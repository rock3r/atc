# atc multi-agent coordination guide

Run `atc guide <topic>` to read `workflow`, `profiles`, `snapshots`, `multi-agent`, or `traps`.

## 1. Resolve the session identity in six steps

`atc` coordinates agents through `state.json`. The `atc.lock` directory serializes changes with a hold time below 20 ms. Host hooks (`PreToolUse` / `Stop`) check commands and release leases.

Each agent tool call runs in a new subshell that exits after the call. `atc` resolves `sessionId` and the host's long-lived `anchorPid` through these sources, in order:

| Priority | Source | What `atc` inspects |
|---|---|---|
| `1` | Explicit flag or env | `--session <id>`, `ATC_SESSION_ID`, or `--lease <lease_id>` |
| `2` | Hook / extension rewrite | `ATC_SESSION_ID=<id> ATC_ANCHOR_PID=<pid>` prepended by `PreToolUse` |
| `3` | Host runtime env vars | `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_TRACE_ID`, `CURSOR_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CLAUDE_SESSION_ID` |
| `4` | Hook process records | `state.hookSessions` matched by `process.ppid`, ancestor PID chain, or unique `cwd` |
| `5` | Stdio MCP server | `mcp-<pid>` persisted for the lifetime of `atc mcp` |
| `6` | Parent process fallback | `TMUX_PANE`, `TERM_SESSION_ID`, or `ppid-<stableParentPid>` |

The next `atc` command reclaims a lease when `process.kill(anchorPid, 0)` fails and no registered worker process group (`workerPgids`) remains alive.

## 2. Contention and the 120-second warm-affinity queue

When matching devices or platform slots are busy, `atc claim --wait 0` exits immediately with code `2`. With `--wait <sec>`, `atc` adds a ticket to `state.queue` and updates `lastHeartbeatAtMs` every second. The default wait is `300` seconds. Android uses `maxRunningEmulators`; iOS uses `maxRunningSimulators`.

| Queue rule | Window / trigger | Behavior |
|---|---|---|
| Reorder for a running device (`canJumpAhead`) | Earlier ticket has waited `< 120 s` (`reorderWindowSec`) | `atc` can serve a ticket matching a running idle device (`Tier 0`) before a cold-boot or eviction ticket. The claim takes `< 20 ms`. |
| Starvation protection (`isTicketStarvationProtected`) | Ticket waits `>= 120 s` (`starvationDeadlineMs`) | `atc` reserves competing resources for the earlier ticket. It can stop an unlocked warm device to boot the requested profile. Later tickets can still use unrelated resources. |

## 3. Hooks check commands and select platform leases

`atc guard <command>` and `atc hook pre-tool-use` inspect shell commands before execution:

| Command category | Examples | Guard & hook action |
|---|---|---|
| Non-device commands | `git status`, `npm test`, `./gradlew assembleDebug` | The guard allows the unchanged command in `< 2 ms` without acquiring the lock. |
| Direct lifecycle commands | `emulator -avd`, `android emulator start`, `adb emu kill`, `adb kill-server`, `xcrun simctl boot\|shutdown\|erase\|delete` | The guard blocks the command (`exit 2`) and directs the agent to `atc claim` / `atc free`. |
| Unleased or cross-session device commands | `adb shell`, `xcrun simctl launch`, `xcodebuild test` without a matching lease | The guard blocks the command (`exit 2`). |
| Leased device & KMP compound commands | `adb install a.apk && xcrun simctl install booted b.app` | Claude Code, Gemini CLI, Antigravity, and Pi rewrite each segment through `ATC_SESSION_ID=<id> atc exec --serial <platform-serial> -- ...`. |
| Session end (`atc hook stop`) | Agent turn finishes | The hook frees active session leases. If an `atc exec` worker still runs, it sets `releaseOnWorkerExit`. |

## 4. Stdio MCP server (`atc mcp`)

Agents can run `atc mcp` or load `.mcp.json` to use Model Context Protocol (MCP) tools over JSON-RPC:

| Tool | Purpose |
|---|---|
| `atc_status` | The tool reports capacity (`emu slots`, `sim slots`), running/offline/creatable devices, active leases, and the queue. |
| `atc_claim` | The tool claims an Android or iOS lease using `ios`, `android`, `type`, `api`, `os`, `udid`, `avd`, or `serial`. |
| `atc_renew` | The tool extends an active lease's time to live (TTL). It accepts an `ios` / `android` filter for KMP sessions. |
| `atc_snapshot` | The tool can `list`, `save`, `load`, or `delete` QEMU or APFS snapshots. It accepts an `ios` / `android` filter. |
| `atc_free` | The tool releases a lease. It accepts `ios` / `android`, `snapshotSave`, `snapshotLoad`, and `stop`. |
| `atc_guide` | The tool returns a built-in guide: `workflow`, `profiles`, `snapshots`, `multi-agent`, or `traps`. |
