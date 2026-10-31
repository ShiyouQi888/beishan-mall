// 每场每人限购件数
//
// 口径：**同一场次、同一天、同一个会员，买了多少件**（不同商品合并计算）。
// 字段叫「每场每人限购」，所以必须是按场次算的 —— 之前实现按 goods_id 统计，
// 实际变成「每个商品每人限购」，和名字对不上：同一场里买 10 件不同的货完全不受拦。
//
// 为什么带日期：场次是每天重复开放的（specialarea 一天三场），
// 只按 specialarea_id 统计会把昨天买的算进今天的额度，第二天一开抢就没额度了。
// orders.specialarea_id 是下单时写入的当时场次，正好用来切分。
import { get } from '../db.js';
import { todayStr } from './sessionWindow.js';

/** 这个会员在本场次今天已经买了多少件（不含已取消） */
export function sessionBoughtOf(memberId, areaId, date = todayStr()) {
  if (!memberId || !areaId) return 0;
  return Number(get(
    `SELECT IFNULL(SUM(num), 0) n FROM orders
     WHERE member_id = ? AND specialarea_id = ? AND type = 1 AND status <> 40
       AND date(create_time) = ?`,
    Number(memberId), Number(areaId), date,
  )?.n) || 0;
}

/**
 * 本场限购件数；<= 0 表示不限。
 * 后台输入框 min=1，正常不会出现 0，这里兜底成「不限」而不是「默认 1 件」——
 * 把 0 当 1 会在运营误填时把整场锁死。
 */
export const sessionLimitOf = (area) => {
  const n = Number(area?.buy_num) || 0;
  return n > 0 ? n : 0;
};

/** 本场的限购额度：{ limit, bought, left }；不限购时 left 为 null */
export function sessionLimitLeft(memberId, area, date = todayStr()) {
  const limit = sessionLimitOf(area);
  const bought = sessionBoughtOf(memberId, area?.specialarea_id, date);
  return { limit, bought, left: limit > 0 ? Math.max(0, limit - bought) : null };
}
