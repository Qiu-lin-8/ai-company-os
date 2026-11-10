// 离线自测:篡改内存快照后重新同步,验证 added/updated/removed 的对比逻辑(不写飞书)
const os = require('os'), fs = require('fs'), path = require('path');
const { loadEnv } = require('../lib/env.cjs'); loadEnv();
const { BaseSync } = require('../sync/worker.cjs');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
  const w = new BaseSync({ dataDir: dir, log: () => {} });
  await w.syncAll('t1');
  const snap = w.snapshot;
  const t = Object.values(snap.tables).find((x) => x.name === '生产工单');
  const ids = Object.keys(t.records);
  t.records[ids[0]]['已完工数量'] = 1;                    // 模拟:值被改
  t.records[ids[0]]['当前状态'] = '待生产';
  delete t.records[ids[1]];                               // 模拟:飞书里新增(本地没有)
  t.records['recFAKE'] = { 工单号: 'HL-FAKE' };           // 模拟:飞书里删除
  const r = await w.syncAll('t2');
  for (const c of r.changes) console.log(c.type, c.table, c.label, JSON.stringify(c.fields), c.diff ? JSON.stringify(c.diff) : '');
  console.log('changes.jsonl lines:', fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8').trim().split('\n').length);
  const again = await w.syncAll('t3'); console.log('idempotent changes:', again.changes.length);
})().catch((e) => { console.error(e.message); process.exit(1); });
