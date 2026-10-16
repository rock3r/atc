import fs from "node:fs";
import { cmdFree } from "./cli.mjs";
import {
  getAncestorPids,
  readState,
  recordHookSession,
  resolveStableParentPid,
  validateSessionId,
  withStateTransaction,
} from "./state.mjs";

// v3: hooks never read, inspect or rewrite shell commands (see docs/scope.md §1). They only
// record the host agent's session identity (so `atc` CLI calls and MCP tools resolve the same
// session) and inject that session into ATC MCP tool calls.

export function parseHookInput(rawStdin) {
  if (!rawStdin || !String(rawStdin).trim()) return null;
  try {
    return JSON.parse(String(rawStdin));
  } catch {
    return null;
  }
}

const ATC_MCP_TOOL_RE =
  /(?:^|[_:/.-])(atc_(?:claim|free|renew|snapshot|status|guide|gradle|bazel|xcode|android|ios|batch))$/i;
const ATC_SESSION_MCP_TOOLS = new Set([
  "atc_claim",
  "atc_free",
  "atc_renew",
  "atc_snapshot",
  "atc_gradle",
  "atc_bazel",
  "atc_xcode",
  "atc_android",
  "atc_ios",
  "atc_batch",
]);
const SHELL_SESSION_REFRESH_MS = 30_000;

function matchAtcMcpTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  const m = toolName.match(ATC_MCP_TOOL_RE);
  return m ? m[1].toLowerCase() : null;
}

export function normalizeHookPayload(payload, ppid = process.ppid) {
  if (!payload || typeof payload !== "object") {
    return { isShellTool: false, mcpToolName: null };
  }

  // Antigravity / Gemini CLI format
  if (payload.toolCall && typeof payload.toolCall === "object") {
    const name = String(payload.toolCall.name || "");
    const args =
      payload.toolCall.args && typeof payload.toolCall.args === "object"
        ? payload.toolCall.args
        : {};
    const isLazyMcpWrapper = name === "call_mcp_tool" && typeof args.ToolName === "string";
    const mcpToolName = isLazyMcpWrapper
      ? matchAtcMcpTool(args.ToolName)
      : matchAtcMcpTool(name);
    const mcpToolInput = isLazyMcpWrapper
      ? args.Arguments && typeof args.Arguments === "object"
        ? args.Arguments
        : {}
      : args;
    const rawSession = payload.conversationId || payload.session_id || `ppid-${ppid}`;
    const payloadCwd =
      typeof args.Cwd === "string" && args.Cwd.trim()
        ? args.Cwd.trim()
        : typeof payload.cwd === "string" && payload.cwd.trim()
          ? payload.cwd.trim()
          : Array.isArray(payload.workspacePaths) &&
              typeof payload.workspacePaths[0] === "string" &&
              payload.workspacePaths[0].trim()
            ? payload.workspacePaths[0].trim()
            : null;
    return {
      hostFormat: "antigravity",
      isShellTool: name === "run_command" || name === "bash" || name === "shell",
      isLazyMcpWrapper,
      mcpToolName,
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
      toolInput: mcpToolName ? mcpToolInput : {},
      cwd: payloadCwd,
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
      mcpToolName: null,
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
    };
  }

  // GitHub Copilot CLI native format (camelCase `toolName` + `toolArgs`, object or JSON string)
  if (typeof payload.toolName === "string" && "toolArgs" in payload && !payload.tool_input) {
    const mcpToolName = matchAtcMcpTool(payload.toolName);
    let toolArgs = mcpToolName ? payload.toolArgs : {};
    if (typeof toolArgs === "string") {
      try {
        toolArgs = JSON.parse(toolArgs);
      } catch {
        toolArgs = {};
      }
    }
    if (!toolArgs || typeof toolArgs !== "object") toolArgs = {};
    const rawSession = payload.sessionId || payload.session_id || `ppid-${ppid}`;
    return {
      hostFormat: "copilot",
      isShellTool: /^(bash|shell)$/i.test(payload.toolName),
      mcpToolName,
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
      toolInput: toolArgs,
    };
  }

  // Claude Code / Codex format
  const toolName = String(payload.tool_name || payload.toolName || "");
  const mcpToolName = matchAtcMcpTool(toolName);
  const rawInput = mcpToolName ? payload.tool_input || payload.input || {} : {};
  const toolInput = rawInput && typeof rawInput === "object" ? rawInput : {};
  const rawSession =
    payload.session_id ||
    payload.sessionId ||
    payload.conversation_id ||
    payload.conversationId ||
    `ppid-${ppid}`;
  return {
    hostFormat: "standard",
    isShellTool: /^(bash|shell|run_command|terminal)$/i.test(toolName),
    mcpToolName,
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

// Rebind leases created under a fallback identity (ppid-*/mcp-*) to the host's real session.
function adoptFallbackLeases(state, anchorPid, sessionId, hookEntry) {
  const singleSessionOnAnchor =
    !Array.isArray(hookEntry?.seenSessions) || hookEntry.seenSessions.length <= 1;
  const fallbackPpidSession = `ppid-${anchorPid}`;
  const candidateFallbackSessions = new Set(
    Object.values(state.leases)
      .filter(
        (l) =>
          l.state === "active" &&
          (l.sessionId === fallbackPpidSession ||
            ((l.anchorPid === anchorPid || l.parentPid === anchorPid) &&
              (String(l.sessionId).startsWith("ppid-") || String(l.sessionId).startsWith("mcp-")))),
      )
      .map((l) => l.sessionId),
  );
  if (candidateFallbackSessions.size === 1 && singleSessionOnAnchor) {
    for (const l of Object.values(state.leases)) {
      if (l.state === "active" && candidateFallbackSessions.has(l.sessionId)) {
        if (String(l.sessionId).startsWith("mcp-")) {
          l.mcpSessionId = l.mcpSessionId || l.sessionId;
        }
        l.sessionId = sessionId;
      }
    }
  }
}

export function handlePreToolUseHook(stateDir, rawStdin, options = {}) {
  const payload = typeof rawStdin === "string" ? parseHookInput(rawStdin) : rawStdin;
  const rawPpid = options.ppid ?? process.ppid;
  const fastNorm = normalizeHookPayload(payload, rawPpid);
  const allowOut =
    fastNorm.hostFormat === "cursor"
      ? JSON.stringify({ permission: "allow" }) + "\n"
      : fastNorm.hostFormat === "antigravity"
        ? JSON.stringify({ decision: "allow" }) + "\n"
        : "";

  if (fastNorm.mcpToolName) {
    getAncestorPids(rawPpid);
    const norm = normalizeHookPayload(
      payload,
      resolveStableParentPid(rawPpid, options.processChain),
    );
    const cwd =
      options.cwd ||
      norm.cwd ||
      (typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd());
    withStateTransaction(
      stateDir,
      (state, { now }) => {
        recordHookSession(state, {
          anchorPid: norm.anchorPid,
          sessionId: norm.sessionId,
          cwd,
          now,
          mcpToolName: norm.mcpToolName,
          mcpToolInput: norm.toolInput,
        });
        return { mutated: true };
      },
      { ppid: norm.anchorPid },
    );

    if (
      ATC_SESSION_MCP_TOOLS.has(norm.mcpToolName) &&
      !norm.toolInput?.session &&
      !norm.toolInput?.role
    ) {
      const updatedArgs = { ...norm.toolInput, session: norm.sessionId };
      const antigravityOverwrite = norm.isLazyMcpWrapper
        ? { Arguments: updatedArgs }
        : updatedArgs;
      const allowMcpJson =
        norm.hostFormat === "antigravity"
          ? { decision: "allow", overwrite: antigravityOverwrite }
          : norm.hostFormat === "copilot"
            ? { permissionDecision: "allow", modifiedArgs: updatedArgs }
            : {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                  updatedInput: updatedArgs,
                },
              };
      return {
        exitCode: 0,
        stdout: JSON.stringify(allowMcpJson) + "\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: allowOut, stderr: "" };
  }

  if (!fastNorm.isShellTool) {
    return { exitCode: 0, stdout: allowOut, stderr: "" };
  }

  // Shell tool call: always allowed and never inspected. Refresh the session record for this
  // agent (so `atc` CLI invocations from its shell resolve the same session), at most every 30s.
  const anchorPid = resolveStableParentPid(rawPpid, options.processChain);
  const norm = normalizeHookPayload(payload, anchorPid);
  const now = options.now ?? Date.now();
  let fresh = false;
  try {
    const peek = readState(stateDir);
    const entry = peek?.hookSessions?.[String(anchorPid)];
    fresh = Boolean(entry && entry.sessionId === norm.sessionId && now - (entry.updatedAtMs || 0) < SHELL_SESSION_REFRESH_MS);
  } catch {
    fresh = false;
  }
  if (!fresh) {
    const cwd =
      options.cwd ||
      norm.cwd ||
      (typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd());
    try {
      withStateTransaction(
        stateDir,
        (state, { now: txNow }) => {
          const hookEntry = recordHookSession(state, {
            anchorPid: norm.anchorPid,
            sessionId: norm.sessionId,
            cwd,
            now: txNow,
          });
          adoptFallbackLeases(state, norm.anchorPid, norm.sessionId, hookEntry);
          return { mutated: true };
        },
        { ppid: norm.anchorPid },
      );
    } catch {
      // Best-effort session bookkeeping; never block the agent's tool call
    }
  }
  return { exitCode: 0, stdout: allowOut, stderr: "" };
}

export function handleStopHook(stateDir, rawStdin, options = {}) {
  const payload = typeof rawStdin === "string" ? parseHookInput(rawStdin) : rawStdin;
  const isAntigravityStop = Boolean(
    options.hookType === "stop" ||
      (payload &&
        typeof payload === "object" &&
        ("conversationId" in payload ||
          "fullyIdle" in payload ||
          "turnStatus" in payload ||
          "workspacePaths" in payload ||
          "agentResponse" in payload ||
          "terminationReason" in payload ||
          "executionNum" in payload)),
  );
  const stopStdout = isAntigravityStop ? JSON.stringify({ decision: "allow" }) + "\n" : "";

  if (payload && payload.fullyIdle === false) {
    return { exitCode: 0, freed: [], stdout: stopStdout, stderr: "" };
  }
  // GitHub Copilot fires sessionEnd with reason "complete" after every agent turn while the
  // session stays open (same sessionId, same host process). Keep the lease; TTL expiry and
  // dead-anchor GC reclaim it if the session never sends a terminal reason.
  if (payload && payload.reason === "complete") {
    return { exitCode: 0, freed: [], stdout: stopStdout, stderr: "" };
  }
  const rawPpid = options.ppid ?? process.ppid;
  getAncestorPids(rawPpid);
  const ppid = resolveStableParentPid(rawPpid, options.processChain);
  const rawSession =
    payload?.session_id ||
    payload?.sessionId ||
    payload?.conversationId ||
    payload?.conversation_id ||
    null;

  const targetSessionId = withStateTransaction(
    stateDir,
    (state) => {
      const existingHook = state.hookSessions[String(ppid)];
      const existingSeen = Array.isArray(existingHook?.seenSessions)
        ? existingHook.seenSessions
        : existingHook?.sessionId
          ? [existingHook.sessionId]
          : [];
      let resolvedId = rawSession ? sanitizeSessionId(rawSession, ppid) : null;
      if (!resolvedId && existingHook && existingSeen.length <= 1) {
        resolvedId = existingHook.sessionId;
      }
      const fallbackPpidSession = `ppid-${ppid}`;
      let mutated = Boolean(existingHook);
      if (existingHook) {
        const remainingSessions = resolvedId
          ? existingSeen.filter((s) => s !== resolvedId)
          : [];
        if (remainingSessions.length > 0) {
          existingHook.seenSessions = remainingSessions;
          existingHook.sessionId = remainingSessions[remainingSessions.length - 1];
          if (Array.isArray(existingHook.pendingMcpCalls)) {
            existingHook.pendingMcpCalls = existingHook.pendingMcpCalls.filter(
              (item) => item && item.sessionId !== resolvedId,
            );
          }
        } else {
          delete state.hookSessions[String(ppid)];
        }
      }

      const candidateFallbackSessions = new Set(
        Object.values(state.leases)
          .filter(
            (l) =>
              l.state === "active" &&
              (l.sessionId === fallbackPpidSession ||
                ((l.anchorPid === ppid || l.parentPid === ppid) &&
                  (String(l.sessionId).startsWith("ppid-") ||
                    String(l.sessionId).startsWith("mcp-")))),
          )
          .map((l) => l.sessionId),
      );
      if (candidateFallbackSessions.size === 1 && existingSeen.length <= 1) {
        for (const l of Object.values(state.leases)) {
          if (l.state === "active" && candidateFallbackSessions.has(l.sessionId)) {
            if (resolvedId) {
              l.sessionId = resolvedId;
              mutated = true;
            } else {
              resolvedId = l.sessionId;
            }
          }
        }
      }
      return { mutated, value: resolvedId };
    },
    { ppid },
  );

  if (!targetSessionId) {
    return { exitCode: 0, freed: [], stdout: stopStdout, stderr: "" };
  }

  const freeRes = cmdFree(
    stateDir,
    null,
    { session: targetSessionId },
    { ...options, deferOnBusyWorker: true },
  );
  return {
    exitCode: freeRes.exitCode,
    freed: freeRes.freed || [],
    error: freeRes.error,
    stdout: stopStdout,
    stderr: "",
  };
}

export function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
