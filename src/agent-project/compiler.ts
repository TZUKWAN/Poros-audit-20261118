import path from "node:path";
import { randomBytes } from "node:crypto";
import ts from "typescript";
import { build, type Plugin } from "esbuild";
import {
  parseProject,
  sdkDeclarations,
  skillDefinition,
  type ProjectManifest,
} from "./contract.js";
import { validateFiles, type ProjectFiles } from "./files.js";

export interface Compilation {
  status: "READY" | "FAILED";
  manifest?: ProjectManifest;
  diagnostics: string[];
  bundles: Record<string, string>;
  previewHtml: string;
  evidence: { typecheck: boolean; compiled: boolean; businessVerified: false; compiler: string };
}
const sdkRuntime = `export const defineAgent = x => x; export const defineMcp = x => x;
let port, requestId = 0; const pending = new Map();
if (typeof window !== "undefined") window.addEventListener("message", e => {
  if (e.source !== window.parent || e.data?.type !== "poros.connect" || !e.ports[0] || port) return;
  port = e.ports[0]; port.onmessage = e => { const item = pending.get(e.data?.id);
    if (!item) return; pending.delete(e.data.id); e.data.error ? item.reject(new Error(e.data.error)) : item.resolve(e.data.result); };
  port.start(); port.postMessage({type:"ready"});
});
export async function runAgent(input) {
  if (!port) throw new Error("预览尚未连接，请稍候重试");
  if (pending.size) throw new Error("已有试用正在运行");
  return new Promise((resolve, reject) => { const id = String(++requestId); pending.set(id,{resolve,reject}); port.postMessage({type:"run", id, input}); });
}`;
const mcpAdapter = (entry: string) => `
import definition from "./${entry}";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {ListToolsRequestSchema,CallToolRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {AjvJsonSchemaValidator} from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
const tools = definition.tools;
if (!tools || Object.keys(tools).length > 32) throw new Error("MCP tools must contain at most 32 entries");
const validator = new AjvJsonSchemaValidator();
const validators = new Map(Object.entries(tools).map(([name,tool])=>[name,validator.getValidator(tool.inputSchema)]));
const server = new Server({name:definition.name,version:"1.0.0"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(tools).map(([name,tool])=>({name,description:tool.description,inputSchema:tool.inputSchema}))}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
  const tool = tools[params.name]; if (!Object.hasOwn(tools,params.name)) throw new Error("Tool not found");
  const args = params.arguments || {}; const checked = validators.get(params.name)(args);
  if (!checked.valid) throw new Error("Invalid tool input: " + checked.errorMessage);
  const output = await tool.handler(args,globalThis.__porosContext);
  return {content:[{type:"text",text:typeof output==="string"?output:JSON.stringify(output ?? null)}],structuredContent:output && typeof output==="object" && !Array.isArray(output)?output:{value:output ?? null}};
});
export const ready = server.connect(globalThis.__porosMcpTransport);
`;

function typecheck(files: ProjectFiles): string[] {
  const root = path.resolve(".poros-virtual-types");
  const normalize = (p: string) => path.resolve(p).replaceAll("\\", "/");
  const sources = new Map(
    Object.entries(files).map(([name, content]) => [normalize(path.join(root, name)), content]),
  );
  sources.set(normalize(path.join(root, "poros-sdk.d.ts")), sdkDeclarations);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    allowJs: true,
    checkJs: true,
  };
  const host = ts.createCompilerHost(options);
  const baseExists = host.fileExists,
    baseRead = host.readFile;
  const trusted = (p: string) => normalize(p).includes("/node_modules/");
  host.fileExists = (p) => sources.has(normalize(p)) || (trusted(p) && baseExists(p));
  host.readFile = (p) => sources.get(normalize(p)) ?? (trusted(p) ? baseRead(p) : undefined);
  host.getSourceFile = (p, version) => {
    const text = host.readFile(p);
    return text === undefined ? undefined : ts.createSourceFile(p, text, version, true);
  };
  host.resolveModuleNames = (names, containing) =>
    names.map((name) => {
      if (trusted(containing))
        return ts.resolveModuleName(name, containing, options, host).resolvedModule;
      if (name === "@poros/sdk")
        return { resolvedFileName: path.join(root, "poros-sdk.d.ts"), extension: ts.Extension.Dts };
      if (name.startsWith(".")) {
        const candidate = normalize(path.resolve(path.dirname(containing), name));
        if (!candidate.startsWith(normalize(root) + "/")) return undefined;
        for (const suffix of ["", ".ts", ".tsx", ".js", ".json", "/index.ts"])
          if (sources.has(candidate + suffix))
            return {
              resolvedFileName: candidate + suffix,
              extension: suffix.endsWith("tsx") ? ts.Extension.Tsx : ts.Extension.Ts,
            };
        return undefined;
      }
      if (!/^(react(?:\/jsx-runtime)?|react-dom\/client)$/.test(name)) return undefined;
      return ts.resolveModuleName(name, containing, options, host).resolvedModule;
    });
  const roots = [...sources.keys()].filter((name) => /\.(?:tsx?|jsx?)$/.test(name));
  const program = ts.createProgram(roots, options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .slice(0, 30)
    .map((d) => {
      const name = d.file ? path.relative(root, d.file.fileName).replaceAll("\\", "/") : "工程";
      const pos =
        d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return `${name}${pos ? ":" + (pos.line + 1) + ":" + (pos.character + 1) : ""} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
}

function projectPlugin(files: ProjectFiles, browser: boolean): Plugin {
  return {
    name: "poros-project",
    setup(builder) {
      builder.onResolve({ filter: /.*/, namespace: "project" }, (args) => {
        if (args.path === "@poros/sdk") return { path: "sdk", namespace: "sdk" };
        if (browser && /^(react(?:\/jsx-runtime)?|react-dom\/client)$/.test(args.path))
          return builder.resolve(args.path, { resolveDir: process.cwd(), kind: args.kind });
        const candidate = path.posix.normalize(
          path.posix.join(path.posix.dirname(args.importer), args.path),
        );
        if (!args.path.startsWith(".") || candidate.startsWith("../") || candidate.startsWith("/"))
          return { errors: [{ text: `不允许的依赖 ${args.path}；可用本工程文件与 @poros/sdk` }] };
        for (const suffix of ["", ".ts", ".tsx", ".js", ".json", ".css", "/index.ts"])
          if (Object.hasOwn(files, candidate + suffix))
            return { path: candidate + suffix, namespace: "project" };
        return { errors: [{ text: `找不到工程文件 ${candidate}` }] };
      });
      builder.onLoad({ filter: /.*/, namespace: "project" }, (args) => ({
        contents: files[args.path],
        loader: args.path.endsWith(".tsx")
          ? "tsx"
          : args.path.endsWith(".css")
            ? "css"
            : args.path.endsWith(".json")
              ? "json"
              : "ts",
      }));
      builder.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({
        contents: sdkRuntime,
        loader: "js",
      }));
    },
  };
}
async function bundle(files: ProjectFiles, entry: string, browser = false, trustedMcp = false) {
  const code = trustedMcp
    ? mcpAdapter(entry)
    : browser
      ? `import "@poros/sdk"; import React from "react"; import {createRoot} from "react-dom/client"; import App from "./${entry}"; createRoot(document.getElementById("root")).render(React.createElement(App));`
      : `export {default} from "./${entry}";`;
  const result = await build({
    stdin: {
      contents: code,
      loader: "js",
      resolveDir: process.cwd(),
      sourcefile: "poros-entry.js",
    },
    bundle: true,
    write: false,
    platform: browser ? "browser" : "node",
    target: "es2022",
    format: browser ? "iife" : "cjs",
    outfile: "bundle.js",
    minify: browser,
    logLevel: "silent",
    jsx: "automatic",
    plugins: [
      {
        name: "entry",
        setup(builder) {
          builder.onResolve({ filter: /^@poros\/sdk$/, namespace: "" }, () => ({
            path: "sdk",
            namespace: "sdk",
          }));
          builder.onResolve({ filter: /^\.\//, namespace: "" }, (args) => {
            if (args.importer !== "poros-entry.js" && !args.importer.endsWith("poros-entry.js"))
              return undefined;
            return { path: args.path.slice(2), namespace: "project" };
          });
          if (browser)
            builder.onResolve({ filter: /^react\/jsx-runtime$/, namespace: "project" }, (args) =>
              builder.resolve(args.path, { resolveDir: process.cwd(), kind: args.kind }),
            );
        },
      },
      projectPlugin(files, browser),
    ],
  });
  return {
    code: result.outputFiles.find((f) => f.path.endsWith(".js"))!.text,
    css: result.outputFiles.find((f) => f.path.endsWith(".css"))?.text || "",
  };
}

export async function compileProject(raw: ProjectFiles): Promise<Compilation> {
  const evidence = {
    typecheck: false,
    compiled: false,
    businessVerified: false as const,
    compiler: `TypeScript ${ts.version}; esbuild 0.28.2`,
  };
  const result: Compilation = {
    status: "FAILED",
    diagnostics: [],
    bundles: {},
    previewHtml: "",
    evidence,
  };
  try {
    const files = validateFiles(raw),
      manifest = parseProject(files);
    result.manifest = manifest;
    result.diagnostics = typecheck(files);
    if (result.diagnostics.length) return result;
    evidence.typecheck = true;
    if (manifest.kind === "AGENT")
      result.bundles.agent = (await bundle(files, manifest.entry)).code;
    if (manifest.kind === "MCP")
      result.bundles.mcp = (await bundle(files, manifest.entry, false, true)).code;
    for (const server of manifest.mcp)
      result.bundles["mcp:" + server.name] = (await bundle(files, server.entry, false, true)).code;
    for (const name of Object.keys(files).filter((name) => /(?:^|\/)scripts\/.+\.ts$/.test(name)))
      result.bundles["script:" + name] = (await bundle(files, name)).code;
    for (const directory of manifest.skills) {
      skillDefinition(files, directory);
      const generated = {
        ...files,
        "__skill-agent.ts":
          'import {defineAgent} from "@poros/sdk"; export default defineAgent(async(input,ctx)=>ctx.model(typeof input==="string"?input:JSON.stringify(input)));',
      };
      result.bundles["skill:" + directory] = (await bundle(generated, "__skill-agent.ts")).code;
    }
    if (manifest.kind === "SKILL")
      result.bundles.agent = result.bundles["skill:" + manifest.skills[0]!]!;
    if (manifest.preview) {
      const ui = await bundle(files, manifest.preview, true),
        nonce = randomBytes(18).toString("base64");
      const script = ui.code.replace(/<\/script/gi, "<\\/script");
      const styleScript = `const style=document.createElement('style');style.textContent=${JSON.stringify(ui.css).replaceAll("<", "\\u003c")};document.head.append(style);`;
      result.previewHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>Agent 预览</title></head><body style="margin:0"><div id="root"></div><script nonce="${nonce}">${styleScript}${script}</script></body></html>`;
    }
    evidence.compiled = true;
    result.status = "READY";
  } catch (error) {
    const errors = (error as { errors?: Array<{ text: string }> }).errors;
    result.diagnostics = errors?.map((e) => e.text).slice(0, 20) || [
      error instanceof Error ? error.message : "构建失败",
    ];
  }
  return result;
}
