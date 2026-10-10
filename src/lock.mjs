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

function inspectOwnerFile(ownerPath, now, fallbackStaleMs = STALE_LOCK_MS) {
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
      const stale = !isPidAlive(owner.pid) || now - owner.createdAtMs > ownerStaleMs;
      return { valid: true, stale, nonce: owner.nonce };
    }
    return { valid: false, raw };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { valid: false, raw: null };
    }
    try {
      return { valid: false, raw: fs.readFileSync(ownerPath, "utf8") };
    } catch {
      return { valid: false, raw: null };
    }
  }
}

function withGateLock(breakLockDir, fn, maxWaitMs = 2_000) {
  const breakOwnerPath = path.join(breakLockDir, "owner.json");
  const startMs = Date.now();
  while (true) {
    let acquired = false;
    try {
      fs.mkdirSync(breakLockDir, { mode: 0o700 });
      acquired = true;
      writeFileAtomic(
        breakOwnerPath,
        JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
      );
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        if (acquired) {
          try {
            fs.rmSync(breakLockDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup failure
          }
        }
        throw err;
      }
    }

    if (acquired) {
      try {
        return fn();
      } finally {
        try {
          fs.rmSync(breakLockDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup of gate lock
        }
      }
    }

    try {
      const bst = fs.lstatSync(breakLockDir);
      const now = Date.now();
      let breakStale = now - (bst.mtimeMs || bst.ctimeMs || 0) > MISSING_OWNER_STALE_MS;
      if (fs.existsSync(breakOwnerPath)) {
        try {
          const bOwner = JSON.parse(fs.readFileSync(breakOwnerPath, "utf8"));
          breakStale =
            !bOwner ||
            typeof bOwner.createdAtMs !== "number" ||
            !isPidAlive(bOwner.pid) ||
            now - bOwner.createdAtMs > STALE_LOCK_MS;
        } catch {
          // Malformed break owner file: use mtime/ctime fallback above
        }
      }
      if (breakStale) {
        const staleBreak = `${breakLockDir}.stale.${process.pid}.${randomNonce()}`;
        fs.renameSync(breakLockDir, staleBreak);
        fs.rmSync(staleBreak, { recursive: true, force: true });
        continue;
      }
    } catch {
      // Ignore concurrent breakLockDir release/cleanup
    }

    if (Date.now() - startMs >= maxWaitMs) {
      throw new Error(`Timed out waiting ${maxWaitMs}ms for lock gate ${breakLockDir}`);
    }
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
}

export function acquireLock(
  stateDir,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockName = "atc.lock",
  staleLockMs = STALE_LOCK_MS,
) {
  ensureSafeDirectory(stateDir);
  const lockDir = path.join(stateDir, lockName);
  const ownerPath = path.join(lockDir, "owner.json");
  const breakLockDir = path.join(stateDir, `${lockName}.break`);
  const effectiveStaleMs =
    typeof staleLockMs === "number" && Number.isFinite(staleLockMs) && staleLockMs > 0
      ? Math.max(STALE_LOCK_MS, staleLockMs)
      : STALE_LOCK_MS;
  const startMs = Date.now();
  let firstInvalidOwnerAtMs = null;
  let firstInvalidOwnerKey = null;

  while (true) {
    if (!fs.existsSync(lockDir)) {
      const myNonce = randomNonce();
      let acquiredHandle = null;
      try {
        const remainingMs = Math.max(100, timeoutMs - (Date.now() - startMs));
        acquiredHandle = withGateLock(
          breakLockDir,
          () => {
            fs.mkdirSync(lockDir, { mode: 0o700 });
            const ownerPayload = JSON.stringify({
              pid: process.pid,
              createdAtMs: Date.now(),
              staleAfterMs: effectiveStaleMs,
              nonce: myNonce,
            });
            writeFileAtomic(ownerPath, ownerPayload, myNonce);
            return {
              lockDir,
              ownerPath,
              breakLockDir,
              nonce: myNonce,
            };
          },
          Math.min(2_000, remainingMs),
        );
      } catch (err) {
        if (!err || (err.code !== "EEXIST" && !String(err.message || "").includes("lock gate"))) {
          throw err;
        }
      }
      if (acquiredHandle) {
        return acquiredHandle;
      }
    }

    // Lock exists; inspect owner.json for staleness
    const now = Date.now();
    let isStale = false;
    let observedNonce = null;
    let observedInvalidKey = null;
    const ownerInfo = inspectOwnerFile(ownerPath, now, effectiveStaleMs);
    if (ownerInfo.valid) {
      firstInvalidOwnerAtMs = null;
      firstInvalidOwnerKey = null;
      if (ownerInfo.stale) {
        isStale = true;
        observedNonce = ownerInfo.nonce;
      }
    } else {
      try {
        const st = fs.lstatSync(lockDir);
        const dirKey = `${st.ino || 0}:${st.birthtimeMs || st.ctimeMs || 0}:${ownerInfo.raw ?? "<missing>"}`;
        if (firstInvalidOwnerKey !== dirKey || firstInvalidOwnerAtMs === null) {
          firstInvalidOwnerKey = dirKey;
          firstInvalidOwnerAtMs = now;
        } else if (now - firstInvalidOwnerAtMs >= MISSING_OWNER_STALE_MS) {
          isStale = true;
          observedInvalidKey = dirKey;
        }
      } catch {
        firstInvalidOwnerAtMs = null;
        firstInvalidOwnerKey = null;
      }
    }

    if (isStale) {
      let brokeStale = false;
      let staleDirToClean = null;
      try {
        const remainingMs = Math.max(100, timeoutMs - (Date.now() - startMs));
        withGateLock(
          breakLockDir,
          () => {
            let stillSameStale = false;
            if (observedNonce !== null) {
              const info2 = inspectOwnerFile(ownerPath, Date.now(), effectiveStaleMs);
              if (info2.valid && info2.stale && info2.nonce === observedNonce) {
                stillSameStale = true;
              }
            } else if (observedInvalidKey !== null) {
              try {
                const st2 = fs.lstatSync(lockDir);
                const info2 = inspectOwnerFile(ownerPath, Date.now(), effectiveStaleMs);
                const dirKey2 = `${st2.ino || 0}:${st2.birthtimeMs || st2.ctimeMs || 0}:${info2.raw ?? "<missing>"}`;
                if (!info2.valid && dirKey2 === observedInvalidKey) {
                  stillSameStale = true;
                }
              } catch {
                // lockDir disappeared; do not rename
              }
            }

            if (stillSameStale) {
              const staleDir = path.join(
                stateDir,
                `${lockName}.stale.${process.pid}.${randomNonce()}`,
              );
              fs.renameSync(lockDir, staleDir);
              staleDirToClean = staleDir;
              brokeStale = true;
            }
          },
          Math.min(2_000, remainingMs),
        );
      } catch {
        // Another waiter handled it; fall through to retry/backoff
      }
      if (staleDirToClean) {
        try {
          fs.rmSync(staleDirToClean, { recursive: true, force: true });
        } catch {
          // Swept later by orphan sweep
        }
      }
      if (brokeStale) {
        firstInvalidOwnerAtMs = null;
        firstInvalidOwnerKey = null;
        continue;
      }
    }

    if (Date.now() - startMs >= timeoutMs) {
      throw new Error(`Timed out waiting ${timeoutMs}ms to acquire ${lockDir}`);
    }

    sleepSync(20 + Math.floor(Math.random() * 40));
  }
}

export function verifyLockOwnership(lockHandle) {
  try {
    const raw = fs.readFileSync(lockHandle.ownerPath, "utf8");
    const owner = JSON.parse(raw);
    return Boolean(owner && owner.nonce === lockHandle.nonce);
  } catch {
    return false;
  }
}

export function releaseLock(lockHandle) {
  if (!lockHandle) return;
  const breakLockDir = lockHandle.breakLockDir || `${lockHandle.lockDir}.break`;
  const doRelease = () => {
    if (!verifyLockOwnership(lockHandle)) {
      return;
    }
    try {
      fs.unlinkSync(lockHandle.ownerPath);
    } catch {
      // Ignore if already unlinked
    }
    try {
      fs.rmdirSync(lockHandle.lockDir);
    } catch (err) {
      if (
        process.platform === "win32" &&
        err &&
        (err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOTEMPTY")
      ) {
        return;
      }
    }
  };
  try {
    withGateLock(breakLockDir, doRelease, 2_000);
  } catch {
    doRelease();
  }
}

export function withLock(
  stateDir,
  fn,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockName = "atc.lock",
  staleLockMs = STALE_LOCK_MS,
) {
  const handle = acquireLock(stateDir, timeoutMs, lockName, staleLockMs);
  try {
    return fn(handle);
  } finally {
    releaseLock(handle);
  }
}
