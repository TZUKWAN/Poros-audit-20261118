import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import {
  capabilityBlock,
  dateTime,
  modelPreflight,
  sensitiveGrants,
  type Agent,
  type CatalogEntry,
  type Grant,
  type Manifest,
  type Project,
} from "../pc.js";
import { Badge, Button, Card, Dialog, Field, Input, PageHeading, Select, Textarea } from "../ui.js";
import type { SettingsBody } from "./integrations.js";
import RunDetails from "./run-details.js";
import { Confirm } from "./projects.js";

const originLabel: Record<string, string> = {
  MANUAL: "手工创建",
  TEMPLATE: "模拟环境 · 测试模板",
  MODEL: "模型生成",
  LEGACY_NL: "历史草稿 · 生成通道未记录",
};

export default function AgentsView({ role }: { role: string }) {
  const canBuild = ["BUILDER", "ADMIN"].includes(role);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [settings, setSettings] = useState<SettingsBody | null>(null);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const r = await api<{ agents: Agent[] }>("GET", "/api/agents");
    if (r.ok) {
      setAgents(r.body.agents);
      setSelected((id) =>
        r.body.agents.some((a) => a.id === id) ? id : (r.body.agents[0]?.id ?? ""),
      );
    } else setError(r.body.error ?? "Agent 目录读取失败");
  }, []);
  useEffect(() => {
    void refresh();
    void api<SettingsBody>("GET", "/api/settings/integrations").then((r) => {
      if (r.ok) setSettings(r.body);
    });
    void api<{ projects: Project[] }>("GET", "/api/projects").then((r) => {
      if (r.ok) setProjects(r.body.projects);
    });
    void api<{ capabilities: CatalogEntry[] }>("GET", "/api/capabilities").then((r) => {
      if (r.ok) setCatalog(r.body.capabilities);
    });
  }, [refresh]);
  const agent = agents.find((a) => a.id === selected);
  return (
    <>
      <PageHeading title="Agent 中心">
        {canBuild && <Button onClick={() => setCreateOpen(true)}>新建 Agent</Button>}
      </PageHeading>
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2.7fr)]">
        <Card className="self-start">
          <h3 className="mb-2 font-semibold">Agent 目录</h3>
          <Input
            aria-label="搜索 Agent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名称或部门搜索"
          />
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-800">
              {error}
            </p>
          )}
          <ul className="mt-2 space-y-2">
            {agents
              .filter((a) =>
                (a.name + " " + a.department).toLowerCase().includes(query.trim().toLowerCase()),
              )
              .map((a) => (
                <li key={a.id}>
                  <button
                    aria-pressed={a.id === selected}
                    onClick={() => setSelected(a.id)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:bg-slate-50 aria-pressed:border-[#c9694b] aria-pressed:bg-[#fdf7f4]"
                  >
                    <span className="block break-words text-sm font-medium">{a.name}</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge tone={a.releaseReady ? "ok" : "neutral"}>
                        {a.releaseReady ? `已审批 v${a.currentVersion}` : "草稿"}
                      </Badge>
                      <Badge>{originLabel[a.draftOrigin] ?? "来源未记录"}</Badge>
                    </div>
                  </button>
                </li>
              ))}
          </ul>
          {!agents.length && !error && (
            <p className="mt-2 text-sm text-slate-600">暂无可访问的 Agent</p>
          )}
        </Card>
        {agent &&
          (canBuild ? (
            <Builder
              key={agent.id}
              agent={agent}
              projects={projects}
              catalog={catalog}
              settings={settings}
              refresh={refresh}
            />
          ) : (
            <Card>
              <h3 className="font-semibold">{agent.name}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm">{agent.description}</p>
              <p className="mt-2 text-sm">
                {agent.department || "未归部门"} · v{agent.currentVersion}
              </p>
            </Card>
          ))}
      </div>
      {createOpen && (
        <CreateAgent
          settings={settings}
          close={() => setCreateOpen(false)}
          onCreated={(id) => {
            setSelected(id);
            setCreateOpen(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function CreateAgent({
  settings,
  close,
  onCreated,
}: {
  settings: SettingsBody | null;
  close: () => void;
  onCreated: (id: string) => void;
}) {
  const [mode, setMode] = useState("manual");
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const personal = settings?.connections.find((c) => c.provider === "model");
  const live = Boolean(
    personal?.verified || (settings?.builtinModel && settings.modelMode !== "SIMULATION"),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && close()} title="新建 Agent">
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const r = await api<{ agent: Agent }>(
            "POST",
            "/api/agents/drafts",
            mode === "manual"
              ? {
                  name,
                  department,
                  description,
                  config: {
                    persona: description,
                    modelPolicy: "default",
                    outputKind: "chat-answer",
                  },
                }
              : { description, generationMode: mode },
            {},
            65000,
          );
          setBusy(false);
          if (r.ok) onCreated(r.body.agent.id);
          else setError(r.body.error ?? "创建失败");
        }}
      >
        <Field label="创建方式">
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="manual">手工创建</option>
            <option value="live">使用真实模型生成</option>
            {settings?.modelMode === "SIMULATION" && <option value="template">测试模板</option>}
          </Select>
        </Field>
        {mode === "manual" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Agent 名称">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="部门">
              <Input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                maxLength={120}
              />
            </Field>
          </div>
        )}
        <Field label={mode === "manual" ? "角色与任务" : "自然语言描述"}>
          <Textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
        </Field>
        {mode === "live" && !live && (
          <p className="text-sm text-amber-900" role="status">
            连接未验证。请在设置中通过实际生成测试。
            {personal?.testMessage && " " + personal.testMessage}
          </p>
        )}
        {mode === "template" && (
          <p className="text-sm text-amber-900">模拟环境 · 以固定模板创建测试草稿</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              (mode === "manual" ? !name.trim() : description.trim().length < 4) ||
              (mode === "live" && !live)
            }
          >
            {mode === "manual" ? "创建草稿" : mode === "template" ? "创建测试草稿" : "生成草稿"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Fields = {
  name: string;
  description: string;
  department: string;
  config: Record<string, unknown>;
};
const fromAgent = (a: Agent): Fields => ({
  name: a.name,
  description: a.description,
  department: a.department,
  config: a.draftConfig,
});
const labelFor: Record<string, string> = {
  name: "名称",
  department: "部门",
  description: "简介",
  persona: "角色与任务",
  modelPolicy: "模型策略",
  outputKind: "输出",
};
function Diff({ before, after }: { before: Fields; after: Fields }) {
  const simplify = (fields: Fields) => ({
    name: fields.name,
    department: fields.department,
    description: fields.description,
    ...fields.config,
  });
  const a = simplify(before) as Record<string, unknown>,
    b = simplify(after) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
  return keys.length ? (
    <ul className="space-y-2 text-sm">
      {keys.map((key) => (
        <li key={key} className="rounded-lg border border-slate-200 p-2">
          <span className="font-medium">{labelFor[key] ?? key}</span>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            <p className="whitespace-pre-wrap break-words bg-slate-50 p-2">
              原值 · {String(a[key] ?? "未设置")}
            </p>
            <p className="whitespace-pre-wrap break-words bg-green-50 p-2">
              新值 · {String(b[key] ?? "未设置")}
            </p>
          </div>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-slate-600">配置相同。</p>
  );
}

function Builder({
  agent,
  projects,
  catalog,
  settings,
  refresh,
}: {
  agent: Agent;
  projects: Project[];
  catalog: CatalogEntry[];
  settings: SettingsBody | null;
  refresh: () => Promise<void>;
}) {
  const [fields, setFields] = useState(() => fromAgent(agent));
  const [saved, setSaved] = useState(() => fromAgent(agent));
  const [diff, setDiff] = useState<{ before: Fields; after: Fields } | null>(null);
  const [json, setJson] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [testPrompt, setTestPrompt] = useState("");
  const [testProject, setTestProject] = useState("");
  const [testTask, setTestTask] = useState("");
  const [consent, setConsent] = useState(false);
  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  const model = modelPreflight(agent.grants, settings);
  const tools = sensitiveGrants(agent.grants);
  const testBlock = capabilityBlock(agent.grants, settings, catalog, testProject);
  const personal = agent.grants.some(
    (g) => g.kind === "MODEL" && g.source?.startsWith("personal-openai-compatible:"),
  );
  const policyIssue =
    (fields.config.modelPolicy === "personal" && !personal) ||
    (fields.config.modelPolicy === "deepseek-chat" && personal);
  const projectsForTest = projects.filter(
    (p) =>
      !p.archivedAt &&
      p.role !== "VIEWER" &&
      (!agent.projectRestricted || agent.projects.some((link) => link.projectId === p.id)),
  );
  const config = (key: string, value: string) =>
    setFields((f) => ({ ...f, config: { ...f.config, [key]: value } }));
  const version = agent.versions.find((v) => v.version === agent.currentVersion);
  const field = (key: "name" | "description" | "department", value: string) =>
    setFields((f) => ({ ...f, [key]: value }));
  const run = async (
    action: string,
    body: unknown,
    done: (value: Record<string, unknown>) => string,
  ) => {
    setBusy(true);
    const r = await api("POST", `/api/agents/${agent.id}/${action}`, body);
    setBusy(false);
    setMessage(r.ok ? done(r.body) : (r.body.error ?? "操作失败"));
    if (r.ok) void refresh();
    return r.ok;
  };
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-semibold">Builder · {agent.name}</h3>
          <Badge>
            {originLabel[agent.draftOrigin] ?? agent.draftOrigin}
            {agent.generationModel && " · " + agent.generationModel}
          </Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Agent 名称">
            <Input
              value={fields.name}
              onChange={(e) => field("name", e.target.value)}
              maxLength={120}
            />
          </Field>
          <Field label="部门">
            <Input
              value={fields.department}
              onChange={(e) => field("department", e.target.value)}
              maxLength={120}
            />
          </Field>
        </div>
        <div className="mt-3 grid gap-3">
          <Field label="目录简介">
            <Input
              value={fields.description}
              onChange={(e) => field("description", e.target.value)}
              maxLength={2000}
            />
          </Field>
          <Field label="角色与任务">
            <Textarea
              value={String(fields.config.persona ?? "")}
              onChange={(e) => config("persona", e.target.value)}
              rows={4}
              maxLength={12000}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="模型策略">
              <Select
                value={String(fields.config.modelPolicy ?? "default")}
                onChange={(e) => config("modelPolicy", e.target.value)}
              >
                <option value="default">按已审批授权</option>
                <option value="personal">固定个人模型端点</option>
                <option value="deepseek-chat">组织模型 deepseek-chat</option>
                {String(fields.config.modelPolicy ?? "").startsWith("mock") && (
                  <option value={String(fields.config.modelPolicy)}>历史测试模型策略</option>
                )}
              </Select>
            </Field>
            <Field label="输出要求">
              <Select
                value={String(fields.config.outputKind ?? "chat-answer")}
                onChange={(e) => config("outputKind", e.target.value)}
              >
                <option value="chat-answer">对话答复</option>
                <option value="markdown-document">Markdown 文档</option>
              </Select>
            </Field>
          </div>
        </div>
        <div className="my-3 flex flex-wrap items-center gap-2">
          <Badge tone={model.blocked ? "warn" : "neutral"}>{model.label}</Badge>
          <Badge>{agent.projectRestricted ? "项目专用" : "组织内可用"}</Badge>
          {policyIssue && <Badge tone="warn">模型策略与当前授权不一致</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setAdvanced(!advanced);
              setJson(JSON.stringify(fields.config, null, 2));
            }}
          >
            高级 JSON
          </Button>
          <Button
            disabled={busy || !fields.name.trim() || !dirty}
            onClick={async () => {
              setBusy(true);
              const r = await api<{
                agent: Agent;
                diff: { fields: { before: Fields; after: Fields } };
              }>("PATCH", `/api/agents/${agent.id}/draft`, { ...fields, replaceConfig: true });
              setBusy(false);
              if (!r.ok) {
                setMessage(r.body.error ?? "保存失败");
                return;
              }
              setFields(fromAgent(r.body.agent));
              setSaved(fromAgent(r.body.agent));
              setDiff(r.body.diff.fields);
              setMessage("草稿已保存");
              void refresh();
            }}
          >
            保存草稿
          </Button>
        </div>
        {advanced && (
          <div className="mt-3 grid gap-2">
            <p className="text-xs text-slate-600">
              执行字段为 persona、modelPolicy 和 outputKind。Tool、Skill、MCP、Knowledge
              从授权目录选择。
            </p>
            <Textarea
              aria-label="草稿配置 JSON"
              rows={8}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            <Button
              variant="ghost"
              onClick={() => {
                try {
                  const value: unknown = JSON.parse(json);
                  if (typeof value !== "object" || !value || Array.isArray(value))
                    throw new Error();
                  setFields((f) => ({ ...f, config: value as Record<string, unknown> }));
                  setAdvanced(false);
                } catch {
                  setMessage("高级配置需要有效的 JSON 对象");
                }
              }}
            >
              应用到草稿表单
            </Button>
          </div>
        )}
        {(dirty || diff) && (
          <section className="mt-3">
            <h4 className="mb-2 font-medium">{dirty ? "待保存变更" : "最近保存变更"}</h4>
            <Diff before={dirty ? saved : diff!.before} after={dirty ? fields : diff!.after} />
          </section>
        )}
      </Card>
      <Grants agent={agent} catalog={catalog} settings={settings} refresh={refresh} />
      <Card>
        <h3 className="mb-3 font-semibold">草稿测试</h3>
        <div className="grid gap-3">
          <Field label="测试项目">
            <Select value={testProject} onChange={(e) => setTestProject(e.target.value)}>
              <option value="">{agent.projectRestricted ? "选择关联项目" : "个人测试"}</option>
              {projectsForTest.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="测试任务">
            <Textarea
              value={testPrompt}
              onChange={(e) => setTestPrompt(e.target.value)}
              rows={3}
              maxLength={20000}
            />
          </Field>
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
          {testBlock && <p className="text-sm text-amber-800">{testBlock}</p>}
          <div>
            <Button
              disabled={
                busy ||
                dirty ||
                model.blocked ||
                policyIssue ||
                Boolean(testBlock) ||
                !testPrompt.trim() ||
                (agent.projectRestricted && !testProject) ||
                (tools.length > 0 && !consent)
              }
              onClick={() =>
                void run(
                  "test-runs",
                  {
                    prompt: testPrompt,
                    projectId: testProject || undefined,
                    consent: consent ? tools : [],
                  },
                  (value) => {
                    setTestTask(String(value.taskId));
                    setConsent(false);
                    return "草稿测试任务已提交";
                  },
                )
              }
            >
              运行草稿测试
            </Button>
          </div>
        </div>
      </Card>
      {testTask && <RunDetails key={testTask} taskId={testTask} />}
      <Card>
        <div className="mb-3 flex flex-wrap justify-between gap-2">
          <h3 className="font-semibold">版本与发布</h3>
          <Button
            disabled={busy || dirty || policyIssue || (model.blocked && !personal)}
            onClick={() => setReviewOpen(true)}
          >
            申请发布
          </Button>
        </div>
        {agent.versions.length === 0 ? (
          <p className="text-sm text-slate-600">暂无发布记录</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {agent.versions.map((v) => (
              <li key={v.version} className="rounded-lg border border-slate-200 p-2">
                <strong>v{v.version}</strong> ·{" "}
                {v.approvedAt ? `已批准 ${dateTime(v.approvedAt)}` : "尚未批准"}
                {v.version === agent.currentVersion && " · 当前版本"}
                {v.manifest?.config && (
                  <details className="mt-1">
                    <summary>冻结配置与授权</summary>
                    <ManifestSummary manifest={v.manifest} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {agent.versions.some((v) => v.approvedAt && v.version !== agent.currentVersion) && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="回滚目标版本">
              <Select value={targetVersion} onChange={(e) => setTargetVersion(e.target.value)}>
                <option value="">选择已审批版本</option>
                {agent.versions
                  .filter((v) => v.approvedAt && v.version !== agent.currentVersion)
                  .map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button
              variant="ghost"
              disabled={busy || !targetVersion}
              onClick={() =>
                void run("rollback", { version: Number(targetVersion) }, (value) => {
                  setTargetVersion("");
                  return `已回滚到 v${value.currentVersion}`;
                })
              }
            >
              回滚到选中版本
            </Button>
          </div>
        )}
      </Card>
      {message && (
        <p role="status" className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
          {message}
        </p>
      )}
      {reviewOpen && (
        <Dialog open onOpenChange={(open) => !open && setReviewOpen(false)} title="确认发布申请">
          <ManifestSummary
            manifest={{
              name: saved.name,
              agentId: agent.id,
              department: saved.department,
              config: saved.config,
              grants: agent.grants,
            }}
          />
          {version?.manifest?.config && (
            <>
              <h4 className="my-2 font-medium">与当前版本的变更</h4>
              <Diff
                before={{
                  name: version.manifest.name,
                  department: version.manifest.department,
                  description: saved.description,
                  config: version.manifest.config,
                }}
                after={saved}
              />
              <GrantDiff before={version.manifest.grants} after={agent.grants} />
            </>
          )}
          <Button
            className="mt-3"
            disabled={busy}
            onClick={async () => {
              const ok = await run(
                "publish",
                undefined,
                (value) => `v${value.version} 已冻结，等待独立审批`,
              );
              if (ok) setReviewOpen(false);
            }}
          >
            冻结并提交审批
          </Button>
        </Dialog>
      )}
    </div>
  );
}

export function ManifestSummary({ manifest }: { manifest: Manifest }) {
  return (
    <div className="mt-2 space-y-2 break-words text-sm">
      <p>
        <strong>{manifest.name}</strong> · {manifest.department || "未归部门"}
      </p>
      <p className="whitespace-pre-wrap">{String(manifest.config.persona ?? "未填写 Persona")}</p>
      <p>
        模型策略 {String(manifest.config.modelPolicy ?? "default")} · 输出{" "}
        {manifest.config.outputKind === "markdown-document" ? "Markdown 文档" : "对话答复"}
      </p>
      {manifest.grants.map((g) => (
        <p key={g.kind + g.name} className="rounded bg-slate-50 p-2">
          {g.kind} · {g.name} · {g.source} · {g.version}
          {g.scopeNote && " · " + g.scopeNote}
        </p>
      ))}
    </div>
  );
}

function GrantDiff({ before, after }: { before: Grant[]; after: Grant[] }) {
  const key = (g: Grant) => JSON.stringify([g.kind, g.name, g.source, g.version, g.scopeNote]);
  return (
    <div className="mt-2 text-sm">
      {after
        .filter((a) => !before.some((b) => key(b) === key(a)))
        .map((g) => (
          <p key={key(g)}>新增授权 · {g.name}</p>
        ))}
      {before
        .filter((b) => !after.some((a) => key(b) === key(a)))
        .map((g) => (
          <p key={key(g)}>移除旧授权 · {g.name}</p>
        ))}
    </div>
  );
}

function Grants({
  agent,
  catalog,
  settings,
  refresh,
}: {
  agent: Agent;
  catalog: CatalogEntry[];
  settings: SettingsBody | null;
  refresh: () => Promise<void>;
}) {
  const [kind, setKind] = useState("TOOL");
  const [choice, setChoice] = useState("");
  const [scopeNote, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const custom = settings?.connections.find((c) => c.provider === "model");
  const entries = catalog.filter((item) => item.kind === kind && !item.disabledAt);
  const optionId = (entry: CatalogEntry) => entry.id ?? entry.name;
  const chosen = entries.find((item) => optionId(item) === choice);
  const apply = async (method: string, suffix: string, data?: unknown) => {
    setBusy(true);
    const r = await api(method, `/api/agents/${agent.id}/grants${suffix}`, data);
    setBusy(false);
    setMessage(
      r.ok
        ? method === "DELETE"
          ? "授权已撤销"
          : "草稿授权已保存"
        : (r.body.error ?? "授权操作失败"),
    );
    if (r.ok) {
      setScope("");
      void refresh();
    }
  };
  return (
    <Card>
      <h3 className="mb-3 font-semibold">能力授权与安全</h3>
      <ul className="mb-3 space-y-1">
        {agent.grants.map((g) => (
          <li
            key={g.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-2 text-sm"
          >
            <span className="min-w-0 break-words">
              {g.kind} · <strong>{g.name}</strong> · {g.source} · {g.version}
              <br />
              <span className="text-slate-600">{g.scopeNote}</span>
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              aria-label={"撤销授权 " + g.name}
              onClick={() => setRevoking(g)}
            >
              撤销
            </Button>
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="能力类型">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setChoice("");
            }}
          >
            {["TOOL", "SKILL", "MCP", "KNOWLEDGE", "MODEL"].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </Select>
        </Field>
        <Field label="能力">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">请选择</option>
            {entries.map((entry) => (
              <option key={optionId(entry)} value={optionId(entry)}>
                {entry.name}
                {entry.id ? ` · v${entry.version}` : ""}
              </option>
            ))}
            {kind === "MODEL" && custom?.settings.model && (
              <option value="personal">个人模型 · {custom.settings.model}</option>
            )}
          </Select>
        </Field>
        <Field label="用途及授权范围">
          <Input value={scopeNote} onChange={(e) => setScope(e.target.value)} maxLength={1000} />
        </Field>
        <div className="self-end">
          <Button
            disabled={busy || !choice || !scopeNote.trim()}
            onClick={() => {
              const binding =
                kind === "MODEL" && choice === "personal" ? custom?.settings : undefined;
              if (!binding && !chosen) return;
              void apply("POST", "", {
                kind,
                name: binding?.model ?? chosen?.name,
                scopeNote,
                source: binding ? "personal-openai-compatible:" + binding.baseUrl : chosen?.source,
                version: binding ? binding.model : chosen?.version,
              });
            }}
          >
            保存授权
          </Button>
        </div>
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      )}
      {revoking && (
        <Confirm
          title="撤销能力授权"
          text={`停止使用 ${revoking.name} 的既有任务和版本。恢复后需要重新发布审批。`}
          close={() => setRevoking(null)}
          execute={() => apply("DELETE", "/" + revoking.id)}
        />
      )}
    </Card>
  );
}
