# DECISIONS.md — 自主决策记录

> 依据自主执行协议 D 条：清单未覆盖的细节自行决策，逐条记录决策内容 / 理由 / 替代方案。

| # | 日期 | 决策内容 | 理由 | 替代方案 |
|---|---|---|---|---|
| D1 | 2026-09-29 | Pi 仓库结构与清单描述有出入：`packages/agent`（npm 名 @earendil-works/pi-agent-core）对应清单所称 `agent-core`；仓库内无 `web-ui` 目录，但 npm 存在 `@earendil-works/pi-web-ui@0.75.3`，以 npm 包为准复用 | 官方仓库已重组，npm 包名是稳定契约 | 从旧 commit 找 web-ui 源码（无必要） |
| D2 | 2026-09-29 | 项目根 = `场景智能体/pi-scenario/`；`build-log/`、`review/`、`DECISIONS.md`、`BLOCKED.md` 均置于项目根 | 清单 0.1.4 将四者列为项目级工件 | 置于场景智能体/ 顶层（与代码分离不利审查） |
| D3 | 2026-09-29 | Store 落盘根目录使用 `~/.pi/scenario/`（与清单 0.2.3 一致），Windows 下即 `C:\Users\<user>\.pi\scenario\` | 清单明示 | 项目内 `.data/` 目录 |
| D4 | 2026-09-29 | ESLint 采用 9.x flat config + typescript-eslint 8；lint 钩子经 husky pre-commit 调 `npm run lint` | 现代 ELK 标准形态 | eslintrc 旧格式（已弃用） |
| D5 | 2026-09-29 | 生态包消费方式分层：编译产物包（subagents/mcp-adapter 子路径/context-mode/web-ui）直接 import；TS 源码小包（pi-agent-loop/rpiv-todo）vendored 复制（MIT 保留头）；loop-designer 仅用其数据资源；reactor 子进程 CLI 集成；hermes-memory 作设计参考。Node 25 不支持 node_modules 下 TS 剥离，直接 import TS 入口在运行时必失败 | 实测各包 package.json 形态后定 | 全部 vendored（失真大）/ 全部走 pi 扩展加载器（测试不可行） |
| D6 | 2026-09-29 | P.2.2.b "import 各包的编译测试"实现为：可编译子路径逐一直接 import 断言；TS 源码包经 vendored 副本纳入编译；这一组合覆盖全部 12 包 | 见 D5 的形态约束 | 对 TS 源码包写 ambient 声明（失去类型检查价值） |
