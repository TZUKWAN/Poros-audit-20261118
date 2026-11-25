/** Explicit source fixtures for actual Windows installer acceptance. Not model/vendor acceptance. */
import { mkdir, writeFile } from "node:fs/promises";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { stop } from "esbuild";
import { starterProject } from "../../src/agent-project/contract.js";
import { compileProject } from "../../src/agent-project/compiler.js";
import { createPackage } from "../../src/agent-project/package.js";
const folder = process.env.POROS_WINDOWS_FIXTURES || ".audit/windows-fixtures";
await mkdir(folder, { recursive: true });
const privateKey = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
try {
  const identityA = randomUUID();
  for (const [label, name, expression, identity] of [
    ["A", "Poros 安装验收 A", "Number(input)*3", identityA],
    ["A-update", "Poros 安装验收 A", "Number(input)*4", identityA],
    ["B", "Poros 安装验收 B", "Number(input)+5", randomUUID()],
  ]) {
    const files = starterProject("AGENT", name!);
    files["agent.ts"] =
      'import {defineAgent} from "@poros/sdk";export default defineAgent(input=>' +
      expression +
      ");";
    const build = await compileProject(files);
    if (build.status !== "READY") throw new Error(build.diagnostics.join("\n"));
    const pkg = createPackage({ appIdentity: identity!, files, ...build, privateKey });
    await writeFile(folder + "/" + label + ".poros.json", JSON.stringify(pkg));
  }
} finally {
  stop();
}
