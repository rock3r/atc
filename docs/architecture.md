# atc architecture

How the `atc` CLI, the lock-serialized state file, the 3-tier fleet discovery, the warm-affinity queue, and the multi-agent hooks fit together, and how a request moves through them. For people who change this code.

Status: working on macOS, Linux, and Windows with Node.js >= 20, the official `android` CLI, and `adb`. Updated 2026-10-10.

## Summary

An agent (or a developer) claims exclusive access to an Android Virtual Device (AVD) or physical USB/Wi-Fi device from a shell, runs commands against that lease with `atc exec -- <cmd>`, and frees the lease when done. Everything coordinates through a user-private `state.json` file serialized by an atomic directory lock (`atc.lock`) with no background daemon and zero external npm dependencies.

We chose a CLI, a built-in guide (`atc guide`), and lightweight agent hooks/skills so that any shell-capable agent costs zero context until it needs an Android device. The CLI teaches the workflow (`atc guide [workflow|profiles|snapshots|multi-agent|traps]`), enforces lease boundaries (`atc guard` and `atc hook pre-tool-use`), and cleans up leases automatically when an agent turn ends (`atc hook stop`) or when an agent process exits. An optional stdio MCP server (`atc mcp`) exposes the same operations (`atc_guide`, `atc_status`, `atc_claim`, `atc_renew`, `atc_free`, `atc_snapshot`, `atc_exec`) for MCP-only hosts.

Main invariants:

- **Zero subprocesses under `atc.lock`:** Device discovery (`android emulator list --long`, `adb devices`, `~/.android/avd/*.ini`) runs before acquiring `atc.lock`, and slow device operations (boot, wipe, snapshot load/save, stop) run after releasing `atc.lock` while protected by persisted transitional lease states (`"starting"` and `"stopping"`). Every critical section under `atc.lock` finishes in under 20 ms of in-memory and local filesystem work.
- **No accidental personal-phone hijack:** Unfiltered `atc claim` defaults to `--kind emulator`. Physical USB/Wi-Fi devices are claimed only when explicitly requested (`--serial <id>` or `--kind physical|any`) and never count toward the host QEMU slot cap (`maxRunningEmulators`).
- **Warm-affinity fairness ceiling:** Queued Tier-0 warm matches can jump ahead of Tier-2 cold-eviction tickets within `reorderWindowSec` (120 s) to avoid cold-boot thrashing, but once a ticket waits `reorderWindowSec`, it freezes at Priority #0 and cannot be jumped.

## Components

| Part | Where | Language | What it does |
|---|---|---|---|
| Entrypoint | `bin/atc.mjs` | Node.js ESM | Shebang CLI entrypoint; invokes `main(process.argv.slice(2))` from `src/cli.mjs`. |
| CLI & workflows | `src/cli.mjs` | Node.js ESM | Parses flags and orchestrates `guide`, `claim`, `free`, `renew`, `snapshot`, `exec`, `status`, `config`, `gc`, `guard`, `hook`, and `mcp`. |
| Built-in guide | `src/guide.mjs`, `src/guides/*.md` | Node.js ESM + Markdown | What `atc guide` and `atc_guide` print: `workflow`, `profiles`, `snapshots`, `multi-agent`, and `traps`. |
| Atomic lock | `src/lock.mjs` | Node.js ESM | Cross-platform directory mutex (`mkdir <stateDir>/atc.lock`), nonce verification (`owner.json`), stale-lock breaking, and atomic `state.json` write + `fsync` + `rename`. |
| State & scheduler | `src/state.mjs` | Node.js ESM | Schema validation, corruption quarantine, in-memory GC, 6-tier session identity ladder, profile matching, and bounded-window warm-affinity queue selection. |
| Android & host probes | `src/android.mjs` | Node.js ESM | 3-tier fleet discovery (`running`, `offline`, `creatable`), `.avd/config.ini` + `.lock` inspection, host RAM/disk probes, pre-flight resource admission, and boot/stop/snapshot helpers. |
| Subprocess spawner | `src/spawn.mjs` | Node.js ESM | Safe subprocess execution, Windows `.exe`/`.cmd` resolution (CVE-2024-27980 safe), and `ANDROID_SERIAL` + `--device=<serial>` injection for `atc exec`. |
| Command guard | `src/guard.mjs` | Node.js ESM | Shell tokenizer and command classifier for `adb`, `emulator`, `android`, and Gradle device tasks; rewrites or blocks unscoped/unclaimed device commands. |
| Host hooks | `src/hook.mjs` | Node.js ESM | `PreToolUse` / `beforeShellExecution` and `Stop` / `SessionEnd` hook adapters for Claude Code, Codex, Cursor, Antigravity, and Gemini CLI. |
| Stdio MCP server | `src/mcp.mjs` | Node.js ESM | JSON-RPC 2.0 stdio MCP server exposing `atc_guide`, `atc_status`, `atc_claim`, `atc_renew`, `atc_free`, `atc_snapshot`, and `atc_exec`. |
| Skill & plugins | `skills/atc/`, `extensions/atc/`, `hooks/`, `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `plugin.json` | Markdown, TypeScript, JSON | Multi-host agent skill, Pi extension, and plugin/marketplace manifests. |

## Files on disk

| Path | Written by | Contents |
|---|---|---|
| `<stateDir>/state.json` | `atc` (`src/lock.mjs`) | Active/transitional leases, wait queue tickets, configuration overrides, and short-lived hook PID breadcrumbs (`mode 0600`). |
| `<stateDir>/atc.lock/owner.json` | `atc` (`src/lock.mjs`) | Lock holder `{ pid, createdAtMs, nonce }`. Verified before every atomic rename of `state.json`. |
| `<stateDir>/state.json.corrupt.<ts>` | `atc` (`src/state.mjs`) | Quarantined copy of a corrupted `state.json` before reinitializing clean state. |
| `~/.android/avd/<Name>.ini` & `<Name>.avd/config.ini` | Android SDK / `android emulator create` | Local AVD metadata parsed by `src/android.mjs` in <1 ms without spawning a subprocess. |
| `~/.android/avd/<Name>.avd/*.lock` | QEMU / Android Emulator | `hardware-qemu.ini.lock` / `multiinstance.lock` inspected by `atc` to detect an AVD that is still shutting down or holding a host slot while invisible to `adb`. |
| `~/.android/avd/<Name>.avd/snapshots/<snap>/` | QEMU / `adb emu avd snapshot save` | Saved QEMU snapshots discovered by `src/android.mjs` and managed by `atc snapshot` / `atc claim --snapshot-load`. |

Default `<stateDir>` locations (`mode 0700`):
- **Override:** `$ATC_STATE_DIR` (must be an absolute local path, not a symlink, owned by current UID on POSIX)
- **macOS:** `~/Library/Application Support/atc`
- **Linux:** `$XDG_RUNTIME_DIR/atc` or `~/.local/state/atc`
- **Windows:** `%LOCALAPPDATA%\atc`

## How a request moves through `atc`

### 1. Claiming a device (`atc claim`)

1. **Resolve session identity:** `resolveSessionIdentity()` in `src/state.mjs` determines `{ sessionId, anchorPid }` via the 6-tier ladder: explicit `--session` / `ATC_SESSION_ID`, hook rewrite env vars, ambient host env vars (`CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CURSOR_TRACE_ID`, `PI_SESSION_ID`), `state.hookSessions` PID/cwd breadcrumb, `atc mcp` PID, or parent shell/agent PID.
2. **Probe fleet and host outside lock:** `discoverFleetAndHost()` in `src/android.mjs` runs `android emulator list --long` and `adb devices -l`, parses `~/.android/avd/*.avd/config.ini` and `snapshots/`, checks `.avd/*.lock` files, and reads host available RAM and free disk space.
3. **Select candidate under `atc.lock` (<20 ms):**
   - Runs in-memory GC (`runGarbageCollection()`): expires old leases, reclaims leases whose `anchorPid` is dead (`process.kill(pid, 0)`), cleans timed-out `"starting"`/`"stopping"` records whose `workerPid` died or missed its 15 s heartbeat, and reconciles unexpected device disconnects after a 5 s dual-source grace window.
   - Evaluates candidates in 3 tiers:
     - **Tier 0 (Warm Idle Match):** Unleased online device matching `--type`, `--api`, `--play`/`--no-play`, `--abi`, and `--snapshot-load`. If no prep action is needed, transitions immediately to `"active"`. If `--snapshot-load`, `--wipe-data`, `--cold`, or `--reset-app` is requested, writes a `"starting"` reservation with `workerPid = process.pid`.
     - **Tier 1 (Boot Offline Under Cap & Resource Budget):** Unleased offline AVD (with no lingering `.avd/*.lock` files) when `usedSlots < maxRunningEmulators` and `checkResourceAdmission()` passes for RAM and disk reserves. Reserves as `"starting"`.
     - **Tier 2 (Evict Unclaimed Idle or Create Missing):** When at slot cap and `autoStopIdleOnContention` is enabled, marks the longest-idle unleased emulator `"stopping"` and the target offline/creatable AVD `"starting"` (`replacingAvd` links the pair so they count as 1 slot).
   - If all compatible devices are busy and `--wait > 0`, enqueues a ticket in `state.queue` with `starvationDeadlineMs = enqueuedAtMs + reorderWindowSec * 1000`.
4. **Execute slow transitions outside `atc.lock`:**
   - Starts a 15 s worker heartbeat timer (`startWorkerHeartbeat()`) that extends `lease.deadlineMs` while work is in progress.
   - Runs victim eviction (`android emulator stop`), AVD creation (`android emulator create`), cold/warm boot (`android emulator start` or `emulator @<avd>`), snapshot load (`adb -s <serial> emu avd snapshot load`), or package reset (`adb -s <serial> shell pm clear`).
   - Polls `adb` until `sys.boot_completed=1` and verifies the booted AVD name via `emu avd name` so recycled `emulator-5554` serials cannot attach to the wrong lease.
5. **Finalize or roll back under `atc.lock`:**
   - Transitions `"starting" -> "active"` with `serial` and `expiresAtMs`, or removes the `"starting"` record on failure so the slot immediately reopens.

### 2. Running a command (`atc exec -- <cmd>`)

1. Looks up the caller's active lease under `atc.lock`, registers the current process group in `lease.workerPgids`, and renews `expiresAtMs`.
2. `buildChildInvocation()` in `src/spawn.mjs` injects `ANDROID_SERIAL=<lease.serial>`, `ATC_LEASE_ID`, and `ATC_SESSION_ID` into the child environment. For `android run|install|layout|screen`, it also injects `--device=<lease.serial>`. For `adb`, it injects `-s <lease.serial>` after global flags if no target flag is present.
3. While the child runs, an in-process timer renews the lease every `min(15s, ttl / 3)`. When the child exits, `atc` unregisters the worker process group and returns the child's exit code.

### 3. Guarding and rewriting shell commands (`atc guard` & `atc hook`)

1. `evaluateCommandGuard()` in `src/guard.mjs` fast-paths commands that do not mention `adb`, `emulator`, `android`, `gradlew`, or `./gradlew` in under 2 ms without touching `atc.lock`.
2. Compound commands (`&&`, `||`, `;`, `|`, subshells, `sh -c '...'`, and `for`/`while` loops) are tokenized and inspected segment by segment.
3. Direct lifecycle mutations (`android emulator start|stop|create|delete`, `emulator @avd`, `adb emu kill`, `adb reboot`) are denied (`exit 2`) with instructions to use `atc claim` / `atc free`.
4. Device-targeting commands (`adb`, `android run|install|layout|screen`, `./gradlew connectedAndroidTest`) are checked against the session's active lease:
   - If the session has no lease (or targets a serial owned by another session), the command is blocked (`exit 2`).
   - On hosts that support hook command rewriting (Claude Code, Antigravity, Gemini CLI, Pi), unscoped device commands are automatically rewritten to run under `atc exec -- ...` (preserving shell loop variables when `adb` appears inside a `for`/`while` loop).

## Tests

| Command | What it covers |
|---|---|
| `npm test` (`node --test test/*.test.mjs`) | 16 integration suites covering lock acquisition/stale breaking, corruption quarantine, GC, 5 s dual-source offline grace, bounded-window warm-affinity scheduling, RAM/disk admission, shell guard parsing/rewriting, hooks, `atc exec` serial injection, `atc guide` topics, `atc mcp` (`atc_guide`), and plugin manifest consistency. |
| `npm run check` | Syntax validation (`node --check`) across all `.mjs` entrypoints and modules plus the full test suite. |
| `node /Users/sebp/.agents/skills/publish-spec/scripts/lint-spec.mjs /Users/sebp/src/google/etc` | Structural, visual, responsive (1280px / 768px / 375px), accessibility, and prose lint for the companion design spec. |
