# atc workflow guide

Run `atc guide <topic>` to read `workflow`, `profiles`, `snapshots`, `multi-agent`, or `traps`.

## 1. Check fleet capacity before claiming a device

Run `atc status` to check available RAM, free disk, and used slots (`emu slots` and `sim slots`). It also lists running devices, offline Android Virtual Devices (AVDs) and Simulators, and active leases.

Never run raw `emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `xcrun simctl boot`, `xcrun simctl shutdown`, or `xcrun simctl erase`. `atc` owns the virtual device lifecycle.

## 2. Claim, run under `atc exec`, snapshot, and free

1. Claim a device with the platform and profile the task requires:
   ```bash
   # Android emulator (default outside iOS-only directories)
   atc claim --type phone --api ">=35" --play --wait 300

   # iOS Simulator on macOS
   atc claim --ios --type phone --os ">=18.0" --wait 300
   ```
   If your agent host does not export a session ID, pass `--session <id>` or set `ATC_SESSION_ID=<id>`.
2. Run every device command through `atc exec`:
   ```bash
   # Android commands
   atc exec -- adb shell getprop ro.product.model
   atc exec -- android layout --pretty
   atc exec -- ./gradlew connectedDebugAndroidTest

   # iOS Simulator / physical iOS commands (macOS)
   atc exec -- xcrun simctl launch booted com.example.app
   atc exec -- xcrun devicectl device info details
   ```
   On Android, `atc exec` sets `ANDROID_SERIAL` and adds `--device`. On iOS, it sets `ATC_IOS_UDID`, replaces `simctl`'s `booted` target with `<udid>`, and adds `devicectl`'s `--device`. It tracks the worker process group and renews the lease every 15 seconds.

3. Use dual leases for Kotlin Multiplatform (KMP) tasks.
   One session can hold one Android lease and one iOS lease. `atc exec` selects Android for `adb`/`android`/`gradlew` and iOS for `xcrun simctl`/`devicectl`/`xcodebuild`. Select a platform with `--android` or `--ios` in `atc renew`, `atc snapshot`, or `atc free`.
4. Reset state with snapshots when a test changes device storage:
   ```bash
   atc snapshot save clean_login
   # run destructive test steps...
   atc snapshot load clean_login
   ```
5. Renew during long interactive pauses when no `atc exec` worker is running:
   ```bash
   atc renew --ttl 600
   ```
6. Free the lease when the task finishes:
   ```bash
   atc free
   ```
   A running idle device lets the next queued agent claim it in under 20 ms (`Tier 0`). Use `atc free --stop` only for specialized devices, such as `xr` or `watch`, that other tasks will not reuse.

## 3. Rules that keep concurrent agents safe

| Rule | Why it matters | Command pattern |
|---|---|---|
| Scope every device command with `atc exec --` | Raw `adb`, `./gradlew connected*`, `simctl ... booted`, or `xcodebuild test` collides once a second device boots. | `atc exec -- adb install app.apk` |
| Opt in to physical phones explicitly | Default claims set `--kind emulator` so charging USB phones are never touched. | `atc claim --serial <id>` or `atc claim --ios --udid <id>` |
| Keep shell loops inside one `atc exec` subshell | Subshells inside `atc exec` need loop variables evaluated in the same shell (or rewritten by `atc hook pre-tool-use`). | `atc exec -- sh -c 'for apk in *.apk; do adb install -r "$apk"; done'` |
| Respect exit code `5` (`ERESOURCE_EXCEEDED`) | Starting an emulator or saving a snapshot below the RAM/disk reserve risks host OOM or disk exhaustion. | Run `atc free --stop` on idle devices before asking to pass `--force`. |

## 4. Done checklist

- [ ] Every test or UI check ran under `atc exec --`.
- [ ] The agent cleared temporary app state or restored a snapshot.
- [ ] `atc free` released all held leases.
- [ ] `atc status` shows zero active leases or queue tickets for your session.
