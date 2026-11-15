import fs from 'node:fs';
const p = process.env.USERPROFILE + '/.pi/scenario/scenarios.json';
const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
const s = raw['sc-panel-1793828375347'];
// 恢复真实状态（清除所有测试注入）
s.ledger.inputPatterns = (s.ledger.inputPatterns ?? []).filter((e) => e.digest !== 'f1459fd65ab7ba5ad2b8ccc52c7e4a6b4075d399' && e.digest !== '337152646256b1f41dd084600739b65b22a340b2');
s.ledger.runStats = { runs: 8, accepted: 8, rejected: 0, corrected: 0, consecutiveClean: 2 };
console.log('cleaned → runStats:', JSON.stringify(s.ledger.runStats), 'inputPatterns:', (s.ledger.inputPatterns ?? []).length);
fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf8');
