import { useCallback, useEffect, useRef, useState } from "react";
import { api, download, getToken, saveBlob, setToken } from "../api.js";
import { dateTime, modelDisplay, sensitiveGrants, type Manifest } from "../pc.js";
import { Badge, Button, Card, Dialog, Field, Select, StatusBadge, Textarea } from "../ui.js";
import { CorrectionDialog } from "./correction.js";

type Usage = {
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  judge?: { modelCalls?: number };
};
type Application = {
  id: string;
  ruleVersion: number;
  evidenceRef: string;
  failureReason: string;
  evaluation: string;
  rule: { kind: string; rule: string };
};
type FileUse = {
  ref: string;
  digest: string;
  chars: number;
  truncated: boolean;
  file: { id: string; name: string; sourceUrl: string };
};
type Run = {
  id: string;
  status: string;
  output: string;
  error: string;
  failureCode?: string;
  startedAt: string;
  finishedAt: string | null;
  modelGateway: string;
  modelId: string | null;
  artifact: { id: string; name: string; revisionOfId: string | null } | null;
  feedback: Array<{ id: string; createdBy: string; rating: string | null; comment: string }>;
  fileUses: FileUse[];
  applications: Application[];
  usage: Usage;
};
type Detail = {
  version: number | null;
  task: {
    id: string;
    createdBy: string;
    prompt: string;
    status: string;
    createdAt: string;
    attempts: number;
    maxAttempts: number;
    cancelRequested: boolean;
    acceptedRunId: string | null;
    executionSnapshot: Partial<Manifest>;
  };
  project: { name: string; archivedAt: string | null } | null;
  approval: { decision: string; decidedBy: string | null } | null;
  inputs: Array<{ file: { id: string; name: string } }>;
  permissions: { cancel: boolean; retry: boolean; accept: boolean; feedback: boolean };
  runs: Run[];
};

const recovery: Record<string, string> = {
  MODEL_AUTH_REJECTED: "检查设置里的凭证和授权范围，再测试连接。",
  MODEL_ACCOUNT_VALIDATION_REQUIRED: "在模型供应商完成账号验证，再回设置测试生成。",
  MODEL_UPSTREAM_AUTH_UNAVAILABLE: "检查网关里配置的上游账号。",
  MODEL_RATE_LIMITED: "稍后重试，或检查模型服务额度。",
  MODEL_UPSTREAM_FAILURE: "检查上游服务状态后重试。",
  MODEL_TIMEOUT: "检查模型连接并重试，必要时改用另一个已审批模型。",
  MODEL_NETWORK_ERROR: "检查服务地址、网络及模型连接测试。",
  ACCESS_BLOCKED: "查看项目权限、Agent 授权和个人连接的验证状态。",
  FILE_READ_FAILED: "在文件空间预览所选文件，替换无法解析的文件后重新发起。",
  TASK_TIMEOUT: "缩小任务范围，确认模型和工具响应正常后再试。",
  RUNTIME_FAILED: "从执行证据查看容器或工具错误，再按当前授权重试。",
};

export default function RunDetails({
  taskId,
  onChanged,
  conversationMode = false,
  onRevise,
  onConnections,
  onGovernance,
}: {
  taskId: string;
  onChanged?: () => void;
  conversationMode?: boolean;
  onRevise?: (runId: string) => void;
  onConnections?: () => void;
  onGovernance?: (taskId: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState("");
  const [streamVersion, setStreamVersion] = useState(0);
  const [correct, setCorrect] = useState(false);
  const [retryConsent, setRetryConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<{
    name: string;
    text: string;
    truncated: boolean;
  } | null>(null);
  const load = useCallback(async () => {
    const r = await api<Detail>("GET", `/api/tasks/${taskId}`);
    if (r.ok) {
      setDetail(r.body);
      setStatus(r.body.task.status);
      setPending(r.body.approval?.decision === "PENDING" && r.body.task.status === "BLOCKED");
    } else setMessage(r.body.error ?? "读取任务失败");
  }, [taskId]);
  useEffect(() => {
    void load();
  }, [load]);
  const streamStatus = useCallback(
    (state: string, approval: boolean) => {
      setStatus(state);
      setPending(approval);
      if (state !== "RUNNING" && !approval) {
        void load();
        onChanged?.();
      }
    },
    [load, onChanged],
  );
  const run = detail?.runs.find((r) => r.id === selected) ?? detail?.runs[0];
  const task = detail?.task;
  const tools = sensitiveGrants(task?.executionSnapshot.grants ?? []);
  const canCancel =
    detail?.permissions.cancel && (["QUEUED", "RUNNING"].includes(status) || pending);
  const canRetry =
    detail?.permissions.retry &&
    ["TIMED_OUT", "FAILED"].includes(status) &&
    Boolean(task && task.attempts < task.maxAttempts);
  const invoke = async (action: string, body?: unknown) => {
    setBusy(true);
    const r = await api<{ status?: string }>("POST", `/api/tasks/${taskId}/${action}`, body);
    setBusy(false);
    if (!r.ok) setMessage(r.body.error ?? "操作失败，请刷新重试");
    else {
      setMessage(
        action === "accept" ? "已记录采纳" : action === "cancel" ? "取消请求已提交" : "已提交重试",
      );
      if (action === "retry") {
        setSelected("");
        setRetryConsent(false);
        setStreamVersion((version) => version + 1);
      }
      void load();
      onChanged?.();
    }
  };
  return (
    <section className="space-y-4" aria-label="任务详情">
      <Card className={conversationMode ? "!border-0 !bg-transparent !p-0" : ""}>
        {!conversationMode && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">任务详情</h3>
            {(status || task) && <StatusBadge status={status || task!.status} />}
          </div>
        )}
        {task && detail && (
          <>
            {!conversationMode && (
              <p className="my-3 whitespace-pre-wrap break-words text-sm">{task.prompt}</p>
            )}
            {pending && (
              <p role="status" className="mt-3 text-sm text-amber-800">
                本次请求全部列明能力正在等待独立审批，尚未执行。
                {onGovernance && (
                  <Button className="ml-2" variant="ghost" onClick={() => onGovernance(taskId)}>
                    查看审批申请
                  </Button>
                )}
              </p>
            )}
            {detail.approval?.decision === "REJECTED" && (
              <p className="mt-3 text-sm text-red-800">
                独立审批拒绝 · {detail.approval.decidedBy}
              </p>
            )}
            {(canCancel || canRetry || detail.runs.length > 1) && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canCancel && (
                  <Button
                    variant="ghost"
                    disabled={busy || task.cancelRequested}
                    onClick={() => void invoke("cancel")}
                  >
                    {task.cancelRequested ? "正在取消…" : "取消"}
                  </Button>
                )}
                {canRetry && (
                  <>
                    {tools.length > 0 && (
                      <label className="text-sm">
                        <input
                          type="checkbox"
                          checked={retryConsent}
                          onChange={(e) => setRetryConsent(e.target.checked)}
                        />{" "}
                        同意重试使用 {tools.join("、")}
                      </label>
                    )}
                    <Button
                      variant="ghost"
                      disabled={busy || (tools.length > 0 && !retryConsent)}
                      onClick={() => void invoke("retry", { consent: retryConsent ? tools : [] })}
                    >
                      重试
                    </Button>
                  </>
                )}
                {detail.runs.length > 1 && (
                  <Field label="历史运行">
                    <Select value={run?.id ?? ""} onChange={(e) => setSelected(e.target.value)}>
                      {detail.runs.map((r, index) => (
                        <option key={r.id} value={r.id}>
                          第 {detail.runs.length - index} 次 · {dateTime(r.startedAt)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </div>
            )}
            <details className="mt-3 border-t border-[#e3e1dc] pt-2">
              <summary className="cursor-pointer text-sm text-slate-700">任务信息</summary>
              <dl className="mt-2 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
                {[
                  ["发起人", task.createdBy],
                  ["项目", detail.project?.name ?? "个人任务"],
                  [
                    "Agent",
                    (task.executionSnapshot.name ?? "历史任务") +
                      (detail.version ? ` · v${detail.version}` : " · 草稿"),
                  ],
                  ["创建时间", dateTime(task.createdAt)],
                  ["执行模型", run ? modelDisplay(run.modelGateway, run.modelId) : "等待执行"],
                  ["尝试次数", `${task.attempts} / ${task.maxAttempts}`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-slate-500">{label}</dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 break-all text-xs text-slate-500">任务 ID {task.id}</p>
              {detail.inputs.length > 0 && (
                <p className="mt-1 break-words text-sm">
                  输入文件 · {detail.inputs.map((i) => i.file.name).join("、")}
                </p>
              )}
            </details>
          </>
        )}
        {message && (
          <p className="mt-2 text-sm" role="status">
            {message}
          </p>
        )}
      </Card>

      {run && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto font-semibold">任务结果</h3>
            <Badge>{modelDisplay(run.modelGateway, run.modelId)}</Badge>
            <StatusBadge status={run.status} />
          </div>
          <p className="text-xs text-slate-600">
            运行 {run.id} ·{" "}
            {run.finishedAt
              ? `${((+new Date(run.finishedAt) - +new Date(run.startedAt)) / 1000).toFixed(2)} 秒`
              : "正在执行"}
            {typeof run.usage.modelCalls === "number"
              ? ` · 模型调用 ${run.usage.modelCalls} 次`
              : ""}
            {run.usage.judge?.modelCalls ? ` · Judge 调用 ${run.usage.judge.modelCalls} 次` : ""}
          </p>
          {run.error && (
            <div role="alert" className="my-3 rounded-lg bg-red-50 p-3 text-sm text-red-900">
              {run.error}
              {run.failureCode && (
                <p className="mt-1">{recovery[run.failureCode] ?? run.failureCode}</p>
              )}
              {onConnections && (
                <Button className="mt-2" variant="ghost" onClick={onConnections}>
                  检查个人连接
                </Button>
              )}
            </div>
          )}
          {run.output && (
            <>
              <pre className="my-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-sans text-sm">
                {run.output}
              </pre>
              <div className="flex flex-wrap gap-2">
                {onRevise && run.finishedAt && (
                  <Button onClick={() => onRevise(run.id)}>修改此结果</Button>
                )}
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (run.artifact) {
                      const error = await download(
                        `/api/tasks/${taskId}/runs/${run.id}/artifact`,
                        run.artifact.name,
                      );
                      if (error) setMessage(error);
                    } else
                      saveBlob(
                        new Blob([run.output], { type: "text/plain;charset=utf-8" }),
                        `poros-${run.id}.txt`,
                      );
                  }}
                >
                  {run.artifact ? "下载产物" : "导出结果"}
                </Button>
                {detail?.permissions.accept && (
                  <Button
                    variant="ghost"
                    disabled={
                      busy ||
                      status !== "SUCCEEDED" ||
                      run.status !== "SUCCEEDED" ||
                      Boolean(task?.acceptedRunId)
                    }
                    onClick={() => void invoke("accept", { runId: run.id })}
                  >
                    {task?.acceptedRunId === run.id ? "已采纳" : "采纳结果"}
                  </Button>
                )}
                {detail?.permissions.accept && (
                  <Button variant="ghost" onClick={() => setCorrect(true)}>
                    建议今后遵循
                  </Button>
                )}
              </div>
              {run.artifact?.revisionOfId && (
                <p className="mt-2 break-all text-xs text-slate-600">
                  产物修订 · 源产物 {run.artifact.revisionOfId}。原结果保留。
                </p>
              )}
              <p className="mt-3 text-xs text-slate-600">
                {run.status === "UNVERIFIED"
                  ? "执行已产生结果，质量验收尚未验证。测试模型的输出不能作为真实业务验收。"
                  : run.status === "SUCCEEDED_WITH_VIOLATIONS"
                    ? "结果未通过列明的质量检查，请查看具体规则。"
                    : run.status === "SUCCEEDED"
                      ? "已通过当前配置的质量检查。是否采纳由有资格的发起人决定。"
                      : "质量状态以本次运行记录为准。"}
              </p>
              {detail?.permissions.feedback && run.finishedAt && (
                <ResultFeedback key={run.id} taskId={taskId} run={run} onSaved={load} />
              )}
            </>
          )}
          {run.fileUses.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">
                查看文件来源 · {run.fileUses.length} 份
              </summary>
              <ul className="mt-2 space-y-2 text-sm">
                {run.fileUses.map((use) => (
                  <li key={use.file.id} className="rounded-lg border border-slate-200 p-2">
                    <Badge>{use.ref}</Badge> {use.file.name} · 读取 {use.chars} 字
                    {use.truncated ? "（节选）" : ""}
                    <Button
                      className="ml-2"
                      variant="ghost"
                      aria-label={"预览引用文件 " + use.file.name}
                      onClick={async () => {
                        const response = await api<{
                          preview: { text: string; truncated: boolean };
                        }>("GET", `/api/files/${use.file.id}/preview`, undefined, {}, 30000);
                        if (response.ok)
                          setSourcePreview({ name: use.file.name, ...response.body.preview });
                        else setMessage(response.body.error ?? "来源当前不可读取");
                      }}
                    >
                      预览原文件
                    </Button>
                    {/^https?:\/\//i.test(use.file.sourceUrl) && (
                      <p className="mt-1 break-all">
                        <a target="_blank" rel="noreferrer" href={use.file.sourceUrl}>
                          打开记录的来源
                        </a>
                      </p>
                    )}
                    <p className="break-all text-xs text-slate-500">SHA-256 {use.digest}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {run.applications.length > 0 && (
            <section className="mt-4">
              <h4 className="font-medium">Judgment 检查</h4>
              <ul className="mt-2 space-y-2 text-sm">
                {run.applications.map((row) => (
                  <li key={row.id} className="rounded-lg border border-slate-200 p-2">
                    <Badge
                      tone={
                        row.evaluation === "PASS"
                          ? "ok"
                          : row.evaluation === "FAIL"
                            ? "bad"
                            : "warn"
                      }
                    >
                      {row.evaluation}
                    </Badge>{" "}
                    {row.rule.rule} · v{row.ruleVersion}
                    {row.failureReason && <p>{row.failureReason}</p>}
                    {row.evidenceRef && (
                      <p className="break-all text-xs text-slate-500">{row.evidenceRef}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Card>
      )}
      <details open={!conversationMode} className="rounded-xl border border-[#e3e1dc] bg-white p-3">
        <summary className="cursor-pointer text-sm font-medium">查看执行过程与证据</summary>
        <div className="mt-3">
          <RunTimeline
            key={streamVersion}
            taskId={taskId}
            selected={selected}
            onStatus={streamStatus}
          />
        </div>
      </details>
      {correct && run && (
        <CorrectionDialog
          taskId={taskId}
          runId={run.id}
          version={detail?.version ?? null}
          project={detail?.project?.name ?? null}
          close={() => setCorrect(false)}
        />
      )}
      <Dialog
        open={Boolean(sourcePreview)}
        onOpenChange={(open) => !open && setSourcePreview(null)}
        title={sourcePreview?.name ?? "文件来源"}
      >
        {sourcePreview?.truncated && (
          <p className="mb-2 text-sm text-amber-900">
            当前显示提取节选，执行使用的字数和摘要记录在来源中。
          </p>
        )}
        <pre className="whitespace-pre-wrap break-words font-sans text-sm">
          {sourcePreview?.text}
        </pre>
        <Button className="mt-4" variant="ghost" onClick={() => setSourcePreview(null)}>
          返回结果
        </Button>
      </Dialog>
    </section>
  );
}

function ResultFeedback({
  taskId,
  run,
  onSaved,
}: {
  taskId: string;
  run: Run;
  onSaved: () => Promise<void>;
}) {
  const [rating, setRating] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <details className="mt-4 border-t border-[#e3e1dc] pt-3">
      <summary className="cursor-pointer text-sm">
        评价这次结果{run.feedback?.length ? ` · ${run.feedback.length} 条` : ""}
      </summary>
      <p className="my-2 text-xs text-slate-600">
        评价只记录本次反馈。修改结果请用「修改此结果」，长期标准请用「建议今后遵循」。
      </p>
      <form
        className="grid gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          const r = await api("POST", `/api/tasks/${taskId}/runs/${run.id}/feedback`, {
            rating: rating || null,
            comment,
          });
          setBusy(false);
          setMessage(
            r.ok ? "本次评价已记录，质量状态保持原判定" : (r.body.error ?? "评价保存失败"),
          );
          if (r.ok) await onSaved();
        }}
      >
        <Field label="本次评价">
          <Select value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">仅填写意见</option>
            <option value="HELPFUL">有帮助</option>
            <option value="NEEDS_CHANGES">需要调整</option>
          </Select>
        </Field>
        <Textarea
          aria-label="本次结果意见"
          rows={2}
          value={comment}
          maxLength={4000}
          onChange={(e) => setComment(e.target.value)}
        />
        <Button variant="ghost" disabled={busy || !(rating || comment.trim())}>
          保存本次评价
        </Button>
      </form>
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      <ul className="mt-2 space-y-1 text-xs text-slate-600">
        {run.feedback?.map((feedback) => (
          <li key={feedback.id}>
            {feedback.createdBy} ·{" "}
            {feedback.rating === "HELPFUL"
              ? "有帮助"
              : feedback.rating === "NEEDS_CHANGES"
                ? "需要调整"
                : "意见"}
            {feedback.comment ? ` · ${feedback.comment}` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

type EventRow = { id: string; runId: string; kind: string; payload: Record<string, unknown> };
const timelineTitles: Record<string, string> = {
  "model.binding": "选择模型",
  model: "模型响应",
  "dsh.session": "隔离会话启动",
  "dsh.status": "执行进度",
  "dsh.tool_call": "工具调用",
  "dsh.tool_result": "工具返回",
  "file.context": "准备文件上下文",
  "conversation.context": "衔接工作上下文",
  judgment: "Judgment",
  judge: "语义裁决",
  "capability.call": "调用已授权能力",
  "capability.result": "能力返回来源",
  "capability.error": "能力调用失败",
  "security.audit": "授权检查",
  "tool.error": "工具执行错误",
  "dsh.final": "输出完成",
  status: "运行状态",
};

function eventText({ kind, payload }: EventRow) {
  const value = (key: string) => {
    const item = payload[key];
    return item === null || item === undefined
      ? ""
      : typeof item === "string"
        ? item
        : JSON.stringify(item);
  };
  if (kind === "dsh.tool_call")
    return [value("tool"), payload.authorized ? "允许" : "拒绝", value("input")]
      .filter(Boolean)
      .join(" · ");
  if (kind === "dsh.tool_result")
    return [
      value("tool"),
      value("status"),
      value("content") || value("output") || value("result") || value("error"),
    ]
      .filter(Boolean)
      .join(" · ");
  if (kind === "judgment")
    return payload.phase === "inject"
      ? `已注入 ${Array.isArray(payload.rules) ? payload.rules.length : 0} 条规则`
      : [value("ruleId"), "v" + value("version"), value("evaluation"), value("reason")]
          .filter(Boolean)
          .join(" · ");
  if (kind === "model.binding") return modelDisplay(value("channel"), value("model"));
  return ["phase", "status", "name", "gateway", "model", "ruleId", "error", "message"]
    .map(value)
    .filter(Boolean)
    .join(" · ");
}

function RunTimeline({
  taskId,
  selected,
  onStatus,
}: {
  taskId: string;
  selected: string;
  onStatus: (status: string, pending: boolean) => void;
}) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [state, setState] = useState("连接中");
  const [error, setError] = useState("");
  const cursor = useRef("");
  useEffect(() => {
    const ctrl = new AbortController();
    const sleep = () => new Promise((resolve) => setTimeout(resolve, 1000));
    const seen = new Set<string>();
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          setState(cursor.current ? "恢复连接" : "连接中");
          const res = await fetch(`/api/tasks/${taskId}/events`, {
            headers: {
              authorization: `Bearer ${getToken() ?? ""}`,
              ...(cursor.current ? { "last-event-id": cursor.current } : {}),
            },
            signal: ctrl.signal,
          });
          if (res.status === 401) {
            setToken(null);
            window.dispatchEvent(new Event("poros-auth-expired"));
            return;
          }
          if (res.status === 403 || res.status === 404) {
            setState("访问已失效");
            setError("任务访问权限已变更，请联系项目管理员。");
            return;
          }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          setState("接收中");
          setError("");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!ctrl.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const lines = frame.split("\n");
              const kind = lines.find((line) => line.startsWith("event: "))?.slice(7);
              const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
              const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
              if (!kind || !data) continue;
              if (kind === "access-revoked") {
                setState("访问已失效");
                setError("任务访问权限已撤销。");
                await reader.cancel();
                return;
              }
              if (kind === "error") throw new Error("事件连接已中断，正在恢复");
              if (kind === "reset") {
                seen.clear();
                cursor.current = "";
                setEvents([]);
                continue;
              }
              const payload = JSON.parse(data) as {
                status?: string;
                pendingApproval?: boolean;
                runId: string;
                payload: Record<string, unknown>;
              };
              if (kind === "done") {
                const approval = payload.pendingApproval === true;
                onStatus(payload.status ?? "", approval);
                setState(approval ? "等待审批" : "已结束");
                if (!approval) {
                  await reader.cancel();
                  return;
                }
              } else if (id && !seen.has(id)) {
                seen.add(id);
                cursor.current = id;
                onStatus("RUNNING", false);
                setEvents((all) =>
                  [...all, { id, runId: payload.runId, kind, payload: payload.payload }].slice(
                    -2200,
                  ),
                );
              }
            }
          }
        } catch (e) {
          if (ctrl.signal.aborted) break;
          setError(e instanceof Error ? e.message : "事件连接失败，正在恢复");
        }
        await sleep();
      }
    })();
    return () => ctrl.abort();
  }, [taskId, onStatus]);

  const rows = events.filter((e) => timelineTitles[e.kind] && (!selected || e.runId === selected));
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="font-semibold">执行时间线</h3>
        <Badge>{state}</Badge>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      {!rows.length && (
        <p className="text-sm text-slate-600">
          {state === "已结束" ? "本次任务无运行事件" : "等待执行事件…"}
        </p>
      )}
      <ol className="max-h-[32rem] space-y-2 overflow-auto">
        {rows.map((e) => (
          <li key={e.id} className="border-l-2 border-slate-200 pl-3 text-sm">
            <strong className="mr-2 font-medium">{timelineTitles[e.kind]}</strong>
            <span className="text-xs text-slate-500">{e.kind}</span>
            <p className="whitespace-pre-wrap break-words">{eventText(e).slice(0, 3000)}</p>
            <details className="text-xs text-slate-600">
              <summary>执行证据</summary>
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </Card>
  );
}
