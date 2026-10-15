---
name: atc
description: Coordinate exclusive Android (AVD & physical adb) and iOS/watchOS/tvOS/visionOS (Simulator & physical devicectl) device leases across concurrent coding agents with the `atc` CLI — profile-based claims, QEMU & APFS snapshots, KMP dual-lease routing, warm-affinity queueing, and `atc exec` lease heartbeats. Use before running `adb`, `./gradlew connected*`, `android layout`, `xcrun simctl`, `xcrun devicectl`, `xcodebuild test`, or any mobile device/emulator/simulator command.
license: Apache-2.0
compatibility: Needs Node.js >= 20 on macOS, Linux, or Windows, plus the Android SDK (`adb`, `emulator`, `android` CLI) and/or Xcode (`xcrun simctl`, `xcrun devicectl`) on macOS.
metadata:
  version: "2.1.0"
  author: "Sebastiano Poggi"
---

# Agent Traffic Control (`atc`)

The `atc` CLI coordinates Android emulators, iOS Simulators, and physical test devices (including dual-lease Kotlin Multiplatform / KMP sessions) and carries its own built-in guides. This skill gets you started.

1. Run `atc status`.
   - `atc: command not found`: ask the user, then install it as [references/install.md](references/install.md) says (`npm install -g @rock3r/atc`).
   - Check `Host Capacity` (`emu slots: X/Y`, `sim slots: X/Y`, `build slots: X/Y`, available RAM, free disk), `Running` devices, `Offline` AVDs/Simulators, and active `Leases` / `Builds` / `Queue`.
2. Run `atc guide` and follow it. It covers the claim-exec-free workflow, rules, and a done checklist.
   - Read `atc guide profiles` when choosing `--ios`/`--android`, `--type` (`phone`, `tablet`, `foldable`, `desktop`, `watch`/`wear`, `xr`, `tv`), `--api`/`--os`, `--play`/`--no-play`, or claiming a physical phone (`--serial <id>`, `--udid <id>`, or `--kind physical`).
   - Read `atc guide snapshots` before restoring/saving QEMU or APFS snapshots (`--snapshot-load`, `atc snapshot`), wiping data (`--wipe-data`), resetting app state (`--reset-app`), or handling exit code `5` (`ERESOURCE_EXCEEDED`).
   - Read `atc guide multi-agent` when waiting in the queue (`--wait`), co-scheduling Gradle/Bazel/`xcodebuild` builds (`atc exec --build`, `atc exec --claim`), holding both Android & iOS leases in a KMP session, passing `--session <id>`, or using `atc mcp`.
   - Read `atc guide traps` when diagnosing `more than one device/emulator`, `simctl` collisions, crashed virtual devices vs. unplugged physical phones, blocked daemon kills (`--stop`/`shutdown`), shell loop variable expansion, stale `.avd/*.lock` files, or inspecting `~/Library/Logs/atc/atc-audit.jsonl`.
3. Claim a device before running any Android or iOS command:
   ```bash
   # Android emulator
   atc claim --type phone --api ">=35" --play --wait 300

   # iOS Simulator (macOS)
   atc claim --ios --type phone --os ">=18.0" --wait 300
   ```
   Never start, boot, stop, or wipe an emulator/simulator or kill shared build daemons directly (`emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `xcrun simctl boot`, `xcrun simctl shutdown`, `xcrun simctl erase`, `./gradlew --stop`, `bazel shutdown`). Default claims target virtual devices (`--kind emulator`) so you never hijack a developer's personal USB phone unless explicitly asked.
4. Run every device, instrumentation, or heavy build command through `atc exec`:
   ```bash
   atc exec -- adb shell getprop ro.product.model
   atc exec -- android layout --pretty
   atc exec -- ./gradlew connectedDebugAndroidTest
   atc exec -- xcrun simctl launch booted com.example.app
   atc exec --build -- ./gradlew assembleDebug
   atc exec --claim "--type phone --api >=35" -- ./gradlew connectedDebugAndroidTest
   ```
   `atc exec` injects `ANDROID_SERIAL=<serial>` and `--device=<serial>` on Android, or `ATC_IOS_UDID=<udid>`, rewrites `booted` -> `<udid>` on `simctl`, and injects `--device <udid>` on `devicectl` for iOS. For Gradle, Bazel, and `xcodebuild`, `atc exec` also coordinates 3-tier build slots, per-workspace locks, and CPU/RAM flags. In a KMP session holding 1 Android + 1 iOS lease, `atc exec` auto-selects the matching platform lease.
5. Free the lease as soon as your task finishes:
   ```bash
   atc free
   ```
   Leaving the emulator or simulator warm lets the next queued agent claim it in under 20 ms (`Tier 0`). Pass `atc free --stop` only when shutting down a specialized cold-booted device that other sessions will not reuse.
