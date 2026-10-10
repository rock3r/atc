import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAST_PATH_REGEX = /\b(android|adb|emulator|gradlew|gradle|atc)\b/i;

function expandVariables(str: string, vars: Record<string, string> = {}): string {
  if (!str || Object.keys(vars).length === 0) return str;
  return str.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (full, k1, k2) => {
      const key = k1 || k2;
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : full;
    }
  );
}

export function hasAndroidOrAtcTokens(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  if (FAST_PATH_REGEX.test(command)) return true;
  const normalizedVars = command.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?=["'\\].)/g, "${$1}");
  const collapsed = normalizedVars.replace(/\\(.)/g, "$1").replace(/["']/g, "");
  if (FAST_PATH_REGEX.test(collapsed)) return true;
  if (collapsed.includes("$")) {
    const vars: Record<string, string> = {};
    const assignRe = /\b([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = assignRe.exec(collapsed)) !== null) {
      vars[m[1]] = expandVariables(m[2], vars);
    }
    let expanded = expandVariables(collapsed, vars);
    expanded = expandVariables(expanded, vars);
    if (FAST_PATH_REGEX.test(expanded)) return true;
  }
  return false;
}

export function resolveAtcExecutable(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  platform: string = process.platform
): { executable: string; isBatch: boolean } {
  const resolvedCwd = path.resolve(cwd);
  const pathDirs = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter((d) => Boolean(d) && path.isAbsolute(d) && path.resolve(d) !== resolvedCwd);

  if (platform !== "win32") {
    pathDirs.push(
      path.join(os.homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin"
    );
    for (const dir of pathDirs) {
      const candidate = path.join(dir, "atc");
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return { executable: candidate, isBatch: false };
        }
      } catch {
        // Ignore inaccessible or non-executable PATH entry
      }
    }
    return { executable: "atc", isBatch: false };
  }

  const rawExts = (env.PATHEXT || env.PathExt || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  const extensions = Array.from(new Set([".exe", ".cmd", ".bat", ".com", ...rawExts]));

  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  pathDirs.push(path.join(appData, "npm"), path.join(os.homedir(), ".local", "bin"));

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, "atc" + ext);
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

  return { executable: "atc.cmd", isBatch: true };
}

export function buildAtcSpawnConfig(
  args: string[] = [],
  options: Record<string, any> = {}
) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const resolved = resolveAtcExecutable(env, cwd, platform);
  const resolvedCwd = path.resolve(cwd);
  const safePath = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .map((d: string) => d.trim())
    .filter((d: string) => Boolean(d) && path.isAbsolute(d) && path.resolve(d) !== resolvedCwd)
    .join(path.delimiter);
  const spawnEnv = {
    ...env,
    PATH: safePath,
    ...(platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : {}),
  };

  if (platform === "win32" && resolved.isBatch) {
    for (const arg of args) {
      const s = String(arg);
      if (s.includes("\0") || s.includes("\r") || s.includes("\n") || s.includes("%")) {
        throw new Error(`Unsafe character in Windows batch argument: ${JSON.stringify(s)}`);
      }
    }
    const comspec = env.ComSpec || "cmd.exe";
    const quotedCmd = `"${resolved.executable}" ${args
      .map((a) => `"${String(a).replace(/"/g, '""')}"`)
      .join(" ")}`;
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${quotedCmd}"`],
      isBatch: true,
      options: {
        ...options,
        env: spawnEnv,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: resolved.executable,
    args: args.map(String),
    isBatch: false,
    options: {
      ...options,
      env: spawnEnv,
      shell: false,
    },
  };
}

function runAtcSync(args: string[], options: Record<string, any> = {}) {
  const cfg = buildAtcSpawnConfig(args, options);
  return execFileSync(cfg.command, cfg.args, cfg.options);
}

/**
 * Pi / Ohm / Tau Coding Agent Extension for Android Traffic Control (atc).
 * Intercepts bash tool invocations via `atc guard` and releases session leases on shutdown.
 */
export default function atcExtension(pi: any) {
  const sessionId =
    process.env.ATC_SESSION_ID || process.env.ATC_SESSION || `pi-${process.pid}`;

  pi.on("tool_call", async (event: any) => {
    const toolName = String(event.toolName ?? event.name ?? "").toLowerCase();
    if (toolName !== "bash" && toolName !== "shell") return;
    const command = event.input?.command ?? event.arguments?.command ?? "";
    if (!command || !hasAndroidOrAtcTokens(command)) return;

    const handleDecision = (rawStdout: string) => {
      const decision = JSON.parse(rawStdout);
      if (decision.allowed === false || decision.decision === "deny") {
        return {
          block: true,
          reason: decision.reason || "Blocked by ATC guardrail.",
        };
      }
      if (decision.allowed !== true && decision.decision !== "allow") {
        return {
          block: true,
          reason: "Blocked by ATC guardrail: unrecognized guard response.",
        };
      }
      if (decision.rewrittenCommand) {
        if (event.input && typeof event.input === "object") {
          event.input.command = decision.rewrittenCommand;
        } else if (event.arguments && typeof event.arguments === "object") {
          event.arguments.command = decision.rewrittenCommand;
        }
      }
      return undefined;
    };

    const guardEnv = {
      ...process.env,
      ATC_ANCHOR_PID: process.env.ATC_ANCHOR_PID || String(process.pid),
    };
    const resolved = resolveAtcExecutable(guardEnv, process.cwd(), process.platform);
    const useStdinOnly = process.platform === "win32" && resolved.isBatch;
    const guardArgs = useStdinOnly
      ? ["guard", "--session", sessionId, "--format=json"]
      : ["guard", "--session", sessionId, "--format=json", "--", command];

    try {
      const stdout = runAtcSync(guardArgs, {
        encoding: "utf8",
        input: JSON.stringify({ command }),
        env: guardEnv,
      }) as string;
      return handleDecision(stdout);
    } catch (err: any) {
      if (err?.stdout) {
        try {
          const outcome = handleDecision(err.stdout.toString());
          if (outcome) return outcome;
        } catch {
          // fall through to fail-closed block
        }
      }
      const fallbackReason =
        err?.stderr?.toString()?.trim() ||
        err?.message ||
        "Blocked by ATC guardrail: failed to evaluate command.";
      return { block: true, reason: fallbackReason };
    }
  });

  const releaseSessionLeases = async () => {
    try {
      runAtcSync(["free", "--session", sessionId], {
        stdio: "ignore",
        env: {
          ...process.env,
          ATC_ANCHOR_PID: process.env.ATC_ANCHOR_PID || String(process.pid),
        },
      });
    } catch {
      // ignore if no active lease
    }
  };

  pi.on("session_shutdown", releaseSessionLeases);
  pi.on("session_end", releaseSessionLeases);
}
