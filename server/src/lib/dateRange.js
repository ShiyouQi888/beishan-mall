// 快捷时间范围 → [起, 止] 的 YYYY-MM-DD
//
// 一律按北京日期算（todayStr / addDays 已经固定 UTC+8），不受服务器时区影响。
// 转拍订单、全部订单、订单导出共用这一份，避免三处各写一套口径走偏。
import { todayStr, addDays } from './sessionWindow.js';

/**
 * @param {string} range all / today / yesterday / week / month / custom
 * @param {string} start custom 起始日 YYYY-MM-DD
 * @param {string} end   custom 结束日 YYYY-MM-DD
 * @returns {{start: string, end: string} | null}
 *   all/不传 → {start:'', end:''}（不限时间）；custom 日期非法 → null（调用方应报错，别静默当成不限）
 */
export function resolveRange(range, start, end) {
  const today = todayStr();
  if (range === 'all' || !range) return { start: '', end: '' };
  if (range === 'yesterday') {
    const d = addDays(today, -1);
    return { start: d, end: d };
  }
  if (range === 'week') {
    // 本周一 → 今天。getUTCDay 读的是纯日历值，不受服务器时区影响
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = 周日
    return { start: addDays(today, -(dow === 0 ? 6 : dow - 1)), end: today };
  }
  if (range === 'month') return { start: `${today.slice(0, 7)}-01`, end: today };
  if (range === 'custom') {
    const s = String(start || '').trim();
    const e = String(end || '').trim();
    // 只认 YYYY-MM-DD，别把任意字符串拼进 SQL
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return null;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }
  return { start: today, end: today }; // 默认今日
}

/** 拼成 SQL 片段，create_time 存的是「YYYY-MM-DD HH:mm:ss」本地文本 */
export function rangeClause(range, start, end, col = 'create_time') {
  const r = resolveRange(range, start, end);
  if (!r || !r.start) return null; // 不限时间 / 非法（非法由调用方先行拦截）
  return { sql: `${col} >= ? AND ${col} <= ?`, args: [`${r.start} 00:00:00`, `${r.end} 23:59:59`] };
}
