# 笔记 4/5：pi-tui 组件清单（闸门 UI 复用点）

来源：`ref/pi/packages/tui/src/components/`（npm 包 @earendil-works/pi-tui@0.87.1）

## 组件全表
| 组件 | 文件 | 闸门复用 |
|---|---|---|
| **select-list** | select-list.ts | 闸门3 候选单选、闸门5 三选一、通用菜单 |
| **settings-list** | settings-list.ts | 闸门4 验收清单逐项开关/编辑 |
| **editor** | editor.ts | 闸门1 意图逐项编辑、文本输入 |
| **input** | input.ts | 单行输入（槽位名/重命名） |
| **box** | box.ts | 候选卡片边框（来源徽章/trust 标注容器） |
| **text** | text.ts | 静态文本渲染 |
| **markdown** | markdown.ts | 提案/报告 Markdown 渲染 |
| **loader** / **cancellable-loader** | loader.ts | 检索/执行中状态指示 |
| **scroll-view** | scroll-view.ts | 长列表（场景库/DAG 列表）滚动 |
| **stack/v-stack/h-stack** | stack*.ts | 布局组合 |
| **image** | image.ts | —（面板用） |
| **mouse-region** | mouse-region.ts | 可点击区域（可选） |
| **truncated-text** | truncated-text.ts | 长描述截断（候选卡片描述） |
| **alt-screen-flash** | alt-screen-flash.ts | — |

## overlay 模式（闸门挂起交互）
- pi 扩展侧经 `ctx.ui.showOverlay(...)` 弹出模态（extensions/types.ts 注释），overlay 内部组合上述组件；
- 本项目闸门 TUI = overlay(select-list + editor + box) 组合，每闸门一个组件文件（阶段三 3.2.x）。
- 官方示例参照：`examples/extensions/questionnaire.ts`（多步问卷）、`question.ts`（问答）、`plan-mode/`（计划模式确认）、`permission-gate.ts`（权限审批）——均为"展示→等待决策→应用决策"形态，与闸门协议同构。

## 快照测试路径（3.2.b）
- pi-tui 组件为受控渲染（文本行数组），可对 `component.render(width): string[]` 输出做快照断言。
