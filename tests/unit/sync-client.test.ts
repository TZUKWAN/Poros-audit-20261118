import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WorkspaceSyncClient } from "@/product/sync-client";

describe("远端同步客户端", () => {
  it("通过真实 HTTP 拉取远端 envelope 并生成可应用的同步计划", async () => {
    const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ schemaVersion: 1, workspaceId: "w", revision: "r2", entities: [{ id: "p2", updatedAt: "2026-10-03T00:00:00.000Z", type: "project", data: { name: "远端项目" } }] })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("server address unavailable");
      const client = new WorkspaceSyncClient({ endpoint: `http://127.0.0.1:${address.port}`, workspaceId: "w" });
      const remote = await client.pull();
      expect(remote.revision).toBe("r2");
      expect(WorkspaceSyncClient.plan([], remote).create).toEqual(["p2"]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

