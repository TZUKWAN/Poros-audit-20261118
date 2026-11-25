import { afterAll, describe, expect, it } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stop } from "esbuild";
import type { IntegrationConnection } from "@prisma/client";
import { compileProject } from "../../src/agent-project/compiler.js";
import { starterProject } from "../../src/agent-project/contract.js";
import { createPackage } from "../../src/agent-project/package.js";
import { RuntimeStore } from "../../src/runtime/store.js";
import {
  connectionSecret,
  sealConnectionSecret,
} from "../../src/server/integration-connections.js";
afterAll(() => stop());
describe("independent installation storage", () => {
  it("keeps two Apps and keys separate, refuses a second process, recovers interrupted work without replay, and serializes atomic writes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "poros-runtime-store-"));
    let a: RuntimeStore | undefined, b: RuntimeStore | undefined;
    try {
      const files = starterProject("SKILL", "Independent actual source"),
        build = await compileProject(files);
      expect(build.status).toBe("READY");
      const privateKey = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const first = createPackage({ appIdentity: "A", files, ...build, privateKey }),
        second = createPackage({ appIdentity: "B", files, ...build, privateKey });
      a = await RuntimeStore.open(path.join(directory, "A"), first);
      b = await RuntimeStore.open(path.join(directory, "B"), second);
      expect(a.key.equals(b.key)).toBe(false);
      await expect(RuntimeStore.open(path.join(directory, "A"), first)).rejects.toThrow(
        "already running",
      );
      await Promise.all([
        a.change((next) => {
          next.settings.authorizedTools.push("first");
        }),
        a.change((next) => {
          next.settings.authorizedTools.push("second");
        }),
      ]);
      expect(a.snapshot().settings.authorizedTools).toEqual(["first", "second"]);
      expect(b.snapshot().settings.authorizedTools).toEqual([]);
      const row: IntegrationConnection = {
        organizationId: first.payload.appId,
        userId: "installation",
        provider: "model",
        revision: randomUUID(),
        settings: {},
        encryptedKey: "",
        testedAt: null,
        testCode: null,
        updatedAt: new Date(),
      };
      row.encryptedKey = sealConnectionSecret(row, { apiKey: "ACTUAL-LOCAL-PRIVATE-KEY" }, a.key);
      expect(connectionSecret(row, a.key).apiKey).toBe("ACTUAL-LOCAL-PRIVATE-KEY");
      expect(() => connectionSecret(row, b!.key)).toThrow();
      await a.change((next) => {
        next.jobs.push({
          id: "interrupted",
          actorHash: "a",
          requestKey: "same-request",
          requestHash: "hash",
          version: first.payload.version,
          kind: "RUN",
          input: "original",
          consent: [],
          status: "RUNNING",
          output: null,
          events: [],
          usage: {},
          createdAt: new Date().toISOString(),
        });
      });
      await a.close();
      a = await RuntimeStore.open(path.join(directory, "A"));
      expect(a.snapshot().jobs[0]).toMatchObject({
        status: "INTERRUPTED",
        requestKey: "same-request",
        output: { error: "运行端重启，未自动重放操作" },
      });
      expect(
        JSON.parse(await readFile(path.join(directory, "A", "state.json"), "utf8")).settings
          .authorizedTools,
      ).toEqual(["first", "second"]);
      await a.close();
      a = undefined;
      await expect(RuntimeStore.open(path.join(directory, "A"), second)).rejects.toThrow(
        "another App",
      );
    } finally {
      await a?.close();
      await b?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
