import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../server/errors.js";
import { parseProject } from "../agent-project/contract.js";
import { sha256 } from "../agent-project/package.js";
import type { RuntimeActor, RuntimeStore } from "./store.js";
const token = () => randomBytes(32).toString("base64url");
interface Pairing {
  id: string;
  inviteHash: string;
  claimHash: string;
  name: string;
  grants: string[];
  expires: number;
  status: "PENDING" | "APPROVED";
  result?: string;
}
export class RuntimeAuth {
  private readonly bootstraps = new Map<string, number>();
  private readonly invites = new Map<
    string,
    { expires: number; grants: string[]; claimedBy?: string }
  >();
  private readonly pending = new Map<string, Pairing>();
  private readonly approvals = new Map<string, Promise<void>>();
  constructor(private readonly store: RuntimeStore) {}
  actor(request: Pick<FastifyRequest, "headers">, owner = false): RuntimeActor {
    const raw = String(request.headers.authorization || "").match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    const actor = raw
      ? this.store.snapshot().sessions.find((item) => item.hash === sha256(raw))
      : undefined;
    if (!actor || actor.revokedAt || Date.parse(actor.expiresAt) <= Date.now())
      throw new ApiError(401, "设备尚未配对或会话已撤销");
    if (request.headers["x-poros-remote"] === "1" && actor.role === "OWNER")
      throw new ApiError(403, "远程只接受经电脑确认的设备会话");
    if (owner && actor.role !== "OWNER") throw new ApiError(403, "此操作只允许安装端所有者");
    return actor;
  }
  private prune() {
    for (const [key, expires] of this.bootstraps)
      if (expires <= Date.now()) this.bootstraps.delete(key);
    for (const [key, invite] of this.invites)
      if (invite.expires <= Date.now()) this.invites.delete(key);
    for (const [key, pair] of this.pending)
      if (pair.expires <= Date.now()) this.pending.delete(key);
  }
  bootstrap() {
    this.prune();
    if (this.bootstraps.size > 10) throw new ApiError(429, "本地启动请求过多");
    const code = token();
    this.bootstraps.set(sha256(code), Date.now() + 90000);
    return code;
  }
  async exchange(code: string) {
    this.prune();
    const key = sha256(code),
      expires = this.bootstraps.get(key);
    if (!expires) throw new ApiError(403, "本地启动凭证已失效");
    this.bootstraps.delete(key);
    return this.createSession("OWNER", "安装端所有者", []);
  }
  private async createSession(role: RuntimeActor["role"], name: string, grants: string[]) {
    const raw = token();
    const session: RuntimeActor = {
      hash: sha256(raw),
      role,
      name,
      grants,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      revokedAt: null,
    };
    await this.store.change((next) => {
      next.sessions = [
        ...next.sessions
          .filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > Date.now())
          .slice(-99),
        session,
      ];
    });
    return raw;
  }
  invite(grants: string[]) {
    this.prune();
    if (this.invites.size >= 16) throw new ApiError(429, "待用配对码过多");
    const manifest = parseProject(this.store.package().payload.files),
      allowed = this.store.snapshot().settings.authorizedTools;
    if (grants.some((name) => !manifest.permissions.includes(name) || !allowed.includes(name)))
      throw new ApiError(403, "设备不能获得尚未授权的能力");
    const code = token();
    this.invites.set(sha256(code), { expires: Date.now() + 120000, grants });
    return { code, expiresIn: 120 };
  }
  claim(code: string, claimToken: string, name: string) {
    this.prune();
    const inviteHash = sha256(code),
      claimHash = sha256(claimToken);
    const existing = [...this.pending.values()].find(
      (pair) => pair.inviteHash === inviteHash && pair.claimHash === claimHash,
    );
    if (existing) return { id: existing.id, status: existing.status };
    const invite = this.invites.get(inviteHash);
    if (!invite) throw new ApiError(403, "配对码已失效");
    if (invite.claimedBy && invite.claimedBy !== claimHash)
      throw new ApiError(403, "配对码已有设备正在使用");
    if (this.pending.size >= 32) throw new ApiError(429, "待确认设备过多");
    invite.claimedBy = claimHash;
    const id = randomUUID();
    this.pending.set(id, {
      id,
      inviteHash,
      claimHash,
      name,
      grants: [...invite.grants],
      expires: Date.now() + 300000,
      status: "PENDING",
    });
    return { id, status: "PENDING" };
  }
  requests() {
    this.prune();
    return [...this.pending.values()].map(({ id, name, grants, status }) => ({
      id,
      name,
      grants,
      status,
    }));
  }
  async approve(id: string) {
    const inFlight = this.approvals.get(id);
    if (inFlight) return inFlight;
    this.prune();
    const pair = this.pending.get(id);
    if (!pair) throw new ApiError(404, "配对请求不存在");
    if (pair.status === "APPROVED") return;
    const allowed = this.store.snapshot().settings.authorizedTools;
    if (pair.grants.some((name) => !allowed.includes(name)))
      throw new ApiError(409, "权限配置已改变，请重新配对");
    const operation = this.createSession("DEVICE", pair.name, pair.grants)
      .then((result) => {
        pair.result = result;
        pair.status = "APPROVED";
        this.invites.delete(pair.inviteHash);
      })
      .finally(() => this.approvals.delete(id));
    this.approvals.set(id, operation);
    await operation;
  }
  result(id: string, claimToken: string) {
    this.prune();
    const pair = this.pending.get(id);
    if (!pair || pair.claimHash !== sha256(claimToken)) throw new ApiError(403, "配对回执无效");
    return { status: pair.status, ...(pair.status === "APPROVED" ? { token: pair.result } : {}) };
  }
}
