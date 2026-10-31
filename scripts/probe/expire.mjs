// 到期自动下架回归（替代原「流拍」）
// 独立库（expire.db / 3470），跑完自动销毁，不碰演示库
// 用法: node scripts/probe/expire.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3470;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'expire.db';

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
const money = (n) => Number(Number(n || 0).toFixed(2));
const eq = (a, b, name) => ok(money(a) === money(b), name, `期望 ${b}，实际 ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

const localToday = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function main() {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
  const { db } = await import('../../server/src/db.js');
  const { expireUnsold } = await import('../../server/src/lib/expire.js');

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
  srv.stderr.on('data', (d) => {
    log += String(d);
    if (!String(d).includes('ExperimentalWarning') && !String(d).includes('trace-warnings')) process.stderr.write(d);
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error(`服务启动超时：\n${log.slice(-600)}`);

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    // 场次 1 = 全天开放（不该到期）；场次 2 = 已结束（该到期）
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7' WHERE specialarea_id = 1").run();
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 1, buy_num = 999, open_days = '1,2,3,4,5,6,7' WHERE specialarea_id = 2").run();
    await api('/admin/api/setting/save', {
      method: 'POST', token: at,
      body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0', price_increase_rate: '3' } },
    });

    const holder = db.prepare("SELECT member_id FROM member WHERE mobile = '13800000001'").get().member_id;
    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    const bLogin = await api('/api/member/accountLogin', { method: 'POST', body: { phone: buyer.mobile, password: buyer.mobile } });
    const bt = bLogin.data.token;
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer.member_id, field: 'amount', value: 500000, remark: '到期测试' } });

    const today = localToday();

    /** 造一件「已转拍挂牌在某场次、日期为今天」的商品 */
    const makeListed = async (name, areaId, areaDate) => {
      const c = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: {
          goods_name: name, goods_no: `EXP-${Math.random().toString(36).slice(2, 8)}`,
          category_id: catId, member_id: holder, goods_min_price: 1000, line_price: 1500,
          stock_num: 1, sales_actual: 0, goods_status: 10, goods_sort: 1,
        },
      });
      const gid = Number(c.data.id);
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);
      const o = await api('/api/order/toAddOrder', { method: 'POST', token: bt, body: { goods_id: gid, num: 1, pay_type: 1 } });
      await api('/api/order/toPay', { method: 'POST', token: bt, body: { order_id: o.data.order_id, pay_type: 1 } });
      // 模拟「持有人已转拍挂牌」：商品重新上架、挂到指定场次、订单标记已挂牌
      db.prepare('UPDATE goods SET goods_status = 10, is_sell = 10, area_date = ? WHERE goods_id = ?').run(areaDate, gid);
      db.prepare('UPDATE orders SET consignment_status = 10, transposition_time = ? WHERE order_id = ?').run(`${areaDate} 09:00:00`, o.data.order_id);
      db.prepare('DELETE FROM specialarea_goods WHERE goods_id = ?').run(gid);
      db.prepare('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)')
        .run(areaId, gid, 100, `${areaDate} 09:00:00`);
      return { gid, orderId: Number(o.data.order_id) };
    };

    // ================= 1. 到期下架 =================
    section('[1] 场次已结束 + 没人买 → 自动下架退回持有人');
    const a = await makeListed('到期样品-已结束场次', 2, today);
    const beforeMsg = Number(db.prepare('SELECT COUNT(*) c FROM member_msg WHERE member_id = ?').get(buyer.member_id).c);
    const r1 = expireUnsold(today);
    ok(r1.expired >= 1, '扫描到并下架', JSON.stringify(r1));
    const g1 = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(a.gid);
    eq(g1.goods_status, 20, '商品已下架');
    eq(g1.member_id, buyer.member_id, '商品仍归持有人（只是下架）');
    eq(db.prepare('SELECT consignment_status s FROM orders WHERE order_id = ?').get(a.orderId).s, 0, '订单「已挂牌」标记归零（可重新转拍）');
    ok(Number(db.prepare('SELECT COUNT(*) c FROM member_msg WHERE member_id = ?').get(buyer.member_id).c) > beforeMsg, '给持有人发了退回通知');
    eq(db.prepare('SELECT COUNT(*) c FROM orders WHERE type = 5').get().c, 0, '不再生成任何流拍台账');

    const recons = await api('/api/order/consignment', { method: 'POST', token: bt, body: { order_id: a.orderId } });
    ok(recons.code === 1, '退回后可以重新转拍', recons.msg);

    // ================= 2. 不该下架的两种情况 =================
    section('[2] 场次还开着 / 日期未到 → 不动');
    const b = await makeListed('未到期样品-场次开放中', 1, today);
    const c = await makeListed('未到期样品-明天场次', 2, '2999-01-01');
    const r2 = expireUnsold(today);
    eq(r2.expired, 0, '这两件都不下架');
    eq(db.prepare('SELECT goods_status s FROM goods WHERE goods_id = ?').get(b.gid).s, 10, '开放中的场次不动');
    eq(db.prepare('SELECT goods_status s FROM goods WHERE goods_id = ?').get(c.gid).s, 10, '未来日期的场次不动');

    // ================= 3. 已回收封顶的商品不参与 =================
    section('[3] 已回收封顶的商品不参与到期判断');
    const d = await makeListed('已回收样品', 2, today);
    db.prepare('UPDATE goods SET recycled = 1, member_id = 0 WHERE goods_id = ?').run(d.gid);
    const r3 = expireUnsold(today);
    eq(r3.expired, 0, '封顶商品不再补消息');

    section('[4] 幂等');
    eq(expireUnsold(today).expired, 0, '重复扫描不会再处理一遍');
  } finally {
    srv.kill();
  }

  console.log('\n' + '─'.repeat(52));
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    fails.forEach((f) => console.log(`   · ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
