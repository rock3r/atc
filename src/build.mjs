import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { joinBackslashContinuations, parseJavaProperties, splitRcWords } from "./parsers.mjs";

export function canonicalizeBuildPath(targetPath, options = {}) {
  const rawStr = String(targetPath || ".");
  const isWinPath = /^[a-zA-Z]:[\\/]/.test(rawStr) || rawStr.startsWith("\\\\");
  const isWin = (options?.platform || process.platform) === "win32" || isWinPath;
  const resolved =
    isWinPath && process.platform !== "win32"
      ? path.win32.resolve(rawStr)
      : !isWin && process.platform === "win32" && rawStr.startsWith("/")
        ? path.posix.resolve(rawStr)
        : path.resolve(rawStr);
  try {
    if (!isWin && process.platform === "win32" && rawStr.startsWith("/")) {
      return resolved;
    }
    const realpathFn = fs.realpathSync.native || fs.realpathSync;
    return realpathFn(resolved);
  } catch {
    return isWin ? resolved.toLowerCase() : resolved;
  }
}

const LITERAL_SENTINEL = "\uE000";
// Split a process command line (from the OS process table) on whitespace. Returns null when it
// contains quotes, which makes argument boundaries ambiguous.
function splitProcessWords(cmdLine) {
  const s = String(cmdLine || "");
  if (/["']/.test(s)) return null;
  return s.trim().split(/\s+/).filter(Boolean).slice(0, 4096);
}

function stripLiteralSentinels(value) {
  return String(value || "").replaceAll(LITERAL_SENTINEL, "");
}

export function computeColdBuildRamDemandMb(buildReqs, defaultBuildRamMb = 3072) {
  const baseDefaultMb = Math.max(0, Number(defaultBuildRamMb) || 3072);
  return Math.max(baseDefaultMb, buildReqs?.requestedHeapMb || 0);
}

export function normalizeBuildToolName(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const cleaned = stripLiteralSentinels(cmd).trim().replace(/^@+/, "");
  if (/^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*\+?=/i.test(cleaned)) return null;
  const base = (cleaned.split(/[\\/]/).pop() || "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|sh)$/i, "");
  if (base === "gradle" || base === "gradlew") return "gradle";
  if (base === "bazel" || base === "bazelisk" || base === "bazelw") return "bazel";
  if (base === "xcodebuild") return "xcodebuild";
  return null;
}

const NON_DEVICE_INSTALL_RE = /^install(Dist|BootDist|ShadowDist|Maven|ToMavenLocal)$/i;
const NON_DEVICE_CAMEL_INSTALL_RE = /^i(Dist|BD|SD|M|TML)$/;

export function isGradleDeviceTaskName(name) {
  if (!name || typeof name !== "string") return false;
  if (NON_DEVICE_INSTALL_RE.test(name) || NON_DEVICE_CAMEL_INSTALL_RE.test(name)) {
    return false;
  }
  if (
    /^(connected.*AndroidTest|connectedCheck|deviceCheck|allDevicesCheck|uninstall([A-Z0-9_].*)?|install([A-Z0-9_].*)?)$/i.test(
      name,
    )
  ) {
    return true;
  }
  if (/^(c[A-Z0-9]*A[A-Z0-9]*T|cC|dC|aDC|i[A-Z][A-Za-z0-9]*|u[A-Z][A-Za-z0-9]*)$/.test(name)) {
    return true;
  }
  return false;
}

const BAZEL_STARTUP_VALUE_FLAGS = new Set([
  "--output_base",
  "--output_user_root",
  "--install_base",
  "--bazelrc",
  "--max_idle_secs",
  "--connect_timeout_secs",
  "--server_javabase",
]);

const BAZEL_SUBCOMMANDS = new Set([
  "build",
  "test",
  "run",
  "coverage",
  "mobile-install",
  "query",
  "cquery",
  "aquery",
  "fetch",
  "sync",
  "clean",
  "shutdown",
  "version",
  "help",
  "info",
  "dump",
  "config",
  "mod",
  "license",
]);

export function findBazelSubcommandIndex(args = [], allowedSubcommands = BAZEL_SUBCOMMANDS) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (allowedSubcommands.has(a.toLowerCase())) {
      return i;
    }
  }
  return -1;
}

function findNearestMarkerAncestor(startDir, markerFiles) {
  let cur = path.resolve(startDir);
  for (let depth = 0; depth < 32; depth++) {
    for (const marker of markerFiles) {
      try {
        if (fs.existsSync(path.join(cur, marker))) {
          return cur;
        }
      } catch {
        // Ignore stat error
      }
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

function readBazeliskRcUseBazelVersion(rcFilePath) {
  if (!rcFilePath) return null;
  try {
    if (!fs.existsSync(rcFilePath) || !fs.statSync(rcFilePath).isFile()) return null;
    const lines = fs.readFileSync(rcFilePath, "utf8").split(/\r?\n/);
    let found = null;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key !== "USE_BAZEL_VERSION") continue;
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1).trim();
      }
      found = val;
    }
    return found || null;
  } catch {
    return null;
  }
}

function readDotBazelversion(wsRoot) {
  if (!wsRoot) return null;
  try {
    const bvPath = path.join(String(wsRoot), ".bazelversion");
    if (fs.existsSync(bvPath) && fs.statSync(bvPath).isFile()) {
      const firstLine = fs
        .readFileSync(bvPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => Boolean(l) && !l.startsWith("#"));
      return firstLine || null;
    }
  } catch {
    // Ignore unreadable .bazelversion
  }
  return null;
}

function resolveBazeliskVersionSelector(
  wsRoot,
  {
    rawUseBazelVersion = null,
    rawHome = null,
    baseCwd = process.cwd(),
    platform = process.platform,
  } = {},
) {
  if (rawUseBazelVersion) {
    return String(rawUseBazelVersion).trim();
  }
  if (wsRoot) {
    const wsRcVer = readBazeliskRcUseBazelVersion(path.join(String(wsRoot), ".bazeliskrc"));
    if (wsRcVer) return wsRcVer;
  }
  if (rawHome === "__UNRESOLVED_DYNAMIC_ENV__") {
    return "__UNRESOLVED_DYNAMIC_ENV__";
  }
  if (rawHome) {
    const resolvedHome =
      platform === "win32" &&
      (/^[a-zA-Z]:[\\/]/.test(rawHome) || String(rawHome).startsWith("\\\\"))
        ? path.win32.resolve(String(rawHome))
        : path.resolve(baseCwd || process.cwd(), String(rawHome));
    const homeRcPath =
      platform === "win32" &&
      (/^[a-zA-Z]:[\\/]/.test(resolvedHome) || resolvedHome.startsWith("\\\\"))
        ? path.win32.join(resolvedHome, ".bazeliskrc")
        : path.join(resolvedHome, ".bazeliskrc");
    const homeRcVer = readBazeliskRcUseBazelVersion(homeRcPath);
    if (homeRcVer) return homeRcVer;
  }
  return readDotBazelversion(wsRoot);
}

export function resolveBuildResources(
  rawCmd,
  rawArgs = [],
  cwd = process.cwd(),
  {
    forceBuild = false,
    inheritedEnvVars = null,
    env = process.env,
    workspace = null,
    systemBazelrcPath = undefined,
    platform = undefined,
    bazelMajorVersion = undefined,
    bazelVersion = undefined,
    isBazelisk = undefined,
    tool = undefined,
  } = {},
) {
  const baseEnv = { ...(env || process.env), ...(inheritedEnvVars || {}) };
  const outerCwd = path.resolve(cwd || process.cwd());
  const applyExplicitWorkspaceKeys = (res) => {
    if (
      !workspace ||
      !res ||
      res.kind === "deny_lifecycle" ||
      res.kind === "reject_long_running" ||
      res.kind === "read_only"
    ) {
      return res;
    }
    const canonicalExplicitWs = canonicalizeBuildPath(path.resolve(outerCwd, String(workspace)));
    const extraKeys = [`workspace:${canonicalExplicitWs}`];
    if (res.tool === "gradle") {
      const discovered = canonicalizeBuildPath(
        findNearestMarkerAncestor(canonicalExplicitWs, [
          "settings.gradle.kts",
          "settings.gradle",
          "gradlew",
          "gradlew.bat",
        ]) ||
          findNearestMarkerAncestor(canonicalExplicitWs, ["build.gradle.kts", "build.gradle"]) ||
          canonicalExplicitWs,
      );
      extraKeys.push(
        `gradle:${discovered}`,
        `gradle:${canonicalExplicitWs}`,
        `workspace:${discovered}`,
      );
    } else if (res.tool === "bazel") {
      const discovered = canonicalizeBuildPath(
        findNearestMarkerAncestor(canonicalExplicitWs, [
          "MODULE.bazel",
          "REPO.bazel",
          "WORKSPACE.bazel",
          "WORKSPACE",
        ]) || canonicalExplicitWs,
      );
      extraKeys.push(
        `bazel:ws:${discovered}`,
        `bazel:ws:${canonicalExplicitWs}`,
        `workspace:${discovered}`,
      );
    } else if (res.tool === "xcodebuild") {
      let xcodeDiscovered = canonicalExplicitWs;
      let cur = canonicalExplicitWs;
      for (let depth = 0; depth < 16; depth++) {
        try {
          const entries = fs.readdirSync(cur);
          if (entries.some((e) => e.endsWith(".xcworkspace") || e.endsWith(".xcodeproj"))) {
            xcodeDiscovered = canonicalizeBuildPath(cur);
            break;
          }
        } catch {
          break;
        }
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
      extraKeys.push(
        `xcode:${xcodeDiscovered}`,
        `xcode:${canonicalExplicitWs}`,
        `workspace:${xcodeDiscovered}`,
      );
    } else {
      const discovered = canonicalizeBuildPath(
        findNearestMarkerAncestor(canonicalExplicitWs, [
          "settings.gradle.kts",
          "settings.gradle",
          "gradlew",
          "MODULE.bazel",
          "REPO.bazel",
          "WORKSPACE.bazel",
          "WORKSPACE",
          "build.gradle.kts",
          "build.gradle",
        ]) || canonicalExplicitWs,
      );
      extraKeys.push(`workspace:${discovered}`);
    }
    return {
      ...res,
      workspaceRoot: res.workspaceRoot || canonicalExplicitWs,
      resourceKeys: Array.from(new Set([...(res.resourceKeys || []), ...extraKeys])),
    };
  };
  // v3: invocations are literal argv generated by the typed-op catalog (src/ops/catalog.mjs),
  // so there is no wrapper/shell peeling here: the command is the build tool itself.
  const cmd = String(rawCmd || "");
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  const effectiveEnvVars = { ...(inheritedEnvVars || {}) };
  const baseCwd = outerCwd;
  const directTool = tool || normalizeBuildToolName(cmd);
  if (!directTool) {
    return {
      kind: "not_build_tool",
      tool: null,
      targetPlatform: null,
      requiresDevice: false,
      requiresHeavySlot: false,
      requiresWorkspaceLock: false,
      workspaceRoot: null,
      resourceKeys: [],
    };
  }
  let classified = {
    kind: "pure_build",
    tool: directTool,
    targetPlatform: null,
    requiresDevice: false,
    requiresHeavySlot: true,
    requiresWorkspaceLock: true,
    subcommand: directTool === "bazel" ? args.find((a) => !a.startsWith("-")) || null : null,
    tasks: directTool === "gradle" ? args.filter((a) => !a.startsWith("-")) : [],
  };

  const strArgs = args.map((a) => String(a));

  if (classified.tool === "gradle") {
    let projectDir = null;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--") break;
      if ((a === "-p" || a === "--project-dir") && i + 1 < strArgs.length) {
        projectDir = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("--project-dir=")) {
        projectDir = path.resolve(baseCwd, a.slice("--project-dir=".length));
      } else if (a.startsWith("-p=") && a.length > 3) {
        projectDir = path.resolve(baseCwd, a.slice(3));
      }
    }

    let searchStart = projectDir || (workspace ? path.resolve(outerCwd, String(workspace)) : null);
    if (!searchStart && cmd && (cmd.includes("/") || cmd.includes("\\"))) {
      const resolvedCmd = path.resolve(baseCwd, cmd);
      try {
        if (fs.existsSync(resolvedCmd) && fs.statSync(resolvedCmd).isFile()) {
          const cmdDir = path.dirname(resolvedCmd);
          const cmdHasMarker = Boolean(
            findNearestMarkerAncestor(cmdDir, [
              "settings.gradle.kts",
              "settings.gradle",
              "gradlew",
              "gradlew.bat",
              "build.gradle.kts",
              "build.gradle",
            ]),
          );
          if (cmdHasMarker || baseCwd === cmdDir || baseCwd.startsWith(`${cmdDir}${path.sep}`)) {
            searchStart = cmdDir;
          }
        }
      } catch {
        // Fallback to baseCwd
      }
    }
    if (!searchStart) {
      searchStart = baseCwd;
    }

    const rootDir =
      findNearestMarkerAncestor(searchStart, [
        "settings.gradle.kts",
        "settings.gradle",
        "gradlew",
        "gradlew.bat",
      ]) ||
      findNearestMarkerAncestor(searchStart, ["build.gradle.kts", "build.gradle"]) ||
      searchStart;

    const canonicalRoot = canonicalizeBuildPath(rootDir);
    const envJavaHomeUnset =
      effectiveEnvVars.JAVA_HOME === null || effectiveEnvVars.JAVA_HOME === "";
    const envPathUnset =
      effectiveEnvVars.PATH === null || effectiveEnvVars.PATH === "";
    const envGradleUserHomeUnset =
      effectiveEnvVars.GRADLE_USER_HOME === null || effectiveEnvVars.GRADLE_USER_HOME === "";
    const envGradleHomeUnset =
      effectiveEnvVars.GRADLE_HOME === null || effectiveEnvVars.GRADLE_HOME === "";
    const envLcAllUnset =
      effectiveEnvVars.LC_ALL === null || effectiveEnvVars.LC_ALL === "";
    const envLcMessagesUnset =
      effectiveEnvVars.LC_MESSAGES === null || effectiveEnvVars.LC_MESSAGES === "";
    const envLangUnset =
      effectiveEnvVars.LANG === null || effectiveEnvVars.LANG === "";
    let cliGradleUserHome = null;
    let hasCliGradleJvmArgs = false;
    let cliHeapMb = 0;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--") break;
      if ((a === "-g" || a === "--gradle-user-home") && i + 1 < strArgs.length) {
        cliGradleUserHome = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("--gradle-user-home=")) {
        cliGradleUserHome = path.resolve(baseCwd, a.slice("--gradle-user-home=".length));
      } else if (a.startsWith("-Dgradle.user.home=")) {
        cliGradleUserHome = path.resolve(baseCwd, a.slice("-Dgradle.user.home=".length));
      } else if (a.startsWith("-Dorg.gradle.jvmargs=")) {
        hasCliGradleJvmArgs = true;
        cliHeapMb = parseJvmHeapMb(a.slice("-Dorg.gradle.jvmargs=".length));
      }
    }
    const effectiveGradleHomeEnv = envGradleHomeUnset
      ? null
      : effectiveEnvVars.GRADLE_HOME || baseEnv.GRADLE_HOME || null;
    const resolvedGradleHome =
      effectiveGradleHomeEnv && effectiveGradleHomeEnv !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? path.resolve(baseCwd, effectiveGradleHomeEnv)
        : null;
    const effectiveGradleUserHomeEnv = envGradleUserHomeUnset
      ? null
      : effectiveEnvVars.GRADLE_USER_HOME || baseEnv.GRADLE_USER_HOME || null;
    const effectiveHomeEnv =
      effectiveEnvVars.HOME === null || effectiveEnvVars.HOME === ""
        ? null
        : effectiveEnvVars.HOME || baseEnv.HOME || os.homedir() || null;
    const resolvedGradleUserHome =
      cliGradleUserHome ||
      (effectiveGradleUserHomeEnv && effectiveGradleUserHomeEnv !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? path.resolve(baseCwd, effectiveGradleUserHomeEnv)
        : !envGradleUserHomeUnset &&
            effectiveHomeEnv &&
            effectiveHomeEnv !== "__UNRESOLVED_DYNAMIC_ENV__"
          ? path.join(path.resolve(baseCwd, effectiveHomeEnv), ".gradle")
          : null);
    let propsDaemonDisabled = false;
    let propsHeapMb = 0;
    const daemonJvmCriteriaPath = path.join(
      canonicalRoot,
      "gradle",
      "gradle-daemon-jvm.properties",
    );
    try {
      if (
        fs.existsSync(daemonJvmCriteriaPath) &&
        parseJavaProperties(fs.readFileSync(daemonJvmCriteriaPath, "utf8")).size > 0
      ) {
        propsDaemonDisabled = true;
      }
    } catch {
      // Ignore daemon JVM criteria read errors
    }
    const gradlePropsFiles = [
      ...(resolvedGradleHome ? [path.join(resolvedGradleHome, "gradle.properties")] : []),
      path.join(canonicalRoot, "gradle.properties"),
      ...(resolvedGradleUserHome ? [path.join(resolvedGradleUserHome, "gradle.properties")] : []),
    ];
    let propsReadError = false;
    for (const gradlePropsPath of gradlePropsFiles) {
      try {
        if (fs.existsSync(gradlePropsPath)) {
          const propsMap = parseJavaProperties(fs.readFileSync(gradlePropsPath, "utf8"));
          if (propsMap.has("org.gradle.daemon")) {
            propsDaemonDisabled =
              String(propsMap.get("org.gradle.daemon")).trim().toLowerCase() === "false";
          }
          if (propsMap.has("org.gradle.jvmargs")) {
            propsHeapMb = parseJvmHeapMb(propsMap.get("org.gradle.jvmargs"));
          }
        }
      } catch {
        propsReadError = true;
      }
    }
    const envGradleOpts =
      effectiveEnvVars.GRADLE_OPTS === null || effectiveEnvVars.GRADLE_OPTS === ""
        ? null
        : effectiveEnvVars.GRADLE_OPTS || baseEnv.GRADLE_OPTS || null;
    const envJavaOpts =
      effectiveEnvVars.JAVA_OPTS === null || effectiveEnvVars.JAVA_OPTS === ""
        ? null
        : effectiveEnvVars.JAVA_OPTS || baseEnv.JAVA_OPTS || null;
    const envUnderscoreJavaOptions =
      effectiveEnvVars._JAVA_OPTIONS === null || effectiveEnvVars._JAVA_OPTIONS === ""
        ? null
        : effectiveEnvVars._JAVA_OPTIONS || baseEnv._JAVA_OPTIONS || null;
    const envJavaToolOptions =
      effectiveEnvVars.JAVA_TOOL_OPTIONS === null || effectiveEnvVars.JAVA_TOOL_OPTIONS === ""
        ? null
        : effectiveEnvVars.JAVA_TOOL_OPTIONS || baseEnv.JAVA_TOOL_OPTIONS || null;
    const underscoreJavaHeapMb = parseJvmHeapMb(envUnderscoreJavaOptions);
    const optsHeapMb = Math.max(
      parseJvmHeapMb(envGradleOpts),
      parseJvmHeapMb(envJavaOpts),
      underscoreJavaHeapMb,
      parseJvmHeapMb(envJavaToolOptions),
    );
    const requestedHeapMb = Math.max(
      hasCliGradleJvmArgs ? cliHeapMb : propsHeapMb,
      optsHeapMb,
    );
    const disablesDaemon =
      propsDaemonDisabled ||
      propsReadError ||
      Boolean(
        envGradleOpts || envJavaOpts || envUnderscoreJavaOptions || envJavaToolOptions,
      ) ||
      strArgs.some(
        (a) =>
          a === "--no-daemon" ||
          a === "-Dorg.gradle.daemon=false" ||
          a.startsWith("-Dorg.gradle.jvmargs=") ||
          a.startsWith("-Dorg.gradle.java.home=") ||
          a === "--java-home" ||
          a.startsWith("--java-home=") ||
          a === "-g" ||
          a === "--gradle-user-home" ||
          a.startsWith("--gradle-user-home=") ||
          a.startsWith("-Dgradle.user.home="),
      );
    return applyExplicitWorkspaceKeys({
      ...classified,
      disablesDaemon,
      requestedHeapMb,
      gradleHomeDir: resolvedGradleHome,
      envGradleHomeUnset,
      gradleUserHomeDir: resolvedGradleUserHome,
      envJavaHome: envJavaHomeUnset ? "" : effectiveEnvVars.JAVA_HOME || null,
      envJavaHomeUnset,
      envPath: envPathUnset ? "" : effectiveEnvVars.PATH || null,
      envPathUnset,
      envGradleUserHome: envGradleUserHomeUnset ? "" : effectiveEnvVars.GRADLE_USER_HOME || null,
      envGradleUserHomeUnset,
      envLcAll: envLcAllUnset ? "" : effectiveEnvVars.LC_ALL || null,
      envLcAllUnset,
      envLcMessages: envLcMessagesUnset ? "" : effectiveEnvVars.LC_MESSAGES || null,
      envLcMessagesUnset,
      envLang: envLangUnset ? "" : effectiveEnvVars.LANG || null,
      envLangUnset,
      workspaceRoot: canonicalRoot,
      resourceKeys: [`gradle:${canonicalRoot}`],
    });
  }

  if (classified.tool === "bazel") {
    const rootDir =
      findNearestMarkerAncestor(baseCwd, [
        "MODULE.bazel",
        "REPO.bazel",
        "WORKSPACE.bazel",
        "WORKSPACE",
      ]) || baseCwd;
    const canonicalRoot = canonicalizeBuildPath(rootDir);

    let outputBase = null;
    let outputUserRoot = null;
    let batchMode = false;
    let hasCustomStartupOption = false;
    let requestedHeapMb = 0;
    let ignoreAllRc = false;
    let noSystemRc = false;
    let noWorkspaceRc = false;
    let noHomeRc = false;
    const explicitBazelrcPaths = [];

    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if (a === "--ignore_all_rc_files") {
        ignoreAllRc = true;
        continue;
      }
      if (a === "--noignore_all_rc_files") {
        ignoreAllRc = false;
        continue;
      }
      if (a === "--nosystem_rc") {
        noSystemRc = true;
        continue;
      }
      if (a === "--system_rc") {
        noSystemRc = false;
        continue;
      }
      if (a === "--noworkspace_rc") {
        noWorkspaceRc = true;
        continue;
      }
      if (a === "--workspace_rc") {
        noWorkspaceRc = false;
        continue;
      }
      if (a === "--nohome_rc") {
        noHomeRc = true;
        continue;
      }
      if (a === "--home_rc") {
        noHomeRc = false;
        continue;
      }
      if (a === "--bazelrc" && i + 1 < strArgs.length) {
        explicitBazelrcPaths.push(strArgs[++i]);
        continue;
      }
      if (a.startsWith("--bazelrc=")) {
        explicitBazelrcPaths.push(a.slice("--bazelrc=".length));
        continue;
      }
      if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith("-") && BAZEL_SUBCOMMANDS.has(a)) {
        break;
      }
    }

    const resolveBazelPath = (resolveBaseDir, val) => {
      const s = String(val || "");
      const b = String(resolveBaseDir || "");
      if (
        /^[a-zA-Z]:[\\/]/.test(s) ||
        s.startsWith("\\\\") ||
        /^[a-zA-Z]:[\\/]/.test(b) ||
        b.startsWith("\\\\")
      ) {
        return path.win32.resolve(b || ".", s);
      }
      return path.resolve(resolveBaseDir, s);
    };
    const ambiguousOutputBases = new Set();
    const ambiguousOutputUserRoots = new Set();
    const applyStartupOptionTokens = (tokens, resolveBaseDir, { ambiguous = false } = {}) => {
      const expandWs = (val) =>
        String(val || "").replace(/%workspace%/g, canonicalRoot);
      for (let i = 0; i < tokens.length; i++) {
        const a = tokens[i];
        if (a === "--batch") {
          batchMode = true;
          continue;
        }
        if (a === "--nobatch") {
          if (ambiguous) {
            hasCustomStartupOption = true;
          } else {
            batchMode = false;
          }
          continue;
        }
        if (a === "--output_base" && i + 1 < tokens.length) {
          const nextOut = resolveBazelPath(resolveBaseDir, expandWs(tokens[++i]));
          if (ambiguous) {
            if (outputBase && outputBase !== nextOut) ambiguousOutputBases.add(outputBase);
            ambiguousOutputBases.add(nextOut);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputBases.clear();
          }
          outputBase = nextOut;
          continue;
        }
        if (a.startsWith("--output_base=")) {
          const nextOut = resolveBazelPath(
            resolveBaseDir,
            expandWs(a.slice("--output_base=".length)),
          );
          if (ambiguous) {
            if (outputBase && outputBase !== nextOut) ambiguousOutputBases.add(outputBase);
            ambiguousOutputBases.add(nextOut);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputBases.clear();
          }
          outputBase = nextOut;
          continue;
        }
        if (a === "--output_user_root" && i + 1 < tokens.length) {
          const nextRoot = resolveBazelPath(resolveBaseDir, expandWs(tokens[++i]));
          if (ambiguous) {
            if (outputUserRoot && outputUserRoot !== nextRoot) {
              ambiguousOutputUserRoots.add(outputUserRoot);
            }
            ambiguousOutputUserRoots.add(nextRoot);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputUserRoots.clear();
          }
          outputUserRoot = nextRoot;
          continue;
        }
        if (a.startsWith("--output_user_root=")) {
          const nextRoot = resolveBazelPath(
            resolveBaseDir,
            expandWs(a.slice("--output_user_root=".length)),
          );
          if (ambiguous) {
            if (outputUserRoot && outputUserRoot !== nextRoot) {
              ambiguousOutputUserRoots.add(outputUserRoot);
            }
            ambiguousOutputUserRoots.add(nextRoot);
            hasCustomStartupOption = true;
          } else {
            ambiguousOutputUserRoots.clear();
          }
          outputUserRoot = nextRoot;
          continue;
        }
        if (a === "--host_jvm_args" && i + 1 < tokens.length) {
          hasCustomStartupOption = true;
          requestedHeapMb = Math.max(requestedHeapMb, parseJvmHeapMb(tokens[++i]));
          continue;
        }
        if (a.startsWith("--host_jvm_args=")) {
          hasCustomStartupOption = true;
          requestedHeapMb = Math.max(
            requestedHeapMb,
            parseJvmHeapMb(a.slice("--host_jvm_args=".length)),
          );
          continue;
        }
        if (a === "--bazelrc" && i + 1 < tokens.length) {
          i++;
          continue;
        }
        if (
          a.startsWith("--bazelrc=") ||
          a === "--ignore_all_rc_files" ||
          a === "--noignore_all_rc_files" ||
          a === "--nosystem_rc" ||
          a === "--system_rc" ||
          a === "--noworkspace_rc" ||
          a === "--workspace_rc" ||
          a === "--nohome_rc" ||
          a === "--home_rc"
        ) {
          continue;
        }
        if (BAZEL_STARTUP_VALUE_FLAGS.has(a)) {
          hasCustomStartupOption = true;
          i++;
          continue;
        }
        if (!a.startsWith("-") && BAZEL_SUBCOMMANDS.has(a)) {
          break;
        }
        if (a.startsWith("-")) {
          hasCustomStartupOption = true;
        }
      }
    };

    const subcmdIdx = findBazelSubcommandIndex(strArgs, BAZEL_SUBCOMMANDS);
    const subcmd = classified.subcommand
      ? String(classified.subcommand).toLowerCase()
      : subcmdIdx >= 0
        ? strArgs[subcmdIdx].toLowerCase()
        : null;
    const cliRestArgs = subcmdIdx >= 0 ? strArgs.slice(subcmdIdx + 1) : strArgs;
    let rcEntrySeq = 0;
    const rcCommandEntries = [];
    const rcConfigEntriesByName = new Map();
    const getRcCommandRank = (rcCmd, targetSubcmd) => {
      if (!targetSubcmd) return -1;
      if (rcCmd === "always") return 0;
      if (rcCmd === "common") return 1;
      if (
        rcCmd === "build" &&
        [
          "build",
          "test",
          "run",
          "coverage",
          "mobile-install",
          "cquery",
          "aquery",
          "info",
          "sync",
          "fetch",
          "clean",
        ].includes(targetSubcmd)
      ) {
        return targetSubcmd === "build" ? 4 : 2;
      }
      if (rcCmd === "test" && (targetSubcmd === "test" || targetSubcmd === "coverage")) {
        return targetSubcmd === "test" ? 4 : 3;
      }
      if (rcCmd === targetSubcmd) return 4;
      return -1;
    };

    const parseBazelVersionRange = (rawVer) => {
      if (rawVer === null || rawVer === undefined || rawVer === "") return null;
      const s = String(rawVer).trim();
      const m = s.match(
        /^(?:[A-Za-z0-9_.-]+\/)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+][A-Za-z0-9_.-]+)?$/i,
      );
      if (!m) return null;
      const maj = Number(m[1]);
      if (!Number.isFinite(maj) || maj <= 0) return null;
      const hasMin = m[2] !== undefined && m[2].toLowerCase() !== "x" && m[2] !== "*";
      const min = hasMin ? Number(m[2]) : 0;
      const hasPatch =
        hasMin && m[3] !== undefined && m[3].toLowerCase() !== "x" && m[3] !== "*";
      const patch = hasPatch ? Number(m[3]) : 0;
      return {
        major: maj,
        min: [maj, hasMin ? min : 0, hasPatch ? patch : 0],
        max: [
          maj,
          hasMin ? min : Number.MAX_SAFE_INTEGER,
          hasPatch ? patch : Number.MAX_SAFE_INTEGER,
        ],
      };
    };

    const isBazeliskLauncher = (() => {
      if (typeof isBazelisk === "boolean") return isBazelisk;
      const cleanedCmd = stripLiteralSentinels(String(cmd || "")).trim().replace(/^@+/, "");
      const rawCmdLeaf = cleanedCmd.split(/[\\/]/).pop() || "";
      const baseCmd = rawCmdLeaf.toLowerCase().replace(/\.(exe|cmd|bat|com|sh)$/i, "");
      if (baseCmd === "bazelisk" || baseCmd === "bazelw") return true;
      const checkCandidateIsBazelisk = (candidatePath, { requireExecutable = false } = {}) => {
        try {
          if (!fs.existsSync(candidatePath)) {
            return null;
          }
          const st = fs.statSync(candidatePath);
          if (!st.isFile()) {
            return null;
          }
          if (requireExecutable && process.platform !== "win32") {
            if ((st.mode & 0o111) === 0) {
              return null;
            }
            try {
              fs.accessSync(candidatePath, fs.constants.X_OK);
            } catch {
              return null;
            }
          }
          const real = (fs.realpathSync.native || fs.realpathSync)(candidatePath);
          const realBase = (real.split(/[\\/]/).pop() || "")
            .toLowerCase()
            .replace(/\.(exe|cmd|bat|com|sh)$/i, "");
          return (
            realBase.includes("bazelisk") ||
            realBase === "bazelw" ||
            /[\\/]bazelisk[\\/]/i.test(real)
          );
        } catch {
          return null;
        }
      };
      if (baseCmd === "bazel") {
        if (cleanedCmd.includes("/") || cleanedCmd.includes("\\")) {
          return Boolean(checkCandidateIsBazelisk(path.resolve(baseCwd, cleanedCmd)));
        }
        const effPlatform = platform || process.platform;
        if (
          effectiveEnvVars.PATH === "__UNRESOLVED_DYNAMIC_ENV__" ||
          (effPlatform === "win32" && effectiveEnvVars.Path === "__UNRESOLVED_DYNAMIC_ENV__")
        ) {
          return false;
        }
        const rawPathEnv =
          effectiveEnvVars.PATH === null || effectiveEnvVars.PATH === ""
            ? ""
            : effectiveEnvVars.PATH !== undefined
              ? String(effectiveEnvVars.PATH)
              : effPlatform === "win32" &&
                  (effectiveEnvVars.Path === null || effectiveEnvVars.Path === "")
                ? ""
                : effPlatform === "win32" && effectiveEnvVars.Path !== undefined
                  ? String(effectiveEnvVars.Path)
                  : String(
                      baseEnv.PATH ?? (effPlatform === "win32" ? baseEnv.Path : "") ?? "",
                    );
        if (rawPathEnv) {
          const pathSep =
            rawPathEnv.includes(";") ||
            (effPlatform === "win32" && /^[A-Za-z]:[\\/]/.test(rawPathEnv))
              ? ";"
              : ":";
          const exeCandidates =
            effPlatform === "win32" || process.platform === "win32"
              ? Array.from(
                  new Set([rawCmdLeaf || "bazel", "bazel.exe", "bazel.cmd", "bazel.bat", "bazel"]),
                )
              : [rawCmdLeaf || "bazel"];
          for (const rawDir of rawPathEnv.split(pathSep)) {
            const cleanedDir = rawDir.trim().replace(/^"+|"+$/g, "");
            if (!cleanedDir) continue;
            const resolvedDir = path.resolve(baseCwd, cleanedDir);
            for (const exeName of exeCandidates) {
              const res = checkCandidateIsBazelisk(path.join(resolvedDir, exeName), {
                requireExecutable: true,
              });
              if (res !== null) {
                return res;
              }
            }
          }
        }
      }
      return false;
    })();
    const rawUseBazelVersion =
      effectiveEnvVars.USE_BAZEL_VERSION === null || effectiveEnvVars.USE_BAZEL_VERSION === ""
        ? null
        : effectiveEnvVars.USE_BAZEL_VERSION || baseEnv.USE_BAZEL_VERSION || null;
    const effectiveHomeForBazelisk = (() => {
      const effPlatform = platform || process.platform;
      if (effPlatform === "win32") {
        if (
          effectiveEnvVars.HOME === "__UNRESOLVED_DYNAMIC_ENV__" ||
          effectiveEnvVars.USERPROFILE === "__UNRESOLVED_DYNAMIC_ENV__"
        ) {
          return "__UNRESOLVED_DYNAMIC_ENV__";
        }
        return effectiveEnvVars.HOME === null || effectiveEnvVars.HOME === ""
          ? null
          : effectiveEnvVars.HOME !== undefined
            ? String(effectiveEnvVars.HOME)
            : effectiveEnvVars.USERPROFILE === null || effectiveEnvVars.USERPROFILE === ""
              ? null
              : effectiveEnvVars.USERPROFILE !== undefined
                ? String(effectiveEnvVars.USERPROFILE)
                : baseEnv.HOME || baseEnv.USERPROFILE || os.homedir() || null;
      }
      return effectiveEnvVars.HOME === null || effectiveEnvVars.HOME === ""
        ? null
        : effectiveEnvVars.HOME || baseEnv.HOME || os.homedir() || null;
    })();
    const winningBazeliskSelector = isBazeliskLauncher
      ? resolveBazeliskVersionSelector(canonicalRoot, {
          rawUseBazelVersion,
          rawHome: effectiveHomeForBazelisk,
          baseCwd,
          platform: platform || process.platform,
        })
      : null;
    const bazelVersionRange =
      parseBazelVersionRange(bazelVersion) ||
      parseBazelVersionRange(bazelMajorVersion) ||
      (isBazeliskLauncher &&
      winningBazeliskSelector &&
      winningBazeliskSelector !== "__UNRESOLVED_DYNAMIC_ENV__"
        ? parseBazelVersionRange(winningBazeliskSelector)
        : null);

    const rawBazelMajor =
      bazelVersionRange?.major ??
      (bazelMajorVersion !== null && bazelMajorVersion !== undefined && bazelMajorVersion !== ""
        ? Number(bazelMajorVersion)
        : null);
    const effectiveBazelMajor =
      rawBazelMajor !== null && Number.isFinite(rawBazelMajor) && rawBazelMajor > 0
        ? rawBazelMajor
        : null;

    const cmpSemverTuple = (a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    };

    const evaluateBazelVersionCondition = (condStr, range) => {
      const m = String(condStr || "")
        .trim()
        .match(/^(~|==|!=|<=|>=|<|>|=)(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][A-Za-z0-9_.-]+)?$/);
      if (!m || !range) return "ambiguous";
      const op = m[1] === "=" ? "==" : m[1];
      const cMaj = Number(m[2]);
      const hasMin = m[3] !== undefined;
      const cMin = hasMin ? Number(m[3]) : 0;
      const hasPatch = m[4] !== undefined;
      const cPatch = hasPatch ? Number(m[4]) : 0;
      const target = [cMaj, cMin, cPatch];
      const testSingle = (v) => {
        if (op === "==") {
          if (!hasMin) return v[0] === cMaj;
          return cmpSemverTuple(v, target) === 0;
        }
        if (op === "!=") {
          if (!hasMin) return v[0] !== cMaj;
          return cmpSemverTuple(v, target) !== 0;
        }
        if (op === ">=") return cmpSemverTuple(v, target) >= 0;
        if (op === "<=") return cmpSemverTuple(v, target) <= 0;
        if (op === ">") return cmpSemverTuple(v, target) > 0;
        if (op === "<") return cmpSemverTuple(v, target) < 0;
        if (op === "~") {
          if (cmpSemverTuple(v, target) < 0) return false;
          return hasMin ? v[0] === cMaj && v[1] === cMin : v[0] === cMaj;
        }
        return false;
      };
      if (cmpSemverTuple(range.min, range.max) === 0) {
        return testSingle(range.min) ? "true" : "false";
      }
      if (op === "!=") {
        if (!hasMin) {
          if (range.max[0] < cMaj || range.min[0] > cMaj) return "true";
          if (range.min[0] === cMaj && range.max[0] === cMaj) return "false";
          return "ambiguous";
        }
        if (
          cmpSemverTuple(target, range.min) < 0 ||
          cmpSemverTuple(target, range.max) > 0
        ) {
          return "true";
        }
        return "ambiguous";
      }
      const minSat = testSingle(range.min);
      const maxSat = testSingle(range.max);
      if (minSat && maxSat) return "true";
      if (!minSat && !maxSat) {
        const targetInsideRange =
          cmpSemverTuple(target, range.min) >= 0 && cmpSemverTuple(target, range.max) <= 0;
        if (!targetInsideRange) return "false";
      }
      return "ambiguous";
    };

    const effectiveHostPlatform = platform || process.platform;
    const hostBazelOsName =
      effectiveHostPlatform === "darwin"
        ? "macos"
        : effectiveHostPlatform === "win32"
          ? "windows"
          : effectiveHostPlatform === "linux"
            ? "linux"
            : effectiveHostPlatform === "freebsd"
              ? "freebsd"
              : effectiveHostPlatform === "openbsd"
                ? "openbsd"
                : null;
    const BAZEL_KNOWN_STARTUP_OS_NAMES = new Set([
      "linux",
      "macos",
      "windows",
      "freebsd",
      "openbsd",
      "unknown",
    ]);

    if (!ignoreAllRc) {
      const seenTopLevelRcs = new Set();
      const rcUnqualifiedStartupGroups = [];
      const rcOsStartupGroups = [];
      const parseBazelrcFile = (
        rcPath,
        {
          required = false,
          depth = 0,
          activeStack = new Set(),
          ambiguousCondition = false,
        } = {},
      ) => {
        if (!rcPath || rcPath === "/dev/null" || rcPath.toUpperCase() === "NUL") return;
        if (depth > 8) {
          hasCustomStartupOption = true;
          return;
        }
        const resolvedRc = canonicalizeBuildPath(rcPath, { platform });
        if (depth === 0 && seenTopLevelRcs.has(resolvedRc)) {
          return;
        }
        if (activeStack.has(resolvedRc)) {
          hasCustomStartupOption = true;
          return;
        }
        let content;
        try {
          if (!fs.existsSync(resolvedRc)) {
            if (required) hasCustomStartupOption = true;
            return;
          }
          content = fs.readFileSync(resolvedRc, "utf8");
        } catch {
          if (required) hasCustomStartupOption = true;
          return;
        }
        if (depth === 0) {
          seenTopLevelRcs.add(resolvedRc);
        }
        const nextStack = new Set(activeStack);
        nextStack.add(resolvedRc);
        for (const rawLine of joinBackslashContinuations(content)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const condImportMatch = line.match(/^try-import-if-bazel-version\s+(\S+)\s+(.+)$/);
          if (condImportMatch) {
            const condStr = condImportMatch[1];
            const evalRes = evaluateBazelVersionCondition(condStr, bazelVersionRange);
            if (evalRes === "false") {
              continue;
            }
            const rawTarget = condImportMatch[2]
              .trim()
              .replace(/^['"]|['"]$/g, "")
              .replace(/%workspace%/g, canonicalRoot);
            const targetPath = resolveBazelPath(baseCwd, rawTarget);
            parseBazelrcFile(targetPath, {
              required: false,
              depth: depth + 1,
              activeStack: nextStack,
              ambiguousCondition: ambiguousCondition || evalRes === "ambiguous",
            });
            continue;
          }
          const importMatch = line.match(/^(import|try-import)\s+(.+)$/);
          if (importMatch) {
            const isRequiredImport = importMatch[1] === "import";
            const rawTarget = importMatch[2]
              .trim()
              .replace(/^['"]|['"]$/g, "")
              .replace(/%workspace%/g, canonicalRoot);
            const targetPath = resolveBazelPath(baseCwd, rawTarget);
            parseBazelrcFile(targetPath, {
              required: isRequiredImport,
              depth: depth + 1,
              activeStack: nextStack,
              ambiguousCondition,
            });
            continue;
          }
          const startupMatch = line.match(/^startup(?::([A-Za-z0-9_.-]+))?\s+(.+)$/);
          if (startupMatch) {
            const startupConfig = startupMatch[1] ? startupMatch[1].toLowerCase() : null;
            if (startupConfig) {
              if (hostBazelOsName && startupConfig === hostBazelOsName) {
                rcOsStartupGroups.push({
                  tokens: splitRcWords(startupMatch[2]),
                  baseDir: canonicalRoot,
                  ambiguous: ambiguousCondition,
                });
              } else if (!BAZEL_KNOWN_STARTUP_OS_NAMES.has(startupConfig)) {
                hasCustomStartupOption = true;
              }
              continue;
            }
            rcUnqualifiedStartupGroups.push({
              tokens: splitRcWords(startupMatch[2]),
              baseDir: canonicalRoot,
              ambiguous: ambiguousCondition,
            });
            continue;
          }
          const cmdMatch = line.match(/^([A-Za-z0-9_.-]+)(?::([A-Za-z0-9_.-]+))?\s+(.+)$/);
          if (cmdMatch) {
            const rcCmd = cmdMatch[1].toLowerCase();
            const rcConfig = cmdMatch[2] || null;
            const rank = getRcCommandRank(rcCmd, subcmd);
            if (rank >= 0) {
              const tokens = splitRcWords(cmdMatch[3]).map((t) =>
                String(t).replace(/%workspace%/g, canonicalRoot),
              );
              const entry = { rank, seq: rcEntrySeq++, tokens };
              if (!rcConfig) {
                rcCommandEntries.push(entry);
              } else {
                const prev = rcConfigEntriesByName.get(rcConfig) || [];
                prev.push(entry);
                rcConfigEntriesByName.set(rcConfig, prev);
              }
            }
          }
        }
      };

      if (!noSystemRc) {
        const effectivePlatform = platform || process.platform;
        const resolvedSystemRc =
          systemBazelrcPath !== undefined
            ? systemBazelrcPath
            : effectivePlatform === "win32"
              ? (() => {
                  const progData =
                    effectiveEnvVars.ProgramData ||
                    effectiveEnvVars.PROGRAMDATA ||
                    baseEnv.ProgramData ||
                    baseEnv.PROGRAMDATA ||
                    "C:\\ProgramData";
                  return progData.includes("\\") || /^[A-Za-z]:/.test(progData)
                    ? path.win32.join(progData, "bazel.bazelrc")
                    : path.join(progData, "bazel.bazelrc");
                })()
              : "/etc/bazel.bazelrc";
        if (resolvedSystemRc) {
          parseBazelrcFile(resolvedSystemRc, { required: false });
        }
      }
      if (!noWorkspaceRc) {
        parseBazelrcFile(path.join(canonicalRoot, ".bazelrc"), { required: false });
      }
      const effectiveHomeForBazel =
        effectiveEnvVars.HOME === null || effectiveEnvVars.HOME === ""
          ? null
          : effectiveEnvVars.HOME || baseEnv.HOME || os.homedir() || null;
      if (
        !noHomeRc &&
        effectiveHomeForBazel &&
        effectiveHomeForBazel !== "__UNRESOLVED_DYNAMIC_ENV__"
      ) {
        parseBazelrcFile(path.join(path.resolve(baseCwd, effectiveHomeForBazel), ".bazelrc"), {
          required: false,
        });
      }
      const effectiveBazelrcEnv =
        effectiveEnvVars.BAZELRC === null || effectiveEnvVars.BAZELRC === ""
          ? null
          : effectiveEnvVars.BAZELRC !== undefined
            ? String(effectiveEnvVars.BAZELRC)
            : baseEnv.BAZELRC
              ? String(baseEnv.BAZELRC)
              : null;
      if (effectiveBazelMajor === null || effectiveBazelMajor >= 9) {
        if (effectiveBazelrcEnv === "__UNRESOLVED_DYNAMIC_ENV__") {
          hasCustomStartupOption = true;
        } else if (effectiveBazelrcEnv) {
          if (effectiveBazelMajor === null) {
            hasCustomStartupOption = true;
          }
          for (const rawEnvRc of effectiveBazelrcEnv.split(",")) {
            if (!rawEnvRc) continue;
            if (rawEnvRc === "/dev/null" || rawEnvRc.toUpperCase() === "NUL") {
              break;
            }
            const expandedRc = String(rawEnvRc).replace(/%workspace%/g, canonicalRoot);
            parseBazelrcFile(resolveBazelPath(baseCwd, expandedRc), { required: true });
          }
        }
      }
      for (const rawExplicitRc of explicitBazelrcPaths) {
        if (rawExplicitRc === "/dev/null" || rawExplicitRc.toUpperCase() === "NUL") break;
        const expandedRc = String(rawExplicitRc).replace(/%workspace%/g, canonicalRoot);
        parseBazelrcFile(resolveBazelPath(baseCwd, expandedRc), { required: true });
      }
      for (const grp of rcUnqualifiedStartupGroups) {
        applyStartupOptionTokens(grp.tokens, grp.baseDir, { ambiguous: grp.ambiguous });
      }
      for (const grp of rcOsStartupGroups) {
        applyStartupOptionTokens(grp.tokens, grp.baseDir, { ambiguous: grp.ambiguous });
      }
    }

    if (subcmd && (rcCommandEntries.length > 0 || rcConfigEntriesByName.size > 0)) {
      const flattenSortedEntries = (entries) =>
        [...(entries || [])]
          .sort((a, b) => a.rank - b.rank || a.seq - b.seq)
          .flatMap((e) => e.tokens);
      const rcCommandTokens = flattenSortedEntries(rcCommandEntries);
      const rcConfigTokensByName = new Map();
      for (const [k, entries] of rcConfigEntriesByName.entries()) {
        rcConfigTokensByName.set(k, flattenSortedEntries(entries));
      }
      const expandConfigTokens = (tokens, depth = 0, activeStack = new Set()) => {
        if (depth > 8) return [];
        const out = [];
        for (let i = 0; i < tokens.length; i++) {
          const tok = String(tokens[i] || "");
          if (tok === "--") break;
          let cfgName = null;
          if (tok === "--config" && i + 1 < tokens.length) {
            cfgName = String(tokens[++i] || "");
          } else if (tok.startsWith("--config=")) {
            cfgName = tok.slice("--config=".length);
          }
          if (cfgName !== null) {
            out.push(`--config=${cfgName}`);
            if (cfgName && !activeStack.has(cfgName) && rcConfigTokensByName.has(cfgName)) {
              const nextStack = new Set(activeStack);
              nextStack.add(cfgName);
              out.push(
                ...expandConfigTokens(
                  rcConfigTokensByName.get(cfgName) || [],
                  depth + 1,
                  nextStack,
                ),
              );
            }
            continue;
          }
          out.push(tok);
        }
        return out;
      };
      const cliBeforeDashDash = (() => {
        const idx = cliRestArgs.indexOf("--");
        return idx >= 0 ? cliRestArgs.slice(0, idx) : cliRestArgs;
      })();
      const expandedFromRc = expandConfigTokens(rcCommandTokens);
      const expandedFromCli = expandConfigTokens(cliBeforeDashDash);
      const allEffectiveFlags = [...expandedFromRc, ...expandedFromCli];
      const isFalseVal = (v) => /^(?:false|0|no|f|n)$/i.test(String(v || "").trim());
      let platformConfigEnabled = false;
      for (const tok of allEffectiveFlags) {
        if (tok === "--enable_platform_specific_config") platformConfigEnabled = true;
        else if (tok === "--noenable_platform_specific_config") platformConfigEnabled = false;
        else if (tok.startsWith("--enable_platform_specific_config=")) {
          platformConfigEnabled = !isFalseVal(
            tok.slice("--enable_platform_specific_config=".length),
          );
        }
      }
      const effectivePlatform = platform || process.platform;
      const osConfigName =
        effectivePlatform === "darwin"
          ? "macos"
          : effectivePlatform === "win32"
            ? "windows"
            : effectivePlatform === "linux"
              ? "linux"
              : null;
      const osConfigTokens =
        platformConfigEnabled && osConfigName && rcConfigTokensByName.has(osConfigName)
          ? expandConfigTokens(
              rcConfigTokensByName.get(osConfigName) || [],
              1,
              new Set([osConfigName]),
            )
          : [];
      const effectiveBazelCommandArgs = [
        subcmd,
        ...expandedFromRc.filter((t) => t !== "--"),
        ...osConfigTokens.filter((t) => t !== "--"),
        ...expandedFromCli.filter((t) => t !== "--"),
        ...(cliRestArgs.includes("--") ? cliRestArgs.slice(cliRestArgs.indexOf("--")) : []),
      ];
      classified = { ...classified, effectiveBazelArgs: effectiveBazelCommandArgs };
    }

    applyStartupOptionTokens(strArgs, baseCwd);
    const hasUseBazelVersion = Boolean(
      effectiveEnvVars.USE_BAZEL_VERSION === null || effectiveEnvVars.USE_BAZEL_VERSION === ""
        ? null
        : effectiveEnvVars.USE_BAZEL_VERSION || baseEnv.USE_BAZEL_VERSION || null,
    );
    const disablesDaemon = batchMode || hasCustomStartupOption || hasUseBazelVersion;

    const canonicalUserRoot = outputUserRoot
      ? canonicalizeBuildPath(outputUserRoot, { platform })
      : null;
    const resourceKeys = [`bazel:ws:${canonicalRoot}`];
    if (outputBase) {
      resourceKeys.push(`bazel:out:${canonicalizeBuildPath(outputBase, { platform })}`);
    } else if (canonicalUserRoot) {
      const wsMd5 = crypto.createHash("md5").update(canonicalRoot).digest("hex");
      resourceKeys.push(`bazel:out:${path.join(canonicalUserRoot, wsMd5)}`);
    }
    for (const ambOut of ambiguousOutputBases) {
      const key = `bazel:out:${canonicalizeBuildPath(ambOut, { platform })}`;
      if (!resourceKeys.includes(key)) resourceKeys.push(key);
    }
    if (ambiguousOutputUserRoots.size > 0) {
      const wsMd5 = crypto.createHash("md5").update(canonicalRoot).digest("hex");
      for (const ambRoot of ambiguousOutputUserRoots) {
        const canonAmbRoot = canonicalizeBuildPath(ambRoot, { platform });
        const key = `bazel:out:${path.join(canonAmbRoot, wsMd5)}`;
        if (!resourceKeys.includes(key)) resourceKeys.push(key);
      }
    }
    const resolvedBazelMajorVersion = effectiveBazelMajor ?? bazelMajorVersion;
    const bazelEnvMeta = {
      baseCwd,
      platform: platform || process.platform,
      isBazelisk: isBazeliskLauncher,
      bazelMajorVersion: resolvedBazelMajorVersion,
      envBazelUseBazelVersion: effectiveEnvVars.USE_BAZEL_VERSION,
      envBazelTestTmpdir: effectiveEnvVars.TEST_TMPDIR,
      envBazelUser: effectiveEnvVars.USER,
      envBazelUsername: effectiveEnvVars.USERNAME,
      envBazelHome: effectiveEnvVars.HOME,
      envBazelUserProfile: effectiveEnvVars.USERPROFILE,
      envBazelXdgCacheHome: effectiveEnvVars.XDG_CACHE_HOME,
    };
    return applyExplicitWorkspaceKeys({
      ...classified,
      ...bazelEnvMeta,
      disablesDaemon,
      requestedHeapMb,
      bazelOutputUserRoot: canonicalUserRoot,
      defaultBazelOutputBases: computeDefaultBazelOutputBases(canonicalRoot, {
        buildReqs: bazelEnvMeta,
        env: baseEnv,
        platform: platform || process.platform,
        isBazelisk: isBazeliskLauncher,
        bazelMajorVersion: resolvedBazelMajorVersion,
      }),
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    });
  }

  if (classified.tool === "xcodebuild") {
    let explicitTargetPath = null;
    let derivedDataPath = null;
    for (let i = 0; i < strArgs.length; i++) {
      const a = strArgs[i];
      if ((a === "-workspace" || a === "-project") && i + 1 < strArgs.length) {
        explicitTargetPath = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("-workspace=")) {
        explicitTargetPath = path.resolve(baseCwd, a.slice("-workspace=".length));
      } else if (a.startsWith("-project=")) {
        explicitTargetPath = path.resolve(baseCwd, a.slice("-project=".length));
      } else if (a === "-derivedDataPath" && i + 1 < strArgs.length) {
        derivedDataPath = path.resolve(baseCwd, strArgs[++i]);
      } else if (a.startsWith("-derivedDataPath=")) {
        derivedDataPath = path.resolve(baseCwd, a.slice("-derivedDataPath=".length));
      }
    }

    let rootDir = explicitTargetPath ? path.dirname(explicitTargetPath) : null;
    if (!rootDir) {
      let cur = baseCwd;
      for (let depth = 0; depth < 16; depth++) {
        try {
          const entries = fs.readdirSync(cur);
          if (entries.some((e) => e.endsWith(".xcworkspace") || e.endsWith(".xcodeproj"))) {
            rootDir = cur;
            break;
          }
        } catch {
          break;
        }
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        cur = parent;
      }
    }
    const canonicalRoot = canonicalizeBuildPath(rootDir || baseCwd);
    const resourceKeys = [`xcode:${canonicalRoot}`];
    if (derivedDataPath) {
      resourceKeys.push(`xcode:dd:${canonicalizeBuildPath(derivedDataPath)}`);
    }
    return applyExplicitWorkspaceKeys({
      ...classified,
      workspaceRoot: canonicalRoot,
      resourceKeys: Array.from(new Set(resourceKeys)),
    });
  }

  return applyExplicitWorkspaceKeys({
    ...classified,
    workspaceRoot: null,
    resourceKeys: [],
  });
}

function parseJvmHeapMb(str) {
  if (!str) return 0;
  let lastMaxHeapMb = 0;
  let lastInitHeapMb = 0;
  const re = /-(Xmx|Xms|XX:(?:Max|Initial|Min)HeapSize=)(\d+(?:\.\d+)?)([kKmMgGtT])?\b/g;
  let m;
  while ((m = re.exec(String(str))) !== null) {
    const kind = m[1];
    const num = Number(m[2]);
    if (!Number.isFinite(num) || num <= 0) continue;
    const unit = (m[3] || "").toLowerCase();
    let mb = 0;
    if (unit === "t") mb = Math.ceil(num * 1024 * 1024);
    else if (unit === "g") mb = Math.ceil(num * 1024);
    else if (unit === "m") mb = Math.ceil(num);
    else if (unit === "k") mb = Math.ceil(num / 1024);
    else mb = Math.ceil(num / (1024 * 1024));
    if (kind === "Xmx" || kind === "XX:MaxHeapSize=") {
      lastMaxHeapMb = mb;
    } else {
      lastInitHeapMb = mb;
    }
  }
  return Math.max(lastMaxHeapMb, lastInitHeapMb);
}

function parseJvmSizeBytes(rawVal) {
  const m = String(rawVal || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)([kKmMgGtT])?$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "t") return Math.round(num * 1024 * 1024 * 1024 * 1024);
  if (unit === "g") return Math.round(num * 1024 * 1024 * 1024);
  if (unit === "m") return Math.round(num * 1024 * 1024);
  if (unit === "k") return Math.round(num * 1024);
  return Math.round(num);
}

function normalizeGradleCompatJvmArgs(args) {
  const keyed = new Map();
  const positional = [];
  for (const rawTok of args || []) {
    const tok = String(rawTok || "").trim();
    if (!tok) continue;
    if (tok.startsWith("-Xmx") || tok.startsWith("-XX:MaxHeapSize=")) {
      const val = tok.startsWith("-Xmx") ? tok.slice(4) : tok.slice("-XX:MaxHeapSize=".length);
      const bytes = parseJvmSizeBytes(val);
      keyed.set("max_heap", bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (
      tok.startsWith("-Xms") ||
      tok.startsWith("-XX:InitialHeapSize=") ||
      tok.startsWith("-XX:MinHeapSize=")
    ) {
      const val = tok.startsWith("-Xms") ? tok.slice(4) : tok.slice(tok.indexOf("=") + 1);
      const bytes = parseJvmSizeBytes(val);
      keyed.set("min_heap", bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (tok.startsWith("-Xss") || tok.startsWith("-XX:ThreadStackSize=")) {
      const val = tok.startsWith("-Xss")
        ? tok.slice(4)
        : tok.slice("-XX:ThreadStackSize=".length);
      const bytes = parseJvmSizeBytes(val);
      keyed.set("stack_size", bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (tok.startsWith("-XX:+") || tok.startsWith("-XX:-")) {
      const sign = tok[4];
      const flagName = tok.slice(5);
      keyed.set(`xx:${flagName}`, sign === "+" ? "true" : "false");
    } else if (tok.startsWith("-XX:") && tok.includes("=")) {
      const eqIdx = tok.indexOf("=");
      const optName = tok.slice(4, eqIdx);
      const val = tok.slice(eqIdx + 1);
      const bytes = /Size$/i.test(optName) ? parseJvmSizeBytes(val) : null;
      keyed.set(`xx:${optName}`, bytes !== null ? `bytes:${bytes}` : `raw:${val}`);
    } else if (tok.startsWith("-D")) {
      const eqIdx = tok.indexOf("=");
      const propKey = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
      let propVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : "";
      if (propKey === "file.encoding" && /^utf-?8$/i.test(propVal)) {
        propVal = "UTF-8";
      }
      keyed.set(`prop:${propKey}`, propVal);
    } else if (tok === "-ea" || tok === "-enableassertions") {
      keyed.set("assert:user", "true");
    } else if (tok === "-da" || tok === "-disableassertions") {
      keyed.set("assert:user", "false");
    } else if (tok.startsWith("-ea:") || tok.startsWith("-enableassertions:")) {
      const target = tok.slice(tok.indexOf(":") + 1);
      keyed.set(`assert:pkg:${target}`, "true");
    } else if (tok.startsWith("-da:") || tok.startsWith("-disableassertions:")) {
      const target = tok.slice(tok.indexOf(":") + 1);
      keyed.set(`assert:pkg:${target}`, "false");
    } else if (tok === "-esa" || tok === "-enablesystemassertions") {
      keyed.set("assert:sys", "true");
    } else if (tok === "-dsa" || tok === "-disablesystemassertions") {
      keyed.set("assert:sys", "false");
    } else {
      positional.push(tok);
    }
  }
  return { keyed, positional };
}

function resolveDefaultGradleLocaleProps(env = null) {
  const effectiveEnv = env || process.env || {};
  const hasExplicitLocaleKeys =
    env && ("LC_ALL" in env || "LC_MESSAGES" in env || "LANG" in env);
  const rawLocale = hasExplicitLocaleKeys
    ? effectiveEnv.LC_ALL || effectiveEnv.LC_MESSAGES || effectiveEnv.LANG || "C.UTF-8"
    : effectiveEnv.LC_ALL ||
      effectiveEnv.LC_MESSAGES ||
      effectiveEnv.LANG ||
      process.env.LC_ALL ||
      process.env.LC_MESSAGES ||
      process.env.LANG ||
      "";
  const parsePosixLocale = (raw) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    if (/^(?:C|POSIX)(?:\.(.+))?$/i.test(trimmed)) {
      const encRaw = trimmed.includes(".") ? trimmed.slice(trimmed.indexOf(".") + 1) : "UTF-8";
      const encoding = /^utf-?8$/i.test(encRaw) ? "UTF-8" : encRaw.toUpperCase();
      return { language: "en", country: "US", variant: "", encoding };
    }
    const m = trimmed.match(
      /^([a-zA-Z]{2,3})(?:[_-]([a-zA-Z]{2}|\d{3}))?(?:\.([^@]+))?(?:@(.+))?$/,
    );
    if (!m) return null;
    const encRaw = m[3] || "UTF-8";
    const encoding = /^utf-?8$/i.test(encRaw) ? "UTF-8" : encRaw.toUpperCase();
    return {
      language: m[1].toLowerCase(),
      country: (m[2] || "").toUpperCase(),
      variant: m[4] || "",
      encoding,
    };
  };
  const parsed = parsePosixLocale(rawLocale);
  if (parsed) {
    return parsed;
  }
  try {
    const intlLoc = Intl.DateTimeFormat().resolvedOptions().locale || "";
    const im = intlLoc.match(/^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z]{2}|\d{3}))?/);
    if (im) {
      return {
        language: im[1].toLowerCase(),
        country: (im[2] || "US").toUpperCase(),
        variant: "",
        encoding: "UTF-8",
      };
    }
  } catch {
    // Ignore Intl errors
  }
  return { language: "en", country: "US", variant: "", encoding: "UTF-8" };
}

function stripDefaultGradleDaemonJvmArgs(daemonNorm, expectedNorm, env = null) {
  const keyed = new Map(daemonNorm.keyed);
  const defaultLocale = resolveDefaultGradleLocaleProps(env);
  if (
    !expectedNorm.keyed.has("xx:HeapDumpOnOutOfMemoryError") &&
    keyed.get("xx:HeapDumpOnOutOfMemoryError") === "true"
  ) {
    keyed.delete("xx:HeapDumpOnOutOfMemoryError");
  }
  if (
    !expectedNorm.keyed.has("max_heap") &&
    !expectedNorm.keyed.has("min_heap") &&
    !expectedNorm.keyed.has("xx:MaxMetaspaceSize") &&
    keyed.get("max_heap") === "bytes:536870912" &&
    keyed.get("xx:MaxMetaspaceSize") === "bytes:402653184" &&
    (!keyed.has("min_heap") || keyed.get("min_heap") === "bytes:268435456")
  ) {
    keyed.delete("max_heap");
    keyed.delete("xx:MaxMetaspaceSize");
    keyed.delete("min_heap");
  }
  if (
    !expectedNorm.keyed.has("prop:file.encoding") &&
    keyed.has("prop:file.encoding") &&
    String(keyed.get("prop:file.encoding") || "").toUpperCase() === defaultLocale.encoding
  ) {
    keyed.delete("prop:file.encoding");
  }
  if (
    !expectedNorm.keyed.has("prop:user.country") &&
    keyed.has("prop:user.country") &&
    String(keyed.get("prop:user.country") || "").toUpperCase() === defaultLocale.country
  ) {
    keyed.delete("prop:user.country");
  }
  if (
    !expectedNorm.keyed.has("prop:user.language") &&
    keyed.has("prop:user.language") &&
    String(keyed.get("prop:user.language") || "").toLowerCase() === defaultLocale.language
  ) {
    keyed.delete("prop:user.language");
  }
  if (
    !expectedNorm.keyed.has("prop:user.variant") &&
    keyed.has("prop:user.variant") &&
    String(keyed.get("prop:user.variant") || "") === defaultLocale.variant
  ) {
    keyed.delete("prop:user.variant");
  }
  for (const sysProp of [
    "prop:java.io.tmpdir",
    "prop:sun.io.unicode.encoding",
    "prop:sun.jnu.encoding",
  ]) {
    if (!expectedNorm.keyed.has(sysProp) && keyed.has(sysProp)) {
      keyed.delete(sysProp);
    }
  }
  return { keyed, positional: [...daemonNorm.positional] };
}

function gradleCompatNormEqual(exp, dmn) {
  if (exp.keyed.size !== dmn.keyed.size) return false;
  for (const [k, v] of exp.keyed.entries()) {
    if (!dmn.keyed.has(k) || dmn.keyed.get(k) !== v) return false;
  }
  if (exp.positional.length !== dmn.positional.length) return false;
  for (let i = 0; i < exp.positional.length; i++) {
    if (exp.positional[i] !== dmn.positional[i]) return false;
  }
  return true;
}

function splitJvmArgTokens(rawStr) {
  if (!rawStr) return [];
  const unescaped = String(rawStr)
    .trim()
    .replace(/\\([:=])/g, "$1");
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < unescaped.length; i++) {
    const ch = unescaped[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function computeEffectiveMaxBuilds(cfg = {}, host = null) {
  const rawMax = cfg?.maxConcurrentBuilds;
  if (typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax >= 1) {
    return rawMax;
  }
  if (typeof rawMax === "string" && /^\d+$/.test(rawMax.trim()) && Number(rawMax) >= 1) {
    return Number(rawMax);
  }
  const cores = host?.cpuCores || os.availableParallelism();
  const totalRamMb = host?.totalRamMb || Math.round(os.totalmem() / (1024 * 1024));
  const totalRamGb = totalRamMb / 1024;
  const cpuBound = Math.max(1, Math.floor(cores / 4));
  const ramBound = totalRamGb < 24 ? 1 : totalRamGb < 48 ? 2 : totalRamGb < 96 ? 3 : 4;
  return Math.max(1, Math.min(4, cpuBound, ramBound));
}

export function computeBuildPoolSnapshot(state, host = null) {
  const cfg = state?.config || {};
  const activeWorkspaces = new Set();
  let activeHeavyBuilds = 0;
  let activeTotalBuilds = 0;

  for (const bLease of Object.values(state?.buildLeases || {})) {
    if (!bLease || (bLease.state !== "active" && bLease.state !== "draining")) continue;
    activeTotalBuilds++;
    if (bLease.requiresHeavySlot) {
      activeHeavyBuilds++;
    }
    for (const key of bLease.resourceKeys || []) {
      activeWorkspaces.add(key);
    }
  }

  const baseMaxBuilds = computeEffectiveMaxBuilds(cfg, host);
  const burstBuilds = Math.max(0, Number(cfg.maxDeviceHolderBurstBuilds ?? 1));
  return {
    activeWorkspaces,
    lockedWorkspaces: activeWorkspaces,
    activeHeavyBuilds,
    usedBuildSlots: activeHeavyBuilds,
    activeTotalBuilds,
    baseMaxBuilds,
    burstBuilds,
    burstSlots: burstBuilds,
    effectiveMaxBuilds: baseMaxBuilds,
    totalCapacity: baseMaxBuilds + burstBuilds,
  };
}

export function hasValidPinnedDeviceLease(ticket, leasesByDeviceKey = {}) {
  if (!ticket || (!ticket.pinnedDeviceKey && !ticket.pinnedDeviceLeaseId)) return false;
  if (ticket.pinnedDeviceKey && leasesByDeviceKey[ticket.pinnedDeviceKey]) {
    const lease = leasesByDeviceKey[ticket.pinnedDeviceKey];
    return Boolean(
      lease &&
        (!ticket.pinnedDeviceLeaseId || lease.leaseId === ticket.pinnedDeviceLeaseId) &&
        lease.sessionId === ticket.sessionId &&
        lease.state === "active" &&
        lease.firstSeenOfflineAtMs == null,
    );
  }
  if (ticket.pinnedDeviceLeaseId) {
    for (const lease of Object.values(leasesByDeviceKey || {})) {
      if (
        lease &&
        lease.leaseId === ticket.pinnedDeviceLeaseId &&
        lease.sessionId === ticket.sessionId &&
        lease.state === "active" &&
        lease.firstSeenOfflineAtMs == null
      ) {
        return true;
      }
    }
  }
  return false;
}

export function extractBuildResourceKeyInfo(keyStr) {
  const s = String(keyStr || "");
  const firstColon = s.indexOf(":");
  if (firstColon === -1) return { prefix: s, path: "" };
  const prefix = s.slice(0, firstColon);
  const rest = s.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (
    secondColon !== -1 &&
    ["ws", "out", "dir", "dd"].includes(rest.slice(0, secondColon))
  ) {
    return {
      prefix: `${prefix}:${rest.slice(0, secondColon)}`,
      path: rest.slice(secondColon + 1),
    };
  }
  return { prefix, path: rest };
}

export function doBuildResourceKeysConflict(keyA, keyB) {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  const a = extractBuildResourceKeyInfo(keyA);
  const b = extractBuildResourceKeyInfo(keyB);
  if (!a.path || !b.path) return false;
  const isWinPath =
    process.platform === "win32" ||
    /^[a-zA-Z]:[\\/]/.test(a.path) ||
    /^[a-zA-Z]:[\\/]/.test(b.path) ||
    a.path.startsWith("\\\\") ||
    b.path.startsWith("\\\\");
  const normA = isWinPath ? a.path.replace(/\//g, "\\").toLowerCase() : a.path;
  const normB = isWinPath ? b.path.replace(/\//g, "\\").toLowerCase() : b.path;
  if (a.prefix === b.prefix && normA === normB) return true;
  if (a.prefix === "workspace" || b.prefix === "workspace") {
    return (
      normA === normB ||
      normA.startsWith(`${normB}/`) ||
      normA.startsWith(`${normB}\\`) ||
      normB.startsWith(`${normA}/`) ||
      normB.startsWith(`${normA}\\`)
    );
  }
  return false;
}

export function pruneAndSelectNextBuildTicket(
  queue,
  stateView,
  now,
  {
    reorderWindowMs = 120_000,
    hbTimeoutMs = 10_000,
    livenessCheck = () => true,
    currentTicketId = null,
  } = {},
) {
  const activeWorkspaces = stateView.activeWorkspaces || new Set();
  const activeHeavyBuilds = stateView.activeHeavyBuilds ?? 0;
  const maxHostBuilds = stateView.maxHostBuilds ?? 1;
  const burstBuilds = Math.max(0, Number(stateView.burstBuilds ?? 0));
  const leases = stateView.leases || {};
  const pruned = [];

  for (let i = queue.length - 1; i >= 0; i--) {
    const t = queue[i];
    if (!t || typeof t !== "object") {
      queue.splice(i, 1);
      continue;
    }
    const isCurrentCallerTicket = Boolean(currentTicketId && t.ticketId === currentTicketId);
    const deadWaiter = !t.waiterPid || !livenessCheck(t.waiterPid);
    const waitExpired =
      !isCurrentCallerTicket &&
      typeof t.waitExpiresAtMs === "number" &&
      now >= t.waitExpiresAtMs;
    const hbExpired =
      !isCurrentCallerTicket &&
      typeof t.lastHeartbeatAtMs === "number" &&
      now >= t.lastHeartbeatAtMs + hbTimeoutMs;
    const expired = waitExpired || hbExpired;
    const lostDevice =
      Boolean(t.pinnedDeviceLeaseId || t.pinnedDeviceKey) &&
      !hasValidPinnedDeviceLease(t, leases);
    if (deadWaiter || expired || lostDevice) {
      queue.splice(i, 1);
      pruned.push({
        ticketId: t.ticketId,
        sessionId: t.sessionId,
        reason: lostDevice ? "lost_device_lease" : expired ? "expired" : "dead_waiter",
      });
    }
  }

  function isTicketDeviceAvailable(ticket) {
    if (!ticket.requiresDeviceCoAlloc && !ticket.coAllocResourceKey) return true;
    if (typeof stateView.isDeviceAvailableForTicket === "function") {
      return Boolean(stateView.isDeviceAvailableForTicket(ticket));
    }
    if (typeof ticket.deviceAvailableForCoAlloc === "boolean") {
      return ticket.deviceAvailableForCoAlloc;
    }
    return stateView.deviceAvailableForCoAlloc !== false;
  }

  function getTicketCoAllocResourceKey(ticket) {
    return ticket.coAllocResourceKey || "device";
  }

  function missingResources(ticket) {
    const missing = new Set();
    for (const ws of ticket.resourceKeys || []) {
      for (const activeWs of activeWorkspaces) {
        if (doBuildResourceKeysConflict(ws, activeWs)) {
          missing.add(`ws:${ws}`);
          break;
        }
      }
    }
    const hasDev = Boolean(ticket.pinnedDeviceLeaseId || ticket.requiresDeviceCoAlloc);
    const isStarved =
      typeof ticket.starvationDeadlineMs === "number" && now >= ticket.starvationDeadlineMs;
    const effectiveCeiling =
      hasDev || isStarved ? maxHostBuilds + burstBuilds : maxHostBuilds;
    if (ticket.requiresHeavySlot && activeHeavyBuilds >= effectiveCeiling) {
      missing.add("host:heavy_slot");
    }
    if (ticket.requiresDeviceCoAlloc && !isTicketDeviceAvailable(ticket)) {
      missing.add(getTicketCoAllocResourceKey(ticket));
    }
    return missing;
  }

  function providedResources(ticket) {
    const used = new Set();
    for (const ws of ticket.resourceKeys || []) {
      used.add(`ws:${ws}`);
    }
    if (ticket.requiresHeavySlot) used.add("host:heavy_slot");
    if (ticket.requiresDeviceCoAlloc) used.add(getTicketCoAllocResourceKey(ticket));
    return used;
  }

  const eligible = [];
  for (let i = 0; i < queue.length; i++) {
    const t = queue[i];
    if (missingResources(t).size === 0) {
      eligible.push({ idx: i, ticket: t });
    }
  }
  if (eligible.length === 0) return { chosenIdx: -1, pruned };

  const ranked = [...eligible].sort((a, b) => {
    const aStarved = now >= a.ticket.starvationDeadlineMs;
    const bStarved = now >= b.ticket.starvationDeadlineMs;
    if (aStarved !== bStarved) return aStarved ? -1 : 1;
    const aHasDev = Boolean(a.ticket.pinnedDeviceLeaseId || a.ticket.requiresDeviceCoAlloc);
    const bHasDev = Boolean(b.ticket.pinnedDeviceLeaseId || b.ticket.requiresDeviceCoAlloc);
    if (aHasDev !== bHasDev) return aHasDev ? -1 : 1;
    const aSeq = a.ticket.seq ?? a.ticket.enqueuedAtMs;
    const bSeq = b.ticket.seq ?? b.ticket.enqueuedAtMs;
    return a.ticket.enqueuedAtMs - b.ticket.enqueuedAtMs || aSeq - bSeq;
  });

  for (const cand of ranked) {
    const candUsed = providedResources(cand.ticket);
    const candHasDev = Boolean(cand.ticket.pinnedDeviceLeaseId || cand.ticket.requiresDeviceCoAlloc);
    let blockedByEarlier = false;

    for (let j = 0; j < cand.idx; j++) {
      const earlier = queue[j];
      const earlierMissing = missingResources(earlier);
      const earlierHasDev = Boolean(
        earlier.pinnedDeviceLeaseId || earlier.requiresDeviceCoAlloc,
      );

      if (earlierMissing.size === 0) {
        const canOvertake =
          candHasDev &&
          !earlierHasDev &&
          now < earlier.starvationDeadlineMs &&
          cand.ticket.enqueuedAtMs - earlier.enqueuedAtMs <= reorderWindowMs;
        if (!canOvertake) {
          blockedByEarlier = true;
          break;
        }
      } else if (now >= earlier.starvationDeadlineMs) {
        for (const m of earlierMissing) {
          if (candUsed.has(m)) {
            blockedByEarlier = true;
            break;
          }
          if (m.startsWith("ws:")) {
            const missingKey = m.slice(3);
            if (
              (cand.ticket.resourceKeys || []).some((ck) =>
                doBuildResourceKeysConflict(ck, missingKey),
              )
            ) {
              blockedByEarlier = true;
              break;
            }
          }
        }
        if (blockedByEarlier) break;
      }
    }
    if (!blockedByEarlier) {
      return { chosenIdx: cand.idx, pruned };
    }
  }
  return { chosenIdx: -1, pruned };
}

export function computeUnaccountedBuildRamMb(
  state,
  hostSnapshotSampledAtMs,
  nowMs,
  { excludeBuildId = null } = {},
) {
  let unaccountedBuildRamMb = 0;
  const sampledAtMs =
    typeof hostSnapshotSampledAtMs === "number" && Number.isFinite(hostSnapshotSampledAtMs)
      ? hostSnapshotSampledAtMs
      : nowMs;
  for (const bLease of Object.values(state?.buildLeases || {})) {
    if (!bLease || !bLease.requiresHeavySlot) continue;
    if (excludeBuildId && bLease.buildId === excludeBuildId) continue;
    if (bLease.state !== "active" && bLease.state !== "draining") continue;
    const isPreparingDevice = Boolean(bLease.preparingDevice && bLease.state === "active");
    const withinHorizon =
      typeof bLease.ramReservationUntilMs === "number" && nowMs < bLease.ramReservationUntilMs;
    const admittedAfterSnapshot =
      typeof bLease.createdAtMs === "number" && bLease.createdAtMs >= sampledAtMs;
    if (isPreparingDevice || withinHorizon || admittedAfterSnapshot) {
      unaccountedBuildRamMb += bLease.reservedRamMb || (state?.config?.buildRamEstimateMb ?? 3072);
    }
  }
  return unaccountedBuildRamMb;
}

export function checkUnifiedRamAdmission(
  state,
  hostSnapshot,
  prospectiveDemandMb,
  nowMs,
  { minFreeRamMb = null, hysteresisMb = null, onlineDeviceKeys = new Set() } = {},
) {
  const cfg = state?.config || {};
  const effectiveMinFreeMb = minFreeRamMb ?? cfg.minFreeRamMb ?? 2048;
  const effectiveHysteresisMb = hysteresisMb ?? cfg.buildRamHysteresisMb ?? 256;
  const sampledAtMs =
    typeof hostSnapshot?.sampledAtMs === "number" ? hostSnapshot.sampledAtMs : nowMs;
  const freeRamMb = hostSnapshot?.freeRamMb ?? hostSnapshot?.availableRamMb ?? 4096;

  let unaccountedRamMb = 0;
  for (const lease of Object.values(state?.leases || {})) {
    if (!lease || lease.kind !== "emulator") continue;
    const leaseOnline = Boolean(
      (lease.deviceKey && onlineDeviceKeys.has(lease.deviceKey)) ||
        (lease.avd && onlineDeviceKeys.has(lease.avd)) ||
        (lease.udid && onlineDeviceKeys.has(lease.udid)),
    );
    const isStarting = lease.state === "starting" && !leaseOnline;
    const isRecentlyActivated =
      lease.state === "active" &&
      lease.firstSeenOfflineAtMs == null &&
      !leaseOnline &&
      typeof lease.activatedAtMs === "number" &&
      nowMs - lease.activatedAtMs < 30_000;
    const notInSnapshot =
      typeof lease.claimedAtMs === "number" && lease.claimedAtMs >= sampledAtMs;
    if (isStarting || isRecentlyActivated || notInSnapshot) {
      const leaseOverheadMb =
        (lease.platform || "android") === "ios"
          ? (cfg.simOverheadRamMb ?? 1280)
          : (cfg.qemuOverheadRamMb ?? 1024);
      unaccountedRamMb +=
        lease.requiredRamMb ||
        ((lease.platform || "android") === "ios" ? leaseOverheadMb : 2048 + leaseOverheadMb);
    }
  }

  unaccountedRamMb += computeUnaccountedBuildRamMb(state, sampledAtMs, nowMs);

  const effectiveFreeMb = freeRamMb - unaccountedRamMb - prospectiveDemandMb;
  return {
    allowed: effectiveFreeMb >= effectiveMinFreeMb + effectiveHysteresisMb,
    effectiveFreeMb,
    unaccountedRamMb,
    requiredFloorMb: effectiveMinFreeMb + effectiveHysteresisMb,
  };
}

export function reconcileBuildLease(
  lease,
  nowMs,
  {
    clientGroupAlive = false,
    abortedOrTimedOut = false,
    abortCooldownMs = 5_000,
    maxDrainingMs = 30_000,
  } = {},
) {
  if (!lease || typeof lease !== "object") {
    return { action: "delete_lease" };
  }
  if (lease.state === "active") {
    if (!clientGroupAlive && !abortedOrTimedOut) {
      return { action: "delete_lease" };
    }
    return {
      action: "mark_draining",
      lease: {
        ...lease,
        state: "draining",
        drainingStartedAtMs: nowMs,
        drainingCooldownUntilMs: abortedOrTimedOut ? nowMs + abortCooldownMs : nowMs,
        drainingDeadlineMs: nowMs + maxDrainingMs,
      },
    };
  }
  if (lease.state === "draining") {
    const cooldownDone = nowMs >= (lease.drainingCooldownUntilMs || 0);
    const pastMaxHorizon = nowMs >= (lease.drainingDeadlineMs || Infinity);
    if ((!clientGroupAlive && cooldownDone) || pastMaxHorizon) {
      return {
        action: "delete_lease",
        forcedByHorizon: Boolean(pastMaxHorizon && clientGroupAlive),
      };
    }
    return { action: "keep_draining", lease };
  }
  return { action: "delete_lease" };
}

const BUILD_DAEMON_PROCESS_RE =
  /\b(GradleDaemon|org\.gradle\.launcher\.daemon|kotlin-daemon|KotlinCompileDaemon|bazel\([A-Za-z0-9_.-]+\)|bazel-real|xcbbuildservice|SWBBuildService)\b/i;

export function isProcessSpawnedByBuildDaemon(processChain = []) {
  if (!Array.isArray(processChain)) return false;
  return processChain.some(
    (proc) =>
      proc &&
      (BUILD_DAEMON_PROCESS_RE.test(String(proc.args || "")) ||
        BUILD_DAEMON_PROCESS_RE.test(String(proc.comm || ""))),
  );
}

export function evaluateNestedBuildAdmission(
  state,
  {
    inheritedOpId = null,
    inheritedNonce = null,
    ancestorPids = [],
    processChain = [],
    requestedKeys = [],
    requiresHeavySlot = false,
    requiresDevice = false,
    hasActiveDeviceLease = false,
    livenessCheck = () => true,
  } = {},
) {
  if (!inheritedOpId || !inheritedNonce) {
    return { reentrant: false, deadlockHazard: false, reason: "no_op_env" };
  }
  const activeBuildLease = Object.values(state?.buildLeases || {}).find(
    (b) =>
      b &&
      b.opId === inheritedOpId &&
      b.opNonce === inheritedNonce &&
      b.state === "active",
  );
  if (!activeBuildLease) {
    return { reentrant: false, deadlockHazard: false, reason: "inactive_or_mismatched_op" };
  }
  const parentWorkerAlive = Boolean(
    activeBuildLease.workerPid && livenessCheck(activeBuildLease.workerPid),
  );
  if (!parentWorkerAlive) {
    return { reentrant: false, deadlockHazard: false, reason: "parent_worker_exited" };
  }

  const ancestorSet = new Set(Array.isArray(ancestorPids) ? ancestorPids.map(Number) : []);
  const callerInClientTree =
    ancestorSet.has(Number(activeBuildLease.workerPid)) ||
    (activeBuildLease.execWrapperPid && ancestorSet.has(Number(activeBuildLease.execWrapperPid)));
  const callerSpawnedByBuildDaemon = isProcessSpawnedByBuildDaemon(processChain);

  if (!callerInClientTree && !callerSpawnedByBuildDaemon) {
    return {
      reentrant: false,
      deadlockHazard: false,
      reason: "caller_not_in_client_or_daemon_tree",
    };
  }

  const extractKeyPath = (keyStr) => {
    const s = String(keyStr || "");
    const firstColon = s.indexOf(":");
    if (firstColon === -1) return "";
    const rest = s.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (
      secondColon !== -1 &&
      ["ws", "out", "dir", "dd"].includes(rest.slice(0, secondColon))
    ) {
      return rest.slice(secondColon + 1);
    }
    return rest;
  };

  const heldKeys = new Set(activeBuildLease.resourceKeys || []);
  const heldRoots = new Set();
  if (activeBuildLease.workspaceRoot) {
    heldRoots.add(String(activeBuildLease.workspaceRoot));
  }
  for (const hk of heldKeys) {
    const p = extractKeyPath(hk);
    if (p) heldRoots.add(p);
  }

  const otherHeldKeys = new Set();
  for (const b of Object.values(state?.buildLeases || {})) {
    if (!b || b.buildId === activeBuildLease.buildId) continue;
    if (b.state !== "active" && b.state !== "draining") continue;
    for (const ok of b.resourceKeys || []) {
      otherHeldKeys.add(ok);
    }
  }

  const deltaKeys = [];
  for (const k of requestedKeys || []) {
    if (heldKeys.has(k)) continue;
    const reqPath = extractKeyPath(k);
    const inSameWorkspace =
      Boolean(reqPath) &&
      Array.from(heldRoots).some(
        (root) =>
          reqPath === root ||
          reqPath.startsWith(`${root}/`) ||
          reqPath.startsWith(`${root}\\`),
      );
    if (
      inSameWorkspace &&
      !otherHeldKeys.has(k) &&
      !Array.from(otherHeldKeys).some((ok) => doBuildResourceKeysConflict(k, ok))
    ) {
      deltaKeys.push(k);
      continue;
    }
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build requests workspace resource "${k}" not held by parent build operation ${activeBuildLease.buildId} (held: ${Array.from(heldKeys).join(", ")}). Failing fast to prevent self-deadlock.`,
    };
  }
  if (requiresHeavySlot && !activeBuildLease.requiresHeavySlot) {
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build escalates from workspace-only query to a heavy compilation slot inside parent build operation ${activeBuildLease.buildId}. Failing fast to prevent self-deadlock.`,
    };
  }
  if (requiresDevice && !hasActiveDeviceLease) {
    return {
      reentrant: false,
      deadlockHazard: true,
      reason: `Nested build escalates to require a device lease inside parent build operation ${activeBuildLease.buildId} while holding no active device lease. Failing fast to prevent self-deadlock.`,
    };
  }

  if (deltaKeys.length > 0) {
    activeBuildLease.resourceKeys = Array.from(new Set([...heldKeys, ...deltaKeys]));
  }

  return {
    reentrant: true,
    deadlockHazard: false,
    buildLease: activeBuildLease,
    deltaKeys,
  };
}

export function computeDefaultBazelOutputBases(wsRoot, options = {}) {
  if (!wsRoot) return [];
  const wsMd5 = crypto.createHash("md5").update(String(wsRoot)).digest("hex");
  const buildReqs = options.buildReqs || null;
  const env = options.env || process.env;
  const platform = options.platform || buildReqs?.platform || process.platform;
  const baseCwd = buildReqs?.baseCwd || process.cwd();

  const resolveEnvVar = (key, wrapperVal) => {
    if (wrapperVal === null || wrapperVal === "") return null;
    if (wrapperVal !== undefined) return String(wrapperVal);
    const fromEnv = env?.[key];
    return fromEnv === undefined || fromEnv === "" ? null : String(fromEnv);
  };

  const rawTestTmpdir = resolveEnvVar("TEST_TMPDIR", buildReqs?.envBazelTestTmpdir);
  const rawPosixUser = resolveEnvVar("USER", buildReqs?.envBazelUser);
  const rawWinUsername =
    platform === "win32"
      ? resolveEnvVar("USERNAME", buildReqs?.envBazelUsername)
      : null;
  const rawUser = platform === "win32" ? rawPosixUser || rawWinUsername : rawPosixUser;
  const rawPosixHome = resolveEnvVar("HOME", buildReqs?.envBazelHome);
  const rawWinUserProfile =
    platform === "win32"
      ? resolveEnvVar("USERPROFILE", buildReqs?.envBazelUserProfile)
      : null;
  const rawHome = platform === "win32" ? rawPosixHome || rawWinUserProfile : rawPosixHome;
  const rawXdgCache = resolveEnvVar("XDG_CACHE_HOME", buildReqs?.envBazelXdgCacheHome);
  const rawUseBazelVersion = resolveEnvVar(
    "USE_BAZEL_VERSION",
    buildReqs?.envBazelUseBazelVersion,
  );

  let rawMajor = options.bazelMajorVersion ?? buildReqs?.bazelMajorVersion ?? null;
  const allowBazeliskFallback = Boolean(options.isBazelisk ?? buildReqs?.isBazelisk);
  if (rawMajor === null || rawMajor === undefined || rawMajor === "") {
    const rawVerStr =
      options.bazelVersion ||
      buildReqs?.bazelVersion ||
      (allowBazeliskFallback
        ? resolveBazeliskVersionSelector(wsRoot, {
            rawUseBazelVersion,
            rawHome:
              rawHome ||
              (() => {
                try {
                  return os.userInfo().homedir;
                } catch {
                  return null;
                }
              })() ||
              os.homedir() ||
              null,
            baseCwd,
            platform,
          })
        : null);
    if (rawVerStr && rawVerStr !== "__UNRESOLVED_DYNAMIC_ENV__") {
      const m = String(rawVerStr)
        .trim()
        .match(
          /^(?:[A-Za-z0-9_.-]+\/)?v?(\d+)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:[-+][A-Za-z0-9_.-]+)?$/i,
        );
      if (m) rawMajor = Number(m[1]);
    }
  }
  const bazelMajor =
    rawMajor !== null && rawMajor !== undefined && rawMajor !== ""
      ? Number(rawMajor)
      : null;

  if (
    rawTestTmpdir === "__UNRESOLVED_DYNAMIC_ENV__" ||
    rawPosixUser === "__UNRESOLVED_DYNAMIC_ENV__" ||
    (platform === "win32" && rawWinUsername === "__UNRESOLVED_DYNAMIC_ENV__")
  ) {
    return [];
  }

  const rawSelectedUser =
    rawUser ||
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return null;
      }
    })();
  if (!rawSelectedUser) return [];
  const user = String(rawSelectedUser).replace(/[\\/]/g, "_");

  const resolvePosixPath = (base, val) => {
    const s = String(val || "");
    if (s.startsWith("/")) return path.posix.resolve(s);
    const b = String(base || "");
    if (b.startsWith("/")) return path.posix.resolve(b, s);
    return path.resolve(b, s);
  };

  const candidateRoots = [];
  if (rawTestTmpdir) {
    const resolvedTmp =
      platform === "win32" &&
      (/^[a-zA-Z]:[\\/]/.test(rawTestTmpdir) || rawTestTmpdir.startsWith("\\\\"))
        ? path.win32.resolve(rawTestTmpdir)
        : platform === "win32"
          ? path.resolve(baseCwd, rawTestTmpdir)
          : resolvePosixPath(baseCwd, rawTestTmpdir);
    const joinTmp = platform === "win32" ? path.win32.join : path.posix.join;
    candidateRoots.push(joinTmp(resolvedTmp, `_bazel_${user}`));
    candidateRoots.push(
      joinTmp(canonicalizeBuildPath(resolvedTmp, { platform }), `_bazel_${user}`),
    );
  } else if (platform === "darwin") {
    if (bazelMajor === null || !Number.isFinite(bazelMajor) || bazelMajor <= 0) {
      // Bazel <= 8 uses /var/tmp/_bazel_<user> on macOS while Bazel 9+ uses
      // ~/Library/Caches/bazel/_bazel_<user> (or ${XDG_CACHE_HOME}/bazel/_bazel_<user>).
      // Without a known major version, conservatively treat as cold so a lingering
      // server from the other major version cannot falsely satisfy admission.
      return [];
    }
    if (bazelMajor <= 8) {
      candidateRoots.push(`/var/tmp/_bazel_${user}`);
      candidateRoots.push(`/private/var/tmp/_bazel_${user}`);
    } else {
      if (
        rawXdgCache === "__UNRESOLVED_DYNAMIC_ENV__" ||
        rawPosixHome === "__UNRESOLVED_DYNAMIC_ENV__"
      ) {
        return [];
      }
      if (rawXdgCache) {
        const xdgCache = resolvePosixPath(baseCwd, rawXdgCache);
        candidateRoots.push(path.posix.join(xdgCache, "bazel", `_bazel_${user}`));
        candidateRoots.push(
          path.posix.join(
            canonicalizeBuildPath(xdgCache, { platform }),
            "bazel",
            `_bazel_${user}`,
          ),
        );
      } else {
        const homeDir =
          rawPosixHome ||
          (() => {
            try {
              return os.userInfo().homedir;
            } catch {
              return null;
            }
          })();
        if (homeDir) {
          const resolvedHome = resolvePosixPath(baseCwd, homeDir);
          candidateRoots.push(
            path.posix.join(resolvedHome, "Library", "Caches", "bazel", `_bazel_${user}`),
          );
          candidateRoots.push(
            path.posix.join(
              canonicalizeBuildPath(resolvedHome, { platform }),
              "Library",
              "Caches",
              "bazel",
              `_bazel_${user}`,
            ),
          );
        } else {
          candidateRoots.push(`/var/tmp/_bazel_${user}`);
          candidateRoots.push(`/private/var/tmp/_bazel_${user}`);
        }
      }
    }
  } else if (platform === "win32") {
    if (
      rawXdgCache === "__UNRESOLVED_DYNAMIC_ENV__" ||
      rawPosixHome === "__UNRESOLVED_DYNAMIC_ENV__" ||
      rawWinUserProfile === "__UNRESOLVED_DYNAMIC_ENV__"
    ) {
      return [];
    }
    if (rawXdgCache) {
      if (bazelMajor === null || !Number.isFinite(bazelMajor) || bazelMajor <= 0) {
        return [];
      }
      if (bazelMajor >= 9) {
        const resolvedXdg =
          /^[a-zA-Z]:[\\/]/.test(rawXdgCache) || rawXdgCache.startsWith("\\\\")
            ? path.win32.resolve(rawXdgCache)
            : path.resolve(baseCwd, rawXdgCache);
        candidateRoots.push(path.win32.join(resolvedXdg, "bazel", `_bazel_${user}`));
        candidateRoots.push(
          path.win32.join(
            canonicalizeBuildPath(resolvedXdg, { platform: "win32" }),
            "bazel",
            `_bazel_${user}`,
          ),
        );
      }
    }
    if (candidateRoots.length === 0) {
      const homeDir =
        rawHome ||
        (() => {
          try {
            return os.userInfo().homedir;
          } catch {
            return null;
          }
        })() ||
        os.homedir();
      if (homeDir) {
        const resolvedHome =
          /^[a-zA-Z]:[\\/]/.test(homeDir) || homeDir.startsWith("\\\\")
            ? path.win32.resolve(homeDir)
            : path.resolve(baseCwd, homeDir);
        candidateRoots.push(path.win32.join(resolvedHome, `_bazel_${user}`));
        candidateRoots.push(
          path.win32.join(
            canonicalizeBuildPath(resolvedHome, { platform: "win32" }),
            `_bazel_${user}`,
          ),
        );
      }
    }
  } else {
    if (
      rawXdgCache === "__UNRESOLVED_DYNAMIC_ENV__" ||
      rawPosixHome === "__UNRESOLVED_DYNAMIC_ENV__"
    ) {
      return [];
    }
    const homeDir =
      rawPosixHome ||
      (() => {
        try {
          return os.userInfo().homedir;
        } catch {
          return null;
        }
      })();
    const xdgCache = rawXdgCache
      ? resolvePosixPath(baseCwd, rawXdgCache)
      : homeDir
        ? path.posix.join(resolvePosixPath(baseCwd, homeDir), ".cache")
        : null;
    if (xdgCache) {
      candidateRoots.push(path.posix.join(xdgCache, "bazel", `_bazel_${user}`));
      candidateRoots.push(
        path.posix.join(canonicalizeBuildPath(xdgCache, { platform }), "bazel", `_bazel_${user}`),
      );
    } else {
      candidateRoots.push(`/tmp/_bazel_${user}`);
    }
  }

  const joinFn = platform === "win32" ? path.win32.join : path.posix.join;
  const bases = [];
  for (const root of candidateRoots) {
    if (!root) continue;
    bases.push(joinFn(root, wsMd5));
    bases.push(canonicalizeBuildPath(joinFn(root, wsMd5), { platform }));
  }
  return Array.from(new Set(bases));
}

export function probeWarmBuildDaemons(buildReqs, options = {}) {
  // v3: one direct build-tool invocation per probe (no shell clause trees).
  if (
    !buildReqs ||
    (buildReqs.tool !== "gradle" && buildReqs.tool !== "bazel") ||
    buildReqs.disablesDaemon
  ) {
    return { warm: false, daemonPids: [] };
  }
  const filterIdleGradleDaemons = (
    candidatePids,
    candidateCount = candidatePids.length,
    psClientCount = 0,
  ) => {
    if (buildReqs.tool !== "gradle") {
      return { warm: candidateCount > 0, daemonPids: candidatePids };
    }
    const rawLeases = options.activeBuildLeases || options.state?.buildLeases || null;
    const leaseList = Array.isArray(rawLeases)
      ? rawLeases
      : rawLeases && typeof rawLeases === "object"
        ? Object.values(rawLeases)
        : [];
    const activeGradleLeases = leaseList.filter(
      (b) =>
        b &&
        (b.tool === "gradle" ||
          (Array.isArray(b.claimedDaemonPids) && b.claimedDaemonPids.length > 0) ||
          Number(b.claimedGradleCount) > 0) &&
        b.requiresHeavySlot !== false &&
        (b.state === "active" || b.state === "draining") &&
        !b.preparingDevice,
    );
    const busySet = new Set(
      Array.isArray(options.busyDaemonPids)
        ? options.busyDaemonPids.map((p) => Number(p)).filter(Boolean)
        : [],
    );
    let matchedBusyCount = 0;
    let unassignedBusyCount = 0;
    for (const b of activeGradleLeases) {
      const claimedList =
        Array.isArray(b.claimedDaemonPids) && b.claimedDaemonPids.length > 0
          ? b.claimedDaemonPids.map(Number).filter(Boolean)
          : Number(b.claimedDaemonPid)
            ? [Number(b.claimedDaemonPid)]
            : Array.isArray(b.daemonPids) && b.daemonPids.length === 1 && Number(b.daemonPids[0])
              ? [Number(b.daemonPids[0])]
              : [];
      if (claimedList.length > 0) {
        for (const claimedPid of claimedList) {
          if (candidatePids.length === 0) {
            unassignedBusyCount++;
            matchedBusyCount++;
          } else if (candidatePids.includes(claimedPid)) {
            if (!busySet.has(claimedPid)) {
              busySet.add(claimedPid);
            } else {
              unassignedBusyCount++;
            }
            matchedBusyCount++;
          }
        }
      } else if (
        candidatePids.length > 0 &&
        Array.isArray(b.daemonPids) &&
        b.daemonPids.length > 0 &&
        !b.daemonPids.some((pid) => candidatePids.includes(Number(pid)))
      ) {
        // Active lease has a known disjoint compatible daemon pool
      } else {
        const anonCount = Math.max(1, Number(b.claimedGradleCount) || 1);
        unassignedBusyCount += anonCount;
        matchedBusyCount += anonCount;
      }
    }
    const extraPsBusy = Math.max(0, psClientCount - matchedBusyCount);
    const remainingPids = candidatePids.filter((pid) => !busySet.has(pid));
    const totalDeductions =
      unassignedBusyCount + extraPsBusy + Math.max(0, Number(options._extraBusyGradleCount) || 0);
    if (remainingPids.length > 0) {
      const idlePids = remainingPids.slice(totalDeductions);
      return {
        warm: idlePids.length > 0,
        claimedDaemonPids: idlePids.length > 0 ? [idlePids[0]] : [],
        daemonPids: idlePids,
      };
    }
    const remainingAnon = Math.max(0, candidateCount - busySet.size - totalDeductions);
    return { warm: remainingAnon > 0, claimedDaemonPids: [], daemonPids: [] };
  };
  if (typeof options.warmBuildDaemon === "boolean") {
    return options.warmBuildDaemon
      ? filterIdleGradleDaemons([], 1, 0)
      : { warm: false, daemonPids: [] };
  }
  if (Array.isArray(options.inventory?.warmBuildDaemons)) {
    const matched = options.inventory.warmBuildDaemons.filter((d) => {
      if (!d) return false;
      if (typeof d === "object" && (d.busy === true || d.idle === false || d.state === "busy")) {
        return false;
      }
      if (typeof d === "string") return d === buildReqs.tool || d === buildReqs.workspaceRoot;
      if (d.tool && d.tool !== buildReqs.tool) return false;
      if (d.workspaceRoot && buildReqs.workspaceRoot && d.workspaceRoot !== buildReqs.workspaceRoot) {
        return false;
      }
      return true;
    });
    const matchedPids = matched
      .map((d) => (typeof d === "object" ? Number(d.pid) : 0))
      .filter(Boolean);
    return filterIdleGradleDaemons(matchedPids, matched.length, 0);
  }
  if (options.inventory && !options.runner && !options.spawnSyncFn) {
    return { warm: false, daemonPids: [] };
  }
  const platform = options.platform || process.platform;
  if (platform === "win32" && !options.runner && !options.spawnSyncFn) {
    return { warm: false, daemonPids: [] };
  }
  try {
    let stdout = "";
    if (typeof options.runner === "function") {
      const res = options.runner("ps", ["-ax", "-o", "pid=,command="]);
      stdout = String(res?.stdout || "");
    } else {
      const spawnFn = options.spawnSyncFn || spawnSync;
      const res = spawnFn("ps", ["-ax", "-o", "pid=,command="], {
        encoding: "utf8",
        timeout: 2000,
      });
      if (res?.status === 0 || typeof res?.stdout === "string") {
        stdout = String(res.stdout || "");
      }
    }
    if (!stdout) return { warm: false, daemonPids: [] };
    const daemonPids = [];
    const wsRoot = String(buildReqs.workspaceRoot || "");
    let expectedGradleVersion = null;
    let expectedGradleJavaHome = buildReqs.envJavaHomeUnset
      ? null
      : buildReqs.envJavaHome || options.env?.JAVA_HOME || null;
    const expectedGradleUserHome = buildReqs.envGradleUserHomeUnset
      ? null
      : buildReqs.envGradleUserHome || options.env?.GRADLE_USER_HOME || null;
    if (
      expectedGradleUserHome === "__UNRESOLVED_DYNAMIC_ENV__" ||
      buildReqs.envLcAll === "__UNRESOLVED_DYNAMIC_ENV__" ||
      buildReqs.envLcMessages === "__UNRESOLVED_DYNAMIC_ENV__" ||
      buildReqs.envLang === "__UNRESOLVED_DYNAMIC_ENV__"
    ) {
      return { warm: false, daemonPids: [] };
    }
    const baseProbeEnv = options.env || process.env || {};
    const hasLocaleOverrideInReqs = Boolean(
      buildReqs.envLcAll ||
        buildReqs.envLcAllUnset ||
        buildReqs.envLcMessages ||
        buildReqs.envLcMessagesUnset ||
        buildReqs.envLang ||
        buildReqs.envLangUnset ||
        (options.env &&
          ("LC_ALL" in options.env || "LC_MESSAGES" in options.env || "LANG" in options.env)),
    );
    const effectiveProbeEnv = hasLocaleOverrideInReqs
      ? {
          ...baseProbeEnv,
          LC_ALL: buildReqs.envLcAllUnset
            ? ""
            : buildReqs.envLcAll || baseProbeEnv.LC_ALL || "",
          LC_MESSAGES: buildReqs.envLcMessagesUnset
            ? ""
            : buildReqs.envLcMessages || baseProbeEnv.LC_MESSAGES || "",
          LANG: buildReqs.envLangUnset
            ? ""
            : buildReqs.envLang || baseProbeEnv.LANG || "",
        }
      : baseProbeEnv;
    const matchesCmdPathBoundary = (cmdLine, targetPath, { allowSubpath = false } = {}) => {
      if (!cmdLine || !targetPath) return false;
      const cleanTarget = String(targetPath).replace(/[\\/]+$/, "");
      if (!cleanTarget) return false;
      let searchFrom = 0;
      while (searchFrom < cmdLine.length) {
        const idx = cmdLine.indexOf(cleanTarget, searchFrom);
        if (idx === -1) return false;
        searchFrom = idx + 1;
        const prevCh = idx > 0 ? cmdLine[idx - 1] : "";
        const prevOk = idx === 0 || /[\s="'(:;]/.test(prevCh);
        if (!prevOk) continue;
        let endIdx = idx + cleanTarget.length;
        if (!allowSubpath) {
          while (
            endIdx < cmdLine.length &&
            (cmdLine[endIdx] === "/" || cmdLine[endIdx] === "\\")
          ) {
            endIdx++;
          }
          const nextCh = endIdx < cmdLine.length ? cmdLine[endIdx] : "";
          if (endIdx === cmdLine.length || /[\s="'),;]/.test(nextCh)) {
            return true;
          }
        } else {
          const nextCh = endIdx < cmdLine.length ? cmdLine[endIdx] : "";
          if (
            endIdx === cmdLine.length ||
            nextCh === "/" ||
            nextCh === "\\" ||
            /[\s="'),;]/.test(nextCh)
          ) {
            return true;
          }
        }
      }
      return false;
    };
    const matchesCmdTokenBoundary = (cmdLine, token) => {
      if (!cmdLine || !token) return false;
      let searchFrom = 0;
      while (searchFrom < cmdLine.length) {
        const idx = cmdLine.indexOf(token, searchFrom);
        if (idx === -1) return false;
        searchFrom = idx + 1;
        const prevCh = idx > 0 ? cmdLine[idx - 1] : "";
        const nextIdx = idx + token.length;
        const nextCh = nextIdx < cmdLine.length ? cmdLine[nextIdx] : "";
        const prevOk = idx === 0 || /[\s"']/.test(prevCh);
        const nextOk = nextIdx === cmdLine.length || /[\s"']/.test(nextCh);
        if (prevOk && nextOk) return true;
      }
      return false;
    };
    const isGradleCompatibilityJvmArg = (tok) => {
      if (!tok || !tok.startsWith("-")) return false;
      if (
        tok === "-cp" ||
        tok === "-classpath" ||
        tok === "--class-path" ||
        tok.startsWith("--class-path=")
      ) {
        return false;
      }
      if (
        tok.startsWith("-Dgradle.user.home=") ||
        tok.startsWith("-Duser.dir=") ||
        tok.startsWith("-Dorg.gradle.appname=")
      ) {
        return false;
      }
      return (
        tok.startsWith("-Xm") ||
        tok.startsWith("-XX:") ||
        tok.startsWith("-Xss") ||
        tok.startsWith("-D") ||
        tok.startsWith("-javaagent:") ||
        tok.startsWith("-agentlib:") ||
        tok.startsWith("-agentpath:") ||
        tok === "-ea" ||
        tok.startsWith("-ea:") ||
        tok === "-enableassertions" ||
        tok.startsWith("-enableassertions:") ||
        tok === "-da" ||
        tok.startsWith("-da:") ||
        tok === "-disableassertions" ||
        tok.startsWith("-disableassertions:") ||
        tok === "-esa" ||
        tok === "-dsa"
      );
    };
    let expectedGradleJvmArgs = [];
    let hasExplicitGradleJvmArgs = false;
    if (buildReqs.tool === "gradle" && wsRoot) {
      try {
        const daemonJvmCriteriaPath = path.join(wsRoot, "gradle", "gradle-daemon-jvm.properties");
        if (
          fs.existsSync(daemonJvmCriteriaPath) &&
          parseJavaProperties(fs.readFileSync(daemonJvmCriteriaPath, "utf8")).size > 0
        ) {
          return { warm: false, daemonPids: [] };
        }
        const wrapperPropsPath = path.join(wsRoot, "gradle", "wrapper", "gradle-wrapper.properties");
        if (fs.existsSync(wrapperPropsPath)) {
          const content = fs.readFileSync(wrapperPropsPath, "utf8");
          const verMatch = content.match(/gradle-([0-9.]+(?:-[A-Za-z0-9.]+)?)-(?:bin|all)\.zip/);
          if (verMatch?.[1]) {
            expectedGradleVersion = verMatch[1];
          }
        }
        const gradleHomePropsDir = buildReqs.envGradleHomeUnset
          ? null
          : buildReqs.gradleHomeDir ||
            options.env?.GRADLE_HOME ||
            (!options.env ? process.env.GRADLE_HOME : null) ||
            null;
        const userHomePropsDir = buildReqs.envGradleUserHomeUnset
          ? null
          : expectedGradleUserHome ||
            buildReqs.gradleUserHomeDir ||
            path.join(options.env?.HOME || os.homedir(), ".gradle");
        const gradlePropsFiles = [
          ...(gradleHomePropsDir ? [path.join(gradleHomePropsDir, "gradle.properties")] : []),
          path.join(wsRoot, "gradle.properties"),
          ...(userHomePropsDir ? [path.join(userHomePropsDir, "gradle.properties")] : []),
        ];
        let daemonDisabledInProps = false;
        for (const gradlePropsPath of gradlePropsFiles) {
          if (fs.existsSync(gradlePropsPath)) {
            const propsMap = parseJavaProperties(fs.readFileSync(gradlePropsPath, "utf8"));
            if (propsMap.has("org.gradle.daemon")) {
              daemonDisabledInProps =
                String(propsMap.get("org.gradle.daemon")).trim().toLowerCase() === "false";
            }
            if (propsMap.has("org.gradle.java.home")) {
              expectedGradleJavaHome = String(propsMap.get("org.gradle.java.home")).trim();
            }
            if (propsMap.has("org.gradle.jvmargs")) {
              hasExplicitGradleJvmArgs = true;
              expectedGradleJvmArgs = splitRcWords(propsMap.get("org.gradle.jvmargs"));
            }
          }
        }
        if (daemonDisabledInProps) {
          return { warm: false, daemonPids: [] };
        }
      } catch {
        return { warm: false, daemonPids: [] };
      }
    }
    if (
      buildReqs.tool === "gradle" &&
      !expectedGradleJavaHome &&
      (buildReqs.envJavaHomeUnset ||
        buildReqs.envPath ||
        (!options.runner && !options.spawnSyncFn))
    ) {
      const rawPathVal = buildReqs.envPathUnset
        ? ""
        : buildReqs.envPath ||
          options.env?.PATH ||
          options.env?.Path ||
          (!options.env ? process.env.PATH || process.env.Path : "") ||
          "";
      if (rawPathVal && rawPathVal !== "__UNRESOLVED_DYNAMIC_ENV__") {
        const pathSep = platform === "win32" ? ";" : ":";
        const javaExeNames = platform === "win32" ? ["java.exe", "java.cmd", "java"] : ["java"];
        for (const rawDir of String(rawPathVal).split(pathSep)) {
          const dir = rawDir.trim();
          if (!dir) continue;
          let foundHome = null;
          for (const exeName of javaExeNames) {
            const candidate = path.join(dir, exeName);
            try {
              if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                const realJava = canonicalizeBuildPath(candidate);
                if (realJava === "/usr/bin/java") {
                  break;
                }
                const parentDir = path.dirname(realJava);
                foundHome =
                  path.basename(parentDir).toLowerCase() === "bin"
                    ? path.dirname(parentDir)
                    : parentDir;
                break;
              }
            } catch {
              // Ignore inaccessible PATH entry
            }
          }
          if (foundHome) {
            expectedGradleJavaHome = foundHome;
            break;
          }
        }
      }
      if (!expectedGradleJavaHome && buildReqs.envJavaHomeUnset) {
        return { warm: false, daemonPids: [] };
      }
    }
    const outKeys = (buildReqs.resourceKeys || [])
      .filter((k) => String(k).startsWith("bazel:out:"))
      .map((k) => String(k).slice("bazel:out:".length));
    let psGradleClientCount = 0;
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmdLine = m[2];
      if (buildReqs.tool === "gradle") {
        if (
          !/GradleDaemon\b/.test(cmdLine) &&
          /\b(?:org\.gradle\.wrapper\.GradleWrapperMain|org\.gradle\.launcher\.GradleMain|org\.gradle\.cli\.GradleCliMain)\b/.test(
            cmdLine,
          )
        ) {
          const clientFirstTok = (splitProcessWords(cmdLine) || [""])[0] || "";
          const clientHasExplicitJavaPath =
            clientFirstTok.includes("/") || clientFirstTok.includes("\\");
          if (
            expectedGradleJavaHome &&
            clientHasExplicitJavaPath &&
            !matchesCmdPathBoundary(cmdLine, expectedGradleJavaHome, { allowSubpath: true }) &&
            !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleJavaHome), {
              allowSubpath: true,
            })
          ) {
            continue;
          }
          if (cmdLine.includes("-Dgradle.user.home=")) {
            if (
              !expectedGradleUserHome ||
              (!matchesCmdPathBoundary(cmdLine, expectedGradleUserHome, { allowSubpath: true }) &&
                !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleUserHome), {
                  allowSubpath: true,
                }))
            ) {
              continue;
            }
          }
          psGradleClientCount++;
          continue;
        }
        if (/GradleDaemon\b/.test(cmdLine)) {
          const verMatch = cmdLine.match(/GradleDaemon\s+([0-9][0-9A-Za-z.-]*)/);
          const daemonVer = verMatch?.[1] || null;
          if (expectedGradleVersion && daemonVer !== expectedGradleVersion) {
            continue;
          }
          if (
            expectedGradleJavaHome &&
            !matchesCmdPathBoundary(cmdLine, expectedGradleJavaHome, { allowSubpath: true }) &&
            !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleJavaHome), {
              allowSubpath: true,
            })
          ) {
            continue;
          }
          if (expectedGradleUserHome) {
            if (
              !matchesCmdPathBoundary(cmdLine, expectedGradleUserHome, { allowSubpath: true }) &&
              !matchesCmdPathBoundary(cmdLine, canonicalizeBuildPath(expectedGradleUserHome), {
                allowSubpath: true,
              })
            ) {
              continue;
            }
          } else if (cmdLine.includes("-Dgradle.user.home=")) {
            continue;
          }
          const expectedCompatJvmArgs = expectedGradleJvmArgs.filter(
            (arg) => !arg.startsWith("-Dgradle.user.home=") && !arg.startsWith("-Duser.dir="),
          );
          const expectedCompatNorm = stripDefaultGradleDaemonJvmArgs(
            normalizeGradleCompatJvmArgs(expectedCompatJvmArgs),
            { keyed: new Map(), positional: [] },
            effectiveProbeEnv,
          );
          const daemonMainIdx = cmdLine.search(
            /\b(?:org\.gradle\.launcher\.daemon\.bootstrap\.)?GradleDaemon\b/,
          );
          const preMainCmd = daemonMainIdx >= 0 ? cmdLine.slice(0, daemonMainIdx) : cmdLine;
          const preMainTokens = splitProcessWords(preMainCmd);
          // Quoted process command lines are ambiguous; never reuse such a daemon (cold reservation).
          if (!preMainTokens) continue;
          const daemonCompatJvmArgs = preMainTokens
            .slice(1)
            .filter(
              (tok) => isGradleCompatibilityJvmArg(tok) || expectedCompatJvmArgs.includes(tok),
            );
          const daemonCompatNorm = stripDefaultGradleDaemonJvmArgs(
            normalizeGradleCompatJvmArgs(daemonCompatJvmArgs),
            normalizeGradleCompatJvmArgs(expectedCompatJvmArgs),
            effectiveProbeEnv,
          );
          const rawExpectedCompatNorm = normalizeGradleCompatJvmArgs(expectedCompatJvmArgs);
          const jvmArgsMatch =
            gradleCompatNormEqual(rawExpectedCompatNorm, daemonCompatNorm) ||
            gradleCompatNormEqual(expectedCompatNorm, daemonCompatNorm);
          if (!jvmArgsMatch) {
            continue;
          }
          const matchesWorkspaceOrWrapper =
            (wsRoot && matchesCmdPathBoundary(cmdLine, wsRoot, { allowSubpath: true })) ||
            Boolean(expectedGradleVersion && daemonVer === expectedGradleVersion);
          if (matchesWorkspaceOrWrapper) {
            daemonPids.push(pid);
          }
        }
      } else if (buildReqs.tool === "bazel") {
        const isBazelServer =
          /\bbazel\([^)]+\)/.test(cmdLine) ||
          /com\.google\.devtools\.build\.lib\.bazel\.BazelMain\b/.test(cmdLine);
        if (isBazelServer) {
          const targetOutPaths =
            outKeys.length > 0
              ? outKeys
              : computeDefaultBazelOutputBases(wsRoot, {
                  buildReqs,
                  env: options.env,
                  platform,
                  bazelMajorVersion: options.bazelMajorVersion ?? buildReqs.bazelMajorVersion,
                });
          const matchesWorkspace = targetOutPaths.some(
            (outPath) => outPath && matchesCmdPathBoundary(cmdLine, outPath),
          );
          if (matchesWorkspace) {
            daemonPids.push(pid);
          }
        }
      }
    }
    return filterIdleGradleDaemons(daemonPids, daemonPids.length, psGradleClientCount);
  } catch {
    return { warm: false, daemonPids: [] };
  }
}
