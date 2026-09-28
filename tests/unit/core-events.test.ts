import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@/core/events";

type TestEvents = {
  "state:enter": { from: string; to: string };
  "gate:decision": { gate: string; approved: boolean };
  count: number;
};

function makeBus() {
  return createEventBus<TestEvents>();
}

describe("事件总线 发布/订阅", () => {
  it("emit → on 收到 typed 载荷", () => {
    const bus = makeBus();
    const got: unknown[] = [];
    bus.on("state:enter", (d) => {
      got.push(d);
    });
    bus.emit("state:enter", { from: "parsing", to: "planning" });
    expect(got).toEqual([{ from: "parsing", to: "planning" }]);
  });

  it("退订后不再接收", () => {
    const bus = makeBus();
    const fn = vi.fn();
    const off = bus.on("count", fn);
    bus.emit("count", 1);
    off();
    bus.emit("count", 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("once 只触发一次", () => {
    const bus = makeBus();
    const fn = vi.fn();
    bus.once("count", fn);
    bus.emit("count", 1);
    bus.emit("count", 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("通配订阅收到 [channel, data]", () => {
    const bus = makeBus();
    const got: Array<[string, unknown]> = [];
    bus.onAny((pair) => {
      got.push(pair);
    });
    bus.emit("count", 7);
    bus.emit("gate:decision", { gate: "g3", approved: true });
    expect(got).toEqual([
      ["count", 7],
      ["gate:decision", { gate: "g3", approved: true }],
    ]);
  });

  it("异常订阅者不阻塞其他订阅者", () => {
    const bus = makeBus();
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const good = vi.fn();
    bus.on("count", () => {
      throw new Error("bad subscriber");
    });
    bus.on("count", good);
    expect(() => bus.emit("count", 1)).not.toThrow();
    expect(good).toHaveBeenCalledWith(1);
    errSpy.mockRestore();
  });

  it("listenerCount 统计与 clear 清空", () => {
    const bus = makeBus();
    const o1 = bus.on("count", () => {});
    const o2 = bus.on("count", () => {});
    bus.onAny(() => {});
    expect(bus.listenerCount("count")).toBe(2);
    o1();
    expect(bus.listenerCount("count")).toBe(1);
    o2();
    bus.clear();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe("waitFor", () => {
  it("谓词满足时 resolve", async () => {
    const bus = makeBus();
    const p = bus.waitFor("gate:decision", (d) => d.gate === "g3", 500);
    setTimeout(() => {
      bus.emit("gate:decision", { gate: "g1", approved: false });
      bus.emit("gate:decision", { gate: "g3", approved: true });
    }, 5);
    await expect(p).resolves.toEqual({ gate: "g3", approved: true });
  });

  it("超时 reject 且不再挂监听", async () => {
    const bus = makeBus();
    const p = bus.waitFor("count", undefined, 30);
    await expect(p).rejects.toThrow(/timed out/);
    expect(bus.listenerCount("count")).toBe(0);
  });
});
