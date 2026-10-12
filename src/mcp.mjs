import readline from "node:readline";
import { cmdClaim, cmdFree, cmdRenew, cmdSnapshot, cmdStatus } from "./cli.mjs";
import { GUIDE_TOPICS, cmdGuide } from "./guide.mjs";
import { consumePendingMcpHookSession } from "./state.mjs";

export const MCP_TOOLS = [
  {
    name: "atc_claim",
    description:
      "Claim an exclusive Android emulator, iOS Simulator, or physical device lease by hardware/OS profile, snapshot/wipe state, and host RAM/disk budget.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["android", "ios"], description: "Target platform: android or ios" },
        ios: { type: "boolean", description: "Shorthand for platform: ios" },
        android: { type: "boolean", description: "Shorthand for platform: android" },
        type: { type: "string", description: "Form factor: phone, tablet, foldable, desktop, watch (alias: wear), xr, tv, automotive, resizable" },
        api: { type: "string", description: "Android API spec: e.g. 36, >=35, 34..36" },
        os: { type: "string", description: "OS version spec: e.g. 18.2, >=18.0, 17.5..18.2 (or Android API level)" },
        services: { type: "string", enum: ["play", "google_apis", "aosp"] },
        play: { type: "boolean", description: "Require Google Play Store (Android)" },
        abi: { type: "string" },
        avd: { type: "string", description: "Android AVD name or iOS Simulator name/UDID" },
        udid: { type: "string", description: "iOS Simulator or physical device UDID" },
        serial: { type: "string" },
        kind: { type: "string", enum: ["emulator", "physical", "any"] },
        createIfMissing: { type: "boolean" },
        snapshotLoad: { type: "string" },
        snapshotSaveOnFree: { type: "string" },
        wipeData: { type: "boolean" },
        cold: { type: "boolean" },
        resetApp: { type: "string" },
        headless: { type: "boolean" },
        force: { type: "boolean" },
        ttlSec: { type: "number" },
        waitSec: { type: "number" },
        reorderWindowSec: { type: "number" },
        reason: { type: "string" },
        session: { type: "string", description: "Optional explicit session ID override" },
      },
    },
  },
  {
    name: "atc_free",
    description: "Release an active device lease with optional snapshot-save, snapshot-load, or emulator/simulator shutdown.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Lease ID, serial/UDID, or AVD/Simulator name (omit to free all leases owned by this session)" },
        platform: { type: "string", enum: ["android", "ios"], description: "Optional platform filter (android or ios) when freeing without target" },
        ios: { type: "boolean", description: "Shorthand for platform: ios" },
        android: { type: "boolean", description: "Shorthand for platform: android" },
        snapshotSave: { type: "string" },
        snapshotLoad: { type: "string" },
        stop: { type: "boolean" },
        force: { type: "boolean" },
        session: { type: "string", description: "Optional explicit session ID override" },
      },
    },
  },
  {
    name: "atc_renew",
    description: "Extend the TTL expiration of an active device lease.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        platform: { type: "string", enum: ["android", "ios"], description: "Optional platform filter (android or ios) when renewing in a dual-lease KMP session" },
        ios: { type: "boolean", description: "Shorthand for platform: ios" },
        android: { type: "boolean", description: "Shorthand for platform: android" },
        ttlSec: { type: "number" },
        session: { type: "string", description: "Optional explicit session ID override" },
      },
    },
  },
  {
    name: "atc_snapshot",
    description: "List, save, load, or delete QEMU or APFS Copy-on-Write snapshots on a leased emulator or iOS Simulator.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "save", "load", "delete"] },
        name: { type: "string" },
        platform: { type: "string", enum: ["android", "ios"] },
        ios: { type: "boolean" },
        android: { type: "boolean" },
        avd: { type: "string" },
        udid: { type: "string" },
        serial: { type: "string" },
        force: { type: "boolean" },
        session: { type: "string", description: "Optional explicit session ID override" },
      },
      required: ["action"],
    },
  },
  {
    name: "atc_status",
    description: "Inspect 3-tier fleet capacity (running, offline, creatable), host RAM/disk budget, active leases, and wait queue across Android and iOS.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["android", "ios"] },
        ios: { type: "boolean" },
        android: { type: "boolean" },
        type: { type: "string" },
        api: { type: "string" },
        os: { type: "string" },
        services: { type: "string" },
        play: { type: "boolean" },
      },
    },
  },
  {
    name: "atc_guide",
    description:
      "Read built-in Agent Traffic Control (atc) guides on workflow, profile matching, snapshots, multi-agent coordination, and troubleshooting traps.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: [...GUIDE_TOPICS],
          description: "Guide topic: workflow (default), profiles, snapshots, multi-agent, or traps",
        },
      },
    },
  },
];

function resolveMcpCallOptions(sessionOptions = {}, toolArgs = {}) {
  const hostAgentPid = sessionOptions.ppid ?? process.ppid;
  const mcpPid = sessionOptions.pid ?? process.pid;
  const baseEnv = sessionOptions.env || process.env;
  const argSession =
    typeof toolArgs?.session === "string" && toolArgs.session.trim()
      ? toolArgs.session.trim()
      : typeof toolArgs?.role === "string" && toolArgs.role.trim()
        ? toolArgs.role.trim()
        : null;
  const explicitSession =
    argSession ||
    sessionOptions.sessionId ||
    sessionOptions.flags?.session ||
    sessionOptions.flags?.role ||
    null;
  const explicitAnchorPid =
    sessionOptions.anchorPid ?? sessionOptions.flags?.anchorPid ?? null;
  const ambientSessionId =
    explicitSession ||
    baseEnv.ATC_SESSION_ID ||
    baseEnv.CODEX_SESSION_ID ||
    baseEnv.PI_SESSION_ID ||
    baseEnv.CURSOR_TRACE_ID ||
    baseEnv.CURSOR_SESSION_ID ||
    baseEnv.ANTIGRAVITY_CONVERSATION_ID ||
    baseEnv.GEMINI_SESSION_ID ||
    baseEnv.CLAUDE_SESSION_ID ||
    baseEnv.COPILOT_SESSION_ID ||
    baseEnv.GITHUB_COPILOT_SESSION_ID ||
    baseEnv.CONVERSATION_ID ||
    null;
  const fallbackSessionId = `mcp-${mcpPid}`;
  const defaultSessionId = ambientSessionId || fallbackSessionId;
  const mcpEnv = {
    ...baseEnv,
    ATC_MCP_DEFAULT_SESSION_ID: fallbackSessionId,
    ATC_ANCHOR_PID:
      explicitAnchorPid !== null && explicitAnchorPid !== undefined
        ? String(explicitAnchorPid)
        : baseEnv.ATC_ANCHOR_PID || String(mcpPid),
  };
  if (ambientSessionId) {
    mcpEnv.ATC_SESSION_ID = ambientSessionId;
  } else {
    delete mcpEnv.ATC_SESSION_ID;
  }
  return {
    ...sessionOptions,
    sessionId: defaultSessionId,
    hasExplicitOrAmbientSession: Boolean(ambientSessionId),
    anchorPid: explicitAnchorPid,
    env: mcpEnv,
    ppid: hostAgentPid,
  };
}

export function handleMcpRequest(stateDir, msg, sessionOptions = {}) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  const rawArgs =
    params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  let args = rawArgs;
  let callOptions = resolveMcpCallOptions(sessionOptions, args);

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "android-traffic-control",
          version: "2.1.0",
        },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    if (
      toolName === "atc_claim" ||
      toolName === "atc_free" ||
      toolName === "atc_renew" ||
      toolName === "atc_snapshot" ||
      toolName === "atc_status" ||
      toolName === "atc_guide"
    ) {
      const pendingHook = consumePendingMcpHookSession(stateDir, {
        ...callOptions,
        toolName,
        args,
        ppid: callOptions.ppid,
        cwd: callOptions.cwd || process.cwd(),
        ancestorPids: callOptions.ancestorPids,
        explicitSession: callOptions.hasExplicitOrAmbientSession ? callOptions.sessionId : null,
      });
      if (
        pendingHook?.error &&
        (toolName === "atc_claim" ||
          toolName === "atc_free" ||
          toolName === "atc_renew" ||
          toolName === "atc_snapshot")
      ) {
        const errRes = {
          exitCode: 1,
          code: "AmbiguousSessionError",
          error: pendingHook.error,
        };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(errRes, null, 2) }],
          },
        };
      }
      if (pendingHook?.sessionId && !args.session && !args.role) {
        args = { ...args, session: pendingHook.sessionId };
        callOptions = resolveMcpCallOptions(sessionOptions, args);
      }
    }

    let res;
    if (toolName === "atc_claim") {
      res = cmdClaim(
        stateDir,
        {
          ...args,
          ttl: args.ttlSec,
          wait: args.waitSec ?? 0,
          reorderWindow: args.reorderWindowSec,
        },
        callOptions,
      );
    } else if (toolName === "atc_free") {
      res = cmdFree(stateDir, args.target || null, args, callOptions);
    } else if (toolName === "atc_renew") {
      res = cmdRenew(
        stateDir,
        args.target || null,
        { ...args, ttl: args.ttlSec },
        callOptions,
      );
    } else if (toolName === "atc_snapshot") {
      res = cmdSnapshot(stateDir, args.action, args.name || null, args, callOptions);
    } else if (toolName === "atc_status") {
      res = cmdStatus(stateDir, args, callOptions);
    } else if (toolName === "atc_guide") {
      res = cmdGuide(args.topic || "workflow");
    } else {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }

    const isError = res.exitCode !== 0;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError,
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      },
    };
  }

  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
  return null;
}

export function startMcpServer(stateDir, sessionOptions = {}) {
  const serverOptions = resolveMcpCallOptions(sessionOptions);
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Ignore malformed JSON-RPC lines
        return;
      }
      try {
        const reply = handleMcpRequest(stateDir, msg, sessionOptions);
        if (reply) {
          process.stdout.write(JSON.stringify(reply) + "\n");
        }
      } catch (err) {
        if (msg && msg.id !== undefined) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: -32603,
                message: err?.message || "Internal MCP error",
              },
            }) + "\n",
          );
        }
      }
    });
    rl.on("close", () => {
      try {
        cmdFree(
          stateDir,
          null,
          serverOptions.sessionId ? { session: serverOptions.sessionId } : {},
          serverOptions,
        );
      } catch {
        // Best-effort lease cleanup on MCP transport close
      }
      resolve();
    });
  });
}
