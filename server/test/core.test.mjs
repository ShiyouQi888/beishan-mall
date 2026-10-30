// 核心算法与风控端到端测试（对齐原站实证口径）
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = 'test.db';

process.env.MALL_DB = TEST_DB;
process.env.PORT = String(PORT);

let pass = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(Math.abs(Number(a) - Number(b)) < 0.011, name, `期望 ${b}，实际 ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => Math.round(Number(n) * 100) / 100;
// KEEP_AREA_DATE=1：关闭所有「清空 area_date」的测试夹具，让日程像生产一样生效，
// 用于自查核心测试是否因为夹具而掩盖了真实的日程约束。
const KEEP_SCHEDULE = process.env.KEEP_AREA_DATE === '1';

const dbFile = join(ROOT, 'data', TEST_DB);
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (existsSync(f)) unlinkSync(f);

const env = { ...process.env, MALL_DB: TEST_DB, PORT: String(PORT) };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

async function main() {
  console.log('\n[setup] 初始化独立测试库…');
  await run('node', ['src/seed.js']);

  const { db } = await import('../src/db.js');
  db.exec('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99');

  const baseline = {
    balSum: db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v,
    flowSum: db.prepare("SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2").get().v,
  };

  const srv = spawn('node', ['src/app.js'], { cwd: ROOT, env, stdio: 'pipe' });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d));
  srv.stderr.on('data', (d) => {
    const s = String(d);
    srvLog += s;
    if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write(s);
  });

  // 轮询等待服务就绪（启动阶段包含节点同步与数据迁移，耗时不定）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) { ready = true; break; }
    } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时，日志：\n' + srvLog.slice(-800));

  const api = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = { ...(await res.json()), httpStatus: res.status };
    // 日程夹具（时间倒回）：生产中一件商品被抢下 → 转拍 → 排到下一场甚至明天，
    // 同一件货要隔天才能再买一轮。本文件是单进程几分钟跑完的资金口径测试，
    // 需要让同一件货连续成交 4~5 轮，只能把它的 area_date 清掉，等于是把日历往回拨。
    //
    // 它「不」验证什么：转拍到底该落在哪一场、落在哪一天，这里一律不校验、也不断言。
    // 那部分由 scripts/probe/session-rotation.mjs（34 项，含跨天与一天一场）负责。
    // 它「不」掩盖什么：下单接口对 area_date > today 的拦截本身仍然生效 ——
    // KEEP_AREA_DATE=1 关掉夹具后会立刻看到 24 项因「该商品将在明天的场次开抢」而失败，
    // 说明拦截逻辑是真的在工作，不是被夹具绕过去的。
    if (KEEP_SCHEDULE) return json;
    if (path === '/api/order/consignment' && json.code === 1 && body?.order_id) {
      const row = db.prepare('SELECT goods_id FROM orders WHERE order_id = ?').get(Number(body.order_id));
      if (row) db.prepare('UPDATE goods SET area_date = ? WHERE goods_id = ?').run('', row.goods_id);
    }
    return json;
  };
  const login = async (phone) =>
    (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
  const detail = async (token) => (await api('/api/member/getMemberDetails', { token })).data;

  try {
    console.log(
      KEEP_SCHEDULE
        ? '\n[日程夹具] 已关闭（KEEP_AREA_DATE=1）：转拍后商品会真的排到下一场/明天，\n'
          + '           本进程内无法再买同一件商品，转拍相关段落预期会失败。'
        : '\n[日程夹具] 已启用：转拍成功后把商品 area_date 清空（相当于「时间倒回」）。\n'
          + '           本文件只验证资金口径；「转拍到明天、今天买不到」由 session-rotation.mjs 验证。',
    );

    // 核心测试覆盖的是资金与流转口径，日程规则由 session-rotation.mjs 单独覆盖；
    // 这里把所有商品置为「不限日期」，避免前一段的转拍把商品推到明天、影响后一段。
    if (!KEEP_SCHEDULE) db.prepare("UPDATE goods SET area_date = ''").run();

    console.log('\n[1] 抢购分账（服务费按配置收，卖家全额，上级拿 0.5% 直推奖）');
    const svcRate = Number(db.prepare("SELECT `value` v FROM setting_config WHERE `key`='service_charge'").get().v);
    console.log(`    当前抢单服务费率：${svcRate}%`);
    const buyer = await login('13822367845');
    const seller = await login('13800000002');
    const top = await login('13800000001');

    await api('/api/member/setPay', {
      method: 'POST', token: buyer,
      body: { type: 3, account: '6222000000000001', name: '北山', bank: '招商银行' },
    });

    const goodsList = await api('/api/goods/getLootGoodsList?page=1&limit=50');
    const target = (goodsList.data.data || []).find((g) => g.holder === '玄德世家' && Number(g.goods_min_price) > 0);
    ok(!!target, '找到可用于测试的商品');

    const price = Number(target.goods_min_price);
    const b0 = await detail(buyer), s0 = await detail(seller), t0 = await detail(top);

    const order = await api('/api/order/toAddOrder', {
      method: 'POST', token: buyer, body: { goods_id: target.goods_id, num: 1, pay_type: 1 },
    });
    ok(order.code === 1, '下单成功', order.msg);
    eq(order.data.service_charge, money(price * svcRate / 100), `抢购服务费 = ${price} × ${svcRate}%`);

    const oid = order.data.order_id;
    const paid = await api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: oid, pay_type: 1 } });
    ok(paid.code === 1, '余额支付成功', paid.msg);

    const b1 = await detail(buyer), s1 = await detail(seller), t1 = await detail(top);
    eq(Number(b0.amount) - Number(b1.amount), money(price + Number(order.data.service_charge)),
      `买家支出 = 商品价 ${price} + 服务费 ${order.data.service_charge}`);
    eq(Number(s1.amount) - Number(s0.amount), price, `卖家实收 = 商品价全额 ${price}`);

    const driveExpect = money(price * 0.005);
    eq(Number(s1.e_card_number) - Number(s0.e_card_number), driveExpect,
      `直推奖 = ${price} × 0.5% = ${driveExpect}`);
    eq(Number(t1.e_card_number) - Number(t0.e_card_number), 0, '二级不参与分成（仅单级直推奖）');

    const ecard = await api('/api/member/getECardList', { token: seller });
    const hit = (ecard.data || []).find((x) => Math.abs(Number(x.face_value) - driveExpect) < 0.01);
    // 佣金流水类型是 1（早期误写成 3=积分，导致佣金和积分流水混在一起）
    ok(!!hit, '佣金流水接口能查到该笔直推奖（type=1 佣金）',
      `返回 ${(ecard.data || []).length} 条`);

    const gAfter = await api('/api/goods/getLootDetails?goods_id=' + target.goods_id);
    ok(gAfter.data.holder === '北山', '商品持有人已转移', `实际 ${gAfter.data.holder}`);

    console.log('\n[2] 转拍上架（上架费与服务费按配置，标价自动涨价）');
    const rate = Number(db.prepare("SELECT `value` v FROM setting_config WHERE `key`='listing_fee_rate'").get().v);
    const feeExpect = money(price * rate / 100);
    // 新模型：标价由服务端按「上一手成交价 ×(1+涨价率)」自动算，前端不再手填
    const incRate = Number(db.prepare("SELECT `value` v FROM setting_config WHERE `key`='price_increase_rate'").get().v);
    ok(incRate > 0, '转拍涨价率已配置', `${incRate}%`);
    const newPrice = money(price * (1 + incRate / 100));

    const before = await detail(buyer);
    const consign = await api('/api/order/consignment', {
      method: 'POST', token: buyer, body: { order_id: oid },
    });
    ok(consign.code === 1, '转拍成功', consign.msg);
    eq(consign.data?.listing_fee, feeExpect, `上架费 = ${price} × ${rate}% = ${feeExpect}`);
    eq(consign.data?.prev_price, price, '报价里的上一手成交价正确');
    eq(consign.data?.increase_rate, incRate, '报价返回涨价率');
    eq(consign.data?.next_price, newPrice, `自动标价 = ${price} × (1+${incRate}%) = ${newPrice}`);

    const after = await detail(buyer);
    eq(Number(before.amount) - Number(after.amount), feeExpect, '上架费从余额扣减');

    const g2 = await api('/api/goods/getLootDetails?goods_id=' + target.goods_id);
    eq(g2.data.goods_min_price, newPrice, `商品按新标价 ${newPrice} 重新上架`);
    ok(
      Number(g2.data.line_price) === 0 || Number(g2.data.line_price) > Number(g2.data.goods_min_price),
      '转拍后划线价不为零时必须高于现价',
      `现价 ${g2.data.goods_min_price} / 划线价 ${g2.data.line_price}`,
    );

    // 转拍不再另开 type=2 寄卖单：挂单信息就在原订单 + 商品上
    const coCount = db.prepare('SELECT COUNT(*) c FROM orders WHERE goods_id = ? AND type = 2').get(target.goods_id).c;
    eq(coCount, 0, '转拍不再生成寄卖挂单(type=2)');
    const oRow = db.prepare('SELECT consignment_status, listing_fee, transposition_time FROM orders WHERE order_id = ?').get(oid);
    eq(oRow.consignment_status, 10, '原订单标记为已转拍');
    eq(oRow.listing_fee, feeExpect, '原订单记录上架费');
    ok(!!oRow.transposition_time, '原订单记录转拍时间（流拍扫描依据）');

    // 平台单轮净收 = 抢单服务费 + 转拍上架费 − 直推奖
    const svcFee = money(price * svcRate / 100);
    const net = money(svcFee + feeExpect - driveExpect);
    console.log(`    商品价 ${price} / 服务费 ${svcFee} / 上架费 ${feeExpect} / 直推奖 ${driveExpect} / 平台净收 ${net}`);
    ok(net > 0, '平台本轮净收入为正', `净收 ${net}（服务费 ${svcFee} + 上架费 ${feeExpect} − 直推奖 ${driveExpect}）`);

    
    console.log('\n[3] 差价结算已停用（防重复收款）');
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;

    // 成交即入账：卖家在付款那一刻就拿到钱了，再跑差价匹配会让他收第二次
    const settleRun = await api('/admin/api/settle/run', { method: 'POST', token: at, body: { specialarea_id: 0 } });
    ok(settleRun.code === 0 && /停用/.test(settleRun.msg), '执行结算被拒绝', settleRun.msg);

    // 会员端三个接口必须真的没了，避免「有接口没入口」的半死状态卷土重来
    const gone = await api('/api/order/mySettle', { token: buyer });
    ok(gone.code !== 1 && /不存在/.test(gone.msg), '会员端结算接口已删除', gone.msg);
    ok((await api('/api/order/settleConfirm', { method: 'POST', token: buyer, body: { match_id: 1 } })).code !== 1, '确认收款接口已删除');

    // 只读对账接口还在（后台对账要用）
    ok((await api('/admin/api/settle/batches', { token: at })).code === 1, '结算批次可读（对账）');
    ok((await api('/admin/api/settle/accounts?batch_id=0', { token: at })).code === 1, '中账可读（对账）');

    // 卖家确实在支付时就到账了，这是停用差价匹配的根本原因
    const sellerOfOrder = db.prepare('SELECT seller_id FROM orders WHERE order_id = ?').get(oid)?.seller_id;
    const sellerRow = db.prepare('SELECT amount FROM member WHERE member_id = ?').get(sellerOfOrder);
    ok(!!sellerRow && Number(sellerRow.amount) > 0, '卖家在成交时已到账（即时入账）', '余额 ' + money(sellerRow?.amount));

    console.log('\n[4] 风控拦截');

    const dup = await api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: oid, pay_type: 1 } });
    ok(dup.code === 0, '重复支付被拦截', dup.msg);

    const dupC = await api('/api/order/consignment', { method: 'POST', token: buyer, body: { order_id: oid, price: newPrice } });
    ok(dupC.code === 0, '同一订单不能重复转拍', dupC.msg);

    const own = (goodsList.data.data || []).find((g) => g.holder === '北山');
    if (own) {
      const sb = await api('/api/order/toAddOrder', { method: 'POST', token: buyer, body: { goods_id: own.goods_id, num: 1, pay_type: 1 } });
      ok(sb.code === 0, '不能购买自己持有的商品', sb.msg);
    }

    const poor = await login('13800000004');
    const pr = db.prepare("SELECT member_id id, amount FROM member WHERE mobile='13800000004'").get();
    if (Number(pr.amount) > 0) {
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: pr.id, field: 'amount', value: -Number(pr.amount), remark: '测试清零' },
      });
    }
    const pb = await api('/api/order/toAddOrder', { method: 'POST', token: poor, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    if (pb.code === 1) {
      const r2 = await api('/api/order/toPay', { method: 'POST', token: poor, body: { order_id: pb.data.order_id, pay_type: 1 } });
      ok(r2.code === 0 && /余额不足/.test(r2.msg), '余额不足被拦截', r2.msg);
    }

    db.prepare('UPDATE specialarea SET start_time = 7200, end_time = 7300').run();
    const ot = await api('/api/order/toAddOrder', { method: 'POST', token: buyer, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(ot.code === 0, '非场次时间下单被拦截', ot.msg);
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 86399').run();

    // 「抢购前必须绑定收款账户」已改为后台可配开关，默认关闭
    db.prepare("UPDATE member SET pay_setting = '' WHERE mobile = '13800000004'").run();
    db.prepare('DELETE FROM member_card WHERE member_id = ?').run(pr.id);
    const rcCfg = (await api('/admin/api/setting/trade', { token: at })).data?.values?.require_receiving_account;
    ok(Number(rcCfg) === 20, '收款账户强制开关默认关闭（未开启）', `实际 ${JSON.stringify(rcCfg)}`);

    const npOff = await api('/api/order/toAddOrder', { method: 'POST', token: poor, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(npOff.code === 1, '开关关闭时未绑定收款账户也可下单', npOff.msg);

    await api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'trade', values: { require_receiving_account: '10' } },
    });
    const np = await api('/api/order/toAddOrder', { method: 'POST', token: poor, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(np.code === 0 && /收款方式/.test(np.msg), '开启开关后未绑定收款账户被拦截', np.msg);
    await api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'trade', values: { require_receiving_account: '20' } },
    });

    console.log('\n[5] 提现与退回');
    await api('/api/member/card/add', { method: 'POST', token: buyer, body: { type: 3, account: '6222000000000003', name: '北山', bank: '招商银行' } });
    const wb = Number((await detail(buyer)).amount);
    await api('/api/finance/withdraw/apply', { method: 'POST', token: buyer, body: { amount: 100, account_type: 3, account_info: '招商银行 6222' } });
    eq(wb - Number((await detail(buyer)).amount), 100, '提现申请立即冻结扣减 ¥100');

    const wl = await api('/admin/api/withdraw/list?page=1&limit=10', { token: at });
    const pend = (wl.data.data || []).find((x) => x.status === 0);
    await api('/admin/api/withdraw/audit', { method: 'POST', token: at, body: { withdraw_id: pend.withdraw_id, pass: false, remark: '测试驳回' } });
    eq(Number((await detail(buyer)).amount), wb, '驳回后余额自动退回');

    console.log('\n[6] 数据一致性');
    const fs2 = db.prepare("SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2").get().v;
    const bs2 = db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v;
    eq(money(bs2 - baseline.balSum), money(fs2 - baseline.flowSum), '余额变动 == 余额流水汇总（增量）');
    eq(db.prepare('SELECT COUNT(*) c FROM member WHERE amount < 0').get().c, 0, '没有会员出现负余额');
    eq(db.prepare('SELECT COUNT(*) c FROM orders o LEFT JOIN goods g ON g.goods_id = o.goods_id WHERE g.goods_id IS NULL').get().c, 0, '没有孤儿订单');
    ok(db.prepare('SELECT COUNT(*) c FROM member_grade').get().c === 5, '五级会员等级配置存在');

    console.log('\n[7] 并发安全');
    const bid = db.prepare("SELECT member_id id FROM member WHERE mobile='13822367845'").get().id;
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: bid, field: 'amount', value: 50000, remark: '测试充值' } });
    const g3 = db.prepare("SELECT * FROM goods WHERE member_id = (SELECT member_id FROM member WHERE mobile='13800000002') AND goods_min_price <= 20000 ORDER BY goods_min_price ASC LIMIT 1").get();
    if (g3) {
      const o3 = await api('/api/order/toAddOrder', { method: 'POST', token: buyer, body: { goods_id: g3.goods_id, num: 1, pay_type: 1 } });
      if (o3.data?.order_id) {
        const rs = await Promise.all([
          api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: o3.data.order_id, pay_type: 1 } }),
          api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: o3.data.order_id, pay_type: 1 } }),
        ]);
        ok(rs.filter((r) => r.code === 1).length === 1, '并发支付同一订单只成功一次', `成功 ${rs.filter((r) => r.code === 1).length} 次`);
      }
    }

    console.log('\n[8] 商品拆分');
    await api('/api/member/setPay', {
      method: 'POST', token: seller,
      body: { type: 3, account: '6222000000000010', name: '玄德世家', bank: '工商银行' },
    });
    const splitable = db.prepare(
      "SELECT * FROM goods WHERE member_id = ? AND goods_status = 10 AND is_split = 0 AND type = 1 LIMIT 1",
    ).get(bid);
    if (splitable) {
      const p0 = Number(splitable.goods_min_price);
      const sp = await api('/api/goods/split', {
        method: 'POST', token: buyer, body: { goods_id: splitable.goods_id, parts: 4 },
      });
      ok(sp.code === 1, '拆分成功', sp.msg);
      eq(sp.data?.per_part, money(p0 / 4), `每份价格 = ${p0} / 4`);

      const gs = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(splitable.goods_id);
      const expectLine = Number(splitable.line_price) > 0
        ? Math.floor((Number(splitable.line_price) * 100) / 4) / 100
        : 0;
      eq(gs.line_price, expectLine, `划线价同步按份折算（${splitable.line_price} → ${expectLine}）`);
      ok(gs.line_price === 0 || Number(gs.line_price) > Number(gs.goods_min_price), '划线价高于每份现价');
      eq(gs.stock_num, 4, '库存为 4 份');
      eq(gs.is_split, 1, '标记为拆分商品');
      eq(gs.split_total, 4, '记录拆分总份数');

      const dupSplit = await api('/api/goods/split', {
        method: 'POST', token: buyer, body: { goods_id: splitable.goods_id, parts: 2 },
      });
      ok(dupSplit.code === 0, '已拆分商品不可重复拆分', dupSplit.msg);

      const buySplit = await api('/api/order/toAddOrder', {
        method: 'POST', token: seller, body: { goods_id: splitable.goods_id, num: 2, pay_type: 1 },
      });
      ok(buySplit.code === 1, '拆分商品可下单 2 份', buySplit.msg);
      const gs2 = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(splitable.goods_id);
      eq(gs2.stock_num, 2, '下单后库存扣减为 2 份');

      const over = await api('/api/order/toAddOrder', {
        method: 'POST', token: seller, body: { goods_id: splitable.goods_id, num: 5, pay_type: 1 },
      });
      ok(over.code === 0 && /名额|库存/.test(over.msg), '超过名额被拒单', over.msg);
    }

    console.log('\n[9] 流拍（按原订单推导，不再依赖寄卖挂单）');
    // 造一个「已转拍挂着但没卖掉」的状态：任一持有人 + 其订单标记已转拍 + 商品仍在架
    const pendListing = db.prepare(
      `SELECT o.order_id, o.goods_id, o.member_id FROM orders o JOIN goods g ON g.goods_id = o.goods_id
       WHERE o.type = 1 AND o.status IN (10, 30) AND g.member_id = o.member_id AND g.goods_status = 10
       ORDER BY o.order_id DESC LIMIT 1`,
    ).get();
    ok(!!pendListing, '找到可构造流拍的挂单');
    if (pendListing) {
      db.prepare("UPDATE orders SET consignment_status = 10, transposition_time = '2026-10-28 10:00:00' WHERE order_id = ?")
        .run(pendListing.order_id);
      // 此时库里不应存在 type=2 挂单，流拍必须靠原订单推出来
      eq(
        db.prepare('SELECT COUNT(*) c FROM orders WHERE goods_id = ? AND type = 2 AND status = 0').get(pendListing.goods_id).c,
        0, '无寄卖挂单也能识别待流拍',
      );

      const scan = await api('/admin/api/streambeat/scan', {
        method: 'POST', token: at, body: { date: '2026-10-28' },
      });
      ok(scan.code === 1, '执行流拍扫描', scan.msg);
      ok((scan.data?.count || 0) >= 1, '标记了流拍商品', `${scan.data?.count} 件`);

      const gA = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(pendListing.goods_id);
      eq(gA.goods_status, 30, '商品状态变为流拍(30)');

      const lOrder = db.prepare('SELECT * FROM orders WHERE type = 5 AND status = 50 ORDER BY order_id DESC LIMIT 1').get();
      ok(!!lOrder, '生成流拍记录(type=5)');

      eq(
        db.prepare('SELECT consignment_status c FROM orders WHERE order_id = ?').get(pendListing.order_id).c,
        0, '流拍后原订单挂单标记已关闭',
      );

      // 幂等：再扫一次不应重复生成
      const scan2 = await api('/admin/api/streambeat/scan', {
        method: 'POST', token: at, body: { date: '2026-10-29' },
      });
      eq(
        db.prepare('SELECT COUNT(*) c FROM orders WHERE type = 5 AND goods_id = ?').get(pendListing.goods_id).c,
        1, '同一挂单不会重复判流拍',
      );
      ok(scan2.code === 1, '重复扫描不报错', scan2.msg);

      const rel = await api('/admin/api/streambeat/release', {
        method: 'POST', token: at, body: { order_id: lOrder.order_id },
      });
      ok(rel.code === 1, '释放流拍', rel.msg);
      const gR = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(pendListing.goods_id);
      eq(gR.goods_status, 10, '释放后商品恢复上架(10)');
    }


    console.log('\n[10] 场次时段 / 开放日 + 专场转拍时限');
    const cfgSave = await api('/admin/api/specialarea/save', {
      method: 'POST', token: at,
      body: { specialarea_id: 1, title_main: '测试专场' },
    });
    ok(cfgSave.code === 1, '保存专场配置', cfgSave.msg);

    const cfgBack = (await api('/admin/api/specialarea/detail?id=1', { token: at })).data || {};
    ok(cfgBack.title_main === '测试专场', '配置回读正确', `title_main=${cfgBack.title_main}`);

    // 每个场次按自己的「开放日 + 时段」判断，下面把 1 号场次的开放日改成不含今天
    const jsDay = new Date().getDay();
    const todayNum = jsDay === 0 ? 7 : jsDay;
    const otherDay = todayNum === 1 ? 2 : 1;
    const gArea1 = db.prepare(
      "SELECT * FROM goods WHERE specialarea_id = 1 AND goods_status = 10 AND member_id <> ? LIMIT 1",
    ).get(bid);

    await api('/admin/api/specialarea/save', {
      method: 'POST', token: at,
      body: { specialarea_id: 1, open_days: String(otherDay), start_time: 0, end_time: 86399 },
    });
    if (gArea1) {
      const closed = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer, body: { goods_id: gArea1.goods_id, num: 1, pay_type: 1 },
      });
      ok(closed.code === 0 && /今日未开放该场次/.test(closed.msg), '非开放日下单被拒', closed.msg);
    }

    // 恢复全周开放 + 24 小时转拍时限
    await api('/admin/api/specialarea/save', {
      method: 'POST', token: at,
      body: { specialarea_id: 1, open_days: '1,2,3,4,5,6,7', start_time: 0, end_time: 86399, transposition_hours: 24 },
    });

    if (gArea1) {
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: bid, field: 'amount', value: 20000, remark: '测试充值' },
      });
      const ord = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer, body: { goods_id: gArea1.goods_id, num: 1, pay_type: 1 },
      });
      if (ord.code === 1) {
        const oid2 = ord.data.order_id;
        await api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: oid2, pay_type: 1 } });
        db.prepare("UPDATE orders SET pay_time = datetime('now','localtime','-30 hours') WHERE order_id = ?").run(oid2);
        const late = await api('/api/order/consignment', {
          method: 'POST', token: buyer, body: { order_id: oid2, price: 2000 },
        });
        ok(late.code === 0 && /转拍时限/.test(late.msg), '超过转拍时限被拒', late.msg);
      }
    }


    console.log('\n[11] 后台补充接口');
    const st = await api('/admin/api/stats/goods', { token: at });
    ok(st.code === 1 && Number(st.data?.total_amount) > 0, '商品金额统计', `总额 ${st.data?.total_amount}`);

    const tdy = await api('/admin/api/stats/today-orders', { token: at });
    ok(tdy.code === 1 && tdy.data?.count >= 1, '今日订单明细', `${tdy.data?.count} 单`);

    await api('/admin/api/member/advance', {
      method: 'POST', token: at, body: { member_id: bid, enable: true, count: 3 },
    });
    const adv = db.prepare('SELECT is_advance, advance_count FROM member WHERE member_id = ?').get(bid);
    ok(adv.is_advance === 10 && adv.advance_count === 3, '提前抢购授权生效');

    const sellerId = db.prepare("SELECT member_id id FROM member WHERE mobile='13800000002'").get().id;
    const beforeClear = Number((await detail(seller)).e_card_number);
    if (beforeClear > 0) {
      await api('/admin/api/member/clear-commission', { method: 'POST', token: at, body: { member_id: sellerId } });
      const afterClear = Number((await detail(seller)).e_card_number);
      eq(afterClear, 0, `清除佣金生效（原 ${beforeClear}）`);
    }

    const rep = await api('/api/order/toOrderReport', {
      method: 'POST', token: buyer, body: { order_id: oid, reason: '商品与描述不符', content: '测试举报' },
    });
    ok(rep.code === 1, 'H5 提交举报', rep.msg);

    const repList = await api('/admin/api/report/list?page=1&limit=5', { token: at });
    const rp = (repList.data?.data || [])[0];
    ok(!!rp && rp.status === 0, '后台可见待处理举报', `共 ${repList.data?.total} 条`);

    await api('/admin/api/report/audit', {
      method: 'POST', token: at, body: { report_id: rp.report_id, pass: true, result: '已核实' },
    });
    const rp2 = db.prepare('SELECT status FROM order_report WHERE report_id = ?').get(rp.report_id);
    eq(rp2.status, 10, '举报审核流转为已处理');

    // 积分商城：接口路径对齐原站 /api/score/（不是 /api/goods/score/）
    // 积分商品自本轮起是独立表 score_item，不再关联 goods
    const scoreRow = db.prepare('SELECT item_id, name, score_price, stock FROM score_item WHERE status = 10').get();
    ok(!!scoreRow, '存在可兑换的积分商品');
    const sl = await api('/api/score/getScoreShopList?page=1&limit=30', { token: buyer });
    ok(sl.code === 1, '积分商城列表接口可达（/api/score）', sl.msg);
    ok((sl.data?.list?.data || []).length >= 1, '积分商城返回商品', `${sl.data?.list?.total} 件`);
    ok(
      (sl.data?.list?.data || []).every((x) => x.score_price !== undefined),
      '积分商城返回兑换所需积分',
    );
    const sd = await api(`/api/score/getDetails?item_id=${scoreRow.item_id}`, { token: buyer });
    ok(sd.code === 1 && Number(sd.data?.score_price) === Number(scoreRow.score_price), '积分商品详情返回积分价', JSON.stringify(sd.data?.score_price));
    // 原路径 /api/goods/score/... 已下线，访问应返回 404（非 JSON）
    const oldRes = await fetch(BASE + '/api/goods/score/getScoreShopList');
    eq(oldRes.status, 404, '积分接口旧的 goods 路径已下线');

    const cc = await api('/admin/api/cache/clear', { method: 'POST', token: at });
    ok(cc.code === 1, '清理缓存');

    const si = await api('/admin/api/sysinfo', { token: at });
    ok(si.code === 1 && si.data?.counts?.member >= 1, '系统信息读取');

    // 回归：/setting/save 不能被通用 /:module/save 拦截
    const sv = await api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'trade', values: { listing_fee_rate: '2.8' } },
    });
    ok(sv.code === 1, '保存设置不被通用路由拦截', sv.msg);
    const svBack = await api('/admin/api/setting/trade', { token: at });
    eq(svBack.data?.values?.listing_fee_rate, '2.8', '设置保存后可回读');
    const promptBefore = (await api('/admin/api/setting/prompt', { token: at })).data?.values?.prompt_withdraw;
    const crossGroupSave = await api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'trade', values: { prompt_withdraw: '不应写入' } },
    });
    ok(crossGroupSave.code === 0, '拒绝跨设置分组写入配置键', crossGroupSave.msg);
    const promptAfter = (await api('/admin/api/setting/prompt', { token: at })).data?.values?.prompt_withdraw;
    ok(promptBefore === promptAfter, '跨组写入失败后原设置保持不变');
    await api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'prompt', values: { prompt_withdraw: '测试用提现说明' } },
    });
    const h5SystemInfo = await api('/api/finance/getSystemInfo', { token: buyer });
    ok(h5SystemInfo.data?.prompt_withdraw === '测试用提现说明', '提现页系统信息接口返回后台提现须知配置');
    await api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'prompt', values: { prompt_withdraw: promptBefore || '' } },
    });

    const sg = await api('/admin/api/setting/storage', { token: at });
    ok(sg.code === 1 && (sg.data?.items || []).length > 0, '新增配置组可读取（上传配置）');

    // 协议与须知已合并进「须知配置」，不应再有独立的 grade 组
    // （不写死项数：新增须知项属于正常扩展，这里只校验迁移结果）
    const pg = await api('/admin/api/setting/prompt', { token: at });
    const pKeys = (pg.data?.items || []).map((i) => i.k);
    ok((pg.data?.items || []).length >= 7, '须知配置已合并', `${pg.data?.items?.length} 项`);
    for (const k of ['prompt_register', 'prompt_invite', 'prompt_shop', 'prompt_trade', 'prompt_privacy']) {
      ok(pKeys.includes(k), `须知配置含 ${k}`);
    }
    ok(!pKeys.includes('register_agreement') && !pKeys.includes('invitation_notice'), '旧协议键已迁移');
    ok(!!pg.data?.values?.prompt_register, '协议内容已迁移到 prompt_register');
    const gg = await api('/admin/api/setting/grade', { token: at });
    ok(gg.code === 0, '独立的「协议与须知」组已移除', gg.msg);

    const allPaths = (await api('/admin/api/node/tree', { token: at })).data.tree
      .flatMap((g) => g.children.map((c) => c.path));
    ok(!allPaths.includes('/setting/grade'), '节点树中无重复的协议菜单');
    ok(allPaths.includes('/setting/prompt'), '节点树保留须知配置');


    console.log('\n[12] 订单增强与权限节点');
    const imp = await api('/admin/api/orders/import', {
      method: 'POST', token: at,
      body: { rows: [{ goods_id: 2, member_id: bid, price: 500, num: 4 }] },
    });
    ok(imp.code === 1 && imp.data?.okCount === 1, '批量导入订单', imp.msg);
    const impOid = imp.data?.created?.[0]?.order_id;

    const badImp = await api('/admin/api/orders/import', {
      method: 'POST', token: at, body: { rows: [{ goods_id: 999999, member_id: bid }] },
    });
    ok(badImp.data?.failCount === 1 && /商品不存在/.test(badImp.data.errors[0].msg), '导入失败行返回原因');

    const sp = await api('/admin/api/orders/split', {
      method: 'POST', token: at, body: { order_id: impOid, split_num: 2 },
    });
    ok(sp.code === 1 && sp.data?.per === 2, '后台拆分订单', sp.msg);
    const splitRows = db.prepare("SELECT COUNT(*) c FROM orders WHERE remark LIKE '由订单%拆分'").get().c;
    ok(splitRows >= 1, '拆分后生成新订单', `${splitRows} 笔`);

    const tm = await api('/admin/api/member/team-orders?member_id=1', { token: at });
    ok(tm.code === 1 && tm.data?.team_count >= 1, '团队订单视图', `团队 ${tm.data?.team_count} 人 / ${tm.data?.order_count} 单`);

    const gb = await api('/admin/api/orders/set-goods-order', {
      method: 'POST', token: at, body: { goods_id: 2, member_id: bid, price: 800 },
    });
    ok(gb.code === 1, '后台创建寄买订单', gb.msg);
    const gbRow = db.prepare('SELECT type FROM orders WHERE order_id = ?').get(gb.data.order_id);
    eq(gbRow.type, 4, '寄买订单类型为 4');

    const nt = await api('/admin/api/node/tree', { token: at });
    ok(nt.code === 1 && (nt.data?.tree?.length || 0) >= 5, '节点树读取', `${nt.data?.tree?.length} 组`);
    eq(nt.data.super_role_id, 6, '超级管理员角色ID为 6');

    // 取一个真实存在的非超级管理员角色（角色表与会员等级已分离，旧 role_id=2 不再存在）
    const opRole = db.prepare('SELECT role_id FROM store_role WHERE role_id <> 6 ORDER BY role_id LIMIT 1').get();
    ok(!!opRole && opRole.role_id >= 6, '存在可配置的运营角色', `role_id=${opRole?.role_id}`);
    const opRoleId = opRole.role_id;

    const grp = nt.data.tree.find((x) => x.name === '产品管理');
    const saveRn = await api('/admin/api/role/nodes', {
      method: 'POST', token: at,
      body: { role_id: opRoleId, node_ids: [grp.id, ...grp.children.map((c) => c.id)] },
    });
    ok(saveRn.code === 1, '角色权限保存成功', saveRn.msg);
    const rn = await api(`/admin/api/role/nodes?role_id=${opRoleId}`, { token: at });
    ok((rn.data?.node_ids || []).length >= 2, '角色节点已保存', `${rn.data?.node_ids?.length} 个`);

    const badRn = await api('/admin/api/role/nodes', {
      method: 'POST', token: at, body: { role_id: 999999, node_ids: [1] },
    });
    ok(badRn.code === 0, '不存在的角色拒绝保存权限', badRn.msg);

    const superPaths = await api('/admin/api/my-paths', { token: at });
    ok(superPaths.data?.unrestricted === true, '超级管理员不受权限限制');

    await api('/admin/api/storeuser/save', {
      method: 'POST', token: at,
      body: { user_name: 't_op', password: '123456', nick_name: '测试运营', role_id: opRoleId, status: 10 },
    });
    const tOp = (await api('/admin/api/login', { method: 'POST', body: { user_name: 't_op', password: '123456' } })).data?.token;
    ok(!!tOp, '受限账号可登录');
    const tOpId = db.prepare("SELECT store_user_id FROM store_user WHERE user_name = 't_op'").get().store_user_id;
    const resetAdminPwd = await api('/admin/api/storeuser/save', {
      method: 'POST', token: at,
      body: { store_user_id: tOpId, user_name: 't_op', password: '654321', nick_name: '测试运营', role_id: opRoleId, status: 10 },
    });
    ok(resetAdminPwd.code === 1 && !!(await api('/admin/api/login', { method: 'POST', body: { user_name: 't_op', password: '654321' } })).data?.token,
      '后台管理员可通过编辑表单修改登录密码', resetAdminPwd.msg);
    const mp = await api('/admin/api/my-paths', { token: tOp });
    ok(mp.data?.unrestricted === false, '受限角色返回明确权限集合');
    ok((mp.data?.paths || []).includes('/goods'), '权限集合包含已分配的菜单', JSON.stringify(mp.data?.paths));

    const restrictedMemberList = await api('/admin/api/member/list', { token: tOp });
    ok(restrictedMemberList.httpStatus === 403, '受限角色直接调用未授权会员接口被服务端拒绝', String(restrictedMemberList.httpStatus));
    const restrictedOrderList = await api('/admin/api/orders/list', { token: tOp });
    ok(restrictedOrderList.httpStatus === 403, '受限角色不能省略订单类型读取全部订单', String(restrictedOrderList.httpStatus));
    const restrictedAdvance = await api('/admin/api/member/advance', {
      method: 'POST', token: tOp, body: { member_id: 1, enable: true, count: 3 },
    });
    ok(restrictedAdvance.httpStatus === 403, '受限角色不能直接调用未授权会员操作接口', String(restrictedAdvance.httpStatus));

    const secretList = await api('/admin/api/member/list?limit=10', { token: at });
    const secretRow = secretList.data?.data?.[0] || {};
    ok(!['password', 'pay_password', 'pay_setting', 'open_id', 'idcard', 'sign_image', 'child_id', 'path'].some((k) => k in secretRow), '会员列表不会返回密码及账户配置字段');
    const secretDetail = await api(`/admin/api/member/detail?id=${secretRow.member_id}`, { token: at });
    ok(secretDetail.code === 1 && !['password', 'pay_password', 'pay_setting', 'open_id'].some((k) => k in (secretDetail.data || {})), '会员详情不会返回密码或收款配置');
    const adminRows = await api('/admin/api/storeuser/list?limit=10', { token: at });
    ok(!(adminRows.data?.data?.[0] && 'password' in adminRows.data.data[0]), '管理员列表不会返回密码哈希');
    const modules = await api('/admin/api/modules', { token: at });
    const goodsStatusField = modules.data?.find((x) => x.key === 'goods')?.fields?.find((x) => x.k === 'goods_status');
    ok(goodsStatusField?.type === 'select' && Object.keys(goodsStatusField.opts || {}).length === 3,
      '商品状态编辑元数据提供上架、下架、流拍三态选择');

    const newMember = await api('/admin/api/member/save', {
      method: 'POST', token: at,
      body: { mobile: '13912345678', password: 'first123', nick_name: '后台创建会员', p_id: bid },
    });
    ok(newMember.code === 1, '后台新增会员提交密码后创建成功', newMember.msg);
    const newMemberId = newMember.data?.id;
    const newMemberPath = db.prepare('SELECT path FROM member WHERE member_id = ?').get(newMemberId)?.path;
    ok(newMemberPath === `${db.prepare('SELECT path FROM member WHERE member_id = ?').get(bid).path}${bid}/`, '新增会员自动加入所选上级团队路径');
    ok(!!(await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13912345678', password: 'first123' } })).data?.token, '后台创建会员的密码可用于登录');
    await api('/admin/api/member/save', { method: 'POST', token: at, body: { member_id: newMemberId, password: 'second123' } });
    ok(!!(await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13912345678', password: 'second123' } })).data?.token, '后台可修改会员登录密码');
    const deleteOrder = await api('/admin/api/orders/remove', { method: 'POST', token: at, body: { ids: [impOid] } });
    ok(deleteOrder.code === 0 && db.prepare('SELECT 1 FROM orders WHERE order_id = ?').get(impOid), '通用删除接口拒绝删除订单并保留记录');
    const originalOrderStatus = db.prepare('SELECT status FROM orders WHERE order_id = ?').get(impOid).status;
    const editOrderDirectly = await api('/admin/api/orders/save', { method: 'POST', token: at, body: { order_id: impOid, status: 30 } });
    ok(editOrderDirectly.code === 0 && db.prepare('SELECT status FROM orders WHERE order_id = ?').get(impOid).status === originalOrderStatus,
      '通用保存接口拒绝绕过流程修改订单状态');

    // 菜单单一数据源 + 按权限下发
    const mn = await api('/admin/api/menu', { token: at });
    const menuPaths = (mn.data?.menus || []).flatMap((g) => g.items.map((i) => i.path));
    ok((mn.data?.menus || []).length >= 5, '菜单接口返回分组', `${mn.data?.menus?.length} 组`);
    ok(menuPaths.includes('/goods') && menuPaths.includes('/shop-goods'), '菜单含抢购商品与商城商品');
    ok(!!mn.data?.menus?.[0]?.items?.[0]?.icon, '菜单项带图标');

    const opMenu = await api('/admin/api/menu', { token: tOp });
    const opPaths = (opMenu.data?.menus || []).flatMap((g) => g.items.map((i) => i.path));
    ok(opPaths.length > 0 && opPaths.length < menuPaths.length, '受限账号菜单已按权限裁剪', `${opPaths.length}/${menuPaths.length}`);

    // 商品按类型分离
    const gList1 = await api('/admin/api/goods/list?type=1&limit=50', { token: at });
    const gList2 = await api('/admin/api/goods/list?type=2&limit=50', { token: at });
    ok((gList1.data?.data || []).every((x) => x.type === 1), '抢购商品列表只含 type=1', `${gList1.data?.total} 件`);
    ok((gList2.data?.data || []).every((x) => x.type === 2), '商城商品列表只含 type=2', `${gList2.data?.total} 件`);

    const wrongGoodsType = await api('/admin/api/goods/list?type=99', { token: tOp });
    ok(wrongGoodsType.httpStatus === 403, '商品接口拒绝未定义商品类型的权限绕过', String(wrongGoodsType.httpStatus));

    // 后台角色与会员等级已分离
    const roles = db.prepare('SELECT role_id, role_name FROM store_role').all();
    ok(roles.length <= 3 && roles.every((r) => r.role_id >= 6), '后台角色表不再混入会员等级');
    ok(db.prepare('SELECT COUNT(*) c FROM member_grade').get().c === 5, '会员等级独立存放于 member_grade');

    // 孤儿权限绑定清理：指向已不存在角色的记录必须被清掉
    db.prepare('INSERT OR IGNORE INTO store_role_node (role_id, node_id) VALUES (?,?)').run(88888, 1);
    ok(db.prepare('SELECT COUNT(*) c FROM store_role_node WHERE role_id = 88888').get().c === 1, '已植入孤儿权限绑定');
    const { ensureNodes } = await import('../src/lib/nodes.js');
    ensureNodes();
    ok(
      db.prepare('SELECT COUNT(*) c FROM store_role_node WHERE role_id NOT IN (SELECT role_id FROM store_role)').get().c === 0,
      '孤儿角色权限被清理',
    );

    const superTry = await api('/admin/api/role/nodes', {
      method: 'POST', token: at, body: { role_id: 6, node_ids: [1] },
    });
    ok(superTry.code === 0, '超级管理员权限不可被修改', superTry.msg);

    console.log('\n[13] 抢单服务费（后台可配置，买家额外承担，卖家仍收全额）');
    const scGet = async () =>
      Number((await api('/admin/api/setting/trade', { token: at })).data?.values?.service_charge ?? -1);
    const scSet = async (v) =>
      api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: String(v) } } });

    // 后台必须有这个入口，否则「功能接进去了但没地方配」
    const tradeItems = (await api('/admin/api/setting/trade', { token: at })).data?.items || [];
    ok(tradeItems.some((i) => i.k === 'service_charge'), '后台交易设置含抢单服务费入口');
    const defaultSvc = await scGet();
    ok(defaultSvc >= 0, '抢单服务费默认值可读', `${defaultSvc}%`);

    // 下面这段要验证「费率 0 时不收费」，先显式置 0，不依赖 seed 默认值
    await scSet(0);
    eq(await scGet(), 0, '抢单服务费可置 0');

    // 找一个买家不是持有人的可抢购商品
    const buyerId2 = db.prepare("SELECT member_id id FROM member WHERE mobile='13822367845'").get().id;
    const goods2 = db.prepare(
      'SELECT goods_id, goods_min_price FROM goods WHERE goods_status = 10 AND type = 1 AND member_id <> ? LIMIT 1',
    ).get(buyerId2);
    ok(!!goods2, '找到可用于服务费测试的商品');
    const gp = Number(goods2.goods_min_price);

    // 默认 0：下单与报价都不应产生服务费
    const q0 = await api(`/api/order/getServiceCharge?goods_id=${goods2.goods_id}&num=2`, { token: buyer });
    eq(q0.data?.service_charge, 0, '费率 0 时报价服务费为 0');
    eq(q0.data?.pay_total, money(gp * 2).toFixed(2), '费率 0 时实付 = 商品总额');

    await scSet(5);
    eq(await scGet(), 5, '后台保存服务费费率后可回读');

    // 报价（多件）必须与下单同一口径：按「单价×数量」算，不是按单价算
    const q = await api(`/api/order/getServiceCharge?goods_id=${goods2.goods_id}&num=2`, { token: buyer });
    const total2 = money(gp * 2);
    eq(q.data?.rate, 5, '报价返回费率');
    eq(q.data?.total_price, total2.toFixed(2), '报价按 单价×数量 计算总额');
    eq(q.data?.service_charge, money(total2 * 0.05).toFixed(2), `报价服务费 = ${total2} × 5%`);
    eq(q.data?.pay_total, money(total2 * 1.05).toFixed(2), '报价实付 = 总额 + 服务费');

    // 商品详情返回的费率要同源，否则确认订单页显示的费率与实际扣款对不上
    const gd = await api(`/api/goods/getLootDetails?goods_id=${goods2.goods_id}`, { token: buyer });
    eq(gd.data?.service_charge_rate, 5, '商品详情费率与后台配置同源');

    const sellerBal0 = Number((await detail(seller)).amount);
    const b2 = await api('/api/order/toAddOrder', {
      method: 'POST', token: buyer, body: { goods_id: goods2.goods_id, num: 2, pay_type: 1 },
    });
    ok(b2.code === 1, '带服务费下单成功', b2.msg);
    eq(b2.data?.service_charge, money(total2 * 0.05), '下单落库服务费 = 总额 × 5%');
    const oid2 = b2.data.order_id;
    const row2 = db.prepare('SELECT total_price, service_charge FROM orders WHERE order_id = ?').get(oid2);
    eq(row2.service_charge, money(row2.total_price * 0.05), '订单表服务费与费率吻合');

    const buyerBefore = Number((await detail(buyer)).amount);
    const pay2 = await api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: oid2, pay_type: 1 } });
    ok(pay2.code === 1, '带服务费订单支付成功', pay2.msg);
    const buyerAfter = Number((await detail(buyer)).amount);
    eq(buyerBefore - buyerAfter, money(row2.total_price + row2.service_charge),
      `买家实付 = 商品 ${row2.total_price} + 服务费 ${row2.service_charge}`);

    const sellerBal1 = Number((await detail(seller)).amount);
    const isSeller = (await api('/api/member/getMemberDetails', { token: seller })).data?.member_id
      === db.prepare('SELECT seller_id s FROM orders WHERE order_id = ?').get(oid2).s;
    if (isSeller) {
      eq(sellerBal1 - sellerBal0, row2.total_price, '卖家到账仍是商品全额（服务费不进卖家口袋）');
    }

    // 恢复默认 0，确认不会残留、也不会破坏「抢购不收费」的实证口径
    await scSet(0);
    eq(await scGet(), 0, '恢复默认费率 0');
    const goods3 = db.prepare(
      'SELECT goods_id FROM goods WHERE goods_status = 10 AND type = 1 AND member_id <> ? LIMIT 1',
    ).get(buyerId2);
    if (goods3) {
      const b3 = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer, body: { goods_id: goods3.goods_id, num: 1, pay_type: 1 },
      });
      ok(b3.code === 1, '恢复 0 后仍可下单', b3.msg);
      eq(b3.data?.service_charge, 0, '恢复 0 后下单不再收服务费');
    }

    if (!KEEP_SCHEDULE) db.prepare("UPDATE goods SET area_date = ''").run(); // 本段只测口径，清掉日程
    console.log('\n[14] 转拍自动涨价（逐轮复利，卖家收回全额）');
    const incOf = () => Number(
      db.prepare("SELECT `value` v FROM setting_config WHERE `key`='price_increase_rate'").get()?.v ?? 0,
    );
    const setInc = async (v) => api('/admin/api/setting/save', {
      method: 'POST', token: at, body: { group: 'trade', values: { price_increase_rate: String(v) } },
    });
    ok(incOf() > 0, '转拍涨价率已配置', `${incOf()}%`);
    const tradeItems3 = (await api('/admin/api/setting/trade', { token: at })).data?.items || [];
    ok(tradeItems3.some((i) => i.k === 'price_increase_rate'), '后台交易设置含转拍涨价率入口');

    const inc = incOf() / 100;
    const A = await login('13800000001');
    const B = await login('13800000004');
    const idA = db.prepare("SELECT member_id id FROM member WHERE mobile='13800000001'").get().id;
    const idB = db.prepare("SELECT member_id id FROM member WHERE mobile='13800000004'").get().id;
    for (const id of [idA, idB]) {
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: id, field: 'amount', value: 500000, remark: '涨价测试注资' },
      });
    }

    const gw = db.prepare(
      `SELECT goods_id, goods_min_price FROM goods
       WHERE goods_status = 10 AND type = 1 AND IFNULL(is_split, 0) = 0 AND member_id NOT IN (?, ?)
       ORDER BY goods_id LIMIT 1`,
    ).get(idA, idB);
    ok(!!gw, '找到可用商品（持有人既非 A 也非 B）');
    const P0 = Number(gw.goods_min_price);
    const P1 = money(P0 * (1 + inc));
    const P2 = money(P1 * (1 + inc));

    // 第 1 轮：A 抢下
    const oA = await api('/api/order/toAddOrder', {
      method: 'POST', token: A, body: { goods_id: gw.goods_id, num: 1, pay_type: 1 },
    });
    ok(oA.code === 1, 'A 抢下商品', oA.msg);
    eq(oA.data.total_price, P0, `A 成交价 = 当前标价 ${P0}`);
    await api('/api/order/toPay', { method: 'POST', token: A, body: { order_id: oA.data.order_id, pay_type: 1 } });

    // 报价即自动涨价
    const qA = await api(`/api/order/getConsignmentQuote?order_id=${oA.data.order_id}`, { token: A });
    ok(qA.code === 1, '转拍报价可读', qA.msg);
    eq(qA.data?.prev_price, P0, '报价带出上一手成交价');
    eq(qA.data?.next_price, P1, `自动涨价：${P0} → ${P1}`);
    eq(qA.data?.increase_amount, money(P1 - P0), '报价给出涨价金额');

    const cA = await api('/api/order/consignment', { method: 'POST', token: A, body: { order_id: oA.data.order_id } });
    ok(cA.code === 1, 'A 转拍成功（无需手填价格）', cA.msg);
    eq(cA.data?.next_price, P1, '转拍返回下一轮标价');
    eq(
      db.prepare('SELECT goods_min_price p FROM goods WHERE goods_id = ?').get(gw.goods_id).p,
      P1, '商品标价已自动更新为下一轮价格',
    );

    // 第 2 轮：B 拍走涨价商品 → A 收回「原价 + 涨价」全额
    const aBefore = Number((await detail(A)).amount);
    const oB = await api('/api/order/toAddOrder', {
      method: 'POST', token: B, body: { goods_id: gw.goods_id, num: 1, pay_type: 1 },
    });
    ok(oB.code === 1, 'B 拍下涨价后的商品', oB.msg);
    eq(oB.data.total_price, P1, `B 成交价 = ${P1}`);
    await api('/api/order/toPay', { method: 'POST', token: B, body: { order_id: oB.data.order_id, pay_type: 1 } });
    const aAfter = Number((await detail(A)).amount);
    eq(money(aAfter - aBefore), P1, `A 收回 ${P1} 全额（原价 ${P0} + 涨价 ${money(P1 - P0)}）`);

    // A 的订单已转拍，商品与 A 再无关系
    const holderNow = db.prepare('SELECT member_id m FROM goods WHERE goods_id = ?').get(gw.goods_id).m;
    eq(holderNow, idB, '转拍成交后持有人变为 B，与 A 无关');

    // 第 3 轮：B 转拍，逐轮复利；前端篡改价格应被忽略
    const cB = await api('/api/order/consignment', {
      method: 'POST', token: B, body: { order_id: oB.data.order_id, price: 1 },
    });
    ok(cB.code === 1, 'B 转拍成功（前端故意传 1 元）', cB.msg);
    eq(cB.data?.next_price, P2, `逐轮复利：${P1} → ${P2}，前端传价被忽略`);
    eq(
      db.prepare('SELECT goods_min_price p FROM goods WHERE goods_id = ?').get(gw.goods_id).p,
      P2, '商品标价按复利更新',
    );

    // 涨价率置 0 → 退回原价挂牌
    const oA2 = await api('/api/order/toAddOrder', {
      method: 'POST', token: A, body: { goods_id: gw.goods_id, num: 1, pay_type: 1 },
    });
    ok(oA2.code === 1, 'A 再次买入进入下一轮', oA2.msg);
    await setInc(0);
    eq(incOf(), 0, '涨价率可关闭');
    const qZero = await api(`/api/order/getConsignmentQuote?order_id=${oA2.data.order_id}`, { token: A });
    eq(qZero.data?.next_price, P2, '关闭涨价后按原价挂牌');
    eq(qZero.data?.increase_amount, 0, '关闭涨价后无涨价金额');
    await setInc(3);
    eq(incOf(), 3, '涨价率恢复 3%');

    if (!KEEP_SCHEDULE) db.prepare("UPDATE goods SET area_date = ''").run(); // 本段只测口径，清掉日程
    console.log('\n[15] 我的店铺 + 平台回收');

    // ---------- 我的店铺：预计收益口径 ----------
    // 造一个明确的状态：会员 A 持有一件在售商品，且有一笔买入订单
    const shopOwner = db.prepare("SELECT member_id id, mobile FROM member WHERE mobile='13800000001'").get();
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: shopOwner.id, field: 'amount', value: 300000, remark: '店铺测试注资' },
    });
    const shopGoods = db.prepare(
      `SELECT g.goods_id, g.goods_min_price FROM goods g
       WHERE g.goods_status = 10 AND g.type = 1 AND IFNULL(g.is_split,0) = 0 AND g.member_id <> ?
       ORDER BY g.goods_id DESC LIMIT 1`,
    ).get(shopOwner.id);
    ok(!!shopGoods, '找到可用于店铺测试的商品');

    const shopBuy = await api('/api/order/toAddOrder', {
      method: 'POST', token: A, body: { goods_id: shopGoods.goods_id, num: 1, pay_type: 1 },
    });
    ok(shopBuy.code === 1, '店铺测试：买入商品', shopBuy.msg);
    await api('/api/order/toPay', { method: 'POST', token: A, body: { order_id: shopBuy.data.order_id, pay_type: 1 } });

    // 此时 A 持有、未挂牌
    const shop1 = await api('/api/member/myShop', { token: A });
    ok(shop1.code === 1, '我的店铺接口可读', shop1.msg);
    const shopRow1 = (shop1.data?.list || []).find((x) => x.goods_id === shopGoods.goods_id);
    ok(!!shopRow1, '店铺里能看到自己持有的在售商品');
    eq(shopRow1?.listed, false, '未转拍时标记为待上架');
    const myPrice = Number(shopRow1?.my_price || 0);
    const next1 = Number(shopRow1?.next_price || 0);
    eq(myPrice, shopBuy.data.total_price, '我的买入价取订单成交价');
    eq(next1, money(myPrice * (1 + inc)), '未挂牌时下一轮标价按涨价率预估');
    eq(shopRow1?.est_net, money(next1 - myPrice - Number(shopRow1?.listing_fee || 0)), '预计净收益 = 下一轮价 − 买入价 − 上架费');

    // 转拍后应为「已挂牌」，且下一轮标价取商品现标价
    await api('/api/order/consignment', { method: 'POST', token: A, body: { order_id: shopBuy.data.order_id } });
    const shop2 = await api('/api/member/myShop', { token: A });
    const shopRow2 = (shop2.data?.list || []).find((x) => x.goods_id === shopGoods.goods_id);
    eq(shopRow2?.listed, true, '转拍后标记为已挂牌');
    eq(shopRow2?.next_price, money(myPrice * (1 + inc)), '已挂牌时下一轮标价 = 商品现标价');

    // 别人买走 → 从我的店铺消失
    const shopBuyer2 = await api('/api/member/accountLogin', {
      method: 'POST', body: { phone: '13800000004', password: '13800000004' },
    });
    const buyer2Token = shopBuyer2.data?.token;
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: idB, field: 'amount', value: 300000, remark: '店铺测试注资' },
    });
    const takeIt = await api('/api/order/toAddOrder', {
      method: 'POST', token: buyer2Token, body: { goods_id: shopGoods.goods_id, num: 1, pay_type: 1 },
    });
    ok(takeIt.code === 1, '他人买走店铺商品', takeIt.msg);
    // 归属转移发生在支付结算时，不付款不算买走
    await api('/api/order/toPay', { method: 'POST', token: buyer2Token, body: { order_id: takeIt.data.order_id, pay_type: 1 } });
    eq(
      db.prepare('SELECT member_id m FROM goods WHERE goods_id = ?').get(shopGoods.goods_id).m,
      idB, '支付后商品持有人变为买家',
    );
    const shop3 = await api('/api/member/myShop', { token: A });
    ok(
      !(shop3.data?.list || []).some((x) => x.goods_id === shopGoods.goods_id),
      '商品被抢走后从我的店铺消失',
    );

    // ---------- 平台回收 ----------
    // 先制造一条流拍单：找一个挂在架上没卖掉的，回填时间后扫描
    const rec = db.prepare(
      `SELECT o.order_id, o.goods_id, o.member_id FROM orders o JOIN goods g ON g.goods_id = o.goods_id
       WHERE o.type = 1 AND o.status IN (10,30) AND g.member_id = o.member_id AND g.goods_status = 10
       ORDER BY o.order_id DESC LIMIT 1`,
    ).get();
    ok(!!rec, '找到可构造流拍的商品');
    db.prepare("UPDATE orders SET consignment_status = 10, transposition_time = '2026-10-27 10:00:00' WHERE order_id = ?")
      .run(rec.order_id);
    const recScan = await api('/admin/api/streambeat/scan', {
      method: 'POST', token: at, body: { date: '2026-10-27' },
    });
    ok(recScan.code === 1, '回收测试：先造出流拍单', recScan.msg);
    const lOrder2 = db.prepare('SELECT * FROM orders WHERE type = 5 AND goods_id = ? ORDER BY order_id DESC LIMIT 1')
      .get(rec.goods_id);
    ok(!!lOrder2 && Number(lOrder2.status) === 50, '流拍单已生成待回收');

    const listPrice = Number(db.prepare('SELECT goods_min_price p FROM goods WHERE goods_id = ?').get(rec.goods_id).p);
    const ownerRow0 = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(rec.member_id).amount);
    const recycl = await api('/admin/api/streambeat/recycle', {
      method: 'POST', token: at, body: { order_id: lOrder2.order_id },
    });
    ok(recycl.code === 1, '平台回收成功', recycl.msg);
    eq(recycl.data?.price, listPrice, `回收价 = 挂牌价 ${listPrice}`);

    const ownerRow1 = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(rec.member_id).amount);
    eq(money(ownerRow1 - ownerRow0), listPrice, '回收款已打给原持有人');

    const recGoods = db.prepare('SELECT member_id, goods_status FROM goods WHERE goods_id = ?').get(rec.goods_id);
    eq(recGoods.member_id, 0, '商品转为平台持仓（持有人置空）');
    eq(recGoods.goods_status, 20, '回收后商品下架');
    eq(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(lOrder2.order_id).status, 70, '流拍单置为已回收');

    const flow = db.prepare(
      "SELECT face_value FROM finance_energy WHERE member_id = ? AND type_name = '平台回收' ORDER BY energy_id DESC LIMIT 1",
    ).get(rec.member_id);
    eq(flow?.face_value, listPrice, '生成平台回收资金流水');

    const recycl2 = await api('/admin/api/streambeat/recycle', {
      method: 'POST', token: at, body: { order_id: lOrder2.order_id },
    });
    ok(recycl2.code === 0, '同一流拍单不可重复回收', recycl2.msg);

    // 平台持仓商品可重新上架并被会员买走（无人收款）
    db.prepare('UPDATE goods SET goods_status = 10 WHERE goods_id = ?').run(rec.goods_id);
    const relist = await api('/api/order/toAddOrder', {
      method: 'POST', token: buyer2Token, body: { goods_id: rec.goods_id, num: 1, pay_type: 1 },
    });
    ok(relist.code === 1, '平台持仓商品可重新上架并被购买', relist.msg);

    console.log('\n[16] 注册邀请码开关');
    const inviteCfg = async () =>
      (await api('/admin/api/setting/trade', { token: at })).data?.values?.require_invite_code;
    const setInvite = async (v) =>
      api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { require_invite_code: String(v) } } });

    const tradeItems2 = (await api('/admin/api/setting/trade', { token: at })).data?.items || [];
    ok(tradeItems2.some((i) => i.k === 'require_invite_code'), '后台交易设置含邀请码开关');
    eq(await inviteCfg(), 10, '邀请码开关默认开启');

    const inviter = db.prepare("SELECT invitation_code c FROM member WHERE mobile='13800000001'").get().c;

    // 开启时：不填邀请码被拒
    const noCodeOn = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13977770001', password: '123456' },
    });
    ok(noCodeOn.code === 0 && /邀请码/.test(noCodeOn.msg), '开启时无邀请码被拒', noCodeOn.msg);

    // 关闭时：可无邀请码注册，且不绑定上级
    await setInvite(20);
    eq(await inviteCfg(), 20, '邀请码开关可关闭');
    const noCodeOff = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13977770001', password: '123456', nickName: '无邀请码用户' },
    });
    ok(noCodeOff.code === 1, '关闭时无邀请码可注册', noCodeOff.msg);
    const freeId = noCodeOff.data?.member_id;
    const freeRow = db.prepare('SELECT p_id, path, level, invitation_code FROM member WHERE member_id = ?').get(freeId);
    eq(freeRow.p_id, 0, '无邀请码注册无上级');
    ok(freeRow.path === '/', '无邀请码注册为根节点 path=/', String(freeRow.path));
    eq(freeRow.level, 1, '无邀请码注册 level=1');
    ok((freeRow.invitation_code || '').length > 0, '无邀请码注册也会生成自己的邀请码', freeRow.invitation_code);

    // 关闭时：填了无效邀请码仍要拦，避免用户以为绑上了
    const badCodeOff = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13977770002', password: '123456', code: 'ZZZZZZ' },
    });
    ok(badCodeOff.code === 0 && /邀请码不存在/.test(badCodeOff.msg), '关闭时填错邀请码仍报错', badCodeOff.msg);

    // 关闭时：填了有效邀请码照常绑定
    const withCodeOff = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13977770003', password: '123456', code: inviter },
    });
    ok(withCodeOff.code === 1, '关闭时填有效邀请码可注册', withCodeOff.msg);
    const boundRow = db.prepare('SELECT p_id FROM member WHERE member_id = ?').get(withCodeOff.data?.member_id);
    ok(Number(boundRow.p_id) > 0, '关闭时填邀请码仍会绑定上级', String(boundRow.p_id));

    // 前端下发字段与开关一致
    const regCfgOn = await api('/api/index/getRegisterAgreements');
    eq(regCfgOn.data?.require_invite_code, '0', 'H5 下发开关状态（关闭=0）');
    await setInvite(10);
    eq(await inviteCfg(), 10, '邀请码开关恢复开启');
    eq((await api('/api/index/getRegisterAgreements')).data?.require_invite_code, '1', 'H5 下发开关状态（开启=1）');

    console.log('\n[17] 一级分销：终身绑定 + 后台可改绑');
    // 平级奖已下线，配置组里不应再出现
    const tradeItems3b = (await api('/admin/api/setting/trade', { token: at })).data?.items || [];
    ok(!tradeItems3b.some((i) => i.k === 'same_level_award_rate'), '交易设置已移除平级奖');
    ok(
      !('same_level_award_rate' in ((await api('/api/index/getTradeConfig')).data || {})),
      '前台交易配置不再下发平级奖',
    );
    ok(db.prepare("SELECT COUNT(*) c FROM setting_config WHERE `key`='same_level_award_rate'").get().c === 0,
      '库中已无平级奖配置');

    // 上级1 = 现有会员1，注册下线 X，再用 X 的邀请码注册 Y
    const inviterCode = db.prepare("SELECT invitation_code c FROM member WHERE member_id = 1").get().c;
    const regX = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13988880001', password: '123456', code: inviterCode, nickName: '一级下线X' },
    });
    ok(regX.code === 1, '注册会员 X', regX.msg);
    const xId = regX.data.member_id;
    const xCode = db.prepare('SELECT invitation_code c FROM member WHERE member_id = ?').get(xId).c;
    const regY = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13988880002', password: '123456', code: xCode, nickName: '二级下线Y' },
    });
    ok(regY.code === 1, '用 X 的邀请码注册会员 Y', regY.msg);
    const yId = regY.data.member_id;
    const yToken = regY.data.token;

    // 终身绑定：注册即定，二层关系正确
    const xRow = db.prepare('SELECT p_id, path, level FROM member WHERE member_id = ?').get(xId);
    const yRow = db.prepare('SELECT p_id, path, level FROM member WHERE member_id = ?').get(yId);
    eq(xRow.p_id, 1, 'X 绑定上级为会员1');
    eq(yRow.p_id, xId, 'Y 绑定上级为 X');
    eq(yRow.level, Number(xRow.level) + 1, 'Y 层级 = X 层级 + 1');
    ok(String(yRow.path).startsWith(String(xRow.path)), 'Y 的 path 位于 X 之下');

    // 会员端不能自己改上级
    await api('/api/member/editMember', { method: 'POST', token: yToken, body: { nickName: '改名Y', p_id: 2 } });
    eq(db.prepare('SELECT p_id FROM member WHERE member_id = ?').get(yId).p_id, xId, '会员端改不了上级（p_id 被忽略）');

    // 后台改绑：把 Y 挂到会员2 名下
    const rebind = await api('/admin/api/member/save', {
      method: 'POST', token: at, body: { member_id: yId, p_id: 2 },
    });
    ok(rebind.code === 1, '后台可改绑上级', rebind.msg);
    const yAfter = db.prepare('SELECT p_id, path, level FROM member WHERE member_id = ?').get(yId);
    const newParent = db.prepare('SELECT path, level, child_id FROM member WHERE member_id = 2').get();
    eq(yAfter.p_id, 2, '改绑后上级为会员2');
    ok(String(yAfter.path) === `${newParent.path}2/`, '改绑后 path 同步', String(yAfter.path));
    eq(yAfter.level, Number(newParent.level) + 1, '改绑后 level 同步');
    ok(String(newParent.child_id || '').split(',').includes(String(yId)), '新上级的 child_id 包含 Y');
    const oldParentChild = db.prepare('SELECT child_id FROM member WHERE member_id = ?').get(xId).child_id;
    ok(!String(oldParentChild || '').split(',').includes(String(yId)), '旧上级的 child_id 已移除 Y');

    // 不能挂到自己团队下
    const cycle = await api('/admin/api/member/save', {
      method: 'POST', token: at, body: { member_id: 2, p_id: yId },
    });
    ok(cycle.code === 0, '禁止把会员挂到自己团队下（防环）', cycle.msg);

    // 改绑后新订单的佣金应发给「新上级」
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: yId, field: 'amount', value: 200000, remark: '分销测试注资' },
    });
    const buyGid = db.prepare(
      'SELECT goods_id FROM goods WHERE goods_status = 10 AND type = 1 AND IFNULL(is_split,0) = 0 AND member_id <> ? LIMIT 1',
    ).get(yId)?.goods_id;
    ok(!!buyGid, '找到分销测试商品');
    const yOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: yToken, body: { goods_id: buyGid, num: 1, pay_type: 1 },
    });
    ok(yOrder.code === 1, 'Y 下单', yOrder.msg);
    await api('/api/order/toPay', { method: 'POST', token: yToken, body: { order_id: yOrder.data.order_id, pay_type: 1 } });
    const driveRow = db.prepare(
      "SELECT member_id, face_value FROM finance_energy WHERE type = 1 AND remarks LIKE ?",
    ).get(`%${yOrder.data.order_no}%`);
    ok(!!driveRow, '产生直推奖流水');
    eq(driveRow?.member_id, 2, '佣金发给改绑后的新上级（会员2）');
    const xAward = db.prepare(
      "SELECT COUNT(*) c FROM finance_energy WHERE type = 1 AND member_id = ? AND remarks LIKE ?",
    ).get(xId, `%${yOrder.data.order_no}%`).c;
    eq(xAward, 0, '旧上级 X 拿不到这笔佣金');

    console.log('\n[18] 会员管理：启用 / 禁用 / 删除');
    const memberStatus = async (ids, disabled) =>
      api('/admin/api/member/status', { method: 'POST', token: at, body: { ids, disabled } });
    const memberRemove = async (ids) =>
      api('/admin/api/member/remove', { method: 'POST', token: at, body: { ids } });
    const superCode = db.prepare("SELECT invitation_code c FROM member WHERE member_id = 1").get().c;

    // 注册一个干净账号用于启停用与删除
    const regU1 = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13955550001', password: '123456', code: superCode, nickName: '启停用测试' },
    });
    ok(regU1.code === 1, '注册测试账号 U1', regU1.msg);
    const u1Id = regU1.data.member_id;
    const u1Token = regU1.data.token;

    // 登录正常
    ok((await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13955550001', password: '123456' } })).code === 1,
      '禁用前可正常登录');
    ok((await api('/api/member/getMemberDetails', { token: u1Token })).code === 1, '禁用前旧 token 可用');

    // 禁用
    const dis = await memberStatus([u1Id], 20);
    ok(dis.code === 1 && dis.data?.count === 1, '禁用会员', dis.msg);
    eq(db.prepare('SELECT disabled FROM member WHERE member_id = ?').get(u1Id).disabled, 20, '禁用状态落库');
    const loginBlocked = await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13955550001', password: '123456' } });
    ok(loginBlocked.code === 0 && /禁用/.test(loginBlocked.msg), '禁用后无法登录', loginBlocked.msg);
    const tokenBlocked = await api('/api/member/getMemberDetails', { token: u1Token });
    eq(tokenBlocked.code, -1, '禁用后已登录的 token 立即失效');

    // 启用
    const en = await memberStatus([u1Id], 10);
    ok(en.code === 1, '启用会员', en.msg);
    eq(db.prepare('SELECT disabled FROM member WHERE member_id = ?').get(u1Id).disabled, 10, '启用状态落库');
    ok((await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13955550001', password: '123456' } })).code === 1,
      '启用后可重新登录');

    // 批量启停用
    const batchDis = await memberStatus([u1Id, yId], 20);
    eq(batchDis.data?.count, 2, '批量禁用 2 个账号');
    const batchEn = await memberStatus([u1Id, yId], 10);
    eq(batchEn.data?.count, 2, '批量启用 2 个账号');

    // 有订单的会员：不能删，提示改用禁用
    const yOrders = db.prepare('SELECT COUNT(*) c FROM orders WHERE member_id = ? OR seller_id = ?').get(yId, yId).c;
    ok(yOrders > 0, 'Y 名下有订单（构造前提）', `${yOrders} 笔`);
    const delY = await memberRemove([yId]);
    ok(delY.code === 0 && /订单/.test(delY.msg) && /禁用/.test(delY.msg), '有订单的会员不可删除，提示改用禁用', delY.msg);
    ok(!!db.prepare('SELECT 1 FROM member WHERE member_id = ?').get(yId), '被拒后会员仍在');

    // 有下级的会员：不能删（先把 Y 挂回 X 名下，构造「X 有下级」）
    await api('/admin/api/member/save', { method: 'POST', token: at, body: { member_id: yId, p_id: xId } });
    eq(db.prepare('SELECT p_id FROM member WHERE member_id = ?').get(yId).p_id, xId, 'Y 已挂回 X 名下');
    const delX = await memberRemove([xId]);
    ok(delX.code === 0 && /下级/.test(delX.msg), '有下级会员的不可删除', delX.msg);
    ok(!!db.prepare('SELECT 1 FROM member WHERE member_id = ?').get(xId), '被拒后 X 仍在');

    // 干净账号：可删，并从上级 child_id 移除
    const parentChildBefore = String(db.prepare('SELECT child_id FROM member WHERE member_id = 1').get().child_id || '');
    ok(parentChildBefore.split(',').includes(String(u1Id)), '删除前上级 child_id 含 U1');
    const delU1 = await memberRemove([u1Id]);
    ok(delU1.code === 1, '干净账号可删除', delU1.msg);
    ok(!db.prepare('SELECT 1 FROM member WHERE member_id = ?').get(u1Id), '删除后会员表中已无记录');
    const parentChildAfter = String(db.prepare('SELECT child_id FROM member WHERE member_id = 1').get().child_id || '');
    ok(!parentChildAfter.split(',').includes(String(u1Id)), '删除后上级 child_id 已移除 U1');

    // 混批：有记录的跳过，干净的删掉
    const regU2 = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13955550002', password: '123456', code: superCode, nickName: '混批测试' },
    });
    const mixed = await memberRemove([regU2.data.member_id, yId]);
    ok(mixed.code === 1 && mixed.data?.removed?.length === 1 && mixed.data?.skipped?.length === 1, '批量删除：干净的删掉、有记录的跳过',
      JSON.stringify(mixed.data));

    ok((await memberStatus([], 20)).code === 0, '空选择启停用被拒');
    ok((await memberRemove([])).code === 0, '空选择删除被拒');

  } finally {
    srv.kill();
    await sleep(300);
  }

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    console.log('\n失败项：');
    fails.forEach((f) => console.log(`  · ${f.name}  ${f.detail}`));
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
