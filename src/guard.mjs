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
]);

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

export function hasAndroidOrAtcTokens(command) {
  if (!command || typeof command !== "string") return false;
  return FAST_PATH_REGEX.test(command);
}

export function splitShellSegments(command) {
  if (!command || typeof command !== "string") return [];
  const innerSubstitutions = [];
  const replaceSub = (_full, inner) => {
    innerSubstitutions.push(inner);
    const tokenMatch = String(inner).match(FAST_PATH_REGEX);
    return tokenMatch ? tokenMatch[1] : "";
  };
  const inlineExpanded = command
    .replace(/(?:\$|<|>)\(([^)]+)\)/g, replaceSub)
    .replace(/`([^`]+)`/g, replaceSub);
  const normalized =
    innerSubstitutions.length > 0
      ? `${inlineExpanded} ; ${innerSubstitutions.join(" ; ")}`
      : inlineExpanded;
  const clauses = normalized
    .split(/(?:&&|\|\||[;\n&])+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const segments = [];
  for (const clause of clauses) {
    const stages = clause
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
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
        if (!/^-[A-Za-z0-9]+$/.test(arg) || FAST_PATH_REGEX.test(arg)) {
          upstreamArgs.push(arg);
        }
      }
    }
  }
  return segments;
}

export function tokenizeSegment(segment) {
  const tokens = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

export function expandVariables(str, vars = {}) {
  if (!str || typeof str !== "string" || !vars || Object.keys(vars).length === 0) {
    return str;
  }
  return str.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (full, k1, k2) => {
      const key = k1 || k2;
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : full;
    },
  );
}

export function parseSegment(segment, inheritedVars = {}) {
  const tokens = tokenizeSegment(segment);
  const envVars = {};
  let idx = 0;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === "export") {
      idx++;
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) {
      const k = tok.slice(0, eq);
      const rawVal = tok.slice(eq + 1);
      envVars[k] = expandVariables(rawVal, { ...inheritedVars, ...envVars });
      idx++;
      continue;
    }
    const base = path.basename(tok, path.extname(tok)).toLowerCase();
    if (base === "command" && (tokens[idx + 1] === "-v" || tokens[idx + 1] === "-V")) {
      break;
    }
    if (TRANSPARENT_WRAPPERS.has(base)) {
      idx++;
      if (base === "command") {
        while (idx < tokens.length && (tokens[idx] === "-p" || tokens[idx] === "--")) {
          idx++;
        }
      } else if (base === "timeout" && idx < tokens.length && /^\d+[smhd]?$/.test(tokens[idx])) {
        idx++;
      } else if (base === "sudo") {
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          const flag = tokens[idx];
          idx++;
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
      } else if (base === "nice") {
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          const flag = tokens[idx];
          idx++;
          if (flag === "-n" && idx < tokens.length) {
            idx++;
          }
        }
      }
      continue;
    }
    break;
  }

  const allVars = { ...inheritedVars, ...envVars };
  const remaining = tokens.slice(idx).map((t) => expandVariables(t, allVars));
  const cmd = remaining[0] || "";
  const baseCmd = path.basename(cmd, path.extname(cmd)).toLowerCase();
  const args = remaining.slice(1);
  return {
    raw: expandVariables(segment, allVars),
    envVars: allVars,
    cmd,
    baseCmd,
    args,
  };
}

export function extractTargetSerial(parsed) {
  if (parsed.envVars.ANDROID_SERIAL) {
    return parsed.envVars.ANDROID_SERIAL;
  }
  const { args } = parsed;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--device=")) {
      return a.slice("--device=".length);
    }
    if ((a === "--device" || a === "-s") && i + 1 < args.length) {
      return args[i + 1];
    }
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

  // Precedence 1: ATC commands (`atc ...`)
  if (baseCmd === "atc") {
    const subcommand = args[0] || "";
    let execTargetSerial = null;
    if (subcommand === "exec") {
      const dashDashIdx = args.indexOf("--");
      let wrappedTokens = [];
      if (dashDashIdx !== -1) {
        wrappedTokens = args.slice(dashDashIdx + 1);
      } else {
        let i = 1;
        while (i < args.length) {
          const a = args[i];
          if ((a === "--session" || a === "--role" || a === "--serial" || a === "--lease") && i + 1 < args.length) {
            i += 2;
          } else if (a.startsWith("--")) {
            i += 1;
          } else {
            break;
          }
        }
        wrappedTokens = args.slice(i);
      }
      if (wrappedTokens.length > 0) {
        const wrappedSeg = wrappedTokens
          .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
          .join(" ");
        const innerClass = classifySegment(wrappedSeg, parsed.envVars, depth + 1);
        if (innerClass.kind === "deny_lifecycle") {
          return innerClass;
        }
        if (innerClass.targetSerial) {
          execTargetSerial = innerClass.targetSerial;
        }
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
  if (baseCmd === "emulator" || (baseCmd === "android" && args[0] === "emulator")) {
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
    const emuAction = args[1] || "";
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

  if (baseCmd === "adb") {
    // Strip -s <serial> / -d / -e flags to find the adb subcommand
    let subIdx = 0;
    while (subIdx < args.length) {
      const a = args[subIdx];
      if (a === "-s" || a === "-t" || a === "-H" || a === "-P") {
        subIdx += 2;
      } else if (a.startsWith("-")) {
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
    if (adbSub === "emu" && adbRest[0] === "kill") {
      return {
        kind: "deny_lifecycle",
        reason: 'Direct "adb emu kill" is disabled under ATC. Use "atc free --stop" instead.',
        parsed,
      };
    }
    if (!adbSub || READ_ONLY_ADB_SUBCOMMANDS.has(adbSub)) {
      return { kind: "read_only", parsed };
    }
    return {
      kind: "device_action",
      targetSerial: extractTargetSerial(parsed),
      parsed,
    };
  }

  // Precedence 3: Read-only Android commands (including top-level `android create` project creation)
  if (baseCmd === "android") {
    const sub = args[0] || "";
    if (!sub || READ_ONLY_ANDROID_SUBCOMMANDS.has(sub)) {
      return { kind: "read_only", parsed };
    }
    return {
      kind: "device_action",
      targetSerial: extractTargetSerial(parsed),
      parsed,
    };
  }

  // Precedence 4: Gradle connectedAndroidTest tasks
  if (baseCmd === "gradlew" || baseCmd === "gradle") {
    const hasConnectedTask = args.some((a) => /connected.*androidtest|connectedcheck/i.test(a));
    if (hasConnectedTask) {
      return {
        kind: "device_action",
        targetSerial: extractTargetSerial(parsed),
        parsed,
      };
    }
    return { kind: "ignore", parsed };
  }

  // Shell wrappers (e.g., `bash -c "adb shell ..."`, `sh -lc "emulator -avd ..."`, `eval adb shell ...`)
  if (SHELL_WRAPPERS.has(baseCmd) && FAST_PATH_REGEX.test(effectiveSegment)) {
    const nonFlagArgs = args.filter((a) => !a.startsWith("-") && a !== "<<<" && a !== "<<");
    const innerStrings = [...args.filter((a) => FAST_PATH_REGEX.test(a))];
    if (nonFlagArgs.length > 1) {
      innerStrings.push(nonFlagArgs.join(" "));
    }
    if (innerStrings.length > 0) {
      let chosen = { kind: "ignore", parsed };
      const rank = { ignore: 0, read_only: 1, atc: 2, device_action: 3, deny_lifecycle: 4 };
      for (const inner of innerStrings) {
        const innerVars = { ...parsed.envVars };
        for (const subSeg of splitShellSegments(inner)) {
          if (subSeg.trim() === effectiveSegment.trim()) continue;
          const subClass = classifySegment(subSeg, innerVars, depth + 1);
          Object.assign(innerVars, subClass.parsed?.envVars || {});
          if ((rank[subClass.kind] || 0) > (rank[chosen.kind] || 0)) {
            chosen = subClass;
          }
        }
      }
      if (chosen.kind !== "ignore") {
        return chosen;
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
    FAST_PATH_REGEX.test(effectiveSegment)
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
          .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
          .join(" ");
        return classifySegment(nestedSegment, parsed.envVars, depth + 1);
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

export function evaluateCommandGuard(command, { sessionId, anchorPid, activeLeases = [], runningCount = 0 } = {}) {
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
  if (needsAtcRewrite && sessionId) {
    if (segments.length > 1) {
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

  const serialList = hasUnscopedDeviceAction ? null : Array.from(targetSerials);

  return {
    allowed: true,
    fastPath: false,
    rewrittenCommand,
    renewLease: hasDeviceAction && activeLeases.length > 0,
    targetSerial: serialList && serialList.length === 1 ? serialList[0] : null,
    targetSerials: serialList,
  };
}
