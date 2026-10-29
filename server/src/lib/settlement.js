// 场次结算：差价匹配（对齐原站「大账/中账/小账」机制）
//
// 原站机制（依据同款系统公开说明 + 本站中账数据实证）：
//   1. 场次结束后，统计每个会员在该场次的「买入总额」与「卖出总额」
//   2. 差额 balance = 卖出 − 买入（正=应收，负=应付）
//   3. 把应付方与应收方做差价匹配，生成「匹配付款单」
//   4. 买家线下转账 → 上传凭证 → 卖家确认收款
//
// 平台不碰资金流，收入只有转拍上架费。
import { all, get, run, now } from '../db.js';

const money2 = (n) => Number(Number(n).toFixed(2));

/**
 * 执行一次场次结算
 * @param {number} specialareaId 场次ID（0 = 全部场次）
 * @param {string} date 结算日期 YYYY-MM-DD（空 = 今天）
 */
export function runSettlement(specialareaId = 0, date = '') {
  const day = date || now().slice(0, 10);
  const from = `${day} 00:00:00`;
  const to = `${day} 23:59:59`;

  // 取该场次当日的已支付订单（含买卖双方）
  // type=2 是早期「寄卖挂单」的历史数据，只作台账、不代表真实成交，
  // 显式排除以免同一笔卖出被「挂单 + 成交单」重复计入
  const where = ['type <> 2', 'status >= 10', 'status <> 40', 'create_time >= ?', 'create_time <= ?'];
  const args = [from, to];
  if (specialareaId) {
    where.push('specialarea_id = ?');
    args.push(specialareaId);
  }
  const orders = all(`SELECT * FROM orders WHERE ${where.join(' AND ')}`, ...args);

  if (!orders.length) return { ok: false, reason: '该场次当日没有可结算订单' };

  // 汇总每个会员的买入 / 卖出
  const acc = new Map();
  const pick = (id) => {
    if (!acc.has(id)) {
      acc.set(id, { member_id: id, buy: 0, sell: 0, fee: 0, buyIds: [], sellIds: [] });
    }
    return acc.get(id);
  };

  for (const o of orders) {
    // 买家侧：买单
    if (o.member_id) {
      const a = pick(o.member_id);
      a.buy = money2(a.buy + Number(o.total_price));
      a.buyIds.push(o.order_id);
      a.fee = money2(a.fee + Number(o.listing_fee || 0));
    }
    // 卖家侧：卖单
    if (o.seller_id && o.seller_id !== o.member_id) {
      const a = pick(o.seller_id);
      a.sell = money2(a.sell + Number(o.total_price));
      a.sellIds.push(o.order_id);
    }
  }

  const rate = Number(get("SELECT `value` v FROM setting_config WHERE `key`='listing_fee_rate'")?.v || 0);
  const list = [...acc.values()].map((a) => ({
    ...a,
    balance: money2(a.sell - a.buy),
  }));

  const totalBuy = list.reduce((s, x) => s + x.buy, 0);
  const totalSell = list.reduce((s, x) => s + x.sell, 0);
  const totalFee = list.reduce((s, x) => s + x.fee, 0);

  // 建批次
  const info = run(
    `INSERT INTO settle_batch (specialarea_id, batch_date, total_buy, total_sell, total_fee,
      member_count, status, create_time) VALUES (?,?,?,?,?,?,?,?)`,
    specialareaId, day, money2(totalBuy), money2(totalSell), money2(totalFee), list.length, 0, now(),
  );
  const batchId = Number(info.lastInsertRowid);

  // 写中账
  for (const x of list) {
    run(
      `INSERT INTO settle_account (batch_id, member_id, buy_amount, consignment_amount, listing_fee_amount,
        listing_fee_percentage, coupon_reward, balance, buy_order_ids, sell_order_ids, create_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      batchId, x.member_id, x.buy, x.sell, x.fee, rate, 0, x.balance,
      x.buyIds.join(','), x.sellIds.join(','), now(),
    );
  }

  // 差价匹配：应付方（balance<0）与应收方（balance>0）两两配对
  const matches = matchBalances(list, batchId);

  run('UPDATE settle_batch SET status = 10 WHERE batch_id = ?', batchId);

  return {
    ok: true,
    batch_id: batchId,
    batch_date: day,
    member_count: list.length,
    total_buy: money2(totalBuy),
    total_sell: money2(totalSell),
    total_fee: money2(totalFee),
    match_count: matches.length,
  };
}

/**
 * 差价匹配（贪心配对）
 * 应付方按欠款从大到小，应收方按应收从大到小，依次抵消
 */
function matchBalances(list, batchId) {
  const debtors = list
    .filter((x) => x.balance < -0.01)
    .map((x) => ({ id: x.member_id, amount: money2(-x.balance) }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = list
    .filter((x) => x.balance > 0.01)
    .map((x) => ({ id: x.member_id, amount: money2(x.balance) }))
    .sort((a, b) => b.amount - a.amount);

  const out = [];
  let di = 0;
  let ci = 0;
  let guard = 0;
  while (di < debtors.length && ci < creditors.length && guard < 10000) {
    guard++;
    const d = debtors[di];
    const c = creditors[ci];
    const amt = money2(Math.min(d.amount, c.amount));
    if (amt > 0.01) {
      run(
        `INSERT INTO settle_match (batch_id, payer_id, payee_id, amount, pay_status, create_time)
         VALUES (?,?,?,?,0,?)`,
        batchId, d.id, c.id, amt, now(),
      );
      out.push({ payer_id: d.id, payee_id: c.id, amount: amt });
    }
    d.amount = money2(d.amount - amt);
    c.amount = money2(c.amount - amt);
    if (d.amount <= 0.01) di++;
    if (c.amount <= 0.01) ci++;
  }
  return out;
}
