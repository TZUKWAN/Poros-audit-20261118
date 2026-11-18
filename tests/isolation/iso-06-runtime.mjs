/** Real DSH / real tools, deterministic test model. No host DSH or user volumes. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  runDshSession,
  deploymentScope,
  removeOwnedResource,
} from "../../src/server/dsh-runtime.ts";
import { createTestModel } from "../../scripts/poros-test-model.mjs";

process.env.POROS_DSH_MODEL_STUB = "1";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const run = (options) =>
  runDshSession({
    runId: randomUUID(),
    organizationId: "iso-a",
    agentId: "security-test",
    version: 1,
    taskId: randomUUID(),
    task: "boundary verification",
    ...options,
    grants: [{ kind: "MODEL", name: "deepseek-chat" }, ...(options.grants ?? [])],
  });
const hostile =
  "quotes '\"; $(touch /home/poros/INJECTED) `id`\nPOROS_TASK_EOF\ntouch /home/poros/INJECTED\n# 中文\u2028🙂\n" +
  "x".repeat(18000) +
  "中🙂".repeat(8000);
const data = await run({ task: hostile, grants: [] });
assert.equal(data.completed, true, data.error);
assert.ok(
  Number.isInteger(data.modelCalls) && data.modelCalls > 0,
  "actual DSH test-model steps must be accounted for",
);
assert.ok(
  data.events.some(
    (e) => e.type === "boundary" && e.taskHash === sha(hostile) && e.injected === false,
  ),
  "task must remain byte-identical data; sentinel must be absent",
);
console.log("PASS ISO-06 quotes/multiline/heredoc/Unicode/long task stays data");

for (const name of [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "working_directory",
  "web_search",
  "web_fetch",
  "skill",
  "mcp",
  "unknown_plugin",
]) {
  const denied = await run({
    grants: [],
    testCalls: [
      {
        name,
        arguments: { command: "touch /home/poros/INJECTED", description: "negative authorization" },
      },
    ],
  });
  assert.ok(
    denied.events.some((e) => e.type === "policy" && e.tool === name && e.authorized === false),
    `must deny ${name} before execution`,
  );
  assert.ok(denied.events.some((e) => e.type === "boundary" && e.injected === false));
  console.log(`PASS ISO-06 real DSH denies ${name} before tool body`);
}

let aContainer;
let unblock;
const ready = new Promise((resolve) => {
  unblock = resolve;
});
const a = run({
  organizationId: "iso-a",
  grants: [{ kind: "TOOL", name: "bash" }],
  testCalls: [
    {
      name: "bash",
      arguments: {
        command: "echo org-a-secret > private.txt; sleep 4; cat private.txt",
        description: "isolation sentinel",
      },
    },
  ],
  onEvent: async (e) => {
    if (e.type === "container") {
      aContainer = e.name;
      unblock();
    }
  },
});
await ready;
const meta = JSON.parse(execFileSync("docker", ["inspect", aContainer], { encoding: "utf8" }))[0];
assert.equal(meta.Config.Labels["org.poros.deployment"], deploymentScope());
assert.equal(meta.HostConfig.NetworkMode, "none");
assert.deepEqual(meta.HostConfig.ExtraHosts ?? [], []);
await removeOwnedResource(
  "container",
  aContainer,
  meta.Config.Labels["org.poros.run"],
  undefined,
  "another-deployment",
);
assert.equal(
  execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", aContainer], {
    encoding: "utf8",
  }).trim(),
  "true",
  "another deployment cannot delete this run",
);
const b = await run({
  organizationId: "iso-b",
  grants: [{ kind: "TOOL", name: "bash" }],
  testCalls: [
    {
      name: "bash",
      arguments: {
        command: "test ! -e /home/poros/work/private.txt && echo B-ISOLATED; ls /home/poros/work",
        description: "cross-organization isolation",
      },
    },
  ],
});
const aa = await a;
assert.ok(JSON.stringify(b.events).includes("B-ISOLATED"));
assert.ok(!JSON.stringify(b.events).includes("org-a-secret"));
assert.ok(JSON.stringify(aa.events).includes("org-a-secret"));
assert.equal(
  execFileSync("docker", ["ps", "-aq", "--filter", `name=^${aContainer}$`], {
    encoding: "utf8",
  }).trim(),
  "",
);
console.log("PASS ISO-06 concurrent organizations / bash / private workspace / automatic cleanup");
console.log("PASS ISO-06 cleanup refuses a different deployment's real container");

const ctrl = new AbortController();
let cancelName;
const cancelled = run({
  signal: ctrl.signal,
  grants: [{ kind: "TOOL", name: "bash" }],
  testCalls: [{ name: "bash", arguments: { command: "sleep 30", description: "cancellation" } }],
  onEvent: async (e) => {
    if (e.type === "container") cancelName = e.name;
    if (e.type === "tool_call") ctrl.abort();
  },
});
await assert.rejects(cancelled, /cancel|abort/i);
assert.equal(
  execFileSync("docker", ["ps", "-aq", "--filter", `name=^${cancelName}$`], {
    encoding: "utf8",
  }).trim(),
  "",
);
console.log("PASS ISO-06 cancellation kills container processes and removes resources");

let timeoutName,
  started = false;
await assert.rejects(
  run({
    timeoutMs: 8000,
    grants: [{ kind: "TOOL", name: "bash" }],
    testCalls: [
      {
        name: "bash",
        arguments: { command: "sleep 30", description: "real running tool deadline" },
      },
    ],
    onEvent: async (e) => {
      if (e.type === "container") timeoutName = e.name;
      if (e.type === "tool_call") started = true;
    },
  }),
  /timed out|abort|cancel/i,
);
assert.equal(started, true, "timeout test must actually enter the DSH tool loop");
assert.equal(
  execFileSync("docker", ["ps", "-aq", "--filter", `name=^${timeoutName}$`], {
    encoding: "utf8",
  }).trim(),
  "",
);
console.log("PASS ISO-06 real executing tool timeout terminates processes and cleans container");

const nativeCalls = [
  { name: "working_directory", arguments: {} },
  { name: "write", arguments: { file_path: "poros-tool-test.txt", content: "before-change\n" } },
  {
    name: "edit",
    arguments: {
      file_path: "poros-tool-test.txt",
      old_string: "before-change",
      new_string: "after-change",
    },
  },
  { name: "read", arguments: { file_path: "poros-tool-test.txt" } },
  { name: "glob", arguments: { pattern: "*.txt" } },
  { name: "grep", arguments: { pattern: "after-change", path: "." } },
];
const native = await run({
  grants: nativeCalls.map((call) => ({ kind: "TOOL", name: call.name })),
  testCalls: nativeCalls,
  testSequence: true,
});
const nativeResults = native.events.filter((event) => event.type === "tool_result");
assert.equal(nativeResults.length, nativeCalls.length, JSON.stringify(native.events));
const nativeMarkers = [
  "/home/poros/work",
  "poros-tool-test.txt",
  "poros-tool-test.txt",
  "after-change",
  "poros-tool-test.txt",
  "after-change",
];
for (const [i, result] of nativeResults.entries()) {
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.ok(JSON.stringify(result).includes(nativeMarkers[i]), JSON.stringify(result));
}
console.log(
  "PASS ISO-06 actual working_directory, write, edit, read, glob and grep execute in the same isolated workspace",
);

const revoked = await run({
  grants: [{ kind: "TOOL", name: "bash" }],
  authorizeTool: async () => {
    throw new Error("test policy was revoked while task was admitted");
  },
  testCalls: [
    {
      name: "bash",
      arguments: { command: "touch /home/poros/INJECTED", description: "real-time revocation" },
    },
  ],
});
assert.ok(
  revoked.events.some(
    (event) => event.type === "policy" && event.tool === "bash" && event.authorized === false,
  ),
);
assert.ok(revoked.events.some((event) => event.type === "boundary" && event.injected === false));
console.log(
  "PASS ISO-06 live authorization refusal prevents native tool execution with frozen grant",
);

const brokerCalls = [
  { name: "web_search", arguments: { query: "Poros test query" } },
  { name: "web_fetch", arguments: { url: "https://example.com/" } },
  { name: "poros_skill_review", arguments: {} },
  { name: "poros_knowledge_project_file", arguments: {} },
];
const brokerInputs = [];
const broker = await run({
  grants: [
    { kind: "TOOL", name: "web.search" },
    { kind: "TOOL", name: "web.fetch" },
    { kind: "SKILL", name: "review", source: "poros-catalog:test-review", version: "1" },
    { kind: "KNOWLEDGE", name: "project_file", source: "poros-catalog:test-file", version: "1" },
  ],
  brokerTools: brokerCalls.map((c) => ({
    name: c.name,
    description: "Explicit tool transport fixture",
    input: Object.fromEntries(Object.keys(c.arguments).map((key) => [key, "string"])),
  })),
  invokeTool: async (name, args) => {
    brokerInputs.push({ name, arguments: args });
    return { ok: true, items: [{ title: "test-tool-transport:" + name }] };
  },
  testCalls: brokerCalls,
  testSequence: true,
});
assert.deepEqual(brokerInputs, brokerCalls);
for (const call of brokerCalls)
  assert.ok(
    broker.events.some(
      (e) =>
        e.type === "tool_result" && JSON.stringify(e).includes("test-tool-transport:" + call.name),
    ),
  );
console.log(
  "PASS ISO-06 DSH invokes exact registered web, Skill and Knowledge tools through attached streams (explicit provider contract fixture)",
);

// Real container, DSH and tool execution through an OpenAI wire-contract fixture.
const model = "custom-contract-chat";
const apiKey = randomUUID();
const upstream = await createTestModel(undefined, { model, apiKey, port: 0 });
const baseUrl = "http://127.0.0.1:" + upstream.address().port + "/v1";
const oldBases = process.env.POROS_LOCAL_MODEL_BASES;
try {
  process.env.POROS_LOCAL_MODEL_BASES = baseUrl;
  process.env.POROS_DSH_MODEL_STUB = "0";
  const runResult = await runDshSession({
    task: "Run the granted fixture tool",
    runId: randomUUID(),
    organizationId: "iso-model",
    agentId: "iso-model-agent",
    taskId: randomUUID(),
    model: { model, baseUrl, apiKey },
    grants: [
      { kind: "MODEL", name: model, source: "personal-openai-compatible:" + baseUrl },
      { kind: "TOOL", name: "bash" },
    ],
    timeoutMs: 45000,
    onEvent: async (event) => {
      if (event.type !== "container") return;
      const actual = JSON.parse(
        execFileSync("docker", ["inspect", event.name], { encoding: "utf8" }),
      )[0];
      assert.equal(actual.HostConfig.NetworkMode, "none");
      assert.deepEqual(actual.HostConfig.ExtraHosts ?? [], []);
      assert.ok(actual.Mounts.every((mount) => mount.Type !== "bind"));
    },
  });
  assert.equal(
    runResult.completed,
    true,
    JSON.stringify({ error: runResult.error, diagnostics: runResult.diagnostics }),
  );
  assert.equal(runResult.modelChannel, "configured");
  assert.equal(runResult.modelCalls, 2);
  assert.ok(
    runResult.events.some(
      (event) =>
        event.type === "tool_result" && String(event.result).includes("POROS-DSH-REAL-EXEC"),
    ),
  );
  assert.ok(!JSON.stringify(runResult).includes(apiKey));
  console.log(
    "PASS ISO-06 actual DSH with no network reaches its frozen custom model through the Docker attached stream (explicit OpenAI contract fixture)",
  );
} finally {
  if (oldBases === undefined) delete process.env.POROS_LOCAL_MODEL_BASES;
  else process.env.POROS_LOCAL_MODEL_BASES = oldBases;
  process.env.POROS_DSH_MODEL_STUB = "1";
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
}
