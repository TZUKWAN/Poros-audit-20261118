import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth.js";
import { env } from "../env.js";
import { getDb } from "../db.js";
import {
  connectionView,
  deleteConnection,
  findConnection,
  providerSchema,
  providers,
  recordConnectionCheck,
  saveConnection,
} from "../integration-connections.js";
import { useIntegration, verifyIntegration } from "../integration-providers.js";
import { ProviderError } from "../provider-http.js";
import { ApiError } from "../releases.js";
import { consumeLimit } from "../security.js";

import { describeProviderError, messages } from "../provider-errors.js";

export async function registerIntegrationRoutes(app: FastifyInstance) {
  const db = getDb();
  const params = z.object({ provider: providerSchema });

  app.get("/api/settings/integrations", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const connections = await db.integrationConnection.findMany({
      where: {
        organizationId: p.organizationId,
        userId: p.userId,
        provider: { in: [...providers] },
      },
    });
    return {
      ok: true,
      connections: connections.map((row) => ({
        ...connectionView(row),
        testMessage: row.testCode && row.testCode !== "OK" ? messages[row.testCode] : null,
      })),
      runtime: env.porosRuntime(),
      builtinModel: env.deepseekApiKey() ? "deepseek-chat" : null,
      testModel: env.dshModelStub(),
      modelMode:
        env.dshModelStub() || (env.porosRuntime() === "gateway" && env.modelGateway() === "mock")
          ? "SIMULATION"
          : "CONFIGURED",
      personalModelOnly: env.personalModelOnly(),
    };
  });

  app.put("/api/settings/integrations/:provider", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { provider } = params.parse(req.params);
    await consumeLimit("integration-write:" + p.organizationId + ":" + p.userId, 20, 60000);
    try {
      return {
        ok: true,
        connection: connectionView(await saveConnection(db, p, provider, req.body)),
      };
    } catch (error) {
      if (error instanceof ProviderError)
        throw new ApiError(400, describeProviderError(error).message);
      throw error;
    }
  });

  app.post("/api/settings/integrations/:provider/test", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { provider } = params.parse(req.params);
    await consumeLimit("integration-test:" + p.organizationId + ":" + p.userId, 12, 60000);
    const row = await findConnection(db, p, provider);
    if (!row) throw new ApiError(404, "请先保存连接");
    let code = "OK",
      message = "实际请求通过";
    let http: number | undefined;
    try {
      await verifyIntegration(row);
    } catch (error) {
      ({ code, message, http } = describeProviderError(error));
    }
    const updated = await recordConnectionCheck(db, row, code);
    if (!updated.count) throw new ApiError(409, "连接已变更，请重新测试当前配置");
    return { ok: true, passed: code === "OK", code, message, http };
  });

  app.post("/api/settings/integrations/:provider/use", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    const { provider } = params.parse(req.params);
    const { action, input } = z
      .object({ action: z.enum(["search", "fetch"]), input: z.string().trim().max(2000) })
      .parse(req.body);
    if (!input && provider !== "ima") throw new ApiError(400, "请输入关键词或网页地址");
    await consumeLimit("integration-use:" + p.organizationId + ":" + p.userId, 24, 60000);
    const row = await findConnection(db, p, provider);
    if (!row) throw new ApiError(404, "请先保存连接");
    try {
      return { ok: true, items: await useIntegration(row, action, input) };
    } catch (error) {
      const result = describeProviderError(error);
      if (
        ["AUTH_REJECTED", "UPSTREAM_AUTH_UNAVAILABLE", "ACCOUNT_VALIDATION_REQUIRED"].includes(
          result.code,
        )
      )
        await recordConnectionCheck(db, row, result.code);
      return reply.code(422).send({ ok: false, error: result.message, code: result.code });
    }
  });

  app.delete("/api/settings/integrations/:provider", async (req, reply) => {
    const p = requirePrincipal(req, reply);
    if (!p) return;
    await deleteConnection(db, p, params.parse(req.params).provider);
    return { ok: true };
  });
}
