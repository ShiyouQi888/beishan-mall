// 系统回收（到顶自动结算）回归
// 独立库（recycle.db / 3460），跑完自动销毁，不碰演示库
// 用法: node scripts/probe/recycle.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3460;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'recycle.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
// 关掉 60 秒定时扫描，避免定时器抢在断言前把货结算掉
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0' };

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

    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7'").run();
    const setTrade = (values) => api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values } });
    await setTrade({ service_charge: '2', listing_fee_rate: '0', price_increase_rate: '3', recycle_open: '10', recycle_daily_cap: '0' });

    const holder = db.prepare("SELECT member_id FROM member WHERE mobile = '13800000001'").get().member_id;
    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    const loginBuyer = async (mobile) => {
      const m = db.prepare('SELECT * FROM member WHERE mobile = ?').get(mobile);
      if (!m) return null;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: m.member_id, field: 'amount', value: 200000, remark: '系统回收测试充值' },
      });
      const r = await api('/api/member/accountLogin', { method: 'POST', body: { phone: mobile, password: mobile } });
      return r.code === 1 ? { mid: m.member_id, token: r.data.token } : null;
    };
    const b1 = await loginBuyer('13822367845');
    const b2 = await loginBuyer('13800000002');
    ok(!!b1 && !!b2, '准备两个买家账号');

    const createGoods = async ({ name, price, cap, base }) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: {
          goods_name: name, goods_no: `RC-${Math.random().toString(36).slice(2, 8)}`,
          category_id: catId, member_id: holder, goods_min_price: price,
          base_price: base ?? price, price_cap: cap ?? 0,
          line_price: Math.round(price * 1.5), stock_num: 1, sales_actual: 0, goods_status: 10, goods_sort: 1,
        },
      });
      return Number(r.data?.id) || 0;
    };
    const rowOf = (id) => db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(id);
    const balance = (mid) => money(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(mid).amount);
    const buyAndPay = async (buyer, goodsId) => {
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(goodsId);
      const o = await api('/api/order/toAddOrder', { method: 'POST', token: buyer.token, body: { goods_id: goodsId, num: 1, pay_type: 1 } });
      if (o.code !== 1) return o;
      const p = await api('/api/order/toPay', { method: 'POST', token: buyer.token, body: { order_id: o.data.order_id, pay_type: 1 } });
      return { ...p, order_id: o.data.order_id, total: money(o.data.total_price) };
    };
    const recycleOf = (goodsId) => db.prepare('SELECT * FROM goods_recycle WHERE goods_id = ? ORDER BY recycle_id DESC LIMIT 1').get(goodsId);

    // ================= 1. 到顶商品自动回收 =================
    section('[1] 买到上限价 → 转拍被拒 → 自动回收结算');
    const g1 = await createGoods({ name: '到顶回收样品', price: 1100, base: 1000, cap: 1100 });
    const o1 = await buyAndPay(b1, g1);
    ok(o1.code === 1, '买家按上限价 1100 买下并支付', o1.msg);
    const g1AfterBuy = rowOf(g1);
    eq(g1AfterBuy.member_id, b1.mid, '商品归买家');
    eq(g1AfterBuy.goods_status, 20, '成交即下架（卡死的状态）');

    const cons1 = await api('/api/order/consignment', { method: 'POST', token: b1.token, body: { order_id: o1.order_id } });
    ok(cons1.code === 0 && /价格上限/.test(cons1.msg), '到顶后不能转拍', cons1.msg);

    const before1 = balance(b1.mid);
    const scan1 = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scan1.code === 1 && scan1.data.settled === 1, '扫描结算 1 件', scan1.msg);
    const rec1 = recycleOf(g1);
    eq(rec1?.status, 10, '回收单状态 = 已结算');
    eq(rec1?.buy_price, 1100, '记录买入价 1100');
    eq(rec1?.recycle_price, 1100, '回收价 = 当前实际价格 1100（刚买下即到顶）');
    // 收益按「实际成本」算：买入 1100 + 抢单服务费 22（2%）= 1122，原价接盘就是净亏 22
    eq(rec1?.buy_cost, 1122, '记录实际成本 1122（买入价 + 服务费）');
    eq(rec1?.profit, -22, '这一手没有涨幅，扣掉服务费后净亏 22');
    eq(rec1?.cap_price, 1100, '记录当时上限价');
    eq(rec1?.order_id, o1.order_id, '关联持有人买入订单');
    eq(balance(b1.mid) - before1, 1100, '持有人余额 +1100（原价接盘）');

    const flow = db.prepare("SELECT * FROM finance_energy WHERE member_id = ? AND type_name = '系统回收' ORDER BY energy_id DESC LIMIT 1").get(b1.mid);
    ok(!!flow && money(flow.face_value) === 1100, '资金流水记录「系统回收」', flow && flow.face_value);

    const g1After = rowOf(g1);
    eq(g1After.member_id, 0, '商品转平台持仓');
    eq(g1After.goods_status, 20, '回收后仍下架');
    eq(db.prepare('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?').get(g1).c, 0, '商品已退出所有场次');

    eq(g1After.recycled, 1, '商品打上「封顶」标记');

    // 前台各入口都不能再出现（列表 / 搜索 / 分类 / 详情）
    const lootList = await api('/api/goods/getLootGoodsList?page=1&limit=100');
    ok(!(lootList.data?.data || []).some((x) => Number(x.goods_id) === g1), '抢购列表不再出现');
    const shopList = await api('/api/goods/searchShop?page=1&limit=100');
    ok(!(shopList.data?.data || []).some((x) => Number(x.goods_id) === g1), '商城/搜索结果不再出现');
    const catList = await api(`/api/goods/category/getCategoryGoodsList?category_id=${catId}&page=1&limit=100`);
    ok(!(catList.data?.data || []).some((x) => Number(x.goods_id) === g1), '分类列表不再出现');
    const detail = await api(`/api/goods/getLootDetails?goods_id=${g1}`);
    ok(detail.code === 0, '详情接口按「不存在」处理', detail.msg);

    const adminList = await api('/admin/api/goods/list?limit=100', { token: at });
    const adminRow = (adminList.data?.data || []).find((x) => Number(x.goods_id) === g1);
    eq(adminRow?.recycled, 1, '后台列表能看到「封顶」标记');

    const msg = db.prepare('SELECT * FROM member_msg WHERE member_id = ? ORDER BY msg_id DESC LIMIT 1').get(b1.mid);
    ok(!!msg && /回收/.test(msg.title + msg.content), '给持有人发了回收通知', msg && msg.title);

    const shop = await api('/api/member/myShop', { token: b1.token });
    ok(!(shop.data?.list || []).some((x) => Number(x.goods_id) === g1), '我的店铺里已不再显示该商品');

    const scanAgain = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scanAgain.data.settled === 0 && scanAgain.data.scanned === 0, '重复扫描幂等（不会重复打款）');

    // ================= 1.5 二次上架 =================
    section('[1.5] 后台改回上架 = 二次上架：解封顶、重置基准价、前台重新出现');
    const relist = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_id: g1, goods_status: 10, goods_min_price: 1200, price_cap: 1400 },
    });
    ok(relist.code === 1 && relist.data?.relisted === true, '返回「二次上架」提示', relist.msg);
    const g1Relist = rowOf(g1);
    eq(g1Relist.recycled, 0, '封顶标记已清除');
    eq(g1Relist.goods_status, 10, '状态改回上架');
    eq(g1Relist.base_price, 1200, '基准价重置为当前售价（水位从 0 算）');
    const shopList2 = await api('/api/goods/searchShop?page=1&limit=100');
    ok((shopList2.data?.data || []).some((x) => Number(x.goods_id) === g1), '前台重新能看到这件货');

    // 后台只是下架、没上架时不会解封顶
    await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: g1, goods_status: 20 } });

    // ================= 2. 开关关闭 → 待处理 =================
    section('[2] 自动回收关闭：只记待处理，不打款');
    await setTrade({ recycle_open: '20' });
    const g2 = await createGoods({ name: '开关关闭样品', price: 1100, base: 1000, cap: 1100 });
    const o2 = await buyAndPay(b2, g2);
    ok(o2.code === 1, '买家买下到顶商品', o2.msg);
    const b2Before = balance(b2.mid);
    const scan2 = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scan2.data.pending === 1 && scan2.data.settled === 0, '记为待处理', scan2.msg);
    const rec2 = recycleOf(g2);
    eq(rec2?.status, 20, '回收单状态 = 待处理');
    eq(balance(b2.mid), b2Before, '余额没有变化');
    eq(rowOf(g2).member_id, b2.mid, '商品仍在持有人名下');

    const settle2 = await api('/admin/api/recycle/settle', { method: 'POST', token: at, body: { recycle_id: rec2.recycle_id } });
    ok(settle2.code === 1, '手动结算成功', settle2.msg);
    eq(balance(b2.mid) - b2Before, 1100, '手动结算后余额 +1100');
    eq(recycleOf(g2).status, 10, '状态改为已结算');
    eq(rowOf(g2).member_id, 0, '商品转平台持仓');

    const settleAgain = await api('/admin/api/recycle/settle', { method: 'POST', token: at, body: { recycle_id: rec2.recycle_id } });
    ok(settleAgain.code === 0 && /已结算/.test(settleAgain.msg), '重复结算被拒', settleAgain.msg);

    // ================= 3. 每日上限 =================
    section('[3] 超出每日回收上限：只记待处理');
    await setTrade({ recycle_open: '10', recycle_daily_cap: '100' });
    const g3 = await createGoods({ name: '超限额样品', price: 1100, base: 1000, cap: 1100 });
    const o3 = await buyAndPay(b1, g3);
    ok(o3.code === 1, '买家买下到顶商品', o3.msg);
    const scan3 = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scan3.data.pending >= 1, '超出日限额 → 待处理', scan3.msg);
    const rec3 = recycleOf(g3);
    eq(rec3?.status, 20, '回收单待处理');
    ok(/每日回收上限/.test(rec3?.remark || ''), '备注写明超限原因', rec3?.remark);

    // ================= 4. 边界 =================
    section('[4] 边界：未到顶不回收 / 挂牌到顶照收 / 缺买入订单转待处理');
    await setTrade({ recycle_daily_cap: '0' });

    // 4.1 未到顶
    const g4 = await createGoods({ name: '未到顶样品', price: 1000, base: 1000, cap: 1200 });
    await buyAndPay(b2, g4);
    eq(rowOf(g4).goods_status, 20, '未到顶商品成交后也是下架态');
    let sc = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    eq(sc.data.settled, 0, '未到顶不回收');
    eq(rowOf(g4).member_id, b2.mid, '商品仍归持有人');

    // 4.2 到顶但仍在挂牌：到顶即退出流通，不等接盘人
    const g5 = await createGoods({ name: '挂牌到顶样品', price: 1100, base: 1000, cap: 1100 });
    const o5 = await buyAndPay(b2, g5);
    ok(o5.code === 1, '买家买下到顶商品', o5.msg);
    await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: g5, goods_status: 10 } });
    eq(rowOf(g5).goods_status, 10, '后台重新挂牌（状态仍为上架）');
    const beforeG5 = balance(b2.mid);
    sc = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    eq(sc.data.settled, 1, '挂牌中的到顶商品也会被回收');
    eq(balance(b2.mid) - beforeG5, 1100, '挂牌回收同样按当前实际价格 1100 结算');
    eq(rowOf(g5).recycled, 1, '挂牌回收后同样打封顶标记');

    // 4.3 到顶但没有买入订单（后台指派）：不自动打款，转待处理
    const g6 = await createGoods({ name: '无订单到顶样品', price: 1100, base: 1000, cap: 1100 });
    db.prepare('UPDATE goods SET member_id = ?, goods_status = 10 WHERE goods_id = ?').run(holder, g6);
    const beforeG6 = balance(holder);
    sc = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(sc.data.no_order >= 1, '缺少买入订单 → 记为待处理', JSON.stringify(sc.data));
    const rec6 = recycleOf(g6);
    eq(rec6?.status, 20, '无订单商品落待处理');
    ok(/缺少.*买入订单/.test(rec6?.remark || ''), '备注写明原因', rec6?.remark);
    eq(balance(holder), beforeG6, '待处理不打款');
    const settle6 = await api('/admin/api/recycle/settle', { method: 'POST', token: at, body: { recycle_id: rec6.recycle_id } });
    ok(settle6.code === 1, '人工核对后可手动结算', settle6.msg);
    eq(balance(holder) - beforeG6, 1100, '手动结算按参考价 1100 接盘');

    // ================= 5. 台账接口 =================
    section('[5] 台账列表与汇总');
    const list = await api('/admin/api/recycle/list?limit=50', { token: at });
    ok(list.code === 1 && (list.data?.data || []).length >= 3, '列表返回回收单', `${list.data?.total} 条`);
    const first = (list.data?.data || [])[0] || {};
    ok(!!first._member, '列表带持有人昵称', first._member);
    const sum = await api('/admin/api/recycle/summary', { token: at });
    ok(sum.code === 1 && sum.data.today_count >= 2, '汇总返回今日已结算数与金额', JSON.stringify(sum.data));

    section('[6] 数据一致性');
    ok(db.prepare("SELECT COUNT(*) c FROM goods_recycle WHERE status = 10 AND settle_time = ''").get().c === 0, '已结算记录都有结算时间');
    ok(db.prepare('SELECT COUNT(*) c FROM member WHERE amount < 0').get().c === 0, '没有会员负余额');
    const dup = db.prepare('SELECT goods_id, member_id, COUNT(*) c FROM goods_recycle GROUP BY goods_id, member_id HAVING c > 1').all();
    eq(dup.length, 0, '同一商品同一持有人只有一条回收单');
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
