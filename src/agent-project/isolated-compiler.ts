import { z } from "zod";
import type { Compilation } from "./compiler.js";
import { validateFiles, type ProjectFiles } from "./files.js";
import { runProgram } from "./sandbox.js";
const resultSchema = z.object({
  status: z.enum(["READY", "FAILED"]),
  diagnostics: z.array(z.string()).max(50),
  bundles: z.record(z.string(), z.string()),
  previewHtml: z.string(),
  manifest: z.unknown().optional(),
  evidence: z.object({
    typecheck: z.boolean(),
    compiled: z.boolean(),
    businessVerified: z.literal(false),
    compiler: z.string(),
  }),
});
/** Production compilation never runs project-controlled TypeScript or bundler workloads in the API process. */
export async function compileIsolatedProject(
  raw: ProjectFiles,
  signal?: AbortSignal,
): Promise<Compilation> {
  const files = validateFiles(raw);
  try {
    const result = resultSchema.parse(
      await runProgram('module.exports=require("/opt/poros/compile.cjs");', files, {
        signal,
        timeoutMs: 50000,
        image: process.env.POROS_COMPILER_IMAGE || "poros/compiler:1",
        environment: ["NODE_PATH=/opt/poros/node_modules"],
        outputLimitBytes: 16 * 1024 * 1024,
      }),
    );
    if (result.status === "READY" && (!result.evidence.typecheck || !result.evidence.compiled))
      throw new Error("编译器没有提供真实检查证据");
    return result as Compilation;
  } catch (error) {
    return {
      status: "FAILED",
      diagnostics: ["隔离编译失败：" + (error instanceof Error ? error.message : "编译环境不可用")],
      bundles: {},
      previewHtml: "",
      evidence: {
        typecheck: false,
        compiled: false,
        businessVerified: false,
        compiler: "isolated compiler v1",
      },
    };
  }
}
