import type { ZodType } from "zod";
import { EventEmitter } from "node:events";
import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { Capability } from "@/federation/types.js";
import type { BuildContext } from "@/orchestrator/context.js";

/**
 * 阶段五：三层验收体系。
 *  L1 组件级（5.1）：探活 + 输出 schema 校验 + 延迟记录
 *  L2 任务级（5.2）：规则校验 + LLM judge（闸门4 验收标准逐项打分，阈值可配）+ 合并裁定
 *  L3 泛化测试（5.3）：从槽位生成 ≥2 组换参输入真实执行 + 任务级验收，任一失败即不过
 *  报告（5.4）：三层汇总 → 归因到层与节点 → Memory + 闸门5
 */

// ── 5.1 组件级验收器 ──

export interface ComponentProbeResult {
  capabilityId: string;
  available: boolean;
  latencyMs: number;
  /** 输出 schema 校验（invoke 冒烟返回结构） */
  schemaOk: boolean;
  schemaError?: string;
  message?: string;
}

export interface ComponentAcceptanceDeps {
  probe: (cap: Capability) => Promise<{ available: boolean; latencyMs: number; message?: string }>;
  /** invoke 冒烟（远程优先）；返回 output 供 schema 校验 */
  smokeInvoke: (cap: Capability) => Promise<{ ok: boolean; output?: unknown; error?: string; latencyMs: number }>;
  outputSchema: ZodType<unknown>;
  timeoutMs?: number;
}

export class ComponentAcceptance {
  constructor(private deps: ComponentAcceptanceDeps) {}

  async check(cap: Capability): Promise<ComponentProbeResult> {
    const probe = await this.deps.probe(cap);
    if (!probe.available) {
      return { capabilityId: cap.id, available: false, latencyMs: probe.latencyMs, schemaOk: false, message: probe.message };
    }
    let smoke: Awaited<ReturnType<ComponentAcceptanceDeps["smokeInvoke"]>>;
    try {
      smoke = await Promise.race([
        this.deps.smokeInvoke(cap),
        new Promise<never>((_, reject) => setTimeout(() => reject(new ScenarioError({ code: ScenarioErrorCode.TIMEOUT, message: "component smoke timeout", phase: "verifying" })), this.deps.timeoutMs ?? 10_000)),
      ]);
    } catch (err) {
      return {
        capabilityId: cap.id,
        available: true,
        latencyMs: probe.latencyMs,
        schemaOk: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const parsed = this.deps.outputSchema.safeParse(smoke.output);
    return {
      capabilityId: cap.id,
      available: true,
      latencyMs: smoke.latencyMs,
      schemaOk: parsed.success,
      schemaError: parsed.success ? undefined : parsed.error.issues[0]?.message,
      message: smoke.error,
    };
  }
}

// ── 5.2 任务级验收器 ──

export interface TaskCriterion {
  id: string;
  description: string;
  /** 规则谓词（确定性）：输出 → 通过 */
  rule?: (output: unknown) => boolean;
  /** 需 LLM judge 的标准（模糊目标） */
  needsJudge: boolean;
}

export interface JudgeScore {
  criterionId: string;
  score: number; // 0..1
  reason: string;
}

export interface TaskAcceptanceDeps {
  judge?: (criterion: TaskCriterion, output: unknown) => Promise<JudgeScore>;
  /** judge 通过阈值（可配，默认 0.7） */
  judgeThreshold?: number;
}

export interface TaskVerdict {
  passed: boolean;
  ruleResults: Array<{ criterionId: string; passed: boolean }>;
  judgeScores: JudgeScore[];
  failedAt?: string;
}

export class TaskAcceptance {
  constructor(private deps: TaskAcceptanceDeps = {}) {}

  async check(output: unknown, criteria: TaskCriterion[]): Promise<TaskVerdict> {
    const ruleResults: TaskVerdict["ruleResults"] = [];
    const judgeScores: JudgeScore[] = [];
    const threshold = this.deps.judgeThreshold ?? 0.7;

    for (const c of criteria) {
      if (c.rule) {
        let passed = false;
        try {
          passed = c.rule(output);
        } catch {
          passed = false;
        }
        ruleResults.push({ criterionId: c.id, passed });
        if (!passed) {
          return { passed: false, ruleResults, judgeScores, failedAt: `rule:${c.id}` };
        }
      } else if (c.needsJudge) {
        if (!this.deps.judge) {
          // 无 judge（降级）：视为通过但记录——LLM 不可达时模板化降级路径
          judgeScores.push({ criterionId: c.id, score: 1, reason: "judge unavailable → degrade pass" });
          continue;
        }
        try {
          const s = await this.deps.judge(c, output);
          judgeScores.push(s);
          if (s.score < threshold) {
            return { passed: false, ruleResults, judgeScores, failedAt: `judge:${c.id}` };
          }
        } catch (err) {
          judgeScores.push({ criterionId: c.id, score: 0, reason: err instanceof Error ? err.message : "judge error" });
          return { passed: false, ruleResults, judgeScores, failedAt: `judge:${c.id}` };
        }
      }
    }
    return { passed: true, ruleResults, judgeScores };
  }
}

// ── 5.3 泛化测试器 ──

export interface SlotDef {
  name: string;
  /** 槽位模板：输出/输入中的占位（{{name}}） */
  examples: string[];
}

export interface GeneralizationDeps {
  /** 真实执行：换参输入 → 输出（执行底座管线） */
  run: (inputs: Record<string, string>) => Promise<{ ok: boolean; output?: unknown; error?: string }>;
  /** 任务级验收（复用 5.2） */
  taskAcceptance: TaskAcceptance;
  criteria: TaskCriterion[];
  variants?: number; // ≥2，默认 2
}

export interface GeneralizationVerdict {
  passed: boolean;
  attempts: Array<{ inputs: Record<string, string>; passed: boolean; error?: string }>;
  failedInputs?: Record<string, string>;
}

export class GeneralizationTester {
  constructor(private deps: GeneralizationDeps) {}

  /** 从槽位生成换参组：示例值轮换 + 规范化变体（截断/加后缀） */
  generateVariants(slots: SlotDef[], variants?: number): Array<Record<string, string>> {
    const n = Math.max(2, variants ?? this.deps.variants ?? 2);
    const out: Array<Record<string, string>> = [];
    for (let i = 0; i < n; i++) {
      const set: Record<string, string> = {};
      for (const slot of slots) {
        const ex = slot.examples[i % Math.max(1, slot.examples.length)] ?? slot.name;
        set[slot.name] = i < slot.examples.length ? ex : `${ex}-v${i}`;
      }
      out.push(set);
    }
    return out;
  }

  /** 过拟合检测：换参后任一组失败 → 门槛不过 */
  async check(slots: SlotDef[]): Promise<GeneralizationVerdict> {
    if (slots.length === 0) {
      throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "generalization requires ≥1 slot", phase: "verifying" });
    }
    const variants = this.generateVariants(slots);
    const attempts: GeneralizationVerdict["attempts"] = [];
    for (const inputs of variants) {
      let run: Awaited<ReturnType<GeneralizationDeps["run"]>>;
      try {
        run = await this.deps.run(inputs);
      } catch (err) {
        attempts.push({ inputs, passed: false, error: err instanceof Error ? err.message : String(err) });
        return { passed: false, attempts, failedInputs: inputs };
      }
      if (!run.ok) {
        attempts.push({ inputs, passed: false, error: run.error });
        return { passed: false, attempts, failedInputs: inputs };
      }
      const verdict = await this.deps.taskAcceptance.check(run.output, this.deps.criteria);
      attempts.push({ inputs, passed: verdict.passed, error: verdict.failedAt });
      if (!verdict.passed) {
        return { passed: false, attempts, failedInputs: inputs };
      }
    }
    return { passed: true, attempts };
  }
}

// ── 5.4 验收报告生成器 ──

export interface AcceptanceReport {
  buildId: string;
  at: string;
  component: {
    passed: boolean;
    results: ComponentProbeResult[];
    failedCapability?: string;
  };
  task: {
    passed: boolean;
    verdicts: Array<{ nodeId: string } & TaskVerdict>;
    failedNode?: string;
  };
  generalization: GeneralizationVerdict | { passed: false; skipped: true; reason: string };
  /** 归因摘要（面板/闸门5 直接消费） */
  attribution: string[];
  allPassed: boolean;
}

export class AcceptanceReporter {
  private readonly events = new EventEmitter();

  onReport(handler: (report: AcceptanceReport) => void): () => void {
    this.events.on("report", handler);
    return () => this.events.off("report", handler);
  }

  async build(params: {
    ctx: BuildContext;
    componentResults: ComponentProbeResult[];
    taskVerdicts: Array<{ nodeId: string } & TaskVerdict>;
    generalization: GeneralizationVerdict | { passed: false; skipped: true; reason: string };
  }): Promise<AcceptanceReport> {
    const failedComp = params.componentResults.find((r) => !r.available || !r.schemaOk);
    const failedTask = params.taskVerdicts.find((v) => !v.passed);
    const attribution: string[] = [];
    if (failedComp) {
      attribution.push(
        `L1 组件级失败: ${failedComp.capabilityId}${!failedComp.available ? "（不可达）" : ""}${!failedComp.schemaOk ? ` schema=${failedComp.schemaError ?? "invalid"}` : ""}`,
      );
    }
    if (failedTask) {
      const where = failedTask.failedAt ?? "unknown";
      attribution.push(`L2 任务级失败: 节点 ${failedTask.nodeId} @ ${where}`);
    }
    if (!params.generalization.passed) {
      if ("skipped" in params.generalization) {
        attribution.push(`L3 泛化测试跳过: ${params.generalization.reason}`);
      } else {
        attribution.push(`L3 泛化测试失败: 换参 ${JSON.stringify(params.generalization.failedInputs)}${params.generalization.attempts.at(-1)?.error ? ` @ ${params.generalization.attempts.at(-1)?.error}` : ""}`);
      }
    }
    if (attribution.length === 0) attribution.push("三层验收全部通过");
    const report: AcceptanceReport = {
      buildId: params.ctx.id,
      at: new Date().toISOString(),
      component: {
        passed: !failedComp,
        results: params.componentResults,
        failedCapability: failedComp?.capabilityId,
      },
      task: {
        passed: !failedTask,
        verdicts: params.taskVerdicts,
        failedNode: failedTask?.nodeId,
      },
      generalization: params.generalization,
      attribution,
      allPassed: !failedComp && !failedTask && params.generalization.passed,
    };
    this.events.emit("report", report);
    return report;
  }
}
