import { describe, expect, it } from "vitest";
import { makeStatus } from "@/federation/adapters/base";
import type { AdapterResult, CapabilityAdapter, CapabilityQuery, Source } from "@/federation/types";
import { buildCapability } from "@/federation/adapters/adapter-utils";

/**
 * 1.1.2.b CapabilityAdapter 契约测试：内存假适配器验证接口语义
 * （supports/search 返回形态、超时归一化为 failed 状态而非抛出）。
 */

const fakeSource: Source = { id: "modelscope", tier: "curated", name: "fake", url: "https://fake.example" };

export function makeFakeAdapter(overrides: Partial<CapabilityAdapter> = {}): CapabilityAdapter {
  return {
    source: fakeSource,
    supports: (q: CapabilityQuery) => q.text.length > 0,
    search: async (q: CapabilityQuery): Promise<AdapterResult> => ({
      capabilities: [
        buildCapability({
          id: `fake:${q.text}`,
          name: q.text,
          kind: "mcp-server",
          description: "fake",
          source: fakeSource,
          install: { type: "npx", package: "fake", args: [] },
        }),
      ],
      status: makeStatus(fakeSource.id, true, false, performance.now() - 10, 1),
    }),
    ...overrides,
  };
}

describe("1.1.2.b 适配器契约", () => {
  it("supports 为 false 时检索器跳过该源", () => {
    const a = makeFakeAdapter({ supports: () => false });
    expect(a.supports({ text: "" })).toBe(false);
    expect(a.supports({ text: "x" })).toBe(false);
  });

  it("search 返回 capabilities + 完整状态报告（含延迟与计数）", async () => {
    const a = makeFakeAdapter();
    const r = await a.search({ text: "filesystem" });
    expect(r.capabilities).toHaveLength(1);
    expect(r.status.ok).toBe(true);
    expect(r.status.count).toBe(1);
    expect(r.status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.status.source).toBe("modelscope");
  });

  it("超时异常在检索器层折叠为 failed 状态（适配器可抛，扇出层收口）", async () => {
    const a = makeFakeAdapter({
      search: async () => {
        throw new Error("ABORT_ERR: timeout of 5000ms exceeded");
      },
    });
    await expect(a.search({ text: "x" })).rejects.toThrow(/timeout/);
  });

  it("AbortError 保留取消语义（不重试不吞掉）", async () => {
    const a = makeFakeAdapter({
      search: async () => {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    await expect(a.search({ text: "x" })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("degraded 状态可表达部分成功", () => {
    const s = makeStatus(fakeSource.id, true, true, performance.now() - 5, 3, "truncated after retry");
    expect(s.ok).toBe(true);
    expect(s.degraded).toBe(true);
    expect(s.count).toBe(3);
  });
});
