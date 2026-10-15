import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBuildCommand, peelBuildWrapperTokens, tokenizeShellClause } from "./build.mjs";
import {
  archiveWindowsProcessGroupGeneration,
  clearKnownPosixPgidStartTokens,
  getKnownWindowsTreeDescendants,
  getPosixProcessStartToken,
  hasAliveProcessInGroup,
  isProcessGroupAlive,
  killProcessGroupTree,
  seedPosixPgidStartTokens,
  sleepSync,
} from "./lock.mjs";

const SAFE_TOKEN_REGEX = /^[A-Za-z0-9._:/@=-]+$/;

function isPosixExecutableFile(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(
  command,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  defaultPosixPath = "/usr/bin:/bin",
) {
  if (!command || typeof command !== "string") {
    throw new Error("Command must be a non-empty string");
  }
  if (platform !== "win32") {
    if (
      (command === "android" || command === "adb" || command === "emulator") &&
      !command.includes("/")
    ) {
      const rawPath = env.PATH;
      const effectivePath =
        typeof rawPath === "string" ? rawPath : defaultPosixPath;
      const posixPathDirs = effectivePath.split(":");
      const inPath = posixPathDirs.some((dir) =>
        isPosixExecutableFile(path.resolve(cwd, dir || ".", command)),
      );
      if (!inPath) {
        const home = env.HOME || os.homedir();
        const sdkRoot =
          env.ANDROID_HOME ||
          env.ANDROID_SDK_ROOT ||
          (platform === "darwin"
            ? path.join(home, "Library", "Android", "sdk")
            : path.join(home, "Android", "Sdk"));
        const fallbackDirs = [
          path.join(home, ".local", "bin"),
          path.join(sdkRoot, "platform-tools"),
          path.join(sdkRoot, "emulator"),
          path.join(sdkRoot, "cmdline-tools", "latest", "bin"),
        ];
        for (const dir of fallbackDirs) {
          const candidate = path.join(dir, command);
          if (isPosixExecutableFile(candidate)) {
            return { executable: candidate, isBatch: false };
          }
        }
      }
    }
    return { executable: command, isBatch: false };
  }

  const rawExts = (env.PATHEXT || env.PathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  const extensions = Array.from(new Set([".exe", ".cmd", ".bat", ".com", ...rawExts]));

  const hasPathSep = command.includes("/") || command.includes("\\");
  const normalizedCommand = hasPathSep ? command.replace(/\//g, path.sep) : command;
  const lower = normalizedCommand.toLowerCase();
  const isGradlew =
    lower === "gradlew" ||
    lower === "gradlew.bat" ||
    lower === "gradlew.cmd" ||
    lower === "bazelw" ||
    lower === "bazelw.bat" ||
    lower === "bazelw.cmd";
  if (hasPathSep && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    return { executable: path.resolve(cwd, normalizedCommand), isBatch: true };
  }
  if (hasPathSep && (lower.endsWith(".exe") || lower.endsWith(".com"))) {
    return { executable: path.resolve(cwd, normalizedCommand), isBatch: false };
  }

  // Check relative / project-local candidates in cwd first only for explicit path separators or gradlew
  if (hasPathSep || isGradlew) {
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const localBatch = path.resolve(cwd, normalizedCommand);
      try {
        if (fs.existsSync(localBatch) && fs.statSync(localBatch).isFile()) {
          return { executable: localBatch, isBatch: true };
        }
      } catch {
        // Ignore inaccessible local entry
      }
    } else {
      for (const ext of extensions) {
        const localCandidate = path.resolve(cwd, normalizedCommand + ext);
        try {
          if (fs.existsSync(localCandidate) && fs.statSync(localCandidate).isFile()) {
            return {
              executable: localCandidate,
              isBatch: ext === ".cmd" || ext === ".bat",
            };
          }
        } catch {
          // Ignore inaccessible local entry
        }
      }
    }
  }

  if (hasPathSep) {
    return { executable: path.resolve(cwd, normalizedCommand), isBatch: false };
  }

  const pathDirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const userHome = env.USERPROFILE || env.HOME || os.homedir();
  const sdkRoots = Array.from(
    new Set(
      [
        env.ANDROID_HOME,
        env.ANDROID_SDK_ROOT,
        path.join(localAppData, "Android", "Sdk"),
      ].filter(Boolean),
    ),
  );
  for (const sdkRoot of sdkRoots) {
    pathDirs.push(
      path.join(sdkRoot, "platform-tools"),
      path.join(sdkRoot, "emulator"),
      path.join(sdkRoot, "cmdline-tools", "latest", "bin"),
    );
  }
  pathDirs.push(
    path.join(appData, "npm"),
    path.join(userHome, ".local", "bin"),
  );

  const hasExplicitBatchExt = lower.endsWith(".cmd") || lower.endsWith(".bat");
  const hasExplicitBinExt = lower.endsWith(".exe") || lower.endsWith(".com");

  for (const dir of pathDirs) {
    if (hasExplicitBatchExt || hasExplicitBinExt) {
      const candidate = path.join(dir, normalizedCommand);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return {
            executable: candidate,
            isBatch: hasExplicitBatchExt,
          };
        }
      } catch {
        // Ignore inaccessible PATH entry
      }
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(dir, normalizedCommand + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return {
            executable: candidate,
            isBatch: ext === ".cmd" || ext === ".bat",
          };
        }
      } catch {
        // Ignore inaccessible PATH entry
      }
    }
  }

  const bareBase = lower.replace(/\.(exe|cmd|bat|com)$/, "");
  if (
    hasExplicitBatchExt ||
    bareBase === "atc" ||
    bareBase === "adb" ||
    bareBase === "android" ||
    bareBase === "emulator"
  ) {
    const err = new Error(`Executable not found in PATH: ${command}`);
    err.code = "ENOENT";
    throw err;
  }

  return { executable: command, isBatch: false };
}

export function validateBatchArgs(args, strictInternal = false) {
  for (const arg of args) {
    const s = String(arg);
    if (s.includes("\0") || s.includes("\r") || s.includes("\n") || s.includes("%")) {
      throw new Error(`Unsafe character in Windows batch argument: ${JSON.stringify(s)}`);
    }
    if (strictInternal && !SAFE_TOKEN_REGEX.test(s)) {
      throw new Error(`Disallowed token in internal batch invocation: ${JSON.stringify(s)}`);
    }
  }
}

export function buildSpawnConfig(command, args = [], options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const effectiveEnv =
    platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1", ...env } : env;
  const resolved = resolveExecutable(command, env, cwd, platform);

  if (platform === "win32" && resolved.isBatch) {
    if (!path.win32.isAbsolute(resolved.executable)) {
      const err = new Error(`Executable not found in PATH: ${command}`);
      err.code = "ENOENT";
      throw err;
    }
    validateBatchArgs(args, Boolean(options.strictInternal));
    const comspec = env.ComSpec || "cmd.exe";
    const quotedCmd = `"${resolved.executable}" ${args.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(" ")}`;
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${quotedCmd}"`],
      options: {
        ...options,
        env: effectiveEnv,
        shell: false,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: resolved.executable,
    args: args.map(String),
    options: {
      ...options,
      env: effectiveEnv,
      shell: false,
    },
  };
}

export function runCommandSync(command, args = [], options = {}) {
  if (options.detached) {
    let cfg;
    try {
      cfg = buildSpawnConfig(command, args, {
        ...options,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return {
          status: 1,
          signal: null,
          stdout: "",
          stderr: `ENOENT: ${err.message}`,
          error: err,
        };
      }
      throw err;
    }
    const launcherScript = [
      'const { spawn } = require("node:child_process");',
      "const payload = JSON.parse(process.argv[1]);",
      "try {",
      "  const child = spawn(payload.command, payload.args, {",
      "    cwd: payload.cwd,",
      "    env: payload.env,",
      "    detached: true,",
      '    stdio: "ignore",',
      "    windowsHide: true,",
      "    shell: false,",
      "    windowsVerbatimArguments: Boolean(payload.windowsVerbatimArguments),",
      "  });",
      '  child.once("error", (err) => {',
      "    process.stderr.write(String(err && err.message ? err.message : err));",
      "    process.exit(1);",
      "  });",
      '  child.once("spawn", () => {',
      "    child.unref();",
      "    process.exit(0);",
      "  });",
      "} catch (err) {",
      "  process.stderr.write(String(err && err.message ? err.message : err));",
      "  process.exit(1);",
      "}",
    ].join("\n");
    const launchRes = spawnSync(
      process.execPath,
      [
        "-e",
        launcherScript,
        JSON.stringify({
          command: cfg.command,
          args: cfg.args,
          cwd: cfg.options.cwd || process.cwd(),
          env: cfg.options.env || process.env,
          windowsVerbatimArguments: Boolean(cfg.options.windowsVerbatimArguments),
        }),
      ],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 10_000,
        windowsHide: true,
      },
    );
    const ok = launchRes.status === 0 && !launchRes.error && !launchRes.signal;
    return {
      status: ok ? 0 : (launchRes.status ?? 1),
      signal: launchRes.signal || null,
      stdout: launchRes.stdout || "",
      stderr:
        launchRes.stderr ||
        (launchRes.error ? launchRes.error.message : "") ||
        (launchRes.signal ? `Terminated by signal ${launchRes.signal}` : ""),
      error: launchRes.error || null,
    };
  }
  let cfg;
  try {
    cfg = buildSpawnConfig(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      ...options,
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        status: 1,
        signal: null,
        stdout: "",
        stderr: `ENOENT: ${err.message}`,
        error: err,
      };
    }
    throw err;
  }
  const res = spawnSync(cfg.command, cfg.args, cfg.options);
  return {
    status: res.status ?? (res.error || res.signal ? 1 : 0),
    signal: res.signal || null,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.signal ? `Terminated by signal ${res.signal}` : ""),
    error: res.error || null,
  };
}

const ANDROID_VALUE_GLOBAL_FLAGS = new Set([
  "--sdk",
  "--device",
  "-s",
  "--format",
  "--output",
  "--log-level",
  "--config",
  "--project",
  "-p",
  "--duration",
]);

const REMOTE_LIFECYCLE_VERBS = new Set([
  "remove",
  "delete",
  "disconnect",
  "stop",
  "release",
  "create",
  "reserve",
  "connect",
  "add",
  "extend",
]);

function findAndroidSubcommand(args) {
  let subIdx = 0;
  while (subIdx < args.length) {
    const a = String(args[subIdx]);
    if (a === "--") {
      subIdx += 1;
      break;
    }
    if (ANDROID_VALUE_GLOBAL_FLAGS.has(a) && subIdx + 1 < args.length) {
      subIdx += 2;
    } else if (a.startsWith("-")) {
      subIdx += 1;
    } else {
      break;
    }
  }
  const sub = String(args[subIdx] || "");
  let actIdx = subIdx + 1;
  while (actIdx < args.length) {
    const a = String(args[actIdx]);
    if (ANDROID_VALUE_GLOBAL_FLAGS.has(a) && actIdx + 1 < args.length) {
      actIdx += 2;
    } else if (a.startsWith("-")) {
      actIdx += 1;
    } else {
      break;
    }
  }
  const action = String(args[actIdx] || args[subIdx + 1] || "");
  return { subIdx, sub, actIdx, action };
}

export function buildChildInvocation(
  cmd,
  args,
  lease,
  sessionId,
  baseEnv = process.env,
  buildLease = null,
) {
  let effectiveCmd = cmd;
  let effectiveArgs = [...args];
  let useDefaultStandardPath = false;
  while (
    path.basename(effectiveCmd, path.extname(effectiveCmd)).toLowerCase() === "command"
  ) {
    let idx = 0;
    let queryMode = false;
    while (idx < effectiveArgs.length) {
      const a = String(effectiveArgs[idx]);
      if (a === "--") {
        idx++;
        break;
      }
      if (a === "-p") {
        useDefaultStandardPath = true;
        idx++;
        continue;
      }
      if (a.startsWith("-") && /[vV]/.test(a)) {
        queryMode = true;
        break;
      }
      if (a.startsWith("-")) {
        idx++;
        continue;
      }
      break;
    }
    if (queryMode || idx >= effectiveArgs.length) {
      break;
    }
    effectiveCmd = String(effectiveArgs[idx]);
    effectiveArgs = effectiveArgs.slice(idx + 1);
  }
  cmd = effectiveCmd;
  args = effectiveArgs;
  const base = path.basename(cmd, path.extname(cmd)).toLowerCase();
  const buildClassified = classifyBuildCommand(cmd, args);
  if (buildClassified.kind === "deny_lifecycle") {
    throw new Error(buildClassified.reason);
  }
  const androidParsed = base === "android" ? findAndroidSubcommand(args) : null;
  if (base === "emulator") {
    if (!args.includes("-list-avds") && !args.includes("-version") && !args.includes("-help")) {
      throw new Error(
        'Direct emulator launch is disabled under ATC. Use "atc claim --type <type> --api <api>" instead.',
      );
    }
  } else if (base === "android") {
    if (androidParsed.sub === "emulator") {
      const emuAction = androidParsed.action;
      if (
        ["start", "stop", "remove", "create"].includes(emuAction) &&
        !(emuAction === "create" && args.includes("--list-profiles"))
      ) {
        throw new Error(
          `Direct "android emulator ${emuAction}" is disabled under ATC. Use "atc claim" or "atc free --stop" instead.`,
        );
      }
    } else if (androidParsed.sub === "device" && androidParsed.action === "remote") {
      let remIdx = androidParsed.actIdx + 1;
      while (remIdx < args.length) {
        const a = String(args[remIdx]);
        if (ANDROID_VALUE_GLOBAL_FLAGS.has(a) && remIdx + 1 < args.length) {
          remIdx += 2;
        } else if (a.startsWith("-")) {
          remIdx += 1;
        } else {
          break;
        }
      }
      const remoteAction = String(args[remIdx] || "");
      const fallbackVerb = args
        .slice(androidParsed.actIdx + 1)
        .map(String)
        .find((t) => REMOTE_LIFECYCLE_VERBS.has(t));
      const deniedAction = REMOTE_LIFECYCLE_VERBS.has(remoteAction)
        ? remoteAction
        : fallbackVerb ||
          (remoteAction && remoteAction !== "list" && remoteAction !== "status" ? remoteAction : "");
      if (deniedAction && !args.includes("--help") && !args.includes("-h")) {
        throw new Error(
          `Direct "android device remote ${deniedAction}" is disabled under ATC because remote device lifecycle is not isolated per lease.`,
        );
      }
    }
  } else if (base === "adb") {
    let subIdx = 0;
    while (subIdx < args.length) {
      const a = String(args[subIdx]);
      if (a === "-d" || a === "-e" || a === "-t" || a.startsWith("-t")) {
        throw new Error(
          `Non-serial adb device selector "${a}" is not permitted under ATC; use -s "${lease?.serial || "<serial>"}" or omit selector flags to use ANDROID_SERIAL.`,
        );
      }
      if (a === "--one-device" || a.startsWith("--one-device=")) {
        throw new Error(
          'Direct "adb --one-device" is disabled under ATC because it restricts the shared ADB server on the host.',
        );
      }
      if (a.startsWith("-s") && a.length > 2) {
        const inlineSerial = a.slice(2);
        if (lease?.serial && inlineSerial !== lease.serial) {
          throw new Error(
            `Conflicting device selector "${inlineSerial}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
        subIdx += 1;
        continue;
      }
      if (a === "-s" && subIdx + 1 < args.length) {
        const explicitSerial = String(args[subIdx + 1]);
        if (lease?.serial && explicitSerial !== lease.serial) {
          throw new Error(
            `Conflicting device selector "${explicitSerial}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
        subIdx += 2;
        continue;
      }
      if (a === "-s" || a === "-H" || a === "-P" || a === "-L") {
        subIdx += 2;
      } else if (a.startsWith("-")) {
        subIdx += 1;
      } else if (a.startsWith("wait-for-") && subIdx + 1 < args.length) {
        subIdx += 1;
      } else {
        break;
      }
    }
    const adbSub = String(args[subIdx] || "");
    const adbRest = args.slice(subIdx + 1).map(String);
    if (adbSub === "kill-server") {
      throw new Error(
        'Direct "adb kill-server" is disabled under ATC because it disrupts all shared device sessions on the host.',
      );
    }
    if (adbSub === "reconnect") {
      const reconnectTargets = adbRest.filter((a) => !a.startsWith("-"));
      if (reconnectTargets.includes("offline")) {
        throw new Error(
          'Direct "adb reconnect offline" is disabled under ATC because it resets all offline/unauthorized devices on the host.',
        );
      }
      if (reconnectTargets.length !== 1 || reconnectTargets[0] !== "device") {
        throw new Error(
          'Bare "adb reconnect" is disabled under ATC because it resets host-side ADB connections across the host; use "adb reconnect device" instead.',
        );
      }
    }
    if (adbSub === "emu" && adbRest[0] === "kill") {
      throw new Error(
        'Direct "adb emu kill" is disabled under ATC. Use "atc free --stop" instead.',
      );
    }
    if (adbSub === "attach" || adbSub === "detach") {
      const usbTargets = adbRest.filter((a) => !a.startsWith("-"));
      if (usbTargets.length === 0) {
        if (!lease?.serial) {
          throw new Error(
            `Bare "adb ${adbSub}" is disabled under ATC when the lease has no bound serial; specify the leased target serial explicitly.`,
          );
        }
      } else {
        for (const target of usbTargets) {
          if (lease?.serial && target !== lease.serial) {
            throw new Error(
              `Conflicting device selector "${target}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
            );
          }
        }
      }
    }
    if (adbSub === "disconnect") {
      const disconnectTargets = adbRest.filter((a) => !a.startsWith("-"));
      if (disconnectTargets.length === 0) {
        throw new Error(
          'Bare "adb disconnect" is disabled under ATC because it disconnects all TCP/IP devices on the host; specify the leased target serial explicitly.',
        );
      }
      for (const target of disconnectTargets) {
        if (lease?.serial && target !== lease.serial) {
          throw new Error(
            `Conflicting device selector "${target}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
      }
    }
  }

  if (base === "android") {
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]);
      if (a === "--") break;
      let explicitSerial = null;
      if (a.startsWith("--device=")) {
        explicitSerial = a.slice("--device=".length);
      } else if (a === "--device" && i + 1 < args.length) {
        explicitSerial = String(args[i + 1]);
      } else if (a === "-s" && i + 1 < args.length) {
        explicitSerial = String(args[i + 1]);
      }
      if (explicitSerial && lease?.serial && explicitSerial !== lease.serial) {
        throw new Error(
          `Conflicting device selector "${explicitSerial}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
        );
      }
    }
  }

  let nextArgs = [...args];
  if (
    base === "simctl" ||
    (base === "xcrun" && String(nextArgs[0] || "").toLowerCase() === "simctl")
  ) {
    const simctlOffset = base === "xcrun" ? 1 : 0;
    let subIdx = simctlOffset;
    while (subIdx < nextArgs.length && String(nextArgs[subIdx]).startsWith("-")) {
      const flag = String(nextArgs[subIdx]);
      if ((flag === "--set" || flag === "-s") && subIdx + 1 < nextArgs.length) {
        subIdx += 2;
      } else {
        subIdx += 1;
      }
    }
    const simSub = String(nextArgs[subIdx] || "").toLowerCase();
    if (["boot", "shutdown", "erase", "create", "delete", "clone"].includes(simSub)) {
      throw new Error(
        `Direct "xcrun simctl ${simSub}" is disabled under ATC. Use "atc claim --ios" or "atc free --stop" instead.`,
      );
    }
    const readOnlySimSubs = new Set(["list", "help", "diagnose", "getenv"]);
    if (simSub && !readOnlySimSubs.has(simSub) && lease?.serial) {
      // Find first non-flag target argument after simSub
      let targetIdx = subIdx + 1;
      while (targetIdx < nextArgs.length && String(nextArgs[targetIdx]).startsWith("-")) {
        targetIdx += 1;
      }
      if (targetIdx < nextArgs.length) {
        const targetToken = String(nextArgs[targetIdx]);
        if (targetToken.toLowerCase() === "booted") {
          nextArgs[targetIdx] = lease.serial;
        } else if (
          /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(
            targetToken,
          ) &&
          targetToken.toUpperCase() !== String(lease.serial).toUpperCase()
        ) {
          throw new Error(
            `Conflicting device selector "${targetToken}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
      }
    }
  } else if (
    base === "devicectl" ||
    (base === "xcrun" && String(nextArgs[0] || "").toLowerCase() === "devicectl")
  ) {
    const devctlOffset = base === "xcrun" ? 1 : 0;
    let subIdx = devctlOffset;
    while (subIdx < nextArgs.length && String(nextArgs[subIdx]).startsWith("-")) {
      subIdx += 1;
    }
    const devctlSub = String(nextArgs[subIdx] || "").toLowerCase();
    let explicitDevice = null;
    for (let i = devctlOffset; i < nextArgs.length; i++) {
      const a = String(nextArgs[i]);
      if (a.startsWith("--device=")) {
        explicitDevice = a.slice("--device=".length);
        break;
      }
      if ((a === "--device" || a === "-d") && i + 1 < nextArgs.length) {
        explicitDevice = String(nextArgs[i + 1]);
        break;
      }
    }
    const allowedIds = new Set(
      [lease?.serial, lease?.udid, lease?.coreDeviceId, lease?.profile?.coreDeviceId]
        .filter(Boolean)
        .map((s) => String(s).toUpperCase()),
    );
    if (
      explicitDevice &&
      allowedIds.size > 0 &&
      !allowedIds.has(explicitDevice.toUpperCase())
    ) {
      throw new Error(
        `Conflicting device selector "${explicitDevice}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
      );
    }
    const isHelp = nextArgs.includes("--help") || nextArgs.includes("-h");
    if (
      !explicitDevice &&
      !isHelp &&
      lease?.serial &&
      (devctlSub === "device" || devctlSub === "manage")
    ) {
      nextArgs = [...nextArgs, "--device", String(lease.serial)];
    }
  } else if (
    !new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "powershell", "pwsh"]).has(base) &&
    buildClassified.tool === "xcodebuild"
  ) {
    const peeledXb = peelBuildWrapperTokens(effectiveCmd, nextArgs);
    const xbArgs = Array.isArray(peeledXb.args) ? peeledXb.args : nextArgs;
    const explicitDestinations = [];
    for (let i = 0; i < xbArgs.length; i++) {
      const a = String(xbArgs[i]);
      if (a.startsWith("-destination=")) {
        explicitDestinations.push(a.slice("-destination=".length));
      } else if (a === "-destination" && i + 1 < xbArgs.length) {
        explicitDestinations.push(String(xbArgs[i + 1]));
        i++;
      }
    }
    const allowedIds = new Set(
      [lease?.serial, lease?.udid, lease?.coreDeviceId, lease?.profile?.coreDeviceId]
        .filter(Boolean)
        .map((s) => String(s).toUpperCase()),
    );
    if (
      explicitDestinations.length > 0 &&
      allowedIds.size > 0 &&
      (lease?.platform || "android") === "ios"
    ) {
      for (const dest of explicitDestinations) {
        const idMatch = dest.match(/(?:^|,)\s*id=([^,\s]+)/i);
        if (!idMatch || !idMatch[1] || !allowedIds.has(idMatch[1].toUpperCase())) {
          throw new Error(
            `Conflicting device selector "${idMatch?.[1] || dest}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
      }
    }
    const queryFlags = new Set([
      "-list",
      "-showbuildsettings",
      "-showdestinations",
      "-version",
      "-help",
      "--help",
      "-h",
      "-usage",
    ]);
    const isQueryOnly = xbArgs.some((a) => queryFlags.has(String(a).toLowerCase()));
    if (
      explicitDestinations.length === 0 &&
      !isQueryOnly &&
      lease?.serial &&
      (lease.platform || "android") === "ios"
    ) {
      nextArgs = [...nextArgs, "-destination", `id=${lease.serial}`];
    }
  }

  const isShellWrapper = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "cmd",
    "powershell",
    "pwsh",
  ]).has(base);
  if (buildClassified.requiresHeavySlot || buildClassified.requiresDevice || isShellWrapper) {
    const hostCpus = Math.max(1, os.cpus()?.length || 4);
    const maxConcurrent = Math.max(1, Number(buildLease?.maxConcurrentBuilds || 2));
    const jobsLimit = Math.max(
      2,
      Number(buildLease?.jobsLimit || Math.floor(hostCpus / maxConcurrent)),
    );
    const ramLimitMb = Math.max(1024, Number(buildLease?.reservedRamMb || 3072));
    if (isShellWrapper) {
      const cIdx = nextArgs.findIndex(
        (a) => String(a) === "-c" || (/^-[A-Za-z]+$/.test(String(a)) && String(a).includes("c")),
      );
      if (cIdx !== -1 && cIdx + 1 < nextArgs.length) {
        const rawScript = String(nextArgs[cIdx + 1] || "");
        const parts = rawScript.split(/([;\n]|&&|\|\||\|)/);
        const rewrittenParts = parts.map((part, idx) => {
          if (idx % 2 === 1) return part;
          const trimmed = part.trim();
          if (!trimmed) return part;
          const trailingWs = part.match(/(\s*)$/)?.[1] || "";
          const partNoTrail = part.slice(0, part.length - trailingWs.length);
          const redirMatch = partNoTrail.match(/(\s+(?:[0-9]*>>?\s*\S+|2>&1)(?:\s+(?:[0-9]*>>?\s*\S+|2>&1))*)$/);
          const redirSuffix = redirMatch ? redirMatch[1] : "";
          const corePart = redirMatch ? partNoTrail.slice(0, partNoTrail.length - redirMatch[0].length) : partNoTrail;
          const rawTokens = tokenizeShellClause(corePart.trim());
          if (rawTokens.length === 0) return part;
          const peeled = peelBuildWrapperTokens(rawTokens[0], rawTokens.slice(1));
          const cClass = classifyBuildCommand(peeled.cmd, peeled.args);
          if (cClass.tool === "xcodebuild" && (cClass.requiresHeavySlot || cClass.requiresDevice)) {
            const explicitDestinations = [];
            for (let i = 0; i < peeled.args.length; i++) {
              const a = String(peeled.args[i]);
              if (a.startsWith("-destination=")) {
                explicitDestinations.push(a.slice("-destination=".length));
              } else if (a === "-destination" && i + 1 < peeled.args.length) {
                explicitDestinations.push(String(peeled.args[i + 1]));
                i++;
              }
            }
            const allowedIds = new Set(
              [lease?.serial, lease?.udid, lease?.coreDeviceId, lease?.profile?.coreDeviceId]
                .filter(Boolean)
                .map((s) => String(s).toUpperCase()),
            );
            if (
              explicitDestinations.length > 0 &&
              allowedIds.size > 0 &&
              (lease?.platform || "android") === "ios"
            ) {
              for (const dest of explicitDestinations) {
                const idMatch = dest.match(/(?:^|,)\s*id=([^,\s]+)/i);
                if (!idMatch || !idMatch[1] || !allowedIds.has(idMatch[1].toUpperCase())) {
                  throw new Error(
                    `Conflicting device selector "${idMatch?.[1] || dest}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
                  );
                }
              }
            }
            const xcodeInjected = [];
            if (cClass.requiresHeavySlot && !/(?:^|\s)-jobs(?:=|\s|$)/.test(corePart)) {
              xcodeInjected.push(`-jobs ${jobsLimit}`);
            }
            if (
              explicitDestinations.length === 0 &&
              lease?.serial &&
              (lease.platform || "android") === "ios"
            ) {
              xcodeInjected.push(`-destination id=${lease.serial}`);
            }
            if (xcodeInjected.length > 0) {
              return `${corePart.trimEnd()} ${xcodeInjected.join(" ")}${redirSuffix}${trailingWs}`;
            }
            return part;
          }
          if (!cClass.requiresHeavySlot) return part;
          if (
            cClass.tool === "gradle" &&
            !/(-Dorg\.gradle\.workers\.max=|--max-workers\b)/.test(corePart)
          ) {
            return `${corePart.trimEnd()} -Dorg.gradle.workers.max=${jobsLimit}${redirSuffix}${trailingWs}`;
          }
          if (cClass.tool === "bazel") {
            const hasJobs = /(?:^|\s)--jobs(?:=|\s|$)/.test(corePart);
            const hasRam = /(?:^|\s)--local_ram_resources(?:=|\s|$)/.test(corePart);
            const injected = [];
            if (!hasJobs) injected.push(`--jobs=${jobsLimit}`);
            if (!hasRam) injected.push(`--local_ram_resources=${ramLimitMb}`);
            if (injected.length > 0) {
              const rewrittenCore = corePart.replace(
                /(\bbazel(?:isk|w)?(?:\.(?:exe|cmd|bat))?(?:\s+(?:"[^"]*"|'[^']*'|[^\s"'])+)*?\s+)(build|test|run|coverage)(?=\s|$)/i,
                (_, prefix, sub) => `${prefix}${sub} ${injected.join(" ")}`,
              );
              return `${rewrittenCore}${redirSuffix}${trailingWs}`;
            }
          }
          return part;
        });
        nextArgs = [...nextArgs];
        nextArgs[cIdx + 1] = rewrittenParts.join("");
      }
    } else if (buildClassified.requiresHeavySlot && buildClassified.tool === "gradle") {
      const hasWorkersFlag = nextArgs.some((a) => {
        const s = String(a);
        return (
          s === "--max-workers" ||
          s.startsWith("--max-workers=") ||
          s.startsWith("-Dorg.gradle.workers.max=")
        );
      });
      if (!hasWorkersFlag) {
        const dashDash = nextArgs.indexOf("--");
        const flag = `-Dorg.gradle.workers.max=${jobsLimit}`;
        if (dashDash !== -1) {
          nextArgs = [...nextArgs.slice(0, dashDash), flag, ...nextArgs.slice(dashDash)];
        } else {
          nextArgs = [...nextArgs, flag];
        }
      }
    } else if (buildClassified.requiresHeavySlot && buildClassified.tool === "bazel") {
      const bazelBuildSubs = new Set(["build", "test", "run", "coverage"]);
      const subIdx = nextArgs.findIndex((a) => bazelBuildSubs.has(String(a).toLowerCase()));
      if (subIdx !== -1) {
        const hasJobs = nextArgs.some((a) => {
          const s = String(a);
          return s === "--jobs" || s.startsWith("--jobs=");
        });
        const hasRam = nextArgs.some((a) => {
          const s = String(a);
          return s === "--local_ram_resources" || s.startsWith("--local_ram_resources=");
        });
        const injected = [];
        if (!hasJobs) injected.push(`--jobs=${jobsLimit}`);
        if (!hasRam) injected.push(`--local_ram_resources=${ramLimitMb}`);
        if (injected.length > 0) {
          nextArgs = [
            ...nextArgs.slice(0, subIdx + 1),
            ...injected,
            ...nextArgs.slice(subIdx + 1),
          ];
        }
      }
    } else if (buildClassified.requiresHeavySlot && buildClassified.tool === "xcodebuild") {
      const hasJobs = nextArgs.some((a) => {
        const s = String(a);
        return s === "-jobs" || s.startsWith("-jobs=");
      });
      if (!hasJobs) {
        nextArgs = [...nextArgs, "-jobs", String(jobsLimit)];
      }
    }
  }

  const sanitizedBaseEnv = { ...baseEnv };
  delete sanitizedBaseEnv.ATC_BUILD_OP_ID;
  delete sanitizedBaseEnv.ATC_BUILD_OP_NONCE;
  delete sanitizedBaseEnv.ATC_BUILD_ID;

  const leasePlatform = lease ? lease.platform || "android" : null;
  const env = {
    ...sanitizedBaseEnv,
    ...(useDefaultStandardPath && process.platform !== "win32"
      ? { PATH: "/usr/bin:/bin" }
      : {}),
    ...(lease
      ? {
          ...(leasePlatform === "ios"
            ? {
                ...(lease.kind === "emulator" ? { SIMULATOR_UDID: lease.serial } : {}),
              }
            : {
                ANDROID_SERIAL: lease.serial,
              }),
          ATC_PLATFORM: leasePlatform,
          ATC_DEVICE_SERIAL: lease.serial,
          ATC_LEASE_ID: lease.leaseId,
        }
      : {}),
    ...(buildLease && buildLease.opId && buildLease.opNonce
      ? {
          ATC_BUILD_OP_ID: buildLease.opId,
          ATC_BUILD_OP_NONCE: buildLease.opNonce,
          ATC_BUILD_ID: buildLease.buildId || buildLease.opId,
        }
      : {}),
    ATC_SESSION_ID: sessionId,
  };
  if (base === "android" && androidParsed) {
    const hasDeviceFlag = nextArgs.some((a) => a === "--device" || a.startsWith("--device="));
    const isHelp = nextArgs.includes("--help") || nextArgs.includes("-h");
    if (!hasDeviceFlag && !isHelp && lease?.serial) {
      if (["run", "install", "layout"].includes(androidParsed.sub)) {
        nextArgs = [
          ...nextArgs.slice(0, androidParsed.subIdx + 1),
          `--device=${lease.serial}`,
          ...nextArgs.slice(androidParsed.subIdx + 1),
        ];
      } else if (androidParsed.sub === "screen" && androidParsed.action === "capture") {
        nextArgs = [
          ...nextArgs.slice(0, androidParsed.actIdx + 1),
          `--device=${lease.serial}`,
          ...nextArgs.slice(androidParsed.actIdx + 1),
        ];
      }
    }
  }
  return { cmd, args: nextArgs, env };
}

function terminateChildTree(childPid, signal = "SIGTERM", options = {}) {
  killProcessGroupTree(childPid, signal, options);
}

export function spawnWithHeartbeat(cmd, args, lease, sessionId, onHeartbeat, options = {}) {
  const invocation = buildChildInvocation(
    cmd,
    args,
    lease,
    sessionId,
    options.env,
    options.buildLease || null,
  );
  const detachChild = process.platform !== "win32";
  const spawnCfg = buildSpawnConfig(invocation.cmd, invocation.args, {
    stdio: options.stdio || "inherit",
    env: invocation.env,
    cwd: options.cwd,
    detached: detachChild,
  });

  const intervalMs = options.heartbeatIntervalMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCfg.command, spawnCfg.args, spawnCfg.options);
    const childPid = child.pid || null;
    const effectivePlatform = options.platform || process.platform;
    let childStartToken = null;
    let wrapperSignal = null;
    let killEscalationTimer = null;
    let earlyWinDiscoveryTimer = null;
    const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const signalHandlers = new Map();

    for (const sig of forwardedSignals) {
      const handler = () => {
        if (!wrapperSignal) {
          wrapperSignal = sig;
        }
        if (childPid) {
          terminateChildTree(childPid, sig);
          if (!killEscalationTimer) {
            killEscalationTimer = setTimeout(() => {
              if (isProcessGroupAlive(childPid)) {
                terminateChildTree(childPid, "SIGKILL");
              }
            }, 1500);
            if (typeof killEscalationTimer.unref === "function") {
              killEscalationTimer.unref();
            }
          }
        }
      };
      signalHandlers.set(sig, handler);
      process.on(sig, handler);
    }

    if (childPid && effectivePlatform === "win32") {
      archiveWindowsProcessGroupGeneration(childPid);
      clearKnownPosixPgidStartTokens(childPid);
    }

    const captureStartTokenWhileHandleOpen = () => {
      if (
        !childStartToken &&
        childPid &&
        !options.livenessCheck &&
        child.exitCode === null &&
        child.signalCode === null &&
        !(effectivePlatform === "win32" && getKnownWindowsTreeDescendants(childPid).length > 0)
      ) {
        childStartToken = getPosixProcessStartToken(childPid, {
          platform: effectivePlatform,
          spawnSyncFn: options.spawnSyncFn || options.runner,
          isSpawnCapture: true,
        });
        if (childStartToken) {
          seedPosixPgidStartTokens(childPid, childStartToken);
        }
      }
    };

    captureStartTokenWhileHandleOpen();

    if (childPid && typeof options.onChildSpawn === "function") {
      try {
        options.onChildSpawn(childPid, {
          isProcessGroup: true,
          freshGeneration: true,
          archivedGeneration: effectivePlatform === "win32",
          startToken: childStartToken,
        });
      } catch {
        // Best-effort worker registration
      }
    }

    if (childPid && effectivePlatform === "win32") {
      earlyWinDiscoveryTimer = setTimeout(() => {
        earlyWinDiscoveryTimer = null;
        try {
          captureStartTokenWhileHandleOpen();
          if (hasAliveProcessInGroup(childPid)) {
            onHeartbeat();
          }
        } catch {
          // Best-effort early descendant discovery
        }
      }, 80);
      if (typeof earlyWinDiscoveryTimer.unref === "function") {
        earlyWinDiscoveryTimer.unref();
      }
    }

    const timer = setInterval(() => {
      try {
        captureStartTokenWhileHandleOpen();
        onHeartbeat();
      } catch {
        // Best-effort heartbeat
      }
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    const cleanupListenersAndTimers = () => {
      clearInterval(timer);
      if (earlyWinDiscoveryTimer) {
        clearTimeout(earlyWinDiscoveryTimer);
        earlyWinDiscoveryTimer = null;
      }
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
        killEscalationTimer = null;
      }
      for (const [sig, handler] of signalHandlers.entries()) {
        process.removeListener(sig, handler);
      }
      signalHandlers.clear();
    };

    child.on("error", (err) => {
      cleanupListenersAndTimers();
      if (typeof options.onChildExit === "function") {
        try {
          options.onChildExit({
            childPid,
            exitedCleanly: false,
            exitCode: 1,
            code: 1,
            signal: null,
            aborted: true,
          });
        } catch {
          // Best-effort exit callback
        }
      }
      reject(err);
    });

    child.on("close", (code, signal) => {
      const effectiveSignal = signal || wrapperSignal;
      const finishClose = () => {
        cleanupListenersAndTimers();
        let resolvedExitCode = 1;
        if (wrapperSignal) {
          const sigNum = os.constants?.signals?.[wrapperSignal];
          resolvedExitCode = typeof sigNum === "number" ? 128 + sigNum : 1;
        } else if (typeof code === "number") {
          resolvedExitCode = code;
        } else if (effectiveSignal) {
          const sigNum = os.constants?.signals?.[effectiveSignal];
          resolvedExitCode = typeof sigNum === "number" ? 128 + sigNum : 1;
        }
        if (typeof options.onChildExit === "function") {
          try {
            options.onChildExit({
              childPid,
              exitedCleanly: !effectiveSignal,
              exitCode: resolvedExitCode,
              code: resolvedExitCode,
              signal: effectiveSignal || null,
              aborted: Boolean(
                effectiveSignal ||
                  resolvedExitCode === 130 ||
                  resolvedExitCode === 137 ||
                  resolvedExitCode === 143,
              ),
            });
          } catch {
            // Best-effort exit callback
          }
        }
        try {
          onHeartbeat();
        } catch {
          // Ignore final heartbeat error
        }
        resolve(resolvedExitCode);
      };

      if (childPid && isProcessGroupAlive(childPid)) {
        if (effectiveSignal) {
          terminateChildTree(childPid, "SIGTERM");
          const killDeadline = Date.now() + 500;
          while (isProcessGroupAlive(childPid) && Date.now() < killDeadline) {
            sleepSync(25);
          }
          if (isProcessGroupAlive(childPid)) {
            terminateChildTree(childPid, "SIGKILL");
            const forceDeadline = Date.now() + 300;
            while (isProcessGroupAlive(childPid) && Date.now() < forceDeadline) {
              sleepSync(25);
            }
          }
          finishClose();
          return;
        }
        if (options.buildMode) {
          // Do not block or kill detached shared build daemons (GradleDaemon, kotlin-daemon, Bazel server)
          // when the build client wrapper exits normally.
          finishClose();
          return;
        }
        try {
          onHeartbeat();
        } catch {
          // Best-effort descendant persistence when child shell exits early
        }
        let pollDelayMs = process.platform === "win32" ? 200 : 50;
        const maxPollDelayMs = process.platform === "win32" ? 1500 : 1000;
        const scheduleNextGroupPoll = () => {
          const t = setTimeout(() => {
            if (wrapperSignal) {
              terminateChildTree(childPid, wrapperSignal);
            }
            if (!isProcessGroupAlive(childPid)) {
              finishClose();
              return;
            }
            try {
              onHeartbeat();
            } catch {
              // Best-effort descendant sync during group polling
            }
            pollDelayMs = Math.min(maxPollDelayMs, pollDelayMs * 2);
            scheduleNextGroupPoll();
          }, pollDelayMs);
        };
        scheduleNextGroupPoll();
        return;
      }

      finishClose();
    });
  });
}
