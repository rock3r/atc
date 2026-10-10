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

export function acquireLock(
  stateDir,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockName = "atc.lock",
) {
  ensureSafeDirectory(stateDir);
  const lockDir = path.join(stateDir, lockName);
  const ownerPath = path.join(lockDir, "owner.json");
  const breakLockDir = path.join(stateDir, `${lockName}.break`);
  const startMs = Date.now();
  let firstMissingOwnerAtMs = null;
  let firstMissingOwnerKey = null;

  while (true) {
    const myNonce = randomNonce();
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const ownerPayload = JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
        nonce: myNonce,
      });
      writeFileAtomic(ownerPath, ownerPayload, myNonce);
      return {
        lockDir,
        ownerPath,
        nonce: myNonce,
      };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }
    }

    // Lock exists; inspect owner.json for staleness
    const now = Date.now();
    let isStale = false;
    let observedNonce = null;
    let observedMissingKey = null;
    try {
      const raw = fs.readFileSync(ownerPath, "utf8");
      const owner = JSON.parse(raw);
      firstMissingOwnerAtMs = null;
      firstMissingOwnerKey = null;
      if (
        !owner ||
        typeof owner.createdAtMs !== "number" ||
        now - owner.createdAtMs > STALE_LOCK_MS ||
        !isPidAlive(owner.pid)
      ) {
        isStale = true;
        observedNonce = owner && typeof owner.nonce === "string" ? owner.nonce : "";
      }
    } catch {
      try {
        const st = fs.lstatSync(lockDir);
        const dirKey = `${st.ino || 0}:${st.birthtimeMs || st.ctimeMs || 0}`;
        if (firstMissingOwnerKey !== dirKey || firstMissingOwnerAtMs === null) {
          firstMissingOwnerKey = dirKey;
          firstMissingOwnerAtMs = now;
        } else if (now - firstMissingOwnerAtMs >= MISSING_OWNER_STALE_MS) {
          isStale = true;
          observedMissingKey = dirKey;
        }
      } catch {
        firstMissingOwnerAtMs = null;
        firstMissingOwnerKey = null;
      }
    }

    if (isStale) {
      const breakOwnerPath = path.join(breakLockDir, "owner.json");
      let acquiredBreakLock = false;
      try {
        fs.mkdirSync(breakLockDir, { mode: 0o700 });
        acquiredBreakLock = true;
        writeFileAtomic(
          breakOwnerPath,
          JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
        );
      } catch {
        try {
          const bst = fs.lstatSync(breakLockDir);
          let breakStale =
            Date.now() - (bst.mtimeMs || bst.ctimeMs || 0) > MISSING_OWNER_STALE_MS;
          if (fs.existsSync(breakOwnerPath)) {
            const bOwner = JSON.parse(fs.readFileSync(breakOwnerPath, "utf8"));
            breakStale =
              !bOwner ||
              !isPidAlive(bOwner.pid) ||
              Date.now() - (bOwner.createdAtMs || 0) > STALE_LOCK_MS;
          }
          if (breakStale) {
            const staleBreak = `${breakLockDir}.stale.${process.pid}.${randomNonce()}`;
            fs.renameSync(breakLockDir, staleBreak);
            fs.rmSync(staleBreak, { recursive: true, force: true });
          }
        } catch {
          // Ignore concurrent breakLockDir cleanup
        }
      }

      if (acquiredBreakLock) {
        try {
          let stillSameStale = false;
          if (observedNonce !== null) {
            try {
              const raw2 = fs.readFileSync(ownerPath, "utf8");
              const owner2 = JSON.parse(raw2);
              const now2 = Date.now();
              const nonce2 = owner2 && typeof owner2.nonce === "string" ? owner2.nonce : "";
              if (
                nonce2 === observedNonce &&
                (!owner2 ||
                  typeof owner2.createdAtMs !== "number" ||
                  now2 - owner2.createdAtMs > STALE_LOCK_MS ||
                  !isPidAlive(owner2.pid))
              ) {
                stillSameStale = true;
              }
            } catch {
              // owner.json disappeared during normal release; do not rename
            }
          } else if (observedMissingKey !== null) {
            try {
              const st2 = fs.lstatSync(lockDir);
              const dirKey2 = `${st2.ino || 0}:${st2.birthtimeMs || st2.ctimeMs || 0}`;
              if (dirKey2 === observedMissingKey && !fs.existsSync(ownerPath)) {
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
            firstMissingOwnerAtMs = null;
            firstMissingOwnerKey = null;
            try {
              fs.rmSync(staleDir, { recursive: true, force: true });
            } catch {
              // Swept later by orphan sweep
            }
            continue;
          }
        } catch {
          // Another waiter released it; fall through to backoff
        } finally {
          try {
            fs.rmSync(breakLockDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup of breakLockDir
          }
        }
      }
    }

    if (now - startMs >= timeoutMs) {
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
}

export function withLock(
  stateDir,
  fn,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockName = "atc.lock",
) {
  const handle = acquireLock(stateDir, timeoutMs, lockName);
  try {
    return fn(handle);
  } finally {
    releaseLock(handle);
  }
}
