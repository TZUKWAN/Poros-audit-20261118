# DEPLOYMENT — SceneFlow Enterprise

## 部署边界（PRD §4.1）

```text
宿主机
├── 原有 DeepSeek Harness          # 禁止触碰；完全不参与
└── Docker/OCI
    └── Compose project: sceneflow-enterprise
        ├── dsh        # 唯一 Agent Harness（sceneflow/dsh:0.2.2-rc.1, digest sha256:be1aa0c6…）
        ├── db         # postgres:17-alpine（环回 127.0.0.1:55432）
        └── s3         # seaweedfs:3.85 S3 兼容（环回 127.0.0.1:59000）
        （后续：web/api 服务入同一网络，对外只发布 Web 入口）
```

## 铁律

- DSH 容器：非 root(10001)、零发布端口、具名卷、`no-new-privileges`、`cap_drop ALL`、`tmpfs /tmp`、无宿主任何路径挂载。
- 数据层：仅 `127.0.0.1` 环回发布（开发机连接）；生产不发布、走 `sceneflow-net` 内部。
- postgres 的 root 启动+gosu 降级、SeaweedFS 待定制非 root 镜像：两项豁免/硬化债已记录于 `docs/ISOLATION.md` 与 ISO-02 审计输出。
- 模型/知识库密钥只经环境注入运行服务，不入镜像、不入 compose 文件、不入库。

## 启动

```bash
cp deploy/.env.example 路径 → deploy/.env（改全部 change-me）
docker compose -f deploy/docker-compose.yml up -d
npx prisma migrate deploy && npm run db:seed   # 首次
npm start
```

## 隔离验收

`npm run test:isolation` → ISO-01 哨兵 / ISO-02 静态审计 / ISO-05 容器逃逸负向；ISO-03/04 为容器生命周期实测，记录于 `docs/ISOLATION.md`。
