const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// 读取项目根目录的 .env(FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN),不依赖 dotenv
const { loadEnv } = require('../../lib/env.cjs');
loadEnv(path.join(__dirname, '..', '..', '.env'));
const { BaseSync } = require('../../sync/worker.cjs');
const { summarize } = require('../../lib/summary.cjs');

const host = '127.0.0.1';
const port = Number(process.env.PORT) || 8765;
const root = __dirname;
const dataDir = path.join(__dirname, '..', '..', 'data');

const routes = new Map([
  ['/', 'department-workbench.html'],
  ['/department-workbench.html', 'department-workbench.html'],
  ['/workflow-demo.html', 'workflow-demo.html'],
  ['/index.html', 'index.html'],
  ['/base-live.html', 'base-live.html'],
]);

/* ---------- 飞书多维表格同步(只读)---------- */
const sync = new BaseSync({ dataDir });
const haveCreds = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_BASE_TOKEN);
if (haveCreds) sync.start().catch((e) => console.error('[sync] 启动失败:', e.message));
else console.warn('[sync] 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_TOKEN(见 .env.example),/api/base/* 将返回上次快照或 503。');

const sseClients = new Set();
sync.on('sync', ({ snapshot_at, changes }) => {
  const real = changes.filter((c) => c.type !== 'initial_sync');
  const msg = `event: sync\ndata: ${JSON.stringify({ synced_at: snapshot_at, changes: real, initial: changes.some((c) => c.type === 'initial_sync') })}\n\n`;
  for (const res of sseClients) res.write(msg);
});
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
};

function tableByKey(snap, key) {
  const k = decodeURIComponent(key);
  return Object.values(snap.tables).find((t) => t.table_id === k || t.name === k);
}

function handleApi(request, response, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const snap = sync.getSnapshot();
  const status = sync.status();

  if (p === '/api/base/status') return json(response, 200, status);

  if (p === '/api/base/stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ synced_at: snap && snap.synced_at, status })}\n\n`);
    sseClients.add(response);
    request.on('close', () => sseClients.delete(response));
    return;
  }

  if (p === '/api/base/refresh') { // 立即重新读取(只读),用于页面「立即刷新」
    if (request.method !== 'POST') return json(response, 405, { error: 'use POST' });
    sync.syncAll('manual').then((r) => json(response, 200, { ok: true, changes: r.changes.filter((c) => c.type !== 'initial_sync').length, synced_at: sync.getSnapshot().synced_at }))
      .catch((e) => json(response, 502, { ok: false, error: e.message }));
    return;
  }

  if (request.method !== 'GET') return json(response, 405, { error: '只读接口,仅支持 GET' });
  if (!snap) return json(response, 503, { error: '尚未完成首次同步', status });

  if (p === '/api/base/tables') {
    return json(response, 200, { synced_at: snap.synced_at, status, tables: Object.values(snap.tables).map((t) => ({ table_id: t.table_id, name: t.name, count: t.count, synced_at: t.synced_at, fields: t.fields.map((f) => f.name) })) });
  }
  let m = p.match(/^\/api\/base\/tables\/([^/]+)$/);
  if (m) {
    const t = tableByKey(snap, m[1]);
    if (!t) return json(response, 404, { error: '没有这张表', tables: Object.values(snap.tables).map((x) => x.name) });
    return json(response, 200, { table_id: t.table_id, name: t.name, count: t.count, synced_at: t.synced_at, fields: t.fields, records: Object.entries(t.records).map(([record_id, fields]) => ({ record_id, fields })) });
  }
  if (p === '/api/base/changes') {
    const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 200);
    return json(response, 200, { seq: sync.seq, changes: sync.getChanges({ since: url.searchParams.get('since'), limit }) });
  }
  if (p === '/api/base/summary') return json(response, 200, summarize(snap, sync.getChanges({ limit: 50 })));
  return json(response, 404, { error: 'unknown endpoint', endpoints: ['/api/base/status', '/api/base/tables', '/api/base/tables/:name', '/api/base/changes?since=', '/api/base/summary', '/api/base/stream (SSE)', 'POST /api/base/refresh'] });
}

const server = http.createServer((request, response) => {
  const url0 = (request.url || '/').split('?')[0];
  // 真实业务数据(/api/base/*、/base-live.html)只允许本机直接访问:
  // Host 必须是本机,且不能带反向代理/隧道头(项目可能经 UUMit 等隧道公开演示页,真实数据不能随之公开)
  if (url0.startsWith('/api/base/') || url0 === '/base-live.html') {
    const hostHeader = (request.headers.host || '').replace(/:\d+$/, '');
    const proxied = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'].some((h) => request.headers[h]);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader) || proxied) { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Forbidden: 飞书实时数据仅限本机访问'); return; }
  }
  const url = new URL(request.url, `http://${host}:${port}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/base/')) {
    try { return handleApi(request, response, url); } catch (e) { return json(response, 500, { error: e.message }); }
  }

  const fileName = routes.get(pathname);

  if (!fileName) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const filePath = path.join(root, fileName);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to read page');
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`AI Company OS demo: http://${host}:${port}`);
  console.log(`飞书多维表格实时页: http://${host}:${port}/base-live.html`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { sync.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
