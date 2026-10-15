# atc snapshots, state resets & resource guardrails

Guides: `workflow` · `profiles` · `snapshots` (this page) · `multi-agent` · `traps` (`atc guide <topic>`).

## 1. Reset device state on `atc claim`

When your test needs a known starting state, pass reset flags to `atc claim`:

| Flag | Android emulator action | iOS Simulator action |
|---|---|---|
| `--snapshot-load <name>` | Restores QEMU snapshot `<name>` via `adb emu avd snapshot load` before activating the lease. | Restores APFS copy-on-write (`cp -cR`) snapshot `<name>` from `~/.atc-snapshots/<udid>/<name>` while shutdown, then boots. |
| `--snapshot-save-on-free <name>` | Saves QEMU snapshot `<name>` when `atc free` releases the lease. | Saves APFS snapshot `<name>` when `atc free` releases the lease. |
| `--wipe-data` | Stops the emulator if running, deletes `userdata-qemu.img*` / `cache.img*`, and cold-boots clean. | Shuts down the simulator, runs `xcrun simctl erase <udid>`, and boots clean. |
| `--cold` | Boots with `-no-snapshot-load` instead of restoring quickboot state. | Shuts down and cold-boots the simulator cleanly. |
| `--reset-app <pkg\|bundleId>` | Runs `adb shell pm clear <pkg>` before handing over the lease. | Stops `<bundleId>`, runs `xcrun simctl privacy <udid> reset all <bundleId>`, and wipes its data container. |

```bash
# Android: restore snapshot and clear app storage on claim
atc claim --type phone --api 36 --snapshot-load default_boot --reset-app com.example.app

# iOS Simulator: reset app permissions and container on claim
atc claim --ios --type phone --os ">=18.0" --reset-app com.example.iosApp
```

## 2. Save and restore snapshots during an active lease

While holding an active emulator or simulator lease, use `atc snapshot`:

```bash
atc snapshot list                  # list snapshots on the leased device
atc snapshot save before_checkout  # QEMU snapshot (Android) or APFS cp -cR clone (iOS Simulator)
atc snapshot load before_checkout  # rewind to saved state and wait for boot readiness
atc snapshot delete before_checkout
```

In a Kotlin Multiplatform (KMP) session holding both an Android lease and an iOS lease, pass `--android` or `--ios` (`atc snapshot save clean_state --ios`).

You can also save or load a snapshot when releasing a lease:

```bash
atc free --snapshot-save clean_state
atc free --snapshot-load default_boot
```

During `atc free --snapshot-save` or `atc free --stop`, `atc` marks the lease `"stopping"` under `atc.lock` before calling external tools so no other agent claims the device mid-save or mid-shutdown.

## 3. Host RAM and disk admission guardrails

Android QEMU emulators and iOS Simulators use separate concurrency pools and pre-flight resource checks before booting, wiping data, or saving a snapshot:

| Pool | Default slot cap | Pre-flight admission rule |
|---|---|---|
| Android QEMU (`maxRunningEmulators`) | `2` | Projected available RAM must cover `ramSizeMb + qemuOverheadRamMb (1024 MB) + minFreeRamMb (2048 MB)` plus unaccounted `<10 s` starting builds, and target volume must have `dataDiskMb + minFreeDiskMb (2048 MB)` free disk. |
| iOS Simulators (`maxRunningSimulators`) | `4` | Target volume (`statfsSync`) must have required snapshot/clone disk plus `minFreeDiskMb (2048 MB)` free disk. |
| Heavy builds (`maxConcurrentBuilds`) | `2` (`+1` burst) | Per-workspace lock (`gradle:<root>`, `bazel:ws:<root>`, `xcode:<dir>`) plus RAM check (`buildRamEstimateMb = 4096 MB` for cold daemons + `minFreeRamMb`). |

If either check fails, `atc` exits with code `5` (`ERESOURCE_EXCEEDED`). Free idle virtual devices with `atc free --stop` first; only pass `--force` if the user approves bypassing host resource limits.
