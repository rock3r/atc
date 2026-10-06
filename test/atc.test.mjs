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
  checkResourceAdmission,
  deterministicCreatedAvdId,
} from "../src/android.mjs";
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
      { runner: () => ({ status: 0, stdout: "OK", stderr: "" }) }
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

    // 7. Idempotent re-claim with --reset-app executes pm clear
    const resetCalls = [];
    const idemReset = cmdClaim(
      dir,
      { session: "sess-1", api: "35", resetApp: "com.example.app" },
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
    assert.ok(
      resetCalls.includes("adb -s emulator-5554 shell pm clear com.example.app")
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

