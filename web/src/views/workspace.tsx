import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { dateTime, type TaskRow } from "../pc.js";
import { Button, Card, Input, PageHeading, StatusBadge } from "../ui.js";
import RunDetails from "./run-details.js";

export function TaskList({
  projectId,
  onOpen,
  selectedId,
  refresh = 0,
  title = "我的任务",
}: {
  projectId?: string;
  onOpen: (id: string) => void;
  selectedId?: string;
  refresh?: number;
  title?: string;
}) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const query = new URLSearchParams({
      q,
      page: String(page),
      ...(projectId ? { projectId } : {}),
    });
    const r = await api<{ tasks: TaskRow[]; hasMore: boolean }>("GET", "/api/tasks?" + query);
    if (!r.ok) {
      setError(r.body.error ?? "读取任务失败");
      return;
    }
    setError("");
    setRows(r.body.tasks);
    setMore(r.body.hasMore);
  }, [projectId, q, page]);
  useEffect(() => {
    void load();
  }, [load, refresh]);
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        <Button variant="ghost" onClick={() => void load()}>
          刷新任务
        </Button>
      </div>
      <Input
        aria-label="搜索任务"
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
          setPage(1);
        }}
        placeholder="按任务内容搜索"
      />
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      ) : (
        <>
          {!rows.length && <p className="mt-3 text-sm text-slate-600">暂无任务</p>}
          <ul className="mt-2 space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:bg-slate-50 aria-[current=true]:border-[#c9694b] aria-[current=true]:bg-[#fbf3ef]"
                  aria-current={row.id === selectedId ? "true" : undefined}
                  onClick={() => onOpen(row.id)}
                >
                  <span className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">{row.title}</span>
                    <StatusBadge status={row.status} />
                  </span>
                  <span className="text-xs text-slate-600">
                    {row.createdBy} · {dateTime(row.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {(page > 1 || more) && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button variant="ghost" disabled={!more} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      )}
    </Card>
  );
}

export function RunCenter({
  taskId,
  onOpen,
  onContinue,
}: {
  taskId: string;
  onOpen: (id: string) => void;
  onContinue: (id: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  return (
    <>
      <PageHeading title="运行中心" />
      <div className="grid gap-4 lg:grid-cols-[minmax(250px,1fr)_minmax(0,2.4fr)]">
        <TaskList refresh={refresh} onOpen={onOpen} selectedId={taskId} />
        {taskId ? (
          <div className="min-w-0 space-y-3">
            <Button variant="ghost" onClick={() => onContinue(taskId)}>
              在工作台继续
            </Button>
            <RunDetails key={taskId} taskId={taskId} onChanged={reload} />
          </div>
        ) : (
          <Card>
            <p className="text-sm">选择任务查看执行证据与结果。</p>
          </Card>
        )}
      </div>
    </>
  );
}
