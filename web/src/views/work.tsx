import { useCallback, useEffect, useRef, useState } from "react";
import { api, type OrgInfo } from "../api.js";
import type { WorkStart } from "../navigation.js";
import {
  capabilityBlock,
  dateTime,
  modelPreflight,
  sensitiveGrants,
  type Agent,
  type CatalogEntry,
  type Project,
  type StoredFile,
} from "../pc.js";
import { Badge, Button, Card, Dialog, Field, Input, Select, StatusBadge, Textarea } from "../ui.js";
import IntegrationsView, { type SettingsBody } from "./integrations.js";
import RunDetails from "./run-details.js";

type Conversation = {
  id: string;
  title: string;
  agentId: string | null;
  projectId: string | null;
  createdBy: string;
  updatedAt: string;
};
type Turn = {
  id: string;
  turn: number;
  prompt: string;
  status: string;
  pendingApproval: boolean;
  intent: string;
  parentRunId: string | null;
  createdBy: string;
  createdAt: string;
  runs: Array<{
    id: string;
    output: string;
    artifact: { name: string; revisionOfId: string | null } | null;
  }>;
};
type WorkDetail = {
  conversation: Conversation;
  tasks: Turn[];
  hasMore: boolean;
  writable: boolean;
  project: { name: string; archivedAt: string | null } | null;
};
type Draft = {
  prompt: string;
  agentId: string;
  projectId: string;
  fileIds: string[];
  parentRunId: string;
};
function readDraft(key: string, start: WorkStart): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<Draft> | null;
    if (saved && typeof saved.prompt === "string")
      return {
        prompt: saved.prompt,
        agentId: String(saved.agentId ?? start.agentId ?? ""),
        projectId: String(saved.projectId ?? start.projectId ?? ""),
        fileIds: Array.isArray(saved.fileIds)
          ? saved.fileIds.filter((id): id is string => typeof id === "string").slice(0, 3)
          : [],
        parentRunId: String(saved.parentRunId ?? ""),
      };
  } catch {
    /* A corrupt or unavailable local draft does not prevent server work. */
  }
  return {
    prompt: "",
    agentId: start.agentId ?? "",
    projectId: start.projectId ?? "",
    fileIds: start.fileIds?.slice(0, 3) ?? [],
    parentRunId: "",
  };
}

export function ConversationList({
  onOpen,
  selectedId,
  refresh = 0,
  projectId,
}: {
  onOpen: (id: string) => void;
  selectedId?: string;
  refresh?: number;
  projectId?: string;
}) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<
    Array<Conversation & { project: { name: string } | null; tasks: Array<{ status: string }> }>
  >([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({
      q,
      page: String(page),
      ...(projectId ? { projectId } : {}),
    });
    const r = await api<{ conversations: typeof rows; hasMore: boolean }>(
      "GET",
      "/api/conversations?" + query,
    );
    setLoading(false);
    if (!r.ok) {
      setError(r.body.error ?? "工作列表读取失败");
      return;
    }
    setError("");
    setRows(r.body.conversations);
    setMore(r.body.hasMore);
  }, [q, page, projectId]);
  useEffect(() => {
    void reload();
  }, [reload, refresh]);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{projectId ? "项目工作" : "最近工作"}</h3>
        <Button variant="ghost" onClick={() => void reload()}>
          刷新工作
        </Button>
      </div>
      <Input
        aria-label="搜索工作"
        placeholder="搜索已保存的工作"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          正在读取工作…
        </p>
      )}
      {!loading && !error && !rows.length && (
        <p className="mt-3 text-sm text-slate-600">
          还没有工作。发送第一条要求后会自动保存在这里。
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              className="w-full rounded-lg border border-[#e3e1dc] p-3 text-left hover:bg-[#faf8f5] aria-[current=true]:border-[#c9694b] aria-[current=true]:bg-[#fbf3ef]"
              aria-current={row.id === selectedId ? "true" : undefined}
              onClick={() => onOpen(row.id)}
            >
              <span className="block break-words text-sm font-medium">{row.title}</span>
              <span className="mt-2 flex flex-wrap items-center gap-2">
                {row.tasks[0] && <StatusBadge status={row.tasks[0].status} />}
                <span className="text-xs text-slate-600">{row.project?.name ?? "个人工作"}</span>
              </span>
              <span className="mt-1 block text-xs text-slate-500">{dateTime(row.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
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

export default function WorkView({
  auth,
  conversationId,
  initialTaskId,
  start,
  onOpen,
  onSelectTask,
  onStart,
  onAgents,
  onProject,
  onGovernance,
}: {
  auth: OrgInfo;
  conversationId?: string;
  initialTaskId?: string;
  start: WorkStart;
  onOpen: (id: string, taskId?: string) => void;
  onSelectTask: (taskId: string) => void;
  onStart: (start?: WorkStart) => void;
  onAgents: () => void;
  onProject: (id: string) => void;
  onGovernance: (taskId: string) => void;
}) {
  const draftKey = `poros-work:${auth.organizationId}:${auth.email}:${conversationId ?? JSON.stringify([start.agentId, start.projectId, start.fileIds])}`;
  const [draft, setDraft] = useState(() => readDraft(draftKey, start));
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [settings, setSettings] = useState<SettingsBody | null>(null);
  const [selectedTask, setSelectedTask] = useState(initialTaskId ?? "");
  const [earlierTask, setEarlierTask] = useState<{
    id: string;
    prompt: string;
    turn: number;
  } | null>(null);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<StoredFile[]>([]);
  const [fileStates, setFileStates] = useState<Record<string, string>>({});
  const [fileQuery, setFileQuery] = useState("");
  const [fileChoice, setFileChoice] = useState("");
  const [consent, setConsent] = useState(false);
  const [connections, setConnections] = useState(false);
  const [connectionProviders, setConnectionProviders] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [savedPending] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(draftKey + ":pending") ?? "null") as {
        signature?: string;
        key?: string;
      } | null;
      return value && typeof value.signature === "string" && typeof value.key === "string"
        ? { signature: value.signature, key: value.key }
        : null;
    } catch {
      return null;
    }
  });
  const pending = useRef<{ signature: string; key: string } | null>(savedPending);
  const projectId = work?.conversation.projectId ?? draft.projectId;
  const agentId = work?.conversation.agentId ?? draft.agentId;
  const writable = work ? work.writable : true;
  const update = (patch: Partial<Draft>) => setDraft((value) => ({ ...value, ...patch }));
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      /* Server submission remains available without local storage. */
    }
  }, [draft, draftKey]);
  const loadConditions = useCallback(async () => {
    const [a, p, s, c] = await Promise.all([
      api<{ agents: Agent[] }>("GET", "/api/agents"),
      api<{ projects: Project[] }>("GET", "/api/projects"),
      api<SettingsBody>("GET", "/api/settings/integrations"),
      api<{ capabilities: CatalogEntry[] }>("GET", "/api/capabilities"),
    ]);
    if (a.ok) setAgents(a.body.agents);
    if (p.ok) setProjects(p.body.projects);
    if (s.ok) setSettings(s.body);
    if (c.ok) setCatalog(c.body.capabilities);
    const failure = [a, p, s, c].find((r) => !r.ok);
    if (failure) setError(failure.body.error ?? "读取工作条件失败");
    setLoading(false);
  }, []);
  const loadWork = useCallback(async () => {
    if (!conversationId) return;
    const r = await api<WorkDetail>("GET", `/api/conversations/${conversationId}`);
    if (!r.ok) {
      setError(r.body.error ?? "工作读取失败");
      setWork(null);
      return;
    }
    setWork((previous) => ({
      ...r.body,
      tasks: previous
        ? [
            ...previous.tasks.filter((task) => !r.body.tasks.some((next) => next.id === task.id)),
            ...r.body.tasks,
          ]
        : r.body.tasks,
    }));
    setSelectedTask((previous) => previous || r.body.tasks.at(-1)?.id || "");
  }, [conversationId]);
  useEffect(() => {
    void loadConditions();
    void loadWork();
  }, [loadConditions, loadWork]);
  useEffect(() => {
    if (initialTaskId) setSelectedTask(initialTaskId);
  }, [initialTaskId]);
  useEffect(() => {
    if (!work || !selectedTask || work.tasks.some((task) => task.id === selectedTask)) {
      setEarlierTask(null);
      return;
    }
    let alive = true;
    void api<{ task: { id: string; prompt: string; turn: number; conversationId: string | null } }>(
      "GET",
      `/api/tasks/${selectedTask}`,
    ).then((response) => {
      if (!alive) return;
      if (response.ok && response.body.task.conversationId === conversationId)
        setEarlierTask(response.body.task);
      else {
        setEarlierTask(null);
        setError(response.body.error ?? "所选请求不属于当前工作或已不可访问");
      }
    });
    return () => {
      alive = false;
    };
  }, [work, selectedTask, conversationId]);
  const selectTask = (id: string) => {
    setSelectedTask(id);
    onSelectTask(id);
  };
  const changed = useCallback(() => {
    setRefresh((n) => n + 1);
    void loadWork();
  }, [loadWork]);
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams({ q: fileQuery, ...(projectId ? { projectId } : {}) });
    void api<{ files: StoredFile[] }>("GET", "/api/files?" + query).then((r) => {
      if (!alive) return;
      if (r.ok) setFiles(r.body.files.filter((file) => file.textSupported));
      else setError(r.body.error ?? "文件读取失败");
    });
    return () => {
      alive = false;
    };
  }, [fileQuery, projectId, refresh]);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      draft.fileIds.map(async (id) => {
        const [file, preview] = await Promise.all([
          api<{ file: StoredFile }>("GET", `/api/files/${id}`),
          api<{ preview: { text: string; truncated: boolean } }>(
            "GET",
            `/api/files/${id}/preview`,
            undefined,
            {},
            30000,
          ),
        ]);
        return {
          id,
          file: file.ok ? file.body.file : null,
          state: !file.ok
            ? (file.body.error ?? "文件不可访问")
            : !preview.ok
              ? (preview.body.error ?? "读取失败")
              : !preview.body.preview.text.trim()
                ? "未提取到文字，请移除或替换"
                : "已提取文字 · 执行时最多引用 1500 字",
        };
      }),
    ).then((rows) => {
      if (!alive) return;
      setSelectedFiles(rows.flatMap((row) => (row.file ? [row.file] : [])));
      setFileStates(Object.fromEntries(rows.map((row) => [row.id, row.state])));
    });
    return () => {
      alive = false;
    };
  }, [draft.fileIds]);
  const available = agents.filter(
    (agent) =>
      agent.releaseReady &&
      (!agent.projectRestricted ||
        agent.projects.some((project) => project.projectId === projectId)),
  );
  const agent = available.find((row) => row.id === agentId);
  const manifest = agent?.versions.find(
    (version) => version.version === agent.currentVersion,
  )?.manifest;
  const model = modelPreflight(manifest?.grants ?? [], settings);
  const capabilityIssue = capabilityBlock(manifest?.grants ?? [], settings, catalog, projectId);
  const tools = sensitiveGrants(manifest?.grants ?? []);
  const requiredProviders = [
    ...new Set([
      ...(manifest?.grants.some(
        (grant) => grant.kind === "MODEL" && grant.source.startsWith("personal-openai-compatible:"),
      )
        ? ["model"]
        : []),
      ...catalog
        .filter(
          (entry) =>
            entry.provider &&
            manifest?.grants.some(
              (grant) => grant.name === entry.name && grant.kind === entry.kind,
            ),
        )
        .flatMap((entry) => (entry.provider ? [entry.provider] : [])),
    ]),
  ];
  const filesReady = draft.fileIds.every((id) => fileStates[id]?.startsWith("已提取文字"));
  const latest = work?.tasks.at(-1);
  const resultLabel = (runId: string) => {
    const source = work?.tasks.find((turn) => turn.runs.some((run) => run.id === runId));
    return source ? `第 ${source.turn} 条结果` : "已选历史结果";
  };
  const inProgress =
    latest && (["QUEUED", "RUNNING"].includes(latest.status) || latest.pendingApproval);
  const canSubmit = Boolean(
    writable &&
    (!conversationId || work) &&
    agent &&
    draft.prompt.trim() &&
    !busy &&
    !loading &&
    filesReady &&
    !model.blocked &&
    !capabilityIssue &&
    (!tools.length || consent),
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    const body = {
      agentId,
      projectId: projectId || undefined,
      conversationId,
      prompt: draft.prompt,
      fileIds: draft.fileIds,
      consent: consent ? tools : [],
      parentRunId: draft.parentRunId || undefined,
      intent: draft.parentRunId ? "REVISION" : conversationId ? "FOLLOW_UP" : "REQUEST",
    };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        key: Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join(""),
      };
    try {
      localStorage.setItem(draftKey + ":pending", JSON.stringify(pending.current));
    } catch {
      /* The in-memory key still protects repeat submissions. */
    }
    const r = await api<{ taskId: string; conversationId: string }>("POST", "/api/tasks", body, {
      "idempotency-key": pending.current.key,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.body.error ?? "发送失败，保留原输入，可再次发送确认受理状态");
      return;
    }
    pending.current = null;
    update({ prompt: "", fileIds: [], parentRunId: "" });
    setConsent(false);
    try {
      localStorage.removeItem(draftKey);
      localStorage.removeItem(draftKey + ":pending");
    } catch {
      /* Optional local draft. */
    }
    setSelectedTask(r.body.taskId);
    changed();
    if (!conversationId) onOpen(r.body.conversationId, r.body.taskId);
    else onSelectTask(r.body.taskId);
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.size || file.size > 5 * 1024 * 1024) {
      setError("文件必须为 1 字节至 5 MiB");
      return;
    }
    setUploading(true);
    setError("");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let raw = "";
    for (let i = 0; i < bytes.length; i += 8192)
      raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const r = await api<{ file: StoredFile }>(
      "POST",
      "/api/files",
      { name: file.name, contentBase64: btoa(raw), projectId: projectId || undefined },
      {},
      30000,
    );
    setUploading(false);
    if (!r.ok) {
      setError(r.body.error ?? "上传失败");
      return;
    }
    update({ fileIds: [...draft.fileIds, r.body.file.id] });
    setRefresh((n) => n + 1);
  };
  return (
    <div className="mx-auto grid max-w-[1240px] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <main className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold">
              {work?.conversation.title ?? (conversationId ? "读取工作" : "开始一项工作")}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {work?.project?.name ??
                projects.find((p) => p.id === projectId)?.name ??
                (projectId ? "正在读取项目范围…" : "个人工作")}{" "}
              ·{" "}
              {projectId
                ? "项目成员可见，执行使用发起人的权限与连接"
                : "本人可继续，组织管理员与审阅者可审计"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {projectId && (
              <Button variant="ghost" onClick={() => onProject(projectId)}>
                返回项目
              </Button>
            )}
          </div>
        </div>
        {work && (
          <section aria-label="工作记录" className="space-y-3">
            {earlierTask && (
              <Card>
                <h3 className="mb-2 font-semibold">已定位到第 {earlierTask.turn} 条请求</h3>
                <p className="mb-3 whitespace-pre-wrap text-sm">{earlierTask.prompt}</p>
                <RunDetails
                  key={earlierTask.id}
                  taskId={earlierTask.id}
                  onChanged={changed}
                  conversationMode
                  onConnections={() => setConnections(true)}
                  onGovernance={onGovernance}
                  onRevise={
                    writable
                      ? (runId) => {
                          update({ parentRunId: runId });
                          composer.current?.focus();
                        }
                      : undefined
                  }
                />
                <Button
                  className="mt-3"
                  variant="ghost"
                  onClick={() => {
                    const latest = work.tasks.at(-1);
                    if (latest) selectTask(latest.id);
                  }}
                >
                  查看最近结果
                </Button>
              </Card>
            )}
            {work.hasMore && (
              <Button
                variant="ghost"
                onClick={async () => {
                  const before = work.tasks[0]?.turn;
                  const r = await api<WorkDetail>(
                    "GET",
                    `/api/conversations/${conversationId}?before=${before}`,
                  );
                  if (!r.ok) {
                    setError(r.body.error ?? "历史读取失败");
                    return;
                  }
                  setWork((current) =>
                    current
                      ? {
                          ...current,
                          tasks: [...r.body.tasks, ...current.tasks],
                          hasMore: r.body.hasMore,
                        }
                      : current,
                  );
                }}
              >
                加载更早记录
              </Button>
            )}
            {work.tasks.map((turn) => (
              <div key={turn.id} className="rounded-xl border border-[#e3e1dc] bg-[#faf8f5] p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span>
                    第 {turn.turn} 条 ·{" "}
                    {turn.intent === "REVISION"
                      ? "修改结果"
                      : turn.intent === "FOLLOW_UP"
                        ? "继续工作"
                        : "开始工作"}
                  </span>
                  {turn.pendingApproval ? (
                    <Badge tone="warn">等待独立审批</Badge>
                  ) : (
                    <StatusBadge status={turn.status} />
                  )}
                  <span>{turn.createdBy}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{turn.prompt}</p>
                {turn.parentRunId && (
                  <p className="mt-2 break-all text-xs text-slate-500">
                    修改对象 · {resultLabel(turn.parentRunId)}
                  </p>
                )}
                {selectedTask !== turn.id && (
                  <>
                    {turn.runs[0]?.output && (
                      <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm text-slate-600">
                        {turn.runs[0].output}
                      </p>
                    )}
                    <Button className="mt-3" variant="ghost" onClick={() => selectTask(turn.id)}>
                      查看第 {turn.turn} 条结果与过程
                    </Button>
                  </>
                )}
                {selectedTask === turn.id && (
                  <div className="mt-3">
                    <RunDetails
                      key={turn.id}
                      taskId={turn.id}
                      onChanged={changed}
                      conversationMode
                      onConnections={() => setConnections(true)}
                      onGovernance={onGovernance}
                      onRevise={
                        writable
                          ? (runId) => {
                              update({ parentRunId: runId });
                              composer.current?.focus();
                              composer.current?.scrollIntoView({
                                block: "center",
                                behavior: "smooth",
                              });
                            }
                          : undefined
                      }
                    />
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
        {(!conversationId || work) &&
          (writable ? (
            <Card className="sm:p-5">
              <h3 className="mb-3 font-semibold">
                {draft.parentRunId
                  ? "这次要怎样修改"
                  : conversationId
                    ? "继续这项工作"
                    : "告诉助手要做什么"}
              </h3>
              <form className="grid gap-3" onSubmit={submit}>
                {draft.parentRunId && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#fbf3ef] p-2 text-sm">
                    <span>修改结果 · {resultLabel(draft.parentRunId)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => update({ parentRunId: "" })}
                    >
                      取消修改对象
                    </Button>
                  </div>
                )}
                <Textarea
                  ref={composer}
                  aria-label="任务"
                  rows={4}
                  value={draft.prompt}
                  maxLength={20000}
                  placeholder={
                    conversationId ? "补充要求，或回答助手的问题" : "描述目标、所需材料和期望结果"
                  }
                  onChange={(e) => update({ prompt: e.target.value })}
                />
                <div className="flex flex-wrap items-end gap-3">
                  {!conversationId ? (
                    <Field label="Agent">
                      <Select
                        className="min-h-10 max-w-full"
                        disabled={Boolean(conversationId)}
                        value={agent?.id ?? ""}
                        onChange={(e) => {
                          update({ agentId: e.target.value });
                          setConsent(false);
                        }}
                      >
                        <option value="">{loading ? "正在读取助手…" : "选择一个已发布助手"}</option>
                        {available.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.name} · v{row.currentVersion}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <p className="text-sm">
                      {agent?.name ?? "正在核对原助手…"}
                      {agent ? ` · 下一条使用已审批 v${agent.currentVersion}` : ""}
                    </p>
                  )}
                  {agent && (
                    <Badge
                      tone={
                        model.blocked || settings?.modelMode === "SIMULATION" ? "warn" : "neutral"
                      }
                    >
                      {model.label}
                    </Badge>
                  )}
                </div>
                {agent && !conversationId && (
                  <p className="text-sm text-slate-600">
                    {agent.description || "此助手尚未填写用途说明"}
                  </p>
                )}
                {!loading && !agent && (
                  <p className="text-sm text-amber-900">
                    {agentId
                      ? "原助手当前不可执行，请查看发布和项目授权。"
                      : "先选择适合这项工作的助手。"}{" "}
                    <button type="button" className="underline" onClick={onAgents}>
                      打开 Agent 目录
                    </button>
                  </p>
                )}
                {((model.blocked && agent) || capabilityIssue) && (
                  <div role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    {capabilityIssue || model.label}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setConnectionProviders(
                            requiredProviders.length ? requiredProviders : undefined,
                          );
                          setConnections(true);
                        }}
                      >
                        配置所需连接
                      </Button>
                      <Button type="button" variant="ghost" onClick={onAgents}>
                        查看助手授权
                      </Button>
                    </div>
                  </div>
                )}
                <details
                  className="rounded-lg border border-[#e3e1dc] p-3"
                  open={draft.fileIds.length ? true : undefined}
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    项目与文件
                    {draft.fileIds.length ? ` · ${draft.fileIds.length} 个文件` : "（可选）"}
                  </summary>
                  <div className="mt-3 grid gap-3">
                    <Field label="任务项目">
                      <Select
                        className="min-h-10"
                        value={projectId}
                        disabled={Boolean(conversationId) || loading}
                        onChange={(e) => {
                          update({ projectId: e.target.value, fileIds: [] });
                          setFiles([]);
                          setConsent(false);
                          setFileChoice("");
                        }}
                      >
                        <option value="">个人工作</option>
                        {projectId && !projects.some((row) => row.id === projectId) && (
                          <option value={projectId}>
                            {loading ? "正在读取项目范围…" : "原项目当前不可选"}
                          </option>
                        )}
                        {projects
                          .filter((row) => !row.archivedAt && row.role !== "VIEWER")
                          .map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <p className="text-xs text-slate-600">
                      每次最多新增 3 个输入文件，每个最多引用 1500
                      字。此前引用的文件会在后续请求重新校验并读取，历史请求和结果也会进入上下文，总计上限
                      64000 字符。更换助手、项目或移除历史资料请新建工作。
                    </p>
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label="按名称搜索可引用文件">
                        <Input value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} />
                      </Field>
                      <Field label="任务输入文件">
                        <Select
                          className="min-h-10 max-w-full"
                          value={fileChoice}
                          onChange={(e) => setFileChoice(e.target.value)}
                        >
                          <option value="">选择文件</option>
                          {files
                            .filter((row) => !draft.fileIds.includes(row.id))
                            .map((row) => (
                              <option key={row.id} value={row.id}>
                                {row.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={!fileChoice || draft.fileIds.length >= 3}
                        onClick={() => {
                          update({ fileIds: [...draft.fileIds, fileChoice] });
                          setFileChoice("");
                        }}
                      >
                        添加输入文件
                      </Button>
                    </div>
                    <Field label="上传并引用文件">
                      <Input
                        type="file"
                        disabled={uploading || draft.fileIds.length >= 3}
                        accept=".md,.txt,.csv,.json,.pdf,.docx,.xlsx"
                        onChange={(e) => {
                          void upload(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                    </Field>
                    {uploading && <p role="status">正在上传文件…</p>}
                    <ul className="space-y-2">
                      {draft.fileIds.map((id) => (
                        <li
                          key={id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-2 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="break-all">
                              {selectedFiles.find((file) => file.id === id)?.name ?? "所选文件"}
                            </p>
                            <p className="text-xs text-slate-600">
                              {fileStates[id] ?? "正在检查文件读取…"}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              update({ fileIds: draft.fileIds.filter((fileId) => fileId !== id) })
                            }
                          >
                            移除
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
                {tools.length > 0 && (
                  <div className="rounded-lg bg-[#faf8f5] p-3 text-sm">
                    <label>
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />{" "}
                      同意本次使用 {tools.join("、")}，通过独立审批后执行
                    </label>
                    <p className="mt-1 text-xs text-slate-600">
                      授权针对本次请求的全部列明能力，审批通过后任务开始。下一条请求需要重新同意。
                    </p>
                  </div>
                )}
                {inProgress && (
                  <p role="status" className="text-sm text-slate-600">
                    当前还有未结束的请求。新要求会保存为下一条，等前一条完成或审批结束后执行。
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setConnectionProviders(undefined);
                      setConnections(true);
                    }}
                  >
                    个人连接
                  </Button>
                  <Button type="submit" disabled={!canSubmit}>
                    {busy
                      ? "正在发送…"
                      : draft.parentRunId
                        ? "发送修改要求"
                        : conversationId
                          ? "发送后续要求"
                          : "开始工作"}
                  </Button>
                </div>
              </form>
            </Card>
          ) : (
            <Card>
              <p className="text-sm">
                您可以查看这项工作。继续执行需要项目写入资格；个人工作由发起人继续。
              </p>
            </Card>
          ))}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {error}
            <Button
              className="ml-2"
              variant="ghost"
              onClick={() => {
                setError("");
                void loadConditions();
                void loadWork();
              }}
            >
              重新读取
            </Button>
          </div>
        )}
      </main>
      <aside className="min-w-0 space-y-3">
        <Button className="w-full justify-center" variant="ghost" onClick={() => onStart()}>
          新建工作
        </Button>
        <ConversationList selectedId={conversationId} onOpen={onOpen} refresh={refresh} />
      </aside>
      <Dialog
        open={connections}
        onOpenChange={(open) => {
          setConnections(open);
          if (!open) void loadConditions();
        }}
        title="当前账号的个人连接"
      >
        <p className="mb-3 text-sm text-slate-600">
          要求和材料会保留。连接成功后返回工作，还需要助手已获得对应能力授权。
        </p>
        <IntegrationsView providers={connectionProviders} />
        <Button
          className="mt-4"
          onClick={() => {
            setConnections(false);
            void loadConditions();
          }}
        >
          返回当前工作
        </Button>
      </Dialog>
    </div>
  );
}
