import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import { api, getToken, login, logout, type OrgInfo } from "./api.js";
import { Button, Input } from "./ui.js";
import { RunCenter } from "./views/workspace.js";
import AgentsView from "./views/agents.js";
import IntegrationsView from "./views/integrations.js";
import GovernanceView from "./views/governance.js";
import ProjectsView, { MembersPanel } from "./views/projects.js";
import CapabilitiesView from "./views/capabilities.js";
import { InstallApp } from "./install.js";
import { useAppRoute, type WorkStart } from "./navigation.js";
import WorkView from "./views/work.js";

const tabClass =
  "min-h-11 rounded-t-lg px-2 py-2 text-sm text-[#66625c] hover:text-[#1f1f1e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a14e33] sm:px-4 data-[state=active]:border-b-2 data-[state=active]:border-[#c9694b] data-[state=active]:font-medium data-[state=active]:text-[#1f1f1e]";

export default function App() {
  const [logoutError, setLogoutError] = useState("");
  const [auth, setAuth] = useState<OrgInfo | null>(getToken() ? parseJwt(getToken()!) : null);
  const { route, navigate } = useAppRoute();
  useEffect(() => {
    const expired = () => setAuth(null);
    window.addEventListener("poros-auth-expired", expired);
    if (getToken())
      void api<{ info: OrgInfo }>("GET", "/api/auth/me").then((r) =>
        setAuth(r.ok ? r.body.info : null),
      );
    return () => window.removeEventListener("poros-auth-expired", expired);
  }, []);

  if (!auth) return <LoginView onLogin={setAuth} />;

  const openTask = async (id: string) => {
    const response = await api<{ task: { conversationId: string | null } }>(
      "GET",
      `/api/tasks/${id}`,
    );
    if (!response.ok) {
      setLogoutError(response.body.error ?? "工作读取失败");
      return;
    }
    if (response.body.task.conversationId)
      navigate({ tab: "workspace", conversationId: response.body.task.conversationId, taskId: id });
    else navigate({ tab: "runs", taskId: id });
  };
  const startWork = (start: WorkStart = {}) => navigate({ tab: "workspace", ...start });
  return (
    <div className="mx-auto min-h-dvh max-w-[1480px] px-4 pb-10 lg:px-8">
      <header className="flex items-center justify-between gap-2 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-bold">Poros 工作台</h1>
          <p className="truncate text-xs text-[#8a8880]">
            {auth.email} · 角色 {auth.role}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <InstallApp />
          <Button
            variant="ghost"
            onClick={async () => {
              if (await logout()) setAuth(null);
              else setLogoutError("退出未成功，请重试");
            }}
          >
            退出
          </Button>
        </div>
      </header>
      {logoutError && <p role="alert">{logoutError}</p>}
      <Tabs.Root value={route.tab} onValueChange={(tab) => navigate({ tab })}>
        <Tabs.List
          aria-label="工作台导航"
          className="mb-5 flex flex-wrap gap-x-1 border-b border-[#e3e1dc]"
        >
          {[
            ["workspace", "工作台"],
            ["agents", "Agent 目录"],
            ["projects", "项目空间"],
            ["runs", "运行中心"],
            ["governance", "审批与规则"],
            ["capabilities", "能力中心"],
            ["integrations", "设置"],
          ].map(([value, label]) => (
            <Tabs.Trigger key={value} value={value!} className={tabClass}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="workspace">
          <WorkView
            key={
              route.conversationId ??
              JSON.stringify([route.agentId, route.projectId, route.fileIds])
            }
            auth={auth}
            conversationId={route.conversationId}
            initialTaskId={route.taskId}
            start={route}
            onOpen={(id, taskId) => navigate({ tab: "workspace", conversationId: id, taskId })}
            onSelectTask={(taskId) =>
              navigate({ tab: "workspace", conversationId: route.conversationId, taskId }, true)
            }
            onStart={startWork}
            onAgents={() => navigate({ tab: "agents" })}
            onProject={(id) => navigate({ tab: "projects", projectId: id })}
            onGovernance={(taskId) => navigate({ tab: "governance", taskId })}
          />
        </Tabs.Content>
        <Tabs.Content value="agents">
          <AgentsView
            role={auth.role}
            ownerKey={auth.organizationId + ":" + auth.email}
            initialAgentId={route.agentId}
            onSelect={(id) => navigate({ tab: "agents", agentId: id }, true)}
            onUse={startWork}
          />
        </Tabs.Content>
        <Tabs.Content value="projects">
          <ProjectsView
            email={auth.email}
            role={auth.role}
            initialProjectId={route.projectId}
            onSelect={(id) => navigate({ tab: "projects", projectId: id || undefined }, true)}
            onStart={startWork}
            onOpenWork={(id) => navigate({ tab: "workspace", conversationId: id })}
            onOpenTask={openTask}
          />
        </Tabs.Content>
        <Tabs.Content value="runs">
          <RunCenter
            onContinue={openTask}
            taskId={route.taskId ?? ""}
            onOpen={(id) => navigate({ tab: "runs", taskId: id })}
          />
        </Tabs.Content>
        <Tabs.Content value="integrations" className="space-y-4">
          <IntegrationsView />
          {auth.role === "ADMIN" && <MembersPanel />}
        </Tabs.Content>
        <Tabs.Content value="capabilities">
          <CapabilitiesView role={auth.role} />
        </Tabs.Content>
        <Tabs.Content value="governance">
          <GovernanceView
            key={route.taskId ?? "all"}
            initialTaskId={route.taskId}
            role={auth.role}
            email={auth.email}
            organizationId={auth.organizationId}
            onOpenTask={openTask}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function parseJwt(token: string): OrgInfo | null {
  try {
    const p = JSON.parse(atob(token.split(".")[1]!)) as OrgInfo;
    if (typeof p.exp === "number" && p.exp * 1000 < Date.now()) return null;
    return {
      organizationId: String(p.organizationId),
      role: String(p.role),
      email: String(p.email),
    };
  } catch {
    return null;
  }
}

function LoginView({ onLogin }: { onLogin: (info: OrgInfo) => void }) {
  const [email, setEmail] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    const r = await login(email, password, organizationId);
    setBusy(false);
    if (!r.ok || !r.info) setError(r.error ?? "登录失败");
    else onLogin(r.info);
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Poros</h1>
        <p className="mt-1 text-sm text-[#8a8880]">企业 Agent 开发、配置、协作与治理平台</p>
      </div>
      <div className="space-y-3 rounded-2xl border border-[#e3e1dc] bg-white p-5">
        <label htmlFor="organization" className="block text-sm font-medium">
          组织 ID
        </label>
        <Input
          id="organization"
          autoCapitalize="none"
          autoComplete="organization"
          value={organizationId}
          onChange={(e) => setOrganizationId(e.target.value)}
        />
        <label className="block text-sm font-medium">邮箱</label>
        <Input
          aria-label="邮箱"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="您的组织邮箱"
        />
        <label className="block text-sm font-medium">密码</label>
        <Input
          aria-label="密码"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <p className="text-sm text-[#a1301c]">{error}</p>}
        <Button
          className="w-full justify-center"
          disabled={busy || !password || !email || !organizationId}
          onClick={submit}
        >
          {busy ? "登录中…" : "登录"}
        </Button>
      </div>
      <div className="mt-4 flex justify-center">
        <InstallApp />
      </div>
    </div>
  );
}
