import { FederatedSearch } from "./search.js";
import { mcpSoAdapter } from "./adapters/mcp-so.js";
import { officialServersAdapter } from "./adapters/official-servers.js";
import { modelscopeAdapter } from "./adapters/modelscope.js";
import { clineAdapter } from "./adapters/cline-marketplace.js";
import { awesomeAdapter } from "./adapters/awesome-mcp.js";
import { skillsShAdapter, skillsMpAdapter, skillHubAdapter } from "./adapters/skill-sources.js";
import { fileRegistryCache } from "./search.js";
import path from "node:path";
import { scenarioDataRoot } from "@/core/store.js";

/** 生产装配：8 源联邦检索 + 24h 缓存 */
export async function federatedSearchFactory(): Promise<{ search: (query: string, limit?: number) => ReturnType<FederatedSearch["search"]>; instance: FederatedSearch }> {
  const search = new FederatedSearch(
    [mcpSoAdapter(), officialServersAdapter(), modelscopeAdapter(), clineAdapter(), awesomeAdapter(), skillsShAdapter(), skillsMpAdapter(), skillHubAdapter()],
    fileRegistryCache({ filePath: path.join(scenarioDataRoot(), "registry-cache.json") }),
    5,
  );
  return { search: (query: string, limit?: number) => search.search({ text: query, limit }), instance: search };
}
