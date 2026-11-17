/** Fixed entrypoint. Input is JSON data; fixed paths, fixed executable/argv, no shell. */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createTestModel } from "./poros-test-model.mjs";
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 256000) throw new Error("Input quota exceeded");
}
const input = JSON.parse(raw);
await mkdir("/home/poros/work", { recursive: true, mode: 0o700 });
await mkdir("/home/poros/.dsh", { recursive: true, mode: 0o700 });
await writeFile("/home/poros/patch.json", input.patch, { mode: 0o400 });
await writeFile("/home/poros/task.txt", input.task, { mode: 0o400 });
const model = input.stub ? await createTestModel(input.testCalls) : null;
const event = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const deadline = setTimeout(
  () => {
    event({ type: "error", message: "Container runtime deadline exceeded" });
    process.exit(124);
  },
  Math.min(300000, Math.max(500, input.timeoutMs ?? 180000)),
);
event({ type: "container", name: input.container });
const child = spawn(
  "dsh",
  ["--patch", "/home/poros/patch.json", "--profile", "headless", "--json", "-"],
  {
    cwd: "/home/poros/work",
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      DSH_TELEMETRY_MODE: "OFF",
      POROS_MODEL_KEY: input.key,
      POROS_EXECUTION_POLICY: JSON.stringify({
        allowedTools: input.allowedTools,
        context: input.context,
      }),
    },
  },
);
child.stdin.end(input.task);
child.on("error", (error) => {
  clearTimeout(deadline);
  event({ type: "error", message: error.message });
  model?.close();
  process.exitCode = 1;
});
child.on("close", async (code) => {
  clearTimeout(deadline);
  const task = await readFile("/home/poros/task.txt");
  let injected = false;
  try {
    await access("/home/poros/INJECTED");
    injected = true;
  } catch {}
  if (input.stub)
    event({
      type: "boundary",
      taskHash: createHash("sha256").update(task).digest("hex"),
      injected,
    });
  model?.close();
  process.exitCode = code ?? 1;
});
