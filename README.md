# Android Traffic Control (`atc`)

Coordinate exclusive Android emulator (AVD) and physical USB/Wi-Fi device leases across concurrent coding agents and terminal sessions. You, or a coding agent working for you, claim a device by hardware/OS profile, run `adb`, `./gradlew connected*`, or `android` CLI commands through `atc exec`, save or restore QEMU snapshots, and release the lease when finished—without colliding on `ANDROID_SERIAL`, hijacking a personal USB phone, or thrashing host RAM.

- **Design Specification:** [https://specs.sebastiano.dev/atc/](https://specs.sebastiano.dev/atc/) ([`DESIGN.md`](./DESIGN.md))
- **User Guide:** [`docs/user-guide.md`](./docs/user-guide.md)
- **Architecture:** [`docs/architecture.md`](./docs/architecture.md)
- **License:** Apache-2.0

| Part | What it is |
|---|---|
| `atc` | A zero-dependency Node.js CLI for macOS, Linux, and Windows. It discovers running emulators, connected physical devices, offline AVDs, and creatable profiles; manages exclusive TTL leases and a bounded-window warm-affinity wait queue; runs commands with `ANDROID_SERIAL` and a background lease heartbeat; and controls QEMU snapshots. `atc guide` explains the workflow, profile flags, snapshots, multi-agent coordination, and common traps. |
| `atc` skill & hooks | A compact entry point for coding agents (`skills/atc/SKILL.md`) plus `PreToolUse` and `SessionEnd` hooks (`hooks/hooks.json`, `.cursor/hooks.json`, `extensions/atc/index.ts`) that block unscoped device access and rewrite commands into `atc exec`. Packaged as a Claude Code plugin, Codex plugin, and Agent Plugin. |
| `atc mcp` | An optional stdio MCP server (`atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, `atc_guide`) for agent hosts that prefer structured JSON-RPC tools over shell commands. |

`atc` requires no background daemon or native compilation. Every CLI call reads and updates a user-private `state.json` under an atomic directory lock (`atc.lock`) in under 20 ms, while slow emulator boots, snapshot loads, and command runs execute outside the lock.

## Requirements

- Node.js 20.0.0 or newer (`node --version`) on macOS, Linux, or Windows.
- Android SDK Platform-Tools (`adb`), Android Emulator (`emulator`), and/or the official `android` CLI (`~/.android/bin/android`) on `PATH` or under `ANDROID_HOME` / `ANDROID_SDK_ROOT`.

## Install

**1. Install `atc`.**

```bash
npm install -g @rock3r/atc
```

Then check your host capacity and discovered Android fleet:

```bash
atc status
```

**2. Optional: add the agent plugin.**

In Claude Code:

```text
/plugin marketplace add rock3r/atc
/plugin install atc@atc
```

In Codex:

```bash
codex plugin marketplace add rock3r/atc
codex plugin add atc@atc
```

Other agents:

- **Gemini CLI / Antigravity:** copy `skills/atc` into `~/.gemini/skills/atc` (or `~/.agents/skills/atc`) and configure `atc hook pre-tool-use` / `atc hook stop`.
- **Cursor:** copy `.cursor/hooks.json` into your project's `.cursor/hooks.json` and optionally add `.mcp.json`.
- **Pi:** load `extensions/atc/index.ts`.

## Try it

```bash
atc status                                              # inspect RAM/disk, running devices, offline AVDs, and leases
atc guide                                               # read the workflow guide and golden rules
atc claim --type phone --api ">=35" --play --wait 300   # claim a warm or offline Play Store phone emulator
atc exec -- adb shell getprop ro.product.model          # run adb pinned to the leased serial with a 15s heartbeat
atc exec -- android layout --pretty                     # inspect the live UI hierarchy (--device injected automatically)
atc exec -- ./gradlew connectedDebugAndroidTest         # run instrumentation tests without lease expiration
atc free                                                # release the lease (leaves the emulator warm for the next agent)
```

The [user guide](docs/user-guide.md) walks through profile matching, QEMU snapshots, multi-agent contention, physical USB/Wi-Fi device safety, and troubleshooting.

## Commands

| Command | What it does |
|---|---|
| `atc guide [topic]` | Built-in guides for humans and agents: `workflow` (default), `profiles`, `snapshots`, `multi-agent`, `traps` (`--json` supported) |
| `atc status [--type <type>] [--api <spec>] [--json]` | Host RAM/disk capacity, emulator slot usage, `running` devices, `offline` AVDs, `creatable` profiles, active `leases`, and `queue` |
| `atc claim [flags]` | Claim an exclusive lease by `--type`, `--api`, `--play`/`--no-play`, `--services`, `--abi`, `--avd`, or `--serial`, with `--snapshot-load`, `--wipe-data`, `--cold`, `--reset-app`, `--ttl`, and `--wait` |
| `atc exec [--serial <id>] -- <cmd> [args...]` | Run a command with `ANDROID_SERIAL=<serial>` (and `--device=<serial>` for `android` CLI), process-group tracking, and a 15-second lease heartbeat |
| `atc renew [<target>] [--ttl <sec>]` | Extend an active lease's TTL expiration |
| `atc snapshot <list\|save\|load\|delete> [<name>]` | List, save, restore, or delete QEMU snapshots on a leased emulator |
| `atc free [<target>] [--snapshot-save <name>] [--snapshot-load <name>] [--stop]` | Release one or all leases held by the caller session, optionally saving/loading a snapshot or stopping the emulator |
| `atc config <get\|set> [key] [val]` | Read or update persistent coordinator settings (`maxRunningEmulators`, `minFreeRamMb`, `minFreeDiskMb`, `reorderWindowSec`, `allowPhysicalDevices`, etc.) |
| `atc gc` | Prune expired leases, dead anchor/worker PIDs, stale queue tickets, and orphan temp files |
| `atc guard [--format=json] <command>` | Evaluate whether a shell command is safe, requires `atc exec` rewriting, or violates device/lifecycle guardrails |
| `atc hook <pre-tool-use\|stop>` | Agent lifecycle hook handler for Claude Code, Codex, Gemini CLI, Antigravity, and Cursor |
| `atc mcp` | Start the zero-dependency JSON-RPC stdio MCP server (`atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, `atc_guide`) |

## Documentation

- [User guide](docs/user-guide.md): installation, profile matching, QEMU snapshots, multi-agent coordination, physical device safety, and troubleshooting.
- [Architecture](docs/architecture.md): how the CLI, lock boundary, fleet discovery, warm-affinity queue, and hooks fit together, for contributors modifying the code.
- [Design specification](DESIGN.md): full formal specification ([live spec](https://specs.sebastiano.dev/atc/)).

## Development

```bash
npm test
npm run check
```

