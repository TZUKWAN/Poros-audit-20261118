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
| D7 | 2026-09-29 | tests/setup.ts 注入 DOMMatrix/Path2D 最小 stub：pi-web-ui（Lit 浏览器组件库）依赖 pdfjs-dist 顶层引用浏览器全局，Node 测试环境无法 import。这是环境 polyfill，不是 mock 测试 | 实测 Node 直拉报 DOMMatrix is not defined | 改 jsdom 环境（重且慢）/ 跳过 web-ui 编译测试（违反 D6 覆盖要求） |
| D8 | 2026-09-29 | 8 源实测接入端点（与任务清单猜测的差异均实测确认）：① mcp.so 无公开 JSON API（api.mcp.so 502、/api/* 只回 HTML、ServerFn 直连 500），搜索页纯 SPA → 适配器降级为 slug 详情页解析（SSR JSON-LD + GitHub 链接 + 远程标记）② modelcontextprotocol/servers 走 GitHub API（gh token 可用，未认证限流由指数退避+GITHUB_TOKEN env 缓解）③ ModelScope 实测为 `PUT /api/v1/dolphin/mcpServers`（body PageSize/PageNumber/Query/Criterion；mcp.modelscope.cn 已 ENOTFOUND，浏览器 XHR 抓包破解）④ Cline 实测 `GET api.cline.bot/v1/mcp/marketplace`（仓库本体无 JSON，提交走 issue）⑤ Awesome=raw README 解析 ⑥ skills.sh `GET skills.sh/api/search?q=` ⑦ SkillsMP `GET skillsmp.com/api/skills?q=` ⑧ 腾讯 SkillHub 定位为 skillhub.cloud.tencent.com（"专为中国用户优化的 AI Skills 社区"），API= `GET api.skillhub.tencent.com/api/skills?keyword=`（bundle 挖掘+实测 200）。所有 fixture 为真实响应存档 | 无头浏览器抓包 + curl 逐源验证，fixture 均为真实响应 | 依赖 headless 渲染的搜索页解析（运行时重、CI 不稳） |
| D9 | 2026-09-29 | 技能下载实现为 raw.githubusercontent.com 多候选路径（skills/<id>/SKILL.md、<id>/SKILL.md、SKILL.md × main/master），失败抛 NOT_FOUND；各技能市场无统一下载 API，raw 路径是三方技能包的事实标准 | 实测 skills.sh/SkillsMP/SkillHub 均回 GitHub 仓库引用 | npx skills CLI（需交互、不可编程清理） |
| D10 | 2026-09-29 | trust 证据分：全证据缺失时按保守 0.5（不奖不罚，由硬过滤兜底）；负值证据按缺失处理；来源档位：official=modelcontextprotocol/servers+skills.sh，curated=ModelScope/Cline/Awesome/腾讯SkillHub，aggregate=mcp.so/SkillsMP | 可解释、可测试 | 全缺失记 0（聚合源新条目被系统性压死） |
