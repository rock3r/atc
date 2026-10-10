# atc multi-agent coordination, queueing, hooks & MCP

Guides: `workflow` · `profiles` · `snapshots` · `multi-agent` (this page) · `traps` (`atc guide <topic>`).

## 1. Session identity ladder

Each agent tool call runs in a fresh subshell whose PID exits immediately. `atc` resolves your `sessionId` and long-lived host `anchorPid` in 0 ms using a 6-step ladder:

1. **Explicit flag or env:** `--session <id>`, `ATC_SESSION_ID`, or `--lease <lease_id>`.
2. **Hook / extension rewrite:** `PreToolUse` hooks prepend `ATC_SESSION_ID=<id> ATC_ANCHOR_PID=<pid>`.
3. **Host runtime env vars:** `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_TRACE_ID`, `CURSOR_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CLAUDE_SESSION_ID`.
4. **Hook PID breadcrumb map:** `state.hookSessions` matched by `process.ppid`, ancestor PID chain, or unique `cwd`.
5. **Stdio MCP server:** `atc mcp` keeps a persistent session `mcp-<pid>` for the lifetime of the server.
6. **Parent process fallback:** `TMUX_PANE`, `TERM_SESSION_ID`, or `ppid-<stableParentPid>`.

If the anchor process dies (`process.kill(anchorPid, 0)` fails) and no `atc exec` worker process group is alive, garbage collection reclaims the lease automatically.

## 2. Contention and the warm-affinity queue

When all matching devices or emulator slots are busy:

- With `--wait 0`, `atc claim` fails immediately with exit code `2` (`EBUSY`).
- With `--wait <sec>` (default `300`), `atc claim` enqueues a ticket in `state.queue`, prints its queue position, and updates `lastHeartbeatAtMs` once per second.
- **Bounded-window warm-affinity reordering (`reorderWindowSec = 120s`):** If an emulator becomes free and is already warm (`Tier 0`), a queued ticket that matches that warm emulator can jump ahead of an earlier cold-boot/eviction ticket—provided the earlier ticket has waited less than `120s`.
- **Starvation protection:** Once a ticket waits past `starvationDeadlineMs` (`enqueuedAtMs + 120s`), it freezes at Priority #0. No newer ticket can jump ahead of it, and `atc` evicts an unlocked warm emulator to boot the waiting ticket's required AVD.

## 3. Guardrails and agent hooks

`atc guard <command>` and `atc hook pre-tool-use` inspect shell commands before execution:

- **Non-Android commands** (`git`, `ls`, `npm test`, `./gradlew assembleDebug`) hit a `<2 ms` zero-lock fast path and run untouched.
- **Direct lifecycle commands** (`emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `adb disconnect`) are blocked with exit code `2`.
- **Device commands** (`adb shell`, `adb install`, `./gradlew connectedDebugAndroidTest`, `android layout`):
  - Blocked if the session holds no active lease.
  - Blocked if targeting another session's `-s <serial>` or `--device=<serial>`.
  - Rewritten automatically (in Claude Code, Gemini CLI, Antigravity, and Pi) to run under `ATC_SESSION_ID=<id> atc exec --serial <serial> -- ...` so the lease heartbeat stays attached.
- **`atc hook stop` (`SessionEnd`):** Automatically frees active leases held by the ending session (or defers release via `releaseOnWorkerExit` if an `atc exec` worker is still finishing).

## 4. Stdio MCP server (`atc mcp`)

Agents that prefer structured MCP tools over shell commands can start `atc mcp` (or load `.mcp.json`). It exposes six zero-dependency JSON-RPC tools over stdio:

- `atc_status`: Fleet capacity, running/offline/creatable devices, active leases, and queue.
- `atc_claim`: Claim a device lease by profile, AVD, or serial.
- `atc_renew`: Extend an active lease TTL.
- `atc_snapshot`: `list`, `save`, `load`, or `delete` emulator snapshots.
- `atc_free`: Release a lease (with optional `snapshotSave`, `snapshotLoad`, or `stop`).
- `atc_guide`: Read built-in workflow and troubleshooting guides (`workflow`, `profiles`, `snapshots`, `multi-agent`, `traps`).
