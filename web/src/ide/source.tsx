import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Button, Dialog, DialogClose, Input, Select, Textarea } from "../ui.js";
import { jobLabel, pretty, type Details, type Job } from "./types.js";

export function SourceEditor({
  data,
  path,
  onClose,
  onSave,
}: {
  data: Details;
  path?: string;
  onClose: () => void;
  onSave: (files: Record<string, string>, digest: string) => Promise<string>;
}) {
  const [files, setFiles] = useState({ ...data.files });
  const [selected, setSelected] = useState(
    path && data.files[path] !== undefined ? path : "poros.json",
  );
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [digest, setDigest] = useState(data.workspace.sourceDigest);
  return (
    <Dialog
      title="工程源文件"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <p className="ide-muted">
        保存以打开时的源码版本为依据。发生并发修改时保留编辑内容，请先复制或比较后再处理。
      </p>
      <label className="ide-source-label">
        文件
        <Select
          aria-label="选择工程文件"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {Object.keys(files)
            .sort()
            .map((name) => (
              <option key={name}>{name}</option>
            ))}
        </Select>
      </label>
      <Textarea
        className="ide-code-editor"
        aria-label="工程源代码"
        rows={20}
        spellCheck={false}
        value={files[selected] || ""}
        onChange={(e) => {
          setFiles((f) => ({ ...f, [selected]: e.target.value }));
          setSaved(false);
        }}
      />
      <div className="ide-actions">
        <Input
          aria-label="新文件路径"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          placeholder="新文件路径，例如 tests/cases.json"
        />
        <Button
          variant="ghost"
          onClick={() => {
            if (!filename.trim() || Object.hasOwn(files, filename.trim())) {
              setError("请输入未使用的文件路径");
              return;
            }
            setFiles((f) => ({ ...f, [filename.trim()]: "" }));
            setSelected(filename.trim());
            setFilename("");
            setSaved(false);
          }}
        >
          添加文件
        </Button>
      </div>
      {error && (
        <p role="alert" className="ide-error">
          {error}
        </p>
      )}
      {saved && <p role="status">已保存真实源码版本。关闭后可构建或继续开发。</p>}
      <div className="ide-actions">
        <Button
          disabled={busy || saved}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setDigest(await onSave(files, digest));
              setSaved(true);
            } catch (e) {
              setError(e instanceof Error ? e.message : "保存失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "保存中…" : "保存修改"}
        </Button>
        <DialogClose asChild>
          <Button variant="ghost">关闭</Button>
        </DialogClose>
      </div>
    </Dialog>
  );
}

export function JobDetails({
  workspaceId,
  job,
  onClose,
}: {
  workspaceId: string;
  job: Job;
  onClose: () => void;
}) {
  const [full, setFull] = useState(job),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void api<{ job: Job }>("GET", "/api/ide/workspaces/" + workspaceId + "/jobs/" + job.id).then(
      (r) => {
        if (!alive) return;
        if (r.ok) setFull(r.body.job);
        else setError(r.body.error || "记录读取失败");
      },
    );
    return () => {
      alive = false;
    };
  }, [workspaceId, job.id]);
  return (
    <Dialog
      title="执行记录"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="ide-row">
        <strong>{jobLabel(full.status)}</strong>
        <DialogClose asChild>
          <Button variant="ghost">关闭</Button>
        </DialogClose>
      </div>
      {error && (
        <p role="alert" className="ide-error">
          {error}
        </p>
      )}
      <p className="ide-muted">
        {new Date(full.createdAt).toLocaleString()} · 模型调用 {full.usage?.modelCalls ?? "未知"} 次
        · 输入 {full.usage?.inputTokens ?? "未知"} / 输出 {full.usage?.outputTokens ?? "未知"} token
      </p>
      <h3>实际结果</h3>
      <pre className="ide-result">{pretty(full.output)}</pre>
      <details>
        <summary>运行事件 · {full.events?.length || 0} 条</summary>
        {full.events?.map((event, index) => (
          <div key={event.seq || index}>
            <strong>{event.type}</strong>
            <pre className="ide-result">{pretty(event.data)}</pre>
          </div>
        ))}
      </details>
    </Dialog>
  );
}
