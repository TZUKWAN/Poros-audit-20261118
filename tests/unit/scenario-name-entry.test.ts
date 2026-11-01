import { describe, expect, it } from "vitest";
import { scenarioNameFromRequirement } from "@/scenario/library";

describe("统一场景命名入口", () => {
  it("内核入口使用自然标题规则可识别重复需求", () => {
    expect(scenarioNameFromRequirement("请帮我整理 /data/play 的数据并生成简报", [])).toBe("整理 /data/play 的数据并生成简报");
    expect(scenarioNameFromRequirement("请帮我整理 /data/play 的数据并生成简报", ["整理 /data/play 的数据并生成简报"])).toBe("整理 /data/play 的数据并生成简报（2）");
  });
});
