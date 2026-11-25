import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IdeBuild, PrismaClient } from "@prisma/client";
import type { Principal } from "../auth.js";
import { mkdir, writeFile, lstat, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPackage, publisherKey } from "../../agent-project/package.js";
import { connectionSecret } from "../integration-connections.js";
import { ApiError } from "../errors.js";
import { revisionFiles } from "./repository.js";
export const releaseRoot = () => path.resolve(process.env.POROS_RELEASE_ROOT || ".poros-releases");
export async function workspacePackage(
  db: PrismaClient,
  p: Principal,
  workspaceId: string,
  build: IdeBuild,
  includeMaterials: boolean,
) {
  const files = await revisionFiles(db, workspaceId, build.sourceDigest);
  if (!includeMaterials && Object.keys(files).some((name) => name.startsWith("materials/")))
    throw new ApiError(409, "工程含用户材料，请检查并明确选择随包交付，或移除后重新构建");
  const rows = await db.integrationConnection.findMany({
    where: { organizationId: p.organizationId, userId: p.userId },
  });
  const secrets = rows.flatMap((row) => {
    const value = connectionSecret(row);
    return [value.apiKey, value.clientId || ""];
  });
  return createPackage({
    appIdentity: workspaceId,
    files,
    bundles: build.bundles as Record<string, string>,
    previewHtml: build.previewHtml,
    evidence: build.evidence as Record<string, unknown>,
    privateKey: await publisherKey(),
    secrets,
  });
}
export async function desktopAvailable() {
  return (
    process.platform === "win32" &&
    (await Promise.all(
      [
        ".app-runtime/runtime.mjs",
        "desktop/node_modules/electron/dist/electron.exe",
        "desktop/node_modules/electron-builder/out/cli/cli.js",
      ].map((file) =>
        access(path.resolve(file)).then(
          () => true,
          () => false,
        ),
      ),
    ).then((items) => items.every(Boolean)))
  );
}
export function installerDirectory(workspaceId: string, jobId: string) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{1,120}$/.test(jobId))
    throw new Error("Invalid installer identity");
  return path.join(releaseRoot(), "installers", workspaceId, jobId);
}
export async function packageDesktop(
  db: PrismaClient,
  p: Principal,
  workspaceId: string,
  jobId: string,
  build: IdeBuild,
  includeMaterials: boolean,
  signal: AbortSignal,
) {
  if (!(await desktopAvailable()))
    throw new ApiError(
      409,
      "当前服务未准备 Windows 构建器；可先导出工程包，再在 Windows 构建环境生成安装器",
    );
  const pkg = await workspacePackage(db, p, workspaceId, build, includeMaterials),
    directory = installerDirectory(workspaceId, jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Installer directory cannot be a symlink");
  const file = path.join(directory, "agent.poros.json");
  await writeFile(file, JSON.stringify(pkg), { mode: 0o600 });
  const builder = (await import(pathToFileURL(path.resolve("scripts/build-desktop.mjs")).href)) as {
    buildDesktopPackage: (options: {
      packageFile: string;
      outputDirectory: string;
      signal: AbortSignal;
    }) => Promise<{
      installer: string;
      sha256: string;
      bytes: number;
      windowsSignatureStatus: string;
    }>;
  };
  const result = await builder.buildDesktopPackage({
    packageFile: file,
    outputDirectory: directory,
    signal,
  });
  signal.throwIfAborted();
  return {
    installer: {
      filename: path.basename(result.installer),
      relativePath: path.relative(directory, result.installer),
      sha256: result.sha256,
      bytes: result.bytes,
      windowsSignatureStatus: result.windowsSignatureStatus,
      appId: pkg.payload.appId,
      version: pkg.payload.version,
    },
    buildId: build.id,
  };
}
export async function installerFile(workspaceId: string, jobId: string, raw: unknown) {
  const value = raw as {
      installer?: { relativePath?: string; filename?: string; sha256?: string; bytes?: number };
    },
    item = value?.installer;
  if (
    !item ||
    !item.relativePath ||
    !item.filename ||
    !/^poros\.[a-f0-9]{24}-Setup-1\.0\.0\.exe$/.test(item.filename)
  )
    throw new ApiError(404, "安装产物不存在");
  const directory = installerDirectory(workspaceId, jobId),
    file = path.resolve(directory, item.relativePath);
  if (!file.startsWith(directory + path.sep)) throw new Error("Invalid installer path");
  let parent = path.dirname(file);
  while (parent.length >= directory.length) {
    if ((await lstat(parent)).isSymbolicLink())
      throw new Error("Installer path must not use links");
    if (parent === directory) break;
    parent = path.dirname(parent);
  }
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink() || details.size !== item.bytes)
    throw new ApiError(409, "安装产物已变更，请重新构建");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== item.sha256) throw new ApiError(409, "安装文件摘要不匹配，请重新构建");
  return { file, ...item };
}
