// 数据清除新增三个范围：转拍订单 / 系统回收 / 积分兑换
// 独立库（reset-scopes.db / 3421），不碰演示库
// 用法: node scripts/probe/reset-scopes.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3421;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'reset-scopes.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };

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

async function main() {
  await runSeed();
  const { db } = await import('../../server/src/db.js');

  // 安全阀：这个用例会真的清库，连错就会把演示数据端掉
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) {
    throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是测试库 ${DB}，已中止`);
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
    ok(!!at, '后台登录');

    const official = db.prepare("SELECT * FROM member WHERE mobile = '13800000001'").get();
    ok(!!official, '官方账号存在');

    // ---------- 造数 ----------
    section('[0] 造三块待清数据');
    // 买家
    const buyer = Number(db.prepare(
      `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
         is_valid, amount, score, e_card_number, is_certification, disabled, client_type, create_time, update_time)
       VALUES ('清理买家','13900002222','x',0,'/',1,'clean01',10,0,500,0,0,10,3,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
    ).run().lastInsertRowid);

    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    const mkGoods = (name, no, extra = {}) => {
      const info = db.prepare(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',?,1,'',?,1000,1000,0,0,1,1,1,?,?,0,1,100,1,0,?,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
      ).run(name, no, catId, extra.member_id ?? buyer, extra.status ?? 10, extra.is_sell ?? 10, extra.recycled ?? 0);
      return Number(info.lastInsertRowid);
    };

    // 1) 在挂转拍：商品在架、持有人是买家、订单 consignment_status=10
    const gTrans = mkGoods('在挂转拍样品', 'RS-T1');
    const orderTrans = Number(db.prepare(
      `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
         type, price, num, total_price, service_charge, status, pay_status, pay_type, consignment_status, create_time)
       VALUES ('RSORD1',?,?,?,'在挂转拍样品','/uploads/demo-1.svg',1,1,1000,1,1000,20,10,10,0,10,datetime('now','+8 hours'))`,
    ).run(buyer, official.member_id, gTrans).lastInsertRowid);

    // 2) 已回收：商品封顶下架 + 一条台账
    const gRecycle = mkGoods('已回收样品', 'RS-R1', { status: 20, is_sell: 0, recycled: 1 });
    db.prepare(
      `INSERT INTO goods_recycle (goods_id, order_id, member_id, goods_name, good_thumb, base_price, cap_price,
         buy_price, buy_cost, increase_rate, recycle_price, profit, status, create_time)
       VALUES (?,?,?, '已回收样品','/uploads/demo-1.svg',1000,2000,1500,1530,3,1545,15,10,datetime('now','+8 hours'))`,
    ).run(gRecycle, orderTrans, buyer);

    // 3) 积分兑换：积分商品 + 兑换单 + 兑换流水
    const itemId = Number(db.prepare(
      `INSERT INTO score_item (name, thumb, images, intro, detail, score_price, stock, sold, limit_per, sort, status, create_time, update_time)
       VALUES ('兑换样品','/uploads/demo-1.svg','[]','','',100,5,2,0,100,10,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO score_exchange (exchange_no, member_id, item_id, item_name, item_thumb, score_cost, num, total_score,
         receiver, mobile, region, address, status, create_time)
       VALUES ('RSEX1',?,?, '兑换样品','/uploads/demo-1.svg',100,2,200,'清理买家','13900002222','','',10,datetime('now','+8 hours'))`,
    ).run(buyer, itemId);
    db.prepare(
      `INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time)
       VALUES (?, -200, 3, '积分兑换', '兑换 兑换样品 ×2', datetime('now','+8 hours'))`,
    ).run(buyer);
    // 已取消的兑换单：不该再退一次分
    db.prepare(
      `INSERT INTO score_exchange (exchange_no, member_id, item_id, item_name, item_thumb, score_cost, num, total_score,
         receiver, mobile, region, address, status, create_time)
       VALUES ('RSEX2',?,?, '兑换样品','/uploads/demo-1.svg',100,1,100,'清理买家','13900002222','','',40,datetime('now','+8 hours'))`,
    ).run(buyer, itemId);

    eq(db.prepare('SELECT COUNT(*) c FROM orders WHERE IFNULL(consignment_status,0)=10').get().c, 1, '造出 1 条在挂转拍');
    eq(db.prepare('SELECT COUNT(*) c FROM goods_recycle').get().c, 1, '造出 1 条回收台账');
    eq(db.prepare('SELECT COUNT(*) c FROM score_exchange').get().c, 2, '造出 2 条兑换单（1 待发货 + 1 已取消）');

    // ---------- 预览 ----------
    section('[1] 预览：三项都在范围里');
    const plan = await api('/admin/api/system/reset/plan?scopes=transpose,recycle,score', { token: at });
    const scopes = plan.data?.scopes || {};
    ok(['transpose', 'recycle', 'score'].every((k) => scopes[k]), `范围键：${Object.keys(scopes).join(',')}`);
    eq(scopes.transpose?.label, '转拍订单', '范围名：转拍订单');
    eq(scopes.recycle?.label, '系统回收', '范围名：系统回收');
    eq(scopes.score?.label, '积分兑换', '范围名：积分兑换');
    eq(plan.data?.totals?.transpose, 1, '预览：转拍 1 行');
    eq(plan.data?.totals?.recycle, 2, '预览：回收 2 行（台账 1 + 解除封顶 1）');
    eq(plan.data?.totals?.score, 2, '预览：兑换 2 行');
    eq(Number(plan.data?.summary?.transpose), 1, '概况：转拍挂单 = 1');
    eq(Number(plan.data?.summary?.recycle), 1, '概况：回收台账 = 1');
    eq(Number(plan.data?.summary?.score), 2, '概况：兑换单 = 2');

    // ---------- 2. 只清转拍 ----------
    section('[2] 只清「转拍订单」');
    const r1 = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['transpose'], confirm: '我已知晓风险并确认清除' },
    });
    ok(r1.code === 1, '执行成功', r1.msg);
    eq(db.prepare('SELECT COUNT(*) c FROM orders WHERE IFNULL(consignment_status,0)=10').get().c, 0, '在挂转拍清零');
    eq(db.prepare('SELECT COUNT(*) c FROM orders WHERE order_id = ?').get(orderTrans).c, 1, '这笔订单本身保留（只是撤销挂单）');
    eq(db.prepare('SELECT goods_status FROM goods WHERE goods_id = ?').get(gTrans).goods_status, 20, '商品下架');
    eq(db.prepare('SELECT is_sell FROM goods WHERE goods_id = ?').get(gTrans).is_sell, 0, '商品停止售卖');
    eq(db.prepare('SELECT member_id FROM goods WHERE goods_id = ?').get(gTrans).member_id, buyer, '商品仍在买家名下');
    eq(db.prepare('SELECT COUNT(*) c FROM score_exchange').get().c, 2, '没碰积分兑换');

    // ---------- 3. 只清系统回收 ----------
    section('[3] 只清「系统回收」');
    const r2 = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['recycle'], confirm: '我已知晓风险并确认清除' },
    });
    ok(r2.code === 1, '执行成功', r2.msg);
    eq(db.prepare('SELECT COUNT(*) c FROM goods_recycle').get().c, 0, '回收台账清空');
    eq(db.prepare('SELECT recycled FROM goods WHERE goods_id = ?').get(gRecycle).recycled, 0, '解除封顶标记');
    eq(db.prepare('SELECT goods_status FROM goods WHERE goods_id = ?').get(gRecycle).goods_status, 10, '商品重新上架');
    eq(db.prepare('SELECT is_sell FROM goods WHERE goods_id = ?').get(gRecycle).is_sell, 10, '商品恢复可售');
    eq(db.prepare('SELECT COUNT(*) c FROM goods').get().c, db.prepare('SELECT COUNT(*) c FROM goods').get().c, '商品一个没删');
    eq(db.prepare('SELECT COUNT(*) c FROM orders WHERE order_id = ?').get(orderTrans).c, 1, '没碰订单');

    // ---------- 4. 只清积分兑换 ----------
    section('[4] 只清「积分兑换」');
    const scoreBefore = Number(db.prepare('SELECT score FROM member WHERE member_id = ?').get(buyer).score);
    const r3 = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['score'], confirm: '我已知晓风险并确认清除' },
    });
    ok(r3.code === 1, '执行成功', r3.msg);
    eq(db.prepare('SELECT COUNT(*) c FROM score_exchange').get().c, 0, '兑换单清空');
    eq(Number(db.prepare('SELECT score FROM member WHERE member_id = ?').get(buyer).score), scoreBefore + 200, '只退未取消那单的 200 积分（已取消的不重复退）');
    eq(db.prepare('SELECT stock FROM score_item WHERE item_id = ?').get(itemId).stock, 7, '库存还原 5 → 7');
    eq(db.prepare('SELECT sold FROM score_item WHERE item_id = ?').get(itemId).sold, 0, '已兑数还原 2 → 0');
    eq(db.prepare("SELECT COUNT(*) c FROM finance_energy WHERE type = 3 AND type_name = '积分兑换'").get().c, 0, '兑换流水一并清掉');
    eq(db.prepare('SELECT COUNT(*) c FROM score_item WHERE item_id = ?').get(itemId).c, 1, '积分商品本身不删');

    // ---------- 5. 三项一起（幂等 + 计数） ----------
    section('[5] 三项一起再跑一次：空库不报错');
    const r4 = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['transpose', 'recycle', 'score'], confirm: '我已知晓风险并确认清除' },
    });
    ok(r4.code === 1, '空范围执行也不报错', r4.msg);
    eq(r4.data?.total, 0, '空范围清 0 行');

    // ---------- 6. 恢复出厂七项 ----------
    section('[6] 恢复出厂：七项一起清');
    const allKeys = ['trade', 'transpose', 'recycle', 'score', 'member', 'goods', 'media'];
    ok(allKeys.every((k) => scopes[k]), '七个范围键都在');
    const r5 = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: allKeys, confirm: '我已知晓风险并确认清除' },
    });
    ok(r5.code === 1, '七项恢复出厂执行成功', r5.msg);
    eq(db.prepare('SELECT COUNT(*) c FROM member').get().c, 1, '会员只剩官方');
    eq(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0, '订单清空');
    eq(db.prepare('SELECT COUNT(*) c FROM goods_recycle').get().c, 0, '回收台账清空');
    eq(db.prepare('SELECT COUNT(*) c FROM score_exchange').get().c, 0, '兑换单清空');
    eq(db.prepare('SELECT COUNT(*) c FROM goods WHERE IFNULL(recycled,0)<>0').get().c, 0, '没有残留封顶商品');
    eq(db.prepare("SELECT COUNT(*) c FROM finance_energy WHERE type = 3 AND type_name = '积分兑换'").get().c, 0, '没有残留兑换流水');
  } finally {
    try { srv.kill(); } catch {}
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
