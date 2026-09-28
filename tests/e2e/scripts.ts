import path from "node:path";
import { GoalLoop } from "@/execution/loop.js";

/**
 * 9.1 演示脚本定义：可重放 e2e 的输入与策略（虚拟用户驱动，无人干预）。
 */

export interface DemoSpec {
  id: string;
  requirement: string;
  domain: string;
  keywords: string[];
}

export const DEMO_REQUIREMENTS: Record<string, DemoSpec> = {
  repoDigest: {
    id: "demo-repo-digest",
    requirement: "整理 /data/repo 下的仓库提交记录并生成周报",
    domain: "dev-workflow",
    keywords: ["仓库", "周报", "整理"],
  },
  dataReport: {
    id: "demo-data-report",
    requirement: "整理 /data/repo 的仓库数据并生成周报统计",
    domain: "dev-workflow",
    keywords: ["仓库", "周报", "整理"],
  },
};

export const DEMO_GOAL = {
  id: "demo-goal-loop",
  goal: "两轮内让覆盖率达标",
  maxRounds: 4,
};

export { GoalLoop };

export function e2eArtifactPath(dir: string, name: string): string {
  return path.join(dir, name);
}
