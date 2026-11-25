import { createServer as createHttp, request } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";

const folder = process.argv[2];
if (!folder) throw new Error("Provide the Poros TLS directory");
const [key, cert, trust] = await Promise.all([
  readFile(path.join(folder, "server.key")),
  readFile(path.join(folder, "server.crt")),
  readFile(path.join(folder, "poros-mobile-ca.cer")),
]);
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function forwardingHeaders(headers) {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.connection || "").split(",").map((value) => value.trim().toLowerCase()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

function bridge(req, res) {
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
    res.writeHead(400).end();
    return;
  }
  if (req.url === "/mobile-trust.cer" && req.method === "GET") {
    res
      .writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="poros-mobile-ca.cer"',
        "content-length": trust.length,
        "x-content-type-options": "nosniff",
      })
      .end(trust);
    return;
  }
  const target = request(
    {
      hostname: "127.0.0.1",
      port: 8790,
      path: req.url,
      method: req.method,
      headers: forwardingHeaders(req.headers),
      agent: false,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, forwardingHeaders(upstream.headers));
      upstream.on("error", () => res.destroy());
      upstream.pipe(res);
    },
  );
  target.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "cache-control": "no-store" });
    res.end();
  });
  res.on("close", () => target.destroy());
  req.on("error", () => target.destroy());
  req.pipe(target);
}

const listeners = [
  [createHttps({ key, cert, minVersion: "TLSv1.2" }, bridge), 8791],
  [createHttp(bridge), 8792],
];
await Promise.all(
  listeners.map(
    ([server, port]) =>
      new Promise((resolve, reject) => {
        server.requestTimeout = 30000;
        server.headersTimeout = 10000;
        server.on("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
  ),
);
console.log("Poros mobile ingress ready on loopback");
