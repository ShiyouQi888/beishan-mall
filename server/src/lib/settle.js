// 结算与分账（严格对齐原站实证算法，见 docs/target-system-spec.md）
//
// 原站口径：
//   抢购成交      —— 买家付货款，卖家收全额，平台不收任何费用
//   转拍（寄卖）  —— 按「本轮抢购金额 × 上架费率」收上架费，默认 2.8%
//   直推奖        —— 按「买单金额 × 直推奖率」发给直接上级，默认 0.5%
//   团队奖        —— 按上级会员等级的 team_award 计算，原站五级均为 0（未启用）
//   平级奖        —— 原站配置为 0
//
// 平台每轮净收入 = 上架费 − 直推奖 − 团队奖（2.8% − 0.5% = 2.3%）
import { all, get, run, now } from '../db.js';

const cfg = (k, d = '') => get('SELECT `value` FROM setting_config WHERE `key` = ?', k)?.value ?? d;
export const money2 = (n) => Number(Number(n).toFixed(2));

/** 上架费率（%），对齐原站 listing_fee_percentage */
export const listingFeeRate = () => Number(cfg('listing_fee_rate', '2.8'));
/** 直推奖率（%），对齐原站 grade[drive_award] */
export const driveAwardRate = () => Number(cfg('drive_award_rate', '0.5'));

/** 计算某金额的上架费 */
export function calcListingFee(baseAmount) {
  return money2((Number(baseAmount) * listingFeeRate()) / 100);
}

/** 业务异常：在事务内抛出会被捕获并回滚 */
export const biz = (msg) => {
  const e = new Error(msg);
  e.biz = true;
  return e;
};

/**
 * 抢购成交结算（买家付款成功后调用）
 * - 商品持有人转移给买家，转拍次数 +1
 * - 卖家收到货款全额（平台不从货款里抽成）
 * - 给买家的直接上级发直推奖
 * - 累加团队流水并检查等级升级
 */
export function settleOrder(o) {
  const g = get('SELECT * FROM goods WHERE goods_id = ?', o.goods_id);
  if (!g) return { ok: false, reason: '商品不存在' };

  run(
    `UPDATE goods SET member_id = ?, turn_beat_num = turn_beat_num + ?, sales_actual = sales_actual + ?, update_time = ?
     WHERE goods_id = ?`,
    o.member_id, o.num, o.num, now(), g.goods_id,
  );

  // 卖家收货款全额
  let sellerIncome = 0;
  if (o.seller_id && o.seller_id !== o.member_id) {
    sellerIncome = money2(o.total_price);
    if (sellerIncome > 0) {
      run('UPDATE member SET amount = amount + ? WHERE member_id = ?', sellerIncome, o.seller_id);
      run(
        'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
        o.seller_id, sellerIncome, 2, '商品售出', `订单 ${o.order_no}`, now(),
      );
    }
  }

  const award = distributeAward(o);
  addTeamWater(o.member_id, o.total_price);

  return { ok: true, sellerIncome, award };
}

/**
 * 分销奖励：直推奖 + 团队奖
 * 基数 = 买单金额（对齐原站「大账买单直推奖」）
 */
export function distributeAward(o) {
  const base = money2(o.total_price);
  if (base <= 0) return 0;

  const buyer = get('SELECT member_id, p_id FROM member WHERE member_id = ?', o.member_id);
  if (!buyer?.p_id) return 0;

  const parent = get('SELECT member_id, p_id, grade_id FROM member WHERE member_id = ?', buyer.p_id);
  if (!parent) return 0;

  let total = 0;

  // 1) 直推奖（单级，原站实际跑的就是这一层）
  const driveRate = driveAwardRate();
  if (driveRate > 0) {
    const c = money2((base * driveRate) / 100);
    if (c > 0) {
      total = money2(total + c);
      payCommission(parent.member_id, c, '直推奖', o.order_no);
    }
  }

  // 2) 团队奖（按上级自身等级的 team_award，原站默认 0）
  const grade = parent.grade_id
    ? get('SELECT * FROM member_grade WHERE grade_id = ?', parent.grade_id)
    : null;
  const teamRate = Number(grade?.team_award || 0);
  if (teamRate > 0) {
    const c = money2((base * teamRate) / 100);
    if (c > 0) {
      total = money2(total + c);
      payCommission(parent.member_id, c, '团队奖', o.order_no);
    }
  }

  return total;
}

function payCommission(memberId, amount, label, orderNo) {
  run(
    'UPDATE member SET e_card_number = e_card_number + ?, distribution_amount = distribution_amount + ? WHERE member_id = ?',
    amount, amount, memberId,
  );
  run(
    'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
    memberId, amount, 3, label, `订单 ${orderNo} 大账买单${label}`, now(),
  );
}

/**
 * 团队流水累计 + 等级升级
 * 沿推荐链向上累加业绩，然后逐个检查是否满足升级条件
 */
function addTeamWater(buyerId, amount) {
  const buyer = get('SELECT member_id, p_id FROM member WHERE member_id = ?', buyerId);
  let cur = buyer;
  for (let i = 0; i < 20 && cur?.p_id; i++) {
    const p = get('SELECT member_id, p_id, grade_id FROM member WHERE member_id = ?', cur.p_id);
    if (!p) break;
    run('UPDATE member SET team_water = team_water + ? WHERE member_id = ?', money2(amount), p.member_id);
    checkGradeUpgrade(p.member_id);
    cur = p;
  }
}

/** 按 member_grade 的升级条件判定是否可升级（只升不降） */
function checkGradeUpgrade(memberId) {
  const m = get('SELECT * FROM member WHERE member_id = ?', memberId);
  if (!m) return;

  const childCount = m.child_id ? m.child_id.split(',').filter(Boolean).length : 0;
  // 团队有效人数：path 中包含该会员的所有下级
  const teamValid = get(
    "SELECT COUNT(*) c FROM member WHERE path LIKE ? AND is_valid = 10 AND disabled = 10",
    `%/${memberId}/%`,
  ).c;

  const grades = allGrades();
  let target = m.grade_id || 1;
  for (const g of grades) {
    if (g.grade_id <= target) continue;
    const okDrive = childCount >= (g.drive_num || 0);
    const okValid = teamValid >= (g.team_valid || 0);
    const okWater = Number(m.team_water || 0) >= Number(g.team_water || 0) * 10000;
    if (okDrive && okValid && okWater) target = g.grade_id;
  }

  if (target > (m.grade_id || 1)) {
    run('UPDATE member SET grade_id = ?, identity_vip = ? WHERE member_id = ?', target, target - 1, memberId);
    run(
      'INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
      memberId, '等级提升',
      `恭喜您已升级为「${grades.find((x) => x.grade_id === target)?.name || '新等级'}」`, now(),
    );
  }
}

function allGrades() {
  return all('SELECT * FROM member_grade ORDER BY grade_id');
}
