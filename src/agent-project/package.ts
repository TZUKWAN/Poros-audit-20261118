import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ApiError } from "../server/errors.js";
import { parseProject } from "./contract.js";
import { sourceDigest, validateFiles } from "./files.js";

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
};
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const payloadSchema = z
  .object({
    format: z.literal("poros-app/1"),
    appId: z.string().regex(/^poros\.[a-f0-9]{24}$/),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(120),
    kind: z.enum(["AGENT", "SKILL", "MCP"]),
    createdAt: z.string().datetime(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.record(z.string(), z.string()),
    build: z
      .object({
        bundles: z.record(z.string(), z.string()),
        previewHtml: z.string(),
        evidence: z.record(z.string(), z.unknown()),
      })
      .strict(),
    runtime: z
      .object({
        sdk: z.literal(1),
        node: z.literal(24),
        dsh: z.literal("0.2.2-rc.1"),
        mcpSdk: z.literal("1.32.2"),
      })
      .strict(),
    filesSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    verificationScope: z.literal("Recorded cases only; no supplier acceptance implied"),
  })
  .strict();
export type AppPayload = z.infer<typeof payloadSchema>;
export interface AppPackage {
  payload: AppPayload;
  publisher: string;
  signature: string;
}

export function createPackage(input: {
  appIdentity: string;
  files: Record<string, string>;
  bundles: Record<string, string>;
  previewHtml: string;
  evidence: Record<string, unknown>;
  privateKey: string;
  secrets?: string[];
}): AppPackage {
  const files = validateFiles(input.files),
    manifest = parseProject(files);
  const contents = [
    ...Object.values(files),
    ...Object.values(input.bundles),
    input.previewHtml,
    canonical(input.evidence),
  ];
  if (
    (input.secrets || []).some(
      (secret) =>
        secret.length >= 6 &&
        contents.some(
          (content) =>
            content.includes(secret) || content.includes(JSON.stringify(secret).slice(1, -1)),
        ),
    )
  )
    throw new ApiError(409, "工程包含已知连接凭证，请移除后重新构建");
  if (
    Object.values(files).some((source) =>
      /(?:api[_-]?key|authorization|access[_-]?token|password)["']?\s*[=:]\s*["'](?:Bearer\s+)?[^"'\s]{12,}["']/i.test(
        source,
      ),
    )
  )
    throw new ApiError(409, "发现疑似硬编码凭证，请检查源码后重新打包");
  const artifacts = { bundles: input.bundles, previewHtml: input.previewHtml };
  const artifactSha256 = sha256(canonical(artifacts));
  const payload: AppPayload = {
    format: "poros-app/1",
    appId: "poros." + sha256(input.appIdentity).slice(0, 24),
    version: sha256(canonical({ sourceDigest: sourceDigest(files), artifactSha256 })),
    name: manifest.name,
    kind: manifest.kind,
    createdAt: new Date().toISOString(),
    sourceDigest: sourceDigest(files),
    files,
    build: { ...artifacts, evidence: input.evidence },
    runtime: { sdk: 1, node: 24, dsh: "0.2.2-rc.1", mcpSdk: "1.32.2" },
    filesSha256: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, sha256(content)]),
    ),
    artifactSha256,
    verificationScope: "Recorded cases only; no supplier acceptance implied",
  };
  const key = createPrivateKey(input.privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Publisher key must be Ed25519");
  return {
    payload,
    publisher: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
    signature: sign(null, Buffer.from(canonical(payload)), key).toString("base64url"),
  };
}
export function verifyPackage(raw: unknown): AppPackage & { fingerprint: string } {
  const envelope = z
    .object({
      payload: payloadSchema,
      publisher: z.string().max(1000),
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict()
    .parse(raw);
  const files = validateFiles(envelope.payload.files),
    manifest = parseProject(files),
    key = createPublicKey(envelope.publisher);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(canonical(envelope.payload)),
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  )
    throw new ApiError(400, "软件包签名无效");
  if (
    sourceDigest(files) !== envelope.payload.sourceDigest ||
    manifest.name !== envelope.payload.name ||
    manifest.kind !== envelope.payload.kind ||
    canonical(
      Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
    ) !== canonical(envelope.payload.filesSha256)
  )
    throw new ApiError(400, "软件包源码校验失败");
  const hash = sha256(
    canonical({
      bundles: envelope.payload.build.bundles,
      previewHtml: envelope.payload.build.previewHtml,
    }),
  );
  if (
    hash !== envelope.payload.artifactSha256 ||
    sha256(canonical({ sourceDigest: envelope.payload.sourceDigest, artifactSha256: hash })) !==
      envelope.payload.version
  )
    throw new ApiError(400, "软件包构建校验失败");
  return { ...envelope, fingerprint: sha256(key.export({ type: "spki", format: "der" })) };
}
export async function publisherKey(
  directory = process.env.POROS_RELEASE_ROOT || path.resolve(".poros-releases"),
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Publisher directory must not be a symlink");
  const file = path.join(directory, "publisher.pem");
  try {
    const generated = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    await writeFile(file, generated, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await lstat(file)).isSymbolicLink()) throw new Error("Publisher key must not be a symlink");
  return readFile(file, "utf8");
}
