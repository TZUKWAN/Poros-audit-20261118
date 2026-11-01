import { describe, expect, it } from "vitest";
import { jsonStore } from "@/core/store";
import { ProjectFileSchema } from "@/product/repository";
import { ProjectSchema, WorkspaceSchema } from "@/product/contracts";
import { WorkspaceRepository } from "@/product/repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("工作区和项目仓库", () => {
  it("创建工作区、项目和文件并可切换读取", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "product-"));
    try {
      const repo = new WorkspaceRepository(
        jsonStore({ filePath: path.join(dir, "workspaces.json"), schema: WorkspaceSchema }),
        jsonStore({ filePath: path.join(dir, "projects.json"), schema: ProjectSchema }),
        jsonStore({ filePath: path.join(dir, "files.json"), schema: ProjectFileSchema }),
      );
      const workspace = await repo.getDefaultWorkspace();
      const project = await repo.createProject(workspace.id, "研究项目", "项目说明");
      const file = await repo.addFile({ workspaceId: workspace.id, projectId: project.id, name: "notes.md", path: "notes.md", mediaType: "text/markdown", size: 12 });
      expect((await repo.listProjects(workspace.id)).map((item) => item.id)).toContain(project.id);
      expect((await repo.listFiles(project.id))[0]).toMatchObject({ id: file.id, indexed: false });
      await repo.archiveProject(project.id);
      expect((await repo.getProject(project.id))?.status).toBe("archived");
      await repo.restoreProject(project.id);
      expect((await repo.getProject(project.id))?.status).toBe("active");
      expect(await repo.deleteProject(project.id)).toBe(true);
      expect((await repo.getProject(project.id))?.status).toBe("deleted");
      expect(await repo.listFiles(project.id)).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
