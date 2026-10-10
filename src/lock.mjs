import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STALE_LOCK_MS = 10_000;
const MISSING_OWNER_STALE_MS = 2_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export function randomNonce() {
  return crypto.randomBytes(12).toString("hex");
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

let activePgidLivenessSnapshot = null;
const winKnownTreeDescendants = new Map();
const posixKnownPgidStartTokens = new Map();

function normalizeCreationToken(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "object") {
    if (typeof raw.value === "string" && raw.value.trim()) return raw.value.trim();
    if (typeof raw.DateTime === "string" && raw.DateTime.trim()) return raw.DateTime.trim();
    if (typeof raw.Ticks === "number") return String(raw.Ticks);
  }
  return null;
}

function parseWindowsPgidKey(rawPgid) {
  if (typeof rawPgid === "number" && Number.isInteger(rawPgid) && rawPgid > 1) {
    return { key: rawPgid, pid: rawPgid, rootCreation: null };
  }
  const str = String(rawPgid ?? "").trim();
  const atIdx = str.indexOf("@");
  if (atIdx > 0) {
    const pid = Number(str.slice(0, atIdx));
    const rootCreation = str.slice(atIdx + 1).trim() || null;
    if (Number.isInteger(pid) && pid > 1 && rootCreation) {
      return { key: `${pid}@${rootCreation}`, pid, rootCreation };
    }
  }
  const pid = Number(str);
  if (Number.isInteger(pid) && pid > 1) {
    return { key: pid, pid, rootCreation: null };
  }
  return null;
}

export function getPosixProcessStartToken(pid, options = {}) {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 1) return null;
  const platform = options.platform || process.platform;
  if (platform === "win32") return null;
  const expectedToken = normalizeCreationToken(options.expectedToken);
  const preferPs = Boolean(expectedToken && !expectedToken.startsWith("proc:"));
  if (platform === "linux" && !preferPs) {
    try {
      const stat = fs.readFileSync(`/proc/${numPid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen !== -1) {
        const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
        if (fields.length > 19 && fields[19]) {
          return `proc:${fields[19].trim()}`;
        }
      }
    } catch {
      // Fall back to ps below if /proc is unavailable or unreadable
    }
  }
  if (options.allowSubprocess === false) {
    return null;
  }
  const spawnSyncFn = options.spawnSyncFn || options.runner || spawnSync;
  try {
    const res = spawnSyncFn("ps", ["-o", "lstart=", "-p", String(numPid)], {
      encoding: "utf8",
      timeout: 1500,
    });
    if (res && res.status === 0 && typeof res.stdout === "string") {
      const token = res.stdout.trim().replace(/\s+/g, " ");
      if (token.length > 0) {
        return token;
      }
    }
  } catch {
    // Ignore ps failures
  }
  return null;
}

export function seedPosixPgidStartTokens(pgidOrMap, token = undefined) {
  if (pgidOrMap && typeof pgidOrMap === "object" && !(pgidOrMap instanceof Set)) {
    const iterable =
      pgidOrMap instanceof Map ? pgidOrMap.entries() : Object.entries(pgidOrMap);
    for (const [k, v] of iterable) {
      seedPosixPgidStartTokens(k, v);
    }
    return;
  }
  const parsed = parseWindowsPgidKey(pgidOrMap);
  if (!parsed) return;
  const norm = normalizeCreationToken(token ?? parsed.rootCreation);
  if (norm && norm !== "__exited__") {
    posixKnownPgidStartTokens.set(parsed.pid, norm);
  }
}

export function getKnownPosixPgidStartToken(pgid) {
  const parsed = parseWindowsPgidKey(pgid);
  if (!parsed) return null;
  return posixKnownPgidStartTokens.get(parsed.pid) ?? parsed.rootCreation ?? null;
}

export function clearKnownPosixPgidStartTokens(pgid = null) {
  if (pgid === null || pgid === undefined) {
    posixKnownPgidStartTokens.clear();
  } else {
    const parsed = parseWindowsPgidKey(pgid);
    if (parsed) {
      posixKnownPgidStartTokens.delete(parsed.pid);
    }
  }
}

export function resolveExpectedPosixPgidStartToken(rawPgid, options = {}) {
  const parsed = parseWindowsPgidKey(rawPgid);
  if (!parsed) return null;
  const pidStr = String(parsed.pid);
  const direct =
    normalizeCreationToken(options.startToken) ??
    parsed.rootCreation ??
    normalizeCreationToken(
      options.pgidStartTokens?.[pidStr] ??
        options.lease?.workerPgidStartTokens?.[pidStr] ??
        null,
    );
  if (direct && direct !== "__exited__") {
    return direct;
  }
  const descMap = options.knownDescendants ?? options.lease?.workerDescendants ?? null;
  const descEntries = Array.isArray(descMap) ? descMap : descMap?.[pidStr];
  if (Array.isArray(descEntries)) {
    const rootEntry = descEntries.find(
      (item) => item && typeof item === "object" && Number(item.pid ?? item.ProcessId) === parsed.pid,
    );
    const rootToken = rootEntry
      ? normalizeCreationToken(
          rootEntry.startToken ?? rootEntry.creationDate ?? rootEntry.CreationDate ?? null,
        )
      : null;
    if (rootToken && rootToken !== "__exited__") {
      return rootToken;
    }
  }
  return posixKnownPgidStartTokens.get(parsed.pid) ?? null;
}

export function deriveWindowsTreeGenerationToken(pgid, entriesOrMap) {
  const numPgid = Number(pgid);
  if (!Number.isInteger(numPgid) || numPgid <= 1 || !entriesOrMap) {
    return null;
  }
  const list =
    entriesOrMap instanceof Map
      ? Array.from(entriesOrMap.values())
      : entriesOrMap instanceof Set || Array.isArray(entriesOrMap)
        ? Array.from(entriesOrMap)
        : typeof entriesOrMap === "object"
          ? Object.entries(entriesOrMap).map(([k, v]) =>
              v && typeof v === "object"
                ? { pid: Number(k), ...v }
                : { pid: Number(k), creationDate: v },
            )
          : [];
  if (list.length === 0) return null;
  const rootItem = list.find(
    (item) =>
      item && typeof item === "object" && Number(item.pid ?? item.ProcessId) === numPgid,
  );
  const rootCreation = rootItem
    ? normalizeCreationToken(
        rootItem.creationDate ?? rootItem.CreationDate ?? rootItem.startToken ?? null,
      )
    : null;
  if (rootCreation && rootCreation !== "__exited__") {
    return rootCreation;
  }
  const descParts = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const pid = Number(item.pid ?? item.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || pid === numPgid) continue;
    const c = normalizeCreationToken(
      item.creationDate ?? item.CreationDate ?? item.startToken ?? null,
    );
    if (c && c !== "__exited__") {
      descParts.push(`${pid}:${c}`);
    }
  }
  descParts.sort();
  if (descParts.length > 0) {
    return `__exited__:${descParts[0]}`;
  }
  return rootCreation === "__exited__" ? "__exited__" : null;
}

export function archiveWindowsProcessGroupGeneration(rawPgid) {
  const parsed = parseWindowsPgidKey(rawPgid);
  if (!parsed) return null;
  const existing = winKnownTreeDescendants.get(parsed.pid);
  if (!existing) return null;
  const genToken = deriveWindowsTreeGenerationToken(parsed.pid, existing);
  if (genToken) {
    const archiveKey = `${parsed.pid}@${genToken}`;
    winKnownTreeDescendants.set(archiveKey, existing);
    winKnownTreeDescendants.delete(parsed.pid);
    return archiveKey;
  }
  winKnownTreeDescendants.delete(parsed.pid);
  return null;
}

export function seedWindowsKnownDescendants(pgidOrMap, entries) {
  if (pgidOrMap && typeof pgidOrMap === "object" && !(pgidOrMap instanceof Set)) {
    const iterable =
      pgidOrMap instanceof Map ? pgidOrMap.entries() : Object.entries(pgidOrMap);
    for (const [k, v] of iterable) {
      seedWindowsKnownDescendants(k, v);
    }
    return;
  }
  const parsedPgid = parseWindowsPgidKey(pgidOrMap);
  if (!parsedPgid) return;
  const { pid: pgid } = parsedPgid;
  let targetKey = parsedPgid.key;
  if (!entries) return;
  if (
    activePgidLivenessSnapshot &&
    (activePgidLivenessSnapshot.get(targetKey) === false ||
      (targetKey === pgid && activePgidLivenessSnapshot.get(String(pgid)) === false))
  ) {
    return;
  }
  const list =
    entries instanceof Map
      ? Array.from(entries.values())
      : entries instanceof Set || Array.isArray(entries)
        ? Array.from(entries)
        : entries && typeof entries === "object"
          ? Object.entries(entries).map(([k, v]) =>
              v && typeof v === "object" ? { pid: Number(k), ...v } : { pid: Number(k), creationDate: v },
            )
          : [];
  if (targetKey === pgid) {
    const incomingGenToken = deriveWindowsTreeGenerationToken(pgid, list);
    if (incomingGenToken) {
      const incomingArchiveKey = `${pgid}@${incomingGenToken}`;
      if (winKnownTreeDescendants.has(incomingArchiveKey)) {
        targetKey = incomingArchiveKey;
      } else {
        const existingBare = winKnownTreeDescendants.get(pgid);
        const existingGenToken = deriveWindowsTreeGenerationToken(pgid, existingBare);
        if (existingGenToken && incomingGenToken !== existingGenToken) {
          winKnownTreeDescendants.set(`${pgid}@${existingGenToken}`, existingBare);
          winKnownTreeDescendants.delete(pgid);
        }
      }
    }
  }
  let known = winKnownTreeDescendants.get(targetKey);
  if (!known) {
    known = new Map();
    winKnownTreeDescendants.set(targetKey, known);
  }
  for (const item of list) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) {
      if (!known.has(item)) {
        known.set(item, { pid: item, creationDate: null, alive: true });
      }
    } else if (item && typeof item === "object") {
      const pid = Number(item.pid ?? item.ProcessId);
      if (Number.isInteger(pid) && pid > 0) {
        const creationDate = normalizeCreationToken(
          item.creationDate ?? item.CreationDate ?? item.startToken ?? null,
        );
        const prev = known.get(pid);
        const effectiveCreation = creationDate ?? prev?.creationDate ?? null;
        known.set(pid, {
          pid,
          creationDate: effectiveCreation,
          alive:
            item.alive !== undefined
              ? Boolean(item.alive)
              : effectiveCreation === "__exited__"
                ? false
                : (prev?.alive ?? true),
        });
      }
    }
  }
}

export function clearKnownWindowsTreeDescendants(pgid = null) {
  if (pgid === null || pgid === undefined) {
    winKnownTreeDescendants.clear();
  } else {
    const parsed = parseWindowsPgidKey(pgid);
    if (parsed) {
      winKnownTreeDescendants.delete(parsed.key);
    }
  }
}

export function queryWindowsProcessGroups(pgids, spawnSyncFn = spawnSync, options = {}) {
  const result = new Map();
  result.refreshed = false;
  const triState = Boolean(options && options.triState);
  if (options && options.freshGeneration) {
    for (const rawPgid of pgids || []) {
      archiveWindowsProcessGroupGeneration(rawPgid);
    }
  }
  if (options && options.knownDescendants) {
    if (
      Array.isArray(options.knownDescendants) &&
      Array.isArray(pgids) &&
      pgids.length === 1
    ) {
      seedWindowsKnownDescendants(pgids[0], options.knownDescendants);
    } else {
      seedWindowsKnownDescendants(options.knownDescendants);
    }
  }
  for (const rawPgid of pgids || []) {
    const parsedPgid = parseWindowsPgidKey(rawPgid);
    if (parsedPgid) {
      result.set(parsedPgid.key, triState ? null : true);
    }
  }
  try {
    const psCmd =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress";
    const res = spawnSyncFn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCmd],
      { encoding: "utf8", timeout: 2500, windowsHide: true },
    );
    if (res && res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
      const parsed = JSON.parse(res.stdout.trim());
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const alivePids = new Set();
      const creationByPid = new Map();
      const childrenByParent = new Map();
      for (const r of rows) {
        const pid = Number(r?.ProcessId);
        const ppid = Number(r?.ParentProcessId);
        const cdate = normalizeCreationToken(r?.CreationDate);
        if (Number.isInteger(pid) && pid > 0) {
          alivePids.add(pid);
          if (cdate) {
            creationByPid.set(pid, cdate);
          }
          if (Number.isInteger(ppid) && ppid > 0) {
            let list = childrenByParent.get(ppid);
            if (!list) {
              list = [];
              childrenByParent.set(ppid, list);
            }
            list.push(pid);
          }
        }
      }
      const isSameProcessInstance = (pid, expectedCreation, prevAlive = true) => {
        if (!alivePids.has(pid)) return false;
        if (prevAlive === false || expectedCreation === "__exited__") return false;
        const actualCreation = creationByPid.get(pid) ?? null;
        if (!actualCreation) return false;
        if (!expectedCreation) return true;
        return actualCreation === expectedCreation;
      };
      const isIdentityUnverifiable = (pid, expectedCreation, prevAlive = true) =>
        alivePids.has(pid) &&
        prevAlive !== false &&
        expectedCreation !== "__exited__" &&
        !creationByPid.get(pid);
      for (const rawPgid of pgids || []) {
        const parsedPgid = parseWindowsPgidKey(rawPgid);
        if (!parsedPgid) continue;
        const { key: pgidKey, pid: pgid, rootCreation: explicitRootCreation } = parsedPgid;
        let prevKnown = winKnownTreeDescendants.get(pgidKey);
        if (!prevKnown && explicitRootCreation) {
          const byBare = winKnownTreeDescendants.get(pgid);
          if (byBare && deriveWindowsTreeGenerationToken(pgid, byBare) === explicitRootCreation) {
            prevKnown = byBare;
          }
        }
        prevKnown = prevKnown || new Map();
        const prevRootEntry = prevKnown.get(pgid);
        const normalizedExplicitRoot =
          explicitRootCreation && explicitRootCreation.startsWith("__exited__")
            ? "__exited__"
            : explicitRootCreation;
        const expectedRootCreation =
          prevRootEntry?.creationDate ?? normalizedExplicitRoot ?? null;
        let hasUnverifiableIdentity = isIdentityUnverifiable(
          pgid,
          expectedRootCreation,
          prevRootEntry?.alive,
        );
        if (!hasUnverifiableIdentity) {
          for (const [kPid, prevMeta] of prevKnown.entries()) {
            if (isIdentityUnverifiable(kPid, prevMeta?.creationDate, prevMeta?.alive)) {
              hasUnverifiableIdentity = true;
              break;
            }
          }
        }
        if (hasUnverifiableIdentity) {
          result.set(pgidKey, triState ? null : true);
          continue;
        }
        const nextKnown = new Map();
        const queue = [];
        const visited = new Set();
        const liveMembers = new Set();

        const rootCreation =
          expectedRootCreation ?? creationByPid.get(pgid) ?? null;
        if (isSameProcessInstance(pgid, expectedRootCreation, prevRootEntry?.alive)) {
          queue.push(pgid);
          visited.add(pgid);
          liveMembers.add(pgid);
          nextKnown.set(pgid, {
            pid: pgid,
            creationDate: creationByPid.get(pgid) ?? rootCreation,
            alive: true,
          });
        } else if (!prevRootEntry && !explicitRootCreation) {
          queue.push(pgid);
          visited.add(pgid);
          nextKnown.set(pgid, {
            pid: pgid,
            creationDate: "__exited__",
            alive: false,
          });
        } else {
          nextKnown.set(pgid, {
            pid: pgid,
            creationDate: expectedRootCreation ?? "__exited__",
            alive: false,
          });
        }

        for (const [kPid, prevMeta] of prevKnown.entries()) {
          if (kPid === pgid) continue;
          const expectedCreation = prevMeta?.creationDate ?? null;
          if (isSameProcessInstance(kPid, expectedCreation, prevMeta?.alive)) {
            liveMembers.add(kPid);
            nextKnown.set(kPid, {
              pid: kPid,
              creationDate: creationByPid.get(kPid) ?? expectedCreation,
              alive: true,
            });
            if (!visited.has(kPid)) {
              visited.add(kPid);
              queue.push(kPid);
            }
          } else {
            // Exited or reused intermediate PID: keep tombstone without traversing children,
            // since any legitimate descendant observed while kPid was alive is already in prevKnown.
            nextKnown.set(kPid, {
              pid: kPid,
              creationDate: expectedCreation ?? "__exited__",
              alive: false,
            });
          }
        }

        while (queue.length > 0) {
          const cur = queue.shift();
          const kids = childrenByParent.get(cur) || [];
          for (const kid of kids) {
            const prevKidMeta = prevKnown.get(kid);
            const expectedKidCreation = prevKidMeta?.creationDate ?? null;
            if (isIdentityUnverifiable(kid, expectedKidCreation, prevKidMeta?.alive)) {
              hasUnverifiableIdentity = true;
              break;
            }
            if (isSameProcessInstance(kid, expectedKidCreation, prevKidMeta?.alive)) {
              liveMembers.add(kid);
              nextKnown.set(kid, {
                pid: kid,
                creationDate: creationByPid.get(kid) ?? expectedKidCreation,
                alive: true,
              });
              if (!visited.has(kid)) {
                visited.add(kid);
                queue.push(kid);
              }
            }
          }
          if (hasUnverifiableIdentity) break;
        }
        if (hasUnverifiableIdentity) {
          result.set(pgidKey, triState ? null : true);
          continue;
        }

        if (liveMembers.size > 0) {
          winKnownTreeDescendants.set(pgidKey, nextKnown);
          result.set(pgidKey, true);
        } else {
          winKnownTreeDescendants.delete(pgidKey);
          result.set(pgidKey, false);
        }
      }
      result.refreshed = true;
    }
  } catch {
    // Preserve conservative alive (true) default (or null in triState mode) when PowerShell fails or times out
  }
  return result;
}

export function getKnownWindowsTreePids(pgid, { liveOnly = false } = {}) {
  const parsed = parseWindowsPgidKey(pgid);
  if (!parsed) return [];
  const known = winKnownTreeDescendants.get(parsed.key);
  if (!known) return [];
  const out = [];
  for (const [pid, meta] of known.entries()) {
    if (liveOnly && meta && meta.alive === false) continue;
    out.push(pid);
  }
  return out;
}

export function getKnownWindowsTreeDescendants(pgid) {
  const parsed = parseWindowsPgidKey(pgid);
  if (!parsed) return [];
  const known = winKnownTreeDescendants.get(parsed.key);
  if (!known) return [];
  const out = [];
  for (const [pid, meta] of known.entries()) {
    out.push({
      pid,
      creationDate: meta?.creationDate ?? null,
    });
  }
  return out;
}

function resolveWindowsPgidKey(parsedPgid, knownDescendants) {
  if (!parsedPgid) return null;
  if (parsedPgid.rootCreation || !knownDescendants || typeof knownDescendants !== "object") {
    return parsedPgid.key;
  }
  const pgid = parsedPgid.pid;
  const entries = Array.isArray(knownDescendants)
    ? knownDescendants
    : knownDescendants[String(pgid)];
  if (!Array.isArray(entries) || entries.length === 0) {
    return parsedPgid.key;
  }
  const expectedGenToken = deriveWindowsTreeGenerationToken(pgid, entries);
  if (!expectedGenToken) {
    return parsedPgid.key;
  }
  const archiveKey = `${pgid}@${expectedGenToken}`;
  if (winKnownTreeDescendants.has(archiveKey)) {
    return archiveKey;
  }
  const existingBare = winKnownTreeDescendants.get(pgid);
  const existingGenToken = deriveWindowsTreeGenerationToken(pgid, existingBare);
  if (existingGenToken && existingGenToken !== expectedGenToken) {
    return archiveKey;
  }
  return parsedPgid.key;
}

export function isProcessGroupAlive(
  pgidOrLease,
  secondArg = {},
  thirdArg = undefined,
) {
  const options =
    thirdArg !== undefined
      ? { ...(thirdArg || {}), knownDescendants: secondArg ?? thirdArg?.knownDescendants ?? null }
      : secondArg || {};
  const {
    allowSubprocess = true,
    knownDescendants = null,
    lease = null,
    platform = process.platform,
    livenessCheck = isPidAlive,
  } = options;
  const spawnSyncFn = options.spawnSyncFn || options.runner || spawnSync;
  const killFn = options.killFn || process.kill.bind(process);

  if (pgidOrLease && typeof pgidOrLease === "object") {
    const targetLease = pgidOrLease;
    const leasePgids = Array.isArray(targetLease.workerPgids)
      ? targetLease.workerPgids
      : Array.isArray(targetLease.workerPids)
        ? targetLease.workerPids
        : targetLease.workerPid
          ? [targetLease.workerPid]
          : [];
    return leasePgids.some((p) =>
      isProcessGroupAlive(p, {
        allowSubprocess,
        knownDescendants: knownDescendants || targetLease.workerDescendants || null,
        pgidStartTokens:
          options.pgidStartTokens || targetLease.workerPgidStartTokens || null,
        lease: targetLease,
        spawnSyncFn,
        platform,
        livenessCheck,
        killFn,
      }),
    );
  }
  const parsedPgid = parseWindowsPgidKey(pgidOrLease);
  if (!parsedPgid) {
    return false;
  }
  const { pid: pgid } = parsedPgid;
  const effectiveKnown = knownDescendants || lease?.workerDescendants || null;
  if (effectiveKnown) {
    if (Array.isArray(effectiveKnown)) {
      seedWindowsKnownDescendants(parsedPgid.key, effectiveKnown);
    } else {
      seedWindowsKnownDescendants(effectiveKnown);
    }
  }
  const pgidKey = resolveWindowsPgidKey(parsedPgid, effectiveKnown);
  if (platform === "win32" || winKnownTreeDescendants.has(pgidKey)) {
    if (activePgidLivenessSnapshot && activePgidLivenessSnapshot.has(pgidKey)) {
      return activePgidLivenessSnapshot.get(pgidKey);
    }
    if (allowSubprocess) {
      return Boolean(
        queryWindowsProcessGroups([pgidKey], spawnSyncFn, {
          knownDescendants: effectiveKnown,
        }).get(pgidKey),
      );
    }
    const knownMap = winKnownTreeDescendants.get(pgidKey);
    const rootMeta = knownMap?.get(pgid);
    if ((!rootMeta || rootMeta.alive !== false) && livenessCheck(pgid)) {
      return true;
    }
    if (knownMap) {
      for (const [descPid, meta] of knownMap.entries()) {
        if (meta && meta.alive === false) continue;
        if (livenessCheck(descPid)) {
          return true;
        }
      }
    }
    return false;
  }
  if (activePgidLivenessSnapshot && activePgidLivenessSnapshot.has(pgidKey)) {
    return activePgidLivenessSnapshot.get(pgidKey);
  }
  if (activePgidLivenessSnapshot && activePgidLivenessSnapshot.has(pgid)) {
    return activePgidLivenessSnapshot.get(pgid);
  }
  const hasCustomLiveness =
    typeof livenessCheck === "function" && livenessCheck !== isPidAlive;
  let groupExists = false;
  try {
    killFn(-pgid, 0);
    groupExists = true;
  } catch (err) {
    if (err && err.code === "EPERM") {
      groupExists = true;
    }
  }
  if (!groupExists && !(hasCustomLiveness && livenessCheck(pgid))) {
    return false;
  }
  const expectedStartToken = resolveExpectedPosixPgidStartToken(
    pgidOrLease,
    options,
  );
  if (expectedStartToken) {
    const actualStartToken = getPosixProcessStartToken(pgid, {
      spawnSyncFn,
      platform,
      expectedToken: expectedStartToken,
      allowSubprocess,
    });
    if (actualStartToken !== null && actualStartToken !== expectedStartToken) {
      return false;
    }
    if (!groupExists && hasCustomLiveness && livenessCheck(pgid)) {
      return true;
    }
  } else if (!groupExists && hasCustomLiveness && livenessCheck(pgid)) {
    return true;
  }
  if (platform === "linux") {
    try {
      const entries = fs.readdirSync("/proc");
      let inspectedAny = false;
      for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
          const closeParen = stat.lastIndexOf(")");
          if (closeParen === -1) continue;
          const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
          const state = fields[0];
          const pgrp = Number(fields[2]);
          if (!Number.isInteger(pgrp)) continue;
          inspectedAny = true;
          if (pgrp === pgid && state && !state.toUpperCase().startsWith("Z")) {
            return true;
          }
        } catch {
          // Process exited or unreadable; continue scanning
        }
      }
      if (inspectedAny) {
        return false;
      }
    } catch {
      // Fall back to ps below if /proc is unavailable
    }
  }
  if (!allowSubprocess) {
    return true;
  }
  try {
    const res = spawnSyncFn("ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8",
      timeout: 1500,
    });
    if (res && res.status === 0 && typeof res.stdout === "string") {
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [pgidStr, statStr] = trimmed.split(/\s+/, 2);
        if (
          Number(pgidStr) === pgid &&
          statStr &&
          !statStr.toUpperCase().startsWith("Z")
        ) {
          return true;
        }
      }
      return false;
    }
  } catch {
    // Ignore ps failures and fall back to kill(-pgid, 0) result
  }
  return true;
}

export const hasAliveProcessInGroup = isProcessGroupAlive;

function withTerminatedPgids(arr, terminatedPgids) {
  Object.defineProperty(arr, "terminatedPgids", {
    value: terminatedPgids,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return arr;
}

export function killProcessGroupTree(
  pgidOrLease,
  signalOrOptions = "SIGTERM",
  maybeOptions = {},
) {
  const options =
    signalOrOptions && typeof signalOrOptions === "object"
      ? signalOrOptions
      : maybeOptions || {};
  const signal =
    typeof signalOrOptions === "string"
      ? signalOrOptions
      : options.signal || "SIGTERM";
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || options.runner || spawnSync;
  const knownDescendants =
    options.knownDescendants || options.lease?.workerDescendants || null;

  if (pgidOrLease && typeof pgidOrLease === "object") {
    const lease = pgidOrLease;
    const pgids = Array.isArray(lease.workerPgids)
      ? lease.workerPgids
      : Array.isArray(lease.workerPids)
        ? lease.workerPids
        : lease.workerPid
          ? [lease.workerPid]
          : [];
    const killed = [];
    const confirmedPgids = [];
    for (const p of pgids) {
      const sub = killProcessGroupTree(p, signal, {
        ...options,
        lease,
        knownDescendants: knownDescendants || lease.workerDescendants || null,
        pgidStartTokens:
          options.pgidStartTokens || lease.workerPgidStartTokens || null,
      });
      killed.push(...sub);
      if (Array.isArray(sub.terminatedPgids)) {
        confirmedPgids.push(...sub.terminatedPgids);
      } else if (sub.length > 0) {
        const parsedP = parseWindowsPgidKey(p);
        confirmedPgids.push(parsedP ? parsedP.key : Number(p));
      }
    }
    return withTerminatedPgids(killed, confirmedPgids);
  }

  const parsedPgid = parseWindowsPgidKey(pgidOrLease);
  const childPid = parsedPgid ? parsedPgid.pid : Number(pgidOrLease);
  if (!Number.isInteger(childPid) || childPid <= 0) {
    return withTerminatedPgids([], []);
  }

  if (platform === "win32") {
    if (knownDescendants) {
      if (Array.isArray(knownDescendants)) {
        seedWindowsKnownDescendants(parsedPgid ? parsedPgid.key : childPid, knownDescendants);
      } else {
        seedWindowsKnownDescendants(knownDescendants);
      }
    }
    const childKey = parsedPgid
      ? resolveWindowsPgidKey(parsedPgid, knownDescendants)
      : childPid;
    let refreshedAlive = null;
    if (options.refresh !== false) {
      refreshedAlive = queryWindowsProcessGroups([childKey], spawnSyncFn, {
        triState: true,
      }).get(childKey);
    }
    if (refreshedAlive === false) {
      winKnownTreeDescendants.delete(childKey);
      return withTerminatedPgids([], [childKey]);
    }
    if (refreshedAlive !== true) {
      return withTerminatedPgids([], []);
    }
    const liveKnownPids = getKnownWindowsTreePids(childKey, { liveOnly: true });
    const pidsToKill = [];
    const seen = new Set();
    for (const p of liveKnownPids) {
      if (Number.isInteger(p) && p > 0 && !seen.has(p)) {
        seen.add(p);
        pidsToKill.push(p);
      }
    }
    if (pidsToKill.length === 0) {
      winKnownTreeDescendants.delete(childKey);
      return withTerminatedPgids([], [childKey]);
    }
    const pidArgs = [];
    for (const p of pidsToKill) {
      pidArgs.push("/PID", String(p));
    }
    let taskkillConfirmed = false;
    try {
      const tkRes = spawnSyncFn("taskkill", ["/T", "/F", ...pidArgs], {
        stdio: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      taskkillConfirmed =
        Boolean(tkRes) &&
        !tkRes.error &&
        (tkRes.status === 0 || tkRes.status === 128);
    } catch {
      let allSignaled = true;
      for (const p of pidsToKill) {
        try {
          process.kill(p, signal);
        } catch (err) {
          if (err && err.code !== "ESRCH") {
            allSignaled = false;
          }
        }
      }
      taskkillConfirmed = allSignaled;
    }
    if (!taskkillConfirmed) {
      return withTerminatedPgids([], []);
    }
    winKnownTreeDescendants.delete(childKey);
    return withTerminatedPgids(pidsToKill, [childKey]);
  }

  const killFn = options.killFn || process.kill.bind(process);
  const livenessCheck = options.livenessCheck || isPidAlive;
  if (options.pgidStartTokens && typeof options.pgidStartTokens === "object") {
    seedPosixPgidStartTokens(options.pgidStartTokens);
  }
  if (
    options.lease?.workerPgidStartTokens &&
    typeof options.lease.workerPgidStartTokens === "object"
  ) {
    seedPosixPgidStartTokens(options.lease.workerPgidStartTokens);
  }
  const expectedStartToken = resolveExpectedPosixPgidStartToken(
    pgidOrLease,
    options,
  );
  const hasLeaseContext = Boolean(options.lease || options.requireLeaderToken);
  if (expectedStartToken) {
    const actualStartToken = getPosixProcessStartToken(childPid, {
      spawnSyncFn,
      platform,
      expectedToken: expectedStartToken,
    });
    if (actualStartToken !== null && actualStartToken !== expectedStartToken) {
      posixKnownPgidStartTokens.delete(childPid);
      return withTerminatedPgids([], [parsedPgid ? parsedPgid.key : childPid]);
    }
    if (actualStartToken === null && livenessCheck(childPid)) {
      return withTerminatedPgids([], []);
    }
  } else if (hasLeaseContext && livenessCheck(childPid)) {
    return withTerminatedPgids([], []);
  }
  let groupSignaled = false;
  let groupMissing = false;
  try {
    killFn(-childPid, signal);
    groupSignaled = true;
  } catch (groupErr) {
    groupMissing = Boolean(groupErr && groupErr.code === "ESRCH");
  }
  if (groupMissing) {
    return withTerminatedPgids([], [parsedPgid ? parsedPgid.key : childPid]);
  }
  if (
    !groupSignaled &&
    isProcessGroupAlive(childPid, {
      allowSubprocess: true,
      spawnSyncFn,
      platform,
      killFn,
      expectedStartToken,
    })
  ) {
    return withTerminatedPgids([], []);
  }
  return withTerminatedPgids(
    groupSignaled ? [childPid] : [],
    [parsedPgid ? parsedPgid.key : childPid],
  );
}

export function snapshotProcessGroupsOutsideLock(pgidsOrState, options = {}) {
  const snapshot = new Map();
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || options.runner || spawnSync;
  const rawList = [];
  const mergedKnown = {};
  const mergedTokens = {};
  if (options.knownDescendants && typeof options.knownDescendants === "object") {
    if (Array.isArray(options.knownDescendants)) {
      // Handled per-pgid below if single pgid
    } else {
      Object.assign(mergedKnown, options.knownDescendants);
    }
  }
  if (options.pgidStartTokens && typeof options.pgidStartTokens === "object") {
    Object.assign(mergedTokens, options.pgidStartTokens);
  }
  if (Array.isArray(pgidsOrState)) {
    for (const item of pgidsOrState) {
      if (item && typeof item === "object") {
        if (Array.isArray(item.workerPgids)) {
          rawList.push(...item.workerPgids);
        }
        if (item.workerDescendants && typeof item.workerDescendants === "object") {
          Object.assign(mergedKnown, item.workerDescendants);
        }
        if (
          item.workerPgidStartTokens &&
          typeof item.workerPgidStartTokens === "object"
        ) {
          Object.assign(mergedTokens, item.workerPgidStartTokens);
        }
      } else {
        rawList.push(item);
      }
    }
  } else if (pgidsOrState && typeof pgidsOrState === "object") {
    const leases = pgidsOrState.leases
      ? Object.values(pgidsOrState.leases)
      : [pgidsOrState];
    for (const lease of leases) {
      if (!lease || typeof lease !== "object") continue;
      if (Array.isArray(lease.workerPgids)) {
        rawList.push(...lease.workerPgids);
      }
      if (lease.workerDescendants && typeof lease.workerDescendants === "object") {
        Object.assign(mergedKnown, lease.workerDescendants);
      }
      if (
        lease.workerPgidStartTokens &&
        typeof lease.workerPgidStartTokens === "object"
      ) {
        Object.assign(mergedTokens, lease.workerPgidStartTokens);
      }
    }
  }
  if (rawList.length === 0) {
    return snapshot;
  }
  if (platform === "win32") {
    const validCandidates = [];
    if (Object.keys(mergedKnown).length > 0) {
      seedWindowsKnownDescendants(mergedKnown);
    }
    for (const raw of rawList) {
      const parsed = parseWindowsPgidKey(raw);
      if (!parsed || snapshot.has(parsed.key)) continue;
      validCandidates.push(parsed.key);
      snapshot.set(parsed.key, isPidAlive(parsed.pid));
      if (Array.isArray(options.knownDescendants)) {
        seedWindowsKnownDescendants(parsed.key, options.knownDescendants);
      }
      if (parsed.key === parsed.pid) {
        const bareEntries = mergedKnown[String(parsed.pid)];
        const bareRoot = Array.isArray(bareEntries)
          ? bareEntries.find((e) => Number(e?.pid ?? e?.ProcessId) === parsed.pid)
          : null;
        const bareCreation = bareRoot
          ? normalizeCreationToken(bareRoot.creationDate ?? bareRoot.CreationDate)
          : null;
        const archivedKey = bareCreation ? `${parsed.pid}@${bareCreation}` : null;
        if (archivedKey && winKnownTreeDescendants.has(archivedKey) && !snapshot.has(archivedKey)) {
          validCandidates.push(archivedKey);
          snapshot.set(archivedKey, true);
        }
      }
    }
    if (validCandidates.length > 0) {
      const winRes = queryWindowsProcessGroups(validCandidates, spawnSyncFn);
      for (const [pgidKey, alive] of winRes.entries()) {
        snapshot.set(pgidKey, Boolean(alive));
      }
    }
    return snapshot;
  }
  if (Object.keys(mergedTokens).length > 0) {
    seedPosixPgidStartTokens(mergedTokens);
  }
  const killFn = options.killFn || process.kill.bind(process);
  const hasCustomLiveness =
    typeof options.livenessCheck === "function" &&
    options.livenessCheck !== isPidAlive;
  const candidates = [];
  for (const raw of rawList) {
    const parsed = parseWindowsPgidKey(raw);
    if (!parsed) continue;
    const pgid = parsed.pid;
    if (!Number.isInteger(pgid) || pgid <= 1 || snapshot.has(pgid)) continue;
    let groupExists = false;
    try {
      killFn(-pgid, 0);
      groupExists = true;
    } catch (err) {
      if (err && err.code === "EPERM") {
        groupExists = true;
      }
    }
    const customAlive = !groupExists && hasCustomLiveness && options.livenessCheck(pgid);
    if (!groupExists && !customAlive) {
      snapshot.set(pgid, false);
      if (parsed.key !== pgid) {
        snapshot.set(parsed.key, false);
      }
      continue;
    }
    const expectedToken =
      parsed.rootCreation ||
      mergedTokens[String(pgid)] ||
      posixKnownPgidStartTokens.get(pgid) ||
      null;
    if (expectedToken) {
      const actualToken = getPosixProcessStartToken(pgid, {
        spawnSyncFn,
        platform,
        expectedToken,
      });
      if (actualToken !== null && actualToken !== expectedToken) {
        snapshot.set(pgid, false);
        if (parsed.key !== pgid) {
          snapshot.set(parsed.key, false);
        }
        continue;
      }
      if (customAlive) {
        snapshot.set(pgid, true);
        if (parsed.key !== pgid) {
          snapshot.set(parsed.key, true);
        }
        continue;
      }
    } else if (customAlive) {
      snapshot.set(pgid, true);
      if (parsed.key !== pgid) {
        snapshot.set(parsed.key, true);
      }
      continue;
    }
    candidates.push(pgid);
    snapshot.set(pgid, false);
  }
  if (candidates.length === 0) {
    return snapshot;
  }
  const candidateSet = new Set(candidates);
  if (platform === "linux") {
    try {
      const entries = fs.readdirSync("/proc");
      let inspectedAny = false;
      for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
          const closeParen = stat.lastIndexOf(")");
          if (closeParen === -1) continue;
          const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
          const state = fields[0];
          const pgrp = Number(fields[2]);
          if (!Number.isInteger(pgrp)) continue;
          inspectedAny = true;
          if (candidateSet.has(pgrp) && state && !state.toUpperCase().startsWith("Z")) {
            snapshot.set(pgrp, true);
          }
        } catch {
          // Process exited or unreadable
        }
      }
      if (inspectedAny) {
        return snapshot;
      }
    } catch {
      // Fall back to ps below
    }
  }
  try {
    const res = spawnSyncFn("ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8",
      timeout: 1500,
    });
    if (res && res.status === 0 && typeof res.stdout === "string") {
      for (const line of res.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [pgidStr, statStr] = trimmed.split(/\s+/, 2);
        const pgrp = Number(pgidStr);
        if (
          candidateSet.has(pgrp) &&
          statStr &&
          !statStr.toUpperCase().startsWith("Z")
        ) {
          snapshot.set(pgrp, true);
        }
      }
      return snapshot;
    }
  } catch {
    // Ignore ps failures
  }
  for (const pgid of candidates) {
    snapshot.set(pgid, true);
  }
  return snapshot;
}

export function withProcessGroupSnapshot(snapshot, fn) {
  const prev = activePgidLivenessSnapshot;
  activePgidLivenessSnapshot = snapshot instanceof Map ? snapshot : null;
  try {
    return fn();
  } finally {
    activePgidLivenessSnapshot = prev;
  }
}

export function resolveStateDir(overrideDir = process.env.ATC_STATE_DIR) {
  let stateDir;
  if (overrideDir && overrideDir.trim()) {
    stateDir = overrideDir.trim();
    if (!path.isAbsolute(stateDir)) {
      throw new Error(`ATC_STATE_DIR must be an absolute path: ${stateDir}`);
    }
  } else if (process.platform === "darwin") {
    stateDir = path.join(os.homedir(), "Library", "Application Support", "atc");
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    stateDir = path.join(localAppData, "atc");
  } else {
    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    if (xdgRuntime && path.isAbsolute(xdgRuntime)) {
      try {
        const st = fs.lstatSync(xdgRuntime);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          stateDir = path.join(xdgRuntime, "atc");
        }
      } catch {
        // Fallback to ~/.local/state/atc
      }
    }
    if (!stateDir) {
      stateDir = path.join(os.homedir(), ".local", "state", "atc");
    }
  }

  ensureSafeDirectory(stateDir);
  return stateDir;
}

export function ensureSafeDirectory(dirPath) {
  const parent = path.dirname(dirPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  const st = fs.lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`State directory must be a real directory (not a symlink): ${dirPath}`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    const uid = process.getuid();
    if (st.uid !== uid) {
      throw new Error(`State directory ${dirPath} is owned by uid ${st.uid}, expected ${uid}`);
    }
    try {
      fs.chmodSync(dirPath, 0o700);
    } catch {
      // Ignore chmod failures on restricted filesystems
    }
  }
}

export function writeFileAtomic(targetPath, content, nonce = randomNonce(), beforeRename = null) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `${base}.tmp.${process.pid}.${nonce}`);
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (typeof beforeRename === "function") {
        beforeRename();
      }
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (process.platform === "win32" && (err.code === "EPERM" || err.code === "EACCES")) {
        sleepSync(15 + Math.floor(Math.random() * 30));
        continue;
      }
      break;
    }
  }
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // Best-effort cleanup
  }
  throw lastErr;
}

export function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function toSafeToken(raw) {
  const str = String(raw ?? "");
  if (/^[A-Za-z0-9_-]{1,64}$/.test(str)) {
    return str;
  }
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 32);
}

function getValidOwnerToken(lockDir, info) {
  try {
    const dirSt = fs.lstatSync(lockDir);
    return `nonce.${dirSt.ino || 0}.${info.ino || 0}.${Math.trunc(info.createdAtMs || 0)}.${toSafeToken(info.nonce)}`;
  } catch {
    return null;
  }
}

function getInvalidOwnerToken(lockDir, ownerPath, raw) {
  try {
    const dirSt = fs.lstatSync(lockDir);
    const ownerSt = fs.lstatSync(ownerPath);
    const rawHash = crypto
      .createHash("sha256")
      .update(String(raw ?? ""))
      .digest("hex")
      .slice(0, 16);
    const dirId = `${dirSt.ino || 0}_${Math.trunc(dirSt.birthtimeMs || dirSt.ctimeMs || dirSt.mtimeMs || 0)}`;
    const ownerId = `${ownerSt.ino || 0}_${Math.trunc(ownerSt.birthtimeMs || ownerSt.ctimeMs || ownerSt.mtimeMs || 0)}`;
    return `invalid.${dirId}.${ownerId}.${rawHash}`;
  } catch {
    return null;
  }
}

function inspectUnownedLockDir(lockDir) {
  try {
    const dirSt = fs.lstatSync(lockDir);
    const entries = fs.readdirSync(lockDir).sort();
    if (entries.includes("owner.json")) {
      return null;
    }
    const entryMeta = [];
    for (const name of entries) {
      const entryPath = path.join(lockDir, name);
      const st = fs.lstatSync(entryPath);
      if (st.isDirectory()) {
        return null;
      }
      entryMeta.push(
        `${name}:${st.ino || 0}:${Math.trunc(st.birthtimeMs || st.ctimeMs || st.mtimeMs || 0)}`,
      );
    }
    const dirId = `${dirSt.ino || 0}_${Math.trunc(dirSt.birthtimeMs || dirSt.ctimeMs || dirSt.mtimeMs || 0)}`;
    const entriesHash = crypto
      .createHash("sha256")
      .update(entryMeta.join("|"))
      .digest("hex")
      .slice(0, 16);
    return {
      token: `missing.${dirId}.${entriesHash}`,
      entries,
    };
  } catch {
    return null;
  }
}

function getClaimDirIdentity(claimDir) {
  try {
    const st = fs.lstatSync(claimDir);
    if (!st.isDirectory()) return null;
    return `${st.ino || 0}_${Math.trunc(st.birthtimeMs || st.ctimeMs || st.mtimeMs || 0)}`;
  } catch {
    return null;
  }
}

export function canSweepBreakClaimDir(claimDir, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(claimDir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const fullPath = path.join(claimDir, name);
    if (name.startsWith("breaker.") && name.endsWith(".json")) {
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        const validRecord =
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.nonce === "string" &&
          parsed.nonce.length > 0;
        if (validRecord && isPidAlive(parsed.pid)) {
          return false;
        }
      } catch (err) {
        if (!err || err.code !== "ENOENT") {
          try {
            const st = fs.lstatSync(fullPath);
            if (now - (st.mtimeMs || st.ctimeMs || 0) < MISSING_OWNER_STALE_MS) {
              return false;
            }
          } catch {
            return false;
          }
        }
      }
    } else if (name.includes(".tmp.")) {
      const m = name.match(/\.tmp\.(\d+)\./);
      const tmpPid = m ? Number(m[1]) : 0;
      try {
        const st = fs.lstatSync(fullPath);
        const alive =
          tmpPid > 0
            ? isPidAlive(tmpPid)
            : now - (st.mtimeMs || st.ctimeMs || 0) < MISSING_OWNER_STALE_MS;
        if (alive) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
}

export function trySweepBreakClaimDir(claimDir, now = Date.now()) {
  try {
    const st = fs.lstatSync(claimDir);
    const dirAgeMs = now - (st.mtimeMs || st.ctimeMs || 0);
    if (!st.isDirectory()) {
      if (dirAgeMs > 60_000) {
        fs.unlinkSync(claimDir);
        return true;
      }
      return false;
    }
    if (dirAgeMs <= 60_000) {
      return false;
    }
    const state = inspectAndCleanBreakClaimDir(claimDir, now);
    if (state.active) {
      return false;
    }
    const entries = fs.readdirSync(claimDir);
    if (entries.some((n) => n !== "done" && !n.startsWith("moved."))) {
      return false;
    }
    if (entries.length === 0) {
      fs.rmdirSync(claimDir);
      return true;
    }
    for (const name of entries) {
      const entrySt = fs.lstatSync(path.join(claimDir, name));
      if (now - (entrySt.mtimeMs || entrySt.ctimeMs || 0) <= 60_000) {
        return false;
      }
    }
    const retiringDir = `${claimDir}.retiring.${process.pid}.${randomNonce()}`;
    fs.renameSync(claimDir, retiringDir);
    for (const name of fs.readdirSync(retiringDir)) {
      const target = path.join(retiringDir, name);
      try {
        const entrySt = fs.lstatSync(target);
        if (entrySt.isDirectory()) {
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          fs.unlinkSync(target);
        }
      } catch {
        // Ignore cleanup error inside retired dir
      }
    }
    fs.rmdirSync(retiringDir);
    return true;
  } catch {
    return false;
  }
}

function sweepStaleLockClaims(stateDir, lockName, now = Date.now()) {
  const prefix = `${lockName}.stale.`;
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(prefix)) continue;
      trySweepBreakClaimDir(path.join(stateDir, name), now);
    }
  } catch {
    // Ignore directory read errors
  }
}

function inspectAndCleanBreakClaimDir(claimDir, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(claimDir);
  } catch {
    return { done: false, active: true, cleanedAny: false };
  }
  for (const name of entries) {
    if (name === "done" || name.startsWith("moved.")) {
      return { done: true, active: false, cleanedAny: false };
    }
  }
  let hasActive = false;
  let cleanedAny = false;
  for (const name of entries) {
    const fullPath = path.join(claimDir, name);
    if (name.startsWith("breaker.") && name.endsWith(".json")) {
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        const validRecord =
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.nonce === "string" &&
          parsed.nonce.length > 0;
        const alive = validRecord && isPidAlive(parsed.pid);
        if (alive) {
          hasActive = true;
        } else {
          try {
            fs.unlinkSync(fullPath);
            cleanedAny = true;
          } catch {
            // Ignore concurrent unlink
          }
        }
      } catch (err) {
        if (!err || err.code !== "ENOENT") {
          try {
            const st = fs.lstatSync(fullPath);
            if (now - (st.mtimeMs || st.ctimeMs || 0) >= MISSING_OWNER_STALE_MS) {
              fs.unlinkSync(fullPath);
              cleanedAny = true;
            } else {
              hasActive = true;
            }
          } catch {
            // Ignore concurrent removal
          }
        }
      }
    } else if (name.includes(".tmp.")) {
      const m = name.match(/\.tmp\.(\d+)\./);
      const tmpPid = m ? Number(m[1]) : 0;
      try {
        const st = fs.lstatSync(fullPath);
        const alive =
          tmpPid > 0
            ? isPidAlive(tmpPid)
            : now - (st.mtimeMs || st.ctimeMs || 0) < MISSING_OWNER_STALE_MS;
        if (alive) {
          hasActive = true;
        } else {
          fs.unlinkSync(fullPath);
          cleanedAny = true;
        }
      } catch {
        // Ignore concurrent removal
      }
    }
  }
  return { done: false, active: hasActive, cleanedAny };
}

function tryRecoverAbandonedClaimDir(claimDir, now = Date.now()) {
  try {
    const dirSt = fs.lstatSync(claimDir);
    if (!dirSt.isDirectory()) return false;
    const state = inspectAndCleanBreakClaimDir(claimDir, now);
    if (state.done || state.active) {
      return false;
    }
    const dirAgeMs = now - (dirSt.mtimeMs || dirSt.ctimeMs || 0);
    if (!state.cleanedAny && dirAgeMs < MISSING_OWNER_STALE_MS) {
      return false;
    }
    fs.rmdirSync(claimDir);
    return true;
  } catch {
    return false;
  }
}

function tryWithBreakClaim(stateDir, lockName, candidateBreakToken, fn, options = {}) {
  if (!candidateBreakToken) return false;
  const claimDir = path.join(stateDir, `${lockName}.stale.${candidateBreakToken}`);
  let createdFreshDir = false;
  let mkdirStartMs = Date.now();
  try {
    fs.mkdirSync(claimDir, { mode: 0o700 });
    createdFreshDir = true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      return false;
    }
    if (!tryRecoverAbandonedClaimDir(claimDir, Date.now())) {
      return false;
    }
    mkdirStartMs = Date.now();
    try {
      fs.mkdirSync(claimDir, { mode: 0o700 });
      createdFreshDir = true;
    } catch {
      return false;
    }
  }
  if (!createdFreshDir) {
    return false;
  }

  const myClaimDirId = getClaimDirIdentity(claimDir);
  if (!myClaimDirId || Date.now() - mkdirStartMs >= Math.floor(MISSING_OWNER_STALE_MS / 2)) {
    try {
      fs.rmdirSync(claimDir);
    } catch {
      // Ignore
    }
    return false;
  }

  const myClaimNonce = randomNonce();
  const myClaimStartMs = Date.now();
  const myBreakerName = `breaker.${myClaimNonce}.json`;
  const myBreakerPath = path.join(claimDir, myBreakerName);
  let completed = false;
  try {
    publishOwnerFileExclusive(
      myBreakerPath,
      JSON.stringify({
        pid: process.pid,
        createdAtMs: myClaimStartMs,
        nonce: myClaimNonce,
      }),
      myClaimNonce,
      () =>
        getClaimDirIdentity(claimDir) === myClaimDirId &&
        Date.now() - mkdirStartMs < Math.floor(MISSING_OWNER_STALE_MS / 2),
    );
    const verifyEntries = fs.readdirSync(claimDir);
    if (
      getClaimDirIdentity(claimDir) !== myClaimDirId ||
      verifyEntries.some((n) => n === "done" || n.startsWith("moved.")) ||
      verifyEntries.some((n) => n !== myBreakerName)
    ) {
      return false;
    }

    const canProceed = () => {
      try {
        if (getClaimDirIdentity(claimDir) !== myClaimDirId) {
          return false;
        }
        const curEntries = fs.readdirSync(claimDir);
        return (
          curEntries.includes(myBreakerName) &&
          !curEntries.some((n) => n === "done" || n.startsWith("moved.")) &&
          !curEntries.some((n) => n !== myBreakerName)
        );
      } catch {
        return false;
      }
    };

    completed = Boolean(fn({ claimDir, myClaimNonce, canProceed }));
    if (completed && !options.removeClaimOnComplete) {
      try {
        fs.writeFileSync(path.join(claimDir, "done"), "1", "utf8");
      } catch {
        // Best-effort completion marker
      }
    }
    return completed;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(myBreakerPath);
    } catch {
      // Ignore if already removed
    }
    if (completed && options.removeClaimOnComplete) {
      try {
        fs.unlinkSync(path.join(claimDir, "done"));
      } catch {
        // Ignore if not written
      }
    }
    if (!completed || options.removeClaimOnComplete) {
      try {
        const rem = fs.readdirSync(claimDir);
        if (rem.length === 0) {
          fs.rmdirSync(claimDir);
        }
      } catch {
        // Ignore if already removed or non-empty
      }
    }
  }
}

function publishOwnerFileExclusive(targetPath, content, nonce, canPublish = null) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `${base}.tmp.${process.pid}.${nonce}`);
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    if (typeof canPublish === "function" && !canPublish()) {
      const expiredErr = new Error("Lock owner publication window expired");
      expiredErr.code = "EEXIST";
      throw expiredErr;
    }
    try {
      fs.linkSync(tmpPath, targetPath);
    } catch (linkErr) {
      if (
        linkErr &&
        (linkErr.code === "ENOSYS" || linkErr.code === "EXDEV" || linkErr.code === "EPERM")
      ) {
        if (fs.existsSync(targetPath)) {
          const existsErr = new Error("Lock owner already exists");
          existsErr.code = "EEXIST";
          throw existsErr;
        }
        fs.renameSync(tmpPath, targetPath);
        return;
      }
      throw linkErr;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

function inspectOwnerFile(
  ownerPath,
  now,
  fallbackStaleMs = STALE_LOCK_MS,
  allowLivePidExpiry = true,
) {
  try {
    const st = fs.lstatSync(ownerPath);
    const raw = fs.readFileSync(ownerPath, "utf8");
    const owner = JSON.parse(raw);
    if (
      owner &&
      typeof owner === "object" &&
      typeof owner.nonce === "string" &&
      owner.nonce.length > 0 &&
      typeof owner.createdAtMs === "number" &&
      Number.isFinite(owner.createdAtMs)
    ) {
      const ownerStaleMs =
        typeof owner.staleAfterMs === "number" &&
        Number.isFinite(owner.staleAfterMs) &&
        owner.staleAfterMs > 0
          ? owner.staleAfterMs
          : fallbackStaleMs;
      const pidAlive = isPidAlive(owner.pid);
      const stale =
        !pidAlive || (allowLivePidExpiry && now - owner.createdAtMs > ownerStaleMs);
      return {
        valid: true,
        stale,
        nonce: owner.nonce,
        createdAtMs: owner.createdAtMs,
        ino: st.ino || 0,
      };
    }
    const ageMs = now - (st.mtimeMs || st.ctimeMs || 0);
    return { valid: false, missing: false, stale: ageMs >= MISSING_OWNER_STALE_MS, raw };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { valid: false, missing: true, stale: false, raw: null };
    }
    try {
      const st = fs.lstatSync(ownerPath);
      const ageMs = now - (st.mtimeMs || st.ctimeMs || 0);
      return {
        valid: false,
        missing: false,
        stale: ageMs >= MISSING_OWNER_STALE_MS,
        raw: fs.readFileSync(ownerPath, "utf8"),
      };
    } catch (readErr) {
      if (readErr && readErr.code === "ENOENT") {
        return { valid: false, missing: true, stale: false, raw: null };
      }
      return { valid: false, missing: false, stale: false, raw: "" };
    }
  }
}

export function acquireLock(
  stateDir,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockName = "atc.lock",
  staleLockMs = STALE_LOCK_MS,
  options = {},
) {
  ensureSafeDirectory(stateDir);
  const lockDir = path.join(stateDir, lockName);
  const ownerPath = path.join(lockDir, "owner.json");
  const allowLivePidExpiry = options?.allowLivePidExpiry !== false;
  const effectiveStaleMs =
    typeof staleLockMs === "number" && Number.isFinite(staleLockMs) && staleLockMs > 0
      ? Math.max(STALE_LOCK_MS, staleLockMs)
      : STALE_LOCK_MS;
  const startMs = Date.now();
  const observedUnownedAtMs = new Map();

  while (true) {
    if (typeof options?.shouldAbort === "function" && options.shouldAbort()) {
      throw new Error(`Aborted waiting to acquire ${lockDir}`);
    }
    const attemptStartMs = Date.now();
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const myNonce = randomNonce();
      const myCreatedAtMs = Date.now();
      if (myCreatedAtMs - attemptStartMs >= Math.floor(MISSING_OWNER_STALE_MS / 2)) {
        try {
          fs.rmdirSync(lockDir);
        } catch {
          // Ignore if already removed
        }
      } else {
        const ownerPayload = JSON.stringify({
          pid: process.pid,
          createdAtMs: myCreatedAtMs,
          staleAfterMs: effectiveStaleMs,
          nonce: myNonce,
        });
        publishOwnerFileExclusive(
          ownerPath,
          ownerPayload,
          myNonce,
          () => Date.now() - attemptStartMs < Math.floor(MISSING_OWNER_STALE_MS / 2),
        );
        const handle = {
          lockDir,
          ownerPath,
          nonce: myNonce,
        };
        if (
          Date.now() - attemptStartMs < Math.floor(effectiveStaleMs / 2) &&
          verifyLockOwnership(handle)
        ) {
          return handle;
        }
        releaseLock(handle);
      }
    } catch (err) {
      if (!err || (err.code !== "EEXIST" && err.code !== "ENOENT")) {
        throw err;
      }
    }

    const now = Date.now();
    const info = inspectOwnerFile(ownerPath, now, effectiveStaleMs, allowLivePidExpiry);
    let candidateStale = false;
    let candidateBreakToken = null;
    let candidateMissingEntries = null;

    if (info.valid) {
      observedUnownedAtMs.clear();
      if (info.stale) {
        candidateStale = true;
        candidateBreakToken = getValidOwnerToken(lockDir, info);
      }
    } else if (info.missing) {
      const unowned = inspectUnownedLockDir(lockDir);
      if (unowned) {
        candidateBreakToken = unowned.token;
        candidateMissingEntries = unowned.entries;
        const firstSeen = observedUnownedAtMs.get(unowned.token);
        if (firstSeen === undefined) {
          observedUnownedAtMs.set(unowned.token, now);
        } else if (now - firstSeen >= MISSING_OWNER_STALE_MS) {
          candidateStale = true;
        }
      }
    } else {
      const invToken = getInvalidOwnerToken(lockDir, ownerPath, info.raw);
      if (invToken) {
        candidateBreakToken = invToken;
        const firstSeen = observedUnownedAtMs.get(invToken);
        if (firstSeen === undefined) {
          observedUnownedAtMs.set(invToken, now);
        } else if (now - firstSeen >= MISSING_OWNER_STALE_MS) {
          candidateStale = true;
        }
      }
    }

    if (candidateStale && candidateBreakToken && Date.now() - now < 30_000) {
      if (typeof options?.shouldAbort === "function" && options.shouldAbort()) {
        throw new Error(`Aborted waiting to acquire ${lockDir}`);
      }
      const brokeLock = tryWithBreakClaim(
        stateDir,
        lockName,
        candidateBreakToken,
        ({ claimDir, myClaimNonce, canProceed }) => {
          if (info.missing) {
            const verifyInfo = inspectOwnerFile(
              ownerPath,
              Date.now(),
              effectiveStaleMs,
              allowLivePidExpiry,
            );
            const verifyUnowned = verifyInfo.missing ? inspectUnownedLockDir(lockDir) : null;
            if (!verifyUnowned || verifyUnowned.token !== candidateBreakToken || !canProceed()) {
              return false;
            }
            for (const entryName of candidateMissingEntries || []) {
              if (entryName === "owner.json") continue;
              try {
                fs.unlinkSync(path.join(lockDir, entryName));
              } catch {
                // Ignore if already removed
              }
            }
            if (!canProceed()) {
              return false;
            }
            fs.rmdirSync(lockDir);
            try {
              fs.writeFileSync(path.join(claimDir, "done"), "1", "utf8");
            } catch {
              // Ignore
            }
            return true;
          }

          const verifyInfo = inspectOwnerFile(
            ownerPath,
            Date.now(),
            effectiveStaleMs,
            allowLivePidExpiry,
          );
          const verifiedStale = info.valid
            ? verifyInfo.valid &&
              verifyInfo.stale &&
              getValidOwnerToken(lockDir, verifyInfo) === candidateBreakToken
            : !verifyInfo.valid &&
              !verifyInfo.missing &&
              getInvalidOwnerToken(lockDir, ownerPath, verifyInfo.raw) === candidateBreakToken;

          if (!verifiedStale || !canProceed()) {
            return false;
          }
          if (typeof options?.beforeBreakRename === "function") {
            options.beforeBreakRename({ lockDir, claimDir, candidateBreakToken });
            if (!canProceed()) {
              return false;
            }
          }
          const movedLockDir = path.join(claimDir, `moved.${myClaimNonce}`);
          fs.renameSync(lockDir, movedLockDir);
          try {
            fs.writeFileSync(path.join(claimDir, "done"), "1", "utf8");
          } catch {
            // Ignore
          }
          try {
            fs.rmSync(movedLockDir, { recursive: true, force: true });
          } catch {
            // Swept later by orphan sweep
          }
          return true;
        },
      );
      if (brokeLock) {
        observedUnownedAtMs.clear();
        sweepStaleLockClaims(stateDir, lockName);
        continue;
      }
    }

    if (Date.now() - startMs >= timeoutMs) {
      throw new Error(`Timed out waiting ${timeoutMs}ms to acquire ${lockDir}`);
    }

    sleepSync(15 + Math.floor(Math.random() * 35));
  }
}

export function verifyLockOwnership(lockHandle) {
  if (!lockHandle || !lockHandle.ownerPath) return false;
  try {
    const raw = fs.readFileSync(lockHandle.ownerPath, "utf8");
    const owner = JSON.parse(raw);
    return Boolean(owner && owner.nonce === lockHandle.nonce);
  } catch {
    return false;
  }
}

export function releaseLock(lockHandle) {
  if (!lockHandle || !lockHandle.ownerPath || !lockHandle.lockDir || !lockHandle.nonce) {
    return;
  }
  const info = inspectOwnerFile(lockHandle.ownerPath, Date.now(), STALE_LOCK_MS, false);
  if (!info.valid || info.nonce !== lockHandle.nonce) {
    return;
  }
  const token = getValidOwnerToken(lockHandle.lockDir, info);
  if (!token) {
    return;
  }
  const stateDir = path.dirname(lockHandle.lockDir);
  const lockName = path.basename(lockHandle.lockDir);

  tryWithBreakClaim(stateDir, lockName, token, ({ claimDir, myClaimNonce, canProceed }) => {
    const verifyInfo = inspectOwnerFile(lockHandle.ownerPath, Date.now(), STALE_LOCK_MS, false);
    if (
      !verifyInfo.valid ||
      verifyInfo.nonce !== lockHandle.nonce ||
      getValidOwnerToken(lockHandle.lockDir, verifyInfo) !== token ||
      !canProceed()
    ) {
      return false;
    }

    const movedLockDir = path.join(claimDir, `moved.${myClaimNonce}`);
    let renamedLockDir = false;
    try {
      fs.renameSync(lockHandle.lockDir, movedLockDir);
      renamedLockDir = true;
    } catch {
      // Fallback to in-place unlink + rmdir
    }

    if (renamedLockDir) {
      try {
        fs.writeFileSync(path.join(claimDir, "done"), "1", "utf8");
      } catch {
        // Ignore
      }
      try {
        fs.rmSync(movedLockDir, { recursive: true, force: true });
      } catch {
        // Swept later by orphan sweep
      }
      return true;
    }

    let unlinkedOwner = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.unlinkSync(lockHandle.ownerPath);
        unlinkedOwner = true;
        break;
      } catch (err) {
        if (err && err.code === "ENOENT") {
          unlinkedOwner = true;
          break;
        }
        if (attempt < 4) {
          sleepSync(10);
        }
      }
    }
    if (!unlinkedOwner) {
      return false;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmdirSync(lockHandle.lockDir);
        break;
      } catch (err) {
        if (err && err.code === "ENOENT") break;
        if (
          process.platform === "win32" &&
          err &&
          (err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOTEMPTY")
        ) {
          if (attempt < 4) {
            sleepSync(10);
            continue;
          }
          break;
        }
        break;
      }
    }
    try {
      fs.writeFileSync(path.join(claimDir, "done"), "1", "utf8");
    } catch {
      // Ignore
    }
    return true;
  }, { removeClaimOnComplete: true });
  sweepStaleLockClaims(stateDir, lockName);
}

export function withLock(
  stateDir,
  fn,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockName = "atc.lock",
  staleLockMs = STALE_LOCK_MS,
  options = {},
) {
  const handle = acquireLock(stateDir, timeoutMs, lockName, staleLockMs, options);
  try {
    return fn(handle);
  } finally {
    releaseLock(handle);
  }
}
