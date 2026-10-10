import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  ResourceError,
  checkResourceAdmission,
  deterministicCreatedAvdId,
  discoverFleet,
  isAndroidEmulatorCliUnavailable,
  parseAdbDevicesOutput,
  parseAndroidEmulatorListOutput,
  readFreeDiskMb,
  readHostResources,
  readLocalAvdMetadata,
  resolveAvdHome,
  wipeAvdUserData,
} from "./android.mjs";
import { classifySegment, evaluateCommandGuard, splitShellSegments } from "./guard.mjs";
import { GUIDE_TOPICS, cmdGuide } from "./guide.mjs";
import { handlePreToolUseHook, handleStopHook, readStdinSync } from "./hook.mjs";
import {
  isPidAlive,
  randomNonce,
  resolveStateDir,
  sleepSync,
  withLock,
} from "./lock.mjs";
import { startMcpServer } from "./mcp.mjs";
import { buildChildInvocation, runCommandSync, spawnWithHeartbeat } from "./spawn.mjs";
import {
  DEFAULT_CONFIG,
  addLeaseWorker,
  avdHasRuntimeLockFiles,
  canJumpAhead,
  computeEffectiveMaxEmulators,
  computeUsedEmulatorSlots,
  hasAliveProcessInGroup,
  isTicketStarvationProtected,
  killProcessGroupTree,
  matchesProfile,
  offlineAvdHasRuntimeLockFiles,
  readState,
  reconcileOfflineLeases,
  recordDeviceBootedInState,
  recordDeviceStoppedInState,
  removeLeaseWorker,
  resolveSessionIdentity,
  resolveStableParentPid,
  snapshotProcessGroupsOutsideLock,
  syncLeaseWorkers,
  withStateTransaction,
} from "./state.mjs";

export const ATC_VERSION = "1.0.0";
export { GUIDE_TOPICS, cmdGuide };

function parseBoolFlag(val) {
  if (val === undefined || val === null) return false;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (s === "false" || s === "0" || s === "no" || s === "off" || s === "") {
    return false;
  }
  return true;
}

const BOOLEAN_FLAG_KEYS = new Set([
  "createIfMissing",
  "wipeData",
  "cold",
  "headless",
  "force",
  "stop",
  "shutdown",
  "json",
  "help",
  "version",
  "play",
]);

const COMMON_ALLOWED_FLAGS = new Set([
  "session",
  "role",
  "lease",
  "anchorPid",
  "json",
  "help",
  "h",
  "version",
  "v",
]);

const CLAIM_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "kind",
  "avd",
  "serial",
  "type",
  "api",
  "services",
  "play",
  "abi",
  "createIfMissing",
  "snapshotLoad",
  "snapshotSaveOnFree",
  "wipeData",
  "cold",
  "resetApp",
  "headless",
  "force",
  "reason",
  "ttl",
  "ttlSec",
  "wait",
  "waitSec",
  "reorderWindow",
  "reorderWindowSec",
]);

const FREE_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "target",
  "snapshotSave",
  "snapshotLoad",
  "stop",
  "shutdown",
  "force",
]);

const RENEW_ALLOWED_FLAGS = new Set([...COMMON_ALLOWED_FLAGS, "target", "ttl", "ttlSec"]);

const SNAPSHOT_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "action",
  "name",
  "avd",
  "serial",
  "force",
]);

const EXEC_ALLOWED_FLAGS = new Set([...COMMON_ALLOWED_FLAGS, "serial"]);

const STATUS_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "kind",
  "type",
  "api",
  "services",
  "play",
  "abi",
]);

const GUARD_ALLOWED_FLAGS = new Set([...COMMON_ALLOWED_FLAGS, "format"]);

const GUIDE_ALLOWED_FLAGS = new Set([...COMMON_ALLOWED_FLAGS, "topic"]);

function camelToFlagName(key) {
  if (key.length === 1) return `-${key}`;
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function validateCommandFlags(flags, allowedSet, subcommand) {
  if (!flags || typeof flags !== "object") return null;
  const selfValidatedKeys = new Set([
    "ttl",
    "ttlSec",
    "wait",
    "waitSec",
    "reorderWindow",
    "reorderWindowSec",
    "target",
    "snapshotSave",
    "snapshotLoad",
    "snapshotSaveOnFree",
    "resetApp",
  ]);
  for (const [key, val] of Object.entries(flags)) {
    if (val === undefined) continue;
    if (!allowedSet.has(key)) {
      return `Unknown option "${camelToFlagName(key)}" for "atc ${subcommand}".`;
    }
    if (
      !BOOLEAN_FLAG_KEYS.has(key) &&
      key !== "h" &&
      !selfValidatedKeys.has(key) &&
      typeof val === "boolean"
    ) {
      return `Option "${camelToFlagName(key)}" requires a value.`;
    }
  }
  return null;
}

export function parseCliArgs(argv) {
  const args = [...argv];
  const dashDashIdx = args.indexOf("--");
  let restAfterDash = [];
  let mainArgs = args;
  if (dashDashIdx !== -1) {
    mainArgs = args.slice(0, dashDashIdx);
    restAfterDash = args.slice(dashDashIdx + 1);
  }

  const positionals = [];
  const flags = {};

  for (let i = 0; i < mainArgs.length; i++) {
    const tok = mainArgs[i];
    if (!tok.startsWith("-")) {
      positionals.push(tok);
      continue;
    }
    if (tok === "--play") {
      flags.play = true;
      continue;
    }
    if (tok === "--no-play") {
      flags.play = false;
      continue;
    }
    if (
      [
        "--create-if-missing",
        "--wipe-data",
        "--cold",
        "--headless",
        "--force",
        "--stop",
        "--shutdown",
        "--json",
        "--help",
        "-h",
      ].includes(tok)
    ) {
      const camel = tok
        .replace(/^-+/, "")
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[camel] = true;
      continue;
    }
    const eqIdx = tok.indexOf("=");
    if (eqIdx !== -1) {
      const key = tok
        .slice(0, eqIdx)
        .replace(/^-+/, "")
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const rawVal = tok.slice(eqIdx + 1);
      flags[key] = BOOLEAN_FLAG_KEYS.has(key) ? parseBoolFlag(rawVal) : rawVal;
      continue;
    }
    const key = tok
      .replace(/^-+/, "")
      .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (i + 1 < mainArgs.length && !mainArgs[i + 1].startsWith("-")) {
      flags[key] = mainArgs[++i];
    } else {
      flags[key] = true;
    }
  }

  return {
    subcommand: positionals[0] || "help",
    positionals: positionals.slice(1),
    flags,
    restAfterDash,
  };
}

function clearDeviceStoppedInState(state, deviceInfo) {
  if (!state?.stoppedDevices || !deviceInfo) return;
  if (deviceInfo.deviceKey) delete state.stoppedDevices[deviceInfo.deviceKey];
  if (deviceInfo.avd) delete state.stoppedDevices[`avd:${deviceInfo.avd}`];
  if (deviceInfo.serial) delete state.stoppedDevices[`serial:${deviceInfo.serial}`];
}

function markStoppingAwaitOfflineReconcile(state, targetLease, now, deadlineMs) {
  if (!state || !targetLease) return;
  state.fleetEpoch = (state.fleetEpoch || 0) + 1;
  targetLease.state = "stopping";
  targetLease.awaitOfflineReconcile = true;
  targetLease.stoppingAtMs = now;
  targetLease.reconcileAfterMs = now;
  targetLease.stoppingEpoch = state.fleetEpoch;
  targetLease.deadlineMs = deadlineMs;
}

function clampTtlSec(rawTtl, cfg = DEFAULT_CONFIG) {
  const def = cfg.defaultTtlSec ?? 600;
  const max = cfg.maxTtlSec ?? 3600;
  const n =
    rawTtl !== undefined &&
    rawTtl !== null &&
    typeof rawTtl !== "boolean" &&
    !(typeof rawTtl === "string" && !rawTtl.trim())
      ? Number(rawTtl)
      : def;
  if (!Number.isFinite(n)) return def;
  return Math.max(10, Math.min(max, Math.round(n)));
}

function findLeaseEntry(state, deviceKey, leaseId) {
  if (deviceKey && state.leases?.[deviceKey]?.leaseId === leaseId) {
    return { key: deviceKey, lease: state.leases[deviceKey] };
  }
  for (const [k, l] of Object.entries(state.leases || {})) {
    if (l && l.leaseId === leaseId) {
      return { key: k, lease: l };
    }
  }
  return { key: null, lease: null };
}

function finishLeaseWorker(stateDir, deviceKey, leaseId, ttlMs, options = {}, onBeforeRelease = null) {
  const livenessCheck = options.livenessCheck || isPidAlive;
  const check = withStateTransaction(
    stateDir,
    (state, { now }) => {
      const { key: resolvedKey, lease: cur } = findLeaseEntry(state, deviceKey, leaseId);
      if (
        !cur ||
        cur.leaseId !== leaseId ||
        cur.state === "stopping" ||
        (cur.state === "starting" && cur.workerPid !== process.pid)
      ) {
        return { mutated: false, value: { lease: null, deferredFree: false } };
      }
      if (onBeforeRelease) {
        onBeforeRelease(cur, state, now);
      }
      const otherWorkers = removeLeaseWorker(cur, process.pid, livenessCheck);
      const needsRelease =
        otherWorkers.length === 0 &&
        (cur.releaseOnWorkerExit ||
          (cur.anchorPid !== null &&
            cur.anchorPid !== undefined &&
            !livenessCheck(cur.anchorPid)));
      const hasPendingCleanup =
        cur.kind === "emulator" &&
        Boolean(
          cur.saveSnapshotOnFree ||
            cur.pendingSnapshotSave ||
            cur.pendingSnapshotLoad ||
            cur.pendingStop,
        );
      if (needsRelease) {
        if (!hasPendingCleanup) {
          delete state.leases[resolvedKey];
          return { mutated: true, value: { lease: { ...cur }, deferredFree: false } };
        }
        // Keep process.pid registered until cmdFree transitions the lease to "stopping"
        // so runGarbageCollection does not prune the lease before deferred cleanup executes.
        addLeaseWorker(cur, process.pid, livenessCheck);
        cur.renewedAtMs = now;
        cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + ttlMs);
        return {
          mutated: true,
          value: {
            lease: { ...cur },
            deferredFree: true,
          },
        };
      }
      if (cur.renewedAtMs !== now) {
        cur.renewedAtMs = now;
        cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + ttlMs);
      }
      return { mutated: true, value: { lease: { ...cur }, deferredFree: false } };
    },
    options,
  );

  if (check?.deferredFree) {
    const freeRes = cmdFree(stateDir, leaseId, {}, { ...options, callerWorkerPid: process.pid });
    withStateTransaction(
      stateDir,
      (state, { now }) => {
        const { lease: cur } = findLeaseEntry(state, deviceKey, leaseId);
        if (cur && cur.leaseId === leaseId) {
          removeLeaseWorker(cur, process.pid, livenessCheck);
          if (freeRes.exitCode !== 0) {
            cur.releaseOnWorkerExit = false;
            if (
              cur.anchorPid !== null &&
              cur.anchorPid !== undefined &&
              !livenessCheck(cur.anchorPid)
            ) {
              cur.anchorPid = null;
            }
            cur.renewedAtMs = now;
            cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + ttlMs);
          }
          return { mutated: true };
        }
        return { mutated: false };
      },
      options,
    );
  }
  return check?.lease || null;
}

function startWorkerDeadlineHeartbeat(stateDir, deviceKey, leaseId, timeoutMs) {
  const stopFlag = new Int32Array(new SharedArrayBuffer(12));
  const workerUrl = new URL("./heartbeat.mjs", import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: {
      stateDir,
      deviceKey,
      leaseId,
      timeoutMs,
      workerPid: process.pid,
      stopFlag,
    },
  });
  worker.on("error", () => {
    Atomics.store(stopFlag, 1, 0);
    Atomics.notify(stopFlag, 1);
    Atomics.store(stopFlag, 2, 1);
    Atomics.notify(stopFlag, 2);
  });
  worker.on("exit", () => {
    Atomics.store(stopFlag, 1, 0);
    Atomics.notify(stopFlag, 1);
    Atomics.store(stopFlag, 2, 1);
    Atomics.notify(stopFlag, 2);
  });
  if (typeof worker.unref === "function") {
    worker.unref();
  }
  Atomics.wait(stopFlag, 2, 0, 2000);
  return {
    stop() {
      Atomics.store(stopFlag, 0, 1);
      Atomics.notify(stopFlag, 0);
      while (Atomics.load(stopFlag, 1) !== 0) {
        Atomics.wait(stopFlag, 1, 1, 25);
      }
    },
  };
}

function waitForEmulatorReady(runner, serial, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const propRes = runner(
      "adb",
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      {
        strictInternal: true,
        timeoutMs: Math.min(5000, Math.max(1000, deadline - Date.now())),
      },
    );
    if (propRes.status === 0) {
      const out = String(propRes.stdout || "").trim();
      if (out === "1") {
        return true;
      }
    }
    if (Date.now() + 250 >= deadline) break;
    sleepSync(250);
  }
  throw new Error(`Timed out waiting for emulator ${serial} to finish restoring snapshot.`);
}

function waitForEmulatorOffline(runner, avdHome, { serial, avd }, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let resolvedAvd = avd || null;
  while (Date.now() < deadline) {
    const remainingForListMs = deadline - Date.now();
    if (remainingForListMs <= 0) break;
    const listRes = runner("android", ["emulator", "list", "--long"], {
      timeoutMs: Math.min(4000, Math.max(500, remainingForListMs)),
    });
    let emulatorListOk = listRes.status === 0;
    const listedAvds =
      emulatorListOk && listRes.stdout
        ? parseAndroidEmulatorListOutput(listRes.stdout)
        : [];
    if (!emulatorListOk && isAndroidEmulatorCliUnavailable(listRes, "win32")) {
      const remSdkMs = deadline - Date.now();
      if (remSdkMs > 0) {
        const sdkListRes = runner("emulator", ["-list-avds"], {
          timeoutMs: Math.min(4000, Math.max(500, remSdkMs)),
        });
        if (sdkListRes.status === 0) {
          emulatorListOk = true;
        }
      }
    }
    for (const item of listedAvds) {
      if (!resolvedAvd && serial && item.serial === serial && item.avd) {
        resolvedAvd = item.avd;
      }
    }

    const remainingForAdbMs = deadline - Date.now();
    if (remainingForAdbMs <= 0) break;
    const adbRes = runner("adb", ["devices"], {
      timeoutMs: Math.min(4000, Math.max(500, remainingForAdbMs)),
    });
    const adbDevicesOk = adbRes.status === 0;
    const adbDevices =
      adbDevicesOk && adbRes.stdout ? parseAdbDevicesOutput(adbRes.stdout) : [];

    const probesOk = Boolean(adbDevicesOk && emulatorListOk);
    const mappedAvdForSerial = serial
      ? listedAvds.find((item) => item.online && item.serial === serial)
      : null;
    const serialReassignedToOtherAvd = Boolean(
      mappedAvdForSerial &&
        resolvedAvd &&
        mappedAvdForSerial.avd &&
        mappedAvdForSerial.avd !== resolvedAvd,
    );
    const avdStillOnline = Boolean(
      listedAvds.some(
        (item) =>
          item.online &&
          ((resolvedAvd && item.avd === resolvedAvd) ||
            (serial && !serialReassignedToOtherAvd && item.serial === serial)),
      ),
    );
    const serialStillOnline = Boolean(
      serial &&
        !serialReassignedToOtherAvd &&
        adbDevices.some((dev) => dev.serial === serial),
    );
    if (!resolvedAvd && serial && serialStillOnline) {
      const remMs = deadline - Date.now();
      if (remMs > 0) {
        const nameRes = runner("adb", ["-s", serial, "emu", "avd", "name"], {
          timeoutMs: Math.min(2000, Math.max(500, remMs)),
        });
        const avdId =
          nameRes.status === 0 && nameRes.stdout
            ? nameRes.stdout.split(/\r?\n/)[0].trim()
            : "";
        if (avdId && avdId !== "OK") {
          resolvedAvd = avdId;
        }
      }
    }
    let unmappedOnlineEmulatorMatchesAvd = false;
    if (!serial && resolvedAvd && !avdStillOnline && !serialStillOnline && adbDevicesOk) {
      const mappedSerials = new Set(
        listedAvds.map((item) => item.serial).filter(Boolean),
      );
      for (const dev of adbDevices) {
        if (dev.kind !== "emulator" || !dev.serial || mappedSerials.has(dev.serial)) {
          continue;
        }
        const remMs = deadline - Date.now();
        if (remMs <= 0) {
          unmappedOnlineEmulatorMatchesAvd = true;
          break;
        }
        const nameRes = runner("adb", ["-s", dev.serial, "emu", "avd", "name"], {
          timeoutMs: Math.min(2000, Math.max(500, remMs)),
        });
        const avdId =
          nameRes.status === 0 && nameRes.stdout
            ? nameRes.stdout.split(/\r?\n/)[0].trim()
            : "";
        if (!avdId || avdId === "OK" || avdId === resolvedAvd) {
          unmappedOnlineEmulatorMatchesAvd = true;
          break;
        }
      }
    }
    const stillRunning =
      !probesOk ||
      avdStillOnline ||
      serialStillOnline ||
      unmappedOnlineEmulatorMatchesAvd;
    let hasLockFiles = false;
    if (avdHome) {
      if (resolvedAvd) {
        hasLockFiles = avdHasRuntimeLockFiles(resolvedAvd, avdHome);
      } else {
        const onlineListedAvds = new Set(
          listedAvds.filter((item) => item.online && item.avd).map((item) => item.avd),
        );
        hasLockFiles = offlineAvdHasRuntimeLockFiles(avdHome, onlineListedAvds);
      }
    }
    if (!stillRunning && !hasLockFiles && Date.now() <= deadline) {
      return resolvedAvd || true;
    }
    if (Date.now() + 250 >= deadline) break;
    sleepSync(250);
  }
  const timeoutErr = new Error(
    `Timed out waiting for emulator ${resolvedAvd || serial} to shut down.`,
  );
  timeoutErr.resolvedAvd = resolvedAvd;
  throw timeoutErr;
}

export function selectCandidateUnderLock(
  state,
  inventory,
  req,
  callerTicket,
  now = Date.now(),
  callerSessionId = callerTicket?.sessionId || null,
  livenessCheck = isPidAlive,
) {
  const cfg = state.config || DEFAULT_CONFIG;
  const effectiveMax = computeEffectiveMaxEmulators(cfg, inventory.host);
  const usedSlots = computeUsedEmulatorSlots(state, inventory);
  const getOccupyingLease = (d) =>
    state.leases[d.deviceKey] ||
    (d.serial
      ? Object.values(state.leases || {}).find((l) => l.serial === d.serial)
      : null) ||
    (d.avd
      ? Object.values(state.leases || {}).find((l) => l.avd === d.avd)
      : null) ||
    null;
  const isDeviceOccupied = (d) => Boolean(getOccupyingLease(d));
  const isCallerOwnedResettable = (d) => {
    if (!callerSessionId) return false;
    const l = getOccupyingLease(d);
    if (!l || l.state !== "active" || l.sessionId !== callerSessionId) return false;
    if (syncLeaseWorkers(l, livenessCheck).length > 0) return false;
    return Boolean(!l.serial || req.wipeData || req.coldBoot);
  };

  const earlierTickets = [];
  for (const t of state.queue) {
    if (callerTicket && t.ticketId === callerTicket.ticketId) break;
    if (callerTicket && t.sessionId === callerTicket.sessionId) break;
    earlierTickets.push(t);
  }

  const pseudoCandidateTicket = callerTicket || {
    enqueuedAtMs: now,
    requestedKind: req.kind || "emulator",
    requestedAvd: req.avd || null,
    requestedSerial: req.serial || null,
    requestedProfile: req,
  };

  function matchesCreatableEntry(c, targetReq) {
    if (targetReq.snapshotLoad) {
      return false;
    }
    const p = c.profile || c;
    const profileName = c.deviceName || p.deviceName;
    if (
      targetReq.avd &&
      c.avd !== targetReq.avd &&
      profileName !== targetReq.avd &&
      String(profileName || "").toLowerCase() !== String(targetReq.avd).toLowerCase()
    ) {
      return false;
    }
    return matchesProfile(
      { kind: "emulator", avd: targetReq.avd || c.avd || profileName, profile: p },
      targetReq,
    );
  }

  function doesTicketNeedEmulatorCapacity(earlierReq) {
    if (earlierReq.kind === "physical") return false;
    const hasOfflineMatch = (inventory.offline || []).some(
      (d) => !isDeviceOccupied(d) && matchesProfile(d, earlierReq),
    );
    if (hasOfflineMatch) return true;
    const hasStoppingMatch = Object.values(state.leases || {}).some(
      (l) => l.kind === "emulator" && l.state === "stopping" && matchesProfile(l, earlierReq),
    );
    if (hasStoppingMatch) return true;
    if (
      (earlierReq.wipeData || earlierReq.coldBoot) &&
      (inventory.running || []).some(
        (d) => d.kind === "emulator" && !isDeviceOccupied(d) && matchesProfile(d, earlierReq),
      )
    ) {
      return true;
    }
    if (earlierReq.createIfMissing) {
      const anyExisting = [
        ...(inventory.running || []),
        ...(inventory.offline || []),
        ...Object.values(state.leases || {}),
      ].some((d) => d.kind === "emulator" && matchesProfile(d, earlierReq));
      if (
        !anyExisting &&
        (inventory.creatable || []).some((c) => matchesCreatableEntry(c, earlierReq))
      ) {
        return true;
      }
    }
    return false;
  }

  function isReservedForEarlierTicket(device, isColdOrEvict = false) {
    for (const earlier of earlierTickets) {
      const earlierReq = {
        kind: earlier.requestedKind || "emulator",
        avd: earlier.requestedAvd || null,
        serial: earlier.requestedSerial || null,
        ...earlier.requestedProfile,
      };
      const canUseCandidate = Boolean(device?.kind) && matchesProfile(device, earlierReq);
      const needsEmulatorCapacity =
        device?.kind !== "physical" &&
        (isColdOrEvict || cfg.autoStopIdleOnContention !== false) &&
        doesTicketNeedEmulatorCapacity(earlierReq);
      if (!canUseCandidate && !needsEmulatorCapacity) {
        continue;
      }
      if (isTicketStarvationProtected(earlier, now, cfg)) {
        return true;
      }
      if (isColdOrEvict) {
        return true;
      }
      if (!canJumpAhead(pseudoCandidateTicket, earlier, device, now, cfg)) {
        return true;
      }
    }
    return false;
  }

  // Priority 1: Tier 0 Warm Idle Match
  if (!req.wipeData && !req.coldBoot) {
    const hasUnmappedStartingEmulator = Object.values(state.leases || {}).some(
      (l) => l.kind === "emulator" && l.state === "starting" && !l.serial,
    );
    const warmCandidates = (inventory.running || []).filter(
      (d) =>
        !isDeviceOccupied(d) &&
        !(d.kind === "emulator" && !d.avd && hasUnmappedStartingEmulator) &&
        matchesProfile(d, req),
    );
    for (const dev of warmCandidates) {
      if (!isReservedForEarlierTicket(dev, false)) {
        return {
          priority: 1,
          tier: 0,
          candidate: dev,
          needsWarmPrep: Boolean(req.snapshotLoad || req.resetApp),
        };
      }
    }
  }

  // Physical devices only match in Tier 0
  if (req.kind === "physical") {
    return { priority: null, usedSlots, effectiveMax };
  }

  // Priority 2: Tier 1 Boot Into Free Slot (or reboot running match for wipeData/coldBoot)
  // If any running emulator could not be mapped to its AVD name, or if discovery probes failed,
  // fail closed on offline AVD launches/wipes so ATC never boots or wipes an AVD that is already running.
  const hasUnmappedRunningEmulator = (inventory.running || []).some(
    (d) => d.kind === "emulator" && !d.avd,
  );
  const discoveryProbesFailed = Boolean(
    inventory.probes &&
      (inventory.probes.adbDevicesOk === false || inventory.probes.emulatorListOk === false),
  );
  const safeOfflineCandidates =
    hasUnmappedRunningEmulator || discoveryProbesFailed
      ? []
      : (inventory.offline || []).filter(
          (d) =>
            !d.hasLockFiles &&
            !(inventory.avdHome && d.avd && avdHasRuntimeLockFiles(d.avd, inventory.avdHome)),
        );
  const bootPool = [
    ...(req.wipeData || req.coldBoot
      ? (inventory.running || []).filter((d) => d.kind === "emulator" && d.avd)
      : []),
    ...safeOfflineCandidates,
  ]
    .filter((d) => (!isDeviceOccupied(d) || isCallerOwnedResettable(d)) && matchesProfile(d, req))
    .sort((a, b) => Number(isCallerOwnedResettable(b)) - Number(isCallerOwnedResettable(a)));

  let firstResourceErr = null;

  for (const dev of bootPool) {
    const callerOwnedResettable = isCallerOwnedResettable(dev);
    const slotAvailable = dev.online || callerOwnedResettable || usedSlots < effectiveMax;
    if (!slotAvailable) continue;
    if (!callerOwnedResettable && isReservedForEarlierTicket(dev, true)) continue;
    try {
      checkResourceAdmission(dev, inventory.host, state, inventory, {
        replacingAvd: dev.online ? dev : null,
        wipeOrCreate: Boolean(req.wipeData),
        force: Boolean(req.force),
        now,
      });
      return {
        priority: 2,
        tier: 1,
        candidate: dev,
      };
    } catch (err) {
      if (err instanceof ResourceError && !firstResourceErr) {
        firstResourceErr = err;
      }
    }
  }

  // Priority 3: Tier 2 Evict Idle Running Emulator
  if (cfg.autoStopIdleOnContention !== false && bootPool.length > 0) {
    const idleRunningEmulators = (inventory.running || []).filter(
      (d) =>
        d.kind === "emulator" &&
        d.avd &&
        !isDeviceOccupied(d) &&
        !isReservedForEarlierTicket(d, true),
    );

    for (const victim of idleRunningEmulators) {
      for (const dev of bootPool) {
        if (dev.deviceKey === victim.deviceKey) continue;
        if (isReservedForEarlierTicket(dev, true)) continue;
        try {
          checkResourceAdmission(dev, inventory.host, state, inventory, {
            replacingAvd: victim,
            wipeOrCreate: Boolean(req.wipeData),
            force: Boolean(req.force),
            now,
          });
          return {
            priority: 3,
            tier: 2,
            candidate: dev,
            victim,
          };
        } catch (err) {
          if (err instanceof ResourceError && !firstResourceErr) {
            firstResourceErr = err;
          }
        }
      }
    }
  }

  // Priority 4: Auto-create missing AVD (--create-if-missing)
  const anyExistingMatch = [
    ...(inventory.running || []),
    ...(inventory.offline || []),
    ...Object.values(state.leases || {}),
  ].some((d) => d.kind === "emulator" && matchesProfile(d, req));

  if (req.createIfMissing && !anyExistingMatch && usedSlots < effectiveMax) {
    const creatablePool = (inventory.creatable || []).filter((c) => matchesCreatableEntry(c, req));
    if (creatablePool.length > 0) {
      const matchedCreatable = creatablePool[0];
      const baseProfile = matchedCreatable.profile || matchedCreatable;
      const profileName = matchedCreatable.deviceName || baseProfile.deviceName || "pixel_9";
      const avdId = req.avd || matchedCreatable.avd || profileName || deterministicCreatedAvdId(req);
      const deviceKey = `avd:${avdId}`;
      const syntheticCandidate = {
        avd: avdId,
        deviceKey,
        kind: "emulator",
        online: false,
        ramSizeMb: 2048,
        requiredRamMb: 2048 + (cfg.qemuOverheadRamMb ?? 1024),
        dataDiskMb: 6656,
        freeDiskMb: inventory.host?.freeDiskMb,
        fsDev: inventory.host?.fsDev ?? null,
        profile: {
          deviceType: baseProfile.deviceType || req.deviceType || "phone",
          deviceName: profileName,
          apiLevel:
            baseProfile.apiLevel ||
            (req.apiSpec
              ? `android-${String(req.apiSpec).replace(/\D/g, "") || "36"}`
              : "android-36"),
          services:
            baseProfile.services || req.services || (req.play === false ? "aosp" : "play"),
          playStore:
            typeof baseProfile.playStore === "boolean"
              ? baseProfile.playStore
              : req.play !== false,
          abi: baseProfile.abi || req.abi || (process.arch === "arm64" ? "arm64-v8a" : "x86_64"),
        },
      };
      if (!state.leases[deviceKey] && !isReservedForEarlierTicket(syntheticCandidate, true)) {
        try {
          checkResourceAdmission(syntheticCandidate, inventory.host, state, inventory, {
            wipeOrCreate: true,
            force: Boolean(req.force),
            now,
          });
          return {
            priority: 4,
            tier: 1,
            candidate: syntheticCandidate,
            createAvd: true,
          };
        } catch (err) {
          if (err instanceof ResourceError && !firstResourceErr) {
            firstResourceErr = err;
          }
        }
      }
    }
  }

  // Hard Resource Failure vs Queue Wait: if usedSlots === 0 and resource check failed
  if (firstResourceErr && usedSlots === 0) {
    throw firstResourceErr;
  }

  return { priority: null, usedSlots, effectiveMax };
}

export function cmdClaim(stateDir, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, CLAIM_ALLOWED_FLAGS, "claim");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr };
  }
  const runner = options.runner || runCommandSync;
  const req = {
    kind: flags.kind || (flags.serial && !String(flags.serial).startsWith("emulator-") ? "any" : "emulator"),
    avd: flags.avd || null,
    serial: flags.serial || null,
    deviceType: flags.type || null,
    apiSpec: flags.api ? String(flags.api) : null,
    services: flags.services || null,
    play: flags.play === undefined || flags.play === null ? null : parseBoolFlag(flags.play),
    abi: flags.abi || null,
    createIfMissing: parseBoolFlag(flags.createIfMissing),
    snapshotLoad: flags.snapshotLoad || null,
    snapshotSaveOnFree: flags.snapshotSaveOnFree || null,
    wipeData: parseBoolFlag(flags.wipeData),
    coldBoot: parseBoolFlag(flags.cold),
    resetApp: flags.resetApp || null,
    headless: parseBoolFlag(flags.headless),
    force: parseBoolFlag(flags.force),
    reason: flags.reason || null,
  };

  if (
    flags.snapshotLoad !== undefined &&
    flags.snapshotLoad !== null &&
    (typeof flags.snapshotLoad !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(flags.snapshotLoad))
  ) {
    return {
      exitCode: 1,
      error: `Invalid snapshot name "${flags.snapshotLoad}". Must match /^[A-Za-z0-9._-]{1,64}$/.`,
    };
  }
  if (
    flags.snapshotSaveOnFree !== undefined &&
    flags.snapshotSaveOnFree !== null &&
    (typeof flags.snapshotSaveOnFree !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(flags.snapshotSaveOnFree))
  ) {
    return {
      exitCode: 1,
      error: `Invalid snapshot name "${flags.snapshotSaveOnFree}". Must match /^[A-Za-z0-9._-]{1,64}$/.`,
    };
  }
  if (
    flags.resetApp !== undefined &&
    flags.resetApp !== null &&
    (typeof flags.resetApp !== "string" || !/^[A-Za-z0-9._]{1,128}$/.test(flags.resetApp))
  ) {
    return {
      exitCode: 1,
      error: `Invalid package name "${flags.resetApp}" for --reset-app.`,
    };
  }
  const rawWait = flags.wait ?? flags.waitSec;
  const rawReorderWindow = flags.reorderWindow ?? flags.reorderWindowSec;
  const rawTtl = flags.ttl ?? flags.ttlSec;

  if (rawWait !== undefined && rawWait !== null) {
    const parsedWait =
      typeof rawWait === "boolean" || (typeof rawWait === "string" && !rawWait.trim())
        ? Number.NaN
        : Number(rawWait);
    if (!Number.isFinite(parsedWait) || parsedWait < 0) {
      return {
        exitCode: 1,
        error: `Invalid --wait duration "${rawWait}". Expected a non-negative number of seconds.`,
      };
    }
  }
  if (rawReorderWindow !== undefined && rawReorderWindow !== null) {
    const rw =
      typeof rawReorderWindow === "boolean" ||
      (typeof rawReorderWindow === "string" && !rawReorderWindow.trim())
        ? Number.NaN
        : Number(rawReorderWindow);
    if (!Number.isFinite(rw) || rw < 0) {
      return {
        exitCode: 1,
        error: `Invalid --reorder-window duration "${rawReorderWindow}". Expected a non-negative number of seconds.`,
      };
    }
  }
  if (rawTtl !== undefined && rawTtl !== null) {
    const parsedTtl =
      typeof rawTtl === "boolean" || (typeof rawTtl === "string" && !rawTtl.trim())
        ? Number.NaN
        : Number(rawTtl);
    if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
      return {
        exitCode: 1,
        error: `Invalid --ttl duration "${rawTtl}". Expected a positive number of seconds.`,
      };
    }
  }
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);
  const initialState = readState(stateDir);
  const initialCfg = initialState.config || DEFAULT_CONFIG;
  let inventoryEpoch = initialState.fleetEpoch || 0;
  let discoveryStartedAtMs = Date.now();
  let rawInventory =
    options.inventory ||
    discoverFleet({ runner, avdHome, cfg: initialCfg, platform: options.platform });
  let inventory = options.inventory
    ? rawInventory
    : {
        ...rawInventory,
        discoveredAtMs: rawInventory.discoveredAtMs ?? discoveryStartedAtMs,
        fleetEpoch: rawInventory.fleetEpoch ?? inventoryEpoch,
      };
  const startWaitMs = Date.now();
  let retainedTicketTiming = null;
  const heartbeatQueuedTicket = () => {
    if (!retainedTicketTiming?.ticketId) return;
    try {
      withStateTransaction(
        stateDir,
        (state, { now }) => {
          const t = (state.queue || []).find((q) => q.ticketId === retainedTicketTiming.ticketId);
          if (!t) return { mutated: false };
          t.lastHeartbeatAtMs = now;
          t.waiterPid = process.pid;
          return { mutated: true };
        },
        options,
      );
    } catch {
      // Best-effort queue heartbeat during discovery
    }
  };

  while (true) {
    let txOutcome;
    try {
      txOutcome = withStateTransaction(stateDir, (state, { now }) => {
        const invEpoch = inventory.fleetEpoch ?? inventoryEpoch;
        const stoppedMap = state.stoppedDevices || {};
        const bootedMap = state.bootedDevices || {};
        const isStoppedSinceInventory = (d) => {
          if (!d || d.kind === "physical") return false;
          const byKey = d.deviceKey ? stoppedMap[d.deviceKey] : null;
          const byAvd = d.avd ? stoppedMap[`avd:${d.avd}`] : null;
          const bySerial = d.serial ? stoppedMap[`serial:${d.serial}`] : null;
          return Boolean(
            (byKey && byKey.epoch > invEpoch) ||
              (byAvd && byAvd.epoch > invEpoch) ||
              (bySerial && bySerial.epoch > invEpoch),
          );
        };
        const staleRunning = (inventory.running || []).filter(isStoppedSinceInventory);
        const staleBootedByKey = new Map();
        for (const entry of Object.values(bootedMap)) {
          if (!entry || !(entry.epoch > invEpoch)) continue;
          if (isStoppedSinceInventory(entry)) continue;
          const alreadyRunning = (inventory.running || []).some(
            (d) =>
              d.kind === "emulator" &&
              (!entry.serial || d.serial === entry.serial) &&
              ((entry.deviceKey && d.deviceKey === entry.deviceKey) ||
                (entry.avd && d.avd === entry.avd) ||
                (entry.serial && d.serial === entry.serial)),
          );
          if (alreadyRunning) continue;
          const dedupKey =
            entry.avd ? `avd:${entry.avd}` : entry.deviceKey || `serial:${entry.serial}`;
          const prev = staleBootedByKey.get(dedupKey);
          if (!prev || entry.epoch > prev.epoch) {
            staleBootedByKey.set(dedupKey, entry);
          }
        }
        const staleBooted = Array.from(staleBootedByKey.values());
        const staleStopping = Object.values(state.leases || {}).some(
          (l) =>
            l &&
            l.state === "stopping" &&
            l.awaitOfflineReconcile &&
            (l.stoppingEpoch || 0) > invEpoch,
        );
        const epochAdvanced = (state.fleetEpoch || 0) > invEpoch;
        if (
          (epochAdvanced ||
            staleRunning.length > 0 ||
            staleBooted.length > 0 ||
            staleStopping) &&
          !options.inventory
        ) {
          return {
            mutated: false,
            value: { status: "stale_inventory" },
          };
        }
        let effectiveInventory = inventory;
        if (staleRunning.length > 0 || staleBooted.length > 0) {
          let nextRunning = (inventory.running || []).filter((d) => !isStoppedSinceInventory(d));
          let nextOffline = [...(inventory.offline || [])];
          for (const d of staleRunning) {
            if (d.avd && !nextOffline.some((o) => o.avd === d.avd || o.deviceKey === d.deviceKey)) {
              nextOffline.push({
                ...d,
                deviceKey: `avd:${d.avd}`,
                serial: null,
                online: false,
              });
            }
          }
          for (const b of staleBooted) {
            const runningMatch = nextRunning.find(
              (r) =>
                (b.avd && r.avd === b.avd) ||
                (b.deviceKey && r.deviceKey === b.deviceKey) ||
                (b.serial && r.serial === b.serial),
            );
            nextRunning = nextRunning.filter(
              (r) =>
                !(
                  (b.avd && r.avd === b.avd) ||
                  (b.deviceKey && r.deviceKey === b.deviceKey) ||
                  (b.serial && r.serial === b.serial)
                ),
            );
            const offlineMatch = nextOffline.find(
              (o) =>
                (b.avd && o.avd === b.avd) || (b.deviceKey && o.deviceKey === b.deviceKey),
            );
            nextOffline = nextOffline.filter(
              (o) =>
                !(
                  (b.avd && o.avd === b.avd) ||
                  (b.deviceKey && o.deviceKey === b.deviceKey)
                ),
            );
            const baseMatch = offlineMatch || runningMatch || {};
            nextRunning.push({
              ...baseMatch,
              deviceKey:
                b.deviceKey ||
                baseMatch.deviceKey ||
                (b.avd ? `avd:${b.avd}` : `serial:${b.serial}`),
              kind: "emulator",
              avd: b.avd || baseMatch.avd || null,
              serial: b.serial || null,
              online: true,
              profile: b.profile || baseMatch.profile || {},
              ramSizeMb: b.ramSizeMb || baseMatch.ramSizeMb || 2048,
              requiredRamMb:
                b.requiredRamMb ||
                baseMatch.requiredRamMb ||
                2048 + (state.config?.qemuOverheadRamMb ?? 1024),
            });
          }
          effectiveInventory = {
            ...inventory,
            running: nextRunning,
            offline: nextOffline,
          };
        }

        const waitSec =
          rawWait !== undefined
            ? Number(rawWait)
            : (state.config?.defaultWaitSec ?? DEFAULT_CONFIG.defaultWaitSec);
        const identity = resolveSessionIdentity({
          flags,
          env: options.env || process.env,
          state,
          cwd: options.cwd || process.cwd(),
          ppid: options.ppid ?? process.ppid,
          ancestorPids: options.ancestorPids,
          processChain: options.processChain,
        });
        const ttlSec = clampTtlSec(rawTtl, state.config);
        const ttlMs = ttlSec * 1000;

        let reconciledMutated = reconcileOfflineLeases(
          state,
          effectiveInventory,
          identity.sessionId,
          now,
          options.livenessCheck || isPidAlive,
          avdHome,
        );

        // Step 3: Idempotent Re-Claim (Same Session)
        for (const lease of Object.values(state.leases)) {
          if (isStoppedSinceInventory(lease)) {
            continue;
          }
          const invDev = (effectiveInventory.running || []).find(
            (d) =>
              d.deviceKey === lease.deviceKey ||
              (d.avd && d.avd === lease.avd) ||
              (d.serial && d.serial === lease.serial),
          );
          const candidateForMatch = invDev
            ? { ...invDev, ...lease, snapshots: invDev.snapshots }
            : lease;
          if (
            lease.state === "active" &&
            Boolean(lease.serial) &&
            lease.sessionId === identity.sessionId &&
            matchesProfile(candidateForMatch, { ...req, snapshotLoad: null }) &&
            (!req.snapshotLoad ||
              (lease.kind === "emulator" &&
                (lease.loadedSnapshot === req.snapshotLoad ||
                  !Array.isArray(candidateForMatch.snapshots) ||
                  candidateForMatch.snapshots.includes(req.snapshotLoad)))) &&
            !req.wipeData &&
            !req.coldBoot
          ) {
            const needsSnapLoad = Boolean(
              req.snapshotLoad && lease.loadedSnapshot !== req.snapshotLoad,
            );
            const needsPrep = Boolean(req.resetApp || needsSnapLoad);
            const stopTimeoutMs = (state.config?.stopTimeoutSec || 60) * 1000;
            const livenessCheck = options.livenessCheck || isPidAlive;
            const activeWorkers = syncLeaseWorkers(lease, livenessCheck).filter(
              (p) => p !== process.pid,
            );
            if (needsPrep && activeWorkers.length > 0) {
              lease.renewedAtMs = now;
              lease.expiresAtMs = Math.max(lease.expiresAtMs || 0, now + ttlMs);
              continue;
            }
            if (needsPrep) {
              addLeaseWorker(lease, process.pid, livenessCheck);
              lease.workerPid = process.pid;
              lease.state = "starting";
              lease.deadlineMs = now + stopTimeoutMs;
            }
            lease.releaseOnWorkerExit = false;
            delete lease.pendingSnapshotSave;
            delete lease.pendingSnapshotLoad;
            delete lease.pendingStop;
            lease.renewedAtMs = now;
            lease.expiresAtMs = Math.max(
              rawTtl !== undefined ? 0 : lease.expiresAtMs || 0,
              now + ttlMs,
              needsPrep ? now + stopTimeoutMs * 2 : 0,
            );
            if (req.snapshotSaveOnFree) {
              lease.saveSnapshotOnFree = req.snapshotSaveOnFree;
            }
            if (req.reason) {
              lease.reason = req.reason;
            }
            return {
              mutated: true,
              value: {
                status: "claimed_immediate",
                lease,
                idempotent: true,
                needsPrep,
                needsSnapLoad,
                stopTimeoutMs,
              },
            };
          }
        }

            const reorderWindowMs =
              (rawReorderWindow !== undefined
                ? Number(rawReorderWindow)
                : (state.config?.reorderWindowSec ?? DEFAULT_CONFIG.reorderWindowSec ?? 120)) *
              1000;
            const waitExpiresAtMs = startWaitMs + waitSec * 1000;
            let existingTicket =
              state.queue.find((t) => t.sessionId === identity.sessionId) || null;
            if (!existingTicket && retainedTicketTiming && waitSec > 0 && now < waitExpiresAtMs) {
              existingTicket = {
                ticketId: retainedTicketTiming.ticketId || `q_${randomNonce().slice(0, 12)}`,
                sessionId: identity.sessionId,
                waiterPid: process.pid,
                requestedKind: req.kind,
                requestedAvd: req.avd,
                requestedSerial: req.serial,
                requestedProfile: req,
                enqueuedAtMs: retainedTicketTiming.enqueuedAtMs,
                starvationDeadlineMs: retainedTicketTiming.starvationDeadlineMs,
                queueSeq: retainedTicketTiming.queueSeq,
                lastHeartbeatAtMs: now,
                waitExpiresAtMs,
                reason: req.reason,
              };
              state.queue.push(existingTicket);
              state.queue.sort(
                (a, b) =>
                  (a.enqueuedAtMs ?? 0) - (b.enqueuedAtMs ?? 0) ||
                  (a.queueSeq ?? Number.MAX_SAFE_INTEGER) -
                    (b.queueSeq ?? Number.MAX_SAFE_INTEGER),
              );
              reconciledMutated = true;
            }
            const selection = selectCandidateUnderLock(
              state,
              effectiveInventory,
              req,
              existingTicket,
              now,
              identity.sessionId,
              options.livenessCheck || isPidAlive,
            );

            if (selection.priority === 1 && !selection.needsWarmPrep) {
              const dev = selection.candidate;
              const leaseId = `lease_${randomNonce().slice(0, 12)}`;
              const lease = {
                leaseId,
                deviceKey: dev.deviceKey,
                kind: dev.kind,
                avd: dev.avd || null,
                serial: dev.serial,
                profile: dev.profile,
                sessionId: identity.sessionId,
                anchorPid: identity.anchorPid,
                parentPid: resolveStableParentPid(
                  options.ppid ?? process.ppid,
                  options.processChain,
                ),
                state: "active",
                workerPid: null,
                replacingAvd: null,
                requiredRamMb: dev.requiredRamMb || 0,
                fsDev: dev.fsDev ?? effectiveInventory.host?.fsDev ?? null,
                avdPath: dev.avdPath || null,
                loadedSnapshot: req.snapshotLoad || null,
                saveSnapshotOnFree: req.snapshotSaveOnFree || null,
                claimedAtMs: now,
                activatedAtMs: now,
                activatedEpoch: state.fleetEpoch || 0,
                renewedAtMs: now,
                expiresAtMs: now + ttlMs,
                deadlineMs: null,
                firstSeenOfflineAtMs: null,
                reason: req.reason,
              };
              state.leases[dev.deviceKey] = lease;
              state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);
              return {
                mutated: true,
                value: { status: "claimed_immediate", lease, idempotent: false },
              };
            }

            if (selection.priority !== null) {
              const dev = selection.candidate;
              const existingOwnLease =
                state.leases[dev.deviceKey]?.sessionId === identity.sessionId &&
                state.leases[dev.deviceKey]?.state === "active"
                  ? { ...state.leases[dev.deviceKey] }
                  : null;
              const leaseId = existingOwnLease?.leaseId || `lease_${randomNonce().slice(0, 12)}`;
              const bootTimeoutMs = (state.config.bootTimeoutSec || 180) * 1000;
              const stopTimeoutMs = (state.config.stopTimeoutSec || 60) * 1000;
              let victimLeaseId = null;

              const overheadMb = state.config?.qemuOverheadRamMb ?? 1024;
              const computeRequiredRam = (d) =>
                typeof d.ramSizeMb === "number" && d.ramSizeMb > 0
                  ? d.ramSizeMb + overheadMb
                  : d.requiredRamMb || 2048 + overheadMb;

              if (selection.victim) {
                victimLeaseId = `lease_${randomNonce().slice(0, 12)}`;
                state.leases[selection.victim.deviceKey] = {
                  leaseId: victimLeaseId,
                  deviceKey: selection.victim.deviceKey,
                  kind: "emulator",
                  avd: selection.victim.avd,
                  serial: selection.victim.serial,
                  profile: selection.victim.profile,
                  sessionId: identity.sessionId,
                  anchorPid: identity.anchorPid,
                  state: "stopping",
                  workerPid: process.pid,
                  replacingAvd: null,
                  requiredRamMb: computeRequiredRam(selection.victim),
                  fsDev: selection.victim.fsDev ?? effectiveInventory.host?.fsDev ?? null,
                  avdPath: selection.victim.avdPath || null,
                  claimedAtMs: now,
                  deadlineMs: now + stopTimeoutMs,
                };
              }

              const startingLease = {
                leaseId,
                deviceKey: dev.deviceKey,
                kind: dev.kind,
                avd: dev.avd,
                serial: dev.serial || null,
                profile: dev.profile,
                sessionId: identity.sessionId,
                anchorPid: identity.anchorPid,
                parentPid: resolveStableParentPid(
                  options.ppid ?? process.ppid,
                  options.processChain,
                ),
                state: "starting",
                workerPid: process.pid,
                replacingAvd: selection.victim ? selection.victim.avd : null,
                requiredRamMb: computeRequiredRam(dev),
                requiredDiskMb:
                  Boolean(req.wipeData) || Boolean(selection.createAvd)
                    ? dev.dataDiskMb || 6656
                    : dev.ramSizeMb || 2048,
                fsDev: dev.fsDev ?? effectiveInventory.host?.fsDev ?? null,
                avdPath: dev.avdPath || null,
                loadedSnapshot: req.resetApp ? null : req.snapshotLoad || null,
                saveSnapshotOnFree:
                  req.snapshotSaveOnFree || existingOwnLease?.saveSnapshotOnFree || null,
                claimedAtMs: existingOwnLease?.claimedAtMs || now,
                activatedAtMs: null,
                renewedAtMs: now,
                expiresAtMs: Math.max(
                  rawTtl !== undefined ? 0 : existingOwnLease?.expiresAtMs || 0,
                  now + ttlMs,
                ),
                deadlineMs: now + bootTimeoutMs,
                firstSeenOfflineAtMs: null,
                reason: req.reason || existingOwnLease?.reason || null,
              };
              state.leases[dev.deviceKey] = startingLease;
              state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);

              const knownAvdNames = new Set(
                [...(effectiveInventory.running || []), ...(effectiveInventory.offline || [])]
                  .filter((d) => d.kind === "emulator" && d.avd)
                  .map((d) => d.avd),
              );

              return {
                mutated: true,
                value: {
                  status: "needs_boot_or_prep",
                  lease: startingLease,
                  previousLease: existingOwnLease,
                  hasExplicitTtl: rawTtl !== undefined,
                  selection,
                  victimLeaseId,
                  ttlMs,
                  bootTimeoutMs,
                  stopTimeoutMs,
                  knownAvdNames,
                },
              };
            }

            // No candidate available right now
            if (waitSec <= 0) {
              return {
                mutated: reconciledMutated,
                value: { status: "busy" },
              };
            }

            if (now >= waitExpiresAtMs) {
              state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);
              return {
                mutated: true,
                value: { status: "busy" },
              };
            }

            let ticket = existingTicket;
            if (!ticket) {
              const enqueuedAtMs = retainedTicketTiming ? retainedTicketTiming.enqueuedAtMs : now;
              const starvationDeadlineMs = retainedTicketTiming
                ? retainedTicketTiming.starvationDeadlineMs
                : enqueuedAtMs + reorderWindowMs;
              const queueSeq =
                retainedTicketTiming?.queueSeq ??
                ((state.nextQueueSeq = (state.nextQueueSeq || 0) + 1));
              const ticketId = retainedTicketTiming?.ticketId || `q_${randomNonce().slice(0, 12)}`;
              ticket = {
                ticketId,
                sessionId: identity.sessionId,
                waiterPid: process.pid,
                requestedKind: req.kind,
                requestedAvd: req.avd,
                requestedSerial: req.serial,
                requestedProfile: req,
                enqueuedAtMs,
                starvationDeadlineMs,
                queueSeq,
                lastHeartbeatAtMs: now,
                waitExpiresAtMs,
                reason: req.reason,
              };
              retainedTicketTiming = { ticketId, enqueuedAtMs, starvationDeadlineMs, queueSeq };
              state.queue.push(ticket);
              state.queue.sort(
                (a, b) =>
                  (a.enqueuedAtMs ?? 0) - (b.enqueuedAtMs ?? 0) ||
                  (a.queueSeq ?? Number.MAX_SAFE_INTEGER) -
                    (b.queueSeq ?? Number.MAX_SAFE_INTEGER),
              );
            } else {
              retainedTicketTiming = {
                ticketId: ticket.ticketId,
                enqueuedAtMs: ticket.enqueuedAtMs,
                starvationDeadlineMs: ticket.starvationDeadlineMs,
                queueSeq:
                  ticket.queueSeq ??
                  ((ticket.queueSeq = state.nextQueueSeq = (state.nextQueueSeq || 0) + 1)),
              };
              ticket.lastHeartbeatAtMs = now;
              ticket.waiterPid = process.pid;
            }

            const hbTimeoutSec =
              state.config?.queueHeartbeatTimeoutSec ?? DEFAULT_CONFIG.queueHeartbeatTimeoutSec ?? 10;
            return {
              mutated: true,
              value: { status: "queued", ticket, hbTimeoutSec },
            };
          }, options);
        } catch (err) {
          if (err instanceof ResourceError) {
            return { exitCode: err.exitCode, error: err.message };
          }
          return { exitCode: 1, error: err.message };
        }

        if (txOutcome.status === "stale_inventory") {
          const refreshedState = readState(stateDir);
          inventoryEpoch = refreshedState.fleetEpoch || 0;
          discoveryStartedAtMs = Date.now();
          rawInventory = discoverFleet({
            runner,
            avdHome,
            cfg: refreshedState.config || DEFAULT_CONFIG,
            platform: options.platform,
            onProgress: heartbeatQueuedTicket,
          });
      inventory = {
        ...rawInventory,
        discoveredAtMs: rawInventory.discoveredAtMs ?? discoveryStartedAtMs,
        fleetEpoch: rawInventory.fleetEpoch ?? inventoryEpoch,
      };
      continue;
    }

    if (txOutcome.status === "claimed_immediate") {
      if (txOutcome.idempotent && txOutcome.needsPrep && txOutcome.lease?.serial) {
        const snapTimeoutMs = txOutcome.stopTimeoutMs || 60_000;
        const prepHb = startWorkerDeadlineHeartbeat(
          stateDir,
          txOutcome.lease.deviceKey,
          txOutcome.lease.leaseId,
          snapTimeoutMs,
        );
        let loadedSnap = null;
        let prepUpdatedSnap = false;
        let prepError = null;
        const assertIdempotentPrepOwned = () => {
          const owned = withStateTransaction(
            stateDir,
            (state) => {
              const { lease: cur } = findLeaseEntry(
                state,
                txOutcome.lease.deviceKey,
                txOutcome.lease.leaseId,
              );
              return {
                mutated: false,
                value: Boolean(
                  cur &&
                    cur.leaseId === txOutcome.lease.leaseId &&
                    cur.state === "starting" &&
                    cur.workerPid === process.pid,
                ),
              };
            },
            options,
          );
          if (!owned) {
            throw new Error(
              `Lease reservation ${txOutcome.lease.leaseId} was lost during preparation.`,
            );
          }
        };
        try {
          if (txOutcome.needsSnapLoad && req.snapshotLoad) {
            assertIdempotentPrepOwned();
            const snapRes = runner(
              "adb",
              [
                "-s",
                txOutcome.lease.serial,
                "emu",
                "avd",
                "snapshot",
                "load",
                req.snapshotLoad,
              ],
              { strictInternal: true, timeoutMs: snapTimeoutMs },
            );
            if (snapRes.status !== 0) {
              loadedSnap = null;
              prepUpdatedSnap = true;
              prepError = `Failed to load snapshot "${req.snapshotLoad}" on ${txOutcome.lease.serial}: ${snapRes.stderr || snapRes.stdout}`;
            } else {
              try {
                assertIdempotentPrepOwned();
                waitForEmulatorReady(runner, txOutcome.lease.serial, snapTimeoutMs);
                loadedSnap = req.snapshotLoad;
                prepUpdatedSnap = true;
              } catch (err) {
                loadedSnap = null;
                prepUpdatedSnap = true;
                prepError = err.message;
              }
            }
          }
          if (!prepError && req.resetApp) {
            assertIdempotentPrepOwned();
            const resetRes = runner(
              "adb",
              ["-s", txOutcome.lease.serial, "shell", "pm", "clear", req.resetApp],
              { strictInternal: true },
            );
            if (resetRes.status !== 0) {
              prepError = `Failed to reset app "${req.resetApp}" on ${txOutcome.lease.serial}: ${resetRes.stderr || resetRes.stdout}`;
            } else {
              loadedSnap = null;
              prepUpdatedSnap = true;
            }
          }
        } catch (err) {
          prepError = err.message;
        } finally {
          prepHb.stop();
        }
        let releasedDuringPrep = false;
        const livenessCheck = options.livenessCheck || isPidAlive;
        const reactivated = finishLeaseWorker(
          stateDir,
          txOutcome.lease.deviceKey,
          txOutcome.lease.leaseId,
          clampTtlSec(rawTtl, DEFAULT_CONFIG) * 1000,
          options,
          (cur, state, now) => {
            const otherWorkers = (cur.workerPids || []).filter(
              (p) => p !== process.pid && livenessCheck(p),
            );
            releasedDuringPrep =
              otherWorkers.length === 0 &&
              Boolean(
                cur.releaseOnWorkerExit ||
                  (cur.anchorPid !== null &&
                    cur.anchorPid !== undefined &&
                    !livenessCheck(cur.anchorPid)),
              );
            cur.state = "active";
            cur.deadlineMs = null;
            if (prepUpdatedSnap) {
              cur.loadedSnapshot = loadedSnap;
              txOutcome.lease.loadedSnapshot = loadedSnap;
            }
            const ttlMs = clampTtlSec(rawTtl, state.config) * 1000;
            cur.renewedAtMs = now;
            cur.expiresAtMs =
              rawTtl !== undefined ? now + ttlMs : Math.max(cur.expiresAtMs || 0, now + ttlMs);
          },
        );
        if (prepError) {
          return { exitCode: 1, error: prepError };
        }
        if (!reactivated) {
          return {
            exitCode: 1,
            error: `Lease reservation ${txOutcome.lease.leaseId} was lost during preparation.`,
          };
        }
        if (releasedDuringPrep) {
          return {
            exitCode: 1,
            error: `Lease reservation ${txOutcome.lease.leaseId} was released during preparation.`,
          };
        }
        Object.assign(txOutcome.lease, reactivated);
      }
      return { exitCode: 0, lease: txOutcome.lease, idempotent: txOutcome.idempotent };
    }

    if (txOutcome.status === "busy") {
      return {
        exitCode: 2,
        error: "No matching Android device is currently available (wait timeout reached).",
      };
    }

    if (txOutcome.status === "needs_boot_or_prep") {
      return executeBootOrPrepOutsideLock(stateDir, txOutcome, req, {
        ...options,
        runner,
        avdHome,
        platform: options.platform,
      });
    }

    // Two-Stage Poll Loop (§5.3 Step 6)
    let tick = 0;
    let pollSleepCapMs = Math.max(100, Math.floor(((txOutcome.hbTimeoutSec || 10) * 1000) / 4));
    while (true) {
      const baseSleepMs = 900 + Math.floor(Math.random() * 200);
      sleepSync(Math.min(baseSleepMs, pollSleepCapMs));
      tick++;
      const stageA = withStateTransaction(stateDir, (state, { now }) => {
        const ticket = state.queue.find((t) => t.ticketId === txOutcome.ticket.ticketId);
        if (ticket) {
          ticket.lastHeartbeatAtMs = now;
        }
        const hbTimeoutSec =
          state.config?.queueHeartbeatTimeoutSec ?? DEFAULT_CONFIG.queueHeartbeatTimeoutSec ?? 10;
        const activeCount = Object.values(state.leases).length;
        return {
          mutated: Boolean(ticket),
          value: {
            activeCount,
            expired: now >= txOutcome.ticket.waitExpiresAtMs,
            hbTimeoutSec,
          },
        };
      });
      pollSleepCapMs = Math.max(100, Math.floor((stageA.hbTimeoutSec * 1000) / 4));
      if (stageA.expired) {
        break;
      }
      if (tick % 5 === 0 || stageA.activeCount === 0) {
        const curState = readState(stateDir);
        const curCfg = curState.config || DEFAULT_CONFIG;
        inventoryEpoch = curState.fleetEpoch || 0;
        discoveryStartedAtMs = Date.now();
        rawInventory =
          options.inventory ||
          discoverFleet({
            runner,
            avdHome,
            cfg: curCfg,
            platform: options.platform,
            onProgress: heartbeatQueuedTicket,
          });
        inventory = options.inventory
          ? rawInventory
          : {
              ...rawInventory,
              discoveredAtMs: rawInventory.discoveredAtMs ?? discoveryStartedAtMs,
              fleetEpoch: rawInventory.fleetEpoch ?? inventoryEpoch,
            };
        break;
      }
    }
  }
}

function executeBootOrPrepOutsideLock(stateDir, txOutcome, req, execOptions = {}) {
  const { runner, avdHome, platform } = execOptions;
  const {
    lease,
    previousLease,
    hasExplicitTtl,
    selection,
    victimLeaseId,
    ttlMs,
    bootTimeoutMs,
    stopTimeoutMs,
    knownAvdNames,
  } = txOutcome;
  const candidate = selection.candidate;
  const hbTimer = startWorkerDeadlineHeartbeat(
    stateDir,
    lease.deviceKey,
    lease.leaseId,
    bootTimeoutMs,
  );
  const victimHbTimer =
    selection.victim && victimLeaseId
      ? startWorkerDeadlineHeartbeat(
          stateDir,
          selection.victim.deviceKey,
          victimLeaseId,
          stopTimeoutMs || 60_000,
        )
      : null;
  let resolvedSerial = candidate.serial;
  let bootedNewEmulator = false;
  let partialBootNeedsStop = false;
  let stoppedExistingEmulator = false;
  let prepInvalidatedSnapshot = false;
  let prepLoadedSnapshot = null;
  let victimStopWaitTimedOut = false;
  let rebootStopWaitTimedOut = false;

  const isWin = (platform || process.platform) === "win32";
  const assertReservationStillOwned = () => {
    const targetSerial = resolvedSerial || candidate.serial || null;
    const targetAvd = candidate.avd || lease.avd || null;
    const status = withStateTransaction(stateDir, (state, { now }) => {
      const current = state.leases[lease.deviceKey];
      const owned = Boolean(
        current &&
          current.leaseId === lease.leaseId &&
          current.state === "starting" &&
          current.workerPid === process.pid,
      );
      if (!owned) {
        return { mutated: false, value: "lost" };
      }
      const conflictingLease = Object.values(state.leases || {}).find(
        (l) =>
          l &&
          l.leaseId !== lease.leaseId &&
          ((targetSerial && l.serial === targetSerial) ||
            (targetAvd && l.avd === targetAvd)),
      );
      if (conflictingLease) {
        return { mutated: false, value: "conflict" };
      }
      current.deadlineMs = Math.max(current.deadlineMs || 0, now + (bootTimeoutMs || 180_000));
      if (selection.victim && victimLeaseId) {
        const vLease = state.leases[selection.victim.deviceKey];
        if (vLease && vLease.leaseId === victimLeaseId && vLease.workerPid === process.pid) {
          vLease.deadlineMs = Math.max(
            vLease.deadlineMs || 0,
            now + (stopTimeoutMs || 60_000),
          );
        }
      }
      if (targetSerial && current.serial !== targetSerial) {
        current.serial = targetSerial;
      }
      return { mutated: true, value: "ok" };
    });
    if (status !== "ok") {
      throw new Error(`Lease reservation ${lease.leaseId} was lost during boot`);
    }
  };

  try {
    // 1. Evict victim if replacingAvd is set
    if (selection.victim) {
      assertReservationStillOwned();
      const effectiveStopTimeoutMs = stopTimeoutMs || 60_000;
      const stopRes =
        isWin && selection.victim.serial
          ? runner("adb", ["-s", selection.victim.serial, "emu", "kill"], {
              strictInternal: true,
              timeoutMs: effectiveStopTimeoutMs,
            })
          : runner(
              "android",
              ["emulator", "stop", selection.victim.serial || selection.victim.avd],
              { strictInternal: true, timeoutMs: effectiveStopTimeoutMs },
            );
      if (stopRes.status !== 0) {
        victimHbTimer?.stop();
        throw new Error(
          `Failed to stop idle victim emulator ${selection.victim.avd}: ${stopRes.stderr || stopRes.stdout}`,
        );
      }
      if (isWin && selection.victim.serial) {
        try {
          waitForEmulatorOffline(
            runner,
            avdHome,
            { serial: selection.victim.serial, avd: selection.victim.avd },
            effectiveStopTimeoutMs,
          );
        } catch (err) {
          victimStopWaitTimedOut = true;
          throw err;
        }
      }
      victimHbTimer?.stop();
      withStateTransaction(stateDir, (state, { now }) => {
        const vLease = state.leases[selection.victim.deviceKey];
        recordDeviceStoppedInState(state, selection.victim, now);
        if (vLease && vLease.leaseId === victimLeaseId) {
          delete state.leases[selection.victim.deviceKey];
        }
        return { mutated: true };
      });
    }

    // 2. Auto-create missing AVD if Priority 4
    if (selection.createAvd) {
      withLock(
        stateDir,
        () => {
          assertReservationStillOwned();
          const preCreateFleet = discoverFleet({ runner, avdHome });
          const preFleetAvds = new Set(
            [
              ...(preCreateFleet.offline || []),
              ...(preCreateFleet.running || []),
            ]
              .filter((d) => d.kind === "emulator" && d.avd)
              .map((d) => d.avd),
          );
          const preCreateState = readState(stateDir);
          const leasedByOthers = new Set(
            Object.values(preCreateState.leases || {})
              .filter((l) => l && l.leaseId !== lease.leaseId && l.avd)
              .map((l) => l.avd),
          );

          const createRes = runner(
            "android",
            ["emulator", "create", candidate.profile.deviceName],
            { strictInternal: true, timeoutMs: bootTimeoutMs || 180_000 },
          );
          if (createRes.status !== 0) {
            throw new Error(
              `Failed to create AVD for profile ${candidate.profile.deviceName}: ${createRes.stderr || createRes.stdout}`,
            );
          }

          const postCreateFleet = discoverFleet({ runner, avdHome });
          const allPostAvds = [
            ...(postCreateFleet.offline || []),
            ...(postCreateFleet.running || []),
          ].filter((d) => d.kind === "emulator" && d.avd);

          const postCreateState = readState(stateDir);
          for (const l of Object.values(postCreateState.leases || {})) {
            if (l && l.leaseId !== lease.leaseId && l.avd) {
              leasedByOthers.add(l.avd);
            }
          }
          const strictBaseline = new Set([
            ...(knownAvdNames || []),
            ...preFleetAvds,
            ...leasedByOthers,
          ]);

          let stdoutAvdName = null;
          if (createRes.stdout) {
            const m =
              createRes.stdout.match(/Created AVD\s+['"]?([A-Za-z0-9._-]+)['"]?/i) ||
              createRes.stdout.trim().match(/^([A-Za-z0-9._-]+)$/);
            if (m) {
              stdoutAvdName = m[1];
            }
          }

          const reqWithoutAvd = { ...req, avd: null };
          const newlyCreated =
            allPostAvds.find(
              (d) => !strictBaseline.has(d.avd) && matchesProfile(d, reqWithoutAvd),
            ) ||
            allPostAvds.find((d) => !strictBaseline.has(d.avd)) ||
            (stdoutAvdName && !leasedByOthers.has(stdoutAvdName)
              ? allPostAvds.find((d) => d.avd === stdoutAvdName)
              : null);

          let createdAvdName = newlyCreated?.avd || stdoutAvdName || candidate.avd;

          if (
            newlyCreated &&
            newlyCreated.profile?.apiLevel &&
            newlyCreated.profile.apiLevel !== "unknown" &&
            !matchesProfile(newlyCreated, { ...reqWithoutAvd, snapshotLoad: null })
          ) {
            const mismatchKey = `avd:${newlyCreated.avd}`;
            const mismatchLeaseId = `lease_${randomNonce().slice(0, 12)}`;
            const canRemoveMismatched =
              !preFleetAvds.has(newlyCreated.avd) &&
              withStateTransaction(stateDir, (state, { now }) => {
                const ownedByOther = Object.values(state.leases || {}).some(
                  (l) =>
                    l &&
                    l.leaseId !== lease.leaseId &&
                    (l.avd === newlyCreated.avd || l.deviceKey === mismatchKey),
                );
                if (ownedByOther) {
                  return { mutated: false, value: false };
                }
                state.leases[mismatchKey] = {
                  leaseId: mismatchLeaseId,
                  deviceKey: mismatchKey,
                  kind: "emulator",
                  avd: newlyCreated.avd,
                  serial: null,
                  profile: newlyCreated.profile,
                  sessionId: lease.sessionId,
                  anchorPid: lease.anchorPid ?? null,
                  state: "stopping",
                  workerPid: process.pid,
                  workerPids: [process.pid],
                  replacingAvd: null,
                  requiredRamMb: 0,
                  claimedAtMs: now,
                  deadlineMs: now + (stopTimeoutMs || 60_000),
                };
                return { mutated: true, value: true };
              });
            if (canRemoveMismatched) {
              const effectiveRemoveTimeoutMs = stopTimeoutMs || 60_000;
              const mismatchHbTimer = startWorkerDeadlineHeartbeat(
                stateDir,
                mismatchKey,
                mismatchLeaseId,
                effectiveRemoveTimeoutMs,
              );
              try {
                runner("android", ["emulator", "remove", newlyCreated.avd], {
                  strictInternal: true,
                  timeoutMs: effectiveRemoveTimeoutMs,
                });
              } catch {
                // Best-effort cleanup of mismatched created AVD
              } finally {
                mismatchHbTimer.stop();
                withStateTransaction(stateDir, (state) => {
                  if (state.leases[mismatchKey]?.leaseId === mismatchLeaseId) {
                    delete state.leases[mismatchKey];
                    return { mutated: true };
                  }
                  return { mutated: false };
                });
              }
            }
            throw new Error(
              `Created AVD "${newlyCreated.avd}" (${newlyCreated.profile.apiLevel}) does not satisfy requested profile constraints.`,
            );
          }

          if (req.avd && createdAvdName !== req.avd) {
            throw new Error(
              `Created AVD "${createdAvdName}" does not match requested --avd "${req.avd}".`,
            );
          }

          if (createdAvdName !== candidate.avd || newlyCreated) {
            const oldKey = lease.deviceKey;
            const newKey = `avd:${createdAvdName}`;
            const migrationConflict = withStateTransaction(stateDir, (state) => {
              const current = state.leases[oldKey];
              if (
                !current ||
                current.leaseId !== lease.leaseId ||
                current.state !== "starting" ||
                current.workerPid !== process.pid
              ) {
                return {
                  mutated: false,
                  value: `Lease reservation ${lease.leaseId} was lost during AVD creation.`,
                };
              }
              const destLease = state.leases[newKey];
              if (destLease && destLease.leaseId !== lease.leaseId) {
                return {
                  mutated: false,
                  value: `Created AVD "${createdAvdName}" was concurrently reserved by another session (${destLease.sessionId}).`,
                };
              }
              if (oldKey !== newKey) {
                delete state.leases[oldKey];
              }
              current.deviceKey = newKey;
              current.avd = createdAvdName;
              if (newlyCreated?.profile) {
                current.profile = newlyCreated.profile;
              }
              state.leases[newKey] = current;
              return { mutated: true, value: null };
            });
            if (migrationConflict) {
              throw new Error(migrationConflict);
            }
            candidate.avd = createdAvdName;
            candidate.deviceKey = newKey;
            if (newlyCreated?.profile) {
              candidate.profile = newlyCreated.profile;
            }
            lease.avd = createdAvdName;
            lease.deviceKey = newKey;
          }
        },
        bootTimeoutMs || 180_000,
        "atc.create.lock",
        bootTimeoutMs || 180_000,
        { allowLivePidExpiry: false },
      );
    }

    // 3. Warm state preparation vs Cold/Wipe boot
    if (selection.priority === 1 && selection.needsWarmPrep) {
      if (req.snapshotLoad) {
        assertReservationStillOwned();
        prepInvalidatedSnapshot = true;
        prepLoadedSnapshot = null;
        const snapRes = runner(
          "adb",
          ["-s", resolvedSerial, "emu", "avd", "snapshot", "load", req.snapshotLoad],
          { strictInternal: true, timeoutMs: bootTimeoutMs },
        );
        if (snapRes.status !== 0) {
          throw new Error(
            `Failed to load snapshot "${req.snapshotLoad}" on ${resolvedSerial}: ${snapRes.stderr || snapRes.stdout}`,
          );
        }
        assertReservationStillOwned();
        waitForEmulatorReady(runner, resolvedSerial, bootTimeoutMs);
        prepLoadedSnapshot = req.snapshotLoad;
      }
      if (req.resetApp) {
        assertReservationStillOwned();
        prepInvalidatedSnapshot = true;
        prepLoadedSnapshot = null;
        const resetRes = runner(
          "adb",
          ["-s", resolvedSerial, "shell", "pm", "clear", req.resetApp],
          { strictInternal: true },
        );
        if (resetRes.status !== 0) {
          throw new Error(
            `Failed to reset app "${req.resetApp}" on ${resolvedSerial}: ${resetRes.stderr || resetRes.stdout}`,
          );
        }
      }
    } else {
      if (candidate.online && (req.wipeData || req.coldBoot)) {
        assertReservationStillOwned();
        const effectiveStopTimeoutMs = stopTimeoutMs || 60_000;
        const rebootStopRes =
          isWin && candidate.serial
            ? runner("adb", ["-s", candidate.serial, "emu", "kill"], {
                strictInternal: true,
                timeoutMs: effectiveStopTimeoutMs,
              })
            : runner(
                "android",
                ["emulator", "stop", candidate.serial || candidate.avd],
                {
                  strictInternal: true,
                  timeoutMs: effectiveStopTimeoutMs,
                },
              );
        if (rebootStopRes.status !== 0) {
          throw new Error(
            `Failed to stop emulator ${candidate.avd} before reboot: ${rebootStopRes.stderr || rebootStopRes.stdout}`,
          );
        }
        stoppedExistingEmulator = true;
        resolvedSerial = null;
        if (isWin && candidate.serial) {
          try {
            waitForEmulatorOffline(
              runner,
              avdHome,
              { serial: candidate.serial, avd: candidate.avd },
              effectiveStopTimeoutMs,
            );
          } catch (err) {
            rebootStopWaitTimedOut = true;
            throw err;
          }
        }
      }
      if (req.wipeData) {
        assertReservationStillOwned();
        if (stoppedExistingEmulator && !isWin && avdHome) {
          const lockWaitDeadline = Date.now() + (stopTimeoutMs || 60_000);
          while (avdHasRuntimeLockFiles(candidate.avd, avdHome) && Date.now() < lockWaitDeadline) {
            sleepSync(100);
          }
        }
        wipeAvdUserData(candidate.avd, avdHome);
      }
      assertReservationStillOwned();
      let bootRes;
      if (isWin) {
        const winArgs = ["-avd", candidate.avd];
        if (req.headless) winArgs.push("-no-window");
        if (req.coldBoot || req.wipeData) winArgs.push("-no-snapshot-load");
        bootRes = runner("emulator", winArgs, {
          strictInternal: true,
          detached: true,
          timeoutMs: bootTimeoutMs,
        });
      } else {
        const startArgs = ["emulator", "start", candidate.avd];
        if (req.headless) startArgs.push("--headless");
        if (req.coldBoot || req.wipeData) startArgs.push("--cold");

        bootRes = runner("android", startArgs, {
          strictInternal: true,
          timeoutMs: bootTimeoutMs,
        });
      }
      const serialMatch = (bootRes.stdout || "").match(/\b(emulator-\d+)\b/);
      resolvedSerial = serialMatch ? serialMatch[1] : null;
      if (bootRes.status !== 0 || /\bError:\s+/i.test(bootRes.stdout || "")) {
        const hasLocksAfterFailedStart = Boolean(
          avdHome && avdHasRuntimeLockFiles(candidate.avd, avdHome),
        );
        if (resolvedSerial || hasLocksAfterFailedStart) {
          bootedNewEmulator = true;
          partialBootNeedsStop = true;
        } else {
          try {
            const refreshed = discoverFleet({
              runner,
              avdHome,
              platform: isWin ? "win32" : platform,
            });
            const booted = (refreshed.running || []).find(
              (d) => d.kind === "emulator" && d.avd === candidate.avd,
            );
            if (booted?.serial) {
              resolvedSerial = booted.serial;
            }
            const hasUnmapped = (refreshed.running || []).some(
              (d) => d.kind === "emulator" && !d.avd,
            );
            const probesOk = Boolean(
              refreshed.probes?.emulatorListOk && refreshed.probes?.adbDevicesOk,
            );
            if (
              booted ||
              hasUnmapped ||
              !probesOk ||
              (avdHome && avdHasRuntimeLockFiles(candidate.avd, avdHome))
            ) {
              bootedNewEmulator = true;
              partialBootNeedsStop = true;
            }
          } catch {
            bootedNewEmulator = true;
            partialBootNeedsStop = true;
          }
        }
        throw new Error(
          `Failed to boot emulator ${candidate.avd}: ${(bootRes.stderr || bootRes.stdout || "").trim()}`,
        );
      }
      bootedNewEmulator = true;

      const pollDeadline = Date.now() + (bootTimeoutMs || 60_000);
      while (!resolvedSerial) {
        const refreshed = discoverFleet({
          runner,
          avdHome,
          platform: isWin ? "win32" : platform,
        });
        const booted = (refreshed.running || []).find(
          (d) => d.kind === "emulator" && d.avd === candidate.avd && d.serial,
        );
        resolvedSerial = booted?.serial || null;
        if (resolvedSerial || Date.now() >= pollDeadline) break;
        sleepSync(250);
      }
      if (!resolvedSerial) {
        partialBootNeedsStop = true;
        throw new Error(
          `Booted emulator ${candidate.avd} did not report an adb serial and could not be discovered.`,
        );
      }
      if (isWin) {
        assertReservationStillOwned();
        try {
          waitForEmulatorReady(runner, resolvedSerial, bootTimeoutMs);
        } catch (readyErr) {
          partialBootNeedsStop = true;
          throw readyErr;
        }
      }

      if (req.snapshotLoad) {
        assertReservationStillOwned();
        prepInvalidatedSnapshot = true;
        prepLoadedSnapshot = null;
        const snapRes = runner(
          "adb",
          ["-s", resolvedSerial, "emu", "avd", "snapshot", "load", req.snapshotLoad],
          { strictInternal: true, timeoutMs: bootTimeoutMs },
        );
        if (snapRes.status !== 0) {
          throw new Error(
            `Failed to load snapshot "${req.snapshotLoad}" on ${resolvedSerial}: ${snapRes.stderr || snapRes.stdout}`,
          );
        }
        assertReservationStillOwned();
        waitForEmulatorReady(runner, resolvedSerial, bootTimeoutMs);
        prepLoadedSnapshot = req.snapshotLoad;
      }

      if (req.resetApp) {
        assertReservationStillOwned();
        prepInvalidatedSnapshot = true;
        prepLoadedSnapshot = null;
        const resetRes = runner(
          "adb",
          ["-s", resolvedSerial, "shell", "pm", "clear", req.resetApp],
          { strictInternal: true },
        );
        if (resetRes.status !== 0) {
          throw new Error(
            `Failed to reset app "${req.resetApp}" on ${resolvedSerial}: ${resetRes.stderr || resetRes.stdout}`,
          );
        }
      }
    }

    hbTimer.stop();

    // 4. Activate lease under atc.lock (honoring any deferred release requested during boot/prep)
    let releasedDuringBoot = false;
    const livenessCheck = execOptions.livenessCheck || isPidAlive;
    const activeLease = finishLeaseWorker(
      stateDir,
      lease.deviceKey,
      lease.leaseId,
      ttlMs,
      execOptions,
      (current, state, now) => {
        const targetAvd = candidate.avd || lease.avd || null;
        const conflictingLease = Object.values(state.leases || {}).find(
          (l) =>
            l &&
            l.leaseId !== lease.leaseId &&
            ((resolvedSerial && l.serial === resolvedSerial) ||
              (targetAvd && l.avd === targetAvd)),
        );
        if (conflictingLease) {
          throw new Error(`Lease reservation ${lease.leaseId} was lost during boot`);
        }
        const otherWorkers = (current.workerPids || []).filter(
          (p) => p !== process.pid && livenessCheck(p),
        );
        releasedDuringBoot =
          otherWorkers.length === 0 &&
          Boolean(
            current.releaseOnWorkerExit ||
              (current.anchorPid !== null &&
                current.anchorPid !== undefined &&
                !livenessCheck(current.anchorPid)),
          );
        if (releasedDuringBoot && !previousLease) {
          current.saveSnapshotOnFree = null;
        }
        current.state = "active";
        current.replacingAvd = null;
        current.serial = resolvedSerial;
        current.loadedSnapshot = req.resetApp ? null : req.snapshotLoad || null;
        if (bootedNewEmulator) {
          recordDeviceBootedInState(state, current, now);
        } else {
          clearDeviceStoppedInState(state, current);
        }
        current.activatedAtMs = now;
        current.activatedEpoch = state.fleetEpoch || 0;
        current.renewedAtMs = now;
        current.expiresAtMs = hasExplicitTtl
          ? now + ttlMs
          : Math.max(current.expiresAtMs || 0, previousLease?.expiresAtMs || 0, now + ttlMs);
        current.deadlineMs = null;
      },
    );
    if (!activeLease) {
      throw new Error(`Lease reservation ${lease.leaseId} was lost during boot`);
    }
    if (releasedDuringBoot) {
      return {
        exitCode: 1,
        error: `Lease reservation ${lease.leaseId} was released during boot.`,
      };
    }

    return { exitCode: 0, lease: activeLease, idempotent: false };
  } catch (err) {
    hbTimer.stop();
    victimHbTimer?.stop();
    if (stoppedExistingEmulator && !resolvedSerial && previousLease) {
      try {
        const refreshed = discoverFleet({
          runner,
          avdHome,
          platform: isWin ? "win32" : platform,
        });
        const booted = (refreshed.running || []).find(
          (d) => d.kind === "emulator" && d.avd === candidate.avd && d.serial,
        );
        resolvedSerial = booted?.serial || null;
      } catch {
        // Ignore discovery failure during rollback
      }
    }
    const livenessCheck = execOptions.livenessCheck || isPidAlive;
    const effectiveStopTimeoutMs = stopTimeoutMs || 60_000;
    const rollbackInfo = withStateTransaction(
      stateDir,
      (state, { now }) => {
        const current = state.leases[lease.deviceKey];
        const owned = Boolean(
          current &&
            current.leaseId === lease.leaseId &&
            current.state === "starting" &&
            current.workerPid === process.pid,
        );
        const shouldRelease = Boolean(
          current &&
            (current.releaseOnWorkerExit ||
              (current.anchorPid !== null &&
                current.anchorPid !== undefined &&
                !livenessCheck(current.anchorPid))),
        );
        const pendingStop = Boolean(current?.pendingStop);
        const needsStopOnRollback = Boolean(bootedNewEmulator || pendingStop);
        const canRestorePreviousWithoutStop = Boolean(
          previousLease && !shouldRelease && !partialBootNeedsStop && !pendingStop,
        );
        const targetAvd = candidate.avd || lease.avd || null;
        let migratedToOtherLease = false;
        if (bootedNewEmulator) {
          recordDeviceBootedInState(
            state,
            {
              deviceKey: lease.deviceKey,
              avd: targetAvd,
              serial: resolvedSerial || candidate.serial || null,
              profile: candidate.profile || lease.profile,
              ramSizeMb: candidate.ramSizeMb || 2048,
              requiredRamMb: lease.requiredRamMb || candidate.requiredRamMb || 0,
            },
            now,
          );
        }

        if (owned) {
          if (rebootStopWaitTimedOut) {
            removeLeaseWorker(current, process.pid, livenessCheck);
            current.replacingAvd = null;
            current.serial = candidate.serial || current.serial || null;
            markStoppingAwaitOfflineReconcile(
              state,
              current,
              now,
              now + effectiveStopTimeoutMs,
            );
          } else if (canRestorePreviousWithoutStop) {
            state.leases[lease.deviceKey] = {
              ...previousLease,
              serial: stoppedExistingEmulator
                ? resolvedSerial || null
                : resolvedSerial || previousLease.serial,
              state: "active",
              workerPid: null,
              workerPids: [],
              replacingAvd: null,
              loadedSnapshot:
                stoppedExistingEmulator || prepInvalidatedSnapshot
                  ? prepLoadedSnapshot
                  : previousLease.loadedSnapshot,
              renewedAtMs: now,
              expiresAtMs: Math.max(previousLease.expiresAtMs || 0, now + ttlMs),
              deadlineMs: null,
            };
          } else {
            if (targetAvd && lease.deviceKey === `avd:${targetAvd}`) {
              const pendingSerialEntry = Object.entries(state.leases || {}).find(
                ([k, l]) =>
                  k.startsWith("serial:") &&
                  l &&
                  l.kind === "emulator" &&
                  ((resolvedSerial && l.serial === resolvedSerial) || l.avd === targetAvd),
              );
              if (pendingSerialEntry) {
                const [serialKey, serialLease] = pendingSerialEntry;
                delete state.leases[serialKey];
                serialLease.avd = targetAvd;
                serialLease.deviceKey = lease.deviceKey;
                serialLease.profile = candidate.profile || serialLease.profile;
                state.leases[lease.deviceKey] = serialLease;
                migratedToOtherLease = true;
              }
            }
          }
        } else if (rebootStopWaitTimedOut && !current) {
          const recreated = {
            ...lease,
            workerPid: null,
            workerPids: [],
            replacingAvd: null,
            serial: candidate.serial || lease.serial || null,
          };
          markStoppingAwaitOfflineReconcile(
            state,
            recreated,
            now,
            now + effectiveStopTimeoutMs,
          );
          state.leases[lease.deviceKey] = recreated;
        }
        if (selection.victim) {
          const vCurrent = state.leases[selection.victim.deviceKey];
          if (vCurrent && vCurrent.leaseId === victimLeaseId) {
            if (victimStopWaitTimedOut) {
              removeLeaseWorker(vCurrent, process.pid, livenessCheck);
              markStoppingAwaitOfflineReconcile(
                state,
                vCurrent,
                now,
                now + effectiveStopTimeoutMs,
              );
            } else {
              delete state.leases[selection.victim.deviceKey];
            }
          } else if (victimStopWaitTimedOut && !vCurrent && victimLeaseId) {
            const vRecreated = {
              leaseId: victimLeaseId,
              deviceKey: selection.victim.deviceKey,
              kind: "emulator",
              avd: selection.victim.avd,
              serial: selection.victim.serial || null,
              profile: selection.victim.profile,
              sessionId: lease.sessionId,
              anchorPid: lease.anchorPid ?? null,
              workerPid: null,
              workerPids: [],
              replacingAvd: null,
              requiredRamMb: 0,
              claimedAtMs: now,
            };
            markStoppingAwaitOfflineReconcile(
              state,
              vRecreated,
              now,
              now + effectiveStopTimeoutMs,
            );
            state.leases[selection.victim.deviceKey] = vRecreated;
          }
        }
        const otherLeaseOwnsDevice = Object.values(state.leases || {}).some(
          (l) =>
            l &&
            l.leaseId !== lease.leaseId &&
            ((resolvedSerial && l.serial === resolvedSerial) ||
              (targetAvd && l.avd === targetAvd)),
        );
        const stopBootedEmulator = Boolean(
          owned &&
            !rebootStopWaitTimedOut &&
            !canRestorePreviousWithoutStop &&
            !migratedToOtherLease &&
            !otherLeaseOwnsDevice &&
            needsStopOnRollback,
        );
        if (
          owned &&
          !rebootStopWaitTimedOut &&
          !canRestorePreviousWithoutStop &&
          !migratedToOtherLease
        ) {
          if (stopBootedEmulator) {
            current.state = "stopping";
            current.workerPid = process.pid;
            current.workerPids = [process.pid];
            current.replacingAvd = null;
            if (resolvedSerial) {
              current.serial = resolvedSerial;
            }
            current.deadlineMs = now + effectiveStopTimeoutMs;
          } else {
            delete state.leases[lease.deviceKey];
          }
        }
        return {
          mutated: true,
          value: {
            owned,
            shouldRelease,
            pendingStop,
            stopBootedEmulator,
          },
        };
      },
      execOptions,
    );
    if ((bootedNewEmulator || rollbackInfo.pendingStop) && rollbackInfo.stopBootedEmulator) {
      const rollbackHbTimer = startWorkerDeadlineHeartbeat(
        stateDir,
        lease.deviceKey,
        lease.leaseId,
        effectiveStopTimeoutMs,
      );
      let stoppedCleanly = false;
      let cleanupSerial = resolvedSerial;
      try {
        if (isWin) {
          if (!cleanupSerial) {
            const refreshed = discoverFleet({ runner, avdHome, platform: "win32" });
            const booted = (refreshed.running || []).find(
              (d) => d.kind === "emulator" && d.avd === candidate.avd && d.serial,
            );
            cleanupSerial = booted?.serial || null;
          }
          if (cleanupSerial) {
            const killRes = runner("adb", ["-s", cleanupSerial, "emu", "kill"], {
              strictInternal: true,
              timeoutMs: effectiveStopTimeoutMs,
            });
            if (killRes.status === 0) {
              waitForEmulatorOffline(
                runner,
                avdHome,
                { serial: cleanupSerial, avd: candidate.avd || lease.avd },
                effectiveStopTimeoutMs,
              );
              stoppedCleanly = true;
            }
          }
        } else {
          const stopRes = runner(
            "android",
            ["emulator", "stop", resolvedSerial || candidate.avd],
            {
              strictInternal: true,
              timeoutMs: effectiveStopTimeoutMs,
            },
          );
          if (stopRes.status === 0) {
            stoppedCleanly = true;
          }
        }
      } catch {
        // Best-effort cleanup of newly booted emulator
      } finally {
        rollbackHbTimer.stop();
        withStateTransaction(
          stateDir,
          (state, { now }) => {
            const cur = state.leases[lease.deviceKey];
            if (stoppedCleanly) {
              recordDeviceStoppedInState(
                state,
                {
                  deviceKey: lease.deviceKey,
                  avd: candidate.avd || lease.avd,
                  serial: cleanupSerial || resolvedSerial || candidate.serial,
                },
                now,
              );
              if (
                previousLease &&
                !rollbackInfo.shouldRelease &&
                !rollbackInfo.pendingStop
              ) {
                state.leases[lease.deviceKey] = {
                  ...previousLease,
                  serial: null,
                  state: "active",
                  workerPid: null,
                  workerPids: [],
                  replacingAvd: null,
                  loadedSnapshot: null,
                  renewedAtMs: now,
                  expiresAtMs: Math.max(previousLease.expiresAtMs || 0, now + ttlMs),
                  deadlineMs: null,
                };
              } else if (cur && cur.leaseId === lease.leaseId) {
                delete state.leases[lease.deviceKey];
              }
            } else if (cur && cur.leaseId === lease.leaseId) {
              removeLeaseWorker(cur, process.pid, livenessCheck);
              cur.serial = cleanupSerial || resolvedSerial || cur.serial || null;
              markStoppingAwaitOfflineReconcile(
                state,
                cur,
                now,
                now + effectiveStopTimeoutMs,
              );
            } else if (!cur) {
              const recreated = {
                ...lease,
                state: "stopping",
                workerPid: null,
                workerPids: [],
                replacingAvd: null,
                serial: cleanupSerial || resolvedSerial || lease.serial || null,
                deadlineMs: now + effectiveStopTimeoutMs,
              };
              markStoppingAwaitOfflineReconcile(
                state,
                recreated,
                now,
                now + effectiveStopTimeoutMs,
              );
              state.leases[lease.deviceKey] = recreated;
            }
            return { mutated: true };
          },
          execOptions,
        );
      }
    }
    return { exitCode: 1, error: err.message };
  }
}

export function cmdFree(stateDir, target = null, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, FREE_ALLOWED_FLAGS, "free");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr, freed: [] };
  }
  if (
    flags.target !== undefined &&
    flags.target !== null &&
    (typeof flags.target !== "string" || !flags.target.trim())
  ) {
    return {
      exitCode: 1,
      error: 'Option "--target" requires a non-empty lease ID, serial, or AVD name.',
      freed: [],
    };
  }
  const effectiveTarget = target || (typeof flags.target === "string" ? flags.target.trim() : null);
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);

  if (
    flags.snapshotSave !== undefined &&
    flags.snapshotSave !== null &&
    (typeof flags.snapshotSave !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(flags.snapshotSave))
  ) {
    return {
      exitCode: 1,
      error: `Invalid snapshot name "${flags.snapshotSave}". Must match /^[A-Za-z0-9._-]{1,64}$/.`,
      freed: [],
    };
  }
  if (
    flags.snapshotLoad !== undefined &&
    flags.snapshotLoad !== null &&
    (typeof flags.snapshotLoad !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(flags.snapshotLoad))
  ) {
    return {
      exitCode: 1,
      error: `Invalid snapshot name "${flags.snapshotLoad}". Must match /^[A-Za-z0-9._-]{1,64}$/.`,
      freed: [],
    };
  }

  // Pre-lock disk check (pure statfs, never spawns subprocesses under atc.lock)
  const freeDiskMb =
    options.host?.freeDiskMb ?? (!flags.force ? readFreeDiskMb(avdHome) : 16384);

  const terminatedPgids = [];
  if (!options.deferOnBusyWorker) {
    try {
      const preLiveness = options.livenessCheck || isPidAlive;
      const preState = readState(stateDir);
      const preIdentity = resolveSessionIdentity({
        flags,
        env: options.env || process.env,
        state: preState,
        cwd: options.cwd || process.cwd(),
        ppid: options.ppid ?? process.ppid,
        ancestorPids: options.ancestorPids,
        processChain: options.processChain,
      });
      const preLeases = Object.values(preState.leases || {});
      const preMatches = [];
      if (effectiveTarget) {
        const found =
          preLeases.find((l) => l.leaseId === effectiveTarget) ||
          preLeases.find((l) => l.serial === effectiveTarget) ||
          preLeases.find((l) => l.avd === effectiveTarget);
        if (
          found &&
          (found.sessionId === preIdentity.sessionId ||
            found.leaseId === effectiveTarget ||
            parseBoolFlag(flags.force))
        ) {
          preMatches.push(found);
        }
      } else {
        for (const l of preLeases) {
          if (
            l.sessionId === preIdentity.sessionId &&
            (l.state === "active" || l.state === "starting")
          ) {
            preMatches.push(l);
          }
        }
      }
      for (const l of preMatches) {
        if (!Array.isArray(l.workerPgids) || l.workerPgids.length === 0) continue;
        const pgidSet = new Set(l.workerPgids.map(Number));
        const hasLiveWrapperPid = (l.workerPids || []).some((p) => {
          const num = Number(p);
          return num !== options.callerWorkerPid && !pgidSet.has(num) && preLiveness(num);
        });
        const hasLiveLeaderPid = l.workerPgids.some((p) => {
          const num = Number(p);
          return num !== options.callerWorkerPid && preLiveness(num);
        });
        if (parseBoolFlag(flags.force) || (!hasLiveWrapperPid && !hasLiveLeaderPid)) {
          killProcessGroupTree(l, "SIGKILL", {
            spawnSyncFn: options.spawnSyncFn || options.runner,
            platform: options.platform,
          });
          terminatedPgids.push(...l.workerPgids.map(Number));
        }
      }
    } catch {
      // Best-effort pre-lock orphan tree termination
    }
  }

  let outcome;
  try {
    outcome = withStateTransaction(
      stateDir,
      (state, { now }) => {
        const identity = resolveSessionIdentity({
          flags,
          env: options.env || process.env,
          state,
          cwd: options.cwd || process.cwd(),
        ppid: options.ppid ?? process.ppid,
        ancestorPids: options.ancestorPids,
        processChain: options.processChain,
      });

      const matches = [];
      const leasesList = Object.values(state.leases);
      if (effectiveTarget) {
        const byId = leasesList.find((l) => l.leaseId === effectiveTarget);
        const bySerial = !byId && leasesList.find((l) => l.serial === effectiveTarget);
        const byAvd = !byId && !bySerial && leasesList.find((l) => l.avd === effectiveTarget);
        const found = byId || bySerial || byAvd;
        if (!found) {
          return {
            mutated: false,
            value: {
              status: "not_found",
              error: `No matching active lease found for "${effectiveTarget}".`,
              freed: [],
            },
          };
        }
        const isOwner =
          found.sessionId === identity.sessionId ||
          found.leaseId === effectiveTarget ||
          parseBoolFlag(flags.force);
        if (!isOwner) {
          return {
            mutated: false,
            value: {
              status: "forbidden",
              error: `Lease ${found.leaseId} (${found.deviceKey}) is owned by session "${found.sessionId}", not "${identity.sessionId}".`,
            },
          };
        }
        matches.push(found);
      } else {
        for (const l of leasesList) {
          if (
            l.sessionId === identity.sessionId &&
            (l.state === "active" || l.state === "starting")
          ) {
            matches.push(l);
          }
        }
      }

      const prevQueueLen = Array.isArray(state.queue) ? state.queue.length : 0;
      if (!effectiveTarget && Array.isArray(state.queue) && prevQueueLen > 0) {
        state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);
      }
      const prunedOwnTickets = prevQueueLen !== (state.queue?.length || 0);

      if (matches.length === 0) {
        return {
          mutated: prunedOwnTickets,
          value: { status: "empty", freed: [] },
        };
      }

      const livenessCheck = options.livenessCheck || isPidAlive;
      const isForced = parseBoolFlag(flags.force);
      const stoppingQueue = [];
      const freedImmediate = [];
      const busyErrors = [];
      const stopTimeoutMs = (state.config.stopTimeoutSec || 60) * 1000;
      const cumulativeSnapshotMbByFs = new Map();
      const matchedKeys = new Set(matches.map((m) => m.deviceKey));
      for (const otherLease of Object.values(state.leases || {})) {
        if (!otherLease || otherLease.kind !== "emulator" || matchedKeys.has(otherLease.deviceKey)) {
          continue;
        }
        const otherFsKey =
          options.host?.freeDiskMb !== undefined
            ? "__injected_host__"
            : otherLease.fsDev || otherLease.avdPath || avdHome || "default";
        if (
          otherLease.state === "starting" &&
          typeof otherLease.requiredDiskMb === "number" &&
          otherLease.requiredDiskMb > 0
        ) {
          cumulativeSnapshotMbByFs.set(
            otherFsKey,
            (cumulativeSnapshotMbByFs.get(otherFsKey) || 0) + otherLease.requiredDiskMb,
          );
        } else if (
          typeof otherLease.pendingSnapshotDiskMb === "number" &&
          otherLease.pendingSnapshotDiskMb > 0
        ) {
          cumulativeSnapshotMbByFs.set(
            otherFsKey,
            (cumulativeSnapshotMbByFs.get(otherFsKey) || 0) + otherLease.pendingSnapshotDiskMb,
          );
        }
      }

      for (const lease of matches) {
        const activeWorkers = syncLeaseWorkers(lease, livenessCheck).filter(
          (p) => p !== options.callerWorkerPid,
        );
        if (activeWorkers.length > 0) {
          lease.releaseOnWorkerExit = true;
          if (flags.snapshotSave) {
            lease.pendingSnapshotSave = flags.snapshotSave;
          }
          if (flags.snapshotLoad) {
            lease.pendingSnapshotLoad = flags.snapshotLoad;
          }
          if (parseBoolFlag(flags.stop) || parseBoolFlag(flags.shutdown)) {
            lease.pendingStop = true;
          }
          busyErrors.push(
            `Lease ${lease.leaseId} (${lease.deviceKey}) has active in-flight worker(s) (${activeWorkers.join(", ")}); wait for completion or pass --force.`,
          );
          continue;
        }

        const saveSnap =
          flags.snapshotSave || lease.pendingSnapshotSave || lease.saveSnapshotOnFree || null;
        const loadSnap = flags.snapshotLoad || lease.pendingSnapshotLoad || null;
        const doStop =
          (parseBoolFlag(flags.stop) ||
            parseBoolFlag(flags.shutdown) ||
            Boolean(lease.pendingStop)) &&
          lease.kind === "emulator";

        const meta =
          saveSnap && lease.kind === "emulator"
            ? readLocalAvdMetadata(lease.avd, avdHome, state.config)
            : null;
        if (saveSnap && !isForced && lease.kind === "emulator" && meta) {
          const fsKey =
            options.host?.freeDiskMb !== undefined
              ? "__injected_host__"
              : meta.fsDev || meta.avdPath || avdHome || "default";
          const fsFreeDiskMb = options.host?.freeDiskMb ?? meta.freeDiskMb ?? freeDiskMb;
          const nextCumulativeMb = (cumulativeSnapshotMbByFs.get(fsKey) || 0) + meta.ramSizeMb;
          cumulativeSnapshotMbByFs.set(fsKey, nextCumulativeMb);
          if (fsFreeDiskMb < nextCumulativeMb + (state.config.minFreeDiskMb ?? 2048)) {
            throw new ResourceError(
              5,
              `Insufficient disk space to save snapshot "${saveSnap}" on ${lease.avd}: needs ${nextCumulativeMb + (state.config.minFreeDiskMb ?? 2048)}MB free.`,
            );
          }
        }

        if ((saveSnap || loadSnap || doStop) && lease.kind === "emulator") {
          lease.state = "stopping";
          lease.workerPid = process.pid;
          lease.deadlineMs = now + stopTimeoutMs;
          if (saveSnap && meta) {
            lease.pendingSnapshotDiskMb = meta.ramSizeMb || 2048;
            lease.fsDev = meta.fsDev ?? lease.fsDev ?? null;
          }
          stoppingQueue.push({
            lease: { ...lease },
            saveSnap,
            loadSnap,
            doStop,
            stopTimeoutMs,
          });
        } else {
          freedImmediate.push(lease.leaseId);
          delete state.leases[lease.deviceKey];
        }
      }

      return {
        mutated: true,
        value: {
          status:
            busyErrors.length > 0 &&
            !options.deferOnBusyWorker &&
            freedImmediate.length === 0 &&
            stoppingQueue.length === 0
              ? "busy_worker"
              : "ok",
          freedImmediate,
          stoppingQueue,
          busyErrors: options.deferOnBusyWorker ? [] : busyErrors,
        },
      };
    }, terminatedPgids.length > 0 ? { ...options, terminatedPgids } : options);
  } catch (err) {
    if (err instanceof ResourceError) {
      return { exitCode: err.exitCode, error: err.message };
    }
    return { exitCode: 1, error: err.message };
  }

  if (outcome.status === "not_found") {
    return { exitCode: 3, error: outcome.error, freed: [] };
  }
  if (outcome.status === "forbidden") {
    return { exitCode: 3, error: outcome.error };
  }
  if (outcome.status === "busy_worker") {
    return {
      exitCode: 3,
      error: outcome.busyErrors.join("; "),
      freed: [],
    };
  }

  const allFreed = [...(outcome.freedImmediate || [])];
  const actionErrors = [...(outcome.busyErrors || [])];
  const stoppingItems = outcome.stoppingQueue || [];
  const heartbeats = new Map(
    stoppingItems.map((item) => [
      item.lease.leaseId,
      startWorkerDeadlineHeartbeat(
        stateDir,
        item.lease.deviceKey,
        item.lease.leaseId,
        item.stopTimeoutMs,
      ),
    ]),
  );

  for (const item of stoppingItems) {
    const { lease, saveSnap, loadSnap, doStop, stopTimeoutMs } = item;
    let itemFailed = false;
    let windowsStopWaitTimedOut = false;
    let loadedSnapOnFree = false;
    const checkAndRefreshStopping = () =>
      withStateTransaction(stateDir, (state, { now }) => {
        let mutated = false;
        let currentItemActive = false;
        for (const rem of stoppingItems) {
          const { lease: cur } = findLeaseEntry(
            state,
            rem.lease.deviceKey,
            rem.lease.leaseId,
          );
          if (
            cur &&
            cur.leaseId === rem.lease.leaseId &&
            cur.workerPid === process.pid &&
            cur.state === "stopping"
          ) {
            cur.deadlineMs = now + rem.stopTimeoutMs;
            mutated = true;
            if (rem.lease.leaseId === lease.leaseId) {
              currentItemActive = true;
            }
          }
        }
        return { mutated, value: currentItemActive };
      });
    try {
      if (!checkAndRefreshStopping()) {
        itemFailed = true;
        actionErrors.push(
          `Lease ${lease.leaseId} (${lease.deviceKey}) was superseded before cleanup could run.`,
        );
      }
      if (!itemFailed && saveSnap) {
        if (!lease.serial) {
          itemFailed = true;
          actionErrors.push(
            `Failed to save snapshot "${saveSnap}" on ${lease.avd || lease.deviceKey}: emulator has no active adb serial.`,
          );
        } else {
          const saveRes = runner(
            "adb",
            ["-s", lease.serial, "emu", "avd", "snapshot", "save", saveSnap],
            { strictInternal: true, timeoutMs: stopTimeoutMs },
          );
          if (saveRes.status !== 0) {
            itemFailed = true;
            actionErrors.push(
              `Failed to save snapshot "${saveSnap}" on ${lease.serial}: ${saveRes.stderr || saveRes.stdout}`,
            );
          }
        }
      }
      if (!itemFailed && loadSnap && !doStop) {
        if (saveSnap && !checkAndRefreshStopping()) {
          itemFailed = true;
          actionErrors.push(
            `Lease ${lease.leaseId} (${lease.deviceKey}) was superseded before cleanup could run.`,
          );
        } else if (!lease.serial) {
          itemFailed = true;
          actionErrors.push(
            `Failed to load snapshot "${loadSnap}" on ${lease.avd || lease.deviceKey}: emulator has no active adb serial.`,
          );
        } else {
          const loadRes = runner(
            "adb",
            ["-s", lease.serial, "emu", "avd", "snapshot", "load", loadSnap],
            { strictInternal: true, timeoutMs: stopTimeoutMs },
          );
          if (loadRes.status !== 0) {
            itemFailed = true;
            actionErrors.push(
              `Failed to load snapshot "${loadSnap}" on ${lease.serial}: ${loadRes.stderr || loadRes.stdout}`,
            );
          } else {
            try {
              if (!checkAndRefreshStopping()) {
                throw new Error(
                  `Lease ${lease.leaseId} (${lease.deviceKey}) was superseded before cleanup could run.`,
                );
              }
              waitForEmulatorReady(runner, lease.serial, stopTimeoutMs);
              loadedSnapOnFree = true;
            } catch (err) {
              itemFailed = true;
              actionErrors.push(err.message);
            }
          }
        }
      }
      if (!itemFailed && doStop) {
        if ((saveSnap || loadSnap) && !checkAndRefreshStopping()) {
          itemFailed = true;
          actionErrors.push(
            `Lease ${lease.leaseId} (${lease.deviceKey}) was superseded before cleanup could run.`,
          );
        } else {
          const isWin = (options.platform || process.platform) === "win32";
          if (isWin && !lease.avd && lease.serial) {
            try {
              const nameRes = runner("adb", ["-s", lease.serial, "emu", "avd", "name"], {
                timeoutMs: Math.min(3000, stopTimeoutMs),
              });
              const avdId =
                nameRes.status === 0 && nameRes.stdout
                  ? nameRes.stdout.split(/\r?\n/)[0].trim()
                  : "";
              if (avdId && avdId !== "OK") {
                lease.avd = avdId;
              }
            } catch {
              // Best-effort pre-kill AVD mapping
            }
          }
          const stopRes =
            isWin && lease.serial
              ? runner("adb", ["-s", lease.serial, "emu", "kill"], {
                  strictInternal: true,
                  timeoutMs: stopTimeoutMs,
                })
              : runner("android", ["emulator", "stop", lease.serial || lease.avd], {
                  strictInternal: true,
                  timeoutMs: stopTimeoutMs,
                });
          if (stopRes.status !== 0) {
            itemFailed = true;
            actionErrors.push(
              `Failed to stop emulator ${lease.avd || lease.serial}: ${stopRes.stderr || stopRes.stdout}`,
            );
          } else if (isWin && lease.serial) {
            try {
              const maybeResolvedAvd = waitForEmulatorOffline(
                runner,
                avdHome,
                { serial: lease.serial, avd: lease.avd },
                stopTimeoutMs,
              );
              if (typeof maybeResolvedAvd === "string" && !lease.avd) {
                lease.avd = maybeResolvedAvd;
              }
            } catch (err) {
              if (typeof err?.resolvedAvd === "string" && !lease.avd) {
                lease.avd = err.resolvedAvd;
              }
              itemFailed = true;
              windowsStopWaitTimedOut = true;
              actionErrors.push(err.message);
            }
          }
        }
      }
    } catch (err) {
      itemFailed = true;
      actionErrors.push(err?.message || String(err));
    } finally {
      heartbeats.get(lease.leaseId)?.stop();
      withStateTransaction(
        stateDir,
        (state, { now }) => {
          const { key: resolvedKey, lease: cur } = findLeaseEntry(
            state,
            lease.deviceKey,
            lease.leaseId,
          );
          if (cur && cur.leaseId === lease.leaseId) {
            if (lease.avd && !cur.avd) {
              cur.avd = lease.avd;
            }
            if (itemFailed) {
              const livenessCheck = options.livenessCheck || isPidAlive;
              removeLeaseWorker(cur, process.pid, livenessCheck);
              if (windowsStopWaitTimedOut) {
                markStoppingAwaitOfflineReconcile(state, cur, now, now + stopTimeoutMs);
              } else {
                cur.state = "active";
                cur.releaseOnWorkerExit = false;
                if (loadSnap) {
                  cur.loadedSnapshot = loadedSnapOnFree ? loadSnap : null;
                }
                if (
                  cur.anchorPid !== null &&
                  cur.anchorPid !== undefined &&
                  !livenessCheck(cur.anchorPid)
                ) {
                  cur.anchorPid = null;
                }
                cur.deadlineMs = null;
                const ttlMs = (state.config?.defaultTtlSec || 600) * 1000;
                cur.renewedAtMs = now;
                cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + ttlMs);
              }
            } else {
              if (doStop) {
                recordDeviceStoppedInState(state, cur, now);
              }
              delete state.leases[resolvedKey];
            }
            return { mutated: true };
          }
          if (itemFailed && windowsStopWaitTimedOut && !cur) {
            const recreated = {
              ...lease,
              workerPid: null,
              workerPids: [],
            };
            markStoppingAwaitOfflineReconcile(state, recreated, now, now + stopTimeoutMs);
            state.leases[lease.deviceKey] = recreated;
            return { mutated: true };
          }
          return { mutated: false };
        },
        options,
      );
      if (!itemFailed) {
        allFreed.push(lease.leaseId);
      }
    }
  }

  if (actionErrors.length > 0) {
    return {
      exitCode: 1,
      error: actionErrors.join("; "),
      freed: allFreed,
    };
  }

  return { exitCode: 0, freed: allFreed };
}

export function cmdRenew(stateDir, target = null, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, RENEW_ALLOWED_FLAGS, "renew");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr };
  }
  if (
    flags.target !== undefined &&
    flags.target !== null &&
    (typeof flags.target !== "string" || !flags.target.trim())
  ) {
    return {
      exitCode: 1,
      error: 'Option "--target" requires a non-empty lease ID, serial, or AVD name.',
    };
  }
  const rawExplicitTtl = flags.ttl ?? flags.ttlSec;
  if (rawExplicitTtl !== undefined && rawExplicitTtl !== null) {
    const parsedTtl =
      typeof rawExplicitTtl === "boolean" ||
      (typeof rawExplicitTtl === "string" && !rawExplicitTtl.trim())
        ? Number.NaN
        : Number(rawExplicitTtl);
    if (!Number.isFinite(parsedTtl) || parsedTtl <= 0) {
      return {
        exitCode: 1,
        error: `Invalid --ttl duration "${rawExplicitTtl}". Expected a positive number of seconds.`,
      };
    }
  }
  const effectiveTarget = target || (typeof flags.target === "string" ? flags.target.trim() : null);
  return withStateTransaction(stateDir, (state, { now }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
      ancestorPids: options.ancestorPids,
      processChain: options.processChain,
    });
    const ttlSec = clampTtlSec(rawExplicitTtl, state.config);
    const ttlMs = ttlSec * 1000;

    const leasesList = Object.values(state.leases).filter((l) => l.state === "active");
    let lease = null;
    if (effectiveTarget) {
      lease =
        leasesList.find((l) => l.leaseId === effectiveTarget) ||
        leasesList.find((l) => l.serial === effectiveTarget) ||
        leasesList.find((l) => l.avd === effectiveTarget);
    } else {
      const owned = leasesList.filter((l) => l.sessionId === identity.sessionId);
      if (owned.length > 1) {
        return {
          mutated: false,
          value: {
            exitCode: 1,
            error: `Session "${identity.sessionId}" holds ${owned.length} active leases; specify a <lease-id|serial|avd> target to renew.`,
          },
        };
      }
      lease = owned[0] || null;
    }

    if (!lease) {
      return {
        mutated: false,
        value: { exitCode: 3, error: "No matching active lease found to renew." },
      };
    }
    if (lease.sessionId !== identity.sessionId && lease.leaseId !== effectiveTarget) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} is owned by "${lease.sessionId}", not "${identity.sessionId}".`,
        },
      };
    }

    lease.renewedAtMs = now;
    lease.expiresAtMs =
      rawExplicitTtl !== undefined ? now + ttlMs : Math.max(lease.expiresAtMs || 0, now + ttlMs);
    return {
      mutated: true,
      value: { exitCode: 0, lease },
    };
  }, options);
}

export function cmdSnapshot(stateDir, action, name = null, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, SNAPSHOT_ALLOWED_FLAGS, "snapshot");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr };
  }
  const effectiveAction = action || (typeof flags.action === "string" ? flags.action : null);
  const effectiveName = name || (typeof flags.name === "string" ? flags.name : null);
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);

  if (effectiveAction === "list") {
    const targetAvd = flags.avd || null;
    const targetSerial = flags.serial || null;
    if (targetAvd && !targetSerial) {
      const meta = readLocalAvdMetadata(targetAvd, avdHome);
      if (meta.exists) {
        return { exitCode: 0, snapshots: meta.snapshots };
      }
    }
    const fleet = options.inventory || discoverFleet({ avdHome, runner });
    if (targetSerial || targetAvd) {
      const allDevs = [...(fleet.running || []), ...(fleet.offline || [])];
      const matched = allDevs.find(
        (d) =>
          d.kind === "emulator" &&
          (!targetSerial || d.serial === targetSerial) &&
          (!targetAvd || d.avd === targetAvd),
      );
      if (!matched) {
        const state = readState(stateDir);
        const leased = Object.values(state.leases || {}).find(
          (l) =>
            l.kind === "emulator" &&
            (!targetSerial || l.serial === targetSerial) &&
            (!targetAvd || l.avd === targetAvd) &&
            l.avd,
        );
        if (leased) {
          const meta = readLocalAvdMetadata(leased.avd, avdHome);
          return { exitCode: 0, snapshots: meta.snapshots };
        }
      }
      if (!matched) {
        return {
          exitCode: 1,
          error: `No emulator found matching ${targetSerial ? `serial "${targetSerial}"` : `AVD "${targetAvd}"`}.`,
        };
      }
      const snaps = Array.isArray(matched.snapshots)
        ? matched.snapshots
        : readLocalAvdMetadata(matched.avd, avdHome).snapshots;
      return { exitCode: 0, snapshots: snaps };
    }
    const byAvd = {};
    for (const d of [...fleet.running, ...fleet.offline]) {
      if (d.kind === "emulator" && d.avd) {
        byAvd[d.avd] = d.snapshots || [];
      }
    }
    return { exitCode: 0, snapshots: byAvd };
  }

  if (!["save", "load", "delete"].includes(effectiveAction)) {
    return {
      exitCode: 1,
      error: `Unknown snapshot action "${effectiveAction}". Expected list, save, load, or delete.`,
    };
  }

  if (!effectiveName || !/^[A-Za-z0-9._-]{1,64}$/.test(effectiveName)) {
    return {
      exitCode: 1,
      error: `Invalid snapshot name "${effectiveName}". Must match /^[A-Za-z0-9._-]{1,64}$/.`,
    };
  }

  const freeDiskMb =
    options.host?.freeDiskMb ??
    (effectiveAction === "save" && !flags.force ? readFreeDiskMb(avdHome) : 16384);

  const leaseCheck = withStateTransaction(stateDir, (state, { now }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
      ancestorPids: options.ancestorPids,
      processChain: options.processChain,
    });
    const owned = Object.values(state.leases).filter(
      (l) =>
        l.state === "active" &&
        l.kind === "emulator" &&
        l.sessionId === identity.sessionId &&
        (!flags.serial || l.serial === flags.serial) &&
        (!flags.avd || l.avd === flags.avd),
    );
    if (owned.length === 0) {
      return {
        mutated: false,
        value: { exitCode: 3, error: `Session "${identity.sessionId}" holds no active emulator lease.` },
      };
    }
    if (owned.length > 1 && !flags.serial && !flags.avd) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Session "${identity.sessionId}" holds multiple active emulator leases; pass --serial <serial> or --avd <avd>.`,
        },
      };
    }
    const lease = owned[0];
    const saveMeta =
      effectiveAction === "save"
        ? readLocalAvdMetadata(lease.avd, avdHome, state.config)
        : null;
    if (effectiveAction === "save" && !parseBoolFlag(flags.force) && saveMeta) {
      const meta = saveMeta;
      const minDisk = state.config.minFreeDiskMb ?? 2048;
      const targetFsKey =
        options.host?.freeDiskMb !== undefined
          ? "__injected_host__"
          : meta.fsDev || meta.avdPath || avdHome || "default";
      let reservedDiskMb = 0;
      for (const otherLease of Object.values(state.leases || {})) {
        if (
          !otherLease ||
          otherLease.kind !== "emulator" ||
          otherLease.deviceKey === lease.deviceKey
        ) {
          continue;
        }
        const otherFsKey =
          options.host?.freeDiskMb !== undefined
            ? "__injected_host__"
            : otherLease.fsDev || otherLease.avdPath || avdHome || "default";
        if (otherFsKey !== targetFsKey) continue;
        if (
          otherLease.state === "starting" &&
          typeof otherLease.requiredDiskMb === "number" &&
          otherLease.requiredDiskMb > 0
        ) {
          reservedDiskMb += otherLease.requiredDiskMb;
        } else if (
          typeof otherLease.pendingSnapshotDiskMb === "number" &&
          otherLease.pendingSnapshotDiskMb > 0
        ) {
          reservedDiskMb += otherLease.pendingSnapshotDiskMb;
        }
      }
      const effectiveFreeDiskMb =
        (options.host?.freeDiskMb ?? meta.freeDiskMb ?? freeDiskMb) - reservedDiskMb;
      if (effectiveFreeDiskMb < meta.ramSizeMb + minDisk) {
        return {
          mutated: false,
          value: {
            exitCode: 5,
            error: `Insufficient disk space (${effectiveFreeDiskMb}MB free) to save snapshot "${effectiveName}" on ${lease.avd}: needs ${meta.ramSizeMb + minDisk}MB free. Pass --force to bypass.`,
          },
        };
      }
    }
    if (!lease.serial) {
      return {
        mutated: false,
        value: {
          exitCode: 1,
          error: `Cannot ${effectiveAction} snapshot "${effectiveName}" on ${lease.avd || lease.deviceKey}: emulator has no active adb serial.`,
        },
      };
    }
    const ttlMs = (state.config.defaultTtlSec || 600) * 1000;
    const stopTimeoutMs = (state.config.stopTimeoutSec || 60) * 1000;
    const livenessCheck = options.livenessCheck || isPidAlive;
    const activeWorkers = syncLeaseWorkers(lease, livenessCheck).filter(
      (p) => p !== process.pid,
    );
    if (effectiveAction === "load" && activeWorkers.length > 0) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} (${lease.deviceKey}) has active in-flight worker(s) (${activeWorkers.join(", ")}); wait for completion before loading a snapshot.`,
        },
      };
    }
    addLeaseWorker(lease, process.pid, livenessCheck);
    if (effectiveAction === "save" && saveMeta) {
      lease.pendingSnapshotDiskMb = saveMeta.ramSizeMb || 2048;
      lease.fsDev = saveMeta.fsDev ?? lease.fsDev ?? null;
    } else if (effectiveAction === "load") {
      lease.state = "starting";
      lease.workerPid = process.pid;
      lease.deadlineMs = now + stopTimeoutMs;
      lease.loadedSnapshot = null;
    }
    lease.renewedAtMs = now;
    lease.expiresAtMs = Math.max(lease.expiresAtMs, now + Math.max(ttlMs, stopTimeoutMs * 2));
    return { mutated: true, value: { exitCode: 0, lease: { ...lease }, ttlMs, stopTimeoutMs } };
  }, options);

  if (leaseCheck.exitCode !== 0) {
    return leaseCheck;
  }

  const loadHb =
    effectiveAction === "load"
      ? startWorkerDeadlineHeartbeat(
          stateDir,
          leaseCheck.lease.deviceKey,
          leaseCheck.lease.leaseId,
          leaseCheck.stopTimeoutMs,
        )
      : null;

  const clearSnapshotWorker = (markLoaded = false) => {
    loadHb?.stop();
    const updated = finishLeaseWorker(
      stateDir,
      leaseCheck.lease.deviceKey,
      leaseCheck.lease.leaseId,
      leaseCheck.ttlMs,
      options,
      (cur) => {
        if (effectiveAction === "save") {
          delete cur.pendingSnapshotDiskMb;
        } else if (effectiveAction === "load") {
          cur.state = "active";
          cur.deadlineMs = null;
          cur.loadedSnapshot = markLoaded ? effectiveName : null;
        } else if (
          markLoaded &&
          effectiveAction === "delete" &&
          cur.loadedSnapshot === effectiveName
        ) {
          cur.loadedSnapshot = null;
        }
      },
    );
    return updated;
  };

  let res;
  try {
    res = runner(
      "adb",
      ["-s", leaseCheck.lease.serial, "emu", "avd", "snapshot", effectiveAction, effectiveName],
      { strictInternal: true, timeoutMs: leaseCheck.stopTimeoutMs },
    );
  } catch (err) {
    clearSnapshotWorker(false);
    return { exitCode: 1, error: err.message };
  }
  if (res.status !== 0) {
    clearSnapshotWorker(false);
    return {
      exitCode: 1,
      error: `adb snapshot ${effectiveAction} "${effectiveName}" failed: ${res.stderr || res.stdout}`,
    };
  }

      if ( effectiveAction === "load") {
    try {
      const stillOwnedBeforeWait = withStateTransaction(
        stateDir,
        (state) => {
          const { lease: cur } = findLeaseEntry(
            state,
            leaseCheck.lease.deviceKey,
            leaseCheck.lease.leaseId,
          );
          return {
            mutated: false,
            value: Boolean(
              cur &&
                cur.leaseId === leaseCheck.lease.leaseId &&
                cur.state === "starting" &&
                cur.workerPid === process.pid,
            ),
          };
        },
        options,
      );
      if (!stillOwnedBeforeWait) {
        throw new Error(`Lease ${leaseCheck.lease.leaseId} was lost during snapshot load.`);
      }
      waitForEmulatorReady(runner, leaseCheck.lease.serial, leaseCheck.stopTimeoutMs);
    } catch (err) {
      clearSnapshotWorker(false);
      return { exitCode: 1, error: err.message };
    }
  }

  const finalLease = clearSnapshotWorker(true);
  if (!finalLease) {
    return {
      exitCode: 1,
      error: `Lease ${leaseCheck.lease.leaseId} was lost during snapshot ${effectiveAction}.`,
    };
  }

  return { exitCode: 0, lease: finalLease, snapshot: effectiveName, action: effectiveAction };
}

export async function cmdExec(stateDir, commandArgs, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, EXEC_ALLOWED_FLAGS, "exec");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr };
  }
  if (!commandArgs || commandArgs.length === 0) {
    return { exitCode: 1, error: "Usage: atc exec [--serial <serial>] -- <command> [args...]" };
  }

  const check = withStateTransaction(stateDir, (state, { now }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
      ancestorPids: options.ancestorPids,
      processChain: options.processChain,
    });
    const owned = Object.values(state.leases).filter(
      (l) =>
        l.state === "active" &&
        l.sessionId === identity.sessionId &&
        (!flags.serial || l.serial === flags.serial),
    );
    if (owned.length === 0) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Session "${identity.sessionId}" holds no active device lease. Run "atc claim" first.`,
        },
      };
    }
    if (owned.length > 1 && !flags.serial) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Session "${identity.sessionId}" holds multiple active leases; pass --serial <serial>.`,
        },
      };
    }
    const lease = owned[0];
    if (!lease.serial) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} (${lease.avd || lease.deviceKey}) has no active adb serial because its last restart failed; run "atc claim" to restart it.`,
        },
      };
    }
    const [cmd, ...args] = commandArgs;
    const wrappedClass = classifySegment(
      [cmd, ...args]
        .map((a) => (/[\s"'\\]/.test(String(a)) ? JSON.stringify(String(a)) : String(a)))
        .join(" "),
      lease.serial ? { ANDROID_SERIAL: lease.serial } : {},
    );
    if (wrappedClass.kind === "deny_lifecycle") {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: wrappedClass.reason,
        },
      };
    }
    if (
      wrappedClass.targetSerial &&
      lease.serial &&
      wrappedClass.targetSerial !== lease.serial
    ) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Conflicting device selector "${wrappedClass.targetSerial}" in atc exec; lease ${lease.leaseId} is bound to "${lease.serial}".`,
        },
      };
    }
    try {
      buildChildInvocation(cmd, args, lease, identity.sessionId, options.env);
    } catch (err) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: err.message,
        },
      };
    }
    const ttlMs = (state.config.defaultTtlSec || 600) * 1000;
    addLeaseWorker(lease, process.pid, options.livenessCheck || isPidAlive);
    if (wrappedClass.kind !== "read_only") {
      lease.loadedSnapshot = null;
    }
    lease.renewedAtMs = now;
    lease.expiresAtMs = Math.max(lease.expiresAtMs, now + ttlMs);
    return {
      mutated: true,
      value: {
        exitCode: 0,
        lease,
        sessionId: identity.sessionId,
        ttlMs,
      },
    };
  }, options);

  if (check.exitCode !== 0) {
    return check;
  }

  const [cmd, ...args] = commandArgs;
  const heartbeatIntervalMs = Math.min(60_000, Math.max(1000, Math.floor(check.ttlMs / 3)));
  const onHeartbeat = () => {
    withStateTransaction(stateDir, (state, { now }) => {
      const { lease: cur } = findLeaseEntry(
        state,
        check.lease.deviceKey,
        check.lease.leaseId,
      );
      if (cur && cur.leaseId === check.lease.leaseId && cur.sessionId === check.sessionId) {
        syncLeaseWorkers(cur, options.livenessCheck || isPidAlive);
        cur.renewedAtMs = now;
        cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + check.ttlMs);
        return { mutated: true };
      }
      return { mutated: false };
    }, options);
  };

  let spawnedChildPid = null;
  const onChildSpawn = (childPid, { isProcessGroup } = {}) => {
    spawnedChildPid = childPid;
    try {
      if (
        isProcessGroup &&
        !options.livenessCheck &&
        (options.platform || process.platform) === "win32"
      ) {
        snapshotProcessGroupsOutsideLock([childPid], {
          spawnSyncFn: options.spawnSyncFn,
          platform: options.platform,
        });
      }
      withStateTransaction(
        stateDir,
        (state) => {
          const { lease: cur } = findLeaseEntry(
            state,
            check.lease.deviceKey,
            check.lease.leaseId,
          );
          if (cur && cur.leaseId === check.lease.leaseId && cur.sessionId === check.sessionId) {
            addLeaseWorker(cur, childPid, options.livenessCheck || isPidAlive, {
              isProcessGroup: Boolean(isProcessGroup),
            });
            return { mutated: true };
          }
          return { mutated: false };
        },
        options,
      );
    } catch {
      // Best-effort child PID registration
    }
  };

  try {
    const exitCode = await spawnWithHeartbeat(
      cmd,
      args,
      check.lease,
      check.sessionId,
      onHeartbeat,
      {
        ...options,
        heartbeatIntervalMs,
        onChildSpawn,
      },
    );
    return { exitCode };
  } finally {
    try {
      let keepSpawnedChildGroup = false;
      if (spawnedChildPid && !options.livenessCheck) {
        try {
          keepSpawnedChildGroup = hasAliveProcessInGroup(spawnedChildPid, {
            allowSubprocess: true,
            spawnSyncFn: options.spawnSyncFn,
            platform: options.platform,
          });
        } catch {
          keepSpawnedChildGroup = false;
        }
      }
      finishLeaseWorker(
        stateDir,
        check.lease.deviceKey,
        check.lease.leaseId,
        check.ttlMs,
        options,
        (cur) => {
          if (spawnedChildPid) {
            if (keepSpawnedChildGroup) {
              syncLeaseWorkers(cur, options.livenessCheck || isPidAlive);
            } else {
              removeLeaseWorker(cur, spawnedChildPid, options.livenessCheck || isPidAlive);
            }
          }
        },
      );
    } catch {
      // Best-effort workerPid cleanup
    }
  }
}

export function cmdStatus(stateDir, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, STATUS_ALLOWED_FLAGS, "status");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr };
  }
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);
  const preState = readState(stateDir);
  const cfg = preState.config || DEFAULT_CONFIG;
  const inventoryEpoch = preState.fleetEpoch || 0;
  const discoveryStartedAtMs = Date.now();
  const rawInventory =
    options.inventory ||
    discoverFleet({
      runner,
      avdHome,
      cfg,
      platform: options.platform,
      livenessCheck: options.livenessCheck,
    });
  const inventory = options.inventory
    ? rawInventory
    : {
        ...rawInventory,
        discoveredAtMs: rawInventory.discoveredAtMs ?? discoveryStartedAtMs,
        fleetEpoch: rawInventory.fleetEpoch ?? inventoryEpoch,
      };
  const req = {
    kind: flags.kind || "any",
    deviceType: flags.type || null,
    apiSpec: flags.api ? String(flags.api) : null,
    services: flags.services || null,
    play: typeof flags.play === "boolean" ? flags.play : null,
    abi: flags.abi || null,
  };

  return withStateTransaction(
    stateDir,
    (state, { now }) => {
      reconcileOfflineLeases(
        state,
        inventory,
        null,
        now,
        options.livenessCheck || isPidAlive,
        avdHome,
      );
      const effectiveMaxEmulators = computeEffectiveMaxEmulators(state.config, inventory.host);
      const usedSlots = computeUsedEmulatorSlots(state, inventory);
      const running = (inventory.running || []).filter((d) => matchesProfile(d, req));
      const offline = (inventory.offline || []).filter((d) => matchesProfile(d, req));
      const creatable = (inventory.creatable || []).filter((d) =>
        matchesProfile({ ...d, kind: d.kind || "emulator" }, req),
      );

      return {
        mutated: true,
        value: {
          exitCode: 0,
          hostCapacity: {
            ...inventory.host,
            usedSlots,
            effectiveMaxEmulators,
            minFreeRamMb: state.config.minFreeRamMb,
            minFreeDiskMb: state.config.minFreeDiskMb,
          },
          fleet: {
            running,
            offline,
            creatable,
          },
          leases: state.leases,
          queue: state.queue,
          config: state.config,
        },
      };
    },
    options,
  );
}

export function cmdConfig(stateDir, action, key = null, val = null) {
  return withStateTransaction(stateDir, (state) => {
    if (!action || action === "get") {
      if (!key) {
        return { mutated: false, value: { exitCode: 0, config: state.config } };
      }
      return { mutated: false, value: { exitCode: 0, key, value: state.config[key] } };
    }
    if (action === "set") {
      if (!key || !(key in DEFAULT_CONFIG)) {
        return {
          mutated: false,
          value: { exitCode: 1, error: `Unknown config key "${key}".` },
        };
      }
      if (val === undefined || val === null || (typeof val === "string" && !val.trim())) {
        return {
          mutated: false,
          value: {
            exitCode: 1,
            error: `Missing value for config key "${key}". Usage: atc config set <key> <val>`,
          },
        };
      }
      let parsedVal = val;
      if (key === "maxRunningEmulators") {
        if (val === "auto") {
          parsedVal = "auto";
        } else if (/^\d+$/.test(String(val)) && Number(val) >= 1) {
          parsedVal = Number(val);
        } else {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: 'maxRunningEmulators must be "auto" or an integer >= 1.',
            },
          };
        }
      } else if (typeof DEFAULT_CONFIG[key] === "number") {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          return {
            mutated: false,
            value: { exitCode: 1, error: `Config key "${key}" requires a non-negative number.` },
          };
        }
        if ((key === "bootTimeoutSec" || key === "stopTimeoutSec") && n < 5) {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `Config key "${key}" must be at least 5 seconds.`,
            },
          };
        }
        if ((key === "defaultTtlSec" || key === "maxTtlSec") && n < 10) {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `Config key "${key}" must be at least 10 seconds.`,
            },
          };
        }
        if (key === "queueHeartbeatTimeoutSec" && n < 5) {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `Config key "${key}" must be at least 5 seconds.`,
            },
          };
        }
        parsedVal = Math.round(n);
        if (key === "defaultTtlSec" && parsedVal > (state.config.maxTtlSec ?? 3600)) {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `defaultTtlSec (${parsedVal}) cannot exceed maxTtlSec (${state.config.maxTtlSec ?? 3600}).`,
            },
          };
        }
        if (key === "maxTtlSec" && (state.config.defaultTtlSec ?? 600) > parsedVal) {
          state.config.defaultTtlSec = parsedVal;
        }
      } else if (typeof DEFAULT_CONFIG[key] === "boolean") {
        const norm = String(val).trim().toLowerCase();
        if (norm === "true" || norm === "1") {
          parsedVal = true;
        } else if (norm === "false" || norm === "0") {
          parsedVal = false;
        } else {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `Config key "${key}" requires a boolean value ("true" or "false").`,
            },
          };
        }
      }
      state.config[key] = parsedVal;
      return { mutated: true, value: { exitCode: 0, key, value: parsedVal } };
    }
    return {
      mutated: false,
      value: { exitCode: 1, error: `Unknown config action "${action}". Use get or set.` },
    };
  });
}

export function cmdGc(stateDir, options = {}) {
  const terminatedPgids = [];
  try {
    const preLiveness = options.livenessCheck || isPidAlive;
    const preState = readState(stateDir);
    const now = options.now ?? Date.now();
    const cfg = preState.config || DEFAULT_CONFIG;
    const maxTtlMs = (cfg.maxTtlSec || 3600) * 1000;
    for (const lease of Object.values(preState.leases || {})) {
      if (!lease || typeof lease !== "object") continue;
      if (!Array.isArray(lease.workerPgids) || lease.workerPgids.length === 0) continue;
      const pgidSet = new Set(lease.workerPgids.map(Number));
      const hasLiveWrapperPid = (lease.workerPids || []).some((p) => {
        const num = Number(p);
        return !pgidSet.has(num) && preLiveness(num);
      });
      if (hasLiveWrapperPid) continue;
      const lastRenewedMs =
        typeof lease.renewedAtMs === "number" ? lease.renewedAtMs : lease.claimedAtMs;
      const isExpired =
        now >= lease.expiresAtMs ||
        now < lease.claimedAtMs ||
        (typeof lastRenewedMs === "number" && now > lastRenewedMs + maxTtlMs);
      const isDeadAnchor =
        lease.anchorPid !== null &&
        lease.anchorPid !== undefined &&
        !preLiveness(lease.anchorPid);
      if (isExpired || isDeadAnchor || Boolean(lease.releaseOnWorkerExit)) {
        killProcessGroupTree(lease, "SIGKILL", {
          spawnSyncFn: options.spawnSyncFn || options.runner,
          platform: options.platform,
        });
        terminatedPgids.push(...lease.workerPgids.map(Number));
      }
    }
  } catch {
    // Best-effort pre-lock orphan tree termination
  }
  return withStateTransaction(
    stateDir,
    (_state, { pruned }) => {
      return { mutated: true, value: { exitCode: 0, pruned } };
    },
    terminatedPgids.length > 0 ? { ...options, terminatedPgids } : options,
  );
}

export function cmdGuard(stateDir, commandStr, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, GUARD_ALLOWED_FLAGS, "guard");
  if (unknownFlagErr) {
    return { exitCode: 1, allowed: false, reason: unknownFlagErr, error: unknownFlagErr };
  }
  const inventory = options.inventory || null;
  let probedRunningCount = inventory ? (inventory.running || []).length : 0;

  if (!inventory && options.runningCount === undefined) {
    const hasUnscopedDeviceAction = splitShellSegments(commandStr).some((seg) => {
      const c = classifySegment(seg);
      return c.kind === "device_action" && !c.targetSerial;
    });
    if (hasUnscopedDeviceAction) {
      const runner = options.runner || runCommandSync;
      const adbRes = runner("adb", ["devices"], { timeoutMs: 3000 });
      if (adbRes.status === 0 && adbRes.stdout !== undefined && adbRes.stdout !== null) {
        probedRunningCount = parseAdbDevicesOutput(adbRes.stdout).length;
      } else {
        probedRunningCount = 2;
      }
    }
  } else if (options.runningCount !== undefined) {
    probedRunningCount = options.runningCount;
  }

  const evalRes = withStateTransaction(stateDir, (state, { now }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
      ancestorPids: options.ancestorPids,
      processChain: options.processChain,
    });
    const activeLeases = Object.values(state.leases).filter(
      (l) => l.state === "active" && l.sessionId === identity.sessionId,
    );
    const totalLeasedCount = Object.keys(state.leases).length;
    const runningCount = Math.max(probedRunningCount, totalLeasedCount, activeLeases.length);
    const guard = evaluateCommandGuard(commandStr, {
      sessionId: identity.sessionId,
      anchorPid: identity.anchorPid,
      activeLeases,
      runningCount,
      platform: options.platform,
    });
    let mutated = false;
    if (guard.allowed && guard.renewLease && activeLeases.length > 0) {
      const ttlMs = (state.config?.defaultTtlSec ?? DEFAULT_CONFIG.defaultTtlSec ?? 600) * 1000;
      const targeted =
        Array.isArray(guard.targetSerials) && guard.targetSerials.length > 0
          ? new Set(guard.targetSerials)
          : guard.targetSerial
            ? new Set([guard.targetSerial])
            : null;
      for (const lease of activeLeases) {
        if (!targeted || targeted.has(lease.serial)) {
          lease.loadedSnapshot = null;
          lease.renewedAtMs = now;
          lease.expiresAtMs = Math.max(lease.expiresAtMs || 0, now + ttlMs);
          mutated = true;
        }
      }
    }
    return { mutated, value: guard };
  }, options);

  return {
    exitCode: evalRes.allowed ? 0 : 2,
    ...evalRes,
  };
}

export async function runCli(argv = process.argv.slice(2), env = process.env, options = {}) {
  const parsed = parseCliArgs(argv);
  const stateDir = resolveStateDir(env.ATC_STATE_DIR);

  if (parsed.flags.version || parsed.flags.v || parsed.subcommand === "version") {
    if (parsed.flags.json) {
      process.stdout.write(JSON.stringify({ version: ATC_VERSION }, null, 2) + "\n");
    } else {
      process.stdout.write(`${ATC_VERSION}\n`);
    }
    return 0;
  }

  if (parsed.flags.help || parsed.flags.h || parsed.subcommand === "help") {
    const helpTopic =
      parsed.subcommand === "help" ? parsed.positionals[0] : parsed.subcommand;
    if (helpTopic === "guide") {
      process.stdout.write(
        `Usage: atc guide [workflow|profiles|snapshots|multi-agent|traps] [--json]\n\n` +
          `Without a topic, prints the workflow guide. Read it before your first claim.\n\n` +
          `  workflow     claim -> exec -> snapshot -> free loop, rules, and done checklist\n` +
          `  profiles     3-tier fleet discovery, profile flags, and physical device safety\n` +
          `  snapshots    QEMU snapshots, wipe/cold/reset-app flags, and RAM/disk guardrails\n` +
          `  multi-agent  session identity, warm-affinity queue, hooks, guard, and MCP\n` +
          `  traps        common Android/ADB/multi-agent failure modes and how atc fixes them\n`,
      );
      return 0;
    }
    process.stdout.write(
      `Android Traffic Control (atc)\n\n` +
        `Usage:\n` +
        `  atc guide [workflow|profiles|snapshots|multi-agent|traps] [--json]\n` +
        `  atc claim [--type <type>] [--api <spec>] [--play|--no-play] [--snapshot-load <name>] [--ttl <sec>] [--wait <sec>]\n` +
        `  atc free [<target>] [--snapshot-save <name>] [--snapshot-load <name>] [--stop]\n` +
        `  atc renew [<target>] [--ttl <sec>]\n` +
        `  atc snapshot <list|save|load|delete> [<name>]\n` +
        `  atc exec -- <command> [args...]\n` +
        `  atc status [--type <type>] [--api <spec>] [--json]\n` +
        `  atc config <get|set> [key] [val]\n` +
        `  atc gc\n` +
        `  atc guard [--format=json] <command>\n` +
        `  atc hook <pre-tool-use|stop>\n` +
        `  atc mcp\n`,
    );
    return 0;
  }

  switch (parsed.subcommand) {
    case "guide": {
      const unknownFlagErr = validateCommandFlags(parsed.flags, GUIDE_ALLOWED_FLAGS, "guide");
      if (unknownFlagErr) {
        process.stderr.write(`[atc] ${unknownFlagErr}\n`);
        return 1;
      }
      if (
        parsed.positionals.length > 1 ||
        (parsed.positionals.length > 0 && parsed.flags.topic !== undefined)
      ) {
        const extra =
          parsed.positionals.length > 1 ? parsed.positionals[1] : parsed.positionals[0];
        process.stderr.write(`[atc] Unexpected argument "${extra}" for "atc guide".\n`);
        return 1;
      }
      const topicArg =
        parsed.positionals[0] ||
        (typeof parsed.flags.topic === "string" ? parsed.flags.topic : "workflow");
      const res = cmdGuide(topicArg);
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      if (parsed.flags.json) {
        process.stdout.write(
          JSON.stringify({ topic: res.topic, topics: res.topics, text: res.text }, null, 2) + "\n",
        );
      } else {
        process.stdout.write(res.text.endsWith("\n") ? res.text : res.text + "\n");
      }
      return 0;
    }

    case "claim": {
      if (parsed.positionals.length > 0) {
        process.stderr.write(
          `[atc] Unexpected argument "${parsed.positionals[0]}" for "atc claim".\n`,
        );
        return 1;
      }
      const res = cmdClaim(stateDir, parsed.flags, { env });
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      if (parsed.flags.json) {
        process.stdout.write(JSON.stringify(res.lease, null, 2) + "\n");
      } else {
        const l = res.lease;
        process.stdout.write(
          `✓ Claimed ${l.avd || l.serial} (${l.serial})\n` +
            `  lease:   ${l.leaseId} · profile: ${l.profile?.deviceType || l.kind} / ${l.profile?.apiLevel || "physical"}\n` +
            `  session: ${l.sessionId}\n`,
        );
      }
      return 0;
    }

    case "free": {
      if (
        parsed.positionals.length > 1 ||
        (parsed.positionals.length > 0 && parsed.flags.target !== undefined)
      ) {
        const extra =
          parsed.positionals.length > 1 ? parsed.positionals[1] : parsed.positionals[0];
        process.stderr.write(`[atc] Unexpected argument "${extra}" for "atc free".\n`);
        return 1;
      }
      const targetArg =
        parsed.positionals[0] ||
        (typeof parsed.flags.target === "string" ? parsed.flags.target : null);
      const res = cmdFree(stateDir, targetArg, parsed.flags, { env });
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      if (parsed.flags.json) {
        process.stdout.write(JSON.stringify({ freed: res.freed }, null, 2) + "\n");
      } else {
        process.stdout.write(
          res.freed.length > 0
            ? `✓ Freed lease(s): ${res.freed.join(", ")}\n`
            : `✓ No active leases to free.\n`,
        );
      }
      return 0;
    }

    case "renew": {
      if (
        parsed.positionals.length > 1 ||
        (parsed.positionals.length > 0 && parsed.flags.target !== undefined)
      ) {
        const extra =
          parsed.positionals.length > 1 ? parsed.positionals[1] : parsed.positionals[0];
        process.stderr.write(`[atc] Unexpected argument "${extra}" for "atc renew".\n`);
        return 1;
      }
      const targetArg =
        parsed.positionals[0] ||
        (typeof parsed.flags.target === "string" ? parsed.flags.target : null);
      const res = cmdRenew(stateDir, targetArg, parsed.flags, { env });
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      process.stdout.write(`✓ Renewed ${res.lease.leaseId} (${res.lease.serial})\n`);
      return 0;
    }

    case "snapshot": {
      if (
        parsed.positionals.length > 2 ||
        (parsed.positionals[0] === "list" && parsed.positionals.length > 1)
      ) {
        const extra =
          parsed.positionals[0] === "list" ? parsed.positionals[1] : parsed.positionals[2];
        process.stderr.write(`[atc] Unexpected argument "${extra}" for "atc snapshot".\n`);
        return 1;
      }
      const [action, name] = parsed.positionals;
      const res = cmdSnapshot(stateDir, action, name, parsed.flags, { env });
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      process.stdout.write(JSON.stringify(res.snapshots ?? res, null, 2) + "\n");
      return 0;
    }

    case "exec": {
      const cmdTokens =
        parsed.restAfterDash.length > 0 ? parsed.restAfterDash : parsed.positionals;
      const res = await cmdExec(stateDir, cmdTokens, parsed.flags, { env });
      if (res.error) {
        process.stderr.write(`[atc] ${res.error}\n`);
      }
      return res.exitCode;
    }

    case "status": {
      if (parsed.positionals.length > 0) {
        process.stderr.write(
          `[atc] Unexpected argument "${parsed.positionals[0]}" for "atc status".\n`,
        );
        return 1;
      }
      const res = cmdStatus(stateDir, parsed.flags, { env });
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      if (parsed.flags.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else {
        const hc = res.hostCapacity;
        process.stdout.write(
          `Host Capacity: ${hc.availableRamMb} MB RAM avail · ${hc.freeDiskMb} MB disk free · slots: ${hc.usedSlots}/${hc.effectiveMaxEmulators} used\n`,
        );
        process.stdout.write(`  Running (${res.fleet.running.length}): ${res.fleet.running.map((d) => `${d.avd || d.serial} (${d.serial})`).join(", ") || "none"}\n`);
        process.stdout.write(`  Offline (${res.fleet.offline.length}): ${res.fleet.offline.map((d) => d.avd).join(", ") || "none"}\n`);
        process.stdout.write(`  Leases  (${Object.keys(res.leases).length}): ${Object.keys(res.leases).join(", ") || "none"}\n`);
        process.stdout.write(`  Queue   (${res.queue.length}): ${res.queue.map((q) => q.ticketId).join(", ") || "none"}\n`);
      }
      return 0;
    }

    case "config": {
      const unknownFlagErr = validateCommandFlags(parsed.flags, COMMON_ALLOWED_FLAGS, "config");
      if (unknownFlagErr) {
        process.stderr.write(`[atc] ${unknownFlagErr}\n`);
        return 1;
      }
      if (
        parsed.positionals.length > 3 ||
        (parsed.positionals[0] === "get" && parsed.positionals.length > 2)
      ) {
        const extra =
          parsed.positionals[0] === "get" ? parsed.positionals[2] : parsed.positionals[3];
        process.stderr.write(`[atc] Unexpected argument "${extra}" for "atc config".\n`);
        return 1;
      }
      const [action, key, val] = parsed.positionals;
      const res = cmdConfig(stateDir, action, key, val);
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      process.stdout.write(JSON.stringify(res.config ?? { [res.key]: res.value }, null, 2) + "\n");
      return 0;
    }

    case "gc": {
      const unknownFlagErr = validateCommandFlags(parsed.flags, COMMON_ALLOWED_FLAGS, "gc");
      if (unknownFlagErr) {
        process.stderr.write(`[atc] ${unknownFlagErr}\n`);
        return 1;
      }
      if (parsed.positionals.length > 0) {
        process.stderr.write(
          `[atc] Unexpected argument "${parsed.positionals[0]}" for "atc gc".\n`,
        );
        return 1;
      }
      const res = cmdGc(stateDir);
      process.stdout.write(JSON.stringify(res.pruned, null, 2) + "\n");
      return 0;
    }

    case "guard": {
      const cmdTokens =
        parsed.restAfterDash.length > 0 ? parsed.restAfterDash : parsed.positionals;
      let cmdStr = cmdTokens.join(" ");
      if (!cmdStr) {
        const rawStdin = readStdinSync();
        if (rawStdin && rawStdin.trim()) {
          try {
            const payload = JSON.parse(rawStdin);
            cmdStr = payload.command ?? payload.CommandLine ?? "";
          } catch {
            cmdStr = rawStdin.trim();
          }
        }
      }
      const res = cmdGuard(stateDir, cmdStr, parsed.flags, { env });
      if (parsed.flags.format === "json" || parsed.flags.json) {
        process.stdout.write(JSON.stringify(res) + "\n");
      } else if (!res.allowed) {
        process.stderr.write(`${res.reason}\n`);
      } else if (res.rewrittenCommand) {
        process.stdout.write(`${res.rewrittenCommand}\n`);
      }
      return res.exitCode;
    }

    case "hook": {
      const unknownFlagErr = validateCommandFlags(parsed.flags, COMMON_ALLOWED_FLAGS, "hook");
      if (unknownFlagErr) {
        process.stderr.write(`[atc] ${unknownFlagErr}\n`);
        return 1;
      }
      if (parsed.positionals.length > 1) {
        process.stderr.write(
          `[atc] Unexpected argument "${parsed.positionals[1]}" for "atc hook".\n`,
        );
        return 1;
      }
      const hookType = String(parsed.positionals[0] || "pre-tool-use").toLowerCase();
      const rawStdin = readStdinSync();
      if (
        hookType === "stop" ||
        hookType === "sessionend" ||
        hookType === "session-end" ||
        hookType === "session_end" ||
        hookType === "session_shutdown"
      ) {
        const res = handleStopHook(stateDir, rawStdin);
        return res.exitCode;
      }
      const res = handlePreToolUseHook(stateDir, rawStdin);
      if (res.stderr) process.stderr.write(res.stderr);
      if (res.stdout) process.stdout.write(res.stdout);
      return res.exitCode;
    }

    case "mcp": {
      const unknownFlagErr = validateCommandFlags(parsed.flags, COMMON_ALLOWED_FLAGS, "mcp");
      if (unknownFlagErr) {
        process.stderr.write(`[atc] ${unknownFlagErr}\n`);
        return 1;
      }
      if (parsed.positionals.length > 0) {
        process.stderr.write(
          `[atc] Unexpected argument "${parsed.positionals[0]}" for "atc mcp".\n`,
        );
        return 1;
      }
      await startMcpServer(stateDir, {
        ...options,
        env,
        sessionId:
          (typeof parsed.flags.session === "string" && parsed.flags.session.trim()) ||
          (typeof parsed.flags.role === "string" && parsed.flags.role.trim()) ||
          options.sessionId,
        anchorPid: parsed.flags.anchorPid ?? options.anchorPid,
        flags: parsed.flags,
      });
      return 0;
    }

    default: {
      process.stderr.write(`[atc] Unknown subcommand "${parsed.subcommand}". Run "atc --help" for usage.\n`);
      return 1;
    }
  }
}
