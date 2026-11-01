/**
 * 抢购列表的「本场限购」标记。
 *
 * 用户反馈：上午场每人限购 1 件，抢了 1 件后列表里还有一个商品看起来能抢。
 * 实际下单会被后端拦住（order.js 有校验），但列表从来不返回限购额度，
 * 前端也就无法置灰 —— 点进去才知道买不了。
 *
 * 这里验证：
 *   1. 未登录时列表不返回限购字段（没会员就无所谓额度）
 *   2. 登录后每件货都带 purchase_limit / purchase_bought
 *   3. 抢了 1 件（额度 1）后，同场另一件货的 purchase_bought 变成 1
 *   4. 另一件货此时下单会被拒（后端口径与列表一致）
 *   5. 取消订单后额度释放，列表回到 0
 *
 * 独立库（purchase-limit.db / 3475）。
 * 用法: node scripts/probe/loot-purchase-limit.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3475;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'purchase-limit.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  const p = join(SERVER, 'data', f);
  if (existsSync(p)) unlinkSync(p);
}
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

  try {
    // 场次全开、每人限购 1 件
    // 全表都设成「全天开放 + 每人 1 件」：商品可能同时挂在多个场次，
    // displayAreaOf 会挑其中一个当代表场次，只改 1 号场会让 limit 取到别的场次（0=不限）。
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, is_open = 10, buy_num = 1').run();
    const AREA = 1;

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const reg = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13950000001', password: 'limit123456', code: 'boss01', nickName: '限购验收' },
    });
    const mid = Number(reg.data?.member_id);
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 50000, remark: '验收充值' } });
    const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13950000001', password: 'limit123456' } })).data.token;
    ok(!!tk, '会员登录');

    // 同一场次放两件商品
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mk = async (name, price) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: price, stock_num: 1, goods_status: 10, goods_sort: 1 },
      });
      const id = Number(r.data?.id);
      await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: AREA, goods_ids: [id] } });
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(id);
      return id;
    };
    const gA = await mk('限购样品-A', 1000);
    const gB = await mk('限购样品-B', 1200);
    ok(gA > 0 && gB > 0, '两件商品都已放入同一场次');

    // ---------- 1. 未登录 ----------
    section('[1] 未登录：列表不带限购字段（没有会员就无所谓额度）');
    const anon = await api(`/api/goods/getLootGoodsList?specialarea_id=${AREA}&page=1&limit=10`);
    const anonRows = anon.data?.data || [];
    ok(anonRows.length >= 2, '未登录也能看到商品列表', String(anonRows.length));
    ok(anonRows.every((x) => x.purchase_limit === undefined), '未登录返回里没有 purchase_limit');

    // ---------- 2. 登录后带额度 ----------
    section('[2] 登录后：每件货都带「本场限购」额度');
    const before = await api(`/api/goods/getLootGoodsList?specialarea_id=${AREA}&page=1&limit=10`, { token: tk });
    const bA = (before.data?.data || []).find((x) => Number(x.goods_id) === gA);
    const bB = (before.data?.data || []).find((x) => Number(x.goods_id) === gB);
    eq(bA?.purchase_limit, 1, 'A 的本场限购 = 1');
    eq(bA?.purchase_bought, 0, 'A 的已购 = 0');
    eq(bB?.purchase_bought, 0, 'B 的已购 = 0');

    // ---------- 3. 抢 A 之后 ----------
    section('[3] 抢了 A 之后：同场的 B 也标成「已抢满」');
    const od = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: gA, num: 1, pay_type: 0 } });
    ok(od.code === 1, 'A 下单成功', od.msg);
    eq(get('SELECT specialarea_id FROM orders WHERE order_id = ?', od.data.order_id).specialarea_id, AREA, '订单记下了场次（限购统计靠它）');

    const afterList = await api(`/api/goods/getLootGoodsList?specialarea_id=${AREA}&page=1&limit=10`, { token: tk });
    const aA = (afterList.data?.data || []).find((x) => Number(x.goods_id) === gA);
    const aB = (afterList.data?.data || []).find((x) => Number(x.goods_id) === gB);
    eq(aA?.purchase_bought, 1, 'A 已购 1');
    eq(aB?.purchase_bought, 1, 'B 的已购也是 1（同场合并计算）');
    ok(Number(aB?.purchase_bought) >= Number(aB?.purchase_limit), 'B 达到上限 → 前端会标「本场已抢满」');

    const loot = await api('/api/goods/getLootList', { token: tk });
    const areaRow = (loot.data?.list || []).find((x) => Number(x.specialarea_id) === AREA);
    const lB = (areaRow?.goods_list || []).find((x) => Number(x.goods_id) === gB);
    eq(lB?.purchase_limit, 1, '抢购页主列表（getLootList）同样带限购字段');
    eq(lB?.purchase_bought, 1, '主列表里 B 的已购 = 1');

    // ---------- 4. 后端确实拦 ----------
    section('[4] B 此时下单会被后端拦住（口径一致）');
    const od2 = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: gB, num: 1, pay_type: 0 } });
    ok(od2.code !== 1, 'B 下单被拒', od2.msg);
    ok(/限购|抢满|额度/.test(String(od2.msg || '')), '提示里说明是限购原因', od2.msg);

    // ---------- 5. 取消后额度释放 ----------
    section('[5] 取消 A 的订单：额度释放，B 又能抢');
    const cc = await api('/api/order/cancel', { method: 'POST', token: tk, body: { order_id: od.data.order_id } });
    ok(cc.code === 1, '取消成功', cc.msg);
    const afterCancel = await api(`/api/goods/getLootGoodsList?specialarea_id=${AREA}&page=1&limit=10`, { token: tk });
    const cB = (afterCancel.data?.data || []).find((x) => Number(x.goods_id) === gB);
    eq(cB?.purchase_bought, 0, '取消后 B 的已购回到 0');
    const od3 = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: gB, num: 1, pay_type: 0 } });
    ok(od3.code === 1, '取消后 B 可以正常下单', od3.msg);
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
