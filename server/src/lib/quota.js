// 每场放量：库存是仓库里一共有多少，放量是「这一场只拿出多少来卖」
//
// 为什么单开一份实现：这个判定同时被三处用到（下单校验、列表出参、详情出参），
// 三处各写一遍 SQL 迟早会走偏。而且「本场」的边界必须只有一个定义。
import { all, get } from '../db.js';
import { todayStr } from './sessionWindow.js';

/**
 * 本场各商品已卖出的数量。
 * 「本场」按自然日切：系统一天最多三场，一个商品只会落在其中一场，
 * 所以按日期统计与按场次统计等价，第二天自动从 0 开始，不需要定时任务清零。
 * 未付款订单也算占用（下单时已经扣了库存，口径必须一致）；已取消的不算。
 */
export function soldTodayByGoods(date = todayStr()) {
  const map = new Map();
  const rows = all(
    `SELECT goods_id, IFNULL(SUM(num), 0) n FROM orders
     WHERE type = 1 AND status <> 40 AND date(create_time) = ?
     GROUP BY goods_id`,
    date,
  );
  for (const r of rows) map.set(Number(r.goods_id), Number(r.n) || 0);
  return map;
}

/** 单件商品的本场已售 */
export function soldTodayOf(goodsId, date = todayStr()) {
  return Number(get(
    `SELECT IFNULL(SUM(num), 0) n FROM orders
     WHERE goods_id = ? AND type = 1 AND status <> 40 AND date(create_time) = ?`,
    Number(goodsId), date,
  )?.n) || 0;
}

/** 本场还剩几件可卖；不限量返回 null */
export function quotaLeft(g, sold = 0) {
  const quota = Number(g?.session_quota) || 0;
  if (quota <= 0) return null;
  return Math.max(0, quota - (Number(sold) || 0));
}

/** 本场放量是否已卖满（不限量恒为 false） */
export function quotaFull(g, sold = 0) {
  const left = quotaLeft(g, sold);
  return left !== null && left <= 0;
}
