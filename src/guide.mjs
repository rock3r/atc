import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUIDES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "guides");

export const GUIDE_TOPICS = Object.freeze([
  "workflow",
  "profiles",
  "snapshots",
  "multi-agent",
  "traps",
]);

const GUIDE_ALIASES = Object.freeze({
  default: "workflow",
  overview: "workflow",
  quickstart: "workflow",
  help: "workflow",
  profile: "profiles",
  device: "profiles",
  devices: "profiles",
  physical: "profiles",
  fleet: "profiles",
  snapshot: "snapshots",
  reset: "snapshots",
  wipe: "snapshots",
  resources: "snapshots",
  multiagent: "multi-agent",
  queue: "multi-agent",
  hook: "multi-agent",
  hooks: "multi-agent",
  guard: "multi-agent",
  mcp: "multi-agent",
  concurrency: "multi-agent",
  trap: "traps",
  troubleshooting: "traps",
  errors: "traps",
  "exit-codes": "traps",
});

export function resolveGuideTopic(rawTopic) {
  if (!rawTopic || !String(rawTopic).trim()) {
    return "workflow";
  }
  const normalized = String(rawTopic).trim().toLowerCase();
  if (GUIDE_TOPICS.includes(normalized)) {
    return normalized;
  }
  if (Object.prototype.hasOwnProperty.call(GUIDE_ALIASES, normalized)) {
    return GUIDE_ALIASES[normalized];
  }
  return null;
}

export function cmdGuide(rawTopic = "workflow") {
  const topic = resolveGuideTopic(rawTopic);
  if (!topic) {
    return {
      exitCode: 1,
      error: `Unknown guide "${rawTopic}": choose one of ${GUIDE_TOPICS.join(", ")}.`,
    };
  }
  const filePath = path.join(GUIDES_DIR, `${topic}.md`);
  const text = fs.readFileSync(filePath, "utf8");
  return {
    exitCode: 0,
    topic,
    topics: [...GUIDE_TOPICS],
    text,
  };
}
