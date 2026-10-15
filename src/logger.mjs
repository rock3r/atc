import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "./lock.mjs";

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

export function resolveSystemLogDir(env = process.env, platform = process.platform) {
  if (env?.ATC_LOG_DIR && String(env.ATC_LOG_DIR).trim()) {
    return path.resolve(String(env.ATC_LOG_DIR).trim());
  }
  const home = env?.HOME || env?.USERPROFILE || os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Logs", "atc");
  }
  if (platform === "win32") {
    const localAppData = env?.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(localAppData, "atc", "logs");
  }
  const xdgState = env?.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(xdgState, "atc", "logs");
}

export function resolveAuditLogDir(
  stateDir = null,
  env = process.env,
  platform = process.platform,
) {
  if (env?.ATC_LOG_DIR && String(env.ATC_LOG_DIR).trim()) {
    return path.resolve(String(env.ATC_LOG_DIR).trim());
  }
  if (stateDir) {
    const defaultStateDir = resolveStateDir(undefined);
    if (path.resolve(stateDir) !== path.resolve(defaultStateDir)) {
      return path.join(path.resolve(stateDir), "logs");
    }
  }
  return resolveSystemLogDir(env, platform);
}

export function resolveAuditLogPath(
  stateDir = null,
  env = process.env,
  platform = process.platform,
) {
  return path.join(resolveAuditLogDir(stateDir, env, platform), "atc-audit.jsonl");
}

export function deriveAuditCategory(eventName) {
  const name = String(eventName || "");
  if (name.startsWith("guard_") || name.startsWith("guard.")) return "guard";
  if (name.includes("queue")) return "queue";
  if (name.startsWith("build_") || name.startsWith("build.")) return "build";
  if (name.includes("gc_prune") || name.startsWith("gc_") || name.startsWith("gc.")) return "gc";
  return "lease";
}

export function flushAuditEvents(
  events,
  {
    stateDir = null,
    env = process.env,
    platform = process.platform,
    enabled = true,
    maxFileBytes = DEFAULT_MAX_LOG_BYTES,
  } = {},
) {
  if (!enabled || !Array.isArray(events) || events.length === 0) return;
  if (env?.ATC_DISABLE_AUDIT_LOG === "1" || env?.ATC_DISABLE_AUDIT_LOG === "true") return;

  try {
    const logDir = resolveAuditLogDir(stateDir, env, platform);
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(logDir, "atc-audit.jsonl");

    try {
      const st = fs.statSync(logPath);
      if (st.size >= maxFileBytes) {
        const rotatedPath = path.join(logDir, "atc-audit.1.jsonl");
        try {
          fs.renameSync(logPath, rotatedPath);
        } catch {
          // Best-effort rotation
        }
      }
    } catch {
      // File does not exist yet
    }

    const nowMs = Date.now();
    const lines = [];
    for (const ev of events) {
      if (!ev || typeof ev !== "object" || !ev.event) continue;
      const {
        ts: _rawTs,
        tsMs: rawTsMs,
        pid: rawPid,
        event: rawEvent,
        sessionId: rawSessionId,
        details: rawDetails,
        ...extraFields
      } = ev;
      const tsMs = typeof rawTsMs === "number" && Number.isFinite(rawTsMs) ? rawTsMs : nowMs;
      const eventStr = String(rawEvent);
      const category = extraFields.category || deriveAuditCategory(eventStr);
      const record = {
        schemaVersion: 1,
        ts: new Date(tsMs).toISOString(),
        epochMs: tsMs,
        tsMs,
        pid: rawPid ?? process.pid,
        category,
        event: eventStr,
        sessionId: rawSessionId ?? null,
        ...extraFields,
        ...(rawDetails && typeof rawDetails === "object" ? { details: rawDetails } : {}),
      };
      lines.push(JSON.stringify(record));
    }
    if (lines.length > 0) {
      fs.appendFileSync(logPath, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    // Best-effort audit logging: never fail an ATC operation if log I/O fails
  }
}

export function logAuditEvent(event, options = {}) {
  if (!event || typeof event !== "object") return;
  flushAuditEvents([event], options);
}

export function readRecentAuditEvents(
  stateDir = null,
  { limit = 100, env = process.env, platform = process.platform } = {},
) {
  try {
    const logPath = resolveAuditLogPath(stateDir, env, platform);
    if (!fs.existsSync(logPath)) return [];
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = limit > 0 ? lines.slice(-limit) : lines;
    const parsed = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Skip malformed line
      }
    }
    return parsed;
  } catch {
    return [];
  }
}
