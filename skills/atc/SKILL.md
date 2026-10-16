---
name: atc
description: Coordinates exclusive Android and iOS/watchOS/tvOS/visionOS device leases across coding agents with the atc CLI. Supports virtual and physical devices, profile matching, QEMU and APFS snapshots, KMP dual leases, queued claims, and command heartbeats. Use before running adb, ./gradlew connected*, android layout, xcrun simctl, xcrun devicectl, xcodebuild test, or other mobile device commands.
license: Apache-2.0
compatibility: Needs Node.js >= 20 on macOS, Linux, or Windows, plus the Android SDK (`adb`, `emulator`, `android` CLI) and/or Xcode (`xcrun simctl`, `xcrun devicectl`) on macOS.
metadata:
  version: "2.1.0"
  author: "Sebastiano Poggi"
---

# Agent Traffic Control (`atc`)

The `atc` CLI gives agents exclusive leases for Android emulators, iOS Simulators, and physical test devices. Kotlin Multiplatform (KMP) sessions can hold Android and iOS leases together. Run `atc guide` for the device workflow.

1. Run `atc status`.
   - If the shell reports `atc: command not found`, ask the user before installing. Follow [references/install.md](references/install.md) (`npm install -g @rock3r/atc`).
   - Check `Host Capacity` (`emu slots: X/Y`, `sim slots: X/Y`, available RAM, free disk), `Running` devices, `Offline` AVDs/Simulators, and active `Leases` / `Queue`.
2. Follow `atc guide` to claim a device, run commands, and release the lease.
   - Read `atc guide profiles` when choosing `--ios`/`--android`, `--type` (`phone`, `tablet`, `foldable`, `desktop`, `watch`/`wear`, `xr`, `tv`), `--api`/`--os`, `--play`/`--no-play`, or claiming a physical phone (`--serial <id>`, `--udid <id>`, or `--kind physical`).
   - Read `atc guide snapshots` before restoring/saving QEMU or APFS snapshots (`--snapshot-load`, `atc snapshot`), wiping data (`--wipe-data`), resetting app state (`--reset-app`), or handling exit code `5` (`ERESOURCE_EXCEEDED`).
   - Read `atc guide multi-agent` when waiting in the queue (`--wait`), holding both Android & iOS leases in a KMP session, passing `--session <id>`, or using `atc mcp`.
   - Read `atc guide traps` when diagnosing `more than one device/emulator`, `simctl` collisions, crashed virtual devices vs. unplugged physical phones, shell loop variable expansion, or stale `.avd/*.lock` files.
3. Claim a device before running any Android or iOS command:
   ```bash
   # Android emulator
   atc claim --type phone --api ">=35" --play --wait 300

   # iOS Simulator (macOS)
   atc claim --ios --type phone --os ">=18.0" --wait 300
   ```
   Never start, boot, stop, or wipe an emulator or simulator directly. This includes `emulator -avd`, `android emulator start`, `adb emu kill`, and `adb kill-server`. It also includes `xcrun simctl boot`, `xcrun simctl shutdown`, and `xcrun simctl erase`. Default claims target virtual devices (`--kind emulator`). Claim a physical phone only when the user requests it.
4. Run every device or instrumentation command through `atc exec`:
   ```bash
   atc exec -- adb shell getprop ro.product.model
   atc exec -- android layout --pretty
   atc exec -- ./gradlew connectedDebugAndroidTest
   atc exec -- xcrun simctl launch booted com.example.app
   ```
   On Android, `atc exec` sets `ANDROID_SERIAL=<serial>` and adds `--device=<serial>`. On iOS, it sets `ATC_IOS_UDID=<udid>`. It replaces `simctl`'s `booted` target with `<udid>` and adds `devicectl`'s `--device <udid>`. When a KMP session holds Android and iOS leases, `atc exec` selects the matching platform lease.
5. Free the lease as soon as your task finishes:
   ```bash
   atc free
   ```
   Leave reusable emulators and simulators running so the next queued agent can claim them in under 20 ms (`Tier 0`). Use `atc free --stop` only for a specialized cold-booted device that other sessions will not reuse.
