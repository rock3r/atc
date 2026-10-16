import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_TOOLS, handleMcpRequest } from "../src/mcp.mjs";

const posix = process.platform !== "win32";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atc-mcp-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "gradlew"), '#!/bin/sh\necho "SESSION=$ATC_SESSION_ID ARGS=$*"\n');
  fs.chmodSync(path.join(proj, "gradlew"), 0o755);
  return { root, stateDir, proj, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function call(stateDir, name, args, sessionOptions) {
  return handleMcpRequest(stateDir, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, sessionOptions);
}

test("mcp: op family tools and atc_batch are listed; no raw command tool exists", () => {
  const names = MCP_TOOLS.map((t) => t.name);
  for (const n of ["atc_gradle", "atc_bazel", "atc_xcode", "atc_android", "atc_ios", "atc_batch", "atc_snapshot", "atc_claim"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => /exec|shell|command|guard/.test(n)));
  const android = MCP_TOOLS.find((t) => t.name === "atc_android");
  assert.ok(android.inputSchema.properties.operation.enum.includes("prop.set"));
});

test("mcp: atc_gradle runs under the MCP session identity and captures output", { skip: !posix }, async () => {
  const s = setup();
  try {
    const reply = await call(s.stateDir, "atc_gradle", { operation: "tasks", params: { tasks: ["assembleDebug"] } }, { sessionId: "agent-42", cwd: s.proj, env: { ...process.env } });
    const res = JSON.parse(reply.result.content[0].text);
    assert.equal(reply.result.isError, false, res.error);
    assert.match(res.stdout, /^SESSION=agent-42 ARGS=assembleDebug -Dorg\.gradle\.workers\.max=\d+/);
  } finally {
    s.cleanup();
  }
});

test("mcp: invalid params come back as structured errors", async () => {
  const s = setup();
  try {
    const reply = await call(s.stateDir, "atc_gradle", { operation: "tasks", params: { tasks: ["a;b"], shell: "rm -rf /" } }, { sessionId: "agent-1", cwd: s.proj });
    assert.equal(reply.result.isError, true);
    const res = JSON.parse(reply.result.content[0].text);
    assert.deepEqual(res.errors.map((e) => e.code).sort(), ["pattern_mismatch", "unknown_field"]);
    const unknownOp = await call(s.stateDir, "atc_gradle", { operation: "exec", params: {} }, { sessionId: "agent-1", cwd: s.proj });
    assert.equal(JSON.parse(unknownOp.result.content[0].text).errors[0].code, "unknown_op");
  } finally {
    s.cleanup();
  }
});

test("mcp: atc_batch validate returns exact invocations", { skip: !posix }, async () => {
  const s = setup();
  try {
    const reply = await call(
      s.stateDir,
      "atc_batch",
      { plan: { version: 1, steps: [{ id: "a", op: "gradle.tasks", tasks: ["lint"] }] }, validate: true },
      { sessionId: "agent-7", cwd: s.proj },
    );
    const res = JSON.parse(reply.result.content[0].text);
    assert.equal(reply.result.isError, false, res.error);
    assert.deepEqual(res.steps[0].invocations[0].args, ["lint"]);
  } finally {
    s.cleanup();
  }
});
