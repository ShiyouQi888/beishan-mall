/**
 * 「转拍上架费前置到下单时收取」验收。
 *
 * 背景：上架费原来要等会员点「转拍上架」时再从他余额里扣。
 * 问题是那时货已经在他手上、钱也付过了 —— 余额不够就转不了拍，货卡死，
 * 运营只能手工调账。而且会员在抢购那一刻看不到这笔费用。
 *
 * 现在的口径：
 *   - 下单时，应付 = 货款 + 抢单服务费 + 转拍上架费（按本单总额 × 上架费率预估）
 *   - 支付时一次扣清，H5 下单页三个金额都要显示
 *   - 转拍时不再二次扣款，报价里 net_income 也不再减一次（否则利润被算低）
 *   - 迁移前的老订单（listing_fee = 0）仍按老办法在转拍时扣，行为不变
 *
 * 覆盖：
 *   1. 下单返回的三个金额字段都能对上：total_price / service_charge / listing_fee
 *   2. 支付后余额 = 初始 − （货款 + 服务费 + 上架费）
 *   3. 报价带 listing_fee_prepaid = 1，且净收益不减上架费
 *   4. 转拍不重复扣款，余额与支付后一致；订单上保留预付金额
 *   5. 老订单（listing_fee 手工清 0）报价 prepaid = 0，转拍时才扣
 *
 * 独立库（listing-fee-prepaid.db / 3469），跑完销毁。
 * 用法: node scripts/probe/listing-fee-prepaid.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3469;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'listing-fee-prepaid.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const eq = (a, b, name) => ok(Math.abs(Number(a) - Number(b)) < 0.005, name, `期望 ${b}，实际 ${a}`);

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
  {
    const { db } = await import('../../server/src/db.js');
    db.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();
  }

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

  const { db, get, all } = await import('../../server/src/db.js');
  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

  try {
    // 场次改成全天开放（种子里的上午场 08:00-12:00 多半已经过了）
    const dow = new Date(`${todayStr()}T00:00:00Z`).getUTCDay();
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, open_days = ?, is_open = 10, transposition_hours = 0 WHERE specialarea_id = 1')
      .run(String(dow === 0 ? 7 : dow));
    // 费率写死，不依赖种子默认值：服务费 2% / 涨价 3% / 上架费 2.8%
    const setCfg = (k, v) => {
      const row = get('SELECT `value` FROM setting_config WHERE `key` = ?', k);
      if (row) db.prepare('UPDATE setting_config SET `value` = ? WHERE `key` = ?').run(String(v), k);
      else db.prepare('INSERT INTO setting_config (`key`, `value`) VALUES (?,?)').run(k, String(v));
    };
    setCfg('service_charge', 2);
    setCfg('price_increase_rate', 3);
    setCfg('listing_fee_rate', 2.8);

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const reg = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13960000001', password: 'lfp123456', code: 'boss01', nickName: '上架费买家' },
    });
    const mid = Number(reg.data?.member_id) || get('SELECT member_id FROM member WHERE mobile = ?', '13960000001')?.member_id;
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '验收充值' },
    });
    const lg = await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13960000001', password: 'lfp123456' } });
    const tk = lg.data?.token;
    ok(!!tk, '买家登录');
    const bal = () => Number(get('SELECT amount FROM member WHERE member_id = ?', mid).amount);

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = async (name) => {
      const c = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: 1000, stock_num: 1, goods_status: 10, goods_sort: 1 },
      });
      const id = Number(c.data?.id);
      await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [id] } });
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(id);
      return id;
    };

    // ---------- 1. 下单：三个金额一次算清 ----------
    section('[1] 下单时就要把上架费算进来（1000 货：服务费 20 + 上架费 28）');
    const g1 = await mkGoods('前置上架费样品');
    const o1 = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: g1, num: 1, pay_type: 1 } });
    eq(o1.data?.total_price, 1000, '货款 1000');
    eq(o1.data?.service_charge, 20, '抢单服务费 20（2%）');
    eq(o1.data?.listing_fee, 28, '转拍上架费 28（2.8%）');
    ok(o1.data?.listing_fee > 0, '下单返回里带上架费（H5 才能前置展示）');

    // ---------- 2. 支付：一次扣清 ----------
    section('[2] 支付时一次扣清 1048');
    const pay1 = await api('/api/order/toPay', { method: 'POST', token: tk, body: { order_id: o1.data.order_id, pay_type: 1 } });
    ok(pay1.code === 1, '支付成功', pay1.msg);
    eq(bal(), 5000 - 1048, '余额 = 5000 −（1000 + 20 + 28）');

    const flow = all('SELECT * FROM finance_energy WHERE member_id = ? ORDER BY energy_id DESC LIMIT 1', mid)[0];
    eq(Math.abs(Number(flow.face_value)), 1048, '流水金额 = 实付 1048');
    ok(String(flow.remarks).includes('上架费'), '流水备注写明含上架费（财务可追溯）', flow.remarks);

    // ---------- 3. 报价：成本必须含预付的上架费 ----------
    section('[3] 报价：实际成本含预付上架费，不再重复减');
    const q1 = await api(`/api/order/getConsignmentQuote?order_id=${o1.data.order_id}`, { token: tk });
    eq(q1.data?.listing_fee, 28, '报价仍展示这一手的应缴上架费 28（口径透明）');
    eq(q1.data?.listing_fee_prepaid, 1, '标记为「下单时已付」');
    eq(q1.data?.prev_cost, 1048, '实际成本 1048 = 1000 + 20 + 28（含预付上架费）');
    // 1030 − 1048 − 0 = −18：涨价 3% 盖不住 2% + 2.8% 的费用
    eq(q1.data?.net_income, -18, '净收益 −18 = 1030 − 1048（上架费只算一次）');

    // 我的店铺必须跟报价一个口径，否则会员在店铺里看到「赚」，转拍后却「亏」
    const shop = await api('/api/member/myShop', { token: tk });
    const item = (shop.data?.list || []).find((x) => Number(x.goods_id) === g1);
    eq(item?.my_cost, 1048, '店铺：实际成本 1048');
    eq(item?.listing_fee, 28, '店铺：上架费（已付）28');
    ok(item?.listing_fee_due === undefined, '店铺：不再暴露「待扣上架费」字段（转拍不收费）');
    eq(item?.est_net, q1.data?.net_income, '店铺预估 = 转拍报价（同一口径）');

    // ---------- 4. 转拍：不再二次扣款 ----------
    section('[4] 转拍不重复扣款');
    const before = bal();
    const cs = await api('/api/order/consignment', { method: 'POST', token: tk, body: { order_id: o1.data.order_id } });
    ok(cs.code === 1, '转拍成功', cs.msg);
    eq(bal(), before, '余额不变（上架费下单时已付）');
    const ord1 = get('SELECT * FROM orders WHERE order_id = ?', o1.data.order_id);
    eq(ord1.consignment_status, 10, '订单标记已挂牌');
    eq(ord1.listing_fee, 28, '订单上保留预付金额 28（供统计，不被本轮报价覆盖）');
    const feeFlows = all("SELECT * FROM finance_energy WHERE member_id = ? AND type_name = '转拍上架费'", mid);
    eq(feeFlows.length, 0, '没有「转拍上架费」扣款流水（避免重复入账）');

    // ---------- 5. 历史订单：费率变了也不追缴 ----------
    // 这是用户报的真实问题：一笔下单时 listing_fee = 0 的老订单，
    // 运营后来把上架费调成 2.8%，会员点转拍却被要求补缴 60 元，
    // 余额不够就报「余额不足以支付上架费」—— 货卡死在手上。
    section('[5] 历史订单（listing_fee = 0）：费率改了也不追缴、不卡死');
    const g2 = await mkGoods('老订单样品');
    const o2 = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: g2, num: 1, pay_type: 1 } });
    await api('/api/order/toPay', { method: 'POST', token: tk, body: { order_id: o2.data.order_id, pay_type: 1 } });
    // 模拟历史数据：下单时没收过这笔钱（当时费率是 0，或代码还没上线）
    db.prepare('UPDATE orders SET listing_fee = 0 WHERE order_id = ?').run(o2.data.order_id);
    const q2 = await api(`/api/order/getConsignmentQuote?order_id=${o2.data.order_id}`, { token: tk });
    eq(q2.data?.listing_fee_prepaid, 0, '历史订单标记为未付过');
    eq(q2.data?.listing_fee, 0, '报价里不虚构一笔上架费（按订单实收 0）');
    eq(q2.data?.prev_cost, 1020, '历史订单实际成本 1020（没付过上架费）');
    eq(q2.data?.net_income, 10, '净收益 10 = 1030 − 1020（不再按新费率扣 28）');
    // 把余额清到 0，复现用户截图那一刻：只要还会扣款就必然报「余额不足」
    db.prepare('UPDATE member SET amount = 0 WHERE member_id = ?').run(mid);
    const cs2 = await api('/api/order/consignment', { method: 'POST', token: tk, body: { order_id: o2.data.order_id } });
    ok(cs2.code === 1, '余额为 0 也能转拍（不再报「余额不足以支付上架费」）', cs2.msg);
    eq(bal(), 0, '余额没被扣（转拍不再收费）');
    const oldFlow = all("SELECT * FROM finance_energy WHERE member_id = ? AND type_name = '转拍上架费'", mid);
    eq(oldFlow.length, 0, '没有产生「转拍上架费」流水');
    const ord2 = get('SELECT * FROM orders WHERE order_id = ?', o2.data.order_id);
    eq(ord2.listing_fee, 0, '订单上的 listing_fee 不被覆盖（财务统计不会虚增收入）');
    eq(ord2.consignment_status, 10, '订单已标记挂牌');
  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
  }

  console.log('\n' + '─'.repeat(52));
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass} 项断言`);
}

main().catch((e) => {
  console.error('探针异常：', e.message);
  process.exit(1);
});
