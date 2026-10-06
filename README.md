# Android Traffic Control (ATC)

**Android Traffic Control (`atc`)** coordinates exclusive Android Virtual Device (AVD) and physical USB/Wi-Fi device leases across concurrent AI coding agents and developer terminal sessions.

- **Design Specification:** [https://specs.sebastiano.dev/atc/](https://specs.sebastiano.dev/atc/) ([`DESIGN.md`](./DESIGN.md))
- **License:** Apache-2.0

## Why ATC?

When multiple AI coding agents (Codex, Pi, Cursor, Antigravity, Gemini CLI, Claude Code) or terminal sessions work concurrently on the same host machine, they collide on Android emulators and connected physical devices:

1. **Mid-task collision:** One agent installs an APK, clears app data, or stops an emulator while another is inspecting a UI tree (`android layout`) or running instrumentation tests.
2. **Multi-device ambiguity & personal-phone hazard:** Commands without `ANDROID_SERIAL` or `--device=<serial>` fail when multiple devices are connected or accidentally install test APKs onto a developer's personal USB phone.
3. **Host resource exhaustion & cold-boot thrashing:** Launching every offline AVD concurrently exhausts host RAM/disk, while strict FIFO ordering between different device profiles repeatedly stops and cold-boots emulators back-to-back.
4. **Orphaned locks:** Crashed or finished agent turns leave devices locked indefinitely.

## Key Features

- **Profile-Based Leases & 3-Tier Fleet Discovery:** Claim devices by `--type <phone|tablet|foldable|desktop|wear|xr|tv|automotive|resizable>`, `--api <36|>=34|34..36>`, `--play` / `--no-play` / `--services <play|google_apis|aosp>`, and `--abi`. `atc status` reports `running`, `offline`, and `creatable` profiles.
- **Bounded-Window Warm-Affinity Queue (`reorderWindowSec = 120s`):** Batches queued jobs that match an already-running emulator (`Tier 0`) ahead of cold-eviction jobs (`Tier 2`) within a 120-second fairness window, then freezes waiting tickets at Priority #0 so niche configs never starve.
- **QEMU Snapshots & State Reset:** Supports `--snapshot-load <name>`, `--snapshot-save-on-free <name>`, `--wipe-data`, `--cold`, `--reset-app <pkg>`, and `atc snapshot <list|save|load|delete>`.
- **Host RAM & Disk Admission Guardrails:** Enforces a configurable concurrent emulator cap (default `2`, or `"auto"`) plus pre-flight RAM and disk checks (exit code `5` `ERESOURCE_EXCEEDED`, bypassable via `--force`).
- **Physical Device Safety:** Default claims target emulators (`--kind emulator`) so personal USB phones are never hijacked; physical devices can be claimed explicitly via `--serial <id>` or `--kind physical|any`.
- **Multi-Agent Guardrails & Stdio MCP:** Ships with a universal skill (`skills/atc/SKILL.md`), Pi extension (`extensions/atc/index.ts`), `PreToolUse` / `Stop` hooks (`atc hook`), and an optional zero-dependency Stdio MCP server (`atc mcp`).

## Quick Start

```bash
# Inspect fleet capacity, running/offline/creatable devices, and active leases
atc status --type phone --api ">=35" --play

# Claim a phone emulator (or restore a clean snapshot)
atc claim --type phone --api ">=35" --play --snapshot-load default_boot --ttl 600

# Run commands pinned to the leased device with automatic lease heartbeat
atc exec -- android layout --pretty
atc exec -- ./gradlew connectedDebugAndroidTest

# Release the lease (keeping the emulator warm for the next queued agent)
atc free
```
