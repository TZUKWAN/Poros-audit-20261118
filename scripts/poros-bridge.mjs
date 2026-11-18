import http from "node:http";
import { randomUUID } from "node:crypto";

/** The container communicates with Poros over its attached Docker streams. */
export async function createBridge(lines, key, event) {
  const responses = new Map();
  const accept = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const req = responses.get(message.id);
    if (!req || message.type !== "bridge.reply") return;
    if (message.abort) {
      responses.delete(message.id);
      req.destroy();
      return;
    }
    if (message.status !== undefined)
      req.writeHead(message.status, {
        "content-type": message.contentType || "application/json",
        "cache-control": "no-store",
      });
    if (message.chunk) req.write(Buffer.from(message.chunk, "base64"));
    if (message.done) {
      responses.delete(message.id);
      req.end();
    }
  };
  lines.on("line", accept);
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + key) {
      res.writeHead(401).end();
      return;
    }
    const route =
      req.url === "/v1/chat/completions"
        ? "model"
        : req.url === "/tool"
          ? "tool"
          : req.url === "/authorize"
            ? "authorize"
            : "";
    if (!route || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    if (responses.size >= 4) {
      res.writeHead(429).end();
      return;
    }
    let raw = "",
      size = 0;
    req.setEncoding("utf8");
    try {
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 256000) {
          res.writeHead(413).end();
          return;
        }
        raw += chunk;
      }
      const id = randomUUID();
      responses.set(id, res);
      res.once("close", () => {
        if (responses.delete(id)) event({ type: "bridge.cancel", id });
      });
      event({ type: "bridge.request", route, id, body: JSON.parse(raw) });
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(9918, "127.0.0.1", resolve);
  });
  return () => {
    lines.off("line", accept);
    server.closeAllConnections();
    server.close();
  };
}
