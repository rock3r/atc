# atc traps & troubleshooting

Guides: `workflow` · `profiles` · `snapshots` · `multi-agent` · `traps` (this page) (`atc guide <topic>`).

## Common Android & multi-agent traps

| Trap | Symptom | Why it happens | Fix with `atc` |
|---|---|---|---|
| Unscoped `adb` or Gradle test command | `adb: more than one device/emulator` | A second emulator booted or a USB phone is connected, and `ANDROID_SERIAL` is unset. | Always run device commands via `atc exec -- <cmd>`. |
| Personal phone hijacked during tests | Test APK installs or clears data on a developer's USB phone. | `adb install` or `./gradlew connectedCheck` targets all or the only connected USB device. | `atc claim` defaults to `--kind emulator`; `atc guard` blocks unscoped `adb` and unleased serials. |
| Lease expires during a long Gradle build | Another session steals the emulator mid-run. | Static TTL expired because `adb`/`gradlew` was run directly without a worker heartbeat. | Run via `atc exec -- ./gradlew ...` so `atc` registers `workerPgids` and renews the lease every 15 s. |
| Shell loop or `$VAR` breaks across rewrite | `for apk in *.apk; do adb install "$apk"; done` loses `$apk` if split naively. | Subshells inside `atc exec` cannot see unexported variables assigned in a separate process. | Run `atc exec -- sh -c 'for apk in *.apk; do adb install "$apk"; done'` or let `atc hook pre-tool-use` rewrite the loop body in place. |
| Cursor hook blocks raw `adb` even with a lease | `Cursor hooks cannot rewrite commands to attach a lease heartbeat.` | Cursor's `beforeShellExecution` hook protocol only supports allow/deny, not command rewriting. | Prefix device commands explicitly with `atc exec -- <cmd>` when running in Cursor. |
| Ambiguous session in shared repo (`cwd`) | `Multiple active agent sessions detected in <cwd>; pass --session <id>` | Two agents run in the same directory without exporting a session env var, and neither is an ancestor PID. | Pass `--session <unique-id>` or export `ATC_SESSION_ID=<unique-id>`. |
| Offline AVD counts as a used slot (`slots: 1/2 used`) | `atc status --json` shows `"hasLockFiles": true` on an offline AVD. | A previous QEMU process crashed or was `SIGKILL`ed, leaving `hardware-qemu.ini.lock` or `snapshot.lock` in `~/.android/avd/<Name>.avd`. | Verify no `qemu-system` process is running for that AVD, then remove the stale `*.lock` files from `~/.android/avd/<Name>.avd/`. |
| Cold-boot thrashing between agents | Agent A wants API 35, Agent B wants API 36, Agent C wants API 35; emulators keep stopping and booting. | Strict FIFO queue forces an eviction on every turn switch. | Use `atc claim --wait 300`; warm-affinity reordering (`reorderWindowSec = 120s`) batches Agent C onto the already-warm API 35 emulator before evicting it for Agent B. |

## Exit codes reference

| Exit code | Name | Meaning & next step |
|---|---|---|
| `0` | `OK` | Command succeeded (or hook allowed execution). |
| `1` | `EUSAGE / EINTERNAL` | Invalid CLI flag, unknown subcommand, or unexpected tool failure. Check `atc --help`. |
| `2` | `EBUSY / EGUARD_BLOCKED` | All matching devices are busy (`--wait 0`) or `atc guard` / `atc hook` blocked an unsafe command. |
| `3` | `ENOTFOUND / EFORBIDDEN` | No active lease for this session, or lease belongs to another session. Claim a device first (`atc claim`). |
| `4` | `ETIMEDOUT` | Queue wait (`--wait`) or emulator boot (`bootTimeoutSec`) timed out. Check `atc status`. |
| `5` | `ERESOURCE_EXCEEDED` | Host available RAM or free disk space is below the safety reserve (`minFreeRamMb` / `minFreeDiskMb`). Free idle emulators (`atc free --stop`) or ask the user before passing `--force`. |
| `6` | `EPHYSICAL_FORBIDDEN` | Physical device claim rejected by policy (`allowPhysicalDevices`). Use an emulator or update `atc config`. |
