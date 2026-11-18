# 部署与启动

Node 24.22.3（`.node-version` / CI / Dockerfile），DSH 0.2.2-rc.1，PostgreSQL 17，SeaweedFS 3.85。API `127.0.0.1:8787`、数据库 55432、S3 59000，默认仅环回。

```sh
cp .env.example .env
# 填写本部署自己的配置，不复制宿主 DSH 凭证
npm ci
npm run db:up
npx prisma migrate deploy
npm run runtime:build
npm run build
npm run db:seed  # 仅开发
npm start
```

Compose 显式读取 `.env`；CI 用环境变量。SeaweedFS 使用 `-s3.config` 身份，无匿名账户；3.85 仅设置 AWS 环境变量经实测不足以拒绝匿名。S3 密钥使用随机字母/数字/下划线/连字符，避免 JSON 插值歧义。认证升级保留具名数据卷，真实部署禁止 `down -v`。

`Dockerfile.dsh` 支持从零构建。若 Docker Hub 不可达且已有已验证的 `poros/dsh:0.2.2-rc.1`，可用 `docker build -f deploy/Dockerfile.runtime -t poros/dsh:0.2.2-rc.1-audit .` 叠加本机测试修复层；离线基础镜像的 Node 精确版本可能不同，完整 CI 从固定 Dockerfile 构建。Compose dsh 是隔离测试模板，实际任务不使用其共享卷。

## 真实模型与生产

设置 `POROS_RUNTIME=dsh`、`MODEL_GATEWAY=deepseek`、`POROS_DSH_MODEL_STUB=0` 和明确授权的 `POROS_DEEPSEEK_API_KEY`。供应商密钥只留在 API 进程；容器经短期令牌访问同一准入模型。真实 DSH 的 Judge 不因 Builder 仍为 mock 而失配。

使用个人模型的部署可设置 `POROS_PERSONAL_MODEL_ONLY=1` 和独立的 `POROS_SETTINGS_KEY`，保留真实 DSH，运行时以完成连接测试的成员凭证为准。现有部署也可设置加密主密钥启用个人集成。精确的模型及远程访问合同见 [手机与个人集成](MOBILE_AND_CONNECTIONS.md)。

JWT 至少 32 字符；数据库/S3 替换开发默认，数据库不得含 `.test` 开发成员。执行 `npm run build` 后使用 `npm run start:prod`。外部入口由受控 TLS 反向代理接入环回端口。API 服务账户需要 Docker 权限；禁止将该账户凭证/socket 交给 Agent。

默认配额：全局 4、组织 2 并发；组织队列/运行最多 100；任务 500ms–300s，最多 3 次显式尝试；容器 1 CPU / 768MiB / 128 PID；执行模型最多 64 次调用，语义 Judge 另至多1次且不重试，每次至多 4096 输出 Token。缺失用量为null，实际生成/Judge分项记录，未知金额为null。事件、输出和诊断均有限额。副作用不自动重放，取消/超时/关闭/崩溃由截止时间及归属标签清理处理。

开发前端用 `npm run ui:dev`，生产由 Fastify 提供构建 UI，同源部署。

## 迁移与验证

迁移只增加字段/表/枚举/保护触发器，不删除业务数据。保留旧版本记录，但拒绝按当前草稿补猜历史授权；需重新发布审批。回滚只指向已审批版本。旧 Pi/宿主 DSH 不自动访问。

运行 build、lint、test:api、test:isolation、e2e、audit。API/E2E 创建 UUID 独立测试库并清理自建对象。ISO-03 唯一 project、finally 清理。Linux UI 测试前执行 `node node_modules/playwright-core/cli.js install --with-deps chromium`；Windows 使用独立无头 Edge，不控制可见桌面。
