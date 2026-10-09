import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPidAlive,
  randomNonce,
  verifyLockOwnership,
  withLock,
  writeFileAtomic,
} from "./lock.mjs";

const ancestorPidCache = new Map();

export function getAncestorPids(startPid = process.ppid) {
  const numericStart = Number(startPid);
  if (!Number.isInteger(numericStart) || numericStart <= 0) {
    return [];
  }
  if (ancestorPidCache.has(numericStart)) {
    return ancestorPidCache.get(numericStart);
  }
  const ancestors = [numericStart];
  if (process.platform === "linux" && fs.existsSync(`/proc/${numericStart}/status`)) {
    let cur = numericStart;
    for (let depth = 0; depth < 16; depth++) {
      try {
        const statusText = fs.readFileSync(`/proc/${cur}/status`, "utf8");
        const m = statusText.match(/^PPid:\s*(\d+)/m);
        const parent = m ? Number(m[1]) : 0;
        if (!parent || parent <= 1 || ancestors.includes(parent)) break;
        ancestors.push(parent);
        cur = parent;
      } catch {
        break;
      }
    }
  } else if (process.platform !== "win32") {
    try {
      const res = spawnSync("ps", ["-Ao", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 1500,
      });
      if (res.status === 0 && res.stdout) {
        const parentMap = new Map();
        for (const raw of res.stdout.split(/\r?\n/)) {
          const m = raw.trim().match(/^(\d+)\s+(\d+)$/);
          if (m) {
            parentMap.set(Number(m[1]), Number(m[2]));
          }
        }
        let cur = numericStart;
        for (let depth = 0; depth < 16; depth++) {
          const parent = parentMap.get(cur);
          if (!parent || parent <= 1 || ancestors.includes(parent)) break;
          ancestors.push(parent);
          cur = parent;
        }
      }
    } catch {
      // Ignore ps lookup error
    }
  }
  ancestorPidCache.set(numericStart, ancestors);
  return ancestors;
}

export const DEFAULT_CONFIG = Object.freeze({
  maxRunningEmulators: 2,
  minFreeRamMb: 2048,
  minFreeDiskMb: 2048,
  qemuOverheadRamMb: 1024,
  defaultTtlSec: 600,
  maxTtlSec: 3600,
  defaultWaitSec: 300,
  reorderWindowSec: 120,
  queueHeartbeatTimeoutSec: 10,
  bootTimeoutSec: 180,
  stopTimeoutSec: 60,
  offlineGraceMs: 5000,
  autoStopIdleOnContention: true,
  allowPhysicalDevices: "explicit",
  allowedPhysicalSerials: [],
});

export function createDefaultState() {
  return {
    version: 1,
    config: structuredClone(DEFAULT_CONFIG),
    leases: {},
    queue: [],
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

export function readState(stateDir) {
  const statePath = path.join(stateDir, "state.json");
  if (!fs.existsSync(statePath)) {
    return createDefaultState();
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!validateTopLevelState(parsed)) {
      throw new Error("Invalid state.json top-level schema");
    }
    parsed.config = { ...DEFAULT_CONFIG, ...parsed.config };
    return parsed;
  } catch (err) {
    const corruptPath = path.join(stateDir, `state.json.corrupt.${Date.now()}`);
    try {
      fs.renameSync(statePath, corruptPath);
      process.stderr.write(
        `[atc] Quarantined corrupt state.json to ${corruptPath} (${err.message})\n`,
      );
    } catch {
      // Ignore rename error
    }
    return createDefaultState();
  }
}

export function commitState(stateDir, state, lockHandle) {
  if (!verifyLockOwnership(lockHandle)) {
    throw new Error("Lock ownership nonce lost before state.json commit; aborting write");
  }
  const statePath = path.join(stateDir, "state.json");
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n", lockHandle.nonce);
}

export function sweepOrphanFiles(stateDir, now = Date.now()) {
  try {
    const entries = fs.readdirSync(stateDir);
    for (const name of entries) {
      if (!name.startsWith("state.json.tmp.") && !name.startsWith("atc.lock.stale.")) {
        continue;
      }
      const fullPath = path.join(stateDir, name);
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

export function runGarbageCollection(state, stateDir, now = Date.now(), livenessCheck = isPidAlive) {
  const pruned = {
    leases: [],
    queue: [],
    hookSessions: [],
  };
  const cfg = state.config || DEFAULT_CONFIG;
  const maxTtlMs = (cfg.maxTtlSec || 3600) * 1000;
  const hbTimeoutMs = (cfg.queueHeartbeatTimeoutSec || 10) * 1000;

  for (const [deviceKey, lease] of Object.entries(state.leases)) {
    if (!lease || typeof lease !== "object") {
      delete state.leases[deviceKey];
      continue;
    }
    if (lease.state === "active") {
      const lastRenewedMs =
        typeof lease.renewedAtMs === "number" ? lease.renewedAtMs : lease.claimedAtMs;
      const expired =
        now >= lease.expiresAtMs ||
        now < lease.claimedAtMs ||
        (typeof lastRenewedMs === "number" && now > lastRenewedMs + maxTtlMs);
      const deadAnchor =
        lease.anchorPid !== null &&
        lease.anchorPid !== undefined &&
        !livenessCheck(lease.anchorPid);
      if (expired || deadAnchor) {
        pruned.leases.push({
          deviceKey,
          leaseId: lease.leaseId,
          reason: expired ? "expired" : "dead_anchor",
        });
        delete state.leases[deviceKey];
      }
    } else if (lease.state === "starting" || lease.state === "stopping") {
      const deadWorker = !lease.workerPid || !livenessCheck(lease.workerPid);
      const pastDeadline =
        (typeof lease.deadlineMs === "number" && now >= lease.deadlineMs) ||
        (typeof lease.claimedAtMs === "number" && now < lease.claimedAtMs);
      if (deadWorker || pastDeadline) {
        pruned.leases.push({
          deviceKey,
          leaseId: lease.leaseId,
          reason: deadWorker ? "dead_worker" : "deadline_exceeded",
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

  if (stateDir && (!state.lastOrphanSweepAtMs || now - state.lastOrphanSweepAtMs > 60_000)) {
    state.lastOrphanSweepAtMs = now;
    sweepOrphanFiles(stateDir, now);
  }

  return pruned;
}

export function reconcileOfflineLeases(state, inventory, callerSessionId, now = Date.now()) {
  if (!inventory) return;
  const graceMs = state.config?.offlineGraceMs ?? 5000;
  const probes = inventory.probes || { emulatorListOk: true, adbDevicesOk: true };
  const emulatorListOk = probes.emulatorListOk !== false;
  const adbDevicesOk = probes.adbDevicesOk !== false;
  const onlineAvds = new Set(
    (inventory.running || []).filter((d) => d.kind === "emulator").map((d) => d.avd),
  );
  const onlineSerials = new Set([
    ...(inventory.running || []).map((d) => d.serial).filter(Boolean),
    ...(inventory.onlineSerials || []).filter(Boolean),
  ]);

  for (const [deviceKey, lease] of Object.entries(state.leases)) {
    if (!lease.avd && lease.kind === "emulator" && lease.serial) {
      const mappedDev = (inventory.running || []).find(
        (d) => d.kind === "emulator" && d.serial === lease.serial && d.avd,
      );
      if (mappedDev && mappedDev.deviceKey && mappedDev.deviceKey !== deviceKey) {
        delete state.leases[deviceKey];
        lease.avd = mappedDev.avd;
        lease.deviceKey = mappedDev.deviceKey;
        lease.profile = mappedDev.profile || lease.profile;
        state.leases[mappedDev.deviceKey] = lease;
      }
    }
    if (lease.state !== "active") continue;
    if (lease.kind === "physical") {
      const serialOnline = Boolean(lease.serial && onlineSerials.has(lease.serial));
      if (serialOnline) {
        lease.firstSeenOfflineAtMs = null;
        continue;
      }
      if (!adbDevicesOk) {
        continue;
      }
    } else {
      const avdOnline = Boolean(lease.avd && onlineAvds.has(lease.avd));
      const serialOnline = Boolean(lease.serial && onlineSerials.has(lease.serial));
      if (avdOnline || serialOnline) {
        lease.firstSeenOfflineAtMs = null;
        continue;
      }
      if (!emulatorListOk || !adbDevicesOk) {
        continue;
      }
    }

    if (lease.sessionId === callerSessionId) {
      delete state.leases[deviceKey];
      continue;
    }
    if (!lease.firstSeenOfflineAtMs) {
      lease.firstSeenOfflineAtMs = now;
    } else if (now - lease.firstSeenOfflineAtMs >= graceMs) {
      delete state.leases[deviceKey];
    }
  }
}

export function withStateTransaction(stateDir, fn, options = {}) {
  // Pre-warm ancestor PID cache strictly outside atc.lock so resolveSessionIdentity never spawns subprocesses under lock
  if (!options.ancestorPids) {
    getAncestorPids(options.ppid ?? process.ppid);
  }
  return withLock(
    stateDir,
    (lockHandle) => {
      const now = options.now ?? Date.now();
      const state = readState(stateDir);
      const pruned = runGarbageCollection(state, stateDir, now, options.livenessCheck);
      const result = fn(state, { now, pruned, lockHandle });
      if (result && result.mutated !== false) {
        commitState(stateDir, state, lockHandle);
      }
      return result?.value !== undefined ? result.value : result;
    },
    options.lockTimeoutMs,
  );
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

export function matchesProfile(device, req = {}) {
  const requestedKind = req.kind || (req.serial && !req.serial.startsWith("emulator-") ? "any" : "emulator");
  if (requestedKind !== "any" && device.kind !== requestedKind) {
    return false;
  }
  if (req.avd && device.avd !== req.avd) {
    return false;
  }
  if (req.serial && device.serial !== req.serial) {
    return false;
  }
  if (req.deviceType) {
    const want = req.deviceType.toLowerCase();
    const actual = (device.profile?.deviceType || "").toLowerCase();
    if (actual !== want) {
      const resizableCompatible = ["phone", "foldable", "tablet", "desktop"].includes(want);
      if (!(actual === "resizable" && resizableCompatible)) {
        return false;
      }
    }
  }
  if (req.apiSpec && !matchesApiSpec(device.profile?.apiLevel, req.apiSpec)) {
    return false;
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

export function computeUsedEmulatorSlots(state, inventory = {}) {
  const runningOrStopping = new Set();
  const serialToLeasedAvd = new Map();
  for (const lease of Object.values(state.leases || {})) {
    if (lease.kind === "emulator" && lease.serial && lease.avd) {
      serialToLeasedAvd.set(lease.serial, lease.avd);
    }
  }
  for (const dev of inventory.running || []) {
    if (dev.kind === "emulator") {
      const key = dev.avd || serialToLeasedAvd.get(dev.serial) || (dev.serial ? `serial:${dev.serial}` : null);
      if (key) {
        runningOrStopping.add(key);
      }
    }
  }
  for (const lease of Object.values(state.leases || {})) {
    if (
      lease.kind === "emulator" &&
      (lease.state === "stopping" || lease.state === "active") &&
      lease.avd
    ) {
      runningOrStopping.add(lease.avd);
    }
  }
  let startingExtra = 0;
  for (const lease of Object.values(state.leases)) {
    if (lease.kind === "emulator" && lease.state === "starting") {
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
    kind: earlierTicket.requestedKind,
    avd: earlierTicket.requestedAvd,
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

export function resolveSessionIdentity({
  flags = {},
  env = process.env,
  state = null,
  cwd = process.cwd(),
  ppid = process.ppid,
  ancestorPids = null,
} = {}) {
  const explicitAnchor = env.ATC_ANCHOR_PID && /^\d+$/.test(env.ATC_ANCHOR_PID)
    ? Number(env.ATC_ANCHOR_PID)
    : null;

  const findHookAnchorForSession = (sid) => {
    if (explicitAnchor) return explicitAnchor;
    if (state?.hookSessions) {
      const matched = Object.values(state.hookSessions).find(
        (h) => h && h.sessionId === sid && h.agentPid,
      );
      if (matched) return Number(matched.agentPid);
    }
    return null;
  };

  const explicitSessionFlag = flags.session || flags.role;
  if (explicitSessionFlag) {
    const sid = validateSessionId(explicitSessionFlag);
    return {
      sessionId: sid,
      anchorPid: findHookAnchorForSession(sid),
      source: "flag",
    };
  }
  if (env.ATC_SESSION_ID) {
    const sid = validateSessionId(env.ATC_SESSION_ID);
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
          anchorPid: found.anchorPid || explicitAnchor || ppid,
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

  if (state?.hookSessions) {
    const direct = state.hookSessions[String(ppid)];
    if (direct && SESSION_ID_REGEX.test(direct.sessionId)) {
      return {
        sessionId: direct.sessionId,
        anchorPid: Number(direct.agentPid || ppid),
        source: "hook_ppid",
      };
    }
    const ancestors = ancestorPids || ancestorPidCache.get(Number(ppid)) || [Number(ppid)];
    for (const ancPid of ancestors) {
      const ancMatch = state.hookSessions[String(ancPid)];
      if (ancMatch && SESSION_ID_REGEX.test(ancMatch.sessionId)) {
        return {
          sessionId: ancMatch.sessionId,
          anchorPid: Number(ancMatch.agentPid || ancPid),
          source: "hook_ancestor_pid",
        };
      }
    }
    const cwdMatches = Object.values(state.hookSessions).filter((h) => h && h.cwd === cwd);
    if (cwdMatches.length === 1 && SESSION_ID_REGEX.test(cwdMatches[0].sessionId)) {
      return {
        sessionId: cwdMatches[0].sessionId,
        anchorPid: Number(cwdMatches[0].agentPid || ppid),
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
        return {
          sessionId: ancestorCwdMatches[0].sessionId,
          anchorPid: Number(ancestorCwdMatches[0].agentPid || ppid),
          source: "hook_cwd_ancestor",
        };
      }
      const err = new Error(
        `Multiple active agent sessions detected in ${cwd}; pass --session <unique_id> or ATC_SESSION_ID explicitly.`,
      );
      err.code = "EAMBIGUOUS_SESSION";
      throw err;
    }
  }

  const termKey = env.TMUX_PANE || env.TERM_SESSION_ID;
  if (termKey) {
    const sanitized = termKey.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96);
    const sid = validateSessionId(`term-${sanitized}`);
    return {
      sessionId: sid,
      anchorPid: findHookAnchorForSession(sid) || ppid,
      source: "terminal_env",
    };
  }

  return {
    sessionId: validateSessionId(`ppid-${ppid}`),
    anchorPid: explicitAnchor || ppid,
    source: "ppid_fallback",
  };
}
