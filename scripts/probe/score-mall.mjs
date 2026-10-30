// 积分商城回归：后台管理、会员兑换、发货退分、分销积分奖励、流水分类
// 独立库（score-mall.db / 3426）
// 用法: node scripts/probe/score-mall.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3426;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'score-mall.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runSeed() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await runSeed();
  const { db } = await import('../../server/src/db.js');

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => {
    log += String(d);
    if (!String(d).includes('ExperimentalWarning') && !String(d).includes('trace-warnings')) process.stderr.write(d);
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const loginM = async (phone) =>
      (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
    const MT = await loginM('13822367845');
    ok(!!at && !!MT, '后台与会员登录成功');

    const meId = db.prepare("SELECT member_id id, p_id, score FROM member WHERE mobile = '13822367845'").get();
    const addScore = (n) => db.prepare('UPDATE member SET score = score + ? WHERE member_id = ?').run(n, meId.id);

    // 造一条收货地址
    db.prepare(
      "INSERT INTO member_address (member_id, name, mobile, province, city, district, detail, is_default, create_time) VALUES (?,?,?,?,?,?,?,1,?)",
    ).run(meId.id, '测试收货人', '13800000000', '广东省', '深圳市', '南山区', '科技园 1 号', new Date().toISOString());
    const addrId = db.prepare('SELECT address_id id FROM member_address WHERE member_id = ?').get(meId.id).id;
    ok(!!addrId, '准备收货地址');

    const saveItem = (values) => api('/admin/api/scoreItem/save', { method: 'POST', token: at, body: values });
    const listItems = async () => (await api('/admin/api/scoreItem/list?page=1&limit=50', { token: at })).data?.data || [];

    // ---------------- 后台管理 ----------------
    section('[1] 后台积分商品：新增 / 编辑 / 列表');
    const created = await saveItem({ name: '测试积分好礼', thumb: '/uploads/demo.png', score_price: 100, stock: 5, limit_per: 0, sort: 10, status: 10 });
    ok(created.code === 1, '新增积分商品成功', created.msg);
    const item = db.prepare("SELECT * FROM score_item WHERE name = '测试积分好礼'").get();
    ok(!!item && Number(item.score_price) === 100, '积分价写入正确', item && item.score_price);
    ok(Number(item.stock) === 5, '库存写入正确');

    await saveItem({ item_id: item.item_id, name: '测试积分好礼（改）', score_price: 120, stock: 5, status: 10 });
    const edited = db.prepare('SELECT * FROM score_item WHERE item_id = ?').get(item.item_id);
    ok(edited.name === '测试积分好礼（改）' && Number(edited.score_price) === 120, '编辑生效');

    const admList = await listItems();
    ok(admList.some((x) => x.item_id === item.item_id), '后台列表能查到');

    // 下架商品不该出现在前台
    await saveItem({ item_id: item.item_id, status: 20 });
    const offList = await api('/api/score/getScoreShopList?page=1&limit=50');
    ok(!(offList.data?.list?.data || []).some((x) => x.item_id === item.item_id), '下架后前台看不到');
    await saveItem({ item_id: item.item_id, status: 10 });
    const onList = await api('/api/score/getScoreShopList?page=1&limit=50');
    ok((onList.data?.list?.data || []).some((x) => x.item_id === item.item_id), '上架后前台可见');

    // ---------------- 兑换校验 ----------------
    section('[2] 兑换前置校验');
    const noAddr = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 1 } });
    ok(noAddr.code !== 1 && /地址/.test(noAddr.msg || ''), '不选地址被拒', noAddr.msg);

    db.prepare('UPDATE member SET score = 0 WHERE member_id = ?').run(meId.id);
    const noScore = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 1, address_id: addrId } });
    ok(noScore.code !== 1 && /积分不足/.test(noScore.msg || ''), '积分不足被拒', noScore.msg);

    addScore(10000);
    const overStock = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 99, address_id: addrId } });
    ok(overStock.code !== 1, '超过库存被拒', overStock.msg);

    const badNum = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: -1, address_id: addrId } });
    ok(badNum.code !== 1, '负数数量被拒', badNum.msg);

    // ---------------- 正常兑换 ----------------
    section('[3] 正常兑换：扣积分、减库存、写记录');
    const before = db.prepare('SELECT score FROM member WHERE member_id = ?').get(meId.id).score;
    const okEx = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 2, address_id: addrId } });
    ok(okEx.code === 1, '兑换成功', okEx.msg);
    const after = db.prepare('SELECT score FROM member WHERE member_id = ?').get(meId.id).score;
    ok(Number(before) - Number(after) === 240, '扣掉 120×2=240 积分', `${before} → ${after}`);
    const it2 = db.prepare('SELECT * FROM score_item WHERE item_id = ?').get(item.item_id);
    ok(Number(it2.stock) === 3 && Number(it2.sold) === 2, '库存减 2、已兑加 2', `stock=${it2.stock} sold=${it2.sold}`);

    const ex = db.prepare('SELECT * FROM score_exchange ORDER BY exchange_id DESC LIMIT 1').get();
    ok(Number(ex.total_score) === 240 && Number(ex.num) === 2, '兑换单金额与数量正确');
    ok(ex.receiver === '测试收货人' && /科技园/.test(ex.address || ''), '收货信息快照已写入');
    ok(Number(ex.status) === 10, '兑换单初始为待发货');

    const flow = db.prepare("SELECT * FROM finance_energy WHERE member_id = ? ORDER BY energy_id DESC LIMIT 1").get(meId.id);
    ok(Number(flow.type) === 3 && Number(flow.face_value) === -240, '积分流水 type=3、负数', `type=${flow.type} val=${flow.face_value}`);

    // ---------------- 每人限兑 ----------------
    section('[4] 每人限兑');
    await saveItem({ item_id: item.item_id, name: '限兑商品', score_price: 10, stock: 100, limit_per: 2, status: 10 });
    const ex2 = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 2, address_id: addrId } });
    ok(ex2.code !== 1 && /限兑/.test(ex2.msg || ''), '超出每人限兑被拒', ex2.msg);
    const ex3 = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 1, address_id: addrId } });
    ok(ex3.code !== 1, '已兑 2 件后连 1 件都不能再兑', ex3.msg);

    // ---------------- 会员端兑换记录 ----------------
    section('[5] 会员端兑换记录');
    const my = await api('/api/score/myExchanges?page=1&limit=10', { token: MT });
    ok(my.code === 1 && (my.data?.list?.data || []).length > 0, '能看到自己的兑换记录');
    const rec = (my.data?.list?.data || [])[0];
    ok(rec.status_text === '待发货', '状态文案正确', rec.status_text);

    // ---------------- 后台发货 ----------------
    section('[6] 后台兑换发货');
    const shipNo = await api('/admin/api/score-exchange/deliver', { method: 'POST', token: at, body: { exchange_id: ex.exchange_id } });
    ok(shipNo.code !== 1, '不填单号不能发货', shipNo.msg);
    const ship = await api('/admin/api/score-exchange/deliver', { method: 'POST', token: at, body: { exchange_id: ex.exchange_id, express_no: 'SF123', express_company: '顺丰速运' } });
    ok(ship.code === 1, '发货成功', ship.msg);
    const shipped = db.prepare('SELECT * FROM score_exchange WHERE exchange_id = ?').get(ex.exchange_id);
    ok(Number(shipped.status) === 20 && shipped.express_no === 'SF123', '状态转为待收货、单号已记');

    // ---------------- 取消退分 ----------------
    section('[7] 取消兑换：退积分、回滚库存');
    // 上一段把每人限兑设成 2 且已兑满，这里先解除限制才能再造一笔
    await saveItem({ item_id: item.item_id, limit_per: 0 });
    const okEx2 = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 2, address_id: addrId } });
    ok(okEx2.code === 1, '再造一笔待发货兑换', okEx2.msg);
    const target = db.prepare("SELECT * FROM score_exchange WHERE status = 10 ORDER BY exchange_id DESC LIMIT 1").get();
    const scoreBeforeCancel = Number(db.prepare('SELECT score FROM member WHERE member_id = ?').get(meId.id).score);
    const stockBeforeCancel = Number(db.prepare('SELECT stock FROM score_item WHERE item_id = ?').get(item.item_id).stock);
    const cancel = await api('/admin/api/score-exchange/cancel', { method: 'POST', token: at, body: { exchange_id: target.exchange_id } });
    ok(cancel.code === 1, '取消成功', cancel.msg);
    const scoreAfterCancel = Number(db.prepare('SELECT score FROM member WHERE member_id = ?').get(meId.id).score);
    const stockAfterCancel = Number(db.prepare('SELECT stock FROM score_item WHERE item_id = ?').get(item.item_id).stock);
    ok(scoreAfterCancel - scoreBeforeCancel === Number(target.total_score), '积分已全额退回', `+${scoreAfterCancel - scoreBeforeCancel}`);
    ok(stockAfterCancel - stockBeforeCancel === Number(target.num), '库存已还原', `+${stockAfterCancel - stockBeforeCancel}`);
    ok(db.prepare('SELECT status FROM score_exchange WHERE exchange_id = ?').get(target.exchange_id).status === 40, '状态转为已取消');

    const cancelShipped = await api('/admin/api/score-exchange/cancel', { method: 'POST', token: at, body: { exchange_id: ex.exchange_id } });
    ok(cancelShipped.code !== 1, '已发货的兑换不能取消退分', cancelShipped.msg);

    // ---------------- 前台总开关 ----------------
    section('[8] 积分商城总开关');
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'store', values: { score_open: '20' } } });
    const closedList = await api('/api/score/getScoreShopList?page=1&limit=10');
    ok(closedList.code !== 1, '关闭后前台列表被拒', closedList.msg);
    const closedEx = await api('/api/score/exchange', { method: 'POST', token: MT, body: { item_id: item.item_id, num: 1, address_id: addrId } });
    ok(closedEx.code !== 1, '关闭后兑换被拒', closedEx.msg);
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'store', values: { score_open: '10' } } });
    ok((await api('/api/score/getScoreShopList?page=1&limit=10')).code === 1, '重新开启后恢复');

    // ---------------- 分销积分奖励 ----------------
    section('[9] 成交送积分：默认关闭时不给');
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'pay', values: { pay_balance_open: '10' } } });
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0', price_increase_rate: '0', drive_award_rate: '0.5' } } });
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99').run();

    const buyerId = meId.id;
    const parentId = meId.p_id;
    ok(!!parentId, '该会员有上级，可用于测上级奖励', `p_id=${parentId}`);
    const parentScoreOf = () => Number(db.prepare('SELECT score FROM member WHERE member_id = ?').get(parentId).score);
    const buyerScoreOf = () => Number(db.prepare('SELECT score FROM member WHERE member_id = ?').get(buyerId).score);

    const buyOne = async () => {
      const g = db.prepare(
        "SELECT goods_id, goods_min_price FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id <> ? ORDER BY goods_id LIMIT 1",
      ).get(buyerId);
      if (!g) throw new Error('无可用商品');
      const r = await api('/api/order/toAddOrder', { method: 'POST', token: MT, body: { goods_id: g.goods_id, num: 1, pay_type: 1 } });
      if (r.code !== 1) throw new Error('下单失败：' + r.msg);
      const p = await api('/api/order/toPay', { method: 'POST', token: MT, body: { order_id: r.data.order_id, pay_type: 1 } });
      if (p.code !== 1) throw new Error('支付失败：' + p.msg);
      return { orderId: r.data.order_id, price: Number(g.goods_min_price) };
    };

    db.prepare('UPDATE member SET amount = 5000000 WHERE member_id = ?').run(buyerId);
    const b0 = buyerScoreOf();
    const p0 = parentScoreOf();
    const buy1 = await buyOne();
    ok(buyerScoreOf() === b0 && parentScoreOf() === p0, '开关关闭时成交不产生积分');

    section('[10] 开启后按比例给买家与上级发积分');
    // 买家每消费 10 元得 1 分；上级每促成 20 元得 1 分
    await api('/admin/api/setting/save', {
      method: 'POST', token: at,
      body: { group: 'store', values: { score_award_open: '10', score_award_buyer: '10', score_award_parent: '20' } },
    });
    db.prepare('UPDATE member SET amount = 5000000 WHERE member_id = ?').run(buyerId);
    const b1 = buyerScoreOf();
    const p1 = parentScoreOf();
    const buy2 = await buyOne();
    const expectBuyer = Math.floor(buy2.price / 10);
    const expectParent = Math.floor(buy2.price / 20);
    ok(buyerScoreOf() - b1 === expectBuyer, `买家得到 ${expectBuyer} 积分`, `实际 ${buyerScoreOf() - b1}`);
    ok(parentScoreOf() - p1 === expectParent, `上级得到 ${expectParent} 积分`, `实际 ${parentScoreOf() - p1}`);

    section('[11] 积分流水与佣金流水不再混淆');
    const buyerFlow = db.prepare(
      "SELECT * FROM finance_energy WHERE member_id = ? AND type_name = '消费奖励' ORDER BY energy_id DESC LIMIT 1",
    ).get(buyerId);
    ok(Number(buyerFlow?.type) === 3, '积分奖励流水 type=3', `type=${buyerFlow?.type}`);
    ok(Number(buyerFlow?.face_value) === expectBuyer, '积分奖励流水数值正确');

    const commission = db.prepare(
      "SELECT * FROM finance_energy WHERE type_name = '直推奖' ORDER BY energy_id DESC LIMIT 1",
    ).get();
    ok(!!commission, '存在直推奖流水');
    ok(Number(commission?.type) === 1, '佣金流水 type=1（不再写成积分）', `type=${commission?.type}`);

    section('[12] 后台积分商品删除');
    const del = await api('/admin/api/scoreItem/remove', { method: 'POST', token: at, body: { ids: [item.item_id] } });
    ok(del.code === 1, '删除积分商品成功', del.msg);
    ok(!db.prepare('SELECT 1 FROM score_item WHERE item_id = ?').get(item.item_id), '确实已删除');
  } catch (e) {
    fails.push('异常：' + e.message);
    console.error('\n异常：', e.message);
  } finally {
    srv.kill();
    await sleep(300);
  }

  console.log('\n' + '─'.repeat(52));
  if (fails.length) {
    console.log(`✗ ${fails.length} 项失败（通过 ${pass} 项）`);
    for (const f of fails) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
