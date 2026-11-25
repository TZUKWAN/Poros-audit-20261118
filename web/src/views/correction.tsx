import { useState } from "react";
import { api } from "../api.js";
import { Button, Dialog, Field, Input, Select, Textarea } from "../ui.js";

const operators = [
  ["must_contain", "必须包含文本"],
  ["must_not_contain", "禁止出现文本"],
  ["max_length", "限制最大长度"],
] as const;

export function RuleInput({
  initial,
  lockKind = false,
  onChange,
}: {
  initial?: { kind: string; rule: string };
  lockKind?: boolean;
  onChange: (kind: string, rule: string) => void;
}) {
  const [kind, setKind] = useState(initial?.kind ?? "MECHANICAL");
  const [operator, setOperator] = useState(
    initial?.kind === "MECHANICAL"
      ? (initial.rule.split(":")[0] ?? "must_contain")
      : "must_contain",
  );
  const [value, setValue] = useState(
    initial
      ? initial.kind === "SEMANTIC"
        ? initial.rule
        : initial.rule.slice(initial.rule.indexOf(":") + 1)
      : "",
  );
  const update = (nextKind: string, nextOperator: string, nextValue: string) => {
    setKind(nextKind);
    setOperator(nextOperator);
    setValue(nextValue);
    const text = nextValue.trim();
    const valid =
      nextKind === "SEMANTIC"
        ? text.length >= 3
        : nextOperator === "max_length"
          ? /^[1-9]\d{0,5}$/.test(text) && Number(text) <= 100000
          : Boolean(text);
    onChange(nextKind, valid ? (nextKind === "SEMANTIC" ? text : nextOperator + ":" + text) : "");
  };
  return (
    <div className="grid gap-3">
      <Field label="规则类型">
        <Select
          value={kind}
          disabled={lockKind}
          onChange={(e) => update(e.target.value, operator, "")}
        >
          <option value="MECHANICAL">机械规则</option>
          <option value="SEMANTIC">语义规则</option>
        </Select>
      </Field>
      {kind === "MECHANICAL" && (
        <Field label="检查方式">
          <Select value={operator} onChange={(e) => update(kind, e.target.value, value)}>
            {operators.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label={
          kind === "SEMANTIC" ? "裁决标准" : operator === "max_length" ? "最大字符数" : "检查文本"
        }
      >
        {kind === "SEMANTIC" ? (
          <Textarea
            rows={3}
            value={value}
            onChange={(e) => update(kind, operator, e.target.value)}
            maxLength={4000}
          />
        ) : (
          <Input
            type={operator === "max_length" ? "number" : "text"}
            min={1}
            max={100000}
            maxLength={3900}
            value={value}
            onChange={(e) => update(kind, operator, e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

export function CorrectionDialog({
  taskId,
  runId,
  version,
  project,
  close,
}: {
  taskId: string;
  runId: string;
  version: number | null;
  project: string | null;
  close: () => void;
}) {
  const [rule, setRule] = useState("");
  const [kind, setKind] = useState("MECHANICAL");
  const [scopeType, setScopeType] = useState("AGENT");
  const [sourceFeedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && close()} title="建议今后遵循">
      <p className="mb-3 text-sm text-slate-600">
        把这次经验提为长期规则候选，独立审批通过后才影响今后的执行。本次结果不会因此改写。
      </p>
      <p className="mb-3 break-all text-sm text-slate-600">
        运行 {runId} · {version ? `Agent v${version}` : "草稿测试"}
      </p>
      {submitted ? (
        <Button onClick={close}>完成</Button>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await api<{ candidate: { conflicts: string[] } }>(
              "POST",
              `/api/tasks/${taskId}/runs/${runId}/corrections`,
              { kind, rule, scopeType, sourceFeedback },
            );
            setBusy(false);
            setSubmitted(r.ok);
            setMessage(
              r.ok
                ? r.body.candidate.conflicts.length > 0
                  ? "候选已存档。与生效规则冲突，审批前需修订。"
                  : "纠正已关联原始运行，等待独立审批。"
                : (r.body.error ?? "提交纠正失败"),
            );
          }}
        >
          <Field label="纠正说明">
            <Textarea
              value={sourceFeedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              maxLength={4000}
            />
          </Field>
          <Field label="生效范围">
            <Select value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
              <option value="AGENT">本 Agent</option>
              {project && <option value="PROJECT">项目 · {project}</option>}
            </Select>
          </Field>
          <RuleInput
            onChange={(type, rule) => {
              setKind(type);
              setRule(rule);
            }}
          />
          <Button type="submit" disabled={busy || !rule || !sourceFeedback.trim()}>
            提交纠正
          </Button>
        </form>
      )}
      {message && (
        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      )}
    </Dialog>
  );
}
