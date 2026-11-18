import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import type { Principal } from "./auth.js";
import { visibleAgents } from "./auth.js";
import type { DshGrant } from "./dsh-runtime.js";
import { modelId, personalModelSource } from "./integration-connections.js";
import { canonicalModelBase } from "./provider-http.js";
import { ApiError } from "./errors.js";
import { connectorFor, nativeTools, managedSource, harnessSource } from "./capability-catalog.js";
import { assertGrantRevision, requireManagedGrant } from "./capabilities.js";

export { ApiError } from "./errors.js";
export function validateConfig(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ApiError(400, "Agent 配置必须是对象");
  const config = raw as Record<string, unknown>;
  if (
    config.persona !== undefined &&
    (typeof config.persona !== "string" || config.persona.length > 12000)
  )
    throw new ApiError(400, "Persona 必须为不超过 12000 字符的文本");
  if (
    config.modelPolicy !== undefined &&
    ![
      "default",
      "deepseek-chat",
      "personal",
      ...(process.env.NODE_ENV !== "production" ? ["mock（未配置真实模型服务）"] : []),
    ].includes(String(config.modelPolicy))
  )
    throw new ApiError(400, "未准入的 Model Policy；不可静默切换模型");
  if (
    config.outputKind !== undefined &&
    config.outputKind !== "chat-answer" &&
    config.outputKind !== "markdown-document"
  )
    throw new ApiError(400, "输出要求请选择对话答复或 Markdown 文档");
}
/** Tool permissions come from precise grants. Retire the unused legacy suggestions. */
export function editableConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const config = { ...raw };
  delete config.tools;
  validateConfig(config);
  return config;
}
export interface Manifest {
  agentId: string;
  name: string;
  department: string;
  config: Record<string, unknown>;
  grants: DshGrant[];
  harness: string;
}
const shaJson = (json: string) => createHash("sha256").update(json).digest("hex");
export const digest = (value: unknown) =>
  shaJson(
    JSON.stringify(value, (_key, item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const fields = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(fields)
          .sort()
          .map((key) => [key, fields[key]]),
      );
    }),
  );
export const matchesFrozenDigest = (value: unknown, hash: unknown) =>
  typeof hash === "string" && (digest(value) === hash || shaJson(JSON.stringify(value)) === hash);
export function validateGrant(g: DshGrant): void {
  if (connectorFor(g)) return;
  if (
    g.kind === "TOOL" &&
    (nativeTools as readonly string[]).includes(g.name) &&
    (!g.source || g.source === harnessSource)
  )
    return;
  if (
    ["SKILL", "KNOWLEDGE"].includes(g.kind) &&
    g.source?.startsWith(managedSource) &&
    /^[a-z0-9][a-z0-9_-]{0,79}$/.test(g.name) &&
    /^[1-9][0-9]{0,7}$/.test(g.version ?? "")
  )
    return;
  if (g.kind === "MODEL" && g.source?.startsWith(personalModelSource)) {
    const base = g.source.slice(personalModelSource.length);
    try {
      if (modelId.safeParse(g.name).success && canonicalModelBase(base) === base) return;
    } catch {
      /* Reject malformed grants, including embedded credentials. */
    }
  } else if (
    g.kind === "MODEL" &&
    g.name === "deepseek-chat" &&
    (!g.source || g.source === harnessSource)
  )
    return;
  throw new ApiError(
    400,
    "能力未注册或尚未配置真实绑定；默认拒绝（Tool/Skill/MCP/Knowledge/Model 均需精确授权）",
  );
}
export function personalModelGrant(grants: DshGrant[]) {
  const matching = grants.filter(
    (grant) => grant.kind === "MODEL" && grant.source?.startsWith(personalModelSource),
  );
  if (matching.length > 1) throw new ApiError(409, "一个 Agent 版本只能指定一个个人模型连接");
  return matching[0] as (DshGrant & { source: string }) | undefined;
}
export function validateModelPolicy(manifest: Manifest) {
  const binding = personalModelGrant(manifest.grants);
  if (manifest.config.modelPolicy === "personal" && !binding)
    throw new ApiError(409, "个人模型策略需要先授权明确的端点和型号");
  if (manifest.config.modelPolicy === "deepseek-chat" && binding)
    throw new ApiError(409, "组织模型策略与个人模型授权冲突，请选择其一");
  return binding;
}
export function parseManifest(raw: unknown): Manifest {
  const m = raw as Manifest;
  if (!m || !m.agentId || !Array.isArray(m.grants) || m.harness !== "@deepseek-ai/dsh@0.2.2-rc.1")
    throw new ApiError(409, "旧版缺少可验证授权快照，请重新申请发布并审批");
  for (const g of m.grants) validateGrant(g);
  validateConfig(m.config);
  validateModelPolicy(m);
  return m;
}
export async function requestPublication(db: PrismaClient, p: Principal, agentId: string) {
  return db.$transaction(async (tx) => {
    // Serialize release allocation *and* draft/grant reads on the same Agent row.
    await tx.$queryRaw`SELECT id FROM "AgentDefinition" WHERE id=${agentId} AND "organizationId"=${p.organizationId} FOR UPDATE`;
    const a = await tx.agentDefinition.findFirst({
      where: { id: agentId, ...visibleAgents(p, "write") },
      include: { grants: true },
    });
    if (!a) throw new ApiError(404, "Agent 不存在");
    validateConfig(a.draftConfig);
    for (const grant of a.grants) {
      validateGrant(grant);
      await requireManagedGrant(tx, p.organizationId, grant);
    }
    const manifest: Manifest = {
      agentId: a.id,
      name: a.name,
      department: a.department,
      config: a.draftConfig as Record<string, unknown>,
      grants: a.grants.map((g) => ({
        kind: g.kind,
        name: g.name,
        version: g.version,
        source: g.source,
        scopeNote: g.scopeNote,
      })),
      harness: "@deepseek-ai/dsh@0.2.2-rc.1",
    };
    validateModelPolicy(manifest);
    const next = await tx.agentDefinition.update({
      where: { id: a.id },
      data: { versionCounter: { increment: 1 } },
    });
    const version = await tx.agentVersion.create({
      data: {
        agentId: a.id,
        version: next.versionCounter,
        config: a.draftConfig as Prisma.InputJsonValue,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        publishedBy: p.userId,
      },
    });
    const approval = await tx.approvalRequest.create({
      data: {
        organizationId: p.organizationId,
        kind: "AGENT_PUBLISH",
        subjectId: version.id,
        requestedBy: p.userId,
        payload: {
          agentId: a.id,
          version: version.version,
          manifestHash: digest(manifest),
          manifest: manifest as unknown as Prisma.InputJsonValue,
        },
      },
    });
    return {
      version: version.version,
      approvalId: approval.id,
      pending: true,
      immutable: true,
      manifest,
    };
  });
}
export async function approvePublication(
  tx: Prisma.TransactionClient,
  subjectId: string,
  organizationId: string,
) {
  const v = await tx.agentVersion.findFirst({
    where: { id: subjectId, agent: { organizationId } },
    include: { agent: true },
  });
  if (!v) throw new ApiError(404, "发布版本不存在");
  const manifest = parseManifest(v.manifest);
  await assertGrantRevision(tx, v.agentId, manifest.grants, v.version, v.createdAt);
  for (const grant of manifest.grants) await requireManagedGrant(tx, organizationId, grant);
  await tx.agentVersion.update({ where: { id: v.id }, data: { approvedAt: new Date() } });
  // A delayed approval of an older pending version must not silently roll back a newer release.
  await tx.agentDefinition.updateMany({
    where: { id: v.agentId, currentVersion: { lt: v.version } },
    data: { currentVersion: v.version, status: "PUBLISHED" },
  });
}
