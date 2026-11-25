import { ApiError } from "../server/errors.js";
import { parseProject } from "./contract.js";
import { validateFiles, type ProjectFiles } from "./files.js";
import { fileHash, lockSchema } from "./lock.js";
import { verifyPackage } from "./package.js";

/** Copy immutable capability source; never carry credentials or silently grant imported permissions. */
export function assembleCapability(target: ProjectFiles, raw: unknown) {
  const pkg = verifyPackage(raw),
    source = pkg.payload.files;
  if (pkg.payload.kind === "AGENT") throw new ApiError(400, "请选择 Skill 或 MCP 能力包");
  const manifest = parseProject(target),
    incoming = parseProject(source);
  if (manifest.kind !== "AGENT") throw new ApiError(400, "请在 Agent 工程中装配能力");
  const files = { ...target },
    hashes: Record<string, string> = {};
  for (const [name, text] of Object.entries(source)) {
    if (["poros.json", "poros.lock.json", "README.md"].includes(name)) {
      if (
        name === "README.md" &&
        Object.values(source).some((content) => content !== text && content.includes("README.md"))
      )
        throw new ApiError(409, "能力引用根 README.md，请先改为技能目录内的参考文件");
      continue;
    }
    if (files[name] !== undefined && files[name] !== text)
      throw new ApiError(409, "能力文件与工程冲突：" + name + "，请先为能力使用独立目录");
    files[name] = text;
    hashes[name] = fileHash(text);
  }
  const servers = [...incoming.mcp];
  if (incoming.kind === "MCP")
    servers.unshift({ name: "mcp-" + pkg.payload.sourceDigest.slice(0, 8), entry: incoming.entry });
  for (const server of servers) {
    const existing = manifest.mcp.find((item) => item.name === server.name);
    if (existing && existing.entry !== server.entry)
      throw new ApiError(409, "MCP 名称冲突：" + server.name);
    if (!existing) manifest.mcp.push(server);
  }
  manifest.skills = [...new Set([...manifest.skills, ...incoming.skills])];
  manifest.permissions = [...new Set([...manifest.permissions, ...incoming.permissions])];
  const lock = files["poros.lock.json"]
    ? lockSchema.parse(JSON.parse(files["poros.lock.json"]))
    : { formatVersion: 1 as const, packages: [] };
  if (!lock.packages.some((item) => item.sourceDigest === pkg.payload.sourceDigest))
    lock.packages.push({
      name: incoming.name,
      kind: pkg.payload.kind,
      sourceDigest: pkg.payload.sourceDigest,
      publisherFingerprint: pkg.fingerprint,
      files: hashes,
    });
  files["poros.json"] = JSON.stringify(manifest, null, 2) + "\n";
  files["poros.lock.json"] = JSON.stringify(lock, null, 2) + "\n";
  validateFiles(files);
  parseProject(files);
  return {
    files,
    package: {
      name: incoming.name,
      fingerprint: pkg.fingerprint,
      sourceDigest: pkg.payload.sourceDigest,
    },
  };
}
