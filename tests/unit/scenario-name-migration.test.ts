import { describe, expect, it } from "vitest";
import { migratedScenarioName, scenarioNameFromRequirement } from "@/scenario/library";

describe("场景名称迁移规则", () => {
  it("为历史重复名称生成可识别的后缀", () => {
    const used = ["建立一个本地论文写作研究场景"];
    expect(scenarioNameFromRequirement("建立一个本地论文写作研究场景", used)).toBe("建立一个本地论文写作研究场景（2）");
  });

  it("规范化旧版本把完整需求直接当标题的名称", () => {
    expect(migratedScenarioName("我要参加中国国际大学生创新大赛，项目是毫米波雷达", "我要参加中国国际大学生创新大赛，项目是毫米波雷达", [])).toBe("参加中国国际大学生创新大赛，项目是毫米波雷达");
    expect(migratedScenarioName("我的自定义场景", "我要整理一份数据", [])).toBe("我的自定义场景");
  });
});
