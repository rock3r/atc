import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectUnparseableShellConstructs,
  joinBackslashContinuations,
  parseEnvWrapperArgs,
  parseJavaProperties,
  parseScriptHeredocs,
  splitShellWords,
  stripOpaqueHeredocsForCheck,
} from "./parsers.mjs";

export function canonicalizeBuildPath(targetPath, options = {}) {
  const rawStr = String(targetPath || ".");
  const isWinPath = /^[a-zA-Z]:[\\/]/.test(rawStr) || rawStr.startsWith("\\\\");
  const isWin = (options?.platform || process.platform) === "win32" || isWinPath;
  const resolved =
    isWinPath && process.platform !== "win32"
      ? path.win32.resolve(rawStr)
      : !isWin && process.platform === "win32" && rawStr.startsWith("/")
        ? path.posix.resolve(rawStr)
        : path.resolve(rawStr);
  try {
    if (!isWin && process.platform === "win32" && rawStr.startsWith("/")) {
      return resolved;
    }
    const realpathFn = fs.realpathSync.native || fs.realpathSync;
    return realpathFn(resolved);
  } catch {
    return isWin ? resolved.toLowerCase() : resolved;
  }
}

const LITERAL_SENTINEL = "\uE000";

function stripLiteralSentinels(value) {
  return String(value || "").replaceAll(LITERAL_SENTINEL, "");
}

export function tokenizeShellClauseWithSpans(clause, options = {}) {
  const s = String(clause || "");
  const markLiterals = Boolean(options?.markLiterals);
  const tokens = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  const substStack = [];
  let hasToken = false;
  let tokStart = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (substStack.length > 0) {
      const top = substStack[substStack.length - 1];
      cur += ch;
      if (top.inSingle) {
        if (ch === "'") top.inSingle = false;
        continue;
      }
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[++i];
        continue;
      }
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
      if (top.type === "paren") {
        if (ch === "(") substStack.push({ type: "paren", inSingle: false, inDouble: false });
        else if (ch === ")") substStack.pop();
      } else if (top.type === "brace") {
        if (ch === "{") substStack.push({ type: "brace", inSingle: false, inDouble: false });
        else if (ch === "}") substStack.pop();
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else if (markLiterals && /[$`~*?\[%]/.test(ch)) {
        cur += LITERAL_SENTINEL + ch;
      } else {
        cur += ch;
      }
      continue;
    }
    if (inBacktick) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === "`") {
        inBacktick = false;
      }
      continue;
    }
    if (ch === "$" && i + 1 < s.length && (s[i + 1] === "(" || s[i + 1] === "{")) {
      if (!hasToken) tokStart = i;
      hasToken = true;
      cur += ch + s[i + 1];
      substStack.push({
        type: s[i + 1] === "(" ? "paren" : "brace",
        inSingle: false,
        inDouble: false,
      });
      i++;
      continue;
    }
    if (!inDouble && (ch === "<" || ch === ">") && i + 1 < s.length && s[i + 1] === "(") {
      if (!hasToken) tokStart = i;
      hasToken = true;
      cur += ch + s[i + 1];
      substStack.push({ type: "paren", inSingle: false, inDouble: false });
      i++;
      continue;
    }
    if (ch === "`") {
      if (!hasToken) tokStart = i;
      hasToken = true;
      inBacktick = true;
      cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && s[i + 1] === "\n") {
        i++;
      } else if (ch === "\\" && s[i + 1] === "\r" && s[i + 2] === "\n") {
        i += 2;
      } else if (
        ch === "\\" &&
        i + 1 < s.length &&
        (s[i + 1] === '"' || s[i + 1] === "\\" || s[i + 1] === "$" || s[i + 1] === "`")
      ) {
        const nextCh = s[i + 1];
        cur += markLiterals && /[$`~*?\[%]/.test(nextCh) ? LITERAL_SENTINEL + nextCh : nextCh;
        i++;
      } else if (markLiterals && /[~*?\[]/.test(ch)) {
        cur += LITERAL_SENTINEL + ch;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'") {
      if (!hasToken) tokStart = i;
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      if (!hasToken) tokStart = i;
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && s[i + 1] === "\n") {
      i++;
      continue;
    }
    if (ch === "\\" && s[i + 1] === "\r" && s[i + 2] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length && /\s|['"\\$`~*?\[]/.test(s[i + 1])) {
      if (!hasToken) tokStart = i;
      const nextCh = s[i + 1];
      cur += markLiterals && /[$`~*?\[%]/.test(nextCh) ? LITERAL_SENTINEL + nextCh : nextCh;
      hasToken = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || cur.length > 0) {
        tokens.push({ value: cur, start: tokStart, end: i });
        cur = "";
        hasToken = false;
        tokStart = -1;
      }
      continue;
    }
    if (!hasToken && ch === "#") {
      while (i < s.length && s[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (!hasToken) tokStart = i;
    cur += ch;
    hasToken = true;
  }
  if (hasToken || cur.length > 0) {
    tokens.push({ value: cur, start: tokStart, end: s.length });
  }
  return tokens;
}

export function tokenizeShellClause(clause, options = {}) {
  return tokenizeShellClauseWithSpans(clause, options).map((t) => t.value);
}

export function scanExecutableSubstitutions(text, { ignoreOuterSingleQuotes = false } = {}) {
  const s = String(text || "");
  const results = [];
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let topSub = null;
  const stack = [];

  const curCtx = () => (stack.length > 0 ? stack[stack.length - 1] : null);
  const isSingle = () => (curCtx() ? curCtx().inSingle : inSingle);
  const isDouble = () => (curCtx() ? curCtx().inDouble : inDouble);
  const setSingle = (v) => {
    if (curCtx()) curCtx().inSingle = v;
    else if (!ignoreOuterSingleQuotes) inSingle = v;
  };
  const setDouble = (v) => {
    if (curCtx()) curCtx().inDouble = v;
    else inDouble = v;
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
      if (ch === "`") {
        inBacktick = false;
        if (topSub && topSub.kind === "backtick" && stack.length === 0) {
          results.push({
            openStart: topSub.openStart,
            bodyStart: topSub.bodyStart,
            bodyEnd: i,
            closeEnd: i + 1,
            body: s.slice(topSub.bodyStart, i),
            kind: "backtick",
          });
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
        topSub = {
          openStart: i,
          bodyStart: i + 1,
          kind: "backtick",
        };
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
        topSub = {
          openStart: i,
          bodyStart: i + 2,
          kind: "paren",
          stackDepth: stack.length + 1,
        };
      }
      stack.push({
        type: isCmdSub ? "paren" : "brace",
        inSingle: false,
        inDouble: false,
      });
      i++;
      continue;
    }
    if (!isDouble() && (ch === "<" || ch === ">") && i + 1 < s.length && s[i + 1] === "(") {
      if (!topSub) {
        topSub = {
          openStart: i,
          bodyStart: i + 2,
          kind: "paren",
          stackDepth: stack.length + 1,
        };
      }
      stack.push({ type: "paren", inSingle: false, inDouble: false });
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
    if (stack.length > 0) {
      const top = curCtx();
      if (top.type === "paren" || top.type === "arith") {
        if (ch === "#" && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
          while (i + 1 < s.length && s[i + 1] !== "\n") {
            i++;
          }
          continue;
        }
        if (ch === "(") {
          stack.push({ type: "paren", inSingle: false, inDouble: false });
        } else if (ch === ")") {
          stack.pop();
          if (topSub && topSub.kind === "paren" && stack.length < topSub.stackDepth) {
            results.push({
              openStart: topSub.openStart,
              bodyStart: topSub.bodyStart,
              bodyEnd: i,
              closeEnd: i + 1,
              body: s.slice(topSub.bodyStart, i),
              kind: "paren",
            });
            topSub = null;
          }
        }
      } else if (top.type === "brace") {
        if (ch === "{") stack.push({ type: "brace", inSingle: false, inDouble: false });
        else if (ch === "}") stack.pop();
      }
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
      while (i + 1 < s.length && s[i + 1] !== "\n") {
        i++;
      }
      continue;
    }
  }
  return results;
}

function computeQuotedMask(s) {
  const mask = new Uint8Array(s.length);
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  const substStack = [];
  const pendingHeredocs = [];

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

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isSingle()) {
      mask[i] = 1;
      if (ch === "'") setSingle(false);
      continue;
    }
    if (inBacktick) {
      mask[i] = 1;
      if (ch === "\\" && i + 1 < s.length) {
        mask[i + 1] = 1;
        i++;
        continue;
      }
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      mask[i] = 1;
      mask[i + 1] = 1;
      i++;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      mask[i] = 1;
      continue;
    }
    if (ch === "$" && i + 1 < s.length && (s[i + 1] === "(" || s[i + 1] === "{")) {
      mask[i] = 1;
      mask[i + 1] = 1;
      substStack.push({
        type: s[i + 1] === "(" ? "paren" : "brace",
        inSingle: false,
        inDouble: false,
      });
      i++;
      continue;
    }
    if (!isDouble() && (ch === "<" || ch === ">") && i + 1 < s.length && s[i + 1] === "(") {
      mask[i] = 1;
      mask[i + 1] = 1;
      substStack.push({ type: "paren", inSingle: false, inDouble: false });
      i++;
      continue;
    }
    if (isDouble()) {
      mask[i] = 1;
      if (ch === '"') setDouble(false);
      continue;
    }
    if (ch === "'") {
      setSingle(true);
      mask[i] = 1;
      continue;
    }
    if (ch === '"') {
      setDouble(true);
      mask[i] = 1;
      continue;
    }
    if (substStack.length > 0) {
      mask[i] = 1;
      const top = curCtx();
      if (top.type === "paren") {
        if (ch === "#" && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
          while (i + 1 < s.length && s[i + 1] !== "\n") {
            i++;
            mask[i] = 1;
          }
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
    if (ch === "\n" && pendingHeredocs.length > 0) {
      mask[i] = 3;
      let cursor = i + 1;
      while (pendingHeredocs.length > 0 && cursor <= s.length) {
        const { delim, stripTabs, quoted } = pendingHeredocs.shift();
        while (cursor <= s.length) {
          let lineEnd = s.indexOf("\n", cursor);
          if (lineEnd === -1) lineEnd = s.length;
          let lineText = s.slice(cursor, lineEnd);
          if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
          if (!quoted) {
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
          const cmpText = stripTabs ? lineText.replace(/^\t+/, "") : lineText;
          for (let k = cursor; k < lineEnd; k++) {
            mask[k] = 3;
          }
          if (cmpText === delim) {
            if (lineEnd < s.length && pendingHeredocs.length > 0) {
              mask[lineEnd] = 3;
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
          mask[lineEnd] = 3;
          cursor = lineEnd + 1;
        }
      }
      i = cursor - 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(s[i - 1]))) {
      mask[i] = 2;
      while (i + 1 < s.length && s[i + 1] !== "\n") {
        i++;
        mask[i] = 2;
      }
      continue;
    }
    if (s[i - 1] !== "<" && ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      let k = i + 2;
      const stripTabs = s[k] === "-";
      if (stripTabs) k++;
      while (k < s.length && (s[k] === " " || s[k] === "\t")) {
        k++;
      }
      let delim = "";
      const delimStart = k;
      let dSingle = false;
      let dDouble = false;
      let quoted = false;
      while (k < s.length) {
        const c = s[k];
        if (dSingle) {
          mask[k] = 1;
          if (c === "'") dSingle = false;
          else delim += c;
          k++;
          continue;
        }
        if (dDouble) {
          mask[k] = 1;
          if (c === '"') {
            dDouble = false;
          } else if (
            c === "\\" &&
            k + 1 < s.length &&
            (s[k + 1] === '"' || s[k + 1] === "\\" || s[k + 1] === "$" || s[k + 1] === "`")
          ) {
            mask[k + 1] = 1;
            delim += s[k + 1];
            k += 2;
            continue;
          } else {
            delim += c;
          }
          k++;
          continue;
        }
        if (c === "'") {
          mask[k] = 1;
          dSingle = true;
          quoted = true;
          k++;
          continue;
        }
        if (c === '"') {
          mask[k] = 1;
          dDouble = true;
          quoted = true;
          k++;
          continue;
        }
        if (c === "\\" && s[k + 1] === "\n") {
          mask[k] = 1;
          mask[k + 1] = 1;
          k += 2;
          continue;
        }
        if (c === "\\" && s[k + 1] === "\r" && s[k + 2] === "\n") {
          mask[k] = 1;
          mask[k + 1] = 1;
          mask[k + 2] = 1;
          k += 3;
          continue;
        }
        if (c === "\\" && k + 1 < s.length && s[k + 1] !== "\n") {
          mask[k] = 1;
          mask[k + 1] = 1;
          quoted = true;
          delim += s[k + 1];
          k += 2;
          continue;
        }
        if (/[\s;&|()<>]/.test(c)) {
          break;
        }
        delim += c;
        k++;
      }
      if (delim.length > 0 && k > delimStart) {
        pendingHeredocs.push({ delim, stripTabs, quoted });
        i = k - 1;
        continue;
      }
    }
  }
  return mask;
}

export function splitShellClauseRedirAndGroup(part) {
  const s = String(part || "");
  const fullMask = computeQuotedMask(s);
  let wsPos = s.length;
  while (wsPos > 0 && /\s/.test(s[wsPos - 1]) && fullMask[wsPos - 1] === 0) {
    wsPos--;
  }
  const trailingWs = s.slice(wsPos);
  let coreEnd = s.slice(0, wsPos);
  let suffix = "";
  let closedSubshells = 0;
  let closedBraces = 0;

  const hdStart = fullMask.subarray(0, coreEnd.length).indexOf(3);
  if (hdStart !== -1) {
    suffix = coreEnd.slice(hdStart) + suffix;
    coreEnd = coreEnd.slice(0, hdStart);
  }

  const commentStart = fullMask.subarray(0, coreEnd.length).indexOf(2);
  if (commentStart !== -1) {
    let wsBeforeComment = commentStart;
    while (
      wsBeforeComment > 0 &&
      /\s/.test(coreEnd[wsBeforeComment - 1]) &&
      fullMask[wsBeforeComment - 1] === 0
    ) {
      wsBeforeComment--;
    }
    suffix = coreEnd.slice(wsBeforeComment) + suffix;
    coreEnd = coreEnd.slice(0, wsBeforeComment);
  }

  while (coreEnd.length > 0) {
    const mask = computeQuotedMask(coreEnd);
    const rMatch = coreEnd.match(
      /(\s+(?:[0-9]*>>?\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)|[0-9]*<<-?\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\\S+|\S+)|2>&1))$/,
    );
    if (rMatch) {
      const matchStart = coreEnd.length - rMatch[1].length;
      const opRel = rMatch[1].search(/[<>]/);
      if (opRel !== -1 && mask[matchStart + opRel] === 0) {
        suffix = rMatch[1] + suffix;
        coreEnd = coreEnd.slice(0, matchStart);
        continue;
      }
    }
    const gMatch = coreEnd.match(/(\s*[)}]+)$/);
    if (gMatch) {
      let stripPos = coreEnd.length;
      let parens = 0;
      let braces = 0;
      while (stripPos > 0) {
        let p = stripPos - 1;
        while (p >= 0 && /\s/.test(coreEnd[p]) && mask[p] === 0) {
          p--;
        }
        if (p >= 0 && (coreEnd[p] === ")" || coreEnd[p] === "}") && mask[p] === 0) {
          if (coreEnd[p] === ")") {
            let q = p - 1;
            while (q >= 0 && /\s/.test(coreEnd[q]) && mask[q] === 0) {
              q--;
            }
            if (q >= 0 && coreEnd[q] === "(" && mask[q] === 0) {
              break;
            }
            parens++;
          } else {
            braces++;
          }
          stripPos = p;
          while (stripPos > 0 && /\s/.test(coreEnd[stripPos - 1]) && mask[stripPos - 1] === 0) {
            stripPos--;
          }
          continue;
        }
        break;
      }
      if (parens + braces > 0) {
        closedSubshells += parens;
        closedBraces += braces;
        suffix = coreEnd.slice(stripPos) + suffix;
        coreEnd = coreEnd.slice(0, stripPos);
        continue;
      }
    }
    break;
  }

  let leadPos = 0;
  while (leadPos < coreEnd.length && /\s/.test(coreEnd[leadPos])) {
    leadPos++;
  }
  let leadingCore = coreEnd.slice(leadPos);
  let openedSubshells = 0;
  let openedBraces = 0;
  const leadingKeywords = [];
  const forLoopVars = [];
  const functionNames = [];
  let functionOpenChar = null;
  let functionBodyStartOffset = -1;
  let hasCasePattern = false;
  while (leadingCore.length > 0) {
    if (/^[({]/.test(leadingCore)) {
      if (leadingCore.startsWith("(")) {
        const leadMask = computeQuotedMask(leadingCore);
        let closeParenBeforeWs = -1;
        for (let i = 1; i < leadingCore.length; i++) {
          if (leadMask[i] === 0 && /\s/.test(leadingCore[i])) break;
          if (leadMask[i] === 0 && leadingCore[i] === ")") {
            closeParenBeforeWs = i;
            break;
          }
        }
        if (closeParenBeforeWs > 1) {
          hasCasePattern = true;
          leadPos += closeParenBeforeWs + 1;
          while (leadPos < coreEnd.length && /\s/.test(coreEnd[leadPos])) leadPos++;
          leadingCore = coreEnd.slice(leadPos);
          continue;
        }
        openedSubshells++;
      } else {
        openedBraces++;
      }
      leadPos += 1;
      while (leadPos < coreEnd.length && /\s/.test(coreEnd[leadPos])) leadPos++;
      leadingCore = coreEnd.slice(leadPos);
      continue;
    }
    const kwMatch = leadingCore.match(
      /^(?:(then|else|do|if|elif|while|until|fi|done|esac|!)(?=\s|[({]|$)|(for\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+in\b[^;\n]*)?)(?=\s|[({]|$)|(case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in)(?=\s|[({]|$)|((?:function\s+([A-Za-z_][A-Za-z0-9_.-]*)(?:\s*\(\s*\))?|([A-Za-z_][A-Za-z0-9_.-]*)\s*\(\s*\)))(?=\s|[({]|$))/,
    );
    if (kwMatch) {
      const kw = (
        kwMatch[1] ||
        (kwMatch[2] ? "for" : kwMatch[4] ? "case" : "function")
      ).toLowerCase();
      if (kw !== "!") {
        leadingKeywords.push(kw);
      }
      if (kwMatch[3]) {
        forLoopVars.push(kwMatch[3]);
      }
      leadPos += kwMatch[0].length;
      while (leadPos < coreEnd.length && /\s/.test(coreEnd[leadPos])) leadPos++;
      if (kwMatch[6] || kwMatch[7]) {
        functionNames.push(kwMatch[6] || kwMatch[7]);
        if (coreEnd[leadPos] === "{" || coreEnd[leadPos] === "(") {
          functionOpenChar = coreEnd[leadPos];
          functionBodyStartOffset = leadPos + 1;
          leadingCore = coreEnd.slice(leadPos);
          break;
        }
      }
      leadingCore = coreEnd.slice(leadPos);
      continue;
    }
    const leadMask = computeQuotedMask(leadingCore);
    let closeParenIdx = -1;
    for (let i = 0; i < leadingCore.length; i++) {
      if (leadMask[i] === 0 && /\s/.test(leadingCore[i])) break;
      if (leadMask[i] === 0 && leadingCore[i] === ")") {
        closeParenIdx = i;
        break;
      }
    }
    if (closeParenIdx > 0) {
      hasCasePattern = true;
      leadPos += closeParenIdx + 1;
      while (leadPos < coreEnd.length && /\s/.test(coreEnd[leadPos])) leadPos++;
      leadingCore = coreEnd.slice(leadPos);
      continue;
    }
    break;
  }

  return {
    corePart: coreEnd,
    strippedClause: leadingCore.trim(),
    redirSuffix: suffix,
    trailingWs,
    openedSubshells,
    closedSubshells,
    openedBraces,
    closedBraces,
    leadingKeywords,
    forLoopVars,
    functionNames,
    functionOpenChar,
    functionBodyStartOffset,
    hasCasePattern,
  };
}

export function extractShellFunctionSpan(rawParts, startPartIdx, splitInfo = null) {
  const info = splitInfo || splitShellClauseRedirAndGroup(rawParts[startPartIdx]);
  if (!info.functionNames || info.functionNames.length === 0) return null;
  const fnName = info.functionNames[info.functionNames.length - 1];
  let openChar = info.functionOpenChar;
  let bodyStartPartIdx = startPartIdx;
  let bodyStartOffset = info.functionBodyStartOffset;
  if (!openChar) {
    for (let p = startPartIdx + 2; p < rawParts.length; p += 2) {
      const t = String(rawParts[p] || "");
      const m = t.match(/^\s*([({])/);
      if (m) {
        openChar = m[1];
        bodyStartPartIdx = p;
        bodyStartOffset = m[0].length;
        break;
      }
      if (t.trim().length > 0) break;
    }
  }
  if (!openChar || bodyStartOffset < 0) return null;
  const closeChar = openChar === "{" ? "}" : ")";
  let depth = 1;
  for (let p = bodyStartPartIdx; p < rawParts.length; p += 2) {
    const partStr = String(rawParts[p] || "");
    const mask = computeQuotedMask(partStr);
    const startI = p === bodyStartPartIdx ? bodyStartOffset : 0;
    for (let i = startI; i < partStr.length; i++) {
      if (mask[i] !== 0) continue;
      if (partStr[i] === openChar) {
        depth++;
      } else if (partStr[i] === closeChar) {
        depth--;
        if (depth === 0) {
          const bodyScript =
            bodyStartPartIdx === p
              ? partStr.slice(bodyStartOffset, i)
              : rawParts[bodyStartPartIdx].slice(bodyStartOffset) +
                rawParts.slice(bodyStartPartIdx + 1, p).join("") +
                partStr.slice(0, i);
          const trailingInfo = splitShellClauseRedirAndGroup(partStr.slice(i + 1));
          return {
            name: fnName,
            names: [...info.functionNames],
            startPartIdx,
            bodyStartPartIdx,
            bodyStartOffset,
            endPartIdx: p,
            bodyEndOffset: i,
            bodyScript,
            isSubshellFn: openChar === "(",
            trailingClosedSubshells: trailingInfo.closedSubshells || 0,
            trailingClosedBraces: trailingInfo.closedBraces || 0,
          };
        }
      }
    }
  }
  return null;
}

export function splitShellScriptParts(script) {
  const s = String(script || "");
  const mask = computeQuotedMask(s);
  const parts = [];
  let cur = "";

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (mask[i] !== 0) {
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      parts.push(cur, ch);
      cur = "";
      continue;
    }
    if (ch === "&") {
      if (s[i + 1] === "&" && mask[i + 1] === 0) {
        parts.push(cur, "&&");
        cur = "";
        i++;
        continue;
      }
      if (s[i + 1] !== ">" && (i === 0 || s[i - 1] !== ">")) {
        parts.push(cur, "&");
        cur = "";
        continue;
      }
    }
    if (ch === "|") {
      if (s[i + 1] === "|" && mask[i + 1] === 0) {
        parts.push(cur, "||");
        cur = "";
        i++;
      } else {
        parts.push(cur, "|");
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function expandOrValidateShellPath(rawPath, envMap = process.env, options = {}) {
  let p = String(rawPath || "");
  if (!p) return { resolved: "", unresolved: false };
  const taintedVars = options?.taintedVars || envMap?.__taintedVars || null;
  const shellType = options?.shellType || "posix";
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    if (taintedVars?.has("*") || taintedVars?.has("HOME") || taintedVars?.has("USERPROFILE")) {
      return { resolved: null, unresolved: true };
    }
    const home = envMap?.HOME || envMap?.USERPROFILE || os.homedir();
    if (!home) return { resolved: null, unresolved: true };
    p = p === "~" ? home : path.join(home, p.slice(2));
  } else if (p.startsWith("~")) {
    return { resolved: null, unresolved: true };
  }
  if (
    /(?<!\uE000)`/.test(p) ||
    /(?<!\uE000)\$\(/.test(p) ||
    /(?<!\uE000)[*?\[]/.test(p)
  ) {
    return { resolved: null, unresolved: true };
  }
  if (/(?<!\uE000)\$/.test(p)) {
    let unresolved = false;
    p = p.replace(
      /(?<!\uE000)\$(?:\{(?:env:)?([^}]*)\}|(?:env:)?([A-Za-z_][A-Za-z0-9_]*|[1-9]))/gi,
      (_m, braced, plain) => {
        if (braced !== undefined && !/^(?:[A-Za-z_][A-Za-z0-9_]*|[1-9])$/.test(braced)) {
          const paramMatch =
            shellType !== "cmd"
              ? braced.match(/^([A-Za-z_][A-Za-z0-9_]*|[1-9])(:-|-(?!-)|:\+|\+)(.*)$/)
              : null;
          if (!paramMatch) {
            unresolved = true;
            return "";
          }
          const [, pVar, op, fallbackRaw] = paramMatch;
          if (
            taintedVars?.has("*") ||
            taintedVars?.has(pVar) ||
            taintedVars?.has(pVar.toUpperCase())
          ) {
            unresolved = true;
            return "";
          }
          const rawVal = envMap?.[pVar] ?? envMap?.[pVar.toUpperCase()];
          const isSet = rawVal !== undefined && rawVal !== null;
          const isNonEmpty = isSet && String(rawVal) !== "";
          if (op === ":-" || op === "-") {
            if (op === ":-" ? isNonEmpty : isSet) {
              return String(rawVal);
            }
            const fb = expandOrValidateShellPath(fallbackRaw, envMap, options);
            if (fb.unresolved || !fb.resolved) {
              unresolved = true;
              return "";
            }
            return fb.resolved;
          }
          if (op === ":+" ? isNonEmpty : isSet) {
            const fb = expandOrValidateShellPath(fallbackRaw, envMap, options);
            if (fb.unresolved) {
              unresolved = true;
              return "";
            }
            return fb.resolved;
          }
          return "";
        }
        const varName = braced !== undefined ? braced : plain;
        if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[1-9])$/.test(varName)) {
          unresolved = true;
          return "";
        }
        if (
          taintedVars?.has("*") ||
          taintedVars?.has(varName) ||
          taintedVars?.has(varName.toUpperCase())
        ) {
          unresolved = true;
          return "";
        }
        const val = envMap?.[varName] ?? envMap?.[varName.toUpperCase()];
        if (val === undefined || val === null || String(val) === "") {
          unresolved = true;
          return "";
        }
        return String(val);
      },
    );
    if (unresolved || /(?<!\uE000)\$/.test(p)) {
      return { resolved: null, unresolved: true };
    }
  }
  if (shellType === "cmd" && /(?<!\uE000)%/.test(p)) {
    let unresolved = false;
    p = p.replace(/(?<!\uE000)%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, varName) => {
      if (
        taintedVars?.has("*") ||
        taintedVars?.has(varName) ||
        taintedVars?.has(varName.toUpperCase())
      ) {
        unresolved = true;
        return "";
      }
      const val = envMap?.[varName] ?? envMap?.[varName.toUpperCase()];
      if (val === undefined || val === null || String(val) === "") {
        unresolved = true;
        return "";
      }
      return String(val);
    });
    if (unresolved || /(?<!\uE000)%/.test(p)) {
      return { resolved: null, unresolved: true };
    }
  }
  return { resolved: stripLiteralSentinels(p), unresolved: false };
}

export function expandShellBuildClausePaths(cmd, args = [], envMap = process.env, options = {}) {
  let nextCmd = String(cmd || "");
  if (
    nextCmd.includes("/") ||
    nextCmd.includes("\\") ||
    nextCmd.includes("$") ||
    nextCmd.startsWith("~") ||
    nextCmd.includes("%") ||
    nextCmd.includes(LITERAL_SENTINEL)
  ) {
    const expCmd = expandOrValidateShellPath(nextCmd, envMap, options);
    if (expCmd.unresolved) {
      return {
        cmd: stripLiteralSentinels(nextCmd),
        args: Array.isArray(args) ? args.map(stripLiteralSentinels) : [],
        unresolved: true,
      };
    }
    nextCmd = expCmd.resolved;
  }
  const tool = normalizeBuildToolName(nextCmd);
  const nextArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (!tool) {
    return {
      cmd: stripLiteralSentinels(nextCmd),
      args: nextArgs.map(stripLiteralSentinels),
      unresolved: false,
    };
  }
  const expandArgVal = (rawVal) => expandOrValidateShellPath(rawVal, envMap, options);

  if (tool === "gradle") {
    const gradlePathFlags = new Set([
      "-p",
      "--project-dir",
      "-c",
      "--settings-file",
      "-b",
      "--build-file",
      "-g",
      "--gradle-user-home",
    ]);
    const gradleEqPrefixes = [
      "--project-dir=",
      "-p=",
      "--settings-file=",
      "-c=",
      "--build-file=",
      "-b=",
      "--gradle-user-home=",
      "-g=",
    ];
    for (let i = 0; i < nextArgs.length; i++) {
      const a = nextArgs[i];
      if (a === "--") break;
      if (gradlePathFlags.has(a) && i + 1 < nextArgs.length) {
        const exp = expandArgVal(nextArgs[i + 1]);
        if (exp.unresolved) {
          return {
            cmd: stripLiteralSentinels(nextCmd),
            args: nextArgs.map(stripLiteralSentinels),
            unresolved: true,
          };
        }
        nextArgs[i + 1] = exp.resolved;
        i++;
        continue;
      }
      const eqPrefix = gradleEqPrefixes.find((p) => a.startsWith(p) && a.length > p.length);
      if (eqPrefix) {
        const exp = expandArgVal(a.slice(eqPrefix.length));
        if (exp.unresolved) {
          return {
            cmd: stripLiteralSentinels(nextCmd),
            args: nextArgs.map(stripLiteralSentinels),
            unresolved: true,
          };
        }
        nextArgs[i] = `${eqPrefix}${exp.resolved}`;
      }
    }
  } else if (tool === "bazel") {
    const bazelPathFlags = new Set(["--output_base", "--output_user_root"]);
    const bazelEqPrefixes = ["--output_base=", "--output_user_root="];
    for (let i = 0; i < nextArgs.length; i++) {
      const a = nextArgs[i];
      if (bazelPathFlags.has(a) && i + 1 < nextArgs.length) {
        const exp = expandArgVal(nextArgs[i + 1]);
        if (exp.unresolved) {
          return {
            cmd: stripLiteralSentinels(nextCmd),
            args: nextArgs.map(stripLiteralSentinels),
            unresolved: true,
          };
        }
        nextArgs[i + 1] = exp.resolved;
        i++;
        continue;
      }
      const eqPrefix = bazelEqPrefixes.find((p) => a.startsWith(p));
      if (eqPrefix) {
        const exp = expandArgVal(a.slice(eqPrefix.length));
        if (exp.unresolved) {
          return {
            cmd: stripLiteralSentinels(nextCmd),
            args: nextArgs.map(stripLiteralSentinels),
            unresolved: true,
          };
        }
        nextArgs[i] = `${eqPrefix}${exp.resolved}`;
        continue;
      }
      if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith("-") && BAZEL_SUBCOMMANDS.has(a.toLowerCase())) {
        break;
      }
    }
  } else if (tool === "xcodebuild") {
    const xcodePathFlags = new Set(["-workspace", "-project", "-derivedDataPath"]);
    const xcodeEqPrefixes = ["-workspace=", "-project=", "-derivedDataPath="];
    for (let i = 0; i < nextArgs.length; i++) {
      const a = nextArgs[i];
      if (xcodePathFlags.has(a) && i + 1 < nextArgs.length) {
        const exp = expandArgVal(nextArgs[i + 1]);
        if (exp.unresolved) {
          return {
            cmd: stripLiteralSentinels(nextCmd),
            args: nextArgs.map(stripLiteralSentinels),
            unresolved: true,
          };
        }
        nextArgs[i + 1] = exp.resolved;
        i++;
        continue;
      }
      const eqPrefix = xcodeEqPrefixes.find((p) => a.startsWith(p));
      if (eqPrefix) {
        const exp = expandArgVal(a.slice(eqPrefix.length));
        if (exp.unresolved) {
          return {
            cmd: stripLiteralSentinels(nextCmd),
            args: nextArgs.map(stripLiteralSentinels),
            unresolved: true,
          };
        }
        nextArgs[i] = `${eqPrefix}${exp.resolved}`;
      }
    }
  }
  return {
    cmd: stripLiteralSentinels(nextCmd),
    args: nextArgs.map(stripLiteralSentinels),
    unresolved: false,
  };
}

export function peelBuildWrapperTokens(cmd, args = [], options = {}) {
  let curCmd = String(cmd || "");
  let curArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  let relCwd = null;
  let unresolvedDynamicCwd = false;
  const baseEnv = options?.env || process.env;
  const baseCwd = options?.cwd || process.cwd();
  const inShell = Boolean(options?.inShell);
  const incomingTaintedVars =
    options?.taintedVars instanceof Set ? new Set(options.taintedVars) : new Set();
  const incomingShellType = options?.shellType || "posix";
  const envVars = {};
  let clearedInheritedEnv = false;

  for (let depth = 0; depth < 16; depth++) {
    const cleaned = stripLiteralSentinels(curCmd).trim().replace(/^@+/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*\+=?/.test(cleaned) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned)) {
      const eqIdx = cleaned.indexOf("=");
      const isAppend = eqIdx > 0 && cleaned[eqIdx - 1] === "+";
      const rawKey = cleaned.slice(0, isAppend ? eqIdx - 1 : eqIdx);
      const rawVal = curCmd.slice(curCmd.indexOf("=") + 1);
      if (inShell) {
        const expVal = expandOrValidateShellPath(rawVal, baseEnv, {
          taintedVars: incomingTaintedVars,
          shellType: incomingShellType,
        });
        const prevTainted =
          isAppend && (incomingTaintedVars.has("*") || incomingTaintedVars.has(rawKey));
        const prevVal = isAppend ? String(envVars[rawKey] ?? baseEnv?.[rawKey] ?? "") : "";
        envVars[rawKey] =
          expVal.unresolved || prevTainted
            ? "__UNRESOLVED_DYNAMIC_ENV__"
            : isAppend
              ? prevVal + expVal.resolved
              : expVal.resolved;
      } else {
        const prevVal = isAppend ? String(envVars[rawKey] ?? baseEnv?.[rawKey] ?? "") : "";
        envVars[rawKey] = isAppend
          ? prevVal + stripLiteralSentinels(rawVal)
          : stripLiteralSentinels(rawVal);
      }
      if (curArgs.length === 0) {
        curCmd = "";
        break;
      }
      curCmd = curArgs[0];
      curArgs = curArgs.slice(1);
      continue;
    }
    const base = (cleaned.split(/[\\/]/).pop() || "")
      .toLowerCase()
      .replace(/\.(exe|cmd|bat|com|sh)$/i, "");

    if (
      base === "then" ||
      base === "else" ||
      base === "do" ||
      base === "if" ||
      base === "elif" ||
      base === "while" ||
      base === "until" ||
      cleaned === "!"
    ) {
      if (curArgs.length === 0) {
        curCmd = "";
        break;
      }
      curCmd = curArgs[0];
      curArgs = curArgs.slice(1);
      continue;
    }
    if (base === "build-brief" || base === "time" || base === "nohup") {
      let i = 0;
      if (base === "time") {
        while (i < curArgs.length) {
          const a = curArgs[i];
          if (a === "--") {
            i += 1;
            break;
          }
          if (
            (a === "-f" || a === "--format" || a === "-o" || a === "--output") &&
            i + 1 < curArgs.length
          ) {
            i += 2;
            continue;
          }
          if (a.startsWith("-")) {
            i += 1;
            continue;
          }
          break;
        }
      } else if (base === "nohup" && curArgs[0] === "--") {
        i = 1;
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "xcrun") {
      let i = 0;
      let queryMode = false;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i += 1;
          break;
        }
        if (a === "-f" || a === "--find" || a === "--show-sdk-path" || a === "--show-sdk-version") {
          queryMode = true;
          break;
        }
        if ((a === "-sdk" || a === "--sdk" || a === "-toolchain" || a === "--toolchain") && i + 1 < curArgs.length) {
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (queryMode || i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "nice") {
      let i = 0;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i += 1;
          break;
        }
        if ((a === "-n" || a === "--adjustment") && i + 1 < curArgs.length) {
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "timeout") {
      let i = 0;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if (
          (a === "-k" || a === "--kill-after" || a === "-s" || a === "--signal") &&
          i + 1 < curArgs.length
        ) {
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < curArgs.length && /^\d+(?:\.\d+)?[smhd]?$/.test(curArgs[i])) {
        i += 1;
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "env") {
      const parsedEnv = parseEnvWrapperArgs(curArgs);
      if (parsedEnv.unknownOption) {
        unresolvedDynamicCwd = true;
        break;
      }
      const envEntryCwd = relCwd;
      const envEntryUnresolved = unresolvedDynamicCwd;
      for (const act of parsedEnv.actions) {
        if (act.type === "ignore_env") {
          for (const k of Object.keys(envVars)) {
            delete envVars[k];
          }
          clearedInheritedEnv = true;
          envVars.JAVA_HOME = null;
          envVars.PATH = null;
          envVars.GRADLE_USER_HOME = null;
          envVars.GRADLE_HOME = null;
          envVars.GRADLE_OPTS = null;
          envVars.JAVA_OPTS = null;
          envVars._JAVA_OPTIONS = null;
          envVars.JAVA_TOOL_OPTIONS = null;
          envVars.USE_BAZEL_VERSION = null;
          envVars.HOME = null;
          envVars.USERPROFILE = null;
          envVars.TEST_TMPDIR = null;
          envVars.XDG_CACHE_HOME = null;
          envVars.USER = null;
          envVars.LOGNAME = null;
          envVars.USERNAME = null;
          envVars.BAZELRC = null;
          envVars.LC_ALL = null;
          envVars.LC_MESSAGES = null;
          envVars.LANG = null;
        } else if (act.type === "chdir") {
          const rawNextDir = act.rawDir;
          const exp = inShell
            ? expandOrValidateShellPath(rawNextDir, baseEnv, {
                taintedVars: incomingTaintedVars,
                shellType: incomingShellType,
              })
            : { resolved: stripLiteralSentinels(rawNextDir), unresolved: false };
          if (exp.unresolved) {
            unresolvedDynamicCwd = true;
          } else {
            const nextDir = exp.resolved;
            if (path.isAbsolute(nextDir)) {
              relCwd = nextDir;
              unresolvedDynamicCwd = false;
            } else {
              relCwd = envEntryCwd ? path.join(envEntryCwd, nextDir) : nextDir;
              unresolvedDynamicCwd = envEntryUnresolved;
            }
          }
        } else if (act.type === "unset") {
          envVars[act.key] = null;
        } else if (act.type === "assign") {
          if (inShell) {
            const expVal = expandOrValidateShellPath(act.rawVal, baseEnv, {
              taintedVars: incomingTaintedVars,
              shellType: incomingShellType,
            });
            envVars[act.key] = expVal.unresolved ? "__UNRESOLVED_DYNAMIC_ENV__" : expVal.resolved;
          } else {
            envVars[act.key] = stripLiteralSentinels(act.rawVal);
          }
        }
      }
      if (parsedEnv.cmdIndex >= curArgs.length) break;
      curCmd = curArgs[parsedEnv.cmdIndex];
      curArgs = curArgs.slice(parsedEnv.cmdIndex + 1);
      continue;
    }
    if (base === "builtin") {
      let i = 0;
      if (curArgs[0] === "--") i = 1;
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "command") {
      let i = 0;
      let queryMode = false;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if (a.startsWith("-") && /[vV]/.test(a)) {
          queryMode = true;
          break;
        }
        if (a.startsWith("-")) {
          i++;
          continue;
        }
        break;
      }
      if (queryMode || i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (base === "exec") {
      let i = 0;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if (a === "-a" && i + 1 < curArgs.length) {
          i += 2;
          continue;
        }
        if (a.startsWith("-")) {
          i++;
          continue;
        }
        break;
      }
      if (i >= curArgs.length) break;
      curCmd = curArgs[i];
      curArgs = curArgs.slice(i + 1);
      continue;
    }
    if (
      base === "sh" ||
      base === "bash" ||
      base === "zsh" ||
      base === "dash" ||
      base === "ksh" ||
      base === "cmd" ||
      base === "powershell" ||
      base === "pwsh"
    ) {
      const cIdx = curArgs.findIndex((a) => {
        if (base === "cmd") return /^\/[ck]$/i.test(a);
        if (base === "powershell" || base === "pwsh") return /^-(?:c|command)$/i.test(a);
        return a === "-c" || (/^-[A-Za-z]+$/.test(a) && a.includes("c"));
      });
      let hereStrRaw = null;
      if (
        cIdx === -1 &&
        inShell &&
        (base === "sh" || base === "bash" || base === "zsh" || base === "dash" || base === "ksh")
      ) {
        for (let hi = 0; hi < curArgs.length; hi++) {
          const cleanArg = stripLiteralSentinels(curArgs[hi]);
          if (/^[0-9]*<<<$/.test(cleanArg) && hi + 1 < curArgs.length) {
            hereStrRaw = String(curArgs[hi + 1] || "");
            break;
          }
          if (/^[0-9]*<<<[\s\S]+$/.test(cleanArg)) {
            const prefixLen = curArgs[hi].indexOf("<<<") + 3;
            hereStrRaw = String(curArgs[hi].slice(prefixLen) || "");
            break;
          }
        }
      }
      if ((cIdx !== -1 && cIdx + 1 < curArgs.length) || hereStrRaw !== null) {
        const rawScriptArg = stripLiteralSentinels(
          hereStrRaw !== null
            ? hereStrRaw
            : (base === "cmd" || base === "powershell" || base === "pwsh") &&
                curArgs.length > cIdx + 2
              ? curArgs.slice(cIdx + 1).join(" ")
              : String(curArgs[cIdx + 1] || ""),
        );
        const script = rawScriptArg.trim();
        const isAmpersandBackground = base !== "cmd";
        const matchedClauses = [];
        const shellType = base === "cmd" ? "cmd" : "posix";
        let curShellRelCwd = relCwd;
        let curShellUnresolvedCwd = unresolvedDynamicCwd;
        let shellEnv = clearedInheritedEnv ? { ...envVars } : { ...baseEnv, ...envVars };
        let curShellEnvVars = { ...envVars };
        let taintedEnvVars = new Set(incomingTaintedVars);
        let fnDefs = new Map(options?.fnDefs instanceof Map ? options.fnDefs : []);
        const activeFnCalls = new Set(options?.activeFnCalls instanceof Set ? options.activeFnCalls : []);
        const candidateBuildToolEnv = { ...(options?.candidateBuildToolEnv || {}) };
        for (const [ek, ev] of Object.entries(shellEnv)) {
          if (typeof ev === "string" && normalizeBuildToolName(ev)) {
            candidateBuildToolEnv[ek] = ev;
          }
        }
        let braceDepth = 0;
        let pushdStack = [];
        const cwdStack = [];
        const controlStack = [];
        const fnCallStack = [];
        let chainHasCondition = false;
        let chainSawOrOrPipe = false;
        let chainMutatedCwd = false;
        let chainAnyCwdMutation = false;
        let chainMutatedEnv = new Set();
        let chainAnyEnvMutation = new Set();
        let currentClauseBackgrounded = false;
        let outerChainConditional = false;
        let hasUnresolvedCmd = false;
        const registerLocalVar = (varName) => {
          if (fnCallStack.length === 0 || !varName) return;
          const topFnCall = fnCallStack[fnCallStack.length - 1];
          const cleanName = stripLiteralSentinels(varName);
          const normKeys =
            shellType === "cmd" || base === "powershell" || base === "pwsh"
              ? [cleanName, cleanName.toUpperCase(), cleanName.toLowerCase()]
              : [cleanName];
          for (const k of normKeys) {
            topFnCall.localVars.add(k);
            if (!topFnCall.savedState.has(k)) {
              topFnCall.savedState.set(k, {
                hasEnv: k in shellEnv,
                envVal: shellEnv[k],
                hasCurVar: k in curShellEnvVars,
                curVarVal: curShellEnvVars[k],
                tainted: taintedEnvVars.has(k),
                hasCand: k in candidateBuildToolEnv,
                candVal: candidateBuildToolEnv[k],
                inChainMutated: chainMutatedEnv.has(k),
                inChainAny: chainAnyEnvMutation.has(k),
              });
            }
          }
        };
        const captureChainEntryState = () => ({
          cwd: curShellRelCwd,
          unresolvedCwd: curShellUnresolvedCwd,
          pushdStack: [...pushdStack],
          shellEnv: { ...shellEnv },
          envVars: { ...curShellEnvVars },
          taintedEnvVars: new Set(taintedEnvVars),
        });
        let chainEntryState = captureChainEntryState();

        const findTopControlFrame = (types = null) => {
          for (let i = controlStack.length - 1; i >= 0; i--) {
            const f = controlStack[i];
            if (f.subshellDepth !== cwdStack.length) continue;
            if (!types || types.includes(f.type)) return { frame: f, index: i };
          }
          return null;
        };

        const expandInShell = (val, envObj = shellEnv) =>
          expandOrValidateShellPath(val, envObj, {
            taintedVars: taintedEnvVars,
            shellType,
          });

        const recordCwdMutation = ({
          isAbsoluteTarget = false,
          hasCasePattern = false,
          dirVerified = true,
        } = {}) => {
          chainAnyCwdMutation = true;
          if (chainHasCondition || outerChainConditional || !dirVerified) {
            chainMutatedCwd = true;
          }
          const inCaseBlock = Boolean(findTopControlFrame(["case"]));
          if (
            chainSawOrOrPipe ||
            (hasCasePattern && !inCaseBlock)
          ) {
            curShellUnresolvedCwd = true;
          }
          if (!currentClauseBackgrounded) {
            for (const frame of controlStack) {
              if (frame.subshellDepth === cwdStack.length) {
                frame.mutatedCwd = true;
                if (frame.phase === "cond") {
                  frame.condMutatedCwd = true;
                }
                if (frame.type === "loop" && !isAbsoluteTarget) {
                  curShellUnresolvedCwd = true;
                }
              }
            }
          }
        };

        const recordEnvMutation = (
          varName,
          { isUnresolvedVal = false, sepAfter = null, hasCasePattern = false } = {},
        ) => {
          if (!varName) return;
          const cleanName = stripLiteralSentinels(varName);
          const normKeys =
            shellType === "cmd" || base === "powershell" || base === "pwsh"
              ? [cleanName, cleanName.toUpperCase(), cleanName.toLowerCase()]
              : [cleanName];
          const inCaseBlock = Boolean(findTopControlFrame(["case"]));
          for (const k of normKeys) {
            chainAnyEnvMutation.add(k);
            if (chainHasCondition || outerChainConditional) {
              chainMutatedEnv.add(k);
            }
            if (
              isUnresolvedVal ||
              chainSawOrOrPipe ||
              sepAfter === "|" ||
              (hasCasePattern && !inCaseBlock)
            ) {
              taintedEnvVars.add(k);
            } else if (!chainHasCondition && !outerChainConditional) {
              taintedEnvVars.delete(k);
            }
            if (!currentClauseBackgrounded) {
              for (const frame of controlStack) {
                if (frame.subshellDepth === cwdStack.length) {
                  let isLocalSinceFrame = false;
                  for (let fdIdx = frame.fnDepth ?? 0; fdIdx < fnCallStack.length; fdIdx++) {
                    if (fnCallStack[fdIdx].localVars.has(k)) {
                      isLocalSinceFrame = true;
                      break;
                    }
                  }
                  if (isLocalSinceFrame) continue;
                  frame.mutatedEnv.add(k);
                  if (frame.phase === "cond") {
                    frame.condMutatedEnv.add(k);
                  }
                }
              }
            }
          }
        };

        const resetChainState = () => {
          for (const fd of fnDefs.values()) {
            if (fd.definedInCondChain) {
              fd.tainted = true;
              fd.definedInCondChain = false;
            }
          }
          chainHasCondition = false;
          chainSawOrOrPipe = false;
          chainMutatedCwd = false;
          chainAnyCwdMutation = false;
          chainMutatedEnv = new Set();
          chainAnyEnvMutation = new Set();
          chainEntryState = captureChainEntryState();
        };

        const runShellScript = (scriptToRun, runOpts = {}) => {
          const prevOuterCond = outerChainConditional;
          if (runOpts.inheritedCond) {
            outerChainConditional = true;
          }
          const trimmedScript = String(scriptToRun || "").trim();
          const rawParts = splitShellScriptParts(trimmedScript);
          const scriptHeredocs = parseScriptHeredocs(trimmedScript, rawParts);
          const clauses = [];
          let pendingSepBefore = null;
          for (let pIdx = 0; pIdx < rawParts.length; pIdx += 2) {
            const text = rawParts[pIdx].trim();
            const sepAfter = pIdx + 1 < rawParts.length ? rawParts[pIdx + 1] : null;
            if (text) {
              clauses.push({
                text,
                rawPart: rawParts[pIdx],
                partIdx: pIdx,
                sepBefore: pendingSepBefore,
                sepAfter,
                backgrounded: isAmpersandBackground && sepAfter === "&",
              });
              pendingSepBefore = sepAfter;
            } else if (sepAfter) {
              if (pendingSepBefore === ";" && sepAfter === ";") {
                pendingSepBefore = ";;";
              } else {
                pendingSepBefore = sepAfter;
              }
            }
          }
          if (isAmpersandBackground) {
            for (let ci = clauses.length - 1; ci > 0; ci--) {
              if (
                clauses[ci].backgrounded &&
                (clauses[ci].sepBefore === "&&" ||
                  clauses[ci].sepBefore === "||" ||
                  clauses[ci].sepBefore === "|")
              ) {
                clauses[ci - 1].backgrounded = true;
              }
            }
          }

          for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
            const clauseObj = clauses[cIdx];
            const { sepBefore, sepAfter } = clauseObj;
            currentClauseBackgrounded = Boolean(clauseObj.backgrounded);
            if (
              sepBefore === ";" ||
              sepBefore === ";;" ||
              sepBefore === "\n" ||
              sepBefore === "&"
            ) {
              if (sepBefore === "&" && isAmpersandBackground) {
                curShellRelCwd = chainEntryState.cwd;
                curShellUnresolvedCwd = chainEntryState.unresolvedCwd;
                pushdStack = [...chainEntryState.pushdStack];
                shellEnv = { ...chainEntryState.shellEnv };
                curShellEnvVars = { ...chainEntryState.envVars };
                taintedEnvVars = new Set(chainEntryState.taintedEnvVars);
              } else {
                if (chainMutatedCwd) {
                  curShellUnresolvedCwd = true;
                }
                for (const k of chainMutatedEnv) {
                  taintedEnvVars.add(k);
                }
              }
              if (sepBefore === ";;") {
                const topCase = findTopControlFrame(["case"])?.frame;
                if (topCase) {
                  for (const fd of fnDefs.values()) {
                    if (fd.definedInFrame === topCase) fd.tainted = true;
                  }
                  curShellRelCwd = topCase.entryCwd;
                  curShellUnresolvedCwd = topCase.entryUnresolvedCwd;
                  pushdStack = [...topCase.entryPushdStack];
                  shellEnv = { ...topCase.entryShellEnv };
                  curShellEnvVars = { ...topCase.entryEnvVars };
                  taintedEnvVars = new Set(topCase.entryTaintedEnv);
                }
              }
              resetChainState();
            } else if (sepBefore === "||" || sepBefore === "|") {
              chainHasCondition = true;
              chainSawOrOrPipe = true;
              if (chainAnyCwdMutation) {
                curShellUnresolvedCwd = true;
              }
              for (const k of chainAnyEnvMutation) {
                taintedEnvVars.add(k);
              }
            }

            const clause = clauseObj.text;
            const splitInfo = splitShellClauseRedirAndGroup(clauseObj.rawPart || clause);
            const {
              strippedClause,
              openedSubshells,
              closedSubshells,
              openedBraces,
              closedBraces,
              leadingKeywords,
              forLoopVars,
              functionNames,
              hasCasePattern,
            } = splitInfo;
            const isFunctionDecl = Array.isArray(functionNames) && functionNames.length > 0;
            for (let s = 0; s < openedSubshells; s++) {
              cwdStack.push({
                cwd: curShellRelCwd,
                unresolvedCwd: curShellUnresolvedCwd,
                shellEnv: { ...shellEnv },
                envVars: { ...curShellEnvVars },
                taintedEnvVars: new Set(taintedEnvVars),
                fnDefs: new Map(fnDefs),
                braceDepth,
                pushdStack: [...pushdStack],
                chainHasCondition,
                chainSawOrOrPipe,
                chainMutatedCwd,
                chainAnyCwdMutation,
                chainMutatedEnv: new Set(chainMutatedEnv),
                chainAnyEnvMutation: new Set(chainAnyEnvMutation),
                chainEntryState: {
                  cwd: chainEntryState.cwd,
                  unresolvedCwd: chainEntryState.unresolvedCwd,
                  pushdStack: [...chainEntryState.pushdStack],
                  shellEnv: { ...chainEntryState.shellEnv },
                  envVars: { ...chainEntryState.envVars },
                  taintedEnvVars: new Set(chainEntryState.taintedEnvVars),
                },
              });
              resetChainState();
            }
            braceDepth += openedBraces || 0;
            const popSubshells = (
              cBraces = isFunctionDecl ? 0 : closedBraces,
              cSubshells = isFunctionDecl ? 0 : closedSubshells,
            ) => {
              if (cBraces > 0) {
                braceDepth = Math.max(0, braceDepth - cBraces);
              }
              for (let s = 0; s < cSubshells; s++) {
                if (cwdStack.length > 0) {
                  const frame = cwdStack.pop();
                  curShellRelCwd = frame.cwd;
                  curShellUnresolvedCwd = frame.unresolvedCwd;
                  shellEnv = frame.shellEnv;
                  curShellEnvVars = frame.envVars;
                  taintedEnvVars = frame.taintedEnvVars;
                  if (frame.fnDefs) fnDefs = frame.fnDefs;
                  braceDepth = frame.braceDepth ?? braceDepth;
                  pushdStack = frame.pushdStack;
                  chainHasCondition = frame.chainHasCondition;
                  chainSawOrOrPipe = frame.chainSawOrOrPipe;
                  chainMutatedCwd = frame.chainMutatedCwd;
                  chainAnyCwdMutation = frame.chainAnyCwdMutation;
                  chainMutatedEnv = frame.chainMutatedEnv;
                  chainAnyEnvMutation = frame.chainAnyEnvMutation;
                  chainEntryState = frame.chainEntryState;
                  while (
                    controlStack.length > 0 &&
                    controlStack[controlStack.length - 1].subshellDepth > cwdStack.length
                  ) {
                    controlStack.pop();
                  }
                }
              }
            };

            let handledFunctionDecl = false;
            for (const kw of leadingKeywords || []) {
              if (kw === "function") {
                const fnSpan = extractShellFunctionSpan(rawParts, clauseObj.partIdx, splitInfo);
                if (fnSpan) {
                  for (const fnName of fnSpan.names || [fnSpan.name]) {
                    const isCondFn =
                      outerChainConditional ||
                      chainHasCondition ||
                      chainSawOrOrPipe ||
                      fnDefs.has(fnName);
                    const prevDef = fnDefs.get(fnName);
                    fnDefs.set(fnName, {
                      ...fnSpan,
                      name: fnName,
                      tainted: isCondFn,
                      prevDefs: prevDef ? [...(prevDef.prevDefs || []), prevDef] : [],
                      definedInFrame: controlStack[controlStack.length - 1] || null,
                      definedInCondChain: chainHasCondition || outerChainConditional,
                      called: false,
                    });
                  }
                  while (
                    cIdx + 1 < clauses.length &&
                    clauses[cIdx + 1].partIdx <= fnSpan.endPartIdx
                  ) {
                    cIdx++;
                  }
                  popSubshells(fnSpan.trailingClosedBraces || 0, fnSpan.trailingClosedSubshells || 0);
                  handledFunctionDecl = true;
                  break;
                }
              } else if (kw === "if") {
              controlStack.push({
                type: "if",
                phase: "cond",
                subshellDepth: cwdStack.length,
                fnDepth: fnCallStack.length,
                entryCwd: curShellRelCwd,
                entryUnresolvedCwd: curShellUnresolvedCwd,
                entryPushdStack: [...pushdStack],
                entryShellEnv: { ...shellEnv },
                entryEnvVars: { ...curShellEnvVars },
                entryTaintedEnv: new Set(taintedEnvVars),
                condMutatedCwd: false,
                mutatedCwd: false,
                condMutatedEnv: new Set(),
                mutatedEnv: new Set(),
              });
              resetChainState();
            } else if (kw === "then") {
              const found = findTopControlFrame(["if"]);
              if (found) {
                found.frame.phase = "then";
              }
              resetChainState();
            } else if (kw === "elif" || kw === "else") {
              const found = findTopControlFrame(["if"]);
              if (found) {
                for (const fd of fnDefs.values()) {
                  if (fd.definedInFrame === found.frame) fd.tainted = true;
                }
                found.frame.phase = kw === "elif" ? "cond" : "else";
                if (found.frame.condMutatedCwd) {
                  curShellUnresolvedCwd = true;
                } else {
                  curShellRelCwd = found.frame.entryCwd;
                  curShellUnresolvedCwd = found.frame.entryUnresolvedCwd;
                  pushdStack = [...found.frame.entryPushdStack];
                }
                shellEnv = { ...found.frame.entryShellEnv };
                curShellEnvVars = { ...found.frame.entryEnvVars };
                taintedEnvVars = new Set(found.frame.entryTaintedEnv);
                for (const k of found.frame.condMutatedEnv) {
                  taintedEnvVars.add(k);
                }
              } else {
                curShellUnresolvedCwd = true;
              }
              resetChainState();
            } else if (kw === "fi") {
              const found = findTopControlFrame(["if"]);
              if (found) {
                for (const fd of fnDefs.values()) {
                  if (fd.definedInFrame === found.frame) fd.tainted = true;
                }
                controlStack.splice(found.index, 1);
                if (found.frame.mutatedCwd) {
                  curShellUnresolvedCwd = true;
                } else {
                  curShellRelCwd = found.frame.entryCwd;
                  curShellUnresolvedCwd = found.frame.entryUnresolvedCwd;
                  pushdStack = [...found.frame.entryPushdStack];
                }
                shellEnv = { ...found.frame.entryShellEnv };
                curShellEnvVars = { ...found.frame.entryEnvVars };
                taintedEnvVars = new Set(found.frame.entryTaintedEnv);
                for (const k of found.frame.mutatedEnv) {
                  taintedEnvVars.add(k);
                }
              }
              resetChainState();
            } else if (kw === "while" || kw === "until" || kw === "for") {
              const loopMutatedEnv = new Set(forLoopVars || []);
              for (const fv of loopMutatedEnv) {
                taintedEnvVars.add(fv);
              }
              controlStack.push({
                type: "loop",
                phase: kw === "for" ? "body" : "cond",
                subshellDepth: cwdStack.length,
                fnDepth: fnCallStack.length,
                entryCwd: curShellRelCwd,
                entryUnresolvedCwd: curShellUnresolvedCwd,
                entryPushdStack: [...pushdStack],
                entryShellEnv: { ...shellEnv },
                entryEnvVars: { ...curShellEnvVars },
                entryTaintedEnv: new Set(taintedEnvVars),
                condMutatedCwd: false,
                mutatedCwd: false,
                condMutatedEnv: new Set(),
                mutatedEnv: loopMutatedEnv,
              });
              resetChainState();
            } else if (kw === "do") {
              const found = findTopControlFrame(["loop"]);
              if (found) {
                found.frame.phase = "body";
              }
              resetChainState();
            } else if (kw === "done") {
              const found = findTopControlFrame(["loop"]);
              if (found) {
                for (const fd of fnDefs.values()) {
                  if (fd.definedInFrame === found.frame) fd.tainted = true;
                }
                controlStack.splice(found.index, 1);
                if (found.frame.mutatedCwd) {
                  curShellUnresolvedCwd = true;
                }
                shellEnv = { ...found.frame.entryShellEnv };
                curShellEnvVars = { ...found.frame.entryEnvVars };
                taintedEnvVars = new Set(found.frame.entryTaintedEnv);
                for (const k of found.frame.mutatedEnv) {
                  taintedEnvVars.add(k);
                }
              }
              resetChainState();
            } else if (kw === "case") {
              controlStack.push({
                type: "case",
                phase: "arm",
                subshellDepth: cwdStack.length,
                fnDepth: fnCallStack.length,
                entryCwd: curShellRelCwd,
                entryUnresolvedCwd: curShellUnresolvedCwd,
                entryPushdStack: [...pushdStack],
                entryShellEnv: { ...shellEnv },
                entryEnvVars: { ...curShellEnvVars },
                entryTaintedEnv: new Set(taintedEnvVars),
                condMutatedCwd: false,
                mutatedCwd: false,
                condMutatedEnv: new Set(),
                mutatedEnv: new Set(),
              });
              resetChainState();
            } else if (kw === "esac") {
              const found = findTopControlFrame(["case"]);
              if (found) {
                for (const fd of fnDefs.values()) {
                  if (fd.definedInFrame === found.frame) fd.tainted = true;
                }
                controlStack.splice(found.index, 1);
                if (found.frame.mutatedCwd) {
                  curShellUnresolvedCwd = true;
                }
                shellEnv = { ...found.frame.entryShellEnv };
                curShellEnvVars = { ...found.frame.entryEnvVars };
                taintedEnvVars = new Set(found.frame.entryTaintedEnv);
                for (const k of found.frame.mutatedEnv) {
                  taintedEnvVars.add(k);
                }
              }
              resetChainState();
            }
          }

          if (handledFunctionDecl) {
            continue;
          }

          if (hasCasePattern) {
            const topCase = findTopControlFrame(["case"])?.frame;
            if (topCase) {
              for (const fd of fnDefs.values()) {
                if (fd.definedInFrame === topCase) fd.tainted = true;
              }
              curShellRelCwd = topCase.entryCwd;
              curShellUnresolvedCwd = topCase.entryUnresolvedCwd;
              pushdStack = [...topCase.entryPushdStack];
              shellEnv = { ...topCase.entryShellEnv };
              curShellEnvVars = { ...topCase.entryEnvVars };
              taintedEnvVars = new Set(topCase.entryTaintedEnv);
            }
            resetChainState();
          }

          const rawTokens = tokenizeShellClause(strippedClause, { markLiterals: true });
          if (rawTokens.length === 0) {
            popSubshells();
            continue;
          }
          const subExecs = [...scanExecutableSubstitutions(strippedClause)];
          for (const hd of scriptHeredocs) {
            if (hd.opPartIdx === clauseObj.partIdx && !hd.quoted && hd.kind !== "shell") {
              subExecs.push(
                ...scanExecutableSubstitutions(hd.effectiveBodyText, {
                  ignoreOuterSingleQuotes: true,
                }),
              );
            }
          }
          if (subExecs.length > 0) {
            const subBaseCwd = curShellRelCwd
              ? path.isAbsolute(curShellRelCwd)
                ? curShellRelCwd
                : path.resolve(baseCwd, curShellRelCwd)
              : baseCwd;
            for (const subExec of subExecs) {
              const subPeeled = peelBuildWrapperTokens(base, ["-c", subExec.body], {
                env: shellEnv,
                cwd: subBaseCwd,
                inShell: true,
                taintedVars: taintedEnvVars,
                shellType,
                fnDefs,
                activeFnCalls,
                candidateBuildToolEnv,
              });
              if (Array.isArray(subPeeled.allBuildClauses) && subPeeled.allBuildClauses.length > 0) {
                for (const subC of subPeeled.allBuildClauses) {
                  const subUnresolvedCwd = Boolean(
                    subC.unresolvedDynamicCwd ||
                      subPeeled.unresolvedDynamicCwd ||
                      (curShellUnresolvedCwd && !(subC.relCwd && path.isAbsolute(subC.relCwd))),
                  );
                  const subEffectiveRelCwd = subC.relCwd
                    ? path.isAbsolute(subC.relCwd)
                      ? subC.relCwd
                      : curShellRelCwd
                        ? path.join(curShellRelCwd, subC.relCwd)
                        : subC.relCwd
                    : curShellRelCwd || null;
                  matchedClauses.push({
                    cmd: subC.cmd,
                    args: subC.args,
                    relCwd: subEffectiveRelCwd,
                    envVars: {
                      ...curShellEnvVars,
                      ...(subPeeled.envVars || {}),
                      ...(subC.envVars || {}),
                    },
                    backgrounded: Boolean(
                      clauseObj.backgrounded || subPeeled.backgrounded || subC.backgrounded,
                    ),
                    unresolvedDynamicCwd: subUnresolvedCwd,
                  });
                }
              } else if (
                subPeeled.unparseableShellReason ||
                subPeeled.hasUnresolvedCmd ||
                subPeeled.unresolvedDynamicCwd
              ) {
                hasUnresolvedCmd = true;
                curShellUnresolvedCwd = true;
              }
            }
          }
          let unwrappedCommandOrBuiltin = false;
          while (rawTokens.length > 1) {
            const firstClean = stripLiteralSentinels(rawTokens[0]).toLowerCase();
            if (firstClean === "builtin") {
              rawTokens.shift();
              if (rawTokens[0] && stripLiteralSentinels(rawTokens[0]) === "--") {
                rawTokens.shift();
              }
              unwrappedCommandOrBuiltin = true;
              continue;
            }
            if (firstClean === "command") {
              let ci = 1;
              let isQuery = false;
              while (ci < rawTokens.length) {
                const ca = stripLiteralSentinels(rawTokens[ci]);
                if (ca === "--") {
                  ci++;
                  break;
                }
                if (ca.startsWith("-") && /[vV]/.test(ca)) {
                  isQuery = true;
                  break;
                }
                if (ca.startsWith("-")) {
                  ci++;
                  continue;
                }
                break;
              }
              if (!isQuery && ci < rawTokens.length) {
                rawTokens.splice(0, ci);
                unwrappedCommandOrBuiltin = true;
                continue;
              }
            }
            break;
          }
          if (rawTokens.length === 0) {
            popSubshells();
            continue;
          }
          const headTok = stripLiteralSentinels(rawTokens[0]);
          const headLower = headTok.toLowerCase();
          let fnTokIdx = 0;
          const callPrefixEnv = {};
          const callPrefixTainted = new Set();
          while (
            fnTokIdx < rawTokens.length &&
            /^[A-Za-z_][A-Za-z0-9_]*\+?=/i.test(stripLiteralSentinels(rawTokens[fnTokIdx]))
          ) {
            const pTok = rawTokens[fnTokIdx];
            const eqIdx = pTok.indexOf("=");
            const rawBeforeEq = stripLiteralSentinels(pTok.slice(0, eqIdx));
            const isAppend = rawBeforeEq.endsWith("+");
            const k = isAppend ? rawBeforeEq.slice(0, -1) : rawBeforeEq;
            const rawVal = pTok.slice(eqIdx + 1);
            const expVal = expandInShell(rawVal, shellEnv);
            if (expVal.unresolved) {
              callPrefixTainted.add(k);
            } else {
              callPrefixEnv[k] = isAppend
                ? String(shellEnv[k] ?? "") + expVal.resolved
                : expVal.resolved;
            }
            fnTokIdx++;
          }
          const candidateFnName =
            fnTokIdx < rawTokens.length ? stripLiteralSentinels(rawTokens[fnTokIdx]) : "";
          if (!unwrappedCommandOrBuiltin && candidateFnName && fnDefs.has(candidateFnName)) {
            const fnDef = fnDefs.get(candidateFnName);
            fnDef.called = true;
            const fnIsTainted = Boolean(
              fnDef.tainted ||
                (fnDef.definedInFrame && !controlStack.includes(fnDef.definedInFrame)),
            );
            if (activeFnCalls.has(candidateFnName)) {
              curShellUnresolvedCwd = true;
              recordCwdMutation({ isAbsoluteTarget: false, hasCasePattern, dirVerified: false });
              recordEnvMutation("*", {
                isUnresolvedVal: true,
                sepAfter,
                hasCasePattern,
              });
            } else {
              if (fnIsTainted) {
                curShellUnresolvedCwd = true;
                recordCwdMutation({ isAbsoluteTarget: false, hasCasePattern, dirVerified: false });
                recordEnvMutation("*", {
                  isUnresolvedVal: true,
                  sepAfter,
                  hasCasePattern,
                });
                for (const pd of fnDef.prevDefs || []) {
                  runShellScript(pd.bodyScript, { inheritedCond: true });
                }
              }
              const callArgs = rawTokens.slice(fnTokIdx + 1);
              const savedPosEnv = {};
              const savedPosTaint = new Set();
              for (let pi = 1; pi <= 9; pi++) {
                const pk = String(pi);
                savedPosEnv[pk] = shellEnv[pk];
                if (taintedEnvVars.has(pk)) savedPosTaint.add(pk);
                if (pi - 1 < callArgs.length) {
                  const expArg = expandInShell(callArgs[pi - 1], shellEnv);
                  if (expArg.unresolved) {
                    taintedEnvVars.add(pk);
                  } else {
                    shellEnv[pk] = expArg.resolved;
                    taintedEnvVars.delete(pk);
                  }
                } else {
                  delete shellEnv[pk];
                  taintedEnvVars.delete(pk);
                }
              }
              const savedPrefixEnv = new Map();
              for (const pk of [...Object.keys(callPrefixEnv), ...callPrefixTainted]) {
                savedPrefixEnv.set(pk, {
                  hasEnv: pk in shellEnv,
                  envVal: shellEnv[pk],
                  hasCurVar: pk in curShellEnvVars,
                  curVarVal: curShellEnvVars[pk],
                  tainted: taintedEnvVars.has(pk),
                });
              }
              for (const [pk, pv] of Object.entries(callPrefixEnv)) {
                shellEnv[pk] = pv;
                curShellEnvVars[pk] = pv;
                taintedEnvVars.delete(pk);
              }
              for (const pk of callPrefixTainted) {
                taintedEnvVars.add(pk);
              }
              const needsSubshell = Boolean(
                fnDef.isSubshellFn ||
                  clauseObj.backgrounded ||
                  sepAfter === "|" ||
                  sepBefore === "|",
              );
              if (needsSubshell) {
                cwdStack.push({
                  cwd: curShellRelCwd,
                  unresolvedCwd: curShellUnresolvedCwd,
                  shellEnv: { ...shellEnv },
                  envVars: { ...curShellEnvVars },
                  taintedEnvVars: new Set(taintedEnvVars),
                  fnDefs: new Map(fnDefs),
                  braceDepth,
                  pushdStack: [...pushdStack],
                  chainHasCondition,
                  chainSawOrOrPipe,
                  chainMutatedCwd,
                  chainAnyCwdMutation,
                  chainMutatedEnv: new Set(chainMutatedEnv),
                  chainAnyEnvMutation: new Set(chainAnyEnvMutation),
                  chainEntryState: {
                    cwd: chainEntryState.cwd,
                    unresolvedCwd: chainEntryState.unresolvedCwd,
                    pushdStack: [...chainEntryState.pushdStack],
                    shellEnv: { ...chainEntryState.shellEnv },
                    envVars: { ...chainEntryState.envVars },
                    taintedEnvVars: new Set(chainEntryState.taintedEnvVars),
                  },
                });
              }
              const clausesBeforeCall = matchedClauses.length;
              fnCallStack.push({ localVars: new Set(), savedState: new Map() });
              activeFnCalls.add(candidateFnName);
              runShellScript(fnDef.bodyScript, {
                inheritedCond: chainHasCondition || outerChainConditional || fnIsTainted,
              });
              activeFnCalls.delete(candidateFnName);
              const poppedFnCall = fnCallStack.pop();
              if (poppedFnCall && !needsSubshell) {
                for (const [lk, saved] of poppedFnCall.savedState.entries()) {
                  if (saved.hasEnv) shellEnv[lk] = saved.envVal;
                  else delete shellEnv[lk];
                  if (saved.hasCurVar) curShellEnvVars[lk] = saved.curVarVal;
                  else delete curShellEnvVars[lk];
                  if (saved.tainted) taintedEnvVars.add(lk);
                  else taintedEnvVars.delete(lk);
                  if (saved.hasCand) candidateBuildToolEnv[lk] = saved.candVal;
                  else delete candidateBuildToolEnv[lk];
                  if (saved.inChainMutated) chainMutatedEnv.add(lk);
                  else chainMutatedEnv.delete(lk);
                  if (saved.inChainAny) chainAnyEnvMutation.add(lk);
                  else chainAnyEnvMutation.delete(lk);
                }
              }
              const callClauses = matchedClauses.slice(clausesBeforeCall);
              const callSig = callClauses
                .map((c) => {
                  const cl = classifyBuildCommand(c.cmd, c.args);
                  return `${cl.tool || "none"}:${Boolean(cl.requiresHeavySlot)}:${Boolean(cl.requiresDevice)}`;
                })
                .join(",");
              if (!fnDef.producedClauses) fnDef.producedClauses = [];
              fnDef.producedClauses.push(...callClauses);
              if (fnDef.firstCallSig === undefined) {
                fnDef.firstCallSig = callSig;
              } else if (fnDef.firstCallSig !== callSig) {
                for (const pc of fnDef.producedClauses) {
                  pc.unresolvedDynamicCwd = true;
                }
              }
              if (needsSubshell && cwdStack.length > 0) {
                const frame = cwdStack.pop();
                curShellRelCwd = frame.cwd;
                curShellUnresolvedCwd = frame.unresolvedCwd;
                shellEnv = frame.shellEnv;
                curShellEnvVars = frame.envVars;
                taintedEnvVars = frame.taintedEnvVars;
                if (frame.fnDefs) fnDefs = frame.fnDefs;
                braceDepth = frame.braceDepth ?? braceDepth;
                pushdStack = frame.pushdStack;
                chainHasCondition = frame.chainHasCondition;
                chainSawOrOrPipe = frame.chainSawOrOrPipe;
                chainMutatedCwd = frame.chainMutatedCwd;
                chainAnyCwdMutation = frame.chainAnyCwdMutation;
                chainMutatedEnv = frame.chainMutatedEnv;
                chainAnyEnvMutation = frame.chainAnyEnvMutation;
                chainEntryState = frame.chainEntryState;
              }
              for (const [pk, saved] of savedPrefixEnv.entries()) {
                if (saved.hasEnv) shellEnv[pk] = saved.envVal;
                else delete shellEnv[pk];
                if (saved.hasCurVar) curShellEnvVars[pk] = saved.curVarVal;
                else delete curShellEnvVars[pk];
                if (saved.tainted) taintedEnvVars.add(pk);
                else taintedEnvVars.delete(pk);
              }
              for (let pi = 1; pi <= 9; pi++) {
                const pk = String(pi);
                if (savedPosEnv[pk] === undefined) {
                  delete shellEnv[pk];
                } else {
                  shellEnv[pk] = savedPosEnv[pk];
                }
                if (savedPosTaint.has(pk)) {
                  taintedEnvVars.add(pk);
                } else {
                  taintedEnvVars.delete(pk);
                }
              }
            }
            chainHasCondition = true;
            popSubshells();
            continue;
          }
          if (headLower === "source" || headTok === "." || headLower === "eval") {
            const evalHeredocs = scriptHeredocs.filter(
              (h) =>
                h.kind === "shell" &&
                (h.consumerPartIdx !== -1 ? h.consumerPartIdx : h.opPartIdx) === clauseObj.partIdx,
            );
            for (const hd of evalHeredocs) {
              runShellScript(hd.effectiveBodyText, { inheritedCond: true });
            }
            curShellUnresolvedCwd = true;
            recordCwdMutation({ isAbsoluteTarget: false, hasCasePattern, dirVerified: false });
            recordEnvMutation("*", {
              isUnresolvedVal: true,
              sepAfter,
              hasCasePattern,
            });
            for (const fd of fnDefs.values()) {
              if (!activeFnCalls.has(fd.name)) {
                activeFnCalls.add(fd.name);
                runShellScript(fd.bodyScript, { inheritedCond: true });
                activeFnCalls.delete(fd.name);
              }
            }
            popSubshells();
            continue;
          }
          if (
            headLower === "export" ||
            headLower === "local" ||
            headLower === "declare" ||
            headLower === "typeset" ||
            headLower === "readonly" ||
            (base === "cmd" && headLower === "set" && rawTokens.length > 1) ||
            rawTokens.every((t) =>
              /^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*\+?=/i.test(stripLiteralSentinels(t)),
            )
          ) {
            const assignTokens =
              headLower === "export" ||
              headLower === "local" ||
              headLower === "declare" ||
              headLower === "typeset" ||
              headLower === "readonly" ||
              (base === "cmd" && headLower === "set")
                ? rawTokens.slice(1)
                : rawTokens;
            const isLocalDecl =
              fnCallStack.length > 0 &&
              (headLower === "local" ||
                ((headLower === "declare" || headLower === "typeset") &&
                  !assignTokens.some((t) =>
                    /^-[A-Za-z]*g[A-Za-z]*$/.test(stripLiteralSentinels(t)),
                  )));
            for (const tok of assignTokens) {
              const cleanTok = stripLiteralSentinels(tok);
              if (/^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*\+?=/i.test(cleanTok)) {
                const eqIdx = tok.indexOf("=");
                const rawBeforeEq = stripLiteralSentinels(tok.slice(0, eqIdx));
                const isAppend = rawBeforeEq.endsWith("+");
                const rawKey = isAppend ? rawBeforeEq.slice(0, -1) : rawBeforeEq;
                const k = rawKey.replace(/^\$env:/i, "");
                if (isLocalDecl) {
                  registerLocalVar(k);
                }
                const rawVal = tok.slice(eqIdx + 1);
                const expVal = expandInShell(rawVal, shellEnv);
                const prevTainted =
                  isAppend &&
                  (taintedEnvVars.has("*") ||
                    taintedEnvVars.has(k) ||
                    taintedEnvVars.has(k.toUpperCase()));
                const isUnres = expVal.unresolved || prevTainted;
                const prevVal = isAppend ? String(shellEnv[k] ?? "") : "";
                const finalVal = isUnres
                  ? stripLiteralSentinels(rawVal)
                  : isAppend
                    ? prevVal + expVal.resolved
                    : expVal.resolved;
                shellEnv[k] = finalVal;
                curShellEnvVars[k] = finalVal;
                if (normalizeBuildToolName(finalVal)) {
                  candidateBuildToolEnv[k] = finalVal;
                  if (shellType === "cmd" || base === "powershell" || base === "pwsh") {
                    candidateBuildToolEnv[k.toUpperCase()] = finalVal;
                    candidateBuildToolEnv[k.toLowerCase()] = finalVal;
                  }
                }
                recordEnvMutation(k, {
                  isUnresolvedVal: isUnres,
                  sepAfter,
                  hasCasePattern,
                });
              } else if (
                isLocalDecl &&
                !cleanTok.startsWith("-") &&
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanTok)
              ) {
                registerLocalVar(cleanTok);
                delete shellEnv[cleanTok];
                delete curShellEnvVars[cleanTok];
                recordEnvMutation(cleanTok, {
                  isUnresolvedVal: false,
                  sepAfter,
                  hasCasePattern,
                });
              }
            }
            popSubshells();
            continue;
          }
          if (
            (base === "powershell" || base === "pwsh") &&
            /^\$env:[A-Za-z_][A-Za-z0-9_]*$/i.test(headTok) &&
            (stripLiteralSentinels(rawTokens[1] || "") === "=" ||
              stripLiteralSentinels(rawTokens[1] || "") === "+=") &&
            rawTokens.length >= 3
          ) {
            const k = headTok.replace(/^\$env:/i, "");
            const isAppend = stripLiteralSentinels(rawTokens[1] || "") === "+=";
            const rawVal = rawTokens.slice(2).join(" ");
            const expVal = expandInShell(rawVal, shellEnv);
            const prevTainted =
              isAppend &&
              (taintedEnvVars.has("*") ||
                taintedEnvVars.has(k) ||
                taintedEnvVars.has(k.toUpperCase()));
            const isUnres = expVal.unresolved || prevTainted;
            const prevVal = isAppend ? String(shellEnv[k] ?? "") : "";
            const finalVal = isUnres
              ? stripLiteralSentinels(rawVal)
              : isAppend
                ? prevVal + expVal.resolved
                : expVal.resolved;
            shellEnv[k] = finalVal;
            curShellEnvVars[k] = finalVal;
            if (normalizeBuildToolName(finalVal)) {
              candidateBuildToolEnv[k] = finalVal;
              candidateBuildToolEnv[k.toUpperCase()] = finalVal;
              candidateBuildToolEnv[k.toLowerCase()] = finalVal;
            }
            recordEnvMutation(k, {
              isUnresolvedVal: isUnres,
              sepAfter,
              hasCasePattern,
            });
            popSubshells();
            continue;
          }
          if (headLower === "unset") {
            for (const tok of rawTokens.slice(1)) {
              const cleanTok = stripLiteralSentinels(tok);
              if (!cleanTok.startsWith("-")) {
                delete shellEnv[cleanTok];
                curShellEnvVars[cleanTok] = null;
                recordEnvMutation(cleanTok, {
                  isUnresolvedVal: false,
                  sepAfter,
                  hasCasePattern,
                });
              }
            }
            popSubshells();
            continue;
          }
          if (headLower === "read") {
            const readVars = rawTokens
              .slice(1)
              .map(stripLiteralSentinels)
              .filter((t) => !t.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
            for (const rv of readVars.length > 0 ? readVars : ["REPLY"]) {
              recordEnvMutation(rv, {
                isUnresolvedVal: true,
                sepAfter,
                hasCasePattern,
              });
            }
            popSubshells();
            continue;
          }
          if (headLower === "popd" || headLower === "pop-location") {
            const hasNamedStack = rawTokens
              .slice(1)
              .map(stripLiteralSentinels)
              .some((t) => /^-stackname(?::|$)/i.test(t));
            let isAbsPop = false;
            if (!hasNamedStack && pushdStack.length > 0) {
              const popped = pushdStack.pop();
              curShellRelCwd = popped.cwd;
              curShellUnresolvedCwd = popped.unresolvedCwd;
              isAbsPop = Boolean(popped.cwd && path.isAbsolute(popped.cwd) && !popped.unresolvedCwd);
            } else {
              curShellUnresolvedCwd = true;
            }
            if (sepAfter === "|") {
              curShellUnresolvedCwd = true;
            }
            recordCwdMutation({ isAbsoluteTarget: isAbsPop, hasCasePattern });
            popSubshells();
            continue;
          }
          const isPushdCmd = headLower === "pushd" || headLower === "push-location";
          const isCdCmd =
            headLower === "cd" ||
            headLower === "chdir" ||
            headLower === "sl" ||
            headLower === "set-location" ||
            headLower === "cd.." ||
            headLower === "cd\\";
          if (isCdCmd || isPushdCmd) {
            let dirIdx = 1;
            let stackNameUsed = false;
            let implicitTargetDir =
              headLower === "cd.." ? ".." : headLower === "cd\\" ? "\\" : null;
            if (!implicitTargetDir) {
              while (dirIdx < rawTokens.length) {
                const tok = stripLiteralSentinels(rawTokens[dirIdx]);
                if (/^\/d$/i.test(tok)) {
                  dirIdx++;
                  continue;
                }
                if (/^-(?:path|literalpath)$/i.test(tok)) {
                  dirIdx++;
                  break;
                }
                if (/^-passthru$/i.test(tok)) {
                  dirIdx++;
                  continue;
                }
                if (/^-stackname$/i.test(tok)) {
                  stackNameUsed = true;
                  dirIdx += 2;
                  continue;
                }
                if (tok.startsWith("-")) {
                  if (tok === "-") break;
                  if (tok === "--") {
                    dirIdx++;
                    break;
                  }
                  dirIdx++;
                  continue;
                }
                break;
              }
            }
            let isAbsTarget = false;
            const prevCwdForOldPwd =
              !curShellUnresolvedCwd && curShellRelCwd && path.isAbsolute(curShellRelCwd)
                ? curShellRelCwd
                : null;
            if (stackNameUsed) {
              curShellUnresolvedCwd = true;
            } else if (!implicitTargetDir && dirIdx >= rawTokens.length) {
              if (isCdCmd) {
                const home =
                  (!taintedEnvVars.has("HOME") && shellEnv?.HOME) ||
                  (!taintedEnvVars.has("USERPROFILE") && shellEnv?.USERPROFILE) ||
                  os.homedir();
                if (home && !taintedEnvVars.has("HOME") && !taintedEnvVars.has("USERPROFILE")) {
                  curShellRelCwd = home;
                  curShellUnresolvedCwd = false;
                  isAbsTarget = path.isAbsolute(home) || /^[A-Za-z]:[\\/]/.test(home);
                } else {
                  curShellUnresolvedCwd = true;
                }
              } else {
                curShellUnresolvedCwd = true;
              }
            } else {
              const targetDir = implicitTargetDir || rawTokens[dirIdx];
              const cleanTargetDir = stripLiteralSentinels(targetDir);
              if (cleanTargetDir === "-") {
                if (shellEnv?.OLDPWD && !curShellUnresolvedCwd && !taintedEnvVars.has("OLDPWD")) {
                  curShellRelCwd = shellEnv.OLDPWD;
                  curShellUnresolvedCwd = false;
                  isAbsTarget =
                    path.isAbsolute(shellEnv.OLDPWD) || /^[A-Za-z]:[\\/]/.test(shellEnv.OLDPWD);
                } else {
                  curShellUnresolvedCwd = true;
                }
              } else if (targetDir) {
                if (isPushdCmd) {
                  pushdStack.push({
                    cwd: curShellRelCwd,
                    unresolvedCwd: curShellUnresolvedCwd,
                  });
                }
                const exp = expandInShell(targetDir, shellEnv);
                if (exp.unresolved) {
                  curShellUnresolvedCwd = true;
                } else {
                  const resolvedDir = exp.resolved;
                  if (path.isAbsolute(resolvedDir) || /^[A-Za-z]:[\\/]/.test(resolvedDir)) {
                    curShellRelCwd = resolvedDir;
                    curShellUnresolvedCwd = false;
                    isAbsTarget = true;
                  } else {
                    curShellRelCwd = curShellRelCwd
                      ? path.join(curShellRelCwd, resolvedDir)
                      : resolvedDir;
                  }
                }
              }
            }
            if (prevCwdForOldPwd) {
              shellEnv.OLDPWD = prevCwdForOldPwd;
            } else {
              delete shellEnv.OLDPWD;
            }
            if (sepAfter === "|") {
              curShellUnresolvedCwd = true;
            }
            let dirVerified = false;
            if (!curShellUnresolvedCwd && curShellRelCwd) {
              const candidateAbs = path.isAbsolute(curShellRelCwd)
                ? curShellRelCwd
                : path.resolve(baseCwd, curShellRelCwd);
              try {
                dirVerified =
                  fs.existsSync(candidateAbs) && fs.statSync(candidateAbs).isDirectory();
              } catch {
                dirVerified = false;
              }
            }
            recordCwdMutation({ isAbsoluteTarget: isAbsTarget, hasCasePattern, dirVerified });
            popSubshells();
            continue;
          }
          chainHasCondition = true;
          const clauseBaseCwd = curShellRelCwd
            ? path.isAbsolute(curShellRelCwd)
              ? curShellRelCwd
              : path.resolve(baseCwd, curShellRelCwd)
            : baseCwd;
          const peeled = peelBuildWrapperTokens(rawTokens[0], rawTokens.slice(1), {
            env: shellEnv,
            cwd: clauseBaseCwd,
            inShell: true,
            taintedVars: taintedEnvVars,
            shellType,
            candidateBuildToolEnv,
          });
          if (Array.isArray(peeled.allBuildClauses) && peeled.allBuildClauses.length > 0) {
            for (const subC of peeled.allBuildClauses) {
              const subUnresolvedCwd = Boolean(
                subC.unresolvedDynamicCwd ||
                  peeled.unresolvedDynamicCwd ||
                  (curShellUnresolvedCwd && !(subC.relCwd && path.isAbsolute(subC.relCwd))),
              );
              const subEffectiveRelCwd = subC.relCwd
                ? path.isAbsolute(subC.relCwd)
                  ? subC.relCwd
                  : curShellRelCwd
                    ? path.join(curShellRelCwd, subC.relCwd)
                    : subC.relCwd
                : curShellRelCwd || null;
              matchedClauses.push({
                cmd: subC.cmd,
                args: subC.args,
                relCwd: subEffectiveRelCwd,
                envVars: { ...curShellEnvVars, ...(peeled.envVars || {}), ...(subC.envVars || {}) },
                backgrounded: Boolean(clauseObj.backgrounded || peeled.backgrounded || subC.backgrounded),
                unresolvedDynamicCwd: subUnresolvedCwd,
              });
            }
            popSubshells();
            continue;
          }
          const shellClauseHeredocs = scriptHeredocs.filter(
            (h) =>
              h.kind === "shell" &&
              (h.consumerPartIdx !== -1 ? h.consumerPartIdx : h.opPartIdx) === clauseObj.partIdx,
          );
          if (shellClauseHeredocs.length > 0) {
            const hdShellCmd = stripLiteralSentinels(peeled.cmd || "");
            const hdShellBase = (hdShellCmd.split(/[\\/]/).pop() || "")
              .toLowerCase()
              .replace(/\.(?:exe|cmd|bat|com|sh)$/i, "");
            const effectiveHdShell = [
              "sh",
              "bash",
              "zsh",
              "dash",
              "ksh",
              "cmd",
              "powershell",
              "pwsh",
            ].includes(hdShellBase)
              ? hdShellBase
              : base;
            const hdEnv = { ...shellEnv, ...(peeled.envVars || {}) };
            const hdTainted = new Set(taintedEnvVars);
            for (const k of Object.keys(peeled.envVars || {})) {
              hdTainted.delete(k);
            }
            const pArgs = Array.isArray(peeled.args) ? peeled.args : [];
            let posStart = -1;
            for (let ai = 0; ai < pArgs.length; ai++) {
              const cleanA = stripLiteralSentinels(pArgs[ai]);
              if (cleanA === "--") {
                posStart = ai + 1;
                break;
              }
              if (cleanA === "-s") {
                posStart = ai + 1;
                if (posStart < pArgs.length && stripLiteralSentinels(pArgs[posStart]) === "--") {
                  posStart++;
                }
                break;
              }
            }
            if (posStart !== -1) {
              const posList = pArgs.slice(posStart);
              for (let pi = 1; pi <= 9; pi++) {
                const pk = String(pi);
                if (pi - 1 < posList.length) {
                  const expPos = expandInShell(posList[pi - 1], hdEnv);
                  if (expPos.unresolved) {
                    hdTainted.add(pk);
                  } else {
                    hdEnv[pk] = expPos.resolved;
                    hdTainted.delete(pk);
                  }
                } else {
                  delete hdEnv[pk];
                  hdTainted.delete(pk);
                }
              }
            }
            const hdCwd = peeled.relCwd
              ? path.isAbsolute(peeled.relCwd)
                ? peeled.relCwd
                : path.resolve(clauseBaseCwd, peeled.relCwd)
              : clauseBaseCwd;
            const hdRelPrefix = peeled.relCwd
              ? path.isAbsolute(peeled.relCwd)
                ? peeled.relCwd
                : curShellRelCwd
                  ? path.join(curShellRelCwd, peeled.relCwd)
                  : peeled.relCwd
              : curShellRelCwd || null;
            for (const hd of shellClauseHeredocs) {
              const hdPeeled = peelBuildWrapperTokens(
                effectiveHdShell,
                ["-c", hd.effectiveBodyText],
                {
                  env: hdEnv,
                  cwd: hdCwd,
                  inShell: true,
                  taintedVars: hdTainted,
                  shellType,
                  fnDefs,
                  activeFnCalls,
                  candidateBuildToolEnv,
                },
              );
              if (Array.isArray(hdPeeled.allBuildClauses) && hdPeeled.allBuildClauses.length > 0) {
                for (const subC of hdPeeled.allBuildClauses) {
                  const subUnresolvedCwd = Boolean(
                    subC.unresolvedDynamicCwd ||
                      hdPeeled.unresolvedDynamicCwd ||
                      peeled.unresolvedDynamicCwd ||
                      (curShellUnresolvedCwd && !(subC.relCwd && path.isAbsolute(subC.relCwd))),
                  );
                  const subEffectiveRelCwd = subC.relCwd
                    ? path.isAbsolute(subC.relCwd)
                      ? subC.relCwd
                      : hdRelPrefix
                        ? path.join(hdRelPrefix, subC.relCwd)
                        : subC.relCwd
                    : hdRelPrefix;
                  matchedClauses.push({
                    cmd: subC.cmd,
                    args: subC.args,
                    relCwd: subEffectiveRelCwd,
                    envVars: {
                      ...curShellEnvVars,
                      ...(peeled.envVars || {}),
                      ...(hdPeeled.envVars || {}),
                      ...(subC.envVars || {}),
                    },
                    backgrounded: Boolean(
                      clauseObj.backgrounded ||
                        peeled.backgrounded ||
                        hdPeeled.backgrounded ||
                        subC.backgrounded,
                    ),
                    unresolvedDynamicCwd: subUnresolvedCwd,
                  });
                }
              } else if (
                hdPeeled.unparseableShellReason ||
                hdPeeled.hasUnresolvedCmd ||
                hdPeeled.unresolvedDynamicCwd
              ) {
                hasUnresolvedCmd = true;
                curShellUnresolvedCwd = true;
              }
            }
            popSubshells();
            continue;
          }
          const cmdOnlyExp = expandOrValidateShellPath(peeled.cmd, shellEnv, {
            taintedVars: taintedEnvVars,
            shellType,
          });
          const expandedClause = expandShellBuildClausePaths(
            peeled.cmd,
            peeled.args,
            shellEnv,
            { taintedVars: taintedEnvVars, shellType },
          );
          let matchedToolCmd = normalizeBuildToolName(expandedClause.cmd)
            ? expandedClause.cmd
            : null;
          let forceUnresolvedCmd = false;
          if (!matchedToolCmd && expandedClause.unresolved) {
            const candidateExp = expandOrValidateShellPath(
              peeled.cmd,
              { ...shellEnv, ...candidateBuildToolEnv },
              { shellType },
            );
            if (candidateExp.resolved && normalizeBuildToolName(candidateExp.resolved)) {
              matchedToolCmd = candidateExp.resolved;
              forceUnresolvedCmd = true;
            } else if (cmdOnlyExp.unresolved) {
              const rawCleanCmd = stripLiteralSentinels(peeled.cmd);
              const embeddedToolMatch = rawCleanCmd.match(
                /(?:^|[^A-Za-z0-9_])(gradlew(?:\.bat)?|gradle(?:\.bat|\.cmd)?|bazel(?:isk)?(?:\.exe|\.bat|\.cmd)?|xcodebuild)(?:$|[^A-Za-z0-9_])/i,
              );
              if (embeddedToolMatch?.[1]) {
                matchedToolCmd = embeddedToolMatch[1];
                forceUnresolvedCmd = true;
              } else {
                hasUnresolvedCmd = true;
              }
            }
          }
          if (matchedToolCmd) {
            const clauseUnresolvedCwd = Boolean(
              forceUnresolvedCmd ||
                peeled.unresolvedDynamicCwd ||
                expandedClause.unresolved ||
                (curShellUnresolvedCwd && !(peeled.relCwd && path.isAbsolute(peeled.relCwd))),
            );
            const effectiveRelCwd = peeled.relCwd
              ? path.isAbsolute(peeled.relCwd)
                ? peeled.relCwd
                : curShellRelCwd
                  ? path.join(curShellRelCwd, peeled.relCwd)
                  : peeled.relCwd
              : curShellRelCwd || null;
            const mergedClauseEnvVars = { ...curShellEnvVars, ...(peeled.envVars || {}) };
            if (taintedEnvVars.has("JAVA_HOME") && !(peeled.envVars && "JAVA_HOME" in peeled.envVars)) {
              mergedClauseEnvVars.JAVA_HOME = "__UNRESOLVED_DYNAMIC_ENV__";
            }
            if (
              taintedEnvVars.has("GRADLE_USER_HOME") &&
              !(peeled.envVars && "GRADLE_USER_HOME" in peeled.envVars)
            ) {
              mergedClauseEnvVars.GRADLE_USER_HOME = "__UNRESOLVED_DYNAMIC_ENV__";
            }
            for (const locKey of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
              if (
                (taintedEnvVars.has("*") || taintedEnvVars.has(locKey)) &&
                !(peeled.envVars && locKey in peeled.envVars)
              ) {
                mergedClauseEnvVars[locKey] = "__UNRESOLVED_DYNAMIC_ENV__";
              }
            }
            matchedClauses.push({
              cmd: matchedToolCmd,
              args: expandedClause.args,
              relCwd: effectiveRelCwd,
              envVars: mergedClauseEnvVars,
              backgrounded: Boolean(clauseObj.backgrounded || peeled.backgrounded),
              unresolvedDynamicCwd: clauseUnresolvedCwd,
            });
          }
          popSubshells();
          }
          outerChainConditional = prevOuterCond;
        };

        runShellScript(script);

        const unparseableCheck = detectUnparseableShellConstructs(script, shellType);
        const scriptWithoutHeredoc = stripOpaqueHeredocsForCheck(script);
        const mentionsBuildToolMatch = scriptWithoutHeredoc.match(
          /(?:^|[\s"'/;(&|`])(gradlew|gradle|bazelisk|bazelw|bazel|xcodebuild)(?:\.(?:bat|cmd|exe|sh))?(?=$|[\s"'/);&|`])/i,
        );
        if (
          unparseableCheck.unparseable &&
          (matchedClauses.length > 0 || Boolean(mentionsBuildToolMatch) || hasUnresolvedCmd)
        ) {
          return {
            cmd: matchedClauses[0]?.cmd || mentionsBuildToolMatch?.[1] || "gradle",
            args: matchedClauses[0]?.args || [],
            relCwd: matchedClauses[0]?.relCwd || null,
            envVars: matchedClauses[0]?.envVars || { ...curShellEnvVars },
            backgrounded: false,
            unresolvedDynamicCwd: true,
            unparseableShellReason: unparseableCheck.reason,
            hasUnresolvedCmd: true,
            allBuildClauses: matchedClauses.length > 0 ? matchedClauses : null,
          };
        }

        if (matchedClauses.length > 0) {
          return {
            cmd: matchedClauses[0].cmd,
            args: matchedClauses[0].args,
            relCwd: matchedClauses[0].relCwd || null,
            envVars: matchedClauses[0].envVars || { ...curShellEnvVars },
            backgrounded: matchedClauses.some((c) => c.backgrounded),
            unresolvedDynamicCwd:
              hasUnresolvedCmd || matchedClauses.some((c) => c.unresolvedDynamicCwd),
            hasUnresolvedCmd,
            allBuildClauses: matchedClauses,
          };
        }
        if (hasUnresolvedCmd) {
          return {
            cmd: inShell ? curCmd : stripLiteralSentinels(curCmd),
            args: inShell ? curArgs : curArgs.map(stripLiteralSentinels),
            relCwd,
            envVars,
            backgrounded: false,
            unresolvedDynamicCwd,
            hasUnresolvedCmd: true,
            allBuildClauses: null,
          };
        }
      }
    }
    break;
  }

  return {
    cmd: inShell ? curCmd : stripLiteralSentinels(curCmd),
    args: inShell ? curArgs : curArgs.map(stripLiteralSentinels),
    relCwd,
    envVars,
    backgrounded: false,
    unresolvedDynamicCwd,
    allBuildClauses: null,
  };
}

export function normalizeBuildToolName(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const cleaned = stripLiteralSentinels(cmd).trim().replace(/^@+/, "");
  if (/^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*\+?=/i.test(cleaned)) return null;
  const base = (cleaned.split(/[\\/]/).pop() || "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|sh)$/i, "");
  if (base === "gradle" || base === "gradlew") return "gradle";
  if (base === "bazel" || base === "bazelisk" || base === "bazelw") return "bazel";
  if (base === "xcodebuild") return "xcodebuild";
  return null;
}

const GRADLE_VALUE_FLAGS = new Set([
  "-p",
  "--project-dir",
  "-g",
  "--gradle-user-home",
  "-c",
  "--settings-file",
  "-b",
  "--build-file",
  "-I",
  "--init-script",
  "--console",
  "--warning-mode",
  "--max-workers",
  "--priority",
]);

const GRADLE_WORKSPACE_ONLY_TASKS = new Set([
  "tasks",
  "projects",
  "dependencies",
  "dependencyInsight",
  "help",
  "properties",
  "model",
  "components",
  "outgoingVariants",
  "resolvableConfigurations",
  "buildEnvironment",
  "javaToolchains",
]);

const NON_DEVICE_INSTALL_RE = /^install(Dist|BootDist|ShadowDist|Maven|ToMavenLocal)$/i;
const NON_DEVICE_CAMEL_INSTALL_RE = /^i(Dist|BD|SD|M|TML)$/;

export function isGradleDeviceTaskName(name) {
  if (!name || typeof name !== "string") return false;
  if (NON_DEVICE_INSTALL_RE.test(name) || NON_DEVICE_CAMEL_INSTALL_RE.test(name)) {
    return false;
  }
  if (
    /^(connected.*AndroidTest|connectedCheck|deviceCheck|allDevicesCheck|uninstall([A-Z0-9_].*)?|install([A-Z0-9_].*)?)$/i.test(
      name,
    )
  ) {
    return true;
  }
  if (/^(c[A-Z0-9]*A[A-Z0-9]*T|cC|dC|aDC|i[A-Z][A-Za-z0-9]*|u[A-Z][A-Za-z0-9]*)$/.test(name)) {
    return true;
  }
  return false;
}

const BAZEL_STARTUP_VALUE_FLAGS = new Set([
  "--output_base",
  "--output_user_root",
  "--install_base",
  "--bazelrc",
  "--max_idle_secs",
  "--connect_timeout_secs",
  "--server_javabase",
]);

const BAZEL_SUBCOMMANDS = new Set([
  "build",
  "test",
  "run",
  "coverage",
  "mobile-install",
  "query",
  "cquery",
  "aquery",
  "fetch",
  "sync",
  "clean",
  "shutdown",
  "version",
  "help",
  "info",
  "dump",
  "config",
  "mod",
  "license",
]);

const XCODEBUILD_VALUE_FLAGS = new Set([
  "-project",
  "-workspace",
  "-scheme",
  "-target",
  "-configuration",
  "-sdk",
  "-destination",
  "-destination-timeout",
  "-derivedDataPath",
  "-resultBundlePath",
  "-xcconfig",
  "-archivePath",
  "-exportPath",
  "-exportOptionsPlist",
  "-only-testing",
  "-skip-testing",
  "-testPlan",
]);

export function findBazelSubcommandIndex(args = [], allowedSubcommands = BAZEL_SUBCOMMANDS) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (allowedSubcommands.has(a.toLowerCase())) {
      return i;
    }
  }
  return -1;
}

export function injectBazelFlagsIntoShellClause(corePart, injectedFlags = [], options = {}) {
  if (!injectedFlags || injectedFlags.length === 0) return corePart;
  const s = String(corePart || "");
  let leadingOffset = 0;
  while (leadingOffset < s.length) {
    if (/[\s({]/.test(s[leadingOffset])) {
      leadingOffset++;
      continue;
    }
    const kwMatch = s
      .slice(leadingOffset)
      .match(
        /^(?:(?:then|else|do|if|elif|while|until|fi|done|esac|!)|(for\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+in\b[^;\n]*)?)|(case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in)|(?:function\s+[A-Za-z_][A-Za-z0-9_.-]*(?:\s*\(\s*\))?|[A-Za-z_][A-Za-z0-9_.-]*\s*\(\s*\)))(?=\s|[({]|$)/,
      );
    if (kwMatch) {
      leadingOffset += kwMatch[0].length;
      continue;
    }
    break;
  }
  const spans = tokenizeShellClauseWithSpans(s.slice(leadingOffset), { markLiterals: true });
  const bazelIdx = spans.findIndex((t) => {
    const exp = options?.env
      ? expandOrValidateShellPath(t.value, options.env, {
          taintedVars: options.taintedVars,
          shellType: options.shellType,
        })
      : null;
    const candidate = exp && !exp.unresolved && exp.resolved ? exp.resolved : t.value;
    return normalizeBuildToolName(stripLiteralSentinels(candidate)) === "bazel";
  });
  if (bazelIdx === -1) return corePart;
  const afterBazel = spans.slice(bazelIdx + 1).map((t) => stripLiteralSentinels(t.value));
  const subRelIdx = findBazelSubcommandIndex(
    afterBazel,
    new Set(["build", "test", "run", "coverage"]),
  );
  if (subRelIdx === -1) return corePart;
  const subSpan = spans[bazelIdx + 1 + subRelIdx];
  const insertPos = leadingOffset + subSpan.end;
  return `${s.slice(0, insertPos)} ${injectedFlags.join(" ")}${s.slice(insertPos)}`;
}

export function classifyBuildCommand(rawCmd, rawArgs = [], options = {}) {
  const {
    cmd,
    args,
    backgrounded,
    unresolvedDynamicCwd,
    unparseableShellReason,
    allBuildClauses,
  } = peelBuildWrapperTokens(rawCmd, rawArgs, options);
  if (backgrounded) {
    return {
      kind: "reject_long_running",
      tool: normalizeBuildToolName(cmd) || "multi",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      backgrounded: true,
      reason:
        "Backgrounded build commands (`&`) cannot be coordinated by atc exec because the shell exits before the build finishes.",
    };
  }
  if (allBuildClauses && allBuildClauses.length >= 1) {
    const clauseResults = allBuildClauses.map((c) => classifyBuildCommand(c.cmd, c.args));
    const deny = clauseResults.find((r) => r.kind === "deny_lifecycle");
    if (deny) return deny;
    const reject = clauseResults.find((r) => r.kind === "reject_long_running");
    if (reject) return reject;
    if (unresolvedDynamicCwd) {
      return {
        kind: "deny_lifecycle",
        denySubkind: unparseableShellReason ? "unparseable_shell" : "unresolved_cwd",
        tool: normalizeBuildToolName(cmd) || "multi",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        unresolvedDynamicCwd: true,
        reason:
          unparseableShellReason ||
          "Unresolved dynamic directory change in shell wrapper cannot be mapped to a workspace lock; expand or export the target directory variable before invoking atc exec.",
      };
    }
    if (allBuildClauses.length > 1) {
      const requiresDevice = clauseResults.some((r) => r.requiresDevice);
      const requiresHeavySlot = clauseResults.some((r) => r.requiresHeavySlot);
      const requiresWorkspaceLock = clauseResults.some((r) => r.requiresWorkspaceLock);
      const kind = requiresDevice
        ? "device_coupled_build"
        : requiresHeavySlot
          ? "pure_build"
          : requiresWorkspaceLock
            ? "workspace_only"
            : "not_build_tool";
      return {
        ...clauseResults[0],
        kind,
        targetPlatform: clauseResults.find((r) => r.targetPlatform)?.targetPlatform || null,
        requiresDevice,
        requiresHeavySlot,
        requiresWorkspaceLock,
      };
    }
  }
  if (unresolvedDynamicCwd) {
    return {
      kind: "deny_lifecycle",
      denySubkind: unparseableShellReason ? "unparseable_shell" : "unresolved_cwd",
      tool: normalizeBuildToolName(cmd) || "multi",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      unresolvedDynamicCwd: true,
      reason:
        unparseableShellReason ||
        "Unresolved dynamic directory change in shell wrapper cannot be mapped to a workspace lock; expand or export the target directory variable before invoking atc exec.",
    };
  }
  const tool = normalizeBuildToolName(cmd);
  if (!tool) {
    return {
      kind: "not_build_tool",
      tool: null,
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
    };
  }

  const strArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];

  if (tool === "gradle") {
    if (strArgs.includes("--stop")) {
      return {
        kind: "deny_lifecycle",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        reason:
          'Direct "gradle --stop" is disabled under ATC because it terminates shared Gradle daemons across all active worktrees.',
      };
    }
    if (
      strArgs.includes("--continuous") ||
      strArgs.includes("-t") ||
      strArgs.includes("--foreground")
    ) {
      return {
        kind: "reject_long_running",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: true,
        requiresWorkspaceLock: true,
        reason: strArgs.includes("--foreground")
          ? 'Long-running "gradle --foreground" cannot hold a coordinated build slot indefinitely; run bounded build tasks instead.'
          : 'Long-running "gradle --continuous" (-t) cannot hold a coordinated build slot indefinitely; run bounded build tasks instead.',
      };
    }

    const tasks = [];
    for (let i = 0; i < strArgs.length; i++) {
      const arg = strArgs[i];
      if (arg === "--") break;
      if (arg === "-x" || arg === "--exclude-task") {
        i++;
        continue;
      }
      if (arg.startsWith("--exclude-task=")) continue;
      if (GRADLE_VALUE_FLAGS.has(arg)) {
        i++;
        continue;
      }
      if (
        arg === "--version" ||
        arg === "-v" ||
        arg === "--help" ||
        arg === "-h" ||
        arg === "-?" ||
        arg === "--status"
      ) {
        tasks.push({ raw: arg, metaOnly: true });
        continue;
      }
      if (arg.startsWith("-")) continue;
      tasks.push({ raw: arg, metaOnly: false });
    }

    if (tasks.length > 0 && tasks.every((t) => t.metaOnly)) {
      return {
        kind: "read_only",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    const taskNames = tasks
      .filter((t) => !t.metaOnly)
      .map((t) => {
        const parts = t.raw.split(":");
        return parts[parts.length - 1];
      });

    if (taskNames.length > 0 && taskNames.every((name) => GRADLE_WORKSPACE_ONLY_TASKS.has(name))) {
      return {
        kind: "workspace_only",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: true,
        tasks: taskNames,
      };
    }

    const requiresDevice = taskNames.some(isGradleDeviceTaskName);
    return {
      kind: requiresDevice ? "device_coupled_build" : "pure_build",
      tool: "gradle",
      targetPlatform: requiresDevice ? "android" : null,
      requiresDevice,
      requiresHeavySlot: true,
      requiresWorkspaceLock: true,
      tasks: taskNames,
    };
  }

  if (tool === "bazel") {
    const subcmdIdx = findBazelSubcommandIndex(strArgs, BAZEL_SUBCOMMANDS);
    const subcmd = subcmdIdx >= 0 ? strArgs[subcmdIdx].toLowerCase() : null;
    const restArgs = subcmdIdx >= 0 ? strArgs.slice(subcmdIdx + 1) : strArgs;
    const dashDashIdx = restArgs.indexOf("--");
    const bazelFlags = dashDashIdx >= 0 ? restArgs.slice(0, dashDashIdx) : restArgs;

    const isBazelBoolFalse = (v) => /^(?:false|0|no|f|n)$/i.test(String(v || "").trim());
    let expungeEnabled = false;
    let expungeAsyncEnabled = false;
    for (const a of bazelFlags) {
      if (a === "--expunge") expungeEnabled = true;
      else if (a === "--noexpunge") expungeEnabled = false;
      else if (a.startsWith("--expunge=")) {
        expungeEnabled = !isBazelBoolFalse(a.slice("--expunge=".length));
      } else if (a === "--expunge_async") expungeAsyncEnabled = true;
      else if (a === "--noexpunge_async") expungeAsyncEnabled = false;
      else if (a.startsWith("--expunge_async=")) {
        expungeAsyncEnabled = !isBazelBoolFalse(a.slice("--expunge_async=".length));
      }
    }

    if (
      subcmd === "shutdown" ||
      (subcmd === "clean" && (expungeEnabled || expungeAsyncEnabled))
    ) {
      const label = subcmd === "clean" ? "bazel clean --expunge" : "bazel shutdown";
      return {
        kind: "deny_lifecycle",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        reason: `Direct "${label}" is disabled under ATC because it disrupts active workspace Bazel servers.`,
      };
    }

    if (
      !subcmd &&
      (strArgs.length === 0 ||
        strArgs.includes("--version") ||
        strArgs.includes("--help") ||
        strArgs.includes("-h"))
    ) {
      return {
        kind: "read_only",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    if (
      subcmd === "version" ||
      subcmd === "help" ||
      bazelFlags.includes("--version") ||
      bazelFlags.includes("--help") ||
      bazelFlags.includes("-h")
    ) {
      return {
        kind: "read_only",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    if (
      [
        "query",
        "cquery",
        "aquery",
        "fetch",
        "sync",
        "info",
        "dump",
        "config",
        "mod",
        "license",
        "clean",
      ].includes(subcmd)
    ) {
      return {
        kind: "workspace_only",
        tool: "bazel",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: true,
        subcommand: subcmd,
      };
    }

    const IOS_SIM_FLAG_RE =
      /^--(?:@[A-Za-z0-9_.-]*\/\/[^:=]+:|\/\/[^:=]+:)?ios_simulator_(?:device|version)(?:=|$)/;
    const hasIosDeviceFlag = restArgs.some((a) => IOS_SIM_FLAG_RE.test(String(a)));
    const hasAndroidDeviceFlag = restArgs.some(
      (a, idx) =>
        a === "--device" ||
        a.startsWith("--device=") ||
        a === "--test_arg=--device" ||
        a.startsWith("--test_arg=--device=") ||
        (a === "--test_arg" &&
          idx + 1 < restArgs.length &&
          (restArgs[idx + 1] === "--device" ||
            String(restArgs[idx + 1]).startsWith("--device="))),
    );
    const hasDeviceFlag = hasIosDeviceFlag || hasAndroidDeviceFlag;
    const requiresDevice =
      subcmd === "mobile-install" || ((subcmd === "test" || subcmd === "run") && hasDeviceFlag);
    const targetPlatform = requiresDevice ? (hasIosDeviceFlag ? "ios" : "android") : null;
    const selectors = [];
    for (let i = 0; i < restArgs.length; i++) {
      const a = String(restArgs[i]);
      if (a === "--") continue;
      if (a.startsWith("--device=")) {
        selectors.push(a.slice("--device=".length));
      } else if (a === "--device" && i + 1 < restArgs.length) {
        selectors.push(String(restArgs[++i]));
      } else if (a.startsWith("--test_arg=--device=")) {
        selectors.push(a.slice("--test_arg=--device=".length));
      } else if (a === "--test_arg=--device" && i + 1 < restArgs.length) {
        const nextArg = String(restArgs[i + 1]);
        if (nextArg.startsWith("--test_arg=")) {
          selectors.push(nextArg.slice("--test_arg=".length));
          i += 1;
        } else if (nextArg === "--test_arg" && i + 2 < restArgs.length) {
          selectors.push(String(restArgs[i + 2]));
          i += 2;
        }
      } else if (a === "--test_arg" && i + 1 < restArgs.length) {
        const testArgVal = String(restArgs[i + 1]);
        if (testArgVal.startsWith("--device=")) {
          selectors.push(testArgVal.slice("--device=".length));
          i += 1;
        } else if (testArgVal === "--device" && i + 2 < restArgs.length) {
          const nextPair = String(restArgs[i + 2]);
          if (nextPair === "--test_arg" && i + 3 < restArgs.length) {
            selectors.push(String(restArgs[i + 3]));
            i += 3;
          } else if (nextPair.startsWith("--test_arg=")) {
            selectors.push(nextPair.slice("--test_arg=".length));
            i += 2;
          }
        }
      } else if (
        /^--(?:@[A-Za-z0-9_.-]*\/\/[^:=]+:|\/\/[^:=]+:)?ios_simulator_device=/.test(a)
      ) {
        const val = a.slice(a.indexOf("=") + 1).trim();
        if (val) selectors.push(val);
      } else if (
        /^--(?:@[A-Za-z0-9_.-]*\/\/[^:=]+:|\/\/[^:=]+:)?ios_simulator_device$/.test(a) &&
        i + 1 < restArgs.length
      ) {
        const val = String(restArgs[++i]).trim();
        if (val) selectors.push(val);
      } else if (
        /^--(?:@[A-Za-z0-9_.-]*\/\/[^:=]+:|\/\/[^:=]+:)?ios_simulator_version=/.test(a)
      ) {
        const val = a.slice(a.indexOf("=") + 1).trim();
        if (val) selectors.push(`ios_simulator_version=${val}`);
      } else if (
        /^--(?:@[A-Za-z0-9_.-]*\/\/[^:=]+:|\/\/[^:=]+:)?ios_simulator_version$/.test(a) &&
        i + 1 < restArgs.length
      ) {
        const val = String(restArgs[++i]).trim();
        if (val) selectors.push(`ios_simulator_version=${val}`);
      }
    }
    const uniqueSelectors = Array.from(new Set(selectors.filter(Boolean)));
    const targetSerial =
      uniqueSelectors.length === 0
        ? null
        : uniqueSelectors.length === 1
          ? uniqueSelectors[0]
          : uniqueSelectors.join(",");

    if (subcmd === "run" && !requiresDevice) {
      let noRunEnabled = false;
      let hasScriptPath = false;
      for (const a of bazelFlags) {
        if (a === "--norun") noRunEnabled = true;
        else if (a === "--run") noRunEnabled = false;
        else if (a.startsWith("--norun=")) {
          noRunEnabled = !isBazelBoolFalse(a.slice("--norun=".length));
        } else if (a.startsWith("--run=")) {
          noRunEnabled = isBazelBoolFalse(a.slice("--run=".length));
        } else if (a.startsWith("--script_path")) {
          hasScriptPath = true;
        }
      }
      const boundedBuildOnly = noRunEnabled || hasScriptPath;
      if (!boundedBuildOnly) {
        return {
          kind: "reject_long_running",
          tool: "bazel",
          subcommand: subcmd,
          targetPlatform: null,
          targetSerial: null,
          requiresDevice: false,
          requiresHeavySlot: true,
          requiresWorkspaceLock: true,
          reason:
            'Unbounded "bazel run" can hold a build slot indefinitely; pass "--norun" or "--script_path" to build only, or run the built binary outside "atc exec --build".',
        };
      }
    }

    return {
      kind: requiresDevice ? "device_coupled_build" : "pure_build",
      tool: "bazel",
      targetPlatform,
      targetSerial,
      requiresDevice,
      requiresHeavySlot: true,
      requiresWorkspaceLock: true,
      subcommand: subcmd,
    };
  }

  if (tool === "xcodebuild") {
    if (
      strArgs.includes("-version") ||
      strArgs.includes("-showsdks") ||
      strArgs.includes("-usage") ||
      strArgs.includes("-help") ||
      strArgs.includes("--help")
    ) {
      return {
        kind: "read_only",
        tool: "xcodebuild",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
      };
    }

    if (
      strArgs.includes("-list") ||
      strArgs.includes("-showBuildSettings") ||
      strArgs.includes("-showDestinations") ||
      strArgs.includes("-showTestPlans")
    ) {
      return {
        kind: "workspace_only",
        tool: "xcodebuild",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: true,
      };
    }

    const buildActions = [];
    const destinations = [];
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "-destination" && i + 1 < strArgs.length) {
        destinations.push(strArgs[i + 1]);
        i++;
        continue;
      }
      if (a.startsWith("-destination=")) {
        destinations.push(a.slice("-destination=".length));
        continue;
      }
      if (XCODEBUILD_VALUE_FLAGS.has(a) && i + 1 < strArgs.length) {
        i++;
        continue;
      }
      if (a.startsWith("-") || a.includes("=")) continue;
      buildActions.push(a.toLowerCase());
    }

    const hasFullTest = buildActions.includes("test");
    const hasTestWithoutBuilding = buildActions.includes("test-without-building");
    const hasAnyTest = hasFullTest || hasTestWithoutBuilding;

    const isNonDeviceDestination =
      destinations.length > 0 &&
      destinations.every(
        (d) => /\bplatform=macOS\b/i.test(d) || /\bgeneric\/platform=/i.test(d),
      );

    const requiresDevice = hasAnyTest && !isNonDeviceDestination;
    const requiresHeavySlot =
      !hasTestWithoutBuilding ||
      hasFullTest ||
      buildActions.includes("build") ||
      buildActions.includes("build-for-testing") ||
      buildActions.includes("archive") ||
      buildActions.includes("analyze");

    if (requiresDevice) {
      return {
        kind: "device_coupled_build",
        tool: "xcodebuild",
        targetPlatform: "ios",
        requiresDevice: true,
        requiresHeavySlot,
        requiresWorkspaceLock: true,
        actions: buildActions,
      };
    }

    return {
      kind: requiresHeavySlot ? "pure_build" : "workspace_only",
      tool: "xcodebuild",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot,
      requiresWorkspaceLock: true,
      actions: buildActions,
    };
  }

  return {
    kind: "not_build_tool",
    tool: null,
    targetPlatform: null,
    requiresDevice: false,
    requiresHeavySlot: false,
    requiresWorkspaceLock: false,
  };
}

function findNearestMarkerAncestor(startDir, markerFiles) {
  let cur = path.resolve(startDir);
  for (let depth = 0; depth < 32; depth++) {
    for (const marker of markerFiles) {
      try {
        if (fs.existsSync(path.join(cur, marker))) {
          return cur;
        }
      } catch {
        // Ignore stat error
      }
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

export function resolveBuildResources(
  rawCmd,
  rawArgs = [],
  cwd = process.cwd(),
  {
    forceBuild = false,
    inheritedEnvVars = null,
    env = process.env,
    workspace = null,
    systemBazelrcPath = undefined,
    platform = undefined,
    bazelMajorVersion = undefined,
    bazelVersion = undefined,
    isBazelisk = undefined,
  } = {},
) {
  const baseEnv = { ...(env || process.env), ...(inheritedEnvVars || {}) };
  const outerCwd = path.resolve(cwd || process.cwd());
  const applyExplicitWorkspaceKeys = (res) => {
    if (
      !workspace ||
      !res ||
      res.kind === "deny_lifecycle" ||
      res.kind === "reject_long_running" ||
      res.kind === "read_only"
    ) {
      return res;
    }
    const canonicalExplicitWs = canonicalizeBuildPath(path.resolve(outerCwd, String(workspace)));
    const extraKeys = [`workspace:${canonicalExplicitWs}`];
    if (res.tool === "gradle") {
      const discovered = canonicalizeBuildPath(
        findNearestMarkerAncestor(canonicalExplicitWs, [
          "settings.gradle.kts",
          "settings.gradle",
          "gradlew",
          "gradlew.bat",
        ]) ||
          findNearestMarkerAncestor(canonicalExplicitWs, ["build.gradle.kts", "build.gradle"]) ||
          canonicalExplicitWs,
      );
      extraKeys.push(
        `gradle:${discovered}`,
        `gradle:${canonicalExplicitWs}`,
        `workspace:${discovered}`,
      );
    } else if (res.tool === "bazel") {
      const discovered = canonicalizeBuildPath(
        findNearestMarkerAncestor(canonicalExplicitWs, [
          "MODULE.bazel",
          "REPO.bazel",
          "WORKSPACE.bazel",
          "WORKSPACE",
        ]) || canonicalExplicitWs,
      );
      extraKeys.push(
        `bazel:ws:${discovered}`,
        `bazel:ws:${canonicalExplicitWs}`,
        `workspace:${discovered}`,
      );
    } else if (res.tool === "xcodebuild") {
      let xcodeDiscovered = canonicalExplicitWs;
      let cur = canonicalExplicitWs;
      for (let depth = 0; depth < 16; depth++) {
        try {
          const entries = fs.readdirSync(cur);
          if (entries.some((e) => e.endsWith(".xcworkspace") || e.endsWith(".xcodeproj"))) {
            xcodeDiscovered = canonicalizeBuildPath(cur);
            break;
          }
        } catch {
          break;
        }
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
      extraKeys.push(
        `xcode:${xcodeDiscovered}`,
        `xcode:${canonicalExplicitWs}`,
        `workspace:${xcodeDiscovered}`,
      );
    } else {
      const discovered = canonicalizeBuildPath(
        findNearestMarkerAncestor(canonicalExplicitWs, [
          "settings.gradle.kts",
          "settings.gradle",
          "gradlew",
          "MODULE.bazel",
          "REPO.bazel",
          "WORKSPACE.bazel",
          "WORKSPACE",
          "build.gradle.kts",
          "build.gradle",
        ]) || canonicalExplicitWs,
      );
      extraKeys.push(`workspace:${discovered}`);
    }
    return {
      ...res,
      workspaceRoot: res.workspaceRoot || canonicalExplicitWs,
      resourceKeys: Array.from(new Set([...(res.resourceKeys || []), ...extraKeys])),
    };
  };
  const {
    cmd,
    args,
    relCwd,
    envVars,
    backgrounded,
    unresolvedDynamicCwd,
    unparseableShellReason,
    hasUnresolvedCmd,
    allBuildClauses,
  } = peelBuildWrapperTokens(rawCmd, rawArgs, { env: baseEnv, cwd });
  if (backgrounded) {
    return {
      kind: "reject_long_running",
      tool: normalizeBuildToolName(cmd) || "multi",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      backgrounded: true,
      workspaceRoot: null,
      resourceKeys: [],
      reason:
        "Backgrounded build commands (`&`) cannot be coordinated by atc exec because the shell exits before the build finishes.",
    };
  }
  if (unresolvedDynamicCwd || (forceBuild && hasUnresolvedCmd)) {
    return {
      kind: "deny_lifecycle",
      denySubkind: unparseableShellReason ? "unparseable_shell" : "unresolved_cwd",
      tool: normalizeBuildToolName(cmd) || "multi",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      unresolvedDynamicCwd: true,
      workspaceRoot: null,
      resourceKeys: [],
      reason:
        unparseableShellReason ||
        "Unresolved dynamic directory change in shell wrapper cannot be mapped to a workspace lock; expand or export the target directory variable before invoking atc exec.",
    };
  }
  const effectiveEnvVars = { ...(inheritedEnvVars || {}), ...(envVars || {}) };
  if (allBuildClauses && allBuildClauses.length > 1) {
    const clauseRes = allBuildClauses.map((c) => {
      const clauseCwd = c.relCwd ? path.resolve(outerCwd, c.relCwd) : outerCwd;
      return resolveBuildResources(c.cmd, c.args, clauseCwd, {
        forceBuild: false,
        inheritedEnvVars: c.envVars || effectiveEnvVars,
        env,
        workspace,
        systemBazelrcPath,
        platform,
        bazelMajorVersion,
        bazelVersion,
      });
    });
    const deny = clauseRes.find((r) => r.kind === "deny_lifecycle");
    if (deny) return deny;
    const reject = clauseRes.find((r) => r.kind === "reject_long_running");
    if (reject) return reject;
    const devicePlatforms = Array.from(
      new Set(
        clauseRes
          .filter((r) => r.requiresDevice && r.targetPlatform)
          .map((r) => r.targetPlatform),
      ),
    );
    if (devicePlatforms.length > 1) {
      return {
        kind: "deny_lifecycle",
        tool: clauseRes[0]?.tool || "multi",
        targetPlatform: null,
        requiresDevice: true,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        workspaceRoot: null,
        resourceKeys: [],
        reason:
          "Mixed-platform device-coupled build clauses (Android + iOS) cannot share a single shell wrapper; run each platform's device build in its own atc exec invocation.",
      };
    }
    const requiresDevice = clauseRes.some((r) => r.requiresDevice);
    const requiresHeavySlot = clauseRes.some((r) => r.requiresHeavySlot);
    const requiresWorkspaceLock = clauseRes.some((r) => r.requiresWorkspaceLock);
    const kind = requiresDevice
      ? "device_coupled_build"
      : requiresHeavySlot
        ? "pure_build"
        : requiresWorkspaceLock
          ? "workspace_only"
          : "not_build_tool";
    return {
      ...clauseRes[0],
      kind,
      targetPlatform: clauseRes.find((r) => r.targetPlatform)?.targetPlatform || null,
      targetSerial: (() => {
        const clauseSerials = Array.from(
          new Set(
            clauseRes
              .flatMap((r) => (r.targetSerial ? String(r.targetSerial).split(",") : []))
              .filter(Boolean),
          ),
        );
        return clauseSerials.length === 0
          ? null
          : clauseSerials.length === 1
            ? clauseSerials[0]
            : clauseSerials.join(",");
      })(),
      requiresDevice,
      requiresHeavySlot,
      requiresWorkspaceLock,
      disablesDaemon: clauseRes.some((r) => r.disablesDaemon),
      requestedHeapMb: Math.max(0, ...clauseRes.map((r) => r.requestedHeapMb || 0)),
      workspaceRoot: clauseRes.find((r) => r.workspaceRoot)?.workspaceRoot || null,
      resourceKeys: Array.from(new Set(clauseRes.flatMap((r) => r.resourceKeys || []))),
      clauseBuildReqs: clauseRes.filter((r) => r.requiresHeavySlot),
    };
  }
  let classified = classifyBuildCommand(cmd, args);
  const baseCwd = relCwd ? path.resolve(outerCwd, relCwd) : outerCwd;
  if (classified.kind === "not_build_tool") {
    if (forceBuild) {
      const canonicalRoot = canonicalizeBuildPath(
        workspace ? path.resolve(outerCwd, String(workspace)) : baseCwd,
      );
      return applyExplicitWorkspaceKeys({
        kind: "pure_build",
        tool: "custom",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: true,
        requiresWorkspaceLock: true,
        workspaceRoot: canonicalRoot,
        resourceKeys: [`workspace:${canonicalRoot}`],
      });
    }
    return {
      ...classified,
      workspaceRoot: null,
      resourceKeys: [],
    };
  }
  if (!classified.requiresWorkspaceLock) {
    return {
      ...classified,
      workspaceRoot: null,
      resourceKeys: [],
    };
  }

  const strArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];

  if (classified.tool === "gradle") {
    let projectDir = null;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--") break;
      if ((a === "-p" || a === "--project-dir") && i + 1 < strArgs.length) {
        projectDir = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("--project-dir=")) {
        projectDir = path.resolve(baseCwd, a.slice("--project-dir=".length));
      } else if (a.startsWith("-p=") && a.length > 3) {
        projectDir = path.resolve(baseCwd, a.slice(3));
      }
    }

    let searchStart = projectDir;
    if (!searchStart && cmd && (cmd.includes("/") || cmd.includes("\\"))) {
      const resolvedCmd = path.resolve(baseCwd, cmd);
      try {
        if (fs.existsSync(resolvedCmd) && fs.statSync(resolvedCmd).isFile()) {
          searchStart = path.dirname(resolvedCmd);
        }
      } catch {
        // Fallback to baseCwd
      }
    }
    if (!searchStart) {
      searchStart = baseCwd;
    }

    const rootDir =
      findNearestMarkerAncestor(searchStart, [
        "settings.gradle.kts",
        "settings.gradle",
        "gradlew",
        "gradlew.bat",
      ]) ||
      findNearestMarkerAncestor(searchStart, ["build.gradle.kts", "build.gradle"]) ||
      searchStart;

    const canonicalRoot = canonicalizeBuildPath(rootDir);
    const envJavaHomeUnset =
      effectiveEnvVars.JAVA_HOME === null || effectiveEnvVars.JAVA_HOME === "";
    const envPathUnset =
      effectiveEnvVars.PATH === null || effectiveEnvVars.PATH === "";
    const envGradleUserHomeUnset =
      effectiveEnvVars.GRADLE_USER_HOME === null || effectiveEnvVars.GRADLE_USER_HOME === "";
    const envGradleHomeUnset =
      effectiveEnvVars.GRADLE_HOME === null || effectiveEnvVars.GRADLE_HOME === "";
    const envLcAllUnset =
      effectiveEnvVars.LC_ALL === null || effectiveEnvVars.LC_ALL === "";
    const envLcMessagesUnset =
      effectiveEnvVars.LC_MESSAGES === null || effectiveEnvVars.LC_MESSAGES === "";
    const envLangUnset =
      effectiveEnvVars.LANG === null || effectiveEnvVars.LANG === "";
    let cliGradleUserHome = null;
    let hasCliGradleJvmArgs = false;
    let cliHeapMb = 0;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--") break;
      if ((a === "-g" || a === "--gradle-user-home") && i + 1 < strArgs.length) {
        cliGradleUserHome = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("--gradle-user-home=")) {
        cliGradleUserHome = path.resolve(baseCwd, a.slice("--gradle-user-home=".length));
      } else if (a.startsWith("-Dgradle.user.home=")) {
        cliGradleUserHome = path.resolve(baseCwd, a.slice("-Dgradle.user.home=".length));
      } else if (a.startsWith("-Dorg.gradle.jvmargs=")) {
        hasCliGradleJvmArgs = true;
        cliHeapMb = parseJvmHeapMb(a.slice("-Dorg.gradle.jvmargs=".length));
      }
    }
    const effectiveGradleHomeEnv = envGradleHomeUnset
      ? null
      : effectiveEnvVars.GRADLE_HOME || baseEnv.GRADLE_HOME || null;
    const resolvedGradleHome =
      effectiveGradleHomeEnv && effectiveGradleHomeEnv !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? path.resolve(baseCwd, effectiveGradleHomeEnv)
        : null;
    const effectiveGradleUserHomeEnv = envGradleUserHomeUnset
      ? null
      : effectiveEnvVars.GRADLE_USER_HOME || baseEnv.GRADLE_USER_HOME || null;
    const effectiveHomeEnv =
      effectiveEnvVars.HOME === null || effectiveEnvVars.HOME === ""
        ? null
        : effectiveEnvVars.HOME || baseEnv.HOME || os.homedir() || null;
    const resolvedGradleUserHome =
      cliGradleUserHome ||
      (effectiveGradleUserHomeEnv && effectiveGradleUserHomeEnv !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? path.resolve(baseCwd, effectiveGradleUserHomeEnv)
        : !envGradleUserHomeUnset &&
            effectiveHomeEnv &&
            effectiveHomeEnv !== "__UNRESOLVED_DYNAMIC_ENV__"
          ? path.join(path.resolve(baseCwd, effectiveHomeEnv), ".gradle")
          : null);
    let propsDaemonDisabled = false;
    let propsHeapMb = 0;
    const daemonJvmCriteriaPath = path.join(
      canonicalRoot,
      "gradle",
      "gradle-daemon-jvm.properties",
    );
    try {
      if (
        fs.existsSync(daemonJvmCriteriaPath) &&
        parseJavaProperties(fs.readFileSync(daemonJvmCriteriaPath, "utf8")).size > 0
      ) {
        propsDaemonDisabled = true;
      }
    } catch {
      // Ignore daemon JVM criteria read errors
    }
    const gradlePropsFiles = [
      ...(resolvedGradleHome ? [path.join(resolvedGradleHome, "gradle.properties")] : []),
      path.join(canonicalRoot, "gradle.properties"),
      ...(resolvedGradleUserHome ? [path.join(resolvedGradleUserHome, "gradle.properties")] : []),
    ];
    let propsReadError = false;
    for (const gradlePropsPath of gradlePropsFiles) {
      try {
        if (fs.existsSync(gradlePropsPath)) {
          const propsMap = parseJavaProperties(fs.readFileSync(gradlePropsPath, "utf8"));
          if (propsMap.has("org.gradle.daemon")) {
            propsDaemonDisabled =
              String(propsMap.get("org.gradle.daemon")).trim().toLowerCase() === "false";
          }
          if (propsMap.has("org.gradle.jvmargs")) {
            propsHeapMb = parseJvmHeapMb(propsMap.get("org.gradle.jvmargs"));
          }
        }
      } catch {
        propsReadError = true;
      }
    }
    const envGradleOpts =
      effectiveEnvVars.GRADLE_OPTS === null || effectiveEnvVars.GRADLE_OPTS === ""
        ? null
        : effectiveEnvVars.GRADLE_OPTS || baseEnv.GRADLE_OPTS || null;
    const envJavaOpts =
      effectiveEnvVars.JAVA_OPTS === null || effectiveEnvVars.JAVA_OPTS === ""
        ? null
        : effectiveEnvVars.JAVA_OPTS || baseEnv.JAVA_OPTS || null;
    const envUnderscoreJavaOptions =
      effectiveEnvVars._JAVA_OPTIONS === null || effectiveEnvVars._JAVA_OPTIONS === ""
        ? null
        : effectiveEnvVars._JAVA_OPTIONS || baseEnv._JAVA_OPTIONS || null;
    const envJavaToolOptions =
      effectiveEnvVars.JAVA_TOOL_OPTIONS === null || effectiveEnvVars.JAVA_TOOL_OPTIONS === ""
        ? null
        : effectiveEnvVars.JAVA_TOOL_OPTIONS || baseEnv.JAVA_TOOL_OPTIONS || null;
    const underscoreJavaHeapMb = parseJvmHeapMb(envUnderscoreJavaOptions);
    const optsHeapMb = Math.max(
      parseJvmHeapMb(envGradleOpts),
      parseJvmHeapMb(envJavaOpts),
      underscoreJavaHeapMb,
      parseJvmHeapMb(envJavaToolOptions),
    );
    const requestedHeapMb = Math.max(
      hasCliGradleJvmArgs ? cliHeapMb : propsHeapMb,
      optsHeapMb,
    );
    const disablesDaemon =
      propsDaemonDisabled ||
      propsReadError ||
      Boolean(
        envGradleOpts || envJavaOpts || envUnderscoreJavaOptions || envJavaToolOptions,
      ) ||
      strArgs.some(
        (a) =>
          a === "--no-daemon" ||
          a === "-Dorg.gradle.daemon=false" ||
          a.startsWith("-Dorg.gradle.jvmargs=") ||
          a.startsWith("-Dorg.gradle.java.home=") ||
          a === "--java-home" ||
          a.startsWith("--java-home=") ||
          a === "-g" ||
          a === "--gradle-user-home" ||
          a.startsWith("--gradle-user-home=") ||
          a.startsWith("-Dgradle.user.home="),
      );
    return applyExplicitWorkspaceKeys({
      ...classified,
      disablesDaemon,
      requestedHeapMb,
      gradleHomeDir: resolvedGradleHome,
      envGradleHomeUnset,
      gradleUserHomeDir: resolvedGradleUserHome,
      envJavaHome: envJavaHomeUnset ? "" : effectiveEnvVars.JAVA_HOME || null,
      envJavaHomeUnset,
      envPath: envPathUnset ? "" : effectiveEnvVars.PATH || null,
      envPathUnset,
      envGradleUserHome: envGradleUserHomeUnset ? "" : effectiveEnvVars.GRADLE_USER_HOME || null,
      envGradleUserHomeUnset,
      envLcAll: envLcAllUnset ? "" : effectiveEnvVars.LC_ALL || null,
      envLcAllUnset,
      envLcMessages: envLcMessagesUnset ? "" : effectiveEnvVars.LC_MESSAGES || null,
      envLcMessagesUnset,
      envLang: envLangUnset ? "" : effectiveEnvVars.LANG || null,
      envLangUnset,
      workspaceRoot: canonicalRoot,
      resourceKeys: [`gradle:${canonicalRoot}`],
    });
  }

  if (classified.tool === "bazel") {
    const rootDir =
      findNearestMarkerAncestor(baseCwd, [
        "MODULE.bazel",
        "REPO.bazel",
        "WORKSPACE.bazel",
        "WORKSPACE",
      ]) || baseCwd;
    const canonicalRoot = canonicalizeBuildPath(rootDir);

    let outputBase = null;
    let outputUserRoot = null;
    let batchMode = false;
    let hasCustomStartupOption = false;
    let requestedHeapMb = 0;
    let ignoreAllRc = false;
    let noSystemRc = false;
    let noWorkspaceRc = false;
    let noHomeRc = false;
    const explicitBazelrcPaths = [];

    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--ignore_all_rc_files") {
        ignoreAllRc = true;
        continue;
      }
      if (a === "--noignore_all_rc_files") {
        ignoreAllRc = false;
        continue;
      }
      if (a === "--nosystem_rc") {
        noSystemRc = true;
        continue;
      }
      if (a === "--system_rc") {
        noSystemRc = false;
        continue;
      }
      if (a === "--noworkspace_rc") {
        noWorkspaceRc = true;
        continue;
      }
      if (a === "--workspace_rc") {
        noWorkspaceRc = false;
        continue;
      }
      if (a === "--nohome_rc") {
        noHomeRc = true;
        continue;
      }
      if (a === "--home_rc") {
        noHomeRc = false;
        continue;
      }
      if (a === "--bazelrc" && i + 1 < strArgs.length) {
        explicitBazelrcPaths.push(strArgs[++i]);
        continue;
      }
      if (a.startsWith("--bazelrc=")) {
        explicitBazelrcPaths.push(a.slice("--bazelrc=".length));
        continue;
      }
      if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith("-") && BAZEL_SUBCOMMANDS.has(a)) {
        break;
      }
    }

    const resolveBazelPath = (resolveBaseDir, val) => {
      const s = String(val || "");
      const b = String(resolveBaseDir || "");
      if (
        /^[a-zA-Z]:[\\/]/.test(s) ||
        s.startsWith("\\\\") ||
        /^[a-zA-Z]:[\\/]/.test(b) ||
        b.startsWith("\\\\")
      ) {
        return path.win32.resolve(b || ".", s);
      }
      return path.resolve(resolveBaseDir, s);
    };
    const ambiguousOutputBases = new Set();
    const ambiguousOutputUserRoots = new Set();
    const applyStartupOptionTokens = (tokens, resolveBaseDir, { ambiguous = false } = {}) => {
      const expandWs = (val) =>
        String(val || "").replace(/%workspace%/g, canonicalRoot);
      for (let i = 0; i < tokens.length; i++) {
        const a = tokens[i];
        if (a === "--batch") {
          batchMode = true;
          continue;
        }
        if (a === "--nobatch") {
          if (ambiguous) {
            hasCustomStartupOption = true;
          } else {
            batchMode = false;
          }
          continue;
        }
        if (a === "--output_base" && i + 1 < tokens.length) {
          const nextOut = resolveBazelPath(resolveBaseDir, expandWs(tokens[++i]));
          if (ambiguous) {
            if (outputBase && outputBase !== nextOut) ambiguousOutputBases.add(outputBase);
            ambiguousOutputBases.add(nextOut);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputBases.clear();
          }
          outputBase = nextOut;
          continue;
        }
        if (a.startsWith("--output_base=")) {
          const nextOut = resolveBazelPath(
            resolveBaseDir,
            expandWs(a.slice("--output_base=".length)),
          );
          if (ambiguous) {
            if (outputBase && outputBase !== nextOut) ambiguousOutputBases.add(outputBase);
            ambiguousOutputBases.add(nextOut);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputBases.clear();
          }
          outputBase = nextOut;
          continue;
        }
        if (a === "--output_user_root" && i + 1 < tokens.length) {
          const nextRoot = resolveBazelPath(resolveBaseDir, expandWs(tokens[++i]));
          if (ambiguous) {
            if (outputUserRoot && outputUserRoot !== nextRoot) {
              ambiguousOutputUserRoots.add(outputUserRoot);
            }
            ambiguousOutputUserRoots.add(nextRoot);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputUserRoots.clear();
          }
          outputUserRoot = nextRoot;
          continue;
        }
        if (a.startsWith("--output_user_root=")) {
          const nextRoot = resolveBazelPath(
            resolveBaseDir,
            expandWs(a.slice("--output_user_root=".length)),
          );
          if (ambiguous) {
            if (outputUserRoot && outputUserRoot !== nextRoot) {
              ambiguousOutputUserRoots.add(outputUserRoot);
            }
            ambiguousOutputUserRoots.add(nextRoot);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputUserRoots.clear();
          }
          outputUserRoot = nextRoot;
          continue;
        }
        if (a === "--host_jvm_args" && i + 1 < tokens.length) {
          hasCustomStartupOption = true;
          requestedHeapMb = Math.max(requestedHeapMb, parseJvmHeapMb(tokens[++i]));
          continue;
        }
        if (a.startsWith("--host_jvm_args=")) {
          hasCustomStartupOption = true;
          requestedHeapMb = Math.max(
            requestedHeapMb,
            parseJvmHeapMb(a.slice("--host_jvm_args=".length)),
          );
          continue;
        }
        if (a === "--bazelrc" && i + 1 < tokens.length) {
          i++;
          continue;
        }
        if (
          a.startsWith("--bazelrc=") ||
          a === "--ignore_all_rc_files" ||
          a === "--noignore_all_rc_files" ||
          a === "--nosystem_rc" ||
          a === "--system_rc" ||
          a === "--noworkspace_rc" ||
          a === "--workspace_rc" ||
          a === "--nohome_rc" ||
          a === "--home_rc"
        ) {
          continue;
        }
        if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
          hasCustomStartupOption = true;
          i++;
          continue;
        }
        if (!a.startsWith("-") && BAZEL_SUBCOMMANDS.has(a)) {
          break;
        }
        if (a.startsWith("-")) {
          hasCustomStartupOption = true;
        }
      }
    };

    const subcmdIdx = findBazelSubcommandIndex(strArgs, BAZEL_SUBCOMMANDS);
    const subcmd = classified.subcommand
      ? String(classified.subcommand).toLowerCase()
      : subcmdIdx >= 0
        ? strArgs[subcmdIdx].toLowerCase()
        : null;
    const cliRestArgs = subcmdIdx >= 0 ? strArgs.slice(subcmdIdx + 1) : strArgs;
    let rcEntrySeq = 0;
    const rcCommandEntries = [];
    const rcConfigEntriesByName = new Map();
    const getRcCommandRank = (rcCmd, targetSubcmd) => {
      if (!targetSubcmd) return -1;
      if (rcCmd === "always") return 0;
      if (rcCmd === "common") return 1;
      if (
        rcCmd === "build" &&
        [
          "build",
          "test",
          "run",
          "coverage",
          "mobile-install",
          "cquery",
          "aquery",
          "info",
          "sync",
          "fetch",
          "clean",
        ].includes(targetSubcmd)
      ) {
        return targetSubcmd === "build" ? 4 : 2;
      }
      if (rcCmd === "test" && (targetSubcmd === "test" || targetSubcmd === "coverage")) {
        return targetSubcmd === "test" ? 4 : 3;
      }
      if (rcCmd === targetSubcmd) return 4;
      return -1;
    };

    const parseBazelVersionRange = (rawVer) => {
      if (rawVer === null || rawVer === undefined || rawVer === "") return null;
      const s = String(rawVer).trim();
      const m = s.match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+][A-Za-z0-9_.-]+)?$/i);
      if (!m) return null;
      const maj = Number(m[1]);
      if (!Number.isFinite(maj) || maj <= 0) return null;
      const hasMin = m[2] !== undefined && m[2].toLowerCase() !== "x" && m[2] !== "*";
      const min = hasMin ? Number(m[2]) : 0;
      const hasPatch =
        hasMin && m[3] !== undefined && m[3].toLowerCase() !== "x" && m[3] !== "*";
      const patch = hasPatch ? Number(m[3]) : 0;
      return {
        major: maj,
        min: [maj, hasMin ? min : 0, hasPatch ? patch : 0],
        max: [
          maj,
          hasMin ? min : Number.MAX_SAFE_INTEGER,
          hasPatch ? patch : Number.MAX_SAFE_INTEGER,
        ],
      };
    };

    const isBazeliskLauncher = (() => {
      if (typeof isBazelisk === "boolean") return isBazelisk;
      const cleanedCmd = stripLiteralSentinels(String(cmd || "")).trim().replace(/^@+/, "");
      const baseCmd = (cleanedCmd.split(/[\\/]/).pop() || "")
        .toLowerCase()
        .replace(/\.(exe|cmd|bat|com|sh)$/i, "");
      if (baseCmd === "bazelisk" || baseCmd === "bazelw") return true;
      if (baseCmd === "bazel" && (cleanedCmd.includes("/") || cleanedCmd.includes("\\"))) {
        try {
          const candidatePath = path.resolve(baseCwd, cleanedCmd);
          if (fs.existsSync(candidatePath)) {
            const real = (fs.realpathSync.native || fs.realpathSync)(candidatePath);
            const realBase = (real.split(/[\\/]/).pop() || "")
              .toLowerCase()
              .replace(/\.(exe|cmd|bat|com|sh)$/i, "");
            if (realBase.includes("bazelisk") || realBase === "bazelw") {
              return true;
            }
          }
        } catch {
          // Ignore realpath errors
        }
      }
      return false;
    })();
    const rawUseBazelVersion =
      effectiveEnvVars.USE_BAZEL_VERSION === null || effectiveEnvVars.USE_BAZEL_VERSION === ""
        ? null
        : effectiveEnvVars.USE_BAZEL_VERSION || baseEnv.USE_BAZEL_VERSION || null;
    const dotBazelversionRaw = isBazeliskLauncher
      ? (() => {
          try {
            const bvPath = path.join(canonicalRoot, ".bazelversion");
            if (fs.existsSync(bvPath) && fs.statSync(bvPath).isFile()) {
              const firstLine = fs
                .readFileSync(bvPath, "utf8")
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find((l) => Boolean(l) && !l.startsWith("#"));
              return firstLine || null;
            }
          } catch {
            // Ignore unreadable .bazelversion
          }
          return null;
        })()
      : null;
    const bazelVersionRange =
      parseBazelVersionRange(bazelVersion) ||
      parseBazelVersionRange(bazelMajorVersion) ||
      (isBazeliskLauncher &&
      rawUseBazelVersion &&
      rawUseBazelVersion !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? parseBazelVersionRange(rawUseBazelVersion)
        : null) ||
      (isBazeliskLauncher ? parseBazelVersionRange(dotBazelversionRaw) : null);

    const rawBazelMajor =
      bazelVersionRange?.major ??
      (bazelMajorVersion !== null && bazelMajorVersion !== undefined && bazelMajorVersion !== ""
        ? Number(bazelMajorVersion)
        : null);
    const effectiveBazelMajor =
      rawBazelMajor !== null && Number.isFinite(rawBazelMajor) && rawBazelMajor > 0
        ? rawBazelMajor
        : null;

    const cmpSemverTuple = (a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    };

    const evaluateBazelVersionCondition = (condStr, range) => {
      const m = String(condStr || "")
        .trim()
        .match(/^(~|==|!=|<=|>=|<|>|=)(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][A-Za-z0-9_.-]+)?$/);
      if (!m || !range) return "ambiguous";
      const op = m[1] === "=" ? "==" : m[1];
      const cMaj = Number(m[2]);
      const hasMin = m[3] !== undefined;
      const cMin = hasMin ? Number(m[3]) : 0;
      const hasPatch = m[4] !== undefined;
      const cPatch = hasPatch ? Number(m[4]) : 0;
      const target = [cMaj, cMin, cPatch];
      const testSingle = (v) => {
        if (op === "==") {
          if (!hasMin) return v[0] === cMaj;
          return cmpSemverTuple(v, target) === 0;
        }
        if (op === "!=") {
          if (!hasMin) return v[0] !== cMaj;
          return cmpSemverTuple(v, target) !== 0;
        }
        if (op === ">=") return cmpSemverTuple(v, target) >= 0;
        if (op === "<=") return cmpSemverTuple(v, target) <= 0;
        if (op === ">") return cmpSemverTuple(v, target) > 0;
        if (op === "<") return cmpSemverTuple(v, target) < 0;
        if (op === "~") {
          if (cmpSemverTuple(v, target) < 0) return false;
          return hasMin ? v[0] === cMaj && v[1] === cMin : v[0] === cMaj;
        }
        return false;
      };
      if (cmpSemverTuple(range.min, range.max) === 0) {
        return testSingle(range.min) ? "true" : "false";
      }
      if (op === "!=") {
        if (!hasMin) {
          if (range.max[0] < cMaj || range.min[0] > cMaj) return "true";
          if (range.min[0] === cMaj && range.max[0] === cMaj) return "false";
          return "ambiguous";
        }
        if (
          cmpSemverTuple(target, range.min) < 0 ||
          cmpSemverTuple(target, range.max) > 0
        ) {
          return "true";
        }
        return "ambiguous";
      }
      const minSat = testSingle(range.min);
      const maxSat = testSingle(range.max);
      if (minSat && maxSat) return "true";
      if (!minSat && !maxSat) {
        const targetInsideRange =
          cmpSemverTuple(target, range.min) >= 0 && cmpSemverTuple(target, range.max) <= 0;
        if (!targetInsideRange) return "false";
      }
      return "ambiguous";
    };

    const effectiveHostPlatform = platform || process.platform;
    const hostBazelOsName =
      effectiveHostPlatform === "darwin"
        ? "macos"
        : effectiveHostPlatform === "win32"
          ? "windows"
          : effectiveHostPlatform === "linux"
            ? "linux"
            : effectiveHostPlatform === "freebsd"
              ? "freebsd"
              : effectiveHostPlatform === "openbsd"
                ? "openbsd"
                : null;
    const BAZEL_KNOWN_STARTUP_OS_NAMES = new Set([
      "linux",
      "macos",
      "windows",
      "freebsd",
      "openbsd",
      "unknown",
    ]);

    if (!ignoreAllRc) {
      const seenTopLevelRcs = new Set();
      const rcUnqualifiedStartupGroups = [];
      const rcOsStartupGroups = [];
      const parseBazelrcFile = (
        rcPath,
        {
          required = false,
          depth = 0,
          activeStack = new Set(),
          ambiguousCondition = false,
        } = {},
      ) => {
        if (!rcPath || rcPath === "/dev/null" || rcPath.toUpperCase() === "NUL") return;
        if (depth > 8) {
          hasCustomStartupOption = true;
          return;
        }
        const resolvedRc = canonicalizeBuildPath(rcPath, { platform });
        if (depth === 0 && seenTopLevelRcs.has(resolvedRc)) {
          return;
        }
        if (activeStack.has(resolvedRc)) {
          hasCustomStartupOption = true;
          return;
        }
        let content;
        try {
          if (!fs.existsSync(resolvedRc)) {
            if (required) hasCustomStartupOption = true;
            return;
          }
          content = fs.readFileSync(resolvedRc, "utf8");
        } catch {
          if (required) hasCustomStartupOption = true;
          return;
        }
        if (depth === 0) {
          seenTopLevelRcs.add(resolvedRc);
        }
        const nextStack = new Set(activeStack);
        nextStack.add(resolvedRc);
        const rcDir = path.dirname(resolvedRc);
        for (const rawLine of joinBackslashContinuations(content)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const condImportMatch = line.match(/^try-import-if-bazel-version\s+(\S+)\s+(.+)$/);
          if (condImportMatch) {
            const condStr = condImportMatch[1];
            const evalRes = evaluateBazelVersionCondition(condStr, bazelVersionRange);
            if (evalRes === "false") {
              continue;
            }
            const rawTarget = condImportMatch[2]
              .trim()
              .replace(/^['"]|['"]$/g, "")
              .replace(/%workspace%/g, canonicalRoot);
            const targetPath = path.resolve(rcDir, rawTarget);
            parseBazelrcFile(targetPath, {
              required: false,
              depth: depth + 1,
              activeStack: nextStack,
              ambiguousCondition: ambiguousCondition || evalRes === "ambiguous",
            });
            continue;
          }
          const importMatch = line.match(/^(import|try-import)\s+(.+)$/);
          if (importMatch) {
            const isRequiredImport = importMatch[1] === "import";
            const rawTarget = importMatch[2]
              .trim()
              .replace(/^['"]|['"]$/g, "")
              .replace(/%workspace%/g, canonicalRoot);
            const targetPath = path.resolve(rcDir, rawTarget);
            parseBazelrcFile(targetPath, {
              required: isRequiredImport,
              depth: depth + 1,
              activeStack: nextStack,
              ambiguousCondition,
            });
            continue;
          }
          const startupMatch = line.match(/^startup(?::([A-Za-z0-9_.-]+))?\s+(.+)$/);
          if (startupMatch) {
            const startupConfig = startupMatch[1] ? startupMatch[1].toLowerCase() : null;
            if (startupConfig) {
              if (hostBazelOsName && startupConfig === hostBazelOsName) {
                rcOsStartupGroups.push({
                  tokens: splitShellWords(startupMatch[2]),
                  baseDir: canonicalRoot,
                  ambiguous: ambiguousCondition,
                });
              } else if (!BAZEL_KNOWN_STARTUP_OS_NAMES.has(startupConfig)) {
                hasCustomStartupOption = true;
              }
              continue;
            }
            rcUnqualifiedStartupGroups.push({
              tokens: splitShellWords(startupMatch[2]),
              baseDir: canonicalRoot,
              ambiguous: ambiguousCondition,
            });
            continue;
          }
          const cmdMatch = line.match(/^([A-Za-z0-9_.-]+)(?::([A-Za-z0-9_.-]+))?\s+(.+)$/);
          if (cmdMatch) {
            const rcCmd = cmdMatch[1].toLowerCase();
            const rcConfig = cmdMatch[2] || null;
            const rank = getRcCommandRank(rcCmd, subcmd);
            if (rank >= 0) {
              const tokens = splitShellWords(cmdMatch[3]).map((t) =>
                String(t).replace(/%workspace%/g, canonicalRoot),
              );
              const entry = { rank, seq: rcEntrySeq++, tokens };
              if (!rcConfig) {
                rcCommandEntries.push(entry);
              } else {
                const prev = rcConfigEntriesByName.get(rcConfig) || [];
                prev.push(entry);
                rcConfigEntriesByName.set(rcConfig, prev);
              }
            }
          }
        }
      };

      if (!noSystemRc) {
        const effectivePlatform = platform || process.platform;
        const resolvedSystemRc =
          systemBazelrcPath !== undefined
            ? systemBazelrcPath
            : effectivePlatform === "win32"
              ? (() => {
                  const progData =
                    effectiveEnvVars.ProgramData ||
                    effectiveEnvVars.PROGRAMDATA ||
                    baseEnv.ProgramData ||
                    baseEnv.PROGRAMDATA ||
                    "C:\\ProgramData";
                  return progData.includes("\\") || /^[A-Za-z]:/.test(progData)
                    ? path.win32.join(progData, "bazel.bazelrc")
                    : path.join(progData, "bazel.bazelrc");
                })()
              : "/etc/bazel.bazelrc";
        if (resolvedSystemRc) {
          parseBazelrcFile(resolvedSystemRc, { required: false });
        }
      }
      if (!noWorkspaceRc) {
        parseBazelrcFile(path.join(canonicalRoot, ".bazelrc"), { required: false });
      }
      const effectiveHomeForBazel =
        effectiveEnvVars.HOME === null || effectiveEnvVars.HOME === ""
          ? null
          : effectiveEnvVars.HOME || baseEnv.HOME || os.homedir() || null;
      if (
        !noHomeRc &&
        effectiveHomeForBazel &&
        effectiveHomeForBazel !== "__UNRESOLVED_DYNAMIC_ENV__"
      ) {
        parseBazelrcFile(path.join(path.resolve(baseCwd, effectiveHomeForBazel), ".bazelrc"), {
          required: false,
        });
      }
      const effectiveBazelrcEnv =
        effectiveEnvVars.BAZELRC === null || effectiveEnvVars.BAZELRC === ""
          ? null
          : effectiveEnvVars.BAZELRC !== undefined
            ? String(effectiveEnvVars.BAZELRC)
            : baseEnv.BAZELRC
              ? String(baseEnv.BAZELRC)
              : null;
      let hitNullRcSentinel = false;
      if (effectiveBazelMajor === null || effectiveBazelMajor >= 9) {
        if (effectiveBazelrcEnv === "__UNRESOLVED_DYNAMIC_ENV__") {
          hasCustomStartupOption = true;
        } else if (effectiveBazelrcEnv) {
          if (effectiveBazelMajor === null) {
            hasCustomStartupOption = true;
          }
          for (const rawEnvRc of effectiveBazelrcEnv.split(",")) {
            if (!rawEnvRc) continue;
            if (rawEnvRc === "/dev/null" || rawEnvRc.toUpperCase() === "NUL") {
              hitNullRcSentinel = true;
              break;
            }
            const expandedRc = String(rawEnvRc).replace(/%workspace%/g, canonicalRoot);
            parseBazelrcFile(resolveBazelPath(baseCwd, expandedRc), { required: true });
          }
        }
      }
      if (!hitNullRcSentinel) {
        for (const rawExplicitRc of explicitBazelrcPaths) {
          if (rawExplicitRc === "/dev/null" || rawExplicitRc.toUpperCase() === "NUL") break;
          const expandedRc = String(rawExplicitRc).replace(/%workspace%/g, canonicalRoot);
          parseBazelrcFile(resolveBazelPath(baseCwd, expandedRc), { required: true });
        }
      }
      for (const grp of rcUnqualifiedStartupGroups) {
        applyStartupOptionTokens(grp.tokens, grp.baseDir, { ambiguous: grp.ambiguous });
      }
      for (const grp of rcOsStartupGroups) {
        applyStartupOptionTokens(grp.tokens, grp.baseDir, { ambiguous: grp.ambiguous });
      }
    }

    if (subcmd && (rcCommandEntries.length > 0 || rcConfigEntriesByName.size > 0)) {
      const flattenSortedEntries = (entries) =>
        [...(entries || [])]
          .sort((a, b) => a.rank - b.rank || a.seq - b.seq)
          .flatMap((e) => e.tokens);
      const rcCommandTokens = flattenSortedEntries(rcCommandEntries);
      const rcConfigTokensByName = new Map();
      for (const [k, entries] of rcConfigEntriesByName.entries()) {
        rcConfigTokensByName.set(k, flattenSortedEntries(entries));
      }
      const expandConfigTokens = (tokens, depth = 0, activeStack = new Set()) => {
        if (depth > 8) return [];
        const out = [];
        for (let i = 0; i < tokens.length; i++) {
          const tok = String(tokens[i] || "");
          if (tok === "--") break;
          let cfgName = null;
          if (tok === "--config" && i + 1 < tokens.length) {
            cfgName = String(tokens[++i] || "");
          } else if (tok.startsWith("--config=")) {
            cfgName = tok.slice("--config=".length);
          }
          if (cfgName !== null) {
            out.push(`--config=${cfgName}`);
            if (cfgName && !activeStack.has(cfgName) && rcConfigTokensByName.has(cfgName)) {
              const nextStack = new Set(activeStack);
              nextStack.add(cfgName);
              out.push(
                ...expandConfigTokens(
                  rcConfigTokensByName.get(cfgName) || [],
                  depth + 1,
                  nextStack,
                ),
              );
            }
            continue;
          }
          out.push(tok);
        }
        return out;
      };
      const cliBeforeDashDash = (() => {
        const idx = cliRestArgs.indexOf("--");
        return idx >= 0 ? cliRestArgs.slice(0, idx) : cliRestArgs;
      })();
      const expandedFromRc = expandConfigTokens(rcCommandTokens);
      const expandedFromCli = expandConfigTokens(cliBeforeDashDash);
      const allEffectiveFlags = [...expandedFromRc, ...expandedFromCli];
      const isFalseVal = (v) => /^(?:false|0|no|f|n)$/i.test(String(v || "").trim());
      let platformConfigEnabled = false;
      for (const tok of allEffectiveFlags) {
        if (tok === "--enable_platform_specific_config") platformConfigEnabled = true;
        else if (tok === "--noenable_platform_specific_config") platformConfigEnabled = false;
        else if (tok.startsWith("--enable_platform_specific_config=")) {
          platformConfigEnabled = !isFalseVal(
            tok.slice("--enable_platform_specific_config=".length),
          );
        }
      }
      const effectivePlatform = platform || process.platform;
      const osConfigName =
        effectivePlatform === "darwin"
          ? "macos"
          : effectivePlatform === "win32"
            ? "windows"
            : effectivePlatform === "linux"
              ? "linux"
              : null;
      const osConfigTokens =
        platformConfigEnabled && osConfigName && rcConfigTokensByName.has(osConfigName)
          ? expandConfigTokens(
              rcConfigTokensByName.get(osConfigName) || [],
              1,
              new Set([osConfigName]),
            )
          : [];
      const effectiveBazelCommandArgs = [
        subcmd,
        ...expandedFromRc.filter((t) => t !== "--"),
        ...osConfigTokens.filter((t) => t !== "--"),
        ...expandedFromCli.filter((t) => t !== "--"),
        ...(cliRestArgs.includes("--") ? cliRestArgs.slice(cliRestArgs.indexOf("--")) : []),
      ];
      const reclassified = {
        ...classifyBuildCommand("bazel", effectiveBazelCommandArgs),
        effectiveBazelArgs: effectiveBazelCommandArgs,
      };
      if (reclassified.kind === "deny_lifecycle" || reclassified.kind === "read_only") {
        return {
          ...reclassified,
          workspaceRoot: null,
          resourceKeys: [],
        };
      }
      classified = reclassified;
    }

    applyStartupOptionTokens(strArgs, baseCwd);
    const hasUseBazelVersion = Boolean(
      effectiveEnvVars.USE_BAZEL_VERSION === null || effectiveEnvVars.USE_BAZEL_VERSION === ""
        ? null
        : effectiveEnvVars.USE_BAZEL_VERSION || baseEnv.USE_BAZEL_VERSION || null,
    );
    const disablesDaemon = batchMode || hasCustomStartupOption || hasUseBazelVersion;

    const canonicalUserRoot = outputUserRoot
      ? canonicalizeBuildPath(outputUserRoot, { platform })
      : null;
    const resourceKeys = [`bazel:ws:${canonicalRoot}`];
    if (outputBase) {
      resourceKeys.push(`bazel:out:${canonicalizeBuildPath(outputBase, { platform })}`);
    } else if (canonicalUserRoot) {
      const wsMd5 = crypto.createHash("md5").update(canonicalRoot).digest("hex");
      resourceKeys.push(`bazel:out:${path.join(canonicalUserRoot, wsMd5)}`);
    }
    for (const ambOut of ambiguousOutputBases) {
      const key = `bazel:out:${canonicalizeBuildPath(ambOut, { platform })}`;
      if (!resourceKeys.includes(key)) resourceKeys.push(key);
    }
    if (ambiguousOutputUserRoots.size > 0) {
      const wsMd5 = crypto.createHash("md5").update(canonicalRoot).digest("hex");
      for (const ambRoot of ambiguousOutputUserRoots) {
        const canonAmbRoot = canonicalizeBuildPath(ambRoot, { platform });
        const key = `bazel:out:${path.join(canonAmbRoot, wsMd5)}`;
        if (!resourceKeys.includes(key)) resourceKeys.push(key);
      }
    }
    const resolvedBazelMajorVersion = effectiveBazelMajor ?? bazelMajorVersion;
    const bazelEnvMeta = {
      baseCwd,
      platform: platform || process.platform,
      isBazelisk: isBazeliskLauncher,
      bazelMajorVersion: resolvedBazelMajorVersion,
      envBazelTestTmpdir: effectiveEnvVars.TEST_TMPDIR,
      envBazelUser: effectiveEnvVars.USER,
      envBazelUsername: effectiveEnvVars.USERNAME,
      envBazelHome: effectiveEnvVars.HOME,
      envBazelUserProfile: effectiveEnvVars.USERPROFILE,
      envBazelXdgCacheHome: effectiveEnvVars.XDG_CACHE_HOME,
    };
    return applyExplicitWorkspaceKeys({
      ...classified,
      ...bazelEnvMeta,
      disablesDaemon,
      requestedHeapMb,
      bazelOutputUserRoot: canonicalUserRoot,
      defaultBazelOutputBases: computeDefaultBazelOutputBases(canonicalRoot, {
        buildReqs: bazelEnvMeta,
        env: baseEnv,
        platform: platform || process.platform,
        isBazelisk: isBazeliskLauncher,
        bazelMajorVersion: resolvedBazelMajorVersion,
      }),
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    });
  }

  if (classified.tool === "xcodebuild") {
    let explicitTargetPath = null;
    let derivedDataPath = null;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if ((a === "-workspace" || a === "-project") && i + 1 < strArgs.length) {
        explicitTargetPath = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("-workspace=")) {
        explicitTargetPath = path.resolve(baseCwd, a.slice("-workspace=".length));
      } else if (a.startsWith("-project=")) {
        explicitTargetPath = path.resolve(baseCwd, a.slice("-project=".length));
      } else if (a === "-derivedDataPath" && i + 1 < strArgs.length) {
        derivedDataPath = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("-derivedDataPath=")) {
        derivedDataPath = path.resolve(baseCwd, a.slice("-derivedDataPath=".length));
      }
    }

    let rootDir = explicitTargetPath ? path.dirname(explicitTargetPath) : null;
    if (!rootDir) {
      let cur = baseCwd;
      for (let depth = 0; depth < 16; depth++) {
        try {
          const entries = fs.readdirSync(cur);
          if (entries.some((e) => e.endsWith(".xcworkspace") || e.endsWith(".xcodeproj"))) {
            rootDir = cur;
            break;
          }
        } catch {
          break;
        }
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
    }
    const canonicalRoot = canonicalizeBuildPath(rootDir || baseCwd);
    const resourceKeys = [`xcode:${canonicalRoot}`];
    if (derivedDataPath) {
      resourceKeys.push(`xcode:dd:${canonicalizeBuildPath(derivedDataPath)}`);
    }
    return applyExplicitWorkspaceKeys({
      ...classified,
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    });
  }

  return applyExplicitWorkspaceKeys({
    ...classified,
    workspaceRoot: null,
    resourceKeys: [],
  });
}

function parseJvmHeapMb(str) {
  if (!str) return 0;
  let lastMaxHeapMb = 0;
  let lastInitHeapMb = 0;
  const re = /-(Xmx|Xms|XX:(?:Max|Initial|Min)HeapSize=)(\d+(?:\.\d+)?)([kKmMgGtT])?\b/g;
  let m;
  while ((m = re.exec(String(str))) !== null) {
    const kind = m[1];
    const num = Number(m[2]);
    if (!Number.isFinite(num) || num <= 0) continue;
    const unit = (m[3] || "").toLowerCase();
    let mb = 0;
    if (unit === "t") mb = Math.ceil(num * 1024 * 1024);
    else if (unit === "g") mb = Math.ceil(num * 1024);
    else if (unit === "m") mb = Math.ceil(num);
    else if (unit === "k") mb = Math.ceil(num / 1024);
    else mb = Math.ceil(num / (1024 * 1024));
    if (kind === "Xmx" || kind === "XX:MaxHeapSize=") {
      lastMaxHeapMb = mb;
    } else {
      lastInitHeapMb = mb;
    }
  }
  return Math.max(lastMaxHeapMb, lastInitHeapMb);
}

function parseJvmSizeBytes(rawVal) {
  const m = String(rawVal || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)([kKmMgGtT])?$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "t") return Math.round(num * 1024 * 1024 * 1024 * 1024);
  if (unit === "g") return Math.round(num * 1024 * 1024 * 1024);
  if (unit === "m") return Math.round(num * 1024 * 1024);
  if (unit === "k") return Math.round(num * 1024);
  return Math.round(num);
}

function normalizeGradleCompatJvmArgs(args) {
  const keyed = new Map();
  const positional = [];
  for (const rawTok of args || []) {
    const tok = String(rawTok || "").trim();
    if (!tok) continue;
    if (tok.startsWith("-Xmx") || tok.startsWith("-XX:MaxHeapSize=")) {
      const val = tok.startsWith("-Xmx") ? tok.slice(4) : tok.slice("-XX:MaxHeapSize=".length);
      const bytes = parseJvmSizeBytes(val);
      keyed.set("max_heap", bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (
      tok.startsWith("-Xms") ||
      tok.startsWith("-XX:InitialHeapSize=") ||
      tok.startsWith("-XX:MinHeapSize=")
    ) {
      const val = tok.startsWith("-Xms") ? tok.slice(4) : tok.slice(tok.indexOf("=") + 1);
      const bytes = parseJvmSizeBytes(val);
      keyed.set("min_heap", bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (tok.startsWith("-Xss") || tok.startsWith("-XX:ThreadStackSize=")) {
      const val = tok.startsWith("-Xss")
        ? tok.slice(4)
        : tok.slice("-XX:ThreadStackSize=".length);
      const bytes = parseJvmSizeBytes(val);
      keyed.set("stack_size", bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (tok.startsWith("-XX:+") || tok.startsWith("-XX:-")) {
      const sign = tok[4];
      const flagName = tok.slice(5);
      keyed.set(`xx:${flagName}`, sign === "+" ? "true" : "false");
    } else if (tok.startsWith("-XX:") && tok.includes("=")) {
      const eqIdx = tok.indexOf("=");
      const optName = tok.slice(4, eqIdx);
      const val = tok.slice(eqIdx + 1);
      const bytes = /Size$/i.test(optName) ? parseJvmSizeBytes(val) : null;
      keyed.set(`xx:${optName}`, bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (tok.startsWith("-D")) {
      const eqIdx = tok.indexOf("=");
      const propKey = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
      let propVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : "";
      if (propKey === "file.encoding" && /^utf-?8$/i.test(propVal)) {
        propVal = "UTF-8";
      }
      keyed.set(`prop:${propKey}`, propVal);
    } else if (tok === "-ea" || tok === "-enableassertions") {
      keyed.set("assert:user", "true");
    } else if (tok === "-da" || tok === "-disableassertions") {
      keyed.set("assert:user", "false");
    } else if (tok.startsWith("-ea:") || tok.startsWith("-enableassertions:")) {
      const target = tok.slice(tok.indexOf(":") + 1);
      keyed.set(`assert:pkg:${target}`, "true");
    } else if (tok.startsWith("-da:") || tok.startsWith("-disableassertions:")) {
      const target = tok.slice(tok.indexOf(":") + 1);
      keyed.set(`assert:pkg:${target}`, "false");
    } else if (tok === "-esa" || tok === "-enablesystemassertions") {
      keyed.set("assert:sys", "true");
    } else if (tok === "-dsa" || tok === "-disablesystemassertions") {
      keyed.set("assert:sys", "false");
    } else {
      positional.push(tok);
    }
  }
  return { keyed, positional };
}

function resolveDefaultGradleLocaleProps(env = null) {
  const effectiveEnv = env || process.env || {};
  const hasExplicitLocaleKeys =
    env && ("LC_ALL" in env || "LC_MESSAGES" in env || "LANG" in env);
  const rawLocale = hasExplicitLocaleKeys
    ? effectiveEnv.LC_ALL || effectiveEnv.LC_MESSAGES || effectiveEnv.LANG || "C.UTF-8"
    : effectiveEnv.LC_ALL ||
      effectiveEnv.LC_MESSAGES ||
      effectiveEnv.LANG ||
      process.env.LC_ALL ||
      process.env.LC_MESSAGES ||
      process.env.LANG ||
      "";
  const parsePosixLocale = (raw) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    if (/^(?:C|POSIX)(?:\.(.+))?$/i.test(trimmed)) {
      const encRaw = trimmed.includes(".") ? trimmed.slice(trimmed.indexOf(".") + 1) : "UTF-8";
      const encoding = /^utf-?8$/i.test(encRaw) ? "UTF-8" : encRaw.toUpperCase();
      return { language: "en", country: "US", variant: "", encoding };
    }
    const m = trimmed.match(
      /^([a-zA-Z]{2,3})(?:[_-]([a-zA-Z]{2}|\d{3}))?(?:\.([^@]+))?(?:@(.+))?$/,
    );
    if (!m) return null;
    const encRaw = m[3] || "UTF-8";
    const encoding = /^utf-?8$/i.test(encRaw) ? "UTF-8" : encRaw.toUpperCase();
    return {
      language: m[1].toLowerCase(),
      country: (m[2] || "").toUpperCase(),
      variant: m[4] || "",
      encoding,
    };
  };
  const parsed = parsePosixLocale(rawLocale);
  if (parsed) {
    return parsed;
  }
  try {
    const intlLoc = Intl.DateTimeFormat().resolvedOptions().locale || "";
    const im = intlLoc.match(/^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2}|\d{3}))?/);
    if (im) {
      return {
        language: im[1].toLowerCase(),
        country: (im[2] || "US").toUpperCase(),
        variant: "",
        encoding: "UTF-8",
      };
    }
  } catch {
    // Ignore Intl errors
  }
  return { language: "en", country: "US", variant: "", encoding: "UTF-8" };
}

function stripDefaultGradleDaemonJvmArgs(daemonNorm, expectedNorm, env = null) {
  const keyed = new Map(daemonNorm.keyed);
  const defaultLocale = resolveDefaultGradleLocaleProps(env);
  if (
    !expectedNorm.keyed.has("xx:HeapDumpOnOutOfMemoryError") &&
    keyed.get("xx:HeapDumpOnOutOfMemoryError") === "true"
  ) {
    keyed.delete("xx:HeapDumpOnOutOfMemoryError");
  }
  if (
    !expectedNorm.keyed.has("max_heap") &&
    !expectedNorm.keyed.has("min_heap") &&
    !expectedNorm.keyed.has("xx:MaxMetaspaceSize") &&
    keyed.get("max_heap") === "bytes:536870912" &&
    keyed.get("xx:MaxMetaspaceSize") === "bytes:402653184" &&
    (!keyed.has("min_heap") || keyed.get("min_heap") === "bytes:268435456")
  ) {
    keyed.delete("max_heap");
    keyed.delete("xx:MaxMetaspaceSize");
    keyed.delete("min_heap");
  }
  if (
    !expectedNorm.keyed.has("prop:file.encoding") &&
    keyed.has("prop:file.encoding") &&
    String(keyed.get("prop:file.encoding") || "").toUpperCase() === defaultLocale.encoding
  ) {
    keyed.delete("prop:file.encoding");
  }
  if (
    !expectedNorm.keyed.has("prop:user.country") &&
    keyed.has("prop:user.country") &&
    String(keyed.get("prop:user.country") || "").toUpperCase() === defaultLocale.country
  ) {
    keyed.delete("prop:user.country");
  }
  if (
    !expectedNorm.keyed.has("prop:user.language") &&
    keyed.has("prop:user.language") &&
    String(keyed.get("prop:user.language") || "").toLowerCase() === defaultLocale.language
  ) {
    keyed.delete("prop:user.language");
  }
  if (
    !expectedNorm.keyed.has("prop:user.variant") &&
    keyed.has("prop:user.variant") &&
    String(keyed.get("prop:user.variant") || "") === defaultLocale.variant
  ) {
    keyed.delete("prop:user.variant");
  }
  for (const sysProp of [
    "prop:java.io.tmpdir",
    "prop:sun.io.unicode.encoding",
    "prop:sun.jnu.encoding",
  ]) {
    if (!expectedNorm.keyed.has(sysProp) && keyed.has(sysProp)) {
      keyed.delete(sysProp);
    }
  }
  return { keyed, positional: [...daemonNorm.positional] };
}

function gradleCompatNormEqual(exp, dmn) {
  if (exp.keyed.size !== dmn.keyed.size) return false;
  for (const [k, v] of exp.keyed.entries()) {
    if (!dmn.keyed.has(k) || dmn.keyed.get(k) !== v) return false;
  }
  if (exp.positional.length !== dmn.positional.length) return false;
  for (let i = 0; i < exp.positional.length; i++) {
    if (exp.positional[i] !== dmn.positional[i]) return false;
  }
  return true;
}

function splitJvmArgTokens(rawStr) {
  if (!rawStr) return [];
  const unescaped = String(rawStr)
    .trim()
    .replace(/\\([:=])/g, "$1");
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < unescaped.length; i++) {
    const ch = unescaped[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function computeEffectiveMaxBuilds(cfg = {}, host = null) {
  const rawMax = cfg?.maxConcurrentBuilds;
  if (typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax >= 1) {
    return rawMax;
  }
  if (typeof rawMax === "string" && /^\d+$/.test(rawMax.trim()) && Number(rawMax) >= 1) {
    return Number(rawMax);
  }
  const cores = host?.cpuCores || os.availableParallelism();
  const totalRamMb = host?.totalRamMb || Math.round(os.totalmem() / (1024 * 1024));
  const totalRamGb = totalRamMb / 1024;
  const cpuBound = Math.max(1, Math.floor(cores / 4));
  const ramBound = totalRamGb < 24 ? 1 : totalRamGb < 48 ? 2 : totalRamGb < 96 ? 3 : 4;
  return Math.max(1, Math.min(4, cpuBound, ramBound));
}

export function computeBuildPoolSnapshot(state, host = null) {
  const cfg = state?.config || {};
  const activeWorkspaces = new Set();
  let activeHeavyBuilds = 0;
  let activeTotalBuilds = 0;

  for (const bLease of Object.values(state?.buildLeases || {})) {
    if (!bLease || (bLease.state !== "active" && bLease.state !== "draining")) continue;
    activeTotalBuilds++;
    if (bLease.requiresHeavySlot) {
      activeHeavyBuilds++;
    }
    for (const key of bLease.resourceKeys || []) {
      activeWorkspaces.add(key);
    }
  }

  const baseMaxBuilds = computeEffectiveMaxBuilds(cfg, host);
  const burstBuilds = Math.max(0, Number(cfg.maxDeviceHolderBurstBuilds ?? 1));
  return {
    activeWorkspaces,
    lockedWorkspaces: activeWorkspaces,
    activeHeavyBuilds,
    usedBuildSlots: activeHeavyBuilds,
    activeTotalBuilds,
    baseMaxBuilds,
    burstBuilds,
    burstSlots: burstBuilds,
    effectiveMaxBuilds: baseMaxBuilds,
    totalCapacity: baseMaxBuilds + burstBuilds,
  };
}

export function hasValidPinnedDeviceLease(ticket, leasesByDeviceKey = {}) {
  if (!ticket || (!ticket.pinnedDeviceKey && !ticket.pinnedDeviceLeaseId)) return false;
  if (ticket.pinnedDeviceKey && leasesByDeviceKey[ticket.pinnedDeviceKey]) {
    const lease = leasesByDeviceKey[ticket.pinnedDeviceKey];
    return Boolean(
      lease &&
        (!ticket.pinnedDeviceLeaseId || lease.leaseId === ticket.pinnedDeviceLeaseId) &&
        lease.sessionId === ticket.sessionId &&
        lease.state === "active" &&
        lease.firstSeenOfflineAtMs == null,
    );
  }
  if (ticket.pinnedDeviceLeaseId) {
    for (const lease of Object.values(leasesByDeviceKey || {})) {
      if (
        lease &&
        lease.leaseId === ticket.pinnedDeviceLeaseId &&
        lease.sessionId === ticket.sessionId &&
        lease.state === "active" &&
        lease.firstSeenOfflineAtMs == null
      ) {
        return true;
      }
    }
  }
  return false;
}

export function extractBuildResourceKeyInfo(keyStr) {
  const s = String(keyStr || "");
  const firstColon = s.indexOf(":");
  if (firstColon === -1) return { prefix: s, path: "" };
  const prefix = s.slice(0, firstColon);
  const rest = s.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (
    secondColon !== -1 &&
    ["ws", "out", "dir", "dd"].includes(rest.slice(0, secondColon))
  ) {
    return {
      prefix: `${prefix}:${rest.slice(0, secondColon)}`,
      path: rest.slice(secondColon + 1),
    };
  }
  return { prefix, path: rest };
}

export function doBuildResourceKeysConflict(keyA, keyB) {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  const a = extractBuildResourceKeyInfo(keyA);
  const b = extractBuildResourceKeyInfo(keyB);
  if (!a.path || !b.path) return false;
  const isWinPath =
    process.platform === "win32" ||
    /^[a-zA-Z]:[\\/]/.test(a.path) ||
    /^[a-zA-Z]:[\\/]/.test(b.path) ||
    a.path.startsWith("\\\\") ||
    b.path.startsWith("\\\\");
  const normA = isWinPath ? a.path.replace(/\//g, "\\").toLowerCase() : a.path;
  const normB = isWinPath ? b.path.replace(/\//g, "\\").toLowerCase() : b.path;
  if (a.prefix === b.prefix && normA === normB) return true;
  if (a.prefix === "workspace" || b.prefix === "workspace") {
    return (
      normA === normB ||
      normA.startsWith(`${normB}/`) ||
      normA.startsWith(`${normB}\\`) ||
      normB.startsWith(`${normA}/`) ||
      normB.startsWith(`${normA}\\`)
    );
  }
  return false;
}

export function pruneAndSelectNextBuildTicket(
  queue,
  stateView,
  now,
  {
    reorderWindowMs = 120_000,
    hbTimeoutMs = 10_000,
    livenessCheck = () => true,
    currentTicketId = null,
  } = {},
) {
  const activeWorkspaces = stateView.activeWorkspaces || new Set();
  const activeHeavyBuilds = stateView.activeHeavyBuilds ?? 0;
  const maxHostBuilds = stateView.maxHostBuilds ?? 1;
  const burstBuilds = Math.max(0, Number(stateView.burstBuilds ?? 0));
  const leases = stateView.leases || {};
  const pruned = [];

  for (let i = queue.length - 1; i >= 0; i--) {
    const t = queue[i];
    if (!t || typeof t !== "object") {
      queue.splice(i, 1);
      continue;
    }
    const isCurrentCallerTicket = Boolean(currentTicketId && t.ticketId === currentTicketId);
    const deadWaiter = !t.waiterPid || !livenessCheck(t.waiterPid);
    const waitExpired =
      !isCurrentCallerTicket &&
      typeof t.waitExpiresAtMs === "number" &&
      now >= t.waitExpiresAtMs;
    const hbExpired =
      !isCurrentCallerTicket &&
      typeof t.lastHeartbeatAtMs === "number" &&
      now >= t.lastHeartbeatAtMs + hbTimeoutMs;
    const expired = waitExpired || hbExpired;
    const lostDevice =
      Boolean(t.pinnedDeviceLeaseId || t.pinnedDeviceKey) &&
      !hasValidPinnedDeviceLease(t, leases);
    if (deadWaiter || expired || lostDevice) {
      queue.splice(i, 1);
      pruned.push({
        ticketId: t.ticketId,
        sessionId: t.sessionId,
        reason: lostDevice ? "lost_device_lease" : expired ? "expired" : "dead_waiter",
      });
    }
  }

  function isTicketDeviceAvailable(ticket) {
    if (!ticket.requiresDeviceCoAlloc && !ticket.coAllocResourceKey) return true;
    if (typeof stateView.isDeviceAvailableForTicket === "function") {
      return Boolean(stateView.isDeviceAvailableForTicket(ticket));
    }
    if (typeof ticket.deviceAvailableForCoAlloc === "boolean") {
      return ticket.deviceAvailableForCoAlloc;
    }
    return stateView.deviceAvailableForCoAlloc !== false;
  }

  function getTicketCoAllocResourceKey(ticket) {
    return ticket.coAllocResourceKey || "device";
  }

  function missingResources(ticket) {
    const missing = new Set();
    for (const ws of ticket.resourceKeys || []) {
      for (const activeWs of activeWorkspaces) {
        if (doBuildResourceKeysConflict(ws, activeWs)) {
          missing.add(`ws:${ws}`);
          break;
        }
      }
    }
    const hasDev = Boolean(ticket.pinnedDeviceLeaseId || ticket.requiresDeviceCoAlloc);
    const isStarved =
      typeof ticket.starvationDeadlineMs === "number" && now >= ticket.starvationDeadlineMs;
    const effectiveCeiling =
      hasDev || isStarved ? maxHostBuilds + burstBuilds : maxHostBuilds;
    if (ticket.requiresHeavySlot && activeHeavyBuilds >= effectiveCeiling) {
      missing.add("host:heavy_slot");
    }
    if (ticket.requiresDeviceCoAlloc && !isTicketDeviceAvailable(ticket)) {
      missing.add(getTicketCoAllocResourceKey(ticket));
    }
    return missing;
  }

  function providedResources(ticket) {
    const used = new Set();
    for (const ws of ticket.resourceKeys || []) {
      used.add(`ws:${ws}`);
    }
    if (ticket.requiresHeavySlot) used.add("host:heavy_slot");
    if (ticket.requiresDeviceCoAlloc) used.add(getTicketCoAllocResourceKey(ticket));
    return used;
  }

  const eligible = [];
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    if (missingResources(t).size === 0) {
      eligible.push({ idx: i, ticket: t });
    }
  }
  if (eligible.length === 0) return { chosenIdx: -1, pruned };

  const ranked = [...eligible].sort((a, b) => {
    const aStarved = now >= a.ticket.starvationDeadlineMs;
    const bStarved = now >= b.ticket.starvationDeadlineMs;
    if (aStarved !== bStarved) return aStarved ? -1 : 1;
    const aHasDev = Boolean(a.ticket.pinnedDeviceLeaseId || a.ticket.requiresDeviceCoAlloc);
    const bHasDev = Boolean(b.ticket.pinnedDeviceLeaseId || b.ticket.requiresDeviceCoAlloc);
    if (aHasDev !== bHasDev) return aHasDev ? -1 : 1;
    const aSeq = a.ticket.seq ?? a.ticket.enqueuedAtMs;
    const bSeq = b.ticket.seq ?? b.ticket.enqueuedAtMs;
    return a.ticket.enqueuedAtMs - b.ticket.enqueuedAtMs || aSeq - bSeq;
  });

  for (const cand of ranked) {
    const candUsed = providedResources(cand.ticket);
    const candHasDev = Boolean(cand.ticket.pinnedDeviceLeaseId || cand.ticket.requiresDeviceCoAlloc);
    let blockedByEarlier = false;

    for (let j = 0; j < cand.idx; j++) {
      const earlier = queue[j];
      const earlierMissing = missingResources(earlier);
      const earlierHasDev = Boolean(
        earlier.pinnedDeviceLeaseId || earlier.requiresDeviceCoAlloc,
      );

      if (earlierMissing.size === 0) {
        const canOvertake =
          candHasDev &&
          !earlierHasDev &&
          now < earlier.starvationDeadlineMs &&
          cand.ticket.enqueuedAtMs - earlier.enqueuedAtMs <= reorderWindowMs;
        if (!canOvertake) {
          blockedByEarlier = true;
          break;
        }
      } else if (now >= earlier.starvationDeadlineMs) {
        for (const m of earlierMissing) {
          if (candUsed.has(m)) {
            blockedByEarlier = true;
            break;
          }
          if (m.startsWith("ws:")) {
            const missingKey = m.slice(3);
            if (
              (cand.ticket.resourceKeys || []).some((ck) =>
                doBuildResourceKeysConflict(ck, missingKey),
              )
            ) {
              blockedByEarlier = true;
              break;
            }
          }
        }
        if (blockedByEarlier) break;
      }
    }
    if (!blockedByEarlier) {
      return { chosenIdx: cand.idx, pruned };
    }
  }
  return { chosenIdx: -1, pruned };
}

export function computeUnaccountedBuildRamMb(
  state,
  hostSnapshotSampledAtMs,
  nowMs,
  { excludeBuildId = null } = {},
) {
  let unaccountedBuildRamMb = 0;
  const sampledAtMs =
    typeof hostSnapshotSampledAtMs === "number" && Number.isFinite(hostSnapshotSampledAtMs)
      ? hostSnapshotSampledAtMs
      : nowMs;
  for (const bLease of Object.values(state?.buildLeases || {})) {
    if (!bLease || !bLease.requiresHeavySlot) continue;
    if (excludeBuildId && bLease.buildId === excludeBuildId) continue;
    if (bLease.state !== "active" && bLease.state !== "draining") continue;
    const isPreparingDevice = Boolean(bLease.preparingDevice && bLease.state === "active");
    const withinHorizon =
      typeof bLease.ramReservationUntilMs === "number" && nowMs < bLease.ramReservationUntilMs;
    const admittedAfterSnapshot =
      typeof bLease.createdAtMs === "number" && bLease.createdAtMs >= sampledAtMs;
    if (isPreparingDevice || withinHorizon || admittedAfterSnapshot) {
      unaccountedBuildRamMb += bLease.reservedRamMb || (state?.config?.buildRamEstimateMb ?? 3072);
    }
  }
  return unaccountedBuildRamMb;
}

export function checkUnifiedRamAdmission(
  state,
  hostSnapshot,
  prospectiveDemandMb,
  nowMs,
  { minFreeRamMb = null, hysteresisMb = null, onlineDeviceKeys = new Set() } = {},
) {
  const cfg = state?.config || {};
  const effectiveMinFreeMb = minFreeRamMb ?? cfg.minFreeRamMb ?? 2048;
  const effectiveHysteresisMb = hysteresisMb ?? cfg.buildRamHysteresisMb ?? 256;
  const sampledAtMs =
    typeof hostSnapshot?.sampledAtMs === "number" ? hostSnapshot.sampledAtMs : nowMs;
  const freeRamMb = hostSnapshot?.freeRamMb ?? hostSnapshot?.availableRamMb ?? 4096;

  let unaccountedRamMb = 0;
  for (const lease of Object.values(state?.leases || {})) {
    if (!lease || lease.kind !== "emulator") continue;
    const leaseOnline = Boolean(
      (lease.deviceKey && onlineDeviceKeys.has(lease.deviceKey)) ||
        (lease.avd && onlineDeviceKeys.has(lease.avd)) ||
        (lease.udid && onlineDeviceKeys.has(lease.udid)),
    );
    const isStarting = lease.state === "starting" && !leaseOnline;
    const isRecentlyActivated =
      lease.state === "active" &&
      lease.firstSeenOfflineAtMs == null &&
      !leaseOnline &&
      typeof lease.activatedAtMs === "number" &&
      nowMs - lease.activatedAtMs < 30_000;
    const notInSnapshot =
      typeof lease.claimedAtMs === "number" && lease.claimedAtMs >= sampledAtMs;
    if (isStarting || isRecentlyActivated || notInSnapshot) {
      const leaseOverheadMb =
        (lease.platform || "android") === "ios"
          ? (cfg.simOverheadRamMb ?? 1280)
          : (cfg.qemuOverheadRamMb ?? 1024);
      unaccountedRamMb +=
        lease.requiredRamMb ||
        ((lease.platform || "android") === "ios" ? leaseOverheadMb : 2048 + leaseOverheadMb);
    }
  }

  unaccountedRamMb += computeUnaccountedBuildRamMb(state, sampledAtMs, nowMs);

  const effectiveFreeMb = freeRamMb - unaccountedRamMb - prospectiveDemandMb;
  return {
    allowed: effectiveFreeMb >= effectiveMinFreeMb + effectiveHysteresisMb,
    effectiveFreeMb,
    unaccountedRamMb,
    requiredFloorMb: effectiveMinFreeMb + effectiveHysteresisMb,
  };
}

export function reconcileBuildLease(
  lease,
  nowMs,
  {
    clientGroupAlive = false,
    abortedOrTimedOut = false,
    abortCooldownMs = 5_000,
    maxDrainingMs = 30_000,
  } = {},
) {
  if (!lease || typeof lease !== "object") {
    return { action: "delete_lease" };
  }
  if (lease.state === "active") {
    if (!clientGroupAlive && !abortedOrTimedOut) {
      return { action: "delete_lease" };
    }
    return {
      action: "mark_draining",
      lease: {
        ...lease,
        state: "draining",
        drainingStartedAtMs: nowMs,
        drainingCooldownUntilMs: abortedOrTimedOut ? nowMs + abortCooldownMs : nowMs,
        drainingDeadlineMs: nowMs + maxDrainingMs,
      },
    };
  }
  if (lease.state === "draining") {
    const cooldownDone = nowMs >= (lease.drainingCooldownUntilMs || 0);
    const pastMaxHorizon = nowMs >= (lease.drainingDeadlineMs || Infinity);
    if ((!clientGroupAlive && cooldownDone) || pastMaxHorizon) {
      return {
        action: "delete_lease",
        forcedByHorizon: Boolean(pastMaxHorizon && clientGroupAlive),
      };
    }
    return { action: "keep_draining", lease };
  }
  return { action: "delete_lease" };
}

const BUILD_DAEMON_PROCESS_RE =
  /\b(GradleDaemon|org\.gradle\.launcher\.daemon|kotlin-daemon|KotlinCompileDaemon|bazel\([A-Za-z0-9_.-]+\)|bazel-real|xcbbuildservice|SWBBuildService)\b/i;

export function isProcessSpawnedByBuildDaemon(processChain = []) {
  if (!Array.isArray(processChain)) return false;
  return processChain.some(
    (proc) =>
      proc &&
      (BUILD_DAEMON_PROCESS_RE.test(String(proc.args || "")) ||
        BUILD_DAEMON_PROCESS_RE.test(String(proc.comm || ""))),
  );
}

export function evaluateNestedBuildAdmission(
  state,
  {
    inheritedOpId = null,
    inheritedNonce = null,
    ancestorPids = [],
    processChain = [],
    requestedKeys = [],
    requiresHeavySlot = false,
    requiresDevice = false,
    hasActiveDeviceLease = false,
    livenessCheck = () => true,
  } = {},
) {
  if (!inheritedOpId || !inheritedNonce) {
    return { reentrant: false, deadlockHazard: false, reason: "no_op_env" };
  }
  const activeBuildLease = Object.values(state?.buildLeases || {}).find(
    (b) =>
      b &&
      b.opId === inheritedOpId &&
      b.opNonce === inheritedNonce &&
      b.state === "active",
  );
  if (!activeBuildLease) {
    return { reentrant: false, deadlockHazard: false, reason: "inactive_or_mismatched_op" };
  }
  const parentWorkerAlive = Boolean(
    activeBuildLease.workerPid && livenessCheck(activeBuildLease.workerPid),
  );
  if (!parentWorkerAlive) {
    return { reentrant: false, deadlockHazard: false, reason: "parent_worker_exited" };
  }

  const ancestorSet = new Set(Array.isArray(ancestorPids) ? ancestorPids.map(Number) : []);
  const callerInClientTree =
    ancestorSet.has(Number(activeBuildLease.workerPid)) ||
    (activeBuildLease.execWrapperPid && ancestorSet.has(Number(activeBuildLease.execWrapperPid)));
  const callerSpawnedByBuildDaemon = isProcessSpawnedByBuildDaemon(processChain);

  if (!callerInClientTree && !callerSpawnedByBuildDaemon) {
    return {
      reentrant: false,
      deadlockHazard: false,
      reason: "caller_not_in_client_or_daemon_tree",
    };
  }

  const extractKeyPath = (keyStr) => {
    const s = String(keyStr || "");
    const firstColon = s.indexOf(":");
    if (firstColon === -1) return "";
    const rest = s.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (
      secondColon !== -1 &&
      ["ws", "out", "dir", "dd"].includes(rest.slice(0, secondColon))
    ) {
      return rest.slice(secondColon + 1);
    }
    return rest;
  };

  const heldKeys = new Set(activeBuildLease.resourceKeys || []);
  const heldRoots = new Set();
  if (activeBuildLease.workspaceRoot) {
    heldRoots.add(String(activeBuildLease.workspaceRoot));
  }
  for (const hk of heldKeys) {
    const p = extractKeyPath(hk);
    if (p) heldRoots.add(p);
  }

  const otherHeldKeys = new Set();
  for (const b of Object.values(state?.buildLeases || {})) {
    if (!b || b.buildId === activeBuildLease.buildId) continue;
    if (b.state !== "active" && b.state !== "draining") continue;
    for (const ok of b.resourceKeys || []) {
      otherHeldKeys.add(ok);
    }
  }

  const deltaKeys = [];
  for (const k of requestedKeys || []) {
    if (heldKeys.has(k)) continue;
    const reqPath = extractKeyPath(k);
    const inSameWorkspace =
      Boolean(reqPath) &&
      Array.from(heldRoots).some(
        (root) =>
          reqPath === root ||
          reqPath.startsWith(`${root}/`) ||
          reqPath.startsWith(`${root}\\`),
      );
    if (
      inSameWorkspace &&
      !otherHeldKeys.has(k) &&
      !Array.from(otherHeldKeys).some((ok) => doBuildResourceKeysConflict(k, ok))
    ) {
      deltaKeys.push(k);
      continue;
    }
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build requests workspace resource "${k}" not held by parent build operation ${activeBuildLease.buildId} (held: ${Array.from(heldKeys).join(", ")}). Failing fast to prevent self-deadlock.`,
    };
  }
  if (requiresHeavySlot && !activeBuildLease.requiresHeavySlot) {
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build escalates from workspace-only query to a heavy compilation slot inside parent build operation ${activeBuildLease.buildId}. Failing fast to prevent self-deadlock.`,
    };
  }
  if (requiresDevice && !hasActiveDeviceLease) {
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build escalates to require a device lease inside parent build operation ${activeBuildLease.buildId} while holding no active device lease. Failing fast to prevent self-deadlock.`,
    };
  }

  if (deltaKeys.length > 0) {
    activeBuildLease.resourceKeys = Array.from(new Set([...heldKeys, ...deltaKeys]));
  }

  return {
    reentrant: true,
    deadlockHazard: false,
    buildLease: activeBuildLease,
    deltaKeys,
  };
}

export function computeDefaultBazelOutputBases(wsRoot, options = {}) {
  if (!wsRoot) return [];
  const wsMd5 = crypto.createHash("md5").update(String(wsRoot)).digest("hex");
  const buildReqs = options.buildReqs || null;
  const env = options.env || process.env;
  const platform = options.platform || buildReqs?.platform || process.platform;
  const baseCwd = buildReqs?.baseCwd || process.cwd();
  let rawMajor = options.bazelMajorVersion ?? buildReqs?.bazelMajorVersion ?? null;
  const allowBazeliskFallback = Boolean(options.isBazelisk ?? buildReqs?.isBazelisk);
  if (rawMajor === null || rawMajor === undefined || rawMajor === "") {
    const rawVerStr =
      options.bazelVersion ||
      buildReqs?.bazelVersion ||
      (allowBazeliskFallback &&
      env?.USE_BAZEL_VERSION &&
      env.USE_BAZEL_VERSION !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? String(env.USE_BAZEL_VERSION)
        : null) ||
      (allowBazeliskFallback
        ? (() => {
            try {
              const bvPath = path.join(String(wsRoot), ".bazelversion");
              if (fs.existsSync(bvPath) && fs.statSync(bvPath).isFile()) {
                return (
                  fs
                    .readFileSync(bvPath, "utf8")
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .find((l) => Boolean(l) && !l.startsWith("#")) || null
                );
              }
            } catch {
              // Ignore unreadable .bazelversion
            }
            return null;
          })()
        : null);
    if (rawVerStr) {
      const m = String(rawVerStr)
        .trim()
        .match(
          /^(?:[A-Za-z0-9_.-]+\/)?v?(\d+)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:[-+][A-Za-z0-9_.-]+)?$/i,
        );
      if (m) rawMajor = Number(m[1]);
    }
  }
  const bazelMajor =
    rawMajor !== null && rawMajor !== undefined && rawMajor !== ""
      ? Number(rawMajor)
      : null;

  const resolveEnvVar = (key, wrapperVal) => {
    if (wrapperVal === null || wrapperVal === "") return null;
    if (wrapperVal !== undefined) return String(wrapperVal);
    const fromEnv = env?.[key];
    return fromEnv === undefined || fromEnv === "" ? null : String(fromEnv);
  };

  const rawTestTmpdir = resolveEnvVar("TEST_TMPDIR", buildReqs?.envBazelTestTmpdir);
  const rawPosixUser = resolveEnvVar("USER", buildReqs?.envBazelUser);
  const rawWinUsername =
    platform === "win32"
      ? resolveEnvVar("USERNAME", buildReqs?.envBazelUsername)
      : null;
  const rawUser = platform === "win32" ? rawPosixUser || rawWinUsername : rawPosixUser;
  const rawPosixHome = resolveEnvVar("HOME", buildReqs?.envBazelHome);
  const rawWinUserProfile =
    platform === "win32"
      ? resolveEnvVar("USERPROFILE", buildReqs?.envBazelUserProfile)
      : null;
  const rawHome = platform === "win32" ? rawPosixHome || rawWinUserProfile : rawPosixHome;
  const rawXdgCache = resolveEnvVar("XDG_CACHE_HOME", buildReqs?.envBazelXdgCacheHome);

  if (
    rawTestTmpdir === "__UNRESOLVED_DYNAMIC_ENV__" ||
    rawPosixUser === "__UNRESOLVED_DYNAMIC_ENV__" ||
    (platform === "win32" && rawWinUsername === "__UNRESOLVED_DYNAMIC_ENV__")
  ) {
    return [];
  }

  const rawSelectedUser =
    rawUser ||
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return null;
      }
    })();
  if (!rawSelectedUser) return [];
  const user = String(rawSelectedUser).replace(/[\\/]/g, "_");

  const resolvePosixPath = (base, val) => {
    const s = String(val || "");
    if (s.startsWith("/")) return path.posix.resolve(s);
    const b = String(base || "");
    if (b.startsWith("/")) return path.posix.resolve(b, s);
    return path.resolve(b, s);
  };

  const candidateRoots = [];
  if (rawTestTmpdir) {
    const resolvedTmp =
      platform === "win32" &&
      (/^[a-zA-Z]:[\\/]/.test(rawTestTmpdir) || rawTestTmpdir.startsWith("\\\\"))
        ? path.win32.resolve(rawTestTmpdir)
        : platform === "win32"
          ? path.resolve(baseCwd, rawTestTmpdir)
          : resolvePosixPath(baseCwd, rawTestTmpdir);
    const joinTmp = platform === "win32" ? path.win32.join : path.posix.join;
    candidateRoots.push(joinTmp(resolvedTmp, `_bazel_${user}`));
    candidateRoots.push(
      joinTmp(canonicalizeBuildPath(resolvedTmp, { platform }), `_bazel_${user}`),
    );
  } else if (platform === "darwin") {
    if (bazelMajor === null || !Number.isFinite(bazelMajor) || bazelMajor <= 0) {
      // Bazel <= 8 uses /var/tmp/_bazel_<user> on macOS while Bazel 9+ uses
      // ~/Library/Caches/bazel/_bazel_<user> (or ${XDG_CACHE_HOME}/bazel/_bazel_<user>).
      // Without a known major version, conservatively treat as cold so a lingering
      // server from the other major version cannot falsely satisfy admission.
      return [];
    }
    if (bazelMajor <= 8) {
      candidateRoots.push(`/var/tmp/_bazel_${user}`);
      candidateRoots.push(`/private/var/tmp/_bazel_${user}`);
    } else {
      if (
        rawXdgCache === "__UNRESOLVED_DYNAMIC_ENV__" ||
        rawPosixHome === "__UNRESOLVED_DYNAMIC_ENV__"
      ) {
        return [];
      }
      if (rawXdgCache) {
        const xdgCache = resolvePosixPath(baseCwd, rawXdgCache);
        candidateRoots.push(path.posix.join(xdgCache, "bazel", `_bazel_${user}`));
        candidateRoots.push(
          path.posix.join(
            canonicalizeBuildPath(xdgCache, { platform }),
            "bazel",
            `_bazel_${user}`,
          ),
        );
      } else {
        const homeDir =
          rawPosixHome ||
          (() => {
            try {
              return os.userInfo().homedir;
            } catch {
              return null;
            }
          })();
        if (homeDir) {
          const resolvedHome = resolvePosixPath(baseCwd, homeDir);
          candidateRoots.push(
            path.posix.join(resolvedHome, "Library", "Caches", "bazel", `_bazel_${user}`),
          );
          candidateRoots.push(
            path.posix.join(
              canonicalizeBuildPath(resolvedHome, { platform }),
              "Library",
              "Caches",
              "bazel",
              `_bazel_${user}`,
            ),
          );
        } else {
          candidateRoots.push(`/var/tmp/_bazel_${user}`);
          candidateRoots.push(`/private/var/tmp/_bazel_${user}`);
        }
      }
    }
  } else if (platform === "win32") {
    if (
      rawXdgCache === "__UNRESOLVED_DYNAMIC_ENV__" ||
      rawPosixHome === "__UNRESOLVED_DYNAMIC_ENV__" ||
      rawWinUserProfile === "__UNRESOLVED_DYNAMIC_ENV__"
    ) {
      return [];
    }
    if (rawXdgCache) {
      if (bazelMajor === null || !Number.isFinite(bazelMajor) || bazelMajor <= 0) {
        return [];
      }
      if (bazelMajor >= 9) {
        const resolvedXdg =
          /^[a-zA-Z]:[\\/]/.test(rawXdgCache) || rawXdgCache.startsWith("\\\\")
            ? path.win32.resolve(rawXdgCache)
            : path.resolve(baseCwd, rawXdgCache);
        candidateRoots.push(path.win32.join(resolvedXdg, "bazel", `_bazel_${user}`));
        candidateRoots.push(
          path.win32.join(
            canonicalizeBuildPath(resolvedXdg, { platform: "win32" }),
            "bazel",
            `_bazel_${user}`,
          ),
        );
      }
    }
    if (candidateRoots.length === 0) {
      const homeDir =
        rawHome ||
        (() => {
          try {
            return os.userInfo().homedir;
          } catch {
            return null;
          }
        })() ||
        os.homedir();
      if (homeDir) {
        const resolvedHome =
          /^[a-zA-Z]:[\\/]/.test(homeDir) || homeDir.startsWith("\\\\")
            ? path.win32.resolve(homeDir)
            : path.resolve(baseCwd, homeDir);
        candidateRoots.push(path.win32.join(resolvedHome, `_bazel_${user}`));
        candidateRoots.push(
          path.win32.join(
            canonicalizeBuildPath(resolvedHome, { platform: "win32" }),
            `_bazel_${user}`,
          ),
        );
      }
    }
  } else {
    if (
      rawXdgCache === "__UNRESOLVED_DYNAMIC_ENV__" ||
      rawPosixHome === "__UNRESOLVED_DYNAMIC_ENV__"
    ) {
      return [];
    }
    const homeDir =
      rawPosixHome ||
      (() => {
        try {
          return os.userInfo().homedir;
        } catch {
          return null;
        }
      })();
    const xdgCache = rawXdgCache
      ? resolvePosixPath(baseCwd, rawXdgCache)
      : homeDir
        ? path.posix.join(resolvePosixPath(baseCwd, homeDir), ".cache")
        : null;
    if (xdgCache) {
      candidateRoots.push(path.posix.join(xdgCache, "bazel", `_bazel_${user}`));
      candidateRoots.push(
        path.posix.join(canonicalizeBuildPath(xdgCache, { platform }), "bazel", `_bazel_${user}`),
      );
    } else {
      candidateRoots.push(`/tmp/_bazel_${user}`);
    }
  }

  const joinFn = platform === "win32" ? path.win32.join : path.posix.join;
  const bases = [];
  for (const root of candidateRoots) {
    if (!root) continue;
    bases.push(joinFn(root, wsMd5));
    bases.push(canonicalizeBuildPath(joinFn(root, wsMd5), { platform }));
  }
  return Array.from(new Set(bases));
}

export function probeWarmBuildDaemons(buildReqs, options = {}) {
  if (Array.isArray(buildReqs?.clauseBuildReqs) && buildReqs.clauseBuildReqs.length > 0) {
    const subProbes = buildReqs.clauseBuildReqs.map((sub) =>
      probeWarmBuildDaemons({ ...sub, clauseBuildReqs: null }, options),
    );
    return {
      warm: subProbes.length > 0 && subProbes.every((p) => p.warm),
      daemonPids: Array.from(new Set(subProbes.flatMap((p) => p.daemonPids || []))),
    };
  }
  if (
    !buildReqs ||
    (buildReqs.tool !== "gradle" && buildReqs.tool !== "bazel") ||
    buildReqs.disablesDaemon
  ) {
    return { warm: false, daemonPids: [] };
  }
  const filterIdleGradleDaemons = (
    candidatePids,
    candidateCount = candidatePids.length,
    psClientCount = 0,
  ) => {
    if (buildReqs.tool !== "gradle") {
      return { warm: candidateCount > 0, daemonPids: candidatePids };
    }
    const rawLeases = options.activeBuildLeases || options.state?.buildLeases || null;
    const leaseList = Array.isArray(rawLeases)
      ? rawLeases
      : rawLeases && typeof rawLeases === "object"
        ? Object.values(rawLeases)
        : [];
    const activeGradleLeases = leaseList.filter(
      (b) =>
        b &&
        b.tool === "gradle" &&
        b.requiresHeavySlot !== false &&
        (b.state === "active" || b.state === "draining") &&
        !b.preparingDevice,
    );
    const busySet = new Set(
      Array.isArray(options.busyDaemonPids)
        ? options.busyDaemonPids.map((p) => Number(p)).filter(Boolean)
        : [],
    );
    let matchedBusyCount = 0;
    let unassignedBusyCount = 0;
    for (const b of activeGradleLeases) {
      const claimedPid =
        Number(b.claimedDaemonPid) ||
        (Array.isArray(b.daemonPids) && b.daemonPids.length === 1 ? Number(b.daemonPids[0]) : 0);
      if (claimedPid) {
        if (candidatePids.length === 0) {
          unassignedBusyCount++;
          matchedBusyCount++;
        } else if (candidatePids.includes(claimedPid)) {
          if (!busySet.has(claimedPid)) {
            busySet.add(claimedPid);
          } else {
            unassignedBusyCount++;
          }
          matchedBusyCount++;
        }
      } else if (
        candidatePids.length > 0 &&
        Array.isArray(b.daemonPids) &&
        b.daemonPids.length > 0 &&
        !b.daemonPids.some((pid) => candidatePids.includes(Number(pid)))
      ) {
        // Active lease has a known disjoint compatible daemon pool
      } else {
        unassignedBusyCount++;
        matchedBusyCount++;
      }
    }
    const extraPsBusy = Math.max(0, psClientCount - matchedBusyCount);
    const remainingPids = candidatePids.filter((pid) => !busySet.has(pid));
    const totalDeductions = unassignedBusyCount + extraPsBusy;
    if (remainingPids.length > 0) {
      const idlePids = remainingPids.slice(totalDeductions);
      return { warm: idlePids.length > 0, daemonPids: idlePids };
    }
    const remainingAnon = Math.max(0, candidateCount - busySet.size - totalDeductions);
    return { warm: remainingAnon > 0, daemonPids: [] };
  };
  if (typeof options.warmBuildDaemon === "boolean") {
    return options.warmBuildDaemon
      ? filterIdleGradleDaemons([], 1, 0)
      : { warm: false, daemonPids: [] };
  }
  if (Array.isArray(options.inventory?.warmBuildDaemons)) {
    const matched = options.inventory.warmBuildDaemons.filter((d) => {
      if (!d) return false;
      if (typeof d === "object" && (d.busy === true || d.idle === false || d.state === "busy")) {
        return false;
      }
      if (typeof d === "string") return d === buildReqs.tool || d === buildReqs.workspaceRoot;
      if (d.tool && d.tool !== buildReqs.tool) return false;
      if (d.workspaceRoot && buildReqs.workspaceRoot && d.workspaceRoot !== buildReqs.workspaceRoot) {
        return false;
      }
      return true;
    });
    const matchedPids = matched
      .map((d) => (typeof d === "object" ? Number(d.pid) : 0))
      .filter(Boolean);
    return filterIdleGradleDaemons(matchedPids, matched.length, 0);
  }
  if (options.inventory && !options.runner && !options.spawnSyncFn) {
    return { warm: false, daemonPids: [] };
  }
  const platform = options.platform || process.platform;
  if (platform === "win32" && !options.runner && !options.spawnSyncFn) {
    return { warm: false, daemonPids: [] };
  }
  try {
    let stdout = "";
    if (typeof options.runner === "function") {
      const res = options.runner("ps", ["-ax", "-o", "pid=,command="]);
      stdout = String(res?.stdout || "");
    } else {
      const spawnFn = options.spawnSyncFn || spawnSync;
      const res = spawnFn("ps", ["-ax", "-o", "pid=,command="], {
        encoding: "utf8",
        timeout: 2000,
      });
      if (res?.status === 0 || typeof res?.stdout === "string") {
        stdout = String(res.stdout || "");
      }
    }
    if (!stdout) return { warm: false, daemonPids: [] };
    const daemonPids = [];
    const wsRoot = String(buildReqs.workspaceRoot || "");
    let expectedGradleVersion = null;
    let expectedGradleJavaHome = buildReqs.envJavaHomeUnset
      ? null
      : buildReqs.envJavaHome || options.env?.JAVA_HOME || null;
    const expectedGradleUserHome = buildReqs.envGradleUserHomeUnset
      ? null
      : buildReqs.envGradleUserHome || options.env?.GRADLE_USER_HOME || null;
    if (
      expectedGradleUserHome === "__UNRESOLVED_DYNAMIC_ENV__" ||
      buildReqs.envLcAll === "__UNRESOLVED_DYNAMIC_ENV__" ||
      buildReqs.envLcMessages === "__UNRESOLVED_DYNAMIC_ENV__" ||
      buildReqs.envLang === "__UNRESOLVED_DYNAMIC_ENV__"
    ) {
      return { warm: false, daemonPids: [] };
    }
    const baseProbeEnv = options.env || process.env || {};
    const hasLocaleOverrideInReqs = Boolean(
      buildReqs.envLcAll ||
        buildReqs.envLcAllUnset ||
        buildReqs.envLcMessages ||
        buildReqs.envLcMessagesUnset ||
        buildReqs.envLang ||
        buildReqs.envLangUnset ||
        (options.env &&
          ("LC_ALL" in options.env || "LC_MESSAGES" in options.env || "LANG" in options.env)),
    );
    const effectiveProbeEnv = hasLocaleOverrideInReqs
      ? {
          ...baseProbeEnv,
          LC_ALL: buildReqs.envLcAllUnset
            ? ""
            : buildReqs.envLcAll || baseProbeEnv.LC_ALL || "",
          LC_MESSAGES: buildReqs.envLcMessagesUnset
            ? ""
            : buildReqs.envLcMessages || baseProbeEnv.LC_MESSAGES || "",
          LANG: buildReqs.envLangUnset
            ? ""
            : buildReqs.envLang || baseProbeEnv.LANG || "",
        }
      : baseProbeEnv;
    const matchesCmdPathBoundary = (cmdLine, targetPath, { allowSubpath = false } = {}) => {
      if (!cmdLine || !targetPath) return false;
      const cleanTarget = String(targetPath).replace(/[\\/]+$/, "");
      if (!cleanTarget) return false;
      let searchFrom = 0;
      while (searchFrom < cmdLine.length) {
        const idx = cmdLine.indexOf(cleanTarget, searchFrom);
        if (idx === -1) return false;
        searchFrom = idx + 1;
        const prevCh = idx > 0 ? cmdLine[idx - 1] : "";
        const prevOk = idx === 0 || /[\s="'(:;]/.test(prevCh);
        if (!prevOk) continue;
        let endIdx = idx + cleanTarget.length;
        if (!allowSubpath) {
          while (
            endIdx < cmdLine.length &&
            (cmdLine[endIdx] === "/" || cmdLine[endIdx] === "\\")
          ) {
            endIdx++;
          }
          const nextCh = endIdx < cmdLine.length ? cmdLine[endIdx] : "";
          if (endIdx === cmdLine.length || /[\s="'),;]/.test(nextCh)) {
            return true;
          }
        } else {
          const nextCh = endIdx < cmdLine.length ? cmdLine[endIdx] : "";
          if (
            endIdx === cmdLine.length ||
            nextCh === "/" ||
            nextCh === "\\" ||
            /[\s="'),;]/.test(nextCh)
          ) {
            return true;
          }
        }
      }
      return false;
    };
    const matchesCmdTokenBoundary = (cmdLine, token) => {
      if (!cmdLine || !token) return false;
      let searchFrom = 0;
      while (searchFrom < cmdLine.length) {
        const idx = cmdLine.indexOf(token, searchFrom);
        if (idx === -1) return false;
        searchFrom = idx + 1;
        const prevCh = idx > 0 ? cmdLine[idx - 1] : "";
        const nextIdx = idx + token.length;
        const nextCh = nextIdx < cmdLine.length ? cmdLine[nextIdx] : "";
        const prevOk = idx === 0 || /[\s"']/.test(prevCh);
        const nextOk = nextIdx === cmdLine.length || /[\s"']/.test(nextCh);
        if (prevOk && nextOk) return true;
      }
      return false;
    };
    const isGradleCompatibilityJvmArg = (tok) => {
      if (!tok || !tok.startsWith("-")) return false;
      if (
        tok === "-cp" ||
        tok === "-classpath" ||
        tok === "--class-path" ||
        tok.startsWith("--class-path=")
      ) {
        return false;
      }
      if (
        tok.startsWith("-Dgradle.user.home=") ||
        tok.startsWith("-Duser.dir=") ||
        tok.startsWith("-Dorg.gradle.appname=")
      ) {
        return false;
      }
      return (
        tok.startsWith("-Xm") ||
        tok.startsWith("-XX:") ||
        tok.startsWith("-Xss") ||
        tok.startsWith("-D") ||
        tok.startsWith("-javaagent:") ||
        tok.startsWith("-agentlib:") ||
        tok.startsWith("-agentpath:") ||
        tok === "-ea" ||
        tok.startsWith("-ea:") ||
        tok === "-enableassertions" ||
        tok.startsWith("-enableassertions:") ||
        tok === "-da" ||
        tok.startsWith("-da:") ||
        tok === "-disableassertions" ||
        tok.startsWith("-disableassertions:") ||
        tok === "-esa" ||
        tok === "-dsa"
      );
    };
    let expectedGradleJvmArgs = [];
    let hasExplicitGradleJvmArgs = false;
    if (buildReqs.tool === "gradle" && wsRoot) {
      try {
        const daemonJvmCriteriaPath = path.join(wsRoot, "gradle", "gradle-daemon-jvm.properties");
        if (
          fs.existsSync(daemonJvmCriteriaPath) &&
          parseJavaProperties(fs.readFileSync(daemonJvmCriteriaPath, "utf8")).size > 0
        ) {
          return { warm: false, daemonPids: [] };
        }
        const wrapperPropsPath = path.join(wsRoot, "gradle", "wrapper", "gradle-wrapper.properties");
        if (fs.existsSync(wrapperPropsPath)) {
          const content = fs.readFileSync(wrapperPropsPath, "utf8");
          const verMatch = content.match(/gradle-([0-9.]+(?:-[A-Za-z0-9.]+)?)-(?:bin|all)\.zip/);
          if (verMatch?.[1]) {
            expectedGradleVersion = verMatch[1];
          }
        }
        const gradleHomePropsDir = buildReqs.envGradleHomeUnset
          ? null
          : buildReqs.gradleHomeDir ||
            options.env?.GRADLE_HOME ||
            (!options.env ? process.env.GRADLE_HOME : null) ||
            null;
        const userHomePropsDir = buildReqs.envGradleUserHomeUnset
          ? null
          : expectedGradleUserHome ||
            buildReqs.gradleUserHomeDir ||
            path.join(options.env?.HOME || os.homedir(), ".gradle");
        const gradlePropsFiles = [
          ...(gradleHomePropsDir ? [path.join(gradleHomePropsDir, "gradle.properties")] : []),
          path.join(wsRoot, "gradle.properties"),
          ...(userHomePropsDir ? [path.join(userHomePropsDir, "gradle.properties")] : []),
        ];
        let daemonDisabledInProps = false;
        for (const gradlePropsPath of gradlePropsFiles) {
          if (fs.existsSync(gradlePropsPath)) {
            const propsMap = parseJavaProperties(fs.readFileSync(gradlePropsPath, "utf8"));
            if (propsMap.has("org.gradle.daemon")) {
              daemonDisabledInProps =
                String(propsMap.get("org.gradle.daemon")).trim().toLowerCase() === "false";
            }
            if (propsMap.has("org.gradle.java.home")) {
              expectedGradleJavaHome = String(propsMap.get("org.gradle.java.home")).trim();
            }
            if (propsMap.has("org.gradle.jvmargs")) {
              hasExplicitGradleJvmArgs = true;
              expectedGradleJvmArgs = splitShellWords(propsMap.get("org.gradle.jvmargs"));
            }
          }
        }
        if (daemonDisabledInProps) {
          return { warm: false, daemonPids: [] };
        }
      } catch {
        return { warm: false, daemonPids: [] };
      }
    }
    if (
      buildReqs.tool === "gradle" &&
      !expectedGradleJavaHome &&
      (buildReqs.envJavaHomeUnset ||
        buildReqs.envPath ||
        (!options.runner && !options.spawnSyncFn))
    ) {
      const rawPathVal = buildReqs.envPathUnset
        ? ""
        : buildReqs.envPath ||
          options.env?.PATH ||
          options.env?.Path ||
          (!options.env ? process.env.PATH || process.env.Path : "") ||
          "";
      if (rawPathVal && rawPathVal !== "__UNRESOLVED_DYNAMIC_ENV__") {
        const pathSep = platform === "win32" ? ";" : ":";
        const javaExeNames = platform === "win32" ? ["java.exe", "java.cmd", "java"] : ["java"];
        for (const rawDir of String(rawPathVal).split(pathSep)) {
          const dir = rawDir.trim();
          if (!dir) continue;
          let foundHome = null;
          for (const exeName of javaExeNames) {
            const candidate = path.join(dir, exeName);
            try {
              if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                const realJava = canonicalizeBuildPath(candidate);
                if (realJava === "/usr/bin/java") {
                  break;
                }
                const parentDir = path.dirname(realJava);
                foundHome =
                  path.basename(parentDir).toLowerCase() === "bin"
                    ? path.dirname(parentDir)
                    : parentDir;
                break;
              }
            } catch {
              // Ignore inaccessible PATH entry
            }
          }
          if (foundHome) {
            expectedGradleJavaHome = foundHome;
            break;
          }
        }
      }
      if (!expectedGradleJavaHome && buildReqs.envJavaHomeUnset) {
        return { warm: false, daemonPids: [] };
      }
    }
    const outKeys = (buildReqs.resourceKeys || [])
      .filter((k) => String(k).startsWith("bazel:out:"))
      .map((k) => String(k).slice("bazel:out:".length));
    let psGradleClientCount = 0;
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmdLine = m[2];
      if (buildReqs.tool === "gradle") {
        if (
          !/GradleDaemon\b/.test(cmdLine) &&
          /\b(?:org\.gradle\.wrapper\.GradleWrapperMain|org\.gradle\.launcher\.GradleMain|org\.gradle\.cli\.GradleCliMain)\b/.test(
            cmdLine,
          )
        ) {
          const clientFirstTok = splitShellWords(cmdLine)[0] || "";
          const clientHasExplicitJavaPath =
            clientFirstTok.includes("/") || clientFirstTok.includes("\\");
          if (
            expectedGradleJavaHome &&
            clientHasExplicitJavaPath &&
            !matchesCmdPathBoundary(cmdLine, expectedGradleJavaHome, { allowSubpath: true }) &&
            !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleJavaHome), {
              allowSubpath: true,
            })
          ) {
            continue;
          }
          if (cmdLine.includes("-Dgradle.user.home=")) {
            if (
              !expectedGradleUserHome ||
              (!matchesCmdPathBoundary(cmdLine, expectedGradleUserHome, { allowSubpath: true }) &&
                !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleUserHome), {
                  allowSubpath: true,
                }))
            ) {
              continue;
            }
          }
          psGradleClientCount++;
          continue;
        }
        if (/GradleDaemon\b/.test(cmdLine)) {
          const verMatch = cmdLine.match(/GradleDaemon\s+([0-9][0-9A-Za-z.-]*)/);
          const daemonVer = verMatch?.[1] || null;
          if (expectedGradleVersion && daemonVer !== expectedGradleVersion) {
            continue;
          }
          if (
            expectedGradleJavaHome &&
            !matchesCmdPathBoundary(cmdLine, expectedGradleJavaHome, { allowSubpath: true }) &&
            !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleJavaHome), {
              allowSubpath: true,
            })
          ) {
            continue;
          }
          if (expectedGradleUserHome) {
            if (
              !matchesCmdPathBoundary(cmdLine, expectedGradleUserHome, { allowSubpath: true }) &&
              !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleUserHome), {
                allowSubpath: true,
              })
            ) {
              continue;
            }
          } else if (cmdLine.includes("-Dgradle.user.home=")) {
            continue;
          }
          const expectedCompatJvmArgs = expectedGradleJvmArgs.filter(
            (arg) => !arg.startsWith("-Dgradle.user.home=") && !arg.startsWith("-Duser.dir="),
          );
          const expectedCompatNorm = stripDefaultGradleDaemonJvmArgs(
            normalizeGradleCompatJvmArgs(expectedCompatJvmArgs),
            { keyed: new Map(), positional: [] },
            effectiveProbeEnv,
          );
          const daemonMainIdx = cmdLine.search(
            /\b(?:org\.gradle\.launcher\.daemon\.bootstrap\.)?GradleDaemon\b/,
          );
          const preMainCmd = daemonMainIdx >= 0 ? cmdLine.slice(0, daemonMainIdx) : cmdLine;
          const preMainTokens = splitShellWords(preMainCmd);
          const daemonCompatJvmArgs = preMainTokens
            .slice(1)
            .filter(
              (tok) => isGradleCompatibilityJvmArg(tok) || expectedCompatJvmArgs.includes(tok),
            );
          const daemonCompatNorm = stripDefaultGradleDaemonJvmArgs(
            normalizeGradleCompatJvmArgs(daemonCompatJvmArgs),
            normalizeGradleCompatJvmArgs(expectedCompatJvmArgs),
            effectiveProbeEnv,
          );
          const rawExpectedCompatNorm = normalizeGradleCompatJvmArgs(expectedCompatJvmArgs);
          const jvmArgsMatch =
            gradleCompatNormEqual(rawExpectedCompatNorm, daemonCompatNorm) ||
            gradleCompatNormEqual(expectedCompatNorm, daemonCompatNorm);
          if (!jvmArgsMatch) {
            continue;
          }
          const matchesWorkspaceOrWrapper =
            (wsRoot && matchesCmdPathBoundary(cmdLine, wsRoot, { allowSubpath: true })) ||
            Boolean(expectedGradleVersion && daemonVer === expectedGradleVersion);
          if (matchesWorkspaceOrWrapper) {
            daemonPids.push(pid);
          }
        }
      } else if (buildReqs.tool === "bazel") {
        const isBazelServer =
          /\bbazel\([^)]+\)/.test(cmdLine) ||
          /com\.google\.devtools\.build\.lib\.bazel\.BazelMain\b/.test(cmdLine);
        if (isBazelServer) {
          const targetOutPaths =
            outKeys.length > 0
              ? outKeys
              : computeDefaultBazelOutputBases(wsRoot, {
                  buildReqs,
                  env: options.env,
                  platform,
                  bazelMajorVersion: options.bazelMajorVersion ?? buildReqs.bazelMajorVersion,
                });
          const matchesWorkspace = targetOutPaths.some(
            (outPath) => outPath && matchesCmdPathBoundary(cmdLine, outPath),
          );
          if (matchesWorkspace) {
            daemonPids.push(pid);
          }
        }
      }
    }
    return filterIdleGradleDaemons(daemonPids, daemonPids.length, psGradleClientCount);
  } catch {
    return { warm: false, daemonPids: [] };
  }
}
