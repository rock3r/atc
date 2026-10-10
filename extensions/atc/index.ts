import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAST_PATH_REGEX = /\b(android|adb|emulator|gradlew|gradle|atc)\b/i;
const TOOL_NAMES = ["android", "adb", "emulator", "gradlew", "gradle", "atc"];

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

function decodeShellEscapes(str: string): string {
  if (!str || typeof str !== "string" || !str.includes("\\")) return str;
  return str.replace(
    /\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|0([0-7]{1,3})|([0-7]{1,3})|([abefnrtv\\'"?]))/g,
    (full, hex, u4, u8, oct0, oct, single) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (u8) return String.fromCodePoint(parseInt(u8, 16));
      if (oct0) return String.fromCharCode(parseInt(oct0, 8));
      if (oct) return String.fromCharCode(parseInt(oct, 8));
      if (single === "n") return "\n";
      if (single === "r") return "\r";
      if (single === "t") return "\t";
      return single || full;
    }
  );
}

function resolveStaticSubValue(expandedInner: string, prefixWord = "", suffixWord = ""): string {
  const decodedInner = decodeShellEscapes(String(expandedInner || ""));
  const cleaned = decodedInner
    .replace(/\\(.)/g, "$1")
    .replace(/["']/g, "")
    .trim();
  const tokens = cleaned ? cleaned.split(/\s+/) : [];
  const cmd = tokens[0] ? path.basename(tokens[0], path.extname(tokens[0])).toLowerCase() : "";
  const args = tokens.slice(1);

  if (cmd === "echo") {
    let idx = 0;
    while (idx < args.length && /^-[neE]+$/.test(args[idx])) {
      idx++;
    }
    return decodeShellEscapes(args.slice(idx).join(" "));
  }

  if (cmd === "printf") {
    let idx = 0;
    if (args[idx] === "--") idx++;
    if (args[idx] === "-v") return "";
    const rawFmt = decodeShellEscapes(args[idx] ?? "");
    const fmtArgs = args.slice(idx + 1).map((a) => decodeShellEscapes(a));
    if (fmtArgs.length === 0) return rawFmt;
    if (!/%[-+ #0]*\d*(?:\.\d+)?[sbc]/.test(rawFmt)) {
      return rawFmt + fmtArgs.join("");
    }
    let out = "";
    let argIdx = 0;
    while (argIdx < fmtArgs.length) {
      const prevIdx = argIdx;
      out += rawFmt.replace(/%[-+ #0]*\d*(?:\.\d+)?([sbc])/g, (_m, spec) => {
        if (argIdx >= fmtArgs.length) return "";
        const val = fmtArgs[argIdx++];
        return spec === "c" ? val.slice(0, 1) : val;
      });
      if (argIdx === prevIdx) break;
    }
    return out;
  }

  if (
    (cmd === "command" && (args[0] === "-v" || args[0] === "-V")) ||
    cmd === "which" ||
    cmd === "type"
  ) {
    const tokenMatch = String(expandedInner).match(FAST_PATH_REGEX);
    if (tokenMatch) return tokenMatch[1];
  }

  if (prefixWord || suffixWord) {
    const pLow = prefixWord.toLowerCase();
    const sLow = suffixWord.toLowerCase();
    for (const tool of TOOL_NAMES) {
      if (
        tool.startsWith(pLow) &&
        tool.endsWith(sLow) &&
        pLow.length + sLow.length <= tool.length
      ) {
        return tool.slice(pLow.length, tool.length - sLow.length);
      }
    }
  }

  return "__atc_cmd_sub__";
}

function expandCommandSubstitutionsForFastPath(
  str: string,
  subCollector: string[] = []
): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\" && !inSingle && i + 1 < str.length) {
      out += ch + str[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (
      !inSingle &&
      (ch === "$" || ch === "<" || ch === ">") &&
      str[i + 1] === "(" &&
      str[i + 2] !== "("
    ) {
      let depth = 1;
      let j = i + 2;
      let subSingle = false;
      let subDouble = false;
      while (j < str.length && depth > 0) {
        const c = str[j];
        if (c === "\\" && !subSingle && j + 1 < str.length) {
          j += 2;
          continue;
        }
        if (c === "'" && !subDouble) {
          subSingle = !subSingle;
        } else if (c === '"' && !subSingle) {
          subDouble = !subDouble;
        } else if (!subSingle && !subDouble) {
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        j++;
      }
      if (depth === 0) {
        const rawInner = str.slice(i + 2, j - 1);
        const expandedInner = expandCommandSubstitutionsForFastPath(rawInner, subCollector);
        subCollector.push(expandedInner);
        const prefixMatch = out.match(/([A-Za-z0-9_.-]+)$/);
        const suffixMatch = str.slice(j).match(/^([A-Za-z0-9_.-]+)/);
        out += resolveStaticSubValue(
          expandedInner,
          prefixMatch ? prefixMatch[1] : "",
          suffixMatch ? suffixMatch[1] : ""
        );
        i = j - 1;
        continue;
      }
    }
    if (!inSingle && ch === "`") {
      let j = i + 1;
      while (j < str.length && str[j] !== "`") {
        if (str[j] === "\\" && j + 1 < str.length) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j < str.length && str[j] === "`") {
        const rawInner = str.slice(i + 1, j);
        const expandedInner = expandCommandSubstitutionsForFastPath(rawInner, subCollector);
        subCollector.push(expandedInner);
        const prefixMatch = out.match(/([A-Za-z0-9_.-]+)$/);
        const suffixMatch = str.slice(j + 1).match(/^([A-Za-z0-9_.-]+)/);
        out += resolveStaticSubValue(
          expandedInner,
          prefixMatch ? prefixMatch[1] : "",
          suffixMatch ? suffixMatch[1] : ""
        );
        i = j;
        continue;
      }
    }
    out += ch;
  }

  return out;
}

export function hasAndroidOrAtcTokens(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  if (FAST_PATH_REGEX.test(command)) return true;
  const subParts: string[] = [];
  const subExpanded =
    command.includes("$") || command.includes("`")
      ? expandCommandSubstitutionsForFastPath(command, subParts)
      : command;
  const combined = subParts.length > 0 ? `${subExpanded} ; ${subParts.join(" ; ")}` : subExpanded;
  const ansiDecoded = combined.replace(/\$'((?:\\.|[^'])*)'/g, (_m, inner) =>
    decodeShellEscapes(inner)
  );
  if (FAST_PATH_REGEX.test(ansiDecoded)) return true;
  const normalizedVars = ansiDecoded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?=["'\\].)/g, "${$1}");
  const collapsed = decodeShellEscapes(normalizedVars)
    .replace(/\\(.)/g, "$1")
    .replace(/["']/g, "");
  if (FAST_PATH_REGEX.test(collapsed)) return true;
  let expandedForCmdCheck = collapsed;
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
    expandedForCmdCheck = expanded;
  }
  if (expandedForCmdCheck.includes("__atc_cmd_sub__")) {
    for (const rawClause of expandedForCmdCheck.split(/[;&|\r\n]+/)) {
      const tokens = rawClause
        .trim()
        .split(/\s+/)
        .filter((t) => Boolean(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
      while (
        tokens.length > 0 &&
        /^(?:env|command|nohup|timeout|sudo|nice|time|then|else|do|if|elif|while|until|!|\{|\()+$/i.test(
          tokens[0]
        )
      ) {
        tokens.shift();
      }
      if (tokens[0] && tokens[0].includes("__atc_cmd_sub__")) {
        return true;
      }
    }
  }
  return false;
}

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
