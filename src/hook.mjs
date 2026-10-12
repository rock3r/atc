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
import {
  getAncestorPids,
  recordHookSession,
  resolveStableParentPid,
  validateSessionId,
  withStateTransaction,
} from "./state.mjs";

export function parseHookInput(rawStdin) {
  if (!rawStdin || !String(rawStdin).trim()) return null;
  try {
    return JSON.parse(String(rawStdin));
  } catch {
    return null;
  }
}

const ATC_MCP_TOOL_RE = /(?:^|[_:/.-])(atc_(?:claim|free|renew|snapshot|status|guide))$/i;
const ATC_SESSION_MCP_TOOLS = new Set(["atc_claim", "atc_free", "atc_renew", "atc_snapshot"]);

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
    const command = args.CommandLine ?? args.command ?? "";
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
      command: typeof command === "string" ? command : "",
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
      toolInput: mcpToolName ? mcpToolInput : args,
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
      command: typeof payload.command === "string" ? payload.command : "",
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
    };
  }

  // GitHub Copilot CLI native format (camelCase `toolName` + `toolArgs`, object or JSON string)
  if (typeof payload.toolName === "string" && "toolArgs" in payload && !payload.tool_input) {
    let toolArgs = payload.toolArgs;
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
      mcpToolName: matchAtcMcpTool(payload.toolName),
      command: typeof toolArgs.command === "string" ? toolArgs.command : "",
      sessionId: sanitizeSessionId(rawSession, ppid),
      anchorPid: ppid,
      toolInput: toolArgs,
    };
  }

  // Claude Code / Codex format
  const toolName = String(payload.tool_name || payload.toolName || "");
  const rawInput = payload.tool_input || payload.input || {};
  const toolInput = rawInput && typeof rawInput === "object" ? rawInput : {};
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
    mcpToolName: matchAtcMcpTool(toolName),
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
  const rawPpid = options.ppid ?? process.ppid;
  const fastNorm = normalizeHookPayload(payload, rawPpid);
  const cursorAllowOut =
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
    return { exitCode: 0, stdout: cursorAllowOut, stderr: "" };
  }

  if (!fastNorm.isShellTool || !fastNorm.command) {
    return { exitCode: 0, stdout: cursorAllowOut, stderr: "" };
  }

  // Fast Path (<2ms, Zero Lock)
  if (!hasAndroidOrAtcTokens(fastNorm.command)) {
    return { exitCode: 0, stdout: cursorAllowOut, stderr: "" };
  }

  getAncestorPids(rawPpid);
  const norm = normalizeHookPayload(payload, resolveStableParentPid(rawPpid, options.processChain));

  const cwd =
    options.cwd ||
    norm.cwd ||
    (typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd());
  const inventory = options.inventory || null;
  let probedRunningCount = inventory ? (inventory.running || []).length : 0;
  let probedAndroidRunning = 0;
  let probedIosRunning = 0;
  let hasPerPlatformProbe = false;

  if (!inventory && options.runningCount === undefined) {
    const unscopedSegments = splitShellSegments(norm.command)
      .map((seg) => classifySegment(seg))
      .filter((c) => c.kind === "device_action" && !c.targetSerial);
    const runner = options.runner || runCommandSync;
    if (
      unscopedSegments.some((c) => (c.targetPlatform || c.platform || "android") === "android")
    ) {
      const adbRes = runner("adb", ["devices"], { timeoutMs: 3000 });
      if (adbRes.status === 0 && adbRes.stdout !== undefined && adbRes.stdout !== null) {
        probedAndroidRunning = parseAdbDevicesOutput(adbRes.stdout).length;
      } else {
        probedAndroidRunning = 2;
      }
      probedRunningCount = Math.max(probedRunningCount, probedAndroidRunning);
      hasPerPlatformProbe = true;
    }
    if (unscopedSegments.some((c) => (c.targetPlatform || c.platform) === "ios")) {
      const simRes = runner("xcrun", ["simctl", "list", "devices", "booted", "--json"], {
        timeoutMs: 3000,
      });
      if (simRes.status === 0 && simRes.stdout !== undefined && simRes.stdout !== null) {
        try {
          const parsed = JSON.parse(simRes.stdout);
          let count = 0;
          for (const devs of Object.values(parsed?.devices || {})) {
            if (Array.isArray(devs)) {
              count += devs.filter((d) => d && d.state === "Booted").length;
            }
          }
          probedIosRunning = count;
        } catch {
          probedIosRunning = 2;
        }
      } else {
        probedIosRunning = 2;
      }
      probedRunningCount = Math.max(probedRunningCount, probedIosRunning);
      hasPerPlatformProbe = true;
    }
  } else if (options.runningCount !== undefined) {
    probedRunningCount = options.runningCount;
  }

  const evalResult = withStateTransaction(
    stateDir,
    (state, { now }) => {
      const hookEntry = recordHookSession(state, {
        anchorPid: norm.anchorPid,
        sessionId: norm.sessionId,
        cwd,
        now,
      });
      const singleSessionOnAnchor =
        !Array.isArray(hookEntry.seenSessions) || hookEntry.seenSessions.length <= 1;

      const fallbackPpidSession = `ppid-${norm.anchorPid}`;
      const candidateFallbackSessions = new Set(
        Object.values(state.leases)
          .filter(
            (l) =>
              l.state === "active" &&
              (l.sessionId === fallbackPpidSession ||
                ((l.anchorPid === norm.anchorPid || l.parentPid === norm.anchorPid) &&
                  (String(l.sessionId).startsWith("ppid-") ||
                    String(l.sessionId).startsWith("mcp-")))),
          )
          .map((l) => l.sessionId),
      );
      if (candidateFallbackSessions.size === 1 && singleSessionOnAnchor) {
        for (const l of Object.values(state.leases)) {
          if (l.state === "active" && candidateFallbackSessions.has(l.sessionId)) {
            if (String(l.sessionId).startsWith("mcp-")) {
              l.mcpSessionId = l.mcpSessionId || l.sessionId;
            }
            l.sessionId = norm.sessionId;
          }
        }
      }

      const allLeases = Object.values(state.leases);
      const activeLeases = allLeases.filter(
        (l) => l.state === "active" && l.sessionId === norm.sessionId,
      );
      const totalLeasedCount = allLeases.length;
      const runningCount = Math.max(probedRunningCount, totalLeasedCount, activeLeases.length);
      const runningCountByPlatform = hasPerPlatformProbe
        ? {
            android: Math.max(
              probedAndroidRunning,
              allLeases.filter((l) => (l.platform || "android") === "android").length,
              activeLeases.filter((l) => (l.platform || "android") === "android").length,
            ),
            ios: Math.max(
              probedIosRunning,
              allLeases.filter((l) => l.platform === "ios").length,
              activeLeases.filter((l) => l.platform === "ios").length,
            ),
          }
        : options.runningCountByPlatform;

      const guardRes = evaluateCommandGuard(norm.command, {
        sessionId: norm.sessionId,
        anchorPid: norm.anchorPid,
        activeLeases,
        runningCount,
        runningCountByPlatform,
        platform: options.platform,
      });

      if (guardRes.allowed && norm.hostFormat === "cursor" && guardRes.hasDirectDeviceAction) {
        return {
          mutated: true,
          value: {
            allowed: false,
            reason:
              `Blocked by ATC guardrail: Cursor hooks cannot rewrite commands to attach a lease heartbeat.\n` +
              `  Run device commands via: atc exec -- ${norm.command}`,
            rewrittenCommand: null,
          },
        };
      }

      if (guardRes.allowed && guardRes.renewLease) {
        const ttlMs = (state.config?.defaultTtlSec ?? 600) * 1000;
        const targeted =
          Array.isArray(guardRes.targetSerials) && guardRes.targetSerials.length > 0
            ? new Set(guardRes.targetSerials)
            : guardRes.targetSerial
              ? new Set([guardRes.targetSerial])
              : null;
        for (const lease of activeLeases) {
          if (
            !targeted ||
            targeted.has(lease.serial) ||
            (lease.udid && targeted.has(lease.udid)) ||
            (lease.coreDeviceId && targeted.has(lease.coreDeviceId))
          ) {
            lease.loadedSnapshot = null;
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
        ? { decision: "deny", reason: evalResult.reason }
        : norm.hostFormat === "cursor"
          ? {
              permission: "deny",
              user_message: evalResult.reason,
              agent_message: evalResult.reason,
            }
          : norm.hostFormat === "copilot"
            ? { permissionDecision: "deny", permissionDecisionReason: evalResult.reason }
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
      exitCode: norm.hostFormat === "antigravity" ? 0 : 2,
      stdout: JSON.stringify(denyJson) + "\n",
      stderr: evalResult.reason + "\n",
    };
  }

  if (evalResult.rewrittenCommand && norm.hostFormat !== "cursor") {
    const allowJson =
      norm.hostFormat === "antigravity"
        ? {
            decision: "allow",
            overwrite: {
              CommandLine: evalResult.rewrittenCommand,
            },
          }
        : norm.hostFormat === "copilot"
          ? {
              permissionDecision: "allow",
              modifiedArgs: { ...norm.toolInput, command: evalResult.rewrittenCommand },
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
