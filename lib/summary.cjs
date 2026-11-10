'use strict';
/* 基于规则的中文项目摘要(不调用任何大模型):工单进度、合格率、缺料、最近变更。 */

const QUALITY_WARN = Number(process.env.QUALITY_WARN) || 0.9;   // 合格率低于此值提示
const LOW_RATIO = Number(process.env.LOW_STOCK_RATIO) || 0.3;   // 剩余库存/目前库存 ≤ 该比例视为偏低

const num = (v) => { const x = Array.isArray(v) ? v[0] : v; const n = typeof x === 'number' ? x : Number(x); return Number.isFinite(n) ? n : null; };
const str = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join('、') : String(v));
const pct = (x, d = 1) => (x === null ? '—' : (x * 100).toFixed(d).replace(/\.0+$/, '') + '%');
const findTable = (snap, ...names) => Object.values(snap.tables).find((t) => names.some((n) => t.name === n || t.name.includes(n)));
const rows = (t) => (t ? Object.entries(t.records).map(([id, f]) => ({ record_id: id, ...f })) : []);

const CH_LABEL = { added: '新增', updated: '更新', removed: '删除', table_added: '新增数据表', table_removed: '删除数据表', initial_sync: '首次同步' };

function summarize(snap, changes = []) {
  if (!snap) return { ready: false, lines: ['尚未完成首次同步'] };
  const out = { ready: true, synced_at: snap.synced_at, lines: [], work_orders: [], product_quality: [], shortages: [], picking_issues: [], recent_changes: [] };

  /* 工单进度 */
  const wo = rows(findTable(snap, '生产工单'));
  const byStatus = {};
  for (const r of wo) {
    const plan = num(r['计划数量']), done = num(r['已完工数量']), ok = num(r['合格数量']), bad = num(r['不良数量']), shipped = num(r['已发货数量']), started = num(r['已投产数量']);
    const progress = plan ? Math.min(1, (done || 0) / plan) : null;
    const yieldRate = done ? Math.min(1, (ok || 0) / done) : null;
    const status = str(r['当前状态']) || '未知';
    byStatus[status] = (byStatus[status] || 0) + 1;
    const flags = [];
    if (yieldRate !== null && yieldRate < QUALITY_WARN) flags.push(`合格率 ${pct(yieldRate)} 低于 ${pct(QUALITY_WARN, 0)}`);
    if (status === '待生产' && ((done || 0) > 0 || (started || 0) > 0)) flags.push('状态为「待生产」但已有投产/完工数量,请核对状态');
    out.work_orders.push({ record_id: r.record_id, 工单号: str(r['工单号']), 产品名称: str(r['产品名称']), 产品编码: str(r['产品编码']), 当前状态: status,
      计划数量: plan, 已投产数量: started, 已完工数量: done, 合格数量: ok, 不良数量: bad, 已发货数量: shipped, 进度: progress, 合格率: yieldRate, flags });
  }
  out.work_orders.sort((a, b) => a.工单号.localeCompare(b.工单号));
  if (wo.length) {
    out.lines.push(`共 ${wo.length} 张生产工单:` + Object.entries(byStatus).map(([k, v]) => `${k} ${v} 张`).join('、') + '。');
    for (const w of out.work_orders) {
      let s = `工单 ${w.工单号}(${w.产品名称})${w.当前状态},完工 ${w.已完工数量 ?? 0}/${w.计划数量 ?? '?'},进度 ${pct(w.进度, 0)}`;
      if (w.合格率 !== null) s += `,合格率 ${pct(w.合格率)}`;
      if (w.已发货数量) s += `,已发货 ${w.已发货数量}`;
      s += '。';
      if (w.flags.length) s += ' ⚠ ' + w.flags.join(';') + '。';
      out.lines.push(s);
    }
  }

  /* 按产品汇总的合格率 */
  for (const r of rows(findTable(snap, '生产完成汇总'))) {
    const rate = num(r['合格率']);
    out.product_quality.push({ 产品编码: str(r['产品编码']), 产品名称: str(r['产品名称']), 计划生产套数: num(r['计划生产套数']), 已投产套数: num(r['已投产套数']), 合格套数: num(r['合格套数']), 不良套数: num(r['不良套数']), 已发货套数: num(r['已发货套数']), 现存量: num(r['现存量']), 合格率: rate });
  }
  const lowQ = out.product_quality.filter((p) => p.合格率 !== null && p.合格率 < QUALITY_WARN);
  if (out.product_quality.length) {
    const tot = out.product_quality.reduce((a, p) => ({ ok: a.ok + (p.合格套数 || 0), plan: a.plan + (p.计划生产套数 || 0), ship: a.ship + (p.已发货套数 || 0) }), { ok: 0, plan: 0, ship: 0 });
    out.lines.push(`按产品汇总:计划 ${tot.plan} 套,累计合格 ${tot.ok} 套(完成率 ${pct(tot.plan ? tot.ok / tot.plan : null, 0)}),已发货 ${tot.ship} 套。`);
    if (lowQ.length) out.lines.push(`合格率低于 ${pct(QUALITY_WARN, 0)} 的产品:` + lowQ.map((p) => `${p.产品名称 || p.产品编码} ${pct(p.合格率)}`).join('、') + '。');
  }

  /* 缺料:仅物料(类型=物料),剩余库存 ≤ 0 或 ≤ 目前库存×30% */
  for (const r of rows(findTable(snap, '产品物料基础资料'))) {
    if (str(r['类型']) !== '物料') continue;
    const left = num(r['剩余库存']), cur = num(r['目前库存']);
    if (left === null) continue;
    let level = null, reason = '';
    if (left <= 0) { level = 'short'; reason = '剩余库存已耗尽'; }
    else if (cur && left / cur <= LOW_RATIO) { level = 'low'; reason = `剩余库存仅占目前库存的 ${pct(left / cur, 0)}`; }
    if (level) out.shortages.push({ 编码: str(r['编码']), 名称: str(r['名称']), 单位: str(r['单位']), 目前库存: cur, 剩余库存: left, 标准用量: num(r['标准用量']), 供应商: str(r['供应商']), level, reason });
  }
  out.shortages.sort((a, b) => (a.level === b.level ? a.剩余库存 - b.剩余库存 : a.level === 'short' ? -1 : 1));
  if (out.shortages.length) out.lines.push('库存预警:' + out.shortages.map((s) => `${s.名称}(${s.编码})剩余 ${s.剩余库存}${s.单位},${s.reason}`).join(';') + '。');
  else if (findTable(snap, '产品物料基础资料')) out.lines.push('库存预警:暂无偏低的物料。');

  /* 领料异常:实领 < 应领 */
  for (const r of rows(findTable(snap, '领料记录'))) {
    const need = num(r['应领数量']), got = num(r['实领数量']);
    if (need !== null && got !== null && got < need) out.picking_issues.push({ 领料单号: str(r['领料单号']), 工单号: str(r['工单号']), 物料名称: str(r['物料名称']), 应领数量: need, 实领数量: got, 缺口: need - got });
  }
  if (out.picking_issues.length) out.lines.push('领料不足:' + out.picking_issues.map((p) => `${p.领料单号}(${p.物料名称})缺 ${p.缺口}`).join('、') + '。');

  /* 最近变更 */
  const recent = changes.filter((c) => c.type !== 'initial_sync').slice(-10).reverse();
  out.recent_changes = recent.map((c) => ({ seq: c.seq, ts: c.ts, type: c.type, 表: c.table, 记录: c.label, 字段: c.fields, text: describe(c) }));
  out.lines.push(recent.length ? `最近 ${recent.length} 条变更:` + out.recent_changes.slice(0, 5).map((c) => c.text).join(';') + '。' : '同步以来暂无数据变更。');
  return out;
}

function describe(c) {
  const t = `${c.table || ''}`;
  if (c.type === 'updated') {
    const d = Object.entries(c.diff || {}).slice(0, 3).map(([k, v]) => `${k}:${str(v.from) || '空'}→${str(v.to) || '空'}`).join(',');
    return `${t}「${c.label}」更新(${d}${Object.keys(c.diff || {}).length > 3 ? '…' : ''})`;
  }
  return `${t}${c.label ? `「${c.label}」` : ''}${CH_LABEL[c.type] || c.type}`;
}

module.exports = { summarize, describe, CH_LABEL };
