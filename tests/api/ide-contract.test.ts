import { describe, expect, it } from "vitest";
import { parseProject, starterProject, skillDefinition } from "../../src/agent-project/contract.js";

describe("Agent, Skill and MCP real engineering contracts", () => {
  it("creates valid source projects and rejects malformed skill and capability references", () => {
    for (const kind of ["AGENT", "SKILL", "MCP"] as const) {
      const files = starterProject(kind, "业务工具");
      expect(parseProject(files).kind).toBe(kind);
      if (kind !== "SKILL") expect(files[parseProject(files).entry]).toContain("export default");
    }
    const files = starterProject("SKILL", "技能");
    expect(skillDefinition(files, "skills/custom-skill").instruction).toContain("材料");
    files["skills/custom-skill/SKILL.md"] = "missing frontmatter";
    expect(() => parseProject(files)).toThrow("元数据");
    const agent = starterProject("AGENT", "Agent");
    delete agent["agent.ts"];
    expect(() => parseProject(agent)).toThrow("入口");
  });
});
