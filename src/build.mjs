import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function canonicalizeBuildPath(targetPath) {
  const resolved = path.resolve(String(targetPath || "."));
  try {
    const realpathFn = fs.realpathSync.native || fs.realpathSync;
    return realpathFn(resolved);
  } catch {
    return resolved;
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

export function scanExecutableSubstitutions(text) {
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
    else inSingle = v;
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
        const { delim, stripTabs } = pendingHeredocs.shift();
        while (cursor <= s.length) {
          const nextNl = s.indexOf("\n", cursor);
          const lineEnd = nextNl === -1 ? s.length : nextNl;
          let lineText = s.slice(cursor, lineEnd);
          if (lineText.endsWith("\r")) lineText = lineText.slice(0, -1);
          const cmpText = stripTabs ? lineText.replace(/^\t+/, "") : lineText;
          for (let k = cursor; k < lineEnd; k++) {
            mask[k] = 3;
          }
          if (cmpText === delim) {
            if (nextNl !== -1 && pendingHeredocs.length > 0) {
              mask[nextNl] = 3;
              cursor = nextNl + 1;
            } else {
              cursor = lineEnd;
            }
            break;
          }
          if (nextNl === -1) {
            cursor = s.length;
            break;
          }
          mask[nextNl] = 3;
          cursor = nextNl + 1;
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
    if (ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
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
          k++;
          continue;
        }
        if (c === '"') {
          mask[k] = 1;
          dDouble = true;
          k++;
          continue;
        }
        if (c === "\\" && k + 1 < s.length && s[k + 1] !== "\n") {
          mask[k] = 1;
          mask[k + 1] = 1;
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
        pendingHeredocs.push({ delim, stripTabs });
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
      let i = 0;
      while (i < curArgs.length) {
        const a = curArgs[i];
        if (a === "--") {
          i++;
          break;
        }
        if (a === "-" || a === "-i" || a === "--ignore-environment") {
          for (const k of Object.keys(envVars)) {
            delete envVars[k];
          }
          clearedInheritedEnv = true;
          envVars.JAVA_HOME = null;
          envVars.PATH = null;
          envVars.GRADLE_USER_HOME = null;
          i++;
          continue;
        }
        if ((a === "-C" || a === "--chdir") && i + 1 < curArgs.length) {
          const rawNextDir = curArgs[i + 1];
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
              relCwd = relCwd ? path.join(relCwd, nextDir) : nextDir;
            }
          }
          i += 2;
          continue;
        }
        if ((a === "-u" || a === "--unset") && i + 1 < curArgs.length) {
          envVars[stripLiteralSentinels(curArgs[i + 1])] = null;
          i += 2;
          continue;
        }
        if (a.startsWith("--unset=") && a.length > "--unset=".length) {
          envVars[stripLiteralSentinels(a.slice("--unset=".length))] = null;
          i++;
          continue;
        }
        if (a.startsWith("-")) {
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(stripLiteralSentinels(a))) {
          const cleanAssign = stripLiteralSentinels(a);
          const eqIdx = cleanAssign.indexOf("=");
          const rawKey = cleanAssign.slice(0, eqIdx);
          const rawVal = a.slice(a.indexOf("=") + 1);
          if (inShell) {
            const expVal = expandOrValidateShellPath(rawVal, baseEnv, {
              taintedVars: incomingTaintedVars,
              shellType: incomingShellType,
            });
            envVars[rawKey] = expVal.unresolved ? "__UNRESOLVED_DYNAMIC_ENV__" : expVal.resolved;
          } else {
            envVars[rawKey] = stripLiteralSentinels(rawVal);
          }
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
      if (cIdx !== -1 && cIdx + 1 < curArgs.length) {
        const rawScriptArg = stripLiteralSentinels(
          (base === "cmd" || base === "powershell" || base === "pwsh") &&
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
        const candidateBuildToolEnv = {};
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
          const rawParts = splitShellScriptParts(String(scriptToRun || "").trim());
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
          const subExecs = scanExecutableSubstitutions(strippedClause);
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
              }
            }
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
          if (candidateFnName && fnDefs.has(candidateFnName)) {
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
  const { cmd, args, backgrounded, unresolvedDynamicCwd, allBuildClauses } =
    peelBuildWrapperTokens(rawCmd, rawArgs, options);
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
        tool: normalizeBuildToolName(cmd) || "multi",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: false,
        requiresWorkspaceLock: false,
        unresolvedDynamicCwd: true,
        reason:
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
      tool: normalizeBuildToolName(cmd) || "multi",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      unresolvedDynamicCwd: true,
      reason:
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
    if (strArgs.includes("--continuous") || strArgs.includes("-t")) {
      return {
        kind: "reject_long_running",
        tool: "gradle",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: true,
        requiresWorkspaceLock: true,
        reason:
          'Long-running "gradle --continuous" (-t) cannot hold a coordinated build slot indefinitely; run bounded build tasks instead.',
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

    if (
      subcmd === "shutdown" ||
      (subcmd === "clean" &&
        bazelFlags.some((a) => a === "--expunge" || a === "--expunge_async"))
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

    const hasIosDeviceFlag = restArgs.some(
      (a) => a === "--ios_simulator_device" || a.startsWith("--ios_simulator_device="),
    );
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

    if (subcmd === "run" && !requiresDevice) {
      const boundedBuildOnly =
        bazelFlags.includes("--norun") || bazelFlags.some((a) => a.startsWith("--script_path"));
      if (!boundedBuildOnly) {
        return {
          kind: "reject_long_running",
          tool: "bazel",
          targetPlatform: null,
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
  { forceBuild = false, inheritedEnvVars = null, env = process.env } = {},
) {
  const baseEnv = { ...(env || process.env), ...(inheritedEnvVars || {}) };
  const {
    cmd,
    args,
    relCwd,
    envVars,
    backgrounded,
    unresolvedDynamicCwd,
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
      tool: normalizeBuildToolName(cmd) || "multi",
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      unresolvedDynamicCwd: true,
      workspaceRoot: null,
      resourceKeys: [],
      reason:
        "Unresolved dynamic directory change in shell wrapper cannot be mapped to a workspace lock; expand or export the target directory variable before invoking atc exec.",
    };
  }
  const effectiveEnvVars = { ...(inheritedEnvVars || {}), ...(envVars || {}) };
  const outerCwd = path.resolve(cwd || process.cwd());
  if (allBuildClauses && allBuildClauses.length > 1) {
    const clauseRes = allBuildClauses.map((c) => {
      const clauseCwd = c.relCwd ? path.resolve(outerCwd, c.relCwd) : outerCwd;
      return resolveBuildResources(c.cmd, c.args, clauseCwd, {
        forceBuild: false,
        inheritedEnvVars: c.envVars || effectiveEnvVars,
        env,
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
      requiresDevice,
      requiresHeavySlot,
      requiresWorkspaceLock,
      disablesDaemon: clauseRes.some((r) => r.disablesDaemon),
      workspaceRoot: clauseRes.find((r) => r.workspaceRoot)?.workspaceRoot || null,
      resourceKeys: Array.from(new Set(clauseRes.flatMap((r) => r.resourceKeys || []))),
      clauseBuildReqs: clauseRes.filter((r) => r.requiresHeavySlot),
    };
  }
  const classified = classifyBuildCommand(cmd, args);
  const baseCwd = relCwd ? path.resolve(outerCwd, relCwd) : outerCwd;
  if (classified.kind === "not_build_tool") {
    if (forceBuild) {
      const canonicalRoot = canonicalizeBuildPath(baseCwd);
      return {
        kind: "pure_build",
        tool: "custom",
        targetPlatform: null,
        requiresDevice: false,
        requiresHeavySlot: true,
        requiresWorkspaceLock: true,
        workspaceRoot: canonicalRoot,
        resourceKeys: [`workspace:${canonicalRoot}`],
      };
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
    const disablesDaemon = strArgs.some(
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
    const envJavaHomeUnset =
      effectiveEnvVars.JAVA_HOME === null || effectiveEnvVars.JAVA_HOME === "";
    const envPathUnset =
      effectiveEnvVars.PATH === null || effectiveEnvVars.PATH === "";
    const envGradleUserHomeUnset =
      effectiveEnvVars.GRADLE_USER_HOME === null || effectiveEnvVars.GRADLE_USER_HOME === "";
    return {
      ...classified,
      disablesDaemon,
      envJavaHome: envJavaHomeUnset ? "" : effectiveEnvVars.JAVA_HOME || null,
      envJavaHomeUnset,
      envPath: envPathUnset ? "" : effectiveEnvVars.PATH || null,
      envPathUnset,
      envGradleUserHome: envGradleUserHomeUnset ? "" : effectiveEnvVars.GRADLE_USER_HOME || null,
      envGradleUserHomeUnset,
      workspaceRoot: canonicalRoot,
      resourceKeys: [`gradle:${canonicalRoot}`],
    };
  }

  if (classified.tool === "bazel") {
    let outputBase = null;
    let outputUserRoot = null;
    let disablesDaemon = false;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--batch") {
        disablesDaemon = true;
        continue;
      }
      if (a === "--nobatch") {
        disablesDaemon = false;
        continue;
      }
      if (a === "--output_base" && i + 1 < strArgs.length) {
        outputBase = path.resolve(baseCwd, strArgs[++i]);
        continue;
      }
      if (a.startsWith("--output_base=")) {
        outputBase = path.resolve(baseCwd, a.slice("--output_base=".length));
        continue;
      }
      if (a === "--output_user_root" && i + 1 < strArgs.length) {
        outputUserRoot = path.resolve(baseCwd, strArgs[++i]);
        continue;
      }
      if (a.startsWith("--output_user_root=")) {
        outputUserRoot = path.resolve(baseCwd, a.slice("--output_user_root=".length));
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

    const rootDir =
      findNearestMarkerAncestor(baseCwd, [
        "MODULE.bazel",
        "REPO.bazel",
        "WORKSPACE.bazel",
        "WORKSPACE",
      ]) || baseCwd;

    const canonicalRoot = canonicalizeBuildPath(rootDir);
    const canonicalUserRoot = outputUserRoot ? canonicalizeBuildPath(outputUserRoot) : null;
    const resourceKeys = [`bazel:ws:${canonicalRoot}`];
    if (outputBase) {
      resourceKeys.push(`bazel:out:${canonicalizeBuildPath(outputBase)}`);
    } else if (canonicalUserRoot) {
      const wsMd5 = crypto.createHash("md5").update(canonicalRoot).digest("hex");
      resourceKeys.push(`bazel:out:${path.join(canonicalUserRoot, wsMd5)}`);
    }
    return {
      ...classified,
      disablesDaemon,
      bazelOutputUserRoot: canonicalUserRoot,
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    };
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
    return {
      ...classified,
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    };
  }

  return {
    ...classified,
    workspaceRoot: null,
    resourceKeys: [],
  };
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
  if (a.prefix === "workspace" || b.prefix === "workspace") {
    return (
      a.path === b.path ||
      a.path.startsWith(`${b.path}/`) ||
      a.path.startsWith(`${b.path}\\`) ||
      b.path.startsWith(`${a.path}/`) ||
      b.path.startsWith(`${a.path}\\`)
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
  if (typeof options.warmBuildDaemon === "boolean") {
    return { warm: options.warmBuildDaemon, daemonPids: [] };
  }
  if (Array.isArray(options.inventory?.warmBuildDaemons)) {
    const matched = options.inventory.warmBuildDaemons.filter((d) => {
      if (!d) return false;
      if (typeof d === "string") return d === buildReqs.tool || d === buildReqs.workspaceRoot;
      if (d.tool && d.tool !== buildReqs.tool) return false;
      if (d.workspaceRoot && buildReqs.workspaceRoot && d.workspaceRoot !== buildReqs.workspaceRoot) {
        return false;
      }
      return true;
    });
    return {
      warm: matched.length > 0,
      daemonPids: matched.map((d) => d.pid).filter(Boolean),
    };
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
    const defaultBazelOutMd5 = wsRoot
      ? crypto.createHash("md5").update(wsRoot).digest("hex")
      : null;
    let expectedGradleVersion = null;
    let expectedGradleJavaHome = buildReqs.envJavaHomeUnset
      ? null
      : buildReqs.envJavaHome || options.env?.JAVA_HOME || null;
    const expectedGradleUserHome = buildReqs.envGradleUserHomeUnset
      ? null
      : buildReqs.envGradleUserHome || options.env?.GRADLE_USER_HOME || null;
    if (expectedGradleUserHome === "__UNRESOLVED_DYNAMIC_ENV__") {
      return { warm: false, daemonPids: [] };
    }
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
    let expectedGradleJvmArgs = [];
    if (buildReqs.tool === "gradle" && wsRoot) {
      try {
        const wrapperPropsPath = path.join(wsRoot, "gradle", "wrapper", "gradle-wrapper.properties");
        if (fs.existsSync(wrapperPropsPath)) {
          const content = fs.readFileSync(wrapperPropsPath, "utf8");
          const verMatch = content.match(/gradle-([0-9.]+(?:-[A-Za-z0-9.]+)?)-(?:bin|all)\.zip/);
          if (verMatch?.[1]) {
            expectedGradleVersion = verMatch[1];
          }
        }
        const gradlePropsPath = path.join(wsRoot, "gradle.properties");
        if (fs.existsSync(gradlePropsPath)) {
          const propsContent = fs.readFileSync(gradlePropsPath, "utf8");
          for (const rawPropLine of propsContent.split(/\r?\n/)) {
            const propLine = rawPropLine.trim();
            if (!propLine || propLine.startsWith("#")) continue;
            const jhMatch = propLine.match(/^org\.gradle\.java\.home\s*=\s*(.+)$/);
            if (jhMatch?.[1]) {
              expectedGradleJavaHome = jhMatch[1].trim().replace(/\\:/g, ":");
            }
            const jvmMatch = propLine.match(/^org\.gradle\.jvmargs\s*=\s*(.+)$/);
            if (jvmMatch?.[1]) {
              expectedGradleJvmArgs = jvmMatch[1]
                .trim()
                .split(/\s+/)
                .filter((tok) => tok.startsWith("-Xm") || tok.startsWith("-XX:"));
            }
          }
        }
      } catch {
        // Ignore wrapper property read errors
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
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmdLine = m[2];
      if (buildReqs.tool === "gradle") {
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
          if (
            expectedGradleJvmArgs.length > 0 &&
            !expectedGradleJvmArgs.every((arg) => cmdLine.includes(arg))
          ) {
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
          const matchesOut = outKeys.some(
            (outPath) => outPath && matchesCmdPathBoundary(cmdLine, outPath),
          );
          const matchesDefaultMd5 =
            defaultBazelOutMd5 &&
            new RegExp(`(?:^|[\\\\/=])${defaultBazelOutMd5}(?:$|[\\\\/\\s"'])`, "i").test(cmdLine);
          const matchesUserRootAndWs = Boolean(
            buildReqs.bazelOutputUserRoot &&
              matchesCmdPathBoundary(cmdLine, buildReqs.bazelOutputUserRoot, {
                allowSubpath: true,
              }) &&
              wsRoot &&
              (matchesCmdPathBoundary(cmdLine, wsRoot) || matchesDefaultMd5),
          );
          const matchesWorkspace =
            outKeys.length > 0
              ? matchesOut || matchesUserRootAndWs
              : Boolean(
                  wsRoot && (matchesCmdPathBoundary(cmdLine, wsRoot) || matchesDefaultMd5),
                );
          if (matchesWorkspace) {
            daemonPids.push(pid);
          }
        }
      }
    }
    return { warm: daemonPids.length > 0, daemonPids };
  } catch {
    return { warm: false, daemonPids: [] };
  }
}
