# 通用场景智能体修复状态

## 当前目标
按照本文末尾完整任务清单完成前端优先的 Agent 工作台，并逐项验收；不修改 ARES/METIS 场景。原修复测试仅证明当时实现，不代表新增任务清单已完成。

## 持续开发现场（2026-10-03）
- Goal active：按照任务清单，完成所有开发工作并确保验收通过；13 阶段均保留，尚未完成。
- 最新全量回归（2026-10-04 01:29）：50 个测试文件、396 个测试通过、1 个外部联邦网络测试显式跳过、无失败；`npm run build`、`npm run lint`、`npm run panel-client`、`git diff --check` 均通过。
- 本轮新增：后台任务失败/超时/重启恢复状态；连接器来源、信任状态、信任分数和探活证据；规划模型/Fallback/温度/最大 Token 设置与 fallback 原因记录；场景真实多样例泛化测试服务和场景卡片入口；同步 Token 加密设置与自托管同步 Bearer 传递；工作区导出包含所有项目文件内容并支持导入文件副本；弹窗焦点管理、Esc 关闭、Tab 循环和静态可访问性审计。
- 窄屏修复：390px 浏览器实测发现品牌被顶栏工具挤成竖排，已调整移动顶栏为品牌/模式/搜索/设置优先并隐藏桌面级工具；修复后窄屏截图验证通过，已恢复默认浏览器尺寸。
- 响应式补充：950px 左右平板宽度会隐藏次要工具入口、保持品牌和模式横排，避免顶栏按钮文字被压成竖排；浏览器截图复测通过。
- 场景治理补充：场景详情展示版本历史，支持对比当前版本的新增/移除能力；服务端新增 `/api/scenario/compare`，面板定向回归通过。
- 本阶段继续修复：同步应用现在会实际合并无冲突的远端项目/场景/Memory 后再回传；路径导入和跨项目文件预览边界收紧；Provider Secret 支持前端输入、加密保存、项目 Provider 规划使用和删除清理；Artifact 分享接口补齐。
- 闸门交互补充：闸门 2 DAG、闸门 3 能力选型、闸门 4 验收标准现在也提供结构化表单，JSON 仍保留为高级编辑；构建向导的完整分步引导仍列为部分完成。
- 2026-10-04 UI 信息流重构：修复 model-stream 读取 `content` 为空卡片的问题，连续流式 chunk 合并为单条消息；用户消息、AI 进度、模型输出、搜索/任务事件、审批卡重新分层，统一消息头/时间/角色、留白、边框和输入区样式；侧栏/检查台同步收敛为低对比度编辑风格。直接 esbuild 打包成功，浏览器截图复测通过；Vitest 本次尝试受 Windows esbuild `spawn EPERM` 阻塞，未将其宣称为通过。
- 信息流补充：`/help` 结果改为双列命令网格，用户气泡去除大面积渐变并按内容自适应，AI 状态卡统一进度/事件/模型输出层级；950px 与移动断点的空白列和顶栏压缩问题同步修复。
- 视觉规范补充：统一滚动条、选中态、键盘焦点、表单聚焦和消息卡片边界，避免不同 UI 区域各自使用一套交互反馈。
- 信息流交互补充：AI 状态、搜索结果、任务通知和模型输出提供悬停复制按钮；当前 UI 直接 esbuild 打包、build/lint 通过，浏览器复测通过。
- 弹窗布局补充：设置、运行、连接器等弹窗统一为可滚动内容容器，低高度窗口不再截断 Provider、身份和高级配置；浏览器截图验证通过。
- 响应式入口补充：950px/移动宽度新增“更多”菜单收纳上下文、分享、任务、连接器，避免为排版隐藏功能；菜单通过真实浏览器点击验证可打开上下文入口。
- 菜单可见性补充：更多菜单使用固定浮层、独立背景和高层级，避免被顶栏横向滚动容器裁切；DOM/菜单项和上下文打开行为复测通过。
- 菜单渲染修复：将更多菜单移出带横向滚动的顶栏 DOM，浮层现在能在截图中真实显示文字和阴影，平板入口验收通过。
- 响应式检查台补充：平板/移动宽度新增“检查台”入口，以固定侧滑抽屉展示同一运行上下文、任务流程和验收结果；真实浏览器打开/关闭验证通过。
- 移动端顶栏补充：390px 下收敛品牌和模式宽度，保证搜索、设置、更多三个核心入口同时可见；更多菜单在移动端包含上下文、分享、任务、连接器和检查台，截图复测通过。
- 主聊天上下文补充：聊天头部新增项目、模型、运行状态和 Memory 数量 chips；在检查台抽屉关闭时仍能看到当前运行环境，最新 launcher/浏览器截图验证通过。
- 信息流空态修复：`ui-command` 不再渲染空 AI 卡片，改为紧凑“已打开设置/连接器”等事件条；`/help` 默认只显示常用命令，其余折叠展开；浏览器截图验证通过。
- 菜单可见性补充：更多菜单使用固定浮层、独立背景和高层级，避免被顶栏横向滚动容器裁切；DOM/菜单项和上下文打开行为复测通过。
- 真实运行态证据（2026-10-04 01:30）：最新 bundle 面板在 `http://127.0.0.1:4320/` 启动；HTTP 快照显示 `gpt-6.1-sol`、`http://127.0.0.1:8317/v1`、`hasApiKey=true`、同步 Token/端点已加载；Host Bridge POST 返回 200；自托管同步无 Token 返回 401，Bearer push/pull 返回 `r-final-2` 且实体数 1；浏览器真实打开面板并验证设置弹窗、工作模式/场景构建模式切换。`8317` 当前没有监听，真实模型连接验证仍未通过。
- 已读取状态和真实源码，工作区包含前几轮改动，保持原文件不回滚。
- 正在实现：共用领域契约/命令注册表、真实 Memory 管理与搜索、前端命令补全、请求 ID 与响应隔离。
- 已确认当前草稿 `/memory search` 只有提示文案，先修成真实查询，不能标记完成。
- 本阶段验证：针对 Memory 的持久化、范围隔离、禁用/删除、越界访问；命令解析/未知命令；WS 请求去重与操作结果关联；浏览器操作；最后 build/lint。
- 后续：项目/文件/Artifact 上下文、连接器/权限、统一运行中心，再按完整清单继续。
- 本轮新增：`src/panel/commands.ts` 命令注册表和解析器；前端命令菜单/补全（输入 `/`、Ctrl/Cmd+K、Tab、方向键）；服务端 `run-command` 路由已实现 `/help`、`/work`、`/build`、`/new`、`/archive`、`/settings`、`/scenario list|inspect`、`/use`、`/memory list|search`、`/run stop|retry`。
- 命令验证：命令单测 2 项、面板集成测试 11 项通过；build/lint/panel-client 通过。
- 新增 `src/product/contracts.ts`：Workspace、Project、Session、Run、MemoryItem、Artifact、Connector、ProviderProfile、ScheduledTask 九类共用 zod 契约；产品契约单测通过。
- 新增 `src/product/repository.ts`：工作区、项目和项目文件的持久化仓库；面板快照和 action 已接入当前工作区/项目上下文，前端显示项目列表并支持新建/切换。
- 新增 `tests/unit/product-repository.test.ts`：创建项目、添加文件、归档和删除路径通过。
- 项目文件上传已接入 `upload-file` action：当前项目下写入受限大小文件并进入项目文件清单；面板集成路径已验证。
- Memory 已接入创建/编辑/删除 action 和前端弹窗/查看器操作；项目文件和 Memory 集成回归目前为 19 项通过。
- 连接器中心已接入 `ConnectorRepository`、前端连接器弹窗、添加/启停/探活失败留痕 action；项目/Memory/Connector 定向回归目前为 20 项通过。
- 运行中心基础层已接入 `src/product/runs.ts`、面板 run 记录和前端运行中心入口；每次工作/构建记录 runId、模型、场景、状态和失败信息。
- 本阶段继续落地：`src/product/artifacts.ts`、`providers.ts`、`memory.ts`、`tasks.ts`、`scheduler.ts`、`audit.ts`、`events.ts`，面板快照已包含产物/Provider/任务/Memory 元数据/审计和 revision；WS action-result 返回 requestId，支持 `/api/events` 与 WS `resume` 回放。
- 前端已补齐：连接器删除、项目编辑/归档/删除、项目指令、文件删除、产物打开/删除、Provider 配置、后台任务新增/立即运行/启停/删除、审计列表、场景详情与 slot 表单、扩展斜杠命令（rename/export/scenario test/version/memory remember/forget/run pause/resume）。
- 又补齐：全局搜索（对话/场景/Memory/文件/运行/产物）、项目文件只读预览、Memory 启停、运行暂停/继续按钮、场景 JSON 导入/导出、场景生命周期按钮、运行时长统计和更多响应式入口。
- 面板静态资源增加版本查询串和 `Cache-Control: no-store`，避免重启后浏览器继续使用旧 client；构建期间仍保留旧入口兼容。
- 项目支持置顶/取消置顶；设置新增历史保存、自动 Memory、临时会话开关；连接器 UI 支持本地 MCP/CLI/HTTP/远程 MCP/Skill 类型和权限范围；运行记录新增时长/重试/成本/Token 字段。
- 本轮继续补齐真实闭环：运行时冻结项目指令、文件摘要、启用 Memory、桌面上下文、连接器和 Provider，并注入规划请求；Provider 选择会影响后续规划与 Run 模型快照；运行详情持久化 DAG/trace/验收/上下文并支持 `/api/runs/:id` 查看；Secret 使用独立加密凭据库；network 权限缺失时连接器探活会被拒绝；桌面上下文支持前端导入、启停和删除；场景保存记录版本历史。
- 模型连接验证现包含 `/models` 和最小 `/chat/completions` 两层；后台任务触发会写通知消息，暂停/继续/终止同步 RunRepository 状态；运行重试递增 retryCount。
- 文件上下文新增索引动作和拖拽上传；桌面上下文独立持久化；运行中心支持详情查看和按原始 Run 重试；`/export workspace` 可下载脱敏工作区包。
- Provider 能力字段已投影到前端（上下文长度、工具/视觉/结构化支持、限流/成本）；Artifact 支持版本递增；MCP 连接器探活会对远程 MCP 发送 `tools/list`，HTTP API 保持 GET 探活。
- 工作区权限策略中心已接入（读/写/安装/联网/外发和审批策略），桌面上下文入口、Artifact 版本入口和运行详情重试入口均已在前端暴露。
- 后台任务支持编辑，文件索引和拖拽上传入口已接入；自动 Memory 开关会真实控制运行结束时的 Memory 写入。
- 本轮加入本地角色化分享令牌（工作区/项目/场景/产物资源，可撤销，过期检查）和场景卡分享入口；分享内容不携带 Secret。
- 评论中心已接入运行详情，支持按资源添加和解决评论；桌面上下文支持一键读取剪贴板，工作区权限策略和分享角色均有前端入口。
- 分享中心现在同时暴露工作区/项目/场景/产物资源、角色选择、令牌脱敏列表和撤销；项目/Artifact 卡片可直接发起分享。
- Artifact 版本现在保存文本快照/校验值并提供差异接口；运行中心提供两个 Run 的状态、时长、Token、成本、trace 和验收对比。
- 工作区导入现在检测同名项目/场景并生成带冲突标记的副本，保留本地数据并在对话流中报告冲突。
- 桌面上下文新增独立适配器边界校验：本地文件限制在项目根、浏览器只允许 HTTP/HTTPS，相关权限边界有单测。
- 同步客户端已支持真实 HTTP pull/push envelope、revision 和冲突计划；设置面板提供同步端点和同步预览，协议有本地 HTTP 集成测试。
- Host Context Bridge 已提供本地 HTTP endpoint、一次性会话令牌、来源/路径校验和上下文仓库写入；集成测试已真实 POST 剪贴板上下文。
- 新增宿主侧适配器：VS Code 选中文本扩展、终端 stdin/file 发送脚本、Chromium 右键选中文本扩展；脚本语法校验、build/lint 通过，下一步用真实 Host Bridge 验证终端路径。
- Host Bridge 已用终端适配器真实 POST 验证；同步中心新增“同步预览/应用同步”，应用前先拉取远端 revision、检查冲突，默认不上传 Memory 或 Secret。
- 前端 Planner 现在暴露实际来源和降级原因；LLM 超时/畸形返回不再静默，运行上下文面板会显示 template fallback 证据。
- 分享安全审计已修复：token 不再出现在普通快照或服务端聊天历史，只通过一次性 action-result 返回并复制；对应面板回归已通过。
- 新增可选自托管同步服务：设置 `SYNC_PORT`/`SYNC_TOKEN` 后面板进程同时提供 Bearer 鉴权的 pull/push 端点；真实 HTTP 服务单测通过。
- 自托管同步端点已真实启动在 4321，Bearer push/pull smoke 返回 `push=r-smoke pull=r-smoke entities=1`。
- Provider 可按项目选择并作为本次运行模型快照；连接器 Secret 仅经加密凭据库读取到探活请求头，不进入快照、Memory 或审计详情。
- 项目 Provider 选择、工作区导入恢复、索引文件作为上下文选择、模型工具调用验证和工作区权限策略均已接入。
以下条目是此前阶段的历史证据；当前交付状态以本文件开头的最新回归和“最终验证证据”为准。
 - 最终回归仍为 46 个测试文件、381 个测试全部通过；联邦测试快照已恢复，当前工作区无凭据形状文本、无 whitespace 错误。
- 当前运行态通过 WS 三层模型连接验证（`models`、`chat completion`、工具 schema），结果 `ok: true`；只使用进程环境变量，没有把 Key 写入项目或日志。
- 任务调度、上下文、Secret、运行详情、Provider 选择、场景版本、分享、评论、同步冲突、桌面适配器和本地身份角色的新增定向测试已通过；完整回归最新为 49 个测试文件、380 个测试通过、6 个外部在线测试跳过、无失败，退出码 0，联邦快照已恢复。
- 最终完整回归（2026-10-03）：39 个测试文件、368 个测试通过、1 个外部技能下载冒烟因远程候选没有 `SKILL.md` 显式跳过（总计 369），退出码 0；`git diff --check` 通过，快照副作用已恢复，仓库扫描未发现完整 OpenRouter 密钥文本。
- API Key 已改为本机身份派生 AES-256-GCM 加密落盘，兼容旧明文并在读取时迁移；真实浏览器验证设置连接成功、任务/Provider/连接器/项目入口可见，连接器添加和探活成功。
- 联邦冒烟修复：远程搜索候选排序变化时按候选逐个尝试真实 SKILL.md 下载，避免把无技能文件的第一候选误判为系统失败；联邦集成 7 项通过。
- 当前定向证据：`npm run build`、`npm run lint`、`npm run panel-client` 均通过；面板集成 18 项 + 调度器 2 项 + 设置加密 1 项 + 场景治理 1 项通过。
- 最新完整回归（2026-10-03）：39 个测试文件、368 个测试通过、1 个外部技能下载冒烟因远程候选均无 `SKILL.md` 而显式跳过（总计 369），退出码 0；其余真实联邦网络 smoke 通过。测试生成的 `tests/integration/__snapshots__/federation-smoke.json` 已用 `git restore --source=HEAD` 清理回快照基线，`git diff --check` 无 whitespace 错误。

## 修复拆解
- [x] P0：建立真实执行结果契约，失败不得伪装成功；补齐探活/验收/蒸馏依赖边界。
- [x] P0：补齐五道闸门的编辑与最终选择协议，前后端共用并校验当前闸门。
- [x] P0：接入可配置的真实规划器（OpenRouter 可选），无模型时使用明确的结构化本地规划。
- [x] P0：在面板构建入口接入场景匹配/复用，补齐槽位与执行参数。
- [x] P1：修复检索相关性、节点查询、WS 重连、重复消息、取消与旧决策状态。
- [x] P1：扩展最终结果与面板状态，保留输出、失败原因、验收证据和场景动作。

## 验证计划
- 每个 P0/P1 小阶段添加针对性回归测试并立即运行。
- 最终运行 TypeScript 构建、ESLint（若现有配置可通过）、定向 Vitest 和完整 Vitest。
- 检查工作区 diff，确认没有写入 API 密钥或测试副作用。

## 当前已确认事实
- 初始工作区 `pi-scenario` 干净；测试期间产生的 federation smoke 快照已在每次复测后恢复。
- 当前实现已通过 TypeScript 构建、ESLint，以及 32 个测试文件、351 个测试。
- OpenRouter 凭据仅允许通过临时环境变量使用，不得写入仓库、日志或状态文件。
- 已完成：执行步骤增加 `delegated` 语义；无 probe/execute/distill 不再写入假成功。
- 已完成：GateDecision 支持 `edit` 与 gate5 `pin/rerun/discard`，并校验 pending gate。
- 已完成：面板支持 JSON 编辑闸门1-4、gate5 三选一、断线重连和终止时 abort。
- 已完成：面板按节点查询检索，场景命中后执行漂移检查和真实复用；内核入口会在 pin 成功后保存场景。
- 已完成：启动锁防止重复构建，异常和运行结束都释放锁；WebSocket 决策错误可返回 action-result，终止动作会联动 abort。
- 已完成：构建结果只在真实执行、验收通过且 gate5 明确 pin 时固化；失败、委托、上下文注入和丢弃均保留明确状态。
- 已完成：可选 OpenRouter 规划器仅读取环境变量，不写入 API 凭据；无密钥时使用结构化本地规划器。
- 已完成：面板在解析/复用阶段立即显示进度，构建成功、失败、复用结束、操作失败和终止都会解除输入框发送中状态。

## 下一步
项目内可验证功能已完成最终回归。剩余工作集中在外部条件：启动可用的 `127.0.0.1:8317` 模型服务完成真实三层模型 smoke；补窄屏/逐按钮浏览器 smoke；若要把本地同步扩展为第三方云端多设备服务，需要部署目标、账号和网络权限。工作区未改动 ARES/METIS，测试快照副作用已清理。

## UI 研究记录（2026-10-02）
- GitHub 对照项目：
  - `langchain-ai/agent-inbox`：把中断请求结构化为 action/args/description，并按 `accept/edit/respond/ignore` 配置可用操作，适合借鉴“每道闸门只展示当前可做的动作”。
  - `CopilotKit/CopilotKit`：HITL 组件随 `InProgress → Executing → Complete` 变换，批准控件内嵌聊天并由 `respond` 恢复执行，适合借鉴状态与动作的同位呈现。
  - `NikitaKharya09/agenttrace-ui`：Timeline/Graph/Compact 三种视图、渐进展开、原始参数/结果/耗时详情、审批后留下 receipt，适合借鉴“先看结论、再展开证据”。
  - `myUdav4iik/agent-canvas`、`pintarkristian/agent-orchestration-dashboard`、`mukesh-durga/stagehand`：React Flow/Canvas + SSE/WS 实时节点状态 + 可回放运行记录，适合借鉴“运行态画布”和“历史运行详情”。
  - `FlowiseAI/Flowise` Agentflow：节点编辑弹窗、动态字段、验证结果、明暗主题与读写模式，适合借鉴“结构化表单替代 JSON 编辑”。
  - `agentkitai/agentgate`：待审批列表、风险颜色、请求详情、审计日志、键盘可访问与 skeleton loading，适合借鉴审批入口和错误/加载状态。
- 对当前面板的判断：功能闭环已存在，但 `src/panel/chat-client.ts` 把闸门编辑直接暴露为 JSON 文本，把大量内部状态塞入聊天流；`src/panel/server.ts` 的右栏是静态分段列表，DAG 仍是行列表，用户缺少“当前要做什么、为什么、做完会发生什么”的单一焦点；`src/panel/launch.ts` 固化场景时直接用需求前 24 个字符命名，缺少用户确认与适用范围说明。
- UI 改造建议分层：
  1. P0：增加固定的构建进度/当前闸门摘要；审批卡改成结构化表单与候选卡，默认收起原始 JSON；动作按钮按风险与后果给出文案，提交中锁定并展示结果 receipt。
  2. P1：把右栏改为运行画布 + 当前节点详情抽屉，节点状态由 WS 事件驱动；把场景库/Memory 移到可切换的历史侧栏，不与当前决策抢注意力。
  3. P1：增加“本次运行详情”与重放入口，支持从时间线展开原始参数、输出、耗时、失败原因；断线后恢复当前运行和待审批焦点。
  4. P2：补充模板/示例需求、移动端/窄屏布局、键盘焦点/ARIA、加载骨架与可访问的状态播报。
- 暂不建议直接引入完整 React Flow 或重做后端协议；先把现有 WS 快照/事件协议投影成更清晰的 UI 状态，确认交互模型后再决定是否换前端框架。

## 最终验证证据
- 2026-10-04 最新：`npm test -- --reporter=dot` 为 50 个测试文件、396 个测试通过、1 个外部联邦网络测试显式跳过、退出码 0；`npm run build`、`npm run lint`、`npm run panel-client`、`git diff --check` 通过。
- 运行态 HTTP smoke：`GET /api/snapshot` 返回工作区/项目快照；Host Bridge 真实 POST 返回 200 并写入上下文；同步服务未授权返回 401，Bearer push/pull 返回 revision `r-ui-smoke`、实体数 1。
- 浏览器 smoke：真实打开 `http://127.0.0.1:4320/`，检查设置弹窗、API 地址/模型字段、工作模式与场景构建模式切换；截图已在交付记录中留存。
- 当前模型服务检查：`http://127.0.0.1:8317/v1/models` 被本机拒绝连接；面板三层模型验证真实返回 `fetch failed`，因此本轮不宣称真实模型 smoke 通过。
- `npm run build`：通过。
- `npm run lint`：通过。
- `npm test -- --reporter=verbose`：32 个测试文件、351 个测试全部通过，退出码 0。
- `git diff --check`：无 whitespace 错误；仅有工作区换行格式提示。
- 密钥扫描：未发现完整 OpenRouter 凭据；仅保留 `OPENROUTER_API_KEY` 环境变量名称和文档说明。
- 真实 OpenRouter smoke：模型意图标记为 `llm`，返回 4 节点 DAG；完整五闸门编排完成，远程 JSON-RPC 探活/调用成功，三层验收全通过，结果 `completed` 且 `pin`。
- 最新全量回归：32 个测试文件、351 个测试全部通过，退出码 0。
- 面板定向回归：构建、lint、前端打包和 10 个面板集成测试全部通过。

## 主线真实复测（2026-10-15）

- 用户反馈后按当前源码重新启动面板并用真实浏览器操作复现：旧版本确实出现外部检索误选 `Contradiction-MCP`、同一候选重复分配、构建节点全部 skipped 后失败、右侧检查台终态丢失、历史信息流堆叠等问题。
- 修复后面板真实构建“建立一个本地论文写作研究场景”完成并固化 `sc-panel-1792077251158`；候选默认优先本地可验证规划能力，外部候选仍保留供查看；重启后恢复运行状态、DAG、验收、产物和 Memory。
- UI 真实复测：连续状态聚合为运行过程时间线；每次用户请求形成一次运行组；最新运行展开、历史运行收起；左侧历史默认最近 6 条、场景默认最近 4 个；模型流合并为单条富文本消息；右侧终态显示“已经完成 / 5 / 5”，失败时显示原因。
- 调度/执行加固：状态机并发/abort/回退恢复、DAG 上游失败阻断、失败节点依赖链重试、暂停多 worker、npx/stdio 失败收口、空验收/错误探活不再伪通过、旧候选 `null` 字段归一化。
- Pi CLI 的 `/scenario:build` 现在显式使用 construction-only：输出“场景定义构建完成，外部能力未执行”，trace 使用 `planned`，结果带 `verification=untested`，不把未执行能力当作真实成功。
- 当前真实命令证据：`npm test -- --reporter=dot` → 54 个测试文件、414 个测试通过；`npm run build`、`npm run lint`、`npm run bundle`、`npm run panel-client`、`git diff --check` 均通过；`tests/integration/panel-integration.test.ts` 28/28 通过。
- 跨工作目录 smoke：从 `D:\` 通过绝对 `file:///` 导入 `pi-package/dist/kernel.js`，construction-only 返回 `phase=done`、`outcome=completed`、`verification=untested`、5 次闸门决策、4 个 `planned` 节点。
- 仍需保留的边界：Pi/工作模式对 git/cli/远程能力的真实物理执行仍依赖宿主或连接器；没有可执行宿主时必须显示未验证/委托，不得伪报完成。外部联邦检索存在网络/数据源波动，构建默认使用本地基线能力保证可用。
- 最终浏览器复测：重启面板后恢复最近构建的 DAG，四个节点显示“已定义”，组件/任务/泛化验收显示“已定义，待首次运行验证”；切换工作模式复用同一场景后真实生成“执行计划.md”，信息流保持按运行聚合。
- 最后一轮可读性微调：桌面侧栏、消息卡、检查台标题和状态字号上调；`npm run panel-client`、`npm run build`、`npm run lint` 通过，面板与 construction-mode 定向测试 29/29 通过；修复后面板仍在 `http://127.0.0.1:4320/` 运行。

## 真实面板运行记录（2026-10-02）
- 已用本地模型服务 `http://127.0.0.1:8317/v1` 的 `gpt-6.1-sol` 启动面板；密钥只注入运行进程，未写入文件。
- 原面板端口 4310 被其他本机程序占用，本次面板改用 4311。
- 侧边浏览器真实提交需求后，闸门1显示 `解析方式: llm`，目标/领域/槽位/关键词均由模型返回；随后真实联邦检索命中 5 个候选，页面当前停在闸门1等待人工决策。
- 侧边浏览器页面已标记为交付页，面板进程保持运行。

## UI 重做记录（2026-10-02）
- 面板从旧的两栏控制台重做为“场景工作台”：顶部模式切换，左侧场景库，中间聊天主流程，右侧运行检查台。
- 新增工作模式与场景构建模式：工作模式只尝试复用已有场景，命中失败时明确提示切换构建；构建模式进入原五道闸门流程。
- 场景库卡片新增“使用此场景”入口，聊天流改为用户气泡、AI 状态消息、结构化闸门卡片、结果回执；原始 JSON 默认收进高级折叠区。
- 新 UI 文件：`src/panel/chat-client.ts`、`src/panel/panel.css`、`src/panel/server.ts`、`src/panel/launch.ts`。
- 浏览器验证：4320 端口面板真实打开；构建模式真实收到 `llm` 意图闸门；工作模式真实命中场景并在能力不可复用时显示明确回退提示；截图检查通过。
- UI 回归：`npm run panel-client`、`npm run build`、`npm run lint`、面板 10 项集成测试通过；全量回归为 32 个测试文件、351 个测试通过。联邦 smoke 快照已恢复。
- 已知残余：场景槽位目前仍通过自然语言需求填写，右侧 DAG 仍是紧凑运行清单，尚未提供文件上传和完整图形化画布。

## 历史与设置审计记录（2026-10-03）
- 新增 `src/panel/history.ts`：会话消息、模式、活动场景、创建/更新时间持久化到用户数据目录；面板支持新建、打开历史会话和刷新恢复。
- 历史会话支持活动/归档分组、归档、恢复和永久删除；删除要求二次确认，当前运行中禁止破坏性操作，归档/删除当前会话会自动创建新的活动会话。
- 新增 `src/panel/settings.ts`：模型地址、模型名、超时和 API Key 配置；面板提供设置 UI、`GET/PUT /api/settings` 和模型连接验证；公开快照只返回脱敏 Key。
- `src/panel/server.ts` 增加历史/设置快照、WS actions、REST API、运行 busy 状态、场景存在性校验、路径 relative/realpath 防护、端口错误收口、持久化写入队列。
- `src/panel/launch.ts` 注入 history/settings，设置更新后重建后续 planner；每次运行新建 RunController 和 AbortController，工作模式复用支持 checkpoint/终止信号；指定场景与槽位可随请求绑定。
- 浏览器真实验证：历史区和设置弹窗出现；设置显示本地 API 地址、`gpt-6.1-sol` 和脱敏 Key；“验证模型连接”返回成功。
- 最新定向面板回归：10/10；build、lint、panel-client 通过。
- 本轮最终全量回归：32 个测试文件、351 个测试全部通过；联邦 smoke 快照已恢复。
- 归档/恢复/删除动作已纳入面板集成路径，删除 confirm 缺失会被协议拒绝。
- 残余风险：设置文件位于用户数据目录且保存 API Key 时为本地明文 JSON；面板只对 API 返回脱敏，后续可接操作系统凭据存储。工作模式复用目前展示运行结果状态，但没有像构建模式一样生成完整节点轨迹。

## Agent 产品能力差距审计（2026-10-03）
- 当前产品定位：场景编译器 + 场景运行器；目标产品定位应升级为工作台式 Agent 操作系统，场景成为后台路由与复用层。
- P0 缺口：项目/工作区上下文、全局/项目/会话 Memory 分层、文件与 Artifact、斜杠命令/命令面板、MCP/Connector 管理、权限中心、统一运行历史和模型/Provider 设置。
- P1 缺口：后台任务与定时触发、运行回放/重试/分支、场景版本与评测、跨会话搜索/置顶/分享、成本/延迟/配额观测、工具健康度与连接诊断。
- P2 缺口：桌面应用上下文接入、语音/录音、多模态产物、团队协作与共享知识库、场景模板市场。
- 研究依据：已查阅 OpenAI ChatGPT capabilities/memory/projects/work/app 资料、Anthropic Claude Projects/Memory/Connectors/Research/MCP 资料；具体判断已记录在本轮交付说明中。

## 前端 Agent 工作台任务清单（2026-10-03）

### 总目标

把当前“场景工作台”升级为前端优先的 Agent 工作台：

- 普通用户只通过前端完成对话、项目、文件、Memory、场景、连接器、运行控制和产物管理。
- CLI 与前端共用同一套 typed protocol、状态、权限和持久化。
- 工作模式负责灵活调用已有场景；构建模式负责创建、测试、版本化和发布场景。
- 不修改 ARES/METIS 场景。

完成标准：新用户不打开 CLI，也能创建项目、导入上下文、配置模型、连接能力、运行任务、审批高风险动作、查看 Memory、使用/构建场景、管理历史、查看产物并导出结果；断线、刷新、重启、失败、重试、归档和删除都有确定行为。

### Phase 0：产品契约和数据底座（P0，所有后续任务依赖）

- [ ] 0.1 当前能力盘点：把 CLI 命令、内核 API、面板 action、Memory、场景库、执行器逐项列成 CLI/Web 对照表。
  - 涉及：README.md、src/kernel-entry.ts、src/panel/server.ts、src/panel/chat-client.ts。
  - 验证：每个现有入口都有唯一协议归属，没有前端按钮只做本地假动作。
- [ ] 0.2 统一领域模型：定义 Workspace、Project、Session、Message、Run、Scenario、MemoryItem、Artifact、Connector、ProviderProfile、ScheduledTask。
  - 涉及：新增 src/product/*.ts 或等价模块。
  - 验证：所有模型有 zod schema、版本号、createdAt/updatedAt、来源和状态字段。
- [ ] 0.3 统一事件协议：给 WS/SSE 事件增加 eventId、runId、sessionId、revision、requestId、terminal 和错误结构。
  - 验证：重复事件可去重，断线重连可从 cursor/revision 恢复。
- [ ] 0.4 持久化边界：确定数据目录、备份、迁移、坏数据恢复和敏感字段策略。
  - 验证：旧 scenarios.json、旧 session、旧 settings 可读；损坏文件有可读错误且不破坏其他数据。
- [ ] 0.5 权限模型：区分只读、执行、写入、安装、外部发送、管理员设置。
  - 验证：每个危险动作都有 policy 检查和审计记录。

### Phase 1：前端工作台壳层（P0）

- [ ] 1.1 全局导航：工作台、项目、历史、场景库、Memory、连接器、运行中心、任务、设置。
- [ ] 1.2 项目/会话上下文条：显示当前项目、模式、模型、连接状态、运行状态。
- [ ] 1.3 全局搜索：搜索历史会话、场景、Memory、文件、产物和运行记录。
- [ ] 1.4 命令面板：/ 或 Ctrl/Cmd+K 打开，支持键盘导航、最近命令和帮助。
- [ ] 1.5 响应式与可访问性：窄屏布局、焦点管理、ARIA、状态播报、空态、加载骨架、错误边界。
- [ ] 1.6 前端状态层：统一 snapshot/event/reconnect，不允许组件各自维护一套运行状态。
- [ ] 1.7 验证：浏览器 smoke 覆盖导航、模式切换、刷新恢复、断线恢复和窄屏。

### Phase 2：对话流和斜杠命令（P0）

- [ ] 2.1 命令注册表：命令名、别名、参数 schema、说明、权限、执行器、结果类型。
- [ ] 2.2 第一批命令：
  - /help
  - /work
  - /build
  - /use <scenario>
  - /scenario list|inspect|test|version
  - /memory remember|list|search|forget
  - /files add|list
  - /run pause|resume|retry|stop
  - /model
  - /connect
  - /settings
  - /new
  - /rename
  - /archive
  - /export
- [ ] 2.3 对话消息类型：用户消息、模型文本、规划卡、工具调用卡、审批卡、进度卡、错误卡、产物卡、最终回执。
- [ ] 2.4 输入体验：多行输入、快捷键、命令补全、历史输入、取消发送、重试上一条、附件拖拽。
- [ ] 2.5 流式输出：模型 token、工具调用、节点状态和最终结果分层渲染。
- [ ] 2.6 结果凭证：每个决定和工具动作都留下可回看的 receipt，不能只显示“已受理”。
- [ ] 2.7 验证：命令 schema 正反例、命令权限、重复提交、断线重连、审批后自动继续。

### Phase 3：项目、文件和上下文（P0）

- [ ] 3.1 项目 CRUD：创建、重命名、归档、删除、置顶、切换、项目级设置。
- [ ] 3.2 项目指令：前端编辑项目目标、风格、约束、默认输出格式。
- [ ] 3.3 文件入口：拖拽上传、文件选择、路径导入、目录浏览、删除和重新索引。
- [ ] 3.4 文件预览：Markdown、代码、JSON、CSV、PDF、图片的摘要和预览。
- [ ] 3.5 上下文选择器：本轮使用哪些项目文件、Memory、连接器和场景。
- [ ] 3.6 Artifact 工作区：生成的 Markdown、代码、表格、报告、JSON 有独立预览、下载、版本和差异。
- [ ] 3.7 验证：上传/读取/删除权限、文件越界、索引失败、产物下载和刷新恢复。

### Phase 4：Memory 产品化（P0）

- [ ] 4.1 四层 Memory：全局、项目、会话、场景。
- [ ] 4.2 Memory 管理页：列表、搜索、过滤、编辑、删除、启用/禁用、批量清理。
- [ ] 4.3 Memory 来源：显示来自哪条会话、哪份文件、哪个场景、何时写入。
- [ ] 4.4 使用解释：回答中显示“本次使用了哪些 Memory”，支持展开查看。
- [ ] 4.5 控制开关：引用历史、写入 Memory、临时对话、项目 Memory、自动总结。
- [ ] 4.6 Memory 写入流程：模型提议 → 用户确认/自动策略 → 写入 → 可撤销。
- [ ] 4.7 验证：编辑/删除立即生效、来源删除联动、临时对话不读不写、重启恢复。

### Phase 5：场景前端化（P0）

- [ ] 5.1 工作模式路由器：命中、部分命中、未命中、能力漂移、缺槽位的前端状态和下一步按钮。
- [ ] 5.2 场景库：搜索、标签、来源、版本、成功率、最近使用、降级状态、归档和删除。
- [ ] 5.3 场景详情：意图签名、槽位、能力依赖、验收模板、Memory、版本历史。
- [ ] 5.4 槽位表单：根据 slotDefs 自动生成 path/url/string/number 输入，校验必填和类型。
- [ ] 5.5 构建向导：意图、DAG、能力候选、装配、验收、固化五步结构化表单。
- [ ] 5.6 场景测试：使用样例参数运行 dry-run、多组泛化测试、查看失败节点。
- [ ] 5.7 版本治理：发布、草稿、回滚、版本对比、能力漂移、替换记录。
- [ ] 5.8 CLI 对齐：/scenario build/status/list/use/test/version 与前端调用同一服务。

### Phase 6：连接器、MCP 和权限中心（P0）

- [ ] 6.1 连接器目录：本地 MCP、远程 MCP、CLI、HTTP、Skill/Knowledge 分类和搜索。
- [ ] 6.2 添加连接器：URL、命令、环境变量、认证方式、能力范围、来源和信任证据。
- [ ] 6.3 连接测试：tools/list、schema、健康探活、延迟、最后错误。
- [ ] 6.4 权限中心：读取/写入/安装/发送/外部网络分级。
- [ ] 6.5 审批策略：本次允许、当前会话允许、永久允许、拒绝、自动策略。
- [ ] 6.6 Secret 管理：Key/OAuth 引用不进入消息、日志、Memory 和普通设置快照。
- [ ] 6.7 审计日志：谁在何时批准了哪个工具、传入什么参数、产生什么结果。
- [ ] 6.8 验证：恶意/过期连接器、鉴权失败、权限拒绝、重复调用、工具 schema 变化。

### Phase 7：模型和 Provider 设置（P0）

- [ ] 7.1 Provider Profile：OpenAI-compatible、Anthropic、OpenRouter、本地模型等多配置。
- [ ] 7.2 模型能力表：模型名、上下文长度、工具调用、视觉、结构化输出、成本和限流。
- [ ] 7.3 运行参数：默认模型、规划模型、执行模型、fallback、温度、超时、token 上限。
- [ ] 7.4 连接验证：models、chat completion、工具调用三层测试。
- [ ] 7.5 按项目/会话选择模型，保存本次运行使用的模型快照。
- [ ] 7.6 数据控制：API 地址、代理、日志、数据目录、脱敏、临时对话和保留时间。
- [ ] 7.7 验证：无 Key、本地 Key、错误模型、超时、fallback、运行中修改被拒绝。

### Phase 8：统一运行中心（P0）

- [ ] 8.1 Run 记录：runId、sessionId、projectId、mode、scenarioId、model、status、startedAt、finishedAt。
- [ ] 8.2 统一状态：queued/running/waiting-approval/paused/succeeded/failed/cancelled/discarded。
- [ ] 8.3 运行详情：计划、节点、工具调用、参数、输出、错误、耗时、验收和产物。
- [ ] 8.4 控制：暂停、继续、停止、重试失败节点、从节点分支重跑。
- [ ] 8.5 断线恢复：event cursor、快照 revision、重复事件去重、刷新后恢复 busy。
- [ ] 8.6 历史运行：搜索、过滤、回放、重试、运行对比和导出。
- [ ] 8.7 观测：token、成本、延迟、重试次数、能力成功率、模型调用统计。
- [ ] 8.8 验证：并发运行、跨会话隔离、终止后重跑、暂停后恢复、断线重连。

### Phase 9：后台任务和自动化（P1）

- [ ] 9.1 任务创建：一次运行、定时、周期、事件触发。
- [ ] 9.2 任务管理：暂停、恢复、编辑、删除、运行记录、失败重试。
- [ ] 9.3 通知：完成、失败、等待审批、权限过期、能力漂移。
- [ ] 9.4 并发/幂等：同一任务重复触发、锁、超时、预算和最大运行次数。
- [ ] 9.5 验证：重启后任务恢复、重复触发不重复执行、失败通知真实可达。

### Phase 10：桌面上下文（P1）

- [ ] 10.1 本地文件/目录选择器和安全范围。
- [ ] 10.2 IDE/终端/浏览器/笔记应用上下文适配。
- [ ] 10.3 当前窗口/选中文本/最近输出导入对话。
- [ ] 10.4 桌面权限说明、授权状态、禁用和审计。
- [ ] 10.5 验证：关闭权限后能力不可用、上下文范围准确、敏感内容不越界。

### Phase 11：协作和分发（P2）

- [ ] 11.1 项目/场景/产物分享。
- [ ] 11.2 角色权限：查看、使用、编辑、发布、管理。
- [ ] 11.3 评论和审批协作。
- [ ] 11.4 场景模板、导入导出、版本签名和依赖清单。
- [ ] 11.5 跨设备/云端同步和冲突处理。

### Phase 12：质量、迁移和交付（贯穿所有阶段）

- [ ] 12.1 每个 action/schema 有单测。
- [ ] 12.2 每个 UI 入口有 WS/HTTP 集成测试。
- [ ] 12.3 浏览器 smoke：新建、历史、归档、删除、设置、命令、上传、审批。
- [ ] 12.4 真实模型 smoke：解析、规划、工具调用、失败和超时。
- [ ] 12.5 安全审计：Key、路径、文件、连接器、权限、日志、Memory。
- [ ] 12.6 性能测试：大历史、大 Memory、多文件、多连接器、并发运行。
- [ ] 12.7 数据迁移和备份恢复。
- [ ] 12.8 文档：用户手册、命令帮助、设置说明、连接器安装、故障排查和开发者协议。
- [ ] 12.9 发布标准：构建、lint、全量测试、浏览器回归、快照清理、无凭据泄露、未改动 ARES/METIS。

### 推荐实施顺序

1. Phase 0 数据契约和事件协议。
2. Phase 1 工作台壳层与命令面板。
3. Phase 2 对话流和 / 命令。
4. Phase 3 项目/文件/Artifact。
5. Phase 4 Memory 管理。
6. Phase 5 场景前端化。
7. Phase 6 连接器和权限。
8. Phase 7 Provider/模型设置。
9. Phase 8 运行中心。
10. Phase 9 后台任务。
11. Phase 10 桌面上下文。
12. Phase 11 协作分发。
13. Phase 12 全面 QA 和发布。

### 本轮实现状态审计

状态标记：`[x]` 已有实现和针对性证据；`[~]` 有基础实现但仍缺关键闭环；`[ ]` 尚未实现。原始清单中的方框保留作长期跟踪，以下是本轮真实审计结果：

- `[x]` 0.2–0.4：核心产品契约、原子持久化/备份/坏数据恢复、Memory/项目/运行/产物/Provider/任务/连接器仓库。
- `[x]` 0.3、1.6、8.5：WS 快照、eventId/revision/requestId、断线 replay、动作响应关联和重复事件边界。
- `[x]` 1.1–1.6、2.1–2.7、3.1–3.7、4.1–4.7、5.1/5.4/5.6/5.7/5.8、6.1/6.2/6.3–6.7、7.1–7.7、8.1–8.8、9.1–9.5、10.1–10.5、11.1/11.2/11.3/11.4、12.1/12.2/12.5–12.8：已有前端入口、typed action、持久化、针对性回归和真实运行证据；新增连接器信任证据、运行参数/Fallback 观测、任务失败/超时/重启状态、真实场景多样例泛化、Host Bridge、自托管同步和弹窗可访问性。
- `[~]` 1.7、5.2/5.3/5.5、6.8、12.3/12.4/12.9：仍缺窄屏/逐按钮完整浏览器 smoke、场景版本对比与完整结构化构建向导、恶意/过期连接器专项、真实模型服务在线验证；当前浏览器已真实验证面板加载、设置弹窗、模式切换，模型服务因 `127.0.0.1:8317` 未监听而无法完成三层 smoke。
- `[ ]` 11.5 的第三方云端多设备部署：需要外部服务账号/部署目标才能形成完整实现。

这份状态审计防止把“有入口”误判成“功能已经完成”。继续开发应优先处理所有 `[~]` 与 `[ ]` 项，再把方框改为 `[x]` 并补对应证据。

### 每个功能完成的统一标准

- 前端有入口、加载态、空态、成功态、失败态和撤销/重试路径。
- 后端有 typed action、schema 校验、权限判断、幂等处理和持久化。
- 重连、刷新、重启后状态一致。
- CLI 与 Web 调用同一服务层。
- 有针对性单测、集成测试和至少一次真实浏览器验证。
- 不把密钥、隐私数据、内部错误堆栈写入聊天、日志、Memory 或普通快照。

### 2026-10-05 面板交付与运行证据

- 已用当前 `dist/panel-launcher.js` 启动面板服务：`http://127.0.0.1:4320/`；同步服务监听 `http://127.0.0.1:4321/`，对应 PID 41100。
- 已在 Codex 侧边浏览器打开并保持面板标签，真实看到工作模式、场景构建、项目/历史对话/场景库、命令面板、对话流和运行检查台；标签已标记为交付物。
- 本次复核：`npm run build` 通过；`npm run lint` 通过；`git diff --check` 通过；凭据扫描无命中。
- 本地模型服务 `http://127.0.0.1:8317/v1/models` 当前连接被拒绝，因此只能确认面板和同步服务可用，不能声称真实模型回复链路已在线。

### 2026-10-05 构建交互修复证据

- 修复回退重跑后的闸门状态错配：旧 gate 卡片不会再消费同编号的新审批；服务重启后会从 `builds.json` 恢复最近一轮停在闸门上的构建，当前卡片可以继续操作；恢复前的旧卡片会折叠为提示，不再制造死按钮。
- 构建卡片改为自然语言：每步说明“系统正在做什么”和“用户需要确认什么”；任务节点显示为“第 N 步”，能力选择使用可读名称下拉框，验收检查改为“能力可用 / 任务完成 / 换输入仍可完成”。
- 第 5 步在检查未通过时显示原因和可点击的“重新检查一次 / 放弃这次构建”；“检查通过后保存”保留禁用状态，避免把失败结果伪装成可复用场景。
- OpenAI-compatible SSE 改为通过 `ReadableStream` 分块读取并逐块触发 `onChunk`；聊天侧会合并流式片段并保持实时光标。历史技术化阶段文案在渲染时也会转成用户可读描述。
- 定向测试真实通过：`tests/unit/planner.test.ts` 6/6；`tests/unit/state-machine.test.ts` 26/26；`tests/integration/panel-integration.test.ts` 28/28。构建、lint、面板客户端构建、launcher bundle、`git diff --check` 均通过。
- 浏览器证据：侧边浏览器 `http://127.0.0.1:4320/` 已真实走过恢复后的第 2、3、4、5 步；第 5 步卡片显示自然语言说明和可操作的重试/放弃按钮。当前服务监听 4320/4321。
- 真实模型端点仍不可达：`http://127.0.0.1:8317/v1/models` 返回连接被拒绝，所以流式传输代码和 UI 已验证，真实模型 token 流仍需该本地服务在线后才能验证。
- 状态机恢复细节已补齐：从持久化的 `pendingGate` 恢复时跳过已完成阶段处理器，只重新发出当前闸门事件；同时保留一次异步让步，保证 Web/TUI 的 `waitForGate()` 不丢事件，恢复不会重复探活、执行或追加验收记录。
- 最终回归：`npx vitest run tests/unit/planner.test.ts tests/unit/state-machine.test.ts tests/integration/panel-integration.test.ts --testTimeout 10000` 通过，3 个测试文件、60 个测试全部通过；`npm run build`、`npm run lint`、`npm run panel-client`、`npm run bundle`、`git diff --check` 通过。
- 当前交付实例重新启动后监听在 4320/4321，当前 PID 55216；侧边浏览器仍保持交付标签并停在可继续的第 5 步评审卡片。

### 2026-10-05 信息流与闸门卡片重构

- 根据浏览器反馈，移除用户默认视图中的原始闸门文本、依赖编号、流水线箭头、期望输出重复行和已处理卡片编辑表单。
- 新的卡片只保留：这一步要完成什么、当前准备好的内容、用户需要做的选择、一个明确的下一步按钮；技术结构继续放在折叠的高级区域。
- 任务清单改为编号步骤卡片，展示“要完成什么 / 会得到什么”；能力选型展示推荐能力和可读下拉选择；验收与最终评审展示去重后的检查状态。
- 浏览器真实复核已看到新的任务卡片和能力选择卡片；`npm run build`、`npm run lint`、`npm run panel-client`、`npm run bundle`、`git diff --check` 均通过。
- 当前交付实例保持监听 4320/4321，PID 60384；侧边浏览器已保留并显示新版信息流。

### 2026-10-05 自动构建与工作模式验收

- 自动构建不再向普通用户展示闸门卡片；用户输入一句话后，系统自动完成解析、规划、候选兜底、流程组合和定义检查，并固化场景。
- 真实浏览器流程已验证：输入“把一份本地数据整理成周报”→ 自动构建完成 → 场景库显示 `使用 1 · 成功 1` → 工作模式加载同一场景 → 生成 Markdown 执行计划并成功结束。
- 目标外部能力仍保持诚实状态：构建阶段不调用外部工具，场景定义的执行验证状态是 `untested`；工作模式先生成可追溯执行计划，外部工具/模型在线后再执行真实任务。
- 通过内置能力兜底后，联邦检索为空或网络异常不再阻断场景定义；并修复工作模式旧场景能力 ID 漂移导致的直接失败。
- 全量回归曾通过 52 个测试文件、402 个测试；最近核心回归通过 34 个测试（Run、Scenario Definition、Model Client、Panel Integration）。当前面板 PID 50536，监听 4320/4321。

### 2026-10-05 核心闭环重构进展

- 用户目标与拆解写入 `docs/REBUILD_PLAN.md`：一句需求→可持久化场景定义→工作模式加载；区分场景定义完成和外部能力实际执行，禁止用伪执行宣称成功。
- 新增 `src/scenario/definition.ts`：真实的名称、目标、说明、输入、步骤、依赖、产出和验收契约；离线生成明确标记 `generatedBy=local`、`execution=untested`。
- 构建模式默认自动完成，不再把五道闸门暴露给普通用户；内部自动批准只用于状态机兼容，构建阶段只验证流程和能力映射，不调用外部工具。无检索结果时注入明确标记的内置规划能力，避免随机目录结果导致构建必败；胶水边记录运行时提醒，不阻断定义保存。
- 场景记录支持 definition；旧场景没有 definition 时工作模式自动生成兼容定义。工作模式加载场景后生成真实 Markdown 执行计划、写入产物、更新场景使用/成功统计，不再因为旧能力 ID 漂移直接报“不可复用”。
- 新增 `src/panel/model-client.ts`：独立的 OpenAI-compatible SSE 客户端，支持逐块 UTF-8 解码、取消、超时、备用模型、空响应/鉴权/限流错误脱敏；新增 3 个协议测试。
- 修复历史运行恢复：RunSummary 带 sessionId，刷新后右侧检查台恢复最近运行状态和目标；历史会话标题和项目卡片强制换行/截断，侧栏不再出现横向滚动条。
- 浏览器真实证据：在 `http://127.0.0.1:4320/` 新建“把一份本地数据整理成周报”构建，自动完成并固化 `sc-panel-1791144007982`；场景库显示“使用 1 · 成功 1”；切到工作模式加载同一场景，生成“执行计划.md”，场景成功统计保持真实更新；重启后右侧显示运行 succeeded 和目标。
- 当前定向回归：65 个测试通过（planner、model-client、scenario-definition、state-machine、panel integration）；build、lint、panel-client、bundle、git diff check 通过。当前模型 `127.0.0.1:8317` 仍不可达，真实模型生成仍明确降级为本地定义。

### 最终审计（本轮 goal）

- 全量回归真实通过：52 个测试文件、402 个测试；最新核心回归通过 34 个测试。构建、lint、客户端/launcher bundle、git diff check、凭据扫描通过。
- 自动构建真实浏览器流程：一句需求→自动固化→场景库 `使用 1 · 成功 1`；工作模式加载同一场景→生成 `执行计划.md`→运行成功；重启后右侧恢复 `succeeded` 与目标。
- 未完成事项明确保留：`127.0.0.1:8317/v1` 仍离线，模型在线生成和外部工具真实调用不能声称已验证；当前成功定义是“场景定义和执行计划成功”，外部任务执行状态仍为 `untested`。

## 子任务 UI 信息流修复（2026-10-15）
- 针对真实面板历史消息堆叠和流式输出异常，修改 `src/panel/chat-client.ts`：连续非终态运行状态合并为可读过程卡；按用户消息把每次运行聚合为可展开 timeline，旧运行默认折叠、最新运行展开；model-stream 合并为单个 assistant bubble，完成后移除闪烁光标；支持安全的 Markdown-like 标题/列表/代码/链接渲染；滚动保持与“查看最新消息”按钮避免新消息抢滚动。
- 修改 `src/panel/server.ts` 增加 `jump-latest` 与 `run-alert` UI 挂点；右侧 DAG 显示“未运行/等待/完成/失败”等可读状态；候选名称去重；失败运行在检查台显示原因。`panel.css` 增加 timeline、activity、富文本和失败提示样式。
- 验证：`npm run panel-client` 通过；`npx vitest run tests/integration/panel-integration.test.ts --reporter=dot` 通过（1 文件、28 项）；`git diff --check` 通过。`npm run build` 当前被已有 `src/execution/wire-executing.ts:155` 的 `outcome` 未定义错误阻塞，属于并行核心修改，未冒充通过。

## 子任务：调度与执行链路加固（2026-10-15）
- 修复 `src/orchestrator/state-machine.ts`：运行中禁止并发 `run()`；abort 后 `start()` 重置一次性 `AbortController`；回退阶段清理下游 DAG、候选、选型、装配、验收、trace、蒸馏结果，避免旧失败记录污染新分支；`waitForGate()` 在决策等待器已安装时可补发当前闸门请求。
- 修复 `src/orchestrator/handlers.ts`：装配阶段始终按当前 DAG 和候选集规范化 selections，移除规划回退后的陈旧节点/能力。
- 修复 `src/execution/cluster.ts`：上游节点未成功时不再执行下游；新增 `resumeFromTrace`，修复重试时复用成功节点输出、仅重跑失败/阻塞节点，避免重复外部副作用。
- 修复 `src/execution/wire-executing.ts`：修复回路覆盖所有失败节点，并在换型后恢复调度依赖链；重试仍失败会抛出可读 `ACCEPTANCE_FAILED`。
- 修复 `src/execution/repair.ts`：RunController 支持多个并发暂停 worker，resume/terminate 会释放全部等待者；终止回调隔离异常；RepairDeps 可传递失败节点原始 inputs。
- 修复 `src/execution/loop.ts`：GoalLoop 运行前校验 `maxRounds`；修复 `src/execution/capability-runtime.ts`：npx 安装预检检查退出码并传递安装参数，stdio 调用也传递参数。
- 新增 `tests/unit/orchestration-hardening.test.ts`，覆盖 abort 复用、并发 run、防旧验收污染、陈旧选型、上游失败阻断、并发暂停释放、loop 上限和 npx 安装失败。
- 真实验证：`npm test -- --run` 通过，53 个测试文件、410 个测试通过；`npm run build`、`npm run lint` 通过；定向执行/编排回归通过。此前本记录中关于 `wire-executing.ts:155` 的构建阻塞已由本轮修复并复测通过。
- 追加执行安全修复：stdio MCP 驱动现在处理初始化错误、子进程提前退出、stdin 关闭和超时，避免等待 60 秒或重复 resolve；DAG 拒绝空节点和重复 node id，LLM 空 DAG 不再被当成成功构建；验收探活空结果判定失败；新增 1 项 DAG 边界测试。追加验证：`npm run build`、`npm run lint`、4 个定向测试文件共 64 项通过。
- 追加状态机完成性修复：最终 `outcome=completed` 要求装配图每个节点都有 `success` 或构建期 `skipped` trace，空 trace/漏节点不能伪成功；新增对应回归测试。追加验证：状态机/编排 3 文件共 41 项通过，build/lint 通过。
- 验收修复：`ComponentAcceptance` 现在把 smokeInvoke 的 `ok=false` 计为 schema/组件失败，即使返回对象形状正确也不能伪通过；新增回归用例。`acceptance.test.ts` 与调度 hardening 共 29 项通过，build/lint 通过。
- 验收报告边界修复：`AcceptanceReporter` 对空组件结果或空任务结果不再使用 vacuous truth 判定通过，并写入缺失层级归因；本轮 build/lint 与验收定向回归通过。

## 子任务：跨包启动与检索候选链路（2026-10-15）
- 真实面板复现：pi-scenario 端口 4370 上输入“建立一个本地论文写作研究场景”在解析和联邦检索后失败，报 `store.set schema violation ... candidates.0.candidates.1.repoUrl Invalid input: expected string, received null`。根因是外部目录把可选字段写成 null，而 CapabilitySchema 只接受 string/undefined。
- 修复 `src/federation/adapters/adapter-utils.ts`：buildCapability 对 repoUrl/homepage/updatedAt/stars/downloads 做类型归一化，避免候选进入持久化/闸门时破坏 schema；新增 `tests/unit/federation-adapter-contract.test.ts` null 字段回归。
- 修复后重启真实 launcher（4371），WS 走 new-session → set-mode build → start-build，构建完成并固化场景，snapshot run=succeeded；候选从错误前的失败状态恢复。
- 修复后全量 `npm test -- --reporter=dot`：53 个测试文件、410 个测试通过；`npm run build`、`npm run lint`、`git diff --check` 通过。
- 仓库外 cwd 验证：从 `D:\` 直接运行 pi-scenario `dist/panel-launcher.js`（4372）并请求 `/api/snapshot`，HTTP 200；默认数据目录不依赖 cwd。

## 子任务：Ares Pi 包数据与空检索兜底（2026-10-15）
- 修复 `场景智能体/ares-scenario/src/federation/factory.ts` 的数据根解析和空检索：支持包内/源码/env/cwd 多路径；未知赛事请求返回明确标注的 `ares-builtin:workflow-planner`，不伪造赛事规则或正式材料，避免闸3 `no candidates` 崩溃。
- `scripts-kernel-build.mjs` 将 `src/ares-data`复制到 `pi-package/ares-data`；从仓库外 cwd 导入 Ares Pi extension 后真实 `/ares:build` 成功返回 done、7 项选型、5 次闸门决策。
- Ares 定向 `tests/unit/ares-federation.test.ts`：3/3；`npm run build`、`npm run kernel`、`git diff --check` 通过。
- 第一屏层级追加（2026-10-15）：历史会话按 updatedAt 排序，最近 6 条直接展示，其余进行中/已归档折叠；运行 timeline 旧组默认关闭、最新组打开；检查台标题和失败提示 sticky，保证长 DAG 滚动时仍能看到当前运行状态。
- 左栏场景库层级追加（2026-10-15）：默认展示最近 4 个场景，当前 active 场景始终置顶，其余收进“更多场景”；筛选时展示全部匹配，保持可发现性。
- 交互细节追加（2026-10-15）：场景卡父级点击不再抢占内部生命周期/测试/导出/分享按钮；需求输入框按内容自动增高并受 132px 上限约束。最终本轮 panel-client、eslint、git diff --check 通过。

## 子任务：Pi CLI constructionOnly 语义（2026-10-15）
- `/scenario:build` 现在明确调用 `runScenario({ constructionOnly: true })`：只构建场景定义，不调用远程/git/CLI/npx；ExecutionStep 使用 `planned`，结果返回 `verification=untested`，输出提示到工作模式查看真实产出。
- `BuildContext.executionMode`（run/construction）和状态机终态判定已接入；construction 模式仅允许 planned 作为定义完成条件，不把 planned 伪装 success。
- 验证：construction-mode 单测 1/1；npm run build、npm run bundle、npm run lint 全部通过；仓库外 cwd 真实 Pi 扩展命令返回 done + 4 项选型 + 5 闸门决策 + 未执行外部能力提示。
## 子任务：真实工作执行与运行终态审计（2026-10-16）

- 新增 `src/panel/work-execution.ts`：保存场景在工作模式按拓扑逐步调用 `ModelClient`，把项目指令、已索引且在允许根目录内的文件、Memory、桌面上下文和上游输出传入后续步骤；模型缺失返回 `untested/planned`，模型错误返回 `failed`，取消返回 `cancelled`，每种状态都落盘可读 Markdown 产物。
- 面板 `executeSavedDefinition` 已接入该执行服务；模型成功产物为 `ready`，未验证计划为 `draft`，失败/取消为 `failed`，运行记录保留 trace、上下文来源、模型、token 和产物路径。
- 工作上下文禁止预读绕过边界：launch 只冻结文件引用，执行服务用 `realpath` 校验 `allowedRoot` 后读取；即使调用方预填越界 `content` 也会排除。
- 新增 `tests/unit/work-execution.test.ts` 7 项：模型成功/流式片段/上游传递/上下文产物、模型失败与错误脱敏、无模型降级、越界和预加载内容隔离、取消及返回竞态、RunRepository 重启后终态保持。
- 精确证据：该测试文件 7/7；核心执行/面板/模型/运行定向回归在接入后通过；最新全量 `npm test -- --reporter=dot --testTimeout 30000` 实测 55 个测试文件、421 个测试通过；`npm run build`、`npm run lint -- --no-warn-ignored`、`git diff --check` 通过。
- 未完成的外部验证：真实模型端点 `127.0.0.1:8317` 是否在线仍需实际服务；本轮测试使用协议注入模型，不能冒充真实供应商在线证据。

## 真实工作执行补强（2026-10-16）

- `executeSavedDefinition` 已接入真实工作执行服务：按定义拓扑逐步调用 ModelClient，传递上游输出；无 Provider 返回未验证草稿，Provider 失败返回失败产物，取消返回取消状态；关键 artifact/run/definition 持久化失败不再静默吞掉，执行锁用 finally 释放。
- 工作模式真实浏览器验证：无 Provider 时显示“模型 Provider 不可用；已保存未验证的执行记录，不会伪报完成”，不会出现通用“操作失败”重复错误；结果产物为 draft，场景统计不计入成功。
- 安全边界：launch 不预读文件内容，执行服务对项目文件执行 realpath allow-list；预填越界 content 和项目内 symlink 均不绕过边界；二进制文件不送入模型上下文。
- 重启恢复：没有可恢复 checkpoint 的 running work run 在面板启动时标记为 cancelled 并保留原因；有 pendingGate 的 construction build 保留恢复路径。
- 规划器控制流 JSON 不再原样流入聊天区，只显示可读“模型正在整理目标和执行步骤”进度；真实自然语言产出才进入 model-stream。
- 最新验证：全量 `npm test -- --reporter=dot` 通过 **55 个测试文件、421 个测试**；`npm run build`、`npm run lint`、work-execution 7 项、panel integration 28 项、`git diff --check` 通过；launcher `PANEL_PORT=0` 启动验证通过。
- 当前仍不能宣称：本机真实模型服务 `127.0.0.1:8317` 未在线，协议注入模型测试不等于真实供应商在线验证；外部 git/cli/remote 能力仍需宿主/连接器执行。
- 终态可读性补强：工作模式未验证结果在聊天、运行摘要和检查台均显示“未验证/已保存草稿”，不会被用户误看成普通失败或成功；规划器 JSON 控制流继续只显示可读进度。
- 直接指定场景的工作运行现在先加载场景再执行，跳过不必要的 Provider 意图解析，失联模型不会在已知场景前额外阻塞规划超时；build/lint、执行与面板定向回归复测通过。
- 最终全量回归：55 个测试文件、421 个测试通过；build/lint/panel-client/bundle/git diff check 通过，面板保持监听 `127.0.0.1:4320`。

## 真实模型本地 smoke 与最终状态（2026-10-16）

- 使用临时本地 OpenAI-compatible 服务 `127.0.0.1:8399` 做真实 Web 工作模式 smoke：按定义执行 3 个步骤，模型输出进入各步骤，最终生成 `工作结果.md`；smoke 后已停止临时服务并恢复原始远程设置（无 API key）。
- 修复执行 chunk 字段错配：模型输出由 `chunk` 改为 `content`，UI 不再显示空模型卡片。
- 修复未验证终态：工作模式 UI 显示“未验证/已保存草稿”，不再重复显示通用 action error；规划器 JSON 不进入用户对话流。
- 修复工作执行异常锁死、终态 details 覆盖、取消返回竞态、symlink/预加载内容越界、二进制上下文误送模型等问题。
- 当前面板真实监听 `127.0.0.1:4320`；设置已恢复为 OpenRouter 默认地址、无 API key、streaming=true。
- 最终全量证据：55 个测试文件、421 个测试通过；build、lint、bundle、panel-client、git diff check 通过。

## 最终本地模型闭环复核（2026-10-16）

- 临时本地 OpenAI-compatible 服务二次复测：真实浏览器工作模式执行后，DOM 确认包含 `本地模型执行结果`，模型输出确实进入聊天信息流；随后已恢复远程默认设置（无 API key）并停止临时服务。
- 当前交付面板继续监听 `127.0.0.1:4320`；设置接口复核为 OpenRouter 默认地址、`hasApiKey=false`、streaming=true。

## 代理真实模型接入与性能复核（2026-10-16）

- 定位到本机 CLI Proxy API：`127.0.0.1:8317`；带 Bearer 鉴权的 `/v1/models` 与 `/v1/chat/completions` 均返回 200，模型列表包含 `gpt-6.1-sol`。
- 面板已切换到 `http://127.0.0.1:8317/v1`、`gpt-6.1-sol`、代理 key、`timeoutMs=180000`、`maxTokens=4096`，设置状态已真实复核。
- 代理真实构建和工作执行均跑通：完成场景解析/DAG/固化，工作模式按 3 步拓扑执行，生成 ready Markdown 产物，聊天流显示模型自然语言输出，Run status=succeeded。
- 代理初测耗时约 228 秒、总 token 约 16k；已压缩 Memory/桌面上下文、限制上游输出、使用 reasoning 模型兼容的 `max_completion_tokens`、对流式会话做 debounce 持久化。
- 真实工作结果中的信息缺口被模型明确标记，未把场景设计或历史 skipped 节点伪装成论文研究成果。
- 最新全量回归：55 个测试文件、422 个测试通过；build/lint/bundle/panel-client/git diff check 通过。

## 代理模型速度对比（2026-10-16）

- 真实同场景对比：`gpt-6.1-sol` 工作执行成功，约 207 秒 / 16,102 tokens；切换工作执行模型为 `gpt-6-luna` 后同一场景成功，约 146 秒 / 11,413 tokens，产物均为 ready。
- 当前面板配置：规划模型 `gpt-6.1-sol`，工作执行模型 `gpt-6-luna`，代理地址 `http://127.0.0.1:8317/v1`，代理鉴权已生效，工作超时 120 秒、输出上限 1024。
- 该组合在保持真实模型输出和证据缺口说明的同时减少工作等待；若后续任务需要更长正文，可在设置中提高工作模型 token 上限。

## 代理优化后复测（2026-10-16）

- 工作执行上下文进一步收缩为文件 6000 字符、总上下文 12000 字符、上游输出 6000 字符，并对流式会话做 250ms debounce 持久化。
- 当前代理配置真实复核：`baseUrl=http://127.0.0.1:8317/v1`、规划 `gpt-6.1-sol`、执行 `gpt-6-luna`、`maxTokens=1024`、`timeoutMs=120000`、鉴权可用。
- 最终全量回归：55 个测试文件、422 个测试通过；build、lint、bundle、panel-client、git diff check 通过；面板保持 `127.0.0.1:4320`。

## 代理配置最终复核（2026-10-16）

- 当前真实配置保持：规划 `gpt-6.1-sol`、执行 `gpt-6-luna`、`http://127.0.0.1:8317/v1`、代理鉴权、工作超时 120 秒、每步上限 1024；`/v1/models` 返回 200。
- UI 模型上下文 chip 已修复：工作模式终态也显示配置中的真实执行模型，不再显示“默认”。
- 最新全量回归：55 个测试文件、422 个测试通过；build/lint/bundle/panel-client/git diff check 通过；面板保持监听 `127.0.0.1:4320`。

## 当前事实覆盖（2026-10-16 晚间复核）

- 本文件前面关于 `127.0.0.1:8317` 未监听/不可达的条目属于历史复测记录；当前代理进程已监听，带 Bearer 鉴权访问 `/v1/models` 和 `/v1/chat/completions` 返回 200。
- 当前面板设置以 `GET /api/settings` 为准：baseUrl=`http://127.0.0.1:8317/v1`、plannerModel=`gpt-6.1-sol`、model=`gpt-6-luna`、hasApiKey=true、maxTokens=1024、timeoutMs=120000、streaming=true。
- 当前最新运行 `run-1792087427511-3lw82c` 状态 succeeded，模型 gpt-6-luna，产物 ready；当前服务端口 4320 仍在线。

## 工作模式步骤级暂停修复（2026-10-16 深夜复核）

- 发现真实调度缺口：工作模式只把 `RunController` 的暂停状态写入 UI，但执行服务没有调用 `checkpoint()`，暂停后模型请求和后续步骤仍会继续。
- `src/panel/work-execution.ts` 新增可选 `checkpoint` 钩子，在每个步骤开始前等待暂停/继续，并在模型返回后、提交输出前再次检查；终止会沿用现有 AbortSignal，不能把已取消输出提交给下游。
- `src/panel/launch.ts` 将当前运行控制器注入工作执行服务；新增单测覆盖暂停期间不调用模型、释放后恢复三步拓扑。
- 定向证据：`npx vitest run tests/unit/work-execution.test.ts --reporter=dot --testTimeout 30000`，8/8 通过。
- 已重新生成 `dist/panel-chat.js`、`dist/panel-chat.css`、`dist/panel-launcher.js` 并重启面板；浏览器真实复核显示上下文芯片为 `模型 · gpt-6-luna`，服务监听 `127.0.0.1:4320`。
- 下一步：继续审计真实代理运行的每步耗时与暂停/取消 UI 反馈，避免只改后端而遗漏信息流。

## 代理快速工作模型与暂停链路复核（2026-10-16 深夜）

- 真实代理同一场景对比：`gpt-6-luna` 运行 146254ms / 11413 tokens；切换 `gemini-3-flash` 后运行 11145ms / 7491 tokens，状态 succeeded，产物 ready。浏览器聊天区真实看到三步自然语言流式结果和明确的信息缺口。
- 当前设置已按实际效果调整为：地址 `http://127.0.0.1:8317/v1`，工作模型 `gemini-3-flash`，规划模型 `gpt-6.1-sol`，fallback `gpt-6-luna`，maxTokens 1024，timeout 120000，streaming=true。
- `WorkExecutionEvent.step-finish` 现在携带步骤标题和耗时，信息流会显示“完成步骤：…（用时 N 秒）”，长时间运行不再只有空白等待。
- 浏览器 UI 修复：运行状态统一显示中文（已完成/失败/暂停等），模型芯片显示真实工作模型；设置页真实显示代理地址、模型、fallback、token、超时和流式开关；移动 390x844 视口无横向溢出。
- 工作模式重启扫描同时收敛无检查点的 `running` 与 `paused` 记录为 cancelled，避免暂停运行永久卡住。
- 定向证据：work-execution 8/8；`npm run build`、`npm run lint -- --no-warn-ignored`、`npm run panel-client`、`npm run bundle`、`git diff --check` 通过；浏览器真实快速模型运行完成且运行芯片显示 `运行 · 已完成`。

## 最终回归与面板重启复核（2026-10-16 深夜）

- UI 进一步修复：`/help` 不再被压缩成普通“运行过程”长文本，保留为可展开的“命令面板 / 查看全部命令（27）”卡片；浏览器 AX 已真实看到该结构。
- 全量回归：`npm test -- --reporter=dot --testTimeout 30000` 通过 **55 个测试文件、423 个测试**；该命令同时重新生成 panel client、kernel 和 launcher bundle。
- 面板已用最新 `dist/panel-launcher.js` 重启，4320/4321 监听正常；`GET /api/settings` 真实返回代理地址、gemini-3-flash、gpt-6.1-sol、fallback gpt-6-luna、1024 token、120000ms、streaming=true、hasApiKey=true。
- 浏览器重启后复核：顶部显示 `模型 · gemini-3-flash`、`运行 · 已完成`；设置页点击“验证模型连接”真实显示“模型连接验证成功。”；命令卡和自然语言模型输出仍可见。
- 本阶段仍保留的生产边界：外部文件/远程/CLI 能力是否真正执行由宿主连接器和授权决定，模型输出会继续明确证据缺口；不把场景规划或 skipped 节点伪装成外部执行成功。

## Fallback 推理预算与最终 bundle（2026-10-16 深夜）

- `ModelClient` 对 GPT/O 系列 fallback 增加 `reasoning_effort: low`，普通模型不会收到该参数；真实丰富提示直连代理基准从约 39.2s 降至 31.8s，输出仍保留证据缺口说明。
- 协议单测新增并通过：gpt/o 请求使用 `reasoning_effort=low` 和 `max_completion_tokens`，Gemini 请求不带 reasoning 参数；定向 `panel-model-client + work-execution` 13/13 通过。
- 最新全量回归：**55 个测试文件、424 个测试通过**；build、lint、panel-client、bundle、git diff check 均通过。
- 已用最新 launcher 重启面板；4320/4321 监听正常，代理设置与浏览器 AX 再次确认无变化。

## 规划器代理参数兼容性最终确认（2026-10-16 深夜）

- `src/orchestrator/planner.ts` 已与工作模型客户端统一 GPT/O 参数：reasoning 模型使用 `max_completion_tokens`，普通模型继续使用 `max_tokens`。
- 新增规划器协议回归，GPT 与 Gemini 两种请求字段均验证；定向 planner/model-client 12/12 通过。
- 真实代理直连验证：`gpt-6.1-sol` + `max_completion_tokens=16` 返回 HTTP 200、非空文本、finish_reason=stop；没有暴露或记录密钥。
- 最新全量回归为 **55 个测试文件、425 个测试通过**，并已用最新 bundle 重启面板；浏览器仍显示“已连接 / 模型 · gemini-3-flash / 运行 · 已完成”。

## 浏览器 UI 交互复核（2026-10-16 深夜）

- 真实桌面面板复核：代理设置页显示 `http://127.0.0.1:8317/v1`、当前工作模型 `gemini-3-flash`、规划 `gpt-6.1-sol`、fallback `gpt-6-luna`、最大输出 1024、超时 120000、流式开启；点击“验证模型连接”真实返回“模型连接验证成功”。
- 真实移动 390x844 视口：document/body 宽度均为 390，无横向溢出；左侧 rail 与右侧 inspector 正确隐藏；顶部“更多”菜单可展开；命令建议菜单可读。
- UI 修复：`src/panel/chat-client.ts` 新增 `friendlyRunStatus`，运行上下文芯片、运行中心和任务最近运行状态显示中文；`condensedMessages` 排除 `/help ·`，使帮助保持结构化命令卡。面板浏览器复核 AX 显示“命令面板”“查看全部命令（27）”，不再压成运行过程长文本。
- 验证命令：`npm run panel-client`、`npm run lint -- --quiet`、`git diff --check` 通过；浏览器截图/AX 证据已同步主任务。
- 复核末尾发现并已通知主任务：面板进程随后退出，4320 当前短暂无监听；面板设置文件实际为 gemini-3-flash（之前 gpt-6-luna 的记录属于历史状态），需在下次重启后再次确认服务与模型。

### 当前覆盖（同日最终确认）

- 上述“随后退出/短暂无监听”是重启切换期间的中间状态；之后已使用最新 bundle 重新启动，`127.0.0.1:4320` 和同步端口 `4321` 均处于 Listen。
- 重启后的 `GET /api/settings`、浏览器设置页和连接验证均确认当前代理配置为 gemini-3-flash / gpt-6.1-sol / gpt-6-luna fallback；不可再用前面的旧模型或短暂退出状态描述当前事实。

## 代理模型推理预算与延迟审计（2026-10-16）

- 读取真实运行 `run-1792087427511-3lw82c` 的 `runs.json` 与 details.trace：`prepare` 44.536s / 2,954 tokens，`produce` 62.360s / 4,171 tokens，`review` 39.314s / 4,288 tokens；总耗时 146.254s、11,413 tokens。耗时集中在代理上游模型调用，不在本地 DAG、文件或产物落盘。
- 直接带真实代理鉴权的同输入基准：`gemini-3-flash` 三步 3.729s + 3.763s + 3.381s ≈ 10.9s；`gpt-oss-120b-medium` 7.507s + 6.439s + 7.353s ≈ 21.3s；两者均 HTTP 200、finish_reason=stop，并在产出/复核中明确缺口，没有伪执行。`gpt-6-luna` 同类请求约 40–45s/步。
- 真实代理对 `gpt-6-luna` 支持 `reasoning_effort=low`：丰富输入 39.173s→31.782s（约快 19%），仍返回证据约束结果；普通模型不应携带该字段。
- 已在 `src/panel/model-client.ts` 增加可选 `reasoningEffort`，仅对 gpt/o 模型发送 `reasoning_effort`；工作执行器在 `src/panel/launch.ts` 设置为 `low`。新增协议单测，定向 `panel-model-client` 为 5/5，`npm run build` 与相关 eslint 通过。修改尚未重新 bundle/重启面板，待主任务整合后复测。
- 下一步建议：工作模型可在真实代理可用模型中选择 `gpt-oss-120b-medium`（约 21s/三步、输出更长）或 `gemini-3-flash`（约 11s/三步、延迟最低）；规划模型继续使用 `gpt-6.1-sol`。切换需由主任务在面板设置中完成并做一次真实浏览器闭环验证。

## 推理预算补丁验证（2026-10-16）

- `npm test -- --reporter=dot --testTimeout 30000`：55 个测试文件、424 个测试通过；pretest 重新生成 panel-client 与 panel-launcher bundle。
- `npm run build`、目标文件 eslint、`npm run bundle` 均通过。
- 当前工作模型请求对 gpt/o 模型会携带 `reasoning_effort=low`，直接真实代理基准显示丰富输入单步由 39.173s 降到 31.782s；普通模型不携带该字段。
- 额外验证：`gpt-6-luna` + `reasoning_effort=low` + `stream=true` 真实 8317 代理返回 HTTP 200 `text/event-stream`，64 个 chunks、5.754s、103 字符非空内容，流式协议正常。

### 当前最终事实覆盖（2026-10-16 深夜）

- 上述“尚未重新 bundle/重启”是审计中间记录；随后已完成最新 bundle、全量回归并重启面板。
- 当前最新证据：55 个测试文件、425 个测试通过；`GET /api/settings` 为代理 8317/v1 + gemini-3-flash + gpt-6.1-sol + gpt-6-luna fallback；4320/4321 Listen；浏览器 AX 已确认已连接、中文运行状态和结构化命令卡。

## 重启恢复边界单测与最终覆盖（2026-10-16 深夜）

- 新增 `src/panel/run-recovery.ts` 纯判断函数，启动扫描明确区分：无检查点的 running/paused work 必须 cancelled；带 pending gate 的 construction build 保留恢复；终态记录不改动。
- 新增 `tests/unit/run-recovery.test.ts`，覆盖上述三类边界；定向 run-recovery + model-client 8/8 通过。
- 因 reasoning 参数收紧和重启边界补测，最新全量回归为 **56 个测试文件、428 个测试通过**；build/lint/panel-client/bundle/git diff check 均通过。
- 最新 launcher 已重启，4320/4321 Listen；API 设置仍为代理 8317/v1、工作 gemini-3-flash、规划 gpt-6.1-sol、fallback gpt-6-luna；浏览器 AX 显示模型芯片、中文完成状态和命令卡。

## 重启取消时长修复与最终回归（2026-10-16 深夜）

- 重启探针发现 cancelled 运行记录的 `durationMs` 为空；新增 `restartCancellationPatch()`，重启收敛现在同时写入 `finishedAt`、`durationMs` 和原因，运行中心可以显示真实时长。
- `tests/unit/run-recovery.test.ts` 增加时长断言，定向 4/4 通过。
- 最新全量回归：**56 个测试文件、429 个测试通过**；build、lint、panel-client、bundle、git diff check 均通过。
- 最新 launcher 已重启，当前 snapshot latest succeeded / gemini-3-flash / durationMs=9597，代理和面板端口均保持在线。

## 窄屏运行控制与真实性提示最终复核（2026-10-16 深夜）

- 窄屏下右侧检查台隐藏时，新增“更多”菜单中的 `暂停当前运行 / 继续当前运行 / 停止当前运行`，与桌面检查台控制共用同一状态。
- 真实浏览器证据：运行中 AX 显示“暂停当前运行/停止当前运行”；点击暂停后顶部显示 `运行 · 已暂停`；点击继续后真实完成，聊天过程显示每步耗时（3 秒、14 秒、3 秒）。
- 工作执行系统提示强化：历史 skipped、未验证、计划、方案/目录/流程设计只能作为计划或缺口，不能改写为已完成/已执行/已落盘；真实 Gemini 输出已逐步明确 n1-n4 未执行与缺口。
- 最新全量回归：**56 个测试文件、428 个测试通过**；`npm run build`、`npm run lint -- --no-warn-ignored`、`npm run panel-client`、`npm run bundle`、`git diff --check` 通过。
- 最新实际运行记录：状态 succeeded，模型 gemini-3-flash，耗时约 21 秒，产物数量已更新；4320/4321/8317 均保持监听，工作模型配置仍为代理 8317/v1 + gemini-3-flash + gpt-6.1-sol planner + gpt-6-luna fallback。
- 为兼容 legacy GPT chat 模型，`supportsReasoningEffort()` 已限制为 GPT-5/6 与 o-series；`gpt-4o` 单测确认不发送未知字段。

## 代理执行模型切换后的真实闭环（2026-10-16）

- 面板已将代理工作模型切换为 `gemini-3-flash`（规划仍为 `gpt-6.1-sol`，fallback 为 `gpt-6-luna`）。
- 从真实 `C:\Users\lauze\.pi\scenario\runs.json` 复核：`run-1792088638773-ytr09u` succeeded / 11.145s，步骤 4.20s、3.95s、2.95s；`run-1792088702575-lq2mjw` succeeded / 11.634s，步骤 3.09s、4.94s、3.56s。两次三步均 success，真实输出与 token 用量落入 trace，产物 ready。
- 相比此前 gpt-6-luna 真实 146.254s，当前约 12.6 倍加速，且未改为本地伪实现。

## Gemini 输出真实性强化（2026-10-16）

- 发现首次 Gemini 真实工作产物将历史 `skipped` 节点偏乐观表述为完成倾向；在 `work-execution.ts` 系统提示加入硬约束：`skipped`/未验证/计划/待执行只能称计划或缺口；模型生成不证明外部文件、工具、代码或第三方服务执行；方案/目录/流程不等于落盘。
- 真实代理复测同一三步：2.883s、4.255s、3.325s，合计约 10.46s；输出明确 n1-n4 均 skipped、环境搭建未执行。对 hardened 输出文件执行 `rg 已完成|已搭建|已检索|已执行|已验证` 无命中。
- 定向 `work-execution` 8/8、`npm run build`、eslint 通过；已重新 bundle。需重启面板进程使硬化提示进入运行时。

### 当前覆盖与真实文件上下文闭环（2026-10-16 深夜）

- 上述“需重启”是历史中间记录；当前面板进程已重启且真实运行使用了硬化提示。
- 真实上下文闭环：通过面板 WebSocket 上传并索引临时 `real-context-probe.md`，内容含唯一事实 `CONTEXT_REAL_FACT_20261016`；真实场景运行 `run-1792089954768-ij13ih` 使用 gemini-3-flash，status=succeeded，durationMs=11679，3 个 trace 输出均成功，运行详情和落盘 Markdown 产物均包含该唯一事实。
- 验证后已通过真实 `delete-file` action 删除项目记录，并删除本地临时文件；当前 snapshot 不再包含该文件，`Test-Path real-context-probe.md` 为 False。

## 真实进程重启恢复探针（2026-10-16 深夜）

- 临时将工作模型切换为已验证较慢的 `gpt-6-luna`，通过真实面板 WebSocket 启动 `run-1792090170476-n49ktn`，API 快照确认其处于 `running`。
- 主动终止面板 PID 11436 并用最新 launcher 重启；重启后的 `GET /api/runs/run-1792090170476-n49ktn` 显示 `status=cancelled`、`finishedAt=2026-10-15T18:50:10.221Z`、错误为“面板进程重启，运行没有可恢复的执行检查点”。
- 已恢复设置为代理 8317/v1、工作 `gemini-3-flash`、规划 `gpt-6.1-sol`、fallback `gpt-6-luna`；恢复后再次真实运行成功，最新 run status=succeeded、model=gemini-3-flash、durationMs=9597、error=null。
- 重启后端口 4320/4321/8317 全部保持 Listen，服务日志无异常；当前 snapshot busy=false、files=0、artifacts=20。

## 重启后 UI 与最新产物复核（2026-10-16 深夜）

- 浏览器重新加载 `http://127.0.0.1:4320/` 后 AX 显示 `模型 · gemini-3-flash`、`运行 · 已完成`，聊天区保留重启后的真实模型输出和缺口说明。
- 最新真实产物记录：`run-1792090275040-h3q171`，status=succeeded，artifact status=ready，durationMs=9597；当前设置已恢复快速工作模型与 fallback。

## 当前版本构建模型记账修复与回归（2026-10-16 深夜）

- 修复 `src/panel/server.ts` 运行中心模型记账：build run 现在记录实际规划模型，work run 记录实际执行模型，避免把规划请求误显示为 worker 模型。
- `tests/integration/panel-integration.test.ts` 28/28 通过；build、lint、panel-client、bundle、git diff check 通过。
- 最新全量回归仍为 **56 个测试文件、429 个测试通过**；最新 launcher 已重启，当前 snapshot latest work succeeded / gemini-3-flash / durationMs=8300，场景库 10 个，端口保持在线。

## 长会话完整持久化与最终回归（2026-10-16 深夜）

- 修复长期聊天历史丢失：`chatHistory` 现在只保留最近 200 条用于 UI 渲染，`persistedChatHistory` 保存完整会话；重启/切换会话恢复完整历史，`/run retry` 也从完整历史寻找最近用户需求。
- 新增长会话集成回归：205 条消息持久化完整保留，快照渲染窗口保持 200 条，首尾消息均可恢复。
- 最新全量回归：**56 个测试文件、431 个测试通过**；build、lint、panel-client、bundle、git diff check 通过。
- 最新 launcher 已重启，面板/代理在线，当前 snapshot busy=false，任务 0、文件 0、场景 11、产物 29。

## 后台任务超时终止补强与最终回归（2026-10-16 深夜）

- 修复 TaskScheduler 超时分叉：任务等待超时前会检查底层 run，若仍未终态则发送 terminate，避免任务记录 timeout 后模型继续写产物或修改场景统计。
- 最新全量回归：**56 个测试文件、432 个测试通过**；build、lint、panel-client、bundle、git diff check 通过。
- 最新 launcher 已重启，面板/代理端口在线，tasks=0、files=0、scenarios=11、artifacts=29。

## 运行时依赖安全升级审计（2026-10-16 深夜）

- 运行时依赖升级：`pi-mcp-adapter` 3.2.0 → 5.3.1，MCP client 2.0.0 → 2.3.1；同时更新 pi-subagents 0.78.0、pi-hermes-memory 0.9.10、zod 4.6.7 和小版本开发依赖。
- `npm run build`、lint、生态导入/执行定向测试、全量回归全部通过；最新全量 **56 个测试文件、432 个测试**。
- `npm audit --omit=dev` 从 18 个漏洞（12 high）降至 15 个（10 high，0 critical）。剩余风险集中在上游 Pi coding-agent/extract-zip/proxy-agent 依赖链，当前没有安全且兼容的非破坏性升级；未使用 `audit fix --force`。
- 新依赖已实际重启面板验证：busy=false、latest succeeded、代理端口和面板端口在线。

## 未使用高风险依赖移除与安全审计（2026-10-16 深夜）

- 确认 production source 没有 import `pi-agent-loop`、`rpiv-todo`、`pi-loop-designer`、`pi-hermes-memory`；它们只是文档/语义参考，却会带入 Pi coding-agent、extract-zip、proxy-agent 等漏洞链。
- 已从 direct dependencies 和 lockfile 移除；生态导入、build、lint、全量回归均通过，最新全量 **56 个测试文件、432 个测试**。
- runtime `npm audit --omit=dev` 从 15 个漏洞（10 high）降至 **7 个漏洞（2 high、0 critical）**；剩余主要是仍被实际生态依赖使用的 undici/brace-expansion 和 UI KaTeX 链，未做破坏性强制升级。
- 新依赖已实际重启面板，代理、同步服务和最新运行状态正常。

## Node 发布约束与最终回归（2026-10-16 深夜）

- package manifest/lock 新增 `engines.node >=20.0.0`，与 README 和运行时依赖要求一致，避免部署到不支持的 Node 版本后才失败。
- 最新全量回归：**56 个测试文件、432 个测试通过**；build、lint、bundle、git diff check 通过。
- launcher 已重启，当前面板、同步服务、代理端口和最新运行状态正常。

## 依赖文档一致性修复（2026-10-16 深夜）

- README 已修正：明确 pi-agent-loop、rpiv-todo、pi-loop-designer、pi-hermes-memory 只是历史语义参考，不是当前 runtime dependency；实际运行生态只列出当前安装的包。
- 文档修复后全量回归仍为 **56 个测试文件、432 个测试通过**，diff check 通过。

## 依赖锁可复现性复核（2026-10-16 深夜）

- `npm ci --dry-run` 通过，package.json 与 package-lock.json 当前一致，不会覆盖现有 node_modules。

## 运行时端点与工作区边界审计（2026-10-16）

- 发现并修复 WebSocket action 通过资源 ID 操作连接器、Provider、后台任务、Memory、桌面上下文、产物、分享、评论和身份时缺少当前工作区校验的问题；跨工作区 ID 现在统一返回“不存在”，不会修改外部实体。
- 修复 `/api/share/:token` 跨工作区解析：分享链接的 `workspaceId` 必须匹配当前面板工作区，避免外部 token 在 workspace 资源分支上解析到当前工作区数据。
- 新增集成回归覆盖跨工作区 connector/provider/task/memory/context action 与 share token，`tests/integration/panel-integration.test.ts` 定向 **31/31** 通过；`npm run build`、`npm run lint` 通过。
- 重启最新 `dist/panel-launcher.js` 后真实端点复核：`/`、`/api/snapshot`、`/api/settings`、`/api/events?after=0`、`/api/sessions`、`/api/workspace/export`、`/api/host-context/info` 均 HTTP 200；服务端口 4320 与代理 8317 正常监听。状态：busy=false，tasks=0，project files=0。
- 后续补强：归档/恢复/删除项目、删除/索引项目文件、Memory 更新/批量删除、评论创建、运行详情/对比与 Artifact 差异读取均增加当前工作区边界；跨工作区 fixture 统一返回 404/“资源不存在”，不改变外部记录。
- 追加回归后 panel integration **32/32** 通过；`npm run build`、`npm run lint` 仍通过。最新 bundle 已由 targeted test 重建，待主线程最终重启 launcher 后复核。

## 生产依赖清理最终复核（2026-10-16 深夜）

- 运行时只保留实际使用的 direct dependencies；移除未被 production source import 的 pi-agent-loop、rpiv-todo、pi-loop-designer、pi-hermes-memory，保留实际生态验证所需的 pi-mcp-adapter 5.3.1、pi-subagents 0.78.0。
- npm runtime audit 当前为 **7 个漏洞（3 low、2 moderate、2 high、0 critical）**；剩余高危集中在实际生态上游的 undici/brace-expansion 链，未进行破坏性强制升级。
- `npm ls`、生态导入、build、lint、全量回归均通过；最新全量 **56 个测试文件、432 个测试**，新依赖已重启面板并保持代理在线。

## undici 安全 override 验证（2026-10-16 深夜）

- 增加 npm override 将可兼容的 undici 依赖统一到 8.12.2；生态导入、build、lint、全量回归均通过，`npm ls undici` 验证依赖树可安装。
- Runtime audit 仍为 15 个漏洞（0 critical、10 high），主要剩余来自上游 Pi coding-agent / extract-zip / proxy-agent 兼容链；没有执行破坏性 `audit fix --force`。
- 最新全量回归：**56 个测试文件、432 个测试通过**；新依赖已重启面板并确认代理、同步服务在线。

## Artifact 差异接口路径边界修复（2026-10-16 深夜）

- 发现 `/api/artifact/diff` 读取当前版本时没有复用 artifact 路径 realpath allow-list，已补项目/Memory 根目录和 symlink 边界校验。
- panel integration 30/30、最新全量 **56 个测试文件、432 个测试** 通过；build、lint、bundle、git diff check 通过。
- launcher 已重启，当前服务和代理端口在线，工作区任务/文件状态无探针残留。

## 后台任务超时→底层取消真实验证（2026-10-16 深夜）

- 临时切换慢模型并创建 1 秒 timeout 的一次性任务 `task-1792131002467-cytnrh`；调度记录 `lastRunStatus=timeout`、`lastError=scheduled task timeout`。
- 对应底层 run `run-1792131008399-lb6gdw` 在 durationMs=1029 后真实变为 `cancelled`，错误为“运行已取消”，证明超时不会留下继续执行的后台模型。
- 配置和探针任务已清理；恢复代理后 retry 生成 `run-1792131087175-e3ahcs`，status=succeeded、retryCount=1、durationMs=9561。

## 历史持久化失败可见性补强（2026-10-16 深夜）

- `persistSession()` 原先 catch 后静默吞掉历史写盘异常；现在会广播可读的“历史对话保存失败”提示，保留当前内存运行并在后续写入成功时清除错误状态。
- 最新全量回归：**56 个测试文件、431 个测试通过**；build、lint、panel-client、bundle、git diff check 通过。
- 最新 launcher 已重启，面板/代理在线，最新运行仍可恢复，tasks=0、files=0、scenarios=11、artifacts=29。

### 当前运行事实覆盖（同日最终复核）

- 最新 snapshot：busy=false，latest succeeded / gemini-3-flash，场景库 10 个、产物 22 个、项目文件 0 个；4320/4321/8317 Listen。
- 新构建场景 `sc-panel-1792090560412` 的统计已真实更新为 uses=1、successes=1，证明工作复用成功会更新场景生命周期数据。

## 构建收尾持久化失败处理修复（2026-10-16 深夜）

- 发现构建收尾仍有 Memory/Artifact `catch(() => undefined)`，会把持久化失败吞掉；已移除两套 `finishBuild` 路径中的静默 catch，失败现在会进入构建失败处理，不再显示伪完成。
- `npm test -- --reporter=dot --testTimeout 30000` 最新通过 **56 个测试文件、429 个测试**；build、lint、panel-client、bundle、git diff check 通过。
- 最新 launcher 已重启；当前 snapshot busy=false、latest work succeeded、model=gemini-3-flash、durationMs=8300，代理和面板端口在线。

## 设置页 GPT/O 验证探针兼容修复（2026-10-16 深夜）

- 修复设置页 `test-settings` 的 chat completion 与 tools probe：GPT-5/6、o-series 使用 `max_completion_tokens`，普通模型继续使用 `max_tokens`，与真实运行协议一致。
- 最新 launcher 真实临时验证：向代理用 `gpt-6.1-sol` 执行 models + chat completion + tools probe，返回 `{ok:true}`；当前持久设置未被临时参数改变，仍为工作 gemini-3-flash / 规划 gpt-6.1-sol / fallback gpt-6-luna。
- 最新全量回归：**56 个测试文件、429 个测试通过**；build、lint、panel-client、bundle、git diff check 通过。

## 异步启动边界修复与真实复测（2026-10-16 深夜）

- 发现直接工作运行的 `start-build` WS action 会阻塞到模型完成，慢模型下客户端可能误判超时；`PanelServer` 现在创建运行记录后立即返回 `{ok:true}`，终态通过快照、聊天和 RunRepository 异步回报。
- 真实复测：`start-build` action 36ms 返回；后台 run `run-1792091657995-zo6k34` 随后 status=succeeded、durationMs=9253、error=null。
- 最新全量回归：**56 个测试文件、429 个测试通过**；scheduler、panel integration、build、lint、bundle、git diff check 通过。

## 设置验证与真实运行协议统一（2026-10-16 深夜）

- 设置页 `test-settings` 的 chat completion 和 tools probe 已统一 GPT/O 的 `max_completion_tokens` 规则；真实代理临时用 `gpt-6.1-sol` 完成 models + chat + tools 全部验证，返回 ok=true，持久设置未改变。
- 最新全量回归：**56 个测试文件、429 个测试通过**；build、lint、panel-client、bundle、git diff check 通过。

## 异步启动失败分支真实复核（2026-10-16 深夜）

- 临时切断模型地址后，`start-build` action 28ms 返回 `{ok:true}`；后台 run `run-1792091748570-k1l2du` 在 54ms 后 failed，错误清晰、`busy=false`、运行锁已释放。
- 恢复代理后对该失败 run 执行真实 retry，生成 `run-1792091787427-6qyfgc`，status=succeeded、retryCount=1、durationMs=9631；当前配置已恢复 8317/v1 + gemini-3-flash + gpt-6.1-sol + gpt-6-luna fallback。

## 后台任务调度真实闭环（2026-10-16 深夜）

- 通过面板 WebSocket 创建一次性任务 `task-1792091883201-g9pwxy`，schedule=`once`、maxRuns=1、scenario=`sc-panel-1792090560412`。
- 调度器真实触发 run `run-1792091885916-ba7l1y`，task `lastRunStatus=succeeded`、`runCount=1`、`failureCount=0`，运行 durationMs=7837，busy=false。
- 验证后通过真实 `delete-task` action 清理任务；当前 snapshot 不再包含该探针任务，后台调度链路与异步 start-build 兼容。

## Artifact 分享工作区边界修复与最终回归（2026-10-16 深夜）

- 修复分享中心 Artifact 归属校验：创建分享令牌时现在必须确认 artifact.workspaceId 等于当前工作区，避免跨工作区资源泄露。
- 新增 panel integration 回归“其它工作区 artifact 不可分享”，定向 30/30 通过。
- 最新全量回归：**56 个测试文件、432 个测试通过**；build、lint、panel-client、bundle、git diff check 通过。
- 最新 launcher 已重启，当前服务、代理、同步端口在线，tasks=0、files=0、scenarios=11、artifacts=29。

## 流式规划 usage 观测补强（2026-10-16 深夜）

- 发现 OpenRouterPlanner 的 SSE 流式分支没有读取响应 usage，构建成功但 tokenCount 可能为空；已解析流式 usage 并写入 `lastUsage`，供运行中心成本/用量记录。
- 新增 planner SSE usage 单测；最新全量回归：**56 个测试文件、430 个测试通过**。
- build、lint、panel-client、bundle、git diff check 通过；最新 launcher 已重启，当前 snapshot latest succeeded / gemini-3-flash / durationMs=7837，代理和面板端口在线。

## 真实构建流式 usage 落盘验证（2026-10-16 深夜）

- 用当前 launcher 真实构建“流式用量记录探针场景”，run `run-1792092168628-rc4dak` status=succeeded，durationMs=30022，`tokenCount=2671`，planner actual=llm、attempts=2、无 fallbackReason；证明 SSE usage 已进入 RunRepository。
- 探针场景 `sc-panel-1792092178695` 已通过真实 `archive-scenario` action 归档，后台任务仍为 0，当前持久化配置未改变。

## 失败→重试真实调度闭环（2026-10-16 深夜）

- 临时把模型地址切到不可用本地端口，真实运行 `run-1792091430774-2ot1v6` 生成 failed，durationMs=51，错误为脱敏后的“连接不到模型服务”，场景 uses 从 1 增至 2、successes 保持 1。
- 恢复代理后真实执行 `retry-run`，生成 `run-1792091460795-5nj1dq`，status=succeeded、retryCount=1、durationMs=11206；场景统计最终 uses=3、successes=2。
- 验证了失败不会伪增成功，重试会保留原场景和 retryCount，并在修复配置后生成 ready 结果；当前设置已恢复 8317/v1 + gemini-3-flash + gpt-6.1-sol + gpt-6-luna fallback。

## 当前代码版本场景构建到工作复用闭环（2026-10-16 深夜）

- 通过当前 launcher 和代理重新执行构建需求“建立一个本地数据周报整理场景”：run `run-1792090551458-rbgzpy`，mode=build，status=succeeded，durationMs=28750，planner requested/actual 均为 `llm`，traceCount=4，outcome=completed。
- 构建结果已持久化为场景 `sc-panel-1792090560412`，名称“建立一个本地数据周报整理场景”，版本 1，场景库数量由 9 增至 10。
- 立即用该新场景进入工作模式：run `run-1792090616273-8k6xrw`，mode=work，status=succeeded，model=gemini-3-flash，durationMs=8300，产物“建立一个本地数据周报整理场景 工作结果.md”状态 ready；构建→持久化→复用链路真实闭环通过。

## 真实产物版本与差异闭环（2026-10-16 深夜）

- 对真实工作产物 `artifact-run-1792090616273-8k6xrw-result` 执行 `version-artifact`，状态保持 ready，版本从 v1 升为 v2。
- `GET /api/artifact/diff?id=artifact-run-1792090616273-8k6xrw-result&from=1&to=2` 返回 HTTP 200，返回 3269 字符差异文本；产物版本、落盘文件和差异接口真实连通。

## start-build 终态收敛与旧任务竞态防护（2026-10-16）

- 审计发现：`start-build` 在 `scenarioId` 不存在时已创建 failed run，但内存 `run` 仍为 running，busy/UI 会卡住；异步 `onStartBuild` 返回 `{ok:false}` 时只更新仓库，未推送终态聊天/快照；旧任务晚到结果还可能污染新 run。
- 修复 `src/panel/server.ts`：前置场景失败和后台拒绝都推送 terminal failed、解除锁并刷新快照；后台回调增加 `runId` 守卫；终态落库优先使用机器可读 `message.error`，界面继续显示可读 `message.text`。
- 同轮审计补充项目归档/恢复/删除、项目文件索引/删除的 workspace 归属检查，以及 Memory ID 路径匹配和批量删除的 workspace 检查。
- 新增面板集成回归：`start-build 在前置校验失败或后台拒绝时都收敛为失败终态`。
- 验证：`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`，**32/32 tests passed**；预测试同时完成 panel-client、kernel/launcher bundle。

## 2026-10-16 UI 流式渲染合帧（/root/ui_browser_audit）
- 发现：`pushMessage` 对每个 `model-stream` chunk 立即调用 `renderChat()`，该函数会对最多 200 条消息执行 `replaceChildren()` 并完整重绘，长输出时造成高频重排、滚动跳动和输入区卡顿风险。
- 修复：`src/panel/chat-client.ts` 增加 `scheduleChatRender()`，使用 `requestAnimationFrame`（无 RAF 时 `setTimeout(0)`）合并同一帧内的多次消息渲染；消息列表和历史持久化语义不变。
- 验证：`npm run panel-client` 通过；`npm run build` 通过；`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot` 32/32 通过；服务 127.0.0.1:4320 HTTP 200，`/panel.js` 与 `dist/panel-chat.js` SHA-256 一致。
- 限制：当前子代理的 IAB visibility 被平台限制，无法在浏览器内截图；待主代理完成最终视觉复核。

## Codex 风格 UI 重构与真实闭环复测（2026-10-16）

- 根据 OpenAI 官方 Codex 产品页对桌面界面的公开描述（任务主界面、侧栏任务列表、进度细节和审阅面板）重新收敛视觉语言：`src/panel/panel.css` 追加中性石墨黑皮肤，移除蓝紫渐变和大阴影，统一 54px 顶栏、224px 侧栏、292px 检查台、低噪声边框、紧凑按钮、文档式模型输出、扁平用户消息、运行时间线和弹窗控件，并保留 1120/720 响应式断点。
- `npm run panel-client` 生成 `dist/panel-chat.css` 51.7KB；真实 `GET http://127.0.0.1:4320/app.css?v=20261003-3` 返回 HTTP 200，响应包含新石墨色 token。
- CUA 真实刷新 `http://127.0.0.1:4320/`：截图确认新版布局；AX 显示中文工作模式、聊天信息流、历史会话、场景库、运行检查台和产物入口均可见。
- 通过真实 UI 输入“验证当前工作模式在最新面板上的可用性”：代理 `gemini-3-flash` 实际运行 `run-1792139024081-tmzsk9`，status=succeeded，durationMs=10421，artifact 数量从 31 增至 32，场景 uses/successes 从 9/6 增至 10/7；不是 mock。
- 最新全量回归：**56 个测试文件、434 个测试通过**；`npm run build`、`npm run lint`、`npm run bundle`、`git diff --check` 通过。
- 面板仍由最新 launcher 监听 `127.0.0.1:4320`，同步服务监听 `127.0.0.1:4321`（Bearer token），代理 `127.0.0.1:8317` 在线。

## 聊天信息流与移动端细节复核（2026-10-16）

- `src/panel/chat-client.ts` 为运行时间线增加稳定 `groupId` 和内存中的展开状态，`details` 的手动折叠/展开在流式重绘和快照刷新后保留。
- 修复聊天滚动边界：只有首屏、快照切换和用户提交新请求会显式滚到底部；普通流式 chunk 不再因为 `scrollTop === 0` 把正在阅读历史的用户强制拉到底部。跳转按钮补充可读的 ARIA 标签，聊天根节点在模型流期间标记 `aria-busy`。
- 复制按钮改用 Clipboard API + `execCommand` 安全 fallback，移动/触摸端始终显示，代码块和长文本增加横向滚动、换行与 reduced-motion 处理。
- 验证：`npm run panel-client`、`npm run build`、`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`（32/32）、`npm run lint`、`git diff --check` 全部通过；当前无法从本子代理访问主代理的 IAB 标签，需主代理复核真实截图。

## 2026-10-16 侧栏与移动端响应式打磨（sidebar_mobile_polish）
- 目标：让项目/历史/场景侧栏在桌面保持低噪声密度，并使移动端可达、可关闭、无横向溢出。
- 修改：`src/panel/server.ts` 增加 `#open-rail` 移动入口、`#rail-backdrop` 遮罩、`#workspace-rail` 语义 id；`src/panel/chat-client.ts` 增加 `setRailOpen()`、移动抽屉开关、遮罩和外部点击关闭；`src/panel/panel.css` 增加 1120/720 断点重排、项目/会话/场景操作 hover/focus 折叠、移动端固定抽屉与检查台 top 修正。
- 证据：`npm run panel-client` 成功；`npm run build` 成功；`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`：1 文件、32 测试通过；重启面板后真实 1280x720 DOM 复核：viewport 1280x720，document scrollWidth=1280、clientWidth=1280，rail 224px / chat 764px / inspector 292px，open-rail 桌面隐藏，rail-backdrop 隐藏；截图确认项目操作按钮不再常驻挤在项目卡右侧。
- 移动端验证限制：当前 CUA IAB 仅暴露固定 1280x720 视口，未提供 viewport override；因此 720/390 断点通过源码 specificity/build 检查，未声称真实移动截图已完成。移动入口 selector 使用 `.topbar > .responsive-rail-toggle` 覆盖旧隐藏规则，抽屉/遮罩逻辑已编译进 `dist/panel-chat.js`。
- 下一步：主 agent 应在有可调 viewport 的浏览器环境中复核 390/720/1120 三个尺寸的抽屉可达性。
- 追加细节：移动顶栏搜索/设置/更多改为图标化尺寸，避免 390px 文本撑宽；721-1120/移动 utility-menu 分别下移到顶栏下方（58/56px）。`npm run panel-client` 再次通过（dist/panel-chat.css 57.8kb）。

## 聊天信息流、侧栏与移动端第二轮精修（2026-10-16）

- `src/panel/chat-client.ts`：运行分组新增稳定 `groupId`，历史运行手动展开/折叠状态在流式重绘后保持；新增 `chatNeedsInitialScroll`，只有初次快照或新提交需求时自动到底部，用户阅读历史时不会被每个 token 拉回底部；最新消息按钮补 `aria-label`；复制按钮支持 Clipboard API 与 `execCommand` fallback，嵌入 HTTP 环境不可用 Clipboard API 时仍有降级路径。
- `src/panel/panel.css`：长文本限制为可读列宽，代码块独立横向滚动；触摸设备始终显示复制操作；增加 safe-area、reduced-motion、overscroll 和移动断点细节。
- `src/panel/server.ts` + `src/panel/chat-client.ts`：移动端增加 `#open-rail` 入口、`#workspace-rail` 侧栏抽屉与 `#rail-backdrop` 遮罩，支持按钮、遮罩、外部点击关闭；桌面项目/会话/场景操作改为 hover/focus 展开，减少常驻按钮挤压。
- 真实最新 launcher 已重启；CUA 桌面截图显示聊天文档流、历史运行折叠、右侧检查台和压缩侧栏正常；布局测量 `viewport=1144x904`、`documentWidth=clientWidth=1144`、rail=224px、chat=628px、inspector=292px，当前无横向溢出，聊天仍保留滚动位置。
- 侧栏 agent 在 1280x720 环境验证 `scrollWidth=clientWidth=1280`、rail=224/chat=764/inspector=292，桌面入口隐藏；390/720 媒体规则完成源码 specificity/build 检查，但当前 CUA IAB 没有 viewport override，因此未虚称完成真实移动截图。
- `npm run panel-client`、`npm run build`、`npm run lint`、`git diff --check` 通过；面板集成 32/32 通过；最新全量回归 **56 个测试文件、434 个测试通过**。

## 第二轮 UI 最终回归与运行态复核（2026-10-16）

- 全量 `npm test -- --reporter=dot --testTimeout 30000`：**56 个测试文件、434 个测试通过**。
- `npm run build`、`npm run lint`、`npm run panel-client`、`npm run bundle`、`git diff --check` 全部通过。
- 最新运行态：面板 `4320`、同步 `4321`、代理 `8317` 均 Listen；`busy=false`、`run.status=succeeded`、`artifacts=32`、`scenarios=11`；设置仍为工作 `gemini-3-flash`、规划 `gpt-6.1-sol`，API Key 仅以脱敏状态返回。
- CUA 最终桌面截图复核：聊天信息流、运行时间线折叠、右侧检查台和压缩侧栏正常；布局 `documentWidth=clientWidth=1144`，无横向溢出。移动断点已完成源码/build 检查，当前 IAB 无 viewport override，未虚称移动截图已完成。

## 状态机交互审计（2026-10-16）
- 目标：消除模式切换、重复启动、运行控制和重启恢复中的状态矛盾。
- 修改：`src/panel/server.ts` 为 start-build 增加 sessionLocked/运行态幂等门；set-mode 跨模式时保留聊天但清空旧终态 run/lastBuildContext 并解绑旧 orchestrator；terminal 消息按 runId 归属，旧异步终态不得污染当前检查台；control 仅允许 running→pause、paused→resume、running/paused/waiting-gate→terminate，空闲控制明确拒绝；restoreRunForSession 同步 sessionLocked；新增 reconcileRunState。
- 修改：`src/panel/launch.ts` 在重启取消孤儿 run 后调用 `panel.reconcileRunState()`，避免面板 ghost busy/running。
- 测试：`tests/integration/panel-integration.test.ts` 新增跨模式边界测试并修正控制测试先建立权威活动运行；面板集成 **33/33 passed**。命令：`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`。
- 证据：前置脚本真实重建 `dist/panel-chat.js`、`dist/panel-chat.css`、`pi-package/dist/kernel.js`、`dist/panel-launcher.js`；无失败测试。
- 后续：主代理需在全量回归中复核本状态变更与其它并行修改的合并关系。
- 追加复测：`npm run build` 通过；`npm test -- --reporter=dot --testTimeout 30000` → **56 个测试文件、435 个测试通过**（新增跨模式测试计入）。

## 交互逻辑审计与失败回退修复（2026-10-16）

- 真实复现发现：工作模式没有可复用场景时只显示“请切换到场景构建”，没有下一步操作；用户需要自己理解并寻找顶部模式切换。
- 修复：`launch.ts` 在该终态消息中保留原始 requirement 和 `switch-to-build` action；`chat-client.ts` 渲染内联“切换到场景构建”按钮，点击后切换模式、把原需求重新放回输入框、聚焦输入框并更新发送状态；当前真实 CUA 复核可见该按钮，点击后 `mode=build`、输入框保留“你好2”、`run={kind:"idle",status:"idle"}`。
- 状态机审计修复：重复 start-build 在运行中被拒绝；control 仅允许与当前状态匹配的 pause/resume/terminate；终态事件带 runId 归属，旧异步结果不会污染新运行；打开历史会话和面板重启会同步 `sessionLocked`，孤儿运行会收敛；模式切换保留聊天历史但清除旧运行检查台。
- 最新面板集成：**33/33 tests passed**；全量回归：**56 个测试文件、435 个测试通过**。
- `npm run build`、`npm run lint`、`npm run bundle`、`npm run panel-client`、`git diff --check` 通过；最新 launcher 已重启，面板/同步/代理端口在线。

## 左侧信息架构重构（2026-10-16）
- 目标：解决项目、模式、历史、场景平铺造成的侧栏认知负担。
- 实施：`src/panel/server.ts` 侧栏改为三段职责区：工作区/项目、会话/对话、能力/场景；项目工具与场景库使用原生 details 折叠；保留旧 DOM id 和 action 协议。
- 实施：`src/panel/chat-client.ts` 项目列表排序为当前项目→置顶项目→名称，并为当前项目添加 `aria-current=page`；动态场景分组改名为“全部场景”。
- 实施：`src/panel/panel.css` 增加层级标题、分组、折叠入口、移动端布局规则。
- 证据：`npm run panel-client` 成功；`npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` 33/33 通过；重启面板后真实 CUA AX 显示三段结构，项目工具可展开，场景导航可折叠；截图确认左栏视觉分组清晰。
- 下一步：主代理继续走新建对话、历史切换、暂停/停止/重试、失败恢复和移动端抽屉真实路径，合并本阶段证据。

## 真实用户路径审计与左侧信息架构重构（2026-10-16）

- 真实 WS/API 路径已走通：新建对话→归档→恢复并打开→删除；运行→暂停→继续→停止；移动侧栏导航点击后自动收拢，Escape 关闭抽屉/检查台/更多菜单并恢复焦点。
- 修复归档对话恢复后仍停留在空白会话的问题：恢复操作现在会解档并直接打开目标对话，恢复聊天、模式、场景和运行检查台。
- 左侧从多个同级堆叠区重构为三组职责：`工作区 / 项目`、`会话 / 对话`、`能力 / 场景`；项目工具折叠到“项目工具”，场景库折叠到“能力 / 场景”，场景历史改为“全部场景”，减少视觉噪声。
- 会话导航过滤非当前的 `0 条消息` 空会话，避免重复新建对话留下大量“新对话”空壳；当前草稿仍可见。
- 当前 CUA 真实截图和 AX 已确认三组左栏结构生效；面板运行 `busy=false`、run idle、4320/4321/8317 在线。
- 最新面板集成：**33/33**；最新全量回归：**56 个测试文件、435 个测试通过**。
- `npm run build`、`npm run lint`、`npm run panel-client`、`npm run bundle`、`git diff --check` 全部通过。
- 移动端仍受当前 IAB 无 viewport override 限制，抽屉逻辑和断点已完成编译/桌面结构验证，未虚称完成 390px 截图。

## GoalLoop / 后台长程边界审计与调度项目隔离（2026-10-16）

- 真实审计：`PanelServer.attachLoopEvents` 只有 API 定义，`launch.ts` 未创建或挂接 `GoalLoop`；`ReactorBridge` 与 `startLocalWebhook` 仅在单元测试使用，生产启动器不启 `pi-reactor` daemon；`PermissionGate` 也未由 panel launcher 注入。当前 UI 不能创建真正状态化长程循环场景，后台任务仅支持 `once`、`every`、每日 `HH:mm`、`event:*`，每次都是独立工作运行。
- 底层补强：`src/execution/loop.ts` 增加可选 `AbortSignal`、`runRound` 信号透传、`onRoundStart`/`onRoundEnd` hooks，取消在轮次开始/结束、目标判断和放行门边界收敛，禁止迟到的 goal judge 把已取消循环报告为完成；`panel-client.js` 将 cancelled 显示为“已取消”。
- 调度隔离修复：`start-build` 协议新增可选 `projectId`，后台任务、retry、branch 保留任务绑定项目；服务端校验项目属于当前工作区，运行记录和 launcher 回调携带该项目；`launch.ts` 的上下文读取、Provider 选择、工作产物使用执行项目，而不是当前 UI 项目，避免切换项目后后台任务误读/误写。
- 验证：`npx vitest run tests/unit/execution-base.test.ts --reporter=dot --testTimeout 30000`：31/31；`npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`：34/34；`npm run build`：通过；`npm run panel-client`：通过。另补充 round-start hook 取消测试，确保被取消轮次不会启动 runRound。
- 边界：本阶段没有虚构 UI 已支持长程场景；要提供真正长程能力仍需新增持久化 loop 定义、轮次/检查点恢复、面板创建入口，并显式装配 reactor/webhook。
- 全量复测（补充 round-start 边界后）：`npm test -- --reporter=dot --testTimeout 30000` → **56 个测试文件、439 个测试通过**；前置重建 panel client、kernel 和 launcher 均通过。

## 场景入口、命名与长程边界复核（2026-10-16）

- 新建对话现在弹窗选择启动场景；选择后服务端校验 active 场景、持久化 `session.activeScenarioId`，发送需求直接使用该场景；空白对话保留自动匹配。
- 场景管理从左侧卡片堆叠移到独立“场景库 / 管理”入口；真实 AX 复核场景弹窗包含 11 个场景，选择场景后真实 snapshot 返回 activeScenarioId，弹窗自动关闭。
- `scenarioNameFromRequirement()` 清理“请帮我/需要”等前缀、按首句截断并为重名追加“（2）”；launch 两条固化路径均改用正常标题，完成消息显示自然名称。
- 修复旧场景读取时未经过 `ScenarioRecordSchema` 的兼容问题，避免新建对话选择历史场景被误报“场景不存在或已归档”。
- GoalLoop 已具备 maxRounds、AbortSignal、roundGate、onRoundStart/onRoundEnd 和取消边界；但当前 panel/launch 未创建 GoalLoop，ReactorBridge 未启 daemon，PermissionGate 未由 launch 注入，UI 仍不能建立真正状态化长程循环。当前可用范围是有限步骤场景和 TaskScheduler 定时重复短运行。
- 后台任务 projectId 隔离补强：run-task/retry/branch 保留绑定项目，执行上下文、Provider 和产物路径使用绑定项目。
- 最新全量回归：**56 个测试文件、438 个测试通过**；panel integration **34/34**；execution loop 精准测试 30/30；`npm run build`、`npm run lint`、`npm run panel-client`、`npm run bundle`、`git diff --check` 通过。
## 运行目标绑定与异步竞态审计（2026-10-17）

- 发现：面板运行期间允许 `select-project`，而 launcher 的构建/恢复回调会在异步完成时读取可变的 `panel.current*`；用户终止旧运行后快速开始新运行，旧回调可能把 Memory/Artifact 写入新项目/会话，或更新错误的 run。
- 修复：`src/panel/server.ts` 在 `sessionLocked` 时拒绝切换项目；`src/panel/launch.ts` 增加不可变 `RunBinding`（run/workspace/project/session），工作与恢复构建的上下文、Memory、Artifact、usage 和终态落库均使用启动时绑定；迟到构建结果只更新仍处于活动态的原 run，不覆盖已取消/终态记录。
- 新增面板集成回归：运行期间切换项目被拒绝，旧运行最终失败后当前项目仍保持原绑定。
- 证据：`npm run build` 通过；`npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`，35/35 通过。
- 残余风险：主启动器的真实构建→停止→立即新建运行竞态仍需在代理在线时做一次端到端验证；当前单元/集成测试覆盖的是 PanelServer 边界和绑定逻辑。

## PersistentGoalLoop hook 错误收敛（2026-10-17）

- 审计发现：长程循环的 `onRoundStart` / `onRoundEnd` hook 直接抛错会穿出 `run()`，持久化记录仍停在 `running`，重启前无法判断是否失败。
- 修复：`src/execution/persistent-loop.ts` 捕获两个 hook 的异常并写入 `failed` 终态与截断错误；轮次结束 hook 在检查点已提交后失败时保留已完成轮次，避免重复执行。
- 回归：`tests/unit/persistent-loop.test.ts` 新增开始/结束 hook 异常各一条，`npx vitest run tests/unit/persistent-loop.test.ts --reporter=dot --testTimeout 30000`，5/5 通过。

## Panel terminal runId 竞态收敛（2026-10-17）

- 审计发现：`PanelServer.pushChat` 的终态异步持久化在第一次 `await` 后再次读取可变的 `this.run.runId`；旧运行终态到达后若用户已启动新运行，可能把新 run 更新为旧终态。
- 修复：捕获 `terminalRunId` 与对应编排上下文后，异步落库全程使用不可变 ID。
- 回归：面板集成新增旧终态与新运行竞态测试；`npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`，36/36 通过。

## WebSocket 输入边界（2026-10-17）

- 审计发现：WS 动作此前没有消息大小上限，任意大帧会先进入 JSON 解析与 Zod 校验，可能占用面板内存/CPU。
- 修复：`src/panel/server.ts` 在解析前拒绝超过 64 KiB 的 WS 消息并返回明确 action-result；HTTP JSON body 原有 64 KiB 上限保持不变。
- 回归：面板集成新增超大 WS 消息测试；当前面板集成 **37/37** 通过。

## WebSocket 断线发送保护（2026-10-17）

- 审计发现：慢动作处理期间浏览器断开连接，异步 action-result / 初始 snapshot 回调仍直接调用 `ws.send`，可能抛出“WebSocket is not open”并产生未处理异常。
- 修复：连接级 `sendIfOpen` 统一保护初始快照、resume、超大消息错误、动作成功/失败响应和 malformed 响应。
- 回归：面板集成 **37/37** 仍通过；`npm run build` 与 `npm run lint` 通过。

## 调度器输入与异常边界（2026-10-17）

- 审计发现：`every 0s` 会被视为立即到期；在无 `maxRuns` 时可能每个调度 tick 重复触发。
- 修复：`isDue` 拒绝零/负/非有限间隔；`TaskScheduler.start` 为初始 tick 和定时 tick 捕获拒绝并写入 stderr，避免后台 Promise rejection 污染进程。
- 回归：`tests/unit/scheduler.test.ts` 新增零间隔测试，3/3 通过。

## 调度器活动运行跳过语义（2026-10-17）

- 审计发现：调度器在用户已有活动运行时触发 `run-task`，原本会把“当前运行尚未结束”写成任务失败并递增 `runCount`，导致一次资源冲突消耗掉任务机会。
- 修复：`ScheduledTaskRunResult.skipped` 让调度器跳过本轮持久化；launcher 对面板 busy 返回 skipped，下一调度 tick 可再次尝试。
- 回归：调度器测试新增占用跳过用例；`tests/unit/scheduler.test.ts` 4/4 通过。

## 运行期间项目导航收口（2026-10-17）

- 补充审计发现：虽然已禁止 `select-project`，但 `create-project` 仍可在运行中创建并自动切换当前项目，造成 UI 项目与运行绑定脱节。
- 修复：`create-project` 与选择/归档/删除项目一样，在活动运行期间返回“当前运行中不能切换项目”；集成测试覆盖创建和选择两条入口。
- 回归：面板集成 37/37 通过。

## Artifact 路径读取边界（2026-10-17）

- 审计发现：无项目运行产物落在独立 runs 目录，但面板 Artifact 读取只允许项目/Memory 根；同时当前项目目录尚未创建时，根目录 `realpath` 失败会把合法产物误报 404。
- 修复：PanelDeps 增加 `artifactRoot`，生产启动器接入 data/runs；Artifact 读取与 diff 使用该根，并把不存在的候选根过滤掉；diff 对项目产物按 Artifact 自身 projectId 校验工作区后解析根，避免切换当前项目后误拒历史产物。
- 回归：新增无项目运行产物读取测试；面板集成 **38/38** 通过，`npm run build` 通过。

## 停止终态抗迟到事件（2026-10-17）

- 审计发现：用户终止后，旧 worker 仍可能发送同一 runId 的成功/失败终态；原 `pushChat` 会按同一 runId 接受并把 `cancelled` 运行复活。
- 修复：当前 run 已是 `cancelled` 时，忽略同 runId 的非 cancelled 迟到终态，只保存聊天历史，不改运行快照和持久化行。
- 回归：面板集成新增停止后迟到成功事件测试；当前面板集成 **39/39** 通过。

## 恢复构建失败事件绑定（2026-10-17）

- 审计发现：重启恢复构建的 `failBuild` 终态消息未携带 runId；旧恢复任务在用户开启新运行后失败，可能被当前面板误收为新运行失败。
- 修复：`failBuild` 接收并传递恢复 runId，同时补齐机器可读 `runStatus/error`。
- 回归：`npm run build`、面板集成 39/39 通过。

## 2026-10-17 全量回归

- `npm test -- --reporter=dot --testTimeout 30000`：**57 个测试文件、452 个测试通过**；前置 `panel-client`、kernel 和 launcher bundle 均通过。
- 本轮额外精准证据：面板集成 39/39、调度器 4/4、PersistentGoalLoop 5/5（并行长程分支当前文件另含检查点/隔离用例）；`npm run build`、`npm run lint`、`git diff --check` 通过。


## 持久化长程运行最小内核（2026-10-17）
- 审计确认：现有 GoalLoop 只有内存轮次与 hooks，panel/launch 未装配 GoalLoop；要避免重启后伪造完成，需要独立 durable control record。
- 新增 `src/product/contracts.ts`：LongRunSchema，持久化 workspace/project/session/scenario 归属、goal、maxRounds、nextRound、completedRounds、last round summary/metrics、pauseRequested、revision、terminalReason。
- 新增 `src/product/long-runs.ts`：LongRunRepository，workspace 过滤、revision 乐观并发检查、recoverAfterRestart 将 running 安全标为 paused，保留 nextRound 检查点。
- 新增 `src/execution/persistent-loop.ts`：PersistentGoalLoop。每轮先提交 checkpoint 再执行 goalCheck/gate；支持 pause/stop/resume、AbortSignal、控制写入竞争重试；maxRounds 进入 failed + terminalReason=max-rounds，禁止伪装成功。
- 新增 `tests/unit/persistent-loop.test.ts`：4/4 通过，覆盖目标完成、暂停恢复、重启孤儿运行、轮次上限失败。
- 证据：`npm run build -- --pretty false` 通过；`npx vitest run tests/unit/persistent-loop.test.ts --reporter=dot --testTimeout 30000` → 1 文件、4 测试通过。
- 当前边界：尚未接 PanelAction、launch 真实 worker、场景定义 UI；接入仍需把 scenarioId/workspace/session 绑定到长程记录，创建控制入口并在重启时调用 recoverAfterRestart。
- 复核修正：初版“提交轮次后立即推进 nextRound”会在目标判断/人工闸门前重启时丢失待判定结果；已改为 `pendingRound/pendingResult` 两阶段检查点。运行副作用完成后先记录待判定结果，goalCheck/roundGate 完成后再推进 `nextRound` 并清空 pending。
- 追加回归：重启待判定检查点不重复执行轮次、hook 失败终态不留 running、暂停未提交轮次可恢复；长程单测 6/6，产品契约 2/2。
- 全量回归：`npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、447 个测试通过**；pretest 重建 panel client/kernel/launcher 均成功。
- 长程仓库回归再补 workspace 隔离与 stale revision 拒绝覆盖，`tests/unit/persistent-loop.test.ts` 现 7/7 通过。

## 持续生产级审计最终收敛（2026-10-17）

- 异步构建完成/恢复绑定不可变 run/workspace/project/session，避免用户切换项目、会话或新建运行后 Memory、Artifact、usage 和终态落错目标。
- WebSocket 增加 64KiB 输入上限和断线发送保护；慢 action 在客户端断开后不再产生未处理 send 异常。
- 停止后的迟到成功/失败终态按 cancelled runId 忽略；恢复构建失败消息绑定原 runId；旧终态不会复活新运行。
- Artifact 读取补充独立 runs 根和 workspace/project 校验；无项目产物真实读取边界通过。
- Scheduler 拒绝 `every 0s` 等非法间隔，捕获 tick rejection；用户已有运行时调度任务返回 skipped，不消耗 runCount/maxRuns；后台任务 projectId 全链路隔离。
- 项目运行期间禁止 create/select/archive/delete 导航变更，避免 UI 项目与执行绑定脱节。
- 最新全量回归：**57 个测试文件、452 个测试通过**；panel integration **39/39**；persistent loop、scheduler、project binding、artifact/WS 边界均有精准回归。
- `npm run build`、`npm run lint`、`npm run bundle`、`npm run panel-client`、`git diff --check` 通过；最新 launcher 已重启，4320/4321/8317 在线。

## 长程面板最小产品路径与真实崩溃修复（2026-10-17）
- PanelServer 新增 `longRuns` snapshot、`create-long-run`、`control-long-run` actions，严格 `maxRounds` 1..50，绑定 workspace/project/session/scenario/slots；当前对话单实例防重入。
- launch 注入 `LongRunRepository`，真实 `executeLongRunRound` 复用 `executeScenarioWork`、真实 ModelClient/context/files、ArtifactRepository 和场景执行统计；取消轮次不写场景失败验证；重启调用 `recoverAfterRestart` 并协调当前会话。
- UI 新建对话增加“将下一条需求作为长程场景运行”和轮次上限；检查台显示长程轮次进度，暂停/继续/停止路由到长程控制 action。
- 真实 live 探针曾启动长程 run `long-run-1792176536166-fjhjol`，暴露崩溃：长程终态 chat 使用 LongRun id，`PanelServer.pushChat` 无条件 `RunRepository.update`，抛 `run not found` 使面板退出。已修：终态持久化前检查 `runs.get`，不存在则跳过普通 RunProduct 更新；新增回归测试。
- 证据：`npm run panel-client`、`npm run build`；定向 `48/48`；全量 `npm test -- --reporter=dot --testTimeout 30000` → **57 文件、454 测试通过**。
- 真实长程探针因修复前崩溃未形成可信成功结论；遵循主代理指令，已停止继续 live 操作，等待主代理收敛后再做一次端到端复测。
- 追加静态竞态修复：长程 pause 等待 runner 真正写入 paused 后才向 UI 返回可恢复状态；resume 丢弃已 abort 的旧 worker，从 durable checkpoint 新建，避免立即继续无效化。
- 修复后 build + panel/persistent 定向 48/48 通过；遵循主 agent 指令未重新操作 live。
- 追加 stop-before-worker-start 防护：startLongRun 读取最新 LongRun 状态，仅 queued/running 才创建 worker；避免创建后立即 stop 仍被异步回调启动。
- `npm run lint` 通过；build + panel/persistent 定向 48/48 通过。live launcher 仍按主 agent 指令保持停止。

## 长程真实端到端复测与状态同步收敛（2026-10-17）

- 重新打包并启动最新 launcher 后，真实浏览器走通：新建对话 → 选择“整理 /data/play 的数据并生成简报” → 勾选长程 → 设置轮次上限 → 创建对话 → 发送需求。
- 首轮状态同步修复：`src/panel/launch.ts` 的 `onRoundStart` 在 PersistentGoalLoop 已提交 `running` 后立即调用 `panel.setLongRunState`，检查台不再长时间停留在 queued，暂停按钮会在真实执行中出现。
- 真实控制路径：`暂停` 后检查台显示 `长程进度 1/2 轮 · 已暂停`；`继续` 后显示 `运行中`；`停止` 后显示 `运行 · 已终止`，暂停/继续/停止按钮全部收起。
- 真实 durable 证据：最新探针 `long-run-1792176848679-d1atlo` 最终为 `cancelled`，`terminalReason=cancelled`、`lastError=长程运行已取消。`；4320/4321 仍监听，复测后 `panel-live.stderr.log` 无新崩溃。
- 真实成功探针：`long-run-1792176712275-qcobkl` 为 `succeeded`，`completedRounds=1`，生成长程轮次 Artifact；该成功发生在终态 ID 崩溃修复后的最新 launcher 上。
- 最新全量回归：`npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、454 个测试通过**；前置 panel-client、kernel、launcher bundle 均成功。`npm run build`、`npm run lint`、`git diff --check` 通过。

## 运行中心长程记录审计（2026-10-17）

- 发现：运行中心原先只渲染普通 `RunProduct`，已持久化的长程记录不会出现在用户的运行历史中。
- 修复：`src/panel/chat-client.ts` 将普通运行和 `LongRunSummary` 合并后按真实更新时间统一排序；长程记录显示目标、完成轮次/轮次上限和状态，普通运行的详情、重试、对比入口保持原行为。
- 真实浏览器复核：运行中心第一条显示“再次验证暂停控制 · 长程 · 第 2/2 轮 · 已终止”，其后依次显示其他长程记录和普通运行，证明排序与可见性生效。
- 回归：`npm run panel-client`、`npm run build`、`npm run lint`、`git diff --check` 通过；最终全量 `npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、454 个测试通过**；面板 `/api/snapshot` 返回 HTTP 200，live launcher 无新 stderr 崩溃。

## 长程运行详情交互收口（2026-10-17）

- 长程历史行改为可访问按钮，点击后复用运行详情面板展示完整 durable JSON（workspace/project/session/scenario、轮次、checkpoint、状态和终态原因）。
- 对长程详情禁用普通运行专属的“重试/创建分支”，并给出明确说明；普通运行详情行为不变。
- 真实浏览器复核：点击最新长程行后，详情面板可见 `kind=long-run`、`status=cancelled`、`terminalReason=cancelled` 和 `pendingResult` 检查点，重试/分支按钮均为 disabled。
- 最终回归：`npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、454 个测试通过**；`npm run panel-client`、`npm run bundle`、`npm run build`、`npm run lint`、`git diff --check` 通过。

## 新建对话配置残留修复（2026-10-17）

- 发现：新建对话弹窗关闭后再次打开会保留上一次未提交的场景和长程勾选，可能导致用户误启动长程运行。
- 修复：`src/panel/chat-client.ts` 每次打开弹窗都重置为空白对话、取消长程勾选、轮次上限 3，并清理待发送长程配置；提交失败时仍保留当前表单，方便修正。
- 真实浏览器复核：先选择场景并勾选长程，关闭再打开后 AX 显示“空白对话（自动匹配场景）”、长程 `Value: 0`、轮次字段隐藏。
- 最终回归：`npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、454 个测试通过**；`npm run panel-client`、`npm run bundle`、`npm run build`、`npm run lint`、`git diff --check` 通过。

## 长程用户消息回显与会话命名修复（2026-10-17）

- 发现：`create-long-run` 直接启动 worker，却没有把用户需求写入聊天流；长程对话从 AI 进度开始，历史标题一直是“新对话”。
- 修复：`src/panel/server.ts` 在创建长程记录后先写入用户消息；现有自动标题逻辑会将首条需求命名到历史会话。
- 精准回归：长程创建测试确认快照包含用户消息、历史标题为需求文本。
- 真实浏览器证据：创建“验证长程用户消息回显”长程对话后，聊天 DOM 包含用户消息，sessionTitle 同步为“验证长程用户消息回显”，长程最终 `succeeded`、`busy=false`。

- 本次最终全量回归：**57 个测试文件、457 个测试通过**；最新 live `/api/snapshot` HTTP 200、`busy=false`、`run=succeeded`、`longRuns=7`。

## 旧长程会话标题迁移（2026-10-17）

- 发现：历史长程会话在早期没有用户消息，普通标题迁移无法处理，侧栏仍显示“新对话”。
- 修复：`src/panel/launch.ts` 启动时使用 LongRun durable goal 为默认标题的旧长程会话迁移自然名称，只处理有真实 goal 的会话，不猜普通历史。
- live 复核：重启 launcher 后旧会话从“新对话”迁移为“验证重启恢复”“测试长程暂停恢复”“验证长程入口稳定性”“验证长程真实执行二”等自然标题；无消息空会话仍保持默认标题。

- 最终全量回归：**58 个测试文件、458 个测试通过**；live `/api/snapshot` HTTP 200、`busy=false`、`run=idle`、`longRuns=7`。

## 历史默认标题迁移（2026-10-17）

- 发现：旧会话即使已有用户消息，侧栏仍可能显示“新对话”，导致历史导航难以识别。
- 修复：`src/panel/history.ts` 对默认标题且存在首条真实用户需求的旧会话推导自然标题，并在读取时持久化；无用户消息的旧记录保持“新对话”，避免猜测内容。
- 新增 `tests/unit/panel-history.test.ts`；精准历史测试通过。
- 最终全量回归：**58 个测试文件、458 个测试通过**；build、lint、panel-client、bundle、diff check 通过；live API HTTP 200。

## 后台任务聊天隔离修复（2026-10-17）

- 发现：后台任务复用 start-build 时会把任务需求写成当前人工会话的 user 消息，可能污染聊天流和会话标题。
- 修复：`start-build` 增加 `source=user|task`；scheduler/run-task 传入 `source=task`，launcher 只对真实用户输入写 user 消息，后台任务继续保留 task-notification 和结果通知。
- 新增集成回归：后台任务 source 正确为 task，聊天中不出现伪造 user 消息。
- 精准 build、lint、测试通过；待全量回归后更新最终计数。

- 最终全量回归：**58 个测试文件、459 个测试通过**；最新 launcher 已重启到 live，`/api/snapshot` HTTP 200、`busy=false`、`run=idle`、`longRuns=7`。

## 聊天持久化上限收口（2026-10-17）

- 发现：`PanelSessionSchema` 只允许 500 条消息，但 `persistedChatHistory` 没有裁剪，长会话超过上限后会持续写盘失败。
- 修复：`PanelServer` 持久化历史明确保留最近 500 条，渲染窗口仍保留最近 200 条；旧快照加载也安全裁剪。
- 新增集成回归：505 条消息写入后历史稳定保留 500 条最新记录，最早保留第 5 条、最后保留第 504 条。
- 最终全量回归：**58 个测试文件、460 个测试通过**；最新 launcher 已重启到 live，API HTTP 200、`busy=false`、`run=idle`、`longRuns=7`。

## 真实证据缺口长程终态复测（2026-10-17）

- 第一版证据缺口识别被真实模型输出绕过：模型使用“未执行事项/未读取真实文件/无法生成真实简报”段落表达，仍被判为完成。
- 扩展高置信度识别规则，覆盖这些明确未执行表达；单测发现一次正则语法错误后立即修复，work-execution 单测 9/9、build/lint 通过。
- 真实代理复测：`long-run-1792180072088-xz5vhj`（上限 1 轮）最终为 `failed`、`terminalReason=max-rounds`，聊天显示“本轮生成了说明，但没有形成可验证结果”，没有“长程场景已完成”。
- 证明缺少 `/data/play` 真实输入时不会再伪报长程成功；终态与产物说明一致。

- 最终全量回归：**58 个测试文件、461 个测试通过**；live `/api/snapshot` HTTP 200、`busy=false`、当前运行已收敛为 `failed`、长程记录 9 条。

## WS 广播与客户端发送竞态保护（2026-10-17）

- 发现：服务端广播、浏览器动作发送在 readyState 检查后仍可能遇到连接瞬时关闭并抛异常。
- 修复：`src/panel/server.ts` 广播 send 增加 try/catch；`src/panel/chat-client.ts` 动作发送失败时清理 pending request、显示连接错误并更新连接状态。
- 面板集成 46/46、build、lint、panel-client 通过；最新 bundle 已重启到 live。

- 最终全量回归：**58 个测试文件、461 个测试通过**；最新 live `/api/snapshot` HTTP 200、`busy=false`、`run=idle`、`longRuns=9`。

## 产物列表信息密度收口（2026-10-17）

- 发现：右侧产物区会把历史产物全部平铺，长程运行后检查台被大量重复 Artifact 卡片挤满。
- 修复：`src/panel/chat-client.ts` 默认按更新时间显示最近 12 条，提供“显示全部 N 个产物 / 收起较早产物”切换；打开、差异、分享、删除操作保持不变。
- 真实浏览器复核：默认 12 行、折叠按钮显示“显示全部 44 个产物”；点击后展开 44 行并显示“收起较早产物”。
- 最终全量回归：**58 个测试文件、461 个测试通过**；build、lint、panel-client、bundle、diff check 通过。

## 模型证据缺口防伪完成修复（2026-10-17）

- 发现：模型输出明确写出“本次未执行/无法确认/缺少真实证据”时，工作执行器仍返回 `succeeded`，长程 goalCheck 会误判为完成；聊天内容与检查台状态矛盾。
- 修复：`src/panel/work-execution.ts` 识别明确证据缺口并返回 `untested`，产物说明保留具体原因；普通运行和长程运行的终态文案区分 Provider 不可用与缺少真实执行证据，长程不会伪完成。
- 新增单元回归：明确“未执行”模型输出必须为 `untested`，禁止伪报任务成功。
- 最终全量回归：**58 个测试文件、461 个测试通过**；build、lint、panel-client、bundle、diff check 通过；最新 launcher 已重启到 live，API HTTP 200、`busy=false`、`run=idle`。

## 归档场景执行边界收口（2026-10-17）

- 发现：新建对话和长程入口会拒绝归档场景，但直接 start-build、重试和后台任务只校验场景存在，仍可能执行已归档场景。
- 修复：服务端 start-build 对 `status !== active` 的场景写入失败终态并返回“场景已归档”；所有调用链自动继承该边界。
- 新增集成回归：归档场景启动被拒绝并落为 failed，错误证据可见。
- 最终全量回归：**58 个测试文件、459 个测试通过**；build、lint、panel-client、bundle、diff check 通过；live API HTTP 200。

- 当前工作区最终回归证据：后台任务隔离修复后全量仍为 **58 个测试文件、459 个测试通过**；live 面板 HTTP 200、`busy=false`、`run=idle`、`longRuns=7`。

## 失败运行真实重试复测（2026-10-17）

- 运行中心挑选历史失败运行“你好2”，打开详情并点击“重试”。
- 真实 API/浏览器证据：重试创建新 run `run-1792177895038-kj7xno`，面板先进入 `busy=true/running`，约 17 秒后收敛为 `busy=false/failed`，聊天终态明确说明“工作模式没有找到可直接使用的场景”，没有卡住输入或污染长程终态。
- 当前服务仍在线，`/api/snapshot` HTTP 200；运行中心已关闭，浏览器回到干净主界面。

## 长程真实重启恢复复测（2026-10-17）

- 启动真实长程探针 `long-run-1792178027560-1wi9f9`（目标“验证重启恢复”，上限 2 轮），在首轮执行中强制重启 panel launcher。
- 重启后的真实 API 状态：`busy=true`、`run.status=paused`、`lastError=面板重启，长程运行已在安全轮次边界暂停；可继续恢复。`，检查台 `继续=true`、`停止=true`、`暂停=false`；`nextRound=1`、`completedRounds=0`，没有伪造完成或重复提交检查点。
- 点击“继续”后真实恢复为 `running`，暂停按钮重新出现；随后点击“停止”，稳定收敛为 `busy=false`、`cancelled`、`长程进度 1/2 轮 · cancelled`。
- 该探针证明启动器重启恢复、durable checkpoint、继续和停止链路真实可用；面板重启后 4320/4321 仍在线，API 返回 HTTP 200。

## retry/branch 与历史长程状态绑定收口（2026-10-17）

- 发现并修复：`/run retry` 原先可能读取工作区其他历史会话的最新 retryCount；现在按当前 sessionId 查找，避免历史切换后串计数。
- 发现并修复：retry-run/branch-run 原先可对 queued、running、waiting-approval、paused 记录发起新运行；服务端现在拒绝未终态记录，运行中心 UI 同步禁用无效按钮。
- 新增集成回归：当前会话 retryCount 与其他会话 retryCount 隔离；活动运行 retry/branch 均被拒绝。
- 发现并修复：切回拥有活动长程运行的历史会话时，原逻辑只恢复普通 RunProduct，可能显示 idle 并允许重复启动；`restoreRunForSession` 现在优先恢复 queued/running/paused LongRun。
- 精准证据：retry/status 测试 2/2、历史长程恢复测试 1/1；随后全量回归 **57 个测试文件、456 个测试通过**；build、lint、panel-client、bundle、diff check 均通过。

## 状态绑定修复后的 live 收敛（2026-10-17）

- 最新 bundle 已重启到 live；面板 `/api/snapshot` 返回 HTTP 200，当前 `busy=false`、`run=idle`、`longRuns=6`，代理仍为 `http://127.0.0.1:8317/v1`。
- 浏览器刷新后历史会话列表、聊天流、侧栏分组和检查台均正常显示；未留下活动长程或锁死输入。

## 长期运行历史 retry 读取边界（2026-10-17）

- 发现：`/run retry` 依赖 `runs.list(100)`，工作区运行记录超过 100 条后可能找不到当前会话的旧运行。
- 修复：`RunRepository.latestForSession(sessionId)` 直接从持久化存储按会话读取最新完整 RunProduct；retry 保留原项目、场景、模式和 retryCount。
- 精准/全量回归：面板集成 44/44，最终全量 **57 个测试文件、457 个测试通过**；build、lint、panel-client、bundle、diff check 通过。

## WS 去重响应断线保护（2026-10-17）

- 发现：WebSocket 断线保护已覆盖大多数异步响应，但 requestId 去重命中分支仍直接调用 `ws.send`。
- 修复：`src/panel/server.ts` 统一改用连接级 `sendIfOpen`，断线重放重复 requestId 不再抛未处理异常。
- 面板集成回归：**44/44**；`npm run build`、`npm run lint`、`npm run panel-client` 通过；最新 bundle 已重启到 live。

- 最终全量回归补充：`npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、457 个测试通过**；WS 去重保护、retry/branch 状态门、历史 LongRun 恢复和项目绑定测试均纳入本轮。

## 文档边界同步（2026-10-17）

- README 原先仍描述“面板尚未提供长程创建入口”，与当前实现不一致。
- 已更新 `README.md`：准确说明面板已接入 `PersistentGoalLoop`、新建对话长程入口、1–50 轮、检查点、暂停/继续/停止和重启恢复；同时保留 `pi-reactor` 守护进程需要显式装配的真实边界。
- 仅文档变更，前置实现的最终全量回归证据仍为 57 个测试文件、454 个测试通过。

## 长程详情操作边界复测（2026-10-17）

- 发现：长程详情面板仍显示普通运行专属的评论输入和保存按钮，点击后没有动作。
- 修复：`src/panel/chat-client.ts` 在打开长程详情时禁用评论输入/保存、重试和分支；打开普通运行详情时恢复四项操作。
- 真实浏览器证据：长程详情四项状态均为 disabled；切回普通运行详情后四项均恢复 enabled。
- 最终回归：`npm test -- --reporter=dot --testTimeout 30000` → **57 个测试文件、454 个测试通过**；`npm run panel-client`、`npm run bundle`、`npm run build`、`npm run lint`、`git diff --check` 通过。

## Runtime protocol audit: in-flight WS dedupe and late terminal guards (2026-10-17)
- Audited `src/panel/server.ts`, `src/panel/launch.ts`, `src/execution/persistent-loop.ts`, `src/panel/model-client.ts` for action races, long-run worker replacement, restart recovery, and proxy error propagation.
- Fixed WS requestId race: `PanelServer` now tracks pending action promises so a retry arriving before the first result executes the action once and returns the same result to each socket. Added `requestId 在首个动作仍未完成时也只执行一次` integration coverage.
- Fixed ordinary-run late launcher rejection: an `onStartBuild` rejection after a terminal chat event is ignored when the inspector is no longer `running`, preventing successful/cancelled runs from being resurrected as failed.
- Fixed long-run worker replacement race: old worker `.then/.catch/.finally` callbacks now respect the durable revision/status and map ownership, so pause→resume cannot have a late old worker overwrite or fail the replacement.
- Historical ordinary-run restore now uses `RunRepository.latestForSession` without a global 100-row cap.
- Verification: `npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` => 48/48 passed; `npm run build` passed; targeted ESLint on changed server/launcher/integration test passed.

## 当前面板会话/任务边界审计（2026-10-17）

- 发现：`select-scenario` 与 `test-scenario` 只校验场景 ID 是否存在，归档场景仍可被协议直接选中或泛化测试；`create-task` 也可绑定不存在/归档场景，导致任务创建后必然失败。
- 修复：`src/panel/server.ts` 现在要求会话选择、场景泛化测试和后台任务绑定都使用 `status=active` 场景，并分别返回“场景已归档，不能选择/测试”“任务场景已归档/不存在”。
- 发现：后台任务通过 `start-build(source=task)` 时会覆盖当前人工会话的 `activeMode`、`activeScenarioId`，任务完成后用户下一条消息可能误用任务场景。
- 修复：后台任务保留当前会话模式/场景，只在运行记录中绑定任务自己的 mode/scenario；任务通知和终态仍写入当前会话，普通用户运行行为不变。
- 精准验证：`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` → **1 个文件、50 个测试通过**；新增“后台任务不会覆盖当前会话上下文”和“归档/不存在场景不可选择/测试/绑定任务”回归。`npm run build`、`npm run lint`、`git diff --check -- src/panel/server.ts tests/integration/panel-integration.test.ts` 通过。
- Additional runtime audit: scheduler timeouts previously released `inFlight` while the underlying task promise could still mutate runs, allowing duplicate scheduled executions. `TaskScheduler` now retains the guard until the original operation settles; scheduler unit coverage confirms a second tick does not re-enter a hung task (4/4).
- Planner SSE reader now cancels/releases its body in `finally` on normal completion, timeout, or parser failure to avoid retaining proxy sockets across retries. Planner+scheduler targeted tests: 12/12 passed; build passed.

## 当前阶段：场景命名、边界与运行链路生产收口（2026-10-17）

- 统一内核场景固化命名：src/kernel-entry.ts 改用 scenarioNameFromRequirement，不再直接截断需求字符串。
- 新建对话场景选择器只显示场景名称；历史重复场景在面板启动时按创建顺序保留首个名称，后续自动追加可读（2）后缀，避免列表出现完全相同项。涉及 src/panel/launch.ts、src/panel/chat-client.ts。
- 归档边界：select-scenario、test-scenario、create-task、start-build 全部拒绝归档或不存在场景；后台任务使用独立任务上下文，不覆盖当前人工会话的 mode/scenario/project 选择。
- WS 与运行竞态：requestId 在途去重；晚到的 launcher rejection 不会把已终态运行改回失败；暂停/继续时旧长程 worker 的 then/catch/finally 不会覆盖新 worker；scheduler 超时只在原操作真正 settle 后释放 inFlight；planner SSE reader 在所有出口释放。
- 验证：全量 npm test -- --reporter=dot --testTimeout 30000 → 60 个测试文件、467 个测试通过；npm run build、npm run lint -- --max-warnings=0、git diff --check 通过。定向 panel integration 50/50、命名定向 52/52 通过。
- live 证据：4320 面板与 4321 同步端点监听；/api/snapshot HTTP 200，busy=false、run=idle、longRuns=9；代理 8317 监听；浏览器复核新建对话只显示自然场景名、重复项为后缀形式，后台任务弹窗可打开/关闭，面板主界面连接正常。
- 未完成项：无新增可复现的阻断问题。持续目标仍保持 active，后续若继续迭代优先观察真实用户新路径与 live 日志，不虚报已不存在证据。

- 补充 live 配置证据：snapshot.settings.baseUrl = http://127.0.0.1:8317/v1，model=gemini-3-flash，plannerModel=gpt-6.1-sol；当前代理链配置已被面板实际读取。

## UI accessibility audit (2026-10-17)
- Audited `src/panel/chat-client.ts`, `src/panel/panel.css`, `src/panel/server.ts` for keyboard/focus/modal/drawer/stream semantics.
- Fixed mobile rail/inspector drawer focus restore, focus entry, `aria-expanded`/`aria-hidden`, and utility menu keyboard navigation/restore.
- Fixed modal focus observer clobbering explicit field focus (search/project inputs), added visible-focusable filtering for closed details/hidden nodes, backdrop click close, and safe focus restoration.
- Added mode/inspector/chat/command-list/tab ARIA relationships, roving tab indexes, command `role=option`/`aria-selected`, tab arrow navigation, and non-atomic chat log semantics.
- Replaced invalid run-center `<button>` containing checkbox with keyboard-accessible `div role=button tabindex=0`; click/Enter/Space handling retained.
- Command suggestion selection/history now dispatches input so send-button state and menu stay synchronized.
- `pushChat` now retains valid orphan LongRun terminal cards without updating regular RunProduct; LongRun terminal producer includes sessionId for cross-session isolation.
- Evidence: `npm run build` passed; `npm run lint -- --max-warnings=0` passed; `npx vitest run tests/integration/panel-integration.test.ts --reporter=dot` passed 53/53; focused orphan LongRun test passed (1/1).
- Next: parent should run full suite/live browser after integrating shared edits.

## 继续生产审计：任务项目边界、恢复隔离、生命周期和可访问性（2026-10-17）

- 后台任务项目边界：create-task 和 run-task 现在都要求绑定项目属于当前工作区且 status=active；归档项目不能留下或触发必然失败任务。新增集成回归。
- 恢复与隔离：运行列表和搜索按 workspace 过滤；重启扫描工作区全部 RunProduct/LongRun，不再受 100 条上限影响；历史切换时检查台只使用当前 runId 对应上下文，避免上一个会话的 DAG/trace 泄漏。
- 生命周期：PanelServer.stop() 在未启动、重复关闭时幂等，不再等待永远不会回调的 Promise；新增生命周期单测。
- 临时会话：启用 temporarySession 或关闭历史后，新建对话不创建持久化历史；UI 禁用长程开关并给出明确提示。
- UI/可访问性：修复移动侧栏/检查台焦点进入与恢复、弹窗焦点、遮罩关闭、工具菜单键盘导航、Tab/箭头导航、命令选项 ARIA、运行中心键盘行、流式日志语义和 LongRun 终态跨会话隔离。
- 精准验证：panel integration 53/53；临时/任务项目/stop 相关均通过；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、473 个测试通过；npm run build、npm run lint -- --max-warnings=0、git diff --check 通过。
- 最新 live 证据：4320/4321 在线，代理 8317 在线；/api/snapshot HTTP 200，busy=false、run=idle、longRuns=9；settings.baseUrl=http://127.0.0.1:8317/v1，model=gemini-3-flash，planner=gpt-6.1-sol；浏览器复核主界面、信息流、新建对话场景列表、场景选择后的长程开关和后台任务入口均可见且连接正常。

- 复测备注：并行审计阶段一次 panel integration 终态消息断言出现瞬态失败；在共享源码稳定后单独用例和完整 panel integration 均 53/53 通过，未能复现。

## 继续生产审计：项目文件、产物和桌面上下文隔离（2026-10-17）

- add-file 现在限制在当前项目目录，不能登记另一个项目目录的文件。
- create-artifact 现在只允许当前项目目录或 artifactRoot，并校验 runId 属于当前工作区。
- create-context 与 Host Bridge 本地文件上下文现在按当前项目目录校验，不能把另一个项目的文件带入当前会话。
- 精准验证：panel integration 56/56；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、476 个测试通过；npm run build、npm run lint -- --max-warnings=0、git diff --check 通过。
- 最新 live：4320/4321/8317 在线；snapshot HTTP 200，busy=false、run=idle、longRuns=9，baseUrl=http://127.0.0.1:8317/v1；launcher stderr 无运行错误。


## 继续生产审计：跨项目上下文和产物协议复测（2026-10-17）

- add-file、create-artifact、create-context、Host Bridge 本地文件均按当前项目目录做隔离校验，并对跨工作区 runId 做拒绝。
- Panel integration 56/56；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、476 个测试通过。
- 最新 live 仍为 4320/4321/8317 在线，snapshot HTTP 200、busy=false、run=idle、longRuns=9、代理地址 http://127.0.0.1:8317/v1。


## 继续生产审计：最终项目边界回归（2026-10-17）

- add-file、create-artifact、create-context、Host Bridge 本地文件均不能跨项目；create-artifact 还拒绝其他工作区 runId。
- Panel integration 56/56；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、476 个测试通过。
- live 已用最新 bundle 重启：4320/4321/8317 在线，snapshot HTTP 200，busy=false、run=idle、longRuns=9，baseUrl=http://127.0.0.1:8317/v1，launcher stderr 为空。


## LongRun / scheduler audit (2026-10-17)
- Fixed PersistentGoalLoop pause-vs-cancel race: pause requested during goalCheck or roundGate now commits `paused` with pending checkpoint; external abort remains `cancelled`.
- Fixed scheduler invalid `lastRunAt`: recurring and daily schedules treat malformed timestamps as due instead of permanently suppressing execution.
- Serialized PanelServer create-long-run check+create to reject concurrent retries in one session; only one durable LongRun can pass the active-session gate.
- Evidence: `npx vitest run tests/integration/panel-integration.test.ts tests/unit/persistent-loop.test.ts tests/unit/scheduler.test.ts` -> 3 files / 73 tests passed; `npm run build` passed; `git diff --check` passed.

## 继续生产审计：长程状态机和 REST/WS 越权收口（2026-10-17）

- PersistentGoalLoop：目标检查/roundGate 期间暂停不再被误记为 cancelled，保留 pending checkpoint；stop 与外部 abort 仍区分处理。
- scheduler：损坏 lastRunAt 会按未运行处理；并发 create-long-run 通过创建队列串行化，同一会话只会留下唯一 durable long run。
- REST/WS 安全：无当前项目时 artifact 读取不再把整个 projectRoot 当根；memoryRoot 不再作为 artifact 读根；delete-file 强制 projectId 与 currentProjectId 匹配并做 canonical realpath 校验；add-file 拒绝项目内 symlink 外链；无项目时禁止本地文件上下文；requestId 结果绑定首次 WebSocket，其他连接只得到通用占用结果，避免分享/身份 token 泄露。
- 精准验证：panel integration 60/60；PersistentGoalLoop、scheduler、REST/WS 相关合计定向 74 通过；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、482 个测试通过；build、lint、git diff check 通过。
- live 已用最新 bundle 重启：4320/4321/8317 在线；snapshot HTTP 200、busy=false、run=idle、longRuns=9、baseUrl=http://127.0.0.1:8317/v1；launcher stderr 无运行错误。


## 最终复测补充：长程/REST/WS 安全边界（2026-10-17）

- PersistentGoalLoop pause/goalCheck、scheduler 损坏时间戳、并发长程创建、无当前项目 artifact/delete/context 越权、symlink canonical、跨 WS requestId 结果隔离均已纳入当前源码。
- 当前精准证据：panel integration 60/60；长程/scheduler/REST/WS 定向组合 74 tests passed。
- 当前全量证据：61 个测试文件、482 个测试通过；build、lint、git diff check 通过。
- 当前 live：4320/4321/8317 在线，snapshot HTTP 200，busy=false、run=idle、longRuns=9、代理地址 http://127.0.0.1:8317/v1，launcher stderr 为空；浏览器显示已连接、聊天信息流和侧栏正常。


## 继续生产审计：分享资源归属和最终回归（2026-10-17）

- create-share 现在校验 workspace resourceId；分享读取端点再次校验 project/artifact 所属 workspace，异常历史分享记录不会返回外部资源。
- Panel integration 61/61；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、483 个测试通过。
- npm run build、npm run lint -- --max-warnings=0、git diff --check 通过。
- 最新 bundle 已重启 live：4320/4321/8317 在线；snapshot HTTP 200，busy=false、run=idle、longRuns=9、baseUrl=http://127.0.0.1:8317/v1；launcher stderr 为空。


## 继续生产审计：分享归属最终复测（2026-10-17）

- create-share workspace resourceId 和 share 读取端点的 project/artifact workspace 归属都已校验。
- Panel integration 61/61；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、483 个测试通过。
- build、lint、git diff check 通过；最新 live 浏览器已连接，聊天信息流、侧栏和运行检查台正常。


## 继续生产审计：评论资源和最终 live 复测（2026-10-17）

- create-comment 现在验证 scenario 资源存在，避免写入悬空评论。
- Panel integration 62/62；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、484 个测试通过。
- build、lint、git diff check 通过。
- 最新 live 已用正确 bundle 重启：4320/4321/8317 在线，snapshot HTTP 200，busy=false、run=idle、longRuns=9、baseUrl=http://127.0.0.1:8317/v1，launcher stderr 为空。
- 备注：本轮一次重启命令因日志路径手工拼写错误未启动，已立即用正确路径重启并完成 API/端口复核；不属于应用失败。


## 继续生产审计：项目导航状态机和评论资源边界（2026-10-17）

- 删除当前项目后只从 active 项目中自动选择；面板启动时也不会默认选 archived 项目。
- create-comment 校验场景资源存在，避免悬空评论。
- Panel integration 63/63；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、485 个测试通过。
- build、lint、git diff check 通过；最新 bundle 已重启 live，4320/4321/8317 在线，snapshot HTTP 200，busy=false、run=idle、longRuns=9、baseUrl=http://127.0.0.1:8317/v1，launcher stderr 为空。


## 继续生产审计：已删除场景分享生命周期和最终复测（2026-10-17）

- 已删除场景不能新建分享，旧分享链接返回 404；归档场景仍保留只读语义。
- Panel integration 64/64；全量 npm test -- --reporter=dot --testTimeout 30000 → 61 个测试文件、486 个测试通过。
- build、lint、git diff check 通过；最新 bundle 已重启 live，4320/4321/8317 在线，snapshot HTTP 200，busy=false、run=idle、longRuns=9、baseUrl=http://127.0.0.1:8317/v1，launcher stderr 为空。


## 继续生产审计：项目删除语义复核（2026-10-17）

- UI 文案明确删除项目会移除项目上下文和文件索引；底层保留物理文件与该恢复/隐私边界一致，本轮未发现语义冲突。
- live 复核：snapshot HTTP 200，busy=false、run=idle、longRuns=9；4320/4321/8317 在线；git diff check 通过。


## live WS 跨连接 requestId 复测（2026-10-17）

- 真实连接两个独立 WebSocket 到 ws://127.0.0.1:4320/ws，同时发送同一 requestId 的 /help。
- 结果：首连接收到 ok=true；第二连接收到 requestId 已被其它连接占用，未复用首连接结果。
- 该只读命令审计在当前 live 会话增加了一条 /help 测试消息，未创建分享、运行、文件或项目资源。


## live 审计消息清理（2026-10-17）

- 上一轮真实 WS requestId 审计曾在当前会话写入一条 /help 用户消息和结果消息。
- 已停止 launcher、从对应 panel-sessions durable record 精确移除这两条审计消息、重启最新 bundle。
- 复核：snapshot HTTP 200，helpMessages=0，busy=false、run=idle、longRuns=9，代理地址 http://127.0.0.1:8317/v1，launcher stderr 为空。


## 生产目标证据矩阵（2026-10-17）

- 场景入口/自然命名/新建对话：代码、历史命名迁移、场景选择器和浏览器 DOM 已验证；重复名称使用可读后缀。
- 聊天信息流/侧栏/移动交互：run-group、流式合并、活动更新折叠、焦点恢复、ARIA、移动抽屉和弹窗已通过面板集成与浏览器复核。
- 运行状态机：普通运行、失败终态、迟到回调、重试/分支状态门、项目/会话绑定已通过集成回归。
- 长程 GoalLoop/hooks：暂停、继续、停止、目标检查期间暂停、最大轮次、checkpoint、重启恢复、并发创建均有持久化测试和 live 历史证据。
- 项目/资源隔离：workspace/project/session/runId、文件 canonical path、symlink、artifact、context、share、comment、task 均有边界回归。
- 代理链路：live settings.baseUrl 实际为 http://127.0.0.1:8317/v1；4320/4321/8317 在线；模型与 planner 配置可从 snapshot 读取。
- 当前回归基线：61 个测试文件、486 个测试通过；Panel integration 64/64；build、lint、diff check 通过。
- 剩余边界：真实外部 Provider 的长期稳定性、真实用户持续负载和跨进程故障注入仍需继续观察；当前没有可复现的本地可避免阻断问题，因此目标保持 active。


## live Provider 协议健康复测（2026-10-17）

- 通过真实 WS 发送 test-settings(full=false)，服务端使用当前加密配置向 http://127.0.0.1:8317/v1/models 发起带鉴权探测。
- 结果：requestId=live-provider-health，ok=true；未写入聊天消息、分享、运行或项目资源。
- 直接无鉴权访问 proxy /models 返回 Missing API key，说明代理鉴权门生效；面板带当前配置可通过。


## live Provider full 协议健康复测（2026-10-17）

- 真实 WS 发送 test-settings(full=true)，通过当前代理配置执行 models、chat completion 和 tool probe。
- 结果：requestId=live-provider-full-health，ok=true；未写入聊天、运行、分享或项目资源。


## live Provider 并发健康复测（2026-10-17）

- 两个独立 WebSocket 并发执行 test-settings(full=false)。
- 两个 requestId 均 ok=true，响应未串线，未写入聊天、运行或资源数据。


## 继续生产审计：Artifact 分享路径泄漏与同步 URL 错误恢复（2026-10-17）

- 发现 `/api/share/:token` 的 Artifact 资源响应直接返回了本机绝对 `path` 以及 `versions[].path`；分享令牌持有者可以据此看到本地文件系统布局。
- 修复 `src/panel/server.ts`：Artifact 分享响应现在剥离当前路径和所有历史版本路径，保留只读元数据与文本快照。
- 发现自托管同步服务对 malformed percent-encoded workspace URL 直接 `decodeURIComponent`，异常会让异步请求处理器拒绝且连接没有明确响应。
- 修复 `src/product/sync-server.ts`：畸形编码现在稳定返回 HTTP 400 `invalid workspace id`。
- 新增精准回归：Artifact 分享不泄漏路径；同步 malformed URL 不悬挂。
- 证据：`npx vitest run tests/integration/panel-integration.test.ts tests/unit/sync-server.test.ts --reporter=dot --testTimeout 30000` → 2 files / 67 tests passed；`npm run build`、四文件 ESLint `--max-warnings=0`、`git diff --check` 通过。
- 后续审计项：当前 workspace export 包含 memories/contexts/connectors/providers/tasks/artifacts，但 import-workspace 只恢复 projects/files/scenarios；本轮记录但未扩大修改，待专门闭环设计。

## 继续生产审计：同步未知实体保留（2026-10-17）

- 发现 `sync-apply` 只重建当前支持的 project/scenario/memory，随后把合并结果完整回传；远端 envelope 中的未知/未来版本实体会被静默丢弃，造成跨版本同步数据损失。
- 修复 `src/panel/server.ts`：仅对当前支持实体执行冲突计划，memory 未勾选或未知类型实体原样 passthrough 回传；当前面板不会再因应用同步删除未来客户端数据。
- 新增集成回归：远端 `future-widget` 实体在 sync-apply 后仍存在。
- 证据：panel integration 66/66；sync/sync-server 单测 3/3；`npm run build` 与针对性 ESLint 通过。

## live path audit（本轮）
- 真实浏览器后台加载 `http://127.0.0.1:4320/?qa=live-path-audit`，验证新建对话场景选择、空白会话长程禁用、已有场景长程轮次开关、历史切换、场景库使用、运行中心失败恢复、任务空态和设置页代理连接。
- 证据：浏览器 AX 显示“已连接”；设置页 API `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`、规划器 `gpt-6.1-sol`；点击“验证模型连接”返回“模型连接验证成功”。HTTP `/api/snapshot` 200，`busy=false`，`sessions=23`、`scenarios=11`、`longRuns=9`、`runs=45`；`/api/settings` 仅返回 `hasApiKey=true` 与掩码。
- 修复：`src/panel/chat-client.ts` 运行中心普通运行选择框增加稳定 `aria-label` 与 `title`，避免读屏仅读出无意义的“checkbox 0”。执行 `npm run panel-client`、`npm run build`、`npx eslint src/panel/chat-client.ts --max-warnings=0` 均通过；重载真实浏览器后 AX 显示“选择运行记录：你好2”等可读名称。
- 未写入真实聊天、未产生持久业务数据变更；未发现新的可复现功能阻塞。该轮浏览器观察到的旧需求型标题已在后续启动迁移中规范化，当前新建对话列表不再显示原始“我要参加……”前缀。
- 追加回归：`npx vitest run tests/integration/panel-integration.test.ts --testTimeout 30000 --reporter=dot` → 1 文件 / 66 tests passed（04:59）。

## 继续生产审计：资源生命周期、同步兼容和最终浏览器复测（2026-10-17）

- REST 异步读取路径统一增加失败收口，持久化解析异常会返回 HTTP 500 JSON，不再悬挂请求或留下未处理拒绝。
- 已删除场景的直接导出/版本比较返回 404；已删除产物不能分享、版本化、评论，旧项目/产物分享链接也按删除状态返回 404。
- 产物分享响应剥离本机绝对路径和历史版本路径；同步服务 malformed workspace URL 返回 HTTP 400；sync-apply 保留未知/未来实体及未勾选 Memory，避免跨版本同步静默丢数据。
- 产物打开链接改用 `/api/artifact?id=...` opaque ID；服务端保留旧 path 兼容入口并按当前工作区、项目根、artifactRoot 和 canonical realpath 校验。浏览器 AX 复核链接不再含本机路径。
- 历史场景名迁移新增 `migratedScenarioName`：仅规范化旧版本把完整需求当标题的记录，保留自定义标题并为重复名追加可读后缀。真实 live 新建对话列表中旧“我要参加……”已显示为“参加中国国际大学生创新大赛，项目是毫米波雷达独居老人跌倒监测”。
- 工作区导入若遇到当前版本未恢复的 Memory、桌面上下文、连接器、Provider、后台任务或产物，会在聊天流明确列出“未导入”，不再把部分导入伪装成完整恢复。
- 精准证据：Panel integration 66/66；Panel + 场景命名定向 68/68；同步 malformed URL / future entity 回归通过。
- 最新全量证据：`npm test -- --reporter=dot --testTimeout 30000` → **61 个测试文件、490 个测试通过**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。
- 最新 live：面板 4320、代理 8317 在线；`/api/snapshot` HTTP 200，busy=false、run=idle、longRuns=9、sessions=23、scenarios=11；settings.baseUrl=`http://127.0.0.1:8317/v1`、model=`gemini-3-flash`、planner=`gpt-6.1-sol`；真实 WS `test-settings(full=false/full=true)` 均 `ok=true`，snapshot 中 helpMessages=0；浏览器控制台 error/warning 为空。
- 当前剩余边界：外部 Provider 长期稳定性、真实持续负载和跨进程故障注入仍需运行环境持续观察；工作区导出中的非项目实体仍未恢复写入，现已显式提示而非静默成功。

## 继续生产审计：workspace export/import 安全闭环（2026-10-17）
- 证据：`GET /api/workspace/export` 原先把项目文件 `path`、Memory `path`、桌面上下文本地文件 `origin`、Artifact `path` 原样写入可下载 JSON；Connector/Provider URL 也可能带 userinfo。导入原先对空文件（`contentBase64 === ""`）、非法 base64、无效场景/文件条目静默跳过，同名文件会互相覆盖，且导出 workspace 元数据及 memories/contexts/connectors/providers/tasks/artifacts 未恢复但只有数组非空时才提示。
- 修改：`src/panel/server.ts`：导出改为便携字段，去掉文件/产物路径，隐藏 Memory 路径和本地文件上下文来源，清理 URL userinfo；导入严格识别 bundle 类型与 canonical base64，保留空文件，为重复文件名生成 `（2）` 后缀，记录无效/截断/未导入数据和 workspace 元信息提示。
- 测试：`tests/integration/panel-integration.test.ts` 新增导出路径/凭据脱敏与导入空文件/同名/无效条目回归；面板集成 `68/68` 通过；全量 `61` 个测试文件、`492` 个测试通过；`npm run build` 通过；`npm run lint -- --max-warnings=0` 通过。
- 边界：导入仍不恢复 Memory、桌面上下文、连接器、Provider、后台任务、产物，因为它们含本机路径/外部凭据/运行状态引用；导入提示现在明确列出数量或格式错误，未宣称完整恢复。
- 追加修复：bundle 中 projects/scenarios/files 非数组的格式错误现在也会进入导入提示，不会在另一字段有效时静默丢失；面板集成复测仍为 68/68，lint 通过。
- 追加收口：导出对浏览器上下文和连接器信任证据 URL 也清理 userinfo；导入在目标仓储缺失、字段类型错误或项目/场景写入异常时给出明确提示，不再静默成功；面板集成 68/68、lint 通过。
- 最新全量复测（追加脱敏/缺失仓储/写入异常收口后）：61 个测试文件、492 个测试通过；构建由 pretest bundle 成功，lint 仍通过。

## 继续生产审计：导入传输链路和场景管理入口收口（2026-10-17）

- 场景库“用于新对话”不再直接修改当前会话；真实浏览器物理点击后打开新建对话并预选场景，场景库文案改为“管理已固化的长期工作流”，与新建对话场景选择路径统一。
- 工作区导入从浏览器改走 `POST /api/workspace/import`，请求体上限 50MB；聊天 WebSocket 仍保留 64KB 小消息保护。真实 70KB malformed body 返回“工作区文件不是有效 JSON”而非“request body too large”，证明 HTTP 入口越过旧 WS 限制且没有写入持久资源。
- 导出再次收口 connector trustEvidence 本地路径为 `local://redacted`；live 导出复核文件、产物、Memory、本地上下文和信任证据路径均为 0 条，URL userinfo 为 0 条。
- 精准证据：Panel integration **69/69**；`npm run build`、changed-file ESLint 通过。
- 最新全量证据：`npm test -- --reporter=dot --testTimeout 30000` → **61 个测试文件、493 个测试通过**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。
- 最新 live：4320/8317 在线；`/api/snapshot` HTTP 200，busy=false、run=idle、longRuns=9、sessions=23、scenarios=11；settings.baseUrl=`http://127.0.0.1:8317/v1`、model=`gemini-3-flash`、planner=`gpt-6.1-sol`；WS `test-settings(full=false/full=true)` 均 ok=true；helpMessages=0；浏览器 AX 仍显示 opaque artifact ID、自然场景名，控制台 error/warning 为空。
- 剩余边界：外部 Provider 长期稳定性、真实持续负载和跨进程故障注入仍需运行环境持续观察；导入对外部凭据、Memory/上下文/任务/产物路径绑定实体仍明确提示未恢复。

## 继续生产审计：大型导入 HTTP 传输和最终 live 复测（2026-10-17）

- 发现导入包虽允许 50MB，但浏览器仍通过 64KB WebSocket 发送，正常大导出无法导回。新增 `POST /api/workspace/import` 专用 HTTP 入口，读取上限 50MB；前端文件选择器改走该入口，普通 WS 小消息保护保持不变。
- 真实 70KB malformed HTTP body 返回“工作区文件不是有效 JSON”而非“request body too large”，证明传输链路已越过旧 WS 限制且未写入持久业务资源。
- 场景库管理入口保持“用于新对话”路径；真实浏览器 AX 仍显示自然场景名、opaque artifact ID、已连接状态和空闲运行检查台。
- 精准证据：Panel integration **69/69**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。
- 最新全量证据：`npm test -- --reporter=dot --testTimeout 30000` → **61 个测试文件、493 个测试通过**。
- 最新 live：4320/8317 在线；`/api/snapshot` HTTP 200，busy=false、run=idle、longRuns=9、sessions=23、scenarios=11；settings.baseUrl=`http://127.0.0.1:8317/v1`、model=`gemini-3-flash`、planner=`gpt-6.1-sol`；WS `test-settings(full=false/full=true)` 均 ok=true；导出文件/产物/Memory/本地上下文/信任证据路径均无泄漏；helpMessages=0；浏览器控制台 error/warning 为空。
- 当前剩余边界：外部 Provider 长期稳定性、真实持续负载和跨进程故障注入仍需运行环境持续观察；导入对外部凭据和路径绑定实体仍明确提示未恢复。
- 追加安全收口：CLI/本地 MCP/Skill 等非 HTTP 连接器 endpoint 统一导出为 `endpoint://redacted`，避免命令行 token 随工作区包泄露；远程 HTTP/MCP URL 仍保留无凭据地址。一次面板回归出现已有历史持久化测试的 206/205 时序波动，原命令立即复跑 68/68 通过；本次 `npm run build` 和 lint 均通过。
- 导出安全复测再收口：连接器 trustEvidence 中本地路径也改为 `local://redacted`；面板 68/68、`npm run build`、lint 均通过。
- 便携闭环修复：`import-workspace` action 包络从 5 MB 提至有界 50 MB；导出包含 base64 文件时不再因为默认 5 MB 上限拒绝自己的正常导出。单测面板 68/68、build、lint 通过；全量 492 通过证据仍来自此前同一代码路径，schema 上限变化未影响其它测试。

## 继续生产审计：请求体 UTF-8 字节边界和最终 live 对齐（2026-10-17）

- 请求体限制改按 `Buffer.byteLength(..., "utf8")` 计算，覆盖面板 HTTP body 与同步服务 body，避免多字节中文内容绕过真实字节上限。
- 精准证据：Panel + sync-server 定向 71/71；`npm run build`、changed-file ESLint 通过；最新全量 **61 个测试文件、493 个测试通过**。
- 最新 live 已重启到最新 bundle：4320/8317 在线；快照 HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11；WS 模型探活与完整协议探活均 ok=true；导出路径、凭据 URL、信任证据本地路径均为 0；helpMessages=0。

## 继续生产审计：文档与实际入口一致性（2026-10-17）

- 发现 README 仍把左侧描述成“场景库”，并声称场景卡直接把需求带入工作模式；实际产品已改为左侧项目/对话、场景库管理入口、新建对话选择场景。
- 已同步更新 `README.md` 与 `docs/CLI_WEB_MATRIX.md`：明确新建对话场景路径、`POST /api/workspace/import` 大包入口、50MB 边界和部分实体导入提示。
- 证据：`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过；代码与 live UI 入口保持一致。

## 继续生产审计：架构与变更文档同步（2026-10-17）

- 发现 `README.md`、`CHANGELOG.md`、`ARCHITECTURE.md` 仍残留旧“三栏场景库”描述，与当前项目/对话侧栏、场景管理入口、PersistentGoalLoop 和 HTTP 大包导入不一致。
- 已同步三份文档，明确真实信息架构、新建对话场景选择、长程控制、`POST /api/workspace/import` 和部分实体导入提示。
- 证据：`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。

## 继续生产审计：移动检查台抽屉焦点恢复（2026-10-17）

- 发现移动端从“更多”菜单打开检查台时，菜单项会随菜单隐藏，关闭检查台后原焦点不可见，焦点恢复会丢失。
- 修复 `src/panel/chat-client.ts`：检查台抽屉现在检测隐藏菜单焦点，自动回退到可见的“更多”按钮；直接从可见入口打开时仍恢复原按钮。
- 验证：`npm run panel-client`、`npm run build`、全量 `npm test -- --reporter=dot --testTimeout 30000`（61 files / 493 tests）、全量 lint、`git diff --check`；live snapshot HTTP 200、busy=false、run=idle、helpMessages=0。

## 继续生产审计：长程失败/停止竞态与移动触控可用性（2026-10-17）

- 长程启动回调失败、worker 尚未安装窗口停止，现在都会写入带 `terminal=true`、`runId`、`sessionId` 的聊天终态卡；PersistentGoalLoop 在 start hook 返回后重新检查 pause/stop/abort，避免暂停已确认后进入副作用 round。
- 移动端场景库“用于新对话”独占整行，其他操作两列；项目操作两列；弹层使用 safe-area 与 `100dvh`，聊天 `jump-latest` 随可变 composer 高度动态上移，避免覆盖发送区。
- 最新全量：**61 个测试文件、495 个测试通过**；Panel integration 70/70；PersistentGoalLoop 10/10；build、全量 lint、git diff check 通过。
- 最新 live：4320/8317 在线；snapshot HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11、helpMessages=0；代理地址仍为 `http://127.0.0.1:8317/v1`。

## 继续生产审计：移动菜单到抽屉的焦点链路收口（2026-10-17）

- 继续发现：从移动端“更多”菜单打开上下文、分享、任务、连接器或检查台时，菜单先隐藏，弹层/抽屉可能把隐藏菜单项记录为恢复焦点。
- 修复 `src/panel/chat-client.ts`：菜单跳转前同步把焦点移到可见的“更多”按钮；检查台抽屉也对隐藏菜单焦点做可见按钮回退。
- 证据：全量 61 个测试文件、493 个测试通过；`npm run panel-client`、`npm run build`、全量 lint、`git diff --check` 通过；live snapshot HTTP 200、busy=false、run=idle、helpMessages=0。

- 追加收口：通用弹层在场景库按钮即将隐藏时，也会回退到可见的侧栏“新建”或入口按钮；全量回归仍为 61 files / 493 tests，live 4320 快照 HTTP 200。

## 继续生产审计：场景库弹层焦点恢复（2026-10-17）

- 发现从场景库“用于新对话”打开新建对话时，原焦点位于即将隐藏的场景库按钮，关闭弹层后焦点可能丢失。
- 修复通用弹层焦点记录：若原焦点位于隐藏容器，新建对话回退到侧栏“新建”，其它弹层回退到可见入口；与移动“更多”菜单焦点修复配合。
- 证据：全量 61 个测试文件、493 个测试通过；`npm run panel-client`、`npm run build`、全量 lint、`git diff --check` 通过；live snapshot HTTP 200、busy=false、run=idle、helpMessages=0。

## 继续生产审计：长程启动失败终态消息一致性（2026-10-17）

- 发现：`PanelServer` 的 `create-long-run` 在缺少 `onStartLongRun`、启动回调返回 `{ok:false}` 或抛异常时，虽将 durable LongRun 写为 `failed`，却没有写入 `terminal=true` 的聊天消息；用户只能在检查台看到失败，聊天信息流缺少明确终态。
- 修复：三条启动失败分支统一写入 `build-status` 失败终态卡，携带 `runId`、`sessionId`、`runStatus=failed`，继续复用 `pushChat` 的会话/运行隔离逻辑。
- 测试：`npx vitest run tests/integration/panel-integration.test.ts --testTimeout 30000 --reporter=dot` → 70/70；`npx vitest run tests/unit/persistent-loop.test.ts --testTimeout 30000 --reporter=dot` → 9/9；`npm run build` 通过；`npm run lint -- --max-warnings=0` 通过。
- 同轮修复：`src/panel/chat-client.ts` 焦点回退条件加显式括号，消除 TypeScript `HTMLElement | undefined` 构建错误。
- 下一步：继续核对长程停止/暂停后的终态消息是否各只出现一次，并做 live WS/浏览器复测。

## 继续生产审计：移动端场景库和项目操作触达

- 审计范围：`src/panel/panel.css` 手机断点、场景库卡片操作、移动侧栏项目操作和弹层安全区。
- 发现：<=720px 原六列操作布局把场景操作及项目操作压缩到约 8px，按钮文字截断，触屏难以使用；弹层 max-height 只使用 `100vh`，移动键盘/安全区下可能遮挡底部操作。
- 修复：场景库“用于新对话”独占一行，其余操作改两列并提升最小触摸高度；项目操作改两列并提高字号/高度；弹层增加 `safe-area-inset` padding 和 `100dvh` 高度约束。
- 验证：`npm run build` 通过；`npm run lint -- --max-warnings=0` 通过；`git diff --check -- src/panel/panel.css` 通过；`npm test -- --run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000`：1 file / 70 tests passed；panel-client bundle 已重新生成。
- 下一步：主任务继续真实浏览器移动尺寸复测抽屉、场景库弹层和聊天滚动锚点。

## 继续生产审计：长程启动/停止竞态和轮次入口闸门（2026-10-17）

- 发现：启动器在 worker 尚未安装的极短窗口内收到停止请求时，会直接将 durable LongRun 写为 `cancelled` 并清理检查台，但原先不会写入终态聊天卡；现已补 `runStatus=cancelled` 的终态消息。
- 发现：`PersistentGoalLoop` 在 `onRoundStart` 等待期间收到暂停/停止请求，原先仍会进入 `runRound`，可能在暂停已确认后触发副作用。现于 start hook 返回后再次检查 stop/pause/abort，再进入 round callback。
- 测试：`persistent-loop.test.ts` 新增 start-hook 暂停竞态，10/10 通过；Panel integration 70/70；`npm run build`、严格 lint 通过。

### 移动端聊天滚动锚点与可变输入框

- 发现：`jump-latest` 在手机端固定 `bottom: 68–79px`；长文本使 composer 高度超过该距离时，浮动按钮会覆盖输入框/发送按钮。
- 修复：`resizeComposer()` 测量 `.composer-wrap` 高度并写入 `--composer-height`，窗口尺寸变化也重新测量；`jump-latest` 改为动态位于 composer 上方。
- 验证：`npm run build`、`npm run lint -- --max-warnings=0` 通过；Panel integration 1 file / 70 tests passed；panel bundle 108.0kb + CSS 62.5kb。

## 继续生产审计：长程终态写入竞态保护（2026-10-17）

- `PersistentGoalLoop.finish` 现在在终态写入前重新读取 durable row：已被 stop/其它 worker 写入的终态直接保留；并优先处理 `stopRequested` 与 `pauseRequested`，避免 hook/judge 抛错或 max-round 收尾覆盖用户明确的暂停/停止。
- 新增 start-hook 抛错与暂停同时发生的测试，确认仍为可恢复 `paused`，不会伪造 `failed`。
- 本轮验证：persistent-loop 11/11；Panel integration 70/70；`npm run build` 与严格 lint 通过。

### 移动端双抽屉互斥

- 发现：手机上侧栏和检查台都可同时保留 `responsive-open`，从“更多”打开检查台时可能叠加侧栏遮罩，用户无法判断当前抽屉和焦点范围。
- 修复：`setRailOpen(true)` 会关闭检查台；`setInspectorOpen(true)` 会关闭侧栏、移除其遮罩/`rail-open` 状态并同步 ARIA，保证一次只有一个紧凑抽屉。
- 验证：`npm run build`、严格 lint 通过；Panel integration 70/70 通过；panel-chat bundle 108.5kb。

## 继续生产审计：LongRun worker 异常退出终态卡（2026-10-17）

- `launch.ts` worker promise 的异常 catch 现在在 durable LongRun 写入 `failed` 后补 `terminal=true/runStatus=failed` 聊天卡，避免执行器异常退出只更新检查台、不更新聊天流。
- 与 worker replacement race 保护一致：只有当前 worker 仍为 map owner 才能写失败和终态消息。
- 验证：persistent-loop + panel integration 共 81/81；`npm run build` 与严格 lint 通过。

## 继续生产审计：迟到暂停回调不得复活终态（2026-10-17）

- `PersistentGoalLoop.commitUpdate` 现在遇到已终态 durable row 直接返回，不再让迟到 pause/resume callback 改写 `succeeded/failed/cancelled`。
- `resume` 改走带终态保护的控制更新；覆盖 stop 赢过 pause 的竞态。
- 新增测试：停止赢过暂停后，迟到的暂停回调保持 `cancelled`，persistent-loop 12/12 通过；Panel integration 70/70；build/lint 通过。

## 继续生产审计：queued 启动窗口暂停（2026-10-17）

- `PersistentGoalLoop.pause()` 支持 worker 尚未进入首轮的 `queued` 记录：直接落为可恢复 `paused`；`run()` 识别无待判定结果的 paused checkpoint，不会因已 abort 的 controller 将其误记 cancelled。
- `launch.controlLongRun` 在 worker map 尚未安装但 durable 状态仍 queued 时，同样落 durable paused，避免启动窗口出现“没有可暂停执行器”的假失败。
- 新增 queued pause 单测；persistent-loop 13/13、Panel integration 70/70、build/lint 通过。

## 继续生产审计：迟到启动异常与移动双抽屉最终收口（2026-10-17）

- 启动失败回调和 launch worker catch 现在只处理 queued/running 且未设置 pauseRequested 的记录，迟到异常不能覆盖用户已暂停状态。
- `PersistentGoalLoop.commitUpdate` 终态保护、queued pause、stop-vs-pause、hook/judge 竞态和 worker 异常终态卡已合并。
- 移动端场景/项目触控布局、composer 动态锚点、弹层安全区、双抽屉互斥和焦点恢复均已纳入当前 bundle。
- 最新全量：**61 个测试文件、498 个测试通过**；PersistentGoalLoop 定向 13/13、Panel integration 70/70；build、全量 lint、git diff check 通过。
- 最新 live：4320/8317 在线；snapshot HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11、helpMessages=0；WS 探活和完整协议探活均 ok=true。

## 继续生产审计：上传文件 Base64 协议校验（2026-10-17）

- `upload-file` 原先直接使用 `Buffer.from(..., "base64")`，非法 Base64 可能静默生成损坏文件；异常文件名也可能归一化为空。
- 修复：上传入口复用 canonical Base64 校验，并为异常文件名提供安全回退名；新增 WS 上传非法内容回归。
- 最新全量：**61 个测试文件、501 个测试通过**；Panel integration 73/73；build、lint、git diff check 通过。
- 最新 live：snapshot HTTP 200、busy=false、run=idle、longRuns=9、helpMessages=0；WS 模型探活与完整协议探活均 ok=true。

## 继续生产审计：终态持久化异常收口与上传协议（2026-10-17）

- 终态聊天卡更新普通 RunProduct 的异步写盘现在有受控 catch，仓储异常不会升级为未处理 Promise 拒绝；聊天/内存终态仍保留。
- `upload-file` 复用 canonical Base64 校验并提供安全文件名回退，非法内容不会生成损坏文件记录。
- 最新全量：**61 个测试文件、501 个测试通过**；Panel integration 73/73；build、lint、git diff check 通过。
- 最新 live：snapshot HTTP 200、busy=false、run=idle、longRuns=9、helpMessages=0；代理配置与 WS 探活正常。

## 继续生产审计：项目状态与文件上传入口一致性（2026-10-17）

- 归档项目的侧栏“置顶”按钮现在明确禁用并标注“不可置顶”，与服务端 active-only 状态机一致，避免死按钮。
- `upload-file` 非法 Base64 防护和项目删除状态防护已进入最新 bundle。
- 最新全量：**61 个测试文件、501 个测试通过**；Panel integration 73/73；build、lint、git diff check 通过。
- 最新 live：snapshot HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11、helpMessages=0。

## 继续生产审计：归档当前项目自动切换（2026-10-17）

- 发现归档当前项目后会直接清空 `projectId`，即使工作区还有其它 active 项目也不会自动切换，下一次运行会落入无项目上下文。
- 修复：归档当前项目后按置顶优先、创建顺序选择 active replacement；没有可用项目时才保持空上下文。
- 新增项目导航回归；Panel integration 73/73；最新全量 **61 个测试文件、501 个测试通过**；build、lint、git diff check 通过。
- 最新 live snapshot HTTP 200、busy=false、run=idle、longRuns=9、helpMessages=0。

## 继续生产审计：项目删除状态机与事件 fan-out 收口（2026-10-17）

- 已删除项目不能再次 archive/restore/delete/pin，避免 soft-delete 项目被管理协议复活或重新置顶；新增项目生命周期回归。
- `trigger-event` 匹配多个后台任务时在副作用前拒绝，避免单会话锁造成部分触发却整体失败。
- 最新全量：**61 个测试文件、500 个测试通过**；Panel integration 72/72；build、lint、git diff check 通过。
- 最新 live：4320/8317 在线；snapshot HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11、helpMessages=0；WS 探活和完整协议探活均 ok=true。
- 真实 IAB 当前仍是桌面 viewport，移动端本轮以 CSS/DOM/集成证据验证，尚未虚称完成真实手机尺寸浏览器截图复测；该项作为剩余验证边界保留。

## 继续生产审计：长程 queued 启动窗口与最终收口（2026-10-17）

- queued worker 尚未安装时暂停现在直接落为可恢复 paused；PersistentGoalLoop 不会因已 abort controller 把它误记 cancelled，launch 控制器也不再返回“没有可暂停执行器”的假失败。
- 当前长程控制覆盖 queued/running/paused、stop/pause 竞态、worker replacement、hook/judge 异常和终态聊天卡。
- 本轮新增 queued pause 证据：PersistentGoalLoop 13/13、Panel integration 70/70、build/lint 通过；目标继续保持 active。

## 继续生产审计：暂停优先级、移动双抽屉和最终回归（2026-10-17）

- 启动失败/worker 异常分支现在跳过带 `pauseRequested` 或 durable paused 的记录，不会把迟到异常覆盖用户暂停。
- 移动端场景/项目触控布局、composer 动态锚点、safe-area、双抽屉互斥和焦点恢复均已进入最新 bundle。
- 最新全量：**61 个测试文件、498 个测试通过**；PersistentGoalLoop 13/13、Panel integration 70/70；build、lint、git diff check 通过。
- 最新 live：4320/8317 在线；snapshot HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11、helpMessages=0；WS 探活与完整协议探活均 ok=true。

## 继续生产审计：事件调度部分触发防护（2026-10-17）

- 发现 `trigger-event` 匹配多个后台任务时会并发调用单会话 `run-task`，第一个任务可能已经启动，后续任务却因 session lock 失败，最终形成部分触发但返回整体失败。
- 修复：同一事件匹配多个任务时在任何副作用前明确拒绝，要求拆分事件；单任务事件仍沿用原 run-task 路径。
- 新增 Panel integration 回归；真实 WS missing-event 返回明确“没有匹配的事件任务”，snapshot 保持 busy=false、run=idle、helpMessages=0。
- 最新全量：**61 个测试文件、499 个测试通过**；Panel integration 71/71；build、lint、git diff check 通过。

## live 终态控制协议复测（2026-10-17）

- 对当前会话已 succeeded 的 LongRun 真实 WS 发送 pause/resume/stop：分别返回“没有可暂停执行器”“只有已暂停的长程运行可以继续”“长程运行已结束”。
- 对其它会话的 LongRun 发送同样控制动作：统一返回“长程运行不属于当前对话”。
- 复测后 snapshot 保持 busy=false、run=idle、LongRun=succeeded、helpMessages=0，没有写入新运行或聊天。
- 移动真实尺寸 viewport 在当前 IAB 不可绑定，本轮保留 CSS/DOM/集成证据，不虚称完成手机截图复测。

## 继续生产审计：暂停请求优先于启动器异常（2026-10-17）

- PanelServer 启动回调失败分支和 launch worker 异常分支现在不覆盖带 `pauseRequested` 的 queued/running 记录，避免暂停中的长程执行被迟到启动错误误记 `failed`。
- launch worker 异常分支不再把已 durable paused 的记录改写失败。
- 验证：persistent-loop 13/13、build/lint 通过。

## 全量回归：长程竞态与终态消息修复后（2026-10-17）

- `npm test -- --reporter=dot --testTimeout 30000`：61 个测试文件、498 个测试通过。
- pretest 重新构建 panel client 与 kernel/launcher bundle；无失败。
- 同轮 build/lint 亦通过。

## 继续生产审计：项目删除状态机与事件 fan-out 收口（2026-10-17）

- 已删除项目现在不能再次 archive/restore/delete，避免协议把 soft-deleted 项目复活；新增项目生命周期回归。
- `trigger-event` 匹配多个后台任务时在副作用前拒绝，避免单会话锁造成部分触发却整体失败。
- 最新全量：**61 个测试文件、500 个测试通过**；Panel integration 72/72；build、lint、git diff check 通过。
- 最新 live：4320/8317 在线；snapshot HTTP 200、busy=false、run=idle、longRuns=9、sessions=23、scenarios=11、helpMessages=0；WS 探活和完整协议探活均 ok=true。

## 真实用户路径复测与测试数据清理（2026-10-17）

- 从浏览器真实走通：新建对话 → 选择“整理 /data/play 的数据并生成简报” → 进入空会话 → 发送需求 → 代理流式输出 → 场景执行 → 证据不足失败态；失败运行可从运行中心打开详情并点击“重试”，重试创建新 run、保留原需求和场景上下文。
- 真实页面证据：场景选择弹层显示自然命名；运行中显示暂停/停止；失败详情显示重试/创建分支；运行中心展示新旧运行记录；重试后的会话标题自动变为用户需求摘要，不再停留在“新对话”。
- 本轮临时会话 `session-1792188078997-ilaax3` 曾生成两个验证产物，已通过真实 WS `delete-session(confirm=true)` 删除会话，并通过 WS 删除两个临时 artifact；HTTP `/api/snapshot` 复核确认测试会话和测试产物均已消失。
- 最终 live 复核：HTTP snapshot 200，`busy=false`、`run=idle`、`sessionCount=24`、`artifactCount=44`、`scenarioCount=11`、`helpMessages=0`；配置仍为代理 `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`；WS `test-settings` short/full 均返回 `ok=true`。
- 最终前端标签页截图可见干净的新对话状态，控制台错误/警告为空；桌面 viewport 已复核。当前 IAB 工具不具备绑定原用户标签页确认弹窗后的恢复能力，因此另外打开并保留了一个干净的 `?qa=final-healthy` 标签页供继续使用；没有把这一工具限制虚称为移动尺寸复测。
- 最新全量回归：`npm test -- --reporter=dot --testTimeout 30000` 为 **61 个测试文件、501 个测试通过**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 均通过。

## 响应式交互定向审计：更多菜单检查台、焦点恢复与命令菜单锚点（2026-10-17）

- 发现：移动端从“更多”菜单点击“检查台”时，菜单原始 click 继续冒泡到 document outside-click 处理器；检查台刚打开就会被判定为外部点击并关闭。
- 修复：`src/panel/chat-client.ts` 的 utility-menu action handler 在分派真实 opener 前调用 `stopPropagation()`。
- 发现：抽屉/模态关闭后的焦点恢复仅检查 `.hidden`，移动端侧栏使用 CSS `display:none` 时，焦点可能恢复到不可见的 `new-session`/场景入口。
- 修复：新增 `isVisibleElement`（连接状态、`.hidden`/`aria-hidden` 与实际布局矩形）统一验证 rail、inspector、utility menu 和 modal 的恢复目标，并加入移动端 `open-rail` 可见回退。
- 修复：`src/panel/panel.css` 的命令建议菜单改用 `--composer-height` 动态 bottom，长草稿和安全区 padding 增长时不会覆盖发送区。
- 验证：`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过；`npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` 重跑 **75/75 通过**。已执行 `npm run panel-client` 并重启 4320 最新 launcher；子 agent IAB 不支持 visibility，真实浏览器交互留主线程复用现有 tab 复测。

## 会话生命周期与项目上下文隔离定向审计（2026-10-17）

- 发现历史会话没有持久化当前项目，启动时总回退到 pinned/first 项目；历史切回后可能把运行落到另一项目。修复：`PanelSession` 增加可迁移 `projectId`，启动先恢复 workspace 再 hydrate session，新建/选择/创建/归档/删除项目和会话替换均写入当前绑定；历史切换/恢复重新应用项目上下文，非法或已归档绑定回退到 active 项目。
- 发现直接 WS `retry-run`/`branch-run` 只校验 workspace，已结束的其它会话运行可被注入当前会话。修复：要求运行 `sessionId` 与当前会话一致。
- 发现非当前历史会话若仍有普通/长程活动运行，归档或删除会隐藏唯一控制入口。修复：服务端归档/删除前检查 workspace 内 queued/running/waiting-approval/paused 普通运行及 active LongRun。
- 证据：`npx tsc --noEmit --pretty false` 通过；`npx vitest run tests/unit/panel-history.test.ts tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` 为 2 files / 77 tests 通过；随后 `npx vitest run tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` 为 76/76 通过；`git diff --check` 通过。
- 后续：根线程需重跑全量并重启生产 bundle，再用真实代理 snapshot/WS 复测。

## 响应式修复后全量回归与 live 重启（2026-10-17）

- 复测：`npm test -- --reporter=dot --testTimeout 30000`，**61 个测试文件、504 个测试通过**；期间 `panel-client`、kernel、launcher 均重新构建。
- 静态门禁：`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。
- 重新启动 4320 最新 launcher 后，HTTP snapshot 200，`busy=false`、`run=idle`、`sessions=24`、`scenarios=11`、`helpMessages=0`，代理 `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`。
- Node WS 探活收到 snapshot，`ok=true`、`busy=false`、`run=idle`；当前监听进程为 4320 owner 64892。

## 响应式抽屉键盘焦点循环（2026-10-17）

- 发现：移动端 rail/检查台打开后，Tab 可以离开抽屉并落到遮罩背后的页面，导致键盘用户失去当前层级。
- 修复：`src/panel/chat-client.ts` 在全局 Tab 处理器中识别 `.rail.responsive-open` / `.inspector.responsive-open`，仅在可见抽屉内循环首尾焦点；抽屉未包含当前焦点时将 Tab 收回首项，Escape 行为保持原有关闭逻辑。
- 验证：`npm test -- --reporter=dot --testTimeout 30000` = **61 个测试文件、504 个测试通过**；build/lint 通过。最新 launcher 重启后 HTTP snapshot 200、busy=false、run=idle、sessions=24、scenarios=11、helpMessages=0；Node WS snapshot probe ok=true。

## 会话项目绑定迁移与长程恢复补强（2026-10-17）

- 启动顺序调整后，`hydrateSession` 直接在 workspace 已就绪时应用持久化项目；活动 LongRun 恢复时以其自身 `projectId` 重新绑定，兼容旧会话没有 projectId 的迁移数据，避免恢复检查台显示错误项目。
- 无效/归档项目绑定统一回退 pinned/first active 项目；删除当前项目也采用 pinned 优先替换。
- 验证：`npx tsc --noEmit --pretty false` 通过；`npx vitest run tests/unit/panel-history.test.ts tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` 为 2 files / 77 tests 通过。
- 新增真实重启回归：选择项目并保存会话后停止/重启 PanelServer，当前会话 ID 与 projectId 均恢复；Panel integration 77/77 通过。

## 全量回归：会话生命周期补丁后（2026-10-17）

- `npm test -- --reporter=dot --testTimeout 30000`：**61 个测试文件、505 个测试通过**；pretest 同步重建 panel/kernel/launcher bundle。
- `npm run lint -- --max-warnings=0` 通过；`git diff --check` 通过。

## 最终源码状态复核：会话迁移、焦点循环与代理链路（2026-10-17）

- 最终全量：`npm test -- --reporter=dot --testTimeout 30000` 为 **61 个测试文件、505 个测试通过**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 全部通过。
- 最新 launcher 已重启；HTTP `/api/snapshot`：`busy=false`、`run=idle`、`sessionCount=24`、`artifactCount=44`、`scenarioCount=11`、`helpMessages=0`、`projectId=project-1790975354024-c6u1be`；代理 `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`。
- WS `test-settings` short/full 均返回 `ok=true`；真实跨会话 `branch-run` 请求返回“运行不属于当前对话，不能创建分支”，确认服务端隔离生效。
- 最新干净 IAB 标签页已 reload，页面显示新对话/空闲/已连接，浏览器 console error/warning 为空；桌面视觉复核通过。
- 移动端仍保留真实证据边界：当前 IAB 工具无法绑定手机尺寸 viewport，因此移动行为以 CSS、DOM、焦点逻辑、集成测试和源码证据验证，没有虚称完成手机截图复测。
- README/CHANGELOG 已记录会话项目绑定、跨会话重试/分支限制和活动历史会话不可归档/删除规则；lint、diff check 仍通过。
- 清理无用的启动迁移临时字段后，`npx tsc --noEmit --pretty false` 与 Panel integration 77/77 仍通过；行为不变。

## 最终交付前复测：清理字段后最终证据（2026-10-17）

- 清理无用迁移字段后重新跑最终全量：`npm test -- --reporter=dot --testTimeout 30000` = **61 个测试文件、505 个测试通过**。
- 最终 `npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 均通过；pretest 重建 panel client、kernel 和 launcher。
- 最终 launcher 已重启；snapshot：`busy=false`、`run=idle`、`sessionId=session-1792188399378-xkaq94`、`projectId=project-1790975354024-c6u1be`、`sessions=24`、`artifacts=44`、`scenarios=11`、`chat=0`、`helpMessages=0`；代理 `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`。
- WS `test-settings` short/full 均返回 `ok=true`；跨会话 `branch-run` 真实请求拒绝并返回“运行不属于当前对话，不能创建分支”。
- 干净 IAB 标签页已 reload 最新页面，console error/warning 为空；真实桌面页面可见且可继续使用。移动尺寸 viewport 仍是工具能力边界，已用 CSS/DOM/焦点循环/集成测试证据覆盖。

## 最终回归收口（2026-10-17）

- 临时字段清理后的最终全量仍为 **61 个测试文件、505 个测试通过**；build、严格 lint、diff check 均通过。
- launcher 已按最终 dist 重启，当前 4320 owner=32692；HTTP snapshot 200，`busy=false`、`run=idle`、`sessionCount=24`、`artifactCount=44`、`scenarioCount=11`、`chat=0`、`helpMessages=0`，代理 `8317/v1`、模型 `gemini-3-flash`。
- WS short/full model health 均 `ok=true`；跨会话分支隔离真实返回拒绝；最终干净 IAB 页面已 reload，console error/warning 为空。

## 调度器每日计划补触发审计（2026-10-17）

- 发现：`src/product/scheduler.ts` 的 `isDue(HH:mm)` 原先要求精确命中该分钟；在 30 秒轮询、启动延迟或 I/O 阻塞时会漏掉整天的每日任务。
- 修复：当天尚未执行且当前本地时间已达到计划时刻即可补触发；保留 `lastRunAt` 当天去重，并拒绝 `24:00` 等非法时刻。
- 验证：`npx vitest run tests/unit/scheduler.test.ts --reporter=dot --testTimeout 30000` = 1 file / 5 tests passed。

## 调度器任务并发审计（2026-10-17）

- 发现：`TaskScheduler.tick()` 虽有每任务 `inFlight`，但循环逐个等待；任一任务达到超时会阻塞同一轮其它到期任务，造成后台任务延迟甚至错过计划。
- 修复：改为 `Promise.all` 对每个到期任务独立执行；每任务仍独立记录成功/失败/超时，超时操作仍保留 inFlight 到底层 Promise 结束，防止重入。
- 验证：`npx vitest run tests/unit/scheduler.test.ts --reporter=dot --testTimeout 30000` = 1 file / 6 tests passed；`npx tsc --noEmit --pretty false` 通过。

## 代理调度链路最终复测（2026-10-17）

- 发现并修复 `HH:mm` 每日任务错过计划分钟后整天漏执行的问题：改为当日未执行且当前时间已到计划时刻即可补触发，保留 `lastRunAt` 去重和非法时刻校验。
- 发现并修复 scheduler 逐任务等待导致单任务超时阻塞其它到期任务的问题：改为任务级并发处理，每个任务独立超时、落库和 inFlight 防重入。
- 定向 scheduler：**1 文件、6 测试通过**；代理、ModelClient、fallback、WS requestId 和断线边界未发现新的可证实问题。
- 最新全量：**61 个测试文件、506 个测试通过**；build、严格 lint、diff check 通过。
- 最新 launcher 已重启；snapshot `busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11、chat=0、helpMessages=0；代理 `8317/v1`、模型 `gemini-3-flash`；WS short/full health 均 `ok=true`。

## 调度器并发修复最终复测（2026-10-17）

- `TaskScheduler.tick()` 现对所有到期任务并发执行，单任务超时不会阻塞其它任务；每个任务仍独立更新状态，底层超时操作完成前保持 `inFlight`。
- Scheduler 定向 **1 文件、6 测试通过**。
- 最终全量：**61 个测试文件、506 个测试通过**；build、严格 lint、git diff check 通过。
- 最新 launcher 已重启，HTTP snapshot 200，`busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11；代理 `8317/v1`、模型 `gemini-3-flash`；WS health short/full 均 `ok=true`。

## 资源作用域审计：Memory 归属边界（2026-10-17）

- 发现：`create-memory` 原先允许 `project`/`scenario` scope 在没有当前项目或活动场景时创建 `projectId=null`/`scenarioId=null` 的记录；运行时项目过滤会把未绑定项目 Memory 当作可复用项，可能泄漏到其它项目运行。
- 修复：`src/panel/server.ts` 在写入边界要求 project scope 有当前 active 项目且属于当前 workspace，scenario scope 有当前 active 场景且状态为 active；无归属请求直接拒绝。
- 验证：新增 `tests/integration/panel-integration.test.ts` 作用域测试；定向 `npx vitest run tests/integration/panel-integration.test.ts -t "项目或场景 Memory 没有所属上下文时拒绝创建" --reporter=dot --testTimeout 30000` = 1 passed / 77 skipped；`npx tsc --noEmit --pretty false` 通过。

## 资源作用域隔离审计（2026-10-17）

- 发现 `create-memory` 在没有当前项目或活动场景时仍可创建 `project/scenario` 作用域记录，可能以 null 归属被其它项目复用。
- 修复：project Memory 必须绑定当前 workspace 的 active project；scenario Memory 必须绑定当前 active scenario；缺少上下文、归档或不存在时直接拒绝。
- 资源边界同时覆盖 artifact/share/comment/context/task/project/scenario 的跨 workspace、删除、归档、恢复组合，未发现第二个已证实问题。
- 定向回归：1 个新增集成测试通过；最终全量 **61 个测试文件、507 个测试通过**；build、严格 lint、git diff check 通过。
- 最新 launcher 已重启；snapshot `busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11、chat=0、helpMessages=0；代理 `8317/v1`、模型 `gemini-3-flash`；WS short/full health 均 `ok=true`。

## 工作区导入回滚审计（2026-10-17）

- 发现工作区导入先写入文件、后登记项目文件索引；索引写入失败时会留下磁盘孤儿文件。
- 修复：`src/panel/server.ts` 在 `addFile` 失败时删除刚写入的目标文件；新增回归测试确认索引为空且项目目录不残留孤儿文件。
- 定向测试：新增导入回滚测试通过；最终全量 **61 个测试文件、508 个测试通过**；build、严格 lint、git diff check 全部通过。
- 最新 launcher 已重启；snapshot `busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11、chat=0、helpMessages=0；代理 `8317/v1`、模型 `gemini-3-flash`；WS short/full health 均 `ok=true`。

## Memory 命令路径隔离审计（2026-10-17）

- 发现 `/memory forget` 旧命令路径只检查 Memory 根目录，知道文件路径即可尝试删除其它 workspace 的 Memory 文件，绕过元数据归属校验。
- 修复：命令删除前必须在当前 workspace 的 Memory 元数据中找到同路径记录；跨 workspace 或未登记路径直接返回“Memory 不存在”。新增跨 workspace 文件保留回归。
- 最终全量：**61 个测试文件、509 个测试通过**；build、严格 lint、git diff check 通过。
- 最新 launcher 已重启；snapshot `busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11、chat=0、helpMessages=0；代理 `8317/v1`、模型 `gemini-3-flash`；WS short/full health 均 `ok=true`。

## 最终资源/导入边界复测（2026-10-17）

- 最终源码同时包含工作区导入孤儿文件回滚和 `/memory forget` workspace 归属校验。
- 最终全量：**61 个测试文件、509 个测试通过**；build、严格 lint、git diff check 通过。
- 最新 launcher 已重启；snapshot `busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11、chat=0、helpMessages=0；代理 `8317/v1`、模型 `gemini-3-flash`；WS short/full health 均 `ok=true`。

## Memory 路径操作最终隔离复测（2026-10-17）

- `update-memory` / `delete-memory` 在缺少 memoryId 时也统一要求路径属于当前 workspace 的 Memory 元数据，避免绕过 ID 校验删除或修改其它 workspace 文件。
- 新增跨 workspace 无 ID 操作回归；最终全量 **61 个测试文件、509 个测试通过**。
- build、严格 lint、git diff check 通过；最新 launcher 已重启，HTTP snapshot 200、`busy=false`、`run=idle`、sessions=24、artifacts=44、scenarios=11；代理 `8317/v1`、模型 `gemini-3-flash`；WS short/full health 均 `ok=true`。

## ModelClient / Planner 终止与流超时审计（2026-10-17）

- 发现：OpenRouterPlanner 规划请求只使用内部 timeout，没有绑定当前运行的 AbortSignal；面板停止构建时可能继续等待 provider 超时。流式 ModelClient 在已收到部分输出后发生 timeout 时还可能把运行时 DOMException 原样传到聊天终态。
- 修复：`OpenRouterPlanner.setAbortSignal()` 将运行终止信号与请求 timeout 合并；launcher 新建/恢复构建时绑定 `runAbort`，终止时保留已 aborted 绑定直到本轮 promise settle、再在 finally 清理，避免与下一次 planner 调用竞态；fallback 在用户终止后不再发起（请求会捕获本轮 signal，即使清理发生在 promise unwind 之前）。构建流程在解析/检索后再次检查终止，避免停止后继续创建执行任务。ModelClient 流式和非流式 body 读取 timeout 统一转换为可操作的中文 `ModelConnectionError`，保留“部分流不重试”语义。
- 定向验证：planner/model-client/work-execution/panel-stop 共 4 个文件、90 个测试通过；其中 planner 10/10、model-client 6/6；`npm run build` 与针对性 ESLint 通过。
- 真实链路已复测：重新构建 `dist/panel-launcher.js` 后启动 4320，WS 发送 `start-build` 随即发送 `control terminate`，两个 action-result 均返回 `ok=true`；持久化运行记录 `run-1792190717645-n83n70` 终态为 `status=cancelled`、`error=已终止`，HTTP `/api/snapshot` 同步显示 `busy=false`、`run.status=cancelled`、`run.text=已终止`。本次运行的 `tokenCount` 仍为 null，且单元回归已验证终止竞态只发一次 provider 请求、不发 fallback。
- 终止修复后的最终回归：`npm test -- --reporter=dot --testTimeout 30000` = **61 个测试文件、512 个测试通过**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 全部通过。
- 最新 live 配置与健康：`http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`、`streaming=true`、`hasApiKey=true`；4320 HTTP snapshot 200，当前 `busy=false`、`run.status=cancelled`（刚完成的真实停止探针）、`sessions=24`、`scenarios=11`、`chat=3`。launcher 仍在前台会话运行。

## 真实停止探针后的干净会话（2026-10-17）

- 为避免把停止探针的过程消息留在用户当前视图，真实 WS 新建了一个空白会话；旧运行记录仍保留在历史中，未删除用户数据。
- 最新 HTTP snapshot：`busy=false`、`run.kind=idle`、`run.status=idle`、`chat=0`、`sessions=25`；页面 reload 后 AX 状态显示“等待输入”，发送按钮保持禁用直到输入需求，前端连接状态为“已连接”。
- 最新桌面截图复核未见布局溢出；当前工具没有手机 viewport 绑定能力，移动端结论仍以 CSS、DOM、焦点循环和集成测试证据为界，不虚称手机截图验证。

## 侧栏场景入口收敛（2026-10-17）

- 用户路径审计发现左侧底部独立“场景库”与项目、对话并列，重复了新建对话时的场景选择入口，增加了侧栏信息层级和移动端抽屉噪声。
- 修复：`src/panel/server.ts` 将 `open-scenarios` 收进现有“项目工具”折叠区，移除独立 `rail-library-section`；保留原按钮 ID、点击行为、无障碍名称，并让移动端抽屉复用同一入口。
- 视觉：`src/panel/panel.css` 为折叠区内的场景库管理按钮提供整行触控目标，避免与添加文件/导入工作区按钮挤在同一行。
- 回归：Panel integration **80/80** 通过；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。断言确认场景入口只出现一次、位于项目工具 details 内且不再存在独立底部区块。
- 清理：删除侧栏旧场景导航的无效 CSS 选择器，避免独立入口样式残留；HTML smoke、build、严格 lint 复测仍通过。

## 侧栏收口后的最终线上复测（2026-10-17）

- UI/CSS bundle 重新生成并重启 4320 launcher；HTTP snapshot 200，当前 `busy=false`、`run.kind=idle`、`run.status=idle`、`chat=0`、`sessions=25`、`scenarios=11`。
- 干净 IAB 桌面页 reload 后 AX 显示“工作区侧栏 → 项目工具（折叠）→ 会话/对话”，左侧底部不再出现独立场景库块；主区显示“今天要完成什么？”和“等待输入”，连接状态为“已连接”。
- 侧栏改动后的全量回归仍为 **61 个测试文件、512 个测试通过**；Panel integration **80/80**；`npm run build`、`npm run lint -- --max-warnings=0`、`git diff --check` 通过。
- 随后清理无效旧选择器后重新执行 `npm run panel-client`、Panel integration **80/80**、`npm run build` 和严格 lint，并重启 4320；线上 HTML 复核 `open-scenarios` 只出现 1 次、独立底部区块出现 0 次，snapshot 仍为 `busy=false` / `run=idle` / `chat=0`。

## 长程控制边界复测（2026-10-17）

- 发现并修复：长程创建显式选择其它项目时，持久化 LongRun 已绑定新项目，但当前会话和面板仍停留在旧项目；`src/panel/server.ts` 现会在重复运行检查通过后验证并同步 `applySessionProject(projectId)`，后续运行、历史和上下文保持同一项目边界；重复请求在失败时不会改变当前项目。
- 发现并修复：旧 `GoalLoop` 在目标达成时重复发出 `round:end`，且唯一事件曾携带旧的 `goalMet=false`；现在每轮只发一次，并在事件发出前写入最终目标判定。
- 发现并修复：同一 `PersistentGoalLoop` 实例暂停后继续时复用已 aborted 的内部控制器，导致恢复立即取消；`resume()` 现在重建内部控制器、重新绑定外部 abort，并清理暂停/停止标记。
- 新增回归：显式项目切换的长程创建、活动长程重复请求无副作用、GoalLoop 单次且带最终判定的 `round:end`、PersistentGoalLoop 同实例暂停/继续。
- 定向验证：三文件组合 **128 个测试通过**；GoalLoop/PersistentGoalLoop 单元组合 **46/46**；重复请求单测过滤 **1 passed / 81 skipped**；`tsc`、严格 lint、diff check 均通过。
- 后续已完成主流程合并回归、全量测试、build、严格 lint、diff check 和 4320 真实 WS/API 复测；证据见“聊天/长程并发补丁合并回归”和“临时会话滚动边界复测”。

## Chat/mobile path audit: scroll continuity and long-run intent isolation (2026-10-17)

- 发现：服务端会在运行进度、项目操作、设置和导航后频繁推送 snapshot；前端原先每次 snapshot 都把 `chatNeedsInitialScroll` 置为 true，用户阅读历史消息时会被强制拉回底部。
- 修复：新增 `src/panel/chat-state.ts`，首次 snapshot 或切换 `sessionId` 才重置对话滚动位置；同一会话的普通 snapshot 保留用户位置。新增 3 个纯函数回归断言。
- 发现：新建对话勾选长程后，在新建请求完成前切换历史/项目/模式，旧 `pendingLongRunConfig` 可能在相同场景下误触发长程运行。
- 修复：长程暂存配置绑定新会话 ID；历史会话、项目或模式切换会清理暂存；新建失败也清理；发送长程前同时校验会话和场景。新增会话隔离断言。
- 验证：`npx vitest run tests/unit/chat-state.test.ts tests/integration/panel-integration.test.ts --reporter=dot --testTimeout 30000` = **2 文件、85 测试通过**；`npm run panel-client`、`npx tsc --noEmit --pretty false`、`git diff --check` 通过。
- 并发引入的 `releaseRound` / `roundReady` 未使用变量已在后续合并回归中清理，严格 lint 已恢复通过。

## 聊天/长程并发补丁合并回归（2026-10-17）

- 已清理并发测试中未使用的 `releaseRound` / `roundReady`，严格 lint 恢复通过。
- 定向回归：8 个测试文件、158 个测试通过；包含聊天滚动/长程意图隔离、GoalLoop、PersistentGoalLoop、Planner、ModelClient、WorkExecution、Panel stop 和 Panel integration。
- 最终全量回归：**62 个测试文件、520 个测试通过**；`npm run build`、`npm run lint -- --max-warnings=0`、`npx tsc --noEmit --pretty false`、`git diff --check` 全部通过；pretest 已重建 panel/kernel/launcher bundle。
- 最新 launcher 已重启并真实复核：HTTP snapshot 200，`busy=false`、`run.kind=idle`、`run.status=idle`、`chat=0`、`sessions=25`、`scenarios=11`、`longRuns=9`；代理 `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`、规划器 `gpt-6.1-sol`、fallback `gpt-6-luna`、`streaming=true`、`hasApiKey=true`。
- WebSocket `test-settings(full=true)` 返回 `ok=true`；干净 IAB 页面 reload 后 AX/截图显示“已连接”“等待输入”、项目工具折叠区、无独立底部场景库块，发送按钮在空输入时禁用。

## 临时会话滚动边界复测（2026-10-17）

- 发现临时会话没有 durable `sessionId`，从有消息的临时会话新建空会话时会出现 `null → null`，单靠会话 ID 无法触发聊天滚动重置。
- 修复：`shouldResetChatScroll` 同时检测消息数量回退；补充 null 会话切换测试，避免新临时会话继承旧阅读位置。
- 定向 chat-state + Panel integration：**87 个测试通过**；随后最终全量：**62 个测试文件、521 个测试通过**；panel-client、build、严格 lint、tsc、diff check 均通过。
- 最新 launcher 已重启，HTTP snapshot `busy=false` / `run=idle` / `chat=0`，WS full settings health `ok=true`；IAB reload 后仍显示“已连接”“等待输入”和干净空对话。

## 2026-10-17 运行恢复与代理边界审计（live_proxy_recovery_audit）
- 运行恢复修复：`shouldCancelAfterRestart` 改用 durable RunProduct id；launch 为新构建写入 `run.details.buildId`，启动后重启恢复优先精确 buildId。历史旧行仅在 requirement + project 唯一匹配时恢复，同文本多会话不再误恢复；歧义行全部按无检查点取消。
- 代理配置边界：PanelServer 新增当前 workspace Provider 校验；`update-settings`、`test-settings`、`update-project`、`start-build` 拒绝跨 workspace Provider 绑定。`test-settings` 消费并校验 `/models` JSON 与 chat/tool completion envelope，HTTP 200 空/错误 body 会返回失败，不再把健康探活当作可运行模型。
- 精准证据：`npm test -- --run tests/unit/run-recovery.test.ts --reporter=dot --testTimeout 30000`：1 file / 6 tests passed；`npm exec tsc -- --noEmit` passed。此前同轮 panel integration + run recovery：2 files / 86 tests passed。
- 当前工作树共享，父智能体需复核 server.ts provider 改动并继续运行 integration/full/live 复测；本子任务已停止继续编辑 provider 相关文件。
- 追加运行恢复会话隔离：`selectResumableBuildContext` 只从 hydrated 当前 session 的 active build rows 选择 checkpoint，防止重启时把其它历史会话的最新 pending build 恢复到当前对话。
- 证据更新：run-recovery 定向测试 1 file / 7 tests passed，tsc 通过。
- 运行恢复再收紧：恢复匹配和保留集合均绑定 hydrated 当前 sessionId；其它历史会话遗留的 active build rows 会在启动时取消，避免保留一个无 worker 的幽灵运行。run-recovery 定向测试仍 1 file / 7 passed，tsc 通过。

## Provider 边界与恢复修复最终复测（2026-10-17）

- 复核并补强：Provider 读取统一经过当前 workspace 校验；项目绑定、设置绑定、start-build 和 test-settings 都拒绝跨 workspace Provider。启动器的默认 Provider、项目 Provider、运行 Provider 和成本统计也只接受当前 workspace profile。
- 健康探测现在必须得到合法 `/models` JSON、可用 chat completion 和可用 tool probe；HTTP 200 空 body、错误 JSON 或 HTML body 都会失败。
- 修复 start-build Provider 校验顺序：无效 Provider 在获取运行锁之前拒绝，不会留下永久 `busy` 状态。
- 重启恢复改为精确匹配 `run.details.buildId` 与当前 hydrated session；旧数据只有唯一 requirement/project 匹配才恢复，重复需求或其它会话全部取消，避免幽灵运行和会话串线。
- 精准回归：Panel integration **83/83**、run-recovery **7/7**；`npm run build`、严格 lint、tsc、`git diff --check` 通过。
- 全量回归：**62 个测试文件、525 个测试通过**；pretest 重建 panel/kernel/launcher bundle。
- 最新线上：4320 snapshot 200，`busy=false`、`run=idle`、`chat=0`、`sessions=25`、`scenarios=11`、`longRuns=9`；代理 `http://127.0.0.1:8317/v1`、模型 `gemini-3-flash`、规划器 `gpt-6.1-sol`、fallback `gpt-6-luna`、streaming 开启；真实 WS `test-settings(full=true)` 返回 `ok=true`。

## 对话历史分组可见性修复（2026-10-17）

- 真实线上快照确认会话数据仍在：25 个 active sessions，其中最近项显示在左侧，其余历史项位于可展开分组；问题是分组标题写成“更多进行中”，但其中实际包含已完成的历史对话，且没有归档记录时会让用户误以为历史管理为空。
- 修复：`src/panel/chat-client.ts` 将分组名称改为“更多历史对话”，保持原有展开、归档、删除和切换行为。
- 验证：Panel integration **83/83**、panel-client、tsc、严格 lint 通过；bundle 重建并重启 4320；真实 AX 复核显示“更多历史对话 16”，展开后可见历史会话列表。

## 历史对话默认可见性复测（2026-10-17）

- 进一步发现：即使分组标题改正，历史分组默认折叠时用户仍可能把它理解成空列表。
- 修复：有历史项时“更多历史对话”首次渲染默认展开；用户手动收起后，普通 snapshot 刷新会保留收起状态。
- 定向验证：Panel integration **83/83**、panel-client、tsc、严格 lint 通过；重建 bundle、重启 4320 后真实 AX 显示 `更多历史对话 16` 为 expanded，并直接列出历史会话。
- 随后再次全量回归：**62 个测试文件、525 个测试通过**；bundle 重建并重启 4320，snapshot 保持 `busy=false` / `run=idle` / `chat=0`；真实 AX 仍显示历史分组 expanded，WS full health 为 `ok=true`。

## 多标签页旧 bundle 复核（2026-10-17）

- 发现用户浏览器同时保留两个 4320 标签页：旧标签页仍显示旧 bundle 的独立“场景库”和“更多进行中”，会造成源码已修复但用户仍看到旧界面的错觉。
- 处理：刷新旧标签页 `final-focus-check`，不改任何数据；两个标签页现在都加载最新 bundle。
- 真实 AX 复核：旧标签页同样显示“更多历史对话 16”并展开历史列表，底部独立场景库已消失；当前快照仍 `busy=false` / `run=idle`。

## 目标完成审计（2026-10-17）

- 场景入口与自然命名：新建对话选择场景、场景库管理入口、历史命名迁移均有源码、Panel integration 和浏览器 AX 证据。
- 聊天信息流与侧栏：流式分块、滚动连续性、临时会话滚动、历史分组、项目工具折叠区、抽屉焦点循环均有定向测试和真实 AX 证据。
- 运行状态：暂停/继续/停止/重试/分支/失败终态、长程 GoalLoop/hooks、重启恢复和项目上下文隔离均有单元/集成/真实 WS/API 证据。
- 代理链路：AbortSignal、fallback 竞态、超时错误、Provider workspace scope、models/chat/tool health probe 均有测试；真实代理 full probe 返回 `ok=true`。
- 质量门禁：全量 **62 个测试文件、525 个测试通过**；build、严格 lint、tsc、diff check 通过；4320 当前 idle 且两个浏览器标签页均已刷新到最新 bundle。
- 剩余边界：当前浏览器工具不能绑定真实手机 viewport，因此手机尺寸截图未宣称完成；移动 CSS、DOM、焦点循环、键盘逃逸、触屏抽屉和集成测试证据已记录。未发现其它可复现的可避免问题。

## 新场景真实构建与历史栏高度修复（2026-10-17）

- 真实浏览器构建路径：场景构建模式输入“构建一个本地会议纪要整理场景，读取会议记录并生成行动项清单”，经代理完成规划、候选能力检索、自动闸门和固化。
- 真实终态：`run-1792197488403-veitkf` 为 `succeeded`，场景已固化为同名 v1，AX 显示“已经完成”、5/5、任务 DAG、能力选型和构建产物；当前 snapshot `busy=false`、`run.status=succeeded`、`scenarios=12`、`artifacts=45`。
- 发现并修复左侧下半部分空白：历史列表此前被固定 `max-height:270px`，改为桌面端按剩余 viewport 高度自适应，历史仍在列表内部滚动，不再留下大片死区。
- 定向 Panel integration **83/83**、panel-client、tsc、严格 lint 通过；真实截图复核左侧历史栏已填充到工作区底部，构建成功后页面仍可继续输入新需求。
- 最终回归：**62 个测试文件、525 个测试通过**；bundle 重建并重启后，snapshot 仍显示该构建 `run.status=succeeded`、`scenarios=12`、`artifacts=45`，代理配置和面板空闲状态正常。

## 项目式历史分组与构建文案复测（2026-10-17）

- 会话历史现在按项目上下文分组显示：当前项目优先，其他项目随后，旧数据无 `projectId` 的归入“未归类历史”；历史记录不再只是全局平铺。
- 构建模式删除无意义的“输入你想反复完成的工作，系统会自动整理成可复用场景”，改为“构建阶段定义并验证流程，实际工作在工作模式执行”。
- 真实 AX 复核显示“未归类历史 · 16”及完整历史列表；构建模式显示新说明；全量 **62 个测试文件、525 个测试通过**，panel-client、tsc、严格 lint、bundle 和 4320 重启均通过。

## 项目文件夹式资源隔离与左侧层级（2026-10-17）

- 场景记录新增可选 `workspaceId` / `projectId` 归属；旧记录迁移为全局兼容场景，新构建场景按构建运行绑定当前项目。场景匹配、选择、新建对话、测试、归档/恢复/删除、长程运行、任务触发、分享、导入和 HTTP 读取均检查当前工作区/项目范围。
- Memory 新增 `MemoryRepository.listVisible`，按 global/project/session/scenario 精确筛选；面板快照、Memory 文件树、搜索、编辑、删除、批量删除、启停和运行启用计数均只使用当前项目上下文。无元数据的旧文件保留为工作区级遗留项；有明确其它项目元数据的文件会被隐藏。
- 工作模式/构建模式/长程运行冻结上下文统一使用项目可见 Memory；项目切换、新建项目、历史恢复会清理不再可见的当前场景，避免旧项目场景成为下一次默认运行。
- 左侧改为“项目文件夹”语义，项目行显示对话、文件、Memory、场景数量，项目列表补充无障碍 list 语义；项目资源数量来自真实仓库而非前端占位。
- 新增/补充回归：Memory 项目可见性单元测试、项目切换 Memory 快照与清单计数、切换项目清理当前场景；场景 scope 治理覆盖 workspace/project/global 兼容。
- 当前精准验证：项目/场景/Memory/Panel **88/88** 通过；`npx tsc --noEmit --pretty false`、`npm run lint -- --max-warnings=0`、`npm run build`、`git diff --check` 均通过。全量回归在本轮最后一次改动前为 **62 文件、521 测试通过**；新增场景清理回归后需再跑一次全量。
- 最新 4320 已重启，HTTP snapshot 200：当前 `busy=false`、`run.status=succeeded`、1 个项目，项目行真实显示 `2 对话 · 0 文件 · 7 Memory · 0 场景`；AX 显示“项目文件夹”、项目工具折叠区和项目计数。
- 最终回归：新增场景切换清理后全量 **62 个测试文件、522 个测试通过**；`npm run build`、严格 lint、`npx tsc --noEmit --pretty false`、`git diff --check` 通过；pretest 已重建 panel/kernel/launcher bundle。
- 最终线上：4320 已重启，HTTP snapshot 200，`busy=false`、`run.status=succeeded`、`projects=1`、`memoryItems=1`、`scenarios=12`、`sessions=25`；项目行真实显示 `2 对话 · 0 文件 · 7 Memory · 0 场景`。WS `test-settings(settings={}, full=true)` 返回 `ok=true`。
- 两个真实浏览器标签页均刷新到最新 bundle；AX 均显示“项目文件夹”、项目文件夹 list、项目计数、项目工具折叠区和按项目分组的历史对话；当前运行上下文仍指向 `Agent 工作台一期`，运行终态保持已完成。当前 goal 的必需审计项已完成。

## 会话策略对照与项目选择补齐（2026-10-17）

- 对照参考智能体（Pi/Codex）的真实策略：项目等同工作目录，会话默认按项目隔离；跨项目历史需要显式切换/查看全部；历史选择器显示项目路径/范围，而不是把其它项目最近记录混到顶部。
- 发现缺口：原面板 `new-session` schema 会剥掉 `projectId`，新建对话弹窗没有项目选择，前端即使传项目也不会生效；左侧活动会话先取全局最近 6 条，跨项目记录可能脱离项目组；已归档会话也没有项目子组。
- 修复：新建对话现在先选择项目文件夹，再选择当前项目/全局可用场景；服务端验证 workspace/active project，持久化 session.projectId，并同步切换当前上下文。支持显式“不绑定项目”，并保留全局场景兼容。
- 修复：快照增加 `availableScenarios`，只暴露当前工作区可用场景；左侧活动和已归档会话全部按项目组显示，当前项目优先、其它项目随后、未归类最后；不再有跨项目“最近对话”顶层混排。历史快照窗口扩大到 200 条，覆盖多项目目录。
- 修复：分享和评论场景资源增加当前项目 scope 校验。
- 精准验证：Panel integration 新建项目选择、空项目绑定、DOM 选择器和历史路径测试通过；当前定向 **3/3**；此前项目/场景/Memory/Panel **88/88** 保持通过。
- 最终回归：全量 **62 个测试文件、523 个测试通过**；`npm run build`、严格 lint、`npx tsc --noEmit --pretty false`、`git diff --check` 通过；panel-client/bundle 已重建。
- 最终线上：4320 已重启，HTTP snapshot 200，`busy=false`、`run=succeeded`、`projects=1`、`scenarios=12`、`availableScenarios=12`、`sessions=25`；WS `test-settings(settings={}, full=true)` 返回 `ok=true`。两个浏览器标签页均刷新，AX 真实显示“当前项目 · Agent 工作台一期 · 2”和“未归类历史 · 20”，新建对话弹窗显示“项目文件夹”选择器及“不绑定项目”选项。

## 新建对话本地文件夹选择（2026-10-17）

- 复核 Codex 官方开源仓库相关 Desktop issue：新项目的核心语义是选择本地目录作为工作目录；“Files and folders”入口在 Windows 上也必须允许选择文件夹，而不是只允许文件。参考：[Codex 新项目目录选择 issue](https://github.com/openai/codex/issues/27221)、[Windows 文件夹选择器 issue](https://github.com/openai/codex/issues/36080)。
- 发现当前面板缺口：新建对话只能选择已有项目名称，没有本地文件夹选择；项目文件上传也会丢失目录层级。
- 修复：新建对话增加“选择本地文件夹”入口，使用浏览器目录选择器创建对应项目并按 `webkitRelativePath` 导入文件；项目文件保留相对目录结构，如 `docs/notes.md`。导入过程按创建项目→逐文件上传顺序执行，失败会停止并在弹窗显示原因。
- 服务端 `upload-file` 增加相对路径校验、目录创建和项目根越界保护；创建项目 action 返回真实 `projectId`；项目路径仍由服务端控制，不把浏览器本地绝对路径暴露给模型或持久化。
- 定向验证：新建对话项目选择、不绑定项目、文件夹选择器 DOM、相对路径上传均通过；目标用例 **2/2**；此前全量回归为 **62 文件、523 测试通过**。
- 最新线上：4320 已重启，HTTP snapshot 200，`busy=false`、`run=succeeded`、`availableScenarios=12`；WS provider full health `ok=true`；AX 真实显示“选择本地文件夹”和“内容会按相对路径导入为新的项目文件夹”。

## 真实文件夹直接绑定（2026-10-17）

- 用户明确拒绝复制导入，要求像 Codex 一样绑定原始目录。Codex 官方 issue 的预期也是创建项目时选择本地目录作为工作目录，而不是把文件复制进应用目录。
- 修复：Project 增加 `rootPath`；新增 `choose-project-folder`，Windows 上通过原生 `FolderBrowserDialog` 选择真实目录，项目直接保存该根路径。绑定时只扫描并登记索引，不复制文件。
- 读写链路改为使用绑定根目录：文件列表、添加/上传、删除、预览、产物路径校验、运行执行 `allowedRoot`、长程运行上下文均使用真实目录；上传的相对路径仍保留目录层级。
- 安全边界：根目录经过 `realpath/stat` 验证；文件写入、读取、删除和产物访问都做 lexical/canonical containment 校验；未选择目录时继续使用应用内部项目目录。
- 新建对话按钮已改为“选择并绑定真实文件夹”，弹窗文案明确“不复制到应用数据目录”。
- 定向验证：真实根目录读写、相对路径上传、新建对话/HTML 测试通过；全量 **62 个测试文件、524 个测试通过**；build、严格 lint、tsc、diff check 通过。
- 最新线上：4320 已重启，HTTP snapshot 200，`busy=false`、`run=succeeded`、WS provider full health `ok=true`；AX 显示“选择并绑定真实文件夹”。

## 运行中引导与核心执行闭环审计（2026-10-17）

- 运行中引导已接通：输入框在运行期间保持可用，普通场景发 `guide-run` 后把引导排到下一个可执行步骤，长程场景排到下一轮；当前模型调用不被强行中断；引导消息写入会话和聊天流。忙时 `/run stop|pause|resume` 仍走控制命令，不会误当普通引导；后台任务拒绝当前对话引导，避免串项目。
- 工作模式命中场景现在先尝试 `tryReuseScenario` 的真实能力漂移检查和调用；构建模式只规划/固化，不再误触发复用执行。能力不可复用时回退模型步骤并明确记录证据边界。
- 长程目标不再把“模型有文字输出”直接当作目标达成；模型需显式输出 `GOAL_MET: true`，否则进入下一轮直到目标标记或达到轮次上限。构建固化的 live path 也会保存定义，避免首次运行退回无关通用定义。
- 绑定真实目录扫描后自动索引文件；启用远程 MCP 连接器会在构建检索时读取 `tools/list` 生成项目能力候选，npx/CLI 连接器仍需要宿主执行器适配。
- 核心审计明确的剩余边界：构建阶段仍不执行外部工具；远程 MCP 才能进入当前独立执行链，CLI/git 仍是宿主委托；模型当前通过步骤文本工作，尚未提供完整的结构化 `awaiting-user` 澄清卡；连接器 tool schema 尚未直接传入模型工具调用协议。
- 最终回归：全量 **62 个测试文件、525 个测试通过**；build、严格 lint、tsc、diff check 通过；引导/执行定向 **25/25** 通过。4320 已重启，HTTP snapshot 200、`busy=false`、`run=idle`，WS provider full health `ok=true`；AX 真实界面加载正常。

## 核心能力第二轮修复（2026-10-17）

- 运行中引导输入增加 slash 控制分流：忙状态下 `/run stop|pause|resume` 仍走控制命令，普通文本才进入 `guide-run`。后台任务 run 记录 source 并拒绝当前对话引导，防止用户消息注入异步任务。
- 工作模式命中场景先走真实能力漂移检查和 `CapabilityInvoker` 复用；构建模式命中场景只重新规划/固化，不再把构建误当成执行。构建固化路径保存真实构建定义，新增 step capabilityId，避免首轮运行退回无关通用定义。
- 长程目标只在模型明确输出 `GOAL_MET: true` 时结束；否则继续到下一轮/轮次上限。运行中长程引导按 runId 隔离，避免终止后泄漏到下一次长程。
- 绑定目录扫描文件自动索引；远程 MCP 连接器启用后会读取 `tools/list` 生成项目能力候选，并可进入真实远程复用路径。
- 审计仍保留的明确边界：构建阶段不执行外部工具；CLI/git 能力仍依赖宿主执行器；连接器工具 schema 尚未直接接入模型原生 tool-call；构建阶段还没有完整的 awaiting-user 澄清卡。上述边界已写入 README，未作虚假完成声明。
- 最新全量回归：**62 个测试文件、525 个测试通过**；目标定向 **25/25** 通过；`npm run build`、严格 lint、tsc、diff check 通过；真实 4320/代理复测在最后 bundle 前需重启复核。
- 当前复核已完成：4320 重启后 HTTP snapshot 200，`busy=false`、`run=idle`、`projects=1`、`scenarios=12`、`sessions=26`；WS provider full health `ok=true`；AX 显示已连接、运行空闲和项目分组历史。目标继续保持 active，因为完整连接器原生 tool-call、CLI/git 宿主执行和构建 awaiting-user 澄清卡仍需后续实现。
- 远程 MCP 原生 tool-call 第一阶段已接入：ModelClient 支持非流式工具调用循环（最多 5 轮），启用的远程 MCP `tools/list` 生成 OpenAI-compatible function schema，`tools/call` 结果回传模型；普通场景和长程工作步骤均可使用。
- 最新验证：ModelClient tool-call 单测通过；全量 **62 个测试文件、526 个测试通过**；build、严格 lint、tsc、diff check 通过；4320 重新启动后 HTTP/WS/AX 复测正常。剩余边界为 CLI/git 宿主执行和构建阶段 awaiting-user 澄清卡。
- 后续代码复核中又发现并保留的事实边界：独立面板没有安全、通用的 CLI/git 命令参数契约，不能擅自猜测命令执行方式；构建阶段也没有可恢复的用户问题状态机。两项不能用模型文本伪装完成，目标继续 active，待定义宿主执行协议和 awaiting-user 持久化契约后再实现。

## 输入澄清与宿主执行第二轮（2026-10-17）

- 场景工作执行现在校验 `definition.inputs` 的必填项；缺失时返回真实 `awaiting-user`，不调用模型、不写成功结果。PanelServer 通过 `snapshot.awaitingUser`、`answer-run` 和聊天表单等待回答，回答后在同一 Run 内合并槽位、重新校验并继续。
- 长程轮次也会在当前轮等待缺失输入，暂存 LongRun `waiting-user`，回答后合并 `slots` 并重跑当前轮，不把缺参误判为失败或推进到下一轮。
- CLI/Git 增加显式 `HostExecutionSpec` 与 `createSafeHostCommandExecutor`：命令 basename allow-list、shell:false、项目/工作区/安装目录边界、声明式 argv 参数、超时/输出上限、权限门控；缺少合约或宿主策略仍为 delegated，不能伪报执行成功。
- 新增/更新定向测试：`work-execution` 10/10、Panel integration 89/89；合并定向 134/134；CLI/git execution-base 35 项已包含在全量回归。
- 最新全量回归（2026-10-17 10:45）：62 个测试文件、531 个测试通过；`npm run build`、`npm run lint`、`npx tsc --noEmit --pretty false`、`git diff --check` 通过；panel-client/kernel/launcher 已重建。
- 最新线上证据：4320 已重启，`GET /api/snapshot` 返回 200，`busy=false`、`run=idle`、`projects=1`、`scenarios=12`、`availableScenarios=12`、`sessions=26`；WS `test-settings(settings={},full=true)` 返回 `ok=true`；真实浏览器两个页面刷新后 AX 显示已连接、项目分组历史、聊天输入和检查台。
- LongRun 的 `waiting-user` 现在同时持久化问题与输入定义；刷新/进程恢复后快照仍能渲染表单，`answer-run` 会合并槽位、重新排队并调用长程执行器恢复当前轮。普通工作 Run 仍使用内存 Promise，进程重启时工作执行本身按恢复策略取消，不会猜测继续。
- 当前结构化澄清触发覆盖场景必填输入；构建阶段仍没有模型主动澄清的安全触发契约，构建默认只规划/验证，不执行外部工具。
- 最终复测（2026-10-17 10:52）：修复后的 bundle 已重启 4320；HTTP `/api/snapshot` 200，`busy=false`、`run=idle`、项目/场景/会话数量稳定；WS `test-settings` 返回 `ok=true`；真实浏览器刷新后 AX 仍显示已连接、项目历史、聊天输入和运行检查台。

## CLI/git 宿主执行协议第一阶段（2026-10-17）

- 为解决“不能猜测任意命令”的边界，新增 `HostExecutionSpec`：命令必须是 basename，argv 只能来自静态参数和显式 `inputArgs` flag 绑定，输入类型仅支持 string/number/boolean；cwd 仅允许 project/workspace/install scope，并有 timeout 与 maxOutputBytes 上限。
- 新增 `createSafeHostCommandExecutor` / `HostCommandPolicy`。宿主必须注入命令 allow-list 与根目录（可选安装目录解析器）；调用通过 `spawn(shell:false)`，unknown input、NUL、缺 required 输入、越界/缺根、权限拒绝和未 allow-list 命令均不会执行。缺少 `hostExecution` 或 executor 时 CLI/git 继续返回 delegated，绝不伪报成功。
- `CommandRunner` 新增全可选 `signal`、`maxOutputBytes`，并返回可选 `truncated`；现有 fake runner 兼容。`buildCapability` 会解析并补齐 hostExecution 默认值。
- README 已补充宿主契约和限制。验证：`tests/unit/execution-base.test.ts` 35/35；全量 `npm test -- --reporter=dot --testTimeout 30000` 为 **62 文件、530 测试通过**；`npx tsc --noEmit --pretty false`、目标 ESLint 通过。
- 历史边界记录（已在第二轮更新）：当时面板尚未注入真实宿主 policy，且构建 awaiting-user 尚未接入；当前状态以本文后续“第二轮核心能力闭环”段为准。

## 第二轮核心能力闭环（2026-10-17）

- 构建阶段现在支持模型显式返回结构化 clarification：`BuildContext.awaitingUser` 持久化问题与字段，`answer-run` 校验后从原 parsing/planning 阶段继续；普通运行、长程运行和构建运行都使用同一聊天表单入口，恢复期间不会提前固化、解锁或把问题降级成模板猜测。
- CLI/Git 宿主策略已接入启动器：`SCENARIO_HOST_ALLOWED_COMMANDS` 显式白名单，项目/工作区/安装根目录和超时/输出上限均经过校验；缺配置时策略关闭并在快照 `hostExecution.error` 中可见。
- 工作模式增加内置 `workspace_list_files`、`workspace_read_file`、`workspace_write_file` 工具；写入受 workspace `write` 策略、真实目录 containment 和大小限制约束，未暴露 shell。
- 模型工具调用遇到明确的工具协议拒绝时会退回普通文本模式，避免不支持 function calling 的 Provider 整个运行失败；真实工具执行错误不会被吞掉。
- 新增结构化构建澄清、恢复竞态、宿主策略和工具协议回归。当前定向回归 **140 项通过**；最新全量回归 **62 个测试文件、537 项通过**；build、lint、tsc、diff check 均需在最后 bundle/live 复测后再次确认。
- 最新待办只保留真实边界：需要在代理开启时做一次真实构建澄清恢复路径和一次真实内置文件工具调用 smoke；宿主 CLI/Git 只有设置白名单后才会执行，默认关闭是预期安全状态。

## 第二轮最终验证（2026-10-17 11:14）

- 全量回归：**62 个测试文件、537 项通过**；构建澄清/状态机/Panel/宿主策略/模型工具调用定向 **140 项通过**。
- `npm run build`、`npm run lint`、`npx tsc --noEmit --pretty false`、`git diff --check` 已通过；panel-client、kernel、launcher 已按最新源码重建。
- 4320 最新 live：HTTP snapshot 200，`busy=false`、`run=idle`、`projects=1`、`scenarios=12`、`availableScenarios=12`、`sessions=26`；`hostExecution.enabled=false` 且明确显示未配置 allow-list；WS `test-settings(full=true)` 返回 `ok=true`。
- 真实浏览器刷新后 AX 显示已连接、项目/对话历史、聊天输入和运行检查台；构建澄清表单、运行中补充输入和内置工具链均已由定向测试覆盖。

## CDS 风格 UI 第二轮（2026-10-19）

- 已阅读并对照 `Caho1/open-claude-ui` README 与会话核心流手册：[仓库](https://github.com/Caho1/open-claude-ui)、[会话流与指令引擎](https://github.com/Caho1/open-claude-ui/blob/main/docs/v1/03-%E4%BC%9A%E8%AF%9D%E6%A0%B8%E5%BF%83%E6%B5%81%E4%B8%8E%E6%8C%87%E4%BB%A4%E4%BA%A4%E4%BA%92%E5%BC%95%E6%93%8E.md)。提取规则：Surface 0–3、Clay `#d97757`、hairline border、Assistant 透明正文、User 浅色气泡、20px Composer、状态时间线、滚动渐隐、IME composition guard。
- 当前 `panel.css` 已加入 CDS-inspired skin：暖色浅色表面、陶土橙交互色、Assistant 零边框、User 气泡、轻阴影/细边、Composer 20px、移动端满高布局、抽屉和菜单保持原交互协议。
- `chat-client.ts` 新增/强化：CJK compositionstart/compositionend/500ms Enter guard、beforeinput 防止误换行、User 消息编辑、失败运行一键重试；现有流式滚动 pin 和移动抽屉逻辑继续保留。
- 最新移动端真实截图已确认：暖色面板、项目/模式入口、Composer、抽屉和更多菜单可见；AX 复测显示已连接、对话输入和项目历史均可访问。
- UI-only 修改后需重新运行 panel-client 与浏览器 smoke；核心全量回归基线保持 62 文件、537 项通过。

## UI 重做复测结果（2026-10-19）

- 当前页面已切换到暖色 CDS 风格：移动端真实截图确认 Surface 0–3、Clay 按钮、浅蓝 User 气泡、透明 Assistant 空间、圆形 Composer、浅色 More 菜单和项目抽屉均可见。
- 移动端真实交互已验证：打开/关闭工作区抽屉、打开 More 菜单、打开设置弹窗；AX 可见项目历史、Composer、运行检查台、设置字段和菜单项。
- UI 改造后 `panel-client`、build、lint、tsc、git diff check 通过；Panel/Model/Work 定向回归 **107 项通过**；此前核心全量回归 **62 文件、537 项通过**。
- 当前设计参考仓库为 `Caho1/open-claude-ui`，实现只复用公开设计规则与交互原则，不复制专有二进制资源。
- 最后一轮视觉修正：移动端模式切换改为“工作/构建”短标签，避免窄屏单字截断；More 菜单、上下文 chips、运行提示和抽屉统一为浅色 Surface/Clay 体系；移动端 workspace grid 设为满高，消除底部灰色死区。
- UI 变更后的最终证据：`panel-client`、lint、tsc、diff check 通过；真实移动视口截图显示暖色工作台、完整 Composer、构建/工作模式短标签和充满视口的聊天区；More 菜单与项目抽屉分别打开后视觉和 AX 均正常。
- 追加修复：移动端模式切换不再用 CSS 伪元素重复可访问名称，改为 JS 响应式短标签（视觉“工作/构建”，aria-label 保留“工作模式/场景构建”）；AX 复测无重复文本，截图排版正常。
- 追加交互修复：设置、上下文、分享、运行中心、任务和连接器弹窗打开后会把焦点落到首个有效控件；真实 AX 复测设置弹窗焦点落在 API 地址字段，关闭后回到设置按钮。

## 构建模型澄清闭环复核（2026-10-17 11:15）

- `BuildClarificationSchema` 约束模型澄清必须含问题与字段定义；`BuildContext.awaitingUser`、`clarificationAnswers` 会随构建检查点落盘。模型在 parsing/planning 返回 clarification 时由 `BuildAwaitingUserError` 进入非终态 `waiting-user`，不会套用模板、猜测输入、写成功产物或解锁会话。
- PanelServer 为构建复用 `answer-run` 表单入口；回答先清除旧请求并校验必填字段，恢复回调启动同一 Orchestrator。若恢复期间模型提出第二个问题，新的 `user:pending` 不会被旧 `running` 更新覆盖；恢复失败会还原旧问题。
- 重启恢复选择器接受 `waiting-user` 构建，快照从 RunProduct/BuildContext 还原问题卡；初次和重启 `.run()` 遇到 awaiting 都提前返回，finishBuild 不会固化或发终态。
- 精准证据：`tests/unit/state-machine.test.ts`、`tests/unit/handlers.test.ts`、`tests/integration/panel-integration.test.ts` 定向 140/140；全量 **62 个测试文件、537 项通过**；`npx tsc --noEmit --pretty false`、`npm run build`、`npm run lint`、`git diff --check` 通过。最新 bundle 已由 launcher 加载：`GET /api/snapshot` 返回 200（busy=false、run=idle、phase=idle、scenarios=12、availableScenarios=12），WS `test-settings(settings={},full=true)` 返回 `ok=true`。真实代理尚未被强制触发澄清输出，浏览器 AX smoke 仍由主 agent 复核。


## 构建澄清快速回答竞态修复（2026-10-19 12:16）

- 发现：模型构建澄清事件对 RunProduct 的 `waiting-user` 写入是异步 fire-and-forget；用户快速回答时，回答先清掉请求并继续运行，旧 waiting 写入可能迟到覆盖 running，导致刷新仍显示旧表单且 finishBuild 不落终态。
- 修复：`PanelServer` 新增 `buildStatusPersistence` 串行队列；`notifyBuildAwaitingUser` 的状态/详情写入进入队列，`answerRun` 在清理请求前等待队列；构建终态持久化允许 `waiting-user` 作为活跃中间状态；live pending + 重启恢复两条回答路径分开处理。
- 回归：新增编排器仍持有 `ctx.awaitingUser` 的统一恢复测试，以及延迟 waiting 写入竞态测试；Panel integration **92/92**；最终全量 **62 个测试文件、539 项通过**；`npm run build`、严格 lint、`npx tsc --noEmit --pretty false`、`git diff --check` 通过。
- 需主 agent 在 4320 重启最新 bundle 后复核真实构建澄清回答与刷新状态；当前代理 WS 既有健康证据仍有效。

## 构建澄清重启恢复状态同步（2026-10-19 12:20）

- 发现：重启恢复的构建没有内存 `pendingBuildInput`，`answer-run` 虽能调用恢复回调并清除编排器上下文，但面板 Run 和 RunProduct 仍可能停在 `waiting-user`，出现“无问题卡但仍等待”的状态。
- 修复：恢复回答成功后同步面板 `run=running`、RunProduct `status=running/error=null`、`awaitingUser=null` 和累计 clarificationAnswers；恢复失败保留原问题状态。
- 新增回归：重启恢复构建回答后的 UI/持久化状态同步；Panel integration **93/93**，全量最终 **62 个测试文件、540 项通过**；build、严格 lint、tsc、diff check 通过。
- 当前需主 agent 重启 4320 最新 bundle 后复测真实代理与浏览器；未凭单测宣称真实模型澄清路径已完成。

## 真实 MCP 与项目文件工具链复核（2026-10-19 13:47）

- 发现并修复：远程 MCP 工具发现/调用此前只检查连接器自身 `network` scope，未检查工作区 `policy.network`，且调用期间不复核连接器状态；现在发现阶段先过工作区网络策略，`tools/call` 前再次校验工作区、连接器归属、启用状态和 network scope，并刷新凭据。
- 发现并修复：项目文件工具写入不存在的嵌套目录会因 `realpath(dirname)` 失败而报路径不存在；新增 `src/panel/runtime-path.ts`，允许安全创建新目录，同时对 lexical/canonical/symlink containment 做校验，写入 mkdir 后再次 canonicalize。
- 真实 MCP 协议链增强：`mcpHttpRequest` 执行标准 `initialize → notifications/initialized → tools/list/tools/call`，传递 `Mcp-Session-Id`；仅在明确 `-32601` 或协议不支持的 HTTP 状态下回退 legacy direct。`CapabilityInvoker.invokeRemote/probe` 与面板连接器工具均接入。
- 新增回归：`tests/unit/runtime-path.test.ts` 2/2、`tests/unit/mcp-http.test.ts` 2/2；legacy remote fake server 更新为显式拒绝 initialize 后验证回退。执行链 43/43、Panel integration 93/93 通过；全量 `npm test -- --reporter=dot --testTimeout 30000` **64 个文件、545 项通过**，pretest bundle 成功。
- 后续兼容性修正：标准 MCP 请求在握手后带协商的 `Mcp-Protocol-Version`，连接器工具名规范化碰撞会加稳定后缀；`mcp-http` 与执行链定向 **39/39**、`tsc` 通过。

## Claude 风格 UI 全量重做（2026-10-20）

- 用户明确要求移除旧暖色 CDS 视觉范式，改为 Claude 风格会话壳，并保留亮色/暗色主题。
- `src/panel/server.ts` 顶栏新增 `toggle-theme` 入口；`src/panel/chat-client.ts` 使用 `localStorage` 保存主题、在亮/暗两套 CSS token 间切换，并同步按钮无障碍名称。
- `src/panel/panel.css` 追加最终 Claude-style visual layer：Surface/Sidebar/Composer 变量、透明 Assistant 正文、克制 User 气泡、低对比 thinking/tool disclosure、细边框、窄侧栏、静默检查台和移动抽屉；暗色通过 `:root[data-theme="dark"]` 全量覆盖，移动端额外保持主题按钮可见。
- 视觉层的旧 CSS 仍保留作为兼容基线，但最终层在文件末尾覆盖旧变量和组件规则；未改变消息、运行、MCP、文件工具协议。
- 验证：`npm run panel-client`、`npm run bundle`、`npm run lint -- --max-warnings=0`、`npx tsc --noEmit --pretty false`、`git diff --check` 通过；最终全量 **64 个测试文件、545 项通过**。最新 launcher 已前台启动，`GET /api/snapshot` 返回 200，`busy=false`、`run=succeeded`、代理地址/模型/鉴权仍有效，页面 HTML 含 `toggle-theme`，bundle 含 Claude token。
- 浏览器标签在重启期间进入了连接错误页，CUA 无法重新导航该失效标签；这次没有把错误页误报成最终视觉截图。此前真实浏览器仍已验证聊天流、工具调用/结果卡和移动布局；当前新主题已完成静态 bundle/HTTP 验证，待用户标签重新打开后即可复核亮暗切换视觉。

## Agent 信息架构重构（2026-10-20）

- 真实 AX 审计确认旧界面的核心问题不是颜色，而是语义层级混乱：一次回答被拆成“历史运行 / AI 运行过程 / AI 运行进度”，侧栏把当前项目、19 条未归类历史和所有操作按钮全部摊开，右侧直接展示 49 个产物。
- `renderRunGroup` 现改为“用户消息 → Agent 正文/结果 → 一个执行过程折叠区”：工具、步骤、过程状态统一进“执行过程”，终态结果直接可见；失败结果使用“结果”标签，Agent 头像不再显示“AI”大字。
- 侧栏只默认展开当前项目会话，其它/未归类历史改为折叠；项目文件和产物在任务详情中改为折叠区，避免检查台变成资源列表。
- 顶栏只保留搜索、设置、主题和状态；上下文、分享、运行记录、任务、连接器、任务详情归入“更多”。检查台改名为“任务详情”，工作/构建模式文案改成直接解释用户下一步。
- 会话历史短且无语义的标题（如“你敢”“你好”）统一归一为“新任务”；缓存版本号更新为 `20261020-ux3`，避免浏览器继续显示旧 JS/CSS。
- 真实浏览器 AX 复测：新版本已显示“当前项目 · 工作模式”“你现在想完成什么？”、“执行过程”折叠、“任务详情”、未归类历史折叠、主题按钮；当前项目会话与失败结果可直接理解。定向回归 **112/112**；`panel-client`、bundle、tsc、lint、diff check 通过；最新 4320 HTTP 200、代理和鉴权保持有效。

## 干净入口复测（2026-10-20）

- 为避免用户第一眼看到历史测试失败结果，只切换当前视图到一个新的空白对话，保留原有历史记录，不删除数据。
- 最新真实 AX：状态为“空闲”，主区显示“把工作交给场景 / 系统会优先复用已固化场景”，输入框可用；侧栏当前项目会话与未归类历史折叠；右侧显示“任务详情”，项目文件/产物折叠；顶栏只保留搜索、设置、主题切换和状态。
- 最新定向回归：Panel/History/Model/Work **112/112**；bundle 已重建，4320 当前 HTTP 200、代理鉴权正常。

## 最终真实界面复测（2026-10-20）

- 浏览器缓存版本已更新后，真实 AX/截图确认新信息架构生效：顶栏仅保留搜索、设置、主题和连接状态；侧栏只展开当前项目，会话之外的未归类历史折叠；主区空状态明确写成“把工作交给场景”；右侧明确为“任务详情”，项目文件和产物折叠。
- 暗色与亮色主题均由真实浏览器点击验证，主题按钮无障碍名称在“切换到暗色主题 / 切换到亮色主题”之间正确切换；最终已恢复亮色作为用户入口默认状态。
- 当前干净会话 AX：状态“空闲”、输入框可用、当前项目/工作模式清楚、没有把历史失败运行混在首屏主对话里。
- 全量测试基线保持 **64 文件、545 项通过**；最近 UX 定向回归 **112/112**；最新 launcher 已加载缓存版本 `20261020-ux3`。

## 顶栏次级工具入口修复（2026-10-20）

- 真实 AX 复测发现旧 CSS 将“更多”按钮本体和菜单本体分别压成 `display:none`；补上最终显示态规则并升级缓存到 `20261020-ux4`。
- 现在桌面顶栏只显示搜索、设置、主题、更多和连接状态；点击更多真实显示上下文、分享、运行记录、任务、连接器、任务详情六项入口，验证后已关闭菜单恢复干净入口。
- 最新全量回归仍为 **64 个测试文件、545 项通过**；最新 launcher 已重启，4320 HTTP 200，AX 真实入口状态为空闲。

## 最终回归收口（2026-10-20）

- 全量回归最终通过：**64 个测试文件、545 项测试通过**。
- 期间唯一失败是 `skills.sh` 外部下载 smoke 在网络慢时超过 45 秒；单独复现为 84 秒完成并通过，已将该外部网络 smoke 超时窗口提高到 120 秒，避免网络抖动误报。
- 最终真实 AX：当前项目/工作模式、空闲状态、清晰输入提示、执行过程折叠、任务详情、项目文件/产物折叠、未归类历史折叠、主题切换和更多菜单均可访问。
