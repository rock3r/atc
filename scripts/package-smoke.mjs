import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options });
  if (result.error) throw result.error;
  return result;
}

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    const quoted = ["npm", ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
    const result = spawnSync(quoted, { encoding: "utf8", shell: comspec, ...options });
    if (result.error) throw result.error;
    return result;
  }
  return run("npm", args, options);
}

function runWindowsCmdShim(shim, args, options = {}) {
  if (/["\r\n&|<>^%!]/.test(shim) || args.some((argument) => !/^[a-z-]+$/.test(argument))) {
    throw new Error("Windows smoke command contains unsupported cmd.exe metacharacters");
  }
  const comspec = process.env.ComSpec ?? process.env.COMSPEC;
  if (!comspec) throw new Error("Windows smoke requires ComSpec");
  const result = spawnSync(`"${shim}" ${args.join(" ")}`, {
    encoding: "utf8",
    shell: comspec,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

async function findTarball(candidate) {
  const absolute = path.resolve(candidate);
  const entries = await readdir(absolute).catch(() => undefined);
  if (entries === undefined) return absolute;
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected exactly one package tarball in ${absolute}, found ${tarballs.length}`,
    );
  }
  return path.join(absolute, tarballs[0]);
}

const root = await mkdtemp(path.join(os.tmpdir(), "atc-package-smoke-"));
try {
  let tarball;
  if (process.argv[2]) {
    tarball = await findTarball(process.argv[2]);
  } else {
    const packed = runNpm(["pack", "--silent", "--pack-destination", root], {
      cwd: process.cwd(),
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    tarball = await findTarball(root);
  }

  const prefix = path.join(root, "install");
  const installed = runNpm([
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    prefix,
    tarball,
  ]);
  if (installed.status !== 0) throw new Error(`tarball install failed: ${installed.stderr}`);

  const packageRoot =
    process.platform === "win32"
      ? path.join(prefix, "node_modules", "@rock3r", "atc")
      : path.join(prefix, "lib", "node_modules", "@rock3r", "atc");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const sourceManifest = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  );
  if (manifest.name !== "@rock3r/atc" || manifest.version !== sourceManifest.version) {
    throw new Error(`unexpected installed package identity: ${manifest.name}@${manifest.version}`);
  }

  const requiredFiles = [
    ["bin", "atc.mjs"],
    ["plugin.json"],
    [".codex-plugin", "plugin.json"],
    [".claude-plugin", "plugin.json"],
    [".agents", "plugins", "marketplace.json"],
    [".claude-plugin", "marketplace.json"],
    [".mcp.json"],
    ["skills", "atc", "SKILL.md"],
    ["skills", "atc", "skill-source.json"],
    ["skills", "atc", "references", "install.md"],
    ["docs", "user-guide.md"],
    ["docs", "architecture.md"],
    ["assets", "icon.svg"],
    ["assets", "logo.svg"],
    ["README.md"],
    ["DESIGN.md"],
    ["LICENSE"],
    ["privacy.md"],
  ];
  await Promise.all(
    requiredFiles.map((segments) => access(path.join(packageRoot, ...segments))),
  );

  const primaryCli = path.join(packageRoot, "bin", "atc.mjs");
  const versionRun = run(process.execPath, [primaryCli, "--version"]);
  if (
    versionRun.status !== 0 ||
    versionRun.stdout.trim() !== manifest.version ||
    versionRun.stderr.length > 0
  ) {
    throw new Error(
      `packaged atc --version failed: ${versionRun.stderr || versionRun.stdout}`,
    );
  }

  const helpRun = run(process.execPath, [primaryCli, "--help"]);
  if (
    helpRun.status !== 0 ||
    !helpRun.stdout.includes("atc guide [workflow|profiles|snapshots|multi-agent|traps]") ||
    helpRun.stderr.length > 0
  ) {
    throw new Error(`packaged atc --help failed: ${helpRun.stderr || helpRun.stdout}`);
  }

  const guideRun = run(process.execPath, [primaryCli, "guide"]);
  if (
    guideRun.status !== 0 ||
    !guideRun.stdout.includes("# atc workflow guide") ||
    guideRun.stderr.length > 0
  ) {
    throw new Error(`packaged atc guide failed: ${guideRun.stderr || guideRun.stdout}`);
  }

  const guideJsonRun = run(process.execPath, [primaryCli, "guide", "traps", "--json"]);
  if (guideJsonRun.status !== 0 || guideJsonRun.stderr.length > 0) {
    throw new Error(
      `packaged atc guide traps --json failed: ${guideJsonRun.stderr || guideJsonRun.stdout}`,
    );
  }
  const guidePayload = JSON.parse(guideJsonRun.stdout);
  if (guidePayload.topic !== "traps" || !guidePayload.text?.includes("ANDROID_SERIAL")) {
    throw new Error(`unexpected packaged guide JSON payload: ${guideJsonRun.stdout}`);
  }

  if (process.platform === "win32") {
    const shim = path.join(prefix, "atc.cmd");
    await access(shim);
    const shimVersion = runWindowsCmdShim(shim, ["--version"]);
    if (shimVersion.status !== 0 || shimVersion.stdout.trim() !== manifest.version) {
      throw new Error(
        `packaged Windows atc.cmd --version failed: ${shimVersion.stderr || shimVersion.stdout}`,
      );
    }
  } else {
    const shim = path.join(prefix, "bin", "atc");
    await access(shim);
    const shimVersion = run(shim, ["--version"]);
    if (shimVersion.status !== 0 || shimVersion.stdout.trim() !== manifest.version) {
      throw new Error(
        `packaged POSIX atc --version shim failed: ${shimVersion.stderr || shimVersion.stdout}`,
      );
    }
  }

  process.stdout.write(`packed artifact smoke passed: ${manifest.name}@${manifest.version}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
