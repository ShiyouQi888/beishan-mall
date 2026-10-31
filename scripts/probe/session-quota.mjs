// 每场放量回归：库存 100 件、本场只放 10 件，抢满即结束变灰，剩下的留到下一场
// 独立库（session-quota.db / 3443）
// 用法: node scripts/probe/session-quota.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3443;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'session-quota.db';

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

const runSeed = () => new Promise((resolve, reject) => {
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
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7'").run();
    for (const phone of ['13800000001', '13800000004']) {
      const mid = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(phone).id;
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 90000000, remark: '放量测试' } });
    }

    // ---------------- 库存 100 / 每场放 10 ----------------
    section('[1] 库存 100 件，本场只放 10 件');
    const src = db.prepare(
      'SELECT * FROM goods WHERE type = 1 AND member_id NOT IN (1,4) ORDER BY goods_id LIMIT 1',
    ).get();
    // seed 可能给这件商品留了历史订单，先清掉，否则「本场已售」一开始就不是 0
    db.prepare('DELETE FROM orders WHERE goods_id = ?').run(src.goods_id);
    db.prepare(`UPDATE goods SET goods_status = 10, goods_min_price = 1000, line_price = 1200,
      stock_num = 100, stock_total = 100, sales_actual = 0,
      session_quota = 10, area_date = '', member_id = 0 WHERE goods_id = ?`).run(src.goods_id);
    const GID = src.goods_id;
    const read = () => db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(GID);
    ok(Number(read().session_quota) === 10 && Number(read().stock_num) === 100, '配置正确',
      `quota=${read().session_quota} stock=${read().stock_num}`);

    const buy = async (token, num) => {
      const o = await api('/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: GID, num, pay_type: 1 } });
      if (o.code !== 1) return { ok: false, msg: o.msg };
      const p = await api('/api/order/toPay', { method: 'POST', token, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ok: p.code === 1, msg: p.msg, order_id: o.data.order_id };
    };

    // ---------------- 卖 3 件 ----------------
    section('[2] A 买 3 件：本场还剩 7 件可抢');
    const b1 = await buy(A, 3);
    ok(b1.ok, 'A 买 3 件成功', b1.msg);
    const list1 = await api('/api/goods/getLootGoodsList?page=1&limit=100');
    const card1 = (list1.data?.data || []).find((x) => x.goods_id === GID);
    ok(!!card1 && Number(card1.session_quota) === 10, '列表带出本场放量 10', card1 && `quota=${card1.session_quota}`);
    ok(!!card1 && Number(card1.session_sold) === 3, '列表带出本场已售 3', card1 && `sold=${card1.session_sold}`);
    ok(!!card1 && Number(card1.session_left) === 7, '本场还剩 7 件', card1 && `left=${card1.session_left}`);
    ok(!!card1 && Number(card1.sold_out) === 0, '还能继续卖', card1 && `sold_out=${card1.sold_out}`);
    ok(Number(read().stock_num) === 97, '总库存 100 → 97（放量和库存各扣各的）', `stock=${read().stock_num}`);

    // ---------------- 超放量被拒 ----------------
    section('[3] 想买 8 件：超过本场剩余的 7 件，必须被拒');
    const over = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: GID, num: 8, pay_type: 1 } });
    ok(over.code !== 1 && /本场|限量|只剩/.test(over.msg || ''), '超出本场放量被拒', over.msg);

    // ---------------- 买满 10 件 ----------------
    section('[4] 再买 7 件：本场 10 件抢满，商品变灰');
    const b2 = await buy(B, 7);
    ok(b2.ok, 'B 买下剩余 7 件', b2.msg);
    const after = read();
    ok(Number(after.stock_num) === 90, '总库存还剩 90 件（这一场只放了 10 件）', `stock=${after.stock_num}`);
    ok(Number(after.goods_status) === 10, '商品仍在架（不是真的卖光了）', `status=${after.goods_status}`);

    const list2 = await api('/api/goods/getLootGoodsList?page=1&limit=100');
    const card2 = (list2.data?.data || []).find((x) => x.goods_id === GID);
    ok(!!card2, '列表里仍然有它（不消失）');
    ok(!!card2 && Number(card2.sold_out) === 1, '已标为不可抢（灰卡）', card2 && `sold_out=${card2.sold_out}`);
    ok(!!card2 && Number(card2.session_full) === 1, '原因是「本场已满」而不是库存卖光', card2 && `session_full=${card2.session_full}`);

    const det = await api(`/api/goods/getLootDetails?goods_id=${GID}`, { token: B });
    ok(Number(det.data?.session_full) === 1 && Number(det.data?.session_sold) === 10,
      '详情页：本场已满、已售 10', `full=${det.data?.session_full} sold=${det.data?.session_sold}`);

    section('[5] 本场满之后不能再抢');
    const denied = await api('/api/order/toAddOrder', { method: 'POST', token: A, body: { goods_id: GID, num: 1, pay_type: 1 } });
    ok(denied.code !== 1, '再抢被拒', denied.msg);
    ok(/本场|抢完|下一场/.test(denied.msg || ''), '提示指向「本场已抢完」，不是「已下架」', denied.msg);

    // ---------------- 第二天自动重新放量 ----------------
    section('[6] 到了下一场（把订单日期挪到昨天）：自动恢复，重新放 10 件');
    db.prepare("UPDATE orders SET create_time = datetime('now', 'localtime', '-1 day') WHERE goods_id = ?").run(GID);
    const list3 = await api('/api/goods/getLootGoodsList?page=1&limit=100');
    const card3 = (list3.data?.data || []).find((x) => x.goods_id === GID);
    ok(!!card3 && Number(card3.session_sold) === 0, '本场已售清零（新的一场）', card3 && `sold=${card3.session_sold}`);
    ok(!!card3 && Number(card3.sold_out) === 0, '重新可抢', card3 && `sold_out=${card3.sold_out}`);
    ok(!!card3 && Number(card3.session_left) === 10, '新一场又有 10 件额度', card3 && `left=${card3.session_left}`);
    ok(Number(read().stock_num) === 90, '总库存仍是 90（卖掉的不会退回来）');

    // ---------------- 放量 0 = 不限量 ----------------
    section('[7] 放量填 0 时退回「整批库存都能卖」');
    db.prepare('UPDATE goods SET session_quota = 0 WHERE goods_id = ?').run(GID);
    const card4 = ((await api('/api/goods/getLootGoodsList?page=1&limit=100')).data?.data || []).find((x) => x.goods_id === GID);
    ok(!!card4 && Number(card4.session_quota) === 0 && Number(card4.session_full) === 0, '不限量：不按本场截断',
      card4 && `quota=${card4.session_quota} full=${card4.session_full}`);
    ok(!!card4 && card4.session_left === null, '不限量时剩余额度为 null', card4 && `left=${card4.session_left}`);

    // ---------------- 放量 + 限购 = 人数 ----------------
    section('[8] 放 10 个名额 + 每人限 1 件 = 正好 10 个人能抢到');
    db.prepare('UPDATE goods SET session_quota = 10, stock_num = 50 WHERE goods_id = ?').run(GID);
    db.prepare('UPDATE specialarea SET buy_num = 1').run();
    // A/B 前面已经买过这个商品，不清掉的话限购 1 件会先把他们拦在门外
    db.prepare('DELETE FROM orders WHERE goods_id = ?').run(GID);
    // 造 10 个会员，各抢 1 件
    const phones = ['13800000001', '13800000004'];
    const extra = [];
    for (let i = 0; i < 8; i++) {
      const phone = `1390000000${i}`;
      const created = await api('/admin/api/member/save', {
        method: 'POST', token: at,
        body: { mobile: phone, password: phone, nick_name: `放量测试${i}` },
      });
      if (created.code === 1) {
        await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: created.data.id, field: 'amount', value: 5000000, remark: '放量人数' } });
        const tk = await login(phone);
        if (tk) extra.push(tk);
      }
    }
    const buyers = [A, B, ...extra].slice(0, 10);
    let bought = 0;
    for (const tk of buyers) {
      const r = await buy(tk, 1);
      if (r.ok) bought++;
    }
    ok(bought === 10, '10 个会员各抢到 1 件', `实际 ${bought} 人`);
    const card5 = ((await api('/api/goods/getLootGoodsList?page=1&limit=100')).data?.data || []).find((x) => x.goods_id === GID);
    ok(!!card5 && Number(card5.session_full) === 1, '10 个名额刚好用完，本场结束', card5 && `full=${card5.session_full}`);
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
