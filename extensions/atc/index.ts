import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FAST_PATH_REGEX = /\b(android|adb|emulator|gradlew|gradle|atc)\b/i;
const TOOL_NAMES = ["android", "adb", "emulator", "gradlew", "gradle", "atc"];

function shellPatToRegExpStr(pat: string, greedy = true): string {
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "\\" && i + 1 < pat.length) {
      out += "\\" + pat[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "*") {
      out += greedy ? ".*" : ".*?";
    } else if (c === "?") {
      out += ".";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function expandSingleBraceExpression(
  full: string,
  inner: string,
  vars: Record<string, string>
): string {
  const failValue = "__atc_cmd_sub__";
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])$/.test(inner)) {
    if (Object.prototype.hasOwnProperty.call(vars, inner)) {
      return vars[inner];
    }
    return /^(?:\d+|[@*#?$!-])$/.test(inner) ? failValue : full;
  }
  if (/^#(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*])$/.test(inner)) {
    const key = inner.slice(1);
    return Object.prototype.hasOwnProperty.call(vars, key)
      ? String(vars[key]).length.toString()
      : failValue;
  }
  const m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*])(.+)$/s);
  if (!m) {
    return failValue;
  }
  const key = m[1];
  const hasKey = Object.prototype.hasOwnProperty.call(vars, key);
  const val = hasKey ? String(vars[key]) : "";
  const rest = m[2].replace(/\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g, (rawRef, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : rawRef
  );

  const subSliceMatch = rest.match(/^:(?:\s+(-?\d+)|(\d+))(?::\s*(-?\d+))?$/);
  if (subSliceMatch) {
    if (!hasKey) return failValue;
    const offset = parseInt(subSliceMatch[1] ?? subSliceMatch[2], 10);
    const start = offset < 0 ? Math.max(0, val.length + offset) : offset;
    if (subSliceMatch[3] === undefined) {
      return val.slice(start);
    }
    const len = parseInt(subSliceMatch[3], 10);
    return len < 0
      ? val.slice(start, Math.max(start, val.length + len))
      : val.slice(start, start + len);
  }

  const defMatch = rest.match(/^(:?[-=+?])(.*)$/s);
  if (defMatch) {
    const op = defMatch[1];
    const word = defMatch[2];
    const isSetAndNonEmpty = hasKey && val !== "";
    if (op === ":-" || op === ":=") {
      if (isSetAndNonEmpty) return val;
      return !word.includes("$") ? word : failValue;
    }
    if (op === "-" || op === "=") {
      if (hasKey) return val;
      return !word.includes("$") ? word : failValue;
    }
    if (op === ":+") {
      if (!hasKey) return failValue;
      if (val === "") return "";
      return !word.includes("$") ? word : failValue;
    }
    if (op === "+") {
      if (!hasKey) return failValue;
      return !word.includes("$") ? word : failValue;
    }
    if (op === ":?" || op === "?") {
      if (hasKey && (op === "?" || val !== "")) return val;
      return failValue;
    }
  }

  const prefMatch = rest.match(/^(#{1,2})(.*)$/s);
  if (prefMatch) {
    if (!hasKey || prefMatch[2].includes("$")) return failValue;
    const greedy = prefMatch[1] === "##";
    const re = new RegExp("^" + shellPatToRegExpStr(prefMatch[2], greedy));
    return val.replace(re, "");
  }

  const sufMatch = rest.match(/^(%{1,2})(.*)$/s);
  if (sufMatch) {
    if (!hasKey || sufMatch[2].includes("$")) return failValue;
    const greedy = sufMatch[1] === "%%";
    const re = new RegExp("^" + shellPatToRegExpStr(sufMatch[2], true) + "$");
    if (greedy) {
      for (let i = 0; i <= val.length; i++) {
        if (re.test(val.slice(i))) return val.slice(0, i);
      }
      return val;
    }
    for (let i = val.length; i >= 0; i--) {
      if (re.test(val.slice(i))) return val.slice(0, i);
    }
    return val;
  }

  const patSubMatch = rest.match(/^(\/{1,2}|\/#|\/%)([^/]*)(?:\/(.*))?$/s);
  if (patSubMatch) {
    if (
      !hasKey ||
      patSubMatch[2].includes("$") ||
      (patSubMatch[3] && patSubMatch[3].includes("$"))
    ) {
      return failValue;
    }
    const mode = patSubMatch[1];
    const patStr = shellPatToRegExpStr(patSubMatch[2], true);
    const rep = patSubMatch[3] ?? "";
    const prefix = mode === "/#" ? "^" : "";
    const suffix = mode === "/%" ? "$" : "";
    const flags = mode === "//" ? "g" : "";
    return val.replace(new RegExp(prefix + patStr + suffix, flags), () => rep);
  }

  if (rest === "^^") return hasKey ? val.toUpperCase() : failValue;
  if (rest === "^") return hasKey ? (val ? val[0].toUpperCase() + val.slice(1) : "") : failValue;
  if (rest === ",,") return hasKey ? val.toLowerCase() : failValue;
  if (rest === ",") return hasKey ? (val ? val[0].toLowerCase() + val.slice(1) : "") : failValue;

  return failValue;
}

function expandVariables(str: string, vars: Record<string, string> = {}): string {
  if (!str || !str.includes("$")) return str;
  const safeVars = vars || {};
  let out = str;
  for (let pass = 0; pass < 4 && out.includes("${"); pass++) {
    const next = out.replace(/\$\{([^{}]+)\}/g, (full, inner) =>
      expandSingleBraceExpression(full, inner, safeVars)
    );
    if (next === out) break;
    out = next;
  }
  return out.replace(/\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(safeVars, key)) {
      return safeVars[key];
    }
    if (/^[0-9@*#?$!-]$/.test(key)) {
      return "__atc_cmd_sub__";
    }
    return full;
  });
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
    if (args[idx] === "-v") return "__atc_cmd_sub__";
    const rawFmt = decodeShellEscapes(args[idx] ?? "");
    const fmtArgs = args.slice(idx + 1).map((a) => decodeShellEscapes(a));
    const strippedFmt = rawFmt
      .replace(/%%/g, "")
      .replace(/%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[sbc]/g, "");
    if (strippedFmt.includes("%")) {
      return "__atc_cmd_sub__";
    }
    if (!/%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[sbc]/.test(rawFmt)) {
      return rawFmt.replace(/%%/g, "%");
    }
    let out = "";
    let argIdx = 0;
    let invalidDynamicWidth = false;
    do {
      const prevIdx = argIdx;
      out += rawFmt.replace(
        /%(%|([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?([sbc]))/g,
        (_full, body, _flags, widthTok, precTok, spec) => {
          if (body === "%") return "%";
          if (widthTok === "*") {
            const w = parseInt(fmtArgs[argIdx++] ?? "", 10);
            if (Number.isNaN(w)) {
              invalidDynamicWidth = true;
              return "";
            }
          }
          let prec: number | undefined;
          if (precTok === "*") {
            const p = parseInt(fmtArgs[argIdx++] ?? "", 10);
            if (Number.isNaN(p)) {
              invalidDynamicWidth = true;
              return "";
            }
            prec = p;
          } else if (precTok !== undefined) {
            prec = parseInt(precTok, 10);
          }
          const val = fmtArgs[argIdx++] ?? "";
          if (spec === "c") return val.slice(0, 1);
          if (prec !== undefined && prec >= 0) return val.slice(0, prec);
          return val;
        }
      );
      if (invalidDynamicWidth) return "__atc_cmd_sub__";
      if (argIdx === prevIdx) break;
    } while (argIdx < fmtArgs.length);
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
        /^(?:env|command|nohup|timeout|sudo|nice|time|sh|bash|zsh|dash|ksh|fish|csh|tcsh|eval|-[A-Za-z]+|then|else|do|if|elif|while|until|!|\{|\()+$/i.test(
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
