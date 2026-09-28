import { describe, expect, it } from "vitest";
import { PhaseSchema, ScenarioError, ScenarioErrorCode, toScenarioError } from "@/core/errors";

describe("ScenarioError 构造与字段", () => {
  it("携带 code/message/phase/context/cause", () => {
    const cause = new Error("boom");
    const err = new ScenarioError({
      code: ScenarioErrorCode.SOURCE_UNAVAILABLE,
      message: "mcp.so 不可达",
      phase: "retrieving",
      context: { source: "mcp.so" },
      cause,
    });
    expect(err.code).toBe(ScenarioErrorCode.SOURCE_UNAVAILABLE);
    expect(err.phase).toBe("retrieving");
    expect(err.context).toEqual({ source: "mcp.so" });
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("mcp.so 不可达");
    expect(err.name).toBe("ScenarioError");
  });

  it("context 缺省为空对象", () => {
    const err = new ScenarioError({ code: ScenarioErrorCode.UNKNOWN, message: "x", phase: "infra" });
    expect(err.context).toEqual({});
  });
});

describe("ScenarioError 序列化", () => {
  it("toJSON → fromJSON 往返保留字段", () => {
    const err = new ScenarioError({
      code: ScenarioErrorCode.ILLEGAL_TRANSITION,
      message: "parsing → executing 非法",
      phase: "parsing",
      context: { from: "parsing", to: "executing" },
    });
    const restored = ScenarioError.fromJSON(err.toJSON());
    expect(restored.code).toBe(ScenarioErrorCode.ILLEGAL_TRANSITION);
    expect(restored.message).toBe("parsing → executing 非法");
    expect(restored.phase).toBe("parsing");
    expect(restored.context).toEqual({ from: "parsing", to: "executing" });
  });

  it("cause 以 name: message 字符串保留，不携带堆栈", () => {
    const err = new ScenarioError({
      code: ScenarioErrorCode.INVOKE_FAILED,
      message: "调用失败",
      phase: "executing",
      cause: new TypeError("cannot read property"),
    });
    const json = err.toJSON();
    expect(json.cause).toBe("TypeError: cannot read property");
  });

  it("fromJSON 拒绝坏 payload 并归一化为 UNKNOWN", () => {
    const restored = ScenarioError.fromJSON({ nonsense: true });
    expect(restored.code).toBe(ScenarioErrorCode.UNKNOWN);
    const restored2 = ScenarioError.fromJSON("plain string");
    expect(restored2.code).toBe(ScenarioErrorCode.UNKNOWN);
  });
});

describe("toScenarioError 归一化", () => {
  it("ScenarioError 原样透传", () => {
    const original = new ScenarioError({ code: ScenarioErrorCode.TIMEOUT, message: "t", phase: "verifying" });
    expect(toScenarioError(original, "infra")).toBe(original);
  });

  it("Error 按消息分类：网络/超时/限流/JSON", () => {
    expect(toScenarioError(new Error("fetch failed for x"), "retrieving").code).toBe(ScenarioErrorCode.SOURCE_UNAVAILABLE);
    expect(toScenarioError(Object.assign(new Error("request ETIMEDOUT"), { name: "Error" }), "verifying").code).toBe(
      ScenarioErrorCode.TIMEOUT,
    );
    const abortLike = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(toScenarioError(abortLike, "executing").code).toBe(ScenarioErrorCode.CANCELLED);
    expect(toScenarioError(new Error("HTTP 429 too many requests"), "retrieving").code).toBe(ScenarioErrorCode.RATE_LIMITED);
    expect(toScenarioError(new Error("Unexpected token < in JSON"), "retrieving").code).toBe(ScenarioErrorCode.SOURCE_PARSE);
  });

  it("非 Error thrown 值字符串化保留", () => {
    const err = toScenarioError({ weird: 1 }, "planning");
    expect(err.code).toBe(ScenarioErrorCode.UNKNOWN);
    expect(err.message).toBe('{"weird":1}');
  });

  it("PhaseSchema 拒绝未知阶段", () => {
    expect(PhaseSchema.safeParse("parsing").success).toBe(true);
    expect(PhaseSchema.safeParse("not-a-phase").success).toBe(false);
  });
});
