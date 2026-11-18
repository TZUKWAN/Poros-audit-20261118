import type { CapabilityDefinition, Prisma, Task } from "@prisma/client";
import { z } from "zod";
import type { Principal } from "./auth.js";
import {
  connectorFor,
  harnessSource,
  managedSource,
  runtimeToolName,
  type BrokerTool,
} from "./capability-catalog.js";
import type { DshGrant } from "./dsh-runtime.js";
import { ApiError } from "./errors.js";
import { extractFileText } from "./file-text.js";
import { findConnection, recordConnectionCheck, type Provider } from "./integration-connections.js";
import { useIntegrationTool } from "./integration-providers.js";
import { describeProviderError } from "./provider-errors.js";
import { getObject } from "./storage.js";
import { redact } from "./security.js";

export async function requireManagedGrant(
  db: Prisma.TransactionClient,
  organizationId: string,
  grant: DshGrant,
  projectId?: string | null,
) {
  if (!grant.source?.startsWith(managedSource)) return null;
  const capability = await db.capabilityDefinition.findFirst({
    where: {
      id: grant.source.slice(managedSource.length),
      organizationId,
      kind: grant.kind,
      name: grant.name,
      version: Number(grant.version),
      disabledAt: null,
    },
  });
  if (
    !capability ||
    (projectId !== undefined && capability.projectId && projectId !== capability.projectId)
  )
    throw new ApiError(403, "能力已停用、版本不匹配或需要使用关联项目");
  return capability;
}

export async function assertGrantRevision(
  db: Prisma.TransactionClient,
  agentId: string,
  grants: DshGrant[],
  version: number | null,
  createdAt: Date,
) {
  if (!grants.length) return;
  const revoked = await db.agentGrantRevocation.findFirst({
    where: {
      agentId,
      ...(version === null
        ? { revokedAt: { gte: createdAt } }
        : { throughVersion: { gte: version } }),
      OR: grants.map((grant) => ({
        kind: grant.kind,
        name: grant.name,
        source: grant.source ?? harnessSource,
      })),
    },
  });
  if (revoked) throw new ApiError(403, `${revoked.name} 授权已撤销，需要重新授权并发布新版本`);
}

type Owner = Pick<Principal, "organizationId" | "userId">;
export async function freezeCapabilityConnections(
  db: Prisma.TransactionClient,
  p: Owner,
  grants: DshGrant[],
  projectId: string | null,
) {
  const revisions: Partial<Record<Provider, string>> = {};
  for (const grant of grants) {
    await requireManagedGrant(db, p.organizationId, grant, projectId);
    const connector = connectorFor(grant);
    if (!connector || revisions[connector.provider]) continue;
    const row = await findConnection(db, p, connector.provider);
    if (!row || row.testCode !== "OK")
      throw new ApiError(
        409,
        `${connector.capability} 需要发起人在设置中验证 ${connector.provider} 连接`,
      );
    revisions[connector.provider] = row.revision;
  }
  return revisions;
}

export async function assertCapabilityConnections(
  db: Prisma.TransactionClient,
  task: Pick<Task, "organizationId" | "createdBy" | "connectionRevisions">,
) {
  const owner = { organizationId: task.organizationId, userId: task.createdBy };
  const revisions = task.connectionRevisions as Partial<Record<Provider, string>>;
  for (const provider of ["kdocs", "ima", "tinyfish"] as const) {
    if (!revisions?.[provider]) continue;
    const current = await findConnection(db, owner, provider);
    if (!current || current.revision !== revisions[provider] || current.testCode !== "OK")
      throw new ApiError(403, `${provider} 凭证已更换、停用或验证失败，请重新发起任务`);
  }
}

export async function brokerRuntime(
  db: Prisma.TransactionClient,
  task: Task,
  grants: DshGrant[],
  checkAccess: () => Promise<void>,
  log: (kind: string, value: unknown) => Promise<void>,
) {
  const definitions = new Map<
    string,
    { tool: BrokerTool; grant: DshGrant; capability: CapabilityDefinition | null }
  >();
  const owner = { organizationId: task.organizationId, userId: task.createdBy };
  const revisions = task.connectionRevisions as Partial<Record<Provider, string>>;
  for (const grant of grants) {
    const connector = connectorFor(grant);
    const capability = await requireManagedGrant(db, task.organizationId, grant, task.projectId);
    if (!connector && !capability) continue;
    const name = runtimeToolName(grant)!;
    const tool: BrokerTool = connector ?? {
      name,
      description:
        capability!.kind === "SKILL"
          ? `Load versioned organization skill instructions: ${capability!.description}`
          : `Read the authorized project source: ${capability!.description}`,
      input: {},
    };
    if (definitions.has(name)) throw new ApiError(409, "能力的运行时名称冲突");
    definitions.set(name, { tool, grant, capability });
  }
  const invoke = async (name: string, input: unknown, signal: AbortSignal) => {
    const binding = definitions.get(name);
    if (!binding) return { ok: false, error: "该工具未获本次授权" };
    try {
      signal.throwIfAborted();
      await checkAccess();
      const args = z
        .object(
          Object.fromEntries(
            Object.keys(binding.tool.input).map((key) => [
              key,
              z
                .string()
                .trim()
                .min(name === "ima_list" ? 0 : 1)
                .max(2000),
            ]),
          ),
        )
        .strict()
        .parse(input ?? {});
      const connector = connectorFor(binding.grant);
      const source = {
        tool: name,
        capability: binding.grant.name,
        version: binding.grant.version,
        source: binding.grant.source,
      };
      await log("capability.call", { ...source, input: args });
      if (connector) {
        const row = await findConnection(db, owner, connector.provider);
        if (!row || row.revision !== revisions?.[connector.provider] || row.testCode !== "OK")
          throw new ApiError(403, "发起人的连接未验证、凭证已变更或已撤销");
        let items;
        try {
          items = await useIntegrationTool(row, connector.action, args, signal);
        } catch (error) {
          const failure = describeProviderError(error);
          if (
            ["AUTH_REJECTED", "ACCOUNT_VALIDATION_REQUIRED", "UPSTREAM_AUTH_UNAVAILABLE"].includes(
              failure.code,
            )
          )
            await recordConnectionCheck(db, row, failure.code);
          throw error;
        }
        await checkAccess();
        await log("capability.result", {
          ...source,
          provider: connector.provider,
          items,
          count: items.length,
        });
        return { ok: true, source, items };
      }
      const capability = await requireManagedGrant(
        db,
        task.organizationId,
        binding.grant,
        task.projectId,
      );
      if (capability?.kind === "SKILL") {
        await log("capability.result", { ...source, chars: capability.instruction.length });
        return { ok: true, source, instruction: capability.instruction };
      }
      const file = await db.fileObject.findFirst({
        where: {
          id: capability?.fileId ?? "",
          organizationId: task.organizationId,
          projectId: task.projectId,
          deletedAt: null,
        },
      });
      if (!file) throw new ApiError(403, "关联知识文件已删除或无访问权限");
      const preview = await extractFileText(file.name, await getObject(file.storageKey), signal);
      await checkAccess();
      const item = {
        title: file.name,
        text: preview.text.slice(0, 12000),
        url: file.sourceUrl,
        id: file.id,
        truncated: preview.truncated || preview.text.length > 12000,
      };
      await log("capability.result", {
        ...source,
        items: [{ title: file.name, id: file.id, url: file.sourceUrl, truncated: item.truncated }],
      });
      return { ok: true, source, items: [item] };
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof z.ZodError
            ? "工具输入缺失或格式不正确"
            : describeProviderError(error).message;
      await log("capability.error", { tool: name, error: redact(message) });
      return { ok: false, error: message };
    }
  };
  return { brokerTools: [...definitions.values()].map((value) => value.tool), invoke };
}
