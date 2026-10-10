import path from "node:path";

const FAST_PATH_REGEX = /\b(android|adb|emulator|gradlew|gradle|atc)\b/i;
const TRANSPARENT_WRAPPERS = new Set([
  "env",
  "command",
  "nohup",
  "timeout",
  "build-brief",
  "sudo",
  "nice",
  "time",
  "npx",
  "then",
  "else",
  "do",
  "if",
  "elif",
  "while",
  "until",
  "!",
  "{",
]);
const SHELL_WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "eval",
  "source",
  ".",
]);
const SHELL_BUILTIN_WRAPPERS = new Set([
  "command",
  "builtin",
  "eval",
  "source",
  ".",
  "time",
  "exec",
]);

function requiresShellExecution(cmdStr) {
  const firstTok = tokenizeSegment(cmdStr)[0] || "";
  return (
    firstTok.includes("=") ||
    SHELL_BUILTIN_WRAPPERS.has(firstTok.toLowerCase())
  );
}

const PASSIVE_NON_EXEC_COMMANDS = new Set([
  "echo",
  "printf",
  "git",
  "rg",
  "grep",
  "sed",
  "awk",
  "cat",
  "ls",
  "cd",
  "pwd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "chown",
  "find",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "tr",
  "cut",
  "jq",
  "true",
  "false",
  "which",
  "type",
  "esac",
  "fi",
  "done",
  "}",
]);

const CASE_PREFIX_BEFORE_PIPE_RE =
  /^(?:(?:(?:if|elif|while|until|then|else|do|\{|!)\s+)*case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in\s+)?\(?\s*(?:"[^"]*"|'[^']*'|[^\s|);(]+)$/;
const CASE_SUFFIX_AFTER_PIPE_RE =
  /^\s*(?:(?:"[^"]*"|'[^']*'|[^\s|);(]+)\s*\|\s*)*(?:"[^"]*"|'[^']*'|[^\s|);(]+)\)/;
const LEADING_CONTROL_PREFIX_RE =
  /^(?:(?:if|elif|while|until|then|else|do|\{|!)\s+|(?:function\s+[A-Za-z_][A-Za-z0-9_.-]*(?:\s*\(\s*\))?\s*\{\s*|[A-Za-z_][A-Za-z0-9_.-]*\s*\(\s*\)\s*\{\s*)|case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in\s+|\(?\s*(?:(?:"[^"]*"|'[^']*'|[^\s|);(]+)\s*\|\s*)*(?:"[^"]*"|'[^']*'|[^\s|);(]+)\)\s*|\((?!\()\s*)+/;

function isCasePatternAlternationPipe(cur, rest) {
  return CASE_PREFIX_BEFORE_PIPE_RE.test(cur.trim()) && CASE_SUFFIX_AFTER_PIPE_RE.test(rest);
}

const READ_ONLY_ANDROID_SUBCOMMANDS = new Set([
  "docs",
  "sdk",
  "info",
  "help",
  "skills",
  "studio",
  "describe",
  "create",
  "init",
  "update",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const READ_ONLY_ADB_SUBCOMMANDS = new Set([
  "devices",
  "version",
  "help",
  "start-server",
  "--version",
  "--help",
]);

const TOOL_NAMES = ["android", "adb", "emulator", "gradlew", "gradle", "atc"];

function decodeShellEscapes(str) {
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
    },
  );
}

function resolveStaticSubValue(expandedInner, prefixWord = "", suffixWord = "") {
  const tokens = tokenizeSegment(
    String(expandedInner || "")
      .trimStart()
      .replace(LEADING_CONTROL_PREFIX_RE, ""),
  );
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
    if (args[idx] === "-v") {
      return "__atc_cmd_sub__";
    }
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
          let prec;
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
        },
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

function matchesAndroidOrAtcText(str, inheritedVars = {}) {
  if (!str || typeof str !== "string") return false;
  if (FAST_PATH_REGEX.test(str)) return true;
  const subExpanded =
    str.includes("$") || str.includes("`") ? extractCommandSubstitutions(str, []) : str;
  const ansiDecoded = subExpanded.replace(/\$'((?:\\.|[^'])*)'/g, (_m, inner) =>
    decodeShellEscapes(inner),
  );
  if (FAST_PATH_REGEX.test(ansiDecoded)) return true;
  const normalizedVars = ansiDecoded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?=["'\\].)/g, "${$1}");
  const collapsed = decodeShellEscapes(normalizedVars)
    .replace(/\\(.)/g, "$1")
    .replace(/["']/g, "");
  if (FAST_PATH_REGEX.test(collapsed)) return true;
  let expandedForCmdCheck = collapsed;
  if (collapsed.includes("$")) {
    const vars = { ...inheritedVars };
    const assignRe = /\b([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&)]+)/g;
    let m;
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
      const strippedClause = rawClause.trimStart().replace(LEADING_CONTROL_PREFIX_RE, "");
      const tokens = strippedClause
        .trim()
        .split(/\s+/)
        .filter((t) => Boolean(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
      while (
        tokens.length > 0 &&
        /^(?:env|command|nohup|timeout|sudo|nice|time|sh|bash|zsh|dash|ksh|fish|csh|tcsh|eval|-[A-Za-z]+|then|else|do|if|elif|while|until|!|\{|\()+$/i.test(
          tokens[0],
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

export function hasAndroidOrAtcTokens(command) {
  if (!command || typeof command !== "string") return false;
  if (matchesAndroidOrAtcText(command)) return true;
  if (command.includes("$") || command.includes("`")) {
    const shellVars = {};
    for (const seg of splitShellSegments(command)) {
      const parsed = parseSegment(seg, shellVars);
      Object.assign(shellVars, parsed.envVars || {});
      if (
        parsed.cmd.includes("__atc_cmd_sub__") ||
        parsed.baseCmd.includes("__atc_cmd_sub__") ||
        matchesAndroidOrAtcText(parsed.baseCmd, shellVars) ||
        matchesAndroidOrAtcText(parsed.raw, shellVars) ||
        parsed.args.some((a) => matchesAndroidOrAtcText(a, shellVars))
      ) {
        return true;
      }
    }
  }
  return false;
}

function splitOutsideQuotes(str, sepType) {
  const parts = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\" && !inSingle && i + 1 < str.length) {
      cur += ch + str[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (sepType === "clause") {
        if ((ch === "&" && str[i + 1] === "&") || (ch === "|" && str[i + 1] === "|")) {
          if (cur.trim()) parts.push(cur.trim());
          cur = "";
          i++;
          continue;
        }
        if (ch === ";") {
          if (cur.trim()) parts.push(cur.trim());
          cur = "";
          if (str[i + 1] === ";" && str[i + 2] === "&") {
            i += 2;
          } else if (str[i + 1] === ";" || str[i + 1] === "&") {
            i += 1;
          }
          continue;
        }
        if (
          ch === "\n" ||
          (ch === "&" &&
            str[i + 1] !== ">" &&
            str[i - 1] !== ">" &&
            str[i - 1] !== "<" &&
            str[i - 1] !== "|")
        ) {
          if (cur.trim()) parts.push(cur.trim());
          cur = "";
          continue;
        }
      } else if (sepType === "pipe") {
        if (
          ch === "|" &&
          str[i + 1] !== "|" &&
          !isCasePatternAlternationPipe(cur, str.slice(i + 1))
        ) {
          if (cur.trim()) parts.push(cur.trim());
          cur = "";
          if (str[i + 1] === "&") {
            i++;
          }
          continue;
        }
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function extractCommandSubstitutions(str, innerSubstitutions) {
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
        const expandedInner = extractCommandSubstitutions(rawInner, innerSubstitutions);
        innerSubstitutions.push(expandedInner);
        const prefixMatch = out.match(/([A-Za-z0-9_.-]+)$/);
        const suffixMatch = str.slice(j).match(/^([A-Za-z0-9_.-]+)/);
        out += resolveStaticSubValue(
          expandedInner,
          prefixMatch ? prefixMatch[1] : "",
          suffixMatch ? suffixMatch[1] : "",
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
        const expandedInner = extractCommandSubstitutions(rawInner, innerSubstitutions);
        innerSubstitutions.push(expandedInner);
        const prefixMatch = out.match(/([A-Za-z0-9_.-]+)$/);
        const suffixMatch = str.slice(j + 1).match(/^([A-Za-z0-9_.-]+)/);
        out += resolveStaticSubValue(
          expandedInner,
          prefixMatch ? prefixMatch[1] : "",
          suffixMatch ? suffixMatch[1] : "",
        );
        i = j;
        continue;
      }
    }
    out += ch;
  }

  return out;
}

export function splitShellSegments(command) {
  if (!command || typeof command !== "string") return [];
  const innerSubstitutions = [];
  const inlineExpanded = extractCommandSubstitutions(command, innerSubstitutions);
  const normalized =
    innerSubstitutions.length > 0
      ? `${inlineExpanded} ; ${innerSubstitutions.join(" ; ")}`
      : inlineExpanded;
  const clauses = splitOutsideQuotes(normalized, "clause");
  const segments = [];
  for (const clause of clauses) {
    const stages = splitOutsideQuotes(clause, "pipe");
    const upstreamArgs = [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const parsedStage = parseSegment(stage);
      if (i > 0 && upstreamArgs.length > 0) {
        if (SHELL_WRAPPERS.has(parsedStage.baseCmd)) {
          segments.push(`${stage} ${upstreamArgs.map((a) => JSON.stringify(a)).join(" ")}`);
        } else if (parsedStage.baseCmd === "xargs" || parsedStage.baseCmd === "parallel") {
          segments.push(`${stage} ${upstreamArgs.join(" ")}`);
        } else {
          segments.push(stage);
        }
      } else {
        segments.push(stage);
      }
      for (const arg of parsedStage.args) {
        if (!/^-[A-Za-z0-9]+$/.test(arg) || matchesAndroidOrAtcText(arg, parsedStage.envVars)) {
          upstreamArgs.push(arg);
        }
      }
    }
  }
  return segments;
}

export function tokenizeSegment(segment, { preserveLiteralDollar = false } = {}) {
  const tokens = [];
  const str = String(segment || "");
  const isWinPathLike = (s) => /^(?:[A-Za-z]:\\|\.\\|\.\.\\|\\\\)/.test(s);
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /\s/.test(str[i])) i++;
    if (i >= str.length) break;
    const start = i;
    let end = i;
    while (end < str.length && !/\s/.test(str[end])) {
      if (str[end] === '"') {
        end++;
        while (end < str.length && str[end] !== '"') {
          if (str[end] === "\\" && end + 1 < str.length) end += 2;
          else end++;
        }
        if (end < str.length) end++;
      } else if (str[end] === "'") {
        end++;
        while (end < str.length && str[end] !== "'") end++;
        if (end < str.length) end++;
      } else if (str[end] === "\\" && end + 1 < str.length) {
        end += 2;
      } else {
        end++;
      }
    }
    const rawWord = str.slice(start, end);
    const keepBackslashes = isWinPathLike(rawWord) || rawWord === "\\;";
    let tok = "";
    let j = 0;
    while (j < rawWord.length) {
      const ch = rawWord[j];
      if (ch === '"') {
        j++;
        while (j < rawWord.length && rawWord[j] !== '"') {
          if (rawWord[j] === "\\" && j + 1 < rawWord.length && /["\\$`]/.test(rawWord[j + 1])) {
            const escapedCh = rawWord[j + 1];
            tok += preserveLiteralDollar && escapedCh === "$" ? "\uE000" : escapedCh;
            j += 2;
          } else {
            tok += rawWord[j++];
          }
        }
        if (j < rawWord.length) j++;
      } else if (ch === "$" && rawWord[j + 1] === "'") {
        j += 2;
        let ansiInner = "";
        while (j < rawWord.length && rawWord[j] !== "'") {
          if (rawWord[j] === "\\" && j + 1 < rawWord.length) {
            ansiInner += rawWord[j] + rawWord[j + 1];
            j += 2;
          } else {
            ansiInner += rawWord[j++];
          }
        }
        if (j < rawWord.length) j++;
        const decoded = decodeShellEscapes(ansiInner);
        tok += preserveLiteralDollar ? decoded.replace(/\$/g, "\uE000") : decoded;
      } else if (ch === "'") {
        j++;
        while (j < rawWord.length && rawWord[j] !== "'") {
          const sqCh = rawWord[j++];
          tok += preserveLiteralDollar && sqCh === "$" ? "\uE000" : sqCh;
        }
        if (j < rawWord.length) j++;
      } else if (ch === "\\" && j + 1 < rawWord.length && !keepBackslashes) {
        const escapedCh = rawWord[j + 1];
        tok += preserveLiteralDollar && escapedCh === "$" ? "\uE000" : escapedCh;
        j += 2;
      } else if (ch === "$") {
        const m = rawWord.slice(j).match(/^\$([A-Za-z_][A-Za-z0-9_]*)(?=["'\\].)/);
        if (m) {
          tok += `\${${m[1]}}`;
          j += m[0].length;
        } else {
          tok += rawWord[j++];
        }
      } else {
        tok += rawWord[j++];
      }
    }
    tokens.push(tok);
    i = end;
  }
  return tokens;
}

function shellPatToRegExpStr(pat, greedy = true) {
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

function expandSingleBraceExpression(full, inner, vars, opaqueFallback) {
  const failValue = opaqueFallback !== null ? opaqueFallback : full;
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
  if (!hasKey && opaqueFallback === null) {
    return failValue;
  }
  const val = hasKey ? String(vars[key]) : "";
  const rest = m[2].replace(/\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g, (rawRef, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : rawRef,
  );

  // Substring / positional-slice expansion: ${var:offset} or ${var:offset:length}
  const subSliceMatch = rest.match(/^:(?:\s+(-?\d+)|(\d+))(?::\s*(-?\d+))?$/);
  if (subSliceMatch) {
    if (!hasKey) return failValue;
    const offset = parseInt(subSliceMatch[1] ?? subSliceMatch[2], 10);
    if ((key === "@" || key === "*") && Object.prototype.hasOwnProperty.call(vars, "#")) {
      const count = parseInt(vars["#"], 10) || 0;
      const posList = [
        vars["0"] ?? "",
        ...Array.from({ length: count }, (_, i) => vars[String(i + 1)] ?? ""),
      ];
      const baseList = offset === 0 ? posList : posList.slice(1);
      const start =
        offset === 0
          ? 0
          : offset < 0
            ? Math.max(0, baseList.length + offset)
            : Math.max(0, offset - 1);
      if (subSliceMatch[3] === undefined) {
        return baseList.slice(start).join(" ");
      }
      const len = parseInt(subSliceMatch[3], 10);
      if (len < 0) return failValue;
      return baseList.slice(start, start + len).join(" ");
    }
    const start = offset < 0 ? Math.max(0, val.length + offset) : offset;
    if (subSliceMatch[3] === undefined) {
      return val.slice(start);
    }
    const len = parseInt(subSliceMatch[3], 10);
    return len < 0
      ? val.slice(start, Math.max(start, val.length + len))
      : val.slice(start, start + len);
  }

  // Default / alternate value operators: :-, -, :=, =, :+, +, :?, ?
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

  // Prefix removal: ${var#pat} or ${var##pat}
  const prefMatch = rest.match(/^(#{1,2})(.*)$/s);
  if (prefMatch) {
    if (!hasKey || prefMatch[2].includes("$")) return failValue;
    const greedy = prefMatch[1] === "##";
    const re = new RegExp("^" + shellPatToRegExpStr(prefMatch[2], greedy));
    return val.replace(re, "");
  }

  // Suffix removal: ${var%pat} or ${var%%pat}
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

  // Pattern substitution: ${var/pat/rep}, ${var//pat/rep}, ${var/#pat/rep}, ${var/%pat/rep}
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

  // Case modification: ^, ^^, ,, ,,
  if (rest === "^^") return hasKey ? val.toUpperCase() : failValue;
  if (rest === "^") return hasKey ? (val ? val[0].toUpperCase() + val.slice(1) : "") : failValue;
  if (rest === ",,") return hasKey ? val.toLowerCase() : failValue;
  if (rest === ",") return hasKey ? (val ? val[0].toLowerCase() + val.slice(1) : "") : failValue;

  return failValue;
}

function expandUnquotedChunk(str, safeVars, opaqueFallback) {
  let out = str.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?=["'\\.]|$)/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(safeVars, k) ? `\${${k}}` : m,
  );
  for (let pass = 0; pass < 4 && out.includes("${"); pass++) {
    const next = out.replace(/\$\{([^{}]+)\}/g, (full, inner) =>
      expandSingleBraceExpression(full, inner, safeVars, opaqueFallback),
    );
    if (next === out) break;
    out = next;
  }
  return out.replace(/\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(safeVars, key)) {
      return safeVars[key];
    }
    if (/^[0-9@*#?$!-]$/.test(key) && opaqueFallback !== null) {
      return opaqueFallback;
    }
    return full;
  });
}

export function expandVariables(str, vars = {}, { opaqueFallback = "__atc_cmd_sub__" } = {}) {
  if (!str || typeof str !== "string") {
    return str;
  }
  if (!str.includes("$")) {
    return str.replace(/\uE000/g, "$");
  }
  const safeVars = vars || {};
  let out = "";
  let chunk = "";
  let inSingle = false;
  let inDouble = false;
  const flushChunk = () => {
    if (chunk) {
      out += expandUnquotedChunk(chunk, safeVars, opaqueFallback);
      chunk = "";
    }
  };

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (!inSingle && ch === "\\" && i + 1 < str.length) {
      if (str[i + 1] === "$") {
        flushChunk();
        out += "\\$";
        i++;
        continue;
      }
      chunk += ch + str[i + 1];
      i++;
      continue;
    }
    if (!inSingle && !inDouble && ch === "$" && str[i + 1] === "'") {
      flushChunk();
      out += "$'";
      i += 2;
      while (i < str.length && str[i] !== "'") {
        if (str[i] === "\\" && i + 1 < str.length) {
          out += str[i] + str[i + 1];
          i += 2;
        } else {
          out += str[i++];
        }
      }
      if (i < str.length && str[i] === "'") {
        out += "'";
      }
      continue;
    }
    if (!inDouble && ch === "'") {
      flushChunk();
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (inSingle) {
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      chunk += ch;
      continue;
    }
    chunk += ch;
  }
  flushChunk();
  return out.replace(/\uE000/g, "$");
}

export function parseSegment(segment, inheritedVars = {}) {
  const rawStripped = String(segment || "")
    .trimStart()
    .replace(LEADING_CONTROL_PREFIX_RE, "");
  const strippedSegment =
    rawStripped.includes("$(") ||
    rawStripped.includes("<(") ||
    rawStripped.includes(">(") ||
    rawStripped.includes("`")
      ? extractCommandSubstitutions(rawStripped, [])
      : rawStripped;
  const tokens = tokenizeSegment(strippedSegment, { preserveLiteralDollar: true });
  let baseVars = { ...inheritedVars };
  const envVars = {};
  let stripsAndroidSerial = Boolean(inheritedVars.__atc_stripped_android_serial);
  let idx = 0;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === "export") {
      idx++;
      let isUnexport = false;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        const flag = tokens[idx++];
        if (flag === "--") break;
        if (
          flag === "-n" ||
          (flag.startsWith("-") && !flag.startsWith("--") && flag.slice(1).includes("n"))
        ) {
          isUnexport = true;
        }
      }
      if (isUnexport) {
        while (idx < tokens.length) {
          const arg = tokens[idx++];
          const k = arg.split("=")[0];
          delete baseVars[k];
          delete envVars[k];
          if (k === "ANDROID_SERIAL") {
            stripsAndroidSerial = true;
            envVars.__atc_stripped_android_serial = "1";
          }
        }
        break;
      }
      continue;
    }
    if (tok === "unset") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        const flag = tokens[idx++];
        if (flag === "--") break;
      }
      while (idx < tokens.length) {
        const k = tokens[idx++];
        delete baseVars[k];
        delete envVars[k];
        if (k === "ANDROID_SERIAL") {
          stripsAndroidSerial = true;
          envVars.__atc_stripped_android_serial = "1";
        }
      }
      break;
    }
    const eq = tok.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) {
      const k = tok.slice(0, eq);
      const rawVal = tok.slice(eq + 1);
      const expandedVal = expandVariables(rawVal, { ...baseVars, ...envVars });
      envVars[k] = expandedVal;
      if (k === "ANDROID_SERIAL") {
        if (expandedVal) {
          stripsAndroidSerial = false;
          delete baseVars.__atc_stripped_android_serial;
          delete envVars.__atc_stripped_android_serial;
        } else {
          delete baseVars.ANDROID_SERIAL;
          delete envVars.ANDROID_SERIAL;
          stripsAndroidSerial = true;
          envVars.__atc_stripped_android_serial = "1";
        }
      }
      idx++;
      continue;
    }
    const base = path.basename(tok, path.extname(tok)).toLowerCase();
    if (base === "command" && (tokens[idx + 1] === "-v" || tokens[idx + 1] === "-V")) {
      break;
    }
    if (TRANSPARENT_WRAPPERS.has(base)) {
      idx++;
      if (base === "env") {
        while (idx < tokens.length && (tokens[idx] === "-" || tokens[idx].startsWith("-"))) {
          const flag = tokens[idx];
          idx++;
          if (flag === "--") {
            break;
          }
          if (flag === "-" || flag === "-i" || flag === "--ignore-environment") {
            baseVars = {};
            for (const k of Object.keys(envVars)) {
              delete envVars[k];
            }
            stripsAndroidSerial = true;
          } else if (flag === "-u" || flag === "--unset") {
            const unsetKey = tokens[idx] || "";
            if (idx < tokens.length) idx++;
            delete baseVars[unsetKey];
            delete envVars[unsetKey];
            if (unsetKey === "ANDROID_SERIAL") {
              stripsAndroidSerial = true;
            }
          } else if (flag.startsWith("--unset=") || (flag.startsWith("-u") && flag.length > 2)) {
            const unsetKey = flag.startsWith("--unset=") ? flag.slice("--unset=".length) : flag.slice(2);
            delete baseVars[unsetKey];
            delete envVars[unsetKey];
            if (unsetKey === "ANDROID_SERIAL") {
              stripsAndroidSerial = true;
            }
          } else if (flag === "-S" || flag === "--split-string") {
            const splitStr = tokens[idx] || "";
            if (idx < tokens.length) {
              tokens.splice(idx, 1, ...tokenizeSegment(splitStr));
            }
          } else if (flag.startsWith("--split-string=") || (flag.startsWith("-S") && flag.length > 2)) {
            const splitStr = flag.startsWith("--split-string=") ? flag.slice("--split-string=".length) : flag.slice(2);
            tokens.splice(idx, 0, ...tokenizeSegment(splitStr));
          } else if ((flag === "-C" || flag === "--chdir") && idx < tokens.length) {
            idx++;
          }
        }
      } else if (base === "command") {
        while (idx < tokens.length && (tokens[idx] === "-p" || tokens[idx] === "--")) {
          idx++;
        }
      } else if (base === "timeout") {
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          const flag = tokens[idx++];
          if (flag === "--") break;
          if ((flag === "-k" || flag === "-s") && idx < tokens.length) {
            idx++;
          }
        }
        if (idx < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[idx])) {
          idx++;
        }
      } else if (base === "sudo") {
        let sudoPreservesSerial = false;
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          const flag = tokens[idx];
          idx++;
          if (flag === "--") break;
          if (
            flag === "-E" ||
            flag === "--preserve-env" ||
            (flag.startsWith("-") && !flag.startsWith("--") && flag.slice(1).includes("E"))
          ) {
            sudoPreservesSerial = true;
          } else if (
            flag.startsWith("--preserve-env=") &&
            flag
              .slice("--preserve-env=".length)
              .split(",")
              .map((s) => s.trim())
              .includes("ANDROID_SERIAL")
          ) {
            sudoPreservesSerial = true;
          }
          if (
            (flag === "-u" ||
              flag === "-g" ||
              flag === "-C" ||
              flag === "-D" ||
              flag === "-R" ||
              flag === "-T") &&
            idx < tokens.length
          ) {
            idx++;
          }
        }
        if (!sudoPreservesSerial) {
          baseVars = {};
          for (const k of Object.keys(envVars)) {
            delete envVars[k];
          }
          stripsAndroidSerial = true;
        }
      } else if (base === "nice") {
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          const flag = tokens[idx];
          idx++;
          if (flag === "--") break;
          if (flag === "-n" && idx < tokens.length) {
            idx++;
          }
        }
      }
      continue;
    }
    break;
  }

  const allVars = { ...baseVars, ...envVars };
  const rawTokens = tokens.slice(idx);
  const remaining = rawTokens.map((t) => expandVariables(t, allVars));
  if (remaining.length > 0 && rawTokens[0]?.includes("$") && /\s/.test(remaining[0])) {
    const splitCmdTokens = remaining[0].trim().split(/\s+/).filter(Boolean);
    if (splitCmdTokens.length > 0) {
      remaining.splice(0, 1, ...splitCmdTokens);
    }
  }
  while (
    remaining.length > 1 &&
    (["fi", "done", "esac", "}"].includes(remaining[remaining.length - 1]) ||
      /^\)+$/.test(remaining[remaining.length - 1]))
  ) {
    remaining.pop();
  }
  if (
    remaining.length > 0 &&
    /\)+$/.test(remaining[remaining.length - 1]) &&
    !remaining[remaining.length - 1].includes("(")
  ) {
    remaining[remaining.length - 1] = remaining[remaining.length - 1].replace(/\)+$/, "");
    if (!remaining[remaining.length - 1] && remaining.length > 1) {
      remaining.pop();
    }
  }
  const cmd = remaining[0] || "";
  const baseCmd = path.basename(cmd, path.extname(cmd)).toLowerCase();
  const args = remaining.slice(1);
  return {
    raw: expandVariables(segment, allVars),
    envVars: allVars,
    stripsAndroidSerial,
    cmd,
    baseCmd,
    args,
  };
}

export function extractTargetSerial(parsed) {
  const { baseCmd, args } = parsed;
  if (baseCmd === "adb") {
    const selectors = [];
    let subIdx = 0;
    while (subIdx < args.length) {
      const a = String(args[subIdx]);
      if (a === "-d" || a === "-e" || a === "-t" || a.startsWith("-t")) {
        selectors.push(a === "-t" && subIdx + 1 < args.length ? `-t ${args[subIdx + 1]}` : a);
        subIdx += a === "-t" && subIdx + 1 < args.length ? 2 : 1;
        continue;
      }
      if (a === "-s" && subIdx + 1 < args.length) {
        selectors.push(String(args[subIdx + 1]));
        subIdx += 2;
        continue;
      }
      if (a.startsWith("-s") && a.length > 2) {
        selectors.push(a.slice(2));
        subIdx += 1;
        continue;
      }
      if (a === "-H" || a === "-P" || a === "-L") {
        subIdx += 2;
      } else if (a.startsWith("-")) {
        subIdx += 1;
      } else if (a.startsWith("wait-for-") && subIdx + 1 < args.length) {
        subIdx += 1;
      } else {
        break;
      }
    }
    if (selectors.length > 0) {
      const unique = Array.from(new Set(selectors));
      return unique.length === 1 ? unique[0] : unique.join(",");
    }
  } else {
    const selectors = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") break;
      if (a.startsWith("--device=")) {
        selectors.push(a.slice("--device=".length));
      } else if ((a === "--device" || a === "-s") && i + 1 < args.length) {
        selectors.push(args[i + 1]);
        i += 1;
      }
    }
    if (selectors.length > 0) {
      const unique = Array.from(new Set(selectors));
      return unique.length === 1 ? unique[0] : unique.join(",");
    }
  }
  if (parsed.envVars.ANDROID_SERIAL) {
    return parsed.envVars.ANDROID_SERIAL;
  }
  if (parsed.stripsAndroidSerial) {
    return "<stripped-ANDROID_SERIAL>";
  }
  return null;
}

export function classifySegment(segment, inheritedVars = {}, depth = 0) {
  const parsed = parseSegment(segment, inheritedVars);
  if (depth > 8) {
    return {
      kind: "device_action",
      targetSerial: extractTargetSerial(parsed),
      parsed,
    };
  }
  const { baseCmd, args } = parsed;
  const effectiveSegment = parsed.raw || segment;

  if (!baseCmd || (baseCmd === "command" && (args[0] === "-v" || args[0] === "-V"))) {
    return { kind: "ignore", parsed };
  }

  if (parsed.cmd.includes("__atc_cmd_sub__") || baseCmd.includes("__atc_cmd_sub__")) {
    return {
      kind: "deny_lifecycle",
      reason:
        "Opaque command substitution in executable position is blocked; invoke Android/ATC tools directly or via 'atc exec'.",
      parsed,
    };
  }

  // Precedence 1: ATC commands (`atc ...`)
  if (baseCmd === "atc") {
    let subIdx = 0;
    let atcSerialFlag = null;
    while (subIdx < args.length) {
      const a = args[subIdx];
      if ((a === "--serial" || a === "-s") && subIdx + 1 < args.length) {
        atcSerialFlag = args[subIdx + 1];
        subIdx += 2;
      } else if (a.startsWith("--serial=")) {
        atcSerialFlag = a.slice("--serial=".length);
        subIdx += 1;
      } else if (
        (a === "--session" ||
          a === "--role" ||
          a === "--anchor-pid" ||
          a === "--lease" ||
          a === "--state-dir") &&
        subIdx + 1 < args.length
      ) {
        subIdx += 2;
      } else if (a.startsWith("-") && a !== "--") {
        subIdx += 1;
      } else {
        break;
      }
    }
    const subcommand = args[subIdx] || "";
    let execTargetSerial = null;
    if (subcommand === "exec") {
      const dashDashIdx = args.indexOf("--", subIdx + 1);
      let wrappedTokens = [];
      let i = subIdx + 1;
      const scanEnd = dashDashIdx !== -1 ? dashDashIdx : args.length;
      while (i < scanEnd) {
        const a = args[i];
        if ((a === "--serial" || a === "-s") && i + 1 < scanEnd) {
          atcSerialFlag = args[i + 1];
          i += 2;
        } else if (a.startsWith("--serial=")) {
          atcSerialFlag = a.slice("--serial=".length);
          i += 1;
        } else if (
          (a === "--session" ||
            a === "--role" ||
            a === "--anchor-pid" ||
            a === "--lease" ||
            a === "--state-dir") &&
          i + 1 < scanEnd
        ) {
          i += 2;
        } else if (a.startsWith("--")) {
          i += 1;
        } else {
          break;
        }
      }
      if (dashDashIdx !== -1) {
        wrappedTokens = args.slice(dashDashIdx + 1);
      } else {
        wrappedTokens = args.slice(i);
      }
      if (wrappedTokens.length > 0) {
        const wrappedSeg = wrappedTokens
          .map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a))
          .join(" ");
        const execInheritedVars = { ...parsed.envVars };
        if (atcSerialFlag) {
          execInheritedVars.ANDROID_SERIAL = atcSerialFlag;
        } else if (
          !execInheritedVars.ANDROID_SERIAL &&
          !parsed.stripsAndroidSerial &&
          !execInheritedVars.__atc_stripped_android_serial
        ) {
          execInheritedVars.ANDROID_SERIAL = "__ATC_EXEC_INJECTED_SERIAL__";
        }
        const innerClass = classifySegment(wrappedSeg, execInheritedVars, depth + 1);
        if (innerClass.kind === "deny_lifecycle") {
          return innerClass;
        }
        if (
          innerClass.targetSerial &&
          innerClass.targetSerial !== "__ATC_EXEC_INJECTED_SERIAL__"
        ) {
          execTargetSerial = innerClass.targetSerial;
        } else if (atcSerialFlag) {
          execTargetSerial = atcSerialFlag;
        }
      } else if (atcSerialFlag) {
        execTargetSerial = atcSerialFlag;
      }
    }
    return {
      kind: "atc",
      subcommand,
      execTargetSerial,
      parsed,
    };
  }

  // Precedence 2: Direct lifecycle bypass (evaluated before generic android subcommands!)
  const androidSubInfo = (() => {
    if (baseCmd !== "android") return null;
    const valueFlags = new Set([
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
    let subIdx = 0;
    while (subIdx < args.length) {
      const a = String(args[subIdx]);
      if (a === "--") {
        subIdx += 1;
        break;
      }
      if (valueFlags.has(a) && subIdx + 1 < args.length) {
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
      if (valueFlags.has(a) && actIdx + 1 < args.length) {
        actIdx += 2;
      } else if (a.startsWith("-")) {
        actIdx += 1;
      } else {
        break;
      }
    }
    const action = String(args[actIdx] || args[subIdx + 1] || "");
    return { subIdx, sub, actIdx, action, valueFlags };
  })();

  if (baseCmd === "emulator" || (baseCmd === "android" && androidSubInfo.sub === "emulator")) {
    if (baseCmd === "emulator") {
      if (args.includes("-list-avds") || args.includes("-version") || args.includes("-help")) {
        return { kind: "read_only", parsed };
      }
      return {
        kind: "deny_lifecycle",
        reason:
          'Direct emulator launch is disabled under ATC. Use "atc claim --type <type> --api <api>" instead.',
        parsed,
      };
    }
    const emuAction = androidSubInfo.action;
    if (["start", "stop", "remove", "create"].includes(emuAction)) {
      if (emuAction === "create" && args.includes("--list-profiles")) {
        return { kind: "read_only", parsed };
      }
      return {
        kind: "deny_lifecycle",
        reason: `Direct "android emulator ${emuAction}" is disabled under ATC. Use "atc claim --type <type> --api <api>" (with --create-if-missing if needed) or "atc free --stop" instead.`,
        parsed,
      };
    }
    if (emuAction === "list" || emuAction === "--help" || emuAction === "-h") {
      return { kind: "read_only", parsed };
    }
  }

  if (baseCmd === "android" && androidSubInfo.sub === "device" && androidSubInfo.action === "remote") {
    const remoteLifecycleVerbs = new Set([
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
    let remIdx = androidSubInfo.actIdx + 1;
    while (remIdx < args.length) {
      const a = String(args[remIdx]);
      if (androidSubInfo.valueFlags.has(a) && remIdx + 1 < args.length) {
        remIdx += 2;
      } else if (a.startsWith("-")) {
        remIdx += 1;
      } else {
        break;
      }
    }
    const remoteAction = String(args[remIdx] || "");
    const fallbackVerb = args
      .slice(androidSubInfo.actIdx + 1)
      .map(String)
      .find((t) => remoteLifecycleVerbs.has(t));
    if (args.includes("--help") || args.includes("-h")) {
      return { kind: "read_only", parsed };
    }
    const deniedAction = remoteLifecycleVerbs.has(remoteAction)
      ? remoteAction
      : fallbackVerb || (remoteAction && remoteAction !== "list" && remoteAction !== "status" ? remoteAction : "");
    if (deniedAction) {
      return {
        kind: "deny_lifecycle",
        reason: `Direct "android device remote ${deniedAction}" is disabled under ATC because remote device lifecycle is not isolated per lease.`,
        parsed,
      };
    }
    return { kind: "read_only", parsed };
  }

  if (baseCmd === "adb") {
    // Strip -s <serial> / -d / -e / -t / -H / -P / -L flags and wait-for-* prefixes to find the adb subcommand
    let subIdx = 0;
    let hadWaitPrefix = false;
    while (subIdx < args.length) {
      const a = args[subIdx];
      if (a === "--one-device" || a.startsWith("--one-device=")) {
        return {
          kind: "deny_lifecycle",
          reason:
            'Direct "adb --one-device" is disabled under ATC because it restricts the shared ADB server on the host.',
          parsed,
        };
      }
      if (a === "-s" || a === "-t" || a === "-H" || a === "-P" || a === "-L") {
        subIdx += 2;
      } else if (a.startsWith("-")) {
        subIdx += 1;
      } else if (a.startsWith("wait-for-") && subIdx + 1 < args.length) {
        hadWaitPrefix = true;
        subIdx += 1;
      } else {
        break;
      }
    }
    const adbSub = args[subIdx] || "";
    const adbRest = args.slice(subIdx + 1);
    if (adbSub === "kill-server") {
      return {
        kind: "deny_lifecycle",
        reason:
          'Direct "adb kill-server" is disabled under ATC because it disrupts all shared device sessions on the host.',
        parsed,
      };
    }
    if (adbSub === "reconnect") {
      const reconnectTargets = adbRest.filter((a) => !a.startsWith("-"));
      if (reconnectTargets.includes("offline")) {
        return {
          kind: "deny_lifecycle",
          reason:
            'Direct "adb reconnect offline" is disabled under ATC because it resets all offline/unauthorized devices on the host.',
          parsed,
        };
      }
      if (reconnectTargets.length !== 1 || reconnectTargets[0] !== "device") {
        return {
          kind: "deny_lifecycle",
          reason:
            'Bare "adb reconnect" is disabled under ATC because it resets host-side ADB connections across the host; use "adb reconnect device" inside "atc exec --" instead.',
          parsed,
        };
      }
    }
    if (adbSub === "emu" && adbRest[0] === "kill") {
      return {
        kind: "deny_lifecycle",
        reason: 'Direct "adb emu kill" is disabled under ATC. Use "atc free --stop" instead.',
        parsed,
      };
    }
    if (adbSub === "attach" || adbSub === "detach") {
      const usbTargets = adbRest.filter((a) => !a.startsWith("-"));
      const explicitSel = extractTargetSerial(parsed);
      const allTargets = Array.from(
        new Set([...(explicitSel ? [explicitSel] : []), ...usbTargets]),
      );
      return {
        kind: "device_action",
        targetSerial:
          allTargets.length === 0
            ? null
            : allTargets.length === 1
              ? allTargets[0]
              : allTargets.join(","),
        parsed,
      };
    }
    if (adbSub === "disconnect") {
      const disconnectTargets = adbRest.filter((a) => !a.startsWith("-"));
      if (disconnectTargets.length === 0) {
        return {
          kind: "deny_lifecycle",
          reason:
            'Bare "adb disconnect" is disabled under ATC because it disconnects all TCP/IP devices on the host; specify the leased target serial explicitly.',
          parsed,
        };
      }
      const explicitSel = extractTargetSerial(parsed);
      const allTargets = Array.from(
        new Set([...(explicitSel ? [explicitSel] : []), ...disconnectTargets]),
      );
      return {
        kind: "device_action",
        targetSerial: allTargets.length === 1 ? allTargets[0] : allTargets.join(","),
        parsed,
      };
    }
    if (!hadWaitPrefix && (!adbSub || READ_ONLY_ADB_SUBCOMMANDS.has(adbSub))) {
      return { kind: "read_only", parsed };
    }
    return {
      kind: "device_action",
      targetSerial: extractTargetSerial(parsed),
      parsed,
    };
  }

  // Precedence 3: Read-only Android commands (including top-level `android create` project creation and `android screen resolve`)
  if (baseCmd === "android") {
    const sub = androidSubInfo.sub;
    const action = androidSubInfo.action;
    if (
      !sub ||
      READ_ONLY_ANDROID_SUBCOMMANDS.has(sub) ||
      args.includes("--help") ||
      args.includes("-h") ||
      (sub === "screen" &&
        (!action || action === "resolve" || action === "--help" || action === "-h"))
    ) {
      return { kind: "read_only", parsed };
    }
    return {
      kind: "device_action",
      targetSerial: extractTargetSerial(parsed),
      parsed,
    };
  }

  // Precedence 4: Gradle connectedAndroidTest and install/uninstall tasks
  if (baseCmd === "gradlew" || baseCmd === "gradle") {
    const hasDeviceTask = args.some((a) => {
      if (!a || a.startsWith("-")) return false;
      const taskName = a.split(":").pop() || "";
      if (/^(connected.*androidtest|connectedcheck|devicecheck)$/i.test(taskName)) {
        return true;
      }
      if (/^uninstall([A-Z0-9_].*)?$/i.test(taskName)) {
        return true;
      }
      if (
        /^install([A-Z0-9_].*)?$/i.test(taskName) &&
        !/^install(Dist|BootDist|ShadowDist|Maven|ToMavenLocal)$/i.test(taskName)
      ) {
        return true;
      }
      return false;
    });
    if (hasDeviceTask) {
      return {
        kind: "device_action",
        targetSerial: extractTargetSerial(parsed),
        parsed,
      };
    }
    return { kind: "ignore", parsed };
  }

  // Shell wrappers (e.g., `bash -c "adb shell ..."`, `sh -lc "emulator -avd ..."`, `eval adb shell ...`)
  if (SHELL_WRAPPERS.has(baseCmd)) {
    const cShells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
    const innerEntries = [];
    let handledCWrapper = false;
    if (cShells.has(baseCmd)) {
      let hasCFlag = false;
      let scriptIdx = -1;
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]);
        if (a === "--") {
          if (i + 1 < args.length) scriptIdx = i + 1;
          break;
        }
        if (
          (a === "-o" || a === "+o" || a === "--rcfile" || a === "--init-file") &&
          i + 1 < args.length
        ) {
          i++;
          continue;
        }
        if (a === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
          hasCFlag = true;
          continue;
        }
        if ((a.startsWith("-") || a.startsWith("+")) && a.length > 1) {
          continue;
        }
        scriptIdx = i;
        break;
      }
      if (hasCFlag && scriptIdx !== -1 && scriptIdx < args.length) {
        handledCWrapper = true;
        const rawScript = String(args[scriptIdx]);
        const posArgs = args.slice(scriptIdx + 1).map((a) => String(a));
        const wrapperVars = { ...parsed.envVars };
        for (let i = 0; i < posArgs.length; i++) {
          wrapperVars[String(i)] = posArgs[i];
        }
        wrapperVars["@"] = posArgs.slice(1).join(" ");
        wrapperVars["*"] = posArgs.slice(1).join(" ");
        wrapperVars["#"] = String(Math.max(0, posArgs.length - 1));
        const normalizedScript = rawScript.replace(
          /"(\$(?:[@*]|\{[@*](?::[^}]+)?\}))"/g,
          "$1",
        );
        innerEntries.push({ script: normalizedScript, vars: wrapperVars });
      }
    }
    if (!handledCWrapper && matchesAndroidOrAtcText(effectiveSegment, parsed.envVars)) {
      const nonFlagArgs = args.filter((a) => !a.startsWith("-") && a !== "<<<" && a !== "<<");
      for (const a of args) {
        if (matchesAndroidOrAtcText(a, parsed.envVars)) {
          innerEntries.push({ script: a, vars: { ...parsed.envVars } });
        }
      }
      if (nonFlagArgs.length > 1) {
        innerEntries.push({ script: nonFlagArgs.join(" "), vars: { ...parsed.envVars } });
      }
    }
    if (innerEntries.length > 0) {
      let chosen = { kind: "ignore", parsed };
      const rank = { ignore: 0, read_only: 1, atc: 2, device_action: 3, deny_lifecycle: 4 };
      for (const { script: inner, vars: baseInnerVars } of innerEntries) {
        const innerVars = { ...baseInnerVars };
        for (const subSeg of splitShellSegments(inner)) {
          if (subSeg.trim() === effectiveSegment.trim()) continue;
          const subClass = classifySegment(subSeg, innerVars, depth + 1);
          Object.assign(innerVars, subClass.parsed?.envVars || {});
          if (subClass.parsed?.stripsAndroidSerial) {
            delete innerVars.ANDROID_SERIAL;
            innerVars.__atc_stripped_android_serial = "1";
          } else if (subClass.parsed?.envVars?.ANDROID_SERIAL) {
            delete innerVars.__atc_stripped_android_serial;
          }
          if ((rank[subClass.kind] || 0) > (rank[chosen.kind] || 0)) {
            chosen = subClass;
          } else if (subClass.kind === "device_action" && chosen.kind === "device_action") {
            if (subClass.targetSerial === "<stripped-ANDROID_SERIAL>") {
              chosen = subClass;
            } else if (!chosen.targetSerial && subClass.targetSerial) {
              chosen = subClass;
            } else if (
              chosen.targetSerial &&
              subClass.targetSerial &&
              chosen.targetSerial !== subClass.targetSerial
            ) {
              chosen = {
                ...subClass,
                targetSerial: `${chosen.targetSerial},${subClass.targetSerial}`,
              };
            }
          }
        }
      }
      if (chosen.kind !== "ignore") {
        return chosen;
      }
      if (handledCWrapper) {
        return { kind: "ignore", parsed };
      }
    }
  }

  // Unrecognized wrapper or executable action on a utility around an Android command: peel to nested tool or fail closed
  const execFlagIdx =
    baseCmd === "find"
      ? args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")
      : -1;
  const isExecutablePassive =
    execFlagIdx !== -1 ||
    (baseCmd === "git" &&
      (args.includes("-c") || (args[0] === "bisect" && args[1] === "run"))) ||
    baseCmd === "awk" ||
    baseCmd === "sed";

  if (
    (!PASSIVE_NON_EXEC_COMMANDS.has(baseCmd) || isExecutablePassive) &&
    matchesAndroidOrAtcText(effectiveSegment, parsed.envVars)
  ) {
    const startSearchIdx = execFlagIdx !== -1 ? execFlagIdx + 1 : 0;
    const nestedRelIdx = args.slice(startSearchIdx).findIndex((a) => {
      const b = path.basename(a, path.extname(a)).toLowerCase();
      return (
        ["atc", "emulator", "adb", "android", "gradlew", "gradle"].includes(b) ||
        SHELL_WRAPPERS.has(b) ||
        TRANSPARENT_WRAPPERS.has(b)
      );
    });
    const peelIdx =
      execFlagIdx !== -1 && execFlagIdx + 1 < args.length
        ? execFlagIdx + 1
        : nestedRelIdx !== -1
          ? startSearchIdx + nestedRelIdx
          : -1;
    if (peelIdx !== -1) {
      const cleanedArgs = args
        .slice(peelIdx)
        .filter((a) => a !== ";" && a !== "\\;" && a !== "+");
      if (cleanedArgs.length > 0) {
        const nestedSegment = cleanedArgs
          .map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a))
          .join(" ");
        return classifySegment(nestedSegment, parsed.envVars, depth + 1);
      }
    }
    const embeddedCandidates = extractEmbeddedCommands(args.slice(startSearchIdx));
    if (embeddedCandidates.length > 0) {
      const embeddedSerials = new Set();
      const baseEmbeddedVars = { ...parsed.envVars };
      delete baseEmbeddedVars.ANDROID_SERIAL;
      for (const candidate of embeddedCandidates) {
        const innerVars = { ...baseEmbeddedVars };
        for (const subSeg of splitShellSegments(candidate)) {
          if (subSeg.trim() === effectiveSegment.trim()) continue;
          const subClass = classifySegment(subSeg, innerVars, depth + 1);
          Object.assign(innerVars, subClass.parsed?.envVars || {});
          if (subClass.kind === "deny_lifecycle") {
            return subClass;
          }
          if (subClass.kind === "device_action" && subClass.targetSerial) {
            for (const s of String(subClass.targetSerial).split(",")) {
              if (s) embeddedSerials.add(s);
            }
          }
        }
      }
      if (embeddedSerials.size > 0) {
        return {
          kind: "device_action",
          targetSerial: Array.from(embeddedSerials).join(","),
          parsed,
        };
      }
    }
    return {
      kind: "device_action",
      targetSerial: extractTargetSerial(parsed),
      parsed,
    };
  }

  return { kind: "ignore", parsed };
}

function extractEmbeddedCommands(args) {
  const candidates = [];
  const toolNames = new Set(["atc", "emulator", "adb", "android", "gradlew", "gradle"]);
  for (const rawArg of args) {
    if (!rawArg || !matchesAndroidOrAtcText(rawArg)) continue;
    const arg = String(rawArg).replace(/\\(["'`\\])/g, "$1");
    const literals = [];
    const litRe = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;
    let m;
    while ((m = litRe.exec(arg)) !== null) {
      const lit = m[1] ?? m[2] ?? m[3] ?? "";
      if (lit) literals.push(lit);
    }
    for (const lit of literals) {
      if (matchesAndroidOrAtcText(lit) && /\s/.test(lit.trim())) {
        candidates.push(lit.trim());
      }
    }
    for (let i = 0; i < literals.length; i++) {
      const base = path.basename(literals[i], path.extname(literals[i])).toLowerCase();
      if (toolNames.has(base)) {
        const joined = literals
          .slice(i)
          .map((l) => (/[\s"'\\]/.test(l) ? JSON.stringify(l) : l))
          .join(" ");
        if (joined) candidates.push(joined);
        break;
      }
    }
    const inlineRe = /\b(?:adb|android|emulator|gradlew|gradle|atc)\b[^;)"'`\]\r\n]*/gi;
    let im;
    while ((im = inlineRe.exec(arg)) !== null) {
      const snippet = im[0].trim();
      if (snippet) candidates.push(snippet);
    }
  }
  return candidates;
}

function splitTrailingControlClosers(cmdBody) {
  const openStack = [];
  const matchedCloseIndices = new Set();
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmdBody.length; i++) {
    const ch = cmdBody[i];
    if (ch === "\\" && !inSingle && i + 1 < cmdBody.length) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "(") {
        openStack.push(i);
      } else if (ch === ")" && openStack.length > 0) {
        openStack.pop();
        matchedCloseIndices.add(i);
      }
    }
  }
  let end = cmdBody.length;
  while (end > 0) {
    const slice = cmdBody.slice(0, end);
    const kwMatch = slice.match(/\s+(?:fi|done|esac|\})$/);
    if (kwMatch) {
      end -= kwMatch[0].length;
      continue;
    }
    if (cmdBody[end - 1] === ")" && !matchedCloseIndices.has(end - 1)) {
      end--;
      while (end > 0 && /\s/.test(cmdBody[end - 1])) {
        end--;
      }
      continue;
    }
    break;
  }
  return {
    body: cmdBody.slice(0, end).trim(),
    suffix: cmdBody.slice(end),
  };
}

function rewriteStageCommandSubstitutions(stageText, rewriteOpts) {
  let rewrittenStage = "";
  let maskedStage = "";
  let changed = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < stageText.length; i++) {
    const ch = stageText[i];
    if (ch === "\\" && !inSingle && i + 1 < stageText.length) {
      rewrittenStage += ch + stageText[i + 1];
      maskedStage += ch + stageText[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      rewrittenStage += ch;
      maskedStage += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      rewrittenStage += ch;
      maskedStage += ch;
      continue;
    }
    if (
      !inSingle &&
      (ch === "$" || ch === "<" || ch === ">") &&
      stageText[i + 1] === "(" &&
      stageText[i + 2] !== "("
    ) {
      let depth = 1;
      let j = i + 2;
      let subSingle = false;
      let subDouble = false;
      while (j < stageText.length && depth > 0) {
        const c = stageText[j];
        if (c === "\\" && !subSingle && j + 1 < stageText.length) {
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
        const inner = stageText.slice(i + 2, j - 1);
        const rewrittenInner = rewriteCompoundCommand(inner, rewriteOpts);
        if (rewrittenInner !== inner) {
          changed = true;
          rewrittenStage += `${ch}(${rewrittenInner})`;
          maskedStage += "__atc_cmd_sub__";
        } else {
          const orig = stageText.slice(i, j);
          rewrittenStage += orig;
          maskedStage += orig;
        }
        i = j - 1;
        continue;
      }
    }
    if (!inSingle && ch === "`") {
      let j = i + 1;
      while (j < stageText.length && stageText[j] !== "`") {
        if (stageText[j] === "\\" && j + 1 < stageText.length) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j < stageText.length && stageText[j] === "`") {
        const inner = stageText.slice(i + 1, j);
        const rewrittenInner = rewriteCompoundCommand(inner, rewriteOpts);
        if (rewrittenInner !== inner) {
          changed = true;
          rewrittenStage += `\`${rewrittenInner}\``;
          maskedStage += "__atc_cmd_sub__";
        } else {
          const orig = stageText.slice(i, j + 1);
          rewrittenStage += orig;
          maskedStage += orig;
        }
        i = j;
        continue;
      }
    }
    rewrittenStage += ch;
    maskedStage += ch;
  }

  return { changed, rewrittenStage, maskedStage };
}

function rewriteCompoundCommand(command, { sessionId, anchorPid, execSerial, platform = "win32" }) {
  const rewriteOpts = { sessionId, anchorPid, execSerial, platform };
  const isWin = platform === "win32";
  const sessionFlag = sessionId
    ? anchorPid
      ? ` --session ${sessionId} --anchor-pid ${anchorPid}`
      : ` --session ${sessionId}`
    : "";
  const sessionFlags = sessionFlag.trim();
  const posixEnvPrefix =
    !isWin && sessionId
      ? anchorPid
        ? `ATC_SESSION_ID=${sessionId} ATC_ANCHOR_PID=${anchorPid} `
        : `ATC_SESSION_ID=${sessionId} `
      : "";
  const tokens = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let subParenDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && !inSingle && i + 1 < command.length) {
      cur += ch + command[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (!inSingle) {
      if (ch === "`") {
        inBacktick = !inBacktick;
        cur += ch;
        continue;
      }
      if (!inBacktick) {
        if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
          subParenDepth++;
          cur += ch + "(";
          i++;
          continue;
        }
        if (subParenDepth > 0 && ch === "(") {
          subParenDepth++;
          cur += ch;
          continue;
        }
        if (subParenDepth > 0 && ch === ")") {
          subParenDepth--;
          cur += ch;
          continue;
        }
      }
    }
    if (!inSingle && !inDouble && !inBacktick && subParenDepth === 0) {
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
        tokens.push({ type: "stage", text: cur });
        tokens.push({ type: "sep", text: ` ${ch}${command[i + 1]} ` });
        cur = "";
        i++;
        continue;
      }
      if (ch === ";") {
        tokens.push({ type: "stage", text: cur });
        if (command[i + 1] === ";" && command[i + 2] === "&") {
          tokens.push({ type: "sep", text: " ;;& " });
          i += 2;
        } else if (command[i + 1] === ";") {
          tokens.push({ type: "sep", text: " ;; " });
          i += 1;
        } else if (command[i + 1] === "&") {
          tokens.push({ type: "sep", text: " ;& " });
          i += 1;
        } else {
          tokens.push({ type: "sep", text: " ; " });
        }
        cur = "";
        continue;
      }
      if (ch === "\n") {
        tokens.push({ type: "stage", text: cur });
        tokens.push({ type: "sep", text: "\n" });
        cur = "";
        continue;
      }
      if (ch === "|" && !isCasePatternAlternationPipe(cur, command.slice(i + 1))) {
        tokens.push({ type: "stage", text: cur });
        if (command[i + 1] === "&") {
          tokens.push({ type: "sep", text: " |& " });
          i += 1;
        } else {
          tokens.push({ type: "sep", text: " | " });
        }
        cur = "";
        continue;
      }
      if (
        ch === "&" &&
        command[i + 1] !== ">" &&
        command[i - 1] !== ">" &&
        command[i - 1] !== "<"
      ) {
        tokens.push({ type: "stage", text: cur });
        tokens.push({ type: "sep", text: " & " });
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur) {
    tokens.push({ type: "stage", text: cur });
  }

  const shellVars = {};
  let pipeUpstreamArgs = [];
  let inPipeline = false;
  return tokens
    .map((tok) => {
      if (tok.type !== "stage") {
        const sepTrimmed = tok.text.trim();
        if (sepTrimmed === "|" || sepTrimmed === "|&") {
          inPipeline = true;
        } else {
          pipeUpstreamArgs = [];
          inPipeline = false;
        }
        return tok.text;
      }
      let trimmed = tok.text.trim();
      if (!trimmed) return tok.text;
      const subRewrite = rewriteStageCommandSubstitutions(trimmed, rewriteOpts);
      const stageForClassify = subRewrite.changed ? subRewrite.maskedStage : trimmed;
      const parsedStage = parseSegment(stageForClassify, shellVars);
      let classifyInput = stageForClassify;
      if (inPipeline && pipeUpstreamArgs.length > 0) {
        if (SHELL_WRAPPERS.has(parsedStage.baseCmd)) {
          classifyInput = `${stageForClassify} ${pipeUpstreamArgs.map((a) => JSON.stringify(a)).join(" ")}`;
        } else if (parsedStage.baseCmd === "xargs" || parsedStage.baseCmd === "parallel") {
          classifyInput = `${stageForClassify} ${pipeUpstreamArgs.join(" ")}`;
        }
      }
      const c = classifySegment(classifyInput, shellVars);
      Object.assign(shellVars, c.parsed?.envVars || {});
      const forVarMatch = trimmed.match(/^(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (forVarMatch) {
        shellVars[forVarMatch[1]] = "__atc_cmd_sub__";
      }
      const readVarMatch = trimmed.match(/(?:^|\b)read\s+(?:-[A-Za-z0-9]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (readVarMatch) {
        shellVars[readVarMatch[1]] = "__atc_cmd_sub__";
      }
      for (const arg of parsedStage.args) {
        if (!/^-[A-Za-z0-9]+$/.test(arg) || matchesAndroidOrAtcText(arg, parsedStage.envVars)) {
          pipeUpstreamArgs.push(arg);
        }
      }
      if (subRewrite.changed) {
        trimmed = subRewrite.rewrittenStage;
        if (c.kind !== "device_action" && c.kind !== "atc") {
          return trimmed;
        }
      }
      if (c.kind === "device_action" && execSerial) {
        let prefix = "";
        let cmdBody = trimmed;
        const ctrlMatch = trimmed.match(LEADING_CONTROL_PREFIX_RE);
        if (ctrlMatch) {
          prefix = ctrlMatch[0];
          cmdBody = trimmed.slice(prefix.length).trim();
        }
        const { body: strippedBody, suffix } = splitTrailingControlClosers(cmdBody);
        cmdBody = strippedBody;
        const staticShellVars = Object.fromEntries(
          Object.entries(shellVars).filter(
            ([k, v]) =>
              !k.startsWith("__atc_") &&
              typeof v === "string" &&
              !v.includes("__atc_cmd_sub__") &&
              /^[A-Za-z0-9._:/@=-]+$/.test(v),
          ),
        );
        if (Object.keys(staticShellVars).length > 0 && cmdBody.includes("$")) {
          cmdBody = expandVariables(cmdBody, staticShellVars, { opaqueFallback: null });
        }
        if (isWin) {
          return `${prefix}atc exec${sessionFlag} --serial ${execSerial} -- ${cmdBody}${suffix}`;
        }
        const isSimpleStage =
          !/[<>|&;`()\r\n]/.test(cmdBody) && !requiresShellExecution(cmdBody);
        if (isSimpleStage) {
          return `${prefix}${posixEnvPrefix}atc exec --serial ${execSerial} -- ${cmdBody}${suffix}`;
        }
        const dynamicEnvAssigns = Object.entries(shellVars)
          .filter(
            ([k]) =>
              !k.startsWith("__atc_") &&
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) &&
              !Object.prototype.hasOwnProperty.call(staticShellVars, k) &&
              new RegExp(`\\$(?:\\{${k}[^}]*\\}|${k}\\b)`).test(cmdBody),
          )
          .map(([k]) => `${k}="$${k}" `)
          .join("");
        const escaped = `'${String(cmdBody).replace(/'/g, `'\\''`)}'`;
        return `${prefix}${dynamicEnvAssigns}${posixEnvPrefix}atc exec --serial ${execSerial} -- sh -c ${escaped}${suffix}`;
      }
      if (c.kind === "atc" && sessionFlags) {
        const hasSession =
          Boolean(c.parsed.envVars.ATC_SESSION_ID) ||
          c.parsed.args.some(
            (a) =>
              a === "--session" ||
              a.startsWith("--session=") ||
              a === "--role" ||
              a.startsWith("--role="),
          );
        if (!hasSession) {
          return trimmed.replace(/\batc(\s+[A-Za-z0-9_-]+)/i, `atc$1 ${sessionFlags}`);
        }
      }
      return trimmed;
    })
    .join("");
}

export function evaluateCommandGuard(
  command,
  { sessionId, anchorPid, activeLeases = [], runningCount = 0, platform = process.platform } = {},
) {
  if (!hasAndroidOrAtcTokens(command)) {
    return { allowed: true, fastPath: true, rewrittenCommand: null };
  }

  const segments = splitShellSegments(command);
  let needsAtcRewrite = false;
  let hasDeviceAction = false;
  let hasUnscopedDeviceAction = false;
  const targetSerials = new Set();
  const shellVars = {};

  for (const seg of segments) {
    const c = classifySegment(seg, shellVars);
    Object.assign(shellVars, c.parsed?.envVars || {});
    if (c.parsed?.stripsAndroidSerial) {
      delete shellVars.ANDROID_SERIAL;
      shellVars.__atc_stripped_android_serial = "1";
    } else if (c.parsed?.envVars?.ANDROID_SERIAL) {
      delete shellVars.__atc_stripped_android_serial;
    }
    if (c.kind === "ignore" || c.kind === "read_only") {
      continue;
    }

    if (c.kind === "atc") {
      if (c.execTargetSerial) {
        const ownsExecTarget =
          Array.isArray(activeLeases) && activeLeases.some((l) => l.serial === c.execTargetSerial);
        if (!ownsExecTarget) {
          const ownedSerials =
            Array.isArray(activeLeases) && activeLeases.length > 0
              ? activeLeases.map((l) => l.serial).join(", ")
              : "none";
          return {
            allowed: false,
            reason:
              `Blocked by ATC guardrail: "atc exec" payload targets device "${c.execTargetSerial}", which is not owned by session "${sessionId || "current"}".\n` +
              `  Owned lease serial(s): ${ownedSerials}`,
            rewrittenCommand: null,
          };
        }
        targetSerials.add(c.execTargetSerial);
      }
      const hasSession =
        Boolean(c.parsed.envVars.ATC_SESSION_ID) ||
        c.parsed.args.some(
          (a) =>
            a === "--session" ||
            a.startsWith("--session=") ||
            a === "--role" ||
            a.startsWith("--role="),
        );
      if (!hasSession && sessionId) {
        needsAtcRewrite = true;
      }
      continue;
    }

    if (c.kind === "deny_lifecycle") {
      return {
        allowed: false,
        reason: c.reason,
        rewrittenCommand: null,
      };
    }

    if (c.kind === "device_action") {
      hasDeviceAction = true;
      if (!activeLeases || activeLeases.length === 0) {
        return {
          allowed: false,
          reason:
            `Blocked by ATC guardrail: command "${seg}" interacts with an Android device, but session "${sessionId || "current"}" holds no active device lease.\n` +
            `  1. Claim a device first:  atc claim --type phone --api 36\n` +
            `  2. Run your command via:  atc exec -- ${seg}`,
          rewrittenCommand: null,
        };
      }

      const targetSerial = c.targetSerial;
      if (targetSerial) {
        const ownsTarget = activeLeases.some((l) => l.serial === targetSerial);
        if (!ownsTarget) {
          const ownedSerials = activeLeases.map((l) => l.serial).join(", ");
          return {
            allowed: false,
            reason:
              `Blocked by ATC guardrail: command targets device "${targetSerial}", which is not owned by session "${sessionId}".\n` +
              `  Owned lease serial(s): ${ownedSerials}`,
            rewrittenCommand: null,
          };
        }
        targetSerials.add(targetSerial);
      } else if (activeLeases.length > 1 || runningCount > 1) {
        const primarySerial = activeLeases[0].serial;
        return {
          allowed: false,
          reason:
            `Blocked by ATC guardrail: multiple devices are connected or leased, and "${seg}" does not specify ANDROID_SERIAL or --device.\n` +
            `  Wrap with: atc exec -- ${seg}\n` +
            `  Or specify: ANDROID_SERIAL=${primarySerial} ${seg}`,
          rewrittenCommand: null,
        };
      } else {
        hasUnscopedDeviceAction = true;
      }
    }
  }

  let rewrittenCommand = null;
  const serialList = hasUnscopedDeviceAction ? null : Array.from(targetSerials);
  const isWin = platform === "win32";

  if (hasDeviceAction && activeLeases.length > 0) {
    if (targetSerials.size > 1) {
      return {
        allowed: false,
        reason:
          'Blocked by ATC guardrail: command targets multiple devices in one invocation; run each device command via "atc exec --serial <serial> -- <command>".',
        rewrittenCommand: null,
      };
    }
    const execSerial =
      serialList && serialList.length === 1 ? serialList[0] : activeLeases[0].serial;
    const isSimpleSingleCommand =
      segments.length === 1 &&
      !needsAtcRewrite &&
      !/[<>|&;`()\r\n]/.test(command) &&
      !requiresShellExecution(command);
    if (isWin) {
      rewrittenCommand = rewriteCompoundCommand(command, {
        sessionId,
        anchorPid,
        execSerial,
        platform: "win32",
      });
    } else {
      const envPrefix = sessionId
        ? anchorPid
          ? `ATC_SESSION_ID=${sessionId} ATC_ANCHOR_PID=${anchorPid} `
          : `ATC_SESSION_ID=${sessionId} `
        : "";
      if (isSimpleSingleCommand) {
        rewrittenCommand = `${envPrefix}atc exec --serial ${execSerial} -- ${command}`;
      } else if (segments.length > 1) {
        rewrittenCommand = rewriteCompoundCommand(command, {
          sessionId,
          anchorPid,
          execSerial,
          platform,
        });
      } else {
        const escaped = `'${String(command).replace(/'/g, `'\\''`)}'`;
        rewrittenCommand = `${envPrefix}atc exec --serial ${execSerial} -- sh -c ${escaped}`;
      }
    }
  } else if (needsAtcRewrite && sessionId) {
    if (isWin) {
      rewrittenCommand = rewriteCompoundCommand(command, {
        sessionId,
        anchorPid,
        execSerial: null,
        platform: "win32",
      });
    } else if (segments.length > 1) {
      const exportVars = anchorPid
        ? `export ATC_SESSION_ID=${sessionId} ATC_ANCHOR_PID=${anchorPid}; `
        : `export ATC_SESSION_ID=${sessionId}; `;
      rewrittenCommand = exportVars + command;
    } else {
      const prefix = anchorPid
        ? `ATC_SESSION_ID=${sessionId} ATC_ANCHOR_PID=${anchorPid} `
        : `ATC_SESSION_ID=${sessionId} `;
      rewrittenCommand = prefix + command;
    }
  }

  return {
    allowed: true,
    fastPath: false,
    rewrittenCommand,
    hasDirectDeviceAction: hasDeviceAction,
    renewLease: hasDeviceAction && activeLeases.length > 0,
    targetSerial: serialList && serialList.length === 1 ? serialList[0] : null,
    targetSerials: serialList,
  };
}
