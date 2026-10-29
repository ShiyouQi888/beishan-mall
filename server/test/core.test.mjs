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
    return res.json();
  };
  const login = async (phone) =>
    (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
  const detail = async (token) => (await api('/api/member/getMemberDetails', { token })).data;

  try {
    console.log('\n[1] 抢购分账（抢购不收费，卖家全额，上级拿 0.5% 直推奖）');
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
    eq(order.data.service_charge, 0, '抢购下单不收取服务费');

    const oid = order.data.order_id;
    const paid = await api('/api/order/toPay', { method: 'POST', token: buyer, body: { order_id: oid, pay_type: 1 } });
    ok(paid.code === 1, '余额支付成功', paid.msg);

    const b1 = await detail(buyer), s1 = await detail(seller), t1 = await detail(top);
    eq(Number(b0.amount) - Number(b1.amount), price, `买家支出 = 商品价 ${price}（无额外费用）`);
    eq(Number(s1.amount) - Number(s0.amount), price, `卖家实收 = 商品价全额 ${price}`);

    const driveExpect = money(price * 0.005);
    eq(Number(s1.e_card_number) - Number(s0.e_card_number), driveExpect,
      `直推奖 = ${price} × 0.5% = ${driveExpect}`);
    eq(Number(t1.e_card_number) - Number(t0.e_card_number), 0, '二级不参与分成（仅单级直推奖）');

    const ecard = await api('/api/member/getECardList', { token: seller });
    const hit = (ecard.data || []).find((x) => Math.abs(Number(x.face_value) - driveExpect) < 0.01);
    ok(!!hit, '佣金流水接口能查到该笔直推奖（type=3 返佣）',
      `返回 ${(ecard.data || []).length} 条`);

    const gAfter = await api('/api/goods/getLootDetails?goods_id=' + target.goods_id);
    ok(gAfter.data.holder === '北山', '商品持有人已转移', `实际 ${gAfter.data.holder}`);

    console.log('\n[2] 转拍上架（收 2.8% 上架费）');
    const rate = Number(db.prepare("SELECT `value` v FROM setting_config WHERE `key`='listing_fee_rate'").get().v);
    const feeExpect = money(price * rate / 100);
    const newPrice = money(price + 200);

    const before = await detail(buyer);
    const consign = await api('/api/order/consignment', {
      method: 'POST', token: buyer, body: { order_id: oid, price: newPrice },
    });
    ok(consign.code === 1, '转拍成功', consign.msg);
    eq(consign.data?.listing_fee, feeExpect, `上架费 = ${price} × ${rate}% = ${feeExpect}`);

    const after = await detail(buyer);
    eq(Number(before.amount) - Number(after.amount), feeExpect, '上架费从余额扣减');

    const g2 = await api('/api/goods/getLootDetails?goods_id=' + target.goods_id);
    eq(g2.data.goods_min_price, newPrice, `商品按新标价 ${newPrice} 重新上架`);
    ok(
      Number(g2.data.line_price) === 0 || Number(g2.data.line_price) > Number(g2.data.goods_min_price),
      '转拍后划线价不为零时必须高于现价',
      `现价 ${g2.data.goods_min_price} / 划线价 ${g2.data.line_price}`,
    );

    const co = db.prepare("SELECT * FROM orders WHERE goods_id = ? AND type = 2 ORDER BY order_id DESC LIMIT 1").get(target.goods_id);
    ok(!!co && co.seller_id === after.member_id, '生成寄卖挂单（卖家=原持有人，买家为空）');
    eq(co?.listing_fee, feeExpect, '寄卖单记录上架费');

    const net = money(feeExpect - driveExpect);
    console.log(`    商品价 ${price} / 上架费 ${feeExpect} / 直推奖 ${driveExpect} / 平台净收 ${net}`);
    ok(net > 0, '平台本轮净收入为正', `净收 ${net}`);

    
    console.log('\n[3] 场次结算与差价匹配');
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const settleRun = await api('/admin/api/settle/run', {
      method: 'POST', token: at, body: { specialarea_id: 0 },
    });
    ok(settleRun.code === 1, '触发场次结算', settleRun.msg);
    const batchId = settleRun.data?.batch_id;

    const accs = (await api(`/admin/api/settle/accounts?batch_id=${batchId}`, { token: at })).data || [];
    ok(accs.length >= 2, '中账记录已生成', `${accs.length} 条`);

    let balanceOk = true;
    let sumBuy = 0, sumSell = 0;
    for (const a of accs) {
      if (Math.abs(Number(a.balance) - (Number(a.consignment_amount) - Number(a.buy_amount))) > 0.011) balanceOk = false;
      sumBuy += Number(a.buy_amount);
      sumSell += Number(a.consignment_amount);
    }
    ok(balanceOk, '每条中账：差额 = 卖出 − 买入');
    eq(money(sumBuy), money(sumSell), '全场买入总额 == 卖出总额（买卖配平）');

    const matches = (await api(`/admin/api/settle/matches?batch_id=${batchId}`, { token: at })).data || [];
    ok(matches.length >= 1, '生成差价匹配付款单', `${matches.length} 笔`);

    const debtSum = accs.filter((a) => Number(a.balance) < 0).reduce((s, a) => s + -Number(a.balance), 0);
    const matchSum = matches.reduce((s, m) => s + Number(m.amount), 0);
    eq(money(matchSum), money(debtSum), '匹配总额 == 应付总额（应收应付配平）');

    // 付款方上传凭证 → 收款方确认
    const mt0 = matches[0];
    const voucherRes = await api('/api/order/settleVoucher', {
      method: 'POST', token: await login(db.prepare('SELECT mobile FROM member WHERE member_id = ?').get(mt0.payer_id).mobile),
      body: { match_id: mt0.match_id, voucher: '/uploads/test.png' },
    });
    ok(voucherRes.code === 1, '付款方上传转账凭证', voucherRes.msg);

    const confirmRes = await api('/api/order/settleConfirm', {
      method: 'POST', token: await login(db.prepare('SELECT mobile FROM member WHERE member_id = ?').get(mt0.payee_id).mobile),
      body: { match_id: mt0.match_id },
    });
    ok(confirmRes.code === 1, '收款方确认收款', confirmRes.msg);

    const done = db.prepare('SELECT pay_status FROM settle_match WHERE match_id = ?').get(mt0.match_id);
    eq(done.pay_status, 20, '付款单状态流转至已完成');

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
      ok(over.code === 0 && /库存不足/.test(over.msg), '超过库存被拒单', over.msg);
    }

    console.log('\n[9] 流拍');
    const pending = db.prepare(
      "SELECT * FROM orders WHERE type = 2 AND status = 0 AND seller_id = ? LIMIT 1",
    ).get(bid);
    if (pending) {
      db.prepare("UPDATE orders SET create_time = '2026-10-28 10:00:00' WHERE order_id = ?").run(pending.order_id);
      const scan = await api('/admin/api/streambeat/scan', {
        method: 'POST', token: at, body: { date: '2026-10-28' },
      });
      ok(scan.code === 1, '执行流拍扫描', scan.msg);
      ok((scan.data?.count || 0) >= 1, '标记了流拍商品', `${scan.data?.count} 件`);

      const gA = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(pending.goods_id);
      eq(gA.goods_status, 30, '商品状态变为流拍(30)');

      const lOrder = db.prepare("SELECT * FROM orders WHERE type = 5 AND status = 50 ORDER BY order_id DESC LIMIT 1").get();
      ok(!!lOrder, '生成流拍记录(type=5)');

      const rel = await api('/admin/api/streambeat/release', {
        method: 'POST', token: at, body: { order_id: lOrder.order_id },
      });
      ok(rel.code === 1, '释放流拍', rel.msg);
      const gR = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(pending.goods_id);
      eq(gR.goods_status, 10, '释放后商品恢复上架(10)');
    }


    console.log('\n[10] 专场配置（开启日期 / 转拍时限）');
    const cfgSave = await api('/admin/api/specialarea/save', {
      method: 'POST', token: at,
      body: { specialarea_id: 1, open_days: '6,7', title_main: '测试专场' },
    });
    ok(cfgSave.code === 1, '保存专场配置', cfgSave.msg);

    const cfgBack = (await api('/admin/api/specialarea/detail?id=1', { token: at })).data || {};
    ok(cfgBack.open_days === '6,7', '配置回读正确', `open_days=${cfgBack.open_days}`);

    const jsDay = new Date().getDay();
    const todayNum = jsDay === 0 ? 7 : jsDay;
    const gArea1 = db.prepare(
      "SELECT * FROM goods WHERE specialarea_id = 1 AND goods_status = 10 AND member_id <> ? LIMIT 1",
    ).get(bid);
    if (gArea1 && todayNum < 6) {
      const closed = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer, body: { goods_id: gArea1.goods_id, num: 1, pay_type: 1 },
      });
      ok(closed.code === 0 && /未开启/.test(closed.msg), '非开放日下单被拒', closed.msg);
    }

    // 恢复全周 + 24 小时转拍时限
    await api('/admin/api/specialarea/save', {
      method: 'POST', token: at,
      body: { specialarea_id: 1, open_days: '1,2,3,4,5,6,7', transposition_hours: 24, start_time: 0, end_time: 86399 },
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
    const scoreRow = db.prepare(
      'SELECT sg.goods_id, sg.score FROM score_goods sg JOIN goods g ON g.goods_id = sg.goods_id WHERE g.goods_status = 10',
    ).get();
    ok(!!scoreRow, '存在可兑换的积分商品');
    const sl = await api('/api/score/getScoreShopList?page=1&limit=30', { token: buyer });
    ok(sl.code === 1, '积分商城列表接口可达（/api/score）', sl.msg);
    ok((sl.data?.list?.data || []).length >= 1, '积分商城返回商品', `${sl.data?.list?.total} 件`);
    ok(
      (sl.data?.list?.data || []).every((x) => x.score_price !== undefined),
      '积分商城返回兑换所需积分',
    );
    const sd = await api(`/api/score/getDetails?goods_id=${scoreRow.goods_id}`, { token: buyer });
    ok(sd.code === 1 && Number(sd.data?.score_price) === Number(scoreRow.score), '积分商品详情返回积分价', JSON.stringify(sd.data?.score_price));
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
    const mp = await api('/admin/api/my-paths', { token: tOp });
    ok(mp.data?.unrestricted === false, '受限角色返回明确权限集合');
    ok((mp.data?.paths || []).includes('/goods'), '权限集合包含已分配的菜单', JSON.stringify(mp.data?.paths));

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
    eq(await scGet(), 0, '抢单服务费默认 0（与原站实证一致：抢购环节平台不收费）');

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
