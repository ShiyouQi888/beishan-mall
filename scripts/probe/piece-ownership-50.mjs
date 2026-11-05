// 按件货权 + 50 轮转拍端到端回归。
// 使用独立临时数据库与端口，不读写开发演示库。
// 用法：node scripts/probe/piece-ownership-50.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = resolve(tmpdir(), 'beishan-mall-piece-ownership-50');
const TEMP_ROOT = resolve(tmpdir()).toLowerCase() + sep.toLowerCase();
if (!TEST_DIR.toLowerCase().startsWith(TEMP_ROOT)) throw new Error('拒绝清理临时目录之外的路径');
const DB = join(TEST_DIR, 'mall.db');
const UPLOAD_DIR = join(TEST_DIR, 'uploads');
const env = { ...process.env, MALL_DB: DB, UPLOAD_DIR, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };

const CFG = { initialPrice: 100, serviceRate: 2, listingRate: 1, increaseRate: 3, resaleRounds: 50, stock: 80 };
const m2 = (n) => Number(Number(n).toFixed(2));
const closeMoney = (a, b) => Math.abs(m2(a) - m2(b)) < 0.005;
const assertions = { count: 0 };
function check(condition, label, detail = '') {
  assertions.count += 1;
  if (!condition) throw new Error(`${label}${detail ? `：${detail}` : ''}`);
}
function eqMoney(actual, expected, label) {
  check(closeMoney(actual, expected), label, `期望 ${m2(expected).toFixed(2)}，实际 ${m2(actual).toFixed(2)}`);
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function runNode(args, childEnv = env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { cwd: SERVER, env: childEnv, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => code === 0 ? resolveRun(output) : rejectRun(new Error(output)));
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(resolveStop, 1500);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); });
    child.kill('SIGTERM');
  });
}

async function main() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  await runNode(['src/seed.js']);
  process.env.MALL_DB = DB;
  process.env.UPLOAD_DIR = UPLOAD_DIR;
  const { db } = await import('../../server/src/db.js');
  let server;

  try {
    for (const [key, value] of [
      ['service_charge', CFG.serviceRate],
      ['listing_fee_rate', CFG.listingRate],
      ['price_increase_rate', CFG.increaseRate],
      ['drive_award_rate', 0],
      ['score_award_open', 20],
    ]) {
      db.prepare('UPDATE setting_config SET `value` = ? WHERE `key` = ?').run(String(value), key);
    }
    // 禁用测试库场次：转拍 nextSlot 在无活动场次时会原地上架，不会排到未来日期。
    db.prepare('UPDATE specialarea SET is_open = 20').run();

    server = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) { ready = true; break; }
      } catch {}
      if (server.exitCode !== null) break;
      await sleep(250);
    }
    if (!ready) throw new Error(`隔离测试服务启动失败：\n${serverLog.slice(-1800)}`);

    const api = async (path, { method = 'GET', body, token } = {}) => {
      const response = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return response.json();
    };
    const adminApi = async (path, { method = 'GET', body, token } = {}) => {
      const response = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return response.json();
    };

    const adminLogin = await adminApi('/admin/api/login', {
      method: 'POST', body: { user_name: 'admin1', password: '123456' },
    });
    const adminToken = adminLogin.data?.token;
    check(adminLogin.code === 1 && !!adminToken, '后台登录');

    const baseline = (await adminApi('/admin/api/dashboard', { token: adminToken })).data;
    check(!!baseline?.overview, '读取基线统计');
    const baseOrderCount = Number(baseline.overview.order_total);
    const baseTurnover = Number(baseline.overview.turnover_total);
    const baseService = Number(baseline.overview.fee_total);
    const baseListing = Number(baseline.overview.listing_fee_total);
    const baseTransposing = Number(baseline.cards.find((c) => c.key === 'transposing')?.value || 0);
    const basePayoutCount = Number(db.prepare("SELECT COUNT(*) c FROM finance_energy WHERE type = 2 AND type_name = '商品售出'").get().c);
    const basePayoutSum = Number(db.prepare("SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2 AND type_name = '商品售出'").get().v);

    const official = db.prepare("SELECT member_id, invitation_code FROM member WHERE mobile = '13800000001'").get();
    const categoryId = Number(db.prepare('SELECT category_id FROM goods_category ORDER BY category_id LIMIT 1').get()?.category_id || 0);
    check(!!official?.member_id && !!categoryId, '演示基础会员与商品分类存在');

    const goodsResult = await adminApi('/admin/api/goods/save', {
      method: 'POST', token: adminToken,
      body: {
        goods_name: '货权 50 轮回归商品', category_id: categoryId,
        goods_min_price: CFG.initialPrice, stock_num: CFG.stock,
        goods_status: 10, goods_sort: 1,
      },
    });
    const poolId = Number(goodsResult.data?.id || 0);
    check(goodsResult.code === 1 && poolId > 0, '创建批量库存商品', goodsResult.msg);
    // 商品保存兼容旧场次字段；此用例专测不受场次时间限制的单件所有权流转。
    db.prepare('DELETE FROM specialarea_goods WHERE goods_id = ?').run(poolId);
    db.prepare("UPDATE goods SET specialarea_id = 0, area_date = '' WHERE goods_id = ?").run(poolId);
    const poolBefore = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(poolId);
    check(Number(poolBefore.member_id) === 0, '初始库存池由平台持有');
    eqMoney(poolBefore.stock_total, CFG.stock, '库存池初始名额');
    eqMoney(poolBefore.stock_num, CFG.stock, '库存池初始剩余库存');

    const buyers = [];
    const buyerCount = CFG.resaleRounds + 2; // 首笔批量成交 + 50 次转卖 + 末端后台过户
    for (let i = 1; i <= buyerCount; i += 1) {
      const phone = String(13940000000 + i);
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'piece50pass', code: official.invitation_code, nickName: `货权轮次${i}` },
      });
      check(reg.code === 1 && !!reg.data?.token && Number(reg.data?.member_id) > 0, `注册第 ${i} 位测试会员`, reg.msg);
      buyers.push({ id: Number(reg.data.member_id), token: reg.data.token, phone });
    }

    let unitId = 0;
    let currentOwnerId = 0;
    let currentOrderId = 0;
    let price = m2(CFG.initialPrice);
    let priceSum = 0;
    let serviceSum = 0;
    let listingSum = 0;

    console.log(`\n开始端到端链路：1 次批量库存成交 + ${CFG.resaleRounds} 次单件转卖`);
    for (let i = 0; i <= CFG.resaleRounds; i += 1) {
      const round = i + 1;
      const buyer = buyers[i];
      const roundPrice = price;
      const goodsId = i === 0 ? poolId : unitId;
      const service = m2(roundPrice * CFG.serviceRate / 100);
      const listing = m2(roundPrice * CFG.listingRate / 100);
      const sellerBalance = currentOwnerId
        ? Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(currentOwnerId).amount)
        : null;

      const orderResult = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer.token, body: { goods_id: goodsId, num: 1 },
      });
      check(orderResult.code === 1 && Number(orderResult.data?.order_id) > 0, `第 ${round} 笔下单成功`, orderResult.msg);
      const orderId = Number(orderResult.data.order_id);
      const orderBefore = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
      eqMoney(orderBefore.price, roundPrice, `第 ${round} 笔成交标价`);
      eqMoney(orderBefore.service_charge, service, `第 ${round} 笔抢单服务费`);
      eqMoney(orderBefore.listing_fee, listing, `第 ${round} 笔预付上架费`);
      check(Number(orderBefore.seller_id) === currentOwnerId, `第 ${round} 笔卖家为当前持有人`);

      const apply = await api('/api/order/apply', { method: 'POST', token: buyer.token, body: { order_id: orderId } });
      check(apply.code === 1, `第 ${round} 笔提交抢单申请`, apply.msg);
      const confirm = await adminApi('/admin/api/orders/confirm-pay', {
        method: 'POST', token: adminToken, body: { order_id: orderId },
      });
      check(confirm.code === 1, `第 ${round} 笔后台确认成交`, confirm.msg);

      const settledOrder = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
      check(Number(settledOrder.pay_status) === 10 && Number(settledOrder.status) === 10, `第 ${round} 笔订单已成交`);
      if (i === 0) {
        unitId = Number(settledOrder.asset_goods_id);
        check(unitId > 0 && unitId !== poolId, '按件成交生成独立单件货权');
        const source = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(poolId);
        check(Number(source.member_id) === 0, '批量库存仍归原持有人');
        eqMoney(source.stock_num, CFG.stock - 1, '仅扣减一个库存名额');
        eqMoney(source.stock_total, CFG.stock, '批量库存总名额保持不变');
        check(Number(source.goods_status) === 10, '剩余库存未售罄，库存池仍在售');
        check(Number(settledOrder.goods_id) === poolId, '原订单仍保留库存池来源');
      } else {
        check(Number(settledOrder.goods_id) === unitId && Number(settledOrder.asset_goods_id) === 0,
          `第 ${round} 笔订单沿单件货权继续流转`);
        const oldListing = db.prepare('SELECT consignment_status FROM orders WHERE order_id = ?').get(currentOrderId);
        check(Number(oldListing.consignment_status) === 0, `第 ${round} 笔成交清除上一手挂牌状态`);
      }

      const unit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
      check(Number(unit.member_id) === buyer.id, `第 ${round} 笔成交后貨权归买家`);
      check(Number(unit.goods_status) === 20, `第 ${round} 笔成交后单件商品待转拍`);
      eqMoney(unit.stock_total, 1, `第 ${round} 笔持有记录保持单件`);
      eqMoney(unit.stock_num, 1, `第 ${round} 笔单件库存保持为 1`);
      eqMoney(unit.turn_beat_num, round, `第 ${round} 笔流转统计`);
      eqMoney(unit.sales_actual, round, `第 ${round} 笔销量统计`);
      eqMoney(unit.goods_min_price, roundPrice, `第 ${round} 笔货权现价`);

      const shop = await api('/api/member/myShop', { token: buyer.token });
      const shopUnit = (shop.data?.list || []).find((g) => Number(g.goods_id) === unitId);
      check(!!shopUnit, `第 ${round} 位买家在我的店铺看到货权`);
      check(shopUnit?.transferable === true && Number(shopUnit?.piece_sale) === 0,
        `第 ${round} 位买家可转拍该单件货权`);
      check(Number(shopUnit?.order_id) === orderId, `第 ${round} 位买家店铺关联本轮订单`);
      if (i > 0) {
        const formerShop = await api('/api/member/myShop', { token: buyers[i - 1].token });
        check(!(formerShop.data?.list || []).some((g) => Number(g.goods_id) === unitId),
          `第 ${round} 笔成交后上一手不再持有该货权`);
      }

      if (currentOwnerId) {
        const sellerAfter = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(currentOwnerId).amount);
        eqMoney(sellerAfter - sellerBalance, price, `第 ${round} 笔卖家收到完整货款`);
      }

      priceSum = m2(priceSum + price);
      serviceSum = m2(serviceSum + service);
      listingSum = m2(listingSum + listing);
      const dashboardAfterSale = (await adminApi('/admin/api/dashboard', { token: adminToken })).data;
      eqMoney(dashboardAfterSale.overview.order_total, baseOrderCount + round, `第 ${round} 笔订单统计累计`);
      eqMoney(dashboardAfterSale.overview.turnover_total, baseTurnover + priceSum, `第 ${round} 笔成交额统计累计`);
      eqMoney(dashboardAfterSale.overview.fee_total, baseService + serviceSum, `第 ${round} 笔服务费统计累计`);
      eqMoney(dashboardAfterSale.overview.listing_fee_total, baseListing + listingSum, `第 ${round} 笔上架费统计累计`);
      const transposingAfterSale = Number(dashboardAfterSale.cards.find((c) => c.key === 'transposing')?.value || 0);
      check(transposingAfterSale === baseTransposing, `第 ${round} 笔成交后挂牌数回到基线`);

      currentOwnerId = buyer.id;
      currentOrderId = orderId;

      if (i < CFG.resaleRounds) {
        const nextPrice = m2(price * (1 + CFG.increaseRate / 100));
        const quote = await api(`/api/order/getConsignmentQuote?order_id=${orderId}`, { token: buyer.token });
        check(quote.code === 1, `第 ${round} 手转卖报价成功`, quote.msg);
        eqMoney(quote.data?.prev_price, price, `第 ${round} 手报价读取本轮买入价`);
        eqMoney(quote.data?.next_price, nextPrice, `第 ${round} 手涨价复利`);
        eqMoney(quote.data?.prev_service_charge, service, `第 ${round} 手成本含抢单服务费`);
        eqMoney(quote.data?.listing_fee, listing, `第 ${round} 手成本含已预付上架费`);
        eqMoney(quote.data?.net_income, m2(nextPrice - price - service - listing), `第 ${round} 手预计净收益统计`);
        eqMoney(shopUnit?.est_net, quote.data?.net_income, `第 ${round} 手我的店铺与报价收益一致`);

        const amountBeforeListing = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(buyer.id).amount);
        const consign = await api('/api/order/consignment', {
          method: 'POST', token: buyer.token, body: { order_id: orderId },
        });
        check(consign.code === 1, `第 ${round} 手转拍上架成功`, consign.msg);
        eqMoney(consign.data?.selling_price, nextPrice, `第 ${round} 手上架标价`);
        eqMoney(consign.data?.listing_fee, listing, `第 ${round} 手上架费沿用预付值`);
        eqMoney(Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(buyer.id).amount),
          amountBeforeListing, `第 ${round} 手上架不重复扣款`);
        const listedUnit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
        check(Number(listedUnit.member_id) === buyer.id && Number(listedUnit.goods_status) === 10,
          `第 ${round} 手上架后仍归持有人且可售`);
        eqMoney(listedUnit.goods_min_price, nextPrice, `第 ${round} 手上架更新商品价格`);
        check(Number(db.prepare('SELECT consignment_status FROM orders WHERE order_id = ?').get(orderId).consignment_status) === 10,
          `第 ${round} 手订单挂牌状态已更新`);

        const dashboardListed = (await adminApi('/admin/api/dashboard', { token: adminToken })).data;
        check(Number(dashboardListed.cards.find((c) => c.key === 'transposing')?.value || 0) === baseTransposing + 1,
          `第 ${round} 手后台在挂统计加一`);
        eqMoney(dashboardListed.overview.turnover_total, baseTurnover + priceSum,
          `第 ${round} 手转拍不重复增加成交额`);
        eqMoney(dashboardListed.overview.listing_fee_total, baseListing + listingSum,
          `第 ${round} 手转拍不重复增加上架费`);

        price = nextPrice;
      }

      console.log(`  第 ${String(round).padStart(2, '0')} 笔：买家 ${buyer.id} 持有，成交价 ¥${roundPrice.toFixed(2)}${i < CFG.resaleRounds ? '，已完成转拍上架' : ''}`);
    }

    const chainCount = Number(db.prepare(
      'SELECT COUNT(*) c FROM orders WHERE goods_id = ? OR goods_id = ? OR asset_goods_id = ?',
    ).get(poolId, unitId, unitId).c);
    eqMoney(chainCount, CFG.resaleRounds + 1, '订单链包含首次按件成交和 50 次转卖');
    const finalPool = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(poolId);
    check(Number(finalPool.member_id) === 0, '50 轮后原批量库存持有人未变');
    eqMoney(finalPool.stock_num, CFG.stock - 1, '50 轮转卖没有再次扣批量库存');
    eqMoney(finalPool.sales_actual, 1, '原库存池只统计首次按件成交');
    const finalUnit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
    check(Number(finalUnit.member_id) === currentOwnerId && Number(finalUnit.goods_status) === 20,
      '50 轮后单件货权属于最后一位买家并处于待转拍状态');
    eqMoney(finalUnit.turn_beat_num, CFG.resaleRounds + 1, '50 轮后流转次数累计正确');
    eqMoney(finalUnit.sales_actual, CFG.resaleRounds + 1, '50 轮后单件商品销量累计正确');
    eqMoney(finalUnit.goods_min_price, price, '50 轮后价格按复利累计正确');
    const payoutCount = Number(db.prepare(
      "SELECT COUNT(*) c FROM finance_energy WHERE type = 2 AND type_name = '商品售出'",
    ).get().c);
    eqMoney(payoutCount, basePayoutCount + CFG.resaleRounds, '平台给 50 位上一手持有人各记一笔全额售出流水');
    const payoutSum = Number(db.prepare(
      "SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2 AND type_name = '商品售出'",
    ).get().v);
    eqMoney(payoutSum, basePayoutSum + priceSum - CFG.initialPrice, '卖家到账合计与 50 次转卖成交价一致');

    // 后台转让也必须只转当前单件货权，不能把平台剩余库存池转给接手会员。
    const recipient = buyers[CFG.resaleRounds + 1];
    const transfer = await adminApi('/admin/api/orders/transfer', {
      method: 'POST', token: adminToken,
      body: { order_id: currentOrderId, to_member_id: recipient.id, reason: '50 轮货权回归验证' },
    });
    check(transfer.code === 1, '后台可转让最后一手独立货权', transfer.msg);
    check(Number(db.prepare('SELECT member_id FROM goods WHERE goods_id = ?').get(unitId).member_id) === recipient.id,
      '后台转让后单件持有人变更');
    check(Number(db.prepare('SELECT member_id FROM goods WHERE goods_id = ?').get(poolId).member_id) === 0,
      '后台转让不会改变原库存池持有人');
    const recipientShop = await api('/api/member/myShop', { token: recipient.token });
    check((recipientShop.data?.list || []).some((g) => Number(g.goods_id) === unitId),
      '后台转让后的新持有人在我的店铺看到该单件货权');
    const transferRow = db.prepare('SELECT goods_moved FROM order_transfer WHERE order_id = ? ORDER BY transfer_id DESC LIMIT 1').get(currentOrderId);
    check(Number(transferRow?.goods_moved) === 1, '后台转让流水记为同步过户货权');

    console.log('\n统计汇总');
    console.log(`  成交订单：${CFG.resaleRounds + 1}（批量首次成交 1 + 单件转卖 ${CFG.resaleRounds}）`);
    console.log(`  实际转拍：${CFG.resaleRounds} 次`);
    console.log(`  最终标价：¥${price.toFixed(2)}；服务费累计：¥${serviceSum.toFixed(2)}；上架费累计：¥${listingSum.toFixed(2)}`);
    console.log(`  检查项：${assertions.count} 项全部通过`);
  } finally {
    await stop(server);
    try { db.close(); } catch {}
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\n✗ 50 轮货权回归失败');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
