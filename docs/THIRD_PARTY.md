# 第三方与 SBOM

[sbom.cdx.json](sbom.cdx.json) 由 `npm run sbom` 从实际 npm 依赖树生成，包含开发工具；精确版本/完整性见 lockfile。

| 组件 | 基线 | 许可 |
|---|---|---|
| DSH | 0.2.2-rc.1 | MIT，deepseek-ai/deepseek-harness |
| Node | 24.22.3 | MIT 等 |
| PostgreSQL | 17-alpine | PostgreSQL License |
| SeaweedFS | 3.85 | Apache-2.0 |
| Fastify/static | 5.12.8 / 10.1.11 | MIT |
| Prisma/client | 6.19.0 | Apache-2.0 |
| AWS S3 SDK | 3.1170.0 | Apache-2.0 |
| React/Radix/Tailwind/Vite | lockfile 实际版本 | MIT |
| Vitest / Playwright Core | 5.1.0 / 1.65.1 | MIT / Apache-2.0 |
| @poros/picomatch-secure | 4.0.7+poros.security.1 | 原 MIT 保留 |
| PDF.js / yauzl / saxes | 6.5.438 / 3.4.0 / 6.0.0 | Apache-2.0 / MIT / ISC |

匹配器上游 GHSA-fc5q-39xc-vjpf 尚无已发布修复，不能假称升级解决。私有完整源码补丁禁用项目不需要的重复 extglob；见 [补丁说明](../vendor/picomatch/SECURITY_PATCH.md) 与对应测试。没有漏洞忽略项，npm audit 检查真实依赖树。

仓库公开可读。Poros 根包声明 UNLICENSED，第三方组件以其各自的许可证为准。

依据：已安装 DSH 0.2.2-rc.1 官方发行源码、Prisma 6.19.0 类型与真实数据库事务、[Fastify static 兼容表](https://github.com/fastify/fastify-static#compatibility)、[SeaweedFS 凭证](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials)、[Playwright Library](https://playwright.dev/docs/library)、[匹配器漏洞公告](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)。Context7 返回 Invalid API key，未将失败记作成功检索。
