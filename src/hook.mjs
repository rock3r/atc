import fs from "node:fs";
import { discoverFleet } from "./android.mjs";
import { evaluateCommandGuard, hasAndroidOrAtcTokens } from "./guard.mjs";
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

  // Claude Code / Codex / Cursor format
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
  if (!norm.isShellTool || !norm.command) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // Fast Path (<2ms, Zero Lock)
  if (!hasAndroidOrAtcTokens(norm.command)) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  const cwd = options.cwd || process.cwd();
  const inventory = options.inventory || null;
  const runningCount = inventory
    ? (inventory.running || []).length
    : 1;

  const evalResult = withStateTransaction(stateDir, (state, { now }) => {
    state.hookSessions[String(norm.anchorPid)] = {
      sessionId: norm.sessionId,
      agentPid: norm.anchorPid,
      cwd,
      updatedAtMs: now,
    };

    const activeLeases = Object.values(state.leases).filter(
      (l) => l.state === "active" && l.sessionId === norm.sessionId,
    );

    const guardRes = evaluateCommandGuard(norm.command, {
      sessionId: norm.sessionId,
      anchorPid: norm.anchorPid,
      activeLeases,
      runningCount,
    });

    if (guardRes.allowed && guardRes.renewLease) {
      const ttlMs = (state.config.defaultTtlSec || 600) * 1000;
      for (const lease of activeLeases) {
        lease.renewedAtMs = now;
        lease.expiresAtMs = Math.max(lease.expiresAtMs, now + ttlMs);
      }
    }

    return { mutated: true, value: guardRes };
  });

  if (!evalResult.allowed) {
    const denyJson =
      norm.hostFormat === "antigravity"
        ? { decision: "block", reason: evalResult.reason }
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

  if (evalResult.rewrittenCommand) {
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

  return { exitCode: 0, stdout: "", stderr: "" };
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

  const freed = withStateTransaction(stateDir, (state) => {
    let targetSessionId = rawSession ? sanitizeSessionId(rawSession, ppid) : null;
    if (!targetSessionId && state.hookSessions[String(ppid)]) {
      targetSessionId = state.hookSessions[String(ppid)].sessionId;
    }
    const released = [];
    if (!targetSessionId) {
      return { mutated: false, value: released };
    }
    for (const [deviceKey, lease] of Object.entries(state.leases)) {
      if (lease.state === "active" && lease.sessionId === targetSessionId) {
        released.push(lease.leaseId);
        delete state.leases[deviceKey];
      }
    }
    delete state.hookSessions[String(ppid)];
    return { mutated: released.length > 0, value: released };
  });

  return { exitCode: 0, freed };
}

export function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
