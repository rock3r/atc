# `atc` user guide

`atc` (Android Traffic Control) coordinates exclusive Android Virtual Device (AVD) and physical USB/Wi-Fi device leases across concurrent coding agents and developer terminal sessions. You—or an agent working on your behalf—claim a device by profile, run `adb`, Gradle `connectedCheck`, or `android` CLI commands inside `atc exec`, save and restore QEMU snapshots, and release the lease when done.

You need Node.js 20 or newer on macOS, Linux, or Windows, plus the Android SDK (`adb`, `emulator`, and/or the official `android` CLI).

## Install

**1. Install the CLI.**

```bash
npm install -g android-traffic-control
```

Or from a local clone of the repository:

```bash
npm install -g .
```

**2. Check your fleet and host capacity.**

```bash
atc status
```

`atc status` inspects your available RAM, free disk space, `~/.android/avd/*.ini` metadata, `adb devices`, and `android emulator list` without holding a lock, then prints:

```text
Host Capacity: 25039 MB RAM avail · 54576 MB disk free · slots: 0/2 used
  Running (2): adb-2A191FDH3007B7-WLccO7._adb-tls-connect._tcp, adb-68041FDKX000SV-XnmQwo._adb-tls-connect._tcp
  Offline (8): Medium_Phone, Opus_API37, Pixel_3a_API_33_arm64-v8a, Pixel_8_API_34_GMS, Pixel_9, Resizable, Wear_OS_Small_Round, XR_Glasses
  Leases  (0): none
  Queue   (0): none
```

Pass `atc status --json` for full machine-readable output (including each AVD's API level, form factor, Play Store support, RAM/disk requirements, and existing QEMU snapshots).

**3. Install the agent plugin (optional).**

In Claude Code:

```text
/plugin marketplace add rock3r/atc
/plugin install atc@atc
```

In Codex:

```bash
codex plugin marketplace add rock3r/atc
codex plugin add atc@atc
```

In Gemini CLI or Antigravity, copy `skills/atc` into your skills directory (`~/.gemini/skills/atc` or `~/.agents/skills/atc`) and configure `atc hook pre-tool-use` and `atc hook stop`. In Cursor, copy `.cursor/hooks.json` into `.cursor/hooks.json`. In Pi, load `extensions/atc/index.ts`.

## Built-in guides (`atc guide`)

`atc` carries its own documentation so coding agents never need to guess flags or recovery steps:

```bash
atc guide              # default: the workflow loop, rules, and done checklist
atc guide profiles     # 3-tier fleet discovery, profile flags, and physical device safety
atc guide snapshots    # QEMU snapshots, wipe/cold/reset-app flags, and RAM/disk guardrails
atc guide multi-agent  # session identity, warm-affinity queue, hooks, guard, and MCP
atc guide traps        # common Android/ADB/multi-agent failure modes and exit codes
```

Add `--json` (`atc guide traps --json`) to receive `{ topic, topics, text }` as JSON.

## Your first leased session

**1. Claim an emulator by profile.**

```bash
atc claim --type phone --api ">=35" --play --wait 300
```

What happens when you run `atc claim`:

- **`Tier 0` (warm reuse, `<20 ms`):** If a running, unlocked emulator already matches `phone`, `api >= 35`, and `play`, `atc` assigns the lease immediately.
- **`Tier 1` (cold boot from `~/.android/avd`):** If no running emulator matches and an emulator slot is open (`slots: 0/2 used`), `atc` checks host RAM and disk reserves, writes a `"starting"` reservation under `atc.lock`, boots the matching offline AVD outside the lock, waits for `sys.boot_completed=1`, and activates the lease.
- **`Tier 2` (warm idle eviction):** If all emulator slots are occupied by unlocked idle emulators and `autoStopIdleOnContention` is `true`, `atc` stops the oldest idle emulator first, then boots the requested AVD.
- **`Tier 3` (create on demand):** If you pass `--create-if-missing` and no local AVD matches, `atc` creates a deterministic AVD via `android emulator create` before booting it.

**2. Run commands through `atc exec`.**

```bash
atc exec -- adb shell getprop ro.product.model
atc exec -- android layout --pretty
atc exec -- ./gradlew connectedDebugAndroidTest
```

`atc exec` does three things automatically:

1. Exports `ANDROID_SERIAL=<serial>` (and `ATC_LEASE_ID`, `ATC_SESSION_ID`, `ATC_AVD`) into the child environment.
2. Injects `--device=<serial>` into `android` CLI subcommands (`layout`, `screenshot`, `run`, `install`, etc.) when not already specified.
3. Registers the child's process group (`workerPgids`) in `state.json` and runs a background heartbeat that renews the lease every 15 seconds for as long as the command is alive.

**3. Release the lease when finished.**

```bash
atc free
```

By default, `atc free` releases the lease while leaving the emulator running (`warm`), so the next agent session that needs a compatible device claims it in under 20 ms. If you booted a specialized emulator (such as `xr` or `wear`) and want to reclaim host RAM immediately, pass `--stop`:

```bash
atc free --stop
```

## Snapshots and clean state resets

When tests mutate device state (login tokens, local databases, permissions), use QEMU snapshots or reset flags:

```bash
# Restore a known snapshot on claim and clear app data before starting
atc claim --type phone --api 36 --snapshot-load default_boot --reset-app com.example.app

# Save a checkpoint mid-session
atc snapshot save logged_in

# Run destructive test steps, then rewind to the checkpoint
atc snapshot load logged_in

# Save a snapshot and stop the emulator when freeing
atc free --snapshot-save post_test --stop
```

To wipe an emulator back to factory userdata before booting, pass `--wipe-data`:

```bash
atc claim --avd Pixel_9 --wipe-data
```

## Multi-agent contention and the warm-affinity queue

When two or more agents request devices concurrently:

- Each agent session is identified automatically via `--session <id>`, `ATC_SESSION_ID`, host environment variables (`CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `GEMINI_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `CURSOR_SESSION_ID`, `PI_SESSION_ID`), hook PID breadcrumbs, or parent process PID.
- When all matching devices or slots are busy, `atc claim --wait 300` places the caller into `state.queue` and updates its ticket heartbeat once per second.
- **Warm-affinity batching (`reorderWindowSec = 120s`):** Suppose `Pixel_9` (API 36) is currently running. Ticket #1 in the queue wants an offline `Wear_OS` AVD (which requires stopping `Pixel_9` and cold-booting Wear OS), while Ticket #2 wants `Pixel_9` (already warm). As long as Ticket #1 has waited less than `120s`, Ticket #2 can jump ahead and reuse the warm `Pixel_9` immediately instead of thrashing the host with two cold boots.
- **Starvation protection:** Once Ticket #1 reaches `starvationDeadlineMs` (`120s`), it freezes at Priority #0. No newer ticket can jump ahead of it.

## Physical USB and Wi-Fi devices

Developers often charge a personal phone over USB or keep Wireless Debugging connected while coding. To prevent agents from accidentally installing debug APKs or clearing data on a personal device:

- Default claims (`atc claim --type phone`) **only match emulators** (`--kind emulator`).
- Physical devices do not count toward `maxRunningEmulators` QEMU slots.
- To claim a connected physical test device explicitly, pass its serial or `--kind physical`:
  ```bash
  atc claim --serial adb-2A191FDH3007B7-WLccO7._adb-tls-connect._tcp --session device-test
  atc exec --session device-test -- adb shell getprop ro.product.model
  atc free --session device-test
  ```
- To forbid all physical device claims on a machine, set:
  ```bash
  atc config set allowPhysicalDevices never
  ```

## Host RAM and disk guardrails

Before starting an offline AVD, wiping userdata, or saving a snapshot, `atc` checks host resources:

- **RAM:** Projected available RAM (subtracting any other `"starting"` or freshly activated emulators not yet reflected in OS free memory) must cover `ramSizeMb + qemuOverheadRamMb (1024 MB) + minFreeRamMb (2048 MB)`.
- **Disk:** Free disk space on the AVD's filesystem volume must cover the required userdata/snapshot size plus `minFreeDiskMb (2048 MB)`.

When host RAM or disk is below the safety threshold, `atc` exits with code `5` (`ERESOURCE_EXCEEDED`). Stop unused emulators (`atc free --stop`) or adjust thresholds with `atc config set minFreeRamMb <mb>`. Pass `--force` only when you intentionally want to bypass the check.

## Guardrails, hooks, and MCP

When the `atc` plugin or hooks are active:

- **`PreToolUse` (`atc hook pre-tool-use` / `atc guard`):**
  - Non-Android shell commands (`git`, `npm`, `ls`, `./gradlew assembleDebug`) exit in `<2 ms` without touching `atc.lock`.
  - Direct emulator lifecycle commands (`emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `adb disconnect`) are blocked with exit code `2`.
  - Device commands (`adb shell`, `adb install`, `./gradlew connectedDebugAndroidTest`, `android layout`) are blocked if the session holds no active lease or targets another session's serial, and are automatically rewritten to `atc exec --serial <serial> -- ...` in hosts that support command rewriting (Claude Code, Gemini CLI, Antigravity, Pi).
- **`SessionEnd` / `Stop` (`atc hook stop`):**
  - Automatically releases any active leases owned by the finishing agent session (or marks `releaseOnWorkerExit` if a background `atc exec` worker is still completing).
- **Stdio MCP (`atc mcp`):**
  - Exposes `atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, and `atc_guide` over newline-delimited JSON-RPC 2.0.

## Troubleshooting and exit codes

Run `atc guide traps` at any time for a quick reference table.

| Exit code | Constant | When it happens |
|---|---|---|
| `0` | `OK` | Command succeeded. |
| `1` | `EUSAGE / EINTERNAL` | Invalid flag, unknown subcommand/topic, or tool execution failure. |
| `2` | `EBUSY / EGUARD_BLOCKED` | All matching devices are busy (`--wait 0`) or `atc guard` blocked an unsafe command. |
| `3` | `ENOTFOUND / EFORBIDDEN` | Caller session holds no matching lease, or lease belongs to another session / has in-flight workers. |
| `4` | `ETIMEDOUT` | Queue wait (`--wait`) or emulator boot (`bootTimeoutSec`) timed out. |
| `5` | `ERESOURCE_EXCEEDED` | Host RAM or free disk space is below the required reserve (bypassable with `--force`). |
| `6` | `EPHYSICAL_FORBIDDEN` | Physical device claim blocked by `allowPhysicalDevices` config policy. |
