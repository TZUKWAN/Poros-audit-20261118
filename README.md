# Poros Enterprise

企业 Agent 的构建、发布、执行和判断规则治理平台。唯一 Agent Harness 为容器内 **DSH 0.2.2-rc.1**。本轮沿用企业方向，私有、UNLICENSED；不恢复旧 Pi 编排、联邦市场或场景蒸馏。

## 当前行为

- React 19 / Radix / Tailwind / Vite：组织登录、Builder、任务实时事件、独立审批、规则修订、集成状态。
- 发布申请冻结 Persona、配置、Model Policy、精确授权及版本/来源；独立审阅者批准后生效。版本单调递增，回滚只换指针。缺少历史授权快照的旧版本须重新发布审批，不虚构迁移授权。
- 任务提交立即返回 202 和 ID，PostgreSQL Worker 后台执行；支持事件 ID/重连补发、幂等、取消、超时、显式限次重试和共享并发限额。敏感工具须本次同意和独立审批。
- 每任务独立临时 DSH 容器，无用户卷/宿主挂载/Docker socket；非 root、只读根、资源配额。工具执行前默认拒绝，事后再审计。模型供应商密钥留在 API 宿主。
- Judgment：显式反馈、真实作用域/来源、人工审批、机械冲突检测、不可变修订与逐次证据。FAIL/UNCHECKED/PASS 分离；开发 mock 输出为 UNVERIFIED。
- 可撤销认证、登录/上传限流、原子一次性下载票据；SeaweedFS S3 拒绝匿名访问。

## 启动

Node **24.22.3**（`.node-version`），Docker / Compose v2。API 默认只监听 `127.0.0.1:8787`。

```sh
cp .env.example .env
# 编辑本部署自己的数据库、JWT、S3 配置，不提交真实凭证
npm ci
npm run db:up
npx prisma migrate deploy
npm run runtime:build
npm run build
npm run db:seed       # 仅开发，生产拒绝种子
npm start
```

构建包含服务端、UI 和 `dist/src/server/public`。生产使用 `npm run start:prod`；配置不全、mock/stub、开发默认口令或开发成员均拒绝启动。详见 [DEPLOYMENT](docs/DEPLOYMENT.md)。

## 验证与证据

```sh
npm run build
npm run lint
npm run test:api
npm run test:isolation
npm run e2e
npm audit --audit-level=low
npm run sbom
```

测试使用独立临时数据库、真实 PostgreSQL/S3/DSH/工具及无头浏览器，只清理自建资源。模型桩仅用于可重复验证执行边界，**不代表真实模型服务验收**。未配置的 Kdocs/IMA/TinyFish 不可授权或调用，无假成功。

交付：[审计修复报告](AUDIT_FIX_REPORT.md)、[测试证据](TEST_EVIDENCE.md)、[安全复核](SECURITY_REVIEW.md)、[功能迁移矩阵](docs/FEATURE_MIGRATION_MATRIX.md)、[已定事项](docs/DECISIONS.md)、[第三方/SBOM](docs/THIRD_PARTY.md)。旧 Pi 文档是历史资料，不能作为当前部署说明。
