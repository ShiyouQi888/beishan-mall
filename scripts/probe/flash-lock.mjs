/**
 * 抢购锁单验收：提交订单即锁定，别人抢不了；支付确认后商品变灰。
 *
 * 断言链：
 *   1. A 下单成功 → 商品 locked=1、列表卡片状态是「抢购中」
 *   2. B 下单同一件货 → 被拒，提示被别人锁定
 *   3. A 重复下单 → 被拒，提示自己去付款或取消
 *   4. A 支付 → 商品下架（goods_status=20），前台 sold_out=1（灰掉）
 *   5. 另一件货：C 下单不付 → 超时（把时限设 1 分钟、create_time 提前）→ 订单关闭 + 商品可再抢
 *
 * 独立库（flash.db / 3419），跑完删库。
 *
 * 用法: node scripts/probe/flash-lock.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3419;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'flash.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
// 关掉定时任务：超时关单由用例手动触发，避免定时器抢在断言前动手
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), ORDER_EXPIRE_SCAN_MS: '0', RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };
process.env.MALL_DB = DB;

let pass = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

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

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  const { db, get } = await import('../../server/src/db.js');
  const { expireUnpaidOrders } = await import('../../server/src/lib/orderExpire.js');
  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;

    // 场次全天开放 + 支付时限 1 分钟（方便测超时）
    const dow = new Date(`${todayStr()}T00:00:00Z`).getUTCDay();
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, open_days = ?, is_open = 10, transposition_hours = 0 WHERE specialarea_id = 1')
      .run(String(dow === 0 ? 7 : dow));
    db.prepare("UPDATE setting_config SET `value` = '1' WHERE `key` = 'order_pay_timeout'").run();
    // 系统默认只开线下转账；本用例要走余额支付验证锁定与释放，测试库显式打开
    db.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();

    // 三个买家
    const people = [];
    for (const [i, phone] of [[1, '13990000001'], [2, '13990000002'], [3, '13990000003']]) {
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'lock123456', code: 'boss01', nickName: `抢单${i}` },
      });
      const mid = Number(reg.data?.member_id) || get('SELECT member_id FROM member WHERE mobile = ?', phone)?.member_id;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '锁单验收充值' },
      });
      const lg = await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'lock123456' } });
      people.push({ mid: Number(mid), token: lg.data?.token });
    }
    const [A, B, C] = people;
    ok(people.every((p) => p.token), '三个买家可登录');

    // 两件唯一货
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = async (name) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: 1000, stock_num: 1, goods_status: 10, goods_sort: 1 },
      });
      const gid = Number(r.data?.id);
      await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid] } });
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);
      return gid;
    };
    const gA = await mkGoods('锁单验收样品A');
    const gB = await mkGoods('锁单验收样品B');
    ok(gA > 0 && gB > 0, '两件测试商品已创建');

    // ---------- 1. A 下单即锁 ----------
    console.log('[1] A 下单即锁单');
    const oA = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: gA, num: 1, pay_type: 1 } });
    eq(oA.code, 1, 'A 下单成功');
    const dA = await api(`/api/goods/getLootDetails?goods_id=${gA}`, { token: A.token });
    eq(dA.data?.locked, 1, '商品标记为「被锁单」');
    ok(dA.data?.sold_out === 0, '但还没卖出去（不是已抢完）', String(dA.data?.sold_out));
    const listA = await api('/api/goods/getLootList');
    const cardA = (listA.data?.list || []).flatMap((a) => a.goods_list || []).find((x) => Number(x.goods_id) === gA);
    ok(!!cardA, '抢购列表里能找到这件货');
    if (cardA) eq(cardA.locked, 1, '列表卡片也带 locked=1');

    // ---------- 2. B 抢不了 ----------
    console.log('\n[2] 别人抢不了');
    const oB = await api('/api/order/toAddOrder', { method: 'POST', token: B.token, body: { goods_id: gA, num: 1, pay_type: 1 } });
    eq(oB.code, 0, 'B 下单被拒');
    ok(/锁定|抢先/.test(oB.msg), '提示说明被别人锁定', oB.msg);

    const oA2 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: gA, num: 1, pay_type: 1 } });
    eq(oA2.code, 0, 'A 重复下单也被拒');
    // 「同一件货每人只能买一次」的分支比锁单更靠前，两种提示都算拦住了
    ok(/已经下过单|已经买过/.test(oA2.msg), '提示让 A 先去付款或取消（已被拦下）', oA2.msg);

    // ---------- 3. 支付后商品下架变灰 ----------
    console.log('\n[3] A 支付后商品下架');
    const pay = await api('/api/order/toPay', { method: 'POST', token: A.token, body: { order_id: oA.data.order_id, pay_type: 1 } });
    eq(pay.code, 1, 'A 支付成功');
    const gAfter = get('SELECT goods_status, member_id FROM goods WHERE goods_id = ?', gA);
    eq(gAfter.goods_status, 20, '商品已下架');
    eq(gAfter.member_id, A.mid, '商品归 A 所有');
    const dA2 = await api(`/api/goods/getLootDetails?goods_id=${gA}`, { token: B.token });
    eq(dA2.data?.sold_out, 1, '前台显示已抢完（灰卡）');
    eq(dA2.data?.locked, 0, '不再是锁单状态');

    // ---------- 4. 超时释放 ----------
    console.log('\n[4] 下单不付：超时自动释放');
    const oC = await api('/api/order/toAddOrder', { method: 'POST', token: C.token, body: { goods_id: gB, num: 1, pay_type: 1 } });
    eq(oC.code, 1, 'C 下单成功');
    // 把下单时间往前挪 3 分钟（时限是 1 分钟）
    db.prepare("UPDATE orders SET create_time = '2020-01-01 00:00:00' WHERE order_id = ?").run(oC.data.order_id);
    const beforeExpire = expireUnpaidOrders();
    ok(beforeExpire.closed >= 1, '超时关单任务命中', `${beforeExpire.closed} 笔`);
    eq(get('SELECT status FROM orders WHERE order_id = ?', oC.data.order_id).status, 40, '订单已关闭');
    const dC = await api(`/api/goods/getLootDetails?goods_id=${gB}`, { token: B.token });
    eq(dC.data?.locked, 0, '商品解除锁定');
    ok(dC.data?.sold_out === 0, '商品重新可抢', String(dC.data?.sold_out));
    const oB2 = await api('/api/order/toAddOrder', { method: 'POST', token: B.token, body: { goods_id: gB, num: 1, pay_type: 1 } });
    eq(oB2.code, 1, 'B 现在能抢这件货了');

    // 关单日志与站内消息
    const lg = get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '超时关闭'", oC.data.order_id);
    eq(lg.c, 1, '落下「超时关闭」日志');
    const msg = get('SELECT COUNT(*) c FROM member_msg WHERE member_id = ?', C.mid);
    ok(msg.c >= 1, '给会员发了站内提醒', String(msg.c));

    // ---------- 5. 支付时限接口 ----------
    console.log('\n[5] 支付时限配置透出');
    const tc = await api('/api/index/getTradeConfig');
    eq(tc.data?.pay_timeout, 1, '前台拿到后台配置的支付时限');
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
