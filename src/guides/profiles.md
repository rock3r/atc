# atc profiles & fleet discovery guide

Guides: `workflow` · `profiles` (this page) · `snapshots` · `multi-agent` · `traps` (`atc guide <topic>`).

## 1. Three-tier fleet discovery

When you run `atc claim`, `atc` inspects the host outside `atc.lock` and picks a candidate in priority order:

| Tier | Candidate | Latency | What happens |
|---|---|---|---|
| `Tier 0` | Warm idle running emulator matching the profile | `< 20 ms` | Immediate in-memory lease assignment; no boot wait. |
| `Tier 1` | Offline local AVD in `~/.android/avd` (when a slot is free) | `5–60 s` | Reserves `state: "starting"`, boots the AVD outside the lock, waits for `sys.boot_completed=1`, then activates the lease. |
| `Tier 2` | Offline local AVD when slots are full (`autoStopIdleOnContention: true`) | `10–90 s` | Stops the oldest unlocked warm emulator first, then boots the requested offline AVD. |
| `Tier 3` | Creatable profile via `android emulator create` (`--create-if-missing`) | `30–180 s` | Creates a deterministic `atc_<type>_<api>_<services>_<abi>` AVD, then boots and leases it. |

## 2. Profile filter flags

Pass only the constraints your task requires so `atc` can reuse warm emulators whenever possible:

| Flag | Examples | Meaning |
|---|---|---|
| `--type <type>` | `phone`, `tablet`, `foldable`, `desktop`, `wear`, `xr`, `tv`, `automotive`, `resizable` | Form factor inferred from AVD `hw.device.name` and system image tags. A `resizable` AVD can satisfy `phone`, `foldable`, `tablet`, or `desktop`. |
| `--api <spec>` | `36`, `>=34`, `<=35`, `34..36` | Android SDK API level constraint. |
| `--play` / `--no-play` | `--play` | Require or exclude Google Play Store images. |
| `--services <svc>` | `play`, `google_apis`, `aosp` | Exact system image service tier. |
| `--abi <abi>` | `arm64-v8a`, `x86_64` | CPU ABI constraint. |
| `--avd <name>` | `--avd Pixel_9` | Pin to a specific AVD name. |
| `--serial <serial>` | `--serial emulator-5554` | Pin to a specific running emulator or physical device serial. |

Examples:

```bash
# Any modern Play Store phone (prefers an already-running warm emulator)
atc claim --type phone --api ">=34" --play

# Wear OS round watch on API 36
atc claim --type wear --api 36

# Create a tablet AVD automatically if none exists locally
atc claim --type tablet --api 36 --play --create-if-missing
```

## 3. Physical USB and Wi-Fi devices

Developers often keep a personal phone plugged into USB for charging or Wireless Debugging. To prevent agents from installing test APKs or clearing data on a personal phone:

- `atc claim` defaults to `--kind emulator`. Physical devices are never claimed by default.
- Physical devices do not consume host QEMU emulator slots (`maxRunningEmulators`).
- To claim a physical device explicitly when requested by the user:
  ```bash
  # By exact adb serial (from `atc status`)
  atc claim --serial adb-2A191FDH3007B7-WLccO7._adb-tls-connect._tcp

  # Or any connected physical device matching the API constraint
  atc claim --kind physical --api ">=35"
  ```
- When `allowPhysicalDevices` is set to `"never"` via `atc config set allowPhysicalDevices never`, `atc` rejects all physical device claims with exit code `6` (`EPHYSICAL_FORBIDDEN`).
