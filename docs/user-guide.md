# `atc` user guide

`atc` gives coding agents exclusive Android and iOS device leases without a background daemon.

Status: `v2.1.0` · Updated `2026-10-12` · Node.js >= 20 on macOS, Linux, and Windows.

## Executive summary

Agents sharing a machine can change the same emulator, iOS Simulator, or USB phone. One agent can install an APK or stop a simulator while another agent inspects its screen. Unscoped `adb` and `xcrun simctl` commands can target the wrong device. An agent crash can leave its lease active.

Agent Traffic Control (`atc`) coordinates access through a user-private `state.json` file and an atomic directory lock (`atc.lock`). Agents claim devices by hardware and operating system (OS) profile. They run commands through `atc exec`, which renews leases every 15 seconds. Agents can restore QEMU or APFS snapshots and release leases after use.

Agents must cooperate with `atc` to keep device access exclusive. Any local process can bypass it and connect to `adb` (`localhost:5037`) or `CoreSimulatorService`. The host plugin checks and rewrites agent shell commands before execution. These checks do not create an OS security boundary.

| Topic | Section |
|---|---|
| Setup & fleet check | [Install the CLI and list devices](#install-the-cli-and-list-devices) |
| Single-agent flow | [One agent claims by profile and runs with a 15-second heartbeat](#one-agent-claims-by-profile-and-runs-with-a-15-second-heartbeat) |
| Multi-agent contention | [The queue protects earlier requests after 120 seconds](#the-queue-protects-earlier-requests-after-120-seconds) |
| Kotlin Multiplatform (KMP) | [One KMP session holds an Android lease and an iOS lease at once](#one-kmp-session-holds-an-android-lease-and-an-ios-lease-at-once) |
| Crashes & disconnects | [Crashed virtual devices reboot in place; unplugged phones fail in 15 seconds](#crashed-virtual-devices-reboot-in-place-unplugged-phones-fail-in-15-seconds) |
| Snapshots & clean resets | [Snapshots restore saved device state](#snapshots-restore-saved-device-state) |
| Coordination Q&A | [Questions on how coordination works](#questions-on-how-coordination-works) |
| CLI & exit codes | [Commands and exit codes](#commands-and-exit-codes) |

## Install the CLI and list devices

Install `@rock3r/atc` globally with npm. Then run `atc status` to check host memory, disk space, and devices. On macOS, `atc status` probes Android (`adb`, `~/.android/avd`) and iOS (`simctl`, `devicectl`) outside `atc.lock`.

```bash
npm install -g @rock3r/atc
atc status
```

```text
Host Capacity: 16735 MB RAM avail · 29989 MB disk free
  emu slots: 0/2 · sim slots: 0/4
  Running (2): adb-2A191FDH3007B7, 00008120-000464CE2E44C01E
  Offline (40): Opus_API37, Pixel_9, Wear_OS_Small_Round,
                iPhone 16 Pro, Apple Watch Series 10 (46mm)
  Leases  (0): none
  Queue   (0): none
```

Install the optional agent plugin so your coding agent loads the `atc` skill and runs `PreToolUse` / `Stop` guardrail hooks automatically.

| Agent host | Install command or path |
|---|---|
| Claude Code | `/plugin marketplace add rock3r/atc` then `/plugin install atc@atc` |
| Codex | `codex plugin marketplace add rock3r/atc && codex plugin add atc@atc` |
| GitHub Copilot CLI / app | `copilot plugin marketplace add rock3r/atc && copilot plugin install atc@atc` |
| Antigravity | Symlink or copy package root to `~/.gemini/config/plugins/atc` (`plugin.json`, `skills/atc`, `hooks.json`, `mcp_config.json`) |
| Gemini CLI | Copy `skills/atc` to `~/.gemini/skills/atc` and wire `atc hook pre-tool-use` + `atc hook stop` |
| Cursor | Copy `.cursor/hooks.json` into `.cursor/hooks.json` (and optional `.mcp.json`) |
| Pi | Load `extensions/atc/index.ts` |

## One agent claims by profile and runs with a 15-second heartbeat

An agent can claim a virtual device by form factor and OS version. It can also select an Android Virtual Device (AVD) name or device identifier (UDID). `atc exec` adds the leased target to child commands and renews the lease every 15 seconds while they run.

```mermaid
sequenceDiagram
    autonumber
    participant Agent as Coding Agent
    participant ATC as atc (atc.lock < 20ms)
    participant Dev as Emulator / Simulator

    Agent->>ATC: atc claim --type phone --api ">=35" --play
    alt Warm idle device matches (Tier 0)
        ATC-->>Agent: Lease active in < 20 ms
    else Offline device in ~/.android/avd or CoreSimulator (Tier 1)
        ATC->>ATC: Check RAM/disk & write "starting" reservation
        ATC->>Dev: Boot outside lock & wait for readiness
        ATC-->>Agent: Lease active (serial / UDID assigned)
    end

    Agent->>ATC: atc exec -- ./gradlew connectedDebugAndroidTest
    ATC->>Dev: Set ANDROID_SERIAL + --device=<serial>
    loop Every 15 seconds while worker process group is alive
        ATC->>ATC: Heartbeat extends lease expiresAtMs
    end
    Dev-->>Agent: Exit code 0

    Agent->>ATC: atc free
    ATC-->>Agent: Lease freed (device stays warm for next agent)
```

`atc` releases `atc.lock` before booting an emulator or running a test. The `"starting"` or `"active"` lease reserves the device during that work.

```bash
# Android emulator loop
atc claim --type phone --api ">=35" --play --wait 300
atc exec -- adb shell getprop ro.product.model
atc exec -- android layout --pretty
atc exec -- ./gradlew connectedDebugAndroidTest
atc free

# iOS Simulator loop (macOS)
atc claim --ios --type phone --os ">=18.0" --wait 300
atc exec -- xcrun simctl launch booted com.example.app
atc free
```

## The queue protects earlier requests after 120 seconds

When device slots are busy, `atc claim --wait 300` adds the caller to `state.queue`. It updates the ticket heartbeat once per second. Strict first-in, first-out (FIFO) order can cause repeated cold boots when agents alternate device profiles.

`atc` can reorder requests during a 120-second window (`reorderWindowSec = 120`). A ticket matching a running idle device (`Tier 0`) can precede an earlier cold-boot ticket that has waited less than 120 seconds. After 120 seconds, `atc` reserves competing resources for the earlier ticket. Later tickets can still use unrelated resources.

```mermaid
flowchart LR
    subgraph Host["Host Slot (1/1 Used)"]
        P9["Pixel_9 (API 36)\nWarm Emulator"]
    end

    subgraph Queue["Wait Queue (reorderWindowSec = 120s)"]
        T1["Ticket #1: Agent B\nNeeds cold Wear_OS (waited 10s)"]
        T2["Ticket #2: Agent C\nMatches warm Pixel_9"]
    end

    P9 -- "1. Agent A runs atc free" --> Check{"Has Ticket #1\nwaited >= 120s?"}
    Check -- "No (< 120s)" --> T2
    T2 -- "Reuses warm Pixel_9 in < 20ms" --> P9
    Check -- "Yes (Priority #0 freeze)" --> T1
    T1 -- "Stops Pixel_9 & boots Wear_OS" --> Host
```

| Time | Event | Queue decision |
|---|---|---|
| `t = 0s` | Agent A holds warm `Pixel_9` (`API 36`). Agent B requests offline `Wear_OS` (`--type watch`). | Agent B enters queue as Ticket #1 (`starvationDeadline = 120s`). |
| `t = 10s` | Agent C requests `--type phone --api ">=35"`. Agent A frees `Pixel_9`. | Ticket #1 has waited 10 s (`< 120s`). Agent C jumps ahead and claims warm `Pixel_9` in `< 20 ms`. |
| `t = 125s` | Agent C frees `Pixel_9`. Agent D requests `--type phone --api 36`. | Ticket #1 is past 120 s (frozen at Priority #0). `atc` blocks Agent D, stops `Pixel_9`, and boots `Wear_OS` for Agent B. |

## One KMP session holds an Android lease and an iOS lease at once

Kotlin Multiplatform (KMP), Flutter, and React Native tasks can test Android and iOS in one macOS agent session. Each session can hold one Android lease and one iOS lease at the same time.

With one lease per platform, `atc exec` and `atc hook pre-tool-use` select the lease that matches each command. These commands do not require `--serial` or `--android`/`--ios` on `atc exec`.

```mermaid
flowchart TD
    Sess["KMP Session (1 Android Lease + 1 iOS Lease)"] --> Exec["atc exec / PreToolUse Hook"]
    Exec -- "adb / android / ./gradlew" --> And["Android Lease\nANDROID_SERIAL=emulator-5554\n--device=emulator-5554"]
    Exec -- "xcrun simctl / devicectl / xcodebuild" --> Ios["iOS Lease\nATC_IOS_UDID=D9746857-...\nbooted -> UDID / --device UDID"]
    Exec -- "sh -c / multiplatform script" --> Both["Exports BOTH\nANDROID_SERIAL + ATC_IOS_UDID"]
```

```bash
# Claim 1 Android device and 1 iOS Simulator in the same session
atc claim --android --type phone --api ">=35"
atc claim --ios --type phone --os ">=18.0"

# Platform tools auto-select their matching lease
atc exec -- adb shell getprop ro.product.model
atc exec -- xcrun simctl launch booted org.example.kmpApp

# Scope renew, snapshot, and free with --android or --ios
atc snapshot save kmp_ready --ios
atc renew --android --ttl 600
atc free --android
atc free --ios --stop
```

## Crashed virtual devices reboot in place; unplugged phones fail in 15 seconds

`atc` can reboot a virtual device after QEMU or `Simulator.app` crashes. A person must reconnect an unplugged USB phone.

When a leased virtual device disappears from `adb` or `simctl`, `atc` reserves it for up to 45 seconds. The owner can reclaim and reboot it while keeping `expiresAtMs`. A physical disconnect has a 15-second grace period. After that period, `atc` records the disconnect; an owner re-claim fails immediately (`exit 1`). An owner re-claim also fails during the grace period.

```mermaid
flowchart TD
    Drop["Leased Device Drops from adb / simctl / devicectl"] --> Kind{"Device kind?"}
    Kind -- "Virtual (AVD / Simulator)" --> VGrace["Hold 45s Offline Reservation\n(clear serial, block exec/renew/snapshot)"]
    VGrace -- "Owner re-claims within 45s" --> VBoot["Reboot in place outside lock\nKeep original leaseId & expiresAtMs"]
    VGrace -- "45s expires" --> VFree["Release reservation & reopen slot"]

    Kind -- "Physical (Android USB/Wi-Fi or iPhone)" --> PGrace["Hold 15s Cable-Glitch Window"]
    PGrace -- "Owner re-claims or > 15s elapsed" --> PTomb["Fail fast (Exit Code 1)\nRecord disconnectedPhysicalLeases tombstone"]
```

| Failure mode | Grace window | What `atc exec` / `atc guard` does | What `atc claim` does |
|---|---|---|---|
| Emulator or iOS Simulator crash | `45 s` | Blocks immediately (`exit 2`/`3`) with a message to run `atc claim`. | Reboots the crashed virtual device in place and preserves `expiresAtMs`. |
| Physical Android or iPhone unplugged | `15 s` | Blocks immediately (`exit 2`/`3`) once offline is detected. | Fails fast (`exit 1`) telling the agent to ask the user to reconnect the cable. |

## Snapshots restore saved device state

Tests can change login tokens, permissions, and database rows. Android emulators use QEMU snapshots to save state. iOS Simulators use APFS copy-on-write `cp -cR` clones in `~/.atc-snapshots/<udid>/<name>`.

| Operation | Command | Android emulator action | iOS Simulator action |
|---|---|---|---|
| Save checkpoint | `atc snapshot save <name>` | `adb emu avd snapshot save <name>` | Shuts down simulator, runs `cp -cR` on `data/`, and reboots |
| Restore checkpoint | `atc snapshot load <name>` | `adb emu avd snapshot load <name>` + boot check | Shuts down simulator, swaps APFS `data/` clone, and boots |
| Clear one app | `atc claim ... --reset-app <id>` | `adb shell pm clear <pkg>` | Stops `<bundleId>`, resets privacy permissions, and wipes app container |
| Factory wipe | `atc claim ... --wipe-data` | Deletes `userdata-qemu.img*` and cold-boots | Runs `xcrun simctl erase <udid>` and boots clean |

```bash
# Restore a known snapshot on claim and clear app storage before starting
atc claim --type phone --api 36 --snapshot-load default_boot --reset-app com.example.app

# Save a checkpoint mid-session, run destructive steps, then rewind
atc snapshot save logged_in
atc exec -- ./gradlew connectedDebugAndroidTest
atc snapshot load logged_in
```

## Questions on how coordination works

### Can `atc` stop a rogue agent from talking to `adb` or `simctl` directly?

`atc` requires agents to follow its lease protocol ([context thread](https://bsky.app/profile/sebastiano.dev/post/3mxm4nh77yc2f)).

`adb` (port `5037`) and `CoreSimulatorService` accept commands from processes in the same user account. `atc` cannot prevent those processes from calling the tools directly.

`atc guide` defines the protocol. The host plugin checks shell commands with `atc hook pre-tool-use` / `atc guard`:

| Command type | Example | `atc guard` / `PreToolUse` action |
|---|---|---|
| Raw lifecycle mutation | `emulator -avd`, `adb emu kill`, `xcrun simctl boot\|shutdown\|erase` | Blocked (`exit 2`); instructs agent to use `atc claim` / `atc free`. |
| Unleased or cross-session command | `adb shell`, `xcrun simctl launch`, `xcodebuild test` without matching lease | Blocked (`exit 2`). |
| Leased command in Claude Code, Gemini CLI, Antigravity, or Pi | `adb install app.apk` | Rewritten to `ATC_SESSION_ID=<id> atc exec --serial <id> -- ...`. |

### Can an agent recover access after another agent exits without releasing the device?

`atc` can reclaim the lease. The next agent can reset device state separately.

`atc` handles leases that an agent leaves active:

| Exit scenario | How `atc` reclaims the lease |
|---|---|
| Normal turn end (`Stop` / `SessionEnd` hook) | `atc hook stop` frees the session's leases immediately (or sets `releaseOnWorkerExit` if a worker is still finishing). |
| Agent crash or closed terminal (`SIGKILL`) | The next `atc` command checks `kill(anchorPid, 0)` and `workerPgids` and reaps the dead-PID lease in `< 20 ms`. |
| Idle hang with no active `atc exec` worker | The lease expires when its TTL (`defaultTtlSec = 600`) runs out. |

Releasing a lease leaves device state unchanged unless the agent requests cleanup. An agent can leave a dialog open or change app storage. On emulators and iOS Simulators, use `--snapshot-load <name>`, `--reset-app <id>`, or `--wipe-data` to discard changes. Physical phones support only app-level resets (`--reset-app <pkg>`).

```mermaid
flowchart LR
    Crash["Agent A exits without calling atc free"] --> Hook{"Did Stop hook run?"}
    Hook -- "Yes" --> Free["Lease freed at turn end"]
    Hook -- "No (SIGKILL / crash)" --> Next["Agent B runs atc claim"]
    Next --> Probe["atc checks kill(anchorPid, 0)\nand workerPgids under atc.lock"]
    Probe -- "PID dead or TTL expired" --> Reclaim["Orphan lease reaped in < 20ms"]
    Reclaim --> Clean["Agent B passes --snapshot-load or --reset-app\nto discard Agent A's device state"]
```

### Why does `atc` run without a background daemon?

A background daemon can retain an older package version or stale `ANDROID_HOME` and `DEVELOPER_DIR` values. Every caller would depend on that process remaining available.

`atc` stores all state in `<stateDir>/state.json` protected by an atomic `mkdir <stateDir>/atc.lock` mutex (`< 20 ms` hold time):

| Phase | Runs under `atc.lock`? | What happens |
|---|---|---|
| 1. Fleet discovery | No (before lock) | Probes `adb`, `android`, `simctl`, `devicectl`, and host RAM/disk. |
| 2. Candidate selection & GC | Yes (`< 20 ms`) | Reaps dead-PID leases, checks `atc.lock/owner.json`, and writes `"starting"` or `"active"` state. |
| 3. Boot, snapshot, or wipe | No (after lock) | Runs external tools while a 15-second worker heartbeat extends `lease.deadlineMs`. |

### Can an agent install a test build onto my charging personal phone?

`atc claim` defaults to `--kind emulator` and excludes physical USB and Wi-Fi devices on Android and iOS. Physical claims require an explicit request. `atc guard` also blocks unscoped `adb install` and `./gradlew connectedCheck` commands when a physical device is attached. Processes that bypass `atc` can still access that phone.

To target a physical phone on purpose, pass its identifier or `--kind physical`:

```bash
# Physical Android phone
atc claim --serial adb-2A191FDH3007B7-SAhkP3._adb-tls-connect._tcp

# Physical iPhone (via Xcode CoreDevice / devicectl)
atc claim --ios --kind physical --udid 00008120-000464CE2E44C01E

# Optional: forbid all physical device claims on this machine
atc config set allowPhysicalDevices never
```

### How do Android emulator slots and iOS Simulator slots share a Mac?

Android emulators boot QEMU virtual machines with dedicated guest RAM. iOS Simulators run user-space processes that share the macOS kernel. `atc` tracks the platforms in separate slot pools:

| Pool | Config key & default | Admission check before boot |
|---|---|---|
| Android QEMU emulators | `maxRunningEmulators = 2` | Available host RAM must cover `ramSizeMb + 1024 MB overhead + minFreeRamMb (2048 MB)`, plus `2048 MB` free disk. |
| iOS Simulators (macOS) | `maxRunningSimulators = 4` | Target volume must have at least `minFreeDiskMb (2048 MB)` free disk space. |
| Physical devices | Unlimited (`0` virtual slots) | Must be online in `adb devices` or `xcrun devicectl list devices`. |

## Commands and exit codes

Run `atc guide [workflow|profiles|snapshots|multi-agent|traps]` at any time to read the built-in CLI guides.

| Command | What it does |
|---|---|
| `atc status [--ios\|--android] [--type <t>] [--api\|--os <spec>] [--json]` | Show host RAM/disk, `emu slots`, `sim slots`, `running`/`offline`/`creatable` devices, `leases`, and `queue`. |
| `atc claim [--ios\|--android] [--type <t>] [--api\|--os <spec>] [flags]` | Claim a lease (`--play`, `--no-play`, `--avd`, `--udid`, `--serial`, `--kind`, `--snapshot-load`, `--wipe-data`, `--cold`, `--reset-app`, `--create-if-missing`, `--ttl`, `--wait`). |
| `atc exec [--ios\|--android] [--serial <id>] -- <cmd> [args...]` | Run a command with target env/flags injected, worker process-group tracking, and a 15 s heartbeat. |
| `atc snapshot <list\|save\|load\|delete> [<name>] [--ios\|--android]` | Manage QEMU snapshots (Android) or APFS copy-on-write clones (iOS Simulator). |
| `atc renew [<target>] [--ios\|--android] [--ttl <sec>] [--json]` | Extend an active lease's TTL. |
| `atc free [<target>] [--ios\|--android] [--snapshot-save <n>] [--stop]` | Release one or all leases held by the caller session. |
| `atc guide [workflow\|profiles\|snapshots\|multi-agent\|traps] [--json]` | Print built-in documentation topics. |
| `atc config <get\|set> [key] [val]` | Read or update config (`maxRunningEmulators`, `maxRunningSimulators`, `minFreeRamMb`, `allowPhysicalDevices`). |
| `atc gc` | Prune expired leases, dead anchor/worker PIDs, and stale queue tickets. |
| `atc guard [--format=json] <command>` | Check whether a shell command is allowed, blocked, or rewritten under `atc`. |
| `atc hook <pre-tool-use\|stop>` | Host hook entrypoint for Claude Code, Codex, Gemini CLI, Antigravity, and Cursor. |
| `atc mcp` | Start the stdio MCP server (`atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, `atc_guide`). |

| Exit code | Name | Meaning and next action |
|---|---|---|
| `0` | `OK` | Command succeeded. |
| `1` | `EUSAGE / EINTERNAL` | Invalid flag, unknown subcommand, physical device disconnected while leased, or tool error. |
| `2` | `EBUSY / EGUARD_BLOCKED` | All matching devices busy (`--wait 0`) or `atc guard` blocked an unsafe command. |
| `3` | `ENOTFOUND / EFORBIDDEN` | Caller session holds no matching online lease, or lease belongs to another session. |
| `4` | `ETIMEDOUT` | Queue wait (`--wait`) or device boot (`bootTimeoutSec`) timed out. |
| `5` | `ERESOURCE_EXCEEDED` | Host available RAM or free disk space is below safety reserves (ask user before `--force`). |
| `6` | `EPHYSICAL_FORBIDDEN` | Physical device claim rejected by `allowPhysicalDevices` policy. |
