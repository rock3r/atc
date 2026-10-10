# atc snapshots, state resets & resource guardrails

Guides: `workflow` · `profiles` · `snapshots` (this page) · `multi-agent` · `traps` (`atc guide <topic>`).

## 1. Claiming a clean device state

When your test requires a known starting state on an emulator, pass reset flags to `atc claim`:

| Flag | What it does |
|---|---|
| `--snapshot-load <name>` | Restores QEMU snapshot `<name>` (for example `default_boot` or `clean_login`) before activating the lease. Prefers AVDs that already have that snapshot loaded or stored. |
| `--snapshot-save-on-free <name>` | Automatically saves snapshot `<name>` when `atc free` releases the lease. |
| `--wipe-data` | Stops the emulator if running, removes `userdata-qemu.img*` / `cache.img*`, and cold-boots a factory-fresh device. |
| `--cold` | Boots with `-no-snapshot-load` instead of restoring quickboot state. |
| `--reset-app <pkg>` | Runs `adb shell pm clear <pkg>` before handing the lease to your session. |

Example:

```bash
atc claim --type phone --api 36 --snapshot-load default_boot --reset-app com.example.app
```

## 2. Managing snapshots during an active lease

While holding an active emulator lease, use `atc snapshot`:

```bash
atc snapshot list                  # list snapshots on the leased AVD
atc snapshot save before_checkout  # save current RAM/disk state via `adb emu avd snapshot save`
atc snapshot load before_checkout  # rewind to saved state and wait for boot_completed=1
atc snapshot delete before_checkout
```

You can also save or restore a snapshot atomically when releasing a lease:

```bash
atc free --snapshot-save clean_state
atc free --snapshot-load default_boot
```

During `atc free --snapshot-save` or `atc free --stop`, `atc` transitions the lease to `state: "stopping"` under `atc.lock` before running `adb`, so no other agent can claim the emulator mid-save or mid-shutdown.

## 3. Host RAM and disk admission guardrails

Every QEMU emulator consumes guest RAM plus host hypervisor overhead (`qemuOverheadRamMb`, default `1024 MB`) and disk space for userdata/snapshots. Before booting an offline AVD, wiping data, or saving a snapshot, `atc` checks:

1. **RAM admission:** Projected available host RAM (accounting for other `"starting"` and recently activated emulators) must cover `ramSizeMb + qemuOverheadRamMb + minFreeRamMb` (default reserve `2048 MB`).
2. **Per-volume disk admission:** Free disk space on the AVD's filesystem volume (`statfsSync`, accounting for concurrent `"starting"` and `pendingSnapshotDiskMb` reservations on the same volume) must cover the required userdata/snapshot size plus `minFreeDiskMb` (default reserve `2048 MB`).

If either check fails, `atc` exits with code `5` (`ERESOURCE_EXCEEDED`). Free idle emulators with `atc free --stop` first; only pass `--force` if the user explicitly approves bypassing host resource limits.
