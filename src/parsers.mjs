import { parseArgs } from "node:util";

export const LITERAL_SENTINEL = "\uE000";

function stripSentinels(value) {
  return String(value || "").replaceAll(LITERAL_SENTINEL, "");
}

/**
 * Spec-compliant java.util.Properties parser.
 * Handles '#' and '!' comments, backslash line continuations, '=', ':', and
 * whitespace key/value separators, and standard Java escape sequences (\uXXXX, \t, \n, \r, \f, \\, \:, \=).
 */
export function parseJavaProperties(content) {
  const props = new Map();
  if (!content || typeof content !== "string") return props;

  const rawLines = content.split(/\r?\n/);
  const logicalLines = [];
  let currentLine = "";
  let continuing = false;

  for (const rawLine of rawLines) {
    const line = continuing ? rawLine.replace(/^[ \t\f]+/, "") : rawLine.replace(/^[ \t\f]+/, "");
    if (!continuing) {
      if (!line || line.startsWith("#") || line.startsWith("!")) {
        continue;
      }
    }
    let backslashCount = 0;
    for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) {
      backslashCount++;
    }
    if (backslashCount % 2 === 1) {
      currentLine += line.slice(0, -1);
      continuing = true;
    } else {
      currentLine += line;
      logicalLines.push(currentLine);
      currentLine = "";
      continuing = false;
    }
  }
  if (continuing && currentLine) {
    logicalLines.push(currentLine);
  }

  const unescapeJavaProp = (str) => {
    let out = "";
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch !== "\\" || i + 1 >= str.length) {
        out += ch;
        continue;
      }
      const next = str[++i];
      if (next === "t") out += "\t";
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "f") out += "\f";
      else if (next === "u" && i + 4 < str.length) {
        const hex = str.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += next;
        }
      } else {
        out += next;
      }
    }
    return out;
  };

  for (const line of logicalLines) {
    let keyEnd = 0;
    let escaped = false;
    for (; keyEnd < line.length; keyEnd++) {
      const ch = line[keyEnd];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "=" || ch === ":" || ch === " " || ch === "\t" || ch === "\f") {
        break;
      }
    }
    let valStart = keyEnd;
    while (
      valStart < line.length &&
      (line[valStart] === " " || line[valStart] === "\t" || line[valStart] === "\f")
    ) {
      valStart++;
    }
    if (valStart < line.length && (line[valStart] === "=" || line[valStart] === ":")) {
      valStart++;
      while (
        valStart < line.length &&
        (line[valStart] === " " || line[valStart] === "\t" || line[valStart] === "\f")
      ) {
        valStart++;
      }
    }
    const key = unescapeJavaProp(line.slice(0, keyEnd));
    const value = unescapeJavaProp(line.slice(valStart));
    if (key) {
      props.set(key, value);
    }
  }

  return props;
}

function stripBazelrcLineComment(rawLine) {
  let quote = null;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < rawLine.length) i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < rawLine.length) {
      i++;
      continue;
    }
    if (ch === "#") {
      return rawLine.slice(0, i);
    }
  }
  return rawLine;
}

/**
 * Joins backslash-continued lines in configuration files like .bazelrc.
 */
export function joinBackslashContinuations(content) {
  if (!content || typeof content !== "string") return [];
  const rawLines = content.split(/\r?\n/);
  const lines = [];
  let cur = "";
  for (const raw of rawLines) {
    const uncommented = stripBazelrcLineComment(raw);
    const trimmedRight = uncommented.replace(/\s+$/, "");
    let bs = 0;
    for (let i = trimmedRight.length - 1; i >= 0 && trimmedRight[i] === "\\"; i--) {
      bs++;
    }
    if (bs % 2 === 1) {
      cur += trimmedRight.slice(0, -1) + " ";
    } else {
      cur += uncommented;
      lines.push(cur);
      cur = "";
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Battle-tested shell-quote style word splitter supporting single quotes,
 * double quotes (with \", \\, \$, \`), and unquoted backslash escapes.
 */
export function splitShellWords(rawStr) {
  if (!rawStr) return [];
  const s = String(rawStr).trim();
  const tokens = [];
  let cur = "";
  let hasToken = false;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (
        ch === "\\" &&
        i + 1 < s.length &&
        (s[i + 1] === '"' || s[i + 1] === "\\" || s[i + 1] === "$" || s[i + 1] === "`")
      ) {
        cur += s[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length && /[\s"']/.test(s[i + 1])) {
      cur += s[++i];
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || cur.length > 0) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken || cur.length > 0) {
    tokens.push(cur);
  }
  return tokens;
}

/**
 * Uses Node's built-in util.parseArgs (POSIX/GNU getopt_long) to parse `env` wrapper arguments.
 * Fails closed (`unknownOption: true`) if an unrecognized flag or `-S`/`--split-string` is encountered.
 */
export function parseEnvWrapperArgs(curArgs = []) {
  const cleanArgs = curArgs.map((a) => stripSentinels(a));
  const actions = [];
  let cmdIndex = curArgs.length;
  let unknownOption = false;

  // Locate the boundary of `env` options & KEY=VALUE assignments before invoking parseArgs
  // so flags belonging to the wrapped command are never parsed as `env` flags.
  let limit = curArgs.length;
  for (let i = 0; i < cleanArgs.length; i++) {
    const a = cleanArgs[i];
    if (a === "--") {
      limit = i + 1;
      break;
    }
    if (a === "-" || a === "-i" || a === "--ignore-environment" || a === "-0" || a === "--null" || a === "-v" || a === "--debug") {
      continue;
    }
    if (a === "-u" || a === "--unset" || a === "-C" || a === "--chdir") {
      i++;
      continue;
    }
    if (
      a.startsWith("--unset=") ||
      a.startsWith("--chdir=") ||
      (a.startsWith("-") && a.length > 1)
    ) {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      continue;
    }
    limit = i;
    break;
  }

  const prefixClean = cleanArgs.slice(0, limit);
  try {
    const parsed = parseArgs({
      args: prefixClean,
      options: {
        "ignore-environment": { type: "boolean", short: "i", multiple: true },
        chdir: { type: "string", short: "C", multiple: true },
        unset: { type: "string", short: "u", multiple: true },
        null: { type: "boolean", short: "0", multiple: true },
        debug: { type: "boolean", short: "v", multiple: true },
      },
      strict: false,
      allowPositionals: true,
      tokens: true,
    });

    for (const tok of parsed.tokens) {
      if (tok.kind === "option-terminator") {
        cmdIndex = tok.index + 1;
        break;
      }
      if (tok.kind === "option") {
        if (tok.name === "ignore-environment") {
          actions.push({ type: "ignore_env" });
        } else if (tok.name === "chdir") {
          if (typeof tok.value !== "string" || !tok.value) {
            unknownOption = true;
            break;
          }
          // Preserve original sentinel-annotated value when standalone token was used
          const rawOrig =
            !tok.inlineValue && tok.index + 1 < curArgs.length
              ? curArgs[tok.index + 1]
              : tok.rawName && curArgs[tok.index]?.startsWith(tok.rawName + "=")
                ? curArgs[tok.index].slice(tok.rawName.length + 1)
                : tok.rawName && curArgs[tok.index]?.startsWith(tok.rawName)
                  ? curArgs[tok.index].slice(tok.rawName.length)
                  : tok.value;
          actions.push({ type: "chdir", rawDir: rawOrig });
        } else if (tok.name === "unset") {
          if (typeof tok.value !== "string" || !tok.value) {
            unknownOption = true;
            break;
          }
          actions.push({ type: "unset", key: stripSentinels(tok.value) });
        } else if (tok.name === "null" || tok.name === "debug") {
          // Benign flags
        } else {
          unknownOption = true;
          break;
        }
        continue;
      }
      if (tok.kind === "positional") {
        if (tok.value === "-") {
          actions.push({ type: "ignore_env" });
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.value)) {
          const rawToken = curArgs[tok.index];
          const cleanAssign = stripSentinels(rawToken);
          const eqIdx = cleanAssign.indexOf("=");
          const key = cleanAssign.slice(0, eqIdx);
          const rawVal = rawToken.slice(rawToken.indexOf("=") + 1);
          actions.push({ type: "assign", key, rawVal });
          continue;
        }
        cmdIndex = tok.index;
        break;
      }
    }
    if (cmdIndex === curArgs.length && limit < curArgs.length) {
      cmdIndex = limit;
    }
  } catch {
    unknownOption = true;
  }

  return { actions, cmdIndex, unknownOption };
}

const SHELL_INTERPRETER_HEREDOC_BASES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "csh",
  "tcsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "source",
  ".",
]);

const HEREDOC_TRANSPARENT_WRAPPERS = new Set([
  "env",
  "nice",
  "nohup",
  "time",
  "timeout",
  "stdbuf",
  "command",
  "builtin",
  "exec",
  "chrt",
  "ionice",
  "taskset",
  "setsid",
  "caffeinate",
  "arch",
]);

const HEREDOC_WRAPPER_VALUE_FLAGS = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-S",
  "--split-string",
  "-n",
  "--adjustment",
  "-k",
  "--kill-after",
  "-s",
  "--signal",
  "-i",
  "-o",
  "-e",
  "--input",
  "--output",
  "--error",
  "-a",
]);

function extractHeredocCmdBase(token) {
  const cleaned = stripSentinels(String(token || ""))
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/^@+/, "");
  if (!cleaned) return "";
  return (cleaned.split(/[\\/]/).pop() || "")
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com|sh)$/i, "");
}

function splitHeaderLineClauses(lineStr, lineOffset = 0) {
  const clauses = [];
  let clauseStart = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let parenDepth = 0;
  for (let i = 0; i < lineStr.length; i++) {
    const ch = lineStr[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inBacktick) {
      if (ch === "\\" && i + 1 < lineStr.length) {
        i++;
        continue;
      }
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (ch === "\\" && i + 1 < lineStr.length) {
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(lineStr[i - 1]))) {
      break;
    }
    if (ch === "(") {
      parenDepth++;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (parenDepth === 0) {
      if ((ch === "&" && lineStr[i + 1] === "&") || (ch === "|" && lineStr[i + 1] === "|")) {
        clauses.push({
          start: lineOffset + clauseStart,
          end: lineOffset + i,
          sepAfter: `${ch}${lineStr[i + 1]}`,
        });
        i++;
        clauseStart = i + 1;
        continue;
      }
      if (ch === "|") {
        const sep = lineStr[i + 1] === "&" ? "|&" : "|";
        clauses.push({
          start: lineOffset + clauseStart,
          end: lineOffset + i,
          sepAfter: sep,
        });
        if (sep === "|&") i++;
        clauseStart = i + 1;
        continue;
      }
      if (ch === ";") {
        const sep = lineStr[i + 1] === ";" ? ";;" : ";";
        clauses.push({
          start: lineOffset + clauseStart,
          end: lineOffset + i,
          sepAfter: sep,
        });
        if (sep === ";;") i++;
        clauseStart = i + 1;
        continue;
      }
      if (
        ch === "&" &&
        lineStr[i + 1] !== ">" &&
        (i === 0 || (lineStr[i - 1] !== ">" && lineStr[i - 1] !== "<"))
      ) {
        clauses.push({
          start: lineOffset + clauseStart,
          end: lineOffset + i,
          sepAfter: "&",
        });
        clauseStart = i + 1;
        continue;
      }
    }
  }
  clauses.push({
    start: lineOffset + clauseStart,
    end: lineOffset + lineStr.length,
    sepAfter: null,
  });
  return clauses;
}

function inspectHeredocClauseCommand(rawClauseText) {
  const hasProcessOrCmdSub = /(?:^|[^\\])(?:[<>]\(|\$\(|`)/.test(rawClauseText);
  const writesFile = /(?:^|[^<>])>(?!&)/.test(rawClauseText);
  let cleaned = String(rawClauseText || "")
    .replace(/(?:[0-9]*>>?\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)|2>&1)/g, " ")
    .trimStart();
  const ctrlRe = /^(?:(?:if|then|else|elif|while|until|do|!)\b|[({;]\s*)+/;
  while (ctrlRe.test(cleaned)) {
    cleaned = cleaned.replace(ctrlRe, "").trimStart();
  }
  const words = splitShellWords(cleaned);
  let idx = 0;
  while (idx < words.length) {
    const w = words[idx];
    if (/^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*\+?=/i.test(w)) {
      idx++;
      continue;
    }
    const base = extractHeredocCmdBase(w);
    if (HEREDOC_TRANSPARENT_WRAPPERS.has(base)) {
      idx++;
      while (idx < words.length) {
        const arg = words[idx];
        if (arg === "--") {
          idx++;
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          idx++;
          continue;
        }
        if (arg.startsWith("-")) {
          if ( (base === "command" || base === "builtin") && /[vV]/.test(arg) ) {
            break;
          }
          idx++;
          if (HEREDOC_WRAPPER_VALUE_FLAGS.has(arg) && idx < words.length) {
            idx++;
          }
          continue;
        }
        break;
      }
      if (base === "timeout" && idx < words.length && /^\d+(?:\.\d+)?[smhd]?$/i.test(words[idx])) {
        idx++;
      }
      continue;
    }
    break;
  }
  const cmdTok = words[idx] || "";
  const base = extractHeredocCmdBase(cmdTok);
  const args = words.slice(idx + 1);
  let isShellReadingStdin = false;
  if (SHELL_INTERPRETER_HEREDOC_BASES.has(base)) {
    if (base === "eval" || base === "source" || base === ".") {
      isShellReadingStdin = true;
    } else {
      const hasInlineC = args.some((a) => {
        if (base === "cmd") return /^\/[ck]$/i.test(a);
        if (base === "powershell" || base === "pwsh") return /^-(?:c|command)$/i.test(a);
        return a === "-c" || (/^-[A-Za-z]+$/.test(a) && a.includes("c") && !a.includes("s"));
      });
      isShellReadingStdin = !hasInlineC;
    }
  }
  return {
    base,
    cmdTok,
    args,
    isShellReadingStdin,
    writesFile: writesFile || base === "tee",
    hasProcessOrCmdSub,
  };
}

function extractCommandSubstitutionsFromUnquotedHeredoc(bodyText) {
  const s = String(bodyText || "");
  const out = [];
  let inBacktick = false;
  let topSub = null;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (top?.inSingle) {
      if (ch === "'") top.inSingle = false;
      continue;
    }
    if (inBacktick) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (ch === "`") {
        inBacktick = false;
        if (topSub && topSub.kind === "backtick" && stack.length === 0) {
          out.push(s.slice(topSub.openStart, i + 1));
          topSub = null;
        }
      }
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      if (!topSub && stack.length === 0) {
        topSub = { openStart: i, kind: "backtick" };
      }
      continue;
    }
    if (ch === "$" && i + 1 < s.length && (s[i + 1] === "(" || s[i + 1] === "{")) {
      if (s[i + 1] === "(" && s[i + 2] === "(") {
        stack.push({ type: "arith", inSingle: false, inDouble: false });
        stack.push({ type: "paren", inSingle: false, inDouble: false });
        i += 2;
        continue;
      }
      const isCmdSub = s[i + 1] === "(";
      if (isCmdSub && !topSub) {
        topSub = { openStart: i, kind: "paren", stackDepth: stack.length + 1 };
      }
      stack.push({ type: isCmdSub ? "paren" : "brace", inSingle: false, inDouble: false });
      i++;
      continue;
    }
    if (top) {
      if (top.inDouble) {
        if (ch === '"') top.inDouble = false;
        continue;
      }
      if (ch === "'") {
        top.inSingle = true;
        continue;
      }
      if (ch === '"') {
        top.inDouble = true;
        continue;
      }
      if (top.type === "paren" || top.type === "arith") {
        if (ch === "(") {
          stack.push({ type: "paren", inSingle: false, inDouble: false });
        } else if (ch === ")") {
          stack.pop();
          if (topSub && topSub.kind === "paren" && stack.length < topSub.stackDepth) {
            out.push(s.slice(topSub.openStart, i + 1));
            topSub = null;
          }
        }
      } else if (top.type === "brace") {
        if (ch === "{") stack.push({ type: "brace", inSingle: false, inDouble: false });
        else if (ch === "}") stack.pop();
      }
    }
  }
  return out;
}

export function parseScriptHeredocs(script, rawParts = null) {
  const s = String(script || "");
  if (!s.includes("<<")) return [];

  const heredocs = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  const substStack = [];
  const pendingHeredocs = [];
  let currentLineStart = 0;

  const curCtx = () => (substStack.length > 0 ? substStack[substStack.length - 1] : null);
  const isSingle = () => (curCtx() ? curCtx().inSingle : inSingle);
  const isDouble = () => (curCtx() ? curCtx().inDouble : inDouble);
  const setSingle = (v) => {
    if (curCtx()) curCtx().inSingle = v;
    else inSingle = v;
  };
  const setDouble = (v) => {
    if (curCtx()) curCtx().inDouble = v;
    else inDouble = v;
  };

  const resolvePendingAtNewline = (nlIdx) => {
    const headerLineEnd = nlIdx > 0 && s[nlIdx - 1] === "\r" ? nlIdx - 1 : nlIdx;
    let cursor = nlIdx + 1;
    const lineHeredocs = [];
    while (pendingHeredocs.length > 0) {
      const phd = pendingHeredocs.shift();
      const bodyStart = cursor;
      let bodyEnd = s.length;
      let heredocEnd = s.length;
      let unterminated = true;
      while (cursor <= s.length) {
        const lineStart = cursor;
        let lineEnd = s.indexOf("\n", lineStart);
        if (lineEnd === -1) lineEnd = s.length;
        let lineText = s.slice(lineStart, lineEnd);
        if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
        if (!phd.quoted) {
          while (lineEnd < s.length && /(?<!\\)(?:\\\\)*\\$/.test(lineText)) {
            lineText = lineText.slice(0, -1);
            const nextStart = lineEnd + 1;
            let nextEnd = s.indexOf("\n", nextStart);
            if (nextEnd === -1) nextEnd = s.length;
            let nextPart = s.slice(nextStart, nextEnd);
            if (nextPart.endsWith("\r")) nextPart = nextPart.slice(0, -1);
            lineText += nextPart;
            lineEnd = nextEnd;
          }
        }
        const cmpText = phd.stripTabs ? lineText.replace(/^\t+/, "") : lineText;
        if (cmpText === phd.delim) {
          bodyEnd = lineStart;
          heredocEnd = lineEnd;
          unterminated = false;
          if (lineEnd < s.length && pendingHeredocs.length > 0) {
            cursor = lineEnd + 1;
          } else {
            cursor = lineEnd;
          }
          break;
        }
        if (lineEnd >= s.length) {
          cursor = s.length;
          break;
        }
        cursor = lineEnd + 1;
      }
      const bodyText = s.slice(bodyStart, bodyEnd);
      let effectiveBodyText = bodyText;
      if (phd.stripTabs) {
        effectiveBodyText = effectiveBodyText.replace(/^(?:\t+)|(?<=\n)\t+/g, "");
      }
      if (!phd.quoted) {
        effectiveBodyText = effectiveBodyText.replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, "$1");
      }
      const entry = {
        ...phd,
        headerLineEnd,
        bodyStart,
        bodyEnd,
        heredocEnd,
        unterminated,
        bodyText,
        effectiveBodyText,
        kind: "other_executable",
        opPartIdx: -1,
        bodyPartIdx: -1,
        consumerPartIdx: -1,
        relBodyStart: -1,
        relBodyEnd: -1,
      };
      lineHeredocs.push(entry);
      heredocs.push(entry);
    }
    return cursor;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isSingle()) {
      if (ch === "'") setSingle(false);
      continue;
    }
    if (inBacktick) {
      if (ch === "\\" && i + 1 < s.length) {
        i++;
        continue;
      }
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "$" && i + 1 < s.length && (s[i + 1] === "(" || s[i + 1] === "{")) {
      substStack.push({
        type: s[i + 1] === "(" ? "paren" : "brace",
        inSingle: false,
        inDouble: false,
      });
      i++;
      continue;
    }
    if (!isDouble() && (ch === "<" || ch === ">") && i + 1 < s.length && s[i + 1] === "(") {
      substStack.push({ type: "paren", inSingle: false, inDouble: false });
      i++;
      continue;
    }
    if (isDouble()) {
      if (ch === '"') setDouble(false);
      continue;
    }
    if (ch === "'") {
      setSingle(true);
      continue;
    }
    if (ch === '"') {
      setDouble(true);
      continue;
    }
    if (substStack.length > 0) {
      const top = curCtx();
      if (top.type === "paren") {
        if (ch === "#" && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
          while (i + 1 < s.length && s[i + 1] !== "\n") i++;
          continue;
        }
        if (ch === "(") substStack.push({ type: "paren", inSingle: false, inDouble: false });
        else if (ch === ")") substStack.pop();
      } else if (top.type === "brace") {
        if (ch === "{") substStack.push({ type: "brace", inSingle: false, inDouble: false });
        else if (ch === "}") substStack.pop();
      }
      continue;
    }
    if (ch === "\n") {
      if (pendingHeredocs.length > 0) {
        const nextCursor = resolvePendingAtNewline(i);
        currentLineStart = nextCursor < s.length && s[nextCursor] === "\n" ? nextCursor + 1 : nextCursor;
        i = nextCursor - 1;
      } else {
        currentLineStart = i + 1;
      }
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
      while (i + 1 < s.length && s[i + 1] !== "\n") i++;
      continue;
    }
    if (s[i - 1] !== "<" && ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      const opStart =
        i > 0 && /[0-9]/.test(s[i - 1]) && (i === 1 || /[\s;&|()]/.test(s[i - 2])) ? i - 1 : i;
      let k = i + 2;
      const stripTabs = s[k] === "-";
      if (stripTabs) k++;
      while (k < s.length && (s[k] === " " || s[k] === "\t")) k++;
      let delim = "";
      const delimStart = k;
      let quoted = false;
      while (k < s.length && !/[\s;&|()<>]/.test(s[k])) {
        if (s[k] === "$" && s[k + 1] === "'") {
          quoted = true;
          k += 2;
          while (k < s.length && s[k] !== "'") {
            if (s[k] === "\\" && k + 1 < s.length) {
              delim += s[k + 1];
              k += 2;
            } else {
              delim += s[k++];
            }
          }
          if (k < s.length) k++;
        } else if (s[k] === "'") {
          quoted = true;
          k++;
          while (k < s.length && s[k] !== "'") delim += s[k++];
          if (k < s.length) k++;
        } else if (s[k] === '"' || (s[k] === "$" && s[k + 1] === '"')) {
          quoted = true;
          if (s[k] === "$") k++;
          k++;
          while (k < s.length && s[k] !== '"') {
            if (s[k] === "\\" && s[k + 1] === "\n") {
              k += 2;
            } else if (s[k] === "\\" && s[k + 1] === "\r" && s[k + 2] === "\n") {
              k += 3;
            } else if (s[k] === "\\" && k + 1 < s.length && /["\\$`]/.test(s[k + 1])) {
              delim += s[k + 1];
              k += 2;
            } else {
              delim += s[k++];
            }
          }
          if (k < s.length) k++;
        } else if (s[k] === "\\" && s[k + 1] === "\n") {
          k += 2;
        } else if (s[k] === "\\" && s[k + 1] === "\r" && s[k + 2] === "\n") {
          k += 3;
        } else if (s[k] === "\\" && k + 1 < s.length) {
          quoted = true;
          delim += s[k + 1];
          k += 2;
        } else {
          delim += s[k++];
        }
      }
      if (delim.length > 0 && k > delimStart) {
        pendingHeredocs.push({
          opStart,
          opEnd: k,
          delim,
          stripTabs,
          quoted,
          lineStart: currentLineStart,
        });
        i = k - 1;
      }
    }
  }

  while (pendingHeredocs.length > 0) {
    const phd = pendingHeredocs.shift();
    heredocs.push({
      ...phd,
      headerLineEnd: s.length,
      bodyStart: s.length,
      bodyEnd: s.length,
      heredocEnd: s.length,
      unterminated: true,
      bodyText: "",
      effectiveBodyText: "",
      kind: "other_executable",
      opPartIdx: -1,
      bodyPartIdx: -1,
      consumerPartIdx: -1,
      relBodyStart: -1,
      relBodyEnd: -1,
    });
  }

  let partRanges = null;
  if (Array.isArray(rawParts)) {
    partRanges = [];
    let offset = 0;
    for (let p = 0; p < rawParts.length; p++) {
      const len = String(rawParts[p] || "").length;
      partRanges.push({ start: offset, end: offset + len });
      offset += len;
    }
  }

  const findEvenPartAtOffset = (charOffset) => {
    if (!partRanges) return -1;
    for (let p = 0; p < partRanges.length; p += 2) {
      if (charOffset >= partRanges[p].start && charOffset <= partRanges[p].end) {
        return p;
      }
    }
    return -1;
  };

  for (const hd of heredocs) {
    if (partRanges) {
      for (let p = 0; p < partRanges.length; p += 2) {
        if (hd.opStart >= partRanges[p].start && hd.opStart < partRanges[p].end) {
          hd.opPartIdx = p;
        }
        if (hd.bodyStart >= partRanges[p].start && hd.bodyEnd <= partRanges[p].end) {
          hd.bodyPartIdx = p;
          hd.relBodyStart = hd.bodyStart - partRanges[p].start;
          hd.relBodyEnd = hd.bodyEnd - partRanges[p].start;
        }
      }
    }

    const headerLine = s.slice(hd.lineStart, hd.headerLineEnd);
    const clauses = splitHeaderLineClauses(headerLine, hd.lineStart);
    const cIdx = clauses.findIndex((c) => hd.opStart >= c.start && hd.opStart <= c.end);
    if (cIdx === -1) continue;
    const clause = clauses[cIdx];

    const sameClauseHds = heredocs.filter(
      (h) => h.lineStart === hd.lineStart && h.opStart >= clause.start && h.opEnd <= clause.end,
    );
    let clauseWithoutHeredocs = "";
    let curPos = clause.start;
    for (const shd of sameClauseHds) {
      clauseWithoutHeredocs += `${s.slice(curPos, shd.opStart)} `;
      curPos = shd.opEnd;
    }
    clauseWithoutHeredocs += s.slice(curPos, clause.end);

    const clauseInfo = inspectHeredocClauseCommand(clauseWithoutHeredocs);
    if (clauseInfo.isShellReadingStdin) {
      hd.kind = "shell";
      hd.consumerPartIdx = hd.opPartIdx;
      continue;
    }

    if (clauseInfo.base === "cat" || clauseInfo.base === "tee") {
      if (clause.sepAfter === "|" || clause.sepAfter === "|&") {
        let stageIdx = cIdx + 1;
        let matchedShellConsumerOffset = -1;
        while (stageIdx < clauses.length) {
          const stClause = clauses[stageIdx];
          const stText = s.slice(stClause.start, stClause.end).trim();
          if (!stText && stageIdx === clauses.length - 1) {
            const afterHd = s.slice(hd.heredocEnd);
            const nextStageMatch = afterHd.match(/^(\s+)([^\n;&|]+)/);
            if (nextStageMatch) {
              const stInfo = inspectHeredocClauseCommand(nextStageMatch[2]);
              if (stInfo.isShellReadingStdin) {
                matchedShellConsumerOffset = hd.heredocEnd + nextStageMatch[1].length;
              }
            }
            break;
          }
          const stInfo = inspectHeredocClauseCommand(stText);
          if (stInfo.isShellReadingStdin) {
            matchedShellConsumerOffset = stClause.start;
            break;
          }
          if (
            (stInfo.base === "cat" || stInfo.base === "tee") &&
            (stClause.sepAfter === "|" || stClause.sepAfter === "|&")
          ) {
            stageIdx++;
            continue;
          }
          break;
        }
        if (matchedShellConsumerOffset !== -1) {
          hd.kind = "shell";
          hd.consumerPartIdx = findEvenPartAtOffset(matchedShellConsumerOffset);
        } else {
          hd.kind = "other_executable";
        }
        continue;
      }

      const afterGroupPipe = s
        .slice(hd.heredocEnd)
        .match(/^(\s*[)}]+\s*\|(?!\|)\s*)([^\n;&|]+)/);
      if (afterGroupPipe) {
        const stInfo = inspectHeredocClauseCommand(afterGroupPipe[2]);
        if (stInfo.isShellReadingStdin) {
          hd.kind = "shell";
          hd.consumerPartIdx = findEvenPartAtOffset(hd.heredocEnd + afterGroupPipe[1].length);
        } else {
          hd.kind = "other_executable";
        }
        continue;
      }

      const restOfHeaderLine = s.slice(clause.end, hd.headerLineEnd).trim();
      const afterHeredocText = s.slice(hd.heredocEnd).trim();
      if (
        clauseInfo.hasProcessOrCmdSub ||
        hd.unterminated ||
        (clauseInfo.writesFile && (restOfHeaderLine.length > 0 || afterHeredocText.length > 0))
      ) {
        hd.kind = "other_executable";
      } else {
        hd.kind = "data";
      }
      continue;
    }

    hd.kind = "other_executable";
  }

  return heredocs;
}

export function stripOpaqueHeredocsForCheck(script) {
  if (!script || !script.includes("<<")) return script;
  const s = String(script);
  const heredocs = parseScriptHeredocs(s);
  if (heredocs.length === 0) return s;

  const edits = [];
  for (const hd of heredocs) {
    if (hd.kind === "data") {
      const replacement = hd.quoted
        ? ""
        : extractCommandSubstitutionsFromUnquotedHeredoc(hd.effectiveBodyText).join("\n");
      edits.push({
        start: hd.bodyStart,
        end: hd.heredocEnd,
        replacement,
      });
    } else {
      edits.push({
        start: hd.opStart,
        end: hd.opEnd,
        replacement: " ",
      });
      edits.push({
        start: hd.bodyStart,
        end: hd.heredocEnd,
        replacement: hd.effectiveBodyText,
      });
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let out = s;
  for (const edit of edits) {
    out = `${out.slice(0, edit.start)}${edit.replacement}${out.slice(edit.end)}`;
  }
  return out;
}

/**
 * Vendored shell-quote style tokenizer producing operator, word, and comment tokens,
 * plus quote/escape integrity status.
 */
export function parseShellQuote(rawScript, { shellType = "posix" } = {}) {
  const s = stripOpaqueHeredocsForCheck(String(rawScript || ""));
  const tokens = [];
  let i = 0;
  let unclosedQuote = false;
  let trailingEscape = false;

  while (i < s.length) {
    while (i < s.length && /[ \t\f\r]/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === "\n") {
      tokens.push({ type: "op", op: ";" });
      i++;
      continue;
    }

    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      let end = s.indexOf("\n", i);
      if (end === -1) end = s.length;
      tokens.push({ type: "comment", value: s.slice(i + 1, end) });
      i = end;
      continue;
    }

    if (
      shellType === "posix" &&
      (s[i] === "<" || s[i] === ">") &&
      s[i + 1] === "("
    ) {
      tokens.push({ type: "op", op: `${s[i]}(` });
      i += 2;
      continue;
    }

    if (s.slice(i, i + 3) === "<<<") {
      tokens.push({ type: "op", op: "<<<" });
      i += 3;
      continue;
    }

    const twoCharOp = s.slice(i, i + 2);
    if (
      twoCharOp === "&&" ||
      twoCharOp === "||" ||
      twoCharOp === ";;" ||
      twoCharOp === "|&" ||
      twoCharOp === ">>" ||
      twoCharOp === ">&" ||
      twoCharOp === ">|" ||
      twoCharOp === "<<" ||
      twoCharOp === "<&" ||
      twoCharOp === "<>"
    ) {
      tokens.push({ type: "op", op: twoCharOp });
      i += 2;
      continue;
    }

    if (
      s[i] === ";" ||
      s[i] === "|" ||
      s[i] === "&" ||
      s[i] === "(" ||
      s[i] === ")" ||
      s[i] === ">" ||
      s[i] === "<"
    ) {
      tokens.push({ type: "op", op: s[i] });
      i++;
      continue;
    }

    let word = "";
    let hasExpansion = false;
    let quoted = false;
    while (i < s.length) {
      const ch = s[i];
      if (/[ \t\f\r\n]/.test(ch)) break;
      if (
        ch === ";" ||
        ch === "|" ||
        ch === "&" ||
        ch === "(" ||
        ch === ")" ||
        ch === ">" ||
        ch === "<"
      ) {
        break;
      }
      if (ch === "'") {
        quoted = true;
        i++;
        while (i < s.length && s[i] !== "'") {
          word += s[i++];
        }
        if (i >= s.length) {
          unclosedQuote = true;
          break;
        }
        i++;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < s.length) {
            const nxt = s[i + 1];
            if (nxt === '"' || nxt === "\\" || nxt === "$" || nxt === "`") {
              word += nxt;
              i += 2;
              continue;
            }
          }
          if (s[i] === "$" || s[i] === "`") {
            hasExpansion = true;
          }
          word += s[i++];
        }
        if (i >= s.length) {
          unclosedQuote = true;
          break;
        }
        i++;
        continue;
      }
      if (shellType === "posix" && ch === "\\") {
        if (i + 1 >= s.length) {
          trailingEscape = true;
          i++;
          break;
        }
        if (s[i + 1] === "\n") {
          i += 2;
          continue;
        }
        word += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === "$" && s[i + 1] === "(") {
        hasExpansion = true;
        let depth = 1;
        word += "$(";
        i += 2;
        while (i < s.length && depth > 0) {
          if (s[i] === "(") depth++;
          else if (s[i] === ")") depth--;
          word += s[i++];
        }
        if (depth > 0) {
          unclosedQuote = true;
        }
        continue;
      }
      if (ch === "`") {
        hasExpansion = true;
        word += ch;
        i++;
        while (i < s.length && s[i] !== "`") {
          if (s[i] === "\\" && i + 1 < s.length) {
            word += s[i] + s[i + 1];
            i += 2;
            continue;
          }
          word += s[i++];
        }
        if (i >= s.length) {
          unclosedQuote = true;
          break;
        }
        word += s[i++];
        continue;
      }
      if (ch === "$") {
        hasExpansion = true;
      }
      word += s[i++];
    }
    tokens.push({ type: "word", value: word, hasExpansion, quoted });
  }

  return { tokens, unclosedQuote, trailingEscape };
}

/**
 * Shared fail-closed gate used by both classifier (`peelBuildCommandWrappers`)
 * and rewriter (`buildChildInvocation`).
 * Rejects unclosed quotes/subshells, `eval`/`coproc`/`select` in command position,
 * process substitutions `<(...)` / `>(...)`, and dynamic redirection targets `>$(...)`.
 */
export function detectUnparseableShellConstructs(script, shellType = "posix") {
  if (!script || typeof script !== "string") {
    return { unparseable: false, reason: null };
  }
  const cleanScript = stripSentinels(script);
  if (cleanScript.includes("<<")) {
    const heredocs = parseScriptHeredocs(cleanScript);
    if (heredocs.some((hd) => hd.kind === "other_executable" || hd.unterminated)) {
      return {
        unparseable: true,
        reason:
          'Executable or file-writing heredoc in shell command cannot be safely analyzed under ATC; run direct commands via "atc exec" or "atc batch".',
      };
    }
  }
  const parsed = parseShellQuote(cleanScript, { shellType });
  if (parsed.unclosedQuote) {
    return {
      unparseable: true,
      reason:
        "Unclosed quote or command substitution in shell command cannot be safely analyzed under ATC.",
    };
  }
  if (shellType === "posix" && parsed.trailingEscape) {
    return {
      unparseable: true,
      reason:
        "Trailing unescaped backslash in shell command cannot be safely analyzed under ATC.",
    };
  }

  const REDIR_OPS = new Set([">", ">>", ">&", ">|", "<", "<&", "<>"]);
  const CMD_BOUNDARY_OPS = new Set([";", ";;", "&", "&&", "||", "|", "|&", "("]);
  const CMD_BOUNDARY_WORDS = new Set(["{", "!", "then", "else", "elif", "do"]);

  let atCommandHead = true;
  let afterCommandOrBuiltin = false;

  for (let idx = 0; idx < parsed.tokens.length; idx++) {
    const tok = parsed.tokens[idx];
    if (tok.type === "comment") continue;
    if (tok.type === "op") {
      if (tok.op === "<(" || tok.op === ">(") {
        return {
          unparseable: true,
          reason:
            "Process substitution <(...) / >(...) in shell command cannot be safely analyzed under ATC.",
        };
      }
      if (REDIR_OPS.has(tok.op)) {
        const nextTok = parsed.tokens[idx + 1];
        if (nextTok && nextTok.type === "word" && nextTok.hasExpansion) {
          return {
            unparseable: true,
            reason:
              "Dynamic redirection target in shell command cannot be safely analyzed under ATC.",
          };
        }
        continue;
      }
      if (CMD_BOUNDARY_OPS.has(tok.op)) {
        atCommandHead = true;
        afterCommandOrBuiltin = false;
      }
      continue;
    }

    if (tok.type === "word") {
      const val = tok.value;
      if (atCommandHead) {
        if (CMD_BOUNDARY_WORDS.has(val)) {
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(val) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(val)) {
          continue;
        }
        if (val === "command" || val === "builtin") {
          afterCommandOrBuiltin = true;
          continue;
        }
        if (afterCommandOrBuiltin && val.startsWith("-")) {
          if (/[vV]/.test(val)) {
            atCommandHead = false;
            afterCommandOrBuiltin = false;
          }
          continue;
        }
        if (val === "eval" || val === "coproc" || val === "select") {
          return {
            unparseable: true,
            reason: `Shell "${val}" construct cannot be safely analyzed under ATC; run direct commands via "atc exec" or "atc batch".`,
          };
        }
        atCommandHead = false;
        afterCommandOrBuiltin = false;
      }
    }
  }

  return { unparseable: false, reason: null };
}

