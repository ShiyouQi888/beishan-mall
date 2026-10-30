// 安全回归：上传鉴权、订单数量/状态参数的服务端限制
// 独立库（security.db / 3423）
// 用法: node scripts/probe/security.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3423;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'security.db';

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

// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const uploadForm = () => {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'probe.png');
  return fd;
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
    section('[1] 上传接口必须登录');
    const anon = await fetch(`${BASE}/api/upload/image`, { method: 'POST', body: uploadForm() });
    const anonJson = await anon.json();
    ok(anonJson.code !== 1, '未登录不能上传', anonJson.msg);

    const anonMulti = await fetch(`${BASE}/api/upload/images`, { method: 'POST', body: uploadForm() });
    ok((await anonMulti.json()).code !== 1, '未登录不能批量上传');

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const mt = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: buyer.mobile, password: buyer.mobile } })).data?.token;
    ok(!!mt, '会员登录');

    const authed = await fetch(`${BASE}/api/upload/image`, {
      method: 'POST', headers: { Authorization: `Bearer ${mt}` }, body: uploadForm(),
    }).then((r) => r.json());
    ok(authed.code === 1 && /^\/uploads\//.test(authed.data?.path || ''), '登录后正常上传', authed.msg);

    // 准备下单条件
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0' } } });
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer.member_id, field: 'amount', value: 900000, remark: '测试充值' } });
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99').run();
    const g = db.prepare(
      'SELECT goods_id, goods_min_price FROM goods WHERE type = 1 AND goods_status = 10 AND member_id <> ? LIMIT 1',
    ).get(buyer.member_id);
    ok(!!g, '找到可下单的商品');

    section('[2] 下单数量：负数 / 0 / 小数 / 非数字 / 超大都要被拒');
    const badNums = [
      [-1, '负数'],
      [0, '0'],
      [1.5, '小数'],
      ['abc', '非数字'],
      [10000, '超大'],
    ];
    for (const [num, label] of badNums) {
      const r = await api('/api/order/toAddOrder', { method: 'POST', token: mt, body: { goods_id: g.goods_id, num, pay_type: 1 } });
      ok(r.code === 0 && /数量|件/.test(r.msg), `num=${label} 被拒`, r.msg);
    }

    const good = await api('/api/order/toAddOrder', { method: 'POST', token: mt, body: { goods_id: g.goods_id, num: 2, pay_type: 1 } });
    ok(good.code === 1, '合法数量（2 件）可以下单', good.msg);
    const total = db.prepare('SELECT num, total_price FROM orders WHERE order_id = ?').get(good.data.order_id);
    ok(Number(total.num) === 2 && Number(total.total_price) === Number(g.goods_min_price) * 2, '订单数量与总额正确', `${total.num} × ${g.goods_min_price}`);

    section('[3] 拆分数量：负数 / 小数被拒');
    const splitNeg = await api('/api/order/toSplitOrder', { method: 'POST', token: mt, body: { order_id: good.data.order_id, num: -5 } });
    ok(splitNeg.code === 0 && /拆分数量/.test(splitNeg.msg), '拆分数为负被拒', splitNeg.msg);
    const splitFloat = await api('/api/order/toSplitOrder', { method: 'POST', token: mt, body: { order_id: good.data.order_id, num: 1.5 } });
    ok(splitFloat.code === 0 && /拆分数量/.test(splitFloat.msg), '拆分数为小数被拒', splitFloat.msg);
    const splitOk = await api('/api/order/toSplitOrder', { method: 'POST', token: mt, body: { order_id: good.data.order_id, num: 1 } });
    ok(splitOk.code === 1, '拆 1 件可以', splitOk.msg);

    section('[4] 会员不能直接改订单状态');
    const up = await api('/api/order/upOrderStatus', { method: 'POST', token: mt, body: { order_id: good.data.order_id, status: 10 } });
    ok(up.code !== 1 && /不存在/.test(up.msg), 'upOrderStatus 已删除', up.msg);
    const paid = db.prepare('SELECT status, pay_status FROM orders WHERE order_id = ?').get(good.data.order_id);
    ok(Number(paid.pay_status) === 0, '订单没有被偷偷改成已成交', JSON.stringify(paid));

    section('[5] 脏订单兜底：金额非正不许扣款');
    // 直接塞一条负数金额的订单，模拟历史脏数据/导入异常，支付时不能变成「给买家加钱」
    const dirtyInfo = db.prepare(
      `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, type, price, num, total_price, service_charge, status, pay_status, pay_type, create_time)
       VALUES ('Q-DIRTY', ?, 0, ?, '脏数据单', 1, 100, 1, -100, 0, 0, 0, 1, datetime('now','localtime'))`,
    ).run(buyer.member_id, g.goods_id);
    const dirtyId = Number(dirtyInfo.lastInsertRowid);
    const beforeBal = db.prepare('SELECT amount FROM member WHERE member_id = ?').get(buyer.member_id).amount;
    const dirtyPay = await api('/api/order/toPay', { method: 'POST', token: mt, body: { order_id: dirtyId, pay_type: 1 } });
    ok(dirtyPay.code === 0 && /金额异常/.test(dirtyPay.msg), '负数金额订单不许支付', dirtyPay.msg);
    const afterBal = db.prepare('SELECT amount FROM member WHERE member_id = ?').get(buyer.member_id).amount;
    ok(Number(afterBal) === Number(beforeBal), '余额没有被反向增加', `${beforeBal} → ${afterBal}`);

    section('[6] 只能查自己的物流');
    const other = db.prepare('SELECT order_id FROM orders WHERE member_id <> ? LIMIT 1').get(buyer.member_id);
    if (other) {
      const ex = await api(`/api/order/express?order_id=${other.order_id}`, { token: mt });
      ok(ex.code === 0, '查别人订单的物流被拒', ex.msg);
    } else {
      ok(true, '没有他人订单（跳过）');
    }
    const own = await api(`/api/order/express?order_id=${good.data.order_id}`, { token: mt });
    ok(own.code === 1, '查自己的物流正常', own.msg);

    section('[7] 后台导入：状态走白名单、数量要正整数');
    const badStatus = await api('/admin/api/orders/import', {
      method: 'POST', token: at,
      body: { rows: [{ goods_id: g.goods_id, member_id: buyer.member_id, price: 100, num: 1, status: 999 }] },
    });
    ok(badStatus.code === 1 && badStatus.data?.okCount === 0, '状态 999 被拒', JSON.stringify(badStatus.data?.errors?.[0] || {}));
    const badNum = await api('/admin/api/orders/import', {
      method: 'POST', token: at,
      body: { rows: [{ goods_id: g.goods_id, member_id: buyer.member_id, price: 100, num: 2.5 }] },
    });
    ok(badNum.code === 1 && badNum.data?.okCount === 0, '数量为小数被拒', JSON.stringify(badNum.data?.errors?.[0] || {}));
    const goodImport = await api('/admin/api/orders/import', {
      method: 'POST', token: at,
      body: { rows: [{ goods_id: g.goods_id, member_id: buyer.member_id, price: 100, num: 1, status: 10, pay_status: 10 }] },
    });
    ok(goodImport.code === 1 && goodImport.data?.okCount === 1, '合法数据可导入', goodImport.msg);

    section('[8] 后台拆分：份数必须整数');
    const adminSplitFloat = await api('/admin/api/orders/split', { method: 'POST', token: at, body: { order_id: good.data.order_id, split_num: 2.5 } });
    ok(adminSplitFloat.code === 0 && /整数/.test(adminSplitFloat.msg), '拆 2.5 份被拒', adminSplitFloat.msg);
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
