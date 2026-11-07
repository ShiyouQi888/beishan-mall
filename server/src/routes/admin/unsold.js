// 流拍订单：场次结束仍未成交、已下架退回持有人的转拍货
//
// 「流拍」台账（orders.type=5）早已下线，现在 expire.js 只做两件事：
// 商品下架、把订单的在挂标记归零，同时写一条「场次到期未成交」日志。
// 所以这里不新建表，直接用「挂出去过 + 已下架 + 仍归原持有人 + 当前没在挂」作为流拍口径。
//
// 指派 = 运营把这件货指定给某会员，按「后台确认收款」口径生成一笔成交订单：
// 走 settleOrder 结算（货款/佣金/积分、货权过户），场次日期固定延续今天。
import { Router } from 'express';
import { all, get, run, tx, now } from '../../db.js';
import { ok, fail, authAdmin, money, assetUrl, calcServiceCharge } from '../../lib/helper.js';
import { orderNo } from '../../lib/auth.js';
import { settleOrder, calcListingFee } from '../../lib/settle.js';
import { todayStr } from '../../lib/sessionWindow.js';
import { todaySlot } from '../../lib/sessions.js';
import { setGoodsAreas } from '../../lib/areaGoods.js';

const r = Router();

// 该货当前这一手的成交单：按件货用独立货权 id，整件货用 goods_id。
// 别名必须整体构造，不能用字符串 replace —— asset_goods_id 里含 goods_id 子串会替换坏。
const ownedGoods = (a = '') => (a
  ? `COALESCE(NULLIF(${a}.asset_goods_id, 0), ${a}.goods_id)`
  : 'COALESCE(NULLIF(asset_goods_id, 0), goods_id)');

/**
 * 流拍列表。
 * 条件：有持有人、已下架(20)、未回收、没有正在挂牌的订单，
 * 且最后一手成交单上留有挂牌痕迹（转拍上架 / 场次到期未成交 / 退出场次）。
 */
r.get('/unsold/list', authAdmin, (req, res) => {
  const p = Math.max(1, Number(req.query.page) || 1);
  const pp = Math.min(100, Number(req.query.limit) || 20);
  const kw = String(req.query.keyword || '').trim();
  let rows = all(
    `SELECT g.goods_id, g.goods_name, g.good_thumb, g.goods_min_price, g.base_price,
            g.price_cap, g.member_id AS holder_id, g.area_date, g.goods_status,
            g.turn_beat_num, g.update_time,
            m.nick_name AS holder_name, m.mobile AS holder_mobile,
            o.order_id AS last_order_id, o.order_no AS last_order_no,
            o.total_price AS last_price, o.specialarea_id,
            a.title_main AS area_name, a.name AS area_slot_name,
            (SELECT MAX(l.create_time) FROM order_log l
              WHERE l.order_id = o.order_id
                AND l.action IN ('转拍上架', '场次到期未成交', '退出场次')) AS last_listing_time
       FROM goods g
       JOIN member m ON m.member_id = g.member_id
       JOIN orders o ON o.order_id = (
         SELECT o2.order_id FROM orders o2
          WHERE ${ownedGoods('o2')} = g.goods_id
            AND o2.type = 1 AND o2.pay_status = 10 AND o2.member_id = g.member_id
          ORDER BY o2.order_id DESC LIMIT 1
       )
       LEFT JOIN specialarea a ON a.specialarea_id = o.specialarea_id
      WHERE IFNULL(g.member_id, 0) > 0
        AND g.goods_status = 20
        AND IFNULL(g.recycled, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM orders ox
           WHERE ${ownedGoods('ox')} = g.goods_id
             AND IFNULL(ox.consignment_status, 0) = 10
        )
        AND EXISTS (
          SELECT 1 FROM order_log l
           WHERE l.order_id = o.order_id
             AND l.action IN ('转拍上架', '场次到期未成交', '退出场次')
        )
      ORDER BY last_listing_time DESC, g.goods_id DESC`,
  );
  if (kw) {
    rows = rows.filter((x) => String(x.goods_name || '').includes(kw)
      || String(x.holder_name || '').includes(kw)
      || String(x.holder_mobile || '').includes(kw)
      || String(x.last_order_no || '').includes(kw));
  }
  const total = rows.length;
  const data = rows.slice((p - 1) * pp, p * pp).map((x) => ({
    ...x,
    good_thumb: assetUrl(x.good_thumb || ''),
    goods_min_price: Number(x.goods_min_price || 0).toFixed(2),
    last_price: Number(x.last_price || 0).toFixed(2),
    area_text: x.area_name || x.area_slot_name || '未关联场次',
  }));
  res.json(ok({ total, data, page: p, limit: pp, last_page: Math.ceil(total / pp) || 0 }));
});

/**
 * 指派流拍商品给指定会员（视同抢单成交）。
 * 生成一笔已成交订单 → settleOrder 结算并过户 → 场次日期延续今天。
 * 与后台「新增订单 + 确认收款」同口径：平台不实际收款，货款由双方线下结清。
 */
r.post('/unsold/assign', authAdmin, (req, res) => {
  const goodsId = Number(req.body?.goods_id);
  const toId = Number(req.body?.member_id);
  const reason = String(req.body?.reason || '').trim().slice(0, 100);
  if (!Number.isInteger(goodsId) || goodsId <= 0) return res.json(fail('请选择商品'));
  if (!Number.isInteger(toId) || toId <= 0) return res.json(fail('请选择接手会员'));
  if (String(req.body?.confirm || '') !== 'ASSIGN_UNSOLD') return res.json(fail('缺少指派确认'));

  const g = get('SELECT * FROM goods WHERE goods_id = ?', goodsId);
  if (!g) return res.json(fail('商品不存在'));
  if (Number(g.recycled) === 1) return res.json(fail('商品已被回收，不能指派'));
  if (Number(g.member_id) <= 0) return res.json(fail('商品没有持有人，不能指派'));
  if (Number(g.member_id) === toId) return res.json(fail('接手会员就是当前持有人'));
  if (Number(g.goods_status) === 10) return res.json(fail('商品正在挂牌转拍，不能指派'));
  if (Number(g.stock_total) > 1) return res.json(fail('该商品是库存池，不能直接指派'));
  const to = get('SELECT member_id, nick_name, mobile, disabled FROM member WHERE member_id = ?', toId);
  if (!to) return res.json(fail('接手会员不存在'));
  if (Number(to.disabled) === 20) return res.json(fail('该会员已被禁用，不能接手'));
  const listed = get(
    `SELECT 1 FROM orders WHERE ${ownedGoods()} = ? AND IFNULL(consignment_status, 0) = 10`, goodsId,
  );
  if (listed) return res.json(fail('该商品仍有在挂记录，不能指派'));
  const prev = get(
    `SELECT * FROM orders WHERE ${ownedGoods()} = ?
       AND type = 1 AND pay_status = 10 AND member_id = ? ORDER BY order_id DESC LIMIT 1`,
    goodsId, Number(g.member_id),
  );
  if (!prev) return res.json(fail('找不到该货的成交订单'));

  const price = money(Number(g.goods_min_price) || 0);
  if (!(price > 0)) return res.json(fail('商品标价无效，请先在商品管理里设置'));
  const service = calcServiceCharge(price);
  const listingFee = calcListingFee(price);
  const holder = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', g.member_id);
  const no = orderNo('F');
  const t = now();
  const today = todayStr();
  const baseAreaId = Number(prev.specialarea_id) || Number(g.specialarea_id) || 0;
  // 场次延续今天：优先今天还能开的场次，沿用原场次顺序起点；今天全结束则保留原场次
  const areaId = Number(todaySlot(baseAreaId)?.area_id || baseAreaId) || 0;

  let orderId = 0;
  try {
    tx(() => {
      const info = run(
        `INSERT INTO orders
          (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
           type, price, num, total_price, service_charge, listing_fee,
           status, pay_status, pay_type, pay_time, remark, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        no, toId, Number(g.member_id), goodsId, g.goods_name || '', g.good_thumb || '', areaId,
        1, price, 1, price, service, listingFee,
        10, 10, 0, t, reason || '流拍指派（视同抢单成交）', t,
      );
      orderId = Number(info.lastInsertRowid);
      const o = get('SELECT * FROM orders WHERE order_id = ?', orderId);
      // 与后台确认收款完全同口径：过户货权、下架、卖家货款 / 直推奖 / 积分
      settleOrder(o);
      // 成交后 goods_status 已是 20；这里把排期日期固定回今天，场次关联落到今天这一场
      run('UPDATE goods SET area_date = ?, update_time = ? WHERE goods_id = ?', today, t, goodsId);
      if (areaId) setGoodsAreas(goodsId, [areaId]);
      run(
        'INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        orderId, '流拍指派', 'admin',
        `由会员 ${g.member_id} 指派给 ${toId}（${reason || '流拍指派'}）；标价 ¥${price.toFixed(2)}，场次延续 ${today}`, t,
      );
      run(
        `INSERT INTO admin_operation_log
          (admin_id, admin_name, admin_nick, role_id, action, method, path, target_type, target_id,
           details, result, http_status, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        Number(req.admin?.store_user_id) || 0,
        String(req.admin?.user_name || ''), String(req.admin?.nick_name || ''), Number(req.admin?.role_id) || 0,
        '指派流拍商品', 'POST', '/unsold/assign', '商品', String(goodsId),
        JSON.stringify({
          goods_id: goodsId, goods_name: g.goods_name, order_no: no,
          from_member_id: Number(g.member_id), to_member_id: toId,
          price, service_charge: service, listing_fee: listingFee,
          area_id: areaId, date: today, reason,
        }),
        1, 200, t,
      );
    });
  } catch (e) {
    return res.json(fail(`指派失败：${e.message}`));
  }

  res.json(ok({
    order_id: orderId,
    order_no: no,
    goods_id: goodsId,
    goods_name: g.goods_name || '',
    from_member_id: Number(g.member_id),
    from_name: holder?.nick_name || '',
    to_member_id: toId,
    to_name: to.nick_name || '',
    price: price.toFixed(2),
    service_charge: service.toFixed(2),
    listing_fee: listingFee.toFixed(2),
    area_id: areaId,
    date: today,
  }, `已指派给 ${to.nick_name || `会员#${toId}`}，生成成交订单 ${no}，场次延续今天（${today}）`));
});

export default r;
