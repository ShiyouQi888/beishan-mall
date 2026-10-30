// 「已转拍出去的订单不需要发货」回归
// 覆盖：持有人变了才判定为已转拍、当前持有人仍可发货、接口层拦截、
//       平台回收也算转手、未支付不判定、非抢购类不受影响。
// 独立库（transferred.db / 3425）
// 用法: node scripts/probe/transferred-order.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3425;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'transferred.db';

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
    const A = await loginM('13800000001');
    const B = await loginM('13800000004');
    ok(!!at && !!A && !!B, '后台与两个会员均登录成功');

    // 用余额支付，链路最短，且能真实走完「成交 → 转拍 → 被下一个人买走」
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'pay', values: { pay_balance_open: '10' } } });
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0', price_increase_rate: '0' } } });
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99').run();
    for (const mobile of ['13800000001', '13800000004']) {
      const mid = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(mobile).id;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 2000000, remark: '测试注资' },
      });
    }

    const orderList = async (q = '') => (await api(`/admin/api/orders/list?page=1&limit=100${q}`, { token: at })).data?.data || [];
    const orderOf = async (id) => (await api(`/admin/api/orders/detail?id=${id}`, { token: at })).data;
    const buy = async (token, goodsId) => {
      const r = await api('/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: goodsId, num: 1, pay_type: 1 } });
      if (r.code !== 1) throw new Error('下单失败：' + r.msg);
      const p = await api('/api/order/toPay', { method: 'POST', token, body: { order_id: r.data.order_id, pay_type: 1 } });
      if (p.code !== 1) throw new Error('支付失败：' + p.msg);
      return r.data.order_id;
    };

    // 需要两件独立的商品：一件用来验「能发货」，一件用来走「买了不发货、直接转拍出去」
    const pickTwo = db.prepare(
      "SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id NOT IN (1,4) ORDER BY goods_id LIMIT 2",
    ).all();
    ok(pickTwo.length >= 2, '找到两件可用于测试的商品', `只有 ${pickTwo.length} 件`);
    const gA = pickTwo[0]?.goods_id;
    const gB = pickTwo[1]?.goods_id;

    // ---------------- 一手：A 买下，A 是当前持有人 ----------------
    section('[1] 刚买下：还没转拍，正常发货');
    const oA = await buy(A, gA);
    const dA = await orderOf(oA);
    ok(dA.transferred === 0, '这笔订单未标记已转拍');
    ok(Number(db.prepare('SELECT member_id m FROM goods WHERE goods_id = ?').get(gA).m) === 1, '商品现持有人是 A');
    ok(dA.status === 10, '订单仍是待发货');
    const ship1 = await api('/admin/api/orders/deliver', { method: 'POST', token: at, body: { order_id: oA, express_no: 'SF001' } });
    ok(ship1.code === 1, '当前持有人可以直接发货', ship1.msg);
    ok(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(oA).status === 20, '发货后进入待收货');

    // ---------------- 转拍出去 ----------------
    section('[2] A 转拍给 B：A 的订单不该再要求发货');
    const oB1 = await buy(A, gB);
    ok(!!oB1, 'A 买下第二件商品');
    const cons = await api('/api/order/consignment', { method: 'POST', token: A, body: { order_id: oB1 } });
    ok(cons.code === 1, 'A 转拍成功', cons.msg);
    // 转拍会把货顺延到明天，这里拉回可抢状态；本探针只关心发货判定，不关心日程
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gB);

    const oB2 = await buy(B, gB);
    ok(!!oB2, 'B 买下这件货');

    const dOut = await orderOf(oB1);
    ok(dOut.transferred === 1, 'A 的订单已标记为「已转拍」', `transferred=${dOut.transferred}`);
    ok(dOut.status_text !== '待发货', '状态文案不再是待发货', dOut.status_text);

    section('[3] 已转拍的单：后台不能再发货');
    const shipOut = await api('/admin/api/orders/deliver', { method: 'POST', token: at, body: { order_id: oB1, express_no: 'SF999' } });
    ok(shipOut.code !== 1, '发货被拒', shipOut.msg);
    ok(/转拍/.test(shipOut.msg || ''), '被拒原因指向已转拍', shipOut.msg);
    const after = db.prepare('SELECT status, express_no FROM orders WHERE order_id = ?').get(oB1);
    ok(after.status === 10 && !after.express_no, '被拒后订单没有被改坏');

    section('[4] 列表接口也带这个标记（前端据此隐藏按钮）');
    const list = await orderList();
    const rowOut = list.find((x) => x.order_id === oB1);
    const rowCur = list.find((x) => x.order_id === oB2);
    ok(!!rowOut && rowOut.transferred === 1, 'A 的单在列表里 transferred=1');
    ok(!!rowCur && rowCur.transferred === 0, 'B 的单（当前持有人）transferred=0');

    // ---------------- 当前持有人不受影响 ----------------
    section('[5] 当前持有人的单照常发货');
    const shipB = await api('/admin/api/orders/deliver', { method: 'POST', token: at, body: { order_id: oB2, express_no: 'SF002' } });
    ok(shipB.code === 1, 'B 的单可以正常发货', shipB.msg);
    ok(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(oB2).status === 20, '发货后进入待收货');

    // ---------------- 平台回收也算转手 ----------------
    section('[6] 商品被平台回收：买家手上也没货了');
    const g2 = db.prepare(
      "SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id <> 1 AND member_id <> 4 ORDER BY goods_id DESC LIMIT 1",
    ).get();
    if (g2 && g2.goods_id !== gA && g2.goods_id !== gB) {
      const o3 = await buy(A, g2.goods_id);
      const before = await orderOf(o3);
      ok(before.transferred === 0, '回收前：A 的单未转拍');
      db.prepare("UPDATE goods SET member_id = 0, goods_status = 20, is_sell = 0 WHERE goods_id = ?").run(g2.goods_id);
      const afterR = await orderOf(o3);
      ok(afterR.transferred === 1, '回收到平台后：A 的单也算已转手', `transferred=${afterR.transferred}`);
    } else {
      ok(true, '跳过（没有第二件可用商品）');
      ok(true, '跳过（没有第二件可用商品）');
    }

    // ---------------- 未支付不判定 ----------------
    section('[7] 未支付的单不参与判定');
    const g3 = db.prepare(
      "SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id <> 4 ORDER BY goods_id LIMIT 1",
    ).get();
    if (g3) {
      const r = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: g3.goods_id, num: 1, pay_type: 1 } });
      if (r.code === 1) {
        const d = await orderOf(r.data.order_id);
        ok(d.transferred === 0, '未支付的单不会被判成已转拍');
        ok(d.status === 0 && d.status_text !== '已转拍', '状态仍是待付款', d.status_text);
      } else {
        ok(true, '跳过（无可下单商品）');
        ok(true, '跳过（无可下单商品）');
      }
    }

    // ---------------- 会员端口径 ----------------
    section('[8] 会员端订单详情同步这个口径');
    const h5 = await api(`/api/order/detail?order_id=${oB1}`, { token: A });
    const h5row = h5.data;
    ok(!!h5row, '会员能查到自己的这笔单');
    ok(h5row.transferred === 1, '会员端也返回 transferred=1', `transferred=${h5row.transferred}`);
    ok(h5row.status_text === '已转拍', '会员端状态文案是「已转拍」', h5row.status_text);
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
