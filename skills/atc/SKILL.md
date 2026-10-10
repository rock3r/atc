---
name: atc
description: Coordinate exclusive Android emulator (AVD) and physical USB/Wi-Fi device leases across concurrent coding agents with the `atc` CLI — profile-based claims, QEMU snapshots, bounded-window warm-affinity queueing, and `atc exec` lease heartbeats. Use before running `adb`, `./gradlew connected*`, `android layout`, or any Android device/emulator command.
license: Apache-2.0
compatibility: Needs Node.js >= 20 on macOS, Linux, or Windows, and the Android SDK (`adb`, `emulator`, and/or the official `android` CLI) for live fleet discovery.
metadata:
  version: "1.0.0"
  author: "Sebastiano Poggi"
---

# Android Traffic Control (`atc`)

The `atc` CLI coordinates Android emulators and physical test devices and carries its own built-in guides. This skill gets you started.

1. Run `atc status`.
   - `atc: command not found`: ask the user, then install it as [references/install.md](references/install.md) says (`npm install -g @rock3r/atc`).
   - Check `Host Capacity` (`slots: X/Y used`, available RAM, free disk), `Running` devices, `Offline` AVDs, and active `Leases` / `Queue`.
2. Run `atc guide` and follow it. It covers the claim-exec-free workflow, rules, and a done checklist.
   - Read `atc guide profiles` when choosing `--type`, `--api`, `--play`/`--no-play`, or claiming a physical USB/Wi-Fi phone (`--serial <id>` / `--kind physical`).
   - Read `atc guide snapshots` before restoring/saving QEMU snapshots (`--snapshot-load`, `atc snapshot`), wiping data (`--wipe-data`), or handling exit code `5` (`ERESOURCE_EXCEEDED`).
   - Read `atc guide multi-agent` when waiting in the queue (`--wait`), passing `--session <id>`, or using `atc mcp`.
   - Read `atc guide traps` when diagnosing `more than one device/emulator`, shell loop variable expansion, or stale `.avd/*.lock` files.
3. Claim a device before running any Android command:
   ```bash
   atc claim --type phone --api ">=35" --play --wait 300
   ```
   Never start, boot, stop, or wipe an emulator directly (`emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`). Default claims target emulators (`--kind emulator`) so you never hijack a developer's personal USB phone unless explicitly asked.
4. Run every device or instrumentation command through `atc exec`:
   ```bash
   atc exec -- adb shell getprop ro.product.model
   atc exec -- android layout --pretty
   atc exec -- ./gradlew connectedDebugAndroidTest
   ```
   `atc exec` injects `ANDROID_SERIAL=<serial>` and `--device=<serial>`, tracks the worker process group, and renews the lease every 15 seconds while the command runs.
5. Free the lease as soon as your task finishes:
   ```bash
   atc free
   ```
   Leaving the emulator warm lets the next queued agent claim it in under 20 ms (`Tier 0`). Pass `atc free --stop` only when shutting down a specialized cold-booted AVD that other sessions will not reuse.
