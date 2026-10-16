# ATC 3.0: supported scope

This document is the source of truth for what ATC 3.x supports. Anything not listed here is refused with an explanation. If you need something that isn't supported, please [open a feature request](https://github.com/rock3r/atc/issues) describing your use case.

## Principles
1. **Domain:** device/emulator/simulator management and communication, plus builds. Nothing else.
2. **No shell, anywhere.** ATC never receives, inspects or runs shell commands. Agents request **allowlisted typed ops**, and ATC builds every invocation itself as literal argv.
3. **Closed grammar.** A fixed op catalog with closed enums and strict value patterns. There are no free-form arguments and no passthrough flags.
4. **ATC never changes the semantics of a request.** It doesn't split, merge, reorder or coalesce. It only adds **efficiency notices** for next time.
5. **Refusals explain themselves:** what was unsupported, the supported alternative, and `https://github.com/rock3r/atc/issues`.
6. **Pessimistic assumptions are reported** as `{assumption, consequence, fix}`.
7. **New ops need a strong usability case.** Edge cases get a refusal plus a message, never new modelling.

## 1. Entry points
| Entry point | For |
|---|---|
| `atc exec <system> <op> [params] [flags]` | **one basic op**: no env, no cwd change, no ordering, no claim reuse |
| `atc batch --file plan.json` (`--validate` for a dry run) | **everything else**: a DAG of the same ops plus `cwd`, `env`, `dependsOn`, claims, timeouts |
| MCP tools `atc_gradle`, `atc_bazel`, `atc_xcode`, `atc_android`, `atc_ios`, `atc_batch` | the same ops, schemas and validator (`{operation, params, …}`) |

Device lifecycle commands are unchanged: `atc claim/free/renew/status/snapshot/gc/config/guide`.

`atc exec` CLI shape: `atc exec <system> <verb> [positional…] [--param value | --param=value | --flag | --no-flag]`. Verbs are kebab-case (`build-for-testing`), two-word verbs are allowed (`android prop get`), array params repeat (`--config ci --config remote`), map params use `--property key=value`. Exec-level flags: `--json`, `--claim` (plus claim selectors `--type`, `--api`, `--os`, `--kind`, `--play`, `--abi`, `--services`, `--ttl`), `--serial`/`--udid`, `--android`/`--ios`, `--wait <sec>`, `--session`, `--force --reason "<why>"`. `--cwd`/`--env` and `-- <command>` are refused with a pointer to `atc batch` / the catalog.

## 2. v1 op catalog (approved)

### 2.1 Builds: each system keeps its natural commands
All systems share the concepts **run a task**, **run a series of tasks** and **clean**. Every build op accepts `workspace` (directory to resolve the build root from), `brief` (condensed output, full log on disk), `buildOnly` (assert no device is needed) and `ramMb` (minimum RAM to reserve).

| Op | Params / flags |
|---|---|
| `gradle.tasks` | `tasks[]` (any task name/path), run as **one** wrapper invocation · `offline`, `info`, `stacktrace`, `rerunTasks`, `continueAfterFailure`, `properties{}` (`-P`) |
| `bazel.build` / `bazel.test` / `bazel.coverage` | `targets[]` · `configs[]`, `testFilter` (test/coverage), `keepGoing` |
| `bazel.run` | `target`, `runArgs[]` (after `--`) · `timeoutSec` **required** |
| `bazel.series` | ordered `series: [{command, targets[], configs[]?, expunge?}]` with `command ∈ {build, test, coverage, clean}` (closed enum; `run` is not allowed in a series). Run exactly as given: one invocation per entry, in order, stopping at the first failure. Batch/MCP only. |
| `bazel.clean` | `expunge` (bool) |
| `xcode.build` / `xcode.test` / `xcode.buildForTesting` / `xcode.testWithoutBuilding` / `xcode.archive` / `xcode.clean` | `scheme`, `workspaceFile` or `project` · `configuration`, `testPlan`, `onlyTesting[]`, `skipTesting[]`, `derivedDataPath`, `testDestination ∈ {simulator, macos}` |
| `xcode.actions` | the same params + ordered `actions[]` with each action `∈ {build, test, build-for-testing, test-without-building, archive, clean}`, as one `xcodebuild` call |

**ATC derives:**
- the executable: the project's Gradle wrapper (`gradlew` / `gradlew.bat`, found by walking up from `workspace`/cwd; a system-wide `gradle` is not supported), Bazel as `./bazelw` at the workspace root, else `bazelisk`, else `bazel`; `xcodebuild`;
- device vs pure build (Gradle device task names such as `connected*`, `install*`, `uninstall*`; Xcode `test`/`test-without-building` unless `testDestination: "macos"`);
- worker/job/RAM limits (`-Dorg.gradle.workers.max`, `--jobs` + `--local_ram_resources`, `-jobs`), the workspace resource key, the Bazel output base, and the device destination/serial from the claim.

**Serialization:** builds on the same workspace key (`gradle:<root>`, `bazel:ws:<root>`, `xcode:<root>`, `xcode:dd:<derivedData>`) are serialized, and heavy builds share the host build-slot pool. A clean therefore never races another build in the same workspace. Multi-invocation ops (`bazel.series`) hold their slot and locks for the whole run.

**Not supported, hard-denied even with `--force`:** stopping Gradle daemons, stopping the Bazel server, Gradle continuous mode. Daemons and servers are shared across sessions, and ATC owns them. None of these are expressible in the catalog.

### 2.2 Android device ops (require an Android lease; serial always injected)
| Op | Params |
|---|---|
| `android.install` | `apk`, flags `replace`, `grantPermissions` |
| `android.uninstall` | `package` |
| `android.launch` | `package` + `activity` |
| `android.clearData` | `package` |
| `android.permission` | `package`, `permission`, `action ∈ {grant, revoke}` |
| `android.logcat` | dump only (`logcat -d`): `filters[]` (`tag:level`), `lines` (last N) |
| `android.screenshot` | `output` (screencap to a device temp file, pull, remove) |
| `android.prop.get` / `android.prop.set` | `key` (+ `value`). `set` is refused on physical devices unless `atc config set allowPhysicalPropSet true`. |

**Device-side transport contract.** Ops that go through `adb shell` (launch, clearData, permission, prop.*, screenshot) use **fixed command templates**. The remote side gets a shell string, so passing separate host argv entries is **not** enough protection. Therefore:
- every value interpolated into a remote template must match its pattern, all of which are subsets of the **transport-safe charset** `^[A-Za-z0-9_.:/@+=,-]+$` (no spaces, quotes, `;`, `$` outside activity names, backticks, `&`, `|`, `<`, `>`, `\`, `*`, `?`, `~`, `#`);
- each value is additionally single-quote-wrapped in the template;
- this restriction is **not overridable by `--force`**;
- tests assert on the **exact remote command string** a fake `adb` receives.

### 2.3 iOS simulator ops (require an iOS lease; UDID always injected; macOS only)
| Op | Params |
|---|---|
| `ios.install` / `ios.uninstall` | `app` / `bundleId` |
| `ios.launch` / `ios.terminate` | `bundleId`, `launchArgs[]` (launch only; passed to the app after the bundle id) |
| `ios.openUrl` | `url` (`^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s'"`;|&<>\\]*$`) |
| `ios.screenshot` | `output` |
| `ios.privacy` | `bundleId`, `service` (enum), `action ∈ {grant, revoke, reset}` |

### 2.4 Snapshots (virtual devices only)
- Ops: `snapshot.list`, and `snapshot.save` / `snapshot.load` / `snapshot.delete` with `name` (CLI: `atc exec snapshot save <name>`, same as `atc snapshot save <name>`).
- Android uses QEMU snapshots and iOS uses APFS clones, as before. Physical devices are refused.

### 2.5 Candidates, not in v1 (added only on request)
- **Android:** `stop`, `push`/`pull`, `screenrecord`, `setting`, `input`, `instrument`, launch-by-intent, streaming logcat.
- **iOS:** `recordVideo`, `location`, `log`.
- **Bazel:** target exclusion patterns.

### 2.6 Not expressible, by design
- Arbitrary `adb shell` or `simctl spawn`, `adb kill-server`/`reboot`/`emu kill`, and `simctl boot/shutdown/erase` outside `atc claim`/`atc free`.
- Third-party runners (`maestro`, `flutter`, Detox, scripts).

## 3. Value validation (strict, KISS)
- Each value is checked against an allowlist pattern. Anything else is rejected with the pattern and the issues link.
- A leading `-` is always rejected (and never forceable), except for program arguments that cannot reach the tool's own option parser (`bazel.run` `runArgs[]` after `--`, `ios.launch` `launchArgs[]` after the bundle id).
- All errors are collected and returned together as `{path, code, message, hint}`; exit code `7`, and nothing runs.

| Value | Pattern |
|---|---|
| Gradle task / path | `^:?[A-Za-z0-9_][A-Za-z0-9_.-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)*$` |
| Gradle property (`-P`) key / value | `^[A-Za-z0-9_.-]{1,128}$` / transport-safe charset |
| Bazel target | `^(@[A-Za-z0-9_.~+-]*)?//[A-Za-z0-9_./+-]*(:[A-Za-z0-9_./+=,@~-]+)?$` (incl. `//...`, `:all`) |
| Bazel config / test filter | `^[A-Za-z0-9_.-]+$` / transport-safe charset |
| `bazel.run` `runArgs[]`, `ios.launch` `launchArgs[]` | transport-safe charset (leading `-` allowed) |
| Xcode scheme / configuration / test plan | `^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$` |
| Xcode `onlyTesting` / `skipTesting` | `^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.()-]+){0,2}$` |
| Android package / permission | `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$` / `^[A-Za-z][A-Za-z0-9_.]*$` |
| Activity | `^\.?[A-Za-z][A-Za-z0-9_.$]*$` (`$` allowed only here; still single-quoted remotely) |
| Logcat filter | `^([A-Za-z0-9_.-]+\|\*):[VDIWEFS]$` |
| iOS bundle id | `^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$` |
| Prop key / value | `^[A-Za-z0-9_.-]{1,128}$` / transport-safe charset, ≤ 256 chars |
| Snapshot name / step id | `^[A-Za-z0-9_.-]{1,64}$` |
| Env var name / value (batch) | `^[A-Za-z_][A-Za-z0-9_]{0,127}$` / transport-safe charset |
| Paths (`apk`, `app`, `cwd`, `workspace`, `output`, `derivedDataPath`, `workspaceFile`, `project`) | no NUL/newline, no leading `-`. **Syntax is checked at validation time; existence is checked at execution time** (inputs may be produced by ancestor steps). A batch step's `cwd` must exist at validation; a build's wrapper/workspace marker must be found before anything runs. |

**Windows execution contract:**
- `bazel(isk).exe` runs by direct spawn.
- `gradlew.bat` goes through `cmd.exe /d /s /c` using the salvaged, reviewed resolution and quoting.
- For batch-file invocations, **every argument** must additionally match `^[A-Za-z0-9_.:/\\@+=,-]+$` (no `%`, `!`, `^`, quotes, spaces, `&`, `|`, `<`, `>`).
- The **resolved wrapper path** (e.g. `C:\work\app\gradlew.bat`) and the working directory passed to `cmd.exe` must contain no `%`, `!`, `^`, `"`, `&`, `|`, `<`, `>` or control characters. Spaces are allowed, because the path is quoted. CMD expands `%NAME%` even inside double quotes, so expansion-sensitive paths are refused outright, suggesting the project be moved to a plain path.
- These checks are **not overridable by `--force`**.
- Xcode/iOS ops are macOS-only (`unsupported_host` elsewhere).

## 4. `atc batch` (v1)
```json
{
  "version": 1,
  "steps": [
    { "id": "assemble", "op": "gradle.tasks", "cwd": "app",
      "tasks": ["assembleDebug", "assembleDebugAndroidTest"], "buildOnly": true, "brief": true },
    { "id": "install", "op": "android.install", "dependsOn": ["assemble"],
      "apk": "app/build/outputs/apk/debug/app-debug.apk", "replace": true,
      "claim": { "platform": "android", "type": "phone", "api": "36" } },
    { "id": "test", "op": "gradle.tasks", "dependsOn": ["install"], "cwd": "app",
      "tasks": ["connectedDebugAndroidTest"], "claim": { "reuse": "install" }, "timeoutSec": 1800 }
  ]
}
```
- Common step fields: `id`, `op`, `dependsOn`, `cwd`, `env` (literal string values), `claim` (a profile object `{platform, kind?, type?, api?, os?, play?, abi?, services?, snapshotLoad?, ttlSec?}` or `{ "reuse": "<stepId>" }`), `timeoutSec`, `continueOnError`, `force: { reason }`. Every other field is an op param.
- **Executor (v1):** **sequential**, in a deterministic topological order. There is no parallel step execution in v1.
- **Failure:** a failed step skips its dependents (`dependency_failed`) and stops the batch, unless the step has `continueOnError: true`, in which case independent steps keep running and the failure does not fail the batch.

**Claim-reuse contract:**
- `reuse` must name an **ancestor** (via `dependsOn`) that has its own claim on the same platform.
- The runner keeps that lease (bound by lease id/serial, never re-acquired by profile) from the producer until its **last consumer** finishes, renewing it while held.
- It releases the lease after the last consumer, or on failure/cancellation.
- If the producer failed, every consumer is **skipped** (`dependency_failed`, or `claim_unavailable` if the lease is gone).
- Leases the session held before the batch started are never released by the batch.

**Validation** runs entirely before anything executes:
- **Structure:** `version: 1`, a non-empty `steps` array, unknown fields as errors, `op` in the catalog, required params, types, closed enums, value patterns.
- **Semantics:**
  - duplicate ids, unknown or misspelled deps, self-dependencies, cycles;
  - device op without a claim (and no session lease), platform mismatch, `claim` on a step that uses no device, `reuse` of a non-ancestor or of a claim-less step;
  - `buildOnly` with device tasks;
  - `cwd` missing; build wrapper / workspace marker missing;
  - host OS and Windows transport violations.
- **Output:** every error as `{path, code, message, hint}`; exit `7`, and nothing runs.
- **`--validate`:** prints the order, the exact argv per step (the leased device serial is shown as a placeholder), notices and overridden checks, and runs nothing.

## 5. `--force`: the agent takes responsibility
**Overrides only:** value-**pattern** rejections for build-host values (Gradle tasks and properties keys, Bazel targets and configs, Xcode names and test identifiers).

**Never overrides:**
- shell, arbitrary executables, unknown ops or params;
- extra arguments (**there is no `extraArgs`**), or any value starting with `-`;
- the device-side transport charset and the Windows batch-transport charset;
- device selectors or claims, locks, slots, and RAM admission;
- hard-denied actions (§2.1).

**Accountability:**
- `--reason` is required (batch: `"force": { "reason": "…" }`).
- Overridden checks are echoed back.
- The audit log and `state.forcedRuns` record the run id, session, op, cwd, overridden checks and reason.
- `atc status --forced` lists them.
- When a later op fails in the same workspace within 24 hours, the result attributes the forced run that may be responsible.
- Every forceable rejection says "request support at <issues>" so the case won't need `--force` next time.

## 6. Notices
- Shape: `{assumption, consequence, fix}`.
- Shown on `atc exec` stderr, in `--json`, in batch results, and in MCP results.
- Current notices:
  - a `gradle.tasks` request mixing device and pure build tasks holds the device during compilation; fix: split assemble and device steps;
  - consecutive `bazel.series` entries with the same command could be merged;
  - several batch steps claiming their own device on the same platform; fix: `claim: {reuse}`.

## 7. No shell inspection: what is removed, and session identity
- **Removed:**
  - `atc guard` (now prints a removal notice, exit `7`);
  - PreToolUse/beforeShellExecution command analysis and rewriting;
  - compound splitting and all shell parsing;
  - `atc exec -- <command>`;
  - the pi extension's `tool_call` shell parser and its call into `atc guard` (`extensions/atc/index.ts`).
- **Session identity is kept without reading commands.** The remaining host hooks only record the host session id and anchor PID (they never read the command field), so MCP and CLI claims still belong to the host session that the Stop hook releases.
- **Consequence:** raw `adb`/`./gradlew` run directly in an agent's shell is not intercepted. Steering happens through the skill, docs, `atc guide` and MCP. Coordination guarantees apply to work requested through ATC.

## 8. Exit codes
| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Usage error or internal error; also a child tool's own exit code passes through when it fails. |
| `2` | Busy: no matching device or slot (`--wait 0`). |
| `3` | No matching lease for this session, lease owned by another session, or a policy refusal (e.g. `allowPhysicalPropSet`). |
| `4` | Queue wait or boot timed out. |
| `5` | Host RAM/disk below the safety reserve. |
| `6` | Physical device claim rejected by policy. |
| `7` | Request rejected by validation (unsupported op/param/value); nothing ran. |
| `124` | An op's `timeoutSec` elapsed and ATC stopped it. |

## 9. Design decisions
1. Cross-agent destructive actions stay hard-denied even with `--force`. Agents can still run them outside ATC in an emergency, but ATC owns these shared resources and won't do it on request.
2. Review findings are triaged against this document: in-scope bugs are fixed, out-of-scope requests are refused by design (or available via `--force` where allowed).
