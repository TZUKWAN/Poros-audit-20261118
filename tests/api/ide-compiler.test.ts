import { describe, expect, it } from "vitest";
import { starterProject } from "../../src/agent-project/contract.js";
import { compileProject } from "../../src/agent-project/compiler.js";

describe("IDE actual compiler", () => {
  it("typechecks and bundles Agent, SKILL scripts and official-SDK MCP servers without executing source", async () => {
    for (const kind of ["AGENT", "SKILL", "MCP"] as const) {
      const files = starterProject(kind, "实际工程");
      const result = await compileProject(files);
      expect(result.status, result.diagnostics.join("\n")).toBe("READY");
      expect(result.evidence).toMatchObject({
        typecheck: true,
        compiled: true,
        businessVerified: false,
      });
      if (kind === "AGENT") expect(result.previewHtml).toContain("Content-Security-Policy");
      if (kind === "MCP") expect(result.bundles.mcp).toContain("tools/list");
    }
    const broken = starterProject("AGENT", "坏代码");
    broken["agent.ts"] = 'const value: number = "wrong"; export default () => value;';
    expect((await compileProject(broken)).diagnostics.join(" ")).toContain("not assignable");
    broken["agent.ts"] = 'import fs from "node:fs"; export default () => fs.readFileSync(".env");';
    expect((await compileProject(broken)).status).toBe("FAILED");
  }, 60000);
});
