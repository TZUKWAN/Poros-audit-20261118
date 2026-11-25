import { useEffect, useState } from "react";
import { Badge, Button, Card, Input } from "../ui.js";
import type { appApi } from "./api.js";
type Status = {
  mode: "OFF" | "QUICK" | "WORKER";
  state: "OFF" | "STARTING" | "ONLINE" | "RECONNECTING" | "FAILED";
  url?: string;
  endpoint?: string;
  message?: string;
  limits: string;
};
export function RemoteSettings({
  api,
  onUrl,
}: {
  api: ReturnType<typeof appApi>;
  onUrl: (url: string) => void;
}) {
  const [remote, setRemote] = useState<Status | null>(null),
    [endpoint, setEndpoint] = useState(""),
    [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const load = async () => {
    const response = await api<{ remote: Status }>("GET", "/api/app/remote");
    if (response.ok) {
      setRemote(response.body.remote);
      onUrl(response.body.remote.state === "ONLINE" ? response.body.remote.url || "" : "");
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, []);
  const save = async (body: unknown) => {
    setBusy(true);
    setError("");
    try {
      const response = await api<{ remote: Status }>("PUT", "/api/app/remote", body);
      if (!response.ok) throw new Error(response.body.error || "远程配置失败");
      setKey("");
      setRemote(response.body.remote);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className="ide-row">
        <h3>远程访问</h3>
        <Badge>
          {
            (
              {
                OFF: "未开启",
                STARTING: "正在准备",
                ONLINE: "已连接",
                RECONNECTING: "正在重连",
                FAILED: "连接失败",
              } as const
            )[remote?.state || "OFF"]
          }
        </Badge>
      </div>
      <p className="ide-muted">
        任务在这台电脑运行，手机通过配对后访问。电脑需要保持开机并运行此软件。
      </p>
      {error && (
        <p role="alert" className="ide-error">
          {error}
        </p>
      )}
      {remote?.message && <p role="status">{remote.message}</p>}
      {remote?.url && remote.state === "ONLINE" && (
        <p className="app-code">
          <a href={remote.url} target="_blank" rel="noreferrer">
            {remote.url}
          </a>
          <Button
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(remote.url!)
                .catch(() => setError("复制失败，请手动复制地址"))
            }
          >
            复制地址
          </Button>
        </p>
      )}
      <div className="ide-actions">
        <Button
          disabled={busy || remote?.state === "STARTING"}
          onClick={() => void save({ mode: "QUICK" })}
        >
          开启临时免费访问
        </Button>
        {remote?.mode !== "OFF" && (
          <Button variant="ghost" disabled={busy} onClick={() => void save({ mode: "OFF" })}>
            关闭远程
          </Button>
        )}
      </div>
      <p className="ide-muted">
        免账号临时地址重启会变，适合试用。稳定地址可连接自己的 Cloudflare 免费
        Worker，额度和可用性取决于账号及网络。
      </p>
      <button
        type="button"
        className="ide-link"
        onClick={() => setAdvanced(!advanced)}
        aria-expanded={advanced}
      >
        使用稳定的中继地址
      </button>
      {advanced && (
        <div className="ide-form">
          <label>
            中继 HTTPS 地址
            <Input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={remote?.endpoint || "https://your-relay.workers.dev"}
            />
          </label>
          <label>
            中继管理密钥
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              placeholder="填写自己部署时设置的 HOST_KEY"
            />
          </label>
          <Button
            disabled={busy || !endpoint}
            onClick={() =>
              void save({ mode: "WORKER", endpoint, ...(key ? { relayKey: key } : {}) })
            }
          >
            连接此中继
          </Button>
        </div>
      )}
      {remote && <p className="ide-muted">{remote.limits}</p>}
    </Card>
  );
}
