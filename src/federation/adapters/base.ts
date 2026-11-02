import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { AdapterResult, CapabilityAdapter, CapabilityQuery, Source, SourceId, SourceStatus } from "../types.js";

export type { AdapterResult, CapabilityAdapter, CapabilityQuery, SourceStatus };

/** 单源失败不抛出（除取消外）：一律折叠为 failed 状态报告（1.4.1.a 语义） */
export function makeStatus(
  source: SourceId,
  ok: boolean,
  degraded: boolean,
  startedAt: number,
  count: number,
  message?: string,
): SourceStatus {
  return {
    source,
    ok,
    degraded,
    latencyMs: Math.round(performance.now() - startedAt),
    count,
    message,
  };
}

/** 统一 fetch：超时 + 429/5xx 指数退避重试（1.2.2.c），UA 标识 */
export async function httpFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, retries = 2, ...rest } = init;
  const signal = rest.signal ?? undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...rest,
        signal: signal ? anySignal([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "pi-scenario/0.1 (+https://github.com/TZUKWAN/METIS_PARALLEL)",
          accept: "application/json, text/html;q=0.8, */*;q=0.5",
          ...(rest.headers ?? {}),
        },
      });
      if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
        // R4 审计P3：重试前必须消费/丢弃响应体——undici 在 body 被消费或 GC 前
        // 一直占着 socket，8 源共享连接池，持续 5xx 会把池耗尽拖垮其它出站调用。
        await resp.body?.cancel().catch(() => undefined);
        await sleep(baseBackoffMs * 2 ** attempt + Math.random() * 250, signal);
        continue;
      }
      return resp;
    } catch (err) {
      if (signal?.aborted) {
        throw new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "fetch cancelled", phase: "retrieving" });
      }
      lastErr = err;
      if (attempt < retries) {
        await sleep(baseBackoffMs * 2 ** attempt + Math.random() * 250, signal);
        continue;
      }
    }
  }
  throw lastErr;
}

const baseBackoffMs = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ScenarioError({ code: ScenarioErrorCode.CANCELLED, message: "sleep cancelled", phase: "retrieving" }));
      },
      { once: true },
    );
  });
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) controller.abort();
    else s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** 安全 JSON 读取：非 2xx 抛 ScenarioError（带状态码） */
export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number; retries?: number } = {}): Promise<T> {
  const resp = await httpFetch(url, init);
  if (!resp.ok) {
    throw new ScenarioError({
      code: resp.status === 429 ? ScenarioErrorCode.RATE_LIMITED : ScenarioErrorCode.SOURCE_UNAVAILABLE,
      message: `HTTP ${resp.status} from ${url}`,
      phase: "retrieving",
      context: { url, status: resp.status },
    });
  }
  try {
    return (await resp.json()) as T;
  } catch (err) {
    throw new ScenarioError({
      code: ScenarioErrorCode.SOURCE_PARSE,
      message: `invalid JSON from ${url}`,
      phase: "retrieving",
      cause: err,
    });
  }
}

export type { Source };
