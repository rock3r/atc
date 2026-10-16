import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdBatch } from "../src/cli.mjs";
import { readState } from "../src/state.mjs";
const HOST = { totalRamMb: 65536, availableRamMb: 32768, freeDiskMb: 100000, cpuCores: 8 };

const posix = process.platform !== "win32";

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atc-batch-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj);
  const log = path.join(root, "calls.log");
  script(path.join(proj, "gradlew"), `echo "gradlew $* ENV_FOO=$FOO" >> ${log}; [ "$1" = "fail" ] && exit 5; exit 0`);
  script(path.join(bin, "adb"), `echo "adb $*" >> ${log}; exit 0`);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  return {
    root,
    stateDir,
    proj,
    log,
    env,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []),
    run: (plan, flags = {}) => cmdBatch(stateDir, { session: "sess-batch", json: true, ...flags }, { env, cwd: proj, plan, inventory: mockInventory, host: HOST }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const assembleInstallLaunch = () => ({
  version: 1,
  steps: [
    { id: "assemble", op: "gradle.tasks", tasks: [":app:assembleDebug"], env: { FOO: "bar" } },
    { id: "install", op: "android.install", apk: "app.apk", dependsOn: ["assemble"], claim: { platform: "android", api: "35", type: "phone" } },
    { id: "launch", op: "android.launch", package: "com.ex.app", activity: ".Main", dependsOn: ["install"], claim: { reuse: "install" } },
  ],
});

test("batch: invalid plans are rejected in full before anything runs", { skip: !posix }, async () => {
  const s = setup();
  try {
    const plan = assembleInstallLaunch();
    plan.steps[0].tasks = ["bad;task"];
    plan.steps[2].claim = { reuse: "nope" };
    plan.steps.push({ id: "x", op: "shell.run", command: "rm -rf /" });
    const res = await s.run(plan);
    assert.equal(res.exitCode, 7);
    assert.ok(res.errors.length >= 3);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.cleanup();
  }
});

test("batch: --validate prints exact argv and runs nothing", { skip: !posix }, async () => {
  const s = setup();
  try {
    const res = await s.run(assembleInstallLaunch(), { validate: true });
    assert.equal(res.exitCode, 0, res.error);
    assert.deepEqual(res.order, ["assemble", "install", "launch"]);
    assert.deepEqual(res.steps[0].invocations[0].args, [":app:assembleDebug"]);
    assert.equal(res.steps[2].invocations[0].args[3], "am start -n 'com.ex.app/.Main'");
    assert.deepEqual(s.calls(), []);
  } finally {
    s.cleanup();
  }
});

test("batch: assemble → install → launch with claim reuse, per-step env, release after last consumer", { skip: !posix }, async () => {
  const s = setup();
  try {
    const res = await s.run(assembleInstallLaunch());
    assert.equal(res.exitCode, 0, JSON.stringify(res, null, 2));
    assert.deepEqual(res.steps.map((x) => x.status), ["ok", "ok", "ok"]);
    const calls = s.calls();
    assert.match(calls[0], /^gradlew :app:assembleDebug -Dorg\.gradle\.workers\.max=\d+ ENV_FOO=bar$/);
    assert.match(calls[1], /^adb -s emulator-5554 install .*app\.apk$/);
    assert.equal(calls[2], "adb -s emulator-5554 shell am start -n 'com.ex.app/.Main'");
    const st = readState(s.stateDir);
    assert.deepEqual(Object.keys(st.leases), [], "claim released after last consumer");
  } finally {
    s.cleanup();
  }
});

test("batch: failing step skips dependents and stops the batch", { skip: !posix }, async () => {
  const s = setup();
  try {
    const plan = assembleInstallLaunch();
    plan.steps[0].tasks = ["fail"];
    const res = await s.run(plan);
    assert.equal(res.exitCode, 5);
    assert.deepEqual(res.steps.map((x) => x.status), ["failed", "skipped", "skipped"]);
    assert.equal(res.steps[1].reason, "dependency_failed");
    assert.equal(s.calls().length, 1);
  } finally {
    s.cleanup();
  }
});

test("batch: continueOnError lets independent steps run", { skip: !posix }, async () => {
  const s = setup();
  try {
    const res = await s.run({
      version: 1,
      steps: [
        { id: "a", op: "gradle.tasks", tasks: ["fail"], continueOnError: true },
        { id: "b", op: "gradle.tasks", tasks: ["lint"] },
        { id: "c", op: "gradle.tasks", tasks: ["check"], dependsOn: ["a"] },
      ],
    });
    assert.equal(res.exitCode, 0);
    assert.deepEqual(res.steps.map((x) => x.status), ["failed", "ok", "skipped"]);
  } finally {
    s.cleanup();
  }
});

test("batch: separate claims on the same platform produce an efficiency notice", { skip: !posix }, async () => {
  const s = setup();
  try {
    const res = await s.run(
      {
        version: 1,
        steps: [
          { id: "i1", op: "android.install", apk: "a.apk", claim: { platform: "android" } },
          { id: "i2", op: "android.install", apk: "b.apk", claim: { platform: "android" } },
        ],
      },
      { validate: true },
    );
    assert.equal(res.exitCode, 0, res.error);
    assert.ok(res.notices.some((n) => /reuse/.test(n.fix)));
  } finally {
    s.cleanup();
  }
});

test("batch: unknown step fields such as phase or command are rejected", async () => {
  const s = setup();
  try {
    const res = await s.run({ version: 1, steps: [{ id: "a", op: "gradle.tasks", tasks: ["x"], phase: "pure-build", command: "./gradlew x" }] });
    assert.equal(res.exitCode, 7);
    assert.deepEqual(res.errors.map((e) => e.code).sort(), ["unknown_field", "unknown_field"]);
  } finally {
    s.cleanup();
  }
});

test("batch: bazel.run keeps its required timeoutSec", { skip: !posix }, async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.proj, "MODULE.bazel"), "");
    script(path.join(s.proj, "bazelw"), "exit 0");
    const res = await s.run({ version: 1, steps: [{ id: "gen", op: "bazel.run", target: "//tools:gen", timeoutSec: 30 }] }, { validate: true });
    assert.equal(res.exitCode, 0, res.error);
    assert.equal(res.steps[0].invocations[0].timeoutSec, 30);
  } finally {
    s.cleanup();
  }
});

test("batch: a claim is released once its last consumer is skipped", { skip: !posix }, async () => {
  const s = setup();
  try {
    const leaseCountDuringStep = path.join(s.root, "leases.txt");
    const stateFile = path.join(s.stateDir, "state.json");
    script(
      path.join(s.proj, "gradlew"),
      `[ "$1" = "fail" ] && exit 5; if grep -q '"avd:Pixel_8_API_35"' ${stateFile}; then echo held > ${leaseCountDuringStep}; else echo free > ${leaseCountDuringStep}; fi; exit 0`,
    );
    const res = await s.run({
      version: 1,
      steps: [
        { id: "install", op: "android.install", apk: "a.apk", claim: { platform: "android" } },
        { id: "flaky", op: "gradle.tasks", tasks: ["fail"], continueOnError: true },
        { id: "launch", op: "android.launch", package: "com.ex.app", activity: ".Main", dependsOn: ["install", "flaky"], claim: { reuse: "install" } },
        { id: "later", op: "gradle.tasks", tasks: ["lint"], dependsOn: ["launch"], continueOnError: true },
        { id: "unrelated", op: "gradle.tasks", tasks: ["check"] },
      ],
    });
    assert.deepEqual(res.steps.map((x) => x.status), ["ok", "failed", "skipped", "skipped", "ok"]);
    assert.equal(fs.readFileSync(leaseCountDuringStep, "utf8").trim(), "free", "claim released before the unrelated step");
  } finally {
    s.cleanup();
  }
});

test("batch: a step timeout is one deadline across a multi-invocation op", { skip: !posix }, async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.proj, "MODULE.bazel"), "");
    script(path.join(s.proj, "bazelw"), "sleep 2");
    const started = Date.now();
    const res = await s.run({
      version: 1,
      steps: [{ id: "s", op: "bazel.series", series: [{ command: "build", targets: ["//a"] }, { command: "build", targets: ["//b"] }], timeoutSec: 3 }],
    });
    assert.equal(res.exitCode, 124, JSON.stringify(res.steps));
    assert.ok(Date.now() - started < 3900, "second invocation only got the remaining time");
  } finally {
    s.cleanup();
  }
});

test("batch: claim reuse on a device-free step is rejected", async () => {
  const s = setup();
  try {
    const res = await s.run({
      version: 1,
      steps: [
        { id: "install", op: "android.install", apk: "a.apk", claim: { platform: "android" } },
        { id: "build", op: "gradle.tasks", tasks: ["assembleDebug"], dependsOn: ["install"], claim: { reuse: "install" } },
      ],
    });
    assert.equal(res.exitCode, 7);
    assert.equal(res.errors[0].code, "claim_unused");
  } finally {
    s.cleanup();
  }
});

test("cli: `atc batch -` and `--file -` read the plan from stdin", async () => {
  const { parseCliArgs } = await import("../src/cli.mjs");
  assert.deepEqual(parseCliArgs(["batch", "-"]).positionals, ["-"]);
  assert.equal(parseCliArgs(["batch", "--file", "-"]).flags.file, "-");
  const s = setup();
  try {
    const plan = JSON.stringify({ version: 1, steps: [{ id: "a", op: "gradle.tasks", tasks: ["lint"] }] });
    fs.writeFileSync(path.join(s.proj, "gradlew"), "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(path.join(s.proj, "gradlew.bat"), "@exit /b 0\r\n");
    const res = await cmdBatch(s.stateDir, { session: "stdin", json: true, validate: true, file: "-" }, { env: s.env, cwd: s.proj, readStdin: () => plan });
    assert.equal(res.exitCode, 0, res.error);
  } finally {
    s.cleanup();
  }
});

test("batch: validation models an explicit physical claim (prop.set policy caught before claiming)", async () => {
  const s = setup();
  try {
    const plan = {
      version: 1,
      steps: [{ id: "p", op: "android.prop.set", key: "debug.x", value: "1", claim: { platform: "android", kind: "physical" } }],
    };
    for (const flags of [{ validate: true }, {}]) {
      const res = await s.run(plan, flags);
      assert.equal(res.exitCode, 7, JSON.stringify(res));
      assert.equal(res.errors[0].code, "physical_not_allowed");
    }
    assert.deepEqual(Object.keys(readState(s.stateDir).leases || {}), [], "nothing was claimed");
  } finally {
    s.cleanup();
  }
});

test("batch: a step's env is used for its claim too", async () => {
  const s = setup();
  try {
    const seen = [];
    const { runBatch } = await import("../src/batch.mjs");
    const { execDeps } = await import("../src/cli.mjs");
    const deps = {
      ...execDeps(s.stateDir, {}),
      cmdClaim: (_dir, _flags, opts) => {
        seen.push(opts.env.ANDROID_AVD_HOME);
        return { exitCode: 2, error: "busy" };
      },
      cmdFree: () => ({ exitCode: 0 }),
      sessionHasLease: () => false,
      resolveSessionId: () => "s",
    };
    const res = await runBatch(
      s.stateDir,
      { version: 1, steps: [{ id: "i", op: "android.install", apk: "a.apk", env: { ANDROID_AVD_HOME: "/custom/avd" }, claim: { platform: "android" } }] },
      deps,
      { env: s.env, cwd: s.proj, json: true },
    );
    assert.notEqual(res.exitCode, 0);
    assert.deepEqual(seen, ["/custom/avd"]);
  } finally {
    s.cleanup();
  }
});

test("batch: planning models an existing physical session lease when the step has no claim", async () => {
  const s = setup();
  try {
    const { runBatch } = await import("../src/batch.mjs");
    const { execDeps } = await import("../src/cli.mjs");
    const physical = { serial: "R5CX", kind: "physical", platform: "android", state: "active" };
    const deps = {
      ...execDeps(s.stateDir, {}),
      cmdClaim: () => ({ exitCode: 1 }),
      cmdFree: () => ({ exitCode: 0 }),
      sessionHasLease: () => true,
      sessionLease: () => physical,
      resolveSessionId: () => "s",
    };
    const res = await runBatch(
      s.stateDir,
      { version: 1, steps: [{ id: "p", op: "android.prop.set", key: "debug.x", value: "1" }] },
      deps,
      { env: s.env, cwd: s.proj, json: true, validateOnly: true },
    );
    assert.equal(res.exitCode, 7, JSON.stringify(res));
    assert.equal(res.errors[0].code, "physical_not_allowed");
  } finally {
    s.cleanup();
  }
});

test("batch: snapshot steps refuse a physical claim before anything runs", async () => {
  const s = setup();
  try {
    const res = await s.run(
      { version: 1, steps: [{ id: "snap", op: "snapshot.save", name: "clean", claim: { platform: "android", kind: "physical" } }] },
      { validate: true },
    );
    assert.equal(res.exitCode, 7, JSON.stringify(res));
    assert.equal(res.errors[0].code, "virtual_only");
  } finally {
    s.cleanup();
  }
});

test("batch: two producers that receive the same idempotent lease share ownership", { skip: !posix }, async () => {
  const s = setup();
  try {
    const { runBatch } = await import("../src/batch.mjs");
    const { execDeps, cmdClaim } = await import("../src/cli.mjs");
    const events = [];
    let claimCount = 0;
    const deps = {
      ...execDeps(s.stateDir, {}),
      cmdClaim: (dir, flags, opts) => {
        claimCount++;
        const res = cmdClaim(dir, flags, { ...opts, inventory: mockInventory });
        return claimCount === 1 ? res : { ...res, idempotent: true };
      },
      cmdFree: (dir, leaseId) => {
        const launches = s.calls().filter((l) => l === "adb shell").length;
        events.push(`free:${leaseId ? "lease" : "none"}:after-${launches}-launches`);
        return { exitCode: 0, freed: [leaseId] };
      },
      cmdRenew: () => ({ exitCode: 0 }),
      sessionHasLease: () => false,
      resolveSessionId: () => "sess-batch",
    };
    script(path.join(s.root, "bin", "adb"), `echo "adb $3" >> ${s.log}; exit 0`);
    const res = await runBatch(
      s.stateDir,
      {
        version: 1,
        steps: [
          { id: "p1", op: "android.install", apk: "a.apk", claim: { platform: "android" } },
          { id: "p2", op: "android.install", apk: "b.apk", dependsOn: ["p1"], claim: { platform: "android" } },
          { id: "c1", op: "android.launch", package: "com.ex.app", activity: ".Main", dependsOn: ["p1", "p2"], claim: { reuse: "p1" } },
          { id: "c2", op: "android.launch", package: "com.ex.app", activity: ".Main", dependsOn: ["c1", "p2"], claim: { reuse: "p2" } },
        ],
      },
      deps,
      { env: s.env, cwd: s.proj, json: true, inventory: mockInventory, host: HOST, session: "sess-batch" },
    );
    assert.equal(res.exitCode, 0, JSON.stringify(res.steps));
    assert.deepEqual(res.steps.map((x) => x.status), ["ok", "ok", "ok", "ok"]);
    assert.deepEqual(events, ["free:lease:after-2-launches"], "the shared lease is freed exactly once, after the last consumer");
  } finally {
    s.cleanup();
  }
});
