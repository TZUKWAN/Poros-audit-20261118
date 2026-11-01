import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonStore } from "@/core/store";
import { RemoteSyncEnvelopeSchema } from "@/product/sync-client";
import { WorkspaceSyncServer } from "@/product/sync-server";

describe("自托管同步服务", () => {
  it("Bearer 鉴权、pull、push 均通过真实 HTTP", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sync-server-"));
    const server = new WorkspaceSyncServer(jsonStore({ filePath: path.join(dir, "remote.json"), schema: RemoteSyncEnvelopeSchema }), "sync-secret");
    const port = await server.start(0);
    try {
      const envelope = { schemaVersion: 1 as const, workspaceId: "w", revision: "r1", entities: [{ id: "p1", updatedAt: "2026-10-03T00:00:00.000Z", type: "project", data: { name: "p" } }] };
      expect((await fetch(`http://127.0.0.1:${port}/workspaces/w`)).status).toBe(401);
      const pushed = await fetch(`http://127.0.0.1:${port}/workspaces/w/sync`, { method: "POST", headers: { authorization: "Bearer sync-secret", "content-type": "application/json" }, body: JSON.stringify(envelope) });
      expect(pushed.status).toBe(200);
      const pulled = await fetch(`http://127.0.0.1:${port}/workspaces/w`, { headers: { authorization: "Bearer sync-secret" } });
      expect((await pulled.json()).revision).toBe("r1");
    } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("畸形 URL 编码返回 400 而不会让请求悬挂", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sync-server-malformed-"));
    const server = new WorkspaceSyncServer(jsonStore({ filePath: path.join(dir, "remote.json"), schema: RemoteSyncEnvelopeSchema }), "sync-secret");
    const port = await server.start(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/workspaces/%E0%A4%A/sync`, { headers: { authorization: "Bearer sync-secret" } });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("invalid workspace id");
    } finally { await server.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});

