# 测试证据

执行日期：2026-11-18，Windows PowerShell 7.6，Docker Server 29.1.2。原宿主 Node25不受新版 Vitest 支持，实际后续验证使用独立缓存的 Node **24.22.3**，未修改全局安装。命令通过该 Node 调用 npm-cli.js，子进程 PATH 使用同一 Node。

## 已记录的针对性证据

- 基线 API 34/34 通过，未以该旧结果冒充修复后验收。
- 新硬化集成19项通过：发布/授权冻结、回滚/并发/乱序审批、独立审批、执行中 SSE/重连、幂等、取消/超时/限次重试及重新审批、执行中撤权、并发额度、真实 PostgreSQL 故障回滚、崩溃租约、规则冲突/版本/项目权限、票据重放/撤销、限流、生产门控。
- 原28项 API 验收保留，并按异步/审批合同更新；增加真实 S3 元数据失败后对象回收，共29项通过，包含签名往返及对象匿名403。
- 语义/Judge准入7项、私有依赖补丁2项、真实 HTTP 模型代理与部署清理作用域2项通过；其中模型响应为明确单元夹具，不冒充真实服务。
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

最终本地 API 合并运行 **5文件、59/59通过**；build/lint均通过。完整隔离集 ISO-01/02/03/05/06 通过；部署清理作用域修改后，ISO-06又单独通过。最终编译后 E2E/无头 Edge通过；npm ci/audit均为0漏洞，SBOM398组件。

最终命令日志保存在 `.audit/evidence/`（build.log、lint.log、test-api.log、test-isolation.log、iso-06-final.log、e2e.log、npm-ci.log、npm-audit.log、sbom.log）。CI 由私有修复 PR 的 Checks 提供当前 HEAD 的可复核结果，不能用旧公开 PR 的成功记录替代。本文件不提前写入尚未完成的远端成功状态。

本机业务库迁移前已生成41818字节的自定义格式备份，验证90条目录项；迁移前后九张业务表行数相同。备份与前后计数保存在 Git 忽略的 `.audit/backups/`，未公开上传，未将目录验证说成恢复演练。

## 失败与修复记录

1. 注入测试先真实失败并创建无害哨兵；精确移除自己的标记/UUID目录后修复，再通过真实负向。
2. Docker Hub 拉取超时，本机使用已验证同版镜像叠加可信修复层；不宣称从零镜像在本机拉取成功。
3. DSH 新插件必须使用 insert patch；旧未知 entry 会警告并跳过。依据官方配置 schema 修正后，真实前置拒绝事件出现。
4. Prisma advisory lock 的 void 解码导致500；转text后事务与审批测试通过。
5. S3 3.85 环境变量方式匿名仍200；改显式配置后403，原具名卷保持。
6. SBOM暴露 esbuild覆盖声明与嵌套版本不一致；统一后生成成功，没有跳过失败。

没有真实模型/第三方凭证的服务验收。`dsh(stub)` 只证明真实 DSH/工具链与工程边界；费用金额未知记null，禁止外推成生产模型质量或账单证明。
