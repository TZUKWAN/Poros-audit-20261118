# R3/R4/R5 复验记录（终审完成）

## R5 终验（2026-11-02，单 Explore close-read：R4 修复质量 + 最后角落）

发现 5 项（1 P2 + 4 P3），全部修复；关键疑点 verified-ok：

| # | 级别 | 仓库 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P2 | ares/metis | R4 重连窗口内三处 ws.send 无 readyState 守卫——断线期间 Enter/decide/abort 抛 InvalidStateError，乐观消息静默消失 | 三处守卫（decide 守卫置于乐观标记之前）；onSend 守卫通过后才本地推送 |
| 2 | P3 | ares/metis | lastLocalDecisionGate 单槽——双击 CONFLICT 误还原已成功的首击卡片 | 服务端 CONFLICT 回显 decisionGate，客户端精确还原（快照 backfill 毫秒级自愈兜底） |
| 3 | P3 | pi | shares getByToken/list 对全表 parse——一行坏数据致所有分享链接 500 | 逐行 safeParse 跳过坏行 |
| 4 | P3 | pi | recoverAfterRestart 3 次失败静默——坏记录永远卡 running 每次启动重试 | 失败留痕 console.error |
| 5 | P3 | pi | decide() 重复 gate 校验死代码（294 行已有） | 删除 R4 重复段 |

**R5 verified-ok（关键疑点）**：
- pi abort 清理 vs 恢复路径：abort 后 outcome="failed" 被 restore 过滤正确排除；crash 路径 pendingGate 保留且 run():187 正确重呈现 gate——双向安全。
- ares/metis backfill 序号配对：驳回重跑（新卡片 ordinal 1 无配对 → 保持未决 ✓）；双构建各批准（mark 先于快照，配对不承担已决卡片 ✓）。
- pi finishBuild 无双执行（run:done handler 与 .then 内联 finish 互斥路径验证）。
- scheduler inFlight 无泄漏；decide 校验不会误伤虚拟用户；per-build RunController 闭包/GC 正确；commit message 与 diff 三仓一致。

## R4（2026-11-02，双 Explore 审计：pi 12 项 + ares/metis 10 项，全部修复）

| # | 级别 | 仓库 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P1 | ares/metis | snapshot() backfill 用 find() 把「驳回→重跑」后的新 pending 卡片误标已决 → 按钮消失构建挂死 | 按「第 N 张 gate-G 卡片 ↔ 第 N 个 gate-G 审批」序号配对 |
| 2 | P1 | ares/metis | terminate 从未接线 orch.abort()——Abort 按钮无效，gate 等待永久挂起锁死面板 | attachOrchestrator 后 controller.onTerminateCallback(() => orch.abort()) |
| 3 | P1 | pi | pushSnapshot() 无 catch，~35 处调用点任一 fs 抖动 = unhandledRejection 崩面板 | pushSnapshot 本体 try/catch 一处兜底全部 |
| 4 | P1 | pi | finishBuild 链（launch.ts:855/1313）reject 未处理——构建成功后固化 IO 失败崩进程 | 链中插 .catch → failBuild（内层再 .catch 防爆） |
| 5 | P2 | ares/metis | start-build 被拒/启动失败时 isStreaming 不重置，Enter 永久失效 | catch 路径广播 run-error + 客户端 action-result ok:false 本地重置 |
| 6 | P2 | ares/metis | WS 断线无重连——服务器一重启面板永久失能 | close → 指数退避重连（1s 起 30s 封顶） |
| 7 | P2 | 三仓 | decide() 不校验 pendingGate——错误 gate 决策静默 resolve 挂起等待 | 校验失败抛 CONFLICT 且不清 decideResolve（等待继续存活） |
| 8 | P2 | pi | scheduler stop() 是空操作——inFlight 存 task id 字符串，allSettled(["t1"]) 立即 settle | inFlight 改 Map<string, Promise> 存 operation；shutdown 加 10s 总超时 |
| 9 | P3 | 三仓 | abort 泄漏 decideResolve/pendingGate；迟到 decide 静默 resolve 死等待 | onAbort 清理两者；resolve wrapper 自清 |
| 10 | P3 | pi | fetch 重试不消费响应体——undici socket 占用耗尽连接池 | 重试前 resp.body?.cancel() |
| 11 | P3 | ares/metis | invokeRemote/stdio 响应体无上限 | readBodyCapped 流式 5MB 预算；stdio 行缓冲 5MB 熔断 |
| 12 | P3 | ares/metis | 乐观 decided 标记不还原（双击 CONFLICT 后卡片假已决） | action-result 带动作类型；gate-decision 拒绝时还原该 gate 卡片 |
| 13 | P3 | ares/metis | 无 orchestrator 时 decide 假确认 | handleAction 前置守卫返回错误 |

### R4 实测抓出并修复的回归

**RunController 单例中毒**：terminate 接线后暴露——controller 是全局单例且 terminate 单次语义，terminate 一次后所有后续构建在首个 checkpoint 抛 CANCELLED。修复：每次 start-build 新建 RunController + panel.setController 同步 control 路由（抄 pi 语义）。ares/metis 同改。

### R4 三场景实测（WS 机器人，ares 4520 / metis 4521 各一轮）

- 场景A（P1-1）：gate1 驳回→重跑→新 gate1 卡片 **decided 为 undefined**（可操作）→ 走完五闸门 run-done ✓
- 场景B（P1-2）：gate1 pending 时 terminate → 收到 run-error（abort reject 挂起等待 → 锁释放）✓
- 场景C：terminate 后立即再 start-build → 受理并完整走完 → run-done ✓
- R3 双构建回归：ares/metis 双双全绿（无 R4 修复破坏 R3 行为）

## R1-F 三面板完整构建实测（2026-11-02）
- PI 4517: done ✓ 固化「整理 /data/audit-final 的数据并生成审计简报」v1，检索进度 8/8 分源反馈正常
- ARES 4520: done ✓ 固化 sc-panel-1793598368678 v1（数模竞赛线）
- METIS 4521: done ✓ 固化（短视频信息茧房定量研究）
- 机器人 timeout 判定为脚本 bug（找旧 terminal 字段），非产品缺陷；产品侧 terminal 状态正常

## R3 Explore 审计（12 项发现，全部修复）

| # | 级别 | 仓库 | 问题 | 修复 |
|---|------|------|------|------|
| 1 | P1 | ares/metis | start-build TOCTOU：守卫检查在首个 await(search) 前通过，current 赋值在其后，两个并发消息各自启动编排器 | 守卫通过后、首个 await 前同步置 currentDone=false 哨兵；启动期异常 catch 恢复哨兵（commit c01f621/ccecc8d） |
| 2 | P1 | ares/metis | 服务端从不广播 run-done/run-error → 客户端 editor.isStreaming 首次构建后永久 true，Enter 发送失效 | then/catch 里 panel.broadcast({kind:"run-done"/"run-error"})（同上 commit） |
| 3 | P2 | pi | launchBusy=true 后到 orch.run() finally 前有多个裸 await，任一 reject 锁永真 | start-build 分支整体包 try/catch：异常清锁+推终端错误+返回失败（69446d2f） |
| 4 | P2 | ares/metis | decidedGates 全局 Set 跨构建残留 → 第二次构建的闸门误显示"已批准"且按钮消失；另有死代码 gateCard/void gateCard | 决策状态随消息体携带（decide() 直接标记本地最后一张卡片；渲染只信 m.decided）；全局 Set 与死代码全删（fe6a2d6/3863879） |
| 5 | P2 | 三仓 | WS initial snapshot 的 void .then 无 .catch → unhandledRejection 崩进程；ares/metis HTTP /api/snapshot 无失败兜底 → 请求悬挂 | 全部加 .catch；HTTP 路径 catch 里回 500（三仓各 1 commit） |
| 6 | P2 | ares/metis | processCommandRunner 无输出截断/无 AbortSignal（pi 已有） | 逐行对齐 pi 实现（maxOutputBytes 默认 1MB + signal 联动 kill） |
| 7 | P2 | ares/metis | 无 SIGINT/SIGTERM 处理，Ctrl+C 硬杀产生孤儿 | 挂信号 → panel.stop() → process.exit(0) |
| 8 | P3 | pi | scheduler.stop 不等 in-flight 任务 | stop() 改 async，等 inFlight 清空（上限 30s）；launch.ts shutdown 链并入 |
| 9 | P3 | 三仓 | reactor-bridge webhook body 无上限 + onStart reject 链尾裸奔 | body 1MB 上限（超限 413+destroy）；onStart catch 打日志（ares/metis 文件与 pi 逐字节同步） |
| 11 | P3 | 三仓 | clusterEvents/loopEvents 无上限，长跑内存膨胀 | push 后超 500 条 splice 裁剪 |

## R3 实测复验（WS 机器人双构建连续流程，2026-11-02）

ares 4520 / metis 4521 各跑两轮完整构建（start-build → 逐 gate 批准 → run-done → 立即第二次 start-build）：

```
{"label":"ares",  "pass2":true,"pass4":true,"build1RunDone":true,"build2Gate1WasUndecided":true,"build2RunDone":true}
{"label":"metis", "pass2":true,"pass4":true,"build1RunDone":true,"build2Gate1WasUndecided":true,"build2RunDone":true}
```

- pass2 = 收到 run-done 广播（#2 修复生效，isStreaming 可重置）
- pass4 = 第二次构建的 gate1 卡片 decided 为 undefined（#4 修复生效，不再误显示已批准）
- 两构建均完整走完五闸门并固化场景

### 实测抓出的新回归（已修）

**锁释放时序**：run-done 广播后客户端立即发下一次 start-build，而旧代码在 .finally（等 distill/save/refresh 收尾后）才 currentDone=true → 第二次构建被"已有构建进行中"拒绝（TOCTOU 的时序镜像）。修复：then/catch 入口立即 currentDone=true，广播在其后；.finally 保留作回调自身抛错的兜底（ares/metis 各 1 follow-up commit）。

### 实测工具教训（记入流程）

- Node ws 库 message 回调签名是 `(data: RawData, isBinary)`，**不是浏览器 Event 对象**——`String(ev.data)` 恒为 "undefined"，JSON.parse 静默吞掉每条消息。机器人因此白等 240s。诊断脚本与机器人的差异正在于此。
- Git Bash 的 `kill <PID>` 对 Windows 进程无效，必须 `powershell taskkill /F /PID`；`timeout` 命令是 Windows 版（等待按键），不能用来包装 node。
- 浏览器端代码（chat-client）改后必须 `npm run panel-client` 重建 dist/panel-chat.js——`npm run bundle` 只重建 launcher。

## 三仓测试基线（R3 修复后）
- pi-scenario: 541 passed | 6 skipped（网络类，SCENARIO_RUN_NETWORK=1 时启用）
- ares-scenario: 239 passed
- metis-scenario: 232 passed
- tsc --noEmit 三仓全零
