// Closed catalog of typed ATC operations (see docs/scope.md §2).
// ATC never runs shell: each op turns validated, typed params into literal invocations.
import fs from "node:fs";
import path from "node:path";
import { isGradleDeviceTaskName } from "../build.mjs";
import { quoteRemote } from "./patterns.mjs";

export class OpError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const BUILD_COMMON = {
  workspace: { type: "path", role: "dir", description: "Directory to resolve the build root from (defaults to cwd)" },
  brief: { type: "boolean", description: "Condensed output; full log path printed on failure" },
  buildOnly: { type: "boolean", description: "Assert this is a pure build (no device needed)" },
  ramMb: { type: "integer", min: 1, max: 1048576, description: "Minimum RAM to reserve (MB)" },
};

const EXECUTABLE_PARAM = {
  executable: {
    type: "path",
    role: "input",
    description: "Custom wrapper or executable to run (you take responsibility, same as --force)",
  },
};

const XCODE_COMMON = {
  scheme: { type: "string", pattern: "xcodeName", required: true },
  workspaceFile: { type: "path", role: "input", description: "Path to .xcworkspace" },
  project: { type: "path", role: "input", description: "Path to .xcodeproj" },
  configuration: { type: "string", pattern: "xcodeName" },
  testPlan: { type: "string", pattern: "xcodeName" },
  onlyTesting: { type: "string[]", pattern: "xcodeTestId" },
  skipTesting: { type: "string[]", pattern: "xcodeTestId" },
  derivedDataPath: { type: "path", role: "output" },
  testDestination: {
    type: "enum",
    values: ["simulator", "macos"],
    description: "Where test actions run: the claimed iOS simulator (default) or the macOS host",
  },
  ...BUILD_COMMON,
};

const XCODE_ACTIONS = ["build", "test", "build-for-testing", "test-without-building", "archive", "clean"];
const BAZEL_SERIES_COMMANDS = ["build", "test", "coverage", "clean"];
const BAZEL_QUERY_OUTPUTS = ["label", "label_kind", "xml", "proto", "streamed_jsonproto", "graph", "minrank", "maxrank", "location", "package", "build"];
const BAZEL_CQUERY_OUTPUTS = ["label", "label_kind", "starlark", "jsonproto", "streamed_jsonproto", "textproto", "xml", "graph", "files"];
export const BAZEL_QUERY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function findUp(startDir, fileNames) {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 64; i++) {
    for (const f of fileNames) {
      const candidate = path.join(cur, f);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore unreadable entries
      }
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

function buildBaseDir(params, ctx) {
  if (!params.workspace) return ctx.cwd;
  const dir = path.resolve(ctx.cwd, params.workspace);
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) {
    // Never walk up from a misspelled workspace into a parent project.
    throw new OpError("workspace_not_found", `Workspace directory ${dir} does not exist.`, "Pass an existing directory as workspace.");
  }
  return dir;
}

function resolveCustomExecutable(rawExec, { baseDir, rootDir = null, ctx, system }) {
  const isWin = (ctx.platform || process.platform) === "win32";
  const raw = String(rawExec);
  const hasSep = raw.includes("/") || raw.includes("\\") || (isWin && /^[A-Za-z]:/.test(raw));
  const winExts = isWin && !/\.(?:exe|cmd|bat|com)$/i.test(raw) ? ["", ".bat", ".cmd", ".exe"] : [""];
  const checkFile = (p) => {
    for (const ext of winExts) {
      const candidate = p + ext;
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (!isWin && process.platform !== "win32") {
            fs.accessSync(candidate, fs.constants.X_OK);
          }
          return candidate;
        }
      } catch (err) {
        if (err && (err.code === "EACCES" || err.code === "EPERM")) {
          throw new OpError(
            "executable_not_executable",
            `Custom ${system} executable ${candidate} is not executable.`,
            `Run chmod +x ${candidate} or pass an executable binary/wrapper.`,
          );
        }
      }
    }
    return null;
  };

  if (hasSep) {
    const searchBases = [
      baseDir,
      ...(rootDir && rootDir !== baseDir ? [rootDir] : []),
      ...(ctx.cwd && ctx.cwd !== baseDir && ctx.cwd !== rootDir ? [ctx.cwd] : []),
    ];
    for (const b of searchBases) {
      const found = checkFile(path.resolve(b, raw));
      if (found) return found;
    }
    throw new OpError(
      "executable_not_found",
      `Custom ${system} executable "${raw}" was not found (resolved against ${baseDir}).`,
      "Pass an existing executable path, or omit executable to use the default.",
    );
  }

  const localNames = winExts.map((ext) => raw + ext);
  const inRoot = rootDir ? findUp(rootDir, localNames) : null;
  if (inRoot && path.dirname(inRoot) === rootDir) {
    const checked = checkFile(inRoot);
    if (checked) return checked;
  }
  const walked = findUp(baseDir, localNames);
  if (walked) {
    const checked = checkFile(walked);
    if (checked) return checked;
  }
  const which = ctx.which || (() => null);
  const fromPath = which(raw);
  if (fromPath) return fromPath;
  throw new OpError(
    "executable_not_found",
    `Custom ${system} executable "${raw}" was not found in ${baseDir} or on PATH.`,
    "Pass an existing wrapper path or executable on PATH, or omit executable to use the default.",
  );
}

function resolveGradleExecutable(params, ctx) {
  const baseDir = buildBaseDir(params, ctx);
  const isWin = (ctx.platform || process.platform) === "win32";
  const names = isWin ? ["gradlew.bat", "gradlew.cmd"] : ["gradlew"];
  const projectMarker =
    findUp(baseDir, ["settings.gradle.kts", "settings.gradle", ...names]) ||
    findUp(baseDir, ["build.gradle.kts", "build.gradle"]);
  const projectRoot = projectMarker ? path.dirname(projectMarker) : null;
  if (params.executable) {
    const cmd = resolveCustomExecutable(params.executable, {
      baseDir,
      rootDir: projectRoot,
      ctx,
      system: "Gradle",
    });
    const execDir = path.dirname(cmd);
    const execIsAncestor = baseDir === execDir || baseDir.startsWith(`${execDir}${path.sep}`);
    const cwd = projectRoot || (execIsAncestor ? execDir : baseDir);
    return { cmd, cwd };
  }
  const wrapper = findUp(baseDir, names);
  if (!wrapper) {
    throw new OpError(
      "gradle_wrapper_not_found",
      `No Gradle wrapper (${names.join(" / ")}) found in ${baseDir} or its parents.`,
      "gradle.tasks runs the project's Gradle wrapper by default. Run from inside the project, pass workspace, or pass executable.",
    );
  }
  return { cmd: wrapper, cwd: path.dirname(wrapper) };
}

function resolveBazelExecutable(params, ctx) {
  const baseDir = buildBaseDir(params, ctx);
  const wsMarker = findUp(baseDir, [
    "MODULE.bazel",
    "REPO.bazel",
    "WORKSPACE.bazel",
    "WORKSPACE",
  ]);
  if (!wsMarker) {
    throw new OpError(
      "bazel_workspace_not_found",
      `No Bazel workspace (MODULE.bazel / WORKSPACE) found in ${baseDir} or its parents.`,
      "Run from inside the Bazel workspace, or pass workspace.",
    );
  }
  const wsRoot = path.dirname(wsMarker);
  if (params.executable) {
    const cmd = resolveCustomExecutable(params.executable, {
      baseDir,
      rootDir: wsRoot,
      ctx,
      system: "Bazel",
    });
    return { cmd, wsRoot };
  }
  const isWin = (ctx.platform || process.platform) === "win32";
  const local = findUp(wsRoot, isWin ? ["bazelw.bat", "bazelw.cmd"] : ["bazelw"]);
  if (local && path.dirname(local) === wsRoot) return { cmd: local, wsRoot };
  const which = ctx.which || (() => null);
  const bazelisk = which("bazelisk");
  return { cmd: bazelisk || "bazel", wsRoot };
}

function bazelCommonArgs(params) {
  const args = [];
  for (const c of params.configs || []) args.push(`--config=${c}`);
  if (params.testFilter) args.push(`--test_filter=${params.testFilter}`);
  if (params.keepGoing) args.push("--keep_going");
  return args;
}

function xcodeBaseArgs(params, ctx) {
  const base = buildBaseDir(params, ctx);
  const args = [];
  if (params.workspaceFile) args.push("-workspace", path.resolve(base, params.workspaceFile));
  if (params.project) args.push("-project", path.resolve(base, params.project));
  args.push("-scheme", params.scheme);
  if (params.configuration) args.push("-configuration", params.configuration);
  if (params.testPlan) args.push("-testPlan", params.testPlan);
  for (const t of params.onlyTesting || []) args.push(`-only-testing:${t}`);
  for (const t of params.skipTesting || []) args.push(`-skip-testing:${t}`);
  if (params.derivedDataPath) args.push("-derivedDataPath", path.resolve(base, params.derivedDataPath));
  return args;
}

const XCODE_DEVICE_ACTIONS = new Set(["test", "test-without-building"]);

function xcodeDestinationArgs(params, ctx, actions) {
  if (!actions.some((a) => XCODE_DEVICE_ACTIONS.has(a))) return [];
  if (params.testDestination === "macos") return ["-destination", "platform=macOS"];
  if (ctx.lease?.kind === "physical") {
    throw new OpError(
      "simulator_only",
      "Xcode test actions target a simulator (testDestination: simulator); this session's iOS lease is a physical device.",
      'Claim a simulator, or use testDestination: "macos" for macOS tests. Physical-device test runs are not in the catalog yet; request them at https://github.com/rock3r/atc/issues.',
    );
  }
  return ctx.lease?.serial ? ["-destination", `id=${ctx.lease.serial}`] : [];
}

function xcodeOp(name, actions) {
  return {
    name,
    system: "xcode",
    kind: "build",
    hostOs: "darwin",
    params: { ...XCODE_COMMON },
    devicePlatform: "ios",
    deviceCoupled: (p) => p.testDestination !== "macos" && actions.some((a) => XCODE_DEVICE_ACTIONS.has(a)),
    invocations(params, ctx) {
      return [{ cmd: "xcodebuild", args: [...xcodeBaseArgs(params, ctx), ...actions, ...xcodeDestinationArgs(params, ctx, actions)], cwd: buildBaseDir(params, ctx) }];
    },
  };
}

function adb(ctx, ...args) {
  if (!ctx.lease?.serial) {
    throw new OpError("claim_required", "This operation needs an active Android device lease.", "Run `atc claim --android` first.");
  }
  return { cmd: "adb", args: ["-s", ctx.lease.serial, ...args] };
}

function adbShell(ctx, remote) {
  return adb(ctx, "shell", remote);
}

function simctl(ctx, verb, ...args) {
  if (!ctx.lease?.serial) {
    throw new OpError("claim_required", "This operation needs an active iOS simulator lease.", "Run `atc claim --ios` first.");
  }
  if (ctx.lease.kind === "physical") {
    throw new OpError(
      "simulator_only",
      "iOS device operations run through simctl and only support simulators; this session's iOS lease is a physical device.",
      "Claim a simulator (atc claim --ios --kind emulator). Physical iOS device ops are not in the catalog yet; request them at https://github.com/rock3r/atc/issues.",
    );
  }
  return { cmd: "xcrun", args: ["simctl", verb, ctx.lease.serial, ...args] };
}

export const OPS = Object.freeze({
  "gradle.tasks": {
    name: "gradle.tasks",
    system: "gradle",
    kind: "build",
    positional: "tasks",
    params: {
      tasks: { type: "string[]", pattern: "gradleTask", required: true, minItems: 1, maxItems: 64 },
      offline: { type: "boolean" },
      info: { type: "boolean" },
      stacktrace: { type: "boolean" },
      rerunTasks: { type: "boolean" },
      continueAfterFailure: { type: "boolean" },
      properties: { type: "map", keyPattern: "gradlePropertyKey", valuePattern: "transportSafe" },
      ...EXECUTABLE_PARAM,
      ...BUILD_COMMON,
    },
    devicePlatform: "android",
    deviceCoupled: (p) => Array.isArray(p.tasks) && p.tasks.some((t) => isGradleDeviceTaskName(String(t).split(":").pop())),
    invocations(params, ctx) {
      const { cmd, cwd } = resolveGradleExecutable(params, ctx);
      const args = [...params.tasks];
      if (params.offline) args.push("--offline");
      if (params.info) args.push("--info");
      if (params.stacktrace) args.push("--stacktrace");
      if (params.rerunTasks) args.push("--rerun-tasks");
      if (params.continueAfterFailure) args.push("--continue");
      for (const [k, v] of Object.entries(params.properties || {})) args.push(`-P${k}=${v}`);
      return [{ cmd, args, cwd }];
    },
    notices(params) {
      const tasks = params.tasks || [];
      const device = tasks.filter((t) => isGradleDeviceTaskName(String(t).split(":").pop()));
      if (device.length > 0 && device.length < tasks.length) {
        return [
          {
            assumption: `Tasks ${device.join(", ")} need a device; the others are pure build tasks.`,
            consequence: "The device is held for the whole invocation, including compilation.",
            fix: "Split into an assemble step and a device step (batch dependsOn) so the device is only claimed when needed.",
          },
        ];
      }
      return [];
    },
  },

  "bazel.build": bazelSimple("build"),
  "bazel.test": bazelSimple("test"),
  "bazel.coverage": bazelSimple("coverage"),
  "bazel.run": {
    name: "bazel.run",
    system: "bazel",
    kind: "build",
    positional: "target",
    params: {
      target: { type: "string", pattern: "bazelTarget", required: true },
      runArgs: { type: "string[]", pattern: "passthroughArg", maxItems: 64 },
      configs: { type: "string[]", pattern: "bazelConfig" },
      timeoutSec: { type: "integer", min: 1, max: 86400, required: true },
      ...EXECUTABLE_PARAM,
      ...BUILD_COMMON,
    },
    invocations(params, ctx) {
      const { cmd, wsRoot } = resolveBazelExecutable(params, ctx);
      const args = ["run", ...bazelCommonArgs(params), params.target];
      if ((params.runArgs || []).length > 0) args.push("--", ...params.runArgs);
      return [{ cmd, args, cwd: wsRoot, timeoutSec: params.timeoutSec }];
    },
  },
  "bazel.series": {
    name: "bazel.series",
    system: "bazel",
    kind: "build",
    params: {
      series: {
        type: "objectList",
        required: true,
        minItems: 1,
        maxItems: 32,
        item: {
          command: { type: "enum", values: BAZEL_SERIES_COMMANDS, required: true },
          targets: { type: "string[]", pattern: "bazelTarget" },
          configs: { type: "string[]", pattern: "bazelConfig" },
          expunge: { type: "boolean" },
        },
      },
      ...EXECUTABLE_PARAM,
      ...BUILD_COMMON,
    },
    invocations(params, ctx) {
      const { cmd, wsRoot } = resolveBazelExecutable(params, ctx);
      return params.series.map((entry) => {
        if (entry.command === "clean") {
          return { cmd, args: ["clean", ...(entry.expunge ? ["--expunge"] : [])], cwd: wsRoot };
        }
        const args = [entry.command];
        for (const c of entry.configs || []) args.push(`--config=${c}`);
        args.push(...(entry.targets || []));
        return { cmd, args, cwd: wsRoot };
      });
    },
    check(params) {
      const errs = [];
      (params.series || []).forEach((e, i) => {
        if (e.command !== "clean" && (!Array.isArray(e.targets) || e.targets.length === 0)) {
          errs.push({ path: `/series/${i}/targets`, code: "required", message: `"${e.command}" needs at least one target.` });
        }
        if (e.command === "clean" && e.targets?.length) {
          errs.push({ path: `/series/${i}/targets`, code: "not_allowed", message: "clean takes no targets." });
        }
        if (e.command !== "clean" && e.expunge) {
          errs.push({ path: `/series/${i}/expunge`, code: "not_allowed", message: "expunge only applies to clean." });
        }
      });
      return errs;
    },
    notices(params) {
      const s = params.series || [];
      for (let i = 1; i < s.length; i++) {
        if (s[i].command === s[i - 1].command && s[i].command !== "clean") {
          return [
            {
              assumption: `Consecutive "${s[i].command}" entries run as separate Bazel invocations, exactly as requested.`,
              consequence: "Each invocation re-runs analysis.",
              fix: "Merge consecutive entries with the same command into one entry next time.",
            },
          ];
        }
      }
      return [];
    },
  },
  "bazel.clean": {
    name: "bazel.clean",
    system: "bazel",
    kind: "build",
    params: { expunge: { type: "boolean" }, ...EXECUTABLE_PARAM, ...BUILD_COMMON },
    invocations(params, ctx) {
      const { cmd, wsRoot } = resolveBazelExecutable(params, ctx);
      return [{ cmd, args: ["clean", ...(params.expunge ? ["--expunge"] : [])], cwd: wsRoot }];
    },
  },
  "bazel.query": bazelQueryOp("query", BAZEL_QUERY_OUTPUTS),
  "bazel.cquery": bazelQueryOp("cquery", BAZEL_CQUERY_OUTPUTS),

  "xcode.build": xcodeOp("xcode.build", ["build"]),
  "xcode.test": xcodeOp("xcode.test", ["test"]),
  "xcode.buildForTesting": xcodeOp("xcode.buildForTesting", ["build-for-testing"]),
  "xcode.testWithoutBuilding": xcodeOp("xcode.testWithoutBuilding", ["test-without-building"]),
  "xcode.archive": xcodeOp("xcode.archive", ["archive"]),
  "xcode.clean": xcodeOp("xcode.clean", ["clean"]),
  "xcode.actions": {
    ...xcodeOp("xcode.actions", []),
    params: {
      ...XCODE_COMMON,
      actions: { type: "enum[]", values: XCODE_ACTIONS, required: true, minItems: 1, maxItems: 6 },
    },
    deviceCoupled: (p) => p.testDestination !== "macos" && Array.isArray(p.actions) && p.actions.some((a) => XCODE_DEVICE_ACTIONS.has(a)),
    invocations(params, ctx) {
      return [{ cmd: "xcodebuild", args: [...xcodeBaseArgs(params, ctx), ...params.actions, ...xcodeDestinationArgs(params, ctx, params.actions)], cwd: buildBaseDir(params, ctx) }];
    },
  },

  "android.install": {
    name: "android.install",
    system: "android",
    kind: "device",
    platform: "android",
    positional: "apk",
    params: {
      apk: { type: "path", role: "input", required: true },
      replace: { type: "boolean" },
      grantPermissions: { type: "boolean" },
    },
    invocations(p, ctx) {
      return [adb(ctx, "install", ...(p.replace ? ["-r"] : []), ...(p.grantPermissions ? ["-g"] : []), path.resolve(ctx.cwd, p.apk))];
    },
  },
  "android.uninstall": {
    name: "android.uninstall",
    system: "android",
    kind: "device",
    platform: "android",
    positional: "package",
    params: { package: { type: "string", pattern: "androidPackage", required: true } },
    invocations: (p, ctx) => [adb(ctx, "uninstall", p.package)],
  },
  "android.launch": {
    name: "android.launch",
    system: "android",
    kind: "device",
    platform: "android",
    params: {
      package: { type: "string", pattern: "androidPackage", required: true },
      activity: { type: "string", pattern: "androidActivity", required: true },
    },
    invocations: (p, ctx) => [adbShell(ctx, `am start -n ${quoteRemote(`${p.package}/${p.activity}`)}`)],
  },
  "android.clearData": {
    name: "android.clearData",
    system: "android",
    kind: "device",
    platform: "android",
    positional: "package",
    params: { package: { type: "string", pattern: "androidPackage", required: true } },
    invocations: (p, ctx) => [adbShell(ctx, `pm clear ${quoteRemote(p.package)}`)],
  },
  "android.permission": {
    name: "android.permission",
    system: "android",
    kind: "device",
    platform: "android",
    params: {
      package: { type: "string", pattern: "androidPackage", required: true },
      permission: { type: "string", pattern: "androidPermission", required: true },
      action: { type: "enum", values: ["grant", "revoke"], required: true },
    },
    invocations: (p, ctx) => [adbShell(ctx, `pm ${p.action} ${quoteRemote(p.package)} ${quoteRemote(p.permission)}`)],
  },
  "android.logcat": {
    name: "android.logcat",
    readOnly: true,
    system: "android",
    kind: "device",
    platform: "android",
    params: {
      filters: { type: "string[]", pattern: "logcatFilter", maxItems: 32 },
      lines: { type: "integer", min: 1, max: 100000 },
    },
    invocations: (p, ctx) => [adb(ctx, "logcat", "-d", ...(p.lines ? ["-t", String(p.lines)] : []), ...(p.filters || []))],
  },
  "android.screenshot": {
    name: "android.screenshot",
    readOnly: true,
    system: "android",
    kind: "device",
    platform: "android",
    positional: "output",
    params: { output: { type: "path", role: "output", required: true } },
    invocations(p, ctx) {
      const remote = "/data/local/tmp/atc-screenshot.png";
      return [
        adbShell(ctx, `screencap -p ${quoteRemote(remote)}`),
        adb(ctx, "pull", remote, path.resolve(ctx.cwd, p.output)),
        adbShell(ctx, `rm -f ${quoteRemote(remote)}`),
      ];
    },
  },
  "android.prop.get": {
    name: "android.prop.get",
    readOnly: true,
    system: "android",
    kind: "device",
    platform: "android",
    positional: "key",
    params: { key: { type: "string", pattern: "propKey", required: true } },
    invocations: (p, ctx) => [adbShell(ctx, `getprop ${quoteRemote(p.key)}`)],
  },
  "android.prop.set": {
    name: "android.prop.set",
    system: "android",
    kind: "device",
    platform: "android",
    positional: ["key", "value"],
    params: {
      key: { type: "string", pattern: "propKey", required: true },
      value: { type: "string", pattern: "transportSafe", required: true },
    },
    physicalNeedsConfig: "allowPhysicalPropSet",
    invocations: (p, ctx) => [adbShell(ctx, `setprop ${quoteRemote(p.key)} ${quoteRemote(p.value)}`)],
  },

  "ios.install": {
    name: "ios.install",
    system: "ios",
    kind: "device",
    platform: "ios",
    hostOs: "darwin",
    positional: "app",
    params: { app: { type: "path", role: "input", required: true } },
    invocations: (p, ctx) => [simctl(ctx, "install", path.resolve(ctx.cwd, p.app))],
  },
  "ios.uninstall": iosBundleOp("ios.uninstall", "uninstall"),
  "ios.terminate": iosBundleOp("ios.terminate", "terminate"),
  "ios.launch": {
    name: "ios.launch",
    system: "ios",
    kind: "device",
    platform: "ios",
    hostOs: "darwin",
    positional: "bundleId",
    params: {
      bundleId: { type: "string", pattern: "iosBundleId", required: true },
      launchArgs: { type: "string[]", pattern: "passthroughArg", maxItems: 32 },
    },
    invocations: (p, ctx) => [simctl(ctx, "launch", p.bundleId, ...(p.launchArgs || []))],
  },
  "ios.openUrl": {
    name: "ios.openUrl",
    system: "ios",
    kind: "device",
    platform: "ios",
    hostOs: "darwin",
    positional: "url",
    params: { url: { type: "string", pattern: "url", required: true } },
    invocations: (p, ctx) => [simctl(ctx, "openurl", p.url)],
  },
  "ios.screenshot": {
    name: "ios.screenshot",
    readOnly: true,
    system: "ios",
    kind: "device",
    platform: "ios",
    hostOs: "darwin",
    positional: "output",
    params: { output: { type: "path", role: "output", required: true } },
    invocations: (p, ctx) => {
      const inv = simctl(ctx, "io", "screenshot", path.resolve(ctx.cwd, p.output));
      return [inv];
    },
  },
  "ios.privacy": {
    name: "ios.privacy",
    system: "ios",
    kind: "device",
    platform: "ios",
    hostOs: "darwin",
    params: {
      bundleId: { type: "string", pattern: "iosBundleId", required: true },
      service: {
        type: "enum",
        values: ["all", "calendar", "contacts-limited", "contacts", "location", "location-always", "photos-add", "photos", "media-library", "microphone", "motion", "reminders", "siri", "camera"],
        required: true,
      },
      action: { type: "enum", values: ["grant", "revoke", "reset"], required: true },
    },
    invocations: (p, ctx) => [simctl(ctx, "privacy", p.action, p.service, p.bundleId)],
  },

  "snapshot.list": snapshotOp("snapshot.list", "list", false),
  "snapshot.save": snapshotOp("snapshot.save", "save", true),
  "snapshot.load": snapshotOp("snapshot.load", "load", true),
  "snapshot.delete": snapshotOp("snapshot.delete", "delete", true),
});

function bazelQueryOp(command, outputValues) {
  return {
    name: `bazel.${command}`,
    system: "bazel",
    kind: "build",
    positional: "query",
    params: {
      query: { type: "string", pattern: "bazelQueryExpr", required: true },
      output: { type: "enum", values: outputValues, required: true },
      outputFile: { type: "path", role: "output", required: true },
      maxOutputBytes: { type: "integer", min: 1, max: BAZEL_QUERY_MAX_OUTPUT_BYTES },
      keepGoing: { type: "boolean" },
      ...EXECUTABLE_PARAM,
      ...BUILD_COMMON,
    },
    invocations(params, ctx) {
      const { cmd, wsRoot } = resolveBazelExecutable(params, ctx);
      const args = [command, `--output=${params.output}`];
      if (params.keepGoing) args.push("--keep_going");
      args.push(params.query);
      return [{ cmd, args, cwd: wsRoot }];
    },
    check(params) {
      return checkBazelQueryOutputFile(params);
    },
  };
}

function checkBazelQueryOutputFile(params) {
  if (params.outputFile === undefined || params.outputFile === null) return [];
  const raw = String(params.outputFile);
  if (path.isAbsolute(raw)) {
    return [{
      path: "/outputFile",
      code: "unsafe_output",
      message: "outputFile must be a relative path inside the working directory.",
      hint: "Pass a relative path such as out/main-rules.xml. ATC resolves it against cwd and refuses paths that escape it.",
    }];
  }
  if (raw.split(/[/\\]/).includes("..")) {
    return [{
      path: "/outputFile",
      code: "unsafe_output",
      message: "outputFile must not contain '..'.",
      hint: "Pass a relative path that stays inside the working directory.",
    }];
  }
  return [];
}

function bazelSimple(command) {
  return {
    name: `bazel.${command}`,
    system: "bazel",
    kind: "build",
    positional: "targets",
    params: {
      targets: { type: "string[]", pattern: "bazelTarget", required: true, minItems: 1, maxItems: 256 },
      configs: { type: "string[]", pattern: "bazelConfig" },
      ...(command === "test" || command === "coverage" ? { testFilter: { type: "string", pattern: "transportSafe" } } : {}),
      keepGoing: { type: "boolean" },
      ...EXECUTABLE_PARAM,
      ...BUILD_COMMON,
    },
    invocations(params, ctx) {
      const { cmd, wsRoot } = resolveBazelExecutable(params, ctx);
      return [{ cmd, args: [command, ...bazelCommonArgs(params), ...params.targets], cwd: wsRoot }];
    },
  };
}

function iosBundleOp(name, verb) {
  return {
    name,
    system: "ios",
    kind: "device",
    platform: "ios",
    hostOs: "darwin",
    positional: "bundleId",
    params: { bundleId: { type: "string", pattern: "iosBundleId", required: true } },
    invocations: (p, ctx) => [simctl(ctx, verb, p.bundleId)],
  };
}

function snapshotOp(name, action, needsName) {
  return {
    name,
    system: "snapshot",
    kind: "snapshot",
    action,
    virtualOnly: true,
    readOnly: action === "list",
    positional: needsName ? "name" : null,
    params: needsName ? { name: { type: "string", pattern: "snapshotName", required: true } } : {},
  };
}

export const SYSTEMS = Object.freeze(["gradle", "bazel", "xcode", "android", "ios", "snapshot"]);

export function listOps(system = null) {
  return Object.values(OPS).filter((o) => !system || o.system === system);
}

// CLI verb mapping: `atc exec <system> <verb> ...` → op name.
export function resolveOpName(system, verb) {
  if (!system) return null;
  const sys = String(system).toLowerCase();
  if (!SYSTEMS.includes(sys)) return null;
  if (!verb) return null;
  const v = String(verb);
  const direct = `${sys}.${v}`;
  if (OPS[direct]) return direct;
  const camel = `${sys}.${v.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`;
  if (OPS[camel]) return camel;
  return null;
}
