import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requirePrincipal, requireRole } from "../auth.js";
import { getDb } from "../db.js";
import { ApiError } from "../errors.js";
import {
  connectionSecret,
  connectionView,
  saveConnection,
  sealConnectionSecret,
} from "../integration-connections.js";
import { checkModel } from "../integration-providers.js";
import { describeProviderError } from "../provider-errors.js";
import { consumeLimit } from "../security.js";
import { parseProject, skillDefinition } from "../../agent-project/contract.js";
import {
  bindingKey,
  endpointRequest,
  saveEndpoint,
  scopedConnection,
  withRemoteMcp,
} from "./connections.js";
import { json, revisionFiles, workspaceAccess } from "./repository.js";

const parameters = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/) });
const endpointParams = parameters.extend({
  kind: z.enum(["model", "mcp", "api"]),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
});
const settingsSchema = z
  .object({
    runtimeModel: z.enum(["inherit", "own"]).default("inherit"),
    authorizedTools: z.array(z.string().min(1).max(180)).max(40).default([]),
    enabledSkills: z.array(z.string().min(1).max(180)).max(12).optional(),
  })
  .strict();
export async function registerIdeSettings(app: FastifyInstance) {
  const db = getDb();
  const identity = (
    req: Parameters<typeof requirePrincipal>[0],
    reply: Parameters<typeof requirePrincipal>[1],
  ) => {
    const p = requirePrincipal(req, reply);
    return p && requireRole(["BUILDER"], p, reply) ? p : null;
  };
  app.get("/api/ide/workspaces/:id/settings", async (req, reply) => {
    const p = identity(req, reply);
    if (!p) return;
    const { id } = parameters.parse(req.params),
      workspace = await workspaceAccess(db, p, id);
    const files = await revisionFiles(db, id, workspace.sourceDigest);
    const connections = await db.integrationConnection.findMany({
      where: {
        organizationId: p.organizationId,
        userId: p.userId,
        provider: { startsWith: `ide:${id}:` },
      },
    });
    let capabilities: { skills: unknown[]; permissions: string[]; mcp: unknown[] } = {
      skills: [],
      permissions: [],
      mcp: [],
    };
    try {
      const manifest = parseProject(files);
      capabilities = {
        skills: manifest.skills.map((directory) => skillDefinition(files, directory)),
        permissions: manifest.permissions,
        mcp: manifest.mcp,
      };
    } catch {
      /* Invalid source must still be able to repair connection settings. */
    }
    return {
      ok: true,
      settings: workspace.settings,
      capabilities,
      connections: connections.map((row) => ({
        ...connectionView(row),
        key: row.provider.slice(`ide:${id}:`.length),
      })),
    };
  });
  app.put("/api/ide/workspaces/:id/settings", async (req, reply) => {
    const p = identity(req, reply);
    if (!p) return;
    const { id } = parameters.parse(req.params);
    await workspaceAccess(db, p, id);
    const settings = settingsSchema.parse(req.body);
    await db.ideWorkspace.update({ where: { id }, data: { settings: json(settings) } });
    return { ok: true, settings };
  });
  app.put("/api/ide/workspaces/:id/connections/:kind/:name", async (req, reply) => {
    const p = identity(req, reply);
    if (!p) return;
    const { id, kind, name } = endpointParams.parse(req.params);
    await workspaceAccess(db, p, id);
    await consumeLimit(`ide-connection:${p.organizationId}:${p.userId}`, 30, 60000);
    if (kind === "model" && name !== "runtime") throw new ApiError(400, "运行模型名称应为runtime");
    const key = bindingKey(id, kind, kind === "model" ? "" : name);
    const row =
      kind === "model"
        ? await saveConnection(db, p, "model", req.body, key)
        : await saveEndpoint(db, p, key, req.body);
    return { ok: true, connection: connectionView(row) };
  });
  app.delete("/api/ide/workspaces/:id/connections/:kind/:name", async (req, reply) => {
    const p = identity(req, reply);
    if (!p) return;
    const { id, kind, name } = endpointParams.parse(req.params);
    await workspaceAccess(db, p, id);
    await db.integrationConnection.deleteMany({
      where: {
        organizationId: p.organizationId,
        userId: p.userId,
        provider: bindingKey(id, kind, kind === "model" ? "" : name),
      },
    });
    return { ok: true };
  });
  app.post("/api/ide/workspaces/:id/connections/:kind/:name/test", async (req, reply) => {
    const p = identity(req, reply);
    if (!p) return;
    const { id, kind, name } = endpointParams.parse(req.params);
    await workspaceAccess(db, p, id);
    await consumeLimit(`ide-connection-test:${p.organizationId}:${p.userId}`, 12, 60000);
    const key = bindingKey(id, kind, kind === "model" ? "" : name),
      row = await scopedConnection(db, p, key);
    if (!row) throw new ApiError(404, "请先保存连接");
    let code = "OK",
      message = "实际连接测试通过",
      tools: unknown;
    try {
      const signal = AbortSignal.timeout(25000);
      if (kind === "model") await checkModel(row);
      else if (kind === "mcp")
        tools = await withRemoteMcp(
          row,
          signal,
          async (client) => (await client.listTools(undefined, { signal })).tools,
        );
      else
        await endpointRequest(
          row,
          (row.settings as { testPath: string }).testPath,
          "GET",
          undefined,
          signal,
        );
    } catch (error) {
      const failure = describeProviderError(error);
      code = failure.code;
      message = failure.message;
    }
    const revision = tools && code === "OK" ? randomUUID() : row.revision;
    const changed = await db.integrationConnection.updateMany({
      where: {
        organizationId: row.organizationId,
        userId: row.userId,
        provider: row.provider,
        revision: row.revision,
      },
      data: {
        testCode: code,
        testedAt: new Date(),
        ...(tools && code === "OK"
          ? {
              revision,
              settings: json({ ...(row.settings as object), tools }),
              encryptedKey: sealConnectionSecret({ ...row, revision }, connectionSecret(row)),
            }
          : {}),
      },
    });
    if (!changed.count) throw new ApiError(409, "测试期间连接被修改，结果未应用");
    return {
      ok: true,
      passed: code === "OK",
      verified: code === "OK",
      code,
      message,
      ...(tools ? { tools } : {}),
    };
  });
}
