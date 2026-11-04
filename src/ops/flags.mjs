// Caller-supplied tool flags (see docs/scope.md §2.1 "Flags").
//
// ATC does not keep a per-version list of valid Bazel or Gradle flags: the tool itself rejects
// flags it does not know. ATC only checks the token shape (src/ops/patterns.mjs) and refuses the
// small set of flags that would defeat what ATC owns: host resource caps, daemon/server lifecycle,
// and the workspace identity used for locks. Everything else is the caller's responsibility and
// is recorded as a forced run.

const BAZEL_OWNED = new Map([
  ["jobs", "ATC sets --jobs from the build lease so concurrent builds share the host's CPUs."],
  ["local_resources", "ATC owns host resource caps; concurrent builds rely on them."],
  ["local_ram_resources", "ATC owns host resource caps; RAM is admitted by ATC before the build starts."],
  ["local_cpu_resources", "ATC owns host resource caps; concurrent builds rely on them."],
  ["ram_utilization_factor", "ATC owns host resource caps; RAM is admitted by ATC before the build starts."],
]);

// Redirect only where a second spelling would behave differently (configs are placed before
// flags so explicit flags win over a config; exclusions need the "--" target-pattern section).
const BAZEL_USE_PARAM = new Map([["config", "configs"]]);

const GRADLE_OWNED = new Map([
  ["--max-workers", "ATC sets the worker cap from the build lease so concurrent builds share the host's CPUs."],
  ["-Dorg.gradle.workers.max", "ATC sets the worker cap from the build lease so concurrent builds share the host's CPUs."],
  ["--daemon", "Gradle daemons are shared across sessions and ATC owns their lifecycle."],
  ["--no-daemon", "Gradle daemons are shared across sessions and ATC owns their lifecycle."],
  ["--foreground", "Gradle daemons are shared across sessions and ATC owns their lifecycle."],
  ["--stop", "Stopping Gradle daemons is hard-denied: other sessions may be using them."],
  ["--status", "Daemon status is not a build; it does not belong in a build op."],
  ["-Dorg.gradle.daemon", "Gradle daemons are shared across sessions and ATC owns their lifecycle."],
  ["--continuous", "Continuous mode never finishes, so it would hold the build slot forever."],
  ["-Dorg.gradle.jvmargs", "Daemon JVM args decide daemon reuse and ATC's heap accounting; set them in gradle.properties."],
  ["--project-dir", "ATC resolves the project root to pick the workspace lock; use the workspace param."],
  ["--settings-file", "The settings file decides the build root, which ATC resolves to pick the workspace lock; use the workspace param."],
  ["--build-file", "The build file decides the build root, which ATC resolves to pick the workspace lock; use the workspace param."],
  ["--include-build", "An included build is another workspace that ATC has not locked; declare it in settings.gradle(.kts) or build it separately."],
  ["--gradle-user-home", "The Gradle user home is shared state ATC accounts for; it cannot change per build."],
  ["-Dgradle.user.home", "The Gradle user home is shared state ATC accounts for; it cannot change per build."],
]);

const GRADLE_USE_PARAM = new Map([["--exclude-task", "excludeTasks"]]);

function flagName(flag) {
  const s = String(flag);
  // Gradle's long alias for -D: --system-prop=key=value is checked as -Dkey.
  const sysProp = /^--system-prop=([^=]*)/.exec(s);
  if (sysProp) return `-D${sysProp[1]}`;
  const eq = s.indexOf("=");
  return eq === -1 ? s : s.slice(0, eq);
}

function ownedError(path, flag, why) {
  return {
    path,
    code: "flag_owned_by_atc",
    message: `${JSON.stringify(String(flag))} is managed by ATC. ${why}`,
    hint: "Remove this flag. It cannot be overridden, even with --force.",
  };
}

function useParamError(path, flag, param) {
  return {
    path,
    code: "flag_has_param",
    message: `${JSON.stringify(String(flag))} has a typed param.`,
    hint: `Use "${param}" instead of passing it in flags.`,
  };
}

// Returns validation errors for a list of caller-supplied flags. `tool` is "bazel" or "gradle".
export function checkToolFlags(tool, flags, basePath) {
  const errors = [];
  (flags || []).forEach((flag, i) => {
    const p = `${basePath}/${i}`;
    const name = flagName(flag);
    if (tool === "bazel") {
      const bare = name.replace(/^--/, "");
      // Bazel accepts --noX for boolean X; --nojobs and friends still target an owned flag.
      const stripped = bare.startsWith("no") ? bare.slice(2) : null;
      const positive = stripped && (BAZEL_OWNED.has(stripped) || BAZEL_USE_PARAM.has(stripped)) ? stripped : bare;
      if (BAZEL_OWNED.has(positive)) errors.push(ownedError(p, flag, BAZEL_OWNED.get(positive)));
      else if (BAZEL_USE_PARAM.has(positive)) errors.push(useParamError(p, flag, BAZEL_USE_PARAM.get(positive)));
      return;
    }
    if (tool === "gradle") {
      if (GRADLE_OWNED.has(name)) errors.push(ownedError(p, flag, GRADLE_OWNED.get(name)));
      else if (GRADLE_USE_PARAM.has(name)) errors.push(useParamError(p, flag, GRADLE_USE_PARAM.get(name)));
    }
  });
  return errors;
}
