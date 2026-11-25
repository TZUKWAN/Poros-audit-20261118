import type { IntegrationConnection } from "@prisma/client";
import { z } from "zod";
import { parseProject, caseSchema, skillDefinition } from "../agent-project/contract.js";
import { canonical, sha256, type AppPackage } from "../agent-project/package.js";
import { runProgram, withMcp } from "../agent-project/sandbox.js";
import { ApiError } from "../server/errors.js";
import { connectionSecret, modelConnection } from "../server/integration-connections.js";
import { useIntegrationTool } from "../server/integration-providers.js";
import { connectors } from "../server/capability-catalog.js";
import { addUsageCount, createPersonalGateway } from "../server/model-gateway.js";
import { endpointRequest, withRemoteMcp } from "../server/ide/connections.js";
import { redact } from "../server/redact.js";
import type { RuntimeActor, RuntimeCredential, RuntimeJob, RuntimeStore } from "./store.js";

export const runtimeRow = (row: RuntimeCredential): IntegrationConnection => ({
  ...row,
  settings: row.settings as IntegrationConnection["settings"],
  testedAt: row.testedAt ? new Date(row.testedAt) : null,
  updatedAt: new Date(row.updatedAt),
});
export async function executeApp(
  store: RuntimeStore,
  actor: RuntimeActor,
  kind: RuntimeJob["kind"],
  request: { input?: unknown; target?: string; tool?: string },
  consent: string[],
  signal: AbortSignal,
  event: (type: string, data: unknown) => Promise<void>,
) {
  const pkg = store.package(),
    initial = store.snapshot(),
    files = pkg.payload.files,
    manifest = parseProject(files),
    bundles = pkg.payload.build.bundles;
  const rows = initial.credentials.map(runtimeRow),
    secrets = rows.flatMap((row) => {
      const secret = connectionSecret(row, store.key);
      return [secret.apiKey, secret.clientId || ""].filter(Boolean);
    });
  const clean = (value: unknown) => redact(value, secrets, 1000000, Number.MAX_SAFE_INTEGER);
  const settingsDigest = sha256(canonical(initial.settings));
  const scope = sha256(pkg.payload.appId + ":" + store.directory);
  let calls = 0,
    modelCalls = 0,
    inputTokens: number | null = 0,
    outputTokens: number | null = 0;
  const usage = () => ({ modelCalls, inputTokens, outputTokens, monetaryCost: null });
  const authorize = () => {
    signal.throwIfAborted();
    const current = store.snapshot(),
      session = current.sessions.find((item) => item.hash === actor.hash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now())
      throw new ApiError(403, "设备或会话已撤销");
    if (
      (current.package as AppPackage).payload.version !== pkg.payload.version ||
      sha256(canonical(current.settings)) !== settingsDigest
    )
      throw new ApiError(409, "软件或权限配置已变更，请重新发起");
    return current;
  };
  const row = (provider: string) => {
    const current = authorize(),
      pinned = rows.find((item) => item.provider === provider),
      live = current.credentials.find((item) => item.provider === provider);
    if (!pinned || !live || pinned.revision !== live.revision || live.testCode !== "OK")
      throw new ApiError(409, "连接未验证、已更换或已撤销：" + provider);
    return pinned;
  };
  const permit = (name: string) => {
    authorize();
    if (
      !manifest.permissions.includes(name) ||
      !initial.settings.authorizedTools.includes(name) ||
      !consent.includes(name) ||
      (actor.role === "DEVICE" && !actor.grants.includes(name))
    )
      throw new ApiError(403, "能力未获本次授权：" + name);
  };
  const log = (type: string, data: unknown) => event(type, clean(data));
  const execute = async (
    value: unknown,
    mode: "AGENT" | "MCP" | "SKILL" | "SCRIPT",
    target?: string,
    tool?: string,
  ): Promise<unknown> => {
    const invoke = async (method: string, args: unknown[]): Promise<unknown> => {
      authorize();
      if (++calls > 40) throw new ApiError(429, "运行能力调用超过限制");
      await log("runtime.call", { method, args });
      let result: unknown;
      if (method === "model") {
        const modelRow = row("model"),
          model = modelConnection(modelRow, store.key);
        let system = mode === "SKILL" ? "" : manifest.instructions;
        for (const directory of mode === "SKILL" ? [target!].filter(Boolean) : manifest.skills) {
          if (
            mode !== "SKILL" &&
            initial.settings.enabledSkills &&
            !initial.settings.enabledSkills.includes(directory)
          )
            continue;
          const skill = skillDefinition(files, directory);
          system += "\n[Skill " + skill.name + "]\n" + skill.instruction;
          await log("skill.loaded", {
            name: skill.name,
            directory,
            sourceDigest: pkg.payload.sourceDigest,
          });
        }
        system += "\n" + String(args[1] || "");
        if (system.length > 40000 || String(args[0]).length > 60000)
          throw new ApiError(413, "模型上下文超过限制");
        const response = await createPersonalGateway(model)
          .generate(String(args[0]), system, { signal, retry: false })
          .catch((error) => {
            modelCalls += (error as { usage?: { modelCalls?: number } }).usage?.modelCalls || 0;
            inputTokens = null;
            outputTokens = null;
            throw error;
          });
        modelCalls += response.usage?.modelCalls || 1;
        inputTokens = addUsageCount(inputTokens, response.usage?.inputTokens);
        outputTokens = addUsageCount(outputTokens, response.usage?.outputTokens);
        row("model");
        result = response.output;
      } else if (method === "asset") {
        const path = String(args[0]);
        if (!Object.hasOwn(files, path)) throw new ApiError(404, "包内资料不存在");
        result = files[path];
      } else if (method === "skill") {
        const name = String(args[0]),
          directory = manifest.skills.find(
            (item) => item === name || skillDefinition(files, item).name === name,
          );
        if (
          !directory ||
          (initial.settings.enabledSkills && !initial.settings.enabledSkills.includes(directory))
        )
          throw new ApiError(403, "技能未绑定或已停用");
        result = skillDefinition(files, directory).instruction;
      } else if (method === "script") {
        const path = String(args[0]);
        permit("script:" + path);
        const code = bundles["script:" + path];
        if (!code) throw new ApiError(404, "技能脚本不存在");
        result = await runProgram(code, args[1], {
          signal,
          scope,
          call: invoke,
          event: (t, d) => log(t, d),
        });
      } else if (method === "http") {
        const match = String(args[0]).match(/^([a-z][a-z0-9-]{0,39}):(\/.*)$/);
        if (!match) throw new ApiError(400, "API 使用 slot:/path 格式");
        const provider = "api:" + match[1];
        permit(provider);
        const options = z
          .object({ method: z.enum(["GET", "POST"]).default("GET"), body: z.unknown().optional() })
          .parse(args[1] || {});
        result = await endpointRequest(
          row(provider),
          match[2]!,
          options.method,
          options.body,
          signal,
          store.key,
        );
        row(provider);
      } else if (method === "tool") {
        const name = String(args[0]);
        permit(name);
        if (name.startsWith("mcp:")) {
          const [, server, nameOfTool] = name.split(":");
          if (!server || !nameOfTool) throw new ApiError(400, "MCP 工具名称不合法");
          const use = async (client: Parameters<Parameters<typeof withMcp>[2]>[0]) =>
            client.callTool(
              {
                name: nameOfTool,
                arguments: z.record(z.string(), z.unknown()).parse(args[1] || {}),
              },
              undefined,
              { signal },
            );
          const code = bundles["mcp:" + server];
          if (code) result = await withMcp(code, { signal, scope, call: invoke }, use);
          else {
            const provider = "mcp:" + server,
              connection = row(provider);
            result = await withRemoteMcp(
              connection,
              signal,
              async (client) => {
                const current = await client.listTools(undefined, { signal });
                if (
                  canonical(current.tools) !==
                  canonical((connection.settings as { tools?: unknown }).tools)
                )
                  throw new ApiError(409, "MCP 工具发生变化，请重新测试并授权");
                return use(client);
              },
              store.key,
            );
            row(provider);
          }
          if ((result as { isError?: boolean })?.isError)
            throw new ApiError(502, "MCP 工具返回业务错误");
        } else {
          const connector = connectors.find((item) => item.capability === name);
          if (!connector) throw new ApiError(403, "工具未注册");
          const validated = z
            .object(
              Object.fromEntries(
                Object.keys(connector.input).map((key) => [key, z.string().max(2000)]),
              ),
            )
            .strict()
            .parse(args[1] || {});
          result = await useIntegrationTool(
            row(connector.provider),
            connector.action,
            validated,
            signal,
            store.key,
          );
          row(connector.provider);
        }
      } else throw new ApiError(403, "未知能力调用");
      authorize();
      await log("runtime.result", { method, result });
      return clean(result);
    };
    const options = { signal, scope, call: invoke, event: (t: string, d: unknown) => log(t, d) };
    if (mode === "MCP") {
      const code = target ? bundles["mcp:" + target] : bundles.mcp;
      if (!code) throw new ApiError(404, "包内 MCP 不存在");
      return withMcp(code, options, async (client) => {
        const tools = await client.listTools(undefined, { signal });
        if (!tool) return { tools: tools.tools };
        const result = await client.callTool(
          { name: tool, arguments: z.record(z.string(), z.unknown()).parse(value || {}) },
          undefined,
          { signal },
        );
        if (result.isError) throw new ApiError(502, "MCP 工具返回业务错误");
        return result;
      });
    }
    const code =
      mode === "SCRIPT"
        ? bundles["script:" + target]
        : mode === "SKILL"
          ? bundles["skill:" + (target || manifest.skills[0])]
          : bundles.agent;
    if (!code) throw new ApiError(409, "软件包没有可运行入口");
    return runProgram(code, value, options);
  };
  try {
    authorize();
    let output: unknown;
    if (kind === "TEST") {
      if (!manifest.tests) throw new ApiError(409, "当前版本没有验收案例，未判定通过");
      const cases = caseSchema.parse(JSON.parse(files[manifest.tests]!)),
        results = [];
      for (const example of cases) {
        signal.throwIfAborted();
        try {
          const mode = example.target
            ? manifest.skills.includes(example.target)
              ? "SKILL"
              : manifest.mcp.some((item) => item.name === example.target)
                ? "MCP"
                : "SCRIPT"
            : manifest.kind === "MCP"
              ? "MCP"
              : manifest.kind === "SKILL"
                ? "SKILL"
                : "AGENT";
          const actual = await execute(example.input, mode, example.target, example.tool),
            comparable =
              mode === "MCP"
                ? ((actual as { structuredContent?: unknown }).structuredContent ?? actual)
                : actual;
          const passed =
            (Object.hasOwn(example, "expected") || Boolean(example.contains)) &&
            (Object.hasOwn(example, "expected")
              ? canonical(comparable) === canonical(example.expected)
              : JSON.stringify(comparable).includes(example.contains!));
          results.push({ name: example.name, passed, output: clean(comparable) });
        } catch (error) {
          if (signal.aborted) throw error;
          results.push({
            name: example.name,
            passed: false,
            error: error instanceof Error ? error.message : "案例失败",
          });
        }
      }
      const evaluation = {
        status: cases.length && results.every((item) => item.passed) ? "PASSED" : "FAILED",
        cases: results,
      };
      output = { version: pkg.payload.version, evaluation };
      if (evaluation.status !== "PASSED")
        throw Object.assign(new ApiError(422, "验收案例未通过"), { output });
    } else
      output = {
        version: pkg.payload.version,
        result: await execute(
          request.input,
          kind === "MCP_TEST"
            ? "MCP"
            : kind === "SKILL_TEST"
              ? "SKILL"
              : manifest.kind === "MCP"
                ? "MCP"
                : manifest.kind === "SKILL"
                  ? "SKILL"
                  : "AGENT",
          request.target,
          request.tool,
        ),
        verification: "NOT_EVALUATED",
      };
    authorize();
    return { output: clean(output), usage: usage() };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("运行失败"), { usage: usage() });
  }
}
