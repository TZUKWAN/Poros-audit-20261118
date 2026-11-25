import { packageDesktop } from "./delivery.js";
import { randomUUID } from "node:crypto";
import type { IdeBuild, IdeJob, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Principal } from "../auth.js";
import { ApiError, digest } from "../releases.js";
import { redact } from "../security.js";
import { createPersonalGateway } from "../model-gateway.js";
import {
  modelConnection,
  connectionSecret,
  personalModelSource,
} from "../integration-connections.js";
import { useIntegrationTool } from "../integration-providers.js";
import { connectors } from "../capability-catalog.js";
import { runDshSession } from "../dsh-runtime.js";
import { describeProviderError } from "../provider-errors.js";
import { ProviderError } from "../provider-http.js";
import { compileIsolatedProject } from "../../agent-project/isolated-compiler.js";
import {
  parseProject,
  sdkDeclarations,
  skillDefinition,
  caseSchema,
} from "../../agent-project/contract.js";
import { validateFiles } from "../../agent-project/files.js";
import { runProgram, withMcp } from "../../agent-project/sandbox.js";
import { json, revisionFiles, saveRevision, workspaceAccess } from "./repository.js";
import {
  bindingKey,
  endpointRequest,
  runtimeModel,
  scopedConnection,
  withRemoteMcp,
} from "./connections.js";

export const jobInput = z
  .object({
    prompt: z.string().trim().min(1).max(20000).optional(),
    input: z.unknown().optional(),
    tool: z.string().max(120).optional(),
    target: z.string().max(180).optional(),
    includeMaterials: z.boolean().optional(),
    consent: z.array(z.string().max(120)).max(40).default([]),
  })
  .strict();
type JobInput = z.infer<typeof jobInput>;
type Bindings = {
  revisions: Record<string, string>;
  settingsDigest: string;
  runtimeKey: string;
  sessionId?: string;
};
export const terminalJob = (status: string) => !["QUEUED", "RUNNING"].includes(status);

export async function submitIdeJob(
  db: PrismaClient,
  p: Principal,
  id: string,
  kind:
    "DEVELOP" | "BUILD" | "PACKAGE" | "RUN" | "TEST" | "MCP_TEST" | "SCRIPT_TEST" | "SKILL_TEST",
  input: JobInput,
  requestKey: string,
  expectedDigest: string,
  buildId?: string,
) {
  const workspace = await workspaceAccess(db, p, id);
  const requestHash = digest({ kind, input, expectedDigest, buildId });
  const prior = await db.ideJob.findUnique({
    where: { workspaceId_requestKey: { workspaceId: id, requestKey } },
  });
  if (prior) {
    if (prior.requestHash !== requestHash) throw new ApiError(409, "幂等键对应不同操作");
    return prior;
  }
  if (workspace.sourceDigest !== expectedDigest)
    throw new ApiError(409, "工程已变更，请刷新后重试");
  if (kind === "DEVELOP") {
    if (!input.prompt) throw new ApiError(400, "请输入开发要求");
    await runtimeModel(db, p, "model");
  }
  if (
    buildId &&
    !(await db.ideBuild.count({ where: { id: buildId, workspaceId: id, status: "READY" } }))
  )
    throw new ApiError(404, "可运行构建不存在");
  const settings = workspace.settings as { runtimeModel?: string };
  const rows = await db.integrationConnection.findMany({
    where: { organizationId: p.organizationId, userId: p.userId },
  });
  const bindings: Bindings = {
    revisions: Object.fromEntries(rows.map((row) => [row.provider, row.revision])),
    settingsDigest: digest(workspace.settings),
    runtimeKey: settings.runtimeModel === "own" ? bindingKey(id, "model") : "model",
    sessionId: p.sessionId,
  };
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "IdeWorkspace" WHERE id=${id} FOR UPDATE`;
    const duplicate = await tx.ideJob.findUnique({
      where: { workspaceId_requestKey: { workspaceId: id, requestKey } },
    });
    if (duplicate) {
      if (duplicate.requestHash !== requestHash) throw new ApiError(409, "幂等键对应不同操作");
      return duplicate;
    }
    if (!(await tx.ideWorkspace.count({ where: { id, sourceDigest: expectedDigest } })))
      throw new ApiError(409, "工程已变更，请刷新后重试");
    if (
      await tx.ideJob.count({
        where: {
          workspaceId: id,
          status: { in: ["QUEUED", "RUNNING"] },
          buildId: buildId ? { not: null } : null,
        },
      })
    )
      throw new ApiError(
        409,
        buildId ? "已有试用正在进行，可停止后重试" : "工程已有开发或构建正在进行，可停止后重试",
      );
    return tx.ideJob.create({
      data: {
        workspaceId: id,
        kind,
        requestKey,
        requestHash,
        sourceDigest: expectedDigest,
        buildId,
        input: json({ ...input, bindings }),
      },
    });
  });
}

export async function buildWorkspace(db: PrismaClient, workspaceId: string, signal?: AbortSignal) {
  const workspace = await db.ideWorkspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const files = await revisionFiles(db, workspace.id, workspace.sourceDigest);
  const compiled = await compileIsolatedProject(files, signal);
  if (compiled.manifest && compiled.manifest.kind !== workspace.kind) {
    compiled.status = "FAILED";
    compiled.diagnostics.push("工程类型不能隐式改变，请新建相应工程");
  }
  const build = await db.ideBuild.create({
    data: {
      workspaceId,
      sourceDigest: workspace.sourceDigest,
      status: compiled.status,
      diagnostics: compiled.diagnostics,
      manifest: json(compiled.manifest || {}),
      bundles: json(compiled.bundles),
      previewHtml: compiled.previewHtml,
      evidence: json(compiled.evidence),
    },
  });
  if (build.status === "READY")
    await db.ideWorkspace.updateMany({
      where: { id: workspaceId, sourceDigest: build.sourceDigest },
      data: { latestBuildId: build.id, name: compiled.manifest?.name || workspace.name },
    });
  return build;
}

export async function executeIdeJob(db: PrismaClient, initial: IdeJob, signal: AbortSignal) {
  let workspace = await db.ideWorkspace.findUniqueOrThrow({ where: { id: initial.workspaceId } });
  const input = initial.input as unknown as JobInput & { bindings: Bindings },
    bindings = input.bindings;
  const membership = await db.membership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: workspace.organizationId,
        userId: workspace.ownerId,
      },
    },
  });
  const principal: Principal = {
    organizationId: workspace.organizationId,
    userId: workspace.ownerId,
    email: workspace.ownerId,
    role: membership?.role || "EMPLOYEE",
    sessionId: bindings.sessionId,
  };
  const secrets: string[] = [];
  const events: Array<{ seq: number; type: string; data: unknown; at: string }> = [];
  let writes = Promise.resolve();
  let modelCalls = 0,
    inputTokens: number | null = 0,
    outputTokens: number | null = 0;
  const usage = () => ({
    modelCalls,
    inputTokens,
    outputTokens,
    monetaryCost: null,
    costNote: "没有经核实单价，不虚构费用",
  });
  const log = (type: string, data: unknown) => {
    events.push({
      seq: events.length + 1,
      type,
      data: redact(data, secrets),
      at: new Date().toISOString(),
    });
    if (events.length > 300) throw new ApiError(429, "本轮事件超过限制");
    writes = writes.then(async () => {
      await db.ideJob.updateMany({
        where: { id: initial.id, status: "RUNNING" },
        data: { events: json([...events]), usage: json(usage()) },
      });
    });
    return writes;
  };
  const authorize = async () => {
    signal.throwIfAborted();
    const [member, current, job] = await Promise.all([
      db.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: principal.organizationId,
            userId: principal.userId,
          },
        },
      }),
      db.ideWorkspace.findUnique({ where: { id: workspace.id } }),
      db.ideJob.findUnique({ where: { id: initial.id } }),
    ]);
    if (!member || member.disabledAt || !["ADMIN", "BUILDER"].includes(member.role))
      throw new ApiError(403, "开发权限已撤销");
    if (
      !current ||
      current.ownerId !== principal.userId ||
      digest(current.settings) !== bindings.settingsDigest
    )
      throw new ApiError(403, "工程配置已变更，请重新发起");
    if (!job || job.cancelRequested || job.status !== "RUNNING")
      throw new ApiError(409, "操作已停止或中断");
    if (
      bindings.sessionId &&
      !(await db.authSession.count({
        where: { id: bindings.sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      }))
    )
      throw new ApiError(403, "登录会话已撤销");
    workspace = current;
  };
  const pinnedConnection = async (key: string) => {
    await authorize();
    const row = await scopedConnection(db, principal, key);
    if (!row || row.revision !== bindings.revisions[key] || row.testCode !== "OK")
      throw new ApiError(409, "连接未验证、已更换或已撤销");
    const secret = connectionSecret(row);
    if (secret.apiKey) secrets.push(secret.apiKey);
    if (secret.clientId) secrets.push(secret.clientId);
    return row;
  };
  let callCount = 0;
  let lastBuild: IdeBuild | undefined;
  const buildCurrent = async (buildSignal = signal) => {
    const current = await db.ideWorkspace.findUniqueOrThrow({ where: { id: workspace.id } });
    if (lastBuild?.sourceDigest === current.sourceDigest) return lastBuild;
    return (lastBuild = await buildWorkspace(db, workspace.id, buildSignal));
  };
  const runtime = async (
    build: IdeBuild,
    value: unknown,
    mode: "AGENT" | "MCP" | "SCRIPT" | "SKILL" = "AGENT",
    target?: string,
    selectedTool = input.tool,
    runSignal = signal,
  ): Promise<unknown> => {
    const files = await revisionFiles(db, workspace.id, build.sourceDigest),
      manifest = parseProject(files);
    const bundles = build.bundles as Record<string, string>;
    const settings = workspace.settings as { authorizedTools?: string[]; enabledSkills?: string[] };
    const permit = (name: string) => {
      if (
        !manifest.permissions.includes(name) ||
        !settings.authorizedTools?.includes(name) ||
        !input.consent.includes(name)
      )
        throw new ApiError(403, `能力 ${name} 需要工程声明、设置授权和本次操作同意`);
    };
    const invoke = async (method: string, args: unknown[]): Promise<unknown> => {
      runSignal.throwIfAborted();
      await authorize();
      if (++callCount > 40) throw new ApiError(429, "运行调用超过限制");
      await log("runtime.call", { method, args });
      let result: unknown;
      if (method === "model") {
        const row = await pinnedConnection(bindings.runtimeKey),
          model = modelConnection(row);
        let system = mode === "SKILL" ? "" : manifest.instructions;
        for (const directory of mode === "SKILL" ? [target!].filter(Boolean) : manifest.skills) {
          if (
            mode !== "SKILL" &&
            settings.enabledSkills &&
            !settings.enabledSkills.includes(directory)
          )
            continue;
          const skill = skillDefinition(files, directory);
          system += `\n[Skill ${skill.name}]\n${skill.instruction}`;
          await log("skill.loaded", {
            name: skill.name,
            directory,
            sourceDigest: build.sourceDigest,
          });
        }
        system += "\n" + String(args[1] || "");
        if (system.length > 40000 || String(args[0]).length > 60000)
          throw new ApiError(413, "模型上下文超过本次运行限制");
        const response = await createPersonalGateway(model)
          .generate(String(args[0]), system, { signal: runSignal, retry: false })
          .catch((error) => {
            modelCalls += (error as { usage?: { modelCalls?: number } }).usage?.modelCalls || 0;
            inputTokens = null;
            outputTokens = null;
            throw error;
          });
        modelCalls += response.usage?.modelCalls || 1;
        inputTokens =
          inputTokens === null ||
          response.usage?.inputTokens === null ||
          response.usage?.inputTokens === undefined
            ? null
            : inputTokens + response.usage.inputTokens;
        outputTokens =
          outputTokens === null ||
          response.usage?.outputTokens === null ||
          response.usage?.outputTokens === undefined
            ? null
            : outputTokens + response.usage.outputTokens;
        result = response.output;
      } else if (method === "asset") {
        const name = String(args[0]);
        if (!Object.hasOwn(files, name)) throw new ApiError(404, "工程资料不存在");
        if (files[name]!.length > 128000) throw new ApiError(413, "单次资料读取过大");
        result = files[name];
      } else if (method === "skill") {
        const name = String(args[0]),
          directory = manifest.skills.find(
            (directory) => skillDefinition(files, directory).name === name || directory === name,
          );
        if (!directory || (settings.enabledSkills && !settings.enabledSkills.includes(directory)))
          throw new ApiError(403, "技能未绑定或已停用");
        result = skillDefinition(files, directory).instruction;
      } else if (method === "script") {
        const name = String(args[0]);
        permit("script:" + name);
        const code = bundles["script:" + name];
        if (!code) throw new ApiError(404, "技能脚本不存在");
        result = await runProgram(code, args[1], {
          signal: runSignal,
          call: invoke,
          event: (t, d) => log(t, d),
        });
      } else if (method === "http") {
        const endpoint = String(args[0]),
          colon = endpoint.indexOf(":");
        const slot = endpoint.slice(0, colon),
          suffix = endpoint.slice(colon + 1);
        if (colon < 1 || !/^[a-z][a-z0-9-]{0,39}$/.test(slot))
          throw new ApiError(400, "API使用 slot:/path 格式");
        permit("api:" + slot);
        const options = z
          .object({ method: z.enum(["GET", "POST"]).default("GET"), body: z.unknown().optional() })
          .parse(args[1] || {});
        result = await endpointRequest(
          await pinnedConnection(bindingKey(workspace.id, "api", slot)),
          suffix,
          options.method,
          options.body,
          runSignal,
        );
      } else if (method === "tool") {
        const name = String(args[0]);
        permit(name);
        if (name.startsWith("mcp:")) {
          const [, server, tool] = name.split(":");
          if (!server || !tool) throw new ApiError(400, "MCP工具使用 mcp:server:tool 格式");
          const use = async (client: Parameters<Parameters<typeof withMcp>[2]>[0]) =>
            client.callTool(
              { name: tool, arguments: z.record(z.string(), z.unknown()).parse(args[1] || {}) },
              undefined,
              { signal: runSignal },
            );
          const code = bundles["mcp:" + server];
          if (code)
            result = await withMcp(
              code,
              { signal: runSignal, call: invoke, event: (t, d) => log(t, d) },
              use,
            );
          else {
            const row = await pinnedConnection(bindingKey(workspace.id, "mcp", server));
            result = await withRemoteMcp(row, runSignal, async (client) => {
              const current = await client.listTools(undefined, { signal: runSignal });
              if (digest(current.tools) !== digest((row.settings as { tools?: unknown }).tools))
                throw new ApiError(409, "MCP工具定义已变化，请重新测试并检查授权");
              return use(client);
            });
          }
          if ((result as { isError?: boolean })?.isError)
            throw new ApiError(502, "MCP工具返回业务错误");
        } else {
          const connector = connectors.find((connector) => connector.capability === name);
          if (!connector) throw new ApiError(403, "工具未注册");
          const row = await pinnedConnection(connector.provider);
          const argumentsSchema = z
            .object(
              Object.fromEntries(
                Object.keys(connector.input).map((key) => [key, z.string().max(2000)]),
              ),
            )
            .strict();
          result = await useIntegrationTool(
            row,
            connector.action,
            argumentsSchema.parse(args[1] || {}),
            runSignal,
          );
        }
      } else throw new ApiError(403, "未知运行能力");
      await authorize();
      await log("runtime.result", { method, result });
      return redact(result, secrets, 1000000, Number.MAX_SAFE_INTEGER);
    };
    const options = {
      signal: runSignal,
      call: invoke,
      event: (t: string, d: unknown) => log(t, d),
    };
    if (mode === "MCP") {
      const code = target ? bundles["mcp:" + target] : bundles.mcp;
      if (!code) throw new ApiError(404, "当前构建没有该MCP服务");
      return withMcp(code, options, async (client) => {
        const catalogue = await client.listTools(undefined, { signal: runSignal });
        if (!selectedTool) return { tools: catalogue.tools };
        const result = await client.callTool(
          { name: selectedTool, arguments: z.record(z.string(), z.unknown()).parse(value || {}) },
          undefined,
          { signal: runSignal },
        );
        if (result.isError) throw new ApiError(502, "MCP工具返回业务错误");
        return result;
      });
    }
    const code =
      mode === "SCRIPT"
        ? bundles["script:" + target]
        : mode === "SKILL"
          ? bundles["skill:" + target]
          : bundles.agent;
    if (!code) throw new ApiError(409, "当前构建没有可运行入口");
    return runProgram(code, value, options);
  };
  const evaluations = new Map<
    string,
    {
      status: string;
      cases: Array<{ name: string; passed: boolean; output?: unknown; error?: string }>;
    }
  >();
  const evaluate = async (build: IdeBuild, runSignal = signal) => {
    if (evaluations.has(build.sourceDigest)) {
      await log("evaluation.reused", { sourceDigest: build.sourceDigest });
      return evaluations.get(build.sourceDigest)!;
    }
    const files = await revisionFiles(db, workspace.id, build.sourceDigest),
      manifest = parseProject(files);
    if (!manifest.tests) return { status: "NOT_EVALUATED", cases: [] };
    const cases = caseSchema.parse(JSON.parse(files[manifest.tests]!));
    const results: Array<{ name: string; passed: boolean; output?: unknown; error?: string }> = [];
    for (const example of cases) {
      runSignal.throwIfAborted();
      try {
        const mode = example.target
          ? manifest.skills.includes(example.target)
            ? "SKILL"
            : manifest.mcp.some((server) => server.name === example.target)
              ? "MCP"
              : "SCRIPT"
          : manifest.kind === "MCP"
            ? "MCP"
            : "AGENT";
        const output = await runtime(
          build,
          example.input,
          mode,
          example.target,
          example.tool,
          runSignal,
        );
        const comparable =
          mode === "MCP"
            ? ((output as { structuredContent?: unknown }).structuredContent ?? output)
            : output;
        const hasAssertion = Object.hasOwn(example, "expected") || Boolean(example.contains);
        const passed =
          hasAssertion &&
          (Object.hasOwn(example, "expected")
            ? digest(comparable) === digest(example.expected)
            : JSON.stringify(comparable).includes(example.contains!));
        results.push({ name: example.name, passed, output: comparable });
      } catch (error) {
        if (runSignal.aborted) throw error;
        results.push({
          name: example.name,
          passed: false,
          error: error instanceof Error ? error.message : "案例失败",
        });
      }
    }
    const result = {
      status: cases.length && results.every((r) => r.passed) ? "PASSED" : "FAILED",
      cases: results,
    };
    await log("evaluation", result);
    await db.ideBuild.update({
      where: { id: build.id },
      data: {
        evidence: json({
          ...(build.evidence as object),
          evaluation: redact(result, secrets, 1000000),
          bindingDigest: digest(bindings),
        }),
      },
    });
    evaluations.set(build.sourceDigest, result);
    return result;
  };
  try {
    await authorize();
    await log("operation.start", { kind: initial.kind, sourceDigest: initial.sourceDigest });
    let output: unknown;
    if (initial.kind === "DEVELOP") {
      const { model } = await runtimeModel(db, principal, "model", bindings.revisions.model);
      secrets.push(model.apiKey);
      const toolNames = [
        "workspace_read",
        "workspace_search",
        "workspace_patch",
        "workspace_build",
        "workspace_test",
      ];
      const authorizeModel = async () => {
        await pinnedConnection("model");
      };
      const session = await runDshSession({
        runId: initial.id,
        taskId: initial.id,
        organizationId: workspace.organizationId,
        agentId: workspace.id,
        task: input.prompt!,
        model,
        signal,
        timeoutMs: 240000,
        configuredModelOnly: true,
        persona: `你是 Poros 的 Agent AI IDE 开发者。当前工程类型 ${workspace.kind}。${input.target ? "当前定制目标：" + input.target : ""}只能使用授权工作区工具。
先读取 poros.json 和相关源文件，修改真实工程并调用 workspace_build，失败时据诊断修复。有验收案例时调用 workspace_test。不要将编译通过称为业务验收通过，不伪造连接或测试结果。
工作区路径之外没有访问权限。保持工程kind，定制技能放 skills/<name>/SKILL.md（标准元数据），脚本默认导出函数；MCP使用defineMcp并在poros.json的mcp中登记。
poros.json格式：formatVersion:1,name,kind,entry,preview?,instructions,skills:目录数组,mcp:[{name,entry}],permissions:精确能力名数组,tests?:JSON案例文件。
工具名为 web.search/web.fetch/kdocs.search/kdocs.read/ima.list/ima.search 或 mcp:服务名:工具名；API用ctx.http("slot:/path",options)，声明api:slot。声明不等同授权，凭证由用户设置。
源码支持本工程相对导入、@poros/sdk，以及界面React/react-dom。不要写未实现依赖、虚构API或凭证。MCP工具实现通过handler使用ctx；不要仅输出URL配置。
SDK类型：${sdkDeclarations}
文件列表：${Object.keys(await revisionFiles(db, workspace.id, workspace.sourceDigest)).join(", ")}`,
        grants: [
          { kind: "MODEL", name: model.model, source: personalModelSource + model.baseUrl },
          ...toolNames.map((name) => ({ kind: "TOOL" as const, name })),
        ],
        brokerTools: [
          {
            name: "workspace_read",
            description: "读取当前版本文件或文件列表，返回源码摘要。offset为字符偏移。",
            input: { path: "string", offset: "string" },
          },
          { name: "workspace_search", description: "检索工程文件内容", input: { query: "string" } },
          {
            name: "workspace_patch",
            description:
              "原子修改工程；files为JSON路径到完整文本/null映射，expectedDigest来自读取回执",
            input: { files: "string", expectedDigest: "string" },
          },
          {
            name: "workspace_build",
            description: "真实类型检查与构建，返回诊断",
            input: {},
            timeoutMs: 60000,
          },
          {
            name: "workspace_test",
            description: "运行poros.json声明的真实案例，返回实际结果；没有案例保持未评估",
            input: {},
            timeoutMs: 120000,
          },
        ],
        authorizeModel,
        authorizeTool: async (name) => {
          await authorize();
          if (!toolNames.includes(name)) throw new ApiError(403, "未授权开发工具");
        },
        invokeTool: async (name, raw, toolSignal) => {
          await authorize();
          const args = z.record(z.string(), z.unknown()).parse(raw || {});
          const current = await db.ideWorkspace.findUniqueOrThrow({ where: { id: workspace.id } });
          const files = await revisionFiles(db, workspace.id, current.sourceDigest);
          if (name === "workspace_read") {
            const filename = String(args.path || ""),
              offset = Math.max(0, Math.min(2000000, Number(args.offset) || 0));
            if (!filename || filename === ".")
              return { ok: true, digest: current.sourceDigest, files: Object.keys(files) };
            if (!Object.hasOwn(files, filename)) throw new ApiError(404, "文件不存在");
            return {
              ok: true,
              digest: current.sourceDigest,
              path: filename,
              content: files[filename]!.slice(offset, offset + 16000),
              totalCharacters: files[filename]!.length,
              offset,
            };
          }
          if (name === "workspace_search")
            return {
              ok: true,
              digest: current.sourceDigest,
              matches: Object.entries(files)
                .flatMap(([name, text]) => {
                  const index = text.indexOf(String(args.query));
                  return index < 0
                    ? []
                    : [
                        {
                          path: name,
                          offset: index,
                          text: text.slice(Math.max(0, index - 100), index + 400),
                        },
                      ];
                })
                .slice(0, 40),
            };
          if (name === "workspace_patch") {
            const patch = z
              .record(z.string(), z.string().nullable())
              .parse(JSON.parse(String(args.files)));
            const next = { ...files };
            for (const [name, content] of Object.entries(patch)) {
              if (content === null) delete next[name];
              else next[name] = content;
            }
            const saved = await saveRevision(
              db,
              principal,
              workspace.id,
              String(args.expectedDigest),
              validateFiles(next),
            );
            await log("source.changed", { digest: saved.digest, files: Object.keys(patch) });
            return { ok: true, digest: saved.digest, files: Object.keys(patch) };
          }
          if (name === "workspace_build" || name === "workspace_test") {
            toolSignal.throwIfAborted();
            const built = await buildCurrent(toolSignal);
            await log("build", {
              id: built.id,
              status: built.status,
              diagnostics: built.diagnostics,
            });
            if (built.status !== "READY")
              return {
                ok: true,
                buildId: built.id,
                status: built.status,
                diagnostics: built.diagnostics,
              };
            return name === "workspace_test"
              ? { ok: true, buildId: built.id, ...(await evaluate(built, toolSignal)) }
              : { ok: true, buildId: built.id, status: "READY", businessVerified: false };
          }
          throw new ApiError(403, "未授权开发工具");
        },
        onEvent: (event) => log("development." + event.type, event),
      });
      modelCalls += session.modelCalls || 0;
      inputTokens = null;
      outputTokens = null;
      if (!session.completed || session.error)
        throw new ApiError(502, session.error || session.diagnostics || "开发运行未完成");
      const built = await buildCurrent();
      if (built.status !== "READY")
        throw new ApiError(422, "当前修改构建失败：" + JSON.stringify(built.diagnostics));
      const evaluated = await evaluate(built);
      output = {
        summary: session.final,
        buildId: built.id,
        sourceDigest: built.sourceDigest,
        evaluation: evaluated,
      };
      if (evaluated.status === "FAILED")
        throw Object.assign(new ApiError(422, "工程可构建，但验收案例未通过"), { output });
    } else {
      let built: IdeBuild | null = initial.buildId
        ? await db.ideBuild.findFirst({
            where: { id: initial.buildId, workspaceId: workspace.id, status: "READY" },
          })
        : null;
      if (!built) built = await buildWorkspace(db, workspace.id, signal);
      if (built.status !== "READY")
        throw new ApiError(422, "构建失败：" + JSON.stringify(built.diagnostics));
      if (initial.kind === "BUILD")
        output = { buildId: built.id, sourceDigest: built.sourceDigest, businessVerified: false };
      else if (initial.kind === "PACKAGE") {
        await log("package.start", { buildId: built.id });
        output = await packageDesktop(
          db,
          principal,
          workspace.id,
          initial.id,
          built,
          Boolean(input.includeMaterials),
          signal,
        );
        await log("package.ready", output);
      } else if (initial.kind === "TEST") {
        const evaluated = await evaluate(built);
        output = { buildId: built.id, evaluation: evaluated };
        if (evaluated.status !== "PASSED")
          throw Object.assign(
            new ApiError(
              422,
              evaluated.status === "NOT_EVALUATED"
                ? "当前工程没有验收案例，未判定通过"
                : "验收案例未通过",
            ),
            { output },
          );
      } else
        output = {
          buildId: built.id,
          result: await runtime(
            built,
            input.input,
            initial.kind === "MCP_TEST"
              ? "MCP"
              : initial.kind === "SCRIPT_TEST"
                ? "SCRIPT"
                : initial.kind === "SKILL_TEST"
                  ? "SKILL"
                  : "AGENT",
            input.target,
          ),
          verification: "NOT_EVALUATED",
        };
    }
    await authorize();
    await writes;
    await db.ideJob.updateMany({
      where: { id: initial.id, status: "RUNNING" },
      data: {
        status: "SUCCEEDED",
        stage: "completed",
        output: json(redact(output, secrets, 1000000, Number.MAX_SAFE_INTEGER)),
        usage: json(usage()),
      },
    });
  } catch (error) {
    await writes.catch(() => {});
    const job = await db.ideJob.findUnique({ where: { id: initial.id } });
    const failure = error instanceof Error ? error.message : "操作失败";
    const message = error instanceof ProviderError ? describeProviderError(error).message : failure;
    await db.ideJob.updateMany({
      where: { id: initial.id, status: "RUNNING" },
      data: {
        status: job?.cancelRequested ? "CANCELLED" : signal.aborted ? "INTERRUPTED" : "FAILED",
        stage: "stopped",
        output: json(
          redact(
            { error: message, ...((error as { output?: object }).output || {}) },
            secrets,
            1000000,
          ),
        ),
        usage: json(usage()),
      },
    });
  }
}

export function startIdeWorker(db: PrismaClient) {
  const workerId = randomUUID();
  let closing = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> = Promise.resolve();
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const tick = async () => {
    if (closing || active.size >= 2) return;
    const job = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(709141822)::text`;
      await tx.ideJob.updateMany({
        where: { status: "RUNNING", leaseUntil: { lt: new Date() } },
        data: {
          status: "INTERRUPTED",
          stage: "stopped",
          output: { error: "执行租约失效，未自动重放操作" },
        },
      });
      if ((await tx.ideJob.count({ where: { status: "RUNNING" } })) >= 2) return null;
      const sourceRunning = await tx.ideJob.count({ where: { status: "RUNNING", buildId: null } });
      const packaging = await tx.ideJob.count({ where: { status: "RUNNING", kind: "PACKAGE" } });
      const queued = await tx.ideJob.findFirst({
        where: {
          status: "QUEUED",
          ...(packaging ? { kind: { not: "PACKAGE" } } : {}),
          ...(sourceRunning ? { buildId: { not: null } } : {}),
        },
        orderBy: { createdAt: "asc" },
      });
      if (!queued) return null;
      return tx.ideJob.update({
        where: { id: queued.id },
        data: {
          status: "RUNNING",
          stage: "running",
          workerId,
          leaseUntil: new Date(Date.now() + 30000),
        },
      });
    });
    if (!job) return;
    if (closing) {
      await db.ideJob.updateMany({
        where: { id: job.id, workerId, status: "RUNNING" },
        data: { status: "QUEUED", stage: "queued", workerId: null, leaseUntil: null },
      });
      return;
    }
    const controller = new AbortController();
    const watch = setInterval(() => {
      void db.ideJob
        .findUnique({ where: { id: job.id } })
        .then((current) => {
          if (!current || current.cancelRequested || current.status !== "RUNNING")
            controller.abort();
          else
            return db.ideJob.updateMany({
              where: { id: job.id, workerId, status: "RUNNING" },
              data: { leaseUntil: new Date(Date.now() + 30000) },
            });
        })
        .catch(() => controller.abort());
    }, 1500);
    const deadline = setTimeout(() => controller.abort(), 300000);
    const done = executeIdeJob(db, job, controller.signal).finally(() => {
      clearInterval(watch);
      clearTimeout(deadline);
      active.delete(job.id);
    });
    active.set(job.id, { controller, done });
    void done.catch((error) =>
      console.error("IDE execution", error instanceof Error ? error.name : "error"),
    );
  };
  const schedule = () => {
    if (!closing)
      timer = setTimeout(() => {
        polling = tick()
          .catch((error) =>
            console.error("IDE worker", error instanceof Error ? error.name : "error"),
          )
          .finally(schedule);
      }, 300);
  };
  schedule();
  return {
    stop: async () => {
      closing = true;
      if (timer) clearTimeout(timer);
      await polling;
      const jobs = [...active.values()];
      jobs.forEach((job) => job.controller.abort());
      await Promise.allSettled(jobs.map((job) => job.done));
    },
  };
}
