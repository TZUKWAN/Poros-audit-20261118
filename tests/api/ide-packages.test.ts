import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { stop } from "esbuild";
import { compileProject } from "../../src/agent-project/compiler.js";
import { parseProject, starterProject } from "../../src/agent-project/contract.js";
import { assembleCapability } from "../../src/agent-project/assembly.js";
import { createPackage, verifyPackage } from "../../src/agent-project/package.js";
afterAll(() => stop());
describe("immutable signed engineering packages", () => {
  it("exports actual compiled source, verifies publisher and rejects tampering or credentials", async () => {
    const files = starterProject("SKILL", "Reusable skill"),
      build = await compileProject(files);
    expect(build.status, build.diagnostics.join("\n")).toBe("READY");
    const privateKey = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const input = { appIdentity: "actual-workspace", files, ...build, privateKey };
    const pkg = createPackage(input),
      checked = verifyPackage(pkg);
    expect(checked.payload.build.bundles).toHaveProperty("agent");
    expect(checked.payload.files).toEqual(files);
    expect(checked.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const tampered = structuredClone(pkg);
    tampered.payload.files["README.md"] += "changed";
    expect(() => verifyPackage(tampered)).toThrow("签名");
    expect(() =>
      createPackage({
        ...input,
        files: { ...files, "private.txt": "ACTUAL-PRIVATE-TEST-KEY" },
        secrets: ["ACTUAL-PRIVATE-TEST-KEY"],
      }),
    ).toThrow("凭证");
    expect(() =>
      createPackage({
        ...input,
        evidence: { cases: [{ output: { echoedCredential: "ACTUAL-PRIVATE-TEST-KEY" } }] },
        secrets: ["ACTUAL-PRIVATE-TEST-KEY"],
      }),
    ).toThrow("凭证");
    expect(() =>
      createPackage({
        ...input,
        files: { ...files, "unsafe.ts": 'const apiKey="never-hardcode-credential-123";' },
      }),
    ).toThrow("凭证");
  });
  it("pins imported Skill and MCP source, refuses collision or silent changes, and never grants permissions", async () => {
    const privateKey = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    let agent = starterProject("AGENT", "Assembly");
    for (const kind of ["SKILL", "MCP"] as const) {
      const files = starterProject(kind, kind + " reusable"),
        manifest = parseProject(files);
      manifest.permissions = ["api:helpdesk"];
      files["poros.json"] = JSON.stringify(manifest);
      const build = await compileProject(files);
      expect(build.status, build.diagnostics.join("\n")).toBe("READY");
      const pkg = createPackage({ appIdentity: kind, files, ...build, privateKey });
      agent = assembleCapability(agent, pkg).files;
    }
    expect(parseProject(agent).skills).toContain("skills/custom-skill");
    expect(parseProject(agent).mcp).toHaveLength(1);
    expect(parseProject(agent).permissions).toEqual(["api:helpdesk"]);
    expect(agent["poros.lock.json"]).toContain("publisherFingerprint");
    const changed = {
      ...agent,
      "skills/custom-skill/SKILL.md": agent["skills/custom-skill/SKILL.md"] + "\nunaudited change",
    };
    expect(() => parseProject(changed)).toThrow("已绑定能力");
    const result = await compileProject(changed);
    expect(result.status).toBe("FAILED");
    expect(result.diagnostics.join("\n")).toContain("发生变化");
    expect(Object.keys(agent).some((key) => /settings|credential|\.env/.test(key))).toBe(false);
  });
});
