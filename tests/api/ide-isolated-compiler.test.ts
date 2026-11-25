import { describe, expect, it } from "vitest";
import { starterProject } from "../../src/agent-project/contract.js";
import { compileIsolatedProject } from "../../src/agent-project/isolated-compiler.js";
describe("production compilation resource isolation", () => {
  it("really compiles Agent/Skill/MCP in the trusted no-network container and refuses invalid TypeScript or unchecked JavaScript", async () => {
    for (const kind of ["AGENT", "SKILL", "MCP"] as const) {
      const result = await compileIsolatedProject(starterProject(kind, "Isolated " + kind));
      expect(result.status, result.diagnostics.join("\n")).toBe("READY");
      expect(result.evidence).toMatchObject({
        typecheck: true,
        compiled: true,
        businessVerified: false,
      });
    }
    const broken = starterProject("AGENT", "Compiler negative");
    broken["agent.ts"] = 'const bad:number="invalid";export default()=>bad;';
    expect((await compileIsolatedProject(broken)).status).toBe("FAILED");
    delete broken["agent.ts"];
    broken["agent.js"] = "export default function(input){return input.missing();}";
    const manifest = JSON.parse(broken["poros.json"]!);
    manifest.entry = "agent.js";
    broken["poros.json"] = JSON.stringify(manifest);
    const unchecked = await compileIsolatedProject(broken);
    expect(unchecked.status).toBe("FAILED");
    expect(unchecked.diagnostics.join("\n")).toContain("implicitly has an 'any'");
  }, 120000);
});
