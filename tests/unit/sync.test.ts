import { describe, expect, it } from "vitest";
import { planSync } from "@/product/sync";

describe("工作区同步冲突计划", () => {
  it("保留本地和远端同时修改的冲突，不静默覆盖", () => {
    const base = [{ id: "p1", updatedAt: "2026-10-03T00:00:00.000Z" }];
    const local = [{ id: "p1", updatedAt: "2026-10-03T00:01:00.000Z" }];
    const remote = [{ id: "p1", updatedAt: "2026-10-03T00:02:00.000Z" }, { id: "p2", updatedAt: "2026-10-03T00:02:00.000Z" }];
    const plan = planSync(local, remote, base);
    expect(plan.conflicts).toEqual(["p1"]);
    expect(plan.create).toEqual(["p2"]);
  });
});

