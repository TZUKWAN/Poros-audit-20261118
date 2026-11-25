import { RemoteManager } from "../remote/manager.js";
import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ApiError } from "../server/errors.js";
import { ProviderError } from "../server/provider-http.js";
import { describeProviderError } from "../server/provider-errors.js";
import { connectionSecret } from "../server/integration-connections.js";
import { useIntegration } from "../server/integration-providers.js";
import { redact } from "../server/redact.js";
import { parseProject, skillDefinition } from "../agent-project/contract.js";
import { canonical, sha256, verifyPackage, type AppPackage } from "../agent-project/package.js";
import { RuntimeStore, type RuntimeActor, type RuntimeJob } from "./store.js";
import { RuntimeAuth } from "./auth.js";
import { executeApp, runtimeRow } from "./runner.js";
import {
  runtimeConnectionView,
  restoreRuntimeConnectionHosts,
  runtimeProvider,
  saveRuntimeConnection,
  testRuntimeConnection,
} from "./connections.js";

const requestInput = z
  .object({
    input: z.unknown().optional(),
    target: z.string().max(180).optional(),
    tool: z.string().max(120).optional(),
  })
  .strict();
export async function buildRuntime(options: {
  directory: string;
  package?: AppPackage;
  publicDirectory?: string;
}) {
  const store = await RuntimeStore.open(options.directory, options.package),
    auth = new RuntimeAuth(store);
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 });
  const active = new Map<
    string,
    { actorHash: string; controller: AbortController; done: Promise<void> }
  >();
  const tickets = new Map<string, { actorHash: string; expires: number; version: string }>();
  const remote = new RemoteManager(app, store);
  let storageFailure = "";
  const limits = new Map<string, { count: number; until: number }>();
  try {
    restoreRuntimeConnectionHosts(store);
    const limit = (key: string, capacity = 90) => {
      for (const [id, entry] of limits) if (entry.until <= Date.now()) limits.delete(id);
      const existing = limits.get(key);
      if (existing && existing.count >= capacity)
        throw new ApiError(429, "请求过于频繁，请稍后重试");
      if (limits.size >= 2000 && !existing) throw new ApiError(429, "运行端正在处理较多请求");
      limits.set(key, {
        count: (existing?.count || 0) + 1,
        until: existing?.until || Date.now() + 60000,
      });
    };
    const actor = (req: FastifyRequest, owner = false) => auth.actor(req, owner);
    const currentInfo = () => {
      const pkg = store.package();
      const manifest = parseProject(pkg.payload.files);
      return {
        appId: pkg.payload.appId,
        name: pkg.payload.name,
        kind: pkg.payload.kind,
        version: pkg.payload.version,
        sourceDigest: pkg.payload.sourceDigest,
        createdAt: pkg.payload.createdAt,
        evidence: pkg.payload.build.evidence,
        hasUi: Boolean(pkg.payload.build.previewHtml),
        runtime: "independent",
        manifest: {
          skills: manifest.skills,
          permissions: manifest.permissions,
          mcp: manifest.mcp,
          preview: manifest.preview,
        },
      };
    };
    app.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof ApiError
          ? error.statusCode
          : error instanceof z.ZodError
            ? 400
            : error instanceof ProviderError
              ? 502
              : 500;
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof z.ZodError
            ? "输入不符合接口要求"
            : error instanceof ProviderError
              ? describeProviderError(error).message
              : "运行端内部错误";
      return reply.code(status).send({ ok: false, error: message });
    });
    app.addHook("onSend", async (request, reply, payload) => {
      const frame = request.routeOptions.url === "/frame/:ticket" && reply.statusCode === 200;
      reply.header(
        "content-security-policy",
        frame
          ? "frame-ancestors 'self'; sandbox allow-scripts"
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      reply
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-store");
      if (!frame) reply.header("x-frame-options", "DENY");
      return payload;
    });
    app.get("/api/app/info", async () => ({
      ok: true,
      ...currentInfo(),
      ...(storageFailure ? { error: storageFailure } : {}),
    }));
    app.post("/api/app/bootstrap", async (req) => {
      limit("bootstrap", 15);
      const { code } = z
        .object({ code: z.string().length(43) })
        .strict()
        .parse(req.body);
      return { ok: true, token: await auth.exchange(code) };
    });
    app.get("/api/app/session", async (req) => {
      const session = actor(req);
      return {
        ok: true,
        role: session.role,
        sessionIdentity: session.role === "OWNER" ? "owner" : session.hash,
        deviceName: session.name,
        grants: session.grants,
        authorizedTools: store
          .snapshot()
          .settings.authorizedTools.filter(
            (name) => session.role === "OWNER" || session.grants.includes(name),
          ),
        ...currentInfo(),
      };
    });
    app.post("/api/app/logout", async (req) => {
      const session = actor(req);
      await store.change((next) => {
        const current = next.sessions.find((item) => item.hash === session.hash);
        if (current) current.revokedAt = new Date().toISOString();
      });
      for (const entry of active.values())
        if (entry.actorHash === session.hash) entry.controller.abort();
      return { ok: true };
    });
    app.post("/api/app/pair/invites", async (req) => {
      actor(req, true);
      limit("invite", 15);
      const body = z
        .object({ grants: z.array(z.string()).max(40).default([]) })
        .strict()
        .parse(req.body);
      return { ok: true, ...auth.invite(body.grants) };
    });
    app.post("/api/app/pair/claim", async (req) => {
      limit("claim", 30);
      const body = z
        .object({
          code: z.string().length(43),
          claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          name: z.string().trim().min(1).max(80),
        })
        .strict()
        .parse(req.body);
      return { ok: true, ...auth.claim(body.code, body.claimToken, body.name) };
    });
    app.post("/api/app/pair/result", async (req) => {
      limit("pair-result", 120);
      const body = z
        .object({ id: z.string().uuid(), claimToken: z.string().length(43) })
        .strict()
        .parse(req.body);
      return { ok: true, ...auth.result(body.id, body.claimToken) };
    });
    app.get("/api/app/pair/requests", async (req) => {
      actor(req, true);
      return { ok: true, requests: auth.requests() };
    });
    app.post("/api/app/pair/:id/approve", async (req) => {
      actor(req, true);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await auth.approve(id);
      return { ok: true };
    });
    app.get("/api/app/devices", async (req) => {
      actor(req, true);
      return {
        ok: true,
        devices: store
          .snapshot()
          .sessions.filter((item) => item.role === "DEVICE")
          .map(({ hash, name, grants, expiresAt, revokedAt }) => ({
            id: hash,
            name,
            grants,
            expiresAt,
            revokedAt,
          })),
      };
    });
    app.delete("/api/app/devices/:id", async (req) => {
      actor(req, true);
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
      await store.change((next) => {
        const device = next.sessions.find((item) => item.hash === id && item.role === "DEVICE");
        if (!device) throw new ApiError(404, "设备不存在");
        device.revokedAt = new Date().toISOString();
      });
      for (const entry of active.values()) if (entry.actorHash === id) entry.controller.abort();
      return { ok: true };
    });
    app.get("/api/app/remote", async (req) => {
      actor(req, true);
      return { ok: true, remote: remote.status() };
    });
    app.put("/api/app/remote", async (req) => {
      actor(req, true);
      limit("remote-settings", 12);
      try {
        return { ok: true, remote: await remote.configure(req.body) };
      } catch (error) {
        if (error instanceof z.ZodError) throw error;
        throw new ApiError(400, error instanceof Error ? error.message : "远程配置失败");
      }
    });
    app.get("/api/app/settings", async (req) => {
      actor(req, true);
      const state = store.snapshot(),
        manifest = parseProject(store.package().payload.files);
      return {
        ok: true,
        settings: state.settings,
        connections: state.credentials.map(runtimeConnectionView),
        skills: manifest.skills.map((directory) =>
          skillDefinition(store.package().payload.files, directory),
        ),
        permissions: manifest.permissions,
        mcp: manifest.mcp,
        publisher: store.package().fingerprint,
      };
    });
    app.put("/api/app/settings", async (req) => {
      actor(req, true);
      const settings = z
        .object({
          authorizedTools: z.array(z.string()).max(40).default([]),
          enabledSkills: z.array(z.string()).max(12).optional(),
        })
        .strict()
        .parse(req.body);
      const manifest = parseProject(store.package().payload.files);
      if (
        settings.authorizedTools.some((name) => !manifest.permissions.includes(name)) ||
        settings.enabledSkills?.some((name) => !manifest.skills.includes(name))
      )
        throw new ApiError(400, "权限或技能不在当前软件声明范围内");
      await store.change((next) => {
        next.settings = settings;
      });
      for (const entry of active.values()) entry.controller.abort();
      return { ok: true, settings };
    });
    app.put("/api/app/connections/:provider", async (req) => {
      actor(req, true);
      limit("save-connection", 30);
      const { provider } = z.object({ provider: runtimeProvider }).parse(req.params);
      return { ok: true, connection: await saveRuntimeConnection(store, provider, req.body) };
    });
    app.get("/api/app/connections", async (req) => {
      actor(req, true);
      return {
        ok: true,
        connections: store
          .snapshot()
          .credentials.filter((item) =>
            ["model", "kdocs", "ima", "tinyfish"].includes(item.provider),
          )
          .map(runtimeConnectionView),
        runtime: "independent",
        builtinModel: null,
        testModel: false,
        modelMode: "CONFIGURED",
        personalModelOnly: true,
      };
    });
    app.post("/api/app/connections/:provider/use", async (req) => {
      actor(req, true);
      limit("use-connection", 20);
      const { provider } = z
        .object({ provider: z.enum(["kdocs", "ima", "tinyfish"]) })
        .parse(req.params);
      const body = z
        .object({ action: z.enum(["search", "fetch"]), input: z.string().max(2000) })
        .strict()
        .parse(req.body);
      const connection = store.snapshot().credentials.find((item) => item.provider === provider);
      if (!connection) throw new ApiError(404, "请先保存连接");
      return {
        ok: true,
        items: await useIntegration(
          runtimeRow(connection),
          body.action,
          body.input,
          AbortSignal.timeout(20000),
          store.key,
        ),
      };
    });
    app.post("/api/app/connections/:provider/test", async (req) => {
      actor(req, true);
      limit("test-connection", 12);
      const { provider } = z.object({ provider: runtimeProvider }).parse(req.params);
      return { ok: true, ...(await testRuntimeConnection(store, provider)) };
    });
    app.delete("/api/app/connections/:provider", async (req) => {
      actor(req, true);
      const { provider } = z.object({ provider: runtimeProvider }).parse(req.params);
      await store.change((next) => {
        next.credentials = next.credentials.filter((item) => item.provider !== provider);
      });
      for (const entry of active.values()) entry.controller.abort();
      return { ok: true };
    });
    const visible = (session: RuntimeActor, job: RuntimeJob) =>
      session.role === "OWNER" || job.actorHash === session.hash;
    app.get("/api/app/jobs", async (req) => {
      const session = actor(req);
      return {
        ok: true,
        jobs: store
          .snapshot()
          .jobs.filter((job) => visible(session, job))
          .slice(-30)
          .reverse(),
      };
    });
    app.get("/api/app/jobs/:id", async (req) => {
      const session = actor(req),
        { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const job = store.snapshot().jobs.find((item) => item.id === id && visible(session, item));
      if (!job) throw new ApiError(404, "运行记录不存在");
      return { ok: true, job };
    });
    app.post("/api/app/jobs/:id/cancel", async (req) => {
      const session = actor(req),
        { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const job = store.snapshot().jobs.find((item) => item.id === id && visible(session, item));
      if (!job) throw new ApiError(404, "运行记录不存在");
      active.get(id)?.controller.abort();
      return { ok: true };
    });
    app.post("/api/app/jobs", async (req, reply) => {
      if (storageFailure) throw new ApiError(503, storageFailure);
      const session = actor(req);
      limit("jobs:" + session.hash, 20);
      const body = z
        .object({
          kind: z.enum(["RUN", "TEST", "MCP_TEST", "SKILL_TEST"]).default("RUN"),
          input: requestInput.default({}),
          consent: z.array(z.string()).max(40).default([]),
          expectedVersion: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(req.body);
      const requestKey = z.string().min(1).max(128).parse(req.headers["idempotency-key"]),
        version = store.package().payload.version,
        requestHash = sha256(canonical(body));
      const identity = session.role === "OWNER" ? "owner" : session.hash;
      let created = false;
      const secrets = store.snapshot().credentials.flatMap((item) => {
        const secret = connectionSecret(runtimeRow(item), store.key);
        return [secret.apiKey, secret.clientId || ""].filter(Boolean);
      });
      const clean = (value: unknown) => redact(value, secrets, 1000000, Number.MAX_SAFE_INTEGER);
      const job = await store.change((next) => {
        const receipt = next.receipts.find((item) => item.requestKey === requestKey);
        if (receipt) {
          if (receipt.identity !== identity || receipt.requestHash !== requestHash)
            throw new ApiError(409, "幂等键已用于其他设备或操作");
          const existing = next.jobs.find((item) => item.id === receipt.jobId);
          if (!existing) throw new ApiError(410, "原任务已归档，不会再次执行：" + receipt.jobId);
          return existing;
        }
        if (body.expectedVersion && body.expectedVersion !== version)
          throw new ApiError(409, "软件已更新，请刷新界面后重新操作；本次没有执行");
        if (next.receipts.length >= 50000)
          throw new ApiError(429, "本实例执行回执已达五万条上限，本次没有执行；历史回执没有被丢弃");
        if (next.jobs.some((item) => item.status === "RUNNING"))
          throw new ApiError(409, "已有任务运行，可先停止或等待");
        const entry: RuntimeJob = {
          id: randomUUID(),
          actorHash: session.hash,
          requestKey,
          requestHash,
          version,
          kind: body.kind,
          input: clean(body.input),
          consent: body.consent,
          status: "RUNNING",
          output: null,
          events: [],
          usage: {},
          createdAt: new Date().toISOString(),
        };
        next.jobs = [...next.jobs.slice(-29), entry];
        next.receipts.push({ identity, requestKey, requestHash, jobId: entry.id, version });
        created = true;
        return entry;
      });
      if (created) {
        const controller = new AbortController(),
          deadline = setTimeout(() => controller.abort(), 180000);
        let writes: Promise<unknown> = Promise.resolve(),
          sequence = 0;
        const event = (type: string, data: unknown) => {
          const seq = ++sequence,
            at = new Date().toISOString();
          if (seq > 200) throw new ApiError(429, "运行事件超过限制");
          writes = writes.then(() =>
            store.change((next) => {
              const entry = next.jobs.find((item) => item.id === job.id);
              if (entry) entry.events.push({ seq, type, data: clean(data), at });
            }),
          );
          return writes.then(() => {});
        };
        const done = executeApp(
          store,
          session,
          body.kind,
          body.input,
          body.consent,
          controller.signal,
          event,
        )
          .then(async (result) => {
            await writes;
            await store.change((next) => {
              const entry = next.jobs.find((item) => item.id === job.id);
              if (entry) {
                entry.status = controller.signal.aborted ? "CANCELLED" : "SUCCEEDED";
                entry.output = controller.signal.aborted ? { error: "运行已取消" } : result.output;
                entry.usage = result.usage;
              }
            });
          })
          .catch(async (error) => {
            await writes.catch(() => {});
            const detail =
              error instanceof ProviderError
                ? describeProviderError(error).message
                : error instanceof Error
                  ? error.message
                  : "运行失败";
            await store.change((next) => {
              const entry = next.jobs.find((item) => item.id === job.id);
              if (entry) {
                entry.status = controller.signal.aborted ? "CANCELLED" : "FAILED";
                entry.output = clean({
                  error: detail,
                  ...((error as { output?: object }).output || {}),
                });
                entry.usage = (error as { usage?: Record<string, unknown> }).usage || {
                  modelCalls: null,
                };
              }
            });
          })
          .finally(() => {
            clearTimeout(deadline);
            active.delete(job.id);
          });
        active.set(job.id, { actorHash: session.hash, controller, done });
        void done.catch(() => {
          storageFailure = "运行状态保存失败，已停止接受新任务，请检查安装目录空间和权限";
        });
      }
      return reply.code(202).send({ ok: true, job });
    });
    app.post("/api/app/preview-ticket", async (req) => {
      const session = actor(req);
      limit("frame:" + session.hash, 40);
      if (!store.package().payload.build.previewHtml)
        throw new ApiError(404, "该软件没有自定义界面");
      for (const [id, record] of tickets) if (record.expires <= Date.now()) tickets.delete(id);
      if (tickets.size >= 100) throw new ApiError(429, "预览过多");
      const code = randomBytes(32).toString("base64url");
      tickets.set(sha256(code), {
        actorHash: session.hash,
        expires: Date.now() + 60000,
        version: store.package().payload.version,
      });
      return { ok: true, url: "/frame/" + code };
    });
    app.get("/frame/:ticket", async (req, reply) => {
      const { ticket } = z.object({ ticket: z.string().length(43) }).parse(req.params),
        record = tickets.get(sha256(ticket));
      tickets.delete(sha256(ticket));
      const session =
        record && store.snapshot().sessions.find((item) => item.hash === record.actorHash);
      if (
        !record ||
        record.expires <= Date.now() ||
        !session ||
        session.revokedAt ||
        Date.parse(session.expiresAt) <= Date.now() ||
        record.version !== store.package().payload.version
      )
        throw new ApiError(403, "界面预览已失效");
      return reply.type("text/html; charset=utf-8").send(store.package().payload.build.previewHtml);
    });
    app.post("/api/app/update", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
      actor(req, true);
      if (active.size) throw new ApiError(409, "请先停止运行再更新");
      const body = z
          .object({ package: z.unknown(), acceptPermissions: z.boolean().default(false) })
          .strict()
          .parse(req.body),
        incoming = verifyPackage(body.package),
        current = store.package();
      if (
        incoming.payload.appId !== current.payload.appId ||
        incoming.fingerprint !== current.fingerprint
      )
        throw new ApiError(403, "更新不属于同一软件和发布者");
      const oldPermissions = parseProject(current.payload.files).permissions,
        newPermissions = parseProject(incoming.payload.files).permissions;
      const added = newPermissions.filter((name) => !oldPermissions.includes(name));
      if (added.length && !body.acceptPermissions)
        throw new ApiError(409, "更新声明新增能力，请核对后明确接受：" + added.join(", "));
      await store.change((next) => {
        next.history = [...next.history.slice(-2), next.package];
        next.package = {
          payload: incoming.payload,
          publisher: incoming.publisher,
          signature: incoming.signature,
        };
        next.settings.authorizedTools = next.settings.authorizedTools.filter(
          (name) => oldPermissions.includes(name) && newPermissions.includes(name),
        );
      });
      tickets.clear();
      return {
        ok: true,
        version: incoming.payload.version,
        addedPermissions: added,
        message: "更新已保存，新增能力尚未授权",
      };
    });
    const appPrefix = (req: FastifyRequest) => {
      const value = String(req.headers["x-poros-base"] || "/");
      return /^\/c\/[a-f0-9]{64}\/$/.test(value) ? value : "/";
    };
    app.get("/manifest.webmanifest", async (req, reply) => {
      const prefix = appPrefix(req),
        info = currentInfo();
      return reply.type("application/manifest+json").send({
        id: prefix + "?app=" + info.appId,
        name: info.name,
        short_name: info.name.slice(0, 20),
        start_url: prefix,
        scope: prefix,
        display: "standalone",
        background_color: "#f6f5f1",
        theme_color: "#c9694b",
        icons: [
          { src: prefix + "icons/poros-192.png", sizes: "192x192", type: "image/png" },
          { src: prefix + "icons/poros-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    });
    app.get("/offline.html", async (_req, reply) =>
      reply
        .type("text/html; charset=utf-8")
        .send(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接已中断</title></head><body><main><h1>连接已中断</h1><p>恢复连接后查看任务状态，请勿重复提交。</p></main></body></html>',
        ),
    );
    app.get("/sw.js", async (req, reply) => {
      const pkg = store.package(),
        cachePrefix =
          "poros-app-offline-" +
          pkg.payload.appId +
          "-" +
          sha256(appPrefix(req)).slice(0, 16) +
          "-",
        cache = cachePrefix + pkg.payload.version;
      return reply
        .type("application/javascript")
        .send(
          `const cacheName=${JSON.stringify(cache)},prefix=new URL('.',self.location.href).pathname,offline=prefix+'offline.html';self.addEventListener('install',e=>e.waitUntil(caches.open(cacheName).then(c=>c.addAll([offline,prefix+'icons/poros-192.png']))));self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(${JSON.stringify(cachePrefix)})&&k!==cacheName).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.origin!==self.location.origin||e.request.method!=='GET'||u.pathname.startsWith(prefix+'api/')||u.pathname.startsWith(prefix+'frame/'))return;if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match(offline)));});`,
        );
    });
    if (options.publicDirectory) {
      const directory = path.resolve(options.publicDirectory),
        html = await readFile(path.join(directory, "index.html"), "utf8");
      app.get("/", async (req, reply) => {
        const prefix = appPrefix(req);
        return reply.type("text/html; charset=utf-8").send(
          html
            .replace(
              "<head>",
              '<head><meta name="poros-runtime" content="app"><base href="' + prefix + '">',
            )
            .replaceAll('="/assets/', '="./assets/')
            .replaceAll('="/manifest.webmanifest"', '="./manifest.webmanifest"'),
        );
      });
      await app.register(fastifyStatic, { root: directory, index: false });
    }
    app.addHook("onClose", async () => {
      await remote.close();
      const running = [...active.values()];
      running.forEach((item) => item.controller.abort());
      await Promise.allSettled(running.map((item) => item.done));
      await store.close();
    });
    await app.ready();
    void remote.resume().catch(() => {});
    return { app, store, auth, remote, bootstrap: () => auth.bootstrap() };
  } catch (error) {
    await app.close().catch(() => {});
    await store.close();
    throw error;
  }
}
