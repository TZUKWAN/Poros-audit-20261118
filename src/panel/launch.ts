import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { scenarioDataRoot, jsonStore } from "@/core/store.js";
import { ScenarioLibrary, recordFromDistilled } from "@/scenario/library.js";
import { distill } from "@/distill/distill.js";
import { createOrchestrator } from "@/orchestrator/runner.js";
import { memoryBuildStore } from "@/orchestrator/build-store.js";
import { CapabilityInvoker } from "@/execution/capability-runtime.js";
import { RunController } from "@/execution/repair.js";
import { federatedSearchFactory } from "@/federation/factory.js";
import { PanelServer, defaultPageHtml } from "@/panel/server.js";
import { sessionMemoryMd, memoryPaths } from "@/memory/memory.js";
import type { Orchestrator } from "@/orchestrator/state-machine.js";
import type { BuildContext } from "@/orchestrator/context.js";
import type { Capability } from "@/federation/types.js";

/**
 * 面板启动器（play 模式）：
 *  - 真实 8 源联邦检索 + 真实能力调用尝试（6s 超时）+ 模拟兜底（output.simulated=true 标注）
 *  - 五闸门由用户在网页上批准/驳回（无虚拟用户）
 *  - done 后蒸馏固化场景 + 写会话 Memory（右侧面板立即可见）
 */

const PORT = Number(process.env.PANEL_PORT ?? 4310);
const INVOKE_TIMEOUT_MS = 6_000;

async function main(): Promise<void> {
  const dataRoot = scenarioDataRoot();
  const memoryRoot = path.join(dataRoot, "memory");
  for (const p of [memoryRoot, memoryPaths(memoryRoot).sessions, memoryPaths(memoryRoot).scenarios, memoryPaths(memoryRoot).knowledge]) {
    await mkdir(p, { recursive: true });
  }
  const library = new ScenarioLibrary({
    store: jsonStore({ filePath: path.join(dataRoot, "scenarios.json"), schema: z.unknown() }),
  });
  const controller = new RunController();
  const search = await federatedSearchFactory();
  const invoker = new CapabilityInvoker();

  let current: Orchestrator | undefined;
  let currentDone = true;

  const panel = new PanelServer({
    library,
    controller,
    memoryRoot,
    pageHtml: defaultPageHtml(),
    onStartBuild: async (requirement) => {
      if (!currentDone && current) {
        panel.pushChat({
          role: "build-status", tone: "err",
          text: `已有构建进行中（${current.ctx.id}，阶段 ${current.ctx.phase}）——先完成它（可驳回或等待）`, ts: Date.now(),
        });
        return { ok: false, error: "build in progress" };
      }
      // 用户消息回显（服务端权威，重连可恢复）
      panel.pushChat({ role: "user", content: requirement, timestamp: Date.now() });
      panel.pushChat({
        role: "build-status", tone: "info",
        text: "好，开始构建。第一步：8 源联邦检索（skills.sh / SkillsMP / 腾讯SkillHub / ModelScope / Cline / Awesome / mcp.so / 官方servers）……首次约需 30-60 秒",
        ts: Date.now(),
      });
      // 一次真实联邦检索供本构建全部节点共用（模板 DAG 三节点查询同源；24h 缓存兜底）
      const baseResult = await search(requirement, 5);
      const bySource = new Map<string, number>();
      for (const s of baseResult.statuses) {
        if (s.ok && s.count > 0) bySource.set(s.source, s.count);
      }
      const hitText = baseResult.capabilities.length
        ? `命中 ${baseResult.capabilities.length} 个候选：${baseResult.capabilities.slice(0, 3).map((c) => c.name).join("、")}${baseResult.capabilities.length > 3 ? " 等" : ""}（来源：${[...bySource.entries()].map(([s, n]) => `${s}×${n}`).join("、") || "无"}）`
        : "本次检索未命中候选，将使用模板流程继续";
      panel.pushChat({ role: "build-status", tone: baseResult.capabilities.length ? "ok" : "info", text: hitText, ts: Date.now() });

      // play 模式执行器：跳过安装/克隆，直接真实调用（6s 超时）+ 模拟兜底（诚实标注 simulated）
      const demoExecute = async (ctx: BuildContext): Promise<void> => {
        if (!ctx.assembly) {
          throw new Error("executing without assembly");
        }
        const assembly = ctx.assembly as { nodes: Array<{ nodeId: string; capabilityId: string }> };
        const sets = ctx.candidates as Array<{ nodeId: string; candidates: Capability[] }>;
        const capOf = (capabilityId: string): Capability | undefined => {
          for (const s of sets) {
            const hit = s.candidates.find((c) => c.id === capabilityId);
            if (hit) return hit;
          }
          return undefined;
        };
        for (const node of assembly.nodes) {
          await controller.checkpoint();
          const cap = capOf(node.capabilityId);
          const startedAt = new Date().toISOString();
          if (!cap) {
            ctx.trace.push({ nodeId: node.nodeId, startedAt, finishedAt: new Date().toISOString(), status: "skipped" });
            continue;
          }
          const action = cap.name.replace(/\s+/g, "-").toLowerCase();
          // 技能知识：零网络，直接用描述注入（raw 下载对非 GitHub 源会重试拖慢 play 节奏）
          const result =
            cap.kind === "skill-knowledge" || cap.install.type === "context"
              ? { ok: true, output: { mode: "context-injection", capability: cap.id, content: cap.description }, latencyMs: 0 }
              : await invoker.invoke(cap, action, { requirement }, { timeoutMs: INVOKE_TIMEOUT_MS });
          ctx.trace.push({
            nodeId: node.nodeId,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "success",
            capabilityId: cap.id,
            output: result.ok
              ? { mode: "real-invoke", result: result.output }
              : { simulated: true, attempted: cap.id, reason: result.error ?? "unreachable" },
          });
        }
        ctx.acceptance.push({
          layer: "task",
          passed: true,
          detail: { mode: "play", nodes: assembly.nodes.length },
          at: new Date().toISOString(),
        });
      };

      const orch = createOrchestrator({
        handlerDeps: {
          search: async () => baseResult,
          execute: demoExecute,
        },
        store: memoryBuildStore(),
      });
      panel.attachOrchestrator(orch);
      current = orch;
      currentDone = false;
      const buildId = `panel-${Date.now()}`;
      orch.start(requirement, buildId);
      void orch
        .run()
        .then(async (final) => {
          // 固化 + Memory
          const distilled = await distill(final);
          const id = `sc-${buildId}`;
          await library.save(
            recordFromDistilled({
              id,
              name: requirement.slice(0, 24),
              ctx: final,
              distilled,
              capabilityIds: [...new Set(final.selections.map((s) => s.capabilityId))],
            }),
          );
          await writeFile(
            path.join(memoryPaths(memoryRoot).sessions, `${final.id}.md`),
            sessionMemoryMd(final),
            "utf8",
          );
          panel.pushChat({
            role: "build-status", tone: "ok",
            text: `构建完成 ✓ 场景已固化为 ${id}（v1），会话已写入 Memory。右栏可以看到它；下次说相似的需求会直接命中复用。`,
            ts: Date.now(),
          });
          await panel.refresh();
        })
        .catch(async (err: unknown) => {
          panel.pushChat({
            role: "build-status", tone: "err",
            text: `构建失败：${err instanceof Error ? err.message : String(err)}。可以直接输入新需求重试。`,
            ts: Date.now(),
          });
          await panel.refresh();
        })
        .finally(() => {
          currentDone = true;
        });
      return { ok: true };
    },
  });

  const port = await panel.start(PORT);
  const banner = [
    "",
    "┌──────────────────────────────────────────────┐",
    "│  场景Agent 面板已启动                        │",
    `│  打开  http://127.0.0.1:${port}             │`,
    "│  输入需求 → 在页面上过五道闸门              │",
    "│  Ctrl+C 停止                                 │",
    "└──────────────────────────────────────────────┘",
    "",
  ].join("\n");
  process.stdout.write(`${banner}\n`);
}

void main().catch((err) => {
  console.error("launcher failed:", err);
  process.exit(1);
});
