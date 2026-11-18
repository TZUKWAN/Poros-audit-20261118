import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { dateTime, type Agent, type Manifest, type Project } from "../pc.js";
import { Badge, Button, Card, Dialog, Field, PageHeading, Select, Textarea } from "../ui.js";
import { ManifestSummary } from "./agents.js";
import { RuleInput } from "./correction.js";
import { Confirm } from "./projects.js";

type Approval = {
  id: string;
  kind: string;
  subjectId: string;
  requestedBy: string;
  decision: string;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  payload: {
    manifest?: Manifest;
    version?: number;
    taskId?: string;
    tools?: string[];
    rule?: string;
    scopeType?: string;
    scopeId?: string;
    sourceRunId?: string;
    sourceFeedback?: string;
    impactedAgents?: Array<{ id: string; name: string }>;
    conflicts?: string[];
  };
};
type Rule = {
  id: string;
  rule: string;
  kind: string;
  version: number;
  status: string;
  scopeType: string;
  scopeId: string;
  sourceRunId: string;
  sourceFeedback: string;
  disabledAt: string | null;
  disabledBy: string | null;
  previousId: string | null;
  applications: Array<{
    id: string;
    evaluation: string;
    failureReason: string;
    ruleVersion: number;
  }>;
};
const approvalLabel: Record<string, string> = {
  AGENT_PUBLISH: "Agent 发布",
  DANGEROUS_OPERATION: "敏感操作授权",
  JUDGMENT_RULE: "Judgment 规则",
};
const stateLabel: Record<string, string> = {
  PENDING: "待审批",
  APPROVED: "已批准",
  REJECTED: "已拒绝",
  WITHDRAWN: "已撤回",
  CANDIDATE: "候选",
  DISABLED: "已停用",
  SUPERSEDED: "已被修订",
};

export default function GovernanceView({
  role,
  email,
  organizationId,
  onOpenTask,
}: {
  role: string;
  email: string;
  organizationId: string;
  onOpenTask: (id: string) => void;
}) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [form, setForm] = useState<"new" | Rule | null>(null);
  const [disable, setDisable] = useState<Rule | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const canReview = ["REVIEWER", "ADMIN"].includes(role);
  const refresh = useCallback(async () => {
    const [r, a, p] = await Promise.all([
      api<{ rules: Rule[] }>("GET", "/api/judgments"),
      api<{ agents: Agent[] }>("GET", "/api/agents"),
      api<{ projects: Project[] }>("GET", "/api/projects"),
    ]);
    if (r.ok) setRules(r.body.rules);
    else setMessage(r.body.error ?? "规则读取失败");
    if (a.ok) setAgents(a.body.agents);
    if (p.ok) setProjects(p.body.projects);
    if (canReview) {
      const response = await api<{ approvals: Approval[] }>("GET", "/api/approvals");
      if (response.ok) setApprovals(response.body.approvals);
      else setMessage(response.body.error ?? "审批读取失败");
    }
  }, [canReview]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const scopeName = (type: string, id: string) =>
    type === "PROJECT"
      ? `项目 · ${projects.find((p) => p.id === id)?.name ?? id}`
      : type === "AGENT"
        ? `Agent · ${agents.find((a) => a.id === id)?.name ?? id}`
        : type === "DEPARTMENT"
          ? `部门 · ${id}`
          : "整个组织";
  return (
    <>
      <PageHeading title="治理中心">
        <Button variant="ghost" onClick={() => void refresh()}>
          刷新
        </Button>
      </PageHeading>
      <div className="grid gap-4 lg:grid-cols-2">
        {canReview && (
          <Card className="self-start">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">独立审批</h3>
              <label className="text-sm">
                <input
                  type="checkbox"
                  checked={showHistory}
                  onChange={(e) => setShowHistory(e.target.checked)}
                />{" "}
                显示审批历史
              </label>
            </div>
            {!approvals.some((a) => showHistory || a.decision === "PENDING") && (
              <p className="text-sm text-slate-600">暂无待审批事项。</p>
            )}
            {approvals
              .filter((a) => showHistory || a.decision === "PENDING")
              .map((a) => (
                <article
                  key={a.id}
                  data-approval-id={a.id}
                  className="mb-3 rounded-lg border border-slate-200 p-3 text-sm"
                >
                  <div className="flex flex-wrap gap-2">
                    <strong>{approvalLabel[a.kind] ?? a.kind}</strong>
                    <Badge>{stateLabel[a.decision] ?? a.decision}</Badge>
                  </div>
                  <p className="mt-1">
                    发起人 {a.requestedBy} · {dateTime(a.createdAt)}
                  </p>
                  {a.decidedAt && (
                    <p>
                      审阅者 {a.decidedBy} · {dateTime(a.decidedAt)}
                    </p>
                  )}
                  {a.kind === "AGENT_PUBLISH" && a.payload.manifest?.config && (
                    <details className="mt-2" open>
                      <summary>冻结配置 · v{a.payload.version}</summary>
                      <ManifestSummary manifest={a.payload.manifest} />
                    </details>
                  )}
                  {a.kind === "DANGEROUS_OPERATION" && (
                    <div className="my-2">
                      <p>已同意使用 {a.payload.tools?.join("、")}</p>
                      <Button
                        variant="ghost"
                        onClick={() => onOpenTask(a.payload.taskId ?? a.subjectId)}
                      >
                        查看任务
                      </Button>
                    </div>
                  )}
                  {a.kind === "JUDGMENT_RULE" && (
                    <div className="my-2 space-y-1">
                      <p className="break-words">{a.payload.rule}</p>
                      <p>
                        {scopeName(a.payload.scopeType ?? "", a.payload.scopeId ?? "")} · v
                        {a.payload.version}
                      </p>
                      <p>
                        受影响 Agent ·{" "}
                        {a.payload.impactedAgents?.map((agent) => agent.name).join("、") ||
                          "未记录"}
                      </p>
                      {a.payload.sourceRunId && (
                        <p className="break-all text-xs">来源运行 {a.payload.sourceRunId}</p>
                      )}
                      {a.payload.sourceFeedback && (
                        <p className="whitespace-pre-wrap break-words text-slate-700">
                          {a.payload.sourceFeedback}
                        </p>
                      )}
                      {Boolean(a.payload.conflicts?.length) && (
                        <p className="text-red-800">
                          提交时发现 {a.payload.conflicts!.length} 条冲突。服务端会在批准时复核。
                        </p>
                      )}
                    </div>
                  )}
                  {a.decision === "PENDING" && (
                    <div className="mt-2 flex gap-2">
                      {(["APPROVED", "REJECTED"] as const).map((decision) => (
                        <Button
                          key={decision}
                          variant={decision === "APPROVED" ? "primary" : "ghost"}
                          disabled={busy || email === a.requestedBy}
                          onClick={async () => {
                            setBusy(true);
                            const r = await api("POST", `/api/approvals/${a.id}/decision`, {
                              decision,
                            });
                            setBusy(false);
                            setMessage(r.ok ? "审批决定已记录" : (r.body.error ?? "审批失败"));
                            void refresh();
                          }}
                        >
                          {decision === "APPROVED" ? "批准" : "拒绝"}
                        </Button>
                      ))}
                    </div>
                  )}
                  {email === a.requestedBy && a.decision === "PENDING" && (
                    <p className="mt-1 text-xs text-slate-600">等待其他审阅者决定。</p>
                  )}
                </article>
              ))}
          </Card>
        )}
        <Card className="self-start">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Judgment 规则</h3>
            <Button onClick={() => setForm("new")}>新建候选规则</Button>
          </div>
          {rules.length === 0 && (
            <p className="text-sm text-slate-600">暂无规则。可从任务结果发起有运行证据的纠正。</p>
          )}
          {rules.map((r) => (
            <article key={r.id} className="mb-2 rounded-lg border border-slate-200 p-3 text-sm">
              <div className="mb-1 flex flex-wrap gap-2">
                <Badge>
                  {stateLabel[r.status] ?? r.status} · v{r.version}
                </Badge>
                <Badge>{r.kind === "MECHANICAL" ? "机械" : "语义"}</Badge>
              </div>
              <p className="break-words font-medium">{r.rule}</p>
              <p>{scopeName(r.scopeType, r.scopeId)}</p>
              {r.disabledAt && (
                <p>
                  停用人 {r.disabledBy} · {dateTime(r.disabledAt)}
                </p>
              )}
              {r.sourceRunId && (
                <p className="break-all text-xs text-slate-600">来源运行 {r.sourceRunId}</p>
              )}
              {r.previousId && (
                <p className="break-all text-xs text-slate-600">上一修订 {r.previousId}</p>
              )}
              {r.applications.length > 0 && (
                <details className="my-2">
                  <summary>最近执行评估</summary>
                  <ul className="mt-2 space-y-1">
                    {r.applications.map((a) => (
                      <li key={a.id}>
                        <Badge>{a.evaluation}</Badge> v{a.ruleVersion} {a.failureReason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setForm(r)}>
                  申请修订
                </Button>
                {canReview && r.status === "APPROVED" && (
                  <Button variant="danger" onClick={() => setDisable(r)}>
                    停用
                  </Button>
                )}
              </div>
            </article>
          ))}
        </Card>
      </div>
      {message && (
        <p role="status" className="mt-3 rounded-lg bg-white p-3 text-sm">
          {message}
        </p>
      )}
      {form && (
        <RuleDialog
          rule={form === "new" ? null : form}
          organizationId={organizationId}
          agents={agents}
          projects={projects}
          close={() => setForm(null)}
          saved={(message) => {
            setForm(null);
            setMessage(message);
            void refresh();
          }}
        />
      )}
      {disable && (
        <Confirm
          title="停用规则"
          text={`停用 v${disable.version} 后，后续任务不再注入此版本。`}
          close={() => setDisable(null)}
          execute={async () => {
            const r = await api("POST", `/api/judgments/${disable.id}/disable`);
            setMessage(r.ok ? "规则已停用并留痕" : (r.body.error ?? "停用失败"));
            void refresh();
          }}
        />
      )}
    </>
  );
}

function RuleDialog({
  rule: existing,
  organizationId,
  agents,
  projects,
  close,
  saved,
}: {
  rule: Rule | null;
  organizationId: string;
  agents: Agent[];
  projects: Project[];
  close: () => void;
  saved: (s: string) => void;
}) {
  const [kind, setKind] = useState(existing?.kind ?? "MECHANICAL");
  const [rule, setRule] = useState(existing?.rule ?? "");
  const [scopeType, setScopeType] = useState(existing?.scopeType ?? "ORGANIZATION");
  const [scopeId, setScopeId] = useState(existing?.scopeId ?? organizationId);
  const [sourceFeedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options =
    scopeType === "PROJECT"
      ? projects.filter((p) => !p.archivedAt).map((p) => [p.id, p.name])
      : scopeType === "AGENT"
        ? agents.map((a) => [a.id, a.name])
        : [...new Set(agents.map((a) => a.department).filter(Boolean))].map((dep) => [dep, dep]);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={existing ? `申请修订 v${existing.version}` : "新建候选规则"}
    >
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await api<{ candidate: { conflicts: string[] } }>(
            "POST",
            existing ? `/api/judgments/${existing.id}/revisions` : "/api/judgments/candidates",
            { kind, rule, scopeType, scopeId, sourceFeedback },
          );
          setBusy(false);
          if (r.ok)
            saved(
              r.body.candidate.conflicts.length
                ? "候选已保存，审批前需核对冲突。"
                : "候选已提交，等待独立审批。",
            );
          else setError(r.body.error ?? "提交失败");
        }}
      >
        <RuleInput
          initial={existing ?? undefined}
          lockKind={Boolean(existing)}
          onChange={(kind, rule) => {
            setKind(kind);
            setRule(rule);
          }}
        />
        <Field label="作用域">
          <Select
            value={scopeType}
            disabled={Boolean(existing)}
            onChange={(e) => {
              setScopeType(e.target.value);
              setScopeId(e.target.value === "ORGANIZATION" ? organizationId : "");
            }}
          >
            <option value="ORGANIZATION">组织</option>
            <option value="DEPARTMENT">部门</option>
            <option value="PROJECT">项目</option>
            <option value="AGENT">Agent</option>
          </Select>
        </Field>
        {scopeType !== "ORGANIZATION" && (
          <Field label="作用对象">
            <Select
              value={scopeId}
              disabled={Boolean(existing)}
              onChange={(e) => setScopeId(e.target.value)}
            >
              <option value="">选择作用对象</option>
              {options.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="反馈依据">
          <Textarea
            value={sourceFeedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            maxLength={4000}
          />
        </Field>
        {!existing && (
          <p className="text-xs text-slate-600">
            从任务详情的「纠正结果」可以自动附上实际运行证据。
          </p>
        )}
        <Button type="submit" disabled={busy || !rule || !scopeId || !sourceFeedback.trim()}>
          提交候选
        </Button>
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
