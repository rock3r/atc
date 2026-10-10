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

function sweepStaleLockClaims(stateDir, lockName, now = Date.now()) {
  const prefix = `${lockName}.stale.`;
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(prefix)) continue;
      const fullPath = path.join(stateDir, name);
      try {
        const st = fs.lstatSync(fullPath);
        if (
          now - (st.mtimeMs || st.ctimeMs || 0) > 60_000 &&
          (!st.isDirectory() || canSweepBreakClaimDir(fullPath, now))
        ) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore concurrent deletion
      }
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
    return { done: false, active: true };
  }
  for (const name of entries) {
    if (name === "done" || name.startsWith("moved.")) {
      return { done: true, active: false };
    }
  }
  let hasActive = false;
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
        }
      } catch {
        // Ignore concurrent removal
      }
    }
  }
  return { done: false, active: hasActive };
}

function tryWithBreakClaim(stateDir, lockName, candidateBreakToken, fn) {
  if (!candidateBreakToken) return false;
  const claimDir = path.join(stateDir, `${lockName}.stale.${candidateBreakToken}`);
  try {
    fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }

  const initialState = inspectAndCleanBreakClaimDir(claimDir, Date.now());
  if (initialState.done || initialState.active) {
    return false;
  }

  const myClaimNonce = randomNonce();
  const myClaimStartMs = Date.now();
  const myBreakerName = `breaker.${myClaimNonce}.json`;
  const myBreakerPath = path.join(claimDir, myBreakerName);
  try {
    writeFileAtomic(
      myBreakerPath,
      JSON.stringify({
        pid: process.pid,
        createdAtMs: myClaimStartMs,
        nonce: myClaimNonce,
      }),
      myClaimNonce,
    );
    const verifyEntries = fs.readdirSync(claimDir);
    if (
      verifyEntries.some((n) => n === "done" || n.startsWith("moved.")) ||
      verifyEntries.some((n) => n !== myBreakerName)
    ) {
      return false;
    }

    const canProceed = () => {
      try {
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

    const completed = Boolean(fn({ claimDir, myClaimNonce, canProceed }));
    if (completed) {
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
  });
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
