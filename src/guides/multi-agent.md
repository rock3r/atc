# atc multi-agent coordination, queueing, hooks & MCP

Guides: `workflow` · `profiles` · `snapshots` · `multi-agent` (this page) · `traps` (`atc guide <topic>`).

## 1. Cooperative coordination and the 6-step session identity ladder

`atc` coordinates concurrent agents through a lock-serialized `state.json` (`atc.lock`, `<20 ms` hold time) and enforces guardrails through host hooks (`PreToolUse` / `Stop`).

Each agent tool call runs in a fresh subshell whose PID exits right away. `atc` resolves your `sessionId` and long-lived host `anchorPid` in 0 ms using a 6-step ladder:

| Priority | Source | What `atc` inspects |
|---|---|---|
| `1` | Explicit flag or env | `--session <id>`, `ATC_SESSION_ID`, or `--lease <lease_id>` |
| `2` | Hook / extension rewrite | `ATC_SESSION_ID=<id> ATC_ANCHOR_PID=<pid>` prepended by `PreToolUse` |
| `3` | Host runtime env vars | `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_TRACE_ID`, `CURSOR_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CLAUDE_SESSION_ID` |
| `4` | Hook PID breadcrumb map | `state.hookSessions` matched by `process.ppid`, ancestor PID chain, or unique `cwd` |
| `5` | Stdio MCP server | `mcp-<pid>` persisted for the lifetime of `atc mcp` |
| `6` | Parent process fallback | `TMUX_PANE`, `TERM_SESSION_ID`, or `ppid-<stableParentPid>` |

If an agent exits or crashes without calling `atc free` (`process.kill(anchorPid, 0)` fails) and no `atc exec` worker process group (`workerPgids`) is alive, the next `atc` command reclaims the orphan lease automatically.

## 2. Contention and the 120-second warm-affinity queue

When all matching devices or platform slots (`maxRunningEmulators` on Android, `maxRunningSimulators` on iOS) are busy, `atc claim` either fails immediately (`--wait 0`, exit code `2`) or enqueues a ticket in `state.queue` (`--wait <sec>`, default `300`) and updates `lastHeartbeatAtMs` every second.

| Queue rule | Window / trigger | Behavior |
|---|---|---|
| Warm-affinity jump (`canJumpAhead`) | Earlier ticket has waited `< 120 s` (`reorderWindowSec`) | A queued ticket matching an already-warm (`Tier 0`) device jumps ahead of a cold-boot/eviction ticket and starts in `< 20 ms`. |
| Starvation freeze (`isTicketStarvationProtected`) | Ticket waits `>= 120 s` (`starvationDeadlineMs`) | Ticket freezes at Priority #0. No newer ticket can jump ahead of it; `atc` stops an unlocked warm device and boots the waiting ticket's profile. |

## 3. Build + device co-scheduling (`atc exec --build` & `atc exec --claim`)

`atc` prevents cross-starvation between heavy builds (`gradle`/`./gradlew`, `bazel`/`bazelisk`/`./bazelw`, `xcodebuild`) and device leases via `state.buildLeases` and `state.buildQueue`:

| Tier | Caller profile | Slot ceiling | Co-scheduling guarantee |
|---|---|---|---|
| `Tier 0` | Starved build ticket waiting `>= 120 s` (`buildReorderWindowSec`) | Base + Burst (`2 + 1 = 3`) | Bounds maximum queue wait so pure builds never starve indefinitely. |
| `Tier 1` | Holds an active device lease or runs `atc exec --claim "<flags>" -- <cmd>` | Base + Burst (`2 + 1 = 3`) | Jumps ahead of `< 120 s` pure builds and uses the burst slot so leased devices never sit idle waiting to compile. Cold-boot `--claim` runs reserve a `"preparing_device"` build slot before booting. |
| `Tier 2` | Pure CPU build (`atc exec --build -- ./gradlew assembleDebug`) | Base (`maxConcurrentBuilds = 2`) | Serializes colliding `workspaceKeys` (`gradle:<root>`, `bazel:ws:<root>`, `xcode:<dir>`) and holds a `2.5 s` `"draining"` cooldown after exit while daemons release workspace locks. Nested sub-builds inherit `ATC_BUILD_OP_ID` without deadlocking. |

## 4. Guardrails, KMP dual-lease routing, and agent hooks

`atc guard <command>` and `atc hook pre-tool-use` inspect shell commands before execution:

| Command category | Examples | Guard & hook action |
|---|---|---|
| Non-device commands | `git status`, `npm test` | `< 2 ms` zero-lock fast path; runs untouched. |
| Pure builds (`coordinateBuilds: true`) | `./gradlew assembleDebug`, `bazel build //...` | Allowed (or rewritten to `atc exec --build -- ...` when `coordinateBuilds` is enabled). |
| Direct lifecycle & daemon kill commands | `emulator -avd`, `adb emu kill`, `xcrun simctl boot\|shutdown\|erase`, `./gradlew --stop`, `bazel shutdown`, `bazel clean --expunge` | Blocked (`exit 2`); prevents killing shared virtual devices or another agent's build daemon. |
| Unleased or cross-session device commands | `adb shell`, `xcrun simctl launch`, `xcodebuild test` without a matching lease | Blocked (`exit 2`). |
| Leased device & KMP compound commands | `adb install a.apk && xcrun simctl install booted b.app` | Rewritten in Claude Code, Gemini CLI, Antigravity, and Pi so each segment runs under `ATC_SESSION_ID=<id> atc exec --serial <platform-serial> -- ...`. |
| Session end (`atc hook stop`) | Agent turn finishes | Frees active leases held by the session (or sets `releaseOnWorkerExit` if an `atc exec` worker is still running). |

## 5. Stdio MCP server (`atc mcp`)

Agents that prefer structured JSON-RPC tools over shell commands can run `atc mcp` (or load `.mcp.json`):

| Tool | Purpose |
|---|---|
| `atc_status` | Fleet capacity (`emu slots`, `sim slots`), running/offline/creatable devices, active leases, and queue. |
| `atc_claim` | Claim an Android or iOS lease (`ios`, `android`, `type`, `api`, `os`, `udid`, `avd`, `serial`). |
| `atc_renew` | Extend an active lease TTL (supports `ios` / `android` filter for KMP sessions). |
| `atc_snapshot` | `list`, `save`, `load`, or `delete` QEMU or APFS snapshots (supports `ios` / `android` filter). |
| `atc_free` | Release a lease (supports `ios` / `android` filter, `snapshotSave`, `snapshotLoad`, or `stop`). |
| `atc_guide` | Read built-in guides (`workflow`, `profiles`, `snapshots`, `multi-agent`, `traps`). |
