# atc snapshots and state resets

Run `atc guide <topic>` to read `workflow`, `profiles`, `snapshots`, `multi-agent`, or `traps`.

## 1. Reset device state on `atc claim`

Pass reset flags to `atc claim` when a test requires a known starting state:

| Flag | Android emulator action | iOS Simulator action |
|---|---|---|
| `--snapshot-load <name>` | `atc` restores QEMU snapshot `<name>` with `adb emu avd snapshot load` before activating the lease. | `atc` shuts down the simulator if running, restores APFS copy-on-write (`cp -cR`) snapshot `<name>` from `<stateDir>/ios-snapshots/<udid>/<name>`, and boots the simulator. |
| `--snapshot-save-on-free <name>` | `atc free` saves QEMU snapshot `<name>` before releasing the lease. | `atc free` saves APFS snapshot `<name>` before releasing the lease. |
| `--wipe-data` | `atc` stops a running emulator, deletes `userdata-qemu.img*` / `cache.img*`, and boots it with clean data. | `atc` shuts down the simulator, runs `xcrun simctl erase <udid>`, and boots it with clean data. |
| `--cold` | `atc` boots with `-no-snapshot-load` to skip quickboot state. | `atc` shuts down and cold-boots the simulator. |
| `--reset-app <pkg\|bundleId>` | `atc` runs `adb shell pm clear <pkg>` before activating the lease. | `atc` stops `<bundleId>`, runs `xcrun simctl privacy <udid> reset all <bundleId>`, and clears its data container. |

```bash
# Android: restore snapshot and clear app storage on claim
atc claim --type phone --api 36 --snapshot-load default_boot --reset-app com.example.app

# iOS Simulator: reset app permissions and container on claim
atc claim --ios --type phone --os ">=18.0" --reset-app com.example.iosApp
```

## 2. Save and restore snapshots during an active lease

Use `atc snapshot` (or `atc exec snapshot …`) with an active emulator or simulator lease:

```bash
atc snapshot list                  # list snapshots on the leased device
atc snapshot save before_checkout  # QEMU snapshot (Android) or APFS cp -cR clone (iOS Simulator)
atc snapshot load before_checkout  # rewind to saved state and wait for boot readiness
atc snapshot delete before_checkout
```

For a Kotlin Multiplatform (KMP) session with Android and iOS leases, select the platform with `--android` or `--ios`. For example, run `atc snapshot save clean_state --ios`.

`atc free` can save or load a snapshot before releasing a lease:

```bash
atc free --snapshot-save clean_state
atc free --snapshot-load default_boot
```

`atc free --snapshot-save` and `atc free --stop` mark the lease `"stopping"` under `atc.lock`. External tools then run outside the lock. This reservation prevents another agent from claiming the device during the operation.

## 3. Host RAM and disk admission guardrails

`atc` uses separate slot limits for Android QEMU emulators and iOS Simulators. It checks resources before booting, wiping data, or saving snapshots:

| Pool | Default slot cap | Pre-flight admission rule |
|---|---|---|
| Android QEMU (`maxRunningEmulators`) | `2` | Projected available RAM must cover `ramSizeMb + qemuOverheadRamMb (1024 MB) + minFreeRamMb (2048 MB)`, plus unaccounted builds that started in the last 30 s. The target volume must have `dataDiskMb + minFreeDiskMb (2048 MB)` free disk. |
| iOS Simulators (`maxRunningSimulators`) | `4` | Projected available RAM must cover `simOverheadRamMb (1280 MB) + minFreeRamMb (2048 MB)`, and free disk on the target volume (`statfsSync`) must cover the boot or snapshot clone plus `minFreeDiskMb (2048 MB)`. |
| Heavy builds (`maxConcurrentBuilds`) | `"auto"` (1-4 by CPU/RAM, `+1` burst) | One build per workspace key (`gradle:<root>`, `bazel:ws:<root>`, `xcode:<root>`, `xcode:dd:<derivedData>`) plus a RAM check (`buildRamEstimateMb = 3072 MB` for cold daemons + `minFreeRamMb`). |

If either check fails, `atc` exits with code `5` (`ERESOURCE_EXCEEDED`). Stop idle virtual devices with `atc free --stop` first. For emulator/simulator boots and snapshot saves, use `--force` on `atc claim` / `atc snapshot` only with user approval to bypass host resource limits. Build RAM admission is never bypassed: `--force` on a build op only overrides value patterns, so free resources or wait for running builds instead.
