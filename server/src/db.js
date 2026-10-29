import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

// 支持通过 MALL_DB 指定独立数据库（测试用），避免污染演示库
const DB_FILE = process.env.MALL_DB
  ? (isAbsolute(process.env.MALL_DB) ? process.env.MALL_DB : join(DATA_DIR, process.env.MALL_DB))
  : join(DATA_DIR, 'mall.db');

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// 并发写入时排队等待，避免直接抛 SQLITE_BUSY
db.exec('PRAGMA busy_timeout = 5000');

/** 简易嵌套事务支持（SAVEPOINT），避免事务内再开事务报错 */
let txDepth = 0;
export function tx(fn) {
  const name = `sp_${txDepth}`;
  if (txDepth === 0) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${name}`);
  txDepth++;
  try {
    const r = fn();
    txDepth--;
    if (txDepth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE ${name}`);
    return r;
  } catch (e) {
    txDepth--;
    if (txDepth === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO ${name}`);
    throw e;
  }
}

/**
 * SQL 参数数量校验。
 * node:sqlite 在占位符多于参数时不会报错，而是静默绑定 NULL ——
 * 这类 bug 会让 UPDATE 匹配 0 行却「执行成功」，极难发现。
 * 这里在开发/测试环境强制校验（生产可用 SQL_GUARD=0 关闭）。
 */
function guard(sql, params) {
  if (process.env.SQL_GUARD === '0') return;
  const need = (sql.match(/\?/g) || []).length;
  if (need !== params.length) {
    throw new Error(
      `[SQL 参数不匹配] 占位符 ${need} 个，实际传入 ${params.length} 个\n  ${sql.replace(/\s+/g, ' ').trim().slice(0, 200)}`,
    );
  }
}

export const all = (sql, ...p) => {
  guard(sql, p);
  return db.prepare(sql).all(...p);
};
export const get = (sql, ...p) => {
  guard(sql, p);
  return db.prepare(sql).get(...p);
};
export const run = (sql, ...p) => {
  guard(sql, p);
  return db.prepare(sql).run(...p);
};
export const scalar = (sql, ...p) => {
  const row = get(sql, ...p);
  if (!row) return null;
  return Object.values(row)[0];
};

export const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const today = () => now().slice(0, 10);
