import fs from "node:fs";
import { parseAdbDevicesOutput } from "./android.mjs";
import { cmdFree } from "./cli.mjs";
import {
  classifySegment,
  evaluateCommandGuard,
  hasAndroidOrAtcTokens,
  splitShellSegments,
} from "./guard.mjs";
import { runCommandSync } from "./spawn.mjs";
import { validateSessionId, withStateTransaction } from "./state.mjs";

export function parseHookInput(rawStdin) {
  if (!rawStdin || !String(rawStdin).trim()) return null;
  try {
    return JSON.parse(String(rawStdin));
  } catch {
    return null;
  }
}

export function normalizeHookPayload(payload, ppid = process.ppid) {
  if (!payload || typeof payload !== "object") {
    return { isShellTool: false };
  }

  // Antigravity / Gemini CLI format
  if (payload.toolCall && typeof payload.toolCall === "object") {
    const name = String(payload.toolCall.name || "");
    const args = payload.toolCall.args || {};
    const command = args.CommandLine ?? args.command ?? "";
    const rawSession = payload.conversationId || payload.session_id || `ppid-${ppid}`;
    return {
      hostFormat: "antigravity",
      isShellTool: name === "run_command" || name === "bash" || name === "shell",
      command: typeof command === "string" ? command : "",
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
    };
  }

  // Cursor beforeShellExecution format (top-level `command` field)
  if (
    payload.hook_event_name === "beforeShellExecution" ||
    (typeof payload.command === "string" && !payload.tool_name && !payload.toolName)
  ) {
    const rawSession =
      payload.conversation_id ||
      payload.conversationId ||
      payload.session_id ||
      payload.sessionId ||
      `ppid-${ppid}`;
    return {
      hostFormat: "cursor",
      isShellTool: true,
      command: typeof payload.command === "string" ? payload.command : "",
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
    };
  }

  // Claude Code / Codex format
  const toolName = String(payload.tool_name || payload.toolName || "");
  const toolInput = payload.tool_input || payload.input || {};
  const command = toolInput.command ?? toolInput.CommandLine ?? "";
  const rawSession =
    payload.session_id ||
    payload.sessionId ||
    payload.conversation_id ||
    payload.conversationId ||
    `ppid-${ppid}`;
  return {
    hostFormat: "standard",
    isShellTool: /^(bash|shell|run_command|terminal)$/i.test(toolName),
    command: typeof command === "string" ? command : "",
    sessionId: sanitizeSessionId(rawSession, ppid),
    anchorPid: ppid,
    toolInput,
  };
}

function sanitizeSessionId(raw, ppid) {
  const cleaned = String(raw || `ppid-${ppid}`)
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, "_")
    .slice(0, 128);
  return validateSessionId(cleaned || `ppid-${ppid}`);
}

export function handlePreToolUseHook(stateDir, rawStdin, options = {}) {
  const payload = typeof rawStdin === "string" ? parseHookInput(rawStdin) : rawStdin;
  const norm = normalizeHookPayload(payload, options.ppid ?? process.ppid);
  const cursorAllowOut =
    norm.hostFormat === "cursor" ? JSON.stringify({ permission: "allow" }) + "\n" : "";
  if (!norm.isShellTool || !norm.command) {
    return { exitCode: 0, stdout: cursorAllowOut, stderr: "" };
  }

  // Fast Path (<2ms, Zero Lock)
  if (!hasAndroidOrAtcTokens(norm.command)) {
    return { exitCode: 0, stdout: cursorAllowOut, stderr: "" };
  }

  const cwd = options.cwd || process.cwd();
  const inventory = options.inventory || null;
  let probedRunningCount = inventory ? (inventory.running || []).length : 0;

  if (!inventory && options.runningCount === undefined) {
    const hasUnscopedDeviceAction = splitShellSegments(norm.command).some((seg) => {
      const c = classifySegment(seg);
      return c.kind === "device_action" && !c.targetSerial;
    });
    if (hasUnscopedDeviceAction) {
      const runner = options.runner || runCommandSync;
      const adbRes = runner("adb", ["devices"], { timeoutMs: 3000 });
      if (adbRes.status === 0 && adbRes.stdout) {
        probedRunningCount = parseAdbDevicesOutput(adbRes.stdout).length;
      }
    }
  } else if (options.runningCount !== undefined) {
    probedRunningCount = options.runningCount;
  }

  const evalResult = withStateTransaction(
    stateDir,
    (state, { now }) => {
      state.hookSessions[String(norm.anchorPid)] = {
        sessionId: norm.sessionId,
        agentPid: norm.anchorPid,
        cwd,
        updatedAtMs: now,
      };

      const fallbackPpidSession = `ppid-${norm.anchorPid}`;
      for (const l of Object.values(state.leases)) {
        if (
          l.state === "active" &&
          (l.sessionId === fallbackPpidSession ||
            (l.anchorPid === norm.anchorPid && String(l.sessionId).startsWith("ppid-")))
        ) {
          l.sessionId = norm.sessionId;
        }
      }

      const activeLeases = Object.values(state.leases).filter(
        (l) => l.state === "active" && l.sessionId === norm.sessionId,
      );
      const totalLeasedCount = Object.keys(state.leases).length;
      const runningCount = Math.max(probedRunningCount, totalLeasedCount, activeLeases.length);

      const guardRes = evaluateCommandGuard(norm.command, {
        sessionId: norm.sessionId,
        anchorPid: norm.anchorPid,
        activeLeases,
        runningCount,
      });

      if (guardRes.allowed && guardRes.renewLease) {
        const ttlMs = (state.config?.defaultTtlSec ?? 600) * 1000;
        const targeted =
          Array.isArray(guardRes.targetSerials) && guardRes.targetSerials.length > 0
            ? new Set(guardRes.targetSerials)
            : guardRes.targetSerial
              ? new Set([guardRes.targetSerial])
              : null;
        for (const lease of activeLeases) {
          if (!targeted || targeted.has(lease.serial)) {
            lease.renewedAtMs = now;
            lease.expiresAtMs = Math.max(lease.expiresAtMs, now + ttlMs);
          }
        }
      }

      return { mutated: true, value: guardRes };
    },
    { ppid: norm.anchorPid },
  );

  if (!evalResult.allowed) {
    const denyJson =
      norm.hostFormat === "antigravity"
        ? { decision: "block", reason: evalResult.reason }
        : norm.hostFormat === "cursor"
          ? {
              permission: "deny",
              user_message: evalResult.reason,
              agent_message: evalResult.reason,
            }
          : {
              decision: "block",
              reason: evalResult.reason,
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: evalResult.reason,
              },
            };
    return {
      exitCode: 2,
      stdout: JSON.stringify(denyJson) + "\n",
      stderr: evalResult.reason + "\n",
    };
  }

  if (evalResult.rewrittenCommand && norm.hostFormat !== "cursor") {
    const allowJson =
      norm.hostFormat === "antigravity"
        ? {
            overwrite: {
              CommandLine: evalResult.rewrittenCommand,
            },
          }
        : {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: {
                ...norm.toolInput,
                command: evalResult.rewrittenCommand,
              },
            },
          };
    return {
      exitCode: 0,
      stdout: JSON.stringify(allowJson) + "\n",
      stderr: "",
    };
  }

  return { exitCode: 0, stdout: cursorAllowOut, stderr: "" };
}

export function handleStopHook(stateDir, rawStdin, options = {}) {
  const payload = typeof rawStdin === "string" ? parseHookInput(rawStdin) : rawStdin;
  if (payload && payload.fullyIdle === false) {
    return { exitCode: 0, freed: [] };
  }
  const ppid = options.ppid ?? process.ppid;
  const rawSession =
    payload?.session_id ||
    payload?.sessionId ||
    payload?.conversationId ||
    payload?.conversation_id ||
    null;

  const targetSessionId = withStateTransaction(
    stateDir,
    (state) => {
      let resolvedId = rawSession ? sanitizeSessionId(rawSession, ppid) : null;
      if (!resolvedId && state.hookSessions[String(ppid)]) {
        resolvedId = state.hookSessions[String(ppid)].sessionId;
      }
      const fallbackPpidSession = `ppid-${ppid}`;
      let mutated = Boolean(state.hookSessions[String(ppid)]);
      delete state.hookSessions[String(ppid)];

      for (const l of Object.values(state.leases)) {
        if (
          l.state === "active" &&
          (l.sessionId === fallbackPpidSession ||
            (l.anchorPid === ppid && String(l.sessionId).startsWith("ppid-")))
        ) {
          if (resolvedId) {
            l.sessionId = resolvedId;
            mutated = true;
          } else {
            resolvedId = l.sessionId;
          }
        }
      }
      return { mutated, value: resolvedId };
    },
    { ppid },
  );

  if (!targetSessionId) {
    return { exitCode: 0, freed: [] };
  }

  const freeRes = cmdFree(stateDir, null, { session: targetSessionId }, options);
  return {
    exitCode: freeRes.exitCode,
    freed: freeRes.freed || [],
    error: freeRes.error,
  };
}

export function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
