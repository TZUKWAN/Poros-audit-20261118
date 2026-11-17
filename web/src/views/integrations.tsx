/** 集成与状态（凭证门控项固化：未配置的集成如实标注，不虚报可用）。 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, Card } from "../ui.js";

interface StatusBody {
  modelGateway: string;
  modelDisclaimer: string;
  runtime: string;
  executionGateway: string;
  dshModel: string;
  semanticJudge: string;
  kdocs: string;
  ima: string;
  tinyfish: string;
}

export default function IntegrationsView() {
  const [s, setS] = useState<StatusBody | null>(null);
  useEffect(() => {
    api<StatusBody>("GET", "/api/integrations/status").then((r) => {
      if (r.ok) setS(r.body as unknown as StatusBody);
    });
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm font-medium">执行与模型通道</p>
        {s && (
          <div className="grid gap-2 text-sm">
            <Row
              label="Agent Harness"
              value={
                <Badge tone={s.runtime === "dsh" ? "ok" : "warn"}>
                  {s.runtime === "dsh" ? "DSH 每任务独立容器" : "开发网关契约通道（未经 DSH）"}
                </Badge>
              }
            />
            <Row
              label="模型网关"
              value={
                s.modelGateway === "mock" ? (
                  <Badge tone="warn">mock（未配置真实模型服务）</Badge>
                ) : (
                  <Badge tone="ok">{s.modelGateway}</Badge>
                )
              }
            />
            <Row
              label="语义 Judge"
              value={
                <Badge tone={s.semanticJudge.startsWith("已配置") ? "ok" : "warn"}>
                  {s.semanticJudge}
                </Badge>
              }
            />
            <Row label="DSH 模型" value={<Badge>{s.dshModel}</Badge>} />
            <Row label="执行/评估模型准入" value={<Badge>{s.executionGateway}</Badge>} />
          </div>
        )}
      </Card>
      <Card>
        <p className="mb-3 text-sm font-medium">办公 / 知识 / 检索集成</p>
        {s && (
          <div className="grid gap-2 text-sm">
            <Row label="Kdocs" value={<Badge tone="warn">{s.kdocs}</Badge>} />
            <Row label="IMA" value={<Badge tone="warn">{s.ima}</Badge>} />
            <Row label="TinyFish Search/Fetch" value={<Badge tone="warn">{s.tinyfish}</Badge>} />
          </div>
        )}
        <p className="mt-3 text-xs text-[#a5a29b]">
          以上集成需要组织级凭证与真实能力绑定。当前未配置，接口不可调用，不能用配置开关标为可用。
        </p>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-[#faf9f7] px-3 py-2">
      <span className="text-[#5c5a55]">{label}</span>
      {value}
    </div>
  );
}
