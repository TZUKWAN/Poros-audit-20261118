import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename, unlink, lstat, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { verifyPackage, type AppPackage } from "../agent-project/package.js";

const credential = z
  .object({
    provider: z.string(),
    organizationId: z.string(),
    userId: z.string(),
    revision: z.string(),
    encryptedKey: z.string(),
    settings: z.record(z.string(), z.unknown()),
    testedAt: z.string().nullable(),
    testCode: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();
const session = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string(),
    role: z.enum(["OWNER", "DEVICE"]),
    grants: z.array(z.string()),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .strict();
const job = z
  .object({
    id: z.string(),
    actorHash: z.string(),
    requestKey: z.string(),
    requestHash: z.string(),
    version: z.string(),
    kind: z.enum(["RUN", "TEST", "MCP_TEST", "SKILL_TEST"]),
    input: z.unknown(),
    consent: z.array(z.string()),
    status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]),
    output: z.unknown(),
    events: z.array(
      z.object({ seq: z.number(), type: z.string(), data: z.unknown(), at: z.string() }),
    ),
    usage: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .strict();
const stateSchema = z
  .object({
    formatVersion: z.literal(1),
    appId: z.string(),
    package: z.unknown(),
    history: z.array(z.unknown()).max(3),
    credentials: z.array(credential),
    sessions: z.array(session),
    jobs: z.array(job).max(100),
    receipts: z
      .array(
        z
          .object({
            identity: z.string(),
            requestKey: z.string(),
            requestHash: z.string(),
            jobId: z.string(),
            version: z.string(),
          })
          .strict(),
      )
      .max(50000)
      .default([]),
    settings: z
      .object({
        authorizedTools: z.array(z.string()).max(40),
        enabledSkills: z.array(z.string()).max(12).optional(),
      })
      .strict(),
  })
  .strict();
export type RuntimeState = z.infer<typeof stateSchema>;
export type RuntimeJob = RuntimeState["jobs"][number];
export type RuntimeActor = RuntimeState["sessions"][number];
export type RuntimeCredential = RuntimeState["credentials"][number];
async function ordinaryFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Runtime file must be an ordinary file: " + path.basename(file));
}
/** One process per installation. Atomic snapshots are independent of the IDE's database and credentials. */
export class RuntimeStore {
  private state: RuntimeState;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  readonly instance = randomUUID();
  private constructor(
    readonly directory: string,
    readonly key: Buffer,
    state: RuntimeState,
  ) {
    this.state = state;
  }
  static async open(directory: string, initialPackage?: AppPackage): Promise<RuntimeStore> {
    const resolved = path.resolve(directory);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Installation directory must not be a symlink");
    const stateFile = path.join(resolved, "state.json"),
      keyFile = path.join(resolved, "settings.key");
    let state: RuntimeState | undefined;
    try {
      await ordinaryFile(stateFile);
      state = stateSchema.parse(JSON.parse(await readFile(stateFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pkg = verifyPackage(state ? state.package : initialPackage);
    if (state && state.appId !== pkg.payload.appId)
      throw new Error("Installation identity does not match its package");
    if (
      state &&
      initialPackage &&
      (verifyPackage(initialPackage).payload.appId !== state.appId ||
        verifyPackage(initialPackage).fingerprint !== pkg.fingerprint)
    )
      throw new Error("Existing installation belongs to another App or publisher");
    let key: Buffer;
    try {
      await ordinaryFile(keyFile);
      key = await readFile(keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || state)
        throw new Error("Installation key is unavailable; existing credentials were not reset");
      key = randomBytes(32);
      const handle = await open(keyFile, "wx", 0o600);
      try {
        await handle.writeFile(key);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (key.length !== 32) throw new Error("Invalid installation key");
    const envelope = { payload: pkg.payload, publisher: pkg.publisher, signature: pkg.signature };
    const store = new RuntimeStore(
      resolved,
      key,
      state || {
        formatVersion: 1,
        appId: pkg.payload.appId,
        package: envelope,
        history: [],
        credentials: [],
        sessions: [],
        jobs: [],
        receipts: [],
        settings: { authorizedTools: [] },
      },
    );
    const lockDirectory = path.join(resolved, "runtime.lock"),
      ownFile = path.join(lockDirectory, store.instance + ".json");
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await lstat(lockDirectory);
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink())
        throw new Error("Invalid installation lock");
      const entries = await readdir(lockDirectory);
      if (entries.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(entries[0]!))
        throw new Error("Installation lock is being initialized or needs inspection");
      const oldFile = path.join(lockDirectory, entries[0]!);
      await ordinaryFile(oldFile);
      const lock = z
        .object({ pid: z.number().int().positive(), instance: z.string() })
        .parse(JSON.parse(await readFile(oldFile, "utf8")));
      if (entries[0] !== lock.instance + ".json") throw new Error("Invalid lock identity");
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("This installation is already running");
      // Remove the exact old owner's file before the empty directory. A concurrent new owner cannot be removed.
      await unlink(oldFile);
      await rmdir(lockDirectory);
      await mkdir(lockDirectory, { mode: 0o700 });
    }
    const lockHandle = await open(ownFile, "wx", 0o600);
    try {
      await lockHandle.writeFile(JSON.stringify({ pid: process.pid, instance: store.instance }));
    } finally {
      await lockHandle.close();
    }
    try {
      await store.change((next) => {
        for (const entry of next.jobs)
          if (entry.status === "RUNNING") {
            entry.status = "INTERRUPTED";
            entry.output = { error: "运行端重启，未自动重放操作" };
          }
      });
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  snapshot() {
    return structuredClone(this.state);
  }
  package() {
    return verifyPackage(this.state.package);
  }
  async change<T>(update: (next: RuntimeState) => T): Promise<T> {
    if (this.closed) throw new Error("Installation storage is closed");
    const operation = this.serial.then(async () => {
      const next = structuredClone(this.state),
        result = update(next);
      stateSchema.parse(next);
      const temporary = path.join(this.directory, ".state-" + randomUUID() + ".pending"),
        target = path.join(this.directory, "state.json");
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      this.state = next;
      return result;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.serial;
    const directory = path.join(this.directory, "runtime.lock"),
      file = path.join(directory, this.instance + ".json");
    try {
      await ordinaryFile(file);
      const current = JSON.parse(await readFile(file, "utf8")) as { instance?: string };
      if (current.instance === this.instance) {
        await unlink(file);
        await rmdir(directory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
