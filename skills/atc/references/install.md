# Installing and updating `atc`

Ask the user before installing global packages or modifying agent configuration.

## 1. Install the `atc` CLI

Requires Node.js 20 or newer (`node --version`) on macOS, Linux, or Windows:

```bash
npm install -g @rock3r/atc
```

Or install directly from a local checkout:

```bash
npm install -g /path/to/atc
```

Verify the CLI and inspect your Android fleet:

```bash
atc --help
atc status
atc guide
```

## 2. Install the Agent Plugin (Skills + Guardrail Hooks)

### Claude Code

Add the marketplace and install the `atc` plugin (installs both the `atc` skill and the `PreToolUse` / `SessionEnd` hooks):

```text
/plugin marketplace add rock3r/atc
/plugin install atc@atc
```

### Codex

Add the marketplace and install the `atc` plugin:

```bash
codex plugin marketplace add rock3r/atc
codex plugin add atc@atc
```

### GitHub Copilot CLI & Copilot app

Add the marketplace and install the `atc` plugin (the root `plugin.json` is an Agent Plugins 1.0 manifest; Copilot loads the skill from `skills/atc/`, the `preToolUse` / `sessionEnd` hooks from `com.github.copilot/hooks/hooks.json`, and the `atc mcp` server from `mcp.json`):

```bash
copilot plugin marketplace add rock3r/atc
copilot plugin install atc@atc
```

To test a local checkout, pass its path to `copilot plugin marketplace add` instead. Run `copilot plugin marketplace update` and reinstall after updating, because Copilot caches plugin components. The hooks locate the globally installed `atc` CLI, so step 1 is required.

Copilot fires `sessionEnd` with `reason: "complete"` after every agent turn, so `atc` keeps the lease on that reason and releases it only on a terminal reason (`user_exit`, `abort`, `error`, `timeout`). Archiving a Copilot app session sends no hook event; its lease is reclaimed by TTL expiry (`defaultTtlSec`, 600 s by default), or run `atc free` before closing. Quitting the Copilot app releases its leases on the next `atc` invocation (dead-anchor GC). Long-running `atc exec` commands are never cut off by the TTL, because the worker heartbeat keeps the lease alive.

### VS Code (GitHub Copilot agent mode)

Experimental: VS Code hooks are in Preview. VS Code can load Claude-format plugins (`.claude-plugin/plugin.json` + `hooks/hooks.json`), or you can enable `chat.useClaudeHooks` and wire `atc hook pre-tool-use` / `atc hook stop` in `.claude/settings.json`.

### Antigravity

Copy or symlink the `atc` package/repository root into `~/.gemini/config/plugins/atc` (or register its `plugin.json` path in `~/.gemini/plugins.json`). Antigravity automatically loads `plugin.json`, the `skills/atc/SKILL.md` skill, the `PreToolUse` / `Stop` session hooks in `hooks.json`, and the `atc mcp` server in `mcp_config.json`:

```bash
mkdir -p ~/.gemini/config/plugins
ln -s "$(npm root -g)/@rock3r/atc" ~/.gemini/config/plugins/atc
```

### Gemini CLI

Copy or symlink `skills/atc` into your skills directory (`~/.gemini/skills/atc` or `~/.agents/skills/atc`), and wire `atc hook pre-tool-use` / `atc hook stop` in your hook configuration.

### Cursor

Copy `.cursor/hooks.json` into your project's `.cursor/hooks.json` (or user Cursor hooks) and optionally enable the `atc mcp` server via `.mcp.json`.

### Pi

Load the Pi extension from `extensions/atc/index.ts`, which intercepts `tool_call` and `session_shutdown` events in-process and registers native `atc_*` tools.
