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

    // probeWarmBuildDaemons detects warm GradleDaemon and Bazel server unless --no-daemon / --batch
    const gradleReqs = resolveBuildResources("./gradlew", ["assembleDebug"], spacedAppDir);
    const warmGradle = probeWarmBuildDaemons(gradleReqs, {
      runner: () => ({
        stdout: "  44123 /Library/Java/bin/java org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10\n",
      }),
    });
    assert.equal(warmGradle.warm, true);
    assert.deepEqual(warmGradle.daemonPids, [44123]);

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
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
