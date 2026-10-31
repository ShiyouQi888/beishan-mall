// 「退货」：把一件已经挂牌、但失去场次的转拍货退回持有人
//
// 为什么需要它：
//   转拍上架时商品被绑定到「下一场」（specialarea_goods），订单打上 consignment_status=10。
//   如果运营把商品从场次里移除、或者整个场次被删掉，关联就没了 —— 但 goods.area_date 和
//   consignment_status 还在。于是这件货进入死锁：
//     · H5 列表按 area_date 过滤 → 看不到
//     · 到期扫描 lib/expire.js 见「没有关联场次」直接跳过 → 永远不会被下架
//     · 持有人点转拍 → 被「该订单已转拍上架」拦住
//   货凭空消失，持有人钱货两空，后台也没有入口能救。
//
// 处理原则：一件转拍货只要在挂，就必须有场次承载。一旦失去场次，系统主动退货 ——
// 下架、把在挂标记归零、发站内信让持有人重新转拍，而不是让它悬空。
import { get, run, now } from '../db.js';

/**
 * 退货（幂等）：没有在挂记录、或者商品还挂在别的场次时，什么都不做。
 * @param {number} goodsId
 * @param {string} reason 写进订单日志的原因
 * @returns {{released:boolean, goods_name?:string, member_id?:number, order_id?:number, reason?:string}}
 */
export function releaseListing(goodsId, reason = '') {
  const g = get(
    'SELECT goods_id, goods_name, member_id, goods_status FROM goods WHERE goods_id = ?',
    Number(goodsId) || 0,
  );
  // 平台自营的货没有「持有人」概念，不参与退货
  if (!g || Number(g.member_id) <= 0) return { released: false, reason: 'platform' };

  // 还挂在别的场次：货有地方卖，不动它
  const left = Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', g.goods_id)?.c || 0);
  if (left > 0) return { released: false, reason: 'still-in-area' };

  // 只有「当前持有人的这一手」才是在挂单，历史订单上的标记不算
  const o = get(
    `SELECT order_id FROM orders
     WHERE goods_id = ? AND member_id = ? AND type = 1 AND IFNULL(consignment_status, 0) = 10
     ORDER BY order_id DESC LIMIT 1`,
    g.goods_id, g.member_id,
  );
  if (!o) return { released: false, reason: 'not-listed' };

  const t = now();
  const remark = reason || '所在场次已取消，商品下架并退回持有人';

  run('UPDATE orders SET consignment_status = 0 WHERE order_id = ?', o.order_id);
  // 必须下架：留在架上又没有场次，它会变成「随时可买」的自由商品，
  // 别人按标价就能把这件货买走 —— 那是持有人真金白银买来的。
  run(
    'UPDATE goods SET goods_status = 20, is_sell = 0, area_date = \'\', update_time = ? WHERE goods_id = ?',
    t, g.goods_id,
  );
  run(
    'INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    o.order_id, '退出场次', 'system', remark, t,
  );
  run(
    'INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
    g.member_id, '商品已退出场次',
    `「${g.goods_name}」所在场次已取消，商品已下架退回你的店铺。需要继续出售时，请重新点「转拍上架」。`,
    t,
  );

  return { released: true, goods_name: g.goods_name, member_id: g.member_id, order_id: o.order_id };
}

/**
 * 清理历史失效的「已挂牌」标记（启动时跑一次，幂等）。
 *
 * 修复前 settleOrder 不过户时清标记，同一件货会累积多条 consignment_status=10 ——
 * 只要「货已经不在订单会员手上」（被买走 / 被回收成平台持仓），这条记录就不可能仍在挂。
 * @returns {number} 清理条数
 */
export function cleanStaleListingFlags() {
  const r = run(
    `UPDATE orders SET consignment_status = 0
     WHERE IFNULL(consignment_status, 0) = 10
       AND EXISTS (
         SELECT 1 FROM goods g
         WHERE g.goods_id = orders.goods_id AND IFNULL(g.member_id, 0) <> orders.member_id
       )`,
  );
  return Number(r.changes || 0);
}
