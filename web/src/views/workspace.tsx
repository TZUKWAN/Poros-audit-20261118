import { useEffect, useRef, useState, useCallback } from "react";
import { api, getToken, setToken } from "../api.js";
import { Badge, Button, Card, Select, StatusBadge, Textarea } from "../ui.js";
interface AgentRow {
  releaseReady: boolean;
  id: string;
  name: string;
  status: string;
  currentVersion: number;
  versions: Array<{ version: number; manifest: { grants: Array<{ kind: string; name: string }> } }>;
}
interface RecentTask {
  id: string;
  title: string;
  status: string;
  sensitive: string[];
}
function requestKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export default function WorkspaceView({ role }: { role: string }) {
  const [agents, setAgents] = useState<AgentRow[]>([]),
    [agentId, setAgentId] = useState(""),
    [prompt, setPrompt] = useState(""),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [last, setLast] = useState<{
    taskId: string;
    status: string;
    runtime?: string;
    sensitive: string[];
    pendingApproval: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recent, setRecent] = useState<RecentTask[]>([]);
  const [recentError, setRecentError] = useState("");
  const [retryConsent, setRetryConsent] = useState(false);
  const refreshRecent = useCallback(async () => {
    const r = await api<{ tasks: RecentTask[] }>("GET", "/api/tasks");
    if (r.ok) {
      setRecent(r.body.tasks);
      setRecentError("");
    } else setRecentError(r.body.error ?? "读取任务失败");
  }, []);
  const pendingRequest = useRef<{ body: string; key: string } | null>(null);
  const onStatus = useCallback(
    (status: string, pendingApproval = false) =>
      setLast((prev) =>
        prev && (prev.status !== status || prev.pendingApproval !== pendingApproval)
          ? { ...prev, status, pendingApproval }
          : prev,
      ),
    [],
  );
  const manifest = agents
    .find((a) => a.id === agentId)
    ?.versions.find(
      (v) => v.version === agents.find((a) => a.id === agentId)?.currentVersion,
    )?.manifest;
  const sensitive = (manifest?.grants ?? [])
    .filter(
      (g) =>
        g.kind === "TOOL" && ["bash", "write", "edit", "web.fetch", "web.search"].includes(g.name),
    )
    .map((g) => g.name);
  useEffect(() => {
    void api<{ agents: AgentRow[] }>("GET", "/api/agents").then((r) => {
      if (r.ok) {
        setAgents(r.body.agents);
        setAgentId(r.body.agents.find((a) => a.releaseReady)?.id ?? "");
      }
    });
    void refreshRecent();
  }, [refreshRecent]);
  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <span>下达任务 · {role}</span>
          {last && (
            <>
              {last.runtime && <Badge tone="brand">{last.runtime}</Badge>}
              <StatusBadge status={last.status} />
            </>
          )}
        </div>
        <Select
          aria-label="Agent"
          className="max-w-full"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setConsent(false);
          }}
        >
          <option value="">选择已发布 Agent…</option>
          {agents
            .filter((a) => a.releaseReady)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} (v{a.currentVersion})
              </option>
            ))}
        </Select>
        <Textarea
          aria-label="任务"
          rows={3}
          className="mt-2"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述任务"
        />
        {sensitive.length > 0 && (
          <label className="mt-2 block text-sm">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{" "}
            同意本次任务使用 {sensitive.join("、")}；独立审批通过后执行
          </label>
        )}
        <Button
          disabled={!agentId || !prompt.trim() || busy || (sensitive.length > 0 && !consent)}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const body = { agentId, prompt, consent: consent ? sensitive : [] },
                encoded = JSON.stringify(body);
              if (pendingRequest.current?.body !== encoded)
                pendingRequest.current = { body: encoded, key: requestKey() };
              const r = await api<{ taskId: string; status: string; runtime: string }>(
                "POST",
                "/api/tasks",
                body,
                { "idempotency-key": pendingRequest.current.key },
              );
              if (r.ok) {
                pendingRequest.current = null;
                setLast({ ...r.body, sensitive, pendingApproval: r.body.status === "BLOCKED" });
                setConsent(false);
                setRetryConsent(false);
                void refreshRecent();
              } else setError(r.body.error ?? "提交失败");
            } catch {
              setError("网络中断，请检查连接");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "提交中…" : "提交任务"}
        </Button>
        {last && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              disabled={!["QUEUED", "RUNNING", "BLOCKED"].includes(last.status)}
              onClick={async () => {
                const r = await api("POST", `/api/tasks/${last.taskId}/cancel`);
                if (!r.ok) setError(r.body.error ?? "取消失败");
                else void refreshRecent();
              }}
            >
              取消
            </Button>
            {["FAILED", "TIMED_OUT"].includes(last.status) && last.sensitive.length > 0 && (
              <label className="w-full text-sm">
                <input
                  type="checkbox"
                  checked={retryConsent}
                  onChange={(e) => setRetryConsent(e.target.checked)}
                />{" "}
                同意重试使用 {last.sensitive.join("、")}
              </label>
            )}
            <Button
              variant="ghost"
              disabled={
                !["FAILED", "TIMED_OUT"].includes(last.status) ||
                (last.sensitive.length > 0 && !retryConsent)
              }
              onClick={async () => {
                const r = await api<{ status: string }>("POST", `/api/tasks/${last.taskId}/retry`, {
                  consent: retryConsent ? last.sensitive : [],
                });
                if (r.ok) {
                  setLast({
                    ...last,
                    status: r.body.status,
                    pendingApproval: r.body.status === "BLOCKED",
                  });
                  setRetryConsent(false);
                  setError("");
                  setAttempt((a) => a + 1);
                  void refreshRecent();
                } else setError(r.body.error ?? "重试失败");
              }}
            >
              重试
            </Button>
            <p className="break-all text-xs">任务 ID：{last.taskId}</p>
          </div>
        )}
        {last?.pendingApproval && last.status === "BLOCKED" && (
          <p role="status" className="mt-2 text-sm">
            本次敏感操作已提交，请独立审阅者到「审批与规则」决定。
          </p>
        )}
        {error && (
          <p role="status" className="mt-2 text-sm text-[#a1301c]">
            {error}
          </p>
        )}
      </Card>
      {last && (
        <RunEvents key={`${last.taskId}:${attempt}`} taskId={last.taskId} onStatus={onStatus} />
      )}
      <Card>
        <div className="flex justify-between gap-2">
          <h2 className="font-medium">我的任务</h2>
          <Button variant="ghost" onClick={refreshRecent}>
            刷新任务
          </Button>
        </div>
        {recentError && (
          <p role="alert" className="text-sm">
            {recentError}
          </p>
        )}
        {recent.length === 0 && !recentError && (
          <p className="mt-2 text-sm text-[#5c5a55]">暂无任务</p>
        )}
        <ul className="mt-2 grid gap-2">
          {recent.map((task) => (
            <li key={task.id}>
              <button
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-[#e3e1dc] px-3 py-2 text-left text-sm"
                onClick={() => {
                  setRetryConsent(false);
                  setLast({
                    taskId: task.id,
                    status: task.status,
                    sensitive: task.sensitive,
                    pendingApproval: false,
                  });
                }}
              >
                <span className="min-w-0 break-words">{task.title}</span>
                <StatusBadge status={task.id === last?.taskId ? last.status : task.status} />
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
interface EventRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}
/** Real live SSE with persistent IDs, bounded rendering, reconnect and explicit errors. */
export function RunEvents({
  taskId,
  onStatus,
}: {
  taskId: string;
  onStatus?: (status: string, pendingApproval?: boolean) => void;
}) {
  const [events, setEvents] = useState<EventRow[]>([]),
    [state, setState] = useState("连接中"),
    [final, setFinal] = useState(""),
    [error, setError] = useState("");
  const seen = useRef(new Set<string>()),
    cursor = useRef("");
  useEffect(() => {
    const ctrl = new AbortController();
    let stopped = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    void (async () => {
      while (!stopped) {
        try {
          setState(cursor.current ? "重连中" : "连接中");
          const response = await fetch(`/api/tasks/${taskId}/events`, {
            headers: {
              authorization: `Bearer ${getToken() ?? ""}`,
              ...(cursor.current ? { "last-event-id": cursor.current } : {}),
            },
            signal: ctrl.signal,
          });
          if (response.status === 401 || response.status === 403) {
            setState("访问已失效");
            setError(`HTTP ${response.status}：请重新登录或联系项目管理员`);
            if (response.status === 401) {
              setToken(null);
              window.dispatchEvent(new Event("poros-auth-expired"));
            }
            break;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setState("接收中");
          setError("");
          const reader = response.body!.getReader(),
            decoder = new TextDecoder();
          let buf = "",
            status = "",
            pendingApproval = false;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buf += decoder.decode(chunk.value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const frame of frames) {
              const lines = frame.split("\n"),
                kind = lines.find((l) => l.startsWith("event: "))?.slice(7),
                id = lines.find((l) => l.startsWith("id: "))?.slice(4),
                data = lines.find((l) => l.startsWith("data: "))?.slice(6);
              if (!kind || !data) continue;
              const decoded = JSON.parse(data) as {
                payload: Record<string, unknown>;
                status?: string;
                pendingApproval?: boolean;
              };
              if (kind === "done") {
                status = decoded.status ?? "";
                pendingApproval = decoded.pendingApproval === true;
                onStatus?.(status, pendingApproval);
                setState(pendingApproval ? "等待审批" : status === "BLOCKED" ? "已阻止" : "已结束");
              } else if (kind === "error") throw new Error("连接中断，正在恢复事件");
              else if (kind === "reset") {
                seen.current.clear();
                setEvents([]);
                cursor.current = "";
              } else if (id && !seen.current.has(id)) {
                seen.current.add(id);
                cursor.current = id;
                onStatus?.("RUNNING", false);
                setEvents((prev) => [...prev, { id, kind, payload: decoded.payload }].slice(-500));
              }
            }
          }
          if (status && !pendingApproval) {
            const result = await api<{ runs: Array<{ output: string }> }>(
              "GET",
              `/api/tasks/${taskId}`,
            );
            if (result.ok) setFinal(result.body.runs[0]?.output ?? "");
            break;
          }
        } catch (e) {
          if (stopped) break;
          setError(e instanceof Error ? e.message : "连接失败");
          setState("重连中");
        }
        await sleep(1000);
      }
    })();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [taskId, onStatus]);
  return (
    <Card>
      <div className="mb-2 flex gap-2">
        <span>运行事件</span>
        <Badge>{state}</Badge>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="max-h-80 space-y-1 overflow-auto font-mono text-xs">
        {events.map((e) => (
          <div key={e.id} className="rounded bg-[#faf9f7] px-2 py-1">
            <Badge>{e.kind}</Badge>
            <span className="ml-2 break-all">{JSON.stringify(e.payload)}</span>
          </div>
        ))}
        {!events.length && <p>等待执行事件…</p>}
      </div>
      {final && <pre className="mt-3 whitespace-pre-wrap text-sm">{final}</pre>}
    </Card>
  );
}
