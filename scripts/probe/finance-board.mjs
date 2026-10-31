// 财务大盘核对：跑真实订单链，逐项验证 /admin/api/finance/overview 的每个数字
// 口径：抢单服务费 2% / 上架费 0（A 段）→ 1%（B 段） / 转拍涨价 3% / 直推奖 0.5% / 起始价 10000
// 独立库（finance.db / 3403），不碰演示库
// 用法: node scripts/probe/finance-board.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3403;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'finance.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };
// 本进程也要切到独立库，否则 import db.js 时会连到默认的演示库，读到的是另一份数据
process.env.MALL_DB = DB;

const m2 = (n) => Number(Number(n).toFixed(2));
const yuan = (n) => `¥${m2(n).toFixed(2)}`;

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
function eqMoney(actual, expect, name) {
  const a = m2(actual);
  const e = m2(expect);
  ok(Math.abs(a - e) < 0.005, name, `期望 ${yuan(e)}，实际 ${yuan(a)}，差 ${m2(a - e)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const BASE_PRICE = 10000;
const SERVICE_RATE = 2;
const INCREASE_RATE = 3;
const DRIVE_RATE = 0.5;
const ROUNDS = 3;

async function main() {
  console.log('[setup] 初始化独立核对库…');
  await run('node', ['src/seed.js']);
  const { db, now } = await import('../../server/src/db.js');
  db.exec("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7'");

  // 系统默认只开线下转账；本用例要走余额支付，测试库显式把余额支付打开
  {
    try {
      const { db: __payDb } = await import('../../server/src/db.js');
      __payDb.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();
    } catch {}
  }
  const srv = spawn('node', ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
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
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-800));

  const api = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res.json();
  };
  const adminAt = async (path, opts = {}) => {
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    return res.json();
  };

  try {
    section('[0] 后台登录与口径配置');
    const at = (await adminAt('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录成功');

    const saveCfg = (values) => adminAt('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values } });
    const s0 = await saveCfg({
      service_charge: String(SERVICE_RATE),
      listing_fee_rate: '0',
      withdraw_fee: '0',
      price_increase_rate: String(INCREASE_RATE),
      drive_award_rate: String(DRIVE_RATE),
    });
    ok(s0.code === 1, '写入本轮口径', s0.msg);

    // 基线：seed 自带演示订单与佣金，所有断言都按「增量」核对，避免被历史数据带偏
    const ov0 = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(!!ov0, '基线数据可读');
    const base = {
      orders: ov0.today.orders,
      gmv: ov0.today.gmv,
      svc: ov0.today.service_fee,
      listing: ov0.today.listing_fee,
      income: ov0.today.income,
      award: ov0.today.drive_award,
      net: ov0.today.net,
      totalNet: ov0.total.net,
      totalListing: ov0.total.listing_fee,
      commission: ov0.liability.commission,
    };
    console.log(`    基线（演示数据）：今日 ${base.orders} 单 / 成交 ${yuan(base.gmv)} / 服务费 ${yuan(base.svc)} / 佣金 ${yuan(base.commission)}`);

    // 未登录必须拒绝
    const noAuth = await fetch(`${BASE}/admin/api/finance/overview`).then((r) => r.json());
    ok(noAuth.code !== 1, '未登录访问财务大盘被拒绝', JSON.stringify(noAuth).slice(0, 80));

    section('[1] 建 10000 元商品 + 3 位邀请注册买家');
    const holder = db.prepare("SELECT member_id, invitation_code FROM member WHERE mobile='13800000001'").get();
    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    const areaId = db.prepare('SELECT specialarea_id FROM specialarea LIMIT 1').get().specialarea_id;
    const cg = await adminAt('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: {
        goods_name: '财务核对标品 10000', goods_no: 'FIN-10000',
        category_id: catId, specialarea_id: areaId, member_id: holder.member_id,
        goods_min_price: BASE_PRICE, line_price: Math.round(BASE_PRICE * 1.4),
        stock_num: 1, goods_status: 10, sales_actual: 0, goods_sort: 1,
      },
    });
    ok(cg.code === 1 && cg.data?.id, '创建商品', cg.msg);
    const gid = cg.data.id;
    // 商品与场次改为关联表驱动：建完商品再单独关联，goods.specialarea_id 不再参与判断
    await adminAt('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: areaId, goods_ids: [gid] },
    });

    const buyers = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const phone = `1392000000${i + 1}`;
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST',
        body: { phone, password: '123456', code: holder.invitation_code, nickName: `财务第${i + 1}手` },
      });
      ok(reg.code === 1 && !!reg.data?.token, `注册第 ${i + 1} 手`, reg.msg);
      await adminAt('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: reg.data.member_id, field: 'amount', value: 200000, remark: '核对充值' },
      });
      buyers.push({ token: reg.data.token, mid: reg.data.member_id });
    }

    // 期望链
    const chain = [];
    let price = m2(BASE_PRICE);
    for (let r = 1; r <= ROUNDS; r += 1) {
      const fee = m2((price * SERVICE_RATE) / 100);
      const award = m2((price * DRIVE_RATE) / 100);
      chain.push({ r, price, fee, award });
      price = m2(price * (1 + INCREASE_RATE / 100));
    }

    section('[2] 走 3 轮「抢单 → 支付 → 转拍」（上架费 0）');
    let lastOrderId = null;
    for (let r = 1; r <= ROUNDS; r += 1) {
      const e = chain[r - 1];
      const b = buyers[r - 1];
      const od = await api('/api/order/toAddOrder', { method: 'POST', token: b.token, body: { goods_id: gid, num: 1, pay_type: 1 } });
      ok(od.code === 1, `第${r}轮 下单，标价 ${yuan(e.price)}`, od.msg);
      if (od.code !== 1) throw new Error('下单失败，终止');
      lastOrderId = od.data.order_id;
      eqMoney(od.data.total_price, e.price, `第${r}轮 订单标价`);
      eqMoney(od.data.service_charge, e.fee, `第${r}轮 服务费 ${yuan(e.fee)}`);

      const pay = await api('/api/order/toPay', { method: 'POST', token: b.token, body: { order_id: lastOrderId, pay_type: 1 } });
      ok(pay.code === 1, `第${r}轮 支付成功`, pay.msg);

      if (r < ROUNDS) {
        const cs = await api('/api/order/consignment', { method: 'POST', token: b.token, body: { order_id: lastOrderId } });
        ok(cs.code === 1, `第${r}轮 转拍成功`, cs.msg);
      }
    }

    section('[3] A 段财务大盘核对（上架费 0，仅服务费）');
    const expectSvc = m2(chain.reduce((s, e) => s + e.fee, 0));
    const expectGmv = m2(chain.reduce((s, e) => s + e.price, 0));
    const expectAward = m2(chain.reduce((s, e) => s + e.award, 0));
    const expectNet = m2(expectSvc - expectAward);
    console.log(`    标价：${chain.map((e) => yuan(e.price)).join(' + ')} = ${yuan(expectGmv)}`);
    console.log(`    服务费：${chain.map((e) => yuan(e.fee)).join(' + ')} = ${yuan(expectSvc)}`);
    console.log(`    直推奖：${chain.map((e) => yuan(e.award)).join(' + ')} = ${yuan(expectAward)}`);

    const ovA = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(!!ovA, '接口返回数据');
    eqMoney(ovA.today.orders - base.orders, ROUNDS, `今日订单增量 = ${ROUNDS}`);
    eqMoney(ovA.today.gmv - base.gmv, expectGmv, '今日成交额增量');
    eqMoney(ovA.today.service_fee - base.svc, expectSvc, '今日抢单服务费增量');
    eqMoney(ovA.today.listing_fee - base.listing, 0, '今日上架费增量 = 0');
    eqMoney(ovA.today.income - base.income, expectSvc, '今日经营收入增量 = 服务费');
    eqMoney(ovA.today.drive_award - base.award, expectAward, '今日直推奖增量');
    eqMoney(ovA.today.net - base.net, expectNet, '今日经营净利增量 = 收入 − 支出');
    eqMoney(ovA.total.net - base.totalNet, expectNet, '累计经营净利增量 = 今日增量（单日数据）');
    eqMoney(ovA.total.recycle_cost, 0, '累计平台回收支出 = 0（全程未回收）');
    eqMoney(ovA.total.cash_net, m2(ovA.total.net), '现金净流 = 净利 − 回收 = 净利');

    ok(ovA.rate.service_charge === SERVICE_RATE, `费率回显：抢单服务费 ${SERVICE_RATE}%`);
    ok(ovA.rate.drive_award === DRIVE_RATE, `费率回显：直推奖 ${DRIVE_RATE}%`);
    eqMoney(ovA.rate.per_order, m2(SERVICE_RATE - DRIVE_RATE), '单均毛利 = 2% − 0.5% = 1.5%');

    eqMoney(ovA.liability.commission - base.commission, expectAward, '会员负债中的佣金增量 = 本轮全部直推奖');
    const dbBalance = m2(db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v);
    eqMoney(ovA.liability.balance, dbBalance, '会员负债中的余额 = member.amount 合计');
    eqMoney(ovA.liability.total, m2(dbBalance + ovA.liability.commission), '会员负债合计 = 余额 + 佣金');

    section('[4] B 段：打开 1% 上架费，再转拍一单，验证收入结构第二项');
    await saveCfg({ listing_fee_rate: '1' });
    const lastBuyer = buyers[ROUNDS - 1];
    const q = (await api(`/api/order/getConsignmentQuote?order_id=${lastOrderId}`, { token: lastBuyer.token })).data;
    const expectListing = m2((chain[ROUNDS - 1].price * 1) / 100);
    eqMoney(q.listing_fee, expectListing, `报价上架费 = ${yuan(chain[ROUNDS - 1].price)} × 1%`);
    const cs2 = await api('/api/order/consignment', { method: 'POST', token: lastBuyer.token, body: { order_id: lastOrderId } });
    ok(cs2.code === 1, '第 3 轮持有人转拍（带 1% 上架费）', cs2.msg);

    const ovB = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    eqMoney(ovB.today.listing_fee - base.listing, expectListing, '今日上架费增量已计入');
    eqMoney(ovB.today.service_fee - base.svc, expectSvc, '上架费不影响服务费口径');
    eqMoney(ovB.today.income - base.income, m2(expectSvc + expectListing), '经营收入 = 服务费 + 上架费');
    eqMoney(ovB.today.net - base.net, m2(expectSvc + expectListing - expectAward), '净利随收入同步增加');
    const dbListing = m2(db.prepare('SELECT IFNULL(SUM(listing_fee),0) v FROM orders').get().v);
    eqMoney(ovB.total.listing_fee - base.totalListing, expectListing, '累计上架费增量 = 本单上架费');
    ok(dbListing >= expectListing, '库中上架费合计已落库', `库中 ${yuan(dbListing)}`);
    section('[5] 趋势数据一致性');
    ok(Array.isArray(ovB.trend_daily) && ovB.trend_daily.length === 30, '日趋势返回 30 天');
    // 本地日期（toISOString 是 UTC，东八区 0-8 点会差一天）
    const todayStr = (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();
    ok(ovB.trend_daily[29].date === todayStr, '日趋势最后一天 = 今天', ovB.trend_daily[29].date);
    ok(ovB.trend_daily.every((x, i) => i === 0 || x.date > ovB.trend_daily[i - 1].date), '日趋势按日期升序');
    eqMoney(ovB.trend_daily[29].net, ovB.today.net, '日趋势今天净利 = 今日净利卡片');
    eqMoney(ovB.trend_daily.reduce((s, x) => s + Number(x.net), 0), ovB.total.net, '日趋势净利求和 = 累计净利');
    eqMoney(ovB.trend_daily.reduce((s, x) => s + Number(x.service_fee), 0), ovB.total.service_fee, '日趋势服务费求和 = 累计服务费');
    ok(ovB.trend_daily.every((x) => Math.abs(m2(x.income - x.drive_award - x.net)) < 0.005), '每天：收入 − 支出 = 净利');

    ok(Array.isArray(ovB.trend_monthly) && ovB.trend_monthly.length === 6, '月趋势返回 6 个月');
    const curYm = todayStr.slice(0, 7);
    const curMonth = ovB.trend_monthly[5];
    ok(curMonth.month === curYm, '月趋势最后一月 = 本月', curMonth.month);
    eqMoney(curMonth.net, ovB.month.net, '本月净利 = 月趋势本月行');
    ok(ovB.trend_monthly.every((x) => Math.abs(m2(x.income - x.drive_award - x.net)) < 0.005), '每月：收入 − 支出 = 净利');

    section('[6] 风险引擎');
    const hasHigh = (arr) => arr.some((x) => x.level === 'high');
    ok(!hasHigh(ovB.risks), '正常费率下无高风险项');
    ok(Array.isArray(ovB.risks) && ovB.risks.length > 0, '风险列表非空');
    ok(ovB.risks.every((x) => ['high', 'warn', 'info', 'ok'].includes(x.level)), '风险等级取值合法');
    ok(ovB.risks.every((x) => !!x.title && !!x.detail), '每条风险都有标题与说明');
    console.log('    当前风险项：' + ovB.risks.map((x) => `[${x.level}] ${x.title}`).join(' | '));

    // 把直推奖拉到服务费之上 → 单均毛利为负 → 必须报高风险
    await saveCfg({ drive_award_rate: '3' });
    const ovC = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    eqMoney(ovC.rate.per_order, -1, '单均毛利 = 2% − 3% = −1%');
    ok(hasHigh(ovC.risks), '单均毛利为负时报高风险');
    ok(ovC.risks.some((x) => x.title.includes('单均毛利')), '高风险标题点名单均毛利');

    // 会员余额调负 → 账务异常风险
    await saveCfg({ drive_award_rate: String(DRIVE_RATE) });
    db.prepare('UPDATE member SET amount = -1 WHERE member_id = ?').run(buyers[0].mid);
    const ovD = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(hasHigh(ovD.risks), '存在负余额会员时报高风险');
    ok(ovD.risks.some((x) => x.title.includes('余额为负')), '高风险标题点名余额为负');
    db.prepare('UPDATE member SET amount = 0 WHERE member_id = ?').run(buyers[0].mid);

    section('[6b] 风险引擎：分销成本率与回收流动性');
    // 造一笔超过收入 60% 的佣金支出 → 必须报「分销成本占收入」
    const insEnergy = db.prepare(
      'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
    );
    insEnergy.run(buyers[0].mid, m2(ovD.total.income * 2), 1, '直推奖', 'PROBE_TMP', now());
    const ovF = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(ovF.risks.some((x) => x.title.includes('分销成本占收入')), '佣金超过收入 60% 时报分销成本风险');
    ok(m2(ovF.total.drive_award) > m2(ovF.total.income), '支出已超过收入');
    ok(ovF.risks.some((x) => x.level === 'high' && x.title.includes('累计经营净利为负')), '净利转负时报高风险');

    // 造一笔占成交额 30% 的平台回收 → 必须报「平台回收占成交额」，且现金净流转负
    insEnergy.run(buyers[1].mid, m2(ovD.total.gmv * 0.3), 2, '平台回收', 'PROBE_TMP', now());
    const ovG = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(ovG.risks.some((x) => x.title.includes('平台回收占成交额')), '回收占比超 20% 时报流动性风险');
    ok(m2(ovG.total.cash_net) < 0, '回收支出拉低现金净流为负');
    ok(ovG.risks.some((x) => x.title.includes('现金净流为负')), '现金净流为负时报风险');
    console.log('    构造后的风险项：' + ovG.risks.map((x) => `[${x.level}] ${x.title}`).join(' | '));

    // 清理探针构造的流水
    db.prepare("DELETE FROM finance_energy WHERE remarks = 'PROBE_TMP'").run();
    section('[7] 空数据兜底');    const ovE = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(ovE.trend_daily.every((x) => typeof x.net === 'number' && !Number.isNaN(x.net)), '日趋势无 NaN');
    ok(ovE.trend_monthly.every((x) => typeof x.net === 'number' && !Number.isNaN(x.net)), '月趋势无 NaN');
    ok(Object.values(ovE.today).every((v) => typeof v === 'number' && !Number.isNaN(v)), '今日各项均为有效数字');

    // 提现模块整体下线：大盘里不该再出现任何提现指标
    section('[8] 提现指标已下线');
    const ovW = (await adminAt('/admin/api/finance/overview', { token: at })).data;
    ok(!('pending_withdraw' in (ovW.liability || {})), '负债里没有 pending_withdraw');
    ok(!('paid_withdraw' in (ovW.liability || {})), '负债里没有 paid_withdraw');
    ok(!('withdraw_paid' in (ovW.total || {})), '累计统计里没有 withdraw_paid');
    ok(!JSON.stringify(ovW.risks || []).includes('提现'), '风险提示里没有提现');
    ok(!/withdraw/i.test(JSON.stringify(ovW)), '整份数据不含 withdraw 字段');

    console.log(`\n${'─'.repeat(56)}`);
    if (fails.length) {
      console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
      for (const f of fails) console.log(`   · ${f}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ 全部通过：${pass} 项断言`);
    }
  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
    try { if (process.env.KEEP_DB !== '1') { for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) if (existsSync(f)) unlinkSync(f); } } catch {}
    process.exit(process.exitCode || 0);
  }
}

main().catch((e) => {
  console.error('\n[错误]', e.message);
  process.exit(1);
});
