// 找出 schema 里定义、但代码中从未出现过的字段名（大概率是历史遗留）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = 'D:/复刻商城';
const schema = readFileSync(join(ROOT, 'server/src/schema.sql'), 'utf8');

// 收集服务端 + 前端代码全文
const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '_probe', '_npmcache'].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (['.js', '.mjs', '.vue'].includes(extname(p))) files.push(p);
  }
})(ROOT);
const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');

// 解析每张表的字段
const tables = [];
const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
let m;
while ((m = re.exec(schema))) {
  const [, table, body] = m;
  const cols = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('--')) continue;
    const c = t.match(/^`?(\w+)`?\s+(INTEGER|TEXT|REAL|NUMERIC|BLOB)/i);
    if (c) cols.push(c[1]);
  }
  tables.push({ table, cols });
}

console.log('=== 定义在 schema 但代码里从未出现过的字段 ===');
let found = 0;
for (const { table, cols } of tables) {
  const dead = cols.filter((c) => !new RegExp(`\\b${c}\\b`).test(code));
  if (dead.length) {
    found += dead.length;
    console.log(`  ${table}: ${dead.join(', ')}`);
  }
}
if (!found) console.log('  无');
console.log(`\n表数 ${tables.length}，字段总数 ${tables.reduce((s, t) => s + t.cols.length, 0)}`);
