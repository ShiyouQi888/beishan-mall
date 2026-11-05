import { all, get, run, tx, now } from '../db.js';

/**
 * 按件销售的商品行代表卖家的库存池；成交后订单会额外挂一条独立单件商品。
 * 唯一件订单没有拆分资产，继续直接使用 orders.goods_id。
 */
export const orderGoodsId = (order) =>
  Number(order?.asset_goods_id) > 0 ? Number(order.asset_goods_id) : Number(order?.goods_id) || 0;

export const orderGoods = (order) => {
  const goodsId = orderGoodsId(order);
  return goodsId ? get('SELECT * FROM goods WHERE goods_id = ?', goodsId) : null;
};

/**
 * 为一笔按件成交单建立单件货权。调用方负责在业务事务中执行。
 * goods_no 使用订单号，重复确认或迁移中断后重跑都能找到同一件货。
 */
export function ensureOrderAsset(order, sourceGoods) {
  if (!order || !sourceGoods || Number(sourceGoods.stock_total) <= 1) return null;

  const linkedId = Number(order.asset_goods_id) || 0;
  if (linkedId) {
    const linked = get('SELECT * FROM goods WHERE goods_id = ?', linkedId);
    if (linked) return linked;
  }

  const assetNo = `UNIT-${order.order_no}`;
  let asset = get(
    'SELECT * FROM goods WHERE goods_no = ? AND asset_parent_id = ? ORDER BY goods_id LIMIT 1',
    assetNo, sourceGoods.goods_id,
  );

  if (!asset) {
    const t = now();
    const price = Number(order.price) || Number(sourceGoods.goods_min_price) || 0;
    const basePrice = Number(sourceGoods.base_price) > 0 ? Number(sourceGoods.base_price) : price;
    const info = run(
      `INSERT INTO goods (
         goods_name, goods_no, good_thumb, images, detail, detail_images, category_id,
         specialarea_id, area_date, member_id, goods_min_price, base_price, price_cap, recycled,
         line_price, stock_num, stock_total, sales_actual, goods_status, is_sell,
         turn_beat_num, goods_sort, type, score_price, session_quota, asset_parent_id,
         create_time, update_time
       ) VALUES (?,?,?,?,?,?,?,0,'',?,?,?,?,0,?,1,1,1,20,0,1,?,?,?,?,?, ?,?)`,
      sourceGoods.goods_name || order.goods_name || '', assetNo,
      sourceGoods.good_thumb || order.goods_thumb || '', sourceGoods.images || '',
      sourceGoods.detail || '', sourceGoods.detail_images || '', Number(sourceGoods.category_id) || 0,
      Number(order.member_id), price, basePrice, Number(sourceGoods.price_cap) || 0,
      Number(sourceGoods.line_price) || 0, Number(sourceGoods.goods_sort) || 100,
      Number(sourceGoods.type) || 1, Number(sourceGoods.score_price) || 0,
      Number(sourceGoods.session_quota) || 0, Number(sourceGoods.goods_id), t, t,
    );
    asset = get('SELECT * FROM goods WHERE goods_id = ?', Number(info.lastInsertRowid));
  }

  if (!asset) throw new Error(`订单 ${order.order_no} 的独立货权创建失败`);
  run(
    'UPDATE orders SET asset_goods_id = ? WHERE order_id = ? AND IFNULL(asset_goods_id, 0) = 0',
    asset.goods_id, order.order_id,
  );
  order.asset_goods_id = Number(asset.goods_id);
  return asset;
}

/** 启动迁移：给旧版已确认的按件订单补建独立货权，可安全重复运行。 */
export function backfillPieceOrderAssets() {
  const pending = all(
    `SELECT o.*, g.goods_id AS source_goods_id
       FROM orders o JOIN goods g ON g.goods_id = o.goods_id
      WHERE o.type = 1 AND o.pay_status = 10 AND IFNULL(o.status, 0) <> 40
        AND IFNULL(o.asset_goods_id, 0) = 0 AND IFNULL(g.stock_total, 1) > 1
      ORDER BY o.order_id ASC`,
  );
  if (!pending.length) return 0;

  return tx(() => {
    let created = 0;
    for (const order of pending) {
      const source = get('SELECT * FROM goods WHERE goods_id = ?', order.source_goods_id);
      if (!source) continue;
      ensureOrderAsset(order, source);
      created += 1;
    }
    return created;
  });
}
