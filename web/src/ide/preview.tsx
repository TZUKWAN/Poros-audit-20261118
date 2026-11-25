import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Badge, Button, Input, Select, Textarea } from "../ui.js";
import { activeJob, jobLabel, pretty, type Build, type Details, type Job } from "./types.js";
import { attachPreview } from "./preview-bridge.js";
export type Trial = (kind: string, input: Record<string, unknown>, buildId: string) => Promise<Job>;
export function Preview({
  data,
  run,
  onBuild,
  onSource,
  onTrace,
  target,
  onClearTarget,
}: {
  data: Details | null;
  run: Trial;
  onBuild: () => void;
  onSource: () => void;
  onTrace: (job: Job) => void;
  target: { kind: string; name: string } | null;
  onClearTarget: () => void;
}) {
  const [device, setDevice] = useState("pc"),
    [frame, setFrame] = useState<{ url: string; buildId: string; workspaceId: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [nonce, setNonce] = useState(0);
  const iframe = useRef<HTMLIFrameElement>(null),
    port = useRef<(() => void) | null>(null),
    trial = useRef(run);
  trial.current = run;
  const workspaceId = data?.workspace.id || "",
    latest = data?.workspace.latestBuildId || "";
  const build = data?.builds.find((b) => b.id === latest),
    failed = data?.builds.find(
      (b) => b.sourceDigest === data.workspace.sourceDigest && b.status === "FAILED",
    );
  const hasUi = Boolean(build?.manifest.preview);
  useEffect(() => {
    setFrame(null);
    setError("");
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId || !latest || !hasUi) return;
    let alive = true;
    void api<{ url: string }>(
      "POST",
      "/api/ide/workspaces/" + workspaceId + "/builds/" + latest + "/preview-ticket",
    ).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setFrame({ url: r.body.url, buildId: latest, workspaceId });
        setError("");
      } else setError(r.body.error || "无法加载预览");
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, latest, hasUi, nonce]);
  useEffect(
    () => () => {
      port.current?.();
      port.current = null;
    },
    [frame?.url],
  );
  const connect = () => {
    port.current?.();
    if (!iframe.current?.contentWindow || !frame) return;
    port.current = attachPreview(
      iframe.current.contentWindow,
      async (input) => (await trial.current("RUN", { input }, frame.buildId)).output.result,
    );
  };
  const trials = data?.jobs.filter((j) => j.kind !== "DEVELOP" && j.kind !== "BUILD") || [];
  const outdated = Boolean(build && build.sourceDigest !== data?.workspace.sourceDigest);
  return (
    <section className="ide-preview" aria-label="实时预览">
      <div className="ide-pane-toolbar">
        <strong>{target ? "能力试用" : "实时预览"}</strong>
        <div className="ide-actions">
          {hasUi && !target && (
            <div className="ide-segment" aria-label="预览设备">
              <button aria-pressed={device === "pc"} onClick={() => setDevice("pc")}>
                PC
              </button>
              <button aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}>
                手机
              </button>
            </div>
          )}
          <Button variant="ghost" onClick={onSource} disabled={!data}>
            代码
          </Button>
        </div>
      </div>
      {error && (
        <p className="ide-error" role="alert">
          {error} <button onClick={() => setNonce((n) => n + 1)}>重试预览</button>
        </p>
      )}
      {failed && (
        <details className="ide-build-error" open>
          <summary>本次构建失败{build ? "，保留上次可运行版本" : ""}</summary>
          <pre>{failed.diagnostics.join("\n")}</pre>
        </details>
      )}
      {build && (
        <div className="ide-version">
          <Badge>{outdated ? "上次可运行版本" : "当前构建"}</Badge>
          <span>
            源码 {build.sourceDigest.slice(0, 8)} · {new Date(build.createdAt).toLocaleTimeString()}
          </span>
          <span>构建通过 · 业务验收见案例结果</span>
        </div>
      )}
      <div className={"ide-stage " + (device === "mobile" ? "ide-stage-mobile" : "")}>
        {frame && frame.workspaceId === workspaceId && (
          <iframe
            ref={iframe}
            title="Agent 实际运行界面"
            src={frame.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={connect}
            className={target ? "ide-frame-hidden" : "ide-agent-frame"}
          />
        )}
        {target && build ? (
          <div className="ide-test-surface">
            <div className="ide-row">
              <strong>{target.name || "能力测试"}</strong>
              <Button variant="ghost" onClick={onClearTarget}>
                返回预览
              </Button>
            </div>
            <TrialPanel
              key={workspaceId + ":" + target.kind + ":" + target.name}
              build={build}
              run={run}
              kind={target.kind}
              target={target.name}
            />
          </div>
        ) : !hasUi && build ? (
          <div className="ide-test-surface">
            <TrialPanel
              key={workspaceId + ":" + latest}
              build={build}
              run={run}
              kind={
                data?.workspace.kind === "MCP"
                  ? "MCP_TEST"
                  : data?.workspace.kind === "SKILL"
                    ? "SKILL_TEST"
                    : "RUN"
              }
              target={data?.workspace.kind === "SKILL" ? build.manifest.skills?.[0] || "" : ""}
            />
          </div>
        ) : !frame ? (
          <div className="ide-empty">
            <div className="ide-empty-mark">P</div>
            <h2>
              这里是你的{" "}
              {data?.workspace.kind === "SKILL"
                ? "技能"
                : data?.workspace.kind === "MCP"
                  ? "MCP"
                  : "Agent"}
            </h2>
            <p>
              {data
                ? "在左侧描述需求，开发助手会修改真实工程。构建成功后，直接在这里试用。"
                : "从左侧描述你要开发的 Agent 开始。"}
            </p>
            {data && (
              <Button variant="ghost" onClick={onBuild}>
                构建当前工程
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {trials.length > 0 && (
        <details className="ide-trials">
          <summary>最近试用 · {jobLabel(trials[0]!.status)}</summary>
          {trials.slice(0, 5).map((job) => (
            <div key={job.id} className="ide-trial-row">
              <span>
                {new Date(job.createdAt).toLocaleTimeString()} ·{" "}
                {job.kind === "TEST" ? "案例验收" : "实际运行"} · {jobLabel(job.status)}
              </span>
              <Button variant="ghost" onClick={() => onTrace(job)}>
                查看结果
              </Button>
              {job.output.error && <p className="ide-error">{job.output.error}</p>}
              {activeJob(job) && <span role="status">运行中…</span>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
type Tool = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
    required?: string[];
  };
};
export function TrialPanel({
  build,
  run,
  kind,
  target,
}: {
  build: Build;
  run: Trial;
  kind: string;
  target: string;
}) {
  const [input, setInput] = useState(""),
    [tools, setTools] = useState<Tool[]>([]),
    [selected, setSelected] = useState(""),
    [values, setValues] = useState<Record<string, string>>({}),
    [jsonMode, setJsonMode] = useState(false),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const tool = tools.find((t) => t.name === selected),
    isMcp = kind === "MCP_TEST";
  const execute = async (list = false) => {
    setBusy(true);
    setError("");
    try {
      let value: unknown = input;
      if (isMcp && !list) {
        value = jsonMode
          ? JSON.parse(input || "{}")
          : Object.fromEntries(
              Object.entries(values).map(([key, value]) => {
                const type = tool?.inputSchema?.properties?.[key]?.type;
                return [
                  key,
                  type === "number" || type === "integer"
                    ? Number(value)
                    : type === "boolean"
                      ? value === "true"
                      : type === "object" || type === "array"
                        ? JSON.parse(value)
                        : value,
                ];
              }),
            );
      }
      const job = await run(
        kind,
        {
          input: value,
          ...(target ? { target } : {}),
          ...(isMcp && !list ? { tool: selected } : {}),
        },
        build.id,
      );
      if (list) {
        const catalogue = (job.output.result as { tools: Tool[] }).tools || [];
        setTools(catalogue);
        setSelected(catalogue[0]?.name || "");
      } else setResult(job.output.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ide-trial-panel">
      <h2>{isMcp ? "MCP 工具测试" : kind === "SKILL_TEST" ? "技能试用" : "运行 Agent"}</h2>
      <p className="ide-muted">
        使用当前构建的真实代码
        {isMcp ? "，通过官方 MCP 协议握手并调用工具。" : "和当前已验证连接执行。"}
      </p>
      {isMcp && (
        <>
          <Button variant="ghost" disabled={busy} onClick={() => void execute(true)}>
            连接并发现工具
          </Button>
          {tools.length > 0 && (
            <>
              <label>
                选择工具
                <Select
                  aria-label="选择工具"
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setValues({});
                  }}
                >
                  {tools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="ide-muted">{tool?.description}</p>
              <label className="ide-permission">
                <input
                  type="checkbox"
                  checked={jsonMode}
                  onChange={(e) => setJsonMode(e.target.checked)}
                />
                使用 JSON 输入
              </label>
            </>
          )}
        </>
      )}
      {isMcp && !jsonMode ? (
        Object.entries(tool?.inputSchema?.properties || {}).map(([name, schema]) => (
          <label key={name}>
            {name}
            {tool?.inputSchema?.required?.includes(name) ? " *" : ""}
            {schema.enum ? (
              <Select
                value={values[name] || ""}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              >
                <option value="">选择…</option>
                {schema.enum.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={values[name] || ""}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                placeholder={schema.description || schema.type}
              />
            )}
          </label>
        ))
      ) : (
        <label>
          {isMcp ? "工具参数 JSON" : "试用输入"}
          <Textarea
            aria-label="能力试用输入"
            rows={6}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
      )}
      <Button disabled={busy || (isMcp && !selected)} onClick={() => void execute()}>
        {busy ? "正在实际运行…" : isMcp ? "调用工具" : "开始试用"}
      </Button>
      {error && (
        <p role="alert" className="ide-error">
          {error}
        </p>
      )}
      {result !== undefined && (
        <pre className="ide-result" role="status">
          {pretty(result)}
        </pre>
      )}
    </div>
  );
}
