import { access, readFile } from "node:fs/promises";
import { ATC_VERSION } from "../src/cli.mjs";

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));

const [
  packageManifest,
  portableManifest,
  codexManifest,
  claudeManifest,
  skillSource,
  skillMarkdown,
  mcpSource,
] = await Promise.all([
  readJson("package.json"),
  readJson("plugin.json"),
  readJson(".codex-plugin/plugin.json"),
  readJson(".claude-plugin/plugin.json"),
  readJson("skills/atc/skill-source.json"),
  readFile("skills/atc/SKILL.md", "utf8"),
  readFile("src/mcp.mjs", "utf8"),
]);

const expectedPluginName = "atc";
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const expectedTag = `v${packageManifest.version}`;
const refName = process.env.GITHUB_REF_NAME;
const actualTag =
  process.argv[2] ?? (refName && refName.startsWith("v") ? refName : expectedTag);

if (packageManifest.name !== "@rock3r/atc") {
  throw new Error(`package.json name must be @rock3r/atc, got ${packageManifest.name}`);
}
if (!semanticVersion.test(packageManifest.version)) {
  throw new Error(`package.json version must be strict semver, got ${packageManifest.version}`);
}
if (packageManifest.private === true) {
  throw new Error("npm package must not be private");
}
if (packageManifest.publishConfig?.access !== "public") {
  throw new Error("npm package must publish publicly");
}
if (packageManifest.publishConfig?.provenance !== true) {
  throw new Error("npm package must enable provenance in publishConfig");
}
if (actualTag !== expectedTag) {
  throw new Error(`release tag ${actualTag ?? "<missing>"} must equal ${expectedTag}`);
}

if (
  portableManifest.version !== packageManifest.version ||
  codexManifest.version !== packageManifest.version ||
  claudeManifest.version !== packageManifest.version
) {
  throw new Error("npm and all plugin manifest versions must match");
}
if (
  portableManifest.name !== expectedPluginName ||
  codexManifest.name !== expectedPluginName ||
  claudeManifest.name !== expectedPluginName
) {
  throw new Error(`all plugin manifest names must be ${expectedPluginName}`);
}
if (portableManifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
  throw new Error("portable plugin must target Agent Plugins 1.0.0");
}
if (
  portableManifest.skills !== "./skills/" ||
  codexManifest.skills !== "./skills/" ||
  claudeManifest.skills !== "./skills/"
) {
  throw new Error("Portable, Codex, and Claude plugin manifests must expose ./skills/");
}

const frontmatterVersionMatch = skillMarkdown.match(/^---\r?\n[\s\S]*?\r?\n  version:\s*"([^"]+)"[\s\S]*?\r?\n---/);
const skillFrontmatterVersion = frontmatterVersionMatch?.[1];
if (skillFrontmatterVersion !== packageManifest.version) {
  throw new Error(
    `skills/atc/SKILL.md metadata.version (${skillFrontmatterVersion ?? "<missing>"}) must equal ${packageManifest.version}`,
  );
}

const forbiddenProvenanceKeys = new Set([
  "gitEvidence",
  "recentHistory",
  "evidence",
  "reviewNote",
  "commitSubject",
  "commitSubjects",
  "confidence",
  "confidenceLabel",
  "diagnostics",
  "reviewDiagnostics",
]);
function checkForbiddenKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) checkForbiddenKeys(item);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (forbiddenProvenanceKeys.has(k)) {
        throw new Error(`skills/atc/skill-source.json contains forbidden key: ${k}`);
      }
      checkForbiddenKeys(v);
    }
  }
}
checkForbiddenKeys(skillSource);

if (
  skillSource.schemaVersion !== 1 ||
  skillSource.skill !== "atc" ||
  !Array.isArray(skillSource.sources) ||
  skillSource.sources.length === 0
) {
  throw new Error("skills/atc/skill-source.json must conform to skill-provenance schema v1");
}
const primarySource = skillSource.sources[0];
if (
  primarySource.type !== "local-original-content" ||
  primarySource.role !== "original-content" ||
  primarySource.versionSource !== "frontmatter" ||
  primarySource.version !== packageManifest.version ||
  primarySource.license !== packageManifest.license
) {
  throw new Error(
    `skills/atc/skill-source.json primary source version/metadata must match ${packageManifest.version}`,
  );
}

if (ATC_VERSION !== packageManifest.version) {
  throw new Error(`src/cli.mjs ATC_VERSION (${ATC_VERSION}) must equal ${packageManifest.version}`);
}
const mcpVersionMatch = mcpSource.match(
  /serverInfo:\s*\{\s*name:\s*"android-traffic-control",\s*version:\s*"([^"]+)"/,
);
if (mcpVersionMatch?.[1] !== packageManifest.version) {
  throw new Error(`src/mcp.mjs serverInfo.version must equal ${packageManifest.version}`);
}

await Promise.all([
  access("skills/atc/SKILL.md"),
  access("skills/atc/skill-source.json"),
  access("skills/atc/references/install.md"),
  ...(packageManifest.files ?? []).map((entry) => access(entry)),
]);

process.stdout.write(`release metadata verified: ${expectedTag}\n`);
