import { describe, expect, it } from "vitest";

/**
 * P.2.3.b / D6：生态包编译测试。
 * 编译产物子路径直接 import 断言；TS 源码包经 vendored 副本覆盖（见 DECISIONS D5/D6）。
 */
describe("生态包 import", () => {
  it("pi-subagents 默认导出为扩展注册函数", async () => {
    const m = await import("pi-subagents");
    expect(typeof m.default).toBe("function");
  });

  it("pi-mcp-adapter config/types 编译子路径可用", async () => {
    const config = await import("pi-mcp-adapter/config");
    expect(Object.keys(config).length).toBeGreaterThan(0);
    const types = await import("pi-mcp-adapter/types");
    expect(Object.keys(types).length).toBeGreaterThan(0);
  });

  it("context-mode 插件工厂可用", async () => {
    const m = await import("context-mode");
    expect(m.ContextModePlugin ?? m.default).toBeDefined();
  });

  it("pi-web-ui 渲染器注册 API 可用", async () => {
    const m = await import("@earendil-works/pi-web-ui");
    expect(typeof m.registerMessageRenderer).toBe("function");
    expect(typeof m.renderMessage).toBe("function");
  });
});
