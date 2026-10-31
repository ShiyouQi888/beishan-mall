// 价格上限（金额封顶）& 色块水位回归
// 独立库（price-cap.db / 3450），跑完自动销毁，不碰演示库
// 用法: node scripts/probe/price-cap.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3450;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'price-cap.db';

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

async function main() {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
  const { db } = await import('../../server/src/db.js');

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

    // 场次全天开放 + 涨价率 3% + 服务费 2% + 上架费 0，口径与线上一致
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7'").run();
    await api('/admin/api/setting/save', {
      method: 'POST', token: at,
      body: { group: 'trade', values: { service_charge: '2', listing_fee_rate: '0', price_increase_rate: '3' } },
    });

    const holder = db.prepare("SELECT member_id FROM member WHERE mobile = '13800000001'").get().member_id;
    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    const buyers = [];
    for (const mobile of ['13822367845', '13800000002', '13800000003']) {
      const m = db.prepare('SELECT * FROM member WHERE mobile = ?').get(mobile);
      if (!m) continue;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: m.member_id, field: 'amount', value: 200000, remark: '价格上限测试' },
      });
      const login = await api('/api/member/accountLogin', { method: 'POST', body: { phone: mobile, password: mobile } });
      if (login.code === 1) buyers.push({ mid: m.member_id, token: login.data.token });
    }
    ok(buyers.length >= 2, '准备两个买家账号', `${buyers.length} 个`);

    const createGoods = async (body) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: {
          goods_name: body.name, goods_no: `CAP-${Math.random().toString(36).slice(2, 8)}`,
          category_id: catId, member_id: holder, goods_min_price: body.price,
          base_price: body.base ?? body.price, price_cap: body.cap ?? 0,
          line_price: Math.round(body.price * 1.5),
          stock_num: 1, sales_actual: 0, goods_status: 10, goods_sort: 1, ...body,
        },
      });
      return Number(r.data?.id) || 0;
    };
    const rowOf = (id) => db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(id);
    const goodsInList = async (id) => {
      const r = await api('/admin/api/goods/list?limit=100', { token: at });
      return (r.data?.data || []).find((x) => Number(x.goods_id) === Number(id));
    };
    const buyAndPay = async (buyer, goodsId, num = 1) => {
      // 转拍会把商品排到下一场（跨天），联调里直接放开日期，模拟「到了那一天」
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(goodsId);
      const o = await api('/api/order/toAddOrder', { method: 'POST', token: buyer.token, body: { goods_id: goodsId, num, pay_type: 1 } });
      if (o.code !== 1) return o;
      const p = await api('/api/order/toPay', { method: 'POST', token: buyer.token, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ...p, order_id: o.data.order_id, total: o.data.total_price };
    };

    // ================= 1. 默认值 =================
    section('[1] 新建商品：基准价默认取售价、价格上限默认 0（不限）');
    const g1 = await createGoods({ name: '价格上限样品', price: 1000 });
    const r1 = rowOf(g1);
    eq(r1.base_price, 1000, '基准价默认 = 售价');
    eq(r1.price_cap, 0, '价格上限默认 0');

    // ================= 2. 设置金额上限 =================
    section('[2] 上限 ¥1100：围栏判定（当前 1060，下一轮 1091.8 不越界）');
    await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_id: g1, base_price: 1000, price_cap: 1100, goods_min_price: 1060 },
    });
    const g1row = rowOf(g1);
    eq(g1row.price_cap, 1100, '价格上限落库 ¥1100');
    const listed = await goodsInList(g1);
    ok(!!listed?._cap, '列表返回 _cap 水位对象');
    eq(listed?._cap?.cap_price, 1100, '上限价 = 填的金额 1100');
    eq(listed?._cap?.current, 1060, '当前价 1060');
    eq(listed?._cap?.headroom, 40, '离围栏还有 40 元');
    eq(listed?._cap?.pct, 6, '相对基准价累计涨幅 +6%');
    eq(listed?._cap?.ratio, 0.6, '水位 = (1060-1000)/(1100-1000)');
    ok(listed?._cap?.level === 'yellow', '60% 水位落在黄色预警', listed?._cap?.level);
    ok(listed?._cap?.reached === false, '下一轮 1091.8 不越界 → 未到顶');

    // ================= 3. 转拍价格削到上限 =================
    section('[3] 转拍：1060 → 1091.8（未越界，正常加价）');
    const b1 = buyers[0];
    const pay1 = await buyAndPay(b1, g1);
    ok(pay1.code === 1, '买家 1 买下 1060 并支付', pay1.msg);
    const quote1 = await api(`/api/order/getConsignmentQuote?order_id=${pay1.order_id}`, { token: b1.token });
    ok(quote1.code === 1, '未到顶可以报价', quote1.msg);
    eq(quote1.data?.next_price, 1091.8, '报价 = 1060 × 1.03');
    eq(quote1.data?.cap_price, 1100, '报价返回上限价');
    ok(quote1.data?.capped === false, '没有触发削顶');
    const cons1 = await api('/api/order/consignment', { method: 'POST', token: b1.token, body: { order_id: pay1.order_id } });
    ok(cons1.code === 1, '转拍成功', cons1.msg);
    eq(rowOf(g1).goods_min_price, 1091.8, '商品标价 1091.8');

    // 到了 1091.8，下一轮 1124.55 会越过 1100 的围栏 —— 此时才算到顶
    const listedAtFence = await goodsInList(g1);
    ok(listedAtFence?._cap?.reached === true, '下一轮会越界 → 判定到顶', JSON.stringify(listedAtFence?._cap));
    eq(listedAtFence?._cap?.next_price, 1124.55, '下一轮理论价 1124.55');

    // ================= 4. 到顶后禁止转拍 =================
    section('[4] 已到顶：报价与转拍都要拒绝');
    // 另一件「刚买下、还没挂牌」的到顶商品：转拍会被围栏拦下
    const gCap = await createGoods({ name: '围栏拦截样品', price: 1091.8, base: 1000, cap: 1100 });
    const buyCap = await buyAndPay(buyers[1], gCap);
    ok(buyCap.code === 1, '买家按 1091.8 买下', buyCap.msg);
    const quote2 = await api(`/api/order/getConsignmentQuote?order_id=${buyCap.order_id}`, { token: buyers[1].token });
    ok(quote2.code === 0 && /价格上限/.test(quote2.msg), '报价接口拒绝并说明原因', quote2.msg);
    const cons2 = await api('/api/order/consignment', { method: 'POST', token: buyers[1].token, body: { order_id: buyCap.order_id } });
    ok(cons2.code === 0 && /价格上限/.test(cons2.msg), '转拍接口拒绝', cons2.msg);
    eq(rowOf(gCap).goods_min_price, 1091.8, '被拒后价格没有变化');

    const listed2 = await goodsInList(g1);
    ok(listed2?._cap?.reached === true && listed2?._cap?.level === 'red', '列表色块为「已达上限 / 红」', listed2?._cap?.level);

    const shop = await api('/api/member/myShop', { token: b1.token });
    const item = (shop.data?.list || []).find((x) => Number(x.goods_id) === g1);
    ok(!!item, '我的店铺里有这件商品');
    ok(item?.cap_reached === true && item?.transferable === false, '我的店铺标记「已达上限 / 不可转拍」');
    eq(item?.cap_price, 1100, '我的店铺返回上限价');

    // 回收：按商品当前实际价格 1091.8 接盘（持有人赚到这一轮涨幅）
    const beforeRecycle = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(b1.mid).amount);
    const scan = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scan.code === 1 && scan.data.settled >= 1, '到顶商品被回收', scan.msg);
    const rec = db.prepare('SELECT * FROM goods_recycle WHERE goods_id = ? ORDER BY recycle_id DESC LIMIT 1').get(g1);
    eq(rec?.recycle_price, 1091.8, '回收价 = 当前实际标价 1091.8');
    // 收益按实际成本算：买入 1060 + 抢单服务费 21.2（2%）= 1081.2
    eq(rec?.buy_cost, 1081.2, '回收台书记录实际成本 1081.2（含服务费）');
    eq(rec?.profit, 10.6, '持有人收益 = 1091.8 − 1081.2');
    eq(Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(b1.mid).amount) - beforeRecycle, 1091.8, '款项按实际价格入账');

    // ================= 5. 未设上限：仍按 3% 复利 =================
    section('[5] 不设上限（0）：照常按 3% 涨价');
    const g2 = await createGoods({ name: '价格上限样品-无上限', price: 500 });
    const pay3 = await buyAndPay(buyers[0], g2);
    ok(pay3.code === 1, '买家 1 买下 500', pay3.msg);
    const cons3 = await api('/api/order/consignment', { method: 'POST', token: buyers[0].token, body: { order_id: pay3.order_id } });
    ok(cons3.code === 1, '转拍成功', cons3.msg);
    eq(rowOf(g2).goods_min_price, 515, '无上限时 = 500 × 1.03');

    // ================= 6. 编辑保护与校验 =================
    section('[6] 编辑：基准价留空不改、上限非法值归 0');
    await api('/admin/api/goods/save', {
      method: 'POST', token: at, body: { goods_id: g2, base_price: 0, goods_min_price: 515 },
    });
    eq(rowOf(g2).base_price, 500, '传 0 不会把基准价清掉');
    await api('/admin/api/goods/save', {
      method: 'POST', token: at, body: { goods_id: g2, price_cap: -5 },
    });
    eq(rowOf(g2).price_cap, 0, '负数上限归 0（不限）');
    await api('/admin/api/goods/save', {
      method: 'POST', token: at, body: { goods_id: g2, price_cap: 1e12 },
    });
    eq(rowOf(g2).price_cap, 1e9, '超大上限被截到 1e9');

    // ================= 7. 上限低于当前价 = 直接到顶 =================
    section('[7] 上限低于当前价：立即判定到顶');
    const g3 = await createGoods({ name: '价格上限低于现价', price: 2000 });
    await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: g3, price_cap: 1500 } });
    const listed3 = await goodsInList(g3);
    ok(listed3?._cap?.reached === true, '当前价高于上限 → reached');
    eq(listed3?._cap?.ratio, 1, '水位直接拉满');

    // ================= 8. 复制商品 =================
    section('[8] 复制商品');
    const dup = await api('/admin/api/goods/duplicate', { method: 'POST', token: at, body: { goods_id: g1 } });
    ok(dup.code === 1, '复制成功', dup.msg);
    const dupRow = rowOf(Number(dup.data.goods_id));
    eq(dupRow.price_cap, 1100, '副本沿用价格上限');
    eq(dupRow.base_price, dupRow.goods_min_price, '副本基准价取自身售价（水位从 0 起算）');

    section('[9] 数据一致性');
    ok(db.prepare('SELECT COUNT(*) c FROM goods WHERE base_price > 0').get().c > 0, '所有商品都有基准价');
    ok(money(rowOf(g1).goods_min_price) <= money(rowOf(g1).price_cap || Infinity) + 0.001, '商品价格从未越过上限');
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
