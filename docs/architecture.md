# atc architecture

The `atc` CLI uses a shared state file to coordinate device discovery, leases, queued requests, and agent hooks.

Status: `v2.1.0` · Updated `2026-10-12` · Node.js >= 20 on macOS, Linux, and Windows.

## Executive summary

An agent claims an Android emulator (AVD), an iOS Simulator, or a physical USB/Wi-Fi device. It runs commands through `atc exec -- <cmd>` and releases the lease after use. `atc` coordinates access through a user-private `state.json` file protected by an atomic directory lock (`atc.lock`). It has no background daemon or npm dependencies.

`atc guide` supplies the CLI documentation. `atc guard` and `atc hook pre-tool-use` check lease ownership before agent commands run. `atc hook stop` handles turn-end cleanup; later commands reclaim leases whose agent process has died. The optional Model Context Protocol (MCP) server (`atc mcp`) exposes operations over stdio JSON-RPC 2.0.

| Invariant | Guarantee | Where enforced |
|---|---|---|
| Zero subprocesses under `atc.lock` | Fleet discovery runs before acquiring `atc.lock`; boot, wipe, snapshot, and stop run after releasing `atc.lock` under `"starting"` or `"stopping"` states. Lock hold time stays under `20 ms`. | `src/cli.mjs`, `src/lock.mjs` |
| Physical claims require a request | Default claims set `--kind emulator`. Physical Android and iOS devices require `--serial`, `--udid`, or `--kind physical\|any` and use `0` virtual slots. | `src/cli.mjs`, `src/state.mjs` |
| Queue protection starts after 120 seconds | Warm `Tier 0` matches can precede cold-boot tickets within `reorderWindowSec` (`120 s`). After that window, `atc` reserves competing resources for earlier tickets. Unrelated claims can proceed. | `src/state.mjs` (`canJumpAhead`) |
| Virtual crash recovery vs. physical fail-fast | Crashed virtual devices hold a `45 s` reservation for in-place reboot (`expiresAtMs` preserved). Disconnected physical devices fail fast after `15 s` with a tombstone. | `src/state.mjs` (`reconcileOfflineLeases`), `src/cli.mjs` |

## Every critical section under `atc.lock` finishes in under 20 ms

`cmdClaim`, `cmdFree`, `cmdSnapshot`, and `cmdExec` split every operation into lock-free subprocess probes and `<20 ms` in-memory state transactions.

```text
~ cmdClaim(stateDir, flags, options)                  @ src/cli.mjs:1395
  + resolveTargetPlatform(flags, cwd)                 @ src/ios.mjs:62
  + discoverTargetFleet({ targetPlatform, ... })      @ src/cli.mjs:276
    ~ discoverFleetAndHost(runner, avdHome, ...)      @ src/android.mjs:785
    + discoverIosFleetAndHost(runner, cfg, ...)       @ src/ios.mjs:531
  ~ withStateTransaction(stateDir, fn)                @ src/state.mjs:908
    ~ runGarbageCollection(state, stateDir, now)      @ src/state.mjs:770
    ~ reconcileOfflineLeases(state, inventory, ...)   @ src/state.mjs:1161
    ~ matchesProfile(candidate, req)                  @ src/state.mjs:1423
  + bootIosSimulator(udid, runner, timeoutMs)         @ src/ios.mjs:643
  + loadIosSimulatorSnapshot(udid, name, runner)      @ src/ios.mjs:746
```

1. `resolveTargetPlatform()` (`src/ios.mjs:62`) selects `"android"` or `"ios"` from flags (`--ios`, `--android`, `--udid`, `--os`) or project markers (`.xcodeproj`, `.xcworkspace`, `Package.swift`).
   `resolveSessionIdentity()` (`src/state.mjs:2079`) resolves `{ sessionId, anchorPid }` through six ordered sources.
2. `discoverTargetFleet()` (`src/cli.mjs:276`) runs `android emulator list --long`, `adb devices -l`, `xcrun simctl list --json`, and `xcrun devicectl list devices --json-output` outside `atc.lock`.
   It reads `.avd/config.ini`, snapshots, and host RAM and disk capacity.
3. Under `atc.lock`, `runGarbageCollection()` removes expired leases and leases whose owner processes have died.
   `reconcileOfflineLeases()` reserves offline virtual devices for recovery (`45 s`) and records physical disconnects in `disconnectedPhysicalLeases` (`15 s` grace).
   `cmdClaim` checks Tier 0 for an existing session lease, recovery, or a running idle match.
   It then checks Tier 1 for offline boot, Tier 2 for idle eviction, and Tier 3 for `--create-if-missing`.
4. Outside the lock, `atc` boots devices, loads QEMU or APFS (`cp -cR`) snapshots, or clears app state.
   `startWorkerHeartbeat()` extends `lease.deadlineMs` every 15 seconds during the operation.
5. Under the lock, `cmdClaim` activates the `"starting"` lease with its `serial` / `udid` and `expiresAtMs`.
   On failure, it deletes the starting record and releases the slot.

## `atc exec` and `atc guard` route Android, iOS, and dual-lease KMP commands

Kotlin Multiplatform (KMP) sessions can hold one Android lease and one iOS lease. `cmdExec` (`src/cli.mjs:4973`) and `evaluateCommandGuard` (`src/guard.mjs:1309`) select a platform lease for each command segment.

| Command family | Target platform | Environment & argument injection in `buildChildInvocation` (`src/spawn.mjs:96`) |
|---|---|---|
| `adb ...` | `android` | Sets `ANDROID_SERIAL=<serial>`; injects `-s <serial>` after global `adb` flags when omitted. |
| `android run\|install\|layout\|screen ...` | `android` | Sets `ANDROID_SERIAL=<serial>`; injects `--device=<serial>` when omitted. |
| `./gradlew connected*` | `android` | Sets `ANDROID_SERIAL=<serial>`, `ATC_LEASE_ID`, `ATC_SESSION_ID`, `ATC_AVD`. |
| `xcrun simctl ...` | `ios` | Sets `ATC_IOS_UDID=<udid>`, `SIMCTL_CHILD_ATC_LEASE_ID=<leaseId>`; rewrites `booted` to `<udid>`. |
| `xcrun devicectl device\|manage ...` | `ios` | Sets `ATC_IOS_UDID=<udid>`; injects `--device <udid>` when omitted and validates `--device` against `serial` and `coreDeviceId`. |
| `xcodebuild test ...` | `ios` | Sets `ATC_IOS_UDID=<udid>` and validates `-destination id=<udid>,name=<name>`. |
| Generic (`sh -c ...`) in KMP session | `android` + `ios` | Exports both `ANDROID_SERIAL` and `ATC_IOS_UDID` into the child environment. |

`evaluateCommandGuard()` checks commands for `adb`, `emulator`, `android`, `gradlew`, `simctl`, `devicectl`, and `xcodebuild`. Commands without these tools pass in under `2 ms` without a `state.json` read. The guard blocks direct lifecycle commands (`emulator -avd`, `adb emu kill`, `xcrun simctl boot|shutdown|erase|delete`) with exit code `2`. It rewrites compound commands (`adb ... && xcrun simctl ...`) segment by segment using `execSerialByPlatform`.

## Code map and on-disk state

| Module | Path | Responsibility |
|---|---|---|
| CLI entrypoint | `bin/atc.mjs`, `src/cli.mjs` | Flag parsing and command handlers (`guide`, `claim`, `free`, `renew`, `snapshot`, `exec`, `status`, `config`, `gc`, `guard`, `hook`, `mcp`). |
| Built-in guides | `src/guide.mjs`, `src/guides/*.md` | Markdown topics (`workflow`, `profiles`, `snapshots`, `multi-agent`, `traps`) served by `atc guide` and `atc_guide`. |
| Atomic lock | `src/lock.mjs` | Directory mutex (`mkdir <stateDir>/atc.lock`), `owner.json` nonce check, stale-lock breaking, and atomic `state.json` write + `fsync` + `rename`. |
| State & scheduler | `src/state.mjs` | Schema validation, corruption quarantine, dead-PID GC, 6-step session identity ladder, `watch`/`wear` profile matching, and warm-affinity queue selection. |
| Android probes | `src/android.mjs` | Android 3-tier discovery, `.avd/config.ini` + dead-PID `.lock` cleanup, RAM/disk admission, and QEMU boot/stop/snapshot helpers. |
| iOS probes | `src/ios.mjs` | iOS/watchOS/tvOS/visionOS discovery (`simctl` + `devicectl`), simulator boot/shutdown/erase/create, privacy/container app reset, and APFS `cp -cR` snapshots. |
| Worker liveness | `src/heartbeat.mjs` | Cross-platform process-group tracking (`workerPgids`, POSIX start tokens, Windows CIM `CreationDate` trees) and orphan process-tree reaping. |
| Spawner | `src/spawn.mjs` | Subprocess runner, Windows `.exe`/`.cmd` resolution, and Android/iOS target flag injection. |
| Command guard | `src/guard.mjs` | Shell tokenizer, per-platform command classifier, and loop/compound command rewriter. |
| Host hooks & MCP | `src/hook.mjs`, `src/mcp.mjs` | `PreToolUse` and `Stop` adapters for Claude Code, Codex, Cursor, Antigravity, and Gemini CLI, plus the stdio JSON-RPC 2.0 MCP server. |

| On-disk path | Written by | Contents |
|---|---|---|
| `<stateDir>/state.json` | `src/lock.mjs` | Active/transitional leases, wait queue tickets, `disconnectedPhysicalLeases` tombstones, config overrides, and hook PID breadcrumbs (`mode 0600`). |
| `<stateDir>/atc.lock/owner.json` | `src/lock.mjs` | Lock holder `{ pid, createdAtMs, nonce }` checked before every atomic rename. |
| `~/.android/avd/<Name>.avd/snapshots/<snap>/` | QEMU / `adb` | QEMU snapshots discovered by `src/android.mjs` and restored via `atc snapshot`. |
| `~/.atc-snapshots/<udid>/<snap>/data/` | `src/ios.mjs` | APFS copy-on-write (`cp -cR`) clones of `~/Library/Developer/CoreSimulator/Devices/<udid>/data`. |

## Verification commands

| Command | Coverage |
|---|---|
| `npm test` (`node --test test/*.test.mjs`) | Tests cover lock serialization, corrupt-state handling, dead-PID GC, `45 s` virtual recovery, and `15 s` physical disconnect handling. They also cover scheduling, RAM/disk checks, guards, hooks, command targets, APFS snapshots, KMP leases, guides, and MCP. |
| `npm run check` | Syntax check (`node --check`) across all `.mjs` files plus the full integration test suite. |
| `npm run release:verify` | Version parity check across `package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `skills/atc/SKILL.md`, and `skills/atc/skill-source.json`. |
