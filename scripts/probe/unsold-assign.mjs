/**
 * 流拍订单 + 指派成交验收
 *
 * 覆盖：
 *   1. 流拍列表口径：挂出去过、场次到期未成交、已下架退回持有人、当前没在挂
 *   2. 指派拒绝：未登录、缺 confirm、商品不存在、接手人=持有人、禁用会员、正在挂牌、库存池、已回收
 *   3. 指派成功：生成 F 前缀成交单、settleOrder 结算（货款/佣金/积分）、货权过户、场次延续今天
 *   4. 会员端同步、订单动态、审计留痕；指派后不再出现在流拍列表
 *
 * 独立库（probe-unsold.db / 3480），跑完销毁。
 * 用法: node scripts/probe/unsold-assign.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3480;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-unsold.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`];
const removeDb = () => {
  for (const f of dbFiles) {
    const p = join(SERVER, 'data', f);
    if (!existsSync(p)) continue;
    try { unlinkSync(p); } catch {}
  }
};
removeDb();
process.env.MALL_DB = DB;
const env = {
  ...process.env, MALL_DB: DB, PORT: String(PORT),
  RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0', ORDER_EXPIRE_SCAN_MS: '0',
};
let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);
const near = (a, b, name) => ok(Math.abs(Number(a) - Number(b)) < 0.005, name, `期望 ${b}，实际 ${a}`);

const seed = () => new Promise((resolve, reject) => {
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
  await seed();
  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += String(d)));
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');
  const { db, get, all } = await import('../../server/src/db.js');
  const cleanup = () => { try { srv.kill(); } catch {} };
  try {
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 0, open_days = '1,2,3,4,5,6,7', is_open = 10").run();
    const areaId = Number(get('SELECT specialarea_id FROM specialarea WHERE is_open = 10 ORDER BY start_time LIMIT 1')?.specialarea_id || 0);
    const today = todayStr();
    const at = (await api('/admin/api/login', {
      method: 'POST', body: { user_name: 'admin1', password: '123456' },
    })).data.token;
    ok(!!at, '后台登录');

    const mkMember = async (phone, nick, parentId = 0) => {
      const r = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'probe123456', code: 'boss01', nickName: nick },
      });
      const id = Number(r.data?.member_id);
      const tk = (await api('/api/member/accountLogin', {
        method: 'POST', body: { phone, password: 'probe123456' },
      })).data.token;
      if (parentId) db.prepare('UPDATE member SET p_id = ?, path = ? WHERE member_id = ?')
        .run(parentId, `/${parentId}/`, id);
      return { id, token: tk };
    };
    const P = await mkMember('13976000001', '流拍上级');
    const A = await mkMember('13976000002', '流拍原持有人', P.id);
    const B = await mkMember('13976000003', '流拍接手人', P.id);
    const D = await mkMember('13976000004', '被禁用会员', P.id);
    db.prepare('UPDATE member SET disabled = 20 WHERE member_id = ?').run(D.id);
    ok(A.id && B.id && P.id && D.id, '四个会员注册完成');
    const setCfg = (k, v) => {
      const r = db.prepare('UPDATE setting_config SET value = ? WHERE `key` = ?').run(v, k);
      if (!r.changes) db.prepare('INSERT INTO setting_config (`key`, `value`) VALUES (?, ?)').run(k, v);
    };
    setCfg('score_award_open', '10');
    setCfg('score_award_buyer', '1');
    setCfg('score_award_parent', '0.5');
    setCfg('drive_award_rate', '0.5');

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const gr = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_name: '流拍验证·整件货', category_id: catId, goods_min_price: 3300, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const G = Number(gr.data?.id);
    db.prepare("UPDATE goods SET area_date = '', stock_total = 1, member_id = 0 WHERE goods_id = ?").run(G);
    if (areaId) db.prepare('INSERT OR IGNORE INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)')
      .run(areaId, G, 100, '2026-11-08 00:00:00');

    // 第 1 手成交 → 转拍上架 → 场次到期流拍（直接模拟 expire 写入的状态，不依赖定时扫描）
    const o1 = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: G, num: 1, pay_type: 0 },
    });
    ok(o1.code === 1, 'A 下单', o1.msg);
    const O1 = Number(o1.data.order_id);
    ok((await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: O1 } })).code === 1,
      '第1手确认收款');
    const t0 = '2026-11-08 09:00:00';
    const t1 = '2026-11-08 09:40:00';
    db.prepare("UPDATE goods SET goods_status = 10, is_sell = 10, goods_min_price = 3432, area_date = ? WHERE goods_id = ?")
      .run(today, G);
    db.prepare('UPDATE orders SET consignment_status = 10, transposition_time = ? WHERE order_id = ?').run(t0, O1);
    db.prepare("INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)")
      .run(O1, '转拍上架', 'member', '标价 3432，进入今日场次', t0);
    db.prepare("UPDATE goods SET goods_status = 20, is_sell = 0 WHERE goods_id = ?").run(G);
    db.prepare('UPDATE orders SET consignment_status = 0 WHERE order_id = ?').run(O1);
    db.prepare("INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)")
      .run(O1, '场次到期未成交', 'system', '商品已自动下架退回持有人', t1);
    ok(Number(get('SELECT goods_status FROM goods WHERE goods_id = ?', G).goods_status) === 20, '商品已流拍下架');

    section('[1] 流拍列表');
    const listOf = async (kw = '') => (await api(`/admin/api/unsold/list?page=1&limit=20&keyword=${encodeURIComponent(kw)}`, { token: at })).data;
    const l1 = await listOf();
    eq(l1.total, 1, '流拍列表 1 条');
    const row = l1.data?.[0];
    eq(row?.goods_id, G, '列出正确商品');
    eq(row?.holder_id, A.id, '当前持有人为 A');
    eq(row?.goods_min_price, '3432.00', '显示当前标价');
    eq(row?.last_listing_time, t1, '显示最后流拍时间');
    ok(!!row?.area_text, '显示原场次');
    eq((await listOf('不存在的商品')).total, 0, '关键词过滤生效');
    eq((await listOf('流拍验证')).total, 1, '按商品名关键词命中');

    section('[2] 拒绝条件');
    const assign = (body, token = at) => api('/admin/api/unsold/assign', { method: 'POST', token, body });
    ok((await assign({ goods_id: G, member_id: B.id, confirm: 'ASSIGN_UNSOLD' }, '')).code !== 1, '未登录不能指派');
    ok((await assign({ goods_id: G, member_id: B.id })).code !== 1, '缺少 confirm 被拒绝');
    ok((await assign({ goods_id: 999999, member_id: B.id, confirm: 'ASSIGN_UNSOLD' })).code !== 1, '商品不存在被拒绝');
    ok((await assign({ goods_id: G, member_id: A.id, confirm: 'ASSIGN_UNSOLD' })).code !== 1, '接手人=持有人被拒绝');
    ok((await assign({ goods_id: G, member_id: D.id, confirm: 'ASSIGN_UNSOLD' })).code !== 1, '禁用会员被拒绝');
    db.prepare('UPDATE goods SET goods_status = 10 WHERE goods_id = ?').run(G);
    ok((await assign({ goods_id: G, member_id: B.id, confirm: 'ASSIGN_UNSOLD' })).code !== 1, '正在挂牌被拒绝');
    db.prepare('UPDATE goods SET goods_status = 20 WHERE goods_id = ?').run(G);
    db.prepare('UPDATE goods SET stock_total = 5 WHERE goods_id = ?').run(G);
    ok((await assign({ goods_id: G, member_id: B.id, confirm: 'ASSIGN_UNSOLD' })).code !== 1, '库存池被拒绝');
    db.prepare('UPDATE goods SET stock_total = 1 WHERE goods_id = ?').run(G);
    db.prepare('UPDATE goods SET recycled = 1 WHERE goods_id = ?').run(G);
    ok((await assign({ goods_id: G, member_id: B.id, confirm: 'ASSIGN_UNSOLD' })).code !== 1, '已回收被拒绝');
    db.prepare('UPDATE goods SET recycled = 0 WHERE goods_id = ?').run(G);
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id, A.id, '被拒后货权未变');

    section('[3] 指派成功：视同抢单成交');
    const amountBefore = Number(get('SELECT amount FROM member WHERE member_id = ?', A.id).amount);
    const scoreBefore = Number(get('SELECT score FROM member WHERE member_id = ?', B.id).score);
    const rv = await assign({ goods_id: G, member_id: B.id, reason: '客服补单', confirm: 'ASSIGN_UNSOLD' });
    ok(rv.code === 1, '指派成功', rv.msg);
    ok(String(rv.data?.order_no).startsWith('F'), '生成 F 前缀的指派订单');
    eq(rv.data?.date, today, '场次日期延续今天');
    const NO = String(rv.data?.order_no);
    const no = get('SELECT * FROM orders WHERE order_no = ?', NO);
    eq(no.member_id, B.id, '订单归属接手会员 B');
    eq(no.seller_id, A.id, '卖家为原持有人 A');
    eq(Number(no.status), 10, '订单状态已成交');
    eq(Number(no.pay_status), 10, '支付状态已确认');
    near(Number(no.total_price), 3432, '按当前标价成交');
    ok(no.remark.includes('客服补单'), '指派原因写进订单备注');

    section('[4] 结算、货权与场次');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id, B.id, '货权过户给 B');
    eq(Number(get('SELECT goods_status FROM goods WHERE goods_id = ?', G).goods_status), 20, '商品下架');
    eq(get('SELECT area_date FROM goods WHERE goods_id = ?', G).area_date, today, '场次日期仍是今天');
    ok(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G).c) > 0, '仍关联今天的场次');
    eq(Number(get('SELECT specialarea_id FROM orders WHERE order_id = ?', no.order_id).specialarea_id),
      Number(rv.data?.area_id), '订单场次与商品关联一致');
    const energy = all('SELECT type, member_id, face_value FROM finance_energy WHERE remarks LIKE ?', `%${NO}%`);
    ok(energy.some((x) => Number(x.type) === 2 && Number(x.member_id) === A.id), '卖家 A 收到货款流水');
    ok(energy.some((x) => Number(x.type) === 1 && Number(x.member_id) === P.id), '上级 P 收到直推奖');
    ok(energy.some((x) => Number(x.type) === 3 && Number(x.member_id) === B.id), '接手人 B 收到积分');
    near(Number(get('SELECT amount FROM member WHERE member_id = ?', A.id).amount) - amountBefore, 3432, '卖家余额增加货款');
    ok(Number(get('SELECT score FROM member WHERE member_id = ?', B.id).score) > scoreBefore, '接手人积分增加');
    const logs = all('SELECT action FROM order_log WHERE order_id = ?', no.order_id).map((x) => x.action);
    ok(logs.includes('流拍指派'), '订单动态记录「流拍指派」');
    const audit = get("SELECT COUNT(*) c FROM admin_operation_log WHERE action = '指派流拍商品' AND details LIKE ?", `%${NO}%`);
    ok(Number(audit?.c || 0) > 0, '指派明细写进操作审计');

    section('[5] 会员端同步与列表退出');
    const bList = await api('/api/order/getOrder?page=1&limit=30', { token: B.token });
    ok((bList.data?.data || []).some((x) => Number(x.order_id) === Number(no.order_id)), 'B 的订单列表出现新单');
    const bShop = await api('/api/member/myShop?page=1&limit=50', { token: B.token });
    const bGoods = bShop.data?.data || bShop.data?.list || [];
    ok(bGoods.some((x) => Number(x.goods_id) === Number(G)), 'B 的我的店铺出现该货');
    const aShop = await api('/api/member/myShop?page=1&limit=50', { token: A.token });
    const aGoods = aShop.data?.data || aShop.data?.list || [];
    ok(!aGoods.some((x) => Number(x.goods_id) === Number(G)), 'A 的我的店铺不再显示该货');
    eq((await listOf()).total, 0, '指派后不再出现在流拍列表');

    console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : ''}`);
    if (fails.length) { console.log('失败项：'); for (const f of fails) console.log(' - ' + f); }
  } finally {
    cleanup();
  }
  await sleep(500);
  removeDb();
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
