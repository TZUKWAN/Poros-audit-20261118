import { z } from "zod";
import { planSync, type SyncEntity, type SyncPlan } from "./sync.js";

export const RemoteSyncEnvelopeSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string().min(1), revision: z.string().min(1), entities: z.array(z.object({ id: z.string().min(1), updatedAt: z.string().datetime({ offset: true }), type: z.string().min(1), data: z.unknown() })) });
export type RemoteSyncEnvelope = z.infer<typeof RemoteSyncEnvelopeSchema>;

export interface SyncClientConfig { endpoint: string; workspaceId: string; token?: string; timeoutMs?: number; fetchImpl?: typeof fetch; }

export class WorkspaceSyncClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly config: SyncClientConfig) { this.fetchImpl = config.fetchImpl ?? fetch; }

  async pull(): Promise<RemoteSyncEnvelope> {
    const response = await this.fetchImpl(`${this.config.endpoint.replace(/\/$/, "")}/workspaces/${encodeURIComponent(this.config.workspaceId)}`, { headers: this.headers(), signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000) });
    if (!response.ok) throw new Error(`sync pull HTTP ${response.status}`);
    return RemoteSyncEnvelopeSchema.parse(await response.json());
  }

  async push(envelope: RemoteSyncEnvelope): Promise<RemoteSyncEnvelope> {
    const response = await this.fetchImpl(`${this.config.endpoint.replace(/\/$/, "")}/workspaces/${encodeURIComponent(this.config.workspaceId)}/sync`, { method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000) });
    if (!response.ok) throw new Error(`sync push HTTP ${response.status}`);
    return RemoteSyncEnvelopeSchema.parse(await response.json());
  }

  static plan(local: SyncEntity[], remote: RemoteSyncEnvelope, base: SyncEntity[] = []): SyncPlan { return planSync(local, remote.entities, base); }

  private headers(): Record<string, string> { return this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}; }
}

