# Agent Traffic Control (`atc`)

Coordinate exclusive Android and iOS device leases across concurrent coding agents without a daemon.

- **User Guide (with diagrams & Q&A):** [`docs/user-guide.md`](./docs/user-guide.md)
- **Architecture:** [`docs/architecture.md`](./docs/architecture.md)
- **Design Specification:** [https://specs.sebastiano.dev/atc/](https://specs.sebastiano.dev/atc/) ([`DESIGN.md`](./DESIGN.md))
- **License:** Apache-2.0

## Overview

When two coding agents share a machine, they collide on Android emulators, iOS Simulators, and USB phones. `atc` serializes access through a user-private `state.json` file under an atomic directory lock (`atc.lock`) with `<20 ms` in-memory critical sections and zero npm dependencies.

Agents claim a device by hardware/OS profile, run `adb`, `./gradlew connected*`, `android` CLI, `xcrun simctl`, `xcrun devicectl`, or `xcodebuild` commands inside `atc exec` with a 15-second heartbeat, restore QEMU or APFS copy-on-write snapshots, and free the lease when done.

| Component | What it does |
|---|---|
| `atc` CLI | Discovers running, offline, and creatable Android & iOS devices; manages TTL leases (including dual-lease Kotlin Multiplatform / KMP sessions) and a 120-second warm-affinity wait queue; injects target flags in `atc exec`; and manages QEMU and APFS snapshots. |
| `atc` skill & hooks | Agent skill (`skills/atc/SKILL.md`) plus `PreToolUse` and `Stop` hooks (`hooks.json`, `hooks/hooks.json`, `com.github.copilot/hooks/hooks.json`, `.cursor/hooks.json`, `extensions/atc/index.ts`) that block unscoped device access and rewrite commands into `atc exec`. |
| `atc mcp` | Optional stdio JSON-RPC 2.0 MCP server (`atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, `atc_guide`). |

## Requirements and install

Requires Node.js >= 20 on macOS, Linux, or Windows, plus the Android SDK (`adb`, `emulator`, `android` CLI) and/or Xcode (`xcrun simctl`, `xcrun devicectl`) on macOS.

```bash
npm install -g @rock3r/atc
atc status
```

| Agent host | Optional plugin / hook setup |
|---|---|
| Claude Code | `/plugin marketplace add rock3r/atc` then `/plugin install atc@atc` |
| Codex | `codex plugin marketplace add rock3r/atc && codex plugin add atc@atc` |
| GitHub Copilot CLI / app | `copilot plugin marketplace add rock3r/atc && copilot plugin install atc@atc` |
| Antigravity | Symlink or copy package root into `~/.gemini/config/plugins/atc` (loads `plugin.json`, `skills/atc`, `hooks.json`, and `mcp_config.json`) |
| Gemini CLI | Copy `skills/atc` into `~/.gemini/skills/atc` and wire `atc hook pre-tool-use` + `atc hook stop` |
| Cursor | Copy `.cursor/hooks.json` into `.cursor/hooks.json` (and optional `.mcp.json`) |
| Pi | Load `extensions/atc/index.ts` |

## Quick start

```bash
atc status                                              # inspect RAM/disk, emu/sim slots, and fleet
atc guide                                               # read the workflow guide and rules

# Android emulator workflow
atc claim --type phone --api ">=35" --play --wait 300   # claim a warm or offline Play Store phone
atc exec -- adb shell getprop ro.product.model          # run adb pinned to leased serial + 15s heartbeat
atc exec -- android layout --pretty                     # inspect UI hierarchy (--device injected)
atc exec -- ./gradlew connectedDebugAndroidTest         # run tests without lease expiration
atc free                                                # release lease (leaves emulator warm)

# iOS Simulator workflow (macOS)
atc claim --ios --type phone --os ">=18.0" --wait 300   # claim a warm or offline iPhone Simulator
atc exec -- xcrun simctl launch booted com.example.app  # rewrites "booted" to your leased UDID
atc snapshot save clean_state                           # save APFS copy-on-write (cp -cR) clone
atc free
```

## Commands

| Command | What it does |
|---|---|
| `atc guide [topic]` | Built-in guides: `workflow` (default), `profiles`, `snapshots`, `multi-agent`, `traps` (`--json` supported). |
| `atc status [--ios\|--android] [--type <type>] [--api\|--os <spec>] [--json]` | Host RAM/disk capacity, `emu slots`, `sim slots`, `running` devices, `offline` AVDs/Simulators, `creatable` profiles, `leases`, and `queue`. |
| `atc claim [flags]` | Claim a lease by `--ios`/`--android`, `--type` (`phone`, `tablet`, `foldable`, `desktop`, `watch`/`wear`, `xr`, `tv`), `--api`/`--os`, `--play`/`--no-play`, `--avd`, `--udid`, or `--serial`. |
| `atc exec [--ios\|--android] [--serial <id>] -- <cmd> [args...]` | Run a command with target env/flags (`ANDROID_SERIAL`, `--device`, `ATC_IOS_UDID`, `booted` -> `<udid>`), process-group tracking, and a 15 s heartbeat. |
| `atc renew [<target>] [--ios\|--android] [--ttl <sec>]` | Extend an active lease's TTL expiration. |
| `atc snapshot <list\|save\|load\|delete> [<name>] [--ios\|--android]` | List, save, restore, or delete QEMU snapshots (Android) or APFS copy-on-write snapshots (iOS Simulator). |
| `atc free [<target>] [--ios\|--android] [--snapshot-save <name>] [--stop]` | Release one or all leases held by the caller session. |
| `atc config <get\|set> [key] [val]` | Read or update settings (`maxRunningEmulators`, `maxRunningSimulators`, `minFreeRamMb`, `allowPhysicalDevices`). |
| `atc gc` | Prune expired leases, dead anchor/worker PIDs, and stale queue tickets. |
| `atc guard [--format=json] <command>` | Check whether a shell command is allowed, blocked, or rewritten under `atc`. |
| `atc hook <pre-tool-use\|stop>` | Lifecycle hook handler for Claude Code, Codex, GitHub Copilot CLI, Gemini CLI, Antigravity, and Cursor. |
| `atc mcp` | Start the stdio MCP server (`atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, `atc_guide`). |

## Development

```bash
npm test
npm run check
```
