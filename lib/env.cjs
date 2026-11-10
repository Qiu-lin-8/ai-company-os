'use strict';
/* 极简 .env 读取(不依赖 dotenv)。已存在的进程环境变量优先,不覆盖。 */
const fs = require('node:fs');
const path = require('node:path');

function loadEnv(file) {
  const f = file || path.join(__dirname, '..', '.env');
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return false; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
  }
  return true;
}
module.exports = { loadEnv };
