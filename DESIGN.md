# Android Traffic Control (ATC) design

> [!IMPORTANT]
> **ATC 3.0 supersedes the command-execution parts of this historical spec.** ATC no longer receives, inspects, rewrites or runs shell commands: `atc exec -- <cmd>`, `atc guard`, and PreToolUse command classification (§6.1 `exec` row, §7.1, §9.4, §9.5.3) are removed. Agents request allowlisted typed operations (`atc exec <system> <op>`, `atc batch`, `atc_*` MCP tools) and hooks only record session identity. See [`docs/scope.md`](docs/scope.md) for the 3.0 contract and [`docs/architecture.md`](docs/architecture.md) for the current design. Lease, queue, lock, snapshot and recovery sections below still describe current behavior.

- **Status:** 1.0 Design Specification (v1.0.0)
- **Target Platforms:** macOS, Linux (Windows supported via `adb` and SDK `emulator` fallback; `android emulator` subcommands are macOS/Linux only per official Android CLI support)
- **Runtime Stack:** Node.js (>= 20 LTS, zero external runtime dependencies, ESM `.mjs`)
- **Integration Targets:** Official `android` CLI (`android emulator`, `android run`, `android layout`, `android screen`), `adb`, Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code, and Stdio MCP.

---

## 1. Problem Statement & Scope

Agents and terminal sessions on one host can request the same Android Virtual Device (AVD) or physical USB/Wi-Fi device:

1. **Mid-task collision:** Agent A is inspecting a UI tree (`android layout`) or running instrumentation tests while Agent B installs a different APK, clears app data, navigates away, or stops the emulator.
2. With multiple emulators or a connected personal phone, `adb` and `android` commands can fail or target the wrong device. Explicit `ANDROID_SERIAL` or `--device=<serial>` targets prevent this ambiguity.
3. Starting every offline AVD at once can exhaust host RAM, CPU capacity, or disk space. Strict first-in, first-out (FIFO) ordering can require repeated cold boots between different profiles.
4. **Orphaned locks:** An agent session crashes, hits a turn limit, or forgets to release its device, blocking subsequent sessions.

### ATC coordinates device ownership and preparation
ATC matches exclusive device leases by hardware and operating system (OS) profile. Each lease has a time to live (TTL). ATC queues competing requests, prepares snapshots or clean storage, and scopes commands to leased devices. Agent hooks check commands before execution. ATC uses the official `android` CLI without a background daemon.

### Non-Goals
- Replicating `android` CLI features (SDK management, layout inspection, screenshot capture, APK installation).
- Remote/distributed device farms across multiple physical hosts.
- Multi-instance booting of the same AVD simultaneously (Android AVDs lock their `.avd` directory via `hardware-qemu.ini.lock`; ATC enforces a strict 1-lease-per-AVD invariant).
- OS-level mandatory access control against hostile local users. Agent hooks check cooperative agents; local processes can bypass them.
- Persistent background daemon processes that require OS service managers, code signing, or notarization.

---

## 2. Stack & Portability Rationale

ATC uses Node.js >= 20 with ECMAScript modules (ESM) and no runtime dependencies (`atc.mjs`):

- **Why Node.js with zero native dependencies?**
  - Every target coding agent environment (Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code) already runs on or alongside Node.js on macOS, Linux, and Windows.
  - ATC uses JavaScript (`.mjs`) and Node's built-in modules: `node:fs`, `node:path`, `node:os`, `node:child_process`, `node:crypto`, and `node:readline`.
  - It requires no binary compilation (`node-gyp`), Apple Developer ID signing or notarization, or Windows SmartScreen binary allowlisting.
  - Agents can invoke it through `npx`, global `npm install -g`, or `node "<pluginRoot>/bin/atc.mjs"` from a plugin or extension directory.

---

## 3. Architecture Overview

ATC coordinates CLI commands through a state file in a local user-private directory. An atomic directory lock serializes state changes. ATC has no background daemon. Commands include `claim`, `free`, `renew`, `snapshot`, `exec`, `guard`, `status`, `config`, `gc`, `hook`, and `mcp`.

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
ATC stores state on a local filesystem in a user-private directory with mode `0700`. Files use mode `0600` on POSIX. These checks protect against symlink and temporary-file attacks from other users. ATC does not support NFS or SMB network shares.

- **Override:** `ATC_STATE_DIR` (must be an absolute path on a local disk; verified via `fs.lstatSync` not to be a symlink and owned by `process.getuid()` on POSIX).
- **macOS:** `~/Library/Application Support/atc`
- **Linux:** `$XDG_RUNTIME_DIR/atc` (if set, local, and `0700`) or `~/.local/state/atc`
- **Windows:** `%LOCALAPPDATA%\atc`

### 3.2 Cross-Platform Mutual Exclusion (`atc.lock`) & Strict Lock Boundary

#### Invariant: Zero Subprocesses Under Lock
ATC must never spawn an external subprocess while holding `atc.lock`. This includes `android`, `adb`, `ps`, and `powershell`. ATC gathers inventory before acquiring the lock. It boots and stops devices after releasing the lock. Persisted `"starting"` and `"stopping"` leases reserve devices during these operations.

ATC limits locked work to less than 20 ms of local memory and filesystem operations:
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
   - ATC treats a lock as stale when any condition holds:
     - `owner.json` has existed for > `10,000ms` (`Date.now() - owner.createdAtMs > 10000`), OR
     - `owner.json` is missing/unreadable for > `2,000ms` across retries (crashed mid-acquire or unlinked during release), OR
     - `owner.pid` is confirmed dead via `process.kill(owner.pid, 0)` throwing `ESRCH`.
   - The waiter atomically renames `<stateDir>/atc.lock` to `<stateDir>/atc.lock.stale.<waiterNonce>` to avoid racing other waiters.
   - If `renameSync` fails with `ENOENT`/`EPERM`/`EACCES`, the waiter sleeps and retries normal acquisition. Another waiter has already broken the lock.
   - After a successful rename, the waiter recursively deletes `atc.lock.stale.<waiterNonce>` outside the critical section and retries `Acquire`.
   - Otherwise, sleep `20ms–60ms` (with random jitter) and retry up to `lockTimeoutMs` (`5,000ms`).
3. **Nonce-Verified Commit & Release:**
   - Before renaming `state.json.tmp.<pid>.<myNonce>` onto `state.json`, the holder re-reads `<stateDir>/atc.lock/owner.json` and checks `owner.nonce === myNonce`.
   - If `owner.json` is missing or `owner.nonce !== myNonce`, another process has broken the lock. The holder must abort its write and unlink its temporary file. It must leave `atc.lock` intact.
   - A two-syscall race remains if the kernel sends `SIGSTOP` between nonce verification and `renameSync`. The design limits this risk with critical sections below 20 ms and a 10-second stale threshold.
   - If `owner.nonce === myNonce`, commit `state.json`, unlink `<stateDir>/atc.lock/owner.json`, and call `fs.rmdirSync("<stateDir>/atc.lock")`.
   - Windows antivirus handles can cause `rmdirSync` to throw `EBUSY`/`EPERM`/`ENOTEMPTY` after ATC unlinks `owner.json`. Ignore that error and treat release as successful. The missing-owner rule removes the empty directory after more than two seconds.
4. **Windows Atomic Rename & Corruption Recovery:**
   - State writes open `<stateDir>/state.json.tmp.<pid>.<myNonce>` with flag `"wx"` (`O_CREAT | O_EXCL`, mode `0o600`), write JSON, call `fsyncSync`, close the descriptor, and call `fs.renameSync(tmpPath, statePath)`.
   - On Windows, antivirus or indexer handles can make `renameSync` throw `EPERM` or `EACCES`. Retry up to five times with `15ms–45ms` delays. If all retries fail, unlink `tmpPath`, release `atc.lock`, and exit with code `1`. Keep the previous `state.json` intact.
   - If `state.json` cannot be parsed (`SyntaxError`) or fails top-level schema validation, quarantine it by renaming to `state.json.corrupt.<timestamp>`, log a warning to `stderr`, and initialize a fresh default state.

---

## 4. Data Model (`state.json`)

`state.leases` uses a canonical `deviceKey` for virtual and physical USB/Wi-Fi devices. These keys support the 1.0 and 2.0 platforms without a schema migration (see §9):
- **`avd:<avdId>`** for Android Virtual Devices (enforcing at most one lease/instance per AVD, both before and after boot).
- **`sim:<udid>`** *(reserved for ATC 2.0 iOS Simulators, keyed by `CoreSimulator` UDID)*.
- **`serial:<serial>`** for physical devices (`kind: "physical"`, using `adb` serial on Android or hardware `UDID` on iOS).

Every lease has `state` in `"starting" | "active" | "stopping"`. The `"starting"` state covers AVD creation, boot, snapshot restore, and data wipe outside `atc.lock`. The `"stopping"` state covers `atc free` actions outside the lock: `--snapshot-save`, `--snapshot-load`, and `android emulator stop`.

#### Forward-Compatibility & Mixed-Version Coexistence Invariants (1.0 <-> 2.0)
Agents on one machine can invoke different cached versions of `atc`, including 1.0 and 2.0. Version 1.0 must follow these compatibility rules:
1. **Round-Trip Preservation of Unknown Fields:** When reading and re-serializing `state.json`, 1.0 preserves any unrecognized keys in `config`, `leases[*]`, and `queue[*]` verbatim.
2. **Platform-Scoped Offline Reconciliation & Matching:** 1.0's offline-grace reconciliation (§5.3 Step 2) and profile matching (§5.3 Step 4) only evaluate records where `(record.platform || "android") === "android"`. A 1.0 process will never reap an active `platform: "ios"` (`sim:<udid>`) lease simply because it is absent from `android emulator list` / `adb devices`.
3. **Cross-Platform RAM Budget Awareness:** 1.0's `projectedAvailableRamMb` calculation (§5.2.4) subtracts `requiredRamMb` for all `"starting"` or recently activated leases regardless of `platform`.

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
    "offlineGraceMs": 45000,
    "physicalOfflineGraceMs": 15000,
    "autoStopIdleOnContention": true,
    "allowPhysicalDevices": "explicit"
  },
  "leases": {
    "avd:Pixel_9": {
      "leaseId": "lease_9f8a7b6c5d4e",
      "deviceKey": "avd:Pixel_9",
      "platform": "android",
      "kind": "emulator",
      "avd": "Pixel_9",
      "serial": "emulator-5554",
      "profile": {
        "platform": "android",
        "deviceType": "phone",
        "deviceName": "pixel_9",
        "apiLevel": "android-36",
        "osVersion": null,
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
      "requiredDiskMb": 0,
      "loadedSnapshot": "clean_boot",
      "saveSnapshotOnFree": null,
      "claimedAtMs": 1791292800000,
      "activatedAtMs": 1791292804000,
      "renewedAtMs": 1791292860000,
      "expiresAtMs": 1791293460000,
      "deadlineMs": null,
      "firstSeenOfflineAtMs": null,
      "isRecovery": false,
      "reason": "UI test verification"
    }
  },
  "queue": [
    {
      "ticketId": "q_1a2b3c4d5e6f",
      "sessionId": "agent-77c09a",
      "waiterPid": 51092,
      "requestedPlatform": "android",
      "requestedKind": "emulator",
      "requestedAvd": null,
      "requestedSerial": null,
      "requestedProfile": {
        "platform": "android",
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
  },
  "disconnectedPhysicalLeases": {}
}
```

### 4.1 Lease Lifecycle States & Physical Device Semantics (MVP -> 1.0)
| `lease.state` | Meaning | Counted in `usedSlots`? | Claimable by others? |
| :--- | :--- | :--- | :--- |
| `"starting"` | Device reserved by `workerPid` while boot, `--wipe-data`, `--snapshot-load`, or `--reset-app` runs outside lock | Emulators: Yes (unless `replacingAvd` is already counted as running or `"stopping"`, in which case the pair counts as 1 slot); Physical: No | No |
| `"active"` | Exclusively owned by `sessionId` until `expiresAtMs` (`emulator` or `physical`) | Emulators: Yes; Physical devices: **No** (zero host QEMU RAM/CPU cost) | Only idempotently by the same `sessionId` |
| `"stopping"` | Device reserved by `workerPid` while post-lease actions (`--snapshot-save`, `--snapshot-load`, or `android emulator stop <serial>`) run outside lock | Emulators: Yes; Physical: No | No |

#### Physical devices require an explicit claim
1. Unfiltered `atc claim` defaults to `--kind emulator`. This keeps test APKs off a developer's connected phone unless the agent requests physical access.
2. **Explicit / 1.0 Physical Device Claims:** A physical device can be claimed when explicitly targeted (`atc claim --serial <usb_or_wifi_serial>` or `atc claim --kind physical|any`, or when allowlisted in `config.allowedPhysicalSerials` for 1.0).
3. ATC cannot boot or stop physical devices. On physical leases, `atc free --stop` warns and performs no stop action. Priority-3 eviction excludes `kind: "physical"`. Physical devices use no `maxRunningEmulators` slots.

### 4.2 Host-Agnostic Session Identity & `anchorPid` Resolution
Agent tool calls run in short-lived subshells. The `atc claim` process exits after each call. ATC must identify sessions across Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code, and terminals. It must work without command-rewriting hooks and distinguish agents sharing one repository directory (`cwd`).

1. **Explicit CLI Flag, Lease Token, or Env Var (Highest Priority, Universal):**
   - `--session <id>`, `ATC_SESSION_ID`, or `--lease <leaseId>` / `ATC_LEASE_ID` (with `anchorPid = parseEnvInt(ATC_ANCHOR_PID) || null`). Any agent or script can pass `--session` or `ATC_LEASE_ID` directly with zero hook dependencies.
2. **Extension / Hook Command Rewrite (Pi, Antigravity, Gemini CLI, Claude Code):**
   - Rewriting hosts add `ATC_SESSION_ID=<id> ATC_ANCHOR_PID=<agentPid>` before `atc` commands that lack `--session`.
   - Pi uses `event.input.command` in its `tool_call` extension. Antigravity/Gemini CLI use `overwrite`. Claude Code uses `hookSpecificOutput.updatedInput`.
   - ATC reads these variables to distinguish sessions, including sessions sharing one `cwd`.
3. **Ambient Agent Environment Variables:**
   - Checks standard session/conversation variables exported by agent runtimes: `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_TRACE_ID`, `CURSOR_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CLAUDE_SESSION_ID`, `CONVERSATION_ID`.
4. **PID-Keyed Hook Breadcrumb (`state.hookSessions`, for non-rewriting hooks like Codex & Cursor):**
   - Every `PreToolUse` hook invocation also records `state.hookSessions[agentPid] = { sessionId, agentPid: process.ppid, cwd, updatedAtMs }` (retained for 60s and swept by in-memory GC).
   - When `atc` runs without `ATC_SESSION_ID`:
     - If `state.hookSessions[process.ppid]` exists and is fresh, use it directly (`0ms`).
     - Otherwise inspect fresh entries in `state.hookSessions` matching `process.cwd()`:
       - If **exactly one** active session exists for `cwd`, select it (`0ms`).
       - If multiple sessions share `cwd` and the host cannot rewrite commands, release `atc.lock` before checking ancestor process IDs (PIDs).
       - On POSIX, use `ps` to match an ancestor to `agentPid` in `state.hookSessions`. On Windows, reject the ambiguous call without spawning a subprocess.
       - If the match remains ambiguous, exit `1` and require `--session <unique_id>`.
5. **Stdio MCP server (`atc mcp`, including Cursor, Windsurf, and Zed):**
   - When invoked via `atc mcp`, the MCP server process stays alive for the duration of the agent session: `sessionId = "mcp-" + process.pid`, `anchorPid = process.pid`.
6. **Universal Parent-Process / Terminal Fallback (Zero-Hook Agents & Interactive Shells):**
   - ATC uses `TMUX_PANE`, `TERM_SESSION_ID`, or `ppid-${process.ppid}` with `anchorPid = process.ppid`.
   - Agent runtimes and interactive shells (`zsh`, `bash`, `pwsh`, `cmd`) usually remain alive while their tool commands run and exit.
   - ATC checks `process.ppid`, or the nearest non-wrapper ancestor, through `process.kill(anchorPid, 0)`. This enables dead-agent lease cleanup without hooks.
   - ATC does not use `WT_SESSION` alone because Windows Terminal shares it across tabs and panes.

ATC validates session IDs against `/^[A-Za-z0-9._:-]{1,128}$/`. It clamps `claim` and `renew` `--ttl` values to `[10, config.maxTtlSec]`. It normalizes `--api` values `"36"` and `"android-36"` to `"android-36"`. The OS can reuse a dead `anchorPid` for an unrelated process. In that case, `expiresAtMs` and `config.maxTtlSec` (one hour) bound reclamation.

---

## 5. Core Workflows & State Machine

### 5.1 Garbage Collection (In-Memory inside `atc.lock`, + Orphan File Sweep)
At the start of every locked transaction:
1. **Expired or Clock-Skewed Active Leases:** Remove any lease with `state === "active"` where `now >= lease.expiresAtMs`, `now < lease.claimedAtMs` (backward NTP clock jump guard), or `now > lease.claimedAtMs + (config.maxTtlSec * 1000)`.
2. **Dead Anchor Reclamation:** Remove any `"active"` lease where `lease.anchorPid !== null` and `!isPidAlive(lease.anchorPid)` (`process.kill(anchorPid, 0)` throws `ESRCH`).
3. Workers protect `"starting"` and `"stopping"` leases during boot, wipe, recovery, and snapshot operations outside `atc.lock`.
   - Each worker runs an `unref()`'d `setInterval` heartbeat every `15,000ms`. Under `atc.lock`, it checks `leaseId` and `workerPid === process.pid`, then sets `lease.deadlineMs = Date.now() + timeoutMs`.
   - `deadlineMs` tracks worker liveness separately from ownership expiration (`expiresAtMs`).
   - If `lease.isRecovery === true` and `Date.now() >= lease.expiresAtMs`, the worker aborts recovery. It stops the device outside `atc.lock`, deletes the `"starting"` lease under the lock, and exits `1`.
   - Garbage collection (GC) removes transitional leases only for `!isPidAlive(lease.workerPid)`, `now < lease.claimedAtMs`, or `now >= lease.deadlineMs`.
   - This preserves a live worker's reservation until its deadline, unless the clock moves backward.
4. **Dead/Expired Queue Tickets:** Remove any ticket in `state.queue` where `now >= ticket.waitExpiresAtMs`, `now >= ticket.lastHeartbeatAtMs + (config.queueHeartbeatTimeoutSec * 1000)`, `now < ticket.enqueuedAtMs`, or `!isPidAlive(ticket.waiterPid)`.
5. **Expired Hook Breadcrumbs & Disconnect Tombstones:** Remove any entry in `state.hookSessions` where `now - entry.updatedAtMs > 60_000` or `!isPidAlive(entry.agentPid)`, and remove any entry in `state.disconnectedPhysicalLeases` where `now >= entry.expiresAtMs` or `now < entry.disconnectedAtMs`.
6. **Orphan Temp/Lock File Sweep (Best-Effort):** Periodically (at most once every 60s), unlink any `state.json.tmp.*` or `atc.lock.stale.*` entries in `<stateDir>` whose `mtimeMs` is older than `60,000ms`.

### 5.2 Fleet, Profile, Snapshot & Host Capacity Discovery (Always Outside `atc.lock`)
Before acquiring `atc.lock`, `claim` and `status` discover `running`, `offline`, and `creatable` devices. They also read current host resources:

1. **Base Device List (`android emulator list --long` + `adb devices`):**
   - `android emulator list --long` parses `AVD ID`, `AVD Name`, `API Level`, `Status` (`Online`/`Offline`), and `Serial` (`kind: "emulator"`).
   - `adb devices` classifies connected serials into:
     - **Emulators (`/^emulator-\d+$/`):** Any running `emulator-<port>` not yet mapped is resolved via `adb -s <serial> emu avd name`.
     - **Physical devices (non-`emulator-*` serials in `device` state):** Indexed as `deviceKey: "serial:<serial>"`, `kind: "physical"`. Excluded from default `--kind emulator` claims and lifecycle stops, but claimable via `--serial <serial>` or `--kind physical|any`.
2. **Zero-Subprocess Local AVD Profile, Resource & Snapshot Enrichment (`~/.android/avd`):**
   - For every discovered AVD, ATC reads `<ANDROID_AVD_HOME || ~/.android/avd>/<avdId>.ini` and `<avdPath>/config.ini` directly from the local filesystem (<1ms, zero subprocesses) to extract:
     - ATC derives `deviceType` from `hw.device.name` and `image.sysdir.1`. Values are `"phone" | "tablet" | "foldable" | "desktop" | "watch" | "xr" | "tv" | "automotive" | "resizable"`.
     - The deprecated `--type wear` alias normalizes to `"watch"`.
     - Examples include `pixel_9` as `"phone"`, `medium_tablet` as `"tablet"`, and `wearos_small_round` as `"watch"`.
     - `xr_glasses_device` and `ai_glasses_*` map to `"xr"`. `resizable` maps to `"resizable"` and also satisfies `"phone" | "foldable" | "tablet" | "desktop"` as a secondary match.
     - If neither source identifies a specialized form factor, ATC defaults to `"phone"`.
     - **`services` & `playStore`:** Parsed from `PlayStore.enabled` (`true`/`false`) and `image.sysdir.1` system-image tag:
       - `"play"`: `PlayStore.enabled=true` or tag contains `playstore` / `android-wear-signed`.
       - `"google_apis"`: `PlayStore.enabled=false` and tag contains `google_apis`.
       - `"aosp"`: `PlayStore.enabled=false` and tag is `default` or `aosp_*`.
     - **`abi`:** Parsed from `abi.type` (e.g., `arm64-v8a`, `x86_64`).
     - ATC reads `ramSizeMb` from `hw.ramSize`, defaulting to `2048` MB. It adds `config.qemuOverheadRamMb = 1024` MB for hypervisor and GPU overhead: `requiredRamMb = hwRamMb + 1024`.
     - It reads `cpuCores` from `hw.cpu.ncore`, defaulting to `4`. It computes `dataDiskMb` from `disk.dataPartition.size` plus `sdcard.size`, defaulting to `6144 + 512 = 6656` MB.
     - **`snapshots`:** Directory names listed via `fs.readdirSync("<avdPath>/snapshots")` (e.g., `["default_boot", "logged_in"]`).
3. **Creatable Capacity Discovery (`<sdk>/system-images` + `android emulator create --list-profiles`):**
   - Inspects `<sdk>/system-images/android-*/<tag>/<abi>/` on disk to report which `(deviceType, apiLevel, services, abi)` profiles do **not** yet have an AVD on disk:
     - `readyToCreate`: System image is already installed locally; an AVD can be created in ~2s via `android emulator create <profile>` (or automatically on `atc claim --create-if-missing`).
     - `requiresSdkInstall`: System image is not yet installed locally; outputs the exact `android sdk install "system-images/..."` command needed.
4. **Host resource checks and concurrency limits:**
   - ATC combines a configurable slot limit with RAM and disk checks. The `--force` flag bypasses the resource checks.
   - **Effective Slot Limit (`effectiveMaxEmulators`):**
     - If `config.maxRunningEmulators` is an explicit integer (set via `atc config set maxRunningEmulators <N>` or `ATC_MAX_EMULATORS=<N>`), use `<N>`.
     - The default is `2` concurrent emulators. With `"auto"`, compute the limit from `os.totalmem()` and `os.availableParallelism()`:
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
      - **Before Booting an Offline Emulator `C` (or Saving a Snapshot):**
        - Each virtual-device lease (`kind === "emulator"`) stores `requiredRamMb`, `requiredDiskMb`, and `activatedAtMs`.
        - Android reserves `hw.ramSize + config.qemuOverheadRamMb` RAM. iOS reserves `config.simOverheadRamMb`.
        - During `"starting"` / `"stopping"`, `requiredDiskMb` records the pending disk reservation. Activation resets it to `0`.
        - Every activation, including recovery, sets `activatedAtMs` to `now`.
        - Guest RAM allocation can continue after `sys.boot_completed=1` / `bootstatus`. ATC accounts for that delay in `projectedAvailableRamMb`.
        - It subtracts virtual-device reservations across all platforms for `state === "starting"` or (`state === "active" && lease.firstSeenOfflineAtMs === null && now - lease.activatedAtMs < 30_000`).
        - It excludes any `replacingAvd` / `replacingKey` that the caller is stopping:
          `projectedAvailableRamMb = availableRamMb + (replacingVictim ? replacingVictim.requiredRamMb : 0) - sum(startingOrRecentlyActivatedVirtualLeases.requiredRamMb)`
        - `projectedFreeDiskMb` subtracts `requiredDiskMb` for all pending `"starting"` and `"stopping"` leases on the target volume. This accounts for concurrent boots, snapshot saves, wipes, and AVD creations outside `atc.lock`:
          `projectedFreeDiskMb = freeDiskMb - sum(inFlightTransitionalLeases.requiredDiskMb)`
        - Rule R1 requires `projectedAvailableRamMb >= C.requiredRamMb + config.minFreeRamMb (2048 MB)`. If it fails, evict an eligible idle virtual device `V` under Priority 3. After `V` stops, check live `availableRamMb` again before booting `C` (Step 5.1). If RAM remains insufficient without `--force`, exit `5` (`ERESOURCE_EXCEEDED`).
        - Rule D1 requires `projectedFreeDiskMb >= C.ramSizeMb + config.minFreeDiskMb (2048 MB)`. Reserve `lease.requiredDiskMb = C.ramSizeMb` during `"starting"` / `"stopping"`. This accounts for concurrent QCOW2 overlay growth and snapshot writes that could exhaust disk and corrupt the AVD.
      - **Before Creating an AVD (`--create-if-missing`) or Wiping Data (`--wipe-data`):**
        - Rule D2 requires `projectedFreeDiskMb >= C.dataDiskMb + config.minFreeDiskMb (2048 MB)`, typically `6.5 GB + 2.0 GB = 8.5 GB`. Reserve `lease.requiredDiskMb = C.dataDiskMb` while `"starting"`. If the check fails without `--force`, exit `5` (`ERESOURCE_EXCEEDED`).

### 5.3 Claiming a Device by Profile, Snapshot/Wipe State & Bounded-Window Affinity (`atc claim`)
Inputs:
- **Profile Filters:** `[--type <phone|tablet|foldable|desktop|watch|xr|tv|automotive|resizable>] [--api <36|>=34|34..36>] [--play | --no-play | --services <play|google_apis|aosp>] [--abi <abi>] [--avd <avdId>] [--serial <serial>] [--kind <emulator|physical|any>] [--create-if-missing]` *(note: `--type wear` is accepted as a deprecated alias for `--type watch`)*
- **State / Snapshot Preparation:** `[--snapshot-load <name>] [--snapshot-save-on-free <name>] [--wipe-data] [--cold] [--reset-app <pkg>] [--headless]`
- **Lease, Queue & Resource Controls:** `[--ttl <sec>] [--wait <sec>] [--reorder-window <sec>] [--force] [--reason <text>]`

#### Step 1: Gather Inventory & Host Resources Outside Lock
Run §5.2 to obtain the current snapshot of running devices, offline AVDs (with `.ini` profiles, RAM/disk requirements, and snapshot lists), creatable SDK profiles, and host RAM/disk capacity.

#### Step 2: Acquire `atc.lock` & Run GC (§5.1) + Offline Grace & Owner-Recovery Window
- Only evaluate `"active"` leases whose `lease.platform || "android"` was queried in Step 1's inventory snapshot (in 1.0, `"android"` only; in 2.0, any platform whose inventory was gathered in Step 1).
- Platform-specific offline predicates (using Step 1's discovered **AVD/device-to-serial mapping** rather than raw serial presence):
  - An Android emulator (`platform: "android"`, `kind: "emulator"`) is offline when `android emulator list --long` reports `L.avd` as `Offline`.
    No running `emulator-*` serial in `adb devices` may resolve to `L.avd` in Step 1's mapping.
    This prevents a reused `emulator-<port>` serial for another AVD from keeping `L` online.
    If Step 1 finds `L.avd` online with a different serial, update `L.serial` to that AVD's current serial.
  - **Android physical (`platform: "android"`, `kind: "physical"`):** Confirmed offline when `L.serial` is absent from `adb devices` (or not in `device` state).
  - An iOS Simulator (`platform: "ios"`, `kind: "emulator"`; 2.0, §9.3) is offline when `xcrun simctl list --json` reports `state !== "Booted"` or omits its `udid`.
  - A physical iOS device (`platform: "ios"`, `kind: "physical"`; 2.0, §9.3) is offline when `xcrun devicectl list devices --json-output` omits its hardware `udid` or reports it disconnected/unavailable.
- **Bounded Owner-Recovery Guard Window (Strictly Scoped to Confirmed-Offline Leases; Never Prolongs `expiresAtMs`):**
  - **Online leases (`L` confirmed online in Step 1):** Ensure `L.firstSeenOfflineAtMs = null` and leave `L` intact (online leases are **never** removed by Step 2 reconciliation).
  - **Confirmed-offline leases (`L` confirmed offline in Step 1):**
    - When inventory first confirms `L` offline, set `L.firstSeenOfflineAtMs = now` unless already set.
    - For an Android emulator (`L.platform === "android" && L.kind === "emulator"`), clear `L.serial = null`. This prevents commands from reaching another AVD that reuses its port.
    - A lease with `L.firstSeenOfflineAtMs !== null` reserves `L.deviceKey` and its slot for Step 3 recovery.
    - That reservation cannot authorize `atc exec`, `atc snapshot`, `atc renew`, or `atc guard`. It also cannot authorize post-lease `adb`/`stop` commands in `atc free`.
    - Set `graceMs = L.kind === "physical" ? (config.physicalOfflineGraceMs ?? 15000) : (config.offlineGraceMs ?? 45000)`.
    - Virtual devices default to `45,000ms`, giving the agent time to request recovery after a crash. Physical devices default to `15,000ms` to allow brief USB/Wi-Fi reconnects.
    - The offline guard window is strictly capped by the lease's existing expiration: `recoveryDeadlineMs = Math.min(L.expiresAtMs, L.firstSeenOfflineAtMs + graceMs)`. It **never** extends `L.expiresAtMs`.
    - **If `now >= recoveryDeadlineMs`:**
      - If `L.kind === "physical"`, record `state.disconnectedPhysicalLeases[L.leaseId] = { leaseId: L.leaseId, sessionId: L.sessionId, serial: L.serial, platform: L.platform || "android", profile: L.profile, disconnectedAtMs: L.firstSeenOfflineAtMs, expiresAtMs: L.expiresAtMs }`.
      - GC (§5.1) removes this disconnect record at `L.expiresAtMs`. It lets Step 3 report the disconnect even when another waiter has already removed `L` after 15 seconds.
      - Delete the confirmed-offline lease `L` from `state.leases`.
    - If `now < recoveryDeadlineMs`, keep `L` in `state.leases` for Step 3. This preserves a virtual-device owner's reservation while other callers wait.

#### Step 3: Idempotent Re-Claim & In-Place Crash Recovery (Same Session)
Inspect any `"active"` lease `L` owned by `sessionId` matching the requested profile filters (`matchesProfile(L, req)`), as well as any disconnect tombstone `T` in `state.disconnectedPhysicalLeases` where `T.sessionId === sessionId` and `matchesProfile(T, req)`:
1. **Device is Online (`L.firstSeenOfflineAtMs === null`):**
   - If no state reset (`--wipe-data` / `--cold` / `--snapshot-load` / `--reset-app`, or `L.loadedSnapshot === req.snapshotLoad` and no `--reset-app`) is requested: renew `L.expiresAtMs = now + ttlMs` and return `L` immediately.
   - If the session requests a reset of its online virtual device, update `L` in place.
   - Set `state: "starting"`, `workerPid: process.pid`, `deadlineMs: now + bootTimeoutMs`, `requiredDiskMb: req.wipeData ? C.dataDiskMb : C.ramSizeMb`, and `isRecovery: false`.
   - Commit, release `atc.lock`, and continue to Step 5.
2. **Virtual Device Crashed / Closed (`L.kind === "emulator"` and `L.firstSeenOfflineAtMs !== null`):**
   - Because `L` remained in `state.leases` (`now < recoveryDeadlineMs`), `L` still holds its `deviceKey` and its slot in `occupiedVirtualKeys` ahead of queued waiters.
   - Check whether `L` can be recovered in-place right now:
     - Check that Step 1's offline inventory still contains the AVD/Simulator. Require target-platform `usedSlots <= effectiveMaxSlotLimit`.
     - `usedSlots` already includes `L.deviceKey`, so recovery adds `0` slots unless another process started a device outside ATC.
     - If slots or RAM are insufficient, Priority 3 can select an unreserved idle device `V`. Mark `V` as `"stopping"` through `replacingAvd: V.avd`.
     - Require `L` to pass Rule R1 and Rule D1/D2 (§5.2.4), unless `--force` is set.
     - If recovery can proceed, set `state: "starting"`, `workerPid: process.pid`, `isRecovery: true`, `requiredDiskMb: req.wipeData ? C.dataDiskMb : C.ramSizeMb`, and `deadlineMs: now + bootTimeoutMs` on `L`.
     - Keep `L.expiresAtMs` unchanged. `deadlineMs` tracks worker liveness separately. Remove the session's queue ticket, commit, release `atc.lock`, and continue to Step 5.
     - If recovery cannot proceed, delete `L` from `state.leases`. Warn on `stderr` that recovery lacks resources and the session is rejoining the queue. Continue to Step 4 / Step 6.
3. **Physical Device Disconnected (`L.kind === "physical"` with `L.firstSeenOfflineAtMs !== null`, OR a matching tombstone `T` in `state.disconnectedPhysicalLeases` for `sessionId`):**
   - ATC cannot restart the disconnected physical device. Delete `L` from `state.leases` and `T` from `state.disconnectedPhysicalLeases` if present.
   - Commit, release `atc.lock`, and exit `1` without queuing. Removing `T` lets a later claim proceed after the agent checks `atc status`.
   - Report that the physical device `<serial>` disconnected, ATC released its lease, and the agent must run `atc status` before claiming again.

#### Step 4: Bounded-Window Warm-Affinity Scheduling & Candidate Selection (Under Lock)
ATC can reorder requests to reuse running emulators. A bounded reorder window limits delays for profiles that need a cold boot, including Wear OS, XR, and older AOSP APIs:

1. **Profile Matching (`matchesProfile(device, req)`):**
   - `matchesProfile` checks `(device.platform || "android") === (req.platform || "android")`, `kind`, `avd`, `serial`, and `abi`.
   - It checks `deviceType` and prefers an exact match over `resizable`. It accepts `apiSpec` values such as `36`, `>=34`, and `34..36`.
   - `--play` requires `services === "play"`. `--no-play` requires `playStore === false`.
   - With `--snapshot-load <name>`, it requires `<name>` in `device.snapshots`.
2. **Affinity Tiers (Cost to Run Now):**
   - Tier 0 (`WARM_IDLE_MATCH`) requires an online, unleased device matching `req` without a QEMU restart. `--wipe-data` and `--cold` must be false.
   - Live `--snapshot-load <name>` through `adb emu avd snapshot load` and `--reset-app <pkg>` remain in Tier 0. They keep QEMU running and need no extra RAM.
   - Physical devices can match Tier 0 only when `--kind physical|any` or `--serial` requests them. Tiers 1 and 2 never apply to physical devices.
   - **Tier 1 (`FREE_SLOT_BOOT`):** Candidate AVD is **offline** (or requires reboot for `--wipe-data` / `--cold`), `usedSlots < effectiveMaxEmulators`, and host RAM/disk passes §5.2(4) without stopping a running emulator.
   - **Tier 2 (`COLD_EVICT_BOOT`):** `usedSlots >= effectiveMaxEmulators` (or free host RAM is insufficient without eviction) and running `req` requires stopping an idle running emulator (`Priority 3`) to cold-boot a different offline AVD.
3. **Bounded Reorder Window & Resource-Scoped Anti-Starvation Invariant (`reorderWindowSec`, default `120s`):**
   - Every queue ticket `T` records `enqueuedAtMs` and `starvationDeadlineMs = enqueuedAtMs + (config.reorderWindowSec * 1000)`.
   - An earlier ticket `E` in `state.queue` is **Starvation-Protected (Frozen at Priority 0)** relative to a later caller/ticket `C` if:
     - `now >= E.starvationDeadlineMs` (i.e., `E` has already waited `>= reorderWindowSec` since it was enqueued), **OR**
     - `C.enqueuedAtMs - E.enqueuedAtMs > config.reorderWindowSec * 1000` (`C` arrived outside `E`'s reorder window).
   - **Resource-Scoped Reservation Helper `isReservedForEarlierTicket(candidateDeviceOrSlot)` (No Unrelated Head-of-Line Blocking):**
     Starvation protection reserves competing devices, slots, RAM, and devices selected for eviction. Later requests can use unrelated resources:
     1. **Direct Device Contention:** If an earlier ticket `E` matches `candidateDevice` (`matchesProfile(candidateDevice, E.req)`), then `candidateDevice` is reserved for `E` (unless `E` itself is still blocked on another condition).
     2. If protected ticket `E` needs a slot or RAM, later caller `C` must leave enough resources for `E` to boot.
        If `E` needs an idle device `V` for eviction, reserve `V` for `E`. Later Tier 0 jobs cannot re-lease `V` after protection starts.
     3. If Tier 0 device `D` neither matches `E` nor provides its required eviction resources, `isReservedForEarlierTicket(D)` is `false`.
        Caller `C` can claim `D` immediately, even while `E` has protection. For example, `E` can wait on physical phone `--serial X` while `C` claims an unrelated emulator.
4. **Candidate Selection & Resource Admission Order:**
   - Compute `occupiedVirtualKeys` as a set of canonical `deviceKey` values in the target platform's slot pool.
   - Include running devices from the pre-lock inventory, whether leased or idle. Also include current virtual leases (`kind === "emulator"`) with `state === "active" | "stopping"`.
   - This counts leases activated after discovery without counting a device twice:
     `usedSlots = count(occupiedVirtualKeys) + count(startingVirtualLeases for platform where lease.deviceKey not in occupiedVirtualKeys and (lease.replacingAvd === null or ("avd:" + lease.replacingAvd) not in occupiedVirtualKeys))`
     A `"starting"` lease's `replacingAvd` / `replacingKey` offsets `usedSlots` only when its `"stopping"` device `V` belongs to the same platform pool.
   - Priority 1 selects a Tier 0 online, unleased device matching `req`. Require `isReservedForEarlierTicket(candidate)` false and no `--wipe-data` / `--cold`.
     - If **neither** `--snapshot-load` nor `--reset-app` is requested: transition immediately to `state: "active"`, remove caller's queue ticket, commit, release lock, and return in <5ms.
     - If `--snapshot-load <name>` or `--reset-app <pkg>` **is** requested: write lease with `state: "starting"`, `workerPid: process.pid`, `deadlineMs: now + bootTimeoutMs`, remove caller's queue ticket, commit, release lock, and proceed to Step 5 (Warm State Preparation outside lock).
   - Priority 2 boots a Tier 1 device when `usedSlots < effectiveMaxEmulators`. It can also restart an already-running unleased match for `--wipe-data` / `--cold`.
     Require `isReservedForEarlierTicket(candidate)` false. The candidate must pass §5.2.4's RAM and disk checks unless `--force` is set.
     - Write lease with `state: "starting"`, `workerPid: process.pid`, `requiredDiskMb: req.wipeData ? C.dataDiskMb : C.ramSizeMb`, `deadlineMs: now + bootTimeoutMs`, remove caller's queue ticket, commit, and release lock. Proceed to Step 5.
   - Priority 3 uses Tier 2 eviction when `usedSlots >= effectiveMaxEmulators` or Priority 2 lacks RAM, and `config.autoStopIdleOnContention` is `true`.
     - Select a running unleased device `V` with `isReservedForEarlierTicket(V)` false. Prefer the longest-idle device with no matching queued tickets.
     - When the target platform's slots are full, `V` must belong to that platform. Stopping it frees a target-platform slot.
     - With a free target slot and only shared RAM pressure under Rule R1, `V` can belong to either platform.
     - Select an offline unleased AVD `C` matching `req` with `isReservedForEarlierTicket(C)` false.
     - After reclaiming `V.requiredRamMb`, `C` must pass the target-platform slot check and §5.2(4).
     - Atomically write two records in `state.leases`:
       1. `state.leases[V.deviceKey] = { state: "stopping", serial: V.serial, workerPid: process.pid, deadlineMs: now + stopTimeoutMs, ... }`
       2. `state.leases[C.deviceKey] = { state: "starting", replacingAvd: V.avd, requiredDiskMb: req.wipeData ? C.dataDiskMb : C.ramSizeMb, workerPid: process.pid, deadlineMs: now + bootTimeoutMs, ... }`
     - Remove caller's queue ticket, commit, and release lock. Proceed to Step 5.
   - Priority 4 creates a missing AVD when `--create-if-missing` is set and no AVD on disk or in `state.leases` matches `req`.
     - Require a `readyToCreate` profile from §5.2(3) that passes Rule D2 and Rule R1.
     - Apply the same slot, starvation (`!isReservedForEarlierTicket`), and Priority-3 eviction checks as an offline boot.
     - Require `usedSlots < effectiveMaxEmulators`, or simultaneously mark an unreserved idle device `V` as `"stopping"` with `replacingAvd: V.avd`.
     - Reserve `state.leases["avd:creating:" + ticketId] = { state: "starting", avd: avdId, replacingAvd: V?.avd || null, requiredDiskMb: C.dataDiskMb, workerPid: process.pid, claimedAtMs: now, deadlineMs: now + bootTimeoutMs, ... }`.
     - Commit and release `atc.lock`. Create the AVD with `android emulator create <profile>` outside the lock.
     - Before booting, acquire `atc.lock` and atomically move the lease key from `"avd:creating:" + ticketId` to `"avd:" + actualAvdId`.
     - Release the lock and continue to Step 5.
   - If no virtual devices run or start on any platform, waiting cannot free virtual-device RAM or disk.
     - This requires `usedSlots === 0` and zero active/starting virtual-device RAM leases.
     - If offline candidate `C` still fails Rule R1 or Rule D1/D2 without `--force`, release `atc.lock` and exit `5` (`ERESOURCE_EXCEEDED`).
     - Report the failed resource check and the action needed.

#### Step 5: Evict, Boot & Snapshot/Wipe Preparation Phase (Outside Lock)
All external commands run strictly outside `atc.lock` while the device is protected by `state: "starting"`:
1. If `replacingAvd` is set, stop `V` with `android emulator stop <V.serial>` or, for iOS, `xcrun simctl shutdown <V.serial>`.
   Refresh `availableRamMb` outside `atc.lock`. Then acquire the lock, check `leaseId`, and delete `state.leases[V.deviceKey]`.
   Set `replacingAvd = null` on `C`'s `"starting"` lease. Check Rule R1 against current RAM and starting or recently activated leases, excluding `C`.
   If RAM remains insufficient without `--force`, delete `state.leases[C.deviceKey]`, commit, and exit `5` (`ERESOURCE_EXCEEDED`). Otherwise, release the lock before booting `C`.
2. **Warm State Preparation (if device was already online and `--wipe-data` / `--cold` are false):**
   - If `--snapshot-load <name>` is requested: run `adb -s <serial> emu avd snapshot load <name>`.
   - If `--reset-app <pkg>` is requested: run `adb -s <serial> shell pm clear <pkg>`.
3. **Cold / Snapshot / Wipe Boot (if device was offline, or needed restart for `--wipe-data` / `--cold`):**
   - If device was online and needed `--wipe-data` or `--cold`, run `android emulator stop <serial>` first.
   - If `--wipe-data` is specified, delete user-data/cache images and default quickboot snapshot in the AVD directory before starting with `--cold`.
   - Run `android emulator start <C.avd> [--headless] [--cold]` bounded by `bootTimeoutSec` and resolve the resulting `emulator-<port>` serial.
   - If `--snapshot-load <name>` is requested, run `adb -s <serial> emu avd snapshot load <name>` after boot.
   - If `--reset-app <pkg>` is also requested, run `adb -s <serial> shell pm clear <pkg>`.
4. Acquire `atc.lock` and check that `state.leases[C.deviceKey]` still matches the worker's `leaseId`.
   If `lease.isRecovery === true` and `now >= lease.expiresAtMs`, the original lease expired during boot.
   Release the lock and attempt to stop the newly booted device. Reacquire the lock, delete `state.leases[C.deviceKey]`, commit, and exit `1`.
   Otherwise, activate the lease with `serial`, `loadedSnapshot`, `saveSnapshotOnFree`, `requiredDiskMb: 0`, `activatedAtMs: now`, `firstSeenOfflineAtMs: null`, and `isRecovery: false`.
   Compute expiration from the previous recovery flag: `expiresAtMs = lease.isRecovery ? lease.expiresAtMs : (now + ttlMs)`. Recovery must preserve the original expiration.
   Refresh `activatedAtMs` even during recovery so the 30-second RAM accounting window in §5.2.4 applies. Commit and return.
5. **Rollback on Failure / Timeout / Signal:** Best-effort stop any newly booted emulator, acquire `atc.lock`, delete `state.leases[C.deviceKey]` (and `state.leases[V.deviceKey]` if still `"stopping"`), and exit with code `1`.

#### Step 6: Wait Queue Phase (If No Candidate Available)
- If `--wait 0` (non-blocking), release `atc.lock` and exit with code `2` (`EBUSY`).
- Under `atc.lock`, append a ticket if the caller has none in `state.queue`:
  `{ ticketId, sessionId, waiterPid: process.pid, requestedKind, requestedAvd, requestedSerial, requestedProfile, enqueuedAtMs: now, starvationDeadlineMs: now + reorderWindowMs, lastHeartbeatAtMs: now, waitExpiresAtMs: now + waitMs }`.
- After OS sleep, the waiter restores its original `enqueuedAtMs` and `starvationDeadlineMs` from process memory when reinserting before `waitExpiresAtMs`.
- Sleep beyond a lease TTL or `waitExpiresAtMs` expires the lease or wait. The next command performs cleanup.
- Release `atc.lock` and enter the **Two-Stage Poll Loop** (every `1,000ms` ± `200ms` jitter):
  1. Acquire `atc.lock`, run GC, and update `ticket.lastHeartbeatAtMs = now`. Check for a released lease or a caller now eligible to run, then release the lock. This stage starts no subprocesses.
  2. Outside the lock, refresh inventory through §5.2 when the first stage detects an available slot or device. Also refresh every fifth poll, about five seconds, to detect changes outside ATC. This includes an emulator that the user closed manually. Return to Step 2 after the refresh.

### 5.4 Releasing a Device & Post-Lease Snapshot Actions (`atc free`)
Inputs: `[<target>] [--session <id>] [--snapshot-save <name>] [--snapshot-load <name>] [--stop] [--force]`
1. Target resolution precedence: match `<target>` against `leaseId` first, then `serial`, then `avd`. If `<target>` is omitted, select all `"active"` leases owned by `sessionId`.
2. Verify ownership and state under `atc.lock`:
   - Require `lease.sessionId === callerSessionId || lease.leaseId === target || flags.force`; otherwise exit with code `3` (`EPERM`).
   - Require `lease.state === "active" || flags.force`. Reject an explicitly targeted transitional lease (`"starting"` or `"stopping"`) without `--force` with exit `2` (`EBUSY`). Report the transition's `workerPid`.
   - This prevents `atc free <target>` from racing a boot or snapshot operation. With `--force`, terminate a live `workerPid` before cleaning up a transitional lease.
3. Determine post-lease actions: let `saveSnap = flags.snapshotSave || lease.saveSnapshotOnFree`.
4. Delete the lease when it is offline (`lease.firstSeenOfflineAtMs !== null` or `lease.serial === null`). Also delete it when `--stop`, `saveSnap`, and `--snapshot-load` are all absent.
   Commit, release `atc.lock`, and exit `0`. Never run `adb` or stop commands against an offline or reused serial.
5. **If the lease is online (`lease.firstSeenOfflineAtMs === null && lease.serial !== null`) and `saveSnap`, `--snapshot-load`, or `--stop` IS set (Race-Free Post-Lease Transition):**
   - If `saveSnap` is set, gather a host disk/AVD footprint snapshot outside `atc.lock` (`fs.statfsSync(avdHomeDir)` + `<avdPath>/config.ini`) and verify **Rule D1 (Disk Check against `projectedFreeDiskMb`)** under `atc.lock` (unless `--force` is set).
   - Under `atc.lock`, transition the lease to `state: "stopping"`, `workerPid: process.pid`, `requiredDiskMb: saveSnap ? C.ramSizeMb : 0`, `deadlineMs: now + stopTimeoutMs`, commit, and release `atc.lock` (preventing any concurrent `atc claim` from claiming the emulator mid-snapshot or mid-shutdown).
   - Outside `atc.lock` (while maintaining the 15s `workerPid` `deadlineMs` heartbeat timer per §5.1 rule 3):
     - If `saveSnap` is set (and `lease.kind === "emulator"`): run `adb -s <lease.serial> emu avd snapshot save <saveSnap>`.
     - If `--snapshot-load <name>` is set (and `--stop` is not set and `lease.kind === "emulator"`): run `adb -s <lease.serial> emu avd snapshot load <name>` so the emulator is left clean and warm for the next waiter.
     - If `--stop` is set (and `lease.kind === "emulator"`): run `android emulator stop <lease.serial || lease.avd>`.
   - Reacquire `atc.lock` and delete the `"stopping"` entry if `leaseId` matches. Release the lease even if the external action failed. Commit and exit `0`, or `1` if a snapshot or stop action failed.

### 5.5 Live Snapshot Management During an Active Lease (`atc snapshot`)
Usage: `atc snapshot <list|save|load|delete> [<name>] [--serial <serial> | --avd <avdId>] [--force]`
- `atc snapshot list`: Lists available snapshots for an online or offline AVD (by reading `<avdPath>/snapshots/` and/or `adb -s <serial> emu avd snapshot list`). Requires no lease.
- `atc snapshot <save|load|delete> <name>`:
  1. Validates `<name>` against `/^[A-Za-z0-9._-]{1,64}$/`.
  2. For `save`, gathers host disk telemetry outside `atc.lock` and checks **Rule D1 (`projectedFreeDiskMb`)** under `atc.lock` unless `--force` is set (exit code `5` if insufficient).
  3. Under `atc.lock`, require the session's online `"active"` virtual lease: `lease.firstSeenOfflineAtMs === null && lease.serial !== null`.
     During offline recovery, exit `1` and require `atc claim` before snapshot changes.
     For `save` or `load`, set `state: "starting"`, `workerPid: process.pid`, `requiredDiskMb: action === "save" ? C.ramSizeMb : 0`, and `deadlineMs: now + bootTimeoutMs`.
     The 15-second worker heartbeat (§5.1 Rule 3) protects the reservation against offline reconciliation (§5.3 Step 2) and concurrent `atc free`.
  4. Outside the lock, run `adb -s <lease.serial> emu avd snapshot <save|load|delete> <name>`. For `load`, wait for `sys.boot_completed == 1`.
     Reacquire the lock and check `leaseId`. Restore `state: "active"`, `requiredDiskMb: 0`, and `expiresAtMs = now + ttlMs`.
     Update `loadedSnapshot` on load, then commit.

### 5.6 Executing Scoped Commands (`atc exec`) with In-Process Heartbeat
Usage: `atc exec [--serial <serial>] [--session <id>] -- <command> [args...]`
1. Under `atc.lock`, require the session's online `"active"` lease: `lease.firstSeenOfflineAtMs === null && lease.serial !== null`.
   Select the only online lease, or require `--serial` when several match. During offline recovery, exit `1`.
   Ask the agent to run `atc claim` for a crashed virtual device or `atc status` for a physical device.
2. Extend `expiresAtMs = Math.max(lease.expiresAtMs, now + defaultTtlMs)` and `renewedAtMs = now`.
3. Release `atc.lock`.
4. **Start In-Process Lease Heartbeat Timer:**
   - Start an `unref()`'d `setInterval` timer with interval `Math.min(60_000, Math.floor(ttlMs / 3))`.
   - Each tick acquires `atc.lock`, checks ownership of `leaseId` by `sessionId`, and requires `firstSeenOfflineAtMs === null`.
   - Set `renewedAtMs = Date.now()` and `expiresAtMs = Date.now() + ttlMs`. These updates keep leases alive during long commands, including a 20-minute `./gradlew connectedAndroidTest` run.
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
| `atc free [target] [options]` | Release lease(s) (`leaseId` > `serial` > `avd`); optional `--snapshot-save`, `--snapshot-load`, `--stop`, `--force` | `0` ok, `2` transition in progress, `3` not owner, `5` disk full on snapshot save, `1` error |
| `atc renew [target] [--ttl <sec>]` | Extend lease expiration time on an online active lease (clamped to `maxTtlSec`) | `0` ok, `3` not owner, `1` error/offline |
| `atc snapshot <list\|save\|load\|delete> [name]` | Inspect or save/load/delete QEMU snapshots on leased emulator | `0` ok, `3` not owner, `5` disk full, `1` error |
| `atc exec <system> <op> [params]` | Run an allowlisted typed operation (3.0; replaces `atc exec -- <cmd>`) under the lease/build slot with a periodic heartbeat | Child exit code, `3` no lease, `7` rejected request |
| `atc status [--type ...] [--api ...] [--json]` | Show 3-tier fleet (`running`, `offline` spin-up candidates, `creatable` profiles), host RAM/disk capacity, active leases, and affinity wait queue | `0` ok |
| `atc config <get\|set> [key] [val]` | View or configure `maxRunningEmulators`, `maxRunningSimulators`, `reorderWindowSec`, `minFreeRamMb`, `minFreeDiskMb`, `offlineGraceMs`, `physicalOfflineGraceMs` | `0` ok, `1` invalid value |
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

`atc guard <cmd>` and `atc hook <pre-tool-use|stop>` classify commands and check leases. Host adapters call these handlers, so each host uses the same parsing rules. `build-brief` uses the same adapter structure:

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
> **Removed in 3.0.** This section is kept for history only. ATC 3.0 hooks never read shell commands; see `docs/scope.md` §7.

> The guard checks shell command strings for missing leases and missing `--device` / `ANDROID_SERIAL` targets. Agents can bypass these checks through deliberate command obfuscation. The guard provides no OS security boundary.

1. **Host input handling without shell interpolation:**
   - The Pi extension (`extensions/atc/index.ts`) handles `tool_call` events where `event.toolName === "bash"`.
   - It calls `pi.exec("atc", ["guard", "--format=json", event.input.command])`. It updates `event.input.command` in place or blocks a device command that lacks a lease.
   - **Stdin JSON Hooks (`atc hook pre-tool-use`):** Reads the JSON hook event from `stdin` (never `argv`), normalizing across agent hosts:
     - **Codex / Cursor / Claude Code:** `{ session_id, tool_name: "Bash" | "Shell", tool_input: { command } }`
     - **Antigravity / Gemini CLI:** `{ conversationId, toolCall: { name: "run_command", args: { CommandLine } } }`
   - If the tool is not a shell/command execution tool, exit `0` immediately.
2. **Fast Path (<2ms, Zero Lock):**
   - If the command string contains no whole-word token matching `/\b(android|adb|emulator|gradlew|gradle|atc)\b/`, exit `0`.
3. **Compound Command Segment Analysis:**
   - Split shell commands at `;`, `&&`, `||`, `|`, `&`, `$()`, and newlines.
   - Remove leading environment assignments (`VAR=val`) and wrappers (`env`, `command`, `nohup`, `timeout`, `build-brief`) before classification.
   - Record `state.hookSessions[process.ppid] = { sessionId, agentPid: process.ppid, cwd: process.cwd(), updatedAtMs: now }` under `atc.lock`.
   - Classify each segment in strict precedence order (most-specific rules first):
     1. Allow `atc ...` commands. When `ATC_SESSION_ID` / `--session` is absent, add `ATC_SESSION_ID=<sessionId> ATC_ANCHOR_PID=<process.ppid>` before the command.
        Emit the rewrite through Pi's `event.input.command`, Antigravity/Gemini CLI's `overwrite`, or Claude Code's `updatedInput`.
        This supplies the session identity even when agents share `cwd`.
     2. **Direct lifecycle bypass (evaluated before generic `android` subcommands)**: `android emulator (start|stop|remove|create)` or `emulator @<avd>` or `adb ... emu kill` -> **Denied** (`Use "atc claim --type <type> --api <api>" or "atc free --stop" instead of starting/stopping emulators directly.`).
     3. **Read-only Android/ADB commands**: `android emulator list`, `android (docs|sdk|info|help|skills|studio|describe|create|init|update)` (where top-level `android create` is project creation, distinct from `android emulator create`), `adb (devices|version|help|start-server)` -> Allowed.
     4. **Device-interacting commands**: `android (run|install|layout|screen)`, `adb ... (shell|install|uninstall|push|pull|logcat|forward|reverse|bugreport)`, `(./gradlew|gradle) ... connected*`, or any unparseable segment containing `android`/`adb`/`emulator` (fail-closed toward requiring a lease):
       - Check active leases in `state.json` for `sessionId`:
       - Require an online `"active"` lease: `lease.firstSeenOfflineAtMs === null && lease.serial !== null`.
       - Deny calls without that lease, including leases in the offline recovery window (`firstSeenOfflineAtMs !== null`).
       - Write the error and next action to `stderr`. For an offline lease, require `atc claim` to recover a virtual device or `atc status` for a physical device.
       - Emit structured deny JSON on `stdout` and exit `2`. Codex, Cursor, Antigravity, Gemini CLI, and Claude Code block execution for this result.
       - If the command specifies `--device=<serial>` or `-s <serial>` (or `ANDROID_SERIAL=<serial>`) that does not belong to `sessionId`'s online active lease(s), deny the tool call.
       - Deny ambiguous commands when the session holds multiple online active leases.
       - Also deny commands when multiple emulators run and the command lacks both `atc exec` and `ANDROID_SERIAL` / `--device` / `-s`.
       - Require `atc exec -- <cmd>` or `ANDROID_SERIAL=<serial>`.
       - Otherwise, **auto-renew** `sessionId`'s online active lease (`expiresAtMs = now + ttlMs`) and allow (`exit 0`).

### 7.2 `Stop` / `SessionEnd` Hook (`atc hook stop`)
`atc hook stop` handles `Stop` / `SessionEnd` events where `fullyIdle !== false`. It reads `session_id` / `conversationId` from `stdin` JSON. It releases the session's `"active"` leases through `atc free --session <sessionId>`. Before releasing a device to queued callers, it runs the configured `saveSnapshotOnFree` action.

---

## 8. Security & Cross-Platform Hardening

### 8.1 Cross-Platform Executable Resolution & `shell: false`
Node.js >= 20.12 throws `EINVAL` when spawning `.bat` or `.cmd` files on Windows with `shell: false` (CVE-2024-27980). To maintain safety across macOS, Linux, and Windows:
1. **Executable Discovery (`resolveExecutable`):**
   - On POSIX, spawn executables directly with `shell: false`.
   - On Windows, resolve the target binary against `PATH` (plus `%LOCALAPPDATA%\Android\Sdk\platform-tools` and `%USERPROFILE%\.local\bin` for `adb`/`android`) checking extensions `.exe`, `.cmd`, `.bat` in order.
2. **Direct `.exe` Execution:** If the resolved file ends in `.exe` (e.g., `adb.exe` or `android.exe`), spawn it directly with `shell: false`.
3. **Safe `.cmd` / `.bat` Execution on Windows:**
   - For internal `.cmd` or `.bat` calls, reject arguments containing `\0`, `\r`, `\n`, or unescaped `%` environment expansion tokens.
   - Batch targets include `android.cmd` and `gradlew.bat` inside `atc exec`.
   - ATC validates internal `android` arguments (`avd`, `serial`, and flags) against `/^[A-Za-z0-9._:-]+$/`. It adds `--` before positional arguments where the command supports it.
   - These checks restrict command injection when ATC uses `[process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", ...]]` with `windowsVerbatimArguments: true`.

### 8.2 State Directory & Symlink Protection
- On POSIX, ATC creates `stateDir` with `0o700`. It uses `fs.lstatSync` to reject symlinks and checks ownership against `process.getuid()`.
- ATC opens temporary files (`state.json.tmp.<pid>.<nonce>`) with `fs.openSync(path, "wx", 0o600)` (`O_CREAT | O_EXCL`). It generates nonces with `crypto.randomBytes(12).toString("hex")`.

---

## 9. Historical ATC 2.0 Plan: Multiplatform iOS & Android

ATC 2.1.0 supports Android and iOS. This section records the 2.0 plan and its original requirements. [The user guide](docs/user-guide.md) describes current behavior.

ATC **1.0** shipped as **Android Traffic Control**. The **2.0** plan added iOS Simulator (`xcrun simctl`) and physical iOS device (`xcrun devicectl`) support through `src/ios.mjs`. It required compatibility with the 1.0 `state.json` schema and CLI. The plan retained the lock boundary (§3.2), session identity ladder (§4.2), bounded-window scheduler (§5.3), and hook architecture (§7).

> ATC 2.0 coordinates device ownership, lifecycle and snapshot preparation, and command targets. The agent handles builds, signing, and execution on the device. The agent also handles Apple code-signing certificates, provisioning profiles, Developer Mode, and locked physical screens.

### 9.1 Resolve platforms and match shared profiles
1. **Implicit vs. Explicit Platform Selection (`--platform <android|ios>`):**
   - Calling `atc claim` without `--platform` resolves the target platform in order:
     1. **Explicit Flag:** `--platform ios` (or shorthand `--ios`) vs. `--platform android` (`--android`).
     2. **Flag Inference:** Passing `--udid <udid>`, `--type iphone|ipad`, or `--os ios-*` infers `platform: "ios"`; passing `--avd <name>`, `--play`, `--no-play`, or `--services` infers `platform: "android"`.
     3. **Workspace Inference (`cwd`):** If `cwd` contains an Xcode workspace/project (`*.xcworkspace`, `*.xcodeproj`, or `Package.swift` with iOS targets) and no Android build files (`build.gradle*`, `settings.gradle*`, `AndroidManifest.xml`), infer `platform: "ios"`.
     4. **Default:** Otherwise default to `platform: "android"` (preserving 100% backward compatibility with 1.0 callers).
2. **Canonical `deviceKey` & Shared Form-Factor Taxonomy:**
   - `avd:<avdId>` identifies an Android Virtual Device (`platform: "android"`, `kind: "emulator"`).
   - `sim:<udid>` identifies an iOS Simulator (`platform: "ios"`, `kind: "emulator"`) by `CoreSimulator` UDID. Multiple OS runtimes can share a display name such as `"iPhone 16 Pro"`.
   - `serial:<serial>` identifies a physical device (`kind: "physical"`). It uses the Android `adb` serial or iOS hardware `UDID`.
   - `--type` uses the shared form factors `phone`, `tablet`, `watch`, `tv`, and `xr`.
   - iPhone maps to `phone`; iPad maps to `tablet`; Apple Watch and Wear OS map to `watch`. Apple TV maps to `tv`; Apple Vision maps to `xr`.
   - The aliases `iphone` and `ipad` select `ios` with `phone` and `tablet`, respectively. The deprecated alias `wear` selects `watch`.
   - **OS / API Version (`--api` / `--os`):** Accepts integer API specs (`36`, `>=34`) for Android `apiLevel` and semver specs (`18.2`, `>=17.5`) for iOS `osVersion`.

### 9.2 Unified Queue, Per-Platform Slot Ceilings & Cross-Platform Resource Accounting
Android emulators and iOS Simulators share `state.queue` and the host RAM and disk budget. Each platform has its own virtual-device slot limit:
- **Separate Virtual Slot Ceilings + Shared Host RAM/Disk Budget (`Rule R1` / `Rule D1`):**
  - Android emulators run a guest kernel in QEMU and allocate `hw.ramSize + 1024 MB`, about `3.0–4.5 GB`. `config.maxRunningEmulators` defaults to `2`.
  - An iOS Simulator runs a macOS process tree (`launchd_sim` and `SpringBoard`) with dynamic memory allocation. Its reservation is `requiredRamMb: config.simOverheadRamMb`, or `1280 MB`.
  - The 2.0 plan adds `config.maxRunningSimulators`, with default `4`. Its `"auto"` limit uses `1.5 GB` RAM and `2` logical CPU cores per simulator, clamped to `[1, 8]`.
  - Each platform enforces `projectedAvailableRamMb` (`Rule R1`) and `projectedFreeDiskMb` (`Rule D1`/`D2`) from §5.2.4.
- **Resource-Scoped Starvation Protection & Cross-Platform Idle Eviction (`Priority 3`):**
  - `isReservedForEarlierTicket(candidateDeviceOrSlot)` applies to shared resources (§5.3 Step 4(3)). Protected ticket `E` blocks later caller `C` only when they compete for a matched device, platform slot, RAM, or reserved eviction device `V`.
  - An unrelated Tier 0 iOS or physical claim can proceed while an Android ticket waits for its platform slot or a busy phone.
  - If the target platform has a free slot (`usedSlots < effectiveMaxSlotLimit`), Priority 3 can evict an idle device from either platform for RAM.
  - Select the longest-idle unleased device `V` and reclaim `V.requiredRamMb`. Check live `availableRamMb` after eviction before booting (Step 5.1).
  - When `usedSlots >= effectiveMaxSlotLimit`, `V` must belong to the target platform. Stopping it frees a target slot and its RAM reservation.

### 9.3 iOS Fleet Discovery, Lifecycle & Protected APFS Copy-on-Write Snapshots (Outside `atc.lock`)
1. **Single-Call JSON Fleet Discovery (~40ms):**
   - ATC calls `xcrun simctl list --json` without a category filter. One subprocess returns `{ devicetypes, runtimes, devices, pairs }`.
   - ATC classifies `Booted` devices as `running` and `Shutdown` devices as `offline`. Available `SimRuntime` and `SimDeviceType` combinations are `creatable` through `xcrun simctl create` (about 150 ms).
   - `xcrun devicectl list devices --json-output <tmp>` lists connected USB/Wi-Fi devices with Xcode 15+ and iOS 17+.
   - ATC stores `hardwareProperties.udid` as `lease.serial`. This hardware UDID works with `xcrun devicectl`, `xcodebuild -destination "id=<udid>"`, and third-party runners. The CoreDevice UUID identifies a separate record.
2. **Headless Boot, Creation, Erase & App Reset:**
   - **Boot:** `xcrun simctl boot <udid>` boots the simulator headlessly in the background in ~2–5s without launching the `Simulator.app` GUI window (`xcrun simctl bootstatus <udid> -b` waits until boot completes).
   - **Stop:** `xcrun simctl shutdown <udid>`.
   - `--create-if-missing` uses the same slot (`usedSimSlots < effectiveMaxSimulators`), starvation (`!isReservedForEarlierTicket`), RAM/disk, and Priority-3 eviction checks as offline boot.
   - Before `simctl create` supplies a UDID, Priority 4 reserves `state.leases["sim:creating:" + ticketId]` as `"starting"` under `atc.lock`.
   - Its pending name is `atc_creating_<ticketId>`. Discovery excludes pending names from unleased candidates.
   - Outside the lock, run `xcrun simctl create "atc_creating_<ticketId>" <deviceTypeId> <runtimeId>` (about 150 ms) to get `<newUdid>`.
   - Before booting, acquire `atc.lock` and atomically move the key from `"sim:creating:" + ticketId` to `"sim:" + newUdid`.
   - Release the lock, run `xcrun simctl rename <newUdid> "<displayName>"`, boot `<newUdid>`, and activate the lease.
   - **Factory Wipe (`--wipe-data`):** `xcrun simctl erase <udid>` (~1s).
   - **App Reset (`--reset-app <bundleId>`):** Runs `xcrun simctl terminate <udid> <bundleId>`, `xcrun simctl privacy <udid> reset all <bundleId>`, and clears the data container returned by `xcrun simctl get_app_container <udid> <bundleId> data` (or `xcrun devicectl device uninstall app --device <udid> <bundleId>` on physical devices).
3. **Race-Free APFS Copy-on-Write (`clonefile`) Snapshots (`atc snapshot`):**
   - iOS Simulators have no QEMU live RAM snapshots. ATC uses APFS copy-on-write (`cp -cR` / `clonefile(2)`) to copy `~/Library/Developer/CoreSimulator/Devices/<UDID>/data` to `<stateDir>/ios-snapshots/<UDID>/<name>/data`.
   - The snapshot stays under `<stateDir>` on the same local APFS volume. It survives `simctl delete` and Xcode cache cleanup. A `meta.json` file records `runtimeId` for `SimRuntime` compatibility checks on restore.
   - Saving and loading shut down the simulator for about 2–4 seconds. An `"active"` lease would let concurrent `atc claim` reconciliation (§5.3 Step 2) or `atc free` release it during the operation. The `"starting"` state prevents that race, as required by §5.5:
     1. Under `atc.lock`, `atc snapshot save|load` verifies ownership and transitions the lease from `"active"` to `state: "starting"`, `workerPid: process.pid`, `deadlineMs: now + bootTimeoutMs` (activating the 15s worker heartbeat per §5.1 Rule 3).
     2. Outside `atc.lock`, runs `xcrun simctl shutdown <udid>`, executes the APFS `cp -cR` clone (completing in ~100–200ms with 0 MB of initial disk overhead), and re-boots via `xcrun simctl boot <udid>` + `bootstatus <udid> -b`.
     3. Under `atc.lock`, verifies `leaseId` and transitions the lease back to `state: "active"` with `expiresAtMs = now + ttlMs` (or on failure/timeout, attempts best-effort reboot to restore online state before exiting `1`).

### 9.4 iOS `atc exec` & `atc guard` (Fast-Path, Explicit Target Validation & `"booted"` Protection)
> **Removed in 3.0.** iOS ops are typed (`ios.*`, `xcode.*`) and always target the leased UDID explicitly; there is no `booted` rewriting or command guard.

Apple's `simctl`, `devicectl`, and `xcodebuild` require explicit UDID arguments. Android tools can use `ANDROID_SERIAL`. When several simulators run, `xcrun simctl ... booted` can select an arbitrary simulator:
1. **`atc exec` Environment & Injection:**
   - Sets `ATC_DEVICE_SERIAL=<lease.serial>`, `ATC_PLATFORM=ios`, and `SIMULATOR_UDID=<lease.serial>`.
   - When executing `xcrun simctl ...`, automatically rewrites any positional `booted` target token to `<lease.serial>`.
2. **`atc guard` & `PreToolUse` Hook Rules for iOS (§7.1 Extension):**
   - **Fast-Path Token Expansion (§7.1.2):** Expands the fast-path regex to `/\b(android|adb|emulator|gradlew|gradle|xcrun|simctl|devicectl|xcodebuild|atc)\b/` so non-mobile commands still exit `0` in `<2ms` while all iOS CLI invocations enter segment classification.
   - **Direct lifecycle bypass denied:** `xcrun simctl (boot|shutdown|erase|delete|clone|create)` -> **Denied** (instructs the agent to use `atc claim` / `atc free --stop` / `atc snapshot`).
   - **Read-only & SDK/runtime setup commands allowed without lease:** `xcrun simctl (list|help|runtime)`, `xcrun devicectl (list|help)`, `xcodebuild (-version|-showsdks|-list|-downloadPlatform|-checkFirstLaunchStatus)` -> **Allowed** (`exit 0`).
   - **Device-interacting iOS commands (explicit-target & missing-target validation):**
     Applies to `xcrun simctl (install|uninstall|launch|terminate|io|openurl|push|pbcopy|pbpaste|privacy|spawn|keychain|addmedia|status_bar|ui|get_app_container) <target> ...`, `xcrun devicectl device (install|uninstall|process|info|copy|reboot) ...`, `xcodebuild (test|build-for-testing|test-without-building) ...`, or any unparseable `simctl`/`devicectl` segment:
     1. Require the session's online `"active"` lease with `platform === "ios"` and `firstSeenOfflineAtMs === null`. Otherwise, deny with exit `2`. For a crashed simulator, require `atc claim` to recover it in place.
     2. Check explicit `<udid>`, `--device <id>`, and `-destination "...id=<id>..."` targets against the session's active iOS leases. Deny a mismatch with exit `2` to prevent access to another session's device.
     3. For one active iOS Simulator lease, rewriting hosts replace a `simctl` `booted` target with `<lease.serial>`.
        Other hosts deny the command when several simulators run or `<lease.serial>` is not the only booted simulator.
     4. Deny `devicectl device ...` without `--device <id>`. Require `--device <lease.serial>`.
        Deny `xcodebuild (test|test-without-building|build-for-testing)` without `-destination` or with any destination lacking a session-owned `id=<lease.serial>`.
        A name-only destination such as `name=iPhone 16` fails this check. Require `-destination "platform=iOS Simulator,id=<lease.serial>"`.
     5. Otherwise, auto-renew `sessionId`'s active iOS lease (`expiresAtMs = now + ttlMs`) and allow (`exit 0`).

### 9.5 Report setup errors for the requested platform and device kind
ATC never runs `sudo` or downloads SDK packages automatically. Xcode and Android SDK setup errors can prevent discovery after an OS or IDE update.

ATC must distinguish failed discovery from an empty device list. Otherwise, `atc claim` could wait 300 seconds for a device that cannot appear. ATC follows three rules:

1. **Zero-`sudo` `DEVELOPER_DIR` Auto-Fallback (macOS / Xcode):**
   - `xcode-select -p` can point to `/Library/Developer/CommandLineTools` even when `Xcode.app` is installed. That directory lacks `simctl` and `devicectl`.
   - If `xcrun simctl` fails with `unable to find utility "simctl"` and `/Applications/Xcode.app/Contents/Developer` exists on disk, ATC retries automatically. It sets `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` in the child `xcrun` environment. The retry uses that Xcode installation without changing the system setting or requiring `sudo xcode-select -s`.
2. **Platform- & Kind-Scoped Fail-Fast Classification (Never Queue on Broken Tooling, Never Block Unrelated Claims):**
   - Pre-flight errors are strictly scoped to the **requested `platform` and `requestedKind`**:
     - An Xcode/iOS setup failure must leave Android claims available. An Android setup failure must leave iOS claims available. `atc status` reports unrequested-platform errors as non-fatal `diagnostics` warnings.
     - A missing runtime fails only claims that require a simulator: `platform === "ios"` and `requestedKind !== "physical"`, without a physical match for `--kind any`.
     - A valid physical iPhone claim (`--kind physical` or `--serial <udid>` through `devicectl`) must remain available when a simulator runtime is missing.
   - When the requested platform/kind itself is blocked by a toolchain setup error, `atc claim` **aborts immediately with exit code `1`** (never entering `state.queue`) with an actionable remediation message:
     | Scope | Condition Detected (`stderr` / exit code) | ATC Action & Remediation Output |
     | :--- | :--- | :--- |
     | **iOS (`sim` & `physical`)** | `xcrun` exits with code `69` (`Agreeing to the Xcode/iOS license requires admin privileges`) | Fail fast: *"Xcode license not accepted. Ask the user to run `sudo xcodebuild -license accept`."* |
     | **iOS (`sim` & `physical`)** | `xcrun` / `simctl` reports missing first-launch components (`xcodebuild -runFirstLaunch`) | Fail fast: *"Xcode components need initialization. Ask the user to run `sudo xcodebuild -runFirstLaunch`."* |
     | **iOS (`sim` only)** | `simctl list --json` has 0 available `runtimes` matching the requested `--type` (`phone`/`tablet` -> `iOS`, `watch` -> `watchOS`, `tv` -> `tvOS`, `xr` -> `visionOS`) | Fail fast / report in `creatable.requiresSdkInstall`: *"No `<iOS\|watchOS\|tvOS\|visionOS>` Simulator runtime installed. Run `xcodebuild -downloadPlatform <iOS\|watchOS\|tvOS\|visionOS>`."* |
     | **Android (`emu` & `physical`)** | `android` / `adb` missing from `PATH` and standard SDK locations (`ANDROID_HOME`) | Fail fast: *"Android CLI / platform-tools not found. Install the `android` CLI or set `ANDROID_HOME`."* |
     | **Android (`emu` only)** | Requested profile has no local AVD and system image is not installed | Fail fast / report in `creatable.requiresSdkInstall`: *"Run `android sdk install \"system-images/...\"` (or `yes | sdkmanager --licenses` if prompted for SDK licenses)."* |
     | **Android (Linux `emu`)** | `/dev/kvm` missing or `EACCES` when attempting to boot an x86_64 emulator | Fail fast: *"Linux KVM acceleration unavailable (`/dev/kvm` permission denied). Add user to the `kvm` group."* |
3. **Allowlisting SDK / Setup Commands in `atc guard` (§7.1 & §9.4):**
   - The guard allows SDK setup and inspection without a device lease. This includes `android sdk ...`, `sdkmanager ...`, and `xcodebuild (-version|-showsdks|-list|-downloadPlatform|-checkFirstLaunchStatus)`.
   - It also allows `xcrun simctl (list|help|runtime)` and `xcrun devicectl (list|help)`. Agents can use these commands to inspect tools or install user-space packages and runtimes.
