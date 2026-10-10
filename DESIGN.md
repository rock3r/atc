# Android Traffic Control (ATC) — MVP Design Specification

- **Status:** MVP Design Specification
- **Target Platforms:** macOS, Linux (Windows supported via `adb` and SDK `emulator` fallback; `android emulator` subcommands are macOS/Linux only per official Android CLI support)
- **Runtime Stack:** Node.js (>= 20 LTS, zero external runtime dependencies, ESM `.mjs`)
- **Integration Targets:** Official `android` CLI (`android emulator`, `android run`, `android layout`, `android screen`), `adb`, Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code, and Stdio MCP.

---

## 1. Problem Statement & Scope

When multiple AI coding agents or developer terminal sessions work concurrently on the same host machine, they contend for Android Virtual Devices (AVDs) and connected physical USB/Wi-Fi test devices:

1. **Mid-task collision:** Agent A is inspecting a UI tree (`android layout`) or running instrumentation tests while Agent B installs a different APK, clears app data, navigates away, or stops the emulator.
2. **Multi-device ambiguity & personal-phone hazard:** When multiple emulators or a developer's personal USB phone are connected concurrently, `adb` and `android` commands without explicit device targeting (`ANDROID_SERIAL` or `--device=<serial>`) fail or hit the wrong device.
3. **Host resource exhaustion & cold-boot thrashing:** Launching every offline AVD concurrently exhausts host RAM/CPU/disk, while strict FIFO ordering between different device profiles repeatedly kills and cold-boots emulators back-to-back.
4. **Orphaned locks:** An agent session crashes, hits a turn limit, or forgets to release its device, blocking subsequent sessions.

### Design Goal ("It Has One Job")
ATC provides **exclusive, TTL-bounded device leases matched by hardware/OS profile, a daemonless bounded-window affinity wait queue, snapshot/wipe state preparation, device-scoped command execution, and cooperative agent-hook guardrails** around the official `android` CLI.

### Non-Goals (MVP)
- Replicating `android` CLI features (SDK management, layout inspection, screenshot capture, APK installation).
- Remote/distributed device farms across multiple physical hosts.
- Multi-instance booting of the same AVD simultaneously (Android AVDs lock their `.avd` directory via `hardware-qemu.ini.lock`; ATC enforces a strict 1-lease-per-AVD invariant).
- OS-level mandatory access control against adversarial local users (hook guardrails are cooperative safety rails for coding agents, not a kernel sandbox).
- Persistent background daemon processes that require OS service managers, code signing, or notarization.

---

## 2. Stack & Portability Rationale

ATC is implemented as a **zero-dependency Node.js (>= 20) ESM package** (`atc.mjs`):

- **Why Node.js with zero native dependencies?**
  - Every target coding agent environment (Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code) already runs on or alongside Node.js on macOS, Linux, and Windows.
  - Pure JavaScript (`.mjs`) using only Node built-in modules (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:crypto`, `node:readline`) requires **no binary compilation (`node-gyp`), no Apple Developer ID signing/notarization, and no Windows SmartScreen binary whitelisting**.
  - Works identically via `npx`, global `npm install -g`, or direct invocation from any agent plugin/extension directory (`node "<pluginRoot>/bin/atc.mjs"`).

---

## 3. Architecture Overview

ATC uses a **daemonless, lock-directory-serialized state file** architecture. Every CLI command (`claim`, `free`, `renew`, `snapshot`, `exec`, `guard`, `status`, `config`, `gc`, `hook`, `mcp`) coordinates through a local user-private runtime directory.

```
+-----------------------------------------------------------------------+
| Any Coding Agent or Shell (Codex / Pi / Cursor / Antigravity / Claude)|
|  - Skill:     skills/atc/SKILL.md (universal CLI workflow)            |
|  - Guardrail: Pi extension / PreToolUse hook / `atc guard`            |
|  - Cleanup:   Stop / SessionEnd hook + dead-ancestor-PID GC           |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| ATC CLI (`atc`) & Optional Stdio MCP (`atc mcp`)                      |
|  - Commands: claim | free | renew | snapshot | exec | status | gc ... |
|  - Scheduler: Warm-affinity batching within `reorderWindowSec`        |
|  - Mutex:    Atomic `mkdir <stateDir>/atc.lock` + nonce verification  |
|  - State:    Atomic temp-write + rename of `<stateDir>/state.json`    |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
| Official Android Tooling & Local AVD Metadata (Outside Lock Only)     |
|  - `android emulator list --long` / `start` / `stop` / `create`       |
|  - `~/.android/avd/*.ini`, `*.avd/config.ini`, `*.avd/snapshots/*`    |
|  - `adb devices` / `adb -s <serial> emu avd snapshot <save|load>`     |
+-----------------------------------------------------------------------+
```

### 3.1 State Directory Location & Permissions
To prevent cross-user symlink/temp-file attacks, ATC stores state on a **local filesystem** (NFS/SMB network shares are unsupported) in a user-private directory created with mode `0700` (files `0600` on POSIX):

- **Override:** `ATC_STATE_DIR` (must be an absolute path on a local disk; verified via `fs.lstatSync` not to be a symlink and owned by `process.getuid()` on POSIX).
- **macOS:** `~/Library/Application Support/atc`
- **Linux:** `$XDG_RUNTIME_DIR/atc` (if set, local, and `0700`) or `~/.local/state/atc`
- **Windows:** `%LOCALAPPDATA%\atc`

### 3.2 Cross-Platform Mutual Exclusion (`atc.lock`) & Strict Lock Boundary

#### Invariant: Zero Subprocesses Under Lock
No external subprocess (`android`, `adb`, `ps`, `powershell`, etc.) may **ever** be spawned while holding `atc.lock`. Device inventory is gathered *before* acquiring `atc.lock`, and emulator boot/stop commands run *after* releasing `atc.lock` using persisted transitional lease states (`"starting"` and `"stopping"`).

What runs inside `atc.lock` is strictly bounded to <20ms of local in-memory and filesystem operations:
1. Read and parse `<stateDir>/state.json`.
2. Run in-memory Garbage Collection (timestamps + `process.kill(pid, 0)` syscalls).
3. Mutate state in memory.
4. Verify lock ownership nonce (`owner.json.nonce === myNonce`).
5. Write `<stateDir>/state.json.tmp.<pid>.<nonce>`, `fsyncSync`, and atomically `renameSync` over `<stateDir>/state.json`.
6. Release `atc.lock`.

#### Lock Protocol (`Acquire` / `Stale-Break` / `Release`)
1. **Acquire:**
   - Generate a random 12-byte hex `myNonce`.
   - Call `fs.mkdirSync("<stateDir>/atc.lock", { mode: 0o700 })`.
   - Immediately write `<stateDir>/atc.lock/owner.json` (`{ pid: process.pid, createdAtMs: Date.now(), nonce: myNonce }`) via atomic write-and-rename inside `atc.lock`.
2. **Contention & Stale Lock Recovery:**
   - If `mkdirSync` throws `EEXIST`, read `<stateDir>/atc.lock/owner.json`.
   - A lock is considered **stale** if:
     - `owner.json` has existed for > `10,000ms` (`Date.now() - owner.createdAtMs > 10000`), OR
     - `owner.json` is missing/unreadable for > `2,000ms` across retries (crashed mid-acquire or unlinked during release), OR
     - `owner.pid` is confirmed dead via `process.kill(owner.pid, 0)` throwing `ESRCH`.
   - To break a stale lock without racing other waiters, the waiter atomically renames `<stateDir>/atc.lock` to `<stateDir>/atc.lock.stale.<waiterNonce>`. (If `renameSync` fails with `ENOENT`/`EPERM`/`EACCES`, another waiter already broke it; sleep and retry normal acquisition.) Once renamed, the waiter deletes `atc.lock.stale.<waiterNonce>` recursively outside the critical path and retries `Acquire`.
   - Otherwise, sleep `20ms–60ms` (with random jitter) and retry up to `lockTimeoutMs` (`5,000ms`).
3. **Nonce-Verified Commit & Release:**
   - Before renaming `state.json.tmp.<pid>.<myNonce>` onto `state.json`, the holder re-reads `<stateDir>/atc.lock/owner.json` and checks `owner.nonce === myNonce`.
   - If `owner.json` is missing or `owner.nonce !== myNonce`, the holder was stale-broken: it **must abort** its write, unlink its temp file, and **must not** remove `atc.lock`. (Note: as with any userspace lock, a theoretical 2-syscall window exists if the kernel `SIGSTOP`s the process between nonce verification and `renameSync`; keeping critical sections <20ms against a 10s stale threshold makes this negligible in practice.)
   - If `owner.nonce === myNonce`, commit `state.json`, unlink `<stateDir>/atc.lock/owner.json`, and call `fs.rmdirSync("<stateDir>/atc.lock")`. On Windows, if `rmdirSync` throws `EBUSY`/`EPERM`/`ENOTEMPTY` due to transient antivirus handle retention after `owner.json` is already unlinked, ignore the `rmdirSync` error and treat release as successful (the empty lock dir self-heals via the >2s missing-`owner.json` stale-break rule).
4. **Windows Atomic Rename & Corruption Recovery:**
   - State writes open `<stateDir>/state.json.tmp.<pid>.<myNonce>` with flag `"wx"` (`O_CREAT | O_EXCL`, mode `0o600`), write JSON, call `fsyncSync`, close the descriptor, and call `fs.renameSync(tmpPath, statePath)`.
   - On Windows, if `renameSync` throws `EPERM` or `EACCES` (due to transient antivirus/indexer handles), retry up to 5 times with `15ms–45ms` backoff. If all 5 retries fail, unlink `tmpPath`, release `atc.lock`, and exit with code `1` (leaving previous `state.json` intact).
   - If `state.json` cannot be parsed (`SyntaxError`) or fails top-level schema validation, quarantine it by renaming to `state.json.corrupt.<timestamp>`, log a warning to `stderr`, and initialize a fresh default state.

---

## 4. Data Model (`state.json`)

To support both emulators and physical USB/Wi-Fi devices (in 1.0 or via explicit `--serial` / `--kind physical` opt-in) without a schema migration, `state.leases` is keyed by a canonical `deviceKey`:
- **`avd:<avdId>`** for Android Virtual Devices (enforcing at most one lease/instance per AVD, both before and after boot).
- **`serial:<serial>`** for physical devices (`kind: "physical"`).

Every lease has `state` in `"starting" | "active" | "stopping"` (`"starting"` covers AVD creation, cold/warm boot, live snapshot restore, and data wipe outside `atc.lock`; `"stopping"` covers post-lease actions on `atc free` — `--snapshot-save`, `--snapshot-load`, and/or `android emulator stop` — outside `atc.lock`).

```json
{
  "version": 1,
  "config": {
    "maxRunningEmulators": 2,
    "minFreeRamMb": 2048,
    "minFreeDiskMb": 2048,
    "qemuOverheadRamMb": 1024,
    "defaultTtlSec": 600,
    "maxTtlSec": 3600,
    "defaultWaitSec": 300,
    "reorderWindowSec": 120,
    "queueHeartbeatTimeoutSec": 10,
    "bootTimeoutSec": 180,
    "stopTimeoutSec": 60,
    "offlineGraceMs": 5000,
    "autoStopIdleOnContention": true,
    "allowPhysicalDevices": "explicit"
  },
  "leases": {
    "avd:Pixel_9": {
      "leaseId": "lease_9f8a7b6c5d4e",
      "deviceKey": "avd:Pixel_9",
      "kind": "emulator",
      "avd": "Pixel_9",
      "serial": "emulator-5554",
      "profile": {
        "deviceType": "phone",
        "deviceName": "pixel_9",
        "apiLevel": "android-36",
        "services": "play",
        "playStore": true,
        "abi": "arm64-v8a"
      },
      "sessionId": "agent-eb12f8",
      "anchorPid": 48210,
      "state": "active",
      "workerPid": null,
      "replacingAvd": null,
      "requiredRamMb": 3072,
      "loadedSnapshot": "clean_boot",
      "saveSnapshotOnFree": null,
      "claimedAtMs": 1791292800000,
      "activatedAtMs": 1791292804000,
      "renewedAtMs": 1791292860000,
      "expiresAtMs": 1791293460000,
      "deadlineMs": null,
      "firstSeenOfflineAtMs": null,
      "reason": "UI test verification"
    }
  },
  "queue": [
    {
      "ticketId": "q_1a2b3c4d5e6f",
      "sessionId": "agent-77c09a",
      "waiterPid": 51092,
      "requestedKind": "emulator",
      "requestedAvd": null,
      "requestedSerial": null,
      "requestedProfile": {
        "deviceType": "phone",
        "apiSpec": ">=35",
        "services": "play",
        "abi": null,
        "snapshotLoad": "clean_boot",
        "wipeData": false,
        "coldBoot": false
      },
      "enqueuedAtMs": 1791292810000,
      "starvationDeadlineMs": 1791292930000,
      "lastHeartbeatAtMs": 1791292862000,
      "waitExpiresAtMs": 1791293110000,
      "reason": "Screenshot check"
    }
  ],
  "hookSessions": {
    "48210": {
      "sessionId": "agent-eb12f8",
      "agentPid": 48210,
      "cwd": "/Users/dev/project",
      "updatedAtMs": 1791292860000
    }
  }
}
```

### 4.1 Lease Lifecycle States & Physical Device Semantics (MVP -> 1.0)
| `lease.state` | Meaning | Counted in `usedSlots`? | Claimable by others? |
| :--- | :--- | :--- | :--- |
| `"starting"` | Device reserved by `workerPid` while boot, `--wipe-data`, `--snapshot-load`, or `--reset-app` runs outside lock | Emulators: Yes (unless `replacingAvd` is already counted as running or `"stopping"`, in which case the pair counts as 1 slot); Physical: No | No |
| `"active"` | Exclusively owned by `sessionId` until `expiresAtMs` (`emulator` or `physical`) | Emulators: Yes; Physical devices: **No** (zero host QEMU RAM/CPU cost) | Only idempotently by the same `sessionId` |
| `"stopping"` | Device reserved by `workerPid` while post-lease actions (`--snapshot-save`, `--snapshot-load`, or `android emulator stop <serial>`) run outside lock | Emulators: Yes; Physical: No | No |

#### Physical Devices (`kind: "physical"`): MVP Safety vs 1.0 Support
1. **No Accidental Personal-Phone Hijack:** Unfiltered `atc claim` defaults to `--kind emulator` so agents do not automatically install test APKs onto a developer's personal plugged-in phone.
2. **Explicit / 1.0 Physical Device Claims:** A physical device can be claimed when explicitly targeted (`atc claim --serial <usb_or_wifi_serial>` or `atc claim --kind physical|any`, or when allowlisted in `config.allowedPhysicalSerials` for 1.0).
3. **Lifecycle Guardrails for Physical Devices:** Physical devices cannot be booted or stopped (`--stop` on `atc free` is a no-op with a warning on physical leases, and Priority-3 idle eviction never targets `kind: "physical"`). They do not count toward `maxRunningEmulators`.

### 4.2 Host-Agnostic Session Identity & `anchorPid` Resolution
Agent tool calls execute in ephemeral subshells, so `process.pid` of `atc claim` exits immediately. Furthermore, ATC must work seamlessly across **Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code, and plain terminals** — whether or not the host supports command-rewriting hooks, and even when multiple agents work in the **same repository directory (`cwd`)**:

1. **Explicit CLI Flag, Lease Token, or Env Var (Highest Priority, Universal):**
   - `--session <id>`, `ATC_SESSION_ID`, or `--lease <leaseId>` / `ATC_LEASE_ID` (with `anchorPid = parseEnvInt(ATC_ANCHOR_PID) || null`). Any agent or script can pass `--session` or `ATC_LEASE_ID` directly with zero hook dependencies.
2. **Extension / Hook Command Rewrite (Pi, Antigravity, Gemini CLI, Claude Code):**
   - On hosts whose tool-call extension or `PreToolUse` hook supports command rewriting (`event.input.command` in Pi's `tool_call` extension, `overwrite` in Antigravity/Gemini CLI, or `hookSpecificOutput.updatedInput` in Claude Code), calling `atc` without `--session` automatically prepends `ATC_SESSION_ID=<id> ATC_ANCHOR_PID=<agentPid>`. This provides **exact, collision-free session identity in 0ms** even when multiple sessions run concurrently in the same `cwd`.
3. **Ambient Agent Environment Variables:**
   - Checks standard session/conversation variables exported by agent runtimes: `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_TRACE_ID`, `CURSOR_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CLAUDE_SESSION_ID`, `CONVERSATION_ID`.
4. **PID-Keyed Hook Breadcrumb (`state.hookSessions`, for non-rewriting hooks like Codex & Cursor):**
   - Every `PreToolUse` hook invocation also records `state.hookSessions[agentPid] = { sessionId, agentPid: process.ppid, cwd, updatedAtMs }` (retained for 60s and swept by in-memory GC).
   - When `atc` runs without `ATC_SESSION_ID`:
     - If `state.hookSessions[process.ppid]` exists and is fresh, use it directly (`0ms`).
     - Otherwise inspect fresh entries in `state.hookSessions` matching `process.cwd()`:
       - If **exactly one** active session exists for `cwd`, select it (`0ms`).
       - If **multiple** concurrent sessions exist in the same `cwd` on a host without command rewriting, release `atc.lock` (preserving the zero-subprocesses-under-lock invariant) and walk ancestor PIDs (`ps` on POSIX; on Windows fail closed without spawning a subprocess) to match `agentPid` in `state.hookSessions`; if still ambiguous, fail closed with exit code `1` instructing the agent to pass `--session <unique_id>`.
5. **Stdio MCP Server (`atc mcp` — Cursor, Windsurf, Zed, etc.):**
   - When invoked via `atc mcp`, the MCP server process stays alive for the duration of the agent session: `sessionId = "mcp-" + process.pid`, `anchorPid = process.pid`.
6. **Universal Parent-Process / Terminal Fallback (Zero-Hook Agents & Interactive Shells):**
   - Uses `TMUX_PANE`, `TERM_SESSION_ID`, or `ppid-${process.ppid}` with `anchorPid = process.ppid`. Because agent runtimes (Pi, Codex, Cursor, etc.) and interactive shells (`zsh`, `bash`, `pwsh`, `cmd`) are long-lived parent processes that spawn each tool command, `process.ppid` (or the nearest non-wrapper ancestor PID) provides automatic dead-agent lease reclamation via `process.kill(anchorPid, 0)` even when no hooks are installed. (`WT_SESSION` alone is not used because Windows Terminal shares `WT_SESSION` across tabs/panes.)

Session IDs are validated against `/^[A-Za-z0-9._:-]{1,128}$/`. Requested `--ttl` values on both `claim` and `renew` are clamped to `[10, config.maxTtlSec]`. `--api` values are normalized so `"36"` and `"android-36"` both become `"android-36"`. (Note on OS PID reuse: in the rare event the OS recycles a dead `anchorPid` to an unrelated process, dead-anchor reclamation is bounded by `expiresAtMs` and `config.maxTtlSec` = 1 hour.)

---

## 5. Core Workflows & State Machine

### 5.1 Garbage Collection (In-Memory inside `atc.lock`, + Orphan File Sweep)
At the start of every locked transaction:
1. **Expired or Clock-Skewed Active Leases:** Remove any lease with `state === "active"` where `now >= lease.expiresAtMs`, `now < lease.claimedAtMs` (backward NTP clock jump guard), or `now > lease.claimedAtMs + (config.maxTtlSec * 1000)`.
2. **Dead Anchor Reclamation:** Remove any `"active"` lease where `lease.anchorPid !== null` and `!isPidAlive(lease.anchorPid)` (`process.kill(anchorPid, 0)` throws `ESRCH`).
3. **Stuck `"starting"` / `"stopping"` Leases:** While a worker process is running a `"starting"` or `"stopping"` operation outside `atc.lock` (e.g. cold boot, data wipe, or a multi-GB `adb emu avd snapshot save`), it runs an in-process `setInterval` heartbeat every `15,000ms` (`unref()`'d) that acquires `atc.lock`, verifies `leaseId` and `workerPid === process.pid`, and extends `lease.deadlineMs = Date.now() + timeoutMs`. Consequently, GC removes a `"starting"` or `"stopping"` lease only when `!isPidAlive(lease.workerPid)`, `now < lease.claimedAtMs`, or `now >= lease.deadlineMs` (meaning the worker stopped heartbeating or hung for a full timeout window), preventing a slow snapshot save or cold boot from ever being torn down while its live worker is still progressing.
4. **Dead/Expired Queue Tickets:** Remove any ticket in `state.queue` where `now >= ticket.waitExpiresAtMs`, `now >= ticket.lastHeartbeatAtMs + (config.queueHeartbeatTimeoutSec * 1000)`, `now < ticket.enqueuedAtMs`, or `!isPidAlive(ticket.waiterPid)`.
5. **Expired Hook Breadcrumbs:** Remove any entry in `state.hookSessions` where `now - entry.updatedAtMs > 60_000` or `!isPidAlive(entry.agentPid)`.
6. **Orphan Temp/Lock File Sweep (Best-Effort):** Periodically (at most once every 60s), unlink any `state.json.tmp.*` or `atc.lock.stale.*` entries in `<stateDir>` whose `mtimeMs` is older than `60,000ms`.

### 5.2 Fleet, Profile, Snapshot & Host Capacity Discovery (Always Outside `atc.lock`)
Before acquiring `atc.lock` for `claim` or `status`, ATC builds a three-tier fleet inventory (`running`, `offline`, `creatable`) and a live host resource snapshot:

1. **Base Device List (`android emulator list --long` + `adb devices`):**
   - `android emulator list --long` parses `AVD ID`, `AVD Name`, `API Level`, `Status` (`Online`/`Offline`), and `Serial` (`kind: "emulator"`).
   - `adb devices` classifies connected serials into:
     - **Emulators (`/^emulator-\d+$/`):** Any running `emulator-<port>` not yet mapped is resolved via `adb -s <serial> emu avd name`.
     - **Physical devices (non-`emulator-*` serials in `device` state):** Indexed as `deviceKey: "serial:<serial>"`, `kind: "physical"`. Excluded from default `--kind emulator` claims and lifecycle stops, but claimable via `--serial <serial>` or `--kind physical|any`.
2. **Zero-Subprocess Local AVD Profile, Resource & Snapshot Enrichment (`~/.android/avd`):**
   - For every discovered AVD, ATC reads `<ANDROID_AVD_HOME || ~/.android/avd>/<avdId>.ini` and `<avdPath>/config.ini` directly from the local filesystem (<1ms, zero subprocesses) to extract:
     - **`deviceType` (Form Factor):** Normalized into `"phone" | "tablet" | "foldable" | "desktop" | "wear" | "xr" | "tv" | "automotive" | "resizable"` from `hw.device.name` (e.g., `pixel_9` -> `"phone"`, `medium_tablet` -> `"tablet"`, `wearos_small_round` -> `"wear"`, `xr_glasses_device` / `ai_glasses_*` -> `"xr"`, `resizable` -> `"resizable"`, which also matches `"phone" | "foldable" | "tablet" | "desktop"` as a secondary match) and `image.sysdir.1`.
     - **`services` & `playStore`:** Parsed from `PlayStore.enabled` (`true`/`false`) and `image.sysdir.1` system-image tag:
       - `"play"`: `PlayStore.enabled=true` or tag contains `playstore` / `android-wear-signed`.
       - `"google_apis"`: `PlayStore.enabled=false` and tag contains `google_apis`.
       - `"aosp"`: `PlayStore.enabled=false` and tag is `default` or `aosp_*`.
     - **`abi`:** Parsed from `abi.type` (e.g., `arm64-v8a`, `x86_64`).
     - **Resource Footprint (`ramSizeMb`, `cpuCores`, `dataDiskMb`):** Parsed from `hw.ramSize` (default `2048` MB; plus `config.qemuOverheadRamMb = 1024` MB hypervisor/GPU overhead -> `requiredRamMb = hwRamMb + 1024`), `hw.cpu.ncore` (default `4`), and `disk.dataPartition.size` + `sdcard.size` (default `6144 + 512 = 6656` MB).
     - **`snapshots`:** Directory names listed via `fs.readdirSync("<avdPath>/snapshots")` (e.g., `["default_boot", "logged_in"]`).
3. **Creatable Capacity Discovery (`<sdk>/system-images` + `android emulator create --list-profiles`):**
   - Inspects `<sdk>/system-images/android-*/<tag>/<abi>/` on disk to report which `(deviceType, apiLevel, services, abi)` profiles do **not** yet have an AVD on disk:
     - `readyToCreate`: System image is already installed locally; an AVD can be created in ~2s via `android emulator create <profile>` (or automatically on `atc claim --create-if-missing`).
     - `requiresSdkInstall`: System image is not yet installed locally; outputs the exact `android sdk install "system-images/..."` command needed.
4. **Host Resource Telemetry & Common-Sense Concurrency Rules:**
   - Because ATC runs on everything from 8 GB laptops to 128 GB workstations, it combines a configurable slot ceiling with **hard pre-flight RAM and disk admission checks** (bypassable via `--force`):
   - **Effective Slot Limit (`effectiveMaxEmulators`):**
     - If `config.maxRunningEmulators` is an explicit integer (set via `atc config set maxRunningEmulators <N>` or `ATC_MAX_EMULATORS=<N>`), use `<N>`.
     - Default is `2` concurrent emulators; if set to `"auto"`, compute a common-sense machine ceiling from `os.totalmem()` and `os.availableParallelism()`:
       - Reserve `max(6 GB, 30% of totalRamGb)` for the host OS, IDE, Gradle daemons, and agent runtimes; allocate `3.5 GB` and `4` logical CPU cores per concurrent emulator:
         `effectiveMaxEmulators = clamp(Math.min(Math.floor((totalRamGb - 6) / 3.5), Math.floor(cpuCores / 4)), 1, 6)`
         *(e.g., 16 GB RAM -> `1` emulator; 24–32 GB -> `2` emulators; 48–64 GB -> `4` emulators; 96–128 GB -> `6` emulators).*
   - **Live Available Host RAM (`availableRamMb`):**
     - **Linux:** Reads `MemAvailable` from `/proc/meminfo` (`0.1ms`, includes reclaimable page cache).
     - **Windows:** Uses `os.freemem()` (`GlobalMemoryStatusEx.ullAvailPhys`, includes standby cache).
     - **macOS:** Parses `vm_stat` (`Pages free + Pages inactive + Pages speculative + Pages purgeable`) multiplied by page size, falling back to `totalRamMb - committedEmulatorRamMb - 6144`.
   - **Live Free Disk Space (`freeDiskMb`):**
     - Uses Node's built-in `fs.statfsSync(avdHomeDir)` (`Number(stat.bavail) * Number(stat.bsize)`), requiring zero subprocesses across macOS, Linux, and Windows.
   - **Hard Pre-Flight Admission Rules (Exit Code `5` `ERESOURCE_EXCEEDED`, Bypassable with `--force`):**
     - **Before Booting an Offline Emulator `C`:**
       - Every emulator lease stores `requiredRamMb` (`hw.ramSize + config.qemuOverheadRamMb`) and `activatedAtMs`. Because a newly booted QEMU process may take several seconds after `sys.boot_completed=1` to fault in its full guest RAM in host `availableRamMb`, `projectedAvailableRamMb` subtracts both `"starting"` leases and recently activated leases (`state === "active" && now - lease.activatedAtMs < 30_000`) that were not yet online when the caller's pre-lock inventory snapshot was taken:
         `projectedAvailableRamMb = availableRamMb + (replacingAvd ? replacingAvd.requiredRamMb : 0) - sum(unaccountedStartingOrRecentlyActivatedLeases.requiredRamMb)`
       - **Rule R1 (RAM):** Require `projectedAvailableRamMb >= C.requiredRamMb + config.minFreeRamMb (2048 MB)`. If violated and an idle running emulator `V` can be evicted (`Priority 3`), evict `V` first to reclaim its RAM. If still insufficient and `--force` is not set, fail fast with exit code `5` (`ERESOURCE_EXCEEDED`).
       - **Rule D1 (Boot/Snapshot Disk):** Require `freeDiskMb >= C.ramSizeMb + config.minFreeDiskMb (2048 MB)` (to ensure QCOW2 overlay growth and quickboot snapshot writes cannot exhaust host disk and corrupt the AVD).
     - **Before Creating an AVD (`--create-if-missing`) or Wiping Data (`--wipe-data`):**
       - **Rule D2 (Creation/Wipe Disk):** Require `freeDiskMb >= C.dataDiskMb + config.minFreeDiskMb (2048 MB)` (typically `6.5 GB + 2.0 GB = 8.5 GB`). If violated and `--force` is not set, fail fast with exit code `5` (`ERESOURCE_EXCEEDED`).

### 5.3 Claiming a Device by Profile, Snapshot/Wipe State & Bounded-Window Affinity (`atc claim`)
Inputs:
- **Profile Filters:** `[--type <phone|tablet|foldable|desktop|wear|xr|tv|automotive|resizable>] [--api <36|>=34|34..36>] [--play | --no-play | --services <play|google_apis|aosp>] [--abi <abi>] [--avd <avdId>] [--serial <serial>] [--kind <emulator|physical|any>] [--create-if-missing]`
- **State / Snapshot Preparation:** `[--snapshot-load <name>] [--snapshot-save-on-free <name>] [--wipe-data] [--cold] [--reset-app <pkg>] [--headless]`
- **Lease, Queue & Resource Controls:** `[--ttl <sec>] [--wait <sec>] [--reorder-window <sec>] [--force] [--reason <text>]`

#### Step 1: Gather Inventory & Host Resources Outside Lock
Run §5.2 to obtain the current snapshot of running devices, offline AVDs (with `.ini` profiles, RAM/disk requirements, and snapshot lists), creatable SDK profiles, and host RAM/disk capacity.

#### Step 2: Acquire `atc.lock` & Run GC (§5.1) + Offline Grace Reconciliation
- For emulator leases (`kind: "emulator"`), an `"active"` lease is considered **confirmed offline** only if **both** `android emulator list --long` reports the AVD as `Offline` **and** its `serial` is absent from `adb devices`.For physical device leases (`kind: "physical"`), it is considered confirmed offline when its `serial` is absent from `adb devices` (or not in `device` state).
- On the first inventory snapshot where an `"active"` lease is confirmed offline, set `lease.firstSeenOfflineAtMs = now` (if not already set). Remove the lease if `now - lease.firstSeenOfflineAtMs >= config.offlineGraceMs` (`5,000ms`), or immediately if the lease belongs to the calling `sessionId`. Whenever a device is online in the latest snapshot, reset `lease.firstSeenOfflineAtMs = null`.

#### Step 3: Idempotent Re-Claim (Same Session)
- If `sessionId` already holds an `"active"` lease matching the requested profile filters (and no state reset `--wipe-data` / `--cold` / `--snapshot-load` is requested, or `lease.loadedSnapshot === requestedSnapshot`), renew its `expiresAtMs = now + ttlMs` and return the existing lease immediately.

#### Step 4: Bounded-Window Warm-Affinity Scheduling & Candidate Selection (Under Lock)
To maximize throughput on already-spun-up emulators while guaranteeing that jobs with niche profiles (e.g. Wear OS, XR Glasses, older AOSP APIs) **never** starve, ATC schedules queued and incoming requests using **Bounded-Window Warm-Affinity Ordering**:

1. **Profile Matching (`matchesProfile(device, req)`):**
   - Checks `kind`, `avd`, `serial`, `deviceType` (exact match preferred over `resizable` fallback), `apiSpec` (exact `36`, minimum `>=34`, or range `34..36`), `services` (`--play` requires `services === "play"`; `--no-play` requires `playStore === false`), `abi`, and (if `--snapshot-load <name>` is set) verifies `<name>` exists in `device.snapshots`.
2. **Affinity Tiers (Cost to Run Now):**
   - **Tier 0 (`WARM_IDLE_MATCH`):** Candidate device (whether an online emulator or a connected `kind: "physical"` device when `--kind physical|any` or `--serial` is requested) is **online, unleased**, matches `req`, and does **not** require a full QEMU process restart (`--wipe-data` and `--cold` are false; live `--snapshot-load <name>` via `adb emu avd snapshot load` and `--reset-app <pkg>` stay in Tier 0 because they keep the warm QEMU instance alive and require zero extra RAM). Physical devices are only ever matched in Tier 0 (boot/eviction Tiers 1 and 2 never apply to physical devices).
   - **Tier 1 (`FREE_SLOT_BOOT`):** Candidate AVD is **offline** (or requires reboot for `--wipe-data` / `--cold`), `usedSlots < effectiveMaxEmulators`, and host RAM/disk passes §5.2(4) without stopping a running emulator.
   - **Tier 2 (`COLD_EVICT_BOOT`):** `usedSlots >= effectiveMaxEmulators` (or free host RAM is insufficient without eviction) and running `req` requires stopping an idle running emulator (`Priority 3`) to cold-boot a different offline AVD.
3. **Bounded Reorder Window & Anti-Starvation Invariant (`reorderWindowSec`, default `120s`):**
   - Every queue ticket `T` records `enqueuedAtMs` and `starvationDeadlineMs = enqueuedAtMs + (config.reorderWindowSec * 1000)`.
   - An earlier ticket `E` in `state.queue` is **Starvation-Protected (Frozen at Priority 0)** relative to a later caller/ticket `C` if:
     - `now >= E.starvationDeadlineMs` (i.e., `E` has already waited `>= reorderWindowSec` since it was run), **OR**
     - `C.enqueuedAtMs - E.enqueuedAtMs > config.reorderWindowSec * 1000` (`C` arrived outside `E`'s reorder window).
   - **When Can Caller `C` Jump Ahead of Earlier Ticket `E`?**
     `C` may bypass `E` **if and only if**:
     1. `E` is **not** Starvation-Protected (`now < E.starvationDeadlineMs` and `C.enqueuedAtMs - E.enqueuedAtMs <= config.reorderWindowSec * 1000`), **AND**
     2. `C` has a **Tier 0 (`WARM_IDLE_MATCH`)** candidate `D` available right now, whereas `E` does **not** match `D` (e.g., `E` needs a busy emulator or a Tier 2 `COLD_EVICT_BOOT` of an offline niche AVD).
   - **Reservation Helper `isReservedForEarlierTicket(deviceOrSlot)`:**
     - Any device `D` matched by an earlier ticket `E` that can run on `D` right now is reserved for `E`.
     - Furthermore, if any earlier ticket `E` is **Starvation-Protected (`now >= E.starvationDeadlineMs`)** and requires a free slot or an idle eviction victim `V` to boot its offline AVD, that slot / victim `V` is **reserved for `E`** — no later Tier 0 warm-hit job may re-lease `V` once `E`'s `starvationDeadlineMs` has passed!
4. **Candidate Selection & Resource Admission Order:**
   - Compute occupied emulator capacity `usedSlots` without double-counting, where `runningOrStoppingEmulators` is the set union of all running emulator AVDs observed in the inventory snapshot (whether leased or unleased/idle) and all emulator AVDs with a lease in `state === "stopping"`:
     `usedSlots = count(runningOrStoppingEmulators) + count(startingLeases where lease.avd not in runningOrStoppingEmulators and (lease.replacingAvd === null or lease.replacingAvd not in runningOrStoppingEmulators))`
   - **Priority 1 — Tier 0 Warm Idle Match:** Select an online, unleased device matching `req` where `isReservedForEarlierTicket(candidate)` is `false` (and `--wipe-data` / `--cold` are not set).
     - If **neither** `--snapshot-load` nor `--reset-app` is requested: transition immediately to `state: "active"`, remove caller's queue ticket, commit, release lock, and return in <5ms.
     - If `--snapshot-load <name>` or `--reset-app <pkg>` **is** requested: write lease with `state: "starting"`, `workerPid: process.pid`, `deadlineMs: now + bootTimeoutMs`, remove caller's queue ticket, commit, release lock, and proceed to Step 5 (Warm State Preparation outside lock).
   - **Priority 2 — Tier 1 Boot Into Free Slot (or Reboot Running Match for `--wipe-data` / `--cold`):** If `usedSlots < effectiveMaxEmulators` (or the candidate itself is an already-running unleased AVD that needs a `--wipe-data`/`--cold` restart), `isReservedForEarlierTicket(candidate)` is `false`, and candidate passes the **Pre-Flight RAM & Disk Admission Check (§5.2.4)** (or `--force` is set):
     - Write lease with `state: "starting"`, `workerPid: process.pid`, `deadlineMs: now + bootTimeoutMs`, remove caller's queue ticket, commit, and release lock. Proceed to Step 5.
   - **Priority 3 — Tier 2 Evict Idle Running Emulator (Slot or RAM Contention):** If (`usedSlots >= effectiveMaxEmulators` OR host free RAM is insufficient for Priority 2 without stopping an idle emulator) and `config.autoStopIdleOnContention` is `true`, look for a running **unleased** emulator `V` where `isReservedForEarlierTicket(V)` is `false` (preferring the longest-idle emulator with zero matching queued tickets), and an offline unleased AVD `C` matching `req` where `isReservedForEarlierTicket(C)` is `false` and `C` passes §5.2(4) after reclaiming `V.requiredRamMb`:
     - Atomically write two records in `state.leases`:
       1. `state.leases[V.deviceKey] = { state: "stopping", serial: V.serial, workerPid: process.pid, deadlineMs: now + stopTimeoutMs, ... }`
       2. `state.leases[C.deviceKey] = { state: "starting", replacingAvd: V.avd, workerPid: process.pid, deadlineMs: now + bootTimeoutMs, ... }`
     - Remove caller's queue ticket, commit, and release lock. Proceed to Step 5.
   - **Priority 4 — Auto-Create Missing AVD (`--create-if-missing`):** If no existing AVD on disk or in `state.leases` matches `req` and `--create-if-missing` is passed, verify a `readyToCreate` profile exists in §5.2(3) and passes **Rule D2 (Creation Disk Check)** and **Rule R1 (RAM Check)**. Reserve `state.leases["avd:" + avdId] = { state: "starting", avd: avdId, workerPid: process.pid, claimedAtMs: now, deadlineMs: now + bootTimeoutMs, ... }`, commit, and release `atc.lock`. Outside `atc.lock`, create the AVD via `android emulator create <profile>`, discover the newly created AVD name, migrate the `"starting"` lease key if needed, and proceed to Step 5.
   - **Hard Resource Failure vs Queue Wait:** If an offline candidate `C` exists and no other emulators are running (`usedSlots === 0`), yet `C` still fails **Rule R1 (RAM)** or **Rule D1/D2 (Disk)** (and `--force` is not set), waiting in the queue cannot free emulator RAM/disk: release `atc.lock` and fail immediately with exit code `5` (`ERESOURCE_EXCEEDED`) and an actionable diagnostic message.

#### Step 5: Evict, Boot & Snapshot/Wipe Preparation Phase (Outside Lock)
All external commands run strictly outside `atc.lock` while the device is protected by `state: "starting"`:
1. **Evict Victim (if `replacingAvd` set):** Run `android emulator stop <V.serial>`, then acquire `atc.lock` and delete `state.leases[V.deviceKey]` (verifying `leaseId`).
2. **Warm State Preparation (if device was already online and `--wipe-data` / `--cold` are false):**
   - If `--snapshot-load <name>` is requested: run `adb -s <serial> emu avd snapshot load <name>`.
   - If `--reset-app <pkg>` is requested: run `adb -s <serial> shell pm clear <pkg>`.
3. **Cold / Snapshot / Wipe Boot (if device was offline, or needed restart for `--wipe-data` / `--cold`):**
   - If device was online and needed `--wipe-data` or `--cold`, run `android emulator stop <serial>` first.
   - If `--wipe-data` is specified, delete user-data/cache images and default quickboot snapshot in the AVD directory before starting with `--cold`.
   - Run `android emulator start <C.avd> [--headless] [--cold]` bounded by `bootTimeoutSec` and resolve the resulting `emulator-<port>` serial.
   - If `--snapshot-load <name>` is requested, run `adb -s <serial> emu avd snapshot load <name>` after boot.
   - If `--reset-app <pkg>` is also requested, run `adb -s <serial> shell pm clear <pkg>`.
4. **Activate Lease:** Acquire `atc.lock`, verify `state.leases[C.deviceKey]` still matches our `leaseId`, transition `state` to `"active"` with `serial`, `loadedSnapshot`, `saveSnapshotOnFree`, and `expiresAtMs = now + ttlMs`, commit, and return.
5. **Rollback on Failure / Timeout / Signal:** Best-effort stop any newly booted emulator, acquire `atc.lock`, delete `state.leases[C.deviceKey]` (and `state.leases[V.deviceKey]` if still `"stopping"`), and exit with code `1`.

#### Step 6: Wait Queue Phase (If No Candidate Available)
- If `--wait 0` (non-blocking), release `atc.lock` and exit with code `2` (`EBUSY`).
- Under `atc.lock`, if caller has no ticket in `state.queue`, append `{ ticketId, sessionId, waiterPid: process.pid, requestedKind, requestedAvd, requestedSerial, requestedProfile, enqueuedAtMs: now, starvationDeadlineMs: now + reorderWindowMs, lastHeartbeatAtMs: now, waitExpiresAtMs: now + waitMs }`. (If re-inserting after an OS sleep while `now < waitExpiresAtMs`, the waiter process retains its original `enqueuedAtMs` and `starvationDeadlineMs` in local process memory and restores them on re-insert. Note: if a laptop sleeps longer than a lease TTL or `waitExpiresAtMs`, in-flight waits/leases time out and self-heal on the next command.)
- Release `atc.lock` and enter the **Two-Stage Poll Loop** (every `1,000ms` ± `200ms` jitter):
  1. **Stage A (In-Memory Heartbeat & Fast Check Under `atc.lock`, 0 Subprocesses):** Acquire `atc.lock`, run GC, update `ticket.lastHeartbeatAtMs = now`, and check whether a lease was freed or if the caller is now eligible to run. Release `atc.lock`.
  2. **Stage B (External Inventory Refresh Outside `atc.lock`):** Run §5.2 (`android emulator list --long`, `adb devices`, and host RAM/disk telemetry) only when Stage A indicates a slot/device opened up, **or** every 5th poll tick (~5s) as a fallback to detect out-of-band device changes (e.g., an emulator closed manually by the user), then re-enter Step 2.

### 5.4 Releasing a Device & Post-Lease Snapshot Actions (`atc free`)
Inputs: `[<target>] [--session <id>] [--snapshot-save <name>] [--snapshot-load <name>] [--stop] [--force]`
1. Target resolution precedence: match `<target>` against `leaseId` first, then `serial`, then `avd`. If `<target>` is omitted, select all `"active"` leases owned by `sessionId`.
2. Verify ownership under `atc.lock`: `lease.sessionId === callerSessionId || lease.leaseId === target || flags.force`. Otherwise exit with code `3` (`EPERM`).
3. Determine post-lease actions: let `saveSnap = flags.snapshotSave || lease.saveSnapshotOnFree`.
4. **If no `--stop`, no `saveSnap`, and no `--snapshot-load`:** Delete the lease from `state.leases`, commit, release `atc.lock`, and exit `0`.
5. **If `saveSnap`, `--snapshot-load`, or `--stop` IS set (Race-Free Post-Lease Transition):**
   - If `saveSnap` is set, gather a host disk/AVD footprint snapshot outside `atc.lock` (`fs.statfsSync(avdHomeDir)` + `<avdPath>/config.ini`) and verify **Rule D1 (Disk Check)** (unless `--force` is set).
   - Under `atc.lock`, transition the lease to `state: "stopping"`, `workerPid: process.pid`, `deadlineMs: now + stopTimeoutMs`, commit, and release `atc.lock` (preventing any concurrent `atc claim` from claiming the emulator mid-snapshot or mid-shutdown).
   - Outside `atc.lock` (while maintaining the 15s `workerPid` `deadlineMs` heartbeat timer per §5.1 rule 3):
     - If `saveSnap` is set (and `lease.kind === "emulator"`): run `adb -s <lease.serial> emu avd snapshot save <saveSnap>`.
     - If `--snapshot-load <name>` is set (and `--stop` is not set): run `adb -s <lease.serial> emu avd snapshot load <name>` so the emulator is left clean and warm for the next waiter.
     - If `--stop` is set (and `lease.kind === "emulator"`): run `android emulator stop <lease.serial || lease.avd>`.
   - Re-acquire `atc.lock`, delete the `"stopping"` entry (if `leaseId` matches), commit, and exit `0`.

### 5.5 Live Snapshot Management During an Active Lease (`atc snapshot`)
Usage: `atc snapshot <list|save|load|delete> [<name>] [--serial <serial> | --avd <avdId>] [--force]`
- `atc snapshot list`: Lists available snapshots for an online or offline AVD (by reading `<avdPath>/snapshots/` and/or `adb -s <serial> emu avd snapshot list`). Requires no lease.
- `atc snapshot <save|load|delete> <name>`:
  1. Validates `<name>` against `/^[A-Za-z0-9._-]{1,64}$/`.
  2. For `save`, checks **Rule D1 (Disk Space)** unless `--force` is set (exit code `5` if insufficient).
  3. Under `atc.lock`, verifies that `sessionId` holds an `"active"` emulator lease for the target device and renews `expiresAtMs`.
  4. Outside `atc.lock`, executes `adb -s <lease.serial> emu avd snapshot <save|load|delete> <name>` (and for `load`, waits until `sys.boot_completed == 1`).

### 5.6 Executing Scoped Commands (`atc exec`) with In-Process Heartbeat
Usage: `atc exec [--serial <serial>] [--session <id>] -- <command> [args...]`
1. Under `atc.lock`, verify that `sessionId` holds an `"active"` lease (if the session holds one lease, select it; if multiple, require `--serial`).
2. Extend `expiresAtMs = Math.max(lease.expiresAtMs, now + defaultTtlMs)` and `renewedAtMs = now`.
3. Release `atc.lock`.
4. **Start In-Process Lease Heartbeat Timer:**
   - Start a `setInterval` timer firing every `Math.min(60_000, Math.floor(ttlMs / 3))` (`unref()`'d) that acquires `atc.lock`, verifies `leaseId` is still owned by `sessionId`, and updates `renewedAtMs = Date.now()` and `expiresAtMs = Date.now() + ttlMs`. This guarantees that long-running commands (e.g., a 20-minute `./gradlew connectedAndroidTest` suite) **never** expire mid-run.
5. **Spawn Child Process:**
   - Resolve `<command>` via the Cross-Platform Executable Resolver (§8.1).
   - Set child environment variables `ANDROID_SERIAL=<lease.serial>`, `ATC_LEASE_ID=<lease.leaseId>`, and `ATC_SESSION_ID=<sessionId>`.
   - If `<command>` resolves to `android` and the subcommand is `install`, `run`, `layout`, or `screen`, inject `--device=<lease.serial>` if `--device` is not already present.
6. When the child exits, `clearInterval` the heartbeat timer, touch `renewedAtMs` one final time under `atc.lock`, and exit with the child's exit code.

---

## 6. CLI & Optional MCP Interface

### 6.1 Unified CLI Subcommands
| Command | Purpose | Exit Codes |
| :--- | :--- | :--- |
| `atc guide [topic] [--json]` | Print built-in workflow, profile, snapshot, multi-agent, or troubleshooting guides (`workflow`, `profiles`, `snapshots`, `multi-agent`, `traps`) | `0` ok, `1` unknown topic |
| `atc claim [options]` | Claim by profile (`--type`, `--api`, `--play`/`--no-play`, `--avd`), prepare state (`--snapshot-load`, `--wipe-data`, `--cold`, `--reset-app`), or wait in bounded-window affinity queue | `0` ok, `2` busy/timeout, `5` insufficient RAM/disk (`--force` to bypass), `1` error |
| `atc free [target] [options]` | Release lease(s) (`leaseId` > `serial` > `avd`); optional `--snapshot-save`, `--snapshot-load`, `--stop`, `--force` | `0` ok, `3` not owner, `5` disk full on snapshot save, `1` error |
| `atc renew [target] [--ttl <sec>]` | Extend lease expiration time (clamped to `maxTtlSec`) | `0` ok, `3` not owner, `1` error |
| `atc snapshot <list\|save\|load\|delete> [name]` | Inspect or save/load/delete QEMU snapshots on leased emulator | `0` ok, `3` not owner, `5` disk full, `1` error |
| `atc exec -- <cmd> [args...]` | Run command with `ANDROID_SERIAL` & periodic lease heartbeat | Child exit code, or `3` no lease |
| `atc status [--type ...] [--api ...] [--json]` | Show 3-tier fleet (`running`, `offline` spin-up candidates, `creatable` profiles), host RAM/disk capacity, active leases, and affinity wait queue | `0` ok |
| `atc config <get\|set> [key] [val]` | View or configure `maxRunningEmulators` (`"auto"` or integer), `reorderWindowSec`, `minFreeRamMb`, `minFreeDiskMb` | `0` ok, `1` invalid value |
| `atc gc` | Run garbage collection immediately and print pruned entries | `0` ok |
| `atc hook <pre-tool-use\|stop>` | Read host hook JSON from `stdin` and enforce/cleanup leases | `0` allow, `2` block (stderr + JSON) |
| `atc mcp` | Start zero-dep JSON-RPC 2.0 Stdio MCP server | `0` on EOF |

### 6.2 Stdio MCP Server (`atc mcp`)
For MCP-centric agent hosts, `atc mcp` implements the MCP stdio transport exposing six tools:
- `atc_claim({ type?, api?, services?, play?, abi?, avd?, serial?, kind?, createIfMissing?, snapshotLoad?, snapshotSaveOnFree?, wipeData?, cold?, resetApp?, headless?, force?, ttlSec?, waitSec?, reorderWindowSec?, reason? })`
- `atc_free({ target?, snapshotSave?, snapshotLoad?, stop?, force? })`
- `atc_renew({ target?, ttlSec? })`
- `atc_snapshot({ action: "list" | "save" | "load" | "delete", name?, target?, force? })`
- `atc_status({ type?, api?, services?, play? })` — returns `{ hostCapacity, fleet: { running, offline, creatable }, leases, queue }`
- `atc_guide({ topic?: "workflow" | "profiles" | "snapshots" | "multi-agent" | "traps" })` — returns `{ topic, topics, text }`

---

## 7. Multi-Agent Plugin, Extension & Hook Guardrails

All command classification and lease validation logic lives in `atc` itself (`atc guard <cmd>` and `atc hook <pre-tool-use|stop>`), so every agent ecosystem uses a thin, native adapter without duplicating parsing rules (following the same multi-agent architecture as `build-brief`):

```text
atc/
├── bin/
│   └── atc.mjs                        # Cross-platform CLI + Guard + Hook + MCP entrypoint
├── src/                               # Modular zero-dep ESM implementation
│   ├── cli.mjs
│   ├── guide.mjs                      # Built-in guide command & topic loader
│   ├── guides/                        # Embedded Markdown guides (workflow, profiles, snapshots, multi-agent, traps)
│   ├── lock.mjs
│   ├── state.mjs
│   ├── android.mjs
│   ├── spawn.mjs
│   ├── guard.mjs                      # Host-agnostic shell command classifier & rewriter
│   ├── hook.mjs                       # Stdin JSON adapter for PreToolUse / Stop hooks
│   └── mcp.mjs                        # Zero-dep JSON-RPC 2.0 Stdio MCP server
├── docs/
│   └── user-guide.md                  # End-to-end user & agent guide
├── skills/
│   └── atc/
│       ├── SKILL.md                   # Universal agent skill (Codex, Pi, Cursor, Antigravity, Claude)
│       └── references/
│           └── install.md             # CLI & multi-host plugin installation reference
├── extensions/
│   └── atc/
│       └── index.ts                   # Pi extension (`pi.on("tool_call")` -> `atc guard`)
├── hooks/
│   └── hooks.json                     # Shared PreToolUse / Stop hook definitions
├── .codex-plugin/
│   └── plugin.json                    # Codex plugin manifest
├── .cursor/
│   └── hooks.json                     # Cursor agent hook & MCP config template
├── .claude-plugin/
│   ├── plugin.json                    # Claude Code plugin manifest
│   └── marketplace.json               # Local plugin marketplace registration
├── hooks.json                         # Antigravity / Gemini CLI root hook config
├── plugin.json                        # Antigravity / Gemini CLI root plugin manifest
└── package.json                       # npm package ("bin": { "atc": "./bin/atc.mjs" })
```

### 7.1 Universal Command Guard (`atc guard` & `atc hook pre-tool-use`)
> **Scope Note:** Guardrail enforcement is a **cooperative safety net** designed to catch agents that forget to run `atc claim` or forget `--device` / `ANDROID_SERIAL`. It inspects shell command strings and is not an OS security boundary against deliberate obfuscation.

1. **Multi-Host Input Plumbing (Zero Shell Interpolation):**
   - **Pi Extension (`extensions/atc/index.ts`):** Intercepts `tool_call` events where `event.toolName === "bash"`, invokes `pi.exec("atc", ["guard", "--format=json", event.input.command])`, and either updates `event.input.command` in place or throws/blocks when a device command lacks a lease.
   - **Stdin JSON Hooks (`atc hook pre-tool-use`):** Reads the JSON hook event from `stdin` (never `argv`), normalizing across agent hosts:
     - **Codex / Cursor / Claude Code:** `{ session_id, tool_name: "Bash" | "Shell", tool_input: { command } }`
     - **Antigravity / Gemini CLI:** `{ conversationId, toolCall: { name: "run_command", args: { CommandLine } } }`
   - If the tool is not a shell/command execution tool, exit `0` immediately.
2. **Fast Path (<2ms, Zero Lock):**
   - If the command string contains no whole-word token matching `/\b(android|adb|emulator|gradlew|gradle|atc)\b/`, exit `0`.
3. **Compound Command Segment Analysis:**
   - Split the shell string into segments across `;`, `&&`, `||`, `|`, `&`, `$()`, and newlines; strip leading environment variable assignments (`VAR=val`) and transparent wrappers (`env`, `command`, `nohup`, `timeout`, `build-brief`).
   - Record `state.hookSessions[process.ppid] = { sessionId, agentPid: process.ppid, cwd: process.cwd(), updatedAtMs: now }` under `atc.lock`.
   - Classify each segment in strict precedence order (most-specific rules first):
     1. **ATC commands (`atc ...`)**: Allowed. If `ATC_SESSION_ID` / `--session` is not present in the command, emit a rewritten command (`event.input.command` in Pi, `overwrite` in Antigravity/Gemini CLI, `updatedInput` in Claude Code) prepending `ATC_SESSION_ID=<sessionId> ATC_ANCHOR_PID=<process.ppid>` so the `atc` CLI invocation receives the exact session identity even when multiple agents share the same `cwd`.
     2. **Direct lifecycle bypass (evaluated before generic `android` subcommands)**: `android emulator (start|stop|remove|create)` or `emulator @<avd>` or `adb ... emu kill` -> **Denied** (`Use "atc claim --type <type> --api <api>" or "atc free --stop" instead of starting/stopping emulators directly.`).
     3. **Read-only Android/ADB commands**: `android emulator list`, `android (docs|sdk|info|help|skills|studio|describe|create|init|update)` (where top-level `android create` is project creation, distinct from `android emulator create`), `adb (devices|version|help|start-server)` -> Allowed.
     4. **Device-interacting commands**: `android (run|install|layout|screen)`, `adb ... (shell|install|uninstall|push|pull|logcat|forward|reverse|bugreport)`, `(./gradlew|gradle) ... connected*`, or any unparseable segment containing `android`/`adb`/`emulator` (fail-closed toward requiring a lease):
       - Check active leases in `state.json` for `sessionId`:
       - If `sessionId` holds **no active lease**, deny the tool call: write an actionable error message to `stderr`, emit the structured deny JSON on `stdout`, and exit with code `2` (which blocks execution in Codex, Cursor, Antigravity, Gemini CLI, and Claude Code).
       - If the command specifies `--device=<serial>` or `-s <serial>` (or `ANDROID_SERIAL=<serial>`) that does not belong to `sessionId`'s active lease(s), deny the tool call.
       - If `sessionId` holds multiple active leases, or if multiple emulators are running and the command is not wrapped in `atc exec` and lacks `ANDROID_SERIAL` / `--device` / `-s`, deny with instructions to use `atc exec -- <cmd>` or specify `ANDROID_SERIAL=<serial>`.
       - Otherwise, **auto-renew** `sessionId`'s active lease (`expiresAtMs = now + ttlMs`) and allow (`exit 0`).

### 7.2 `Stop` / `SessionEnd` Hook (`atc hook stop`)
When the agent turn or session terminates (`Stop` / `SessionEnd` event where `fullyIdle !== false`), `atc hook stop` reads `session_id` / `conversationId` from `stdin` JSON and frees all `"active"` leases owned by that session (`atc free --session <sessionId>`), executing any configured `saveSnapshotOnFree` action before releasing the device to queued waiters.

---

## 8. Security & Cross-Platform Hardening

### 8.1 Cross-Platform Executable Resolution & `shell: false`
Node.js >= 20.12 throws `EINVAL` when spawning `.bat` or `.cmd` files on Windows with `shell: false` (CVE-2024-27980). To maintain safety across macOS, Linux, and Windows:
1. **Executable Discovery (`resolveExecutable`):**
   - On POSIX, spawn executables directly with `shell: false`.
   - On Windows, resolve the target binary against `PATH` (plus `%LOCALAPPDATA%\Android\Sdk\platform-tools` and `%USERPROFILE%\.local\bin` for `adb`/`android`) checking extensions `.exe`, `.cmd`, `.bat` in order.
2. **Direct `.exe` Execution:** If the resolved file ends in `.exe` (e.g., `adb.exe` or `android.exe`), spawn it directly with `shell: false`.
3. **Safe `.cmd` / `.bat` Execution on Windows:**
   - When the resolved file is a `.cmd` or `.bat` batch file (e.g., `android.cmd` or `gradlew.bat` inside `atc exec`), first validate that no argument contains `\0`, `\r`, `\n`, or unescaped `%` environment expansion tokens when invoked internally by ATC.
   - For internal `android` CLI calls, all arguments (`avd`, `serial`, flags) are strictly validated against `/^[A-Za-z0-9._:-]+$/` before invocation, and positional arguments are preceded by `--` where supported, making command injection impossible even when routed through `[process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", ...]]` with `windowsVerbatimArguments: true`.

### 8.2 State Directory & Symlink Protection
- On POSIX, `stateDir` is created with `0o700`, checked via `fs.lstatSync` to reject symlinks, and verified to match `process.getuid()`.
- All temporary files (`state.json.tmp.<pid>.<nonce>`) are opened with `fs.openSync(path, "wx", 0o600)` (`O_CREAT | O_EXCL`) and cryptographic random nonces (`crypto.randomBytes(12).toString("hex")`).
