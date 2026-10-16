// ATC 3.0 contracts: no shell anywhere, lock boundary, packaged surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withLock } from "../src/lock.mjs";
import { runCommandSync, spawnWithHeartbeat } from "../src/spawn.mjs";
import { cmdBatch, cmdExec } from "../src/cli.mjs";
const HOST = { totalRamMb: 65536, availableRamMb: 32768, freeDiskMb: 100000, cpuCores: 8 };

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const posix = process.platform !== "win32";

function listFiles(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(rel, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

test("contract: no source module spawns through a shell or evaluates shell text", () => {
  for (const f of listFiles("src", [".mjs"])) {
    const src = read(f);
    assert.ok(!/shell:\s*true/.test(src), `${f} uses shell: true`);
    assert.ok(!/["'`](?:sh|bash|zsh)["'`]\s*,\s*\[\s*["'`]-c["'`]/.test(src), `${f} builds a sh -c invocation`);
    assert.ok(!/from\s+["']\.\/guard\.mjs["']/.test(src), `${f} imports the removed guard`);
  }
  assert.ok(!fs.existsSync(path.join(repo, "src/guard.mjs")), "guard.mjs is gone");
});

test("contract: packaged pi extension does not intercept tool calls or call atc guard", () => {
  const ext = read("extensions/atc/index.ts");
  assert.ok(!/tool_call/.test(ext), "no tool_call listener");
  assert.ok(!/["']guard["']/.test(ext), "no atc guard invocation");
  assert.match(ext, /session_shutdown/);
});

test("contract: hook manifests only invoke `atc hook` entry points", () => {
  for (const f of ["hooks/hooks.json", "hooks.json", ".cursor/hooks.json"]) {
    const txt = read(f);
    assert.ok(!/'guard'|"guard"|atc guard/.test(txt), `${f} references guard`);
    assert.match(txt, /'hook'/, `${f} uses atc hook`);
  }
});

test("lock boundary: spawning while holding atc.lock throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atc-lockb-"));
  const prev = process.env.ATC_ASSERT_LOCK_BOUNDARY;
  try {
    assert.throws(
      () => withLock(dir, () => spawnWithHeartbeat(process.execPath, ["-v"], null, "s", () => {}, {})),
      /lock-boundary violation/,
    );
    process.env.ATC_ASSERT_LOCK_BOUNDARY = "1";
    assert.throws(() => withLock(dir, () => runCommandSync(process.execPath, ["-v"])), /lock-boundary violation/);
    assert.equal(runCommandSync(process.execPath, ["-e", "process.exit(0)"]).status, 0, "fine outside the lock");
  } finally {
    if (prev === undefined) delete process.env.ATC_ASSERT_LOCK_BOUNDARY;
    else process.env.ATC_ASSERT_LOCK_BOUNDARY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lock boundary: exec and batch flows never spawn under atc.lock", { skip: !posix }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atc-lockb-flow-"));
  const prev = process.env.ATC_ASSERT_LOCK_BOUNDARY;
  process.env.ATC_ASSERT_LOCK_BOUNDARY = "1";
  try {
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    const proj = path.join(root, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "gradlew"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(proj, "gradlew"), 0o755);
    const env = { ...process.env };
    const one = await cmdExec(stateDir, ["gradle", "tasks", "build", "--json"], { env, cwd: proj, host: HOST });
    assert.equal(one.exitCode, 0, one.error);
    const batch = await cmdBatch(
      stateDir,
      { session: "lb", json: true },
      { env, cwd: proj, host: HOST, plan: { version: 1, steps: [{ id: "a", op: "gradle.tasks", tasks: ["lint"] }, { id: "b", op: "gradle.tasks", tasks: ["test"], dependsOn: ["a"] }] } },
    );
    assert.equal(batch.exitCode, 0, batch.error);
  } finally {
    if (prev === undefined) delete process.env.ATC_ASSERT_LOCK_BOUNDARY;
    else process.env.ATC_ASSERT_LOCK_BOUNDARY = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contract: cross-agent destructive actions are not in the catalog", async () => {
  const { OPS } = await import("../src/ops/catalog.mjs");
  const names = Object.keys(OPS).join(" ");
  for (const banned of ["stop", "shutdown", "kill", "reboot", "killServer", "daemon"]) {
    assert.ok(!new RegExp(`\\.${banned}\\b`, "i").test(names), `catalog must not expose ${banned}`);
  }
  for (const op of Object.values(OPS)) {
    for (const [k, spec] of Object.entries(op.params)) {
      assert.notEqual(spec.type, "rawArgs", `${op.name}.${k}`);
    }
  }
});
