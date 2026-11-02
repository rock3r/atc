import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  acquireLock,
  clearKnownPosixPgidStartTokens,
  clearKnownWindowsTreeDescendants,
  getKnownWindowsTreeDescendants,
  getKnownWindowsTreePids,
  getPosixProcessStartToken,
  hasAliveProcessInGroup,
  isProcessGroupAlive,
  killProcessGroupTree,
  queryWindowsProcessGroups,
  releaseLock,
  seedWindowsKnownDescendants,
  sleepSync,
  snapshotProcessGroupsOutsideLock,
  verifyLockOwnership,
  withLock,
  writeFileAtomic,
} from "../src/lock.mjs";
import {
  addLeaseWorker,
  archiveWindowsProcessGroupGeneration,
  avdHasRuntimeLockFiles,
  offlineAvdHasRuntimeLockFiles,
  createDefaultState,
  readState,
  commitState,
  runGarbageCollection,
  reconcileOfflineLeases,
  sweepOrphanFiles,
  matchesProfile,
  matchesApiSpec,
  computeEffectiveMaxEmulators,
  computeUsedEmulatorSlots,
  canJumpAhead,
  isTicketStarvationProtected,
  resolveSessionIdentity,
  syncLeaseWorkers,
  withStateTransaction,
} from "../src/state.mjs";
import {
  ResourceError,
  parseAdbDevicesOutput,
  parseAndroidEmulatorListOutput,
  parseCreatableProfilesOutput,
  checkResourceAdmission,
  deterministicCreatedAvdId,
  discoverFleet,
  inferDeviceType,
  resolveAvdHome,
  readLocalAvdMetadata,
} from "../src/android.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";
import { handlePreToolUseHook, handleStopHook } from "../src/hook.mjs";
import {
  buildSpawnConfig,
  prepareOpChildInvocation,
  resolveExecutable,
  runCommandSync,
} from "../src/spawn.mjs";
import {
  GUIDE_TOPICS,
  cmdClaim,
  cmdFree,
  cmdRenew,
  cmdSnapshot,
  cmdExec,
  cmdStatus,
  execDeps,
  cmdConfig,
  cmdGc,
  cmdGuide,
  parseCliArgs,
  runCli,
  selectCandidateUnderLock,
} from "../src/cli.mjs";
import { mintSnapshotId, withSnapshotRegistry } from "../src/snapshot-registry.mjs";
import { cmdExecTokens, renderExecResult } from "../src/exec.mjs";

// Keep the suite hermetic: an agent host (e.g. the atc pre-tool hook rewriting the command to
// `export ATC_SESSION_ID=… ATC_ANCHOR_PID=…; npm run check`) can leak ATC_* identity/coordination
// variables into this process. cmdClaim/cmdFree/etc. read process.env by default, so a leaked
// ATC_ANCHOR_PID would be stamped on every lease as anchorPid and then GC'd as dead_anchor by tests
// that pass a restrictive livenessCheck.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ATC_")) delete process.env[key];
}

function makeTempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atc-test-"));
}

// Writes fake tool scripts (e.g. { adb: "exit 0" }) into <rootDir>/fake-bin and returns an env
// whose PATH resolves them first, for driving typed `atc exec` ops without real devices.
// On Windows only plain `exit N` bodies are supported (emitted as `<name>.cmd`).
function makeFakeToolEnv(rootDir, tools) {
  const binDir = path.join(rootDir, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const exitOnly = /^exit (\d+)$/.exec(body.trim());
    if (exitOnly) {
      fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@exit /b ${exitOnly[1]}\r\n`);
    }
  }
  return process.platform === "win32"
    ? { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || process.env.Path || ""}` }
    : { ...process.env, PATH: `${binDir}:/usr/bin:/bin` };
}

test("lock: acquire, verify nonce, and release", () => {
  const dir = makeTempStateDir();
  try {
    const handle = acquireLock(dir, 2000);
    assert.ok(handle.nonce);
    assert.equal(verifyLockOwnership(handle), true);
    releaseLock(handle);
    assert.equal(verifyLockOwnership(handle), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: breaks stale lock with dead PID", () => {
  const dir = makeTempStateDir();
  try {
    const lockDir = path.join(dir, "atc.lock");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    writeFileAtomic(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 99999999,
        nonce: "dead-nonce",
        createdAtMs: Date.now() - 60_000,
      })
    );
    const handle = acquireLock(dir, 2000);
    assert.ok(handle.nonce !== "dead-nonce");
    releaseLock(handle);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: quarantines corrupted state.json and reinitializes", () => {
  const dir = makeTempStateDir();
  try {
    fs.writeFileSync(path.join(dir, "state.json"), "{ invalid json ", "utf8");
    const state = readState(dir);
    assert.equal(state.version, 1);
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("state.json.corrupt.")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: GC expires dead leases and cleans stale queue tickets", () => {
  const now = 1_700_000_000_000;
  const state = createDefaultState();
  state.leases["avd:Pixel_8_API_35"] = {
    leaseId: "lease-expired",
    deviceKey: "avd:Pixel_8_API_35",
    serial: "emulator-5554",
    avd: "Pixel_8_API_35",
    kind: "emulator",
    state: "active",
    sessionId: "sess-1",
    anchorPid: 99999999,
    claimedAtMs: now - 120_000,
    renewedAtMs: now - 120_000,
    expiresAtMs: now - 60_000,
  };
  state.queue.push({
    ticketId: "t-stale",
    sessionId: "sess-2",
    waiterPid: 99999999,
    enqueuedAtMs: now - 60_000,
    lastHeartbeatAtMs: now - 30_000,
    waitExpiresAtMs: now + 60_000,
  });

  const pruned = runGarbageCollection(state, null, now);
  assert.equal(pruned.leases.length, 1);
  assert.equal(state.leases["avd:Pixel_8_API_35"], undefined);
  assert.equal(pruned.queue.length, 1);
  assert.equal(state.queue.length, 0);

  // Renewed active lease older than maxTtlSec from original claim is NOT pruned while renewedAtMs is fresh
  state.leases["avd:Pixel_9_API_36"] = {
    leaseId: "lease-renewed",
    deviceKey: "avd:Pixel_9_API_36",
    serial: "emulator-5556",
    avd: "Pixel_9_API_36",
    kind: "emulator",
    state: "active",
    sessionId: "sess-live",
    anchorPid: process.pid,
    claimedAtMs: now - 7_200_000, // 2 hours ago (> maxTtlSec)
    renewedAtMs: now - 60_000, // renewed 1 min ago
    expiresAtMs: now + 540_000,
  };
  const pruned2 = runGarbageCollection(state, null, now);
  assert.equal(pruned2.leases.length, 0);
  assert.ok(state.leases["avd:Pixel_9_API_36"]);
});

test("state: reconcileOfflineLeases requires 5s dual-source confirmation", () => {
  const now = 1_700_000_000_000;
  const state = createDefaultState();
  state.config.offlineGraceMs = 5000;
  state.leases["avd:Pixel_8_API_35"] = {
    leaseId: "lease-1",
    deviceKey: "avd:Pixel_8_API_35",
    serial: "emulator-5554",
    avd: "Pixel_8_API_35",
    kind: "emulator",
    state: "active",
    sessionId: "sess-owner",
    anchorPid: process.pid,
    claimedAtMs: now,
    renewedAtMs: now,
    expiresAtMs: now + 60_000,
    firstSeenOfflineAtMs: null,
  };

  // First sighting offline by another session -> records firstSeenOfflineAtMs, keeps lease
  reconcileOfflineLeases(state, { running: [] }, "sess-other", now);
  assert.ok(state.leases["avd:Pixel_8_API_35"]);
  assert.equal(state.leases["avd:Pixel_8_API_35"].firstSeenOfflineAtMs, now);

  // If either probe fails, offline reconciliation is skipped and does not revoke the lease
  reconcileOfflineLeases(
    state,
    { running: [], probes: { emulatorListOk: false, adbDevicesOk: true } },
    "sess-owner",
    now + 6000,
  );
  assert.ok(state.leases["avd:Pixel_8_API_35"]);

  // 3 seconds later -> still within 5s grace window
  reconcileOfflineLeases(state, { running: [] }, "sess-other", now + 3000);
  assert.ok(state.leases["avd:Pixel_8_API_35"]);

  // 6 seconds later -> confirmed dead, lease revoked
  reconcileOfflineLeases(state, { running: [] }, "sess-other", now + 6000);
  assert.equal(state.leases["avd:Pixel_8_API_35"], undefined);
});

test("state: profile matching and bounded-window warm-affinity scheduling", () => {
  assert.equal(matchesApiSpec("android-35", "35"), true);
  assert.equal(matchesApiSpec("android-35", ">=34"), true);
  assert.equal(matchesApiSpec("android-33", ">=34"), false);
  assert.equal(matchesApiSpec("android-34", "33..35"), true);

  const dev = {
    deviceKey: "avd:Pixel_8_API_35",
    avd: "Pixel_8_API_35",
    serial: "emulator-5554",
    kind: "emulator",
    online: true,
    profile: {
      apiLevel: "android-35",
      deviceType: "phone",
      services: "google_apis",
      playStore: false,
      abi: "arm64-v8a",
    },
  };
  assert.equal(matchesProfile(dev, { apiSpec: ">=34", deviceType: "phone" }), true);
  assert.equal(matchesProfile(dev, { apiSpec: ">=34", deviceType: "tablet" }), false);

  const now = 1_700_000_000_000;
  const earlierTicket = {
    ticketId: "t-0",
    sessionId: "sess-0",
    requestedKind: "emulator",
    requestedProfile: { apiSpec: "36", deviceType: "phone" },
    enqueuedAtMs: now - 10_000,
    starvationDeadlineMs: now + 110_000,
  };
  const candidateTicket = {
    ticketId: "t-1",
    sessionId: "sess-1",
    requestedKind: "emulator",
    requestedProfile: { apiSpec: "35", deviceType: "phone" },
    enqueuedAtMs: now - 5_000,
  };

  // Warm API 35 device does not match earlierTicket (API 36), so candidateTicket can jump ahead
  assert.equal(canJumpAhead(candidateTicket, earlierTicket, dev, now), true);

  // Once starvationDeadlineMs is reached, jumping is blocked
  earlierTicket.starvationDeadlineMs = now - 1;
  assert.equal(isTicketStarvationProtected(earlierTicket, now), true);
  assert.equal(canJumpAhead(candidateTicket, earlierTicket, dev, now), false);
});

test("android: parsers and resource admission with recently-activated RAM projection", () => {
  const adbOut = [
    "List of devices attached",
    "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
    "R58M123456A            device usb:1-1 product:dm1q model:SM_S911B device:dm1q transport_id:2",
  ].join("\n");
  const parsedAdb = parseAdbDevicesOutput(adbOut);
  assert.equal(parsedAdb.length, 2);
  assert.equal(parsedAdb[0].serial, "emulator-5554");
  assert.equal(parsedAdb[0].kind, "emulator");
  assert.equal(parsedAdb[1].serial, "R58M123456A");
  assert.equal(parsedAdb[1].kind, "physical");

  const cliOut = [
    "AVD                 Status    Serial          API",
    "Pixel_8_API_35      online    emulator-5554   android-35",
    "Pixel_Tablet_API_34 offline   -               android-34",
  ].join("\n");
  const parsedCli = parseAndroidEmulatorListOutput(cliOut);
  assert.equal(parsedCli.length, 2);
  assert.equal(parsedCli[0].online, true);
  assert.equal(parsedCli[1].online, false);

  const now = 1_700_000_000_000;
  const state = createDefaultState();
  // Device activated 5s ago with 4096 MB required RAM -> projected against available RAM
  state.leases["avd:recent"] = {
    leaseId: "l-recent",
    deviceKey: "avd:recent",
    avd: "recent",
    kind: "emulator",
    state: "active",
    activatedAtMs: now - 5_000,
    requiredRamMb: 4096,
  };

  assert.throws(
    () =>
      checkResourceAdmission(
        { avd: "candidate", requiredRamMb: 3072, ramSizeMb: 2048 },
        { availableRamMb: 8000, freeDiskMb: 50_000, totalRamMb: 32768 },
        state,
        { running: [] },
        { now }
      ),
    (err) => err instanceof ResourceError && err.exitCode === 5
  );

  const id1 = deterministicCreatedAvdId({
    apiSpec: "35",
    deviceType: "phone",
    services: "google_apis",
    abi: "arm64-v8a",
  });
  assert.equal(id1, "atc_phone_android-35_google_apis_arm64-v8a");

  const creatable = parseCreatableProfilesOutput(
    "Profile        Type     API          Services   ABI\npixel_9        phone    android-36   play       arm64-v8a\npixel_tablet   tablet   android-35   google_apis arm64-v8a\n"
  );
  assert.equal(creatable.length, 2);
  assert.equal(creatable[0].deviceName, "pixel_9");
  assert.equal(creatable[0].profile.apiLevel, "android-36");
  assert.equal(creatable[1].profile.deviceType, "tablet");
});

test("hook: PreToolUse handles GitHub Copilot CLI native format", () => {
  const dir = makeTempStateDir();
  try {
    // Non-shell tools and non-device shell commands pass through silently
    const viewAllow = handlePreToolUseHook(
      dir,
      JSON.stringify({ sessionId: "cp-1", toolName: "view", toolArgs: { path: "README.md" } }),
      { ppid: process.pid }
    );
    assert.equal(viewAllow.exitCode, 0);
    assert.equal(viewAllow.stdout, "");

    // v3: shell tool calls are never inspected; they are always allowed (empty stdout for Copilot,
    // toolArgs as JSON string or object) and only record the session for this agent's anchor PID
    for (const toolArgs of [
      JSON.stringify({ command: "adb shell pm list packages" }),
      { command: "atc claim --type phone", description: "claim" },
    ]) {
      const shellAllow = handlePreToolUseHook(
        dir,
        JSON.stringify({ sessionId: "cp-1", cwd: process.cwd(), toolName: "bash", toolArgs }),
        { ppid: process.pid }
      );
      assert.equal(shellAllow.exitCode, 0);
      assert.equal(shellAllow.stdout, "");
    }
    assert.equal(readState(dir).hookSessions[String(process.pid)]?.sessionId, "cp-1");

    // Concurrent Copilot chats sharing a single long-lived MCP process get isolated session IDs
    const mcpInventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      running: [
        {
          deviceKey: "avd:Pixel_8_API_35",
          avd: "Pixel_8_API_35",
          serial: "emulator-5554",
          kind: "emulator",
          online: true,
          profile: { deviceType: "phone", apiLevel: "android-35" },
        },
      ],
      offline: [],
      creatable: [],
    };
    const sharedMcpOpts = { ppid: process.pid, pid: process.pid, env: {}, inventory: mcpInventory };
    const preMcpClaim = handlePreToolUseHook(
      dir,
      JSON.stringify({
        sessionId: "cp-1",
        cwd: process.cwd(),
        toolName: "atc-atc_claim",
        toolArgs: JSON.stringify({ avd: "Pixel_8_API_35" }),
      }),
      { ppid: process.pid }
    );
    assert.equal(preMcpClaim.exitCode, 0);
    const preMcpClaimOut = JSON.parse(preMcpClaim.stdout);
    assert.equal(preMcpClaimOut.permissionDecision, "allow");
    assert.equal(preMcpClaimOut.modifiedArgs.avd, "Pixel_8_API_35");
    assert.equal(preMcpClaimOut.modifiedArgs.session, "cp-1");

    // Overlapping preToolUse from cp-2 before cp-1's MCP request arrives does not overwrite cp-1's invocation
    const preMcpFreeOther = handlePreToolUseHook(
      dir,
      JSON.stringify({
        sessionId: "cp-2",
        cwd: process.cwd(),
        toolName: "atc-atc_free",
        toolArgs: {},
      }),
      { ppid: process.pid }
    );
    assert.equal(preMcpFreeOther.exitCode, 0);
    assert.equal(JSON.parse(preMcpFreeOther.stdout).modifiedArgs.session, "cp-2");

    // Even if the host does not forward modifiedArgs into the MCP call, pendingMcpCalls resolves cp-1 for atc_claim
    const mcpClaimReply = handleMcpRequest(
      dir,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "atc_claim", arguments: { avd: "Pixel_8_API_35" } },
      },
      sharedMcpOpts
    );
    assert.equal(JSON.parse(mcpClaimReply.result.content[0].text).exitCode, 0);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"].sessionId, "cp-1");

    // And cp-2's pending atc_free resolves cp-2, which cannot free cp-1's lease
    const mcpFreeOtherReply = handleMcpRequest(
      dir,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "atc_free", arguments: {} },
      },
      sharedMcpOpts
    );
    assert.deepEqual(JSON.parse(mcpFreeOtherReply.result.content[0].text).freed, []);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"].sessionId, "cp-1");

    // An explicit session override in MCP toolArgs neither records a stale pending entry nor consumes another chat's pending unforwarded call
    handlePreToolUseHook(
      dir,
      JSON.stringify({
        sessionId: "cp-2",
        cwd: process.cwd(),
        toolName: "atc-atc_free",
        toolArgs: {},
      }),
      { ppid: process.pid }
    );
    handlePreToolUseHook(
      dir,
      JSON.stringify({
        sessionId: "cp-1",
        cwd: process.cwd(),
        toolName: "atc-atc_free",
        toolArgs: { session: "manual" },
      }),
      { ppid: process.pid }
    );
    const explicitOverrideReply = handleMcpRequest(
      dir,
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "atc_free", arguments: { session: "manual" } },
      },
      sharedMcpOpts
    );
    assert.equal(explicitOverrideReply.result.isError, false);
    const postOverrideUnforwardedReply = handleMcpRequest(
      dir,
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "atc_free", arguments: {} },
      },
      sharedMcpOpts
    );
    assert.equal(postOverrideUnforwardedReply.result.isError, false);
    assert.deepEqual(JSON.parse(postOverrideUnforwardedReply.result.content[0].text).freed, []);

    // Overlapping identical unforwarded MCP calls from cp-1 and cp-2 fail closed as ambiguous
    handlePreToolUseHook(
      dir,
      JSON.stringify({
        sessionId: "cp-1",
        cwd: process.cwd(),
        toolName: "atc-atc_free",
        toolArgs: {},
      }),
      { ppid: process.pid }
    );
    handlePreToolUseHook(
      dir,
      JSON.stringify({
        sessionId: "cp-2",
        cwd: process.cwd(),
        toolName: "atc-atc_free",
        toolArgs: {},
      }),
      { ppid: process.pid }
    );
    const ambiguousReply = handleMcpRequest(
      dir,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "atc_free", arguments: {} },
      },
      sharedMcpOpts
    );
    assert.equal(ambiguousReply.result.isError, true);
    const ambiguousPayload = JSON.parse(ambiguousReply.result.content[0].text);
    assert.equal(ambiguousPayload.code, "AmbiguousSessionError");
    assert.match(ambiguousPayload.error, /Multiple concurrent agent sessions/);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"].sessionId, "cp-1");

    // Explicit ATC_SESSION_ID values starting with "mcp-" are still honored over hookSessions
    const explicitMcpEnvIdentity = resolveSessionIdentity({
      state: readState(dir),
      env: { ATC_SESSION_ID: "mcp-build" },
      ppid: process.pid,
      cwd: process.cwd(),
    });
    assert.equal(explicitMcpEnvIdentity.sessionId, "mcp-build");
    assert.equal(explicitMcpEnvIdentity.source, "env_atc");

    // sessionEnd with reason "complete" fires after every Copilot turn: keep the lease.
    // A terminal reason (user_exit/abort/error/timeout) releases it.
    const stopOpts = {
      ppid: process.pid,
      host: { freeDiskMb: 65536 },
      runner: () => ({ status: 0, stdout: "OK", stderr: "" }),
    };
    const turnEnd = handleStopHook(
      dir,
      JSON.stringify({ sessionId: "cp-1", cwd: process.cwd(), reason: "complete" }),
      stopOpts
    );
    assert.deepEqual(turnEnd.freed, []);
    const userExit = handleStopHook(
      dir,
      JSON.stringify({ sessionId: "cp-1", cwd: process.cwd(), reason: "user_exit" }),
      stopOpts
    );
    assert.equal(userExit.exitCode, 0);
    assert.equal(userExit.freed.length, 1);

    // Copilot hook manifest exists where Agent Plugins 1.0 loads it, and MCP config at root mcp.json
    const rootDir = new URL("../", import.meta.url);
    const copilotHooks = JSON.parse(
      fs.readFileSync(new URL("com.github.copilot/hooks/hooks.json", rootDir), "utf8")
    );
    assert.equal(copilotHooks.version, 1);
    assert.match(copilotHooks.hooks.preToolUse[0].command, /'hook', 'PreToolUse'/);
    assert.match(copilotHooks.hooks.sessionEnd[0].command, /'hook', 'SessionEnd'/);
    // Agent Plugins 1.0 skips a root mcp.json without the matching $schema; stdio needs explicit type
    const mcp = JSON.parse(fs.readFileSync(new URL("mcp.json", rootDir), "utf8"));
    assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    assert.equal(mcp.mcpServers.atc.type, "stdio");
    assert.equal(mcp.mcpServers.atc.command, "atc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: PreToolUse and Stop hooks handle Antigravity and Claude/Codex formats", () => {
  const dir = makeTempStateDir();
  try {
    // 1. v3: PreToolUse never inspects shell commands; Antigravity run_command is always allowed
    // with decision: "allow" and the session + tool-args cwd are recorded in hookSessions
    const preShell = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversationId: "conv-123",
        workspacePaths: ["/workspace/from-antigravity"],
        toolCall: {
          name: "run_command",
          args: { CommandLine: "adb shell pm list packages", Cwd: "/workspace/from-tool-args" },
        },
      }),
      { ppid: process.pid }
    );
    assert.equal(preShell.exitCode, 0);
    assert.deepEqual(JSON.parse(preShell.stdout), { decision: "allow" });
    assert.equal(readState(dir).hookSessions[String(process.pid)]?.sessionId, "conv-123");
    assert.equal(readState(dir).hookSessions[String(process.pid)]?.cwd, "/workspace/from-tool-args");

    // 1c. PreToolUse injects session into Antigravity MCP tool calls with decision: "allow" + overwrite
    const antigravityMcp = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversationId: "conv-123",
        workspacePaths: ["/workspace/from-antigravity"],
        toolCall: {
          name: "mcp_atc_atc_claim",
          args: { type: "phone" },
        },
      }),
      { ppid: process.pid }
    );
    assert.equal(antigravityMcp.exitCode, 0);
    const antigravityMcpOut = JSON.parse(antigravityMcp.stdout);
    assert.equal(antigravityMcpOut.decision, "allow");
    assert.equal(antigravityMcpOut.overwrite.session, "conv-123");
    assert.equal(antigravityMcpOut.overwrite.type, "phone");

    // 1d. PreToolUse unwraps Antigravity lazy MCP calls (`call_mcp_tool`) and overwrites Arguments.session
    const antigravityLazyMcp = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversationId: "conv-lazy-456",
        workspacePaths: ["/workspace/from-antigravity"],
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "atc_atc",
            ToolName: "atc_claim",
            Arguments: { type: "phone", api: "36" },
          },
        },
      }),
      { ppid: process.pid }
    );
    assert.equal(antigravityLazyMcp.exitCode, 0);
    const antigravityLazyMcpOut = JSON.parse(antigravityLazyMcp.stdout);
    assert.equal(antigravityLazyMcpOut.decision, "allow");
    assert.deepEqual(antigravityLazyMcpOut.overwrite, {
      Arguments: { type: "phone", api: "36", session: "conv-lazy-456" },
    });

    const antigravityNonAtcLazyMcp = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversationId: "conv-lazy-456",
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "chrome-devtools",
            ToolName: "navigate_page",
            Arguments: { url: "https://example.com" },
          },
        },
      }),
      { ppid: process.pid }
    );
    assert.equal(antigravityNonAtcLazyMcp.exitCode, 0);
    assert.deepEqual(JSON.parse(antigravityNonAtcLazyMcp.stdout), { decision: "allow" });

    const antigravityFastAllow = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversationId: "conv-lazy-456",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo hello" },
        },
      }),
      { ppid: process.pid }
    );
    assert.equal(antigravityFastAllow.exitCode, 0);
    assert.deepEqual(JSON.parse(antigravityFastAllow.stdout), { decision: "allow" });

    // 2. Claude/Codex shell calls are allowed with empty stdout and never rewritten
    const preClaude = handlePreToolUseHook(
      dir,
      JSON.stringify({
        session_id: "claude-sess-1",
        tool_name: "Bash",
        tool_input: { command: "atc claim --type phone" },
      }),
      { ppid: process.pid }
    );
    assert.equal(preClaude.exitCode, 0);
    assert.equal(preClaude.stdout, "");
    assert.equal(readState(dir).hookSessions[String(process.pid)]?.sessionId, "claude-sess-1");

    // Cursor shell calls are allowed with permission: "allow"
    const preCursor = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversation_id: "cursor-sess-1",
        hook_event_name: "beforeShellExecution",
        command: "adb shell wm size",
        cwd: process.cwd(),
      }),
      { ppid: process.pid }
    );
    assert.equal(preCursor.exitCode, 0);
    assert.deepEqual(JSON.parse(preCursor.stdout), { permission: "allow" });

    // 3. Two sessions holding leases: shell calls are still allowed (no command inspection)
    const mockInventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      running: [
        {
          deviceKey: "avd:Pixel_8_API_35",
          avd: "Pixel_8_API_35",
          serial: "emulator-5554",
          kind: "emulator",
          online: true,
          profile: { deviceType: "phone", apiLevel: "android-35" },
        },
        {
          deviceKey: "avd:Pixel_9_API_36",
          avd: "Pixel_9_API_36",
          serial: "emulator-5556",
          kind: "emulator",
          online: true,
          profile: { deviceType: "phone", apiLevel: "android-36" },
        },
      ],
      offline: [],
      creatable: [],
    };
    cmdClaim(
      dir,
      { session: "sess-a", avd: "Pixel_8_API_35", snapshotSaveOnFree: "snap-a" },
      { inventory: mockInventory }
    );
    cmdClaim(dir, { session: "sess-b", avd: "Pixel_9_API_36" }, { inventory: mockInventory });

    const unscopedPre = handlePreToolUseHook(
      dir,
      JSON.stringify({
        session_id: "sess-a",
        tool_name: "Bash",
        tool_input: { command: "adb shell wm size" },
      }),
      {
        ppid: process.pid,
        runner: () => ({ status: 0, stdout: "List of devices attached\n", stderr: "" }),
      }
    );
    assert.equal(unscopedPre.exitCode, 0);
    assert.equal(unscopedPre.stdout, "");

    // 4. Stop hook executes deferred snapshotSaveOnFree before releasing lease
    const runnerCalls = [];
    const stopRes = handleStopHook(dir, JSON.stringify({ session_id: "sess-a" }), {
      ppid: process.pid,
      host: { freeDiskMb: 65536 },
      runner: (cmd, args) => {
        runnerCalls.push([cmd, ...args].join(" "));
        return { status: 0, stdout: "OK", stderr: "" };
      },
    });
    assert.equal(stopRes.exitCode, 0);
    assert.equal(stopRes.freed.length, 1);
    assert.ok(
      runnerCalls.some((c) => c.includes("adb -s emulator-5554 emu avd snapshot save snap-a"))
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: claim, status, renew, exec, and free end-to-end with mock fleet", async () => {
  const dir = makeTempStateDir();
  try {
    const mockInventory = {
      host: {
        totalRamMb: 32768,
        availableRamMb: 16384,
        freeDiskMb: 65536,
        cpuCores: 12,
      },
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
          snapshots: ["atc-clean-base"],
          profile: {
            deviceType: "phone",
            deviceName: "pixel_8",
            apiLevel: "android-35",
            services: "google_apis",
            playStore: false,
            abi: "arm64-v8a",
          },
        },
      ],
      offline: [],
      creatable: [],
    };

    // 1. Claim the warm device
    const claimRes = cmdClaim(
      dir,
      { session: "sess-test", api: "35", type: "phone" },
      { inventory: mockInventory }
    );
    assert.equal(claimRes.exitCode, 0);
    assert.equal(claimRes.lease.serial, "emulator-5554");

    // 2. Status reflects 1 active lease
    const statusRes = cmdStatus(dir, {}, { inventory: mockInventory });
    assert.equal(statusRes.exitCode, 0);
    assert.ok(statusRes.leases["avd:Pixel_8_API_35"]);

    // 3. Renew lease
    const renewRes = cmdRenew(dir, claimRes.lease.leaseId, { session: "sess-test", ttl: 1200 });
    assert.equal(renewRes.exitCode, 0);

    // 4. Exec a typed op: the fake adb sees the lease serial via -s and ANDROID_SERIAL/ATC_* env
    if (process.platform !== "win32") {
      const binDir = path.join(dir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const envLog = path.join(dir, "adb-env.log");
      fs.writeFileSync(
        path.join(binDir, "adb"),
        `#!/bin/sh\necho "$1 $2 ANDROID_SERIAL=$ANDROID_SERIAL ATC_LEASE_ID=$ATC_LEASE_ID ATC_SESSION_ID=$ATC_SESSION_ID" > ${envLog}\n[ "$ANDROID_SERIAL" = "emulator-5554" ] || exit 42\n`,
        { mode: 0o755 }
      );
      const execRes = await cmdExec(dir, ["android", "logcat", "--session", "sess-test", "--json"], {
        env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
        inventory: mockInventory,
      });
      assert.equal(execRes.exitCode, 0, execRes.error);
      assert.equal(
        fs.readFileSync(envLog, "utf8").trim(),
        `-s emulator-5554 ANDROID_SERIAL=emulator-5554 ATC_LEASE_ID=${claimRes.lease.leaseId} ATC_SESSION_ID=sess-test`
      );
    }

    // 5. Free the lease
    const freeRes = cmdFree(dir, claimRes.lease.leaseId, { session: "sess-test" });
    assert.equal(freeRes.exitCode, 0);
    assert.deepEqual(freeRes.freed, [claimRes.lease.leaseId]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: error propagation for resetApp, boot serial discovery, free actions, and snapshot load", () => {
  const dir = makeTempStateDir();
  try {
    const warmDevice = {
      deviceKey: "avd:Pixel_8_API_35",
      avd: "Pixel_8_API_35",
      serial: "emulator-5554",
      kind: "emulator",
      online: true,
      ramSizeMb: 2048,
      requiredRamMb: 3072,
      dataDiskMb: 6656,
      snapshots: ["atc-clean-base"],
      profile: {
        deviceType: "phone",
        deviceName: "pixel_8",
        apiLevel: "android-35",
        services: "google_apis",
        playStore: false,
        abi: "arm64-v8a",
      },
    };
    const mockInventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      running: [warmDevice],
      offline: [],
      creatable: [],
    };

    // 1. Failing --reset-app fails the claim and cleans up the lease
    const failedReset = cmdClaim(
      dir,
      { session: "sess-1", api: "35", resetApp: "com.example.missing" },
      {
        inventory: mockInventory,
        runner: () => ({ status: 1, stdout: "", stderr: "Failed" }),
      }
    );
    assert.equal(failedReset.exitCode, 1);
    assert.match(failedReset.error, /Failed to reset app/);
    assert.deepEqual(readState(dir).leases, {});

    // 2. Claim succeeds when runner succeeds, and snapshot load only records loadedSnapshot on success
    const claimOk = cmdClaim(
      dir,
      { session: "sess-1", api: "35" },
      { inventory: mockInventory }
    );
    assert.equal(claimOk.exitCode, 0);

    const snapFail = cmdSnapshot(
      dir,
      "load",
      "clean-snap",
      { session: "sess-1" },
      { runner: () => ({ status: 1, stdout: "", stderr: "KO: snapshot does not exist" }) }
    );
    assert.equal(snapFail.exitCode, 1);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"].loadedSnapshot, null);

    const snapOk = cmdSnapshot(
      dir,
      "load",
      "clean-snap",
      { session: "sess-1" },
      {
        runner: (_cmd, args, opts) => {
          if (args.includes("snapshot")) {
            assert.equal(opts.timeoutMs, 60_000);
          }
          return { status: 0, stdout: "1\n", stderr: "" };
        },
      }
    );
    assert.equal(snapOk.exitCode, 0);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"].loadedSnapshot, "clean-snap");

    // 3. Failing post-release action on cmdFree propagates exitCode 1 and retains active lease
    const freeFail = cmdFree(
      dir,
      claimOk.lease.leaseId,
      { session: "sess-1", stop: true },
      { runner: () => ({ status: 1, stdout: "", stderr: "stop failed" }) }
    );
    assert.equal(freeFail.exitCode, 1);
    assert.match(freeFail.error, /Failed to stop emulator/);
    assert.deepEqual(freeFail.freed, []);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"].state, "active");

    // 4. Non-finite --wait duration is rejected with exitCode 1
    const badWait = cmdClaim(
      dir,
      { session: "sess-1", wait: "abc" },
      { inventory: mockInventory }
    );
    assert.equal(badWait.exitCode, 1);
    assert.match(badWait.error, /Invalid --wait duration/);

    // 5. Configured defaultWaitSec = 0 is honored when --wait is omitted
    cmdConfig(dir, "set", "defaultWaitSec", "0");
    const busyNoWait = cmdClaim(
      dir,
      { session: "sess-2", api: "36" },
      { inventory: mockInventory }
    );
    assert.equal(busyNoWait.exitCode, 2);

    // 6. Re-claim for the idempotency check below
    cmdClaim(dir, { session: "sess-1", api: "35" }, { inventory: mockInventory });

    // 7. Idempotent re-claim with --reset-app and --snapshot-save-on-free executes pm clear and persists saveSnapshotOnFree
    const resetCalls = [];
    const idemReset = cmdClaim(
      dir,
      {
        session: "sess-1",
        api: "35",
        resetApp: "com.example.app",
        snapshotSaveOnFree: "post-test-snap",
      },
      {
        inventory: mockInventory,
        runner: (cmd, args) => {
          resetCalls.push([cmd, ...args].join(" "));
          return { status: 0, stdout: "Success", stderr: "" };
        },
      }
    );
    assert.equal(idemReset.exitCode, 0);
    assert.equal(idemReset.idempotent, true);
    assert.equal(
      readState(dir).leases["avd:Pixel_8_API_35"].saveSnapshotOnFree,
      "post-test-snap"
    );
    assert.ok(
      resetCalls.includes("adb -s emulator-5554 shell pm clear com.example.app")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: offline wipeData/snapshotLoad and createIfMissing use supported android CLI flags", async () => {
  const dir = makeTempStateDir();
  const avdHome = makeTempStateDir();
  try {
    const avdDir = path.join(avdHome, "Pixel_8_API_35.avd");
    fs.mkdirSync(path.join(avdDir, "snapshots", "default_boot"), { recursive: true });
    fs.writeFileSync(path.join(avdDir, "userdata-qemu.img.qcow2"), "dirty", "utf8");

    const offlineInventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      running: [],
      offline: [
        {
          deviceKey: "avd:Pixel_8_API_35",
          avd: "Pixel_8_API_35",
          serial: null,
          kind: "emulator",
          online: false,
          ramSizeMb: 2048,
          requiredRamMb: 3072,
          dataDiskMb: 6656,
          snapshots: ["clean-base"],
          profile: {
            deviceType: "phone",
            deviceName: "pixel_8",
            apiLevel: "android-35",
            services: "google_apis",
            playStore: false,
            abi: "arm64-v8a",
          },
        },
      ],
      creatable: [
        {
          kind: "emulator",
          deviceName: "medium_phone",
          profile: {
            deviceType: "phone",
            deviceName: "medium_phone",
            apiLevel: "android-36",
            services: "play",
            playStore: true,
            abi: "arm64-v8a",
          },
        },
      ],
    };

    const bootCalls = [];
    const bootRes = cmdClaim(
      dir,
      {
        session: "sess-boot",
        api: "35",
        wipeData: true,
        snapshotLoad: "clean-base",
        headless: true,
      },
      {
        platform: "linux",
        avdHome,
        inventory: offlineInventory,
        runner: (cmd, args) => {
          bootCalls.push([cmd, ...args].join(" "));
          if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
            return { status: 0, stdout: "Started emulator-5554\n", stderr: "" };
          }
          if (cmd === "adb" && args.includes("getprop")) {
            return { status: 0, stdout: "1\n", stderr: "" };
          }
          return { status: 0, stdout: "OK", stderr: "" };
        },
      }
    );
    assert.equal(bootRes.exitCode, 0);
    assert.equal(fs.existsSync(path.join(avdDir, "userdata-qemu.img.qcow2")), false);
    assert.equal(fs.existsSync(path.join(avdDir, "snapshots", "default_boot")), false);
    assert.deepEqual(bootCalls, [
      "android emulator start Pixel_8_API_35 --headless --cold",
      "adb -s emulator-5554 emu avd snapshot load clean-base",
      "adb -s emulator-5554 shell getprop sys.boot_completed",
    ]);

    // Free with --shutdown synonym
    const freeCalls = [];
    const freeRes = cmdFree(
      dir,
      bootRes.lease.leaseId,
      { session: "sess-boot", shutdown: true },
      {
        platform: "linux",
        avdHome,
        runner: (cmd, args) => {
          freeCalls.push([cmd, ...args].join(" "));
          return { status: 0, stdout: "OK", stderr: "" };
        },
      }
    );
    assert.equal(freeRes.exitCode, 0);
    assert.deepEqual(freeCalls, ["android emulator stop emulator-5554"]);

    // Auto-create missing AVD invokes `android emulator create <profile>` without `--name` and migrates lease key
    const createCalls = [];
    const createRes = cmdClaim(
      dir,
      {
        session: "sess-create",
        api: "36",
        type: "phone",
        createIfMissing: true,
      },
      {
        platform: "linux",
        avdHome,
        inventory: offlineInventory,
        runner: (cmd, args) => {
          createCalls.push([cmd, ...args].join(" "));
          if (cmd === "android" && args[0] === "emulator" && args[1] === "create") {
            return { status: 0, stdout: "Created AVD Medium_Phone_API_36\n", stderr: "" };
          }
          if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
            return {
              status: 0,
              stdout: "AVD                 Status    Serial          API\nMedium_Phone_API_36 offline   -               android-36\n",
              stderr: "",
            };
          }
          if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
            return { status: 0, stdout: "Started emulator-5556\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      }
    );
    assert.equal(createRes.exitCode, 0);
    assert.equal(createRes.lease.avd, "Medium_Phone_API_36");
    assert.equal(createRes.lease.deviceKey, "avd:Medium_Phone_API_36");
    assert.ok(createCalls.includes("android emulator create medium_phone"));
    assert.ok(createCalls.includes("android emulator start Medium_Phone_API_36"));

    // matchesProfile rejects online and offline emulators lacking requested snapshot
    assert.equal(
      matchesProfile(
        { kind: "emulator", online: true, snapshots: [] },
        { snapshotLoad: "clean-base" }
      ),
      false
    );
    assert.equal(
      matchesProfile(
        { kind: "emulator", online: false, snapshots: [] },
        { snapshotLoad: "clean-base" }
      ),
      false
    );
    assert.equal(
      matchesProfile(
        { kind: "emulator", online: true, snapshots: ["clean-base"] },
        { snapshotLoad: "clean-base" }
      ),
      true
    );

    // Ancestor PID disambiguation resolves concurrent hook sessions in the same cwd
    const multiHookState = {
      hookSessions: {
        "1001": { sessionId: "agent-one", agentPid: 1001, cwd: "/repo" },
        "2002": { sessionId: "agent-two", agentPid: 2002, cwd: "/repo" },
      },
    };
    const resolvedByAncestor = resolveSessionIdentity({
      env: {},
      state: multiHookState,
      cwd: "/repo",
      ppid: 3003,
      ancestorPids: [3003, 2500, 2002],
    });
    assert.equal(resolvedByAncestor.sessionId, "agent-two");

    // Snapshot list honors --serial targeting
    const snapBySerial = cmdSnapshot(
      dir,
      "list",
      null,
      { serial: "emulator-5554" },
      {
        avdHome,
        inventory: {
          running: [
            {
              kind: "emulator",
              avd: "Pixel_8_API_35",
              serial: "emulator-5554",
              snapshots: ["clean-base"],
            },
            {
              kind: "emulator",
              avd: "Medium_Phone_API_36",
              serial: "emulator-5556",
              snapshots: ["other-snap"],
            },
          ],
          offline: [],
        },
      }
    );
    assert.equal(snapBySerial.exitCode, 0);
    assert.deepEqual(snapBySerial.snapshots, ["clean-base"]);

    // Names-only --list-profiles output does not fabricate API/services/ABI
    const namesOnly = parseCreatableProfilesOutput("medium_phone\nmedium_tablet\n");
    assert.equal(namesOnly.length, 2);
    assert.equal(namesOnly[0].profile.deviceType, "phone");
    assert.equal(namesOnly[0].profile.apiLevel, null);
    assert.equal(namesOnly[0].profile.services, null);
    assert.equal(namesOnly[0].profile.playStore, null);
    assert.equal(namesOnly[0].profile.abi, null);

    // Multi-lease session: targetless cmdRenew is rejected as ambiguous
    const shortExpiry = Date.now() + 10_000;
    withStateTransaction(dir, (state, { now }) => {
      state.leases["avd:Pixel_8_API_35"] = {
        leaseId: "lease-second",
        deviceKey: "avd:Pixel_8_API_35",
        avd: "Pixel_8_API_35",
        serial: "emulator-5554",
        kind: "emulator",
        state: "active",
        sessionId: "sess-create",
        anchorPid: process.pid,
        claimedAtMs: now,
        renewedAtMs: now,
        expiresAtMs: shortExpiry,
      };
      state.leases["avd:Medium_Phone_API_36"].expiresAtMs = shortExpiry;
      return { mutated: true };
    });

    const ambigRenew = cmdRenew(dir, null, { session: "sess-create" });
    assert.equal(ambigRenew.exitCode, 1);
    assert.match(ambigRenew.error, /holds 2 active leases/);

    // Explicit --session without ATC_ANCHOR_PID leaves anchorPid null so ephemeral shell exit does not GC lease
    const explicitId = resolveSessionIdentity({
      flags: { session: "explicit-builder" },
      env: {},
      state: { hookSessions: {} },
      ppid: 99999999,
    });
    assert.equal(explicitId.sessionId, "explicit-builder");
    assert.equal(explicitId.anchorPid, null);

    const ambientId = resolveSessionIdentity({
      flags: {},
      env: { CODEX_SESSION_ID: "codex-123" },
      state: { hookSessions: {} },
      ppid: 99999999,
    });
    assert.equal(ambientId.sessionId, "codex-123");
    assert.equal(ambientId.anchorPid, null);

    // MCP claim shares session identity with subsequent PreToolUse and Stop hooks
    const mcpDir = makeTempStateDir();
    try {
      const mcpReply = handleMcpRequest(
        mcpDir,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "atc_claim",
            arguments: { avd: "Pixel_8_API_35" },
          },
        },
        {
          ppid: process.pid,
          env: {},
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [
              {
                deviceKey: "avd:Pixel_8_API_35",
                avd: "Pixel_8_API_35",
                serial: "emulator-5554",
                kind: "emulator",
                online: true,
                profile: { deviceType: "phone", apiLevel: "android-35" },
              },
            ],
            offline: [],
            creatable: [],
          },
        }
      );
      const mcpBody = JSON.parse(mcpReply.result.content[0].text);
      assert.equal(mcpBody.exitCode, 0);

      const hookAfterMcp = handlePreToolUseHook(
        mcpDir,
        JSON.stringify({
          session_id: "host-session-after-mcp",
          tool_name: "Bash",
          tool_input: { command: "adb -s emulator-5554 shell wm size" },
        }),
        { ppid: process.pid, runningCount: 1 }
      );
      assert.equal(hookAfterMcp.exitCode, 0);
      assert.equal(readState(mcpDir).leases["avd:Pixel_8_API_35"].sessionId, "host-session-after-mcp");
    } finally {
      fs.rmSync(mcpDir, { recursive: true, force: true });
    }

    // Physical device property discovery via adb shell getprop
    const fleetWithPhysical = discoverFleet({
      avdHome,
      runner: (cmd, args) => {
        if (cmd === "adb" && args[0] === "devices") {
          return {
            status: 0,
            stdout: "List of devices attached\nR58M123456A\tdevice\n",
            stderr: "",
          };
        }
        if (cmd === "adb" && args[0] === "-s" && args[1] === "R58M123456A" && args[3] === "getprop") {
          return {
            status: 0,
            stdout: [
              "[ro.build.version.sdk]: [35]",
              "[ro.product.cpu.abi]: [arm64-v8a]",
              "[ro.product.model]: [Pixel 8]",
              "[ro.build.characteristics]: [nosdcard]",
              "[ro.com.google.gmsversion]: [14_202405]",
            ].join("\n"),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const physDev = fleetWithPhysical.running.find((d) => d.serial === "R58M123456A");
    assert.ok(physDev);
    assert.equal(physDev.profile.apiLevel, "android-35");
    assert.equal(physDev.profile.abi, "arm64-v8a");
    assert.equal(physDev.profile.services, "play");
    assert.equal(physDev.profile.playStore, true);
    assert.equal(matchesProfile(physDev, { kind: "physical", apiSpec: "35", play: true }), true);
    assert.equal(matchesProfile(physDev, { kind: "physical", apiSpec: "36" }), false);

    // Windows emulator lifecycle uses `emulator -avd` and `adb -s <serial> emu kill`
    const winDir = makeTempStateDir();
    try {
      const winCalls = [];
      const winClaim = cmdClaim(
        winDir,
        { session: "win-sess", api: "35", headless: true, cold: true },
        {
          platform: "win32",
          avdHome,
          inventory: offlineInventory,
          runner: (cmd, args) => {
            winCalls.push([cmd, ...args].join(" "));
            if (cmd === "emulator") {
              return { status: 0, stdout: "emulator-5554\n", stderr: "" };
            }
            if (cmd === "adb" && args.includes("getprop")) {
              return { status: 0, stdout: "1\n", stderr: "" };
            }
            return { status: 0, stdout: "OK", stderr: "" };
          },
        }
      );
      assert.equal(winClaim.exitCode, 0);
      assert.ok(winCalls.includes("emulator -avd Pixel_8_API_35 -no-window -no-snapshot-load"));

      const winFreeCalls = [];
      const winFree = cmdFree(
        winDir,
        winClaim.lease.leaseId,
        { session: "win-sess", stop: true },
        {
          platform: "win32",
          avdHome,
          runner: (cmd, args) => {
            winFreeCalls.push([cmd, ...args].join(" "));
            return { status: 0, stdout: "OK", stderr: "" };
          },
        }
      );
      assert.equal(winFree.exitCode, 0);
      assert.equal(winFreeCalls[0], "adb -s emulator-5554 emu kill");

      // cmdStatus filters creatable profiles and reconciles offline leases
      withStateTransaction(winDir, (state, { now }) => {
        state.leases["avd:Dead_Emu"] = {
          leaseId: "lease-dead-emu",
          deviceKey: "avd:Dead_Emu",
          avd: "Dead_Emu",
          serial: "emulator-5599",
          kind: "emulator",
          state: "active",
          sessionId: "other-sess",
          anchorPid: null,
          claimedAtMs: now - 60_000,
          renewedAtMs: now - 60_000,
          expiresAtMs: now + 60_000,
          firstSeenOfflineAtMs: now - 50_000,
        };
        return { mutated: true };
      });
      const statusFiltered = cmdStatus(
        winDir,
        { type: "wear", api: "35" },
        {
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [],
            offline: [],
            creatable: [
              {
                kind: "emulator",
                deviceName: "medium_phone",
                profile: { deviceType: "phone", apiLevel: "android-36" },
              },
              {
                kind: "emulator",
                deviceName: "wearos_small_round",
                profile: { deviceType: "wear", apiLevel: "android-35" },
              },
            ],
          },
        }
      );
      assert.equal(statusFiltered.exitCode, 0);
      assert.equal(statusFiltered.leases["avd:Dead_Emu"], undefined);
      assert.equal(statusFiltered.fleet.creatable.length, 1);
      assert.equal(statusFiltered.fleet.creatable[0].deviceName, "wearos_small_round");

      // cmdConfig rejects bootTimeoutSec / stopTimeoutSec below minimum threshold and maxTtlSec < 10
      const shortBootCfg = cmdConfig(winDir, "set", "bootTimeoutSec", "2");
      assert.equal(shortBootCfg.exitCode, 1);
      assert.match(shortBootCfg.error, /at least 5 seconds/);

      const shortMaxTtl = cmdConfig(winDir, "set", "maxTtlSec", "5");
      assert.equal(shortMaxTtl.exitCode, 1);
      assert.match(shortMaxTtl.error, /at least 10 seconds/);

      // Cursor native beforeShellExecution hook format
      const cursorFastAllow = handlePreToolUseHook(
        winDir,
        JSON.stringify({
          conversation_id: "cursor-conv-1",
          hook_event_name: "beforeShellExecution",
          command: "git status",
        }),
        { ppid: process.pid }
      );
      assert.equal(cursorFastAllow.exitCode, 0);
      assert.equal(JSON.parse(cursorFastAllow.stdout).permission, "allow");

      // v3: device-tool shell commands are no longer inspected; Cursor still gets permission: "allow"
      const cursorAdbAllow = handlePreToolUseHook(
        winDir,
        JSON.stringify({
          conversation_id: "cursor-conv-1",
          hook_event_name: "beforeShellExecution",
          command: "adb shell pm clear com.example",
        }),
        { ppid: process.pid }
      );
      assert.equal(cursorAdbAllow.exitCode, 0);
      assert.equal(JSON.parse(cursorAdbAllow.stdout).permission, "allow");

      // computeUsedEmulatorSlots counts active emulator leases during transient inventory gaps
      assert.equal(
        computeUsedEmulatorSlots(
          {
            leases: {
              "avd:Pixel_8_API_35": {
                kind: "emulator",
                state: "active",
                avd: "Pixel_8_API_35",
              },
            },
          },
          { running: [] }
        ),
        1
      );

      // cmdConfig rejects queueHeartbeatTimeoutSec < 5
      const badQueueHb = cmdConfig(winDir, ["set", "queueHeartbeatTimeoutSec", "1"]);
      assert.equal(badQueueHb.exitCode, 1);

      // Starvation-protected physical ticket does not block emulator claims
      const schedNow = 1_700_000_000_000;
      const schedState = createDefaultState();
      schedState.queue.push({
        ticketId: "t-phys",
        sessionId: "sess-phys",
        requestedKind: "physical",
        requestedAvd: null,
        requestedSerial: "R58N999999Z",
        requestedProfile: { kind: "physical", serial: "R58N999999Z" },
        enqueuedAtMs: schedNow - 200_000,
        starvationDeadlineMs: schedNow - 80_000,
        lastHeartbeatAtMs: schedNow,
        waitExpiresAtMs: schedNow + 100_000,
      });
      const schedInventory = {
        host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
        running: [
          {
            deviceKey: "avd:Pixel_8_API_35",
            avd: "Pixel_8_API_35",
            serial: "emulator-5554",
            kind: "emulator",
            online: true,
            profile: {
              apiLevel: "android-35",
              deviceType: "phone",
              services: "play",
              playStore: true,
              abi: "arm64-v8a",
            },
          },
        ],
        offline: [],
        creatable: [],
      };
      const emuSelection = selectCandidateUnderLock(
        schedState,
        schedInventory,
        { kind: "emulator", apiSpec: "35" },
        null,
        schedNow,
      );
      assert.equal(emuSelection.priority, 1);
      assert.equal(emuSelection.candidate.avd, "Pixel_8_API_35");

      // Terminal session fallback anchors to parent PID
      const termIdentity = resolveSessionIdentity({
        flags: {},
        env: { TMUX_PANE: "%3" },
        state: { hookSessions: {} },
        ppid: 4242,
      });
      assert.equal(termIdentity.sessionId, "term-_3");
      assert.equal(termIdentity.anchorPid, 4242);

      // Unmapped running emulator from failed `adb emu avd name` counts toward slots and blocks offline boot
      const unmappedFleet = discoverFleet({
        avdHome,
        runner: (cmd, a) => {
          if (cmd === "android" && a[0] === "emulator" && a[1] === "list") {
            return { status: 1, stdout: "", stderr: "error" };
          }
          if (cmd === "adb" && a[0] === "devices") {
            return {
              status: 0,
              stdout: "List of devices attached\nemulator-5554\tdevice\n",
              stderr: "",
            };
          }
          if (cmd === "adb" && a[2] === "emu") {
            return { status: 1, stdout: "", stderr: "timeout" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(unmappedFleet.running.length, 1);
      assert.equal(unmappedFleet.running[0].unknownAvd, true);
      assert.equal(computeUsedEmulatorSlots({ leases: {} }, unmappedFleet), 1);
      const blockedOffline = selectCandidateUnderLock(
        createDefaultState(),
        unmappedFleet,
        { kind: "emulator", avd: "Pixel_8_API_35" },
        null,
        schedNow,
      );
      assert.equal(blockedOffline.priority, null);

      // resolveAvdHome honors ANDROID_USER_HOME and ANDROID_EMULATOR_HOME
      assert.equal(resolveAvdHome({ ANDROID_USER_HOME: "/custom/user" }), path.join("/custom/user", "avd"));
      assert.equal(
        resolveAvdHome({ ANDROID_EMULATOR_HOME: "/custom/emu" }),
        path.join("/custom/emu", "avd")
      );

      // resolveExecutable finds project-local gradlew.bat on win32
      fs.writeFileSync(path.join(winDir, "gradlew.bat"), "@echo off\r\n", "utf8");
      const resolvedLocalBare = resolveExecutable("gradlew", { PATH: "" }, winDir, "win32");
      assert.equal(resolvedLocalBare.isBatch, true);
      assert.equal(resolvedLocalBare.executable, path.join(winDir, "gradlew.bat"));
      const resolvedLocalRel = resolveExecutable("./gradlew", { PATH: "" }, winDir, "win32");
      assert.equal(resolvedLocalRel.isBatch, true);
      assert.equal(resolvedLocalRel.executable, path.join(winDir, "gradlew.bat"));

      // Detached runCommandSync catches asynchronous spawn errors and returns non-zero status
      const detachedMissing = runCommandSync("nonexistent_binary_for_atc_test_xyz", [], {
        detached: true,
      });
      assert.notEqual(detachedMissing.status, 0);
      assert.match(detachedMissing.stderr, /ENOENT/);

      // Multi-lease cmdFree accumulates snapshot disk requirements across all matched leases
      withStateTransaction(winDir, (state, { now }) => {
        state.leases["avd:Pixel_8_API_35"] = {
          leaseId: "lease-snap-1",
          deviceKey: "avd:Pixel_8_API_35",
          avd: "Pixel_8_API_35",
          serial: "emulator-5554",
          kind: "emulator",
          state: "active",
          sessionId: "multi-snap-sess",
          saveSnapshotOnFree: "snap-1",
          claimedAtMs: now,
          renewedAtMs: now,
          expiresAtMs: now + 60_000,
        };
        state.leases["avd:Pixel_9_API_36"] = {
          leaseId: "lease-snap-2",
          deviceKey: "avd:Pixel_9_API_36",
          avd: "Pixel_9_API_36",
          serial: "emulator-5556",
          kind: "emulator",
          state: "active",
          sessionId: "multi-snap-sess",
          saveSnapshotOnFree: "snap-2",
          claimedAtMs: now,
          renewedAtMs: now,
          expiresAtMs: now + 60_000,
        };
        return { mutated: true };
      });
      // Each AVD defaults to 2048MB RAM + 2048MB reserve -> 1 snapshot needs 4096MB, 2 need 6144MB
      const multiSnapDiskFail = cmdFree(
        winDir,
        null,
        { session: "multi-snap-sess" },
        { avdHome, host: { freeDiskMb: 5000 } }
      );
      assert.equal(multiSnapDiskFail.exitCode, 5);

      // Serial-keyed unmapped emulator lease prevents re-claiming after AVD mapping recovers and migrates key
      const unmappedLeaseState = createDefaultState();
      unmappedLeaseState.leases["serial:emulator-5554"] = {
        leaseId: "lease-unmapped-serial",
        deviceKey: "serial:emulator-5554",
        avd: null,
        serial: "emulator-5554",
        kind: "emulator",
        state: "active",
        sessionId: "sess-unmapped-owner",
        claimedAtMs: schedNow,
        renewedAtMs: schedNow,
        expiresAtMs: schedNow + 60_000,
      };
      const selWhenMapped = selectCandidateUnderLock(
        unmappedLeaseState,
        schedInventory,
        { kind: "emulator", apiSpec: "35" },
        null,
        schedNow,
      );
      assert.equal(selWhenMapped.priority, null);
      reconcileOfflineLeases(unmappedLeaseState, schedInventory, "sess-other", schedNow);
      assert.equal(unmappedLeaseState.leases["serial:emulator-5554"], undefined);
      assert.equal(unmappedLeaseState.leases["avd:Pixel_8_API_35"].leaseId, "lease-unmapped-serial");

      // Multiple MCP servers under the same parent PID get distinct default session IDs and cannot hijack each other's lease
      const multiMcpDir = makeTempStateDir();
      try {
        const mcpInv = {
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
          running: [
            {
              deviceKey: "avd:Pixel_8_API_35",
              avd: "Pixel_8_API_35",
              serial: "emulator-5554",
              kind: "emulator",
              online: true,
              profile: { deviceType: "phone", apiLevel: "android-35" },
            },
          ],
          offline: [],
          creatable: [],
        };
        const mcp1 = handleMcpRequest(
          multiMcpDir,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "atc_claim", arguments: { api: "35", waitSec: 0 } },
          },
          {
            ppid: process.pid,
            pid: 41001,
            env: {},
            inventory: mcpInv,
            livenessCheck: () => true,
          },
        );
        const mcp1Res = JSON.parse(mcp1.result.content[0].text);
        assert.equal(mcp1Res.exitCode, 0);
        assert.equal(mcp1Res.lease.sessionId, "mcp-41001");
        assert.equal(mcp1Res.lease.anchorPid, 41001);

        const mcp2 = handleMcpRequest(
          multiMcpDir,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "atc_claim", arguments: { api: "35", waitSec: 0 } },
          },
          {
            ppid: process.pid,
            pid: 41002,
            env: {},
            inventory: mcpInv,
            livenessCheck: () => true,
          },
        );
        const mcp2Res = JSON.parse(mcp2.result.content[0].text);
        assert.equal(mcp2Res.exitCode, 2);

        // When MCP server 41001 crashes without close cleanup, its anchorPid is dead so GC reclaims the lease
        const mcp2AfterCrash = handleMcpRequest(
          multiMcpDir,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "atc_claim", arguments: { api: "35", waitSec: 0 } },
          },
          {
            ppid: process.pid,
            pid: 41002,
            env: {},
            inventory: mcpInv,
            livenessCheck: (pid) => pid !== 41001,
          },
        );
        const mcp2AfterCrashRes = JSON.parse(mcp2AfterCrash.result.content[0].text);
        assert.equal(mcp2AfterCrashRes.exitCode, 0);
        assert.equal(mcp2AfterCrashRes.lease.sessionId, "mcp-41002");
      } finally {
        fs.rmSync(multiMcpDir, { recursive: true, force: true });
      }

      // computeUsedEmulatorSlots counts serial-keyed active emulator leases when discovery probes fail
      const unmappedSlotState = createDefaultState();
      unmappedSlotState.leases["serial:emulator-5554"] = {
        leaseId: "lease-unmapped-slot",
        deviceKey: "serial:emulator-5554",
        avd: null,
        serial: "emulator-5554",
        kind: "emulator",
        state: "active",
        sessionId: "sess-1",
      };
      assert.equal(computeUsedEmulatorSlots(unmappedSlotState, { running: [] }), 1);

      // readLocalAvdMetadata interprets unitless disk.dataPartition.size as bytes
      const bytePartitionAvdDir = path.join(avdHome, "Byte_Partition_API_35.avd");
      fs.mkdirSync(bytePartitionAvdDir, { recursive: true });
      fs.writeFileSync(
        path.join(bytePartitionAvdDir, "config.ini"),
        "hw.ramSize=2048\ndisk.dataPartition.size=6442450944\nsdcard.size=536870912\n",
        "utf8",
      );
      const byteAvdMeta = readLocalAvdMetadata("Byte_Partition_API_35", avdHome);
      assert.equal(byteAvdMeta.ramSizeMb, 2048);
      assert.equal(byteAvdMeta.dataDiskMb, 6144 + 512);

      // parseAndroidEmulatorListOutput checks the status column rather than substring "online" in AVD name
      const parsedOnlineNamedAvd = parseAndroidEmulatorListOutput(
        "AVD                 Status    Serial          API\nOnline_Test_API_35  offline   -               android-35\n",
      );
      assert.equal(parsedOnlineNamedAvd.length, 1);
      assert.equal(parsedOnlineNamedAvd[0].avd, "Online_Test_API_35");
      assert.equal(parsedOnlineNamedAvd[0].online, false);

      // GC preserves active lease while an in-flight exec workerPid is alive even if anchorPid exited
      const execAliveState = createDefaultState();
      const nowExec = Date.now();
      execAliveState.leases["avd:Pixel_8_API_35"] = {
        leaseId: "lease-exec-alive",
        deviceKey: "avd:Pixel_8_API_35",
        avd: "Pixel_8_API_35",
        serial: "emulator-5554",
        kind: "emulator",
        state: "active",
        sessionId: "sess-exec",
        anchorPid: 99001,
        workerPid: 99002,
        claimedAtMs: nowExec,
        renewedAtMs: nowExec,
        expiresAtMs: nowExec + 60_000,
      };
      runGarbageCollection(execAliveState, null, nowExec, (pid) => pid === 99002);
      assert.ok(execAliveState.leases["avd:Pixel_8_API_35"]);
      runGarbageCollection(execAliveState, null, nowExec, () => false);
      assert.equal(execAliveState.leases["avd:Pixel_8_API_35"], undefined);

      // Device commands invalidate loadedSnapshot, and idempotent re-claim with --snapshot-load reloads the snapshot
      const snapReloadDir = makeTempStateDir();
      try {
        const snapInv = {
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
          running: [
            {
              deviceKey: "avd:Pixel_8_API_35",
              avd: "Pixel_8_API_35",
              serial: "emulator-5554",
              kind: "emulator",
              online: true,
              snapshots: ["clean-base"],
              profile: { deviceType: "phone", apiLevel: "android-35" },
            },
          ],
          offline: [],
          creatable: [],
        };
        const snapCalls = [];
        const snapRunner = (cmd, args) => {
          snapCalls.push([cmd, ...args].join(" "));
          if (cmd === "adb" && args.includes("getprop")) {
            return { status: 0, stdout: "1\n", stderr: "" };
          }
          return { status: 0, stdout: "OK", stderr: "" };
        };
        const c1 = cmdClaim(
          snapReloadDir,
          { session: "snap-sess", api: "35", snapshotLoad: "clean-base" },
          { inventory: snapInv, runner: snapRunner },
        );
        assert.equal(c1.exitCode, 0);
        assert.equal(readState(snapReloadDir).leases["avd:Pixel_8_API_35"].loadedSnapshot, "clean-base");

        // A mutating typed device op (android clearData) invalidates loadedSnapshot
        if (process.platform !== "win32") {
          const clearEnv = makeFakeToolEnv(snapReloadDir, { adb: "exit 0" });
          const clearRes = await cmdExec(
            snapReloadDir,
            ["android", "clearData", "com.example.app", "--session", "snap-sess", "--json"],
            { env: clearEnv, inventory: snapInv },
          );
          assert.equal(clearRes.exitCode, 0, clearRes.error);
          assert.equal(readState(snapReloadDir).leases["avd:Pixel_8_API_35"].loadedSnapshot, null);
        }

        // Re-claiming with --snapshot-load restores the snapshot again (only after the
        // mutating op above invalidated it, which needs the POSIX fake adb)
        if (process.platform !== "win32") {
          snapCalls.length = 0;
          const c2 = cmdClaim(
            snapReloadDir,
            { session: "snap-sess", api: "35", snapshotLoad: "clean-base" },
            { inventory: snapInv, runner: snapRunner },
          );
          assert.equal(c2.exitCode, 0);
          assert.equal(c2.idempotent, true);
          assert.ok(snapCalls.includes("adb -s emulator-5554 emu avd snapshot load clean-base"));
          assert.equal(readState(snapReloadDir).leases["avd:Pixel_8_API_35"].loadedSnapshot, "clean-base");
        }
      } finally {
        fs.rmSync(snapReloadDir, { recursive: true, force: true });
      }

      // parseAndroidEmulatorListOutput parses 5-column `android emulator list --long` output (AVD ID, Name, API, Status, Serial)
      const longListParsed = parseAndroidEmulatorListOutput(
        "myphone  Medium Phone  android-34  Online  emulator-5554\nOnline_Test  Online Test  android-35  Offline  -\n",
      );
      assert.equal(longListParsed.length, 2);
      assert.equal(longListParsed[0].avd, "myphone");
      assert.equal(longListParsed[0].online, true);
      assert.equal(longListParsed[0].serial, "emulator-5554");
      assert.equal(longListParsed[0].apiLevel, "android-34");
      assert.equal(longListParsed[1].avd, "Online_Test");
      assert.equal(longListParsed[1].online, false);

      // parseCliArgs and command handlers parse `--wipe-data=false`, `--stop=false`, `--force=false` as false
      const parsedBoolFalse = parseCliArgs([
        "claim",
        "--wipe-data=false",
        "--cold=false",
        "--force=false",
        "--stop=false",
      ]);
      assert.equal(parsedBoolFalse.flags.wipeData, false);
      assert.equal(parsedBoolFalse.flags.cold, false);
      assert.equal(parsedBoolFalse.flags.force, false);
      assert.equal(parsedBoolFalse.flags.stop, false);

      // Idempotent re-claim preserves an existing live exec workerPid even if anchorPid later exits
      const workerKeepDir = makeTempStateDir();
      try {
        const workerInv = {
          running: [
            {
              deviceKey: "avd:Pixel_8_API_35",
              kind: "emulator",
              avd: "Pixel_8_API_35",
              serial: "emulator-5554",
              online: true,
              profile: { deviceType: "phone", apiLevel: "android-35", numericApi: 35, hasPlayStore: true },
              snapshots: ["clean-base"],
            },
          ],
          offline: [],
          creatable: [],
        };
        let anchorAlive = true;
        let execWorkerAlive = true;
        const liveness = (pid) => {
          if (pid === 71001) return anchorAlive;
          if (pid === 71002) return execWorkerAlive;
          if (pid === process.pid) return true;
          return false;
        };
        const wc1 = cmdClaim(
          workerKeepDir,
          { session: "worker-keep-sess", anchorPid: 71001, api: "35" },
          { inventory: workerInv, livenessCheck: liveness },
        );
        assert.equal(wc1.exitCode, 0);
        withStateTransaction(
          workerKeepDir,
          (state) => {
            const lease = state.leases["avd:Pixel_8_API_35"];
            lease.workerPid = 71002;
            lease.workerPids = [71002];
            return { mutated: true };
          },
          { livenessCheck: liveness },
        );

        // Plain idempotent re-claim does not clear the live exec worker (71002)
        const wc2 = cmdClaim(
          workerKeepDir,
          { session: "worker-keep-sess", anchorPid: 71001, api: "35" },
          { inventory: workerInv, livenessCheck: liveness },
        );
        assert.equal(wc2.exitCode, 0);
        assert.equal(wc2.idempotent, true);
        assert.equal(readState(workerKeepDir).leases["avd:Pixel_8_API_35"].workerPid, 71002);

        // Even when anchor exits, plain idempotent re-claim keeps the lease alive while 71002 is alive,
        // whereas destructive prep (--reset-app / snapshot load) refuses to run while 71002 is active
        anchorAlive = false;
        const wc3Plain = cmdClaim(
          workerKeepDir,
          { session: "worker-keep-sess", anchorPid: 71001, api: "35" },
          { inventory: workerInv, livenessCheck: liveness },
        );
        assert.equal(wc3Plain.exitCode, 0);
        assert.ok(readState(workerKeepDir).leases["avd:Pixel_8_API_35"]);
        assert.equal(readState(workerKeepDir).leases["avd:Pixel_8_API_35"].workerPid, 71002);

        const wc3BusyPrep = cmdClaim(
          workerKeepDir,
          {
            session: "worker-keep-sess",
            anchorPid: 71001,
            api: "35",
            resetApp: "com.example.app",
            wait: 0,
          },
          {
            inventory: workerInv,
            livenessCheck: liveness,
            runner: () => {
              throw new Error("Should not reset app while worker 71002 is alive");
            },
          },
        );
        assert.equal(wc3BusyPrep.exitCode, 2);
        assert.ok(readState(workerKeepDir).leases["avd:Pixel_8_API_35"]);
        assert.equal(readState(workerKeepDir).leases["avd:Pixel_8_API_35"].workerPid, 71002);

        const snapBusyLoad = cmdSnapshot(
          workerKeepDir,
          "load",
          "clean_boot",
          { session: "worker-keep-sess" },
          {
            livenessCheck: liveness,
            runner: () => {
              throw new Error("Should not load snapshot while worker 71002 is alive");
            },
          },
        );
        assert.equal(snapBusyLoad.exitCode, 3);
        assert.match(snapBusyLoad.error, /active in-flight worker/);

        // cmdFree (both plain and with --stop) preserves the lease while registered worker 71002 is alive
        const freeWhileBusy = cmdFree(
          workerKeepDir,
          null,
          { session: "worker-keep-sess", stop: true },
          {
            livenessCheck: liveness,
            runner: () => {
              throw new Error("Should not stop emulator while worker 71002 is alive");
            },
          },
        );
        assert.equal(freeWhileBusy.exitCode, 3);
        assert.ok(readState(workerKeepDir).leases["avd:Pixel_8_API_35"]);
        assert.equal(readState(workerKeepDir).leases["avd:Pixel_8_API_35"].state, "active");
        assert.equal(readState(workerKeepDir).leases["avd:Pixel_8_API_35"].workerPid, 71002);

        // Even when now advances beyond maxTtlSec while worker 71002 is alive, GC does not expire the lease
        withStateTransaction(
          workerKeepDir,
          (state) => {
            state.config.maxTtlSec = 10;
            state.config.defaultTtlSec = 10;
            return { mutated: true };
          },
          { livenessCheck: liveness },
        );
        withStateTransaction(workerKeepDir, () => ({ mutated: false }), {
          livenessCheck: liveness,
          now: Date.now() + 120_000,
        });
        assert.ok(readState(workerKeepDir).leases["avd:Pixel_8_API_35"]);

        // Once the exec worker also exits, GC prunes the dead-anchor / deferred-free lease
        execWorkerAlive = false;
        withStateTransaction(workerKeepDir, () => ({ mutated: false }), {
          livenessCheck: liveness,
        });
        assert.equal(readState(workerKeepDir).leases["avd:Pixel_8_API_35"], undefined);
      } finally {
        fs.rmSync(workerKeepDir, { recursive: true, force: true });
      }

      // Windows resolveExecutable and buildSpawnConfig treat npm `atc` shim as batch (.cmd) launched via cmd.exe
      const fakeNpmBin = path.join(winDir, "npm-bin");
      fs.mkdirSync(fakeNpmBin, { recursive: true });
      const fakeAtcShim = path.join(fakeNpmBin, "atc.cmd");
      fs.writeFileSync(fakeAtcShim, "@echo off\r\n", "utf8");
      const winAtcResolved = resolveExecutable("atc", { PATH: fakeNpmBin }, winDir, "win32");
      assert.equal(winAtcResolved.isBatch, true);
      assert.equal(winAtcResolved.executable, fakeAtcShim);
      const winAtcSpawn = buildSpawnConfig("atc", ["free", "--session", "pi-1"], {
        env: { PATH: fakeNpmBin, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        cwd: winDir,
        platform: "win32",
      });
      assert.equal(winAtcSpawn.command, "C:\\Windows\\System32\\cmd.exe");
      assert.equal(winAtcSpawn.options.windowsVerbatimArguments, true);

      // Wrapper-launched invocations (`npx atc ...` / `sh -c ...`) anchor to the stable parent shell PID
      const npxDir = makeTempStateDir();
      try {
        const npxInv = {
          running: [
            {
              deviceKey: "avd:Pixel_8_API_35",
              kind: "emulator",
              avd: "Pixel_8_API_35",
              serial: "emulator-5554",
              online: true,
              profile: { deviceType: "phone", apiLevel: "android-35", numericApi: 35, hasPlayStore: true },
              snapshots: [],
            },
          ],
          offline: [],
          creatable: [],
        };
        const npxClaim = cmdClaim(
          npxDir,
          { api: "35" },
          {
            env: {},
            ppid: 88001,
            ancestorPids: [88001, 88000, 5050],
            processChain: [
              { pid: 88001, ppid: 88000, comm: "node", args: "node /usr/local/bin/npx-cli.js atc claim" },
              { pid: 88000, ppid: 5050, comm: "sh", args: "sh -c npx atc claim" },
              { pid: 5050, ppid: 1, comm: "-zsh", args: "-zsh" },
            ],
            inventory: npxInv,
            livenessCheck: (pid) => pid === 5050,
          },
        );
        assert.equal(npxClaim.exitCode, 0);
        assert.equal(npxClaim.lease.sessionId, "ppid-5050");
        assert.equal(npxClaim.lease.anchorPid, 5050);

        // Next `npx atc renew` with a new transient npx PID (88002, while 88001 is dead) retains and renews the lease
        const npxRenew = cmdRenew(
          npxDir,
          null,
          {},
          {
            env: {},
            ppid: 88002,
            ancestorPids: [88002, 5050],
            processChain: [
              { pid: 88002, ppid: 5050, comm: "npx", args: "npx atc renew" },
              { pid: 5050, ppid: 1, comm: "-zsh", args: "-zsh" },
            ],
            livenessCheck: (pid) => pid === 5050,
          },
        );
        assert.equal(npxRenew.exitCode, 0);
        assert.equal(npxRenew.lease.leaseId, npxClaim.lease.leaseId);

        // Non-owner `claim --wait 0` persists firstSeenOfflineAtMs so a subsequent non-blocking claim after grace period succeeds
        const offlineInvForReconcile = {
          running: [],
          offline: [
            {
              deviceKey: "avd:Pixel_8_API_35",
              kind: "emulator",
              avd: "Pixel_8_API_35",
              serial: null,
              online: false,
              profile: { deviceType: "phone", apiLevel: "android-35", numericApi: 35, hasPlayStore: true },
              snapshots: [],
            },
          ],
          creatable: [
            {
              kind: "emulator",
              deviceName: "medium_phone",
              profile: { deviceType: "phone", deviceName: "medium_phone", apiLevel: null, services: null, playStore: null, abi: null },
            },
          ],
          probes: { emulatorListOk: true, adbDevicesOk: true },
        };
        const t0 = Date.now();
        const busyFirst = cmdClaim(
          npxDir,
          { session: "other-sess", api: "35", wait: 0 },
          { inventory: offlineInvForReconcile, now: t0, livenessCheck: () => true },
        );
        assert.equal(busyFirst.exitCode, 2);
        assert.equal(readState(npxDir).leases["avd:Pixel_8_API_35"].firstSeenOfflineAtMs, t0);

        // Bare hardware profile without API/services/ABI metadata does not match explicit --api / --services / --abi in --create-if-missing
        const noBlindCreate = cmdClaim(
          npxDir,
          { session: "other-sess", api: "35", services: "aosp", abi: "x86_64", createIfMissing: true, wait: 0 },
          { inventory: offlineInvForReconcile, now: t0, livenessCheck: () => true },
        );
        assert.equal(noBlindCreate.exitCode, 2);

        // matchesProfile rejects physical devices when emulator-only flags like --snapshot-load are requested
        assert.equal(
          matchesProfile(
            { kind: "physical", serial: "R58N123456A", profile: { deviceType: "phone", apiLevel: "android-35" } },
            { kind: "any", serial: "R58N123456A", snapshotLoad: "clean-base" },
          ),
          false,
        );

        // cmdFree restores the lease to active if a snapshot/stop runner throws an exception
        withStateTransaction(
          npxDir,
          (s) => {
            s.leases["avd:Pixel_8_API_35"].firstSeenOfflineAtMs = null;
            s.leases["avd:Pixel_8_API_35"].serial = "emulator-5554";
            return { mutated: true };
          },
          { livenessCheck: () => true },
        );
        const freeThrown = cmdFree(
          npxDir,
          npxClaim.lease.leaseId,
          { session: "ppid-5050", stop: true },
          {
            livenessCheck: () => true,
            runner: () => {
              throw new Error("Runner threw during stop");
            },
          },
        );
        assert.equal(freeThrown.exitCode, 1);
        assert.deepEqual(freeThrown.freed, []);
        assert.equal(readState(npxDir).leases["avd:Pixel_8_API_35"].state, "active");

        // Typed-op child invocations get the lease serial injected as ANDROID_SERIAL (argv untouched)
        const npxLease = readState(npxDir).leases["avd:Pixel_8_API_35"];
        const npxPrepared = prepareOpChildInvocation(
          { cmd: "adb", args: ["-s", npxLease.serial, "get-state"] },
          { lease: npxLease, sessionId: "ppid-5050", baseEnv: { ATC_BUILD_OP_ID: "stale" } },
        );
        assert.equal(npxPrepared.env.ANDROID_SERIAL, "emulator-5554");
        assert.equal(npxPrepared.env.ATC_DEVICE_SERIAL, "emulator-5554");
        assert.equal(npxPrepared.env.ATC_LEASE_ID, npxLease.leaseId);
        assert.equal(npxPrepared.env.ATC_SESSION_ID, "ppid-5050");
        assert.equal(npxPrepared.env.ATC_BUILD_OP_ID, undefined);
        assert.deepEqual(npxPrepared.args, ["-s", "emulator-5554", "get-state"]);

        // Cold restart of online emulator honors configured stopTimeoutSec on both POSIX and Windows
        const stopTimeoutDir = makeTempStateDir();
        try {
          const customState = readState(stopTimeoutDir);
          customState.config.stopTimeoutSec = 95;
          fs.writeFileSync(path.join(stopTimeoutDir, "state.json"), JSON.stringify(customState));
          for (const testPlatform of ["darwin", "win32"]) {
            let capturedStopTimeoutMs = null;
            let winKilled = false;
            const coldRestartRes = cmdClaim(
              stopTimeoutDir,
              { session: `cold-sess-${testPlatform}`, avd: "Pixel_8_API_35", cold: true, force: true, wait: 0 },
              {
                platform: testPlatform,
                inventory: npxInv,
                runner: (cmd, args, opts) => {
                  if (
                    (cmd === "android" && args[0] === "emulator" && args[1] === "stop") ||
                    (cmd === "adb" && args.includes("emu") && args.includes("kill"))
                  ) {
                    capturedStopTimeoutMs = opts?.timeoutMs;
                    winKilled = true;
                    return { status: 0, stdout: "", stderr: "" };
                  }
                  if (
                    (cmd === "android" && args[0] === "emulator" && args[1] === "start") ||
                    cmd === "emulator"
                  ) {
                    winKilled = false;
                    return { status: 0, stdout: JSON.stringify({ serial: "emulator-5554" }), stderr: "" };
                  }
                  if (cmd === "adb" && args[0] === "devices") {
                    return {
                      status: 0,
                      stdout: winKilled
                        ? "List of devices attached\n"
                        : "List of devices attached\nemulator-5554\tdevice\n",
                      stderr: "",
                    };
                  }
                  if (cmd === "adb") {
                    return { status: 0, stdout: "1\n", stderr: "" };
                  }
                  return { status: 0, stdout: "", stderr: "" };
                },
              },
            );
            assert.equal(coldRestartRes.exitCode, 0);
            assert.equal(capturedStopTimeoutMs, 95_000);
            cmdFree(stopTimeoutDir, coldRestartRes.lease.leaseId, { session: `cold-sess-${testPlatform}` });
          }

          // 3. Preserve destination lease if another session concurrently reserves the created AVD key during key migration
          const collisionDir = makeTempStateDir();
          try {
            const createOnlyInv = {
              running: [],
              offline: [],
              creatable: [
                {
                  kind: "emulator",
                  deviceName: "pixel_9",
                  profile: {
                    deviceType: "phone",
                    deviceName: "pixel_9",
                    apiLevel: "android-35",
                    numericApi: 35,
                    services: "google_apis",
                    playStore: false,
                    abi: "arm64-v8a",
                  },
                },
              ],
            };
            const colRes = cmdClaim(
              collisionDir,
              { session: "creator-sess", type: "phone", api: "35", createIfMissing: true, force: true, wait: 0 },
              {
                avdHome,
                inventory: createOnlyInv,
                runner: (cmd, args) => {
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "create") {
                    // Simulate another session reserving avd:Pixel_9_API_35 while create was running outside the lock
                    const st = readState(collisionDir);
                    st.leases["avd:Pixel_9_API_35"] = {
                      leaseId: "lease_other_session",
                      sessionId: "other-session",
                      state: "starting",
                      kind: "emulator",
                      avd: "Pixel_9_API_35",
                      deviceKey: "avd:Pixel_9_API_35",
                      workerPid: process.pid,
                      deadlineMs: Date.now() + 60_000,
                    };
                    fs.writeFileSync(path.join(collisionDir, "state.json"), JSON.stringify(st));
                    return { status: 0, stdout: "Created AVD 'Pixel_9_API_35'\n", stderr: "" };
                  }
                  return { status: 0, stdout: "", stderr: "" };
                },
              },
            );
            assert.equal(colRes.exitCode, 1);
            assert.match(colRes.error, /concurrently reserved by another session/);
            const postCollisionState = readState(collisionDir);
            assert.equal(postCollisionState.leases["avd:Pixel_9_API_35"]?.leaseId, "lease_other_session");
            assert.equal(postCollisionState.leases["avd:pixel_9"], undefined);
          } finally {
            fs.rmSync(collisionDir, { recursive: true, force: true });
          }

          // 4. POSIX emulator start keeps polling discoverFleet when serial appears on second refresh
          const posixPollDir = makeTempStateDir();
          try {
            let listCalls = 0;
            const posixPollRes = cmdClaim(
              posixPollDir,
              { session: "posix-poll-sess", avd: "Pixel_8_API_35", force: true, wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  running: [],
                  offline: [
                    {
                      deviceKey: "avd:Pixel_8_API_35",
                      kind: "emulator",
                      avd: "Pixel_8_API_35",
                      serial: null,
                      online: false,
                      profile: { deviceType: "phone", apiLevel: "android-35", numericApi: 35, hasPlayStore: true },
                      snapshots: [],
                    },
                  ],
                  creatable: [],
                },
                runner: (cmd, args) => {
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    // Return without printing emulator-<port> so serial discovery must poll discoverFleet
                    return { status: 0, stdout: "Started successfully\n", stderr: "" };
                  }
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
                    listCalls += 1;
                    if (listCalls === 1) {
                      return {
                        status: 0,
                        stdout: "AVD                 Status    Serial          API\nPixel_8_API_35      offline   -               android-35\n",
                        stderr: "",
                      };
                    }
                    return {
                      status: 0,
                      stdout: "AVD                 Status    Serial          API\nPixel_8_API_35      online    emulator-5554   android-35\n",
                      stderr: "",
                    };
                  }
                  if (cmd === "adb" && args[0] === "devices") {
                    return {
                      status: 0,
                      stdout:
                        listCalls >= 2
                          ? "List of devices attached\nemulator-5554\tdevice\n"
                          : "List of devices attached\n",
                      stderr: "",
                    };
                  }
                  return { status: 0, stdout: "", stderr: "" };
                },
              },
            );
            assert.equal(posixPollRes.exitCode, 0);
            assert.equal(posixPollRes.lease.serial, "emulator-5554");
            assert.ok(listCalls >= 2);
          } finally {
            fs.rmSync(posixPollDir, { recursive: true, force: true });
          }

          // 5. parseAndroidEmulatorListOutput preserves AVD identifiers starting with "AVD" while skipping the header row
          const avdPrefixList = parseAndroidEmulatorListOutput(
            "AVD                 Status    Serial          API\nAVD_Pixel_9         online    emulator-5558   android-36\n",
          );
          assert.equal(avdPrefixList.length, 1);
          assert.equal(avdPrefixList[0].avd, "AVD_Pixel_9");
          assert.equal(avdPrefixList[0].online, true);
          assert.equal(avdPrefixList[0].serial, "emulator-5558");

          // 6. starting/stopping transition reservations with a future deadlineMs are retained until deadlineMs expires even if workerPid is dead
          const orphanTransState = createDefaultState();
          const tTrans = 1_700_000_000_000;
          orphanTransState.leases["avd:Pixel_8_API_35"] = {
            leaseId: "lease-orphan-starting",
            deviceKey: "avd:Pixel_8_API_35",
            avd: "Pixel_8_API_35",
            kind: "emulator",
            state: "starting",
            sessionId: "sess-orphan",
            workerPid: 99999999,
            claimedAtMs: tTrans,
            deadlineMs: tTrans + 60_000,
          };
          const prunedBeforeDeadline = runGarbageCollection(
            orphanTransState,
            null,
            tTrans + 10_000,
            () => false,
          );
          assert.equal(prunedBeforeDeadline.leases.length, 0);
          assert.ok(orphanTransState.leases["avd:Pixel_8_API_35"]);

          const prunedAfterDeadline = runGarbageCollection(
            orphanTransState,
            null,
            tTrans + 60_000,
            () => false,
          );
          assert.equal(prunedAfterDeadline.leases.length, 1);
          assert.equal(prunedAfterDeadline.leases[0].reason, "deadline_exceeded");
          assert.equal(orphanTransState.leases["avd:Pixel_8_API_35"], undefined);

          // 7. `atc free --help` / `atc free -h` short-circuits help without releasing active leases
          const helpDir = makeTempStateDir();
          try {
            const helpClaim = cmdClaim(
              helpDir,
              { session: "help-sess", api: "35" },
              { inventory: npxInv },
            );
            assert.equal(helpClaim.exitCode, 0);
            const helpExit1 = await runCli(["free", "--help"], {
              ...process.env,
              ATC_STATE_DIR: helpDir,
              ATC_SESSION_ID: "help-sess",
            });
            assert.equal(helpExit1, 0);
            const helpExit2 = await runCli(["free", "-h"], {
              ...process.env,
              ATC_STATE_DIR: helpDir,
              ATC_SESSION_ID: "help-sess",
            });
            assert.equal(helpExit2, 0);
            const unknownExit = await runCli(["fre", "--stop"], {
              ...process.env,
              ATC_STATE_DIR: helpDir,
              ATC_SESSION_ID: "help-sess",
            });
            assert.equal(unknownExit, 1);
            assert.ok(readState(helpDir).leases["avd:Pixel_8_API_35"]);
          } finally {
            fs.rmSync(helpDir, { recursive: true, force: true });
          }

          // 8. reconcileOfflineLeases preserves offline leases while registered workers remain alive
          const offlineWorkerState = createDefaultState();
          offlineWorkerState.leases["phys:R58N123456A"] = {
            leaseId: "lease-rebooting-phys",
            deviceKey: "phys:R58N123456A",
            serial: "R58N123456A",
            kind: "physical",
            state: "active",
            sessionId: "sess-reboot",
            workerPid: 77001,
            workerPids: [77001],
            firstSeenOfflineAtMs: tTrans - 30_000,
          };
          reconcileOfflineLeases(
            offlineWorkerState,
            { running: [], offline: [], onlineSerials: [], probes: { emulatorListOk: true, adbDevicesOk: true } },
            "other-sess",
            tTrans,
            (pid) => pid === 77001,
          );
          assert.ok(offlineWorkerState.leases["phys:R58N123456A"]);

          // Once worker exits, offline reconciliation after graceMs deletes the lease
          reconcileOfflineLeases(
            offlineWorkerState,
            { running: [], offline: [], onlineSerials: [], probes: { emulatorListOk: true, adbDevicesOk: true } },
            "other-sess",
            tTrans,
            () => false,
          );
          assert.equal(offlineWorkerState.leases["phys:R58N123456A"], undefined);

          // 11. parseAndroidEmulatorListOutput skips `AVD ID  AVD Name  API Level  Status  Serial` long-list header
          const longHeaderParsed = parseAndroidEmulatorListOutput(
            "AVD ID              AVD Name            API Level  Status    Serial\nPixel_8_API_35      Pixel 8 API 35      35         offline   -\n",
          );
          assert.equal(longHeaderParsed.length, 1);
          assert.equal(longHeaderParsed[0].avd, "Pixel_8_API_35");
          assert.equal(longHeaderParsed[0].online, false);

          // 12. Cold restart of an online AVD clears the stale serial and rediscovers the new emulator port when stdout omits the serial
          const coldRediscoverDir = makeTempStateDir();
          try {
            const coldRediscoverRes = cmdClaim(
              coldRediscoverDir,
              { session: "cold-rediscover", avd: "Pixel_8_API_35", cold: true, force: true, wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: npxInv,
                runner: (cmd, args) => {
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
                    return { status: 0, stdout: "", stderr: "" };
                  }
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    // Omit serial from stdout so it must be rediscovered from fleet
                    return { status: 0, stdout: "Started Pixel_8_API_35\n", stderr: "" };
                  }
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
                    return {
                      status: 0,
                      stdout: "AVD                 Status    Serial          API\nPixel_8_API_35      online    emulator-5558   android-35\n",
                      stderr: "",
                    };
                  }
                  if (cmd === "adb" && args[0] === "devices") {
                    return {
                      status: 0,
                      stdout: "List of devices attached\nemulator-5558\tdevice\n",
                      stderr: "",
                    };
                  }
                  return { status: 0, stdout: "", stderr: "" };
                },
              },
            );
            assert.equal(coldRediscoverRes.exitCode, 0);
            assert.equal(coldRediscoverRes.lease.serial, "emulator-5558");

            // 13. `atc exec` heartbeats do not shorten a long lease TTL (e.g. 3600s) down to defaultTtlSec (600s)
            const renewLong = cmdRenew(coldRediscoverDir, coldRediscoverRes.lease.leaseId, {
              session: "cold-rediscover",
              ttl: 3600,
            });
            assert.equal(renewLong.exitCode, 0);
            const longExpiresAt = renewLong.lease.expiresAtMs;
            const fakeAdbEnv = makeFakeToolEnv(coldRediscoverDir, { adb: "exit 0" });
            const execLongRes = await cmdExec(
              coldRediscoverDir,
              ["android", "logcat", "--session", "cold-rediscover", "--json"],
              { env: fakeAdbEnv },
            );
            assert.equal(execLongRes.exitCode, 0, execLongRes.error);
            assert.ok(readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"].expiresAtMs >= longExpiresAt);

            // 15. Unknown options (e.g., --wipe-dtaa, --snapshot-laod, --stpo) are rejected instead of silently ignored
            const badClaimFlag1 = cmdClaim(coldRediscoverDir, {
              session: "cold-rediscover",
              wipeDtaa: true,
            });
            assert.equal(badClaimFlag1.exitCode, 1);
            assert.match(badClaimFlag1.error, /Unknown option "--wipe-dtaa" for "atc claim"/);

            const badClaimFlag2 = await runCli(["claim", "--snapshot-laod", "clean"], {
              ...process.env,
              ATC_STATE_DIR: coldRediscoverDir,
              ATC_SESSION_ID: "cold-rediscover",
            });
            assert.equal(badClaimFlag2, 1);

            const badFreeFlag = cmdFree(coldRediscoverDir, null, {
              session: "cold-rediscover",
              stpo: true,
            });
            assert.equal(badFreeFlag.exitCode, 1);
            assert.match(badFreeFlag.error, /Unknown option "--stpo" for "atc free"/);

            // 16. Deferred cleanup on worker exit executes pending snapshot-save and stop before dropping lease
            withStateTransaction(coldRediscoverDir, (state) => {
              const cur = state.leases["avd:Pixel_8_API_35"];
              cur.workerPids = [999001];
              cur.workerPid = 999001;
              return { mutated: true };
            }, { livenessCheck: (pid) => pid === 999001 || pid === process.pid });

            const busyDeferRes = cmdFree(
              coldRediscoverDir,
              null,
              {
                session: "cold-rediscover",
                snapshotSave: "deferred-snap",
                stop: true,
              },
              {
                livenessCheck: (pid) => pid === 999001 || pid === process.pid,
              },
            );
            assert.equal(busyDeferRes.exitCode, 3);
            assert.equal(readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"].releaseOnWorkerExit, true);
            assert.equal(readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"].pendingSnapshotSave, "deferred-snap");
            assert.equal(readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"].pendingStop, true);

            const deferredCalls = [];
            let worker999Checks = 0;
            const execFinishRes = await cmdExec(
              coldRediscoverDir,
              ["android", "logcat", "--session", "cold-rediscover", "--json"],
              {
                env: fakeAdbEnv,
                platform: "darwin",
                avdHome,
                host: { freeDiskMb: 16384 },
                livenessCheck: (pid) => {
                  if (pid === 999001) {
                    return worker999Checks++ < 2;
                  }
                  return pid === process.pid;
                },
                runner: (cmd, args) => {
                  deferredCalls.push([cmd, ...args].join(" "));
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(execFinishRes.exitCode, 0, execFinishRes.error);
            assert.ok(
              deferredCalls.some((c) => c === "adb -s emulator-5558 emu avd snapshot save deferred-snap"),
              `Expected deferred snapshot save, got: ${JSON.stringify(deferredCalls)}`,
            );
            assert.ok(
              deferredCalls.some((c) => c === "android emulator stop emulator-5558"),
              `Expected deferred emulator stop, got: ${JSON.stringify(deferredCalls)}`,
            );
            assert.equal(readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"], undefined);

            // 17. resolveExecutable("atc", ...) fails instead of falling back to a bare atc.cmd that cmd.exe would resolve in cwd
            const untrustedRepoDir = makeTempStateDir();
            try {
              const repoAtcCmd = path.join(untrustedRepoDir, "atc.cmd");
              fs.writeFileSync(repoAtcCmd, "@echo off\r\necho hacked\r\n");
              assert.throws(
                () =>
                  resolveExecutable(
                    "atc",
                    { PATH: "", APPDATA: untrustedRepoDir, LOCALAPPDATA: untrustedRepoDir },
                    untrustedRepoDir,
                    "win32",
                  ),
                /Executable not found in PATH/,
              );
              assert.throws(
                () =>
                  buildSpawnConfig("atc", ["status"], {
                    env: { PATH: "", APPDATA: untrustedRepoDir, LOCALAPPDATA: untrustedRepoDir },
                    cwd: untrustedRepoDir,
                    platform: "win32",
                  }),
                /Executable not found in PATH/,
              );
            } finally {
              fs.rmSync(untrustedRepoDir, { recursive: true, force: true });
            }

            // 18. reconcileOfflineLeases preserves destination lease when serial:<serial> maps to an occupied avd:<name>
            const reconcileCollisionState = createDefaultState();
            reconcileCollisionState.leases["avd:Pixel_8_API_35"] = {
              leaseId: "lease_dest",
              deviceKey: "avd:Pixel_8_API_35",
              kind: "emulator",
              avd: "Pixel_8_API_35",
              serial: null,
              sessionId: "dest-sess",
              state: "starting",
              workerPid: process.pid,
              deadlineMs: Date.now() + 60_000,
            };
            reconcileCollisionState.leases["serial:emulator-5558"] = {
              leaseId: "lease_src",
              deviceKey: "serial:emulator-5558",
              kind: "emulator",
              avd: null,
              serial: "emulator-5558",
              sessionId: "src-sess",
              state: "active",
              claimedAtMs: Date.now(),
              renewedAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
              firstSeenOfflineAtMs: null,
            };
            reconcileOfflineLeases(
              reconcileCollisionState,
              {
                running: [
                  {
                    deviceKey: "avd:Pixel_8_API_35",
                    kind: "emulator",
                    avd: "Pixel_8_API_35",
                    serial: "emulator-5558",
                    online: true,
                    profile: { deviceType: "phone", apiLevel: "android-35" },
                  },
                ],
                offline: [],
              },
              "other-sess",
              Date.now(),
            );
            assert.equal(reconcileCollisionState.leases["avd:Pixel_8_API_35"].leaseId, "lease_dest");
            assert.equal(reconcileCollisionState.leases["serial:emulator-5558"], undefined);

            // 19. `atc free --target <lease>` honors `--target` instead of freeing all session leases
            const twoLeaseInv = {
              running: [
                {
                  deviceKey: "avd:Pixel_8_API_35",
                  kind: "emulator",
                  avd: "Pixel_8_API_35",
                  serial: "emulator-5554",
                  online: true,
                  profile: { deviceType: "phone", apiLevel: "android-35" },
                },
                {
                  deviceKey: "avd:Pixel_9_API_36",
                  kind: "emulator",
                  avd: "Pixel_9_API_36",
                  serial: "emulator-5556",
                  online: true,
                  profile: { deviceType: "phone", apiLevel: "android-36" },
                },
              ],
              offline: [],
              creatable: [],
              host: { totalRamMb: 16384, availableRamMb: 8192, freeDiskMb: 16384 },
            };
            const l1 = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_8_API_35" },
              { inventory: twoLeaseInv },
            );
            const l2 = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36" },
              { inventory: twoLeaseInv },
            );
            assert.equal(l1.exitCode, 0);
            assert.equal(l2.exitCode, 0);
            const freeTargetCode = await runCli(["free", "--target", l1.lease.leaseId], {
              ...process.env,
              ATC_STATE_DIR: coldRediscoverDir,
              ATC_SESSION_ID: "target-sess",
            });
            assert.equal(freeTargetCode, 0);
            assert.equal(readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"], undefined);
            assert.ok(readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]);

            // 20. `atc snapshot list --avd <nonexistent>` fails instead of returning an empty snapshot list
            const missingAvdSnap = cmdSnapshot(
              coldRediscoverDir,
              "list",
              null,
              { avd: "Does_Not_Exist_AVD" },
              { avdHome, inventory: twoLeaseInv },
            );
            assert.equal(missingAvdSnap.exitCode, 1);
            assert.match(missingAvdSnap.error, /No emulator found matching AVD "Does_Not_Exist_AVD"/);

            // 22. `atc renew` without `--ttl` preserves an existing later deadline on a long-TTL lease
            const renewSetLong = cmdRenew(coldRediscoverDir, l2.lease.leaseId, {
              session: "target-sess",
              ttl: 3600,
            });
            assert.equal(renewSetLong.exitCode, 0);
            const expectedLongExpiry = renewSetLong.lease.expiresAtMs;
            const renewDefault = cmdRenew(coldRediscoverDir, l2.lease.leaseId, {
              session: "target-sess",
            });
            assert.equal(renewDefault.exitCode, 0);
            assert.ok(renewDefault.lease.expiresAtMs >= expectedLongExpiry);

            // 23. Deferred cleanup failure on worker exit preserves the lease instead of letting GC delete it
            withStateTransaction(
              coldRediscoverDir,
              (state) => {
                const cur = state.leases["avd:Pixel_9_API_36"];
                cur.workerPids = [999002];
                cur.workerPid = 999002;
                return { mutated: true };
              },
              { livenessCheck: (pid) => pid === 999002 || pid === process.pid },
            );
            const deferFailFree = cmdFree(
              coldRediscoverDir,
              l2.lease.leaseId,
              {
                session: "target-sess",
                snapshotSave: "failing-snap",
              },
              {
                livenessCheck: (pid) => pid === 999002 || pid === process.pid,
              },
            );
            assert.equal(deferFailFree.exitCode, 3);
            let worker999002Checks = 0;
            const execDeferredFailRes = await cmdExec(
              coldRediscoverDir,
              ["android", "logcat", "--session", "target-sess", "--json"],
              {
                env: fakeAdbEnv,
                platform: "darwin",
                avdHome,
                host: { freeDiskMb: 16384 },
                livenessCheck: (pid) => {
                  if (pid === 999002) {
                    return worker999002Checks++ < 2;
                  }
                  return pid === process.pid;
                },
                runner: () => ({ status: 1, stdout: "", stderr: "KO: snapshot save failed" }),
              },
            );
            assert.equal(execDeferredFailRes.exitCode, 0, execDeferredFailRes.error);
            const preservedLease = readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"];
            assert.ok(preservedLease, "Lease should be preserved when deferred snapshot save fails");
            assert.equal(preservedLease.state, "active");
            assert.equal(preservedLease.releaseOnWorkerExit, false);

            // 26. Invalid --ttl in cmdClaim/cmdRenew and omitted config set values are rejected
            const invalidRenewTtl = cmdRenew(coldRediscoverDir, l2.lease.leaseId, {
              session: "target-sess",
              ttl: "3600s",
            });
            assert.equal(invalidRenewTtl.exitCode, 1);
            assert.match(invalidRenewTtl.error, /Invalid --ttl duration "3600s"/);

            const invalidClaimTtl = cmdClaim(coldRediscoverDir, {
              session: "target-sess",
              avd: "Pixel_9_API_36",
              ttl: "10m",
            });
            assert.equal(invalidClaimTtl.exitCode, 1);
            assert.match(invalidClaimTtl.error, /Invalid --ttl duration "10m"/);

            const omittedConfigVal = cmdConfig(coldRediscoverDir, "set", "minFreeDiskMb");
            assert.equal(omittedConfigVal.exitCode, 1);
            assert.match(omittedConfigVal.error, /Missing value for config key "minFreeDiskMb"/);
            assert.equal(readState(coldRediscoverDir).config.minFreeDiskMb, 2048);

            // 27. Omitted snapshot option values (boolean true from parseCliArgs) are rejected
            const omittedFreeSnapSave = cmdFree(coldRediscoverDir, l2.lease.leaseId, {
              session: "target-sess",
              snapshotSave: true,
            });
            assert.equal(omittedFreeSnapSave.exitCode, 1);
            assert.match(omittedFreeSnapSave.error, /Invalid snapshot name "true"/);

            const omittedFreeSnapLoad = cmdFree(coldRediscoverDir, l2.lease.leaseId, {
              session: "target-sess",
              snapshotLoad: true,
            });
            assert.equal(omittedFreeSnapLoad.exitCode, 1);
            assert.match(omittedFreeSnapLoad.error, /Invalid snapshot name "true"/);

            // 28. Idempotent re-claim with already-loaded snapshot skips reloading, while a new snapshot loads
            const singleMatchInv = {
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
              running: [
                {
                  deviceKey: "avd:Pixel_9_API_36",
                  avd: "Pixel_9_API_36",
                  serial: "emulator-5556",
                  kind: "emulator",
                  online: true,
                  snapshots: ["clean", "other"],
                  profile: { deviceType: "phone", apiLevel: "android-36" },
                },
              ],
              offline: [],
              creatable: [],
            };
            const snapLoadCmds = [];
            const firstIdempotentLoad = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", snapshotLoad: "clean" },
              {
                inventory: singleMatchInv,
                runner: (cmd, args) => {
                  const full = [cmd, ...args].join(" ");
                  snapLoadCmds.push(full);
                  if (full.includes("sys.boot_completed")) {
                    return { status: 0, stdout: "1\n", stderr: "" };
                  }
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(firstIdempotentLoad.exitCode, 0);
            assert.equal(firstIdempotentLoad.idempotent, true);
            assert.ok(snapLoadCmds.some((c) => c.includes("emu avd snapshot load clean")));

            snapLoadCmds.length = 0;
            const secondIdempotentLoad = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", snapshotLoad: "clean" },
              {
                inventory: singleMatchInv,
                runner: (cmd, args) => {
                  const full = [cmd, ...args].join(" ");
                  snapLoadCmds.push(full);
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(secondIdempotentLoad.exitCode, 0);
            assert.equal(secondIdempotentLoad.idempotent, true);
            assert.equal(snapLoadCmds.length, 0);

            // 29. State-reset reclaim (--cold) on caller's own active lease reboots in-place instead of returning busy, even when an earlier ticket is queued
            withStateTransaction(coldRediscoverDir, (state, { now }) => {
              state.queue.push({
                ticketId: "q_earlier_waiter",
                sessionId: "other-waiter-sess",
                waiterPid: process.pid,
                requestedKind: "emulator",
                requestedAvd: "Pixel_9_API_36",
                requestedSerial: null,
                requestedProfile: { deviceType: "phone", apiSpec: "36" },
                enqueuedAtMs: now - 10_000,
                starvationDeadlineMs: now - 1000,
                lastHeartbeatAtMs: now,
                waitExpiresAtMs: now + 60_000,
              });
              return { mutated: true };
            });
            const coldReclaimCmds = [];
            const coldReclaimRes = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", cold: true, wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: singleMatchInv,
                runner: (cmd, args) => {
                  const full = [cmd, ...args].join(" ");
                  coldReclaimCmds.push(full);
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    return { status: 0, stdout: "Started on emulator-5556\n", stderr: "" };
                  }
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(coldReclaimRes.exitCode, 0);
            assert.equal(coldReclaimRes.lease.leaseId, l2.lease.leaseId);
            assert.ok(coldReclaimCmds.some((c) => c.includes("android emulator stop")));
            assert.ok(coldReclaimCmds.some((c) => c.includes("android emulator start Pixel_9_API_36 --cold")));

            // 30. Explicit non-existent target in cmdFree returns nonzero (exitCode 3)
            const missingFreeRes = cmdFree(coldRediscoverDir, "lease_does_not_exist", {
              session: "target-sess",
            });
            assert.equal(missingFreeRes.exitCode, 3);
            assert.match(missingFreeRes.error, /No matching active lease found for "lease_does_not_exist"/);

            // 31. Failed in-place --cold reclaim restores the caller's original active lease
            const failedColdReclaim = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", cold: true, wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: singleMatchInv,
                runner: () => ({ status: 1, stdout: "", stderr: "stop failed" }),
              },
            );
            assert.equal(failedColdReclaim.exitCode, 1);
            const restoredAfterFail = readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"];
            assert.ok(restoredAfterFail, "Caller's active lease should be restored after failed reset");
            assert.equal(restoredAfterFail.state, "active");
            assert.equal(restoredAfterFail.leaseId, l2.lease.leaseId);
            assert.equal(restoredAfterFail.sessionId, "target-sess");

            // 32. Non-idempotent claim combining --snapshot-load and --reset-app clears loadedSnapshot
            const comboSnapReset = cmdClaim(
              coldRediscoverDir,
              {
                session: "target-sess",
                avd: "Pixel_9_API_36",
                cold: true,
                snapshotLoad: "clean",
                resetApp: "com.example.app",
                wait: 0,
              },
              {
                platform: "darwin",
                avdHome,
                inventory: singleMatchInv,
                runner: (cmd, args) => {
                  const full = [cmd, ...args].join(" ");
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    return { status: 0, stdout: "Started on emulator-5556\n", stderr: "" };
                  }
                  if (full.includes("sys.boot_completed")) {
                    return { status: 0, stdout: "1\n", stderr: "" };
                  }
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(comboSnapReset.exitCode, 0);
            assert.equal(comboSnapReset.lease.loadedSnapshot, null);

            // 33. Invalid boolean config values are rejected
            const invalidBoolCfg = cmdConfig(
              coldRediscoverDir,
              "set",
              "autoStopIdleOnContention",
              "treu",
            );
            assert.equal(invalidBoolCfg.exitCode, 1);
            assert.match(
              invalidBoolCfg.error,
              /Config key "autoStopIdleOnContention" requires a boolean value/,
            );
            assert.equal(readState(coldRediscoverDir).config.autoStopIdleOnContention, true);

            // 34. Deleting the currently loaded snapshot clears lease.loadedSnapshot
            const snapLoadBeforeDel = cmdSnapshot(
              coldRediscoverDir,
              "load",
              "clean",
              { session: "target-sess" },
              {
                avdHome,
                runner: () => ({ status: 0, stdout: "1\n", stderr: "" }),
              },
            );
            assert.equal(snapLoadBeforeDel.exitCode, 0);
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"].loadedSnapshot,
              "clean",
            );
            const snapDelCurrent = cmdSnapshot(
              coldRediscoverDir,
              "delete",
              "clean",
              { session: "target-sess" },
              {
                avdHome,
                runner: () => ({ status: 0, stdout: "OK\n", stderr: "" }),
              },
            );
            assert.equal(snapDelCurrent.exitCode, 0);
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"].loadedSnapshot,
              null,
            );

            // 35. Failed restart after stopping emulator clears stale serial, blocks cmdExec, and allows owner reclaim
            const failedBootAfterStop = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", cold: true, wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: singleMatchInv,
                runner: (cmd, args) => {
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
                    return { status: 0, stdout: "Stopped\n", stderr: "" };
                  }
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    return { status: 1, stdout: "", stderr: "Failed to start" };
                  }
                  return { status: 0, stdout: "", stderr: "" };
                },
              },
            );
            assert.equal(failedBootAfterStop.exitCode, 1);
            const postStopFailLease = readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"];
            assert.ok(postStopFailLease);
            assert.equal(postStopFailLease.serial, null);
            const execWithoutSerial = await cmdExec(
              coldRediscoverDir,
              ["android", "prop", "get", "ro.build.version.sdk", "--session", "target-sess", "--json"],
              { env: fakeAdbEnv },
            );
            assert.equal(execWithoutSerial.exitCode, 3);
            assert.match(execWithoutSerial.error, /has no active adb serial/);
            // 36. `atc free --snapshot-save` or `--snapshot-load` on a lease with `serial: null` fails and retains the lease
            const freeSnapSaveWithoutSerial = cmdFree(
              coldRediscoverDir,
              l2.lease.leaseId,
              { session: "target-sess", snapshotSave: "must-not-skip" },
              { avdHome, host: { freeDiskMb: 16384 } },
            );
            assert.equal(freeSnapSaveWithoutSerial.exitCode, 1);
            assert.match(freeSnapSaveWithoutSerial.error, /has no active adb serial/);
            assert.ok(readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]);

            const freeSnapLoadWithoutSerial = cmdFree(
              coldRediscoverDir,
              l2.lease.leaseId,
              { session: "target-sess", snapshotLoad: "clean" },
              { avdHome },
            );
            assert.equal(freeSnapLoadWithoutSerial.exitCode, 1);
            assert.match(freeSnapLoadWithoutSerial.error, /has no active adb serial/);
            assert.ok(readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]);

            const recoverStoppedOwnLease = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  host: singleMatchInv.host,
                  running: [],
                  offline: [
                    {
                      deviceKey: "avd:Pixel_9_API_36",
                      avd: "Pixel_9_API_36",
                      serial: null,
                      kind: "emulator",
                      online: false,
                      profile: { deviceType: "phone", apiLevel: "android-36" },
                    },
                  ],
                  creatable: [],
                },
                runner: (cmd, args) => {
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    return { status: 0, stdout: "Started on emulator-5558\n", stderr: "" };
                  }
                  return { status: 0, stdout: "1\n", stderr: "" };
                },
              },
            );
            assert.equal(recoverStoppedOwnLease.exitCode, 0);
            assert.equal(recoverStoppedOwnLease.lease.serial, "emulator-5558");
            assert.equal(recoverStoppedOwnLease.lease.leaseId, l2.lease.leaseId);

            // 37. Idempotent re-claim preparation marks the lease non-active ("starting") while running outside lock
            let stateDuringIdempotentPrep = null;
            const idempotentPrepRes = cmdClaim(
              coldRediscoverDir,
              {
                session: "target-sess",
                avd: "Pixel_9_API_36",
                resetApp: "com.example.app",
                wait: 0,
              },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  host: singleMatchInv.host,
                  running: [
                    {
                      deviceKey: "avd:Pixel_9_API_36",
                      avd: "Pixel_9_API_36",
                      serial: "emulator-5558",
                      kind: "emulator",
                      online: true,
                      profile: { deviceType: "phone", apiLevel: "android-36" },
                    },
                  ],
                  offline: [],
                  creatable: [],
                },
                runner: (cmd, args) => {
                  if (cmd === "adb" && args.includes("clear")) {
                    stateDuringIdempotentPrep =
                      readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]?.state;
                  }
                  return { status: 0, stdout: "Success\n", stderr: "" };
                },
              },
            );
            assert.equal(idempotentPrepRes.exitCode, 0);
            assert.equal(idempotentPrepRes.idempotent, true);
            assert.equal(stateDuringIdempotentPrep, "starting");
            assert.equal(idempotentPrepRes.lease.state, "active");
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"].state,
              "active",
            );

            // 38. Source `serial:<serial>` lease with live worker does not displace an in-flight `starting` destination AVD lease until the transition worker drains
            const liveWorkerCollisionState = {
              config: {},
              leases: {
                "serial:emulator-5564": {
                  leaseId: "lease_src_live",
                  deviceKey: "serial:emulator-5564",
                  kind: "emulator",
                  avd: null,
                  serial: "emulator-5564",
                  sessionId: "src-live-sess",
                  state: "active",
                  workerPid: 777001,
                  workerPids: [777001],
                  claimedAtMs: 5000,
                },
                "avd:Pixel_9_API_36": {
                  leaseId: "lease_dest_starting",
                  deviceKey: "avd:Pixel_9_API_36",
                  kind: "emulator",
                  avd: "Pixel_9_API_36",
                  serial: null,
                  sessionId: "dest-boot-sess",
                  state: "starting",
                  workerPid: 777002,
                  claimedAtMs: 1000,
                },
              },
              queue: [],
            };
            const collisionInv = {
              probes: { emulatorListOk: true, adbDevicesOk: true },
              running: [
                {
                  deviceKey: "avd:Pixel_9_API_36",
                  avd: "Pixel_9_API_36",
                  serial: "emulator-5564",
                  kind: "emulator",
                  online: true,
                  profile: { deviceType: "phone", apiLevel: "android-36" },
                },
              ],
              offline: [],
            };
            reconcileOfflineLeases(
              liveWorkerCollisionState,
              collisionInv,
              "any-sess",
              6000,
              (pid) => pid === 777001 || pid === 777002,
            );
            assert.equal(
              liveWorkerCollisionState.leases["avd:Pixel_9_API_36"]?.leaseId,
              "lease_dest_starting",
            );
            assert.equal(
              liveWorkerCollisionState.leases["serial:emulator-5564"]?.leaseId,
              "lease_src_live",
            );
            assert.equal(
              liveWorkerCollisionState.leases["serial:emulator-5564"]?.avd,
              "Pixel_9_API_36",
            );
            // Once the transition worker (777002) exits, reconciliation transfers lease_src_live onto the AVD key
            reconcileOfflineLeases(
              liveWorkerCollisionState,
              collisionInv,
              "any-sess",
              6000,
              (pid) => pid === 777001,
            );
            assert.equal(liveWorkerCollisionState.leases["serial:emulator-5564"], undefined);
            assert.equal(
              liveWorkerCollisionState.leases["avd:Pixel_9_API_36"]?.leaseId,
              "lease_src_live",
            );

            // 39. Displaced transition worker aborts before executing post-boot prep against another session's device
            const displacedCommands = [];
            const displacedClaimRes = cmdClaim(
              coldRediscoverDir,
              {
                session: "displaced-sess",
                avd: "Pixel_8_API_35",
                snapshotLoad: "clean",
                resetApp: "com.example.app",
                wait: 0,
              },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  host: singleMatchInv.host,
                  running: [],
                  offline: [
                    {
                      deviceKey: "avd:Pixel_8_API_35",
                      avd: "Pixel_8_API_35",
                      serial: null,
                      kind: "emulator",
                      online: false,
                      snapshots: ["clean"],
                      profile: { deviceType: "phone", apiLevel: "android-35" },
                    },
                  ],
                  creatable: [],
                },
                runner: (cmd, args) => {
                  displacedCommands.push([cmd, ...args].join(" "));
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    withStateTransaction(coldRediscoverDir, (state, { now }) => {
                      state.leases["avd:Pixel_8_API_35"] = {
                        leaseId: "lease_reconciled_winner",
                        deviceKey: "avd:Pixel_8_API_35",
                        kind: "emulator",
                        avd: "Pixel_8_API_35",
                        serial: "emulator-5554",
                        sessionId: "winner-sess",
                        state: "active",
                        workerPid: 888001,
                        workerPids: [888001],
                        claimedAtMs: now - 5000,
                        activatedAtMs: now - 5000,
                        renewedAtMs: now,
                        expiresAtMs: now + 600_000,
                      };
                      return { mutated: true };
                    });
                    return { status: 0, stdout: "Started on emulator-5554\n", stderr: "" };
                  }
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(displacedClaimRes.exitCode, 1);
            assert.match(displacedClaimRes.error, /was lost during boot/);
            assert.equal(
              displacedCommands.some((c) => c.includes("snapshot load") || c.includes("pm clear")),
              false,
            );
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"]?.leaseId,
              "lease_reconciled_winner",
            );

            // 41. cmdSnapshot("load") transitions the lease to "starting" during restoration and restores "active" afterward
            withStateTransaction(coldRediscoverDir, (s) => {
              if (s.leases["avd:Pixel_9_API_36"]) {
                s.leases["avd:Pixel_9_API_36"].firstSeenOfflineAtMs = null;
                s.leases["avd:Pixel_9_API_36"].serial = "emulator-5558";
              }
              return { mutated: true };
            });
            let stateDuringSnapshotLoad = null;
            const snapLoadRes = cmdSnapshot(
              coldRediscoverDir,
              "load",
              "clean_boot",
              { session: "target-sess", avd: "Pixel_9_API_36" },
              {
                avdHome,
                runner: (cmd, args) => {
                  if (cmd === "adb" && args.includes("load")) {
                    stateDuringSnapshotLoad =
                      readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]?.state;
                    return { status: 0, stdout: "OK\n", stderr: "" };
                  }
                  if (cmd === "adb" && args.includes("sys.boot_completed")) {
                    return { status: 0, stdout: "1\n", stderr: "" };
                  }
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(snapLoadRes.exitCode, 0);
            assert.equal(stateDuringSnapshotLoad, "starting");
            assert.equal(snapLoadRes.lease.state, "active");
            assert.equal(snapLoadRes.lease.loadedSnapshot, "clean_boot");
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]?.state,
              "active",
            );

            // 42. Forced release takeover during boot (same leaseId, state changed to "stopping") blocks activation
            cmdFree(coldRediscoverDir, "Pixel_8_API_35", { force: true });
            const forcedTakeoverRes = cmdClaim(
              coldRediscoverDir,
              {
                session: "boot-takeover-sess",
                avd: "Pixel_8_API_35",
                wait: 0,
              },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  host: singleMatchInv.host,
                  running: [],
                  offline: [
                    {
                      deviceKey: "avd:Pixel_8_API_35",
                      avd: "Pixel_8_API_35",
                      serial: null,
                      kind: "emulator",
                      online: false,
                      profile: { deviceType: "phone", apiLevel: "android-35" },
                    },
                  ],
                  creatable: [],
                },
                runner: (cmd, args) => {
                  if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                    withStateTransaction(coldRediscoverDir, (state, { now }) => {
                      const cur = state.leases["avd:Pixel_8_API_35"];
                      if (cur) {
                        cur.state = "stopping";
                        cur.workerPid = 999888;
                        cur.deadlineMs = now + 60_000;
                      }
                      return { mutated: true };
                    });
                    return { status: 0, stdout: "Started on emulator-5554\n", stderr: "" };
                  }
                  return { status: 0, stdout: "OK\n", stderr: "" };
                },
              },
            );
            assert.equal(forcedTakeoverRes.exitCode, 1);
            assert.match(forcedTakeoverRes.error, /was lost during boot/);
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"]?.state,
              "stopping",
            );
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_8_API_35"]?.workerPid,
              999888,
            );

            // 43. Forced release on a lease with a live worker retains the reservation until the worker exits
            withStateTransaction(coldRediscoverDir, (state) => {
              const cur = state.leases["avd:Pixel_9_API_36"];
              cur.workerPid = 999777;
              cur.workerPids = [999777];
              return { mutated: true };
            }, { livenessCheck: (pid) => pid === 999777 || pid === process.pid });

            const forceFreeBusyRes = cmdFree(
              coldRediscoverDir,
              "Pixel_9_API_36",
              { session: "other-admin-sess", force: true },
              { livenessCheck: (pid) => pid === 999777 || pid === process.pid },
            );
            assert.equal(forceFreeBusyRes.exitCode, 3);
            assert.ok(readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]);
            assert.equal(
              readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"]?.releaseOnWorkerExit,
              true,
            );

            // Clear worker 999777 and verify idempotent claim preserves a later expiresAtMs when --ttl is omitted
            withStateTransaction(
              coldRediscoverDir,
              (state, { now }) => {
                const cur = state.leases["avd:Pixel_9_API_36"];
                cur.workerPid = null;
                cur.workerPids = [];
                cur.releaseOnWorkerExit = false;
                cur.firstSeenOfflineAtMs = null;
                cur.serial = "emulator-5558";
                cur.expiresAtMs = now + 3_600_000;
                return { mutated: true };
              },
              { livenessCheck: (pid) => pid === 999777 || pid === process.pid },
            );
            const laterExpiryBefore =
              readState(coldRediscoverDir).leases["avd:Pixel_9_API_36"].expiresAtMs;
            const idempotentPreserveTtl = cmdClaim(
              coldRediscoverDir,
              { session: "target-sess", avd: "Pixel_9_API_36", wait: 0 },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  host: singleMatchInv.host,
                  running: [
                    {
                      deviceKey: "avd:Pixel_9_API_36",
                      avd: "Pixel_9_API_36",
                      serial: "emulator-5558",
                      kind: "emulator",
                      online: true,
                      profile: { deviceType: "phone", apiLevel: "android-36" },
                    },
                  ],
                  offline: [],
                  creatable: [],
                },
              },
            );
            assert.equal(idempotentPreserveTtl.exitCode, 0);
            assert.equal(idempotentPreserveTtl.idempotent, true);
            assert.ok(idempotentPreserveTtl.lease.expiresAtMs >= laterExpiryBefore);

            // 46. `atc free` rejects extra positional targets instead of ignoring them
            const extraFreeExit = await runCli(["free", "lease-a", "lease-b"], {
              ...process.env,
              ATC_STATE_DIR: coldRediscoverDir,
            });
            assert.equal(extraFreeExit, 1);

            // 47. hooks/hooks.json strips workspace-local PATH entries (e.g. <checkout>/node_modules/.bin) before launching node
            if (process.platform !== "win32") {
              const evilWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-evil-hook-cwd-"));
              try {
                const evilNodeBinDir = path.join(evilWorkDir, "node_modules", ".bin");
                fs.mkdirSync(evilNodeBinDir, { recursive: true });
                const evilNodePath = path.join(evilNodeBinDir, "node");
                fs.writeFileSync(evilNodePath, "#!/bin/sh\necho EVIL_NODE_EXECUTED >&2\nexit 99\n");
                fs.chmodSync(evilNodePath, 0o755);

                const hooksCfg = JSON.parse(
                  fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
                );
                const preHookCmd = hooksCfg.hooks.PreToolUse[0].hooks[0].command;
                const repoRoot = path.resolve(
                  path.dirname(new URL(import.meta.url).pathname),
                  "..",
                );
                const hookRun = spawnSync("/bin/sh", ["-c", preHookCmd], {
                  cwd: evilWorkDir,
                  input: JSON.stringify({
                    session_id: "hook-safe-node-sess",
                    tool_name: "Bash",
                    tool_input: { command: "adb shell getprop" },
                  }),
                  env: {
                    ...process.env,
                    ATC_STATE_DIR: coldRediscoverDir,
                    CLAUDE_PLUGIN_ROOT: repoRoot,
                    PATH: `${evilWorkDir}:${evilNodeBinDir}:${path.dirname(process.execPath)}:${process.env.PATH || ""}`,
                  },
                  encoding: "utf8",
                });
                assert.notEqual(hookRun.status, 99);
                assert.equal(hookRun.stderr.includes("EVIL_NODE_EXECUTED"), false);
                assert.equal(hookRun.status, 0);

                const agHooksCfg = JSON.parse(
                  fs.readFileSync(new URL("../hooks.json", import.meta.url), "utf8"),
                );
                const agPreHookCmd = agHooksCfg.atc.PreToolUse[0].hooks[0].command;
                const agHookRun = spawnSync("/bin/sh", ["-c", agPreHookCmd], {
                  cwd: repoRoot,
                  input: JSON.stringify({
                    conversationId: "antigravity-e2e-sess",
                    workspacePaths: [evilWorkDir],
                    toolCall: {
                      name: "run_command",
                      args: { CommandLine: "adb shell getprop", Cwd: evilWorkDir },
                    },
                  }),
                  env: {
                    ...process.env,
                    ATC_STATE_DIR: coldRediscoverDir,
                    ANTIGRAVITY_CONVERSATION_ID: "antigravity-e2e-sess",
                    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
                  },
                  encoding: "utf8",
                });
                assert.equal(agHookRun.status, 0);
                const agOut = JSON.parse(agHookRun.stdout);
                assert.deepEqual(agOut, { decision: "allow" });
              } finally {
                fs.rmSync(evilWorkDir, { recursive: true, force: true });
              }
            }

            // 50. Stale warm candidate in cached inventory is revalidated when concurrent `free --stop` stops the emulator before lock acquisition
            let discoverCalls = 0;
            const staleRaceDir = makeTempStateDir();
            try {
              const firstClaim = cmdClaim(
                staleRaceDir,
                { session: "owner-a", avd: "Pixel_8_API_35", wait: 0 },
                {
                  platform: "darwin",
                  avdHome,
                  inventory: {
                    host: singleMatchInv.host,
                    running: [
                      {
                        deviceKey: "avd:Pixel_8_API_35",
                        avd: "Pixel_8_API_35",
                        serial: "emulator-5554",
                        kind: "emulator",
                        online: true,
                        profile: { deviceType: "phone", apiLevel: "android-35" },
                      },
                    ],
                    offline: [],
                    creatable: [],
                  },
                },
              );
              assert.equal(firstClaim.exitCode, 0);

              let bootedAfterStop = false;
              const secondClaim = cmdClaim(
                staleRaceDir,
                { session: "claimer-b", avd: "Pixel_8_API_35", wait: 0, force: true },
                {
                  platform: "darwin",
                  avdHome,
                  runner: (cmd, args) => {
                    if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
                      discoverCalls++;
                      if (discoverCalls === 1) {
                        // Simulate concurrent `free --stop` completing right after initial fleet discovery
                        cmdFree(
                          staleRaceDir,
                          firstClaim.lease.leaseId,
                          { session: "owner-a", stop: true },
                          {
                            platform: "darwin",
                            runner: () => ({ status: 0, stdout: "Stopped\n", stderr: "" }),
                          },
                        );
                        return {
                          status: 0,
                          stdout: "Pixel_8_API_35 online emulator-5554 android-35\n",
                          stderr: "",
                        };
                      }
                      return {
                        status: 0,
                        stdout: bootedAfterStop
                          ? "Pixel_8_API_35 online emulator-5560 android-35\n"
                          : "Pixel_8_API_35 offline android-35\n",
                        stderr: "",
                      };
                    }
                    if (cmd === "adb" && args[0] === "devices") {
                      if (discoverCalls === 1) {
                        return {
                          status: 0,
                          stdout: "List of devices attached\nemulator-5554\tdevice\n",
                          stderr: "",
                        };
                      }
                      return {
                        status: 0,
                        stdout: bootedAfterStop
                          ? "List of devices attached\nemulator-5560\tdevice\n"
                          : "List of devices attached\n",
                        stderr: "",
                      };
                    }
                    if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                      bootedAfterStop = true;
                      return { status: 0, stdout: "Started on emulator-5560\n", stderr: "" };
                    }
                    return { status: 0, stdout: "OK\n", stderr: "" };
                  },
                },
              );
              assert.equal(secondClaim.exitCode, 0);
              assert.equal(bootedAfterStop, true);
              assert.equal(secondClaim.lease.serial, "emulator-5560");
              assert.ok(discoverCalls >= 2);
            } finally {
              fs.rmSync(staleRaceDir, { recursive: true, force: true });
            }

            // 52. Deferred release (`free --force`) during boot activation completes release instead of returning an active lease
            const bootDeferDir = makeTempStateDir();
            try {
              let stoppedOnDeferredFree = false;
              const bootClaimRes = cmdClaim(
                bootDeferDir,
                { session: "boot-defer-sess", avd: "Pixel_8_API_35", wait: 0, force: true },
                {
                  platform: "darwin",
                  avdHome,
                  inventory: {
                    host: singleMatchInv.host,
                    running: [],
                    offline: [
                      {
                        deviceKey: "avd:Pixel_8_API_35",
                        avd: "Pixel_8_API_35",
                        serial: null,
                        kind: "emulator",
                        online: false,
                        profile: { deviceType: "phone", apiLevel: "android-35" },
                      },
                    ],
                    creatable: [],
                  },
                  runner: (cmd, args) => {
                    if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                      // Concurrent `free --force --stop` arrives while boot worker is still running
                      const deferFree = cmdFree(
                        bootDeferDir,
                        "Pixel_8_API_35",
                        { session: "boot-defer-sess", force: true, stop: true },
                        { deferOnBusyWorker: true },
                      );
                      assert.equal(deferFree.exitCode, 0);
                      return { status: 0, stdout: "Started on emulator-5562\n", stderr: "" };
                    }
                    if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
                      stoppedOnDeferredFree = true;
                      return { status: 0, stdout: "Stopped\n", stderr: "" };
                    }
                    return { status: 0, stdout: "OK\n", stderr: "" };
                  },
                },
              );
              assert.equal(bootClaimRes.exitCode, 1);
              assert.match(bootClaimRes.error, /released during boot/);
              assert.equal(stoppedOnDeferredFree, true);
              const postBootDeferState = readState(bootDeferDir);
              assert.equal(Object.keys(postBootDeferState.leases).length, 0);
            } finally {
              fs.rmSync(bootDeferDir, { recursive: true, force: true });
            }
          } finally {
            fs.rmSync(coldRediscoverDir, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(stopTimeoutDir, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(npxDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(winDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(avdHome, { recursive: true, force: true });
  }
});

test("regression: Astra review hardening (rollback stopping state, stale lock breaker serialization, auto-create baseline isolation, Windows shutdown wait, and ADB post-subcommand -s)", async () => {
  const dir = makeTempStateDir();
  const avdHome = makeTempStateDir();
  try {
    // 1. Rollback keeps lease in "stopping" state until emulator stop finishes, preventing concurrent claim
    let concurrentClaimDuringStop = null;
    const rollbackRes = cmdClaim(
      dir,
      { session: "rollback-sess", avd: "Pixel_8_API_35", resetApp: "com.example.fail", wait: 0, force: true },
      {
        platform: "darwin",
        avdHome,
        inventory: {
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
          running: [],
          offline: [
            {
              deviceKey: "avd:Pixel_8_API_35",
              avd: "Pixel_8_API_35",
              serial: null,
              kind: "emulator",
              online: false,
              profile: { deviceType: "phone", apiLevel: "android-35" },
            },
          ],
          creatable: [],
        },
        runner: (cmd, args) => {
          if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
            return { status: 0, stdout: "Started on emulator-5554\n", stderr: "" };
          }
          if (cmd === "adb" && args.includes("clear")) {
            return { status: 1, stdout: "", stderr: "Failed to clear package\n" };
          }
          if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
            const midStopState = readState(dir);
            assert.equal(midStopState.leases["avd:Pixel_8_API_35"]?.state, "stopping");
            assert.equal(midStopState.leases["avd:Pixel_8_API_35"]?.serial, "emulator-5554");
            concurrentClaimDuringStop = cmdClaim(
              dir,
              { session: "racing-sess", avd: "Pixel_8_API_35", wait: 0, force: true },
              {
                platform: "darwin",
                avdHome,
                inventory: {
                  host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
                  running: [
                    {
                      deviceKey: "avd:Pixel_8_API_35",
                      avd: "Pixel_8_API_35",
                      serial: "emulator-5554",
                      kind: "emulator",
                      online: true,
                      profile: { deviceType: "phone", apiLevel: "android-35" },
                    },
                  ],
                  offline: [],
                  creatable: [],
                },
              },
            );
            return { status: 0, stdout: "Stopped\n", stderr: "" };
          }
          return { status: 0, stdout: "OK\n", stderr: "" };
        },
      },
    );
    assert.equal(rollbackRes.exitCode, 1);
    assert.equal(concurrentClaimDuringStop?.exitCode, 2);
    assert.equal(readState(dir).leases["avd:Pixel_8_API_35"], undefined);

    // 2. Stale-lock breaking is serialized via breaker lock and commitState/writeFileAtomic re-verifies lock nonce before rename
    const lockTestDir = makeTempStateDir();
    try {
      const lockInfo = acquireLock(lockTestDir, 1000);
      // Tamper with owner.json nonce to simulate lock loss before commit
      fs.writeFileSync(
        lockInfo.ownerPath,
        JSON.stringify({ pid: process.pid, nonce: "forged-nonce", createdAtMs: Date.now() }),
      );
      assert.throws(
        () => commitState(lockTestDir, createDefaultState(), lockInfo),
        /Lock ownership nonce lost before state\.json commit/,
      );
      fs.rmSync(lockInfo.lockDir, { recursive: true, force: true });
      // Malformed owner.json is recovered after MISSING_OWNER_STALE_MS
      fs.mkdirSync(path.join(lockTestDir, "atc.lock"), { recursive: true });
      fs.writeFileSync(path.join(lockTestDir, "atc.lock", "owner.json"), "{corrupt-json");
      const recoveredLock = acquireLock(lockTestDir, 3500);
      assert.ok(recoveredLock.nonce);
      releaseLock(recoveredLock);

      // Extended staleAfterMs (used by atc.create.lock) prevents breaking a live owner's lock after 10s
      fs.mkdirSync(path.join(lockTestDir, "atc.create.lock"), { recursive: true });
      fs.writeFileSync(
        path.join(lockTestDir, "atc.create.lock", "owner.json"),
        JSON.stringify({
          pid: process.pid,
          createdAtMs: Date.now() - 25_000,
          staleAfterMs: 180_000,
          nonce: "live-long-create",
        }),
      );
      assert.throws(
        () => acquireLock(lockTestDir, 150, "atc.create.lock", 180_000),
        /Timed out waiting/,
      );
      fs.rmSync(path.join(lockTestDir, "atc.create.lock"), { recursive: true, force: true });
    } finally {
      fs.rmSync(lockTestDir, { recursive: true, force: true });
    }

    // 3. Auto-create snapshots pre-create fleet inside atc.create.lock and never deletes pre-existing or other-session AVDs
    const createIsoDir = makeTempStateDir();
    try {
      let removeCalled = false;
      const createIsoRes = cmdClaim(
        createIsoDir,
        { session: "create-iso-sess", type: "phone", api: "36", createIfMissing: true, wait: 0, force: true },
        {
          platform: "darwin",
          avdHome,
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [],
            offline: [],
            creatable: [
              {
                kind: "emulator",
                deviceName: "pixel_9",
                profile: { deviceType: "phone", deviceName: "pixel_9", apiLevel: "android-36" },
              },
            ],
          },
          runner: (cmd, args) => {
            if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
              // Other_Session_API_34 was already created by another session before our `create` ran
              return {
                status: 0,
                stdout:
                  "AVD                 Status    Serial          API\nOther_Session_API_34 offline   -               android-34\n",
                stderr: "",
              };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "create") {
              return { status: 0, stdout: "Created AVD 'Pixel_9_API_36'\n", stderr: "" };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "remove") {
              removeCalled = true;
              return { status: 0, stdout: "", stderr: "" };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
              return { status: 0, stdout: "Started on emulator-5558\n", stderr: "" };
            }
            return { status: 0, stdout: "OK\n", stderr: "" };
          },
        },
      );
      assert.equal(createIsoRes.exitCode, 0);
      assert.equal(removeCalled, false);
      assert.equal(createIsoRes.lease.avd, "Pixel_9_API_36");
    } finally {
      fs.rmSync(createIsoDir, { recursive: true, force: true });
    }

    // 4. Windows adb emu kill waits for emulator to go offline and release .lock files (including relocated AVDs via .ini path=)
    const winShutdownDir = makeTempStateDir();
    const relocatedRoot = makeTempStateDir();
    try {
      const winAvdDir = path.join(relocatedRoot, "Custom_Relocated_Win.avd");
      fs.mkdirSync(winAvdDir, { recursive: true });
      fs.writeFileSync(
        path.join(avdHome, "Pixel_Win_API_35.ini"),
        `avd.ini.encoding=UTF-8\npath=${winAvdDir}\ntarget=android-35\n`,
      );
      const lockFile = path.join(winAvdDir, "hardware-qemu.ini.lock");
      fs.writeFileSync(lockFile, "locked");
      // Persistent advisory lock file (multiinstance.lock) must NOT block shutdown confirmation once hardware-qemu.ini.lock is removed
      fs.writeFileSync(path.join(winAvdDir, "multiinstance.lock"), "");

      const claimWin = cmdClaim(
        winShutdownDir,
        { session: "win-wait-sess", avd: "Pixel_Win_API_35", wait: 0, force: true },
        {
          platform: "win32",
          avdHome,
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [
              {
                deviceKey: "avd:Pixel_Win_API_35",
                avd: "Pixel_Win_API_35",
                serial: "emulator-5564",
                kind: "emulator",
                online: true,
                profile: { deviceType: "phone", apiLevel: "android-35" },
              },
            ],
            offline: [],
            creatable: [],
          },
        },
      );
      assert.equal(claimWin.exitCode, 0);

      let adbPollCount = 0;
      const freeWin = cmdFree(
        winShutdownDir,
        claimWin.lease.leaseId,
        { session: "win-wait-sess", stop: true },
        {
          platform: "win32",
          avdHome,
          runner: (cmd, args) => {
            if (cmd === "adb" && args.includes("emu") && args.includes("kill")) {
              return { status: 0, stdout: "OK\n", stderr: "" };
            }
            if (cmd === "adb" && args[0] === "devices") {
              adbPollCount += 1;
              if (adbPollCount === 1) {
                // Failed discovery probe must not be treated as confirmed shutdown
                return { status: 1, stdout: "", stderr: "adb server error\n" };
              }
              if (adbPollCount === 2) {
                return {
                  status: 0,
                  stdout: "List of devices attached\nemulator-5564\tdevice\n",
                  stderr: "",
                };
              }
              if (fs.existsSync(lockFile)) {
                fs.rmSync(lockFile, { force: true });
              }
              return { status: 0, stdout: "List of devices attached\n", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.equal(freeWin.exitCode, 0);
      assert.ok(adbPollCount >= 3);
    } finally {
      fs.rmSync(winShutdownDir, { recursive: true, force: true });
      fs.rmSync(relocatedRoot, { recursive: true, force: true });
    }

    // 6. Real-world physical getprop `nosdcard` is not misclassified as `automotive`, and wrapped `android emulator list --long` lines do not emit phantom "Offline" AVDs
    assert.equal(inferDeviceType("Pixel 7 Pro", "nosdcard", "nosdcard"), "phone");
    assert.equal(inferDeviceType("Pixel Watch 3", "nosdcard,watch", "nosdcard,watch"), "watch");
    assert.equal(inferDeviceType("Automotive_1080p", "android-automotive", "automotive"), "automotive");
    const wrappedList = parseAndroidEmulatorListOutput(
      [
        "AVD ID                   AVD Name                      API Level      Status         Serial",
        "Pixel_3a_API_33_arm64-v8aPixel_3a_API_33_arm64-v8a     android-33     Offline",
        "abcdefghabcdefgh         abcdefghabcdefgh              android-34     Offline",
        "Medium_Phone             Medium Phone                  android-canary-20260805",
        "                                                                      Offline",
      ].join("\n"),
    );
    assert.deepEqual(
      wrappedList.map((a) => a.avd),
      ["Pixel_3a_API_33_arm64-v8a", "abcdefghabcdefgh", "Medium_Phone"],
    );

    // 7. Rollback stop failure keeps the lease in "stopping" until the emulator is offline or the stop deadline expires
    const rollbackHoldDir = makeTempStateDir();
    try {
      const rollbackClaim = cmdClaim(
        rollbackHoldDir,
        {
          session: "rollback-hold-sess",
          avd: "Pixel_Rollback_AVD",
          resetApp: "com.example.app",
          wait: 0,
          force: true,
        },
        {
          platform: "darwin",
          avdHome,
          runner: (cmd, args) => {
            if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
              return { status: 0, stdout: "Started on emulator-5568\n", stderr: "" };
            }
            if (cmd === "adb" && args.includes("clear")) {
              return { status: 1, stdout: "", stderr: "Failed to clear package\n" };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
              return { status: 1, stdout: "", stderr: "Stop timed out\n" };
            }
            return { status: 0, stdout: "OK\n", stderr: "" };
          },
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [],
            offline: [
              {
                deviceKey: "avd:Pixel_Rollback_AVD",
                kind: "emulator",
                avd: "Pixel_Rollback_AVD",
                serial: null,
                online: false,
                profile: { deviceType: "phone", apiLevel: "android-35" },
              },
            ],
            creatable: [],
          },
        },
      );
      assert.equal(rollbackClaim.exitCode, 1);
      const stateAfterFailedRollback = readState(rollbackHoldDir);
      const heldLease = stateAfterFailedRollback.leases["avd:Pixel_Rollback_AVD"];
      assert.ok(heldLease, "Expected failed rollback stop to keep stopping reservation");
      assert.equal(heldLease.state, "stopping");
      assert.equal(heldLease.workerPid, null);
      assert.equal(heldLease.serial, "emulator-5568");
      assert.ok(heldLease.deadlineMs > Date.now());

      // Pre-boot/stale offline inventory in reconcileOfflineLeases or concurrent claim must NOT clear the stopping reservation before its deadline
      withStateTransaction(rollbackHoldDir, (s) => {
        reconcileOfflineLeases(
          s,
          {
            running: [],
            offline: [{ deviceKey: "avd:Pixel_Rollback_AVD", kind: "emulator", avd: "Pixel_Rollback_AVD" }],
            probes: { emulatorListOk: true, adbDevicesOk: true },
          },
          "other-sess",
        );
        return { mutated: true };
      });
      assert.ok(
        readState(rollbackHoldDir).leases["avd:Pixel_Rollback_AVD"],
        "Stopping lease must remain held until deadline even when pre-boot offline inventory is reconciled",
      );
      const concurrentClaimWithStaleOfflineInventory = cmdClaim(
        rollbackHoldDir,
        {
          session: "stale-inv-sess",
          avd: "Pixel_Rollback_AVD",
          wait: 0,
          force: true,
        },
        {
          platform: "darwin",
          avdHome,
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [],
            offline: [
              {
                deviceKey: "avd:Pixel_Rollback_AVD",
                kind: "emulator",
                avd: "Pixel_Rollback_AVD",
                serial: null,
                online: false,
                profile: { deviceType: "phone", apiLevel: "android-35" },
              },
            ],
            creatable: [],
          },
        },
      );
      assert.notEqual(concurrentClaimWithStaleOfflineInventory.exitCode, 0);

      // Clear stopping lease for subsequent test cases in rollbackHoldDir
      withStateTransaction(rollbackHoldDir, (s) => {
        delete s.leases["avd:Pixel_Rollback_AVD"];
        s.bootedDevices = {};
        return { mutated: true };
      });

      // 8. allowLivePidExpiry: false prevents breaking a lock held by a live PID even past staleLockMs
      const liveHandle = acquireLock(
        rollbackHoldDir,
        2000,
        "atc.create.lock",
        10000,
        { allowLivePidExpiry: false },
      );
      try {
        const ownerObj = JSON.parse(fs.readFileSync(liveHandle.ownerPath, "utf8"));
        ownerObj.createdAtMs = Date.now() - 120_000;
        ownerObj.staleAfterMs = 10_000;
        fs.writeFileSync(liveHandle.ownerPath, JSON.stringify(ownerObj), "utf8");
        assert.throws(
          () =>
            acquireLock(rollbackHoldDir, 60, "atc.create.lock", 10000, {
              allowLivePidExpiry: false,
            }),
          /Timed out waiting/,
        );
        assert.equal(verifyLockOwnership(liveHandle), true);
      } finally {
        releaseLock(liveHandle);
      }

      // 9. Windows cmdFree --stop timeout preserves "stopping" until deadline
      const winFreeClaim = cmdClaim(
        rollbackHoldDir,
        {
          session: "win-free-timeout-sess",
          avd: "Pixel_Rollback_AVD",
          wait: 0,
          force: true,
        },
        {
          platform: "win32",
          avdHome,
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [
              {
                deviceKey: "avd:Pixel_Rollback_AVD",
                kind: "emulator",
                avd: "Pixel_Rollback_AVD",
                serial: "emulator-5572",
                online: true,
                profile: { deviceType: "phone", apiLevel: "android-35" },
              },
            ],
            offline: [],
            creatable: [],
          },
        },
      );
      assert.equal(winFreeClaim.exitCode, 0);
      withStateTransaction(rollbackHoldDir, (s) => {
        s.config.stopTimeoutSec = 1;
        return { mutated: true };
      });
      const winFreeFail = cmdFree(
        rollbackHoldDir,
        winFreeClaim.lease.leaseId,
        { session: "win-free-timeout-sess", stop: true },
        {
          platform: "win32",
          avdHome,
          runner: (cmd, args) => {
            if (cmd === "adb" && args.includes("emu") && args.includes("kill")) {
              return { status: 0, stdout: "OK\n", stderr: "" };
            }
            if (cmd === "adb" && args[0] === "devices") {
              return {
                status: 0,
                stdout: "List of devices attached\nemulator-5572\tdevice\n",
                stderr: "",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.equal(winFreeFail.exitCode, 1);
      const winFreeHeld = readState(rollbackHoldDir).leases["avd:Pixel_Rollback_AVD"];
      assert.ok(winFreeHeld);
      assert.equal(winFreeHeld.state, "stopping");
      assert.equal(winFreeHeld.workerPid, null);

      // 10. Windows coldBoot/wipeData restart stop-wait timeout keeps the lease in "stopping" (even if upgrading an owned previousLease)
      const rebootTimeoutDir = makeTempStateDir();
      try {
        withStateTransaction(rebootTimeoutDir, (s) => {
          s.config.stopTimeoutSec = 1;
          return { mutated: true };
        });
        const prevClaim = cmdClaim(
          rebootTimeoutDir,
          {
            session: "win-reboot-timeout-sess",
            avd: "Pixel_Rollback_AVD",
            wait: 0,
            force: true,
          },
          {
            platform: "win32",
            avdHome,
            inventory: {
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
              running: [
                {
                  deviceKey: "avd:Pixel_Rollback_AVD",
                  kind: "emulator",
                  avd: "Pixel_Rollback_AVD",
                  serial: "emulator-5574",
                  online: true,
                  profile: { deviceType: "phone", apiLevel: "android-35" },
                },
              ],
              offline: [],
              creatable: [],
            },
          },
        );
        assert.equal(prevClaim.exitCode, 0);
        const rebootTimeoutClaim = cmdClaim(
          rebootTimeoutDir,
          {
            session: "win-reboot-timeout-sess",
            avd: "Pixel_Rollback_AVD",
            cold: true,
            wait: 0,
            force: true,
          },
          {
            platform: "win32",
            avdHome,
            runner: (cmd, args) => {
              if (cmd === "adb" && args.includes("emu") && args.includes("kill")) {
                return { status: 0, stdout: "OK\n", stderr: "" };
              }
              if (cmd === "adb" && args[0] === "devices") {
                return {
                  status: 0,
                  stdout: "List of devices attached\nemulator-5574\tdevice\n",
                  stderr: "",
                };
              }
              return { status: 0, stdout: "", stderr: "" };
            },
            inventory: {
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
              running: [
                {
                  deviceKey: "avd:Pixel_Rollback_AVD",
                  kind: "emulator",
                  avd: "Pixel_Rollback_AVD",
                  serial: "emulator-5574",
                  online: true,
                  profile: { deviceType: "phone", apiLevel: "android-35" },
                },
              ],
              offline: [],
              creatable: [],
            },
          },
        );
        assert.equal(rebootTimeoutClaim.exitCode, 1);
        const rebootHeld = readState(rebootTimeoutDir).leases["avd:Pixel_Rollback_AVD"];
        assert.ok(rebootHeld);
        assert.equal(rebootHeld.state, "stopping");
        assert.equal(rebootHeld.workerPid, null);
      } finally {
        fs.rmSync(rebootTimeoutDir, { recursive: true, force: true });
      }

      // 11. Windows victim eviction stop-wait timeout keeps the victim reservation in "stopping"
      withStateTransaction(rollbackHoldDir, (s) => {
        delete s.leases["avd:Pixel_Rollback_AVD"];
        s.config.maxRunningEmulators = 1;
        s.config.stopTimeoutSec = 1;
        return { mutated: true };
      });
      const victimTimeoutClaim = cmdClaim(
        rollbackHoldDir,
        {
          session: "win-evict-timeout-sess",
          avd: "Pixel_Target_AVD",
          wait: 0,
          force: true,
        },
        {
          platform: "win32",
          avdHome,
          runner: (cmd, args) => {
            if (cmd === "adb" && args.includes("emu") && args.includes("kill")) {
              return { status: 0, stdout: "OK\n", stderr: "" };
            }
            if (cmd === "adb" && args[0] === "devices") {
              return {
                status: 0,
                stdout: "List of devices attached\nemulator-5576\tdevice\n",
                stderr: "",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
          inventory: {
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
            running: [
              {
                deviceKey: "avd:Pixel_Victim_AVD",
                kind: "emulator",
                avd: "Pixel_Victim_AVD",
                serial: "emulator-5576",
                online: true,
                profile: { deviceType: "phone", apiLevel: "android-34" },
              },
            ],
            offline: [
              {
                deviceKey: "avd:Pixel_Target_AVD",
                kind: "emulator",
                avd: "Pixel_Target_AVD",
                serial: null,
                online: false,
                profile: { deviceType: "phone", apiLevel: "android-35" },
              },
            ],
            creatable: [],
          },
        },
      );
      assert.equal(victimTimeoutClaim.exitCode, 1);
      const victimAfterTimeout = readState(rollbackHoldDir).leases["avd:Pixel_Victim_AVD"];
      assert.ok(victimAfterTimeout, "Victim reservation must stay in stopping after Windows kill wait timeout");
      assert.equal(victimAfterTimeout.state, "stopping");
      assert.equal(victimAfterTimeout.workerPid, null);

      // 12. Automotive path separators, AVDs named online/offline, and non-concatenated repeated-half AVD IDs
      assert.equal(
        inferDeviceType("Generic_Device", "system-images/android-35/android-automotive/x86_64/", ""),
        "automotive",
      );
      const onePerLineOnline = parseAndroidEmulatorListOutput("online\noffline\n");
      assert.deepEqual(
        onePerLineOnline.map((a) => a.avd),
        ["online", "offline"],
      );
      const repeatedHalfSeparateName = parseAndroidEmulatorListOutput(
        [
          "AVD ID                   AVD Name                      API Level      Status         Serial",
          "abcdefghijklmnopabcdefghijklmnop My_Phone              android-35     Offline",
        ].join("\n"),
      );
      assert.deepEqual(
        repeatedHalfSeparateName.map((a) => a.avd),
        ["abcdefghijklmnopabcdefghijklmnop"],
      );

      // 13. Background worker heartbeat renews reservation deadline while main thread is blocked in synchronous boot
      const hbSyncDir = makeTempStateDir();
      try {
        withStateTransaction(hbSyncDir, (s) => {
          s.config.bootTimeoutSec = 1;
          return { mutated: true };
        });
        const hbSyncClaim = cmdClaim(
          hbSyncDir,
          {
            session: "hb-sync-sess",
            avd: "Pixel_Heartbeat_AVD",
            wait: 0,
            force: true,
          },
          {
            platform: "darwin",
            avdHome,
            runner: (cmd, args) => {
              if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                sleepSync(1350);
                // Another process running GC after 1.35s must see the heartbeat-renewed deadline
                withStateTransaction(hbSyncDir, () => ({ mutated: false }));
                return { status: 0, stdout: "Started on emulator-5578\n", stderr: "" };
              }
              return { status: 0, stdout: "OK\n", stderr: "" };
            },
            inventory: {
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Heartbeat_AVD",
                  kind: "emulator",
                  avd: "Pixel_Heartbeat_AVD",
                  serial: null,
                  online: false,
                  profile: { deviceType: "phone", apiLevel: "android-35" },
                },
              ],
              creatable: [],
            },
          },
        );
        assert.equal(hbSyncClaim.exitCode, 0);
        assert.equal(hbSyncClaim.lease?.serial, "emulator-5578");
      } finally {
        fs.rmSync(hbSyncDir, { recursive: true, force: true });
      }

      // 14. Ownerless lock directory containing an abandoned owner.json.tmp.* file is safely recovered
      const abandonedTmpDir = makeTempStateDir();
      try {
        const lockDirPath = path.join(abandonedTmpDir, "atc.lock");
        fs.mkdirSync(lockDirPath, { recursive: true, mode: 0o700 });
        const abandonedTmpFile = path.join(
          lockDirPath,
          `owner.json.tmp.${process.pid}.abandoned-nonce`,
        );
        fs.writeFileSync(abandonedTmpFile, '{"pid":99999999,"nonce":"partial"', "utf8");
        const pastSec = Math.floor((Date.now() - 10_000) / 1000);
        fs.utimesSync(abandonedTmpFile, pastSec, pastSec);
        fs.utimesSync(lockDirPath, pastSec, pastSec);

        const recoveredFromTmp = acquireLock(abandonedTmpDir, 3500);
        assert.ok(recoveredFromTmp.nonce);
        assert.equal(verifyLockOwnership(recoveredFromTmp), true);
        assert.equal(fs.existsSync(abandonedTmpFile), false);
        releaseLock(recoveredFromTmp);
      } finally {
        fs.rmSync(abandonedTmpDir, { recursive: true, force: true });
      }

      // 15. Concurrent stale-lock breakers cannot remove a newly acquired lock
      const raceLockDir = makeTempStateDir();
      try {
        const lockModUrl = new URL("../src/lock.mjs", import.meta.url).href;
        for (let round = 0; round < 3; round++) {
          const staleLockPath = path.join(raceLockDir, "atc.lock");
          fs.mkdirSync(staleLockPath, { recursive: true, mode: 0o700 });
          fs.writeFileSync(
            path.join(staleLockPath, "owner.json"),
            JSON.stringify({
              pid: 99999999,
              createdAtMs: Date.now() - 60_000,
              staleAfterMs: 10_000,
              nonce: `stale-round-${round}`,
            }),
            "utf8",
          );

          const workerCount = 5;
          const sab = new SharedArrayBuffer(20);
          const syncView = new Int32Array(sab);
          // syncView[0] = ready count, syncView[1] = go flag, syncView[2] = active holders, syncView[3] = max concurrent holders, syncView[4] = error count
          const workerCode = `
            const { workerData, parentPort } = require("node:worker_threads");
            const view = new Int32Array(workerData.sab);
            import(workerData.lockModUrl)
              .then(({ acquireLock, verifyLockOwnership, releaseLock, sleepSync }) => {
                Atomics.add(view, 0, 1);
                Atomics.notify(view, 0);
                const waitStart = Date.now();
                while (Atomics.load(view, 1) === 0 && Date.now() - waitStart < 5000) {
                  Atomics.wait(view, 1, 0, 50);
                }
                const handle = acquireLock(workerData.stateDir, 6000);
                const activeNow = Atomics.add(view, 2, 1) + 1;
                let prevMax = Atomics.load(view, 3);
                while (activeNow > prevMax) {
                  Atomics.compareExchange(view, 3, prevMax, activeNow);
                  prevMax = Atomics.load(view, 3);
                }
                const ownedStart = verifyLockOwnership(handle);
                sleepSync(60);
                const ownedEnd = verifyLockOwnership(handle);
                Atomics.sub(view, 2, 1);
                releaseLock(handle);
                parentPort.postMessage({ ownedStart, ownedEnd, nonce: handle.nonce });
              })
              .catch((err) => {
                Atomics.add(view, 4, 1);
                Atomics.notify(view, 0);
                throw err;
              });
          `;

          const workers = [];
          const resultsPromise = Promise.all(
            Array.from({ length: workerCount }, () => {
              return new Promise((resolve, reject) => {
                const w = new Worker(workerCode, {
                  eval: true,
                  workerData: {
                    lockModUrl,
                    stateDir: raceLockDir,
                    sab,
                  },
                });
                workers.push(w);
                w.once("message", resolve);
                w.once("error", reject);
                w.once("exit", (code) => {
                  if (code !== 0) {
                    reject(new Error(`Lock contender worker exited with code ${code}`));
                  }
                });
              });
            }),
          );

          const readyDeadlineMs = Date.now() + 5000;
          while (
            Atomics.load(syncView, 0) < workerCount &&
            Atomics.load(syncView, 4) === 0 &&
            Date.now() < readyDeadlineMs
          ) {
            Atomics.wait(syncView, 0, Atomics.load(syncView, 0), 20);
          }
          Atomics.store(syncView, 1, 1);
          Atomics.notify(syncView, 1, workerCount);

          const workerResults = await resultsPromise;
          assert.equal(workerResults.length, workerCount);
          assert.equal(Atomics.load(syncView, 3), 1, "At most 1 contender may hold the lock at a time");
          for (const r of workerResults) {
            assert.equal(r.ownedStart, true);
            assert.equal(r.ownedEnd, true);
            assert.notEqual(r.nonce, `stale-round-${round}`);
          }
        }
      } finally {
        fs.rmSync(raceLockDir, { recursive: true, force: true });
      }

      // 16. Abandoned breaker claim (terminated between claim creation and lock removal) is recovered
      const abandonedClaimStateDir = makeTempStateDir();
      try {
        const staleLockPath = path.join(abandonedClaimStateDir, "atc.lock");
        fs.mkdirSync(staleLockPath, { recursive: true, mode: 0o700 });
        const staleOwnerPath = path.join(staleLockPath, "owner.json");
        const staleCreatedAtMs = Date.now() - 60_000;
        const staleNonce = "abandoned-claim-target";
        fs.writeFileSync(
          staleOwnerPath,
          JSON.stringify({
            pid: 99999999,
            createdAtMs: staleCreatedAtMs,
            staleAfterMs: 10_000,
            nonce: staleNonce,
          }),
          "utf8",
        );
        const dirSt = fs.lstatSync(staleLockPath);
        const ownerSt = fs.lstatSync(staleOwnerPath);
        const token = `nonce.${dirSt.ino || 0}.${ownerSt.ino || 0}.${Math.trunc(staleCreatedAtMs)}.${staleNonce}`;
        const claimDir = path.join(abandonedClaimStateDir, `atc.lock.stale.${token}`);
        fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(claimDir, "breaker.dead-breaker.json"),
          JSON.stringify({
            pid: 99999998,
            createdAtMs: Date.now() - 10_000,
            nonce: "dead-breaker",
          }),
          "utf8",
        );

        const recoveredAfterDeadBreaker = acquireLock(abandonedClaimStateDir, 2000);
        assert.equal(verifyLockOwnership(recoveredAfterDeadBreaker), true);
        assert.notEqual(recoveredAfterDeadBreaker.nonce, staleNonce);
        releaseLock(recoveredAfterDeadBreaker);
      } finally {
        fs.rmSync(abandonedClaimStateDir, { recursive: true, force: true });
      }

      // 17. Deterministic pause of Breaker A immediately before renameSync (>2s) does not allow Breaker B to expire A's live claim or replace lock
      const pausedBreakerDir = makeTempStateDir();
      try {
        const staleLockPath = path.join(pausedBreakerDir, "atc.lock");
        fs.mkdirSync(staleLockPath, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(staleLockPath, "owner.json"),
          JSON.stringify({
            pid: 99999999,
            createdAtMs: Date.now() - 60_000,
            staleAfterMs: 10_000,
            nonce: "paused-breaker-stale-nonce",
          }),
          "utf8",
        );

        const lockModUrl = new URL("../src/lock.mjs", import.meta.url).href;
        const pauseSab = new SharedArrayBuffer(16);
        const pauseView = new Int32Array(pauseSab);
        // pauseView[0] = 1 when A reaches beforeBreakRename, pauseView[1] = active holders, pauseView[2] = max holders
        const workerBCode = `
          const { workerData, parentPort } = require("node:worker_threads");
          const view = new Int32Array(workerData.sab);
          import(workerData.lockModUrl)
            .then(({ acquireLock, verifyLockOwnership, releaseLock, sleepSync }) => {
              const waitStart = Date.now();
              while (Atomics.load(view, 0) === 0 && Date.now() - waitStart < 5000) {
                Atomics.wait(view, 0, 0, 20);
              }
              const handleB = acquireLock(workerData.stateDir, 6000);
              const acquiredAtMs = Date.now();
              const activeNow = Atomics.add(view, 1, 1) + 1;
              let prevMax = Atomics.load(view, 2);
              while (activeNow > prevMax) {
                Atomics.compareExchange(view, 2, prevMax, activeNow);
                prevMax = Atomics.load(view, 2);
              }
              const ownedStart = verifyLockOwnership(handleB);
              sleepSync(40);
              const ownedEnd = verifyLockOwnership(handleB);
              Atomics.sub(view, 1, 1);
              releaseLock(handleB);
              parentPort.postMessage({ ownedStart, ownedEnd, acquiredAtMs });
            })
            .catch((err) => {
              throw err;
            });
        `;

        const workerBPromise = new Promise((resolve, reject) => {
          const w = new Worker(workerBCode, {
            eval: true,
            workerData: {
              lockModUrl,
              stateDir: pausedBreakerDir,
              sab: pauseSab,
            },
          });
          w.once("message", resolve);
          w.once("error", reject);
          w.once("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`Worker B exited with code ${code}`));
            }
          });
        });

        let pausedBeforeRename = false;
        let pauseEndedAtMs = 0;
        const handleA = acquireLock(pausedBreakerDir, 6000, "atc.lock", 10_000, {
          beforeBreakRename: () => {
            pausedBeforeRename = true;
            Atomics.store(pauseView, 0, 1);
            Atomics.notify(pauseView, 0, 1);
            // Pause longer than MISSING_OWNER_STALE_MS (2000ms) right before renameSync
            sleepSync(2200);
            pauseEndedAtMs = Date.now();
          },
        });
        assert.equal(pausedBeforeRename, true);
        const activeA = Atomics.add(pauseView, 1, 1) + 1;
        let prevMaxA = Atomics.load(pauseView, 2);
        while (activeA > prevMaxA) {
          Atomics.compareExchange(pauseView, 2, prevMaxA, activeA);
          prevMaxA = Atomics.load(pauseView, 2);
        }
        assert.equal(verifyLockOwnership(handleA), true);
        sleepSync(50);
        assert.equal(verifyLockOwnership(handleA), true);
        Atomics.sub(pauseView, 1, 1);
        releaseLock(handleA);

        const resB = await workerBPromise;
        assert.equal(resB.ownedStart, true);
        assert.equal(resB.ownedEnd, true);
        assert.equal(Atomics.load(pauseView, 2), 1);
        assert.ok(
          resB.acquiredAtMs >= pauseEndedAtMs,
          "Worker B must not break or acquire the lock while Breaker A is paused before renameSync",
        );
      } finally {
        fs.rmSync(pausedBreakerDir, { recursive: true, force: true });
      }

      // 18. POSIX resolveExecutable skips non-executable files in PATH and fallback directories
      if (process.platform !== "win32") {
        const fakeHome = makeTempStateDir();
        try {
          const localBin = path.join(fakeHome, ".local", "bin");
          const sdkPlatformTools = path.join(fakeHome, "Library", "Android", "sdk", "platform-tools");
          fs.mkdirSync(localBin, { recursive: true });
          fs.mkdirSync(sdkPlatformTools, { recursive: true });
          const nonExecAdb = path.join(localBin, "adb");
          const execAdb = path.join(sdkPlatformTools, "adb");
          fs.writeFileSync(nonExecAdb, "#!/bin/sh\n", "utf8");
          fs.chmodSync(nonExecAdb, 0o644);
          fs.writeFileSync(execAdb, "#!/bin/sh\n", "utf8");
          fs.chmodSync(execAdb, 0o755);

          const resolvedPosixAdb = resolveExecutable(
            "adb",
            { PATH: localBin, HOME: fakeHome },
            fakeHome,
            "darwin",
          );
          assert.equal(resolvedPosixAdb.executable, execAdb);

          // Relative and empty POSIX PATH entries are resolved against child cwd before falling back to SDK
          const childCwd = path.join(fakeHome, "project");
          const relToolsDir = path.join(childCwd, "tools");
          fs.mkdirSync(relToolsDir, { recursive: true });
          const relWrapperAdb = path.join(relToolsDir, "adb");
          fs.writeFileSync(relWrapperAdb, "#!/bin/sh\n", "utf8");
          fs.chmodSync(relWrapperAdb, 0o755);

          const resolvedRelPathAdb = resolveExecutable(
            "adb",
            { PATH: `tools:${localBin}`, HOME: fakeHome },
            childCwd,
            "darwin",
          );
          assert.equal(resolvedRelPathAdb.executable, "adb");

          const resolvedEmptyEntryAdb = resolveExecutable(
            "adb",
            { PATH: `:${localBin}`, HOME: fakeHome },
            relToolsDir,
            "darwin",
          );
          assert.equal(resolvedEmptyEntryAdb.executable, "adb");

          // Empty PATH="" checks child cwd before SDK fallback
          const resolvedEmptyPathWithCwdAdb = resolveExecutable(
            "adb",
            { PATH: "", HOME: fakeHome },
            relToolsDir,
            "darwin",
          );
          assert.equal(resolvedEmptyPathWithCwdAdb.executable, "adb");

          const resolvedEmptyPathNoCwdAdb = resolveExecutable(
            "adb",
            { PATH: "", HOME: fakeHome },
            childCwd,
            "darwin",
          );
          assert.equal(resolvedEmptyPathNoCwdAdb.executable, execAdb);

          // Unset PATH searches POSIX default path (/usr/bin:/bin) before SDK fallback
          const resolvedUnsetPathWithDefaultHit = resolveExecutable(
            "adb",
            { HOME: fakeHome },
            childCwd,
            "darwin",
            `${relToolsDir}:/bin`,
          );
          assert.equal(resolvedUnsetPathWithDefaultHit.executable, "adb");

          const resolvedUnsetPathFallback = resolveExecutable(
            "adb",
            { HOME: fakeHome },
            childCwd,
            "darwin",
            localBin,
          );
          assert.equal(resolvedUnsetPathFallback.executable, execAdb);
        } finally {
          fs.rmSync(fakeHome, { recursive: true, force: true });
        }
      }

      // 19. Stale-claim sweepers retain claim directories with a live breaker even past 60s
      const sweepClaimDir = makeTempStateDir();
      try {
        const liveClaimPath = path.join(sweepClaimDir, "atc.lock.stale.owner.live");
        const doneClaimPath = path.join(sweepClaimDir, "atc.lock.stale.owner.done");
        fs.mkdirSync(liveClaimPath, { recursive: true });
        fs.mkdirSync(doneClaimPath, { recursive: true });
        fs.writeFileSync(
          path.join(liveClaimPath, "breaker.live-nonce.json"),
          JSON.stringify({
            pid: process.pid,
            createdAtMs: Date.now() - 120_000,
            nonce: "live-nonce",
          }),
          "utf8",
        );
        fs.writeFileSync(path.join(doneClaimPath, "done"), "1", "utf8");
        const oldSec = Math.floor((Date.now() - 120_000) / 1000);
        fs.utimesSync(path.join(doneClaimPath, "done"), oldSec, oldSec);
        fs.utimesSync(liveClaimPath, oldSec, oldSec);
        fs.utimesSync(doneClaimPath, oldSec, oldSec);

        sweepOrphanFiles(sweepClaimDir, Date.now());
        assert.equal(fs.existsSync(liveClaimPath), true);
        assert.equal(fs.existsSync(doneClaimPath), false);
      } finally {
        fs.rmSync(sweepClaimDir, { recursive: true, force: true });
      }

      // 20. Windows stopping reservation with awaitOfflineReconcile is retained past deadlineMs and against pre-stopping stale discovery until fresh reconcileOfflineLeases confirms offline + no lock files
      const winReconcileDir = makeTempStateDir();
      try {
        const winAvdDir = path.join(avdHome, "Pixel_Win_Reconcile.avd");
        fs.mkdirSync(winAvdDir, { recursive: true });
        const qemuLockPath = path.join(winAvdDir, "hardware-qemu.ini.lock");
        fs.writeFileSync(qemuLockPath, "locked", "utf8");

        // Stale discovery collected BEFORE the stopping transition
        const stalePreStopInventory = {
          avdHome,
          discoveredAtMs: Date.now() - 5000,
          fleetEpoch: 0,
          running: [],
          offline: [
            {
              deviceKey: "avd:Pixel_Win_Reconcile",
              kind: "emulator",
              avd: "Pixel_Win_Reconcile",
              online: false,
            },
          ],
          probes: { emulatorListOk: true, adbDevicesOk: true },
        };

        withStateTransaction(winReconcileDir, (s, { now }) => {
          s.fleetEpoch = 2;
          s.leases["avd:Pixel_Win_Reconcile"] = {
            leaseId: "lease_win_reconcile",
            deviceKey: "avd:Pixel_Win_Reconcile",
            kind: "emulator",
            avd: "Pixel_Win_Reconcile",
            serial: "emulator-5582",
            state: "stopping",
            awaitOfflineReconcile: true,
            stoppingAtMs: now - 1000,
            reconcileAfterMs: now - 1000,
            stoppingEpoch: 2,
            workerPid: null,
            workerPids: [],
            sessionId: "win-reconcile-sess",
            claimedAtMs: now - 120_000,
            deadlineMs: now - 60_000,
          };
          return { mutated: true };
        });

        // GC must NOT expire an awaitOfflineReconcile stopping reservation even past deadlineMs
        withStateTransaction(winReconcileDir, () => ({ mutated: false }));
        assert.ok(readState(winReconcileDir).leases["avd:Pixel_Win_Reconcile"]);

        // Reconcile while hardware-qemu.ini.lock still exists must retain the stopping reservation
        withStateTransaction(winReconcileDir, (s, { now }) => {
          reconcileOfflineLeases(
            s,
            {
              avdHome,
              discoveredAtMs: now,
              fleetEpoch: 2,
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Win_Reconcile",
                  kind: "emulator",
                  avd: "Pixel_Win_Reconcile",
                  online: false,
                },
              ],
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            "other-sess",
            now,
          );
          return { mutated: true };
        });
        assert.ok(
          readState(winReconcileDir).leases["avd:Pixel_Win_Reconcile"],
          "Stopping reservation must remain held while hardware-qemu.ini.lock is present",
        );

        // Remove lock file, then verify interleaved stale pre-stopping discovery STILL cannot clear the stopping reservation
        fs.rmSync(qemuLockPath, { force: true });
        withStateTransaction(winReconcileDir, (s, { now }) => {
          reconcileOfflineLeases(s, stalePreStopInventory, "other-sess", now);
          return { mutated: true };
        });
        assert.ok(
          readState(winReconcileDir).leases["avd:Pixel_Win_Reconcile"],
          "Stale discovery collected before stoppingAtMs/stoppingEpoch must not clear stopping reservation",
        );

        // Once hardware-qemu.ini.lock is removed and fresh discovery confirms emulator is offline, reconcileOfflineLeases clears it
        withStateTransaction(winReconcileDir, (s, { now }) => {
          reconcileOfflineLeases(
            s,
            {
              avdHome,
              discoveredAtMs: now + 10,
              fleetEpoch: 2,
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Win_Reconcile",
                  kind: "emulator",
                  avd: "Pixel_Win_Reconcile",
                  online: false,
                },
              ],
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            "other-sess",
            now + 10,
          );
          return { mutated: true };
        });
        const postReconcileState = readState(winReconcileDir);
        assert.equal(postReconcileState.leases["avd:Pixel_Win_Reconcile"], undefined);
        assert.ok(postReconcileState.fleetEpoch > 2);
        assert.equal(
          postReconcileState.stoppedDevices?.["avd:Pixel_Win_Reconcile"]?.epoch,
          postReconcileState.fleetEpoch,
        );
        assert.equal(
          postReconcileState.stoppedDevices?.["serial:emulator-5582"]?.epoch,
          postReconcileState.fleetEpoch,
        );

        // Unmapped serial-only Windows stop waits for android emulator list --long serial to go offline even after adb devices drops it
        withStateTransaction(winReconcileDir, (s, { now }) => {
          s.leases["serial:emulator-5590"] = {
            leaseId: "lease_unmapped_win",
            deviceKey: "serial:emulator-5590",
            kind: "emulator",
            avd: null,
            serial: "emulator-5590",
            state: "active",
            workerPid: null,
            workerPids: [],
            sessionId: "unmapped-win-sess",
            claimedAtMs: now,
            renewedAtMs: now,
            expiresAtMs: now + 600_000,
          };
          return { mutated: true };
        });
        let listPolls = 0;
        const unmappedFreeRes = cmdFree(
          winReconcileDir,
          "lease_unmapped_win",
          { session: "unmapped-win-sess", stop: true },
          {
            platform: "win32",
            avdHome,
            runner: (cmd, args) => {
              if (cmd === "adb" && args.includes("emu") && args.includes("kill")) {
                return { status: 0, stdout: "OK\n", stderr: "" };
              }
              if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
                listPolls += 1;
                if (listPolls === 1) {
                  return {
                    status: 0,
                    stdout:
                      "AVD ID                   AVD Name                      API Level      Status         Serial\nPixel_Win_Reconcile      Pixel Win Reconcile           android-35     Online         emulator-5590\n",
                    stderr: "",
                  };
                }
                return {
                  status: 0,
                  stdout:
                    "AVD ID                   AVD Name                      API Level      Status         Serial\nPixel_Win_Reconcile      Pixel Win Reconcile           android-35     Offline\n",
                  stderr: "",
                };
              }
              if (cmd === "adb" && args[0] === "devices") {
                return { status: 0, stdout: "List of devices attached\n", stderr: "" };
              }
              return { status: 0, stdout: "", stderr: "" };
            },
          },
        );
        assert.equal(unmappedFreeRes.exitCode, 0);
        assert.ok(listPolls >= 2, "Expected waitForEmulatorOffline to wait for listed serial to go offline");

        // Unmapped serial-only stopping lease with awaitOfflineReconcile retains reservation while an unleased offline AVD holds lock files, while ignoring lock files of another leased/online AVD
        const otherOnlineAvdDir = path.join(avdHome, "Pixel_Other_Online.avd");
        fs.mkdirSync(otherOnlineAvdDir, { recursive: true });
        fs.writeFileSync(path.join(otherOnlineAvdDir, "hardware-qemu.ini.lock"), "locked", "utf8");
        fs.writeFileSync(qemuLockPath, "locked", "utf8");

        withStateTransaction(winReconcileDir, (s, { now }) => {
          s.fleetEpoch = 5;
          s.leases["serial:emulator-5592"] = {
            leaseId: "lease_unmapped_stopping",
            deviceKey: "serial:emulator-5592",
            kind: "emulator",
            avd: null,
            serial: "emulator-5592",
            state: "stopping",
            awaitOfflineReconcile: true,
            stoppingAtMs: now - 1000,
            reconcileAfterMs: now - 1000,
            stoppingEpoch: 5,
            workerPid: null,
            workerPids: [],
            sessionId: "unmapped-stop-sess",
            claimedAtMs: now - 120_000,
            deadlineMs: now - 60_000,
          };
          return { mutated: true };
        });

        withStateTransaction(winReconcileDir, (s, { now }) => {
          reconcileOfflineLeases(
            s,
            {
              avdHome,
              discoveredAtMs: now + 10,
              fleetEpoch: 5,
              running: [
                {
                  deviceKey: "avd:Pixel_Other_Online",
                  kind: "emulator",
                  avd: "Pixel_Other_Online",
                  serial: "emulator-5554",
                  online: true,
                },
              ],
              offline: [
                {
                  deviceKey: "avd:Pixel_Win_Reconcile",
                  kind: "emulator",
                  avd: "Pixel_Win_Reconcile",
                  online: false,
                },
              ],
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            "other-sess",
            now + 10,
          );
          return { mutated: true };
        });
        assert.ok(
          readState(winReconcileDir).leases["serial:emulator-5592"],
          "Unmapped stopping lease must remain held while an offline AVD still holds lock files",
        );

        // Once the offline AVD's lock file is removed (even though Pixel_Other_Online still has its lock file), the unmapped stopping lease clears
        fs.rmSync(qemuLockPath, { force: true });
        withStateTransaction(winReconcileDir, (s, { now }) => {
          reconcileOfflineLeases(
            s,
            {
              avdHome,
              discoveredAtMs: now + 20,
              fleetEpoch: 5,
              running: [
                {
                  deviceKey: "avd:Pixel_Other_Online",
                  kind: "emulator",
                  avd: "Pixel_Other_Online",
                  serial: "emulator-5554",
                  online: true,
                },
              ],
              offline: [
                {
                  deviceKey: "avd:Pixel_Win_Reconcile",
                  kind: "emulator",
                  avd: "Pixel_Win_Reconcile",
                  online: false,
                },
              ],
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            "other-sess",
            now + 20,
          );
          return { mutated: true };
        });
        assert.equal(readState(winReconcileDir).leases["serial:emulator-5592"], undefined);
      } finally {
        fs.rmSync(winReconcileDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(rollbackHoldDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(avdHome, { recursive: true, force: true });
  }
});

test("regression: Astra review #20 hardening (offline lock safety, state I/O vs corruption, recycled serials, process group tracking, partial boot cleanup, wrapped ADB & piped sh rewrite)", async () => {
  const dir = makeTempStateDir();
  const avdHome = fs.mkdtempSync(path.join(os.tmpdir(), "atc-avd-r20-"));

  try {
    // 1. Codex 4237521395: releaseLock removes its .break-claim.* directory immediately
    const lockH = acquireLock(dir, 1000);
    releaseLock(lockH);
    assert.equal(verifyLockOwnership(lockH), false);
    const leftoverBreakClaims = fs
      .readdirSync(dir)
      .filter((name) => name.includes(".break-claim."));
    assert.deepEqual(
      leftoverBreakClaims,
      [],
      "releaseLock must remove its .break-claim.* directory on completion",
    );

    // 2. Finding #1: Offline candidates excluded when probes failed or runtime lock files exist
    const lockedAvdDir = path.join(avdHome, "Pixel_Locked.avd");
    fs.mkdirSync(lockedAvdDir, { recursive: true });
    fs.writeFileSync(path.join(lockedAvdDir, "hardware-qemu.ini.lock"), "pid=123", "utf8");
    const cleanAvdDir = path.join(avdHome, "Pixel_Clean.avd");
    fs.mkdirSync(cleanAvdDir, { recursive: true });

    const reqAny = {
      kind: "emulator",
      deviceType: null,
      apiSpec: null,
      services: null,
      play: null,
      abi: null,
      avd: null,
      serial: null,
      cold: false,
      wipeData: false,
      snapshotLoad: null,
      createIfMissing: false,
      resetApp: null,
      saveSnapshotOnFree: null,
      ttlSec: 300,
      waitSec: 0,
      reason: "",
    };

    withStateTransaction(dir, (state, { now }) => {
      // When adbDevicesOk is false, offline candidates must not be selected
      const probeFailSel = selectCandidateUnderLock(
        state,
        {
          avdHome,
          running: [],
          offline: [
            {
              deviceKey: "avd:Pixel_Clean",
              kind: "emulator",
              avd: "Pixel_Clean",
              online: false,
              apiLevel: 35,
              deviceType: "phone",
              services: "google_apis_playstore",
              play: true,
              abi: "arm64-v8a",
              ramMb: 2048,
              snapshots: ["clean_boot"],
            },
          ],
          creatable: [],
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCount: 8 },
          probes: { emulatorListOk: true, adbDevicesOk: false },
        },
        reqAny,
        null,
        now,
        "sess-probe-fail",
      );
      assert.equal(probeFailSel.priority, null);
      assert.equal(probeFailSel.candidate, undefined);

      // When probes succeed, locked offline AVD is skipped while clean offline AVD is selected
      const lockCheckSel = selectCandidateUnderLock(
        state,
        {
          avdHome,
          running: [],
          offline: [
            {
              deviceKey: "avd:Pixel_Locked",
              kind: "emulator",
              avd: "Pixel_Locked",
              online: false,
              apiLevel: 35,
              deviceType: "phone",
              services: "google_apis_playstore",
              play: true,
              abi: "arm64-v8a",
              ramMb: 2048,
              snapshots: ["clean_boot"],
            },
            {
              deviceKey: "avd:Pixel_Clean",
              kind: "emulator",
              avd: "Pixel_Clean",
              online: false,
              apiLevel: 35,
              deviceType: "phone",
              services: "google_apis_playstore",
              play: true,
              abi: "arm64-v8a",
              ramMb: 2048,
              snapshots: ["clean_boot"],
            },
          ],
          creatable: [],
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCount: 8 },
          probes: { emulatorListOk: true, adbDevicesOk: true },
        },
        reqAny,
        null,
        now,
        "sess-lock-check",
      );
      assert.equal(lockCheckSel.priority, 2);
      assert.equal(lockCheckSel.candidate.avd, "Pixel_Clean");
      return { mutated: false };
    });

    // 3. Finding #2: readState propagates filesystem I/O errors instead of quarantining valid state
    const ioErrDir = makeTempStateDir();
    try {
      withStateTransaction(ioErrDir, (s) => {
        s.leases["avd:KeepMe"] = {
          leaseId: "lease_keep_me",
          deviceKey: "avd:KeepMe",
          kind: "emulator",
          avd: "KeepMe",
          serial: "emulator-5554",
          state: "active",
          sessionId: "keep-sess",
        };
        return { mutated: true };
      });
      // Replace state.json with a directory so fs.readFileSync throws EISDIR (non-ENOENT I/O error)
      const stateFile = path.join(ioErrDir, "state.json");
      const savedBytes = fs.readFileSync(stateFile, "utf8");
      fs.rmSync(stateFile, { force: true });
      fs.mkdirSync(stateFile);
      assert.throws(
        () => readState(ioErrDir),
        (err) => err && (err.code === "EISDIR" || err.message.includes("illegal operation")),
      );
      fs.rmdirSync(stateFile);
      fs.writeFileSync(stateFile, savedBytes, "utf8");
      assert.equal(readState(ioErrDir).leases["avd:KeepMe"]?.leaseId, "lease_keep_me");
    } finally {
      fs.rmSync(ioErrDir, { recursive: true, force: true });
    }

    // 4. Finding #3 & #4: reconcileOfflineLeases handles recycled serials and skips pre-activation snapshots
    const reconcileDir = makeTempStateDir();
    try {
      const baseNow = Date.now();
      withStateTransaction(reconcileDir, (s) => {
        s.fleetEpoch = 10;
        s.leases["avd:Pixel_Crashed"] = {
          leaseId: "lease_crashed_avd",
          deviceKey: "avd:Pixel_Crashed",
          kind: "emulator",
          avd: "Pixel_Crashed",
          serial: "emulator-5554",
          state: "active",
          sessionId: "sess-a",
          claimedAtMs: baseNow - 30_000,
          activatedAtMs: baseNow - 20_000,
          activatedEpoch: 5,
          expiresAtMs: baseNow + 300_000,
        };
        s.leases["avd:Pixel_Just_Booted"] = {
          leaseId: "lease_just_booted",
          deviceKey: "avd:Pixel_Just_Booted",
          kind: "emulator",
          avd: "Pixel_Just_Booted",
          serial: "emulator-5556",
          state: "active",
          sessionId: "sess-b",
          claimedAtMs: baseNow - 5_000,
          activatedAtMs: baseNow - 1_000,
          activatedEpoch: 10,
          expiresAtMs: baseNow + 300_000,
        };
        return { mutated: true };
      });

      // Pre-activation snapshot (discoveredAtMs < activatedAtMs and fleetEpoch < activatedEpoch) must NOT mark Pixel_Just_Booted offline
      withStateTransaction(reconcileDir, (s) => {
        reconcileOfflineLeases(
          s,
          {
            avdHome,
            discoveredAtMs: baseNow - 2_000,
            fleetEpoch: 9,
            running: [
              // emulator-5554 is now running Pixel_Other, NOT Pixel_Crashed!
              {
                deviceKey: "avd:Pixel_Other",
                kind: "emulator",
                avd: "Pixel_Other",
                serial: "emulator-5554",
                online: true,
              },
            ],
            offline: [
              { deviceKey: "avd:Pixel_Crashed", kind: "emulator", avd: "Pixel_Crashed", online: false },
              { deviceKey: "avd:Pixel_Just_Booted", kind: "emulator", avd: "Pixel_Just_Booted", online: false },
            ],
            probes: { emulatorListOk: true, adbDevicesOk: true },
          },
          "sess-observer",
          baseNow,
        );
        return { mutated: true };
      });

      let recState = readState(reconcileDir);
      assert.equal(
        recState.leases["avd:Pixel_Just_Booted"].firstSeenOfflineAtMs,
        undefined,
        "Pre-activation snapshot must not mark newly activated lease as offline",
      );
      assert.equal(
        recState.leases["avd:Pixel_Crashed"].serial,
        null,
        "Recycled serial occupied by another AVD must be cleared from crashed AVD lease",
      );
      assert.ok(
        recState.leases["avd:Pixel_Crashed"].firstSeenOfflineAtMs,
        "Crashed AVD whose serial was recycled by another AVD must start offline grace timer",
      );

      // After recovery grace window, second post-activation snapshot revokes Pixel_Crashed while updating Pixel_Just_Booted if it moved to emulator-5558
      withStateTransaction(reconcileDir, (s) => {
        s.config.offlineGraceMs = 5000;
        reconcileOfflineLeases(
          s,
          {
            avdHome,
            discoveredAtMs: baseNow + 6_000,
            fleetEpoch: 10,
            running: [
              {
                deviceKey: "avd:Pixel_Other",
                kind: "emulator",
                avd: "Pixel_Other",
                serial: "emulator-5554",
                online: true,
              },
              {
                deviceKey: "avd:Pixel_Just_Booted",
                kind: "emulator",
                avd: "Pixel_Just_Booted",
                serial: "emulator-5558",
                online: true,
              },
            ],
            offline: [
              { deviceKey: "avd:Pixel_Crashed", kind: "emulator", avd: "Pixel_Crashed", online: false },
            ],
            probes: { emulatorListOk: true, adbDevicesOk: true },
          },
          "sess-observer-2",
          baseNow + 6_000,
        );
        return { mutated: true };
      });
      recState = readState(reconcileDir);
      assert.equal(recState.leases["avd:Pixel_Crashed"], undefined);
      assert.equal(recState.leases["avd:Pixel_Just_Booted"].serial, "emulator-5558");
    } finally {
      fs.rmSync(reconcileDir, { recursive: true, force: true });
    }

    // 5. Finding #5: typed-op execution (spawnWithHeartbeat) tracks the child process group and waits for
    // backgrounded subchildren before releasing lease worker registrations (POSIX: fake adb backgrounds a job)
    if (process.platform !== "win32") {
      const execDir = makeTempStateDir();
      try {
        withStateTransaction(execDir, (s, { now }) => {
          s.leases["avd:Pixel_Exec"] = {
            leaseId: "lease_exec_pgid",
            deviceKey: "avd:Pixel_Exec",
            kind: "emulator",
            avd: "Pixel_Exec",
            serial: "emulator-5554",
            state: "active",
            sessionId: "exec-pg-sess",
            claimedAtMs: now,
            renewedAtMs: now,
            expiresAtMs: now + 60_000,
          };
          return { mutated: true };
        });
        const markerFile = path.join(execDir, "bg-done.txt");
        const pgEnv = makeFakeToolEnv(execDir, {
          adb: `(sleep 0.35; echo done > "${markerFile}") >/dev/null 2>&1 </dev/null &\nexit 0`,
        });
        const t0 = Date.now();
        const execRes = await cmdExec(
          execDir,
          ["android", "logcat", "--session", "exec-pg-sess", "--json"],
          { env: pgEnv },
        );
        const elapsedMs = Date.now() - t0;
        assert.equal(execRes.exitCode, 0, execRes.error);
        assert.ok(
          fs.existsSync(markerFile),
          `Expected spawnWithHeartbeat to wait for background process group member to exit (elapsed=${elapsedMs}ms)`,
        );
        const afterLease = readState(execDir).leases["avd:Pixel_Exec"];
        assert.deepEqual(afterLease.workerPids || [], []);
        assert.deepEqual(afterLease.workerPgids || [], []);
      } finally {
        fs.rmSync(execDir, { recursive: true, force: true });
      }
    }

    // 6. Finding #6: Failed/timed-out start that left a partially started emulator stops it during rollback
    const partialBootDir = makeTempStateDir();
    try {
      const partialAvdDir = path.join(avdHome, "Pixel_Partial.avd");
      fs.mkdirSync(partialAvdDir, { recursive: true });
      let stopCalls = 0;
      const claimRes = cmdClaim(
        partialBootDir,
        { avd: "Pixel_Partial", session: "partial-sess", wait: 0, force: true },
        {
          avdHome,
          platform: "linux",
          runner: (cmd, args) => {
            if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
              // Simulate emulator spawning QEMU (creating lock file) before start command times out
              fs.writeFileSync(path.join(partialAvdDir, "hardware-qemu.ini.lock"), "pid=999", "utf8");
              return { status: 124, stdout: "", stderr: "Timed out waiting for boot" };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
              stopCalls += 1;
              fs.rmSync(path.join(partialAvdDir, "hardware-qemu.ini.lock"), { force: true });
              return { status: 0, stdout: "Stopped\n", stderr: "" };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
              const hasLock = fs.existsSync(path.join(partialAvdDir, "hardware-qemu.ini.lock"));
              return {
                status: 0,
                stdout: hasLock
                  ? "AVD ID                   AVD Name                      API Level      Status         Serial\nPixel_Partial            Pixel Partial                 android-35     Online         emulator-5566\n"
                  : "AVD ID                   AVD Name                      API Level      Status         Serial\nPixel_Partial            Pixel Partial                 android-35     Offline\n",
                stderr: "",
              };
            }
            if (cmd === "adb" && args[0] === "devices") {
              return { status: 0, stdout: "List of devices attached\n", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.notEqual(claimRes.exitCode, 0);
      assert.ok(stopCalls >= 1, "Failed start that left lock files/online AVD must stop the partially started emulator");
      assert.equal(readState(partialBootDir).leases["avd:Pixel_Partial"], undefined);
    } finally {
      fs.rmSync(partialBootDir, { recursive: true, force: true });
    }

    // 8. Finding #9: Windows discoverFleet falls back to emulator -list-avds when android emulator list is unavailable
    const winAvdDir = path.join(avdHome, "Pixel_Win_Fallback.avd");
    fs.mkdirSync(winAvdDir, { recursive: true });
    fs.writeFileSync(
      path.join(avdHome, "Pixel_Win_Fallback.ini"),
      `target=android-35\npath=${winAvdDir}\n`,
      "utf8",
    );
    const winFleet = discoverFleet({
      platform: "win32",
      avdHome,
      runner: (cmd, args) => {
        if (cmd === "android" && args[0] === "emulator" && args[1] === "list") {
          return { status: 1, stdout: "", stderr: "error: unsupported on Windows" };
        }
        if (cmd === "emulator" && args[0] === "-list-avds") {
          return { status: 0, stdout: "Pixel_Win_Fallback\n", stderr: "" };
        }
        if (cmd === "adb" && args[0] === "devices") {
          return { status: 0, stdout: "List of devices attached\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(winFleet.probes.emulatorListOk, true);
    assert.ok(winFleet.offline.some((d) => d.avd === "Pixel_Win_Fallback"));

    // 9. Finding #10 & #11: cmdFree snapshot-load failure invalidates loadedSnapshot; cold reclaim preserves saveSnapshotOnFree
    const snapStateDir = makeTempStateDir();
    try {
      withStateTransaction(snapStateDir, (s, { now }) => {
        s.leases["avd:Pixel_Snap"] = {
          leaseId: "lease_snap_preserve",
          deviceKey: "avd:Pixel_Snap",
          kind: "emulator",
          avd: "Pixel_Snap",
          serial: "emulator-5554",
          state: "active",
          sessionId: "snap-sess",
          loadedSnapshot: "clean_boot",
          saveSnapshotOnFree: "after_run",
          reason: "preserve-me",
          claimedAtMs: now - 10_000,
          renewedAtMs: now,
          expiresAtMs: now + 900_000,
          profile: {
            apiLevel: 35,
            deviceType: "phone",
            services: "google_apis_playstore",
            play: true,
            abi: "arm64-v8a",
          },
        };
        return { mutated: true };
      });

      // Cold reclaim of own lease preserves saveSnapshotOnFree, reason, claimedAtMs, and longer expiresAtMs
      const coldReclaimRes = cmdClaim(
        snapStateDir,
        { avd: "Pixel_Snap", cold: true, session: "snap-sess", ttl: 60, force: true },
        {
          avdHome,
          platform: "linux",
          inventory: {
            avdHome,
            running: [
              {
                deviceKey: "avd:Pixel_Snap",
                kind: "emulator",
                avd: "Pixel_Snap",
                serial: "emulator-5554",
                online: true,
                apiLevel: 35,
                deviceType: "phone",
                services: "google_apis_playstore",
                play: true,
                abi: "arm64-v8a",
                ramMb: 2048,
                snapshots: ["clean_boot"],
              },
            ],
            offline: [],
            creatable: [],
            host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCount: 8 },
            probes: { emulatorListOk: true, adbDevicesOk: true },
          },
          runner: (cmd, args) => {
            if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
              return { status: 0, stdout: "Stopped\n", stderr: "" };
            }
            if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
              return { status: 0, stdout: "Started emulator-5554\n", stderr: "" };
            }
            if (cmd === "adb" && args.includes("getprop")) {
              return { status: 0, stdout: "1\n", stderr: "" };
            }
            return { status: 0, stdout: "emulator-5554\tdevice\n", stderr: "" };
          },
        },
      );
      assert.equal(coldReclaimRes.exitCode, 0);
      assert.equal(coldReclaimRes.lease.saveSnapshotOnFree, "after_run");
      assert.equal(coldReclaimRes.lease.reason, "preserve-me");

      // Mark loadedSnapshot as clean_boot, then fail cmdFree with --snapshot-load + --stop at stop step
      withStateTransaction(snapStateDir, (s) => {
        s.leases["avd:Pixel_Snap"].loadedSnapshot = "clean_boot";
        s.leases["avd:Pixel_Snap"].saveSnapshotOnFree = null;
        return { mutated: true };
      });
      const failedFreeLoadRes = cmdFree(
        snapStateDir,
        "lease_snap_preserve",
        { session: "snap-sess", snapshotLoad: "other_snap" },
        {
          avdHome,
          runner: (cmd, args) => {
            if (cmd === "adb" && args.includes("snapshot") && args.includes("load")) {
              return { status: 1, stdout: "", stderr: "KO: snapshot load failed" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      assert.equal(failedFreeLoadRes.exitCode, 1);
      assert.equal(
        readState(snapStateDir).leases["avd:Pixel_Snap"].loadedSnapshot,
        null,
        "Failed snapshot load during free must clear loadedSnapshot",
      );

      // 10. Astra #21 Finding #1: Concurrent boot-and-release recorded in state.bootedDevices prevents exceeding maxRunningEmulators
      const bootCapDir = makeTempStateDir();
      try {
        cmdConfig(bootCapDir, "set", "maxRunningEmulators", "1");
        // Session A boots Pixel_Boot_1 and immediately frees it warm
        const boot1Res = cmdClaim(
          bootCapDir,
          { avd: "Pixel_Boot_1", session: "boot-sess-a", wait: 0, force: true },
          {
            avdHome,
            platform: "linux",
            inventory: {
              avdHome,
              fleetEpoch: 0,
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Boot_1",
                  kind: "emulator",
                  avd: "Pixel_Boot_1",
                  online: false,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
                {
                  deviceKey: "avd:Pixel_Boot_2",
                  kind: "emulator",
                  avd: "Pixel_Boot_2",
                  online: false,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
              ],
              creatable: [],
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            runner: (cmd, args) => {
              if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                return { status: 0, stdout: "Started emulator-5554\n", stderr: "" };
              }
              return { status: 0, stdout: "emulator-5554\tdevice\n", stderr: "" };
            },
          },
        );
        assert.equal(boot1Res.exitCode, 0);
        assert.equal(cmdFree(bootCapDir, null, { session: "boot-sess-a" }).exitCode, 0);
        // Session B has a stale pre-boot inventory (fleetEpoch: 0, running: []) and requests Pixel_Boot_2 with autoStopIdleOnContention=false
        cmdConfig(bootCapDir, "set", "autoStopIdleOnContention", "false");
        const boot2Res = cmdClaim(
          bootCapDir,
          { avd: "Pixel_Boot_2", session: "boot-sess-b", wait: 0, force: true },
          {
            avdHome,
            platform: "linux",
            inventory: {
              avdHome,
              fleetEpoch: 0,
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Boot_1",
                  kind: "emulator",
                  avd: "Pixel_Boot_1",
                  online: false,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
                {
                  deviceKey: "avd:Pixel_Boot_2",
                  kind: "emulator",
                  avd: "Pixel_Boot_2",
                  online: false,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
              ],
              creatable: [],
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
          },
        );
        assert.equal(
          boot2Res.exitCode,
          2,
          "Stale inventory must incorporate state.bootedDevices so maxRunningEmulators=1 is enforced",
        );
      } finally {
        fs.rmSync(bootCapDir, { recursive: true, force: true });
      }

      // 11. Astra #21 Finding #3 & #4 & Codex 4237550997:
      // - Failed-restart recovery with serial: null succeeds when maxRunningEmulators=1
      // - Targetless cmdFree marks in-progress initial claims (activatedAtMs: null) with releaseOnWorkerExit
      // - Failed POSIX rollback stop sets awaitOfflineReconcile so GC does not drop the reservation
      const r21Dir = makeTempStateDir();
      try {
        cmdConfig(r21Dir, "set", "maxRunningEmulators", "1");
        withStateTransaction(r21Dir, (s, { now }) => {
          s.leases["avd:Pixel_Serial_Null"] = {
            leaseId: "lease_serial_null",
            deviceKey: "avd:Pixel_Serial_Null",
            kind: "emulator",
            avd: "Pixel_Serial_Null",
            serial: null,
            state: "active",
            sessionId: "recover-sess",
            claimedAtMs: now - 5_000,
            activatedAtMs: now - 5_000,
            renewedAtMs: now,
            expiresAtMs: now + 300_000,
            profile: { apiLevel: "android-35", deviceType: "phone" },
          };
          return { mutated: true };
        });
        const recoverRes = cmdClaim(
          r21Dir,
          { avd: "Pixel_Serial_Null", session: "recover-sess", wait: 0, force: true },
          {
            avdHome,
            platform: "linux",
            inventory: {
              avdHome,
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Serial_Null",
                  kind: "emulator",
                  avd: "Pixel_Serial_Null",
                  online: false,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
              ],
              creatable: [],
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            runner: (cmd, args) => {
              if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                return { status: 0, stdout: "Started emulator-5554\n", stderr: "" };
              }
              return { status: 0, stdout: "emulator-5554\tdevice\n", stderr: "" };
            },
          },
        );
        assert.equal(recoverRes.exitCode, 0);
        assert.equal(recoverRes.lease.serial, "emulator-5554");

        // Targetless cmdFree with deferOnBusyWorker marks starting lease (activatedAtMs: null) for releaseOnWorkerExit
        withStateTransaction(r21Dir, (s, { now }) => {
          s.leases = {
            "avd:Pixel_Initial_Starting": {
              leaseId: "lease_init_starting",
              deviceKey: "avd:Pixel_Initial_Starting",
              kind: "emulator",
              avd: "Pixel_Initial_Starting",
              serial: null,
              state: "starting",
              workerPid: process.pid,
              workerPids: [process.pid],
              sessionId: "starting-sess",
              claimedAtMs: now,
              activatedAtMs: null,
              deadlineMs: now + 60_000,
              expiresAtMs: now + 300_000,
            },
          };
          return { mutated: true };
        });
        const deferFreeRes = cmdFree(
          r21Dir,
          null,
          { session: "starting-sess", stop: true },
          { deferOnBusyWorker: true },
        );
        assert.equal(deferFreeRes.exitCode, 0);
        const deferLease = readState(r21Dir).leases["avd:Pixel_Initial_Starting"];
        assert.equal(deferLease.releaseOnWorkerExit, true);
        assert.equal(deferLease.pendingStop, true);

        // POSIX rollback stop failure sets awaitOfflineReconcile: true
        withStateTransaction(r21Dir, (s) => {
          s.leases = {};
          return { mutated: true };
        });
        const posixFailRollbackRes = cmdClaim(
          r21Dir,
          {
            avd: "Pixel_Posix_Stop_Fail",
            session: "posix-rb-sess",
            resetApp: "com.example.app",
            wait: 0,
            force: true,
          },
          {
            avdHome,
            platform: "linux",
            inventory: {
              avdHome,
              running: [],
              offline: [
                {
                  deviceKey: "avd:Pixel_Posix_Stop_Fail",
                  kind: "emulator",
                  avd: "Pixel_Posix_Stop_Fail",
                  online: false,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
              ],
              creatable: [],
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            runner: (cmd, args) => {
              if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                return { status: 0, stdout: "Started emulator-5570\n", stderr: "" };
              }
              if (cmd === "adb" && args.includes("pm") && args.includes("clear")) {
                return { status: 1, stdout: "", stderr: "Failed: package not found" };
              }
              if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
                return { status: 1, stdout: "", stderr: "Failed to stop emulator" };
              }
              return { status: 0, stdout: "emulator-5570\tdevice\n", stderr: "" };
            },
          },
        );
        assert.notEqual(posixFailRollbackRes.exitCode, 0);
        const heldRollbackLease = readState(r21Dir).leases["avd:Pixel_Posix_Stop_Fail"];
        assert.ok(heldRollbackLease, "Failed POSIX rollback stop must keep stopping reservation");
        assert.equal(heldRollbackLease.awaitOfflineReconcile, true);

        // Astra #22 Finding 1: Cached inventory with pre-restart serial is updated when bootedDevices has a newer serial
        withStateTransaction(r21Dir, (s) => {
          s.leases = {};
          s.fleetEpoch = 50;
          s.stoppedDevices = {};
          s.bootedDevices = {
            "avd:Pixel_Restarted_Serial": {
              avd: "Pixel_Restarted_Serial",
              deviceKey: "avd:Pixel_Restarted_Serial",
              serial: "emulator-5568",
              epoch: 50,
              bootedAtMs: Date.now(),
            },
          };
          return { mutated: true };
        });
        const restartedSerialClaim = cmdClaim(
          r21Dir,
          { avd: "Pixel_Restarted_Serial", session: "restart-serial-sess", wait: 0 },
          {
            avdHome,
            inventory: {
              avdHome,
              fleetEpoch: 40,
              running: [
                {
                  deviceKey: "avd:Pixel_Restarted_Serial",
                  kind: "emulator",
                  avd: "Pixel_Restarted_Serial",
                  serial: "emulator-5554",
                  online: true,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
              ],
              offline: [],
              creatable: [],
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            runner: () => ({ status: 0, stdout: "", stderr: "" }),
          },
        );
        assert.equal(restartedSerialClaim.exitCode, 0);
        assert.equal(restartedSerialClaim.lease.serial, "emulator-5568");

        // Astra #22 Finding 5: Cold reclaim without explicit --ttl preserves a longer existing lease expiration
        const longExpiryMs = Date.now() + 3_000_000;
        withStateTransaction(r21Dir, (s, { now }) => {
          s.leases = {
            "avd:Pixel_Cold_Preserve_Ttl": {
              leaseId: "lease_long_ttl",
              deviceKey: "avd:Pixel_Cold_Preserve_Ttl",
              kind: "emulator",
              avd: "Pixel_Cold_Preserve_Ttl",
              serial: "emulator-5572",
              profile: { apiLevel: "android-35", deviceType: "phone" },
              sessionId: "long-ttl-sess",
              anchorPid: process.pid,
              state: "active",
              claimedAtMs: now - 10_000,
              activatedAtMs: now - 9_000,
              renewedAtMs: now - 1_000,
              expiresAtMs: longExpiryMs,
            },
          };
          return { mutated: true };
        });
        const coldPreserveRes = cmdClaim(
          r21Dir,
          { avd: "Pixel_Cold_Preserve_Ttl", session: "long-ttl-sess", cold: true, wait: 0 },
          {
            avdHome,
            platform: "linux",
            inventory: {
              avdHome,
              running: [
                {
                  deviceKey: "avd:Pixel_Cold_Preserve_Ttl",
                  kind: "emulator",
                  avd: "Pixel_Cold_Preserve_Ttl",
                  serial: "emulator-5572",
                  online: true,
                  profile: { apiLevel: "android-35", deviceType: "phone" },
                  ramSizeMb: 2048,
                },
              ],
              offline: [],
              creatable: [],
              host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 32768, cpuCores: 8 },
              probes: { emulatorListOk: true, adbDevicesOk: true },
            },
            runner: (cmd, args) => {
              if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
                return { status: 0, stdout: "Stopped\n", stderr: "" };
              }
              if (cmd === "adb" && args[0] === "devices") {
                return { status: 0, stdout: "List of devices attached\n\n", stderr: "" };
              }
              if (cmd === "android" && args[0] === "emulator" && args[1] === "start") {
                return { status: 0, stdout: "Started emulator-5572\n", stderr: "" };
              }
              return { status: 0, stdout: "", stderr: "" };
            },
          },
        );
        assert.equal(coldPreserveRes.exitCode, 0);
        assert.ok(
          coldPreserveRes.lease.expiresAtMs >= longExpiryMs,
          `Expected cold reclaim without --ttl to preserve expiresAtMs >= ${longExpiryMs}, got ${coldPreserveRes.lease.expiresAtMs}`,
        );

        // Codex PR comment: isProcessGroupAlive returns false when only zombie (Z) processes remain in the group
        if (process.platform !== "win32") {
          const parentHolder = spawn(
            process.execPath,
            [
              "-e",
              `
              const { spawn } = require("node:child_process");
              const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120)"], {
                detached: true,
                stdio: "ignore",
              });
              process.stdout.write(String(child.pid) + "\\n");
              setInterval(() => {}, 10000);
              `,
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
          );
          try {
            const childPgid = await new Promise((resolve, reject) => {
              let buf = "";
              parentHolder.stdout.on("data", (d) => {
                buf += d.toString("utf8");
                const nl = buf.indexOf("\n");
                if (nl !== -1) {
                  resolve(Number(buf.slice(0, nl).trim()));
                }
              });
              parentHolder.once("error", reject);
              parentHolder.once("exit", () => reject(new Error("parentHolder exited early")));
            });
            assert.ok(Number.isInteger(childPgid) && childPgid > 1);
            // Freeze parentHolder so libuv cannot waitpid() on child when child exits
            process.kill(parentHolder.pid, "SIGSTOP");
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline && isProcessGroupAlive(childPgid)) {
              await new Promise((r) => setTimeout(r, 50));
            }
            assert.equal(
              isProcessGroupAlive(childPgid),
              false,
              "Zombie-only process group must not be reported alive",
            );
            // Astra #23 Finding 1: withStateTransaction snapshots process-group liveness outside atc.lock and prunes zombie-only workerPgids
            withStateTransaction(r21Dir, (s, { now }) => {
              s.leases["avd:Pixel_Zombie_Group"] = {
                leaseId: "lease_zombie_pg",
                deviceKey: "avd:Pixel_Zombie_Group",
                kind: "emulator",
                avd: "Pixel_Zombie_Group",
                serial: "emulator-5574",
                profile: { apiLevel: "android-35", deviceType: "phone" },
                sessionId: "zombie-pg-sess",
                anchorPid: 999999,
                state: "active",
                workerPid: childPgid,
                workerPids: [childPgid],
                workerPgids: [childPgid],
                claimedAtMs: now - 10_000,
                activatedAtMs: now - 9_000,
                renewedAtMs: now - 5_000,
                expiresAtMs: now - 1_000,
              };
              return { mutated: true };
            });
            withStateTransaction(r21Dir, () => ({ mutated: false }));
            assert.equal(
              readState(r21Dir).leases["avd:Pixel_Zombie_Group"],
              undefined,
              "Zombie-only workerPgids must be snapshotted outside lock and pruned during GC",
            );
          } finally {
            try {
              process.kill(parentHolder.pid, "SIGKILL");
            } catch {
              // Ignore
            }
          }
        }

        // Astra #23 Finding 3: Windows resolveExecutable honors ANDROID_HOME / ANDROID_SDK_ROOT before default %LOCALAPPDATA%\Android\Sdk
        const winCustomSdkDir = makeTempStateDir();
        try {
          const customSdk = path.join(winCustomSdkDir, "custom-sdk");
          const defaultAppData = path.join(winCustomSdkDir, "local-appdata");
          fs.mkdirSync(path.join(customSdk, "platform-tools"), { recursive: true });
          fs.mkdirSync(path.join(defaultAppData, "Android", "Sdk", "platform-tools"), {
            recursive: true,
          });
          const customAdb = path.join(customSdk, "platform-tools", "adb.exe");
          const defaultAdb = path.join(
            defaultAppData,
            "Android",
            "Sdk",
            "platform-tools",
            "adb.exe",
          );
          fs.writeFileSync(customAdb, "MZ");
          fs.writeFileSync(defaultAdb, "MZ");
          const resolvedWinSdkAdb = resolveExecutable(
            "adb",
            {
              PATH: "",
              ANDROID_HOME: customSdk,
              LOCALAPPDATA: defaultAppData,
              APPDATA: winCustomSdkDir,
            },
            winCustomSdkDir,
            "win32",
          );
          assert.equal(resolvedWinSdkAdb.executable, customAdb);
        } finally {
          fs.rmSync(winCustomSdkDir, { recursive: true, force: true });
        }

        // Astra #24 Finding 2: Rekeying a lease from serial:<serial> to avd:<name> during atc exec still executes deferred free cleanup
        withStateTransaction(r21Dir, (s, { now }) => {
          s.leases = {
            "serial:emulator-5576": {
              leaseId: "lease_rekey_defer",
              deviceKey: "serial:emulator-5576",
              kind: "emulator",
              avd: null,
              serial: "emulator-5576",
              profile: { apiLevel: "android-35", deviceType: "phone" },
              sessionId: "rekey-defer-sess",
              anchorPid: process.pid,
              state: "active",
              claimedAtMs: now - 5_000,
              activatedAtMs: now - 4_000,
              renewedAtMs: now,
              expiresAtMs: now + 60_000,
            },
          };
          return { mutated: true };
        });
        if (process.platform !== "win32") {
        let rekeyStopCalled = false;
        // The fake adb execs node (same PID) to rekey its own lease while the typed op is in flight
        const rekeyScript = path.join(r21Dir, "rekey-child.cjs");
        fs.writeFileSync(
          rekeyScript,
            `
            const fs = require("node:fs");
            const path = require("node:path");
            const statePath = path.join(process.argv[2], "state.json");
            const lockPath = path.join(process.argv[2], "atc.lock");
            const deadline = Date.now() + 3000;
            let st;
            while (Date.now() < deadline) {
              try {
                if (!fs.existsSync(lockPath)) {
                  st = JSON.parse(fs.readFileSync(statePath, "utf8"));
                  if (st.leases["serial:emulator-5576"]?.workerPids?.includes(process.pid)) {
                    break;
                  }
                }
              } catch {}
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
            const old = st?.leases?.["serial:emulator-5576"];
            if (old) {
              delete st.leases["serial:emulator-5576"];
              old.avd = "Pixel_Rekeyed";
              old.deviceKey = "avd:Pixel_Rekeyed";
              old.releaseOnWorkerExit = true;
              old.pendingStop = true;
              st.leases["avd:Pixel_Rekeyed"] = old;
              fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
            }
            `,
        );
        const rekeyEnv = makeFakeToolEnv(r21Dir, {
          adb: `exec "${process.execPath}" "${rekeyScript}" "${r21Dir}"`,
        });
        const rekeyExecRes = await cmdExec(
          r21Dir,
          ["android", "logcat", "--session", "rekey-defer-sess", "--json"],
          {
            env: rekeyEnv,
            platform: "linux",
            runner: (cmd, args) => {
              if (cmd === "android" && args[0] === "emulator" && args[1] === "stop") {
                rekeyStopCalled = true;
                return { status: 0, stdout: "Stopped\n", stderr: "" };
              }
              return { status: 0, stdout: "", stderr: "" };
            },
          },
        );
        assert.equal(rekeyExecRes.exitCode, 0, rekeyExecRes.error);
        assert.equal(rekeyStopCalled, true, "Deferred stop must execute even after lease is rekeyed");
        assert.equal(readState(r21Dir).leases["avd:Pixel_Rekeyed"], undefined);
        }

        // Astra #25 Finding 1: queryWindowsProcessGroups defaults to alive (true) when PowerShell fails or returns invalid JSON
        const winFailedQuery = queryWindowsProcessGroups([424242], () => ({
          status: 1,
          stdout: "",
          stderr: "PowerShell failed",
        }));
        assert.equal(winFailedQuery.get(424242), true);
        const winInvalidJsonQuery = queryWindowsProcessGroups([424242], () => ({
          status: 0,
          stdout: "{not-json",
          stderr: "",
        }));
        assert.equal(winInvalidJsonQuery.get(424242), true);
        const winConfirmedDeadQuery = queryWindowsProcessGroups([424242], () => ({
          status: 0,
          stdout: JSON.stringify([{ ProcessId: 100, ParentProcessId: 4 }]),
          stderr: "",
        }));
        assert.equal(winConfirmedDeadQuery.get(424242), false);

        // Astra #25 Finding 2: Windows resolveExecutable fails closed for adb/android/emulator when missing from PATH/SDK
        const winLocalTrapDir = makeTempStateDir();
        try {
          fs.writeFileSync(path.join(winLocalTrapDir, "adb.exe"), "MZ");
          fs.writeFileSync(path.join(winLocalTrapDir, "android.exe"), "MZ");
          fs.writeFileSync(path.join(winLocalTrapDir, "emulator.exe"), "MZ");
          const isolatedWinEnv = {
            PATH: path.join(winLocalTrapDir, "empty-path"),
            ANDROID_HOME: path.join(winLocalTrapDir, "empty-sdk"),
            ANDROID_SDK_ROOT: path.join(winLocalTrapDir, "empty-sdk"),
            LOCALAPPDATA: path.join(winLocalTrapDir, "empty-localappdata"),
            APPDATA: path.join(winLocalTrapDir, "empty-appdata"),
            USERPROFILE: path.join(winLocalTrapDir, "empty-profile"),
          };
          for (const tool of ["adb", "android", "emulator", "adb.exe"]) {
            assert.throws(
              () => resolveExecutable(tool, isolatedWinEnv, winLocalTrapDir, "win32"),
              /Executable not found in PATH/,
            );
          }
          const runMissingWinTool = runCommandSync("android", ["emulator", "list"], {
            env: isolatedWinEnv,
            cwd: winLocalTrapDir,
            platform: "win32",
          });
          assert.equal(runMissingWinTool.status, 1);
          assert.match(runMissingWinTool.stderr, /ENOENT/);
        } finally {
          fs.rmSync(winLocalTrapDir, { recursive: true, force: true });
        }

        // Astra #25 Finding 4: Relocated AVD disk admission and per-filesystem reservation aggregation
        const relocatedState = createDefaultState();
        relocatedState.leases["avd:Starting_On_Ext"] = {
          leaseId: "lease_ext_starting",
          deviceKey: "avd:Starting_On_Ext",
          kind: "emulator",
          avd: "Starting_On_Ext",
          state: "starting",
          requiredRamMb: 3072,
          requiredDiskMb: 6656,
          fsDev: "vol-ext",
        };
        assert.throws(
          () =>
            checkResourceAdmission(
              {
                avd: "Relocated_On_Ext",
                ramSizeMb: 2048,
                requiredRamMb: 3072,
                dataDiskMb: 6656,
                freeDiskMb: 9000,
                fsDev: "vol-ext",
              },
              { availableRamMb: 32768, freeDiskMb: 65536, fsDev: "vol-home" },
              relocatedState,
              { running: [] },
            ),
          (err) => err instanceof ResourceError && err.exitCode === 5,
        );
        // Same freeDiskMb on a different volume ("vol-other") without the starting reservation succeeds
        const otherVolAdmission = checkResourceAdmission(
          {
            avd: "Relocated_On_Other",
            ramSizeMb: 2048,
            requiredRamMb: 3072,
            dataDiskMb: 6656,
            freeDiskMb: 9000,
            fsDev: "vol-other",
          },
          { availableRamMb: 32768, freeDiskMb: 65536, fsDev: "vol-home" },
          relocatedState,
          { running: [] },
        );
        assert.equal(otherVolAdmission.ok, true);

        // Astra #25 Finding 5: Offline emulator holding runtime QEMU lock files counts toward computeUsedEmulatorSlots
        const lockSlotState = createDefaultState();
        const usedWithLockedOffline = computeUsedEmulatorSlots(lockSlotState, {
          running: [],
          offline: [
            {
              deviceKey: "avd:Locked_Offline_Avd",
              avd: "Locked_Offline_Avd",
              kind: "emulator",
              online: false,
              hasLockFiles: true,
            },
          ],
        });
        assert.equal(usedWithLockedOffline, 1);
      } finally {
        fs.rmSync(r21Dir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(snapStateDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(avdHome, { recursive: true, force: true });
  }
});

test("guide, docs, skill, and plugin manifests: built-in guide topics, MCP atc_guide, and multi-host plugin packaging", async () => {
  const dir = makeTempStateDir();
  try {
    // 1. Default topic is workflow, and all 5 canonical topics load cleanly
    assert.deepEqual(GUIDE_TOPICS, ["workflow", "profiles", "snapshots", "multi-agent", "traps"]);
    const defaultGuide = cmdGuide();
    assert.equal(defaultGuide.exitCode, 0);
    assert.equal(defaultGuide.topic, "workflow");
    assert.match(defaultGuide.text, /# atc workflow guide/);

    for (const topic of GUIDE_TOPICS) {
      const res = cmdGuide(topic);
      assert.equal(res.exitCode, 0);
      assert.equal(res.topic, topic);
      assert.deepEqual(res.topics, GUIDE_TOPICS);
      assert.ok(res.text.length > 200, `Expected non-empty markdown for topic ${topic}`);
    }

    // 2. Convenient aliases resolve to canonical topics
    assert.equal(cmdGuide("devices").topic, "profiles");
    assert.equal(cmdGuide("snapshot").topic, "snapshots");
    assert.equal(cmdGuide("queue").topic, "multi-agent");
    assert.equal(cmdGuide("troubleshooting").topic, "traps");

    // 3. Unknown guide topic returns exitCode 1 with actionable message
    const badGuide = cmdGuide("nonexistent-topic");
    assert.equal(badGuide.exitCode, 1);
    assert.match(badGuide.error, /Unknown guide "nonexistent-topic": choose one of workflow, profiles, snapshots, multi-agent, traps/);

    // 4. CLI runCli guide and help guide
    const helpGuideExit = await runCli(["help", "guide"], { ATC_STATE_DIR: dir });
    assert.equal(helpGuideExit, 0);
    const guideJsonExit = await runCli(["guide", "traps", "--json"], { ATC_STATE_DIR: dir });
    assert.equal(guideJsonExit, 0);
    const guideExtraArgExit = await runCli(["guide", "workflow", "extra"], { ATC_STATE_DIR: dir });
    assert.equal(guideExtraArgExit, 1);
    const guideUnknownFlagExit = await runCli(["guide", "--bogus"], { ATC_STATE_DIR: dir });
    assert.equal(guideUnknownFlagExit, 1);

    // 5. MCP atc_guide tool is advertised in tools/list and callable via tools/call
    const listResp = handleMcpRequest(dir, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    assert.ok(listResp.result.tools.some((t) => t.name === "atc_guide"));
    const mcpGuideResp = handleMcpRequest(dir, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "atc_guide", arguments: { topic: "profiles" } },
    });
    assert.equal(mcpGuideResp.result.isError, false);
    const mcpGuidePayload = JSON.parse(mcpGuideResp.result.content[0].text);
    assert.equal(mcpGuidePayload.exitCode, 0);
    assert.equal(mcpGuidePayload.topic, "profiles");
    assert.match(mcpGuidePayload.text, /Three-tier fleet discovery/);

    // 6. Verify skill, user guide, and plugin manifests exist and are valid
    const rootDir = new URL("../", import.meta.url);
    const skillText = fs.readFileSync(new URL("skills/atc/SKILL.md", rootDir), "utf8");
    assert.match(skillText, /atc guide/);
    const installRefText = fs.readFileSync(new URL("skills/atc/references/install.md", rootDir), "utf8");
    assert.match(installRefText, /npm install -g @rock3r\/atc/);
    const userGuideText = fs.readFileSync(new URL("docs/user-guide.md", rootDir), "utf8");
    assert.match(userGuideText, /# `atc` user guide/);
    assert.match(userGuideText, /atc guide/);
    const archText = fs.readFileSync(new URL("docs/architecture.md", rootDir), "utf8");
    assert.match(archText, /# atc architecture/);
    assert.match(archText, /atc\.lock/);

    const pkgJson = JSON.parse(fs.readFileSync(new URL("package.json", rootDir), "utf8"));
    assert.match(pkgJson.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkgJson.publishConfig?.access, "public");
    assert.equal(pkgJson.publishConfig?.provenance, true);

    const skillSource = JSON.parse(fs.readFileSync(new URL("skills/atc/skill-source.json", rootDir), "utf8"));
    assert.equal(skillSource.schemaVersion, 1);
    assert.equal(skillSource.skill, "atc");
    assert.equal(skillSource.sources[0].type, "local-original-content");
    assert.equal(skillSource.sources[0].role, "original-content");
    assert.equal(skillSource.sources[0].versionSource, "frontmatter");
    assert.equal(skillSource.sources[0].version, pkgJson.version);

    const releasingText = fs.readFileSync(new URL("docs/RELEASING.md", rootDir), "utf8");
    assert.match(releasingText, /tools\/check-versions\.sh/);

    const agentPlugin = JSON.parse(fs.readFileSync(new URL("plugin.json", rootDir), "utf8"));
    assert.equal(agentPlugin.name, "atc");
    assert.equal(agentPlugin.displayName, "Agent Traffic Control");
    assert.equal(agentPlugin.logo, "assets/logo.svg");
    assert.ok(Array.isArray(agentPlugin.suggestedPrompts) && agentPlugin.suggestedPrompts.length > 0);
    assert.equal(agentPlugin.version, pkgJson.version);
    assert.equal(agentPlugin.skills, undefined);
    assert.equal(agentPlugin.hooks, "./hooks/hooks.json");

    const antigravityHooks = JSON.parse(fs.readFileSync(new URL("hooks.json", rootDir), "utf8"));
    assert.ok(Array.isArray(antigravityHooks.atc?.PreToolUse));
    assert.match(antigravityHooks.atc.PreToolUse[0].matcher, /run_command/);
    assert.match(antigravityHooks.atc.PreToolUse[0].matcher, /call_mcp_tool/);
    assert.match(antigravityHooks.atc.PreToolUse[0].hooks[0].command, /'hook', 'PreToolUse'/);
    assert.ok(Array.isArray(antigravityHooks.atc?.Stop));
    assert.equal(antigravityHooks.atc.Stop[0].type, "command");
    assert.match(antigravityHooks.atc.Stop[0].command, /'hook', 'Stop'/);

    const antigravityMcp = JSON.parse(fs.readFileSync(new URL("mcp_config.json", rootDir), "utf8"));
    assert.equal(antigravityMcp.mcpServers.atc.command, "node");
    assert.equal(antigravityMcp.mcpServers.atc.args[0], "-e");
    assert.match(antigravityMcp.mcpServers.atc.args[1], /'mcp'/);

    const agentsMarketplace = JSON.parse(fs.readFileSync(new URL(".agents/plugins/marketplace.json", rootDir), "utf8"));
    assert.equal(agentsMarketplace.name, "atc");
    assert.ok(Array.isArray(agentsMarketplace.plugins) && agentsMarketplace.plugins[0].name === "atc");

    const claudePlugin = JSON.parse(fs.readFileSync(new URL(".claude-plugin/plugin.json", rootDir), "utf8"));
    assert.equal(claudePlugin.name, "atc");
    assert.equal(claudePlugin.version, pkgJson.version);
    assert.equal(claudePlugin.skills, "./skills/");

    const marketplace = JSON.parse(fs.readFileSync(new URL(".claude-plugin/marketplace.json", rootDir), "utf8"));
    assert.equal(marketplace.name, "atc");
    assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins[0].name === "atc");

    const codexPlugin = JSON.parse(fs.readFileSync(new URL(".codex-plugin/plugin.json", rootDir), "utf8"));
    assert.equal(codexPlugin.name, "atc");
    assert.equal(codexPlugin.version, pkgJson.version);
    assert.equal(codexPlugin.mcpServers, "./.mcp.json");

    const mcpManifest = JSON.parse(fs.readFileSync(new URL(".mcp.json", rootDir), "utf8"));
    assert.equal(mcpManifest.mcpServers.atc.command, "atc");

    // 7. Execute the actual hook shell commands from every host manifest end-to-end
    if (process.platform !== "win32") {
      const repoRootPath = path.resolve(new URL(".", rootDir).pathname);
      const fakeWs = makeTempStateDir();
      try {
        const execHookManifestCmd = (cmd, payloadObj, extraEnv = {}, cwd = fakeWs) =>
          spawnSync("/bin/sh", ["-c", cmd], {
            cwd,
            input: JSON.stringify(payloadObj),
            encoding: "utf8",
            env: { ...process.env, ATC_STATE_DIR: dir, ...extraEnv },
            timeout: 5000,
          });

        // Antigravity (hooks.json)
        const agPreRes = execHookManifestCmd(
          antigravityHooks.atc.PreToolUse[0].hooks[0].command,
          {
            conversationId: "ag-e2e",
            toolCall: {
              name: "run_command",
              args: { CommandLine: "adb shell ls", Cwd: fakeWs },
            },
          },
          { ANTIGRAVITY_CONVERSATION_ID: "ag-e2e" },
          repoRootPath,
        );
        assert.equal(agPreRes.status, 0);
        assert.deepEqual(JSON.parse(agPreRes.stdout), { decision: "allow" });

        const agMcpRes = execHookManifestCmd(
          antigravityHooks.atc.PreToolUse[0].hooks[0].command,
          {
            conversationId: "ag-e2e",
            toolCall: {
              name: "call_mcp_tool",
              args: {
                ServerName: "atc_atc",
                ToolName: "atc_claim",
                Arguments: { type: "phone" },
              },
            },
          },
          { ANTIGRAVITY_CONVERSATION_ID: "ag-e2e" },
          repoRootPath,
        );
        assert.equal(agMcpRes.status, 0);
        assert.deepEqual(JSON.parse(agMcpRes.stdout), {
          decision: "allow",
          overwrite: { Arguments: { type: "phone", session: "ag-e2e" } },
        });

        const agNonAtcMcpRes = execHookManifestCmd(
          antigravityHooks.atc.PreToolUse[0].hooks[0].command,
          {
            conversationId: "ag-e2e",
            toolCall: {
              name: "call_mcp_tool",
              args: {
                ServerName: "chrome-devtools",
                ToolName: "list_pages",
                Arguments: {},
              },
            },
          },
          { ANTIGRAVITY_CONVERSATION_ID: "ag-e2e" },
          repoRootPath,
        );
        assert.equal(agNonAtcMcpRes.status, 0);
        assert.deepEqual(JSON.parse(agNonAtcMcpRes.stdout), { decision: "allow" });

        const agStopRes = execHookManifestCmd(
          antigravityHooks.atc.Stop[0].command,
          { conversationId: "ag-e2e", fullyIdle: true },
          { ANTIGRAVITY_CONVERSATION_ID: "ag-e2e" },
          repoRootPath,
        );
        assert.equal(agStopRes.status, 0);
        assert.deepEqual(JSON.parse(agStopRes.stdout), { decision: "allow" });

        // Antigravity mcp_config.json launches packaged bin/atc.mjs when installed in ~/.gemini/config/plugins/atc or ~/.gemini/antigravity-cli/plugins/atc without global atc on PATH
        for (const subDir of ["config", "antigravity-cli"]) {
          const fakeHome = makeTempStateDir();
          try {
            const fakePluginDir = path.join(fakeHome, ".gemini", subDir, "plugins", "atc");
            fs.mkdirSync(fakePluginDir, { recursive: true });
            fs.cpSync(path.join(repoRootPath, "bin"), path.join(fakePluginDir, "bin"), {
              recursive: true,
            });
            fs.cpSync(path.join(repoRootPath, "src"), path.join(fakePluginDir, "src"), {
              recursive: true,
            });
            fs.cpSync(
              path.join(repoRootPath, "package.json"),
              path.join(fakePluginDir, "package.json"),
            );
            const agMcpServerRes = spawnSync(
              process.execPath,
              antigravityMcp.mcpServers.atc.args,
              {
                cwd: fakeWs,
                input:
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {},
                  }) + "\n",
                encoding: "utf8",
                env: {
                  ...process.env,
                  HOME: fakeHome,
                  USERPROFILE: fakeHome,
                  PATH: path.dirname(process.execPath),
                  ATC_STATE_DIR: dir,
                },
                timeout: 5000,
              },
            );
            assert.equal(agMcpServerRes.status, 0);
            const mcpInitReply = JSON.parse(agMcpServerRes.stdout.trim());
            assert.equal(mcpInitReply.result.serverInfo.name, "android-traffic-control");
          } finally {
            fs.rmSync(fakeHome, { recursive: true, force: true });
          }
        }

        // Claude Code & OpenAI Codex & Gemini CLI (hooks/hooks.json)
        const stdHooks = JSON.parse(fs.readFileSync(new URL("hooks/hooks.json", rootDir), "utf8"));
        const claudeShellRes = execHookManifestCmd(
          stdHooks.hooks.PreToolUse[0].hooks[0].command,
          {
            session_id: "claude-e2e",
            tool_name: "Bash",
            tool_input: { command: "adb shell ls" },
          },
          { CLAUDE_PLUGIN_ROOT: repoRootPath },
        );
        assert.equal(claudeShellRes.status, 0);
        assert.equal(claudeShellRes.stdout, "");

        const codexMcpRes = execHookManifestCmd(
          stdHooks.hooks.PreToolUse[0].hooks[0].command,
          {
            session_id: "codex-e2e",
            tool_name: "mcp__plugin__atc_claim",
            tool_input: { type: "phone" },
          },
          { CODEX_PLUGIN_ROOT: repoRootPath },
        );
        assert.equal(codexMcpRes.status, 0);
        assert.equal(
          JSON.parse(codexMcpRes.stdout).hookSpecificOutput.updatedInput.session,
          "codex-e2e",
        );

        const geminiStopRes = execHookManifestCmd(
          stdHooks.hooks.SessionEnd[0].hooks[0].command,
          { session_id: "codex-e2e" },
          { GEMINI_EXTENSION_PATH: repoRootPath },
        );
        assert.equal(geminiStopRes.status, 0);

        // Cursor (.cursor/hooks.json)
        const cursorHooks = JSON.parse(
          fs.readFileSync(new URL(".cursor/hooks.json", rootDir), "utf8"),
        );
        const cursorShellRes = execHookManifestCmd(
          cursorHooks.hooks.beforeShellExecution[0].command,
          {
            hook_event_name: "beforeShellExecution",
            conversation_id: "cursor-e2e",
            command: "adb shell ls",
          },
          { CURSOR_PLUGIN_ROOT: repoRootPath },
        );
        assert.equal(cursorShellRes.status, 0);
        assert.deepEqual(JSON.parse(cursorShellRes.stdout), { permission: "allow" });

        // GitHub Copilot CLI (com.github.copilot/hooks/hooks.json)
        const copilotHooks = JSON.parse(
          fs.readFileSync(new URL("com.github.copilot/hooks/hooks.json", rootDir), "utf8"),
        );
        const copilotShellRes = execHookManifestCmd(
          copilotHooks.hooks.preToolUse[0].command,
          {
            sessionId: "copilot-e2e",
            toolName: "bash",
            toolArgs: { command: "adb shell ls" },
          },
          { CLAUDE_PLUGIN_ROOT: repoRootPath },
        );
        assert.equal(copilotShellRes.status, 0);
        assert.equal(copilotShellRes.stdout, "");
      } finally {
        fs.rmSync(fakeWs, { recursive: true, force: true });
      }
    }

    const versionExit = await runCli(["version", "--json"], { ATC_STATE_DIR: dir });
    assert.equal(versionExit, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("post-MVP hardening: Windows multi-hop detached grandchild tracking, CreationDate PID-reuse guard, stale AVD dead-PID lock cleanup", async () => {
  const dir = makeTempStateDir();
  const avdHome = makeTempStateDir();
  const rootPgid = 710001;
  try {
    // 1. Windows Multi-Hop Detached Grandchild Tracking & Cross-Invocation Persistence (Issue #3)
    clearKnownWindowsTreeDescendants(rootPgid);

    // Phase A: Root process (710001) spawns intermediate shell (710002), which spawns grandchild (710003)
    const phaseAProcesses = [
      { ProcessId: 710001, ParentProcessId: 4000, CreationDate: "20261010150000.000000+000" },
      { ProcessId: 710002, ParentProcessId: 710001, CreationDate: "20261010150001.000000+000" },
      { ProcessId: 710003, ParentProcessId: 710002, CreationDate: "20261010150002.000000+000" },
    ];
    const mapA = queryWindowsProcessGroups(
      [rootPgid],
      () => ({
        status: 0,
        stdout: JSON.stringify(phaseAProcesses),
        stderr: "",
      }),
      { pgidStartTokens: { [String(rootPgid)]: "20261010150000.000000+000" } },
    );
    assert.equal(mapA.get(rootPgid), true);
    const knownAfterA = getKnownWindowsTreeDescendants(rootPgid);
    assert.deepEqual(knownAfterA, [
      { pid: 710001, creationDate: "20261010150000.000000+000" },
      { pid: 710002, creationDate: "20261010150001.000000+000" },
      { pid: 710003, creationDate: "20261010150002.000000+000" },
    ]);

    // Phase B: Both root (710001) and intermediate shell (710002) exit; grandchild (710003) survives and spawns great-grandchild (710004)
    const phaseBProcesses = [
      { ProcessId: 710003, ParentProcessId: 710002, CreationDate: "20261010150002.000000+000" },
      { ProcessId: 710004, ParentProcessId: 710003, CreationDate: "20261010150003.000000+000" },
    ];
    // Simulate a separate CLI invocation by clearing in-memory cache and seeding from persisted state.json metadata
    clearKnownWindowsTreeDescendants(rootPgid);
    assert.deepEqual(getKnownWindowsTreeDescendants(rootPgid), []);
    seedWindowsKnownDescendants({ [String(rootPgid)]: knownAfterA });

    const aliveInB = hasAliveProcessInGroup(rootPgid, null, {
      platform: "win32",
      runner: () => ({
        status: 0,
        stdout: JSON.stringify(phaseBProcesses),
        stderr: "",
      }),
    });
    assert.equal(
      aliveInB,
      true,
      "Cross-invocation seeded descendants must detect surviving grandchild/great-grandchild after root & intermediate shell exit",
    );
    const knownAfterB = getKnownWindowsTreeDescendants(rootPgid);
    assert.deepEqual(
      knownAfterB.find((entry) => entry.pid === 710004),
      { pid: 710004, creationDate: "20261010150003.000000+000" },
    );

    // Phase C: PID reuse guard — 710003 and 710004 exit, and OS reuses PID 710003 for an unrelated process with a different CreationDate
    const phaseCReusedProcesses = [
      { ProcessId: 710003, ParentProcessId: 8888, CreationDate: "20261010150999.000000+000" },
      { ProcessId: 710099, ParentProcessId: 710003, CreationDate: "20261010151000.000000+000" },
    ];
    const aliveInC = hasAliveProcessInGroup(rootPgid, null, {
      platform: "win32",
      runner: () => ({
        status: 0,
        stdout: JSON.stringify(phaseCReusedProcesses),
        stderr: "",
      }),
    });
    assert.equal(
      aliveInC,
      false,
      "Reused PID with mismatched CreationDate must not be treated as a live lease worker descendant",
    );

    // Phase D: killProcessGroupTree on Windows kills surviving verified descendants (710004) but skips reused PIDs (710003) and clears tracking
    seedWindowsKnownDescendants({ [String(rootPgid)]: knownAfterB });
    const killedWinPids = [];
    killProcessGroupTree(rootPgid, "SIGTERM", {
      platform: "win32",
      runner: (cmd, args) => {
        if (cmd === "powershell.exe") {
          return {
            status: 0,
            stdout: JSON.stringify([
              // 710003 was reused by an unrelated process -> must NOT be killed
              { ProcessId: 710003, ParentProcessId: 8888, CreationDate: "20261010150999.000000+000" },
              // 710004 is still the genuine great-grandchild -> MUST be killed
              { ProcessId: 710004, ParentProcessId: 710003, CreationDate: "20261010150003.000000+000" },
            ]),
            stderr: "",
          };
        }
        if (cmd === "taskkill") {
          killedWinPids.push(Number(args[args.indexOf("/PID") + 1]));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(killedWinPids, [710004]);
    assert.deepEqual(getKnownWindowsTreeDescendants(rootPgid), []);

    // Phase E: Cross-invocation state.json persistence across withStateTransaction, cmdStatus, cmdFree, and cmdGc
    const now = Date.now();
    seedWindowsKnownDescendants({ [String(rootPgid)]: knownAfterA });
    const winState = createDefaultState();
    winState.leases["serial:emulator-5554"] = {
      leaseId: "lease_win_desc",
      deviceKey: "serial:emulator-5554",
      kind: "emulator",
      avd: "Pixel_8_API_35",
      serial: "emulator-5554",
      profile: { apiLevel: "android-35", deviceType: "phone" },
      sessionId: "win-desc-sess",
      anchorPid: process.pid,
      workerPid: rootPgid,
      workerPids: [rootPgid],
      workerPgids: [rootPgid],
      workerDescendants: { [String(rootPgid)]: knownAfterA },
      state: "active",
      claimedAtMs: now - 10_000,
      activatedAtMs: now - 9_000,
      renewedAtMs: now - 1_000,
      expiresAtMs: now + 300_000,
    };
    withLock(dir, (h) => commitState(dir, winState, h));

    // Clear in-memory map to simulate a fresh CLI process (`atc status`)
    clearKnownWindowsTreeDescendants(rootPgid);
    const statusRes = cmdStatus(
      dir,
      { json: true },
      {
        platform: "win32",
        livenessCheck: (pid) => pid === process.pid, // rootPgid (710001) itself is dead!
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            return {
              status: 0,
              stdout: JSON.stringify(phaseBProcesses),
              stderr: "",
            };
          }
          if (cmd === "adb" && args[0] === "devices") {
            return {
              status: 0,
              stdout: "List of devices attached\nemulator-5554\tdevice\n",
              stderr: "",
            };
          }
          if (cmd === "android") {
            return {
              status: 0,
              stdout: JSON.stringify({
                avds: [
                  {
                    name: "Pixel_8_API_35",
                    serial: "emulator-5554",
                    online: true,
                    api_level: "android-35",
                    device_type: "phone",
                  },
                ],
              }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(statusRes.exitCode, 0);
    const persistedAfterStatus = readState(dir).leases["serial:emulator-5554"];
    assert.ok(persistedAfterStatus, "Lease must remain active while detached grandchild 710003/710004 is alive");
    assert.deepEqual(persistedAfterStatus.workerPids, [rootPgid]);
    assert.deepEqual(
      persistedAfterStatus.workerDescendants?.[String(rootPgid)]?.find((e) => e.pid === 710004),
      { pid: 710004, creationDate: "20261010150003.000000+000" },
      "Discovered multi-hop descendant 710004 must be persisted to state.json across CLI invocations",
    );

    // Simulate `atc free` in a separate CLI process: when leader PID (710001) is dead and detached grandchild (710004) is orphaned,
    // `atc free` terminates the surviving detached grandchild tree outside atc.lock and frees the lease
    clearKnownWindowsTreeDescendants(rootPgid);
    const freeKilledPids = [];
    const freeRes = cmdFree(
      dir,
      "lease_win_desc",
      {},
      {
        platform: "win32",
        env: { ATC_SESSION_ID: "win-desc-sess" },
        livenessCheck: (pid) => pid === process.pid,
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            return {
              status: 0,
              stdout: JSON.stringify([
                { ProcessId: 710004, ParentProcessId: 710003, CreationDate: "20261010150003.000000+000" },
              ]),
              stderr: "",
            };
          }
          if (cmd === "taskkill") {
            freeKilledPids.push(Number(args[args.indexOf("/PID") + 1]));
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(freeRes.exitCode, 0);
    assert.deepEqual(freeRes.freed, ["lease_win_desc"]);
    assert.deepEqual(
      freeKilledPids,
      [710004],
      "atc free must terminate surviving detached grandchild discovered via persisted workerDescendants",
    );
    assert.equal(readState(dir).leases["serial:emulator-5554"], undefined);

    // Simulate `atc gc` in a separate CLI process cleaning up an expired lease's detached Windows grandchild
    const gcPgid = 720001;
    const gcDescMap = [
      { pid: 720001, creationDate: "20261010160000.000000+000" },
      { pid: 720003, creationDate: "20261010160002.000000+000" },
    ];
    const gcState = createDefaultState();
    gcState.leases["serial:emulator-5556"] = {
      leaseId: "lease_win_gc",
      deviceKey: "serial:emulator-5556",
      kind: "emulator",
      avd: "Pixel_GC",
      serial: "emulator-5556",
      profile: { apiLevel: "android-35", deviceType: "phone" },
      sessionId: "win-gc-sess",
      anchorPid: 99999991, // dead anchor
      workerPid: gcPgid,
      workerPids: [gcPgid],
      workerPgids: [gcPgid],
      workerDescendants: { [String(gcPgid)]: gcDescMap },
      state: "active",
      claimedAtMs: now - 700_000,
      activatedAtMs: now - 699_000,
      renewedAtMs: now - 650_000,
      expiresAtMs: now - 10_000, // expired
    };
    withLock(dir, (h) => commitState(dir, gcState, h));
    clearKnownWindowsTreeDescendants(gcPgid);
    const gcKilledPids = [];
    const gcRes = cmdGc(dir, {
      platform: "win32",
      livenessCheck: () => false,
      runner: (cmd, args) => {
        if (cmd === "powershell.exe") {
          return {
            status: 0,
            stdout: JSON.stringify([
              { ProcessId: 720003, ParentProcessId: 720002, CreationDate: "20261010160002.000000+000" },
            ]),
            stderr: "",
          };
        }
        if (cmd === "taskkill") {
          gcKilledPids.push(Number(args[args.indexOf("/PID") + 1]));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(gcRes.exitCode, 0);
    assert.deepEqual(gcKilledPids, [720003], "atc gc must kill surviving detached grandchild of expired lease");
    assert.equal(readState(dir).leases["serial:emulator-5556"], undefined);

    // 2. Stale `.avd/*.lock` Dead-PID Detection in `avdHasRuntimeLockFiles`
    const crashedAvdDir = path.join(avdHome, "Crashed_Pixel.avd");
    fs.mkdirSync(crashedAvdDir, { recursive: true });
    fs.writeFileSync(path.join(crashedAvdDir, "config.ini"), "hw.ramSize=2048\n");
    const hwLockFile = path.join(crashedAvdDir, "hardware-qemu.ini.lock");
    const modemLockFile = path.join(crashedAvdDir, "modem-nv-ram-5554.lock");
    const snapshotLockDir = path.join(crashedAvdDir, "snapshot.lock");
    fs.writeFileSync(hwLockFile, "59872 \n");
    fs.writeFileSync(modemLockFile, " 59872\n");
    fs.mkdirSync(snapshotLockDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotLockDir, "pid"), "59872");

    // Dead PID (59872) -> avdHasRuntimeLockFiles returns false and removes stale lock files/dirs
    const deadLockCheck = avdHasRuntimeLockFiles("Crashed_Pixel", avdHome, (pid) => pid !== 59872);
    assert.equal(deadLockCheck, false, "Stale lock files with dead bare numeric PID must be ignored");
    assert.equal(fs.existsSync(hwLockFile), false, "Dead-PID hardware-qemu.ini.lock must be cleaned up");
    assert.equal(fs.existsSync(modemLockFile), false, "Dead-PID modem-nv-ram-5554.lock must be cleaned up");
    assert.equal(fs.existsSync(snapshotLockDir), false, "Dead-PID snapshot.lock/pid directory must be cleaned up");

    // Live numeric PID -> avdHasRuntimeLockFiles returns true and preserves the lock file
    fs.writeFileSync(hwLockFile, `${process.pid}\n`);
    assert.equal(avdHasRuntimeLockFiles("Crashed_Pixel", avdHome), true);
    assert.equal(fs.existsSync(hwLockFile), true);

    // Non-numeric / synthetic lock contents ("locked", "pid=123") -> preserved as active lock
    fs.writeFileSync(hwLockFile, "locked");
    assert.equal(avdHasRuntimeLockFiles("Crashed_Pixel", avdHome, () => false), true);
    fs.writeFileSync(hwLockFile, "pid=123");
    assert.equal(avdHasRuntimeLockFiles("Crashed_Pixel", avdHome, () => false), true);

    // Verify discoverFleet + computeUsedEmulatorSlots do not count an offline AVD with a dead-PID lock as occupying a slot
    fs.writeFileSync(hwLockFile, "59872\n");
    const fleetWithCrashedLock = discoverFleet({
      avdHome,
      livenessCheck: (pid) => pid !== 59872,
      runner: (cmd, args) => {
        if (cmd === "adb" && args[0] === "devices") {
          return { status: 0, stdout: "List of devices attached\n", stderr: "" };
        }
        if (cmd === "android") {
          return {
            status: 0,
            stdout: "Crashed_Pixel offline android-35\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(fleetWithCrashedLock.offline.length, 1);
    assert.equal(fleetWithCrashedLock.offline[0].hasLockFiles, false);
    assert.equal(computeUsedEmulatorSlots(createDefaultState(), fleetWithCrashedLock), 0);
    assert.equal(
      offlineAvdHasRuntimeLockFiles({ avd: "Crashed_Pixel" }, avdHome, (pid) => pid !== 59872),
      false,
    );

    // 1f. Tombstoned root identity when initial Windows snapshot misses already-exited root PID
    const missedRootPgid = 730001;
    clearKnownWindowsTreeDescendants(missedRootPgid);
    try {
      // Snapshot 1: root (730001) already exited, but child (730002) is alive and spawn-time root token was captured
      const mapMissed1 = queryWindowsProcessGroups(
        [missedRootPgid],
        () => ({
          status: 0,
          stdout: JSON.stringify([
            { ProcessId: 730002, ParentProcessId: 730001, CreationDate: "20261010170001.000000+000" },
          ]),
          stderr: "",
        }),
        { pgidStartTokens: { [String(missedRootPgid)]: "20261010170000.000000+000" } },
      );
      assert.equal(mapMissed1.get(missedRootPgid), true);
      const knownMissed1 = getKnownWindowsTreeDescendants(missedRootPgid);
      assert.deepEqual(
        knownMissed1.find((e) => e.pid === missedRootPgid),
        { pid: missedRootPgid, creationDate: "__exited__" },
      );

      // Snapshot 2: child (730002) exits, and Windows reuses root PID (730001) for an unrelated process with its own child (730099)
      clearKnownWindowsTreeDescendants(missedRootPgid);
      seedWindowsKnownDescendants({ [String(missedRootPgid)]: knownMissed1 });
      const mapMissed2 = queryWindowsProcessGroups([missedRootPgid], () => ({
        status: 0,
        stdout: JSON.stringify([
          { ProcessId: 730001, ParentProcessId: 9000, CreationDate: "20261010170999.000000+000" },
          { ProcessId: 730099, ParentProcessId: 730001, CreationDate: "20261010171000.000000+000" },
        ]),
        stderr: "",
      }));
      assert.equal(
        mapMissed2.get(missedRootPgid),
        false,
        "Tombstoned root PID missed on initial snapshot must not be adopted if reused later",
      );
    } finally {
      clearKnownWindowsTreeDescendants(missedRootPgid);
    }

    // 1g. cmdGc preserves live group leader on releaseOnWorkerExit lease
    const liveLeaderPgid = 740001;
    const liveGcState = createDefaultState();
    liveGcState.leases["serial:emulator-5558"] = {
      leaseId: "lease_live_leader_gc",
      deviceKey: "serial:emulator-5558",
      kind: "emulator",
      avd: "Pixel_Live_GC",
      serial: "emulator-5558",
      profile: { apiLevel: "android-35", deviceType: "phone" },
      sessionId: "live-gc-sess",
      anchorPid: process.pid,
      workerPid: liveLeaderPgid,
      workerPids: [liveLeaderPgid],
      workerPgids: [liveLeaderPgid],
      workerPgidStartTokens: {
        [String(liveLeaderPgid)]: "20261010180000.000000+000",
      },
      releaseOnWorkerExit: true,
      state: "active",
      claimedAtMs: now - 5_000,
      activatedAtMs: now - 4_000,
      renewedAtMs: now - 1_000,
      expiresAtMs: now + 300_000,
    };
    withLock(dir, (h) => commitState(dir, liveGcState, h));
    const liveGcKilled = [];
    const liveGcRes = cmdGc(dir, {
      platform: "win32",
      livenessCheck: (pid) => pid === process.pid || pid === liveLeaderPgid,
      runner: (cmd, args) => {
        if (cmd === "powershell.exe") {
          return {
            status: 0,
            stdout: JSON.stringify([
              { ProcessId: liveLeaderPgid, ParentProcessId: process.pid, CreationDate: "20261010180000.000000+000" },
            ]),
            stderr: "",
          };
        }
        if (cmd === "taskkill") {
          liveGcKilled.push(Number(args[args.indexOf("/PID") + 1]));
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(liveGcRes.exitCode, 0);
    assert.deepEqual(liveGcKilled, [], "cmdGc must not kill an active worker group leader while it is still alive");
    assert.ok(readState(dir).leases["serial:emulator-5558"], "Lease with live worker leader must remain active during GC");

    // 1h. killProcessGroupTree on Windows aborts taskkill when PowerShell refresh fails/times out
    const failedRefreshPgid = 750001;
    seedWindowsKnownDescendants({
      [String(failedRefreshPgid)]: [
        { pid: failedRefreshPgid, creationDate: "20261010190000.000000+000" },
        { pid: 750002, creationDate: "20261010190001.000000+000" },
      ],
    });
    try {
      const killedOnFailedRefresh = [];
      const resFailedRefresh = killProcessGroupTree(failedRefreshPgid, "SIGTERM", {
        platform: "win32",
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            return { status: 1, stdout: "", stderr: "PowerShell timed out" };
          }
          if (cmd === "taskkill") {
            killedOnFailedRefresh.push(Number(args[args.indexOf("/PID") + 1]));
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.deepEqual(resFailedRefresh, []);
      assert.deepEqual(resFailedRefresh.terminatedPgids, []);
      assert.deepEqual(
        killedOnFailedRefresh,
        [],
        "killProcessGroupTree must not kill cached PIDs when PowerShell snapshot refresh fails",
      );
      assert.equal(
        getKnownWindowsTreeDescendants(failedRefreshPgid).length,
        2,
        "Cached descendants must remain tracked when refresh fails so a subsequent retry can verify CreationDate",
      );

      const failedGcState = createDefaultState();
      failedGcState.leases["serial:emulator-5560"] = {
        leaseId: "lease_failed_refresh_gc",
        deviceKey: "serial:emulator-5560",
        kind: "emulator",
        avd: "Pixel_Failed_Refresh_GC",
        serial: "emulator-5560",
        profile: { apiLevel: "android-35", deviceType: "phone" },
        sessionId: "failed-gc-sess",
        anchorPid: 999999,
        workerPid: failedRefreshPgid,
        workerPids: [failedRefreshPgid],
        workerPgids: [failedRefreshPgid],
        workerDescendants: {
          [String(failedRefreshPgid)]: [
            { pid: failedRefreshPgid, creationDate: "20261010190000.000000+000" },
            { pid: 750002, creationDate: "20261010190001.000000+000" },
          ],
        },
        releaseOnWorkerExit: true,
        state: "active",
        claimedAtMs: now - 600_000,
        activatedAtMs: now - 599_000,
        renewedAtMs: now - 500_000,
        expiresAtMs: now - 10_000,
      };
      withLock(dir, (h) => commitState(dir, failedGcState, h));
      const failedGcRes = cmdGc(dir, {
        platform: "win32",
        livenessCheck: () => false,
        runner: (cmd) => {
          if (cmd === "powershell.exe") {
            return { status: 1, stdout: "", stderr: "PowerShell timed out" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(failedGcRes.exitCode, 0);
      const preservedLease = readState(dir).leases["serial:emulator-5560"];
      assert.ok(
        preservedLease,
        "cmdGc must not drop a lease when Windows tree termination could not be verified",
      );
      assert.equal(
        preservedLease.workerDescendants?.[String(failedRefreshPgid)]?.length,
        2,
        "cmdGc must preserve workerDescendants when Windows tree termination could not be verified",
      );

      const resTimedOutTaskkill = killProcessGroupTree(failedRefreshPgid, "SIGTERM", {
        platform: "win32",
        runner: (cmd) => {
          if (cmd === "powershell.exe") {
            return {
              status: 0,
              stdout: JSON.stringify([
                { ProcessId: 750002, ParentProcessId: failedRefreshPgid, CreationDate: "20261010190001.000000+000" },
              ]),
              stderr: "",
            };
          }
          if (cmd === "taskkill") {
            return { status: null, error: new Error("spawnSync taskkill ETIMEDOUT") };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.deepEqual(resTimedOutTaskkill, []);
      assert.deepEqual(
        resTimedOutTaskkill.terminatedPgids,
        [],
        "killProcessGroupTree must not confirm termination when taskkill times out with status: null",
      );
      assert.equal(
        getKnownWindowsTreeDescendants(failedRefreshPgid).length,
        2,
        "Cached descendants must remain tracked when taskkill times out",
      );
    } finally {
      clearKnownWindowsTreeDescendants(failedRefreshPgid);
    }

    // 2f. Concurrent replacement of stale AVD lock during liveness check preserves the new live lock
    const raceAvdDir = path.join(avdHome, "Pixel_Race.avd");
    fs.mkdirSync(raceAvdDir, { recursive: true });
    const raceLockFile = path.join(raceAvdDir, "hardware-qemu.ini.lock");
    fs.writeFileSync(raceLockFile, "99111\n", "utf8");
    const raceLive = avdHasRuntimeLockFiles("Pixel_Race", avdHome, (pid) => {
      if (pid === 99111) {
        // Simulate a new emulator replacing the lock file right as the dead PID check runs
        fs.unlinkSync(raceLockFile);
        fs.writeFileSync(raceLockFile, "99222\n", "utf8");
        return false;
      }
      return pid === 99222;
    });
    assert.equal(
      raceLive,
      true,
      "Replacement lock file created concurrently with stale-lock cleanup must be preserved and reported as live",
    );
    assert.equal(fs.existsSync(raceLockFile), true);
    assert.equal(fs.readFileSync(raceLockFile, "utf8").trim(), "99222");

    // 1i. cmdGc and cmdFree on Windows reap orphaned grandchildren even when exited group leader PID is reused by an unrelated process
    const reusedLeaderPgid = 760001;
    clearKnownWindowsTreeDescendants(reusedLeaderPgid);
    try {
      const reusedGcState = createDefaultState();
      reusedGcState.leases["serial:emulator-5562"] = {
        leaseId: "lease_reused_leader_gc",
        deviceKey: "serial:emulator-5562",
        kind: "emulator",
        avd: "Pixel_Reused_Leader_GC",
        serial: "emulator-5562",
        profile: { apiLevel: "android-35", deviceType: "phone" },
        sessionId: "reused-gc-sess",
        anchorPid: process.pid,
        workerPid: reusedLeaderPgid,
        workerPids: [reusedLeaderPgid],
        workerPgids: [reusedLeaderPgid],
        workerDescendants: {
          [String(reusedLeaderPgid)]: [
            { pid: reusedLeaderPgid, creationDate: "20261010200000.000000+000" },
            { pid: 760003, creationDate: "20261010200002.000000+000" },
          ],
        },
        releaseOnWorkerExit: true,
        state: "active",
        claimedAtMs: now - 10_000,
        activatedAtMs: now - 9_000,
        renewedAtMs: now - 1_000,
        expiresAtMs: now + 300_000,
      };
      withLock(dir, (h) => commitState(dir, reusedGcState, h));
      const reusedGcKilled = [];
      const reusedGcRes = cmdGc(dir, {
        platform: "win32",
        // Numeric PID 760001 is alive in OS because an unrelated process reused it!
        livenessCheck: (pid) => pid === process.pid || pid === reusedLeaderPgid || pid === 760003,
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            return {
              status: 0,
              stdout: JSON.stringify([
                // Unrelated process with a different CreationDate now occupies 760001
                { ProcessId: reusedLeaderPgid, ParentProcessId: 4000, CreationDate: "20261010209999.000000+000" },
                // Surviving detached grandchild from the original worker tree
                { ProcessId: 760003, ParentProcessId: 760002, CreationDate: "20261010200002.000000+000" },
              ]),
              stderr: "",
            };
          }
          if (cmd === "taskkill") {
            for (let i = 0; i < args.length; i++) {
              if (args[i] === "/PID" && args[i + 1]) {
                reusedGcKilled.push(Number(args[i + 1]));
              }
            }
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(reusedGcRes.exitCode, 0);
      assert.deepEqual(
        reusedGcKilled,
        [760003],
        "cmdGc must terminate orphaned Windows grandchild without killing the unrelated process that reused the leader PID",
      );
      assert.equal(
        readState(dir).leases["serial:emulator-5562"],
        undefined,
        "cmdGc must prune the releaseOnWorkerExit lease once orphaned grandchild is terminated despite leader PID reuse",
      );
    } finally {
      clearKnownWindowsTreeDescendants(reusedLeaderPgid);
    }

    // 1j. Missing/null CreationDate in CIM snapshot for a PID with an expected token is treated as unverifiable and aborts taskkill
    const nullTokenPgid = 770001;
    seedWindowsKnownDescendants({
      [String(nullTokenPgid)]: [
        { pid: nullTokenPgid, creationDate: "20261010210000.000000+000" },
        { pid: 770002, creationDate: "20261010210001.000000+000" },
      ],
    });
    try {
      const nullTokenKilled = [];
      const nullTokenRes = killProcessGroupTree(nullTokenPgid, "SIGTERM", {
        platform: "win32",
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            return {
              status: 0,
              stdout: JSON.stringify([
                // Live PID 770002 returned with null CreationDate (e.g., privileged replacement process)
                { ProcessId: 770002, ParentProcessId: 4000, CreationDate: null },
              ]),
              stderr: "",
            };
          }
          if (cmd === "taskkill") {
            nullTokenKilled.push(Number(args[args.indexOf("/PID") + 1]));
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.deepEqual(nullTokenRes, []);
      assert.deepEqual(
        nullTokenRes.terminatedPgids,
        [],
        "killProcessGroupTree must abort destructive termination when expected CreationDate cannot be verified against a null CIM token",
      );
      assert.deepEqual(
        nullTokenKilled,
        [],
        "killProcessGroupTree must not pass PID with missing CreationDate to taskkill /F",
      );
      assert.equal(
        getKnownWindowsTreeDescendants(nullTokenPgid).length,
        2,
        "Cached descendants must remain intact when CreationDate is unverifiable",
      );
    } finally {
      clearKnownWindowsTreeDescendants(nullTokenPgid);
    }

    // 1k. POSIX killProcessGroupTree does not report pgid in terminatedPgids when kill(-pgid) fails with EPERM and group remains alive
    const posixEpermPgid = 780001;
    const posixEpermRes = killProcessGroupTree(posixEpermPgid, "SIGKILL", {
      platform: "darwin",
      killFn: (target) => {
        if (target === -posixEpermPgid) {
          const eperm = new Error("Operation not permitted");
          eperm.code = "EPERM";
          throw eperm;
        }
        const esrch = new Error("No such process");
        esrch.code = "ESRCH";
        throw esrch;
      },
      runner: (cmd) => {
        if (cmd === "ps") {
          return {
            status: 0,
            stdout: `${posixEpermPgid} S\n`,
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(posixEpermRes, []);
    assert.deepEqual(
      posixEpermRes.terminatedPgids,
      [],
      "POSIX killProcessGroupTree must not confirm termination when kill(-pgid) returns EPERM and group remains alive",
    );

    // 1l. Exited tracked intermediate PID is not traversed for new children after unobserved PID reuse + exit
    const unobservedReusePgid = 790001;
    seedWindowsKnownDescendants({
      [String(unobservedReusePgid)]: [
        { pid: unobservedReusePgid, creationDate: "20261010220000.000000+000" },
        { pid: 790002, creationDate: "20261010220001.000000+000" },
      ],
    });
    try {
      const unobservedKilled = [];
      const unobservedRes = killProcessGroupTree(unobservedReusePgid, "SIGTERM", {
        platform: "win32",
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            return {
              status: 0,
              stdout: JSON.stringify([
                // 790002 exited, was briefly reused by an unrelated parent that spawned 790099 and exited before this snapshot
                { ProcessId: 790099, ParentProcessId: 790002, CreationDate: "20261010220500.000000+000" },
              ]),
              stderr: "",
            };
          }
          if (cmd === "taskkill") {
            unobservedKilled.push(Number(args[args.indexOf("/PID") + 1]));
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.deepEqual(unobservedRes, []);
      assert.deepEqual(
        unobservedKilled,
        [],
        "killProcessGroupTree must not adopt or kill children of an already-exited intermediate PID after unobserved reuse",
      );
    } finally {
      clearKnownWindowsTreeDescendants(unobservedReusePgid);
    }

    // 1m. Newly discovered Windows root or child PID with missing/null CreationDate is rejected and not cached as creationDate: null
    const nullInitialPgid = 800001;
    clearKnownWindowsTreeDescendants(nullInitialPgid);
    try {
      const firstNullQuery = queryWindowsProcessGroups(
        [nullInitialPgid],
        () => ({
          status: 0,
          stdout: JSON.stringify([
            { ProcessId: nullInitialPgid, ParentProcessId: 4000, CreationDate: null },
          ]),
          stderr: "",
        }),
        { triState: true, pgidStartTokens: { [String(nullInitialPgid)]: "20261010230000.000000+000" } },
      );
      assert.equal(
        firstNullQuery.get(nullInitialPgid),
        null,
        "Initial snapshot with null CreationDate on live root PID must be treated as unverifiable (null in triState mode)",
      );
      assert.deepEqual(
        getKnownWindowsTreeDescendants(nullInitialPgid),
        [],
        "PID with missing CreationDate must not be cached with creationDate: null",
      );

      // Child discovered via BFS with null CreationDate also marks snapshot unverifiable without caching creationDate: null
      const bfsNullQuery = queryWindowsProcessGroups(
        [nullInitialPgid],
        () => ({
          status: 0,
          stdout: JSON.stringify([
            { ProcessId: nullInitialPgid, ParentProcessId: 4000, CreationDate: "20261010230000.000000+000" },
            { ProcessId: 800002, ParentProcessId: nullInitialPgid, CreationDate: null },
          ]),
          stderr: "",
        }),
        { triState: true, pgidStartTokens: { [String(nullInitialPgid)]: "20261010230000.000000+000" } },
      );
      assert.equal(
        bfsNullQuery.get(nullInitialPgid),
        null,
        "Child discovered via BFS with null CreationDate must mark snapshot unverifiable",
      );
      assert.deepEqual(
        getKnownWindowsTreeDescendants(nullInitialPgid),
        [],
        "Partial tree with unverifiable child CreationDate must not be cached",
      );
    } finally {
      clearKnownWindowsTreeDescendants(nullInitialPgid);
    }

    // 1n. POSIX killProcessGroupTree does not signal positive childPid when kill(-childPid) returns ESRCH
    const posixEsrchPgid = 810001;
    const posixSignaledTargets = [];
    const posixEsrchRes = killProcessGroupTree(posixEsrchPgid, "SIGKILL", {
      platform: "darwin",
      killFn: (target) => {
        posixSignaledTargets.push(target);
        const esrch = new Error("No such process");
        esrch.code = "ESRCH";
        throw esrch;
      },
    });
    assert.deepEqual(
      posixSignaledTargets,
      [-posixEsrchPgid],
      "POSIX killProcessGroupTree must not fall back to signaling positive childPid when process group -childPid is gone",
    );
    assert.deepEqual(posixEsrchRes, []);
    assert.deepEqual(posixEsrchRes.terminatedPgids, [posixEsrchPgid]);

    // 1o. Windows process-group generation archiving isolates reused leader PID across worker generations
    {
      const genLeaderPgid = 820001;
      const oldGenChildPid = 820002;
      const newGenChildPid = 820003;
      const gen1Creation = "20261010231000.000000+000";
      const gen1ChildCreation = "20261010231001.000000+000";
      const gen2Creation = "20261010232000.000000+000";
      const gen2ChildCreation = "20261010232001.000000+000";
      const gen1ArchiveKey = `${genLeaderPgid}@${gen1Creation}`;
      clearKnownWindowsTreeDescendants(genLeaderPgid);
      clearKnownWindowsTreeDescendants(gen1ArchiveKey);
      try {
        const genLease = {
          leaseId: "lease_win_gen",
          deviceKey: "avd:Pixel_Gen",
          workerPids: [genLeaderPgid],
          workerPid: genLeaderPgid,
          workerPgids: [genLeaderPgid],
          workerDescendants: {
            [String(genLeaderPgid)]: [
              { pid: genLeaderPgid, creationDate: gen1Creation, alive: false },
              { pid: oldGenChildPid, creationDate: gen1ChildCreation, alive: true },
            ],
          },
        };
        seedWindowsKnownDescendants(genLease.workerDescendants);

        // New worker spawns reusing numeric PID 820001 with gen2Creation while oldGenChildPid (820002) is still running
        const archivedKey = archiveWindowsProcessGroupGeneration(genLeaderPgid);
        assert.equal(archivedKey, gen1ArchiveKey);

        const gen2Snapshot = [
          { ProcessId: genLeaderPgid, ParentProcessId: 4000, CreationDate: gen2Creation },
          { ProcessId: newGenChildPid, ParentProcessId: genLeaderPgid, CreationDate: gen2ChildCreation },
          { ProcessId: oldGenChildPid, ParentProcessId: 1, CreationDate: gen1ChildCreation },
        ];
        queryWindowsProcessGroups(
          [gen1ArchiveKey, genLeaderPgid],
          () => ({
            status: 0,
            stdout: JSON.stringify(gen2Snapshot),
            stderr: "",
          }),
          {
            knownDescendants: genLease.workerDescendants,
            pgidStartTokens: { [String(genLeaderPgid)]: gen2Creation },
          },
        );

        addLeaseWorker(
          genLease,
          genLeaderPgid,
          (pid) => [genLeaderPgid, oldGenChildPid, newGenChildPid].includes(pid),
          { isProcessGroup: true, freshGeneration: true },
        );

        assert.ok(
          genLease.workerPgids.includes(gen1ArchiveKey) &&
            genLease.workerPgids.includes(genLeaderPgid),
          `Expected lease.workerPgids to track both archived ${gen1ArchiveKey} and current ${genLeaderPgid}, got ${JSON.stringify(genLease.workerPgids)}`,
        );
        assert.deepEqual(
          getKnownWindowsTreeDescendants(genLeaderPgid).map((e) => e.pid).sort((a, b) => a - b),
          [genLeaderPgid, newGenChildPid],
          "Current generation tree must contain new root and new child, not old generation descendant",
        );
        assert.deepEqual(
          getKnownWindowsTreePids(gen1ArchiveKey, { liveOnly: true }),
          [oldGenChildPid],
          "Archived generation tree must retain only the surviving old generation descendant",
        );

        // Signal forwarding / cleanup for the new worker (numeric genLeaderPgid) terminates only gen2 and spares oldGenChildPid
        const killedGen2Pids = [];
        killProcessGroupTree(genLeaderPgid, "SIGTERM", {
          platform: "win32",
          runner: (cmd, args) => {
            if (cmd === "powershell.exe") {
              return {
                status: 0,
                stdout: JSON.stringify(gen2Snapshot),
                stderr: "",
              };
            }
            if (cmd === "taskkill") {
              for (let i = 0; i < args.length; i += 1) {
                if (args[i] === "/PID") {
                  killedGen2Pids.push(Number(args[i + 1]));
                }
              }
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        });
        assert.deepEqual(
          killedGen2Pids.sort((a, b) => a - b),
          [genLeaderPgid, newGenChildPid],
          "Terminating new worker generation must kill new root and new child without killing old generation descendant",
        );
      } finally {
        clearKnownWindowsTreeDescendants(genLeaderPgid);
        clearKnownWindowsTreeDescendants(gen1ArchiveKey);
      }
    }

    // 1p. Cross-lease reused Windows leader PID disassociates bare PGID from the previous lease
    {
      const crossLeaderPgid = 830001;
      const oldLeaseChildPid = 830002;
      const newLeaseChildPid = 830003;
      const genACreation = "20261010233000.000000+000";
      const genAChildCreation = "20261010233001.000000+000";
      const genBCreation = "20261010234000.000000+000";
      const genBChildCreation = "20261010234001.000000+000";
      const genAArchiveKey = `${crossLeaderPgid}@${genACreation}`;
      clearKnownWindowsTreeDescendants(crossLeaderPgid);
      clearKnownWindowsTreeDescendants(genAArchiveKey);
      try {
        const leaseA = {
          leaseId: "lease_win_cross_a",
          deviceKey: "avd:Pixel_Cross_A",
          workerPids: [crossLeaderPgid],
          workerPid: crossLeaderPgid,
          workerPgids: [crossLeaderPgid],
          workerDescendants: {
            [String(crossLeaderPgid)]: [
              { pid: crossLeaderPgid, creationDate: genACreation, alive: false },
              { pid: oldLeaseChildPid, creationDate: genAChildCreation, alive: true },
            ],
          },
        };
        const leaseB = {
          leaseId: "lease_win_cross_b",
          deviceKey: "avd:Pixel_Cross_B",
          workerPids: [],
          workerPid: null,
        };
        seedWindowsKnownDescendants(leaseA.workerDescendants);
        archiveWindowsProcessGroupGeneration(crossLeaderPgid);

        const crossSnapshot = [
          { ProcessId: crossLeaderPgid, ParentProcessId: 4000, CreationDate: genBCreation },
          { ProcessId: newLeaseChildPid, ParentProcessId: crossLeaderPgid, CreationDate: genBChildCreation },
          { ProcessId: oldLeaseChildPid, ParentProcessId: 1, CreationDate: genAChildCreation },
        ];
        queryWindowsProcessGroups(
          [genAArchiveKey, crossLeaderPgid],
          () => ({
            status: 0,
            stdout: JSON.stringify(crossSnapshot),
            stderr: "",
          }),
          {
            knownDescendants: leaseA.workerDescendants,
            pgidStartTokens: { [String(crossLeaderPgid)]: genBCreation },
          },
        );

        const liveCheck = (pid) =>
          [crossLeaderPgid, oldLeaseChildPid, newLeaseChildPid].includes(pid);
        syncLeaseWorkers(leaseA, liveCheck);
        addLeaseWorker(leaseB, crossLeaderPgid, liveCheck, {
          isProcessGroup: true,
          freshGeneration: true,
        });

        assert.deepEqual(
          leaseA.workerPgids,
          [genAArchiveKey],
          "Previous lease must replace bare PGID with archived generation key and not retain bare PGID owned by new lease",
        );
        assert.deepEqual(
          leaseB.workerPgids,
          [crossLeaderPgid],
          "New lease must own the bare numeric PGID for the current generation",
        );

        const killedLeaseAPids = [];
        killProcessGroupTree(leaseA, "SIGKILL", {
          platform: "win32",
          runner: (cmd, args) => {
            if (cmd === "powershell.exe") {
              return { status: 0, stdout: JSON.stringify(crossSnapshot), stderr: "" };
            }
            if (cmd === "taskkill") {
              for (let i = 0; i < args.length; i += 1) {
                if (args[i] === "/PID") {
                  killedLeaseAPids.push(Number(args[i + 1]));
                }
              }
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        });
        assert.deepEqual(
          killedLeaseAPids,
          [oldLeaseChildPid],
          "Killing previous lease must only terminate its archived generation descendant and spare new lease worker",
        );
      } finally {
        clearKnownWindowsTreeDescendants(crossLeaderPgid);
        clearKnownWindowsTreeDescendants(genAArchiveKey);
      }
    }

    // 1q. Tombstoned-root generation (`creationDate: "__exited__"`) is archived under a synthetic generation key when root PID is reused
    {
      const tombLeaderPgid = 840001;
      const tombOldChildPid = 840002;
      const tombNewChildPid = 840003;
      const tombOldChildCreation = "20261010235001.000000+000";
      const tombNewRootCreation = "20261010235500.000000+000";
      const tombNewChildCreation = "20261010235501.000000+000";
      const expectedTombArchiveKey = `${tombLeaderPgid}@__exited__:${tombOldChildPid}:${tombOldChildCreation}`;
      clearKnownWindowsTreeDescendants(tombLeaderPgid);
      clearKnownWindowsTreeDescendants(expectedTombArchiveKey);
      try {
        const tombLeaseA = {
          leaseId: "lease_win_tomb_a",
          deviceKey: "avd:Pixel_Tomb_A",
          workerPids: [tombLeaderPgid],
          workerPid: tombLeaderPgid,
          workerPgids: [tombLeaderPgid],
          workerDescendants: {
            [String(tombLeaderPgid)]: [
              { pid: tombLeaderPgid, creationDate: "__exited__", alive: false },
              { pid: tombOldChildPid, creationDate: tombOldChildCreation, alive: true },
            ],
          },
        };
        const tombLeaseB = {
          leaseId: "lease_win_tomb_b",
          deviceKey: "avd:Pixel_Tomb_B",
          workerPids: [],
          workerPid: null,
        };
        seedWindowsKnownDescendants(tombLeaseA.workerDescendants);
        const archivedKey = archiveWindowsProcessGroupGeneration(tombLeaderPgid);
        assert.equal(archivedKey, expectedTombArchiveKey);

        const tombSnapshot = [
          { ProcessId: tombLeaderPgid, ParentProcessId: 4000, CreationDate: tombNewRootCreation },
          { ProcessId: tombNewChildPid, ParentProcessId: tombLeaderPgid, CreationDate: tombNewChildCreation },
          { ProcessId: tombOldChildPid, ParentProcessId: 1, CreationDate: tombOldChildCreation },
        ];
        queryWindowsProcessGroups(
          [expectedTombArchiveKey, tombLeaderPgid],
          () => ({
            status: 0,
            stdout: JSON.stringify(tombSnapshot),
            stderr: "",
          }),
          {
            knownDescendants: tombLeaseA.workerDescendants,
            pgidStartTokens: { [String(tombLeaderPgid)]: tombNewRootCreation },
          },
        );

        const liveCheck = (pid) =>
          [tombLeaderPgid, tombOldChildPid, tombNewChildPid].includes(pid);
        syncLeaseWorkers(tombLeaseA, liveCheck);
        addLeaseWorker(tombLeaseB, tombLeaderPgid, liveCheck, {
          isProcessGroup: true,
          freshGeneration: true,
        });

        assert.deepEqual(tombLeaseA.workerPgids, [expectedTombArchiveKey]);
        assert.deepEqual(tombLeaseB.workerPgids, [tombLeaderPgid]);
        assert.deepEqual(
          getKnownWindowsTreePids(expectedTombArchiveKey, { liveOnly: true }),
          [tombOldChildPid],
        );
        assert.deepEqual(
          getKnownWindowsTreePids(tombLeaderPgid, { liveOnly: true }).sort((a, b) => a - b),
          [tombLeaderPgid, tombNewChildPid],
        );
      } finally {
        clearKnownWindowsTreeDescendants(tombLeaderPgid);
        clearKnownWindowsTreeDescendants(expectedTombArchiveKey);
      }
    }

    // 1r. POSIX `free --force` / `killProcessGroupTree` verifies group leader start token before signaling `-pgid`
    {
      const posixReusedPgid = 850001;
      const posixUnverifiablePgid = 850002;
      const posixVerifiedPgid = 850003;
      const recordedToken = "Mon Oct 10 10:00:00 2026";
      const reusedToken = "Mon Oct 10 10:05:00 2026";
      clearKnownPosixPgidStartTokens(posixReusedPgid);
      clearKnownPosixPgidStartTokens(posixUnverifiablePgid);
      clearKnownPosixPgidStartTokens(posixVerifiedPgid);
      try {
        // Case A: Reused POSIX leader PID (mismatched start token) is NOT signaled by `free --force`, and stale PGID is pruned
        withStateTransaction(dir, (state, { now }) => {
          state.leases["avd:Pixel_Posix_Reused"] = {
            leaseId: "lease_posix_reused",
            deviceKey: "avd:Pixel_Posix_Reused",
            avd: "Pixel_Posix_Reused",
            serial: "emulator-5596",
            kind: "emulator",
            state: "active",
            sessionId: "posix-reused-sess",
            anchorPid: process.pid,
            workerPid: posixReusedPgid,
            workerPids: [posixReusedPgid],
            workerPgids: [posixReusedPgid],
            workerPgidStartTokens: {
              [String(posixReusedPgid)]: recordedToken,
            },
            claimedAtMs: now - 5000,
            renewedAtMs: now - 1000,
            expiresAtMs: now + 60_000,
          };
          return { mutated: true };
        });

        const signaledReused = [];
        const freeReusedRes = cmdFree(
          dir,
          "lease_posix_reused",
          { session: "admin-sess", force: true },
          {
            platform: "darwin",
            livenessCheck: (pid) => pid === process.pid || pid === posixReusedPgid,
            killFn: (targetPid, sig) => {
              if (sig !== 0) {
                signaledReused.push({ targetPid, sig });
              }
            },
            spawnSyncFn: (cmd, args) => {
              if (cmd === "ps" && args[0] === "-o" && args[1] === "lstart=") {
                return { status: 0, stdout: `${reusedToken}\n`, stderr: "" };
              }
              return { status: 0, stdout: `${posixReusedPgid} S\n`, stderr: "" };
            },
          },
        );
        assert.equal(freeReusedRes.exitCode, 0);
        assert.deepEqual(
          signaledReused,
          [],
          "POSIX free --force must not signal -pgid when the leader PID start token mismatches (reused PID)",
        );
        assert.equal(
          readState(dir).leases["avd:Pixel_Posix_Reused"],
          undefined,
          "Lease must be released after reused POSIX leader PID is pruned without signaling the unrelated process group",
        );

        // Case B: Live POSIX leader PID with missing/unverifiable start token fails closed without signaling `-pgid`
        withStateTransaction(
          dir,
          (state, { now }) => {
            state.leases["avd:Pixel_Posix_Unverifiable"] = {
              leaseId: "lease_posix_unverifiable",
              deviceKey: "avd:Pixel_Posix_Unverifiable",
              avd: "Pixel_Posix_Unverifiable",
              serial: "emulator-5597",
              kind: "emulator",
              state: "active",
              sessionId: "posix-unverifiable-sess",
              anchorPid: process.pid,
              workerPid: posixUnverifiablePgid,
              workerPids: [posixUnverifiablePgid],
              workerPgids: [posixUnverifiablePgid],
              workerPgidStartTokens: {
                [String(posixUnverifiablePgid)]: recordedToken,
              },
              claimedAtMs: now - 5000,
              renewedAtMs: now - 1000,
              expiresAtMs: now + 60_000,
            };
            return { mutated: true };
          },
          {
            platform: "darwin",
            livenessCheck: (pid) => pid === process.pid || pid === posixUnverifiablePgid,
            spawnSyncFn: (cmd, args) => {
              if (cmd === "ps" && args[0] === "-o" && args[1] === "lstart=") {
                return { status: 0, stdout: `${recordedToken}\n`, stderr: "" };
              }
              return { status: 0, stdout: `${posixUnverifiablePgid} S\n`, stderr: "" };
            },
          },
        );

        const signaledUnverifiable = [];
        const freeUnverifiableRes = cmdFree(
          dir,
          "lease_posix_unverifiable",
          { session: "admin-sess", force: true },
          {
            platform: "darwin",
            livenessCheck: (pid) => pid === process.pid || pid === posixUnverifiablePgid,
            killFn: (targetPid, sig) => {
              if (sig !== 0) {
                signaledUnverifiable.push({ targetPid, sig });
              }
            },
            spawnSyncFn: (cmd, args) => {
              if (cmd === "ps" && args[0] === "-o" && args[1] === "lstart=") {
                return { status: 1, stdout: "", stderr: "ps failed" };
              }
              return { status: 0, stdout: `${posixUnverifiablePgid} S\n`, stderr: "" };
            },
          },
        );
        assert.equal(
          freeUnverifiableRes.exitCode,
          3,
          "POSIX free --force must retain the lease when a live leader PID's start token cannot be verified",
        );
        assert.deepEqual(
          signaledUnverifiable,
          [],
          "POSIX free --force must not signal -pgid when start token lookup fails for a live leader PID",
        );
        withStateTransaction(dir, (state) => {
          delete state.leases["avd:Pixel_Posix_Unverifiable"];
          return { mutated: true };
        });

        // Case C: Verified POSIX leader PID (matching start token) IS signaled by `free --force` and lease is released
        withStateTransaction(
          dir,
          (state, { now }) => {
            state.leases["avd:Pixel_Posix_Verified"] = {
              leaseId: "lease_posix_verified",
              deviceKey: "avd:Pixel_Posix_Verified",
              avd: "Pixel_Posix_Verified",
              serial: "emulator-5598",
              kind: "emulator",
              state: "active",
              sessionId: "posix-verified-sess",
              anchorPid: process.pid,
              workerPid: posixVerifiedPgid,
              workerPids: [posixVerifiedPgid],
              workerPgids: [posixVerifiedPgid],
              workerPgidStartTokens: {
                [String(posixVerifiedPgid)]: recordedToken,
              },
              claimedAtMs: now - 5000,
              renewedAtMs: now - 1000,
              expiresAtMs: now + 60_000,
            };
            return { mutated: true };
          },
          {
            platform: "darwin",
            livenessCheck: (pid) => pid === process.pid || pid === posixVerifiedPgid,
            spawnSyncFn: (cmd, args) => {
              if (cmd === "ps" && args[0] === "-o" && args[1] === "lstart=") {
                return { status: 0, stdout: `${recordedToken}\n`, stderr: "" };
              }
              return { status: 0, stdout: `${posixVerifiedPgid} S\n`, stderr: "" };
            },
          },
        );

        const signaledVerified = [];
        const freeVerifiedRes = cmdFree(
          dir,
          "lease_posix_verified",
          { session: "admin-sess", force: true },
          {
            platform: "darwin",
            livenessCheck: (pid) => pid === process.pid || pid === posixVerifiedPgid,
            killFn: (targetPid, sig) => {
              if (sig !== 0) {
                signaledVerified.push({ targetPid, sig });
              }
            },
            spawnSyncFn: (cmd, args) => {
              if (cmd === "ps" && args[0] === "-o" && args[1] === "lstart=") {
                return { status: 0, stdout: `${recordedToken}\n`, stderr: "" };
              }
              return { status: 0, stdout: `${posixVerifiedPgid} S\n`, stderr: "" };
            },
          },
        );
        assert.equal(freeVerifiedRes.exitCode, 0);
        assert.deepEqual(signaledVerified, [
          { targetPid: -posixVerifiedPgid, sig: "SIGKILL" },
        ]);
        assert.equal(readState(dir).leases["avd:Pixel_Posix_Verified"], undefined);

        // Case D: `addLeaseWorker` does not spawn a subprocess on macOS when `startToken` is null (default `allowSubprocess: false`)
        let addWorkerSpawnCalled = false;
        const noSubLease = {
          leaseId: "lease_no_sub",
          deviceKey: "avd:Pixel_No_Sub",
          workerPids: [],
          workerPid: null,
        };
        addLeaseWorker(noSubLease, process.pid, undefined, {
          isProcessGroup: true,
          platform: "darwin",
          spawnSyncFn: () => {
            addWorkerSpawnCalled = true;
            return { status: 0, stdout: `${recordedToken}\n`, stderr: "" };
          },
        });
        assert.equal(
          addWorkerSpawnCalled,
          false,
          "addLeaseWorker must not spawn a subprocess under atc.lock by default when startToken is omitted",
        );
      } finally {
        clearKnownPosixPgidStartTokens(posixReusedPgid);
        clearKnownPosixPgidStartTokens(posixUnverifiablePgid);
        clearKnownPosixPgidStartTokens(posixVerifiedPgid);
      }
    }

    // 1s. Windows root identity captured at spawn protects against PID reuse before the first full tree snapshot
    {
      const fastExitRootPgid = 860001;
      const reusedRootChildPid = 860099;
      const earlierOrphanPid = 860050;
      const legitimateSurvivingChildPid = 860055;
      const earlierOrphanToken = "20261010235850.000000+000";
      const genuineSpawnToken = "20261010235900.000000+000";
      const legitimateChildToken = "20261010235902.000000+000";
      const reusedRootToken = "20261010235905.000000+000";
      clearKnownWindowsTreeDescendants(fastExitRootPgid);
      clearKnownPosixPgidStartTokens(fastExitRootPgid);
      try {
        // Case A: Root exited and its PID was reused BEFORE the first full Windows process-table snapshot,
        // while the spawn-time CreationDate was captured in pgidStartTokens, and an earlier-generation orphan
        // still has ParentProcessId === fastExitRootPgid. Neither the reused root's child nor the older orphan is adopted.
        const reusedFirstSnap = queryWindowsProcessGroups(
          [fastExitRootPgid],
          () => ({
            status: 0,
            stdout: JSON.stringify([
              { ProcessId: fastExitRootPgid, ParentProcessId: 4000, CreationDate: reusedRootToken },
              { ProcessId: reusedRootChildPid, ParentProcessId: fastExitRootPgid, CreationDate: "20261010235906.000000+000" },
              { ProcessId: earlierOrphanPid, ParentProcessId: fastExitRootPgid, CreationDate: earlierOrphanToken },
            ]),
            stderr: "",
          }),
          {
            triState: true,
            pgidStartTokens: { [String(fastExitRootPgid)]: genuineSpawnToken },
          },
        );
        assert.equal(
          reusedFirstSnap.get(fastExitRootPgid),
          false,
          "First Windows snapshot must reject a live root PID whose CreationDate mismatches the spawn-time token and ignore older-generation orphans",
        );
        assert.deepEqual(
          getKnownWindowsTreeDescendants(fastExitRootPgid),
          [],
          "Unrelated process reusing the root PID or older-generation orphans must not be cached or adopted",
        );

        // Case A2: Legitimate surviving child created during [genuineSpawnToken, reusedRootToken) IS still discovered
        // even when the root PID was reused before the first snapshot.
        clearKnownWindowsTreeDescendants(fastExitRootPgid);
        clearKnownPosixPgidStartTokens(fastExitRootPgid);
        const survivingChildSnap = queryWindowsProcessGroups(
          [fastExitRootPgid],
          () => ({
            status: 0,
            stdout: JSON.stringify([
              { ProcessId: fastExitRootPgid, ParentProcessId: 4000, CreationDate: reusedRootToken },
              { ProcessId: reusedRootChildPid, ParentProcessId: fastExitRootPgid, CreationDate: "20261010235906.000000+000" },
              { ProcessId: legitimateSurvivingChildPid, ParentProcessId: fastExitRootPgid, CreationDate: legitimateChildToken },
            ]),
            stderr: "",
          }),
          {
            triState: true,
            pgidStartTokens: { [String(fastExitRootPgid)]: genuineSpawnToken },
          },
        );
        assert.equal(
          survivingChildSnap.get(fastExitRootPgid),
          true,
          "Surviving child created between genuineSpawnToken and reusedRootToken must keep the group alive",
        );
        assert.deepEqual(
          getKnownWindowsTreeDescendants(fastExitRootPgid),
          [
            { pid: fastExitRootPgid, creationDate: "__exited__" },
            { pid: legitimateSurvivingChildPid, creationDate: legitimateChildToken },
          ],
          "Only the __exited__ root sentinel and legitimate surviving child (not the reused root CreationDate or its new child) may be cached",
        );

        // Case A3: When the Windows wrapper exits during spawn-time capture (`getPosixProcessStartToken(..., { isSpawnCapture: true })`),
        // subsequent `addLeaseWorker(..., { isProcessGroup: true, freshGeneration: false, archivedGeneration: true })` must NOT
        // re-archive the freshly captured tree and must persist the detached child under `lease.workerDescendants[String(fastExitRootPgid)]`.
        clearKnownWindowsTreeDescendants(fastExitRootPgid);
        clearKnownPosixPgidStartTokens(fastExitRootPgid);
        archiveWindowsProcessGroupGeneration(fastExitRootPgid);
        const spawnCapTok = getPosixProcessStartToken(fastExitRootPgid, {
          platform: "win32",
          isSpawnCapture: true,
          spawnSyncFn: () => ({
            status: 0,
            stdout: JSON.stringify([
              { ProcessId: legitimateSurvivingChildPid, ParentProcessId: fastExitRootPgid, CreationDate: legitimateChildToken },
            ]),
            stderr: "",
          }),
        });
        assert.equal(spawnCapTok, "__exited__");
        const fastExitLease = {
          leaseId: "lease_fast_exit_win",
          deviceKey: "avd:Pixel_Fast_Exit",
          state: "active",
          sessionId: "fast-exit-sess",
          workerPids: [],
          workerPid: null,
        };
        addLeaseWorker(
          fastExitLease,
          fastExitRootPgid,
          (pid) => pid === legitimateSurvivingChildPid,
          {
            isProcessGroup: true,
            freshGeneration: false,
            archivedGeneration: true,
            platform: "win32",
            allowSubprocess: false,
          },
        );
        assert.deepEqual(
          fastExitLease.workerDescendants?.[String(fastExitRootPgid)],
          [
            { pid: fastExitRootPgid, creationDate: "__exited__" },
            { pid: legitimateSurvivingChildPid, creationDate: legitimateChildToken },
          ],
          "Fast-exited Windows wrapper's detached child must remain registered under bare numeric PGID in lease.workerDescendants",
        );

        // Case B: If the root exited so quickly that even spawn-time CreationDate capture missed it (no expectedStartToken),
        // and the PID is now occupied in the first snapshot, queryWindowsProcessGroups treats it as unverifiable (null) and
        // killProcessGroupTree refuses to run taskkill /F.
        clearKnownWindowsTreeDescendants(fastExitRootPgid);
        clearKnownPosixPgidStartTokens(fastExitRootPgid);
        const uncapturedKilled = [];
        const uncapturedKillRes = killProcessGroupTree(fastExitRootPgid, "SIGKILL", {
          platform: "win32",
          runner: (cmd, args) => {
            if (cmd === "powershell.exe") {
              return {
                status: 0,
                stdout: JSON.stringify([
                  { ProcessId: fastExitRootPgid, ParentProcessId: 4000, CreationDate: reusedRootToken },
                ]),
                stderr: "",
              };
            }
            if (cmd === "taskkill") {
              for (let i = 0; i < args.length; i += 1) {
                if (args[i] === "/PID") {
                  uncapturedKilled.push(Number(args[i + 1]));
                }
              }
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        });
        assert.deepEqual(
          uncapturedKilled,
          [],
          "killProcessGroupTree on Windows must not taskkill a live root PID when no spawn-time CreationDate was captured",
        );
        assert.deepEqual(uncapturedKillRes.terminatedPgids, []);
      } finally {
        clearKnownWindowsTreeDescendants(fastExitRootPgid);
        clearKnownPosixPgidStartTokens(fastExitRootPgid);
      }
    }

    // Concurrent lease renewal between cmdGc unlocked read (or after gcReapingAtMs marker while powershell runs) and beforeKill recheck prevents killing active detached group
    const concurrentRenewPgid = 890001;
    clearKnownWindowsTreeDescendants(concurrentRenewPgid);
    try {
      const gcRaceState = readState(dir);
      gcRaceState.leases["serial:emulator-5578"] = {
        leaseId: "lease_gc_race_renew",
        deviceKey: "serial:emulator-5578",
        kind: "emulator",
        avd: "Pixel_GC_Race",
        serial: "emulator-5578",
        profile: { apiLevel: "android-35", deviceType: "phone" },
        sessionId: "gc-race-sess",
        anchorPid: process.pid,
        workerPid: concurrentRenewPgid,
        workerPids: [concurrentRenewPgid],
        workerPgids: [concurrentRenewPgid],
        workerDescendants: {
          [String(concurrentRenewPgid)]: [
            { pid: concurrentRenewPgid, creationDate: "__exited__", alive: false },
            { pid: 890002, creationDate: "20261011000001.000000+000", alive: true },
          ],
        },
        state: "active",
        claimedAtMs: now - 600_000,
        activatedAtMs: now - 599_000,
        renewedAtMs: now - 500_000,
        expiresAtMs: now - 10_000,
      };
      withLock(dir, (h) => commitState(dir, gcRaceState, h));
      const raceKilledPids = [];
      let renewDuringReap = null;
      const winPsOutput = JSON.stringify([
        {
          ProcessId: 890002,
          ParentProcessId: concurrentRenewPgid,
          CreationDate: "20261011000001.000000+000",
        },
      ]);
      const gcRaceRes = cmdGc(dir, {
        platform: "win32",
        now,
        livenessCheck: (pid) => pid === process.pid || pid === 890002,
        runner: (cmd, args) => {
          if (cmd === "powershell.exe") {
            // Simulate cmdRenew landing AFTER cmdGc set gcReapingAtMs under lock, while powershell.exe is running outside the lock
            renewDuringReap = cmdRenew(
              dir,
              "lease_gc_race_renew",
              { session: "gc-race-sess", ttl: 300 },
              {
                platform: "win32",
                now,
                livenessCheck: (pid) => pid === process.pid || pid === 890002,
                runner: () => ({ status: 0, stdout: winPsOutput, stderr: "" }),
              },
            );
            return {
              status: 0,
              stdout: winPsOutput,
              stderr: "",
            };
          }
          if (cmd === "taskkill") {
            raceKilledPids.push(Number(args[args.indexOf("/PID") + 1]));
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(renewDuringReap?.exitCode, 0);
      assert.equal(gcRaceRes.exitCode, 0);
      assert.deepEqual(
        raceKilledPids,
        [],
        "cmdGc beforeKill recheck must not kill detached descendants when lease was renewed after gcReapingAtMs was set",
      );
      assert.ok(
        readState(dir).leases["serial:emulator-5578"],
        "Concurrently renewed lease must remain active after cmdGc",
      );
      withLock(dir, (h) => {
        const s = readState(dir, { lockHandle: h });
        delete s.leases["serial:emulator-5578"];
        commitState(dir, s, h);
      });
    } finally {
      clearKnownWindowsTreeDescendants(concurrentRenewPgid);
    }
  } finally {
    clearKnownWindowsTreeDescendants(rootPgid);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(avdHome, { recursive: true, force: true });
  }
});

test("ATC 2.0: watch/wear normalization, virtual crash recovery, physical disconnect fail-fast, and iOS multiplatform support", async () => {
  const {
    diagnosePlatformToolingError,
    inferIosDeviceType,
    parseDevicectlListJson,
    parseSimctlListJson,
    resolveTargetPlatform,
  } = await import("../src/ios.mjs");

  const dir = makeTempStateDir();
  try {
    // 1. Canonical "watch" form factor & "wear" alias normalization
    assert.equal(inferDeviceType("Wear_OS_Small_Round", "android-wear", "default"), "watch");
    assert.equal(inferIosDeviceType("Apple Watch Series 10 (46mm)", "Apple Watch", "watchOS-11-4"), "watch");
    assert.equal(
      matchesProfile(
        {
          platform: "android",
          kind: "emulator",
          avd: "Wear_OS_Small_Round",
          profile: { deviceType: "watch", apiLevel: "android-35" },
        },
        { platform: "android", kind: "emulator", deviceType: "wear" },
      ),
      true,
    );
    assert.equal(
      matchesProfile(
        {
          platform: "android",
          kind: "emulator",
          avd: "Wear_OS_Small_Round",
          profile: { deviceType: "wear", apiLevel: "android-35" },
        },
        { platform: "android", kind: "emulator", deviceType: "watch" },
      ),
      true,
    );

    // 2. Virtual device crash recovery in-place (preserving original expiresAtMs)
    const now0 = Date.now();
    const origExpiresAtMs = now0 + 300_000;
    withStateTransaction(dir, (state) => {
      state.leases["avd:Pixel_9"] = {
        leaseId: "lease-crash-1",
        deviceKey: "avd:Pixel_9",
        platform: "android",
        kind: "emulator",
        avd: "Pixel_9",
        serial: "emulator-5554",
        profile: {
          platform: "android",
          deviceType: "phone",
          apiLevel: "android-36",
          services: "play",
          playStore: true,
          abi: "arm64-v8a",
        },
        sessionId: "sess-recover",
        anchorPid: process.pid,
        state: "active",
        isRecovery: false,
        requiredRamMb: 3072,
        claimedAtMs: now0 - 60_000,
        activatedAtMs: now0 - 60_000,
        renewedAtMs: now0 - 10_000,
        expiresAtMs: origExpiresAtMs,
        firstSeenOfflineAtMs: null,
      };
      return { mutated: true };
    });

    // Reconcile offline: marks firstSeenOfflineAtMs and clears emulator serial
    const offlineInv = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      queriedPlatforms: ["android"],
      running: [],
      offline: [
        {
          deviceKey: "avd:Pixel_9",
          platform: "android",
          kind: "emulator",
          avd: "Pixel_9",
          serial: null,
          online: false,
          ramSizeMb: 2048,
          requiredRamMb: 3072,
          dataDiskMb: 6656,
          profile: {
            platform: "android",
            deviceType: "phone",
            apiLevel: "android-36",
            services: "play",
            playStore: true,
            abi: "arm64-v8a",
          },
        },
      ],
      creatable: [],
      probes: { emulatorListOk: true, adbDevicesOk: true },
    };

    const statusOffline = cmdStatus(dir, { android: true }, { inventory: offlineInv });
    assert.equal(statusOffline.exitCode, 0);
    assert.ok(statusOffline.leases["avd:Pixel_9"].firstSeenOfflineAtMs);
    assert.equal(statusOffline.leases["avd:Pixel_9"].serial, null);

    // Offline reservation rejects renew, snapshot, and typed device ops
    const renewOffline = cmdRenew(dir, null, { session: "sess-recover" });
    assert.equal(renewOffline.exitCode, 3);
    assert.match(renewOffline.error, /currently offline/);

    const snapOffline = cmdSnapshot(dir, "save", "snap1", { session: "sess-recover" });
    assert.equal(snapOffline.exitCode, 3);
    assert.match(snapOffline.error, /currently offline/);

    const execOffline = await cmdExec(
      dir,
      ["android", "prop", "get", "ro.build.version.sdk", "--session", "sess-recover", "--wait", "0", "--json"],
      { env: makeFakeToolEnv(dir, { adb: "exit 0" }) },
    );
    assert.notEqual(execOffline.exitCode, 0);
    assert.match(execOffline.error, /crashed or went offline/);

    // Owner re-claims within 45s recovery window -> reboots in-place and preserves original expiresAtMs
    const recoverClaim = cmdClaim(
      dir,
      { session: "sess-recover", type: "phone", ttl: 600, wait: 0 },
      {
        inventory: offlineInv,
        runner: (cmd, args) => {
          if (
            (cmd === "android" && args[0] === "emulator" && args[1] === "start") ||
            (cmd === "emulator" && args.includes("-avd"))
          ) {
            return { status: 0, stdout: "Started emulator-5554\n", stderr: "" };
          }
          if (cmd === "adb" && args.includes("sys.boot_completed")) {
            return { status: 0, stdout: "1\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(recoverClaim.exitCode, 0);
    assert.equal(recoverClaim.recovered, true);
    assert.equal(recoverClaim.lease.leaseId, "lease-crash-1");
    assert.equal(recoverClaim.lease.serial, "emulator-5554");
    assert.equal(recoverClaim.lease.isRecovery, false);
    assert.equal(recoverClaim.lease.firstSeenOfflineAtMs, null);
    assert.equal(
      recoverClaim.lease.expiresAtMs,
      origExpiresAtMs,
      "In-place crash recovery must preserve original expiresAtMs without extending claim duration",
    );

    // Non-executable offline reservation can be freed immediately without external commands
    withStateTransaction(dir, (state, { now }) => {
      state.leases["avd:Pixel_9"].firstSeenOfflineAtMs = now - 2_000;
      state.leases["avd:Pixel_9"].serial = null;
      state.leases["avd:Pixel_9"].saveSnapshotOnFree = "should_not_run";
      return { mutated: true };
    });
    const freeOfflineCalls = [];
    const freeOfflineRes = cmdFree(
      dir,
      null,
      { session: "sess-recover", stop: true },
      {
        runner: (cmd, args) => {
          freeOfflineCalls.push([cmd, ...args].join(" "));
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(freeOfflineRes.exitCode, 0);
    assert.equal(freeOfflineCalls.length, 0, "Freeing an offline reservation must not run adb/stop commands");
    assert.equal(readState(dir).leases["avd:Pixel_9"], undefined);

    // 3. Physical device disconnect fail-fast (within 15s window & via tombstone after 15s)
    withStateTransaction(dir, (state, { now }) => {
      state.leases["serial:PHYS123"] = {
        leaseId: "lease-phys-1",
        deviceKey: "serial:PHYS123",
        platform: "android",
        kind: "physical",
        avd: null,
        serial: "PHYS123",
        profile: {
          platform: "android",
          deviceType: "phone",
          deviceName: "Pixel 7 Pro",
          apiLevel: "android-36",
          services: "play",
          playStore: true,
          abi: "arm64-v8a",
        },
        sessionId: "sess-phys",
        anchorPid: process.pid,
        state: "active",
        claimedAtMs: now - 30_000,
        activatedAtMs: now - 30_000,
        renewedAtMs: now - 5_000,
        expiresAtMs: now + 300_000,
        firstSeenOfflineAtMs: now - 2_000,
      };
      return { mutated: true };
    });

    const physFailFast1 = cmdClaim(
      dir,
      { session: "sess-phys", serial: "PHYS123", wait: 60 },
      { inventory: offlineInv },
    );
    assert.equal(physFailFast1.exitCode, 1);
    assert.match(
      physFailFast1.error,
      /Physical device "PHYS123" disconnected while leased and cannot be restarted automatically/,
    );
    assert.equal(readState(dir).leases["serial:PHYS123"], undefined);

    // After 15s grace window expires, reconcileOfflineLeases records tombstone in disconnectedPhysicalLeases
    withStateTransaction(dir, (state, { now }) => {
      state.leases["serial:PHYS456"] = {
        leaseId: "lease-phys-2",
        deviceKey: "serial:PHYS456",
        platform: "android",
        kind: "physical",
        avd: null,
        serial: "PHYS456",
        profile: {
          platform: "android",
          deviceType: "phone",
          deviceName: "Pixel 7 Pro",
          apiLevel: "android-36",
        },
        sessionId: "sess-phys-2",
        anchorPid: process.pid,
        state: "active",
        claimedAtMs: now - 40_000,
        activatedAtMs: now - 40_000,
        renewedAtMs: now - 25_000,
        expiresAtMs: now + 300_000,
        firstSeenOfflineAtMs: now - 20_000,
      };
      reconcileOfflineLeases(state, offlineInv, "other-sess", now);
      return { mutated: true };
    });
    const postTombState = readState(dir);
    assert.equal(postTombState.leases["serial:PHYS456"], undefined);
    assert.ok(postTombState.disconnectedPhysicalLeases["lease-phys-2"]);

    const physFailFast2 = cmdClaim(
      dir,
      { session: "sess-phys-2", serial: "PHYS456", wait: 60 },
      { inventory: offlineInv },
    );
    assert.equal(physFailFast2.exitCode, 1);
    assert.match(
      physFailFast2.error,
      /Physical device "PHYS456" disconnected while leased and cannot be restarted automatically/,
    );
    assert.equal(readState(dir).disconnectedPhysicalLeases["lease-phys-2"], undefined);

    // 4. Multiplatform iOS resolution, parsing, diagnostics, lifecycle, snapshots, and typed-op env
    assert.equal(resolveTargetPlatform({ ios: true }), "ios");
    assert.equal(resolveTargetPlatform({ android: true }), "android");
    assert.equal(resolveTargetPlatform({ udid: "D9746857-E328-43FF-A79B-42CDE3AD9D71" }), "ios");
    assert.equal(resolveTargetPlatform({ os: ">=18.0" }), "ios");
    assert.equal(resolveTargetPlatform({ avd: "iPhone 16 Pro" }), "ios");
    assert.throws(() => resolveTargetPlatform({ ios: true, android: true }), /Cannot specify both/);

    const simUdid = "D9746857-E328-43FF-A79B-42CDE3AD9D71";
    const simDataDir = path.join(dir, "mock-sim-data");
    fs.mkdirSync(simDataDir, { recursive: true });
    fs.writeFileSync(path.join(simDataDir, "marker.txt"), "v1", "utf8");

    const parsedSim = parseSimctlListJson(
      {
        runtimes: [
          {
            identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
            name: "iOS 18.4",
            version: "18.4",
            isAvailable: true,
          },
        ],
        devicetypes: [
          {
            identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
            name: "iPhone 16 Pro",
            productFamily: "iPhone",
          },
        ],
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-18-4": [
            {
              udid: simUdid,
              name: "iPhone 16 Pro",
              state: "Booted",
              isAvailable: true,
              dataPath: simDataDir,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
            },
          ],
        },
      },
      { stateDir: dir, host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536 } },
    );
    assert.equal(parsedSim.running.length, 1);
    assert.equal(parsedSim.running[0].deviceKey, `sim:${simUdid}`);
    assert.equal(parsedSim.running[0].profile.osVersion, "iOS-18.4");
    assert.equal(parsedSim.running[0].profile.deviceType, "phone");

    const parsedDevCtl = parseDevicectlListJson({
      result: {
        devices: [
          {
            identifier: "CORE-UUID-1111",
            connectionProperties: { pairingState: "paired", tunnelState: "connected", transportType: "wired" },
            hardwareProperties: { udid: "00008130-0011223344556677", platform: "iOS", marketingName: "iPhone 15 Pro", reality: "physical" },
            deviceProperties: { name: "Seb's iPhone", osVersionNumber: "18.3.1" },
          },
          {
            identifier: "CORE-UUID-2222",
            properties: {
              connection: { pairingState: "paired", state: "disconnected", transportType: "wired" },
              hardware: { udid: "00008140-00AABBCCDDEEFF00", platform: "iOS", marketingName: "iPhone 16", reality: "physical", cpuType: { type: 16777228, subtype: 0 } },
              software: { osVersionNumber: { stringValue: "18.4" } },
              state: { name: "Seb's iPhone 16", visibilityClass: "default" },
            },
          },
          {
            identifier: simUdid,
            visibilityClass: "simulators",
            connectionProperties: { pairingState: "paired", tunnelState: "disconnected", transportType: "sameMachine" },
            hardwareProperties: { udid: simUdid, platform: "iOS", marketingName: "iPhone 16 Pro", reality: "simulated" },
            deviceProperties: { name: "iPhone 16 Pro", osVersionNumber: "18.4", provider: "com.apple.CoreSimulator.SimulatorCoreDevicePlugin" },
          },
        ],
      },
    });
    assert.equal(parsedDevCtl.length, 2);
    assert.equal(parsedDevCtl[0].deviceKey, "serial:00008130-0011223344556677");
    assert.equal(parsedDevCtl[0].profile.osVersion, "iOS-18.3.1");
    assert.equal(parsedDevCtl[1].deviceKey, "serial:00008140-00AABBCCDDEEFF00");
    assert.equal(parsedDevCtl[1].profile.osVersion, "iOS-18.4");
    assert.equal(parsedDevCtl[1].profile.deviceName, "Seb's iPhone 16");

    // Pre-flight tooling diagnostics
    assert.match(
      diagnosePlatformToolingError("ios", { deviceType: "phone" }, {}, { platform: "linux" }),
      /iOS targets require macOS/,
    );
    assert.match(
      diagnosePlatformToolingError(
        "ios",
        { deviceType: "watch" },
        {
          running: [],
          offline: [],
          availableRuntimesByFamily: { iOS: 1, watchOS: 0, tvOS: 0, visionOS: 0 },
          probes: { simctlListOk: true, simctlStatus: 0 },
        },
        { platform: "darwin" },
      ),
      /xcodebuild -downloadPlatform watchOS/,
    );

    // Claim warm iOS Simulator, save/load/delete APFS snapshot, typed-op env injection
    const iosInv = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      queriedPlatforms: ["ios"],
      running: parsedSim.running,
      offline: [],
      creatable: parsedSim.creatable,
      probes: { simctlListOk: true, devicectlListOk: true },
    };
    const iosClaim = cmdClaim(
      dir,
      { session: "sess-ios", ios: true, type: "phone", os: ">=18.0" },
      { inventory: iosInv },
    );
    assert.equal(iosClaim.exitCode, 0);
    assert.equal(iosClaim.lease.platform, "ios");
    assert.equal(iosClaim.lease.serial, simUdid);

    // Save APFS snapshot "clean_ios", mutate marker.txt, load snapshot, verify restored
    const snapSaveRes = cmdSnapshot(
      dir,
      "save",
      "clean_ios",
      { session: "sess-ios", force: true },
      {
        runner: (cmd, args) => {
          if (cmd === "cp") {
            fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(snapSaveRes.exitCode, 0, snapSaveRes.error);

    const snapListRes = cmdSnapshot(dir, "list", null, { session: "sess-ios" });
    assert.equal(snapListRes.exitCode, 0);
    assert.deepEqual(snapListRes.snapshots, ["clean_ios"]);

    fs.writeFileSync(path.join(simDataDir, "marker.txt"), "mutated", "utf8");
    const snapLoadRes = cmdSnapshot(
      dir,
      "load",
      "clean_ios",
      { session: "sess-ios" },
      {
        runner: (cmd, args) => {
          if (cmd === "cp") {
            fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(snapLoadRes.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(simDataDir, "marker.txt"), "utf8"), "v1");

    const snapDelRes = cmdSnapshot(dir, "delete", "clean_ios", { session: "sess-ios" });
    assert.equal(snapDelRes.exitCode, 0);

    // iOS typed-op child invocations keep argv untouched and inject SIMULATOR_UDID & ATC_PLATFORM=ios
    const iosChildInv = prepareOpChildInvocation(
      { cmd: "xcrun", args: ["simctl", "launch", simUdid, "com.example.App"] },
      { lease: iosClaim.lease, sessionId: "sess-ios", baseEnv: {} },
    );
    assert.deepEqual(iosChildInv.args, ["simctl", "launch", simUdid, "com.example.App"]);
    assert.equal(iosChildInv.env.ATC_PLATFORM, "ios");
    assert.equal(iosChildInv.env.SIMULATOR_UDID, simUdid);
    assert.equal(iosChildInv.env.ATC_DEVICE_SERIAL, simUdid);
    assert.equal(iosChildInv.env.ANDROID_SERIAL, undefined);

    const iosPhysicalInv = prepareOpChildInvocation(
      { cmd: "xcrun", args: ["devicectl", "device", "info", "details", "--device", "00008120-000464CE2E44C01E"] },
      {
        lease: { ...iosClaim.lease, kind: "physical", serial: "00008120-000464CE2E44C01E" },
        sessionId: "sess-ios",
        baseEnv: {},
      },
    );
    assert.equal(iosPhysicalInv.env.SIMULATOR_UDID, undefined);
    assert.equal(iosPhysicalInv.env.ATC_DEVICE_SERIAL, "00008120-000464CE2E44C01E");

    // 7. KMP dual-lease session (1 Android lease + 1 iOS lease in the same session)
    const kmpAndroidInv = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      queriedPlatforms: ["android"],
      running: [
        {
          deviceKey: "avd:Pixel_9",
          platform: "android",
          kind: "emulator",
          avd: "Pixel_9",
          serial: "emulator-5554",
          online: true,
          ramSizeMb: 2048,
          requiredRamMb: 3072,
          profile: {
            platform: "android",
            deviceType: "phone",
            apiLevel: "android-36",
            services: "play",
            playStore: true,
            abi: "arm64-v8a",
          },
        },
      ],
      offline: [],
      creatable: [],
      probes: { emulatorListOk: true, adbDevicesOk: true },
    };
    const kmpAndroidClaim = cmdClaim(
      dir,
      { android: true, type: "phone", session: "sess-ios" },
      { inventory: kmpAndroidInv },
    );
    assert.equal(kmpAndroidClaim.exitCode, 0);
    assert.equal(kmpAndroidClaim.lease.platform, "android");
    assert.equal(kmpAndroidClaim.lease.serial, "emulator-5554");

    // Platform-scoped renew in a dual-lease KMP session
    const kmpRenewUnscoped = cmdRenew(dir, null, { session: "sess-ios", ttl: 500 });
    assert.equal(kmpRenewUnscoped.exitCode, 1);
    assert.match(kmpRenewUnscoped.error, /--android\/--ios/);

    const kmpRenewIos = cmdRenew(dir, null, { session: "sess-ios", ios: true, ttl: 500 });
    assert.equal(kmpRenewIos.exitCode, 0);
    assert.equal(kmpRenewIos.lease.platform, "ios");

    const kmpRenewAndroid = cmdRenew(dir, null, { session: "sess-ios", android: true, ttl: 500 });
    assert.equal(kmpRenewAndroid.exitCode, 0);
    assert.equal(kmpRenewAndroid.lease.platform, "android");

    // Platform-scoped free in a dual-lease KMP session
    const kmpFreeAndroid = cmdFree(dir, null, { session: "sess-ios", android: true });
    assert.equal(kmpFreeAndroid.exitCode, 0);
    assert.deepEqual(kmpFreeAndroid.freed, [kmpAndroidClaim.lease.leaseId]);
    assert.ok(readState(dir).leases[iosClaim.lease.deviceKey]);

    // 8. E2E 2.1.0 hardening: allowPhysicalDevices=never returns exitCode 6 (EPHYSICAL_FORBIDDEN),
    //    systemImagePresent tie-breaking, and adb emu snapshot KO: error detection
    assert.equal(cmdConfig(dir, "set", "allowPhysicalDevices", "bogus").exitCode, 1);
    assert.equal(cmdConfig(dir, "set", "allowPhysicalDevices", "never").exitCode, 0);
    const physForbiddenInv = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      queriedPlatforms: ["android"],
      running: [
        {
          deviceKey: "serial:USB-PIXEL-99",
          platform: "android",
          kind: "physical",
          avd: null,
          serial: "USB-PIXEL-99",
          online: true,
          profile: {
            platform: "android",
            deviceType: "phone",
            apiLevel: "android-36",
            services: "play",
            playStore: true,
            abi: "arm64-v8a",
          },
        },
      ],
      offline: [],
      creatable: [],
      probes: { emulatorListOk: true, adbDevicesOk: true },
    };
    const forbiddenClaim = cmdClaim(
      dir,
      { android: true, serial: "USB-PIXEL-99", session: "sess-phys-never" },
      { inventory: physForbiddenInv },
    );
    assert.equal(forbiddenClaim.exitCode, 6);
    assert.match(forbiddenClaim.error, /allowPhysicalDevices=never/);
    assert.equal(cmdConfig(dir, "set", "allowPhysicalDevices", "explicit").exitCode, 0);

    // Offline AVD with systemImagePresent: true is preferred over stale AVD with systemImagePresent: false
    const sysImgState = {
      config: { maxRunningEmulators: 2, minFreeRamMb: 2048, minFreeDiskMb: 2048 },
      leases: {},
      queue: [],
    };
    const sysImgInv = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 12 },
      running: [],
      offline: [
        {
          deviceKey: "avd:Stale_Pixel",
          platform: "android",
          kind: "emulator",
          avd: "Stale_Pixel",
          online: false,
          systemImagePresent: false,
          ramSizeMb: 2048,
          requiredRamMb: 3072,
          profile: { deviceType: "phone", apiLevel: "android-36", services: "play", playStore: true },
        },
        {
          deviceKey: "avd:Ready_Opus",
          platform: "android",
          kind: "emulator",
          avd: "Ready_Opus",
          online: false,
          systemImagePresent: true,
          ramSizeMb: 2048,
          requiredRamMb: 3072,
          profile: { deviceType: "phone", apiLevel: "android-37", services: "play", playStore: true },
        },
      ],
      creatable: [],
      probes: { emulatorListOk: true, adbDevicesOk: true },
    };
    const sysImgSel = selectCandidateUnderLock(sysImgState, sysImgInv, {
      platform: "android",
      kind: "emulator",
      deviceType: "phone",
    });
    assert.equal(sysImgSel.candidate?.avd, "Ready_Opus");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("iOS create-if-missing passes the parsed device type and runtime to simctl", async () => {
  const { createIosSimulator, deleteIosSimulator, parseSimctlListJson } = await import("../src/ios.mjs");
  const dir = makeTempStateDir();
  const deviceTypeId = "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro";
  const runtimeId = "com.apple.CoreSimulator.SimRuntime.iOS-18-4";
  const createdUdid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  try {
    const parsed = parseSimctlListJson({
      runtimes: [
        {
          identifier: runtimeId,
          name: "iOS 18.4",
          version: "18.4",
          isAvailable: true,
          supportedDeviceTypes: [{ identifier: deviceTypeId, name: "iPhone 16 Pro", productFamily: "iPhone" }],
        },
      ],
      devicetypes: [{ identifier: deviceTypeId, name: "iPhone 16 Pro", productFamily: "iPhone" }],
      devices: {},
    });
    assert.equal(parsed.creatable[0].deviceTypeId, deviceTypeId);
    assert.equal(parsed.creatable[0].runtimeId, runtimeId);

    const createCalls = [];
    const claim = cmdClaim(
      dir,
      { session: "ios-create-sess", ios: true, type: "phone", os: "18.4", createIfMissing: true, wait: 0, force: true },
      {
        platform: "darwin",
        inventory: {
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 8 },
          queriedPlatforms: ["ios"],
          running: [],
          offline: [],
          creatable: parsed.creatable,
          probes: { simctlListOk: true },
        },
        runner: (cmd, args) => {
          createCalls.push([cmd, args]);
          if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "create") {
            return { status: 0, stdout: `${createdUdid}\n`, stderr: "" };
          }
          if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "bootstatus") {
            return { status: 0, stdout: "Booted", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(claim.exitCode, 0, claim.error);
    const create = createCalls.find((c) => c[0] === "xcrun" && c[1][1] === "create");
    assert.ok(create, "simctl create was not invoked");
    assert.equal(create[1][2], "iPhone 16 Pro");
    assert.equal(create[1][3], deviceTypeId);
    assert.equal(create[1][4], runtimeId);
    assert.equal(String(create[1]).includes("undefined"), false);
    assert.equal(claim.lease.serial, createdUdid);
    assert.equal(claim.lease.createdByAtc, true);

    const missingType = createIosSimulator("iPhone 16 Pro", undefined, runtimeId, {
      runner: () => ({ status: 0, stdout: `${createdUdid}\n`, stderr: "" }),
    });
    assert.fail(`createIosSimulator accepted a missing device type: ${missingType.udid}`);
  } catch (err) {
    if (!/missing device type/i.test(String(err.message))) throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const udid = "BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF";
  const calls = [];
  deleteIosSimulator(udid, {
    runner: (cmd, args) => {
      calls.push([cmd, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(calls[0], ["xcrun", ["simctl", "shutdown", udid]]);
  assert.deepEqual(calls[1], ["xcrun", ["simctl", "delete", udid]]);
});

test("ios.delete removes only the leased simulator and drops that lease", async () => {
  const dir = makeTempStateDir();
  const leased = "CCCCCCCC-DDDD-4EEE-8FFF-000000000001";
  const foreign = "DDDDDDDD-EEEE-4FFF-8000-000000000002";
  try {
    const claim = cmdClaim(
      dir,
      { session: "ios-del-sess", ios: true, udid: leased, wait: 0 },
      {
        platform: "darwin",
        inventory: {
          host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 8 },
          queriedPlatforms: ["ios"],
          running: [
            {
              deviceKey: `sim:${leased}`,
              platform: "ios",
              kind: "emulator",
              avd: "ATC Disposable",
              serial: leased,
              udid: leased,
              online: true,
              profile: { platform: "ios", deviceType: "phone", osVersion: "iOS-18.4", deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
            },
          ],
          offline: [],
          creatable: [],
          probes: { simctlListOk: true },
        },
      },
    );
    assert.equal(claim.exitCode, 0, claim.error);

    const refused = await cmdExec(dir, ["ios", "delete", foreign, "--session", "ios-del-sess"], {
      platform: "darwin",
      invocationRunner: () => {
        throw new Error("simctl must not run for a foreign UDID");
      },
    });
    assert.notEqual(refused.exitCode, 0);
    assert.match(String(refused.error || ""), /not the simulator leased by this session/);
    assert.equal(readState(dir).leases[`sim:${leased}`]?.leaseId, claim.lease.leaseId);

    const deleted = [];
    const removed = await cmdExec(dir, ["ios", "delete", leased, "--session", "ios-del-sess"], {
      platform: "darwin",
      invocationRunner: (cmd, args) => {
        deleted.push([cmd, [...args]]);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(removed.exitCode, 0, removed.error);
    assert.deepEqual(deleted, [["xcrun", ["simctl", "delete", leased]]]);
    const afterDelete = readState(dir);
    assert.equal(afterDelete.leases[`sim:${leased}`], undefined);
    assert.ok(afterDelete.fleetEpoch > 0, "deleting a simulator must advance fleetEpoch");
    assert.equal(afterDelete.stoppedDevices?.[`sim:${leased}`]?.serial, leased);
    assert.equal(afterDelete.bootedDevices?.[`sim:${leased}`], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot registry: existing label conflicts, budget refusal creates nothing, overrun exits 0", () => {
  const dir = makeTempStateDir();
  const registryDir = path.join(dir, "registry");
  fs.mkdirSync(registryDir, { recursive: true });
  try {
    const inventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 8 },
      running: [
        {
          deviceKey: "avd:Pixel_8",
          avd: "Pixel_8",
          serial: "emulator-5554",
          kind: "emulator",
          online: true,
          ramSizeMb: 2048,
          snapshots: [],
          profile: { deviceType: "phone", apiLevel: "android-35" },
        },
      ],
      offline: [],
      creatable: [],
    };
    const claim = cmdClaim(dir, { session: "snap-reg", avd: "Pixel_8" }, { inventory });
    assert.equal(claim.exitCode, 0, claim.error);
    const calls = [];
    const runner = (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "adb" && args.includes("getprop")) return { status: 0, stdout: "1\n", stderr: "" };
      if (cmd === "android") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "OK", stderr: "" };
    };
    const first = cmdSnapshot(
      dir,
      "save",
      "task",
      { session: "snap-reg" },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(first.exitCode, 0, first.error);
    assert.match(first.snapshotId, /^atc-[0-9a-f]{12}$/);
    assert.equal(calls.length, 1);
    assert.match(calls[0], new RegExp(`snapshot save ${first.snapshotId}$`));

    calls.length = 0;
    const conflict = cmdSnapshot(
      dir,
      "save",
      "task",
      { session: "snap-reg" },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(conflict.exitCode, 4, conflict.error);
    assert.equal(calls.length, 0, "a conflicting save must not call adb");
    assert.match(conflict.error, /already exists/);

    const tight = cmdConfig(dir, "set", "snapshotBudgetMb", "1");
    assert.equal(tight.exitCode, 0, tight.error);
    const refused = cmdSnapshot(
      dir,
      "save",
      "other",
      { session: "snap-reg" },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(refused.exitCode, 5, refused.error);
    assert.equal(calls.length, 0, "a pre-save budget miss must not create a snapshot");
    assert.match(refused.error, /No snapshot was created/);

    const replaced = cmdSnapshot(
      dir,
      "save",
      "task",
      { session: "snap-reg", replace: true },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(replaced.exitCode, 5, replaced.error);
    assert.match(replaced.error, /No snapshot was created/);
    assert.equal(calls.length, 0, "a known budget miss must not call adb, even with --replace");
    assert.match(
      replaced.warnings.find((warning) => warning.code === "over_budget").human,
      /we are over budget; ask the user what to do/,
    );

    const pinned = cmdSnapshot(
      dir,
      "save",
      "task",
      { session: "snap-reg", replace: true, keep: true },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(pinned.exitCode, 5, pinned.error);
    assert.equal(calls.length, 0, "a pinned replacement that still exceeds the cap must not call adb");

    cmdConfig(dir, "set", "snapshotBudgetMb", "16384");
    const other = cmdSnapshot(
      dir,
      "save",
      "other",
      { session: "snap-reg" },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(other.exitCode, 0, other.error);
    const loadedA = cmdSnapshot(
      dir,
      "load",
      "task",
      { session: "snap-reg" },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(loadedA.exitCode, 0, loadedA.error);
    const loadedB = cmdClaim(
      dir,
      { session: "snap-reg", avd: "Pixel_8", snapshotLoad: "other" },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(loadedB.exitCode, 0, loadedB.error);
    const registry = JSON.parse(fs.readFileSync(path.join(registryDir, "snapshots.json"), "utf8"));
    const task = registry.snapshots.find((row) => row.label === "task");
    const next = registry.snapshots.find((row) => row.label === "other");
    assert.equal(task.references.includes(claim.lease.leaseId), false);
    assert.equal(next.references.includes(claim.lease.leaseId), true);
    const callsBeforeFree = calls.length;
    const freed = cmdFree(
      dir,
      claim.lease.leaseId,
      { session: "snap-reg", stop: true },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(freed.exitCode, 0, freed.error);
    assert.equal(
      calls.slice(callsBeforeFree).some((call) => /snapshot (save|load)/.test(call)),
      false,
    );
    const afterFree = JSON.parse(fs.readFileSync(path.join(registryDir, "snapshots.json"), "utf8"));
    assert.equal(
      afterFree.snapshots.some((row) => (row.references || []).includes(claim.lease.leaseId)),
      false,
    );
    cmdFree(dir, claim.lease.leaseId, { session: "snap-reg" }, { inventory, snapshotRegistryDir: registryDir });
    const reclaim = cmdClaim(
      dir,
      { session: "snap-reg", avd: "Pixel_8", snapshotLoad: "other", wait: 0 },
      {
        inventory,
        runner,
        snapshotRegistryDir: registryDir,
      },
    );
    assert.equal(reclaim.exitCode, 0, reclaim.error);
    assert.equal(
      calls.some((call) => call.endsWith(`snapshot load ${other.snapshotId}`)),
      true,
    );
    cmdFree(dir, claim.lease.leaseId, { session: "snap-reg" }, { inventory, snapshotRegistryDir: registryDir });

    const staleLock = path.join(registryDir, "snapshots.lock");
    fs.mkdirSync(staleLock);
    fs.writeFileSync(
      path.join(staleLock, "owner.json"),
      JSON.stringify({ pid: 2_147_483_646, createdAtMs: 1 }),
    );
    const recovered = withSnapshotRegistry(registryDir, () => ({ mutated: false, value: "recovered" }));
    assert.equal(recovered, "recovered");
    assert.equal(fs.existsSync(staleLock), false);

    const abandonedId = withSnapshotRegistry(registryDir, (registry) => {
      const id = mintSnapshotId(registry);
      registry.snapshots.push({
        id,
        label: "abandoned",
        storeId: "Pixel_8",
        backendName: id,
        state: "pending",
        ownerPid: 2_147_483_646,
        bytes: 2048,
        references: [],
      });
      return { mutated: true, value: id };
    });
    const replacedAgain = cmdSnapshot(
      dir,
      "save",
      "task",
      { session: "snap-reg", replace: true },
      { inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 } },
    );
    assert.equal(replacedAgain.exitCode, 0, replacedAgain.error);
    cmdFree(dir, reclaim.lease.leaseId, { session: "snap-reg" }, { inventory, snapshotRegistryDir: registryDir });
    const callsBeforeReplaceClaim = calls.length;
    const replaceClaim = cmdClaim(
      dir,
      { session: "snap-reg", avd: "Pixel_8", snapshotLoad: "task" },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(replaceClaim.exitCode, 0, replaceClaim.error);
    assert.equal(
      calls.slice(callsBeforeReplaceClaim).some((call) => call.includes("snapshot load")),
      true,
    );
    const byId = cmdClaim(
      dir,
      { session: "snap-reg", avd: "Pixel_8", snapshotLoad: replacedAgain.snapshotId, wait: 0 },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(byId.exitCode, 0, byId.error);
    const callsBeforeSame = calls.length;
    const sameClaim = cmdClaim(
      dir,
      { session: "snap-reg", avd: "Pixel_8", snapshotLoad: "task" },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(sameClaim.exitCode, 0, sameClaim.error);
    assert.equal(calls.slice(callsBeforeSame).some((call) => call.includes("snapshot load")), false);
    const callsBeforeStale = calls.length;
    const staleLoad = cmdClaim(
      dir,
      { session: "snap-reg", avd: "Pixel_8", snapshotLoad: first.snapshotId, wait: 0 },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(staleLoad.exitCode, 1, staleLoad.error);
    assert.match(staleLoad.error, /does not return newer bytes/);
    assert.equal(
      calls.slice(callsBeforeStale).some((call) => call.includes("snapshot load")),
      false,
    );

    const held = cmdClaim(dir, { session: "snap-reg", avd: "Pixel_8" }, { inventory, snapshotRegistryDir: registryDir });
    assert.equal(held.exitCode, 0, held.error);
    const callsBeforeFreeSave = calls.length;
    const freeSave = cmdFree(
      dir,
      null,
      { session: "snap-reg", snapshotSave: "task" },
      { inventory, runner, snapshotRegistryDir: registryDir },
    );
    assert.equal(freeSave.exitCode, 4, freeSave.error);
    assert.equal(calls.length, callsBeforeFreeSave);
    const afterAbandon = withSnapshotRegistry(registryDir, (registry) => ({
      mutated: false,
      value: registry.snapshots.some((row) => row.id === abandonedId),
    }));
    assert.equal(afterAbandon, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live registry lock stays in place while another caller waits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-lock-"));
  const ready = path.join(dir, "ready");
  const release = path.join(dir, "release");
  const entered = path.join(dir, "entered");
  const child = `
    import fs from "node:fs";
    import { withSnapshotRegistry } from ${JSON.stringify(path.join(process.cwd(), "src/snapshot-registry.mjs"))};
    const [dir, role, ready, release, entered] = process.argv.slice(1);
    if (role === "holder") {
      withSnapshotRegistry(dir, () => {
        fs.writeFileSync(ready, "1");
        const start = Date.now();
        while (!fs.existsSync(release) && Date.now() - start < 3000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return { mutated: true, value: "held" };
      });
    } else {
      const start = Date.now();
      while (!fs.existsSync(ready) && Date.now() - start < 2000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const enteredAt = Date.now();
      withSnapshotRegistry(dir, () => {
        fs.writeFileSync(entered, String(Date.now() - enteredAt));
        return { mutated: false, value: "waited" };
      });
    }
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", child, dir, "holder", ready, release, entered], { stdio: "ignore" });
  const waiter = spawn(process.execPath, ["--input-type=module", "-e", child, dir, "waiter", ready, release, entered], { stdio: "ignore" });
  const start = Date.now();
  while (!fs.existsSync(ready) && Date.now() - start < 2000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  assert.equal(fs.existsSync(ready), true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
  assert.equal(fs.existsSync(entered), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshots.lock")), true);
  fs.writeFileSync(release, "1");
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(entered) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.equal(holder.exitCode === null || holder.exitCode === 0, true);
  assert.ok(Number(fs.readFileSync(entered, "utf8")) >= 70);
  holder.kill();
  waiter.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("iOS snapshot save warns on the snapshot volume", () => {
  const dir = makeTempStateDir();
  const registryDir = path.join(dir, "registry");
  const udid = "EEEEEEEE-FFFF-4000-8000-000000000003";
  const dataPath = path.join(dir, "sim-data");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(path.join(dataPath, "state"), "x");
  try {
    const inventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 8 },
      queriedPlatforms: ["ios"],
      running: [{
        deviceKey: `sim:${udid}`,
        platform: "ios",
        kind: "emulator",
        avd: "ATC Disposable",
        serial: udid,
        udid,
        online: true,
        dataPath,
        profile: { platform: "ios", deviceType: "phone", osVersion: "iOS-18.4" },
      }],
      offline: [],
      creatable: [],
      probes: { simctlListOk: true },
    };
    const claim = cmdClaim(dir, { session: "ios-snap", ios: true, udid, wait: 0 }, {
      platform: "darwin",
      inventory,
    });
    assert.equal(claim.exitCode, 0, claim.error);
    cmdConfig(dir, "set", "snapshotLowDiskPct", "100");
    const runner = (cmd, args) => {
      if (cmd === "cp") {
        fs.cpSync(args[1], args[2], { recursive: true });
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "OK\n", stderr: "" };
    };
    const saved = cmdSnapshot(dir, "save", "task", { session: "ios-snap", ios: true }, {
      platform: "darwin",
      inventory,
      runner,
      snapshotRegistryDir: registryDir,
      host: { freeDiskMb: 65536 },
    });
    assert.equal(saved.exitCode, 0, saved.error);
    assert.equal(
      (saved.warnings || []).some((warning) => warning.code === "low_disk" && warning.volume.endsWith("ios-snapshots")),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement warning uses bytes left after cleanup", () => {
  const dir = makeTempStateDir();
  const registryDir = path.join(dir, "registry");
  fs.mkdirSync(registryDir, { recursive: true });
  try {
    const inventory = {
      host: { totalRamMb: 32768, availableRamMb: 16384, freeDiskMb: 65536, cpuCores: 8 },
      running: [{
        deviceKey: "avd:Pixel_8",
        avd: "Pixel_8",
        serial: "emulator-5554",
        kind: "emulator",
        online: true,
        ramSizeMb: 2048,
        snapshots: [],
        profile: { deviceType: "phone", apiLevel: "android-35" },
      }],
      offline: [],
      creatable: [],
    };
    const claim = cmdClaim(dir, { session: "snap-reg", avd: "Pixel_8" }, { inventory });
    assert.equal(claim.exitCode, 0, claim.error);
    const runner = (cmd, args) => {
      if (cmd === "adb" && args.includes("snapshot") && args.includes("save")) {
        const id = args.at(-1);
        const snapDir = path.join(dir, "avds", "Pixel_8.avd", "snapshots", id);
        fs.mkdirSync(snapDir, { recursive: true });
        fs.writeFileSync(path.join(snapDir, "ram.bin"), Buffer.alloc(64));
      }
      if (cmd === "adb" && args.includes("getprop")) return { status: 0, stdout: "1\n", stderr: "" };
      return { status: 0, stdout: "OK\n", stderr: "" };
    };
    const avdPath = path.join(dir, "avds", "Pixel_8.avd");
    fs.mkdirSync(avdPath, { recursive: true });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    const lease = Object.values(state.leases)[0];
    lease.avdPath = avdPath;
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
    const first = cmdSnapshot(dir, "save", "task", { session: "snap-reg" }, {
      inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 },
    });
    assert.equal(first.exitCode, 0, first.error);
    withSnapshotRegistry(registryDir, (registry) => {
      const row = registry.snapshots.find((item) => item.id === first.snapshotId);
      row.bytes = 2048;
      return { mutated: true, value: true };
    });
    cmdConfig(dir, "set", "snapshotBudgetMb", "2048");
    const replaced = cmdSnapshot(dir, "save", "task", { session: "snap-reg", replace: true }, {
      inventory, runner, snapshotRegistryDir: registryDir, host: { freeDiskMb: 65536 },
    });
    assert.equal(replaced.exitCode, 0, replaced.error);
    assert.equal((replaced.warnings || []).some((warning) => warning.code === "over_budget"), false);
    const after = JSON.parse(fs.readFileSync(path.join(registryDir, "snapshots.json"), "utf8"));
    const old = after.snapshots.find((row) => row.id === first.snapshotId);
    assert.equal(old.bytesDeleted, true);
    assert.equal((after.notices || []).some((notice) => notice.code === "over_budget"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("typed snapshot save accepts replace and keep", async () => {
  const dir = makeTempStateDir();
  try {
    const seen = [];
    const deps = execDeps(dir, {});
    deps.cmdSnapshot = (_stateDir, action, name, flags) => {
      seen.push({ action, name, flags });
      return { exitCode: 0, snapshot: name, snapshotId: "atc-abcdefabcdef" };
    };
    const saved = await cmdExecTokens(dir, ["snapshot", "save", "task", "--replace", "--keep", "--session", "typed-snap"], deps);
    assert.equal(saved.exitCode, 0, saved.error);
    assert.equal(seen[0].action, "save");
    assert.equal(seen[0].name, "task");
    assert.equal(seen[0].flags.replace, true);
    assert.equal(seen[0].flags.keep, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("typed snapshot command prints an over-budget warning", () => {
  const warning = { code: "over_budget", human: "we are over budget; ask the user what to do" };
  for (const json of [false, true]) {
    const err = [];
    const out = [];
    renderExecResult(
      { op: "snapshot.save", exitCode: 0, snapshot: "atc-abc", warnings: [warning] },
      { json, write: (line) => out.push(line), writeErr: (line) => err.push(line) },
    );
    assert.match(err.join(""), /we are over budget/);
    if (json) assert.match(out.join(""), /"code": "over_budget"/);
    else assert.match(out.join(""), /snapshot.save/);
  }
});
