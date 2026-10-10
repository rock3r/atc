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
        if (ch === ";" || ch === "\n" || ch === "&") {
          if (cur.trim()) parts.push(cur.trim());
          cur = "";
          continue;
        }
      } else if (sepType === "pipe") {
        if (ch === "|" && str[i + 1] !== "|") {
          if (cur.trim()) parts.push(cur.trim());
          cur = "";
          continue;
        }
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
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
    if (m[1] !== undefined) {
      tokens.push(m[1].replace(/\\(["\\])/g, "$1"));
    } else {
      tokens.push(m[2] ?? m[3]);
    }
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
  const remaining = tokens.slice(idx).map((t) => expandVariables(t, allVars));
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
    let subIdx = 0;
    while (subIdx < args.length) {
      const a = String(args[subIdx]);
      if (a === "-d" || a === "-e" || a === "-t" || a.startsWith("-t")) {
        return a === "-t" && subIdx + 1 < args.length ? `-t ${args[subIdx + 1]}` : a;
      }
      if (a === "-s" && subIdx + 1 < args.length) {
        return String(args[subIdx + 1]);
      }
      if (a.startsWith("-s") && a.length > 2) {
        return a.slice(2);
      }
      if (a === "-H" || a === "-P" || a === "-L") {
        subIdx += 2;
      } else if (a.startsWith("-")) {
        subIdx += 1;
      } else {
        break;
      }
    }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--device=")) {
      return a.slice("--device=".length);
    }
    if ((a === "--device" || a === "-s") && i + 1 < args.length) {
      return args[i + 1];
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
          .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
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
    return { subIdx, sub, actIdx, action };
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
    const remoteRest = args
      .slice(androidSubInfo.actIdx + 1)
      .map(String)
      .filter((a) => !a.startsWith("-"));
    const remoteAction = remoteRest[0] || "";
    if (
      args.includes("--help") ||
      args.includes("-h") ||
      remoteAction === "list" ||
      remoteAction === "status" ||
      !remoteAction
    ) {
      return { kind: "read_only", parsed };
    }
    if (
      ["remove", "delete", "disconnect", "stop", "release", "create", "reserve", "connect", "add"].includes(
        remoteAction,
      )
    ) {
      return {
        kind: "deny_lifecycle",
        reason: `Direct "android device remote ${remoteAction}" is disabled under ATC because remote device lifecycle is not isolated per lease.`,
        parsed,
      };
    }
  }

  if (baseCmd === "adb") {
    // Strip -s <serial> / -d / -e / -t / -H / -P / -L flags and wait-for-* prefixes to find the adb subcommand
    let subIdx = 0;
    let hadWaitPrefix = false;
    while (subIdx < args.length) {
      const a = args[subIdx];
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

function rewriteCompoundCommand(command, { sessionId, anchorPid, execSerial, platform = "win32" }) {
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
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && !inSingle && i + 1 < command.length) {
      cur += ch + command[i + 1];
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
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
        tokens.push({ type: "stage", text: cur });
        tokens.push({ type: "sep", text: ` ${ch}${command[i + 1]} ` });
        cur = "";
        i++;
        continue;
      }
      if (ch === ";" || ch === "\n" || ch === "|") {
        tokens.push({ type: "stage", text: cur });
        tokens.push({ type: "sep", text: ch === "\n" ? "\n" : ` ${ch} ` });
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
  return tokens
    .map((tok) => {
      if (tok.type !== "stage") return tok.text;
      const trimmed = tok.text.trim();
      if (!trimmed) return tok.text;
      const c = classifySegment(trimmed, shellVars);
      Object.assign(shellVars, c.parsed?.envVars || {});
      if (c.kind === "device_action" && execSerial) {
        if (isWin) {
          return `atc exec${sessionFlag} --serial ${execSerial} -- ${trimmed}`;
        }
        const isSimpleStage =
          !/[<>|&;`$()\r\n]/.test(trimmed) && !tokenizeSegment(trimmed)[0]?.includes("=");
        if (isSimpleStage) {
          return `${posixEnvPrefix}atc exec --serial ${execSerial} -- ${trimmed}`;
        }
        const escaped = `'${String(trimmed).replace(/'/g, `'\\''`)}'`;
        return `${posixEnvPrefix}atc exec --serial ${execSerial} -- sh -c ${escaped}`;
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
      !/[<>|&;`$()\r\n]/.test(command) &&
      !tokenizeSegment(command)[0]?.includes("=");
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
