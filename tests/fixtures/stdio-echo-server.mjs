// 测试用最小 stdio JSON-RPC (MCP) 服务器：initialize → tools/call(echo)
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 1) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "echo-test", version: "0.0.1" } } })}\n`,
    );
  } else if (msg.id === 2) {
    const args = msg.params?.arguments ?? {};
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] } })}\n`,
    );
  }
});
