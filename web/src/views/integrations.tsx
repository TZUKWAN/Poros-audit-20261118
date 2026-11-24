import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Button, Card, Input } from "../ui.js";

const settingsPath = "/api/settings/integrations";
const definitions = [
  {
    provider: "model",
    name: "大模型 API",
    key: "模型 API Key",
    help: "支持 OpenAI 兼容的 Chat Completions。测试会发送一条简短的流式请求。",
  },
  {
    provider: "kdocs",
    name: "Kdocs 金山文档",
    key: "WPS 365 用户授权令牌",
    help: "使用具有云文档授权范围的 WPS 365 用户访问令牌。",
    docs: "https://open.wps.cn/documents/app-integration-dev/mcp-server/use-guide",
  },
  {
    provider: "ima",
    name: "IMA 知识库",
    key: "IMA API Key",
    help: "使用 IMA 开放接口发放的 Client ID 和 API Key。",
    docs: "https://ima.qq.com/agent-interface",
  },
  {
    provider: "tinyfish",
    name: "TinyFish",
    key: "TinyFish API Key",
    help: "连接 TinySearch 和 TinyFetch，仅查询或读取公开网页。请求按您的服务商额度计算。",
    docs: "https://agent.tinyfish.ai/api-keys",
  },
] as const;

type Definition = (typeof definitions)[number];
export interface PersonalConnectionView {
  provider: Definition["provider"];
  settings: { baseUrl?: string; model?: string };
  verified: boolean;
  testedAt: string | null;
  testMessage?: string;
}
export interface SettingsBody {
  connections: PersonalConnectionView[];
  runtime: string;
  builtinModel: string | null;
  testModel: boolean;
  modelMode: "SIMULATION" | "CONFIGURED";
  personalModelOnly: boolean;
}
type Item = { title: string; snippet?: string; url?: string };

export default function IntegrationsView({ providers }: { providers?: string[] } = {}) {
  const [state, setState] = useState<SettingsBody | null>(null);
  const [error, setError] = useState("");
  const reload = async () => {
    const r = await api<SettingsBody>("GET", settingsPath);
    if (r.ok) {
      setError("");
      setState(r.body);
    } else setError(r.body.error ?? "读取设置失败");
  };
  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-semibold">个人集成设置</h2>
        <p className="mt-1 text-sm text-[#5c5a55]">
          凭证仅用于当前组织下的您的账号。保存后可测试实际连接。
        </p>
        {state && (
          <p className="mt-2 text-xs text-[#5c5a55]">
            {state.runtime === "dsh" ? "DSH 独立运行容器" : "开发网关"}
            {state.modelMode === "SIMULATION" ? " · 模拟环境 · 测试模型" : " · 已配置模型通道"}
            {state.builtinModel ? " · 部署模型 " + state.builtinModel : ""}
          </p>
        )}
      </Card>
      {error && (
        <p role="alert">
          {error}{" "}
          <Button variant="ghost" onClick={reload}>
            重试
          </Button>
        </p>
      )}
      {!state && !error && <p role="status">正在读取设置…</p>}
      {state &&
        definitions
          .filter((definition) => !providers || providers.includes(definition.provider))
          .map((definition) => (
            <ConnectionCard
              key={definition.provider}
              definition={definition}
              connection={state.connections.find((row) => row.provider === definition.provider)}
              reload={reload}
            />
          ))}
    </div>
  );
}

function ConnectionCard({
  definition,
  connection,
  reload,
}: {
  definition: Definition;
  connection?: PersonalConnectionView;
  reload: () => Promise<void>;
}) {
  const { provider, name, help, key } = definition;
  const endpoint = settingsPath + "/" + provider;
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [baseUrl, setBaseUrl] = useState(connection?.settings.baseUrl ?? "");
  const [model, setModel] = useState(connection?.settings.model ?? "");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const saveEnabled =
    apiKey.trim() &&
    (provider !== "model" || (baseUrl.trim() && model.trim())) &&
    (provider !== "ima" || clientId.trim());
  const validInput = input.trim() || provider === "ima";

  async function save() {
    setBusy("save");
    setMessage(null);
    const r = await api("PUT", endpoint, {
      apiKey,
      ...(provider === "model" ? { baseUrl, model } : {}),
      ...(provider === "ima" ? { clientId } : {}),
    });
    if (r.ok) {
      setApiKey("");
      setClientId("");
      setItems(null);
      await reload();
    }
    setMessage({ text: r.ok ? "已保存，请测试连接" : (r.body.error ?? "保存失败"), bad: !r.ok });
    setBusy("");
  }
  async function verify() {
    setBusy("test");
    setMessage(null);
    const r = await api<{ passed: boolean; message: string }>(
      "POST",
      endpoint + "/test",
      undefined,
      {},
      29000,
    );
    const passed = r.ok && r.body.passed;
    setMessage({ text: r.ok ? r.body.message : (r.body.error ?? "测试失败"), bad: !passed });
    await reload();
    setBusy("");
  }
  async function disconnect() {
    setBusy("delete");
    const r = await api("DELETE", endpoint);
    if (r.ok) {
      setApiKey("");
      setClientId("");
      setBaseUrl("");
      setModel("");
      setItems(null);
      await reload();
    }
    setMessage({ text: r.ok ? "已断开连接" : (r.body.error ?? "断开失败"), bad: !r.ok });
    setBusy("");
  }
  async function use(action: "search" | "fetch") {
    setBusy(action);
    setItems(null);
    setMessage(null);
    const r = await api<{ items: Item[] }>("POST", endpoint + "/use", { input, action }, {}, 20000);
    if (r.ok) setItems(r.body.items);
    else {
      setMessage({ text: r.body.error ?? "请求失败", bad: true });
      await reload();
    }
    setBusy("");
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{name}</h3>
        <Badge tone={connection?.verified ? "ok" : "warn"}>
          {!connection
            ? "未配置"
            : connection.verified
              ? "已验证"
              : connection.testedAt
                ? "测试未通过"
                : "待测试"}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-[#5c5a55]">{help}</p>
      {"docs" in definition && (
        <a
          className="mt-1 inline-block text-sm underline"
          href={definition.docs}
          target="_blank"
          rel="noreferrer"
        >
          获取凭证
        </a>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (saveEnabled && !busy) void save();
        }}
      >
        {provider === "model" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              API Base URL
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://您的网关/v1"
              />
            </label>
            <label className="grid gap-1 text-sm">
              模型 ID
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          </div>
        )}
        {provider === "ima" && (
          <label className="grid gap-1 text-sm">
            IMA Client ID
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              placeholder={connection ? "更换凭证时重新输入" : ""}
            />
          </label>
        )}
        <label className="grid gap-1 text-sm">
          {key}
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
            placeholder={connection ? "已保存，输入新值可替换" : ""}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={Boolean(busy) || !saveEnabled}>
            {busy === "save" ? "保存中…" : "保存连接"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!connection || Boolean(busy)}
            onClick={verify}
          >
            {busy === "test" ? "正在测试…" : "测试连接"}
          </Button>
          {connection && (
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={disconnect}>
              断开
            </Button>
          )}
        </div>
      </form>
      {provider === "model" && connection?.settings.model && (
        <p className="mt-2 break-all text-xs text-[#5c5a55]">
          已保存 {connection.settings.model} · {connection.settings.baseUrl}。测试通过后，在 Builder
          中授权该模型用于运行和评估。
        </p>
      )}
      {message ? (
        <p
          className={"mt-2 text-sm " + (message.bad ? "text-[#a1301c]" : "text-[#27664b]")}
          role={message.bad ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : (
        connection?.testMessage && (
          <p className="mt-2 text-sm text-[#a1301c]" role="alert">
            {connection.testMessage}
          </p>
        )
      )}
      {connection?.verified && provider !== "model" && (
        <div className="mt-4 border-t border-[#e3e1dc] pt-3">
          <label className="grid gap-1 text-sm">
            {provider === "tinyfish" ? "关键词或 HTTPS 网页地址" : "搜索关键词"}
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={provider === "ima" ? "留空列出知识库" : ""}
            />
          </label>
          <div className="mt-2 flex gap-2">
            <Button disabled={Boolean(busy) || !validInput} onClick={() => use("search")}>
              搜索
            </Button>
            {provider === "tinyfish" && (
              <Button
                variant="ghost"
                disabled={Boolean(busy) || !input.startsWith("https://")}
                onClick={() => use("fetch")}
              >
                读取网页
              </Button>
            )}
          </div>
          {items && (
            <div className="mt-3 space-y-2" aria-live="polite">
              {items.length === 0 ? (
                <p className="text-sm">没有匹配结果</p>
              ) : (
                items.map((item, i) => (
                  <article key={i} className="break-words rounded-lg bg-[#faf9f7] p-2 text-sm">
                    {item.url ? (
                      <a className="underline" href={item.url} target="_blank" rel="noreferrer">
                        {item.title}
                      </a>
                    ) : (
                      <strong>{item.title}</strong>
                    )}
                    {item.snippet && (
                      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-sans">
                        {item.snippet}
                      </pre>
                    )}
                  </article>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
