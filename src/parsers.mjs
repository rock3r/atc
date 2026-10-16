// Config-file parsers used by build resource resolution: java.util.Properties (gradle.properties)
// and .bazelrc tokenization. ATC never parses or runs shell commands (see docs/scope.md).
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
export function splitRcWords(rawStr) {
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

