import { describe, expect, it } from "vitest";
import { ArtifactSchema, ConnectorSchema, LongRunSchema, MemoryItemSchema, ProductModelSchemas, ProjectSchema, ProviderProfileSchema, RunProductSchema, ScheduledTaskSchema, SessionProductSchema, WorkspaceSchema } from "@/product/contracts";

const at = "2026-10-03T00:00:00.000Z";

describe("Agent 工作台产品契约", () => {
  it("所有核心模型都有 schemaVersion、状态和时间字段", () => {
    const common = { schemaVersion: 1, createdAt: at, updatedAt: at };
    expect(WorkspaceSchema.parse({ ...common, id: "w", name: "工作区" }).status).toBe("active");
    expect(ProjectSchema.parse({ ...common, id: "p", workspaceId: "w", name: "项目" }).status).toBe("active");
    expect(SessionProductSchema.parse({ ...common, id: "s", workspaceId: "w", title: "会话" }).status).toBe("active");
    expect(RunProductSchema.parse({ ...common, id: "r", workspaceId: "w", mode: "work", model: "m", status: "queued", requirement: "做事", startedAt: at }).status).toBe("queued");
    expect(LongRunSchema.parse({ ...common, id: "lr", workspaceId: "w", scenarioId: "s", goal: "循环目标", maxRounds: 2, nextRound: 1, status: "queued" }).status).toBe("queued");
  });

  it("Memory、Artifact、Connector、Provider、Task 约束敏感字段和状态", () => {
    const common = { schemaVersion: 1, createdAt: at, updatedAt: at };
    expect(MemoryItemSchema.parse({ ...common, id: "m", workspaceId: "w", scope: "global", content: "偏好", sourceType: "user" }).enabled).toBe(true);
    expect(ArtifactSchema.parse({ ...common, id: "a", workspaceId: "w", name: "结果", mediaType: "text/markdown", path: "x.md" }).status).toBe("draft");
    expect(ConnectorSchema.parse({ ...common, id: "c", workspaceId: "w", name: "本地工具", kind: "mcp-local" }).status).toBe("disabled");
    expect(ProviderProfileSchema.parse({ ...common, id: "pr", workspaceId: "w", name: "本地", kind: "local", baseUrl: "http://127.0.0.1:1/v1", model: "m" }).hasSecret).toBe(false);
    expect(ScheduledTaskSchema.parse({ ...common, id: "t", workspaceId: "w", requirement: "检查", schedule: "once" }).enabled).toBe(true);
    expect(Object.keys(ProductModelSchemas)).toHaveLength(10);
  });

  it("拒绝缺失身份和非法状态", () => {
    expect(() => WorkspaceSchema.parse({ schemaVersion: 1, id: "", name: "x", createdAt: at, updatedAt: at })).toThrow();
    expect(() => RunProductSchema.parse({ schemaVersion: 1, id: "r", workspaceId: "w", mode: "work", model: "m", status: "unknown", requirement: "x", startedAt: at })).toThrow();
    expect(() => ConnectorSchema.parse({ schemaVersion: 1, id: "c", workspaceId: "w", name: "x", kind: "mcp-local", permissionScopes: ["admin"], createdAt: at, updatedAt: at })).toThrow();
  });
});
