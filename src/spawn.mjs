import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_TOKEN_REGEX = /^[A-Za-z0-9._:/@=-]+$/;

export function resolveExecutable(command, env = process.env) {
  if (!command || typeof command !== "string") {
    throw new Error("Command must be a non-empty string");
  }
  if (process.platform !== "win32") {
    return { executable: command, isBatch: false };
  }

  const lower = command.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { executable: command, isBatch: true };
  }
  if (lower.endsWith(".exe")) {
    return { executable: command, isBatch: false };
  }

  const pathDirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  pathDirs.push(
    path.join(localAppData, "Android", "Sdk", "platform-tools"),
    path.join(localAppData, "Android", "Sdk", "emulator"),
    path.join(os.homedir(), ".local", "bin"),
  );

  const extensions = [".exe", ".cmd", ".bat"];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
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
  const resolved = resolveExecutable(command, env);

  if (process.platform === "win32" && resolved.isBatch) {
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
    try {
      const child = spawn(cfg.command, cfg.args, cfg.options);
      if (typeof child.unref === "function") child.unref();
      return { status: 0, signal: null, stdout: "", stderr: "", error: null };
    } catch (err) {
      return {
        status: 1,
        signal: null,
        stdout: "",
        stderr: err?.message || "Failed to spawn detached process",
        error: err,
      };
    }
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

export function buildChildInvocation(cmd, args, lease, sessionId, baseEnv = process.env) {
  const base = path.basename(cmd, path.extname(cmd)).toLowerCase();
  if (base === "emulator") {
    if (!args.includes("-list-avds") && !args.includes("-version") && !args.includes("-help")) {
      throw new Error(
        'Direct emulator launch is disabled under ATC. Use "atc claim --type <type> --api <api>" instead.',
      );
    }
  } else if (base === "android" && args[0] === "emulator") {
    const emuAction = args[1] || "";
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
      if (a === "-s" || a === "-t" || a === "-H" || a === "-P") {
        subIdx += 2;
      } else if (a.startsWith("-")) {
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
  if (
    base === "android" &&
    nextArgs.length > 0 &&
    ["run", "install", "layout", "screen"].includes(nextArgs[0])
  ) {
    const hasDeviceFlag = nextArgs.some((a) => a === "--device" || a.startsWith("--device="));
    if (!hasDeviceFlag && lease.serial) {
      nextArgs = [nextArgs[0], `--device=${lease.serial}`, ...nextArgs.slice(1)];
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
