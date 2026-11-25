import { submissionKey, forgetSubmission, definiteRejection } from "../ide/pending.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog } from "../ui.js";
import { TrialPanel, type Trial } from "../ide/preview.js";
import { attachPreview } from "../ide/preview-bridge.js";
import { jobLabel, pretty, type Build, type Job, type Kind } from "../ide/types.js";
import { RuntimeSettings } from "./settings.js";
import { appApi, appBase } from "./api.js";
import "./style.css";
export interface AppInfo {
  appId: string;
  name: string;
  kind: Kind;
  version: string;
  sourceDigest: string;
  hasUi: boolean;
  createdAt: string;
  evidence: Build["evidence"];
  manifest: Build["manifest"];
  role?: "OWNER" | "DEVICE";
  sessionIdentity?: string;
  authorizedTools?: string[];
  grants?: string[];
  error?: string;
}
type RawJob = Job & { output: Job["output"] | null };
export default function RuntimeView() {
  const [info, setInfo] = useState<AppInfo | null>(null),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [settings, setSettings] = useState(false),
    [jobs, setJobs] = useState<Job[]>([]);
  const [consent, setConsent] = useState<string[] | null>(null),
    [pairCode, setPairCode] = useState(""),
    [deviceName, setDeviceName] = useState("我的手机"),
    [pairMessage, setPairMessage] = useState("");
  const tokenRef = useRef(token),
    infoRef = useRef(info),
    pairPoll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    mounted = useRef(true);
  const consentReply = useRef<{
    resolve: (value: string[]) => void;
    reject: (error: Error) => void;
  } | null>(null);
  tokenRef.current = token;
  infoRef.current = info;
  const api = useMemo(
    () =>
      appApi(
        () => tokenRef.current,
        () => {
          tokenRef.current = "";
          setToken("");
          setError("设备或会话已失效，请重新连接");
        },
      ),
    [],
  );
  const remember = (value: string) => {
    tokenRef.current = value;
    setToken(value);
    try {
      if (infoRef.current)
        localStorage.setItem("poros-app-token:" + appBase + ":" + infoRef.current.appId, value);
    } catch {
      /* The current session remains usable. */
    }
  };
  const refresh = async () => {
    const r = await api<AppInfo>("GET", "/api/app/session");
    if (!r.ok) throw new Error(r.body.error || "会话读取失败");
    setInfo(r.body);
    infoRef.current = r.body;
  };
  const reloadJobs = async () => {
    const r = await api<{ jobs: RawJob[] }>("GET", "/api/app/jobs");
    if (r.ok)
      setJobs(
        r.body.jobs.map((job) => ({
          ...job,
          output: job.output || {},
          stage: job.status === "RUNNING" ? "running" : "completed",
        })),
      );
  };
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const r = await api<AppInfo>("GET", "/api/app/info");
      if (!r.ok) throw new Error(r.body.error || "无法连接运行端");
      setInfo(r.body);
      infoRef.current = r.body;
      const bootstrap = location.hash.match(/^#\/bootstrap\/([A-Za-z0-9_-]{43})$/)?.[1],
        pair = location.hash.match(/^#\/pair\/([A-Za-z0-9_-]{43})$/)?.[1];
      history.replaceState(null, "", location.pathname + location.search);
      if (pair) setPairCode(pair);
      if (bootstrap) {
        const result = await api<{ token: string }>("POST", "/api/app/bootstrap", {
          code: bootstrap,
        });
        if (!result.ok) throw new Error(result.body.error || "本地启动凭证已失效");
        remember(result.body.token);
      } else {
        let saved = "";
        try {
          saved = localStorage.getItem("poros-app-token:" + appBase + ":" + r.body.appId) || "";
        } catch {
          /* Optional persistence. */
        }
        if (saved) remember(saved);
      }
      if (tokenRef.current) {
        await refresh();
        await reloadJobs();
      }
    })().catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
    return () => {
      mounted.current = false;
      clearTimeout(pairPoll.current);
      consentReply.current?.reject(new Error("软件界面已关闭"));
    };
  }, []);
  useEffect(() => {
    if (!token || !jobs.some((job) => job.status === "RUNNING")) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void reloadJobs();
    }, 1200);
    return () => clearInterval(timer);
  }, [token, jobs.some((job) => job.status === "RUNNING")]);
  const run: Trial = async (kind, input, version) => {
    let current = infoRef.current;
    if (current && !current.sessionIdentity) {
      await refresh();
      current = infoRef.current;
    }
    if (!current?.sessionIdentity) throw new Error("软件会话尚未加载");
    const allowed = current.authorizedTools || [],
      granted =
        allowed.length && (kind !== "MCP_TEST" || Boolean(input.tool))
          ? await new Promise<string[]>((resolve, reject) => {
              if (consentReply.current) {
                reject(new Error("已有任务正在等待同意"));
                return;
              }
              consentReply.current = { resolve, reject };
              setConsent(allowed);
            })
          : [];
    const body = { kind, input, consent: granted, expectedVersion: version },
      signature = JSON.stringify(body);
    const namespace =
        "poros-app-pending:" + appBase + ":" + current.appId + ":" + current.sessionIdentity,
      request = await submissionKey(namespace, signature);
    const response = await api<{ job: RawJob }>("POST", "/api/app/jobs", body, {
      "idempotency-key": request.key,
    });
    if (definiteRejection(response.status)) forgetSubmission(namespace, request.key);
    if (!response.ok) throw new Error(response.body.error || "提交失败；原请求号已保留");
    if (!response.body.job?.id) throw new Error("运行回执不完整，请重试找回原请求");
    void reloadJobs();
    const deadline = Date.now() + 195000;
    while (Date.now() < deadline && mounted.current) {
      const r = await api<{ job: RawJob }>("GET", "/api/app/jobs/" + response.body.job.id);
      if (!r.ok) throw new Error(r.body.error || "结果读取失败");
      if (r.body.job.status !== "RUNNING") {
        forgetSubmission(namespace, request.key);
        await reloadJobs();
        const job = { ...r.body.job, output: r.body.job.output || {}, stage: "completed" };
        if (job.status !== "SUCCEEDED") throw new Error(job.output.error || "运行未完成");
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    throw new Error("等待超时，任务仍有运行记录，请查看最近任务");
  };
  const connect = async () => {
    setPairMessage("");
    setError("");
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const claimToken = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const result = await api<{ id: string }>("POST", "/api/app/pair/claim", {
        code: pairCode,
        claimToken,
        name: deviceName,
      });
      if (!result.ok) throw new Error(result.body.error || "配对失败");
      setPairMessage("请在电脑端的设置中同意这台设备。");
      const poll = async () => {
        const r = await api<{ status: string; token?: string }>("POST", "/api/app/pair/result", {
          id: result.body.id,
          claimToken,
        });
        if (!mounted.current) return;
        if (!r.ok) {
          setPairMessage(r.body.error || "配对已失效");
          return;
        }
        if (r.body.token) {
          remember(r.body.token);
          await refresh();
          await reloadJobs();
          setPairMessage("");
        } else
          pairPoll.current = setTimeout(() => void poll().catch((e) => setError(String(e))), 1800);
      };
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "配对失败");
    }
  };
  const build: Build | undefined = info
    ? {
        id: info.version,
        sourceDigest: info.sourceDigest,
        status: "READY",
        diagnostics: [],
        manifest: info.manifest,
        evidence: info.evidence,
        createdAt: info.createdAt,
      }
    : undefined;
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>{info?.name || "Agent"}</strong>
        <div className="ide-actions">
          <Badge>{info?.role === "DEVICE" ? "远程设备" : "独立软件"}</Badge>
          {token && (
            <Button variant="ghost" onClick={() => setSettings(true)}>
              设置
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p className="app-alert" role="alert">
          {error}
        </p>
      )}
      {info?.error && (
        <p className="app-alert" role="alert">
          {info.error}
        </p>
      )}
      {!info ? (
        <p role="status" className="app-loading">
          正在连接运行端…
        </p>
      ) : !token ? (
        <main className="app-pair">
          <h1>连接这台 Agent</h1>
          <p>在电脑端打开软件设置，生成配对码。任务在安装端执行，手机只需浏览器。</p>
          <label>
            配对码
            <input
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              autoCapitalize="none"
              autoComplete="off"
            />
          </label>
          <label>
            设备名称
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
          </label>
          <Button
            onClick={() => void connect()}
            disabled={!pairCode || !deviceName || Boolean(pairMessage)}
          >
            请求连接
          </Button>
          <p role="status">{pairMessage}</p>
        </main>
      ) : (
        <>
          <main className="app-content">
            {info.hasUi ? (
              <RuntimeFrame api={api} version={info.version} run={run} />
            ) : build ? (
              <div className="ide-test-surface">
                <TrialPanel
                  build={build}
                  run={run}
                  kind={
                    info.kind === "MCP" ? "MCP_TEST" : info.kind === "SKILL" ? "SKILL_TEST" : "RUN"
                  }
                  target={info.kind === "SKILL" ? info.manifest.skills?.[0] || "" : ""}
                />
              </div>
            ) : null}
          </main>
          {jobs.length > 0 && (
            <details className="app-history">
              <summary>最近任务 · {jobLabel(jobs[0]!.status)}</summary>
              {jobs.slice(0, 10).map((job) => (
                <article key={job.id}>
                  <div className="ide-row">
                    <span>
                      {new Date(job.createdAt).toLocaleTimeString()} · {jobLabel(job.status)}
                    </span>
                    {job.status === "RUNNING" && (
                      <Button
                        variant="danger"
                        onClick={() =>
                          void api("POST", "/api/app/jobs/" + job.id + "/cancel").then(reloadJobs)
                        }
                      >
                        停止
                      </Button>
                    )}
                  </div>
                  <pre className="ide-result">{pretty(job.output)}</pre>
                </article>
              ))}
            </details>
          )}
        </>
      )}
      {info && token && (
        <RuntimeSettings
          open={settings}
          onOpenChange={setSettings}
          info={info}
          api={api}
          refresh={refresh}
          onLogout={async () => {
            const r = await api("POST", "/api/app/logout");
            if (!r.ok) throw new Error(r.body.error || "退出失败");
            remember("");
            setSettings(false);
          }}
        />
      )}
      <Dialog
        title="允许本次任务使用的能力"
        open={Boolean(consent)}
        onOpenChange={(open) => {
          if (!open) {
            consentReply.current?.reject(new Error("未同意本次操作"));
            consentReply.current = null;
            setConsent(null);
          }
        }}
      >
        <ul>
          {consent?.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
        <div className="ide-actions">
          <Button
            onClick={() => {
              consentReply.current?.resolve(consent || []);
              consentReply.current = null;
              setConsent(null);
            }}
          >
            允许本次运行
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              consentReply.current?.reject(new Error("本次运行已取消"));
              consentReply.current = null;
              setConsent(null);
            }}
          >
            取消
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
function RuntimeFrame({
  api,
  version,
  run,
}: {
  api: ReturnType<typeof appApi>;
  version: string;
  run: Trial;
}) {
  const [frame, setFrame] = useState<{ url: string; version: string } | null>(null),
    [error, setError] = useState("");
  const element = useRef<HTMLIFrameElement>(null),
    close = useRef<(() => void) | null>(null),
    runner = useRef(run);
  runner.current = run;
  useEffect(() => {
    let alive = true;
    void api<{ url: string }>("POST", "/api/app/preview-ticket").then((r) => {
      if (!alive) return;
      if (r.ok) setFrame({ url: appBase + r.body.url, version });
      else setError(r.body.error || "界面加载失败");
    });
    return () => {
      alive = false;
      close.current?.();
    };
  }, [api, version]);
  return (
    <>
      {error && (
        <p className="app-alert" role="alert">
          {error}
        </p>
      )}
      {frame && (
        <iframe
          ref={element}
          title="Agent 软件界面"
          src={frame.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => {
            close.current?.();
            if (element.current?.contentWindow)
              close.current = attachPreview(
                element.current.contentWindow,
                async (input) =>
                  (await runner.current("RUN", { input }, frame.version)).output.result,
              );
          }}
        />
      )}
    </>
  );
}
