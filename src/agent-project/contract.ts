import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ApiError } from "../server/errors.js";
import { projectPath, type ProjectFiles } from "./files.js";
import { verifyCapabilityLock } from "./lock.js";

export const projectKind = z.enum(["AGENT", "SKILL", "MCP"]);
export type ProjectKind = z.infer<typeof projectKind>;
export const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    name: z.string().trim().min(1).max(120),
    kind: projectKind,
    entry: z.string().default("agent.ts"),
    preview: z.string().optional(),
    instructions: z.string().max(12000).default(""),
    skills: z.array(z.string()).max(12).default([]),
    mcp: z
      .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), entry: z.string() }))
      .max(6)
      .default([]),
    permissions: z.array(z.string().max(120)).max(40).default([]),
    tests: z.string().optional(),
  })
  .strict();
export type ProjectManifest = z.infer<typeof manifestSchema>;
export const caseSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(120),
      input: z.unknown(),
      expected: z.unknown().optional(),
      contains: z.string().optional(),
      tool: z.string().optional(),
      target: z.string().optional(),
    }),
  )
  .max(20);
export type ProjectCase = z.infer<typeof caseSchema>[number];

export function skillDefinition(files: ProjectFiles, directory: string) {
  const filename = projectPath(directory.replace(/\/$/, "") + "/SKILL.md");
  const source = files[filename];
  if (!source) throw new ApiError(400, `缺少技能文件 ${filename}`);
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new ApiError(400, `${filename} 缺少 YAML 元数据`);
  const metadata = z
    .object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      description: z.string().trim().min(1).max(1024),
    })
    .passthrough()
    .parse(parseYaml(match[1]!));
  if (directory.split("/").pop() !== metadata.name)
    throw new ApiError(400, "技能名称必须匹配目录名");
  if (!match[2]!.trim()) throw new ApiError(400, "技能正文不能为空");
  return { ...metadata, directory, instruction: match[2]!.trim() };
}

export function parseProject(files: ProjectFiles): ProjectManifest {
  verifyCapabilityLock(files);
  let raw: unknown;
  try {
    raw = JSON.parse(files["poros.json"] || "");
  } catch {
    throw new ApiError(400, "poros.json 不是有效 JSON");
  }
  const manifest = manifestSchema.parse(raw);
  if (manifest.kind !== "SKILL" && !files[projectPath(manifest.entry)])
    throw new ApiError(400, `缺少入口 ${manifest.entry}`);
  if (manifest.preview && !files[projectPath(manifest.preview)])
    throw new ApiError(400, "缺少预览入口");
  if (new Set(manifest.mcp.map((m) => m.name)).size !== manifest.mcp.length)
    throw new ApiError(400, "MCP 名称重复");
  for (const server of manifest.mcp)
    if (!files[projectPath(server.entry)]) throw new ApiError(400, `缺少 MCP 入口 ${server.entry}`);
  for (const skill of manifest.skills) skillDefinition(files, skill);
  if (manifest.kind === "SKILL" && !manifest.skills.length)
    throw new ApiError(400, "技能工程必须包含技能");
  if (manifest.tests) caseSchema.parse(JSON.parse(files[projectPath(manifest.tests)] || "null"));
  return manifest;
}

export function starterProject(kind: ProjectKind, name: string): ProjectFiles {
  const manifest: ProjectManifest = {
    formatVersion: 1,
    kind,
    name,
    entry: kind === "MCP" ? "mcp.ts" : "agent.ts",
    instructions: "根据用户材料完成任务，缺少依据时如实说明。",
    skills: [],
    mcp: [],
    permissions: [],
  };
  const files: ProjectFiles = {};
  if (kind === "AGENT") {
    manifest.preview = "ui.tsx";
    files["agent.ts"] =
      'import { defineAgent } from "@poros/sdk";\n\nexport default defineAgent(async (input, ctx) => {\n  return await ctx.model(typeof input === "string" ? input : JSON.stringify(input));\n});\n';
    files["ui.tsx"] =
      'import { useState } from "react";\nimport { runAgent } from "@poros/sdk";\n\nexport default function App() {\n  const [input, setInput] = useState("");\n  const [output, setOutput] = useState("");\n  const [busy, setBusy] = useState(false);\n  async function submit() {\n    setBusy(true);\n    try { const result = await runAgent(input); setOutput(typeof result === "string" ? result : JSON.stringify(result, null, 2)); }\n    catch (error) { setOutput(error instanceof Error ? error.message : "运行失败"); }\n    finally { setBusy(false); }\n  }\n  return <main style={{padding:24,maxWidth:720,margin:"0 auto",fontFamily:"system-ui,sans-serif",color:"#292722",boxSizing:"border-box"}}>\n    <h1 style={{fontSize:24,lineHeight:1.4,fontWeight:600,margin:"0 0 12px",overflowWrap:"anywhere"}}>' +
      name.replace(/[<>&{}]/g, "") +
      '</h1>\n    <p style={{fontSize:14,lineHeight:1.8,color:"#81796e",margin:"0 0 20px"}}>输入任务，运行当前版本的 Agent。</p>\n    <textarea aria-label="试用输入" value={input} onChange={e=>setInput(e.target.value)} rows={5} style={{width:"100%",boxSizing:"border-box",minHeight:140,padding:14,border:"1px solid #ded9cf",borderRadius:10,fontSize:16,lineHeight:1.7,color:"#292722",background:"#fff",resize:"vertical"}} />\n    <button onClick={submit} disabled={busy||!input.trim()} style={{minHeight:44,padding:"10px 20px",marginTop:12,border:0,borderRadius:9,fontSize:14,background:"#c9694b",color:"white",cursor:busy?"wait":"pointer",opacity:busy||!input.trim()?0.6:1}}>{busy?"正在运行…":"运行 Agent"}</button>\n    <pre role="status" aria-live="polite" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:14,lineHeight:1.8,padding:16,borderRadius:10,background:"#f6f4ef",minHeight:24,marginTop:20}}>{output}</pre>\n  </main>;\n}\n';
  } else if (kind === "MCP") {
    files["mcp.ts"] =
      'import { defineMcp } from "@poros/sdk";\n\nexport default defineMcp({\n  name: "custom-tools",\n  tools: {\n    echo: {\n      description: "回显输入，用于验证真实 MCP 协议连接；请按业务需求修改。",\n      inputSchema: {type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},\n      async handler(args) { return {text:String(args.text)}; }\n    }\n  }\n});\n';
  } else {
    manifest.skills = ["skills/custom-skill"];
    files["skills/custom-skill/SKILL.md"] =
      "---\nname: custom-skill\ndescription: 根据业务需求定制的技能起始工程。\n---\n\n# 处理方法\n\n先核对用户提供的材料和目标，再给出有依据的处理结果。缺少信息时明确说明。\n";
  }
  files["poros.json"] = JSON.stringify(manifest, null, 2) + "\n";
  files["README.md"] =
    `# ${name}\n\n这是起始工程，尚未完成业务开发或验收。使用左侧开发对话修改实现。\n`;
  return files;
}

export const sdkDeclarations = `
declare module "@poros/sdk" {
  export interface AgentContext {
    model(prompt: string, system?: string): Promise<string>;
    tool(name: string, input?: unknown): Promise<unknown>;
    skill(name: string): Promise<string>;
    asset(path: string): Promise<string>;
    script(path: string, input?: unknown): Promise<unknown>;
    http(url: string, options?: {method?: "GET" | "POST"; body?: unknown}): Promise<unknown>;
    emit(type: string, data: unknown): void;
  }
  export type Agent = (input: unknown, ctx: AgentContext) => unknown | Promise<unknown>;
  export function defineAgent(agent: Agent): Agent;
  export interface McpTool {
    description: string;
    inputSchema: Record<string, unknown>;
    handler(args: Record<string, unknown>, ctx: AgentContext): unknown | Promise<unknown>;
  }
  export interface McpDefinition { name: string; tools: Record<string, McpTool>; }
  export function defineMcp(definition: McpDefinition): McpDefinition;
  export function runAgent(input: unknown): Promise<unknown>;
}
`;
