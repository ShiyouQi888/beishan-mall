// 抢完/到期商品保留展示（灰卡 + 已抢完）回归
// 独立库（sold-out-card.db / 3435）
// 用法: node scripts/probe/sold-out-card.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3435;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'sold-out-card.db';

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

const day = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
    ok(!!at && !!A && !!B, '后台与两个会员登录成功');

    // 场次全开、费率清零，把变量降到只剩「列表口径」
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0', price_increase_rate: '0' } } });
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99, open_days = '1,2,3,4,5,6,7'").run();
    for (const phone of ['13800000001', '13800000004']) {
      const mid = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(phone).id;
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 3000000, remark: '灰卡测试' } });
    }

    const listIds = async (token) => {
      const r = await api('/api/goods/getLootGoodsList?page=1&limit=100', { token });
      return r.data?.data || [];
    };
    const pick = (exclude = []) => db.prepare(
      `SELECT * FROM goods WHERE type = 1 AND goods_status = 10 AND IFNULL(is_split,0) = 0
         AND member_id NOT IN (1,4) AND goods_id NOT IN (${exclude.length ? exclude.join(',') : 0})
       ORDER BY goods_id LIMIT 1`,
    ).get();

    // ---------------- 本场卖完的货留在列表里 ----------------
    section('[1] 本场成交的货要留在列表里，标成已抢完');
    const g1 = pick([]);
    ok(!!g1, '找到一件在售整件商品');
    // 标记成「今天这一场」的货，这样成交后它才属于「本场次该保留展示」的范围
    db.prepare('UPDATE goods SET area_date = ? WHERE goods_id = ?').run(day(0), g1.goods_id);

    const o1 = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: g1.goods_id, num: 1, pay_type: 1 } });
    ok(o1.code === 1, 'B 下单', o1.msg);
    const p1 = await api('/api/order/toPay', { method: 'POST', token: B, body: { order_id: o1.data.order_id, pay_type: 1 } });
    ok(p1.code === 1, 'B 支付成功', p1.msg);
    const g1After = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(g1.goods_id);
    ok(Number(g1After.goods_status) === 20, '商品成交后下架', `status=${g1After.goods_status}`);

    const l1 = await listIds(B);
    const card1 = l1.find((x) => x.goods_id === g1.goods_id);
    ok(!!card1, '抢购列表里仍然有它（不再凭空消失）');
    ok(card1 && Number(card1.sold_out) === 1, '卡片带 sold_out=1（前端据此置灰）', card1 && `sold_out=${card1.sold_out}`);

    // 在售的必须排在已抢完前面，否则用户一眼看到的全是灰卡
    const firstSoldIdx = l1.findIndex((x) => Number(x.sold_out) === 1);
    const lastOnSaleIdx = l1.map((x) => Number(x.sold_out)).lastIndexOf(0);
    ok(lastOnSaleIdx < 0 || firstSoldIdx < 0 || firstSoldIdx > lastOnSaleIdx, '在售商品排在已抢完之前',
      `第一个灰卡 #${firstSoldIdx}，最后一个在售 #${lastOnSaleIdx}`);

    // 场次列表（首页抢购页用的那个）
    const loot = await api('/api/goods/getLootList', { token: B });
    const area1 = (loot.data?.list || []).find((a) => a.specialarea_id === g1.specialarea_id);
    const inArea = area1?.goods_list?.find((x) => x.goods_id === g1.goods_id);
    ok(!!inArea, '所属场次的商品列表里也有它');
    ok(inArea && Number(inArea.sold_out) === 1, '场次列表里同样标为已抢完');

    // 详情页
    const det = await api(`/api/goods/getLootDetails?goods_id=${g1.goods_id}`, { token: B });
    ok(det.code === 1, '详情页仍能打开', det.msg);
    ok(Number(det.data?.sold_out) === 1, '详情页返回 sold_out=1（按钮变「已抢完」）');

    section('[2] 已抢完的商品不能再下单');
    const again = await api('/api/order/toAddOrder', { method: 'POST', token: A, body: { goods_id: g1.goods_id, num: 1, pay_type: 1 } });
    ok(again.code !== 1, '再次下单被拒', again.msg);
    ok(/下架|抢完|不存在/.test(again.msg || ''), '拒绝原因说得清', again.msg);

    // ---------------- 不限日期的货卖完就消失，不挂永久灰卡 ----------------
    section('[3] 不限日期的商品售罄后直接消失（不留永久灰卡）');
    const g2 = pick([g1.goods_id]);
    ok(!!g2, '找到第二件商品');
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(g2.goods_id);
    const o2 = await api('/api/order/toAddOrder', { method: 'POST', token: B, body: { goods_id: g2.goods_id, num: 1, pay_type: 1 } });
    if (o2.code === 1) {
      await api('/api/order/toPay', { method: 'POST', token: B, body: { order_id: o2.data.order_id, pay_type: 1 } });
      const after2 = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(g2.goods_id);
      ok(Number(after2.goods_status) === 20, '第二件成交下架');
      const l2 = await listIds(B);
      ok(!l2.some((x) => x.goods_id === g2.goods_id), '列表里没有它（不限日期的货不参与灰卡保留）');
    } else {
      ok(true, '跳过（第二件不可买）');
      ok(true, '跳过（第二件不可买）');
    }

    // ---------------- 昨天场次的下架货不出现 ----------------
    section('[4] 已经是别的日期的下架货不会混进来');
    const g3 = pick([g1.goods_id, g2.goods_id]);
    if (g3) {
      db.prepare("UPDATE goods SET area_date = ?, goods_status = 20 WHERE goods_id = ?").run(day(-1), g3.goods_id);
      const l3 = await listIds(B);
      ok(!l3.some((x) => x.goods_id === g3.goods_id), '昨天场次的下架商品不出现');
    } else {
      ok(true, '跳过（无第三件商品）');
    }

    // ---------------- 分类列表口径一致 ----------------
    section('[5] 分类列表与抢购列表同一口径');
    const cat = await api(`/api/goods/category/getCategoryGoodsList?category_id=${g1.category_id}&page=1&limit=100`, { token: B });
    const catList = cat.data?.data || [];
    const catCard = catList.find((x) => x.goods_id === g1.goods_id);
    ok(!!catCard, '分类列表里也能看到已抢完的它');
    ok(catCard && Number(catCard.sold_out) === 1, '分类列表同样带 sold_out=1');

    // ---------------- 首页「全部」列表口径一致 ----------------
    section('[6] 商城商品不会被误标成已抢完');
    const shop = await api('/api/goods/searchShop?page=1&limit=50');
    const shopSoldOut = (shop.data?.data || []).filter((x) => Number(x.sold_out) === 1);
    ok(shopSoldOut.length === 0, '商城商品（type=2）没有一件被标成已抢完', `${shopSoldOut.length} 件被误标`);
    // ---------------- 详情接口字段契约 ----------------
    // 前端「能不能抢」全靠这几个字段判定。少返回一个，前端就会静默放行 ——
    // 曾经 fmtGoods 漏返回 type，导致详情页 Number(undefined) === 1 恒为 false，
    // 抢购商品在非抢购时段也显示「立即抢购」且按钮能点。
    section('[7] 详情接口必须带齐判定字段');
    const d1 = await api(`/api/goods/getLootDetails?goods_id=${g1.goods_id}`);
    ok(d1.code === 1, '详情接口可用', d1.msg);
    ok(d1.data?.type !== undefined, '返回 type（前端据此区分抢购/商城商品）', `type=${d1.data?.type}`);
    ok(d1.data?.sold_out !== undefined, '返回 sold_out（前端据此判断已抢完）', `sold_out=${d1.data?.sold_out}`);
    ok(d1.data?.is_ordinary_order !== undefined, '返回 is_ordinary_order（前端据此判断能否抢）',
      `is_ordinary_order=${d1.data?.is_ordinary_order}`);

    // 让某场次变成「已结束」，再确认 is_ordinary_order 归零
    const area2 = db.prepare('SELECT * FROM specialarea ORDER BY specialarea_id LIMIT 1').get();
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 1 WHERE specialarea_id = ?').run(area2.specialarea_id);
    const g4 = db.prepare(
      "SELECT goods_id, member_id FROM goods WHERE type = 1 AND goods_status = 10 AND specialarea_id = ? LIMIT 1",
    ).get(area2.specialarea_id);
    if (g4) {
      // 不能买自己持有的货，按持有人挑另一个账号来下这一单
      const buyer = Number(g4.member_id) === 1 ? B : A;
      const d4 = await api(`/api/goods/getLootDetails?goods_id=${g4.goods_id}`);
      ok(Number(d4.data?.is_ordinary_order) === 0, '场次已结束时 is_ordinary_order=0（详情页按钮必须禁用）',
        `is_ordinary_order=${d4.data?.is_ordinary_order}`);
      ok(Number(d4.data?.sold_out) === 0, '场次结束不算「已抢完」，两个状态不能混',
        `sold_out=${d4.data?.sold_out}`);
      const listEnded = await api(`/api/goods/getLootGoodsList?page=1&limit=100&specialarea_id=${area2.specialarea_id}`, { token: B });
      const row4 = (listEnded.data?.data || []).find((x) => x.goods_id === g4.goods_id);
      ok(!!row4 && row4.session_state === 'ended', '列表里该商品 session_state=ended（首页/分类据此置灰）',
        row4 && `session_state=${row4.session_state}`);
      const blocked = await api('/api/order/toAddOrder', { method: 'POST', token: buyer, body: { goods_id: g4.goods_id, num: 1, pay_type: 1 } });
      ok(blocked.code !== 1 && /抢购时间|未开放/.test(blocked.msg || ''), '场次结束后下单被拒', blocked.msg);
    } else {
      ok(true, '跳过（该场次无在售商品）');
      ok(true, '跳过（该场次无在售商品）');
      ok(true, '跳过（该场次无在售商品）');
    }
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399 WHERE specialarea_id = ?').run(area2.specialarea_id);
    // ---------------- 各入口的卡片状态字段必须齐 ----------------
    section('[8] 首页/分类/搜索的卡片状态与抢购页同一口径');
    const all = await api('/api/goods/getLootGoodsList?page=1&limit=100', { token: B });
    const allRows = all.data?.data || [];
    ok(allRows.length > 0, '抢购列表有数据');
    ok(allRows.every((x) => x.session_state !== undefined), '每条都带 session_state（首页据此置灰）',
      allRows.filter((x) => x.session_state === undefined).length + ' 条缺失');
    ok(allRows.every((x) => x.sold_out !== undefined), '每条都带 sold_out');
    ok(allRows.every((x) => x.type !== undefined), '每条都带 type');

    const endedRow = allRows.find((x) => x.session_state === 'ended' || x.session_state === 'closed');
    const openRow = allRows.find((x) => x.session_state === 'open');
    ok(!!openRow, '存在「进行中」的商品（session_state=open）', openRow && openRow.goods_name);
    if (endedRow) {
      ok(Number(endedRow.sold_out) === 0, '场次结束的商品不算已抢完（两个状态分开）', `${endedRow.goods_name} sold_out=${endedRow.sold_out}`);
    } else {
      ok(true, '跳过（没有已结束场次的商品）');
    }

    const catRes = await api(`/api/goods/category/getCategoryGoodsList?category_id=${openRow?.category_id || 1}&page=1&limit=100`, { token: B });
    const catRows = catRes.data?.data || [];
    ok(catRows.every((x) => x.session_state !== undefined), '分类列表也带 session_state');

    const searchRes = await api(`/api/goods/searchShop?keywords=${encodeURIComponent('玉')}&page=1&limit=50`);
    const searchRows = searchRes.data?.data || [];
    ok(searchRows.every((x) => x.session_state !== undefined), '搜索结果也带 session_state',
      searchRows.length ? `${searchRows.length} 条` : '无结果');

    const dRow = await api(`/api/goods/getLootDetails?goods_id=${openRow?.goods_id || g1.goods_id}`);
    ok(dRow.data?.session_state !== undefined, '详情接口带 session_state',
      `session_state=${dRow.data?.session_state}`);
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
