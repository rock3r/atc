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
  "for",
  "select",
  "read",
  "case",
  "[",
  "[[",
  "test",
  "sleep",
  "set",
  "shift",
  "break",
  "continue",
  "return",
  "exit",
  ":",
  "export",
  "unset",
  "local",
  "declare",
  "typeset",
  "readonly",
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

function isExtglobOpen(str, i, curStage = "") {
  const ch = str[i];
  if (str[i + 1] !== "(") return false;
  if (ch !== "@" && ch !== "*" && ch !== "+" && ch !== "?" && ch !== "!") {
    return false;
  }
  const strippedCur =
    ch === "!"
      ? String(curStage || "")
          .replace(LEADING_CONTROL_PREFIX_RE, "")
          .trim()
      : "";
  const inCaseHeader =
    ch === "!"
      ? /(?:^|\s)case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in(?:\s|$)/.test(
          String(curStage || ""),
        )
      : false;
  let depth = 1;
  let qSingle = false;
  let qDouble = false;
  for (let j = i + 2; j < str.length; j++) {
    const c = str[j];
    if (c === "\\" && !qSingle && j + 1 < str.length) {
      j++;
      continue;
    }
    if (c === "'" && !qDouble) {
      qSingle = !qSingle;
      continue;
    }
    if (c === '"' && !qSingle) {
      qDouble = !qDouble;
      continue;
    }
    if (!qSingle && !qDouble) {
      if (c === ";" || c === "\n") return false;
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          if (ch === "!" && !strippedCur && !inCaseHeader) {
            const isCaseArmPattern =
              /^\s*(?:\|\s*(?:[!?+*@]\([^()]*\)|[^;\n)])*)*\)/.test(
                str.slice(j + 1),
              );
            if (!isCaseArmPattern) return false;
          }
          return true;
        }
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
  let arithDepth = 0;
  let subParenDepth = 0;
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
      if (arithDepth === 0 && ch === "$" && str[i + 1] === "(" && str[i + 2] === "(") {
        arithDepth = 2;
        cur += "$((";
        i += 2;
        continue;
      }
      if (arithDepth === 0 && ch === "(" && str[i + 1] === "(") {
        arithDepth = 2;
        cur += "((";
        i++;
        continue;
      }
      if (arithDepth > 0) {
        if (ch === "(") arithDepth++;
        else if (ch === ")") arithDepth--;
        cur += ch;
        continue;
      }
      if (
        ((ch === "$" || ch === "<" || ch === ">") && str[i + 1] === "(") ||
        isExtglobOpen(str, i, cur)
      ) {
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
    if (!inSingle && !inDouble && arithDepth === 0 && subParenDepth === 0) {
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
      } else if (str[end] === "(" && str[end + 1] === "(") {
        let aDepth = 1;
        end += 2;
        while (end < str.length && aDepth > 0) {
          if (str[end] === "(" && str[end + 1] === "(") {
            aDepth++;
            end += 2;
          } else if (str[end] === ")" && str[end + 1] === ")") {
            aDepth--;
            end += 2;
          } else {
            end++;
          }
        }
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
    if (tok === "local" || tok === "declare" || tok === "typeset" || tok === "readonly") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        const flag = tokens[idx++];
        if (flag === "--") break;
      }
      while (
        idx < tokens.length &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[idx]) &&
        !tokens[idx].includes("=")
      ) {
        idx++;
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
      const expandedVal = rawVal.includes("$((")
        ? "__atc_cmd_sub__"
        : expandVariables(rawVal, { ...baseVars, ...envVars });
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

  if (
    !baseCmd ||
    baseCmd.startsWith("((") ||
    (baseCmd === "command" && (args[0] === "-v" || args[0] === "-V"))
  ) {
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

function extractStageLoopVariables(stageText) {
  let s = String(stageText || "").trim();
  if (!s) return [];
  while (true) {
    const m = s.match(LEADING_CONTROL_PREFIX_RE);
    if (!m) break;
    s = s.slice(m[0].length).trimStart();
  }
  s = splitTrailingControlClosers(s).body;
  if (!s) return [];

  const vars = new Set();
  const forVarMatch = s.match(/^(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (forVarMatch) {
    vars.add(forVarMatch[1]);
  }

  const arithRe = /\(\(([\s\S]*?)\)\)/g;
  let am;
  while ((am = arithRe.exec(s)) !== null) {
    const expr = am[1];
    const postRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|(?:<<|>>|[+\-*/%&|^])?=(?!=))/g;
    let pm;
    while ((pm = postRe.exec(expr)) !== null) {
      vars.add(pm[1]);
    }
    const preRe = /(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
    while ((pm = preRe.exec(expr)) !== null) {
      vars.add(pm[1]);
    }
  }

  const tokens = tokenizeSegment(s, { preserveLiteralDollar: true });
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    const eq = tok.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) {
      idx++;
      continue;
    }
    if (tok === "builtin" || tok === "command") {
      idx++;
      while (idx < tokens.length && (tokens[idx] === "-p" || tokens[idx] === "--")) {
        idx++;
      }
      continue;
    }
    break;
  }

  if (idx < tokens.length && tokens[idx] === "read") {
    idx++;
    let optionsEnded = false;
    const readVars = [];
    while (idx < tokens.length) {
      const tok = tokens[idx++];
      if (
        tok === "<" ||
        tok === "<<" ||
        tok === "<<<" ||
        tok === ">" ||
        tok === ">>" ||
        tok === "<&" ||
        tok === ">&" ||
        tok === "<>" ||
        tok === "&>" ||
        tok === "&>>"
      ) {
        if (idx < tokens.length) idx++;
        continue;
      }
      if (/^[0-9]*[<>]/.test(tok) || tok.startsWith("&>") || tok.startsWith("&>>")) {
        continue;
      }
      if (!optionsEnded && tok === "--") {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && tok.startsWith("-") && tok.length > 1) {
        if (/^-[rsuAeE]*[aA]$/.test(tok)) {
          if (idx < tokens.length) {
            const arrVar = tokens[idx++].replace(/^['"]|['"]$/g, "").replace(/\[.*$/, "");
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arrVar)) {
              readVars.push(arrVar);
            }
          }
        } else if (/^-[rsuAeE]*[udnNpti]$/.test(tok)) {
          if (idx < tokens.length) idx++;
        }
        continue;
      }
      optionsEnded = true;
      const cleaned = tok.replace(/^['"]|['"]$/g, "").replace(/\[.*$/, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
        readVars.push(cleaned);
      }
    }
    if (readVars.length === 0) {
      vars.add("REPLY");
    } else {
      for (const rv of readVars) {
        vars.add(rv);
      }
    }
  } else if (
    idx < tokens.length &&
    (tokens[idx] === "mapfile" || tokens[idx] === "readarray")
  ) {
    idx++;
    let optionsEnded = false;
    const mapfileVars = [];
    while (idx < tokens.length) {
      const tok = tokens[idx++];
      if (
        tok === "<" ||
        tok === "<<" ||
        tok === "<<<" ||
        tok === ">" ||
        tok === ">>" ||
        tok === "<&" ||
        tok === ">&" ||
        tok === "<>" ||
        tok === "&>" ||
        tok === "&>>"
      ) {
        if (idx < tokens.length) idx++;
        continue;
      }
      if (/^[0-9]*[<>]/.test(tok) || tok.startsWith("&>") || tok.startsWith("&>>")) {
        continue;
      }
      if (!optionsEnded && tok === "--") {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && tok.startsWith("-") && tok.length > 1) {
        if (/^-t*[dnOsuCc]$/.test(tok)) {
          if (idx < tokens.length) idx++;
        }
        continue;
      }
      optionsEnded = true;
      const cleaned = tok.replace(/^['"]|['"]$/g, "").replace(/\[.*$/, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
        mapfileVars.push(cleaned);
      }
    }
    if (mapfileVars.length === 0) {
      vars.add("MAPFILE");
    } else {
      for (const mv of mapfileVars) {
        vars.add(mv);
      }
    }
  } else if (idx < tokens.length && tokens[idx] === "printf") {
    idx++;
    while (idx < tokens.length) {
      const tok = tokens[idx++];
      if (
        tok === "<" ||
        tok === "<<" ||
        tok === "<<<" ||
        tok === ">" ||
        tok === ">>" ||
        tok === "<&" ||
        tok === ">&" ||
        tok === "<>" ||
        tok === "&>" ||
        tok === "&>>"
      ) {
        if (idx < tokens.length) idx++;
        continue;
      }
      if (/^[0-9]*[<>]/.test(tok) || tok.startsWith("&>") || tok.startsWith("&>>")) {
        continue;
      }
      if (tok === "--") {
        break;
      }
      if (tok === "-v") {
        if (idx < tokens.length) {
          const dest = tokens[idx++].replace(/^['"]|['"]$/g, "").replace(/\[.*$/, "");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(dest)) {
            vars.add(dest);
          }
        }
        continue;
      }
      if (tok.startsWith("-v") && tok.length > 2) {
        const dest = tok.slice(2).replace(/^['"]|['"]$/g, "").replace(/\[.*$/, "");
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(dest)) {
          vars.add(dest);
        }
        continue;
      }
      break;
    }
  } else if (idx < tokens.length && tokens[idx] === "let") {
    idx++;
    while (idx < tokens.length) {
      const expr = tokens[idx++].replace(/^['"]|['"]$/g, "");
      const postRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--|(?:<<|>>|[+\-*/%&|^])?=(?!=))/g;
      let pm;
      while ((pm = postRe.exec(expr)) !== null) {
        vars.add(pm[1]);
      }
      const preRe = /(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
      while ((pm = preRe.exec(expr)) !== null) {
        vars.add(pm[1]);
      }
    }
  } else if (idx < tokens.length && tokens[idx] === "getopts") {
    idx++;
    vars.add("OPTARG");
    vars.add("OPTIND");
    let optionsEnded = false;
    const positional = [];
    while (idx < tokens.length) {
      const tok = tokens[idx++];
      if (
        tok === "<" ||
        tok === "<<" ||
        tok === "<<<" ||
        tok === ">" ||
        tok === ">>" ||
        tok === "<&" ||
        tok === ">&" ||
        tok === "<>" ||
        tok === "&>" ||
        tok === "&>>"
      ) {
        if (idx < tokens.length) idx++;
        continue;
      }
      if (/^[0-9]*[<>]/.test(tok) || tok.startsWith("&>") || tok.startsWith("&>>")) {
        continue;
      }
      if (!optionsEnded && tok === "--") {
        optionsEnded = true;
        continue;
      }
      optionsEnded = true;
      positional.push(tok);
    }
    if (positional.length >= 2) {
      const dest = positional[1].replace(/^['"]|['"]$/g, "").replace(/\[.*$/, "");
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(dest)) {
        vars.add(dest);
      }
    }
  }

  for (const tok of tokens) {
    const arrOrAppendMatch =
      tok.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\]\+?|\+)=/) ||
      tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=\(/);
    if (arrOrAppendMatch) {
      vars.add(arrOrAppendMatch[1]);
    }
  }

  return Array.from(vars);
}

const BASH_SPECIAL_VAR_RE =
  /^(?:RANDOM|SRANDOM|SECONDS|EPOCHSECONDS|EPOCHREALTIME|LINENO|BASH|BASHOPTS|BASHPID|BASH_[A-Z0-9_]+|UID|EUID|GROUPS|HOSTNAME|HOSTTYPE|OSTYPE|MACHTYPE|SHELLOPTS|SHLVL|PPID|DIRSTACK|FUNCNAME|HISTCMD|MAPFILE|PIPESTATUS|COMP_[A-Z0-9_]+)$/;

const BASH_CALLER_SNAPSHOT_VARS = new Set([
  "PIPESTATUS",
  "FUNCNAME",
  "BASH_SOURCE",
  "BASH_LINENO",
  "BASH_ARGV",
  "BASH_ARGC",
  "BASH_REMATCH",
  "MAPFILE",
  "DIRSTACK",
  "COMP_WORDS",
  "COMP_CWORD",
  "COMP_LINE",
  "COMP_POINT",
  "COMP_TYPE",
  "COMP_KEY",
  "COMP_WORDBREAKS",
  "PPID",
  "BASHOPTS",
  "SHELLOPTS",
  "BASH_COMMAND",
  "BASH_EXECUTION_STRING",
]);

const BASH_DYNAMIC_SPECIAL_VARS = new Set([
  "RANDOM",
  "SRANDOM",
  "SECONDS",
  "LINENO",
  "EPOCHSECONDS",
  "EPOCHREALTIME",
  "BASHPID",
  "BASH_SUBSHELL",
  "SHLVL",
  "HISTCMD",
  "GLOBIGNORE",
  ...BASH_CALLER_SNAPSHOT_VARS,
]);

function extractReferencedBashSpecialVars(cmdBody) {
  const s = String(cmdBody || "");
  const vars = new Set();
  const counts = new Map();
  const assigned = new Set();
  const recordRef = (name) => {
    if (BASH_SPECIAL_VAR_RE.test(name)) {
      vars.add(name);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  };
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (inSingle) continue;
    if (!inDouble && (i === 0 || /[\s;(]/.test(s[i - 1]))) {
      const assignMatch = s.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)\+?=/);
      if (assignMatch && BASH_SPECIAL_VAR_RE.test(assignMatch[1])) {
        assigned.add(assignMatch[1]);
      }
    }
    const isDollarArith = ch === "$" && s[i + 1] === "(" && s[i + 2] === "(";
    const isBareArith = !inDouble && ch === "(" && s[i + 1] === "(";
    const isBracketArith = ch === "$" && s[i + 1] === "[";
    if (isDollarArith || isBareArith || isBracketArith) {
      const openLen = isDollarArith ? 3 : 2;
      let depth = isBracketArith ? 1 : 2;
      let j = i + openLen;
      for (; j < s.length; j++) {
        if (isBracketArith) {
          if (s[j] === "[") depth++;
          else if (s[j] === "]" && --depth === 0) break;
        } else {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) break;
        }
      }
      if (j < s.length) {
        const arithInner = s.slice(i + openLen, isBracketArith ? j : j - 1);
        for (const m of arithInner.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
          recordRef(m[1]);
        }
        i = j;
        continue;
      }
    }
    if (ch === "$") {
      const next = s[i + 1] || "";
      if (/^[A-Za-z_]$/.test(next)) {
        const idMatch = s.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (idMatch) {
          recordRef(idMatch[1]);
          i += idMatch[1].length;
          continue;
        }
      }
      if (next === "{") {
        let j = i + 2;
        let depth = 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "\\" && j + 1 < s.length) {
            j += 2;
            continue;
          }
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        if (depth === 0) {
          const inner = s.slice(i + 2, j - 1);
          const varMatch = inner.match(/^[#!]*([A-Za-z_][A-Za-z0-9_]*)/);
          if (varMatch) {
            recordRef(varMatch[1]);
          }
          i = j - 1;
          continue;
        }
      }
    }
  }
  return { vars, counts, assigned };
}

function stageRequiresBashShell(cmdBody) {
  if (extractReferencedBashSpecialVars(cmdBody).vars.size > 0) {
    return true;
  }
  const s = String(cmdBody || "");
  let inSingle = false;
  let inDouble = false;
  let arithDepth = 0;
  const subStack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (!inSingle && ch === "$" && s[i + 1] === "[") {
      return true;
    }
    if (!inSingle && !inDouble && arithDepth === 0 && ch === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
      arithDepth = 2;
      i += 2;
      continue;
    }
    if (!inSingle && ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      subStack.push(inDouble);
      inDouble = false;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && arithDepth > 0) {
      if (ch === "(") {
        arithDepth++;
        continue;
      }
      if (ch === ")") {
        arithDepth--;
        continue;
      }
    }
    if (!inSingle && !inDouble && subStack.length > 0) {
      if (ch === "(") {
        subStack.push(null);
        continue;
      }
      if (ch === ")") {
        const popped = subStack.pop();
        if (typeof popped === "boolean") {
          inDouble = popped;
        }
        continue;
      }
    }
    if (inSingle) continue;
    if (!inDouble && ch === "$" && (s[i + 1] === "'" || s[i + 1] === '"')) {
      return true;
    }
    if (ch === "$" && s[i + 1] === "{") {
      let j = i + 2;
      let depth = 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      if (depth === 0) {
        const inner = s.slice(i + 2, j - 1);
        if (
          inner.startsWith("!") ||
          /\[[^\]]+\]/.test(inner) ||
          /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])(?:\/|\^|,|@[A-Za-z]|:(?![-=?+]))/.test(
            inner,
          )
        ) {
          return true;
        }
      }
    }
    if (!inDouble) {
      if ((ch === "<" || ch === ">") && s[i + 1] === "(") {
        return true;
      }
      if (arithDepth === 0 && isExtglobOpen(s, i, s.slice(0, i))) {
        return true;
      }
      if (ch === "<" && s[i + 1] === "<" && s[i + 2] === "<") {
        return true;
      }
      if (ch === "&" && s[i + 1] === ">") {
        return true;
      }
      if (
        ch === "[" &&
        s[i + 1] === "[" &&
        (i === 0 || /[\s;(|&]/.test(s[i - 1])) &&
        /\s/.test(s[i + 2] || "")
      ) {
        return true;
      }
      if (
        ch === "(" &&
        s[i + 1] === "(" &&
        (i === 0 || /[\s;(|&!]/.test(s[i - 1]))
      ) {
        return true;
      }
      if (ch === "{" && (i === 0 || s[i - 1] !== "$")) {
        let j = i + 1;
        let hasComma = false;
        let hasDotDot = false;
        let validBrace = j < s.length;
        while (j < s.length && s[j] !== "}") {
          if (/\s|['"`$(){};&|<>]/.test(s[j])) {
            validBrace = false;
            break;
          }
          if (s[j] === ",") hasComma = true;
          if (s[j] === "." && s[j + 1] === ".") hasDotDot = true;
          j++;
        }
        if (validBrace && j < s.length && s[j] === "}" && (hasComma || hasDotDot)) {
          return true;
        }
      }
    }
  }
  return false;
}

function stageUsesExtglob(cmdBody) {
  const s = String(cmdBody || "");
  let inSingle = false;
  let inDouble = false;
  let arithDepth = 0;
  let bracketArithDepth = 0;
  const subStack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
      if (ch === "$" && s[i + 1] === "[") {
        bracketArithDepth++;
        i++;
        continue;
      }
      if (bracketArithDepth > 0) {
        if (ch === "[") bracketArithDepth++;
        else if (ch === "]") bracketArithDepth--;
        continue;
      }
      if (arithDepth === 0 && ch === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
        arithDepth = 2;
        i += 2;
        continue;
      }
      if (arithDepth === 0 && ch === "(" && s[i + 1] === "(") {
        arithDepth = 2;
        i++;
        continue;
      }
      if (arithDepth > 0) {
        if (ch === "(") arithDepth++;
        else if (ch === ")") arithDepth--;
        continue;
      }
    }
    if (!inSingle && ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      subStack.push(inDouble);
      inDouble = false;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && subStack.length > 0) {
      if (ch === "(") {
        subStack.push(null);
        continue;
      }
      if (ch === ")") {
        const popped = subStack.pop();
        if (typeof popped === "boolean") {
          inDouble = popped;
        }
        continue;
      }
    }
    if (!inSingle && !inDouble && isExtglobOpen(s, i, s.slice(0, i))) {
      return true;
    }
  }
  return false;
}

function stageReferencesZeroParam(cmdBody) {
  const s = String(cmdBody || "");
  let inSingle = false;
  let inDouble = false;
  const subStack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (!inSingle && ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      subStack.push(inDouble);
      inDouble = false;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && subStack.length > 0) {
      if (ch === "(") {
        subStack.push(null);
        continue;
      }
      if (ch === ")") {
        const popped = subStack.pop();
        if (typeof popped === "boolean") {
          inDouble = popped;
        }
        continue;
      }
    }
    if (inSingle) continue;
    if (ch === "$") {
      const next = s[i + 1] || "";
      if (next === "0") {
        return true;
      }
      if (next === "{") {
        let j = i + 2;
        let depth = 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "\\" && j + 1 < s.length) {
            j += 2;
            continue;
          }
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        if (depth === 0) {
          const inner = s.slice(i + 2, j - 1);
          if (/^[#!]*0+(?:$|[^A-Za-z0-9_\[])/.test(inner)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function stageReferencesPositionalParams(cmdBody) {
  const s = String(cmdBody || "");
  let inSingle = false;
  let inDouble = false;
  const subStack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (!inSingle && ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      subStack.push(inDouble);
      inDouble = false;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && subStack.length > 0) {
      if (ch === "(") {
        subStack.push(null);
        continue;
      }
      if (ch === ")") {
        const popped = subStack.pop();
        if (typeof popped === "boolean") {
          inDouble = popped;
        }
        continue;
      }
    }
    if (inSingle) continue;
    if (ch === "$") {
      const next = s[i + 1] || "";
      if (/^[1-9@*#]$/.test(next)) {
        return true;
      }
      if (next === "{") {
        let j = i + 2;
        let depth = 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "\\" && j + 1 < s.length) {
            j += 2;
            continue;
          }
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        if (depth === 0) {
          const inner = s.slice(i + 2, j - 1);
          if (
            /^[#!]*[@*#]$|^[#!]*0*[1-9][0-9]*(?:$|[^A-Za-z0-9_\[])|^[#!]+[@*](?:$|[^A-Za-z0-9_\[])|^[@*](?:$|[^A-Za-z0-9_\[])/.test(
              inner,
            )
          ) {
            return true;
          }
        }
      }
    }
    if (
      !inDouble &&
      (i === 0 || /[\s;(]/.test(s[i - 1])) &&
      s.slice(i, i + 5) === "shift" &&
      (i + 5 === s.length || /[\s;)]/.test(s[i + 5]))
    ) {
      return true;
    }
  }
  return false;
}

function stageReferencesExitStatus(cmdBody) {
  const s = String(cmdBody || "");
  let inSingle = false;
  let inDouble = false;
  const subStack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (!inSingle && ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      subStack.push(inDouble);
      inDouble = false;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && subStack.length > 0) {
      if (ch === "(") {
        subStack.push(null);
        continue;
      }
      if (ch === ")") {
        const popped = subStack.pop();
        if (typeof popped === "boolean") {
          inDouble = popped;
        }
        continue;
      }
    }
    if (inSingle) continue;
    if (ch === "$") {
      const next = s[i + 1] || "";
      if (next === "?") {
        return true;
      }
      if (next === "{") {
        let j = i + 2;
        let depth = 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "\\" && j + 1 < s.length) {
            j += 2;
            continue;
          }
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        if (depth === 0) {
          const inner = s.slice(i + 2, j - 1);
          if (/^[#!]*\?(?:$|[^A-Za-z0-9_\[])/.test(inner)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function stageContainsUnquotedGlob(
  cmdBody,
  { includeCommandSub = true, includeVarExpansion = true } = {},
) {
  const s = String(cmdBody || "");
  let inSingle = false;
  let inDouble = false;
  let arithDepth = 0;
  let bracketArithDepth = 0;
  let inDoubleBracket = false;
  const subStack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (inSingle) continue;
    if (!inDouble) {
      if (ch === "$" && s[i + 1] === "[") {
        bracketArithDepth++;
        i++;
        continue;
      }
      if (bracketArithDepth > 0) {
        if (ch === "[") bracketArithDepth++;
        else if (ch === "]") bracketArithDepth--;
        continue;
      }
      if (arithDepth === 0 && ch === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
        arithDepth = 2;
        i += 2;
        continue;
      }
      if (arithDepth === 0 && ch === "(" && s[i + 1] === "(") {
        arithDepth = 2;
        i++;
        continue;
      }
      if (arithDepth > 0) {
        if (ch === "(") arithDepth++;
        else if (ch === ")") arithDepth--;
        continue;
      }
      if (
        !inDoubleBracket &&
        ch === "[" &&
        s[i + 1] === "[" &&
        (i === 0 || /[\s;(|&!]/.test(s[i - 1])) &&
        /\s/.test(s[i + 2] || "")
      ) {
        inDoubleBracket = true;
        i++;
        continue;
      }
      if (
        inDoubleBracket &&
        ch === "]" &&
        s[i + 1] === "]" &&
        /\s/.test(s[i - 1] || "") &&
        (i + 2 >= s.length || /[\s;)|&]/.test(s[i + 2]))
      ) {
        inDoubleBracket = false;
        i++;
        continue;
      }
    }
    if (ch === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
      if (!inDouble && !inDoubleBracket && includeCommandSub) {
        return true;
      }
      subStack.push(inDouble);
      inDouble = false;
      i++;
      continue;
    }
    if (!inDouble && ch === "`" && !inDoubleBracket && includeCommandSub) {
      return true;
    }
    if (!inDouble && subStack.length > 0) {
      if (ch === "(") {
        subStack.push(null);
        continue;
      }
      if (ch === ")") {
        const popped = subStack.pop();
        if (typeof popped === "boolean") {
          inDouble = popped;
        }
        continue;
      }
    }
    if (ch === "$" && s[i + 1] === "{") {
      let j = i + 2;
      let depth = 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      if (depth === 0) {
        const inner = s.slice(i + 2, j - 1);
        if (includeVarExpansion && !inDouble && !inDoubleBracket && !inner.startsWith("#")) {
          return true;
        }
        i = j - 1;
        continue;
      }
    }
    if (includeVarExpansion && !inDouble && !inDoubleBracket && ch === "$") {
      const next = s[i + 1] || "";
      if (/[A-Za-z0-9_@*\-!]/.test(next)) {
        return true;
      }
    }
    if (!inDouble && !inDoubleBracket) {
      if (ch === "*" || ch === "?") {
        return true;
      }
      if (ch === "[" && s[i + 1] && !/\s/.test(s[i + 1])) {
        let k = i + 1;
        if (s[k] === "!" || s[k] === "^") k++;
        if (s[k] === "]") k++;
        while (k < s.length && !/[\s;|&<>()]/.test(s[k])) {
          if (s[k] === "\\" && k + 1 < s.length) {
            k += 2;
            continue;
          }
          if (s[k] === "]") {
            return true;
          }
          k++;
        }
      }
    }
  }
  return false;
}

function stageContainsUnboundVarOrParam(
  cmdBody,
  dynamicVarNames = new Set(),
  staticShellVars = {},
) {
  const s = String(cmdBody || "");
  const isKnownBound = (name) =>
    name.startsWith("__atc_") ||
    dynamicVarNames.has(name) ||
    Object.prototype.hasOwnProperty.call(staticShellVars, name);
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !inSingle && i + 1 < s.length) {
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
    if (inSingle) continue;
    if (
      !inDouble &&
      (i === 0 || /[\s;(]/.test(s[i - 1])) &&
      /^(?:unset|shift)(?=$|[\s;)])/.test(s.slice(i))
    ) {
      return true;
    }
    const isDollarArith = ch === "$" && s[i + 1] === "(" && s[i + 2] === "(";
    const isBareArith = !inDouble && ch === "(" && s[i + 1] === "(";
    const isBracketArith = ch === "$" && s[i + 1] === "[";
    if (isDollarArith || isBareArith || isBracketArith) {
      const openLen = isDollarArith ? 3 : 2;
      let depth = isBracketArith ? 1 : 2;
      let j = i + openLen;
      for (; j < s.length; j++) {
        if (isBracketArith) {
          if (s[j] === "[") depth++;
          else if (s[j] === "]" && --depth === 0) break;
        } else {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) break;
        }
      }
      if (j < s.length) {
        const arithInner = s.slice(i + openLen, isBracketArith ? j : j - 1);
        for (const m of arithInner.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
          if (!isKnownBound(m[1])) {
            return true;
          }
        }
        i = j;
        continue;
      }
    }
    if (ch === "$") {
      const next = s[i + 1] || "";
      if (/^[1-9]$/.test(next)) {
        return true;
      }
      if (/^[A-Za-z_]$/.test(next)) {
        const idMatch = s.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
        if (idMatch && !isKnownBound(idMatch[1])) {
          return true;
        }
        if (idMatch) {
          i += idMatch[1].length;
          continue;
        }
      }
      if (next === "{") {
        let j = i + 2;
        let depth = 1;
        while (j < s.length && depth > 0) {
          if (s[j] === "\\" && j + 1 < s.length) {
            j += 2;
            continue;
          }
          if (s[j] === "{") depth++;
          else if (s[j] === "}") depth--;
          j++;
        }
        if (depth === 0) {
          const inner = s.slice(i + 2, j - 1);
          if (inner.startsWith("!")) {
            if (!/^![A-Za-z_][A-Za-z0-9_]*(?:[@*]|\[\*\]|\[@\])$/.test(inner)) {
              return true;
            }
          } else if (/^#([A-Za-z_][A-Za-z0-9_]*)$/.test(inner)) {
            const varName = inner.slice(1);
            if (!isKnownBound(varName)) {
              return true;
            }
          } else if (/^0*[1-9]\d*(?:$|[^-+=])/.test(inner)) {
            return true;
          } else {
            const varMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]+)\])?(.*)$/s);
            if (varMatch) {
              const [, varName, subscript, rest] = varMatch;
              if (subscript !== undefined && !varName.startsWith("__atc_arr_at_")) {
                return true;
              }
              if (!isKnownBound(varName) && !/^:?[-+=]/.test(rest)) {
                return true;
              }
              if (
                rest &&
                stageContainsUnboundVarOrParam(rest, dynamicVarNames, staticShellVars)
              ) {
                return true;
              }
            }
          }
          i = j - 1;
          continue;
        }
      }
    }
  }
  return false;
}

function extractStageShellFlagsUpdate(stageText) {
  let body = String(stageText || "").trim();
  if (!body) return { noglob: null, nounset: null, globShopt: false, unsetVars: [] };
  while (/^[({]/.test(body)) {
    body = body.slice(1).trim();
  }
  const ctrlMatch = body.match(LEADING_CONTROL_PREFIX_RE);
  if (ctrlMatch) {
    body = body.slice(ctrlMatch[0].length).trim();
  }
  body = splitTrailingControlClosers(body).body.trim();
  if (!body) return { noglob: null, nounset: null, globShopt: false, unsetVars: [] };
  const parsed = parseSegment(body);
  const effectiveCmd =
    parsed.baseCmd === "builtin" ? String(parsed.args?.[0] || "") : parsed.baseCmd;
  const effectiveArgs =
    parsed.baseCmd === "builtin" ? (parsed.args || []).slice(1) : parsed.args || [];
  let noglob = null;
  let nounset = null;
  let globShopt = false;
  const unsetVars = [];
  if (effectiveCmd === "set") {
    const args = effectiveArgs;
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]);
      if (arg === "--" || arg === "-") break;
      if (arg === "-o" || arg === "+o") {
        const optName = String(args[i + 1] || "");
        i++;
        if (optName === "noglob") {
          noglob = arg === "-o";
        } else if (optName === "nounset") {
          nounset = arg === "-o";
        }
        continue;
      }
      if (/^-[A-Za-z]+$/.test(arg)) {
        if (arg.includes("f")) {
          noglob = true;
        }
        if (arg.includes("u")) {
          nounset = true;
        }
        if (arg.endsWith("o") && i + 1 < args.length) {
          const optName = String(args[++i]);
          if (optName === "noglob") {
            noglob = true;
          } else if (optName === "nounset") {
            nounset = true;
          }
        }
        continue;
      }
      if (/^\+[A-Za-z]+$/.test(arg)) {
        if (arg.includes("f")) {
          noglob = false;
        }
        if (arg.includes("u")) {
          nounset = false;
        }
        if (arg.endsWith("o") && i + 1 < args.length) {
          const optName = String(args[++i]);
          if (optName === "noglob") {
            noglob = false;
          } else if (optName === "nounset") {
            nounset = false;
          }
        }
        continue;
      }
      break;
    }
  } else if (effectiveCmd === "shopt") {
    const args = effectiveArgs.map(String);
    if (args.some((a) => /^-[A-Za-z]*o/.test(a))) {
      const enable = args.some((a) => /^-[A-Za-z]*s/.test(a))
        ? true
        : args.some((a) => /^-[A-Za-z]*u/.test(a))
          ? false
          : null;
      if (enable !== null) {
        if (args.includes("noglob")) noglob = enable;
        if (args.includes("nounset")) nounset = enable;
      }
    } else if (
      args.some((a) => /^-[A-Za-z]*[su]/.test(a)) &&
      args.some((a) =>
        [
          "nullglob",
          "failglob",
          "dotglob",
          "nocaseglob",
          "extglob",
          "globstar",
          "globasciiranges",
        ].includes(a),
      )
    ) {
      globShopt = true;
    }
  } else if (effectiveCmd === "unset") {
    const args = effectiveArgs.map(String);
    if (!args.includes("-f")) {
      for (const a of args) {
        if (!a.startsWith("-") && a !== "ANDROID_SERIAL" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
          unsetVars.push(a);
          nounset = true;
          if (a === "GLOBIGNORE") {
            globShopt = true;
          }
        }
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(parsed.envVars || {}, "GLOBIGNORE")) {
    globShopt = true;
  }
  return { noglob, nounset, globShopt, unsetVars };
}

function rewriteCompoundCommand(
  command,
  {
    sessionId,
    anchorPid,
    execSerial,
    platform = "win32",
    inheritedShellVars = null,
    inheritedLoopDepth = 0,
  },
) {
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
  let arithDepth = 0;
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
        if (!inDouble && arithDepth === 0 && ch === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
          arithDepth = 2;
          cur += "$((";
          i += 2;
          continue;
        }
        if (!inDouble && arithDepth === 0 && ch === "(" && command[i + 1] === "(") {
          arithDepth = 2;
          cur += "((";
          i++;
          continue;
        }
        if (!inDouble && arithDepth > 0) {
          if (ch === "(") arithDepth++;
          else if (ch === ")") arithDepth--;
          cur += ch;
          continue;
        }
        if (
          ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") ||
          (!inDouble && isExtglobOpen(command, i, cur))
        ) {
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
    if (!inSingle && !inDouble && !inBacktick && subParenDepth === 0 && arithDepth === 0) {
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

  const loopDynamicVars = new Set();
  const maybeUnsetVars = new Set();
  const stageAssignedCounts = new Map();
  let hasNoglobDirective = false;
  let hasNounsetDirective = false;
  let hasGlobShoptDirective = false;
  let scanCondDepth = 0;
  for (const tok of tokens) {
    if (tok.type !== "stage") continue;
    const t = tok.text.trim();
    if (!t) continue;
    if (/(?:^|\s)(?:if|case)\b/.test(t)) {
      scanCondDepth++;
    }
    const flagsUpdate = extractStageShellFlagsUpdate(t);
    if (flagsUpdate.noglob !== null) {
      hasNoglobDirective = true;
    }
    if (flagsUpdate.nounset !== null) {
      hasNounsetDirective = true;
    }
    if (flagsUpdate.globShopt) {
      hasGlobShoptDirective = true;
    }
    for (const uv of flagsUpdate.unsetVars) {
      loopDynamicVars.add(uv);
      maybeUnsetVars.add(uv);
    }
    for (const v of extractStageLoopVariables(t)) {
      loopDynamicVars.add(v);
    }
    const p = parseSegment(t);
    const inCondBranch = scanCondDepth > 0 || /(?:^|\s)(?:if|elif|else|then|case)\b/.test(t);
    for (const [k, v] of Object.entries(p.envVars)) {
      if (k.startsWith("__atc_")) continue;
      stageAssignedCounts.set(k, (stageAssignedCounts.get(k) || 0) + 1);
      if (inCondBranch) {
        loopDynamicVars.add(k);
        maybeUnsetVars.add(k);
      } else if (typeof v === "string" && (v.includes("__atc_cmd_sub__") || v.includes("$"))) {
        loopDynamicVars.add(k);
      }
    }
    const condCloseMatches = t.match(/(?:^|\s)(?:fi|esac)(?=\s|$)/g);
    if (condCloseMatches) {
      scanCondDepth = Math.max(0, scanCondDepth - condCloseMatches.length);
    }
  }
  for (const [k, count] of stageAssignedCounts.entries()) {
    if (count > 1) {
      loopDynamicVars.add(k);
    }
  }

  const shellVars =
    inheritedShellVars && typeof inheritedShellVars === "object"
      ? { ...inheritedShellVars }
      : {};
  if (hasNoglobDirective) {
    shellVars.__atc_noglob_seen = "1";
  }
  if (hasNounsetDirective) {
    shellVars.__atc_nounset_seen = "1";
  }
  if (hasGlobShoptDirective) {
    shellVars.__atc_shopt_glob_seen = "1";
  }
  for (const uv of maybeUnsetVars) {
    shellVars[`__atc_maybe_unset_${uv}`] = "1";
  }
  let pipeUpstreamArgs = [];
  let inPipeline = false;
  let loopDepth = Number.isInteger(inheritedLoopDepth) && inheritedLoopDepth > 0 ? inheritedLoopDepth : 0;
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
      if (/(?:^|\s)(?:for|select|while|until)\b/.test(trimmed)) {
        loopDepth++;
      }
      const flagsUpdate = extractStageShellFlagsUpdate(trimmed);
      if (flagsUpdate.noglob !== null) {
        shellVars.__atc_noglob_seen = "1";
      }
      if (flagsUpdate.nounset !== null) {
        shellVars.__atc_nounset_seen = "1";
      }
      if (flagsUpdate.globShopt) {
        shellVars.__atc_shopt_glob_seen = "1";
      }
      for (const uv of flagsUpdate.unsetVars) {
        shellVars[uv] = "__atc_cmd_sub__";
        shellVars[`__atc_maybe_unset_${uv}`] = "1";
      }
      if (loopDepth > 0) {
        for (const dv of loopDynamicVars) {
          shellVars[dv] = "__atc_cmd_sub__";
        }
      }
      for (const lv of extractStageLoopVariables(trimmed)) {
        shellVars[lv] = "__atc_cmd_sub__";
      }
      const subRewrite = rewriteStageCommandSubstitutions(trimmed, {
        ...rewriteOpts,
        inheritedShellVars: shellVars,
        inheritedLoopDepth: loopDepth,
      });
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
      for (const uv of maybeUnsetVars) {
        if (Object.prototype.hasOwnProperty.call(shellVars, uv)) {
          shellVars[uv] = "__atc_cmd_sub__";
        }
      }
      for (const lv of extractStageLoopVariables(trimmed)) {
        shellVars[lv] = "__atc_cmd_sub__";
      }
      if (loopDepth > 0) {
        for (const dv of loopDynamicVars) {
          shellVars[dv] = "__atc_cmd_sub__";
        }
      }
      for (const arg of parsedStage.args) {
        if (!/^-[A-Za-z0-9]+$/.test(arg) || matchesAndroidOrAtcText(arg, parsedStage.envVars)) {
          pipeUpstreamArgs.push(arg);
        }
      }
      const doneMatches = trimmed.match(/(?:^|\s)done(?=\s|$)/g);
      const finishLoopDepth = () => {
        if (doneMatches) {
          loopDepth = Math.max(0, loopDepth - doneMatches.length);
        }
      };
      if (subRewrite.changed) {
        trimmed = subRewrite.rewrittenStage;
        if (c.kind !== "device_action" && c.kind !== "atc") {
          finishLoopDepth();
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
              !BASH_DYNAMIC_SPECIAL_VARS.has(k) &&
              typeof v === "string" &&
              !v.includes("__atc_cmd_sub__") &&
              /^[A-Za-z0-9._:/@=-]+$/.test(v),
          ),
        );
        if (Object.keys(staticShellVars).length > 0 && cmdBody.includes("$")) {
          cmdBody = expandVariables(cmdBody, staticShellVars, { opaqueFallback: null });
        }
        finishLoopDepth();
        if (isWin) {
          return `${prefix}atc exec${sessionFlag} --serial ${execSerial} -- ${cmdBody}${suffix}`;
        }
        const isSimpleStage =
          !/[<>|&;`()\r\n]/.test(cmdBody) && !requiresShellExecution(cmdBody);
        if (isSimpleStage) {
          return `${prefix}${posixEnvPrefix}atc exec --serial ${execSerial} -- ${cmdBody}${suffix}`;
        }
        const specialBashRefs = extractReferencedBashSpecialVars(cmdBody);
        const dynamicVarNames = new Set(
          Object.keys(shellVars).filter(
            (k) =>
              !k.startsWith("__atc_") &&
              !BASH_DYNAMIC_SPECIAL_VARS.has(k) &&
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) &&
              !Object.prototype.hasOwnProperty.call(staticShellVars, k),
          ),
        );
        for (const v of specialBashRefs.vars) {
          if (
            BASH_CALLER_SNAPSHOT_VARS.has(v) &&
            !specialBashRefs.assigned.has(v) &&
            !(v === "BASH_REMATCH" && /\[\[[^\]]*=~/.test(cmdBody))
          ) {
            dynamicVarNames.add(v);
          }
        }
        const arrayEnvEntries = new Map();
        const exprToAlias = new Map();
        let aliasSeq = 0;
        const allocateEnvAlias = (expr, preferred) => {
          const existing = exprToAlias.get(expr);
          if (existing) return existing;
          let candidate = preferred;
          while (
            /^__atc_arr_at_\d+$/.test(candidate) ||
            (arrayEnvEntries.has(candidate) && arrayEnvEntries.get(candidate) !== expr)
          ) {
            candidate = `${preferred}_${aliasSeq++}`;
          }
          exprToAlias.set(expr, candidate);
          arrayEnvEntries.set(candidate, expr);
          return candidate;
        };
        const hasDynamicPrefixMatch = (prefix) => {
          if (dynamicVarNames.has(prefix)) return true;
          for (const k of dynamicVarNames) {
            if (k.startsWith(prefix)) return true;
          }
          return false;
        };
        const atArrayExprs = [];
        if (dynamicVarNames.size > 0 && cmdBody.includes("$")) {
          const atExprMap = new Map();
          let scanInSingle = false;
          let scanInDouble = false;
          const scanSubStack = [];
          for (let i = 0; i < cmdBody.length; i++) {
            const ch = cmdBody[i];
            if (ch === "\\" && !scanInSingle && i + 1 < cmdBody.length) {
              i++;
              continue;
            }
            if (ch === "'" && !scanInDouble) {
              scanInSingle = !scanInSingle;
              continue;
            }
            if (ch === '"' && !scanInSingle) {
              scanInDouble = !scanInDouble;
              continue;
            }
            if (!scanInSingle && ch === "$" && cmdBody[i + 1] === "(" && cmdBody[i + 2] !== "(") {
              scanSubStack.push(scanInDouble);
              scanInDouble = false;
              i++;
              continue;
            }
            if (!scanInSingle && !scanInDouble && scanSubStack.length > 0) {
              if (ch === "(") {
                scanSubStack.push(null);
                continue;
              }
              if (ch === ")") {
                const popped = scanSubStack.pop();
                if (typeof popped === "boolean") {
                  scanInDouble = popped;
                }
                continue;
              }
            }
            if (!scanInSingle && ch === "$" && cmdBody[i + 1] === "{") {
              let closeIdx = -1;
              let braceDepth = 1;
              for (let j = i + 2; j < cmdBody.length; j++) {
                if (cmdBody[j] === "\\" && j + 1 < cmdBody.length) {
                  j++;
                  continue;
                }
                if (cmdBody[j] === "{") braceDepth++;
                else if (cmdBody[j] === "}") {
                  braceDepth--;
                  if (braceDepth === 0) {
                    closeIdx = j;
                    break;
                  }
                }
              }
              if (closeIdx !== -1) {
                const inner = cmdBody.slice(i + 2, closeIdx);
                const arrMatch = inner.match(/^([#!]?)([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\](.*)$/);
                if (arrMatch && dynamicVarNames.has(arrMatch[2])) {
                  const [, prefixOp, arrName, subscript, modifier] = arrMatch;
                  const isPositionalArray =
                    prefixOp !== "#" &&
                    (subscript === "@" || (subscript === "*" && !scanInDouble));
                  if (isPositionalArray) {
                    const baseKey = `${prefixOp}${arrName}[@]`;
                    if (!atExprMap.has(baseKey)) {
                      const entry = {
                        idx: atArrayExprs.length,
                        inner,
                        baseKey,
                        prefixOp,
                        arrName,
                        subscript,
                        modifier,
                        quoted: scanInDouble,
                        hasUnquoted: !scanInDouble,
                      };
                      atExprMap.set(baseKey, entry);
                      atArrayExprs.push(entry);
                    } else {
                      const existing = atExprMap.get(baseKey);
                      if (!scanInDouble) {
                        existing.hasUnquoted = true;
                      }
                      if (inner !== existing.inner || scanInDouble !== existing.quoted) {
                        existing.hasDistinctModifier = true;
                      }
                    }
                  }
                  i = closeIdx;
                  continue;
                }
                const scalarModMatch = inner.match(/^([#!]?)([A-Za-z_][A-Za-z0-9_]*)(.*)$/s);
                const isPrefixMatch =
                  scalarModMatch &&
                  scalarModMatch[1] === "!" &&
                  (scalarModMatch[3] === "@" || scalarModMatch[3] === "*") &&
                  hasDynamicPrefixMatch(scalarModMatch[2]);
                if (
                  scalarModMatch &&
                  (dynamicVarNames.has(scalarModMatch[2]) || isPrefixMatch)
                ) {
                  if (
                    scalarModMatch[1] === "!" &&
                    (scalarModMatch[3] === "@" || (scalarModMatch[3] === "*" && !scanInDouble))
                  ) {
                    const [, prefixOp, varName, modifier] = scalarModMatch;
                    const baseKey = `${prefixOp}${varName}@`;
                    if (!atExprMap.has(baseKey)) {
                      const entry = {
                        idx: atArrayExprs.length,
                        inner,
                        baseKey,
                        prefixOp,
                        arrName: varName,
                        subscript: modifier,
                        modifier: "",
                        isPrefixExpansion: true,
                        quoted: scanInDouble,
                        hasUnquoted: !scanInDouble,
                      };
                      atExprMap.set(baseKey, entry);
                      atArrayExprs.push(entry);
                    } else {
                      const existing = atExprMap.get(baseKey);
                      if (!scanInDouble) {
                        existing.hasUnquoted = true;
                      }
                      if (inner !== existing.inner || scanInDouble !== existing.quoted) {
                        existing.hasDistinctModifier = true;
                      }
                    }
                  }
                  if (
                    scalarModMatch[1] !== "" ||
                    scalarModMatch[3] !== "" ||
                    BASH_CALLER_SNAPSHOT_VARS.has(scalarModMatch[2])
                  ) {
                    i = closeIdx;
                    continue;
                  }
                }
              }
            }
          }

          let rewrittenArrBody = "";
          let arrInSingle = false;
          let arrInDouble = false;
          const arrSubStack = [];
          let hasUnquotedAlias = false;
          for (let i = 0; i < cmdBody.length; i++) {
            const ch = cmdBody[i];
            if (ch === "\\" && !arrInSingle && i + 1 < cmdBody.length) {
              rewrittenArrBody += ch + cmdBody[i + 1];
              i++;
              continue;
            }
            if (ch === "'" && !arrInDouble) {
              arrInSingle = !arrInSingle;
              rewrittenArrBody += ch;
              continue;
            }
            if (ch === '"' && !arrInSingle) {
              arrInDouble = !arrInDouble;
              rewrittenArrBody += ch;
              continue;
            }
            if (!arrInSingle && ch === "$" && cmdBody[i + 1] === "(" && cmdBody[i + 2] !== "(") {
              arrSubStack.push(arrInDouble);
              arrInDouble = false;
              rewrittenArrBody += "$(";
              i++;
              continue;
            }
            if (!arrInSingle && !arrInDouble && arrSubStack.length > 0) {
              if (ch === "(") {
                arrSubStack.push(null);
                rewrittenArrBody += ch;
                continue;
              }
              if (ch === ")") {
                const popped = arrSubStack.pop();
                if (typeof popped === "boolean") {
                  arrInDouble = popped;
                }
                rewrittenArrBody += ch;
                continue;
              }
            }
            if (!arrInSingle && ch === "$" && cmdBody[i + 1] === "{") {
              let closeIdx = -1;
              let braceDepth = 1;
              for (let j = i + 2; j < cmdBody.length; j++) {
                if (cmdBody[j] === "\\" && j + 1 < cmdBody.length) {
                  j++;
                  continue;
                }
                if (cmdBody[j] === "{") braceDepth++;
                else if (cmdBody[j] === "}") {
                  braceDepth--;
                  if (braceDepth === 0) {
                    closeIdx = j;
                    break;
                  }
                }
              }
              if (closeIdx !== -1) {
                const inner = cmdBody.slice(i + 2, closeIdx);
                const arrMatch = inner.match(/^([#!]?)([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\](.*)$/);
                if (arrMatch && dynamicVarNames.has(arrMatch[2])) {
                  const [, prefixOp, arrName, subscript, modifier] = arrMatch;
                  const isPositionalArray =
                    prefixOp !== "#" &&
                    (subscript === "@" || (subscript === "*" && !arrInDouble));
                  if (isPositionalArray) {
                    const baseKey = `${prefixOp}${arrName}[@]`;
                    const entry = atExprMap.get(baseKey);
                    if (entry) {
                      rewrittenArrBody += `\${__atc_arr_at_${entry.idx}[${subscript}]${modifier}}`;
                      i = closeIdx;
                      continue;
                    }
                  }
                  if (!arrInDouble && prefixOp !== "#") {
                    hasUnquotedAlias = true;
                  }
                  let preferredAlias;
                  if (prefixOp === "#" && (subscript === "@" || subscript === "*")) {
                    preferredAlias = `__atc_arr_${arrName}_len`;
                  } else if (prefixOp === "!" && !modifier && subscript === "*") {
                    preferredAlias = `__atc_arr_${arrName}_keys`;
                  } else if (!prefixOp && !modifier && subscript === "*") {
                    preferredAlias = `__atc_arr_${arrName}_all`;
                  } else if (!prefixOp && !modifier && /^[A-Za-z0-9_]+$/.test(subscript)) {
                    preferredAlias = `__atc_arr_${arrName}_${subscript}`;
                  } else {
                    preferredAlias = `__atc_arr_${arrName}_${aliasSeq++}`;
                  }
                  const aliasName = allocateEnvAlias(inner, preferredAlias);
                  rewrittenArrBody += `\${${aliasName}}`;
                  i = closeIdx;
                  continue;
                }
                const scalarModMatch = inner.match(/^([#!]?)([A-Za-z_][A-Za-z0-9_]*)(.*)$/s);
                const isPrefixMatch =
                  scalarModMatch &&
                  scalarModMatch[1] === "!" &&
                  (scalarModMatch[3] === "@" || scalarModMatch[3] === "*") &&
                  hasDynamicPrefixMatch(scalarModMatch[2]);
                if (
                  scalarModMatch &&
                  (dynamicVarNames.has(scalarModMatch[2]) || isPrefixMatch)
                ) {
                  if (
                    scalarModMatch[1] !== "" ||
                    scalarModMatch[3] !== "" ||
                    BASH_CALLER_SNAPSHOT_VARS.has(scalarModMatch[2])
                  ) {
                    const [, prefixOp, varName, modifier] = scalarModMatch;
                    const isPositionalPrefix =
                      prefixOp === "!" &&
                      (modifier === "@" || (modifier === "*" && !arrInDouble));
                    if (isPositionalPrefix) {
                      const baseKey = `${prefixOp}${varName}@`;
                      const entry = atExprMap.get(baseKey);
                      if (entry) {
                        rewrittenArrBody += `\${__atc_arr_at_${entry.idx}[${modifier}]}`;
                        i = closeIdx;
                        continue;
                      }
                    }
                    if (!arrInDouble && prefixOp !== "#") {
                      hasUnquotedAlias = true;
                    }
                    const isPrefixWildcard =
                      prefixOp === "!" && (modifier === "@" || modifier === "*");
                    const isMaybeUnsetScalar =
                      !isPrefixWildcard &&
                      (Boolean(shellVars.__atc_nounset_seen) ||
                        Boolean(shellVars[`__atc_maybe_unset_${varName}`]));
                    if (!isMaybeUnsetScalar) {
                      const preferredAlias =
                        prefixOp === "#" && !modifier
                          ? `__atc_var_${varName}_len`
                          : !prefixOp && !modifier
                            ? `__atc_var_${varName}`
                            : `__atc_var_${varName}_${aliasSeq++}`;
                      const aliasName = allocateEnvAlias(inner, preferredAlias);
                      rewrittenArrBody += `\${${aliasName}}`;
                      i = closeIdx;
                      continue;
                    }
                  }
                  if (!arrInDouble) {
                    hasUnquotedAlias = true;
                  }
                }
              }
            } else if (!arrInSingle && ch === "$") {
              const plainVarMatch = cmdBody.slice(i + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
              if (plainVarMatch && dynamicVarNames.has(plainVarMatch[1])) {
                if (!arrInDouble) {
                  hasUnquotedAlias = true;
                }
                if (BASH_CALLER_SNAPSHOT_VARS.has(plainVarMatch[1])) {
                  const varName = plainVarMatch[1];
                  const aliasName = allocateEnvAlias(varName, `__atc_var_${varName}`);
                  rewrittenArrBody += `\${${aliasName}}`;
                  i += varName.length;
                  continue;
                }
              }
            }
            rewrittenArrBody += ch;
          }
          cmdBody = rewrittenArrBody;
          arrayEnvEntries.hasUnquotedAlias = hasUnquotedAlias;
        }
        const bareArithVarNames = new Set();
        if (
          (dynamicVarNames.size > 0 || Object.keys(staticShellVars).length > 0) &&
          (cmdBody.includes("((") || cmdBody.includes("$["))
        ) {
          let arithInSingle = false;
          let arithInDouble = false;
          let arithRewritten = "";
          let arithAliasSeq = arrayEnvEntries.size;
          for (let i = 0; i < cmdBody.length; i++) {
            const ch = cmdBody[i];
            if (ch === "\\" && !arithInSingle && i + 1 < cmdBody.length) {
              arithRewritten += ch + cmdBody[i + 1];
              i++;
              continue;
            }
            if (ch === "'" && !arithInDouble) {
              arithInSingle = !arithInSingle;
              arithRewritten += ch;
              continue;
            }
            if (ch === '"' && !arithInSingle) {
              arithInDouble = !arithInDouble;
              arithRewritten += ch;
              continue;
            }
            const isDollarArith =
              !arithInSingle && ch === "$" && cmdBody[i + 1] === "(" && cmdBody[i + 2] === "(";
            const isBareArithCmd =
              !arithInSingle && !arithInDouble && ch === "(" && cmdBody[i + 1] === "(";
            const isBracketArith = !arithInSingle && ch === "$" && cmdBody[i + 1] === "[";
            if (isDollarArith || isBareArithCmd || isBracketArith) {
              const openToken = isDollarArith ? "$((" : isBareArithCmd ? "((" : "$[";
              const startOffset = openToken.length;
              let depth = isBracketArith ? 1 : 2;
              let j = i + startOffset;
              for (; j < cmdBody.length; j++) {
                if (isBracketArith) {
                  if (cmdBody[j] === "[") depth++;
                  else if (cmdBody[j] === "]") {
                    depth--;
                    if (depth === 0) break;
                  }
                } else {
                  if (cmdBody[j] === "(") depth++;
                  else if (cmdBody[j] === ")") {
                    depth--;
                    if (depth === 0) break;
                  }
                }
              }
              if (j < cmdBody.length) {
                const closeToken = isBracketArith ? "]" : "))";
                const rawArithInner = cmdBody.slice(
                  i + startOffset,
                  isBracketArith ? j : j - 1,
                );
                const rewrittenArithInner = rawArithInner
                  .replace(
                    /(?<![${A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]/g,
                    (full, arrName, subscript) => {
                      if (!dynamicVarNames.has(arrName)) return full;
                      const expr = `${arrName}[${subscript}]`;
                      const preferredAlias = /^[A-Za-z0-9_]+$/.test(subscript)
                        ? `__atc_arr_${arrName}_${subscript}`
                        : `__atc_arr_${arrName}_arith_${arithAliasSeq++}`;
                      return allocateEnvAlias(expr, preferredAlias);
                    },
                  )
                  .replace(
                    /(?<![${A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\[)/g,
                    (full, varName) => {
                      if (!dynamicVarNames.has(varName) || !BASH_CALLER_SNAPSHOT_VARS.has(varName)) {
                        return full;
                      }
                      return allocateEnvAlias(varName, `__atc_var_${varName}`);
                    },
                  );
                for (const idMatch of rewrittenArithInner.matchAll(
                  /\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\[)/g,
                )) {
                  const varName = idMatch[1];
                  if (
                    dynamicVarNames.has(varName) ||
                    Object.prototype.hasOwnProperty.call(staticShellVars, varName)
                  ) {
                    dynamicVarNames.add(varName);
                    bareArithVarNames.add(varName);
                  }
                }
                arithRewritten += `${openToken}${rewrittenArithInner}${closeToken}`;
                i = j;
                continue;
              }
            }
            arithRewritten += ch;
          }
          cmdBody = arithRewritten;
        }
        const usesExtglob = stageUsesExtglob(cmdBody);
        const hasZeroParam = stageReferencesZeroParam(cmdBody);
        const hasPositionalParams = stageReferencesPositionalParams(cmdBody);
        const hasExitStatus = stageReferencesExitStatus(cmdBody);
        const hasUnquotedAlias = Boolean(arrayEnvEntries.hasUnquotedAlias);
        const arrayEnvAssigns = Array.from(arrayEnvEntries.entries())
          .map(([alias, expr]) => `${alias}="\${${expr}}" `)
          .join("");
        const usedDynamicVars = Array.from(dynamicVarNames).filter(
          (k) =>
            !BASH_CALLER_SNAPSHOT_VARS.has(k) &&
            (bareArithVarNames.has(k) ||
              new RegExp(`\\$(?:\\{#?${k}(?:\\}|[^A-Za-z0-9_}\\[][^}]*\\})|${k}\\b)`).test(
                cmdBody,
              )),
        );
        const preserveDynamicUnset = (k) =>
          Boolean(shellVars.__atc_nounset_seen) ||
          Boolean(shellVars[`__atc_maybe_unset_${k}`]);
        const dynamicEnvAssigns = usedDynamicVars
          .map((k) =>
            preserveDynamicUnset(k)
              ? `__atc_set_${k}="\${${k}+1}" ${k}="\${${k}-}" `
              : `${k}="$${k}" `,
          )
          .join("");
        const dynamicUnsetPrelude = usedDynamicVars
          .filter((k) => preserveDynamicUnset(k))
          .map((k) => `[ -n "$__atc_set_${k}" ] || unset ${k}; `)
          .join("");
        const needsOuterNounset =
          Boolean(shellVars.__atc_nounset_seen) ||
          stageContainsUnboundVarOrParam(cmdBody, dynamicVarNames, staticShellVars);
        const nounsetPrelude = needsOuterNounset
          ? "case $__atc_flags in *u*) set -u;; esac; "
          : "";
        const statusEnv = hasExitStatus ? '__atc_status="$?" ' : "";
        const statusPrelude = hasExitStatus ? '(exit "$__atc_status"); ' : "";
        const specialVarEnvParts = [];
        const specialVarPreludeParts = [];
        if (specialBashRefs.vars.has("RANDOM")) {
          specialVarEnvParts.push('__atc_random="${RANDOM-}" ');
          if (
            (specialBashRefs.counts.get("RANDOM") || 0) === 1 &&
            !specialBashRefs.assigned.has("RANDOM")
          ) {
            specialVarPreludeParts.push(
              '[ -n "$__atc_random" ] && { unset RANDOM; RANDOM="$__atc_random"; }; ',
            );
          } else {
            specialVarPreludeParts.push('[ -n "$__atc_random" ] && RANDOM="$__atc_random"; ');
          }
        }
        if (specialBashRefs.vars.has("SRANDOM")) {
          specialVarEnvParts.push('__atc_srandom="${SRANDOM-}" ');
          if (
            (specialBashRefs.counts.get("SRANDOM") || 0) === 1 &&
            !specialBashRefs.assigned.has("SRANDOM")
          ) {
            specialVarPreludeParts.push(
              '[ -n "$__atc_srandom" ] && { unset SRANDOM; SRANDOM="$__atc_srandom"; }; ',
            );
          }
        }
        if (specialBashRefs.vars.has("SECONDS")) {
          specialVarEnvParts.push('__atc_seconds="${SECONDS-}" ');
          specialVarPreludeParts.push('[ -n "$__atc_seconds" ] && SECONDS="$__atc_seconds"; ');
        }
        if (specialBashRefs.vars.has("LINENO")) {
          specialVarEnvParts.push('__atc_lineno="${LINENO-}" ');
          specialVarPreludeParts.push(
            '[ -n "$__atc_lineno" ] && { unset LINENO; LINENO="$__atc_lineno"; }; ',
          );
        }
        if (specialBashRefs.vars.has("BASHPID")) {
          specialVarEnvParts.push('__atc_bashpid="${BASHPID-}" ');
          specialVarPreludeParts.push(
            '[ -n "$__atc_bashpid" ] && { unset BASHPID; BASHPID="$__atc_bashpid"; }; ',
          );
        }
        if (specialBashRefs.vars.has("SHLVL")) {
          specialVarEnvParts.push('__atc_shlvl="${SHLVL-}" ');
          specialVarPreludeParts.push('[ -n "$__atc_shlvl" ] && SHLVL="$__atc_shlvl"; ');
        }
        if (specialBashRefs.vars.has("BASH_SUBSHELL")) {
          specialVarEnvParts.push('__atc_bash_subshell="${BASH_SUBSHELL-}" ');
          specialVarPreludeParts.push(
            '[ -n "$__atc_bash_subshell" ] && { unset BASH_SUBSHELL; BASH_SUBSHELL="$__atc_bash_subshell"; }; ',
          );
        }
        if (specialBashRefs.vars.has("HISTCMD")) {
          specialVarEnvParts.push('__atc_histcmd="${HISTCMD-}" ');
          specialVarPreludeParts.push(
            '[ -n "$__atc_histcmd" ] && { unset HISTCMD; HISTCMD="$__atc_histcmd"; }; ',
          );
        }
        const specialVarEnv = specialVarEnvParts.join("");
        const specialVarPrelude = specialVarPreludeParts.join("");
        const needsOuterGlobShopts =
          usesExtglob ||
          Boolean(shellVars.__atc_shopt_glob_seen) ||
          stageContainsUnquotedGlob(cmdBody, {
            includeCommandSub: false,
            includeVarExpansion: false,
          });
        const shoptsEnv = needsOuterGlobShopts
          ? `__atc_globignore="\${GLOBIGNORE-}" __atc_shopts="\$(shopt -p nullglob failglob dotglob nocaseglob${usesExtglob ? "" : " extglob"} 2>/dev/null; shopt -p globstar 2>/dev/null; shopt -p globasciiranges 2>/dev/null)" `
          : "";
        const globShoptPrelude = needsOuterGlobShopts
          ? 'if [ -n "$__atc_globignore" ]; then GLOBIGNORE=$__atc_globignore; else unset GLOBIGNORE; fi; eval "$__atc_shopts" 2>/dev/null; '
          : "";
        if (atArrayExprs.length > 0) {
          const needsOuterIfs =
            atArrayExprs.some((entry) => entry.hasUnquoted) || hasUnquotedAlias;
          const needsOuterNoglob =
            needsOuterIfs ||
            usesExtglob ||
            needsOuterGlobShopts ||
            Boolean(shellVars.__atc_noglob_seen) ||
            stageContainsUnquotedGlob(cmdBody);
          const flagsEnv = needsOuterNoglob || needsOuterNounset ? '__atc_flags="$-" ' : "";
          const noglobPrelude = needsOuterNoglob
            ? "case $__atc_flags in *f*) set -f;; esac; "
            : "";
          const ifsPrelude = needsOuterIfs
            ? 'if [ -n "$1" ]; then IFS=$2; else unset IFS; fi; shift 2; '
            : "";
          const prelude =
            noglobPrelude +
            globShoptPrelude +
            specialVarPrelude +
            ifsPrelude +
            atArrayExprs
              .map((entry) =>
                entry.isPrefixExpansion
                  ? `__atc_arr_at_${entry.idx}=(); while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do __atc_arr_at_${entry.idx}+=("$1"); shift; done; [ "$#" -gt 0 ] && shift`
                  : `__atc_n=$1; shift; __atc_arr_at_${entry.idx}=("\${@:1:$__atc_n}"); shift "$__atc_n"`,
              )
              .join("; ") +
            "; " +
            dynamicUnsetPrelude +
            nounsetPrelude +
            statusPrelude;
          const escaped = `'${String(prelude + cmdBody).replace(/'/g, `'\\''`)}'`;
          const ifsArgs = needsOuterIfs ? '"${IFS+1}" "${IFS-}" ' : "";
          const trailingArrays =
            ifsArgs +
            atArrayExprs
              .map((entry) =>
                entry.isPrefixExpansion
                  ? `"\${${entry.baseKey}}" "--"`
                  : `"\${#${entry.arrName}[@]}" "\${${entry.baseKey}}"`,
              )
              .join(" ") +
            (hasPositionalParams ? ' "$@"' : "");
          const bashExec = usesExtglob ? "bash -O extglob" : "bash";
          const zeroArg = hasZeroParam ? '"$0"' : "bash";
          return `${prefix}${statusEnv}${arrayEnvAssigns}${flagsEnv}${shoptsEnv}${specialVarEnv}${dynamicEnvAssigns}${posixEnvPrefix}atc exec --serial ${execSerial} -- ${bashExec} -c ${escaped} ${zeroArg} ${trailingArrays}${suffix}`;
        }
        const needsOuterNoglob =
          hasUnquotedAlias ||
          usesExtglob ||
          needsOuterGlobShopts ||
          Boolean(shellVars.__atc_noglob_seen) ||
          stageContainsUnquotedGlob(cmdBody);
        const flagsEnv = needsOuterNoglob || needsOuterNounset ? '__atc_flags="$-" ' : "";
        const noglobPrelude = needsOuterNoglob
          ? "case $__atc_flags in *f*) set -f;; esac; "
          : "";
        const shIfsEnv = hasUnquotedAlias ? '__atc_ifs_set="${IFS+1}" __atc_ifs="${IFS-}" ' : "";
        const shIfsPrelude = hasUnquotedAlias
          ? 'if [ -n "$__atc_ifs_set" ]; then IFS=$__atc_ifs; else unset IFS; fi; '
          : "";
        const targetShell =
          usesExtglob || needsOuterGlobShopts || stageRequiresBashShell(cmdBody) ? "bash" : "sh";
        const shellExec = usesExtglob ? "bash -O extglob" : targetShell;
        const escaped = `'${String(noglobPrelude + globShoptPrelude + specialVarPrelude + shIfsPrelude + dynamicUnsetPrelude + nounsetPrelude + statusPrelude + cmdBody).replace(/'/g, `'\\''`)}'`;
        const trailingAtArgs = hasPositionalParams
          ? ` ${hasZeroParam ? '"$0"' : targetShell} "$@"`
          : hasZeroParam
            ? ' "$0"'
            : "";
        return `${prefix}${statusEnv}${arrayEnvAssigns}${flagsEnv}${shoptsEnv}${specialVarEnv}${shIfsEnv}${dynamicEnvAssigns}${posixEnvPrefix}atc exec --serial ${execSerial} -- ${shellExec} -c ${escaped}${trailingAtArgs}${suffix}`;
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
          finishLoopDepth();
          return trimmed.replace(/\batc(\s+[A-Za-z0-9_-]+)/i, `atc$1 ${sessionFlags}`);
        }
      }
      finishLoopDepth();
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
    for (const lv of extractStageLoopVariables(seg)) {
      shellVars[lv] = "__atc_cmd_sub__";
    }
    const c = classifySegment(seg, shellVars);
    Object.assign(shellVars, c.parsed?.envVars || {});
    for (const lv of extractStageLoopVariables(seg)) {
      shellVars[lv] = "__atc_cmd_sub__";
    }
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
        const usesExtglob = stageUsesExtglob(command);
        const needsOuterNoglob = usesExtglob || stageContainsUnquotedGlob(command);
        const needsOuterNounset = stageContainsUnboundVarOrParam(command);
        const flagsEnv = needsOuterNoglob || needsOuterNounset ? '__atc_flags="$-" ' : "";
        const noglobPrelude = needsOuterNoglob
          ? "case $__atc_flags in *f*) set -f;; esac; "
          : "";
        const nounsetPrelude = needsOuterNounset
          ? "case $__atc_flags in *u*) set -u;; esac; "
          : "";
        const targetShell = usesExtglob || stageRequiresBashShell(command) ? "bash" : "sh";
        const shellExec = usesExtglob ? "bash -O extglob" : targetShell;
        const escaped = `'${String(noglobPrelude + nounsetPrelude + command).replace(/'/g, `'\\''`)}'`;
        rewrittenCommand = `${flagsEnv}${envPrefix}atc exec --serial ${execSerial} -- ${shellExec} -c ${escaped}`;
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
