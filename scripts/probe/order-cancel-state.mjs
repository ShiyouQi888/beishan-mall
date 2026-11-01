/**
 * 订单取消链路验收：H5 取消后，前台/后台/统计三处都必须认这个「已取消」。
 *
 * 覆盖：
 *   1. 申请抢单后状态是「待确认」
 *   2. 会员取消 → H5 列表与详情都变「已取消」（原来是「待确认」，看着像没生效）
 *   3. 后台订单列表状态列同步「已取消」
 *   4. 后台「确认收款」必须被拦住（否则会把会员撤回的申请强行成交，钱货两空）
 *   5. 后台首页「订单总数 / 今日订单」不再把已取消的算进去
 *   6. 会员「今日订单」卡片同理
 *
 * 独立库（order-cancel.db / 3473），跑完销毁。
 * 用法: node scripts/probe/order-cancel-state.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3473;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'order-cancel.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  const p = join(SERVER, 'data', f);
  if (existsSync(p)) unlinkSync(p);
}
// 探针自己也要连这个库（漏了这句会连到默认的 mall.db，断言全部对不上）
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

const seed = () => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
});

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await seed();
  {
    const { db } = await import('../../server/src/db.js');
    db.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();
  }

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += String(d)));
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  const { db, get } = await import('../../server/src/db.js');
  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

  try {
    // 场次全开 + 清掉落场日期，保证随时可下单
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, is_open = 10').run();

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const reg = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13960000001', password: 'cancel123456', code: 'boss01', nickName: '取消链路' },
    });
    const mid = Number(reg.data?.member_id);
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 50000, remark: '验收充值' } });
    const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13960000001', password: 'cancel123456' } })).data.token;
    ok(!!tk, '会员登录');

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const cg = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_name: '取消链路样品', category_id: catId, goods_min_price: 1000, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const gid = Number(cg.data?.id);
    // 故意不关联任何场次：不挂场次的商品是「随时可买」，避免被场次时段卡住
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);

    // ---------- 1. 下单（申请抢单，未确认） ----------
    section('[1] 会员申请抢单，此时是「待确认」');
    const od = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: gid, num: 1, pay_type: 0 } });
    ok(od.code === 1, '下单成功', od.msg);
    const oid = od.data.order_id;
    eq(get('SELECT status FROM orders WHERE order_id = ?', oid)?.status, 0, '订单状态 status=0（待付款/待确认）');

    const h5Detail = await api(`/api/order/detail?order_id=${oid}`, { token: tk });
    eq(h5Detail.data?.status_text, '待确认', 'H5 详情显示「待确认」');

    const dashBefore = await api('/admin/api/dashboard', { token: at });
    const totalBefore = Number(dashBefore.data?.overview?.order_total);
    const todayBefore = Number(dashBefore.data?.overview?.order_today);

    const meBefore = await api('/api/member/getMemberDetails', { token: tk });
    ok(Number(meBefore.data?.today_orders) === 1, '会员「今日订单」= 1', String(meBefore.data?.today_orders));

    // ---------- 2. 会员取消 ----------
    section('[2] 会员取消后，H5 必须显示「已取消」而不是「待确认」');
    const cc = await api('/api/order/cancel', { method: 'POST', token: tk, body: { order_id: oid } });
    ok(cc.code === 1, '取消成功', cc.msg);
    eq(get('SELECT status FROM orders WHERE order_id = ?', oid).status, 40, '库里 status=40');

    const list = await api('/api/order/getOrder?page=1&limit=20', { token: tk });
    const row = (list.data?.data || []).find((x) => Number(x.order_id) === Number(oid));
    ok(!!row, '订单仍在我的订单列表里（取消不等于删除）');
    eq(row?.status_text, '已取消', 'H5 列表状态文案 = 已取消');

    const detail2 = await api(`/api/order/detail?order_id=${oid}`, { token: tk });
    eq(detail2.data?.status_text, '已取消', 'H5 详情状态文案 = 已取消');

    // 取消后不应再允许取消 / 支付
    const again = await api('/api/order/cancel', { method: 'POST', token: tk, body: { order_id: oid } });
    ok(again.code !== 1, '重复取消被拒', again.msg);
    const pay = await api('/api/order/toPay', { method: 'POST', token: tk, body: { order_id: oid, pay_type: 1 } });
    ok(pay.code !== 1, '已取消订单不能支付', pay.msg);

    // ---------- 3. 后台列表 ----------
    section('[3] 后台订单列表同步显示「已取消」');
    const adminList = await api('/admin/api/orders/list?page=1&limit=50', { token: at });
    const arow = (adminList.data?.data || []).find((x) => Number(x.order_id) === Number(oid));
    eq(arow?.order_state_text, '已取消', '后台列表状态列 = 已取消');

    // ---------- 4. 后台不能确认收款 ----------
    section('[4] 后台「确认收款」必须拦住已取消订单');
    const confirm = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: oid } });
    ok(confirm.code !== 1, '确认收款被拒绝', confirm.msg);
    ok(/取消/.test(String(confirm.msg || '')), '提示里说明是「已取消」', confirm.msg);
    eq(get('SELECT pay_status FROM orders WHERE order_id = ?', oid).pay_status, 0, '订单没有被偷偷确认');

    // 批量确认同样拦住：全部失败时接口整体返回失败，提示里点名原因
    const batch = await api('/admin/api/orders/confirm-pay-batch', { method: 'POST', token: at, body: { order_ids: [oid] } });
    ok(batch.code !== 1, '批量确认没有把它算成功', JSON.stringify(batch.data));
    ok(/取消/.test(String(batch.msg || '')), '批量确认的提示也说明已取消', batch.msg);

    // ---------- 5. 统计口径 ----------
    section('[5] 已取消的订单不进入任何业务量统计');
    const dashAfter = await api('/admin/api/dashboard', { token: at });
    eq(dashAfter.data?.overview?.order_total, totalBefore - 1, '后台订单总数回退 1');
    eq(dashAfter.data?.overview?.order_today, todayBefore - 1, '后台今日订单回退 1');

    const meAfter = await api('/api/member/getMemberDetails', { token: tk });
    eq(meAfter.data?.today_orders, 0, '会员「今日订单」不计已取消');

    // 首页最近订单里也要标成已取消
    const recent = (dashAfter.data?.recent_orders || []).find((x) => Number(x.order_id) === Number(oid));
    ok(!!recent, '最近订单里能看到这笔');
    eq(recent?.status_text, '已取消', '最近订单状态文案 = 已取消');
  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
  }

  console.log('\n' + '─'.repeat(52));
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass} 项断言`);
}

main().catch((e) => {
  console.error('探针异常：', e.message);
  process.exit(1);
});
