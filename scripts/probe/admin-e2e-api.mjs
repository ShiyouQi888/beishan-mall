// 后台端到端冒烟：17 个通用模块 CRUD + 全部专用操作 + 设置组 + 权限 + 结算 + 数据一致性
// 独立库（admin-smoke.db / 3401），不碰演示库
// 用法: node scripts/probe/admin-e2e-api.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3401;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'admin-smoke.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
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
  console.log('[setup] 初始化独立后台冒烟库…');
  await run('node', ['src/seed.js']);
  const { db } = await import('../../server/src/db.js');
  db.exec('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99');

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
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res.json();
  };

  try {
    // ================= 1. 登录与鉴权 =================
    section('[1] 登录与鉴权');
    const badLogin = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: 'wrong' } });
    ok(badLogin.code === 0, '错误密码被拒', badLogin.msg);
    const loginRes = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } });
    ok(loginRes.code === 1 && !!loginRes.data?.token, '超级管理员登录成功', loginRes.msg);
    const at = loginRes.data.token;
    ok(loginRes.data?.user?.role_id === 6, '登录返回角色信息', `role_id=${loginRes.data?.user?.role_id}`);

    const noToken = await api('/admin/api/member/list');
    ok(noToken.code !== 1, '无 token 访问被拒', noToken.msg);
    const badToken = await api('/admin/api/member/list', { token: 'invalid.token.here' });
    ok(badToken.code !== 1, '伪造 token 被拒', badToken.msg);

    const me = await api('/admin/api/me', { token: at });
    ok(me.code === 1 && me.data?.name === 'admin1', '当前管理员信息');
    const modules = await api('/admin/api/modules', { token: at });
    ok(modules.code === 1, '模块注册表可读');
    const modKeys = Object.keys(modules.data?.modules || modules.data || {});
    ok(modKeys.length >= 16, '模块数量完整', `${modKeys.length} 个`);

    // ================= 2. 通用列表与详情 =================
    section('[2] 16 个模块的列表与详情');
    const listCases = [
      ['goods', 'goods_id'], ['category', 'category_id'], ['specialarea', 'specialarea_id'],
      ['member', 'member_id'], ['orders', 'order_id'], ['certification', 'certification_id'],
      ['recycle', 'recycle_id'], ['delivery', 'template_id'],
      ['energy', 'energy_id'], ['withdraw', 'withdraw_id'], ['settle', 'id'],
      ['banner', 'banner_id'], ['navigation', 'id'], ['notice', 'id'],
      ['storeuser', 'store_user_id'], ['role', 'role_id'],
    ];
    for (const [mod, pk] of listCases) {
      const r = await api(`/admin/api/${mod}/list?page=1&limit=5`, { token: at });
      ok(r.code === 1 && Array.isArray(r.data?.data), `列表可读：${mod}`, r.msg);
      const first = (r.data?.data || [])[0];
      if (first && first[pk] !== undefined) {
        const d = await api(`/admin/api/${mod}/detail?id=${first[pk]}`, { token: at });
        ok(d.code === 1 && String(d.data?.[pk]) === String(first[pk]), `详情可读：${mod}`, d.msg);
      } else {
        ok(true, `详情跳过（无数据）：${mod}`);
      }
    }
    const badMod = await api('/admin/api/notamodule/list', { token: at });
    ok(badMod.code === 0, '不存在的模块被拒', badMod.msg);

    const pageLimit = await api('/admin/api/goods/list?page=1&limit=999', { token: at });
    ok((pageLimit.data?.data || []).length <= 100, 'limit 上限被钳制（≤100）', `${(pageLimit.data?.data || []).length} 条`);
    const searchRes = await api('/admin/api/goods/list?keyword=玉&page=1&limit=10', { token: at });
    ok(searchRes.code === 1, '列表关键字搜索', searchRes.msg);
    const filterRes = await api('/admin/api/goods/list?goods_status=10&page=1&limit=20', { token: at });
    ok((filterRes.data?.data || []).every((x) => Number(x.goods_status) === 10), '列表按字段筛选（goods_status=10）');
    // 商品不再自带场次：按场次筛选走关联表，返回的每一条都必须真的关联了该场
    const areaId = (await api('/admin/api/specialarea/list?page=1&limit=1', { token: at })).data?.data?.[0]?.specialarea_id;
    const areaFilter = await api(`/admin/api/goods/list?area_id=${areaId}&page=1&limit=50`, { token: at });
    ok((areaFilter.data?.data || []).length > 0
      && (areaFilter.data?.data || []).every((x) => (x._area_ids || []).includes(Number(areaId))),
      '列表按关联场次筛选');

    // 敏感字段不外泄
    const memberList = await api('/admin/api/member/list?limit=10', { token: at });
    const mRow = (memberList.data?.data || [])[0] || {};
    ok(!['password', 'pay_password', 'pay_setting', 'open_id', 'idcard', 'path', 'child_id'].some((k) => k in mRow),
      '会员列表不返回密码/收款/层级字段');
    const userList = await api('/admin/api/storeuser/list?limit=10', { token: at });
    ok(!('password' in ((userList.data?.data || [])[0] || {})), '管理员列表不返回密码');

    // ================= 3. 通用新增 / 编辑 =================
    section('[3] 通用新增与编辑（9 个可写模块）');
    const seedMeta = {
      category: { name: '冒烟分类', type: 2, sort: 900 },
      specialarea: { title_main: '冒烟场次', start_time: 0, end_time: 86399, open_days: '1,2,3,4,5,6,7', buy_num: 3, transposition_hours: 10 },
      delivery: { name: '冒烟运费模板', type: 1, first_num: 1, first_price: 10, add_num: 1, add_price: 5, is_open: 10, sort: 900 },
      banner: { type_id: 1, file_path: '/uploads/demo-1.svg', link_url: '#', sort: 900 },
      navigation: { title: '冒烟导航', icon_name: 'home', link_url: '/loot', type: 1, sort: 900, disabled: 10 },
      notice: { title: '冒烟公告', content: '冒烟测试内容', sort: 900 },
      role: { role_name: '冒烟角色', description: '冒烟测试用' },
      storeuser: { user_name: 'smoke_op', password: '123456', nick_name: '冒烟运营', role_id: 7, status: 10 },
      member: { nick_name: '冒烟会员', mobile: '13900003333', password: '123456', p_id: 1 },
      goods: { goods_name: '冒烟商品', goods_no: 'SMOKE-001', category_id: 1, specialarea_id: 1, member_id: 1, goods_min_price: 100, line_price: 200, stock_num: 1, goods_status: 10, sales_actual: 0, goods_sort: 900 },
    };
    const pkMap = {
      goods: 'goods_id', category: 'category_id', specialarea: 'specialarea_id', member: 'member_id',
      certification: 'certification_id', delivery: 'template_id',
      energy: 'energy_id', withdraw: 'withdraw_id', settle: 'id', banner: 'banner_id',
      navigation: 'id', notice: 'id', storeuser: 'store_user_id', role: 'role_id',
    };
    const created = {};
    for (const [mod, payload] of Object.entries(seedMeta)) {
      const r = await api(`/admin/api/${mod}/save`, { method: 'POST', token: at, body: payload });
      ok(r.code === 1 && r.data?.id, `新增：${mod}`, r.msg);
      created[mod] = r.data?.id;
    }

    // 编辑（用正确的业务主键回写，避免误走插入分支）
    const editCases = [
      ['category', { name: '冒烟分类改' }], ['specialarea', { title_main: '冒烟场次改' }],
      ['delivery', { name: '冒烟模板改' }],
      ['navigation', { title: '冒烟导航改' }], ['notice', { title: '冒烟公告改' }],
      ['banner', { sort: 901 }],
      ['role', { description: '冒烟测试改' }], ['member', { nick_name: '冒烟会员改' }],
      ['goods', { goods_name: '冒烟商品改' }],
    ];
    for (const [mod, patch] of editCases) {
      const r = await api(`/admin/api/${mod}/save`, {
        method: 'POST', token: at, body: { ...patch, [pkMap[mod]]: created[mod] },
      });
      ok(r.code === 1, `编辑：${mod}`, r.msg);
    }
    const catAfter = await api(`/admin/api/category/detail?id=${created.category}`, { token: at });
    eq(catAfter.data?.name, '冒烟分类改', '编辑后详情已变更');
    const memberAfter = await api(`/admin/api/member/detail?id=${created.member}`, { token: at });
    eq(memberAfter.data?.nick_name, '冒烟会员改', '会员昵称编辑生效');

    // 校验类断言
    const dupUser = await api('/admin/api/storeuser/save', { method: 'POST', token: at, body: { user_name: 'smoke_op', password: '123456', nick_name: 'x', role_id: 7, status: 10 } });
    ok(dupUser.code === 0 && /已存在/.test(dupUser.msg), '重复登录账号被拒', dupUser.msg);
    const shortPwd = await api('/admin/api/storeuser/save', { method: 'POST', token: at, body: { user_name: 'smoke_op2', password: '123', nick_name: 'x', role_id: 7, status: 10 } });
    ok(shortPwd.code === 0, '管理员密码过短被拒', shortPwd.msg);
    const badRole = await api('/admin/api/storeuser/save', { method: 'POST', token: at, body: { user_name: 'smoke_op3', password: '123456', nick_name: 'x', role_id: 9999, status: 10 } });
    ok(badRole.code === 0, '不存在的角色被拒', badRole.msg);
    const dupMobile = await api('/admin/api/member/save', { method: 'POST', token: at, body: { nick_name: 'x', mobile: '13900003333', password: '123456' } });
    ok(dupMobile.code === 0 && /已存在/.test(dupMobile.msg), '重复手机号被拒', dupMobile.msg);
    const badMobile = await api('/admin/api/member/save', { method: 'POST', token: at, body: { nick_name: 'x', mobile: '123', password: '123456' } });
    ok(badMobile.code === 0, '手机号格式校验', badMobile.msg);
    const orderSave = await api('/admin/api/orders/save', { method: 'POST', token: at, body: { status: 30, id: 1 } });
    ok(orderSave.code === 0 && /专用操作/.test(orderSave.msg), '订单禁止走通用保存', orderSave.msg);
    const emptySave = await api('/admin/api/category/save', { method: 'POST', token: at, body: {} });
    ok(emptySave.code === 0, '空字段保存被拒', emptySave.msg);

    // ================= 4. 业务记录不可删除 =================
    section('[4] 业务记录的删除保护');
    // 订单/流水/提现/结算/实名：通用删除直接禁止
    for (const mod of ['orders', 'energy', 'withdraw', 'settle', 'certification']) {
      const r = await api(`/admin/api/${mod}/remove`, { method: 'POST', token: at, body: { id: 1 } });
      ok(r.code === 0 && /审计/.test(r.msg), `禁止删除：${mod}`, r.msg);
    }
    // 会员走专用删除接口：有业务记录时按原因拦截，并引导改用禁用
    const memberDel = await api('/admin/api/member/remove', { method: 'POST', token: at, body: { ids: [1] } });
    ok(memberDel.code === 0 && /禁用/.test(memberDel.msg), '有业务记录的会员不可删除（建议禁用）', memberDel.msg);
    const noIdRemove = await api('/admin/api/category/remove', { method: 'POST', token: at, body: {} });
    ok(noIdRemove.code === 0, '删除未指定记录被拒', noIdRemove.msg);

    // ================= 5. 订单专用操作 =================
    section('[5] 订单：详情 / 确认收款 / 审核 / 取消');
    const buyerToken = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13800000001', password: '13800000001' } })).data?.token;
    const buyerMid = buyerIdOf(db);
    const pickGoods = () => db.prepare(
      'SELECT goods_id FROM goods WHERE goods_status = 10 AND type = 1 AND member_id <> ? LIMIT 1',
    ).get(buyerMid)?.goods_id;
    const gid = pickGoods();
    ok(!!gid, '找到可用于订单测试的商品');
    // 线下凭证默认是关闭的（pay_bank=20），测试前先打开
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'pay', values: { pay_bank: '10' } } });
    const madeOrder = await api('/api/order/toAddOrder', { method: 'POST', token: buyerToken, body: { goods_id: gid, num: 1, pay_type: 4 } });
    ok(madeOrder.code === 1, '构造后台测试订单', madeOrder.msg);
    const tOid = madeOrder.data.order_id;

    const od = await api(`/admin/api/orders/detail?id=${tOid}`, { token: at });
    ok(od.code === 1 && od.data?.order_id === tOid, '订单详情');
    // 新规则：线下转账必须先由会员上传支付凭证，后台才能确认收款
    await api('/api/order/toPay', { method: 'POST', token: buyerToken, body: { order_id: tOid, pay_type: 4, voucher: '/uploads/demo-1.svg' } });
    const confirmPay = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: tOid } });
    ok(confirmPay.code === 1, '线下凭证：确认收款', confirmPay.msg);
    eq(db.prepare('SELECT pay_status FROM orders WHERE order_id = ?').get(tOid).pay_status, 10, '确认收款后 pay_status=10');
    // 发货环节已整体下线：接口没了，订单状态也不会再走到「待收货」
    const deliver = await api('/admin/api/orders/deliver', { method: 'POST', token: at, body: { order_id: tOid } });
    ok(deliver.code !== 1 && /接口不存在/.test(deliver.msg), '发货接口已下线', deliver.msg);
    eq(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(tOid).status, 10, '支付后状态停在 10，不再流转到待收货');

    const gid2 = pickGoods();
    const cancelTarget = gid2
      ? await api('/api/order/toAddOrder', { method: 'POST', token: buyerToken, body: { goods_id: gid2, num: 1, pay_type: 1 } })
      : { code: 0, msg: '无可买商品' };
    ok(cancelTarget.code === 1, '构造待取消订单', cancelTarget.msg);
    const cancelOrder = await api('/admin/api/orders/cancel', { method: 'POST', token: at, body: { order_id: cancelTarget.data?.order_id } });
    ok(cancelOrder.code === 1, '后台取消订单', cancelOrder.msg);
    eq(db.prepare('SELECT status FROM orders WHERE order_id = ?').get(cancelTarget.data?.order_id).status, 40, '取消后状态 40');

    // 审核（寄卖/寄买订单走审核流）
    const auditTarget = await api('/admin/api/orders/set-goods-order', { method: 'POST', token: at, body: { goods_id: gid, member_id: 3, price: 888 } });
    ok(auditTarget.code === 1, '后台创建寄买订单', auditTarget.msg);
    const audit = await api('/admin/api/orders/audit', { method: 'POST', token: at, body: { order_id: auditTarget.data.order_id, pass: true } });
    ok(audit.code === 1, '订单审核通过', audit.msg);

    const imp = await api('/admin/api/orders/import', { method: 'POST', token: at, body: { rows: [{ goods_id: gid, member_id: 3, price: 500, num: 2 }] } });
    ok(imp.code === 1 && imp.data?.okCount === 1, '批量导入订单', imp.msg);
    const impBad = await api('/admin/api/orders/import', { method: 'POST', token: at, body: { rows: [{ goods_id: 999999, member_id: 3 }] } });
    ok(impBad.data?.failCount === 1, '导入失败行返回原因', JSON.stringify(impBad.data?.errors?.[0]));
    // ================= 6. 会员专用操作 =================
    section('[6] 会员：调账 / 提前抢购 / 清佣金 / 流水 / 团队订单');
    const mid = created.member;
    const balBefore = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(mid).amount);
    const adj = await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '冒烟调账' } });
    ok(adj.code === 1, '会员调账', adj.msg);
    num(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(mid).amount, money(balBefore + 5000), '调账金额落库');
    const adjReason = db.prepare('SELECT remarks FROM finance_energy WHERE member_id = ? ORDER BY energy_id DESC LIMIT 1').get(mid);
    ok(!!adjReason, '调账生成资金流水', adjReason?.remarks || '');

    const adv = await api('/admin/api/member/advance', { method: 'POST', token: at, body: { member_id: mid, enable: true, count: 3 } });
    ok(adv.code === 1, '提前抢购授权', adv.msg);
    const advRow = db.prepare('SELECT is_advance, advance_count FROM member WHERE member_id = ?').get(mid);
    eq(advRow.is_advance, 10, '授权后 is_advance=10');
    eq(advRow.advance_count, 3, '授权次数落库');

    db.prepare('UPDATE member SET e_card_number = 200 WHERE member_id = ?').run(mid);
    const clearC = await api('/admin/api/member/clear-commission', { method: 'POST', token: at, body: { member_id: mid } });
    ok(clearC.code === 1, '清除佣金', clearC.msg);
    num(db.prepare('SELECT e_card_number e FROM member WHERE member_id = ?').get(mid).e, 0, '清除后佣金归零');

    const er = await api(`/admin/api/member/energy-record?member_id=${mid}`, { token: at });
    ok(er.code === 1 && er.data?.scope === 'award', '会员返佣流水可读（默认只看返佣）', er.msg);
    const erAll = await api(`/admin/api/member/energy-record?member_id=${mid}&scope=all`, { token: at });
    ok(erAll.code === 1 && erAll.data?.scope === 'all', '会员全部资金流水可读（scope=all）', erAll.msg);
    ok((erAll.data?.list || []).length >= (er.data?.list || []).length, '全部流水不少于返佣流水',
      `${(erAll.data?.list || []).length} vs ${(er.data?.list || []).length}`);
    const to = await api('/admin/api/member/team-orders?member_id=1', { token: at });
    ok(to.code === 1 && to.data?.team_count >= 1, '团队订单视图', `团队 ${to.data?.team_count} 人`);

    // ================= 7.5 商品复制 =================
    section('[7] 商品复制');
    {
      // 挑一件会员持有的商品：复制出来的必须归平台并下架，不能凭空空投给会员
      const src = db.prepare('SELECT * FROM goods WHERE type = 1 AND member_id > 0 ORDER BY goods_id LIMIT 1').get();
      if (src) {
        const dup = await api('/admin/api/goods/duplicate', { method: 'POST', token: at, body: { goods_id: src.goods_id } });
        ok(dup.code === 1, '复制商品成功', dup.msg);
        const c = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(dup.data.goods_id);
        ok(/（副本）$/.test(c.goods_name), '名称带「（副本）」后缀', c.goods_name);
        ok(c.goods_no && c.goods_no !== src.goods_no, '商品编码重新生成', c.goods_no);
        ok(Number(c.member_id) === 0, '新商品归平台（不空投给原持有人）', `member_id=${c.member_id}`);
        ok(Number(c.goods_status) === 20 && Number(c.is_sell) === 0, '新商品默认下架，待确认后上架');
        ok(Number(c.turn_beat_num) === 0 && Number(c.sales_actual) === 0, '转拍次数与销量归零');
        ok(!c.area_date, '不继承原商品的场次日期');
        ok(c.good_thumb === src.good_thumb && c.detail === src.detail && Number(c.category_id) === Number(src.category_id),
          '图片/详情/分类已复制');
        ok(Number(c.goods_min_price) === Number(src.goods_min_price), '价格已复制');

        const dupBad = await api('/admin/api/goods/duplicate', { method: 'POST', token: at, body: { goods_id: 999999 } });
        ok(dupBad.code !== 1, '复制不存在的商品被拒', dupBad.msg);
      } else {
        ok(true, '无会员持有商品（跳过）');
      }
    }

    // ================= 9. 补发奖 / 实名 / 提现审核 =================
    section('[8] 补发直推奖、实名审核、提现审核');

    // 补发直推奖需要一个「有上级」的买家订单
    const subToken = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13900003333', password: '123456' } })).data?.token;
    const subGid = db.prepare(
      `SELECT goods_id FROM goods WHERE goods_status = 10 AND type = 1
       AND member_id NOT IN (?, ?) ORDER BY goods_id LIMIT 1`,
    ).get(buyerMid, created.member)?.goods_id;
    // 补发测试需要买得起：先把余额补足
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at,
      body: { member_id: created.member, field: 'amount', value: 200000, remark: '补发测试注资' },
    });
    const subOrder = subGid
      ? await api('/api/order/toAddOrder', { method: 'POST', token: subToken, body: { goods_id: subGid, num: 1, pay_type: 1 } })
      : { code: 0, msg: '无可买商品' };
    ok(subOrder.code === 1, '构造有上级的买家订单', subOrder.msg);
    if (subOrder.code === 1) {
      const subPay = await api('/api/order/toPay', { method: 'POST', token: subToken, body: { order_id: subOrder.data.order_id, pay_type: 1 } });
      ok(subPay.code === 1, '买家订单支付（补发前提）', subPay.msg);
      // 模拟「当时漏发」：清掉支付时自动产生的直推奖记录，再走补发
      const tag = `订单 ${subOrder.data.order_no} 大账买单直推奖`;
      db.prepare('DELETE FROM finance_energy WHERE type = 1 AND remarks = ?').run(tag);
      const award = await api('/admin/api/award/grant', { method: 'POST', token: at, body: { order_id: subOrder.data.order_id, remark: '冒烟补发' } });
      ok(award.code === 1, '补发直推奖', award.msg);
      const awardDup = await api('/admin/api/award/grant', { method: 'POST', token: at, body: { order_id: subOrder.data.order_id, remark: '冒烟补发' } });
      ok(awardDup.code === 0 && /已发放/.test(awardDup.msg), '同一订单不重复补发', awardDup.msg);
    }

    // 实名审核
    const certRow = db.prepare('SELECT * FROM member_certification WHERE status = 0 LIMIT 1').get();
    if (certRow) {
      const certAudit = await api('/admin/api/certification/audit', { method: 'POST', token: at, body: { certification_id: certRow.certification_id, pass: true } });
      ok(certAudit.code === 1, '实名审核通过', certAudit.msg);
      eq(db.prepare('SELECT status FROM member_certification WHERE certification_id = ?').get(certRow.certification_id).status, 10, '实名状态流转');
      eq(db.prepare('SELECT is_certification FROM member WHERE member_id = ?').get(certRow.member_id).is_certification, 1, '会员标记为已实名');
    } else {
      ok(true, '无待审实名记录（跳过）');
    }

    // 提现审核：通过 + 驳回退回
    const wdId = db.prepare(
      `INSERT INTO finance_withdraw (member_id, amount, fee, actual_amount, account_info, status, create_time)
       VALUES (?,?,?,?,?,0,datetime('now','localtime'))`,
    ).run(mid, 200, 2, 198, '冒烟卡');
    const wdRowId = Number(wdId.lastInsertRowid);
    const wdPass = await api('/admin/api/withdraw/audit', { method: 'POST', token: at, body: { withdraw_id: wdRowId, pass: true, remark: '冒烟通过' } });
    ok(wdPass.code === 1, '提现审核通过', wdPass.msg);
    eq(db.prepare('SELECT status FROM finance_withdraw WHERE withdraw_id = ?').get(wdRowId).status, 10, '提现状态=已通过');
    const wdAgain = await api('/admin/api/withdraw/audit', { method: 'POST', token: at, body: { withdraw_id: wdRowId, pass: false } });
    ok(wdAgain.code === 0, '已处理提现不可重复审核', wdAgain.msg);

    const wd2 = db.prepare(
      `INSERT INTO finance_withdraw (member_id, amount, fee, actual_amount, account_info, status, create_time)
       VALUES (?,?,?,?,?,0,datetime('now','localtime'))`,
    ).run(mid, 300, 3, 297, '冒烟卡2');
    const wd2Id = Number(wd2.lastInsertRowid);
    db.prepare('UPDATE member SET amount = amount - 300 WHERE member_id = ?').run(mid);
    const beforeReject = Number(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(mid).amount);
    const wdReject = await api('/admin/api/withdraw/audit', { method: 'POST', token: at, body: { withdraw_id: wd2Id, pass: false, remark: '冒烟驳回' } });
    ok(wdReject.code === 1, '提现驳回', wdReject.msg);
    num(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(mid).amount, money(beforeReject + 300), '驳回后金额退回');

    // ================= 10. 设置组 =================
    section('[9] 设置组读写（7 组）');
    const groups = ['store', 'trade', 'pay', 'storage', 'poster', 'prompt', 'nav'];
    for (const g of groups) {
      const r = await api(`/admin/api/setting/${g}`, { token: at });
      ok(r.code === 1 && (r.data?.items || []).length > 0, `设置组可读：${g}`, `${(r.data?.items || []).length} 项`);
    }
    const storeSet = await api('/admin/api/setting/store', { token: at });
    ok((storeSet.data?.items || []).some((x) => x.k === 'score_open'), '商城设置含「积分商城」开关');
    const tradeSet = await api('/admin/api/setting/trade', { token: at });
    const firstTradeKey = tradeSet.data.items[0].k;
    const originVal = tradeSet.data.values[firstTradeKey];
    const saveSet = await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { [firstTradeKey]: '7' } } });
    ok(saveSet.code === 1, '保存设置', saveSet.msg);
    eq((await api('/admin/api/setting/trade', { token: at })).data.values[firstTradeKey], '7', '设置保存后可回读');
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { [firstTradeKey]: originVal } } });
    const badGroup = await api('/admin/api/setting/notagroup', { token: at });
    ok(badGroup.code === 0, '不存在的设置组被拒', badGroup.msg);

    // ================= 11. 权限：菜单 / 节点 / 角色 =================
    section('[10] 权限：菜单下发 / 节点树 / 角色授权');
    const menu = await api('/admin/api/menu', { token: at });
    const menuCount = (menu.data?.menus || []).reduce((s, g) => s + g.items.length, 0);
    // 不写死条数：菜单会随业务增删，这里只要求「全量下发且结构完整」
    ok(menu.code === 1 && menuCount >= 20 && (menu.data?.menus || []).length >= 6,
      '超管菜单全量下发', `${(menu.data?.menus || []).length} 组 / ${menuCount} 项`);
    const myPaths = await api('/admin/api/my-paths', { token: at });
    ok(myPaths.data?.unrestricted === true, '超管不受权限限制');
    const tree = await api('/admin/api/node/tree', { token: at });
    ok(tree.code === 1 && (tree.data?.tree || []).length >= 5, '节点树可读', `${(tree.data?.tree || []).length} 组`);
    eq(tree.data?.super_role_id, 6, '超管角色 ID 为 6');

    const roleList = await api('/admin/api/role/list?limit=10', { token: at });
    const opRole = (roleList.data?.data || []).find((r) => Number(r.role_id) !== 6);
    ok(!!opRole, '存在非超管角色');
    const grp = tree.data.tree.find((g) => g.name === '产品管理') || tree.data.tree[0];
    const saveNodes = await api('/admin/api/role/nodes', {
      method: 'POST', token: at, body: { role_id: opRole.role_id, node_ids: [grp.id, ...grp.children.map((c) => c.id)] },
    });
    ok(saveNodes.code === 1, '角色授权保存', saveNodes.msg);
    const rn = await api(`/admin/api/role/nodes?role_id=${opRole.role_id}`, { token: at });
    ok((rn.data?.node_ids || []).length >= 2, '角色节点可回读', `${(rn.data?.node_ids || []).length} 个`);
    const superNodes = await api('/admin/api/role/nodes', { method: 'POST', token: at, body: { role_id: 6, node_ids: [1] } });
    ok(superNodes.code === 0, '超管权限不可修改', superNodes.msg);
    const ghostRole = await api('/admin/api/role/nodes', { method: 'POST', token: at, body: { role_id: 99999, node_ids: [1] } });
    ok(ghostRole.code === 0, '不存在的角色被拒', ghostRole.msg);

    // 受限账号只能拿到被授权的菜单
    const opToken = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'smoke_op', password: '123456' } })).data?.token;
    ok(!!opToken, '受限账号可登录');
    const opMenu = await api('/admin/api/menu', { token: opToken });
    const opCount = (opMenu.data?.menus || []).reduce((s, g) => s + g.items.length, 0);
    ok(opCount > 0 && opCount < menuCount, '受限账号菜单被裁剪', `${opCount}/${menuCount}`);
    const opPaths = await api('/admin/api/my-paths', { token: opToken });
    ok(opPaths.data?.unrestricted === false, '受限角色返回明确权限集合');
    const denyMember = await api('/admin/api/member/list', { token: opToken });
    ok(denyMember.code !== 1, '受限角色访问未授权模块被拒', denyMember.msg);
    const denySetting = await api('/admin/api/setting/trade', { token: opToken });
    ok(denySetting.code !== 1, '受限角色访问未授权设置被拒', denySetting.msg);

    // ================= 12. 统计与运维 =================
    section('[11] 仪表盘、统计、系统信息、缓存');
    const dash = await api('/admin/api/dashboard', { token: at });
    ok(dash.code === 1, '仪表盘数据', dash.msg);
    const statsGoods = await api('/admin/api/stats/goods', { token: at });
    ok(statsGoods.code === 1, '商品统计', statsGoods.msg);
    const statsOrders = await api('/admin/api/stats/today-orders', { token: at });
    ok(statsOrders.code === 1, '今日订单统计', statsOrders.msg);
    const sysinfo = await api('/admin/api/sysinfo', { token: at });
    ok(sysinfo.code === 1 && sysinfo.data?.counts?.member >= 1, '系统信息', JSON.stringify(sysinfo.data?.counts || {}).slice(0, 60));
    const rnBase = await api('/admin/api/notifications/recycles', { token: at });
    ok(rnBase.code === 1 && Number.isInteger(rnBase.data?.latest_id), '回收通知基线可读', rnBase.msg);
    const rnNew = await api('/admin/api/notifications/recycles?after_id=0', { token: at });
    ok(rnNew.code === 1 && Array.isArray(rnNew.data?.items), '回收通知增量可读', rnNew.msg);
    const cache = await api('/admin/api/cache/clear', { method: 'POST', token: at });
    ok(cache.code === 1, '清理缓存', cache.msg);
    for (const opt of ['role', 'category', 'specialarea']) {
      const r = await api(`/admin/api/options/${opt}`, { token: at });
      ok(r.code === 1, `下拉选项可读：${opt}`, r.msg);
    }

    // ================= 13. 差价对账已下线 =================
    section('[12] 差价对账：接口与页面已全部删除');
    const srun = await api('/admin/api/settle/run', { method: 'POST', token: at, body: { specialarea_id: 0 } });
    ok(srun.code !== 1, '后台差价对账接口已删除', srun.msg);
    const batches = await api('/admin/api/settle/batches', { token: at });
    ok(batches.code !== 1, '结算批次接口已删除', batches.msg);

    // ================= 14. 文件管理 =================
    section('[13] 文件管理：分组 / 上传 / 改名 / 移动 / 引用保护 / 删除');
    const mg = await api('/admin/api/media/groups', { token: at });
    ok(mg.code === 1 && typeof mg.data?.total === 'number', '素材库可读', `共 ${mg.data?.total} 个文件`);
    const noAuthMedia = await fetch(`${BASE}/admin/api/media/list`).then((r) => r.json());
    ok(noAuthMedia.code !== 1, '未登录不能读素材库');

    const gCreate = await api('/admin/api/media/group/save', { method: 'POST', token: at, body: { name: '冒烟素材组' } });
    ok(gCreate.code === 1 && gCreate.data?.group_id, '新建分组', gCreate.msg);
    const mgid = gCreate.data?.group_id;
    ok((await api('/admin/api/media/group/save', { method: 'POST', token: at, body: { name: '冒烟素材组' } })).code === 0, '分组重名被拒');

    const PNG_1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const uploadMedia = async (name, groupId) => {
      const fd = new FormData();
      fd.append('file', new Blob([PNG_1x1], { type: 'image/png' }), name);
      if (groupId !== undefined) fd.append('group_id', String(groupId));
      return fetch(`${BASE}/admin/api/media/upload`, { method: 'POST', headers: { token: at }, body: fd }).then((r) => r.json());
    };

    const upA = await uploadMedia('冒烟图.png', mgid);
    ok(upA.code === 1 && !!upA.data?.file_id, '上传图片入库', upA.msg);
    ok(upA.data?.name === '冒烟图', '中文文件名不乱码', `实际 ${upA.data?.name}`);
    ok(Number(upA.data?.width) === 1 && Number(upA.data?.height) === 1, '解析图片宽高', `${upA.data?.width}×${upA.data?.height}`);
    eq(Number(upA.data?.group_id), mgid, '上传直接落到指定分组');
    const fidA = upA.data.file_id;

    const inGroup = await api(`/admin/api/media/list?group_id=${mgid}`, { token: at });
    ok((inGroup.data?.list || []).some((f) => f.file_id === fidA), '按分组筛选能查到');
    ok((await api('/admin/api/media/rename', { method: 'POST', token: at, body: { file_id: fidA, name: '冒烟改名图' } })).code === 1, '重命名');
    ok((await api('/admin/api/media/move', { method: 'POST', token: at, body: { ids: [fidA], group_id: 0 } })).code === 1, '移动到未分组');
    const refsA = await api(`/admin/api/media/refs?file_id=${fidA}`, { token: at });
    ok(refsA.code === 1 && (refsA.data?.usages || []).length === 0, '新图没有任何引用');
    const delA = await api('/admin/api/media/remove', { method: 'POST', token: at, body: { ids: [fidA] } });
    ok(delA.code === 1 && Number(delA.data?.deleted) === 1, '删除无引用文件', delA.msg);
    ok((await api(`/admin/api/media/refs?file_id=${fidA}`, { token: at })).code === 0, '删除后记录已消失');

    // 引用保护：传一张图挂到广告上，再尝试删除
    const upB = await uploadMedia('冒烟广告图.png');
    const fidB = upB.data?.file_id;
    const bannerSave = await api('/admin/api/banner/save', {
      method: 'POST', token: at, body: { type_id: 1, file_path: upB.data?.path, link_url: '#', sort: 902 },
    });
    ok(bannerSave.code === 1 && !!bannerSave.data?.id, '用该图创建一条广告', bannerSave.msg);
    const refsB = await api(`/admin/api/media/refs?file_id=${fidB}`, { token: at });
    ok((refsB.data?.usages || []).some((u) => u.includes('广告')), '能查出引用来源', (refsB.data?.usages || []).join('、'));
    const delB = await api('/admin/api/media/remove', { method: 'POST', token: at, body: { ids: [fidB] } });
    ok(delB.code === 1 && Number(delB.data?.deleted) === 0 && (delB.data?.skipped || []).length === 1, '被广告引用的图拒绝删除', delB.msg);
    await api('/admin/api/banner/save', {
      method: 'POST', token: at,
      body: { banner_id: bannerSave.data.id, type_id: 1, file_path: '/uploads/demo-2.svg', link_url: '#', sort: 902 },
    });
    const delB2 = await api('/admin/api/media/remove', { method: 'POST', token: at, body: { ids: [fidB] } });
    ok(delB2.code === 1 && Number(delB2.data?.deleted) === 1, '取消引用后可以删除', delB2.msg);
    await api('/admin/api/banner/remove', { method: 'POST', token: at, body: { ids: [bannerSave.data.id] } });
    ok((await api('/admin/api/media/group/remove', { method: 'POST', token: at, body: { group_id: mgid } })).code === 1, '删除分组');

    // ================= 15. 分类：一键首页显示 =================
    section('[14] 分类：一键上/下首页');
    const homeOn = await api('/admin/api/category/home-show-all', { method: 'POST', token: at, body: { value: 10 } });
    ok(homeOn.code === 1 && Number(homeOn.data?.count) > 0, '一键全部上首页', homeOn.msg);
    const homeCats = await api('/api/goods/getCategory?home=1');
    ok((homeCats.data?.categoryList || []).length > 0, '首页分类接口有数据', `${(homeCats.data?.categoryList || []).length} 个`);

    const homeOff = await api('/admin/api/category/home-show-all', { method: 'POST', token: at, body: { value: 20 } });
    ok(homeOff.code === 1 && Number(homeOff.data?.count) > 0, '一键全部隐藏', homeOff.msg);
    const homeEmpty = await api('/api/goods/getCategory?home=1');
    eq((homeEmpty.data?.categoryList || []).length, 0, '隐藏后首页分类为空（H5 整条不渲染）');
    // 不影响「分类页」：不带 home 参数仍返回全部
    const catAll = await api('/api/goods/getCategory');
    ok((catAll.data?.categoryList || []).length > 0, '分类页仍能拿到全部分类');

    const badValue = await api('/admin/api/category/home-show-all', { method: 'POST', token: at, body: { value: 99 } });
    ok(badValue.code === 0, '非法值被拒', badValue.msg);
    await api('/admin/api/category/home-show-all', { method: 'POST', token: at, body: { value: 10 } });

    // ================= 16. 数据一致性 =================
    section('[15] 数据一致性');
    eq(db.prepare('SELECT COUNT(*) c FROM member WHERE amount < 0').get().c, 0, '没有会员出现负余额');
    eq(db.prepare('SELECT COUNT(*) c FROM orders o LEFT JOIN goods g ON g.goods_id = o.goods_id WHERE g.goods_id IS NULL').get().c, 0, '没有孤儿订单');
    ok(db.prepare('SELECT COUNT(*) c FROM store_role_node WHERE role_id NOT IN (SELECT role_id FROM store_role)').get().c === 0, '没有孤儿权限绑定');
    ok(db.prepare('SELECT COUNT(*) c FROM store_node WHERE action_name <> \'\'').get().c > 0, '权限节点表非空');
    const dupRole = db.prepare('SELECT role_name, COUNT(*) c FROM store_role GROUP BY role_name HAVING c > 1').all();
    eq(dupRole.length, 0, '角色名无重复');
    const balSum = db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v;
    ok(Number(balSum) >= 0, '会员余额合计非负', String(money(balSum)));

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

function buyerIdOf(db) {
  return db.prepare("SELECT member_id id FROM member WHERE mobile='13800000001'").get().id;
}

main().catch((e) => { console.error('冒烟异常:', e); process.exit(1); });
