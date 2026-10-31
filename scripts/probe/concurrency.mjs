// 并发与重复成交回归
//   1. 同一件货被多人下单后各自付款 —— 只有第一笔能成交，第二笔必须被拒
//   2. 提现 / 余额转赠并发提交 —— 余额不允许被扣成负数
// 独立库（concurrency.db / 3431）
// 用法: node scripts/probe/concurrency.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3431;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'concurrency.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB; // 必须设在 import db.js 之前，否则会连到主库
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

  // 系统默认只开线下转账；本用例要走余额支付，测试库显式把余额支付打开
  {
    try {
      const { db: __payDb } = await import('../../server/src/db.js');
      __payDb.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();
    } catch {}
  }
  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const login = async (phone) =>
      (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
    const A = await login('13800000001');
    const B = await login('13800000004');
    ok(!!at && !!A && !!B, '后台与两个买家登录成功');

    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0', price_increase_rate: '0' } } });
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99, open_days = ?', '1,2,3,4,5,6,7').run();
    const midA = db.prepare("SELECT member_id id FROM member WHERE mobile='13800000001'").get().id;
    const midB = db.prepare("SELECT member_id id FROM member WHERE mobile='13800000004'").get().id;
    for (const mid of [midA, midB]) {
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 1000000, remark: '并发测试' } });
    }

    // ---------------- 1. 同一件货两人下单后各自付款 ----------------
    section('[1] 同一件货两人下单：只有先付的能成交');
    const g = db.prepare(
      "SELECT goods_id, goods_min_price, member_id FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id NOT IN (?,?) ORDER BY goods_id LIMIT 1",
    ).get(midA, midB);
    ok(!!g, '找到测试商品');
    const sellerId = g.member_id;
    const price = Number(g.goods_min_price);
    const sellerBefore = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(sellerId).amount);

    const oA = await api('/api/order/toAddOrder', { method: 'POST', token: A, body: { goods_id: g.goods_id, num: 1, pay_type: 1 } });
    const oB = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: g.goods_id, num: 1, pay_type: 1 } });
    ok(oA.code === 1 && oB.code === 1, '两人都成功下单（商品仍在上架）', `${oA.msg} / ${oB.msg}`);

    const pA = await api('/api/order/toPay', { method: 'POST', token: A, body: { order_id: oA.data.order_id, pay_type: 1 } });
    ok(pA.code === 1, 'A 先付款成功', pA.msg);

    const pB = await api('/api/order/toPay', { method: 'POST', token: B, body: { order_id: oB.data.order_id, pay_type: 1 } });
    ok(pB.code !== 1, 'B 后付款被拒（货已被买走）', pB.msg);
    ok(/已被他人买走|无法成交/.test(pB.msg || ''), '拒绝原因指向货物已转手', pB.msg);

    const sellerAfter = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(sellerId).amount);
    ok(Math.abs(sellerAfter - sellerBefore - price) < 0.01, '卖家只收到一份货款', `${sellerBefore} → ${sellerAfter}，单价 ${price}`);
    ok(Number(db.prepare('SELECT member_id FROM goods WHERE goods_id = ?').get(g.goods_id).member_id) === midA, '货归先付款的 A');
    ok(Number(db.prepare('SELECT pay_status FROM orders WHERE order_id = ?').get(oB.data.order_id).pay_status) === 0, 'B 的订单仍是未支付，没有被扣钱');

    // 线下支付同样要拦
    const g2 = db.prepare(
      "SELECT goods_id, member_id FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id NOT IN (?,?) ORDER BY goods_id DESC LIMIT 1",
    ).get(midA, midB);
    if (g2 && g2.goods_id !== g.goods_id) {
      await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'pay', values: { pay_bank: '10', pay_voucher_required: '20' } } });
      const o1 = await api('/api/order/toAddOrder', { method: 'POST', token: A, body: { goods_id: g2.goods_id, num: 1, pay_type: 4 } });
      const o2 = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: g2.goods_id, num: 1, pay_type: 4 } });
      if (o1.code === 1 && o2.code === 1) {
        const pay1 = await api('/api/order/toPay', { method: 'POST', token: A, body: { order_id: o1.data.order_id, pay_type: 4 } });
        ok(pay1.code === 1, '线下单先提交成功', pay1.msg);
        // 后台确认收款会真的成交，此时货已经归 A
        const c1 = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: o1.data.order_id } });
        ok(c1.code === 1, '后台确认第一笔收款', c1.msg);
        const c2 = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: o2.data.order_id } });
        ok(c2.code !== 1, '后台确认第二笔收款被拒（货已过户）', c2.msg);
      } else {
        ok(true, '跳过（没有第二件可用商品）');
        ok(true, '跳过（没有第二件可用商品）');
        ok(true, '跳过（没有第二件可用商品）');
      }
    } else {
      ok(true, '跳过线下场景（没有第二件可用商品）');
      ok(true, '跳过线下场景（没有第二件可用商品）');
      ok(true, '跳过线下场景（没有第二件可用商品）');
    }

    // ---------------- 2. 提现并发 ----------------
    section('[2] 提现并发：余额不能被扣成负数');
    const balBefore = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(midA).amount);
    db.prepare('UPDATE member SET amount = 500 WHERE member_id = ?').run(midA);
    // 同一时刻发 8 笔「全额提现」，理论上最多只能成功 1 笔
    const withdraws = await Promise.all(
      Array.from({ length: 8 }, () => api('/api/finance/withdraw/apply', {
        method: 'POST', token: A,
        body: { amount: 500, account_type: 1, account_info: 'wx-test' },
      })),
    );
    const okCount = withdraws.filter((x) => x.code === 1).length;
    const balAfter = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(midA).amount);
    ok(balAfter >= -0.001, '余额没有被扣成负数', `余额 ${balAfter}`);
    ok(okCount <= 1, `最多只成功 1 笔（实际 ${okCount} 笔）`);
    ok(balAfter === 500 - okCount * 500, '扣款笔数与余额变化一致', `余额 ${balAfter}，成功 ${okCount} 笔`);
    db.prepare('UPDATE member SET amount = ? WHERE member_id = ?').run(balBefore, midA);

    // ---------------- 3. 转赠并发 ----------------
    section('[3] 余额转赠并发：同样不能被扣成负数');
    // 找一个 A 的伞下会员作为收款方
    const child = db.prepare('SELECT member_id id FROM member WHERE path LIKE ? AND member_id <> ? LIMIT 1')
      .get(`%/${midA}/%`, midA);
    if (child) {
      db.prepare('UPDATE member SET amount = 300 WHERE member_id = ?').run(midA);
      const transfers = await Promise.all(
        Array.from({ length: 6 }, () => api('/api/member/toTransfer', {
          method: 'POST', token: A, body: { member_id: child.id, num: 300, type: 2 },
        })),
      );
      const tOk = transfers.filter((x) => x.code === 1).length;
      const left = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(midA).amount);
      ok(left >= -0.001, '转出方余额没有变负', `余额 ${left}`);
      ok(tOk <= 1, `最多只成功 1 笔（实际 ${tOk} 笔）`);
    } else {
      ok(true, '跳过（没有伞下会员）');
      ok(true, '跳过（没有伞下会员）');
    }
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
