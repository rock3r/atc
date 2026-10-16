import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveAtcExecutable(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  platform: string = process.platform
): { executable: string; isBatch: boolean } {
  const resolvedCwd = path.resolve(cwd);
  const isOutsideCwd = (p: string) => {
    const rp = path.resolve(p);
    return rp !== resolvedCwd && !rp.startsWith(resolvedCwd + path.sep);
  };
  const pathDirs = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter((d) => Boolean(d) && path.isAbsolute(d) && isOutsideCwd(d));

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
  const isOutsideCwd = (p: string) => {
    const rp = path.resolve(p);
    return rp !== resolvedCwd && !rp.startsWith(resolvedCwd + path.sep);
  };
  const safePath = (env.PATH || env.Path || "")
    .split(path.delimiter)
    .map((d: string) => d.trim())
    .filter((d: string) => Boolean(d) && path.isAbsolute(d) && isOutsideCwd(d))
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
 * Pi / Ohm / Tau Coding Agent Extension for Agent Traffic Control (atc).
 * ATC 3.0 never inspects shell commands, so this extension does not hook tool calls; agents use
 * typed `atc exec <system> <op>` / `atc batch` invocations. It only releases session leases on
 * shutdown.
 */
export default function atcExtension(pi: any) {
  const sessionId =
    process.env.ATC_SESSION_ID || process.env.ATC_SESSION || `pi-${process.pid}`;

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
