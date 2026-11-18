import { randomBytes } from "node:crypto";
import type { IntegrationConnection } from "@prisma/client";
import { z } from "zod";
import { connectionSecret, modelConnection } from "./integration-connections.js";
import {
  checkProviderResponse,
  checkPublicTarget,
  providerEvents,
  ProviderError,
  readProviderText,
  requestModel,
} from "./provider-http.js";

async function jsonResponse(res: Response): Promise<unknown> {
  await checkProviderResponse(res);
  try {
    return JSON.parse(await readProviderText(res));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("INVALID_RESPONSE", res.status);
  }
}
const requestJson = (url: string | URL, init: RequestInit) =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(14000), ...(init.signal ? [init.signal] : [])]),
  }).then(jsonResponse);

const imaSchema = z.object({
  retcode: z.number(),
  data: z
    .object({
      info_list: z.array(z.object({ name: z.string(), id: z.string().optional() })).optional(),
    })
    .optional(),
});
async function imaSearch(row: IntegrationConnection, query: string, signal?: AbortSignal) {
  const { clientId, apiKey } = connectionSecret(row);
  const result = imaSchema.safeParse(
    await requestJson("https://ima.qq.com/openapi/wiki/v1/search_knowledge_base", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "ima-openapi-clientid": clientId!,
        "ima-openapi-apikey": apiKey,
        "ima-openapi-ctx": "app=poros",
      },
      body: JSON.stringify({ query, cursor: "", limit: 8 }),
    }),
  );
  if (!result.success) throw new ProviderError("INVALID_RESPONSE");
  if (result.data.retcode !== 0)
    throw new ProviderError("PROVIDER_REQUEST_REJECTED", undefined, `IMA ${result.data.retcode}`);
  if (!result.data.data) throw new ProviderError("INVALID_RESPONSE");
  return (result.data.data.info_list ?? []).slice(0, 8).map(({ name, id }) => ({
    title: mask(name, apiKey, clientId).slice(0, 300),
    ...(id ? { id: mask(id, apiKey, clientId).slice(0, 200) } : {}),
  }));
}
async function imaContent(
  row: IntegrationConnection,
  query: string,
  knowledgeBaseId: string,
  signal?: AbortSignal,
) {
  const { clientId, apiKey } = connectionSecret(row);
  const validated = z
    .object({
      retcode: z.number(),
      data: z
        .object({
          info_list: z
            .array(
              z.object({
                title: z.string().optional(),
                name: z.string().optional(),
                media_id: z.string().optional(),
                highlight_content: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .safeParse(
      await requestJson("https://ima.qq.com/openapi/wiki/v1/search_knowledge", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "ima-openapi-clientid": clientId!,
          "ima-openapi-apikey": apiKey,
          "ima-openapi-ctx": "app=poros",
        },
        body: JSON.stringify({ query, knowledge_base_id: knowledgeBaseId, cursor: "" }),
      }),
    );
  if (!validated.success) throw new ProviderError("INVALID_RESPONSE");
  if (validated.data.retcode !== 0)
    throw new ProviderError(
      "PROVIDER_REQUEST_REJECTED",
      undefined,
      `IMA ${validated.data.retcode}`,
    );
  if (!validated.data.data) throw new ProviderError("INVALID_RESPONSE");
  return (validated.data.data.info_list ?? []).slice(0, 8).map((item) => ({
    title: mask(item.title ?? item.name ?? "IMA 条目", apiKey, clientId).slice(0, 300),
    id: item.media_id ? mask(item.media_id, apiKey, clientId).slice(0, 200) : undefined,
    snippet: mask(item.highlight_content ?? "", apiKey, clientId).slice(0, 1600),
  }));
}

const searchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      snippet: z.string().optional(),
      url: z.string(),
    }),
  ),
});
const fetchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().optional(),
      url: z.string(),
      text: z.string(),
    }),
  ),
});
async function tinySearch(row: IntegrationConnection, query: string, signal?: AbortSignal) {
  const { apiKey } = connectionSecret(row);
  const url = new URL("https://api.search.tinyfish.ai/");
  url.searchParams.set("query", query);
  const result = searchSchema.safeParse(
    await requestJson(url, { headers: { "X-API-Key": apiKey }, signal }),
  );
  if (!result.success) throw new ProviderError("INVALID_RESPONSE");
  return result.data.results.slice(0, 8).map((item) => ({
    title: mask(item.title, apiKey).slice(0, 300),
    snippet: mask(item.snippet ?? "", apiKey).slice(0, 1200),
    url: safeLink(mask(item.url, apiKey)),
  }));
}
async function tinyFetch(row: IntegrationConnection, input: string, signal?: AbortSignal) {
  const { apiKey } = connectionSecret(row);
  const url = input === "https://www.tinyfish.ai/" ? input : await checkPublicTarget(input);
  const result = fetchSchema.safeParse(
    await requestJson("https://api.fetch.tinyfish.ai/", {
      method: "POST",
      signal,
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ urls: [url], format: "markdown" }),
    }),
  );
  if (!result.success) throw new ProviderError("INVALID_RESPONSE");
  const page = result.data.results[0];
  if (!page) throw new ProviderError("PROVIDER_REQUEST_REJECTED");
  return [
    {
      title: mask(page.title ?? page.url, apiKey).slice(0, 300),
      snippet: mask(page.text, apiKey).slice(0, 16000),
      url,
    },
  ];
}

const kdocsEndpoint = "https://openapi.wps.cn/mcp/v2/kso-yundoc/message";
const rpcSchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
async function kdocsRequest(
  row: IntegrationConnection,
  operation: "search" | "read",
  args: Record<string, string | number>,
  taskSignal?: AbortSignal,
) {
  const { apiKey } = connectionSecret(row);
  const signal = AbortSignal.any([AbortSignal.timeout(14000), ...(taskSignal ? [taskSignal] : [])]);
  const headers = {
    authorization: "Bearer " + apiKey,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  } as Record<string, string>;
  async function rpc(method: string, params?: object, id?: number) {
    const res = await fetch(kdocsEndpoint, {
      method: "POST",
      headers,
      signal,
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    });
    await checkProviderResponse(res);
    const session = res.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    if (id === undefined) {
      await res.body?.cancel();
      return undefined;
    }
    const validate = (raw: string) => {
      const parsed = rpcSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.id !== id) return undefined;
      if (parsed.data.error) {
        const rpc = z.object({ code: z.number().optional() }).safeParse(parsed.data.error);
        throw new ProviderError(
          "PROVIDER_REQUEST_REJECTED",
          undefined,
          rpc.success && typeof rpc.data.code === "number" ? `WPS MCP ${rpc.data.code}` : undefined,
        );
      }
      return parsed.data.result;
    };
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const data of providerEvents(res)) {
        const result = validate(data);
        if (result !== undefined) return result;
      }
    } else {
      const result = validate(await readProviderText(res));
      if (result !== undefined) return result;
    }
    throw new ProviderError("INVALID_RESPONSE");
  }
  const init = z.object({ protocolVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "Poros", version: "1.0.0" },
      },
      1,
    ),
  );
  headers["MCP-Protocol-Version"] = init.protocolVersion;
  try {
    await rpc("notifications/initialized");
    const result = z
      .object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      })
      .parse(
        await rpc(
          "tools/call",
          {
            name:
              operation === "search"
                ? "kso_yundoc_search_yundoc"
                : "kso_yundoc_extract_yundoc_content",
            arguments: args,
          },
          2,
        ),
      );
    if (result.isError) throw new ProviderError("PROVIDER_REQUEST_REJECTED");
    return result.content
      .filter((c) => c.type === "text")
      .slice(0, 5)
      .map((c) => ({
        title: operation === "search" ? "金山文档搜索结果" : "金山文档正文",
        snippet: mask(c.text ?? "", apiKey).slice(0, operation === "search" ? 5000 : 12000),
        ...(operation === "read" && args.file_id ? { id: mask(String(args.file_id), apiKey) } : {}),
      }));
  } finally {
    if (headers["mcp-session-id"] && !signal.aborted) {
      await fetch(kdocsEndpoint, { method: "DELETE", headers, signal, redirect: "error" })
        .then((res) => res.body?.cancel())
        .catch(() => {});
    }
  }
}
const kdocsSearch = (row: IntegrationConnection, query: string, signal?: AbortSignal) =>
  kdocsRequest(row, "search", { keyword: query, page_size: 5, type: "all" }, signal);

function mask(value: string, ...secrets: Array<string | undefined>) {
  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[REDACTED]");
  return value;
}
function safeLink(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    /* Ignore malformed links from providers. */
  }
  return undefined;
}

async function checkModel(row: IntegrationConnection) {
  const { baseUrl, model, apiKey } = modelConnection(row);
  const nonce = "POROS-" + randomBytes(4).toString("hex");
  const response = await requestModel(baseUrl, "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    signal: AbortSignal.timeout(24000),
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 768,
      messages: [{ role: "user", content: "Output this verification code alone: " + nonce }],
    }),
  });
  await checkProviderResponse(response, true);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new ProviderError("STREAM_REQUIRED", response.status);
  }
  let output = "",
    done = false;
  for await (const data of providerEvents(response)) {
    if (data === "[DONE]") {
      done = true;
      break;
    }
    const chunk = JSON.parse(data) as {
      error?: unknown;
      choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
    };
    if (chunk.error) throw new ProviderError("PROVIDER_REQUEST_REJECTED");
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === "string") output += choice.delta.content;
    if (choice?.finish_reason === "stop") done = true;
    if (output.length > 10000) throw new ProviderError("RESPONSE_TOO_LARGE");
  }
  if (!done || output.trim() !== nonce) throw new ProviderError("PROBE_MISMATCH", response.status);
}

export async function verifyIntegration(row: IntegrationConnection): Promise<void> {
  switch (row.provider) {
    case "model":
      await checkModel(row);
      break;
    case "kdocs":
      await kdocsSearch(row, "Poros");
      break;
    case "ima":
      await imaSearch(row, "");
      break;
    case "tinyfish":
      await Promise.all([
        tinySearch(row, "TinyFish official documentation"),
        tinyFetch(row, "https://www.tinyfish.ai/"),
      ]);
      break;
    default:
      throw new ProviderError("SETTINGS_INCOMPLETE");
  }
}

export type IntegrationItem = { title: string; snippet?: string; url?: string; id?: string };
export async function useIntegration(
  row: IntegrationConnection,
  action: "search" | "fetch",
  query: string,
  signal?: AbortSignal,
): Promise<IntegrationItem[]> {
  if (row.testCode !== "OK") throw new ProviderError("NOT_VERIFIED");
  if (row.provider === "tinyfish")
    return action === "fetch" ? tinyFetch(row, query, signal) : tinySearch(row, query, signal);
  if (action === "search" && row.provider === "ima") return imaSearch(row, query, signal);
  if (action === "search" && row.provider === "kdocs") return kdocsSearch(row, query, signal);
  throw new ProviderError("ACTION_NOT_SUPPORTED");
}

export async function useIntegrationTool(
  row: IntegrationConnection,
  action: "search" | "fetch" | "read" | "knowledge",
  input: Record<string, string>,
  signal: AbortSignal,
): Promise<IntegrationItem[]> {
  if (row.testCode !== "OK") throw new ProviderError("NOT_VERIFIED");
  if (action === "read" && row.provider === "kdocs")
    return kdocsRequest(
      row,
      action,
      { drive_id: input.drive_id!, file_id: input.file_id! },
      signal,
    );
  if (action === "knowledge" && row.provider === "ima")
    return imaContent(row, input.query!, input.knowledge_base_id!, signal);
  if (action === "read" || action === "knowledge") throw new ProviderError("ACTION_NOT_SUPPORTED");
  return useIntegration(row, action, action === "fetch" ? input.url! : input.query!, signal);
}
