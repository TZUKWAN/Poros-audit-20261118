/** Agent 目录 + Builder（审查项②③：NL 构建、配置差异、能力授权、测试、发布/回滚）。 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogClose,
  Input,
  Select,
  StatusBadge,
  Textarea,
} from "../ui.js";
import { RunEvents } from "./workspace.js";
import type { PersonalConnectionView } from "./integrations.js";

interface AgentRow {
  releaseReady: boolean;
  id: string;
  name: string;
  description: string;
  department: string;
  status: string;
  currentVersion: number;
  versions: Array<{ version: number; approvedAt: string | null }>;
  nlSource: string | null;
  draftConfig: Record<string, unknown>;
  grants: Array<{ id: string; kind: string; name: string; scopeNote: string; source: string }>;
}

export default function AgentsView({ role }: { role: string }) {
  const canBuild = role === "BUILDER" || role === "ADMIN";
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [nlOpen, setNlOpen] = useState(false);

  const refresh = useCallback(async () => {
    const r = await api<{ agents: AgentRow[] }>("GET", "/api/agents");
    if (r.ok) {
      setAgents(r.body.agents ?? []);
      if (!selected && r.body.agents?.length) setSelected(r.body.agents[0]!.id);
    }
  }, [selected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const agent = agents.find((a) => a.id === selected);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Agent 目录（{agents.length}）</span>
          {canBuild && <Button onClick={() => setNlOpen(true)}>新建 Agent</Button>}
        </div>
        <div className="mt-3 grid gap-2">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => setSelected(a.id)}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                a.id === selected
                  ? "border-[#c9694b] bg-[#fdf7f4]"
                  : "border-[#e3e1dc] bg-white hover:bg-[#faf9f7]"
              }`}
            >
              <span className="font-medium">{a.name}</span>
              <Badge tone={a.releaseReady ? "ok" : "neutral"}>
                {a.releaseReady
                  ? `已审批 v${a.currentVersion}`
                  : a.currentVersion
                    ? "旧版需重新审批"
                    : "草稿"}
              </Badge>
              {a.nlSource && <Badge tone="brand">NL</Badge>}
              <span className="truncate text-xs text-[#8a8880]">{a.description}</span>
            </button>
          ))}
          {!agents.length && (
            <p className="text-sm text-[#a5a29b]">
              暂无 Agent{canBuild ? "，点击右上角创建" : ""}。
            </p>
          )}
        </div>
      </Card>

      {agent && canBuild && <BuilderPanel key={agent.id} agent={agent} onChanged={refresh} />}
      {nlOpen && (
        <NlCreateDialog
          onClose={() => setNlOpen(false)}
          onCreated={(id) => {
            setNlOpen(false);
            setSelected(id);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/** 自然语言 → 结构化草稿（审查项②）：LLM 生成、nlSource 留痕、能力默认空（授权表管理）。 */
function NlCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    const r = await api<{ agent: { id: string } }>(
      "POST",
      "/api/agents/drafts",
      manual ? { name, config: { persona: description } } : { description },
      {},
      65000,
    );
    setBusy(false);
    if (!r.ok) setError(r.body.error ?? `HTTP ${r.status}`);
    else onCreated(r.body.agent.id);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="新建 Agent">
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />{" "}
        手动填写
      </label>
      {manual && (
        <label className="mb-2 grid gap-1 text-sm">
          Agent 名称
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      )}
      <Textarea
        rows={4}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="例：创建一个能在容器内执行命令并汇报输出的运维检查 Agent"
      />
      {error && <p className="mt-2 text-sm text-[#a1301c]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <DialogClose asChild>
          <Button variant="ghost">取消</Button>
        </DialogClose>
        <Button
          disabled={busy || (manual ? !name.trim() : description.trim().length < 4)}
          onClick={create}
        >
          {busy ? "处理中…" : manual ? "创建草稿" : "生成草稿"}
        </Button>
      </div>
    </Dialog>
  );
}

const GRANT_KINDS = ["TOOL", "MODEL"] as const;
const TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "working_directory",
  "web.fetch",
  "web.search",
];

/** Builder 面板：配置差异 / 能力授权 / 草稿测试 / 发布 / 回滚（审查项②③全链路）。 */
function BuilderPanel({ agent, onChanged }: { agent: AgentRow; onChanged: () => void }) {
  const [grants, setGrants] = useState(agent.grants ?? []);
  const [grantKind, setGrantKind] = useState<(typeof GRANT_KINDS)[number]>("TOOL");
  const [grantName, setGrantName] = useState("bash");
  const [grantNote, setGrantNote] = useState("");
  const [personal, setPersonal] = useState<PersonalConnectionView>();
  const [testPrompt, setTestPrompt] = useState("");
  const [testResult, setTestResult] = useState<{
    status: string;
    runtime: string;
    taskId: string;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [draftText, setDraftText] = useState(JSON.stringify(agent.draftConfig, null, 2));
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  useEffect(() => {
    void api<{ connections: PersonalConnectionView[] }>("GET", "/api/settings/integrations").then(
      (response) => {
        if (response.ok)
          setPersonal(
            response.body.connections.find((connection) => connection.provider === "model"),
          );
      },
    );
  }, []);

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-medium">Builder · {agent.name}</span>
        <Badge tone={agent.status === "PUBLISHED" ? "ok" : "neutral"}>{agent.status}</Badge>
        {agent.nlSource && <Badge tone="brand">NL 构建来源已留痕</Badge>}
      </div>

      {/* 配置（草稿）——NL 生成的 persona 等结构化字段直接可见 */}
      <div className="rounded-lg bg-[#faf9f7] p-3 text-xs">
        <p className="mb-1 font-medium text-[#5c5a55]">草稿配置（当前 diff 基线）</p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[#1f1f1e]">
          {JSON.stringify(agent.draftConfig, null, 2)}
        </pre>
        <Textarea
          aria-label="草稿配置 JSON"
          rows={5}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
        />
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              const config = JSON.parse(draftText) as Record<string, unknown>;
              const r = await api("PATCH", `/api/agents/${agent.id}/draft`, { config });
              setMsg(
                r.ok
                  ? { tone: "ok", text: "草稿已保存，已发布版本保持冻结" }
                  : { tone: "bad", text: r.body.error ?? "保存失败" },
              );
              onChanged();
            } catch {
              setMsg({ tone: "bad", text: "请输入有效配置 JSON" });
            }
          }}
        >
          保存草稿
        </Button>
        <p className="mt-1 text-[#8a8880]">描述：{agent.description}</p>
      </div>

      {/* 能力授权（审查项③：默认拒绝，逐项批准 + scopeNote） */}
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium">
          能力授权（每次工具执行前检查；发布时冻结授权与来源）
        </p>
        <div className="mb-2 flex flex-wrap gap-2">
          {grants.map((g) => (
            <div key={g.id} className="flex min-w-0 items-center gap-1">
              <Badge tone="brand">
                {g.kind}:{g.name}
              </Badge>
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                aria-label={"撤销草稿授权 " + g.name}
                onClick={async () => {
                  setBusy("revoke");
                  const result = await api("DELETE", "/api/agents/" + agent.id + "/grants/" + g.id);
                  if (result.ok) {
                    setGrants((all) => all.filter((grant) => grant.id !== g.id));
                    onChanged();
                  } else setMsg({ tone: "bad", text: result.body.error ?? "撤销失败" });
                  setBusy("");
                }}
              >
                撤销
              </Button>
            </div>
          ))}
          {!grants.length && (
            <span className="text-xs text-[#a5a29b]">未授予任何能力（Agent 只能对话）。</span>
          )}
        </div>
        <p className="mt-2 text-xs">
          模型授权会记录模型名与端点。运行个人模型时，任务发起人需要在设置中验证同一个端点和模型。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={grantKind}
            onChange={(e) => {
              setGrantKind(e.target.value as (typeof GRANT_KINDS)[number]);
              setGrantName(
                e.target.value === "MODEL" ? (personal ? "personal" : "builtin") : "bash",
              );
            }}
          >
            {GRANT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          {grantKind === "TOOL" ? (
            <Select value={grantName} onChange={(e) => setGrantName(e.target.value)}>
              {TOOL_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          ) : (
            <Select
              aria-label="模型连接"
              value={grantName}
              onChange={(e) => setGrantName(e.target.value)}
            >
              {personal?.settings.model && (
                <option value="personal">个人模型 · {personal.settings.model}</option>
              )}
              <option value="builtin">部署模型 · deepseek-chat</option>
            </Select>
          )}
          <Input
            className="w-56"
            value={grantNote}
            onChange={(e) => setGrantNote(e.target.value)}
            placeholder="授权范围说明（必填留痕）"
          />
          <Button
            variant="ghost"
            disabled={
              Boolean(busy) ||
              (grantKind === "MODEL" && grantName === "personal" && !personal?.settings.baseUrl) ||
              !grantNote.trim()
            }
            onClick={async () => {
              setBusy("grant");
              const custom =
                grantKind === "MODEL" && grantName === "personal" ? personal?.settings : undefined;
              const name = grantKind === "MODEL" ? (custom?.model ?? "deepseek-chat") : grantName;
              const r = await api(`POST`, `/api/agents/${agent.id}/grants`, {
                kind: grantKind,
                name,
                ...(custom ? { source: "personal-openai-compatible:" + custom.baseUrl } : {}),
                scopeNote: grantNote,
              });
              setBusy("");
              if (r.ok) {
                setMsg({ tone: "ok", text: `已授权 ${grantKind}:${name}` });
                setGrantNote("");
                const fresh = await api<{ agents: AgentRow[] }>("GET", "/api/agents");
                const me = fresh.ok
                  ? (fresh.body.agents ?? []).find((a) => a.id === agent.id)
                  : undefined;
                if (me) setGrants(me.grants ?? []);
                onChanged();
              } else setMsg({ tone: "bad", text: r.body.error ?? `HTTP ${r.status}` });
            }}
          >
            授权
          </Button>
        </div>
      </div>

      {/* 草稿测试 + 发布/回滚 */}
      <div className="mt-4 flex flex-wrap items-start gap-2">
        <label className="w-full text-xs">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{" "}
          同意本次草稿测试使用已列出的敏感工具；提交后仍需独立审批
        </label>
        <Textarea
          rows={2}
          className="w-full sm:w-96"
          value={testPrompt}
          onChange={(e) => setTestPrompt(e.target.value)}
          placeholder="草稿测试提示词（真实执行，不产生版本）"
        />
        <Button
          variant="ghost"
          disabled={busy === "test" || !testPrompt.trim()}
          onClick={async () => {
            setBusy("test");
            const r = await api<{ status: string; runtime: string; taskId: string }>(
              "POST",
              `/api/agents/${agent.id}/test-runs`,
              {
                prompt: testPrompt,
                consent: consent ? grants.filter((g) => g.kind === "TOOL").map((g) => g.name) : [],
              },
            );
            setBusy("");
            if (r.ok)
              setTestResult({
                status: r.body.status,
                runtime: r.body.runtime,
                taskId: r.body.taskId,
              });
            else setMsg({ tone: "bad", text: r.body.error ?? `HTTP ${r.status}` });
          }}
        >
          {busy === "test" ? "测试中…" : "草稿测试"}
        </Button>
        {testResult && (
          <span className="flex items-center gap-1 text-xs text-[#8a8880]">
            <Badge tone="brand">{testResult.runtime}</Badge>
            <StatusBadge status={testResult.status} />
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            disabled={busy === "publish"}
            onClick={async () => {
              setBusy("publish");
              const r = await api<{ version: number }>("POST", `/api/agents/${agent.id}/publish`);
              setBusy("");
              setMsg(
                r.ok
                  ? {
                      tone: "ok",
                      text: `v${r.body.version} 已冻结并提交审批，请独立审阅者到「审批与规则」决定`,
                    }
                  : { tone: "bad", text: r.body.error ?? `HTTP ${r.status}` },
              );
              onChanged();
            }}
          >
            {busy === "publish" ? "提交中…" : "申请发布"}
          </Button>
          {agent.currentVersion > 1 && (
            <Button
              variant="ghost"
              disabled={busy === "rollback"}
              onClick={async () => {
                setBusy("rollback");
                const target = agent.versions
                  .filter((v) => v.approvedAt && v.version < agent.currentVersion)
                  .sort((a, b) => b.version - a.version)[0]?.version;
                if (!target) {
                  setBusy("");
                  setMsg({ tone: "bad", text: "没有可回滚的已审批版本" });
                  return;
                }
                const r = await api("POST", `/api/agents/${agent.id}/rollback`, {
                  version: target,
                });
                setBusy("");
                setMsg(
                  r.ok
                    ? { tone: "ok", text: `已回滚到 v${agent.currentVersion - 1}` }
                    : { tone: "bad", text: r.body.error ?? `HTTP ${r.status}` },
                );
                onChanged();
              }}
            >
              回滚上一版
            </Button>
          )}
        </div>
      </div>

      {msg && (
        <p className={`mt-3 text-sm ${msg.tone === "ok" ? "text-[#256b3a]" : "text-[#a1301c]"}`}>
          {msg.text}
        </p>
      )}
      {testResult && <RunEvents taskId={testResult.taskId} />}
    </Card>
  );
}
