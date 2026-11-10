'use strict';
/* 飞书开放平台最小客户端:tenant_access_token 缓存、分页、限流重试。
   凭证只从 process.env 读取,绝不打印、绝不落盘。 */

const DOMAIN = () => (process.env.FEISHU_DOMAIN || 'https://open.feishu.cn').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FeishuError extends Error {
  constructor(msg, extra) { super(msg); this.name = 'FeishuError'; Object.assign(this, extra || {}); }
}

let tokenCache = null; // { value, exp }
let tokenInflight = null;

async function fetchToken() {
  const id = process.env.FEISHU_APP_ID, secret = process.env.FEISHU_APP_SECRET;
  if (!id || !secret) throw new FeishuError('未配置 FEISHU_APP_ID / FEISHU_APP_SECRET', { code: 'NO_CREDENTIALS' });
  const r = await fetch(DOMAIN() + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0) throw new FeishuError('获取 tenant_access_token 失败: ' + (j.msg || r.status), { code: j.code });
  // 提前 5 分钟刷新(expire 单位:秒)
  tokenCache = { value: j.tenant_access_token, exp: Date.now() + Math.max(60, (j.expire || 7200) - 300) * 1000 };
  return tokenCache.value;
}

async function getToken(force) {
  if (!force && tokenCache && tokenCache.exp > Date.now()) return tokenCache.value;
  if (!tokenInflight) tokenInflight = fetchToken().finally(() => { tokenInflight = null; });
  return tokenInflight;
}

/* 调用开放平台接口。成功返回 data;失败抛 FeishuError(含 code/msg/status)。
   - 99991663/99991664/99991661(token 失效)→ 刷新后重试
   - HTTP 429 / 99991400(频率限制)/ 1254290 / 1254291(多维表格并发冲突)→ 指数退避重试 */
async function api(method, path, { query, body, retries = 5 } = {}) {
  let url = DOMAIN() + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.append(k, v);
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = await getToken(attempt > 0 && lastErr && lastErr.tokenExpired);
    let r, j;
    try {
      r = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      j = await r.json().catch(() => ({ code: -1, msg: 'HTTP ' + r.status }));
    } catch (e) { // 网络错误
      lastErr = new FeishuError('网络错误: ' + e.message, { code: 'NETWORK' });
      if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
      throw lastErr;
    }
    if (j.code === 0) return j.data || {};
    const err = new FeishuError(`飞书接口错误 ${method} ${path.replace(/\/open-apis/, '')}: ${j.msg || j.code} (code ${j.code})`, { code: j.code, status: r.status, msg: j.msg });
    const tokenBad = [99991663, 99991664, 99991661].includes(j.code);
    const limited = r.status === 429 || [99991400, 1254290, 1254291, 1254607].includes(j.code);
    if ((tokenBad || limited || r.status >= 500) && attempt < retries) {
      err.tokenExpired = tokenBad; lastErr = err;
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 200);
      continue;
    }
    throw err;
  }
  throw lastErr;
}

/* 分页:自动跟随 has_more / page_token,返回 items 数组 */
async function listAll(path, { query = {}, pageSize = 500, maxPages = 1000 } = {}) {
  const out = []; let pt = '';
  for (let i = 0; i < maxPages; i++) {
    const d = await api('GET', path, { query: { ...query, page_size: pageSize, page_token: pt || undefined } });
    out.push(...(d.items || []));
    if (!d.has_more || !d.page_token) break;
    pt = d.page_token;
  }
  return out;
}

const B = (appToken) => `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}`;

const listTables = (appToken) => listAll(`${B(appToken)}/tables`, { pageSize: 100 });
const listFields = (appToken, tableId) => listAll(`${B(appToken)}/tables/${tableId}/fields`, { pageSize: 100 });
/* automatic_fields: 同时返回创建人/创建时间等系统字段(不会写入) */
const listRecords = (appToken, tableId) =>
  listAll(`${B(appToken)}/tables/${tableId}/records`, { pageSize: 500, query: { text_field_as_array: 'true' } });
async function getApp(appToken) { return (await api('GET', B(appToken))).app || {}; }

/* 事件订阅:让该多维表格的记录变更推送给本应用(drive.file.bitable_record_changed_v1) */
const subscribeBitable = (fileToken) =>
  api('POST', `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/subscribe`, { query: { file_type: 'bitable' } });
const getSubscribeStatus = (fileToken) =>
  api('GET', `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/get_subscribe`, { query: { file_type: 'bitable' } });

module.exports = { FeishuError, getToken, api, listAll, listTables, listFields, listRecords, getApp, subscribeBitable, getSubscribeStatus };
