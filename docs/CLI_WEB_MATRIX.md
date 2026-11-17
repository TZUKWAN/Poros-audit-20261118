> 历史记录：本文描述旧 Pi 或早期企业基线，不作为当前功能/部署验收。当前事实见 [README](../README.md)、[DEPLOYMENT](DEPLOYMENT.md)、[功能迁移矩阵](FEATURE_MIGRATION_MATRIX.md) 和 [测试证据](../TEST_EVIDENCE.md)。

# CLI and Web capability matrix

This matrix is the contract between the Pi extension, the local Web panel, and the shared service layer.

| Capability | CLI entry | Web entry | Shared service/protocol | Evidence |
|---|---|---|---|---|
| Build a scenario | `/scenario:build <requirement>` | Scenario build mode + `start-build` | `createOrchestrator` + `PanelActionSchema` | orchestrator and panel integration tests |
| Inspect health | `/scenario:status` | Settings, connector and run centers | snapshot + health actions | panel snapshot tests |
| Work with a scenario | kernel `runScenario` | Work mode, `/use`, scenario cards | `tryReuseScenario` | scenario integration tests |
| History | Pi host history | History rail, open/archive/restore/delete | `PanelHistory` + session actions | panel integration tests |
| Projects and files | host/project context | Project rail, upload/drop/preview/index/delete | `WorkspaceRepository` + file actions | panel integration tests |
| Memory | kernel Memory writers | Memory panel and `/memory` commands | `MemoryRepository` + markdown tree | memory and panel tests |
| Connectors | host runtime adapters | Connector center | `ConnectorRepository`, permissions and audit | panel tests |
| Providers | environment/profile | Settings → Provider profiles | `PanelSettingsStore` + `ProviderProfileRepository` | planner/settings tests |
| Runs | kernel execution | Run center, pause/resume/stop/retry/detail | `RunRepository` + WS event protocol | run and panel tests |
| Tasks | reactor/host trigger | Task center and scheduler | `ScheduledTaskRepository` + `TaskScheduler` | scheduler tests |
| Export/import | host filesystem | `/export`, scenario export, workspace export + `POST /api/workspace/import` | local JSON bundle endpoints; large workspace import uses bounded HTTP transport | panel tests |
| Desktop context | host clipboard/file/terminal adapters | Context center and clipboard import | `DesktopContextRepository` + frozen `RuntimeContext` | context and planner tests |
| Collaboration | host/project sharing | scenario/workspace share and run comments | `ShareLinkRepository` + `CommentRepository` | share/comment tests |

Every Web action is validated by `PanelActionSchema`; the server is authoritative for state, permissions, persistence, and receipts. The CLI and Web layer do not maintain separate execution semantics.
