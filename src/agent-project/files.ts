import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { ApiError } from "../server/errors.js";

export type ProjectFiles = Record<string, string>;
export const MAX_PROJECT_BYTES = 2 * 1024 * 1024;

export function projectPath(input: string): string {
  if (
    !input ||
    input.length > 180 ||
    input.includes("\\") ||
    input.includes(":") ||
    input.startsWith("/") ||
    input
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\x00-\x1f<>"|?*]/.test(part) ||
          /^(?:\.env(?:\..*)?|\.git|node_modules|__proto__|con|prn|aux|nul|com\d|lpt\d)$/i.test(
            part,
          ) ||
          /[. ]$/.test(part),
      )
  )
    throw new ApiError(400, "工程路径不合法或包含受保护文件");
  return input;
}

export function validateFiles(raw: unknown): ProjectFiles {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ApiError(400, "工程文件必须为路径与文本的映射");
  const entries = Object.entries(raw);
  if (!entries.length || entries.length > 80) throw new ApiError(400, "工程需要1至80个文件");
  let bytes = 0;
  const lower = new Set<string>();
  for (const [name, content] of entries) {
    projectPath(name);
    if (lower.has(name.toLowerCase())) throw new ApiError(400, "工程路径大小写冲突");
    lower.add(name.toLowerCase());
    if (typeof content !== "string" || content.includes("\0"))
      throw new ApiError(400, "工程只接受文本文件");
    bytes += Buffer.byteLength(content);
  }
  if (bytes > MAX_PROJECT_BYTES) throw new ApiError(413, "工程文件超过2MiB");
  for (const [name] of entries)
    if (entries.some(([other]) => other !== name && other.startsWith(name + "/")))
      throw new ApiError(400, "文件与目录名称冲突");
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export const sourceDigest = (files: ProjectFiles): string =>
  createHash("sha256")
    .update(JSON.stringify(validateFiles(files)))
    .digest("hex");

export class ProjectStore {
  readonly root: string;
  constructor(root = process.env.POROS_WORKSPACE_ROOT || ".poros-workspaces") {
    this.root = path.resolve(root);
  }
  private async directory(workspaceId: string, digest: string) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(workspaceId) || !/^[a-f0-9]{64}$/.test(digest))
      throw new ApiError(400, "工程版本标识不合法");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new ApiError(409, "工程根目录不得为链接");
    const base = await realpath(this.root);
    const workspace = path.join(base, workspaceId);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    if ((await lstat(workspace)).isSymbolicLink()) throw new ApiError(409, "工程目录不得为链接");
    return path.join(workspace, digest);
  }
  async save(workspaceId: string, raw: ProjectFiles): Promise<string> {
    const files = validateFiles(raw),
      digest = sourceDigest(files);
    const target = await this.directory(workspaceId, digest);
    try {
      await lstat(target);
      await this.read(workspaceId, digest, Object.keys(files));
      return digest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pending = target + ".pending-" + randomUUID();
    await mkdir(pending, { mode: 0o700 });
    try {
      for (const [name, content] of Object.entries(files)) {
        const filename = path.join(pending, name);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, content, { flag: "wx", mode: 0o600 });
      }
      try {
        await rename(pending, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code || ""))
          throw error;
        await this.read(workspaceId, digest, Object.keys(files));
      }
    } finally {
      await rm(pending, { recursive: true, force: true });
    }
    return digest;
  }
  async read(workspaceId: string, digest: string, names: string[]): Promise<ProjectFiles> {
    const target = await this.directory(workspaceId, digest);
    const files: ProjectFiles = {};
    for (const name of names) {
      projectPath(name);
      let current = target;
      for (const segment of ["", ...name.split("/")]) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new ApiError(409, "工程包含链接");
      }
      files[name] = await readFile(path.join(target, name), "utf8");
    }
    if (sourceDigest(files) !== digest)
      throw new ApiError(409, "工程文件已在外部变更，请显式导入新版本");
    return files;
  }
}
