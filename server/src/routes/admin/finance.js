// 财务大盘：收入 / 支出 / 净利 / 负债 / 缺口 / 风险
import { Router } from 'express';
import { all, get } from '../../db.js';
import { ok, authAdmin, money, cfg } from '../../lib/helper.js';

const r = Router();

const num = (v) => money(Number(v || 0));
const today = () => new Date().toISOString().slice(0, 10);

/**
 * 口径说明（写进接口里，前端直接展示，避免各页面口径不一）：
 *   经营收入 = 抢单服务费（orders.service_charge，已支付）+ 转拍上架费（orders.listing_fee）
 *   经营支出 = 直推奖（finance_energy type=1）
 *   经营净利 = 收入 − 支出
 *   回收支出 = 平台回收付给会员的钱（资产转换，不计入经营损益，单列）
 *   现金净流 = 经营净利 − 回收支出
 *   会员负债 = 会员余额合计 + 可提现佣金合计（平台需要兑付的钱）
 */
function rangeStats(from, to) {
  const o = get(
    `SELECT COUNT(*) c,
            IFNULL(SUM(total_price),0) gmv,
            IFNULL(SUM(service_charge),0) svc,
            IFNULL(SUM(listing_fee),0) listing
     FROM orders
     WHERE pay_status = 10 AND status <> 40 AND create_time >= ? AND create_time <= ?`,
    from, to,
  ) || {};
  const award = get(
    `SELECT IFNULL(SUM(face_value),0) v FROM finance_energy
     WHERE type = 1 AND create_time >= ? AND create_time <= ?`,
    from, to,
  )?.v;
  const recycle = get(
    `SELECT IFNULL(SUM(face_value),0) v FROM finance_energy
     WHERE type_name = '平台回收' AND create_time >= ? AND create_time <= ?`,
    from, to,
  )?.v;
  const withdraw = get(
    `SELECT IFNULL(SUM(amount),0) v FROM finance_withdraw
     WHERE status = 10 AND create_time >= ? AND create_time <= ?`,
    from, to,
  )?.v;

  const service_fee = num(o.svc);
  const listing_fee = num(o.listing);
  const drive_award = num(award);
  const recycle_cost = num(recycle);
  const income = money(service_fee + listing_fee);
  const net = money(income - drive_award);
  return {
    orders: Number(o.c || 0),
    gmv: num(o.gmv),
    service_fee,
    listing_fee,
    income,
    drive_award,
    net,
    recycle_cost,
    withdraw_paid: num(withdraw),
    cash_net: money(net - recycle_cost),
  };
}

/** 每日趋势（近 N 天，缺失日期补 0） */
function dailyTrend(days = 30) {
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = all(
    `SELECT substr(create_time,1,10) d,
            COUNT(*) c,
            IFNULL(SUM(total_price),0) gmv,
            IFNULL(SUM(service_charge),0) svc,
            IFNULL(SUM(listing_fee),0) listing
     FROM orders
     WHERE pay_status = 10 AND status <> 40 AND substr(create_time,1,10) >= ?
     GROUP BY d ORDER BY d`,
    start,
  );
  const awards = all(
    `SELECT substr(create_time,1,10) d, IFNULL(SUM(face_value),0) v
     FROM finance_energy WHERE type = 1 AND substr(create_time,1,10) >= ?
     GROUP BY d`,
    start,
  );
  const awardMap = new Map(awards.map((x) => [x.d, Number(x.v)]));
  const orderMap = new Map(rows.map((x) => [x.d, x]));

  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
    const o = orderMap.get(d) || {};
    const svc = num(o.svc);
    const listing = num(o.listing);
    const award = num(awardMap.get(d));
    out.push({
      date: d,
      orders: Number(o.c || 0),
      gmv: num(o.gmv),
      service_fee: svc,
      listing_fee: listing,
      income: money(svc + listing),
      drive_award: award,
      net: money(svc + listing - award),
    });
  }
  return out;
}

/** 月度趋势（近 N 个月） */
function monthlyTrend(months = 6) {
  const d = new Date();
  d.setDate(1);
  const list = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const ym = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
    const s = rangeStats(`${ym}-01 00:00:00`, `${ym}-31 23:59:59`);
    list.push({ month: ym, ...s });
  }
  return list;
}

r.get('/finance/overview', authAdmin, (req, res) => {
  const day = today();
  const ym = day.slice(0, 7);
  const todayStats = rangeStats(`${day} 00:00:00`, `${day} 23:59:59`);
  const monthStats = rangeStats(`${ym}-01 00:00:00`, `${ym}-31 23:59:59`);
  const totalStats = rangeStats('1970-01-01 00:00:00', '2999-12-31 23:59:59');

  // 负债与待办
  const balance = num(get('SELECT IFNULL(SUM(amount),0) v FROM member').v);
  const commission = num(get('SELECT IFNULL(SUM(e_card_number),0) v FROM member').v);
  const pendingWithdraw = num(get('SELECT IFNULL(SUM(amount),0) v FROM finance_withdraw WHERE status = 0').v);
  const paidWithdraw = num(get('SELECT IFNULL(SUM(amount),0) v FROM finance_withdraw WHERE status = 10').v);
  const liability = money(balance + commission);

  // 结算缺口：中账差额为负=会员应付平台，正=平台应付会员
  const settleRows = all(
    `SELECT IFNULL(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END),0) payable,
            IFNULL(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),0) receivable,
            COUNT(*) c
     FROM settle_account`,
  )[0] || {};
  const unmatched = get(
    `SELECT IFNULL(SUM(amount),0) v FROM settle_match WHERE pay_status = 0`,
  ).v;

  // 风险判定
  const svcRate = Number(cfg('service_charge', '0'));
  const awardRate = Number(cfg('drive_award_rate', '0'));
  const listRate = Number(cfg('listing_fee_rate', '0'));
  const perOrderCost = money(svcRate - awardRate); // 每单毛利（百分点）
  const negativeMembers = get('SELECT COUNT(*) c FROM member WHERE amount < 0').c;

  const risks = [];
  if (perOrderCost <= 0) {
    risks.push({
      level: 'high',
      title: '单均毛利为 ' + perOrderCost + '%（服务费 ' + svcRate + '% − 直推奖 ' + awardRate + '%）',
      detail: '每做一单都在亏钱或打平。请提高「抢单服务费」或下调「直推奖」到服务费以下。',
    });
  } else if (perOrderCost < 1) {
    risks.push({
      level: 'warn',
      title: '单均毛利仅 ' + perOrderCost + '%',
      detail: '利润空间很薄，一笔坏账或退款就可能吃掉多单利润。建议服务费与直推奖拉开到 1.5% 以上。',
    });
  }
  if (totalStats.net < 0) {
    risks.push({
      level: 'high',
      title: `累计经营净利为负（¥${totalStats.net}）`,
      detail: '支出已超过收入，检查直推奖比例与是否存在异常补发。',
    });
  }
  if (totalStats.cash_net < 0) {
    risks.push({
      level: 'warn',
      title: `现金净流为负（¥${totalStats.cash_net}）`,
      detail: `平台回收已累计付出 ¥${totalStats.recycle_cost}。这是把钱变成库存，短期现金压力大，需确认回收商品能再卖出。`,
    });
  }
  // 分销成本率：直推奖（含团队奖）占经营收入的比例，超过 60% 说明赚的钱大半发给了推广
  if (totalStats.income > 0) {
    const awardRatePct = money((totalStats.drive_award / totalStats.income) * 100);
    if (awardRatePct > 60) {
      risks.push({
        level: 'warn',
        title: `分销成本占收入 ${awardRatePct}%`,
        detail: `累计收入 ¥${totalStats.income}，其中 ¥${totalStats.drive_award} 作为奖励发出。比例过高时平台实际留存很少，建议下调直推奖或提高服务费。`,
      });
    }
  }
  // 流动性：平台回收额占成交额的比例，过高说明商品卖不动、只能自己接盘
  if (totalStats.gmv > 0) {
    const recyclePct = money((totalStats.recycle_cost / totalStats.gmv) * 100);
    if (recyclePct > 20) {
      risks.push({
        level: 'warn',
        title: `平台回收占成交额 ${recyclePct}%`,
        detail: `成交 ¥${totalStats.gmv}，回收付出 ¥${totalStats.recycle_cost}。回收比例高意味着商品在会员之间流转不畅，需要检查定价涨幅是否过快、场次是否人气不足。`,
      });
    }
  }
  if (pendingWithdraw > 0) {
    risks.push({
      level: 'info',
      title: `待审核提现 ¥${pendingWithdraw}`,
      detail: '这些钱已经冻结在会员余额之外，审核通过后即真实流出，请预留资金。',
    });
  }
  if (Number(unmatched) > 0) {
    risks.push({
      level: 'info',
      title: `未确认的匹配付款单 ¥${num(unmatched)}`,
      detail: '中账差额已有匹配单但还没确认收款，确认后账目才算结清。',
    });
  }
  if (negativeMembers > 0) {
    risks.push({
      level: 'high',
      title: `${negativeMembers} 个会员余额为负`,
      detail: '属于账务异常，通常是并发扣款或手工改库导致，需要人工核账。',
    });
  }
  if (!risks.length) {
    risks.push({ level: 'ok', title: '暂无异常', detail: '收入结构、现金净流与负债水平都在正常区间。' });
  }

  res.json(ok({
    today: todayStats,
    month: monthStats,
    total: totalStats,
    liability: {
      balance,
      commission,
      total: liability,
      pending_withdraw: pendingWithdraw,
      paid_withdraw: paidWithdraw,
    },
    settle: {
      payable: num(settleRows.payable),
      receivable: num(settleRows.receivable),
      accounts: Number(settleRows.c || 0),
      unmatched: num(unmatched),
    },
    rate: {
      service_charge: svcRate,
      drive_award: awardRate,
      listing_fee: listRate,
      per_order: perOrderCost,
    },
    trend_daily: dailyTrend(30),
    trend_monthly: monthlyTrend(6),
    risks,
  }));
});

export default r;
