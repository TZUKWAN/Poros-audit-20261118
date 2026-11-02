# R1 全面审计报告 (2026-11-01 ～ 2026-11-02)

## 背景异常处置
三仓在审计开始前被并行会话破坏（26 个基础设施文件被删：tsconfig/vitest.config/内核源码/测试基建），同时混有该会话的**进行中升级**（+10779 行：product contracts/repository、panel 模块化、constructionOnly 模式、依赖升级）。
处置：备份 M 状态 → `git checkout HEAD` 恢复全部被删文件 → 保留升级增量 → 合并提交 `580a5d11` → 回归确认 pi 545 / ares 239 / metis 232 全绿。CLAUDE_STATE.md 为并行会话工作日志（未删除）。

## 发现与修复（Explore 独立审计 15 条 + 自审 1 条误报排除）

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | P1 | panel async 链尾 rejection 未兜底（start-build/create-long-run catch 回调自身 await 可能抛；重放分支单参 then） | 三处补兜底 catch/双参 then；提交 b0cd7753 |
| 2 | P2 | host-context token 由无鉴权 GET 下发 + 全 API 零 Host 校验（DNS rebinding 可全权操作面板） | Host 必须回环形态（三仓）；live-verified evil=403 good=200；pi 旧 bundle 一并重打 |
| 3 | P2 | sync-apply scenario 分支无 workspaceId 校验（越权注入任意作用域） | 强制 workspaceId + projectId=null（sync-apply 无项目导入流程）|
| 4 | P2 | readTextBody/readBody 逐 chunk String() 解码，跨包 UTF-8 截断 | Buffer.concat 整体解码（server + sync-server）|
| 5 | P2 | persistent-loop goal-met/pause 竞态把已达成目标改为 paused → resume 后 failed(max-rounds) | finish() 暂停仅吸收 cancelled/非 max-rounds 失败 |
| 6 | P2 | eventLog 缓存整份快照 ×500（内存放大+重放风暴） | 快照事件不入 eventLog；重放走 /api/snapshot |
| 7 | P3 | user:pending 双处理器 → 澄清卡片重复 | notifyBuildAwaitingUser 唯一入口 |
| 8 | P3 | repository 读改写竞态（projectIds/fileIds） | 已有 serialized 队列保护，补并发测试覆盖（回归通过，未改代码）|
| 9 | P3 | settings.load 空解密覆盖 env 注入凭据 | 空解密回退 env + 告警 |
| 10 | P3 | artifact 裸 path 可读项目根任意文件（含 .env） | 必须命中已登记 artifact 记录（测试 403→404 更严语义）|
| 11 | P3 | scheduler 计数器起点快照覆盖并发更新；超时清 lastRunId | 回写前重读合并；超时保留实际 runId |
| 12 | P3 | work-execution 死分支假保护 | 删除 + 注释说明边界在 251 行 |
| 13 | P3 | create-memory 同名覆盖 + 双记录指向同路径 | 文件名加内容哈希短缀 |
| 14 | P3 | recoverAfterRestart 乐观锁无重试阻塞面板启动 | 3 次重读重试 |
| 15 | P3 | 分享 token 明文落盘 | 存 sha256 哈希，原值一次性返回 |

## 自查误报
- store 串行链"崩溃级"判断：复现测试证明链尾自愈（gate 由 finally release），
  失败操作 reject 给调用方、链不污染。测试保留为防回归（core-store-chain.test.ts）。

## live 实证清单
- 穿越攻击 403（sibling 目录 + 非 .md）
- 重复/非法 WS 决策攻击：面板存活 + 3 条可读错误
- Host 校验：evil 403 / loopback 200（三仓）
- 分域后完整构建：5 闸门 → 固化 → Memory 写入
- stdio 快速失败：单测覆盖（exit before response 不再挂满超时窗口）

## 覆盖状态
- pi: 65 文件 541 测试 + 6 网络跳过（SCENARIO_RUN_NETWORK=1 显式开启）
- ares: 239/239；metis: 232/232
