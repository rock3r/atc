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
  return name === "owner.json";
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
      return { valid: true, stale, nonce: owner.nonce };
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
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const myNonce = randomNonce();
      const myCreatedAtMs = Date.now();
      const ownerPayload = JSON.stringify({
        pid: process.pid,
        createdAtMs: myCreatedAtMs,
        staleAfterMs: effectiveStaleMs,
        nonce: myNonce,
      });
      writeFileAtomic(ownerPath, ownerPayload, myNonce);
      const handle = {
        lockDir,
        ownerPath,
        nonce: myNonce,
      };
      if (
        Date.now() - myCreatedAtMs < Math.floor(effectiveStaleMs / 2) &&
        verifyLockOwnership(handle)
      ) {
        return handle;
      }
      releaseLock(handle);
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }
    }

    const now = Date.now();
    const info = inspectOwnerFile(ownerPath, now, effectiveStaleMs, allowLivePidExpiry);
    let candidateStale = false;
    let candidateUnownedKey = null;

    if (info.valid) {
      observedUnownedAtMs.clear();
      candidateStale = info.stale;
    } else if (info.missing) {
      try {
        const dirSt = fs.lstatSync(lockDir);
        const dirKey = `missing:${dirSt.ino || 0}:${dirSt.ctimeMs || dirSt.mtimeMs || 0}`;
        candidateUnownedKey = dirKey;
        const firstSeen = observedUnownedAtMs.get(dirKey);
        if (firstSeen === undefined) {
          observedUnownedAtMs.set(dirKey, now);
        } else if (now - firstSeen >= MISSING_OWNER_STALE_MS) {
          candidateStale = true;
        }
      } catch {
        // Lock directory disappeared concurrently
      }
    } else {
      const invKey = `invalid:${info.raw ?? ""}`;
      candidateUnownedKey = invKey;
      const firstSeen = observedUnownedAtMs.get(invKey);
      if (firstSeen === undefined) {
        observedUnownedAtMs.set(invKey, now);
      } else if (now - firstSeen >= MISSING_OWNER_STALE_MS || info.stale) {
        candidateStale = true;
      }
    }

    if (candidateStale) {
      if (info.missing) {
        try {
          fs.rmdirSync(lockDir);
          observedUnownedAtMs.clear();
          continue;
        } catch {
          // Directory is non-empty (e.g. an owner or .tmp file was just created); fall through
        }
      } else {
        const stageDir = path.join(
          lockDir,
          `.break.${process.pid}.${randomNonce()}`,
        );
        let stagedDirCreated = false;
        try {
          fs.mkdirSync(stageDir, { mode: 0o700 });
          stagedDirCreated = true;
          const stagedOwnerPath = path.join(stageDir, "owner.json");
          fs.linkSync(ownerPath, stagedOwnerPath);
          const verifyInfo = inspectOwnerFile(
            stagedOwnerPath,
            Date.now(),
            effectiveStaleMs,
            allowLivePidExpiry,
          );
          const verifiedStale = info.valid
            ? verifyInfo.valid && verifyInfo.stale && verifyInfo.nonce === info.nonce
            : !verifyInfo.valid &&
              !verifyInfo.missing &&
              `invalid:${verifyInfo.raw ?? ""}` === candidateUnownedKey;

          if (verifiedStale) {
            const staleDir = path.join(
              stateDir,
              `${lockName}.stale.${process.pid}.${randomNonce()}`,
            );
            fs.renameSync(lockDir, staleDir);
            observedUnownedAtMs.clear();
            try {
              fs.rmSync(staleDir, { recursive: true, force: true });
            } catch {
              // Swept later by orphan sweep
            }
            continue;
          }
          try {
            fs.unlinkSync(stagedOwnerPath);
          } catch {
            // Ignore cleanup failure
          }
        } catch {
          // Another process broke or updated the lock
        } finally {
          if (stagedDirCreated) {
            try {
              fs.rmSync(stageDir, { recursive: true, force: true });
            } catch {
              // Ignore if parent lockDir was renamed and removed
            }
          }
        }
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
  if (!lockHandle || !lockHandle.ownerPath) return;
  if (!verifyLockOwnership(lockHandle)) {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.unlinkSync(lockHandle.ownerPath);
      break;
    } catch (err) {
      if (err && err.code === "ENOENT") break;
      if (attempt === 4) {
        try {
          fs.writeFileSync(lockHandle.ownerPath, "{}", "utf8");
        } catch {
          // Best-effort invalidation
        }
      } else {
        sleepSync(10);
      }
    }
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
        return;
      }
      break;
    }
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
