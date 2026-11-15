import { describe, expect, it } from "vitest";
import { mkdtemp, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureTeamLedger,
  readTeamConstraints,
  resolveConstraints,
  writeTeamConstraints,
} from "@/scenario/team-ledger";
import type { Constraint } from "@/scenario/ledger";

function makeConstraint(id: string, clause: string, layer: "scenario" | "team" = "scenario", active = true): Constraint {
  return {
    id,
    clause,
    scope: "output",
    kind: "advisory",
    pattern: null,
    origin: { type: "reject", text: clause, at: "2026-11-15T00:00:00.000Z", runId: null },
    confirmedAt: "2026-11-15T00:00:00.000Z",
    hits: 0,
    active,
    supersededBy: null,
    layer,
  };
}

describe("两角色模型 §4 团队层账本", () => {
  it("幂等初始化：无文件 → 创建空壳；有文件 → 不动", () => {
    const dir = path.join(tmpdir(), `team-ledger-${Date.now()}`);
    try {
      ensureTeamLedger(dir);
      expect(existsSync(path.join(dir, "team-ledger.json"))).toBe(true);
      const before = readFileSync(path.join(dir, "team-ledger.json"), "utf8");
      ensureTeamLedger(dir);
      expect(readFileSync(path.join(dir, "team-ledger.json"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写入 → 读取 round-trip；layer 统一标记为 team", () => {
    const dir = path.join(tmpdir(), `team-ledger-w-${Date.now()}`);
    try {
      ensureTeamLedger(dir);
      writeTeamConstraints(dir, [makeConstraint("c1", "行动项带负责人", "scenario")]);
      const read = readTeamConstraints(dir);
      expect(read).toHaveLength(1);
      expect(read[0]!.clause).toBe("行动项带负责人");
      expect(read[0]!.layer).toBe("team");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不存在的文件 → 空数组（不抛错）", () => {
    const dir = path.join(tmpdir(), `team-ledger-empty-${Date.now()}`);
    expect(readTeamConstraints(dir)).toEqual([]);
  });

  it("退役条款不返回（active 过滤）", () => {
    const dir = path.join(tmpdir(), `team-ledger-r-${Date.now()}`);
    try {
      ensureTeamLedger(dir);
      writeTeamConstraints(dir, [makeConstraint("c1", "旧条款", "team", false), makeConstraint("c2", "活条款", "team")]);
      expect(readTeamConstraints(dir).map((c) => c.id)).toEqual(["c2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("损坏的 JSON → 空数组（静默降级）", () => {
    const dir = path.join(tmpdir(), `team-ledger-corrupt-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "team-ledger.json"), "{ broken !!");
    expect(readTeamConstraints(dir)).toEqual([]);
  });
});

describe("两角色模型 §4.2 合并解析：场景层覆盖团队层", () => {
  it("同 clauseKey → 场景层胜出，团队层被跳过", () => {
    const scenario = [makeConstraint("s1", "行动项带负责人和截止日", "scenario")];
    const team = [makeConstraint("t1", "行动项带负责人和截止日", "team"), makeConstraint("t2", "日期用YYYY-MM-DD", "team")];
    const resolved = resolveConstraints(scenario, team);
    expect(resolved).toHaveLength(2); // s1 + t2（t1 被 s1 覆盖）
    expect(resolved.find((c) => c.id === "s1")!.fromTeam).toBe(false);
    expect(resolved.find((c) => c.id === "t2")!.fromTeam).toBe(true);
    expect(resolved.find((c) => c.id === "t1")).toBeUndefined();
  });

  it("无冲突 → 两层并存", () => {
    const scenario = [makeConstraint("s1", "场景层条款", "scenario")];
    const team = [makeConstraint("t1", "团队层条款", "team")];
    const resolved = resolveConstraints(scenario, team);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((c) => c.fromTeam !== undefined)).toBe(true);
  });
});
