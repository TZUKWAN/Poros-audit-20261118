import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { api, saveBlob } from "../api.js";
import { Badge, Button, Card, Input, Select } from "../ui.js";
import IntegrationsView from "../views/integrations.js";
import type { Details, Workspace, Job } from "./types.js";

export type Connection = {
  key: string;
  settings: {
    baseUrl?: string;
    model?: string;
    testPath?: string;
    authHeader?: string;
    authPrefix?: string;
    tools?: Array<{ name: string; description?: string }>;
  };
  verified: boolean;
  testedAt: string | null;
};
type Configuration = {
  settings: Workspace["settings"];
  capabilities: {
    skills: Array<{ name: string; directory: string; description: string }>;
    permissions: string[];
    mcp: Array<{ name: string; entry: string }>;
  };
  connections: Connection[];
};
export function IdeSettings({
  open,
  onOpenChange,
  data,
  onRefresh,
  onCustomize,
  onTest,
  onSource,
  onLogout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Details | null;
  onRefresh: () => Promise<void>;
  onCustomize: (target: string) => void;
  onTest: (target: string, kind: "SKILL_TEST" | "MCP_TEST") => void;
  onSource: (path?: string) => void;
  onLogout: () => void;
}) {
  const [section, setSection] = useState("developer"),
    [config, setConfig] = useState<Configuration | null>(null),
    [error, setError] = useState("");
  const [desktop, setDesktop] = useState(false),
    [materials, setMaterials] = useState(false),
    [packaging, setPackaging] = useState(false),
    [packageMessage, setPackageMessage] = useState("");
  const importFile = useRef<HTMLInputElement>(null);
  const id = data?.workspace.id || "";
  const reload = async () => {
    if (!id) return;
    const r = await api<Configuration>("GET", "/api/ide/workspaces/" + id + "/settings");
    if (r.ok) {
      setConfig(r.body);
      setError("");
    } else setError(r.body.error || "读取配置失败");
  };
  useEffect(() => {
    setConfig(null);
    if (open && id) {
      void reload();
      void api<{ windows: boolean }>("GET", "/api/ide/delivery").then((r) => {
        if (r.ok) setDesktop(r.body.windows);
      });
    }
  }, [id, open]);
  const save = async (change: Partial<Workspace["settings"]>) => {
    const r = await api("PUT", "/api/ide/workspaces/" + id + "/settings", {
      ...config?.settings,
      ...change,
    });
    if (!r.ok) {
      setError(r.body.error || "保存失败");
      return;
    }
    await reload();
    await onRefresh();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ide-overlay" />
        <Dialog.Content className="ide-settings" aria-describedby="ide-settings-description">
          <div className="ide-row">
            <Dialog.Title>设置</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="关闭设置">
                关闭
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description id="ide-settings-description" className="ide-muted">
            凭证加密保存在服务端，当前工程的运行权限单独管理。
          </Dialog.Description>
          <div className="ide-segment" role="tablist" aria-label="设置分类">
            {[
              ["developer", "开发与连接"],
              ["agent", "当前工程"],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={section === key}
                onClick={() => setSection(key!)}
              >
                {label}
              </button>
            ))}
          </div>
          {error && (
            <p role="alert" className="ide-error">
              {error}
            </p>
          )}
          {section === "developer" ? (
            <>
              <IntegrationsView context="ide" />
              <div className="ide-row">
                <span className="ide-muted">退出当前账号</span>
                <Button variant="ghost" onClick={onLogout}>
                  退出登录
                </Button>
              </div>
            </>
          ) : !id ? (
            <p>创建工程后，可配置它的模型、技能和 MCP。</p>
          ) : !config ? (
            <p role="status">读取工程设置…</p>
          ) : (
            <>
              <Card>
                <h3>运行模型</h3>
                <p className="ide-muted">
                  开发助手负责改代码，运行模型负责 Agent 的实际任务。二者可以分开配置。
                </p>
                <Select
                  aria-label="运行模型来源"
                  value={config.settings.runtimeModel || "inherit"}
                  onChange={(e) => void save({ runtimeModel: e.target.value as "inherit" | "own" })}
                >
                  <option value="inherit">使用个人模型连接</option>
                  <option value="own">为当前 Agent 单独配置</option>
                </Select>
                {config.settings.runtimeModel === "own" && (
                  <EndpointForm
                    key={id + "-model"}
                    workspaceId={id}
                    kind="model"
                    name="runtime"
                    connection={config.connections.find((c) => c.key === "model")}
                    onReload={reload}
                  />
                )}
              </Card>
              <Card>
                <div className="ide-row">
                  <h3>技能</h3>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      onCustomize("新建一个标准 Agent Skill，包含处理方法、必要脚本和真实验收案例")
                    }
                  >
                    定制技能
                  </Button>
                </div>
                {!config.capabilities.skills.length && (
                  <p className="ide-muted">
                    还未添加技能。可通过开发对话创建，也可从其他技能工程复用。
                  </p>
                )}
                {config.capabilities.skills.map((skill) => (
                  <article className="ide-capability" key={skill.directory}>
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          !config.settings.enabledSkills ||
                          config.settings.enabledSkills.includes(skill.directory)
                        }
                        onChange={(e) =>
                          void save({
                            enabledSkills: e.target.checked
                              ? [...(config.settings.enabledSkills || []), skill.directory]
                              : config.capabilities.skills
                                  .map((s) => s.directory)
                                  .filter(
                                    (d) =>
                                      d !== skill.directory &&
                                      (!config.settings.enabledSkills ||
                                        config.settings.enabledSkills.includes(d)),
                                  ),
                          })
                        }
                      />{" "}
                      {skill.name}
                    </label>
                    <p className="ide-muted">{skill.description}</p>
                    <div className="ide-actions">
                      <Button
                        variant="ghost"
                        onClick={() => onCustomize("修改技能 " + skill.directory)}
                      >
                        修改
                      </Button>
                      <Button variant="ghost" onClick={() => onTest(skill.directory, "SKILL_TEST")}>
                        试用技能
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => onSource(skill.directory + "/SKILL.md")}
                      >
                        查看文件
                      </Button>
                    </div>
                  </article>
                ))}
              </Card>
              <Card>
                <div className="ide-row">
                  <h3>MCP</h3>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      onCustomize(
                        "定制一个 MCP 服务，先明确真实 API、工具输入输出和认证方式，再实现并协议测试",
                      )
                    }
                  >
                    定制 MCP
                  </Button>
                </div>
                {config.capabilities.mcp.map((server) => (
                  <div className="ide-capability" key={server.name}>
                    <strong>{server.name}</strong>
                    <p className="ide-muted">工程内服务 · {server.entry}</p>
                    <div className="ide-actions">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          onCustomize("修改 MCP " + server.name + "，入口 " + server.entry)
                        }
                      >
                        修改
                      </Button>
                      <Button variant="ghost" onClick={() => onTest(server.name, "MCP_TEST")}>
                        测试工具
                      </Button>
                    </div>
                  </div>
                ))}
                <EndpointForm key={id + "-mcp"} workspaceId={id} kind="mcp" onReload={reload} />
                {config.connections
                  .filter((c) => c.key.startsWith("mcp:"))
                  .map((c) => (
                    <EndpointForm
                      key={c.key}
                      workspaceId={id}
                      kind="mcp"
                      name={c.key.slice(4)}
                      connection={c}
                      onReload={reload}
                    />
                  ))}
              </Card>
              <Card>
                <h3>业务 API</h3>
                <p className="ide-muted">
                  给 API 起一个连接名称。程序通过 ctx.http(名称:/路径) 调用，令牌不会进入生成代码。
                </p>
                <EndpointForm key={id + "-api"} workspaceId={id} kind="api" onReload={reload} />
                {config.connections
                  .filter((c) => c.key.startsWith("api:"))
                  .map((c) => (
                    <EndpointForm
                      key={c.key}
                      workspaceId={id}
                      kind="api"
                      name={c.key.slice(4)}
                      connection={c}
                      onReload={reload}
                    />
                  ))}
              </Card>
              <Card>
                <h3>复用与交付</h3>
                <p className="ide-muted">
                  导出包含固定源码、构建、权限声明、案例记录和签名的工程包。安装端需重新绑定连接。签名校验文件完整性，首次导入仍需核对发布者。
                </p>
                <label className="ide-permission">
                  <input
                    type="checkbox"
                    checked={materials}
                    onChange={(e) => setMaterials(e.target.checked)}
                  />
                  我已检查，允许随包交付 materials/ 中的用户材料
                </label>
                <div className="ide-actions">
                  <Button
                    variant="ghost"
                    disabled={packaging || !data?.workspace.latestBuildId}
                    onClick={async () => {
                      setPackaging(true);
                      setPackageMessage("");
                      try {
                        const r = await api<{ package: unknown; filename: string }>(
                          "POST",
                          "/api/ide/workspaces/" + id + "/releases",
                          { buildId: data?.workspace.latestBuildId, includeMaterials: materials },
                          {},
                          30000,
                        );
                        if (!r.ok) throw new Error(r.body.error || "打包失败");
                        saveBlob(
                          new Blob([JSON.stringify(r.body.package)], { type: "application/json" }),
                          r.body.filename,
                        );
                        setPackageMessage("已导出工程包。构建或案例通过不代表外部供应商已验收。");
                      } catch (e) {
                        setPackageMessage(e instanceof Error ? e.message : "打包失败");
                      } finally {
                        setPackaging(false);
                      }
                    }}
                  >
                    导出工程包
                  </Button>
                  {data?.workspace.kind === "AGENT" && (
                    <Button
                      variant="ghost"
                      disabled={packaging}
                      onClick={() => importFile.current?.click()}
                    >
                      导入技能 / MCP 包
                    </Button>
                  )}
                </div>
                <div className="ide-actions">
                  <Button
                    variant="ghost"
                    disabled={packaging || !desktop || !data?.workspace.latestBuildId}
                    onClick={async () => {
                      setPackaging(true);
                      setPackageMessage("");
                      try {
                        const r = await api<{ job: Job }>(
                          "POST",
                          "/api/ide/workspaces/" + id + "/jobs",
                          {
                            kind: "PACKAGE",
                            buildId: data?.workspace.latestBuildId,
                            expectedDigest: data?.workspace.sourceDigest,
                            input: { includeMaterials: materials },
                          },
                          { "idempotency-key": crypto.randomUUID() },
                        );
                        if (!r.ok) throw new Error(r.body.error || "安装构建提交失败");
                        setPackageMessage(
                          "安装构建已开始，关闭设置后也会继续。结果保留在当前工程。",
                        );
                        await onRefresh();
                      } catch (e) {
                        setPackageMessage(e instanceof Error ? e.message : "安装构建失败");
                      } finally {
                        setPackaging(false);
                      }
                    }}
                  >
                    生成 Windows 安装包
                  </Button>
                  {!desktop && (
                    <span className="ide-muted">
                      当前服务未准备 Windows 构建器，可先导出工程包。
                    </span>
                  )}
                </div>
                {data?.jobs
                  .filter((job) => job.kind === "PACKAGE")
                  .slice(0, 3)
                  .map((job) => (
                    <article className="ide-capability" key={job.id}>
                      <span>
                        {job.status === "SUCCEEDED"
                          ? "安装包已生成"
                          : job.status === "RUNNING" || job.status === "QUEUED"
                            ? "正在生成安装包"
                            : "安装构建未完成"}
                      </span>
                      {["QUEUED", "RUNNING"].includes(job.status) && (
                        <Button
                          variant="ghost"
                          onClick={async () => {
                            const r = await api(
                              "POST",
                              "/api/ide/workspaces/" + id + "/jobs/" + job.id + "/cancel",
                            );
                            if (!r.ok) setPackageMessage(r.body.error || "停止失败");
                            else await onRefresh();
                          }}
                        >
                          停止构建
                        </Button>
                      )}
                      {job.output.error && <p className="ide-error">{job.output.error}</p>}
                      {job.output.installer && (
                        <>
                          <p className="ide-muted">
                            {(job.output.installer.bytes / 1024 / 1024).toFixed(1)} MB · Windows
                            签名：{job.output.installer.windowsSignatureStatus}
                          </p>
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              const r = await api<{ url: string }>(
                                "POST",
                                "/api/ide/workspaces/" +
                                  id +
                                  "/jobs/" +
                                  job.id +
                                  "/installer-ticket",
                              );
                              if (!r.ok) {
                                setPackageMessage(r.body.error || "下载准备失败");
                                return;
                              }
                              const anchor = document.createElement("a");
                              anchor.href = r.body.url;
                              anchor.download = job.output.installer!.filename;
                              anchor.click();
                            }}
                          >
                            下载安装包
                          </Button>
                        </>
                      )}
                    </article>
                  ))}
                <input
                  ref={importFile}
                  type="file"
                  hidden
                  accept=".json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setPackaging(true);
                    setPackageMessage("");
                    try {
                      if (file.size > 16 * 1024 * 1024) throw new Error("能力包超过 16 MB");
                      const r = await api<{ message: string }>(
                        "POST",
                        "/api/ide/workspaces/" + id + "/import-capability",
                        {
                          expectedDigest: data?.workspace.sourceDigest,
                          package: JSON.parse(await file.text()),
                        },
                        {},
                        30000,
                      );
                      if (!r.ok) throw new Error(r.body.error || "导入失败");
                      setPackageMessage(r.body.message);
                      await reload();
                      await onRefresh();
                    } catch (err) {
                      setPackageMessage(err instanceof Error ? err.message : "导入失败");
                    } finally {
                      setPackaging(false);
                    }
                  }}
                />
                {packageMessage && (
                  <p role="status" className="ide-muted">
                    {packageMessage}
                  </p>
                )}
              </Card>
              <Card>
                <h3>当前工程的权限</h3>
                <p className="ide-muted">
                  只显示源码声明的能力；试用时会再次确认本次允许的调用。更换连接或权限会使进行中的任务失效。
                </p>
                {!config.capabilities.permissions.length ? (
                  <p className="ide-muted">尚未声明外部工具权限。</p>
                ) : (
                  config.capabilities.permissions.map((name) => (
                    <label className="ide-permission" key={name}>
                      <input
                        type="checkbox"
                        checked={config.settings.authorizedTools?.includes(name) || false}
                        onChange={(e) =>
                          void save({
                            authorizedTools: e.target.checked
                              ? [...(config.settings.authorizedTools || []), name]
                              : (config.settings.authorizedTools || []).filter((n) => n !== name),
                          })
                        }
                      />
                      <code>{name}</code>
                    </label>
                  ))
                )}
              </Card>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function EndpointForm({
  workspaceId,
  kind,
  name: fixedName,
  connection,
  onReload,
  request = api,
  endpointBase,
}: {
  workspaceId: string;
  kind: "model" | "mcp" | "api";
  name?: string;
  connection?: Connection;
  onReload: () => Promise<void>;
  request?: typeof api;
  endpointBase?: string;
}) {
  const [name, setName] = useState(fixedName || ""),
    [baseUrl, setBaseUrl] = useState(connection?.settings.baseUrl || ""),
    [secret, setSecret] = useState(""),
    [model, setModel] = useState(connection?.settings.model || ""),
    [testPath, setTestPath] = useState(connection?.settings.testPath || "/"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [authHeader, setAuthHeader] = useState(connection?.settings.authHeader || "Authorization"),
    [authPrefix, setAuthPrefix] = useState(connection?.settings.authPrefix ?? "Bearer");
  const endpoint = endpointBase
    ? endpointBase + "/" + (kind === "model" ? "model" : kind + ":" + name)
    : "/api/ide/workspaces/" + workspaceId + "/connections/" + kind + "/" + name;
  const action = async (method: string, suffix = "", body?: unknown) => {
    setBusy(true);
    try {
      const r = await request<{ passed?: boolean; message?: string }>(
        method,
        endpoint + suffix,
        body,
        {},
        30000,
      );
      setMessage(r.ok ? r.body.message || "已保存，测试连接后可使用" : r.body.error || "操作失败");
      if (r.ok) {
        setSecret("");
        await onReload();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ide-endpoint"
      onSubmit={(e) => {
        e.preventDefault();
        void action(
          "PUT",
          "",
          kind === "model"
            ? { apiKey: secret, baseUrl, model }
            : endpointBase
              ? { baseUrl, apiKey: secret, testPath, authHeader, authPrefix }
              : { baseUrl, token: secret, testPath, authHeader, authPrefix },
        );
      }}
    >
      <div className="ide-row">
        <strong>{fixedName || "新增" + (kind === "mcp" ? "外部 MCP" : " API")}</strong>
        {connection && (
          <Badge tone={connection.verified ? "ok" : "warn"}>
            {connection.verified ? "连接已验证" : "连接待验证"}
          </Badge>
        )}
      </div>
      {!fixedName && (
        <label>
          连接名称
          <Input
            aria-label={kind + "连接名称"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z][a-z0-9-]{0,39}"
            required
            placeholder="例如 crm"
          />
        </label>
      )}
      <label>
        {kind === "mcp" ? "MCP Streamable HTTP 地址" : "API Base URL"}
        <Input
          aria-label={kind + "地址"}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          inputMode="url"
          required
          autoCapitalize="none"
        />
      </label>
      {kind === "model" && (
        <label>
          模型 ID
          <Input value={model} onChange={(e) => setModel(e.target.value)} required />
        </label>
      )}
      <label>
        {kind === "model" ? "API Key" : "认证凭证（可留空）"}
        <Input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="new-password"
          placeholder={connection ? "更换连接时重新输入" : ""}
          required={kind === "model"}
        />
      </label>
      {kind !== "model" && (
        <div className="ide-actions">
          <label>
            凭证请求头
            <Input value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
          </label>
          <label>
            认证前缀
            <Select value={authPrefix} onChange={(e) => setAuthPrefix(e.target.value)}>
              <option value="Bearer">Bearer</option>
              <option value="Basic">Basic</option>
              <option value="">无前缀（例如 X-API-Key）</option>
            </Select>
          </label>
        </div>
      )}
      {kind === "api" && (
        <label>
          连通测试的只读路径
          <Input value={testPath} onChange={(e) => setTestPath(e.target.value)} required />
        </label>
      )}
      <div className="ide-actions">
        <Button type="submit" disabled={busy || !name || !baseUrl}>
          保存连接
        </Button>
        {connection && (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void action("POST", "/test")}
            >
              测试连接
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void action("DELETE")}
            >
              断开
            </Button>
          </>
        )}
      </div>
      {message && (
        <p role="status" className="ide-muted">
          {message}
        </p>
      )}
      {connection?.settings.tools?.length ? (
        <details>
          <summary>已发现 {connection.settings.tools.length} 个工具</summary>
          {connection.settings.tools.map((tool) => (
            <p key={tool.name}>
              <code>
                mcp:{name}:{tool.name}
              </code>{" "}
              · {tool.description}
            </p>
          ))}
        </details>
      ) : null}
    </form>
  );
}
