/**
 * 回撤转拍成交到指定手验收：后台 /admin/api/transpose/rollback
 *
 * 覆盖：
 *   1. 造真实三手链路（第1手 H5 成交 → 第2/3手后台新增单 + 确认收款 → 第3手转拍上架）
 *   2. 拒绝条件：未登录、缺 confirm、目标手不合法、货持有人已变化、链路外有待确认单
 *   3. 回撤到第 2 手：后续成交单、资金流水、账户余额、货权、标价、挂牌、场次全部回退
 *   4. 会员端同步、订单动态与审计留痕；再回撤到第 1 手
 *
 * 独立库（probe-rollback-chain.db / 3478），跑完销毁。
 * 用法: node scripts/probe/rollback-chain.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3478;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-rollback-chain.db';
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

  const { db, get, all } = await import('../../server/src/db.js');
  const cleanup = () => { try { srv.kill(); } catch {} };
  try {
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, is_open = 10, buy_num = 99').run();
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
    const P = await mkMember('13974000001', '回撤上级');
    const A = await mkMember('13974000002', '第一手买家', P.id);
    const B = await mkMember('13974000003', '第二手买家', P.id);
    const C = await mkMember('13974000004', '第三手买家', P.id);
    ok(A.id && B.id && C.id && P.id, '四个会员注册完成（含共同上级）');
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
      body: { goods_name: '回撤验证·整件货', category_id: catId, goods_min_price: 3300, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const G = Number(gr.data?.id);
    db.prepare("UPDATE goods SET area_date = '', stock_total = 1, stock_num = 1, member_id = 0 WHERE goods_id = ?").run(G);
    ok(!!G, '整件样品商品创建完成');

    // 第 1 手：H5 下单 + 确认收款
    const o1r = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: G, num: 1, pay_type: 0 },
    });
    ok(o1r.code === 1, '第1手 A 下单', o1r.msg);
    const O1 = Number(o1r.data.order_id);
    ok((await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: O1 } })).code === 1,
      '第1手确认收款');

    // 第 2/3 手：后台新增订单给下一手买家 + 确认收款（对齐截图里的「后台新增订单」）
    const nextHand = async (buyerId, price) => {
      // 真实链路：上一手成交后商品下架，持有人点「转拍上架」重新在售，下一手才买得到
      db.prepare("UPDATE goods SET goods_status = 10, is_sell = 10, area_date = '' WHERE goods_id = ?").run(G);
      const c = await api('/admin/api/orders/create', {
        method: 'POST', token: at, body: { member_id: buyerId, goods_id: G, price },
      });
      if (c.code !== 1) throw new Error('建单失败：' + c.msg);
      const oid = Number(c.data.order_id);
      const cp = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: oid } });
      if (cp.code !== 1) throw new Error('确认收款失败：' + cp.msg);
      return oid;
    };
    const O2 = await nextHand(B.id, 3432);
    const O3 = await nextHand(C.id, 3569.28);
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id, C.id, '三手后货权归第3手买家');
    const chain0 = (await api(`/admin/api/transpose/detail?id=${O3}`, { token: at })).data?.chain || [];
    eq(chain0.length, 3, '详情显示 3 手流转链路');
    eq(chain0[1].buyer_id, B.id, '第 2 手买家是 B（用户的回撤目标）');

    // 第 3 手转拍上架（模拟会员点「转拍上架」写入的状态）
    const areaId = Number(get('SELECT specialarea_id FROM specialarea LIMIT 1')?.specialarea_id || 0);
    db.prepare("UPDATE orders SET consignment_status = 10, transposition_time = ? WHERE order_id = ?")
      .run('2026-11-07 20:52:35', O3);
    db.prepare("UPDATE goods SET goods_status = 10, is_sell = 10, area_date = '2026-11-09', goods_min_price = 3712.05 WHERE goods_id = ?")
      .run(G);
    db.prepare('INSERT OR IGNORE INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)')
      .run(areaId, G, 1, '2026-11-07 20:52:35');
    ok(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G).c) > 0, '第3手已挂到下一场');

    const o3 = get('SELECT * FROM orders WHERE order_id = ?', O3);
    const account = (mid) => get('SELECT score, e_card_number, distribution_amount, amount FROM member WHERE member_id = ?', mid);
    const before = { B: account(B.id), C: account(C.id), P: account(P.id) };
    const energyOf = (no) => db.prepare(
      "SELECT * FROM finance_energy WHERE type IN (1,2,3) AND (remarks = ? OR substr(IFNULL(remarks,''),1,?) = ?)",
    ).all(`订单 ${no}`, `订单 ${no} `.length, `订单 ${no} `);
    const e3 = energyOf(o3.order_no);
    ok(e3.length > 0, '第3手成交产生了资金流水');
    const sumOf = (mid, type) => e3.filter((x) => Number(x.member_id) === mid && Number(x.type) === type)
      .reduce((s, x) => s + Number(x.face_value || 0), 0);

    const rollback = (body, token = at) => api('/admin/api/transpose/rollback', { method: 'POST', token, body });

    // ---------- 拒绝条件 ----------
    section('[1] 拒绝条件');
    ok((await rollback({ order_id: O3, target_step: 2, confirm: 'ROLLBACK_CHAIN' }, '')).code !== 1, '未登录管理员不能回撤');
    ok((await rollback({ order_id: O3, target_step: 2 })).code !== 1, '缺少 confirm 被拒绝');
    ok((await rollback({ order_id: O3, target_step: 3, confirm: 'ROLLBACK_CHAIN' })).code !== 1, '目标手 >= 当前链长被拒绝');
    ok((await rollback({ order_id: O3, target_step: 0, confirm: 'ROLLBACK_CHAIN' })).code !== 1, '目标手 < 1 被拒绝');
    ok((await rollback({ order_id: 999999, target_step: 2, confirm: 'ROLLBACK_CHAIN' })).code !== 1, '订单不存在被拒绝');
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(A.id, G);
    ok((await rollback({ order_id: O3, target_step: 2, confirm: 'ROLLBACK_CHAIN' })).code !== 1, '货持有人已变化时被拒绝');
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(C.id, G);
    eq(chain0.length, 3, '被拒绝的调用没有改动链路');

    // ---------- 回撤到第 2 手 ----------
    section('[2] 回撤到第 2 手');
    const rv = await rollback({ order_id: O3, target_step: 2, confirm: 'ROLLBACK_CHAIN' });
    ok(rv.code === 1, '回撤成功', rv.msg);
    eq(rv.data?.target_step, 2, '返回摘要标出目标手');
    eq(rv.data?.removed_count, 1, '撤销 1 笔成交');
    ok(!get('SELECT 1 FROM orders WHERE order_id = ?', O3), '第3手订单已删除');
    ok(!!get('SELECT 1 FROM orders WHERE order_id = ?', O1) && !!get('SELECT 1 FROM orders WHERE order_id = ?', O2),
      '第1、2手成交保留');
    const chain1 = (await api(`/admin/api/transpose/detail?id=${O2}`, { token: at })).data?.chain || [];
    eq(chain1.length, 2, '流转链路回到 2 手');

    section('[3] 资金与账户冲正');
    eq(energyOf(o3.order_no).length, 0, '第3手资金流水已清空');
    ok(rv.data?.reversal?.[0]?.rows > 0, '返回摘要列出被冲正流水条数');
    near(Number(account(B.id).amount), Number(before.B.amount) - sumOf(B.id, 2), '卖家 B 的货款已冲正');
    near(Number(account(C.id).score), Number(before.C.score) - sumOf(C.id, 3), '第3手买家积分已冲正');
    near(Number(account(P.id).e_card_number), Number(before.P.e_card_number) - sumOf(P.id, 1), '上级佣金已冲正');
    near(Number(account(P.id).distribution_amount), Number(before.P.distribution_amount) - sumOf(P.id, 1), '分销收益累计已冲正');

    section('[4] 货权、商品与挂牌状态');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id, B.id, '货权退回第2手买家 B');
    eq(Number(get('SELECT goods_status FROM goods WHERE goods_id = ?', G).goods_status), 20, '商品已下架');
    eq(Number(get('SELECT is_sell FROM goods WHERE goods_id = ?', G).is_sell), 0, '商品已停止出售');
    eq(get('SELECT area_date FROM goods WHERE goods_id = ?', G).area_date, '', '场次日期已清空');
    near(Number(get('SELECT goods_min_price FROM goods WHERE goods_id = ?', G).goods_min_price), 3432, '标价回到第2手成交价');
    eq(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G).c), 0, '已退出场次关联');
    eq(Number(get('SELECT consignment_status FROM orders WHERE order_id = ?', O2).consignment_status), 0,
      '目标手订单回到可重新转拍状态');
    const logs = all('SELECT action FROM order_log WHERE order_id = ?', O2).map((x) => x.action);
    ok(logs.includes('回撤流转'), '第2手订单动态记录「回撤流转」');
    const audit = get("SELECT COUNT(*) c FROM admin_operation_log WHERE action = '回撤转拍流转' AND details LIKE ?", `%${o3.order_no}%`);
    ok(Number(audit?.c || 0) > 0, '回撤明细写进操作审计');

    section('[5] 会员端同步');
    const cList = await api('/api/order/getOrder?page=1&limit=30', { token: C.token });
    ok(!(cList.data?.data || []).some((x) => Number(x.order_id) === Number(O3)), '第3手买家订单列表不再出现该单');
    const bShop = await api('/api/member/myShop?page=1&limit=50', { token: B.token });
    const bList = bShop.data?.data || bShop.data?.list || [];
    ok(bList.some((x) => Number(x.goods_id) === Number(G)), '第2手买家的我的店铺恢复该货');
    const cShop = await api('/api/member/myShop?page=1&limit=50', { token: C.token });
    const cShopList = cShop.data?.data || cShop.data?.list || [];
    ok(!cShopList.some((x) => Number(x.goods_id) === Number(G)), '第3手买家的我的店铺不再显示该货');

    section('[6] 再回撤到第 1 手');
    const rv2 = await rollback({ order_id: O2, target_step: 1, confirm: 'ROLLBACK_CHAIN' });
    ok(rv2.code === 1, '再回撤一次成功', rv2.msg);
    const chain2 = (await api(`/admin/api/transpose/detail?id=${O1}`, { token: at })).data?.chain || [];
    eq(chain2.length, 1, '流转链路只剩 1 手');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id, A.id, '货权退回第1手买家 A');
    ok(!get('SELECT 1 FROM orders WHERE order_id = ?', O2), '第2手订单已删除');

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
