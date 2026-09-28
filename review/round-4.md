# R4 干净环境重建报告 (2026-09-29)

## R4.1 全新目录 clone → 安装 → 构建 → 全部测试
```
git clone <本地仓库> /tmp/r4-clone
npm install      # OK
npm run build    # tsc 退出码 0
npm test         # 30 文件 / 331 用例全绿（含全部 e2e 与真实网络 smoke）
```
- 验证了 README 安装说明与 package-lock 完备；pi-package/dist 经 `pretest`（npm run bundle）自动产出
- 首轮 `npm test` 曾出现 1 例 bundle 时序失败（pretest 产物就绪竞态），手动 `npm run bundle` 后复跑全绿；此后连续多轮稳定

## R4.2 删除 ~/.pi/scenario 冷启动
- 删除数据根后，经生产内核入口（pi-package/dist/kernel.js → runScenario）跑需求A全闭环：
  - 真实 8 源联邦检索（live 网络：命中 awesome-mcp-servers / skills.sh 真实能力）
  - 五闸门全部决策（approvals=5）
  - phase=done；数据根重建出 registry-cache.json
- 结论：**冷启动全闭环通过**
