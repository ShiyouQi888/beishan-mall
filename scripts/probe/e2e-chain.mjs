// 联调联试：邀请注册 → 登录 → 抢单 → 支付 → 转拍 → 下一轮，跑 5 轮并逐项核对金额
// 口径：抢单服务费 2% / 上架费 0 / 提现费 0 / 转拍上涨 3% / 商品起始价 10000
// 独立库（chain.db / 3402），不碰演示库
// 用法: node scripts/probe/e2e-chain.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3402;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'chain.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };

// 本轮联调口径
const CFD = {
  basePrice: 10000,
  serviceRate: 2,      // 抢单服务费 %
  listingRate: 0,      // 上架费 %
  withdrawFee: 0,      // 提现手续费 %
  increaseRate: 3,     // 转拍涨价 %
  rounds: 5,
};

/** 与后端一致的金额取整（两位小数） */
const m2 = (n) => Number(Number(n).toFixed(2));
const yuan = (n) => `¥${m2(n).toFixed(2)}`;

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
/** 精确到分的相等断言 */
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

async function main() {
  console.log('[setup] 初始化独立联调库…');
  await run('node', ['src/seed.js']);
  const { db } = await import('../../server/src/db.js');
  // 场次全天开放、放开限购，避免时间窗干扰
  db.exec("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, open_days = '1,2,3,4,5,6,7'");

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
  const detail = async (t) => (await api('/api/member/getMemberDetails', { token: t })).data;
  const balance = async (t) => Number((await detail(t)).amount);

  try {
    // ================= 1. 后台配置费率 =================
    section('[1] 后台设定本轮口径');
    const at = (await adminAt('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const saveCfg = await adminAt('/admin/api/setting/save', {
      method: 'POST', token: at,
      body: {
        group: 'trade',
        values: {
          service_charge: String(CFD.serviceRate),
          listing_fee_rate: String(CFD.listingRate),
          withdraw_fee: String(CFD.withdrawFee),
          price_increase_rate: String(CFD.increaseRate),
        },
      },
    });
    ok(saveCfg.code === 1, '保存交易设置', saveCfg.msg);
    const cfgBack = (await adminAt('/admin/api/setting/trade', { token: at })).data.values;
    ok(Number(cfgBack.service_charge) === CFD.serviceRate, `抢单服务费 ${CFD.serviceRate}%`, `实际 ${cfgBack.service_charge}`);
    ok(Number(cfgBack.listing_fee_rate) === CFD.listingRate, `上架费 ${CFD.listingRate}%`, `实际 ${cfgBack.listing_fee_rate}`);
    ok(Number(cfgBack.withdraw_fee) === CFD.withdrawFee, `提现手续费 ${CFD.withdrawFee}%`, `实际 ${cfgBack.withdraw_fee}`);
    ok(Number(cfgBack.price_increase_rate) === CFD.increaseRate, `转拍涨价 ${CFD.increaseRate}%`, `实际 ${cfgBack.price_increase_rate}`);

    // ================= 2. 建 10000 的商品 =================
    section('[2] 后台建 10000 元商品');
    const holder = db.prepare("SELECT member_id, invitation_code FROM member WHERE mobile='13800000001'").get();
    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    const areaId = db.prepare('SELECT specialarea_id FROM specialarea LIMIT 1').get().specialarea_id;
    const createGoods = await adminAt('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: {
        goods_name: '联调标品 10000', goods_no: 'CHAIN-10000',
        category_id: catId, specialarea_id: areaId, member_id: holder.member_id,
        goods_min_price: CFD.basePrice, line_price: Math.round(CFD.basePrice * 1.4),
        stock_num: 1, goods_status: 10, sales_actual: 0, goods_sort: 1,
      },
    });
    ok(createGoods.code === 1 && createGoods.data?.id, '创建商品', createGoods.msg);
    const gid = createGoods.data.id;
    // 商品不再自带场次字段：建完之后单独把它关联到场次（唯一数据源是关联表）
    const linkArea = await adminAt('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: areaId, goods_ids: [gid] },
    });
    ok(linkArea.code === 1, '商品关联到场次', linkArea.msg);
    const g0 = db.prepare('SELECT goods_id, goods_min_price, member_id, goods_status FROM goods WHERE goods_id = ?').get(gid);
    eqMoney(g0.goods_min_price, CFD.basePrice, '商品初始标价 10000');
    eqMoney(g0.goods_status, 10, '商品在售');

    // ================= 3. 邀请注册 5 位买家 =================
    section('[3] 通过邀请码注册并登录 5 位买家');
    const buyers = [];
    for (let i = 0; i < CFD.rounds; i += 1) {
      const phone = `1391000000${i + 1}`;
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST',
        body: { phone, password: '123456', code: holder.invitation_code, nickName: `第${i + 1}手` },
      });
      ok(reg.code === 1 && !!reg.data?.token, `注册第 ${i + 1} 手（邀请码 ${holder.invitation_code}）`, reg.msg);
      const token = reg.data.token;
      const mid = reg.data.member_id;
      const parent = db.prepare('SELECT p_id, path FROM member WHERE member_id = ?').get(mid);
      ok(Number(parent.p_id) === Number(holder.member_id), `第 ${i + 1} 手绑定上级为邀请人`, `p_id=${parent.p_id}`);
      // 登录一次验证密码可用
      const relogin = await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: '123456' } });
      ok(relogin.code === 1, `第 ${i + 1} 手可登录`);
      // 后台充值，保证买得起
      await adminAt('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: mid, field: 'amount', value: 200000, remark: '联调充值' },
      });
      buyers.push({ phone, token, mid, nick: `第${i + 1}手` });
    }

    // ================= 4. 五轮抢单 → 转拍 =================
    section('[4] 五轮「抢单 → 支付 → 转拍」，逐轮核对金额');
    // 预期链：P(n) = P(n-1) × 1.03；服务费 = P × 2%；实付 = P + 服务费
    const expectChain = [];
    let price = m2(CFD.basePrice);
    for (let r = 1; r <= CFD.rounds; r += 1) {
      const fee = m2((price * CFD.serviceRate) / 100);
      expectChain.push({ round: r, price, fee, payTotal: m2(price + fee) });
      price = m2(price * (1 + CFD.increaseRate / 100));
    }

    console.log('\n  轮次      标价        服务费      买家实付     卖家到账');
    for (const e of expectChain) {
      console.log(`  第${e.round}轮  ${yuan(e.price).padStart(11)} ${yuan(e.fee).padStart(11)} ${yuan(e.payTotal).padStart(12)} ${yuan(e.price).padStart(12)}`);
    }
    console.log('');

    // 第一轮的卖家是商品原持有人
    let sellerMid = Number(holder.member_id);
    let sellerToken = null;
    let currentOrderId = null;

    for (let r = 1; r <= CFD.rounds; r += 1) {
      const e = expectChain[r - 1];
      const buyer = buyers[r - 1];

      // 转拍会把商品排到「下一场」，一天三场走完就顺延到第二天。
      // 联调要连跑 5 轮，这里代替「等到了那一天」把场次日期放开，金额口径一概不动。
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);

      // 4.1 报价：服务费 = 标价 × 2%
      const quote = await api(`/api/order/getServiceCharge?goods_id=${gid}&num=1`);
      ok(quote.code === 1, `第${r}轮 服务费报价可读`, quote.msg);
      eqMoney(quote.data?.service_charge, e.fee, `第${r}轮 报价服务费 = ${yuan(e.price)} × ${CFD.serviceRate}%`);

      // 4.2 记录买卖双方余额
      const buyerBefore = await balance(buyer.token);
      const sellerBefore = sellerToken ? await balance(sellerToken) : Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(sellerMid).amount);

      // 4.3 下单
      const order = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer.token,
        body: { goods_id: gid, num: 1, pay_type: 1 },
      });
      ok(order.code === 1, `第${r}轮 下单成功`, order.msg);
      if (order.code !== 1) break;
      currentOrderId = order.data.order_id;
      eqMoney(order.data.total_price, e.price, `第${r}轮 订单标价 = ${yuan(e.price)}`);
      eqMoney(order.data.service_charge, e.fee, `第${r}轮 订单服务费 = ${yuan(e.fee)}`);

      const row = db.prepare('SELECT total_price, service_charge FROM orders WHERE order_id = ?').get(currentOrderId);
      eqMoney(row.total_price, e.price, `第${r}轮 落库标价`);
      eqMoney(row.service_charge, e.fee, `第${r}轮 落库服务费`);

      // 4.4 支付
      const pay = await api('/api/order/toPay', { method: 'POST', token: buyer.token, body: { order_id: currentOrderId, pay_type: 1 } });
      ok(pay.code === 1, `第${r}轮 余额支付成功`, pay.msg);

      const buyerAfter = await balance(buyer.token);
      eqMoney(buyerBefore - buyerAfter, e.payTotal, `第${r}轮 买家实付 = 标价 + 服务费`);

      const sellerAfter = sellerToken ? await balance(sellerToken) : Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(sellerMid).amount);
      eqMoney(sellerAfter - sellerBefore, e.price, `第${r}轮 卖家到账 = 标价全额（平台不抽货款）`);

      // 4.5 商品与持有人
      const gRow = db.prepare('SELECT member_id, goods_min_price, turn_beat_num FROM goods WHERE goods_id = ?').get(gid);
      ok(Number(gRow.member_id) === Number(buyer.mid), `第${r}轮 商品归属转移给买家`);
      eqMoney(gRow.goods_min_price, e.price, `第${r}轮 商品现标价 = ${yuan(e.price)}`);
      eqMoney(gRow.turn_beat_num, r, `第${r}轮 流转次数 = ${r}`);

      // 4.6 转拍（最后一轮不转，便于核对终态）
      if (r < CFD.rounds) {
        const nextExpect = m2(e.price * (1 + CFD.increaseRate / 100));
        const cq = await api(`/api/order/getConsignmentQuote?order_id=${currentOrderId}`, { token: buyer.token });
        ok(cq.code === 1, `第${r}轮 转拍报价可读`, cq.msg);
        eqMoney(cq.data?.prev_price, e.price, `第${r}轮 报价上一手价`);
        eqMoney(cq.data?.next_price, nextExpect, `第${r}轮 下一轮标价 = ${yuan(e.price)} × 1.03`);
        eqMoney(cq.data?.listing_fee, 0, `第${r}轮 上架费为 0`);
        eqMoney(cq.data?.net_income, m2(nextExpect - e.price - 0), `第${r}轮 持有人本轮净收益 = 涨价额`);

        const feeBefore = await balance(buyer.token);
        const consign = await api('/api/order/consignment', { method: 'POST', token: buyer.token, body: { order_id: currentOrderId } });
        ok(consign.code === 1, `第${r}轮 转拍成功`, consign.msg);
        eqMoney(consign.data?.listing_fee, '0.00', `第${r}轮 转拍未收上架费`);
        const feeAfter = await balance(buyer.token);
        eqMoney(feeBefore - feeAfter, 0, `第${r}轮 转拍未扣任何费用（余额不变）`);

        const gAfter = db.prepare('SELECT goods_min_price, goods_status FROM goods WHERE goods_id = ?').get(gid);
        eqMoney(gAfter.goods_min_price, nextExpect, `第${r}轮 商品标价已更新为 ${yuan(nextExpect)}`);
        eqMoney(gAfter.goods_status, 10, `第${r}轮 商品重新上架`);

        const noListingFee = db.prepare(
          "SELECT COUNT(*) c FROM finance_energy WHERE type_name = '转拍上架费'",
        ).get().c;
        eqMoney(noListingFee, 0, `第${r}轮 库中无上架费流水`);
      }

      // 下一轮由本手卖给下一位
      sellerMid = buyer.mid;
      sellerToken = buyer.token;
    }

    // ================= 5. 终态核对 =================
    section('[5] 五轮走完的终态核对');
    const finalGoods = db.prepare('SELECT goods_min_price, member_id, turn_beat_num FROM goods WHERE goods_id = ?').get(gid);
    eqMoney(finalGoods.goods_min_price, expectChain[CFD.rounds - 1].price, `终态标价 = ${yuan(expectChain[CFD.rounds - 1].price)}（第5轮成交价）`);
    eqMoney(finalGoods.turn_beat_num, CFD.rounds, `终态流转次数 = ${CFD.rounds}`);
    ok(Number(finalGoods.member_id) === Number(buyers[CFD.rounds - 1].mid), '终态持有人 = 第 5 手');

    const totalService = m2(expectChain.reduce((s, e) => s + e.fee, 0));
    const dbService = m2(db.prepare('SELECT IFNULL(SUM(service_charge),0) v FROM orders WHERE goods_id = ?').get(gid).v);
    eqMoney(dbService, totalService, `五轮服务费合计 = ${yuan(totalService)}`);
    console.log(`    逐轮服务费：${expectChain.map((e) => yuan(e.fee)).join(' + ')} = ${yuan(totalService)}`);

    const totalListing = m2(db.prepare("SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type_name = '转拍上架费'").get().v);
    eqMoney(totalListing, 0, '全程未产生上架费');

    // 每一手的净收益（涨价额）
    console.log('\n  各手持有人净收益（无上架费，卖出价 − 买入价）：');
    for (let r = 1; r < CFD.rounds; r += 1) {
      const buy = expectChain[r - 1].price;
      const sell = expectChain[r].price;
      console.log(`    第${r}手：买入 ${yuan(buy)} → 卖出 ${yuan(sell)}，净赚 ${yuan(sell - buy)}`);
      eqMoney(sell - buy, m2((buy * CFD.increaseRate) / 100), `第${r}手净收益 = 买入价 × ${CFD.increaseRate}%`);
    }
    const lastBuy = expectChain[CFD.rounds - 1].price;
    console.log(`    第${CFD.rounds}手：买入 ${yuan(lastBuy)}（仍在持仓，未卖出）`);

    // ================= 6. 直推奖（0.5%，平台支出，不影响买卖双方） =================
    section('[6] 直推奖（默认 0.5%，验证是否影响买卖双方金额）');
    const driveRate = Number((await api('/api/index/getTradeConfig')).data?.drive_award_rate || 0);
    const awardRows = db.prepare("SELECT member_id, face_value, remarks FROM finance_energy WHERE type = 1").all();
    const awardTotal = m2(awardRows.reduce((s, a) => s + Number(a.face_value), 0));
    console.log(`    直推奖率 ${driveRate}%，共 ${awardRows.length} 笔、合计 ${yuan(awardTotal)}`);
    const expectAward = m2(expectChain.reduce((s, e) => s + m2((e.price * driveRate) / 100), 0));
    eqMoney(awardTotal, expectAward, `直推奖合计 = Σ(成交价 × ${driveRate}%)`);
    const holderAward = m2(awardRows.filter((a) => Number(a.member_id) === Number(holder.member_id)).reduce((s, a) => s + Number(a.face_value), 0));
    ok(holderAward > 0, '邀请人（上级）收到了直推奖', yuan(holderAward));

    // ================= 7. 提现无手续费 =================
    section('[7] 提现（手续费 0%）');
    const winner = buyers[CFD.rounds - 2]; // 第 4 手已卖出，账上有钱
    const wdAmount = 1000;
    const wdBefore = await balance(winner.token);
    const wd = await api('/api/finance/withdraw/apply', {
      method: 'POST', token: winner.token,
      body: { amount: wdAmount, account_type: 3, account_info: '联调银行卡 6222' },
    });
    ok(wd.code === 1, '提交提现申请', wd.msg);
    const wdRow = db.prepare('SELECT amount, fee, actual_amount FROM finance_withdraw WHERE member_id = ? ORDER BY withdraw_id DESC LIMIT 1').get(winner.mid);
    eqMoney(wdRow.amount, wdAmount, `提现金额 ${yuan(wdAmount)}`);
    eqMoney(wdRow.fee, 0, '提现手续费为 0');
    eqMoney(wdRow.actual_amount, wdAmount, '实际到账 = 提现金额');
    eqMoney(wdBefore - (await balance(winner.token)), wdAmount, '余额冻结扣减 = 提现金额（未多扣手续费）');

    // ================= 8. 数据一致性 =================
    section('[8] 联调后的数据一致性');
    ok(db.prepare('SELECT COUNT(*) c FROM member WHERE amount < 0').get().c === 0, '没有会员出现负余额');
    ok(db.prepare('SELECT COUNT(*) c FROM orders o LEFT JOIN goods g ON g.goods_id = o.goods_id WHERE g.goods_id IS NULL').get().c === 0, '没有孤儿订单');
    const ords = db.prepare('SELECT total_price, service_charge, listing_fee FROM orders WHERE goods_id = ? AND type = 1').all(gid);
    eqMoney(ords.length, CFD.rounds, `该商品共产生 ${CFD.rounds} 笔抢购订单`);
    ok(ords.every((o) => m2(o.listing_fee || 0) === 0), '所有订单上架费字段均为 0');
    const sumPrice = m2(ords.reduce((s, o) => s + Number(o.total_price), 0));
    const expectSum = m2(expectChain.reduce((s, e) => s + e.price, 0));
    eqMoney(sumPrice, expectSum, `成交总额合计 = ${yuan(expectSum)}`);

  } finally {
    srv.kill();
    await sleep(300);
  }

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    console.log('\n失败项：');
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}

main().catch((e) => { console.error('联调异常:', e); process.exit(1); });
