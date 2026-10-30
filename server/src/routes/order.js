import { Router } from 'express';
import { all, get, run, tx, now } from '../db.js';
import { ok, fail, authMember, page, money, cfg, calcServiceCharge, serviceChargeRate, priceIncreaseRate, calcNextPrice, assetUrl, ORDER_STATUS, ORDER_TYPE, PAY_TYPE } from '../lib/helper.js';
import { orderNo } from '../lib/auth.js';
import { settleOrder, biz, calcListingFee, listingFeeRate } from '../lib/settle.js';
import { deductStock } from '../lib/split.js';
import { buyWindow } from '../lib/buyWindow.js';
import { nextSessionId } from '../lib/sessions.js';

const r = Router();

const money2 = (n) => Number(Number(n).toFixed(2));

function fmtOrder(o) {
  const g = o.goods_id ? get('SELECT good_thumb, images FROM goods WHERE goods_id = ?', o.goods_id) : null;
  const thumb = o.goods_thumb || g?.good_thumb || '';
  return {
    order_id: o.order_id,
    order_no: o.order_no,
    order_type: o.type,
    order_type_text: ORDER_TYPE[o.type] || '',
    goods_id: o.goods_id,
    goods_name: o.goods_name,
    goods_thumb: assetUrl(thumb),
    price: Number(o.price).toFixed(2),
    num: o.num,
    total_price: Number(o.total_price).toFixed(2),
    service_charge: Number(o.service_charge || 0).toFixed(2),
    status: o.status,
    status_text: ORDER_STATUS[o.status] || '',
    pay_status: o.pay_status,
    pay_type: o.pay_type,
    pay_type_text: PAY_TYPE[o.pay_type] || '',
    pay_voucher: o.pay_voucher,
    consignment_status: o.consignment_status,
    is_examine: o.is_examine,
    express_no: o.express_no,
    express_company: o.express_company,
    create_time: o.create_time,
    pay_time: o.pay_time,
    send_time: o.send_time,
    finish_time: o.finish_time,
    remark: o.remark || '',
    seller_id: o.seller_id,
    seller_name: o.seller_id ? get('SELECT nick_name FROM member WHERE member_id = ?', o.seller_id)?.nick_name || '' : '',
  };
}

/** 记录订单日志 */
const log = (orderId, action, operator = 'member', remark = '') =>
  run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    orderId, action, operator, remark, now());

/** 服务费计算：按订单总额算（与下单写入同一口径，见 lib/helper.js calcServiceCharge） */
function serviceCharge(amount) {
  return calcServiceCharge(amount);
}

// ---------------- 下单（抢购） ----------------
r.post('/toAddOrder', authMember, (req, res) => {
  const { goods_id, num = 1, address_id, remark, pay_type } = req.body;
  const m = req.member;
  if (!goods_id) return res.json(fail('请选择商品'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  if (g.goods_status !== 10) return res.json(fail('商品已下架'));
  if (g.member_id === m.member_id) return res.json(fail('不能购买自己持有的商品'));

  // 场次时间校验：统一按后台「交易设置 → 抢购总时间」判断（所有场次共用一套）
  if (g.specialarea_id) {
    const a = get('SELECT * FROM specialarea WHERE specialarea_id = ?', g.specialarea_id);
    if (a) {
      const w = buyWindow();
      if (!w.dayOk) return res.json(fail(`今日不是抢购日（开放：${w.daysText}）`));
      if (!w.timeOk) return res.json(fail(`当前不在抢购时间内（${w.text}）`));
      // 限购
      const bought = get(
        'SELECT IFNULL(SUM(num),0) n FROM orders WHERE member_id = ? AND type = 1 AND status <> 40 AND create_time >= ?',
        m.member_id, new Date().toISOString().slice(0, 10),
      ).n;
      if (bought + Number(num) > (a.buy_num || 1)) {
        return res.json(fail(`每人限购 ${a.buy_num || 1} 件`));
      }
    }
  }

  // 是否强制会员先设置收款方式由后台「交易设置」控制，默认关闭。
  // 兼容旧版 H5：收款账户页面写入 member_card，而旧校验只检查 member.pay_setting。
  if (g.type === 1 && Number(cfg('require_receiving_account', '20')) === 10) {
    const hasReceivingAccount = Boolean(m.pay_setting)
      || Boolean(get('SELECT card_id FROM member_card WHERE member_id = ? LIMIT 1', m.member_id));
    if (!hasReceivingAccount) return res.json(fail('请先设置收款方式'));
  }

  const price = Number(g.goods_min_price);
  const total = money2(price * Number(num));
  // 抢单服务费：按「商品总额 × 后台配置费率」计算，由买家额外承担，卖家仍收全额货款。
  // 后台「交易设置 → 抢单服务费(%)」默认 0 —— 与原站实证一致（抢购环节平台不收费，
  // 平台收入来自转拍上架费）；配了费率才收。
  const fee = calcServiceCharge(total);
  const no = orderNo('Q');

  let orderId;
  try {
    tx(() => {
      // 拆分商品需扣减份数库存（原子扣减，不足则拒单）
      if (g.is_split === 1) {
        if (!deductStock(g.goods_id, num)) throw biz(`库存不足，仅剩 ${g.stock_num} 份`);
      }
      const info = run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
          type, price, num, total_price, service_charge, status, pay_status, pay_type, address_id, remark, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        no, m.member_id, g.member_id, g.goods_id, g.goods_name, g.good_thumb, g.specialarea_id,
        1, price, Number(num), total, fee, 0, 0, Number(pay_type) || 0, Number(address_id) || 0, remark || '', now(),
      );
      orderId = Number(info.lastInsertRowid);
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  log(orderId, '创建订单', 'member', `${g.goods_name} × ${num}`);
  res.json(ok({ order_id: orderId, order_no: no, total_price: total, service_charge: fee }, '下单成功'));
});

// ---------------- 服务费 ----------------
// 两个查询接口与下单保持同一口径：按「单价 × 数量」算，否则多件下单时页面显示与实付对不上
const quoteServiceCharge = (req, res) => {
  const { goods_id, num = 1 } = req.query;
  if (!goods_id) { res.json(fail('method param miss:goods_id')); return null; }
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) { res.json(fail('商品不存在')); return null; }
  const n = Math.max(1, Number(num) || 1);
  const price = Number(g.goods_min_price);
  const total = money2(price * n);
  return { price, num: n, total, fee: serviceCharge(total) };
};

r.get('/getServiceCharge', (req, res) => {
  const q = quoteServiceCharge(req, res);
  if (!q) return;
  res.json(ok({
    service_charge: q.fee.toFixed(2),
    rate: serviceChargeRate(),
    price: q.price.toFixed(2),
    num: q.num,
    total_price: q.total.toFixed(2),
    pay_total: money2(q.total + q.fee).toFixed(2),
  }));
});

r.get('/toServiceCharge', (req, res) => {
  const q = quoteServiceCharge(req, res);
  if (!q) return;
  res.json(ok({
    service_charge: q.fee.toFixed(2),
    rate: serviceChargeRate(),
    total_price: q.total.toFixed(2),
    pay_total: money2(q.total + q.fee).toFixed(2),
  }));
});

// ---------------- 支付 ----------------
r.post('/toPay', authMember, (req, res) => {
  const { order_id, pay_type, voucher } = req.body;
  const m = req.member;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), m.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.pay_status === 10) return res.json(fail('订单已支付'));
  const pt = Number(pay_type) || 1;
  if (pt === 1) {
    // 余额支付：事务内原子扣款 + 原子标记已支付，防止并发超扣/重复扣
    const cost = money2(o.total_price + o.service_charge);
    try {
      tx(() => {
        const r1 = run(
          'UPDATE member SET amount = amount - ? WHERE member_id = ? AND amount >= ?',
          cost, m.member_id, cost,
        );
        if (Number(r1.changes) !== 1) throw biz('账户余额不足');

        const r2 = run(
          'UPDATE orders SET status = 10, pay_status = 10, pay_time = ? WHERE order_id = ? AND pay_status = 0',
          now(), o.order_id,
        );
        if (Number(r2.changes) !== 1) throw biz('订单已支付，请勿重复操作');

        run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
          m.member_id, -cost, 2, '余额支付', `订单 ${o.order_no}`, now());
        settleOrder(o);
        log(o.order_id, '支付完成', 'member', `余额支付 ¥${cost.toFixed(2)}`);
      });
    } catch (e) {
      if (e.biz) return res.json(fail(e.message));
      throw e;
    }
    return res.json(ok([], '支付成功'));
  }
  if (pt === 4) {
    if (!voucher) return res.json(fail('请上传支付凭证'));
    run('UPDATE orders SET pay_type = 4, pay_voucher = ? WHERE order_id = ?', voucher, o.order_id);
    log(o.order_id, '上传支付凭证', 'member');
    return res.json(ok([], '凭证已提交，等待平台确认'));
  }
  // 微信/支付宝：演示环境直接标记待确认
  run('UPDATE orders SET pay_type = ?, pay_voucher = ? WHERE order_id = ?', pt, voucher || '', o.order_id);
  res.json(ok([], '已提交支付，等待确认'));
});

// 结算与分账逻辑见 lib/settle.js（与后台确认收款共用）

// ---------------- 订单列表 ----------------
r.get('/getOrder', authMember, (req, res) => {
  const { status, dataType, page: p = 1, limit = 10 } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  const where = ['member_id = ?'];
  const args = [req.member.member_id];
  if (status !== undefined && status !== '' && status !== 'all') {
    where.push('status = ?');
    args.push(Number(status));
  }
  if (dataType && dataType !== 'all') {
    where.push('type = ?');
    args.push(Number(dataType));
  }
  const w = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM orders WHERE ${w}`, ...args).c;
  const list = all(`SELECT * FROM orders WHERE ${w} ORDER BY order_id DESC LIMIT ? OFFSET ?`, ...args, pp, (cur - 1) * pp);
  res.json(ok(page(list.map(fmtOrder), total, cur, pp)));
});

r.get('/detail', authMember, (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json(fail('method param miss:order_id'));
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  if (o.member_id !== req.member.member_id && o.seller_id !== req.member.member_id) {
    return res.json(fail('无权查看该订单'));
  }
  const addr = o.address_id ? get('SELECT * FROM member_address WHERE address_id = ?', o.address_id) : null;
  res.json(ok({ ...fmtOrder(o), address: addr, logs: all('SELECT * FROM order_log WHERE order_id = ? ORDER BY log_id', o.order_id) }));
});

// 订单状态流转：取消 / 确认收货
r.post('/cancel', authMember, (req, res) => {
  const { order_id } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.status !== 0) return res.json(fail('当前状态不可取消'));
  run('UPDATE orders SET status = 40 WHERE order_id = ?', o.order_id);
  log(o.order_id, '订单取消', 'member');
  res.json(ok([], '已取消'));
});

r.post('/receipt', authMember, (req, res) => {
  const { order_id } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.status !== 20) return res.json(fail('当前状态不可确认收货'));
  run('UPDATE orders SET status = 30, finish_time = ? WHERE order_id = ?', now(), o.order_id);
  log(o.order_id, '确认收货', 'member');
  res.json(ok([], '已确认收货'));
});

r.get('/express', authMember, (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json(fail('method param miss:order_id'));
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  res.json(
    ok({
      express_no: o.express_no,
      express_company: o.express_company,
      traces: o.express_no
        ? [{ time: o.send_time, context: '商品已发出，请注意查收' }]
        : [],
    }),
  );
});

/**
 * 转拍定价（单一口径）：
 *   下一轮标价 = 上一手成交价 × (1 + 涨价率)，逐轮复利 10000 → 10300 → 10609
 *   下一轮买家付 10300，上一手持有人收回 10300 全额（原价 + 涨价），此后与原持有人再无关系
 * 涨价率 > 0 时完全由服务端定价，忽略前端传入的价格（防止篡改）。
 */
function quoteConsignment(o, g, clientPrice) {
  const prevPrice = money2(o.total_price);
  const rate = priceIncreaseRate();
  const nextPrice = rate > 0
    ? calcNextPrice(prevPrice)
    : (Number(clientPrice) > 0 ? money2(clientPrice) : money2(g.goods_min_price));
  const listingFee = calcListingFee(prevPrice);
  return {
    prev_price: prevPrice,
    increase_rate: rate,
    increase_amount: money2(nextPrice - prevPrice),
    next_price: nextPrice,
    listing_fee: listingFee,
    // 持有人的实际套利 = 下一轮收回价 − 上一手成本 − 上架费
    net_income: money2(nextPrice - prevPrice - listingFee),
  };
}

/** 转拍报价（H5 展示用，不落库） */
r.get('/getConsignmentQuote', authMember, (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json(fail('method param miss:order_id'));
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.consignment_status === 10) return res.json(fail('该订单已转拍上架'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', o.goods_id);
  if (!g) return res.json(fail('商品不存在'));
  res.json(ok(quoteConsignment(o, g, req.query.price)));
});

// 转拍（寄卖上架）：按本轮抢购金额收取上架费，商品重新上架到原场次
r.post('/consignment', authMember, (req, res) => {
  const { order_id, price } = req.body;
  const m = req.member;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), m.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.status !== 10 && o.status !== 30) return res.json(fail('订单未完成，无法转拍'));
  if (o.consignment_status === 10) return res.json(fail('该订单已转拍上架'));

  const g = get('SELECT * FROM goods WHERE goods_id = ?', o.goods_id);
  if (!g) return res.json(fail('商品不存在'));
  if (g.member_id !== m.member_id) return res.json(fail('您不是该商品持有人'));

  // 转拍时限：支付后 N 小时内可转拍（0 表示不限）
  const area = o.specialarea_id
    ? get('SELECT * FROM specialarea WHERE specialarea_id = ?', o.specialarea_id)
    : null;
  const limitHours = Number(area?.transposition_hours || 0);
  if (limitHours > 0 && o.pay_time) {
    const deadline = new Date(o.pay_time.replace(/-/g, '/')).getTime() + limitHours * 3600 * 1000;
    if (Date.now() > deadline) {
      return res.json(fail(`已超过转拍时限（支付后 ${limitHours} 小时内可转拍）`));
    }
  }

  // 上架费 = 本轮抢购金额 × 上架费率
  const q = quoteConsignment(o, g, price);
  const fee = q.listing_fee;
  const sellPrice = q.next_price;
  if (sellPrice <= 0) return res.json(fail('标价必须大于 0'));

  try {
    tx(() => {
      // 上架费（费率为 0 时不扣款、不写 0 元流水，否则会员流水里会出现无意义的 ¥0.00 记录）
      if (fee > 0) {
        const r1 = run(
          'UPDATE member SET amount = amount - ? WHERE member_id = ? AND amount >= ?',
          fee, m.member_id, fee,
        );
        if (Number(r1.changes) !== 1) throw biz(`余额不足以支付上架费 ¥${fee.toFixed(2)}`);
        run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
          m.member_id, -fee, 2, '转拍上架费', `订单 ${o.order_no} 上架费 ${fee.toFixed(2)}`, now());
      }

      // 原订单标记已寄卖
      run('UPDATE orders SET consignment_status = 10, listing_fee = ?, transposition_time = ? WHERE order_id = ?',
        fee, now(), o.order_id);

      // 商品重新上架，更新标价；划线价须高于现价，否则同步上调
      const curLine = Number(g.line_price || 0);
      const newLine = curLine > 0 && curLine <= sellPrice ? money2(sellPrice * 1.1) : curLine;
      // 转拍上架要落到「下一场」，而不是原地留在上一场（否则同一件商品永远只在前一场流转）
      const nextArea = nextSessionId(g.specialarea_id);
      run(
        `UPDATE goods SET goods_min_price = ?, line_price = ?, goods_status = 10, is_sell = 10,
           specialarea_id = ?, update_time = ?
         WHERE goods_id = ?`,
        sellPrice, newLine, nextArea || g.specialarea_id, now(), g.goods_id,
      );

      // 不再生成寄卖挂单：挂单信息已完整存在于「本订单的 consignment_status/listing_fee/transposition_time」
      // 与「goods 的持有人/标价/上下架」两处，另开一张 type=2 订单属于纯冗余（曾留下永不结清的僵尸单）
      log(o.order_id, '转拍上架', 'member',
        `标价 ${sellPrice}（上一手 ${q.prev_price}，涨价 ${q.increase_rate}% = ${q.increase_amount}），上架费 ${fee.toFixed(2)}，进入场次 #${nextArea || g.specialarea_id}`);
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok(
    { ...q, listing_fee: fee.toFixed(2), selling_price: sellPrice },
    `转拍成功，下一轮标价 ¥${sellPrice.toFixed(2)}（涨价 ${q.increase_rate}%）`,
  ));
});

// 拆分订单（把一单拆成多单）
r.post('/toSplitOrder', authMember, (req, res) => {
  const { order_id, num } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.num < 2) return res.json(fail('订单数量不足，无法拆分'));
  const n = Math.min(Number(num) || 1, o.num - 1);
  tx(() => {
    run('UPDATE orders SET num = num - ? WHERE order_id = ?', n, o.order_id);
    const no = orderNo('S');
    const info = run(
      `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
        type, price, num, total_price, service_charge, status, pay_status, create_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      no, o.member_id, o.seller_id, o.goods_id, o.goods_name, o.goods_thumb, o.specialarea_id,
      o.type, o.price, n, money2(o.price * n), serviceCharge(o.price * n), o.status, o.pay_status, now(),
    );
    log(o.order_id, '拆分订单', 'member', `拆出 ${n} 件`);
    log(Number(info.lastInsertRowid), '拆分生成', 'member');
  });
  res.json(ok([], '拆分成功'));
});

r.post('/upOrderStatus', authMember, (req, res) => {
  const { order_id, status } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  run('UPDATE orders SET status = ? WHERE order_id = ?', Number(status), o.order_id);
  res.json(ok([], '操作成功'));
});

// 举报（写入举报表，后台可审核）
r.post('/toOrderReport', authMember, (req, res) => {
  const { order_id, reason, content, images } = req.body;
  if (!reason) return res.json(fail('请先选择举报原因'));
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  run(
    `INSERT INTO order_report (order_id, member_id, target_id, goods_id, reason, content, images, status, create_time)
     VALUES (?,?,?,?,?,?,?,0,?)`,
    o.order_id, req.member.member_id, o.seller_id || 0, o.goods_id || 0,
    reason, content || '', images || '', now(),
  );
  res.json(ok([], '举报已提交，平台会尽快处理'));
});

r.get('/getOrderReport', authMember, (req, res) => {
  const { order_id } = req.query;
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  res.json(ok({ reasons: ['商品与描述不符', '卖家不发货', '价格欺诈', '虚假交易', '其他'] }));
});

// 评价
r.post('/evaluation', authMember, (req, res) => {
  const { order_id, content, rate } = req.body;
  if (!order_id) return res.json(fail('method param miss:order_id'));
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  log(o.order_id, '评价', 'member', `${rate || 5}星：${content || ''}`);
  res.json(ok([], '评价成功'));
});


// ---------------- 结算待办（差价匹配的付款/收款） ----------------
r.get('/mySettle', authMember, (req, res) => {
  const me = req.member.member_id;
  const pay = all(
    `SELECT sm.*, m.nick_name payee_name, m.mobile payee_mobile, m.pay_setting
     FROM settle_match sm LEFT JOIN member m ON m.member_id = sm.payee_id
     WHERE sm.payer_id = ? AND sm.pay_status < 20 ORDER BY sm.match_id DESC`,
    me,
  );
  const receive = all(
    `SELECT sm.*, m.nick_name payer_name, m.mobile payer_mobile
     FROM settle_match sm LEFT JOIN member m ON m.member_id = sm.payer_id
     WHERE sm.payee_id = ? AND sm.pay_status < 20 ORDER BY sm.match_id DESC`,
    me,
  );
  res.json(ok({ pay, receive }));
});

// 付款方上传转账凭证
r.post('/settleVoucher', authMember, (req, res) => {
  const { match_id, voucher } = req.body;
  if (!voucher) return res.json(fail('请上传付款凭证'));
  const m = get('SELECT * FROM settle_match WHERE match_id = ? AND payer_id = ?',
    Number(match_id), req.member.member_id);
  if (!m) return res.json(fail('付款单不存在'));
  if (m.pay_status === 20) return res.json(fail('该笔已完成'));
  run('UPDATE settle_match SET voucher = ?, pay_status = 10, pay_time = ? WHERE match_id = ?',
    voucher, now(), m.match_id);
  res.json(ok([], '凭证已提交，等待对方确认收款'));
});

// 收款方确认收款
r.post('/settleConfirm', authMember, (req, res) => {
  const { match_id } = req.body;
  const m = get('SELECT * FROM settle_match WHERE match_id = ? AND payee_id = ?',
    Number(match_id), req.member.member_id);
  if (!m) return res.json(fail('收款单不存在'));
  if (m.pay_status !== 10) return res.json(fail('对方尚未上传付款凭证'));
  if (m.pay_status === 20) return res.json(fail('该笔已确认'));
  run('UPDATE settle_match SET pay_status = 20, confirm_time = ? WHERE match_id = ?', now(), m.match_id);
  res.json(ok([], '已确认收款'));
});

export default r;
