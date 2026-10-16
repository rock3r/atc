# ATC 3.0: supported scope

This document is the source of truth for what ATC 3.x supports. Anything not listed here is refused with an explanation. If you need something that isn't supported, please [open a feature request](https://github.com/rock3r/atc/issues) describing your use case.

## Principles
1. **Domain:** device/emulator/simulator management and communication, plus builds. Nothing else.
2. **No shell, anywhere.** ATC never receives, inspects or runs shell commands. Agents request **allowlisted typed ops**, and ATC builds every invocation itself.
3. **Closed grammar.** A fixed op catalog with closed enums and strict value patterns. There are no free-form arguments and no passthrough flags.
4. **ATC never changes the semantics of a request.** It doesn't split, merge, reorder or coalesce. It only adds **efficiency notices** for next time.
5. **Refusals explain themselves:** what was unsupported, the supported alternative, and `https://github.com/rock3r/atc/issues`.
6. **Pessimistic assumptions are reported** as `{assumption, consequence, fix}`.
7. **New ops need a strong usability case.** Edge cases get a refusal plus a message, never new modelling.

## 1. Entry points
| Entry point | For |
|---|---|
| `atc exec <system> <op> [params] [flags]` | **one basic op**: no env, no cwd change, no ordering, no timeout, no claim reuse |
| `atc batch --file plan.json` (`--validate` for a dry run) | **everything else**: a DAG of the same ops plus `cwd`, `env`, `dependsOn`, claims, timeouts |
| MCP tools | the same ops, schemas and validator |

Device lifecycle commands are unchanged: `atc claim/free/renew/status/snapshot/gc/config/guide`.

## 2. v1 op catalog (approved)

### 2.1 Builds: each system keeps its natural commands
All systems share the concepts **run a task**, **run a series of tasks** and **clean**.

| Op | Params / flags |
|---|---|
| `gradle.tasks` | `tasks[]` (any task name/path), run as **one** `./gradlew` invocation · `buildOnly`, `brief`, `offline`, `info`, `stacktrace`, `rerunTasks`, `continueAfterFailure`, `properties{}` (`-P`) |
| `bazel.build` / `bazel.test` / `bazel.coverage` | `targets[]` · `brief`, `configs[]`, `testFilter`, `keepGoing` |
| `bazel.run` | `target`, `runArgs[]` · `timeoutSec` **required** |
| `bazel.series` | ordered `[{command, targets[], configs[]?}]` with `command ∈ {build, test, coverage, clean}` (closed enum; `run` is not allowed in a series). Run exactly as given: one invocation per entry, in order. |
| `bazel.clean` | `expunge` (bool) |
| `xcode.build` / `xcode.test` / `xcode.buildForTesting` / `xcode.testWithoutBuilding` / `xcode.archive` / `xcode.clean` | `scheme`, `workspaceFile` or `project` · `configuration`, `testPlan`, `onlyTesting[]`, `skipTesting[]`, `derivedDataPath`, `brief` |
| `xcode.actions` | the same params + ordered `actions[]` with each action `∈ {build, test, build-for-testing, test-without-building, archive, clean}`, as one `xcodebuild` call |

**ATC derives:** the executable (`./gradlew` / `gradlew.bat`, bazelisk vs bazel, `xcodebuild`), device vs pure build, worker/job/RAM limits, workspace key, output base, and the destination/serial from the claim.

**Lock classes:**
- **Shared workspace lock + build slot:** ordinary build ops.
- **Exclusive workspace lock** for the **whole invocation** when it contains a clean:
  - a `gradle.tasks` request with any task named `clean` or ending in `:clean`;
  - `bazel.clean`, or a `bazel.series` with a `clean` entry (exclusive for the entire series, on workspace + output base);
  - `xcode.clean`, or `xcode.actions` containing `clean` (exclusive on that DerivedData path).
- Exclusive admission waits for in-flight builds on the key to finish and blocks new ones until done.
- **Multi-task and series ops** hold their locks and slot for the whole run. RAM is sized for the largest part.

**Not supported, hard-denied even with `--force`:** stopping Gradle daemons, stopping the Bazel server, Gradle continuous mode. Daemons and servers are shared across sessions, and ATC owns them.

### 2.2 Android device ops (require an Android claim; serial always injected)
| Op | Params |
|---|---|
| `android.install` | `apk`, flags `replace`, `grantPermissions` |
| `android.uninstall` | `package` |
| `android.launch` | `package` + `activity` |
| `android.clearData` | `package` |
| `android.permission` | `package`, `permission`, `action ∈ {grant, revoke}` |
| `android.logcat` | `filters[]` (`tag:level`), `durationSec` or `dump` |
| `android.screenshot` | `output` |
| `android.prop.get` / `android.prop.set` | `key` (+ `value`). `set` only on emulators unless enabled in config. |

**Device-side transport contract.** Ops that go through `adb shell` (launch, clearData, permission, prop.*) use **fixed command templates**. The remote side gets a shell string, so passing separate host argv entries is **not** enough protection. Therefore:
- every value interpolated into a remote template must match a **transport-safe charset**: `^[A-Za-z0-9_.:/@+=,-]+$` (no spaces, quotes, `;`, `$`, backticks, `&`, `|`, `<`, `>`, `\`, `*`, `?`, `~`, `#`);
- each value is additionally single-quote-wrapped in the template;
- this restriction is **not overridable by `--force`**;
- tests assert on the **exact remote command string** a fake `adb` receives, using hostile values.

### 2.3 iOS simulator ops (require an iOS claim; UDID always injected)
| Op | Params |
|---|---|
| `ios.install` / `ios.uninstall` | `app` / `bundleId` |
| `ios.launch` / `ios.terminate` | `bundleId`, `launchArgs[]` (transport-safe charset) |
| `ios.openUrl` | `url` (`^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s'"`;|&<>\\]*$`) |
| `ios.screenshot` | `output` |
| `ios.privacy` | `bundleId`, `service` (enum), `action ∈ {grant, revoke, reset}` |

### 2.4 Snapshots (virtual devices only)
- Ops: `device.snapshot.list`, and `device.snapshot.save` / `load` / `delete` with `name`.
- Android uses QEMU snapshots and iOS uses APFS clones, as today. Physical devices are refused.

### 2.5 Candidates, not in v1 (added only on request)
- **Android:** `stop`, `push`/`pull`, `screenrecord`, `setting`, `input`, `instrument`, launch-by-intent.
- **iOS:** `recordVideo`, `location`, `log`.
- **Bazel:** target exclusion patterns.

### 2.6 Not expressible, by design
- Arbitrary `adb shell` or `simctl spawn`, `adb kill-server`/`reboot`/`emu kill`, and `simctl boot/shutdown/erase` outside `atc claim`/`atc free`.
- Third-party runners (`maestro`, `flutter`, Detox, scripts).

## 3. Value validation (strict, KISS)
- Each value is checked against an allowlist pattern. Anything else is rejected with the pattern and the issues link.
- A leading `-` is always rejected, for every value.

| Value | Pattern |
|---|---|
| Gradle task / path | `^:?[A-Za-z0-9_][A-Za-z0-9_.-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)*$` |
| Gradle property (`-P`) key / value | `^[A-Za-z0-9_.-]{1,128}$` / transport-safe charset |
| Bazel target | `^(@[A-Za-z0-9_.~+-]*)?//[A-Za-z0-9_./+-]*(:[A-Za-z0-9_./+=,@~-]+)?$` (incl. `//...`, `:all`) |
| Bazel config / test filter | `^[A-Za-z0-9_.-]+$` / transport-safe charset |
| `bazel.run` `runArgs[]` | transport-safe charset |
| Xcode scheme / configuration / test plan | `^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$` (macOS only, direct exec) |
| Xcode `onlyTesting` / `skipTesting` | `^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.()-]+){0,2}$` |
| Android package / permission | `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$` / `^[A-Za-z0-9_.]+$` |
| Activity | `^\.?[A-Za-z][A-Za-z0-9_.$]*$` (`$` allowed only here; still single-quoted remotely) |
| iOS bundle id | `^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$` |
| Prop key / value | `^[A-Za-z0-9_.-]{1,128}$` / transport-safe charset, ≤ 256 chars |
| Snapshot name | `^[A-Za-z0-9_.-]{1,64}$` |
| Paths (`apk`, `app`, `cwd`, `workspace`, `output`, `derivedDataPath`, `workspaceFile`, `project`) | no NUL/newline. **Syntax is checked at validation time; existence is checked at execution time** (inputs may be produced by ancestor steps). `cwd`/`workspace` must exist at validation unless an ancestor step is declared to create them (not in v1, so they must exist). |

**Windows execution contract:**
- `bazel(isk).exe` runs by direct spawn.
- `gradlew.bat` must go through `cmd.exe /d /s /c` using the salvaged, reviewed resolution and escaping from PR #8.
- For batch-file invocations, **every argument** must additionally match `^[A-Za-z0-9_.:/\\@+=,-]+$` (no `%`, `!`, `^`, quotes, spaces, `&`, `|`, `<`, `>`).
- The **resolved wrapper path** (e.g. `C:\work\app\gradlew.bat`) and the working directory passed to `cmd.exe` must contain no `%`, `!`, `^`, `"`, `&`, `|`, `<`, `>` or control characters. Spaces are allowed, because the reviewed code quotes the path. CMD expands `%NAME%` even inside double quotes, so expansion-sensitive paths are refused outright, with a notice suggesting the project be moved to a plain path.
- These checks are **not overridable by `--force`**.
- Xcode/iOS ops are macOS-only.

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
- Common fields: `id`, `op`, `dependsOn`, `cwd`, `env` (literal string values, transport-safe charset), `claim` (a profile object or `{ "reuse": "<stepId>" }`), `workspace`, `phase`, `ramMb`, `timeoutSec`, `continueOnError`, `force: { reason }`.
- **Executor (v1):** **sequential**, in a deterministic topological order. There is no parallel step execution in v1.

**Claim-reuse contract** (new implementation, not salvaged):
- `reuse` must name an **ancestor** that has its own claim.
- The runner keeps that lease (by **lease id + generation**, never re-acquired by profile) from the producer until its **last consumer** finishes. It renews the lease with the batch heartbeat.
- It releases the lease after the last consumer, or on failure/cancellation.
- If the producer failed (including under `continueOnError`), every consumer is **skipped** with a `claim_unavailable` error.
- Leases the session held before the batch started are never released by the batch.

**Validation** runs entirely before anything executes:
- **Structure:** `version: 1`, a non-empty `steps` array, unknown fields as errors, `op` in the catalog, required params, types, closed enums, value patterns.
- **Semantics:**
  - duplicate ids, unknown or misspelled deps, cycles;
  - device op without a claim, platform mismatch, `reuse` of a non-ancestor or of a claim-less step;
  - `buildOnly` with device tasks;
  - `cwd`/`workspace` missing, or missing the expected markers;
  - Windows transport violations.
- **Output:** every error as `{path, code, message, hint}`, plus `notices[]`; exit `1`, and nothing runs.
- **`--validate`:** prints order, claims (including reuse spans), lock classes, workspace keys, RAM, notices, and the exact argv per step. Inputs that are produced at run time are listed as "checked at execution".

## 5. `--force`: the agent takes responsibility
**Overrides only:**
- value-**pattern** rejections for build-host values (tasks, targets, schemes, configs, properties);
- refusals due to ambiguity or unsupported config (e.g. unknown Bazel version with a version-conditional rc import).

**Never overrides:**
- shell, arbitrary executables, unknown ops or params;
- extra arguments (**there is no `extraArgs`**);
- the device-side transport charset and the Windows batch-transport charset;
- device selectors or claims, locks, slots, and cold RAM reservation (always pessimistic under force);
- hard-denied actions (§2.1).

**Accountability:**
- `--reason` is required.
- Overridden warnings are echoed back.
- The audit log records session, op, argv, overridden checks and reason.
- `atc status --forced` summarises them.
- Later breakage attributes the forced run that may be responsible.
- Every forced run says "request support at <issues>" so the case won't need `--force` next time.

## 6. Notices
- Shape: `{assumption, consequence, fix}`.
- Shown on `atc exec` stderr, in `--json`, in batch results, and in MCP results.
- Examples:
  - cold RAM reservation, fix `--ram-mb`;
  - custom Bazel startup (unknown version), fix: pin `.bazelversion`;
  - device held during compilation, fix: split steps;
  - a `bazel.series` that could be merged.

## 7. No shell inspection: what is removed, and session identity
- **Removed:**
  - `atc guard`;
  - PreToolUse/beforeShellExecution command analysis and rewriting;
  - compound splitting;
  - the pi extension's `tool_call` shell parser and its call into `atc guard` (`extensions/atc/index.ts`).
- **Session identity is kept without reading commands.** The remaining host hooks only record the host session id and anchor PID (they never read the command field), so MCP and CLI claims still belong to the host session that the Stop hook releases.
- **Consequence:** raw `adb`/`./gradlew` run directly in an agent's shell is not intercepted. Steering happens through the skill, docs, `atc guide` and MCP. Coordination guarantees apply to work requested through ATC.

## 8. Design decisions
1. Cross-agent destructive actions stay hard-denied even with `--force`. Agents can still run them outside ATC in an emergency, but ATC owns these shared resources and won't do it on request.
2. Review findings are triaged against this document: in-scope bugs are fixed, out-of-scope requests are refused by design (or available via `--force` where allowed).
