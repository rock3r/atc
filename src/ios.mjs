import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHostResources } from "./android.mjs";
import { runCommandSync } from "./spawn.mjs";
import { DEFAULT_CONFIG } from "./state.mjs";

export const IOS_UDID_REGEX =
  /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;

export function isIosUdid(val) {
  if (!val || typeof val !== "string") return false;
  return IOS_UDID_REGEX.test(val.trim());
}

export function inferIosDeviceType(name = "", productFamily = "", runtimeId = "") {
  const combined = `${name} ${productFamily} ${runtimeId}`.toLowerCase();
  if (combined.includes("watch")) return "watch";
  if (combined.includes("tv")) return "tv";
  if (combined.includes("vision") || combined.includes("reality") || combined.includes("xr")) {
    return "xr";
  }
  if (combined.includes("ipad") || combined.includes("tablet")) return "tablet";
  return "phone";
}

export function formatIosRuntimeVersion(runtimeObj = {}, runtimeId = "") {
  const rawName = String(runtimeObj?.name || "").trim();
  if (rawName) {
    const m = rawName.match(/^(iOS|watchOS|tvOS|visionOS|xrOS)\s+(\d+(?:\.\d+)*)/i);
    if (m) {
      const fam = m[1].toLowerCase() === "xros" ? "visionOS" : m[1];
      return `${fam}-${m[2]}`;
    }
  }
  const idStr = String(runtimeObj?.identifier || runtimeId || "");
  const idMatch = idStr.match(/SimRuntime\.(iOS|watchOS|tvOS|visionOS|xrOS)-(\d+(?:-\d+)*)/i);
  if (idMatch) {
    const fam = idMatch[1].toLowerCase() === "xros" ? "visionOS" : idMatch[1];
    const ver = idMatch[2].replace(/-/g, ".");
    return `${fam}-${ver}`;
  }
  if (runtimeObj?.version) {
    return `iOS-${runtimeObj.version}`;
  }
  return "unknown";
}

function hasProjectMarkersInDir(dirPath) {
  if (!dirPath) return { hasIos: false, hasAndroid: false };
  let cur = path.resolve(dirPath);
  let hasIos = false;
  let hasAndroid = false;
  for (let depth = 0; depth < 3; depth++) {
    try {
      const entries = fs.readdirSync(cur);
      for (const entry of entries) {
        if (
          entry.endsWith(".xcodeproj") ||
          entry.endsWith(".xcworkspace") ||
          entry === "Package.swift" ||
          entry === "Podfile"
        ) {
          hasIos = true;
        }
        if (
          entry === "build.gradle" ||
          entry === "build.gradle.kts" ||
          entry === "settings.gradle" ||
          entry === "settings.gradle.kts" ||
          entry === "AndroidManifest.xml" ||
          entry === "gradlew"
        ) {
          hasAndroid = true;
        }
      }
    } catch {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { hasIos, hasAndroid };
}

export function resolveTargetPlatform(flags = {}, cwdOrOptions = {}) {
  const options =
    typeof cwdOrOptions === "string"
      ? { cwd: cwdOrOptions, inferFromCwd: true }
      : { inferFromCwd: true, ...(cwdOrOptions || {}) };

  const hasIosFlag = Boolean(flags.ios && flags.ios !== "false" && flags.ios !== "0");
  const hasAndroidFlag = Boolean(
    flags.android && flags.android !== "false" && flags.android !== "0",
  );

  if (hasIosFlag && hasAndroidFlag) {
    throw new Error('Cannot specify both "--ios" and "--android" simultaneously.');
  }
  if (hasIosFlag) {
    if (
      flags.platform &&
      String(flags.platform).trim().toLowerCase() !== "ios" &&
      String(flags.platform).trim().toLowerCase() !== "all"
    ) {
      throw new Error(
        `Conflicting platform flags "--ios" and "--platform ${flags.platform}".`,
      );
    }
    return "ios";
  }
  if (hasAndroidFlag) {
    if (
      flags.platform &&
      String(flags.platform).trim().toLowerCase() !== "android" &&
      String(flags.platform).trim().toLowerCase() !== "all"
    ) {
      throw new Error(
        `Conflicting platform flags "--android" and "--platform ${flags.platform}".`,
      );
    }
    return "android";
  }
  if (flags.platform !== undefined && flags.platform !== null && flags.platform !== false) {
    if (typeof flags.platform !== "string" || !flags.platform.trim()) {
      throw new Error('Option "--platform" requires a value ("android" or "ios").');
    }
    const norm = flags.platform.trim().toLowerCase();
    if (norm === "android" || norm === "ios" || norm === "all" || norm === "any") {
      return norm === "any" ? "all" : norm;
    }
    throw new Error(
      `Invalid --platform "${flags.platform}". Expected "android" or "ios".`,
    );
  }

  // Target-specific inference
  if (flags.udid || flags.os !== undefined) {
    return "ios";
  }
  if (
    flags.api !== undefined &&
    flags.api !== null &&
    /^(iOS|watchOS|tvOS|visionOS|xrOS)/i.test(String(flags.api).trim())
  ) {
    return "ios";
  }
  if (flags.services || flags.play !== undefined || flags.abi) {
    return "android";
  }
  if (flags.avd && typeof flags.avd === "string") {
    const avdTrim = flags.avd.trim();
    if (
      isIosUdid(avdTrim) ||
      /^(iPhone|iPad|Apple\s+Watch|Apple\s+TV|Apple\s+Vision)/i.test(avdTrim)
    ) {
      return "ios";
    }
    return "android";
  }
  if (flags.api !== undefined) {
    return "android";
  }
  if (flags.type && typeof flags.type === "string") {
    const lowType = flags.type.trim().toLowerCase();
    if (lowType === "iphone" || lowType === "ipad") {
      return "ios";
    }
  }
  if (flags.serial && typeof flags.serial === "string" && isIosUdid(flags.serial)) {
    return "ios";
  }

  // Project directory inference when running on macOS without explicit platform flags
  const hostPlatform = options.platform || process.platform;
  if (options.inferFromCwd && hostPlatform === "darwin") {
    const cwd = options.cwd || process.cwd();
    const { hasIos, hasAndroid } = hasProjectMarkersInDir(cwd);
    if (hasIos && !hasAndroid) {
      return "ios";
    }
  }

  return options.defaultPlatform || "android";
}

export function runIosCommandSync(runner = runCommandSync, cmd, args = [], options = {}) {
  const res = runner(cmd, args, options);
  if (res.status === 0) {
    return res;
  }
  const combined = `${res.stderr || ""} ${res.stdout || ""}`;
  const isMissingActiveDeveloperDir =
    /unable to find utility|not a developer tool or in PATH|active developer path.*does not exist/i.test(
      combined,
    );
  const defaultXcodeDevDir = "/Applications/Xcode.app/Contents/Developer";
  const currentEnv = options.env || process.env;
  if (
    isMissingActiveDeveloperDir &&
    !currentEnv?.DEVELOPER_DIR &&
    fs.existsSync(defaultXcodeDevDir)
  ) {
    return runner(cmd, args, {
      ...options,
      env: {
        ...currentEnv,
        DEVELOPER_DIR: defaultXcodeDevDir,
      },
    });
  }
  return res;
}

export function resolveSimulatorDataDir(udid, dataPathFromSimctl = null) {
  if (dataPathFromSimctl && typeof dataPathFromSimctl === "string") {
    return dataPathFromSimctl;
  }
  return path.join(
    os.homedir(),
    "Library",
    "Developer",
    "CoreSimulator",
    "Devices",
    String(udid),
    "data",
  );
}

export function listIosSimulatorSnapshots(stateDir, udid) {
  if (!stateDir || !udid) return [];
  const snapRoot = path.join(stateDir, "ios-snapshots", String(udid));
  if (!fs.existsSync(snapRoot)) return [];
  try {
    const names = [];
    for (const entry of fs.readdirSync(snapRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dataDir = path.join(snapRoot, entry.name, "data");
      if (fs.existsSync(dataDir)) {
        names.push(entry.name);
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

export function parseSimctlListJson(
  rawJson,
  { stateDir = null, cfg = DEFAULT_CONFIG, host = null } = {},
) {
  const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  const runtimesList = Array.isArray(parsed?.runtimes) ? parsed.runtimes : [];
  const deviceTypesList = Array.isArray(parsed?.devicetypes) ? parsed.devicetypes : [];
  const devicesByRuntime =
    parsed?.devices && typeof parsed.devices === "object" ? parsed.devices : {};

  const runtimeById = new Map();
  for (const rt of runtimesList) {
    if (rt && rt.identifier) {
      runtimeById.set(rt.identifier, rt);
    }
  }
  const deviceTypeById = new Map();
  for (const dt of deviceTypesList) {
    if (dt && dt.identifier) {
      deviceTypeById.set(dt.identifier, dt);
    }
  }

  const overheadMb = cfg?.simOverheadRamMb ?? 1280;
  const hostAbi = process.arch === "arm64" ? "arm64" : "x86_64";
  const running = [];
  const offline = [];
  const onlineSerials = [];

  for (const [runtimeId, devArray] of Object.entries(devicesByRuntime)) {
    if (!Array.isArray(devArray)) continue;
    const rtObj = runtimeById.get(runtimeId) || { identifier: runtimeId };
    const osVersion = formatIosRuntimeVersion(rtObj, runtimeId);
    for (const dev of devArray) {
      if (!dev || !dev.udid) continue;
      if (dev.isAvailable === false) continue;
      const dtObj = dev.deviceTypeIdentifier
        ? deviceTypeById.get(dev.deviceTypeIdentifier)
        : null;
      const deviceType = inferIosDeviceType(dev.name, dtObj?.productFamily, runtimeId);
      const isOnline = String(dev.state || "").toLowerCase() === "booted";
      const udid = String(dev.udid);
      const dataPath = resolveSimulatorDataDir(udid, dev.dataPath);
      const snapshots = stateDir ? listIosSimulatorSnapshots(stateDir, udid) : [];
      const record = {
        deviceKey: `sim:${udid}`,
        platform: "ios",
        kind: "emulator",
        avd: dev.name || udid,
        serial: udid,
        udid,
        online: isOnline,
        dataPath,
        ramSizeMb: 0,
        requiredRamMb: overheadMb,
        dataDiskMb: 1536,
        freeDiskMb: host?.freeDiskMb,
        fsDev: host?.fsDev ?? null,
        snapshots,
        profile: {
          platform: "ios",
          deviceType,
          deviceName: dev.name || udid,
          osVersion,
          apiLevel: osVersion,
          runtimeId,
          deviceTypeId: dev.deviceTypeIdentifier || dtObj?.identifier || null,
          services: "apple",
          playStore: false,
          abi: hostAbi,
        },
      };
      if (isOnline) {
        running.push(record);
        onlineSerials.push(udid);
      } else {
        offline.push(record);
      }
    }
  }

  const creatable = [];
  const availableRuntimesByFamily = {
    iOS: 0,
    watchOS: 0,
    tvOS: 0,
    visionOS: 0,
  };

  for (const rt of runtimesList) {
    if (!rt || rt.isAvailable === false || !rt.identifier) continue;
    const osVersion = formatIosRuntimeVersion(rt, rt.identifier);
    if (/^watchOS-/i.test(osVersion)) availableRuntimesByFamily.watchOS++;
    else if (/^tvOS-/i.test(osVersion)) availableRuntimesByFamily.tvOS++;
    else if (/^visionOS-/i.test(osVersion)) availableRuntimesByFamily.visionOS++;
    else if (/^iOS-/i.test(osVersion)) availableRuntimesByFamily.iOS++;

    const supportedTypes =
      Array.isArray(rt.supportedDeviceTypes) && rt.supportedDeviceTypes.length > 0
        ? rt.supportedDeviceTypes
        : deviceTypesList.filter((dt) => {
            const fam = String(dt?.productFamily || dt?.name || "").toLowerCase();
            if (/^watchos-/i.test(osVersion)) return fam.includes("watch");
            if (/^tvos-/i.test(osVersion)) return fam.includes("tv");
            if (/^visionos-/i.test(osVersion)) {
              return fam.includes("vision") || fam.includes("reality");
            }
            return fam.includes("iphone") || fam.includes("ipad");
          });

    for (const dt of supportedTypes) {
      if (!dt || !dt.identifier) continue;
      const deviceType = inferIosDeviceType(dt.name, dt.productFamily, rt.identifier);
      creatable.push({
        platform: "ios",
        kind: "emulator",
        avd: dt.name || dt.identifier,
        deviceName: dt.name || dt.identifier,
        runtimeId: rt.identifier,
        deviceTypeId: dt.identifier,
        profile: {
          platform: "ios",
          deviceType,
          deviceName: dt.name || dt.identifier,
          osVersion,
          apiLevel: osVersion,
          runtimeId: rt.identifier,
          deviceTypeId: dt.identifier,
          services: "apple",
          playStore: false,
          abi: hostAbi,
        },
      });
    }
  }

  return {
    running,
    offline,
    creatable,
    onlineSerials,
    availableRuntimesByFamily,
  };
}

export function parseDevicectlListJson(rawJson) {
  const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  const devices = Array.isArray(parsed?.result?.devices) ? parsed.result.devices : [];
  const physicalDevices = [];
  for (const dev of devices) {
    if (!dev || typeof dev !== "object") continue;
    const conn = dev.connectionProperties || dev.properties?.connection || {};
    const hw = dev.hardwareProperties || dev.properties?.hardware || {};
    const props = dev.deviceProperties || dev.properties?.state || {};
    const sw = dev.properties?.software || {};
    const reality = String(hw.reality || dev.properties?.hardware?.reality || "").toLowerCase();
    const visibility = String(
      dev.visibilityClass || dev.properties?.state?.visibilityClass || "",
    ).toLowerCase();
    const provider = String(
      dev.deviceProperties?.provider || dev.properties?.state?.provider || "",
    ).toLowerCase();
    const transportType = conn.transportType || dev.properties?.connection?.transportType || null;
    if (
      reality === "simulated" ||
      visibility === "simulators" ||
      provider.includes("coresimulator") ||
      String(transportType || "").toLowerCase() === "samemachine"
    ) {
      continue;
    }
    const pairingState = String(
      conn.pairingState || dev.properties?.connection?.pairingState || "paired",
    ).toLowerCase();
    const tunnelState = String(
      conn.tunnelState || dev.properties?.connection?.state || "",
    ).toLowerCase();
    if (pairingState !== "paired") continue;
    if (tunnelState === "unavailable") continue;
    if (tunnelState === "disconnected" && !transportType) continue;
    if (
      (conn.pairingState !== undefined || dev.properties?.connection?.pairingState !== undefined) &&
      tunnelState !== "connected" &&
      tunnelState !== "available" &&
      !transportType
    ) {
      continue;
    }
    const udid = hw.udid || dev.properties?.hardware?.udid || dev.identifier;
    if (!udid) continue;
    const coreDeviceId = dev.identifier || udid;
    const rawPlatform = String(
      hw.platform || dev.properties?.hardware?.platform || props.platform || "iOS",
    );
    const swVerObj = sw.osVersionNumber;
    const rawOsVersion = String(
      dev.deviceProperties?.osVersionNumber ||
        (typeof swVerObj === "object" && swVerObj !== null ? swVerObj.stringValue : swVerObj) ||
        "",
    );
    const osPrefix = /watch/i.test(rawPlatform)
      ? "watchOS"
      : /tv/i.test(rawPlatform)
        ? "tvOS"
        : /vision|xr/i.test(rawPlatform)
          ? "visionOS"
          : "iOS";
    const osVersion = rawOsVersion ? `${osPrefix}-${rawOsVersion}` : osPrefix;
    const devName =
      props.name ||
      dev.deviceProperties?.name ||
      hw.marketingName ||
      hw.productType ||
      hw.deviceType ||
      String(udid);
    const deviceType = inferIosDeviceType(
      `${devName} ${hw.deviceType || ""} ${hw.productType || ""}`,
      rawPlatform,
      osVersion,
    );
    const cpuName = String(hw.cpuType?.name || "");
    const cpuTypeNum = Number(hw.cpuType?.type ?? dev.properties?.hardware?.cpuType?.type ?? 0);
    const cpuArch =
      cpuName.includes("x86_64") || cpuTypeNum === 16777223 ? "x86_64" : "arm64";
    physicalDevices.push({
      deviceKey: `serial:${udid}`,
      platform: "ios",
      kind: "physical",
      avd: null,
      serial: String(udid),
      udid: String(udid),
      coreDeviceId: String(coreDeviceId),
      online: true,
      ramSizeMb: 0,
      requiredRamMb: 0,
      dataDiskMb: 0,
      snapshots: [],
      profile: {
        platform: "ios",
        deviceType,
        deviceName: devName,
        osVersion,
        apiLevel: osVersion,
        coreDeviceId: String(coreDeviceId),
        services: "apple",
        playStore: false,
        abi: cpuArch,
      },
    });
  }
  return physicalDevices;
}

export function discoverIosFleet({
  stateDir = null,
  cfg = DEFAULT_CONFIG,
  runner = runCommandSync,
  platform = process.platform,
  env = process.env,
  onProgress = null,
  includePhysical = true,
} = {}) {
  const notifyProgress = () => {
    if (typeof onProgress === "function") {
      try {
        onProgress();
      } catch {
        // Ignore callback error
      }
    }
  };
  const discoveredAtMs = Date.now();
  const coreSimDir = path.join(os.homedir(), "Library", "Developer", "CoreSimulator");
  const host = readHostResources(fs.existsSync(coreSimDir) ? coreSimDir : os.homedir());

  if (platform !== "darwin") {
    return {
      host,
      discoveredAtMs,
      queriedPlatforms: ["ios"],
      running: [],
      offline: [],
      creatable: [],
      onlineSerials: [],
      probes: {
        simctlListOk: false,
        devicectlListOk: false,
        simctlStatus: 1,
        simctlStderr: `iOS targets require macOS with Xcode installed (current host OS: ${platform}).`,
      },
    };
  }

  notifyProgress();
  const simRes = runIosCommandSync(runner, "xcrun", ["simctl", "list", "--json"], {
    timeoutMs: 8000,
    env,
  });
  notifyProgress();

  let simctlListOk = false;
  let running = [];
  let offline = [];
  let creatable = [];
  let onlineSerials = [];
  let availableRuntimesByFamily = { iOS: 0, watchOS: 0, tvOS: 0, visionOS: 0 };

  if (simRes.status === 0 && simRes.stdout) {
    try {
      const parsedSim = parseSimctlListJson(simRes.stdout, { stateDir, cfg, host });
      simctlListOk = true;
      running = parsedSim.running;
      offline = parsedSim.offline;
      creatable = parsedSim.creatable;
      onlineSerials = parsedSim.onlineSerials;
      availableRuntimesByFamily = parsedSim.availableRuntimesByFamily;
    } catch {
      simctlListOk = false;
    }
  }

  let devicectlListOk = true;
  if (includePhysical && cfg?.allowPhysicalDevices !== "never") {
    const tmpFile = path.join(
      os.tmpdir(),
      `atc-devicectl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    try {
      const devRes = runIosCommandSync(
        runner,
        "xcrun",
        ["devicectl", "list", "devices", "--json-output", tmpFile],
        { timeoutMs: 5000, env },
      );
      notifyProgress();
      let rawJson = null;
      if (fs.existsSync(tmpFile)) {
        rawJson = fs.readFileSync(tmpFile, "utf8");
      } else if (devRes.status === 0 && devRes.stdout && devRes.stdout.trim().startsWith("{")) {
        rawJson = devRes.stdout;
      }
      if (devRes.status === 0 && rawJson) {
        const knownSimUdids = new Set(
          [...running, ...offline].map((d) => d.udid || d.serial).filter(Boolean),
        );
        const phys = parseDevicectlListJson(rawJson);
        for (const p of phys) {
          if (knownSimUdids.has(p.udid) || knownSimUdids.has(p.serial)) continue;
          running.push(p);
          onlineSerials.push(p.serial);
        }
      } else if (devRes.status !== 0) {
        devicectlListOk = false;
      }
    } catch {
      devicectlListOk = false;
    } finally {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  return {
    host,
    discoveredAtMs,
    queriedPlatforms: ["ios"],
    running,
    offline,
    creatable,
    onlineSerials,
    availableRuntimesByFamily,
    probes: {
      simctlListOk,
      devicectlListOk,
      simctlStatus: simRes.status,
      simctlStderr: `${simRes.stderr || ""} ${simRes.stdout || ""}`.trim(),
      simctlErrorCode: simRes.error?.code || null,
    },
  };
}

export function diagnosePlatformToolingError(targetPlatform, req = {}, inventory = {}, options = {}) {
  const hostPlatform = options.platform || process.platform;
  const probes = inventory?.probes || {};

  if (targetPlatform === "ios") {
    if (hostPlatform !== "darwin") {
      return `iOS targets require macOS with Xcode installed (current host OS: ${hostPlatform}).`;
    }
    const stderr = String(probes.simctlStderr || "");
    if (
      probes.simctlStatus === 69 ||
      /agree to the Xcode\/iOS license|xcodebuild -license/i.test(stderr)
    ) {
      return "Xcode license agreement has not been accepted. Run 'sudo xcodebuild -license accept' in an interactive terminal.";
    }
    if (/first launch|install additional required components|-runFirstLaunch/i.test(stderr)) {
      return "Xcode requires initial component installation. Run 'sudo xcodebuild -runFirstLaunch' in an interactive terminal.";
    }
    if (
      req.kind !== "physical" &&
      (probes.simctlErrorCode === "ENOENT" ||
        /unable to find utility "simctl"|not a developer tool/i.test(stderr))
    ) {
      return "Xcode Simulator tools (simctl) not found. Install Xcode.app or point DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer.";
    }
    if (
      req.kind !== "physical" &&
      probes.simctlListOk === true &&
      inventory?.availableRuntimesByFamily
    ) {
      const wantType = String(req.deviceType || "phone").toLowerCase();
      const runtimeFamily =
        wantType === "watch" || wantType === "wear"
          ? "watchOS"
          : wantType === "tv"
            ? "tvOS"
            : wantType === "xr"
              ? "visionOS"
              : "iOS";
      const familyCount = inventory.availableRuntimesByFamily[runtimeFamily] ?? 0;
      const hasAnyFamilySim = [
        ...(inventory.running || []),
        ...(inventory.offline || []),
      ].some(
        (d) =>
          d.platform === "ios" &&
          d.kind === "emulator" &&
          String(d.profile?.osVersion || "").toLowerCase().startsWith(runtimeFamily.toLowerCase()),
      );
      if (familyCount === 0 && !hasAnyFamilySim) {
        return `No ${runtimeFamily} Simulator runtimes are installed. Run 'xcodebuild -downloadPlatform ${runtimeFamily}' to download a Simulator runtime.`;
      }
    }
    return null;
  }

  // Android pre-flight checks (only when real discovery probes ran and returned 0 devices)
  if (!inventory?.probes) return null;
  const totalDevices = (inventory.running || []).length + (inventory.offline || []).length;
  if (totalDevices > 0) return null;

  if (
    probes.adbErrorCode === "ENOENT" ||
    /command not found|not recognized/i.test(String(probes.adbStderr || ""))
  ) {
    return "Android Debug Bridge ('adb') not found on PATH. Install Android SDK platform-tools and add it to PATH.";
  }
  if (
    req.kind !== "physical" &&
    probes.emulatorListOk === false &&
    (probes.emuListErrorCode === "ENOENT" ||
      /command not found|not recognized/i.test(String(probes.emuListStderr || "")))
  ) {
    return "Android CLI ('android') and SDK 'emulator' not found on PATH. Install the Android CLI or add $ANDROID_HOME/emulator and $ANDROID_HOME/platform-tools to PATH.";
  }
  return null;
}

const SIM_TCC_PROTECTED_SUBDIRS = [
  path.join("Library", "Spotlight"),
  path.join("Library", "Caches", "locationd"),
];

function isBenignTccCloneError(stderr, destDir) {
  if (!destDir || !fs.existsSync(destDir)) return false;
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (line) =>
      /Operation not permitted/i.test(line) &&
      (/\/Library\/Spotlight\//.test(line) || /\/Library\/Caches\/locationd\//.test(line)),
  );
}

function cloneDirectoryApfsOrCopy(runner, srcDir, destDir, timeoutMs = 60_000, env = process.env) {
  const cpRes = runner("cp", ["-cR", srcDir, destDir], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  if (cpRes.status === 0 || isBenignTccCloneError(cpRes.stderr, destDir)) {
    return { ...cpRes, status: 0 };
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  // Fallback to cp -a if filesystem does not support APFS clonefile (e.g. tmpfs in tests)
  const fallbackRes = runner("cp", ["-a", srcDir, destDir], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  if (fallbackRes.status === 0 || isBenignTccCloneError(fallbackRes.stderr, destDir)) {
    return { ...fallbackRes, status: 0 };
  }
  return fallbackRes;
}

export function saveIosSimulatorSnapshot(
  stateDir,
  lease,
  name,
  {
    runner = runCommandSync,
    stopTimeoutMs = 60_000,
    bootTimeoutMs = 180_000,
    skipReboot = false,
    env = process.env,
    assertOwned = null,
  } = {},
) {
  const udid = lease.serial || lease.udid;
  if (!udid) {
    throw new Error(`Cannot save snapshot "${name}": simulator lease has no UDID.`);
  }
  const srcDataDir = lease.dataPath || resolveSimulatorDataDir(udid);
  if (!fs.existsSync(srcDataDir)) {
    throw new Error(
      `Cannot save snapshot "${name}" for simulator ${udid}: data directory ${srcDataDir} does not exist.`,
    );
  }
  if (assertOwned) assertOwned();
  const shutRes = runIosCommandSync(runner, "xcrun", ["simctl", "shutdown", udid], {
    strictInternal: true,
    timeoutMs: stopTimeoutMs,
    env,
  });
  const shutMsg = `${shutRes.stderr || ""} ${shutRes.stdout || ""}`;
  if (shutRes.status !== 0 && !/current state:\s*Shutdown/i.test(shutMsg)) {
    throw new Error(`Failed to shut down simulator ${udid} for snapshot save: ${shutMsg.trim()}`);
  }

  const udidSnapRoot = path.join(stateDir, "ios-snapshots", String(udid));
  fs.mkdirSync(udidSnapRoot, { recursive: true });
  const stageDir = path.join(
    udidSnapRoot,
    `.tmp-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const finalDir = path.join(udidSnapRoot, name);

  try {
    fs.mkdirSync(stageDir, { recursive: true });
    if (assertOwned) assertOwned();
    const stagedDataDir = path.join(stageDir, "data");
    const movedTccDirs = [];
    const parentSrcDir = path.dirname(srcDataDir);
    try {
      for (let i = 0; i < SIM_TCC_PROTECTED_SUBDIRS.length; i++) {
        const rel = SIM_TCC_PROTECTED_SUBDIRS[i];
        const origPath = path.join(srcDataDir, rel);
        if (fs.existsSync(origPath)) {
          const asidePath = path.join(
            parentSrcDir,
            `.atc-tcc-aside-${process.pid}-${Date.now()}-${i}`,
          );
          try {
            fs.renameSync(origPath, asidePath);
            movedTccDirs.push({ origPath, asidePath });
          } catch {
            // Best-effort TCC aside move
          }
        }
      }
      const cloneRes = cloneDirectoryApfsOrCopy(
        runner,
        srcDataDir,
        stagedDataDir,
        stopTimeoutMs,
        env,
      );
      if (cloneRes.status !== 0) {
        throw new Error(
          `Failed to clone simulator data directory for snapshot "${name}": ${(cloneRes.stderr || cloneRes.stdout || "").trim()}`,
        );
      }
    } finally {
      for (const { origPath, asidePath } of movedTccDirs) {
        try {
          if (fs.existsSync(asidePath)) {
            fs.renameSync(asidePath, origPath);
          }
        } catch {
          // Best-effort restore
        }
      }
    }
    const meta = {
      name,
      udid: String(udid),
      runtimeId: lease.profile?.runtimeId || null,
      osVersion: lease.profile?.osVersion || lease.profile?.apiLevel || null,
      createdAtMs: Date.now(),
    };
    fs.writeFileSync(path.join(stageDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(stageDir, finalDir);
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (!skipReboot) {
      runIosCommandSync(runner, "xcrun", ["simctl", "boot", udid], {
        strictInternal: true,
        timeoutMs: bootTimeoutMs,
        env,
      });
    }
    throw err;
  }

  if (!skipReboot) {
    if (assertOwned) assertOwned();
    const bootRes = runIosCommandSync(runner, "xcrun", ["simctl", "boot", udid], {
      strictInternal: true,
      timeoutMs: bootTimeoutMs,
      env,
    });
    const bootMsg = `${bootRes.stderr || ""} ${bootRes.stdout || ""}`;
    if (bootRes.status !== 0 && !/current state:\s*Booted/i.test(bootMsg)) {
      throw new Error(
        `Failed to reboot simulator ${udid} after snapshot save: ${bootMsg.trim()}`,
      );
    }
    const statusRes = runIosCommandSync(runner, "xcrun", ["simctl", "bootstatus", udid, "-b"], {
      strictInternal: true,
      timeoutMs: bootTimeoutMs,
      env,
    });
    if (statusRes.status !== 0) {
      throw new Error(
        `Timed out waiting for simulator ${udid} bootstatus after snapshot save: ${(statusRes.stderr || statusRes.stdout || "").trim()}`,
      );
    }
  }
}

export function loadIosSimulatorSnapshot(
  stateDir,
  lease,
  name,
  {
    runner = runCommandSync,
    stopTimeoutMs = 60_000,
    bootTimeoutMs = 180_000,
    skipReboot = false,
    env = process.env,
    assertOwned = null,
  } = {},
) {
  const udid = lease.serial || lease.udid;
  if (!udid) {
    throw new Error(`Cannot load snapshot "${name}": simulator lease has no UDID.`);
  }
  const snapDir = path.join(stateDir, "ios-snapshots", String(udid), name);
  const snapDataDir = path.join(snapDir, "data");
  const metaPath = path.join(snapDir, "meta.json");
  if (!fs.existsSync(snapDataDir)) {
    throw new Error(`Snapshot "${name}" does not exist for simulator ${udid}.`);
  }
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (
        meta.runtimeId &&
        lease.profile?.runtimeId &&
        meta.runtimeId !== lease.profile.runtimeId
      ) {
        throw new Error(
          `Snapshot "${name}" was captured on runtime "${meta.runtimeId}" and cannot be loaded onto "${lease.profile.runtimeId}".`,
        );
      }
    } catch (err) {
      if (/cannot be loaded onto/.test(err.message)) {
        throw err;
      }
    }
  }

  const targetDataDir = lease.dataPath || resolveSimulatorDataDir(udid);
  const parentDeviceDir = path.dirname(targetDataDir);
  fs.mkdirSync(parentDeviceDir, { recursive: true });

  if (assertOwned) assertOwned();
  const shutRes = runIosCommandSync(runner, "xcrun", ["simctl", "shutdown", udid], {
    strictInternal: true,
    timeoutMs: stopTimeoutMs,
    env,
  });
  const shutMsg = `${shutRes.stderr || ""} ${shutRes.stdout || ""}`;
  if (shutRes.status !== 0 && !/current state:\s*Shutdown/i.test(shutMsg)) {
    throw new Error(`Failed to shut down simulator ${udid} for snapshot load: ${shutMsg.trim()}`);
  }

  const stagedRestoreDir = path.join(
    parentDeviceDir,
    `data.restore.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
  );
  const backupDataDir = path.join(
    parentDeviceDir,
    `data.backup.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    if (assertOwned) assertOwned();
    const cloneRes = cloneDirectoryApfsOrCopy(
      runner,
      snapDataDir,
      stagedRestoreDir,
      stopTimeoutMs,
      env,
    );
    if (cloneRes.status !== 0) {
      throw new Error(
        `Failed to restore snapshot "${name}" onto simulator ${udid}: ${(cloneRes.stderr || cloneRes.stdout || "").trim()}`,
      );
    }
    if (fs.existsSync(targetDataDir)) {
      fs.renameSync(targetDataDir, backupDataDir);
    }
    const transferredTccDirs = [];
    try {
      if (fs.existsSync(backupDataDir)) {
        for (const rel of SIM_TCC_PROTECTED_SUBDIRS) {
          const fromBackup = path.join(backupDataDir, rel);
          const toStaged = path.join(stagedRestoreDir, rel);
          if (fs.existsSync(fromBackup) && !fs.existsSync(toStaged)) {
            try {
              fs.mkdirSync(path.dirname(toStaged), { recursive: true });
              fs.renameSync(fromBackup, toStaged);
              transferredTccDirs.push({ fromBackup, toStaged });
            } catch {
              // Best-effort TCC directory preservation
            }
          }
        }
      }
      fs.renameSync(stagedRestoreDir, targetDataDir);
      fs.rmSync(backupDataDir, { recursive: true, force: true });
    } catch (swapErr) {
      for (const { fromBackup, toStaged } of transferredTccDirs) {
        try {
          if (fs.existsSync(toStaged) && !fs.existsSync(fromBackup)) {
            fs.renameSync(toStaged, fromBackup);
          }
        } catch {
          // Ignore rollback error
        }
      }
      if (!fs.existsSync(targetDataDir) && fs.existsSync(backupDataDir)) {
        fs.renameSync(backupDataDir, targetDataDir);
      }
      throw swapErr;
    }
  } finally {
    fs.rmSync(stagedRestoreDir, { recursive: true, force: true });
  }

  if (!skipReboot) {
    if (assertOwned) assertOwned();
    const bootRes = runIosCommandSync(runner, "xcrun", ["simctl", "boot", udid], {
      strictInternal: true,
      timeoutMs: bootTimeoutMs,
      env,
    });
    const bootMsg = `${bootRes.stderr || ""} ${bootRes.stdout || ""}`;
    if (bootRes.status !== 0 && !/current state:\s*Booted/i.test(bootMsg)) {
      throw new Error(
        `Failed to reboot simulator ${udid} after snapshot load: ${bootMsg.trim()}`,
      );
    }
    const statusRes = runIosCommandSync(runner, "xcrun", ["simctl", "bootstatus", udid, "-b"], {
      strictInternal: true,
      timeoutMs: bootTimeoutMs,
      env,
    });
    if (statusRes.status !== 0) {
      throw new Error(
        `Timed out waiting for simulator ${udid} bootstatus after snapshot load: ${(statusRes.stderr || statusRes.stdout || "").trim()}`,
      );
    }
  }
}

export function deleteIosSimulatorSnapshot(stateDir, leaseOrUdid, name) {
  const udid =
    leaseOrUdid && typeof leaseOrUdid === "object"
      ? leaseOrUdid.udid || leaseOrUdid.serial
      : leaseOrUdid;
  const snapDir = path.join(stateDir, "ios-snapshots", String(udid), name);
  if (!fs.existsSync(snapDir)) {
    throw new Error(`Snapshot "${name}" does not exist for simulator ${udid}.`);
  }
  fs.rmSync(snapDir, { recursive: true, force: true });
}

export const runAppleToolSync = runIosCommandSync;

export function waitForIosSimulatorBooted(
  runner = runCommandSync,
  udid,
  timeoutMs = 180_000,
  env = process.env,
) {
  const statusRes = runIosCommandSync(runner, "xcrun", ["simctl", "bootstatus", udid, "-b"], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  if (statusRes.status !== 0) {
    throw new Error(
      `Timed out waiting for simulator ${udid} bootstatus: ${(statusRes.stderr || statusRes.stdout || "").trim()}`,
    );
  }
}

export function bootIosSimulator(
  udid,
  { runner = runCommandSync, timeoutMs = 180_000, headless = false, env = process.env } = {},
) {
  const bootRes = runIosCommandSync(runner, "xcrun", ["simctl", "boot", udid], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  const bootMsg = `${bootRes.stderr || ""} ${bootRes.stdout || ""}`;
  if (bootRes.status !== 0 && !/current state:\s*Booted/i.test(bootMsg)) {
    const compatHint = /SimLaunchHostService|code=53/i.test(bootMsg)
      ? " (Hint: Simulator runtime may be incompatible with the active Xcode version; run 'xcodebuild -downloadPlatform iOS' to install a matching runtime)"
      : "";
    throw new Error(`Failed to boot simulator ${udid}: ${bootMsg.trim()}${compatHint}`);
  }
  waitForIosSimulatorBooted(runner, udid, timeoutMs, env);
  if (!headless) {
    try {
      runner("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", String(udid)], {
        timeoutMs: 10_000,
        env,
      });
    } catch {
      // Best-effort Simulator.app GUI foregrounding when not headless
    }
  }
}

export function shutdownIosSimulator(
  udid,
  { runner = runCommandSync, timeoutMs = 60_000, env = process.env } = {},
) {
  const shutRes = runIosCommandSync(runner, "xcrun", ["simctl", "shutdown", udid], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  const shutMsg = `${shutRes.stderr || ""} ${shutRes.stdout || ""}`;
  if (shutRes.status !== 0 && !/current state:\s*Shutdown/i.test(shutMsg)) {
    throw new Error(`Failed to shut down simulator ${udid}: ${shutMsg.trim()}`);
  }
}

export function deleteIosSimulator(
  udid,
  { runner = runCommandSync, timeoutMs = 60_000, env = process.env } = {},
) {
  if (!udid || String(udid).trim() === "" || String(udid) === "undefined") {
    throw new Error("Cannot delete an iOS Simulator without a UDID.");
  }
  const shutRes = runIosCommandSync(runner, "xcrun", ["simctl", "shutdown", String(udid)], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  const shutMsg = `${shutRes.stderr || ""} ${shutRes.stdout || ""}`;
  if (shutRes.status !== 0 && !/current state:\s*Shutdown/i.test(shutMsg)) {
    throw new Error(`Failed to shut down simulator ${udid} before delete: ${shutMsg.trim()}`);
  }
  const delRes = runIosCommandSync(runner, "xcrun", ["simctl", "delete", String(udid)], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  if (delRes.status !== 0) {
    throw new Error(
      `Failed to delete simulator ${udid}: ${(delRes.stderr || delRes.stdout || "").trim()}`,
    );
  }
}

export function eraseIosSimulator(
  udid,
  { runner = runCommandSync, timeoutMs = 60_000, env = process.env } = {},
) {
  const eraseRes = runIosCommandSync(runner, "xcrun", ["simctl", "erase", udid], {
    strictInternal: true,
    timeoutMs,
    env,
  });
  if (eraseRes.status !== 0) {
    throw new Error(
      `Failed to erase simulator ${udid}: ${(eraseRes.stderr || eraseRes.stdout || "").trim()}`,
    );
  }
}

export function createIosSimulator(
  name,
  deviceTypeId,
  runtimeId,
  { runner = runCommandSync, timeoutMs = 180_000, env = process.env } = {},
) {
  if (deviceTypeId === undefined || deviceTypeId === null || String(deviceTypeId).trim() === "") {
    throw new Error(
      `Cannot create iOS Simulator "${name}": missing device type. ` +
        `Refusing to pass an empty device type to simctl.`,
    );
  }
  const args = ["simctl", "create", String(name), String(deviceTypeId)];
  if (runtimeId) {
    args.push(String(runtimeId));
  }
  const createRes = runIosCommandSync(runner, "xcrun", args, {
    strictInternal: true,
    timeoutMs,
    env,
  });
  if (createRes.status !== 0) {
    throw new Error(
      `Failed to create iOS Simulator "${name}": ${(createRes.stderr || createRes.stdout || "").trim()}`,
    );
  }
  const udid = String(createRes.stdout || "").trim().split(/\r?\n/)[0].trim();
  if (!udid) {
    throw new Error(`xcrun simctl create did not return a valid UDID for "${name}".`);
  }
  return {
    udid,
    dataPath: resolveSimulatorDataDir(udid),
  };
}

export function resetIosSimulatorApp(arg1, arg2, arg3 = {}, arg4 = {}) {
  let runner = runCommandSync;
  let udid;
  let bundleId;
  let opts = {};
  if (typeof arg1 === "function") {
    runner = arg1;
    udid = arg2;
    bundleId = arg3;
    opts = arg4 || {};
  } else {
    udid = arg1;
    bundleId = arg2;
    opts = arg3 || {};
    if (opts.runner) runner = opts.runner;
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const env = opts.env || process.env;

  runIosCommandSync(runner, "xcrun", ["simctl", "terminate", udid, bundleId], {
    strictInternal: true,
    timeoutMs: Math.min(10_000, timeoutMs),
    env,
  });
  runIosCommandSync(runner, "xcrun", ["simctl", "privacy", udid, "reset", "all", bundleId], {
    strictInternal: true,
    timeoutMs: Math.min(15_000, timeoutMs),
    env,
  });
  const containerRes = runIosCommandSync(
    runner,
    "xcrun",
    ["simctl", "get_app_container", udid, bundleId, "data"],
    {
      strictInternal: true,
      timeoutMs: Math.min(10_000, timeoutMs),
      env,
    },
  );
  if (containerRes.status !== 0) {
    const errText = `${containerRes.stderr || ""} ${containerRes.stdout || ""}`.trim();
    if (/No such file or directory|not found|not installed/i.test(errText)) {
      return { status: 0 };
    }
    throw new Error(
      `Failed to reset app "${bundleId}" on simulator ${udid}: ${errText}`,
    );
  }
  const containerPath = String(containerRes.stdout || "").trim();
  if (containerPath && path.isAbsolute(containerPath) && fs.existsSync(containerPath)) {
    for (const sub of ["Documents", "tmp", path.join("Library", "Caches")]) {
      const subDir = path.join(containerPath, sub);
      if (fs.existsSync(subDir)) {
        try {
          for (const entry of fs.readdirSync(subDir)) {
            fs.rmSync(path.join(subDir, entry), { recursive: true, force: true });
          }
        } catch {
          // Best-effort container cleanup
        }
      }
    }
    const prefsFile = path.join(containerPath, "Library", "Preferences", `${bundleId}.plist`);
    if (fs.existsSync(prefsFile)) {
      try {
        fs.rmSync(prefsFile, { force: true });
      } catch {
        // Ignore
      }
    }
  }
  return { status: 0 };
}
