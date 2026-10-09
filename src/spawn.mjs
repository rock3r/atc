import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_TOKEN_REGEX = /^[A-Za-z0-9._:/@=-]+$/;

export function resolveExecutable(
  command,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
) {
  if (!command || typeof command !== "string") {
    throw new Error("Command must be a non-empty string");
  }
  if (platform !== "win32") {
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
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const resolvedCmd = hasPathSep ? path.resolve(cwd, normalizedCommand) : normalizedCommand;
    return { executable: resolvedCmd, isBatch: true };
  }
  if (lower.endsWith(".exe") || lower.endsWith(".com")) {
    const resolvedCmd = hasPathSep ? path.resolve(cwd, normalizedCommand) : normalizedCommand;
    return { executable: resolvedCmd, isBatch: false };
  }

  // Check relative / project-local candidates in cwd first (handles `./gradlew`, `.\gradlew`, and `gradlew`)
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

  if (hasPathSep) {
    return { executable: path.resolve(cwd, normalizedCommand), isBatch: false };
  }

  const pathDirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  pathDirs.push(
    path.join(localAppData, "Android", "Sdk", "platform-tools"),
    path.join(localAppData, "Android", "Sdk", "emulator"),
    path.join(appData, "npm"),
    path.join(os.homedir(), ".local", "bin"),
  );

  for (const dir of pathDirs) {
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

  if (lower === "atc") {
    return { executable: "atc.cmd", isBatch: true };
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
  const resolved = resolveExecutable(command, env, cwd, platform);

  if (platform === "win32" && resolved.isBatch) {
    validateBatchArgs(args, Boolean(options.strictInternal));
    const comspec = env.ComSpec || "cmd.exe";
    const quotedCmd = `"${resolved.executable}" ${args.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(" ")}`;
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${quotedCmd}"`],
      options: {
        ...options,
        env,
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
      env,
      shell: false,
    },
  };
}

export function runCommandSync(command, args = [], options = {}) {
  if (options.detached) {
    const cfg = buildSpawnConfig(command, args, {
      ...options,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
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
  const cfg = buildSpawnConfig(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000,
    ...options,
  });
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

export function buildChildInvocation(cmd, args, lease, sessionId, baseEnv = process.env) {
  const base = path.basename(cmd, path.extname(cmd)).toLowerCase();
  const androidParsed = base === "android" ? findAndroidSubcommand(args) : null;
  if (base === "emulator") {
    if (!args.includes("-list-avds") && !args.includes("-version") && !args.includes("-help")) {
      throw new Error(
        'Direct emulator launch is disabled under ATC. Use "atc claim --type <type> --api <api>" instead.',
      );
    }
  } else if (base === "android" && androidParsed.sub === "emulator") {
    const emuAction = androidParsed.action;
    if (
      ["start", "stop", "remove", "create"].includes(emuAction) &&
      !(emuAction === "create" && args.includes("--list-profiles"))
    ) {
      throw new Error(
        `Direct "android emulator ${emuAction}" is disabled under ATC. Use "atc claim" or "atc free --stop" instead.`,
      );
    }
  } else if (base === "adb") {
    let subIdx = 0;
    while (subIdx < args.length) {
      const a = String(args[subIdx]);
      if (a === "-d" || a === "-e" || a === "-t" || a.startsWith("-t")) {
        throw new Error(
          `Non-serial adb device selector "${a}" is not permitted under ATC; use -s "${lease.serial}" or omit selector flags to use ANDROID_SERIAL.`,
        );
      }
      if (a.startsWith("-s") && a.length > 2) {
        const inlineSerial = a.slice(2);
        if (lease.serial && inlineSerial !== lease.serial) {
          throw new Error(
            `Conflicting device selector "${inlineSerial}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
        subIdx += 1;
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
    if (adbSub === "emu" && adbRest[0] === "kill") {
      throw new Error(
        'Direct "adb emu kill" is disabled under ATC. Use "atc free --stop" instead.',
      );
    }
    if (adbSub === "disconnect") {
      const disconnectTargets = adbRest.filter((a) => !a.startsWith("-"));
      if (disconnectTargets.length === 0) {
        throw new Error(
          'Bare "adb disconnect" is disabled under ATC because it disconnects all TCP/IP devices on the host; specify the leased target serial explicitly.',
        );
      }
      for (const target of disconnectTargets) {
        if (lease.serial && target !== lease.serial) {
          throw new Error(
            `Conflicting device selector "${target}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
          );
        }
      }
    }
  }

  if (base === "adb" || base === "android") {
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]);
      let explicitSerial = null;
      if (base === "android" && a.startsWith("--device=")) {
        explicitSerial = a.slice("--device=".length);
      } else if (base === "android" && a === "--device" && i + 1 < args.length) {
        explicitSerial = String(args[i + 1]);
      } else if (base === "adb" && a === "-s" && i + 1 < args.length) {
        explicitSerial = String(args[i + 1]);
      }
      if (explicitSerial && lease.serial && explicitSerial !== lease.serial) {
        throw new Error(
          `Conflicting device selector "${explicitSerial}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
        );
      }
    }
  }
  const env = {
    ...baseEnv,
    ANDROID_SERIAL: lease.serial,
    ATC_LEASE_ID: lease.leaseId,
    ATC_SESSION_ID: sessionId,
  };
  let nextArgs = [...args];
  if (base === "android" && androidParsed) {
    const hasDeviceFlag = nextArgs.some((a) => a === "--device" || a.startsWith("--device="));
    const isHelp = nextArgs.includes("--help") || nextArgs.includes("-h");
    if (!hasDeviceFlag && !isHelp && lease.serial) {
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

export function spawnWithHeartbeat(cmd, args, lease, sessionId, onHeartbeat, options = {}) {
  const invocation = buildChildInvocation(cmd, args, lease, sessionId, options.env);
  const spawnCfg = buildSpawnConfig(invocation.cmd, invocation.args, {
    stdio: options.stdio || "inherit",
    env: invocation.env,
  });

  const intervalMs = options.heartbeatIntervalMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCfg.command, spawnCfg.args, spawnCfg.options);
    const timer = setInterval(() => {
      try {
        onHeartbeat();
      } catch {
        // Best-effort heartbeat
      }
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    child.on("error", (err) => {
      clearInterval(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearInterval(timer);
      try {
        onHeartbeat();
      } catch {
        // Ignore final heartbeat error
      }
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      if (signal) {
        const sigNum = os.constants?.signals?.[signal];
        resolve(typeof sigNum === "number" ? 128 + sigNum : 1);
        return;
      }
      resolve(1);
    });
  });
}
