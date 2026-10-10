# atc workflow guide

Guides: `workflow` (this page) · `profiles` · `snapshots` · `multi-agent` · `traps` (`atc guide <topic>`).

## 1. Before you start

Run `atc status`. Check:

- `Host Capacity`: available RAM, free disk, and used emulator slots (`slots: X/Y used`).
- `Running`: warm emulators and connected physical devices.
- `Offline`: local AVDs in `~/.android/avd` that `atc claim` can boot on demand.
- `Leases` and `Queue`: whether another agent already holds or waits for a device.

Never run raw `emulator -avd`, `android emulator start`, `adb emu kill`, or `adb kill-server`. `atc` owns the emulator lifecycle.

## 2. The loop

1. **Claim a device** matching the profile your task needs:
   ```bash
   atc claim --type phone --api ">=35" --play --wait 300
   ```
   Pass `--session <id>` (or set `ATC_SESSION_ID=<id>`) when your agent host does not export a session ID.
2. **Run every device command through `atc exec`**:
   ```bash
   atc exec -- adb shell getprop ro.product.model
   atc exec -- android layout --pretty
   atc exec -- ./gradlew connectedDebugAndroidTest
   ```
   `atc exec` sets `ANDROID_SERIAL=<serial>`, injects `--device=<serial>` into `android` CLI commands, tracks the worker process group, and renews the lease every 15 seconds while the command runs.
3. **Inspect or reset state with snapshots** when a test mutates device state:
   ```bash
   atc snapshot save clean_login
   # run destructive test steps...
   atc snapshot load clean_login
   ```
4. **Renew between long interactive pauses** if no `atc exec` worker is running:
   ```bash
   atc renew --ttl 600
   ```
5. **Free the lease as soon as your task finishes**:
   ```bash
   atc free
   ```
   Leaving the emulator warm lets the next queued agent claim it in under 20 ms (`Tier 0`). Pass `atc free --stop` only when you booted a specialized AVD (such as `xr` or `wear`) that other tasks will not reuse.

## 3. Rules that keep concurrent agents safe

- **Always scope device access with `atc exec -- <cmd>`.** Raw `adb` or `./gradlew connected*` fails with `more than one device/emulator` as soon as a second emulator boots or a USB phone is plugged in.
- **Physical phones are opt-in.** Default claims only match emulators (`--kind emulator`). Claim a physical phone only when the user asks, using `atc claim --serial <serial>` or `atc claim --kind physical`.
- **Keep shell loops and variables inside one `atc exec` shell** or let the `PreToolUse` hook rewrite them:
  ```bash
  atc exec -- sh -c 'for apk in app.apk test.apk; do adb install -r "$apk"; done'
  ```
- **Respect exit code `5` (`ERESOURCE_EXCEEDED`).** If `atc claim` or `atc snapshot save` reports insufficient host RAM or disk space, free unused emulators (`atc free --stop`) or ask the user before passing `--force`.

## 4. Done checklist

- [ ] Every test or UI verification ran under `atc exec --`.
- [ ] Any temporary app state was cleaned up or restored from a snapshot.
- [ ] `atc free` was called to release the lease.
- [ ] `atc status` confirms your session holds zero active leases or queue tickets.
