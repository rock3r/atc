# atc workflow guide

Guides: `workflow` (this page) · `profiles` · `snapshots` · `multi-agent` · `traps` (`atc guide <topic>`).

## 1. Check fleet capacity before claiming a device

Run `atc status` to inspect available RAM, free disk, used Android emulator slots (`emu slots`), used iOS Simulator slots (`sim slots`), used build slots (`build slots`), running devices, offline AVDs/Simulators, active leases, and active builds.

Never run raw `emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `xcrun simctl boot`, `xcrun simctl shutdown`, `xcrun simctl erase`, `./gradlew --stop`, `bazel shutdown`, or `bazel clean --expunge`. `atc` owns the virtual device lifecycle and shared build daemons.

## 2. Claim, run under `atc exec`, co-schedule builds, snapshot, and free

1. **Claim a device** matching the platform and profile your task needs:
   ```bash
   # Android emulator (default outside iOS-only directories)
   atc claim --type phone --api ">=35" --play --wait 300

   # iOS Simulator on macOS
   atc claim --ios --type phone --os ">=18.0" --wait 300
   ```
   If your agent host does not export a session ID, pass `--session <id>` or set `ATC_SESSION_ID=<id>`.
2. **Run every device or build command through `atc exec`**:
   ```bash
   # Android commands (Tier 1 priority build slot auto-assigned when holding a device)
   atc exec -- adb shell getprop ro.product.model
   atc exec -- android layout --pretty
   atc exec -- ./gradlew connectedDebugAndroidTest

   # Pure builds without a device lease (Tier 2 build slot + per-workspace lock)
   atc exec --build -- ./gradlew assembleDebug
   atc exec --build -- bazel build //app:main

   # One-shot atomic device + build co-allocation (claims device + Tier 1 build slot, frees both on exit)
   atc exec --claim "--type phone --api >=35" -- ./gradlew connectedDebugAndroidTest

   # iOS Simulator / physical iOS commands (macOS)
   atc exec -- xcrun simctl launch booted com.example.app
   atc exec -- xcrun devicectl device info details
   ```
   `atc exec` injects `ANDROID_SERIAL` and `--device` on Android, or `ATC_IOS_UDID`, `booted` -> `<udid>` (`simctl`), and `--device` (`devicectl`) on iOS. For `gradle`, `bazel`, and `xcodebuild`, `atc exec` also coordinates workspace locks, shapes worker/RAM flags (`-Dorg.gradle.workers.max`, `--jobs`, `-jobs`), tracks the worker process group, and renews the lease every 15 seconds.

3. **Use dual leases for Kotlin Multiplatform (KMP) tasks**:
   One session can hold **1 Android lease + 1 iOS lease** at once. `atc exec` routes `adb`/`android`/`gradlew` to the Android lease and `xcrun simctl`/`devicectl`/`xcodebuild` to the iOS lease automatically. Pass `--android` or `--ios` to target one leg in `atc renew`, `atc snapshot`, or `atc free`.
4. **Reset state with snapshots** when a test mutates device storage:
   ```bash
   atc snapshot save clean_login
   # run destructive test steps...
   atc snapshot load clean_login
   ```
5. **Renew during long interactive pauses** when no `atc exec` worker is running:
   ```bash
   atc renew --ttl 600
   ```
6. **Free the lease when your task finishes**:
   ```bash
   atc free
   ```
   Leaving the virtual device warm lets the next queued agent claim it in under 20 ms (`Tier 0`). Pass `atc free --stop` only when shutting down a specialized device (such as `xr` or `watch`) that other tasks will not reuse.

## 3. Rules that keep concurrent agents safe

| Rule | Why it matters | Command pattern |
|---|---|---|
| Scope every device command with `atc exec --` | Raw `adb`, `./gradlew connected*`, `simctl ... booted`, or `xcodebuild test` collides once a second device boots. | `atc exec -- adb install app.apk` |
| Opt in to physical phones explicitly | Default claims set `--kind emulator` so charging USB phones are never touched. | `atc claim --serial <id>` or `atc claim --ios --udid <id>` |
| Keep shell loops inside one `atc exec` subshell | Subshells inside `atc exec` need loop variables evaluated in the same shell (or rewritten by `atc hook pre-tool-use`). | `atc exec -- sh -c 'for apk in *.apk; do adb install -r "$apk"; done'` |
| Respect exit code `5` (`ERESOURCE_EXCEEDED`) | Starting an emulator or saving a snapshot below the RAM/disk reserve risks host OOM or disk exhaustion. | Run `atc free --stop` on idle devices before asking to pass `--force`. |

## 4. Done checklist

- [ ] Every test or UI check ran under `atc exec --`.
- [ ] Temporary app state was cleaned up or restored from a snapshot.
- [ ] `atc free` released all held leases.
- [ ] `atc status` shows zero active leases or queue tickets for your session.
