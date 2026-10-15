import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasValidPinnedDeviceLease } from "./build.mjs";
import { flushAuditEvents } from "./logger.mjs";
import {
  archiveWindowsProcessGroupGeneration,
  canSweepBreakClaimDir,
  clearKnownPosixPgidStartTokens,
  clearKnownWindowsTreeDescendants,
  deriveWindowsTreeGenerationToken,
  getKnownPosixPgidStartToken,
  getKnownWindowsTreeDescendants,
  getKnownWindowsTreePids,
  getPosixProcessStartToken,
  hasAliveProcessInGroup,
  isPidAlive,
  isProcessGroupAlive,
  killProcessGroupTree,
  queryWindowsProcessGroups,
  randomNonce,
  seedPosixPgidStartTokens,
  seedWindowsKnownDescendants,
  sleepSync,
  snapshotProcessGroupsOutsideLock,
  trySweepBreakClaimDir,
  verifyLockOwnership,
  withLock,
  withProcessGroupSnapshot,
  writeFileAtomic,
} from "./lock.mjs";

export {
  archiveWindowsProcessGroupGeneration,
  clearKnownPosixPgidStartTokens,
  clearKnownWindowsTreeDescendants,
  deriveWindowsTreeGenerationToken,
  getKnownPosixPgidStartToken,
  getKnownWindowsTreeDescendants,
  getKnownWindowsTreePids,
  getPosixProcessStartToken,
  hasAliveProcessInGroup,
  isProcessGroupAlive,
  killProcessGroupTree,
  queryWindowsProcessGroups,
  seedPosixPgidStartTokens,
  seedWindowsKnownDescendants,
  snapshotProcessGroupsOutsideLock,
  withProcessGroupSnapshot,
};

const ancestorPidCache = new Map();
const ancestorProcessCache = new Map();

export function isTransientWrapperProcess(proc) {
  if (!proc || typeof proc !== "object") return false;
  const args = String(proc.args || "").trim();
  const firstToken =
    args.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) ||
    String(proc.comm || "").trim();
  const base = firstToken
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/^[-]+/, "")
    .replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");
  const commBase = String(proc.comm || "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/^[-]+/, "")
    .replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");

  const wrapperBins = new Set(["npm", "npx", "pnpm", "pnpx", "yarn", "bunx", "corepack"]);
  if (wrapperBins.has(base) || wrapperBins.has(commBase)) {
    return true;
  }

  if (
    (base === "node" || base === "nodejs" || commBase === "node" || commBase === "nodejs") &&
    /(?:^|[\\/"'\s])(?:npx(?:-cli)?|npm(?:-cli)?|pnpm(?:-cli)?|pnpx|yarn|corepack|bunx)(?:\.[cm]?js|\.exe|\.cmd)?(?:\s|"|'|$)/i.test(
      args,
    )
  ) {
    return true;
  }

  if ((base === "bun" || commBase === "bun") && /\bbun(?:\.exe)?\s+x\b/i.test(args)) {
    return true;
  }

  const shellBins = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
  if (
    (shellBins.has(base) || shellBins.has(commBase)) &&
    /(?:^|\s)-(?:[a-zA-Z]*c[a-zA-Z]*)\b/.test(args)
  ) {
    return true;
  }

  if (
    (base === "cmd" || commBase === "cmd") &&
    /(?:^|\s)\/(?:[dDsS]\s+\/)*[cC]\b/.test(args)
  ) {
    return true;
  }

  return false;
}

export function resolveStableParentPid(startPid = process.ppid, processChain = null) {
  const numericStart = Number(startPid);
  if (!Number.isInteger(numericStart) || numericStart <= 0) {
    return startPid;
  }
  const chain = processChain || ancestorProcessCache.get(numericStart) || [];
  let candidate = numericStart;
  for (const proc of chain) {
    if (proc.pid !== candidate) break;
    if (isTransientWrapperProcess(proc) && Number.isInteger(proc.ppid) && proc.ppid > 1) {
      candidate = proc.ppid;
    } else {
      break;
    }
  }
  return candidate;
}

export function getAncestorPids(startPid = process.ppid) {
  const numericStart = Number(startPid);
  if (!Number.isInteger(numericStart) || numericStart <= 0) {
    return [];
  }
  if (ancestorPidCache.has(numericStart)) {
    return ancestorPidCache.get(numericStart);
  }
  const ancestors = [numericStart];
  const chain = [];
  if (process.platform === "linux" && fs.existsSync(`/proc/${numericStart}/status`)) {
    let cur = numericStart;
    for (let depth = 0; depth < 16; depth++) {
      try {
        const statusText = fs.readFileSync(`/proc/${cur}/status`, "utf8");
        const m = statusText.match(/^PPid:\s*(\d+)/m);
        const nameMatch = statusText.match(/^Name:\s*(.+)$/m);
        let cmdline = "";
        try {
          cmdline = fs
            .readFileSync(`/proc/${cur}/cmdline`, "utf8")
            .replace(/\0+/g, " ")
            .trim();
        } catch {
          // Ignore cmdline read failure
        }
        const parent = m ? Number(m[1]) : 0;
        const comm = nameMatch ? nameMatch[1].trim() : "";
        chain.push({ pid: cur, ppid: parent, comm, args: cmdline || comm });
        if (!parent || parent <= 1 || ancestors.includes(parent)) break;
        ancestors.push(parent);
        cur = parent;
      } catch {
        break;
      }
    }
  } else if (process.platform !== "win32") {
    try {
      const res = spawnSync("ps", ["-Ao", "pid=,ppid=,args="], {
        encoding: "utf8",
        timeout: 1500,
      });
      if (res.status === 0 && res.stdout) {
        const procMap = new Map();
        for (const raw of res.stdout.split(/\r?\n/)) {
          const m = raw.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (m) {
            const pid = Number(m[1]);
            const ppid = Number(m[2]);
            const args = m[3].trim();
            const firstToken =
              args.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) || "";
            procMap.set(pid, { pid, ppid, comm: firstToken, args });
          }
        }
        let cur = numericStart;
        for (let depth = 0; depth < 16; depth++) {
          const info = procMap.get(cur);
          if (!info) break;
          chain.push(info);
          const parent = info.ppid;
          if (!parent || parent <= 1 || ancestors.includes(parent)) break;
          ancestors.push(parent);
          cur = parent;
        }
      }
    } catch {
      // Ignore ps lookup error
    }
  } else if (numericStart === process.ppid) {
    try {
      const psCmd =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
      const res = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psCmd],
        { encoding: "utf8", timeout: 2500, windowsHide: true },
      );
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout.trim());
        const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        const procMap = new Map();
        for (const r of rows) {
          const pid = Number(r.ProcessId);
          const ppid = Number(r.ParentProcessId);
          if (pid > 0) {
            procMap.set(pid, {
              pid,
              ppid,
              comm: String(r.Name || ""),
              args: String(r.CommandLine || r.Name || ""),
            });
          }
        }
        let cur = numericStart;
        for (let depth = 0; depth < 16; depth++) {
          const info = procMap.get(cur);
          if (!info) break;
          chain.push(info);
          const parent = info.ppid;
          if (!parent || parent <= 1 || ancestors.includes(parent)) break;
          ancestors.push(parent);
          cur = parent;
        }
      }
    } catch {
      // Ignore powershell lookup error
    }
  }
  ancestorPidCache.set(numericStart, ancestors);
  ancestorProcessCache.set(numericStart, chain);
  return ancestors;
}

export function getAncestorProcessChain(startPid = process.ppid) {
  const numericStart = Number(startPid);
  if (!Number.isInteger(numericStart) || numericStart <= 0) {
    return [];
  }
  if (!ancestorProcessCache.has(numericStart)) {
    getAncestorPids(numericStart);
  }
  return ancestorProcessCache.get(numericStart) || [];
}

export const DEFAULT_CONFIG = Object.freeze({
  maxRunningEmulators: 2,
  maxRunningSimulators: 4,
  minFreeRamMb: 2048,
  minFreeDiskMb: 2048,
  qemuOverheadRamMb: 1024,
  simOverheadRamMb: 1280,
  defaultTtlSec: 600,
  maxTtlSec: 3600,
  defaultWaitSec: 300,
  reorderWindowSec: 120,
  queueHeartbeatTimeoutSec: 10,
  bootTimeoutSec: 180,
  stopTimeoutSec: 60,
  offlineGraceMs: 45000,
  physicalOfflineGraceMs: 15000,
  autoStopIdleOnContention: true,
  allowPhysicalDevices: "explicit",
  allowedPhysicalSerials: [],
  coordinateBuilds: false,
  maxConcurrentBuilds: "auto",
  maxDeviceHolderBurstBuilds: 1,
  buildRamEstimateMb: 3072,
  buildRamReservationWindowSec: 30,
  buildRamHysteresisMb: 256,
  buildAbortCooldownSec: 5,
  maxBuildDrainingSec: 30,
  defaultBuildWaitSec: 600,
  buildReorderWindowSec: 120,
  auditLogging: true,
});

export function createDefaultState() {
  return {
    version: 1,
    config: structuredClone(DEFAULT_CONFIG),
    leases: {},
    disconnectedPhysicalLeases: {},
    queue: [],
    buildLeases: {},
    buildQueue: [],
    nextBuildQueueSeq: 1,
    hookSessions: {},
    lastOrphanSweepAtMs: 0,
  };
}

export function validateTopLevelState(obj) {
  return (
    Boolean(obj) &&
    typeof obj === "object" &&
    obj.version === 1 &&
    typeof obj.config === "object" &&
    obj.config !== null &&
    typeof obj.leases === "object" &&
    obj.leases !== null &&
    Array.isArray(obj.queue) &&
    typeof obj.hookSessions === "object" &&
    obj.hookSessions !== null
  );
}

function readStateFileRaw(statePath, hasLock = false) {
  const maxAttempts = hasLock ? 1 : 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fs.readFileSync(statePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return null;
      }
      if (
        !hasLock &&
        attempt + 1 < maxAttempts &&
        err &&
        (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES")
      ) {
        sleepSync(5);
        continue;
      }
      throw err;
    }
  }
  return null;
}

function parseStateContent(raw) {
  const parsed = JSON.parse(raw);
  if (!validateTopLevelState(parsed)) {
    throw new Error("Invalid state.json top-level schema");
  }
  parsed.config = { ...DEFAULT_CONFIG, ...parsed.config };
  if (
    !parsed.disconnectedPhysicalLeases ||
    typeof parsed.disconnectedPhysicalLeases !== "object"
  ) {
    parsed.disconnectedPhysicalLeases = {};
  }
  if (
    !parsed.buildLeases ||
    typeof parsed.buildLeases !== "object" ||
    Array.isArray(parsed.buildLeases)
  ) {
    parsed.buildLeases = {};
  }
  if (!Array.isArray(parsed.buildQueue)) {
    parsed.buildQueue = [];
  }
  if (
    typeof parsed.nextBuildQueueSeq !== "number" ||
    !Number.isFinite(parsed.nextBuildQueueSeq) ||
    parsed.nextBuildQueueSeq < 1
  ) {
    parsed.nextBuildQueueSeq = 1;
  }
  return parsed;
}

function quarantineCorruptStateUnderLock(stateDir, statePath, reasonMessage, lockHandle) {
  if (!lockHandle || !verifyLockOwnership(lockHandle)) {
    return createDefaultState();
  }
  const corruptPath = path.join(stateDir, `state.json.corrupt.${Date.now()}`);
  try {
    fs.renameSync(statePath, corruptPath);
    process.stderr.write(
      `[atc] Quarantined corrupt state.json to ${corruptPath} (${reasonMessage})\n`,
    );
  } catch {
    // Ignore rename error if already removed
  }
  return createDefaultState();
}

export function readState(stateDir, options = {}) {
  const statePath = path.join(stateDir, "state.json");
  const holdsLock = Boolean(options.lockHandle && verifyLockOwnership(options.lockHandle));
  const raw = readStateFileRaw(statePath, holdsLock);
  if (raw === null) {
    return createDefaultState();
  }
  try {
    return parseStateContent(raw);
  } catch (parseErr) {
    if (options.quarantine === false) {
      return createDefaultState();
    }
    if (holdsLock) {
      return quarantineCorruptStateUnderLock(
        stateDir,
        statePath,
        parseErr.message,
        options.lockHandle,
      );
    }
    return withLock(stateDir, (lh) => {
      const lockedRaw = readStateFileRaw(statePath, true);
      if (lockedRaw === null) {
        return createDefaultState();
      }
      try {
        return parseStateContent(lockedRaw);
      } catch (lockedParseErr) {
        return quarantineCorruptStateUnderLock(stateDir, statePath, lockedParseErr.message, lh);
      }
    });
  }
}

export function commitState(stateDir, state, lockHandle) {
  const assertOwned = () => {
    if (!verifyLockOwnership(lockHandle)) {
      throw new Error("Lock ownership nonce lost before state.json commit; aborting write");
    }
  };
  assertOwned();
  const statePath = path.join(stateDir, "state.json");
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n", lockHandle.nonce, assertOwned);
}

export function sweepOrphanFiles(stateDir, now = Date.now()) {
  try {
    const entries = fs.readdirSync(stateDir);
    for (const name of entries) {
      const fullPath = path.join(stateDir, name);
      if (/^atc\.(?:create\.)?lock(?:\.break)?\.stale\./.test(name)) {
        trySweepBreakClaimDir(fullPath, now);
        continue;
      }
      if (!name.startsWith("state.json.tmp.")) {
        continue;
      }
      try {
        const st = fs.lstatSync(fullPath);
        if (now - st.mtimeMs > 60_000) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore concurrent deletion
      }
    }
  } catch {
    // Ignore directory read failure
  }
}

function isLeaseProcessGroupKeyAlive(lease, pgKey, livenessCheck = isPidAlive) {
  if (typeof pgKey === "string" && pgKey.includes("@")) {
    return hasAliveProcessInGroup(pgKey.trim(), {
      allowSubprocess: false,
      knownDescendants: lease?.workerDescendants,
      pgidStartTokens: lease?.workerPgidStartTokens,
      lease,
      livenessCheck,
    });
  }
  const pid = Number(pgKey);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const hasWindowsDescendantEntry = Boolean(lease?.workerDescendants?.[String(pid)]);
  const hasPosixStartTokenEntry = Boolean(lease?.workerPgidStartTokens?.[String(pid)]);
  return livenessCheck === isPidAlive || hasWindowsDescendantEntry || hasPosixStartTokenEntry
    ? hasAliveProcessInGroup(pid, {
        allowSubprocess: false,
        knownDescendants: lease?.workerDescendants,
        pgidStartTokens: lease?.workerPgidStartTokens,
        lease,
        livenessCheck,
      })
    : livenessCheck(pid) ||
        hasAliveProcessInGroup(pid, {
          allowSubprocess: false,
          knownDescendants: lease?.workerDescendants,
          pgidStartTokens: lease?.workerPgidStartTokens,
          lease,
          livenessCheck,
        });
}

function reconcileLeaseWindowsGenerations(
  lease,
  freshPid = null,
  { archivedGeneration = false } = {},
) {
  if (
    freshPid &&
    lease?.workerPgidStartTokens &&
    typeof lease.workerPgidStartTokens === "object"
  ) {
    delete lease.workerPgidStartTokens[String(freshPid)];
    if (Object.keys(lease.workerPgidStartTokens).length === 0) {
      delete lease.workerPgidStartTokens;
    }
  }
  if (!lease?.workerDescendants || typeof lease.workerDescendants !== "object") {
    if (freshPid && !archivedGeneration) {
      const curKnown = getKnownWindowsTreeDescendants(freshPid);
      const curRoot = curKnown.find((e) => Number(e?.pid) === Number(freshPid));
      if (
        curRoot &&
        (curRoot.creationDate === "__exited__" ||
          !getKnownWindowsTreePids(freshPid, { liveOnly: true }).includes(Number(freshPid)))
      ) {
        archiveWindowsProcessGroupGeneration(freshPid);
      }
    }
    return;
  }
  for (const [key, prevEntries] of Object.entries({ ...lease.workerDescendants })) {
    if (key.includes("@") || !Array.isArray(prevEntries) || prevEntries.length === 0) {
      continue;
    }
    const numericPid = Number(key);
    if (!Number.isInteger(numericPid) || numericPid <= 1) continue;
    const prevGenToken = deriveWindowsTreeGenerationToken(numericPid, prevEntries);
    if (!prevGenToken) continue;
    const archiveKey = `${numericPid}@${prevGenToken}`;
    const archivedKnown = getKnownWindowsTreeDescendants(archiveKey);
    const curKnown = getKnownWindowsTreeDescendants(numericPid);
    const curGenToken = deriveWindowsTreeGenerationToken(numericPid, curKnown);
    if (freshPid === numericPid && curGenToken === prevGenToken && !archivedGeneration) {
      archiveWindowsProcessGroupGeneration(numericPid);
    }
    const isNewGeneration =
      archivedKnown.length > 0 ||
      (curGenToken && curGenToken !== prevGenToken) ||
      freshPid === numericPid;
    if (isNewGeneration) {
      lease.workerDescendants[archiveKey] = prevEntries;
      delete lease.workerDescendants[key];
      if (
        lease.workerPgidStartTokens &&
        typeof lease.workerPgidStartTokens === "object"
      ) {
        delete lease.workerPgidStartTokens[key];
        if (Object.keys(lease.workerPgidStartTokens).length === 0) {
          delete lease.workerPgidStartTokens;
        }
      }
      seedWindowsKnownDescendants(archiveKey, prevEntries);
      const pgids = Array.isArray(lease.workerPgids)
        ? lease.workerPgids.filter(
            (p) => (typeof p === "string" && p.includes("@")) || Number(p) !== numericPid,
          )
        : [];
      if (!pgids.includes(archiveKey)) {
        pgids.push(archiveKey);
      }
      lease.workerPgids = pgids;
    }
  }
}

export function getLiveLeaseWorkerPids(lease, livenessCheck = isPidAlive) {
  if (!lease || typeof lease !== "object") return [];
  reconcileLeaseWindowsGenerations(lease);
  if (lease.workerDescendants && typeof lease.workerDescendants === "object") {
    seedWindowsKnownDescendants(lease.workerDescendants);
  }
  if (
    lease.workerPgidStartTokens &&
    typeof lease.workerPgidStartTokens === "object"
  ) {
    seedPosixPgidStartTokens(lease.workerPgidStartTokens);
  }
  const raw = [];
  if (Array.isArray(lease.workerPids)) {
    raw.push(...lease.workerPids);
  }
  if (lease.workerPid !== null && lease.workerPid !== undefined) {
    raw.push(lease.workerPid);
  }
  const pgidEntries = Array.isArray(lease.workerPgids) ? lease.workerPgids : [];
  for (const pgKey of pgidEntries) {
    const numPid = Number(String(pgKey).split("@")[0]);
    if (Number.isInteger(numPid) && numPid > 1) {
      raw.push(numPid);
    }
  }
  const seen = new Set();
  const alive = [];
  for (const val of raw) {
    const pid = Number(val);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    const matchingPgids = pgidEntries.filter(
      (p) => Number(String(p).split("@")[0]) === pid,
    );
    const isAlive =
      matchingPgids.length > 0
        ? matchingPgids.some((pgKey) =>
            isLeaseProcessGroupKeyAlive(lease, pgKey, livenessCheck),
          )
        : livenessCheck(pid);
    if (isAlive) {
      alive.push(pid);
    }
  }
  return alive;
}

function syncLeaseWindowsDescendants(lease) {
  if (!lease || typeof lease !== "object") return;
  if (!Array.isArray(lease.workerPgids) || lease.workerPgids.length === 0) {
    delete lease.workerDescendants;
    return;
  }
  const nextDesc = {};
  const prevDesc =
    lease.workerDescendants && typeof lease.workerDescendants === "object"
      ? lease.workerDescendants
      : {};
  for (const rawPgid of lease.workerPgids) {
    const isQualified = typeof rawPgid === "string" && rawPgid.includes("@");
    const keyStr = isQualified ? rawPgid.trim() : String(Number(rawPgid));
    const numPid = Number(keyStr.split("@")[0]);
    if (!Number.isInteger(numPid) || numPid <= 1) continue;
    const known = getKnownWindowsTreeDescendants(isQualified ? keyStr : numPid);
    if (known.length > 0) {
      nextDesc[keyStr] = known;
    } else if (Array.isArray(prevDesc[keyStr]) && prevDesc[keyStr].length > 0) {
      nextDesc[keyStr] = prevDesc[keyStr];
    }
  }
  if (Object.keys(nextDesc).length > 0) {
    lease.workerDescendants = nextDesc;
  } else {
    delete lease.workerDescendants;
  }
}

function syncLeasePosixStartTokens(lease) {
  if (!lease || typeof lease !== "object") return;
  if (!Array.isArray(lease.workerPgids) || lease.workerPgids.length === 0) {
    delete lease.workerPgidStartTokens;
    return;
  }
  const nextTokens = {};
  const prevTokens =
    lease.workerPgidStartTokens &&
    typeof lease.workerPgidStartTokens === "object"
      ? lease.workerPgidStartTokens
      : {};
  for (const rawPgid of lease.workerPgids) {
    const keyStr = String(rawPgid).trim();
    if (keyStr.includes("@")) continue;
    const numPid = Number(keyStr);
    if (!Number.isInteger(numPid) || numPid <= 1) continue;
    const pidKey = String(numPid);
    const prevTok = prevTokens[pidKey] || null;
    const knownTok = getKnownPosixPgidStartToken(numPid);
    const resolvedTok =
      typeof prevTok === "string" && prevTok.trim() && prevTok.trim() !== "__exited__"
        ? prevTok.trim()
        : typeof knownTok === "string" && knownTok.trim() && knownTok.trim() !== "__exited__"
          ? knownTok.trim()
          : null;
    if (resolvedTok) {
      nextTokens[pidKey] = resolvedTok;
      seedPosixPgidStartTokens(numPid, resolvedTok);
    }
  }
  if (Object.keys(nextTokens).length > 0) {
    lease.workerPgidStartTokens = nextTokens;
  } else {
    delete lease.workerPgidStartTokens;
  }
}

export function syncLeaseWorkers(lease, livenessCheck = isPidAlive) {
  const alive = getLiveLeaseWorkerPids(lease, livenessCheck);
  lease.workerPids = alive;
  if (Array.isArray(lease.workerPgids)) {
    lease.workerPgids = lease.workerPgids
      .map((p) => (typeof p === "string" && p.includes("@") ? p.trim() : Number(p)))
      .filter((pgKey) => isLeaseProcessGroupKeyAlive(lease, pgKey, livenessCheck));
    if (lease.workerPgids.length === 0) {
      delete lease.workerPgids;
    }
  }
  syncLeaseWindowsDescendants(lease);
  syncLeasePosixStartTokens(lease);
  lease.workerPid = alive[0] ?? null;
  return alive;
}

export function addLeaseWorker(lease, pid, livenessCheck = isPidAlive, options = {}) {
  const numericPid = Number(pid);
  if (options.isProcessGroup && Number.isInteger(numericPid) && numericPid > 1) {
    reconcileLeaseWindowsGenerations(
      lease,
      options.freshGeneration ? numericPid : null,
      { archivedGeneration: Boolean(options.archivedGeneration) },
    );
  }
  const alive = getLiveLeaseWorkerPids(lease, livenessCheck);
  if (Number.isInteger(numericPid) && numericPid > 0 && !alive.includes(numericPid)) {
    alive.push(numericPid);
  }
  if (options.isProcessGroup && Number.isInteger(numericPid) && numericPid > 1) {
    const pgids = Array.isArray(lease.workerPgids)
      ? lease.workerPgids
          .map((p) => (typeof p === "string" && p.includes("@") ? p.trim() : Number(p)))
          .filter(
            (pgKey) =>
              pgKey === numericPid ||
              isLeaseProcessGroupKeyAlive(lease, pgKey, livenessCheck),
          )
      : [];
    if (!pgids.includes(numericPid)) {
      pgids.push(numericPid);
    }
    lease.workerPgids = pgids;
    if (options.descendants) {
      seedWindowsKnownDescendants(numericPid, options.descendants);
    }
    const effectivePlatform = options.platform || process.platform;
    const explicitToken =
      typeof options.startToken === "string" && options.startToken.trim()
        ? options.startToken.trim()
        : null;
    const startToken =
      explicitToken ||
      getKnownPosixPgidStartToken(numericPid) ||
      (livenessCheck === isPidAlive
        ? getPosixProcessStartToken(numericPid, {
            platform: effectivePlatform,
            spawnSyncFn: options.spawnSyncFn || options.runner,
            allowSubprocess: Boolean(options.allowSubprocess),
          })
        : null);
    if (startToken && startToken !== "__exited__") {
      seedPosixPgidStartTokens(numericPid, startToken);
      if (
        !lease.workerPgidStartTokens ||
        typeof lease.workerPgidStartTokens !== "object"
      ) {
        lease.workerPgidStartTokens = {};
      }
      lease.workerPgidStartTokens[String(numericPid)] = startToken;
    }
  }
  lease.workerPids = alive;
  syncLeaseWindowsDescendants(lease);
  syncLeasePosixStartTokens(lease);
  lease.workerPid = alive[0] ?? null;
  return alive;
}

export function removeLeaseWorker(lease, pid, livenessCheck = isPidAlive) {
  const isQualified = typeof pid === "string" && pid.includes("@");
  const keyStr = isQualified ? pid.trim() : null;
  const numericPid = Number(isQualified ? keyStr.split("@")[0] : pid);
  if (Array.isArray(lease.workerPgids)) {
    lease.workerPgids = lease.workerPgids.filter((p) => {
      if (isQualified) {
        return String(p).trim() !== keyStr;
      }
      if (typeof p === "string" && p.includes("@")) {
        return true;
      }
      return Number(p) !== numericPid;
    });
    if (lease.workerPgids.length === 0) {
      delete lease.workerPgids;
    }
  }
  clearKnownWindowsTreeDescendants(isQualified ? keyStr : numericPid);
  clearKnownPosixPgidStartTokens(isQualified ? keyStr : numericPid);
  if (lease?.workerDescendants && typeof lease.workerDescendants === "object") {
    delete lease.workerDescendants[isQualified ? keyStr : String(numericPid)];
    if (Object.keys(lease.workerDescendants).length === 0) {
      delete lease.workerDescendants;
    }
  }
  if (
    lease?.workerPgidStartTokens &&
    typeof lease.workerPgidStartTokens === "object"
  ) {
    delete lease.workerPgidStartTokens[String(numericPid)];
    if (keyStr) {
      delete lease.workerPgidStartTokens[keyStr];
    }
    if (Object.keys(lease.workerPgidStartTokens).length === 0) {
      delete lease.workerPgidStartTokens;
    }
  }
  if (Array.isArray(lease?.workerPids)) {
    lease.workerPids = lease.workerPids.filter((p) => Number(p) !== numericPid);
  }
  if (Number(lease?.workerPid) === numericPid) {
    lease.workerPid = null;
  }
  const alive = getLiveLeaseWorkerPids(lease, livenessCheck);
  lease.workerPids = alive;
  syncLeaseWindowsDescendants(lease);
  syncLeasePosixStartTokens(lease);
  lease.workerPid = alive[0] ?? null;
  return alive;
}

export function runGarbageCollection(state, stateDir, now = Date.now(), livenessCheck = isPidAlive) {
  const pruned = {
    leases: [],
    queue: [],
    buildLeases: [],
    buildQueue: [],
    hookSessions: [],
    workersMutated: false,
  };
  const cfg = state.config || DEFAULT_CONFIG;
  const maxTtlMs = (cfg.maxTtlSec || 3600) * 1000;
  const hbTimeoutMs = (cfg.queueHeartbeatTimeoutSec || 10) * 1000;
  const abortCooldownMs = (cfg.buildAbortCooldownSec ?? 5) * 1000;
  const maxDrainingMs = (cfg.maxBuildDrainingSec ?? 30) * 1000;

  if (!state.buildLeases || typeof state.buildLeases !== "object" || Array.isArray(state.buildLeases)) {
    state.buildLeases = {};
  }
  if (!Array.isArray(state.buildQueue)) {
    state.buildQueue = [];
  }

  for (const [deviceKey, lease] of Object.entries(state.leases)) {
    if (!lease || typeof lease !== "object") {
      delete state.leases[deviceKey];
      continue;
    }
    if (lease.state === "active") {
      const beforeWorkerPids = JSON.stringify(lease.workerPids || null);
      const beforeWorkerPgids = JSON.stringify(lease.workerPgids || null);
      const beforeDescendants = JSON.stringify(lease.workerDescendants || null);
      const beforeStartTokens = JSON.stringify(
        lease.workerPgidStartTokens || null,
      );
      const aliveWorkers = syncLeaseWorkers(lease, livenessCheck);
      if (
        beforeWorkerPids !== JSON.stringify(lease.workerPids || null) ||
        beforeWorkerPgids !== JSON.stringify(lease.workerPgids || null) ||
        beforeDescendants !== JSON.stringify(lease.workerDescendants || null) ||
        beforeStartTokens !==
          JSON.stringify(lease.workerPgidStartTokens || null)
      ) {
        pruned.workersMutated = true;
      }
      const workerAlive = aliveWorkers.length > 0;
      const gcReapingAgeMs =
        typeof lease.gcReapingAtMs === "number" &&
        Number.isFinite(lease.gcReapingAtMs)
          ? now - lease.gcReapingAtMs
          : -1;
      const isGcReaping = gcReapingAgeMs >= 0 && gcReapingAgeMs < 30_000;
      if (workerAlive && !isGcReaping) {
        const defaultTtlMs = (cfg.defaultTtlSec || 600) * 1000;
        lease.renewedAtMs = Math.max(lease.renewedAtMs || 0, now);
        lease.expiresAtMs = Math.max(
          lease.expiresAtMs || 0,
          now + Math.min(defaultTtlMs, maxTtlMs),
        );
      }
      const lastRenewedMs =
        typeof lease.renewedAtMs === "number" ? lease.renewedAtMs : lease.claimedAtMs;
      const expired =
        !workerAlive &&
        (now >= lease.expiresAtMs ||
          now < lease.claimedAtMs ||
          (typeof lastRenewedMs === "number" && now > lastRenewedMs + maxTtlMs));
      const deadAnchor =
        lease.anchorPid !== null &&
        lease.anchorPid !== undefined &&
        !livenessCheck(lease.anchorPid) &&
        !workerAlive;
      const deferredFreeDone = Boolean(lease.releaseOnWorkerExit) && !workerAlive;
      if (expired || deadAnchor || deferredFreeDone) {
        pruned.leases.push({
          deviceKey,
          leaseId: lease.leaseId,
          reason: expired ? "expired" : deferredFreeDone ? "deferred_free" : "dead_anchor",
        });
        delete state.leases[deviceKey];
      }
    } else if (lease.state === "starting" || lease.state === "stopping") {
      const deadWorker = !lease.workerPid || !livenessCheck(lease.workerPid);
      if (lease.state === "stopping" && lease.awaitOfflineReconcile && deadWorker) {
        continue;
      }
      const hasDeadline = typeof lease.deadlineMs === "number" && Number.isFinite(lease.deadlineMs);
      const pastDeadline =
        (hasDeadline && now >= lease.deadlineMs) ||
        (typeof lease.claimedAtMs === "number" && now < lease.claimedAtMs);
      if (pastDeadline || (deadWorker && !hasDeadline)) {
        pruned.leases.push({
          deviceKey,
          leaseId: lease.leaseId,
          reason: pastDeadline ? "deadline_exceeded" : "dead_worker",
        });
        delete state.leases[deviceKey];
      }
    }
  }

  state.queue = state.queue.filter((ticket) => {
    if (!ticket || typeof ticket !== "object") return false;
    const expired =
      now >= ticket.waitExpiresAtMs ||
      now >= ticket.lastHeartbeatAtMs + hbTimeoutMs ||
      now < ticket.enqueuedAtMs;
    const deadWaiter = !ticket.waiterPid || !livenessCheck(ticket.waiterPid);
    if (expired || deadWaiter) {
      pruned.queue.push({
        ticketId: ticket.ticketId,
        sessionId: ticket.sessionId,
        reason: expired ? "expired" : "dead_waiter",
      });
      return false;
    }
    return true;
  });

  for (const [buildId, bLease] of Object.entries(state.buildLeases)) {
    if (!bLease || typeof bLease !== "object") {
      delete state.buildLeases[buildId];
      continue;
    }
    const beforeWorkerPids = JSON.stringify(bLease.workerPids || null);
    const beforeWorkerPgids = JSON.stringify(bLease.workerPgids || null);
    const beforeDescendants = JSON.stringify(bLease.workerDescendants || null);
    const beforeStartTokens = JSON.stringify(bLease.workerPgidStartTokens || null);
    const aliveWorkers = syncLeaseWorkers(bLease, livenessCheck);
    if (
      beforeWorkerPids !== JSON.stringify(bLease.workerPids || null) ||
      beforeWorkerPgids !== JSON.stringify(bLease.workerPgids || null) ||
      beforeDescendants !== JSON.stringify(bLease.workerDescendants || null) ||
      beforeStartTokens !== JSON.stringify(bLease.workerPgidStartTokens || null)
    ) {
      pruned.workersMutated = true;
    }
    const groupAlive = aliveWorkers.length > 0;
    const clientPidAlive = Boolean(bLease.workerPid && livenessCheck(bLease.workerPid));
    const wrapperAlive = Boolean(bLease.execWrapperPid && livenessCheck(bLease.execWrapperPid));

    if (bLease.state === "active") {
      const lastRenewedMs =
        typeof bLease.renewedAtMs === "number" ? bLease.renewedAtMs : bLease.createdAtMs;
      const pastTtl =
        (typeof bLease.expiresAtMs === "number" && now >= bLease.expiresAtMs) ||
        (typeof lastRenewedMs === "number" && now > lastRenewedMs + maxTtlMs);
      const prepHorizonMs =
        ((cfg.bootTimeoutSec || 180) +
          (cfg.stopTimeoutSec || 60) +
          (cfg.defaultWaitSec || 300)) *
        1000;
      const activePrepReservation = Boolean(
        bLease.preparingDevice &&
          wrapperAlive &&
          typeof bLease.createdAtMs === "number" &&
          now - bLease.createdAtMs < Math.max(maxTtlMs, prepHorizonMs),
      );
      if (
        (clientPidAlive || wrapperAlive) &&
        (!pastTtl || activePrepReservation) &&
        !bLease.abortedOrTimedOut
      ) {
        const defaultTtlMs = (cfg.defaultTtlSec || 600) * 1000;
        bLease.renewedAtMs = Math.max(bLease.renewedAtMs || 0, now);
        bLease.expiresAtMs = Math.max(
          bLease.expiresAtMs || 0,
          now + Math.min(defaultTtlMs, maxTtlMs),
        );
      } else {
        bLease.state = "draining";
        bLease.drainingStartedAtMs = now;
        bLease.drainingCooldownUntilMs = now + abortCooldownMs;
        bLease.drainingDeadlineMs = now + maxDrainingMs;
        pruned.workersMutated = true;
      }
    } else if (bLease.state === "draining") {
      const cooldownDone = now >= (bLease.drainingCooldownUntilMs || 0);
      const pastMaxHorizon =
        now >= (bLease.drainingDeadlineMs || (bLease.drainingStartedAtMs || now) + maxDrainingMs);
      if ((!groupAlive && cooldownDone) || pastMaxHorizon) {
        pruned.buildLeases.push({
          buildId,
          sessionId: bLease.sessionId,
          reason: pastMaxHorizon && groupAlive ? "draining_horizon_exceeded" : "draining_complete",
        });
        delete state.buildLeases[buildId];
      }
    } else {
      delete state.buildLeases[buildId];
    }
  }

  state.buildQueue = state.buildQueue.filter((ticket) => {
    if (!ticket || typeof ticket !== "object") return false;
    const expired =
      (typeof ticket.waitExpiresAtMs === "number" && now >= ticket.waitExpiresAtMs) ||
      (typeof ticket.lastHeartbeatAtMs === "number" && now >= ticket.lastHeartbeatAtMs + hbTimeoutMs) ||
      (typeof ticket.enqueuedAtMs === "number" && now < ticket.enqueuedAtMs);
    const deadWaiter = !ticket.waiterPid || !livenessCheck(ticket.waiterPid);
    const lostDevice =
      Boolean(ticket.pinnedDeviceLeaseId || ticket.pinnedDeviceKey) &&
      !hasValidPinnedDeviceLease(ticket, state.leases);
    if (expired || deadWaiter || lostDevice) {
      pruned.buildQueue.push({
        ticketId: ticket.ticketId,
        sessionId: ticket.sessionId,
        reason: lostDevice ? "lost_device_lease" : expired ? "expired" : "dead_waiter",
      });
      return false;
    }
    return true;
  });

  for (const [pidKey, entry] of Object.entries(state.hookSessions)) {
    if (
      !entry ||
      now - entry.updatedAtMs > 60_000 ||
      !livenessCheck(Number(entry.agentPid || pidKey))
    ) {
      pruned.hookSessions.push(pidKey);
      delete state.hookSessions[pidKey];
    }
  }

  const markerRetentionMs = Math.max(maxTtlMs, 3_600_000);
  if (state.stoppedDevices && typeof state.stoppedDevices === "object") {
    for (const [k, entry] of Object.entries(state.stoppedDevices)) {
      if (
        !entry ||
        typeof entry.stoppedAtMs !== "number" ||
        now - entry.stoppedAtMs > markerRetentionMs
      ) {
        delete state.stoppedDevices[k];
      }
    }
  }
  if (state.bootedDevices && typeof state.bootedDevices === "object") {
    for (const [k, entry] of Object.entries(state.bootedDevices)) {
      if (
        !entry ||
        typeof entry.bootedAtMs !== "number" ||
        now - entry.bootedAtMs > markerRetentionMs
      ) {
        delete state.bootedDevices[k];
      }
    }
  }
  if (
    state.disconnectedPhysicalLeases &&
    typeof state.disconnectedPhysicalLeases === "object"
  ) {
    for (const [k, tomb] of Object.entries(state.disconnectedPhysicalLeases)) {
      if (
        !tomb ||
        typeof tomb.expiresAtMs !== "number" ||
        now >= tomb.expiresAtMs ||
        (typeof tomb.disconnectedAtMs === "number" && now < tomb.disconnectedAtMs)
      ) {
        delete state.disconnectedPhysicalLeases[k];
      }
    }
  }

  if (stateDir && (!state.lastOrphanSweepAtMs || now - state.lastOrphanSweepAtMs > 60_000)) {
    state.lastOrphanSweepAtMs = now;
    sweepOrphanFiles(stateDir, now);
  }

  return pruned;
}

const AVD_RUNTIME_LOCK_NAMES = new Set([
  "hardware-qemu.ini.lock",
  "snapshot.lock",
  "modem-nv-ram-5554.lock",
]);

function readBareAvdLockPid(targetPath) {
  const stat = fs.statSync(targetPath);
  let rawContent = null;
  let contentStat = stat;
  if (stat.isDirectory()) {
    const pidFile = path.join(targetPath, "pid");
    if (!fs.existsSync(pidFile)) {
      return { stat, contentStat: null, pid: null };
    }
    contentStat = fs.statSync(pidFile);
    rawContent = fs.readFileSync(pidFile, "utf8");
  } else if (stat.isFile()) {
    rawContent = fs.readFileSync(targetPath, "utf8");
  } else {
    return { stat, contentStat: null, pid: null };
  }
  const cleaned = String(rawContent).replace(/\0/g, "");
  const barePidMatch = cleaned.match(/^\s*(\d+)\s*$/);
  if (!barePidMatch) {
    return { stat, contentStat, pid: null };
  }
  const pid = Number(barePidMatch[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { stat, contentStat, pid: null };
  }
  return { stat, contentStat, pid };
}

function isAvdLockEntryLive(lockPath, livenessCheck = isPidAlive) {
  try {
    const initial = readBareAvdLockPid(lockPath);
    if (initial.pid === null) {
      return true;
    }
    if (livenessCheck(initial.pid)) {
      return true;
    }
    const stagedPath = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let renamed = false;
    try {
      fs.renameSync(lockPath, stagedPath);
      renamed = true;
    } catch {
      // Another caller removed or replaced the lock entry
      return fs.existsSync(lockPath);
    }
    if (renamed) {
      try {
        const staged = readBareAvdLockPid(stagedPath);
        const sameEntry =
          staged.pid === initial.pid &&
          staged.stat.isDirectory() === initial.stat.isDirectory() &&
          (!initial.stat.ino || !staged.stat.ino || staged.stat.ino === initial.stat.ino) &&
          (!initial.contentStat?.ino ||
            !staged.contentStat?.ino ||
            staged.contentStat.ino === initial.contentStat.ino);
        if (!sameEntry) {
          const replacementLive = staged.pid === null || livenessCheck(staged.pid);
          if (replacementLive) {
            try {
              if (!fs.existsSync(lockPath)) {
                fs.renameSync(stagedPath, lockPath);
              }
            } catch {
              // Ignore restore errors
            }
            return true;
          }
        }
      } catch {
        // Proceed to remove stagedPath below
      }
      try {
        fs.rmSync(stagedPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on staged path
      }
    }
    return fs.existsSync(lockPath);
  } catch {
    return true;
  }
}

export function avdHasRuntimeLockFiles(avdId, avdHome, livenessCheck = isPidAlive) {
  if (!avdId || !avdHome) return false;
  try {
    let avdDir = path.join(avdHome, `${avdId}.avd`);
    const iniPath = path.join(avdHome, `${avdId}.ini`);
    if (fs.existsSync(iniPath)) {
      const content = fs.readFileSync(iniPath, "utf8");
      for (const rawLine of String(content).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (key === "path" && val && fs.existsSync(val)) {
          avdDir = val;
          break;
        }
      }
    }
    if (!fs.existsSync(avdDir)) return false;
    let hasLiveLock = false;
    for (const entry of fs.readdirSync(avdDir)) {
      if (!AVD_RUNTIME_LOCK_NAMES.has(entry)) continue;
      if (isAvdLockEntryLive(path.join(avdDir, entry), livenessCheck)) {
        hasLiveLock = true;
      }
    }
    return hasLiveLock;
  } catch {
    return true;
  }
}

export function offlineAvdHasRuntimeLockFiles(
  avdHomeOrDevice,
  excludedAvdsOrAvdHome = new Set(),
  livenessCheck = isPidAlive,
) {
  if (avdHomeOrDevice && typeof avdHomeOrDevice === "object") {
    const dev = avdHomeOrDevice;
    if (typeof excludedAvdsOrAvdHome === "string" && excludedAvdsOrAvdHome && dev.avd) {
      return avdHasRuntimeLockFiles(dev.avd, excludedAvdsOrAvdHome, livenessCheck);
    }
    return Boolean(dev.hasLockFiles);
  }
  const avdHome = avdHomeOrDevice;
  const excludedAvds = excludedAvdsOrAvdHome;
  if (!avdHome || !fs.existsSync(avdHome)) return false;
  try {
    for (const entry of fs.readdirSync(avdHome)) {
      if (entry.endsWith(".ini") || entry.endsWith(".avd")) {
        const avdId = entry.slice(0, -4);
        if (excludedAvds && excludedAvds.has(avdId)) continue;
        if (avdHasRuntimeLockFiles(avdId, avdHome, livenessCheck)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function recordDeviceStoppedInState(state, deviceInfo, now = Date.now()) {
  if (!state || !deviceInfo) return;
  state.fleetEpoch = (state.fleetEpoch || 0) + 1;
  if (!state.stoppedDevices || typeof state.stoppedDevices !== "object") {
    state.stoppedDevices = {};
  }
  const entry = {
    epoch: state.fleetEpoch,
    stoppedAtMs: now,
    avd: deviceInfo.avd || null,
    serial: deviceInfo.serial || null,
  };
  if (deviceInfo.deviceKey) {
    state.stoppedDevices[deviceInfo.deviceKey] = entry;
  }
  if (deviceInfo.avd) {
    state.stoppedDevices[`avd:${deviceInfo.avd}`] = entry;
  }
  if (deviceInfo.serial) {
    state.stoppedDevices[`serial:${deviceInfo.serial}`] = entry;
  }
  if (state.bootedDevices && typeof state.bootedDevices === "object") {
    if (deviceInfo.deviceKey) delete state.bootedDevices[deviceInfo.deviceKey];
    if (deviceInfo.avd) delete state.bootedDevices[`avd:${deviceInfo.avd}`];
    if (deviceInfo.serial) delete state.bootedDevices[`serial:${deviceInfo.serial}`];
  }
}

export function recordDeviceBootedInState(state, deviceInfo, now = Date.now()) {
  if (!state || !deviceInfo || deviceInfo.kind === "physical") return;
  state.fleetEpoch = (state.fleetEpoch || 0) + 1;
  if (!state.bootedDevices || typeof state.bootedDevices !== "object") {
    state.bootedDevices = {};
  }
  const entry = {
    epoch: state.fleetEpoch,
    bootedAtMs: now,
    deviceKey:
      deviceInfo.deviceKey ||
      (deviceInfo.avd ? `avd:${deviceInfo.avd}` : deviceInfo.serial ? `serial:${deviceInfo.serial}` : null),
    avd: deviceInfo.avd || null,
    serial: deviceInfo.serial || null,
    profile: deviceInfo.profile || null,
    ramSizeMb: deviceInfo.ramSizeMb || 2048,
    requiredRamMb: deviceInfo.requiredRamMb || 0,
  };
  if (entry.deviceKey) {
    state.bootedDevices[entry.deviceKey] = entry;
  }
  if (deviceInfo.avd) {
    state.bootedDevices[`avd:${deviceInfo.avd}`] = entry;
  }
  if (deviceInfo.serial) {
    state.bootedDevices[`serial:${deviceInfo.serial}`] = entry;
  }
  if (state.stoppedDevices && typeof state.stoppedDevices === "object") {
    if (deviceInfo.deviceKey) delete state.stoppedDevices[deviceInfo.deviceKey];
    if (deviceInfo.avd) delete state.stoppedDevices[`avd:${deviceInfo.avd}`];
    if (deviceInfo.serial) delete state.stoppedDevices[`serial:${deviceInfo.serial}`];
  }
}

export function isLeaseExecutable(lease) {
  return Boolean(
    lease &&
      lease.state === "active" &&
      (lease.firstSeenOfflineAtMs === null || lease.firstSeenOfflineAtMs === undefined) &&
      lease.serial,
  );
}

export function reconcileOfflineLeases(
  state,
  inventory,
  callerSessionId,
  now = Date.now(),
  livenessCheck = isPidAlive,
  avdHome = inventory?.avdHome || null,
) {
  if (!inventory) return false;
  let mutated = false;
  const queriedPlatforms = Array.isArray(inventory.queriedPlatforms)
    ? new Set(inventory.queriedPlatforms.map((p) => String(p).toLowerCase()))
    : null;
  const probes = inventory.probes || {
    emulatorListOk: true,
    adbDevicesOk: true,
    simctlListOk: true,
    devicectlListOk: true,
  };
  const emulatorListOk = probes.emulatorListOk !== false;
  const adbDevicesOk = probes.adbDevicesOk !== false;
  const simctlListOk = probes.simctlListOk !== false;
  const devicectlListOk = probes.devicectlListOk !== false;
  const onlineAvds = new Set(
    (inventory.running || [])
      .filter((d) => d.kind === "emulator" && (d.platform || "android") === "android")
      .map((d) => d.avd),
  );
  const onlineSimSerials = new Set(
    (inventory.running || [])
      .filter(
        (d) =>
          d.kind === "emulator" && (d.platform === "ios" || d.deviceKey?.startsWith("sim:")),
      )
      .map((d) => d.serial)
      .filter(Boolean),
  );
  const onlineSerials = new Set([
    ...(inventory.running || []).map((d) => d.serial).filter(Boolean),
    ...Array.from(inventory.onlineSerials || []).filter(Boolean),
  ]);

  for (const [deviceKey, lease] of Object.entries(state.leases)) {
    const leasePlatform = (
      lease.platform ||
      lease.profile?.platform ||
      (deviceKey.startsWith("sim:") ? "ios" : "android")
    ).toLowerCase();
    if (queriedPlatforms && !queriedPlatforms.has(leasePlatform)) {
      continue;
    }
    if (
      leasePlatform === "android" &&
      (!lease.avd || deviceKey.startsWith("serial:")) &&
      lease.kind === "emulator" &&
      lease.serial
    ) {
      const mappedDev = (inventory.running || []).find(
        (d) =>
          d.kind === "emulator" &&
          (d.platform || "android") === "android" &&
          d.serial === lease.serial &&
          d.avd,
      );
      if (mappedDev && mappedDev.deviceKey && mappedDev.deviceKey !== deviceKey) {
        const destLease = state.leases[mappedDev.deviceKey];
        if (!destLease) {
          delete state.leases[deviceKey];
          lease.avd = mappedDev.avd;
          lease.deviceKey = mappedDev.deviceKey;
          lease.profile = mappedDev.profile || lease.profile;
          state.leases[mappedDev.deviceKey] = lease;
          mutated = true;
        } else {
          const destInTransition =
            (destLease.state === "starting" || destLease.state === "stopping") &&
            Boolean(destLease.workerPid && livenessCheck(destLease.workerPid));
          const destHasLiveWorker = destInTransition
            ? true
            : destLease.state === "starting" || destLease.state === "stopping"
              ? false
              : syncLeaseWorkers(destLease, livenessCheck).length > 0;
          const srcHasLiveWorker =
            lease.state === "starting" || lease.state === "stopping"
              ? Boolean(lease.workerPid && livenessCheck(lease.workerPid))
              : syncLeaseWorkers(lease, livenessCheck).length > 0;
          if (destInTransition && srcHasLiveWorker) {
            if (lease.avd !== mappedDev.avd) {
              lease.avd = mappedDev.avd;
              lease.profile = mappedDev.profile || lease.profile;
              mutated = true;
            }
            continue;
          }
          const destWins =
            destInTransition ||
            (!srcHasLiveWorker &&
              (destLease.state === "starting" ||
                destLease.state === "stopping" ||
                destHasLiveWorker ||
                (destLease.claimedAtMs || 0) <= (lease.claimedAtMs || Infinity)));
          delete state.leases[deviceKey];
          if (!destWins) {
            lease.avd = mappedDev.avd;
            lease.deviceKey = mappedDev.deviceKey;
            lease.profile = mappedDev.profile || lease.profile;
            state.leases[mappedDev.deviceKey] = lease;
          }
          mutated = true;
          if (destWins) continue;
        }
      }
    }
    if (lease.state === "stopping") {
      if (!lease.awaitOfflineReconcile) continue;
      if (lease.workerPid && livenessCheck(lease.workerPid)) continue;
      const requiredFreshAfterMs = Math.max(
        typeof lease.stoppingAtMs === "number" && Number.isFinite(lease.stoppingAtMs)
          ? lease.stoppingAtMs
          : 0,
        typeof lease.reconcileAfterMs === "number" && Number.isFinite(lease.reconcileAfterMs)
          ? lease.reconcileAfterMs
          : 0,
      );
      if (
        typeof lease.stoppingEpoch === "number" &&
        typeof inventory.fleetEpoch === "number" &&
        inventory.fleetEpoch < lease.stoppingEpoch
      ) {
        continue;
      }
      const hasFreshEpoch =
        typeof lease.stoppingEpoch === "number" &&
        typeof inventory.fleetEpoch === "number" &&
        inventory.fleetEpoch >= lease.stoppingEpoch;
      const hasFreshTimestamp =
        typeof inventory.discoveredAtMs === "number" &&
        Number.isFinite(inventory.discoveredAtMs) &&
        (hasFreshEpoch
          ? inventory.discoveredAtMs >= requiredFreshAfterMs
          : inventory.discoveredAtMs > requiredFreshAfterMs);
      if (requiredFreshAfterMs > 0 && !hasFreshTimestamp) {
        continue;
      }
      if (requiredFreshAfterMs > 0 && now < requiredFreshAfterMs) {
        continue;
      }
      if (leasePlatform === "ios") {
        if (!simctlListOk) continue;
        if (lease.serial && onlineSimSerials.has(lease.serial)) continue;
        recordDeviceStoppedInState(state, lease, now);
        delete state.leases[deviceKey];
        mutated = true;
        continue;
      }
      if (!emulatorListOk || !adbDevicesOk) continue;
      const avdOnline = Boolean(lease.avd && onlineAvds.has(lease.avd));
      const serialOnline = Boolean(lease.serial && onlineSerials.has(lease.serial));
      const hasUnmappedEmulator = Boolean(
        lease.avd &&
          (inventory.running || []).some(
            (d) => d.kind === "emulator" && (d.platform || "android") === "android" && !d.avd,
          ),
      );
      if (avdOnline || serialOnline || hasUnmappedEmulator) continue;
      const otherActiveAvds = new Set([
        ...onlineAvds,
        ...Object.values(state.leases || {})
          .filter((l) => l && l.leaseId !== lease.leaseId && l.avd)
          .map((l) => l.avd),
      ]);
      const offlineEntry = lease.avd
        ? (inventory.offline || []).find((d) => d.avd === lease.avd || d.deviceKey === deviceKey)
        : null;
      const hasLocks = lease.avd
        ? Boolean(offlineEntry?.hasLockFiles) ||
          Boolean(avdHome && avdHasRuntimeLockFiles(lease.avd, avdHome, livenessCheck))
        : Boolean(
            (inventory.offline || []).some(
              (d) => d?.hasLockFiles && (!d.avd || !otherActiveAvds.has(d.avd)),
            ),
          ) ||
          Boolean(
            avdHome && offlineAvdHasRuntimeLockFiles(avdHome, otherActiveAvds, livenessCheck),
          );
      if (hasLocks) continue;
      recordDeviceStoppedInState(state, lease, now);
      delete state.leases[deviceKey];
      mutated = true;
      continue;
    }
    if (lease.state !== "active") continue;
    const leaseActiveSinceMs = Math.max(
      typeof lease.activatedAtMs === "number" && Number.isFinite(lease.activatedAtMs)
        ? lease.activatedAtMs
        : 0,
      typeof lease.claimedAtMs === "number" && Number.isFinite(lease.claimedAtMs)
        ? lease.claimedAtMs
        : 0,
    );
    if (
      typeof lease.activatedEpoch === "number" &&
      typeof inventory.fleetEpoch === "number" &&
      inventory.fleetEpoch < lease.activatedEpoch
    ) {
      continue;
    }
    if (
      typeof inventory.discoveredAtMs === "number" &&
      Number.isFinite(inventory.discoveredAtMs) &&
      leaseActiveSinceMs > 0 &&
      inventory.discoveredAtMs < leaseActiveSinceMs
    ) {
      continue;
    }
    if (lease.kind === "physical") {
      const serialOnline = Boolean(lease.serial && onlineSerials.has(lease.serial));
      if (serialOnline) {
        if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
          lease.firstSeenOfflineAtMs = null;
          mutated = true;
        }
        continue;
      }
      if (leasePlatform === "ios" ? !devicectlListOk : !adbDevicesOk) {
        continue;
      }
    } else if (leasePlatform === "ios") {
      const simOnline = Boolean(
        lease.serial && (onlineSimSerials.has(lease.serial) || onlineSerials.has(lease.serial)),
      );
      if (simOnline) {
        if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
          lease.firstSeenOfflineAtMs = null;
          mutated = true;
        }
        continue;
      }
      if (!simctlListOk) {
        continue;
      }
    } else {
      const runningForAvd = lease.avd
        ? (inventory.running || []).find(
            (d) =>
              d.kind === "emulator" &&
              (d.platform || "android") === "android" &&
              d.avd === lease.avd,
          )
        : null;
      const runningForSerial = lease.serial
        ? (inventory.running || []).find(
            (d) =>
              d.kind === "emulator" &&
              (d.platform || "android") === "android" &&
              d.serial === lease.serial,
          )
        : null;
      const serialTakenByOtherAvd = Boolean(
        lease.avd &&
          runningForSerial &&
          runningForSerial.avd &&
          runningForSerial.avd !== lease.avd,
      );
      if (
        runningForAvd &&
        runningForAvd.serial &&
        runningForAvd.serial !== lease.serial
      ) {
        lease.serial = runningForAvd.serial;
        mutated = true;
      } else if (serialTakenByOtherAvd && (!runningForAvd || !runningForAvd.serial)) {
        lease.serial = null;
        mutated = true;
      }
      const avdOnline = Boolean(lease.avd && onlineAvds.has(lease.avd));
      const serialOnline = Boolean(
        lease.serial &&
          onlineSerials.has(lease.serial) &&
          !serialTakenByOtherAvd &&
          (!lease.avd ||
            !emulatorListOk ||
            runningForSerial?.unknownAvd ||
            runningForSerial?.avd === lease.avd),
      );
      if (avdOnline || serialOnline) {
        if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
          lease.firstSeenOfflineAtMs = null;
          mutated = true;
        }
        continue;
      }
      if (!emulatorListOk || !adbDevicesOk) {
        continue;
      }
    }

    if (syncLeaseWorkers(lease, livenessCheck).length > 0) {
      continue;
    }

    // Preserve active lease with serial: null from a failed owner restart (firstSeenOfflineAtMs === null)
    if (
      lease.sessionId === callerSessionId &&
      lease.kind === "emulator" &&
      lease.avd &&
      !lease.serial &&
      (lease.firstSeenOfflineAtMs === null || lease.firstSeenOfflineAtMs === undefined)
    ) {
      continue;
    }

    // Clear stale Android emulator serial immediately upon confirmed offline detection
    if (
      lease.kind === "emulator" &&
      leasePlatform === "android" &&
      lease.serial !== null &&
      lease.serial !== undefined
    ) {
      lease.serial = null;
      mutated = true;
    }

    if (lease.firstSeenOfflineAtMs === null || lease.firstSeenOfflineAtMs === undefined) {
      lease.firstSeenOfflineAtMs = now;
      mutated = true;
    }

    const graceMs =
      lease.kind === "physical"
        ? (state.config?.physicalOfflineGraceMs ?? 15_000)
        : (state.config?.offlineGraceMs ?? 45_000);
    const expiresAtMs =
      typeof lease.expiresAtMs === "number" && Number.isFinite(lease.expiresAtMs)
        ? lease.expiresAtMs
        : Infinity;
    const recoveryDeadlineMs = Math.min(expiresAtMs, lease.firstSeenOfflineAtMs + graceMs);

    if (now >= recoveryDeadlineMs) {
      if (lease.kind === "physical") {
        if (
          !state.disconnectedPhysicalLeases ||
          typeof state.disconnectedPhysicalLeases !== "object"
        ) {
          state.disconnectedPhysicalLeases = {};
        }
        state.disconnectedPhysicalLeases[lease.leaseId] = {
          leaseId: lease.leaseId,
          sessionId: lease.sessionId,
          serial: lease.serial,
          platform: leasePlatform,
          profile: lease.profile || null,
          disconnectedAtMs: lease.firstSeenOfflineAtMs,
          expiresAtMs:
            typeof lease.expiresAtMs === "number" && Number.isFinite(lease.expiresAtMs)
              ? lease.expiresAtMs
              : now + (state.config?.defaultTtlSec ?? 600) * 1000,
        };
      }
      delete state.leases[deviceKey];
      mutated = true;
    }
  }
  return mutated;
}

export function withStateTransaction(stateDir, fn, options = {}) {
  // Pre-warm ancestor PID cache strictly outside atc.lock so resolveSessionIdentity never spawns subprocesses under lock
  if (!options.ancestorPids) {
    getAncestorPids(options.ppid ?? process.ppid);
  }
  let pgidSnapshot = null;
  const terminatedSet = new Set();
  if (Array.isArray(options.terminatedPgids)) {
    for (const p of options.terminatedPgids) {
      if (typeof p === "string" && p.includes("@")) {
        const trimmed = p.trim();
        const num = Number(trimmed.split("@")[0]);
        if (Number.isInteger(num) && num > 1) {
          terminatedSet.add(trimmed);
        }
      } else {
        const num = Number(p);
        if (Number.isInteger(num) && num > 1) {
          terminatedSet.add(num);
        }
      }
    }
  }
  const isTerminatedKey = (rawKey) => {
    if (typeof rawKey === "string" && rawKey.includes("@")) {
      return terminatedSet.has(rawKey.trim());
    }
    return terminatedSet.has(Number(rawKey));
  };
  const freshGenerationSet = new Set(
    Array.isArray(options.freshGenerationPgids)
      ? options.freshGenerationPgids.map(Number).filter((p) => Number.isInteger(p) && p > 1)
      : [],
  );
  if (!options.archivedGeneration) {
    for (const freshPid of freshGenerationSet) {
      archiveWindowsProcessGroupGeneration(freshPid);
    }
  }
  try {
    const preRaw = readStateFileRaw(path.join(stateDir, "state.json"), false);
    const pgids = [];
    const knownDescendants = {};
    const pgidStartTokens = {};
    if (preRaw) {
      const preParsed = JSON.parse(preRaw);
      const allPreLeases = [
        ...Object.values(preParsed?.leases || {}),
        ...Object.values(preParsed?.buildLeases || {}),
      ];
      for (const lease of allPreLeases) {
        if (!lease || typeof lease !== "object") continue;
        if (lease.workerDescendants && typeof lease.workerDescendants === "object") {
          for (const [k, v] of Object.entries(lease.workerDescendants)) {
            if (isTerminatedKey(k)) continue;
            if (!k.includes("@") && Array.isArray(v)) {
              const numPid = Number(k);
              const prevGenToken = deriveWindowsTreeGenerationToken(numPid, v);
              const curKnown = getKnownWindowsTreeDescendants(numPid);
              const curGenToken = deriveWindowsTreeGenerationToken(numPid, curKnown);
              const isReplacedGen =
                freshGenerationSet.has(numPid) ||
                Boolean(
                  prevGenToken &&
                    (getKnownWindowsTreeDescendants(`${numPid}@${prevGenToken}`).length > 0 ||
                      (curGenToken && curGenToken !== prevGenToken)),
                );
              if (isReplacedGen && prevGenToken) {
                const archiveKey = `${numPid}@${prevGenToken}`;
                knownDescendants[archiveKey] = v;
                pgids.push(archiveKey);
                if (curKnown.length > 0) {
                  knownDescendants[k] = curKnown;
                }
                continue;
              }
            }
            knownDescendants[k] = v;
          }
        }
        if (
          lease.workerPgidStartTokens &&
          typeof lease.workerPgidStartTokens === "object"
        ) {
          for (const [k, v] of Object.entries(lease.workerPgidStartTokens)) {
            if (typeof v !== "string" || !v.trim()) continue;
            const trimmedV = v.trim();
            const numPid = Number(k);
            const curKnown = getKnownWindowsTreeDescendants(numPid);
            const curGenToken = deriveWindowsTreeGenerationToken(numPid, curKnown);
            const inMemStartTok = getKnownPosixPgidStartToken(numPid);
            const isReplacedStartTok =
              freshGenerationSet.has(numPid) ||
              Boolean(inMemStartTok && inMemStartTok !== trimmedV) ||
              Boolean(curGenToken && curGenToken !== trimmedV);
            if (!isTerminatedKey(k) && !isReplacedStartTok) {
              pgidStartTokens[k] = trimmedV;
            } else if (!isTerminatedKey(k) && inMemStartTok) {
              pgidStartTokens[k] = inMemStartTok;
            }
          }
        }
        if (Array.isArray(lease.workerPgids)) {
          for (const p of lease.workerPgids) {
            if (!isTerminatedKey(p)) {
              pgids.push(p);
            }
          }
        }
      }
    }
    for (const freshPid of freshGenerationSet) {
      if (!isTerminatedKey(freshPid)) {
        pgids.push(freshPid);
        const freshTok =
          options.freshGenerationStartTokens?.[String(freshPid)] ??
          getKnownPosixPgidStartToken(freshPid);
        if (freshTok) {
          pgidStartTokens[String(freshPid)] = freshTok;
        }
      }
    }
    if (Object.keys(knownDescendants).length > 0) {
      seedWindowsKnownDescendants(knownDescendants);
    }
    if (Object.keys(pgidStartTokens).length > 0) {
      seedPosixPgidStartTokens(pgidStartTokens);
    }
    if (pgids.length > 0) {
      pgidSnapshot = snapshotProcessGroupsOutsideLock(pgids, {
        knownDescendants,
        pgidStartTokens,
        spawnSyncFn: options.spawnSyncFn || options.runner,
        platform: options.platform,
        livenessCheck: options.livenessCheck,
        killFn: options.killFn,
      });
    }
  } catch {
    // Ignore pre-lock snapshot parse errors
  }
  if (terminatedSet.size > 0) {
    if (!pgidSnapshot) pgidSnapshot = new Map();
    for (const p of terminatedSet) {
      pgidSnapshot.set(p, false);
      clearKnownWindowsTreeDescendants(p);
      clearKnownPosixPgidStartTokens(p);
    }
  }
  const auditEvents = [];
  let auditLoggingEnabled = true;
  const txResult = withLock(
    stateDir,
    (lockHandle) =>
      withProcessGroupSnapshot(pgidSnapshot, () => {
        const now = options.now ?? Date.now();
        const state = readState(stateDir, { lockHandle });
        auditLoggingEnabled = state?.config?.auditLogging !== false;
        if (freshGenerationSet.size > 0) {
          for (const lease of [
            ...Object.values(state?.leases || {}),
            ...Object.values(state?.buildLeases || {}),
          ]) {
            if (!lease || typeof lease !== "object") continue;
            for (const freshPid of freshGenerationSet) {
              reconcileLeaseWindowsGenerations(lease, freshPid, {
                archivedGeneration: Boolean(options.archivedGeneration),
              });
            }
          }
        }
        const pruned = runGarbageCollection(state, stateDir, now, options.livenessCheck);
        for (const p of pruned.leases) {
          auditEvents.push({
            tsMs: now,
            event: "device_gc_prune",
            sessionId: null,
            details: p,
          });
        }
        for (const p of pruned.queue) {
          auditEvents.push({
            tsMs: now,
            event: "device_queue_prune",
            sessionId: p.sessionId || null,
            details: p,
          });
        }
        for (const p of pruned.buildLeases) {
          auditEvents.push({
            tsMs: now,
            event: "build_gc_prune",
            sessionId: p.sessionId || null,
            details: p,
          });
        }
        for (const p of pruned.buildQueue) {
          auditEvents.push({
            tsMs: now,
            event: "build_queue_prune",
            sessionId: p.sessionId || null,
            details: p,
          });
        }
        const result = fn(state, { now, pruned, lockHandle, auditEvents });
        const gcMutated =
          pruned.leases.length > 0 ||
          pruned.queue.length > 0 ||
          pruned.buildLeases.length > 0 ||
          pruned.buildQueue.length > 0 ||
          pruned.hookSessions.length > 0 ||
          Boolean(pruned.workersMutated);
        if ((result && result.mutated !== false) || gcMutated) {
          commitState(stateDir, state, lockHandle);
        }
        return result?.value !== undefined ? result.value : result;
      }),
    options.lockTimeoutMs,
    "atc.lock",
    undefined,
    options,
  );
  if (auditEvents.length > 0) {
    flushAuditEvents(auditEvents, {
      stateDir,
      env: options.env,
      platform: options.platform,
      enabled: auditLoggingEnabled,
    });
  }
  return txResult;
}

export function normalizeDeviceType(type) {
  if (!type) return "";
  const t = String(type).trim().toLowerCase();
  if (t === "wear" || t === "wearos" || t === "watchos") return "watch";
  if (t === "iphone") return "phone";
  if (t === "ipad") return "tablet";
  if (t === "appletv") return "tv";
  if (t === "vision" || t === "visionos") return "xr";
  return t;
}

export function normalizeApiLevel(spec) {
  if (!spec) return null;
  const s = String(spec).trim();
  if (/^\d+$/.test(s)) return `android-${s}`;
  return s;
}

export function parseApiNumber(apiStr) {
  if (!apiStr) return null;
  const m = String(apiStr).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function matchesApiSpec(deviceApiLevel, apiSpec) {
  if (!apiSpec) return true;
  if (!deviceApiLevel || deviceApiLevel === "unknown") return false;
  const spec = String(apiSpec).trim();
  const devNum = parseApiNumber(deviceApiLevel);
  if (devNum === null) {
    return String(deviceApiLevel) === normalizeApiLevel(spec);
  }
  const rangeMatch = spec.match(/^(\d+)\.\.(\d+)$/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    return devNum >= min && devNum <= max;
  }
  const cmpMatch = spec.match(/^(>=|<=|>|<|=)\s*(?:android-)?(\d+)$/);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const target = Number(cmpMatch[2]);
    if (op === ">=") return devNum >= target;
    if (op === "<=") return devNum <= target;
    if (op === ">") return devNum > target;
    if (op === "<") return devNum < target;
    return devNum === target;
  }
  const exactNum = parseApiNumber(spec);
  return exactNum !== null ? devNum === exactNum : false;
}

export function parseOsVersionNumber(osStr) {
  if (!osStr) return null;
  const m = String(osStr).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function matchesOsSpec(deviceOsVersion, osSpec) {
  if (!osSpec) return true;
  if (!deviceOsVersion || deviceOsVersion === "unknown") return false;
  const spec = String(osSpec).trim().replace(/^[A-Za-z]+\s*/i, "");
  const devNum = parseOsVersionNumber(deviceOsVersion);
  if (devNum === null) {
    return String(deviceOsVersion).toLowerCase() === String(osSpec).trim().toLowerCase();
  }
  const rangeMatch = spec.match(/^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    const effectiveMax = rangeMatch[2].includes(".") ? max : max + 0.9999;
    return devNum >= min && devNum <= effectiveMax;
  }
  const cmpMatch = spec.match(/^(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)$/);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const rawTarget = cmpMatch[2];
    const target = Number(rawTarget);
    if (op === ">=") return devNum >= target;
    if (op === "<=") return rawTarget.includes(".") ? devNum <= target : devNum < target + 1;
    if (op === ">") return rawTarget.includes(".") ? devNum > target : devNum >= target + 1;
    if (op === "<") return devNum < target;
    return rawTarget.includes(".") ? Math.abs(devNum - target) < 1e-6 : Math.floor(devNum) === target;
  }
  const exactMatch = spec.match(/^(\d+(?:\.\d+)?)$/);
  if (exactMatch) {
    const rawTarget = exactMatch[1];
    const target = Number(rawTarget);
    if (rawTarget.includes(".")) {
      return Math.abs(devNum - target) < 1e-6;
    }
    return Math.floor(devNum) === target;
  }
  return false;
}

const UUID_SELECTOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matchesSingleLeaseSelector(lease, sel) {
  if (!lease || !sel) return false;
  const trimmed = String(sel).trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("ios_simulator_version=")) {
    if ((lease.platform || "android") !== "ios") return false;
    const verSpec = trimmed.slice("ios_simulator_version=".length).trim();
    const leaseOs = lease.profile?.osVersion || lease.profile?.apiLevel || null;
    if (!leaseOs) return false;
    return matchesOsSpec(leaseOs, verSpec);
  }
  if (trimmed.startsWith("ios_simulator_device=") || (lease.platform || "android") === "ios") {
    if ((lease.platform || "android") !== "ios") return false;
    const rawDevSpec = trimmed.startsWith("ios_simulator_device=")
      ? trimmed.slice("ios_simulator_device=".length).trim()
      : trimmed;
    const devSpec = rawDevSpec.toLowerCase();
    if (!devSpec) return false;
    const candidates = [
      lease.serial,
      lease.udid,
      lease.coreDeviceId,
      lease.profile?.coreDeviceId,
      lease.profile?.deviceName,
      lease.avd,
      lease.profile?.deviceTypeId,
      lease.profile?.deviceTypeIdentifier,
    ]
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase());
    return candidates.includes(devSpec);
  }
  const exactIds = [
    lease.serial,
    lease.udid,
    lease.coreDeviceId,
    lease.profile?.coreDeviceId,
  ].filter(Boolean);
  for (const id of exactIds) {
    if (String(id) === trimmed) return true;
    if (UUID_SELECTOR_RE.test(trimmed) && UUID_SELECTOR_RE.test(String(id))) {
      if (String(id).toLowerCase() === trimmed.toLowerCase()) return true;
    }
  }
  return false;
}

export function findConflictingLeaseSelector(
  lease,
  targetSerial,
  { allowRewritableBooted = false } = {},
) {
  if (!targetSerial || !lease) return null;
  const parts = String(targetSerial)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const leasePlat = lease.platform || "android";
  for (const part of parts) {
    if (
      allowRewritableBooted &&
      leasePlat === "ios" &&
      lease.kind === "emulator" &&
      part.toLowerCase() === "booted"
    ) {
      continue;
    }
    if (!matchesSingleLeaseSelector(lease, part)) {
      return part;
    }
  }
  return null;
}

export function matchesLeaseTarget(lease, targetSerial, options = {}) {
  if (!lease || !targetSerial) return false;
  return findConflictingLeaseSelector(lease, targetSerial, options) === null;
}

export function matchesProfile(device, req = {}) {
  const devPlatform = device.platform || "android";
  if (req.platform && req.platform !== "any" && devPlatform !== req.platform) {
    return false;
  }
  const requestedKind =
    req.kind ||
    (req.serial && !req.serial.startsWith("emulator-") && !req.udid ? "any" : "emulator");
  if (requestedKind !== "any" && device.kind !== requestedKind) {
    return false;
  }
  if (req.udid) {
    const wantUdid = String(req.udid).trim().toLowerCase();
    const devUdid = String(device.udid || device.serial || "").trim().toLowerCase();
    const devAvd = String(device.avd || "").trim().toLowerCase();
    if (devUdid !== wantUdid && devAvd !== wantUdid) {
      return false;
    }
  }
  if (req.avd) {
    if (devPlatform === "ios") {
      const wantAvd = String(req.avd).trim().toLowerCase();
      const devAvd = String(device.avd || "").trim().toLowerCase();
      const devName = String(device.profile?.deviceName || "").trim().toLowerCase();
      const devUdid = String(device.udid || device.serial || "").trim().toLowerCase();
      const devTypeId = String(
        device.profile?.deviceTypeId || device.profile?.deviceTypeIdentifier || "",
      )
        .trim()
        .toLowerCase();
      if (
        devAvd !== wantAvd &&
        devName !== wantAvd &&
        devUdid !== wantAvd &&
        devTypeId !== wantAvd
      ) {
        return false;
      }
    } else if (device.avd !== req.avd) {
      return false;
    }
  }
  if (req.serial) {
    if (device.serial !== req.serial && device.udid !== req.serial) {
      return false;
    }
  }
  if (req.deviceType) {
    const want = normalizeDeviceType(req.deviceType);
    const actual = normalizeDeviceType(device.profile?.deviceType || "");
    if (actual !== want) {
      const resizableCompatible = ["phone", "foldable", "tablet", "desktop"].includes(want);
      if (!(actual === "resizable" && resizableCompatible)) {
        return false;
      }
    }
  }
  if (req.apiSpec) {
    if (devPlatform === "ios") {
      if (!matchesOsSpec(device.profile?.osVersion || device.profile?.apiLevel, req.apiSpec)) {
        return false;
      }
    } else if (!matchesApiSpec(device.profile?.apiLevel, req.apiSpec)) {
      return false;
    }
  }
  if (req.osSpec) {
    if (devPlatform === "ios") {
      if (!matchesOsSpec(device.profile?.osVersion || device.profile?.apiLevel, req.osSpec)) {
        return false;
      }
    } else if (!matchesApiSpec(device.profile?.apiLevel, req.osSpec)) {
      return false;
    }
  }
  if (req.services) {
    if ((device.profile?.services || "").toLowerCase() !== req.services.toLowerCase()) {
      return false;
    }
  }
  if (req.play === true && device.profile?.services !== "play" && device.profile?.playStore !== true) {
    return false;
  }
  if (
    req.play === false &&
    (device.profile?.services === "play" ||
      device.profile?.playStore === true ||
      (device.profile?.services == null && device.profile?.playStore == null))
  ) {
    return false;
  }
  if (req.abi && (device.profile?.abi || "").toLowerCase() !== req.abi.toLowerCase()) {
    return false;
  }
  if (
    (req.snapshotLoad || req.snapshotSaveOnFree || req.wipeData || req.coldBoot) &&
    device.kind !== "emulator"
  ) {
    return false;
  }
  if (req.snapshotLoad && device.kind === "emulator") {
    if (device.loadedSnapshot === req.snapshotLoad) {
      return true;
    }
    if (Array.isArray(device.snapshots) && !device.snapshots.includes(req.snapshotLoad)) {
      return false;
    }
  }
  return true;
}

export function computeEffectiveMaxEmulators(config = DEFAULT_CONFIG, host = {}) {
  const envCap = process.env.ATC_MAX_EMULATORS;
  if (envCap && /^\d+$/.test(envCap.trim())) {
    return Math.max(1, Number(envCap.trim()));
  }
  const raw = config.maxRunningEmulators;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return raw;
  }
  const totalRamGb = (host.totalRamMb || Math.round(os.totalmem() / (1024 * 1024))) / 1024;
  const cpuCores = host.cpuCores || os.availableParallelism();
  const reserveGb = Math.max(6, totalRamGb * 0.3);
  const byRam = Math.floor((totalRamGb - reserveGb) / 3.5);
  const byCpu = Math.floor(cpuCores / 4);
  return Math.max(1, Math.min(6, Math.min(byRam, byCpu)));
}

export function computeEffectiveMaxSimulators(config = DEFAULT_CONFIG, host = {}) {
  const envCap = process.env.ATC_MAX_SIMULATORS;
  if (envCap && /^\d+$/.test(envCap.trim())) {
    return Math.max(1, Number(envCap.trim()));
  }
  const raw = config.maxRunningSimulators ?? DEFAULT_CONFIG.maxRunningSimulators;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return raw;
  }
  const totalRamGb = (host.totalRamMb || Math.round(os.totalmem() / (1024 * 1024))) / 1024;
  const cpuCores = host.cpuCores || os.availableParallelism();
  const reserveGb = Math.max(6, totalRamGb * 0.3);
  const byRam = Math.floor((totalRamGb - reserveGb) / 2.0);
  const byCpu = Math.floor(cpuCores / 2);
  return Math.max(1, Math.min(8, Math.min(byRam, byCpu)));
}

export function computeUsedEmulatorSlots(state, inventory = {}) {
  const runningOrStopping = new Set();
  const serialToLeasedAvd = new Map();
  for (const lease of Object.values(state.leases || {})) {
    if ((lease.platform || "android") === "android" && lease.kind === "emulator" && lease.serial && lease.avd) {
      serialToLeasedAvd.set(lease.serial, lease.avd);
    }
  }
  const inventoryEmulatorSerials = new Set();
  for (const dev of inventory.running || []) {
    if ((dev.platform || "android") === "android" && dev.kind === "emulator") {
      if (dev.serial) {
        inventoryEmulatorSerials.add(dev.serial);
      }
      const key = dev.avd || serialToLeasedAvd.get(dev.serial) || (dev.serial ? `serial:${dev.serial}` : null);
      if (key) {
        runningOrStopping.add(key);
      }
    }
  }
  for (const dev of inventory.offline || []) {
    if (
      (dev.platform || "android") === "android" &&
      dev.kind === "emulator" &&
      (dev.hasLockFiles ||
        (inventory.avdHome && dev.avd && avdHasRuntimeLockFiles(dev.avd, inventory.avdHome)))
    ) {
      const key = dev.avd || dev.deviceKey;
      if (key) {
        runningOrStopping.add(key);
      }
    }
  }
  for (const lease of Object.values(state.leases || {})) {
    if (
      (lease.platform || "android") === "android" &&
      lease.kind === "emulator" &&
      (lease.state === "stopping" || lease.state === "active")
    ) {
      if (lease.avd) {
        runningOrStopping.add(lease.avd);
      } else if (lease.serial && !inventoryEmulatorSerials.has(lease.serial)) {
        runningOrStopping.add(`serial:${lease.serial}`);
      }
    }
  }
  let startingExtra = 0;
  for (const lease of Object.values(state.leases || {})) {
    if ((lease.platform || "android") === "android" && lease.kind === "emulator" && lease.state === "starting") {
      const avdAlreadyCounted = lease.avd && runningOrStopping.has(lease.avd);
      const replacingAlreadyCounted =
        lease.replacingAvd && runningOrStopping.has(lease.replacingAvd);
      if (!avdAlreadyCounted && !replacingAlreadyCounted) {
        startingExtra += 1;
      }
    }
  }
  return runningOrStopping.size + startingExtra;
}

export function computeUsedSimulatorSlots(state, inventory = {}) {
  const runningOrStopping = new Set();
  for (const dev of inventory.running || []) {
    if ((dev.platform || "android") === "ios" && dev.kind === "emulator") {
      const key = dev.udid || dev.serial || dev.avd || dev.deviceKey;
      if (key) {
        runningOrStopping.add(key);
      }
    }
  }
  for (const lease of Object.values(state.leases || {})) {
    if (
      (lease.platform || "android") === "ios" &&
      lease.kind === "emulator" &&
      (lease.state === "stopping" || lease.state === "active")
    ) {
      const key = lease.udid || lease.serial || lease.avd || lease.deviceKey;
      if (key) {
        runningOrStopping.add(key);
      }
    }
  }
  let startingExtra = 0;
  for (const lease of Object.values(state.leases || {})) {
    if ((lease.platform || "android") === "ios" && lease.kind === "emulator" && lease.state === "starting") {
      const key = lease.udid || lease.serial || lease.avd || lease.deviceKey;
      const alreadyCounted = key && runningOrStopping.has(key);
      const replacingAlreadyCounted =
        lease.replacingAvd && runningOrStopping.has(lease.replacingAvd);
      if (!alreadyCounted && !replacingAlreadyCounted) {
        startingExtra += 1;
      }
    }
  }
  return runningOrStopping.size + startingExtra;
}

export function canJumpAhead(candidateTicket, earlierTicket, targetDevice, now, config = DEFAULT_CONFIG) {
  const windowMs = (config.reorderWindowSec ?? 120) * 1000;
  const earlierDeadline =
    earlierTicket.starvationDeadlineMs ?? earlierTicket.enqueuedAtMs + windowMs;
  if (now >= earlierDeadline) {
    return false;
  }
  if (candidateTicket.enqueuedAtMs - earlierTicket.enqueuedAtMs > windowMs) {
    return false;
  }
  const candidateWarm =
    Boolean(targetDevice.online) &&
    !candidateTicket.requestedProfile?.wipeData &&
    !candidateTicket.requestedProfile?.coldBoot;
  const earlierMatchesWarm = matchesProfile(targetDevice, {
    platform: earlierTicket.requestedPlatform,
    kind: earlierTicket.requestedKind,
    avd: earlierTicket.requestedAvd,
    udid: earlierTicket.requestedUdid,
    serial: earlierTicket.requestedSerial,
    ...earlierTicket.requestedProfile,
  });
  return candidateWarm && !earlierMatchesWarm;
}

export function isTicketStarvationProtected(ticket, now, config = DEFAULT_CONFIG) {
  const windowMs = (config.reorderWindowSec ?? 120) * 1000;
  const deadline = ticket.starvationDeadlineMs ?? ticket.enqueuedAtMs + windowMs;
  return now >= deadline;
}

export const SESSION_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

export function validateSessionId(id) {
  if (!id || !SESSION_ID_REGEX.test(id)) {
    throw new Error(`Invalid session ID "${id}" (must match ${SESSION_ID_REGEX})`);
  }
  return id;
}

export function canonicalizeMcpArgs(args) {
  const sortJsonValue = (val) => {
    if (Array.isArray(val)) return val.map(sortJsonValue);
    if (val && typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        if (v !== undefined) out[k] = sortJsonValue(v);
      }
      return out;
    }
    return val;
  };
  if (!args || typeof args !== "object" || Array.isArray(args)) return "{}";
  const filtered = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== "session" && k !== "role" && v !== undefined) {
      filtered[k] = sortJsonValue(v);
    }
  }
  return JSON.stringify(sortJsonValue(filtered));
}

export function recordHookSession(
  state,
  { anchorPid, sessionId, cwd, now = Date.now(), mcpToolName = null, mcpToolInput = null },
) {
  const pidKey = String(anchorPid);
  const prev = state.hookSessions[pidKey];
  const prevLive =
    prev && typeof prev.updatedAtMs === "number" && now - prev.updatedAtMs <= 60_000;
  const seenList =
    prevLive && Array.isArray(prev.seenSessions)
      ? prev.seenSessions.filter((s) => typeof s === "string" && s !== sessionId)
      : prevLive && typeof prev.sessionId === "string" && prev.sessionId !== sessionId
        ? [prev.sessionId]
        : [];
  seenList.push(sessionId);
  const pendingMcpCalls = (
    prevLive && Array.isArray(prev.pendingMcpCalls) ? prev.pendingMcpCalls : []
  ).filter(
    (item) => item && typeof item.updatedAtMs === "number" && now - item.updatedAtMs <= 60_000,
  );
  const hasExplicitMcpSessionArg = Boolean(
    mcpToolInput &&
      typeof mcpToolInput === "object" &&
      ((typeof mcpToolInput.session === "string" && mcpToolInput.session.trim()) ||
        (typeof mcpToolInput.role === "string" && mcpToolInput.role.trim())),
  );
  if (mcpToolName && !hasExplicitMcpSessionArg) {
    pendingMcpCalls.push({
      sessionId,
      toolName: String(mcpToolName).toLowerCase(),
      argsKey: canonicalizeMcpArgs(mcpToolInput),
      updatedAtMs: now,
    });
  }
  state.hookSessions[pidKey] = {
    sessionId,
    agentPid: anchorPid,
    cwd,
    updatedAtMs: now,
    seenSessions: seenList,
    pendingMcpCalls,
  };
  return state.hookSessions[pidKey];
}

export function consumePendingMcpHookSession(
  stateDir,
  {
    toolName,
    args = {},
    ppid = process.ppid,
    cwd = process.cwd(),
    ancestorPids = null,
    explicitSession = null,
    ...txOptions
  } = {},
) {
  try {
    const peek = readState(stateDir);
    if (!peek?.hookSessions || Object.keys(peek.hookSessions).length === 0) {
      return { sessionId: explicitSession || null, error: null };
    }
  } catch {
    // Fall through to transaction if state read fails
  }
  const normTool = String(toolName || "").toLowerCase();
  const argsKey = canonicalizeMcpArgs(args);
  if (!ancestorPids) {
    getAncestorPids(ppid);
  }
  return withStateTransaction(
    stateDir,
    (state, { now }) => {
      if (!state?.hookSessions) {
        return { mutated: false, value: { sessionId: explicitSession || null, error: null } };
      }
      const ancestors = ancestorPids || ancestorPidCache.get(Number(ppid)) || [Number(ppid)];
      let entry = state.hookSessions[String(ppid)] || null;
      if (!entry) {
        for (const ancPid of ancestors) {
          if (state.hookSessions[String(ancPid)]) {
            entry = state.hookSessions[String(ancPid)];
            break;
          }
        }
      }
      if (!entry) {
        const cwdMatches = Object.values(state.hookSessions).filter((h) => h && h.cwd === cwd);
        if (cwdMatches.length === 1) {
          entry = cwdMatches[0];
        } else if (cwdMatches.length > 1) {
          const ancestorSet = new Set(ancestors.map(Number));
          const ancestorCwdMatches = cwdMatches.filter((h) =>
            ancestorSet.has(Number(h.agentPid)),
          );
          if (ancestorCwdMatches.length === 1) {
            entry = ancestorCwdMatches[0];
          } else if (!explicitSession) {
            return {
              mutated: false,
              value: {
                sessionId: null,
                error: `Multiple active agent sessions detected in ${cwd}; pass --session <unique_id> or ATC_SESSION_ID explicitly.`,
              },
            };
          }
        }
      }
      if (!entry) {
        return { mutated: false, value: { sessionId: explicitSession || null, error: null } };
      }

      const livePending = Array.isArray(entry.pendingMcpCalls)
        ? entry.pendingMcpCalls.filter(
            (item) =>
              item && typeof item.updatedAtMs === "number" && now - item.updatedAtMs <= 60_000,
          )
        : [];
      let mutated =
        Array.isArray(entry.pendingMcpCalls) && livePending.length !== entry.pendingMcpCalls.length;
      entry.pendingMcpCalls = livePending;

      if (explicitSession) {
        const idx = livePending.findIndex(
          (item) =>
            item.sessionId === explicitSession &&
            item.toolName === normTool &&
            item.argsKey === argsKey,
        );
        if (idx !== -1) {
          livePending.splice(idx, 1);
          mutated = true;
        }
        return { mutated, value: { sessionId: explicitSession, error: null } };
      }

      const matching = livePending.filter(
        (item) => item.toolName === normTool && item.argsKey === argsKey,
      );
      if (matching.length > 0) {
        const matchingSessions = new Set(matching.map((m) => m.sessionId));
        if (matchingSessions.size > 1) {
          return {
            mutated,
            value: {
              sessionId: null,
              error: `Multiple concurrent agent sessions invoked ${normTool} with identical arguments without forwarding a session ID; pass session explicitly.`,
            },
          };
        }
        const resolved = matching[0].sessionId;
        const idx = livePending.indexOf(matching[0]);
        if (idx !== -1) {
          livePending.splice(idx, 1);
          mutated = true;
        }
        return { mutated, value: { sessionId: resolved, error: null } };
      }

      if (Array.isArray(entry.seenSessions) && entry.seenSessions.length > 1) {
        return {
          mutated,
          value: {
            sessionId: null,
            error: `Multiple active agent sessions detected in ${cwd}; pass --session <unique_id> or ATC_SESSION_ID explicitly.`,
          },
        };
      }
      if (SESSION_ID_REGEX.test(entry.sessionId)) {
        return { mutated, value: { sessionId: entry.sessionId, error: null } };
      }
      return { mutated, value: { sessionId: null, error: null } };
    },
    { ...txOptions, ppid },
  );
}

export function resolveSessionIdentity({
  flags = {},
  env = process.env,
  state = null,
  cwd = process.cwd(),
  ppid = process.ppid,
  ancestorPids = null,
  processChain = null,
} = {}) {
  const rawAnchor = flags.anchorPid ?? env.ATC_ANCHOR_PID;
  const explicitAnchor =
    rawAnchor && /^\d+$/.test(String(rawAnchor)) ? Number(rawAnchor) : null;
  const stablePpid = resolveStableParentPid(ppid, processChain);

  const findHookAnchorForSession = (sid) => {
    if (explicitAnchor) return explicitAnchor;
    if (state?.hookSessions) {
      const matched = Object.values(state.hookSessions).find(
        (h) =>
          h &&
          h.agentPid &&
          (h.sessionId === sid ||
            (Array.isArray(h.seenSessions) && h.seenSessions.includes(sid))),
      );
      if (matched) return Number(matched.agentPid);
    }
    return null;
  };

  const resolveMigratedMcpSession = (sid) => {
    if (sid.startsWith("mcp-") && state?.leases) {
      const migratedSessions = new Set(
        Object.values(state.leases)
          .filter((l) => l && l.state === "active" && l.mcpSessionId === sid && l.sessionId)
          .map((l) => l.sessionId),
      );
      if (migratedSessions.size === 1) {
        return [...migratedSessions][0];
      }
    }
    return sid;
  };

  const assertSingleHookSession = (entry) => {
    if (Array.isArray(entry?.seenSessions) && entry.seenSessions.length > 1) {
      const err = new Error(
        `Multiple active agent sessions detected in ${cwd}; pass --session <unique_id> or ATC_SESSION_ID explicitly.`,
      );
      err.code = "EAMBIGUOUS_SESSION";
      throw err;
    }
  };

  const resolveFromHookSessions = () => {
    if (!state?.hookSessions) return null;
    const direct = state.hookSessions[String(ppid)];
    if (direct && SESSION_ID_REGEX.test(direct.sessionId)) {
      assertSingleHookSession(direct);
      return {
        sessionId: direct.sessionId,
        anchorPid: Number(direct.agentPid || explicitAnchor || ppid),
        source: "hook_ppid",
      };
    }
    const ancestors = ancestorPids || ancestorPidCache.get(Number(ppid)) || [Number(ppid)];
    for (const ancPid of ancestors) {
      const ancMatch = state.hookSessions[String(ancPid)];
      if (ancMatch && SESSION_ID_REGEX.test(ancMatch.sessionId)) {
        assertSingleHookSession(ancMatch);
        return {
          sessionId: ancMatch.sessionId,
          anchorPid: Number(ancMatch.agentPid || explicitAnchor || ancPid),
          source: "hook_ancestor_pid",
        };
      }
    }
    const cwdMatches = Object.values(state.hookSessions).filter((h) => h && h.cwd === cwd);
    if (cwdMatches.length === 1 && SESSION_ID_REGEX.test(cwdMatches[0].sessionId)) {
      assertSingleHookSession(cwdMatches[0]);
      return {
        sessionId: cwdMatches[0].sessionId,
        anchorPid: Number(cwdMatches[0].agentPid || explicitAnchor || stablePpid),
        source: "hook_cwd",
      };
    }
    if (cwdMatches.length > 1) {
      const ancestorSet = new Set(ancestors.map(Number));
      const ancestorCwdMatches = cwdMatches.filter((h) => ancestorSet.has(Number(h.agentPid)));
      if (
        ancestorCwdMatches.length === 1 &&
        SESSION_ID_REGEX.test(ancestorCwdMatches[0].sessionId)
      ) {
        assertSingleHookSession(ancestorCwdMatches[0]);
        return {
          sessionId: ancestorCwdMatches[0].sessionId,
          anchorPid: Number(ancestorCwdMatches[0].agentPid || explicitAnchor || stablePpid),
          source: "hook_cwd_ancestor",
        };
      }
      const err = new Error(
        `Multiple active agent sessions detected in ${cwd}; pass --session <unique_id> or ATC_SESSION_ID explicitly.`,
      );
      err.code = "EAMBIGUOUS_SESSION";
      throw err;
    }
    return null;
  };

  const explicitSessionFlag = flags.session || flags.role;
  if (explicitSessionFlag) {
    const sid = resolveMigratedMcpSession(validateSessionId(explicitSessionFlag));
    return {
      sessionId: sid,
      anchorPid: findHookAnchorForSession(sid),
      source: "flag",
    };
  }
  if (env.ATC_SESSION_ID) {
    const sid = resolveMigratedMcpSession(validateSessionId(env.ATC_SESSION_ID));
    return {
      sessionId: sid,
      anchorPid: findHookAnchorForSession(sid),
      source: "env_atc",
    };
  }
  if (flags.lease || env.ATC_LEASE_ID) {
    const leaseId = flags.lease || env.ATC_LEASE_ID;
    if (state?.leases) {
      const found = Object.values(state.leases).find((l) => l.leaseId === leaseId);
      if (found) {
        return {
          sessionId: found.sessionId,
          anchorPid: found.anchorPid || explicitAnchor || stablePpid,
          source: "lease_token",
        };
      }
    }
  }

  const hostEnvKeys = [
    "CODEX_SESSION_ID",
    "PI_SESSION_ID",
    "CURSOR_TRACE_ID",
    "CURSOR_SESSION_ID",
    "ANTIGRAVITY_CONVERSATION_ID",
    "GEMINI_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "COPILOT_SESSION_ID",
    "GITHUB_COPILOT_SESSION_ID",
    "CONVERSATION_ID",
  ];
  for (const key of hostEnvKeys) {
    const val = env[key]?.trim();
    if (val && SESSION_ID_REGEX.test(val)) {
      return {
        sessionId: val,
        anchorPid: findHookAnchorForSession(val),
        source: `env_${key.toLowerCase()}`,
      };
    }
  }

  const hookResolved = resolveFromHookSessions();
  if (hookResolved) {
    return hookResolved;
  }

  if (env.ATC_MCP_DEFAULT_SESSION_ID) {
    const sid = resolveMigratedMcpSession(validateSessionId(env.ATC_MCP_DEFAULT_SESSION_ID));
    return {
      sessionId: sid,
      anchorPid: findHookAnchorForSession(sid),
      source: "env_atc",
    };
  }

  const termKey = env.TMUX_PANE || env.TERM_SESSION_ID;
  if (termKey) {
    const sanitized = termKey.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96);
    const sid = validateSessionId(`term-${sanitized}`);
    return {
      sessionId: sid,
      anchorPid: findHookAnchorForSession(sid) || stablePpid,
      source: "terminal_env",
    };
  }

  return {
    sessionId: validateSessionId(`ppid-${stablePpid}`),
    anchorPid: explicitAnchor || stablePpid,
    source: "ppid_fallback",
  };
}
