/**
 * Fastify 应用组装。导出 buildApp 供 API 测试用 inject 模式（不起端口）。
 * 错误契约（PRD §7.2/§5.2）：任何异常 → 真实错误响应，绝不 catch 后返回 ok:true。
 */
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { authMiddleware } from "./auth.js";
import { registerRoutes, CREDENTIALS_DDL } from "./routes/index.js";
import { getDb } from "./db.js";
import { startWorker } from "./worker.js";
import { validateEnvironment } from "./env.js";
import type { RunnerDeps } from "./runner.js";
import { assertS3Private } from "./storage.js";

export async function buildApp(
  options: { worker?: boolean; runner?: Partial<RunnerDeps> } = {},
): Promise<FastifyInstance> {
  validateEnvironment();
  const app = Fastify({
    bodyLimit: 8 * 1024 * 1024,
    logger: {
      level: process.env.LOG_LEVEL || "info",
      serializers: {
        req: (req: { method: string; url: string; ip: string }) => ({
          method: req.method,
          path: req.url?.split("?")[0],
          ip: req.ip,
        }),
      },
    },
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        ok: false,
        error: "参数校验失败",
        issues: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const code = (error as { code?: string }).code;
    app.log.error(
      { errorName: error instanceof Error ? error.name : "unknown", code },
      "request failed",
    );
    const status =
      (error as { statusCode?: number }).statusCode ||
      (code === "P2002" ? 409 : code === "P2025" ? 404 : 500);
    return reply
      .code(status)
      .send({
        ok: false,
        error: status >= 500 ? "内部错误" : error instanceof Error ? error.message : "请求失败",
      });
  });
  app.addHook("onRequest", authMiddleware);
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .header(
        "content-security-policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      );
    return payload;
  });
  app.get("/api/health", async () => ({ ok: true, service: "poros" }));
  await app.register(registerRoutes);
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.method === "GET" && !req.raw.url?.startsWith("/api"))
      return reply.sendFile("index.html");
    return reply.code(404).send({ ok: false, error: "不存在" });
  });
  // 凭证表（最小 SQL 管理，见 CREDENTIALS_DDL 注释）
  await getDb().$executeRawUnsafe(CREDENTIALS_DDL);
  if (
    process.env.NODE_ENV === "production" &&
    (await getDb().membership.count({ where: { userId: { endsWith: ".test" } } }))
  )
    throw new Error("Production refuses development seed memberships");
  if (process.env.NODE_ENV === "production") await assertS3Private();
  if (options.worker !== false) {
    const worker = startWorker(getDb(), options.runner);
    app.addHook("preClose", async () => worker.stop());
  }
  return app;
}
