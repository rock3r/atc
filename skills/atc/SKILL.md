---
name: atc
description: Coordinate shared Android emulator and physical device leases across concurrent coding agents using Android Traffic Control (atc). Use before running adb, gradle connectedCheck, or android emulator commands.
---

# Android Traffic Control (`atc`)

Always coordinate Android emulator and physical device access through `atc` so concurrent agent sessions do not collide on the same `ANDROID_SERIAL`, corrupt snapshots, or exhaust host RAM.

## Golden Rules

1. **Never run `adb` or `emulator` without an active `atc` lease.**
2. **Use `atc exec` for test runs or one-off commands** — it automatically sets `ANDROID_SERIAL=<serial>`, injects `--device=<serial>` for `android` CLI commands, and renews the lease heartbeat in the background every 15 seconds while the command runs:
   ```bash
   npx atc exec --session builder-1 -- ./gradlew connectedDebugAndroidTest
   npx atc exec --session builder-1 -- adb shell am start -n com.example/.MainActivity
   ```
3. **Or claim explicitly when running multiple interactive steps:**
   ```bash
   npx atc claim --session builder-1 --api 35 --type phone --json
   ```
   When finished, release the lease immediately:
   ```bash
   npx atc free --session builder-1
   ```
4. **Never start, boot, kill, or wipe an emulator directly** (`emulator -avd ...`, `adb emu kill`, `android emulator start`). Let `atc claim` and `atc free --stop` manage device lifecycle and clean snapshots (`atc-clean-base`).
