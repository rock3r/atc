// Validation for typed ATC operations and batch plans (see docs/scope.md §3–§5).
// All errors are collected (never just the first) as { path, code, message, hint }.
import path from "node:path";
import { OPS, SYSTEMS, listOps, resolveOpName } from "./ops/catalog.mjs";
import { FEATURE_REQUEST_URL, PATTERNS, checkPattern, isSafePathSyntax } from "./ops/patterns.mjs";

function err(pathStr, code, message, hint = null, extra = {}) {
  return { path: pathStr, code, message, ...(hint ? { hint } : {}), ...extra };
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

export function suggest(value, candidates) {
  const v = String(value || "").toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(v, String(c).toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(String(value).length / 3)) ? best : null;
}

function didYouMean(value, candidates) {
  const s = suggest(value, candidates);
  return s ? `Did you mean "${s}"?` : null;
}

function patternError(p, patternKey, value, { force = false, overridden = [] } = {}) {
  const pat = PATTERNS[patternKey];
  if (checkPattern(patternKey, value)) return null;
  // Option injection: a leading "-" is never forceable, whatever the pattern.
  const forceable = Boolean(pat.forceable) && !String(value ?? "").startsWith("-") && !/[\0\r\n]/.test(String(value ?? ""));
  if (force && forceable) {
    overridden.push({ path: p, check: `pattern:${patternKey}`, value: String(value) });
    return null;
  }
  return err(
    p,
    "pattern_mismatch",
    `${JSON.stringify(String(value))} is not ${pat.label}.`,
    forceable
      ? `If this value is legitimate, re-run with --force --reason "<why>" (you take responsibility), and request support at ${FEATURE_REQUEST_URL}.`
      : `This value cannot be overridden. Request support at ${FEATURE_REQUEST_URL} if you need it.`,
    { forceable },
  );
}

function validateField(spec, value, p, ctx) {
  const errors = [];
  const push = (e) => e && errors.push(e);
  switch (spec.type) {
    case "string":
      if (typeof value !== "string" || value.length === 0) {
        push(err(p, "type", "Expected a non-empty string."));
      } else if (spec.pattern) {
        push(patternError(p, spec.pattern, value, ctx));
      }
      break;
    case "string[]":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        push(err(p, "type", "Expected an array of strings."));
        break;
      }
      if (spec.minItems && value.length < spec.minItems) {
        push(err(p, "min_items", `Expected at least ${spec.minItems} item(s).`));
      }
      if (spec.maxItems && value.length > spec.maxItems) {
        push(err(p, "max_items", `Expected at most ${spec.maxItems} item(s).`));
      }
      value.forEach((v, i) => spec.pattern && push(patternError(`${p}/${i}`, spec.pattern, v, ctx)));
      break;
    case "boolean":
      if (typeof value !== "boolean") push(err(p, "type", "Expected true or false."));
      break;
    case "integer":
      if (!Number.isInteger(value)) push(err(p, "type", "Expected an integer."));
      else if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
        push(err(p, "range", `Expected an integer between ${spec.min} and ${spec.max}.`));
      }
      break;
    case "enum":
      if (!spec.values.includes(value)) {
        push(err(p, "enum", `Expected one of: ${spec.values.join(", ")}.`, didYouMean(value, spec.values)));
      }
      break;
    case "enum[]":
      if (!Array.isArray(value) || value.length === 0) {
        push(err(p, "type", `Expected a non-empty array of: ${spec.values.join(", ")}.`));
        break;
      }
      if (spec.maxItems && value.length > spec.maxItems) {
        push(err(p, "max_items", `Expected at most ${spec.maxItems} item(s).`));
      }
      value.forEach((v, i) => {
        if (!spec.values.includes(v)) {
          push(err(`${p}/${i}`, "enum", `Expected one of: ${spec.values.join(", ")}.`, didYouMean(v, spec.values)));
        }
      });
      break;
    case "path":
      if (typeof value !== "string" || !isSafePathSyntax(value)) {
        push(err(p, "path_syntax", "Expected a path without NUL/newline characters that does not start with '-'."));
      }
      break;
    case "map":
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        push(err(p, "type", "Expected an object of key/value strings."));
        break;
      }
      for (const [k, v] of Object.entries(value)) {
        push(patternError(`${p}/${k}`, spec.keyPattern, k, ctx));
        if (typeof v !== "string") push(err(`${p}/${k}`, "type", "Expected a string value."));
        else push(patternError(`${p}/${k}`, spec.valuePattern, v, ctx));
      }
      break;
    case "objectList":
      if (!Array.isArray(value) || value.length === 0) {
        push(err(p, "type", "Expected a non-empty array of objects."));
        break;
      }
      if (spec.maxItems && value.length > spec.maxItems) {
        push(err(p, "max_items", `Expected at most ${spec.maxItems} item(s).`));
      }
      value.forEach((item, i) => {
        errors.push(...validateObject(spec.item, item, `${p}/${i}`, ctx));
      });
      break;
    default:
      push(err(p, "internal", `Unknown field type ${spec.type}.`));
  }
  return errors;
}

function validateObject(fields, obj, basePath, ctx) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return [err(basePath || "/", "type", "Expected an object.")];
  }
  for (const key of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      errors.push(
        err(`${basePath}/${key}`, "unknown_field", `Unknown field "${key}".`, didYouMean(key, Object.keys(fields))),
      );
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    const val = obj[key];
    if (val === undefined || val === null) {
      if (spec.required) errors.push(err(`${basePath}/${key}`, "required", `Missing required field "${key}".`));
      continue;
    }
    errors.push(...validateField(spec, val, `${basePath}/${key}`, ctx));
  }
  return errors;
}

// Validate op params. Returns { errors, overridden } where overridden lists forced pattern checks.
export function validateOpParams(opName, params, { force = false, basePath = "" } = {}) {
  const op = OPS[opName];
  const overridden = [];
  if (!op) {
    return {
      errors: [
        err(
          `${basePath}/op`,
          "unknown_op",
          `"${opName}" is not a supported operation.`,
          `${didYouMean(opName, Object.keys(OPS)) || ""} Supported: ${Object.keys(OPS).join(", ")}. Request others at ${FEATURE_REQUEST_URL}.`.trim(),
        ),
      ],
      overridden,
    };
  }
  const ctx = { force, overridden };
  const errors = validateObject(op.params, params || {}, basePath, ctx);
  if (
    params?.executable !== undefined &&
    params?.executable !== null &&
    !errors.some((e) => e.path === `${basePath}/executable`)
  ) {
    overridden.push({
      path: `${basePath}/executable`,
      check: "custom_executable",
      value: String(params.executable),
    });
  }
  if (errors.length === 0 && typeof op.check === "function") {
    errors.push(...op.check(params).map((e) => ({ ...e, path: `${basePath}${e.path}` })));
  }
  if (op.system === "xcode" && params?.workspaceFile && params?.project) {
    errors.push(err(`${basePath}/project`, "conflict", "Pass either workspaceFile or project, not both."));
  }
  if (errors.length === 0 && op.deviceCoupled && params?.buildOnly && op.deviceCoupled(params || {})) {
    errors.push(
      err(`${basePath}/buildOnly`, "build_only_device", "buildOnly was set, but these tasks need a device.", "Remove buildOnly, or split the device tasks into a separate step."),
    );
  }
  return { errors, overridden };
}

const EXEC_LEVEL_FLAGS = {
  json: "boolean",
  force: "boolean",
  reason: "string",
  session: "string",
  anchorPid: "string",
  serial: "string",
  udid: "string",
  android: "boolean",
  ios: "boolean",
  claim: "boolean",
  wait: "string",
  // Claim selector flags (used with --claim for device-coupled builds)
  type: "string",
  api: "string",
  os: "string",
  kind: "string",
  play: "boolean",
  abi: "string",
  services: "string",
  ttl: "string",
};

function camelCase(s) {
  return String(s).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseScalar(spec, raw) {
  if (spec.type === "integer") {
    return /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
  return raw;
}

// Parse `atc exec <system> <verb> [positional...] [--flag value | --flag=value | --bool]`.
export function parseOpArgv(tokens) {
  const errors = [];
  const toks = [...(tokens || [])].map(String);
  if (toks[0] === "--") {
    return {
      errors: [
        err(
          "/",
          "unsupported_raw_command",
          '"atc exec -- <command>" is no longer supported: ATC never runs arbitrary commands.',
          'Use a typed operation, e.g. "atc exec gradle tasks assembleDebug" or "atc exec android install app.apk". Run "atc exec --help" for the catalog.',
        ),
      ],
    };
  }
  const [system, rawVerb, ...restToks] = toks;
  let verb = rawVerb;
  let rest = restToks;
  // Two-word verbs, e.g. `atc exec android prop get <key>` → android.prop.get
  if (verb && rest.length > 0 && !rest[0].startsWith("-") && resolveOpName(system, `${verb}.${rest[0]}`)) {
    verb = `${verb}.${rest[0]}`;
    rest = rest.slice(1);
  }
  if (!system || system.startsWith("-")) {
    return { errors: [err("/system", "required", `Missing system. Supported: ${SYSTEMS.join(", ")}.`)] };
  }
  if (!SYSTEMS.includes(system)) {
    return {
      errors: [
        err(
          "/system",
          "unknown_system",
          `"${system}" is not a supported system.`,
          `${didYouMean(system, SYSTEMS) || ""} Supported: ${SYSTEMS.join(", ")}. Request others at ${FEATURE_REQUEST_URL}.`.trim(),
        ),
      ],
    };
  }
  const verbs = listOps(system).map((o) => o.name.slice(system.length + 1).replace(/\./g, " "));
  if (!verb || verb.startsWith("-")) {
    return { errors: [err("/verb", "required", `Missing operation for ${system}. Supported: ${verbs.join(", ")}.`)] };
  }
  const opName = resolveOpName(system, verb);
  if (!opName) {
    return {
      errors: [
        err(
          "/verb",
          "unknown_op",
          `"${system} ${verb}" is not a supported operation.`,
          `${didYouMean(verb, verbs) || ""} Supported: ${verbs.join(", ")}. Request others at ${FEATURE_REQUEST_URL}.`.trim(),
        ),
      ],
    };
  }
  const op = OPS[opName];
  const params = {};
  const execFlags = {};
  const positionals = [];
  const paramKeyFor = (flagName) => {
    if (op.params[flagName]) return flagName;
    const plural = `${flagName}s`;
    if (op.params[plural] && /\[\]$/.test(op.params[plural].type)) return plural;
    if (flagName === "property" && op.params.properties) return "properties";
    return null;
  };
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const rawName = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    let name = camelCase(rawName);
    let inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
    let negated = false;
    if (name.startsWith("no") && /^no[A-Z]/.test(name)) {
      const positive = name[2].toLowerCase() + name.slice(3);
      if (op.params[positive]?.type === "boolean" || (!op.params[positive] && EXEC_LEVEL_FLAGS[positive] === "boolean")) {
        negated = true;
        name = positive;
      }
    }
    if (name === "ramMb" && !op.params.ramMb) {
      errors.push(err(`/${name}`, "unknown_flag", `--ram-mb does not apply to ${opName}.`));
      continue;
    }
    const pKey = paramKeyFor(name);
    const allowLeadingDash = Boolean(pKey && op.params[pKey]?.pattern && PATTERNS[op.params[pKey].pattern]?.allowLeadingDash);
    const takeValue = () => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 < rest.length && (allowLeadingDash || !rest[i + 1].startsWith("--"))) return rest[++i];
      errors.push(err(`/${name}`, "missing_value", `--${rawName} requires a value.`));
      return null;
    };
    if (pKey) {
      const spec = op.params[pKey];
      if (spec.type === "boolean") {
        params[pKey] = negated ? false : inlineVal === undefined ? true : !/^(false|0|no|off)$/i.test(inlineVal);
      } else if (spec.type === "string[]" || spec.type === "enum[]") {
        const v = takeValue();
        if (v !== null) (params[pKey] ||= []).push(v);
      } else if (spec.type === "map") {
        const v = takeValue();
        if (v !== null) {
          const kv = v.indexOf("=");
          if (kv <= 0) errors.push(err(`/${pKey}`, "type", `--${rawName} expects key=value.`));
          else (params[pKey] ||= {})[v.slice(0, kv)] = v.slice(kv + 1);
        }
      } else if (spec.type === "objectList") {
        errors.push(err(`/${pKey}`, "batch_only", `${opName} cannot be expressed on the command line.`, 'Describe it in an "atc batch" plan.'));
      } else {
        const v = takeValue();
        if (v !== null) params[pKey] = parseScalar(spec, v);
      }
      continue;
    }
    const execType = EXEC_LEVEL_FLAGS[name];
    if (execType) {
      if (execType === "boolean") execFlags[name] = negated ? false : inlineVal === undefined ? true : !/^(false|0|no|off)$/i.test(inlineVal);
      else {
        const v = takeValue();
        if (v !== null) execFlags[name] = v;
      }
      continue;
    }
    if (name === "cwd" || name === "env") {
      if (inlineVal === undefined && i + 1 < rest.length && !rest[i + 1].startsWith("--")) i++;
      errors.push(
        err(`/${name}`, "batch_only", `--${rawName} is not available on "atc exec"; it needs ceremony.`, 'Use an "atc batch" plan, which supports cwd and env per step.'),
      );
      continue;
    }
    errors.push(
      err(
        `/${name}`,
        "unknown_flag",
        `Unknown option --${rawName} for ${opName}.`,
        `${didYouMean(name, [...Object.keys(op.params), ...Object.keys(EXEC_LEVEL_FLAGS)]) || ""} Options: ${Object.keys(op.params).join(", ")}. Request others at ${FEATURE_REQUEST_URL}.`.trim(),
      ),
    );
  }
  if (positionals.length > 0) {
    if (!op.positional) {
      errors.push(err("/", "unexpected_argument", `${opName} takes no positional arguments (got "${positionals[0]}").`));
    } else if (Array.isArray(op.positional)) {
      if (positionals.length > op.positional.length) {
        errors.push(err("/", "unexpected_argument", `${opName} takes at most ${op.positional.length} positional arguments (${op.positional.join(", ")}).`));
      } else {
        positionals.forEach((v, i) => {
          params[op.positional[i]] = parseScalar(op.params[op.positional[i]], v);
        });
      }
    } else {
      const spec = op.params[op.positional];
      if (/\[\]$/.test(spec.type)) {
        params[op.positional] = [...(params[op.positional] || []), ...positionals];
      } else if (positionals.length > 1) {
        errors.push(err("/", "unexpected_argument", `${opName} takes a single ${op.positional} (got ${positionals.length}).`));
      } else {
        params[op.positional] = parseScalar(spec, positionals[0]);
      }
    }
  }
  return { opName, params, execFlags, errors };
}

const STEP_COMMON_FIELDS = new Set([
  "id",
  "op",
  "dependsOn",
  "cwd",
  "env",
  "claim",
  "timeoutSec",
  "continueOnError",
  "force",
]);

// Validate a batch plan. ctx: { cwd, existsDir(p) } — existsDir defaults to fs check.
export function validateBatchPlan(plan, ctx = {}) {
  const errors = [];
  const overridden = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { errors: [err("/", "type", "The plan must be a JSON object.")], overridden, order: [] };
  }
  for (const key of Object.keys(plan)) {
    if (!["version", "steps"].includes(key)) {
      errors.push(err(`/${key}`, "unknown_field", `Unknown top-level field "${key}".`, didYouMean(key, ["version", "steps"])));
    }
  }
  if (plan.version !== 1) errors.push(err("/version", "version", "Expected \"version\": 1."));
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push(err("/steps", "required", "Expected a non-empty \"steps\" array."));
    return { errors, overridden, order: [] };
  }
  const ids = new Map();
  plan.steps.forEach((step, i) => {
    const p = `/steps/${i}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      errors.push(err(p, "type", "Each step must be an object."));
      return;
    }
    if (typeof step.id !== "string" || !PATTERNS.stepId.re.test(step.id)) {
      errors.push(err(`${p}/id`, "pattern_mismatch", `Each step needs an "id" that is ${PATTERNS.stepId.label}.`));
    } else if (ids.has(step.id)) {
      errors.push(err(`${p}/id`, "duplicate_id", `Duplicate id "${step.id}" (first used at /steps/${ids.get(step.id)}).`));
    } else {
      ids.set(step.id, i);
    }
  });
  const stepById = new Map();
  plan.steps.forEach((step, i) => {
    if (step && typeof step === "object" && typeof step.id === "string" && ids.get(step.id) === i) stepById.set(step.id, step);
  });
  plan.steps.forEach((step, i) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return;
    const p = `/steps/${i}`;
    const op = OPS[step.op];
    if (typeof step.op !== "string") {
      errors.push(err(`${p}/op`, "required", "Each step needs an \"op\"."));
      return;
    }
    if (!op) {
      errors.push(
        err(`${p}/op`, "unknown_op", `"${step.op}" is not a supported operation.`, `${didYouMean(step.op, Object.keys(OPS)) || ""} Request others at ${FEATURE_REQUEST_URL}.`.trim()),
      );
      return;
    }
    const force = step.force;
    let forceOn = false;
    if (force !== undefined) {
      if (!force || typeof force !== "object" || typeof force.reason !== "string" || force.reason.trim().length < 3) {
        errors.push(err(`${p}/force`, "force_reason_required", '"force" must be { "reason": "<why you take responsibility>" }.'));
      } else {
        forceOn = true;
      }
    }
    const opParams = {};
    for (const [k, v] of Object.entries(step)) {
      // timeoutSec is both a step field and a bazel.run param: pass it through where declared.
      if (!STEP_COMMON_FIELDS.has(k) || (k === "timeoutSec" && op.params.timeoutSec)) opParams[k] = v;
    }
    const res = validateOpParams(step.op, opParams, { force: forceOn, basePath: p });
    errors.push(...res.errors);
    overridden.push(...res.overridden.map((o) => ({ ...o, stepId: step.id })));
    if (step.dependsOn !== undefined) {
      if (!Array.isArray(step.dependsOn) || step.dependsOn.some((d) => typeof d !== "string")) {
        errors.push(err(`${p}/dependsOn`, "type", "Expected an array of step ids."));
      } else {
        step.dependsOn.forEach((d, j) => {
          if (d === step.id) errors.push(err(`${p}/dependsOn/${j}`, "self_dependency", "A step cannot depend on itself."));
          else if (!stepById.has(d)) {
            errors.push(err(`${p}/dependsOn/${j}`, "unknown_dependency", `Unknown step "${d}".`, didYouMean(d, [...stepById.keys()])));
          }
        });
      }
    }
    if (step.cwd !== undefined) {
      if (typeof step.cwd !== "string" || !isSafePathSyntax(step.cwd)) {
        errors.push(err(`${p}/cwd`, "path_syntax", "Expected a path without NUL/newline characters that does not start with '-'."));
      } else if (ctx.existsDir && !ctx.existsDir(path.resolve(ctx.cwd || process.cwd(), step.cwd))) {
        errors.push(err(`${p}/cwd`, "not_found", `Directory "${step.cwd}" does not exist.`));
      }
    }
    if (step.env !== undefined) {
      if (!step.env || typeof step.env !== "object" || Array.isArray(step.env)) {
        errors.push(err(`${p}/env`, "type", "Expected an object of literal string values."));
      } else {
        for (const [k, v] of Object.entries(step.env)) {
          if (!PATTERNS.envKey.re.test(k)) errors.push(err(`${p}/env/${k}`, "pattern_mismatch", `"${k}" is not ${PATTERNS.envKey.label}.`));
          if (typeof v !== "string" || !PATTERNS.transportSafe.re.test(v)) {
            errors.push(err(`${p}/env/${k}`, "pattern_mismatch", `Env values must be ${PATTERNS.transportSafe.label}.`));
          }
        }
      }
    }
    if (step.timeoutSec !== undefined && (!Number.isInteger(step.timeoutSec) || step.timeoutSec < 1 || step.timeoutSec > 86400)) {
      errors.push(err(`${p}/timeoutSec`, "range", "Expected an integer between 1 and 86400."));
    }
    if (step.continueOnError !== undefined && typeof step.continueOnError !== "boolean") {
      errors.push(err(`${p}/continueOnError`, "type", "Expected true or false."));
    }
    // Claims (device classification only runs on type-valid params)
    const paramsValid = res.errors.length === 0;
    const coupled = paramsValid && Boolean(op.deviceCoupled && op.deviceCoupled(opParams));
    const needsDevice = op.kind === "device" || op.kind === "snapshot" || coupled;
    const platform = op.platform || (coupled ? op.devicePlatform : null);
    if (step.claim !== undefined) {
      if (!step.claim || typeof step.claim !== "object" || Array.isArray(step.claim)) {
        errors.push(err(`${p}/claim`, "type", 'Expected a claim profile object or { "reuse": "<stepId>" }.'));
      } else if (step.claim.reuse !== undefined) {
        const extra = Object.keys(step.claim).filter((k) => k !== "reuse");
        if (extra.length) errors.push(err(`${p}/claim/${extra[0]}`, "unknown_field", '"reuse" cannot be combined with profile fields.'));
        const producer = stepById.get(step.claim.reuse);
        if (!producer) {
          errors.push(err(`${p}/claim/reuse`, "unknown_dependency", `Unknown step "${step.claim.reuse}".`, didYouMean(step.claim.reuse, [...stepById.keys()])));
        } else if (!producer.claim || producer.claim.reuse !== undefined) {
          errors.push(err(`${p}/claim/reuse`, "claim_reuse_invalid", `Step "${step.claim.reuse}" does not claim a device itself.`));
        } else if (!isAncestor(stepById, step.claim.reuse, step.id)) {
          errors.push(err(`${p}/claim/reuse`, "claim_reuse_not_ancestor", `Step "${step.claim.reuse}" must be an ancestor (via dependsOn) of "${step.id}".`));
        } else if (platform && claimPlatform(producer.claim) && claimPlatform(producer.claim) !== platform) {
          errors.push(err(`${p}/claim/reuse`, "platform_mismatch", `Step "${step.claim.reuse}" claims a ${claimPlatform(producer.claim)} device, but ${step.op} needs ${platform}.`));
        }
        if (!needsDevice && paramsValid) {
          errors.push(err(`${p}/claim`, "claim_unused", `${step.op} does not use a device here; remove the claim reuse so the device isn't held during this step.`));
        }
      } else {
        errors.push(...validateClaimProfile(step.claim, `${p}/claim`));
        const cp = claimPlatform(step.claim);
        if (platform && cp && cp !== platform) {
          errors.push(err(`${p}/claim/platform`, "platform_mismatch", `${step.op} needs a ${platform} device, but the claim is for ${cp}.`));
        }
        if (!needsDevice && paramsValid) {
          errors.push(err(`${p}/claim`, "claim_unused", `${step.op} does not use a device here; remove the claim.`));
        }
      }
    } else if (needsDevice) {
      const leaseCount = ctx.sessionLeaseCount ? ctx.sessionLeaseCount(platform) : ctx.sessionHasLease?.(platform) ? 1 : 0;
      if (leaseCount === 0) {
        errors.push(
          err(`${p}/claim`, "claim_required", `${step.op} needs a ${platform || "device"} device.`, `Add "claim": { "platform": "${platform || "android"}", ... } or { "reuse": "<stepId>" }.`),
        );
      } else if (leaseCount > 1) {
        errors.push(
          err(
            `${p}/claim`,
            "claim_ambiguous",
            `This session holds ${leaseCount} ${platform || "device"} leases, so ${step.op} can't pick one.`,
            `Add "claim": { "platform": "${platform || "android"}", ... } or { "reuse": "<stepId>" } to this step.`,
          ),
        );
      }
    }
  });
  const order = errors.some((e) => e.code === "unknown_dependency" || e.code === "duplicate_id") ? [] : topoOrder(plan.steps, errors);
  return { errors, overridden, order };
}

const CLAIM_FIELDS = {
  platform: { type: "enum", values: ["android", "ios"], required: true },
  kind: { type: "enum", values: ["emulator", "physical"] },
  type: { type: "string", pattern: "transportSafe" },
  api: { type: "string", pattern: "versionSpec" },
  os: { type: "string", pattern: "versionSpec" },
  play: { type: "boolean" },
  abi: { type: "string", pattern: "transportSafe" },
  services: { type: "string", pattern: "transportSafe" },
  snapshotLoad: { type: "string", pattern: "snapshotName" },
  ttlSec: { type: "integer", min: 30, max: 86400 },
};

function validateClaimProfile(claim, p) {
  return validateObject(CLAIM_FIELDS, claim, p, { force: false, overridden: [] });
}

function claimPlatform(claim) {
  return claim && typeof claim === "object" ? claim.platform || null : null;
}

function isAncestor(stepById, ancestorId, stepId, seen = new Set()) {
  const step = stepById.get(stepId);
  if (!step || !Array.isArray(step.dependsOn)) return false;
  for (const d of step.dependsOn) {
    if (d === ancestorId) return true;
    if (seen.has(d)) continue;
    seen.add(d);
    if (isAncestor(stepById, ancestorId, d, seen)) return true;
  }
  return false;
}

function topoOrder(steps, errors) {
  const idx = new Map(steps.map((s, i) => [s?.id, i]));
  const state = new Map();
  const out = [];
  const visit = (id, trail) => {
    if (state.get(id) === 2) return true;
    if (state.get(id) === 1) {
      const cycle = [...trail.slice(trail.indexOf(id)), id];
      errors.push(err(`/steps/${idx.get(id)}/dependsOn`, "cycle", `Dependency cycle: ${cycle.join(" → ")}.`));
      return false;
    }
    state.set(id, 1);
    const step = steps[idx.get(id)];
    for (const d of Array.isArray(step?.dependsOn) ? step.dependsOn : []) {
      if (idx.has(d) && !visit(d, [...trail, id])) return false;
    }
    state.set(id, 2);
    out.push(id);
    return true;
  };
  for (const s of steps) {
    if (s && typeof s.id === "string" && !visit(s.id, [])) return [];
  }
  return out;
}

export function formatErrors(errors) {
  return errors
    .map((e) => `  ${e.path || "/"}: ${e.message}${e.hint ? `\n      → ${e.hint}` : ""}`)
    .join("\n");
}
