import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
await mkdir(".app-runtime", { recursive: true });
const result = await build({
  entryPoints: ["src/runtime/cli.ts"],
  outfile: ".app-runtime/runtime.mjs",
  bundle: true,
  metafile: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import {createRequire as __porosRequire} from "node:module"; import {fileURLToPath as __porosFileURL} from "node:url"; import {dirname as __porosDirectory} from "node:path"; const require=__porosRequire(import.meta.url), __filename=__porosFileURL(import.meta.url), __dirname=__porosDirectory(__filename);',
  },
  logLevel: "info",
});
await cp("src/server/public", ".app-runtime/public", {
  recursive: true,
  filter: (source) => path.basename(source) !== "legacy.html",
});
await unlink(".app-runtime/public/legacy.html").catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
const packages = new Map();
async function record(directory) {
  while (directory.includes("node_modules")) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (pkg.name && pkg.version) {
        packages.set(directory, pkg);
        return;
      }
    } catch {
      /* Some bundled files live below an intermediate module directory. */
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
for (const input of Object.keys(result.metafile.inputs))
  if (input.replaceAll("\\", "/").includes("node_modules/"))
    await record(path.dirname(path.resolve(input)));
const frontend = new Set(),
  seen = new Set();
async function frontendPackage(name, from = path.resolve(".")) {
  const marker = from + ":" + name;
  if (seen.has(marker)) return;
  seen.add(marker);
  let parent = from,
    directory;
  for (;;) {
    const candidate = path.join(parent, "node_modules", name);
    try {
      const pkg = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
      directory = candidate;
      packages.set(candidate, pkg);
      frontend.add(pkg.name);
      for (const dependency of Object.keys(pkg.dependencies || {}))
        await frontendPackage(dependency, candidate);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (!directory) throw new Error("Missing UI license metadata: " + name);
}
for (const name of ["react", "react-dom", "@radix-ui/react-dialog", "@radix-ui/react-tabs"])
  await frontendPackage(name);
const notices = [
  "# Third-party components",
  "These are the installed packages used by the bundled runtime or the shared React interface. Declared licenses and distributed license files follow. Poros itself remains UNLICENSED.",
  "",
];
const components = [];
for (const [directory, pkg] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const files = (await readdir(directory)).filter((name) =>
    /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name),
  );
  const license = typeof pkg.license === "string" ? pkg.license : "See package distribution";
  notices.push("## " + pkg.name + " " + pkg.version, "Declared license: " + license, "");
  for (const name of files) {
    try {
      notices.push("### " + name, "", await readFile(path.join(directory, name), "utf8"), "");
    } catch (error) {
      if (error.code !== "EISDIR") throw error;
    }
  }
  components.push({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    licenses: [{ license: { name: license } }],
    properties: [
      { name: "poros:component-scope", value: frontend.has(pkg.name) ? "shared-ui" : "runtime" },
    ],
  });
}
await writeFile(".app-runtime/THIRD_PARTY_NOTICES.md", notices.join("\n"));
await writeFile(
  ".app-runtime/sbom.cdx.json",
  JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components }, null, 2),
);
console.log(
  "Runtime artifact includes license records for " +
    components.length +
    " actual installed components.",
);
