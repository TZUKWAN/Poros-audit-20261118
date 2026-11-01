import type { Store } from "@/core/store.js";
import { ArtifactSchema, type Artifact } from "./contracts.js";

export interface ArtifactSummary {
  id: string;
  name: string;
  mediaType: string;
  projectId: string | null;
  sessionId: string | null;
  runId: string | null;
  version: number;
  status: Artifact["status"];
  path: string;
  createdAt: string;
  updatedAt: string;
}

export class ArtifactRepository {
  constructor(private readonly store: Store<Artifact>) {}

  async create(params: Omit<Artifact, "schemaVersion" | "createdAt" | "updatedAt" | "checksum" | "versions"> & Partial<Pick<Artifact, "checksum" | "versions">>): Promise<Artifact> {
    const now = new Date().toISOString();
    const artifact = ArtifactSchema.parse({ schemaVersion: 1, ...params, createdAt: now, updatedAt: now });
    await this.store.set(artifact.id, artifact);
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    const value = await this.store.get(id);
    return value ? ArtifactSchema.parse(value) : undefined;
  }

  async update(id: string, patch: Partial<Pick<Artifact, "name" | "path" | "version" | "status" | "checksum" | "versions">>): Promise<Artifact> {
    const current = await this.get(id);
    if (!current) throw new Error("artifact not found");
    const updated = ArtifactSchema.parse({ ...current, ...patch, updatedAt: new Date().toISOString() });
    await this.store.set(id, updated);
    return updated;
  }

  async list(workspaceId: string, projectId?: string | null): Promise<ArtifactSummary[]> {
    return (await this.store.entries())
      .map(([, value]) => ArtifactSchema.parse(value))
      .filter((artifact) => artifact.workspaceId === workspaceId && (projectId === undefined || artifact.projectId === projectId))
      .filter((artifact) => artifact.status !== "deleted")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        mediaType: artifact.mediaType,
        projectId: artifact.projectId,
        sessionId: artifact.sessionId,
        runId: artifact.runId,
        version: artifact.version,
        status: artifact.status,
        path: artifact.path,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      }));
  }

  async softDelete(id: string): Promise<Artifact | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    return await this.update(id, { status: "deleted" });
  }

  async createVersion(id: string, snapshot?: { content?: string; checksum?: string | null }): Promise<Artifact> {
    const current = await this.get(id);
    if (!current) throw new Error("artifact not found");
    const versions = [...current.versions, { version: current.version, path: current.path, checksum: current.checksum, ...(snapshot?.content !== undefined ? { content: snapshot.content } : {}), createdAt: current.updatedAt }];
    return await this.update(id, { version: current.version + 1, checksum: snapshot?.checksum ?? current.checksum, versions, status: "ready" });
  }
}
