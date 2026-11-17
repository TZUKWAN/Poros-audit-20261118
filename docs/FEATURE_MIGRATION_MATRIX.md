# main 与企业版差异

只读核对 main `18ec87ba62f58ee31be8ea864398896bedd3bd96`、企业基线 `fdb85cbe632ef57fd009cb039b6995500476c7dd` 及当前修复代码。依据为 git ls-tree 和 main 的真实源码；未执行旧 main 全套测试，不声称旧功能在企业版仍可运行。

| 旧能力/源码 | 企业对应物 | 分类与结论 |
|---|---|---|
| 一句话场景构建：orchestrator/planner、handlers、state-machine | NL Agent 草稿、差异、版本和审批 | 部分替代；不生成旧场景 DAG；真实 LLM 依赖授权，mock 明示 |
| 五闸门：state-machine.ts / GATE_ON_EXIT | 独立发布、敏感任务与规则审批 | 部分替代；保留人的边界，不宣称五个研究闸门等价移植 |
| 八源检索：federation/factory.ts 的八个市场和领域源 | 精确注册与授权能力 | 明确取消通用联邦市场，沿用已确认企业方向 |
| 场景库/填槽/蒸馏：scenario/library、reuse、distill | 已审批 Agent 版本复用 | 旧算法明确取消，资产复用部分替代；不称为场景泛化 |
| 反馈账本：scenario/ledger、team-ledger、selfcheck | Judgment 来源/审批/作用域/修订/注入/证据 | 部分替代；无自动晋级、沉默通过或伪因果统计，不声称逐行迁移 |
| 长期运行：product/long-runs、scheduler | 持久队列/租约/SSE/取消/超时/显式重试 | 部分替代；单次最多 300s，不提供旧多轮检查点恢复；崩溃显式失败 |
| ARES/METIS：domains/profile、*-knowledge、ares-skills | 组织 Agent 配置和授权边界 | 自动携带旧领域包明确取消；未注册 Skill/Knowledge 拒绝，旧资料保留 Git 历史 |
| 身份/任务/文件：product/identities、tasks、artifacts | PostgreSQL 组织/成员/项目/RBAC、任务、认证 S3 | 对应企业核心边界完整替代；不把旧同步分享/桌面适配算成全部迁移 |

“需要产品决策”项已由刘总决定：沿用企业 DSH、私有 UNLICENSED，本轮不恢复已取消旧架构。申报书中的八源检索/蒸馏/自动泛化不得继续作为企业版已实现成果。可如实对应：自然语言定义构建、受控真实执行、人工反馈转化与规则复用。
