# Poros 审计修复报告

日期：2026-11-18。基线为企业分支 fdb85cbe632ef57fd009cb039b6995500476c7dd；修复分支 codex/poros-audit-20261118。main 18ec87ba 保持只读，Git 历史保留。全程单模型执行，未使用子智能体。

## 逐项处置

| 项目 | 真实原因与修复 | 代码/验证 |
|---|---|---|
| P0-1 命令注入 | 旧 heredoc 实际创建了无害攻击哨兵；新桥固定 argv、stdin JSON、固定私有路径，任务不进入 Shell | dsh-runtime、bootstrap；ISO-06 引号/换行/结束符/Unicode/超长输入哈希和哨兵 |
| P0-2 执行前授权 | 旧 profile 部分禁用+事后审计不足；加入官方 tools/pre-execute/execute 确切白名单，未知工具默认拒绝、Model 单独准入，事后检查保留 | tool-policy、releases、runner；真实 DSH bash/Skill/MCP/未知工具负向 |
| P0-3 同部署组织隔离 | 旧任务共享容器/HOME；改为每任务独立容器、无用户卷和共享目录；密钥留在服务端，经限额短期令牌代理 | ISO-06 两组织并发 bash 私有文件、取消/超时/清理、容器到模型代理传输 |
| P1-4 版本冻结 | 授权曾读可变 AgentGrant；发布 manifest 冻结名称/部门/Persona/配置/Model Policy/精确授权/版本/来源，DB 触发器保护 | releases/schema/migration；草稿/授权变化不影响旧版本，直接改快照被 DB 拒绝 |
| P1-5 回滚再发布 | currentVersion+1 与历史冲突；独立 versionCounter、行锁事务、回滚只换已审批版本指针；旧版延迟批准不倒退生效指针 | 连续发布、回滚后发布、并发唯一版本及先批新版再批旧版测试 |
| P1-6 实时流 | 原 HTTP 等全部完成再回放；改为 202 入队、后台 Worker、逐事件持久化和 SSE ID/补发 | 长任务尚 RUNNING 已收到 judgment 事件；Last-Event-ID 不重复补发；真实无头 UI |
| P1-7 审批/单次授权 | 原发布自批准；改为冻结后 PENDING，禁止自审批；敏感任务须发起人显式 consent 和独立审批 | 突破角色、自审批、未同意、重复审批、快照不变回归；Governance UI |
| P1-8 Judgment 生命周期 | 空参数/非法数字、作用域和来源、冲突、原地修订问题；严格语法、真实对象、跨范围机械冲突、不可变家族修订、人工 supersede/disable | judgment/routes/migration；非法规则、冲突拒审、版本史和项目权限回归 |
| P1-9 模型/Judge | 真实 DSH 与独立 mock 网关失配；执行模型准入统一，测试模型禁用真实语义裁决；缺失/重复/无理由/截断证据不 PASS | executionGateway、semantic-judge；七项语义与准入测试 |
| P1-10 负向覆盖 | 补充真实运行安全、并发、授权变更、幂等、模型/DB 失败、租约失效、项目边界、票据重放 | API、ISO-06 与 E2E；原有验收未删除，改为验证真实异步合同 |
| P2-11 部署一致 | Node 22/20/24 与端口冲突；固定 Node 24.22.3、8787、DSH 版本；构建复制静态文件，生产从 dist 启动 | .node-version/package/CI/Dockerfile/copy-public；build 和编译后服务器 E2E |
| P2-12 文档一致 | 失效 MinIO/Pi/候选复用/RLS 声明；当前架构重写，旧研究材料标历史，迁移差异逐项明确 | README/ARCHITECTURE/DEPLOYMENT/FEATURE_MIGRATION_MATRIX/REUSE_AUDIT |
| P2-13 生产安全 | 速率限制、撤销认证、一次性下载、文件边界、S3 认证、已知密钥脱敏、生产拒绝种子/mock/stub | auth/security/storage/env；真实 S3 签名往返及匿名403、重放/退出/移除成员/开发配置负向 |
| P2-14 运行治理 | DB 共享队列/并发配额/租约；取消/截止时间/显式限次重试；容器硬配额；输出/事件/诊断限额；归属清理 | worker/runtime/proxy；真实取消/超时、并发限额、崩溃租约不重放、唯一实例清理 |
| P2-15 许可证 | 未擅自选择开源许可；刘总决定私有 UNLICENSED，package private:true；第三方各自许可保留 | DECISIONS、THIRD_PARTY、实际 SBOM、私有匹配器补丁 MIT |

## 补充工程问题

- 原 ISO-03 使用 process.exit(0) 跳过 finally，留下测试实例；改为唯一 project 和必经清理，Windows 不依赖宿主 sh/sleep。ISO-05 也使用独立一次性容器。
- Docker Hub 本机拉取超时后，使用已验证同版 DSH 镜像加修复层；没有假报从零构建成功。完整 CI 走固定 Dockerfile。
- SeaweedFS 3.85 仅环境变量认证经动态验证无效，改为显式身份配置；匿名403与签名往返均验证，原数据卷不删。
- 修复 Prisma advisory-lock 的 void 类型解码问题；锁返回值转 text，不降低事务隔离。
- 升级漏洞依赖；无上游修复的匹配器使用保留 MIT 的完整私有 fork，禁用不需要的危险重复 extglob。未忽略漏洞。SBOM 曾发现 esbuild 安装树与覆盖声明不一致，修复并重新生成，不能带着无效依赖树交付。
- 新旧 UI 对发布/任务状态已同步；旧 legacy 原型只读停用脚本，避免把 PENDING 说成已发布。
- SSE 区分真实待审批与撤权后的终止阻止；UI 完成后移除旧审批提示、复位本次同意、禁用不适用动作，401/403停止重连。
- 清理资源同时核对部署数据库/schema、runId、归属 token；真实容器验证不同部署不能误删，密钥轮换不改变部署标识。
- 本机迁移前备份已验证90条目录项，九张业务表迁移前后行数一致；备份保留本地且不进入 Git。已核实只有旧 ISO-03 测试标记的遗留实例精确清理，未删除用户资源。
- 运行用量不再把缺失Token当0；实际代理上游尝试与已观察步骤分开，缺失或不一致传播null，generation/Judge分项落库，金额未知为null。异常字节长度凭证头直接401，禁止转成进程异常；断开模型代理时中止上游。
- CI真实暴露并修正Postgres参数分组与初始化临时实例就绪竞态。账号制品额度耗尽采用实际运行日志/Job Summary截图哈希和本机图像交付，未删用户制品、未开通付费额度；全部测试保持必跑。固定Ubuntu24.04与官方Node24 Actions提交。
- 分块HTTP先真实复现中文/emoji跨Buffer边界损坏，再统一代理、容器stdin和测试模型的UTF-8流解码；保留失败/修复日志，ISO-06覆盖约74KiB多字节输入的原文哈希。

## 范围与复核

本轮不恢复旧八源联邦/场景蒸馏/多轮检查点，不将这些算作完整迁移。产品/许可证选择已由负责人明确，见决策表。原公开仓库不接收私有补丁。

主模型复核包含：授权链、schema/迁移、发布/规则不可变性、Worker/SSE 状态、容器/凭证边界、失败路径、测试模型标注、真实产物存在、文档与当前源码一致。每次失败先修复并复测，再推进下一单元；最终命令和证据见 TEST_EVIDENCE。

没有真实模型、Kdocs/IMA/TinyFish 的外部凭证验收。语义模型判断不是确定性证明；未知用量/账单金额记 null，不虚构费用。没有宣称企业生产在任意环境下“零风险”；当前已验证的是明确列出的工程控制与测试边界。
