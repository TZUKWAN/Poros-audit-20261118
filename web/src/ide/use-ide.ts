import { submissionKey, forgetSubmission, definiteRejection } from "./pending.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Details, Job, Kind, Workspace } from "./types.js";
import { activeJob } from "./types.js";

const readId = () => {
  const match = location.hash.match(/^#\/ide\/([A-Za-z0-9_-]+)$/);
  return match?.[1] || "";
};
export function useIde(owner: string) {
  const [id, setId] = useState(readId);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const currentId = useRef(id),
    latest = useRef<Details | null>(null),
    mounted = useRef(true);
  const inFlight = useRef(new Set<string>());
  currentId.current = id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const select = useCallback(
    (next: string) => {
      setId(next);
      currentId.current = next;
      history.pushState(null, "", "#/ide/" + next);
      try {
        localStorage.setItem("poros-ide-recent:" + owner, next);
      } catch {
        /* Navigation still works without local storage. */
      }
    },
    [owner],
  );
  useEffect(() => {
    const update = () => setId(readId());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  const refresh = useCallback(async (target = currentId.current) => {
    if (!target || inFlight.current.has(target)) return;
    inFlight.current.add(target);
    const previous = latest.current?.workspace.id === target ? latest.current : null;
    try {
      const response = await api<Omit<Details, "files"> & { files?: Details["files"] }>(
        "GET",
        `/api/ide/workspaces/${target}${previous ? "?since=" + previous.workspace.sourceDigest : ""}`,
      );
      if (!mounted.current || currentId.current !== target) return;
      if (!response.ok) {
        setError(response.body.error || "读取工程失败");
        return;
      }
      const next: Details = {
        ...response.body,
        files: response.body.files || previous?.files || {},
      };
      latest.current = next;
      setData(next);
      setError("");
      setWorkspaces((items) =>
        [next.workspace, ...items.filter((item) => item.id !== target)].slice(0, 100),
      );
    } finally {
      inFlight.current.delete(target);
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void api<{ workspaces: Workspace[] }>("GET", "/api/ide/workspaces").then((response) => {
      if (!alive) return;
      if (!response.ok) {
        setError(response.body.error || "读取工程列表失败");
        return;
      }
      setWorkspaces(response.body.workspaces);
      if (!currentId.current && response.body.workspaces.length) {
        let recent = "";
        try {
          recent = localStorage.getItem("poros-ide-recent:" + owner) || "";
        } catch {
          /* Optional history. */
        }
        select(
          response.body.workspaces.find((item) => item.id === recent)?.id ||
            response.body.workspaces[0]!.id,
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [owner, select]);
  useEffect(() => {
    if (!id) return;
    void refresh(id);
    const timer = setInterval(() => {
      void refresh(id);
    }, 1600);
    return () => clearInterval(timer);
  }, [id, refresh]);
  const create = useCallback(
    async (name: string, kind: Kind) => {
      const response = await api<{ workspace: Workspace }>("POST", "/api/ide/workspaces", {
        name,
        kind,
      });
      if (!response.ok) throw new Error(response.body.error || "创建工程失败");
      select(response.body.workspace.id);
      await refresh(response.body.workspace.id);
      return response.body.workspace;
    },
    [select, refresh],
  );
  const submit = useCallback(
    async (
      kind: string,
      input: Record<string, unknown>,
      buildId?: string,
      workspace?: Workspace,
    ) => {
      const current =
        workspace ||
        (latest.current?.workspace.id === currentId.current ? latest.current.workspace : null);
      if (!current) throw new Error("请先打开或创建工程");
      const signature = JSON.stringify([current.id, kind, input, buildId]);
      const namespace = "poros-ide-pending:" + owner + ":" + current.id,
        receipt = await submissionKey(namespace, signature, current.sourceDigest);
      const request = {
        key: receipt.key,
        body: {
          kind,
          input,
          buildId,
          expectedDigest: receipt.expectedDigest || current.sourceDigest,
        },
      };
      setSending(true);
      try {
        const response = await api<{ job: Job }>(
          "POST",
          `/api/ide/workspaces/${current.id}/jobs`,
          request.body,
          { "idempotency-key": request.key },
        );
        if (definiteRejection(response.status) || (response.ok && response.body.job?.id))
          forgetSubmission(namespace, request.key);
        if (!response.ok) throw new Error(response.body.error || "提交失败");
        if (!response.body.job?.id) throw new Error("运行回执不完整，请重试找回原请求");
        await refresh(current.id);
        return response.body.job;
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [refresh, owner],
  );
  const wait = useCallback(
    async (workspaceId: string, job: Job, signal?: AbortSignal) => {
      const deadline = Date.now() + 320000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const response = await api<{ job: Job }>(
          "GET",
          `/api/ide/workspaces/${workspaceId}/jobs/${job.id}`,
        );
        if (!response.ok) throw new Error(response.body.error || "读取运行失败");
        const current = response.body.job;
        if (!activeJob(current)) {
          await refresh(workspaceId);
          if (current.status !== "SUCCEEDED")
            throw new Error(current.output.error || "运行没有完成");
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      throw new Error("等待结果超时，运行记录仍会保留，请查看最近试用");
    },
    [refresh],
  );
  const stop = useCallback(
    async (jobId: string) => {
      const response = await api(
        "POST",
        `/api/ide/workspaces/${currentId.current}/jobs/${jobId}/cancel`,
      );
      if (!response.ok) throw new Error(response.body.error || "停止失败");
      await refresh();
    },
    [refresh],
  );
  const save = useCallback(
    async (files: Record<string, string>, expectedDigest: string) => {
      const response = await api<{ digest: string }>(
        "PUT",
        `/api/ide/workspaces/${currentId.current}/source`,
        { expectedDigest, files },
      );
      if (!response.ok) throw new Error(response.body.error || "保存失败");
      await refresh();
      return response.body.digest;
    },
    [refresh],
  );
  return {
    id,
    data: data?.workspace.id === id ? data : null,
    workspaces,
    error,
    setError,
    sending,
    create,
    select,
    refresh,
    submit,
    wait,
    stop,
    save,
  };
}
export type IdeController = ReturnType<typeof useIde>;
