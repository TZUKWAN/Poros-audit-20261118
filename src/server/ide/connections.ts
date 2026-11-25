import type { IntegrationConnection, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { Principal } from "../auth.js";
import {
  connectionSecret,
  modelConnection,
  sealConnectionSecret,
} from "../integration-connections.js";
import {
  checkProviderResponse,
  readProviderText,
  requestPublicEndpoint,
} from "../provider-http.js";
import { ApiError } from "../errors.js";

export const bindingKey = (workspaceId: string, kind: "model" | "mcp" | "api", name = "") =>
  `ide:${workspaceId}:${kind}${name ? ":" + name : ""}`;
export const scopedConnection = (
  db: PrismaClient,
  p: Pick<Principal, "organizationId" | "userId">,
  key: string,
) =>
  db.integrationConnection.findUnique({
    where: {
      organizationId_userId_provider: {
        organizationId: p.organizationId,
        userId: p.userId,
        provider: key,
      },
    },
  });

export async function saveEndpoint(db: PrismaClient, p: Principal, key: string, input: unknown) {
  const b = z
    .object({
      baseUrl: z.string().url().max(500),
      token: z.string().max(6000).default(""),
      testPath: z.string().max(300).default("/"),
      authHeader: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,80}$/)
        .default("Authorization"),
      authPrefix: z.enum(["Bearer", "Basic", ""]).default("Bearer"),
    })
    .strict()
    .parse(input);
  const url = new URL(b.baseUrl);
  validateAuthHeader(b.authHeader);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new ApiError(400, "端点需要不含凭证的HTTP(S)地址");
  const identity = { organizationId: p.organizationId, userId: p.userId, provider: key },
    revision = randomUUID();
  const data = {
    revision,
    settings: {
      baseUrl: b.baseUrl.replace(/\/$/, ""),
      testPath: b.testPath,
      authHeader: b.authHeader,
      authPrefix: b.authPrefix,
    },
    encryptedKey: sealConnectionSecret({ ...identity, revision }, { apiKey: b.token }),
    testedAt: null,
    testCode: null,
  };
  return db.integrationConnection.upsert({
    where: { organizationId_userId_provider: identity },
    create: { ...identity, ...data },
    update: data,
  });
}
export function validateAuthHeader(name: string) {
  if (
    !/^[A-Za-z0-9-]{1,80}$/.test(name) ||
    /^(?:host|connection|content-length|content-type|upgrade|transfer-encoding|mcp-session-id|cookie|set-cookie|origin|referer|proxy-.*|sec-.*)$/i.test(
      name,
    )
  )
    throw new ApiError(400, "不能将凭证放入该请求头");
}
export function endpointAuth(row: IntegrationConnection, encryptionKey?: Buffer) {
  const settings = row.settings as { authHeader?: string; authPrefix?: string };
  const header = settings.authHeader || "Authorization",
    prefix = settings.authPrefix ?? "Bearer";
  validateAuthHeader(header);
  if (!["Bearer", "Basic", ""].includes(prefix)) throw new ApiError(400, "认证前缀不合法");
  const { apiKey } = connectionSecret(row, encryptionKey);
  return apiKey ? { [header.toLowerCase()]: (prefix ? prefix + " " : "") + apiKey } : {};
}

export async function endpointRequest(
  row: IntegrationConnection,
  suffix: string,
  method: "GET" | "POST" | "DELETE",
  body: unknown,
  signal: AbortSignal,
  encryptionKey?: Buffer,
) {
  const settings = z.object({ baseUrl: z.string() }).parse(row.settings);
  if (!suffix.startsWith("/") || suffix.startsWith("//") || suffix.includes("\\"))
    throw new ApiError(400, "API路径不合法");
  const base = new URL(settings.baseUrl + "/"),
    target = new URL("." + suffix, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
    throw new ApiError(403, "API请求超出绑定范围");
  const response = await requestPublicEndpoint(target.href, {
    method,
    signal,
    headers: { "content-type": "application/json", ...endpointAuth(row, encryptionKey) },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  await checkProviderResponse(response);
  const text = await readProviderText(response, 512 * 1024);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function withRemoteMcp<T>(
  row: IntegrationConnection,
  signal: AbortSignal,
  use: (client: Client) => Promise<T>,
  encryptionKey?: Buffer,
): Promise<T> {
  const { baseUrl } = z.object({ baseUrl: z.string().url() }).parse(row.settings);
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: endpointAuth(row, encryptionKey) },
    fetch: async (input, init) => {
      const target = new URL(String(input));
      if (target.href !== new URL(baseUrl).href) throw new ApiError(403, "MCP请求超出绑定端点");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const method = init?.method || "POST";
      if (
        !["GET", "POST", "DELETE"].includes(method) ||
        (init?.body && typeof init.body !== "string")
      )
        throw new ApiError(400, "不支持的MCP请求");
      return requestPublicEndpoint(target.href, {
        method: method as "GET" | "POST" | "DELETE",
        headers,
        body: init?.body as string | undefined,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      });
    },
  });
  const client = new Client({ name: "Poros-IDE", version: "1.0.0" });
  try {
    await client.connect(transport, { signal });
    return await use(client);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
}

export async function runtimeModel(db: PrismaClient, p: Principal, key: string, revision?: string) {
  const row = await scopedConnection(db, p, key);
  if (!row || row.testCode !== "OK") throw new ApiError(409, "请先在设置中配置并验证模型连接");
  if (revision && row.revision !== revision) throw new ApiError(409, "模型连接已变更，请重新发起");
  return { row, model: modelConnection(row) };
}
