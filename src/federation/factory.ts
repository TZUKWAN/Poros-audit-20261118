import { FederatedSearch, fileRegistryCache } from "./search.js";
import { mcpSoAdapter } from "./adapters/mcp-so.js";
import { officialServersAdapter } from "./adapters/official-servers.js";
import { modelscopeAdapter } from "./adapters/modelscope.js";
import { clineAdapter } from "./adapters/cline-marketplace.js";
import { awesomeAdapter } from "./adapters/awesome-mcp.js";
import { skillsShAdapter, skillsMpAdapter, skillHubAdapter } from "./adapters/skill-sources.js";
import path from "node:path";
import { scenarioDataRoot } from "@/core/store.js";
import { domainProfiles } from "@/domains/profile.js";
import type { CapabilityAdapter } from "./types.js";

/**
 * SceneFlow 统一联邦装配：8 远程市场源 + 全部领域本地源（ares 竞赛库 / metis 研究脊柱）。
 * 领域源 100% 本地零网络，capabilityId 自带 ares-/metis- 前缀无冲突；24h 缓存兜底。
 */
export async function federatedSearchFactory(): Promise<{ search: (query: string, limit?: number) => ReturnType<FederatedSearch["search"]>; instance: FederatedSearch }> {
  const domainAdapters: CapabilityAdapter[] = [];
  for (const profile of domainProfiles()) {
    try {
      domainAdapters.push(...(await profile.adapters()));
    } catch (err) {
      // 领域数据缺失（如目录被删）只降级该领域，不阻塞面板启动。
      console.error(`[sceneflow] domain ${profile.id} sources unavailable:`, err instanceof Error ? err.message : String(err));
    }
  }
  const search = new FederatedSearch(
    [mcpSoAdapter(), officialServersAdapter(), modelscopeAdapter(), clineAdapter(), awesomeAdapter(), skillsShAdapter(), skillsMpAdapter(), skillHubAdapter(), ...domainAdapters],
    fileRegistryCache({ filePath: path.join(scenarioDataRoot(), "registry-cache.json") }),
    5,
  );
  return { search: (query: string, limit?: number) => search.search({ text: query, limit }), instance: search };
}
