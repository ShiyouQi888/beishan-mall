// 「支付凭证必传」开关回归
// 覆盖：开关开启时必须上传凭证（前后端都拦）、关闭时两端都放行、
//       关闭时不会清空已上传的凭证、余额支付完全不受影响。
// 独立库（voucher.db / 3424）
// 用法: node scripts/probe/voucher-switch.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3424;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'voucher.db';

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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const mt = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: buyer.mobile, password: buyer.mobile } })).data?.token;
    ok(!!mt, '会员登录');

    // 线下转账方式本身要开着，否则测的是「支付方式未开放」而不是凭证开关
    const savePay = (values) => api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'pay', values } });
    await savePay({ pay_bank: '10' });
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99').run();
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: buyer.member_id, field: 'amount', value: 900000, remark: '测试充值' },
    });

    /** 每次都要找一件「不属于买家、在售」的商品，下单成功后就不能再用 */
    // 抢购是提交即锁单：选商品时要跳过已被未支付订单占住的货
    const pickGoods = () => db.prepare(
      `SELECT goods_id FROM goods
       WHERE type = 1 AND goods_status = 10 AND IFNULL(area_date,'') = '' AND member_id <> ?
         AND goods_id NOT IN (SELECT goods_id FROM orders WHERE IFNULL(status, 0) = 0 AND IFNULL(pay_status, 0) = 0)
       ORDER BY goods_id LIMIT 1`,
    ).get(buyer.member_id);

    const newOrder = async (payType = 4) => {
      const g = pickGoods();
      if (!g) throw new Error('没有可下单的商品了');
      const r = await api('/api/order/toAddOrder', {
        method: 'POST', token: mt, body: { goods_id: g.goods_id, num: 1, pay_type: payType },
      });
      if (r.code !== 1) throw new Error('下单失败：' + r.msg);
      return r.data.order_id;
    };
    const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE order_id = ?').get(id);
    const paySetting = async () => (await api('/api/index/getPaySeeting')).data;

    // ---------------- 开关默认状态 ----------------
    section('[1] 默认：开关为「必传」');
    ok((await paySetting()).voucher_required === '1', '接口下发 voucher_required=1');
    const payGroup = (await api('/admin/api/setting/pay', { token: at })).data?.items || [];
    ok(payGroup.some((i) => i.k === 'pay_voucher_required'), '后台支付设置里有「支付凭证必传」开关');

    // ---------------- 必传：两端都拦 ----------------
    section('[2] 必传时：会员端没凭证过不去');
    const o1 = await newOrder();
    const noVoucher = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o1, pay_type: 4 } });
    ok(noVoucher.code !== 1, '无凭证提交被拒', noVoucher.msg);
    ok(/凭证/.test(noVoucher.msg || ''), '被拒原因指向凭证', noVoucher.msg);
    ok(orderRow(o1).pay_status === 0, '被拒后订单仍是未支付');

    const up = await fetch(`${BASE}/api/upload/image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mt}` },
      body: (() => { const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'p.png'); return fd; })(),
    }).then((r) => r.json());
    const vurl = up.data?.url || up.data?.path;
    ok(!!vurl, '上传凭证图成功', up.msg);

    const withVoucher = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o1, pay_type: 4, voucher: vurl } });
    ok(withVoucher.code === 1, '带凭证提交成功', withVoucher.msg);
    ok(/凭证/.test(withVoucher.msg || ''), '提示语是「凭证已提交」', withVoucher.msg);
    ok(orderRow(o1).pay_voucher === vurl, '凭证已落到订单上');

    section('[3] 必传时：后台确认收款也要求凭证');
    const o2 = await newOrder();
    const confirmNoVoucher = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: o2 } });
    ok(confirmNoVoucher.code !== 1, '无凭证订单不能直接确认收款', confirmNoVoucher.msg);
    ok(orderRow(o2).pay_status === 0, '被拒后订单仍未支付');

    // ---------------- 关闭开关 ----------------
    section('[4] 关掉开关：会员端不再要求凭证');
    await savePay({ pay_voucher_required: '20' });
    ok((await paySetting()).voucher_required === '0', '接口下发 voucher_required=0');

    const o3 = await newOrder();
    const freePay = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o3, pay_type: 4 } });
    ok(freePay.code === 1, '无凭证也能提交', freePay.msg);
    ok(!/凭证/.test(freePay.msg || ''), '提示语不再提凭证', freePay.msg);
    ok(orderRow(o3).pay_type === 4, '支付方式已记录为线下转账');
    ok(!orderRow(o3).pay_voucher, '没有凭空写出一条凭证');
    ok(orderRow(o3).pay_status === 0, '标记为「已提交待确认」，没有直接算已支付');

    section('[5] 关掉开关：后台可以直接确认收款');
    const confirmFree = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: o3 } });
    ok(confirmFree.code === 1, '无凭证订单可确认收款', confirmFree.msg);
    ok(orderRow(o3).pay_status === 10, '确认后订单已支付');

    // ---------------- 已上传的凭证不能被抹掉 ----------------
    section('[6] 关掉开关后再次提交，不能把已上传的凭证清空');
    await savePay({ pay_voucher_required: '10' });
    const o4 = await newOrder();
    await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o4, pay_type: 4, voucher: vurl } });
    ok(orderRow(o4).pay_voucher === vurl, '先正常传上凭证');
    await savePay({ pay_voucher_required: '20' });
    const again = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o4, pay_type: 4 } });
    ok(again.code === 1, '关开关后再次提交成功', again.msg);
    ok(orderRow(o4).pay_voucher === vurl, '已上传的凭证仍保留，没被写成空');

    // ---------------- 余额支付不受影响 ----------------
    section('[7] 余额支付完全不受这个开关影响');
    await savePay({ pay_balance_open: '10', pay_voucher_required: '10' });
    const before = Number(db.prepare('SELECT amount a FROM member WHERE member_id = ?').get(buyer.member_id).a);
    const o5 = await newOrder(1);
    const balPay = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o5, pay_type: 1 } });
    ok(balPay.code === 1, '必传开关开着也能余额支付', balPay.msg);
    const after = Number(db.prepare('SELECT amount a FROM member WHERE member_id = ?').get(buyer.member_id).a);
    ok(after < before, '余额已扣', `${before} → ${after}`);
    ok(orderRow(o5).pay_status === 10, '余额支付即时到账，不等后台确认');

    section('[8] 开关可以来回切，不会残留');
    await savePay({ pay_voucher_required: '20' });
    ok((await paySetting()).voucher_required === '0', '关闭后读回 0');
    await savePay({ pay_voucher_required: '10' });
    ok((await paySetting()).voucher_required === '1', '重新打开后读回 1');
    const o6 = await newOrder();
    const backToStrict = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: o6, pay_type: 4 } });
    ok(backToStrict.code !== 1, '重新打开后又要求凭证', backToStrict.msg);
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
