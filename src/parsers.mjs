import { parseArgs } from "node:util";

const LITERAL_SENTINEL = "\uE000";

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

/**
 * Joins backslash-continued lines in configuration files like .bazelrc.
 */
export function joinBackslashContinuations(content) {
  if (!content || typeof content !== "string") return [];
  const rawLines = content.split(/\r?\n/);
  const lines = [];
  let cur = "";
  for (const raw of rawLines) {
    const trimmedRight = raw.replace(/\s+$/, "");
    let bs = 0;
    for (let i = trimmedRight.length - 1; i >= 0 && trimmedRight[i] === "\\"; i--) {
      bs++;
    }
    if (bs % 2 === 1) {
      cur += trimmedRight.slice(0, -1) + " ";
    } else {
      cur += raw;
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
    if (ch === "\\" && i + 1 < s.length) {
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
