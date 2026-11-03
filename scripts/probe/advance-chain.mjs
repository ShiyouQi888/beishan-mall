/**
 * 提前抢购全链路：提前下单 → 提前提交申请 → 后台确认成交。
 * 语义确认：提前抢购 = 在场次开始前 N 分钟就能下单并提交抢单申请。
 * 独立库（advance-chain.db / 3482）。
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', '..', 'server');
const PORT = 3482;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'advance-chain.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  const p = join(SERVER, 'data', f); if (existsSync(p)) unlinkSync(p);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };
await new Promise((res, rej) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
  p.on('close', c => (c === 0 ? res(o) : rej(new Error(o))));
});
const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
let ready = false;
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {} await sleep(250); }
if (!ready) { console.error('服务未起来'); process.exit(1); }

let pass = 0; const fails = [];
const ok = (c, n, d = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fails.push(n + (d ? ' → ' + d : '')); console.log('  ✗ ' + n + (d ? ' → ' + d : '')); } };
const eq = (a, b, n) => ok(String(a) === String(b), n, `期望 ${b}，实际 ${a}`);
const api = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
};

const { db, get } = await import('../../server/src/db.js');
const nowSec = Math.floor((Math.floor(Date.now() / 1000) + 8 * 3600) % 86400);
const start = nowSec + 180, end = start + 3600;
db.prepare("UPDATE specialarea SET start_time=?, end_time=?, is_open=10, open_days=?, buy_num=0 WHERE specialarea_id=1").run(start, end, '1,2,3,4,5,6,7');

const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
const mkMember = async (phone, nick) => {
  const r = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone, password: 'advance123', code: 'boss01', nickName: nick } });
  const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'advance123' } })).data.token;
  return { id: Number(r.data?.member_id), token: tk };
};
const A = await mkMember('13992000001', '有资格');
const B = await mkMember('13992000002', '没资格');
await api('/admin/api/member/advance', { method: 'POST', token: at, body: { member_id: A.id, enable: true, minutes: 5, count: 2 } });

const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
const mkGoods = async (name, price) => {
  const r = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_name: name, category_id: catId, goods_min_price: price, stock_num: 1, goods_status: 10, goods_sort: 1 } });
  const id = Number(r.data?.id);
  db.prepare("UPDATE goods SET area_date='' WHERE goods_id=?").run(id);
  await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [id] } });
  return id;
};
const g1 = await mkGoods('链路样品A', 500);
const g2 = await mkGoods('链路样品B', 600);

console.log('\n[1] 列表/详情对资格的判定');
const listA = await api('/api/goods/getLootList', { token: A.token });
const cardA = (listA.data?.list || []).flatMap(a => a.goods_list || []).find(x => Number(x.goods_id) === g1);
eq(cardA?.advance_open, 1, 'A 的列表卡片 advance_open=1');
const listB = await api('/api/goods/getLootList', { token: B.token });
const cardB = (listB.data?.list || []).flatMap(a => a.goods_list || []).find(x => Number(x.goods_id) === g1);
eq(cardB?.advance_open, 0, 'B 的列表卡片 advance_open=0');
const dA = await api(`/api/goods/getLootDetails?goods_id=${g1}`, { token: A.token });
eq(dA.data?.advance_open, 1, 'A 详情 advance_open=1');

console.log('\n[2] 提前下单 + 提前提交申请');
const o1 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: g1, num: 1 } });
ok(o1.code === 1, 'A 提前下单成功', o1.msg);
const oid = o1.data?.order_id;
eq(get('SELECT specialarea_id FROM orders WHERE order_id = ?', oid).specialarea_id, 1, '订单落在 1 号场次');
eq(get('SELECT status FROM orders WHERE order_id = ?', oid).status, 0, '订单状态=待付款/待确认');
eq(get('SELECT pay_status FROM orders WHERE order_id = ?', oid).pay_status, 0, '未确认收款');
const ap1 = await api('/api/order/apply', { method: 'POST', token: A.token, body: { order_id: oid } });
ok(ap1.code === 1, '提交抢单申请成功', ap1.msg);
eq(Number(get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '申请抢单'", oid).c), 1, '日志里有申请记录');
const ap2 = await api('/api/order/apply', { method: 'POST', token: A.token, body: { order_id: oid } });
ok(ap2.code === 1 && /已经提交过/.test(ap2.msg), '重复申请幂等', ap2.msg);
eq(get('SELECT advance_count FROM member WHERE member_id = ?', A.id).advance_count, 1, '提前次数 2 → 1');

console.log('\n[3] 无资格的人这段时间动不了这件货');
const bTry = await api('/api/order/toAddOrder', { method: 'POST', token: B.token, body: { goods_id: g1, num: 1 } });
ok(bTry.code === 0, 'B 下单被拒', bTry.msg);
ok(/锁定|抢先|不在抢购时间/.test(bTry.msg || ''), '拒绝原因是锁单/未开抢', bTry.msg);
const listB2 = await api('/api/goods/getLootList', { token: B.token });
const cardB2 = (listB2.data?.list || []).flatMap(a => a.goods_list || []).find(x => Number(x.goods_id) === g1);
eq(cardB2?.locked, 1, 'B 的列表把该货标为「抢购中/已锁定」');

console.log('\n[4] 后台能看到并确认');
const al = await api('/admin/api/orders/list?page=1&limit=50', { token: at });
const row = (al.data?.data || []).find(x => Number(x.order_id) === Number(oid));
ok(!!row, '后台订单列表能看到这笔单');
eq(row?.member_id, A.id, '订单归属是 A');
eq(row?.order_state_text, '待确认', '后台状态=待确认');
const cp = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: oid } });
ok(cp.code === 1, '后台确认抢单成功', cp.msg);
eq(get('SELECT pay_status FROM orders WHERE order_id = ?', oid).pay_status, 10, '订单已成交');
eq(get('SELECT member_id FROM goods WHERE goods_id = ?', g1).member_id, A.id, '货权过户到 A');
const meA = await api('/api/member/getMemberDetails', { token: A.token });
eq(meA.data?.today_orders, 1, 'A 今日订单=1');

console.log('\n[4b] 开场前不能被「未确认超时」关单');
{
  const { expireUnpaidOrders } = await import('../../server/src/lib/orderExpire.js');
  // 再下一单（另件货），把创建时间伪造成 2 小时前 —— 模拟提前很久下单
  const o3 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: g2, num: 1 } });
  ok(o3.code === 1, '再造一笔提前单', o3.msg);
  const oid3 = o3.data.order_id;
  db.prepare("UPDATE orders SET create_time = datetime('now','localtime','-2 hours') WHERE order_id = ?").run(oid3);
  expireUnpaidOrders(30); // 时限 30 分钟，理论上该关
  eq(get('SELECT status FROM orders WHERE order_id = ?', oid3).status, 0, '开场前：提前单没被关掉');
  // 把场次改成已开场，再跑一次，就该正常关单了
  db.prepare('UPDATE specialarea SET start_time=0, end_time=86399 WHERE specialarea_id=1').run();
  expireUnpaidOrders(30);
  eq(get('SELECT status FROM orders WHERE order_id = ?', oid3).status, 40, '开场后：超时单照常关闭');
}

console.log('\n[5] 正式开抢后，无资格的人也能正常买（互不影响）');
db.prepare('UPDATE specialarea SET start_time=0, end_time=86399 WHERE specialarea_id=1').run();
const bBuy = await api('/api/order/toAddOrder', { method: 'POST', token: B.token, body: { goods_id: g2, num: 1 } });
ok(bBuy.code === 1, 'B 在正式时段能下单', bBuy.msg);
const aBuy2 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: g2, num: 1 } });
ok(aBuy2.code === 0, 'A 不能再抢同一件（每人每件一次）', aBuy2.msg);

console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : ''}`);
if (fails.length) fails.forEach(f => console.log(' - ' + f));
srv.kill();
process.exit(fails.length ? 1 : 0);
