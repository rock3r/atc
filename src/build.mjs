import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function canonicalizeBuildPath(targetPath) {
  const resolved = path.resolve(String(targetPath || "."));
  try {
    const realpathFn = fs.realpathSync.native || fs.realpathSync;
    return realpathFn(resolved);
  } catch {
    return resolved;
  }
}

export function tokenizeShellClause(clause) {
  const s = String(clause || "");
  const tokens = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
        cur += s[i + 1];
        i++;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length && /\s|['"\\]/.test(s[i + 1])) {
      cur += s[i + 1];
      hasToken = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || cur.length > 0) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken || cur.length > 0) {
    tokens.push(cur);
  }
  return tokens;
}

export function splitShellScriptParts(script) {
  const s = String(script || "");
  const parts = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[i + 1];
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      parts.push(cur, ch);
      cur = "";
      continue;
    }
    if (ch === "&" && s[i + 1] === "&") {
      parts.push(cur, "&&");
      cur = "";
      i++;
      continue;
    }
    if (ch === "|") {
      if (s[i + 1] === "|") {
        parts.push(cur, "||");
        cur = "";
        i++;
      } else {
        parts.push(cur, "|");
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function peelBuildWrapperTokens(cmd, args = []) {
  let curCmd = String(cmd || "");
  let curArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  let relCwd = null;
  const envVars = {};

  for (let depth = 0; depth < 16; depth++) {
    const cleaned = curCmd.trim().replace(/^@+/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned)) {
      const eqIdx = cleaned.indexOf("=");
      envVars[cleaned.slice(0, eqIdx)] = cleaned.slice(eqIdx + 1);
      if (curArgs.length === 0) break;
      curCmd = curArgs[0];
      curArgs = curArgs.slice(1);
      continue;
    }
    const base = (cleaned.split(/[\\/]/).pop() || "")
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|com|sh)$/i, "");

    if (base === "build-brief" || base === "time" || base === "nohup") {
      if (curArgs.length === 0) break;
      curCmd = curArgs[0];
      curArgs = curArgs.slice(1);
      continue;
    }
    if (base === "xcrun") {
      let i = 0;
      let queryMode = false;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "-f" || a === "--find" || a === "--show-sdk-path" || a === "--show-sdk-version") {
          queryMode = true;
          break;
        }
        if ((a === "-sdk" || a === "--sdk" || a === "-toolchain" || a === "--toolchain") && i + 1 < curArgs.length) {
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (queryMode || i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "nice") {
      let i = 0;
      while (i < curArgs.length && curArgs[i].startsWith("-")) {
        if (curArgs[i] === "-n" && i + 1 < curArgs.length) {
          i += 2;
        } else {
          i += 1;
        }
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "timeout") {
      let i = 0;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if (
          (a === "-k" || a === "--kill-after" || a === "-s" || a === "--signal") &&
          i + 1 < curArgs.length
        ) {
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < curArgs.length && /^\d+(?:\.\d+)?[smhd]?$/.test(curArgs[i])) {
        i += 1;
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "env") {
      let i = 0;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if ((a === "-C" || a === "--chdir") && i + 1 < curArgs.length) {
          relCwd = relCwd ? path.join(relCwd, curArgs[i + 1]) : curArgs[i + 1];
          i += 2;
          continue;
        }
        if ((a === "-u" || a === "--unset") && i + 1 < curArgs.length) {
          delete envVars[curArgs[i + 1]];
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
          const eqIdx = a.indexOf("=");
          envVars[a.slice(0, eqIdx)] = a.slice(eqIdx + 1);
          i++;
          continue;
        }
        break;
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "command") {
      let i = 0;
      let queryMode = false;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if (a.startsWith("-") && /[vV]/.test(a)) {
          queryMode = true;
          break;
        }
        if (a.startsWith("-")) {
          i++;
          continue;
        }
        break;
      }
      if (queryMode || i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (
      base === "sh" ||
      base === "bash" ||
      base === "zsh" ||
      base === "dash" ||
      base === "ksh" ||
      base === "cmd" ||
      base === "powershell" ||
      base === "pwsh"
    ) {
      const cIdx = curArgs.findIndex((a) => {
        if (base === "cmd") return /^\/[ck]$/i.test(a);
        if (base === "powershell" || base === "pwsh") return /^-(?:c|command)$/i.test(a);
        return a === "-c" || (/^-[A-Za-z]+$/.test(a) && a.includes("c"));
      });
      if (cIdx !== -1 && cIdx + 1 < curArgs.length) {
        const rawScriptArg =
          (base === "cmd" || base === "powershell" || base === "pwsh") &&
          curArgs.length > cIdx + 2
            ? curArgs.slice(cIdx + 1).join(" ")
            : String(curArgs[cIdx + 1] || "");
        const script = rawScriptArg.trim();
        const clauses = splitShellScriptParts(script)
          .filter((_, idx) => idx % 2 === 0)
          .map((s) => s.trim())
          .filter(Boolean);
        const matchedClauses = [];
        let curShellRelCwd = relCwd;
        const cwdStack = [];
        for (const clause of clauses) {
          let strippedClause = clause
            .replace(/\s+[0-9]*>>?\s*\S+/g, "")
            .replace(/\s+2>&1\b/g, "")
            .trim();
          while (/^[({]/.test(strippedClause)) {
            if (strippedClause.startsWith("(")) {
              cwdStack.push(curShellRelCwd);
            }
            strippedClause = strippedClause.slice(1).trim();
          }
          let closedSubshells = 0;
          while (/[)}]$/.test(strippedClause)) {
            if (strippedClause.endsWith(")")) {
              closedSubshells++;
            }
            strippedClause = strippedClause.slice(0, -1).trim();
          }
          const popSubshells = () => {
            for (let s = 0; s < closedSubshells; s++) {
              if (cwdStack.length > 0) {
                curShellRelCwd = cwdStack.pop();
              }
            }
          };
          const rawTokens = tokenizeShellClause(strippedClause);
          if (rawTokens.length === 0) {
            popSubshells();
            continue;
          }
          const headTok = rawTokens[0];
          if ((headTok === "cd" || headTok === "pushd") && rawTokens.length >= 2) {
            let dirIdx = 1;
            while (dirIdx < rawTokens.length && rawTokens[dirIdx].startsWith("-")) {
              dirIdx++;
            }
            if (dirIdx < rawTokens.length) {
              const targetDir = rawTokens[dirIdx];
              if (targetDir && targetDir !== "-") {
                curShellRelCwd = curShellRelCwd ? path.join(curShellRelCwd, targetDir) : targetDir;
              }
            }
            popSubshells();
            continue;
          }
          const peeled = peelBuildWrapperTokens(rawTokens[0], rawTokens.slice(1));
          if (normalizeBuildToolName(peeled.cmd)) {
            const effectiveRelCwd =
              peeled.relCwd && curShellRelCwd
                ? path.join(curShellRelCwd, peeled.relCwd)
                : peeled.relCwd || curShellRelCwd || null;
            matchedClauses.push({
              cmd: peeled.cmd,
              args: peeled.args,
              relCwd: effectiveRelCwd,
              envVars: { ...envVars, ...(peeled.envVars || {}) },
            });
          }
          popSubshells();
        }
        if (matchedClauses.length > 0) {
          return {
            cmd: matchedClauses[0].cmd,
            args: matchedClauses[0].args,
            relCwd: matchedClauses[0].relCwd || null,
            envVars: matchedClauses[0].envVars || { ...envVars },
            allBuildClauses: matchedClauses,
          };
        }
      }
    }
    break;
  }

  return { cmd: curCmd, args: curArgs, relCwd, envVars, allBuildClauses: null };
}

export function normalizeBuildToolName(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const cleaned = cmd.trim().replace(/^@+/, "");
  const base = (cleaned.split(/[\\/]/).pop() || "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|sh)$/i, "");
  if (base === "gradle" || base === "gradlew") return "gradle";
  if (base === "bazel" || base === "bazelisk" || base === "bazelw") return "bazel";
  if (base === "xcodebuild") return "xcodebuild";
  return null;
}

const GRADLE_VALUE_FLAGS = new Set([
  "-p",
  "--project-dir",
  "-g",
  "--gradle-user-home",
  "-c",
  "--settings-file",
  "-b",
  "--build-file",
  "-I",
  "--init-script",
  "--console",
  "--warning-mode",
  "--max-workers",
  "--priority",
]);

const GRADLE_WORKSPACE_ONLY_TASKS = new Set([
  "tasks",
  "projects",
  "dependencies",
  "dependencyInsight",
  "help",
  "properties",
  "model",
  "components",
  "outgoingVariants",
  "resolvableConfigurations",
  "buildEnvironment",
  "javaToolchains",
]);

const NON_DEVICE_INSTALL_RE = /^install(Dist|BootDist|ShadowDist|Maven|ToMavenLocal)$/i;
const NON_DEVICE_CAMEL_INSTALL_RE = /^i(Dist|BD|SD|M|TML)$/;

export function isGradleDeviceTaskName(name) {
  if (!name || typeof name !== "string") return false;
  if (NON_DEVICE_INSTALL_RE.test(name) || NON_DEVICE_CAMEL_INSTALL_RE.test(name)) {
    return false;
  }
  if (
    /^(connected.*AndroidTest|connectedCheck|deviceCheck|allDevicesCheck|uninstall([A-Z0-9_].*)?|install([A-Z0-9_].*)?)$/i.test(
      name,
    )
  ) {
    return true;
  }
  if (/^(c[A-Z0-9]*A[A-Z0-9]*T|cC|dC|aDC|i[A-Z][A-Za-z0-9]*|u[A-Z][A-Za-z0-9]*)$/.test(name)) {
    return true;
  }
  return false;
}

const BAZEL_STARTUP_VALUE_FLAGS = new Set([
  "--output_base",
  "--output_user_root",
  "--install_base",
  "--bazelrc",
  "--max_idle_secs",
  "--connect_timeout_secs",
  "--server_javabase",
]);

const BAZEL_SUBCOMMANDS = new Set([
  "build",
  "test",
  "run",
  "coverage",
  "mobile-install",
  "query",
  "cquery",
  "aquery",
  "fetch",
  "sync",
  "clean",
  "shutdown",
  "version",
  "help",
  "info",
  "dump",
  "config",
  "mod",
  "license",
]);

const XCODEBUILD_VALUE_FLAGS = new Set([
  "-project",
  "-workspace",
  "-scheme",
  "-target",
  "-configuration",
  "-sdk",
  "-destination",
  "-destination-timeout",
  "-derivedDataPath",
  "-resultBundlePath",
  "-xcconfig",
  "-archivePath",
  "-exportPath",
  "-exportOptionsPlist",
  "-only-testing",
  "-skip-testing",
  "-testPlan",
]);

export function classifyBuildCommand(rawCmd, rawArgs = []) {
  const { cmd, args, allBuildClauses } = peelBuildWrapperTokens(rawCmd, rawArgs);
  if (allBuildClauses && allBuildClauses.length > 1) {
    const clauseResults = allBuildClauses.map((c) => classifyBuildCommand(c.cmd, c.args));
    const deny = clauseResults.find((r) => r.kind === "deny_lifecycle");
    if (deny) return deny;
    const reject = clauseResults.find((r) => r.kind === "reject_long_running");
    if (reject) return reject;
    const requiresDevice = clauseResults.some((r) => r.requiresDevice);
    const requiresHeavySlot = clauseResults.some((r) => r.requiresHeavySlot);
    const requiresWorkspaceLock = clauseResults.some((r) => r.requiresWorkspaceLock);
    const kind = requiresDevice
      ? "device_coupled_build"
      : requiresHeavySlot
        ? "pure_build"
        : requiresWorkspaceLock
          ? "workspace_only"
          : "not_build_tool";
    return {
      ...clauseResults[0],
      kind,
      targetPlatform: clauseResults.find((r) => r.targetPlatform)?.targetPlatform || null,
      requiresDevice,
      requiresHeavySlot,
      requiresWorkspaceLock,
    };
  }
  const tool = normalizeBuildToolName(cmd);
  if (!tool) {
    return {
      kind: "not_build_tool",
      tool: null,
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
    };
  }

  const strArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];

  if (tool === "gradle") {
    if (strArgs.includes("--stop")) {
      return {
        kind: "deny_lifecycle",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        reason:
          'Direct "gradle --stop" is disabled under ATC because it terminates shared Gradle daemons across all active worktrees.',
      };
    }
    if (strArgs.includes("--continuous") || strArgs.includes("-t")) {
      return {
        kind: "reject_long_running",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: true,
        requiresWorkspaceLock: true,
        reason:
          'Long-running "gradle --continuous" (-t) cannot hold a coordinated build slot indefinitely; run bounded build tasks instead.',
      };
    }

    const tasks = [];
    for (let i = 0; i < strArgs.length; i++) {
      const arg = strArgs[i];
      if (arg === "--") break;
      if (arg === "-x" || arg === "--exclude-task") {
        i++;
        continue;
      }
      if (arg.startsWith("--exclude-task=")) continue;
      if (GRADLE_VALUE_FLAGS.has(arg)) {
        i++;
        continue;
      }
      if (
        arg === "--version" ||
        arg === "-v" ||
        arg === "--help" ||
        arg === "-h" ||
        arg === "-?" ||
        arg === "--status"
      ) {
        tasks.push({ raw: arg, metaOnly: true });
        continue;
      }
      if (arg.startsWith("-")) continue;
      tasks.push({ raw: arg, metaOnly: false });
    }

    if (tasks.length > 0 && tasks.every((t) => t.metaOnly)) {
      return {
        kind: "read_only",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    const taskNames = tasks
      .filter((t) => !t.metaOnly)
      .map((t) => {
        const parts = t.raw.split(":");
        return parts[parts.length - 1];
      });

    if (taskNames.length > 0 && taskNames.every((name) => GRADLE_WORKSPACE_ONLY_TASKS.has(name))) {
      return {
        kind: "workspace_only",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: true,
        tasks: taskNames,
      };
    }

    const requiresDevice = taskNames.some(isGradleDeviceTaskName);
    return {
      kind: requiresDevice ? "device_coupled_build" : "pure_build",
      tool: "gradle",
      targetPlatform: requiresDevice ? "android" : null,
      requiresDevice,
      requiresHeavySlot: true,
      requiresWorkspaceLock: true,
      tasks: taskNames,
    };
  }

  if (tool === "bazel") {
    let subcmd = null;
    let subcmdIdx = -1;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      if (BAZEL_SUBCOMMANDS.has(a)) {
        subcmd = a;
        subcmdIdx = i;
        break;
      }
    }
    const restArgs = subcmdIdx >= 0 ? strArgs.slice(subcmdIdx + 1) : strArgs;
    const dashDashIdx = restArgs.indexOf("--");
    const bazelFlags = dashDashIdx >= 0 ? restArgs.slice(0, dashDashIdx) : restArgs;

    if (
      subcmd === "shutdown" ||
      (subcmd === "clean" &&
        bazelFlags.some((a) => a === "--expunge" || a === "--expunge_async"))
    ) {
      const label = subcmd === "clean" ? "bazel clean --expunge" : "bazel shutdown";
      return {
        kind: "deny_lifecycle",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        reason: `Direct "${label}" is disabled under ATC because it disrupts active workspace Bazel servers.`,
      };
    }

    if (
      !subcmd &&
      (strArgs.length === 0 ||
        strArgs.includes("--version") ||
        strArgs.includes("--help") ||
        strArgs.includes("-h"))
    ) {
      return {
        kind: "read_only",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    if (
      subcmd === "version" ||
      subcmd === "help" ||
      bazelFlags.includes("--version") ||
      bazelFlags.includes("--help") ||
      bazelFlags.includes("-h")
    ) {
      return {
        kind: "read_only",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    if (
      [
        "query",
        "cquery",
        "aquery",
        "fetch",
        "sync",
        "info",
        "dump",
        "config",
        "mod",
        "license",
        "clean",
      ].includes(subcmd)
    ) {
      return {
        kind: "workspace_only",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: true,
        subcommand: subcmd,
      };
    }

    const hasIosDeviceFlag = bazelFlags.some(
      (a) => a === "--ios_simulator_device" || a.startsWith("--ios_simulator_device="),
    );
    const hasAndroidDeviceFlag = bazelFlags.some(
      (a) =>
        a === "--device" ||
        a.startsWith("--device=") ||
        a.startsWith("--test_arg=--device="),
    );
    const hasDeviceFlag = hasIosDeviceFlag || hasAndroidDeviceFlag;
    const requiresDevice =
      subcmd === "mobile-install" || ((subcmd === "test" || subcmd === "run") && hasDeviceFlag);
    const targetPlatform = requiresDevice ? (hasIosDeviceFlag ? "ios" : "android") : null;

    if (subcmd === "run" && !requiresDevice) {
      const boundedBuildOnly =
        bazelFlags.includes("--norun") || bazelFlags.some((a) => a.startsWith("--script_path"));
      if (!boundedBuildOnly) {
        return {
          kind: "reject_long_running",
          tool: "bazel",
          targetPlatform: null,
          requiresDevice: false,
          requiresHeavySlot: true,
          requiresWorkspaceLock: true,
          reason:
            'Unbounded "bazel run" can hold a build slot indefinitely; pass "--norun" or "--script_path" to build only, or run the built binary outside "atc exec --build".',
        };
      }
    }

    return {
      kind: requiresDevice ? "device_coupled_build" : "pure_build",
      tool: "bazel",
      targetPlatform,
      requiresDevice,
      requiresHeavySlot: true,
      requiresWorkspaceLock: true,
      subcommand: subcmd,
    };
  }

  if (tool === "xcodebuild") {
    if (
      strArgs.includes("-version") ||
      strArgs.includes("-showsdks") ||
      strArgs.includes("-usage") ||
      strArgs.includes("-help") ||
      strArgs.includes("--help")
    ) {
      return {
        kind: "read_only",
        tool: "xcodebuild",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    if (
      strArgs.includes("-list") ||
      strArgs.includes("-showBuildSettings") ||
      strArgs.includes("-showDestinations") ||
      strArgs.includes("-showTestPlans")
    ) {
      return {
        kind: "workspace_only",
        tool: "xcodebuild",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: true,
      };
    }

    const buildActions = [];
    const destinations = [];
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "-destination" && i + 1 < strArgs.length) {
        destinations.push(strArgs[i + 1]);
        i++;
        continue;
      }
      if (a.startsWith("-destination=")) {
        destinations.push(a.slice("-destination=".length));
        continue;
      }
      if (XCODEBUILD_VALUE_FLAGS.has(a) && i + 1 < strArgs.length) {
        i++;
        continue;
      }
      if (a.startsWith("-") || a.includes("=")) continue;
      buildActions.push(a.toLowerCase());
    }

    const hasFullTest = buildActions.includes("test");
    const hasTestWithoutBuilding = buildActions.includes("test-without-building");
    const hasAnyTest = hasFullTest || hasTestWithoutBuilding;

    const isNonDeviceDestination =
      destinations.length > 0 &&
      destinations.every(
        (d) => /\bplatform=macOS\b/i.test(d) || /\bgeneric\/platform=/i.test(d),
      );

    const requiresDevice = hasAnyTest && !isNonDeviceDestination;
    const requiresHeavySlot =
      !hasTestWithoutBuilding ||
      hasFullTest ||
      buildActions.includes("build") ||
      buildActions.includes("build-for-testing") ||
      buildActions.includes("archive") ||
      buildActions.includes("analyze");

    if (requiresDevice) {
      return {
        kind: "device_coupled_build",
        tool: "xcodebuild",
        targetPlatform: "ios",
        requiresDevice: true,
        requiresHeavySlot,
        requiresWorkspaceLock: true,
        actions: buildActions,
      };
    }

    return {
      kind: requiresHeavySlot ? "pure_build" : "workspace_only",
      tool: "xcodebuild",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot,
      requiresWorkspaceLock: true,
      actions: buildActions,
    };
  }

  return {
    kind: "not_build_tool",
    tool: null,
    targetPlatform: null,
    requiresDevice: false,
    requiresHeavySlot: false,
    requiresWorkspaceLock: false,
  };
}

function findNearestMarkerAncestor(startDir, markerFiles) {
  let cur = path.resolve(startDir);
  for (let depth = 0; depth < 32; depth++) {
    for (const marker of markerFiles) {
      try {
        if (fs.existsSync(path.join(cur, marker))) {
          return cur;
        }
      } catch {
        // Ignore stat error
      }
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

export function resolveBuildResources(
  rawCmd,
  rawArgs = [],
  cwd = process.cwd(),
  { forceBuild = false, inheritedEnvVars = null } = {},
) {
  const { cmd, args, relCwd, envVars, allBuildClauses } = peelBuildWrapperTokens(rawCmd, rawArgs);
  const effectiveEnvVars = { ...(inheritedEnvVars || {}), ...(envVars || {}) };
  const outerCwd = path.resolve(cwd || process.cwd());
  if (allBuildClauses && allBuildClauses.length > 1) {
    const clauseRes = allBuildClauses.map((c) => {
      const clauseCwd = c.relCwd ? path.resolve(outerCwd, c.relCwd) : outerCwd;
      return resolveBuildResources(c.cmd, c.args, clauseCwd, {
        forceBuild: false,
        inheritedEnvVars: c.envVars || effectiveEnvVars,
      });
    });
    const deny = clauseRes.find((r) => r.kind === "deny_lifecycle");
    if (deny) return deny;
    const reject = clauseRes.find((r) => r.kind === "reject_long_running");
    if (reject) return reject;
    const devicePlatforms = Array.from(
      new Set(
        clauseRes
          .filter((r) => r.requiresDevice && r.targetPlatform)
          .map((r) => r.targetPlatform),
      ),
    );
    if (devicePlatforms.length > 1) {
      return {
        kind: "deny_lifecycle",
        tool: clauseRes[0]?.tool || "multi",
        targetPlatform: null,
        requiresDevice: true,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        workspaceRoot: null,
        resourceKeys: [],
        reason:
          "Mixed-platform device-coupled build clauses (Android + iOS) cannot share a single shell wrapper; run each platform's device build in its own atc exec invocation.",
      };
    }
    const requiresDevice = clauseRes.some((r) => r.requiresDevice);
    const requiresHeavySlot = clauseRes.some((r) => r.requiresHeavySlot);
    const requiresWorkspaceLock = clauseRes.some((r) => r.requiresWorkspaceLock);
    const kind = requiresDevice
      ? "device_coupled_build"
      : requiresHeavySlot
        ? "pure_build"
        : requiresWorkspaceLock
          ? "workspace_only"
          : "not_build_tool";
    return {
      ...clauseRes[0],
      kind,
      targetPlatform: clauseRes.find((r) => r.targetPlatform)?.targetPlatform || null,
      requiresDevice,
      requiresHeavySlot,
      requiresWorkspaceLock,
      disablesDaemon: clauseRes.some((r) => r.disablesDaemon),
      workspaceRoot: clauseRes.find((r) => r.workspaceRoot)?.workspaceRoot || null,
      resourceKeys: Array.from(new Set(clauseRes.flatMap((r) => r.resourceKeys || []))),
      clauseBuildReqs: clauseRes.filter((r) => r.requiresHeavySlot),
    };
  }
  const classified = classifyBuildCommand(cmd, args);
  const baseCwd = relCwd ? path.resolve(outerCwd, relCwd) : outerCwd;
  if (classified.kind === "not_build_tool") {
    if (forceBuild) {
      const canonicalRoot = canonicalizeBuildPath(baseCwd);
      return {
        kind: "pure_build",
        tool: "custom",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: true,
        requiresWorkspaceLock: true,
        workspaceRoot: canonicalRoot,
        resourceKeys: [`workspace:${canonicalRoot}`],
      };
    }
    return {
      ...classified,
      workspaceRoot: null,
      resourceKeys: [],
    };
  }
  if (!classified.requiresWorkspaceLock) {
    return {
      ...classified,
      workspaceRoot: null,
      resourceKeys: [],
    };
  }

  const strArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];

  if (classified.tool === "gradle") {
    let projectDir = null;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--") break;
      if ((a === "-p" || a === "--project-dir") && i + 1 < strArgs.length) {
        projectDir = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("--project-dir=")) {
        projectDir = path.resolve(baseCwd, a.slice("--project-dir=".length));
      } else if (a.startsWith("-p=") && a.length > 3) {
        projectDir = path.resolve(baseCwd, a.slice(3));
      }
    }

    let searchStart = projectDir;
    if (!searchStart && cmd && (cmd.includes("/") || cmd.includes("\\"))) {
      const resolvedCmd = path.resolve(baseCwd, cmd);
      try {
        if (fs.existsSync(resolvedCmd) && fs.statSync(resolvedCmd).isFile()) {
          searchStart = path.dirname(resolvedCmd);
        }
      } catch {
        // Fallback to baseCwd
      }
    }
    if (!searchStart) {
      searchStart = baseCwd;
    }

    const rootDir =
      findNearestMarkerAncestor(searchStart, [
        "settings.gradle.kts",
        "settings.gradle",
        "gradlew",
        "gradlew.bat",
      ]) ||
      findNearestMarkerAncestor(searchStart, ["build.gradle.kts", "build.gradle"]) ||
      searchStart;

    const canonicalRoot = canonicalizeBuildPath(rootDir);
    const disablesDaemon = strArgs.some(
      (a) =>
        a === "--no-daemon" ||
        a === "-Dorg.gradle.daemon=false" ||
        a.startsWith("-Dorg.gradle.jvmargs=") ||
        a.startsWith("-Dorg.gradle.java.home=") ||
        a === "--java-home" ||
        a.startsWith("--java-home=") ||
        a === "-g" ||
        a === "--gradle-user-home" ||
        a.startsWith("--gradle-user-home="),
    );
    return {
      ...classified,
      disablesDaemon,
      envJavaHome: effectiveEnvVars.JAVA_HOME || null,
      workspaceRoot: canonicalRoot,
      resourceKeys: [`gradle:${canonicalRoot}`],
    };
  }

  if (classified.tool === "bazel") {
    let outputBase = null;
    let disablesDaemon = false;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--batch") {
        disablesDaemon = true;
        continue;
      }
      if (a === "--nobatch") {
        disablesDaemon = false;
        continue;
      }
      if (a === "--output_base" && i + 1 < strArgs.length) {
        outputBase = path.resolve(baseCwd, strArgs[++i]);
        continue;
      }
      if (a.startsWith("--output_base=")) {
        outputBase = path.resolve(baseCwd, a.slice("--output_base=".length));
        continue;
      }
      if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith("-") && BAZEL_SUBCOMMANDS.has(a)) {
        break;
      }
    }

    const rootDir =
      findNearestMarkerAncestor(baseCwd, [
        "MODULE.bazel",
        "REPO.bazel",
        "WORKSPACE.bazel",
        "WORKSPACE",
      ]) || baseCwd;

    const canonicalRoot = canonicalizeBuildPath(rootDir);
    const resourceKeys = [`bazel:ws:${canonicalRoot}`];
    if (outputBase) {
      resourceKeys.push(`bazel:out:${canonicalizeBuildPath(outputBase)}`);
    }
    return {
      ...classified,
      disablesDaemon,
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    };
  }

  if (classified.tool === "xcodebuild") {
    let explicitTargetPath = null;
    let derivedDataPath = null;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if ((a === "-workspace" || a === "-project") && i + 1 < strArgs.length) {
        explicitTargetPath = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("-workspace=")) {
        explicitTargetPath = path.resolve(baseCwd, a.slice("-workspace=".length));
      } else if (a.startsWith("-project=")) {
        explicitTargetPath = path.resolve(baseCwd, a.slice("-project=".length));
      } else if (a === "-derivedDataPath" && i + 1 < strArgs.length) {
        derivedDataPath = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("-derivedDataPath=")) {
        derivedDataPath = path.resolve(baseCwd, a.slice("-derivedDataPath=".length));
      }
    }

    let rootDir = explicitTargetPath ? path.dirname(explicitTargetPath) : null;
    if (!rootDir) {
      let cur = baseCwd;
      for (let depth = 0; depth < 16; depth++) {
        try {
          const entries = fs.readdirSync(cur);
          if (entries.some((e) => e.endsWith(".xcworkspace") || e.endsWith(".xcodeproj"))) {
            rootDir = cur;
            break;
          }
        } catch {
          break;
        }
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
    }
    const canonicalRoot = canonicalizeBuildPath(rootDir || baseCwd);
    const resourceKeys = [`xcode:${canonicalRoot}`];
    if (derivedDataPath) {
      resourceKeys.push(`xcode:dd:${canonicalizeBuildPath(derivedDataPath)}`);
    }
    return {
      ...classified,
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    };
  }

  return {
    ...classified,
    workspaceRoot: null,
    resourceKeys: [],
  };
}

export function computeEffectiveMaxBuilds(cfg = {}, host = null) {
  const rawMax = cfg?.maxConcurrentBuilds;
  if (typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax >= 1) {
    return rawMax;
  }
  if (typeof rawMax === "string" && /^\d+$/.test(rawMax.trim()) && Number(rawMax) >= 1) {
    return Number(rawMax);
  }
  const cores = host?.cpuCores || os.availableParallelism();
  const totalRamMb = host?.totalRamMb || Math.round(os.totalmem() / (1024 * 1024));
  const totalRamGb = totalRamMb / 1024;
  const cpuBound = Math.max(1, Math.floor(cores / 4));
  const ramBound = totalRamGb < 24 ? 1 : totalRamGb < 48 ? 2 : totalRamGb < 96 ? 3 : 4;
  return Math.max(1, Math.min(4, cpuBound, ramBound));
}

export function computeBuildPoolSnapshot(state, host = null) {
  const cfg = state?.config || {};
  const activeWorkspaces = new Set();
  let activeHeavyBuilds = 0;
  let activeTotalBuilds = 0;

  for (const bLease of Object.values(state?.buildLeases || {})) {
    if (!bLease || (bLease.state !== "active" && bLease.state !== "draining")) continue;
    activeTotalBuilds++;
    if (bLease.requiresHeavySlot) {
      activeHeavyBuilds++;
    }
    for (const key of bLease.resourceKeys || []) {
      activeWorkspaces.add(key);
    }
  }

  const baseMaxBuilds = computeEffectiveMaxBuilds(cfg, host);
  const burstBuilds = Math.max(0, Number(cfg.maxDeviceHolderBurstBuilds ?? 1));
  return {
    activeWorkspaces,
    lockedWorkspaces: activeWorkspaces,
    activeHeavyBuilds,
    usedBuildSlots: activeHeavyBuilds,
    activeTotalBuilds,
    baseMaxBuilds,
    burstBuilds,
    burstSlots: burstBuilds,
    effectiveMaxBuilds: baseMaxBuilds,
    totalCapacity: baseMaxBuilds + burstBuilds,
  };
}

export function hasValidPinnedDeviceLease(ticket, leasesByDeviceKey = {}) {
  if (!ticket || (!ticket.pinnedDeviceKey && !ticket.pinnedDeviceLeaseId)) return false;
  if (ticket.pinnedDeviceKey && leasesByDeviceKey[ticket.pinnedDeviceKey]) {
    const lease = leasesByDeviceKey[ticket.pinnedDeviceKey];
    return Boolean(
      lease &&
        (!ticket.pinnedDeviceLeaseId || lease.leaseId === ticket.pinnedDeviceLeaseId) &&
        lease.sessionId === ticket.sessionId &&
        lease.state === "active" &&
        lease.firstSeenOfflineAtMs == null,
    );
  }
  if (ticket.pinnedDeviceLeaseId) {
    for (const lease of Object.values(leasesByDeviceKey || {})) {
      if (
        lease &&
        lease.leaseId === ticket.pinnedDeviceLeaseId &&
        lease.sessionId === ticket.sessionId &&
        lease.state === "active" &&
        lease.firstSeenOfflineAtMs == null
      ) {
        return true;
      }
    }
  }
  return false;
}

export function pruneAndSelectNextBuildTicket(
  queue,
  stateView,
  now,
  {
    reorderWindowMs = 120_000,
    hbTimeoutMs = 10_000,
    livenessCheck = () => true,
    currentTicketId = null,
  } = {},
) {
  const activeWorkspaces = stateView.activeWorkspaces || new Set();
  const activeHeavyBuilds = stateView.activeHeavyBuilds ?? 0;
  const maxHostBuilds = stateView.maxHostBuilds ?? 1;
  const burstBuilds = Math.max(0, Number(stateView.burstBuilds ?? 0));
  const leases = stateView.leases || {};
  const pruned = [];

  for (let i = queue.length - 1; i >= 0; i--) {
    const t = queue[i];
    if (!t || typeof t !== "object") {
      queue.splice(i, 1);
      continue;
    }
    const isCurrentCallerTicket = Boolean(currentTicketId && t.ticketId === currentTicketId);
    const deadWaiter = !t.waiterPid || !livenessCheck(t.waiterPid);
    const waitExpired =
      !isCurrentCallerTicket &&
      typeof t.waitExpiresAtMs === "number" &&
      now >= t.waitExpiresAtMs;
    const hbExpired =
      !isCurrentCallerTicket &&
      typeof t.lastHeartbeatAtMs === "number" &&
      now >= t.lastHeartbeatAtMs + hbTimeoutMs;
    const expired = waitExpired || hbExpired;
    const lostDevice =
      Boolean(t.pinnedDeviceLeaseId || t.pinnedDeviceKey) &&
      !hasValidPinnedDeviceLease(t, leases);
    if (deadWaiter || expired || lostDevice) {
      queue.splice(i, 1);
      pruned.push({
        ticketId: t.ticketId,
        sessionId: t.sessionId,
        reason: lostDevice ? "lost_device_lease" : expired ? "expired" : "dead_waiter",
      });
    }
  }

  function isTicketDeviceAvailable(ticket) {
    if (!ticket.requiresDeviceCoAlloc && !ticket.coAllocResourceKey) return true;
    if (typeof stateView.isDeviceAvailableForTicket === "function") {
      return Boolean(stateView.isDeviceAvailableForTicket(ticket));
    }
    if (typeof ticket.deviceAvailableForCoAlloc === "boolean") {
      return ticket.deviceAvailableForCoAlloc;
    }
    return stateView.deviceAvailableForCoAlloc !== false;
  }

  function getTicketCoAllocResourceKey(ticket) {
    return ticket.coAllocResourceKey || "device";
  }

  function missingResources(ticket) {
    const missing = new Set();
    for (const ws of ticket.resourceKeys || []) {
      if (activeWorkspaces.has(ws)) missing.add(`ws:${ws}`);
    }
    const hasDev = Boolean(ticket.pinnedDeviceLeaseId || ticket.requiresDeviceCoAlloc);
    const isStarved =
      typeof ticket.starvationDeadlineMs === "number" && now >= ticket.starvationDeadlineMs;
    const effectiveCeiling =
      hasDev || isStarved ? maxHostBuilds + burstBuilds : maxHostBuilds;
    if (ticket.requiresHeavySlot && activeHeavyBuilds >= effectiveCeiling) {
      missing.add("host:heavy_slot");
    }
    if (ticket.requiresDeviceCoAlloc && !isTicketDeviceAvailable(ticket)) {
      missing.add(getTicketCoAllocResourceKey(ticket));
    }
    return missing;
  }

  function providedResources(ticket) {
    const used = new Set();
    for (const ws of ticket.resourceKeys || []) {
      used.add(`ws:${ws}`);
    }
    if (ticket.requiresHeavySlot) used.add("host:heavy_slot");
    if (ticket.requiresDeviceCoAlloc) used.add(getTicketCoAllocResourceKey(ticket));
    return used;
  }

  const eligible = [];
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    if (missingResources(t).size === 0) {
      eligible.push({ idx: i, ticket: t });
    }
  }
  if (eligible.length === 0) return { chosenIdx: -1, pruned };

  const ranked = [...eligible].sort((a, b) => {
    const aStarved = now >= a.ticket.starvationDeadlineMs;
    const bStarved = now >= b.ticket.starvationDeadlineMs;
    if (aStarved !== bStarved) return aStarved ? -1 : 1;
    const aHasDev = Boolean(a.ticket.pinnedDeviceLeaseId || a.ticket.requiresDeviceCoAlloc);
    const bHasDev = Boolean(b.ticket.pinnedDeviceLeaseId || b.ticket.requiresDeviceCoAlloc);
    if (aHasDev !== bHasDev) return aHasDev ? -1 : 1;
    const aSeq = a.ticket.seq ?? a.ticket.enqueuedAtMs;
    const bSeq = b.ticket.seq ?? b.ticket.enqueuedAtMs;
    return a.ticket.enqueuedAtMs - b.ticket.enqueuedAtMs || aSeq - bSeq;
  });

  for (const cand of ranked) {
    const candUsed = providedResources(cand.ticket);
    const candHasDev = Boolean(cand.ticket.pinnedDeviceLeaseId || cand.ticket.requiresDeviceCoAlloc);
    let blockedByEarlier = false;

    for (let j = 0; j < cand.idx; j++) {
      const earlier = queue[j];
      const earlierMissing = missingResources(earlier);
      const earlierHasDev = Boolean(
        earlier.pinnedDeviceLeaseId || earlier.requiresDeviceCoAlloc,
      );

      if (earlierMissing.size === 0) {
        const canOvertake =
          candHasDev &&
          !earlierHasDev &&
          now < earlier.starvationDeadlineMs &&
          cand.ticket.enqueuedAtMs - earlier.enqueuedAtMs <= reorderWindowMs;
        if (!canOvertake) {
          blockedByEarlier = true;
          break;
        }
      } else if (now >= earlier.starvationDeadlineMs) {
        for (const m of earlierMissing) {
          if (candUsed.has(m)) {
            blockedByEarlier = true;
            break;
          }
        }
        if (blockedByEarlier) break;
      }
    }
    if (!blockedByEarlier) {
      return { chosenIdx: cand.idx, pruned };
    }
  }
  return { chosenIdx: -1, pruned };
}

export function computeUnaccountedBuildRamMb(
  state,
  hostSnapshotSampledAtMs,
  nowMs,
  { excludeBuildId = null } = {},
) {
  let unaccountedBuildRamMb = 0;
  const sampledAtMs =
    typeof hostSnapshotSampledAtMs === "number" && Number.isFinite(hostSnapshotSampledAtMs)
      ? hostSnapshotSampledAtMs
      : nowMs;
  for (const bLease of Object.values(state?.buildLeases || {})) {
    if (!bLease || !bLease.requiresHeavySlot) continue;
    if (excludeBuildId && bLease.buildId === excludeBuildId) continue;
    if (bLease.state !== "active" && bLease.state !== "draining") continue;
    const isPreparingDevice = Boolean(bLease.preparingDevice && bLease.state === "active");
    const withinHorizon =
      typeof bLease.ramReservationUntilMs === "number" && nowMs < bLease.ramReservationUntilMs;
    const admittedAfterSnapshot =
      typeof bLease.createdAtMs === "number" && bLease.createdAtMs >= sampledAtMs;
    if (isPreparingDevice || withinHorizon || admittedAfterSnapshot) {
      unaccountedBuildRamMb += bLease.reservedRamMb || (state?.config?.buildRamEstimateMb ?? 3072);
    }
  }
  return unaccountedBuildRamMb;
}

export function checkUnifiedRamAdmission(
  state,
  hostSnapshot,
  prospectiveDemandMb,
  nowMs,
  { minFreeRamMb = null, hysteresisMb = null, onlineDeviceKeys = new Set() } = {},
) {
  const cfg = state?.config || {};
  const effectiveMinFreeMb = minFreeRamMb ?? cfg.minFreeRamMb ?? 2048;
  const effectiveHysteresisMb = hysteresisMb ?? cfg.buildRamHysteresisMb ?? 256;
  const sampledAtMs =
    typeof hostSnapshot?.sampledAtMs === "number" ? hostSnapshot.sampledAtMs : nowMs;
  const freeRamMb = hostSnapshot?.freeRamMb ?? hostSnapshot?.availableRamMb ?? 4096;

  let unaccountedRamMb = 0;
  for (const lease of Object.values(state?.leases || {})) {
    if (!lease || lease.kind !== "emulator") continue;
    const leaseOnline = Boolean(
      (lease.deviceKey && onlineDeviceKeys.has(lease.deviceKey)) ||
        (lease.avd && onlineDeviceKeys.has(lease.avd)) ||
        (lease.udid && onlineDeviceKeys.has(lease.udid)),
    );
    const isStarting = lease.state === "starting" && !leaseOnline;
    const isRecentlyActivated =
      lease.state === "active" &&
      lease.firstSeenOfflineAtMs == null &&
      !leaseOnline &&
      typeof lease.activatedAtMs === "number" &&
      nowMs - lease.activatedAtMs < 30_000;
    const notInSnapshot =
      typeof lease.claimedAtMs === "number" && lease.claimedAtMs >= sampledAtMs;
    if (isStarting || isRecentlyActivated || notInSnapshot) {
      const leaseOverheadMb =
        (lease.platform || "android") === "ios"
          ? (cfg.simOverheadRamMb ?? 1280)
          : (cfg.qemuOverheadRamMb ?? 1024);
      unaccountedRamMb +=
        lease.requiredRamMb ||
        ((lease.platform || "android") === "ios" ? leaseOverheadMb : 2048 + leaseOverheadMb);
    }
  }

  unaccountedRamMb += computeUnaccountedBuildRamMb(state, sampledAtMs, nowMs);

  const effectiveFreeMb = freeRamMb - unaccountedRamMb - prospectiveDemandMb;
  return {
    allowed: effectiveFreeMb >= effectiveMinFreeMb + effectiveHysteresisMb,
    effectiveFreeMb,
    unaccountedRamMb,
    requiredFloorMb: effectiveMinFreeMb + effectiveHysteresisMb,
  };
}

export function reconcileBuildLease(
  lease,
  nowMs,
  {
    clientGroupAlive = false,
    abortedOrTimedOut = false,
    abortCooldownMs = 5_000,
    maxDrainingMs = 30_000,
  } = {},
) {
  if (!lease || typeof lease !== "object") {
    return { action: "delete_lease" };
  }
  if (lease.state === "active") {
    if (!clientGroupAlive && !abortedOrTimedOut) {
      return { action: "delete_lease" };
    }
    return {
      action: "mark_draining",
      lease: {
        ...lease,
        state: "draining",
        drainingStartedAtMs: nowMs,
        drainingCooldownUntilMs: abortedOrTimedOut ? nowMs + abortCooldownMs : nowMs,
        drainingDeadlineMs: nowMs + maxDrainingMs,
      },
    };
  }
  if (lease.state === "draining") {
    const cooldownDone = nowMs >= (lease.drainingCooldownUntilMs || 0);
    const pastMaxHorizon = nowMs >= (lease.drainingDeadlineMs || Infinity);
    if ((!clientGroupAlive && cooldownDone) || pastMaxHorizon) {
      return {
        action: "delete_lease",
        forcedByHorizon: Boolean(pastMaxHorizon && clientGroupAlive),
      };
    }
    return { action: "keep_draining", lease };
  }
  return { action: "delete_lease" };
}

const BUILD_DAEMON_PROCESS_RE =
  /\b(GradleDaemon|org\.gradle\.launcher\.daemon|kotlin-daemon|KotlinCompileDaemon|bazel\([A-Za-z0-9_.-]+\)|bazel-real|xcbbuildservice|SWBBuildService)\b/i;

export function isProcessSpawnedByBuildDaemon(processChain = []) {
  if (!Array.isArray(processChain)) return false;
  return processChain.some(
    (proc) =>
      proc &&
      (BUILD_DAEMON_PROCESS_RE.test(String(proc.args || "")) ||
        BUILD_DAEMON_PROCESS_RE.test(String(proc.comm || ""))),
  );
}

export function evaluateNestedBuildAdmission(
  state,
  {
    inheritedOpId = null,
    inheritedNonce = null,
    ancestorPids = [],
    processChain = [],
    requestedKeys = [],
    requiresHeavySlot = false,
    requiresDevice = false,
    hasActiveDeviceLease = false,
    livenessCheck = () => true,
  } = {},
) {
  if (!inheritedOpId || !inheritedNonce) {
    return { reentrant: false, deadlockHazard: false, reason: "no_op_env" };
  }
  const activeBuildLease = Object.values(state?.buildLeases || {}).find(
    (b) =>
      b &&
      b.opId === inheritedOpId &&
      b.opNonce === inheritedNonce &&
      b.state === "active",
  );
  if (!activeBuildLease) {
    return { reentrant: false, deadlockHazard: false, reason: "inactive_or_mismatched_op" };
  }
  const parentWorkerAlive = Boolean(
    activeBuildLease.workerPid && livenessCheck(activeBuildLease.workerPid),
  );
  if (!parentWorkerAlive) {
    return { reentrant: false, deadlockHazard: false, reason: "parent_worker_exited" };
  }

  const ancestorSet = new Set(Array.isArray(ancestorPids) ? ancestorPids.map(Number) : []);
  const callerInClientTree =
    ancestorSet.has(Number(activeBuildLease.workerPid)) ||
    (activeBuildLease.execWrapperPid && ancestorSet.has(Number(activeBuildLease.execWrapperPid)));
  const callerSpawnedByBuildDaemon = isProcessSpawnedByBuildDaemon(processChain);

  if (!callerInClientTree && !callerSpawnedByBuildDaemon) {
    return {
      reentrant: false,
      deadlockHazard: false,
      reason: "caller_not_in_client_or_daemon_tree",
    };
  }

  const extractKeyPath = (keyStr) => {
    const s = String(keyStr || "");
    const firstColon = s.indexOf(":");
    if (firstColon === -1) return "";
    const rest = s.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (
      secondColon !== -1 &&
      ["ws", "out", "dir", "dd"].includes(rest.slice(0, secondColon))
    ) {
      return rest.slice(secondColon + 1);
    }
    return rest;
  };

  const heldKeys = new Set(activeBuildLease.resourceKeys || []);
  const heldRoots = new Set();
  if (activeBuildLease.workspaceRoot) {
    heldRoots.add(String(activeBuildLease.workspaceRoot));
  }
  for (const hk of heldKeys) {
    const p = extractKeyPath(hk);
    if (p) heldRoots.add(p);
  }

  const otherHeldKeys = new Set();
  for (const b of Object.values(state?.buildLeases || {})) {
    if (!b || b.buildId === activeBuildLease.buildId) continue;
    if (b.state !== "active" && b.state !== "draining") continue;
    for (const ok of b.resourceKeys || []) {
      otherHeldKeys.add(ok);
    }
  }

  const deltaKeys = [];
  for (const k of requestedKeys || []) {
    if (heldKeys.has(k)) continue;
    const reqPath = extractKeyPath(k);
    const inSameWorkspace =
      Boolean(reqPath) &&
      Array.from(heldRoots).some(
        (root) =>
          reqPath === root ||
          reqPath.startsWith(`${root}/`) ||
          reqPath.startsWith(`${root}\\`),
      );
    if (inSameWorkspace && !otherHeldKeys.has(k)) {
      deltaKeys.push(k);
      continue;
    }
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build requests workspace resource "${k}" not held by parent build operation ${activeBuildLease.buildId} (held: ${Array.from(heldKeys).join(", ")}). Failing fast to prevent self-deadlock.`,
    };
  }
  if (requiresHeavySlot && !activeBuildLease.requiresHeavySlot) {
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build escalates from workspace-only query to a heavy compilation slot inside parent build operation ${activeBuildLease.buildId}. Failing fast to prevent self-deadlock.`,
    };
  }
  if (requiresDevice && !hasActiveDeviceLease) {
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build escalates to require a device lease inside parent build operation ${activeBuildLease.buildId} while holding no active device lease. Failing fast to prevent self-deadlock.`,
    };
  }

  if (deltaKeys.length > 0) {
    activeBuildLease.resourceKeys = Array.from(new Set([...heldKeys, ...deltaKeys]));
  }

  return {
    reentrant: true,
    deadlockHazard: false,
    buildLease: activeBuildLease,
    deltaKeys,
  };
}

export function probeWarmBuildDaemons(buildReqs, options = {}) {
  if (Array.isArray(buildReqs?.clauseBuildReqs) && buildReqs.clauseBuildReqs.length > 1) {
    const subProbes = buildReqs.clauseBuildReqs.map((sub) =>
      probeWarmBuildDaemons({ ...sub, clauseBuildReqs: null }, options),
    );
    return {
      warm: subProbes.length > 0 && subProbes.every((p) => p.warm),
      daemonPids: Array.from(new Set(subProbes.flatMap((p) => p.daemonPids || []))),
    };
  }
  if (
    !buildReqs ||
    (buildReqs.tool !== "gradle" && buildReqs.tool !== "bazel") ||
    buildReqs.disablesDaemon
  ) {
    return { warm: false, daemonPids: [] };
  }
  if (typeof options.warmBuildDaemon === "boolean") {
    return { warm: options.warmBuildDaemon, daemonPids: [] };
  }
  if (Array.isArray(options.inventory?.warmBuildDaemons)) {
    const matched = options.inventory.warmBuildDaemons.filter((d) => {
      if (!d) return false;
      if (typeof d === "string") return d === buildReqs.tool || d === buildReqs.workspaceRoot;
      if (d.tool && d.tool !== buildReqs.tool) return false;
      if (d.workspaceRoot && buildReqs.workspaceRoot && d.workspaceRoot !== buildReqs.workspaceRoot) {
        return false;
      }
      return true;
    });
    return {
      warm: matched.length > 0,
      daemonPids: matched.map((d) => d.pid).filter(Boolean),
    };
  }
  if (options.inventory && !options.runner && !options.spawnSyncFn) {
    return { warm: false, daemonPids: [] };
  }
  const platform = options.platform || process.platform;
  if (platform === "win32" && !options.runner && !options.spawnSyncFn) {
    return { warm: false, daemonPids: [] };
  }
  try {
    let stdout = "";
    if (typeof options.runner === "function") {
      const res = options.runner("ps", ["-ax", "-o", "pid=,command="]);
      stdout = String(res?.stdout || "");
    } else {
      const spawnFn = options.spawnSyncFn || spawnSync;
      const res = spawnFn("ps", ["-ax", "-o", "pid=,command="], {
        encoding: "utf8",
        timeout: 2000,
      });
      if (res?.status === 0 || typeof res?.stdout === "string") {
        stdout = String(res.stdout || "");
      }
    }
    if (!stdout) return { warm: false, daemonPids: [] };
    const daemonPids = [];
    const wsRoot = String(buildReqs.workspaceRoot || "");
    const wsBase = wsRoot ? path.basename(wsRoot) : "";
    let expectedGradleVersion = null;
    let expectedGradleJavaHome = buildReqs.envJavaHome || options.env?.JAVA_HOME || null;
    let expectedGradleJvmArgs = [];
    if (buildReqs.tool === "gradle" && wsRoot) {
      try {
        const wrapperPropsPath = path.join(wsRoot, "gradle", "wrapper", "gradle-wrapper.properties");
        if (fs.existsSync(wrapperPropsPath)) {
          const content = fs.readFileSync(wrapperPropsPath, "utf8");
          const verMatch = content.match(/gradle-([0-9.]+(?:-[A-Za-z0-9.]+)?)-(?:bin|all)\.zip/);
          if (verMatch?.[1]) {
            expectedGradleVersion = verMatch[1];
          }
        }
        const gradlePropsPath = path.join(wsRoot, "gradle.properties");
        if (fs.existsSync(gradlePropsPath)) {
          const propsContent = fs.readFileSync(gradlePropsPath, "utf8");
          for (const rawPropLine of propsContent.split(/\r?\n/)) {
            const propLine = rawPropLine.trim();
            if (!propLine || propLine.startsWith("#")) continue;
            const jhMatch = propLine.match(/^org\.gradle\.java\.home\s*=\s*(.+)$/);
            if (jhMatch?.[1]) {
              expectedGradleJavaHome = jhMatch[1].trim().replace(/\\:/g, ":");
            }
            const jvmMatch = propLine.match(/^org\.gradle\.jvmargs\s*=\s*(.+)$/);
            if (jvmMatch?.[1]) {
              expectedGradleJvmArgs = jvmMatch[1]
                .trim()
                .split(/\s+/)
                .filter((tok) => tok.startsWith("-Xm") || tok.startsWith("-XX:"));
            }
          }
        }
      } catch {
        // Ignore wrapper property read errors
      }
    }
    const outKeys = (buildReqs.resourceKeys || [])
      .filter((k) => String(k).startsWith("bazel:out:"))
      .map((k) => String(k).slice("bazel:out:".length));
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmdLine = m[2];
      if (buildReqs.tool === "gradle") {
        if (/GradleDaemon\b/.test(cmdLine)) {
          const verMatch = cmdLine.match(/GradleDaemon\s+([0-9][0-9A-Za-z.-]*)/);
          const daemonVer = verMatch?.[1] || null;
          if (expectedGradleVersion && daemonVer !== expectedGradleVersion) {
            continue;
          }
          if (expectedGradleJavaHome && !cmdLine.includes(expectedGradleJavaHome)) {
            continue;
          }
          if (
            expectedGradleJvmArgs.length > 0 &&
            !expectedGradleJvmArgs.every((arg) => cmdLine.includes(arg))
          ) {
            continue;
          }
          const matchesWorkspaceOrWrapper =
            (wsRoot && cmdLine.includes(wsRoot)) ||
            Boolean(expectedGradleVersion && daemonVer === expectedGradleVersion);
          if (matchesWorkspaceOrWrapper) {
            daemonPids.push(pid);
          }
        }
      } else if (buildReqs.tool === "bazel") {
        const isBazelServer =
          /\bbazel\([^)]+\)/.test(cmdLine) ||
          /com\.google\.devtools\.build\.lib\.bazel\.BazelMain\b/.test(cmdLine);
        if (isBazelServer) {
          const matchesOut = outKeys.some((outPath) => outPath && cmdLine.includes(outPath));
          if (
            matchesOut ||
            !wsRoot ||
            cmdLine.includes(wsRoot) ||
            (wsBase && cmdLine.includes(`bazel(${wsBase})`))
          ) {
            daemonPids.push(pid);
          }
        }
      }
    }
    return { warm: daemonPids.length > 0, daemonPids };
  } catch {
    return { warm: false, daemonPids: [] };
  }
}
