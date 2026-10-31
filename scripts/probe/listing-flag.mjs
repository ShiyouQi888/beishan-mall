/**
 * 「已挂牌」标记在所有权转移时必须归零。
 *
 * 背景：转拍上架会把订单的 consignment_status 置 10，表示「这一手挂在场上等下一手」。
 * 但这件货被买走、完成过户之后，上一手的挂牌就结束了 —— 原来 settleOrder 不清这个标记，
 * 同一件货会累积多条「在挂」记录（演示库 goods 5 / 6 各有两条），
 * 任何按 consignment_status 统计的地方都会多算。
 *
 * 覆盖：
 *   1. A 买 → 转拍（标记 10）→ B 买走 → A 那一手必须归 0
 *   2. B 转拍 → C 买走 → B 那一手归 0，A 的仍是 0
 *   3. 不变量：全库不存在「货不在订单会员手上、标记却还是 10」的记录
 *   4. 启动清理函数 cleanStaleListingFlags()：能清掉人为构造的脏数据，且幂等
 *
 * 独立库（listing-flag.db / 3463），跑完销毁。
 * 用法: node scripts/probe/listing-flag.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3463;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'listing-flag.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
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
  const { db, run, get, all } = await import('../../server/src/db.js');
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  // 场次全天开放、不限转拍时限、上架费与涨价率都设 0（只验标记，不掺财务）
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, transposition_hours = 0, buy_num = 999, is_open = 10');
  run("UPDATE setting_config SET `value` = '0' WHERE `key` IN ('listing_fee_rate', 'price_increase_rate', 'service_charge')");
  run("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'");

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

  const goodsIdRef = { id: 0 };
  const memberIds = [];
  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const mkUser = async (phone) => {
      await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: `标记${phone.slice(-4)}` },
      });
      const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
      const mid = Number(get('SELECT member_id id FROM member WHERE mobile = ?', phone)?.id);
      memberIds.push(mid);
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000000, remark: '标记验收' },
      });
      return { tk, mid };
    };

    const A = await mkUser('13911000111');
    const B = await mkUser('13911000112');
    const C = await mkUser('13911000113');

    // 一件平台持有的唯一件，挂到场次 1
    const gid = Number(run(
      `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
         member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
         goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
       VALUES ('标记验收样品','LF-1','/uploads/demo-1.svg','[]','',1,0,'',0,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
    ).lastInsertRowid);
    goodsIdRef.id = gid;
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', gid);

    /** 下单 + 余额支付 */
    const buyAndPay = async (u) => {
      const o = await api('/api/order/toAddOrder', { method: 'POST', token: u.tk, body: { goods_id: gid, num: 1, pay_type: 1 } });
      if (o.code !== 1) return { ok: false, msg: o.msg };
      const p = await api('/api/order/toPay', { method: 'POST', token: u.tk, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ok: p.code === 1, msg: p.msg, order_id: o.data.order_id };
    };
    const flagOf = (oid) => Number(get('SELECT consignment_status FROM orders WHERE order_id = ?', oid)?.consignment_status ?? -1);
    const listedCount = () => Number(get(
      `SELECT COUNT(*) c FROM orders WHERE goods_id = ? AND IFNULL(consignment_status,0) = 10`, gid,
    ).c);

    section('[1] A 买 → 转拍 → B 买走');
    const a1 = await buyAndPay(A);
    ok(a1.ok, 'A 买下并支付', a1.msg);
    eq(flagOf(a1.order_id), 0, 'A 的订单初始不在挂');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', gid).member_id, A.mid, '货已过户给 A');

    const cA = await api('/api/order/consignment', { method: 'POST', token: A.tk, body: { order_id: a1.order_id } });
    ok(cA.code === 1, 'A 转拍上架', cA.msg);
    eq(flagOf(a1.order_id), 10, 'A 这一手标记为在挂');

    const b1 = await buyAndPay(B);
    ok(b1.ok, 'B 买下并支付', b1.msg);
    eq(flagOf(a1.order_id), 0, '★ B 买走后，A 那一手自动归零');
    eq(flagOf(b1.order_id), 0, 'B 的新订单本来就不在挂');
    eq(listedCount(), 0, '这件货当前没有任何「在挂」记录');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', gid).member_id, B.mid, '货已过户给 B');

    section('[2] B 买 → 转拍 → C 买走');
    const cB = await api('/api/order/consignment', { method: 'POST', token: B.tk, body: { order_id: b1.order_id } });
    ok(cB.code === 1, 'B 转拍上架', cB.msg);
    eq(flagOf(b1.order_id), 10, 'B 这一手标记为在挂');
    eq(flagOf(a1.order_id), 0, 'A 那一手仍是 0（不会被重复点亮）');
    eq(listedCount(), 1, '此刻只有 1 条在挂记录（不再累积）');

    const c1 = await buyAndPay(C);
    ok(c1.ok, 'C 买下并支付', c1.msg);
    eq(flagOf(b1.order_id), 0, '★ C 买走后，B 那一手自动归零');
    eq(listedCount(), 0, '过户后没有残留的在挂记录');

    section('[3] 全库不变量');
    const stale = all(
      `SELECT o.order_id, o.goods_id, o.member_id, g.member_id AS holder
       FROM orders o JOIN goods g ON g.goods_id = o.goods_id
       WHERE IFNULL(o.consignment_status, 0) = 10 AND IFNULL(g.member_id, 0) <> o.member_id`,
    );
    eq(stale.length, 0, '不存在「货不在他手上却还标着在挂」的订单', JSON.stringify(stale));

    section('[4] 启动清理函数（历史脏数据）');
    run('UPDATE orders SET consignment_status = 10 WHERE goods_id = ?', gid);
    eq(listedCount(), 3, '人为把 3 条都改成在挂（货当前在 C 手上）');
    const { cleanStaleListingFlags } = await import('../../server/src/lib/listing.js');
    const fixed = cleanStaleListingFlags();
    // A、B 的订单「货已经不在他们手上」，属于脏数据；C 是当前持有人，他那条是合法在挂，必须保留
    eq(fixed, 2, '清理函数只清掉 A、B 两条脏数据');
    eq(listedCount(), 1, 'C 那条合法在挂被保留');
    eq(cleanStaleListingFlags(), 0, '再跑一次是幂等的（没有可清的了）');
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', c1.order_id).consignment_status, 10,
      '当前持有人的在挂标记没被误清');
  } finally {
    try { srv.kill(); } catch {}
    if (goodsIdRef.id) {
      const oids = db.prepare('SELECT order_id FROM orders WHERE goods_id = ?').all(goodsIdRef.id).map((x) => x.order_id);
      for (const oid of oids) {
        run('DELETE FROM order_log WHERE order_id = ?', oid);
        run('DELETE FROM orders WHERE order_id = ?', oid);
      }
      run('DELETE FROM specialarea_goods WHERE goods_id = ?', goodsIdRef.id);
      run('DELETE FROM goods WHERE goods_id = ?', goodsIdRef.id);
    }
    for (const mid of memberIds) {
      if (!mid) continue;
      for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
        run(`DELETE FROM ${t} WHERE member_id = ?`, mid);
      }
      run('DELETE FROM member WHERE member_id = ?', mid);
    }
    console.log('\n已清理测试数据');
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项，通过 ${pass} 项`);
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass} 项断言`);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  process.exit(1);
});
