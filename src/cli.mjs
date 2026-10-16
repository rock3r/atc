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
import {
  checkUnifiedRamAdmission,
  computeBuildPoolSnapshot,
  computeColdBuildRamDemandMb,
  computeEffectiveMaxBuilds,
  evaluateNestedBuildAdmission,
  hasValidPinnedDeviceLease,
  probeWarmBuildDaemons,
  pruneAndSelectNextBuildTicket,
  reconcileBuildLease,
  resolveBuildResources,
} from "./build.mjs";
import { classifySegment, evaluateCommandGuard, splitShellSegments } from "./guard.mjs";
import { cmdExecTokens, renderExecResult } from "./exec.mjs";
import { GUIDE_TOPICS, cmdGuide } from "./guide.mjs";
import { handlePreToolUseHook, handleStopHook, readStdinSync } from "./hook.mjs";
import {
  bootIosSimulator,
  createIosSimulator,
  deleteIosSimulatorSnapshot,
  diagnosePlatformToolingError,
  discoverIosFleet,
  eraseIosSimulator,
  listIosSimulatorSnapshots,
  loadIosSimulatorSnapshot,
  parseSimctlListJson,
  resetIosSimulatorApp,
  resolveSimulatorDataDir,
  resolveTargetPlatform,
  runAppleToolSync,
  saveIosSimulatorSnapshot,
  shutdownIosSimulator,
  waitForIosSimulatorBooted,
} from "./ios.mjs";
import {
  isPidAlive,
  randomNonce,
  resolveStateDir,
  sleepSync,
  withLock,
} from "./lock.mjs";
import { resolveAuditLogPath } from "./logger.mjs";
import { startMcpServer } from "./mcp.mjs";
import { buildChildInvocation, prepareOpChildInvocation, runCommandSync, spawnWithHeartbeat } from "./spawn.mjs";
import {
  DEFAULT_CONFIG,
  addLeaseWorker,
  archiveWindowsProcessGroupGeneration,
  avdHasRuntimeLockFiles,
  canJumpAhead,
  commitState,
  computeEffectiveMaxEmulators,
  computeEffectiveMaxSimulators,
  computeUsedEmulatorSlots,
  computeUsedSimulatorSlots,
  findConflictingLeaseSelector,
  getAncestorPids,
  getAncestorProcessChain,
  getKnownPosixPgidStartToken,
  getKnownWindowsTreePids,
  getPosixProcessStartToken,
  hasAliveProcessInGroup,
  isTicketStarvationProtected,
  killProcessGroupTree,
  matchesProfile,
  normalizeDeviceType,
  offlineAvdHasRuntimeLockFiles,
  queryWindowsProcessGroups,
  readState,
  reconcileOfflineLeases,
  recordDeviceBootedInState,
  recordDeviceStoppedInState,
  removeLeaseWorker,
  resolveSessionIdentity,
  resolveStableParentPid,
  seedPosixPgidStartTokens,
  snapshotProcessGroupsOutsideLock,
  syncLeaseWorkers,
  withStateTransaction,
} from "./state.mjs";

export const ATC_VERSION = "2.1.0";
export { GUIDE_TOPICS, cmdGuide };

function isWorkerGroupLeaderAlive(pgid, lease, livenessCheck = isPidAlive, options = {}) {
  const isQualified = typeof pgid === "string" && pgid.includes("@");
  const keyStr = isQualified ? pgid.trim() : null;
  const num = Number(isQualified ? keyStr.split("@")[0] : pgid);
  if (!Number.isInteger(num) || num <= 1) return false;
  if (num === options.callerWorkerPid) return false;
  const descKey = isQualified ? keyStr : String(num);
  const descEntries = lease?.workerDescendants?.[descKey];
  if (Array.isArray(descEntries)) {
    const rootEntry = descEntries.find(
      (item) => item && typeof item === "object" && Number(item.pid ?? item.ProcessId) === num,
    );
    if (
      rootEntry &&
      (rootEntry.alive === false ||
        String(rootEntry.creationDate ?? rootEntry.CreationDate ?? "").trim() === "__exited__")
    ) {
      return false;
    }
  }
  if (!livenessCheck(num)) {
    return false;
  }
  const effectivePlatform = options.platform || process.platform;
  if (effectivePlatform === "win32") {
    const targetKey = isQualified ? keyStr : num;
    const qRes = queryWindowsProcessGroups(
      [targetKey],
      options.spawnSyncFn || options.runner,
      {
        knownDescendants: lease?.workerDescendants,
        pgidStartTokens:
          options.pgidStartTokens || lease?.workerPgidStartTokens || null,
        lease,
        triState: true,
      },
    );
    if (qRes.refreshed && qRes.get(targetKey) !== null) {
      return getKnownWindowsTreePids(targetKey, { liveOnly: true }).includes(num);
    }
    return true;
  }
  const expectedStartToken =
    (isQualified ? keyStr.slice(keyStr.indexOf("@") + 1).trim() : null) ||
    lease?.workerPgidStartTokens?.[String(num)] ||
    getKnownPosixPgidStartToken(num) ||
    null;
  if (expectedStartToken) {
    const actualStartToken = getPosixProcessStartToken(num, {
      spawnSyncFn: options.spawnSyncFn || options.runner,
      platform: effectivePlatform,
      expectedToken: expectedStartToken,
    });
    if (actualStartToken !== null && actualStartToken !== expectedStartToken) {
      return false;
    }
  }
  return true;
}

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
  "ios",
  "android",
  "build",
  "claim",
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
  "platform",
  "ios",
  "android",
  "kind",
  "avd",
  "udid",
  "serial",
  "type",
  "api",
  "os",
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
  "platform",
  "ios",
  "android",
  "target",
  "snapshotSave",
  "snapshotLoad",
  "stop",
  "shutdown",
  "force",
]);

const RENEW_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "platform",
  "ios",
  "android",
  "target",
  "ttl",
  "ttlSec",
]);

const SNAPSHOT_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "platform",
  "ios",
  "android",
  "action",
  "name",
  "avd",
  "udid",
  "serial",
  "force",
]);

const EXEC_ALLOWED_FLAGS = new Set([
  ...CLAIM_ALLOWED_FLAGS,
  "build",
  "claim",
  "workspace",
  "phase",
  "ramMb",
  "ram-mb",
]);

const BATCH_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "file",
  "spec",
  "workspace",
  "wait",
  "waitSec",
]);

const VALID_EXEC_PHASES = new Set(["pure-build", "device-build", "device-test", "read-only"]);

const STATUS_ALLOWED_FLAGS = new Set([
  ...COMMON_ALLOWED_FLAGS,
  "platform",
  "ios",
  "android",
  "kind",
  "type",
  "api",
  "os",
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
    "workspace",
    "phase",
    "ramMb",
    "ram-mb",
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

function tokenizeClaimSelectorString(raw) {
  const tokens = [];
  let cur = "";
  let quote = null;
  const s = String(raw || "").trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) {
    tokens.push(cur);
  }
  return tokens;
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
    if (tok === "--claim") {
      flags.claim = true;
      if (i + 1 < mainArgs.length) {
        const nextTok = String(mainArgs[i + 1]);
        if (/\s/.test(nextTok)) {
          const extraTokens = tokenizeClaimSelectorString(mainArgs[++i]);
          mainArgs.splice(i + 1, 0, ...extraTokens);
        }
      }
      continue;
    }
    if (
      [
        "--ios",
        "--android",
        "--build",
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
      if (
        key === "claim" &&
        !["true", "false", "1", "0", "yes", "no", "on", "off", ""].includes(
          rawVal.trim().toLowerCase(),
        )
      ) {
        flags.claim = true;
        const extraTokens = tokenizeClaimSelectorString(rawVal);
        mainArgs.splice(i + 1, 0, ...extraTokens);
        continue;
      }
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

function resolveExplicitPlatformFilter(flags = {}) {
  const wantIos = parseBoolFlag(flags.ios);
  const wantAndroid = parseBoolFlag(flags.android);
  if (wantIos && wantAndroid) {
    throw new Error("Cannot specify both --ios and --android.");
  }
  if (wantIos) return "ios";
  if (wantAndroid) return "android";
  if (flags.platform !== undefined && flags.platform !== null && String(flags.platform).trim() !== "") {
    const p = String(flags.platform).trim().toLowerCase();
    if (p === "ios" || p === "apple") return "ios";
    if (p === "android") return "android";
    if (p === "all" || p === "any") return null;
    throw new Error(`Invalid --platform "${flags.platform}". Expected "android", "ios", or "all".`);
  }
  return null;
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
    (state, { now, auditEvents }) => {
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
        onBeforeRelease(cur, state, now, auditEvents);
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

function isAdbEmuFailure(res) {
  if (!res || res.status !== 0) return true;
  return /(?:^|\r?\n)\s*KO:/i.test(`${res.stdout || ""}\n${res.stderr || ""}`);
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

function discoverTargetFleet({
  targetPlatform = "android",
  stateDir = null,
  runner = runCommandSync,
  avdHome,
  cfg = DEFAULT_CONFIG,
  platform,
  livenessCheck,
  onProgress,
  env = process.env,
} = {}) {
  if (targetPlatform === "ios") {
    return discoverIosFleet({
      runner,
      stateDir,
      cfg,
      platform,
      onProgress,
      env,
    });
  }
  if (targetPlatform === "all" || targetPlatform === "any") {
    const androidInv = discoverFleet({
      runner,
      avdHome,
      cfg,
      platform,
      livenessCheck,
      onProgress,
    });
    const hostPlat = platform || process.platform;
    if (hostPlat !== "darwin") {
      return androidInv;
    }
    const iosInv = discoverIosFleet({
      runner,
      stateDir,
      cfg,
      platform,
      onProgress,
      env,
    });
    const onlineSerials = [
      ...new Set([
        ...(androidInv.onlineSerials || []),
        ...(iosInv.onlineSerials || []),
      ]),
    ];
    return {
      host: androidInv.host || iosInv.host,
      avdHome: androidInv.avdHome,
      discoveredAtMs: androidInv.discoveredAtMs,
      queriedPlatforms: ["android", "ios"],
      running: [...(androidInv.running || []), ...(iosInv.running || [])],
      offline: [...(androidInv.offline || []), ...(iosInv.offline || [])],
      creatable: [...(androidInv.creatable || []), ...(iosInv.creatable || [])],
      onlineSerials,
      availableRuntimesByFamily: iosInv.availableRuntimesByFamily || null,
      probes: {
        ...(androidInv.probes || {}),
        ...(iosInv.probes || {}),
      },
    };
  }
  return discoverFleet({
    runner,
    avdHome,
    cfg,
    platform,
    livenessCheck,
    onProgress,
  });
}

export function selectCandidateUnderLock(
  state,
  inventory,
  req,
  callerTicket,
  now = Date.now(),
  callerSessionId = callerTicket?.sessionId || null,
  livenessCheck = isPidAlive,
  options = {},
) {
  const cfg = state.config || DEFAULT_CONFIG;
  const effectiveMaxAndroid = computeEffectiveMaxEmulators(cfg, inventory.host);
  const usedAndroidSlots = computeUsedEmulatorSlots(state, inventory);
  const effectiveMaxIos = computeEffectiveMaxSimulators(cfg, inventory.host);
  const usedIosSlots = computeUsedSimulatorSlots(state, inventory);
  const getPlatformSlotInfo = (plat) =>
    plat === "ios"
      ? { usedSlots: usedIosSlots, effectiveMax: effectiveMaxIos }
      : { usedSlots: usedAndroidSlots, effectiveMax: effectiveMaxAndroid };
  const primarySlotInfo = getPlatformSlotInfo(req.platform === "ios" ? "ios" : "android");
  const effectiveMax = primarySlotInfo.effectiveMax;
  const usedSlots = primarySlotInfo.usedSlots;

  const getOccupyingLease = (d) =>
    state.leases[d.deviceKey] ||
    (d.serial
      ? Object.values(state.leases || {}).find((l) => l.serial === d.serial)
      : null) ||
    (d.udid
      ? Object.values(state.leases || {}).find(
          (l) => l.udid === d.udid || l.serial === d.udid,
        )
      : null) ||
    (d.avd && (d.platform || "android") === "android"
      ? Object.values(state.leases || {}).find(
          (l) => (l.platform || "android") === "android" && l.avd === d.avd,
        )
      : null) ||
    null;
  const isDeviceOccupied = (d) => Boolean(getOccupyingLease(d));
  const isCallerOwnedResettable = (d) => {
    if (!callerSessionId) return false;
    const l = getOccupyingLease(d);
    if (!l || l.state !== "active" || l.sessionId !== callerSessionId) return false;
    if (l.firstSeenOfflineAtMs !== null && l.firstSeenOfflineAtMs !== undefined) return false;
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
    requestedPlatform: req.platform || "android",
    requestedKind: req.kind || "emulator",
    requestedAvd: req.avd || null,
    requestedUdid: req.udid || null,
    requestedSerial: req.serial || null,
    requestedProfile: req,
  };

  function matchesCreatableEntry(c, targetReq) {
    if (targetReq.snapshotLoad) {
      return false;
    }
    const p = c.profile || c;
    const profileName = c.deviceName || p.deviceName;
    const cPlat = c.platform || "android";
    if (
      targetReq.avd &&
      c.avd !== targetReq.avd &&
      profileName !== targetReq.avd &&
      String(profileName || "").toLowerCase() !== String(targetReq.avd).toLowerCase() &&
      String(c.simDeviceTypeId || "").toLowerCase() !== String(targetReq.avd).toLowerCase()
    ) {
      return false;
    }
    return matchesProfile(
      {
        platform: cPlat,
        kind: "emulator",
        avd: targetReq.avd || c.avd || profileName,
        profile: p,
      },
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
    const devPlatform = device?.platform || "android";
    for (const earlier of earlierTickets) {
      const earlierReq = {
        platform: earlier.requestedPlatform || earlier.requestedProfile?.platform || "android",
        kind: earlier.requestedKind || "emulator",
        avd: earlier.requestedAvd || null,
        udid: earlier.requestedUdid || null,
        serial: earlier.requestedSerial || null,
        ...earlier.requestedProfile,
      };
      const canUseCandidate = Boolean(device?.kind) && matchesProfile(device, earlierReq);
      const samePlatformOrShared =
        earlierReq.platform === "any" || earlierReq.platform === devPlatform;
      const needsEmulatorCapacity =
        device?.kind !== "physical" &&
        samePlatformOrShared &&
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
      (l) =>
        (l.platform || "android") === "android" &&
        l.kind === "emulator" &&
        l.state === "starting" &&
        !l.serial,
    );
    const allowPhys = cfg.allowPhysicalDevices ?? "explicit";
    const allowedSerials = Array.isArray(cfg.allowedPhysicalSerials)
      ? cfg.allowedPhysicalSerials
      : [];
    const isPhysicalAllowed = (d) => {
      if (d.kind !== "physical") return true;
      if (allowPhys === "never" || allowPhys === false) return false;
      if (allowedSerials.length > 0) {
        return allowedSerials.some((s) => s === d.serial || s === d.udid);
      }
      return true;
    };
    const warmCandidates = (inventory.running || []).filter(
      (d) =>
        isPhysicalAllowed(d) &&
        !isDeviceOccupied(d) &&
        !(
          (d.platform || "android") === "android" &&
          d.kind === "emulator" &&
          !d.avd &&
          hasUnmappedStartingEmulator
        ) &&
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
  const hasUnmappedRunningAndroidEmulator = (inventory.running || []).some(
    (d) => (d.platform || "android") === "android" && d.kind === "emulator" && !d.avd,
  );
  const androidProbesFailed = Boolean(
    inventory.probes &&
      (inventory.probes.adbDevicesOk === false || inventory.probes.emulatorListOk === false),
  );
  const iosProbesFailed = Boolean(
    inventory.probes && inventory.probes.simctlListOk === false,
  );
  const safeOfflineCandidates = (inventory.offline || []).filter((d) => {
    const dPlat = d.platform || "android";
    if (dPlat === "ios") {
      return !iosProbesFailed;
    }
    if (hasUnmappedRunningAndroidEmulator || androidProbesFailed) {
      return false;
    }
    return (
      !d.hasLockFiles &&
      !(inventory.avdHome && d.avd && avdHasRuntimeLockFiles(d.avd, inventory.avdHome))
    );
  });
  const bootPool = [
    ...(req.wipeData || req.coldBoot
      ? (inventory.running || []).filter((d) => d.kind === "emulator" && (d.avd || d.udid))
      : []),
    ...safeOfflineCandidates,
  ]
    .filter((d) => (!isDeviceOccupied(d) || isCallerOwnedResettable(d)) && matchesProfile(d, req))
    .sort(
      (a, b) =>
        Number(isCallerOwnedResettable(b)) - Number(isCallerOwnedResettable(a)) ||
        Number(b.systemImagePresent !== false) - Number(a.systemImagePresent !== false),
    );

  let firstResourceErr = null;

  for (const dev of bootPool) {
    const devPlat = dev.platform || "android";
    const { usedSlots: platUsed, effectiveMax: platMax } = getPlatformSlotInfo(devPlat);
    const callerOwnedResettable = isCallerOwnedResettable(dev);
    const slotAvailable = dev.online || callerOwnedResettable || platUsed < platMax;
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

  // Priority 3: Tier 2 Evict Idle Running Emulator / Simulator
  if (cfg.autoStopIdleOnContention !== false && bootPool.length > 0) {
    const idleRunningVirtuals = (inventory.running || []).filter(
      (d) =>
        d.kind === "emulator" &&
        (d.avd || d.udid) &&
        !isDeviceOccupied(d) &&
        !isReservedForEarlierTicket(d, true),
    );

    for (const dev of bootPool) {
      if (isReservedForEarlierTicket(dev, true)) continue;
      const devPlat = dev.platform || "android";
      const { usedSlots: platUsed, effectiveMax: platMax } = getPlatformSlotInfo(devPlat);
      // Prefer same-platform victims first; require same-platform victim if target platform slots are full
      const sortedVictims = [...idleRunningVirtuals].sort(
        (a, b) =>
          Number((b.platform || "android") === devPlat) -
          Number((a.platform || "android") === devPlat),
      );
      for (const victim of sortedVictims) {
        if (dev.deviceKey === victim.deviceKey) continue;
        const victimPlat = victim.platform || "android";
        if (platUsed >= platMax && victimPlat !== devPlat) {
          continue;
        }
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

  // Priority 4: Auto-create missing AVD / Simulator (--create-if-missing)
  const anyExistingMatch = [
    ...(inventory.running || []),
    ...(inventory.offline || []),
    ...Object.values(state.leases || {}),
  ].some((d) => d.kind === "emulator" && matchesProfile(d, req));

  if (req.createIfMissing && !anyExistingMatch) {
    const creatablePool = (inventory.creatable || []).filter((c) => matchesCreatableEntry(c, req));
    if (creatablePool.length > 0) {
      const matchedCreatable = creatablePool[0];
      const createPlat = matchedCreatable.platform || (req.platform === "ios" ? "ios" : "android");
      const { usedSlots: platUsed, effectiveMax: platMax } = getPlatformSlotInfo(createPlat);
      if (platUsed < platMax) {
        const baseProfile = matchedCreatable.profile || matchedCreatable;
        let syntheticCandidate;
        if (createPlat === "ios") {
          const simOverhead = cfg.simOverheadRamMb ?? 1280;
          const ramSizeMb = matchedCreatable.ramSizeMb || 2048;
          const profileName = matchedCreatable.deviceName || baseProfile.deviceName || "iPhone 16";
          const avdName = req.avd || matchedCreatable.avd || profileName;
          const deviceKey =
            matchedCreatable.deviceKey ||
            `sim:create_${String(avdName).replace(/[^A-Za-z0-9._-]/g, "_")}`;
          syntheticCandidate = {
            platform: "ios",
            avd: avdName,
            deviceKey,
            kind: "emulator",
            online: false,
            simDeviceTypeId:
              matchedCreatable.simDeviceTypeId || baseProfile.deviceTypeIdentifier || null,
            simRuntimeId:
              matchedCreatable.simRuntimeId || baseProfile.runtimeIdentifier || null,
            ramSizeMb,
            requiredRamMb: ramSizeMb + simOverhead,
            dataDiskMb: matchedCreatable.dataDiskMb || 4096,
            freeDiskMb: inventory.host?.freeDiskMb,
            fsDev: inventory.host?.fsDev ?? null,
            profile: {
              ...baseProfile,
              deviceType: baseProfile.deviceType || req.deviceType || "phone",
              deviceName: profileName,
            },
          };
        } else {
          const profileName = matchedCreatable.deviceName || baseProfile.deviceName || "pixel_9";
          const avdId =
            req.avd || matchedCreatable.avd || profileName || deterministicCreatedAvdId(req);
          const deviceKey = `avd:${avdId}`;
          syntheticCandidate = {
            platform: "android",
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
        }
        if (
          !state.leases[syntheticCandidate.deviceKey] &&
          !isReservedForEarlierTicket(syntheticCandidate, true)
        ) {
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
  }

  const totalUsedVirtualSlots = usedAndroidSlots + usedIosSlots;
  // Hard Resource Failure vs Queue Wait: if totalUsedVirtualSlots === 0 and resource check failed
  if (firstResourceErr && totalUsedVirtualSlots === 0 && !options.suppressResourceError) {
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
  let resolvedPlatform;
  try {
    resolvedPlatform = resolveTargetPlatform(flags, options.cwd || process.cwd());
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }
  const targetPlatform = resolvedPlatform === "all" ? "any" : resolvedPlatform;

  const req = {
    platform: targetPlatform,
    kind:
      flags.kind ||
      (flags.udid || (flags.serial && !String(flags.serial).startsWith("emulator-"))
        ? "any"
        : "emulator"),
    avd: flags.avd || null,
    udid: flags.udid || null,
    serial: flags.serial || null,
    deviceType: flags.type ? normalizeDeviceType(flags.type) : null,
    apiSpec: flags.api ? String(flags.api) : null,
    osSpec: flags.os ? String(flags.os) : null,
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
    (typeof flags.resetApp !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(flags.resetApp))
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
    discoverTargetFleet({
      targetPlatform: resolvedPlatform,
      stateDir,
      runner,
      avdHome,
      cfg: initialCfg,
      platform: options.platform,
      env: options.env || process.env,
    });
  let inventory = options.inventory
    ? rawInventory
    : {
        ...rawInventory,
        discoveredAtMs: rawInventory.discoveredAtMs ?? discoveryStartedAtMs,
        fleetEpoch: rawInventory.fleetEpoch ?? inventoryEpoch,
      };
  const startWaitMs = Date.now();
  let retainedTicketTiming = null;
  let emittedRecoveryFallbackWarning = false;
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
      txOutcome = withStateTransaction(
        stateDir,
        (state, { now, auditEvents }) => {
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
              if (
                (d.avd || d.udid) &&
                !nextOffline.some((o) => o.deviceKey === d.deviceKey || (d.avd && o.avd === d.avd))
              ) {
                nextOffline.push({
                  ...d,
                  deviceKey:
                    d.platform === "ios"
                      ? `sim:${d.udid || d.serial}`
                      : `avd:${d.avd}`,
                  serial: d.platform === "ios" ? d.udid || d.serial : null,
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
                platform: b.platform || baseMatch.platform || "android",
                deviceKey:
                  b.deviceKey ||
                  baseMatch.deviceKey ||
                  (b.avd ? `avd:${b.avd}` : `serial:${b.serial}`),
                kind: "emulator",
                avd: b.avd || baseMatch.avd || null,
                udid: b.udid || baseMatch.udid || null,
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

          const allowPhysPolicy = state.config?.allowPhysicalDevices ?? "explicit";
          const allowedPhysSerials = Array.isArray(state.config?.allowedPhysicalSerials)
            ? state.config.allowedPhysicalSerials
            : [];
          const isPhysAllowedByPolicy = (d) => {
            if (!d || d.kind !== "physical") return true;
            if (allowPhysPolicy === "never" || allowPhysPolicy === false) return false;
            if (allowedPhysSerials.length > 0) {
              return allowedPhysSerials.some((s) => s === d.serial || s === d.udid);
            }
            return true;
          };
          const hasMatchingVirtualDevice = [
            ...(effectiveInventory.running || []),
            ...(effectiveInventory.offline || []),
          ].some((d) => d.kind === "emulator" && matchesProfile(d, req));
          const hasBlockedMatchingPhysical = (effectiveInventory.running || []).some(
            (d) => d.kind === "physical" && matchesProfile(d, req) && !isPhysAllowedByPolicy(d),
          );
          const targetsPhysicalUnderNever =
            (allowPhysPolicy === "never" || allowPhysPolicy === false) &&
            (req.kind === "physical" ||
              (!hasMatchingVirtualDevice &&
                Boolean(
                  hasBlockedMatchingPhysical ||
                    (req.serial && !String(req.serial).startsWith("emulator-")) ||
                    req.udid,
                )));
          if (targetsPhysicalUnderNever || (!hasMatchingVirtualDevice && hasBlockedMatchingPhysical)) {
            return {
              mutated: reconciledMutated,
              value: {
                status: "physical_forbidden",
                error:
                  `Physical device claim rejected by policy (allowPhysicalDevices=${allowPhysPolicy}). ` +
                  `Use an emulator/simulator or update "atc config".`,
              },
            };
          }

          // Step 3.1: Idempotent Re-Claim of Active Online Lease (Same Session)
          for (const lease of Object.values(state.leases)) {
            if (!isPhysAllowedByPolicy(lease)) {
              continue;
            }
            if (isStoppedSinceInventory(lease)) {
              continue;
            }
            if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
              continue;
            }
            const invDev = (effectiveInventory.running || []).find(
              (d) =>
                d.deviceKey === lease.deviceKey ||
                (d.avd &&
                  (d.platform || "android") === (lease.platform || "android") &&
                  d.avd === lease.avd) ||
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

          // Step 3.2: In-Place Owner Crash Recovery for Virtual Devices (§5.3 Step 3.2)
          let fellBackFromRecovery = false;
          let recoveryFallbackWarning = null;
          for (const [leaseKey, lease] of Object.entries(state.leases)) {
            if (
              lease.state !== "active" ||
              lease.kind !== "emulator" ||
              lease.sessionId !== identity.sessionId ||
              lease.firstSeenOfflineAtMs === null ||
              lease.firstSeenOfflineAtMs === undefined
            ) {
              continue;
            }
            const leasePlat = lease.platform || "android";
            const offlineMatch = (effectiveInventory.offline || []).find(
              (d) =>
                d.deviceKey === lease.deviceKey ||
                (d.udid && (d.udid === lease.udid || d.udid === lease.serial)) ||
                (d.avd && (d.platform || "android") === leasePlat && d.avd === lease.avd),
            );
            const candidateForMatch = offlineMatch
              ? { ...offlineMatch, ...lease, snapshots: offlineMatch.snapshots }
              : lease;
            if (!matchesProfile(candidateForMatch, { ...req, snapshotLoad: null })) {
              continue;
            }
            const graceMs = state.config?.offlineGraceMs ?? 45_000;
            const recoveryDeadlineMs = Math.min(
              typeof lease.expiresAtMs === "number" && Number.isFinite(lease.expiresAtMs)
                ? lease.expiresAtMs
                : Infinity,
              lease.firstSeenOfflineAtMs + graceMs,
            );
            if (now >= recoveryDeadlineMs) {
              delete state.leases[leaseKey];
              reconciledMutated = true;
              continue;
            }

            // Verify whether in-place recovery is possible right now
            let canRecover = false;
            let recoveryVictim = null;
            let recoveryFailReason = "underlying virtual device is no longer in offline inventory";

            const androidProbesFailed = Boolean(
              leasePlat === "android" &&
                effectiveInventory.probes &&
                (effectiveInventory.probes.adbDevicesOk === false ||
                  effectiveInventory.probes.emulatorListOk === false),
            );
            const iosProbesFailed = Boolean(
              leasePlat === "ios" &&
                effectiveInventory.probes &&
                effectiveInventory.probes.simctlListOk === false,
            );
            const hasLocks = Boolean(
              leasePlat === "android" &&
                offlineMatch &&
                (offlineMatch.hasLockFiles ||
                  (avdHome && offlineMatch.avd && avdHasRuntimeLockFiles(offlineMatch.avd, avdHome))),
            );

            if (offlineMatch && !androidProbesFailed && !iosProbesFailed && !hasLocks) {
              const cfg = state.config || DEFAULT_CONFIG;
              const platUsed =
                leasePlat === "ios"
                  ? computeUsedSimulatorSlots(state, effectiveInventory)
                  : computeUsedEmulatorSlots(state, effectiveInventory);
              const platMax =
                leasePlat === "ios"
                  ? computeEffectiveMaxSimulators(cfg, effectiveInventory.host)
                  : computeEffectiveMaxEmulators(cfg, effectiveInventory.host);

              // Note: lease itself is counted in platUsed while state === "active"
              if (platUsed <= platMax) {
                try {
                  checkResourceAdmission(offlineMatch, effectiveInventory.host, state, effectiveInventory, {
                    wipeOrCreate: Boolean(req.wipeData),
                    force: Boolean(req.force),
                    now,
                  });
                  canRecover = true;
                } catch (err) {
                  recoveryFailReason = err.message || "insufficient host RAM/disk headroom";
                }
              } else {
                recoveryFailReason = `platform slot limit reached (${platUsed}/${platMax} used)`;
              }

              // Try evicting an idle running virtual device if direct recovery failed
              if (!canRecover && cfg.autoStopIdleOnContention !== false) {
                const isOccupied = (d) =>
                  Boolean(
                    state.leases[d.deviceKey] ||
                      (d.serial &&
                        Object.values(state.leases || {}).some((l) => l.serial === d.serial)) ||
                      (d.avd &&
                        (d.platform || "android") === "android" &&
                        Object.values(state.leases || {}).some(
                          (l) => (l.platform || "android") === "android" && l.avd === d.avd,
                        )),
                  );
                const idleVictims = (effectiveInventory.running || [])
                  .filter((d) => d.kind === "emulator" && (d.avd || d.udid) && !isOccupied(d))
                  .sort(
                    (a, b) =>
                      Number((b.platform || "android") === leasePlat) -
                      Number((a.platform || "android") === leasePlat),
                  );
                for (const v of idleVictims) {
                  if (v.deviceKey === offlineMatch.deviceKey) continue;
                  if (platUsed > platMax && (v.platform || "android") !== leasePlat) continue;
                  try {
                    checkResourceAdmission(offlineMatch, effectiveInventory.host, state, effectiveInventory, {
                      replacingAvd: v,
                      wipeOrCreate: Boolean(req.wipeData),
                      force: Boolean(req.force),
                      now,
                    });
                    canRecover = true;
                    recoveryVictim = v;
                    break;
                  } catch (err) {
                    recoveryFailReason = err.message || recoveryFailReason;
                  }
                }
              }
            }

            if (canRecover && offlineMatch) {
              const bootTimeoutMs = (state.config?.bootTimeoutSec || 180) * 1000;
              const stopTimeoutMs = (state.config?.stopTimeoutSec || 60) * 1000;
              const overheadMb =
                leasePlat === "ios"
                  ? (state.config?.simOverheadRamMb ?? 1280)
                  : (state.config?.qemuOverheadRamMb ?? 1024);
              const computeRequiredRam = (d) =>
                typeof d.ramSizeMb === "number" && d.ramSizeMb > 0
                  ? d.ramSizeMb + overheadMb
                  : d.requiredRamMb || 2048 + overheadMb;
              let victimLeaseId = null;
              if (recoveryVictim) {
                victimLeaseId = `lease_${randomNonce().slice(0, 12)}`;
                state.leases[recoveryVictim.deviceKey] = {
                  leaseId: victimLeaseId,
                  deviceKey: recoveryVictim.deviceKey,
                  platform: recoveryVictim.platform || "android",
                  kind: "emulator",
                  avd: recoveryVictim.avd,
                  udid: recoveryVictim.udid || null,
                  serial: recoveryVictim.serial,
                  profile: recoveryVictim.profile,
                  sessionId: identity.sessionId,
                  anchorPid: identity.anchorPid,
                  state: "stopping",
                  workerPid: process.pid,
                  replacingAvd: null,
                  requiredRamMb: computeRequiredRam(recoveryVictim),
                  fsDev: recoveryVictim.fsDev ?? effectiveInventory.host?.fsDev ?? null,
                  avdPath: recoveryVictim.avdPath || null,
                  claimedAtMs: now,
                  deadlineMs: now + stopTimeoutMs,
                };
              }
              lease.state = "starting";
              lease.isRecovery = true;
              lease.workerPid = process.pid;
              lease.replacingAvd = recoveryVictim
                ? recoveryVictim.avd || recoveryVictim.udid || recoveryVictim.serial
                : null;
              lease.requiredRamMb = computeRequiredRam(offlineMatch);
              lease.requiredDiskMb = req.wipeData
                ? offlineMatch.dataDiskMb || 6656
                : offlineMatch.ramSizeMb || 2048;
              lease.loadedSnapshot = req.resetApp ? null : req.snapshotLoad || null;
              if (req.snapshotSaveOnFree) {
                lease.saveSnapshotOnFree = req.snapshotSaveOnFree;
              }
              if (req.reason) {
                lease.reason = req.reason;
              }
              // IMPORTANT: Do NOT extend lease.expiresAtMs during crash recovery
              lease.deadlineMs = now + bootTimeoutMs;
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
                  lease: { ...lease },
                  previousLease: null,
                  isRecovery: true,
                  hasExplicitTtl: false,
                  selection: {
                    priority: recoveryVictim ? 3 : 2,
                    tier: recoveryVictim ? 2 : 1,
                    candidate: offlineMatch,
                    victim: recoveryVictim,
                  },
                  victimLeaseId,
                  ttlMs,
                  bootTimeoutMs,
                  stopTimeoutMs,
                  knownAvdNames,
                },
              };
            } else {
              // Recovery impossible: delete offline reservation and fall through to queue
              recoveryFallbackWarning = `[atc] Crashed virtual device "${lease.avd || lease.serial || leaseKey}" could not be recovered in-place (${recoveryFailReason}); rejoining the claim queue.`;
              delete state.leases[leaseKey];
              fellBackFromRecovery = true;
              reconciledMutated = true;
            }
          }

          // Step 3.3: Physical Device Disconnected Fail-Fast (§5.3 Step 3.3)
          const matchPhysicalReq = {
            ...req,
            kind: flags.kind || "any",
            snapshotLoad: null,
          };
          for (const [leaseKey, lease] of Object.entries(state.leases)) {
            if (
              lease.kind === "physical" &&
              lease.sessionId === identity.sessionId &&
              lease.firstSeenOfflineAtMs !== null &&
              lease.firstSeenOfflineAtMs !== undefined &&
              matchesProfile(
                {
                  kind: "physical",
                  platform: lease.platform || "android",
                  serial: lease.serial,
                  udid: lease.udid || lease.serial,
                  profile: lease.profile || {},
                },
                matchPhysicalReq,
              )
            ) {
              const disconnectedSerial = lease.serial || lease.udid || leaseKey;
              delete state.leases[leaseKey];
              if (state.disconnectedPhysicalLeases) {
                for (const [tKey, tVal] of Object.entries(state.disconnectedPhysicalLeases)) {
                  if (tVal?.sessionId === identity.sessionId) {
                    delete state.disconnectedPhysicalLeases[tKey];
                  }
                }
              }
              state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);
              return {
                mutated: true,
                value: {
                  status: "physical_disconnected",
                  serial: disconnectedSerial,
                },
              };
            }
          }
          if (
            state.disconnectedPhysicalLeases &&
            typeof state.disconnectedPhysicalLeases === "object"
          ) {
            for (const [tKey, tomb] of Object.entries(state.disconnectedPhysicalLeases)) {
              if (
                tomb &&
                tomb.sessionId === identity.sessionId &&
                matchesProfile(
                  {
                    kind: "physical",
                    platform: tomb.platform || "android",
                    serial: tomb.serial,
                    udid: tomb.serial,
                    profile: tomb.profile || {},
                  },
                  matchPhysicalReq,
                )
              ) {
                const disconnectedSerial = tomb.serial || tKey;
                delete state.disconnectedPhysicalLeases[tKey];
                state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);
                return {
                  mutated: true,
                  value: {
                    status: "physical_disconnected",
                    serial: disconnectedSerial,
                  },
                };
              }
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
              requestedPlatform: req.platform,
              requestedKind: req.kind,
              requestedAvd: req.avd,
              requestedUdid: req.udid,
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
            { suppressResourceError: fellBackFromRecovery && waitSec > 0 },
          );

          if (selection.priority === 1 && !selection.needsWarmPrep) {
            const dev = selection.candidate;
            const leaseId = `lease_${randomNonce().slice(0, 12)}`;
            const lease = {
              leaseId,
              deviceKey: dev.deviceKey,
              platform: dev.platform || "android",
              kind: dev.kind,
              avd: dev.avd || null,
              udid: dev.udid || null,
              coreDeviceId: dev.coreDeviceId || null,
              serial: dev.serial,
              profile: dev.profile,
              dataPath: dev.dataPath || null,
              sessionId: identity.sessionId,
              anchorPid: identity.anchorPid,
              parentPid: resolveStableParentPid(
                options.ppid ?? process.ppid,
                options.processChain,
              ),
              state: "active",
              isRecovery: false,
              workerPid: null,
              replacingAvd: null,
              requiredRamMb: dev.requiredRamMb || 0,
              requiredDiskMb: 0,
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
            if (Array.isArray(auditEvents)) {
              auditEvents.push({
                event: "device_claim",
                sessionId: identity.sessionId,
                leaseId: lease.leaseId,
                deviceKey: lease.deviceKey,
                platform: lease.platform,
                kind: lease.kind,
                serial: lease.serial,
                avd: lease.avd,
                udid: lease.udid,
              });
            }
            return {
              mutated: true,
              value: {
                status: "claimed_immediate",
                lease,
                idempotent: false,
                recoveryFallbackWarning,
              },
            };
          }

          if (selection.priority !== null) {
            const dev = selection.candidate;
            const devPlat = dev.platform || "android";
            const existingOwnLease =
              state.leases[dev.deviceKey]?.sessionId === identity.sessionId &&
              state.leases[dev.deviceKey]?.state === "active"
                ? { ...state.leases[dev.deviceKey] }
                : null;
            const leaseId = existingOwnLease?.leaseId || `lease_${randomNonce().slice(0, 12)}`;
            const bootTimeoutMs = (state.config.bootTimeoutSec || 180) * 1000;
            const stopTimeoutMs = (state.config.stopTimeoutSec || 60) * 1000;
            let victimLeaseId = null;

            const computeRequiredRam = (d) => {
              const p = d.platform || "android";
              const overheadMb =
                p === "ios"
                  ? (state.config?.simOverheadRamMb ?? 1280)
                  : (state.config?.qemuOverheadRamMb ?? 1024);
              return typeof d.ramSizeMb === "number" && d.ramSizeMb > 0
                ? d.ramSizeMb + overheadMb
                : d.requiredRamMb || 2048 + overheadMb;
            };

            if (selection.victim) {
              victimLeaseId = `lease_${randomNonce().slice(0, 12)}`;
              state.leases[selection.victim.deviceKey] = {
                leaseId: victimLeaseId,
                deviceKey: selection.victim.deviceKey,
                platform: selection.victim.platform || "android",
                kind: "emulator",
                avd: selection.victim.avd,
                udid: selection.victim.udid || null,
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
              platform: devPlat,
              kind: dev.kind,
              avd: dev.avd,
              udid: dev.udid || null,
              coreDeviceId: dev.coreDeviceId || null,
              serial: dev.serial || null,
              profile: dev.profile,
              dataPath: dev.dataPath || null,
              sessionId: identity.sessionId,
              anchorPid: identity.anchorPid,
              parentPid: resolveStableParentPid(
                options.ppid ?? process.ppid,
                options.processChain,
              ),
              state: "starting",
              isRecovery: false,
              workerPid: process.pid,
              replacingAvd: selection.victim
                ? selection.victim.avd || selection.victim.udid || selection.victim.serial
                : null,
              requiredRamMb: computeRequiredRam(dev),
              requiredDiskMb:
                Boolean(req.wipeData) || Boolean(selection.createAvd)
                  ? dev.dataDiskMb || (devPlat === "ios" ? 4096 : 6656)
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
                recoveryFallbackWarning,
              },
            };
          }

          // Check pre-flight tooling diagnostics when 0 candidates exist anywhere in fleet
          const diagErr = diagnosePlatformToolingError(
            resolvedPlatform === "all" ? "android" : resolvedPlatform,
            req,
            effectiveInventory,
            { platform: options.platform || process.platform },
          );
          if (diagErr) {
            return {
              mutated: reconciledMutated,
              value: { status: "env_error", error: diagErr },
            };
          }

          // No candidate available right now
          if (waitSec <= 0) {
            return {
              mutated: reconciledMutated,
              value: { status: "busy", recoveryFallbackWarning },
            };
          }

          if (now >= waitExpiresAtMs) {
            state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);
            return {
              mutated: true,
              value: { status: "busy", recoveryFallbackWarning },
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
              requestedPlatform: req.platform,
              requestedKind: req.kind,
              requestedAvd: req.avd,
              requestedUdid: req.udid,
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
            value: { status: "queued", ticket, hbTimeoutSec, recoveryFallbackWarning },
          };
        },
        options,
      );
    } catch (err) {
      if (err instanceof ResourceError) {
        return { exitCode: err.exitCode, error: err.message };
      }
      return { exitCode: 1, error: err.message };
    }

    if (txOutcome.recoveryFallbackWarning && !emittedRecoveryFallbackWarning) {
      emittedRecoveryFallbackWarning = true;
      process.stderr.write(`${txOutcome.recoveryFallbackWarning}\n`);
    }

    if (txOutcome.status === "physical_disconnected") {
      return {
        exitCode: 1,
        error: `Physical device "${txOutcome.serial}" disconnected while leased and cannot be restarted automatically. Your lease was released — run "atc status" to re-check what is available before claiming again.`,
      };
    }

    if (txOutcome.status === "physical_forbidden") {
      return {
        exitCode: 6,
        error: txOutcome.error,
      };
    }

    if (txOutcome.status === "env_error") {
      return {
        exitCode: 1,
        error: txOutcome.error,
      };
    }

    if (txOutcome.status === "stale_inventory") {
      const refreshedState = readState(stateDir);
      inventoryEpoch = refreshedState.fleetEpoch || 0;
      discoveryStartedAtMs = Date.now();
      rawInventory = discoverTargetFleet({
        targetPlatform: resolvedPlatform,
        stateDir,
        runner,
        avdHome,
        cfg: refreshedState.config || DEFAULT_CONFIG,
        platform: options.platform,
        onProgress: heartbeatQueuedTicket,
        env: options.env || process.env,
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
          const isIosLease = (txOutcome.lease.platform || "android") === "ios";
          if (txOutcome.needsSnapLoad && req.snapshotLoad) {
            assertIdempotentPrepOwned();
            if (isIosLease) {
              try {
                loadIosSimulatorSnapshot(stateDir, txOutcome.lease, req.snapshotLoad, {
                  runner,
                  stopTimeoutMs: snapTimeoutMs,
                  bootTimeoutMs: snapTimeoutMs * 2,
                  env: options.env || process.env,
                  assertOwned: assertIdempotentPrepOwned,
                });
                loadedSnap = req.snapshotLoad;
                prepUpdatedSnap = true;
              } catch (err) {
                loadedSnap = null;
                prepUpdatedSnap = true;
                prepError = err.message;
              }
            } else {
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
          }
          if (!prepError && req.resetApp) {
            assertIdempotentPrepOwned();
            if (isIosLease) {
              try {
                resetIosSimulatorApp(txOutcome.lease.serial, req.resetApp, {
                  runner,
                  timeoutMs: snapTimeoutMs,
                  env: options.env || process.env,
                });
                loadedSnap = null;
                prepUpdatedSnap = true;
              } catch (err) {
                prepError = err.message;
              }
            } else {
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
      const targetLabel =
        resolvedPlatform === "ios"
          ? "iOS"
          : resolvedPlatform === "all"
            ? "mobile"
            : "Android";
      return {
        exitCode: 2,
        error: `No matching ${targetLabel} device is currently available (wait timeout reached).`,
      };
    }

    if (txOutcome.status === "needs_boot_or_prep") {
      return executeBootOrPrepOutsideLock(stateDir, txOutcome, req, {
        ...options,
        runner,
        avdHome,
        platform: options.platform,
        staticHost: options.inventory?.host || null,
        inventory: effectiveInventoryForBoot(inventory),
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
          discoverTargetFleet({
            targetPlatform: resolvedPlatform,
            stateDir,
            runner,
            avdHome,
            cfg: curCfg,
            platform: options.platform,
            onProgress: heartbeatQueuedTicket,
            env: options.env || process.env,
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

function effectiveInventoryForBoot(inv) {
  return inv || { running: [], offline: [], creatable: [] };
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
  const candidatePlat = candidate.platform || lease.platform || "android";
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
  let resolvedSerial = candidate.serial || candidate.udid || null;
  let bootedNewEmulator = false;
  let partialBootNeedsStop = false;
  let stoppedExistingEmulator = false;
  let prepInvalidatedSnapshot = false;
  let prepLoadedSnapshot = null;
  let victimStopWaitTimedOut = false;
  let rebootStopWaitTimedOut = false;

  const isWin = (platform || process.platform) === "win32";
  const assertReservationStillOwned = () => {
    const targetSerial = resolvedSerial || candidate.serial || candidate.udid || null;
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
      if (current.isRecovery && now >= (current.expiresAtMs || 0)) {
        return { mutated: false, value: "expired_recovery" };
      }
      const conflictingLease = Object.values(state.leases || {}).find(
        (l) =>
          l &&
          l.leaseId !== lease.leaseId &&
          ((targetSerial && l.serial === targetSerial) ||
            (candidatePlat === "android" &&
              (l.platform || "android") === "android" &&
              targetAvd &&
              l.avd === targetAvd)),
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
    if (status === "expired_recovery") {
      throw new Error(`Lease ${lease.leaseId} expired during crash recovery.`);
    }
    if (status !== "ok") {
      throw new Error(`Lease reservation ${lease.leaseId} was lost during boot`);
    }
  };

  try {
    // 1. Evict victim if replacingAvd is set (§5.3 Step 5.1)
    if (selection.victim) {
      assertReservationStillOwned();
      const effectiveStopTimeoutMs = stopTimeoutMs || 60_000;
      const victimPlat = selection.victim.platform || "android";
      if (victimPlat === "ios") {
        try {
          shutdownIosSimulator(selection.victim.serial || selection.victim.udid, {
            runner,
            timeoutMs: effectiveStopTimeoutMs,
            env: execOptions.env || process.env,
          });
        } catch (err) {
          victimHbTimer?.stop();
          throw new Error(
            `Failed to stop idle victim simulator ${selection.victim.avd || selection.victim.serial}: ${err.message}`,
          );
        }
      } else {
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
      }
      victimHbTimer?.stop();
      // Post-eviction state update and live RAM re-check (§5.3 Step 5.1 & §9.3)
      const liveHost = execOptions.staticHost || {
        ...readHostResources(avdHome),
        freeDiskMb: candidate.freeDiskMb ?? readFreeDiskMb(avdHome),
      };
      withStateTransaction(stateDir, (state, { now }) => {
        const vLease = state.leases[selection.victim.deviceKey];
        recordDeviceStoppedInState(state, selection.victim, now);
        if (vLease && vLease.leaseId === victimLeaseId) {
          delete state.leases[selection.victim.deviceKey];
        }
        const curLease = state.leases[lease.deviceKey];
        if (curLease && curLease.leaseId === lease.leaseId) {
          curLease.replacingAvd = null;
        }
        return { mutated: true };
      });
      if (!req.force) {
        const postEvictState = readState(stateDir);
        const tempState = {
          ...postEvictState,
          leases: Object.fromEntries(
            Object.entries(postEvictState.leases || {}).filter(([k]) => k !== lease.deviceKey),
          ),
        };
        const postEvictInventory = {
          ...(execOptions.inventory || {}),
          running: (execOptions.inventory?.running || []).filter(
            (d) => d.deviceKey !== selection.victim.deviceKey,
          ),
        };
        checkResourceAdmission(candidate, liveHost, tempState, postEvictInventory, {
          wipeOrCreate: Boolean(req.wipeData || selection.createAvd),
          force: Boolean(req.force),
          now: Date.now(),
        });
      }
    }

    // 2. Auto-create missing AVD / Simulator if Priority 4 (§5.3 Step 5.2)
    if (selection.createAvd) {
      if (candidatePlat === "ios") {
        assertReservationStillOwned();
        const createdSim = createIosSimulator(
          candidate.avd || req.avd || candidate.profile?.deviceName || "iPhone 16",
          candidate.simDeviceTypeId || candidate.profile?.deviceTypeIdentifier,
          candidate.simRuntimeId || candidate.profile?.runtimeIdentifier,
          {
            runner,
            timeoutMs: bootTimeoutMs || 180_000,
            env: execOptions.env || process.env,
          },
        );
        const createdUdid = createdSim.udid;
        const oldKey = lease.deviceKey;
        const newKey = `sim:${createdUdid}`;
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
              value: `Lease reservation ${lease.leaseId} was lost during Simulator creation.`,
            };
          }
          const destLease = state.leases[newKey];
          if (destLease && destLease.leaseId !== lease.leaseId) {
            return {
              mutated: false,
              value: `Created Simulator "${createdUdid}" was concurrently reserved by another session (${destLease.sessionId}).`,
            };
          }
          if (oldKey !== newKey) {
            delete state.leases[oldKey];
          }
          current.deviceKey = newKey;
          current.udid = createdUdid;
          current.serial = createdUdid;
          current.dataPath = createdSim.dataPath || resolveSimulatorDataDir(createdUdid);
          state.leases[newKey] = current;
          return { mutated: true, value: null };
        });
        if (migrationConflict) {
          throw new Error(migrationConflict);
        }
        candidate.deviceKey = newKey;
        candidate.udid = createdUdid;
        candidate.serial = createdUdid;
        candidate.dataPath = createdSim.dataPath || resolveSimulatorDataDir(createdUdid);
        lease.deviceKey = newKey;
        lease.udid = createdUdid;
        lease.serial = createdUdid;
        lease.dataPath = candidate.dataPath;
        resolvedSerial = createdUdid;
      } else {
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
                    platform: "android",
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
    }

    // 3. Warm state preparation vs Cold/Wipe boot (§5.3 Step 5.3)
    if (candidatePlat === "ios") {
      const simUdid = resolvedSerial || candidate.udid || candidate.serial || lease.udid || lease.serial;
      resolvedSerial = simUdid;
      if (selection.priority === 1 && selection.needsWarmPrep) {
        if (req.snapshotLoad) {
          assertReservationStillOwned();
          prepInvalidatedSnapshot = true;
          prepLoadedSnapshot = null;
          loadIosSimulatorSnapshot(
            stateDir,
            {
              ...lease,
              serial: simUdid,
              udid: simUdid,
              dataPath: candidate.dataPath || lease.dataPath,
            },
            req.snapshotLoad,
            {
              runner,
              stopTimeoutMs: stopTimeoutMs || 60_000,
              bootTimeoutMs: bootTimeoutMs || 180_000,
              env: execOptions.env || process.env,
              assertOwned: assertReservationStillOwned,
            },
          );
          prepLoadedSnapshot = req.snapshotLoad;
        }
        if (req.resetApp) {
          assertReservationStillOwned();
          prepInvalidatedSnapshot = true;
          prepLoadedSnapshot = null;
          resetIosSimulatorApp(simUdid, req.resetApp, {
            runner,
            timeoutMs: stopTimeoutMs || 60_000,
            env: execOptions.env || process.env,
          });
        }
      } else {
        if (candidate.online && (req.wipeData || req.coldBoot)) {
          assertReservationStillOwned();
          shutdownIosSimulator(simUdid, {
            runner,
            timeoutMs: stopTimeoutMs || 60_000,
            env: execOptions.env || process.env,
          });
          stoppedExistingEmulator = true;
        }
        if (req.wipeData) {
          assertReservationStillOwned();
          eraseIosSimulator(simUdid, {
            runner,
            timeoutMs: stopTimeoutMs || 60_000,
            env: execOptions.env || process.env,
          });
        }
        if (req.snapshotLoad) {
          assertReservationStillOwned();
          prepInvalidatedSnapshot = true;
          prepLoadedSnapshot = null;
          loadIosSimulatorSnapshot(
            stateDir,
            {
              ...lease,
              serial: simUdid,
              udid: simUdid,
              dataPath: candidate.dataPath || lease.dataPath,
            },
            req.snapshotLoad,
            {
              runner,
              stopTimeoutMs: stopTimeoutMs || 60_000,
              bootTimeoutMs: bootTimeoutMs || 180_000,
              env: execOptions.env || process.env,
              assertOwned: assertReservationStillOwned,
            },
          );
          bootedNewEmulator = true;
          prepLoadedSnapshot = req.snapshotLoad;
        } else {
          assertReservationStillOwned();
          try {
            bootIosSimulator(simUdid, {
              runner,
              timeoutMs: bootTimeoutMs || 180_000,
              headless: Boolean(req.headless),
              env: execOptions.env || process.env,
            });
          } catch (bootErr) {
            bootedNewEmulator = true;
            partialBootNeedsStop = true;
            throw bootErr;
          }
          bootedNewEmulator = true;
        }
        if (req.resetApp) {
          assertReservationStillOwned();
          prepInvalidatedSnapshot = true;
          prepLoadedSnapshot = null;
          resetIosSimulatorApp(simUdid, req.resetApp, {
            runner,
            timeoutMs: stopTimeoutMs || 60_000,
            env: execOptions.env || process.env,
          });
        }
      }
    } else if (selection.priority === 1 && selection.needsWarmPrep) {
      if (req.snapshotLoad) {
        assertReservationStillOwned();
        prepInvalidatedSnapshot = true;
        prepLoadedSnapshot = null;
        const snapRes = runner(
          "adb",
          ["-s", resolvedSerial, "emu", "avd", "snapshot", "load", req.snapshotLoad],
          { strictInternal: true, timeoutMs: bootTimeoutMs },
        );
        if (isAdbEmuFailure(snapRes)) {
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
        if (isAdbEmuFailure(snapRes)) {
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

    // 4. Activate lease under atc.lock (§5.3 Step 5.4)
    let releasedDuringBoot = false;
    const livenessCheck = execOptions.livenessCheck || isPidAlive;
    const activeLease = finishLeaseWorker(
      stateDir,
      lease.deviceKey,
      lease.leaseId,
      ttlMs,
      execOptions,
      (current, state, now, auditEvents) => {
        if (current.isRecovery && now >= (current.expiresAtMs || 0)) {
          throw new Error(`Lease ${lease.leaseId} expired during crash recovery.`);
        }
        const targetAvd = candidate.avd || lease.avd || null;
        const conflictingLease = Object.values(state.leases || {}).find(
          (l) =>
            l &&
            l.leaseId !== lease.leaseId &&
            ((resolvedSerial && l.serial === resolvedSerial) ||
              (candidatePlat === "android" &&
                (l.platform || "android") === "android" &&
                targetAvd &&
                l.avd === targetAvd)),
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
        if (candidatePlat === "ios") {
          current.udid = resolvedSerial;
        }
        current.loadedSnapshot = req.resetApp ? null : req.snapshotLoad || null;
        if (bootedNewEmulator) {
          recordDeviceBootedInState(state, current, now);
        } else {
          clearDeviceStoppedInState(state, current);
        }
        current.activatedAtMs = now;
        current.activatedEpoch = state.fleetEpoch || 0;
        current.renewedAtMs = now;
        if (current.isRecovery) {
          // Do NOT prolong expiresAtMs during crash recovery (§5.3 Step 5.4)
          current.isRecovery = false;
        } else {
          current.expiresAtMs = hasExplicitTtl
            ? now + ttlMs
            : Math.max(current.expiresAtMs || 0, previousLease?.expiresAtMs || 0, now + ttlMs);
        }
        current.firstSeenOfflineAtMs = null;
        current.deadlineMs = null;
        if (!releasedDuringBoot && Array.isArray(auditEvents)) {
          auditEvents.push({
            event: "device_claim",
            sessionId: current.sessionId,
            leaseId: current.leaseId,
            deviceKey: current.deviceKey,
            platform: current.platform,
            kind: current.kind,
            serial: current.serial,
            avd: current.avd,
            udid: current.udid,
            booted: Boolean(bootedNewEmulator),
          });
        }
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

    return {
      exitCode: 0,
      lease: activeLease,
      idempotent: false,
      recovered: Boolean(lease.isRecovery),
    };
  } catch (err) {
    hbTimer.stop();
    victimHbTimer?.stop();
    if (
      candidatePlat === "android" &&
      stoppedExistingEmulator &&
      !resolvedSerial &&
      previousLease
    ) {
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
              platform: candidatePlat,
              avd: targetAvd,
              udid: candidate.udid || lease.udid || null,
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
            if (candidatePlat === "android" && targetAvd && lease.deviceKey === `avd:${targetAvd}`) {
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
              platform: selection.victim.platform || "android",
              kind: "emulator",
              avd: selection.victim.avd,
              udid: selection.victim.udid || null,
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
              (candidatePlat === "android" &&
                (l.platform || "android") === "android" &&
                targetAvd &&
                l.avd === targetAvd)),
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
        if (candidatePlat === "ios") {
          const simTarget = cleanupSerial || candidate.udid || lease.udid || lease.serial;
          if (simTarget) {
            shutdownIosSimulator(simTarget, {
              runner,
              timeoutMs: effectiveStopTimeoutMs,
              env: execOptions.env || process.env,
            });
            stoppedCleanly = true;
          }
        } else if (isWin) {
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
        // Best-effort cleanup of newly booted emulator/simulator
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
                  platform: candidatePlat,
                  avd: candidate.avd || lease.avd,
                  udid: candidate.udid || lease.udid || null,
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
                  serial: candidatePlat === "ios" ? previousLease.serial : null,
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
    if (err instanceof ResourceError) {
      return { exitCode: err.exitCode, error: err.message };
    }
    return { exitCode: 1, error: err.message };
  }
}

export function cmdFree(stateDir, target = null, flags = {}, options = {}) {
  const unknownFlagErr = validateCommandFlags(flags, FREE_ALLOWED_FLAGS, "free");
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr, freed: [] };
  }
  let platFilter = null;
  try {
    platFilter = resolveExplicitPlatformFilter(flags);
  } catch (err) {
    return { exitCode: 1, error: err.message, freed: [] };
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
          preLeases.find((l) => l.serial === effectiveTarget || l.udid === effectiveTarget) ||
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
            (l.state === "active" || l.state === "starting") &&
            (!platFilter || (l.platform || "android") === platFilter)
          ) {
            preMatches.push(l);
          }
        }
      }
      for (const l of preMatches) {
        if (!Array.isArray(l.workerPgids) || l.workerPgids.length === 0) continue;
        const pgidSet = new Set(
          l.workerPgids.map((p) => Number(String(p).split("@")[0])),
        );
        const hasLiveWrapperPid = (l.workerPids || []).some((p) => {
          const num = Number(p);
          return num !== options.callerWorkerPid && !pgidSet.has(num) && preLiveness(num);
        });
        const hasLiveLeaderPid = l.workerPgids.some((p) =>
          isWorkerGroupLeaderAlive(p, l, preLiveness, options),
        );
        if (parseBoolFlag(flags.force) || (!hasLiveWrapperPid && !hasLiveLeaderPid)) {
          const killedRes = killProcessGroupTree(l, "SIGKILL", {
            spawnSyncFn: options.spawnSyncFn || options.runner,
            platform: options.platform,
            livenessCheck: preLiveness,
            killFn: options.killFn,
          });
          if (Array.isArray(killedRes?.terminatedPgids)) {
            terminatedPgids.push(...killedRes.terminatedPgids);
          }
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
      (state, { now, auditEvents }) => {
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
          const bySerial =
            !byId &&
            leasesList.find((l) => l.serial === effectiveTarget || l.udid === effectiveTarget);
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
              (l.state === "active" || l.state === "starting") &&
              (!platFilter || (l.platform || "android") === platFilter)
            ) {
              matches.push(l);
            }
          }
        }

        const prevQueueLen = Array.isArray(state.queue) ? state.queue.length : 0;
        if (!effectiveTarget && Array.isArray(state.queue) && prevQueueLen > 0) {
          state.queue = state.queue.filter(
            (t) =>
              t.sessionId !== identity.sessionId ||
              (platFilter &&
                t.req?.platform &&
                t.req.platform !== "any" &&
                t.req.platform !== platFilter),
          );
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
          if (
            !otherLease ||
            otherLease.kind !== "emulator" ||
            matchedKeys.has(otherLease.deviceKey)
          ) {
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

          // Non-executable offline reservation (§5.4): release immediately without external adb/simctl calls
          if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
            freedImmediate.push(lease.leaseId);
            if (Array.isArray(auditEvents)) {
              auditEvents.push({
                event: "device_free",
                sessionId: lease.sessionId,
                leaseId: lease.leaseId,
                deviceKey: lease.deviceKey,
                serial: lease.serial,
              });
            }
            delete state.leases[lease.deviceKey];
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
          const leasePlat = lease.platform || "android";

          const meta =
            saveSnap && lease.kind === "emulator" && leasePlat === "android"
              ? readLocalAvdMetadata(lease.avd, avdHome, state.config)
              : saveSnap && lease.kind === "emulator" && leasePlat === "ios"
                ? { ramSizeMb: 2048, freeDiskMb: readFreeDiskMb(stateDir), fsDev: null }
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
                `Insufficient disk space to save snapshot "${saveSnap}" on ${lease.avd || lease.serial}: needs ${nextCumulativeMb + (state.config.minFreeDiskMb ?? 2048)}MB free.`,
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
            if (Array.isArray(auditEvents)) {
              auditEvents.push({
                event: "device_free",
                sessionId: lease.sessionId,
                leaseId: lease.leaseId,
                deviceKey: lease.deviceKey,
                serial: lease.serial,
              });
            }
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
      },
      terminatedPgids.length > 0 ? { ...options, terminatedPgids } : options,
    );
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
    const isIosLease = (lease.platform || "android") === "ios";
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
        } else if (isIosLease) {
          try {
            saveIosSimulatorSnapshot(stateDir, lease, saveSnap, {
              runner,
              stopTimeoutMs,
              bootTimeoutMs: stopTimeoutMs * 2,
              skipReboot: Boolean(doStop || loadSnap),
              env: options.env || process.env,
            });
          } catch (err) {
            itemFailed = true;
            actionErrors.push(err.message);
          }
        } else {
          const saveRes = runner(
            "adb",
            ["-s", lease.serial, "emu", "avd", "snapshot", "save", saveSnap],
            { strictInternal: true, timeoutMs: stopTimeoutMs },
          );
          if (isAdbEmuFailure(saveRes)) {
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
        } else if (isIosLease) {
          try {
            loadIosSimulatorSnapshot(stateDir, lease, loadSnap, {
              runner,
              stopTimeoutMs,
              bootTimeoutMs: stopTimeoutMs * 2,
              env: options.env || process.env,
            });
            loadedSnapOnFree = true;
          } catch (err) {
            itemFailed = true;
            actionErrors.push(err.message);
          }
        } else {
          const loadRes = runner(
            "adb",
            ["-s", lease.serial, "emu", "avd", "snapshot", "load", loadSnap],
            { strictInternal: true, timeoutMs: stopTimeoutMs },
          );
          if (isAdbEmuFailure(loadRes)) {
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
        } else if (isIosLease) {
          try {
            shutdownIosSimulator(lease.serial || lease.udid, {
              runner,
              timeoutMs: stopTimeoutMs,
              env: options.env || process.env,
            });
          } catch (err) {
            itemFailed = true;
            actionErrors.push(err.message);
          }
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
        (state, { now, auditEvents }) => {
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
              if (Array.isArray(auditEvents)) {
                auditEvents.push({
                  event: "device_free",
                  sessionId: cur.sessionId,
                  leaseId: cur.leaseId,
                  deviceKey: cur.deviceKey,
                  serial: cur.serial,
                  stopped: Boolean(doStop),
                });
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
  let platFilter = null;
  try {
    platFilter = resolveExplicitPlatformFilter(flags);
  } catch (err) {
    return { exitCode: 1, error: err.message };
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
        leasesList.find((l) => l.serial === effectiveTarget || l.udid === effectiveTarget) ||
        leasesList.find((l) => l.avd === effectiveTarget);
    } else {
      const owned = leasesList.filter(
        (l) =>
          l.sessionId === identity.sessionId &&
          (!platFilter || (l.platform || "android") === platFilter),
      );
      if (owned.length > 1) {
        return {
          mutated: false,
          value: {
            exitCode: 1,
            error: `Session "${identity.sessionId}" holds ${owned.length} active leases; specify a <lease-id|serial|avd> target or --android/--ios to renew.`,
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
    if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} (${lease.avd || lease.serial || lease.deviceKey}) is currently offline; run "atc claim" to recover or release it before renewing.`,
        },
      };
    }

    const killCommittedAgeMs =
      typeof lease.gcKillCommittedAtMs === "number" &&
      Number.isFinite(lease.gcKillCommittedAtMs)
        ? now - lease.gcKillCommittedAtMs
        : -1;
    if (killCommittedAgeMs >= 0 && killCommittedAgeMs < 30_000) {
      return {
        mutated: false,
        value: { exitCode: 3, error: "No matching active lease found to renew." },
      };
    }

    delete lease.gcReapingAtMs;
    delete lease.gcKillCommittedAtMs;
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
  let platFilter = null;
  try {
    platFilter = resolveExplicitPlatformFilter(flags);
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }
  const effectiveAction = action || (typeof flags.action === "string" ? flags.action : null);
  const effectiveName = name || (typeof flags.name === "string" ? flags.name : null);
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);

  if (effectiveAction === "list") {
    const targetAvd = flags.avd || null;
    const targetUdid = flags.udid || null;
    const targetSerial = flags.serial || targetUdid || null;
    if (targetUdid) {
      return { exitCode: 0, snapshots: listIosSimulatorSnapshots(stateDir, targetUdid) };
    }
    if (targetAvd && !targetSerial) {
      const meta = readLocalAvdMetadata(targetAvd, avdHome);
      if (meta.exists) {
        return { exitCode: 0, snapshots: meta.snapshots };
      }
    }
    const state = readState(stateDir);
    if (targetSerial || targetAvd) {
      const leasedIos = Object.values(state.leases || {}).find(
        (l) =>
          (l.platform || "android") === "ios" &&
          l.kind === "emulator" &&
          (!targetSerial || l.serial === targetSerial || l.udid === targetSerial) &&
          (!targetAvd || l.avd === targetAvd),
      );
      if (leasedIos && (leasedIos.udid || leasedIos.serial)) {
        return {
          exitCode: 0,
          snapshots: listIosSimulatorSnapshots(stateDir, leasedIos.udid || leasedIos.serial),
        };
      }
    } else {
      const identity = resolveSessionIdentity({
        flags,
        env: options.env || process.env,
        state,
        cwd: options.cwd || process.cwd(),
        ppid: options.ppid ?? process.ppid,
        ancestorPids: options.ancestorPids,
        processChain: options.processChain,
      });
      const ownedEmulators = Object.values(state.leases || {}).filter(
        (l) =>
          l.state === "active" &&
          l.kind === "emulator" &&
          l.sessionId === identity.sessionId &&
          (!platFilter || (l.platform || "android") === platFilter),
      );
      if (ownedEmulators.length === 1) {
        const only = ownedEmulators[0];
        if ((only.platform || "android") === "ios" && (only.udid || only.serial)) {
          return {
            exitCode: 0,
            snapshots: listIosSimulatorSnapshots(stateDir, only.udid || only.serial),
          };
        }
        if ((only.platform || "android") === "android" && only.avd && platFilter === "android") {
          const meta = readLocalAvdMetadata(only.avd, avdHome);
          if (meta.exists) {
            return { exitCode: 0, snapshots: meta.snapshots };
          }
        }
      }
    }
    const fleet = options.inventory || discoverFleet({ avdHome, runner });
    if (targetSerial || targetAvd) {
      const allDevs = [...(fleet.running || []), ...(fleet.offline || [])];
      const matched = allDevs.find(
        (d) =>
          d.kind === "emulator" &&
          (!targetSerial || d.serial === targetSerial || d.udid === targetSerial) &&
          (!targetAvd || d.avd === targetAvd),
      );
      if (!matched) {
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
        : matched.platform === "ios"
          ? listIosSimulatorSnapshots(stateDir, matched.udid || matched.serial)
          : readLocalAvdMetadata(matched.avd, avdHome).snapshots;
      return { exitCode: 0, snapshots: snaps };
    }
    const byAvd = {};
    for (const d of [...fleet.running, ...fleet.offline]) {
      if (d.kind === "emulator" && (d.avd || d.udid)) {
        byAvd[d.avd || d.udid] = d.snapshots || [];
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
    const selectorSerial = flags.serial || flags.udid || null;
    const owned = Object.values(state.leases).filter(
      (l) =>
        l.state === "active" &&
        l.kind === "emulator" &&
        l.sessionId === identity.sessionId &&
        (!platFilter || (l.platform || "android") === platFilter) &&
        (!selectorSerial || l.serial === selectorSerial || l.udid === selectorSerial) &&
        (!flags.avd || l.avd === flags.avd),
    );
    if (owned.length === 0) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Session "${identity.sessionId}" holds no active${platFilter ? ` ${platFilter}` : ""} emulator lease.`,
        },
      };
    }
    if (owned.length > 1 && !selectorSerial && !flags.avd) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Session "${identity.sessionId}" holds multiple active emulator leases; pass --serial <serial>, --avd <avd>, or --android/--ios.`,
        },
      };
    }
    const lease = owned[0];
    if (lease.firstSeenOfflineAtMs !== null && lease.firstSeenOfflineAtMs !== undefined) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} (${lease.avd || lease.serial || lease.deviceKey}) is currently offline; run "atc claim" to recover it before running snapshot commands.`,
        },
      };
    }
    const isIosLease = (lease.platform || "android") === "ios";
    const saveMeta =
      effectiveAction === "save"
        ? isIosLease
          ? { ramSizeMb: 2048, freeDiskMb: readFreeDiskMb(stateDir), fsDev: null }
          : readLocalAvdMetadata(lease.avd, avdHome, state.config)
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
            error: `Insufficient disk space (${effectiveFreeDiskMb}MB free) to save snapshot "${effectiveName}" on ${lease.avd || lease.serial}: needs ${meta.ramSizeMb + minDisk}MB free. Pass --force to bypass.`,
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
    const transitionsToStarting =
      effectiveAction === "load" || (isIosLease && effectiveAction === "save");
    if (transitionsToStarting && activeWorkers.length > 0) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} (${lease.deviceKey}) has active in-flight worker(s) (${activeWorkers.join(", ")}); wait for completion before running snapshot ${effectiveAction}.`,
        },
      };
    }
    addLeaseWorker(lease, process.pid, livenessCheck);
    if (effectiveAction === "save" && saveMeta) {
      lease.pendingSnapshotDiskMb = saveMeta.ramSizeMb || 2048;
      lease.fsDev = saveMeta.fsDev ?? lease.fsDev ?? null;
    }
    if (transitionsToStarting) {
      lease.state = "starting";
      lease.workerPid = process.pid;
      lease.deadlineMs = now + stopTimeoutMs;
      if (effectiveAction === "load") {
        lease.loadedSnapshot = null;
      }
    }
    lease.renewedAtMs = now;
    lease.expiresAtMs = Math.max(lease.expiresAtMs, now + Math.max(ttlMs, stopTimeoutMs * 2));
    return {
      mutated: true,
      value: {
        exitCode: 0,
        lease: { ...lease },
        ttlMs,
        stopTimeoutMs,
        isIosLease,
        transitionsToStarting,
      },
    };
  }, options);

  if (leaseCheck.exitCode !== 0) {
    return leaseCheck;
  }

  const loadHb = leaseCheck.transitionsToStarting
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
          if (leaseCheck.transitionsToStarting) {
            cur.state = "active";
            cur.deadlineMs = null;
          }
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

  if (leaseCheck.isIosLease) {
    try {
      if (effectiveAction === "save") {
        saveIosSimulatorSnapshot(stateDir, leaseCheck.lease, effectiveName, {
          runner,
          stopTimeoutMs: leaseCheck.stopTimeoutMs,
          bootTimeoutMs: leaseCheck.stopTimeoutMs * 2,
          env: options.env || process.env,
        });
      } else if (effectiveAction === "load") {
        loadIosSimulatorSnapshot(stateDir, leaseCheck.lease, effectiveName, {
          runner,
          stopTimeoutMs: leaseCheck.stopTimeoutMs,
          bootTimeoutMs: leaseCheck.stopTimeoutMs * 2,
          env: options.env || process.env,
        });
      } else if (effectiveAction === "delete") {
        deleteIosSimulatorSnapshot(stateDir, leaseCheck.lease, effectiveName);
      }
    } catch (err) {
      clearSnapshotWorker(false);
      return { exitCode: 1, error: err.message };
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
  if (isAdbEmuFailure(res)) {
    clearSnapshotWorker(false);
    return {
      exitCode: 1,
      error: `adb snapshot ${effectiveAction} "${effectiveName}" failed: ${res.stderr || res.stdout}`,
    };
  }

  if (effectiveAction === "load") {
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

// Internal runner for typed ops: admission (build slots, workspace locks, RAM), device lease
// resolution or co-allocation, heartbeats, and sequential execution of literal invocations.
// `plan` = { op, params, buildReqs, deviceClass, makeInvocations(lease) → [{cmd,args,cwd,timeoutSec}],
//            readOnly, onOutput?, stdio? }.
export async function runOpInvocations(stateDir, plan, flags = {}, options = {}) {
  let platFilter = null;
  try {
    platFilter = resolveExplicitPlatformFilter(flags);
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }
  const cwd = options.cwd || process.cwd();
  const callerEnv = options.env || process.env;
  const op = plan.op;

  const rawRamMb = flags.ramMb;
  let explicitRamMb = 0;
  if (rawRamMb !== undefined && rawRamMb !== null) {
    const parsedRam = Number(rawRamMb);
    if (!Number.isInteger(parsedRam) || parsedRam < 1 || parsedRam > 1_048_576) {
      return {
        exitCode: 1,
        error: `Invalid ramMb "${rawRamMb}". Expected an integer between 1 and 1048576.`,
      };
    }
    explicitRamMb = parsedRam;
  }

  const isBuildOp = op.kind === "build";
  const isClaimFlag = parseBoolFlag(flags.claim);
  const selectorSerial = flags.serial || flags.udid || null;

  const buildReqs = { ...plan.buildReqs, resourceKeys: [...(plan.buildReqs?.resourceKeys || [])] };
  if (explicitRamMb > 0) {
    buildReqs.requestedHeapMb = Math.max(buildReqs.requestedHeapMb || 0, explicitRamMb);
  }
  const cmdDeviceClass = plan.deviceClass || { kind: "not_build_tool", targetPlatform: null };

  const requiredDevicePlatform =
    (buildReqs.requiresDevice && buildReqs.targetPlatform) ||
    (cmdDeviceClass.kind === "device_action" && cmdDeviceClass.targetPlatform) ||
    null;
  if (requiredDevicePlatform === "ios" || requiredDevicePlatform === "android") {
    if (platFilter && platFilter !== requiredDevicePlatform) {
      return {
        exitCode: 3,
        error: `${op.name} targets ${requiredDevicePlatform}, which conflicts with explicit --${platFilter} selector.`,
      };
    }
    platFilter = requiredDevicePlatform;
  }

  const needsBuildCoordination = Boolean(buildReqs.requiresWorkspaceLock);
  const needsDeviceLease =
    isClaimFlag ||
    Boolean(selectorSerial) ||
    Boolean(buildReqs.requiresDevice) ||
    cmdDeviceClass.kind === "device_action" ||
    !isBuildOp;

  const rawWait = flags.wait ?? flags.waitSec;
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

  const claimFlags = Object.fromEntries(
    Object.entries(flags).filter(
      ([k]) =>
        k !== "build" &&
        k !== "claim" &&
        k !== "workspace" &&
        k !== "phase" &&
        k !== "ramMb" &&
        k !== "ram-mb",
    ),
  );
  if (!claimFlags.platform && !claimFlags.ios && !claimFlags.android && requiredDevicePlatform) {
    claimFlags.platform = requiredDevicePlatform;
  }
  if (buildReqs.targetSerial && requiredDevicePlatform === "ios") {
    for (const part of String(buildReqs.targetSerial)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (part.startsWith("ios_simulator_version=")) {
        if (!claimFlags.os && !claimFlags.api) {
          claimFlags.os = part.slice("ios_simulator_version=".length).trim();
        }
      } else if (
        !claimFlags.avd &&
        !claimFlags.udid &&
        !claimFlags.serial &&
        part.toLowerCase() !== "booted"
      ) {
        claimFlags.avd = part.startsWith("ios_simulator_device=")
          ? part.slice("ios_simulator_device=".length).trim()
          : part;
      }
    }
  }

  // If --claim is requested without build coordination, claim the device first via cmdClaim
  let coAllocatedLeaseId = null;
  let coAllocatedDeviceKey = null;
  if (isClaimFlag && !needsBuildCoordination) {
    const claimRes = cmdClaim(stateDir, claimFlags, options);
    if (claimRes.exitCode !== 0) {
      return claimRes;
    }
    if (!claimRes.idempotent && claimRes.lease?.leaseId) {
      coAllocatedLeaseId = claimRes.lease.leaseId;
      coAllocatedDeviceKey = claimRes.lease.deviceKey || null;
    }
  }
  const cleanupCoAllocatedLeaseOnEarlyError = () => {
    if (!coAllocatedLeaseId) return;
    try {
      withStateTransaction(
        stateDir,
        (state, { auditEvents }) => {
          const { key, lease: cur } = findLeaseEntry(
            state,
            coAllocatedDeviceKey,
            coAllocatedLeaseId,
          );
          if (!cur || cur.leaseId !== coAllocatedLeaseId) {
            return { mutated: false };
          }
          delete state.leases[key];
          if (Array.isArray(auditEvents)) {
            auditEvents.push({
              event: "device_free",
              sessionId: cur.sessionId,
              leaseId: cur.leaseId,
              deviceKey: key,
              platform: cur.platform,
              kind: cur.kind,
              serial: cur.serial,
              reason: "exec_claim_abort",
            });
          }
          return { mutated: true };
        },
        options,
      );
    } catch {
      // Best-effort cleanup on pre-spawn error
    }
  };

  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);
  const rawPpid = options.ppid ?? process.ppid;
  const ancestorPids = options.ancestorPids || Array.from(getAncestorPids(rawPpid));
  const processChain =
    options.processChain ||
    (needsBuildCoordination ? getAncestorProcessChain(rawPpid) : []);
  const inheritedOpId = callerEnv.ATC_BUILD_OP_ID
    ? String(callerEnv.ATC_BUILD_OP_ID).trim()
    : null;
  const inheritedNonce = callerEnv.ATC_BUILD_OP_NONCE
    ? String(callerEnv.ATC_BUILD_OP_NONCE).trim()
    : null;

  let resolvedClaimPlatform = "android";
  let coClaimReq = null;
  if (isClaimFlag && needsBuildCoordination) {
    try {
      resolvedClaimPlatform = resolveTargetPlatform(claimFlags, cwd);
    } catch (err) {
      cleanupCoAllocatedLeaseOnEarlyError();
      return { exitCode: 1, error: err.message };
    }
    if (
      resolvedClaimPlatform === "android" &&
      !claimFlags.android &&
      !claimFlags.platform &&
      buildReqs.targetPlatform === "ios"
    ) {
      resolvedClaimPlatform = "ios";
    }
    const targetPlatform = resolvedClaimPlatform === "all" ? "any" : resolvedClaimPlatform;
    coClaimReq = {
      platform: targetPlatform,
      kind:
        claimFlags.kind ||
        (claimFlags.udid ||
        (claimFlags.serial && !String(claimFlags.serial).startsWith("emulator-"))
          ? "any"
          : "emulator"),
      avd: claimFlags.avd || null,
      udid: claimFlags.udid || null,
      serial: claimFlags.serial || null,
      deviceType: claimFlags.type ? normalizeDeviceType(claimFlags.type) : null,
      apiSpec: claimFlags.api ? String(claimFlags.api) : null,
      osSpec: claimFlags.os ? String(claimFlags.os) : null,
      services: claimFlags.services || null,
      play:
        claimFlags.play === undefined || claimFlags.play === null
          ? null
          : parseBoolFlag(claimFlags.play),
      abi: claimFlags.abi || null,
      createIfMissing: parseBoolFlag(claimFlags.createIfMissing),
      snapshotLoad: claimFlags.snapshotLoad || null,
      snapshotSaveOnFree: claimFlags.snapshotSaveOnFree || null,
      wipeData: parseBoolFlag(claimFlags.wipeData),
      coldBoot: parseBoolFlag(claimFlags.cold),
      resetApp: claimFlags.resetApp || null,
      headless: parseBoolFlag(claimFlags.headless),
      force: parseBoolFlag(claimFlags.force),
      reason: claimFlags.reason || null,
    };
  }

  const startWaitMs = Date.now();
  let retainedBuildTicket = null;
  let coClaimInventory = options.inventory || null;

  const getMatchingOwnedLeases = (leasesMap, sessionId) => {
    let owned = Object.values(leasesMap || {}).filter(
      (l) =>
        l &&
        l.state === "active" &&
        l.sessionId === sessionId &&
        (!platFilter || (l.platform || "android") === platFilter) &&
        (!selectorSerial ||
          l.serial === selectorSerial ||
          l.udid === selectorSerial ||
          l.coreDeviceId === selectorSerial) &&
        (!coClaimReq ||
          (matchesProfile(l, {
            ...coClaimReq,
            kind: claimFlags.kind ? coClaimReq.kind : "any",
            snapshotLoad: null,
          }) &&
            !coClaimReq.wipeData &&
            !coClaimReq.coldBoot)),
    );
    if (owned.length > 1 && !selectorSerial) {
      const preferredPlat = cmdDeviceClass.targetPlatform || buildReqs.targetPlatform;
      if (preferredPlat === "ios" || preferredPlat === "android") {
        const platformMatched = owned.filter(
          (l) => (l.platform || "android") === preferredPlat,
        );
        if (platformMatched.length === 1) {
          owned = platformMatched;
        }
      }
    }
    return owned;
  };

  const refreshHostAndInventory = () => {
    const curState = readState(stateDir);
    const curCfg = curState.config || DEFAULT_CONFIG;
    let freshlyDiscoveredInventory = false;
    if (isClaimFlag && needsBuildCoordination && !options.inventory) {
      const preIdentity = resolveSessionIdentity({
        flags,
        env: callerEnv,
        state: curState,
        cwd,
        ppid: rawPpid,
        ancestorPids,
        processChain,
      });
      const matchingOwned = getMatchingOwnedLeases(curState.leases, preIdentity.sessionId);
      const hasOwnedActive =
        matchingOwned.length === 1 &&
        Boolean(matchingOwned[0].serial) &&
        matchingOwned[0].firstSeenOfflineAtMs == null &&
        (!coClaimReq ||
          (!coClaimReq.resetApp &&
            (!coClaimReq.snapshotLoad ||
              (matchingOwned[0].kind === "emulator" &&
                matchingOwned[0].loadedSnapshot === coClaimReq.snapshotLoad))));
      const nowPre = Date.now();
      const cacheStale =
        !coClaimInventory ||
        (curState.fleetEpoch || 0) !== coClaimInventory.fleetEpoch ||
        nowPre - (coClaimInventory.discoveredAtMs || 0) >= 1500;
      if (!hasOwnedActive && cacheStale) {
        const discStart = Date.now();
        const rawInv = discoverTargetFleet({
          targetPlatform: resolvedClaimPlatform,
          stateDir,
          runner,
          avdHome,
          cfg: curCfg,
          platform: options.platform,
          env: callerEnv,
        });
        coClaimInventory = {
          ...rawInv,
          discoveredAtMs: rawInv.discoveredAtMs ?? discStart,
          fleetEpoch: rawInv.fleetEpoch ?? (curState.fleetEpoch || 0),
        };
        freshlyDiscoveredInventory = true;
      }
    }
    const host =
      options.host ||
      options.inventory?.host ||
      (freshlyDiscoveredInventory && coClaimInventory?.host ? coClaimInventory.host : null) ||
      (needsBuildCoordination ? readHostResources(avdHome) : coClaimInventory?.host || null);
    const probedGradleBuildIds = new Set(
      Object.values(options.activeBuildLeases || curState.buildLeases || {})
        .filter(
          (b) =>
            b &&
            (b.tool === "gradle" ||
              (Array.isArray(b.claimedDaemonPids) && b.claimedDaemonPids.length > 0) ||
              Number(b.claimedGradleCount) > 0) &&
            b.requiresHeavySlot !== false &&
            (b.state === "active" || b.state === "draining") &&
            !b.preparingDevice &&
            b.buildId,
        )
        .map((b) => b.buildId),
    );
    const warmDaemonProbe =
      needsBuildCoordination && buildReqs.requiresHeavySlot
        ? probeWarmBuildDaemons(buildReqs, {
            ...options,
            activeBuildLeases: options.activeBuildLeases ?? curState.buildLeases,
          })
        : { warm: false, daemonPids: [] };
    return { host, inventory: coClaimInventory, warmDaemonProbe, probedGradleBuildIds };
  };

  let check;
  while (true) {
    const { host, inventory, warmDaemonProbe, probedGradleBuildIds } = refreshHostAndInventory();
    let txRes;
    try {
      txRes = withStateTransaction(
        stateDir,
        (state, { now, auditEvents }) => {
          const livenessCheck = options.livenessCheck || isPidAlive;
          const identity = resolveSessionIdentity({
            flags,
            env: callerEnv,
            state,
            cwd,
            ppid: rawPpid,
            ancestorPids,
            processChain,
          });
          const ttlSec = clampTtlSec(flags.ttl ?? flags.ttlSec, state.config);
          const ttlMs = ttlSec * 1000;

          let lease = null;
          let coClaimCandidate = null;
          let coClaimNeedsColdOrPrep = false;
          let coClaimDeviceAvailable = false;
          let effectiveInventory = inventory;

          if (needsDeviceLease) {
            const owned = getMatchingOwnedLeases(state.leases, identity.sessionId);
            if (owned.length > 1 && !selectorSerial) {
              return {
                mutated: false,
                value: {
                  status: "error",
                  exitCode: 3,
                  error: `Session "${identity.sessionId}" holds multiple active leases; pass --serial <serial> or --android/--ios.`,
                },
              };
            }
            if (owned.length === 1) {
              const matchedLease = owned[0];
              const needsIdempotentPrep = Boolean(
                coClaimReq &&
                  (coClaimReq.resetApp ||
                    (coClaimReq.snapshotLoad &&
                      (matchedLease.kind !== "emulator" ||
                        matchedLease.loadedSnapshot !== coClaimReq.snapshotLoad))),
              );
              if (
                matchedLease.firstSeenOfflineAtMs !== null &&
                matchedLease.firstSeenOfflineAtMs !== undefined
              ) {
                if (isClaimFlag) {
                  coClaimNeedsColdOrPrep = true;
                  coClaimDeviceAvailable = true;
                } else {
                  return {
                    mutated: false,
                    value: {
                      status: "error",
                      exitCode: 3,
                      error:
                        matchedLease.kind === "physical"
                          ? `Physical device "${matchedLease.serial || matchedLease.deviceKey}" is currently disconnected. Wait for it to reconnect or run "atc claim" to release the lease.`
                          : `Virtual device "${matchedLease.avd || matchedLease.serial || matchedLease.deviceKey}" crashed or went offline; run "atc claim" within the recovery window to restart it in-place.`,
                    },
                  };
                }
              } else if (!matchedLease.serial) {
                if (isClaimFlag) {
                  coClaimNeedsColdOrPrep = true;
                  coClaimDeviceAvailable = true;
                } else {
                  return {
                    mutated: false,
                    value: {
                      status: "error",
                      exitCode: 3,
                      error: `Lease ${matchedLease.leaseId} (${matchedLease.avd || matchedLease.deviceKey}) has no active adb serial because its last restart failed; run "atc claim" to restart it.`,
                    },
                  };
                }
              } else if (needsIdempotentPrep) {
                coClaimNeedsColdOrPrep = true;
                coClaimDeviceAvailable = true;
              } else {
                lease = matchedLease;
                coClaimDeviceAvailable = true;
              }
            } else if (!isClaimFlag) {
              return {
                mutated: false,
                value: {
                  status: "error",
                  exitCode: 3,
                  error: `Session "${identity.sessionId}" holds no active${platFilter ? ` ${platFilter}` : ""} device lease. Run "atc claim" first.`,
                },
              };
            } else if (coClaimReq && inventory) {
              const invEpoch = inventory.fleetEpoch ?? (state.fleetEpoch || 0);
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
              if (staleRunning.length > 0 || staleBooted.length > 0) {
                let nextRunning = (inventory.running || []).filter(
                  (d) => !isStoppedSinceInventory(d),
                );
                let nextOffline = [...(inventory.offline || [])];
                for (const d of staleRunning) {
                  if (
                    (d.avd || d.udid) &&
                    !nextOffline.some(
                      (o) => o.deviceKey === d.deviceKey || (d.avd && o.avd === d.avd),
                    )
                  ) {
                    nextOffline.push({
                      ...d,
                      deviceKey:
                        d.platform === "ios"
                          ? `sim:${d.udid || d.serial}`
                          : `avd:${d.avd}`,
                      serial: d.platform === "ios" ? d.udid || d.serial : null,
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
                      (b.avd && o.avd === b.avd) ||
                      (b.deviceKey && o.deviceKey === b.deviceKey),
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
                    platform: b.platform || baseMatch.platform || "android",
                    deviceKey:
                      b.deviceKey ||
                      baseMatch.deviceKey ||
                      (b.avd ? `avd:${b.avd}` : `serial:${b.serial}`),
                    kind: "emulator",
                    avd: b.avd || baseMatch.avd || null,
                    udid: b.udid || baseMatch.udid || null,
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
              reconcileOfflineLeases(
                state,
                effectiveInventory,
                identity.sessionId,
                now,
                livenessCheck,
                avdHome,
              );
              const selection = selectCandidateUnderLock(
                state,
                effectiveInventory,
                coClaimReq,
                null,
                now,
                identity.sessionId,
                livenessCheck,
                { suppressResourceError: true },
              );
              if (selection.priority === 1 && !selection.needsWarmPrep) {
                coClaimCandidate = selection.candidate;
                coClaimDeviceAvailable = true;
              } else if (selection.priority !== null) {
                coClaimNeedsColdOrPrep = true;
                coClaimDeviceAvailable = true;
              } else {
                const anyWarmMatchInFleet = (effectiveInventory.running || []).some((d) =>
                  matchesProfile(d, coClaimReq),
                );
                const anyOfflineMatchInFleet = (effectiveInventory.offline || []).some((d) =>
                  matchesProfile(d, coClaimReq),
                );
                if (!anyWarmMatchInFleet && !anyOfflineMatchInFleet) {
                  coClaimNeedsColdOrPrep = true;
                  coClaimDeviceAvailable = true;
                } else {
                  coClaimDeviceAvailable = false;
                }
              }
            }
          }

          const effectiveDeviceForCheck = lease || coClaimCandidate;
          if (effectiveDeviceForCheck) {
            if (!needsBuildCoordination && lease) {
              addLeaseWorker(lease, process.pid, livenessCheck);
              if (!plan.readOnly) {
                lease.loadedSnapshot = null;
              }
              lease.renewedAtMs = now;
              lease.expiresAtMs = Math.max(lease.expiresAtMs, now + ttlMs);
              return {
                mutated: true,
                value: {
                  status: "admitted",
                  exitCode: 0,
                  lease,
                  buildLease: null,
                  coAllocatedDevice: Boolean(
                    coAllocatedLeaseId && lease.leaseId === coAllocatedLeaseId,
                  ),
                  sessionId: identity.sessionId,
                  ttlMs,
                },
              };
            }
          } else if (!needsDeviceLease) {
            if (!needsBuildCoordination) {
              return {
                mutated: false,
                value: {
                  status: "admitted",
                  exitCode: 0,
                  lease: null,
                  buildLease: null,
                  sessionId: identity.sessionId,
                  ttlMs,
                },
              };
            }
          }

          // Nested / Re-entrant build check
          const nested = evaluateNestedBuildAdmission(state, {
            inheritedOpId,
            inheritedNonce,
            ancestorPids,
            processChain,
            requestedKeys: buildReqs.resourceKeys,
            requiresHeavySlot: Boolean(buildReqs.requiresHeavySlot),
            requiresDevice: Boolean(needsDeviceLease),
            hasActiveDeviceLease: Boolean(lease),
            livenessCheck,
          });
          if (nested.deadlockHazard) {
            if (Array.isArray(auditEvents)) {
              auditEvents.push({
                event: "build_deadlock_reject",
                sessionId: identity.sessionId,
                workspaceRoot: buildReqs.workspaceRoot,
                resourceKeys: buildReqs.resourceKeys,
                reason: nested.reason,
              });
            }
            return {
              mutated: false,
              value: {
                status: "error",
                exitCode: 3,
                error: nested.reason,
              },
            };
          }
          if (nested.reentrant) {
            if (Array.isArray(auditEvents)) {
              auditEvents.push({
                event: "build_reentrant",
                sessionId: identity.sessionId,
                parentBuildId: nested.buildLease.buildId,
                opId: nested.buildLease.opId,
                workspaceRoot: buildReqs.workspaceRoot,
                tool: buildReqs.tool,
                deltaKeys: nested.deltaKeys || [],
              });
            }
            if (lease) {
              addLeaseWorker(lease, process.pid, livenessCheck);
              lease.loadedSnapshot = null;
              lease.renewedAtMs = now;
              lease.expiresAtMs = Math.max(lease.expiresAtMs, now + ttlMs);
            }
            return {
              mutated: Boolean(lease || (nested.deltaKeys && nested.deltaKeys.length > 0)),
              value: {
                status: "admitted",
                exitCode: 0,
                lease,
                buildLease: nested.buildLease,
                coAllocatedDevice: Boolean(
                  coAllocatedLeaseId && lease && lease.leaseId === coAllocatedLeaseId,
                ),
                reentrant: true,
                sessionId: identity.sessionId,
                ttlMs,
              },
            };
          }

          // Build Queue + Co-Scheduling Admission
          const waitSec =
            rawWait !== undefined
              ? Number(rawWait)
              : (state.config?.defaultBuildWaitSec ?? DEFAULT_CONFIG.defaultBuildWaitSec ?? 600);
          const waitExpiresAtMs = startWaitMs + waitSec * 1000;
          const reorderWindowMs =
            (flags.reorderWindow !== undefined || flags.reorderWindowSec !== undefined
              ? Number(flags.reorderWindow ?? flags.reorderWindowSec)
              : (state.config?.buildReorderWindowSec ??
                DEFAULT_CONFIG.buildReorderWindowSec ??
                120)) * 1000;
          const hbTimeoutSec =
            state.config?.queueHeartbeatTimeoutSec ?? DEFAULT_CONFIG.queueHeartbeatTimeoutSec ?? 10;
          const hbTimeoutMs = hbTimeoutSec * 1000;

          if (!Array.isArray(state.buildQueue)) {
            state.buildQueue = [];
          }
          let ticket =
            (retainedBuildTicket?.ticketId &&
              state.buildQueue.find((t) => t.ticketId === retainedBuildTicket.ticketId)) ||
            state.buildQueue.find(
              (t) => t.sessionId === identity.sessionId && t.waiterPid === process.pid,
            ) ||
            null;
          const wasAlreadyQueued = Boolean(ticket || retainedBuildTicket);
          const coAllocResourceKey =
            isClaimFlag && !lease
              ? `device:${coClaimReq?.platform || "android"}:${coClaimReq?.serial || coClaimReq?.avd || coClaimReq?.udid || coClaimReq?.deviceType || "any"}`
              : null;
          if (!ticket) {
            const enqueuedAtMs = retainedBuildTicket ? retainedBuildTicket.enqueuedAtMs : now;
            const starvationDeadlineMs = retainedBuildTicket
              ? retainedBuildTicket.starvationDeadlineMs
              : enqueuedAtMs + reorderWindowMs;
            const seq =
              retainedBuildTicket?.seq ??
              ((state.nextBuildQueueSeq = (state.nextBuildQueueSeq || 0) + 1));
            const ticketId =
              retainedBuildTicket?.ticketId || `bq_${randomNonce().slice(0, 12)}`;
            ticket = {
              ticketId,
              seq,
              sessionId: identity.sessionId,
              waiterPid: process.pid,
              resourceKeys: buildReqs.resourceKeys,
              workspaceRoot: buildReqs.workspaceRoot,
              requiresHeavySlot: Boolean(buildReqs.requiresHeavySlot),
              requiresWorkspaceLock: Boolean(buildReqs.requiresWorkspaceLock),
              buildClass: buildReqs.kind,
              tool: buildReqs.tool,
              pinnedDeviceLeaseId: lease?.leaseId || null,
              pinnedDeviceKey: lease?.deviceKey || null,
              requiresDeviceCoAlloc: Boolean(isClaimFlag && !lease),
              coAllocResourceKey,
              coAllocReq: isClaimFlag && !lease ? coClaimReq : null,
              deviceAvailableForCoAlloc: coClaimDeviceAvailable,
              enqueuedAtMs,
              starvationDeadlineMs,
              lastHeartbeatAtMs: now,
              waitExpiresAtMs,
            };
            state.buildQueue.push(ticket);
          } else {
            ticket.lastHeartbeatAtMs = now;
            ticket.waiterPid = process.pid;
            ticket.pinnedDeviceLeaseId = lease?.leaseId || null;
            ticket.pinnedDeviceKey = lease?.deviceKey || null;
            ticket.requiresDeviceCoAlloc = Boolean(isClaimFlag && !lease);
            ticket.coAllocResourceKey = coAllocResourceKey;
            ticket.coAllocReq = isClaimFlag && !lease ? coClaimReq : null;
            ticket.deviceAvailableForCoAlloc = coClaimDeviceAvailable;
          }

          const pool = computeBuildPoolSnapshot(state, host);
          const { chosenIdx } = pruneAndSelectNextBuildTicket(
            state.buildQueue,
            {
              activeWorkspaces: pool.activeWorkspaces,
              activeHeavyBuilds: pool.activeHeavyBuilds,
              maxHostBuilds: pool.effectiveMaxBuilds,
              burstBuilds: pool.burstBuilds,
              leases: state.leases,
              isDeviceAvailableForTicket: (t) => {
                if (!t.requiresDeviceCoAlloc) return true;
                if (t.ticketId === ticket.ticketId) {
                  return coClaimDeviceAvailable;
                }
                if (t.coAllocReq && effectiveInventory) {
                  const reqPlat = t.coAllocReq.platform || "android";
                  const queriedPlats = effectiveInventory.queriedPlatforms || [resolvedClaimPlatform];
                  if (queriedPlats.includes(reqPlat)) {
                    const sel = selectCandidateUnderLock(
                      state,
                      effectiveInventory,
                      t.coAllocReq,
                      null,
                      now,
                      t.sessionId,
                      livenessCheck,
                      { suppressResourceError: true },
                    );
                    if (sel.priority !== null) return true;
                    const anyWarm = (effectiveInventory.running || []).some((d) =>
                      matchesProfile(d, t.coAllocReq),
                    );
                    const anyOff = (effectiveInventory.offline || []).some((d) =>
                      matchesProfile(d, t.coAllocReq),
                    );
                    return !anyWarm && !anyOff;
                  }
                }
                return typeof t.deviceAvailableForCoAlloc === "boolean"
                  ? t.deviceAvailableForCoAlloc
                  : true;
              },
            },
            now,
            {
              reorderWindowMs,
              hbTimeoutMs,
              livenessCheck,
              currentTicketId: wasAlreadyQueued ? null : ticket.ticketId,
            },
          );
          const chosenTicket = chosenIdx >= 0 ? state.buildQueue[chosenIdx] : null;
          let canAdmit = Boolean(chosenTicket && chosenTicket.ticketId === ticket.ticketId);
          let ramCheck = null;

          let effectiveWarmDaemon = Boolean(warmDaemonProbe.warm);
          let invalidatedWarmAfterProbe = false;
          const effectiveDaemonPids = Array.isArray(warmDaemonProbe.daemonPids)
            ? [...warmDaemonProbe.daemonPids]
            : [];
          const effectiveClaimedDaemonPids = Array.isArray(warmDaemonProbe.claimedDaemonPids)
            ? [...warmDaemonProbe.claimedDaemonPids]
            : effectiveWarmDaemon && effectiveDaemonPids.length > 0
              ? [effectiveDaemonPids[0]]
              : [];
          const hasGradleClause =
            buildReqs.tool === "gradle" ||
            (Array.isArray(buildReqs.clauseBuildReqs) &&
              buildReqs.clauseBuildReqs.some((r) => r?.tool === "gradle"));
          if ((effectiveWarmDaemon || warmDaemonProbe.anyWarm) && hasGradleClause) {
            const newlyActiveGradle = Object.values(state.buildLeases || {}).filter(
              (b) =>
                b &&
                (b.tool === "gradle" ||
                  (Array.isArray(b.claimedDaemonPids) && b.claimedDaemonPids.length > 0) ||
                  Number(b.claimedGradleCount) > 0) &&
                b.requiresHeavySlot !== false &&
                (b.state === "active" || b.state === "draining") &&
                !b.preparingDevice &&
                (!b.buildId || !probedGradleBuildIds?.has(b.buildId)),
            );
            if (newlyActiveGradle.length > 0) {
              for (const b of newlyActiveGradle) {
                const claimedList =
                  Array.isArray(b.claimedDaemonPids) && b.claimedDaemonPids.length > 0
                    ? b.claimedDaemonPids.map(Number).filter(Boolean)
                    : Number(b.claimedDaemonPid)
                      ? [Number(b.claimedDaemonPid)]
                      : [];
                if (claimedList.length > 0) {
                  for (const claimedPid of claimedList) {
                    const idx = effectiveDaemonPids.indexOf(claimedPid);
                    if (idx >= 0) {
                      effectiveDaemonPids.splice(idx, 1);
                    }
                    const cIdx = effectiveClaimedDaemonPids.indexOf(claimedPid);
                    if (cIdx >= 0) {
                      effectiveClaimedDaemonPids.splice(cIdx, 1);
                    }
                    if (
                      idx < 0 &&
                      (!Array.isArray(warmDaemonProbe.daemonPids) ||
                        warmDaemonProbe.daemonPids.length === 0)
                    ) {
                      effectiveWarmDaemon = false;
                      invalidatedWarmAfterProbe = true;
                    }
                  }
                } else {
                  const anonCount = Math.max(1, Number(b.claimedGradleCount) || 1);
                  for (let k = 0; k < anonCount; k++) {
                    if (effectiveDaemonPids.length > 0) {
                      const removed = effectiveDaemonPids.shift();
                      const cIdx = effectiveClaimedDaemonPids.indexOf(removed);
                      if (cIdx >= 0) effectiveClaimedDaemonPids.splice(cIdx, 1);
                    } else {
                      effectiveWarmDaemon = false;
                      invalidatedWarmAfterProbe = true;
                    }
                  }
                }
              }
              const requiredDaemons = Math.max(1, Number(warmDaemonProbe.claimedGradleCount) || 1);
              if (
                Array.isArray(warmDaemonProbe.daemonPids) &&
                warmDaemonProbe.daemonPids.length > 0 &&
                effectiveDaemonPids.length < requiredDaemons
              ) {
                effectiveWarmDaemon = false;
                invalidatedWarmAfterProbe = true;
              }
            }
          }
          const coldEstimateMb = Math.max(
            computeColdBuildRamDemandMb(buildReqs, state.config?.buildRamEstimateMb ?? 3072),
            explicitRamMb || 0,
          );
          const partialWarmColdMb =
            warmDaemonProbe.anyWarm &&
            typeof warmDaemonProbe.coldRamMb === "number" &&
            warmDaemonProbe.coldRamMb > 0 &&
            !invalidatedWarmAfterProbe
              ? Math.max(warmDaemonProbe.coldRamMb, explicitRamMb || 0)
              : coldEstimateMb;
          const estimateMb = effectiveWarmDaemon
            ? Math.max(0, explicitRamMb || 0)
            : partialWarmColdMb;
          if (canAdmit && buildReqs.requiresHeavySlot && !parseBoolFlag(flags.force)) {
            ramCheck = checkUnifiedRamAdmission(state, host, estimateMb, now, {
              hysteresisMb: wasAlreadyQueued ? 0 : undefined,
            });
            if (!ramCheck.allowed) {
              canAdmit = false;
            }
          }

          if (canAdmit) {
            state.buildQueue.splice(chosenIdx, 1);
            let coAllocatedDevice = false;
            if (!lease && coClaimCandidate) {
              const dev = coClaimCandidate;
              const newLeaseId = `lease_${randomNonce().slice(0, 12)}`;
              lease = {
                leaseId: newLeaseId,
                deviceKey: dev.deviceKey,
                platform: dev.platform || "android",
                kind: dev.kind,
                avd: dev.avd || null,
                udid: dev.udid || null,
                coreDeviceId: dev.coreDeviceId || null,
                serial: dev.serial,
                profile: dev.profile,
                dataPath: dev.dataPath || null,
                sessionId: identity.sessionId,
                anchorPid: identity.anchorPid,
                parentPid: resolveStableParentPid(rawPpid, processChain),
                state: "active",
                isRecovery: false,
                workerPid: null,
                replacingAvd: null,
                requiredRamMb: dev.requiredRamMb || 0,
                requiredDiskMb: 0,
                fsDev: dev.fsDev ?? host?.fsDev ?? null,
                avdPath: dev.avdPath || null,
                loadedSnapshot: coClaimReq?.snapshotLoad || null,
                saveSnapshotOnFree: coClaimReq?.snapshotSaveOnFree || null,
                claimedAtMs: now,
                activatedAtMs: now,
                activatedEpoch: state.fleetEpoch || 0,
                renewedAtMs: now,
                expiresAtMs: now + ttlMs,
                deadlineMs: null,
                firstSeenOfflineAtMs: null,
                reason: coClaimReq?.reason || null,
              };
              state.leases[dev.deviceKey] = lease;
              state.queue = (state.queue || []).filter((t) => t.sessionId !== identity.sessionId);
              coAllocatedDevice = true;
            }
            if (lease) {
              addLeaseWorker(lease, process.pid, livenessCheck);
              lease.loadedSnapshot = null;
              lease.renewedAtMs = now;
              lease.expiresAtMs = Math.max(lease.expiresAtMs || 0, now + ttlMs);
            }

            const buildId = `build_${randomNonce().slice(0, 12)}`;
            const reserveWindowMs = (state.config?.buildRamReservationWindowSec ?? 30) * 1000;
            const isColdPrep = Boolean(!lease && coClaimNeedsColdOrPrep);
            const prepBudgetMs = isColdPrep
              ? ((state.config?.bootTimeoutSec || 180) + (state.config?.stopTimeoutSec || 60)) *
                  1000 +
                Math.max(0, (waitExpiresAtMs || now) - now)
              : 0;
            const buildLease = {
              buildId,
              opId: `op_${randomNonce().slice(0, 12)}`,
              opNonce: randomNonce().slice(0, 16),
              sessionId: identity.sessionId,
              anchorPid: identity.anchorPid,
              workerPid: process.pid,
              execWrapperPid: process.pid,
              workerPids: [process.pid],
              workerPgids: [],
              resourceKeys: buildReqs.resourceKeys,
              workspaceRoot: buildReqs.workspaceRoot,
              buildClass: buildReqs.kind,
              tool: buildReqs.tool,
              requiresHeavySlot: Boolean(buildReqs.requiresHeavySlot),
              requiresWorkspaceLock: Boolean(buildReqs.requiresWorkspaceLock),
              isBurstSlot: Boolean(
                buildReqs.requiresHeavySlot && pool.activeHeavyBuilds >= pool.effectiveMaxBuilds,
              ),
              maxConcurrentBuilds: pool.effectiveMaxBuilds,
              state: "active",
              preparingDevice: isColdPrep,
              pinnedDeviceLeaseId: lease?.leaseId || null,
              pinnedDeviceKey: lease?.deviceKey || null,
              claimedDaemonPid:
                (effectiveWarmDaemon || (warmDaemonProbe.anyWarm && !invalidatedWarmAfterProbe)) &&
                (effectiveClaimedDaemonPids.length > 0 || effectiveDaemonPids.length > 0)
                  ? effectiveClaimedDaemonPids[0] || effectiveDaemonPids[0]
                  : null,
              claimedDaemonPids:
                effectiveWarmDaemon || (warmDaemonProbe.anyWarm && !invalidatedWarmAfterProbe)
                  ? effectiveClaimedDaemonPids.length > 0
                    ? effectiveClaimedDaemonPids
                    : effectiveDaemonPids.slice(
                        0,
                        Math.max(1, Number(warmDaemonProbe.claimedGradleCount) || 1),
                      )
                  : [],
              claimedGradleCount:
                effectiveWarmDaemon || (warmDaemonProbe.anyWarm && !invalidatedWarmAfterProbe)
                  ? Math.max(1, Number(warmDaemonProbe.claimedGradleCount) || 1)
                  : 0,
              daemonPids: effectiveDaemonPids,
              reservedRamMb: buildReqs.requiresHeavySlot ? estimateMb : 0,
              ramReservationUntilMs:
                buildReqs.requiresHeavySlot && estimateMb > 0
                  ? now + Math.max(reserveWindowMs, prepBudgetMs)
                  : 0,
              createdAtMs: now,
              renewedAtMs: now,
              expiresAtMs: now + Math.max(ttlMs, prepBudgetMs),
              op: op.name,
              commandPreview: (plan.probe?.[0] ? [plan.probe[0].cmd, ...plan.probe[0].args] : [op.name]).join(" ").slice(0, 200),
            };
            state.buildLeases[buildId] = buildLease;

            if (!lease && coClaimNeedsColdOrPrep) {
              retainedBuildTicket = {
                ticketId: ticket.ticketId,
                seq: ticket.seq,
                enqueuedAtMs: ticket.enqueuedAtMs,
                starvationDeadlineMs: ticket.starvationDeadlineMs,
              };
              return {
                mutated: true,
                value: {
                  status: "needs_cold_claim",
                  buildLease,
                  sessionId: identity.sessionId,
                  ttlMs,
                  waitSec,
                  waitExpiresAtMs,
                  waitedMs: Math.max(0, now - ticket.enqueuedAtMs),
                },
              };
            }

            if (Array.isArray(auditEvents)) {
              if (coAllocatedDevice && lease) {
                auditEvents.push({
                  event: "device_claim",
                  sessionId: identity.sessionId,
                  leaseId: lease.leaseId,
                  deviceKey: lease.deviceKey,
                  platform: lease.platform,
                  kind: lease.kind,
                  serial: lease.serial,
                  avd: lease.avd,
                  udid: lease.udid,
                  coAllocatedWithBuildId: buildId,
                });
              }
              auditEvents.push({
                event: coAllocatedDevice ? "build_co_alloc_admit" : "build_admit",
                sessionId: identity.sessionId,
                buildId,
                opId: buildLease.opId,
                tool: buildReqs.tool,
                buildClass: buildReqs.kind,
                workspaceRoot: buildReqs.workspaceRoot,
                resourceKeys: buildReqs.resourceKeys,
                pinnedDeviceLeaseId: lease?.leaseId || null,
                pinnedDeviceSerial: lease?.serial || null,
                waitedMs: Math.max(0, now - ticket.enqueuedAtMs),
              });
            }

            return {
              mutated: true,
              value: {
                status: "admitted",
                exitCode: 0,
                lease,
                buildLease,
                coAllocatedDevice: Boolean(
                  coAllocatedDevice ||
                    (coAllocatedLeaseId && lease && lease.leaseId === coAllocatedLeaseId),
                ),
                reentrant: false,
                sessionId: identity.sessionId,
                ttlMs,
              },
            };
          }

          // Cannot admit right now
          const hasActiveVirtualDeviceLease = Object.values(state.leases || {}).some(
            (l) => l && l.kind === "emulator",
          );
          const noRecoverableWorkload =
            ramCheck &&
            !ramCheck.allowed &&
            pool.activeHeavyBuilds === 0 &&
            !hasActiveVirtualDeviceLease;
          if (noRecoverableWorkload) {
            state.buildQueue = state.buildQueue.filter((t) => t.ticketId !== ticket.ticketId);
            return {
              mutated: wasAlreadyQueued,
              value: {
                status: "error",
                exitCode: 5,
                error: `Insufficient host RAM to admit build (${ramCheck.effectiveFreeMb} MB projected free < ${ramCheck.requiredFloorMb} MB required floor). Pass --force to override.`,
              },
            };
          }
          if (waitSec <= 0 || now >= waitExpiresAtMs) {
            state.buildQueue = state.buildQueue.filter((t) => t.ticketId !== ticket.ticketId);
            return {
              mutated: wasAlreadyQueued,
              value: {
                status: "error",
                exitCode: 2,
                error: `Build slot or workspace lock (${buildReqs.resourceKeys.join(", ")}) is currently busy (wait timeout reached).`,
              },
            };
          }

          retainedBuildTicket = {
            ticketId: ticket.ticketId,
            seq: ticket.seq,
            enqueuedAtMs: ticket.enqueuedAtMs,
            starvationDeadlineMs: ticket.starvationDeadlineMs,
          };

          // Coupled heartbeat: keep pinned device lease alive while waiting in buildQueue
          if (lease) {
            lease.renewedAtMs = now;
            lease.expiresAtMs = Math.max(lease.expiresAtMs || 0, now + ttlMs);
          }

          if (!wasAlreadyQueued && Array.isArray(auditEvents)) {
            auditEvents.push({
              event: "build_queue_enter",
              sessionId: identity.sessionId,
              ticketId: ticket.ticketId,
              tool: buildReqs.tool,
              buildClass: buildReqs.kind,
              workspaceRoot: buildReqs.workspaceRoot,
              resourceKeys: buildReqs.resourceKeys,
              pinnedDeviceLeaseId: lease?.leaseId || null,
              requiresDeviceCoAlloc: Boolean(isClaimFlag && !lease),
            });
          }

          return {
            mutated: true,
            value: {
              status: "queued",
              ticket,
              hbTimeoutSec,
              lease,
              ttlMs,
            },
          };
        },
        options,
      );
    } catch (err) {
      cleanupCoAllocatedLeaseOnEarlyError();
      return { exitCode: 1, error: err.message };
    }

    if (txRes.status === "stale_inventory") {
      coClaimInventory = null;
      continue;
    }

    if (txRes.status === "needs_cold_claim") {
      const effectiveClaimFlags = {
        ...claimFlags,
        ...(claimFlags.platform || claimFlags.ios || claimFlags.android
          ? {}
          : { platform: resolvedClaimPlatform }),
        wait: 0,
      };
      let claimRes;
      try {
        claimRes = cmdClaim(
          stateDir,
          effectiveClaimFlags,
          options,
        );
      } catch (err) {
        claimRes = { exitCode: 1, error: err.message };
      }
      if (!claimRes || claimRes.exitCode !== 0 || !claimRes.lease) {
        if (txRes.buildLease?.buildId) {
          try {
            withStateTransaction(
              stateDir,
              (state) => {
                if (state.buildLeases?.[txRes.buildLease.buildId]) {
                  delete state.buildLeases[txRes.buildLease.buildId];
                  return { mutated: true };
                }
                return { mutated: false };
              },
              options,
            );
          } catch {
            // Best-effort rollback of reserved build lease
          }
        }
        if (
          claimRes?.exitCode === 2 &&
          (txRes.waitSec ?? 0) > 0 &&
          Date.now() < (txRes.waitExpiresAtMs ?? startWaitMs)
        ) {
          coClaimInventory = null;
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        return claimRes || { exitCode: 1, error: "Device claim failed during co-allocation." };
      }
      retainedBuildTicket = null;
      const claimedLease = claimRes.lease;
      const coldCreatedNewLease = Boolean(!claimRes.idempotent);
      if (coldCreatedNewLease && claimedLease?.leaseId) {
        coAllocatedLeaseId = claimedLease.leaseId;
        coAllocatedDeviceKey = claimedLease.deviceKey || null;
      }
      // Typed-op invocations carry the lease serial themselves; nothing to re-validate here.

      const postClaimTx = withStateTransaction(
        stateDir,
        (state, { now, auditEvents }) => {
          const livenessCheck = options.livenessCheck || isPidAlive;
          const curBuild = state.buildLeases?.[txRes.buildLease.buildId];
          const { lease: curDev } = findLeaseEntry(
            state,
            claimedLease.deviceKey,
            claimedLease.leaseId,
          );
          const deviceGone = Boolean(
            !curDev ||
              curDev.state !== "active" ||
              curDev.sessionId !== txRes.sessionId,
          );
          if (!curBuild || curBuild.state !== "active" || deviceGone) {
            if (curBuild) {
              delete state.buildLeases[txRes.buildLease.buildId];
            }
            return {
              mutated: Boolean(curBuild),
              value: { ok: false, deviceGone },
            };
          }
          addLeaseWorker(curDev, process.pid, livenessCheck);
          curDev.loadedSnapshot = null;
          curDev.renewedAtMs = now;
          curDev.expiresAtMs = Math.max(curDev.expiresAtMs || 0, now + txRes.ttlMs);
          const reserveWindowMs = (state.config?.buildRamReservationWindowSec ?? 30) * 1000;
          curBuild.preparingDevice = false;
          curBuild.pinnedDeviceLeaseId = claimedLease.leaseId;
          curBuild.pinnedDeviceKey = claimedLease.deviceKey;
          curBuild.createdAtMs = now;
          curBuild.renewedAtMs = now;
          curBuild.expiresAtMs = now + txRes.ttlMs;
          curBuild.ramReservationUntilMs = curBuild.requiresHeavySlot
            ? now + reserveWindowMs
            : 0;
          if (Array.isArray(auditEvents)) {
            auditEvents.push({
              event: "build_co_alloc_admit",
              sessionId: txRes.sessionId,
              buildId: txRes.buildLease.buildId,
              opId: txRes.buildLease.opId,
              tool: buildReqs.tool,
              buildClass: buildReqs.kind,
              workspaceRoot: buildReqs.workspaceRoot,
              resourceKeys: buildReqs.resourceKeys,
              pinnedDeviceLeaseId: claimedLease.leaseId,
              pinnedDeviceSerial: claimedLease.serial || null,
              waitedMs: txRes.waitedMs || 0,
            });
          }
          return {
            mutated: true,
            value: { ok: true, buildLease: { ...curBuild } },
          };
        },
        options,
      );
      if (!postClaimTx?.ok) {
        if (postClaimTx?.deviceGone) {
          coAllocatedLeaseId = null;
          coAllocatedDeviceKey = null;
        }
        // Build reservation or device lease was lost during cold device prep; re-enter admission loop
        continue;
      }
      check = {
        status: "admitted",
        exitCode: 0,
        lease: claimedLease,
        buildLease: postClaimTx.buildLease,
        coAllocatedDevice: coldCreatedNewLease,
        reentrant: false,
        sessionId: txRes.sessionId,
        ttlMs: txRes.ttlMs,
      };
      break;
    }

    if (txRes.status === "error") {
      cleanupCoAllocatedLeaseOnEarlyError();
      return { exitCode: txRes.exitCode, error: txRes.error };
    }

    if (txRes.status === "admitted") {
      check = txRes;
      break;
    }

    // Queued in buildQueue: sleep with jitter and heartbeat both build ticket and pinned device lease
    const pollSleepCapMs = Math.max(100, Math.floor(((txRes.hbTimeoutSec || 10) * 1000) / 4));
    const sleepMs = Math.min(250 + Math.floor(Math.random() * 150), pollSleepCapMs);
    sleepSync(sleepMs);
  }

  const heartbeatIntervalMs = Math.min(60_000, Math.max(1000, Math.floor(check.ttlMs / 3)));
  const onHeartbeat = () => {
    withStateTransaction(stateDir, (state, { now }) => {
      let mutated = false;
      if (check.lease) {
        const { lease: cur } = findLeaseEntry(
          state,
          check.lease.deviceKey,
          check.lease.leaseId,
        );
        if (cur && cur.leaseId === check.lease.leaseId && cur.sessionId === check.sessionId) {
          const killCommittedAgeMs =
            typeof cur.gcKillCommittedAtMs === "number" &&
            Number.isFinite(cur.gcKillCommittedAtMs)
              ? now - cur.gcKillCommittedAtMs
              : -1;
          if (!(killCommittedAgeMs >= 0 && killCommittedAgeMs < 30_000)) {
            delete cur.gcReapingAtMs;
            delete cur.gcKillCommittedAtMs;
            syncLeaseWorkers(cur, options.livenessCheck || isPidAlive);
            cur.renewedAtMs = now;
            cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + check.ttlMs);
            mutated = true;
          }
        }
      }
      if (check.buildLease && !check.reentrant) {
        const curBuild = state.buildLeases?.[check.buildLease.buildId];
        if (curBuild && curBuild.state === "active") {
          syncLeaseWorkers(curBuild, options.livenessCheck || isPidAlive);
          curBuild.renewedAtMs = now;
          curBuild.expiresAtMs = Math.max(curBuild.expiresAtMs || 0, now + check.ttlMs);
          mutated = true;
        }
      }
      return { mutated };
    }, options);
  };

  let spawnedChildPid = null;
  let spawnedChildStartToken = null;
  let childExitInfo = { exitCode: 0, signal: null, aborted: false };
  const onChildSpawn = (
    childPid,
    { isProcessGroup, freshGeneration, archivedGeneration, startToken } = {},
  ) => {
    spawnedChildPid = childPid;
    const effectivePlatform = options.platform || process.platform;
    const isWin = effectivePlatform === "win32";
    try {
      if (isProcessGroup && isWin && !archivedGeneration) {
        archiveWindowsProcessGroupGeneration(childPid);
      }
      spawnedChildStartToken =
        startToken ||
        (isProcessGroup && !options.livenessCheck && !(isWin && archivedGeneration)
          ? getPosixProcessStartToken(childPid, {
              platform: effectivePlatform,
              spawnSyncFn: options.spawnSyncFn || options.runner,
              isSpawnCapture: true,
            })
          : null);
      if (spawnedChildStartToken) {
        seedPosixPgidStartTokens(childPid, spawnedChildStartToken);
      }
      const alreadyArchivedInMemory = Boolean(archivedGeneration || (isProcessGroup && isWin));
      withStateTransaction(
        stateDir,
        (state) => {
          let mutated = false;
          if (check.lease) {
            const { lease: cur } = findLeaseEntry(
              state,
              check.lease.deviceKey,
              check.lease.leaseId,
            );
            if (cur && cur.leaseId === check.lease.leaseId && cur.sessionId === check.sessionId) {
              addLeaseWorker(cur, childPid, options.livenessCheck || isPidAlive, {
                isProcessGroup: Boolean(isProcessGroup),
                freshGeneration: Boolean(freshGeneration ?? true),
                archivedGeneration: alreadyArchivedInMemory,
                startToken: spawnedChildStartToken,
                platform: effectivePlatform,
                spawnSyncFn: options.spawnSyncFn || options.runner,
                allowSubprocess: false,
              });
              mutated = true;
            }
          }
          if (check.buildLease && !check.reentrant) {
            const curBuild = state.buildLeases?.[check.buildLease.buildId];
            if (curBuild && curBuild.state === "active") {
              curBuild.workerPid = childPid;
              addLeaseWorker(curBuild, childPid, options.livenessCheck || isPidAlive, {
                isProcessGroup: Boolean(isProcessGroup),
                freshGeneration: Boolean(freshGeneration ?? true),
                archivedGeneration: alreadyArchivedInMemory,
                startToken: spawnedChildStartToken,
                platform: effectivePlatform,
                spawnSyncFn: options.spawnSyncFn || options.runner,
                allowSubprocess: false,
              });
              mutated = true;
            }
          }
          return { mutated };
        },
        {
          ...options,
          archivedGeneration: alreadyArchivedInMemory,
          freshGenerationPgids:
            isProcessGroup && isWin && !options.livenessCheck
              ? [childPid]
              : undefined,
          freshGenerationStartTokens:
            spawnedChildStartToken &&
            spawnedChildStartToken !== "__exited__" &&
            isProcessGroup
              ? { [String(childPid)]: spawnedChildStartToken }
              : undefined,
        },
      );
    } catch {
      // Best-effort child PID registration
    }
  };

  const steps = [];
  try {
    let invocations;
    try {
      invocations = plan.makeInvocations(check.lease || null);
    } catch (err) {
      return { exitCode: err?.code === "physical_not_allowed" ? 3 : 1, error: err.message, errorCode: err?.code || null, steps };
    }
    let exitCode = 0;
    for (const inv of invocations) {
      const prepared = prepareOpChildInvocation(inv, {
        lease: check.lease || null,
        sessionId: check.sessionId,
        baseEnv: callerEnv,
        buildLease: check.buildLease || null,
        tool: check.buildLease ? buildReqs.tool : null,
      });
      const startedAt = Date.now();
      childExitInfo = { exitCode: 0, signal: null, aborted: false };
      exitCode = await spawnWithHeartbeat(prepared.cmd, prepared.args, check.lease, check.sessionId, onHeartbeat, {
        ...options,
        prepared: { ...prepared, cwd: prepared.cwd || cwd },
        cwd: prepared.cwd || cwd,
        buildLease: check.buildLease,
        buildMode: Boolean(check.buildLease),
        heartbeatIntervalMs,
        onChildSpawn,
        stdio: plan.stdio || options.stdio,
        onOutput: plan.onOutput || options.onOutput,
        timeoutMs: inv.timeoutSec ? inv.timeoutSec * 1000 : options.timeoutMs,
        onChildExit: (info) => {
          childExitInfo = info;
        },
      });
      steps.push({
        cmd: prepared.cmd,
        args: prepared.args,
        cwd: prepared.cwd || cwd,
        exitCode,
        timedOut: Boolean(childExitInfo.timedOut),
        durationMs: Date.now() - startedAt,
      });
      if (exitCode !== 0) break;
    }
    return { exitCode, steps, lease: check.lease || null, sessionId: check.sessionId };
  } finally {
    try {
      let keepSpawnedChildGroup = false;
      if (spawnedChildPid && !options.livenessCheck) {
        try {
          keepSpawnedChildGroup = hasAliveProcessInGroup(spawnedChildPid, {
            allowSubprocess: true,
            triState: true,
            spawnSyncFn: options.spawnSyncFn,
            platform: options.platform,
            expectedStartToken: spawnedChildStartToken,
          });
        } catch {
          keepSpawnedChildGroup = false;
        }
      }
      if (check.buildLease && !check.reentrant) {
        withStateTransaction(
          stateDir,
          (state, { now, auditEvents }) => {
            const curBuild = state.buildLeases?.[check.buildLease.buildId];
            if (!curBuild) return { mutated: false };
            const abortedOrTimedOut = Boolean(
              childExitInfo.aborted ||
                childExitInfo.signal ||
                childExitInfo.exitCode === 130 ||
                childExitInfo.exitCode === 137 ||
                childExitInfo.exitCode === 143,
            );
            const abortCooldownMs = (state.config?.buildAbortCooldownSec ?? 5) * 1000;
            const maxDrainingMs = (state.config?.maxBuildDrainingSec ?? 30) * 1000;
            const rec = reconcileBuildLease(curBuild, now, {
              clientGroupAlive: keepSpawnedChildGroup,
              abortedOrTimedOut,
              abortCooldownMs,
              maxDrainingMs,
            });
            if (rec.action === "mark_draining" && rec.lease) {
              state.buildLeases[check.buildLease.buildId] = rec.lease;
              if (Array.isArray(auditEvents)) {
                auditEvents.push({
                  event: "build_draining",
                  sessionId: check.sessionId,
                  buildId: check.buildLease.buildId,
                  workspaceRoot: check.buildLease.workspaceRoot,
                  resourceKeys: check.buildLease.resourceKeys,
                  exitCode: childExitInfo.exitCode,
                  signal: childExitInfo.signal,
                  drainingCooldownUntilMs: rec.lease.drainingCooldownUntilMs,
                  drainingDeadlineMs: rec.lease.drainingDeadlineMs,
                });
              }
            } else {
              delete state.buildLeases[check.buildLease.buildId];
              if (Array.isArray(auditEvents)) {
                auditEvents.push({
                  event: "build_release",
                  sessionId: check.sessionId,
                  buildId: check.buildLease.buildId,
                  workspaceRoot: check.buildLease.workspaceRoot,
                  resourceKeys: check.buildLease.resourceKeys,
                  durationMs: Math.max(0, now - (check.buildLease.createdAtMs || now)),
                  exitCode: childExitInfo.exitCode,
                });
              }
            }
            return { mutated: true };
          },
          options,
        );
      }
      if (check.lease) {
        if (check.coAllocatedDevice) {
          withStateTransaction(
            stateDir,
            (state, { auditEvents }) => {
              const { key, lease: cur } = findLeaseEntry(
                state,
                check.lease.deviceKey,
                check.lease.leaseId,
              );
              if (!cur || cur.leaseId !== check.lease.leaseId) {
                return { mutated: false };
              }
              if (spawnedChildPid) {
                removeLeaseWorker(cur, spawnedChildPid, options.livenessCheck || isPidAlive);
              }
              removeLeaseWorker(cur, process.pid, options.livenessCheck || isPidAlive);
              if (keepSpawnedChildGroup) {
                cur.releaseOnWorkerExit = true;
                syncLeaseWorkers(cur, options.livenessCheck || isPidAlive);
                return { mutated: true };
              }
              delete state.leases[key];
              if (Array.isArray(auditEvents)) {
                auditEvents.push({
                  event: "device_free",
                  sessionId: check.sessionId,
                  leaseId: cur.leaseId,
                  deviceKey: key,
                  platform: cur.platform,
                  kind: cur.kind,
                  serial: cur.serial,
                  reason: "exec_claim_exit",
                });
              }
              return { mutated: true };
            },
            options,
          );
        } else {
          finishLeaseWorker(
            stateDir,
            check.lease.deviceKey,
            check.lease.leaseId,
            check.ttlMs,
            options,
            (cur) => {
              if (spawnedChildPid) {
                if (keepSpawnedChildGroup && !check.buildLease) {
                  syncLeaseWorkers(cur, options.livenessCheck || isPidAlive);
                } else {
                  removeLeaseWorker(cur, spawnedChildPid, options.livenessCheck || isPidAlive);
                }
              }
            },
          );
        }
      }
    } catch {
      // Best-effort workerPid cleanup
    }
  }
}

function recordForcedRun(stateDir, entry, options = {}) {
  const runId = `forced-${Date.now().toString(36)}-${String(randomNonce()).slice(0, 6)}`;
  try {
    withStateTransaction(
      stateDir,
      (state, { now, auditEvents }) => {
        const identity = resolveSessionIdentity({
          flags: options.flags || {},
          env: options.env || process.env,
          state,
          cwd: entry.cwd,
          ppid: options.ppid ?? process.ppid,
        });
        const rec = { runId, atMs: now, sessionId: identity.sessionId, ...entry };
        state.forcedRuns = [...(state.forcedRuns || []), rec].slice(-50);
        if (Array.isArray(auditEvents)) auditEvents.push({ event: "forced_run", ...rec });
        return { mutated: true };
      },
      options,
    );
  } catch {
    // Best-effort audit; the run itself is still attributed in the result payload
  }
  return runId;
}

export function execDeps(stateDir, options = {}) {
  return {
    runOpInvocations,
    cmdSnapshot,
    readConfig: () => {
      try {
        return readState(stateDir).config || DEFAULT_CONFIG;
      } catch {
        return DEFAULT_CONFIG;
      }
    },
    recordForcedRun: (entry) => recordForcedRun(stateDir, entry, options),
  };
}

// `atc exec <system> <op> ...` (tokens = raw argv after "exec").
export async function cmdExec(stateDir, tokens, options = {}) {
  return cmdExecTokens(stateDir, tokens || [], execDeps(stateDir, options), options);
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

  let statusPlatform = "android";
  const hasExplicitPlatformHints = Boolean(
    flags.ios ||
      flags.android ||
      flags.platform ||
      flags.udid ||
      flags.os ||
      (flags.api && /^[A-Za-z]/.test(String(flags.api))),
  );
  if (hasExplicitPlatformHints) {
    if (
      (parseBoolFlag(flags.ios) && parseBoolFlag(flags.android)) ||
      String(flags.platform || "").toLowerCase() === "all" ||
      String(flags.platform || "").toLowerCase() === "any"
    ) {
      statusPlatform = "all";
    } else {
      try {
        statusPlatform = resolveTargetPlatform(flags, options.cwd || process.cwd());
      } catch (err) {
        return { exitCode: 1, error: err.message };
      }
    }
  } else if (
    !options.inventory &&
    !options.runner &&
    (options.platform || process.platform) === "darwin"
  ) {
    statusPlatform = "all";
  }

  const rawInventory =
    options.inventory ||
    discoverTargetFleet({
      targetPlatform: statusPlatform,
      stateDir,
      runner,
      avdHome,
      cfg,
      platform: options.platform,
      livenessCheck: options.livenessCheck,
      env: options.env || process.env,
    });
  const inventory = options.inventory
    ? rawInventory
    : {
        ...rawInventory,
        discoveredAtMs: rawInventory.discoveredAtMs ?? discoveryStartedAtMs,
        fleetEpoch: rawInventory.fleetEpoch ?? inventoryEpoch,
      };
  const req = {
    platform: statusPlatform === "all" ? "any" : statusPlatform,
    kind: flags.kind || "any",
    udid: flags.udid || null,
    deviceType: flags.type ? normalizeDeviceType(flags.type) : null,
    apiSpec: flags.api ? String(flags.api) : null,
    osSpec: flags.os ? String(flags.os) : null,
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
      const effectiveMaxSimulators = computeEffectiveMaxSimulators(state.config, inventory.host);
      const usedSimulatorSlots = computeUsedSimulatorSlots(state, inventory);
      const buildCapacity = computeBuildPoolSnapshot(state, inventory.host, now);
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
            usedSimulatorSlots,
            effectiveMaxSimulators,
            usedBuildSlots: buildCapacity.usedBuildSlots,
            effectiveMaxBuilds: buildCapacity.effectiveMaxBuilds,
            burstBuildSlots: buildCapacity.burstSlots,
            totalBuildCapacity: buildCapacity.totalCapacity,
            minFreeRamMb: state.config.minFreeRamMb,
            minFreeDiskMb: state.config.minFreeDiskMb,
          },
          buildCapacity: {
            activeHeavyBuilds: buildCapacity.activeHeavyBuilds,
            activeTotalBuilds: buildCapacity.activeTotalBuilds,
            usedBuildSlots: buildCapacity.usedBuildSlots,
            effectiveMaxBuilds: buildCapacity.effectiveMaxBuilds,
            burstBuilds: buildCapacity.burstBuilds,
            totalCapacity: buildCapacity.totalCapacity,
            activeWorkspaces: Array.from(buildCapacity.activeWorkspaces),
          },
          fleet: {
            running,
            offline,
            creatable,
          },
          leases: state.leases,
          queue: state.queue,
          buildLeases: state.buildLeases,
          buildQueue: state.buildQueue,
          logPath: resolveAuditLogPath(stateDir, options.env || process.env),
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
      if (
        key === "maxRunningEmulators" ||
        key === "maxRunningSimulators" ||
        key === "maxConcurrentBuilds"
      ) {
        if (val === "auto") {
          parsedVal = "auto";
        } else if (/^\d+$/.test(String(val)) && Number(val) >= 1) {
          parsedVal = Number(val);
        } else {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `${key} must be "auto" or an integer >= 1.`,
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
      } else if (key === "allowPhysicalDevices") {
        const norm = String(val).trim().toLowerCase();
        if (norm === "explicit" || norm === "never" || norm === "always") {
          parsedVal = norm;
        } else if (norm === "false" || norm === "0") {
          parsedVal = "never";
        } else if (norm === "true" || norm === "1") {
          parsedVal = "explicit";
        } else {
          return {
            mutated: false,
            value: {
              exitCode: 1,
              error: `Config key "allowPhysicalDevices" must be "explicit", "never", or "always".`,
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
  let confirmedKillTargets = [];
  try {
    const preLiveness = options.livenessCheck || isPidAlive;
    const preState = readState(stateDir, { quarantine: false });
    const now = options.now ?? Date.now();
    const cfg = preState.config || DEFAULT_CONFIG;
    const maxTtlMs = (cfg.maxTtlSec || 3600) * 1000;
    const candidates = [];
    for (const [deviceKey, lease] of Object.entries(preState.leases || {})) {
      if (!lease || typeof lease !== "object") continue;
      if (!Array.isArray(lease.workerPgids) || lease.workerPgids.length === 0) continue;
      const pgidSet = new Set(
        lease.workerPgids.map((p) => Number(String(p).split("@")[0])),
      );
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
      if (!isExpired && !isDeadAnchor && !lease.releaseOnWorkerExit) continue;
      const hasLiveLeaderPid = (lease.workerPgids || []).some((p) =>
        isWorkerGroupLeaderAlive(p, lease, preLiveness, options),
      );
      if (hasLiveLeaderPid) continue;
      candidates.push({
        deviceKey,
        leaseId: lease.leaseId,
        expectedPgids: new Set(lease.workerPgids.map((p) => String(p).trim())),
      });
    }
    if (candidates.length > 0) {
      confirmedKillTargets = withLock(
        stateDir,
        (lockHandle) => {
          const lockedNow = options.now ?? Date.now();
          const lockedState = readState(stateDir, { lockHandle });
          const lockedCfg = lockedState.config || DEFAULT_CONFIG;
          const lockedMaxTtlMs = (lockedCfg.maxTtlSec || 3600) * 1000;
          const targets = [];
          let mutated = false;
          for (const cand of candidates) {
            const cur = lockedState.leases?.[cand.deviceKey];
            if (!cur || typeof cur !== "object" || cur.leaseId !== cand.leaseId) continue;
            if (!Array.isArray(cur.workerPgids) || cur.workerPgids.length === 0) continue;
            const hasNewPgid = cur.workerPgids.some(
              (p) => !cand.expectedPgids.has(String(p).trim()),
            );
            if (hasNewPgid) continue;
            const curPgidSet = new Set(
              cur.workerPgids.map((p) => Number(String(p).split("@")[0])),
            );
            const curLiveWrapper = (cur.workerPids || []).some((p) => {
              const num = Number(p);
              return !curPgidSet.has(num) && preLiveness(num);
            });
            if (curLiveWrapper) continue;
            const curLastRenewedMs =
              typeof cur.renewedAtMs === "number" ? cur.renewedAtMs : cur.claimedAtMs;
            const curExpired =
              lockedNow >= cur.expiresAtMs ||
              lockedNow < cur.claimedAtMs ||
              (typeof curLastRenewedMs === "number" &&
                lockedNow > curLastRenewedMs + lockedMaxTtlMs);
            const curDeadAnchor =
              cur.anchorPid !== null &&
              cur.anchorPid !== undefined &&
              !preLiveness(cur.anchorPid);
            if (!curExpired && !curDeadAnchor && !cur.releaseOnWorkerExit) continue;
            cur.gcReapingAtMs = lockedNow;
            targets.push(structuredClone(cur));
            mutated = true;
          }
          if (mutated) {
            commitState(stateDir, lockedState, lockHandle);
          }
          return targets;
        },
        options.lockTimeoutMs,
        "atc.lock",
        undefined,
        options,
      );
      for (const targetLease of confirmedKillTargets) {
        const expectedTargetPgids = new Set(
          (targetLease.workerPgids || []).map((p) => String(p).trim()),
        );
        const killedRes = killProcessGroupTree(targetLease, "SIGKILL", {
          spawnSyncFn: options.spawnSyncFn || options.runner,
          platform: options.platform,
          livenessCheck: preLiveness,
          killFn: options.killFn,
          beforeKill: () =>
            withLock(
              stateDir,
              (lockHandle) => {
                const lockedNow = options.now ?? Date.now();
                const lockedState = readState(stateDir, { lockHandle });
                const lockedCfg = lockedState.config || DEFAULT_CONFIG;
                const lockedMaxTtlMs = (lockedCfg.maxTtlSec || 3600) * 1000;
                const cur = lockedState.leases?.[targetLease.deviceKey];
                if (
                  !cur ||
                  typeof cur !== "object" ||
                  cur.leaseId !== targetLease.leaseId ||
                  cur.gcReapingAtMs !== targetLease.gcReapingAtMs
                ) {
                  return false;
                }
                if (!Array.isArray(cur.workerPgids) || cur.workerPgids.length === 0) {
                  return false;
                }
                const hasNewPgid = cur.workerPgids.some(
                  (p) => !expectedTargetPgids.has(String(p).trim()),
                );
                if (hasNewPgid) return false;
                const curPgidSet = new Set(
                  cur.workerPgids.map((p) => Number(String(p).split("@")[0])),
                );
                const curLiveWrapper = (cur.workerPids || []).some((p) => {
                  const num = Number(p);
                  return !curPgidSet.has(num) && preLiveness(num);
                });
                if (curLiveWrapper) return false;
                const curLastRenewedMs =
                  typeof cur.renewedAtMs === "number" ? cur.renewedAtMs : cur.claimedAtMs;
                const curExpired =
                  lockedNow >= cur.expiresAtMs ||
                  lockedNow < cur.claimedAtMs ||
                  (typeof curLastRenewedMs === "number" &&
                    lockedNow > curLastRenewedMs + lockedMaxTtlMs);
                const curDeadAnchor =
                  cur.anchorPid !== null &&
                  cur.anchorPid !== undefined &&
                  !preLiveness(cur.anchorPid);
                if (!curExpired && !curDeadAnchor && !cur.releaseOnWorkerExit) {
                  return false;
                }
                if (cur.gcKillCommittedAtMs !== lockedNow) {
                  cur.gcKillCommittedAtMs = lockedNow;
                  commitState(stateDir, lockedState, lockHandle);
                }
                return true;
              },
              options.lockTimeoutMs,
              "atc.lock",
              undefined,
              options,
            ),
        });
        if (Array.isArray(killedRes?.terminatedPgids)) {
          terminatedPgids.push(...killedRes.terminatedPgids);
        }
      }
    }
  } catch {
    // Best-effort pre-lock orphan tree termination
  }
  return withStateTransaction(
    stateDir,
    (state, { now, pruned }) => {
      for (const lease of Object.values(state.leases || {})) {
        if (lease && typeof lease === "object") {
          const matchedOwnTarget = confirmedKillTargets.some(
            (t) =>
              t.leaseId === lease.leaseId && t.gcReapingAtMs === lease.gcReapingAtMs,
          );
          if ("gcReapingAtMs" in lease) {
            const ageMs = now - Number(lease.gcReapingAtMs);
            if (matchedOwnTarget || !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= 30_000) {
              delete lease.gcReapingAtMs;
            }
          }
          if ("gcKillCommittedAtMs" in lease) {
            const ageMs = now - Number(lease.gcKillCommittedAtMs);
            if (matchedOwnTarget || !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= 30_000) {
              delete lease.gcKillCommittedAtMs;
            }
          }
        }
      }
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
  let probedAndroidRunning = 0;
  let probedIosRunning = 0;
  let hasPerPlatformProbe = false;

  if (!inventory && options.runningCount === undefined) {
    const unscopedSegments = splitShellSegments(commandStr)
      .map((seg) =>
        classifySegment(seg, {}, 0, {
          cwd: options.cwd || process.cwd(),
          env: options.env || process.env,
        }),
      )
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

  const evalRes = withStateTransaction(stateDir, (state, { now, auditEvents }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
      ancestorPids: options.ancestorPids,
      processChain: options.processChain,
    });
    const allLeases = Object.values(state.leases);
    const activeLeases = allLeases.filter(
      (l) => l.state === "active" && l.sessionId === identity.sessionId,
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
    const guard = evaluateCommandGuard(commandStr, {
      sessionId: identity.sessionId,
      anchorPid: identity.anchorPid,
      activeLeases,
      runningCount,
      runningCountByPlatform,
      platform: options.platform,
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      coordinateBuilds:
        options.coordinateBuilds !== undefined
          ? Boolean(options.coordinateBuilds)
          : Boolean(state.config?.coordinateBuilds),
    });
    if (!guard.allowed) {
      if (Array.isArray(auditEvents)) {
        auditEvents.push({
          event: "guard_deny",
          sessionId: identity.sessionId,
          command: commandStr,
          reason: guard.reason,
        });
      }
    } else if (guard.rewrittenCommand) {
      if (Array.isArray(auditEvents)) {
        auditEvents.push({
          event: "guard_rewrite",
          sessionId: identity.sessionId,
          command: commandStr,
          rewrittenCommand: guard.rewrittenCommand,
        });
      }
    }
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
        if (
          !targeted ||
          targeted.has(lease.serial) ||
          (lease.udid && targeted.has(lease.udid)) ||
          (lease.coreDeviceId && targeted.has(lease.coreDeviceId))
        ) {
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

export async function cmdBatch(stateDir, rawSpecInput, flags = {}, options = {}) {
  const subcmdName = options.subcommand || "batch";
  const unknownFlagErr = validateCommandFlags(flags, BATCH_ALLOWED_FLAGS, subcmdName);
  if (unknownFlagErr) {
    return { exitCode: 1, error: unknownFlagErr };
  }

  if (flags.file !== undefined && flags.file !== null) {
    if (typeof flags.file === "boolean" || !String(flags.file).trim()) {
      return { exitCode: 1, error: 'Option "--file" requires a file path.' };
    }
  }
  if (flags.spec !== undefined && flags.spec !== null) {
    if (typeof flags.spec === "boolean" || (typeof flags.spec === "string" && !flags.spec.trim())) {
      return { exitCode: 1, error: 'Option "--spec" requires a JSON specification.' };
    }
  }
  if (
    flags.file !== undefined &&
    flags.file !== null &&
    flags.spec !== undefined &&
    flags.spec !== null
  ) {
    return { exitCode: 1, error: 'Cannot combine "--file" with "--spec".' };
  }

  let defaultBatchWorkspace = null;
  if (flags.workspace !== undefined && flags.workspace !== null) {
    if (typeof flags.workspace === "boolean" || !String(flags.workspace).trim()) {
      return { exitCode: 1, error: 'Option "--workspace" requires a directory path.' };
    }
    const candWs = path.resolve(options.cwd || process.cwd(), String(flags.workspace).trim());
    try {
      if (!fs.existsSync(candWs) || !fs.statSync(candWs).isDirectory()) {
        return { exitCode: 1, error: `Workspace directory does not exist: ${candWs}` };
      }
      defaultBatchWorkspace = fs.realpathSync(candWs);
    } catch {
      return { exitCode: 1, error: `Workspace directory is not accessible: ${candWs}` };
    }
  }
  const rawBatchWait = flags.wait ?? flags.waitSec;
  let defaultBatchWait = undefined;
  if (rawBatchWait !== undefined && rawBatchWait !== null) {
    const parsedWait =
      typeof rawBatchWait === "boolean" || (typeof rawBatchWait === "string" && !rawBatchWait.trim())
        ? Number.NaN
        : Number(rawBatchWait);
    if (!Number.isFinite(parsedWait) || parsedWait < 0) {
      return {
        exitCode: 1,
        error: `Invalid --wait duration "${rawBatchWait}". Expected a non-negative number of seconds.`,
      };
    }
    defaultBatchWait = parsedWait;
  }

  let spec = null;
  let effectiveSpecInput = null;
  if (rawSpecInput !== undefined && rawSpecInput !== null) {
    effectiveSpecInput = rawSpecInput;
  } else if (flags.spec !== undefined && flags.spec !== null) {
    effectiveSpecInput = flags.spec;
  } else if (
    flags.file !== undefined &&
    flags.file !== null &&
    String(flags.file).trim() !== "-"
  ) {
    const fileArg = String(flags.file).trim();
    try {
      effectiveSpecInput = fs.readFileSync(
        path.resolve(options.cwd || process.cwd(), fileArg),
        "utf8",
      );
    } catch (err) {
      return {
        exitCode: 1,
        error: `Failed to read batch file "${fileArg}": ${err.message}`,
      };
    }
  } else {
    const readStdin =
      typeof options.readStdinFn === "function" ? options.readStdinFn : readStdinSync;
    effectiveSpecInput = readStdin();
  }
  if (
    effectiveSpecInput &&
    typeof effectiveSpecInput === "object" &&
    !Array.isArray(effectiveSpecInput)
  ) {
    spec = effectiveSpecInput;
  } else {
    const rawStr = typeof effectiveSpecInput === "string" ? effectiveSpecInput.trim() : "";
    if (!rawStr) {
      return {
        exitCode: 1,
        error: 'Usage: atc batch [--file <path.json>|--spec <json>] [--json] (or pass JSON spec via stdin)',
      };
    }
    try {
      spec = JSON.parse(rawStr);
    } catch (err) {
      return {
        exitCode: 1,
        error: `Invalid JSON batch specification: ${err.message}`,
      };
    }
  }

  if (!spec || typeof spec !== "object" || !Array.isArray(spec.steps) || spec.steps.length === 0) {
    return {
      exitCode: 1,
      error: 'Batch specification must contain a non-empty "steps" array.',
    };
  }

  const baseCwd = options.cwd || process.cwd();
  const baseEnv = options.env || process.env;
  const stepsById = new Map();
  const preparedSteps = [];

  for (let i = 0; i < spec.steps.length; i++) {
    const rawStep = spec.steps[i];
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      return { exitCode: 1, error: `Batch step at index ${i} must be an object.` };
    }
    const id = typeof rawStep.id === "string" ? rawStep.id.trim() : "";
    if (!id) {
      return {
        exitCode: 1,
        error: `Batch step at index ${i} is missing a non-empty string "id".`,
      };
    }
    if (stepsById.has(id)) {
      return {
        exitCode: 1,
        error: `Duplicate step id "${id}" in batch specification.`,
      };
    }
    const command = typeof rawStep.command === "string" ? rawStep.command.trim() : "";
    if (!command || command.includes("\0")) {
      return {
        exitCode: 1,
        error: `Batch step "${id}" has an empty or invalid "command".`,
      };
    }
    let stepArgs = [];
    if (rawStep.args !== undefined && rawStep.args !== null) {
      if (!Array.isArray(rawStep.args)) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "args" must be an array of strings.`,
        };
      }
      stepArgs = rawStep.args.map((a) => String(a));
      if (stepArgs.some((a) => a.includes("\0"))) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "args" entries must not contain NUL bytes.`,
        };
      }
    }

    let dependsOn = [];
    if (rawStep.dependsOn !== undefined && rawStep.dependsOn !== null) {
      if (!Array.isArray(rawStep.dependsOn)) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "dependsOn" must be an array of step IDs.`,
        };
      }
      for (const dep of rawStep.dependsOn) {
        const depId = typeof dep === "string" ? dep.trim() : "";
        if (!depId) {
          return {
            exitCode: 1,
            error: `Batch step "${id}": "dependsOn" entries must be non-empty strings.`,
          };
        }
        if (depId === id) {
          return {
            exitCode: 1,
            error: `Batch step "${id}" cannot depend on itself.`,
          };
        }
        if (!dependsOn.includes(depId)) {
          dependsOn.push(depId);
        }
      }
    }

    let stepCwd = baseCwd;
    if (rawStep.cwd !== undefined && rawStep.cwd !== null) {
      if (typeof rawStep.cwd !== "string" || !rawStep.cwd.trim()) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "cwd" must be a non-empty directory path.`,
        };
      }
      const candCwd = path.resolve(baseCwd, rawStep.cwd.trim());
      try {
        if (!fs.existsSync(candCwd) || !fs.statSync(candCwd).isDirectory()) {
          return {
            exitCode: 1,
            error: `Batch step "${id}": cwd directory does not exist: ${candCwd}`,
          };
        }
        stepCwd = fs.realpathSync(candCwd);
      } catch {
        return {
          exitCode: 1,
          error: `Batch step "${id}": cwd directory is not accessible: ${candCwd}`,
        };
      }
    }

    let stepWorkspace = defaultBatchWorkspace;
    if (rawStep.workspace !== undefined && rawStep.workspace !== null) {
      if (typeof rawStep.workspace !== "string" || !rawStep.workspace.trim()) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "workspace" must be a non-empty directory path.`,
        };
      }
      const candWs = path.resolve(stepCwd, rawStep.workspace.trim());
      try {
        if (!fs.existsSync(candWs) || !fs.statSync(candWs).isDirectory()) {
          return {
            exitCode: 1,
            error: `Batch step "${id}": workspace directory does not exist: ${candWs}`,
          };
        }
        stepWorkspace = fs.realpathSync(candWs);
      } catch {
        return {
          exitCode: 1,
          error: `Batch step "${id}": workspace directory is not accessible: ${candWs}`,
        };
      }
    }

    let stepPhase = null;
    if (rawStep.phase !== undefined && rawStep.phase !== null) {
      const p = typeof rawStep.phase === "string" ? rawStep.phase.trim().toLowerCase() : "";
      if (!VALID_EXEC_PHASES.has(p)) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": invalid phase "${rawStep.phase}". Expected one of: pure-build, device-build, device-test, read-only.`,
        };
      }
      stepPhase = p;
    }

    const rawStepRam = rawStep.ramMb ?? rawStep["ram-mb"];
    let stepRamMb = undefined;
    if (rawStepRam !== undefined && rawStepRam !== null) {
      const parsedRam =
        typeof rawStepRam === "boolean" || (typeof rawStepRam === "string" && !rawStepRam.trim())
          ? Number.NaN
          : Number(rawStepRam);
      if (!Number.isInteger(parsedRam) || parsedRam < 1 || parsedRam > 1_048_576) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": invalid ramMb "${rawStepRam}". Expected an integer between 1 and 1048576.`,
        };
      }
      stepRamMb = parsedRam;
    }

    const rawStepWait = rawStep.wait ?? rawStep.waitSec;
    let stepWait = defaultBatchWait;
    if (rawStepWait !== undefined && rawStepWait !== null) {
      const parsedWait =
        typeof rawStepWait === "boolean" || (typeof rawStepWait === "string" && !rawStepWait.trim())
          ? Number.NaN
          : Number(rawStepWait);
      if (!Number.isFinite(parsedWait) || parsedWait < 0) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": invalid wait "${rawStepWait}". Expected a non-negative number of seconds.`,
        };
      }
      stepWait = parsedWait;
    }

    let stepEnv = { ...baseEnv };
    if (rawStep.env !== undefined && rawStep.env !== null) {
      if (typeof rawStep.env !== "object" || Array.isArray(rawStep.env)) {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "env" must be an object of key-value pairs.`,
        };
      }
      for (const [k, v] of Object.entries(rawStep.env)) {
        if (!k || k.includes("\0") || k.includes("=")) {
          return {
            exitCode: 1,
            error: `Batch step "${id}": invalid environment variable name ${JSON.stringify(k)}.`,
          };
        }
        if (v === undefined || v === null) {
          delete stepEnv[k];
        } else {
          const strVal = String(v);
          if (strVal.includes("\0")) {
            return {
              exitCode: 1,
              error: `Batch step "${id}": environment variable "${k}" must not contain NUL bytes.`,
            };
          }
          stepEnv[k] = strVal;
        }
      }
    }

    const stepFlags = {};
    if (flags.session !== undefined) stepFlags.session = flags.session;
    if (flags.role !== undefined) stepFlags.role = flags.role;
    if (flags.anchorPid !== undefined) stepFlags.anchorPid = flags.anchorPid;
    if (stepPhase) stepFlags.phase = stepPhase;
    if (stepWorkspace) stepFlags.workspace = stepWorkspace;
    if (stepRamMb !== undefined) stepFlags.ramMb = stepRamMb;
    if (stepWait !== undefined) stepFlags.wait = stepWait;
    if (rawStep.build !== undefined) stepFlags.build = parseBoolFlag(rawStep.build);
    if (rawStep.serial !== undefined) stepFlags.serial = String(rawStep.serial);
    if (rawStep.udid !== undefined) stepFlags.udid = String(rawStep.udid);

    if (rawStep.claim !== undefined && rawStep.claim !== null && rawStep.claim !== false) {
      if (rawStep.claim === true) {
        stepFlags.claim = true;
      } else if (typeof rawStep.claim === "string") {
        const parsedSel = parseCliArgs(["exec", ...tokenizeClaimSelectorString(rawStep.claim)]);
        if (parsedSel.positionals.length > 0) {
          return {
            exitCode: 1,
            error: `Batch step "${id}": unexpected argument "${parsedSel.positionals[0]}" in claim selector.`,
          };
        }
        Object.assign(stepFlags, parsedSel.flags);
        stepFlags.claim = true;
      } else if (typeof rawStep.claim === "object" && !Array.isArray(rawStep.claim)) {
        const claimErr = validateCommandFlags(rawStep.claim, CLAIM_ALLOWED_FLAGS, "claim");
        if (claimErr) {
          return {
            exitCode: 1,
            error: `Batch step "${id}": ${claimErr}`,
          };
        }
        Object.assign(stepFlags, rawStep.claim);
        stepFlags.claim = true;
      } else {
        return {
          exitCode: 1,
          error: `Batch step "${id}": "claim" must be a boolean, selector string, or claim options object.`,
        };
      }
    }

    const execFlagErr = validateCommandFlags(stepFlags, EXEC_ALLOWED_FLAGS, "exec");
    if (execFlagErr) {
      return { exitCode: 1, error: `Batch step "${id}": ${execFlagErr}` };
    }

    try {
      resolveExplicitPlatformFilter(stepFlags);
      if (parseBoolFlag(stepFlags.claim)) {
        resolveTargetPlatform(stepFlags, stepCwd);
      }
    } catch (err) {
      return { exitCode: 1, error: `Batch step "${id}": ${err.message}` };
    }

    const isStepBuild =
      parseBoolFlag(stepFlags.build) ||
      stepPhase === "pure-build" ||
      stepPhase === "device-build";
    const isStepClaim = parseBoolFlag(stepFlags.claim);
    const stepSelectorSerial = stepFlags.serial || stepFlags.udid || null;

    const preflightBuildReqs = resolveBuildResources(command, stepArgs, stepCwd, {
      forceBuild: isStepBuild,
      env: stepEnv,
      workspace: stepWorkspace,
    });
    if (preflightBuildReqs.kind === "deny_lifecycle") {
      return {
        exitCode: 3,
        error: `Batch pre-flight failed on step "${id}": ${preflightBuildReqs.reason}`,
      };
    }
    if (preflightBuildReqs.kind === "reject_long_running") {
      return {
        exitCode: 3,
        error: `Batch pre-flight failed on step "${id}": ${preflightBuildReqs.reason}`,
      };
    }
    const rawStepCmdStr = [command, ...stepArgs]
      .map((a) => (/[\s"'\\]/.test(String(a)) ? JSON.stringify(String(a)) : String(a)))
      .join(" ");
    const preflightDevClass = classifySegment(rawStepCmdStr, {}, 0, {
      cwd: stepCwd,
      env: stepEnv,
    });
    if (preflightDevClass.kind === "deny_lifecycle") {
      return {
        exitCode: 3,
        error: `Batch pre-flight failed on step "${id}": ${preflightDevClass.reason}`,
      };
    }
    if (preflightDevClass.buildClass === "reject_long_running") {
      return {
        exitCode: 3,
        error: `Batch pre-flight failed on step "${id}": ${preflightDevClass.rejectReason || "Continuous/watch build commands cannot be coordinated by atc batch because they hold build slots indefinitely."}`,
      };
    }
    if (stepPhase) {
      if (
        (stepPhase === "pure-build" || stepPhase === "read-only") &&
        (isStepClaim || Boolean(stepSelectorSerial))
      ) {
        return {
          exitCode: 3,
          error: `Batch pre-flight failed on step "${id}": Conflicting flags: --phase=${stepPhase} cannot be combined with --claim or --serial/--udid.`,
        };
      }
      if (stepPhase === "read-only") {
        if (
          preflightBuildReqs.requiresHeavySlot ||
          preflightBuildReqs.requiresWorkspaceLock ||
          preflightBuildReqs.requiresDevice ||
          preflightDevClass.kind === "device_action" ||
          (preflightDevClass.isBuildTool &&
            preflightDevClass.buildClass &&
            preflightDevClass.buildClass !== "read_only")
        ) {
          const conflictKind =
            preflightBuildReqs.kind && preflightBuildReqs.kind !== "not_build_tool"
              ? preflightBuildReqs.kind
              : preflightDevClass.buildClass || preflightDevClass.kind;
          return {
            exitCode: 3,
            error: `Batch pre-flight failed on step "${id}": Phase conflict: command requires build/workspace/device locks (${conflictKind}), which violates --phase=read-only.`,
          };
        }
      } else if (stepPhase === "pure-build") {
        if (preflightBuildReqs.requiresDevice || preflightDevClass.kind === "device_action") {
          return {
            exitCode: 3,
            error: `Batch pre-flight failed on step "${id}": Phase conflict: command interacts with a device (${preflightBuildReqs.kind}), which violates --phase=pure-build.`,
          };
        }
      } else if (stepPhase === "device-test") {
        if (
          (preflightBuildReqs.requiresHeavySlot && !preflightBuildReqs.requiresDevice) ||
          (preflightDevClass.isBuildTool && preflightDevClass.buildClass === "pure_build")
        ) {
          const conflictKind =
            preflightBuildReqs.kind && preflightBuildReqs.kind !== "not_build_tool"
              ? preflightBuildReqs.kind
              : preflightDevClass.buildClass;
          return {
            exitCode: 3,
            error: `Batch pre-flight failed on step "${id}": Phase conflict: command is a pure compilation (${conflictKind}) that does not target a device, which violates --phase=device-test.`,
          };
        }
      }
    }

    const stepObj = {
      id,
      index: i,
      command,
      args: stepArgs,
      dependsOn,
      phase: stepPhase,
      cwd: stepCwd,
      workspace: stepWorkspace,
      env: stepEnv,
      flags: stepFlags,
    };
    stepsById.set(id, stepObj);
    preparedSteps.push(stepObj);
  }

  // Validate dependency references and perform Kahn's topological sort
  const inDegree = new Map();
  const dependents = new Map();
  for (const s of preparedSteps) {
    inDegree.set(s.id, 0);
    dependents.set(s.id, []);
  }
  for (const s of preparedSteps) {
    for (const depId of s.dependsOn) {
      if (!stepsById.has(depId)) {
        return {
          exitCode: 1,
          error: `Batch step "${s.id}" depends on unknown step "${depId}".`,
        };
      }
      inDegree.set(s.id, (inDegree.get(s.id) || 0) + 1);
      dependents.get(depId).push(s.id);
    }
  }

  const readyQueue = preparedSteps.filter((s) => inDegree.get(s.id) === 0).map((s) => s.id);
  const topoOrder = [];
  while (readyQueue.length > 0) {
    const curId = readyQueue.shift();
    topoOrder.push(stepsById.get(curId));
    for (const nextId of dependents.get(curId) || []) {
      const nextDeg = (inDegree.get(nextId) || 0) - 1;
      inDegree.set(nextId, nextDeg);
      if (nextDeg === 0) {
        readyQueue.push(nextId);
      }
    }
  }

  if (topoOrder.length !== preparedSteps.length) {
    const cycleIds = preparedSteps
      .filter((s) => (inDegree.get(s.id) || 0) > 0)
      .map((s) => s.id);
    return {
      exitCode: 1,
      error: `Dependency cycle detected in batch specification involving step(s): ${cycleIds.join(", ")}.`,
    };
  }

  const batchId = `batch_${randomNonce().slice(0, 12)}`;
  const batchStartMs = Date.now();
  let sessionId = null;
  withStateTransaction(
    stateDir,
    (state, { auditEvents }) => {
      const identity = resolveSessionIdentity({
        flags,
        env: baseEnv,
        state,
        cwd: baseCwd,
        ppid: options.ppid ?? process.ppid,
        ancestorPids: options.ancestorPids,
        processChain: options.processChain,
      });
      sessionId = identity.sessionId;
      if (Array.isArray(auditEvents)) {
        auditEvents.push({
          event: "batch_start",
          sessionId: identity.sessionId,
          batchId,
          stepCount: topoOrder.length,
          stepOrder: topoOrder.map((s) => s.id),
        });
      }
      return { mutated: false };
    },
    options,
  );

  const stepResults = [];
  const jsonOutputMode = parseBoolFlag(flags.json);

  for (const step of topoOrder) {
    const stepStartMs = Date.now();
    let execRes;
    try {
      execRes = await cmdExec(
        stateDir,
        [step.command, ...step.args],
        step.flags,
        {
          ...options,
          cwd: step.cwd,
          env: step.env,
          ...(jsonOutputMode && !options.stdio
            ? {
                stdio: ["ignore", "pipe", "pipe"],
                redirectStdoutToStderr: true,
              }
            : {}),
        },
      );
    } catch (err) {
      execRes = {
        exitCode: 1,
        error: err && err.message ? err.message : String(err),
      };
    }
    const durationMs = Math.max(0, Date.now() - stepStartMs);
    const exitCode = typeof execRes?.exitCode === "number" ? execRes.exitCode : 1;
    const stepRecord = {
      id: step.id,
      phase: step.phase,
      exitCode,
      durationMs,
      ...(execRes?.error ? { error: execRes.error } : {}),
    };
    stepResults.push(stepRecord);

    withStateTransaction(
      stateDir,
      (state, { auditEvents }) => {
        if (Array.isArray(auditEvents)) {
          auditEvents.push({
            event: exitCode === 0 ? "batch_step_done" : "batch_step_failed",
            sessionId,
            batchId,
            stepId: step.id,
            phase: step.phase,
            exitCode,
            durationMs,
            ...(execRes?.error ? { error: execRes.error } : {}),
          });
        }
        return { mutated: false };
      },
      options,
    );

    if (exitCode !== 0) {
      const totalDurationMs = Math.max(0, Date.now() - batchStartMs);
      withStateTransaction(
        stateDir,
        (state, { auditEvents }) => {
          if (Array.isArray(auditEvents)) {
            auditEvents.push({
              event: "batch_complete",
              sessionId,
              batchId,
              status: "failed",
              failedStepId: step.id,
              exitCode,
              completedSteps: stepResults.length,
              totalSteps: topoOrder.length,
              durationMs: totalDurationMs,
            });
          }
          return { mutated: false };
        },
        options,
      );
      return {
        exitCode,
        batchId,
        status: "failed",
        failedStepId: step.id,
        steps: stepResults,
        durationMs: totalDurationMs,
        error: execRes?.error || `Batch step "${step.id}" failed with exit code ${exitCode}.`,
      };
    }
  }

  const totalDurationMs = Math.max(0, Date.now() - batchStartMs);
  withStateTransaction(
    stateDir,
    (state, { auditEvents }) => {
      if (Array.isArray(auditEvents)) {
        auditEvents.push({
          event: "batch_complete",
          sessionId,
          batchId,
          status: "completed",
          exitCode: 0,
          completedSteps: stepResults.length,
          totalSteps: topoOrder.length,
          durationMs: totalDurationMs,
        });
      }
      return { mutated: false };
    },
    options,
  );

  return {
    exitCode: 0,
    batchId,
    status: "completed",
    steps: stepResults,
    durationMs: totalDurationMs,
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

  if ((parsed.flags.help || parsed.flags.h || parsed.subcommand === "help") && parsed.subcommand !== "exec") {
    const helpTopic =
      parsed.subcommand === "help" ? parsed.positionals[0] : parsed.subcommand;
    if (helpTopic === "guide") {
      process.stdout.write(
        `Usage: atc guide [workflow|profiles|snapshots|multi-agent|traps] [--json]\n\n` +
          `Without a topic, prints the workflow guide. Read it before your first claim.\n\n` +
          `  workflow     claim -> exec -> snapshot -> free loop, rules, and done checklist\n` +
          `  profiles     3-tier fleet discovery, profile flags, and physical device safety\n` +
          `  snapshots    QEMU/APFS snapshots, wipe/cold/reset-app flags, and RAM/disk guardrails\n` +
          `  multi-agent  session identity, warm-affinity queue, hooks, guard, and MCP\n` +
          `  traps        common Android/iOS/multi-agent failure modes and how atc fixes them\n`,
      );
      return 0;
    }
    process.stdout.write(
      `Agent Traffic Control (atc)\n\n` +
        `Usage:\n` +
        `  atc guide [workflow|profiles|snapshots|multi-agent|traps] [--json]\n` +
        `  atc claim [--ios|--android|--platform <p>] [--type <type>] [--api|--os <spec>] [--play|--no-play] [--snapshot-load <name>] [--ttl <sec>] [--wait <sec>]\n` +
        `  atc free [<target>] [--snapshot-save <name>] [--snapshot-load <name>] [--stop]\n` +
        `  atc renew [<target>] [--ttl <sec>]\n` +
        `  atc snapshot <list|save|load|delete> [<name>]\n` +
        `  atc exec [--build] [--claim] [--workspace <dir>] [--phase <phase>] [--ram-mb <mb>] -- <command> [args...]\n` +
        `  atc batch [--file <path.json>] [--json]\n` +
        `  atc status [--ios|--android] [--type <type>] [--api|--os <spec>] [--json]\n` +
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
      if (parsed.flags.json) {
        process.stdout.write(JSON.stringify(res.lease, null, 2) + "\n");
      } else {
        process.stdout.write(`✓ Renewed ${res.lease.leaseId} (${res.lease.serial})\n`);
      }
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
      const execIdx = argv.indexOf("exec");
      const res = await cmdExec(stateDir, argv.slice(execIdx + 1), { env, ...options });
      if (res.help) {
        (res.exitCode === 0 ? process.stdout : process.stderr).write(res.help);
        return res.exitCode;
      }
      renderExecResult(res, { json: res.json });
      return res.exitCode;
    }

    case "batch":
    case "plan": {
      if (
        parsed.positionals.length > 1 ||
        (parsed.positionals.length > 0 && parsed.flags.file !== undefined) ||
        (parsed.positionals.length > 0 && parsed.flags.spec !== undefined)
      ) {
        const extra =
          parsed.positionals.length > 1 ? parsed.positionals[1] : parsed.positionals[0];
        process.stderr.write(
          `[atc] Unexpected argument "${extra}" for "atc ${parsed.subcommand}".\n`,
        );
        return 1;
      }
      const batchFlags =
        parsed.positionals.length > 0
          ? { ...parsed.flags, file: parsed.positionals[0] }
          : parsed.flags;
      const res = await cmdBatch(stateDir, null, batchFlags, {
        env,
        ...options,
        subcommand: parsed.subcommand,
      });
      if (parsed.flags.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else if (res.error) {
        process.stderr.write(`[atc] ${res.error}\n`);
      } else {
        process.stdout.write(
          `✓ Completed batch ${res.batchId} (${res.steps.length} step${res.steps.length === 1 ? "" : "s"} in ${res.durationMs}ms)\n`,
        );
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
          `Host Capacity: ${hc.availableRamMb} MB RAM avail · ${hc.freeDiskMb} MB disk free · emu slots: ${hc.usedSlots}/${hc.effectiveMaxEmulators} · sim slots: ${hc.usedSimulatorSlots ?? 0}/${hc.effectiveMaxSimulators ?? 4} · build slots: ${hc.usedBuildSlots ?? 0}/${hc.effectiveMaxBuilds ?? 1}\n`,
        );
        process.stdout.write(`  Running (${res.fleet.running.length}): ${res.fleet.running.map((d) => `${d.avd || d.serial} (${d.serial})`).join(", ") || "none"}\n`);
        process.stdout.write(`  Offline (${res.fleet.offline.length}): ${res.fleet.offline.map((d) => d.avd || d.udid).join(", ") || "none"}\n`);
        process.stdout.write(`  Leases  (${Object.keys(res.leases).length}): ${Object.keys(res.leases).join(", ") || "none"}\n`);
        process.stdout.write(`  Queue   (${res.queue.length}): ${res.queue.map((q) => q.ticketId).join(", ") || "none"}\n`);
        process.stdout.write(`  Builds  (${Object.keys(res.buildLeases || {}).length}): ${Object.keys(res.buildLeases || {}).join(", ") || "none"}\n`);
        process.stdout.write(`  BQueue  (${(res.buildQueue || []).length}): ${(res.buildQueue || []).map((q) => q.ticketId).join(", ") || "none"}\n`);
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
        const res = handleStopHook(stateDir, rawStdin, { hookType });
        if (res.stderr) process.stderr.write(res.stderr);
        if (res.stdout) process.stdout.write(res.stdout);
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
