import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Button, Card, Input, Select, Textarea } from "../ui.js";
interface Approval {
  id: string;
  kind: string;
  subjectId: string;
  requestedBy: string;
  decision: string;
  payload: unknown;
}
interface Rule {
  id: string;
  rule: string;
  kind: string;
  version: number;
  status: string;
  scopeType: string;
  scopeId: string;
  familyId: string;
}
export default function GovernanceView({
  role,
  email,
  organizationId,
}: {
  role: string;
  email: string;
  organizationId: string;
}) {
  const [approvals, setApprovals] = useState<Approval[]>([]),
    [rules, setRules] = useState<Rule[]>([]),
    [rule, setRule] = useState(""),
    [feedback, setFeedback] = useState(""),
    [kind, setKind] = useState("MECHANICAL"),
    [scopeType, setScopeType] = useState("ORGANIZATION"),
    [scopeId, setScopeId] = useState(organizationId),
    [revision, setRevision] = useState<Rule | null>(null),
    [message, setMessage] = useState("");
  const canReview = role === "REVIEWER" || role === "ADMIN";
  const refresh = useCallback(async () => {
    const r = await api<{ rules: Rule[] }>("GET", "/api/judgments");
    if (r.ok) setRules(r.body.rules);
    if (canReview) {
      const a = await api<{ approvals: Approval[] }>("GET", "/api/approvals");
      if (a.ok) setApprovals(a.body.approvals);
    }
  }, [canReview]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="space-y-4">
      {canReview && (
        <Card>
          <div className="mb-2 flex justify-between">
            <span>独立审批</span>
            <Button variant="ghost" onClick={() => void refresh()}>
              刷新
            </Button>
          </div>
          {approvals
            .filter((a) => a.decision === "PENDING")
            .map((a) => (
              <div key={a.id} className="mb-3 border-b border-[#e3e1dc] pb-2">
                <Badge>{a.kind}</Badge>
                <p className="text-xs">
                  申请人：{a.requestedBy} · 对象：{a.subjectId}
                </p>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(a.payload, null, 2)}
                </pre>
                {(["APPROVED", "REJECTED"] as const).map((decision) => (
                  <Button
                    key={decision}
                    variant="ghost"
                    disabled={a.requestedBy === email}
                    onClick={async () => {
                      const r = await api("POST", `/api/approvals/${a.id}/decision`, { decision });
                      setMessage(r.ok ? "决定已记录" : (r.body.error ?? "审批失败"));
                      void refresh();
                    }}
                  >
                    {decision === "APPROVED" ? "批准" : "拒绝"}
                  </Button>
                ))}
                {a.requestedBy === email && (
                  <p className="text-xs">由其他审阅者决定，禁止自审批。</p>
                )}
              </div>
            ))}
        </Card>
      )}
      <Card>
        <p className="mb-2">
          {revision
            ? `修订规则 v${revision.version}（审批前原规则继续生效）`
            : "提交显式纠正为候选规则"}
        </p>
        <Select aria-label="规则类型" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option>MECHANICAL</option>
          <option>SEMANTIC</option>
        </Select>
        <Select
          aria-label="作用域"
          value={scopeType}
          onChange={(e) => setScopeType(e.target.value)}
        >
          {["ORGANIZATION", "DEPARTMENT", "PROJECT", "AGENT"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Input
          aria-label="作用域 ID"
          value={scopeId}
          onChange={(e) => setScopeId(e.target.value)}
        />
        <Textarea
          aria-label="规则内容"
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          placeholder="must_contain:引用来源 / max_length:1000"
        />
        <Textarea
          aria-label="反馈来源"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="显式纠正原文与依据"
        />
        <Button
          disabled={!rule.trim() || !feedback.trim()}
          onClick={async () => {
            const r = await api(
              "POST",
              revision ? `/api/judgments/${revision.id}/revisions` : "/api/judgments/candidates",
              { rule, kind, scopeType, scopeId, sourceFeedback: feedback },
            );
            setMessage(r.ok ? "候选已提交，等待独立审批" : (r.body.error ?? "提交失败"));
            if (r.ok) {
              setRevision(null);
              setRule("");
              setFeedback("");
            }
            void refresh();
          }}
        >
          提交候选
        </Button>
        {revision && (
          <Button variant="ghost" onClick={() => setRevision(null)}>
            取消修订
          </Button>
        )}
      </Card>
      <Card>
        {rules.map((r) => (
          <div key={r.id} className="mb-3 border-b border-[#e3e1dc] pb-2">
            <Badge>
              {r.status} · v{r.version}
            </Badge>
            <p>{r.rule}</p>
            <p className="text-xs">
              {r.scopeType}:{r.scopeId} · {r.familyId}
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                setRevision(r);
                setRule(r.rule);
                setKind(r.kind);
                setScopeType(r.scopeType);
                setScopeId(r.scopeId);
              }}
            >
              申请修订
            </Button>
            {canReview && r.status === "APPROVED" && (
              <Button
                variant="ghost"
                onClick={async () => {
                  const res = await api("POST", `/api/judgments/${r.id}/disable`);
                  setMessage(res.ok ? "规则已停用并留痕" : (res.body.error ?? "停用失败"));
                  void refresh();
                }}
              >
                停用
              </Button>
            )}
          </div>
        ))}
      </Card>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
