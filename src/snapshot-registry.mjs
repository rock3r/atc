import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readDiskVolumeInfo } from "./android.mjs";

export const SNAPSHOT_BUDGET_MB = 16384;
export const SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
export const SNAPSHOT_KEEP_MAX = 8;
export const SNAPSHOT_LOW_DISK_PCT = 10;
export const SNAPSHOT_CONFLICT_EXIT = 4;

const ID_RE = /^atc-[0-9a-f]{12}$/;

export function resolveSnapshotRegistryDir(env = process.env) {
  if (process.env.NODE_TEST_CONTEXT) {
    const base = env.ATC_STATE_DIR && path.isAbsolute(env.ATC_STATE_DIR)
      ? env.ATC_STATE_DIR
      : path.join(os.tmpdir(), "atc-test-snapshot-registry");
    return path.join(base, `snapshot-registry-${process.pid}`);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "atc");
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "atc");
  }
  return path.join(os.homedir(), ".local", "state", "atc");
}

function registryPath(dir) {
  return path.join(dir, "snapshots.json");
}

function lockPath(dir) {
  return path.join(dir, "snapshots.lock");
}

function emptyRegistry() {
  return { version: 1, snapshots: [], spentIds: [], notices: [] };
}

function readRegistryFile(dir) {
  const file = registryPath(dir);
  if (!fs.existsSync(file)) return emptyRegistry();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.snapshots)) {
      return emptyRegistry();
    }
    parsed.spentIds = Array.isArray(parsed.spentIds) ? parsed.spentIds : [];
    parsed.notices = Array.isArray(parsed.notices) ? parsed.notices : [];
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

function writeRegistryFile(dir, registry) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = registryPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function withSnapshotRegistry(dir, fn) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = lockPath(dir);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - start > 5000) {
        throw new Error("Timed out waiting for the snapshot registry lock.");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const registry = readRegistryFile(dir);
    const result = fn(registry);
    if (result?.mutated) writeRegistryFile(dir, registry);
    return result?.value;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function mintSnapshotId(registry) {
  const used = new Set([
    ...registry.snapshots.map((row) => row.id),
    ...registry.spentIds.map((row) => row.id),
  ]);
  for (let i = 0; i < 8; i++) {
    const id = `atc-${randomBytes(6).toString("hex")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("Could not mint a unique snapshot id.");
}

export function liveRowForLabel(registry, storeId, label) {
  return registry.snapshots.find(
    (row) => row.storeId === storeId && row.label === label && row.state === "live",
  );
}

export function rowById(registry, id) {
  return registry.snapshots.find((row) => row.id === id) || null;
}

export function isSnapshotId(name) {
  return ID_RE.test(String(name || ""));
}

export function resolveSnapshotName(registry, storeId, name) {
  if (!name) return null;
  if (isSnapshotId(name)) return rowById(registry, name);
  return liveRowForLabel(registry, storeId, name) || null;
}

export function clearLeaseReferences(registry, leaseId, exceptId = null) {
  if (!leaseId) return;
  for (const row of registry.snapshots) {
    if (exceptId && row.id === exceptId) continue;
    if (Array.isArray(row.references) && row.references.includes(leaseId)) {
      row.references = row.references.filter((id) => id !== leaseId);
    }
  }
}

export function recordLoadedSnapshot(registry, storeId, name, leaseId) {
  if (!leaseId) return { recorded: false };
  const row = name ? resolveSnapshotName(registry, storeId, name) : null;
  const live = row && row.state === "live" && (!storeId || row.storeId === storeId);
  clearLeaseReferences(registry, leaseId, live ? row.id : null);
  if (live) {
    row.references = Array.from(new Set([...(row.references || []), leaseId]));
  }
  return { recorded: Boolean(live), id: live ? row.id : null };
}

export function backendNameFor(registry, storeId, name) {
  const row = resolveSnapshotName(registry, storeId, name);
  if (!row || row.state !== "live" || (storeId && row.storeId !== storeId)) return name;
  return row.backendName || name;
}

export function measuredDirMb(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return null;
  let bytes = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(child);
        else if (entry.isFile()) bytes += fs.statSync(child).size;
      } catch {
        return null;
      }
    }
  }
  return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}

export function usedMb(registry) {
  return registry.snapshots.reduce((sum, row) => {
    if (row.bytesDeleted) return sum;
    return sum + (Number(row.bytes) || 0);
  }, 0);
}

export function volumeFreePct(dirPath) {
  try {
    const info = readDiskVolumeInfo(dirPath);
    const stat = fs.statfsSync(dirPath);
    const sizeMb = Math.round((Number(stat.blocks) * Number(stat.bsize)) / (1024 * 1024));
    if (!Number.isFinite(sizeMb) || sizeMb <= 0) return { unavailable: true };
    return {
      unavailable: false,
      freeMb: info.freeDiskMb,
      sizeMb,
      freePct: Math.floor((info.freeDiskMb / sizeMb) * 100),
    };
  } catch {
    return { unavailable: true };
  }
}

export function snapshotConfig(config = {}) {
  return {
    budgetMb: Number(config.snapshotBudgetMb ?? SNAPSHOT_BUDGET_MB),
    ttlSec: Number(config.snapshotTtlSec ?? SNAPSHOT_TTL_SEC),
    keepMax: Number(config.snapshotKeepMax ?? SNAPSHOT_KEEP_MAX),
    lowDiskPct: Number(config.snapshotLowDiskPct ?? SNAPSHOT_LOW_DISK_PCT),
    minFreeDiskMb: Number(config.minFreeDiskMb ?? 2048),
  };
}

export function overBudgetWarning(registry, config) {
  const used = usedMb(registry);
  const limit = snapshotConfig(config).budgetMb;
  if (used <= limit) return null;
  const protectedIds = registry.snapshots
    .filter((row) => row.state === "live" && (row.keep || (row.references || []).length > 0))
    .map((row) => row.id);
  return {
    code: "over_budget",
    usedMb: used,
    limitMb: limit,
    protectedIds,
    action: "ask the user which pin or loaded snapshot to delete",
    human: `we are over budget; ask the user what to do (${used}/${limit} MB)`,
  };
}

export function lowDiskWarning(dirPath, config) {
  const volume = volumeFreePct(dirPath);
  if (volume.unavailable) {
    return {
      code: "disk_stat_unavailable",
      volume: dirPath,
      human: `disk stat unavailable for ${dirPath}`,
    };
  }
  const threshold = snapshotConfig(config).lowDiskPct;
  if (volume.freePct >= threshold) return null;
  return {
    code: "low_disk",
    volume: dirPath,
    freePct: volume.freePct,
    thresholdPct: threshold,
    freeMb: volume.freeMb,
    sizeMb: volume.sizeMb,
    human: `low disk on ${dirPath}: ${volume.freePct}% free, warn below ${threshold}%`,
  };
}

export function collectSnapshotWarnings(registry, config, volumes = []) {
  const warnings = [];
  const over = overBudgetWarning(registry, config);
  if (over) warnings.push(over);
  const seen = new Set();
  for (const volume of volumes) {
    if (!volume || seen.has(volume)) continue;
    seen.add(volume);
    const low = lowDiskWarning(volume, config);
    if (low) warnings.push(low);
  }
  return warnings;
}

export function warningText(warnings = []) {
  return warnings.map((warning) => warning.human).filter(Boolean).join("\n");
}

export function recordNotice(registry, sessionId, notice) {
  registry.notices.push({
    sessionId,
    createdAtMs: Date.now(),
    ...notice,
  });
}

export function noticesForSession(registry, sessionId, now = Date.now()) {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  registry.notices = registry.notices.filter((notice) => now - notice.createdAtMs < maxAge);
  return registry.notices.filter((notice) => notice.sessionId === sessionId);
}
