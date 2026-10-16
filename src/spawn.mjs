import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function terminateChildTree(childPid, signal = "SIGTERM", options = {}) {
  killProcessGroupTree(childPid, signal, options);
}

const BAZEL_RESOURCE_SUBCOMMANDS = new Set(["build", "test", "run", "coverage"]);

// Build the child process env and argv for a typed-op invocation (see docs/scope.md §6).
// Invocations are already literal argv generated from validated params; the only additions
// are lease/session env vars and per-build resource caps for heavy build tools.
export function prepareOpChildInvocation(invocation, { lease = null, sessionId = null, baseEnv = process.env, buildLease = null, tool = null } = {}) {
  const cmd = String(invocation.cmd);
  let args = (invocation.args || []).map(String);
  if (buildLease && tool) {
    const hostCpus = Math.max(1, os.cpus()?.length || 4);
    const maxConcurrent = Math.max(1, Number(buildLease.maxConcurrentBuilds || 2));
    const jobsLimit = Math.max(2, Number(buildLease.jobsLimit || Math.floor(hostCpus / maxConcurrent)));
    const ramLimitMb = Math.max(1024, Number(buildLease.reservedRamMb || 3072));
    if (tool === "gradle") {
      args = [...args, `-Dorg.gradle.workers.max=${jobsLimit}`];
    } else if (tool === "bazel" && BAZEL_RESOURCE_SUBCOMMANDS.has(args[0])) {
      const dashDash = args.indexOf("--");
      const head = dashDash === -1 ? args : args.slice(0, dashDash);
      const tail = dashDash === -1 ? [] : args.slice(dashDash);
      args = [head[0], `--jobs=${jobsLimit}`, `--local_ram_resources=${ramLimitMb}`, ...head.slice(1), ...tail];
    } else if (tool === "xcodebuild" && !args.includes("clean")) {
      args = [...args, "-jobs", String(jobsLimit)];
    }
  }
  const sanitizedBaseEnv = { ...baseEnv };
  delete sanitizedBaseEnv.ATC_BUILD_OP_ID;
  delete sanitizedBaseEnv.ATC_BUILD_OP_NONCE;
  delete sanitizedBaseEnv.ATC_BUILD_ID;
  const leasePlatform = lease ? lease.platform || "android" : null;
  const env = {
    ...sanitizedBaseEnv,
    ...(invocation.env || {}),
    ...(lease
      ? {
          ...(leasePlatform === "ios"
            ? lease.kind === "emulator"
              ? { SIMULATOR_UDID: lease.serial }
              : {}
            : { ANDROID_SERIAL: lease.serial }),
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
    ...(sessionId ? { ATC_SESSION_ID: sessionId } : {}),
  };
  return { cmd, args, env, cwd: invocation.cwd || null };
}

export function spawnWithHeartbeat(cmd, args, lease, sessionId, onHeartbeat, options = {}) {
  const invocation = options.prepared
    ? options.prepared
    : prepareOpChildInvocation(
        { cmd, args, cwd: options.cwd },
        { lease, sessionId, baseEnv: options.env || process.env, buildLease: options.buildLease || null, tool: options.tool || null },
      );
  const detachChild = process.platform !== "win32";
  const spawnCfg = buildSpawnConfig(invocation.cmd, invocation.args, {
    stdio: options.stdio || "inherit",
    env: invocation.env,
    cwd: invocation.cwd || options.cwd,
    detached: detachChild,
  });

  const intervalMs = options.heartbeatIntervalMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCfg.command, spawnCfg.args, spawnCfg.options);
    const onOutput = typeof options.onOutput === "function" ? options.onOutput : null;
    if (child.stdout) {
      if (onOutput) {
        child.stdout.on("data", (chunk) => onOutput(chunk, "stdout"));
      } else if (options.redirectStdoutToStderr) {
        child.stdout.pipe(process.stderr);
      } else {
        child.stdout.resume();
      }
    }
    if (child.stderr) {
      if (onOutput) {
        child.stderr.on("data", (chunk) => onOutput(chunk, "stderr"));
      } else if (options.redirectStdoutToStderr) {
        child.stderr.pipe(process.stderr);
      } else {
        child.stderr.resume();
      }
    }
    const childPid = child.pid || null;
    const effectivePlatform = options.platform || process.platform;
    let childStartToken = null;
    let wrapperSignal = null;
    let timedOut = false;
    let timeoutTimer = null;
    let killEscalationTimer = null;
    let earlyWinDiscoveryTimer = null;
    const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const signalHandlers = new Map();

    const escalateKill = () => {
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
    };

    for (const sig of forwardedSignals) {
      const handler = () => {
        if (!wrapperSignal) {
          wrapperSignal = sig;
        }
        if (childPid) {
          terminateChildTree(childPid, sig);
          escalateKill();
        }
      };
      signalHandlers.set(sig, handler);
      process.on(sig, handler);
    }

    if (childPid && Number(options.timeoutMs) > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (!wrapperSignal) wrapperSignal = "SIGTERM";
        terminateChildTree(childPid, "SIGTERM");
        escalateKill();
      }, Number(options.timeoutMs));
      if (typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }
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
      earlyWinDiscoveryTimer = setTimeout(
        () => {
          earlyWinDiscoveryTimer = null;
          if (child.exitCode !== null || child.signalCode !== null) return;
          try {
            captureStartTokenWhileHandleOpen();
            if (hasAliveProcessInGroup(childPid)) {
              onHeartbeat();
            }
          } catch {
            // Best-effort early descendant discovery
          }
        },
        options.buildMode && !lease ? 500 : 80,
      );
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
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
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
        if (timedOut) {
          resolvedExitCode = 124;
        } else if (wrapperSignal) {
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
              timedOut,
              aborted: Boolean(
                effectiveSignal ||
                  resolvedExitCode === 124 ||
                  resolvedExitCode === 130 ||
                  resolvedExitCode === 137 ||
                  resolvedExitCode === 143,
              ),
            });
          } catch {
            // Best-effort exit callback
          }
        }
        if (!options.buildMode || lease) {
          try {
            onHeartbeat();
          } catch {
            // Ignore final heartbeat error
          }
        }
        resolve(resolvedExitCode);
      };

      if (options.buildMode && !effectiveSignal) {
        // Do not block or kill detached shared build daemons (GradleDaemon, kotlin-daemon, Bazel server)
        // when the build client wrapper exits normally.
        finishClose();
        return;
      }

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
