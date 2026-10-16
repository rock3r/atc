# atc profiles and device discovery guide

Run `atc guide <topic>` to read `workflow`, `profiles`, `snapshots`, `multi-agent`, or `traps`.

## 1. Three-tier fleet discovery

`atc claim` inspects the host outside `atc.lock`. It selects a device in this order:

| Tier | Candidate | Latency | What happens |
|---|---|---|---|
| `Tier 0` | Running idle Android emulator or booted iOS Simulator matching the profile | `< 20 ms` | `atc` assigns the lease in memory without waiting for boot. |
| `Tier 1` | Offline AVD in `~/.android/avd` or shutdown iOS Simulator, with a free slot | `3–60 s` | `atc` reserves `state: "starting"` and boots outside `atc.lock`. It waits for `sys.boot_completed=1` or `simctl bootstatus -b`, then activates the lease. |
| `Tier 2` | Offline AVD or Simulator when slots are full (`autoStopIdleOnContention: true`) | `10–90 s` | `atc` stops the oldest unlocked running device on that platform, then boots the requested device. |
| `Tier 3` | Creatable profile via `android emulator create` or `xcrun simctl create` (`--create-if-missing`) | `10–180 s` | `atc` creates an `atc_*` AVD or iOS Simulator with a deterministic name, then boots and leases it. |

## 2. Platform and profile filter flags

Pass the constraints the task requires. Fewer constraints let `atc` reuse more running virtual devices:

| Flag | Examples | Meaning |
|---|---|---|
| `--android` / `--ios` / `--platform <p>` | `--ios`, `--android` | Select Android or iOS. On macOS, `atc` also selects iOS automatically in directories with `.xcodeproj`, `.xcworkspace`, or `Package.swift` and no `build.gradle*`. |
| `--type <type>` | `phone`, `tablet`, `foldable`, `desktop`, `watch` (alias `wear`), `xr`, `tv`, `automotive`, `resizable` | Select a form factor on Android or iOS. `watch` and `wear` match Wear OS and watchOS. A `resizable` AVD satisfies `phone`, `foldable`, `tablet`, or `desktop`. |
| `--api <spec>` / `--os <spec>` | `36`, `>=34`, `18.4`, `>=18.0`, `17.0..18.4` | Select an Android SDK API level with `--api`. Select an iOS/watchOS/tvOS/visionOS version with `--os`. |
| `--play` / `--no-play` | `--play` | Require or exclude Google Play Store images (Android). |
| `--services <svc>` | `play`, `google_apis`, `aosp` | Require the exact Android system image service tier. |
| `--abi <abi>` | `arm64-v8a`, `x86_64` | Require a CPU application binary interface (ABI). |
| `--avd <name>` | `--avd Pixel_9`, `--avd "iPhone 16 Pro"` | Pin to a specific Android AVD name or iOS Simulator name. |
| `--udid <udid>` | `--udid D9746857-...` | Pin to an iOS Simulator UDID or physical iOS UDID / CoreDevice UUID. |
| `--serial <serial>` | `--serial emulator-5554` | Pin to a running emulator, simulator UDID, or physical device serial. |

```bash
# Any Play Store Android phone on API 35+ (prefers a warm emulator)
atc claim --type phone --api ">=35" --play

# iOS 18+ iPhone Simulator on macOS
atc claim --ios --type phone --os ">=18.0"

# Wear OS or watchOS watch
atc claim --android --type watch --api ">=35"
atc claim --ios --type watch --os ">=11.0"
```

## 3. Physical USB and Wi-Fi devices are opt-in

`atc claim` defaults to `--kind emulator`. Agents must request physical devices explicitly, including phones connected for charging or wireless debugging.

```bash
# Physical Android phone by adb serial (from `atc status`)
atc claim --serial adb-2A191FDH3007B7-SAhkP3._adb-tls-connect._tcp

# Physical iPhone/iPad by hardware UDID (from `atc status --ios`)
atc claim --ios --kind physical --udid 00008120-000464CE2E44C01E

# Block all physical device claims on this machine (exits with code 6)
atc config set allowPhysicalDevices never
```

| Event while leased | Virtual device (AVD / Simulator) | Physical device (Android / iPhone) |
|---|---|---|
| Device goes offline | `atc` reserves the device for `45 s` from `firstSeenOfflineAtMs`, capped by lease expiration. | `atc` allows a `15 s` grace period for brief disconnects. |
| Owner re-claims | `atc` reboots the device in place and preserves `expiresAtMs`. | `atc` exits `1`, records the disconnect, and asks the user to reconnect the cable. |
| Host slot usage | The device uses one slot (`maxRunningEmulators` or `maxRunningSimulators`). | The device uses `0` virtual slots. |
