import { describe, expect, it } from "vitest";
import { localDefinition, validateDefinition } from "@/scenario/definition";
import { ScenarioRecordSchema } from "@/scenario/library";

describe("真实场景定义", () => {
  it("保存完整操作步骤并诚实标记未执行", () => {
    for (const goal of ["整理数据生成周报", "经管实证论文可复现分析", "研究项目答辩准备", "翻译文章", "构建一个小说写作场景"]) {
      const definition = localDefinition(goal);
      expect(definition.instructions).toContain(goal);
      expect(definition.steps).toHaveLength(3);
      expect(definition.generatedBy).toBe("local");
      expect(definition.validation.execution).toBe("untested");
      expect(ScenarioRecordSchema.shape.definition.parse(definition)).toEqual(definition);
    }
  });
  it("拒绝环、未知依赖和重复输入/步骤", () => {
    const definition = localDefinition("翻译文章");
    expect(() => validateDefinition({ ...definition, steps: [{ ...definition.steps[0], deps: ["absent"] }] })).toThrow();
    expect(() => validateDefinition({ ...definition, steps: [{ ...definition.steps[0], deps: ["prepare"] }] })).toThrow();
    expect(() => validateDefinition({ ...definition, steps: [definition.steps[0], definition.steps[0]] })).toThrow();
    expect(() => validateDefinition({ ...definition, inputs: [definition.inputs[0], definition.inputs[0]] })).toThrow();
  });
});
