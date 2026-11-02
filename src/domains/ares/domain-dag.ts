import type { Intent } from "@/orchestrator/context.js";

/**
 * ARES 领域任务 DAG：竞赛材料生产链。
 * 依赖即"材料间数据引用"（BP 营收数字 → 三表 → PPT → 讲稿 → 评审全链同步）。
 * 按 pipeline 线定制节点（L1 创业线最全；算法线偏训练计划）。
 */

export function aresTemplateDag(intent: Intent): { nodes: Array<{ id: string; title: string; deps: string[]; expectedOutput: string }> } {
  const pipeline = (intent as { domain?: string }).domain ?? "L1";
  if (pipeline.startsWith("L6")) {
    // 算法线：训练为主
    return {
      nodes: [
        { id: "n1", title: "匹配赛事与题库定位", deps: [], expectedOutput: "赛事档案+训练目标" },
        { id: "n2", title: "生成训练计划与题单", deps: ["n1"], expectedOutput: "周计划+题库清单" },
        { id: "n3", title: "模板代码与专题讲义", deps: ["n2"], expectedOutput: "模板代码包" },
        { id: "n4", title: "模拟赛与复盘", deps: ["n3"], expectedOutput: "模拟赛记录" },
        { id: "n5", title: "质检与打包", deps: ["n4"], expectedOutput: "训练包交付" },
      ],
    };
  }
  if (pipeline.startsWith("L2")) {
    // 建模线
    return {
      nodes: [
        { id: "n1", title: "赛题理解与建模思路", deps: [], expectedOutput: "问题重述+模型选型" },
        { id: "n2", title: "论文正文与模型求解", deps: ["n1"], expectedOutput: "建模论文 docx" },
        { id: "n3", title: "求解代码与数据", deps: ["n2"], expectedOutput: "可复现代码包" },
        { id: "n4", title: "摘要页与承诺书核查", deps: ["n3"], expectedOutput: "提交清单" },
        { id: "n5", title: "模拟评审与打磨", deps: ["n4"], expectedOutput: "评审意见+修订" },
      ],
    };
  }
  // L1/L4/E 线：全套材料生产链（BP 勾稽为脊柱）
  return {
    nodes: [
      { id: "n1", title: "项目档案与赛事匹配", deps: [], expectedOutput: "project.json（项目/赛事/团队）" },
      { id: "n2", title: "商业计划书正文", deps: ["n1"], expectedOutput: "BP docx（含营收假设）" },
      { id: "n3", title: "财务三表勾稽生成", deps: ["n2"], expectedOutput: "三表 xlsx（勾稽校验通过）" },
      { id: "n4", title: "路演 PPT 程序化生成", deps: ["n2", "n3"], expectedOutput: "PPTX（数字与 BP 同步）" },
      { id: "n5", title: "多页 HTML 原型系统", deps: ["n1"], expectedOutput: "可交互原型" },
      { id: "n6", title: "讲稿与答辩预案", deps: ["n4"], expectedOutput: "分页讲稿+Q&A 预案" },
      { id: "n7", title: "模拟评审与一致性扫描", deps: ["n2", "n3", "n4", "n5", "n6"], expectedOutput: "评审报告+修订清单" },
    ],
  };
}

/** 赛事领域域名词表（parsing 后由 LLM/模板填 domain=pipeline） */
export function inferPipelineFromText(text: string): string {
  const t = text.toLowerCase();
  if (/蓝桥|acm|icpc|天梯|算法|程序设计/.test(t)) return "L6";
  if (/数学建模|数模|统计建模|美赛/.test(t)) return "L2";
  if (/电子设计|机械|智能车|机器人|嵌入式|物联网|节能/.test(t)) return "L3";
  if (/市场调查|商业案例|税收|金融科技|竞争模拟/.test(t)) return "L4";
  if (/广告|华灿|工业设计|艺术|建筑|数字艺术/.test(t)) return "L5";
  return "L1";
}
