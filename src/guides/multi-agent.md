# atc multi-agent coordination, queueing, hooks & MCP

Guides: `workflow` · `profiles` · `snapshots` · `multi-agent` (this page) · `traps` (`atc guide <topic>`).

## 1. Cooperative coordination and the 6-step session identity ladder

`atc` coordinates concurrent agents through a lock-serialized `state.json` (`atc.lock`, `<20 ms` hold time). It never inspects shell commands; agents request typed operations, and host hooks only keep track of who the agent is.

Each agent tool call runs in a fresh subshell whose PID exits right away. `atc` resolves your `sessionId` and long-lived host `anchorPid` using a 6-step ladder:

| Priority | Source | What `atc` inspects |
|---|---|---|
| `1` | Explicit flag or env | `--session <id>`, `ATC_SESSION_ID`, or `--lease <lease_id>` |
| `2` | MCP session injection | `session` added to `atc_*` MCP tool arguments by the `PreToolUse` hook |
| `3` | Host runtime env vars | `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_TRACE_ID`, `CURSOR_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `GEMINI_SESSION_ID`, `CLAUDE_SESSION_ID` |
| `4` | Hook PID breadcrumb map | `state.hookSessions` (recorded by the hook on tool calls, without reading the command) matched by `process.ppid`, ancestor PID chain, or unique `cwd` |
| `5` | Stdio MCP server | `mcp-<pid>` persisted for the lifetime of `atc mcp` |
| `6` | Parent process fallback | `TMUX_PANE`, `TERM_SESSION_ID`, or `ppid-<stableParentPid>` |

If an agent exits or crashes without calling `atc free` (`process.kill(anchorPid, 0)` fails) and no worker process group (`workerPgids`) is alive, the next `atc` command reclaims the orphan lease automatically.

## 2. Contention and the 120-second warm-affinity queue

When all matching devices or platform slots (`maxRunningEmulators` on Android, `maxRunningSimulators` on iOS) are busy, `atc claim` either fails immediately (`--wait 0`, exit code `2`) or enqueues a ticket in `state.queue` (`--wait <sec>`, default `300`) and updates `lastHeartbeatAtMs` every second.

| Queue rule | Window / trigger | Behavior |
|---|---|---|
| Warm-affinity jump (`canJumpAhead`) | Earlier ticket has waited `< 120 s` (`reorderWindowSec`) | A queued ticket matching an already-warm (`Tier 0`) device jumps ahead of a cold-boot/eviction ticket and starts in `< 20 ms`. |
| Starvation freeze (`isTicketStarvationProtected`) | Ticket waits `>= 120 s` (`starvationDeadlineMs`) | Ticket freezes at Priority #0. No newer ticket can jump ahead of it; `atc` stops an unlocked warm device and boots the waiting ticket's profile. |

## 3. Build + device co-scheduling

Build ops (`gradle.tasks`, `bazel.*`, `xcode.*`) go through `state.buildLeases` and `state.buildQueue`. `atc` knows from the op whether a build needs a device (Gradle `connected*`/`install*` tasks, Xcode test actions on a simulator), so there are no intent flags to pass.

| Tier | Caller profile | Slot ceiling | Co-scheduling guarantee |
|---|---|---|---|
| `Tier 0` | Starved build ticket waiting `>= 120 s` (`buildReorderWindowSec`) | Base + Burst | Bounds maximum queue wait so pure builds never starve indefinitely. |
| `Tier 1` | Device-coupled build under your lease, or `--claim` for the run | Base + Burst (`maxConcurrentBuilds = "auto"` `[1..4]` + `1` burst) | Jumps ahead of `< 120 s` pure builds so leased devices never sit idle waiting to compile. Cold-boot `--claim` runs reserve a `"preparing_device"` build slot before booting. |
| `Tier 2` | Pure build | Base | Builds on the same workspace key (`gradle:<root>`, `bazel:ws:<root>`, `xcode:<dir>`) are serialized; aborted builds enter a `5 s` `"draining"` cooldown. Nested builds inherit `ATC_BUILD_OP_ID` without deadlocking. |

### Split phases so devices are held only when needed

`atc` never splits a request for you; it prints a notice instead. Plan the phases yourself, ideally in one `atc batch`:
- **Gradle:** `gradle.tasks [assembleDebug, assembleDebugAndroidTest]` (no claim) → `gradle.tasks [connectedDebugAndroidTest]` (claim).
- **Xcode:** `xcode.buildForTesting` (no claim) → `xcode.testWithoutBuilding` (claim).
- **Bazel:** `bazel.build //app:instrumented_tests` (no claim) → `bazel.test //app:instrumented_tests`.

Use `"claim": {"reuse": "<stepId>"}` to keep one device across several device steps; `atc` holds and renews it until the last consumer finishes.

## 4. Hooks

| Hook | What it does |
|---|---|
| `atc hook pre-tool-use` on shell tools | Allows the call without reading it, and refreshes `state.hookSessions` for the agent (at most every 30 s) so CLI calls resolve the right session. |
| `atc hook pre-tool-use` on `atc_*` MCP tools | Records the session and injects `session` into the tool arguments. |
| `atc hook stop` (session end) | Frees active leases held by the session (or sets `releaseOnWorkerExit` if a worker is still running). |

Raw device or build commands that an agent runs directly in its shell are not intercepted, and therefore not coordinated. Steer work through `atc` operations.

## 5. Stdio MCP server (`atc mcp`)

Agents that prefer structured JSON-RPC tools can run `atc mcp` (or load `.mcp.json`):

| Tool | Purpose |
|---|---|
| `atc_gradle`, `atc_bazel`, `atc_xcode`, `atc_android`, `atc_ios` | Run a typed op: `{operation, params, claim?, serial?, udid?, waitSec?, force?, reason?}`. Output is captured into the result. |
| `atc_batch` | Run or validate (`validate: true`) a batch plan. |
| `atc_status` | Fleet capacity, devices, leases, builds, and queues. |
| `atc_claim` | Claim an Android or iOS lease (`ios`, `android`, `type`, `api`, `os`, `udid`, `avd`, `serial`). |
| `atc_renew` | Extend an active lease TTL (supports `ios` / `android` filter for KMP sessions). |
| `atc_snapshot` | `list`, `save`, `load`, or `delete` QEMU or APFS snapshots. |
| `atc_free` | Release a lease (supports `ios` / `android` filter, `snapshotSave`, `snapshotLoad`, or `stop`). |
| `atc_guide` | Read built-in guides (`workflow`, `profiles`, `snapshots`, `multi-agent`, `traps`). |
