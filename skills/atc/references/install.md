# Installing and updating `atc`

Ask the user before installing global packages or modifying agent configuration.

## 1. Install the `atc` CLI

Requires Node.js 20 or newer (`node --version`) on macOS, Linux, or Windows:

```bash
npm install -g android-traffic-control
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

### Gemini CLI & Antigravity

Copy or symlink `skills/atc` into your skills directory (`~/.gemini/skills/atc` or `~/.agents/skills/atc`), and wire `atc hook pre-tool-use` / `atc hook stop` in your hook configuration.

### Cursor

Copy `.cursor/hooks.json` into your project's `.cursor/hooks.json` (or user Cursor hooks) and optionally enable the `atc mcp` server via `.mcp.json`.

### Pi

Load the Pi extension from `extensions/atc/index.ts`, which intercepts `tool_call` and `session_shutdown` events in-process and registers native `atc_*` tools.
