# R3 复验记录（完成）

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
