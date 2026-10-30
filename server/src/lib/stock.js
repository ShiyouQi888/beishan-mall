// 商品名额（按件出售）
//
// 名额 = 1   → 唯一的一件货：成交即整件归买家、商品下架，买家可以转拍
// 名额 > 1   → 一批货：抢一个减一个名额，抢光自动下架，整件始终归原持有人
//
// 「按份拆分」与「流拍」两个功能都已下线：
//   · 拆分让同一件货同时存在两套价格口径，与转拍互斥；
//   · 流拍改为「到期自动下架退回持有人」（lib/expire.js），不再生成流拍台账。
import { get, run, now } from '../db.js';

/**
 * 是不是「一批货」：名额 > 1 就是，抢一个减一个名额。
 * 注意只看 stock_total，不看 stock_num —— 后者卖着卖着就变成 0/1，判断不出来。
 */
export const isPieceSale = (g) => Number(g?.stock_total) > 1;

/** 下单时扣减名额（事务内调用，原子操作）。只有一批货才需要扣，唯一一件货不扣 */
export function deductStock(goodsId, num) {
  const r = run(
    'UPDATE goods SET stock_num = stock_num - ? WHERE goods_id = ? AND stock_num >= ?',
    Number(num), Number(goodsId), Number(num),
  );
  if (Number(r.changes) !== 1) return false;
  // 名额抢光自动下架（只对一批货生效，唯一一件货由结算时下架）
  const g = get('SELECT stock_num, stock_total FROM goods WHERE goods_id = ?', Number(goodsId));
  if (g && Number(g.stock_num) <= 0 && isPieceSale(g)) {
    run('UPDATE goods SET goods_status = 20 WHERE goods_id = ? AND stock_total > 1', Number(goodsId));
  }
  return true;
}

/**
 * 取消未付款订单时归还名额（与 deductStock 严格对称）
 * - 只处理「一批货」：唯一一件货的 stock_num 不参与售卖，下单也不扣它
 * - 只在订单还没成交时调用。已结算的订单名额已经真卖掉了，再还就是凭空多出一个
 * - 因抢光被自动下架的商品，名额回来后自动恢复在售；手动下架的商品名额本来就不是 0，不受影响
 * @returns {boolean} 是否真的归还了名额
 */
export function restoreStock(goodsId, num) {
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goodsId));
  if (!g || !isPieceSale(g)) return false;
  const add = Number(num) || 0;
  if (add <= 0) return false;

  const cap = Number(g.stock_total) || 0;
  const wasSoldOut = Number(g.stock_num) <= 0;
  let next = Number(g.stock_num) + add;
  if (cap > 0 && next > cap) next = cap;

  run('UPDATE goods SET stock_num = ?, update_time = ? WHERE goods_id = ?', next, now(), g.goods_id);
  if (wasSoldOut && next > 0) {
    run(
      'UPDATE goods SET goods_status = 10, update_time = ? WHERE goods_id = ? AND stock_total > 1 AND goods_status = 20',
      now(), g.goods_id,
    );
  }
  return true;
}
