import { RemoteSettings } from "./remote.js";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Input } from "../ui.js";
import IntegrationsView from "../views/integrations.js";
import { EndpointForm, type Connection } from "../ide/settings.js";
import type { AppInfo } from "./index.js";
import type { appApi } from "./api.js";
import { appBase } from "./api.js";
import { InstallApp } from "../install.js";
interface Settings {
  settings: { authorizedTools: string[]; enabledSkills?: string[] };
  connections: Array<Connection & { provider: string }>;
  skills: Array<{ name: string; directory: string; description: string }>;
  permissions: string[];
  publisher: string;
}
interface Device {
  id: string;
  name: string;
  grants: string[];
  revokedAt: string | null;
}
export function RuntimeSettings({
  open,
  onOpenChange,
  info,
  api,
  refresh,
  onLogout,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  info: AppInfo;
  api: ReturnType<typeof appApi>;
  refresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [remoteUrl, setRemoteUrl] = useState(""),
    [state, setState] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [requests, setRequests] = useState<
      Array<{ id: string; name: string; status: string; grants: string[] }>
    >([]),
    [devices, setDevices] = useState<Device[]>([]),
    [code, setCode] = useState(""),
    [grants, setGrants] = useState<string[]>([]),
    [accept, setAccept] = useState(false),
    [busy, setBusy] = useState(false);
  const owner = info.role === "OWNER";
  const load = async () => {
    if (!owner) return;
    const r = await api<Settings>("GET", "/api/app/settings");
    if (!r.ok) throw new Error(r.body.error || "设置读取失败");
    setState(r.body);
  };
  const pairState = async () => {
    if (!owner) return;
    const [a, b] = await Promise.all([
      api<{ requests: typeof requests }>("GET", "/api/app/pair/requests"),
      api<{ devices: Device[] }>("GET", "/api/app/devices"),
    ]);
    if (a.ok) setRequests(a.body.requests);
    if (b.ok) setDevices(b.body.devices);
  };
  const act = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };
  useEffect(() => {
    if (!open || !owner) return;
    void act(async () => {
      await load();
      await pairState();
    });
    setGrants(info.authorizedTools || []);
    const timer = setInterval(() => {
      void pairState();
    }, 2000);
    return () => clearInterval(timer);
  }, [open, owner]);
  const save = async (change: Partial<Settings["settings"]>) => {
    const r = await api("PUT", "/api/app/settings", { ...state?.settings, ...change });
    if (!r.ok) throw new Error(r.body.error || "保存失败");
    await load();
    await refresh();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ide-overlay" />
        <Dialog.Content className="ide-settings" aria-describedby="app-settings-description">
          <div className="ide-row">
            <Dialog.Title>软件设置</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost">关闭</Button>
            </Dialog.Close>
          </div>
          <Dialog.Description id="app-settings-description" className="ide-muted">
            {owner
              ? "连接凭证保存在此安装端。更换连接或权限会停止进行中的任务。"
              : "任务在安装端运行。连接和能力由电脑端所有者管理。"}
          </Dialog.Description>
          {error && (
            <p role="alert" className="ide-error">
              {error}
            </p>
          )}
          {owner && (
            <div className="app-settings-list">
              <IntegrationsView context="app" request={api} endpointBase="/api/app/connections" />
              {state && (
                <>
                  <Card>
                    <h3>技能</h3>
                    {state.skills.length ? (
                      state.skills.map((skill) => (
                        <div key={skill.directory} className="ide-capability">
                          <label className="ide-permission">
                            <input
                              type="checkbox"
                              checked={
                                !state.settings.enabledSkills ||
                                state.settings.enabledSkills.includes(skill.directory)
                              }
                              onChange={(e) =>
                                void act(() =>
                                  save({
                                    enabledSkills: e.target.checked
                                      ? [...(state.settings.enabledSkills || []), skill.directory]
                                      : state.skills
                                          .map((s) => s.directory)
                                          .filter(
                                            (d) =>
                                              d !== skill.directory &&
                                              (!state.settings.enabledSkills ||
                                                state.settings.enabledSkills.includes(d)),
                                          ),
                                  }),
                                )
                              }
                            />
                            {skill.name}
                          </label>
                          <p className="ide-muted">{skill.description}</p>
                        </div>
                      ))
                    ) : (
                      <p className="ide-muted">此软件没有附带技能。</p>
                    )}
                  </Card>
                  <Card>
                    <h3>MCP 与业务 API</h3>
                    <p className="ide-muted">
                      使用软件源码声明的连接名称。此处只绑定账号，不授予额外能力。
                    </p>
                    <EndpointForm
                      workspaceId=""
                      kind="mcp"
                      request={api}
                      endpointBase="/api/app/connections"
                      onReload={load}
                    />
                    <EndpointForm
                      workspaceId=""
                      kind="api"
                      request={api}
                      endpointBase="/api/app/connections"
                      onReload={load}
                    />
                    {state.connections
                      .filter((item) => /^(mcp|api):/.test(item.provider))
                      .map((item) => (
                        <EndpointForm
                          key={item.provider}
                          workspaceId=""
                          kind={item.provider.startsWith("mcp:") ? "mcp" : "api"}
                          name={item.provider.split(":")[1]}
                          connection={{ ...item, key: item.provider }}
                          request={api}
                          endpointBase="/api/app/connections"
                          onReload={load}
                        />
                      ))}
                  </Card>
                  <Card>
                    <h3>允许此软件使用的能力</h3>
                    {state.permissions.length ? (
                      state.permissions.map((name) => (
                        <label key={name} className="ide-permission">
                          <input
                            type="checkbox"
                            checked={state.settings.authorizedTools.includes(name)}
                            onChange={(e) =>
                              void act(() =>
                                save({
                                  authorizedTools: e.target.checked
                                    ? [...state.settings.authorizedTools, name]
                                    : state.settings.authorizedTools.filter((n) => n !== name),
                                }),
                              )
                            }
                          />
                          <code>{name}</code>
                        </label>
                      ))
                    ) : (
                      <p className="ide-muted">
                        没有声明外部工具权限。运行仍需要配置实际使用的模型或连接。
                      </p>
                    )}
                  </Card>
                  <RemoteSettings api={api} onUrl={setRemoteUrl} />
                  <Card>
                    <h3>连接手机</h3>
                    <p className="ide-muted">
                      在手机可访问的远程地址打开本软件，输入配对码，再在电脑端确认。配对码有效两分钟。
                    </p>
                    {(info.authorizedTools || []).map((name) => (
                      <label key={name} className="ide-permission">
                        <input
                          type="checkbox"
                          checked={grants.includes(name)}
                          onChange={(e) =>
                            setGrants((items) =>
                              e.target.checked
                                ? [...items, name]
                                : items.filter((item) => item !== name),
                            )
                          }
                        />
                        {name}
                      </label>
                    ))}
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void act(async () => {
                          const r = await api<{ code: string }>("POST", "/api/app/pair/invites", {
                            grants,
                          });
                          if (!r.ok) throw new Error(r.body.error || "配对码生成失败");
                          setCode(r.body.code);
                        })
                      }
                    >
                      生成配对码
                    </Button>
                    {code && (
                      <>
                        <p className="app-code">{code}</p>
                        {remoteUrl && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(remoteUrl + "#/pair/" + code)
                                .catch(() => setError("复制失败，请手动复制配对码"))
                            }
                          >
                            复制手机配对链接
                          </Button>
                        )}
                      </>
                    )}
                    {requests
                      .filter((item) => item.status === "PENDING")
                      .map((item) => (
                        <article className="app-device" key={item.id}>
                          <p>{item.name} 请求连接</p>
                          <p className="ide-muted">
                            {item.grants.join("、") || "仅运行，不授予外部工具"}
                          </p>
                          <Button
                            onClick={() =>
                              void act(async () => {
                                const r = await api(
                                  "POST",
                                  "/api/app/pair/" + item.id + "/approve",
                                );
                                if (!r.ok) throw new Error(r.body.error || "确认失败");
                                await pairState();
                              })
                            }
                          >
                            同意此设备
                          </Button>
                        </article>
                      ))}
                    {devices.map((item) => (
                      <article className="app-device" key={item.id}>
                        <div className="ide-row">
                          <span>{item.name}</span>
                          {item.revokedAt ? (
                            <Badge>已撤销</Badge>
                          ) : (
                            <Button
                              variant="danger"
                              onClick={() =>
                                void act(async () => {
                                  const r = await api("DELETE", "/api/app/devices/" + item.id);
                                  if (!r.ok) throw new Error(r.body.error || "撤销失败");
                                  await pairState();
                                })
                              }
                            >
                              撤销连接
                            </Button>
                          )}
                        </div>
                      </article>
                    ))}
                  </Card>
                  <Card>
                    <h3>更新软件</h3>
                    <p className="ide-muted">
                      只接受同一软件、同一发布者签名的工程包。可选择此前导出的旧版包进行回退。新增能力不会自动获得运行授权。
                    </p>
                    <p className="app-code">发布者：{state.publisher}</p>
                    <label className="ide-permission">
                      <input
                        type="checkbox"
                        checked={accept}
                        onChange={(e) => setAccept(e.target.checked)}
                      />
                      我已核对更新声明的新增能力
                    </label>
                    <label>
                      选择已签名工程包
                      <Input
                        type="file"
                        accept=".json"
                        disabled={busy}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (!file) return;
                          setBusy(true);
                          await act(async () => {
                            if (file.size > 16 * 1024 * 1024) throw new Error("工程包超过 16 MB");
                            const r = await api(
                              "POST",
                              "/api/app/update",
                              { package: JSON.parse(await file.text()), acceptPermissions: accept },
                              {},
                              30000,
                            );
                            if (!r.ok) throw new Error(r.body.error || "更新失败");
                            await load();
                            await refresh();
                            setAccept(false);
                          });
                          setBusy(false);
                        }}
                      />
                    </label>
                  </Card>
                </>
              )}
            </div>
          )}
          <div className="ide-row">
            <span className="ide-muted">版本 {info.version.slice(0, 10)}</span>
            <InstallApp name={info.name} base={appBase + "/"} />
            <Button variant="ghost" onClick={() => void act(onLogout)}>
              退出此会话
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
