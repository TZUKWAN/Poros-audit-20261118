import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import {
  capabilityBlock,
  dateTime,
  modelPreflight,
  sensitiveGrants,
  type Agent,
  type CatalogEntry,
  type Project,
  type StoredFile,
  type TaskRow,
} from "../pc.js";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeading,
  Select,
  StatusBadge,
  Textarea,
} from "../ui.js";
import type { SettingsBody } from "./integrations.js";
import RunDetails from "./run-details.js";

function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function TaskList({
  projectId,
  onOpen,
  refresh = 0,
  title = "我的任务",
}: {
  projectId?: string;
  onOpen: (id: string) => void;
  refresh?: number;
  title?: string;
}) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const query = new URLSearchParams({
      q,
      page: String(page),
      ...(projectId ? { projectId } : {}),
    });
    const r = await api<{ tasks: TaskRow[]; hasMore: boolean }>("GET", "/api/tasks?" + query);
    if (!r.ok) {
      setError(r.body.error ?? "读取任务失败");
      return;
    }
    setError("");
    setRows(r.body.tasks);
    setMore(r.body.hasMore);
  }, [projectId, q, page]);
  useEffect(() => {
    void load();
  }, [load, refresh]);
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        <Button variant="ghost" onClick={() => void load()}>
          刷新任务
        </Button>
      </div>
      <Input
        aria-label="搜索任务"
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
          setPage(1);
        }}
        placeholder="按任务内容搜索"
      />
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      ) : (
        <>
          {!rows.length && <p className="mt-3 text-sm text-slate-600">暂无任务</p>}
          <ul className="mt-2 space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => onOpen(row.id)}
                >
                  <span className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">{row.title}</span>
                    <StatusBadge status={row.status} />
                  </span>
                  <span className="text-xs text-slate-600">
                    {row.createdBy} · {dateTime(row.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {(page > 1 || more) && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button variant="ghost" disabled={!more} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      )}
    </Card>
  );
}

export default function WorkspaceView({ email }: { email: string }) {
  const key = "poros-workspace-task:" + email;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<SettingsBody | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [consent, setConsent] = useState(false);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [file, setFile] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileSelection, setFileSelection] = useState<StoredFile[]>([]);
  const [taskId, setTaskId] = useState(() => sessionStorage.getItem(key) ?? "");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingRequest = useRef<{ body: string; key: string } | null>(null);
  const refreshTasks = useCallback(() => setRefresh((value) => value + 1), []);
  const open = (id: string) => {
    setTaskId(id);
    sessionStorage.setItem(key, id);
  };
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<{ agents: Agent[] }>("GET", "/api/agents"),
      api<{ projects: Project[] }>("GET", "/api/projects"),
      api<SettingsBody>("GET", "/api/settings/integrations"),
      api<{ capabilities: CatalogEntry[] }>("GET", "/api/capabilities"),
    ]).then(([a, p, s, c]) => {
      if (!alive) return;
      if (a.ok) {
        setAgents(a.body.agents);
        setAgentId(
          a.body.agents.find((row) => row.releaseReady && !row.projectRestricted)?.id ?? "",
        );
      }
      if (p.ok)
        setProjects(p.body.projects.filter((row) => !row.archivedAt && row.role !== "VIEWER"));
      if (s.ok) setSettings(s.body);
      if (c.ok) setCatalog(c.body.capabilities);
      const failure = [a, p, s, c].find((r) => !r.ok);
      if (failure) setError(failure.body.error ?? "读取任务条件失败");
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const query = new URLSearchParams({ q: fileQuery, ...(projectId ? { projectId } : {}) });
    let alive = true;
    void api<{ files: StoredFile[] }>("GET", "/api/files?" + query).then((r) => {
      if (alive && r.ok) setFiles(r.body.files.filter((f) => f.textSupported));
      else if (alive) setError(r.body.error ?? "读取可用文件失败");
    });
    return () => {
      alive = false;
    };
  }, [projectId, fileQuery]);
  const available = agents.filter(
    (a) =>
      a.releaseReady && (!a.projectRestricted || a.projects.some((p) => p.projectId === projectId)),
  );
  const agent = available.find((a) => a.id === agentId);
  const manifest = agent?.versions.find((v) => v.version === agent.currentVersion)?.manifest;
  const model = modelPreflight(manifest?.grants ?? [], settings);
  const capabilityIssue = capabilityBlock(manifest?.grants ?? [], settings, catalog, projectId);
  const tools = sensitiveGrants(manifest?.grants ?? []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = {
      agentId,
      projectId: projectId || undefined,
      prompt,
      fileIds: fileSelection.map((v) => v.id),
      consent: consent ? tools : [],
    };
    const signature = JSON.stringify(body);
    if (pendingRequest.current?.body !== signature)
      pendingRequest.current = { body: signature, key: requestKey() };
    const r = await api<{ taskId: string }>("POST", "/api/tasks", body, {
      "idempotency-key": pendingRequest.current.key,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.body.error ?? "提交失败");
      return;
    }
    pendingRequest.current = null;
    open(r.body.taskId);
    setConsent(false);
    setFileSelection([]);
    setFile("");
    setFileQuery("");
    refreshTasks();
  };
  return (
    <>
      <PageHeading title="工作台" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.8fr)_minmax(260px,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <h3 className="mb-3 font-semibold">下达任务</h3>
            <form className="grid gap-3" onSubmit={submit}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="任务项目">
                  <Select
                    value={projectId}
                    onChange={(event) => {
                      setProjectId(event.target.value);
                      setFileSelection([]);
                      setFile("");
                      setFiles([]);
                      setConsent(false);
                    }}
                  >
                    <option value="">个人任务</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Agent">
                  <Select
                    value={agent?.id ?? ""}
                    onChange={(e) => {
                      setAgentId(e.target.value);
                      setConsent(false);
                    }}
                  >
                    <option value="">选择已审批 Agent</option>
                    {available.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · v{a.currentVersion}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {agent && (
                <p>
                  <Badge tone={model.blocked ? "warn" : "neutral"}>{model.label}</Badge>
                </p>
              )}
              {capabilityIssue && (
                <p role="status" className="text-sm text-amber-900">
                  {capabilityIssue}
                </p>
              )}
              <Textarea
                aria-label="任务"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={20000}
                placeholder="填写要交给 Agent 的任务"
              />
              <details className="rounded-lg border border-slate-200 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  输入文件 {fileSelection.length > 0 && ` · ${fileSelection.length}`}
                </summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="按名称搜索可引用文件"
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    className="max-w-60"
                  />
                  <Select
                    aria-label="任务输入文件"
                    value={file}
                    onChange={(e) => setFile(e.target.value)}
                  >
                    <option value="">选择可提取文本的文件</option>
                    {files
                      .filter((row) => !fileSelection.some((f) => f.id === row.id))
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={!file || fileSelection.length === 3}
                    onClick={() => {
                      const row = files.find((f) => f.id === file);
                      if (row) setFileSelection((selected) => [...selected, row]);
                      setFile("");
                    }}
                  >
                    添加输入文件
                  </Button>
                </div>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {fileSelection.map((row) => (
                    <li key={row.id}>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() =>
                          setFileSelection((selected) => selected.filter((f) => f.id !== row.id))
                        }
                      >
                        {row.name} · 移除
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
              {tools.length > 0 && (
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />{" "}
                  同意本次使用 {tools.join("、")}，通过独立审批后执行
                </label>
              )}
              <div>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !agent ||
                    !prompt.trim() ||
                    model.blocked ||
                    Boolean(capabilityIssue) ||
                    (tools.length > 0 && !consent)
                  }
                >
                  {busy ? "正在提交…" : "提交任务"}
                </Button>
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-800">
                  {error}
                </p>
              )}
            </form>
          </Card>
          {taskId && <RunDetails key={taskId} taskId={taskId} onChanged={refreshTasks} />}
        </div>
        <aside className="min-w-0">
          <TaskList refresh={refresh} onOpen={open} />
        </aside>
      </div>
    </>
  );
}

export function RunCenter({ taskId, onOpen }: { taskId: string; onOpen: (id: string) => void }) {
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  return (
    <>
      <PageHeading title="运行中心" />
      <div className="grid gap-4 lg:grid-cols-[minmax(250px,1fr)_minmax(0,2.4fr)]">
        <TaskList refresh={refresh} onOpen={onOpen} />
        {taskId ? (
          <RunDetails key={taskId} taskId={taskId} onChanged={reload} />
        ) : (
          <Card>
            <p className="text-sm">选择任务查看执行证据与结果。</p>
          </Card>
        )}
      </div>
    </>
  );
}
