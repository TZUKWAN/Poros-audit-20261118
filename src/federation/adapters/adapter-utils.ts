import { HostExecutionSpecSchema } from "../types.js";
import type { Capability, HostExecutionSpecInput } from "../types.js";
import { computeTrust } from "../trust.js";
import { canonicalName, repoIdentity } from "../types.js";
import { fetchJson, httpFetch, makeStatus } from "./base.js";
import type { AdapterResult, CapabilityAdapter, CapabilityQuery } from "../types.js";

export { canonicalName, repoIdentity, fetchJson, httpFetch, makeStatus };
export type { AdapterResult, CapabilityAdapter, CapabilityQuery };

/** github.com/owner/repo → raw 内容（main/master 依次尝试） */
export async function fetchRawGithub(repo: string, path: string, branch = "main", timeoutMs = 15_000): Promise<string | undefined> {
  const branches = branch === "main" ? ["main", "master"] : [branch, "main", "master"];
  for (const b of branches) {
    const url = `https://raw.githubusercontent.com/${repo}/${b}/${path}`;
    const resp = await httpFetch(url, { signal: AbortSignal.timeout(timeoutMs), retries: 1, headers: { accept: "text/plain" } });
    if (resp.ok) return await resp.text();
  }
  return undefined;
}

export function buildCapability(input: {
  id: string;
  name: string;
  kind: Capability["kind"];
  description: string;
  source: Capability["source"];
  install: Capability["install"];
  hostExecution?: HostExecutionSpecInput;
  remoteRun?: Capability["remoteRun"];
  repoUrl?: string;
  homepage?: string;
  tags?: string[];
  updatedAt?: string;
  stars?: number;
  downloads?: number;
  requiresAuth?: boolean;
  securityFlagged?: boolean;
}): Capability {
  // External catalogs frequently encode missing optional fields as `null`.
  // Keep the internal contract JSON-safe: zod's optional fields accept
  // `undefined`, not `null`, and persisted build contexts validate candidates
  // again when the panel advances to the next gate.
  const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
  const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const cap: Omit<Capability, "trust"> = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    description: input.description,
    source: input.source,
    install: input.install,
    hostExecution: input.hostExecution ? HostExecutionSpecSchema.parse(input.hostExecution) : undefined,
    remoteRun: input.remoteRun,
    repoUrl: optionalString(input.repoUrl),
    homepage: optionalString(input.homepage),
    tags: input.tags ?? [],
    updatedAt: optionalString(input.updatedAt),
    stars: optionalNumber(input.stars),
    downloads: optionalNumber(input.downloads),
    requiresAuth: input.requiresAuth ?? false,
    securityFlagged: input.securityFlagged ?? false,
  };
  return { ...cap, trust: computeTrust(cap) };
}
