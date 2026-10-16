import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPS, OpError, listOps, resolveOpName } from "../src/ops/catalog.mjs";
import {
  PATTERNS,
  WINDOWS_BATCH_ARG_RE,
  WINDOWS_BATCH_PATH_FORBIDDEN_RE,
  checkPattern,
  isSafePathSyntax,
  quoteRemote,
} from "../src/ops/patterns.mjs";
import { formatErrors, parseOpArgv, suggest, validateBatchPlan, validateOpParams } from "../src/validate.mjs";

function tmpDir(prefix = "atc-ops-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(file, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  fs.chmodSync(file, mode);
  return file;
}

const androidLease = { serial: "emulator-5554" };
const iosLease = { serial: "11111111-2222-3333-4444-555555555555" };

// ---------------------------------------------------------------- patterns

test("patterns: gradle task names and paths", () => {
  for (const ok of ["assembleDebug", ":app:test", "app:connectedDebugAndroidTest", ":lib-core:check"]) {
    assert.ok(checkPattern("gradleTask", ok), ok);
  }
  for (const bad of ["-x", "--offline", "a;b", "a b", "$(id)", "", "::a", "a:"]) {
    assert.ok(!checkPattern("gradleTask", bad), bad);
  }
});

test("patterns: bazel labels", () => {
  for (const ok of ["//...", "//app:tests", "@repo//pkg:t", "//a/b/c:all"]) assert.ok(checkPattern("bazelTarget", ok), ok);
  for (const ok of ["app:tests", "--config=x", "//a;b", "//a b"]) assert.ok(!checkPattern("bazelTarget", ok), ok);
});

test("patterns: transport-safe rejects quotes, spaces and shell metacharacters", () => {
  assert.ok(checkPattern("transportSafe", "debug.flag=1,a/b:c@d+e"));
  for (const bad of ["a b", "a'b", 'a"b', "a;b", "$x", "a`b", "a|b", "a&b", "a>b", "-flag"]) {
    assert.ok(!checkPattern("transportSafe", bad), bad);
  }
  assert.equal(PATTERNS.transportSafe.forceable, false);
});

test("patterns: device identifiers are not forceable", () => {
  for (const k of ["androidPackage", "androidActivity", "androidPermission", "iosBundleId", "url", "propKey", "snapshotName"]) {
    assert.equal(PATTERNS[k].forceable, false, k);
  }
  for (const k of ["gradleTask", "bazelTarget", "xcodeName"]) assert.equal(PATTERNS[k].forceable, true, k);
});

test("patterns: urls without metacharacters", () => {
  assert.ok(checkPattern("url", "myapp://open/item?id=3"));
  assert.ok(checkPattern("url", "https://example.com/a"));
  for (const bad of ["https://x y", "myapp://a;rm", "x'y:z", "noscheme"]) assert.ok(!checkPattern("url", bad), bad);
});

test("patterns: path syntax and windows rules", () => {
  assert.ok(isSafePathSyntax("app/build/out.apk"));
  assert.ok(isSafePathSyntax("dir with spaces/a.apk"));
  assert.ok(!isSafePathSyntax("-rf"));
  assert.ok(!isSafePathSyntax("a\nb"));
  assert.ok(!isSafePathSyntax(""));
  assert.ok(WINDOWS_BATCH_ARG_RE.test(":app:assembleDebug"));
  assert.ok(!WINDOWS_BATCH_ARG_RE.test("%PATH%"));
  assert.ok(!WINDOWS_BATCH_ARG_RE.test("a&b"));
  assert.ok(WINDOWS_BATCH_PATH_FORBIDDEN_RE.test("C:\\work\\%NAME%\\gradlew.bat"));
  assert.ok(!WINDOWS_BATCH_PATH_FORBIDDEN_RE.test("C:\\My Projects\\app\\gradlew.bat"));
  assert.equal(quoteRemote("com.example"), "'com.example'");
});

// ---------------------------------------------------------------- catalog

test("catalog: every op has a system, kind and params", () => {
  for (const op of listOps()) {
    assert.ok(op.name.startsWith(`${op.system}.`), op.name);
    assert.ok(["build", "device", "snapshot"].includes(op.kind), op.name);
    assert.equal(typeof op.params, "object", op.name);
    if (op.positional) for (const p of [op.positional].flat()) assert.ok(op.params[p], `${op.name} positional ${p}`);
    if (op.kind !== "snapshot") assert.equal(typeof op.invocations, "function", op.name);
  }
  for (const required of ["android.prop.get", "android.prop.set", "android.permission", "ios.privacy", "snapshot.save", "snapshot.load", "bazel.clean", "xcode.clean"]) {
    assert.ok(OPS[required], required);
  }
});

test("catalog: resolveOpName handles kebab-case verbs", () => {
  assert.equal(resolveOpName("xcode", "build-for-testing"), "xcode.buildForTesting");
  assert.equal(resolveOpName("gradle", "tasks"), "gradle.tasks");
  assert.equal(resolveOpName("git", "status"), null);
  assert.equal(resolveOpName("gradle", "nope"), null);
});

test("gradle.tasks: resolves wrapper upwards and builds literal argv", () => {
  const root = tmpDir();
  const wrapper = touch(path.join(root, "gradlew"));
  const sub = path.join(root, "app", "src");
  fs.mkdirSync(sub, { recursive: true });
  const inv = OPS["gradle.tasks"].invocations(
    { tasks: [":app:assembleDebug"], offline: true, properties: { flavor: "free" } },
    { cwd: sub, platform: "darwin" },
  );
  assert.deepEqual(inv, [{ cmd: wrapper, args: [":app:assembleDebug", "--offline", "-Pflavor=free"], cwd: root }]);
});

test("gradle.tasks: missing wrapper is a clear error", () => {
  const root = tmpDir();
  assert.throws(
    () => OPS["gradle.tasks"].invocations({ tasks: ["build"] }, { cwd: root, platform: "darwin" }),
    (e) => e instanceof OpError && e.code === "gradle_wrapper_not_found",
  );
});

test("gradle.tasks: windows uses gradlew.bat", () => {
  const root = tmpDir();
  const bat = touch(path.join(root, "gradlew.bat"));
  const [inv] = OPS["gradle.tasks"].invocations({ tasks: ["build"] }, { cwd: root, platform: "win32" });
  assert.equal(inv.cmd, bat);
});

test("gradle.tasks: device coupling and split notice", () => {
  const op = OPS["gradle.tasks"];
  assert.equal(op.deviceCoupled({ tasks: ["assembleDebug"] }), false);
  assert.equal(op.deviceCoupled({ tasks: [":app:connectedDebugAndroidTest"] }), true);
  const notices = op.notices({ tasks: ["assembleDebug", "connectedDebugAndroidTest"] });
  assert.equal(notices.length, 1);
  assert.match(notices[0].fix, /Split/);
  assert.deepEqual(op.notices({ tasks: ["connectedDebugAndroidTest"] }), []);
});

test("bazel: prefers bazelw, then bazelisk, then bazel", () => {
  const root = tmpDir();
  touch(path.join(root, "MODULE.bazel"), 0o644);
  const ctx = { cwd: root, platform: "darwin", which: () => null };
  assert.deepEqual(OPS["bazel.build"].invocations({ targets: ["//..."], configs: ["ci"], keepGoing: true }, ctx), [
    { cmd: "bazel", args: ["build", "--config=ci", "--keep_going", "//..."], cwd: root },
  ]);
  const withIsk = { ...ctx, which: (n) => (n === "bazelisk" ? "/opt/bin/bazelisk" : null) };
  assert.equal(OPS["bazel.test"].invocations({ targets: ["//a:t"] }, withIsk)[0].cmd, "/opt/bin/bazelisk");
  const bazelw = touch(path.join(root, "bazelw"));
  assert.equal(OPS["bazel.test"].invocations({ targets: ["//a:t"] }, withIsk)[0].cmd, bazelw);
});

test("bazel: missing workspace is a clear error", () => {
  assert.throws(
    () => OPS["bazel.build"].invocations({ targets: ["//..."] }, { cwd: tmpDir(), which: () => null }),
    (e) => e.code === "bazel_workspace_not_found",
  );
});

test("bazel.series: one invocation per entry, clean with expunge", () => {
  const root = tmpDir();
  touch(path.join(root, "WORKSPACE"), 0o644);
  const inv = OPS["bazel.series"].invocations(
    { series: [{ command: "clean", expunge: true }, { command: "build", targets: ["//a"] }, { command: "test", targets: ["//a:t"], configs: ["ci"] }] },
    { cwd: root, which: () => null },
  );
  assert.deepEqual(
    inv.map((i) => i.args),
    [["clean", "--expunge"], ["build", "//a"], ["test", "--config=ci", "//a:t"]],
  );
});

test("bazel.run: timeout required and run args after --", () => {
  const root = tmpDir();
  touch(path.join(root, "MODULE.bazel"), 0o644);
  const { errors } = validateOpParams("bazel.run", { target: "//tools:gen" });
  assert.ok(errors.some((e) => e.path === "/timeoutSec" && e.code === "required"));
  const [inv] = OPS["bazel.run"].invocations({ target: "//tools:gen", runArgs: ["--out=x"], timeoutSec: 60 }, { cwd: root, which: () => null });
  assert.deepEqual(inv.args, ["run", "//tools:gen", "--", "--out=x"]);
  assert.equal(inv.timeoutSec, 60);
});

test("xcode: destination only for test actions on the leased simulator", () => {
  const op = OPS["xcode.test"];
  const ctx = { cwd: "/w", lease: iosLease };
  const [inv] = op.invocations({ scheme: "App", project: "App.xcodeproj" }, ctx);
  assert.deepEqual(inv.args, ["-project", path.resolve("/w", "App.xcodeproj"), "-scheme", "App", "test", "-destination", `id=${iosLease.serial}`]);
  assert.equal(op.deviceCoupled({ scheme: "App" }), true);
  assert.equal(op.deviceCoupled({ scheme: "App", testDestination: "macos" }), false);
  const [mac] = op.invocations({ scheme: "App", testDestination: "macos" }, { cwd: "/w" });
  assert.deepEqual(mac.args.slice(-2), ["-destination", "platform=macOS"]);
  const [build] = OPS["xcode.build"].invocations({ scheme: "App" }, ctx);
  assert.ok(!build.args.includes("-destination"));
  assert.equal(OPS["xcode.build"].deviceCoupled({ scheme: "App" }), false);
});

test("android ops: adb -s <serial> with single-quoted remote values", () => {
  const ctx = { cwd: "/w", lease: androidLease };
  assert.deepEqual(OPS["android.install"].invocations({ apk: "app.apk", replace: true }, ctx), [
    { cmd: "adb", args: ["-s", "emulator-5554", "install", "-r", path.resolve("/w", "app.apk")] },
  ]);
  assert.deepEqual(OPS["android.launch"].invocations({ package: "com.ex.app", activity: ".Main" }, ctx)[0].args, [
    "-s",
    "emulator-5554",
    "shell",
    "am start -n 'com.ex.app/.Main'",
  ]);
  assert.equal(
    OPS["android.permission"].invocations({ package: "com.ex", permission: "android.permission.CAMERA", action: "grant" }, ctx)[0].args[3],
    "pm grant 'com.ex' 'android.permission.CAMERA'",
  );
  assert.equal(OPS["android.prop.set"].invocations({ key: "debug.x", value: "1" }, ctx)[0].args[3], "setprop 'debug.x' '1'");
  assert.equal(OPS["android.prop.get"].invocations({ key: "ro.build.version.sdk" }, ctx)[0].args[3], "getprop 'ro.build.version.sdk'");
  assert.deepEqual(OPS["android.logcat"].invocations({ lines: 50, filters: ["*:E"] }, ctx)[0].args, ["-s", "emulator-5554", "logcat", "-d", "-t", "50", "*:E"]);
  assert.equal(OPS["android.screenshot"].invocations({ output: "s.png" }, ctx).length, 3);
});

test("device ops without a lease fail with claim_required", () => {
  assert.throws(() => OPS["android.uninstall"].invocations({ package: "com.ex" }, { cwd: "/w" }), (e) => e.code === "claim_required");
  assert.throws(() => OPS["ios.terminate"].invocations({ bundleId: "com.ex" }, { cwd: "/w" }), (e) => e.code === "claim_required");
});

test("ios ops: xcrun simctl <verb> <udid>", () => {
  const ctx = { cwd: "/w", lease: iosLease };
  assert.deepEqual(OPS["ios.launch"].invocations({ bundleId: "com.ex.App", launchArgs: ["-flag"].slice(0, 0) }, ctx)[0], {
    cmd: "xcrun",
    args: ["simctl", "launch", iosLease.serial, "com.ex.App"],
  });
  assert.deepEqual(OPS["ios.privacy"].invocations({ bundleId: "com.ex.App", service: "camera", action: "grant" }, ctx)[0].args, [
    "simctl",
    "privacy",
    iosLease.serial,
    "grant",
    "camera",
    "com.ex.App",
  ]);
  assert.deepEqual(OPS["ios.screenshot"].invocations({ output: "a.png" }, ctx)[0].args, ["simctl", "io", iosLease.serial, "screenshot", path.resolve("/w", "a.png")]);
});

// ---------------------------------------------------------------- validateOpParams

test("validateOpParams: collects all errors at once", () => {
  const { errors } = validateOpParams("gradle.tasks", { tasks: ["ok", "bad;task", "-x"], bogus: 1, offline: "yes" });
  const codes = errors.map((e) => `${e.path}:${e.code}`).sort();
  assert.deepEqual(codes, ["/bogus:unknown_field", "/offline:type", "/tasks/1:pattern_mismatch", "/tasks/2:pattern_mismatch"].sort());
  for (const e of errors) assert.ok(e.message);
});

test("validateOpParams: force overrides forceable patterns only", () => {
  const forced = validateOpParams("gradle.tasks", { tasks: ["weird+task"] }, { force: true });
  assert.deepEqual(forced.errors, []);
  assert.equal(forced.overridden.length, 1);
  assert.equal(forced.overridden[0].check, "pattern:gradleTask");
  const notForceable = validateOpParams("android.uninstall", { package: "com.ex;reboot" }, { force: true });
  assert.equal(notForceable.errors.length, 1);
  assert.equal(notForceable.errors[0].forceable, false);
  assert.match(notForceable.errors[0].hint, /github\.com\/rock3r\/atc\/issues/);
  const transport = validateOpParams("android.prop.set", { key: "a", value: "x y" }, { force: true });
  assert.equal(transport.errors.length, 1);
});

test("validateOpParams: unknown op, enum suggestion, conflicts, buildOnly", () => {
  const unknown = validateOpParams("gradle.task", {});
  assert.equal(unknown.errors[0].code, "unknown_op");
  assert.match(unknown.errors[0].hint, /gradle\.tasks/);
  const en = validateOpParams("android.permission", { package: "com.ex", permission: "a.b", action: "grnat" });
  assert.equal(en.errors[0].code, "enum");
  assert.match(en.errors[0].hint, /grant/);
  const conflict = validateOpParams("xcode.build", { scheme: "App", project: "a.xcodeproj", workspaceFile: "a.xcworkspace" });
  assert.ok(conflict.errors.some((e) => e.code === "conflict"));
  const bo = validateOpParams("gradle.tasks", { tasks: ["connectedCheck"], buildOnly: true });
  assert.ok(bo.errors.some((e) => e.code === "build_only_device"));
});

test("validateOpParams: bazel.series semantic checks", () => {
  const { errors } = validateOpParams("bazel.series", {
    series: [{ command: "build" }, { command: "clean", targets: ["//a"] }, { command: "test", targets: ["//a"], expunge: true }],
  });
  assert.deepEqual(errors.map((e) => e.path), ["/series/0/targets", "/series/1/targets", "/series/2/expunge"]);
});

test("suggest and formatErrors", () => {
  assert.equal(suggest("gradel", ["gradle", "bazel"]), "gradle");
  assert.equal(suggest("zzzzzz", ["gradle"]), null);
  const text = formatErrors([{ path: "/a", message: "bad", hint: "fix it" }]);
  assert.match(text, /\/a: bad/);
  assert.match(text, /fix it/);
});

// ---------------------------------------------------------------- parseOpArgv

test("parseOpArgv: positionals, flags, kebab-case, repeated arrays", () => {
  const r = parseOpArgv(["gradle", "tasks", ":app:assembleDebug", "lint", "--offline", "--property", "a=b", "--brief", "--json"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.opName, "gradle.tasks");
  assert.deepEqual(r.params, { tasks: [":app:assembleDebug", "lint"], offline: true, properties: { a: "b" }, brief: true });
  assert.deepEqual(r.execFlags, { json: true });
  const x = parseOpArgv(["xcode", "build-for-testing", "--scheme", "My App", "--only-testing", "T/A", "--only-testing=T/B"]);
  assert.equal(x.opName, "xcode.buildForTesting");
  assert.deepEqual(x.params, { scheme: "My App", onlyTesting: ["T/A", "T/B"] });
});

test("parseOpArgv: two-word verbs", () => {
  const r = parseOpArgv(["android", "prop", "get", "ro.product.model", "--serial", "emulator-5554"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.opName, "android.prop.get");
  assert.deepEqual(r.params, { key: "ro.product.model" });
  assert.deepEqual(r.execFlags, { serial: "emulator-5554" });
});

test("parseOpArgv: integers are parsed", () => {
  const r = parseOpArgv(["android", "logcat", "--lines", "200"]);
  assert.deepEqual(r.params, { lines: 200 });
});

test("parseOpArgv: raw commands are refused with an alternative", () => {
  const r = parseOpArgv(["--", "./gradlew", "assembleDebug"]);
  assert.equal(r.errors[0].code, "unsupported_raw_command");
  assert.match(r.errors[0].hint, /atc exec gradle tasks/);
});

test("parseOpArgv: unknown system/verb/flag and batch-only flags", () => {
  assert.equal(parseOpArgv(["git", "status"]).errors[0].code, "unknown_system");
  assert.match(parseOpArgv(["gradel", "tasks"]).errors[0].hint, /gradle/);
  assert.equal(parseOpArgv(["gradle", "run"]).errors[0].code, "unknown_op");
  assert.equal(parseOpArgv(["gradle"]).errors[0].code, "required");
  const f = parseOpArgv(["gradle", "tasks", "build", "--bogus", "--cwd", "/x", "--env", "A=B"]);
  assert.deepEqual(f.errors.map((e) => e.code).sort(), ["batch_only", "batch_only", "unknown_flag"]);
  const s = parseOpArgv(["bazel", "series", "--series", "x"]);
  assert.equal(s.errors[0].code, "batch_only");
  const pos = parseOpArgv(["snapshot", "list", "extra"]);
  assert.equal(pos.errors[0].code, "unexpected_argument");
  const two = parseOpArgv(["android", "install", "a.apk", "b.apk"]);
  assert.equal(two.errors[0].code, "unexpected_argument");
  const miss = parseOpArgv(["android", "launch", "--package"]);
  assert.equal(miss.errors[0].code, "missing_value");
});

test("parseOpArgv: --no-<bool> negation and force flags", () => {
  const r = parseOpArgv(["gradle", "tasks", "build", "--no-offline", "--force", "--reason", "custom task naming"]);
  assert.equal(r.params.offline, false);
  assert.deepEqual(r.execFlags, { force: true, reason: "custom task naming" });
});

// ---------------------------------------------------------------- validateBatchPlan

const okPlan = () => ({
  version: 1,
  steps: [
    { id: "assemble", op: "gradle.tasks", tasks: [":app:assembleDebug"] },
    { id: "install", op: "android.install", apk: "app/build/outputs/apk/debug/app-debug.apk", dependsOn: ["assemble"], claim: { platform: "android" } },
    { id: "launch", op: "android.launch", package: "com.ex.app", activity: ".Main", dependsOn: ["install"], claim: { reuse: "install" } },
  ],
});

test("validateBatchPlan: valid plan yields topological order", () => {
  const r = validateBatchPlan(okPlan());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.order, ["assemble", "install", "launch"]);
});

test("validateBatchPlan: structure errors collected together", () => {
  const r = validateBatchPlan({ version: 2, extra: true, steps: [{ id: "a b", op: "gradle.tasks", tasks: ["x"] }, { id: "c", op: "shell.run" }, { id: "c", op: "gradle.tasks", tasks: ["y"] }] });
  const codes = r.errors.map((e) => e.code);
  for (const c of ["unknown_field", "version", "pattern_mismatch", "unknown_op", "duplicate_id"]) assert.ok(codes.includes(c), c);
  assert.deepEqual(r.order, []);
  assert.equal(validateBatchPlan([]).errors[0].code, "type");
  assert.equal(validateBatchPlan({ version: 1, steps: [] }).errors[0].code, "required");
});

test("validateBatchPlan: dependency errors and cycles", () => {
  const r = validateBatchPlan({
    version: 1,
    steps: [
      { id: "a", op: "gradle.tasks", tasks: ["x"], dependsOn: ["b"] },
      { id: "b", op: "gradle.tasks", tasks: ["y"], dependsOn: ["a"] },
    ],
  });
  assert.ok(r.errors.some((e) => e.code === "cycle"));
  const self = validateBatchPlan({ version: 1, steps: [{ id: "a", op: "gradle.tasks", tasks: ["x"], dependsOn: ["a", "zz"] }] });
  assert.deepEqual(self.errors.map((e) => e.code).sort(), ["self_dependency", "unknown_dependency"]);
});

test("validateBatchPlan: step fields", () => {
  const r = validateBatchPlan(
    {
      version: 1,
      steps: [
        {
          id: "a",
          op: "gradle.tasks",
          tasks: ["x"],
          cwd: "missing-dir",
          env: { "BAD-KEY": "v", OK: "a b" },
          timeoutSec: 0,
          continueOnError: "yes",
          phase: "whatever",
          force: { reason: "" },
        },
      ],
    },
    { cwd: "/", existsDir: () => false },
  );
  const codes = r.errors.map((e) => `${e.path}:${e.code}`);
  for (const c of [
    "/steps/0/cwd:not_found",
    "/steps/0/env/BAD-KEY:pattern_mismatch",
    "/steps/0/env/OK:pattern_mismatch",
    "/steps/0/timeoutSec:range",
    "/steps/0/continueOnError:type",
    "/steps/0/phase:unknown_field",
    "/steps/0/force:force_reason_required",
  ]) {
    assert.ok(codes.includes(c), `${c} in ${codes.join(", ")}`);
  }
});

test("validateBatchPlan: step force overrides forceable patterns and is recorded", () => {
  const r = validateBatchPlan({ version: 1, steps: [{ id: "a", op: "gradle.tasks", tasks: ["odd+name"], force: { reason: "vendor plugin task" } }] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.overridden[0].stepId, "a");
});

test("validateBatchPlan: claim rules", () => {
  const missing = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "android.install", apk: "a.apk" }] });
  assert.equal(missing.errors[0].code, "claim_required");
  const withSession = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "android.install", apk: "a.apk" }] }, { sessionHasLease: (p) => p === "android" });
  assert.deepEqual(withSession.errors, []);
  const unused = validateBatchPlan({ version: 1, steps: [{ id: "b", op: "gradle.tasks", tasks: ["assembleDebug"], claim: { platform: "android" } }] });
  assert.equal(unused.errors[0].code, "claim_unused");
  const mismatch = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "ios.install", app: "A.app", claim: { platform: "android" } }] });
  assert.equal(mismatch.errors[0].code, "platform_mismatch");
  const badProfile = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "android.install", apk: "a.apk", claim: { platform: "android", api: "3 4", color: "red" } }] });
  assert.deepEqual(badProfile.errors.map((e) => e.code).sort(), ["pattern_mismatch", "unknown_field"]);
});

test("validateBatchPlan: claim reuse must reference a claiming ancestor", () => {
  const plan = okPlan();
  plan.steps[2].dependsOn = ["assemble"];
  assert.equal(validateBatchPlan(plan).errors[0].code, "claim_reuse_not_ancestor");
  const plan2 = okPlan();
  plan2.steps[2].claim = { reuse: "assemble" };
  assert.equal(validateBatchPlan(plan2).errors[0].code, "claim_reuse_invalid");
  const plan3 = okPlan();
  plan3.steps[2] = { id: "launch", op: "ios.launch", bundleId: "com.ex.App", dependsOn: ["install"], claim: { reuse: "install" } };
  assert.equal(validateBatchPlan(plan3).errors[0].code, "platform_mismatch");
  const plan4 = okPlan();
  plan4.steps[2].claim = { reuse: "install", platform: "android" };
  assert.equal(validateBatchPlan(plan4).errors[0].code, "unknown_field");
});

test("validateBatchPlan: device-coupled builds need a claim", () => {
  const r = validateBatchPlan({ version: 1, steps: [{ id: "t", op: "gradle.tasks", tasks: ["connectedDebugAndroidTest"] }] });
  assert.equal(r.errors[0].code, "claim_required");
  const ok = validateBatchPlan({ version: 1, steps: [{ id: "t", op: "gradle.tasks", tasks: ["connectedDebugAndroidTest"], claim: { platform: "android" } }] });
  assert.deepEqual(ok.errors, []);
});

// ---------------------------------------------------------------- documented CLI examples

test("documented CLI translations (docs/migration-3.0.md, guides) parse and validate", () => {
  const A = ["andr", "oid"].join("");
  const cases = [
    [["gradle", "tasks", ":app:assembleDebug", "--offline"], "gradle.tasks"],
    [["gradle", "tasks", "test", "--property", "flavor=free"], "gradle.tasks"],
    [["gradle", "tasks", "connectedDebugAndroidTest", "--claim", "--type", "phone", "--api", ">=35"], "gradle.tasks"],
    [["bazel", "build", "//app:main", "--config", "ci"], "bazel.build"],
    [["bazel", "test", "//app:tests", "--config", "ci", "--keep-going"], "bazel.test"],
    [["bazel", "clean", "--expunge"], "bazel.clean"],
    [["bazel", "run", "//tools:gen", "--run-arg=--out=x", "--timeout-sec", "300"], "bazel.run"],
    [["xcode", "test", "--scheme", "App"], "xcode.test"],
    [["xcode", "build-for-testing", "--scheme", "App", "--project", "App.xcodeproj"], "xcode.buildForTesting"],
    [["xcode", "test", "--scheme", "App", "--project", "App.xcodeproj", "--only-testing", "AppTests/LoginTests"], "xcode.test"],
    [[A, "install", "app.apk", "--replace"], `${A}.install`],
    [[A, "launch", "--package", "com.ex", "--activity", ".Main"], `${A}.launch`],
    [[A, "clear-data", "com.ex"], `${A}.clearData`],
    [[A, "permission", "--package", "com.ex", "--permission", `${A}.permission.CAMERA`, "--action", "grant"], `${A}.permission`],
    [[A, "prop", "get", "ro.product.model"], `${A}.prop.get`],
    [[A, "prop", "set", "debug.layout", "true"], `${A}.prop.set`],
    [[A, "prop", "set", "a", "b", "c"], null],
    [[A, "logcat", "--lines", "200", "--filter", "MyTag:D", "--filter", "*:S"], `${A}.logcat`],
    [["ios", "launch", "com.ex.App"], "ios.launch"],
    [["ios", "open-url", "myapp://settings"], "ios.openUrl"],
    [["ios", "privacy", "--bundle-id", "com.ex.App", "--service", "camera", "--action", "grant"], "ios.privacy"],
    [["snapshot", "save", "clean"], "snapshot.save"],
  ];
  for (const [argv, expected] of cases) {
    const r = parseOpArgv(argv);
    if (expected === null) {
      // too many positionals
      assert.ok(r.errors.length > 0, argv.join(" "));
      continue;
    }
    assert.deepEqual(r.errors, [], argv.join(" "));
    assert.equal(r.opName, expected, argv.join(" "));
    assert.deepEqual(validateOpParams(r.opName, r.params).errors, [], argv.join(" "));
  }
});

// ---------------------------------------------------------------- review fixes

test("parseOpArgv: --no-<flag> negates exec-level boolean selectors", () => {
  const r = parseOpArgv(["gradle", "tasks", "connectedCheck", "--claim", "--no-play"]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.execFlags, { claim: true, play: false });
});

test("xcode ops run from and resolve paths against the workspace param", () => {
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, "ios"));
  const ctx = { cwd: repo, lease: null };
  const [inv] = OPS["xcode.build"].invocations({ scheme: "App", workspace: "ios", project: "App.xcodeproj", derivedDataPath: "dd" }, ctx);
  assert.equal(inv.cwd, path.join(repo, "ios"));
  assert.deepEqual(inv.args, ["-project", path.join(repo, "ios", "App.xcodeproj"), "-scheme", "App", "-derivedDataPath", path.join(repo, "ios", "dd"), "build"]);
  const [plain] = OPS["xcode.actions"].invocations({ scheme: "App", actions: ["clean", "build"] }, ctx);
  assert.equal(plain.cwd, repo);
});

test("build ops refuse a nonexistent workspace instead of walking up to a parent project", () => {
  const repo = tmpDir();
  touch(path.join(repo, "gradlew"));
  touch(path.join(repo, "MODULE.bazel"), 0o644);
  for (const [op, params] of [
    ["gradle.tasks", { tasks: ["build"], workspace: "does-not-exist" }],
    ["bazel.build", { targets: ["//..."], workspace: "does-not-exist" }],
    ["xcode.build", { scheme: "App", workspace: "does-not-exist" }],
  ]) {
    assert.throws(() => OPS[op].invocations(params, { cwd: repo, platform: "darwin", which: () => null }), (e) => e.code === "workspace_not_found", op);
  }
});

test("validateBatchPlan: wrong param types are reported, never thrown", () => {
  const r = validateBatchPlan({
    version: 1,
    steps: [
      { id: "a", op: "gradle.tasks", tasks: "assemble", claim: { platform: "android" } },
      { id: "b", op: "xcode.actions", scheme: "App", actions: "test" },
    ],
  });
  const codes = r.errors.map((e) => `${e.path}:${e.code}`);
  assert.ok(codes.includes("/steps/0/tasks:type"), codes.join(", "));
  assert.ok(codes.includes("/steps/1/actions:type"), codes.join(", "));
  assert.ok(!codes.some((c) => c.includes("claim_unused")), "no spurious claim errors on invalid params");
});

test("bazel.clean accepts the shared build params", () => {
  assert.deepEqual(validateOpParams("bazel.clean", { expunge: true, ramMb: 4096, buildOnly: true, brief: true, workspace: "." }).errors, []);
});

test("validateBatchPlan: claim version selectors accept the atc claim grammar", () => {
  for (const api of ["36", ">=35", "34..36", "android-35"]) {
    const r = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "android.install", apk: "a.apk", claim: { platform: "android", api } }] });
    assert.deepEqual(r.errors, [], api);
  }
  const ios = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "ios.install", app: "A.app", claim: { platform: "ios", os: ">=18.0" } }] });
  assert.deepEqual(ios.errors, []);
  const bad = validateBatchPlan({ version: 1, steps: [{ id: "i", op: "android.install", apk: "a.apk", claim: { platform: "android", api: ">=35;rm" } }] });
  assert.equal(bad.errors[0].code, "pattern_mismatch");
});

test("ios ops refuse physical leases (simctl is simulator-only)", () => {
  assert.throws(
    () => OPS["ios.launch"].invocations({ bundleId: "com.ex.App" }, { cwd: "/", lease: { serial: "00008120-000464CE2E44C01E", kind: "physical" } }),
    (e) => e.code === "simulator_only",
  );
});
