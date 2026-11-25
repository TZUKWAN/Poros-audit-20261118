import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stop } from "esbuild";
import { starterProject, parseProject } from "../../src/agent-project/contract.js";
import { compileProject } from "../../src/agent-project/compiler.js";
import { createPackage } from "../../src/agent-project/package.js";
import { buildRuntime } from "../../src/runtime/app.js";
afterAll(() => stop());
describe("independent Apps with real isolated code and HTTP fixture", () => {
  it("runs two Apps without the development DB, isolates credentials, pairs/revokes a real device session and never replays lost or archived receipts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "poros-runtime-app-")),
      keys = { A: randomUUID(), B: randomUUID() };
    const counts = { A: 0, B: 0 };
    let a: Awaited<ReturnType<typeof buildRuntime>> | undefined, b: typeof a;
    const previousDatabase = process.env.DATABASE_URL;
    const previousLocalApi = process.env.POROS_LOCAL_API_BASES;
    process.env.DATABASE_URL =
      "postgresql://unavailable:unused@127.0.0.1:1/no_development_database";
    const api = createServer((req, res) => {
      const tenant =
        req.headers["x-api-key"] === keys.A
          ? "A"
          : req.headers["x-api-key"] === keys.B
            ? "B"
            : null;
      if (!tenant) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      counts[tenant]++;
      const respond = () =>
        res.end(JSON.stringify({ tenant, marker: tenant === "A" ? "PRIVATE-A" : "PRIVATE-B" }));
      if (req.url === "/slow") {
        const timer = setTimeout(respond, 15000);
        res.once("close", () => clearTimeout(timer));
      } else respond();
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const baseUrl = "http://127.0.0.1:" + (api.address() as { port: number }).port;
    try {
      const privateKey = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const make = async (identity: string, extra = false) => {
        const files = starterProject("AGENT", "Independent " + identity),
          manifest = parseProject(files);
        manifest.permissions = ["api:business", ...(extra ? ["api:new-capability"] : [])];
        files["poros.json"] = JSON.stringify(manifest);
        files["private.txt"] = "PACKAGE-" + identity;
        files["agent.ts"] =
          'import {defineAgent} from "@poros/sdk";export default defineAgent(async(input,ctx)=>({value:Number(input)*3,source:await ctx.asset("private.txt"),remote:await ctx.http(input==="slow"?"business:/slow":"business:/identity")}));';
        const build = await compileProject(files);
        expect(build.status, build.diagnostics.join("\n")).toBe("READY");
        return createPackage({ appIdentity: identity, files, ...build, privateKey });
      };
      const pkgA = await make("A"),
        pkgB = await make("B");
      a = await buildRuntime({ directory: path.join(directory, "A"), package: pkgA });
      b = await buildRuntime({ directory: path.join(directory, "B"), package: pkgB });
      const owner = async (runtime: NonNullable<typeof a>) => {
        const code = runtime.bootstrap(),
          response = await runtime.app.inject({
            method: "POST",
            url: "/api/app/bootstrap",
            payload: { code },
          });
        expect(response.statusCode, response.body).toBe(200);
        expect(
          (
            await runtime.app.inject({
              method: "POST",
              url: "/api/app/bootstrap",
              payload: { code },
            })
          ).statusCode,
        ).toBe(403);
        return { authorization: "Bearer " + response.json().token };
      };
      let ownerA = await owner(a);
      const ownerB = await owner(b);
      expect(
        (await b.app.inject({ method: "GET", url: "/api/app/settings", headers: ownerA }))
          .statusCode,
      ).toBe(401);
      const configure = async (
        runtime: NonNullable<typeof a>,
        headers: Record<string, string>,
        key: string,
      ) => {
        expect(
          (
            await runtime.app.inject({
              method: "PUT",
              url: "/api/app/settings",
              headers,
              payload: { authorizedTools: ["api:business"] },
            })
          ).statusCode,
        ).toBe(200);
        const saved = await runtime.app.inject({
          method: "PUT",
          url: "/api/app/connections/api:business",
          headers,
          payload: {
            baseUrl,
            apiKey: key,
            authHeader: "X-API-Key",
            authPrefix: "",
            testPath: "/health",
          },
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.body).not.toContain(key);
        const tested = await runtime.app.inject({
          method: "POST",
          url: "/api/app/connections/api:business/test",
          headers,
        });
        expect(tested.json().passed, tested.body).toBe(true);
      };
      await configure(a, ownerA, keys.A);
      await configure(b, ownerB, keys.B);
      const wait = async (
        runtime: NonNullable<typeof a>,
        headers: Record<string, string>,
        id: string,
      ) => {
        for (let i = 0; i < 250; i++) {
          const response = await runtime.app.inject({
            method: "GET",
            url: "/api/app/jobs/" + id,
            headers,
          });
          expect(response.statusCode).toBe(200);
          if (response.json().job.status !== "RUNNING") return response.json().job;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        throw new Error("actual runtime did not finish");
      };
      const body = { input: { input: 7 }, consent: ["api:business"] },
        requestKey = randomUUID();
      const submitted = await a.app.inject({
        method: "POST",
        url: "/api/app/jobs",
        headers: { ...ownerA, "idempotency-key": requestKey },
        payload: body,
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const repeated = await a.app.inject({
        method: "POST",
        url: "/api/app/jobs",
        headers: { ...ownerA, "idempotency-key": requestKey },
        payload: body,
      });
      expect(repeated.json().job.id).toBe(submitted.json().job.id);
      const done = await wait(a, ownerA, submitted.json().job.id);
      expect(done.status, JSON.stringify(done.output)).toBe("SUCCEEDED");
      expect(done.output.result).toEqual({
        value: 21,
        source: "PACKAGE-A",
        remote: { tenant: "A", marker: "PRIVATE-A" },
      });
      expect(counts.A).toBe(1);
      const other = await b.app.inject({
        method: "POST",
        url: "/api/app/jobs",
        headers: { ...ownerB, "idempotency-key": randomUUID() },
        payload: body,
      });
      const finishedB = await wait(b, ownerB, other.json().job.id);
      expect(finishedB.output.result.remote).toEqual({ tenant: "B", marker: "PRIVATE-B" });
      expect(finishedB.output.result.source).toBe("PACKAGE-B");
      expect(counts.B).toBe(1);
      ownerA = await owner(a);
      expect(
        (
          await a.app.inject({
            method: "POST",
            url: "/api/app/jobs",
            headers: { ...ownerA, "idempotency-key": requestKey },
            payload: body,
          })
        ).json().job.id,
      ).toBe(done.id);
      expect(counts.A).toBe(1);
      const invite = await a.app.inject({
        method: "POST",
        url: "/api/app/pair/invites",
        headers: ownerA,
        payload: { grants: ["api:business"] },
      });
      expect(invite.statusCode).toBe(200);
      const claimToken = randomBytes(32).toString("base64url"),
        claimBody = { code: invite.json().code, claimToken, name: "Actual HTTP phone session" };
      const claim = await a.app.inject({
        method: "POST",
        url: "/api/app/pair/claim",
        payload: claimBody,
      });
      expect(claim.statusCode).toBe(200);
      expect(
        (
          await a.app.inject({ method: "POST", url: "/api/app/pair/claim", payload: claimBody })
        ).json().id,
      ).toBe(claim.json().id);
      const receipt = { id: claim.json().id, claimToken };
      expect(
        (
          await a.app.inject({ method: "POST", url: "/api/app/pair/result", payload: receipt })
        ).json().status,
      ).toBe("PENDING");
      await Promise.all([
        a.app.inject({
          method: "POST",
          url: "/api/app/pair/" + claim.json().id + "/approve",
          headers: ownerA,
        }),
        a.app.inject({
          method: "POST",
          url: "/api/app/pair/" + claim.json().id + "/approve",
          headers: ownerA,
        }),
      ]);
      const paired = await a.app.inject({
        method: "POST",
        url: "/api/app/pair/result",
        payload: receipt,
      });
      const phone = { authorization: "Bearer " + paired.json().token };
      expect(
        (await a.app.inject({ method: "GET", url: "/api/app/session", headers: phone })).json()
          .role,
      ).toBe("DEVICE");
      expect(
        (await a.app.inject({ method: "GET", url: "/api/app/settings", headers: phone }))
          .statusCode,
      ).toBe(403);
      expect(
        (await a.app.inject({ method: "GET", url: "/api/app/jobs/" + done.id, headers: phone }))
          .statusCode,
      ).toBe(404);
      const slow = await a.app.inject({
        method: "POST",
        url: "/api/app/jobs",
        headers: { ...phone, "idempotency-key": randomUUID() },
        payload: { input: { input: "slow" }, consent: ["api:business"] },
      });
      expect(slow.statusCode).toBe(202);
      for (let i = 0; i < 100 && counts.A < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 30));
      expect(counts.A).toBe(2);
      const devices = await a.app.inject({
        method: "GET",
        url: "/api/app/devices",
        headers: ownerA,
      });
      expect(devices.json().devices).toHaveLength(1);
      expect(
        (
          await a.app.inject({
            method: "DELETE",
            url: "/api/app/devices/" + devices.json().devices[0].id,
            headers: ownerA,
          })
        ).statusCode,
      ).toBe(200);
      expect((await wait(a, ownerA, slow.json().job.id)).status).toBe("CANCELLED");
      expect(
        (await a.app.inject({ method: "GET", url: "/api/app/session", headers: phone })).statusCode,
      ).toBe(401);
      await a.store.change((next) => {
        next.jobs = next.jobs.filter((job) => job.id !== done.id);
      });
      expect(
        (
          await a.app.inject({
            method: "POST",
            url: "/api/app/jobs",
            headers: { ...ownerA, "idempotency-key": requestKey },
            payload: body,
          })
        ).statusCode,
      ).toBe(410);
      expect(counts.A).toBe(2);
      const update = await make("A", true);
      expect(
        (
          await a.app.inject({
            method: "POST",
            url: "/api/app/update",
            headers: ownerA,
            payload: { package: update },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await a.app.inject({
            method: "POST",
            url: "/api/app/update",
            headers: ownerA,
            payload: { package: update, acceptPermissions: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(a.store.snapshot().settings.authorizedTools).toEqual(["api:business"]);
      expect(
        (
          await a.app.inject({
            method: "POST",
            url: "/api/app/update",
            headers: ownerA,
            payload: { package: pkgB },
          })
        ).statusCode,
      ).toBe(403);
      const stored = await readFile(path.join(directory, "A", "state.json"), "utf8");
      expect(stored).not.toContain(keys.A);
      expect(stored).not.toContain(keys.B);
      expect(stored).not.toContain(paired.json().token);
      await a.app.close();
      // A fresh installed process has none of the previous process's admitted
      // loopback bases. Saved owner configuration must work after reopening.
      delete process.env.POROS_LOCAL_API_BASES;
      a = await buildRuntime({ directory: path.join(directory, "A") });
      expect(a.store.package().payload.version).toBe(update.payload.version);
      expect(a.store.snapshot().credentials).toHaveLength(1);
      expect(a.store.snapshot().receipts).toHaveLength(2);
      const restoredConnection = await a.app.inject({
        method: "POST",
        url: "/api/app/connections/api:business/test",
        headers: ownerA,
      });
      expect(restoredConnection.json().passed, restoredConnection.body).toBe(true);
      const afterRestart = await a.app.inject({
        method: "POST",
        url: "/api/app/jobs",
        headers: { ...ownerA, "idempotency-key": randomUUID() },
        payload: body,
      });
      expect(afterRestart.statusCode, afterRestart.body).toBe(202);
      const restoredRun = await wait(a, ownerA, afterRestart.json().job.id);
      expect(restoredRun.status, JSON.stringify(restoredRun)).toBe("SUCCEEDED");
      expect(restoredRun.output.result.remote.marker).toBe("PRIVATE-A");
      expect(counts.A).toBe(3);
    } finally {
      await a?.app.close();
      await b?.app.close();
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      if (previousDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
      if (previousLocalApi === undefined) delete process.env.POROS_LOCAL_API_BASES;
      else process.env.POROS_LOCAL_API_BASES = previousLocalApi;
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
