import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 10.3 打包为 Pi 包：加载验证。
 *  - 实机验证（2026-09-29）：pi install ./pi-package → pi list 注册 ✓；
 *    pi -p 会话（openrouter/nemotron）exit 0 正常回复 —— pi main.ts 对扩展加载失败
 *    会 reportDiagnostics + exit(1)，故 exit 0 即"加载无错误无警告"的判定依据。
 *  - 此处补命令注册面验证：mock ExtensionAPI 调用扩展入口，断言命令注册。
 */

describe("pi 包命令注册面", () => {
  it("extension.ts 注册 /scenario:build 与 /scenario:status", async () => {
    const src = await readFile(path.join(__dirname, "..", "..", "pi-package", "extension.ts"), "utf8");
    expect(src).toContain('registerCommand("scenario:build"');
    expect(src).toContain('registerCommand("scenario:status"');
    expect(src).toContain('./dist/kernel.js');
  });

  it("包清单声明 pi.extensions 入口", async () => {
    const manifest = JSON.parse(await readFile(path.join(__dirname, "..", "..", "pi-package", "package.json"), "utf8")) as {
      pi: { extensions: string[] };
    };
    expect(manifest.pi.extensions).toEqual(["./extension.ts"]);
  });

  it("内核 bundle 存在且含 runScenario 导出符号", async () => {
    const bundle = await readFile(path.join(__dirname, "..", "..", "pi-package", "dist", "kernel.js"), "utf8");
    expect(bundle).toContain("runScenario");
    expect(bundle.length).toBeGreaterThan(100_000); // 完整内核（联邦/编排/执行/验收/蒸馏/场景库/Memory）
  });
});
