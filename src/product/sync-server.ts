import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Store } from "@/core/store.js";
import { RemoteSyncEnvelopeSchema, type RemoteSyncEnvelope } from "./sync-client.js";

export class WorkspaceSyncServer {
  private server: Server | undefined;
  constructor(private readonly store: Store<RemoteSyncEnvelope>, private readonly token: string) {}

  async start(port = 0): Promise<number> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    return await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => { this.server?.off("listening", onListening); reject(error); };
      const onListening = (): void => { const address = this.server!.address(); resolve(typeof address === "object" && address ? address.port : 0); };
      this.server!.once("error", onError); this.server!.once("listening", onListening); this.server!.listen(port, "127.0.0.1");
    });
  }

  async stop(): Promise<void> { if (!this.server) return; await new Promise<void>((resolve) => this.server!.close(() => resolve())); this.server = undefined; }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/workspaces\/([^/]+)(\/sync)?$/);
    if (!match || !this.authorized(req)) { res.writeHead(401).end(); return; }
    let workspaceId: string;
    try {
      workspaceId = decodeURIComponent(match[1]!);
    } catch {
      // A malformed percent-encoded path must terminate with a client error;
      // otherwise the async request handler rejects and leaves the socket
      // waiting indefinitely.
      res.writeHead(400).end("invalid workspace id");
      return;
    }
    if (req.method === "GET" && !match[2]) {
      const envelope = await this.store.get(workspaceId);
      if (!envelope) { res.writeHead(404).end(); return; }
      return sendJson(res, envelope);
    }
    if (req.method === "POST" && match[2]) {
      try {
        const body = await readBody(req);
        const envelope = RemoteSyncEnvelopeSchema.parse(JSON.parse(body));
        if (envelope.workspaceId !== workspaceId) { res.writeHead(400).end("workspace mismatch"); return; }
        await this.store.set(workspaceId, envelope);
        return sendJson(res, envelope);
      } catch (error) { res.writeHead(400).end(error instanceof Error ? error.message : String(error)); return; }
    }
    res.writeHead(405).end();
  }

  private authorized(req: IncomingMessage): boolean { return Boolean(this.token) && req.headers.authorization === `Bearer ${this.token}`; }
}

async function readBody(req: IncomingMessage): Promise<string> { let body = ""; for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body, "utf8") > 5_000_000) throw new Error("request body too large"); } return body; }
function sendJson(res: ServerResponse, value: unknown): void { res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(value)); }
