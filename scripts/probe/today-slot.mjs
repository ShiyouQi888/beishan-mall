/**
 * 转拍排期到今天验收
 *
 * 覆盖：
 *   1. todaySlot 在今天有可开场次时返回今天；nextSlot 对未来日期的旧语义不变
 *   2. 转拍上架（consignment）不再沿用 goods.area_date 的未来日期，落今天
 *   3. /transpose/set-slot 手动把已排到未来的商品改回今天：上架、只关联一个场次、留痕
 *   4. H5 分类列表（LIST_VISIBLE 口径）改排前后确实查不到/查得到
 *   5. 拒绝条件：未登录、缺 confirm、订单不存在、已回收、无持有人、停用场次
 *
 * 独立库（probe-today-slot.db / 3479），跑完销毁。
 * 用法: node scripts/probe/today-slot.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3479;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-today-slot.db';
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

  const { todaySlot, nextSlot } = await import('../../server/src/lib/sessions.js');
  const { todayStr, addDays } = await import('../../server/src/lib/sessionWindow.js');
  const { db, get, all } = await import('../../server/src/db.js');
  const cleanup = () => { try { srv.kill(); } catch {} };
  try {
    // 全天开放、全周可抢：todaySlot 一定能在今天找到可开场次
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 0, open_days = '1,2,3,4,5,6,7', is_open = 10").run();
    const areas = all('SELECT specialarea_id FROM specialarea WHERE is_open = 10 ORDER BY start_time, specialarea_id');
    const today = todayStr();
    const future = addDays(today, 20);
    const at = await api('/admin/api/login', {
      method: 'POST', body: { user_name: 'admin1', password: '123456' },
    });
    const token = at.data.token;
    ok(!!token, '后台登录');

    section('[1] 排期函数口径');
    const slot = todaySlot(areas[0].specialarea_id);
    ok(!!slot, '今天有可开场次时 todaySlot 有结果');
    eq(slot?.date, today, 'todaySlot 返回今天（业务时区）');
    ok(areas.some((a) => Number(a.specialarea_id) === Number(slot.area_id)), 'todaySlot 返回启用中的场次');
    const oldNext = nextSlot(areas[0].specialarea_id, future);
    ok(!!oldNext && String(oldNext.date) >= future, 'nextSlot 对未来日期的旧语义未变（不回退）');

    const reg = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13975000001', password: 'probe123456', code: 'boss01', nickName: '排期验证会员' },
    });
    const A = Number(reg.data?.member_id);
    const aToken = (await api('/api/member/accountLogin', {
      method: 'POST', body: { phone: '13975000001', password: 'probe123456' },
    })).data.token;
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const gr = await api('/admin/api/goods/save', {
      method: 'POST', token,
      body: { goods_name: '排期验证·整件货', category_id: catId, goods_min_price: 1000, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const G = Number(gr.data?.id);
    db.prepare("UPDATE goods SET area_date = '', stock_total = 1, member_id = 0 WHERE goods_id = ?").run(G);
    const o1 = await api('/api/order/toAddOrder', {
      method: 'POST', token: aToken, body: { goods_id: G, num: 1, pay_type: 0 },
    });
    const O1 = Number(o1.data?.order_id);
    ok((await api('/admin/api/orders/confirm-pay', { method: 'POST', token, body: { order_id: O1 } })).code === 1,
      '第1手成交，货权归会员');
    const inList = async () => {
      const r = await api(`/api/goods/category/getCategoryGoodsList?category_id=${catId}&page=1&limit=50`);
      return (r.data?.data || []).some((x) => Number(x.goods_id) === Number(G));
    };

    section('[2] 新挂牌不再沿用未来日期');
    // 模拟截图：商品被排到 20 天后
    db.prepare("UPDATE goods SET area_date = ?, goods_status = 10, is_sell = 10 WHERE goods_id = ?").run(future, G);
    ok(!(await inList()), '排到未来时 H5 列表查不到（复现问题）');
    const cons = await api('/api/order/consignment', {
      method: 'POST', token: aToken, body: { order_id: O1 },
    });
    ok(cons.code === 1, '转拍上架成功', cons.msg);
    eq(get('SELECT area_date FROM goods WHERE goods_id = ?', G).area_date, today, '转拍上架落到今天');
    ok(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G).c) > 0, '已关联到今天的场次');
    ok(await inList(), 'H5 列表能看到该商品');

    section('[3] 手动改排到今天');
    db.prepare("UPDATE goods SET area_date = ?, goods_status = 20, is_sell = 0 WHERE goods_id = ?").run(future, G);
    const priceBefore = Number(get('SELECT total_price FROM orders WHERE order_id = ?', O1).total_price);
    const holderBefore = Number(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id);
    ok(!(await inList()), '改排前 H5 列表查不到');
    const setSlot = (body, tk = token) => api('/admin/api/transpose/set-slot', { method: 'POST', token: tk, body });
    const rs = await setSlot({ order_id: O1, confirm: 'SET_SLOT' });
    ok(rs.code === 1, '改排成功', rs.msg);
    eq(rs.data?.date, today, '返回摘要标出今天');
    eq(get('SELECT area_date FROM goods WHERE goods_id = ?', G).area_date, today, 'area_date 已改为今天');
    eq(Number(get('SELECT goods_status FROM goods WHERE goods_id = ?', G).goods_status), 10, '商品已重新上架');
    eq(Number(get('SELECT is_sell FROM goods WHERE goods_id = ?', G).is_sell), 10, '商品已开售');
    eq(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G).c), 1, '只关联一个场次');
    eq(Number(get('SELECT specialarea_id FROM goods WHERE goods_id = ?', G).specialarea_id), Number(rs.data?.area_id),
      '镜像列同步为首个关联场次');
    ok(await inList(), '改排后 H5 列表能看到该商品');
    const slog = all('SELECT action FROM order_log WHERE order_id = ?', O1).map((x) => x.action);
    ok(slog.includes('调整场次'), '订单动态记录「调整场次」');
    const audit = get("SELECT COUNT(*) c FROM admin_operation_log WHERE action = '调整转拍场次' AND details LIKE ?", `%${future}%`);
    ok(Number(audit?.c || 0) > 0, '改排明细写进操作审计');
    eq(Number(get('SELECT total_price FROM orders WHERE order_id = ?', O1).total_price), priceBefore, '订单金额未变');
    eq(Number(get('SELECT member_id FROM goods WHERE goods_id = ?', G).member_id), holderBefore, '货权未变');

    section('[4] 拒绝条件');
    ok((await setSlot({ order_id: O1, confirm: 'SET_SLOT' }, '')).code !== 1, '未登录管理员不能改排');
    ok((await setSlot({ order_id: O1 })).code !== 1, '缺少 confirm 被拒绝');
    ok((await setSlot({ order_id: 999999, confirm: 'SET_SLOT' })).code !== 1, '订单不存在被拒绝');
    const secondArea = areas[1];
    db.prepare('UPDATE goods SET recycled = 1 WHERE goods_id = ?').run(G);
    ok((await setSlot({ order_id: O1, confirm: 'SET_SLOT' })).code !== 1, '已回收商品被拒绝');
    db.prepare('UPDATE goods SET recycled = 0, member_id = 0 WHERE goods_id = ?').run(G);
    ok((await setSlot({ order_id: O1, confirm: 'SET_SLOT' })).code !== 1, '无持有人的商品被拒绝');
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(A, G);
    if (secondArea) {
      db.prepare('UPDATE specialarea SET is_open = 20 WHERE specialarea_id = ?').run(secondArea.specialarea_id);
      ok((await setSlot({ order_id: O1, area_id: secondArea.specialarea_id, confirm: 'SET_SLOT' })).code !== 1,
        '停用场次被拒绝');
      db.prepare('UPDATE specialarea SET is_open = 10 WHERE specialarea_id = ?').run(secondArea.specialarea_id);
    }
    eq(get('SELECT area_date FROM goods WHERE goods_id = ?', G).area_date, today, '被拒后排期不变');

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
