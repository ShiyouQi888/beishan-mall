// 到期自动下架：转拍挂出后，场次结束仍没人买，就把商品下架退回持有人
//
// 替代原来的「流拍」机制（已下线）：
//   · 不再生成流拍台账（orders.type = 5）、没有平台回收、没有释放/指派操作
//   · 只做两件事：商品下架、把订单的「已挂牌」标记归零，让持有人能重新转拍
//   · 给持有人发一条站内消息，说明货已退回
import { all, get, run, now } from '../db.js';
import { todayStr, sessionWindow } from './sessionWindow.js';
import { areasOfGoods } from './areaGoods.js';
import { releaseListing } from './listing.js';

/**
 * 扫描并下架已过期的挂单
 * 判定条件：商品挂在场次里、仍在上架、场次日期不晚于今天、且该商品关联的场次都不再开放
 * （今天还有「未开始」的场次时不动，避免把当天晚些时候还要开的那场提前下掉）
 */
export function expireUnsold(day = todayStr()) {
  const rows = all(
    `SELECT goods_id, goods_name, goods_min_price, member_id, area_date
     FROM goods
     WHERE IFNULL(area_date, '') <> ''
       AND area_date <= ?
       AND goods_status = 10
       AND IFNULL(member_id, 0) > 0
       AND IFNULL(recycled, 0) = 0`,
    day,
  );

  let expired = 0;
  const items = [];

  for (const g of rows) {
    const areas = areasOfGoods(g.goods_id);
    if (!areas.length) {
      // 场次被移除/删除后留下的悬空货：成员手上的货已经无处可卖，直接退货。
      // 这里原来写的是 continue —— 于是「无场次 + 已挂牌」的货永远不会被下架，彻底卡死。
      const r = releaseListing(g.goods_id, '所在场次已移除，商品下架并退回持有人');
      if (r.released) {
        expired++;
        items.push({ goods_id: g.goods_id, goods_name: g.goods_name, member_id: g.member_id });
      }
      continue;
    }
    const wins = areas.map((a) => sessionWindow(a));
    if (wins.some((w) => w.open)) continue;             // 还有场次正在开放，不是到期
    if (g.area_date === day && wins.some((w) => w.state === 'upcoming')) continue; // 今天还有没开始的场次

    const t = now();
    const r = run(
      'UPDATE goods SET goods_status = 20, is_sell = 0, update_time = ? WHERE goods_id = ? AND goods_status = 10',
      t, g.goods_id,
    );
    if (Number(r.changes) !== 1) continue;

    // 把这次挂牌标记归零，否则持有人再点转拍会被「该订单已转拍上架」拦住
    const o = get(
      `SELECT order_id FROM orders
       WHERE goods_id = ? AND member_id = ? AND type = 1 AND consignment_status = 10
       ORDER BY order_id DESC LIMIT 1`,
      g.goods_id, g.member_id,
    );
    if (o) {
      run('UPDATE orders SET consignment_status = 0 WHERE order_id = ?', o.order_id);
      run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        o.order_id, '场次到期未成交', 'system', '商品已自动下架退回持有人，可重新转拍', t);
    }

    run('INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
      g.member_id, '商品已退回',
      `「${g.goods_name}」所在场次已结束且无人成交，商品已自动下架退回你的店铺，可随时重新转拍。`, t);

    expired++;
    items.push({ goods_id: g.goods_id, goods_name: g.goods_name, member_id: g.member_id });
  }

  return { scanned: rows.length, expired, items };
}
