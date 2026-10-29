// 数据完整性审计：直接扫数据库，找孤儿记录、口径不一致、越界值
// 用法: node scripts/probe/data-audit.mjs [dbPath]
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = process.argv[2] || join(__dirname, '..', '..', 'server', 'data', 'mall.db');
const db = new DatabaseSync(DB);

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
let issues = 0;
let checks = 0;

function check(name, sql, { expectZero = true, note = '' } = {}) {
  checks++;
  let rows;
  try { rows = db.prepare(sql).all(); } catch (e) { console.log(`  ? ${name} —— 查询失败：${e.message}`); issues++; return; }
  const bad = expectZero ? rows.filter((r) => Number(Object.values(r)[0] || 0) !== 0) : rows;
  if (expectZero) {
    if (bad.length) { issues++; console.log(`  ✗ ${name}${note ? '（' + note + '）' : ''}`, JSON.stringify(bad).slice(0, 160)); }
    else console.log(`  ✓ ${name}`);
  } else {
    if (rows.length) { issues++; console.log(`  ✗ ${name}`, JSON.stringify(rows).slice(0, 160)); }
    else console.log(`  ✓ ${name}`);
  }
}

console.log(`审计库：${DB}\n`);
console.log('【金额与资金】');
check('会员余额不为负', 'SELECT COUNT(*) c FROM member WHERE amount < 0');
check('佣金不为负', 'SELECT COUNT(*) c FROM member WHERE e_card_number < 0');
check('积分不为负', 'SELECT COUNT(*) c FROM member WHERE score < 0');
const balSum = money(db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v);
const flowType2 = money(db.prepare('SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2').get().v);
// 注意：seed 的初始余额与后台直接改库不会产生流水，因此两者不会相等，只做信息输出
console.log(`  · 会员余额合计 ${balSum} ／ 余额类流水合计 ${flowType2}（差额 ${money(balSum - flowType2)}，含 seed 初始余额，不视为异常）`);
check('余额不小于流水合计（初始余额为正）', `SELECT CASE WHEN (SELECT IFNULL(SUM(amount),0) FROM member) >= (SELECT IFNULL(SUM(face_value),0) FROM finance_energy WHERE type = 2) THEN 0 ELSE 1 END c`);

/** 两类记录条数应相等（成对产生的业务） */
function paired(name, aSql, bSql) {
  checks++;
  const a = Number(db.prepare(aSql).get().c);
  const b = Number(db.prepare(bSql).get().c);
  if (a === b) console.log(`  ✓ ${name}（${a} 对）`);
  else { issues++; console.log(`  ✗ ${name}：${a} vs ${b}`); }
}
paired('平台回收流水与已回收流拍单一一对应',
  "SELECT COUNT(*) c FROM finance_energy WHERE type_name = '平台回收'",
  'SELECT COUNT(*) c FROM orders WHERE type = 5 AND status = 70');
paired('提现申请流水与提现记录一一对应',
  "SELECT COUNT(*) c FROM finance_energy WHERE type_name = '提现申请'",
  'SELECT COUNT(*) c FROM finance_withdraw');
paired('转拍上架费流水与转拍次数一一对应',
  "SELECT COUNT(*) c FROM finance_energy WHERE type_name = '转拍上架费'",
  "SELECT COUNT(*) c FROM order_log WHERE action = '转拍上架'");

console.log('\n【订单完整性】');
check('订单都能对应到商品', 'SELECT COUNT(*) c FROM orders o LEFT JOIN goods g ON g.goods_id = o.goods_id WHERE g.goods_id IS NULL');
check('订单买家都存在于会员表', 'SELECT COUNT(*) c FROM orders o LEFT JOIN member m ON m.member_id = o.member_id WHERE o.member_id > 0 AND m.member_id IS NULL');
check('订单卖家都存在（seller_id>0 时）', 'SELECT COUNT(*) c FROM orders o LEFT JOIN member m ON m.member_id = o.seller_id WHERE o.seller_id > 0 AND m.member_id IS NULL');
check('已支付订单都有支付时间', "SELECT COUNT(*) c FROM orders WHERE pay_status = 10 AND (pay_time IS NULL OR pay_time = '')");
check('已转拍订单都有上架费与转拍时间', "SELECT COUNT(*) c FROM orders WHERE consignment_status = 10 AND (IFNULL(listing_fee,0) <= 0 OR transposition_time IS NULL)");
check('不存在仍在售却被标记流拍的商品', 'SELECT COUNT(*) c FROM goods WHERE goods_status = 30 AND member_id = 0');
check('寄卖挂单(type=2)已清零', 'SELECT COUNT(*) c FROM orders WHERE type = 2');
check('流拍单都有备注来源', "SELECT COUNT(*) c FROM orders WHERE type = 5 AND (remark IS NULL OR remark = '')");

console.log('\n【会员与关系链】');
check('手机号无重复', 'SELECT COUNT(*) c FROM (SELECT mobile FROM member GROUP BY mobile HAVING COUNT(*) > 1) t');
check('邀请码无重复', 'SELECT COUNT(*) c FROM (SELECT invitation_code FROM member GROUP BY invitation_code HAVING COUNT(*) > 1) t');
check('邀请码均非空', "SELECT COUNT(*) c FROM member WHERE IFNULL(invitation_code,'') = ''");
check('上级都真实存在', 'SELECT COUNT(*) c FROM member m LEFT JOIN member p ON p.member_id = m.p_id WHERE m.p_id > 0 AND p.member_id IS NULL');
const badPath = db.prepare(`
  SELECT COUNT(*) c FROM member m JOIN member p ON p.member_id = m.p_id
  WHERE m.path <> p.path || p.member_id || '/'
`).get().c;
checks++;
if (Number(badPath)) { issues++; console.log(`  ✗ 会员层级 path 与上级不匹配：${badPath} 条`); } else console.log('  ✓ 会员层级 path 与上级一致');
const selfParent = db.prepare('SELECT COUNT(*) c FROM member WHERE p_id = member_id').get().c;
checks++;
if (Number(selfParent)) { issues++; console.log(`  ✗ 存在自己作为上级的会员：${selfParent}`); } else console.log('  ✓ 无自引用上级');
check('会员等级引用有效', 'SELECT COUNT(*) c FROM member m LEFT JOIN member_grade g ON g.grade_id = m.grade_id WHERE IFNULL(m.grade_id,0) > 0 AND g.grade_id IS NULL');

console.log('\n【商品与场次】');
check('在售商品都有持有人或归平台', 'SELECT COUNT(*) c FROM goods WHERE goods_status = 10 AND member_id IS NULL');
check('商品持有人都真实存在（member_id>0 时）', 'SELECT COUNT(*) c FROM goods g LEFT JOIN member m ON m.member_id = g.member_id WHERE g.member_id > 0 AND m.member_id IS NULL');
check('拆分商品份数与库存一致', 'SELECT COUNT(*) c FROM goods WHERE is_split = 1 AND (split_total <= 0 OR stock_num > split_total)');
check('商品标价非负', 'SELECT COUNT(*) c FROM goods WHERE goods_min_price < 0');
check('划线价不低于现价（非零时）', 'SELECT COUNT(*) c FROM goods WHERE line_price > 0 AND line_price < goods_min_price');
check('场次时间区间合法', 'SELECT COUNT(*) c FROM specialarea WHERE end_time <= start_time');

console.log('\n【权限与配置】');
check('角色节点无孤儿', 'SELECT COUNT(*) c FROM store_role_node WHERE role_id NOT IN (SELECT role_id FROM store_role)');
check('节点绑定指向存在的节点', 'SELECT COUNT(*) c FROM store_role_node n LEFT JOIN store_node d ON d.id = n.node_id WHERE d.id IS NULL');
check('管理员角色都存在', 'SELECT COUNT(*) c FROM store_user u LEFT JOIN store_role r ON r.role_id = u.role_id WHERE r.role_id IS NULL');
check('菜单节点无重复路径', "SELECT COUNT(*) c FROM (SELECT action_name FROM store_node WHERE action_name <> '' GROUP BY action_name HAVING COUNT(*) > 1) t");
check('配置键无空值', "SELECT COUNT(*) c FROM setting_config WHERE `value` IS NULL");
check('不存在已废弃的三级佣金键', "SELECT COUNT(*) c FROM setting_config WHERE `key` IN ('commission_l1','commission_l2','commission_l3','commission_base')");

console.log('\n【结算】');
check('中账差额 = 卖出 − 买入', 'SELECT COUNT(*) c FROM settle_account WHERE ABS(balance - (consignment_amount - buy_amount)) > 0.011');
check('批次内买卖总额配平', 'SELECT COUNT(*) c FROM settle_batch WHERE ABS(total_buy - total_sell) > 0.011');
check('匹配单金额为正', 'SELECT COUNT(*) c FROM settle_match WHERE amount <= 0');
check('结算不含寄卖挂单', 'SELECT COUNT(*) c FROM settle_account a JOIN orders o ON o.order_id IN (SELECT order_id FROM orders WHERE type = 2) WHERE a.buy_amount > 0');

console.log('\n' + '='.repeat(52));
console.log(`检查 ${checks} 项，发现问题 ${issues} 项`);
process.exit(issues ? 1 : 0);
