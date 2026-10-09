import { Worker } from "node:worker_threads";
import {
  ResourceError,
  checkResourceAdmission,
  deterministicCreatedAvdId,
  discoverFleet,
  parseAdbDevicesOutput,
  readFreeDiskMb,
  readHostResources,
  readLocalAvdMetadata,
  resolveAvdHome,
  wipeAvdUserData,
} from "./android.mjs";
import { classifySegment, evaluateCommandGuard, splitShellSegments } from "./guard.mjs";
import { handlePreToolUseHook, handleStopHook, readStdinSync } from "./hook.mjs";
import { randomNonce, resolveStateDir, sleepSync } from "./lock.mjs";
import { startMcpServer } from "./mcp.mjs";
import { buildChildInvocation, runCommandSync, spawnWithHeartbeat } from "./spawn.mjs";
import {
  DEFAULT_CONFIG,
  canJumpAhead,
  computeEffectiveMaxEmulators,
  computeUsedEmulatorSlots,
  isTicketStarvationProtected,
  matchesProfile,
  readState,
  reconcileOfflineLeases,
  resolveSessionIdentity,
  withStateTransaction,
} from "./state.mjs";

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
      flags[key] = tok.slice(eqIdx + 1);
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

function clampTtlSec(rawTtl, cfg = DEFAULT_CONFIG) {
  const def = cfg.defaultTtlSec ?? 600;
  const max = cfg.maxTtlSec ?? 3600;
  const n = rawTtl !== undefined ? Number(rawTtl) : def;
  if (!Number.isFinite(n)) return def;
  return Math.max(10, Math.min(max, Math.round(n)));
}

function startWorkerDeadlineHeartbeat(stateDir, deviceKey, leaseId, timeoutMs) {
  const workerUrl = new URL("./heartbeat.mjs", import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: {
      stateDir,
      deviceKey,
      leaseId,
      timeoutMs,
      workerPid: process.pid,
    },
  });
  worker.on("error", () => {});
  if (typeof worker.unref === "function") {
    worker.unref();
  }
  return {
    stop() {
      try {
        worker.terminate();
      } catch {
        // Ignore termination error
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

export function selectCandidateUnderLock(state, inventory, req, callerTicket, now = Date.now()) {
  const cfg = state.config || DEFAULT_CONFIG;
  const effectiveMax = computeEffectiveMaxEmulators(cfg, inventory.host);
  const usedSlots = computeUsedEmulatorSlots(state, inventory);
  const leasedSerials = new Set(
    Object.values(state.leases || {})
      .map((l) => l.serial)
      .filter(Boolean),
  );
  const isDeviceOccupied = (d) =>
    Boolean(state.leases[d.deviceKey] || (d.serial && leasedSerials.has(d.serial)));

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
    const effectiveReq = {
      ...targetReq,
      apiSpec: p.apiLevel ? targetReq.apiSpec : null,
      services: p.services ? targetReq.services : null,
      play: typeof p.playStore === "boolean" || p.services ? targetReq.play : null,
      abi: p.abi ? targetReq.abi : null,
      snapshotLoad: null,
    };
    return matchesProfile(
      { kind: "emulator", avd: targetReq.avd || c.avd || profileName, profile: p },
      effectiveReq,
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
    const warmCandidates = (inventory.running || []).filter(
      (d) => !isDeviceOccupied(d) && matchesProfile(d, req),
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
  // If any running emulator could not be mapped to its AVD name, fail closed on offline AVD launches
  // so ATC never attempts to cold-boot an AVD that is already running under an unmapped serial.
  const hasUnmappedRunningEmulator = (inventory.running || []).some(
    (d) => d.kind === "emulator" && !d.avd,
  );
  const bootPool = [
    ...(req.wipeData || req.coldBoot
      ? (inventory.running || []).filter((d) => d.kind === "emulator" && d.avd)
      : []),
    ...(hasUnmappedRunningEmulator ? [] : inventory.offline || []),
  ].filter((d) => !isDeviceOccupied(d) && matchesProfile(d, req));

  let firstResourceErr = null;

  for (const dev of bootPool) {
    const slotAvailable = dev.online || usedSlots < effectiveMax;
    if (!slotAvailable) continue;
    if (isReservedForEarlierTicket(dev, true)) continue;
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
  const runner = options.runner || runCommandSync;
  const req = {
    kind: flags.kind || (flags.serial && !String(flags.serial).startsWith("emulator-") ? "any" : "emulator"),
    avd: flags.avd || null,
    serial: flags.serial || null,
    deviceType: flags.type || null,
    apiSpec: flags.api ? String(flags.api) : null,
    services: flags.services || null,
    play: typeof flags.play === "boolean" ? flags.play : null,
    abi: flags.abi || null,
    createIfMissing: Boolean(flags.createIfMissing),
    snapshotLoad: flags.snapshotLoad || null,
    snapshotSaveOnFree: flags.snapshotSaveOnFree || null,
    wipeData: Boolean(flags.wipeData),
    coldBoot: Boolean(flags.cold),
    resetApp: flags.resetApp || null,
    headless: Boolean(flags.headless),
    force: Boolean(flags.force),
    reason: flags.reason || null,
  };

  if (flags.wait !== undefined) {
    const parsedWait = Number(flags.wait);
    if (!Number.isFinite(parsedWait) || parsedWait < 0) {
      return {
        exitCode: 1,
        error: `Invalid --wait duration "${flags.wait}". Expected a non-negative number of seconds.`,
      };
    }
  }
  if (flags.reorderWindow !== undefined) {
    const rw = Number(flags.reorderWindow);
    if (!Number.isFinite(rw) || rw < 0) {
      return {
        exitCode: 1,
        error: `Invalid --reorder-window duration "${flags.reorderWindow}". Expected a non-negative number of seconds.`,
      };
    }
  }
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);
  const initialCfg = readState(stateDir).config || DEFAULT_CONFIG;
  let inventory = options.inventory || discoverFleet({ runner, avdHome, cfg: initialCfg });
  const startWaitMs = Date.now();
  let retainedTicketTiming = null;

  while (true) {
    let txOutcome;
    try {
      txOutcome = withStateTransaction(stateDir, (state, { now }) => {
        const waitSec =
          flags.wait !== undefined
            ? Number(flags.wait)
            : (state.config?.defaultWaitSec ?? DEFAULT_CONFIG.defaultWaitSec);
        const identity = resolveSessionIdentity({
          flags,
          env: options.env || process.env,
          state,
          cwd: options.cwd || process.cwd(),
          ppid: options.ppid ?? process.ppid,
        });
        const ttlSec = clampTtlSec(flags.ttl, state.config);
        const ttlMs = ttlSec * 1000;

        reconcileOfflineLeases(state, inventory, identity.sessionId, now);

        // Step 3: Idempotent Re-Claim (Same Session)
        for (const lease of Object.values(state.leases)) {
          if (
            lease.state === "active" &&
            lease.sessionId === identity.sessionId &&
            matchesProfile(lease, req) &&
            !req.wipeData &&
            !req.coldBoot &&
            (!req.snapshotLoad || lease.loadedSnapshot === req.snapshotLoad)
          ) {
            lease.renewedAtMs = now;
            lease.expiresAtMs = now + ttlMs;
            if (req.snapshotSaveOnFree) {
              lease.saveSnapshotOnFree = req.snapshotSaveOnFree;
            }
            if (req.reason) {
              lease.reason = req.reason;
            }
            return {
              mutated: true,
              value: { status: "claimed_immediate", lease, idempotent: true },
            };
          }
        }

        const existingTicket = state.queue.find((t) => t.sessionId === identity.sessionId) || null;
        const selection = selectCandidateUnderLock(state, inventory, req, existingTicket, now);

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
            parentPid: options.ppid ?? process.ppid,
            state: "active",
            workerPid: null,
            replacingAvd: null,
            requiredRamMb: dev.requiredRamMb || 0,
            loadedSnapshot: req.snapshotLoad || null,
            saveSnapshotOnFree: req.snapshotSaveOnFree || null,
            claimedAtMs: now,
            activatedAtMs: now,
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
          const leaseId = `lease_${randomNonce().slice(0, 12)}`;
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
            parentPid: options.ppid ?? process.ppid,
            state: "starting",
            workerPid: process.pid,
            replacingAvd: selection.victim ? selection.victim.avd : null,
            requiredRamMb: computeRequiredRam(dev),
            loadedSnapshot: req.snapshotLoad || null,
            saveSnapshotOnFree: req.snapshotSaveOnFree || null,
            claimedAtMs: now,
            activatedAtMs: null,
            renewedAtMs: now,
            expiresAtMs: now + ttlMs,
            deadlineMs: now + bootTimeoutMs,
            firstSeenOfflineAtMs: null,
            reason: req.reason,
          };
          state.leases[dev.deviceKey] = startingLease;
          state.queue = state.queue.filter((t) => t.sessionId !== identity.sessionId);

          const knownAvdNames = new Set(
            [...(inventory.running || []), ...(inventory.offline || [])]
              .filter((d) => d.kind === "emulator" && d.avd)
              .map((d) => d.avd),
          );

          return {
            mutated: true,
            value: {
              status: "needs_boot_or_prep",
              lease: startingLease,
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
            mutated: false,
            value: { status: "busy" },
          };
        }

        const reorderWindowMs =
          (flags.reorderWindow !== undefined
            ? Number(flags.reorderWindow)
            : (state.config?.reorderWindowSec ?? DEFAULT_CONFIG.reorderWindowSec ?? 120)) * 1000;
        const waitExpiresAtMs = startWaitMs + waitSec * 1000;
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
          ticket = {
            ticketId: `q_${randomNonce().slice(0, 12)}`,
            sessionId: identity.sessionId,
            waiterPid: process.pid,
            requestedKind: req.kind,
            requestedAvd: req.avd,
            requestedSerial: req.serial,
            requestedProfile: req,
            enqueuedAtMs,
            starvationDeadlineMs,
            lastHeartbeatAtMs: now,
            waitExpiresAtMs,
            reason: req.reason,
          };
          retainedTicketTiming = { enqueuedAtMs, starvationDeadlineMs };
          state.queue.push(ticket);
        } else {
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

    if (txOutcome.status === "claimed_immediate") {
      if (txOutcome.idempotent && req.resetApp && txOutcome.lease?.serial) {
        const resetRes = runner(
          "adb",
          ["-s", txOutcome.lease.serial, "shell", "pm", "clear", req.resetApp],
          { strictInternal: true },
        );
        if (resetRes.status !== 0) {
          return {
            exitCode: 1,
            error: `Failed to reset app "${req.resetApp}" on ${txOutcome.lease.serial}: ${resetRes.stderr || resetRes.stdout}`,
          };
        }
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
        const curCfg = readState(stateDir).config || DEFAULT_CONFIG;
        inventory = options.inventory || discoverFleet({ runner, avdHome, cfg: curCfg });
        break;
      }
    }
  }
}

function executeBootOrPrepOutsideLock(stateDir, txOutcome, req, { runner, avdHome, platform }) {
  const {
    lease,
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

  const isWin = (platform || process.platform) === "win32";

  try {
    // 1. Evict victim if replacingAvd is set
    if (selection.victim) {
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
      victimHbTimer?.stop();
      if (stopRes.status !== 0) {
        throw new Error(
          `Failed to stop idle victim emulator ${selection.victim.avd}: ${stopRes.stderr || stopRes.stdout}`,
        );
      }
      withStateTransaction(stateDir, (state) => {
        const vLease = state.leases[selection.victim.deviceKey];
        if (vLease && vLease.leaseId === victimLeaseId) {
          delete state.leases[selection.victim.deviceKey];
          return { mutated: true };
        }
        return { mutated: false };
      });
    }

    // 2. Auto-create missing AVD if Priority 4
    if (selection.createAvd) {
      const createRes = runner(
        "android",
        ["emulator", "create", candidate.profile.deviceName],
        { strictInternal: true },
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
      const reqWithoutAvd = { ...req, avd: null };
      const newlyCreated =
        allPostAvds.find((d) => !knownAvdNames?.has(d.avd) && matchesProfile(d, reqWithoutAvd)) ||
        allPostAvds.find((d) => !knownAvdNames?.has(d.avd));

      let createdAvdName = newlyCreated?.avd || null;
      if (!createdAvdName && createRes.stdout) {
        const m =
          createRes.stdout.match(/Created AVD\s+['"]?([A-Za-z0-9._-]+)['"]?/i) ||
          createRes.stdout.trim().match(/^([A-Za-z0-9._-]+)$/);
        if (m) {
          createdAvdName = m[1];
        }
      }
      createdAvdName = createdAvdName || candidate.avd;

      if (
        newlyCreated &&
        newlyCreated.profile?.apiLevel &&
        newlyCreated.profile.apiLevel !== "unknown" &&
        !matchesProfile(newlyCreated, { ...reqWithoutAvd, snapshotLoad: null })
      ) {
        try {
          runner("android", ["emulator", "remove", newlyCreated.avd], { strictInternal: true });
        } catch {
          // Best-effort cleanup of mismatched created AVD
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
        withStateTransaction(stateDir, (state) => {
          const current = state.leases[oldKey];
          if (current && current.leaseId === lease.leaseId) {
            if (oldKey !== newKey) {
              delete state.leases[oldKey];
            }
            current.deviceKey = newKey;
            current.avd = createdAvdName;
            if (newlyCreated?.profile) {
              current.profile = newlyCreated.profile;
            }
            state.leases[newKey] = current;
            return { mutated: true };
          }
          return { mutated: false };
        });
        candidate.avd = createdAvdName;
        candidate.deviceKey = newKey;
        if (newlyCreated?.profile) {
          candidate.profile = newlyCreated.profile;
        }
        lease.avd = createdAvdName;
        lease.deviceKey = newKey;
      }
    }

    // 3. Warm state preparation vs Cold/Wipe boot
    if (selection.priority === 1 && selection.needsWarmPrep) {
      if (req.snapshotLoad) {
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
        waitForEmulatorReady(runner, resolvedSerial, bootTimeoutMs);
      }
      if (req.resetApp) {
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
        const rebootStopRes =
          isWin && candidate.serial
            ? runner("adb", ["-s", candidate.serial, "emu", "kill"], { strictInternal: true })
            : runner(
                "android",
                ["emulator", "stop", candidate.serial || candidate.avd],
                { strictInternal: true },
              );
        if (rebootStopRes.status !== 0) {
          throw new Error(
            `Failed to stop emulator ${candidate.avd} before reboot: ${rebootStopRes.stderr || rebootStopRes.stdout}`,
          );
        }
      }
      if (req.wipeData) {
        wipeAvdUserData(candidate.avd, avdHome);
      }
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
      if (bootRes.status !== 0) {
        throw new Error(
          `Failed to boot emulator ${candidate.avd}: ${bootRes.stderr || bootRes.stdout}`,
        );
      }
      bootedNewEmulator = true;

      const serialMatch = (bootRes.stdout || "").match(/\b(emulator-\d+)\b/);
      resolvedSerial = serialMatch ? serialMatch[1] : resolvedSerial;
      const pollDeadline = Date.now() + bootTimeoutMs;
      while (!resolvedSerial) {
        const refreshed = discoverFleet({ runner, avdHome });
        const booted = (refreshed.running || []).find(
          (d) => d.kind === "emulator" && d.avd === candidate.avd && d.serial,
        );
        resolvedSerial = booted?.serial || null;
        if (resolvedSerial || !isWin || Date.now() >= pollDeadline) break;
        sleepSync(500);
      }
      if (!resolvedSerial) {
        throw new Error(
          `Booted emulator ${candidate.avd} did not report an adb serial and could not be discovered.`,
        );
      }
      if (isWin) {
        waitForEmulatorReady(runner, resolvedSerial, bootTimeoutMs);
      }

      if (req.snapshotLoad) {
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
        waitForEmulatorReady(runner, resolvedSerial, bootTimeoutMs);
      }

      if (req.resetApp) {
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

    // 4. Activate lease under atc.lock
    const activeLease = withStateTransaction(stateDir, (state, { now }) => {
      const current = state.leases[lease.deviceKey];
      if (!current || current.leaseId !== lease.leaseId) {
        throw new Error(`Lease reservation ${lease.leaseId} was lost during boot`);
      }
      current.state = "active";
      current.workerPid = null;
      current.replacingAvd = null;
      current.serial = resolvedSerial;
      current.activatedAtMs = now;
      current.renewedAtMs = now;
      current.expiresAtMs = now + ttlMs;
      current.deadlineMs = null;
      return { mutated: true, value: current };
    });

    return { exitCode: 0, lease: activeLease, idempotent: false };
  } catch (err) {
    hbTimer.stop();
    victimHbTimer?.stop();
    if (bootedNewEmulator) {
      try {
        if (isWin) {
          let cleanupSerial = resolvedSerial;
          if (!cleanupSerial) {
            const refreshed = discoverFleet({ runner, avdHome });
            const booted = (refreshed.running || []).find(
              (d) => d.kind === "emulator" && d.avd === candidate.avd && d.serial,
            );
            cleanupSerial = booted?.serial || null;
          }
          if (cleanupSerial) {
            runner("adb", ["-s", cleanupSerial, "emu", "kill"], { strictInternal: true });
          }
        } else {
          runner("android", ["emulator", "stop", resolvedSerial || candidate.avd], {
            strictInternal: true,
          });
        }
      } catch {
        // Best-effort cleanup of newly booted emulator
      }
    }
    withStateTransaction(stateDir, (state) => {
      const current = state.leases[lease.deviceKey];
      if (current && current.leaseId === lease.leaseId) {
        delete state.leases[lease.deviceKey];
      }
      if (selection.victim) {
        const vCurrent = state.leases[selection.victim.deviceKey];
        if (vCurrent && vCurrent.leaseId === victimLeaseId) {
          delete state.leases[selection.victim.deviceKey];
        }
      }
      return { mutated: true };
    });
    return { exitCode: 1, error: err.message };
  }
}

export function cmdFree(stateDir, target = null, flags = {}, options = {}) {
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);

  // Pre-lock disk check (pure statfs, never spawns subprocesses under atc.lock)
  const freeDiskMb =
    options.host?.freeDiskMb ?? (!flags.force ? readFreeDiskMb(avdHome) : 16384);

  let outcome;
  try {
    outcome = withStateTransaction(stateDir, (state, { now }) => {
      const identity = resolveSessionIdentity({
        flags,
        env: options.env || process.env,
        state,
        cwd: options.cwd || process.cwd(),
        ppid: options.ppid ?? process.ppid,
      });

      const matches = [];
      const leasesList = Object.values(state.leases);
      if (target) {
        const byId = leasesList.find((l) => l.leaseId === target);
        const bySerial = !byId && leasesList.find((l) => l.serial === target);
        const byAvd = !byId && !bySerial && leasesList.find((l) => l.avd === target);
        const found = byId || bySerial || byAvd;
        if (!found) {
          return { mutated: false, value: { status: "not_found", freed: [] } };
        }
        const isOwner =
          found.sessionId === identity.sessionId ||
          found.leaseId === target ||
          Boolean(flags.force);
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
          if (l.sessionId === identity.sessionId && l.state === "active") {
            matches.push(l);
          }
        }
      }

      if (matches.length === 0) {
        return { mutated: false, value: { status: "empty", freed: [] } };
      }

      const stoppingQueue = [];
      const freedImmediate = [];
      const stopTimeoutMs = (state.config.stopTimeoutSec || 60) * 1000;
      let cumulativeSnapshotMb = 0;

      for (const lease of matches) {
        const saveSnap = flags.snapshotSave || lease.saveSnapshotOnFree || null;
        const loadSnap = flags.snapshotLoad || null;
        const doStop = Boolean(flags.stop || flags.shutdown) && lease.kind === "emulator";

        if (saveSnap && !flags.force && lease.kind === "emulator") {
          const meta = readLocalAvdMetadata(lease.avd, avdHome, state.config);
          cumulativeSnapshotMb += meta.ramSizeMb;
          if (freeDiskMb < cumulativeSnapshotMb + (state.config.minFreeDiskMb ?? 2048)) {
            throw new ResourceError(
              5,
              `Insufficient disk space to save snapshot "${saveSnap}" on ${lease.avd}: needs ${cumulativeSnapshotMb + (state.config.minFreeDiskMb ?? 2048)}MB free.`,
            );
          }
        }

        if ((saveSnap || loadSnap || doStop) && lease.kind === "emulator") {
          lease.state = "stopping";
          lease.workerPid = process.pid;
          lease.deadlineMs = now + stopTimeoutMs;
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
          status: "ok",
          freedImmediate,
          stoppingQueue,
        },
      };
    });
  } catch (err) {
    if (err instanceof ResourceError) {
      return { exitCode: err.exitCode, error: err.message };
    }
    return { exitCode: 1, error: err.message };
  }

  if (outcome.status === "forbidden") {
    return { exitCode: 3, error: outcome.error };
  }

  const allFreed = [...(outcome.freedImmediate || [])];
  const actionErrors = [];
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
    try {
      withStateTransaction(stateDir, (state, { now }) => {
        let mutated = false;
        for (const rem of stoppingItems) {
          const cur = state.leases[rem.lease.deviceKey];
          if (
            cur &&
            cur.leaseId === rem.lease.leaseId &&
            cur.workerPid === process.pid &&
            cur.state === "stopping"
          ) {
            cur.deadlineMs = now + rem.stopTimeoutMs;
            mutated = true;
          }
        }
        return { mutated };
      });
      if (saveSnap && lease.serial) {
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
      if (!itemFailed && loadSnap && !doStop && lease.serial) {
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
            waitForEmulatorReady(runner, lease.serial, stopTimeoutMs);
          } catch (err) {
            itemFailed = true;
            actionErrors.push(err.message);
          }
        }
      }
      if (!itemFailed && doStop) {
        const isWin = (options.platform || process.platform) === "win32";
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
        }
      }
    } finally {
      heartbeats.get(lease.leaseId)?.stop();
      withStateTransaction(stateDir, (state, { now }) => {
        const cur = state.leases[lease.deviceKey];
        if (cur && cur.leaseId === lease.leaseId) {
          if (itemFailed) {
            cur.state = "active";
            cur.workerPid = null;
            cur.deadlineMs = null;
            const ttlMs = (state.config?.defaultTtlSec || 600) * 1000;
            cur.renewedAtMs = now;
            cur.expiresAtMs = Math.max(cur.expiresAtMs || 0, now + ttlMs);
          } else {
            delete state.leases[lease.deviceKey];
          }
          return { mutated: true };
        }
        return { mutated: false };
      });
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
  return withStateTransaction(stateDir, (state, { now }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
    });
    const ttlSec = clampTtlSec(flags.ttl, state.config);
    const ttlMs = ttlSec * 1000;

    const leasesList = Object.values(state.leases).filter((l) => l.state === "active");
    let lease = null;
    if (target) {
      lease =
        leasesList.find((l) => l.leaseId === target) ||
        leasesList.find((l) => l.serial === target) ||
        leasesList.find((l) => l.avd === target);
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
    if (lease.sessionId !== identity.sessionId && lease.leaseId !== target) {
      return {
        mutated: false,
        value: {
          exitCode: 3,
          error: `Lease ${lease.leaseId} is owned by "${lease.sessionId}", not "${identity.sessionId}".`,
        },
      };
    }

    lease.renewedAtMs = now;
    lease.expiresAtMs = now + ttlMs;
    return {
      mutated: true,
      value: { exitCode: 0, lease },
    };
  });
}

export function cmdSnapshot(stateDir, action, name = null, flags = {}, options = {}) {
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);

  if (action === "list") {
    const targetAvd = flags.avd || null;
    const targetSerial = flags.serial || null;
    if (targetAvd && !targetSerial) {
      const meta = readLocalAvdMetadata(targetAvd, avdHome);
      return { exitCode: 0, snapshots: meta.snapshots };
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
      if (!matched && targetSerial) {
        const state = readState(stateDir);
        const leased = Object.values(state.leases || {}).find(
          (l) =>
            l.kind === "emulator" &&
            l.serial === targetSerial &&
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

  if (!["save", "load", "delete"].includes(action)) {
    return {
      exitCode: 1,
      error: `Unknown snapshot action "${action}". Expected list, save, load, or delete.`,
    };
  }

  if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    return {
      exitCode: 1,
      error: `Invalid snapshot name "${name}". Must match /^[A-Za-z0-9._-]{1,64}$/.`,
    };
  }

  const freeDiskMb =
    options.host?.freeDiskMb ??
    (action === "save" && !flags.force ? readFreeDiskMb(avdHome) : 16384);

  const leaseCheck = withStateTransaction(stateDir, (state, { now }) => {
    const identity = resolveSessionIdentity({
      flags,
      env: options.env || process.env,
      state,
      cwd: options.cwd || process.cwd(),
      ppid: options.ppid ?? process.ppid,
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
    if (action === "save" && !flags.force) {
      const meta = readLocalAvdMetadata(lease.avd, avdHome, state.config);
      const minDisk = state.config.minFreeDiskMb ?? 2048;
      if (freeDiskMb < meta.ramSizeMb + minDisk) {
        return {
          mutated: false,
          value: {
            exitCode: 5,
            error: `Insufficient disk space (${freeDiskMb}MB free) to save snapshot "${name}" on ${lease.avd}: needs ${meta.ramSizeMb + minDisk}MB free. Pass --force to bypass.`,
          },
        };
      }
    }
    const ttlMs = (state.config.defaultTtlSec || 600) * 1000;
    const stopTimeoutMs = (state.config.stopTimeoutSec || 60) * 1000;
    lease.renewedAtMs = now;
    lease.expiresAtMs = Math.max(lease.expiresAtMs, now + Math.max(ttlMs, stopTimeoutMs * 2));
    return { mutated: true, value: { exitCode: 0, lease: { ...lease }, ttlMs, stopTimeoutMs } };
  });

  if (leaseCheck.exitCode !== 0) {
    return leaseCheck;
  }

  const res = runner(
    "adb",
    ["-s", leaseCheck.lease.serial, "emu", "avd", "snapshot", action, name],
    { strictInternal: true, timeoutMs: leaseCheck.stopTimeoutMs },
  );
  if (res.status !== 0) {
    return {
      exitCode: 1,
      error: `adb snapshot ${action} "${name}" failed: ${res.stderr || res.stdout}`,
    };
  }

  if (action === "load") {
    try {
      waitForEmulatorReady(runner, leaseCheck.lease.serial, leaseCheck.stopTimeoutMs);
    } catch (err) {
      return { exitCode: 1, error: err.message };
    }
  }

  const finalLease = withStateTransaction(stateDir, (state, { now }) => {
    const cur = state.leases[leaseCheck.lease.deviceKey];
    if (cur && cur.leaseId === leaseCheck.lease.leaseId) {
      cur.renewedAtMs = now;
      cur.expiresAtMs = Math.max(cur.expiresAtMs, now + leaseCheck.ttlMs);
      if (action === "load") {
        cur.loadedSnapshot = name;
      }
      return { mutated: true, value: { ...cur } };
    }
    return { mutated: false, value: leaseCheck.lease };
  });

  return { exitCode: 0, lease: finalLease, snapshot: name, action };
}

export async function cmdExec(stateDir, commandArgs, flags = {}, options = {}) {
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
    const [cmd, ...args] = commandArgs;
    const wrappedClass = classifySegment(
      [cmd, ...args].map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a))).join(" "),
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
  });

  if (check.exitCode !== 0) {
    return check;
  }

  const [cmd, ...args] = commandArgs;
  const heartbeatIntervalMs = Math.min(60_000, Math.max(1000, Math.floor(check.ttlMs / 3)));
  const onHeartbeat = () => {
    withStateTransaction(stateDir, (state, { now }) => {
      const cur = state.leases[check.lease.deviceKey];
      if (cur && cur.leaseId === check.lease.leaseId && cur.sessionId === check.sessionId) {
        cur.renewedAtMs = now;
        cur.expiresAtMs = now + check.ttlMs;
        return { mutated: true };
      }
      return { mutated: false };
    });
  };

  const exitCode = await spawnWithHeartbeat(
    cmd,
    args,
    check.lease,
    check.sessionId,
    onHeartbeat,
    {
      ...options,
      heartbeatIntervalMs,
    },
  );
  return { exitCode };
}

export function cmdStatus(stateDir, flags = {}, options = {}) {
  const runner = options.runner || runCommandSync;
  const avdHome = options.avdHome || resolveAvdHome(options.env || process.env);
  const cfg = readState(stateDir).config || DEFAULT_CONFIG;
  const inventory = options.inventory || discoverFleet({ runner, avdHome, cfg });
  const req = {
    kind: flags.kind || "any",
    deviceType: flags.type || null,
    apiSpec: flags.api ? String(flags.api) : null,
    services: flags.services || null,
    play: typeof flags.play === "boolean" ? flags.play : null,
    abi: flags.abi || null,
  };

  return withStateTransaction(stateDir, (state, { now }) => {
    reconcileOfflineLeases(state, inventory, null, now);
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
  });
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
        parsedVal = String(val).toLowerCase() === "true" || String(val) === "1";
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

export function cmdGc(stateDir) {
  return withStateTransaction(stateDir, (_state, { pruned }) => {
    return { mutated: true, value: { exitCode: 0, pruned } };
  });
}

export function cmdGuard(stateDir, commandStr, flags = {}, options = {}) {
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
          lease.renewedAtMs = now;
          lease.expiresAtMs = Math.max(lease.expiresAtMs || 0, now + ttlMs);
          mutated = true;
        }
      }
    }
    return { mutated, value: guard };
  });

  return {
    exitCode: evalRes.allowed ? 0 : 2,
    ...evalRes,
  };
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseCliArgs(argv);
  const stateDir = resolveStateDir(env.ATC_STATE_DIR);

  switch (parsed.subcommand) {
    case "claim": {
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
      const res = cmdFree(stateDir, parsed.positionals[0] || null, parsed.flags, { env });
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
      const res = cmdRenew(stateDir, parsed.positionals[0] || null, parsed.flags, { env });
      if (res.exitCode !== 0) {
        process.stderr.write(`[atc] ${res.error}\n`);
        return res.exitCode;
      }
      process.stdout.write(`✓ Renewed ${res.lease.leaseId} (${res.lease.serial})\n`);
      return 0;
    }

    case "snapshot": {
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
      const res = cmdStatus(stateDir, parsed.flags, { env });
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
      await startMcpServer(stateDir);
      return 0;
    }

    default: {
      process.stdout.write(
        `Android Traffic Control (atc)\n\n` +
          `Usage:\n` +
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
  }
}
