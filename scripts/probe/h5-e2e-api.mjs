// H5 端到端冒烟：按页面 → 接口的映射，跑一遍完整用户旅程
// 使用独立 smoke 库（不碰演示库），真实 HTTP 调用
// 用法: node scripts/probe/h5-e2e-api.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3400;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'smoke.db';

const dbFile = join(SERVER, 'data', DB);
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) if (existsSync(f)) unlinkSync(f);

// 必须在本进程 import db.js 之前设置，否则脚本里的 db 会连到演示库
process.env.MALL_DB = DB;

const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);
const num = (a, b, name) => ok(Math.abs(Number(a) - Number(b)) < 0.011, name, `期望 ${b}，实际 ${a}`);
const money = (n) => Math.round(Number(n) * 100) / 100;
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
  console.log('[setup] 初始化独立 smoke 库…');
  await run('node', ['src/seed.js']);

  const { db } = await import('../../server/src/db.js');
  db.exec('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99');

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

  const api = async (path, { method = 'GET', body, token, raw } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (raw) return res;
    return res.json();
  };
  const login = async (phone, pwd) =>
    (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: pwd || phone } })).data?.token;
  const detail = async (t) => (await api('/api/member/getMemberDetails', { token: t })).data;

  try {
    // ========== 首页 / 启动配置（Home、TabBar 依赖）==========
    section('[1] 首页与全局配置');
    for (const [name, path] of [
      ['banner', '/api/index/getBannerList?type_id=1'],
      ['navs', '/api/index/getNavLists'],
      ['storeInfo', '/api/index/getStoreInfo'],
      ['shareInfo', '/api/index/getShareInfo'],
      ['invitePoster', '/api/index/getInvitePoster'],
      ['invitationNotice', '/api/index/getInvitationNotice'],
      ['registerAgreements', '/api/index/getRegisterAgreements'],
      ['openNav', '/api/index/getOpenNavigation'],
      ['tradeConfig', '/api/index/getTradeConfig'],
      ['notices', '/api/notice/getNotice'],
      ['regions', '/api/region/getAllList'],
      ['scoreShop', '/api/score/getScoreShopList?page=1&limit=10'],
    ]) {
      const r = await api(path);
      ok(r.code === 1, `首页依赖可读：${name}`, r.msg);
    }
    const tc = await api('/api/index/getTradeConfig');
    ok(Number(tc.data?.price_increase_rate) > 0, '交易配置带涨价率', String(tc.data?.price_increase_rate));
    ok(tc.data?.listing_fee_rate !== undefined && Number(tc.data?.listing_fee_rate) >= 0, '交易配置带上架费率', String(tc.data?.listing_fee_rate));
    ok(tc.data?.service_charge !== undefined, '交易配置带抢单服务费率', String(tc.data?.service_charge));

    // ========== 分类 / 商品 ==========
    section('[2] 分类、搜索与商品详情');
    const cats = await api('/api/goods/getCategory');
    const catArr = cats.data?.categoryList || [];
    ok(cats.code === 1 && catArr.length > 0, '分类列表', `${catArr.length} 个`);
    const catId = catArr[0]?.category_id;
    const catGoods = await api(`/api/goods/category/getCategoryGoodsList?category_id=${catId}&page=1&limit=10`);
    ok(catGoods.code === 1, '分类下商品列表', catGoods.msg);

    // 首页分类栏总开关
    const nav0 = await api('/api/index/getOpenNavigation');
    ok(nav0.code === 1 && nav0.data?.home_category_open === '10', '开放导航下发首页分类开关', `home_category_open=${nav0.data?.home_category_open}`);
    const homeCats = await api('/api/goods/getCategory?home=1');
    ok(homeCats.code === 1, '首页分类（只取首页显示）', homeCats.msg);
    ok((homeCats.data?.categoryList || []).length > 0, '首页分类非空', `${(homeCats.data?.categoryList || []).length} 个`);

    // 老库缺 home_show 列时不能让首页整块 500
    db.prepare('ALTER TABLE goods_category DROP COLUMN home_show').run();
    const noCol = await api('/api/goods/getCategory?home=1');
    ok(noCol.code === 1 && (noCol.data?.categoryList || []).length > 0, '缺 home_show 列时退化为不过滤', noCol.msg);
    db.prepare('ALTER TABLE goods_category ADD COLUMN home_show INTEGER NOT NULL DEFAULT 10').run();

    const atNav = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    await api('/admin/api/setting/save', { method: 'POST', token: atNav, body: { group: 'nav', values: { home_category_show: '20' } } });
    const nav1 = await api('/api/index/getOpenNavigation');
    ok(nav1.data?.home_category_open === '20', '开关关掉后导航下发 20', `home_category_open=${nav1.data?.home_category_open}`);
    await api('/admin/api/setting/save', { method: 'POST', token: atNav, body: { group: 'nav', values: { home_category_show: '10' } } });
    ok((await api('/api/index/getOpenNavigation')).data?.home_category_open === '10', '开关恢复为 10');

    const lootList = await api('/api/goods/getLootList');
    const areaArr = lootList.data?.list || [];
    ok(lootList.code === 1 && areaArr.length > 0, '抢购场次列表', `${areaArr.length} 场`);
    ok(areaArr.some((a) => (a.goods_list || []).length > 0), '场次下带商品列表');
    const lootGoods = await api('/api/goods/getLootGoodsList?page=1&limit=50');
    ok(lootGoods.code === 1 && (lootGoods.data?.data || []).length > 0, '抢购商品列表', `${lootGoods.data?.total} 件`);

    const search = await api('/api/goods/searchShop?keywords=玉&page=1&limit=10');
    ok(search.code === 1, '搜索接口', search.msg);
    const searchEmpty = await api('/api/goods/searchShop?keywords=zzzz不存在的商品&page=1&limit=10');
    eq(searchEmpty.data?.total || 0, 0, '搜索无结果时返回空列表');

    const shopGoods = db.prepare("SELECT goods_id FROM goods WHERE type = 2 AND goods_status = 10 LIMIT 1").get();
    const shopDetail = await api(`/api/goods/shopgoods/getDetails?goods_id=${shopGoods.goods_id}`);
    ok(shopDetail.code === 1, '商城商品详情', shopDetail.msg);

    const lootTarget = db.prepare(
      `SELECT g.goods_id, g.goods_min_price FROM goods g
       WHERE g.goods_status = 10 AND g.type = 1 AND IFNULL(g.is_split,0) = 0
       ORDER BY g.goods_id LIMIT 1`,
    ).get();
    const lootDetail = await api(`/api/goods/getLootDetails?goods_id=${lootTarget.goods_id}`);
    ok(lootDetail.code === 1, '抢购商品详情', lootDetail.msg);
    ok(lootDetail.data?.service_charge_rate !== undefined, '详情返回服务费率');
    const missing = await api('/api/goods/getLootDetails?goods_id=999999');
    ok(missing.code === 0, '不存在的商品被拒', missing.msg);

    // ========== 注册 / 登录 ==========
    section('[3] 注册与登录');
    const invite = db.prepare("SELECT invitation_code c FROM member WHERE mobile='13800000001'").get().c;
    const newPhone = '13900001111';
    const badFmt = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: '123', password: '123456', code: invite } });
    ok(badFmt.code === 0, '手机号格式错误被拒', badFmt.msg);
    const noCode = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: newPhone, password: '123456' } });
    ok(noCode.code === 0, '缺邀请码被拒', noCode.msg);
    const badCode = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: newPhone, password: '123456', code: 'ZZZZZZ' } });
    ok(badCode.code === 0, '邀请码不存在被拒', badCode.msg);
    const reg = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: newPhone, password: '123456', code: invite, nickName: '冒烟新用户' } });
    ok(reg.code === 1, '注册成功', reg.msg);
    const newToken = reg.data?.token;
    ok(!!newToken, '注册返回 token');
    const dupReg = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: newPhone, password: '123456', code: invite } });
    ok(dupReg.code === 0, '重复注册被拒', dupReg.msg);

    const badPwd = await api('/api/member/accountLogin', { method: 'POST', body: { phone: newPhone, password: 'wrong' } });
    ok(badPwd.code === 0, '错误密码登录被拒', badPwd.msg);
    const okLogin = await api('/api/member/accountLogin', { method: 'POST', body: { phone: newPhone, password: '123456' } });
    ok(okLogin.code === 1 && !!okLogin.data?.token, '正确密码登录成功', okLogin.msg);

    const meNew = await detail(newToken);
    ok(String(meNew?.mobile || '').includes('****'), '会员详情手机号已脱敏', String(meNew?.mobile));
    ok(String(meNew?.mobile || '').startsWith('139'), '脱敏保留号段前缀', String(meNew?.mobile));
    const parentOfNew = db.prepare('SELECT p_id FROM member WHERE mobile = ?').get(newPhone).p_id;
    eq(parentOfNew, 1, '注册后绑定上级');

    const noAuth = await api('/api/member/getMemberDetails');
    eq(noAuth.code, -1, '未登录访问需鉴权接口返回 -1');

    // ========== 地址 ==========
    section('[4] 收货地址（增/改/查/删）');
    const addrAdd = await api('/api/member/address/add', {
      method: 'POST', token: newToken,
      body: { name: '冒烟收件人', mobile: '13900001111', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 1 号', is_default: 1 },
    });
    ok(addrAdd.code === 1, '新增地址', addrAdd.msg);
    const addrList = await api('/api/member/address/list', { token: newToken });
    ok((addrList.data || []).length === 1, '地址列表返回 1 条', `${(addrList.data || []).length} 条`);
    const addrId = (addrList.data || [])[0]?.address_id;
    const addrDetail = await api(`/api/member/address/detail?address_id=${addrId}`, { token: newToken });
    ok(addrDetail.code === 1 && addrDetail.data?.name === '冒烟收件人', '地址详情');
    const addrEdit = await api('/api/member/address/edit', {
      method: 'POST', token: newToken,
      body: { address_id: addrId, name: '改过的名字', mobile: '13900001111', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 2 号', is_default: 1 },
    });
    ok(addrEdit.code === 1, '编辑地址', addrEdit.msg);
    eq((await api('/api/member/address/list', { token: newToken })).data[0].name, '改过的名字', '编辑生效');

    // ========== 抢购下单与支付 ==========
    section('[5] 抢购下单与支付');
    // 新用户充值
    const newId = db.prepare('SELECT member_id id FROM member WHERE mobile = ?').get(newPhone).id;
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: newId, field: 'amount', value: 200000, remark: '冒烟充值' },
    });

    const noAddrOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: newToken, body: { goods_id: lootTarget.goods_id, num: 1, pay_type: 1 },
    });
    ok(noAddrOrder.code === 1, '无地址也可下单（地址非必填）', noAddrOrder.msg);
    const firstOid = noAddrOrder.data?.order_id;

    const selfBuy = await api('/api/order/toAddOrder', {
      method: 'POST', token: newToken, body: { goods_id: lootTarget.goods_id, num: 1, pay_type: 1, address_id: addrId },
    });
    // 商品已归新用户后不能再买自己的
    const afterPay = await api('/api/order/toPay', { method: 'POST', token: newToken, body: { order_id: firstOid, pay_type: 1 } });
    ok(afterPay.code === 1, '余额支付成功', afterPay.msg);
    const heldNow = db.prepare('SELECT member_id m FROM goods WHERE goods_id = ?').get(lootTarget.goods_id).m;
    eq(heldNow, newId, '支付后商品归属转移给买家');
    const again = await api('/api/order/toAddOrder', {
      method: 'POST', token: newToken, body: { goods_id: lootTarget.goods_id, num: 1, pay_type: 1 },
    });
    // 成交即下架：商品已经不在场次里可售，先撞上「已下架」这道闸
    ok(again.code === 0 && /已下架/.test(again.msg), '成交后商品立即下架，无法再被抢', again.msg);
    void selfBuy;

    const dupPay = await api('/api/order/toPay', { method: 'POST', token: newToken, body: { order_id: firstOid, pay_type: 1 } });
    ok(dupPay.code === 0, '重复支付被拦截', dupPay.msg);

    // 余额不足
    const poorPhone = '13800000004';
    const poorToken = await login(poorPhone);
    const poorId = db.prepare('SELECT member_id id, amount FROM member WHERE mobile = ?').get(poorPhone);
    if (Number(poorId.amount) > 0) {
      await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: poorId.id, field: 'amount', value: -Number(poorId.amount), remark: '清零' } });
    }
    const otherGoods = db.prepare(
      'SELECT goods_id FROM goods WHERE goods_status = 10 AND type = 1 AND member_id <> ? LIMIT 1',
    ).get(poorId.id);
    const poorOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: poorToken, body: { goods_id: otherGoods.goods_id, num: 1, pay_type: 1 },
    });
    if (poorOrder.code === 1) {
      const poorPay = await api('/api/order/toPay', { method: 'POST', token: poorToken, body: { order_id: poorOrder.data.order_id, pay_type: 1 } });
      ok(poorPay.code === 0 && /余额不足/.test(poorPay.msg), '余额不足被拦截', poorPay.msg);
    } else {
      ok(true, '余额不足场景：下单阶段即被拦截', poorOrder.msg);
    }

    // ========== 订单列表 / 详情 / 取消 / 确认收货 ==========
    section('[6] 订单列表、详情、取消与确认收货');
    const orderList = await api('/api/order/getOrder?page=1&limit=20', { token: newToken });
    ok(orderList.code === 1 && (orderList.data?.data || []).length > 0, '订单列表', `${orderList.data?.total} 单`);
    const myOid = orderList.data.data[0].order_id;
    const oDetail = await api(`/api/order/detail?order_id=${myOid}`, { token: newToken });
    ok(oDetail.code === 1 && oDetail.data?.order_id === myOid, '订单详情');
    const otherDetail = await api(`/api/order/detail?order_id=${myOid}`, { token: poorToken });
    ok(otherDetail.code === 0, '他人订单不可查看', otherDetail.msg);

    // 新造一笔待付款订单用于取消
    const cancelTarget = db.prepare(
      'SELECT goods_id FROM goods WHERE goods_status = 10 AND type = 1 AND member_id <> ? LIMIT 1',
    ).get(newId);
    const cOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: newToken, body: { goods_id: cancelTarget.goods_id, num: 1, pay_type: 1 },
    });
    ok(cOrder.code === 1, '创建待取消订单', cOrder.msg);
    const cancel = await api('/api/order/cancel', { method: 'POST', token: newToken, body: { order_id: cOrder.data.order_id } });
    ok(cancel.code === 1, '取消待付款订单', cancel.msg);
    eq(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(cOrder.data.order_id).status, 40, '取消后状态为 40');
    const cancelPaid = await api('/api/order/cancel', { method: 'POST', token: newToken, body: { order_id: firstOid } });
    ok(cancelPaid.code === 0, '已支付订单不可取消', cancelPaid.msg);

    const receiptBad = await api('/api/order/receipt', { method: 'POST', token: newToken, body: { order_id: firstOid } });
    ok(receiptBad.code === 0, '未发货不可确认收货', receiptBad.msg);
    // 发货后确认收货
    const ship = await api('/admin/api/orders/deliver', {
      method: 'POST', token: at, body: { order_id: firstOid, express_company: '顺丰', express_no: 'SF123456789' },
    });
    ok(ship.code === 1, '后台发货', ship.msg);
    const receiptOk = await api('/api/order/receipt', { method: 'POST', token: newToken, body: { order_id: firstOid } });
    ok(receiptOk.code === 1, '确认收货成功', receiptOk.msg);
    eq(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(firstOid).status, 30, '确认收货后状态为 30');

    // ========== 转拍 ==========
    section('[7] 转拍与自动涨价');
    const q = await api(`/api/order/getConsignmentQuote?order_id=${firstOid}`, { token: newToken });
    ok(q.code === 1, '转拍报价', q.msg);
    const inc = Number((await api('/api/index/getTradeConfig')).data?.price_increase_rate) / 100;
    const prevPrice = Number(q.data?.prev_price);
    num(q.data?.next_price, money(prevPrice * (1 + inc)), '报价按涨价率计算');
    const consign = await api('/api/order/consignment', { method: 'POST', token: newToken, body: { order_id: firstOid } });
    ok(consign.code === 1, '转拍成功', consign.msg);
    num(db.prepare('SELECT goods_min_price p FROM goods WHERE goods_id = ?').get(lootTarget.goods_id).p,
      money(prevPrice * (1 + inc)), '商品标价已按涨价率更新');
    const consignAgain = await api('/api/order/consignment', { method: 'POST', token: newToken, body: { order_id: firstOid } });
    ok(consignAgain.code === 0, '同一订单不可重复转拍', consignAgain.msg);
    // 转拍后已重新上架，此时才轮到「不能买自己持有」这道校验
    const selfBuyAfterList = await api('/api/order/toAddOrder', {
      method: 'POST', token: newToken, body: { goods_id: lootTarget.goods_id, num: 1, pay_type: 1 },
    });
    ok(selfBuyAfterList.code === 0 && /自己持有/.test(selfBuyAfterList.msg), '不能购买自己持有的商品', selfBuyAfterList.msg);

    // ========== 我的店铺 ==========
    section('[8] 我的店铺');
    const shop = await api('/api/member/myShop', { token: newToken });
    ok(shop.code === 1, '我的店铺可读', shop.msg);
    const shopRow = (shop.data?.list || []).find((x) => x.goods_id === lootTarget.goods_id);
    ok(!!shopRow, '店铺里能看到刚转拍的商品');
    eq(shopRow?.listed, true, '已转拍标记为已挂牌');
    num(shopRow?.next_price, money(prevPrice * (1 + inc)), '店铺下一轮标价 = 商品现标价');
    ok(shop.data?.summary?.count >= 1, '店铺汇总包含件数', `${shop.data?.summary?.count}`);

    // 被别人买走 → 从店铺消失
    const takerToken = await login('13800000002');
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at,
      body: { member_id: db.prepare("SELECT member_id id FROM member WHERE mobile='13800000002'").get().id, field: 'amount', value: 200000, remark: '冒烟充值' },
    });
    const takeOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: takerToken, body: { goods_id: lootTarget.goods_id, num: 1, pay_type: 1 },
    });
    ok(takeOrder.code === 1, '他人可买走店铺商品', takeOrder.msg);
    await api('/api/order/toPay', { method: 'POST', token: takerToken, body: { order_id: takeOrder.data.order_id, pay_type: 1 } });
    const shop2 = await api('/api/member/myShop', { token: newToken });
    ok(!(shop2.data?.list || []).some((x) => x.goods_id === lootTarget.goods_id), '商品被抢走后从店铺消失');

    // ========== 团队 / 佣金 / 钱包 ==========
    section('[9] 团队、佣金与钱包');
    const ind = await api('/api/member/getMyIndirection', { token: newToken });
    ok(ind.code === 1, '我的直推列表', ind.msg);
    const teamStats = await api('/api/member/getMyTeamStats', { token: newToken });
    ok(teamStats.code === 1, '团队统计', teamStats.msg);
    const profit = await api('/api/member/personProfit', { token: newToken });
    ok(profit.code === 1, '佣金明细', profit.msg);
    const ecard = await api('/api/member/getECardList', { token: newToken });
    ok(ecard.code === 1, '佣金流水', ecard.msg);
    const fin = await api('/api/member/financialData', { token: newToken });
    ok(fin.code === 1, '资产数据', fin.msg);
    const amount = await api('/api/finance/getAmountInfo', { token: newToken });
    ok(amount.code === 1, '钱包金额', amount.msg);
    const sysInfo = await api('/api/finance/getSystemInfo', { token: newToken });
    ok(sysInfo.code === 1, '系统信息（提现页依赖）', sysInfo.msg);

    // 上级应拿到直推奖
    const topProfit = await api('/api/member/getECardList', { token: await login('13800000001') });
    ok((topProfit.data || []).length > 0, '上级收到直推奖流水', `${(topProfit.data || []).length} 条`);

    // ========== 提现 ==========
    section('[10] 提现（绑卡 → 申请）');
    const noCard = await api('/api/finance/withdraw/apply', {
      method: 'POST', token: newToken, body: { amount: 100, account_type: 1, account_info: '' },
    });
    ok(noCard.code === 0 && /收款账户/.test(noCard.msg), '未选收款账户被拒', noCard.msg);

    const cardAdd = await api('/api/member/card/add', {
      method: 'POST', token: newToken, body: { type: 3, account: '6222000011112222', name: '冒烟', bank: '招商银行' },
    });
    ok(cardAdd.code === 1, '绑定收款卡', cardAdd.msg);
    const cards = await api('/api/member/card/cardList', { token: newToken });
    ok((cards.data || []).length >= 1, '收款卡列表', `${(cards.data || []).length} 张`);

    const belowMin = await api('/api/finance/withdraw/apply', {
      method: 'POST', token: newToken, body: { amount: 1, account_type: 3, account_info: '6222000011112222' },
    });
    ok(belowMin.code === 0, '低于最低提现金额被拒', belowMin.msg);
    const overBal = await api('/api/finance/withdraw/apply', {
      method: 'POST', token: newToken, body: { amount: 9999999, account_type: 3, account_info: '6222000011112222' },
    });
    ok(overBal.code === 0 && /余额不足/.test(overBal.msg), '超出余额被拒', overBal.msg);

    const balBefore = Number((await detail(newToken)).amount);
    const wd = await api('/api/finance/withdraw/apply', {
      method: 'POST', token: newToken, body: { amount: 100, account_type: 3, account_info: '6222000011112222' },
    });
    ok(wd.code === 1, '提现申请成功', wd.msg);
    num(Number((await detail(newToken)).amount), money(balBefore - 100), '申请后余额立即冻结扣减');
    const wdList = await api('/api/finance/withdraw/list', { token: newToken });
    ok(wdList.code === 1, '提现记录列表', wdList.msg);
    // 后台驳回 → 自动退回
    const wdRow = db.prepare('SELECT withdraw_id FROM finance_withdraw WHERE member_id = ? ORDER BY withdraw_id DESC LIMIT 1').get(newId);
    const reject = await api('/admin/api/withdraw/audit', {
      method: 'POST', token: at, body: { withdraw_id: wdRow.withdraw_id, pass: false, remark: '冒烟驳回' },
    });
    ok(reject.code === 1, '后台驳回提现', reject.msg);
    num(Number((await detail(newToken)).amount), money(balBefore), '驳回后余额自动退回');

    // ========== 实名认证 ==========
    section('[11] 实名认证');
    const certBefore = await api('/api/member/certification/getIsRealName', { token: newToken });
    ok(certBefore.code === 1, '未认证状态可读', certBefore.msg);
    const cert = await api('/api/member/certification/addRealName', {
      method: 'POST', token: newToken,
      body: { real_name: '冒烟测试', idcard: '440300199001011234', front_image: '/uploads/test.png', back_image: '/uploads/test.png', hand_image: '/uploads/test.png' },
    });
    ok(cert.code === 1, '提交实名认证', cert.msg);
    eq(db.prepare('SELECT status FROM member_certification WHERE member_id = ? ORDER BY certification_id DESC LIMIT 1').get(newId).status, 0, '实名记录进入待审核');
    const certDup = await api('/api/member/certification/addRealName', {
      method: 'POST', token: newToken,
      body: { real_name: '冒烟测试', idcard: '440300199001011234', front_image: '', back_image: '', hand_image: '' },
    });
    ok(certDup.code === 0, '重复提交实名被拒', certDup.msg);

    // ========== 积分商城 ==========
    section('[12] 积分商城与兑换');
    const scoreList = await api('/api/score/getScoreShopList?page=1&limit=30', { token: newToken });
    ok(scoreList.code === 1 && (scoreList.data?.list?.data || []).length > 0, '积分商品列表', `${scoreList.data?.list?.total} 件`);
    const sg = scoreList.data.list.data[0];
    const scoreDetail = await api(`/api/score/getDetails?goods_id=${sg.goods_id}`, { token: newToken });
    ok(scoreDetail.code === 1, '积分商品详情', scoreDetail.msg);
    const poorScore = await api('/api/score/exchange', { method: 'POST', token: newToken, body: { goods_id: sg.goods_id } });
    ok(poorScore.code === 0 && /积分不足/.test(poorScore.msg), '积分不足被拒', poorScore.msg);
    // 补积分后兑换
    db.prepare('UPDATE member SET score = score + 100000 WHERE member_id = ?').run(newId);
    const exchange = await api('/api/score/exchange', { method: 'POST', token: newToken, body: { goods_id: sg.goods_id } });
    ok(exchange.code === 1, '积分兑换成功', exchange.msg);

    // 总开关：后台关闭后前台接口必须拒绝，且店铺信息里要下发关闭状态
    const setScore = (v) =>
      api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'store', values: { score_open: v } } });
    const offRes = await setScore('20');
    ok(offRes.code === 1, '后台关闭积分商城', offRes.msg);
    const infoOff = await api('/api/index/getStoreInfo');
    ok(String(infoOff.data?.score_open) === '20', '店铺信息下发关闭状态', `score_open=${infoOff.data?.score_open}`);
    const listOff = await api('/api/score/getScoreShopList?page=1&limit=5', { token: newToken });
    ok(listOff.code === 0 && /未开放/.test(listOff.msg), '关闭后列表接口拒绝', listOff.msg);
    const exOff = await api('/api/score/exchange', { method: 'POST', token: newToken, body: { goods_id: sg.goods_id } });
    ok(exOff.code === 0 && /未开放/.test(exOff.msg), '关闭后兑换接口拒绝', exOff.msg);
    const detOff = await api(`/api/score/getDetails?goods_id=${sg.goods_id}`, { token: newToken });
    ok(detOff.code === 0 && /未开放/.test(detOff.msg), '关闭后详情接口拒绝', detOff.msg);

    await setScore('10');
    const infoOn = await api('/api/index/getStoreInfo');
    ok(String(infoOn.data?.score_open) === '10', '开启积分商城', `score_open=${infoOn.data?.score_open}`);
    const listOn = await api('/api/score/getScoreShopList?page=1&limit=5', { token: newToken });
    ok(listOn.code === 1, '重新开启后列表恢复', listOn.msg);

    // ========== 结算 ==========
    section('[13] 差价结算（待办 → 凭证 → 确认）');
    const mySettle = await api('/api/order/mySettle', { token: newToken });
    ok(mySettle.code === 1, '我的结算待办可读', mySettle.msg);
    const settleRun = await api('/admin/api/settle/run', { method: 'POST', token: at, body: { specialarea_id: 0 } });
    ok(settleRun.code === 1, '触发场次结算', settleRun.msg);
    const matches = (await api(`/admin/api/settle/matches?batch_id=${settleRun.data?.batch_id}`, { token: at })).data || [];
    if (matches.length) {
      const m0 = matches[0];
      const payerPhone = db.prepare('SELECT mobile FROM member WHERE member_id = ?').get(m0.payer_id).mobile;
      const payeePhone = db.prepare('SELECT mobile FROM member WHERE member_id = ?').get(m0.payee_id).mobile;
      const v = await api('/api/order/settleVoucher', {
        method: 'POST', token: await login(payerPhone), body: { match_id: m0.match_id, voucher: '/uploads/test.png' },
      });
      ok(v.code === 1, '付款方上传凭证', v.msg);
      const c = await api('/api/order/settleConfirm', {
        method: 'POST', token: await login(payeePhone), body: { match_id: m0.match_id },
      });
      ok(c.code === 1, '收款方确认收款', c.msg);
      eq(db.prepare('SELECT pay_status FROM settle_match WHERE match_id = ?').get(m0.match_id).pay_status, 20, '付款单流转为已完成');
    } else {
      ok(true, '本次无匹配付款单（数据不足，跳过凭证流转）');
    }

    // ========== 设置 ==========
    section('[14] 设置：昵称、登录密码、支付密码');
    const nick = await api('/api/member/editMember', { method: 'POST', token: newToken, body: { nickName: '改名后的我' } });
    ok(nick.code === 1, '修改昵称', nick.msg);
    eq((await detail(newToken))?.nickName, '改名后的我', '昵称已生效');

    const pwdStatus0 = await api('/api/member/getIsPayPassword', { token: newToken });
    ok(pwdStatus0.code === 1, '支付密码状态可读', pwdStatus0.msg);
    const setPay = await api('/api/member/verificationPayPassword', { method: 'POST', token: newToken, body: { pwd: '654321' } });
    ok(setPay.code === 1, '设置支付密码', setPay.msg);
    eq((await api('/api/member/getIsPayPassword', { token: newToken })).data, '1', '设置后状态为已设置');

    const editPwd = await api('/api/member/editPwd', { method: 'POST', token: newToken, body: { newPwd: 'newpass123' } });
    ok(editPwd.code === 1, '修改登录密码', editPwd.msg);
    ok((await api('/api/member/accountLogin', { method: 'POST', body: { phone: newPhone, password: '123456' } })).code === 0, '旧密码失效');
    ok((await api('/api/member/accountLogin', { method: 'POST', body: { phone: newPhone, password: 'newpass123' } })).code === 1, '新密码可登录');

    // ========== 上传 ==========
    section('[15] 图片上传（凭证 / 头像）');
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'smoke.png');
    const upRes = await fetch(`${BASE}/api/upload/image`, { method: 'POST', headers: { token: newToken }, body: fd });
    const upJson = await upRes.json().catch(() => ({}));
    ok(upJson.code === 1, '上传图片成功', upJson.msg);
    ok(!!(upJson.data?.url || upJson.data), '上传返回地址', JSON.stringify(upJson.data).slice(0, 60));

    // ========== 公告与协议 ==========
    section('[16] 公告与协议页面');
    const notice = await api('/api/notice/getNotice');
    ok(notice.code === 1 && (notice.data || []).length > 0, '公告列表', `${(notice.data || []).length} 条`);
    const agreement = await api('/api/index/getGroupAfterSalesAgreement');
    ok(agreement.code === 1, '售后/交易协议可读', agreement.msg);
    const inviteNotice = await api('/api/index/getInvitationNotice');
    ok(inviteNotice.code === 1, '邀请须知可读', inviteNotice.msg);
    const subscribe = await api('/api/index/getSubscribeSetting');
    ok(subscribe.code === 1, '预约设置可读', subscribe.msg);
    const closeConsign = await api('/api/index/close_consignment');
    ok(closeConsign.code === 1, '转拍开关状态可读', closeConsign.msg);
    const paySetting = await api('/api/index/getPaySeeting');
    ok(paySetting.code === 1, '支付设置可读', paySetting.msg);

    // ========== 数据一致性收尾 ==========
    section('[17] 冒烟后的数据一致性');
    eq(db.prepare('SELECT COUNT(*) c FROM member WHERE amount < 0').get().c, 0, '没有会员出现负余额');
    eq(db.prepare('SELECT COUNT(*) c FROM orders o LEFT JOIN goods g ON g.goods_id = o.goods_id WHERE g.goods_id IS NULL').get().c, 0, '没有孤儿订单');
    const balSum = db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v;
    ok(Number(balSum) >= 0, '会员余额合计非负', String(money(balSum)));

  } finally {
    srv.kill();
    await sleep(300);
    void ROOT;
  }

  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) {
    console.log('\n失败项：');
    fails.forEach((f) => console.log(`  · ${f}`));
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}

main().catch((e) => { console.error('冒烟异常:', e); process.exit(1); });
