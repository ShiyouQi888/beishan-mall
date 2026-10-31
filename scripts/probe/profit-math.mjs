/**
 * 收益口径闭环验证：预估必须等于实际到手。
 *
 * 场景：A 以 1000 买入（实付 1020，含 2% 抢单服务费），转拍后下一轮标价 1030。
 *   旧算法：1030 − 1000 − 0 = 30  ← 把买家自己付的 20 服务费漏算了
 *   正确值：1030 − 1020 − 0 = 10
 * B 真的买走后，A 的余额实际增量也应该正好是 10。三处必须一致：
 *   /member/myShop 的 est_net、/order/getConsignmentQuote 的 net_income、余额真实变化。
 *
 * 独立库（profit.db / 3415），跑完删库。
 *
 * 用法: node scripts/probe/profit-math.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3415;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'profit.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };
process.env.MALL_DB = DB;

let pass = 0;
const fails = [];
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

  const { db, get } = await import('../../server/src/db.js');
  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');
  const { serviceChargeRate, priceIncreaseRate } = await import('../../server/src/lib/helper.js');
  const { listingFeeRate } = await import('../../server/src/lib/settle.js');

  try {
    // 场次改成全天开放（seed 的上午场 08:00-12:00 现在是下午，已经结束了）
    const dow = new Date(`${todayStr()}T00:00:00Z`).getUTCDay();
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, open_days = ?, is_open = 10, transposition_hours = 0 WHERE specialarea_id = 1')
      .run(String(dow === 0 ? 7 : dow));

    // 上架费率默认 2.8%，那样一转手就是亏的（跟用户截图里「上架费 ¥0」的场景不符），
    // 这里显式设成 0，让用例聚焦在「服务费有没有算进成本」这一件事上。
    const feeRow = get("SELECT `value` FROM setting_config WHERE `key` = 'listing_fee_rate'");
    if (feeRow) db.prepare("UPDATE setting_config SET `value` = '0' WHERE `key` = 'listing_fee_rate'").run();
    else db.prepare("INSERT INTO setting_config (`key`, `value`) VALUES ('listing_fee_rate', '0')").run();

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const sr = serviceChargeRate();
    const ir = priceIncreaseRate();
    const lr = listingFeeRate();
    console.log(`费率：抢单服务费 ${sr}% / 转拍涨价 ${ir}% / 上架费 ${lr}%\n`);

    // 两个买家
    const people = [];
    for (const [i, phone] of [[1, '13950000001'], [2, '13950000002']]) {
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'pft123456', code: 'boss01', nickName: `收益买家${i}` },
      });
      const mid = Number(reg.data?.member_id) || get('SELECT member_id FROM member WHERE mobile = ?', phone)?.member_id;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '验收充值' },
      });
      const lg = await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'pft123456' } });
      people.push({ mid: Number(mid), token: lg.data?.token });
    }
    ok(people.every((p) => p.token), '两个买家可登录');
    const [A, B] = people;
    const balOf = (mid) => Number(get('SELECT amount FROM member WHERE member_id = ?', mid).amount);

    // 建商品 1000，挂场次
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const created = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_name: '收益验收样品', category_id: catId, goods_min_price: 1000, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const gid = Number(created.data?.id);
    ok(gid > 0, '商品创建成功', created.msg);
    await api('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid] },
    });
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);

    // ---------- A 买入 ----------
    console.log('[1] A 以 1000 买入（服务费 2%）');
    const o1 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: gid, num: 1, pay_type: 1 } });
    eq(o1.data?.total_price, 1000, '订单商品金额 1000');
    eq(o1.data?.service_charge, 20, '服务费 20');
    const pay1 = await api('/api/order/toPay', { method: 'POST', token: A.token, body: { order_id: o1.data.order_id, pay_type: 1 } });
    ok(pay1.code === 1, 'A 支付成功', pay1.msg);
    const aAfterBuy = balOf(A.mid);
    eq(aAfterBuy, 5000 - 1020, 'A 余额少 1020（商品 + 服务费）');

    // ---------- 未挂牌时的预估 ----------
    console.log('\n[2] 未挂牌：预计收益 = 下一轮标价 − 买入价 − 服务费 − 上架费');
    const shop1 = await api('/api/member/myShop', { token: A.token });
    const item1 = (shop1.data?.list || []).find((x) => Number(x.goods_id) === gid);
    ok(!!item1, '我的店铺能看到这件商品');
    const expectNext = Number((1000 * (1 + ir / 100)).toFixed(2));
    const expectFee = Number((1000 * (lr / 100)).toFixed(2));
    const expectNet = Number((expectNext - 1020 - expectFee).toFixed(2));
    eq(item1.my_price, 1000, '买入价 1000');
    eq(item1.my_service_charge, 20, '带出抢单服务费 20');
    eq(item1.my_cost, 1020, '实际成本 1020');
    eq(item1.next_price, expectNext, `下一轮标价 ${expectNext}`);
    eq(item1.est_net, expectNet, `预计净收益 ${expectNet}（旧算法会算成 ${(expectNext - 1000 - expectFee).toFixed(2)}）`);

    // ---------- 转拍报价 ----------
    console.log('\n[3] 转拍报价与店铺预估必须一致');
    const quote = await api(`/api/order/getConsignmentQuote?order_id=${o1.data.order_id}`, { token: A.token });
    eq(quote.data?.prev_service_charge, 20, '报价带出上一手服务费 20');
    eq(quote.data?.prev_cost, 1020, '报价里的实际成本 1020');
    eq(quote.data?.net_income, expectNet, `报价净收益 = 店铺预估 ${expectNet}`);
    eq(
      quote.data?.net_income,
      Number((quote.data.next_price - quote.data.prev_cost - quote.data.listing_fee).toFixed(2)),
      '报价三数自洽：净收益 = 标价 − 实际成本 − 上架费',
    );

    // ---------- A 转拍 ----------
    const consign = await api('/api/order/consignment', { method: 'POST', token: A.token, body: { order_id: o1.data.order_id } });
    ok(consign.code === 1, 'A 转拍成功', consign.msg);

    const shop2 = await api('/api/member/myShop', { token: A.token });
    const item2 = (shop2.data?.list || []).find((x) => Number(x.goods_id) === gid);
    eq(item2.listed, true, '状态变为已挂牌');
    eq(item2.next_price, expectNext, '挂牌标价 = 下一轮价');
    eq(item2.est_net, expectNet, '挂牌后预计净收益不变');

    // ---------- B 买走，看 A 实收 ----------
    console.log('\n[4] B 买走后 A 的实际到账');
    const o2 = await api('/api/order/toAddOrder', { method: 'POST', token: B.token, body: { goods_id: gid, num: 1, pay_type: 1 } });
    eq(o2.data?.total_price, expectNext, `B 支付商品金额 ${expectNext}`);
    const pay2 = await api('/api/order/toPay', { method: 'POST', token: B.token, body: { order_id: o2.data.order_id, pay_type: 1 } });
    ok(pay2.code === 1, 'B 支付成功', pay2.msg);

    const aFinal = balOf(A.mid);
    // 盈亏要看「相对初始本金」，不是相对买完之后的余额：
    // 买入时扣了 1020、卖出时进账 1030，一进一出才是净收益。
    const realGain = Number((aFinal - 5000).toFixed(2));
    eq(realGain, expectNet, `A 整体盈亏 = 预估 ${expectNet}`);
    eq(aFinal, 5000 + expectNet, 'A 最终余额 = 本金 + 净收益');

    // 再确认一次旧算法确实会算错（防回归到「只扣买入价」）
    const wrong = Number((expectNext - 1000 - expectFee).toFixed(2));
    ok(Math.abs(realGain - wrong) > 0.005, '实际到手不等于旧算法（说明服务费确实计入了）', `实际 ${realGain} vs 旧算法 ${wrong}`);
  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main()
  .catch((e) => { console.error('\n[错误]', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
