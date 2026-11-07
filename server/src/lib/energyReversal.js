// 订单资金冲正（强制删除订单 / 回撤转拍成交共用）
//
// finance_energy 没有 order_id 列，成交时写的备注统一以「订单 <单号>」开头：
//   type=1 佣金（直推奖）→ member.e_card_number / distribution_amount
//   type=2 余额（商品售出）→ member.amount
//   type=3 积分（消费/推广奖励）→ member.score
// 抽成一处，免得两个入口的冲正口径哪天走偏。调用方必须包在事务里。
import { all, get, run } from '../db.js';
import { money } from './helper.js';

/** 精确反查某订单产生的资金流水：精确相等，或「订单号 + 空格」前缀 */
export function energyRowsOf(orderNo) {
  const exact = `订单 ${orderNo}`;
  const prefix = `${exact} `;
  return all(
    `SELECT * FROM finance_energy
      WHERE type IN (1, 2, 3)
        AND (remarks = ? OR substr(IFNULL(remarks, ''), 1, ?) = ?)
      ORDER BY energy_id`,
    exact, prefix.length, prefix,
  );
}

/**
 * 事务内：按流水反向冲正会员账户，并删除这些流水。
 * 已被花掉的账户照实扣成负数，不「余额不足就跳过」——否则订单删了钱还挂在账上。
 * @returns {{rows:number, commission:number, balance:number, score:number, by_member:Array}}
 */
export function reverseOrderEnergy(orderNo) {
  const rows = energyRowsOf(orderNo);
  const summary = { rows: rows.length, commission: 0, balance: 0, score: 0, by_member: [] };
  const touched = new Map();
  for (const e of rows) {
    const amount = Number(e.face_value || 0);
    const mid = Number(e.member_id);
    if (!touched.has(mid)) touched.set(mid, { member_id: mid, commission: 0, balance: 0, score: 0 });
    const acc = touched.get(mid);
    if (Number(e.type) === 1) { summary.commission += amount; acc.commission += amount; }
    else if (Number(e.type) === 2) { summary.balance += amount; acc.balance += amount; }
    else if (Number(e.type) === 3) { summary.score += amount; acc.score += amount; }
  }
  summary.commission = money(summary.commission);
  summary.balance = money(summary.balance);
  summary.score = Math.round(summary.score);
  summary.by_member = [...touched.values()];

  for (const acc of touched.values()) {
    if (acc.commission) {
      run(
        'UPDATE member SET e_card_number = e_card_number - ?, distribution_amount = distribution_amount - ? WHERE member_id = ?',
        money(acc.commission), money(acc.commission), acc.member_id,
      );
    }
    if (acc.balance) {
      run('UPDATE member SET amount = amount - ? WHERE member_id = ?', money(acc.balance), acc.member_id);
    }
    if (acc.score) {
      run('UPDATE member SET score = score - ? WHERE member_id = ?', Math.round(acc.score), acc.member_id);
    }
  }
  for (const e of rows) run('DELETE FROM finance_energy WHERE energy_id = ?', e.energy_id);
  return summary;
}

/** 冲正后点名被扣成负数的账户，交给运营人工核账 */
export function negativeMembersOf(summary) {
  return (summary?.by_member || []).map((x) => x.member_id).filter((mid) => {
    const m = get('SELECT score, e_card_number, amount FROM member WHERE member_id = ?', mid);
    return m && (Number(m.score) < 0 || Number(m.e_card_number) < 0 || Number(m.amount) < 0);
  });
}
