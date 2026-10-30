// 场次流转：成交即下架 → 转拍落到下一场 → 场次顺序为 上午/下午/晚上
// 独立库（session-rotation.db / 3415），不碰演示库
// 用法: node scripts/probe/session-rotation.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3415;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'session-rotation.db';

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
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    // 场次时间放开成全天然，避免探针在非营业时段跑不通（时段本身由 session-window.mjs 覆盖）
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399').run();
    // 上架费设 0，避免余额不足挡住转拍
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { listing_fee_rate: '0', service_charge: '0' } } });

    const pad = (n) => String(n).padStart(2, '0');
    const d0 = new Date();
    const today = d0.getFullYear() + '-' + pad(d0.getMonth() + 1) + '-' + pad(d0.getDate());
    const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
    const tomorrow = d1.getFullYear() + '-' + pad(d1.getMonth() + 1) + '-' + pad(d1.getDate());

    const areas = db.prepare('SELECT * FROM specialarea ORDER BY specialarea_id').all();
    const fore = areas.find((a) => a.name === 'forenoon');
    const after = areas.find((a) => a.name === 'afternoon');
    const even = areas.find((a) => a.name === 'evening');
    ok(!!fore && !!after && !!even, '演示数据有上午/下午/晚上三个场次');

    // 买家：seed 里的分销链成员
    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const buyer2 = db.prepare("SELECT * FROM member WHERE mobile = '13800000002'").get();
    const tokenOf = async (m) =>
      (await api('/api/member/accountLogin', { method: 'POST', body: { phone: m.mobile, password: m.mobile } })).data?.token;
    const t1 = await tokenOf(buyer);
    const t2 = buyer2 ? await tokenOf(buyer2) : '';
    ok(!!t1, '买家1 登录');
    ok(!!t2, '买家2 登录');
    for (const m of [buyer, buyer2]) {
      if (m) await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: m.member_id, field: 'amount', value: 900000, remark: '冒烟充值' } });
    }

    // ---------- 场次顺序 ----------
    section('[1] 场次顺序：上午 → 下午 → 晚上');
    const loot0 = await api('/api/goods/getLootList');
    const names = (loot0.data?.list || []).map((a) => a.name);
    eq(names.join(','), 'forenoon,afternoon,evening', '抢购页场次顺序正确');

    // ---------- 成交即下架 ----------
    section('[2] 上午场买下商品：立即下架，不再出现在场次里');
    const target = db.prepare(
      "SELECT goods_id, goods_name, goods_min_price FROM goods WHERE type = 1 AND goods_status = 10 AND specialarea_id = ? AND member_id <> ? LIMIT 1",
    ).get(fore.specialarea_id, buyer.member_id);
    ok(!!target, '上午场有可买商品', JSON.stringify(target));

    const order = await api('/api/order/toAddOrder', { method: 'POST', token: t1, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(order.code === 1, '下单成功', order.msg);
    const paid = await api('/api/order/toPay', { method: 'POST', token: t1, body: { order_id: order.data.order_id, pay_type: 1 } });
    ok(paid.code === 1, '支付成功', paid.msg);

    const gAfterPay = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(target.goods_id);
    eq(gAfterPay.goods_status, 20, '成交后商品下架(20)');
    eq(gAfterPay.member_id, buyer.member_id, '商品归买家');

    const loot1 = await api('/api/goods/getLootList');
    const foreGoods = (loot1.data?.list || []).find((a) => a.name === 'forenoon')?.goods_list || [];
    ok(!foreGoods.some((g) => g.goods_id === target.goods_id), '上午场列表里不再有这件商品');
    const allListed = (loot1.data?.list || []).flatMap((a) => (a.goods_list || []).map((g) => g.goods_id));
    ok(!allListed.includes(target.goods_id), '所有场次都不再出现它（别人不能按原价再抢）');

    const shop = await api('/api/member/myShop', { token: t1 });
    const mine = (shop.data?.list || []).find((x) => x.goods_id === target.goods_id);
    ok(!!mine, '我的店铺里能看到它（等转拍）');
    ok(mine && mine.listed === false, '状态是「待转拍」');

    // ---------- 转拍 → 下一场 ----------
    section('[3] 转拍上架：落到下一个场次（下午场）');
    const cons = await api('/api/order/consignment', { method: 'POST', token: t1, body: { order_id: order.data.order_id } });
    ok(cons.code === 1, '转拍成功', cons.msg);
    const gAfterCons = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(target.goods_id);
    eq(gAfterCons.goods_status, 10, '重新上架(10)');
    eq(gAfterCons.specialarea_id, after.specialarea_id, '进入下午场');
    ok(Number(gAfterCons.goods_min_price) > Number(target.goods_min_price), '标价按涨价率上调', `${target.goods_min_price} → ${gAfterCons.goods_min_price}`);

    const loot2 = await api('/api/goods/getLootList');
    const afterGoods = (loot2.data?.list || []).find((a) => a.name === 'afternoon')?.goods_list || [];
    ok(afterGoods.some((g) => g.goods_id === target.goods_id), '下午场列表里出现了它');

    // ---------- 第二轮：下午场被买走 → 再转拍进晚上 ----------
    section('[4] 下午场再被买走 → 转拍进晚上场');
    const order2 = await api('/api/order/toAddOrder', { method: 'POST', token: t2, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(order2.code === 1, '买家2 在下午场抢到它', order2.msg);
    await api('/api/order/toPay', { method: 'POST', token: t2, body: { order_id: order2.data.order_id, pay_type: 1 } });
    const cons2 = await api('/api/order/consignment', { method: 'POST', token: t2, body: { order_id: order2.data.order_id } });
    ok(cons2.code === 1, '买家2 转拍成功', cons2.msg);
    const g3 = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(target.goods_id);
    eq(g3.specialarea_id, even.specialarea_id, '进入晚上场');

    // ---------- 环形：晚上场再转拍回到上午场 ----------
    section('[5] 跨天：晚上场再转拍 → 明天上午场（不是今天）');
    const buyer3 = db.prepare("SELECT * FROM member WHERE member_id NOT IN (?, ?) AND is_valid = 10 AND disabled = 10 LIMIT 1").get(buyer.member_id, buyer2.member_id);
    const t3 = buyer3 ? await tokenOf(buyer3) : '';
    if (t3) {
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer3.member_id, field: 'amount', value: 900000, remark: '冒烟充值' } });
      const order3 = await api('/api/order/toAddOrder', { method: 'POST', token: t3, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
      ok(order3.code === 1, '买家3 在晚上场抢到它', order3.msg);
      await api('/api/order/toPay', { method: 'POST', token: t3, body: { order_id: order3.data.order_id, pay_type: 1 } });
      const cons3 = await api('/api/order/consignment', { method: 'POST', token: t3, body: { order_id: order3.data.order_id } });
      ok(cons3.code === 1, '买家3 转拍成功', cons3.msg);
      const g4 = db.prepare('SELECT specialarea_id, area_date FROM goods WHERE goods_id = ?').get(target.goods_id);
      eq(g4.specialarea_id, fore.specialarea_id, '落到第一场（上午场）');
      eq(g4.area_date, tomorrow, '日期顺延到明天，而不是今天');

      // 今天不该再看到、也不该能抢
      const lootToday = await api('/api/goods/getLootList');
      const idsToday = (lootToday.data?.list || []).flatMap((a) => (a.goods_list || []).map((x) => x.goods_id));
      ok(!idsToday.includes(target.goods_id), '今天的场次列表里不再出现它');

      const listToday = await api('/api/goods/getLootGoodsList?page=1&limit=50');
      ok(!(listToday.data?.data || []).some((x) => x.goods_id === target.goods_id), '首页瀑布流也不再出现它');

      const buyer4 = db.prepare('SELECT * FROM member WHERE member_id NOT IN (?, ?, ?) AND is_valid = 10 AND disabled = 10 LIMIT 1').get(buyer.member_id, buyer2.member_id, buyer3.member_id);
      if (buyer4) {
        await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer4.member_id, field: 'amount', value: 900000, remark: '冒烟充值' } });
        const t4 = await tokenOf(buyer4);
        const early = await api('/api/order/toAddOrder', { method: 'POST', token: t4, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
        ok(early.code === 0 && /将在/.test(early.msg), '今天提前抢被拒', early.msg);
      }

      // 把日期改成今天，模拟「到了第二天」→ 又能抢
      db.prepare('UPDATE goods SET area_date = ? WHERE goods_id = ?').run(today, target.goods_id);
      const lootNext = await api('/api/goods/getLootList');
      const foreList = (lootNext.data?.list || []).find((a) => a.name === 'forenoon')?.goods_list || [];
      ok(foreList.some((x) => x.goods_id === target.goods_id), '到了那天，第一场就出现它');
    } else {
      ok(false, '买家3 在晚上场抢到它', '没有可用的第三个会员');
    }
    section('[6] 一天只有一场：抢完只能明天再抢');
    // 只留上午场，模拟「一天一场」的配置
    db.prepare('UPDATE specialarea SET is_open = 20 WHERE name <> ?').run('forenoon');
    db.prepare('UPDATE goods SET specialarea_id = ?, area_date = ? WHERE goods_id = ?').run(fore.specialarea_id, today, target.goods_id);
    const solo = db.prepare("SELECT * FROM member WHERE member_id NOT IN (?, ?, ?) AND is_valid = 10 AND disabled = 10 LIMIT 1").get(buyer.member_id, buyer2.member_id, buyer3.member_id);
    if (solo) {
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: solo.member_id, field: 'amount', value: 900000, remark: '冒烟充值' } });
      const ts = await tokenOf(solo);
      const o6 = await api('/api/order/toAddOrder', { method: 'POST', token: ts, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
      ok(o6.code === 1, '唯一场次里抢到它', o6.msg);
      await api('/api/order/toPay', { method: 'POST', token: ts, body: { order_id: o6.data.order_id, pay_type: 1 } });
      const c6 = await api('/api/order/consignment', { method: 'POST', token: ts, body: { order_id: o6.data.order_id } });
      ok(c6.code === 1, '转拍成功', c6.msg);
      const g6 = db.prepare('SELECT specialarea_id, area_date FROM goods WHERE goods_id = ?').get(target.goods_id);
      eq(g6.specialarea_id, fore.specialarea_id, '还是同一场次');
      eq(g6.area_date, tomorrow, '但日期是明天');
      const loot6 = await api('/api/goods/getLootList');
      const ids6 = (loot6.data?.list || []).flatMap((a) => (a.goods_list || []).map((x) => x.goods_id));
      ok(!ids6.includes(target.goods_id), '今天已经看不到它');
    } else {
      ok(false, '唯一场次里抢到它', '没有可用会员');
    }
    db.prepare('UPDATE specialarea SET is_open = 10').run();

  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main()
  .catch((e) => { console.error('\n[错误]', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
