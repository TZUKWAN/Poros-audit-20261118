# CHANGELOG

## Unreleased production hardening (2026-10-17)

- Web 工作台改为 Codex 风格的项目/对话侧栏、聊天信息流和运行检查台；场景库作为管理入口打开，新建对话时选择场景，场景卡通过“用于新对话”进入同一流程。
- 增加 PersistentGoalLoop 长程场景：1–50 轮、检查点、暂停/继续/停止、重启恢复、并发创建保护和失败终态；普通运行支持暂停/继续/停止/重试/分支及迟到回调保护。
- 历史会话持久化项目上下文，切换或面板重启后恢复原项目；跨会话重试/分支会被拒绝，仍有活动运行的历史会话不能被归档或删除。
- 生产边界收口：项目/会话/工作区隔离、canonical path 与 symlink 防护、分享/评论/产物/上下文生命周期校验、WS requestId 归属和 REST 异步失败响应。
- 工作区导出脱敏文件/产物/Memory/本地上下文/凭据 URL；大包导入走有界 `POST /api/workspace/import`，空文件、同名冲突、非法条目和未恢复实体都会明确提示。
- 代理链路支持 OpenAI-compatible Provider、fallback、流式响应和真实连接探活；面板默认从 `http://127.0.0.1:8317/v1` 读取代理配置。

## 1.0.0 (2026-09-29)

首个完整版本：P 阶段 + 阶段零～十一（五轮终审）全部完成。

### 新增
- **联邦层**：8 源适配器（mcp.so slug/JSON-LD、modelcontextprotocol/servers GitHub API、ModelScope PUT API、Cline Marketplace API、Awesome README 解析、skills.sh、SkillsMP、腾讯 SkillHub），trust 评分（来源档位×证据分）+ 三条硬过滤，24h TTL 缓存，远程探活
- **技能经验矿**：3 源检索+下载 → Skill Digester 四类产物提炼（流程片段/坑与对策/验收要点/能力线索）+ 资产 vendoring + 用完即删
- **编排内核**：8 状态机、五闸门挂起/恢复/驳回回退（含同阶段重跑）、断点持久化与崩溃续跑、决策协议 zod schema
- **虚拟用户驱动器**：5 种策略化 GateDecision（全程批准/驳回 N 次/编辑槽位/换候选/循环驳回压力）
- **五闸门交互层**：TUI/Web 共用纯渲染视图 + 候选卡片（来源徽章/trust 条/风险标/远程标）
- **执行底座**：集群调度（拓扑分层并发、上游输出路由、深度=1 守卫）、安装器（npx/cli/git/remote+并发安装锁）、调用器（remote JSON-RPC/SSE、stdio JSON-RPC、技能上下文注入）、权限门控（默认拒绝）、自动修复回路（trust 次优换型，上限 3）、GoalLoop（逐轮放行 approve/fix/stop）、pi-reactor 桥（cron 触发 + 本地 webhook 真实监听）
- **三层验收**：组件级（探活+schema+延迟）、任务级（规则+LLM judge 阈值可配）、泛化测试（≥2 组换参，过拟合拒绝）、报告归因（层+节点/能力）
- **蒸馏与场景库**：槽位化/分支化/验收泛化/意图签名（词袋+可注入嵌入）；命中三档（复用/派生/新建）、填槽执行 stats 治理、漂移检测局部换型版本+1、低成功率降级标
- **Memory 三层**：会话/场景/知识 Markdown；context-mode ContentStore（SQLite FTS5+BM25）检索；文件树接口
- **Web 面板**：HTTP+WS，项目/对话侧栏 + 聊天信息流 + 运行检查台；场景库管理、新建对话场景选择、五闸门兼容视图、运行中心和移动端抽屉
- **e2e**：4 条无人干预可重放流程（构建固化/命中复用+对比报告/目标模式/漂移恢复）
- **Pi 包**：`pi install ./pi-package` 实机注册，`/scenario:build`、`/scenario:status` 命令；内核 esbuild 单文件 bundle

### 已知限制
1. **pi-subagents 深度集成**：其作为 pi 扩展运行，独立（无 pi 运行时）模式下集群走内核自带的 inProcessDelegator（真实能力调用）；pi 运行时内可经 Delegator 接口接入其委派（D13）
2. **mcp.so 搜索**：站点无公开 JSON API（纯 SPA），适配器降级为 slug 详情页解析——检索命中率为 slug 可猜中的能力（D8）
3. **意图签名嵌入**：默认词袋 hash（64 维确定性），命中阈值按其标定（hit 0.7/partial 0.3）；接入真实 embedding 服务时应在 ScenarioLibrary 构造时调阈值（建议 0.82/0.55）
4. **LLM 依赖点全部有模板降级**：意图解析/DAG 生成/judge 在 LLM 不可用时降级（功能不中断，质量降级）
5. **任务级验收规则**需按领域在闸门4 配置；缺省仅有 invoke 成功性规则
6. **Windows 文件句柄**：ContextModeRetriever 用后须 dispose()（SQLite 锁）；jsonStore/.bak 双写有额外 IO
7. **无鉴权 MCP 远程源**：远程调用走 PermissionGate（默认拒绝）+ 闸门3 风险标，但不做服务端凭据管理
8. **覆盖率**：行覆盖以 src/ 全量计（含 pi 包 bundle 入口薄层），个别集成路径（真实网络 smoke）在断网环境下按协议 F 跳过
