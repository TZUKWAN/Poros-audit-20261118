import fs from 'node:fs';
const LOG = (m) => { console.log(m); fs.appendFileSync('D:/metis-replay.log', `[${new Date().toISOString().slice(11, 19)}] ${m}\n`); };
const REQ = '帮我把这段客户反馈「快递包装破损，客服响应慢，但产品质量不错」归类整理成一份服务质量周报，包含问题分类和改进建议';
const SCEN_ID = 'sc-panel-1793828375347';
const ws = new (await import('ws')).default('ws://127.0.0.1:4517');
let snap = null; let lastPending = -1; let manual = 0;
ws.on('message', (raw) => {
  const d = JSON.parse(raw.toString());
  if (d.kind === 'snapshot') snap = d.snapshot;
  if (d.kind === 'progress' && d.line) { const t = String(d.line); if (t.includes('分寸') || t.includes('重放') || t.includes('体检')) LOG('★ progress: ' + t.slice(0, 100)); }
  if (d.kind === 'chat' && d.message.terminal) LOG('TERM: ' + String(d.message.text ?? '').slice(0, 60));
});
await new Promise((res) => ws.once('open', res));
await new Promise((r) => setTimeout(r, 1500));
const sendAction = (p) => new Promise((res) => { const h = (raw) => { const d = JSON.parse(raw.toString()); if (d.kind === 'action-result' && d.ok !== undefined) { ws.off('message', h); res(d); } }; ws.on('message', h); ws.send(JSON.stringify(p)); setTimeout(() => { ws.off('message', h); res({ ok: false, error: 'timeout' }); }, 30000); });
LOG('启动 work（digest 修复后 → 期待 replay 分支）');
await sendAction({ type: 'start-build', requirement: REQ, mode: 'work' });
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  await new Promise((r) => setTimeout(r, 1500));
  const gate = snap?.pendingGate;
  if (gate && gate !== lastPending) { lastPending = gate; manual += 1; await sendAction({ type: 'gate-decision', decision: { gate, action: 'approve' } }); await new Promise((r) => setTimeout(r, 800)); lastPending = -1; }
  const run = (snap?.runs ?? []).find((r) => String(r.requirement ?? '').includes('客户反馈') && r.startedAt > new Date(t0).toISOString() && (r.status === 'succeeded' || r.status === 'failed'));
  if (run) { LOG(`终态: ${run.status} | 手动 ${manual} 次 | ${manual === 0 ? '★★★ REPLAY 分支零干预' : '走了其他分支'}`); break; }
}
process.exit(0);
