# 当前复用决策

| 范围 | 实际复用 | 自有代码边界/证据 |
|---|---|---|
| Harness | 官方 DSH 0.2.2-rc.1 | 镜像与生命周期桥；读取发行源码，使用真实 tools/pre-execute，不修改宿主安装 |
| UI | React 19 / Radix / Tailwind / Vite | 业务接线、表单与状态；没有宣称使用未安装的 shadcn/TanStack/RHF |
| 身份 | jsonwebtoken / bcryptjs | 组织权限映射、数据库会话撤销；无自研签名协议 |
| 存储 | PostgreSQL 17 / Prisma 6.19.0 / SeaweedFS 3.85 / AWS SDK | 事务、队列、元数据和授权；无自研存储引擎，无虚称 RLS |
| 队列 | PostgreSQL 事务、行锁与 advisory lock | 薄 Worker，无未安装的 pg-boss 或第二调度平台 |
| 日志 | Fastify/Pino | 脱敏、序号化运行事件；不声称部署了未安装的 OpenTelemetry |
| Judge | 同一准入 DeepSeek 网关 | 批量语义判断、严格失败状态与逐条证据；无假模型 PASS |
| 浏览器验证 | Playwright Core / 独立无头 Edge 或 Chromium | 真实 UI 流程；不控制用户可见桌面 |
| 依赖安全 | 升级受影响依赖、完整本地匹配器安全 fork | 上游无补丁时禁用不需要的危险语法，保留 MIT 与出处，有测试和 SBOM |

旧的候选清单不是当前已安装事实。精确版本/许可见 THIRD_PARTY 和生成的 SBOM。Kdocs/IMA/TinyFish/Skill/MCP/Knowledge 未配置真实绑定时直接拒绝，不拿 mock 充作已接入。
