import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parseSkillsSh,
  parseSkillsMp,
  parseSkillHub,
  skillsShAdapter,
  skillsMpAdapter,
  skillHubAdapter,
  githubRepoFromUrl,
} from "@/federation/adapters/skill-sources";
import {
  digestSkillMd,
  digestWithRetry,
  digestAndVendor,
} from "@/federation/skill-digest";

const FIX = (name: string) => path.join(__dirname, "..", "fixtures", name);
const loadJson = (n: string) => JSON.parse(readFileSync(FIX(`federation/${n}`), "utf8"));

// ───────────── 1.3.x 三个技能源解析 ─────────────
describe("1.3.1 skills.sh", () => {
  const payload = loadJson("skills-sh-search.json");
  it("解析出技能列表且含 installs", () => {
    const items = parseSkillsSh(payload);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.id.split("/").length).toBe(3);
    expect(typeof items[0]?.installs).toBe("number");
  });
  it("坏 payload 返回空", () => {
    expect(parseSkillsSh({} as never)).toEqual([]);
  });
  it("适配器 fixture 端到端", async () => {
    const adapter = skillsShAdapter({ search: async () => payload });
    const r = await adapter.search({ text: "filesystem" });
    expect(r.status.ok).toBe(true);
    expect(r.capabilities[0]?.kind).toBe("skill-knowledge");
    expect(r.capabilities[0]?.install.type).toBe("context"); // 技能不进运行时
  });
});

describe("1.3.2 SkillsMP", () => {
  const payload = loadJson("skillsmp-search.json");
  it("解析出描述与 githubUrl", () => {
    const items = parseSkillsMp(payload);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.githubUrl).toMatch(/^https:\/\/github\.com\//);
  });
  it("坏 payload 返回空", () => {
    expect(parseSkillsMp({ skills: "x" } as never)).toEqual([]);
  });
  it("适配器 fixture 端到端 + 描述非空", async () => {
    const adapter = skillsMpAdapter({ search: async () => payload });
    const r = await adapter.search({ text: "transcript" });
    expect(r.status.ok).toBe(true);
    expect((r.capabilities[0]?.description ?? "").length).toBeGreaterThan(0);
  });
});

describe("1.3.3 腾讯 SkillHub", () => {
  const payload = loadJson("skillhub-search.json");
  it("解析 code=0 技能列表（含 verified/updated_at 毫秒）", () => {
    const items = parseSkillHub(payload);
    expect(items.length).toBeGreaterThan(0);
    expect(typeof items[0]?.updated_at).toBe("number");
  });
  it("code≠0 返回空 + message 保留", () => {
    expect(parseSkillHub({ code: 401, message: "unauthorized" })).toEqual([]);
  });
  it("适配器 fixture 端到端：updated_at 转 ISO", async () => {
    const adapter = skillHubAdapter({ search: async () => payload });
    const r = await adapter.search({ text: "filesystem" });
    const cap = r.capabilities.find((c) => c.updatedAt);
    expect(cap?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("githubRepoFromUrl", () => {
    expect(githubRepoFromUrl("https://github.com/a/b/tree/main/skills")).toBe("a/b");
    expect(githubRepoFromUrl(undefined)).toBeUndefined();
  });
});

// ───────────── 1.5 技能经验提炼器 ─────────────
describe("1.5.1.b 真实技能提炼（4 个 anthropics/skills fixture）", () => {
  const skills = ["skill-creator", "mcp-builder", "webapp-testing", "pdf"];

  for (const s of skills) {
    it(`${s}: 四类产物非空且结构化`, () => {
      const md = readFileSync(FIX(`skills/${s}.md`), "utf8");
      const products = digestSkillMd(s, `https://github.com/anthropics/skills/tree/main/skills/${s}`, md);
      expect(products.skillId).toBe(s);
      // 可落地改动至少一项
      const total =
        products.processFragments.length +
        products.pitfalls.length +
        products.acceptancePoints.length +
        products.capabilityLeads.length;
      expect(total).toBeGreaterThan(0);
      expect(products.actionable).toBe(true);
      // 流程片段若存在则步骤 ≥2
      for (const f of products.processFragments) expect(f.steps.length).toBeGreaterThanOrEqual(2);
    });
  }

  it("mcp-builder 提炼出工具线索（npx/MCP）", () => {
    const md = readFileSync(FIX("skills/mcp-builder.md"), "utf8");
    const p = digestSkillMd("mcp-builder", "x", md);
    expect(p.capabilityLeads.length).toBeGreaterThan(0);
  });

  it("webapp-testing 提炼出坑与对策", () => {
    const md = readFileSync(FIX("skills/webapp-testing.md"), "utf8");
    const p = digestSkillMd("webapp-testing", "x", md);
    expect(p.pitfalls.length).toBeGreaterThan(0);
    expect(p.pitfalls[0]?.pitfall.length).toBeGreaterThan(5);
  });
});

describe("1.5.2 提炼有效性校验与重试", () => {
  it("空泛产出（无任何模式命中）触发重提炼（LLM 注入后成功）", async () => {
    const vague = "# Nothing here\n\njust vibes, no steps, no checks.";
    const calls: string[] = [];
    const out = await digestWithRetry("vague-skill", "x", vague, {
      llm: async (md) => {
        calls.push(md);
        return "## Workflow\n1. First do the concrete build step now\n2. Then verify the result carefully";
      },
    });
    expect(calls).toHaveLength(1); // 首轮启发式空泛 → LLM 补一轮
    expect(out.actionable).toBe(true);
    expect(out.processFragments.length).toBeGreaterThan(0);
  });

  it("空泛且无 LLM → 抛 ScenarioError", async () => {
    await expect(digestWithRetry("vague", "x", "# empty\n\n- short")).rejects.toMatchObject({ code: "SOURCE_PARSE" });
  });

  it("正常产出不触发 LLM", async () => {
    const md = readFileSync(FIX("skills/pdf.md"), "utf8");
    const calls: string[] = [];
    await digestWithRetry("pdf", "x", md, { llm: async (m) => { calls.push(m); return ""; } });
    expect(calls).toHaveLength(0);
  });
});

describe("1.5.3 可执行资产 vendoring + 清理", () => {
  it("复制脚本资产（带出处头）并删除技能本体", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skillclone-"));
    const products = path.join(temp, "out");
    // 构造一个带 SKILL.md + 脚本 + 模板的技能目录
    const skillDir = path.join(temp, "clone", "my-skill");
    await import("node:fs/promises").then((fs) => fs.mkdir(path.join(skillDir, "scripts"), { recursive: true }));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(skillDir, "SKILL.md"), "# do things\n\n## Workflow\n1. Run the script carefully now\n2. Then verify the output honestly\n\n- Avoid running scripts blindly on untrusted input data\n", "utf8");
    await writeFile(path.join(skillDir, "scripts", "run.py"), "print('hi')\n", "utf8");
    await writeFile(path.join(skillDir, "template.txt"), "template body here\n", "utf8");

    const result = await digestAndVendor(skillDir, products, {
      skillId: "my-skill",
      sourceUrl: "https://example.com/skill",
      license: "MIT",
    });
    expect(result.cleanedUp).toBe(true); // 技能本体已删除
    await expect(readdir(skillDir)).rejects.toThrow(); // 确认无残留
    expect(result.products.vendored.length).toBe(2); // run.py + template.txt
    const v = result.products.vendored.find((x) => x.file.endsWith("run.py"));
    expect(v?.provenance).toBe("https://example.com/skill");
    const copied = await readFile(v!.destPath, "utf8");
    expect(copied).toContain("# vendored from skill: my-skill");
    expect(copied).toContain("# source: https://example.com/skill");
    expect(copied).toContain("print('hi')");
  });

  it("无 SKILL.md 的临时目录报 NOT_FOUND", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "skillclone2-"));
    await expect(
      digestAndVendor(temp, path.join(temp, "out"), { skillId: "x", sourceUrl: "https://x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await rm(temp, { recursive: true, force: true });
  });
});
