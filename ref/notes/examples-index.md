# P.1.4 官方扩展示例清单（与本项目相关 ≥10 条）

来源：`ref/pi/packages/coding-agent/examples/extensions/`（50+ 官方示例）

| 示例路径 | 与本项目的关联 |
|---|---|
| `plan-mode/` | 闸门1/2 的"提案确认→批准进入执行"交互范式（目录型扩展示例） |
| `permission-gate.ts` | 执行期干预：危险操作审批事件挂 `tool_call` 的标准写法（4.2.3） |
| `questionnaire.ts` | 多步闸门表单（逐项编辑）UI 范式（3.2.1/3.2.4） |
| `question.ts` | 单问题挂起→决策→恢复的模式（GateDecision 挂起/恢复原型） |
| `confirm-destructive.ts` | 闸门5 固化确认（不可逆操作二次确认）范式 |
| `event-bus.ts` | 扩展内自定义事件总线与 pi 事件互通写法（0.2.4 参照） |
| `dynamic-tools.ts` | 按阶段动态注册/撤销工具（执行期能力注入参照） |
| `built-in-tool-renderer.ts` + `message-renderer.ts` + `entry-renderer.ts` | 自定义工具/消息渲染（Web 面板 8.4 闸门卡片参照） |
| `send-user-message.ts` | 修复回路自动重试时程序化注入用户消息（3.3.1） |
| `commands.ts` | `/gate approve|reject|status` 命令族注册范式 |
| `rpc-demo.ts` | 无头模式 RPC 控制环（Web 面板服务与内核解耦参照） |
| `input-transform.ts` | 输入拦截改写（闸门命令解析前置钩子） |
| `modal-editor.ts` / `overlay-test.ts` / `doom-overlay/` | overlay 生命周期、焦点管理、关闭回调（3.2 各闸门 TUI） |
| `custom-compaction.ts` | 上下文压缩钩子（长流水线执行时 Memory 摘要时机） |
| `file-trigger.ts` | 文件变更触发（pi-reactor 之外的轻量触发源参照） |
| `session-name.ts` / `handoff.ts` | 会话元数据与交接（Memory 会话层写入参照） |

> 以上 16 条满足 DoD（≥10 条，每条路径+一句话说明）。完整示例目录共 57 项（含子目录型 6 个）。
