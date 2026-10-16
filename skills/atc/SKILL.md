---
name: atc
description: Coordinate builds (Gradle, Bazel, Xcode) and exclusive Android (AVD & physical adb) and iOS/watchOS/tvOS/visionOS (Simulator & physical) device leases across concurrent coding agents with the `atc` CLI — profile-based claims, typed build/device operations (`atc exec <system> <op>`, `atc batch`, `atc_*` MCP tools), build slots and workspace locks, QEMU & APFS snapshots, KMP dual leases, and warm-affinity queueing. Use instead of running `./gradlew`, `bazel`, `xcodebuild`, `adb`, `xcrun simctl`, or any mobile device/emulator/simulator command directly.
license: Apache-2.0
compatibility: Needs Node.js >= 20 on macOS, Linux, or Windows, plus the Android SDK (`adb`, `emulator`, `android` CLI) and/or Xcode (`xcrun simctl`, `xcodebuild`) on macOS.
metadata:
  version: "3.0.0"
  author: "Sebastiano Poggi"
---

# Agent Traffic Control (`atc`)

The `atc` CLI coordinates builds, Android emulators, iOS Simulators, and physical test devices across concurrent agents, and carries its own built-in guides. You never give `atc` a shell command: you request **typed operations**, and `atc` validates them, builds the exact command, and runs it under the right lease, build slot, and workspace lock. This skill gets you started.

1. Run `atc status`.
   - `atc: command not found`: ask the user, then install it as [references/install.md](references/install.md) says (`npm install -g @rock3r/atc`).
   - Check `Host Capacity` (`emu slots`, `sim slots`, `build slots`, available RAM, free disk), `Running` devices, `Offline` AVDs/Simulators, and active `Leases` / `Builds` / `Queue`.
2. Run `atc guide` and follow it, and `atc exec --help` for the operation catalog.
   - Read `atc guide profiles` when choosing `--ios`/`--android`, `--type` (`phone`, `tablet`, `foldable`, `desktop`, `watch`/`wear`, `xr`, `tv`), `--api`/`--os`, `--play`/`--no-play`, or claiming a physical phone (`--serial <id>`, `--udid <id>`, or `--kind physical`).
   - Read `atc guide snapshots` before restoring/saving snapshots, wiping data (`--wipe-data`), resetting app state (`--reset-app`), or handling exit code `5` (`ERESOURCE_EXCEEDED`).
   - Read `atc guide multi-agent` for queueing, build/device co-scheduling, KMP dual leases, sessions, hooks, and `atc mcp`.
   - Read `atc guide traps` when a request is rejected (exit `7`) or when diagnosing device collisions and crashes.
3. Build through `atc` (no device needed for pure builds):
   ```bash
   atc exec gradle tasks :app:assembleDebug :app:assembleDebugAndroidTest --brief
   atc exec bazel build //app:main
   atc exec xcode build-for-testing --scheme App --project App.xcodeproj
   ```
4. Claim a device only for the steps that need it:
   ```bash
   atc claim --type phone --api ">=35" --play --wait 300   # Android emulator
   atc claim --ios --type phone --os ">=18.0" --wait 300   # iOS Simulator (macOS)
   ```
   Never start, boot, stop, or wipe an emulator/simulator directly, and never stop shared build daemons (`./gradlew --stop`, `bazel shutdown`). Default claims target virtual devices (`--kind emulator`) so you never hijack a developer's personal phone unless explicitly asked.
5. Run device work as typed operations against your lease:
   ```bash
   atc exec android install app/build/outputs/apk/debug/app-debug.apk --replace
   atc exec android launch --package com.example.app --activity .MainActivity
   atc exec gradle tasks :app:connectedDebugAndroidTest
   atc exec android screenshot out/screen.png
   atc exec ios launch com.example.App
   ```
   For anything with several steps, `cwd`/`env`, claims, or timeouts, write an `atc batch` plan and run `atc batch --file plan.json --validate` first. If a request is rejected (exit `7`), read every listed problem; `--force --reason "<why>"` only overrides build-value patterns and makes you responsible for the run. Missing operations can be requested at https://github.com/rock3r/atc/issues.
6. Free the lease as soon as your task finishes:
   ```bash
   atc free
   ```
   Leaving the emulator or simulator warm lets the next queued agent claim it in under 20 ms (`Tier 0`). Pass `atc free --stop` only when shutting down a specialized cold-booted device that other sessions will not reuse.
