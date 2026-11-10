'use strict';
/* 飞书多维表格 → 本地快照同步。
   - 全量同步 → data/snapshot.json;与上一份快照对比 → data/changes.jsonl(追加)
   - 实时:订阅 drive.file.bitable_record_changed_v1(长连接 WSClient,无需公网 IP)
   - 兜底:每 60 秒轮询一次(始终开启)
   只读:不写多维表格,不发任何消息。 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const feishu = require('../lib/feishu.cjs');
const { buildOptionMap, normalizeRecord, slimField } = require('../lib/normalize.cjs');
const { loadEnv } = require('../lib/env.cjs');

const ID_FIELDS = ['工单号', '领料单号', '发货单号', '生产记录编号', '产品编码', '编码', '型号', '名称'];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function recordLabel(rec) {
  for (const k of ID_FIELDS) { const v = rec.fields[k]; if (v !== null && v !== undefined && v !== '') return Array.isArray(v) ? v.join('/') : String(v); }
  for (const v of Object.values(rec.fields)) if (typeof v === 'string' && v) return v;
  return rec.record_id;
}

class BaseSync extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.appToken = opts.appToken || process.env.FEISHU_BASE_TOKEN;
    this.dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
    this.pollMs = opts.pollMs || Number(process.env.FEISHU_POLL_MS) || 60000;
    this.debounceMs = opts.debounceMs || 1500;
    this.log = opts.log || ((...a) => console.log(new Date().toISOString(), '[sync]', ...a));
    this.snapshot = null;
    this.seq = 0;
    this.queue = Promise.resolve();
    this.pending = new Map(); // table_id → timer
    this.status_ = { started_at: null, last_sync_at: null, last_sync_reason: null, last_error: null, syncing: false, polls: 0,
      events: { subscribe: 'pending', subscribe_error: null, ws: 'off', ws_error: null, received: 0, last_event_at: null } };
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.snapFile = path.join(this.dataDir, 'snapshot.json');
    this.changesFile = path.join(this.dataDir, 'changes.jsonl');
    this._load();
  }

  _load() {
    try { this.snapshot = JSON.parse(fs.readFileSync(this.snapFile, 'utf8')); } catch { this.snapshot = null; }
    try {
      const lines = fs.readFileSync(this.changesFile, 'utf8').split('\n').filter(Boolean);
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      this.seq = last ? last.seq : 0;
    } catch { this.seq = 0; }
  }

  status() { return { ...this.status_, app_token_set: !!this.appToken, tables: this.snapshot ? Object.keys(this.snapshot.tables).length : 0, seq: this.seq }; }
  getSnapshot() { return this.snapshot; }

  /* ---------- 对外:读变更 ---------- */
  getChanges({ since, limit = 200 } = {}) {
    let lines;
    try { lines = fs.readFileSync(this.changesFile, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    let items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (since !== undefined && since !== null && since !== '') {
      if (/^\d+$/.test(String(since))) items = items.filter((c) => c.seq > Number(since));
      else { const t = Date.parse(since); if (!Number.isNaN(t)) items = items.filter((c) => Date.parse(c.ts) > t); }
    }
    return items.slice(-limit);
  }

  /* ---------- 同步(串行化) ---------- */
  _enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  syncAll(reason = 'manual') { return this._enqueue(() => this._syncAll(reason)); }
  syncTable(tableId, reason = 'event') { return this._enqueue(() => this._syncTable(tableId, reason)); }

  async _fetchTable(t, optionsHint) {
    const [fields, records] = await Promise.all([feishu.listFields(this.appToken, t.table_id), feishu.listRecords(this.appToken, t.table_id)]);
    return { t, fields, records };
  }

  _buildTable(fetched, options, syncedAt) {
    const { t, fields, records } = fetched;
    const ctx = { options };
    const recs = {};
    for (const r of records) { const n = normalizeRecord(r, fields, ctx); recs[n.record_id] = n.fields; }
    return {
      table_id: t.table_id, name: t.name, synced_at: syncedAt,
      fields: fields.filter((f) => !/^父记录( \d+)?$/.test(f.field_name)).map(slimField),
      count: records.length, records: recs,
    };
  }

  async _syncAll(reason) {
    this.status_.syncing = true;
    const startedAt = Date.now();
    try {
      const tables = await feishu.listTables(this.appToken);
      const fetched = [];
      // 并发 3 张表一批,兼顾速度与频控(429 会自动退避重试)
      for (let i = 0; i < tables.length; i += 3) fetched.push(...await Promise.all(tables.slice(i, i + 3).map((t) => this._fetchTable(t))));
      const fieldsByTable = Object.fromEntries(fetched.map((f) => [f.t.table_id, f.fields]));
      const options = buildOptionMap(fieldsByTable);
      const now = new Date().toISOString();
      const next = { base_token: this.appToken, synced_at: now, options, tables: {} };
      for (const f of fetched) next.tables[f.t.table_id] = this._buildTable(f, options, now);
      const changes = this._diff(this.snapshot, next, reason);
      this._commit(next, changes);
      this.status_.last_error = null;
      this.status_.last_sync_at = now; this.status_.last_sync_reason = reason;
      if (changes.length) this.log(`同步完成(${reason}) ${Date.now() - startedAt}ms,变更 ${changes.length} 条`);
      return { changes };
    } catch (e) {
      this.status_.last_error = e.message;
      this.log('同步失败:', e.message);
      this.emit('error_sync', e);
      throw e;
    } finally { this.status_.syncing = false; }
  }

  async _syncTable(tableId, reason) {
    if (!this.snapshot) return this._syncAll(reason);
    this.status_.syncing = true;
    try {
      const tables = await feishu.listTables(this.appToken);
      const t = tables.find((x) => x.table_id === tableId);
      if (!t) return this._syncAll(reason); // 表被删/新建 → 全量
      const f = await this._fetchTable(t);
      const options = { ...(this.snapshot.options || {}), ...buildOptionMap({ [tableId]: f.fields }) };
      const now = new Date().toISOString();
      const next = JSON.parse(JSON.stringify(this.snapshot));
      next.options = options; next.synced_at = now;
      next.tables[tableId] = this._buildTable(f, options, now);
      const changes = this._diff(this.snapshot, next, reason, tableId);
      this._commit(next, changes);
      this.status_.last_error = null;
      this.status_.last_sync_at = now; this.status_.last_sync_reason = reason;
      if (changes.length) this.log(`表「${t.name}」同步完成(${reason}),变更 ${changes.length} 条`);
      return { changes };
    } catch (e) {
      this.status_.last_error = e.message; this.log('同步失败:', e.message); throw e;
    } finally { this.status_.syncing = false; }
  }

  /* ---------- 对比 ---------- */
  _diff(prev, next, reason, onlyTable) {
    const ts = new Date().toISOString();
    const out = [];
    const push = (c) => out.push({ seq: ++this.seq, ts, reason, ...c });
    if (!prev) {
      push({ type: 'initial_sync', counts: Object.fromEntries(Object.values(next.tables).map((t) => [t.name, t.count])) });
      return out;
    }
    const ids = onlyTable ? [onlyTable] : [...new Set([...Object.keys(prev.tables), ...Object.keys(next.tables)])];
    for (const tid of ids) {
      const a = prev.tables[tid], b = next.tables[tid];
      if (!a && b) { push({ type: 'table_added', table_id: tid, table: b.name, count: b.count }); continue; }
      if (a && !b) { push({ type: 'table_removed', table_id: tid, table: a.name }); continue; }
      for (const [rid, fields] of Object.entries(b.records)) {
        const old = a.records[rid];
        if (!old) { push({ type: 'added', table_id: tid, table: b.name, record_id: rid, label: recordLabel({ record_id: rid, fields }), fields: Object.keys(fields).filter((k) => fields[k] !== null) }); continue; }
        const changed = [...new Set([...Object.keys(fields), ...Object.keys(old)])].filter((k) => !eq(fields[k], old[k]));
        if (changed.length) push({ type: 'updated', table_id: tid, table: b.name, record_id: rid, label: recordLabel({ record_id: rid, fields }), fields: changed, diff: Object.fromEntries(changed.map((k) => [k, { from: old[k] ?? null, to: fields[k] ?? null }])) });
      }
      for (const [rid, fields] of Object.entries(a.records)) {
        if (!b.records[rid]) push({ type: 'removed', table_id: tid, table: a.name, record_id: rid, label: recordLabel({ record_id: rid, fields }), fields: [] });
      }
    }
    return out;
  }

  _commit(next, changes) {
    const tmp = this.snapFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
    fs.renameSync(tmp, this.snapFile);
    if (changes.length) fs.appendFileSync(this.changesFile, changes.map((c) => JSON.stringify(c)).join('\n') + '\n');
    this.snapshot = next;
    this.emit('sync', { snapshot_at: next.synced_at, changes });
  }

  /* ---------- 事件订阅 ---------- */
  _scheduleTable(tableId, reason) {
    const key = tableId || '*';
    clearTimeout(this.pending.get(key));
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      (tableId ? this.syncTable(tableId, reason) : this.syncAll(reason)).catch(() => {});
    }, this.debounceMs));
  }

  async startEvents() {
    const ev = this.status_.events;
    // 1) 订阅该多维表格的文档事件(需要应用身份权限 docs:event:subscribe,或 drive:drive / docs:doc / sheets:spreadsheet 任一)
    try {
      await feishu.subscribeBitable(this.appToken);
      ev.subscribe = 'ok'; ev.subscribe_error = null;
      this.log('已订阅多维表格记录变更事件(drive subscribe 成功)');
    } catch (e) {
      ev.subscribe = 'failed'; ev.subscribe_error = { code: e.code, message: String(e.message).split('\n')[0].replace(/https?:\/\/\S+/g, '<url>').slice(0, 400) };
      if (e.code === 99991672) {
        this.log('⚠ 事件订阅失败:应用缺少权限。请在开发者后台「权限管理」开通 docs:event:subscribe(或 drive:drive / docs:doc / sheets:spreadsheet 任一),并发布新版本;在此之前仅使用 60 秒轮询。');
      } else this.log(`⚠ 事件订阅失败(code ${e.code}):${e.message};保持 60 秒轮询。`);
    }
    // 2) 长连接接收事件(即使订阅暂时失败也建立连接,权限开通后重启服务即可)
    let Lark;
    try { Lark = require('@larksuiteoapi/node-sdk'); } catch {
      ev.ws = 'unavailable'; ev.ws_error = '未安装 @larksuiteoapi/node-sdk(npm install)';
      this.log('⚠ 未安装 @larksuiteoapi/node-sdk,长连接不可用,仅 60 秒轮询。运行 npm install 即可。');
      return;
    }
    try {
      const onEvent = (data) => {
        ev.received++; ev.last_event_at = new Date().toISOString();
        this.log('收到飞书事件', data && data.event_type || '', data && data.table_id || '');
        this._scheduleTable(data && data.table_id, 'event');
      };
      const dispatcher = new Lark.EventDispatcher({}).register({
        'drive.file.bitable_record_changed_v1': onEvent,
        'drive.file.bitable_field_changed_v1': onEvent,
      });
      ev.ws = 'connecting';
      this.ws = new Lark.WSClient({
        appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET,
        loggerLevel: Lark.LoggerLevel.warn, autoReconnect: true,
        onReady: () => { ev.ws = 'connected'; ev.ws_error = null; this.log('长连接已建立(WSClient)'); },
        onError: (err) => { ev.ws = 'failed'; ev.ws_error = String(err && err.message || err).slice(0, 300); this.log('⚠ 长连接失败:', ev.ws_error, '—请确认开发者后台「事件与回调」→ 订阅方式已选「使用长连接接收事件」'); },
        onReconnecting: () => { ev.ws = 'reconnecting'; },
        onReconnected: () => { ev.ws = 'connected'; },
      });
      await this.ws.start({ eventDispatcher: dispatcher });
    } catch (e) {
      ev.ws = 'failed'; ev.ws_error = String(e.message).slice(0, 300);
      this.log('⚠ 长连接启动失败:', e.message);
    }
  }

  /* ---------- 生命周期 ---------- */
  async start({ events = true } = {}) {
    if (!this.appToken) throw new Error('未配置 FEISHU_BASE_TOKEN');
    this.status_.started_at = new Date().toISOString();
    try { await this.syncAll('startup'); } catch { /* 已记录,轮询会重试 */ }
    this.timer = setInterval(() => { this.status_.polls++; this.syncAll('poll').catch(() => {}); }, this.pollMs);
    this.timer.unref && this.timer.unref();
    if (events) this.startEvents().catch((e) => this.log('事件启动异常:', e.message));
    return this;
  }

  stop() {
    clearInterval(this.timer);
    for (const t of this.pending.values()) clearTimeout(t);
    try { this.ws && this.ws.close && this.ws.close({ force: true }); } catch { /* ignore */ }
  }
}

module.exports = { BaseSync, recordLabel };

/* CLI:node sync/worker.cjs --once  只做一次全量同步 */
if (require.main === module) {
  loadEnv();
  const w = new BaseSync();
  if (process.argv.includes('--once')) {
    w.syncAll('cli').then(() => { const s = w.getSnapshot(); for (const t of Object.values(s.tables)) console.log(`${t.name}\t${t.count}`); process.exit(0); }).catch((e) => { console.error(e.message); process.exit(1); });
  } else w.start();
}
