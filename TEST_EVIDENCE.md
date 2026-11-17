# 测试证据

执行日期：2026-11-18，Windows PowerShell 7.6，Docker Server 29.1.2。原宿主 Node25不受新版 Vitest 支持，实际后续验证使用独立缓存的 Node **24.22.3**，未修改全局安装。命令通过该 Node 调用 npm-cli.js，子进程 PATH 使用同一 Node。

## 已记录的针对性证据

- 基线 API 34/34 通过，未以该旧结果冒充修复后验收。
- 新硬化集成19项通过：发布/授权冻结、回滚/并发/乱序审批、独立审批、执行中 SSE/重连、幂等、取消/超时/限次重试及重新审批、执行中撤权、并发额度、真实 PostgreSQL 故障回滚、崩溃租约、规则冲突/版本/项目权限、票据重放/撤销、限流、生产门控。
- 原28项 API 验收保留，并按异步/审批合同更新；增加真实 S3 元数据失败后对象回收，共29项通过，包含签名往返及对象匿名403。
- 语义/Judge准入7项、私有依赖补丁2项、真实 HTTP 模型代理/部署清理作用域/未知用量3项通过；其中模型响应为明确单元夹具，不冒充真实服务。代理负向还覆盖相同字符数但不同字节数的异常凭证头与非法请求不得计为上游调用。
- ISO-06 真实 DSH：恶意文本/Unicode/长输入保持哈希、拒绝 bash/Skill/MCP/未知工具；同部署两组织 bash 数据隔离；另一部署不能删除实际运行容器；取消和真实执行中超时终止/删除；容器实际访问认证模型代理（仅测试上游）。
- ISO-03 两个唯一 Compose 实例隔离并移除自建卷/网络；ISO-05 无宿主挂载、非 root、只读根、无特权/能力。
- E2E 编译后服务器：独立发布/任务审批 → 真实 DSH 工具输出 → 显式纠正 → 人工批准规则 → 下次注入/机械评估；跨组织访问拒绝。
- 独立无头 Edge：组织登录、敏感同意、审阅者批准、实际 tool_result、结束状态与集成未配置；完成后旧审批提示消失、同意复位、取消按钮禁用，浏览器错误为0。截图 [.audit/evidence/workspace.png](.audit/evidence/workspace.png)。
- npm ci / install 实际审计0漏洞；SBOM从实际依赖树生成398组件。上游无补丁的匹配器由本项目完整私有源码补丁修复，保留许可，无忽略项。

## 最终复现命令

```sh
npm ci
npm run build
npm run lint
npm run test:api
npm run test:isolation
POROS_E2E_REQUIRED=1 npm run e2e
npm audit --audit-level=low
npm run sbom
```

最近本地全量 API **5文件、60/60通过**。完整隔离集 ISO-01/02/03/05/06 通过；运行代理/用量修改后，build（含两端类型检查）、ISO-06、编译后 E2E/无头 Edge再次通过，真实DSH用量落库断言通过。最后UTF-8修复又通过代理3项与实际镜像ISO-06针对性验证。lint见提交钩子及CI记录；npm ci/audit均为0漏洞，SBOM398组件。当前HEAD全量验证以最终CI为准。

最终命令日志保存在 `.audit/evidence/`（build.log、lint.log、test-api.log、test-isolation.log、iso-06-final.log、e2e.log、npm-ci.log、npm-audit.log、sbom.log）。CI 由私有修复 PR 的 Checks 提供当前 HEAD 的可复核结果，不能用旧公开 PR 的成功记录替代。本文件不提前写入尚未完成的远端成功状态。

本机业务库迁移前已生成41818字节的自定义格式备份，验证90条目录项；迁移前后九张业务表行数相同。备份与前后计数保存在 Git 忽略的 `.audit/backups/`，未公开上传，未将目录验证说成恢复演练。

## 失败与修复记录

1. 注入测试先真实失败并创建无害哨兵；精确移除自己的标记/UUID目录后修复，再通过真实负向。
2. Docker Hub 拉取超时，本机使用已验证同版镜像叠加可信修复层；不宣称从零镜像在本机拉取成功。
3. DSH 新插件必须使用 insert patch；旧未知 entry 会警告并跳过。依据官方配置 schema 修正后，真实前置拒绝事件出现。
4. Prisma advisory lock 的 void 解码导致500；转text后事务与审批测试通过。
5. S3 3.85 环境变量方式匿名仍200；改显式配置后403，原具名卷保持。
6. SBOM暴露 esbuild覆盖声明与嵌套版本不一致；统一后生成成功，没有跳过失败。
7. 私有仓库首轮 CI 的 Postgres service 初始化暴露 Runner 不按 Shell 单引号分组：`-U`被当成 Docker 参数，尚未运行任何应用测试。已将 health-cmd 改为 Runner 支持的双引号分组；远端复测结果由修复 PR 当前 HEAD 的 Checks 记录。
8. 第二轮 CI 构建/API与完整镜像/隔离已通过，E2E基础设施阶段误认 PostgreSQL 初始化临时 Unix-socket 实例就绪。依据实际官方 entrypoint 的 `listen_addresses=''` 改用 TCP readiness。账号制品存储配额已满，未删除已有制品或购买额度；改为浏览器断言全部通过后，将该次实际截图字节数、SHA-256及执行 commit 写入日志和 Job Summary。本机真实截图随交付保留，不用仓库旧图冒充本次运行图。
9. 用量复核发现 DSH 缺字段时曾累计0；已改为未知值传播null、实际代理上游尝试计数、步骤数不一致时Token总量未知，并分别保留generation/Judge用量。真实HTTP负向、数值契约、Judge用量传递和真实DSH落库均已通过。金额仍为null，不伪造账单。
10. 分块HTTP真实复现UTF-8边界损坏：`中文🙂分块请求`变成`���文🙂分块请求`，失败日志`utf8-before.log`。代理、容器stdin与测试模型请求统一使用Node原生UTF-8流解码后，真实分块HTTP的3项代理回归通过（`utf8-after.log`）；ISO-06输入扩展为约74KiB、含大量中文/emoji的数据，并重新构建实际镜像验证。
11. 两个连续PR完整运行已三job成功，但同一HEAD的push/PR重复触发留下取消检查，使PR汇总为UNSTABLE。收敛为main/企业主线push和所有PR分别触发完整三job，修复分支由PR完整验证；不删历史运行、不跳过测试，最终还需检查当前HEAD恰好三项SUCCESS与PR的CLEAN状态。

CI 固定 Ubuntu24.04，checkout/setup-node 使用官方 Node24 版本并固定提交SHA，避免原Node20弃用和ubuntu-latest迁移提示。远端当前HEAD必须完成三job后才可交付，旧失败/取消运行不算通过。

没有真实模型/第三方凭证的服务验收。`dsh(stub)` 只证明真实 DSH/工具链与工程边界；费用金额未知记null，禁止外推成生产模型质量或账单证明。
