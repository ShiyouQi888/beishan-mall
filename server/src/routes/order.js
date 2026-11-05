import { Router } from 'express';
import { all, get, run, tx, now } from '../db.js';
import { ok, fail, authMember, page, money, cfg, calcServiceCharge, serviceChargeRate, priceIncreaseRate, calcNextPrice, assetUrl, ORDER_STATUS, ORDER_TYPE, orderStateText } from '../lib/helper.js';
import { orderNo } from '../lib/auth.js';
import { settleOrder, biz, calcListingFee, listingFeeRate, goodsStillOwnedBySeller } from '../lib/settle.js';
import { deductStock, restoreStock, isPieceSale } from '../lib/stock.js';
import { todayStr } from '../lib/sessionWindow.js';
import { nextSlot } from '../lib/sessions.js';
import { areasOfGoods, openAreaOf, displayAreaOf, setGoodsAreas, advanceLeadOf } from '../lib/areaGoods.js';
import { sessionBoughtOf, sessionLimitOf } from '../lib/purchaseLimit.js';
import { priceCapOf, clampToCap } from '../lib/priceCap.js';
import { orderGoods, orderGoodsId } from '../lib/orderAssets.js';

const r = Router();

const money2 = (n) => Number(Number(n).toFixed(2));

function fmtOrder(o) {
  const g = orderGoods(o);
  const thumb = o.goods_thumb || g?.good_thumb || '';
  // 买家已把这件货转拍给别人（商品现持有人不再是他）→ 不会再有发货/收货环节
  const transferred = Number(o.type) === 1 && Number(o.pay_status) === 10 && !!g
    && Number(g.member_id) !== Number(o.member_id);
  return {
    order_id: o.order_id,
    order_no: o.order_no,
    order_type: o.type,
    order_type_text: ORDER_TYPE[o.type] || '',
    goods_id: o.goods_id,
    owned_goods_id: orderGoodsId(o),
    goods_name: o.goods_name,
    goods_thumb: assetUrl(thumb),
    price: Number(o.price).toFixed(2),
    num: o.num,
    total_price: Number(o.total_price).toFixed(2),
    service_charge: Number(o.service_charge || 0).toFixed(2),
    // 转拍上架费：下单时随货款一起收的。白名单漏了这个字段，
    // H5 订单列表/详情就算前端算好了「实付 = 货款 + 服务费 + 上架费」也永远减不出上架费。
    listing_fee: Number(o.listing_fee || 0).toFixed(2),
    status: o.status,
    // 没有支付与发货环节：看平台确认没确认；已取消的必须单独标出来，
    // 否则会员取消后订单在列表里仍显示「待确认」，看起来像没生效
    status_text: orderStateText(o, true),
    transferred: transferred ? 1 : 0,
    pay_status: o.pay_status,
    consignment_status: o.consignment_status,
    is_examine: o.is_examine,
    create_time: o.create_time,
    pay_time: o.pay_time,
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

/** 「申请抢单」这笔动作是否已经登记过（幂等判据，H5 与后台共用） */
const APPLY_ACTION = '申请抢单';
const hasApplied = (orderId) =>
  !!get('SELECT log_id FROM order_log WHERE order_id = ? AND action = ? ORDER BY log_id LIMIT 1', orderId, APPLY_ACTION);

/** 批量算一批订单有没有申请过，避免列表页逐行查一次（N+1） */
function appliedIdSet(orderIds) {
  const ids = orderIds.filter((id) => Number.isInteger(Number(id)) && Number(id) > 0).map(Number);
  if (!ids.length) return new Set();
  const rows = all(
    `SELECT DISTINCT order_id FROM order_log WHERE action = ? AND order_id IN (${ids.map(() => '?').join(',')})`,
    APPLY_ACTION, ...ids,
  );
  return new Set(rows.map((r) => Number(r.order_id)));
}

/** 服务费计算：按订单总额算（与下单写入同一口径，见 lib/helper.js calcServiceCharge） */
function serviceCharge(amount) {
  return calcServiceCharge(amount);
}

// ---------------- 下单（抢购） ----------------
/**
 * 后台「库存」填成 >1 的抢购商品，运营的预期就是「这个价有一批货，抢一个减一个」。
 * 这类商品在数据上要有「初始名额」——只靠 stock_num 判断不出来，它卖着卖着也会变成 0/1。
 *
 * 这里只补 stock_total（名额），不动价格与在售状态：
 * 拆分是「一件货按份定价」的另一种玩法，跟「这批货能卖几次」是两件事，混用字段
 * 会让后台显示成「已拆分」、H5 显示「拆分为 100 份」，运营看到一脸懵。
 * @returns {object} 补齐名额之后的最新商品行
 */
function ensureStockTotal(g) {
  const total = Number(g.stock_total) || 0;
  const stock = Number(g.stock_num) || 0;
  if (total >= stock) return g;                                    // 名额已经覆盖库存，不用动

  // 带 stock_total < ? 的条件，两个并发请求同时进来也只会改一次
  run(
    'UPDATE goods SET stock_total = ?, update_time = ? WHERE goods_id = ? AND IFNULL(stock_total, 0) < ?',
    stock, now(), g.goods_id, stock,
  );
  return get('SELECT * FROM goods WHERE goods_id = ?', g.goods_id);
}

r.post('/toAddOrder', authMember, (req, res) => {
  const { goods_id, num = 1, address_id, remark } = req.body;
  const m = req.member;
  // 支付环节已整体下线：下单只是登记一笔「抢单申请」，付不付、怎么付由平台线下确认。
  // pay_type 固定写 0，历史数据里的 1~4 仅作留档，不再有任何代码读它。
  if (!goods_id) return res.json(fail('请选择商品'));
  let g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  g = ensureStockTotal(g);
  if (g.goods_status !== 10) return res.json(fail('商品已下架'));
  if (g.member_id === m.member_id) return res.json(fail('不能购买自己持有的商品'));
  // 场次日期：轮转到明天的商品，今天不能提前抢
  const today = todayStr();
  if (g.area_date && g.area_date > today) {
    return res.json(fail(`该商品将在 ${g.area_date} 的场次开抢`));
  }

  // 数量必须在服务端收死：负数会让总额为负，支付时变成「余额加钱」；小数/NaN 会污染金额与库存
  const numInt = Number(num);
  if (!Number.isInteger(numInt) || numInt < 1) return res.json(fail('购买数量必须是不小于 1 的整数'));
  if (numInt !== 1) {
    // 一件商品就是一个标的，同一个人只可能持有一件：一次买多件没有业务含义，
    // 而且会让「每人每场限购」的口径变得含糊（按件还是按商品）。前台本来也没有数量选择器。
    return res.json(fail('每件商品每人限购 1 件，不能一次购买多件'));
  }
  if (isPieceSale(g) && numInt > Number(g.stock_num || 0)) {
    // 拆分商品按「份」卖，一批货按「名额」卖，提示文案要跟着走，不然用户看不懂
    return res.json(fail(`只剩 ${Number(g.stock_num) || 0} 个名额了`));
  }

  // 同一个商品，同一个人只能买一次（终身）。已取消的不算，取消后可以重新抢。
  // 「不能购买自己持有的商品」只能挡住当前持有人，挡不住「前几天买过、后来转拍出去了」的情况。
  const everBought = Number(get(
    'SELECT IFNULL(SUM(num), 0) n FROM orders WHERE member_id = ? AND (goods_id = ? OR asset_goods_id = ?) AND type = 1 AND status <> 40',
    m.member_id, g.goods_id, g.goods_id,
  )?.n) || 0;
  if (everBought > 0) {
    return res.json(fail('这件商品你已经买过了，同一件货每人只能买一次'));
  }

  // 场次校验：商品与场次是多对多，只要其中一场正在开放就能下单。
  // 一件商品都没关联场次时，它属于「随时可买」，不受场次时间约束。
  const areas = areasOfGoods(g.goods_id);
  let orderArea = null;
  // 这一单是不是靠「提前抢购」资格进来的（决定要不要扣次数）
  let isAdvanced = false;
  if (areas.length) {
    // 提前抢购：开通了资格的会员（且填了提前分钟数）可以先把场次「往前放」lead 秒。
    // 只提前开始，不推迟结束 —— 12:00 之后照样买不了。
    const lead = advanceLeadOf(m);
    const opened = openAreaOf(areas, new Date(), lead);
    if (!opened) {
      // 场次整体被后台停用：跟「时间没到 / 已结束」区分开，否则运营排查时会以为配错了时段
      if (areas.every((a) => Number(a.is_open ?? 10) !== 10)) {
        return res.json(fail('该商品所在场次已停用，暂不可购买'));
      }
      // 给出最贴近的提示：今天不开放 / 还没到时间 / 今天已经结束
      const shown = displayAreaOf(areas);
      const w = shown.w;
      if (!w.dayOk) return res.json(fail(`今日未开放该场次（开放：${w.daysText}）`));
      if (w.state === 'upcoming') return res.json(fail(`当前不在抢购时间内（${w.text} 开抢）`));
      return res.json(fail(`该商品所在场次已结束（${w.text}）`));
    }
    orderArea = opened.area;
    isAdvanced = Boolean(opened.advanced);
    // 限购：**本场次**每人合计多少件（不同商品合并算），不是「每个商品各算各的」。
    // 见 lib/purchaseLimit.js —— 场次每天重复开放，所以还要按日期切分。
    const limit = sessionLimitOf(orderArea);
    if (limit > 0) {
      const bought = sessionBoughtOf(m.member_id, orderArea.specialarea_id);
      if (bought + numInt > limit) {
        return res.json(fail(bought > 0
          ? `本场每人限购 ${limit} 件，你已抢 ${bought} 件，本场还能再抢 ${Math.max(0, limit - bought)} 件`
          : `本场每人限购 ${limit} 件`));
      }
    }
  }

  // 锁单：唯一一件货（名额=1）同一时刻只能有一笔「待付款」订单占着。
  // 提交订单就算锁住，别人连下单都下不了 —— 否则两个人同时下单、先付先得，
  // 后付的那位钱被扣了却发现货没了。按件出售的一批货不锁，那本来就是「抢一个减一个」。
  if (!isPieceSale(g)) {
    const locked = get(
      `SELECT order_id, order_no, member_id FROM orders
       WHERE goods_id = ? AND type = 1 AND IFNULL(status, 0) = 0 AND IFNULL(pay_status, 0) = 0
       ORDER BY order_id DESC LIMIT 1`,
      g.goods_id,
    );
    if (locked) {
      return res.json(fail(Number(locked.member_id) === Number(m.member_id)
        ? '你已经下过单了，请先取消这笔订单再重新抢'
        : '这件货刚被别人抢先锁定，等他取消或超时后可以再抢'));
    }
  }

  const price = Number(g.goods_min_price);
  const total = money2(price * numInt);
  // 抢单服务费：按「商品总额 × 后台配置费率」计算，由买家额外承担，卖家仍收全额货款。
  // 后台「交易设置 → 抢单服务费(%)」默认 0 —— 与原站实证一致（抢购环节平台不收费，
  // 平台收入来自转拍上架费）；配了费率才收。
  const fee = calcServiceCharge(total);
  // 转拍上架费：原来要等转拍上架时再从余额扣，余额不够就转不了拍（货卡死在手里）。
  // 现在下单时一并计入应付，转拍时不再重复收取；金额按本单总额 × 上架费率预估，
  // 与实际转拍时的收取基数一致（转拍按「上一手成交价」算，本单就是那一手）。
  const listingFee = calcListingFee(total);
  const no = orderNo('Q');

  let orderId;
  try {
    tx(() => {
      // 一批货需要扣名额（原子扣减，不足则拒单）；唯一一件货不动库存
      if (isPieceSale(g)) {
        if (!deductStock(g.goods_id, numInt)) throw biz(`数量不足，只剩 ${g.stock_num} 个名额`);
      }
      const info = run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
          type, price, num, total_price, service_charge, listing_fee, status, pay_status, pay_type, address_id, remark, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        no, m.member_id, g.member_id, g.goods_id, g.goods_name, g.good_thumb,
        orderArea ? Number(orderArea.specialarea_id) : 0,
        1, price, numInt, total, fee, listingFee, 0, 0, 0, Number(address_id) || 0, remark || '', now(),
      );
      orderId = Number(info.lastInsertRowid);

      // 提前抢购按次计：只有「真的在提前窗口内下单」才扣次数。
      // 0 表示不限次数（后台默认），扣到 0 时写成 -1，表示额度已用完。
      if (isAdvanced && Number(m.advance_count) > 0) {
        const left = Number(m.advance_count) - 1;
        run('UPDATE member SET advance_count = ? WHERE member_id = ?', left > 0 ? left : -1, m.member_id);
      }
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  log(orderId, '创建订单', 'member', `${g.goods_name} × ${num}`);
  res.json(ok({
    order_id: orderId, order_no: no, total_price: total, service_charge: fee, listing_fee: listingFee,
  }, '下单成功'));
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

// ---------------- 申请抢单（支付环节已整体下线） ----------------
// 这套玩法从来没有在线支付：会员提交的是「抢单申请」，平台线下收款后在后台点确认。
// 余额支付、微信/支付宝、线下凭证上传都已删除，只留这一个动作。
function applyOrder(req, res) {
  const { order_id } = req.body || {};
  const m = req.member;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), m.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (Number(o.pay_status) === 10) return res.json(fail('订单已确认，无需再申请'));
  if (Number(o.status) === 40) return res.json(fail('订单已取消，不能再申请抢单'));
  // 幂等：退出重进再点、网络慢连点两下，都不该在日志里刷出一串「申请抢单」，
  // 否则后台看到的动态会失真
  if (hasApplied(o.order_id)) {
    return res.json(ok({ applied: 1 }, '这笔订单已经提交过抢单申请，请等待平台确认'));
  }
  log(o.order_id, '申请抢单', 'member', '已提交平台，等待确认');
  res.json(ok({ applied: 1 }, '已提交抢单申请，等待平台确认'));
}

r.post('/apply', authMember, applyOrder);

// 兼容旧版 H5：缓存里的页面还在调 /toPay，并且带 pay_type:0。
// 这里只放行「申请抢单」，任何支付方式一律拒绝 —— 免得老页面以为还能付款。
r.post('/toPay', authMember, (req, res) => {
  const pt = Number(req.body?.pay_type ?? 0);
  if (pt > 0) return res.json(fail('支付功能已下线，提交申请后由平台确认收款'));
  req.body = { order_id: req.body?.order_id };
  return applyOrder(req, res);
});

// 结算与分账逻辑见 lib/settle.js（与后台确认收款共用）

// ---------------- 订单列表 ----------------
r.get('/getOrder', authMember, (req, res) => {
  const { status, pay_status, dataType, order_id, page: p = 1, limit = 10 } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  const where = ['member_id = ?'];
  const args = [req.member.member_id];
  if (order_id !== undefined && order_id !== '') {
    const id = Number(order_id);
    if (!Number.isInteger(id) || id <= 0) return res.json(fail('订单编号无效'));
    where.push('order_id = ?');
    args.push(id);
  }
  if (status !== undefined && status !== '' && status !== 'all') {
    where.push('status = ?');
    args.push(Number(status));
  }
  // 会员端订单页现在只看付没付
  if (pay_status !== undefined && pay_status !== '' && pay_status !== 'all') {
    where.push('pay_status = ?');
    args.push(Number(pay_status));
  }
  if (dataType && dataType !== 'all') {
    where.push('type = ?');
    args.push(Number(dataType));
  }
  const w = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM orders WHERE ${w}`, ...args).c;
  const list = all(`SELECT * FROM orders WHERE ${w} ORDER BY order_id DESC LIMIT ? OFFSET ?`, ...args, pp, (cur - 1) * pp);
  const applied = appliedIdSet(list.map((o) => o.order_id));

  // 「我转出的订单」：后台把单转给别人后，这笔单在列表里会凭空消失，会员第一反应是「我的订单没了」。
  // 只在「全部」第一页补几条只读记录 —— 不动分页与各 tab 的语义，转出量本来就少（只有后台操作才产生）。
  let outList = [];
  const noFilter = (v) => v === undefined || v === '' || v === 'all';
  if (!order_id && noFilter(status) && noFilter(pay_status) && noFilter(dataType) && cur === 1) {
    const mine = new Set(list.map((o) => Number(o.order_id)));
    outList = all(
      `SELECT t.order_id, t.to_member_id, t.create_time AS transfer_time
         FROM order_transfer t
         JOIN (SELECT order_id, MAX(transfer_id) mid FROM order_transfer
                WHERE from_member_id = ? GROUP BY order_id) x ON x.mid = t.transfer_id
        ORDER BY t.transfer_id DESC LIMIT 20`,
      req.member.member_id,
    )
      // 又转回自己名下的不重复展示（那是正常订单）
      .filter((t) => !mine.has(Number(t.order_id)))
      .map((t) => {
        const o = get('SELECT * FROM orders WHERE order_id = ?', t.order_id);
        if (!o) return null;
        const to = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', t.to_member_id);
        return {
          ...fmtOrder(o),
          // 已转出：订单不再属于他，任何操作都不该出现
          transferred_out: 1,
          transferred: 0,
          status_text: '已转出',
          transfer_time: t.transfer_time,
          out_to_name: to?.nick_name || '',
          // 手机号打码：受让方是谁，原买家只需要能认出来，不需要完整号码
          out_to_mobile: String(to?.mobile || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
          applied: 0,
        };
      })
      .filter(Boolean);
  }

  const data = list.map((o) => ({ ...fmtOrder(o), applied: applied.has(Number(o.order_id)) ? 1 : 0, transferred_out: 0 }));
  res.json(ok(page([...data, ...outList], total + outList.length, cur, pp)));
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
  const logs = all('SELECT * FROM order_log WHERE order_id = ? ORDER BY log_id', o.order_id);
  res.json(ok({
    ...fmtOrder(o),
    address: addr,
    // H5 靠这个字段把「申请抢单」按钮置灰，避免退出重进后重复提交
    applied: logs.some((l) => l.action === APPLY_ACTION) ? 1 : 0,
    logs,
  }));
});

// 订单状态流转：取消 / 确认收货
r.post('/cancel', authMember, (req, res) => {
  const { order_id } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.status !== 0) return res.json(fail('当前状态不可取消'));
  // cancel_by 记来源：后台要能区分「会员自己撤回」和「运营取消」
  run('UPDATE orders SET status = 40, cancel_by = 1 WHERE order_id = ?', o.order_id);
  // 拆分商品的下单时就扣了份数，取消要把份额还回去，否则没付款的单也会一直占着库存
  restoreStock(o.goods_id, o.num);
  log(o.order_id, '订单取消', 'member');
  res.json(ok([], '已取消'));
});

/**
 * 转拍定价（单一口径）：
 *   下一轮标价 = 上一手成交价 × (1 + 涨价率)，逐轮复利 10000 → 10300 → 10609
 *   下一轮买家付 10300，上一手持有人收回 10300 全额（原价 + 涨价），此后与原持有人再无关系
 * 涨价率 > 0 时完全由服务端定价，忽略前端传入的价格（防止篡改）。
 */
function quoteConsignment(o, g, clientPrice) {
  const prevPrice = money2(o.total_price);
  // 买家实付 = 商品金额 + 抢单服务费 + 转拍上架费（下单时已预付）。
  // 算套利时这三笔都是成本：只扣商品金额会把利润算高
  // （9800 买、10094 卖，实际只赚 98，不是 294）。
  const prevService = money2(Number(o.service_charge) || 0);
  // 上架费在下单那一刻就定了，订单上记多少就是多少。
  // 绝不按「当前费率」重算 —— 运营中途把费率从 0 调到 2.8%，会员手里那些
  // 下单时根本没付过这笔钱的货就会被凭空追缴，余额不够还直接卡死
  // （货在他手上、转不了拍、也退不掉）。
  const prepaid = money2(Number(o.listing_fee) || 0);
  const prevCost = money2(prevPrice + prevService + prepaid);
  const rate = priceIncreaseRate();
  const cap = priceCapOf(g);
  const raw = rate > 0
    ? calcNextPrice(prevPrice)
    : (Number(clientPrice) > 0 ? money2(clientPrice) : money2(g.goods_min_price));
  // 兜底：如果因为改配置/手工改价导致这一轮会越过围栏，压到围栏价（正常已被 reached 拦下）
  const nextPrice = clampToCap(raw, cap);
  return {
    prev_price: prevPrice,
    prev_service_charge: prevService,
    prev_cost: prevCost,
    increase_rate: rate,
    increase_amount: money2(nextPrice - prevPrice),
    next_price: nextPrice,
    // 这一手实际付过的上架费（下单时随货款收的；历史订单为 0，转拍也不再补收）
    listing_fee: prepaid,
    // 持有人的实际套利 = 下一轮收回价 − 上一手实际成本（货款 + 服务费 + 上架费）
    net_income: money2(nextPrice - prevCost),
    // 前端据此决定「上架费」是显示「下单时已付」，还是「本次不收取」
    listing_fee_prepaid: prepaid > 0 ? 1 : 0,
    // 价格水位（供前端展示「还能涨多少」）
    base_price: cap.base_price,
    cap_price: cap.cap_price,
    increase_pct: cap.pct,
    headroom: cap.headroom,
    capped: cap.cap_price > 0 && nextPrice >= cap.cap_price,
  };
}

/** 超过价格上限的提示文案（报价与转拍共用） */
const capReachedMsg = (cap) =>
  `该商品已达价格上限 ¥${cap.cap_price.toFixed(2)}（当前 ¥${cap.current.toFixed(2)}，基准价 ¥${cap.base_price.toFixed(2)}），不能再转拍；系统会自动回收结算，款项将退回余额`;

/** 转拍报价（H5 展示用，不落库） */
r.get('/getConsignmentQuote', authMember, (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return res.json(fail('method param miss:order_id'));
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  if (o.consignment_status === 10) return res.json(fail('该订单已转拍上架'));
  const g = orderGoods(o);
  if (!g) return res.json(fail('商品不存在'));
  if (isPieceSale(g)) return res.json(fail('该订单尚未生成独立货权，请联系平台处理'));
  const cap = priceCapOf(g);
  if (cap.reached) return res.json(fail(capReachedMsg(cap)));
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

  const g = orderGoods(o);
  if (!g) return res.json(fail('商品不存在'));
  if (isPieceSale(g)) return res.json(fail('该订单尚未生成独立货权，请联系平台处理'));
  if (g.member_id !== m.member_id) return res.json(fail('您不是该商品持有人'));

  // 价格上限：到顶后不再允许挂出，否则下一轮价格会突破上限，上限就形同虚设
  const capNow = priceCapOf(g);
  if (capNow.reached) return res.json(fail(capReachedMsg(capNow)));

  // 转拍时限：支付后 N 小时内建议转拍（0 表示不限）
  //
  // 这里是「软时限」：超时**不拦**，只在订单日志上记一笔「超时挂牌」。
  // 为什么不再硬拦：货已经在他手上，超时后如果连挂牌都不允许，这件货就永久死在他手里
  // （下架、卖不掉、也不能转拍），平台还得背这个投诉。真正的约束交给运营看日志去催。
  const area = o.specialarea_id
    ? get('SELECT * FROM specialarea WHERE specialarea_id = ?', o.specialarea_id)
    : null;
  const limitHours = Number(area?.transposition_hours || 0);
  let overdue = false;
  if (limitHours > 0 && o.pay_time) {
    const deadline = new Date(o.pay_time.replace(/-/g, '/')).getTime() + limitHours * 3600 * 1000;
    overdue = Date.now() > deadline;
  }

  // 上架费只在下单时收一次，这里一分钱都不再扣。
  // 原来「老订单在转拍时补扣」的分支已删除：那个分支有三个坑 ——
  //   1. 运营中途改费率，会员手里没付过这笔钱的货被凭空追缴；
  //   2. 余额不够直接报错，货卡死在手上（转不了拍、也退不掉）；
  //   3. 扣成功后把金额写回订单，财务统计会把「刚收到的钱」重复计一次。
  const q = quoteConsignment(o, g, price);
  const sellPrice = q.next_price;
  if (sellPrice <= 0) return res.json(fail('标价必须大于 0'));

  try {
    tx(() => {
      // 原订单标记已寄卖；listing_fee 保持下单时的实收值，绝不覆盖
      run('UPDATE orders SET consignment_status = 10, transposition_time = ? WHERE order_id = ?',
        now(), o.order_id);

      // 商品重新上架，更新标价；划线价须高于现价，否则同步上调
      const curLine = Number(g.line_price || 0);
      const newLine = curLine > 0 && curLine <= sellPrice ? money2(sellPrice * 1.1) : curLine;
      // 转拍上架要落到「下一场」：以本单成交的场次为起点往后走，当天最后一场之后顺延到第二天第一场。
      // 商品可能同时挂在多个场次，转拍是一次全新的挂牌 —— 只保留下一场这一条关联，
      // 新的挂牌因此有唯一确定的场次（否则同一件货会在旧场次里被按旧价再抢一次）。
      const slot = nextSlot(o.specialarea_id || g.specialarea_id, g.area_date);
      const nextArea = slot ? slot.area_id : 0;
      const nextDate = slot ? slot.date : g.area_date || '';
      run(
        `UPDATE goods SET goods_min_price = ?, line_price = ?, goods_status = 10, is_sell = 10,
           area_date = ?, update_time = ?
         WHERE goods_id = ?`,
        sellPrice, newLine, nextDate, now(), g.goods_id,
      );
      // 关联表是唯一数据源：覆盖成「下一场」，镜像列由 setGoodsAreas 同步
      setGoodsAreas(g.goods_id, slot ? [slot.area_id] : []);

      // 不再生成寄卖挂单：挂单信息已完整存在于「本订单的 consignment_status/listing_fee/transposition_time」
      // 与「goods 的持有人/标价/上下架」两处，另开一张 type=2 订单属于纯冗余（曾留下永不结清的僵尸单）
      log(o.order_id, '转拍上架', 'member',
        `${overdue ? `（超时挂牌：支付后已超过 ${limitHours} 小时）` : ''}标价 ${sellPrice}（上一手 ${q.prev_price}，涨价 ${q.increase_rate}% = ${q.increase_amount}），上架费 ${q.listing_fee.toFixed(2)}（下单时已付），进入场次 #${nextArea}${nextDate ? `（${nextDate}）` : ''}`);
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok(
    { ...q, listing_fee: q.listing_fee.toFixed(2), selling_price: sellPrice },
    `转拍成功，下一轮标价 ¥${sellPrice.toFixed(2)}（涨价 ${q.increase_rate}%）`,
  ));
});

// 原 /upOrderStatus：直接写 orders.status，任何登录会员都能把订单改成任意状态（含伪装成已成交），
// 且前台早已改用 /order/receipt 与 /order/cancel（带状态校验），故删除。


// 评价
r.post('/evaluation', authMember, (req, res) => {
  const { order_id, content, rate } = req.body;
  if (!order_id) return res.json(fail('method param miss:order_id'));
  const o = get('SELECT * FROM orders WHERE order_id = ? AND member_id = ?', Number(order_id), req.member.member_id);
  if (!o) return res.json(fail('订单不存在'));
  log(o.order_id, '评价', 'member', `${rate || 5}星：${content || ''}`);
  res.json(ok([], '评价成功'));
});


// ---------------- 会员间结算待办：已下线 ----------------
// 原来这里有 mySettle / settleVoucher / settleConfirm，用于「差价匹配」生成的付款单。
// 但成交流程早已改为即时入账（付款时卖家当场到账），这套会员间付款会重复收钱，
// 前台页面与后台生成入口都已移除，接口一并删除。

export default r;
