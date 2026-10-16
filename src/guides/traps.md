# atc troubleshooting guide

Run `atc guide <topic>` to read `workflow`, `profiles`, `snapshots`, `multi-agent`, or `traps`.

## Diagnose Android, iOS, and multi-agent failures

| Trap | Symptom | Why it happens | Fix with `atc` |
|---|---|---|---|
| Unscoped `adb`, `simctl booted`, or test command | `adb: more than one device/emulator` or tests hit the wrong simulator | A second emulator/simulator booted or a USB phone is connected. | Always run device commands via `atc exec -- <cmd>` (rewrites `booted` to your leased iOS UDID and sets `ANDROID_SERIAL`). |
| Tests change a personal phone | A test installs an APK/IPA or clears data on a developer's connected phone. | `adb install`, `./gradlew connectedCheck`, or `devicectl` targets a connected USB device. | `atc claim` defaults to `--kind emulator`; `atc guard` blocks unscoped commands and unleased serials/UDIDs. |
| Lease expires during a long Gradle or `xcodebuild` run | Another session claims the emulator/simulator during the run. | The lease time to live (TTL) expired because the build ran without a worker heartbeat. | Run via `atc exec -- ./gradlew ...` or `atc exec -- xcodebuild ...` so `atc` registers `workerPgids` and renews the lease every 15 s. |
| Kotlin Multiplatform (KMP) session holds Android and iOS leases | `atc renew` or `atc free` reports multiple active leases. | The session holds one lease per platform. | Select `--android` or `--ios`, as in `atc renew --ios` or `atc free --android`. `atc exec` selects Android for `adb`/`gradlew` and iOS for `simctl`/`devicectl`/`xcodebuild`. |
| A virtual device crashes or a physical phone disconnects | `atc` blocks the command with an offline error (`exit 2` or `exit 3`). | The emulator/Simulator process died, or the USB cable disconnected. | Re-run `atc claim` within the virtual device's 45-second recovery window to reboot it. For physical phones, the grace period is 15 seconds; ask the user to reconnect. |
| iOS Simulator fails to boot with `code=53` / `SimLaunchHostService` | `Unable to boot the Simulator` (`NSPOSIXErrorDomain code=53`). | The active Xcode `developer_dir` (`xcode-select -p`) does not match the installed simulator runtime build. | Select the matching Xcode.app through `xcode-select` (`DEVELOPER_DIR`), or claim a runtime version that matches the active Xcode. |
| Shell loop variables become unavailable after rewriting | `for apk in *.apk; do adb install "$apk"; done` loses `$apk` if the rewrite separates its assignment and use. | Separate `atc exec` processes cannot read unexported variables from another process. | Run `atc exec -- sh -c 'for apk in *.apk; do adb install "$apk"; done'` or let `atc hook pre-tool-use` rewrite the loop body in place. |
| Cursor hook blocks raw `adb`/`simctl` even with a lease | `Cursor hooks cannot rewrite commands to attach a lease heartbeat.` | Cursor's `beforeShellExecution` hook protocol supports allow/deny responses. It cannot rewrite commands. | Prefix device commands explicitly with `atc exec -- <cmd>` when running in Cursor. |
| Offline AVD counts as a used slot (`emu slots: 1/2`) | `atc status --json` shows `"hasLockFiles": true` on an offline AVD. | QEMU left a non-numeric lock after a crash or is still shutting down. | `atc` removes bare locks with dead PIDs. For a QEMU process still running, wait for shutdown or inspect `~/.android/avd/<Name>.avd/*.lock`. |

## Exit codes reference

| Exit code | Name | Meaning & next step |
|---|---|---|
| `0` | `OK` | The command succeeded or the hook allowed execution. |
| `1` | `EUSAGE / EINTERNAL` | The command has an invalid flag or unknown subcommand, a leased physical device disconnected, or a tool failed. Check `atc --help`. |
| `2` | `EBUSY / EGUARD_BLOCKED` | All matching devices are busy (`--wait 0`) or `atc guard` / `atc hook` blocked an unsafe command. |
| `3` | `ENOTFOUND / EFORBIDDEN` | The session has no active online lease, or another session owns the lease. Claim a device with `atc claim`. |
| `4` | `ETIMEDOUT` | The queue wait (`--wait`) or device boot (`bootTimeoutSec`) timed out. Check `atc status`. |
| `5` | `ERESOURCE_EXCEEDED` | Host available RAM or free disk space is below the safety reserve (`minFreeRamMb` / `minFreeDiskMb`). Free idle devices (`atc free --stop`) or ask the user before passing `--force`. |
| `6` | `EPHYSICAL_FORBIDDEN` | `allowPhysicalDevices` rejects the physical claim. Use a virtual device or update `atc config`. |
