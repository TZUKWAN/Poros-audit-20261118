export type Grant = {
  id: string;
  kind: string;
  name: string;
  scopeNote: string;
  source: string;
  version: string;
};
export type Manifest = {
  agentId: string;
  name: string;
  department: string;
  config: Record<string, unknown>;
  grants: Grant[];
};
export type Agent = {
  id: string;
  name: string;
  description: string;
  department: string;
  status: string;
  currentVersion: number;
  releaseReady: boolean;
  draftRevision: string;
  publicationRevision: string;
  draftConfig: Record<string, unknown>;
  draftOrigin: string;
  generationModel: string | null;
  projectRestricted: boolean;
  projects: Array<{ projectId: string }>;
  grants: Grant[];
  versions: Array<{ version: number; approvedAt: string | null; manifest: Manifest }>;
};
export type Project = {
  id: string;
  name: string;
  description: string;
  archivedAt: string | null;
  role: "MANAGER" | "CONTRIBUTOR" | "VIEWER";
};
export type StoredFile = {
  id: string;
  name: string;
  category: string;
  sizeBytes: number;
  sourceUrl: string;
  createdAt: string;
  createdBy: string;
  projectId: string | null;
  useCount: number;
  textSupported: boolean;
};
export type TaskRow = {
  id: string;
  title: string;
  status: string;
  sensitive: string[];
  createdAt: string;
  createdBy: string;
};
export type CatalogEntry = {
  id?: string;
  kind: string;
  name: string;
  source: string;
  version: string;
  description: string;
  projectId?: string | null;
  provider?: "kdocs" | "ima" | "tinyfish";
  disabledAt?: string | null;
  runtimeName?: string;
  configured?: boolean;
};

export const dateTime = (date: string) => new Date(date).toLocaleString("zh-CN");
export const sensitiveGrants = (grants: Grant[]) =>
  grants
    .filter(
      (g) =>
        g.kind === "MCP" ||
        g.name.startsWith("ima.") ||
        (g.kind === "TOOL" &&
          ["bash", "write", "edit", "web.fetch", "web.search"].includes(g.name)),
    )
    .map((g) => g.name);

export const modelDisplay = (channel: string, model?: string | null) => {
  if (channel === "mock" || channel === "dsh(stub)") return "模拟环境 · 测试模型";
  if (channel === "pending") return "等待模型分配";
  return model ? `真实模型 · ${model}` : channel || "连接未验证";
};
import type { SettingsBody } from "./views/integrations.js";

export function modelPreflight(grants: Grant[], settings: SettingsBody | null) {
  if (!settings) return { label: "正在检查模型连接", blocked: true };
  const personal = grants.find(
    (grant) => grant.kind === "MODEL" && grant.source.startsWith("personal-openai-compatible:"),
  );
  if (personal) {
    const connected = settings.connections.find((row) => row.provider === "model");
    if (settings.testModel && settings.runtime === "dsh")
      return { label: "模拟环境不能运行已授权的个人模型", blocked: true };
    const matches =
      connected?.verified &&
      connected.settings.model === personal.name &&
      "personal-openai-compatible:" + connected.settings.baseUrl === personal.source;
    return matches
      ? { label: `已验证个人模型 · ${personal.name}`, blocked: false }
      : { label: `连接未验证 · 请在设置中验证 ${personal.name}`, blocked: true };
  }
  if (settings.personalModelOnly) return { label: "先授权并审批个人模型", blocked: true };
  if (
    (settings.runtime === "dsh" || settings.modelMode === "CONFIGURED") &&
    !grants.some((grant) => grant.kind === "MODEL" && grant.name === "deepseek-chat")
  )
    return { label: "缺少 deepseek-chat 模型授权", blocked: true };
  return settings.modelMode === "SIMULATION"
    ? { label: "模拟环境 · 测试模型", blocked: false }
    : settings.builtinModel
      ? { label: `部署模型 · ${settings.builtinModel}`, blocked: false }
      : { label: "部署模型未配置，请联系部署管理员", blocked: true };
}

export function capabilityBlock(
  grants: Grant[],
  settings: SettingsBody | null,
  catalog: CatalogEntry[],
  project?: string,
) {
  for (const grant of grants) {
    const entry = catalog.find(
      (item) =>
        item.kind === grant.kind &&
        item.name === grant.name &&
        (item.source === grant.source || grant.name.startsWith("web.")),
    );
    if (grant.source?.startsWith("poros-catalog:") && (!entry || entry.disabledAt))
      return `${grant.name} 已停用或当前用户无访问范围`;
    if (entry?.projectId && project !== undefined && entry.projectId !== project)
      return `${entry.name} 需要选择其注册项目`;
    if (
      entry?.provider &&
      !settings?.connections.some(
        (connection) => connection.provider === entry.provider && connection.verified,
      )
    )
      return `${entry.name} 连接未验证。请先在设置中验证 ${entry.provider}。`;
    if ((entry?.provider || entry?.id) && settings?.runtime !== "dsh")
      return "此能力需要 DSH 运行环境";
  }
  return "";
}
