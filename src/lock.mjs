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

function isOwnerEntryName(name) {
  return name === "owner.json" || /^owner\.[A-Za-z0-9_-]+\.json$/.test(name);
}

function inspectOwnerFile(
  ownerPath,
  now,
  fallbackStaleMs = STALE_LOCK_MS,
  allowLivePidExpiry = true,
) {
  try {
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
      return { valid: true, stale, nonce: owner.nonce };
    }
    return { valid: false, missing: false, raw };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { valid: false, missing: true, raw: null };
    }
    try {
      return { valid: false, missing: false, raw: fs.readFileSync(ownerPath, "utf8") };
    } catch (readErr) {
      if (readErr && readErr.code === "ENOENT") {
        return { valid: false, missing: true, raw: null };
      }
      return { valid: false, missing: false, raw: "" };
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
  const allowLivePidExpiry = options?.allowLivePidExpiry !== false;
  const effectiveStaleMs =
    typeof staleLockMs === "number" && Number.isFinite(staleLockMs) && staleLockMs > 0
      ? Math.max(STALE_LOCK_MS, staleLockMs)
      : STALE_LOCK_MS;
  const startMs = Date.now();
  const invalidSeenAtMs = new Map();

  while (true) {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    let entries = [];
    try {
      entries = fs.readdirSync(lockDir);
    } catch {
      entries = [];
    }

    let hasLiveOwner = false;
    let unlinkedStale = false;
    const seenInvalidKeys = new Set();

    for (const entry of entries) {
      const entryPath = path.join(lockDir, entry);
      if (isOwnerEntryName(entry)) {
        const info = inspectOwnerFile(entryPath, now, effectiveStaleMs, allowLivePidExpiry);
        if (info.missing) {
          continue;
        }
        if (info.valid) {
          if (info.stale) {
            if (entry === `owner.${info.nonce}.json`) {
              try {
                fs.unlinkSync(entryPath);
                unlinkedStale = true;
              } catch {
                // Already unlinked by owner or competing breaker
              }
            } else {
              const info2 = inspectOwnerFile(
                entryPath,
                Date.now(),
                effectiveStaleMs,
                allowLivePidExpiry,
              );
              if (info2.valid && info2.stale && info2.nonce === info.nonce) {
                try {
                  fs.unlinkSync(entryPath);
                  unlinkedStale = true;
                } catch {
                  // Ignore concurrent unlink
                }
              }
            }
          } else {
            hasLiveOwner = true;
          }
        } else {
          const invKey = `${entry}:${info.raw ?? ""}`;
          seenInvalidKeys.add(invKey);
          const firstSeen = invalidSeenAtMs.get(invKey);
          if (firstSeen === undefined) {
            invalidSeenAtMs.set(invKey, now);
          } else if (now - firstSeen >= MISSING_OWNER_STALE_MS) {
            const recheck = inspectOwnerFile(
              entryPath,
              Date.now(),
              effectiveStaleMs,
              allowLivePidExpiry,
            );
            if (!recheck.valid && !recheck.missing && `${entry}:${recheck.raw ?? ""}` === invKey) {
              try {
                fs.unlinkSync(entryPath);
                invalidSeenAtMs.delete(invKey);
                unlinkedStale = true;
              } catch {
                // Ignore concurrent unlink
              }
            }
          } else {
            hasLiveOwner = true;
          }
        }
      } else if (entry.includes(".tmp.")) {
        try {
          const st = fs.lstatSync(entryPath);
          if (now - (st.mtimeMs || st.ctimeMs || 0) >= MISSING_OWNER_STALE_MS) {
            fs.unlinkSync(entryPath);
          }
        } catch {
          // Ignore transient temp file
        }
      }
    }

    for (const k of Array.from(invalidSeenAtMs.keys())) {
      if (!seenInvalidKeys.has(k)) {
        invalidSeenAtMs.delete(k);
      }
    }

    if (unlinkedStale && !hasLiveOwner) {
      continue;
    }

    if (!hasLiveOwner) {
      const myNonce = randomNonce();
      const myFileName = `owner.${myNonce}.json`;
      const myOwnerPath = path.join(lockDir, myFileName);
      const myCreatedAtMs = Date.now();
      let wroteCandidate = false;
      try {
        const ownerPayload = JSON.stringify({
          pid: process.pid,
          createdAtMs: myCreatedAtMs,
          staleAfterMs: effectiveStaleMs,
          nonce: myNonce,
        });
        writeFileAtomic(myOwnerPath, ownerPayload, myNonce);
        wroteCandidate = true;
        const postEntries = fs.readdirSync(lockDir).filter(isOwnerEntryName);
        if (
          postEntries.length === 1 &&
          postEntries[0] === myFileName &&
          Date.now() - myCreatedAtMs < Math.floor(effectiveStaleMs / 2)
        ) {
          return {
            lockDir,
            ownerPath: myOwnerPath,
            nonce: myNonce,
          };
        }
      } catch {
        // Fall through to cleanup and retry
      }
      if (wroteCandidate) {
        try {
          fs.unlinkSync(myOwnerPath);
        } catch {
          // Ignore if already removed
        }
      }
    }

    if (Date.now() - startMs >= timeoutMs) {
      throw new Error(`Timed out waiting ${timeoutMs}ms to acquire ${lockDir}`);
    }

    sleepSync(10 + Math.floor(Math.random() * 30));
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
  if (!lockHandle || !lockHandle.ownerPath) return;
  if (!verifyLockOwnership(lockHandle)) {
    return;
  }
  try {
    fs.unlinkSync(lockHandle.ownerPath);
  } catch {
    // Ignore if already unlinked
  }
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
