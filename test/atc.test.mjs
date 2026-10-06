import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireLock,
  releaseLock,
  verifyLockOwnership,
  withLock,
  writeFileAtomic,
} from "../src/lock.mjs";
import {
  createDefaultState,
  readState,
  commitState,
  runGarbageCollection,
  reconcileOfflineLeases,
  matchesProfile,
  matchesApiSpec,
  computeEffectiveMaxEmulators,
  computeUsedEmulatorSlots,
  canJumpAhead,
  isTicketStarvationProtected,
  resolveSessionIdentity,
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
} from "../src/android.mjs";
import { handleMcpRequest } from "../src/mcp.mjs";
import {
  classifySegment,
  evaluateCommandGuard,
  splitShellSegments,
} from "../src/guard.mjs";
import { handlePreToolUseHook, handleStopHook } from "../src/hook.mjs";
import { buildChildInvocation } from "../src/spawn.mjs";
import {
  cmdClaim,
  cmdFree,
  cmdRenew,
  cmdSnapshot,
  cmdExec,
  cmdStatus,
  cmdConfig,
  cmdGuard,
} from "../src/cli.mjs";

function makeTempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atc-test-"));
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

test("guard: fast-path, compound splitting, precedence rules, and serial validation", () => {
  // Fast-path non-Android command
  const fast = evaluateCommandGuard("git status && npm test");
  assert.equal(fast.allowed, true);
  assert.equal(fast.fastPath, true);

  // Compound shell split
  const segments = splitShellSegments("echo hello && adb -s emulator-5554 shell wm size");
  assert.equal(segments.length, 2);

  // Precedence: deny_lifecycle beats read_only in compound command
  const lifecycle = evaluateCommandGuard("adb devices && emulator -avd Pixel_8_API_35");
  assert.equal(lifecycle.allowed, false);
  assert.match(lifecycle.reason, /Direct emulator launch is disabled/);

  // Read-only commands allowed without lease
  const ro = evaluateCommandGuard("adb devices -l");
  assert.equal(ro.allowed, true);

  // Device action without lease -> denied
  const deniedNoLease = evaluateCommandGuard("./gradlew connectedDebugAndroidTest", {
    sessionId: "sess-1",
    activeLeases: [],
  });
  assert.equal(deniedNoLease.allowed, false);
  assert.match(deniedNoLease.reason, /holds no active device lease/);

  // Device action with active lease -> allowed & renews lease
  const allowedWithLease = evaluateCommandGuard("./gradlew connectedDebugAndroidTest", {
    sessionId: "sess-1",
    activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
    runningCount: 1,
  });
  assert.equal(allowedWithLease.allowed, true);
  assert.equal(allowedWithLease.renewLease, true);

  // Device action targeting another agent's serial -> denied
  const wrongSerial = evaluateCommandGuard("adb -s emulator-5556 shell input keyevent 82", {
    sessionId: "sess-1",
    activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
    runningCount: 2,
  });
  assert.equal(wrongSerial.allowed, false);
  assert.match(wrongSerial.reason, /emulator-5556/);

  // Wrapped Android commands (`sudo`, `bash -c`, custom wrappers) fail closed without a lease
  const sudoWrap = evaluateCommandGuard("sudo adb shell pm list packages", {
    sessionId: "sess-1",
    activeLeases: [],
  });
  assert.equal(sudoWrap.allowed, false);

  const bashWrap = evaluateCommandGuard("bash -c 'adb shell pm list packages'", {
    sessionId: "sess-1",
    activeLeases: [],
  });
  assert.equal(bashWrap.allowed, false);

  const bashLifecycle = evaluateCommandGuard("bash -c 'emulator -avd Pixel_8_API_35'", {
    sessionId: "sess-1",
    activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
  });
  assert.equal(bashLifecycle.allowed, false);
  assert.match(bashLifecycle.reason, /Direct emulator launch is disabled/);

  // adb kill-server is denied as a host-wide lifecycle command
  const killServer = evaluateCommandGuard("adb kill-server", {
    sessionId: "sess-1",
    activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
  });
  assert.equal(killServer.allowed, false);
  assert.match(killServer.reason, /adb kill-server/);

  // Compound ATC commands export ATC_SESSION_ID across all segments
  const compoundAtc = evaluateCommandGuard(
    "atc claim --type phone && atc exec -- ./gradlew connectedCheck",
    {
      sessionId: "sess-compound",
      anchorPid: 12345,
      activeLeases: [],
    }
  );
  assert.equal(compoundAtc.allowed, true);
  assert.match(
    compoundAtc.rewrittenCommand,
    /^export ATC_SESSION_ID=sess-compound ATC_ANCHOR_PID=12345; /
  );
});

test("hook: PreToolUse and Stop hooks handle Antigravity and Claude/Codex formats", () => {
  const dir = makeTempStateDir();
  try {
    // 1. PreToolUse denies unleased adb shell in Antigravity format
    const preDeny = handlePreToolUseHook(
      dir,
      JSON.stringify({
        conversationId: "conv-123",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "adb shell pm list packages" },
        },
      }),
      { ppid: process.pid }
    );
    assert.equal(preDeny.exitCode, 2);
    assert.equal(JSON.parse(preDeny.stdout).decision, "block");

    // 2. PreToolUse rewrites `atc claim` to inject ATC_SESSION_ID in Claude/Codex format
    const preRewrite = handlePreToolUseHook(
      dir,
      JSON.stringify({
        session_id: "claude-sess-1",
        tool_name: "Bash",
        tool_input: { command: "atc claim --type phone" },
      }),
      { ppid: process.pid }
    );
    assert.equal(preRewrite.exitCode, 0);
    const rewriteOut = JSON.parse(preRewrite.stdout);
    assert.match(
      rewriteOut.hookSpecificOutput.updatedInput.command,
      /ATC_SESSION_ID=claude-sess-1/
    );

    // 3. Multi-device ambiguity is enforced when two sessions hold leases
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
    assert.equal(unscopedPre.exitCode, 2);
    assert.match(unscopedPre.stderr, /multiple devices are connected or leased/);

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

test("spawn: buildChildInvocation injects ANDROID_SERIAL and --device for android CLI", () => {
  const inv = buildChildInvocation(
    "android",
    ["run", "com.example.app"],
    { serial: "emulator-5554", leaseId: "lease-123" },
    "sess-1",
    {}
  );
  assert.equal(inv.env.ANDROID_SERIAL, "emulator-5554");
  assert.equal(inv.env.ATC_LEASE_ID, "lease-123");
  assert.equal(inv.env.ATC_SESSION_ID, "sess-1");
  assert.deepEqual(inv.args, ["run", "--device=emulator-5554", "com.example.app"]);
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

    // 4. Exec a child process with ANDROID_SERIAL injected
    const execRes = await cmdExec(
      dir,
      [
        process.execPath,
        "-e",
        "if (process.env.ANDROID_SERIAL !== 'emulator-5554') process.exit(42);",
      ],
      { session: "sess-test" }
    );
    assert.equal(execRes.exitCode, 0);

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

    // 3. Failing post-release action on cmdFree propagates exitCode 1
    const freeFail = cmdFree(
      dir,
      claimOk.lease.leaseId,
      { session: "sess-1", stop: true },
      { runner: () => ({ status: 1, stdout: "", stderr: "stop failed" }) }
    );
    assert.equal(freeFail.exitCode, 1);
    assert.match(freeFail.error, /Failed to stop emulator/);
    assert.deepEqual(freeFail.freed, []);

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

    // 6. Standalone cmdGuard probes live devices via adb devices and blocks unscoped commands when >1 device is online
    cmdClaim(dir, { session: "sess-1", api: "35" }, { inventory: mockInventory });
    const guardMulti = cmdGuard(
      dir,
      "adb shell wm size",
      { session: "sess-1" },
      {
        runner: () => ({
          status: 0,
          stdout:
            "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n",
          stderr: "",
        }),
      }
    );
    assert.equal(guardMulti.exitCode, 2);
    assert.equal(guardMulti.allowed, false);

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

test("cli: offline wipeData/snapshotLoad and createIfMissing use supported android CLI flags", () => {
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

    // Backtick and process substitutions are inspected by guard
    const backtickGuard = evaluateCommandGuard("echo `adb shell pm clear com.example`", {
      sessionId: "sess-unleased",
      activeLeases: [],
    });
    assert.equal(backtickGuard.allowed, false);

    const procSubGuard = evaluateCommandGuard("cat <(adb shell pm clear com.example)", {
      sessionId: "sess-unleased",
      activeLeases: [],
    });
    assert.equal(procSubGuard.allowed, false);

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

    // Standalone cmdGuard renews lease on allowed device_action
    const shortExpiry = Date.now() + 10_000;
    withStateTransaction(dir, (state) => {
      state.leases["avd:Medium_Phone_API_36"].expiresAtMs = shortExpiry;
      return { mutated: true };
    });
    const guardRenew = cmdGuard(
      dir,
      "adb -s emulator-5556 shell wm size",
      { session: "sess-create" },
      { runningCount: 1 }
    );
    assert.equal(guardRenew.exitCode, 0);
    assert.ok(readState(dir).leases["avd:Medium_Phone_API_36"].expiresAtMs > shortExpiry + 100_000);

    // Names-only --list-profiles output does not fabricate API/services/ABI
    const namesOnly = parseCreatableProfilesOutput("medium_phone\nmedium_tablet\n");
    assert.equal(namesOnly.length, 2);
    assert.equal(namesOnly[0].profile.deviceType, "phone");
    assert.equal(namesOnly[0].profile.apiLevel, null);
    assert.equal(namesOnly[0].profile.services, null);
    assert.equal(namesOnly[0].profile.playStore, null);
    assert.equal(namesOnly[0].profile.abi, null);

    // Multi-lease session: targetless cmdRenew is rejected as ambiguous, and PreToolUse hook renews only targeted serial
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

    const hookTargeted = handlePreToolUseHook(
      dir,
      JSON.stringify({
        session_id: "sess-create",
        tool_name: "Bash",
        tool_input: { command: "adb -s emulator-5554 shell wm size" },
      }),
      { ppid: process.pid, runningCount: 2 }
    );
    assert.equal(hookTargeted.exitCode, 0);
    const afterHookState = readState(dir);
    assert.ok(afterHookState.leases["avd:Pixel_8_API_35"].expiresAtMs > shortExpiry + 100_000);
    assert.equal(afterHookState.leases["avd:Medium_Phone_API_36"].expiresAtMs, shortExpiry);

    // sudo -n does not consume the wrapped command
    const sudoNonInteractive = evaluateCommandGuard("sudo -n adb kill-server", {
      sessionId: "sess-create",
      activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
    });
    assert.equal(sudoNonInteractive.allowed, false);
    assert.match(sudoNonInteractive.reason, /adb kill-server/);

    // Explicit --session without ATC_ANCHOR_PID leaves anchorPid null so ephemeral shell exit does not GC lease
    const explicitId = resolveSessionIdentity({
      flags: { session: "explicit-builder" },
      env: {},
      state: { hookSessions: {} },
      ppid: 99999999,
    });
    assert.equal(explicitId.sessionId, "explicit-builder");
    assert.equal(explicitId.anchorPid, null);

    // find -exec and variable-expanded commands are inspected by guard
    const findExecGuard = evaluateCommandGuard("find . -exec adb shell pm clear com.example \\;", {
      sessionId: "sess-unleased",
      activeLeases: [],
    });
    assert.equal(findExecGuard.allowed, false);

    const varExpandedGuard = evaluateCommandGuard('tool=adb; "$tool" shell pm clear com.example', {
      sessionId: "sess-unleased",
      activeLeases: [],
    });
    assert.equal(varExpandedGuard.allowed, false);

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

    // Pipelines feeding commands into shell interpreters or xargs are inspected by guard
    const pipeShGuard = evaluateCommandGuard("echo 'adb shell pm clear com.example' | sh", {
      sessionId: "sess-unleased",
      activeLeases: [],
    });
    assert.equal(pipeShGuard.allowed, false);

    const pipeBashLifecycle = evaluateCommandGuard(
      "printf '%s\\n' 'emulator -avd Pixel_8_API_35' | bash",
      {
        sessionId: "sess-create",
        activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
      }
    );
    assert.equal(pipeBashLifecycle.allowed, false);
    assert.match(pipeBashLifecycle.reason, /Direct emulator launch is disabled/);

    // cmdGuard with --session and ATC_ANCHOR_PID retains anchorPid in rewritten command
    const piGuard = cmdGuard(
      dir,
      "atc claim --type phone",
      { session: "pi-1234" },
      { env: { ATC_ANCHOR_PID: "4242" } }
    );
    assert.equal(piGuard.allowed, true);
    assert.match(piGuard.rewrittenCommand, /ATC_SESSION_ID=pi-1234 ATC_ANCHOR_PID=4242/);

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
      assert.deepEqual(winFreeCalls, ["adb -s emulator-5554 emu kill"]);

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
          claimedAtMs: now - 20_000,
          renewedAtMs: now - 20_000,
          expiresAtMs: now + 60_000,
          firstSeenOfflineAtMs: now - 10_000,
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

      // buildChildInvocation and evaluateCommandGuard reject conflicting explicit device selectors in atc exec
      assert.throws(
        () =>
          buildChildInvocation(
            "adb",
            ["-s", "emulator-5556", "shell", "wm", "size"],
            { serial: "emulator-5554", leaseId: "lease-1" },
            "sess-1"
          ),
        /Conflicting device selector/
      );
      const execWrongSerialGuard = evaluateCommandGuard(
        "atc exec -- adb -s emulator-5556 shell wm size",
        {
          sessionId: "sess-1",
          activeLeases: [{ leaseId: "lease-1", serial: "emulator-5554" }],
        }
      );
      assert.equal(execWrongSerialGuard.allowed, false);

      // cmdConfig rejects bootTimeoutSec / stopTimeoutSec below minimum threshold
      const shortBootCfg = cmdConfig(winDir, "set", "bootTimeoutSec", "2");
      assert.equal(shortBootCfg.exitCode, 1);
      assert.match(shortBootCfg.error, /at least 5 seconds/);
    } finally {
      fs.rmSync(winDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(avdHome, { recursive: true, force: true });
  }
});

