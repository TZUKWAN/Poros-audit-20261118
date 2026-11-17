import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run sbom to use the active npm toolchain");
const data = JSON.parse(
  execFileSync(process.execPath, [npm, "sbom", "--sbom-format", "cyclonedx"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }),
);
if (!Array.isArray(data.components) || !data.components.length)
  throw new Error("SBOM contains no actual dependencies");
await writeFile("docs/sbom.cdx.json", JSON.stringify(data, null, 2) + "\n");
console.log(`SBOM written: ${data.components.length} components (including development tooling)`);
