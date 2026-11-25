/** Deterministic MODEL fixture. Real DSH and real tool bodies; production refuses fixtures. */
import http from "node:http";
export async function createTestModel(
  calls = [
    {
      name: "bash",
      arguments: { command: "echo POROS-DSH-REAL-EXEC", description: "verify real tool execution" },
    },
  ],
  options = {},
) {
  const model = options.model ?? "poros-stub";
  const server = http.createServer(async (req, res) => {
    if (options.apiKey && req.headers.authorization !== "Bearer " + options.apiKey) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body),
      completed = (input.messages ?? []).filter((m) => m.role === "tool").length;
    const batch = options.sequence ? calls.slice(completed, completed + 1) : completed ? [] : calls;
    if (options.model && input.model !== model) {
      res.writeHead(400).end("Unexpected model in contract fixture");
      return;
    }
    const probe =
      input.messages?.length === 1 && typeof input.messages[0].content === "string"
        ? input.messages[0].content.match(
            /^Output this verification code alone: (POROS-[0-9a-f]{8})$/,
          )?.[1]
        : null;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "model-fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (probe) {
      send({ role: "assistant", content: probe });
      send({}, "stop");
    } else if (batch.length) {
      send({
        role: "assistant",
        tool_calls: batch.map((c, i) => ({
          index: i,
          id: `call-${completed + i}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });
      send({}, "tool_calls");
    } else {
      const messages = (input.messages ?? [])
        .map((message) => JSON.stringify(message.content ?? ""))
        .join("\n");
      const excerpts = [
        ...new Set(messages.match(/POROS-PC-(?:WORD|EXCEL|MD|PDF|PERSONA)-[a-f0-9]{8}/g) ?? []),
      ];
      send({
        role: "assistant",
        content:
          "POROS-DSH-OK — deterministic test MODEL response; execution is verified only by actual tool_result events." +
          (excerpts.length ? "\nFixture received: " + excerpts.join(", ") : ""),
      });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 9919, "127.0.0.1", resolve);
  });
  return server;
}
