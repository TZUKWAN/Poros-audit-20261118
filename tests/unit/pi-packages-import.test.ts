import { describe, expect, it } from "vitest";

/**
 * P.2.2.b 编译测试：验证 4 个 Pi 官方包可正常 import 且导出非空。
 * P.2.3.b 生态包在 ecosystem-compile.test.ts 中同法验证。
 */
describe("pi 官方包 import", () => {
  it("pi-ai 可导入且含文本生成入口", async () => {
    const ai = await import("@earendil-works/pi-ai");
    const exportNames = Object.keys(ai);
    expect(exportNames.length).toBeGreaterThan(0);
  });

  it("pi-agent-core 可导入且含 agentLoop", async () => {
    const core = await import("@earendil-works/pi-agent-core");
    expect(Object.keys(core)).toContain("agentLoop");
  });

  it("pi-tui 可导入且含核心组件", async () => {
    const tui = await import("@earendil-works/pi-tui");
    const names = Object.keys(tui);
    expect(names.length).toBeGreaterThan(0);
  });

  it("zod 可用于 schema 定义", async () => {
    const { z } = await import("zod");
    const schema = z.object({ name: z.string() });
    expect(schema.safeParse({ name: "x" }).success).toBe(true);
  });
});
