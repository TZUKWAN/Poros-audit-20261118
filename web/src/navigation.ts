import { useCallback, useEffect, useState } from "react";

export type WorkStart = { agentId?: string; projectId?: string; fileIds?: string[] };
export type AppRoute = WorkStart & { tab: string; conversationId?: string; taskId?: string };
const tabs = new Set([
  "workspace",
  "agents",
  "projects",
  "runs",
  "capabilities",
  "governance",
  "integrations",
]);

function readRoute(): AppRoute {
  const [path = "", query = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
  const parameters = new URLSearchParams(query);
  const [section, id] = path.split("/");
  let conversationId: string | undefined;
  try {
    conversationId = section === "work" && id ? decodeURIComponent(id) : undefined;
  } catch {
    /* Ignore malformed external fragments. */
  }
  return {
    tab: section === "work" ? "workspace" : tabs.has(section ?? "") ? section! : "workspace",
    conversationId,
    taskId: parameters.get("task") || undefined,
    agentId: parameters.get("agent") || undefined,
    projectId: parameters.get("project") || undefined,
    fileIds: parameters.getAll("file"),
  };
}

export function useAppRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  const navigate = useCallback((next: AppRoute, replace = false) => {
    const parameters = new URLSearchParams();
    if (next.taskId) parameters.set("task", next.taskId);
    if (next.agentId) parameters.set("agent", next.agentId);
    if (next.projectId) parameters.set("project", next.projectId);
    next.fileIds?.forEach((id) => parameters.append("file", id));
    const path = next.conversationId ? "work/" + encodeURIComponent(next.conversationId) : next.tab;
    const hash = "#/" + path + (parameters.size ? "?" + parameters.toString() : "");
    window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    setRoute(next);
  }, []);
  return { route, navigate };
}
