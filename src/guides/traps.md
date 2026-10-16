# atc traps & troubleshooting

Guides: `workflow` · `profiles` · `snapshots` · `multi-agent` · `traps` (this page) (`atc guide <topic>`).

## Common Android, iOS & multi-agent traps

| Trap | Symptom | Why it happens | Fix with `atc` |
|---|---|---|---|
| Unscoped `adb`, `simctl booted`, or test command | `adb: more than one device/emulator` or tests hit the wrong simulator | A second emulator/simulator booted or a USB phone is connected. | Always run device commands via `atc exec -- <cmd>` (rewrites `booted` to your leased iOS UDID and sets `ANDROID_SERIAL`). |
| Personal phone hijacked during tests | Test APK/IPA installs or clears data on a developer's USB phone or iPhone. | `adb install`, `./gradlew connectedCheck`, or `devicectl` targets a connected USB device. | `atc claim` defaults to `--kind emulator`; `atc guard` blocks unscoped commands and unleased serials/UDIDs. |
| Lease expires during a long Gradle or `xcodebuild` run | Another session steals the emulator/simulator mid-run. | Static TTL expired because the build was run directly without a worker heartbeat. | Run via `atc exec -- ./gradlew ...` or `atc exec -- xcodebuild ...` so `atc` registers `workerPgids` and renews the lease every 15 s. |
| KMP session holds both Android & iOS leases | `atc renew` or `atc free` reports multiple active leases. | Session holds 1 Android lease and 1 iOS lease simultaneously. | Pass `--android` or `--ios` (`atc renew --ios`, `atc free --android`); `atc exec` auto-disambiguates `adb`/`gradlew` vs `simctl`/`devicectl`/`xcodebuild`. |
| Virtual device crashed vs. physical phone unplugged | Command blocked with offline error (`exit 2` or `exit 3`). | Emulator/Simulator process died (`45s` recovery window) or USB cable disconnected (`15s` fail-fast). | For virtual devices, re-run `atc claim` within 45 s to reboot in-place; for physical phones, ask the user to reconnect the device. |
| iOS Simulator fails to boot with `code=53` / `SimLaunchHostService` | `Unable to boot the Simulator` (`NSPOSIXErrorDomain code=53`). | Active Xcode `developer_dir` (`xcode-select -p`) is newer/older than the installed simulator runtime build. | Switch `xcode-select` (`DEVELOPER_DIR`) to the matching Xcode.app or claim a runtime version matching your active Xcode. |
| Shell loop or `$VAR` breaks across rewrite | `for apk in *.apk; do adb install "$apk"; done` loses `$apk` if split naively. | Subshells inside `atc exec` cannot see unexported variables assigned in a separate process. | Run `atc exec -- sh -c 'for apk in *.apk; do adb install "$apk"; done'` or let `atc hook pre-tool-use` rewrite the loop body in place. |
| Cursor hook blocks raw `adb`/`simctl` even with a lease | `Cursor hooks cannot rewrite commands to attach a lease heartbeat.` | Cursor's `beforeShellExecution` hook protocol only supports allow/deny, not command rewriting. | Prefix device commands explicitly with `atc exec -- <cmd>` when running in Cursor. |
| Offline AVD counts as a used slot (`emu slots: 1/2`) | `atc status --json` shows `"hasLockFiles": true` on an offline AVD. | A previous QEMU process crashed with a non-numeric lock or is still shutting down. | `atc` auto-cleans bare dead-PID locks; if a QEMU process is stuck, wait for shutdown or check `~/.android/avd/<Name>.avd/*.lock`. |
| `./gradlew --stop` or `bazel shutdown` blocked (`exit 2`) | Guard blocks stopping Gradle or Bazel daemons. | Stopping shared build daemons crashes active compilations in other agent sessions. | Never run `--stop`, `shutdown`, or `clean --expunge` on shared hosts; let `atc exec --build` manage build slots and daemon draining. |
| Two builds in the same repo wait on each other | Second `atc exec --build` queues even when `build slots` shows `1/2`. | Both builds share a workspace key (`gradle:<root>`, `bazel:ws:<root>`, or `xcode:dd:<path>`) or a prior aborted/lingering build is in its `5 s` `"draining"` cooldown. | Let `atc` serialize same-workspace builds automatically, or pass an isolated `-derivedDataPath` / `--output_base` when supported. |

## System audit logs (`atc-audit.jsonl`)

`atc` writes structured JSONL audit events (`lease`, `build`, `queue`, `guard`, `gc`) to `~/Library/Logs/atc/atc-audit.jsonl` (macOS), `$XDG_STATE_HOME/atc/logs/atc-audit.jsonl` (Linux), or `%LOCALAPPDATA%\atc\logs\atc-audit.jsonl` (Windows). Attach recent lines from `atc-audit.jsonl` and `atc status --json` when reporting bugs or diagnosing multi-agent contention.

## Exit codes reference

| Exit code | Name | Meaning & next step |
|---|---|---|
| `0` | `OK` | Command succeeded (or hook allowed execution). |
| `1` | `EUSAGE / EINTERNAL` | Invalid CLI flag, unknown subcommand, physical device disconnected while leased, or tool failure. Check `atc --help`. |
| `2` | `EBUSY / EGUARD_BLOCKED` | All matching devices are busy (`--wait 0`) or `atc guard` / `atc hook` blocked an unsafe command. |
| `3` | `ENOTFOUND / EFORBIDDEN` | No active (online) lease for this session, or lease belongs to another session. Claim a device first (`atc claim`). |
| `4` | `ETIMEDOUT` | Queue wait (`--wait`) or emulator/simulator boot (`bootTimeoutSec`) timed out. Check `atc status`. |
| `5` | `ERESOURCE_EXCEEDED` | Host available RAM or free disk space is below the safety reserve (`minFreeRamMb` / `minFreeDiskMb`). Free idle devices (`atc free --stop`) or ask the user before passing `--force`. |
| `6` | `EPHYSICAL_FORBIDDEN` | Physical device claim rejected by policy (`allowPhysicalDevices`). Use an emulator/simulator or update `atc config`. |
