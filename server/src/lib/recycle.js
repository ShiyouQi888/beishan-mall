// 系统回收：商品涨到「价格上限」后的自动结算
//
// 为什么需要它：
//   商品价格封顶后，持有人既不能再转拍（价格会突破上限），也没法把货卖出去 ——
//   等于花真金白银买了一件永远无法流通的标的，钱就死在手里。
//   所以到顶即由平台接盘：按「持有人买入价 + 一轮涨幅（转拍涨价率）」结算给他，
//   商品转为平台持仓（member_id = 0、下架、退出场次），后续由平台自行处置。
//
// 两条闸门（后台「交易设置」）：
//   recycle_open       到顶自动回收总开关（默认开）
//   recycle_daily_cap  每日回收总额上限（0 = 不限）；超出后只记「待处理」，不自动打款
import { all, get, run, tx, now, today } from '../db.js';
import { cfg, money, priceIncreaseRate } from './helper.js';
import { priceCapOf } from './priceCap.js';
import { setGoodsAreas } from './areaGoods.js';

const recycleEnabled = () => Number(cfg('recycle_open', '10')) === 10;
const dailyCapAmount = () => Math.max(0, Number(cfg('recycle_daily_cap', '0')) || 0);

/** 今天已结算的回收总额（用于日限额判断） */
function settledToday() {
  return Number(
    get(
      "SELECT IFNULL(SUM(recycle_price),0) v FROM goods_recycle WHERE status = 10 AND substr(IFNULL(settle_time, create_time),1,10) = ?",
      today(),
    )?.v || 0,
  );
}

/**
 * 找出「价格已到顶 + 仍在会员手里」的商品。
 * 挂牌中（10）与已下架（20）都算：到顶就意味着不能再转拍，继续挂着只会等来一个
 * 「买下就卡死」的接盘人（平台还得再赔一轮），所以到顶即退出流通。
 * 流拍（30）走流拍自己的平台回收流程，这里不碰。
 */
function findCappedGoods() {
  // SQL 只做粗筛，是否「到顶」交给 priceCapOf：封顶是金额围栏，
  // 判定看的是「下一轮涨幅会不会越界」，不是「当前价等于封顶价」。
  const rows = all(
    `SELECT g.* FROM goods g
     WHERE IFNULL(g.price_cap, 0) > 0
       AND IFNULL(g.member_id, 0) > 0
       AND g.goods_status IN (10, 20)
       AND NOT EXISTS (
         SELECT 1 FROM goods_recycle r
         WHERE r.goods_id = g.goods_id AND r.member_id = g.member_id
       )
     ORDER BY g.goods_id ASC`,
  );
  return rows.filter((g) => priceCapOf(g).reached);
}

/** 持有人买下这件货的那笔订单（唯一件才有意义） */
function holderOrderOf(g) {
  return get(
    `SELECT * FROM orders
     WHERE goods_id = ? AND member_id = ? AND type = 1 AND pay_status = 10 AND status <> 40
     ORDER BY order_id DESC LIMIT 1`,
    g.goods_id, g.member_id,
  );
}

/**
 * 结算一笔回收：给持有人打款 + 商品转平台持仓 + 记账 + 通知
 * @param {object} g 商品行
 * @param {object} o 持有人买入订单
 * @param {number} rate 结算涨幅（%）
 */
function settle(g, o, rate, remark = '') {
  const buyPrice = money(o?.total_price || g.goods_min_price);
  // 实际成本要含买家当时付的抢单服务费与转拍上架费（现在下单时一并收取）——
  // 只扣商品金额会把「持有人收益」报高，回收时平台等于按虚高的收益补差
  const buyCost = money(buyPrice + Number(o?.service_charge || 0) + Number(o?.listing_fee || 0));
  // 封顶价只是围栏：结算按商品「当前实际价格」接盘 ——
  //   · 刚买下（下架待转拍）的商品，当前价就是买入价 → 原价接盘（持有人净亏一笔服务费）
  //   · 已转拍挂牌的商品，当前价是持有人挂出的价 → 按挂牌价接盘，不白丢这一轮涨幅
  const recyclePrice = money(Number(g.goods_min_price) || buyPrice);
  const profit = money(recyclePrice - buyCost);
  const cap = priceCapOf(g);
  const t = now();
  let recycleId = 0;

  tx(() => {
    run('UPDATE member SET amount = amount + ? WHERE member_id = ?', recyclePrice, g.member_id);
    run(
      'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      g.member_id, recyclePrice, 2, '系统回收',
      `商品「${g.goods_name}」到顶回收：按当前实际价格 ${recyclePrice.toFixed(2)} 接盘（买入 ${buyPrice.toFixed(2)}），商品转平台持仓`,
      t,
    );
    // 商品转平台持仓：持有人置 0、下架、退出场次，避免继续挂在场次里被按上限价买走又卡一次
    run(
      // 打「封顶」标记：前台从此不再展示这件货，只有后台改回上架才会重新流通
      "UPDATE goods SET member_id = 0, goods_status = 20, is_sell = 0, recycled = 1, area_date = '', update_time = ? WHERE goods_id = ?",
      t, g.goods_id,
    );
    setGoodsAreas(g.goods_id, []);

    const info = run(
      `INSERT INTO goods_recycle (goods_id, order_id, member_id, goods_name, good_thumb,
        base_price, cap_price, buy_price, buy_cost, increase_rate, recycle_price, profit, status, remark, create_time, settle_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      g.goods_id, Number(o?.order_id) || 0, g.member_id, g.goods_name, g.good_thumb || '',
      cap.base_price, cap.cap_price, buyPrice, buyCost, rate, recyclePrice, profit, 10, remark, t, t,
    );
    recycleId = Number(info.lastInsertRowid);

    if (o?.order_id) {
      run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        o.order_id, '系统回收结算', 'system',
        `到顶回收：按当前实际价格 ${recyclePrice.toFixed(2)} 接盘（买入 ${buyPrice.toFixed(2)}）`, t);
    }
    run('INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
      g.member_id, '商品已到顶回收',
      `「${g.goods_name}」下一轮涨价会越过价格上限 ¥${cap.cap_price.toFixed(2)}，已停止转拍。平台按当前实际价格 ¥${recyclePrice.toFixed(2)} 接盘结算，款项已入余额。`,
      t);
  });

  return { recycle_id: recycleId, goods_id: g.goods_id, member_id: g.member_id, buy_price: buyPrice, recycle_price: recyclePrice, profit };
}

/** 记一笔「待处理」：开关关闭或超出日限额时用，商品保持原样等人处理 */
function markPending(g, o, rate, reason) {
  const buyPrice = money(o?.total_price || g.goods_min_price);
  const buyCost = money(buyPrice + Number(o?.service_charge || 0) + Number(o?.listing_fee || 0));
  const recyclePrice = money(Number(g.goods_min_price) || buyPrice);
  const cap = priceCapOf(g);
  const t = now();
  const info = run(
    `INSERT INTO goods_recycle (goods_id, order_id, member_id, goods_name, good_thumb,
      base_price, cap_price, buy_price, buy_cost, increase_rate, recycle_price, profit, status, remark, create_time, settle_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    g.goods_id, Number(o?.order_id) || 0, g.member_id, g.goods_name, g.good_thumb || '',
    cap.base_price, cap.cap_price, buyPrice, buyCost, rate, recyclePrice, money(recyclePrice - buyCost),
    20, reason, t, '',
  );
  return { recycle_id: Number(info.lastInsertRowid), goods_id: g.goods_id, pending: true, reason };
}

/**
 * 扫描并结算所有到顶商品
 * @param {{force?:boolean}} opt force=true 时忽略开关与日限额（后台手动结算单笔用不到这个）
 */
export function scanCappedGoods(opt = {}) {
  const rate = priceIncreaseRate();
  const list = findCappedGoods();
  const out = { scanned: list.length, settled: 0, pending: 0, skipped: 0, no_order: 0, paid: 0, items: [] };

  if (!list.length) return out;

  let todayTotal = settledToday();
  const enabled = opt.force || recycleEnabled();
  const dayLimit = dailyCapAmount();

  for (const g of list) {
    const o = holderOrderOf(g);
    if (!o) {
      // 没有买入订单（后台直接指派/历史数据）：算不出真实买入价，不能自动打款，
      // 按现价作为参考买入价落一条「待处理」，由运营核对后手动结算。
      markPending(g, null, rate, '缺少持有人买入订单：已按现价作为参考买入价，请核对后手动结算');
      out.pending++;
      out.no_order++;
      continue;
    }

    if (!enabled) {
      markPending(g, o, rate, '自动回收已关闭，待人工处理');
      out.pending++;
      continue;
    }
    const buyPrice = money(o.total_price || g.goods_min_price);
    const need = money(Number(g.goods_min_price) || buyPrice);
    if (dayLimit > 0 && todayTotal + need > dayLimit) {
      markPending(g, o, rate, `超出每日回收上限 ¥${dayLimit}，待人工处理`);
      out.pending++;
      continue;
    }

    const r = settle(g, o, rate);
    todayTotal = money(todayTotal + r.recycle_price);
    out.settled++;
    out.paid = money(out.paid + r.recycle_price);
    out.items.push(r);
  }
  return out;
}

/** 手动结算一条「待处理」回收单 */
export function settlePending(recycleId, operator = 'admin') {
  const rec = get('SELECT * FROM goods_recycle WHERE recycle_id = ?', Number(recycleId));
  if (!rec) return { ok: false, reason: '回收单不存在' };
  if (Number(rec.status) === 10) return { ok: false, reason: '该笔已结算' };

  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(rec.goods_id));
  if (!g) return { ok: false, reason: '商品不存在' };
  if (Number(g.member_id) !== Number(rec.member_id)) {
    return { ok: false, reason: '商品已不在原持有人名下（可能已被买走），无法按原单结算' };
  }

  const buyPrice = Number(rec.buy_price) || 0;
  // 老台账没有 buy_cost（迁移时按买入价回填过），这里再兜一次底
  const buyCost = Number(rec.buy_cost) > 0 ? Number(rec.buy_cost) : buyPrice;
  const recyclePrice = money(Number(rec.recycle_price) || Number(g.goods_min_price) || buyPrice);
  const profit = money(recyclePrice - buyCost);
  const t = now();

  tx(() => {
    run('UPDATE member SET amount = amount + ? WHERE member_id = ?', recyclePrice, rec.member_id);
    run(
      'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      rec.member_id, recyclePrice, 2, '系统回收',
      `补结算：商品「${rec.goods_name}」到顶回收，按当前实际价格 ${recyclePrice.toFixed(2)} 接盘`, t,
    );
    run(
      // 打「封顶」标记：前台从此不再展示这件货，只有后台改回上架才会重新流通
      "UPDATE goods SET member_id = 0, goods_status = 20, is_sell = 0, recycled = 1, area_date = '', update_time = ? WHERE goods_id = ?",
      t, g.goods_id,
    );
    setGoodsAreas(g.goods_id, []);
    run(
      'UPDATE goods_recycle SET status = 10, recycle_price = ?, profit = ?, remark = ?, settle_time = ? WHERE recycle_id = ?',
      recyclePrice, profit, `${rec.remark ? rec.remark + '；' : ''}${operator} 手动结算`, t, rec.recycle_id,
    );
    if (rec.order_id) {
      run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        rec.order_id, '系统回收结算', operator, `补结算回收价 ${recyclePrice.toFixed(2)}`, t);
    }
    run('INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
      rec.member_id, '商品已到顶回收',
      `「${rec.goods_name}」平台已按 ¥${recyclePrice.toFixed(2)} 接盘结算，款项已入余额。`, t);
  });

  return { ok: true, recycle_id: rec.recycle_id, recycle_price: recyclePrice, profit };
}

/** 给后台列表/看板用的汇总 */
export function recycleSummary() {
  const d = today();
  const t = get(
    "SELECT COUNT(*) c, IFNULL(SUM(recycle_price),0) v, IFNULL(SUM(profit),0) p FROM goods_recycle WHERE status = 10 AND substr(IFNULL(settle_time, create_time),1,10) = ?",
    d,
  );
  const pending = get('SELECT COUNT(*) c FROM goods_recycle WHERE status = 20');
  const total = get('SELECT COUNT(*) c, IFNULL(SUM(recycle_price),0) v FROM goods_recycle WHERE status = 10');
  return {
    today_count: Number(t?.c || 0),
    today_amount: money(t?.v || 0),
    today_profit: money(t?.p || 0),
    pending_count: Number(pending?.c || 0),
    total_count: Number(total?.c || 0),
    total_amount: money(total?.v || 0),
  };
}
