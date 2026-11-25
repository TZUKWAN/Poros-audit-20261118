import type { ApiResult, api } from "../api.js";
export const appBase = new URL(".", document.baseURI).pathname.replace(/\/$/, "");
export function appApi(token: () => string, expired: () => void): typeof api {
  return async <T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    timeoutMs = 15000,
  ): Promise<ApiResult<T>> => {
    try {
      const sentToken = token();
      const response = await fetch(appBase + path, {
        method,
        headers: {
          ...(sentToken ? { authorization: "Bearer " + sentToken } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 && sentToken === token()) expired();
      const result = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body: result as T & { error?: string } };
    } catch {
      return {
        ok: false,
        status: 0,
        body: { error: "连接中断或超时，任务回执会保留，请恢复连接后重试" } as T & {
          error: string;
        },
      };
    }
  };
}
