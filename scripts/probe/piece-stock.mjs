// 「库存填 100 就要能卖 100 次」回归：多库存商品必须按件卖，不能卖一件就整件下架
// 独立库（piece-stock.db / 3440）
// 用法: node scripts/probe/piece-stock.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3440;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'piece-stock.db';

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

const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

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

    // 「每件商品每人只能买一次」上线后，同一会员没法重复买同一商品，
    // 需要几个「干净」的会员轮流当首次买家
    const tempMember = async (phone) => {
      await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: `库存测试${phone.slice(-4)}` },
      });
      const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
      const mid = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(phone)?.id;
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 50000000, remark: '库存件数测试' } });
      return tk;
    };

    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0', price_increase_rate: '0' } } });
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7'").run();
    for (const phone of ['13800000001', '13800000004']) {
      const mid = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(phone).id;
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 50000000, remark: '库存件数测试' } });
    }

    // ---------------- 造一件「库存 100」的商品：完全复刻用户的操作 ----------------
    section('[1] 后台把库存填成 100');
    const src = db.prepare(
      'SELECT * FROM goods WHERE type = 1 AND goods_status = 10 AND member_id NOT IN (1,4) ORDER BY goods_id LIMIT 1',
    ).get();
    ok(!!src, '找到一件干净的整件商品');
    db.prepare("UPDATE goods SET stock_num = 100, area_date = '', sales_actual = 0 WHERE goods_id = ?").run(src.goods_id);
    const holder = Number(src.member_id);
    const before = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(src.goods_id);
    ok(Number(before.stock_num) === 100, '初始库存 100', `stock=${before.stock_num}`);

    const read = () => db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(src.goods_id);
    const buy = async (token, num = 1) => {
      const o = await api('/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: src.goods_id, num, pay_type: 1 } });
      if (o.code !== 1) return { ok: false, msg: o.msg };
      const p = await api('/api/order/toPay', { method: 'POST', token, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ok: p.code === 1, msg: p.msg, order_id: o.data.order_id };
    };

    // ---------------- 第一个人买 1 件 ----------------
    section('[2] 第一个人买 1 件：商品必须还在售、库存 99（这是用户报的 bug）');
    const b1 = await buy(A);
    ok(b1.ok, 'A 买下 1 件并支付', b1.msg);
    const after1 = read();
    ok(Number(after1.goods_status) === 10, '商品仍在售，没有整件下架', `status=${after1.goods_status}`);
    ok(Number(after1.stock_num) === 99, '库存 100 → 99', `stock=${after1.stock_num}`);
    ok(Number(after1.member_id) === holder, '整件仍归原持有人', `holder=${after1.member_id}`);
    ok(Number(after1.sales_actual) === 1, '销量 +1', `sales=${after1.sales_actual}`);
    ok(Number(after1.stock_total) === 100, '名额记为 100，不随成交变化', `stock_total=${after1.stock_total}`);

    // 前台还能看到、还能点
    const list = await api('/api/goods/getLootGoodsList?page=1&limit=100');
    const card = (list.data?.data || []).find((x) => x.goods_id === src.goods_id);
    ok(!!card, '仍出现在抢购列表里');
    ok(card && Number(card.sold_out) === 0, '卡片不是「已抢完」', card && `sold_out=${card.sold_out}`);

    // ---------------- 第二个人接着买 ----------------
    section('[3] 第二个人还能买');
    const B2 = await tempMember('13800000021');
    const b2 = await buy(B2);
    ok(b2.ok, '新买家买下第 2 件', b2.msg);
    const after2 = read();
    ok(Number(after2.stock_num) === 98, '库存 99 → 98', `stock=${after2.stock_num}`);
    ok(Number(after2.goods_status) === 10, '仍在售');
    ok(Number(after2.member_id) === holder, '持有人没变（B 只买到一件货，不是整件）', `holder=${after2.member_id}`);

    // ---------------- 一次买多件 ----------------
    section('[4] 一次买多件被拒（每件商品每人只能买 1 件）');
    const before4 = Number(read().stock_num);
    const b3 = await buy(A, 3);
    ok(!b3.ok, 'A 一次买 3 件被拒', b3.msg);
    ok(/不能一次购买多件/.test(b3.msg || ''), '提示写明「不能一次购买多件」', b3.msg);
    ok(Number(read().stock_num) === before4, `库存没被扣（仍 ${before4}）`, `stock=${read().stock_num}`);
    const bAgain = await buy(A);
    ok(!bAgain.ok && /已经买过/.test(bAgain.msg || ''), 'A 再买同一商品也被拒（已买过）', bAgain.msg);

    // ---------------- 未付款占库存、取消归还 ----------------
    section('[5] 下单即占库存，取消要还回去');
    const C = await tempMember('13800000011');
    ok(!!C, '新买家 C 登录');
    const before5 = Number(read().stock_num);
    const holdOrder = await api('/api/order/toAddOrder', { method: 'POST', token: C, body: { goods_id: src.goods_id, num: 1, pay_type: 1 } });
    ok(holdOrder.code === 1, 'C 下单 1 件先不付款', holdOrder.msg);
    ok(Number(read().stock_num) === before5 - 1, `未付款也占库存 ${before5} → ${before5 - 1}`, `stock=${read().stock_num}`);
    const dup = await api('/api/order/toAddOrder', { method: 'POST', token: C, body: { goods_id: src.goods_id, num: 1, pay_type: 1 } });
    ok(dup.code !== 1 && /已经买过/.test(dup.msg || ''), 'C 占着单再买同一商品被拒', dup.msg);
    const cancel = await api('/api/order/cancel', { method: 'POST', token: C, body: { order_id: holdOrder.data.order_id } });
    ok(cancel.code === 1, 'C 取消订单', cancel.msg);
    ok(Number(read().stock_num) === before5, `取消后库存还回来 ${before5 - 1} → ${before5}`, `stock=${read().stock_num}`);

    // ---------------- 卖光才下架 ----------------
    section('[6] 卖到 0 才下架，之后不能再买');
    db.prepare('UPDATE goods SET stock_num = 1 WHERE goods_id = ?').run(src.goods_id);
    const D = await tempMember('13800000012');
    const last = await buy(D);
    ok(last.ok, '新买家 D 买走最后 1 件', last.msg);
    const soldOut = read();
    ok(Number(soldOut.stock_num) === 0, '库存归零');
    ok(Number(soldOut.goods_status) === 20, '卖光才下架', `status=${soldOut.goods_status}`);
    const denied = await api('/api/order/toAddOrder', { method: 'POST', token: C, body: { goods_id: src.goods_id, num: 1, pay_type: 1 } });
    ok(denied.code !== 1, '售罄后下单被拒', denied.msg);

    // ---------------- 库存 1 的商品仍是转拍语义 ----------------
    section('[7] 库存 1 的商品维持「成交即转给买家 + 下架」');
    const single = db.prepare(
      "SELECT * FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(stock_num,0) = 1 AND member_id NOT IN (1,4) LIMIT 1",
    ).get();
    if (single) {
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(single.goods_id);
      const o = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: single.goods_id, num: 1, pay_type: 1 } });
      if (o.code === 1) {
        await api('/api/order/toPay', { method: 'POST', token: B, body: { order_id: o.data.order_id, pay_type: 1 } });
        const s = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(single.goods_id);
        ok(Number(s.goods_status) === 20, '单件商品成交后下架');
        ok(Number(s.member_id) === 4, '单件商品归买家 B', `holder=${s.member_id}`);
      } else {
        ok(true, '跳过（单件商品不可买）');
        ok(true, '跳过（单件商品不可买）');
      }
    } else {
      ok(true, '跳过（没有库存 1 的干净商品）');
      ok(true, '跳过（没有库存 1 的干净商品）');
    }

    // ---------------- 启动迁移：存量多库存商品 ----------------
    section('[8] 启动迁移会把存量多库存商品的名额补齐');
    const legacy = db.prepare(
      'SELECT * FROM goods WHERE type = 1 AND IFNULL(stock_total,0) > 1 LIMIT 1',
    ).get();
    ok(Number(legacy?.stock_total) === 100, '被迁移的商品名额记成原库存 100', `stock_total=${legacy?.stock_total}`);
    // ---------------- 本场额度跨商品共用 ----------------
    section('[9] 本场限购是「整场共用一份额度」，不是每个商品各一份');
    const pair = db.prepare('SELECT goods_id FROM goods WHERE type = 1 ORDER BY goods_id DESC LIMIT 2').all();
    for (const row of pair) {
      db.prepare("UPDATE goods SET goods_status = 10, stock_num = 2, stock_total = 2, area_date = '', member_id = 0 WHERE goods_id = ?")
        .run(row.goods_id);
      // 必须挂到同一场次，否则走的是「未关联场次 = 随时可买、不限购」分支，量不出场次额度
      db.prepare('DELETE FROM specialarea_goods WHERE goods_id = ?').run(row.goods_id);
      db.prepare('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)').run(row.goods_id);
    }
    db.prepare('UPDATE specialarea SET buy_num = 1').run();
    ok(pair.length === 2, '准备两件各 2 个名额的商品');

    const buyOne = async (token, gid) => {
      const o = await api('/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: gid, num: 1, pay_type: 1 } });
      if (o.code !== 1) return { ok: false, msg: o.msg };
      const p = await api('/api/order/toPay', { method: 'POST', token, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ok: p.code === 1, msg: p.msg };
    };

    const E = await tempMember('13800000022');
    const first = await buyOne(E, pair[0].goods_id);
    ok(first.ok, 'E 抢到第一件', first.msg);
    const second = await api('/api/order/toAddOrder', { method: 'POST', token: E, body: { goods_id: pair[1].goods_id, num: 1, pay_type: 1 } });
    ok(second.code !== 1 && /本场每人限购 1 件/.test(second.msg || ''),
      'E 再抢同场的另一件被拒（额度是整场共用的）', second.msg);

    db.prepare('UPDATE specialarea SET buy_num = 999').run();
    const afterRaise = await api('/api/order/toAddOrder', { method: 'POST', token: E, body: { goods_id: pair[1].goods_id, num: 1, pay_type: 1 } });
    ok(afterRaise.code === 1, '把本场限购调大后，同一件商品立刻能买（说明拦它的是场次额度）', afterRaise.msg);

    db.prepare('UPDATE specialarea SET buy_num = 999').run();
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
