'use strict';
/* AI Company OS 部门工作台服务
   - 只提供一个页面:/ 与 /department-workbench.html;其余路径一律 404
   - /api/base/*:飞书多维表格只读数据接口(仅 GET;不返回任何凭据、令牌或环境变量)
   - 监听 127.0.0.1:8765,UUMit 等隧道把公网流量转发到这里 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadEnv } = require('../../lib/env.cjs');
loadEnv(path.join(__dirname, '..', '..', '.env'));
const { BaseSync } = require('../../sync/worker.cjs');

const host = '127.0.0.1';
const port = Number(process.env.PORT) || 8765;
const pageFile = path.join(__dirname, 'department-workbench.html');
const dataDir = path.join(__dirname, '..', '..', 'data');
const PAGE_PATHS = new Set(['/', '/department-workbench.html']);
const MAX_SSE = 60;

/* ---------- 飞书多维表格同步(只读,不向飞书写入任何内容) ---------- */
const sync = new BaseSync({ dataDir });
const haveCreds = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_BASE_TOKEN);
if (haveCreds) sync.start().catch((e) => console.error('[sync] 启动失败:', e.message));
else console.warn('[sync] 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN(见 .env.example),/api/base/* 将返回上次快照或 503。');

/* 「在飞书中打开」链接:域名可用 FEISHU_BASE_DOMAIN(仅主机名)配置;校验后才使用 */
const rawDom = String(process.env.FEISHU_BASE_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '').toLowerCase();
const FEISHU_HOST = /^[a-z0-9.-]+$/.test(rawDom) && rawDom ? rawDom : 'ecn4q25afp0k.feishu.cn';
const tableUrl = (snap, t) => `https://${FEISHU_HOST}/base/${encodeURIComponent(snap.base_token)}?table=${encodeURIComponent(t.table_id)}${t.view_id ? '&view=' + encodeURIComponent(t.view_id) : ''}`;

const sseClients = new Set();
const sseSend = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
sync.on('sync', ({ snapshot_at, changes }) => {
  const real = changes.filter((c) => c.type !== 'initial_sync');
  for (const res of sseClients) sseSend(res, 'sync', { synced_at: snapshot_at, seq: sync.seq, changed: real.length });
});
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 15000).unref();

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' };
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(body));
};

/* 对外状态:只给页面需要的几项,不含错误详情/应用令牌等内部信息 */
function publicStatus() {
  const s = sync.status();
  const ev = s.events || {};
  return {
    ok: !s.last_error,
    syncing: !!s.syncing,
    last_sync_at: s.last_sync_at || (sync.getSnapshot() && sync.getSnapshot().synced_at) || null,
    last_sync_reason: s.last_sync_reason,
    seq: s.seq,
    tables: s.tables,
    mode: ev.ws === 'connected' && ev.subscribe === 'ok' ? 'push' : 'poll',
    events_received: ev.received || 0,
    last_event_at: ev.last_event_at || null,
  };
}

/* 本机直接访问(没有反向代理/隧道头)才允许手动触发重新同步 */
function isLocalDirect(request) {
  const hostHeader = (request.headers.host || '').replace(/:\d+$/, '');
  const proxied = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'via'].some((h) => request.headers[h]);
  const addr = request.socket.remoteAddress || '';
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader) && !proxied && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

function handleApi(request, response, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (p === '/api/base/refresh') { // 仅本机:立即重新读取飞书(只读)
    if (method !== 'POST') return json(response, 405, { error: 'use POST' });
    if (!isLocalDirect(request)) return json(response, 403, { error: '仅限本机触发' });
    sync.syncAll('manual').then(() => json(response, 200, { ok: true, status: publicStatus() })).catch(() => json(response, 502, { ok: false }));
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') return json(response, 405, { error: '只读接口,仅支持 GET' });

  if (p === '/api/base/status') return json(response, 200, publicStatus());

  if (p === '/api/base/stream') {
    if (sseClients.size >= MAX_SSE) return json(response, 503, { error: '连接数已满,请使用轮询' });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY });
    response.write('retry: 5000\n');
    sseSend(response, 'hello', { status: publicStatus() });
    sseClients.add(response);
    request.on('close', () => sseClients.delete(response));
    return;
  }

  const snap = sync.getSnapshot();
  if (!snap) return json(response, 503, { error: '尚未完成首次同步', status: publicStatus() });

  if (p === '/api/base/data') { // 页面一次拿全部表:{表名: {count, records}}
    const tables = {};
    for (const t of Object.values(snap.tables)) tables[t.name] = { table_id: t.table_id, view_id: t.view_id || null, view_name: t.view_name || null, url: tableUrl(snap, t), count: t.count, fields: (t.fields || []).map((f) => ({ name: f.name, type: f.type, ui_type: f.ui_type })), records: Object.entries(t.records).map(([record_id, fields]) => ({ record_id, ...fields })) };
    return json(response, 200, { synced_at: snap.synced_at, seq: sync.seq, status: publicStatus(), tables });
  }
  if (p === '/api/base/changes') {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const items = sync.getChanges({ since: url.searchParams.get('since'), limit }).map(({ seq, ts, type, table, table_id, record_id, label, fields, diff, counts }) => ({ seq, ts, type, table, table_id, record_id, label, fields, diff, counts }));
    return json(response, 200, { seq: sync.seq, changes: items });
  }
  return json(response, 404, { error: 'unknown endpoint', endpoints: ['/api/base/status', '/api/base/data', '/api/base/changes', '/api/base/stream'] });
}

const server = http.createServer((request, response) => {
  let url;
  try { url = new URL(request.url, `http://${host}:${port}`); } catch { response.writeHead(400); return response.end('Bad request'); }

  if (url.pathname.startsWith('/api/base/')) {
    try { return handleApi(request, response, url); } catch (e) { return json(response, 500, { error: 'internal error' }); }
  }

  if (!PAGE_PATHS.has(url.pathname)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY });
    response.end('Not found');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY });
    response.end();
    return;
  }
  fs.readFile(pageFile, (error, content) => {
    if (error) { response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Unable to read page'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
});

server.listen(port, host, () => {
  console.log(`AI Company OS 部门工作台: http://${host}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { sync.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
