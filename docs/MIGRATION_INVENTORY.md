# 企业迁移处置终表

main 18ec87ba，企业基线 fdb85cbe。完整差异见 [功能矩阵](FEATURE_MIGRATION_MATRIX.md)。

| 路径 | 当前事实/处置 |
|---|---|
| orchestrator/gates/federation/distill/scenario/panel | 企业基线已删除旧 Pi 链。本轮不恢复、不继续删除研究历史，替代/取消分别说明 |
| core/domains/product/memory/integrations | 活动源码为企业 server；旧领域、长期运行、同步未全量移植，不宣称等价 |
| server/prisma/web | 当前企业实现；修复执行安全、审批、版本、任务、规则和生产控制，真实依赖验证 |
| pi-package/旧构建入口 | 无活动 Git 跟踪执行入口；不清理磁盘既有忽略产物 |
| 旧中文方案/CLI_WEB_MATRIX/REBUILD_PLAN | 保留为历史文档，顶部标识，不作为当前部署事实 |
| package/lock、Docker/CI | 固定版本、漏洞修复、真实 SBOM；匹配器私有补丁保留原 MIT |

旧报告把草稿/发布等价成五闸门、把规则原型当作整个场景库保留的表述不再使用。本轮无 RLS，应用授权有负向测试。旧版本授权不可追溯时拒绝执行，不能迁移补猜。

业务库只增量迁移，测试创建 UUID 独立库。旧 Pi 用户数据及宿主 DSH 不自动读取、导入、删除。
