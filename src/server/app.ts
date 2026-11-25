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
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerCapabilityRoutes } from "./routes/capabilities.js";
import { getDb } from "./db.js";
import { startWorker } from "./worker.js";
import { validateEnvironment } from "./env.js";
import type { RunnerDeps } from "./runner.js";
import { assertS3Private } from "./storage.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerIdeRoutes } from "./ide/routes.js";
import { startIdeWorker } from "./ide/engine.js";
import { registerIdeSettings } from "./ide/settings.js";
import { registerIdePreview } from "./ide/preview.js";

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
          path: req.url?.startsWith("/preview/") ? "/preview/[ticket]" : req.url?.split("?")[0],
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
    return reply.code(status).send({
      ok: false,
      error: status >= 500 ? "内部错误" : error instanceof Error ? error.message : "请求失败",
    });
  });
  app.addHook("onRequest", authMiddleware);
  app.addHook("onSend", async (req, reply, payload) => {
    const preview = req.routeOptions.url === "/preview/:ticket" && reply.statusCode === 200;
    reply
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", preview ? "SAMEORIGIN" : "DENY")
      .header(
        "content-security-policy",
        preview
          ? "frame-ancestors 'self'; sandbox allow-scripts"
          : "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      );
    if (
      req.url.startsWith("/api/") ||
      req.url.startsWith("/preview/") ||
      ["/", "/index.html", "/sw.js", "/manifest.webmanifest"].includes(req.url.split("?")[0]!)
    )
      reply.header("cache-control", "no-store");
    return payload;
  });
  app.get("/api/health", async () => ({ ok: true, service: "poros" }));
  await app.register(registerRoutes);
  await app.register(registerIntegrationRoutes);
  await app.register(registerProjectRoutes);
  await app.register(registerFileRoutes);
  await app.register(registerCapabilityRoutes);
  await app.register(registerConversationRoutes);
  await app.register(registerIdeRoutes);
  await app.register(registerIdeSettings);
  await app.register(registerIdePreview);
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
    const ideWorker = startIdeWorker(getDb());
    app.addHook("preClose", async () => {
      await ideWorker.stop();
      await worker.stop();
    });
  }
  return app;
}
