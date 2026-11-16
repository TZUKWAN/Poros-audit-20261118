# ISOLATION — 宿主 DSH 零影响证据（PRD §4）

> 本文件只随真实运行结果更新；每项标注执行方式与局限，不用"理论上隔离"充数。

## 硬边界（代码与部署层）

- `src/server/dsh-paths.ts`：一切路径只从 `SCENEFLOW_HOME` 派生，缺失即抛错，**无操作系统默认目录回退**（隔离 by construction）。
- `deploy/docker-compose.yml`：独立 project/network/具名卷；DSH 服务零发布端口、非 root(10001)、`no-new-privileges`、`cap_drop: ALL`、`tmpfs /tmp`；**无任何宿主路径 bind mount、无 Docker socket、无特权、无 host 网络**。
- `deploy/Dockerfile.dsh`：node:24-bookworm-slim + 锁定版本 DSH；容器内专属 HOME/XDG/DSH_HOME。

## 验收状态矩阵

| 用例 | 状态 | 证据 | 执行方式与局限 |
|---|---|---|---|
| ISO-01 哨兵目录负向 | ✅ PASS | `node tests/isolation/iso-01-sentinel.mjs` | 仿真宿主 HOME（4 哨兵含金丝鹰令牌）→ 运行路径模块 → 哨兵哈希前后一致；源码静态守卫无默认目录回退。**软件级实现**：无 syscall 探针（Windows CI 条件限制），以"哈希清单+源码守卫+拒绝回退的构造"替代，如实标注。未触碰任何真实宿主 `.dsh` |
| ISO-02 卷/权限/网络静态审计 | ✅ PASS | `node tests/isolation/iso-02-compose-audit.mjs` | 解析 `docker compose config`：无特权/host 网络/docker.sock/root/发布端口/ bind 挂载；宿主路径黑名单未命中 |
| ISO-03 双实例互不影响 | ⏳ 待镜像构建后执行 | — | 计划：`docker compose -p sceneflow-a / sceneflow-b` 各起一套，A 改配置后断言 B 与哨兵不变 |
| ISO-04 进程与端口审计 | ⏳ 待镜像构建后执行 | — | `docker ps`/宿主机端口核对：无宿主 dsh 进程被拉起、无端口冲突 |
| ISO-05 权限负向（容器越宿主） | ⏳ 待运行链接通后执行 | — | 容器内尝试访问宿主路径/未授权工具 → 必须拒绝+审计 |
| SEC-01 提示词注入/越权工具 | ⏳ Phase 2-3 执行 | — | 随工具网关与权限中间件交付 |

## 真实运行证据（构建后回填）

- 镜像构建：`docker compose -f deploy/docker-compose.yml build` →（回填日志摘要与镜像 digest）
- 容器内 DSH 版本：`docker run --rm sceneflow/dsh:0.2.2-rc.1 dsh --version` →（回填）
