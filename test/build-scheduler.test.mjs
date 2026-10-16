import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  canonicalizeBuildPath,
  resolveBuildResources,
  computeEffectiveMaxBuilds,
  computeBuildPoolSnapshot,
  pruneAndSelectNextBuildTicket,
  computeUnaccountedBuildRamMb,
  checkUnifiedRamAdmission,
  reconcileBuildLease,
  evaluateNestedBuildAdmission,
  computeDefaultBazelOutputBases,
  probeWarmBuildDaemons,
  computeColdBuildRamDemandMb,
  doBuildResourceKeysConflict,
  extractBuildResourceKeyInfo,
  isGradleDeviceTaskName,
} from "../src/build.mjs";
import { flushAuditEvents, readRecentAuditEvents } from "../src/logger.mjs";
import { checkResourceAdmission } from "../src/android.mjs";
import { prepareOpChildInvocation } from "../src/spawn.mjs";
import { createDefaultState, readState } from "../src/state.mjs";
import { cmdBatch, cmdClaim, cmdExec } from "../src/cli.mjs";
import { planOp } from "../src/exec.mjs";
import { joinBackslashContinuations, parseJavaProperties, splitRcWords } from "../src/parsers.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atc-build-test-"));
}

delete process.env.GRADLE_OPTS;
delete process.env._JAVA_OPTIONS;
delete process.env.JAVA_TOOL_OPTIONS;
delete process.env.GRADLE_HOME;
delete process.env.JAVA_OPTS;
delete process.env.GRADLE_USER_HOME;

const posix = process.platform !== "win32";
const realpath = (p) => (fs.realpathSync.native || fs.realpathSync)(p);

function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// Temp project with a fake Gradle wrapper; ops resolve the wrapper from cwd.
function setupProject({ gradlew = "exit 0" } = {}) {
  const root = makeTempDir();
  const stateDir = path.join(root, "state");
  const bin = path.join(root, "bin");
  const proj = path.join(root, "proj");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "settings.gradle"), "rootProject.name = 'app'\n");
  script(path.join(proj, "gradlew"), gradlew);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ATC_STATE_DIR: stateDir };
  delete env.ATC_LOG_DIR;
  delete env.ATC_BUILD_OP_ID;
  delete env.ATC_BUILD_OP_NONCE;
  return {
    root,
    stateDir,
    bin,
    proj,
    env,
    writeState(mutate) {
      const st = readState(stateDir);
      mutate(st);
      fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(st, null, 2));
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function hostInventory(overrides = {}, running = []) {
  return {
    host: {
      cpuCores: 8,
      totalRamMb: 32768,
      availableRamMb: 16384,
      freeDiskMb: 50000,
      sampledAtMs: Date.now(),
      ...overrides,
    },
    running,
    offline: [],
    creatable: [],
  };
}

const PIXEL_35 = {
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
};

function busyBuildLease(id, resourceKeys, extra = {}) {
  const now = Date.now();
  return {
    buildId: id,
    sessionId: "sess-holder",
    workerPid: process.pid,
    workerPgid: null,
    opId: `op_${id}`,
    opNonce: `nonce_${id}`,
    tool: "gradle",
    workspaceRoot: "/other-workspace",
    resourceKeys,
    requiresWorkspaceLock: true,
    requiresHeavySlot: true,
    pinnedDeviceLeaseId: null,
    state: "active",
    createdAtMs: now,
    updatedAtMs: now,
    expiresAtMs: now + 60_000,
    drainingUntilMs: null,
    maxDrainingAtMs: null,
    reservedRamMb: 0,
    ramReservationUntilMs: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Build requirement resolution (direct literal argv; device coupling comes from the op)
// ---------------------------------------------------------------------------

test("resolveBuildResources classifies direct gradle, bazel and xcodebuild argv as serialized pure builds", () => {
  const tmp = makeTempDir();
  try {
    const wsDir = path.join(tmp, "repo");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "settings.gradle.kts"), "rootProject.name = 'demo'\n");
    const canonicalWs = canonicalizeBuildPath(wsDir);

    for (const args of [["assembleDebug", "--stacktrace"], ["tasks", "--all"], ["connectedDebugAndroidTest"]]) {
      const res = resolveBuildResources("./gradlew", args, wsDir);
      assert.equal(res.kind, "pure_build", `gradle ${args.join(" ")}`);
      assert.equal(res.tool, "gradle");
      assert.equal(res.requiresDevice, false, "device coupling is decided by the op, not argv");
      assert.equal(res.requiresWorkspaceLock, true);
      assert.equal(res.requiresHeavySlot, true);
      assert.deepEqual(res.resourceKeys, [`gradle:${canonicalWs}`]);
      assert.equal(res.workspaceRoot, canonicalWs);
    }
    assert.deepEqual(resolveBuildResources("./gradlew", ["build"], wsDir).tasks, ["build"]);

    // Absolute wrapper path and -p / --project-dir resolve the Gradle root
    const subRepoDir = path.join(tmp, "sub-repo");
    fs.mkdirSync(subRepoDir, { recursive: true });
    fs.writeFileSync(path.join(subRepoDir, "settings.gradle"), "rootProject.name = 'sub'\n");
    const canonicalSub = canonicalizeBuildPath(subRepoDir);
    assert.deepEqual(resolveBuildResources("./gradlew", ["-p", "sub-repo", "build"], tmp).resourceKeys, [`gradle:${canonicalSub}`]);
    assert.deepEqual(resolveBuildResources("./gradlew", ["--project-dir=sub-repo", "build"], tmp).resourceKeys, [`gradle:${canonicalSub}`]);
    const subWrapper = script(path.join(subRepoDir, "gradlew"), "exit 0");
    assert.deepEqual(resolveBuildResources(subWrapper, ["build"], tmp).resourceKeys, [`gradle:${canonicalSub}`]);

    // Literal argv is never re-split: quoted separators stay inside one argument
    const literal = resolveBuildResources("./gradlew", ["build", "-Pfilter=a|b;c&&d"], wsDir);
    assert.deepEqual(literal.tasks, ["build"]);
    assert.deepEqual(literal.resourceKeys, [`gradle:${canonicalWs}`]);

    // Bazel: every subcommand (including clean/run, which are now allowed typed ops) is serialized
    fs.writeFileSync(path.join(wsDir, "MODULE.bazel"), "");
    for (const args of [["build", "//app:main"], ["query", "//..."], ["clean", "--expunge"], ["run", "//tools:gen"]]) {
      const res = resolveBuildResources("bazel", args, wsDir, { systemBazelrcPath: null });
      assert.equal(res.kind, "pure_build", `bazel ${args.join(" ")}`);
      assert.equal(res.tool, "bazel");
      assert.equal(res.subcommand, args[0]);
      assert.equal(res.requiresWorkspaceLock, true);
      assert.equal(res.requiresHeavySlot, true);
      assert.ok(res.resourceKeys.includes(`bazel:ws:${canonicalWs}`));
    }
    assert.equal(resolveBuildResources("bazelisk", ["build", "//..."], wsDir).tool, "bazel");
    assert.equal(resolveBuildResources("/opt/bin/bazelw", ["build", "//..."], wsDir).tool, "bazel");

    // xcodebuild: project discovery and -derivedDataPath keys
    const xcRoot = path.join(tmp, "ios");
    fs.mkdirSync(path.join(xcRoot, "App.xcodeproj"), { recursive: true });
    fs.mkdirSync(path.join(xcRoot, "Sources"), { recursive: true });
    const canonicalXc = canonicalizeBuildPath(xcRoot);
    const xcBuild = resolveBuildResources("xcodebuild", ["-scheme", "App", "build"], path.join(xcRoot, "Sources"));
    assert.equal(xcBuild.kind, "pure_build");
    assert.equal(xcBuild.tool, "xcodebuild");
    assert.equal(xcBuild.requiresDevice, false);
    assert.deepEqual(xcBuild.resourceKeys, [`xcode:${canonicalXc}`]);
    const ddPath = path.join(tmp, "dd");
    const xcDerived = resolveBuildResources(
      "xcodebuild",
      ["-project", path.join(xcRoot, "App.xcodeproj"), "-scheme", "App", "-derivedDataPath", ddPath, "test"],
      tmp,
    );
    assert.deepEqual(xcDerived.resourceKeys, [`xcode:${canonicalXc}`, `xcode:dd:${canonicalizeBuildPath(ddPath)}`]);

    // Anything that is not a direct build tool is not classified (no wrapper / shell peeling)
    for (const [cmd, args] of [
      ["sh", ["-c", "./gradlew assembleDebug"]],
      ["build-brief", ["./gradlew", "assembleDebug"]],
      ["xcrun", ["xcodebuild", "test", "-scheme", "App"]],
      ["env", ["FOO=1", "./gradlew", "build"]],
      ["node", ["-e", "process.exit(0)"]],
    ]) {
      const res = resolveBuildResources(cmd, args, wsDir);
      assert.equal(res.kind, "not_build_tool", `${cmd} must not be peeled`);
      assert.deepEqual(res.resourceKeys, []);
      assert.equal(res.requiresWorkspaceLock, false);
    }

    // Explicit workspace adds generic workspace:<root> keys next to the tool key
    const dirA = path.join(tmp, "a");
    const subNested = path.join(dirA, "sub", "nested");
    fs.mkdirSync(subNested, { recursive: true });
    fs.writeFileSync(path.join(dirA, "settings.gradle"), "rootProject.name = 'a'\n");
    const canonicalDirA = canonicalizeBuildPath(dirA);
    const explicitWs = resolveBuildResources("./gradlew", ["build"], tmp, { workspace: subNested });
    assert.ok(explicitWs.resourceKeys.includes(`workspace:${canonicalDirA}`));
    assert.ok(explicitWs.resourceKeys.includes(`gradle:${canonicalDirA}`));
    assert.ok(explicitWs.resourceKeys.includes(`workspace:${canonicalizeBuildPath(subNested)}`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("typed build ops derive device coupling, platform and workspace keys from the op", () => {
  const tmp = makeTempDir();
  try {
    const wsDir = path.join(tmp, "repo");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'demo'\n");
    script(path.join(wsDir, "gradlew"), "exit 0");
    fs.writeFileSync(path.join(wsDir, "gradlew.bat"), "@exit /b 0\r\n");
    fs.writeFileSync(path.join(wsDir, "MODULE.bazel"), "");
    const canonicalWs = canonicalizeBuildPath(wsDir);

    const pure = planOp("gradle.tasks", { tasks: [":app:assembleDebug"] }, { cwd: wsDir });
    assert.deepEqual(pure.errors, []);
    assert.equal(pure.buildReqs.kind, "pure_build");
    assert.equal(pure.buildReqs.requiresDevice, false);
    assert.equal(pure.buildReqs.requiresHeavySlot, true);
    assert.equal(pure.buildReqs.requiresWorkspaceLock, true);
    assert.ok(pure.buildReqs.resourceKeys.includes(`gradle:${canonicalWs}`));
    assert.ok(pure.buildReqs.resourceKeys.includes(`workspace:${canonicalWs}`));

    const coupled = planOp("gradle.tasks", { tasks: [":app:connectedDebugAndroidTest"] }, { cwd: wsDir });
    assert.equal(coupled.buildReqs.kind, "device_coupled_build");
    assert.equal(coupled.buildReqs.requiresDevice, true);
    assert.equal(coupled.buildReqs.targetPlatform, "android");

    const mixed = planOp("gradle.tasks", { tasks: ["assembleDebug", "installDebug"] }, { cwd: wsDir });
    assert.equal(mixed.buildReqs.kind, "device_coupled_build");
    assert.equal(mixed.notices.length, 1, "mixed device/pure tasks produce a split-the-step notice");

    const buildOnlyDevice = planOp("gradle.tasks", { tasks: ["connectedCheck"], buildOnly: true }, { cwd: wsDir });
    assert.equal(buildOnlyDevice.errors[0].code, "build_only_device");

    const ramHint = planOp("gradle.tasks", { tasks: ["build"], ramMb: 6144 }, { cwd: wsDir });
    assert.equal(ramHint.buildReqs.requestedHeapMb, 6144);
    assert.equal(computeColdBuildRamDemandMb(ramHint.buildReqs, 3072), 6144);
    assert.equal(computeColdBuildRamDemandMb(pure.buildReqs, 3072), 3072);

    for (const [opName, params] of [
      ["bazel.build", { targets: ["//app:main"] }],
      ["bazel.clean", { expunge: true }],
      ["bazel.run", { target: "//tools:gen", timeoutSec: 30 }],
    ]) {
      const p = planOp(opName, params, { cwd: wsDir });
      assert.deepEqual(p.errors, [], opName);
      assert.equal(p.buildReqs.kind, "pure_build", opName);
      assert.equal(p.buildReqs.tool, "bazel");
      assert.ok(p.buildReqs.resourceKeys.includes(`bazel:ws:${canonicalWs}`), opName);
    }

    const xcTest = planOp("xcode.test", { scheme: "App" }, { cwd: wsDir, platform: "darwin" });
    assert.equal(xcTest.buildReqs.kind, "device_coupled_build");
    assert.equal(xcTest.buildReqs.targetPlatform, "ios");
    assert.equal(xcTest.buildReqs.tool, "xcodebuild");
    const xcMacTest = planOp("xcode.test", { scheme: "App", testDestination: "macos" }, { cwd: wsDir, platform: "darwin" });
    assert.equal(xcMacTest.buildReqs.kind, "pure_build");
    const xcBuild = planOp("xcode.build", { scheme: "App" }, { cwd: wsDir, platform: "darwin" });
    assert.equal(xcBuild.buildReqs.kind, "pure_build");
    assert.equal(xcBuild.buildReqs.requiresDevice, false);

    // Gradle device task-name heuristics used by the op
    for (const name of ["connectedDebugAndroidTest", "connectedCheck", "installDebug", "uninstallAll", "cC", "iD"]) {
      assert.equal(isGradleDeviceTaskName(name), true, name);
    }
    for (const name of ["assembleDebug", "installDist", "installShadowDist", "publishToMavenLocal", "iDist", "lint"]) {
      assert.equal(isGradleDeviceTaskName(name), false, name);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareOpChildInvocation appends per-build caps, injects lease env and sanitizes ATC_BUILD_OP_* env", () => {
  const plain = prepareOpChildInvocation({ cmd: "/repo/gradlew", args: ["assembleDebug"], cwd: "/repo" }, { baseEnv: {} });
  assert.deepEqual(plain.args, ["assembleDebug"], "no build lease → argv untouched");
  assert.equal(plain.cwd, "/repo");

  const inv = prepareOpChildInvocation(
    { cmd: "/repo/gradlew", args: ["assembleDebug", "-Pfilter=a|b;c&&d", "-Pnote=-Dorg.gradle.workers.max=99"] },
    {
      sessionId: "sess-1",
      baseEnv: { ATC_BUILD_OP_ID: "stale_op", ATC_BUILD_OP_NONCE: "stale_nonce", ATC_BUILD_ID: "stale_build", PATH: "/usr/bin" },
      buildLease: { buildId: "build_123", opId: "op_fresh", opNonce: "nonce_fresh", jobsLimit: 4, reservedRamMb: 3072 },
      tool: "gradle",
    },
  );
  assert.deepEqual(inv.args, [
    "assembleDebug",
    "-Pfilter=a|b;c&&d",
    "-Pnote=-Dorg.gradle.workers.max=99",
    "-Dorg.gradle.workers.max=4",
  ]);
  assert.equal(inv.env.ATC_BUILD_OP_ID, "op_fresh");
  assert.equal(inv.env.ATC_BUILD_OP_NONCE, "nonce_fresh");
  assert.equal(inv.env.ATC_BUILD_ID, "build_123");
  assert.equal(inv.env.ATC_SESSION_ID, "sess-1");
  assert.equal(inv.env.PATH, "/usr/bin");

  const stale = prepareOpChildInvocation(
    { cmd: "adb", args: ["devices"] },
    { baseEnv: { ATC_BUILD_OP_ID: "stale_op", ATC_BUILD_OP_NONCE: "stale_nonce", ATC_BUILD_ID: "b" } },
  );
  assert.equal(stale.env.ATC_BUILD_OP_ID, undefined, "inherited build op identity never leaks into children");
  assert.equal(stale.env.ATC_BUILD_OP_NONCE, undefined);
  assert.equal(stale.env.ATC_BUILD_ID, undefined);

  const caps = { jobsLimit: 4, reservedRamMb: 4096 };
  assert.deepEqual(
    prepareOpChildInvocation({ cmd: "bazel", args: ["build", "//app:main"] }, { baseEnv: {}, buildLease: caps, tool: "bazel" }).args,
    ["build", "--jobs=4", "--local_ram_resources=4096", "//app:main"],
  );
  assert.deepEqual(
    prepareOpChildInvocation({ cmd: "bazel", args: ["run", "//tools:gen", "--", "--flag"] }, { baseEnv: {}, buildLease: caps, tool: "bazel" }).args,
    ["run", "--jobs=4", "--local_ram_resources=4096", "//tools:gen", "--", "--flag"],
    "resource flags stay before the run args separator",
  );
  assert.deepEqual(
    prepareOpChildInvocation({ cmd: "bazel", args: ["clean", "--expunge"] }, { baseEnv: {}, buildLease: caps, tool: "bazel" }).args,
    ["clean", "--expunge"],
  );
  assert.deepEqual(
    prepareOpChildInvocation({ cmd: "bazel", args: ["query", "//..."] }, { baseEnv: {}, buildLease: caps, tool: "bazel" }).args,
    ["query", "//..."],
  );
  assert.deepEqual(
    prepareOpChildInvocation({ cmd: "xcodebuild", args: ["-scheme", "App", "test"] }, { baseEnv: {}, buildLease: caps, tool: "xcodebuild" }).args,
    ["-scheme", "App", "test", "-jobs", "4"],
  );
  assert.deepEqual(
    prepareOpChildInvocation({ cmd: "xcodebuild", args: ["-scheme", "App", "clean"] }, { baseEnv: {}, buildLease: caps, tool: "xcodebuild" }).args,
    ["-scheme", "App", "clean"],
  );
  const minCaps = prepareOpChildInvocation({ cmd: "bazel", args: ["test", "//..."] }, { baseEnv: {}, buildLease: { jobsLimit: 1, reservedRamMb: 10 }, tool: "bazel" });
  assert.deepEqual(minCaps.args, ["test", "--jobs=2", "--local_ram_resources=1024", "//..."], "caps are clamped to sane minimums");

  const android = prepareOpChildInvocation(
    { cmd: "/repo/gradlew", args: ["connectedCheck"] },
    { baseEnv: {}, lease: { leaseId: "lease_1", platform: "android", kind: "emulator", serial: "emulator-5554" } },
  );
  assert.equal(android.env.ANDROID_SERIAL, "emulator-5554");
  assert.equal(android.env.ATC_PLATFORM, "android");
  assert.equal(android.env.ATC_DEVICE_SERIAL, "emulator-5554");
  assert.equal(android.env.ATC_LEASE_ID, "lease_1");

  const ios = prepareOpChildInvocation(
    { cmd: "xcodebuild", args: ["test", "-destination", "id=SIM-UDID-999"] },
    { baseEnv: {}, lease: { leaseId: "lease_ios", platform: "ios", kind: "emulator", serial: "SIM-UDID-999" } },
  );
  assert.equal(ios.env.SIMULATOR_UDID, "SIM-UDID-999");
  assert.equal(ios.env.ANDROID_SERIAL, undefined);
  assert.equal(ios.env.ATC_PLATFORM, "ios");
});

// ---------------------------------------------------------------------------
// Scheduler primitives
// ---------------------------------------------------------------------------

test("computeEffectiveMaxBuilds, pool snapshots and resource key conflicts", () => {
  assert.equal(computeEffectiveMaxBuilds({ maxConcurrentBuilds: 3 }, { cpuCores: 2, totalRamMb: 4096 }), 3);
  assert.equal(computeEffectiveMaxBuilds({ maxConcurrentBuilds: "2" }, null), 2);
  assert.equal(computeEffectiveMaxBuilds({ maxConcurrentBuilds: 0 }, { cpuCores: 16, totalRamMb: 65536 }), 3);
  assert.equal(computeEffectiveMaxBuilds({}, { cpuCores: 8, totalRamMb: 16384 }), 1, "<24 GB RAM → 1 build");
  assert.equal(computeEffectiveMaxBuilds({}, { cpuCores: 8, totalRamMb: 32768 }), 2);
  assert.equal(computeEffectiveMaxBuilds({}, { cpuCores: 4, totalRamMb: 131072 }), 1, "CPU-bound");
  assert.equal(computeEffectiveMaxBuilds({}, { cpuCores: 64, totalRamMb: 262144 }), 4, "capped at 4");

  const state = createDefaultState();
  state.config.maxConcurrentBuilds = 2;
  state.buildLeases.b1 = { buildId: "b1", state: "active", requiresHeavySlot: true, resourceKeys: ["gradle:/ws-a"] };
  state.buildLeases.b2 = { buildId: "b2", state: "draining", requiresHeavySlot: false, resourceKeys: ["bazel:ws:/ws-b"] };
  state.buildLeases.b3 = { buildId: "b3", state: "released", requiresHeavySlot: true, resourceKeys: ["gradle:/ws-c"] };
  const snap = computeBuildPoolSnapshot(state, { cpuCores: 8, totalRamMb: 32768 });
  assert.equal(snap.activeHeavyBuilds, 1);
  assert.equal(snap.activeTotalBuilds, 2);
  assert.equal(snap.baseMaxBuilds, 2);
  assert.equal(snap.burstBuilds, 1);
  assert.equal(snap.totalCapacity, 3);
  assert.deepEqual([...snap.activeWorkspaces].sort(), ["bazel:ws:/ws-b", "gradle:/ws-a"]);

  // Resource key formats
  assert.deepEqual(extractBuildResourceKeyInfo("gradle:/ws-a"), { prefix: "gradle", path: "/ws-a" });
  assert.deepEqual(extractBuildResourceKeyInfo("bazel:ws:/ws-a"), { prefix: "bazel:ws", path: "/ws-a" });
  assert.deepEqual(extractBuildResourceKeyInfo("bazel:out:/tmp/out"), { prefix: "bazel:out", path: "/tmp/out" });
  assert.deepEqual(extractBuildResourceKeyInfo("xcode:dd:/dd"), { prefix: "xcode:dd", path: "/dd" });
  assert.deepEqual(extractBuildResourceKeyInfo("workspace:/ws"), { prefix: "workspace", path: "/ws" });

  assert.equal(doBuildResourceKeysConflict("gradle:/ws-a", "gradle:/ws-a"), true);
  assert.equal(doBuildResourceKeysConflict("gradle:/ws-a", "gradle:/ws-b"), false);
  assert.equal(doBuildResourceKeysConflict("gradle:/ws-a", "bazel:ws:/ws-a"), false, "different tools in one dir do not conflict by tool key");
  assert.equal(doBuildResourceKeysConflict("workspace:/ws-a", "gradle:/ws-a"), true);
  assert.equal(doBuildResourceKeysConflict("workspace:/ws-a", "bazel:ws:/ws-a/sub"), true, "generic workspace keys conflict with nested roots");
  assert.equal(doBuildResourceKeysConflict("workspace:/ws-a", "gradle:/ws-ab"), false, "path-component boundary");
  assert.equal(doBuildResourceKeysConflict("bazel:out:C:\\Shared\\Out", "bazel:out:c:/shared/out"), true, "Windows paths compare case-insensitively");
  assert.equal(doBuildResourceKeysConflict(null, "gradle:/ws-a"), false);
});

test("3-tier priority build queue, workspace lock, and starvation protection invariants", () => {
  const now = 100_000;
  const state = createDefaultState();
  state.config.maxConcurrentBuilds = 1;
  state.config.maxDeviceHolderBurstBuilds = 0;

  state.leases["serial:emulator-5554"] = {
    leaseId: "lease_dev1",
    sessionId: "sess-dev",
    state: "active",
    claimedAtMs: now - 5000,
    renewedAtMs: now - 1000,
    expiresAtMs: now + 600_000,
    firstSeenOfflineAtMs: null,
  };

  const queue = [
    {
      ticketId: "bq_pure",
      seq: 1,
      sessionId: "sess-pure",
      waiterPid: process.pid,
      resourceKeys: ["gradle:/ws-a"],
      requiresWorkspaceLock: true,
      requiresHeavySlot: true,
      pinnedDeviceLeaseId: null,
      enqueuedAtMs: now - 10_000,
      starvationDeadlineMs: now + 110_000,
      lastHeartbeatAtMs: now,
      waitExpiresAtMs: now + 60_000,
    },
    {
      ticketId: "bq_coupled",
      seq: 2,
      sessionId: "sess-dev",
      waiterPid: process.pid,
      resourceKeys: ["gradle:/ws-b"],
      requiresWorkspaceLock: true,
      requiresHeavySlot: true,
      pinnedDeviceLeaseId: "lease_dev1",
      enqueuedAtMs: now - 2_000,
      starvationDeadlineMs: now + 118_000,
      lastHeartbeatAtMs: now,
      waitExpiresAtMs: now + 60_000,
    },
  ];

  const stateView = {
    activeWorkspaces: new Set(),
    activeHeavyBuilds: 0,
    maxHostBuilds: 1,
    burstBuilds: 0,
    leases: state.leases,
  };

  const sel = pruneAndSelectNextBuildTicket(queue, stateView, now);
  assert.equal(queue[sel.chosenIdx]?.ticketId, "bq_coupled", "Device-holding build must win Tier 1 priority");

  // Starvation protection: if pure build reached starvationDeadlineMs, it promotes to Tier 0
  queue[0].starvationDeadlineMs = now - 1_000;
  const starvedSel = pruneAndSelectNextBuildTicket(queue, stateView, now);
  assert.equal(queue[starvedSel.chosenIdx]?.ticketId, "bq_pure", "Starved pure build must promote to Tier 0");

  // Workspace lock: a ticket whose key is already held is never chosen
  const lockedSel = pruneAndSelectNextBuildTicket(
    [{ ...queue[0], starvationDeadlineMs: now + 100_000 }],
    { ...stateView, activeWorkspaces: new Set(["gradle:/ws-a"]), maxHostBuilds: 4 },
    now,
  );
  assert.equal(lockedSel.chosenIdx, -1, "same workspace key must serialize");

  // Max concurrent builds: a full pool admits nothing (no burst for pure builds that are not starved)
  const fullSel = pruneAndSelectNextBuildTicket(
    [{ ...queue[0], starvationDeadlineMs: now + 100_000 }],
    { ...stateView, activeWorkspaces: new Set(["gradle:/ws-z"]), activeHeavyBuilds: 1, maxHostBuilds: 1, burstBuilds: 1 },
    now,
  );
  assert.equal(fullSel.chosenIdx, -1, "full build pool must queue pure builds");
});

test("reconcileBuildLease transitions aborted builds to draining and blocks workspace until cooldown", () => {
  const now = 200_000;
  const state = createDefaultState();
  const buildLease = {
    buildId: "build_1",
    resourceKeys: ["gradle:/ws-a"],
    requiresWorkspaceLock: true,
    requiresHeavySlot: true,
    state: "active",
    createdAtMs: now - 5_000,
    workerPid: 99999,
  };
  state.buildLeases[buildLease.buildId] = buildLease;

  const rec = reconcileBuildLease(buildLease, now, {
    clientGroupAlive: false,
    abortedOrTimedOut: true,
    abortCooldownMs: 5_000,
    maxDrainingMs: 30_000,
  });
  assert.equal(rec.action, "mark_draining");
  assert.equal(rec.lease.state, "draining");
  state.buildLeases[buildLease.buildId] = rec.lease;

  const snapDuringDrain = computeBuildPoolSnapshot(state, { cpuCores: 8, totalRamMb: 32768 });
  assert.equal(snapDuringDrain.usedBuildSlots, 1);
  assert.equal(snapDuringDrain.activeWorkspaces.has("gradle:/ws-a"), true);

  // After cooldown elapses and clientGroupAlive is false, reconcileBuildLease deletes the lease
  const recAfter = reconcileBuildLease(rec.lease, now + 6_000, {
    clientGroupAlive: false,
  });
  assert.equal(recAfter.action, "delete_lease");
});

test("Unified RAM admission accounts for recently started builds across emulator boots and builds", () => {
  const now = 500_000;
  const state = createDefaultState();
  state.config.minFreeRamMb = 2048;
  state.config.emulatorRamEstimateMb = 3072;
  state.config.buildRamEstimateMb = 3072;
  state.config.buildRamHysteresisMb = 256;

  state.buildLeases.build_recent = {
    buildId: "build_recent",
    state: "active",
    requiresHeavySlot: true,
    createdAtMs: now - 2_000,
    reservedRamMb: 3072,
    ramReservationUntilMs: now + 28_000,
  };

  const host = {
    availableRamMb: 6000,
    freeDiskMb: 20000,
    sampledAtMs: now - 5_000,
  };

  assert.equal(computeUnaccountedBuildRamMb(state, host.sampledAtMs, now), 3072);

  assert.throws(
    () =>
      checkResourceAdmission(
        { avd: "Pixel_7_API_35", platform: "android", kind: "emulator", ramSizeMb: 2048 },
        host,
        state,
        { running: [] },
        { now },
      ),
    /Insufficient host RAM/,
  );

  const buildRam = checkUnifiedRamAdmission(state, host, 3072, now);
  assert.equal(buildRam.allowed, false);
});

test("evaluateNestedBuildAdmission allows same-workspace re-entrant builds (including cross-tool KMP delta keys) and fails fast on cross-workspace deadlock", () => {
  const state = createDefaultState();
  state.buildLeases.build_parent = {
    buildId: "build_parent",
    sessionId: "sess-a",
    state: "active",
    opId: "op_parent",
    opNonce: "nonce_parent",
    workspaceRoot: "/repo-a",
    resourceKeys: ["xcode:/repo-a", "workspace:/repo-a"],
    requiresWorkspaceLock: true,
    requiresHeavySlot: true,
    workerPid: process.pid,
  };

  const sameWsCrossTool = evaluateNestedBuildAdmission(state, {
    inheritedOpId: "op_parent",
    inheritedNonce: "nonce_parent",
    ancestorPids: [process.pid],
    requestedKeys: ["gradle:/repo-a", "workspace:/repo-a"],
    requiresHeavySlot: true,
  });
  assert.equal(sameWsCrossTool.reentrant, true);
  assert.equal(sameWsCrossTool.deadlockHazard, false);
  assert.deepEqual(sameWsCrossTool.deltaKeys, ["gradle:/repo-a"]);
  assert.ok(state.buildLeases.build_parent.resourceKeys.includes("gradle:/repo-a"));

  const crossWs = evaluateNestedBuildAdmission(state, {
    inheritedOpId: "op_parent",
    inheritedNonce: "nonce_parent",
    ancestorPids: [process.pid],
    requestedKeys: ["gradle:/repo-b"],
    requiresHeavySlot: true,
  });
  assert.equal(crossWs.reentrant, false);
  assert.equal(crossWs.deadlockHazard, true);
  assert.match(crossWs.reason, /Failing fast to prevent self-deadlock/);

  // Re-entrant device escalation guard: pure build spawning device-requiring build without device lease
  const deviceEscalate = evaluateNestedBuildAdmission(state, {
    inheritedOpId: "op_parent",
    inheritedNonce: "nonce_parent",
    ancestorPids: [process.pid],
    requestedKeys: ["gradle:/repo-a"],
    requiresHeavySlot: true,
    requiresDevice: true,
    hasActiveDeviceLease: false,
  });
  assert.equal(deviceEscalate.reentrant, false);
  assert.equal(deviceEscalate.deadlockHazard, true);
  assert.match(deviceEscalate.reason, /while holding no active device lease/);
});

test("pruneAndSelectNextBuildTicket evaluates per-ticket device availability so blocked Ticket A does not block eligible Ticket B", () => {
  const now = 300_000;
  const queue = [
    {
      ticketId: "bq_coalloc_android_busy",
      seq: 1,
      sessionId: "sess-a",
      waiterPid: process.pid,
      resourceKeys: ["gradle:/ws-a"],
      requiresWorkspaceLock: true,
      requiresHeavySlot: true,
      pinnedDeviceLeaseId: null,
      requiresDeviceCoAlloc: true,
      coAllocResourceKey: "device:android",
      deviceAvailableForCoAlloc: false,
      enqueuedAtMs: now - 5_000,
      starvationDeadlineMs: now + 115_000,
      lastHeartbeatAtMs: now,
      waitExpiresAtMs: now + 60_000,
    },
    {
      ticketId: "bq_coalloc_ios_free",
      seq: 2,
      sessionId: "sess-b",
      waiterPid: process.pid,
      resourceKeys: ["gradle:/ws-b"],
      requiresWorkspaceLock: true,
      requiresHeavySlot: true,
      pinnedDeviceLeaseId: null,
      requiresDeviceCoAlloc: true,
      coAllocResourceKey: "device:ios",
      deviceAvailableForCoAlloc: true,
      enqueuedAtMs: now - 2_000,
      starvationDeadlineMs: now + 118_000,
      lastHeartbeatAtMs: now,
      waitExpiresAtMs: now + 60_000,
    },
  ];

  const stateView = {
    activeWorkspaces: new Set(),
    activeHeavyBuilds: 0,
    maxHostBuilds: 1,
    burstBuilds: 0,
    leases: {},
  };

  const sel = pruneAndSelectNextBuildTicket(queue, stateView, now);
  assert.equal(
    queue[sel.chosenIdx]?.ticketId,
    "bq_coalloc_ios_free",
    "Ticket B with available iOS device must be admitted even when older Ticket A's Android device is unavailable",
  );

  // Generic workspace:<root> conflicts with tool-specific gradle:<root>
  const customVsGradleSel = pruneAndSelectNextBuildTicket(
    [
      {
        ticketId: "bq_custom_ws",
        seq: 3,
        sessionId: "sess-c",
        waiterPid: process.pid,
        resourceKeys: ["workspace:/ws-shared"],
        requiresWorkspaceLock: true,
        requiresHeavySlot: true,
        pinnedDeviceLeaseId: null,
        requiresDeviceCoAlloc: false,
        enqueuedAtMs: now - 1_000,
        starvationDeadlineMs: now + 119_000,
        lastHeartbeatAtMs: now,
        waitExpiresAtMs: now + 60_000,
      },
    ],
    {
      activeWorkspaces: new Set(["gradle:/ws-shared"]),
      activeHeavyBuilds: 1,
      maxHostBuilds: 2,
      burstBuilds: 0,
      leases: {},
    },
    now,
  );
  assert.equal(
    customVsGradleSel.chosenIdx,
    -1,
    "Custom workspace:/ws-shared must conflict with active gradle:/ws-shared",
  );

  const gradleVsCustomSel = pruneAndSelectNextBuildTicket(
    [
      {
        ticketId: "bq_gradle_ws",
        seq: 4,
        sessionId: "sess-d",
        waiterPid: process.pid,
        resourceKeys: ["gradle:/ws-shared"],
        requiresWorkspaceLock: true,
        requiresHeavySlot: true,
        pinnedDeviceLeaseId: null,
        requiresDeviceCoAlloc: false,
        enqueuedAtMs: now - 1_000,
        starvationDeadlineMs: now + 119_000,
        lastHeartbeatAtMs: now,
        waitExpiresAtMs: now + 60_000,
      },
    ],
    {
      activeWorkspaces: new Set(["workspace:/ws-shared"]),
      activeHeavyBuilds: 1,
      maxHostBuilds: 2,
      burstBuilds: 0,
      leases: {},
    },
    now,
  );
  assert.equal(
    gradleVsCustomSel.chosenIdx,
    -1,
    "Tool-specific gradle:/ws-shared must conflict with active workspace:/ws-shared",
  );
});

test("starved pure builds can use burst slots, default burst capacity is 1, and audit logs rotate across 3 files", () => {
  const defaultState = createDefaultState();
  assert.equal(defaultState.config.maxDeviceHolderBurstBuilds, 1, "Default maxDeviceHolderBurstBuilds must be 1");

  const snap = computeBuildPoolSnapshot(defaultState, { cpuCores: 8, totalRamMb: 32768 });
  assert.equal(snap.burstBuilds, 1);

  // Starved pure-build ticket can use burst slot when base capacity is full
  const now = 500_000;
  const starvedQueue = [
    {
      ticketId: "bq_starved_pure",
      seq: 1,
      sessionId: "sess-pure",
      waiterPid: process.pid,
      resourceKeys: ["gradle:/ws-pure"],
      requiresWorkspaceLock: true,
      requiresHeavySlot: true,
      pinnedDeviceLeaseId: null,
      enqueuedAtMs: now - 130_000,
      starvationDeadlineMs: now - 10_000, // starved!
      lastHeartbeatAtMs: now,
      waitExpiresAtMs: now + 60_000,
    },
  ];
  const sel = pruneAndSelectNextBuildTicket(
    starvedQueue,
    {
      activeWorkspaces: new Set(["gradle:/ws-other"]),
      activeHeavyBuilds: 2,
      maxHostBuilds: 2,
      burstBuilds: 1,
      leases: {},
    },
    now,
  );
  assert.equal(sel.chosenIdx, 0, "Starved pure build must be admitted into burst slot");

  // Verify bounded 3-file audit log rotation (.1 -> .2 -> .3)
  const rotDir = path.join(makeTempDir(), "rot-logs");
  try {
    for (let i = 1; i <= 4; i++) {
      flushAuditEvents(
        [{ event: "build_admit", sessionId: `rot-${i}`, buildId: `b_${i}` }],
        { env: { ATC_LOG_DIR: rotDir }, maxFileBytes: 10, maxFiles: 3 },
      );
    }
    assert.ok(fs.existsSync(path.join(rotDir, "atc-audit.jsonl")));
    assert.ok(fs.existsSync(path.join(rotDir, "atc-audit.1.jsonl")));
    assert.ok(fs.existsSync(path.join(rotDir, "atc-audit.2.jsonl")));
    assert.ok(fs.existsSync(path.join(rotDir, "atc-audit.3.jsonl")));
  } finally {
    fs.rmSync(path.dirname(rotDir), { recursive: true, force: true });
  }
});

test("computeUnaccountedBuildRamMb keeps preparingDevice build RAM reserved even after initial 30s window", () => {
  const now = 900_000;
  const state = createDefaultState();
  state.buildLeases.build_cold = {
    buildId: "build_cold",
    state: "active",
    preparingDevice: true,
    requiresHeavySlot: true,
    createdAtMs: now - 45_000,
    expiresAtMs: now + 300_000,
    reservedRamMb: 3072,
    ramReservationUntilMs: now - 15_000, // initial 30s elapsed while device is still booting
  };
  assert.equal(
    computeUnaccountedBuildRamMb(state, now - 1_000, now),
    3072,
    "Build waiting on cold device preparation must keep its RAM reservation active",
  );
  assert.equal(
    computeUnaccountedBuildRamMb(state, now - 1_000, now, { excludeBuildId: "build_cold" }),
    0,
  );
});

// ---------------------------------------------------------------------------
// Gradle: gradle.properties heap/daemon detection and warm daemon probing
// ---------------------------------------------------------------------------

test("Gradle heap/daemon detection from gradle.properties, JVM option env vars and invocation env", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-gradle-props-"));
  try {
    const dirB = path.join(wsDir, "b");
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, "settings.gradle"), "rootProject.name = 'b'\n");
    const subAppDir = path.join(wsDir, "app");
    fs.mkdirSync(subAppDir, { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "settings.gradle"), "rootProject.name = 'subapp'\n");

    // gradle.properties org.gradle.jvmargs supplies the heap hint
    fs.writeFileSync(path.join(subAppDir, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8\n");
    const subAppGradleReqs = resolveBuildResources("./gradlew", ["build"], subAppDir);
    assert.equal(subAppGradleReqs.requestedHeapMb, 2048);
    assert.equal(subAppGradleReqs.disablesDaemon, false);

    // Java .properties parser supports ':' separator and backslash line continuation in gradle.properties
    fs.writeFileSync(
      path.join(subAppDir, "gradle.properties"),
      "! comment line\norg.gradle.jvmargs : -Xmx4g \\\n  -Dfile.encoding=UTF-8\n",
    );
    assert.equal(resolveBuildResources("./gradlew", ["build"], subAppDir).requestedHeapMb, 4096);

    // $GRADLE_USER_HOME/gradle.properties overrides project properties
    const isolatedGradleHome = path.join(wsDir, "isolated-gradle-home");
    fs.mkdirSync(isolatedGradleHome, { recursive: true });
    fs.writeFileSync(path.join(isolatedGradleHome, "gradle.properties"), "org.gradle.jvmargs=-Xmx8g -Dfile.encoding=UTF-8\n");
    const userHomeOverrideReqs = resolveBuildResources("./gradlew", ["build"], subAppDir, {
      env: { ...process.env, GRADLE_USER_HOME: isolatedGradleHome },
    });
    assert.equal(userHomeOverrideReqs.requestedHeapMb, 8192);
    assert.equal(userHomeOverrideReqs.gradleUserHomeDir, isolatedGradleHome);

    // gradle/gradle-daemon-jvm.properties marks the build cold
    fs.mkdirSync(path.join(subAppDir, "gradle"), { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "gradle", "gradle-daemon-jvm.properties"), "toolchainVersion=21\ntoolchainVendor=temurin\n");
    assert.equal(resolveBuildResources("./gradlew", ["build"], subAppDir).disablesDaemon, true);

    // Installation-level $GRADLE_HOME/gradle.properties is loaded with lowest precedence
    const fakeGradleHome = path.join(wsDir, "gradle-dist");
    const fakeUserHome = path.join(wsDir, "gradle-user");
    fs.mkdirSync(fakeGradleHome, { recursive: true });
    fs.mkdirSync(fakeUserHome, { recursive: true });
    fs.writeFileSync(path.join(fakeGradleHome, "gradle.properties"), "org.gradle.jvmargs=-Xmx3g\norg.gradle.daemon=false\n");
    const gradleHomeOnlyReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, {
      env: { GRADLE_HOME: fakeGradleHome, GRADLE_USER_HOME: fakeUserHome },
    });
    assert.equal(gradleHomeOnlyReqs.requestedHeapMb, 3072);
    assert.equal(gradleHomeOnlyReqs.disablesDaemon, true);

    // Project gradle.properties overrides $GRADLE_HOME/gradle.properties
    fs.writeFileSync(path.join(dirB, "gradle.properties"), "org.gradle.jvmargs=-Xmx4g\norg.gradle.daemon=true\n");
    const projectOverridesDistReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, {
      env: { GRADLE_HOME: fakeGradleHome, GRADLE_USER_HOME: fakeUserHome },
    });
    assert.equal(projectOverridesDistReqs.requestedHeapMb, 4096);
    assert.equal(projectOverridesDistReqs.disablesDaemon, false);

    // Duplicate heap flags: the last one wins
    fs.writeFileSync(path.join(dirB, "gradle.properties"), "org.gradle.jvmargs=-Xmx1g -Xmx8g\n");
    assert.equal(
      resolveBuildResources("./gradlew", ["assembleDebug"], dirB, { env: { GRADLE_USER_HOME: fakeUserHome } }).requestedHeapMb,
      8192,
    );
    fs.rmSync(path.join(dirB, "gradle.properties"), { force: true });

    // JVM option env vars (_JAVA_OPTIONS, JAVA_OPTS, GRADLE_OPTS, JAVA_TOOL_OPTIONS) override a smaller CLI heap and mark the build cold
    for (const [key, val, expected] of [
      ["_JAVA_OPTIONS", "-Xmx16g", 16384],
      ["JAVA_OPTS", "-Xmx8g", 8192],
      ["GRADLE_OPTS", "-Xmx6g", 6144],
      ["JAVA_TOOL_OPTIONS", "-Xmx12g", 12288],
    ]) {
      const res = resolveBuildResources("./gradlew", ["-Dorg.gradle.jvmargs=-Xmx1g", "assembleDebug"], dirB, {
        env: { [key]: val, GRADLE_USER_HOME: fakeUserHome },
      });
      assert.equal(res.requestedHeapMb, expected, key);
      assert.equal(res.disablesDaemon, true, key);
    }

    // Per-invocation env (batch step env) is honoured the same way as the caller env
    const gradleOptsReqs = resolveBuildResources("./gradlew", ["build"], subAppDir, {
      inheritedEnvVars: { GRADLE_OPTS: "-Dorg.gradle.jvmargs=-Xmx8g" },
    });
    assert.equal(gradleOptsReqs.disablesDaemon, true);
    assert.equal(gradleOptsReqs.requestedHeapMb, 8192);

    // -Xms initial heap settings also reserve RAM alongside -Xmx
    const xmsGradleHeap = resolveBuildResources("./gradlew", ["-Dorg.gradle.jvmargs=-Xms8g", "assembleDebug"], dirB, {
      env: { GRADLE_USER_HOME: fakeUserHome },
    });
    assert.equal(xmsGradleHeap.requestedHeapMb, 8192);
    assert.equal(computeColdBuildRamDemandMb(xmsGradleHeap, 3072), 8192);

    // CLI daemon-affecting flags mark the invocation cold
    for (const flag of ["--no-daemon", "-Dorg.gradle.daemon=false", "--java-home=/jdk", "-Dgradle.user.home=/tmp/x"]) {
      assert.equal(resolveBuildResources("./gradlew", ["build", flag], dirB, { env: {} }).disablesDaemon, true, flag);
    }

    // Invocation env overrides and unsets are recorded for warm-daemon matching
    const javaHomeReqs = resolveBuildResources("./gradlew", ["build"], dirB, { inheritedEnvVars: { JAVA_HOME: "/opt/jdk-21" } });
    assert.equal(javaHomeReqs.envJavaHome, "/opt/jdk-21");
    const unsetJavaHomeReqs = resolveBuildResources("./gradlew", ["build"], dirB, { inheritedEnvVars: { JAVA_HOME: null } });
    assert.equal(unsetJavaHomeReqs.envJavaHomeUnset, true);
    const isolatedHomeReqs = resolveBuildResources("./gradlew", ["build"], dirB, {
      env: {},
      inheritedEnvVars: { GRADLE_USER_HOME: isolatedGradleHome },
    });
    assert.equal(isolatedHomeReqs.envGradleUserHome, isolatedGradleHome);
    assert.equal(isolatedHomeReqs.gradleUserHomeDir, isolatedGradleHome);
    const clearedHomeReqs = resolveBuildResources("./gradlew", ["build"], dirB, {
      env: { GRADLE_USER_HOME: isolatedGradleHome },
      inheritedEnvVars: { GRADLE_USER_HOME: null },
    });
    assert.equal(clearedHomeReqs.envGradleUserHomeUnset, true);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("probeWarmBuildDaemons matches warm Gradle daemons by version, JVM, user home, JVM args and locale", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atc-warm-gradle-"));
  try {
    const spacedAppDir = path.join(tmpRoot, "my app");
    fs.mkdirSync(spacedAppDir, { recursive: true });
    fs.writeFileSync(path.join(spacedAppDir, "settings.gradle.kts"), "");
    const canonicalSpacedApp = canonicalizeBuildPath(spacedAppDir);

    // Wrapper version match
    const wrapperDir = path.join(spacedAppDir, "gradle", "wrapper");
    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(wrapperDir, "gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n",
    );
    const gradleReqs = resolveBuildResources("./gradlew", ["assembleDebug"], spacedAppDir, {
      env: { PATH: "", GRADLE_OPTS: "", JAVA_OPTS: "" },
    });
    const warmGradle = probeWarmBuildDaemons(gradleReqs, {
      env: { PATH: "", GRADLE_OPTS: "", JAVA_OPTS: "" },
      runner: () => ({
        stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
      }),
    });
    assert.equal(warmGradle.warm, true);
    assert.deepEqual(warmGradle.daemonPids, [44123]);

    const extraJvmArgsGradle = probeWarmBuildDaemons(gradleReqs, {
      env: { PATH: "", GRADLE_OPTS: "", JAVA_OPTS: "" },
      runner: () => ({
        stdout:
          "  44123 /Library/Java/bin/java -Xmx8g -Dfile.encoding=US-ASCII org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
      }),
    });
    assert.equal(extraJvmArgsGradle.warm, false);

    const mismatchedGradle = probeWarmBuildDaemons(gradleReqs, {
      env: { PATH: "" },
      runner: () => ({
        stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.9\n",
      }),
    });
    assert.equal(mismatchedGradle.warm, false);

    const noDaemonReqs = resolveBuildResources("./gradlew", ["assembleDebug", "--no-daemon"], spacedAppDir);
    assert.equal(
      probeWarmBuildDaemons(noDaemonReqs, {
        runner: () => ({
          stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
        }),
      }).warm,
      false,
    );

    // Inventory-provided warm daemons are matched per tool and workspace
    assert.equal(
      probeWarmBuildDaemons(gradleReqs, {
        inventory: { warmBuildDaemons: [{ tool: "bazel", workspaceRoot: canonicalSpacedApp, pid: 2222 }] },
      }).warm,
      false,
    );
    const inventoryWarm = probeWarmBuildDaemons(gradleReqs, {
      inventory: { warmBuildDaemons: [{ tool: "gradle", workspaceRoot: canonicalSpacedApp, pid: 1111 }] },
    });
    assert.equal(inventoryWarm.warm, true);
    assert.deepEqual(inventoryWarm.daemonPids, [1111]);

    // Invocation JAVA_HOME is honored when matching warm Gradle daemons
    const javaHomeReqs = resolveBuildResources("./gradlew", ["assembleDebug"], spacedAppDir, {
      inheritedEnvVars: { JAVA_HOME: "/opt/jdk-21" },
    });
    assert.equal(
      probeWarmBuildDaemons(javaHomeReqs, {
        platform: "darwin",
        runner: () => ({ status: 0, stdout: "54321 /opt/jdk-17/bin/java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n" }),
      }).warm,
      false,
    );
    assert.equal(
      probeWarmBuildDaemons(javaHomeReqs, {
        platform: "darwin",
        runner: () => ({ status: 0, stdout: "54321 /opt/jdk-21/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n" }),
      }).warm,
      true,
    );

    // Unset JAVA_HOME resolves java from PATH
    const wsDir = path.join(tmpRoot, "ws");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");
    const unsetJavaHomeReqs = resolveBuildResources("./gradlew", ["build"], wsDir, { inheritedEnvVars: { JAVA_HOME: null } });
    const mockJdkHome = path.join(wsDir, "jdk21");
    const mockJdkBin = path.join(mockJdkHome, "bin");
    fs.mkdirSync(mockJdkBin, { recursive: true });
    fs.writeFileSync(path.join(mockJdkBin, process.platform === "win32" ? "java.exe" : "java"), "");
    const canonicalMockJdkHome = realpath(mockJdkHome);
    const mockJava = path.join(canonicalMockJdkHome, "bin", "java");
    assert.equal(
      probeWarmBuildDaemons(unsetJavaHomeReqs, {
        env: { JAVA_HOME: "/nonexistent/parent/java", PATH: mockJdkBin },
        runner: () => ({
          stdout: `4241 /Library/Java/JDK17/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${unsetJavaHomeReqs.workspaceRoot}\n`,
        }),
      }).warm,
      false,
    );
    assert.equal(
      probeWarmBuildDaemons(unsetJavaHomeReqs, {
        env: { JAVA_HOME: "/nonexistent/parent/java", PATH: mockJdkBin },
        runner: () => ({ stdout: `4242 ${mockJava} org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${unsetJavaHomeReqs.workspaceRoot}\n` }),
      }).warm,
      true,
    );
    assert.equal(
      probeWarmBuildDaemons(unsetJavaHomeReqs, {
        env: { JAVA_HOME: "/nonexistent/parent/java", PATH: path.join(wsDir, "no-such-bin") },
        runner: () => ({ stdout: `4242 ${mockJava} org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${unsetJavaHomeReqs.workspaceRoot}\n` }),
      }).warm,
      false,
    );

    // GRADLE_USER_HOME isolation in warm daemon probe
    const isolatedGradleHome = path.join(wsDir, "isolated-gradle-home");
    const gradleUserHomeReqs = resolveBuildResources("./gradlew", ["build"], wsDir, {
      inheritedEnvVars: { GRADLE_USER_HOME: isolatedGradleHome },
    });
    assert.equal(
      probeWarmBuildDaemons(gradleUserHomeReqs, {
        env: { JAVA_HOME: canonicalMockJdkHome },
        runner: () => ({ stdout: `4242 ${mockJava} org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${gradleUserHomeReqs.workspaceRoot}\n` }),
      }).warm,
      false,
    );
    assert.equal(
      probeWarmBuildDaemons(gradleUserHomeReqs, {
        env: { JAVA_HOME: canonicalMockJdkHome },
        runner: () => ({
          stdout: `4242 ${mockJava} -Dgradle.user.home=${isolatedGradleHome} org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${gradleUserHomeReqs.workspaceRoot}\n`,
        }),
      }).warm,
      true,
    );

    // A cleared invocation GRADLE_USER_HOME does not fall back to the caller's GRADLE_USER_HOME
    const clearedHomeReqs = resolveBuildResources("./gradlew", ["build"], wsDir, {
      inheritedEnvVars: { GRADLE_USER_HOME: null, PATH: mockJdkBin },
    });
    assert.equal(clearedHomeReqs.envGradleUserHomeUnset, true);
    assert.equal(
      probeWarmBuildDaemons(clearedHomeReqs, {
        env: { GRADLE_USER_HOME: isolatedGradleHome, JAVA_HOME: canonicalMockJdkHome },
        runner: () => ({
          stdout: `4242 ${mockJava} -Dgradle.user.home=${isolatedGradleHome} org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${clearedHomeReqs.workspaceRoot}\n`,
        }),
      }).warm,
      false,
    );

    // gradle.properties org.gradle.jvmargs compares all daemon-affecting JVM args (including -D properties)
    const subAppDir = path.join(wsDir, "app");
    fs.mkdirSync(subAppDir, { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "settings.gradle"), "rootProject.name = 'subapp'\n");
    const canonicalSubApp = realpath(subAppDir);
    fs.writeFileSync(path.join(subAppDir, "gradle.properties"), "org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8\n");
    const subAppGradleReqs = resolveBuildResources("./gradlew", ["build"], subAppDir);
    assert.equal(
      probeWarmBuildDaemons(subAppGradleReqs, {
        env: { JAVA_HOME: canonicalMockJdkHome },
        runner: () => ({
          stdout: `5001 ${mockJava} -Xmx2g -Dfile.encoding=US-ASCII org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalSubApp}\n`,
        }),
      }).warm,
      false,
    );
    assert.equal(
      probeWarmBuildDaemons(subAppGradleReqs, {
        env: { JAVA_HOME: canonicalMockJdkHome },
        runner: () => ({
          stdout: `5001 ${mockJava} -Xmx2g -Dfile.encoding=UTF-8 org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalSubApp}\n`,
        }),
      }).warm,
      true,
    );

    // $GRADLE_USER_HOME/gradle.properties heap override rejects a daemon started with the stale project heap
    fs.mkdirSync(isolatedGradleHome, { recursive: true });
    fs.writeFileSync(path.join(isolatedGradleHome, "gradle.properties"), "org.gradle.jvmargs=-Xmx8g -Dfile.encoding=UTF-8\n");
    const userHomeOverrideReqs = resolveBuildResources("./gradlew", ["build"], subAppDir, {
      env: { ...process.env, GRADLE_USER_HOME: isolatedGradleHome },
    });
    assert.equal(
      probeWarmBuildDaemons(userHomeOverrideReqs, {
        env: { JAVA_HOME: canonicalMockJdkHome, GRADLE_USER_HOME: isolatedGradleHome },
        runner: () => ({
          stdout: `5002 ${mockJava} -Dgradle.user.home=${isolatedGradleHome} -Xmx2g -Dfile.encoding=UTF-8 org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalSubApp}\n`,
        }),
      }).warm,
      false,
    );

    // gradle-daemon-jvm.properties prevents warm daemon false positives
    fs.writeFileSync(path.join(subAppDir, "gradle.properties"), "org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8\n");
    fs.mkdirSync(path.join(subAppDir, "gradle"), { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "gradle", "gradle-daemon-jvm.properties"), "toolchainVersion=21\n");
    const daemonCriteriaReqs = resolveBuildResources("./gradlew", ["build"], subAppDir);
    assert.equal(
      probeWarmBuildDaemons(daemonCriteriaReqs, {
        env: { JAVA_HOME: canonicalMockJdkHome },
        runner: () => ({
          stdout: `5001 ${mockJava} -Xmx4g -Dfile.encoding=UTF-8 org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalSubApp}\n`,
        }),
      }).warm,
      false,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("probeWarmBuildDaemons: default Gradle JVM args, locale, duplicate heap precedence and busy daemon exclusion", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-warm-default-"));
  try {
    const dirB = path.join(wsDir, "b");
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, "settings.gradle"), "rootProject.name = 'b'\n");
    const canonicalDirB = realpath(dirB);
    const mockJdk = path.join(wsDir, "jdk-def");
    fs.mkdirSync(path.join(mockJdk, "bin"), { recursive: true });
    fs.writeFileSync(path.join(mockJdk, "bin", process.platform === "win32" ? "java.exe" : "java"), "");
    const canonicalMockJdk = realpath(mockJdk);
    const java = path.join(canonicalMockJdk, "bin", "java");
    const fakeUserHome = path.join(wsDir, "gradle-user");
    fs.mkdirSync(fakeUserHome, { recursive: true });

    // Default Gradle JVM arguments match warm daemon when org.gradle.jvmargs is unset
    const plainReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, { env: { HOME: wsDir } });
    const defaultJvmWarmProbe = probeWarmBuildDaemons(plainReqs, {
      env: { JAVA_HOME: canonicalMockJdk, HOME: wsDir },
      runner: () => ({
        stdout: `7001 ${java} -Xmx512m -XX:MaxMetaspaceSize=384m -XX:+HeapDumpOnOutOfMemoryError org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalDirB}\n`,
      }),
    });
    assert.equal(defaultJvmWarmProbe.warm, true);
    assert.deepEqual(defaultJvmWarmProbe.daemonPids, [7001]);
    assert.equal(
      probeWarmBuildDaemons(plainReqs, {
        env: { JAVA_HOME: canonicalMockJdk, HOME: wsDir },
        runner: () => ({
          stdout: `7002 ${java} -Xmx2g -XX:MaxMetaspaceSize=384m org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalDirB}\n`,
        }),
      }).warm,
      false,
      "non-default heap when org.gradle.jvmargs is unset must not match",
    );

    // Duplicate JVM heap args: effective (last) value must match the daemon
    fs.writeFileSync(path.join(dirB, "gradle.properties"), "org.gradle.jvmargs=-Xmx1g -Xmx8g\n");
    const dupHeapReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, {
      env: { JAVA_HOME: canonicalMockJdk, GRADLE_USER_HOME: fakeUserHome },
    });
    assert.equal(dupHeapReqs.requestedHeapMb, 8192);
    assert.equal(
      probeWarmBuildDaemons(dupHeapReqs, {
        env: { JAVA_HOME: canonicalMockJdk, GRADLE_USER_HOME: fakeUserHome },
        runner: () => ({
          stdout: `7010 ${java} -Dgradle.user.home=${fakeUserHome} -Xmx8g -Xmx1g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalDirB}\n`,
        }),
      }).warm,
      false,
    );
    const matchingEffectiveDaemonProbe = probeWarmBuildDaemons(dupHeapReqs, {
      env: { JAVA_HOME: canonicalMockJdk, GRADLE_USER_HOME: fakeUserHome },
      runner: () => ({
        stdout: `7011 ${java} -Dgradle.user.home=${fakeUserHome} -Xmx8g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalDirB}\n`,
      }),
    });
    assert.equal(matchingEffectiveDaemonProbe.warm, true);
    assert.deepEqual(matchingEffectiveDaemonProbe.daemonPids, [7011]);
    fs.rmSync(path.join(dirB, "gradle.properties"), { force: true });

    // Full default Gradle daemon compatibility set including locale
    const defaultGradleReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, {
      env: { JAVA_HOME: canonicalMockJdk, GRADLE_USER_HOME: fakeUserHome },
    });
    const daemonLine = (pid, country, lang) =>
      `${pid} ${java} -XX:MaxMetaspaceSize=384m -XX:+HeapDumpOnOutOfMemoryError -Xms256m -Xmx512m -Dfile.encoding=UTF-8 -Duser.country=${country} -Duser.language=${lang} -Duser.variant -Dgradle.user.home=${fakeUserHome} org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${canonicalDirB}`;
    const baseEnv = { JAVA_HOME: canonicalMockJdk, GRADLE_USER_HOME: fakeUserHome };
    const localeEnv = (lang) => ({ ...baseEnv, LC_ALL: "", LC_MESSAGES: "", LANG: lang });

    const fullDefaultDaemonProbe = probeWarmBuildDaemons(defaultGradleReqs, {
      env: baseEnv,
      runner: () => ({ stdout: `${daemonLine(7020, "US", "en")}\n` }),
    });
    assert.equal(fullDefaultDaemonProbe.warm, true);
    assert.deepEqual(fullDefaultDaemonProbe.daemonPids, [7020]);
    assert.equal(
      probeWarmBuildDaemons(defaultGradleReqs, { env: localeEnv("en_US.UTF-8"), runner: () => ({ stdout: `${daemonLine(7021, "FR", "fr")}\n` }) }).warm,
      false,
    );
    assert.equal(
      probeWarmBuildDaemons(defaultGradleReqs, { env: localeEnv("fr_FR.UTF-8"), runner: () => ({ stdout: `${daemonLine(7022, "US", "en")}\n` }) }).warm,
      false,
      "non-English host locale rejects English daemon",
    );
    assert.equal(
      probeWarmBuildDaemons(defaultGradleReqs, { env: localeEnv("fr_FR.UTF-8"), runner: () => ({ stdout: `${daemonLine(7023, "FR", "fr")}\n` }) }).warm,
      true,
    );

    // Invocation-level LANG override / unset (batch step env) is honoured over the caller env
    const frInvocationReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, {
      env: localeEnv("en_US.UTF-8"),
      inheritedEnvVars: { LANG: "fr_FR.UTF-8" },
    });
    assert.equal(
      probeWarmBuildDaemons(frInvocationReqs, { env: localeEnv("en_US.UTF-8"), runner: () => ({ stdout: `${daemonLine(7024, "US", "en")}\n` }) }).warm,
      false,
    );
    const unsetLangReqs = resolveBuildResources("./gradlew", ["assembleDebug"], dirB, {
      env: localeEnv("fr_FR.UTF-8"),
      inheritedEnvVars: { LANG: null },
    });
    assert.equal(
      probeWarmBuildDaemons(unsetLangReqs, { env: localeEnv("fr_FR.UTF-8"), runner: () => ({ stdout: `${daemonLine(7025, "FR", "fr")}\n` }) }).warm,
      false,
    );

    // Busy Gradle daemon is not double-counted as warm for a concurrent Gradle build
    const otherLease = (claimedDaemonPid) => ({
      build_other_gradle: {
        buildId: "build_other_gradle",
        tool: "gradle",
        requiresHeavySlot: true,
        state: "active",
        preparingDevice: false,
        claimedDaemonPid,
      },
    });
    const busyGradleProbeSingle = probeWarmBuildDaemons(defaultGradleReqs, {
      env: baseEnv,
      activeBuildLeases: otherLease(7020),
      runner: () => ({ stdout: `${daemonLine(7020, "US", "en")}\n` }),
    });
    assert.equal(busyGradleProbeSingle.warm, false);
    assert.deepEqual(busyGradleProbeSingle.daemonPids, []);

    const incompatibleBusyGradleProbe = probeWarmBuildDaemons(defaultGradleReqs, {
      env: baseEnv,
      activeBuildLeases: otherLease(8001),
      runner: () => ({ stdout: `${daemonLine(7020, "US", "en")}\n` }),
    });
    assert.equal(incompatibleBusyGradleProbe.warm, true);
    assert.deepEqual(incompatibleBusyGradleProbe.daemonPids, [7020]);

    const busyGradleProbeTwoDaemons = probeWarmBuildDaemons(defaultGradleReqs, {
      env: baseEnv,
      activeBuildLeases: otherLease(7020),
      runner: () => ({ stdout: [daemonLine(7020, "US", "en"), daemonLine(7021, "US", "en")].join("\n") }),
    });
    assert.equal(busyGradleProbeTwoDaemons.warm, true);
    assert.deepEqual(busyGradleProbeTwoDaemons.daemonPids, [7021]);

    const busyGradleClientPsProbe = probeWarmBuildDaemons(defaultGradleReqs, {
      env: baseEnv,
      runner: () => ({
        stdout: [`7019 ${java} org.gradle.wrapper.GradleWrapperMain assembleDebug`, daemonLine(7020, "US", "en")].join("\n"),
      }),
    });
    assert.equal(busyGradleClientPsProbe.warm, false);
    assert.deepEqual(busyGradleClientPsProbe.daemonPids, []);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bazel: bazelrc parsing, output bases, version detection and warm server probing
// ---------------------------------------------------------------------------

test("Bazel output bases and warm server probing require exact workspace identity and default output base", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-bazel-warm-"));
  try {
    const subAppDir = path.join(wsDir, "app");
    fs.mkdirSync(subAppDir, { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "MODULE.bazel"), 'module(name = "app")\n');
    const canonicalSubApp = realpath(subAppDir);

    const bazelAppReqs = resolveBuildResources("bazel", ["--nosystem_rc", "build", "//..."], subAppDir, { bazelMajorVersion: 9 });
    assert.equal(bazelAppReqs.workspaceRoot, canonicalSubApp);
    assert.deepEqual(bazelAppReqs.resourceKeys, [`bazel:ws:${canonicalSubApp}`]);
    assert.equal(
      probeWarmBuildDaemons(bazelAppReqs, {
        runner: () => ({ stdout: "9001 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --workspace_directory=/other/work/app\n" }),
      }).warm,
      false,
      "basename-only bazel(app) match is not enough",
    );
    assert.equal(
      probeWarmBuildDaemons(bazelAppReqs, {
        runner: () => ({
          stdout: `9001 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --output_base=/tmp/custom-bazel-out --workspace_directory=${canonicalSubApp}\n`,
        }),
      }).warm,
      false,
      "custom --output_base server must not match a default invocation",
    );
    const defaultSubAppBazelOut = computeDefaultBazelOutputBases(canonicalSubApp, { bazelMajorVersion: 9 })[0];
    const exactWorkspaceProbe = probeWarmBuildDaemons(bazelAppReqs, {
      runner: () => ({
        stdout: `9002 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --output_base=${defaultSubAppBazelOut} --workspace_directory=${canonicalSubApp}\n`,
      }),
    });
    assert.equal(exactWorkspaceProbe.warm, true);
    assert.deepEqual(exactWorkspaceProbe.daemonPids, [9002]);
    assert.equal(
      probeWarmBuildDaemons(bazelAppReqs, {
        runner: () => ({ stdout: `9003 bazel(app2) -XX:+HeapDumpOnOutOfMemoryError --workspace_directory=${canonicalSubApp}2\n` }),
      }).warm,
      false,
      "path-component boundary (rejects /work/app2 for /work/app)",
    );

    // macOS Bazel 8 vs Bazel 9 default output root + conservative cold fallback when version is ambiguous
    const ambiguousDarwinReqs = resolveBuildResources("bazel", ["--nosystem_rc", "build", "//..."], subAppDir, { platform: "darwin" });
    assert.deepEqual(computeDefaultBazelOutputBases(canonicalSubApp, { platform: "darwin" }), []);
    assert.equal(
      probeWarmBuildDaemons(ambiguousDarwinReqs, {
        platform: "darwin",
        runner: () => ({
          stdout: `9003 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --output_base=/private/var/tmp/_bazel_alice/0123456789abcdef --workspace_directory=${canonicalSubApp}\n`,
        }),
      }).warm,
      false,
    );
    assert.ok(
      computeDefaultBazelOutputBases(canonicalSubApp, {
        platform: "darwin",
        bazelMajorVersion: 9,
        env: { USER: "alice", HOME: "/Users/alice" },
      }).some((p) => p.includes("/Users/alice/Library/Caches/bazel/_bazel_alice/")),
    );
    assert.ok(
      computeDefaultBazelOutputBases(canonicalSubApp, {
        platform: "darwin",
        bazelMajorVersion: 9,
        env: { USER: "alice", HOME: "/Users/alice", XDG_CACHE_HOME: "/custom/xdg" },
      }).some((p) => p.includes("/custom/xdg/bazel/_bazel_alice/")),
    );
    assert.ok(
      computeDefaultBazelOutputBases(canonicalSubApp, {
        platform: "darwin",
        bazelMajorVersion: 8,
        env: { USER: "alice", HOME: "/Users/alice" },
      }).some((p) => p.startsWith("/private/var/tmp/_bazel_alice/")),
    );

    // POSIX username fallback ignores LOGNAME/USERNAME when USER is unset and sanitizes / and \
    const unsetUserReqs = resolveBuildResources("bazel", ["--nosystem_rc", "build", "//..."], subAppDir, {
      platform: "linux",
      env: { USER: "stale", HOME: "/home/acct" },
      inheritedEnvVars: { USER: null, LOGNAME: "ci", USERNAME: "ci" },
    });
    assert.equal(
      computeDefaultBazelOutputBases(canonicalSubApp, {
        buildReqs: unsetUserReqs,
        platform: "linux",
        env: { LOGNAME: "ci", USERNAME: "ci", HOME: "/home/acct" },
      }).some((p) => p.includes("/_bazel_ci/")),
      false,
    );
    assert.ok(
      computeDefaultBazelOutputBases(canonicalSubApp, {
        platform: "linux",
        env: { USER: "CORP\\team/alice", HOME: "/home/alice" },
      }).some((p) => p.includes("/_bazel_CORP_team_alice/")),
    );

    // --output_user_root derives an output base and does not match default-root servers
    const isolatedBazelRoot = path.join(wsDir, "bazel-user-root");
    fs.mkdirSync(isolatedBazelRoot, { recursive: true });
    const bazelUserRootReqs = resolveBuildResources("bazel", [`--output_user_root=${isolatedBazelRoot}`, "build", "//..."], subAppDir);
    assert.ok(bazelUserRootReqs.resourceKeys.some((k) => k.startsWith("bazel:out:")));
    assert.equal(
      probeWarmBuildDaemons(bazelUserRootReqs, {
        runner: () => ({ stdout: `9004 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --workspace_directory=${canonicalSubApp}\n` }),
      }).warm,
      false,
    );

    // Server-changing startup options (--host_jvm_args) mark the invocation cold and record requestedHeapMb
    const bazelHostJvmReqs = resolveBuildResources("bazel", ["--host_jvm_args=-Xmx8g", "build", "//..."], subAppDir);
    assert.equal(bazelHostJvmReqs.disablesDaemon, true);
    assert.equal(bazelHostJvmReqs.requestedHeapMb, 8192);
    assert.equal(
      probeWarmBuildDaemons(bazelHostJvmReqs, {
        runner: () => ({ stdout: `9005 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --workspace_directory=${canonicalSubApp}\n` }),
      }).warm,
      false,
    );
    const xmsBazelHeap = resolveBuildResources("bazel", ["--nosystem_rc", "--host_jvm_args=-Xms6g", "build", "//..."], subAppDir);
    assert.equal(xmsBazelHeap.requestedHeapMb, 6144);

    // Nonexistent Windows shared output_base normalizes case-insensitively
    const winOutUpper = resolveBuildResources("bazel", ["--nosystem_rc", "--output_base=C:\\Shared\\Out", "build", "//..."], subAppDir, { platform: "win32" });
    const winOutLower = resolveBuildResources("bazel", ["--nosystem_rc", "--output_base=c:\\shared\\out", "build", "//..."], wsDir, { platform: "win32" });
    assert.ok(winOutUpper.resourceKeys.includes("bazel:out:c:\\shared\\out"));
    assert.ok(winOutLower.resourceKeys.includes("bazel:out:c:\\shared\\out"));
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("bazelrc parsing: workspace/system/env/explicit rc files, imports, version-gated imports and startup:<os>", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-bazelrc-"));
  try {
    const subAppDir = path.join(wsDir, "app");
    fs.mkdirSync(subAppDir, { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "MODULE.bazel"), 'module(name = "app")\n');
    const dirA = path.join(wsDir, "a");
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, "MODULE.bazel"), 'module(name = "a")\n');
    const canonicalDirA = realpath(dirA);

    // Workspace .bazelrc startup options (--output_base and --host_jvm_args) are loaded into resourceKeys and requestedHeapMb
    const sharedBazelOut = path.join(wsDir, "shared-bazel-out");
    fs.mkdirSync(sharedBazelOut, { recursive: true });
    const canonicalSharedBazelOut = realpath(sharedBazelOut);
    fs.writeFileSync(path.join(subAppDir, ".bazelrc"), `startup --output_base=${canonicalSharedBazelOut}\nstartup --host_jvm_args=-Xmx6g\n`);
    const bazelrcReqs = resolveBuildResources("bazel", ["build", "//..."], subAppDir, { systemBazelrcPath: null });
    assert.ok(bazelrcReqs.resourceKeys.includes(`bazel:out:${canonicalSharedBazelOut}`));
    assert.equal(bazelrcReqs.disablesDaemon, true);
    assert.equal(bazelrcReqs.requestedHeapMb, 6144);
    fs.rmSync(path.join(subAppDir, ".bazelrc"));

    // BAZELRC environment variable (single or comma-separated) loads startup options
    const envRc1 = path.join(wsDir, "env1.bazelrc");
    const envRc2 = path.join(wsDir, "env2.bazelrc");
    fs.writeFileSync(envRc1, `startup --output_base=${path.join(wsDir, "bazel-env-out")}\n`);
    fs.writeFileSync(envRc2, "startup --host_jvm_args=-Xmx6g\n");
    const bazelrcEnvReqs = resolveBuildResources("bazel", ["--nosystem_rc", "--nohome_rc", "build", "//..."], subAppDir, {
      env: { ...process.env, BAZELRC: `${envRc1},${envRc2}` },
    });
    assert.ok(bazelrcEnvReqs.resourceKeys.some((k) => k.startsWith("bazel:out:") && k.endsWith("bazel-env-out")));
    assert.equal(bazelrcEnvReqs.requestedHeapMb, 6144);
    assert.equal(bazelrcEnvReqs.disablesDaemon, true);

    // An invocation-level unset of BAZELRC (step env) wins over the caller env
    const unsetBazelrcEnvReqs = resolveBuildResources("bazel", ["--nosystem_rc", "--nohome_rc", "build", "//..."], subAppDir, {
      env: { ...process.env, BAZELRC: `${envRc1},${envRc2}` },
      inheritedEnvVars: { BAZELRC: null },
    });
    assert.equal(unsetBazelrcEnvReqs.resourceKeys.some((k) => k.startsWith("bazel:out:")), false);
    assert.equal(unsetBazelrcEnvReqs.requestedHeapMb, 0);

    // BAZELRC=/dev/null sentinel stops processing subsequent comma-separated entries
    const envRcIgnored = path.join(wsDir, "env-ignored.bazelrc");
    fs.writeFileSync(envRcIgnored, `startup --output_base=${path.join(wsDir, "bazel-env-ignored-out")}\n`);
    const bazelrcNullSentinelReqs = resolveBuildResources("bazel", ["--nosystem_rc", "--nohome_rc", "build", "//..."], subAppDir, {
      env: { ...process.env, BAZELRC: `${envRc1},/dev/null,${envRcIgnored}` },
    });
    assert.ok(bazelrcNullSentinelReqs.resourceKeys.some((k) => k.endsWith("bazel-env-out")));
    assert.equal(bazelrcNullSentinelReqs.resourceKeys.some((k) => k.endsWith("bazel-env-ignored-out")), false);

    // Repeated bazelrc imports outside a cycle are reprocessed in place
    const sharedImportRc = path.join(wsDir, "shared-import.bazelrc");
    const repeatParentRc = path.join(wsDir, "repeat-parent.bazelrc");
    fs.writeFileSync(sharedImportRc, `startup --output_base=${path.join(wsDir, "bazel-repeat-actual-out")}\n`);
    fs.writeFileSync(
      repeatParentRc,
      [
        `import ${sharedImportRc.replace(/\\/g, "/")}`,
        `startup --output_base=${path.join(wsDir, "bazel-repeat-middle-out")}`,
        `import ${sharedImportRc.replace(/\\/g, "/")}`,
      ].join("\n") + "\n",
    );
    const repeatImportReqs = resolveBuildResources("bazel", ["--nosystem_rc", "--nohome_rc", `--bazelrc=${repeatParentRc}`, "build", "//..."], subAppDir);
    assert.ok(repeatImportReqs.resourceKeys.some((k) => k.endsWith("bazel-repeat-actual-out")));
    assert.equal(repeatImportReqs.resourceKeys.some((k) => k.endsWith("bazel-repeat-middle-out")), false);

    // --bazelrc=/dev/null stops processing subsequent --bazelrc flags
    const ignoredBazelOut = path.join(wsDir, "ignored-bazel-out");
    fs.mkdirSync(ignoredBazelOut, { recursive: true });
    const canonicalIgnoredBazelOut = realpath(ignoredBazelOut);
    const rcX = path.join(wsDir, "x.rc");
    const rcZ = path.join(wsDir, "z.rc");
    fs.writeFileSync(rcX, `startup --output_base=${canonicalSharedBazelOut}\n`);
    fs.writeFileSync(rcZ, `startup --output_base=${canonicalIgnoredBazelOut}\n`);
    const nullSentinelBazelrcReqs = resolveBuildResources(
      "bazel",
      ["--noworkspace_rc", `--bazelrc=${rcX}`, "--bazelrc=/dev/null", `--bazelrc=${rcZ}`, "build", "//..."],
      subAppDir,
    );
    assert.ok(nullSentinelBazelrcReqs.resourceKeys.includes(`bazel:out:${canonicalSharedBazelOut}`));
    assert.ok(!nullSentinelBazelrcReqs.resourceKeys.includes(`bazel:out:${canonicalIgnoredBazelOut}`));

    // Windows %ProgramData%\bazel.bazelrc system rc loading
    const fakeProgData = path.join(wsDir, "ProgramData");
    const winSysBazelOut = path.join(wsDir, "win-sys-bazel-out");
    fs.mkdirSync(fakeProgData, { recursive: true });
    fs.mkdirSync(winSysBazelOut, { recursive: true });
    const canonicalWinSysBazelOut = realpath(winSysBazelOut);
    fs.writeFileSync(path.join(fakeProgData, "bazel.bazelrc"), `startup --output_base=${canonicalWinSysBazelOut}\n`);
    const winSysRcReqs = resolveBuildResources("bazel", ["build", "//..."], dirA, { platform: "win32", env: { ProgramData: fakeProgData } });
    assert.ok(winSysRcReqs.resourceKeys.includes(`bazel:out:${canonicalWinSysBazelOut}`));

    // BAZELRC version gating (Bazel <= 8 ignores BAZELRC, unknown version forces cold) and top-level rc deduplication
    const dedupeRcX = path.join(wsDir, "dedupe-x.rc");
    const dedupeRcY = path.join(wsDir, "dedupe-y.rc");
    const dedupeOutX = path.join(wsDir, "dedupe-out-x");
    fs.writeFileSync(dedupeRcX, `startup --output_base=${dedupeOutX}\n`);
    fs.writeFileSync(dedupeRcY, `startup --output_base=${path.join(wsDir, "dedupe-out-y")}\n`);
    const noRc = ["--nosystem_rc", "--nohome_rc", "--noworkspace_rc"];
    const bazel8IgnoresBazelrc = resolveBuildResources("bazel", [...noRc, "build", "//..."], dirA, { env: { BAZELRC: dedupeRcX }, bazelMajorVersion: 8 });
    assert.equal(bazel8IgnoresBazelrc.resourceKeys.some((k) => k.endsWith("dedupe-out-x")), false);
    assert.equal(bazel8IgnoresBazelrc.disablesDaemon, false);
    assert.equal(
      probeWarmBuildDaemons(bazel8IgnoresBazelrc, {
        bazelMajorVersion: 8,
        runner: () => ({ stdout: `9501 bazel(a) -XX:+HeapDumpOnOutOfMemoryError --output_base=${dedupeOutX} --workspace_directory=${canonicalDirA}\n` }),
      }).warm,
      false,
    );
    const bazelUnknownVerWithBazelrc = resolveBuildResources("bazel", [...noRc, "build", "//..."], dirA, { env: { BAZELRC: dedupeRcX } });
    assert.equal(bazelUnknownVerWithBazelrc.disablesDaemon, true);
    assert.equal(
      probeWarmBuildDaemons(bazelUnknownVerWithBazelrc, {
        runner: () => ({ stdout: `9502 bazel(a) -XX:+HeapDumpOnOutOfMemoryError --output_base=${dedupeOutX} --workspace_directory=${canonicalDirA}\n` }),
      }).warm,
      false,
    );
    const bazel9TopLevelDedupe = resolveBuildResources("bazel", [...noRc, "build", "//..."], dirA, {
      env: { BAZELRC: `${dedupeRcX},${dedupeRcY},${dedupeRcX}` },
      bazelMajorVersion: 9,
    });
    assert.ok(bazel9TopLevelDedupe.resourceKeys.some((k) => k.endsWith("dedupe-out-y")));
    assert.equal(bazel9TopLevelDedupe.resourceKeys.some((k) => k.endsWith("dedupe-out-x")), false);
    assert.equal(bazel9TopLevelDedupe.disablesDaemon, false);

    // try-import-if-bazel-version: true / false / ambiguous (ambiguous forces cold)
    const condImportRc = path.join(wsDir, "cond-import.rc");
    const condDeviceRc = path.join(wsDir, "cond-device.rc");
    fs.writeFileSync(condDeviceRc, `startup --output_base=${path.join(wsDir, "cond-out-87")}\ntest --test_arg=--device=emulator-5554\n`);
    fs.writeFileSync(condImportRc, `try-import-if-bazel-version >=8.7.0 ${condDeviceRc}\n`);
    const condArgs = [...noRc, `--bazelrc=${condImportRc}`, "test", "//app:test"];
    const condTrueTest = resolveBuildResources("bazel", condArgs, dirA, { bazelVersion: "8.7.0" });
    assert.equal(condTrueTest.kind, "pure_build", "argv never makes a bazel invocation device-coupled; the op does");
    assert.ok(condTrueTest.resourceKeys.some((k) => k.endsWith("cond-out-87")));
    assert.equal(condTrueTest.disablesDaemon, false);
    const condFalseTest = resolveBuildResources("bazel", condArgs, dirA, { bazelVersion: "8.6.0" });
    assert.equal(condFalseTest.resourceKeys.some((k) => k.endsWith("cond-out-87")), false);
    const condAmbiguousTest = resolveBuildResources("bazel", condArgs, dirA);
    assert.ok(condAmbiguousTest.resourceKeys.some((k) => k.endsWith("cond-out-87")));
    assert.equal(condAmbiguousTest.disablesDaemon, true);

    // startup:<os> filtering & precedence
    const startupOsRc = path.join(wsDir, "startup-os.rc");
    fs.writeFileSync(
      startupOsRc,
      [
        `startup:macos --output_base=${path.join(wsDir, "out-mac")}`,
        `startup:linux --output_base=${path.join(wsDir, "out-linux")}`,
        `startup --output_base=${path.join(wsDir, "out-default")}`,
      ].join("\n") + "\n",
    );
    const macStartupRes = resolveBuildResources("bazel", [...noRc, `--bazelrc=${startupOsRc}`, "build", "//..."], dirA, { platform: "darwin" });
    assert.ok(macStartupRes.resourceKeys.some((k) => k.endsWith("out-mac")));
    assert.equal(macStartupRes.resourceKeys.some((k) => k.endsWith("out-linux")), false);
    assert.equal(macStartupRes.resourceKeys.some((k) => k.endsWith("out-default")), false);
    assert.equal(macStartupRes.disablesDaemon, false);

    // Relative bazelrc import/try-import-if-bazel-version resolve against the invocation cwd
    const rcCwdSub = path.join(wsDir, "bazel-rc-cwd-test", "sub", "inv");
    const rcConfigDir = path.join(wsDir, "bazel-rc-cwd-test", "configs");
    fs.mkdirSync(path.join(rcCwdSub, "rel"), { recursive: true });
    fs.mkdirSync(rcConfigDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "bazel-rc-cwd-test", "MODULE.bazel"), "", "utf8");
    const cwdImportOutBase = path.join(wsDir, "bazel-cwd-import-out");
    const cwdCondImportOutBase = path.join(wsDir, "bazel-cwd-cond-import-out");
    fs.mkdirSync(cwdImportOutBase, { recursive: true });
    fs.mkdirSync(cwdCondImportOutBase, { recursive: true });
    fs.writeFileSync(path.join(rcCwdSub, "rel", "imported.bazelrc"), `startup --output_base=${cwdImportOutBase}\n`, "utf8");
    fs.writeFileSync(path.join(rcCwdSub, "rel", "cond.bazelrc"), `startup --output_base=${cwdCondImportOutBase}\n`, "utf8");
    const outerRcPath = path.join(rcConfigDir, "outer.bazelrc");
    fs.writeFileSync(outerRcPath, "import rel/imported.bazelrc\ntry-import-if-bazel-version >=8.0.0 rel/cond.bazelrc\n", "utf8");
    const relImportFromCwdReqs = resolveBuildResources("bazel", [`--bazelrc=${outerRcPath}`, "build", "//..."], rcCwdSub, {
      bazelVersion: "8.2.1",
      systemBazelrcPath: null,
      env: { HOME: rcConfigDir },
    });
    const canonicalRcWsRoot = canonicalizeBuildPath(path.join(wsDir, "bazel-rc-cwd-test"));
    assert.deepEqual(relImportFromCwdReqs.resourceKeys, [
      `bazel:ws:${canonicalRcWsRoot}`,
      `bazel:out:${canonicalizeBuildPath(cwdCondImportOutBase)}`,
    ]);

    // BAZELRC=/dev/null stops reading remaining BAZELRC entries without ignoring explicit --bazelrc flags
    const envBeforeNullRc = path.join(rcConfigDir, "env-before.bazelrc");
    const envAfterNullRc = path.join(rcConfigDir, "env-after.bazelrc");
    const cliAfterEnvNullRc = path.join(rcConfigDir, "cli-after-null.bazelrc");
    const cliAfterNullOutBase = path.join(wsDir, "bazel-cli-after-env-null-out");
    fs.mkdirSync(cliAfterNullOutBase, { recursive: true });
    fs.writeFileSync(envBeforeNullRc, "build --jobs=2\n", "utf8");
    fs.writeFileSync(envAfterNullRc, `startup --output_base=${path.join(wsDir, "bazel-ignored-after-null-out")}\n`, "utf8");
    fs.writeFileSync(cliAfterEnvNullRc, `startup --output_base=${cliAfterNullOutBase}\n`, "utf8");
    const bazelrcNullThenCliReqs = resolveBuildResources("bazel", [`--bazelrc=${cliAfterEnvNullRc}`, "build", "//..."], rcCwdSub, {
      bazelVersion: "9.0.0",
      systemBazelrcPath: null,
      env: { HOME: rcConfigDir, BAZELRC: `${envBeforeNullRc},/dev/null,${envAfterNullRc}` },
    });
    assert.deepEqual(bazelrcNullThenCliReqs.resourceKeys, [
      `bazel:ws:${canonicalRcWsRoot}`,
      `bazel:out:${canonicalizeBuildPath(cliAfterNullOutBase)}`,
    ]);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("Bazel version detection: .bazelversion / .bazeliskrc for Bazelisk launchers vs direct bazel binaries", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-bazel-version-"));
  try {
    const noRc = ["--nosystem_rc", "--nohome_rc", "--noworkspace_rc"];
    const aliceEnv = { USER: "alice", HOME: "/Users/alice" };
    const bvDir = path.join(wsDir, "bazel9-ws");
    fs.mkdirSync(bvDir, { recursive: true });
    fs.writeFileSync(path.join(bvDir, "MODULE.bazel"), 'module(name = "b9")\n');
    fs.writeFileSync(path.join(bvDir, ".bazelversion"), "9.0.0\n");
    const canonicalBvDir = realpath(bvDir);

    const bvDarwinReqs = resolveBuildResources("bazelisk", [...noRc, "build", "//..."], bvDir, { platform: "darwin", env: aliceEnv });
    assert.equal(bvDarwinReqs.bazelMajorVersion, 9);
    assert.ok(bvDarwinReqs.defaultBazelOutputBases.some((p) => p.includes("/Users/alice/Library/Caches/bazel/_bazel_alice/")));
    const bvDarwinWarmProbe = probeWarmBuildDaemons(bvDarwinReqs, {
      platform: "darwin",
      env: aliceEnv,
      runner: () => ({
        stdout: `9601 bazel(b9) -XX:+HeapDumpOnOutOfMemoryError --output_base=${bvDarwinReqs.defaultBazelOutputBases[0]} --workspace_directory=${canonicalBvDir}\n`,
      }),
    });
    assert.equal(bvDarwinWarmProbe.warm, true);
    assert.deepEqual(bvDarwinWarmProbe.daemonPids, [9601]);

    // Workspace bazelw wrapper (what bazel ops prefer) is treated as a Bazelisk launcher
    const bazelwReqs = resolveBuildResources(path.join(bvDir, "bazelw"), [...noRc, "build", "//..."], bvDir, { platform: "darwin", env: aliceEnv });
    assert.equal(bazelwReqs.isBazelisk, true);
    assert.equal(bazelwReqs.bazelMajorVersion, 9);

    // Direct `/opt/bazel-8/bin/bazel` binary does not read .bazelversion and stays ambiguous on macOS
    const directBazelDarwinReqs = resolveBuildResources("/opt/bazel-8/bin/bazel", [...noRc, "build", "//..."], bvDir, { platform: "darwin", env: aliceEnv });
    assert.equal(directBazelDarwinReqs.bazelMajorVersion, undefined);
    assert.deepEqual(directBazelDarwinReqs.defaultBazelOutputBases, []);

    if (posix) {
      // Bare `bazel` resolved through PATH symlink to `bazelisk` reads .bazelversion, a standalone binary does not
      const fakeBazeliskBinDir = path.join(wsDir, "fake-bazelisk-bin");
      fs.mkdirSync(fakeBazeliskBinDir, { recursive: true });
      const fakeBazeliskExe = path.join(fakeBazeliskBinDir, "bazelisk");
      fs.writeFileSync(fakeBazeliskExe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.symlinkSync(fakeBazeliskExe, path.join(fakeBazeliskBinDir, "bazel"));
      const pathSymlinkBazelReqs = resolveBuildResources("bazel", [...noRc, "build", "//..."], bvDir, {
        platform: "darwin",
        env: { ...aliceEnv, PATH: fakeBazeliskBinDir },
      });
      assert.equal(pathSymlinkBazelReqs.isBazelisk, true);
      assert.equal(pathSymlinkBazelReqs.bazelMajorVersion, 9);

      const fakeStandaloneBazelBinDir = path.join(wsDir, "fake-standalone-bazel-bin");
      fs.mkdirSync(fakeStandaloneBazelBinDir, { recursive: true });
      fs.writeFileSync(path.join(fakeStandaloneBazelBinDir, "bazel"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const pathStandaloneBazelReqs = resolveBuildResources("bazel", [...noRc, "build", "//..."], bvDir, {
        platform: "darwin",
        env: { ...aliceEnv, PATH: fakeStandaloneBazelBinDir },
      });
      assert.equal(pathStandaloneBazelReqs.isBazelisk, false);
      assert.equal(pathStandaloneBazelReqs.bazelMajorVersion, undefined);
      assert.deepEqual(pathStandaloneBazelReqs.defaultBazelOutputBases, []);

      // Non-executable PATH bazel->bazelisk entry is skipped
      const nonExecBinDir = path.join(wsDir, "nonexec-bazelisk-bin");
      fs.mkdirSync(nonExecBinDir, { recursive: true });
      const nonExecBazelisk = path.join(nonExecBinDir, "bazelisk");
      fs.writeFileSync(nonExecBazelisk, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      fs.symlinkSync(nonExecBazelisk, path.join(nonExecBinDir, "bazel"));
      const nonExecFallbackReqs = resolveBuildResources("bazel", [...noRc, "build", "//..."], bvDir, {
        platform: "darwin",
        env: { ...aliceEnv, PATH: `${nonExecBinDir}:${fakeStandaloneBazelBinDir}` },
      });
      assert.equal(nonExecFallbackReqs.isBazelisk, false);
      assert.equal(nonExecFallbackReqs.bazelMajorVersion, undefined);
      assert.deepEqual(nonExecFallbackReqs.defaultBazelOutputBases, []);
    }

    // .bazeliskrc USE_BAZEL_VERSION takes precedence over .bazelversion; non-numeric selectors do not fall back
    const bazeliskRcWs = path.join(wsDir, "bazeliskrc-ws");
    fs.mkdirSync(bazeliskRcWs, { recursive: true });
    fs.writeFileSync(path.join(bazeliskRcWs, "MODULE.bazel"), 'module(name = "brc")\n');
    fs.writeFileSync(path.join(bazeliskRcWs, ".bazelversion"), "8.2.1\n");
    fs.writeFileSync(path.join(bazeliskRcWs, ".bazeliskrc"), "USE_BAZEL_VERSION=9.2.0\n");
    const bazeliskRcReqs = resolveBuildResources("bazelisk", [...noRc, "build", "//..."], bazeliskRcWs, { platform: "darwin", env: aliceEnv });
    assert.equal(bazeliskRcReqs.bazelMajorVersion, 9);
    assert.ok(bazeliskRcReqs.defaultBazelOutputBases.some((p) => p.includes("/Users/alice/Library/Caches/bazel/_bazel_alice/")));

    const lastGreenEnvReqs = resolveBuildResources("bazelisk", [...noRc, "build", "//..."], bvDir, {
      platform: "darwin",
      env: { ...aliceEnv, USE_BAZEL_VERSION: "last_green" },
    });
    assert.equal(lastGreenEnvReqs.bazelMajorVersion, undefined);
    assert.deepEqual(lastGreenEnvReqs.defaultBazelOutputBases, []);

    fs.writeFileSync(path.join(bazeliskRcWs, ".bazelversion"), "9.0.0\n");
    fs.writeFileSync(path.join(bazeliskRcWs, ".bazeliskrc"), "USE_BAZEL_VERSION=last_green\n");
    const lastGreenRcReqs = resolveBuildResources("bazelisk", [...noRc, "build", "//..."], bazeliskRcWs, { platform: "darwin", env: aliceEnv });
    assert.equal(lastGreenRcReqs.bazelMajorVersion, undefined);
    assert.deepEqual(lastGreenRcReqs.defaultBazelOutputBases, []);
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test("vendored properties / bazelrc parsers survive seeded property-based fuzzing", () => {
  let seed = 0x1337beef;
  const nextRand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pick = (arr) => arr[Math.floor(nextRand() * arr.length)];
  for (let i = 0; i < 200; i++) {
    const k = `org.gradle.${pick(["jvmargs", "java.home", "daemon", "caching", "workers.max"])}`;
    const v = pick(["-Xmx4g", "C:\\Java\\jdk-21", "/opt/jdk:21", "true", "false", "line1\\\n  line2"]);
    const sep = pick(["=", ":", " = ", " : ", " "]);
    const parsedProps = parseJavaProperties(`# comment\n${k}${sep}${v}\n`);
    assert.equal(typeof parsedProps.get(k), "string");

    const rcPhase = pick(["startup", "build", "test", "common", "build:ci"]);
    const rcFlag = pick(["--output_base=/tmp/out", "--jobs=4", "--javabase=/jdk"]);
    const rcLines = joinBackslashContinuations(`# bazelrc comment\n${rcPhase} \\\n  ${rcFlag}\n`).filter(
      (l) => l.trim() && !l.trim().startsWith("#"),
    );
    assert.equal(rcLines.length, 1);
    const rcWords = splitRcWords(rcLines[0]);
    assert.equal(rcWords[0], rcPhase);
    assert.equal(rcWords[1], rcFlag);
  }
  assert.deepEqual(splitRcWords("test --flag=iPhone\\ 16 'quoted arg' \"double q\""), ["test", "--flag=iPhone 16", "quoted arg", "double q"]);
});

// ---------------------------------------------------------------------------
// End-to-end runner: typed build ops through cmdExec / cmdBatch
// ---------------------------------------------------------------------------

test("exec gradle tasks coordinates pure builds via a build lease and writes structured JSONL audit logs", { skip: !posix }, async () => {
  const s = setupProject({ gradlew: 'echo "ARGS:$*"; echo "OP:$ATC_BUILD_OP_ID"' });
  try {
    const execRes = await cmdExec(s.stateDir, ["gradle", "tasks", "assembleDebug", "--session", "sess-1", "--json"], {
      env: s.env,
      cwd: s.proj,
      inventory: hostInventory(),
    });
    assert.equal(execRes.exitCode, 0, execRes.error);
    assert.match(execRes.stdout, /ARGS:assembleDebug -Dorg\.gradle\.workers\.max=\d+/);
    assert.match(execRes.stdout, /OP:\S+/, "child receives its build op identity");

    const afterState = readState(s.stateDir);
    assert.deepEqual(afterState.buildLeases, {});
    assert.deepEqual(afterState.buildQueue, []);

    const events = readRecentAuditEvents(s.stateDir, { limit: 20 });
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes("build_admit"), `Expected build_admit in ${JSON.stringify(eventNames)}`);
    assert.ok(eventNames.includes("build_release"), `Expected build_release in ${JSON.stringify(eventNames)}`);
    for (const ev of events) {
      assert.equal(ev.schemaVersion, 1, "audit record must include schemaVersion: 1");
      assert.equal(typeof ev.epochMs, "number", "audit record must include numeric epochMs");
      assert.equal(ev.category, "build", "build_admit / build_release must have category 'build'");
    }
    const admitEv = events.find((e) => e.event === "build_admit");
    const releaseEv = events.find((e) => e.event === "build_release");
    assert.ok(admitEv?.buildId, "build_admit event must preserve top-level buildId");
    assert.ok(admitEv?.opId, "build_admit event must preserve top-level opId");
    assert.ok(Array.isArray(admitEv?.resourceKeys), "build_admit event must preserve top-level resourceKeys");
    assert.ok(admitEv.resourceKeys.includes(`gradle:${canonicalizeBuildPath(s.proj)}`));
    assert.equal(admitEv.sessionId, "sess-1");
    assert.equal(releaseEv?.exitCode, 0, "build_release event must preserve top-level exitCode");

    // A failing build still releases its build lease
    script(path.join(s.proj, "gradlew"), "exit 3");
    const failRes = await cmdExec(s.stateDir, ["gradle", "tasks", "build", "--session", "sess-1", "--json"], {
      env: s.env,
      cwd: s.proj,
      inventory: hostInventory(),
    });
    assert.equal(failRes.exitCode, 3);
    assert.deepEqual(readState(s.stateDir).buildLeases, {});
  } finally {
    s.cleanup();
  }
});

test("exec --wait 0 admits immediately when the slot is free and exits 2 when the workspace or pool is busy", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    const run = (session, extra = []) =>
      cmdExec(s.stateDir, ["gradle", "tasks", "assembleDebug", "--wait", "0", "--session", session, "--json", ...extra], {
        env: s.env,
        cwd: s.proj,
        inventory: hostInventory(),
      });

    const freeRes = await run("sess-wait0-free");
    assert.equal(freeRes.exitCode, 0, freeRes.error);

    // Busy workspace key → --wait 0 fails immediately with exitCode 2
    const resolvedWs = canonicalizeBuildPath(s.proj);
    s.writeState((st) => {
      st.config.maxConcurrentBuilds = 4;
      st.buildLeases.build_busy = busyBuildLease("build_busy", [`gradle:${resolvedWs}`, `workspace:${resolvedWs}`], { workspaceRoot: resolvedWs });
    });
    const busyRes = await run("sess-wait0-busy");
    assert.equal(busyRes.exitCode, 2);
    assert.match(busyRes.error, /currently busy \(wait timeout reached\)/);
    assert.equal(readState(s.stateDir).buildLeases.build_busy.state, "active", "holder untouched");

    // A different workspace with a free pool is admitted
    s.writeState((st) => {
      st.buildLeases = { build_other: busyBuildLease("build_other", ["gradle:/other-workspace"]) };
    });
    const otherWsRes = await run("sess-wait0-other");
    assert.equal(otherWsRes.exitCode, 0, otherWsRes.error);

    // Full build pool (max concurrent builds reached, no burst) → busy even on a different workspace
    s.writeState((st) => {
      st.config.maxConcurrentBuilds = 1;
      st.config.maxDeviceHolderBurstBuilds = 0;
    });
    const poolFullRes = await run("sess-wait0-pool");
    assert.equal(poolFullRes.exitCode, 2);
    assert.match(poolFullRes.error, /currently busy/);
    assert.deepEqual(readState(s.stateDir).buildQueue, [], "timed-out waiters leave no queue tickets behind");
  } finally {
    s.cleanup();
  }
});

test("exec serializes concurrent builds on the same workspace key", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    const log = path.join(s.root, "order.log");
    script(path.join(s.proj, "gradlew"), `echo "start $1" >> ${log}; sleep 1; echo "end $1" >> ${log}`);
    // Each waiter runs in its own process, as real agents do (the in-process queue wait is synchronous).
    const cliUrl = new URL("../src/cli.mjs", import.meta.url).href;
    const run = (task, session) =>
      new Promise((resolve, reject) => {
        const code = [
          `const { cmdExec } = await import(${JSON.stringify(cliUrl)});`,
          `const res = await cmdExec(${JSON.stringify(s.stateDir)}, ${JSON.stringify(["gradle", "tasks", task, "--session", session, "--wait", "60", "--json"])},`,
          `  { env: process.env, cwd: ${JSON.stringify(s.proj)}, inventory: ${JSON.stringify(hostInventory())} });`,
          `process.stdout.write(JSON.stringify({ exitCode: res.exitCode, error: res.error || null }));`,
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: s.env, stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("error", reject);
        child.on("close", () => {
          try {
            resolve(JSON.parse(out));
          } catch (err) {
            reject(new Error(`child output not JSON: ${out}`));
          }
        });
      });
    const [a, b] = await Promise.all([run("taskA", "sess-a"), run("taskB", "sess-b")]);
    assert.equal(a.exitCode, 0, a.error);
    assert.equal(b.exitCode, 0, b.error);
    const lines = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    const first = lines[0].split(" ")[1];
    const second = first === "taskA" ? "taskB" : "taskA";
    assert.deepEqual(lines, [`start ${first}`, `end ${first}`, `start ${second}`, `end ${second}`], "builds on one workspace never overlap");
    const st = readState(s.stateDir);
    assert.deepEqual(st.buildLeases, {});
    assert.deepEqual(st.buildQueue, []);
  } finally {
    s.cleanup();
  }
});

test("exec fails fast with exit 5 on an unrecoverable host RAM shortfall even with a long --wait", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    s.writeState((st) => {
      st.leases["serial:usb-phone-1"] = {
        leaseId: "lease_phys_1",
        deviceKey: "serial:usb-phone-1",
        platform: "android",
        kind: "physical",
        serial: "usb-phone-1",
        sessionId: "sess-other-phys",
        state: "active",
        claimedAtMs: Date.now(),
        renewedAtMs: Date.now(),
        expiresAtMs: Date.now() + 600_000,
        firstSeenOfflineAtMs: null,
      };
    });
    const lowRamRes = await cmdExec(s.stateDir, ["gradle", "tasks", "assembleDebug", "--wait", "600", "--session", "sess-low-ram", "--json"], {
      env: s.env,
      cwd: s.proj,
      inventory: hostInventory({ totalRamMb: 8192, availableRamMb: 1024 }),
    });
    assert.equal(lowRamRes.exitCode, 5, "Unrecoverable host RAM shortfall must fail fast with exitCode 5");
    assert.match(lowRamRes.error, /Insufficient host RAM/);
    assert.deepEqual(readState(s.stateDir).buildLeases, {});
  } finally {
    s.cleanup();
  }
});

test("exec --claim performs atomic device + build co-allocation and releases only the device it claimed", { skip: !posix }, async () => {
  const s = setupProject({ gradlew: '[ "$ANDROID_SERIAL" = "emulator-5554" ] || exit 2; exit 0' });
  try {
    const inventory = hostInventory({}, [PIXEL_35]);
    const res = await cmdExec(
      s.stateDir,
      ["gradle", "tasks", "connectedDebugAndroidTest", "--claim", "--type", "phone", "--api", "35", "--session", "sess-coalloc", "--json"],
      { env: s.env, cwd: s.proj, inventory },
    );
    assert.equal(res.exitCode, 0, res.error);

    const afterState = readState(s.stateDir);
    assert.deepEqual(afterState.leases, {}, "One-shot exec --claim must release the co-allocated device lease on exit");
    assert.deepEqual(afterState.buildLeases, {});

    const events = readRecentAuditEvents(s.stateDir, { limit: 20 }).map((e) => e.event);
    assert.ok(events.includes("device_claim"), JSON.stringify(events));
    assert.ok(events.includes("build_co_alloc_admit"), JSON.stringify(events));
    assert.ok(events.includes("build_release"), JSON.stringify(events));
    assert.ok(events.includes("device_free"), JSON.stringify(events));

    // A pre-existing session lease is reused and NOT released by exec --claim
    const preClaim = cmdClaim(s.stateDir, { type: "phone", api: "35", session: "sess-preexisting" }, { inventory, env: s.env });
    assert.equal(preClaim.exitCode, 0, preClaim.error);
    const preExec = await cmdExec(
      s.stateDir,
      ["gradle", "tasks", "connectedDebugAndroidTest", "--claim", "--session", "sess-preexisting", "--json"],
      { env: s.env, cwd: s.proj, inventory },
    );
    assert.equal(preExec.exitCode, 0, preExec.error);
    const afterPreState = readState(s.stateDir);
    assert.equal(Object.keys(afterPreState.leases).length, 1, "Pre-existing session lease must remain active after exec --claim");
    assert.deepEqual(afterPreState.buildLeases, {});

    // Without --claim the held lease is used directly
    const leasedExec = await cmdExec(s.stateDir, ["gradle", "tasks", "connectedCheck", "--session", "sess-preexisting", "--json"], {
      env: s.env,
      cwd: s.proj,
      inventory,
    });
    assert.equal(leasedExec.exitCode, 0, leasedExec.error);
  } finally {
    s.cleanup();
  }
});

test("exec --claim does not claim or boot a device when the build pool is full", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    s.writeState((st) => {
      st.config.maxConcurrentBuilds = 1;
      st.config.maxDeviceHolderBurstBuilds = 0;
      st.buildLeases.build_active = busyBuildLease("build_active", ["gradle:/other-workspace"], { sessionId: "sess-other-builder" });
    });
    const blockedRes = await cmdExec(
      s.stateDir,
      ["gradle", "tasks", "connectedDebugAndroidTest", "--claim", "--wait", "0", "--session", "sess-blocked-coalloc", "--json"],
      { env: s.env, cwd: s.proj, inventory: hostInventory({}, [PIXEL_35]) },
    );
    assert.equal(blockedRes.exitCode, 2);
    assert.match(blockedRes.error, /currently busy \(wait timeout reached\)/);
    assert.deepEqual(readState(s.stateDir).leases, {}, "Device must not be claimed while build slot is unavailable");
  } finally {
    s.cleanup();
  }
});

test("device-coupled builds and device ops require a matching-platform lease", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    const inventory = hostInventory({}, [PIXEL_35]);
    const noLease = await cmdExec(s.stateDir, ["android", "install", "app.apk", "--session", "sess-no-lease", "--wait", "0"], {
      env: s.env,
      cwd: s.proj,
      inventory,
      livenessCheck: () => true,
    });
    assert.equal(noLease.exitCode, 3, noLease.error);
    assert.match(noLease.error, /holds no active android device lease/);

    const noLeaseBuild = await cmdExec(s.stateDir, ["gradle", "tasks", "connectedCheck", "--session", "sess-no-lease", "--wait", "0"], {
      env: s.env,
      cwd: s.proj,
      inventory,
      livenessCheck: () => true,
    });
    assert.equal(noLeaseBuild.exitCode, 3, noLeaseBuild.error);
    assert.match(noLeaseBuild.error, /holds no active android device lease/);
    assert.deepEqual(readState(s.stateDir).buildLeases, {}, "no build lease is left behind");

    const claimRes = cmdClaim(s.stateDir, { session: "sess-android-only" }, { inventory, env: s.env, livenessCheck: () => true });
    assert.equal(claimRes.exitCode, 0, claimRes.error);

    if (process.platform === "darwin") {
      fs.mkdirSync(path.join(s.proj, "App.xcodeproj"), { recursive: true });
      const wrongPlatBuild = await cmdExec(s.stateDir, ["xcode", "test", "--scheme", "App", "--session", "sess-android-only", "--wait", "0"], {
        env: s.env,
        cwd: s.proj,
        inventory,
        livenessCheck: () => true,
      });
      assert.equal(wrongPlatBuild.exitCode, 3, wrongPlatBuild.error);
      assert.match(wrongPlatBuild.error, /holds no active ios device lease/);
    }

    // Explicit platform selector that conflicts with the op's device platform is rejected
    const conflicting = await cmdExec(s.stateDir, ["gradle", "tasks", "connectedCheck", "--ios", "--session", "sess-android-only"], {
      env: s.env,
      cwd: s.proj,
      inventory,
      livenessCheck: () => true,
    });
    assert.equal(conflicting.exitCode, 3);
    assert.match(conflicting.error, /conflicts with explicit --ios selector/);
  } finally {
    s.cleanup();
  }
});

test("exec --claim releases the newly claimed device when pre-spawn validation fails", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    const physical = {
      deviceKey: "serial:R5CX123",
      serial: "R5CX123",
      kind: "physical",
      platform: "android",
      online: true,
      profile: { deviceType: "phone", apiLevel: "android-35" },
    };
    const res = await cmdExec(
      s.stateDir,
      ["android", "prop", "set", "debug.x", "--value", "1", "--claim", "--kind", "physical", "--session", "agent-claim-validation-fail", "--json"],
      { env: s.env, cwd: s.proj, inventory: hostInventory({}, [physical]), livenessCheck: () => true },
    );
    assert.equal(res.exitCode, 3, res.error);
    assert.equal(res.errorCode, "physical_not_allowed");
    assert.equal(Object.keys(readState(s.stateDir).leases || {}).length, 0, "co-allocated lease must be released");
  } finally {
    s.cleanup();
  }
});

test("batch runs typed build steps in dependency order and rejects invalid plans before anything runs", { skip: !posix }, async () => {
  const s = setupProject();
  try {
    const orderLog = path.join(s.root, "dag-order.txt");
    script(path.join(s.proj, "gradlew"), `echo "$1" >> ${orderLog}`);
    const run = (plan, flags = {}) =>
      cmdBatch(s.stateDir, { session: "sess-batch", json: true, ...flags }, { env: s.env, cwd: s.proj, plan, inventory: hostInventory() });

    const cycleRes = await run({
      version: 1,
      steps: [
        { id: "a", op: "gradle.tasks", tasks: ["a"], dependsOn: ["b"] },
        { id: "b", op: "gradle.tasks", tasks: ["b"], dependsOn: ["a"] },
      ],
    });
    assert.equal(cycleRes.exitCode, 7);
    assert.ok(cycleRes.errors.length >= 1);
    assert.match(cycleRes.error, /cycle/i);
    assert.equal(fs.existsSync(orderLog), false);

    // Pre-flight: a later invalid step (device tasks marked buildOnly, missing wrapper) rejects the whole plan
    const emptyDir = path.join(s.root, "no-wrapper");
    fs.mkdirSync(emptyDir);
    const preflightFailRes = await run({
      version: 1,
      steps: [
        { id: "step1", op: "gradle.tasks", tasks: ["compileLib"] },
        { id: "step2", op: "gradle.tasks", tasks: ["connectedDebugAndroidTest"], buildOnly: true, dependsOn: ["step1"] },
        { id: "step3", op: "gradle.tasks", tasks: ["lint"], cwd: emptyDir, dependsOn: ["step1"] },
      ],
    });
    assert.equal(preflightFailRes.exitCode, 7);
    assert.ok(preflightFailRes.errors.some((e) => e.code === "build_only_device"), JSON.stringify(preflightFailRes.errors));
    assert.equal(fs.existsSync(orderLog), false, "step 1 must not run if a later step fails pre-flight");
    const planErrRes = await run({
      version: 1,
      steps: [
        { id: "step1", op: "gradle.tasks", tasks: ["compileLib"] },
        { id: "step3", op: "gradle.tasks", tasks: ["lint"], workspace: emptyDir, dependsOn: ["step1"] },
      ],
    });
    assert.equal(planErrRes.exitCode, 7);
    assert.ok(planErrRes.errors.some((e) => e.code === "gradle_wrapper_not_found"), JSON.stringify(planErrRes.errors));
    assert.equal(fs.existsSync(orderLog), false);

    const dagRes = await run({
      version: 1,
      steps: [
        { id: "test-ready", op: "gradle.tasks", tasks: ["testReady"], dependsOn: ["compile-lib", "compile-app"] },
        { id: "compile-lib", op: "gradle.tasks", tasks: ["compileLib"], ramMb: 1024 },
        { id: "compile-app", op: "gradle.tasks", tasks: ["compileApp"], dependsOn: ["compile-lib"] },
      ],
    });
    assert.equal(dagRes.exitCode, 0, dagRes.error);
    assert.deepEqual(dagRes.steps.map((x) => x.id), ["compile-lib", "compile-app", "test-ready"]);
    assert.deepEqual(dagRes.steps.map((x) => x.status), ["ok", "ok", "ok"]);
    assert.equal(fs.readFileSync(orderLog, "utf8"), "compileLib\ncompileApp\ntestReady\n");
    const st = readState(s.stateDir);
    assert.deepEqual(st.buildLeases, {}, "every step releases its build lease");
    assert.deepEqual(st.buildQueue, []);
  } finally {
    s.cleanup();
  }
});
