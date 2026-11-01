import { ScenarioError, ScenarioErrorCode } from "@/core/errors.js";
import type { Dag, TaskNode } from "./context.js";

/** 2.3.2 拓扑排序 + 环检测 */
export function topoSort(dag: Dag): TaskNode[] {
  if (dag.nodes.length === 0) {
    throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "DAG must contain at least one node", phase: "planning" });
  }
  const ids = dag.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) {
    throw new ScenarioError({ code: ScenarioErrorCode.VALIDATION, message: "DAG node ids must be unique", phase: "planning" });
  }
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  for (const n of dag.nodes) {
    for (const dep of n.deps) {
      if (!byId.has(dep)) {
        throw new ScenarioError({
          code: ScenarioErrorCode.VALIDATION,
          message: `node ${n.id} depends on unknown node ${dep}`,
          phase: "planning",
        });
      }
    }
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of dag.nodes) {
    indegree.set(n.id, n.deps.length);
    for (const dep of n.deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), n.id]);
    }
  }
  const queue = dag.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: TaskNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (node) out.push(node);
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (out.length !== dag.nodes.length) {
    const cycleNodes = dag.nodes.filter((n) => !out.includes(n)).map((n) => n.id);
    throw new ScenarioError({
      code: ScenarioErrorCode.VALIDATION,
      message: `dependency cycle detected among: ${cycleNodes.join(", ")}`,
      phase: "planning",
      context: { cycleNodes },
    });
  }
  return out;
}

/** 2.3.2 并行分组：同层可并行节点（执行底座分组委派依据） */
export function parallelGroups(dag: Dag): string[][] {
  const sorted = topoSort(dag);
  const depth = new Map<string, number>();
  for (const n of sorted) {
    depth.set(n.id, n.deps.length === 0 ? 0 : Math.max(...n.deps.map((d) => (depth.get(d) ?? 0) + 1)));
  }
  const groups = new Map<number, string[]>();
  for (const [id, d] of depth) {
    groups.set(d, [...(groups.get(d) ?? []), id]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
}
