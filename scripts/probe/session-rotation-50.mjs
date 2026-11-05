// 场次关联 + 转拍轮转 50 轮端到端回归。
// 使用独立临时数据库与端口，不读写开发演示库。
// 用法：node scripts/probe/session-rotation-50.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3510;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = resolve(tmpdir(), 'beishan-mall-session-rotation-50');
const TEMP_ROOT = resolve(tmpdir()).toLowerCase() + sep.toLowerCase();
if (!TEST_DIR.toLowerCase().startsWith(TEMP_ROOT)) throw new Error('拒绝清理临时目录之外的路径');
const DB = join(TEST_DIR, 'mall.db');
const UPLOAD_DIR = join(TEST_DIR, 'uploads');
const env = { ...process.env, MALL_DB: DB, UPLOAD_DIR, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };

const ROUNDS = 50;
const AREA_COUNT = ROUNDS + 1;
const INITIAL_PRICE = 100;
const INCREASE_RATE = 1;
const assertions = { count: 0 };
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const money = (n) => Number(Number(n).toFixed(2));

function check(condition, label, detail = '') {
  assertions.count += 1;
  if (!condition) throw new Error(`${label}${detail ? `：${detail}` : ''}`);
}

function eq(actual, expected, label) {
  check(String(actual) === String(expected), label, `期望 ${expected}，实际 ${actual}`);
}

function eqMoney(actual, expected, label) {
  check(Math.abs(money(actual) - money(expected)) < 0.005,
    label, `期望 ¥${money(expected).toFixed(2)}，实际 ¥${money(actual).toFixed(2)}`);
}

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
  const { db, now } = await import('../../server/src/db.js');
  const { todayStr, addDays } = await import('../../server/src/lib/sessionWindow.js');
  let server;

  try {
    for (const [key, value] of [
      ['service_charge', 0],
      ['listing_fee_rate', 0],
      ['price_increase_rate', INCREASE_RATE],
      ['drive_award_rate', 0],
      ['score_award_open', 20],
    ]) {
      db.prepare('UPDATE setting_config SET `value` = ? WHERE `key` = ?').run(String(value), key);
    }

    // 让测试轮转只经过下面建立的场次；相同全天窗口以场次 ID 作为稳定顺序。
    db.prepare('UPDATE specialarea SET is_open = 20').run();
    const insertArea = db.prepare(
      `INSERT INTO specialarea (name, title_main, title_ordinary, start_time, end_time, open_days,
        buy_num, transposition_hours, is_subscribe, is_open, sort, create_time)
       VALUES ('', ?, '', 0, 0, '1,2,3,4,5,6,7', 999, 0, 0, 10, 100, ?)`,
    );
    const areaIds = [];
    for (let i = 1; i <= AREA_COUNT; i += 1) {
      areaIds.push(Number(insertArea.run(`场次轮转测试 ${String(i).padStart(2, '0')}`, now()).lastInsertRowid));
    }
    check(areaIds.length === AREA_COUNT && areaIds.every((id, i) => i === 0 || id > areaIds[i - 1]),
      '创建 51 个按时段稳定排序的连续开放场次');

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

    const login = await adminApi('/admin/api/login', {
      method: 'POST', body: { user_name: 'admin1', password: '123456' },
    });
    const adminToken = login.data?.token;
    check(login.code === 1 && !!adminToken, '测试后台登录');

    const official = db.prepare("SELECT member_id, invitation_code FROM member WHERE mobile = '13800000001'").get();
    const categoryId = Number(db.prepare('SELECT category_id FROM goods_category ORDER BY category_id LIMIT 1').get()?.category_id || 0);
    check(!!official?.member_id && !!categoryId, '演示基础会员和商品分类存在');

    const createGoods = await adminApi('/admin/api/goods/save', {
      method: 'POST', token: adminToken,
      body: {
        goods_name: '场次自动轮转 50 轮测试商品', category_id: categoryId,
        goods_min_price: INITIAL_PRICE, stock_num: ROUNDS + 2,
        goods_status: 10, goods_sort: 1,
      },
    });
    const poolId = Number(createGoods.data?.id || 0);
    check(createGoods.code === 1 && poolId > 0, '创建按件库存测试商品', createGoods.msg);
    const attach = await adminApi('/admin/api/specialarea/goods/add', {
      method: 'POST', token: adminToken, body: { specialarea_id: areaIds[0], goods_ids: [poolId] },
    });
    check(attach.code === 1, '把初始库存商品挂到第一场', attach.msg);
    const pool = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(poolId);
    eq(pool.specialarea_id, areaIds[0], '初始商品场次镜像正确');
    eq(db.prepare('SELECT specialarea_id FROM specialarea_goods WHERE goods_id = ?').get(poolId).specialarea_id,
      areaIds[0], '初始商品关联表指向第一场');

    const buyers = [];
    for (let i = 1; i <= AREA_COUNT + 1; i += 1) {
      const phone = String(13950000000 + i);
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST',
        body: { phone, password: 'rotation50pass', code: official.invitation_code, nickName: `场次轮转${i}` },
      });
      check(reg.code === 1 && !!reg.data?.token && Number(reg.data?.member_id) > 0, `注册轮次会员 ${i}`, reg.msg);
      buyers.push({ id: Number(reg.data.member_id), token: reg.data.token });
    }

    let unitId = 0;
    let previousOrderId = 0;
    let price = INITIAL_PRICE;
    const orderIds = [];
    const day = todayStr();
    console.log(`\n开始场次链路：首次按件成交 + ${ROUNDS} 轮转卖，目标第 ${AREA_COUNT} 场`);

    for (let i = 0; i <= ROUNDS; i += 1) {
      const round = i + 1;
      const buyer = buyers[i];
      const expectedAreaId = areaIds[i];
      const goodsId = i === 0 ? poolId : unitId;
      const created = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer.token, body: { goods_id: goodsId, num: 1 },
      });
      check(created.code === 1 && Number(created.data?.order_id) > 0, `第 ${round} 笔可从预期场次下单`, created.msg);
      const orderId = Number(created.data.order_id);
      orderIds.push(orderId);
      const orderBefore = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
      eq(orderBefore.specialarea_id, expectedAreaId, `第 ${round} 笔订单记录的成交场次`);
      eqMoney(orderBefore.price, price, `第 ${round} 笔订单使用本轮价格`);

      const apply = await api('/api/order/apply', { method: 'POST', token: buyer.token, body: { order_id: orderId } });
      check(apply.code === 1, `第 ${round} 笔提交抢单申请`, apply.msg);
      const confirm = await adminApi('/admin/api/orders/confirm-pay', {
        method: 'POST', token: adminToken, body: { order_id: orderId },
      });
      check(confirm.code === 1, `第 ${round} 笔后台确认成交`, confirm.msg);
      const settled = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
      eq(settled.pay_status, 10, `第 ${round} 笔订单已付款`);
      eq(settled.status, 10, `第 ${round} 笔订单已完成`);
      eq(settled.specialarea_id, expectedAreaId, `第 ${round} 笔成交场次未漂移`);

      if (i === 0) {
        unitId = Number(settled.asset_goods_id);
        check(unitId > 0 && unitId !== poolId, '首次按件成交生成独立单件货权');
        const source = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(poolId);
        eq(source.member_id, 0, '按件库存池仍归平台');
        eq(source.stock_num, ROUNDS + 1, '首次成交只扣一件库存');
        eq(source.specialarea_id, areaIds[0], '库存池自己的场次保持不变');
      } else {
        eq(settled.goods_id, unitId, `第 ${round} 笔继续交易同一单件货权`);
        eq(settled.asset_goods_id, 0, `第 ${round} 笔不再生成重复单件`);
        const old = db.prepare('SELECT consignment_status FROM orders WHERE order_id = ?').get(previousOrderId);
        eq(old.consignment_status, 0, `第 ${round} 笔成交清除上一手挂牌标记`);
      }

      const unit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
      eq(unit.member_id, buyer.id, `第 ${round} 笔确认后货权属于买家`);
      eq(unit.goods_status, 20, `第 ${round} 笔确认后商品等待买家转卖`);
      eq(unit.turn_beat_num, round, `第 ${round} 轮流转统计累计`);
      eqMoney(unit.goods_min_price, price, `第 ${round} 轮持有价格正确`);
      const shop = await api('/api/member/myShop', { token: buyer.token });
      check((shop.data?.list || []).some((g) => Number(g.goods_id) === unitId), `第 ${round} 位买家店铺能看到货权`);

      // 每笔成交后点「转卖」，检查接口回写的下一场关系、镜像字段、日期和抢购列表。
      if (i < ROUNDS) {
        const nextPrice = money(price * (1 + INCREASE_RATE / 100));
        const quote = await api(`/api/order/getConsignmentQuote?order_id=${orderId}`, { token: buyer.token });
        check(quote.code === 1, `第 ${round} 轮转卖报价成功`, quote.msg);
        eqMoney(quote.data?.next_price, nextPrice, `第 ${round} 轮报价涨价正确`);

        const listed = await api('/api/order/consignment', {
          method: 'POST', token: buyer.token, body: { order_id: orderId },
        });
        check(listed.code === 1, `第 ${round} 轮点击转卖后上架成功`, listed.msg);
        eqMoney(listed.data?.selling_price, nextPrice, `第 ${round} 轮挂牌价更新`);

        const targetAreaId = areaIds[i + 1];
        const listedUnit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
        eq(listedUnit.member_id, buyer.id, `第 ${round} 轮挂牌后持有人不变`);
        eq(listedUnit.goods_status, 10, `第 ${round} 轮挂牌后商品重新上架`);
        eq(listedUnit.specialarea_id, targetAreaId, `第 ${round} 轮商品场次镜像自动指向下一场`);
        eq(listedUnit.area_date, day, `第 ${round} 轮下一场日期为预期业务日期`);
        const links = db.prepare(
          'SELECT specialarea_id FROM specialarea_goods WHERE goods_id = ? ORDER BY area_goods_id',
        ).all(unitId).map((r) => Number(r.specialarea_id));
        check(links.length === 1 && links[0] === targetAreaId,
          `第 ${round} 轮关联表只保留下一场`, `实际关联 ${JSON.stringify(links)}，预期 ${targetAreaId}`);
        eq(db.prepare('SELECT consignment_status FROM orders WHERE order_id = ?').get(orderId).consignment_status,
          10, `第 ${round} 轮订单记录转卖已挂牌`);

        const targetAdminList = await adminApi(`/admin/api/specialarea/${targetAreaId}/goods`, { token: adminToken });
        check(targetAdminList.code === 1 && (targetAdminList.data?.list || []).some((g) => Number(g.goods_id) === unitId),
          `第 ${round} 轮后台下一场商品关联列表可见货品`, targetAdminList.msg);
        const h5Goods = await api(`/api/goods/getLootGoodsList?specialarea_id=${targetAreaId}&limit=100`);
        check(h5Goods.code === 1 && (h5Goods.data?.data || []).some((g) => Number(g.goods_id) === unitId),
          `第 ${round} 轮 H5 下一场抢购列表可见货品`, h5Goods.msg);
        const h5Sessions = await api('/api/goods/getLootList');
        const shownSession = (h5Sessions.data?.list || []).find((a) => Number(a.specialarea_id) === targetAreaId);
        check(!!shownSession && (shownSession.goods_list || []).some((g) => Number(g.goods_id) === unitId),
          `第 ${round} 轮 H5 场次首页把货品展示在下一场`);

        // 由于下一场全天开放，紧接着实际下单并在下一次迭代核对订单场次，证明关联可交易。
        const nextDetail = await api(`/api/goods/getLootDetails?goods_id=${unitId}`);
        check(nextDetail.code === 1, `第 ${round} 轮转卖商品详情可访问`, nextDetail.msg);
        price = nextPrice;
      }

      previousOrderId = orderId;
      console.log(`  第 ${String(round).padStart(2, '0')} 笔成交落在场次 #${expectedAreaId}${i < ROUNDS ? `，转卖后自动进入 #${areaIds[i + 1]}` : '（完成 50 轮转卖）'}`);
    }

    // 边界场景：最后一场再转卖，应回到第一场的次日；H5 可以预告，但当天不能抢。
    const tomorrow = addDays(day, 1);
    const boundaryOrderId = previousOrderId;
    const boundaryBuyer = buyers[ROUNDS];
    const boundaryQuote = await api(`/api/order/getConsignmentQuote?order_id=${boundaryOrderId}`, { token: boundaryBuyer.token });
    check(boundaryQuote.code === 1, '最后一场转卖报价成功', boundaryQuote.msg);
    const boundaryListed = await api('/api/order/consignment', {
      method: 'POST', token: boundaryBuyer.token, body: { order_id: boundaryOrderId },
    });
    check(boundaryListed.code === 1, '最后一场转卖成功', boundaryListed.msg);
    const wrapUnit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
    eq(wrapUnit.specialarea_id, areaIds[0], '最后一场之后场次循环回到第一场');
    eq(wrapUnit.area_date, tomorrow, '最后一场之后排到下一业务日');
    const wrapLinks = db.prepare('SELECT specialarea_id FROM specialarea_goods WHERE goods_id = ?').all(unitId);
    check(wrapLinks.length === 1 && Number(wrapLinks[0].specialarea_id) === areaIds[0],
      '跨日循环只保留第一场关联');
    const preview = await api('/api/goods/getLootList');
    check(preview.code === 1 && (preview.data?.preview || []).some((g) =>
      Number(g.goods_id) === unitId && g.next_date === tomorrow), 'H5 抢购页预告次日第一场的转拍商品');
    const todayAreaList = await api(`/api/goods/getLootGoodsList?specialarea_id=${areaIds[0]}&limit=100`);
    check(todayAreaList.code === 1 && !(todayAreaList.data?.data || []).some((g) => Number(g.goods_id) === unitId),
      '跨日商品不会提前出现在今日可抢列表');
    const tooEarly = await api('/api/order/toAddOrder', {
      method: 'POST', token: buyers[ROUNDS + 1].token, body: { goods_id: unitId, num: 1 },
    });
    check(tooEarly.code !== 1 && String(tooEarly.msg).includes(tomorrow), '跨日商品当天不可提前下单', tooEarly.msg);

    eq(orderIds.length, ROUNDS + 1, '连续 51 笔订单形成完整场次链');
    const finalUnit = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(unitId);
    eq(finalUnit.member_id, buyers[ROUNDS].id, '最后一轮转卖后货权仍归最后买家');
    eq(finalUnit.specialarea_id, areaIds[0], '跨日后场次回到第一场');
    eq(finalUnit.area_date, tomorrow, '跨日后日期正确');
    const finalLinks = db.prepare('SELECT specialarea_id FROM specialarea_goods WHERE goods_id = ?').all(unitId);
    check(finalLinks.length === 1 && Number(finalLinks[0].specialarea_id) === areaIds[0],
      '最终场次关联无重复、无旧场次残留');
    const oldAreasWithUnit = db.prepare('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ? AND specialarea_id <> ?')
      .get(unitId, areaIds[0]);
    eq(oldAreasWithUnit.c, 0, '商品没有残留在历史场次');
    const orderAreaChain = db.prepare(
      'SELECT specialarea_id FROM orders WHERE order_id IN (' + orderIds.map(() => '?').join(',') + ') ORDER BY order_id',
    ).all(...orderIds).map((r) => Number(r.specialarea_id));
    check(orderAreaChain.every((id, i) => id === areaIds[i]), '订单成交场次按 1 至 51 场严格递进');

    console.log('\n场次链路统计');
    console.log(`  成交订单：${orderIds.length}；连续轮转：${ROUNDS} 次；末场跨日轮转：1 次；覆盖场次：${AREA_COUNT} 个`);
    console.log(`  最终标价：¥${money(boundaryListed.data?.selling_price).toFixed(2)}；货品关联场次：#${areaIds[0]}（${tomorrow}）`);
    console.log(`  检查项：${assertions.count} 项全部通过`);
  } finally {
    await stop(server);
    try { db.close(); } catch {}
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\n✗ 50 轮场次关联回归失败');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
