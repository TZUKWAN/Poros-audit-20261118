import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../server/errors.js";
import { canonicalModelBase, checkModelBase } from "../server/provider-http.js";
import { modelId, sealConnectionSecret } from "../server/integration-connections.js";
import { verifyIntegration } from "../server/integration-providers.js";
import { describeProviderError } from "../server/provider-errors.js";
import { endpointRequest, validateAuthHeader, withRemoteMcp } from "../server/ide/connections.js";
import { runtimeRow } from "./runner.js";
import type { RuntimeCredential, RuntimeStore } from "./store.js";
export const runtimeProvider = z
  .string()
  .regex(/^(?:model|kdocs|ima|tinyfish|(?:api|mcp):[a-z][a-z0-9-]{0,39})$/);
const inputSchema = z
  .object({
    apiKey: z.string().max(6000).default(""),
    clientId: z.string().max(6000).optional(),
    baseUrl: z.string().url().max(500).optional(),
    model: modelId.optional(),
    testPath: z.string().max(300).default("/"),
    authHeader: z.string().default("Authorization"),
    authPrefix: z.enum(["Bearer", "Basic", ""]).default("Bearer"),
  })
  .strict();
function admitOwnerLoopback(base: string, model: boolean) {
  const url = new URL(base);
  if (!["127.0.0.1", "[::1]"].includes(url.hostname)) return;
  const key = model ? "POROS_LOCAL_MODEL_BASES" : "POROS_LOCAL_API_BASES";
  process.env[key] = [
    ...new Set([...(process.env[key] || "").split(",").filter(Boolean), base]),
  ].join(",");
}
export function restoreRuntimeConnectionHosts(store: RuntimeStore) {
  for (const row of store.snapshot().credentials) {
    if (
      typeof row.settings.baseUrl === "string" &&
      (row.provider === "model" || /^(?:api|mcp):/.test(row.provider))
    )
      admitOwnerLoopback(row.settings.baseUrl, row.provider === "model");
  }
}
export function runtimeConnectionView(row: RuntimeCredential) {
  return {
    provider: row.provider,
    settings: row.settings,
    testedAt: row.testedAt,
    verified: row.testCode === "OK",
    testCode: row.testCode,
  };
}
export async function saveRuntimeConnection(store: RuntimeStore, provider: string, raw: unknown) {
  runtimeProvider.parse(provider);
  const input = inputSchema.parse(raw),
    now = new Date().toISOString();
  const settings: Record<string, unknown> = {};
  if (provider === "model") {
    if (!input.baseUrl || !input.model || !input.apiKey.trim())
      throw new ApiError(400, "请填写模型地址、ID 和 API Key");
    const base = canonicalModelBase(input.baseUrl);
    admitOwnerLoopback(base, true);
    checkModelBase(base);
    settings.baseUrl = base;
    settings.model = input.model;
  } else if (provider.startsWith("api:") || provider.startsWith("mcp:")) {
    if (!input.baseUrl) throw new ApiError(400, "请填写连接地址");
    const url = new URL(input.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new ApiError(400, "连接地址不能包含凭证");
    validateAuthHeader(input.authHeader);
    Object.assign(settings, {
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      testPath: input.testPath,
      authHeader: input.authHeader,
      authPrefix: input.authPrefix,
    });
    admitOwnerLoopback(String(settings.baseUrl), false);
  } else if (!input.apiKey.trim() || (provider === "ima" && !input.clientId?.trim()))
    throw new ApiError(400, "连接凭证不完整");
  const identity = {
    organizationId: store.package().payload.appId,
    userId: "installation",
    provider,
    revision: randomUUID(),
  };
  const row: RuntimeCredential = {
    ...identity,
    settings,
    encryptedKey: sealConnectionSecret(
      identity,
      { apiKey: input.apiKey, clientId: input.clientId },
      store.key,
    ),
    testedAt: null,
    testCode: null,
    updatedAt: now,
  };
  await store.change((next) => {
    next.credentials = [...next.credentials.filter((item) => item.provider !== provider), row];
  });
  return runtimeConnectionView(row);
}
export async function testRuntimeConnection(store: RuntimeStore, provider: string) {
  const saved = store.snapshot().credentials.find((item) => item.provider === provider);
  if (!saved) throw new ApiError(404, "请先保存连接");
  const row = runtimeRow(saved);
  let code = "OK",
    message = "实际连接测试通过",
    tools: unknown;
  try {
    const signal = AbortSignal.timeout(25000);
    if (provider.startsWith("mcp:"))
      tools = await withRemoteMcp(
        row,
        signal,
        async (client) => (await client.listTools(undefined, { signal })).tools,
        store.key,
      );
    else if (provider.startsWith("api:"))
      await endpointRequest(
        row,
        String(saved.settings.testPath || "/"),
        "GET",
        undefined,
        signal,
        store.key,
      );
    else await verifyIntegration(row, store.key);
  } catch (error) {
    const failure = describeProviderError(error);
    code = failure.code;
    message = failure.message;
  }
  await store.change((next) => {
    const current = next.credentials.find((item) => item.provider === provider);
    if (!current || current.revision !== saved.revision)
      throw new ApiError(409, "测试期间连接已变更");
    current.testCode = code;
    current.testedAt = new Date().toISOString();
    if (tools && code === "OK") current.settings.tools = tools;
  });
  return { passed: code === "OK", code, message, ...(tools ? { tools } : {}) };
}
