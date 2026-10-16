# Installing and updating `atc`

Ask the user before installing global packages or modifying agent configuration.

## 1. Install the `atc` CLI

Install Node.js 20 or newer on macOS, Linux, or Windows. Check the version with `node --version`.

```bash
npm install -g @rock3r/atc
```

To install a local checkout, use its path:

```bash
npm install -g /path/to/atc
```

Check that the CLI runs and lists devices:

```bash
atc --help
atc status
atc guide
```

## 2. Install the agent plugin and hooks

### Claude Code

Add the marketplace and install the plugin. Claude Code loads the `atc` skill and the `PreToolUse` / `SessionEnd` hooks:

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

Add the marketplace and install the plugin. The root `plugin.json` uses Agent Plugins 1.0. Copilot loads `skills/atc/`, the `preToolUse` / `sessionEnd` hooks in `com.github.copilot/hooks/hooks.json`, and the `atc mcp` server in `mcp.json`:

```bash
copilot plugin marketplace add rock3r/atc
copilot plugin install atc@atc
```

To test a local checkout, pass its path to `copilot plugin marketplace add`. Copilot caches plugin components. After an update, run `copilot plugin marketplace update` and reinstall. Complete step 1 first because the hooks use the globally installed CLI.

Copilot sends `sessionEnd` with `reason: "complete"` after each agent turn. `atc` keeps the lease for this reason. It releases leases for terminal reasons: `user_exit`, `abort`, `error`, and `timeout`.

Archiving a Copilot app session sends no hook event. Its lease expires after its time to live (TTL), controlled by `defaultTtlSec` (600 seconds by default). Run `atc free` before closing to release it immediately. After the app quits, the next `atc` command reclaims leases whose anchor process has died. Worker heartbeats keep leases alive during long-running `atc exec` commands.

### VS Code (GitHub Copilot agent mode)

VS Code hooks are experimental and in Preview. VS Code can load Claude-format plugins (`.claude-plugin/plugin.json` and `hooks/hooks.json`). Another option is to enable `chat.useClaudeHooks` and configure `atc hook pre-tool-use` / `atc hook stop` in `.claude/settings.json`.

### Antigravity

Copy or symlink the package or repository root into `~/.gemini/config/plugins/atc`. Another option is to register its `plugin.json` path in `~/.gemini/plugins.json`. Antigravity loads `plugin.json`, `skills/atc/SKILL.md`, the `PreToolUse` / `Stop` session hooks in `hooks.json`, and the `atc mcp` server in `mcp_config.json`:

```bash
mkdir -p ~/.gemini/config/plugins
ln -s "$(npm root -g)/@rock3r/atc" ~/.gemini/config/plugins/atc
```

### Gemini CLI

Copy or symlink `skills/atc` to `~/.gemini/skills/atc` or `~/.agents/skills/atc`. Configure `atc hook pre-tool-use` / `atc hook stop` in the host's hook settings.

### Cursor

Copy `.cursor/hooks.json` into your project's `.cursor/hooks.json` (or user Cursor hooks) and optionally enable the `atc mcp` server via `.mcp.json`.

### Pi

Load `extensions/atc/index.ts`. The Pi extension listens for `session_shutdown` and `session_end` events and runs `atc free` to release the session's leases when Pi exits.
