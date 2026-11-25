import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../server/errors.js";
import { projectPath, type ProjectFiles } from "./files.js";
export const lockSchema = z
  .object({
    formatVersion: z.literal(1),
    packages: z
      .array(
        z.object({
          name: z.string(),
          kind: z.enum(["SKILL", "MCP"]),
          sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
          publisherFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
        }),
      )
      .max(20),
  })
  .strict();
export const fileHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function verifyCapabilityLock(files: ProjectFiles) {
  if (!files["poros.lock.json"]) return;
  const lock = lockSchema.parse(JSON.parse(files["poros.lock.json"]));
  for (const pkg of lock.packages)
    for (const [filename, hash] of Object.entries(pkg.files)) {
      projectPath(filename);
      if (files[filename] === undefined || fileHash(files[filename]) !== hash)
        throw new ApiError(
          409,
          "已绑定能力 " +
            pkg.name +
            " 的文件发生变化：" +
            filename +
            "。请显式派生新版本或重新导入。",
        );
    }
}
