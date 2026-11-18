# Poros 企业架构

React → Fastify 权限边界 → PostgreSQL 持久任务 → Worker → 每任务独立 DSH 容器。事件在执行中落库，SSE 按 runId:seq 推送并补发。

| 模块 | 职责 |
|---|---|
| auth.ts | 可撤销会话、当前成员/角色/项目、原子一次性票据 |
| releases.ts / Prisma | 不可变 manifest、行锁分配版本、精确能力与来源；触发器保护发布内容和规则正文 |
| routes/index.ts | principal 派生组织；独立发布/任务/规则审批；异步任务和授权检查 |
| worker.ts | 数据库共享并发限额、租约、取消；崩溃显式失败，不自动重放副作用 |
| runner.ts | 冻结版本、固定规则应用、实时事件、质量状态、调用/Token 留痕 |
| dsh-runtime.ts / scripts/poros-*.mjs | 固定 argv + stdin JSON，无任务 Shell 拼接；前置授权；硬配额和容器自身截止时间；精确归属清理 |
| model-proxy.ts | 每运行短期令牌、固定模型/上游、请求/输出限额；供应商密钥不进入 Agent |
| judgment.ts / semantic-judge.ts | 作用域、机械冲突、独立评估；失败/缺裁决/证据不足均 UNCHECKED；真实 DSH/Judge 共用准入通道 |
| storage.ts | 认证 S3；生产启动核查匿名拒绝 |

API 宿主是可信 Docker broker，Agent 没有 Docker 权限。任务不共享 HOME、会话、缓存、工作区、凭证或用户卷；执行证据保存在经授权的数据库，临时会话随容器销毁。

当前不启用数据库 RLS，后端授权有负向测试。旧 Pi 和宿主 DSH 数据不导入、不删除。企业实现不等同于旧八源检索、五闸门或场景泛化，见迁移矩阵。
