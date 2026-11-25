import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { OrgInfo } from "../api.js";
import { Badge, Button, Dialog, DialogClose, Input, Select, Textarea } from "../ui.js";
import { IdeSettings } from "./settings.js";
import { Preview, type Trial } from "./preview.js";
import { JobDetails, SourceEditor } from "./source.js";
import { activeJob, jobLabel, kindLabel, type Job, type Kind } from "./types.js";
import { useIde } from "./use-ide.js";
import "./style.css";

export default function IdeView({
  auth,
  onLogout,
}: {
  auth: OrgInfo;
  onLogout: () => Promise<void>;
}) {
  const owner = auth.organizationId + ":" + auth.email,
    ide = useIde(owner);
  const [draft, setDraft] = useState(""),
    [error, setError] = useState("");
  const [settings, setSettings] = useState(false),
    [source, setSource] = useState<{ path?: string } | null>(null),
    [trace, setTrace] = useState<Job | null>(null);
  const [newKind, setNewKind] = useState<Kind | null>(null),
    [name, setName] = useState(""),
    [creating, setCreating] = useState(false);
  const [tab, setTab] = useState("chat"),
    [split, setSplit] = useState(43),
    [target, setTarget] = useState<{ kind: string; name: string } | null>(null);
  const [permission, setPermission] = useState<string[] | null>(null);
  const permissionReply = useRef<{
    resolve: (value: string[]) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    layout = useRef<HTMLDivElement>(null),
    scrollEnd = useRef<HTMLDivElement>(null);
  const draftKey = "poros-ide-draft:" + owner + ":" + (ide.id || "new");
  const currentDraftKey = useRef(draftKey);
  currentDraftKey.current = draftKey;
  useEffect(() => {
    try {
      setDraft(sessionStorage.getItem(draftKey) || "");
    } catch {
      setDraft("");
    }
    setTarget(null);
    setSource(null);
    setTrace(null);
    setError("");
    permissionReply.current?.reject(new Error("已切换工程，试用已取消"));
    permissionReply.current = null;
    setPermission(null);
  }, [draftKey]);
  useEffect(
    () => () => {
      permissionReply.current?.reject(new Error("IDE 已关闭"));
    },
    [],
  );
  const updateDraft = (value: string) => {
    setDraft(value);
    try {
      sessionStorage.setItem(currentDraftKey.current, value);
    } catch {
      /* Draft remains in this window. */
    }
  };
  const data = ide.data,
    developing = data?.jobs.find((j) => j.kind === "DEVELOP" && activeJob(j));
  const sourceBusy = data?.jobs.some(
    (j) => ["DEVELOP", "BUILD", "TEST"].includes(j.kind) && activeJob(j),
  );
  const chat =
    data?.jobs
      .filter((j) => j.kind === "DEVELOP")
      .slice()
      .reverse() || [];
  useEffect(() => {
    scrollEnd.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [chat.length, developing?.events.length, developing?.status]);
  const invoke = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };
  const send = async () => {
    if (!draft.trim() || ide.sending || sourceBusy) return;
    const prompt = draft.trim();
    setError("");
    try {
      let workspace = data?.workspace;
      if (!workspace) {
        workspace = await ide.create(prompt.slice(0, 45), "AGENT");
        try {
          sessionStorage.setItem("poros-ide-draft:" + owner + ":" + workspace.id, prompt);
        } catch {
          /* Optional persistence. */
        }
        setDraft(prompt);
      }
      await ide.submit("DEVELOP", { prompt }, undefined, workspace);
      updateDraft("");
    } catch (e) {
      const message = e instanceof Error ? e.message : "发送失败";
      setError(message);
      updateDraft(prompt);
      if (/模型|连接|配置/.test(message)) setSettings(true);
    }
  };
  const run: Trial = async (kind, input, buildId) => {
    if (!data) throw new Error("工程尚未加载");
    const build = data.builds.find((b) => b.id === buildId);
    const allowed = (build?.manifest.permissions || []).filter((name) =>
      data.workspace.settings.authorizedTools?.includes(name),
    );
    const requiresPermission = kind !== "MCP_TEST" || Boolean(input.tool);
    const consent =
      allowed.length && requiresPermission
        ? await new Promise<string[]>((resolve, reject) => {
            if (permissionReply.current) {
              reject(new Error("已有操作等待授权"));
              return;
            }
            permissionReply.current = { resolve, reject };
            setPermission(allowed);
          })
        : [];
    const job = await ide.submit(kind, { ...input, consent }, buildId);
    return ide.wait(data.workspace.id, job);
  };
  const build = () =>
    void invoke(async () => {
      const job = await ide.submit("BUILD", {});
      await ide.wait(ide.id, job);
    });
  const customize = (text: string) => {
    updateDraft(text + "\n");
    setSettings(false);
    setTab("chat");
  };
  const test = (name: string, kind: "SKILL_TEST" | "MCP_TEST") => {
    setTarget({ name, kind });
    setSettings(false);
    setTab("preview");
  };
  return (
    <div className="ide-shell">
      <header className="ide-header">
        <div className="ide-brand">
          <strong>Poros</strong>
          <span>Agent AI IDE</span>
        </div>
        <Select
          aria-label="当前工程"
          value={ide.id}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith("new:")) {
              setNewKind(value.slice(4) as Kind);
              setName("");
            } else ide.select(value);
          }}
        >
          <option value="" disabled>
            选择工程
          </option>
          {ide.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {kindLabel(w.kind)}
            </option>
          ))}
          <optgroup label="新建">
            <option value="new:AGENT">＋ Agent</option>
            <option value="new:SKILL">＋ 技能</option>
            <option value="new:MCP">＋ MCP 服务</option>
          </optgroup>
        </Select>
        <Button variant="ghost" onClick={() => setSettings(true)}>
          设置
        </Button>
      </header>
      <div className="ide-mobile-tabs" role="tablist" aria-label="工作区域">
        <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
          开发对话
        </button>
        <button role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
          运行预览
        </button>
      </div>
      <div
        ref={layout}
        className={"ide-layout ide-tab-" + tab}
        style={{ "--ide-left": split + "%" } as CSSProperties}
      >
        <section className="ide-chat" aria-label="开发对话">
          <div className="ide-pane-toolbar">
            <strong>{data ? "开发 " + kindLabel(data.workspace.kind) : "开发一个 Agent"}</strong>
            {data && <Badge>{data.workspace.sourceDigest.slice(0, 8)}</Badge>}
          </div>
          <div className="ide-chat-scroll">
            {!chat.length && (
              <div className="ide-welcome">
                <h1>
                  {data?.workspace.kind === "MCP"
                    ? "这个 MCP 要连接什么系统？"
                    : data?.workspace.kind === "SKILL"
                      ? "你要定制什么技能？"
                      : "你想做一个什么 Agent？"}
                </h1>
                <p>说清它帮谁、处理什么材料、最后交付什么。开发助手会改代码，右边可以直接试用。</p>
                <div className="ide-welcome-options">
                  <button
                    onClick={() =>
                      updateDraft(
                        "开发一个客户资料整理 Agent，读取我提供的材料，提取客户信息并输出可核对的结构化结果。",
                      )
                    }
                  >
                    从一个实际任务开始
                  </button>
                  <button
                    onClick={() => {
                      setNewKind("SKILL");
                      setName("");
                    }}
                  >
                    定制一个技能
                  </button>
                  <button
                    onClick={() => {
                      setNewKind("MCP");
                      setName("");
                    }}
                  >
                    开发 MCP 工具
                  </button>
                </div>
              </div>
            )}
            {chat.map((job) => (
              <article className="ide-exchange" key={job.id}>
                <div className="ide-user-message">{job.input.prompt}</div>
                <div className="ide-assistant-message">
                  <div className="ide-row">
                    <strong>Poros</strong>
                    <span className={job.status === "FAILED" ? "ide-error" : "ide-muted"}>
                      {jobLabel(job.status)}
                    </span>
                  </div>
                  {job.output.summary && <p>{job.output.summary}</p>}
                  {job.output.error && (
                    <p className="ide-error" role="alert">
                      {job.output.error}
                    </p>
                  )}
                  {activeJob(job) && (
                    <p className="ide-progress" role="status">
                      {progress(job)}
                    </p>
                  )}
                  {job.output.evaluation && (
                    <p className="ide-muted">
                      案例验收：
                      {job.output.evaluation.status === "PASSED"
                        ? "通过"
                        : job.output.evaluation.status === "FAILED"
                          ? "未通过"
                          : "尚未执行"}
                    </p>
                  )}
                  <button className="ide-text-button" onClick={() => setTrace(job)}>
                    查看修改与执行记录
                  </button>
                </div>
              </article>
            ))}
            <div ref={scrollEnd} />
          </div>
          <div className="ide-composer">
            {(error || ide.error) && (
              <p className="ide-error" role="alert">
                {error || ide.error}
              </p>
            )}
            <Textarea
              aria-label="开发要求"
              placeholder="描述需求，或说说哪里需要修改…"
              value={draft}
              rows={4}
              onChange={(e) => updateDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="ide-composer-actions">
              <div className="ide-actions">
                <button
                  className="ide-text-button"
                  onClick={() => fileInput.current?.click()}
                  disabled={!data || Boolean(sourceBusy)}
                >
                  添加材料
                </button>
                {data && (
                  <button
                    className="ide-text-button"
                    disabled={Boolean(sourceBusy)}
                    onClick={build}
                  >
                    构建
                  </button>
                )}
                {data && (
                  <button
                    className="ide-text-button"
                    disabled={Boolean(sourceBusy)}
                    onClick={() =>
                      void invoke(async () => {
                        const job = await ide.submit("TEST", {});
                        await ide.wait(ide.id, job);
                      })
                    }
                  >
                    验收
                  </button>
                )}
              </div>
              {developing ? (
                <Button variant="danger" onClick={() => void invoke(() => ide.stop(developing.id))}>
                  停止
                </Button>
              ) : (
                <Button
                  disabled={!draft.trim() || ide.sending || Boolean(sourceBusy)}
                  onClick={() => void send()}
                >
                  {ide.sending ? "提交中…" : "发送"}
                </Button>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".md,.txt,.csv,.json,.yaml,.yml,.xml,.html"
              onChange={(e) => {
                const selected = [...(e.target.files || [])];
                e.target.value = "";
                void invoke(async () => {
                  if (!data) return;
                  if (
                    selected.length > 12 ||
                    selected.reduce((n, f) => n + f.size, 0) > 1000000 ||
                    selected.some((f) => f.size > 256000)
                  )
                    throw new Error("每次最多 12 个文本文件，单个 256 KB，总量 1 MB");
                  const files = { ...data.files };
                  for (const file of selected) {
                    const path = "materials/" + file.name;
                    if (Object.hasOwn(files, path))
                      throw new Error("同名材料已存在，请先重命名：" + file.name);
                    files[path] = await file.text();
                  }
                  await ide.save(files, data.workspace.sourceDigest);
                  updateDraft(
                    draft +
                      "\n已添加材料：" +
                      selected.map((f) => "materials/" + f.name).join("、"),
                  );
                });
              }}
            />
          </div>
        </section>
        <div
          className="ide-divider"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="调整对话与预览宽度"
          aria-valuemin={30}
          aria-valuemax={65}
          aria-valuenow={split}
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
              e.preventDefault();
              setSplit((n) => Math.max(30, Math.min(65, n + (e.key === "ArrowLeft" ? -2 : 2))));
            }
          }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId) || !layout.current) return;
            const rect = layout.current.getBoundingClientRect();
            setSplit(Math.max(30, Math.min(65, ((e.clientX - rect.left) / rect.width) * 100)));
          }}
        />
        <Preview
          data={data}
          run={run}
          onBuild={build}
          onSource={() => setSource({})}
          onTrace={setTrace}
          target={target}
          onClearTarget={() => setTarget(null)}
        />
      </div>
      <IdeSettings
        open={settings}
        onOpenChange={setSettings}
        data={data}
        onRefresh={ide.refresh}
        onCustomize={customize}
        onTest={test}
        onSource={(path) => {
          setSettings(false);
          setSource({ path });
        }}
        onLogout={() => void invoke(onLogout)}
      />
      {source && data && (
        <SourceEditor
          key={data.workspace.id}
          data={data}
          path={source.path}
          onClose={() => setSource(null)}
          onSave={ide.save}
        />
      )}
      {trace && data && (
        <JobDetails workspaceId={data.workspace.id} job={trace} onClose={() => setTrace(null)} />
      )}
      <Dialog
        title={"新建" + kindLabel(newKind || "AGENT")}
        open={Boolean(newKind)}
        onOpenChange={(open) => {
          if (!open) setNewKind(null);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newKind || !name.trim() || creating) return;
            setCreating(true);
            void invoke(async () => {
              await ide.create(name.trim(), newKind);
              setNewKind(null);
            }).finally(() => setCreating(false));
          }}
        >
          <label>
            名称
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <p className="ide-muted">创建真实工程后，在左侧对话中描述具体需求。</p>
          <div className="ide-actions">
            <Button type="submit" disabled={creating || !name.trim()}>
              创建工程
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" type="button">
                取消
              </Button>
            </DialogClose>
          </div>
        </form>
      </Dialog>
      <Dialog
        title="本次试用使用的能力"
        open={Boolean(permission)}
        onOpenChange={(open) => {
          if (!open) {
            permissionReply.current?.reject(new Error("未同意本次能力调用"));
            permissionReply.current = null;
            setPermission(null);
          }
        }}
      >
        <p>运行过程中可调用以下已在工程设置中授权的能力：</p>
        <ul>
          {permission?.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <div className="ide-actions">
          <Button
            onClick={() => {
              permissionReply.current?.resolve(permission || []);
              permissionReply.current = null;
              setPermission(null);
            }}
          >
            允许本次运行
          </Button>
          <DialogClose asChild>
            <Button variant="ghost">取消</Button>
          </DialogClose>
        </div>
      </Dialog>
    </div>
  );
}
function progress(job: Job) {
  const last = job.events
    ?.slice()
    .reverse()
    .find((e) => /tool_call|evaluation|build|source.saved/.test(e.type));
  if (!last) return "正在分析需求和读取工程…";
  const text = JSON.stringify(last.data);
  if (/workspace_patch|source.saved/.test(text + last.type)) return "正在修改工程文件…";
  if (/workspace_test|evaluation/.test(text + last.type)) return "正在执行真实案例…";
  if (/workspace_build|build/.test(text + last.type)) return "正在编译和检查代码…";
  return "正在读取与分析工程…";
}
