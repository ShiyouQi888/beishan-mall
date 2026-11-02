// 批量操作：订单批量确认收款 / 提现批量审核
// 独立库（batch-ops.db / 3419）
// 用法: node scripts/probe/batch-ops.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3419;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'batch-ops.db';

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

const api = async (path, { method = 'GET', body, token, silent } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (silent) return json;
  return json;
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
  // 提现模块已下线、四个通道默认关闭；本用例要验批量审核，测试库显式开线下打款通道
  {
    try {
      const { db: __wdDb } = await import('../../server/src/db.js');
      __wdDb.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'withdraw_offline_open'").run();
    } catch {}
  }
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
    // 打开线下凭证支付 + 免手续费，避免测试被配置挡住
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'pay', values: { pay_bank: '10' } } });
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0' } } });
    // 场次全开，避免非营业时段跑不通
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399').run();

    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const mt = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: buyer.mobile, password: buyer.mobile } })).data?.token;
    ok(!!mt, '买家登录');
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer.member_id, field: 'amount', value: 900000, remark: '冒烟充值' } });

    const goodsIds = () => db.prepare(
      'SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND member_id <> ? LIMIT 10',
    ).all(buyer.member_id).map((x) => x.goods_id);

    // 造一笔「已上传凭证、等待后台确认收款」的线下单
    // 必须每单换一件商品：同一件货只能成交一次，重复成交会被服务端拒绝（见 concurrency.mjs）
    const usedGoods = new Set();
    async function makeVoucherOrder() {
      const gid = goodsIds().find((id) => !usedGoods.has(id));
      if (!gid) return null;
      usedGoods.add(gid);
      const order = await api('/api/order/toAddOrder', { method: 'POST', token: mt, body: { goods_id: gid, num: 1, pay_type: 4 } });
      if (order.code !== 1) return null;
      return order.data.order_id;
    }

    section('[1] 订单：批量确认收款');
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = await makeVoucherOrder();
      if (id) ids.push(id);
    }
    eq(ids.length, 3, '造出 3 笔待确认的线下凭证单');

    const before = db.prepare('SELECT COUNT(*) c FROM orders WHERE pay_status = 0').get().c;
    const batch = await api('/admin/api/orders/confirm-pay-batch', { method: 'POST', token: at, body: { order_ids: ids } });
    ok(batch.code === 1 && Number(batch.data?.done) === ids.length, '批量确认成功', batch.msg);
    const after = db.prepare('SELECT COUNT(*) c FROM orders WHERE pay_status = 0').get().c;
    eq(before - after, ids.length, '待确认数量减少对应笔数');
    eq(db.prepare('SELECT COUNT(*) c FROM orders WHERE order_id IN (' + ids.join(',') + ') AND pay_status = 10').get().c, ids.length, '三笔都已到账');
    const logCount = db.prepare("SELECT COUNT(*) c FROM order_log WHERE action = '确认收款' AND order_id IN (" + ids.join(',') + ')').get().c;
    eq(logCount, ids.length, '每笔都写了订单日志');
    ok(db.prepare('SELECT COUNT(*) c FROM goods WHERE goods_id IN (SELECT goods_id FROM orders WHERE order_id IN (' + ids.join(',') + ')) AND goods_status = 10').get().c === 0, '成交商品已下架（不会再被原价抢）');

    section('[2] 重复确认：如实报错，不假装成功');
    const again = await api('/admin/api/orders/confirm-pay-batch', { method: 'POST', token: at, body: { order_ids: ids } });
    ok(again.code === 0 && /已确认/.test(again.msg), '已确认的再提交会被拦下', again.msg);

    section('[3] 部分成功：一笔已确认 + 一笔待确认');
    const extra = await makeVoucherOrder();
    ok(!!extra, '再造一笔待确认单');
    const mixed = await api('/admin/api/orders/confirm-pay-batch', { method: 'POST', token: at, body: { order_ids: [ids[0], extra] } });
    ok(mixed.code === 1, '部分成功仍返回成功', mixed.msg);
    eq(mixed.data?.done, 1, '成功 1 笔');
    eq((mixed.data?.failed || []).length, 1, '跳过 1 笔');
    eq(db.prepare('SELECT pay_status p FROM orders WHERE order_id = ?').get(extra).p, 10, '新单已到账');

    // 提现模块已整体下线，相关批量审核用例随之删除
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
