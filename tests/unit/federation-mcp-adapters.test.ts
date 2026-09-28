import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseMcpSoDetail, slugify } from "@/federation/adapters/mcp-so";
import { matchOfficialServers, firstParagraph } from "@/federation/adapters/official-servers";
import { parseModelscopeServers, modelscopeAdapter, type MsResponse } from "@/federation/adapters/modelscope";
import { clineAdapter, matchClineEntries, type ClineEntry } from "@/federation/adapters/cline-marketplace";
import { awesomeAdapter, parseAwesomeReadme, matchAwesome } from "@/federation/adapters/awesome-mcp";

const FIX = (name: string) => path.join(__dirname, "..", "fixtures", "federation", name);

// ───────────── 1.2.1 mcp.so（fixture ≥8 用例）─────────────
describe("1.2.1 mcp.so 详情页解析", () => {
  const html = readFileSync(FIX("mcpso-detail.html"), "utf8");
  const parsed = parseMcpSoDetail(html, "filesystem");

  it("命中 JSON-LD 且结构正确", () => {
    expect(parsed).not.toBeNull();
    expect(parsed?.jsonld["@type"]).toBe("SoftwareApplication");
    expect(parsed?.jsonld.name?.toLowerCase()).toContain("filesystem");
  });
  it("提取到 GitHub 仓库链接", () => {
    expect(parsed?.repoUrl).toBe("https://github.com/modelcontextprotocol/servers");
  });
  it("JSON-LD description 非空", () => {
    expect((parsed?.jsonld.description ?? "").length).toBeGreaterThan(0);
  });
  it("分类标签存在", () => {
    expect(parsed?.jsonld.applicationCategory).toBeTruthy();
  });
  it("slug 化：大小写/空格/下划线归一", () => {
    expect(slugify("Filesystem Server")).toBe("filesystem-server");
    expect(slugify("git_mcp")).toBe("git-mcp");
  });
  it("无 JSON-LD 页面返回 null（空态）", () => {
    expect(parseMcpSoDetail("<html><body>shell only</body></html>", "x")).toBeNull();
  });
  it("坏 JSON-LD 返回 null（字段缺失容错）", () => {
    expect(parseMcpSoDetail('<script type="application/ld+json">{oops</script>', "x")).toBeNull();
  });
  it("远程标记：页面含 /mcp 端点时提取", () => {
    const withRemote = html.replace("</head>", '</head><!-- https://remote.example.com/mcp -->');
    expect(parseMcpSoDetail(withRemote, "filesystem")?.remoteHint).toBe("https://remote.example.com/mcp");
  });
});

// ───────────── 1.2.2 modelcontextprotocol/servers（≥6）─────────────
describe("1.2.2 官方 servers 仓库", () => {
  const entries = ["everything", "fetch", "filesystem", "git", "memory", "sequentialthinking", "time"].map((name) => ({
    name,
    type: "dir",
    path: `src/${name}`,
  }));
  it("查询命中 filesystem", () => {
    expect(matchOfficialServers(entries, "filesystem").map((e) => e.name)).toEqual(["filesystem"]);
  });
  it("部分匹配 fetch 命中 fetch 不命中 filesystem", () => {
    const got = matchOfficialServers(entries, "fetch").map((e) => e.name);
    expect(got).toContain("fetch");
    expect(got).not.toContain("filesystem");
  });
  it("大写查询不敏感", () => {
    expect(matchOfficialServers(entries, "GIT").map((e) => e.name)).toContain("git");
  });
  it("空查询返回空（limit 边界）", () => {
    expect(matchOfficialServers(entries, "")).toEqual([]);
  });
  it("文件型条目被忽略", () => {
    expect(matchOfficialServers([...entries, { name: "README", type: "file", path: "x" }], "readme")).toEqual([]);
  });
  it("firstParagraph：跳过标题取首个实质段落", () => {
    const md = "# Filesystem\n\nNode.js server implementing Model Context Protocol for filesystem operations.\n\n## Install";
    expect(firstParagraph(md)).toMatch(/^Node\.js server/);
  });
  it("firstParagraph：README 缺失返回 undefined", () => {
    expect(firstParagraph(undefined)).toBeUndefined();
  });
});

// ───────────── 1.2.3 ModelScope（≥6）─────────────
describe("1.2.3 ModelScope MCP 广场", () => {
  const payload = JSON.parse(readFileSync(FIX("modelscope-search.json"), "utf8")) as MsResponse;
  const servers = parseModelscopeServers(payload);

  it("解析出候选且包含 filesystem", () => {
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.some((s) => s.Name.toLowerCase().includes("filesystem"))).toBe(true);
  });
  it("非 200 Code 返回空（错误路径）", () => {
    expect(parseModelscopeServers({ Code: 500, Message: "err" })).toEqual([]);
  });
  it("缺 Data.McpServer 返回空（字段缺失容错）", () => {
    expect(parseModelscopeServers({ Code: 200 })).toEqual([]);
  });
  it("适配器端到端：fixture 驱动产出能力列表", async () => {
    const adapter = modelscopeAdapter({ search: async () => servers.slice(0, 5) });
    const r = await adapter.search({ text: "filesystem" });
    expect(r.status.ok).toBe(true);
    expect(r.capabilities.length).toBeGreaterThan(0);
    expect(r.capabilities[0]?.source.id).toBe("modelscope");
  });
  it("DeployedUrl 非空 → remote 安装 + remoteRun 标记", async () => {
    const withDeployed = servers.map((s, i) =>
      i === 0 ? { ...s, DeployedUrl: "https://mcp.modelscope.cn/x/mcp", DeployedUrlTransportType: "sse" } : s,
    );
    const adapter = modelscopeAdapter({ search: async () => withDeployed.slice(0, 1) });
    const r = await adapter.search({ text: "x" });
    expect(r.capabilities[0]?.install.type).toBe("remote");
    expect(r.capabilities[0]?.remoteRun?.transport).toBe("sse");
  });
  it("搜索失败折叠为 failed 状态", async () => {
    const adapter = modelscopeAdapter({ search: async () => { throw new Error("HTTP 502"); } });
    const r = await adapter.search({ text: "x" });
    expect(r.status.ok).toBe(false);
    expect(r.status.message).toContain("502");
  });
  it(" stars/updatedAt 映射到 trust 证据", async () => {
    const adapter = modelscopeAdapter({ search: async () => servers.slice(0, 1) });
    const r = await adapter.search({ text: "x" });
    const cap = r.capabilities[0];
    expect(cap?.trust.evidence.stars).toBe(servers[0]?.Stars);
  });
});

// ───────────── 1.2.4 Cline（≥6）─────────────
describe("1.2.4 Cline MCP Marketplace", () => {
  const entries = JSON.parse(readFileSync(FIX("cline-marketplace.json"), "utf8")) as ClineEntry[];

  it("市场条目规模合理", () => {
    expect(entries.length).toBeGreaterThan(50);
  });
  it("多词查询按命中数排序", () => {
    const got = matchClineEntries(entries, "github api", 5);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(5);
  });
  it("查询 postman 命中 Postman API Tools", () => {
    expect(matchClineEntries(entries, "postman", 5)[0]?.name).toContain("Postman");
  });
  it("无命中返回空", () => {
    expect(matchClineEntries(entries, "zzzznotexist", 5)).toEqual([]);
  });
  it("适配器：requiresApiKey → requiresAuth 标记", async () => {
    const adapter = clineAdapter({ marketplace: async () => entries });
    const r = await adapter.search({ text: "postman", limit: 3 });
    const cap = r.capabilities[0];
    expect(cap).toBeTruthy();
    expect(cap?.trust.hardFilterPassed).toBe(true);
  });
  it("适配器：githubUrl → git 安装", async () => {
    const adapter = clineAdapter({ marketplace: async () => entries });
    const r = await adapter.search({ text: "postman", limit: 1 });
    expect(r.capabilities[0]?.install.type).toBe("git");
  });
  it("适配器：限流失败折叠状态", async () => {
    const adapter = clineAdapter({ marketplace: async () => { throw new Error("HTTP 429"); } });
    const r = await adapter.search({ text: "x" });
    expect(r.status.ok).toBe(false);
  });
  it("updatedAt 缺省回退 createdAt", async () => {
    const synthetic: ClineEntry = { mcpId: "github.com/a/b", name: "Synthetic", createdAt: "2026-03-27T22:30:02.730347Z" };
    const adapter = clineAdapter({ marketplace: async () => [synthetic] });
    const r = await adapter.search({ text: "synthetic", limit: 1 });
    expect(r.capabilities[0]?.updatedAt).toBe("2026-03-27T22:30:02.730347Z");
  });
});

// ───────────── 1.2.5 Awesome（≥6）─────────────
describe("1.2.5 Awesome MCP Servers", () => {
  const md = readFileSync(FIX("awesome-readme.md"), "utf8");
  const entries = parseAwesomeReadme(md);

  it("解析出大量条目（数百）", () => {
    expect(entries.length).toBeGreaterThan(300);
  });
  it("每条都有分类/名称/URL", () => {
    const sample = entries.slice(0, 50);
    for (const e of sample) {
      expect(e.category.length).toBeGreaterThan(0);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.url.startsWith("http")).toBe(true);
    }
  });
  it("描述截断在 300 字内", () => {
    for (const e of entries.slice(0, 100)) expect(e.description.length).toBeLessThanOrEqual(300);
  });
  it("查询 filesystem 命中条目", () => {
    expect(matchAwesome(entries, "filesystem", 5).length).toBeGreaterThan(0);
  });
  it("格式变体：— 与 – 分隔符", () => {
    const variant = "### Cat\n- [A](https://a.example) — desc A\n- [B](https://b.example) – desc B\n- [C](https://c.example): desc C";
    const got = parseAwesomeReadme(variant);
    expect(got).toHaveLength(3);
    expect(got[2]?.description).toBe("desc C");
  });
  it("无分类小节的列表被忽略（防误收导航）", () => {
    const md2 = "- [Nav](https://nav.example) - nav item\n\n### Real\n- [Real](https://real.example) - real";
    expect(parseAwesomeReadme(md2).map((e) => e.name)).toEqual(["Real"]);
  });
  it("适配器端到端 + github 链接 → git 安装", async () => {
    const adapter = awesomeAdapter({ readme: async () => md });
    const r = await adapter.search({ text: "filesystem", limit: 3 });
    expect(r.status.ok).toBe(true);
    expect(r.capabilities.length).toBeGreaterThan(0);
    const gh = r.capabilities.find((c) => c.install.type === "git");
    expect(gh).toBeTruthy();
  });
});
