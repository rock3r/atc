import readline from "node:readline";
import { cmdClaim, cmdFree, cmdRenew, cmdSnapshot, cmdStatus } from "./cli.mjs";

export const MCP_TOOLS = [
  {
    name: "atc_claim",
    description:
      "Claim an exclusive Android emulator or physical device lease by hardware/OS profile, snapshot/wipe state, and host RAM/disk budget.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Form factor: phone, tablet, foldable, desktop, wear, xr, tv, automotive, resizable" },
        api: { type: "string", description: "API spec: e.g. 36, >=35, 34..36" },
        services: { type: "string", enum: ["play", "google_apis", "aosp"] },
        play: { type: "boolean", description: "Require Google Play Store" },
        abi: { type: "string" },
        avd: { type: "string" },
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
      },
    },
  },
  {
    name: "atc_free",
    description: "Release an active device lease with optional snapshot-save, snapshot-load, or emulator shutdown.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Lease ID, serial, or AVD name (omit to free all leases owned by this session)" },
        snapshotSave: { type: "string" },
        snapshotLoad: { type: "string" },
        stop: { type: "boolean" },
        force: { type: "boolean" },
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
        ttlSec: { type: "number" },
      },
    },
  },
  {
    name: "atc_snapshot",
    description: "List, save, load, or delete QEMU snapshots on a leased emulator.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "save", "load", "delete"] },
        name: { type: "string" },
        avd: { type: "string" },
        serial: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: "atc_status",
    description: "Inspect 3-tier fleet capacity (running, offline, creatable), host RAM/disk budget, active leases, and wait queue.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        api: { type: "string" },
        services: { type: "string" },
        play: { type: "boolean" },
      },
    },
  },
];

export function handleMcpRequest(stateDir, msg, sessionOptions = {}) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  const mcpSessionId = sessionOptions.sessionId || `mcp-${process.pid}`;
  const mcpEnv = {
    ...process.env,
    ATC_SESSION_ID: mcpSessionId,
    ATC_ANCHOR_PID: String(process.pid),
  };

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "android-traffic-control",
          version: "0.1.0",
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
    const args = params?.arguments || {};
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
        { env: mcpEnv, ppid: process.pid, ...sessionOptions },
      );
    } else if (toolName === "atc_free") {
      res = cmdFree(stateDir, args.target || null, args, {
        env: mcpEnv,
        ppid: process.pid,
        ...sessionOptions,
      });
    } else if (toolName === "atc_renew") {
      res = cmdRenew(
        stateDir,
        args.target || null,
        { ttl: args.ttlSec },
        { env: mcpEnv, ppid: process.pid, ...sessionOptions },
      );
    } else if (toolName === "atc_snapshot") {
      res = cmdSnapshot(stateDir, args.action, args.name || null, args, {
        env: mcpEnv,
        ppid: process.pid,
        ...sessionOptions,
      });
    } else if (toolName === "atc_status") {
      res = cmdStatus(stateDir, args, {
        env: mcpEnv,
        ppid: process.pid,
        ...sessionOptions,
      });
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
  const mcpSessionId = sessionOptions.sessionId || `mcp-${process.pid}`;
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
        const reply = handleMcpRequest(stateDir, msg, {
          ...sessionOptions,
          sessionId: mcpSessionId,
        });
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
        cmdFree(stateDir, null, { session: mcpSessionId }, sessionOptions);
      } catch {
        // Best-effort lease cleanup on MCP transport close
      }
      resolve();
    });
  });
}
