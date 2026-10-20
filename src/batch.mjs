// `atc batch`: a JSON DAG of typed ops (see docs/scope.md §5).
// v1 runs steps sequentially in dependency order. Plans are validated in full before anything runs.
import fs from "node:fs";
import path from "node:path";
import { EXIT_INVALID, execOp, planOp, renderNotice } from "./exec.mjs";
import { OPS } from "./ops/catalog.mjs";
import { formatErrors, validateBatchPlan } from "./validate.mjs";

const STEP_COMMON_FIELDS = new Set(["id", "op", "dependsOn", "cwd", "env", "claim", "timeoutSec", "continueOnError", "force"]);

function stepParams(step) {
  const declared = OPS[step.op]?.params || {};
  const out = {};
  for (const [k, v] of Object.entries(step)) {
    // timeoutSec is both a step field and a bazel.run param: pass it through where declared.
    if (!STEP_COMMON_FIELDS.has(k) || (k === "timeoutSec" && declared.timeoutSec)) out[k] = v;
  }
  return out;
}

function claimFlagsFromProfile(profile) {
  const f = {};
  if (profile.platform) f.platform = profile.platform;
  for (const k of ["kind", "type", "api", "os", "abi", "services", "snapshotLoad"]) if (profile[k] !== undefined) f[k] = profile[k];
  if (profile.play !== undefined) f.play = profile.play;
  if (profile.ttlSec !== undefined) f.ttl = String(profile.ttlSec);
  return f;
}

function lastConsumerIndex(order, stepById, producerId) {
  let last = order.indexOf(producerId);
  order.forEach((id, i) => {
    const s = stepById.get(id);
    if (s?.claim?.reuse === producerId) last = Math.max(last, i);
  });
  return last;
}

export function readPlanInput({ file = null, spec = null, cwd = process.cwd(), readStdin = null } = {}) {
  let raw;
  if (spec !== null && spec !== undefined) raw = typeof spec === "string" ? spec : JSON.stringify(spec);
  else if (file && file !== "-") raw = fs.readFileSync(path.resolve(cwd, file), "utf8");
  else raw = readStdin ? readStdin() : "";
  if (!raw || !String(raw).trim()) throw new Error('No plan given. Pass --file <plan.json> or pipe the JSON plan on stdin.');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`The plan is not valid JSON: ${err.message}`);
  }
}

// deps = exec deps + { cmdClaim, cmdFree, cmdRenew, sessionHasLease(platform), resolveSessionId() }
export async function runBatch(stateDir, plan, deps, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const json = Boolean(options.json);
  const startedAt = Date.now();
  const batchId = `batch-${startedAt.toString(36)}`;

  const v = validateBatchPlan(plan, {
    cwd,
    existsDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    sessionHasLease: deps.sessionHasLease || (() => false),
    ...(deps.sessionLeaseCount ? { sessionLeaseCount: deps.sessionLeaseCount } : {}),
  });
  if (v.errors.length > 0) {
    return {
      exitCode: EXIT_INVALID,
      ok: false,
      batchId,
      errors: v.errors,
      error: `Plan rejected before running anything (${v.errors.length} problem${v.errors.length === 1 ? "" : "s"}):\n${formatErrors(v.errors)}`,
    };
  }
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));
  const order = v.order;

  // Second pass: per-step planning (wrapper/workspace resolution, host OS, Windows contract).
  const config = deps.readConfig ? deps.readConfig() : {};
  const planned = new Map();
  const planErrors = [];
  for (const id of order) {
    const step = stepById.get(id);
    const stepCwd = step.cwd ? path.resolve(cwd, step.cwd) : cwd;
    const p = planOp(step.op, stepParams(step), {
      force: Boolean(step.force),
      reason: step.force?.reason,
      cwd: stepCwd,
      env: { ...env, ...(step.env || {}) },
      platform,
      config,
    });
    const idx = plan.steps.indexOf(step);
    for (const e of p.errors) planErrors.push({ ...e, path: `/steps/${idx}${e.path === "/" ? "" : e.path}` });
    // Model the declared claim so guaranteed device-policy refusals (e.g. prop.set on a
    // physical device) are caught before any device is claimed.
    let placeholder = null;
    if (p.errors.length === 0 && p.op.kind === "snapshot") {
      // Snapshots are virtual-only: refuse a declared or existing physical lease up front.
      const claim = step.claim?.reuse !== undefined ? stepById.get(step.claim.reuse)?.claim : step.claim;
      const sessionLease = !claim && deps.sessionLease ? deps.sessionLease(claim?.platform || null) : null;
      const kind = claim ? claim.kind : sessionLease?.kind;
      if (kind === "physical") {
        planErrors.push({
          path: `/steps/${idx}/claim`,
          code: "virtual_only",
          message: `${step.op} only works on emulators and simulators, but this step would run on a physical device.`,
          hint: 'Claim a virtual device ("kind": "emulator").',
        });
      }
    }
    if (p.errors.length === 0 && p.op.kind !== "snapshot" && (p.op.kind !== "build" || p.buildReqs.requiresDevice)) {
      const claim = step.claim?.reuse !== undefined ? stepById.get(step.claim.reuse)?.claim : step.claim;
      const opPlatform = p.op.platform || p.op.devicePlatform;
      // No claim: the step uses the session's existing lease, so model that lease's kind.
      const sessionLease = !claim && deps.sessionLease ? deps.sessionLease(opPlatform) : null;
      const kind = claim ? (claim.kind === "physical" ? "physical" : "emulator") : sessionLease?.kind === "physical" ? "physical" : "emulator";
      placeholder = {
        serial: "<leased-device>",
        leaseId: "<lease>",
        kind,
        platform: opPlatform,
      };
      try {
        p.makeInvocations(placeholder);
      } catch (err) {
        if (err?.code === "physical_not_allowed" || err?.code === "simulator_only") {
          planErrors.push({ path: `/steps/${idx}/claim`, code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
        }
      }
    }
    planned.set(id, { plan: p, cwd: stepCwd, placeholder });
  }
  if (planErrors.length > 0) {
    return {
      exitCode: EXIT_INVALID,
      ok: false,
      batchId,
      errors: planErrors,
      error: `Plan rejected before running anything (${planErrors.length} problem${planErrors.length === 1 ? "" : "s"}):\n${formatErrors(planErrors)}`,
    };
  }

  const notices = [];
  for (const id of order) {
    for (const n of planned.get(id).plan.notices || []) notices.push({ stepId: id, ...n });
  }
  // Efficiency notice: a device step that does not reuse an earlier claim on the same platform.
  const claimingSteps = order.filter((id) => stepById.get(id).claim && stepById.get(id).claim.reuse === undefined);
  if (claimingSteps.length > 1) {
    const byPlat = new Map();
    for (const id of claimingSteps) {
      const plat = stepById.get(id).claim.platform;
      byPlat.set(plat, [...(byPlat.get(plat) || []), id]);
    }
    for (const [plat, ids] of byPlat) {
      if (ids.length > 1) {
        notices.push({
          stepId: ids[1],
          assumption: `Steps ${ids.join(", ")} each claim their own ${plat} device, exactly as requested.`,
          consequence: "Each claim may boot or wait for a separate device.",
          fix: `Use "claim": { "reuse": "${ids[0]}" } on the later steps (and dependsOn) to keep one device.`,
        });
      }
    }
  }

  if (options.validateOnly) {
    return {
      exitCode: 0,
      ok: true,
      batchId,
      validated: true,
      order,
      notices,
      steps: order.map((id) => {
        const { plan: p, cwd: stepCwd, placeholder } = planned.get(id);
        let invocations = [];
        try {
          invocations =
            p.op.kind === "snapshot"
              ? [{ snapshot: p.op.action, name: p.params.name || null }]
              : p.makeInvocations(placeholder);
        } catch (err) {
          invocations = [{ error: err.message }];
        }
        return { id, op: p.opName, cwd: stepCwd, invocations, overridden: p.overridden };
      }),
    };
  }

  if (!json) for (const n of notices) process.stderr.write(renderNotice(n).replace("[atc] notice:", `[atc] notice (${n.stepId}):`));

  const sessionId = options.session || (deps.resolveSessionId ? deps.resolveSessionId() : null);
  const results = new Map();
  const heldClaims = new Map(); // producerId -> { lease, created, timer, lastIdx }
  const releaseClaim = (producerId) => {
    const h = heldClaims.get(producerId);
    if (!h) return;
    heldClaims.delete(producerId);
    if (h.timer) clearInterval(h.timer);
    if (h.created && h.lease?.leaseId) {
      try {
        deps.cmdFree(stateDir, h.lease.leaseId, { session: sessionId }, { env, cwd });
      } catch {
        // best-effort release
      }
    }
  };

  let batchExit = 0;
  let stopped = false;
  // Release claims whose last consumer has run or been skipped (or whose producer failed).
  const sweepClaims = (i, id, status) => {
    for (const [pid, h] of [...heldClaims]) {
      if (h.lastIdx <= i || (pid === id && status !== "ok")) releaseClaim(pid);
    }
  };
  try {
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const step = stepById.get(id);
      const { cwd: stepCwd } = planned.get(id);
      const started = Date.now();
      const deps_ = Array.isArray(step.dependsOn) ? step.dependsOn : [];
      const failedDep = deps_.find((d) => results.get(d)?.status !== "ok");
      if (failedDep) {
        results.set(id, { id, op: step.op, status: "skipped", reason: "dependency_failed", dependency: failedDep });
        sweepClaims(i, id, "skipped");
        continue;
      }
      if (stopped) {
        results.set(id, { id, op: step.op, status: "skipped", reason: "batch_stopped" });
        sweepClaims(i, id, "skipped");
        continue;
      }
      const flags = { session: sessionId, ...(json ? { json: true } : {}) };
      if (step.force) {
        flags.force = true;
        flags.reason = step.force.reason;
      }
      let claimError = null;
      if (step.claim && step.claim.reuse !== undefined) {
        const h = heldClaims.get(step.claim.reuse);
        if (!h) claimError = { code: "claim_unavailable", message: `The device claimed by "${step.claim.reuse}" is not available.` };
        else flags.serial = h.lease.serial;
      } else if (step.claim) {
        const res = deps.cmdClaim(stateDir, { ...claimFlagsFromProfile(step.claim), session: sessionId }, { env: { ...env, ...(step.env || {}) }, cwd: stepCwd, inventory: options.inventory });
        if (res.exitCode !== 0 || !res.lease) {
          claimError = { code: "claim_failed", message: res.error || "Device claim failed." };
        } else {
          const lastIdx = lastConsumerIndex(order, stepById, id);
          // An idempotent claim can return a lease another producer in this batch already holds.
          // Share ownership: extend the owner's lifetime instead of holding an independent alias.
          const owner = [...heldClaims.values()].find((h) => h.lease?.leaseId && h.lease.leaseId === res.lease.leaseId && !h.aliasOf);
          if (owner) {
            owner.lastIdx = Math.max(owner.lastIdx, lastIdx);
            if (!owner.timer && owner.lastIdx > i && deps.cmdRenew) {
              const ownerTtlMs = Math.max(15_000, Number(res.lease.expiresAtMs || owner.lease.expiresAtMs || 0) - Date.now());
              owner.timer = setInterval(() => {
                try {
                  deps.cmdRenew(stateDir, owner.lease.leaseId, { session: sessionId }, { env, cwd });
                } catch {
                  // best-effort heartbeat
                }
              }, Math.max(5_000, Math.floor(ownerTtlMs / 3)));
              if (typeof owner.timer.unref === "function") owner.timer.unref();
            }
            heldClaims.set(id, { lease: res.lease, created: false, timer: null, lastIdx, aliasOf: true });
            flags.serial = res.lease.serial;
          } else {
            const ttlMs = Math.max(30_000, Number(res.lease.expiresAtMs || 0) - Date.now());
            const timer =
              lastIdx > i && deps.cmdRenew
                ? setInterval(() => {
                    try {
                      deps.cmdRenew(stateDir, res.lease.leaseId, { session: sessionId }, { env, cwd });
                    } catch {
                      // best-effort heartbeat
                    }
                  }, Math.max(5_000, Math.floor(ttlMs / 3)))
                : null;
            if (timer && typeof timer.unref === "function") timer.unref();
            heldClaims.set(id, { lease: res.lease, created: !res.idempotent, timer, lastIdx });
            flags.serial = res.lease.serial;
          }
        }
      }
      let r;
      if (claimError) {
        r = { id, op: step.op, status: "failed", exitCode: 3, error: claimError.message, errorCode: claimError.code };
      } else {
        const res = await execOp(
          stateDir,
          { op: step.op, params: stepParams(step), flags },
          deps,
          { ...options, cwd: stepCwd, env: { ...env, ...(step.env || {}) }, timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : undefined, inventory: options.inventory },
        );
        r = {
          id,
          op: step.op,
          status: res.exitCode === 0 ? "ok" : "failed",
          exitCode: res.exitCode,
          durationMs: Date.now() - started,
          steps: res.steps,
          ...(res.error ? { error: res.error } : {}),
          ...(res.errors ? { errors: res.errors } : {}),
          ...(res.logPath ? { logPath: res.logPath, summary: res.summary } : {}),
          ...(res.forcedRunId ? { forcedRunId: res.forcedRunId } : {}),
          ...(res.overridden?.length ? { overridden: res.overridden } : {}),
          ...(res.attribution?.length ? { attribution: res.attribution } : {}),
          ...(json && res.stdout !== undefined ? { stdout: res.stdout, stderr: res.stderr } : {}),
          ...(res.artifact ? { artifact: res.artifact } : {}),
          ...(res.stderr !== undefined && res.artifact ? { stderr: res.stderr } : {}),
          ...(res.snapshots ? { snapshots: res.snapshots } : {}),
        };
      }
      results.set(id, r);
      sweepClaims(i, id, r.status);
      if (r.status !== "ok") {
        if (!step.continueOnError) {
          if (batchExit === 0) batchExit = r.exitCode || 1;
          stopped = true;
        }
      }
    }
  } finally {
    for (const pid of [...heldClaims.keys()]) releaseClaim(pid);
  }

  const steps = order.map((id) => results.get(id));
  return {
    exitCode: batchExit,
    ok: batchExit === 0,
    batchId,
    durationMs: Date.now() - startedAt,
    notices,
    steps,
  };
}

export function renderBatchResult(res, { json = false, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s) } = {}) {
  if (json) {
    write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (res.error) {
    writeErr(`[atc] ${res.error}\n`);
    return;
  }
  if (res.validated) {
    write(`✓ Plan is valid (${res.steps.length} step${res.steps.length === 1 ? "" : "s"}). Execution order and exact invocations:\n`);
    for (const s of res.steps) {
      write(`  ${s.id} (${s.op}) in ${s.cwd}\n`);
      for (const inv of s.invocations) {
        if (inv.cmd) write(`    $ ${[inv.cmd, ...inv.args].map((a) => (/[^A-Za-z0-9_.:/@+=,-]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
        else write(`    ${JSON.stringify(inv)}\n`);
      }
    }
    return;
  }
  for (const s of res.steps) {
    const mark = s.status === "ok" ? "✓" : s.status === "skipped" ? "-" : "✗";
    const extra = s.status === "skipped" ? ` (${s.reason}${s.dependency ? `: ${s.dependency}` : ""})` : s.status === "failed" ? ` (exit ${s.exitCode})` : "";
    writeErr(`[atc] ${mark} ${s.id} ${s.op}${extra}\n`);
    if (s.status === "failed" && s.error) writeErr(`      ${s.error.replace(/\n/g, "\n      ")}\n`);
    if (s.summary?.length && s.status === "failed") for (const l of s.summary) writeErr(`      ${l}\n`);
    if (s.logPath) writeErr(`      log: ${s.logPath}\n`);
  }
  writeErr(`[atc] ${res.ok ? "✓ Completed" : "✗ Failed"} batch ${res.batchId} in ${res.durationMs}ms\n`);
}
