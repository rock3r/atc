import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  canonicalizeBuildPath,
  classifyBuildCommand,
  resolveBuildResources,
  computeEffectiveMaxBuilds,
  computeBuildPoolSnapshot,
  pruneAndSelectNextBuildTicket,
  computeUnaccountedBuildRamMb,
  checkUnifiedRamAdmission,
  reconcileBuildLease,
  evaluateNestedBuildAdmission,
  probeWarmBuildDaemons,
} from "../src/build.mjs";
import {
  resolveAuditLogPath,
  logAuditEvent,
  flushAuditEvents,
  readRecentAuditEvents,
} from "../src/logger.mjs";
import { checkResourceAdmission } from "../src/android.mjs";
import { evaluateCommandGuard } from "../src/guard.mjs";
import { handlePreToolUseHook } from "../src/hook.mjs";
import { buildChildInvocation } from "../src/spawn.mjs";
import {
  createDefaultState,
  readState,
  commitState,
  withStateTransaction,
} from "../src/state.mjs";
import {
  cmdClaim,
  cmdExec,
  cmdFree,
  cmdGuard,
  cmdStatus,
  cmdConfig,
  parseCliArgs,
} from "../src/cli.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atc-build-test-"));
}

test("classifyBuildCommand & resolveBuildResources handle gradle, bazel, xcodebuild, and build-brief wrappers", () => {
  const tmp = makeTempDir();
  const wsDir = path.join(tmp, "repo");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "settings.gradle.kts"), "rootProject.name = 'demo'\n");

  const pureGradle = resolveBuildResources(
    "build-brief",
    ["./gradlew", "assembleDebug", "--stacktrace"],
    wsDir,
  );
  assert.equal(pureGradle.kind, "pure_build");
  assert.equal(pureGradle.tool, "gradle");
  assert.equal(pureGradle.requiresWorkspaceLock, true);
  assert.equal(pureGradle.requiresHeavySlot, true);
  assert.deepEqual(pureGradle.resourceKeys, [`gradle:${canonicalizeBuildPath(wsDir)}`]);

  const wsOnlyGradle = resolveBuildResources("./gradlew", ["tasks", "--all"], wsDir);
  assert.equal(wsOnlyGradle.kind, "workspace_only");
  assert.equal(wsOnlyGradle.requiresWorkspaceLock, true);
  assert.equal(wsOnlyGradle.requiresHeavySlot, false);

  const readOnlyGradle = resolveBuildResources("./gradlew", ["--version"], wsDir);
  assert.equal(readOnlyGradle.kind, "read_only");
  assert.equal(readOnlyGradle.requiresWorkspaceLock, false);
  assert.equal(readOnlyGradle.requiresHeavySlot, false);

  const stopGradle = resolveBuildResources("./gradlew", ["--stop"], wsDir);
  assert.equal(stopGradle.kind, "deny_lifecycle");

  const contGradle = resolveBuildResources("./gradlew", ["test", "--continuous"], wsDir);
  assert.equal(contGradle.kind, "reject_long_running");

  const devGradle = resolveBuildResources("./gradlew", ["connectedDebugAndroidTest"], wsDir);
  assert.equal(devGradle.kind, "device_coupled_build");
  assert.equal(devGradle.requiresDevice, true);
  assert.equal(devGradle.requiresWorkspaceLock, true);
  assert.equal(devGradle.requiresHeavySlot, true);

  const bazelShut = resolveBuildResources("bazel", ["shutdown"], wsDir);
  assert.equal(bazelShut.kind, "deny_lifecycle");

  const bazelExpunge = resolveBuildResources("bazelisk", ["clean", "--expunge_async"], wsDir);
  assert.equal(bazelExpunge.kind, "deny_lifecycle");

  const bazelQuery = resolveBuildResources("bazel", ["query", "//..."], wsDir);
  assert.equal(bazelQuery.kind, "workspace_only");
  assert.equal(bazelQuery.requiresWorkspaceLock, true);
  assert.equal(bazelQuery.requiresHeavySlot, false);

  const bazelRunMobile = resolveBuildResources("bazel", ["mobile-install", "//app:bin"], wsDir);
  assert.equal(bazelRunMobile.kind, "device_coupled_build");
  assert.equal(bazelRunMobile.requiresDevice, true);

  const xcodeSimTest = resolveBuildResources(
    "xcodebuild",
    ["test", "-scheme", "App", "-destination", "platform=iOS Simulator,id=11111111-2222-3333-4444-555555555555"],
    wsDir,
  );
  assert.equal(xcodeSimTest.kind, "device_coupled_build");
  assert.equal(xcodeSimTest.targetPlatform, "ios");

  const xcodeMacBuild = resolveBuildResources(
    "xcodebuild",
    ["build", "-scheme", "MacTool", "-destination", "generic/platform=macOS"],
    wsDir,
  );
  assert.equal(xcodeMacBuild.kind, "pure_build");
  assert.equal(xcodeMacBuild.requiresDevice, false);
  assert.equal(xcodeMacBuild.requiresWorkspaceLock, true);
  assert.equal(xcodeMacBuild.requiresHeavySlot, true);

  const shellMultiTool = resolveBuildResources(
    "sh",
    ["-c", "./gradlew assembleDebug; bazel build //app:main"],
    wsDir,
  );
  assert.equal(shellMultiTool.kind, "pure_build");
  assert.ok(shellMultiTool.resourceKeys.includes(`gradle:${canonicalizeBuildPath(wsDir)}`));
  assert.ok(shellMultiTool.resourceKeys.includes(`bazel:ws:${canonicalizeBuildPath(wsDir)}`));

  const xcrunWrapped = resolveBuildResources(
    "xcrun",
    [
      "xcodebuild",
      "test",
      "-scheme",
      "App",
      "-destination",
      "platform=iOS Simulator,id=11111111-2222-3333-4444-555555555555",
    ],
    wsDir,
  );
  assert.equal(xcrunWrapped.kind, "device_coupled_build");
  assert.equal(xcrunWrapped.tool, "xcodebuild");
  assert.equal(xcrunWrapped.requiresWorkspaceLock, true);

  const subRepoDir = path.join(tmp, "sub-repo");
  fs.mkdirSync(subRepoDir, { recursive: true });
  fs.writeFileSync(path.join(subRepoDir, "settings.gradle"), "rootProject.name = 'sub'\n");
  const cdShellGradle = resolveBuildResources(
    "sh",
    ["-c", "cd sub-repo && ./gradlew assembleDebug"],
    tmp,
  );
  assert.deepEqual(cdShellGradle.resourceKeys, [`gradle:${canonicalizeBuildPath(subRepoDir)}`]);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("buildChildInvocation blocks daemon-killing commands and sanitizes ATC_BUILD_OP_* env", () => {
  assert.throws(
    () => buildChildInvocation("./gradlew", ["--stop"], null, "sess-1", {}),
    /disabled under ATC/,
  );
  assert.throws(
    () => buildChildInvocation("bazel", ["shutdown"], null, "sess-1", {}),
    /disabled under ATC/,
  );

  const inv = buildChildInvocation(
    "./gradlew",
    ["assembleDebug"],
    null,
    "sess-1",
    {
      ATC_BUILD_OP_ID: "stale_op",
      ATC_BUILD_OP_NONCE: "stale_nonce",
      PATH: process.env.PATH,
    },
    {
      buildId: "build_123",
      opId: "op_fresh",
      opNonce: "nonce_fresh",
      reservedRamMb: 3072,
    },
  );
  assert.equal(inv.env.ATC_BUILD_OP_ID, "op_fresh");
  assert.equal(inv.env.ATC_BUILD_OP_NONCE, "nonce_fresh");
  assert.ok(inv.args.some((a) => String(a).startsWith("-Dorg.gradle.workers.max=")));

  const bazelInv = buildChildInvocation("bazel", ["build", "//app:main"], null, "sess-1", {}, {
    reservedRamMb: 4096,
  });
  assert.ok(bazelInv.args.some((a) => String(a).startsWith("--jobs=")));
  assert.ok(bazelInv.args.includes("--local_ram_resources=4096"));
  assert.equal(inv.env.ATC_BUILD_ID, "build_123");

  const shInv = buildChildInvocation(
    "sh",
    ["-c", "./gradlew assembleDebug; bazel build //app:main"],
    null,
    "sess-1",
    {},
    { reservedRamMb: 4096 },
  );
  assert.match(shInv.args[1], /-Dorg\.gradle\.workers\.max=\d+/);
  assert.match(shInv.args[1], /--jobs=\d+ --local_ram_resources=4096/);
});

test("evaluateCommandGuard respects coordinateBuilds toggle and always guards lifecycle & device-coupled builds", () => {
  const stopGuard = evaluateCommandGuard("./gradlew --stop", {
    sessionId: "sess-a",
    activeLeases: [],
    coordinateBuilds: false,
  });
  assert.equal(stopGuard.allowed, false);
  assert.match(stopGuard.reason, /shared Gradle daemons/);

  const pureDisabled = evaluateCommandGuard("build-brief ./gradlew assembleDebug", {
    sessionId: "sess-a",
    activeLeases: [],
    coordinateBuilds: false,
  });
  assert.equal(pureDisabled.allowed, true);
  assert.equal(pureDisabled.rewrittenCommand, null);

  const pureEnabled = evaluateCommandGuard("build-brief ./gradlew assembleDebug", {
    sessionId: "sess-a",
    anchorPid: 4242,
    activeLeases: [],
    coordinateBuilds: true,
    platform: "darwin",
  });
  assert.equal(pureEnabled.allowed, true);
  assert.match(
    pureEnabled.rewrittenCommand,
    /^ATC_SESSION_ID=sess-a ATC_ANCHOR_PID=4242 atc exec --build -- build-brief \.\/gradlew assembleDebug$/,
  );

  const pureEnabledWin = evaluateCommandGuard("build-brief ./gradlew assembleDebug", {
    sessionId: "sess-a",
    anchorPid: 4242,
    activeLeases: [],
    coordinateBuilds: true,
    platform: "win32",
  });
  assert.equal(pureEnabledWin.allowed, true);
  assert.match(
    pureEnabledWin.rewrittenCommand,
    /^atc exec --session sess-a --anchor-pid 4242 --build -- build-brief \.\/gradlew assembleDebug$/,
  );

  const unleasedCoupled = evaluateCommandGuard("./gradlew connectedDebugAndroidTest", {
    sessionId: "sess-a",
    activeLeases: [],
    coordinateBuilds: false,
  });
  assert.equal(unleasedCoupled.allowed, false);
  assert.match(unleasedCoupled.reason, /atc exec --claim --/);

  const explicitCoAlloc = evaluateCommandGuard("atc exec --claim -- ./gradlew connectedDebugAndroidTest", {
    sessionId: "sess-a",
    activeLeases: [],
    coordinateBuilds: false,
  });
  assert.equal(explicitCoAlloc.allowed, true);
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

test("cmdExec --build coordinates pure builds and writes structured JSONL audit logs", async () => {
  const stateDir = makeTempDir();
  const wsDir = path.join(stateDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");

  const fakeInventory = {
    host: {
      cpuCores: 8,
      totalRamMb: 32768,
      availableRamMb: 16384,
      freeDiskMb: 50000,
      sampledAtMs: Date.now(),
    },
    running: [],
    offline: [],
    creatable: [],
  };

  const execRes = await cmdExec(
    stateDir,
    ["node", "-e", "process.exit(0)"],
    { build: true, session: "sess-1" },
    {
      cwd: wsDir,
      inventory: fakeInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-1" },
    },
  );
  assert.equal(execRes.exitCode, 0);

  const afterState = readState(stateDir);
  assert.deepEqual(afterState.buildLeases, {});
  assert.deepEqual(afterState.buildQueue, []);

  const events = readRecentAuditEvents(stateDir, { limit: 20 });
  const eventNames = events.map((e) => e.event);
  assert.ok(eventNames.includes("build_admit"), `Expected build_admit in ${JSON.stringify(eventNames)}`);
  assert.ok(eventNames.includes("build_release"), `Expected build_release in ${JSON.stringify(eventNames)}`);

  for (const ev of events) {
    assert.equal(ev.schemaVersion, 1, "audit record must include schemaVersion: 1");
    assert.equal(typeof ev.epochMs, "number", "audit record must include numeric epochMs");
    assert.equal(ev.category, "build", "build_admit / build_release must have category 'build'");
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("cmdExec --claim performs atomic device + build co-allocation without holding device while build slot is busy", async () => {
  const stateDir = makeTempDir();
  const wsDir = path.join(stateDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");

  const fakeInventory = {
    host: {
      cpuCores: 8,
      totalRamMb: 32768,
      availableRamMb: 16384,
      freeDiskMb: 50000,
      sampledAtMs: Date.now(),
    },
    running: [
      {
        deviceKey: "Pixel_7_API_35",
        serial: "emulator-5554",
        avd: "Pixel_7_API_35",
        platform: "android",
        kind: "emulator",
        profile: {
          deviceType: "phone",
          apiLevel: 35,
          playStore: true,
        },
        state: "online",
      },
    ],
    offline: [],
    creatable: [],
  };

  const fakeGradlew = path.join(wsDir, "gradlew");
  fs.writeFileSync(
    fakeGradlew,
    `#!/usr/bin/env node\nif (process.env.ANDROID_SERIAL !== "emulator-5554") process.exit(2);\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(wsDir, "gradlew.cmd"),
    `@node "%~dp0gradlew" %*\r\n`,
    { mode: 0o755 },
  );

  const parsedSelector = parseCliArgs([
    "exec",
    "--claim",
    "--type phone --api >=35",
    "--",
    "./gradlew",
    "connectedDebugAndroidTest",
  ]);
  assert.equal(parsedSelector.flags.claim, true);
  assert.equal(parsedSelector.flags.type, "phone");
  assert.equal(parsedSelector.flags.api, ">=35");

  const res = await cmdExec(
    stateDir,
    [fakeGradlew, "connectedDebugAndroidTest"],
    { claim: "--type phone --api >=35", session: "sess-coalloc" },
    {
      cwd: wsDir,
      inventory: fakeInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-coalloc" },
    },
  );
  assert.equal(res.exitCode, 0);

  const afterState = readState(stateDir);
  assert.deepEqual(
    afterState.leases,
    {},
    "One-shot cmdExec --claim must release the co-allocated device lease on exit",
  );
  assert.deepEqual(afterState.buildLeases, {});

  const events = readRecentAuditEvents(stateDir, { limit: 20 }).map((e) => e.event);
  assert.ok(events.includes("device_claim"));
  assert.ok(events.includes("build_co_alloc_admit"));
  assert.ok(events.includes("build_release"));
  assert.ok(events.includes("device_free"));

  // Pre-existing session lease must NOT be released when running cmdExec --claim
  const preClaim = cmdClaim(
    stateDir,
    { type: "phone", api: ">=35", session: "sess-preexisting" },
    { inventory: fakeInventory, env: { ...process.env, ATC_SESSION_ID: "sess-preexisting" } },
  );
  assert.equal(preClaim.exitCode, 0);

  const preExec = await cmdExec(
    stateDir,
    [fakeGradlew, "connectedDebugAndroidTest"],
    { claim: true, session: "sess-preexisting" },
    {
      cwd: wsDir,
      inventory: fakeInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-preexisting" },
    },
  );
  assert.equal(preExec.exitCode, 0);
  const afterPreState = readState(stateDir);
  assert.equal(
    Object.keys(afterPreState.leases).length,
    1,
    "Pre-existing session lease must remain active after cmdExec --claim",
  );

  // Also verify buildChildInvocation injects -destination id=<udid> and -jobs for xcodebuild test under iOS lease
  const iosXb = buildChildInvocation(
    "xcodebuild",
    ["test", "-scheme", "App"],
    {
      leaseId: "lease_ios_1",
      platform: "ios",
      kind: "emulator",
      serial: "D9746857-ABCD-4321-9999-111122223333",
    },
    "sess-ios",
    {},
  );
  assert.ok(iosXb.args.includes("-destination"));
  assert.ok(iosXb.args.includes("id=D9746857-ABCD-4321-9999-111122223333"));
  assert.ok(iosXb.args.includes("-jobs"));

  assert.throws(
    () =>
      buildChildInvocation(
        "xcodebuild",
        ["test", "-scheme", "App", "-destination", "platform=iOS Simulator,name=iPhone 16"],
        {
          leaseId: "lease_ios_1",
          platform: "ios",
          kind: "emulator",
          serial: "D9746857-ABCD-4321-9999-111122223333",
        },
        "sess-ios",
        {},
      ),
    /Conflicting device selector/,
  );

  fs.rmSync(stateDir, { recursive: true, force: true });
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
});

test("cmdExec --build --wait 0 admits immediately when slot is free and exits with code 2 when slot is busy", async () => {
  const stateDir = makeTempDir();
  const wsDir = path.join(stateDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");

  const fakeInventory = {
    host: {
      cpuCores: 8,
      totalRamMb: 32768,
      availableRamMb: 16384,
      freeDiskMb: 50000,
      sampledAtMs: Date.now(),
    },
    running: [],
    offline: [],
    creatable: [],
  };

  // 1. Free slot -> --wait 0 succeeds immediately
  const freeRes = await cmdExec(
    stateDir,
    ["node", "-e", "process.exit(0)"],
    { build: true, wait: "0", session: "sess-wait0-free" },
    {
      cwd: wsDir,
      inventory: fakeInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-wait0-free" },
    },
  );
  assert.equal(freeRes.exitCode, 0);

  // Verify audit log preserves top-level fields (buildId, opId, resourceKeys, exitCode)
  const events = readRecentAuditEvents(stateDir, { limit: 20 });
  const admitEv = events.find((e) => e.event === "build_admit");
  const releaseEv = events.find((e) => e.event === "build_release");
  assert.ok(admitEv?.buildId, "build_admit event must preserve top-level buildId");
  assert.ok(admitEv?.opId, "build_admit event must preserve top-level opId");
  assert.ok(Array.isArray(admitEv?.resourceKeys), "build_admit event must preserve top-level resourceKeys");
  assert.equal(releaseEv?.exitCode, 0, "build_release event must preserve top-level exitCode");

  // 2. Busy workspace slot -> --wait 0 fails immediately with exitCode 2
  const state = readState(stateDir);
  const resolvedWs = canonicalizeBuildPath(wsDir);
  state.config.maxConcurrentBuilds = 1;
  state.buildLeases.build_busy = {
    buildId: "build_busy",
    sessionId: "sess-holder",
    workerPid: process.pid,
    workerPgid: null,
    opId: "op_busy",
    opNonce: "nonce_busy",
    tool: "gradle",
    workspaceRoot: resolvedWs,
    resourceKeys: [`gradle:${resolvedWs}`, `workspace:${resolvedWs}`],
    requiresWorkspaceLock: true,
    requiresHeavySlot: true,
    pinnedDeviceLeaseId: null,
    state: "active",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    drainingUntilMs: null,
    maxDrainingAtMs: null,
    reservedRamMb: 0,
    ramReservationUntilMs: 0,
  };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));

  const busyRes = await cmdExec(
    stateDir,
    ["node", "-e", "process.exit(0)"],
    { build: true, wait: "0", session: "sess-wait0-busy" },
    {
      cwd: wsDir,
      inventory: fakeInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-wait0-busy" },
    },
  );
  assert.equal(busyRes.exitCode, 2);
  assert.match(busyRes.error, /currently busy \(wait timeout reached\)/);

  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("starved pure builds can use burst slots, default burst capacity is 1, low-RAM fails fast with exitCode 5, and cmdGuard audits decisions", async () => {
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

  // Low-RAM host with 0 active heavy builds and 0 active device leases fails fast with exitCode 5 even when wait > 0
  const stateDir = makeTempDir();
  const wsDir = path.join(stateDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");

  const stLowRam = readState(stateDir);
  stLowRam.leases["serial:usb-phone-1"] = {
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
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(stLowRam, null, 2));

  const lowRamInventory = {
    host: {
      cpuCores: 8,
      totalRamMb: 8192,
      availableRamMb: 1024, // < 2048 floor + 3072 build RAM
      freeDiskMb: 50000,
      sampledAtMs: Date.now(),
    },
    running: [],
    offline: [],
    creatable: [],
  };

  const lowRamRes = await cmdExec(
    stateDir,
    ["node", "-e", "process.exit(0)"],
    { build: true, wait: "600", session: "sess-low-ram" },
    {
      cwd: wsDir,
      inventory: lowRamInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-low-ram" },
    },
  );
  assert.equal(lowRamRes.exitCode, 5, "Unrecoverable host RAM shortfall must fail fast with exitCode 5");
  assert.match(lowRamRes.error, /Insufficient host RAM/);

  // Standalone cmdGuard records guard_deny and guard_rewrite in audit log
  cmdConfig(stateDir, "set", "coordinateBuilds", "true");
  const denyRes = cmdGuard(
    stateDir,
    "adb shell input tap 1 1",
    { session: "sess-guard" },
    { runningCount: 2, platform: "darwin" },
  );
  assert.equal(denyRes.allowed, false);

  const rewriteRes = cmdGuard(
    stateDir,
    "./gradlew assembleDebug",
    { session: "sess-guard" },
    { runningCount: 0, platform: "darwin" },
  );
  assert.equal(rewriteRes.allowed, true);
  assert.ok(rewriteRes.rewrittenCommand);

  const guardEvents = readRecentAuditEvents(stateDir, { category: "guard", limit: 10 });
  const guardEventNames = guardEvents.map((e) => e.event);
  assert.ok(guardEventNames.includes("guard_deny"), "cmdGuard must emit guard_deny audit event");
  assert.ok(guardEventNames.includes("guard_rewrite"), "cmdGuard must emit guard_rewrite audit event");

  // Verify bounded 3-file audit log rotation (.1 -> .2 -> .3)
  const rotDir = path.join(stateDir, "rot-logs");
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

  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("cmdExec --claim does not claim or boot a device when the build pool is full", async () => {
  const stateDir = makeTempDir();
  const wsDir = path.join(stateDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");

  const now = Date.now();
  const state = readState(stateDir);
  state.config.maxConcurrentBuilds = 1;
  state.config.maxDeviceHolderBurstBuilds = 0;
  state.buildLeases.build_active = {
    buildId: "build_active",
    sessionId: "sess-other-builder",
    workerPid: process.pid,
    workerPgid: null,
    opId: "op_active",
    opNonce: "nonce_active",
    tool: "gradle",
    workspaceRoot: "/other-workspace",
    resourceKeys: ["gradle:/other-workspace"],
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
  };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2));

  const fakeInventory = {
    host: {
      cpuCores: 8,
      totalRamMb: 32768,
      availableRamMb: 16384,
      freeDiskMb: 50000,
      sampledAtMs: now,
    },
    running: [
      {
        deviceKey: "Pixel_7_API_35",
        serial: "emulator-5554",
        avd: "Pixel_7_API_35",
        platform: "android",
        kind: "emulator",
        profile: {
          deviceType: "phone",
          apiLevel: 35,
          playStore: true,
        },
        state: "online",
      },
    ],
    offline: [],
    creatable: [],
  };

  const blockedRes = await cmdExec(
    stateDir,
    ["./gradlew", "connectedDebugAndroidTest"],
    { claim: true, wait: "0", session: "sess-blocked-coalloc" },
    {
      cwd: wsDir,
      inventory: fakeInventory,
      env: { ...process.env, ATC_SESSION_ID: "sess-blocked-coalloc" },
    },
  );
  assert.equal(blockedRes.exitCode, 2);
  assert.match(blockedRes.error, /currently busy \(wait timeout reached\)/);

  // Verify the device was NEVER claimed because the build slot was full!
  const afterState = readState(stateDir);
  assert.deepEqual(afterState.leases, {}, "Device must not be claimed while build slot is unavailable");

  fs.rmSync(stateDir, { recursive: true, force: true });
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

test("resolveBuildResources and buildChildInvocation handle quoted shell paths, shell xcodebuild destinations, and Bazel startup flags with subcommand names", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atc-round5-"));
  try {
    const spacedAppDir = path.join(tmpRoot, "my app");
    fs.mkdirSync(spacedAppDir, { recursive: true });
    fs.writeFileSync(path.join(spacedAppDir, "settings.gradle.kts"), "");

    const resQuotedCd = resolveBuildResources(
      "sh",
      ["-c", 'cd "my app" && ./gradlew test'],
      tmpRoot,
      process.env,
    );
    const canonicalSpacedApp = canonicalizeBuildPath(spacedAppDir);
    assert.ok(
      resQuotedCd.resourceKeys.includes(`gradle:${canonicalSpacedApp}`),
      `Expected gradle:${canonicalSpacedApp} in ${JSON.stringify(resQuotedCd.resourceKeys)}`,
    );

    const iosLease = {
      leaseId: "lease-ios-shell",
      platform: "ios",
      kind: "emulator",
      serial: "SIM-UDID-999",
      udid: "SIM-UDID-999",
    };
    const buildLease = {
      buildId: "bld-shell-1",
      jobsLimit: 4,
      reservedRamMb: 3072,
    };

    const xcShellInv = buildChildInvocation(
      "sh",
      ["-c", "xcodebuild test -scheme App"],
      iosLease,
      "sess-round5",
      process.env,
      buildLease,
    );
    assert.match(xcShellInv.args[1], /-jobs 4/);
    assert.match(xcShellInv.args[1], /-destination id=SIM-UDID-999/);

    assert.throws(
      () =>
        buildChildInvocation(
          "sh",
          ["-c", 'xcodebuild test -scheme App -destination "platform=iOS Simulator,name=iPhone 16"'],
          iosLease,
          "sess-round5",
          process.env,
          buildLease,
        ),
      /Conflicting device selector/,
    );

    const bazelShellInv = buildChildInvocation(
      "sh",
      ["-c", "bazel --output_base=/tmp/build build //app:bin"],
      null,
      "sess-round5",
      process.env,
      buildLease,
    );
    assert.equal(
      bazelShellInv.args[1],
      "bazel --output_base=/tmp/build build --jobs=4 --local_ram_resources=3072 //app:bin",
    );

    // Wrapped xcodebuild (env FOO=1 xcodebuild test / xcrun --sdk iphonesimulator xcodebuild test)
    const xcEnvInv = buildChildInvocation(
      "env",
      ["FOO=1", "xcodebuild", "test", "-scheme", "App"],
      iosLease,
      "sess-round6",
      process.env,
      buildLease,
    );
    assert.ok(xcEnvInv.args.includes("-destination"));
    assert.ok(xcEnvInv.args.includes("id=SIM-UDID-999"));

    const xcSdkInv = buildChildInvocation(
      "xcrun",
      ["--sdk", "iphonesimulator", "xcodebuild", "test", "-scheme", "App"],
      iosLease,
      "sess-round6",
      process.env,
      buildLease,
    );
    assert.ok(xcSdkInv.args.includes("-destination"));
    assert.ok(xcSdkInv.args.includes("id=SIM-UDID-999"));

    // Multiple -destination flags: second unleased destination must be rejected
    assert.throws(
      () =>
        buildChildInvocation(
          "xcodebuild",
          [
            "test",
            "-scheme",
            "App",
            "-destination",
            "id=SIM-UDID-999",
            "-destination",
            "id=UNLEASED-UDID",
          ],
          iosLease,
          "sess-round6",
          process.env,
          buildLease,
        ),
      /Conflicting device selector "UNLEASED-UDID"/,
    );

    // probeWarmBuildDaemons detects warm GradleDaemon by matching wrapper version or workspace path unless --no-daemon / --batch
    const wrapperDir = path.join(spacedAppDir, "gradle", "wrapper");
    fs.mkdirSync(wrapperDir, { recursive: true });
    fs.writeFileSync(
      path.join(wrapperDir, "gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n",
    );
    const gradleReqs = resolveBuildResources("./gradlew", ["assembleDebug"], spacedAppDir);
    const warmGradle = probeWarmBuildDaemons(gradleReqs, {
      runner: () => ({
        stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
      }),
    });
    assert.equal(warmGradle.warm, true);
    assert.deepEqual(warmGradle.daemonPids, [44123]);

    const mismatchedGradle = probeWarmBuildDaemons(gradleReqs, {
      runner: () => ({
        stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.9\n",
      }),
    });
    assert.equal(mismatchedGradle.warm, false);

    const noDaemonReqs = resolveBuildResources(
      "./gradlew",
      ["assembleDebug", "--no-daemon"],
      spacedAppDir,
    );
    assert.equal(
      probeWarmBuildDaemons(noDaemonReqs, {
        runner: () => ({
          stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
        }),
      }).warm,
      false,
    );

    // Leading shell variable assignments and Windows cmd /c & pwsh -Command wrappers
    const shellEnvReqs = resolveBuildResources(
      "sh",
      ["-c", "JAVA_HOME=/jdk ./gradlew connectedDebugAndroidTest"],
      spacedAppDir,
    );
    assert.equal(shellEnvReqs.tool, "gradle");
    assert.equal(shellEnvReqs.requiresDevice, true);

    const winCmdReqs = resolveBuildResources(
      "cmd",
      ["/c", "gradlew.bat", "connectedCheck"],
      spacedAppDir,
    );
    assert.equal(winCmdReqs.tool, "gradle");
    assert.equal(winCmdReqs.requiresDevice, true);
    assert.ok(winCmdReqs.resourceKeys.includes(`gradle:${canonicalSpacedApp}`));

    const winCmdInv = buildChildInvocation(
      "cmd",
      ["/c", "gradlew.bat", "assembleDebug"],
      null,
      "sess-round8",
      process.env,
      buildLease,
    );
    assert.match(winCmdInv.args[1], /-Dorg\.gradle\.workers\.max=4/);

    // timeout wrapper peeling
    const timeoutReqs = resolveBuildResources(
      "timeout",
      ["-k", "30s", "10m", "./gradlew", "assembleDebug"],
      spacedAppDir,
    );
    assert.equal(timeoutReqs.tool, "gradle");
    assert.ok(timeoutReqs.resourceKeys.includes(`gradle:${canonicalSpacedApp}`));

    // Single-pipe stage splitting in shell wrapper
    const pipedGradleInv = buildChildInvocation(
      "sh",
      ["-c", "./gradlew build | tee build.log"],
      null,
      "sess-round7",
      process.env,
      buildLease,
    );
    assert.equal(
      pipedGradleInv.args[1],
      "./gradlew build -Dorg.gradle.workers.max=4 | tee build.log",
    );

    // Shell-wrapped xcodebuild test-without-building pins destination without requiring heavy slot
    const testWithoutBuildingInv = buildChildInvocation(
      "sh",
      ["-c", "xcodebuild test-without-building -scheme App"],
      iosLease,
      "sess-round7",
      process.env,
      null,
    );
    assert.equal(
      testWithoutBuildingInv.args[1],
      "xcodebuild test-without-building -scheme App -destination id=SIM-UDID-999",
    );

    // Quoted shell separators inside arguments are preserved intact
    const quotedSepInv = buildChildInvocation(
      "sh",
      ["-c", "./gradlew build -Pfilter='a|b;c&&d'"],
      null,
      "sess-round9",
      process.env,
      buildLease,
    );
    assert.equal(
      quotedSepInv.args[1],
      "./gradlew build -Pfilter='a|b;c&&d' -Dorg.gradle.workers.max=4",
    );

    // Mixed-platform device-coupled shell clauses are denied
    const mixedDeviceReqs = resolveBuildResources(
      "sh",
      ["-c", "./gradlew connectedCheck && xcodebuild test -scheme App"],
      spacedAppDir,
    );
    assert.equal(mixedDeviceReqs.kind, "deny_lifecycle");
    assert.match(mixedDeviceReqs.reason, /Mixed-platform device-coupled build clauses/);

    // Multi-tool warm daemon probe checks every heavy tool in the shell wrapper
    const multiToolReqs = resolveBuildResources(
      "sh",
      ["-c", "./gradlew assembleDebug && bazel build //app"],
      spacedAppDir,
    );
    const onlyGradleWarm = probeWarmBuildDaemons(multiToolReqs, {
      inventory: {
        warmBuildDaemons: [{ tool: "gradle", workspaceRoot: canonicalSpacedApp, pid: 1111 }],
      },
    });
    assert.equal(onlyGradleWarm.warm, false);
    const bothWarm = probeWarmBuildDaemons(multiToolReqs, {
      inventory: {
        warmBuildDaemons: [
          { tool: "gradle", workspaceRoot: canonicalSpacedApp, pid: 1111 },
          { tool: "bazel", workspaceRoot: canonicalSpacedApp, pid: 2222 },
        ],
      },
    });
    assert.equal(bothWarm.warm, true);
    assert.deepEqual(bothWarm.daemonPids, [1111, 2222]);

    // Grouped shell commands place injected flags inside the closing parenthesis and preserve cd scope
    const groupedReqs = resolveBuildResources(
      "sh",
      ["-c", '(cd "my app" && ./gradlew connectedCheck)'],
      tmpRoot,
    );
    assert.equal(groupedReqs.kind, "device_coupled_build");
    assert.ok(groupedReqs.resourceKeys.includes(`gradle:${canonicalSpacedApp}`));
    const groupedInv = buildChildInvocation(
      "sh",
      ["-c", '(cd "my app" && ./gradlew build)'],
      null,
      "sess-round10",
      process.env,
      buildLease,
    );
    assert.equal(
      groupedInv.args[1],
      '(cd "my app" && ./gradlew build -Dorg.gradle.workers.max=4)',
    );

    // Invocation JAVA_HOME is honored when matching warm Gradle daemons
    const javaHomeReqs = resolveBuildResources(
      "env",
      ["JAVA_HOME=/opt/jdk-21", "./gradlew", "assembleDebug"],
      spacedAppDir,
    );
    assert.equal(javaHomeReqs.envJavaHome, "/opt/jdk-21");
    const wrongJavaProbe = probeWarmBuildDaemons(javaHomeReqs, {
      platform: "darwin",
      runner: () => ({
        status: 0,
        stdout: "54321 /opt/jdk-17/bin/java -Xmx4g org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
      }),
    });
    assert.equal(wrongJavaProbe.warm, false);
    const matchingJavaProbe = probeWarmBuildDaemons(javaHomeReqs, {
      platform: "darwin",
      runner: () => ({
        status: 0,
        stdout: "54321 /opt/jdk-21/bin/java -Xmx4g -XX:MaxMetaspaceSize=512m org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
      }),
    });
    assert.equal(matchingJavaProbe.warm, true);

    // Peel shell exec builtin
    const execBuiltinReqs = resolveBuildResources(
      "sh",
      ["-c", "exec ./gradlew connectedCheck"],
      spacedAppDir,
    );
    assert.equal(execBuiltinReqs.kind, "device_coupled_build");
    assert.ok(execBuiltinReqs.resourceKeys.includes(`gradle:${canonicalSpacedApp}`));

    // Track pushd and popd across shell clauses
    fs.writeFileSync(path.join(tmpRoot, "settings.gradle.kts"), "");
    const canonicalTmpRoot = canonicalizeBuildPath(tmpRoot);
    const pushdPopdReqs = resolveBuildResources(
      "sh",
      ["-c", 'pushd "my app" && ./gradlew assembleDebug && popd && ./gradlew test'],
      tmpRoot,
    );
    assert.ok(pushdPopdReqs.resourceKeys.includes(`gradle:${canonicalSpacedApp}`));
    assert.ok(pushdPopdReqs.resourceKeys.includes(`gradle:${canonicalTmpRoot}`));

    // Quoted > inside arguments is not treated as a shell redirection
    const quotedRedirInv = buildChildInvocation(
      "sh",
      ["-c", "./gradlew build -Pfilter='a > b'"],
      null,
      "sess-round11",
      process.env,
      buildLease,
    );
    assert.equal(
      quotedRedirInv.args[1],
      "./gradlew build -Pfilter='a > b' -Dorg.gradle.workers.max=4",
    );

    // Bazel separate startup-option value named "build" does not confuse subcommand location
    const bazelDirectOutBaseInv = buildChildInvocation(
      "bazel",
      ["--output_base", "build", "build", "//app"],
      null,
      "sess-round11",
      process.env,
      buildLease,
    );
    assert.deepEqual(bazelDirectOutBaseInv.args, [
      "--output_base",
      "build",
      "build",
      "--jobs=4",
      "--local_ram_resources=3072",
      "//app",
    ]);
    const bazelShellOutBaseInv = buildChildInvocation(
      "sh",
      ["-c", "bazel --output_base build build //app"],
      null,
      "sess-round11",
      process.env,
      buildLease,
    );
    assert.equal(
      bazelShellOutBaseInv.args[1],
      "bazel --output_base build build --jobs=4 --local_ram_resources=3072 //app",
    );

    // Background & separator splits before echo and marks backgrounded builds as reject_long_running
    const bgInv = buildChildInvocation(
      "sh",
      ["-c", "./gradlew build & echo done"],
      null,
      "sess-round12",
      process.env,
      buildLease,
    );
    assert.equal(bgInv.args[1], "./gradlew build -Dorg.gradle.workers.max=4 & echo done");
    const bgReqs = resolveBuildResources(
      "sh",
      ["-c", "./gradlew build & echo done"],
      spacedAppDir,
    );
    assert.equal(bgReqs.kind, "reject_long_running");

    // Absolute cd path replaces prior relative cd path
    const absCdReqs = resolveBuildResources(
      "sh",
      ["-c", `cd fake-sub && cd ${JSON.stringify(spacedAppDir)} && ./gradlew assembleDebug`],
      tmpRoot,
    );
    assert.deepEqual(absCdReqs.resourceKeys, [`gradle:${canonicalSpacedApp}`]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("cmdExec enforces matching-platform lease for device builds and keeps device commands from bypassing leases via --build", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-plat-guard-"));
  const fakeInventory = {
    hostResources: {
      totalMemMb: 32768,
      freeMemMb: 16384,
      availableMemMb: 16384,
      cpus: 8,
      sampledAtMs: Date.now(),
    },
    running: [
      {
        deviceKey: "Pixel_7_API_35",
        serial: "emulator-5554",
        avd: "Pixel_7_API_35",
        platform: "android",
        kind: "emulator",
        profile: { deviceType: "phone", apiLevel: 35, playStore: true },
        state: "online",
      },
    ],
    offline: [],
    creatable: [],
  };
  try {
    // 1. atc exec --build -- adb install app.apk must still require a device lease
    const noLeaseAdbBuild = await cmdExec(
      stateDir,
      ["adb", "install", "app.apk"],
      { build: true, session: "sess-no-lease" },
      {
        inventory: fakeInventory,
        env: { ...process.env, ATC_SESSION_ID: "sess-no-lease" },
        livenessCheck: () => true,
      },
    );
    assert.equal(noLeaseAdbBuild.exitCode, 3);
    assert.match(noLeaseAdbBuild.error, /holds no active android device lease/);

    // 2. Holding only an Android lease must not allow xcodebuild test to proceed without an iOS lease
    const claimRes = cmdClaim(
      stateDir,
      { session: "sess-android-only" },
      {
        inventory: fakeInventory,
        env: { ...process.env, ATC_SESSION_ID: "sess-android-only" },
        livenessCheck: () => true,
      },
    );
    assert.equal(claimRes.exitCode, 0);

    const wrongPlatBuild = await cmdExec(
      stateDir,
      ["xcodebuild", "test", "-scheme", "App"],
      { session: "sess-android-only" },
      {
        inventory: fakeInventory,
        env: { ...process.env, ATC_SESSION_ID: "sess-android-only" },
        livenessCheck: () => true,
      },
    );
    assert.equal(wrongPlatBuild.exitCode, 3);
    assert.match(wrongPlatBuild.error, /holds no active ios device lease/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cmdExec --claim releases newly claimed device when pre-spawn validation fails", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-claim-abort-"));
  const fakeInventory = {
    hostResources: {
      totalMemMb: 32768,
      freeMemMb: 16384,
      availableMemMb: 16384,
      cpus: 8,
      sampledAtMs: Date.now(),
    },
    running: [
      {
        deviceKey: "Pixel_7_API_35",
        serial: "emulator-5554",
        avd: "Pixel_7_API_35",
        platform: "android",
        kind: "emulator",
        profile: { deviceType: "phone", apiLevel: 35, playStore: true },
        state: "online",
      },
    ],
    offline: [],
    creatable: [],
  };
  try {
    const res = await cmdExec(
      stateDir,
      ["adb", "-s", "emulator-5556", "shell", "echo", "hi"],
      { claim: true, session: "agent-claim-validation-fail" },
      {
        inventory: fakeInventory,
        env: { ...process.env, ATC_SESSION_ID: "agent-claim-validation-fail" },
        livenessCheck: () => true,
      },
    );
    assert.equal(res.exitCode, 3);
    assert.match(res.error, /Conflicting device selector "emulator-5556"/);
    const stateAfter = readState(stateDir);
    assert.equal(Object.keys(stateAfter.leases || {}).length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("nice --adjustment and shell control keywords (then/else/do/if/!) peel and inject worker limits", () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-ctrl-kw-"));
  try {
    fs.writeFileSync(path.join(wsDir, "settings.gradle"), "rootProject.name = 'app'\n");
    const niceReqs = resolveBuildResources(
      "nice",
      ["--adjustment", "5", "./gradlew", "connectedCheck"],
      wsDir,
    );
    assert.equal(niceReqs.kind, "device_coupled_build");
    assert.equal(niceReqs.tool, "gradle");
    assert.equal(niceReqs.requiresDevice, true);
    assert.equal(niceReqs.requiresHeavySlot, true);
    assert.ok(niceReqs.resourceKeys.some((k) => k.startsWith("gradle:")));

    const niceInv = buildChildInvocation(
      "nice",
      ["--adjustment", "5", "./gradlew", "connectedCheck"],
      { serial: "emulator-5554", leaseId: "lease_1", platform: "android", kind: "emulator" },
      "sess_1",
      process.env,
      { jobsLimit: 4, reservedRamMb: 3072 },
    );
    assert.deepEqual(niceInv.args, [
      "--adjustment",
      "5",
      "./gradlew",
      "connectedCheck",
      "-Dorg.gradle.workers.max=4",
    ]);

    const shellIfReqs = resolveBuildResources(
      "sh",
      ["-c", "if test -f settings.gradle; then ./gradlew build; fi"],
      wsDir,
      { forceBuild: true },
    );
    assert.equal(shellIfReqs.kind, "pure_build");
    assert.equal(shellIfReqs.tool, "gradle");
    assert.ok(shellIfReqs.resourceKeys.some((k) => k.startsWith("gradle:")));

    const shellIfInv = buildChildInvocation(
      "sh",
      ["-c", "if test -f settings.gradle; then ./gradlew build; else bazel build //app; fi"],
      null,
      "sess_1",
      process.env,
      { jobsLimit: 4, reservedRamMb: 3072 },
    );
    assert.equal(
      shellIfInv.args[1],
      "if test -f settings.gradle; then ./gradlew build -Dorg.gradle.workers.max=4; else bazel build --jobs=4 --local_ram_resources=3072 //app; fi",
    );

    const substInv = buildChildInvocation(
      "sh",
      ["-c", "./gradlew build -Pversion=$(git describe; echo suffix)"],
      null,
      "sess_1",
      process.env,
      { jobsLimit: 4, reservedRamMb: 3072 },
    );
    assert.equal(
      substInv.args[1],
      "./gradlew build -Pversion=$(git describe; echo suffix) -Dorg.gradle.workers.max=4",
    );

    const expandedVarReqs = resolveBuildResources(
      "sh",
      ["-c", 'cd "$PROJECT_DIR" && ./gradlew build'],
      os.tmpdir(),
      { env: { ...process.env, PROJECT_DIR: wsDir } },
    );
    assert.equal(expandedVarReqs.kind, "pure_build");
    assert.equal(expandedVarReqs.tool, "gradle");
    const canonicalWs = (fs.realpathSync.native || fs.realpathSync)(wsDir);
    assert.ok(
      expandedVarReqs.resourceKeys.some((k) =>
        k.endsWith(canonicalWs),
      ),
    );

    const unresolvedVarReqs = resolveBuildResources(
      "sh",
      ["-c", 'cd "$UNSET_PROJECT_DIR_XYZ" && ./gradlew build'],
      wsDir,
      { env: {} },
    );
    assert.equal(unresolvedVarReqs.kind, "deny_lifecycle");
    assert.match(unresolvedVarReqs.reason, /Unresolved dynamic directory change/);

    const unsetJavaHomeReqs = resolveBuildResources(
      "env",
      ["-u", "JAVA_HOME", "./gradlew", "build"],
      wsDir,
    );
    assert.equal(unsetJavaHomeReqs.envJavaHomeUnset, true);
    const warmProbe = probeWarmBuildDaemons(unsetJavaHomeReqs, {
      env: { JAVA_HOME: "/nonexistent/parent/java" },
      runner: () => ({
        stdout: `4242 /Library/Java/Standard/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10 ${unsetJavaHomeReqs.workspaceRoot}\n`,
      }),
    });
    assert.equal(warmProbe.warm, true);

    const subAppDir = path.join(wsDir, "app");
    fs.mkdirSync(subAppDir, { recursive: true });
    fs.writeFileSync(path.join(subAppDir, "settings.gradle"), "rootProject.name = 'subapp'\n");
    const canonicalSubApp = (fs.realpathSync.native || fs.realpathSync)(subAppDir);

    // Conditional cd in a closed if block makes subsequent cwd ambiguous
    const condIfAfterFi = resolveBuildResources(
      "sh",
      ["-c", "if false; then cd app; fi; ./gradlew build"],
      wsDir,
    );
    assert.equal(condIfAfterFi.kind, "deny_lifecycle");
    assert.match(condIfAfterFi.reason, /Unresolved dynamic directory change/);

    // Conditional cd inside the same then branch resolves to that branch's directory
    const condIfInsideThen = resolveBuildResources(
      "sh",
      ["-c", "if test -d app; then cd app && ./gradlew build; fi"],
      wsDir,
    );
    assert.equal(condIfInsideThen.kind, "pure_build");
    assert.deepEqual(condIfInsideThen.resourceKeys, [`gradle:${canonicalSubApp}`]);

    // Sibling else branch does not inherit then branch's cd
    const condIfInElse = resolveBuildResources(
      "sh",
      ["-c", "if test -d app; then cd app; else ./gradlew build; fi"],
      wsDir,
    );
    assert.equal(condIfInElse.kind, "pure_build");
    assert.deepEqual(condIfInElse.resourceKeys, [`gradle:${canonicalWs}`]);

    // Short-circuit && or || cd followed by `;` makes subsequent cwd ambiguous
    const condAndThenSemi = resolveBuildResources(
      "sh",
      ["-c", "test -d app && cd app; ./gradlew build"],
      wsDir,
    );
    assert.equal(condAndThenSemi.kind, "deny_lifecycle");
    assert.match(condAndThenSemi.reason, /Unresolved dynamic directory change/);

    const condOrCd = resolveBuildResources(
      "sh",
      ["-c", "test -d app || cd app && ./gradlew build"],
      wsDir,
    );
    assert.equal(condOrCd.kind, "deny_lifecycle");
    assert.match(condOrCd.reason, /Unresolved dynamic directory change/);

    // Bazel warm daemon probe requires full workspace identity or output base (not basename-only bazel(app))
    fs.writeFileSync(path.join(subAppDir, "MODULE.bazel"), 'module(name = "app")\n');
    const bazelAppReqs = resolveBuildResources("bazel", ["build", "//..."], subAppDir);
    const otherBasenameProbe = probeWarmBuildDaemons(bazelAppReqs, {
      runner: () => ({
        stdout: "9001 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --workspace_directory=/other/work/app\n",
      }),
    });
    assert.equal(otherBasenameProbe.warm, false);

    const exactWorkspaceProbe = probeWarmBuildDaemons(bazelAppReqs, {
      runner: () => ({
        stdout: `9002 bazel(app) -XX:+HeapDumpOnOutOfMemoryError --workspace_directory=${canonicalSubApp}\n`,
      }),
    });
    assert.equal(exactWorkspaceProbe.warm, true);
    assert.deepEqual(exactWorkspaceProbe.daemonPids, [9002]);

    // Trailing shell comments preserve comment text and insert injected flags before `#`
    const commentGradleInv = buildChildInvocation(
      "sh",
      ["-c", "./gradlew build # note; not a command"],
      null,
      "sess_1",
      process.env,
      { jobsLimit: 4, reservedRamMb: 3072 },
    );
    assert.equal(
      commentGradleInv.args[1],
      "./gradlew build -Dorg.gradle.workers.max=4 # note; not a command",
    );

    const commentXcodeInv = buildChildInvocation(
      "sh",
      ["-c", "xcodebuild test -scheme App # note"],
      { serial: "SIM-UDID-123", leaseId: "lease_ios_1", platform: "ios", kind: "emulator" },
      "sess_1",
      process.env,
      { jobsLimit: 4, reservedRamMb: 3072 },
    );
    assert.equal(
      commentXcodeInv.args[1],
      "xcodebuild test -scheme App -jobs 4 -destination id=SIM-UDID-123 # note",
    );

    // Heredoc bodies mentioning build commands are opaque and neither require a lease nor get rewritten
    const heredocScript = "cat <<EOF\n./gradlew connectedCheck\nEOF";
    const heredocReqs = resolveBuildResources("sh", ["-c", heredocScript], wsDir);
    assert.equal(heredocReqs.kind, "not_build_tool");
    assert.equal(heredocReqs.requiresDevice, false);
    const heredocInv = buildChildInvocation(
      "sh",
      ["-c", heredocScript],
      null,
      "sess_1",
      process.env,
      { jobsLimit: 4, reservedRamMb: 3072 },
    );
    assert.equal(heredocInv.args[1], heredocScript);

    // Shell-expanded project path flags (-p "$PROJECT_DIR") resolve before locking and reject unset vars
    const expandedFlagReqs = resolveBuildResources(
      "sh",
      ["-c", './gradlew -p "$PROJECT_DIR" build'],
      wsDir,
      { env: { ...process.env, PROJECT_DIR: subAppDir } },
    );
    assert.equal(expandedFlagReqs.kind, "pure_build");
    assert.deepEqual(expandedFlagReqs.resourceKeys, [`gradle:${canonicalSubApp}`]);

    const unresolvedFlagReqs = resolveBuildResources(
      "sh",
      ["-c", './gradlew -p "$UNSET_PROJECT_DIR" build'],
      wsDir,
      { env: {} },
    );
    assert.equal(unresolvedFlagReqs.kind, "deny_lifecycle");

    // Windows cmd `cd /d` and PowerShell `Set-Location` / `Push-Location` / `Pop-Location`
    const cmdCdDReqs = resolveBuildResources(
      "cmd",
      ["/c", "cd /d app && gradlew.bat build"],
      wsDir,
    );
    assert.equal(cmdCdDReqs.kind, "pure_build");
    assert.deepEqual(cmdCdDReqs.resourceKeys, [`gradle:${canonicalSubApp}`]);

    const pwshSetLocReqs = resolveBuildResources(
      "pwsh",
      ["-Command", "Set-Location app; .\\gradlew.bat build"],
      wsDir,
    );
    assert.equal(pwshSetLocReqs.kind, "pure_build");
    assert.deepEqual(pwshSetLocReqs.resourceKeys, [`gradle:${canonicalSubApp}`]);

    const pwshPushPopReqs = resolveBuildResources(
      "pwsh",
      ["-Command", "Push-Location -Path app; .\\gradlew.bat build; Pop-Location; .\\gradlew.bat test"],
      wsDir,
    );
    assert.equal(pwshPushPopReqs.kind, "pure_build");
    assert.ok(pwshPushPopReqs.resourceKeys.includes(`gradle:${canonicalSubApp}`));
    assert.ok(pwshPushPopReqs.resourceKeys.includes(`gradle:${canonicalWs}`));
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});
