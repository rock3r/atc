# atc traps & troubleshooting

Guides: `workflow` · `profiles` · `snapshots` · `multi-agent` · `traps` (this page) (`atc guide <topic>`).

## Common Android, iOS & multi-agent traps

| Trap | Symptom | Why it happens | Fix with `atc` |
|---|---|---|---|
| Raw `adb`, `simctl`, or test command | `adb: more than one device/emulator` or tests hit the wrong simulator | A second emulator/simulator booted or a USB phone is connected, and the command wasn't scoped. | Request the work as an `atc` op (`atc exec android …`, `atc exec ios …`, `atc exec gradle tasks connected…`); `atc` always targets your leased serial/UDID. |
| Request rejected with exit `7` | `[atc] Request rejected (N problems)` | A value didn't match its pattern, an option is unknown, or the op isn't in the catalog. Nothing ran. | Read every listed problem and hint. Fix values, use `atc exec --help`, move `cwd`/`env`/multi-step work into `atc batch`, or request the op at https://github.com/rock3r/atc/issues. |
| Legitimate build value rejected | e.g. an unusual Gradle task or Bazel label is refused | Patterns are strict on purpose. | Re-run with `--force --reason "<why>"` (build values only; you take responsibility and the run is recorded). |
| Personal phone hijacked during tests | Test APK/IPA installs or clears data on a developer's phone. | A raw command targeted a connected USB device. | `atc claim` defaults to `--kind emulator`, and `atc` ops only target your own lease. Don't run raw device commands. |
| Lease expires during a long build | Another session steals the emulator/simulator mid-run. | The build ran outside `atc`, so no heartbeat renewed the lease. | Run builds as `atc exec gradle tasks …` / `atc exec xcode …` so `atc` registers the worker and renews the lease. |
| Device held while compiling | Notice: "The device is held for the whole invocation, including compilation." | One request mixed compile tasks and device tasks. | Split assemble and device phases (two steps in `atc batch`, device claimed only for the second). |
| KMP session holds both Android & iOS leases | `atc renew` or `atc free` reports multiple active leases. | Session holds 1 Android lease and 1 iOS lease simultaneously. | Pass `--android` or `--ios` (`atc renew --ios`, `atc free --android`); ops pick their platform's lease automatically. |
| Virtual device crashed vs. physical phone unplugged | Device op fails with an offline error. | Emulator/Simulator process died (`45s` recovery window) or USB cable disconnected (`15s` fail-fast). | For virtual devices, re-run `atc claim` within 45 s to reboot in place; for physical phones, ask the user to reconnect the device. |
| iOS Simulator fails to boot with `code=53` / `SimLaunchHostService` | `Unable to boot the Simulator` (`NSPOSIXErrorDomain code=53`). | Active Xcode `developer_dir` (`xcode-select -p`) doesn't match the installed simulator runtime build. | Switch `xcode-select` (`DEVELOPER_DIR`) to the matching Xcode.app or claim a runtime version matching your active Xcode. |
| `gradle_wrapper_not_found` | `No Gradle wrapper (gradlew) found in … or its parents.` | `gradle.tasks` runs the project's wrapper; there is no system `gradle` fallback. | Run from inside the project or pass `--workspace <dir>`. |
| Windows path refused | `windows_unsafe_path` / `windows_unsafe_arg` | `gradlew.bat` runs through `cmd.exe`, which expands `%`, `!`, `^` even inside quotes. | Move the project to a path without those characters; keep build values to `[A-Za-z0-9_.:/\@+=,-]`. |
| Offline AVD counts as a used slot (`emu slots: 1/2`) | `atc status --json` shows `"hasLockFiles": true` on an offline AVD. | A previous QEMU process crashed with a non-numeric lock or is still shutting down. | `atc` auto-cleans bare dead-PID locks; if a QEMU process is stuck, wait for shutdown or check `~/.android/avd/<Name>.avd/*.lock`. |
| Stopping shared build daemons | There is no op for `./gradlew --stop` or `bazel shutdown`. | Stopping shared daemons crashes active compilations in other agent sessions. | Don't stop them on shared hosts; `atc` manages build slots and draining. |
| Two builds in the same repo wait on each other | Second build queues even when `build slots` shows `1/2`. | Both builds share a workspace key (`gradle:<root>`, `bazel:ws:<root>`, or `xcode:dd:<path>`), or a prior aborted build is in its `5 s` `"draining"` cooldown. | Expected: same-workspace builds are serialized. Use separate checkouts (or an isolated `derivedDataPath`) for true parallelism. |
| An op ran too long | Exit `124`. | The op's `timeoutSec` elapsed and `atc` stopped it. | Raise `timeoutSec` (required on `bazel.run`; optional per batch step). |

## System audit logs (`atc-audit.jsonl`)

`atc` writes structured JSONL audit events (`lease`, `build`, `queue`, `gc`, `forced_run`) to `~/Library/Logs/atc/atc-audit.jsonl` (macOS), `$XDG_STATE_HOME/atc/logs/atc-audit.jsonl` (Linux), or `%LOCALAPPDATA%\atc\logs\atc-audit.jsonl` (Windows). Attach recent lines from `atc-audit.jsonl`, `atc status --json`, and `atc status --forced` when reporting bugs or diagnosing multi-agent contention.

## Exit codes reference

| Exit code | Name | Meaning & next step |
|---|---|---|
| `0` | `OK` | Command succeeded (or hook allowed execution). |
| `1` | `EUSAGE / EINTERNAL` | Invalid CLI flag, unknown subcommand, physical device disconnected while leased, or tool failure (a failing tool's own exit code is passed through). Check `atc --help`. |
| `2` | `EBUSY` | All matching devices or slots are busy (`--wait 0`). |
| `3` | `ENOTFOUND / EFORBIDDEN` | No active (online) lease for this session, lease belongs to another session, or a policy refused the op. Claim a device first (`atc claim`). |
| `4` | `ETIMEDOUT` | Queue wait (`--wait`) or emulator/simulator boot (`bootTimeoutSec`) timed out. Check `atc status`. |
| `5` | `ERESOURCE_EXCEEDED` | Host available RAM or free disk space is below the safety reserve (`minFreeRamMb` / `minFreeDiskMb`). Free idle devices (`atc free --stop`). For device boots and snapshot saves only, ask the user before passing `--force` to `atc claim` / `atc snapshot`; builds are never forced past RAM admission. |
| `6` | `EPHYSICAL_FORBIDDEN` | Physical device claim rejected by policy (`allowPhysicalDevices`). Use an emulator/simulator or update `atc config`. |
| `7` | `EINVALID_OP` | Request rejected by validation; nothing ran. Read the listed problems and hints. |
| `124` | `ETIMEOUT_OP` | The op's `timeoutSec` elapsed and `atc` stopped it. |
