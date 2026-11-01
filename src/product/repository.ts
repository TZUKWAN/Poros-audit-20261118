import { z } from "zod";
import type { Store } from "@/core/store.js";
import { ConnectorSchema, ProjectSchema, WorkspaceSchema, type Connector, type Project, type Workspace } from "./contracts.js";

export const ProjectFileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(240),
  path: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().min(0).default(0),
  indexed: z.boolean().default(false),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export class WorkspaceRepository {
  constructor(
    private readonly workspaces: Store<Workspace>,
    private readonly projects: Store<Project>,
    private readonly files: Store<ProjectFile>,
  ) {}

  async getWorkspace(id: string): Promise<Workspace | undefined> { return await this.workspaces.get(id); }
  async listWorkspaces(): Promise<Workspace[]> { return (await this.workspaces.entries()).map(([, value]) => WorkspaceSchema.parse(value)); }
  async createWorkspace(name: string): Promise<Workspace> {
    const now = new Date().toISOString();
    const workspace = WorkspaceSchema.parse({ schemaVersion: 1, id: idOf("ws"), name, status: "active", projectIds: [], createdAt: now, updatedAt: now });
    await this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  async listProjects(workspaceId: string): Promise<Project[]> {
    return (await this.projects.entries()).map(([, value]) => ProjectSchema.parse(value)).filter((project) => project.workspaceId === workspaceId && project.status !== "deleted");
  }

  async getProject(id: string): Promise<Project | undefined> {
    const value = await this.projects.get(id);
    return value ? ProjectSchema.parse(value) : undefined;
  }

  async createProject(workspaceId: string, name: string, description = "", rootPath: string | null = null): Promise<Project> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) throw new Error("workspace not found");
    const now = new Date().toISOString();
    const project = ProjectSchema.parse({ schemaVersion: 1, id: idOf("project"), workspaceId, name, rootPath, description, instructions: "", status: "active", pinned: false, providerId: null, fileIds: [], memoryIds: [], scenarioIds: [], createdAt: now, updatedAt: now });
    await this.projects.set(project.id, project);
    workspace.projectIds = [...workspace.projectIds, project.id];
    workspace.updatedAt = now;
    await this.workspaces.set(workspace.id, workspace);
    return project;
  }

  async updateProject(id: string, patch: Partial<Pick<Project, "name" | "description" | "instructions" | "pinned" | "providerId" | "rootPath">>): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error("project not found");
    const updated = ProjectSchema.parse({ ...project, ...patch, updatedAt: new Date().toISOString() });
    await this.projects.set(id, updated);
    return updated;
  }

  async upsertProject(project: Project): Promise<Project> {
    const workspace = await this.getWorkspace(project.workspaceId);
    if (!workspace) throw new Error("workspace not found");
    const parsed = ProjectSchema.parse(project);
    const existing = await this.getProject(parsed.id);
    await this.projects.set(parsed.id, parsed);
    if (!existing && !workspace.projectIds.includes(parsed.id)) {
      workspace.projectIds = [...workspace.projectIds, parsed.id];
      workspace.updatedAt = new Date().toISOString();
      await this.workspaces.set(workspace.id, workspace);
    }
    return parsed;
  }

  async archiveProject(id: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error("project not found");
    const archived = ProjectSchema.parse({ ...project, status: "archived", updatedAt: new Date().toISOString() });
    await this.projects.set(id, archived);
    return archived;
  }

  async restoreProject(id: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error("project not found");
    const restored = ProjectSchema.parse({ ...project, status: "active", updatedAt: new Date().toISOString() });
    await this.projects.set(id, restored);
    return restored;
  }

  async deleteProject(id: string): Promise<boolean> {
    const project = await this.getProject(id);
    if (!project) return false;
    const now = new Date().toISOString();
    await this.projects.set(id, ProjectSchema.parse({ ...project, status: "deleted", updatedAt: now }));
    for (const [fileId, file] of await this.files.entries()) if (file.projectId === id) await this.files.delete(fileId);
    return true;
  }

  async listFiles(projectId: string): Promise<ProjectFile[]> {
    return (await this.files.entries()).map(([, value]) => ProjectFileSchema.parse(value)).filter((file) => file.projectId === projectId);
  }

  async addFile(params: { workspaceId: string; projectId: string; name: string; path: string; mediaType: string; size?: number }): Promise<ProjectFile> {
    const project = await this.getProject(params.projectId);
    if (!project || project.workspaceId !== params.workspaceId || project.status !== "active") throw new Error("project unavailable");
    const now = new Date().toISOString();
    const file = ProjectFileSchema.parse({ schemaVersion: 1, id: idOf("file"), ...params, size: params.size ?? 0, indexed: false, createdAt: now, updatedAt: now });
    await this.files.set(file.id, file);
    project.fileIds = [...project.fileIds, file.id];
    project.updatedAt = now;
    await this.projects.set(project.id, project);
    return file;
  }

  async getFile(id: string): Promise<ProjectFile | undefined> {
    const value = await this.files.get(id);
    return value ? ProjectFileSchema.parse(value) : undefined;
  }

  async deleteFile(id: string): Promise<boolean> {
    const file = await this.getFile(id);
    if (!file) return false;
    const deleted = await this.files.delete(id);
    if (!deleted) return false;
    const project = await this.getProject(file.projectId);
    if (project) {
      project.fileIds = project.fileIds.filter((fileId) => fileId !== id);
      project.updatedAt = new Date().toISOString();
      await this.projects.set(project.id, project);
    }
    return true;
  }

  async setFileIndexed(id: string, indexed: boolean): Promise<ProjectFile> {
    const file = await this.getFile(id);
    if (!file) throw new Error("file not found");
    const updated = ProjectFileSchema.parse({ ...file, indexed, updatedAt: new Date().toISOString() });
    await this.files.set(id, updated);
    return updated;
  }

  async getDefaultWorkspace(): Promise<Workspace> {
    const active = (await this.listWorkspaces()).find((workspace) => workspace.status === "active");
    return active ?? await this.createWorkspace("个人工作区");
  }
}

export class ConnectorRepository {
  constructor(private readonly store: Store<Connector>) {}

  async list(workspaceId: string): Promise<Connector[]> {
    return (await this.store.entries()).map(([, value]) => ConnectorSchema.parse(value)).filter((connector) => connector.workspaceId === workspaceId);
  }

  async get(id: string): Promise<Connector | undefined> {
    const value = await this.store.get(id);
    return value ? ConnectorSchema.parse(value) : undefined;
  }

  async create(params: { workspaceId: string; name: string; kind: Connector["kind"]; endpoint?: string; permissionScopes?: Connector["permissionScopes"]; hasSecret?: boolean; source?: Connector["source"]; trustEvidence?: Connector["trustEvidence"] }): Promise<Connector> {
    const now = new Date().toISOString();
    const connector = ConnectorSchema.parse({ schemaVersion: 1, id: idOf("connector"), workspaceId: params.workspaceId, name: params.name, kind: params.kind, endpoint: params.endpoint ?? null, permissionScopes: params.permissionScopes ?? [], hasSecret: params.hasSecret ?? false, source: params.source ?? "user", trustStatus: params.trustEvidence?.length ? "verified" : "unverified", trustScore: params.trustEvidence?.length ? 0.5 : 0, trustEvidence: params.trustEvidence ?? [], status: "disabled", lastHealthAt: null, lastError: null, createdAt: now, updatedAt: now });
    await this.store.set(connector.id, connector);
    return connector;
  }

  async setStatus(id: string, status: Connector["status"], lastError: string | null = null): Promise<Connector> {
    const connector = await this.get(id);
    if (!connector) throw new Error("connector not found");
    const updated = ConnectorSchema.parse({ ...connector, status, lastError, lastHealthAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await this.store.set(id, updated);
    return updated;
  }

  async recordTrustEvidence(id: string, evidence: Connector["trustEvidence"][number], status: Connector["trustStatus"] = "verified", score = 0.5): Promise<Connector> {
    const connector = await this.get(id);
    if (!connector) throw new Error("connector not found");
    const updated = ConnectorSchema.parse({ ...connector, trustStatus: status, trustScore: score, trustEvidence: [...connector.trustEvidence, evidence].slice(-20), updatedAt: new Date().toISOString() });
    await this.store.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> { return await this.store.delete(id); }
}

function idOf(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
