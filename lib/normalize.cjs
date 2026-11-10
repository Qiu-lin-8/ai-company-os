'use strict';
/* 把多维表格原始记录变成「干净」的普通值:
   - 单选/多选的选项 id(optXXXX)→ 选项名(含「查找引用」字段里夹带的 id,靠全局选项表解析)
   - 文本数组 [{text}] → 字符串
   - 双向/单向关联 → 文本列表(text_arr)
   - 数字字段里的数字字符串 → number
   - 毫秒时间戳 → Asia/Shanghai ISO 字符串 */

const TZ = 'Asia/Shanghai';
const OPT_ID = /^opt[0-9A-Za-z]{6,16}$/;

// 多维表格 field type
const T = { TEXT: 1, NUMBER: 2, SELECT: 3, MULTI: 4, DATE: 5, CHECKBOX: 7, USER: 11, PHONE: 13, URL: 15, ATTACH: 17,
  LINK: 18, FORMULA: 20, DUPLINK: 21, LOCATION: 22, GROUP: 23, CREATED_TIME: 1001, MODIFIED_TIME: 1002,
  CREATED_BY: 1003, MODIFIED_BY: 1004, AUTONUM: 1005, LOOKUP: 19, CURRENCY: 99001 };

const shFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/* ms → "2026-11-02T00:00:00+08:00"(上海固定 UTC+8,无夏令时) */
function toShanghaiISO(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Object.fromEntries(shFmt.formatToParts(new Date(n)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

/* 从全部表的字段定义建「选项 id → 名称」全局表 */
function buildOptionMap(fieldsByTable) {
  const map = {};
  for (const fields of Object.values(fieldsByTable)) {
    for (const f of fields || []) {
      const opts = f.property && f.property.options;
      if (Array.isArray(opts)) for (const o of opts) if (o && o.id && o.name) map[o.id] = o.name;
    }
  }
  return map;
}

const isNumericStr = (s) => typeof s === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(s);

/* 递归拍平为标量/标量数组 */
function flat(v, ctx) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => flat(x, ctx));
  if (typeof v === 'string') return [OPT_ID.test(v) && ctx.options[v] ? ctx.options[v] : v];
  if (typeof v === 'number' || typeof v === 'boolean') return [v];
  if (typeof v === 'object') {
    if (Array.isArray(v.text_arr)) return v.text_arr.flatMap((x) => flat(x, ctx));   // 关联
    if (v.link !== undefined) return [v.text || v.link];                              // 超链接
    if (v.name !== undefined && (v.id !== undefined || v.en_name !== undefined)) return [v.name]; // 人员
    if (v.file_token !== undefined) return [v.name || v.file_token];                  // 附件
    if (v.full_address !== undefined) return [v.full_address];                        // 地理位置
    if (v.value !== undefined) return flat(v.value, ctx);                             // 公式/查找引用包装
    if (v.text !== undefined) return [String(v.text)];                                // 文本片段
    if (v.record_ids !== undefined) return [];
    return [];
  }
  return [];
}

function joinText(arr) { return arr.map(String).join(''); }
function collapse(arr) { return arr.length === 0 ? null : arr.length === 1 ? arr[0] : arr; }

function normalizeValue(raw, field, ctx) {
  const type = field && field.type;
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case T.TEXT: {
      if (typeof raw === 'string') return raw === '' ? null : raw;
      const s = joinText(flat(raw, ctx));
      return s === '' ? null : s;
    }
    case T.AUTONUM: return raw === '' ? null : raw;
    case T.NUMBER: case T.CURRENCY: {
      const x = Array.isArray(raw) ? raw[0] : raw;
      if (typeof x === 'number') return x;
      if (isNumericStr(x)) return Number(x);
      return x === '' ? null : x;
    }
    case T.SELECT: {
      const a = flat(raw, ctx); return a.length ? a[0] : null;
    }
    case T.MULTI: return flat(raw, ctx);
    case T.DATE: case T.CREATED_TIME: case T.MODIFIED_TIME: {
      const x = Array.isArray(raw) ? raw[0] : raw;
      return toShanghaiISO(x) || (x === '' ? null : x);
    }
    case T.CHECKBOX: return !!raw;
    case T.LINK: case T.DUPLINK: return flat(raw, ctx);
    case T.USER: case T.CREATED_BY: case T.MODIFIED_BY: case T.ATTACH: case T.GROUP: return flat(raw, ctx);
    case T.URL: case T.PHONE: case T.LOCATION: return collapse(flat(raw, ctx));
    case T.FORMULA: case T.LOOKUP: default: {
      // 公式/查找引用:结果类型不定。拍平;纯数字字符串转数字;ms 时间戳不猜测(由字段 ui_type 决定)
      const a = flat(raw, ctx).map((x) => (isNumericStr(x) ? Number(x) : x));
      return collapse(a);
    }
  }
}

/* 返回 { field_id, name, type, ui_type } 的精简字段描述 */
const slimField = (f) => ({ field_id: f.field_id, name: f.field_name, type: f.type, ui_type: f.ui_type || null, is_primary: !!f.is_primary });

/* 自引用的「父记录」类系统关联列(无业务含义)不输出 */
const HIDDEN = /^父记录( \d+)?$/;

function normalizeRecord(rec, fields, ctx) {
  const byName = new Map(fields.map((f) => [f.field_name, f]));
  const out = {};
  const keys = [...byName.keys()]; // 保持表里的列顺序
  for (const k of keys) {
    if (HIDDEN.test(k)) continue;
    const f = byName.get(k);
    const key = k.trim();
    out[key] = normalizeValue(rec.fields ? rec.fields[k] : undefined, f, ctx);
  }
  return { record_id: rec.record_id || rec.id, fields: out };
}

module.exports = { T, TZ, toShanghaiISO, buildOptionMap, normalizeValue, normalizeRecord, slimField };
