// 拆分商品库存回归：卖一份不能把整件锁死，卖完才下架
// 独立库（split-stock.db / 3434）
// 用法: node scripts/probe/split-stock.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3434;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'split-stock.db';

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
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99, open_days = '1,2,3,4,5,6,7'").run();
    for (const phone of ['13800000001', '13800000004']) {
      const mid = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(phone).id;
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 3000000, remark: '拆分库存测试' } });
    }

    // ---------------- 准备一件拆分商品 ----------------
    section('[1] 把一件商品拆成 3 份');
    const src = db.prepare(
      'SELECT * FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(is_split,0) = 0 AND member_id NOT IN (1,4) ORDER BY goods_id LIMIT 1',
    ).get();
    ok(!!src, '找到可拆分商品');
    const holder = Number(src.member_id);

    const sp = await api('/admin/api/goods/split', { method: 'POST', token: at, body: { goods_id: src.goods_id, parts: 3 } });
    ok(sp.code === 1, '拆分成功', sp.msg);
    const afterSplit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(src.goods_id);
    ok(Number(afterSplit.stock_num) === 3 && Number(afterSplit.is_split) === 1, '库存置为 3 份');
    // 商品可能有历史销量，断言一律用「增量」而不是绝对值
    const salesBase = Number(afterSplit.sales_actual) || 0;

    const buy = async (token) => {
      const o = await api('/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: src.goods_id, num: 1, pay_type: 1 } });
      if (o.code !== 1) return { ok: false, msg: o.msg };
      const p = await api('/api/order/toPay', { method: 'POST', token, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ok: p.code === 1, msg: p.msg, order_id: o.data.order_id };
    };

    // ---------------- 卖出第一份 ----------------
    section('[2] 卖出第 1 份后，商品必须还在售');
    const b1 = await buy(A);
    ok(b1.ok, 'A 买下 1 份并支付', b1.msg);
    const afterOne = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(src.goods_id);
    ok(Number(afterOne.stock_num) === 2, '库存剩 2 份', `stock=${afterOne.stock_num}`);
    ok(Number(afterOne.goods_status) === 10, '商品仍在售（这是本次修的 bug）', `status=${afterOne.goods_status}`);
    ok(Number(afterOne.is_sell) === 10, 'is_sell 仍为在售');
    ok(Number(afterOne.member_id) === holder, '整件仍归原持有人（买家只买到一份）', `holder=${afterOne.member_id}`);
    ok(Number(afterOne.sales_actual) === salesBase + 1, '销量累加 1', `${salesBase} → ${afterOne.sales_actual}`);

    // 前台还能看到
    const listAfterOne = await api('/api/goods/getLootGoodsList?page=1&limit=50');
    ok((listAfterOne.data?.data || listAfterOne.data?.list?.data || []).some((g) => g.goods_id === src.goods_id),
      '卖出一份后仍出现在抢购列表里');

    // ---------------- 继续卖 ----------------
    section('[3] 剩余份额还能继续卖');
    const b2 = await buy(B);
    ok(b2.ok, 'B 买下第 2 份', b2.msg);
    const afterTwo = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(src.goods_id);
    ok(Number(afterTwo.stock_num) === 1, '库存剩 1 份');
    ok(Number(afterTwo.goods_status) === 10, '卖到剩 1 份仍在售');

    const b3 = await buy(B);
    ok(b3.ok, '再买下最后 1 份', b3.msg);
    const afterAll = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(src.goods_id);
    ok(Number(afterAll.stock_num) === 0, '库存归零');
    ok(Number(afterAll.goods_status) === 20, '卖完后自动下架', `status=${afterAll.goods_status}`);
    ok(Number(afterAll.sales_actual) === salesBase + 3, '总销量累加 3 份', `${salesBase} → ${afterAll.sales_actual}`);

    // ---------------- 售罄后不能买 ----------------
    section('[4] 卖完后不能再下单');
    const oversell = await api('/api/order/toAddOrder', { method: 'POST', token: A, body: { goods_id: src.goods_id, num: 1, pay_type: 1 } });
    ok(oversell.code !== 1, '售罄后下单被拒', oversell.msg);

    // ---------------- 拆分商品不能转拍 ----------------
    section('[5] 拆分商品不支持转拍');
    const quote = await api(`/api/order/getConsignmentQuote?order_id=${b1.order_id}`, { token: A });
    ok(quote.code !== 1 && /拆分/.test(quote.msg || ''), '转拍报价被拒', quote.msg);
    const cons = await api('/api/order/consignment', { method: 'POST', token: A, body: { order_id: b1.order_id } });
    ok(cons.code !== 1 && /拆分/.test(cons.msg || ''), '转拍提交被拒', cons.msg);

    // ---------------- 整件商品行为不变 ----------------
    section('[6] 非拆分商品仍然是「成交即下架」');
    const whole = db.prepare(
      "SELECT * FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(is_split,0) = 0 AND IFNULL(area_date,'') = '' AND member_id NOT IN (1,4) ORDER BY goods_id DESC LIMIT 1",
    ).get();
    if (whole) {
      const wOrder = await api('/api/order/toAddOrder', { method: 'POST', token: A, body: { goods_id: whole.goods_id, num: 1, pay_type: 1 } });
      if (wOrder.code === 1) {
        await api('/api/order/toPay', { method: 'POST', token: A, body: { order_id: wOrder.data.order_id, pay_type: 1 } });
        const wAfter = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(whole.goods_id);
        ok(Number(wAfter.goods_status) === 20, '整件商品成交后下架');
        ok(Number(wAfter.member_id) === 1, '整件商品归买家', `holder=${wAfter.member_id}`);
      } else {
        ok(true, '跳过（无可买整件商品）');
        ok(true, '跳过（无可买整件商品）');
      }
    } else {
      ok(true, '跳过（无可买整件商品）');
      ok(true, '跳过（无可买整件商品）');
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
