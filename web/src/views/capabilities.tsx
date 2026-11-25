import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { CatalogEntry, Project, StoredFile } from "../pc.js";
import { Badge, Button, Card, Dialog, Field, Input, PageHeading, Select, Textarea } from "../ui.js";
import type { SettingsBody } from "./integrations.js";
import { Confirm } from "./projects.js";

const labels: Record<string, string> = {
  TOOL: "Tool",
  SKILL: "Skill",
  MCP: "MCP",
  KNOWLEDGE: "Knowledge",
  MODEL: "模型",
};
export default function CapabilitiesView({ role }: { role: string }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<SettingsBody | null>(null);
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [create, setCreate] = useState(false);
  const [disable, setDisable] = useState<CatalogEntry | null>(null);
  const [message, setMessage] = useState("");
  const reload = useCallback(async () => {
    const [data, scopes, connections] = await Promise.all([
      api<{ capabilities: CatalogEntry[] }>("GET", "/api/capabilities"),
      api<{ projects: Project[] }>("GET", "/api/projects"),
      api<SettingsBody>("GET", "/api/settings/integrations"),
    ]);
    if (data.ok) setCatalog(data.body.capabilities);
    else setMessage(data.body.error ?? "读取能力目录失败");
    if (scopes.ok) setProjects(scopes.body.projects);
    if (connections.ok) setSettings(connections.body);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const status = (entry: CatalogEntry) => {
    if (entry.disabledAt) return "已停用";
    if (entry.provider)
      return settings?.connections.find((c) => c.provider === entry.provider)?.verified
        ? "个人连接已验证"
        : "个人连接未验证";
    if (entry.kind === "MODEL")
      return settings?.testModel ? "测试模型环境" : entry.configured ? "部署已配置" : "部署未配置";
    return entry.id ? "已注册版本" : "DSH 注册工具";
  };
  return (
    <>
      <PageHeading title="能力中心">
        {role === "ADMIN" && <Button onClick={() => setCreate(true)}>注册能力版本</Button>}
      </PageHeading>
      <Card>
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="按类型筛选能力"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">全部类型</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Input
            className="max-w-80"
            aria-label="搜索能力"
            placeholder="按名称或来源搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button variant="ghost" onClick={() => void reload()}>
            刷新能力
          </Button>
        </div>
        <div className="mt-3 divide-y divide-slate-200">
          {catalog
            .filter(
              (row) =>
                (!kind || row.kind === kind) &&
                (row.name + " " + row.source).toLowerCase().includes(query.toLowerCase()),
            )
            .map((entry) => (
              <article
                key={entry.id ?? entry.kind + entry.name}
                className="flex flex-wrap items-center gap-3 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{entry.name}</strong>
                    <Badge>
                      {labels[entry.kind]} · {entry.version}
                    </Badge>
                    <Badge>{status(entry)}</Badge>
                  </div>
                  <p className="mt-1 break-words text-slate-700">{entry.description}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    {entry.source} ·{" "}
                    {entry.projectId
                      ? (projects.find((p) => p.id === entry.projectId)?.name ?? "项目范围")
                      : entry.provider
                        ? "任务发起人的个人连接"
                        : "组织范围"}
                  </p>
                </div>
                {role === "ADMIN" && entry.id && !entry.disabledAt && (
                  <Button variant="danger" onClick={() => setDisable(entry)}>
                    停用版本
                  </Button>
                )}
              </article>
            ))}
        </div>
        {message && (
          <p role="status" className="mt-2 text-sm">
            {message}
          </p>
        )}
      </Card>
      {create && (
        <RegisterCapability
          projects={projects.filter((p) => !p.archivedAt)}
          close={() => setCreate(false)}
          saved={() => {
            setCreate(false);
            setMessage("能力版本已注册，可在 Agent Builder 授权");
            void reload();
          }}
        />
      )}
      {disable && (
        <Confirm
          title="停用能力版本"
          text={`停止 ${disable.name} v${disable.version} 的后续调用。`}
          close={() => setDisable(null)}
          execute={async () => {
            const r = await api("DELETE", `/api/capabilities/${disable.id}`);
            setMessage(r.ok ? "能力版本已停用" : (r.body.error ?? "停用失败"));
            if (r.ok) void reload();
          }}
        />
      )}
    </>
  );
}

function RegisterCapability({
  projects,
  close,
  saved,
}: {
  projects: Project[];
  close: () => void;
  saved: () => void;
}) {
  const [kind, setKind] = useState("SKILL");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [projectId, setProjectId] = useState("");
  const [fileId, setFileId] = useState("");
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!projectId || kind !== "KNOWLEDGE") return;
    let alive = true;
    const queryParams = new URLSearchParams({ projectId, q: query });
    void api<{ files: StoredFile[] }>("GET", "/api/files?" + queryParams).then((r) => {
      if (alive && r.ok) setFiles(r.body.files.filter((f) => f.textSupported));
      else if (alive) setError(r.body.error ?? "读取项目文件失败");
    });
    return () => {
      alive = false;
    };
  }, [kind, projectId, query]);
  return (
    <Dialog open onOpenChange={(open) => !open && close()} title="注册能力版本">
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          const r = await api("POST", "/api/capabilities", {
            kind,
            name,
            description,
            projectId: projectId || undefined,
            ...(kind === "SKILL" ? { instruction } : { fileId }),
          });
          setSaving(false);
          if (r.ok) saved();
          else setError(r.body.error ?? "注册失败");
        }}
      >
        <Field label="能力类型">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setFileId("");
            }}
          >
            <option value="SKILL">Skill 指令</option>
            <option value="KNOWLEDGE">项目知识文件</option>
          </Select>
        </Field>
        <Field label="注册名称">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9][a-z0-9_\-]{0,51}"
            placeholder="例如 report-review"
            maxLength={52}
            required
          />
        </Field>
        <Field label="用途说明">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={240}
            required
          />
        </Field>
        <Field label="使用范围">
          <Select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setFileId("");
              setFiles([]);
            }}
          >
            <option value="">{kind === "SKILL" ? "组织内" : "选择项目"}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "SKILL" ? (
          <Field label="Skill 指令">
            <Textarea
              rows={6}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={8000}
            />
          </Field>
        ) : (
          <>
            <Field label="搜索项目知识文件">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} />
            </Field>
            <Field label="知识文件">
              <Select value={fileId} onChange={(e) => setFileId(e.target.value)}>
                <option value="">选择文本文件</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <Button
          type="submit"
          disabled={
            saving ||
            !name ||
            !description.trim() ||
            (kind === "SKILL" ? !instruction.trim() : !fileId || !projectId)
          }
        >
          保存能力版本
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
