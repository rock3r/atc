// Value patterns for typed ATC operations (see docs/scope.md §3).
// Every free-form value accepted by an op must match one of these allowlist patterns.

export const FEATURE_REQUEST_URL = "https://github.com/rock3r/atc/issues";

export const PATTERNS = Object.freeze({
  gradleTask: {
    re: /^:?[A-Za-z0-9_][A-Za-z0-9_.-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/,
    label: "a Gradle task name or path (e.g. assembleDebug, :app:test)",
    forceable: true,
  },
  gradlePropertyKey: {
    re: /^[A-Za-z0-9_.-]{1,128}$/,
    label: "a Gradle property name ([A-Za-z0-9_.-], max 128 chars)",
    forceable: true,
  },
  bazelTarget: {
    re: /^(@[A-Za-z0-9_.~+-]*)?\/\/[A-Za-z0-9_./+-]*(:[A-Za-z0-9_./+=,@~-]+)?$/,
    label: "a Bazel label or pattern (e.g. //app:tests, //...)",
    forceable: true,
  },
  bazelConfig: {
    re: /^[A-Za-z0-9_.-]+$/,
    label: "a Bazel config name ([A-Za-z0-9_.-])",
    forceable: true,
  },
  xcodeName: {
    re: /^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$/,
    label: "an Xcode scheme/configuration/test plan name ([A-Za-z0-9_.-], single spaces)",
    forceable: true,
  },
  xcodeTestId: {
    re: /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.()-]+){0,2}$/,
    label: "an Xcode test identifier (Target[/Class[/method()]])",
    forceable: true,
  },
  androidPackage: {
    re: /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/,
    label: "an Android package name (e.g. com.example.app)",
    forceable: false,
  },
  androidActivity: {
    re: /^\.?[A-Za-z][A-Za-z0-9_.$]*$/,
    label: "an Android activity class name (e.g. .MainActivity)",
    forceable: false,
  },
  androidPermission: {
    re: /^[A-Za-z][A-Za-z0-9_.]*$/,
    label: "an Android permission name (e.g. android.permission.CAMERA)",
    forceable: false,
  },
  logcatFilter: {
    re: /^([A-Za-z0-9_.-]+|\*):[VDIWEFS]$/,
    label: "a logcat filter tag:level (e.g. MyTag:D, *:S)",
    forceable: false,
  },
  iosBundleId: {
    re: /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
    label: "an iOS bundle identifier (e.g. com.example.App)",
    forceable: false,
  },
  url: {
    re: /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s'"`;|&<>\\]*$/,
    label: "a URL without whitespace, quotes or shell metacharacters",
    forceable: false,
  },
  propKey: {
    re: /^[A-Za-z0-9_.-]{1,128}$/,
    label: "a property key ([A-Za-z0-9_.-], max 128 chars)",
    forceable: false,
  },
  snapshotName: {
    re: /^[A-Za-z0-9_.-]{1,64}$/,
    label: "a snapshot name ([A-Za-z0-9_.-], max 64 chars)",
    forceable: false,
  },
  stepId: {
    re: /^[A-Za-z0-9_.-]{1,64}$/,
    label: "a step id ([A-Za-z0-9_.-], max 64 chars)",
    forceable: false,
  },
  envKey: {
    re: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
    label: "an environment variable name",
    forceable: false,
  },
  // Values interpolated into a device-side remote shell command or forwarded as tool args.
  transportSafe: {
    re: /^[A-Za-z0-9_.:/@+=,-]{1,256}$/,
    label: "a transport-safe value ([A-Za-z0-9_.:/@+=,-], max 256 chars)",
    forceable: false,
  },
  // Claim version selectors, same grammar as `atc claim --api/--os`: 36, >=35, 34..36, 18.2, android-35.
  versionSpec: {
    re: /^(>=|<=|>|<|=)?[A-Za-z0-9._-]{1,32}(\.\.[A-Za-z0-9._-]{1,32})?$/,
    label: "a version spec (e.g. 36, >=35, 34..36, 18.2)",
    forceable: false,
  },
  // Arguments forwarded to the program being run (after `--` for bazel run, after the bundle id
  // for simctl launch). They cannot reach the tool's own option parser, so a leading "-" is fine.
  passthroughArg: {
    re: /^[A-Za-z0-9_.:/@+=,-]{1,256}$/,
    label: "a program argument ([A-Za-z0-9_.:/@+=,-], max 256 chars)",
    forceable: false,
    allowLeadingDash: true,
  },
});

// Windows: every argument passed through cmd.exe to a .bat/.cmd wrapper must match this.
export const WINDOWS_BATCH_ARG_RE = /^[A-Za-z0-9_.:/\\@+=,-]+$/;
// Windows: resolved wrapper path / cwd may contain spaces but no CMD expansion-sensitive chars.
export const WINDOWS_BATCH_PATH_FORBIDDEN_RE = /[%!^"&|<>\r\n\t\0]/;

export function isSafePathSyntax(value) {
  const s = String(value ?? "");
  return s.length > 0 && s.length <= 4096 && !/[\0\r\n]/.test(s) && !s.startsWith("-");
}

export function checkPattern(patternKey, value) {
  const p = PATTERNS[patternKey];
  if (!p) throw new Error(`Unknown pattern "${patternKey}"`);
  const s = String(value ?? "");
  if (s.startsWith("-") && !p.allowLeadingDash) return false;
  return p.re.test(s);
}

export function quoteRemote(value) {
  // Values are validated transport-safe (no quotes) before reaching this point.
  return `'${String(value)}'`;
}
