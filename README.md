# Agent Traffic Control (`atc`)

`atc` gives coding agents exclusive Android and iOS device leases without a background daemon.

- **User Guide (with diagrams & Q&A):** [`docs/user-guide.md`](./docs/user-guide.md)
- **Architecture:** [`docs/architecture.md`](./docs/architecture.md)
- **Design Specification:** [https://specs.sebastiano.dev/atc/](https://specs.sebastiano.dev/atc/) ([`DESIGN.md`](./DESIGN.md))
- **License:** Apache-2.0

## Overview

Agents sharing a machine can install apps or stop devices that another agent is using. `atc` coordinates access through a user-private `state.json` file. An atomic directory lock (`atc.lock`) protects in-memory changes that take less than 20 ms. The package has no npm dependencies.

Agents claim devices by hardware and operating system (OS) profile. They run device commands through `atc exec`, which renews leases every 15 seconds. Supported commands include `adb`, `./gradlew connected*`, `android`, `xcrun simctl`, `xcrun devicectl`, and `xcodebuild`. Agents can restore QEMU or APFS copy-on-write snapshots before releasing their leases.

| Component | What it does |
|---|---|
| `atc` CLI | The CLI discovers running, offline, and creatable Android and iOS devices. It manages expiring leases, Kotlin Multiplatform (KMP) dual leases, a 120-second reorder window, command targets, and QEMU/APFS snapshots. |
| `atc` skill & hooks | `skills/atc/SKILL.md` defines the agent workflow. `PreToolUse` and `Stop` hooks block unscoped access and rewrite commands through `atc exec`. Adapters use `hooks.json`, `hooks/hooks.json`, `com.github.copilot/hooks/hooks.json`, `.cursor/hooks.json`, and `extensions/atc/index.ts`. |
| `atc mcp` | The optional Model Context Protocol (MCP) server uses stdio JSON-RPC 2.0. It exposes `atc_status`, `atc_claim`, `atc_renew`, `atc_snapshot`, `atc_free`, and `atc_guide`. |

## Requirements and install

Install Node.js >= 20 on macOS, Linux, or Windows. Android requires the Android SDK (`adb`, `emulator`, and `android` CLI). iOS requires Xcode (`xcrun simctl` and `xcrun devicectl`) on macOS.

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
