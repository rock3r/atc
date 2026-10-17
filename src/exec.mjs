// `atc exec` front-end for typed operations (see docs/scope.md §2–§4).
// Parse → validate (all errors at once) → build literal invocations → dispatch by kind.
// ATC never receives, inspects or runs shell commands.
import fs from "node:fs";
import path from "node:path";
import { OPS, OpError, SYSTEMS, listOps } from "./ops/catalog.mjs";
import { FEATURE_REQUEST_URL, WINDOWS_BATCH_ARG_RE, WINDOWS_BATCH_PATH_FORBIDDEN_RE } from "./ops/patterns.mjs";
import { resolveOpBuildRequirements } from "./ops/requirements.mjs";
import { formatErrors, parseOpArgv, validateOpParams } from "./validate.mjs";

export const EXIT_INVALID = 7;
export const EXIT_POLICY = 3;

const MAX_CAPTURE_BYTES = 256 * 1024;
const BRIEF_TAIL_LINES = 40;
const BRIEF_MAX_LINES = 80;
const BRIEF_SIGNAL_RE = /(error|failed|failure|what went wrong|exception|\bfatal\b|✗|cannot|could not|unresolved)/i;

// Pure-Node PATH lookup (no subprocess). Always resolves against cwd and returns an absolute path.
export function whichSync(name, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const rawExts = platform === "win32" ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const exts = platform === "win32" && /\.(?:exe|cmd|bat|com)$/i.test(name) ? ["", ...rawExts] : rawExts;
  for (const d of dirs) {
    const resolvedDir =
      platform === "win32" && (/^[A-Za-z]:[\\/]/.test(d) || d.startsWith("\\\\"))
        ? path.win32.resolve(d)
        : path.resolve(cwd, d);
    for (const ext of exts) {
      const candidate =
        platform === "win32" && (/^[A-Za-z]:[\\/]/.test(resolvedDir) || resolvedDir.startsWith("\\\\"))
          ? path.win32.join(resolvedDir, name + ext.toLowerCase())
          : path.join(resolvedDir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) {
          if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

function isBatchWrapper(cmd) {
  return /\.(bat|cmd)$/i.test(String(cmd));
}

// Windows contract (docs/scope.md §3.4): batch wrappers run through cmd.exe, so every arg and
// the wrapper path/cwd must be free of CMD expansion characters. Not forceable.
export function checkWindowsContract(invocations, platform) {
  const errors = [];
  if (platform !== "win32") return errors;
  invocations.forEach((inv, i) => {
    if (!isBatchWrapper(inv.cmd)) return;
    if (WINDOWS_BATCH_PATH_FORBIDDEN_RE.test(inv.cmd) || (inv.cwd && WINDOWS_BATCH_PATH_FORBIDDEN_RE.test(inv.cwd))) {
      errors.push({
        path: `/invocations/${i}/cmd`,
        code: "windows_unsafe_path",
        message: `The wrapper path ${JSON.stringify(inv.cmd)} contains characters cmd.exe would expand (% ! ^ " & | < >).`,
        hint: "Move the project to a path without these characters. This check cannot be overridden.",
      });
    }
    (inv.args || []).forEach((a, j) => {
      if (!WINDOWS_BATCH_ARG_RE.test(String(a))) {
        errors.push({
          path: `/invocations/${i}/args/${j}`,
          code: "windows_unsafe_arg",
          message: `Argument ${JSON.stringify(String(a))} cannot be passed safely through cmd.exe to a .bat wrapper.`,
          hint: `Use only [A-Za-z0-9_.:/\\@+=,-]. This check cannot be overridden. Request support at ${FEATURE_REQUEST_URL}.`,
        });
      }
    });
  });
  return errors;
}

export function deviceClassFor(op, params) {
  if (op.kind === "device" || op.kind === "snapshot") {
    return { kind: op.readOnly ? "read_only_device" : "device_action", targetPlatform: op.platform || null };
  }
  const coupled = Boolean(op.deviceCoupled && op.deviceCoupled(params));
  return { kind: coupled ? "device_coupled_build" : "pure_build", targetPlatform: coupled ? op.devicePlatform || null : null };
}

export function renderNotice(n) {
  return `[atc] notice: ${n.assumption}\n        consequence: ${n.consequence}\n        next time:   ${n.fix}\n`;
}

function invalid(errors, extra = {}) {
  return {
    exitCode: EXIT_INVALID,
    ok: false,
    errors,
    error: `Request rejected (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n${formatErrors(errors)}`,
    ...extra,
  };
}

function boundedAppend(buf, chunk) {
  if (buf.length >= MAX_CAPTURE_BYTES) return buf;
  const s = chunk.toString("utf8");
  return buf + s.slice(0, MAX_CAPTURE_BYTES - buf.length);
}

function briefLogPath(stateDir, opName) {
  const dir = path.join(stateDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${opName}-${stamp}-${process.pid}.log`);
}

export function summarizeBriefOutput(lines, exitCode) {
  if (exitCode === 0) return [];
  const picked = new Set();
  lines.forEach((l, i) => {
    if (BRIEF_SIGNAL_RE.test(l)) picked.add(i);
  });
  for (let i = Math.max(0, lines.length - BRIEF_TAIL_LINES); i < lines.length; i++) picked.add(i);
  const idx = [...picked].sort((a, b) => a - b);
  const kept = idx.slice(-BRIEF_MAX_LINES).map((i) => lines[i]);
  return kept;
}

// Validate and plan an op without running it. Returns { errors } or a plan.
export function planOp(opName, params, { force = false, reason = null, cwd = process.cwd(), env = process.env, platform = process.platform, config = {} } = {}) {
  const op = OPS[opName];
  const { errors, overridden } = validateOpParams(opName, params, { force });
  if (force && (!reason || String(reason).trim().length < 3)) {
    errors.push({
      path: "/reason",
      code: "force_reason_required",
      message: "--force needs --reason \"<why you take responsibility>\".",
      hint: "Forced runs are audited and later breakage is attributed to them.",
    });
  }
  if (errors.length > 0) return { errors, overridden };
  if (op.hostOs && platform !== op.hostOs) {
    return {
      errors: [
        {
          path: "/op",
          code: "unsupported_host",
          message: `${opName} needs a ${op.hostOs === "darwin" ? "macOS" : op.hostOs} host.`,
          hint: `Request support at ${FEATURE_REQUEST_URL} if you need it elsewhere.`,
        },
      ],
      overridden,
    };
  }
  const ctxBase = { cwd, platform, which: (n) => whichSync(n, env, platform, cwd) };
  let probe = [];
  if (op.kind === "build") {
    try {
      probe = op.invocations(params, { ...ctxBase, lease: null });
    } catch (err) {
      if (err instanceof OpError) return { errors: [{ path: "/", code: err.code, message: err.message, hint: err.hint }], overridden };
      throw err;
    }
    const winErrors = checkWindowsContract(probe, platform);
    if (winErrors.length) return { errors: winErrors, overridden };
  }
  const notices = typeof op.notices === "function" ? op.notices(params) : [];
  const buildReqs = resolveOpBuildRequirements(op, params, probe, { env });
  const makeInvocations = (lease) => {
    if (op.physicalNeedsConfig && lease?.kind === "physical" && !config[op.physicalNeedsConfig]) {
      throw new OpError(
        "physical_not_allowed",
        `${opName} is disabled on physical devices.`,
        `Enable it with "atc config set ${op.physicalNeedsConfig} true" if you accept the risk.`,
      );
    }
    const invs = op.invocations(params, { ...ctxBase, lease });
    const winErrors = checkWindowsContract(invs, platform);
    if (winErrors.length) throw new OpError(winErrors[0].code, winErrors[0].message, winErrors[0].hint);
    return invs;
  };
  return {
    errors: [],
    op,
    opName,
    params,
    overridden,
    notices,
    buildReqs,
    deviceClass: deviceClassFor(op, params),
    readOnly: Boolean(op.readOnly),
    probe,
    makeInvocations,
  };
}

const RUNNER_FLAG_KEYS = ["claim", "serial", "udid", "android", "ios", "wait", "session", "anchorPid", "type", "api", "os", "kind", "play", "abi", "services", "ttl"];

// Execute a typed op. deps = { runOpInvocations, cmdSnapshot, readConfig, recordForcedRun }.
export async function execOp(stateDir, request, deps, options = {}) {
  const { op: opName, params = {}, flags = {} } = request;
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const json = Boolean(flags.json || options.json);
  const force = Boolean(flags.force);
  const config = deps.readConfig ? deps.readConfig() : {};
  const plan = planOp(opName, params, { force, reason: flags.reason, cwd, env, platform, config });
  if (plan.errors.length > 0) return invalid(plan.errors, { op: opName });
  const op = plan.op;

  const claimRequested = Boolean(flags.claim);
  const needsDevice = op.kind !== "build" || plan.buildReqs.requiresDevice;
  if (claimRequested && !needsDevice) {
    return invalid([
      {
        path: "/claim",
        code: "claim_unused",
        message: `${opName} does not use a device here; --claim would only hold one idle.`,
        hint: "Drop --claim.",
      },
    ], { op: opName });
  }
  if (op.kind === "snapshot") {
    for (const k of ["claim", "wait"]) {
      if (flags[k] !== undefined) {
        return invalid([{ path: `/${k}`, code: "not_allowed", message: `--${k} does not apply to snapshot ops; claim the emulator/simulator first.` }], { op: opName });
      }
    }
  }

  if (!json) for (const n of plan.notices) process.stderr.write(renderNotice(n));

  const effectiveWorkspaceDir = plan.buildReqs?.workspaceRoot || plan.probe?.[0]?.cwd || cwd;
  let forcedRunId = null;
  if (force || plan.overridden.length > 0) {
    const effectiveReason =
      flags.reason && String(flags.reason).trim()
        ? String(flags.reason).trim()
        : `custom executable (${params.executable})`;
    forcedRunId = deps.recordForcedRun
      ? deps.recordForcedRun(
          { op: opName, reason: effectiveReason, overridden: plan.overridden, cwd: effectiveWorkspaceDir },
          { session: flags.session, anchorPid: flags.anchorPid },
        )
      : null;
    if (!json) {
      process.stderr.write(
        `[atc] forced run${forcedRunId ? ` ${forcedRunId}` : ""}: you take responsibility (${effectiveReason}). Overridden: ${
          plan.overridden.map((o) => `${o.path}=${JSON.stringify(o.value)}`).join(", ") || "none"
        }\n`,
      );
    }
  }

  const base = { op: opName, notices: plan.notices, overridden: plan.overridden, forcedRunId };

  if (op.kind === "snapshot") {
    const snapFlags = {};
    for (const k of ["serial", "udid", "android", "ios", "session", "anchorPid"]) if (flags[k] !== undefined) snapFlags[k] = flags[k];
    const res = deps.cmdSnapshot(stateDir, op.action, params.name || null, snapFlags, { ...options, env, cwd });
    return { ...base, ...res, ok: res.exitCode === 0 };
  }

  const runnerFlags = {};
  for (const k of RUNNER_FLAG_KEYS) if (flags[k] !== undefined) runnerFlags[k] = flags[k];
  if (params.ramMb) runnerFlags.ramMb = params.ramMb;

  const brief = Boolean(params.brief) && op.kind === "build";
  let stdout = "";
  let stderr = "";
  let logPath = null;
  let logFd = null;
  let lineBuf = "";
  const briefLines = [];
  let onOutput = null;
  let stdio = undefined;
  if (brief) {
    logPath = briefLogPath(stateDir, opName);
    logFd = fs.openSync(logPath, "a");
    stdio = ["ignore", "pipe", "pipe"];
    onOutput = (chunk) => {
      try {
        fs.writeSync(logFd, chunk);
      } catch {
        // best-effort log
      }
      lineBuf += chunk.toString("utf8");
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop();
      for (const p of parts) {
        briefLines.push(p);
        if (briefLines.length > 5000) briefLines.splice(0, briefLines.length - 5000);
      }
    };
  } else if (json) {
    stdio = ["ignore", "pipe", "pipe"];
    onOutput = (chunk, stream) => {
      if (stream === "stdout") stdout = boundedAppend(stdout, chunk);
      else stderr = boundedAppend(stderr, chunk);
    };
  }

  const startedAt = Date.now();
  let res;
  try {
    res = await deps.runOpInvocations(
      stateDir,
      { ...plan, stdio, onOutput },
      runnerFlags,
      { ...options, env, cwd, platform: options.platform },
    );
  } finally {
    if (logFd !== null) {
      try {
        if (lineBuf) briefLines.push(lineBuf);
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
    }
  }
  const out = {
    ...base,
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    durationMs: Date.now() - startedAt,
    steps: res.steps || [],
    ...(res.error ? { error: res.error } : {}),
    ...(res.errorCode ? { errorCode: res.errorCode } : {}),
    ...(json && !brief ? { stdout, stderr } : {}),
    ...(logPath ? { logPath } : {}),
  };
  if (brief) {
    out.summary = summarizeBriefOutput(briefLines, res.exitCode);
  }
  if (res.exitCode !== 0 && deps.recentForcedRuns) {
    const since = Date.now() - 24 * 3600 * 1000;
    const related = deps
      .recentForcedRuns()
      .filter(
        (r) =>
          r &&
          r.atMs >= since &&
          r.runId !== forcedRunId &&
          (r.cwd === effectiveWorkspaceDir ||
            String(effectiveWorkspaceDir).startsWith(`${r.cwd}${path.sep}`) ||
            String(r.cwd).startsWith(`${effectiveWorkspaceDir}${path.sep}`)),
      );
    if (related.length > 0) {
      out.attribution = related.map((r) => ({ runId: r.runId, op: r.op, reason: r.reason, sessionId: r.sessionId, atMs: r.atMs }));
      if (!json) {
        for (const r of related) {
          process.stderr.write(
            `[atc] note: forced run ${r.runId} (${r.op}, session ${r.sessionId || "?"}, "${r.reason}") touched this workspace ${Math.round((Date.now() - r.atMs) / 60000)} min ago and may be related.\n`,
          );
        }
      }
    }
  }
  return out;
}

export function renderExecResult(res, { json = false, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s) } = {}) {
  if (json) {
    const { json: _json, ...payload } = res;
    write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  if (res.error) writeErr(`[atc] ${res.error}\n`);
  if (res.logPath) {
    if (res.exitCode === 0) {
      writeErr(`[atc] ✓ ${res.op} succeeded in ${Math.round((res.durationMs || 0) / 100) / 10}s (full log: ${res.logPath})\n`);
    } else {
      for (const l of res.summary || []) writeErr(`${l}\n`);
      writeErr(`[atc] ✗ ${res.op} failed with exit code ${res.exitCode} (full log: ${res.logPath})\n`);
    }
  }
  if (res.snapshots) write(JSON.stringify(res.snapshots, null, 2) + "\n");
  else if (res.op?.startsWith("snapshot.") && res.exitCode === 0) write(`✓ ${res.op} ${res.snapshot || ""}\n`.replace(/ \n$/, "\n"));
}

export function execHelp(system = null) {
  const lines = [];
  if (!system) {
    lines.push(
      "Usage: atc exec <system> <operation> [args] [--options] [--json]",
      "",
      "ATC runs allowlisted typed operations only, never shell commands. For env, cwd,",
      "multiple steps, claims and timeouts use \"atc batch\" (a JSON plan of the same ops).",
      "",
      `Systems: ${SYSTEMS.join(", ")}`,
      "",
    );
  }
  for (const sys of system ? [system] : SYSTEMS) {
    lines.push(`${sys}:`);
    for (const op of listOps(sys)) {
      const verb = op.name.slice(sys.length + 1).replace(/\./g, " ").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const posList = Array.isArray(op.positional) ? op.positional : op.positional ? [op.positional] : [];
      const pos = posList.map((p) => ` <${p}${/\[\]$/.test(op.params[p].type) ? "..." : ""}>`).join("");
      const opts = Object.entries(op.params)
        .filter(([k]) => !posList.includes(k))
        .map(([k, s]) => {
          const flag = `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
          const req = s.required ? "" : "?";
          if (s.type === "boolean") return `${flag}${req}`;
          if (s.type === "objectList") return `${k} (batch only)`;
          if (s.type === "map") return `--${k === "properties" ? "property" : k}${req} <key=value> (repeatable)`;
          if (/\[\]$/.test(s.type)) return `${flag.replace(/s$/, "")}${req} <${s.type === "enum[]" ? s.values.join("|") : "value"}> (repeatable)`;
          return `${flag}${req} <${s.type === "enum" ? s.values.join("|") : s.type}>`;
        });
      lines.push(`  atc exec ${sys} ${verb}${pos}${opts.length ? `  ${opts.join(" ")}` : ""}`);
    }
    lines.push("");
  }
  lines.push(
    "Exec options: --json  --claim [selectors]  --serial/--udid <id>  --wait <sec>  --force --reason \"<why>\"",
    `Missing something? Request it at ${FEATURE_REQUEST_URL}`,
  );
  return lines.join("\n") + "\n";
}

// CLI entry: tokens are the raw argv after `exec`.
export async function cmdExecTokens(stateDir, tokens, deps, options = {}) {
  if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h" || tokens[0] === "help") {
    return { exitCode: 0, help: execHelp() };
  }
  if (tokens.length >= 1 && SYSTEMS.includes(tokens[0]) && (tokens[1] === "--help" || tokens[1] === "-h" || tokens.length === 1)) {
    return { exitCode: tokens.length === 1 ? EXIT_INVALID : 0, help: execHelp(tokens[0]) };
  }
  const parsed = parseOpArgv(tokens);
  if (parsed.errors.length > 0) {
    const all = [...parsed.errors];
    if (parsed.opName) {
      const seen = new Set(all.map((e) => e.path));
      for (const e of validateOpParams(parsed.opName, parsed.params || {}).errors) {
        if (!seen.has(e.path)) all.push(e);
      }
    }
    return invalid(all, { op: parsed.opName || null, json: Boolean(parsed.execFlags?.json) });
  }
  const res = await execOp(stateDir, { op: parsed.opName, params: parsed.params, flags: parsed.execFlags }, deps, options);
  return { ...res, json: Boolean(parsed.execFlags.json) };
}
