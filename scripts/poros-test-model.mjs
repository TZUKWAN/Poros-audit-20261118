/** Deterministic MODEL fixture. Real DSH and real tool bodies; production refuses fixtures. */
import http from "node:http";
export async function createTestModel(
  calls = [
    {
      name: "bash",
      arguments: { command: "echo POROS-DSH-REAL-EXEC", description: "verify real tool execution" },
    },
  ],
) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body),
      hasResult = input.messages?.some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "model-fixture", object: "chat.completion.chunk", model: "poros-stub", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (!hasResult && calls.length) {
      send({
        role: "assistant",
        tool_calls: calls.map((c, i) => ({
          index: i,
          id: `call-${i}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });
      send({}, "tool_calls");
    } else {
      send({
        role: "assistant",
        content:
          "POROS-DSH-OK — deterministic test MODEL response; execution is verified only by actual tool_result events.",
      });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(9919, "127.0.0.1", resolve);
  });
  return server;
}
