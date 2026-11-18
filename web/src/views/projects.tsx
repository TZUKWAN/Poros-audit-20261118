import { useCallback, useEffect, useState } from "react";
import { api, download } from "../api.js";
import { dateTime, type Agent, type Project, type StoredFile } from "../pc.js";
import { Badge, Button, Card, Dialog, Field, Input, PageHeading, Select, Textarea } from "../ui.js";
import { TaskList } from "./workspace.js";

const projectRoles = { MANAGER: "项目管理员", CONTRIBUTOR: "协作者", VIEWER: "只读成员" };
const orgRoles = { ADMIN: "组织管理员", BUILDER: "构建者", EMPLOYEE: "成员", REVIEWER: "审阅者" };
type AuditEntry = {
  id: string;
  action: string;
  subjectId: string;
  actorId: string;
  createdAt: string;
};
const auditLabel: Record<string, string> = {
  "project.created": "创建项目",
  "project.updated": "修改项目",
  "project.archived": "归档项目",
  "project.membership.updated": "分配项目权限",
  "project.membership.removed": "移除项目成员",
  "project.agent.linked": "关联 Agent",
  "project.agent.unlinked": "解除 Agent 关联",
  "file.uploaded": "上传文件",
  "file.removed": "移除文件",
  "file.categorized": "调整分类",
  "task.submitted": "提交任务",
  "task.cancelled": "取消任务",
  "task.accepted": "采纳任务结果",
  "judgment.disabled": "停用规则",
  "member.enabled": "更新组织成员",
  "member.disabled": "停用组织成员",
};

export default function ProjectsView({
  email,
  role,
  onOpenTask,
}: {
  email: string;
  role: string;
  onOpenTask: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [create, setCreate] = useState(false);
  const refresh = useCallback(async () => {
    const r = await api<{ projects: Project[] }>("GET", "/api/projects");
    if (r.ok) setProjects(r.body.projects);
    else setError(r.body.error ?? "项目读取失败");
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <>
      <PageHeading title="项目空间">
        {role === "ADMIN" && <Button onClick={() => setCreate(true)}>新建项目</Button>}
      </PageHeading>
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,1fr)_minmax(0,3fr)]">
        <Card className="self-start">
          <Input
            aria-label="搜索项目"
            placeholder="按项目名称搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="mt-3 w-full rounded-lg border border-slate-200 p-2 text-left text-sm aria-pressed:border-[#c9694b]"
            aria-pressed={!selected}
            onClick={() => setSelected("")}
          >
            个人文件
          </button>
          {projects
            .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
            .map((p) => (
              <button
                key={p.id}
                aria-pressed={selected === p.id}
                onClick={() => setSelected(p.id)}
                className="mt-2 block w-full rounded-lg border border-slate-200 p-2 text-left hover:bg-slate-50 aria-pressed:border-[#c9694b]"
              >
                <strong className="block break-words text-sm">{p.name}</strong>
                <span className="text-xs text-slate-600">
                  {p.archivedAt ? "已归档" : projectRoles[p.role]}
                </span>
              </button>
            ))}
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-800">
              {error}
            </p>
          )}
        </Card>
        {selected ? (
          <ProjectDetails
            key={selected}
            id={selected}
            role={role}
            email={email}
            onOpenTask={onOpenTask}
            onChanged={refresh}
          />
        ) : (
          <FilesPanel email={email} canWrite canManage={role === "ADMIN"} onOpenTask={onOpenTask} />
        )}
      </div>
      {create && (
        <ProjectDialog
          close={() => setCreate(false)}
          saved={(project) => {
            setSelected(project.id);
            setCreate(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function ProjectDialog({
  project,
  close,
  saved,
}: {
  project?: Project;
  close: () => void;
  saved: (project: Project) => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={project ? "编辑项目" : "新建项目"}
    >
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await api<{ project: Project }>(
            project ? "PATCH" : "POST",
            project ? `/api/projects/${project.id}` : "/api/projects",
            { name, description },
          );
          setBusy(false);
          if (r.ok) saved(r.body.project);
          else setError(r.body.error ?? "保存项目失败");
        }}
      >
        <Field label="项目名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="项目说明">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
          />
        </Field>
        <Button type="submit" disabled={busy || !name.trim()}>
          保存项目
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

type ProjectDetail = {
  project: Project & {
    members: Array<{
      userId: string;
      role: keyof typeof projectRoles;
      organizationRole: keyof typeof orgRoles;
      available: boolean;
    }>;
  };
  agents: Agent[];
  availableMembers: Array<{ userId: string }>;
  audit: AuditEntry[];
};
function ProjectDetails({
  id,
  role,
  email,
  onOpenTask,
  onChanged,
}: {
  id: string;
  role: string;
  email: string;
  onOpenTask: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [section, setSection] = useState("tasks");
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    text: string;
    action: () => Promise<void>;
  } | null>(null);
  const [member, setMember] = useState("");
  const [memberRole, setMemberRole] = useState("CONTRIBUTOR");
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const r = await api<ProjectDetail>("GET", `/api/projects/${id}`);
    if (r.ok) setDetail(r.body);
    else setMessage(r.body.error ?? "读取项目失败");
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (section === "agents")
      void api<{ agents: Agent[] }>("GET", "/api/agents").then((r) => {
        if (r.ok) setAgents(r.body.agents);
      });
  }, [section]);
  const mutate = async (method: string, suffix: string, label: string, body?: unknown) => {
    setBusy(true);
    const r = await api(method, `/api/projects/${id}${suffix}`, body);
    setBusy(false);
    setMessage(r.ok ? label : (r.body.error ?? "项目操作失败"));
    if (r.ok) {
      void load();
      void onChanged();
    }
  };
  if (!detail)
    return (
      <Card>
        <p role="status">{message || "正在读取项目…"}</p>
      </Card>
    );
  const { project } = detail;
  const canManage = project.role === "MANAGER" && !project.archivedAt;
  const canWrite = project.role !== "VIEWER" && !project.archivedAt;
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-lg font-semibold">{project.name}</h3>
          <Badge>{project.archivedAt ? "已归档 · 只读" : projectRoles[project.role]}</Badge>
          {canManage && (
            <>
              <Button variant="ghost" onClick={() => setEdit(true)}>
                编辑项目
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  setConfirm({
                    title: "归档项目",
                    text: "归档后项目保留供查看，并停止新增或执行项目任务。",
                    action: () => mutate("PATCH", "", "项目已归档", { archive: true }),
                  })
                }
              >
                归档项目
              </Button>
            </>
          )}
        </div>
        {project.description && (
          <p className="mt-2 whitespace-pre-wrap text-sm">{project.description}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            ["tasks", "项目任务"],
            ["files", "文件"],
            ["members", "项目成员"],
            ["agents", "关联 Agent"],
            ...(project.role === "MANAGER" ? [["audit", "操作审计"]] : []),
          ].map(([key, label]) => (
            <Button
              key={key}
              variant={section === key ? "primary" : "ghost"}
              onClick={() => setSection(key!)}
              aria-pressed={section === key}
            >
              {label}
            </Button>
          ))}
        </div>
        {message && (
          <p role="status" className="mt-2 text-sm">
            {message}
          </p>
        )}
      </Card>
      {section === "tasks" && (
        <TaskList projectId={id} title="项目任务与运行" onOpen={onOpenTask} />
      )}
      {section === "files" && (
        <FilesPanel
          email={email}
          projectId={id}
          canWrite={canWrite}
          canManage={canManage}
          onOpenTask={onOpenTask}
        />
      )}
      {section === "members" && (
        <Card>
          <h4 className="mb-2 font-semibold">项目成员</h4>
          <ul className="space-y-1 text-sm">
            {project.members.map((m) => (
              <li
                key={m.userId}
                className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 p-2"
              >
                <span>
                  {m.userId} · {projectRoles[m.role]}
                  {!m.available && " · 组织访问已停用"}
                </span>
                {canManage && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setConfirm({
                        title: "移除项目成员",
                        text: `移除 ${m.userId} 对此项目的访问。`,
                        action: () =>
                          mutate(
                            "DELETE",
                            "/members/" + encodeURIComponent(m.userId),
                            "项目权限已移除",
                          ),
                      })
                    }
                    aria-label={"移除项目成员 " + m.userId}
                  >
                    移除
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="组织成员">
                <Select
                  value={member}
                  onChange={(e) => {
                    setMember(e.target.value);
                    setMemberRole(
                      project.members.find((m) => m.userId === e.target.value)?.role ??
                        "CONTRIBUTOR",
                    );
                  }}
                >
                  <option value="">选择成员</option>
                  {detail.availableMembers.map((m) => (
                    <option key={m.userId}>{m.userId}</option>
                  ))}
                </Select>
              </Field>
              <Field label="项目角色">
                <Select value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                  {Object.entries(projectRoles).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <Button
                  disabled={!member || busy}
                  onClick={() =>
                    void mutate("PUT", "/members", "项目权限已保存", {
                      userId: member,
                      role: memberRole,
                    })
                  }
                >
                  保存项目权限
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
      {section === "agents" && (
        <Card>
          <h4 className="mb-2 font-semibold">关联 Agent</h4>
          {detail.agents.length === 0 && <p className="text-sm text-slate-600">暂无关联 Agent。</p>}
          {detail.agents.map((a) => (
            <div
              key={a.id}
              className="mb-2 flex items-center justify-between rounded bg-slate-50 p-2 text-sm"
            >
              <span>
                {a.name} · {a.currentVersion ? `v${a.currentVersion}` : "草稿"}
              </span>
              {canManage && ["ADMIN", "BUILDER"].includes(role) && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setConfirm({
                      title: "解除 Agent 关联",
                      text: `停止此项目对 ${a.name} 的执行授权。`,
                      action: () => mutate("DELETE", "/agents/" + a.id, "关联已解除"),
                    })
                  }
                >
                  解除关联
                </Button>
              )}
            </div>
          ))}
          {canManage && ["ADMIN", "BUILDER"].includes(role) && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="选择 Agent">
                <Select value={agent} onChange={(e) => setAgent(e.target.value)}>
                  <option value="">选择要关联的 Agent</option>
                  {agents
                    .filter((a) => !detail.agents.some((v) => v.id === a.id))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Button
                disabled={!agent || busy}
                onClick={() =>
                  setConfirm({
                    title: "关联 Agent",
                    text: "关联后的 Agent 只允许在已关联且有执行权限的项目运行。",
                    action: async () => {
                      await mutate("PUT", "/agents/" + agent, "已关联 Agent");
                      setAgent("");
                    },
                  })
                }
              >
                关联到项目
              </Button>
            </div>
          )}
        </Card>
      )}
      {section === "audit" && (
        <Card>
          <h4 className="mb-2 font-semibold">操作审计</h4>
          <AuditList rows={detail.audit} />
        </Card>
      )}
      {edit && (
        <ProjectDialog
          project={project}
          close={() => setEdit(false)}
          saved={() => {
            setEdit(false);
            void load();
            void onChanged();
          }}
        />
      )}
      {confirm && (
        <Confirm
          title={confirm.title}
          text={confirm.text}
          close={() => setConfirm(null)}
          execute={confirm.action}
        />
      )}
    </div>
  );
}

function AuditList({ rows }: { rows: AuditEntry[] }) {
  return rows.length ? (
    <ul className="divide-y divide-slate-200 text-sm">
      {rows.map((row) => (
        <li key={row.id} className="py-2">
          <strong>{auditLabel[row.action] ?? row.action}</strong> · {row.actorId} ·{" "}
          {dateTime(row.createdAt)}
          <p className="break-all text-xs text-slate-600">{row.subjectId}</p>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-slate-600">暂无操作审计。</p>
  );
}

export function Confirm({
  title,
  text,
  close,
  execute,
}: {
  title: string;
  text: string;
  close: () => void;
  execute: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && close()} title={title}>
      <p className="text-sm">{text}</p>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" disabled={busy} onClick={close}>
          返回
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await execute();
            close();
          }}
        >
          确认
        </Button>
      </div>
    </Dialog>
  );
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function FilesPanel({
  projectId,
  email,
  canWrite,
  canManage,
  onOpenTask,
}: {
  projectId?: string;
  email: string;
  canWrite: boolean;
  canManage: boolean;
  onOpenTask: (id: string) => void;
}) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [upload, setUpload] = useState<File | null>(null);
  const [category, setCategory] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{
    file: StoredFile;
    text: string;
    truncated: boolean;
  } | null>(null);
  const [usage, setUsage] = useState<{
    file: StoredFile;
    rows: Array<{
      runId: string;
      ref: string;
      chars: number;
      createdAt: string;
      run: { taskId: string };
    }>;
  } | null>(null);
  const [remove, setRemove] = useState<StoredFile | null>(null);
  const [classify, setClassify] = useState<StoredFile | null>(null);
  const reload = useCallback(async () => {
    const query = new URLSearchParams({
      q,
      page: String(page),
      ...(projectId ? { projectId } : {}),
      ...(filter ? { category: filter } : {}),
    });
    const r = await api<{ files: StoredFile[]; hasMore: boolean }>("GET", "/api/files?" + query);
    if (r.ok) {
      setFiles(r.body.files);
      setMore(r.body.hasMore);
    } else setMessage(r.body.error ?? "文件读取失败");
  }, [q, projectId, page, filter]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <Card>
      <h3 className="mb-3 font-semibold">{projectId ? "项目文件" : "个人文件"}</h3>
      {canWrite && (
        <form
          className="mb-4 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!upload || upload.size > 5 * 1024 * 1024 || !upload.size) {
              setMessage("请选择一个 1 字节到 5 MiB 的文件");
              return;
            }
            setBusy(true);
            const r = await api(
              "POST",
              "/api/files",
              {
                projectId,
                name: upload.name,
                contentBase64: base64(new Uint8Array(await upload.arrayBuffer())),
                category,
                sourceUrl,
              },
              {},
              30000,
            );
            setBusy(false);
            setMessage(r.ok ? "文件已保存" : (r.body.error ?? "上传失败"));
            if (r.ok) {
              setUpload(null);
              setCategory("");
              setSourceUrl("");
              setNonce((value) => value + 1);
              setPage(1);
              void reload();
            }
          }}
        >
          <Field label="上传文件">
            <Input
              key={nonce}
              type="file"
              accept=".md,.txt,.csv,.json,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg"
              onChange={(e) => setUpload(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label="文件分类">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
          </Field>
          <Field label="来源 URL">
            <Input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
          </Field>
          <div className="self-end">
            <Button type="submit" disabled={busy || !upload}>
              上传
            </Button>
          </div>
          <p className="text-xs text-slate-600 sm:col-span-2">
            文本输入支持 Markdown、文本、CSV、JSON、带文本层的 PDF、Word 和 Excel。每件文件上限 5
            MiB。
          </p>
        </form>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="搜索文件"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="按文件名搜索"
        />
        <Input
          aria-label="按分类筛选文件"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
          placeholder="按分类筛选"
        />
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      {files.length === 0 && <p className="mt-3 text-sm text-slate-600">暂无符合条件的文件。</p>}
      <ul className="mt-3 grid gap-2">
        {files.map((file) => (
          <li key={file.id} className="grid gap-2 rounded-lg border border-slate-200 p-3 text-sm">
            <div>
              <strong className="break-all">{file.name}</strong> · {file.category || "未分类"}
              <p className="text-xs text-slate-600">
                {file.sizeBytes} 字节 · {file.createdBy} · {dateTime(file.createdAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                disabled={!file.textSupported}
                aria-label={"预览 " + file.name}
                onClick={async () => {
                  const r = await api<{ preview: { text: string; truncated: boolean } }>(
                    "GET",
                    `/api/files/${file.id}/preview`,
                    undefined,
                    {},
                    15000,
                  );
                  if (r.ok) setPreview({ file, ...r.body.preview });
                  else setMessage(r.body.error ?? "预览失败");
                }}
              >
                预览
              </Button>
              <Button
                variant="ghost"
                aria-label={"下载 " + file.name}
                onClick={async () => {
                  const ticket = await api<{ ticket: string }>(
                    "POST",
                    `/api/files/${file.id}/download-ticket`,
                  );
                  if (!ticket.ok) setMessage(ticket.body.error ?? "下载授权失败");
                  else
                    setMessage(
                      (await download(
                        `/api/files/${file.id}/download?dl=${encodeURIComponent(ticket.body.ticket)}`,
                        file.name,
                      )) ?? "文件已下载",
                    );
                }}
              >
                下载
              </Button>
              <Button
                variant="ghost"
                aria-label={"使用记录 " + file.name}
                onClick={async () => {
                  const r = await api<{ uses: NonNullable<typeof usage>["rows"] }>(
                    "GET",
                    `/api/files/${file.id}/usage`,
                  );
                  if (r.ok) setUsage({ file, rows: r.body.uses });
                  else setMessage(r.body.error ?? "使用记录读取失败");
                }}
              >
                使用记录 · {file.useCount}
              </Button>
              {canWrite && (canManage || file.createdBy === email) && (
                <>
                  <Button variant="ghost" onClick={() => setClassify(file)}>
                    分类
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={"移除 " + file.name}
                    onClick={() => setRemove(file)}
                  >
                    移除
                  </Button>
                </>
              )}
            </div>
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
      {preview && (
        <Dialog open onOpenChange={(open) => !open && setPreview(null)} title={preview.file.name}>
          {preview.truncated && <p className="text-sm text-amber-800">显示已提取的文本节选。</p>}
          {/^https?:\/\//i.test(preview.file.sourceUrl) && (
            <p className="text-sm">
              <a href={preview.file.sourceUrl} rel="noreferrer" target="_blank">
                打开记录的来源
              </a>
            </p>
          )}
          <pre className="mt-2 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 text-sm">
            {preview.text}
          </pre>
          <Button className="mt-3" variant="ghost" onClick={() => setPreview(null)}>
            关闭
          </Button>
        </Dialog>
      )}
      {usage && (
        <Dialog
          open
          onOpenChange={(open) => !open && setUsage(null)}
          title={usage.file.name + " · 使用记录"}
        >
          {usage.rows.length ? (
            usage.rows.map((row) => (
              <p key={row.runId} className="my-2 text-sm">
                <Button variant="ghost" onClick={() => onOpenTask(row.run.taskId)}>
                  查看运行
                </Button>{" "}
                {row.ref} · {row.chars} 字 · {dateTime(row.createdAt)}
              </p>
            ))
          ) : (
            <p className="text-sm">暂无任务使用此文件。</p>
          )}
          <Button variant="ghost" onClick={() => setUsage(null)}>
            关闭
          </Button>
        </Dialog>
      )}
      {classify && (
        <Dialog open onOpenChange={(open) => !open && setClassify(null)} title="编辑文件分类">
          <Field label="新分类">
            <Input
              value={classify.category}
              onChange={(e) => setClassify({ ...classify, category: e.target.value })}
              maxLength={80}
            />
          </Field>
          <Button
            className="mt-3"
            onClick={async () => {
              const r = await api("PATCH", `/api/files/${classify.id}`, {
                category: classify.category,
              });
              setMessage(r.ok ? "分类已更新" : (r.body.error ?? "分类失败"));
              setClassify(null);
              if (r.ok) void reload();
            }}
          >
            保存分类
          </Button>
        </Dialog>
      )}
      {remove && (
        <Confirm
          title="移除文件"
          text={`移除 ${remove.name} 的日常访问，并保留历史运行的来源记录。`}
          close={() => setRemove(null)}
          execute={async () => {
            const r = await api("DELETE", `/api/files/${remove.id}`);
            setMessage(r.ok ? "文件已移除" : (r.body.error ?? "移除失败"));
            if (r.ok) void reload();
          }}
        />
      )}
    </Card>
  );
}

export function MembersPanel() {
  const [rows, setRows] = useState<
    Array<{ userId: string; role: keyof typeof orgRoles; disabledAt: string | null }>
  >([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("EMPLOYEE");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<{ userId: string; role: string } | null>(null);
  const reload = async () => {
    const r = await api<{ members: typeof rows; audit: AuditEntry[] }>("GET", "/api/members");
    if (r.ok) {
      setRows(r.body.members);
      setAudit(r.body.audit);
    } else setMessage(r.body.error ?? "账号读取失败");
  };
  useEffect(() => {
    void reload();
  }, []);
  const save = async (userId: string, role: string, disabled: boolean, password?: string) => {
    setBusy(true);
    const r = await api("PUT", "/api/members", { userId, role, disabled, password });
    setBusy(false);
    setMessage(
      r.ok
        ? disabled
          ? "账号已停用，会话已撤销"
          : "成员已保存"
        : (r.body.error ?? "保存成员失败"),
    );
    if (r.ok) {
      setPassword("");
      void reload();
    }
  };
  return (
    <Card>
      <h3 className="mb-3 font-semibold">组织账号管理</h3>
      <form
        className="grid gap-3 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(email, role, false, password || undefined);
        }}
      >
        <Field label="成员邮箱">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="组织角色">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(orgRoles).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="新账号初始密码">
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div>
          <Button
            type="submit"
            disabled={busy || !email || (password.length > 0 && password.length < 12)}
          >
            保存组织成员
          </Button>
        </div>
      </form>
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      <ul className="mt-3 divide-y divide-slate-200 text-sm">
        {rows.map((row) => (
          <li key={row.userId} className="flex flex-wrap items-center gap-2 py-2">
            <span className="mr-auto">
              {row.userId} · {orgRoles[row.role]}
              {row.disabledAt && " · 已停用"}
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              aria-label={"编辑成员 " + row.userId}
              onClick={() => {
                setEmail(row.userId);
                setRole(row.role);
                setPassword("");
              }}
            >
              编辑角色
            </Button>
            {row.disabledAt ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void save(row.userId, row.role, false)}
              >
                启用
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={busy}
                aria-label={"停用成员 " + row.userId}
                onClick={() => setConfirm(row)}
              >
                停用
              </Button>
            )}
          </li>
        ))}
      </ul>
      <details>
        <summary className="mt-3 text-sm font-medium">账号审计</summary>
        <AuditList rows={audit} />
      </details>
      {confirm && (
        <Confirm
          title="停用组织成员"
          text={`停用 ${confirm.userId} 的组织访问并撤销现有会话。`}
          close={() => setConfirm(null)}
          execute={() => save(confirm.userId, confirm.role, true)}
        />
      )}
    </Card>
  );
}
