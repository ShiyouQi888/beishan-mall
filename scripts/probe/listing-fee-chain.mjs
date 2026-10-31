/**
 * 转拍上架费「全链路」验收：后台设置 → 下单 → 支付 → 各端展示 → 导出 → 转拍 → 结算 → 财务。
 *
 * 用的是用户截图里的参数：商品 2000 元、上架费 2%、服务费 0%。
 * 期望：下单就带出 40 元上架费，实付 2040；转拍不再扣；财务按 40 计收入。
 *
 * 覆盖：
 *   1. 后台设置落库，前台 getTradeConfig 立即返回新费率（没有缓存）
 *   2. 下单返回三笔金额；支付按 2040 扣款，流水备注写清构成
 *   3. 三处展示接口都带 listing_fee：H5 订单列表 / H5 订单详情 / 后台订单详情
 *   4. 订单导出表头与数值（上架费列、实付金额列）
 *   5. 转拍不再扣款，订单 listing_fee 不被覆盖
 *   6. 下一手按新价成交，两份上架费都进财务口径
 *   7. 到顶回收：实际成本含上架费
 *
 * 独立库（listing-fee-chain.db / 3471），跑完销毁。
 * 用法: node scripts/probe/listing-fee-chain.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3471;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'listing-fee-chain.db';
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
    const dow = new Date(`${todayStr()}T00:00:00Z`).getUTCDay();
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, open_days = ?, is_open = 10, transposition_hours = 0 WHERE specialarea_id = 1')
      .run(String(dow === 0 ? 7 : dow));

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    // ---------- 1. 后台设置 → 前台配置 ----------
    section('[1] 后台设 2%，前台配置应立刻可见（不能有缓存）');
    const save = await api('/admin/api/setting/save', {
      method: 'POST', token: at,
      body: { group: 'trade', values: { listing_fee_rate: '2', service_charge: '0' } },
    });
    ok(save.code === 1, '保存交易设置', save.msg);
    eq(get("SELECT `value` FROM setting_config WHERE `key` = 'listing_fee_rate'").value, 2, '库里已是 2%');
    const tc = await api('/api/index/getTradeConfig');
    eq(tc.data?.listing_fee_rate, 2, '前台拿到的费率是 2%');
    eq(tc.data?.service_charge, 0, '抢单服务费 0%');

    // ---------- 2. 下单与支付 ----------
    section('[2] 2000 元的货：下单带 40 元上架费，支付实扣 2040');
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const cg = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_name: '链路验收鸡蛋 2000', category_id: catId, goods_min_price: 2000, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const gid = Number(cg.data?.id);
    await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid] } });
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);

    const mkMember = async (phone) => {
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'chain123456', code: 'boss01', nickName: `链路${phone.slice(-2)}` },
      });
      const mid = Number(reg.data?.member_id) || get('SELECT member_id FROM member WHERE mobile = ?', phone)?.member_id;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '验收充值' },
      });
      const lg = await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'chain123456' } });
      return { mid: Number(mid), token: lg.data?.token };
    };
    const A = await mkMember('13970000001');
    const B = await mkMember('13970000002');
    ok(A.token && B.token, '两个买家可登录');
    const bal = (mid) => Number(get('SELECT amount FROM member WHERE member_id = ?', mid).amount);

    const o1 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: gid, num: 1, pay_type: 1 } });
    eq(o1.data?.total_price, 2000, '商品金额 2000');
    eq(o1.data?.service_charge, 0, '服务费 0（截图里的设置）');
    eq(o1.data?.listing_fee, 40, '转拍上架费 40（2000 × 2%）');
    const pay1 = await api('/api/order/toPay', { method: 'POST', token: A.token, body: { order_id: o1.data.order_id, pay_type: 1 } });
    ok(pay1.code === 1, '支付成功', pay1.msg);
    eq(bal(A.mid), 5000 - 2040, '余额扣 2040（2000 + 0 + 40）');
    const flow = all('SELECT * FROM finance_energy WHERE member_id = ? ORDER BY energy_id DESC LIMIT 1', A.mid)[0];
    eq(Math.abs(Number(flow.face_value)), 2040, '流水金额 2040');
    ok(/上架费 40\.00/.test(String(flow.remarks)), '流水备注写明上架费 40.00', flow.remarks);

    // ---------- 3. 三处展示接口 ----------
    section('[3] 三个页面拿到的数据都要带上架费');
    const h5List = await api('/api/order/getOrder', { token: A.token });
    const row1 = (h5List.data?.list || h5List.data?.data || []).find((x) => Number(x.order_id) === o1.data.order_id);
    eq(row1?.listing_fee, 40, 'H5 订单列表：listing_fee = 40（卡片「实付」行数据源）');
    const h5Detail = await api(`/api/order/getOrder?order_id=${o1.data.order_id}`, { token: A.token });
    const d1 = (h5Detail.data?.list || h5Detail.data?.data || [])[0];
    eq(d1?.listing_fee, 40, 'H5 订单详情：listing_fee = 40');
    const adminDetail = await api(`/admin/api/orders/detail?id=${o1.data.order_id}`, { token: at });
    eq(adminDetail.data?.listing_fee, 40, '后台订单详情：listing_fee = 40');
    eq(adminDetail.data?.service_charge, 0, '后台订单详情：service_charge = 0');

    // ---------- 4. 导出 ----------
    section('[4] 订单导出：表头与数值');
    const res = await fetch(`${BASE}/admin/api/orders/export`, { headers: { token: at } });
    const csv = await res.text();
    const lines = csv.replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    const header = lines[0];
    ok(header.includes('转拍上架费'), '表头含「转拍上架费」', header);
    ok(header.includes('实付金额'), '表头含「实付金额」');
    const cols = header.split(',');
    const idxFee = cols.indexOf('转拍上架费');
    const idxPay = cols.indexOf('实付金额');
    const myLine = lines.find((l) => l.includes(o1.data.order_no));
    ok(!!myLine, '导出文件里有这笔单');
    if (myLine) {
      const cells = myLine.split(',');
      eq(cells[idxFee], 40, '导出：上架费列 40.00');
      eq(cells[idxPay], 2040, '导出：实付金额列 2040.00');
    }

    // ---------- 5. 转拍不扣钱 ----------
    section('[5] 转拍：一分钱都不再扣');
    const balBefore = bal(A.mid);
    const q = await api(`/api/order/getConsignmentQuote?order_id=${o1.data.order_id}`, { token: A.token });
    eq(q.data?.listing_fee, 40, '报价带出已付的 40 元');
    eq(q.data?.listing_fee_prepaid, 1, '标记「下单时已付」');
    eq(q.data?.prev_cost, 2040, '实际成本 2040（含服务费与上架费）');
    const cs = await api('/api/order/consignment', { method: 'POST', token: A.token, body: { order_id: o1.data.order_id } });
    ok(cs.code === 1, '转拍成功', cs.msg);
    eq(bal(A.mid), balBefore, '余额不变');
    eq(get('SELECT listing_fee FROM orders WHERE order_id = ?', o1.data.order_id).listing_fee, 40, '订单 listing_fee 保持 40（不被覆盖）');
    eq(get('SELECT goods_min_price FROM goods WHERE goods_id = ?', gid).goods_min_price, 2060, '下一轮标价 2060（+3%）');

    // ---------- 6. 下一手成交 ----------
    section('[6] 下一手成交：两份上架费都进财务口径');
    // 转拍会把货排到「下一场」，那个场次的时段此刻未必开放。
    // 本用例只验金额链路，这里把场次时段全放开 + 清掉落场日期，模拟「到了那一天、那一场正在开抢」。
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, is_open = 10').run();
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);
    const o2 = await api('/api/order/toAddOrder', { method: 'POST', token: B.token, body: { goods_id: gid, num: 1, pay_type: 1 } });
    if (!o2.data?.total_price) console.log('    第二手下单返回：', JSON.stringify(o2));
    eq(o2.data?.total_price, 2060, '第二手标价 2060');
    eq(o2.data?.listing_fee, 41.2, '第二手自己那笔上架费 41.2');
    await api('/api/order/toPay', { method: 'POST', token: B.token, body: { order_id: o2.data.order_id, pay_type: 1 } });
    eq(bal(A.mid), 5000 - 2040 + 2060, 'A 收回 2060 全额');
    eq(bal(A.mid) - 5000, 20, 'A 净赚 20（2060 − 2040）');
    const ov = await api('/admin/api/finance/overview', { token: at });
    ok(Number(ov.data?.total?.listing_fee) >= 81.2 - 0.005, '财务累计上架费 ≥ 81.2（40 + 41.2）', String(ov.data?.total?.listing_fee));

    // ---------- 7. 到顶回收的成本口径 ----------
    section('[7] 到顶回收：实际成本要含上架费');
    db.prepare('UPDATE goods SET price_cap = ? WHERE goods_id = ?').run(2100, gid);
    const scan = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scan.code === 1, '回收扫描可执行', scan.msg);
    const rec = get('SELECT * FROM goods_recycle WHERE goods_id = ? ORDER BY recycle_id DESC LIMIT 1', gid);
    ok(!!rec, '产生回收记录');
    if (rec) {
      // B 实付 2060 + 41.2 = 2101.2；按当前标价 2060 接盘
      eq(rec.buy_cost, 2101.2, '实际成本 2101.2 = 货款 2060 + 上架费 41.2');
      eq(rec.profit, -41.2, '持有人收益 −41.2（涨价 60 但自付 41.2 费用 + 30 服务费）');
    }
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
