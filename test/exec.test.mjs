import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdClaim, cmdExec } from "../src/cli.mjs";
import { checkWindowsContract, execHelp, planOp, summarizeBriefOutput } from "../src/exec.mjs";
import { readState } from "../src/state.mjs";

function tmp(prefix = "atc-exec-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const posix = process.platform !== "win32";

const mockInventory = {
  host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
  running: [
    {
      deviceKey: "avd:Pixel_8_API_35",
      avd: "Pixel_8_API_35",
      serial: "emulator-5554",
      kind: "emulator",
      online: true,
      ramSizeMb: 2048,
      requiredRamMb: 3072,
      dataDiskMb: 6656,
      snapshots: [],
      profile: { deviceType: "phone", deviceName: "pixel_8", apiLevel: "android-35", services: "google_apis", playStore: false, abi: "arm64-v8a" },
    },
  ],
  offline: [],
  creatable: [],
};

function setup() {
  const root = tmp();
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ATC_STATE_DIR: stateDir };
  return { root, stateDir, bin, proj, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("exec: gradle.tasks runs the wrapper with literal argv and resource caps", { skip: !posix }, async () => {
  const s = setup();
  try {
    script(path.join(s.proj, "gradlew"), 'echo "ARGS:$*"');
    const res = await cmdExec(s.stateDir, ["gradle", "tasks", ":app:assembleDebug", "--offline", "--json"], { env: s.env, cwd: s.proj });
    assert.equal(res.exitCode, 0, res.error);
    assert.equal(res.steps.length, 1);
    assert.equal(res.steps[0].args[0], ":app:assembleDebug");
    assert.equal(res.steps[0].args[1], "--offline");
    assert.match(res.steps[0].args[2], /^-Dorg\.gradle\.workers\.max=\d+$/);
    assert.match(res.stdout, /ARGS::app:assembleDebug --offline -Dorg/);
    const st = readState(s.stateDir);
    assert.deepEqual(Object.keys(st.buildLeases || {}), [], "build lease released");
  } finally {
    s.cleanup();
  }
});

test("exec: validation errors are collected and nothing runs", async () => {
  const s = setup();
  try {
    const marker = path.join(s.root, "ran");
    script(path.join(s.proj, "gradlew"), `touch ${marker}`);
    const res = await cmdExec(s.stateDir, ["gradle", "tasks", "a;b", "--bogus", "--cwd", "/x"], { env: s.env, cwd: s.proj });
    assert.equal(res.exitCode, 7);
    assert.equal(res.errors.length, 3);
    assert.ok(!fs.existsSync(marker));
  } finally {
    s.cleanup();
  }
});

test("exec: --claim on a pure build is rejected as claim_unused", async () => {
  const s = setup();
  try {
    script(path.join(s.proj, "gradlew"), "exit 0");
    const res = await cmdExec(s.stateDir, ["gradle", "tasks", "assembleDebug", "--claim"], { env: s.env, cwd: s.proj });
    assert.equal(res.exitCode, 7);
    assert.equal(res.errors[0].code, "claim_unused");
  } finally {
    s.cleanup();
  }
});

test("exec: --force needs a reason, is recorded, and cannot unlock leading-dash values", { skip: !posix }, async () => {
  const s = setup();
  try {
    script(path.join(s.proj, "gradlew"), "exit 0");
    const noReason = await cmdExec(s.stateDir, ["gradle", "tasks", "odd+name", "--force"], { env: s.env, cwd: s.proj });
    assert.equal(noReason.exitCode, 7);
    assert.equal(noReason.errors[0].code, "force_reason_required");
    const dash = await cmdExec(s.stateDir, ["gradle", "tasks", "-x", "--force", "--reason", "please"], { env: s.env, cwd: s.proj });
    assert.equal(dash.exitCode, 7);
    assert.equal(dash.errors[0].forceable, false);
    const ok = await cmdExec(s.stateDir, ["gradle", "tasks", "odd+name", "--force", "--reason", "vendor plugin task", "--json"], { env: s.env, cwd: s.proj });
    assert.equal(ok.exitCode, 0, ok.error);
    assert.ok(ok.forcedRunId);
    const st = readState(s.stateDir);
    assert.equal(st.forcedRuns.length, 1);
    assert.equal(st.forcedRuns[0].reason, "vendor plugin task");
    assert.equal(st.forcedRuns[0].op, "gradle.tasks");
    assert.equal(st.forcedRuns[0].overridden[0].value, "odd+name");
  } finally {
    s.cleanup();
  }
});

test("exec: --brief writes a full log and condenses failures", { skip: !posix }, async () => {
  const s = setup();
  try {
    script(path.join(s.proj, "gradlew"), 'i=0; while [ $i -lt 100 ]; do echo "noise $i"; i=$((i+1)); done; echo "e: Unresolved reference: foo" >&2; exit 1');
    const res = await cmdExec(s.stateDir, ["gradle", "tasks", "build", "--brief", "--json"], { env: s.env, cwd: s.proj });
    assert.equal(res.exitCode, 1);
    assert.ok(fs.existsSync(res.logPath));
    assert.match(fs.readFileSync(res.logPath, "utf8"), /noise 0/);
    assert.ok(res.summary.some((l) => /Unresolved reference/.test(l)));
    assert.ok(!res.summary.includes("noise 0"), "early noise trimmed");
    assert.ok(res.summary.length <= 80);
  } finally {
    s.cleanup();
  }
});

test("exec: android ops run adb -s <serial> with the exact remote string under the lease", { skip: !posix }, async () => {
  const s = setup();
  try {
    const log = path.join(s.root, "adb.log");
    script(path.join(s.bin, "adb"), `for a in "$@"; do printf '[%s]' "$a" >> ${log}; done; echo >> ${log}`);
    const claim = cmdClaim(s.stateDir, { session: "sess-exec", api: "35", type: "phone" }, { inventory: mockInventory, env: s.env });
    assert.equal(claim.exitCode, 0, claim.error);
    const res = await cmdExec(
      s.stateDir,
      ["android", "launch", "--package", "com.example.app", "--activity", ".MainActivity", "--session", "sess-exec", "--json"],
      { env: s.env, cwd: s.proj, inventory: mockInventory },
    );
    assert.equal(res.exitCode, 0, res.error);
    assert.equal(fs.readFileSync(log, "utf8").trim(), "[-s][emulator-5554][shell][am start -n 'com.example.app/.MainActivity']");
  } finally {
    s.cleanup();
  }
});

test("exec: multi-invocation ops stop at the first failure", { skip: !posix }, async () => {
  const s = setup();
  try {
    const log = path.join(s.root, "adb.log");
    script(path.join(s.bin, "adb"), `echo "$3" >> ${log}; [ "$3" = "pull" ] && exit 7; exit 0`);
    cmdClaim(s.stateDir, { session: "sess-shot", api: "35", type: "phone" }, { inventory: mockInventory, env: s.env });
    const res = await cmdExec(s.stateDir, ["android", "screenshot", "out.png", "--session", "sess-shot", "--json"], { env: s.env, cwd: s.proj, inventory: mockInventory });
    assert.equal(res.exitCode, 7);
    assert.equal(res.steps.length, 2);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["shell", "pull"]);
  } finally {
    s.cleanup();
  }
});

test("exec: device ops without a lease fail clearly", async () => {
  const s = setup();
  try {
    const res = await cmdExec(s.stateDir, ["android", "uninstall", "com.example.app", "--session", "nobody", "--wait", "0"], { env: s.env, cwd: s.proj, inventory: mockInventory });
    assert.notEqual(res.exitCode, 0);
    assert.ok(res.error);
  } finally {
    s.cleanup();
  }
});

test("exec: bazel.run honours timeoutSec (exit 124)", { skip: !posix }, async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.proj, "MODULE.bazel"), "");
    script(path.join(s.proj, "bazelw"), "sleep 30");
    const started = Date.now();
    const res = await cmdExec(s.stateDir, ["bazel", "run", "//tools:gen", "--timeout-sec", "1", "--json"], { env: s.env, cwd: s.proj });
    assert.equal(res.exitCode, 124, res.error);
    assert.equal(res.steps[0].timedOut, true);
    assert.ok(Date.now() - started < 15000);
    assert.equal(res.steps[0].args[0], "run");
    assert.match(res.steps[0].args[1], /^--jobs=/);
  } finally {
    s.cleanup();
  }
});

test("exec: bazel.clean --expunge is allowed and serialized like a build", { skip: !posix }, async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.proj, "MODULE.bazel"), "");
    script(path.join(s.proj, "bazelw"), 'echo "ARGS:$*"');
    const res = await cmdExec(s.stateDir, ["bazel", "clean", "--expunge", "--json"], { env: s.env, cwd: s.proj });
    assert.equal(res.exitCode, 0, res.error);
    assert.deepEqual(res.steps[0].args, ["clean", "--expunge"]);
  } finally {
    s.cleanup();
  }
});

test("windows contract: batch args and wrapper paths are checked, never forceable", () => {
  const errs = checkWindowsContract(
    [{ cmd: "C:\\work\\%NAME%\\gradlew.bat", args: ["build", "a&b", "%PATH%"], cwd: "C:\\work\\%NAME%" }],
    "win32",
  );
  assert.deepEqual(errs.map((e) => e.code), ["windows_unsafe_path", "windows_unsafe_arg", "windows_unsafe_arg"]);
  assert.deepEqual(checkWindowsContract([{ cmd: "C:\\My Projects\\gradlew.bat", args: [":app:build"] }], "win32"), []);
  assert.deepEqual(checkWindowsContract([{ cmd: "/x/%y%/gradlew", args: ["a&b"] }], "darwin"), []);
});

test("windows contract: planOp rejects a %NAME% project directory", () => {
  const root = tmp();
  try {
    const dir = path.join(root, "%NAME%");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "gradlew.bat"), "");
    const plan = planOp("gradle.tasks", { tasks: ["build"] }, { cwd: dir, platform: "win32" });
    assert.equal(plan.errors[0].code, "windows_unsafe_path");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("planOp: prop.set on a physical device needs config opt-in", () => {
  const plan = planOp("android.prop.set", { key: "debug.x", value: "1" }, { cwd: "/" });
  assert.deepEqual(plan.errors, []);
  assert.throws(() => plan.makeInvocations({ serial: "R5CX", kind: "physical" }), (e) => e.code === "physical_not_allowed");
  assert.equal(plan.makeInvocations({ serial: "emulator-5554", kind: "emulator" })[0].args[3], "setprop 'debug.x' '1'");
  const allowed = planOp("android.prop.set", { key: "debug.x", value: "1" }, { cwd: "/", config: { allowPhysicalPropSet: true } });
  assert.equal(allowed.makeInvocations({ serial: "R5CX", kind: "physical" }).length, 1);
});

test("planOp: host OS gate for Apple ops", () => {
  const plan = planOp("ios.terminate", { bundleId: "com.ex.App" }, { platform: "linux" });
  assert.equal(plan.errors[0].code, "unsupported_host");
});

test("summarizeBriefOutput keeps signal lines and the tail", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  lines[10] = "FAILURE: Build failed with an exception.";
  const out = summarizeBriefOutput(lines, 1);
  assert.equal(out[0], lines[10]);
  assert.equal(out.at(-1), "line 199");
  assert.deepEqual(summarizeBriefOutput(lines, 0), []);
});

test("execHelp lists every system and the feature request link", () => {
  const h = execHelp();
  for (const sys of ["gradle", "bazel", "xcode", "android", "ios", "snapshot"]) assert.match(h, new RegExp(`${sys}:`));
  assert.match(h, /atc exec android prop get <key>/);
  assert.match(h, /github\.com\/rock3r\/atc\/issues/);
});

test("exec: two in-process builds on one workspace serialize without blocking the event loop", { skip: !posix }, async () => {
  const s = setup();
  try {
    const log = path.join(s.root, "order.log");
    script(path.join(s.proj, "gradlew"), `echo "start $1" >> ${log}; sleep 1; echo "end $1" >> ${log}`);
    const [a, b] = await Promise.all([
      cmdExec(s.stateDir, ["gradle", "tasks", "one", "--json"], { env: s.env, cwd: s.proj }),
      cmdExec(s.stateDir, ["gradle", "tasks", "two", "--json"], { env: s.env, cwd: s.proj }),
    ]);
    assert.equal(a.exitCode, 0, a.error);
    assert.equal(b.exitCode, 0, b.error);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^start/);
    assert.match(lines[1], /^end/, `builds overlapped: ${lines.join(" | ")}`);
  } finally {
    s.cleanup();
  }
});

test("planOp: read-only device ops carry their platform for lease selection", () => {
  const A = ["andr", "oid"].join("");
  const p = planOp(`${A}.logcat`, { lines: 10 }, { cwd: "/" });
  assert.deepEqual(p.deviceClass, { kind: "read_only_device", targetPlatform: A });
});

test("exec: read-only op never runs against an opposite-platform lease", { skip: !posix }, async () => {
  const s = setup();
  try {
    const log = path.join(s.root, "adb.log");
    script(path.join(s.bin, "adb"), `echo "$*" >> ${log}`);
    const iosInventory = {
      ...mockInventory,
      running: [
        {
          deviceKey: "sim:AAAA",
          platform: "ios",
          avd: "iPhone 16",
          serial: "11111111-2222-3333-4444-555555555555",
          udid: "11111111-2222-3333-4444-555555555555",
          kind: "emulator",
          online: true,
          profile: { deviceType: "phone", osVersion: "18.2", runtime: "iOS 18.2" },
        },
      ],
    };
    const claim = cmdClaim(s.stateDir, { session: "sess-x", ios: true }, { inventory: iosInventory, env: s.env, platform: "darwin" });
    assert.equal(claim.exitCode, 0, claim.error);
    const res = await cmdExec(s.stateDir, ["android", "logcat", "--session", "sess-x", "--wait", "0", "--json"], { env: s.env, cwd: s.proj, inventory: iosInventory });
    assert.notEqual(res.exitCode, 0);
    assert.ok(!fs.existsSync(log), "adb must not be invoked with an iOS UDID");
  } finally {
    s.cleanup();
  }
});
