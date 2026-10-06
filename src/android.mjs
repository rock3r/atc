import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommandSync } from "./spawn.mjs";
import { DEFAULT_CONFIG, normalizeApiLevel } from "./state.mjs";

export class ResourceError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "ResourceError";
    this.exitCode = exitCode;
  }
}

export function parseSizeMb(val, fallbackMb) {
  if (val === undefined || val === null || val === "") return fallbackMb;
  const s = String(val).trim().toUpperCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(K|KB|M|MB|G|GB)?$/);
  if (!m) return fallbackMb;
  const num = Number(m[1]);
  const unit = m[2] || "M";
  if (unit.startsWith("G")) return Math.round(num * 1024);
  if (unit.startsWith("K")) return Math.max(1, Math.round(num / 1024));
  return Math.round(num);
}

export function parseIniFile(content) {
  const map = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    map[key] = val;
  }
  return map;
}

export function inferDeviceType(deviceName = "", sysDir = "", tagId = "") {
  const combined = `${deviceName} ${sysDir} ${tagId}`.toLowerCase();
  if (combined.includes("xr") || combined.includes("glasses")) return "xr";
  if (combined.includes("wear")) return "wear";
  if (combined.includes("tv") || combined.includes("atv")) return "tv";
  if (combined.includes("auto") || combined.includes("car")) return "automotive";
  if (combined.includes("desktop")) return "desktop";
  if (combined.includes("fold")) return "foldable";
  if (combined.includes("tablet") || combined.includes("pixel_c")) return "tablet";
  if (combined.includes("resizable")) return "resizable";
  return "phone";
}

export function inferServices(playStoreEnabled, sysDir = "", tagId = "") {
  const isPlay =
    String(playStoreEnabled).toLowerCase() === "true" ||
    String(playStoreEnabled) === "1" ||
    sysDir.toLowerCase().includes("playstore") ||
    tagId.toLowerCase().includes("playstore") ||
    tagId.toLowerCase().includes("wear-signed");
  if (isPlay) {
    return { services: "play", playStore: true };
  }
  if (sysDir.toLowerCase().includes("google_apis") || tagId.toLowerCase().includes("google_apis")) {
    return { services: "google_apis", playStore: false };
  }
  return { services: "aosp", playStore: false };
}

export function resolveAvdHome(env = process.env) {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_PREFS_ROOT) return path.join(env.ANDROID_PREFS_ROOT, ".android", "avd");
  return path.join(os.homedir(), ".android", "avd");
}

export function readLocalAvdMetadata(avdId, avdHome = resolveAvdHome(), cfg = DEFAULT_CONFIG) {
  const iniPath = path.join(avdHome, `${avdId}.ini`);
  let avdPath = path.join(avdHome, `${avdId}.avd`);
  let targetApi = null;

  if (fs.existsSync(iniPath)) {
    try {
      const rootIni = parseIniFile(fs.readFileSync(iniPath, "utf8"));
      if (rootIni.path && fs.existsSync(rootIni.path)) {
        avdPath = rootIni.path;
      }
      if (rootIni.target) {
        targetApi = normalizeApiLevel(rootIni.target);
      }
    } catch {
      // Fallback to default .avd path
    }
  }

  const configPath = path.join(avdPath, "config.ini");
  let configIni = {};
  if (fs.existsSync(configPath)) {
    try {
      configIni = parseIniFile(fs.readFileSync(configPath, "utf8"));
    } catch {
      // Ignore parse error
    }
  }

  const sysDir = configIni["image.sysdir.1"] || "";
  const apiMatch = sysDir.match(/android-(\d+)/i);
  const apiLevel = apiMatch ? `android-${apiMatch[1]}` : targetApi || "unknown";
  const tagId = configIni["tag.id"] || "";
  const deviceName = configIni["hw.device.name"] || avdId;
  const deviceType = inferDeviceType(deviceName, sysDir, tagId);
  const { services, playStore } = inferServices(configIni["PlayStore.enabled"], sysDir, tagId);
  const abi = configIni["abi.type"] || "arm64-v8a";
  const ramSizeMb = parseSizeMb(configIni["hw.ramSize"], 2048);
  const cpuCores = Number(configIni["hw.cpu.ncore"]) || 4;
  const dataPartitionMb = parseSizeMb(configIni["disk.dataPartition.size"], 6144);
  const sdcardMb = parseSizeMb(configIni["sdcard.size"], 512);
  const dataDiskMb = dataPartitionMb + sdcardMb;
  const requiredRamMb = ramSizeMb + (cfg.qemuOverheadRamMb ?? 1024);

  let snapshots = [];
  const snapDir = path.join(avdPath, "snapshots");
  if (fs.existsSync(snapDir)) {
    try {
      snapshots = fs
        .readdirSync(snapDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      // Ignore snapshot read error
    }
  }

  return {
    avd: avdId,
    avdPath,
    profile: {
      deviceType,
      deviceName,
      apiLevel,
      services,
      playStore,
      abi,
    },
    ramSizeMb,
    requiredRamMb,
    cpuCores,
    dataDiskMb,
    snapshots,
  };
}

export function wipeAvdUserData(avdId, avdHome = resolveAvdHome(), cfg = DEFAULT_CONFIG) {
  const meta = readLocalAvdMetadata(avdId, avdHome, cfg);
  const avdPath = meta.avdPath;
  if (!avdPath || !fs.existsSync(avdPath)) {
    return;
  }
  const filesToRemove = [
    "userdata-qemu.img",
    "userdata-qemu.img.qcow2",
    "cache.img",
    "cache.img.qcow2",
    "encryptionkey.img",
    "encryptionkey.img.qcow2",
  ];
  for (const name of filesToRemove) {
    fs.rmSync(path.join(avdPath, name), { force: true });
  }
  fs.rmSync(path.join(avdPath, "snapshots", "default_boot"), { recursive: true, force: true });
}

export function parseAdbDevicesOutput(stdout) {
  const results = [];
  const lines = String(stdout).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state] = parts;
    if (state !== "device") continue;
    const isEmulator = /^emulator-\d+$/.test(serial);
    results.push({
      serial,
      kind: isEmulator ? "emulator" : "physical",
    });
  }
  return results;
}

export function parseAdbGetpropOutput(stdout) {
  const props = {};
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const m = rawLine.trim().match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (m) {
      props[m[1].trim()] = m[2].trim();
    }
  }
  return props;
}

export function parseAndroidEmulatorListOutput(stdout) {
  const avds = [];
  const lines = String(stdout).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("AVD") || line.startsWith("---") || line.startsWith("No ")) {
      continue;
    }
    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length === 1 && /^[A-Za-z0-9._-]+$/.test(cols[0])) {
      avds.push({ avd: cols[0], online: false, serial: null, apiLevel: null });
      continue;
    }
    if (cols.length >= 2) {
      const avd = cols[0].split(/\s+/)[0];
      const online = line.toLowerCase().includes("online");
      const serialMatch = line.match(/\b(emulator-\d+)\b/);
      const apiMatch = line.match(/\b(?:android-)?(\d{2})\b/i);
      avds.push({
        avd,
        online,
        serial: serialMatch ? serialMatch[1] : null,
        apiLevel: apiMatch ? `android-${apiMatch[1]}` : null,
      });
    }
  }
  return avds;
}

export function resolveSdkRoot(env = process.env) {
  if (env.ANDROID_HOME) return env.ANDROID_HOME;
  if (env.ANDROID_SDK_ROOT) return env.ANDROID_SDK_ROOT;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Android", "sdk");
  }
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Android", "Sdk");
  }
  return path.join(os.homedir(), "Android", "Sdk");
}

export function readInstalledSystemImages(sdkRoot = resolveSdkRoot()) {
  const images = [];
  if (!sdkRoot) return images;
  const sysImagesDir = path.join(sdkRoot, "system-images");
  if (!fs.existsSync(sysImagesDir)) return images;
  try {
    for (const apiDir of fs.readdirSync(sysImagesDir, { withFileTypes: true })) {
      if (!apiDir.isDirectory()) continue;
      const apiMatch = apiDir.name.match(/android-(\d+)/i);
      const apiLevel = apiMatch ? `android-${apiMatch[1]}` : apiDir.name;
      const apiPath = path.join(sysImagesDir, apiDir.name);
      for (const tagDir of fs.readdirSync(apiPath, { withFileTypes: true })) {
        if (!tagDir.isDirectory()) continue;
        const tagId = tagDir.name;
        const tagPath = path.join(apiPath, tagId);
        for (const abiDir of fs.readdirSync(tagPath, { withFileTypes: true })) {
          if (!abiDir.isDirectory()) continue;
          const abi = abiDir.name.toLowerCase();
          const sysDirRel = `system-images/${apiDir.name}/${tagId}/${abiDir.name}/`;
          const { services, playStore } = inferServices(false, sysDirRel, tagId);
          images.push({
            apiLevel,
            tagId,
            services,
            playStore,
            abi,
          });
        }
      }
    }
  } catch {
    // Ignore unreadable system-images directory
  }
  return images;
}

export function parseCreatableProfilesOutput(stdout, installedImages = []) {
  const profiles = [];
  const lines = String(stdout).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith("Profile") ||
      line.startsWith("Device") ||
      line.startsWith("ID") ||
      line.startsWith("---") ||
      line.startsWith("No ")
    ) {
      continue;
    }
    const cols = line
      .split(/\s{2,}|\s+/)
      .map((c) => c.trim())
      .filter(Boolean);
    const deviceName = cols[0];
    if (!deviceName || !/^[A-Za-z0-9._-]+$/.test(deviceName)) continue;

    const apiMatch = line.match(/\b(?:android-)?(\d{2})\b/i);
    const apiLevel = apiMatch ? `android-${apiMatch[1]}` : null;
    const abiMatch = line.match(/\b(arm64-v8a|x86_64|x86|armeabi-v7a)\b/i);
    const abi = abiMatch ? abiMatch[1].toLowerCase() : null;
    const hasServiceToken = /\b(playstore|play|google_apis|aosp|wear-signed)\b/i.test(line);
    const { services, playStore } = hasServiceToken
      ? inferServices(line.toLowerCase().includes("play"), line, line)
      : { services: null, playStore: null };
    const deviceType = inferDeviceType(deviceName, line, line);

    if (apiLevel === null && abi === null && services === null && installedImages.length > 0) {
      for (const img of installedImages) {
        profiles.push({
          kind: "emulator",
          deviceName,
          profile: {
            deviceType,
            deviceName,
            apiLevel: img.apiLevel,
            services: img.services,
            playStore: img.playStore,
            abi: img.abi,
          },
        });
      }
      continue;
    }

    profiles.push({
      kind: "emulator",
      deviceName,
      profile: {
        deviceType,
        deviceName,
        apiLevel,
        services,
        playStore,
        abi,
      },
    });
  }
  return profiles;
}

export function readFreeDiskMb(avdHome = resolveAvdHome()) {
  let freeDiskMb = 16384;
  try {
    const targetDir = fs.existsSync(avdHome) ? avdHome : os.homedir();
    const stat = fs.statfsSync(targetDir);
    freeDiskMb = Math.round((Number(stat.bavail) * Number(stat.bsize)) / (1024 * 1024));
  } catch {
    // Fallback
  }
  return freeDiskMb;
}

export function readHostResources(avdHome = resolveAvdHome()) {
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
  let availableRamMb = Math.round(os.freemem() / (1024 * 1024));

  if (process.platform === "linux" && fs.existsSync("/proc/meminfo")) {
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/i);
      if (m) {
        availableRamMb = Math.round(Number(m[1]) / 1024);
      }
    } catch {
      // Fallback to os.freemem()
    }
  } else if (process.platform === "darwin") {
    try {
      const vm = runCommandSync("vm_stat", [], { timeoutMs: 2000 });
      if (vm.status === 0 && vm.stdout) {
        const pageSizeMatch = vm.stdout.match(/page size of (\d+) bytes/i);
        const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;
        const readPages = (label) => {
          const m = vm.stdout.match(new RegExp(`${label}:\\s+(\\d+)`, "i"));
          return m ? Number(m[1]) : 0;
        };
        const reclaimablePages =
          readPages("Pages free") +
          readPages("Pages inactive") +
          readPages("Pages speculative") +
          readPages("Pages purgeable");
        if (reclaimablePages > 0) {
          availableRamMb = Math.round((reclaimablePages * pageSize) / (1024 * 1024));
        }
      }
    } catch {
      // Fallback to os.freemem()
    }
  }

  return {
    totalRamMb,
    availableRamMb,
    freeDiskMb: readFreeDiskMb(avdHome),
    cpuCores: os.availableParallelism(),
  };
}

export function checkResourceAdmission(
  candidate,
  host,
  state,
  inventory,
  { replacingAvd = null, wipeOrCreate = false, force = false, now = Date.now() } = {},
) {
  if (force) return { ok: true };
  const cfg = state.config || DEFAULT_CONFIG;
  const overheadMb = cfg.qemuOverheadRamMb ?? 1024;
  const neededRamMb =
    typeof candidate.ramSizeMb === "number" && candidate.ramSizeMb > 0
      ? candidate.ramSizeMb + overheadMb
      : candidate.requiredRamMb || 2048 + overheadMb;
  const neededDiskMb = wipeOrCreate ? candidate.dataDiskMb || 6656 : candidate.ramSizeMb || 2048;

  const onlineAvds = new Set(
    (inventory?.running || []).filter((d) => d.kind === "emulator").map((d) => d.avd),
  );
  let unaccountedRamMb = 0;
  for (const lease of Object.values(state.leases || {})) {
    if (lease.kind !== "emulator" || lease.avd === candidate.avd) continue;
    const isStarting = lease.state === "starting" && !onlineAvds.has(lease.avd);
    const isRecentlyActivated =
      lease.state === "active" &&
      !onlineAvds.has(lease.avd) &&
      typeof lease.activatedAtMs === "number" &&
      now - lease.activatedAtMs < 30_000;
    if (isStarting || isRecentlyActivated) {
      unaccountedRamMb += lease.requiredRamMb || 2048 + overheadMb;
    }
  }

  const replacingCreditMb = replacingAvd
    ? typeof replacingAvd.ramSizeMb === "number" && replacingAvd.ramSizeMb > 0
      ? replacingAvd.ramSizeMb + overheadMb
      : replacingAvd.requiredRamMb || 2048 + overheadMb
    : 0;
  const projectedAvailableRamMb =
    (host.availableRamMb ?? 4096) + replacingCreditMb - unaccountedRamMb;

  if (projectedAvailableRamMb < neededRamMb + (cfg.minFreeRamMb ?? 2048)) {
    throw new ResourceError(
      5,
      `Insufficient host RAM for AVD "${candidate.avd}": needs ${neededRamMb}MB (+${cfg.minFreeRamMb ?? 2048}MB reserve), projected available is ${projectedAvailableRamMb}MB. Pass --force to bypass.`,
    );
  }

  if ((host.freeDiskMb ?? 16384) < neededDiskMb + (cfg.minFreeDiskMb ?? 2048)) {
    throw new ResourceError(
      5,
      `Insufficient disk space for AVD "${candidate.avd}": needs ${neededDiskMb}MB (+${cfg.minFreeDiskMb ?? 2048}MB reserve), only ${host.freeDiskMb}MB free. Pass --force to bypass.`,
    );
  }

  return { ok: true, projectedAvailableRamMb };
}

export function discoverFleet({
  avdHome = resolveAvdHome(),
  cfg = DEFAULT_CONFIG,
  runner = runCommandSync,
} = {}) {
  const host = readHostResources(avdHome);
  const knownAvds = new Map();

  // 1. Discover local .ini files in ~/.android/avd
  if (fs.existsSync(avdHome)) {
    try {
      for (const entry of fs.readdirSync(avdHome)) {
        if (entry.endsWith(".ini")) {
          const avdId = entry.slice(0, -4);
          knownAvds.set(avdId, {
            ...readLocalAvdMetadata(avdId, avdHome, cfg),
            deviceKey: `avd:${avdId}`,
            kind: "emulator",
            online: false,
            serial: null,
          });
        }
      }
    } catch {
      // Ignore unreadable avdHome
    }
  }

  // 2. Query android emulator list --long
  const emuListRes = runner("android", ["emulator", "list", "--long"], { timeoutMs: 8000 });
  if (emuListRes.status === 0 && emuListRes.stdout) {
    for (const item of parseAndroidEmulatorListOutput(emuListRes.stdout)) {
      const existing = knownAvds.get(item.avd) || {
        ...readLocalAvdMetadata(item.avd, avdHome, cfg),
        deviceKey: `avd:${item.avd}`,
        kind: "emulator",
      };
      if (item.apiLevel && existing.profile.apiLevel === "unknown") {
        existing.profile.apiLevel = item.apiLevel;
      }
      existing.online = Boolean(item.online);
      if (item.serial) existing.serial = item.serial;
      knownAvds.set(item.avd, existing);
    }
  }

  // 3. Query adb devices for online emulators and physical USB/Wi-Fi devices
  const physicalDevices = [];
  const adbRes = runner("adb", ["devices"], { timeoutMs: 8000 });
  if (adbRes.status === 0 && adbRes.stdout) {
    for (const dev of parseAdbDevicesOutput(adbRes.stdout)) {
      if (dev.kind === "emulator") {
        const alreadyMapped = Array.from(knownAvds.values()).find((a) => a.serial === dev.serial);
        if (alreadyMapped) {
          alreadyMapped.online = true;
          continue;
        }
        const nameRes = runner("adb", ["-s", dev.serial, "emu", "avd", "name"], { timeoutMs: 4000 });
        if (nameRes.status === 0 && nameRes.stdout) {
          const avdId = nameRes.stdout.split(/\r?\n/)[0].trim();
          if (avdId && avdId !== "OK") {
            const existing = knownAvds.get(avdId) || {
              ...readLocalAvdMetadata(avdId, avdHome, cfg),
              deviceKey: `avd:${avdId}`,
              kind: "emulator",
            };
            existing.online = true;
            existing.serial = dev.serial;
            knownAvds.set(avdId, existing);
          }
        }
      } else {
        const propRes = runner("adb", ["-s", dev.serial, "shell", "getprop"], { timeoutMs: 4000 });
        const props =
          propRes.status === 0 && propRes.stdout ? parseAdbGetpropOutput(propRes.stdout) : {};
        const sdk = props["ro.build.version.sdk"];
        const cpuAbi =
          props["ro.product.cpu.abi"] || props["ro.product.cpu.abilist"]?.split(",")[0];
        const model = props["ro.product.model"] || "";
        const characteristics = props["ro.build.characteristics"] || "";
        const gmsVersion = props["ro.com.google.gmsversion"] || "";
        const hasProps = Object.keys(props).length > 0;
        physicalDevices.push({
          deviceKey: `serial:${dev.serial}`,
          kind: "physical",
          avd: null,
          serial: dev.serial,
          online: true,
          profile: {
            deviceType: hasProps ? inferDeviceType(model, characteristics, characteristics) : null,
            deviceName: model || dev.serial,
            apiLevel: sdk && /^\d+$/.test(sdk) ? `android-${sdk}` : null,
            services: gmsVersion ? "play" : hasProps ? "aosp" : null,
            playStore: gmsVersion ? true : hasProps ? false : null,
            abi: cpuAbi ? cpuAbi.toLowerCase() : null,
          },
          ramSizeMb: 0,
          requiredRamMb: 0,
          dataDiskMb: 0,
          snapshots: [],
        });
      }
    }
  }

  // 4. Query creatable profiles via android emulator create --list-profiles
  let creatable = [];
  const profRes = runner("android", ["emulator", "create", "--list-profiles"], {
    timeoutMs: 8000,
  });
  if (profRes.status === 0 && profRes.stdout) {
    const installedImages = readInstalledSystemImages();
    creatable = parseCreatableProfilesOutput(profRes.stdout, installedImages);
  }

  const running = [];
  const offline = [];
  for (const avd of knownAvds.values()) {
    if (avd.online) {
      running.push(avd);
    } else {
      offline.push(avd);
    }
  }
  running.push(...physicalDevices);

  return {
    host,
    running,
    offline,
    creatable,
  };
}

export function deterministicCreatedAvdId(req) {
  const sanitize = (s, fallback) =>
    String(s || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
  const typeSlug = sanitize(req.deviceType, "phone");
  const apiSlug = sanitize(normalizeApiLevel(req.apiSpec || "36"), "android-36");
  const svcSlug = sanitize(
    req.services || (req.play === false ? "aosp" : "play"),
    "play",
  );
  const abiSlug = sanitize(req.abi, process.arch === "arm64" ? "arm64-v8a" : "x86_64");
  return `atc_${typeSlug}_${apiSlug}_${svcSlug}_${abiSlug}`;
}
