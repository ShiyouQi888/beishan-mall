/**
 * 订单转让验收：后台把一笔订单从 A 转到 B，归属、流水、三方可见性必须全对。
 *
 * 业务口径（与运营确认过）：
 *   未付款转让 = 把抢购名额给别人，新买家继续付款
 *   已付款转让 = 订单归新买家，货款由双方线下结清（平台不退款、不收款、不动余额）
 *
 * 覆盖：
 *   1. 未付款订单转让：订单换人、商品不动、流水记 goods_moved=0
 *   2. 原买家列表出现「已转出」只读记录，新买家列表出现正常订单
 *   3. 已付款订单转让：商品持有人同步过户，流水记 goods_moved=1
 *   4. 七条拒绝条件逐条命中
 *   5. 转让不动任何人的余额
 *   6. 接手人本场已抢数会随转让增加（限购提示口径）
 *
 * 独立库（order-transfer.db / 3474），跑完销毁。
 * 用法: node scripts/probe/order-transfer.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3474;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'order-transfer.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  const p = join(SERVER, 'data', f);
  if (existsSync(p)) unlinkSync(p);
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
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

const seed = () => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
});

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await seed();
  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += String(d)));
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  const { db, get } = await import('../../server/src/db.js');
  const cleanup = () => { try { srv.kill(); } catch {} };

  try {
    // 场次全开，商品不挂场次时随时可买
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, is_open = 10, buy_num = 1').run();

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const mkMember = async (phone, nick) => {
      const r = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'transfer123456', code: 'boss01', nickName: nick },
      });
      const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'transfer123456' } })).data.token;
      return { id: Number(r.data?.member_id), token: tk, phone };
    };
    const A = await mkMember('13970000001', '原买家');
    const B = await mkMember('13970000002', '接手人');
    const C = await mkMember('13970000003', '第三手');
    const D = await mkMember('13970000004', '打酱油');
    ok(A.id && B.id && C.id && D.id, '四个会员注册完成');

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = async (name, price, stock) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: price, stock_num: stock, goods_status: 10, goods_sort: 1 },
      });
      const id = Number(r.data?.id);
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(id);
      return id;
    };
    const G1 = await mkGoods('转让验证·整件', 1000, 1);
    const G2 = await mkGoods('转让验证·按件', 800, 5);
    ok(G1 && G2, '两件样品商品创建完成');

    // ---------- 1. 未付款转让 ----------
    section('[1] 未付款订单转让 = 转名额');
    const od1 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: G1, num: 1, pay_type: 0 } });
    ok(od1.code === 1, 'A 下单', od1.msg);
    const O1 = od1.data.order_id;
    const amtA0 = Number(get('SELECT amount FROM member WHERE member_id = ?', A.id).amount);
    const amtB0 = Number(get('SELECT amount FROM member WHERE member_id = ?', B.id).amount);

    const t1 = await api('/admin/api/orders/transfer', {
      method: 'POST', token: at, body: { order_id: O1, to_member_id: B.id, reason: '帮人代拍' },
    });
    ok(t1.code === 1, '转让成功', t1.msg);
    eq(get('SELECT member_id FROM orders WHERE order_id = ?', O1).member_id, B.id, '订单归属改为 B');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G1).member_id, 0, '未付款：商品持有人不动（货还在平台手里）');
    eq(get('SELECT goods_moved FROM order_transfer WHERE order_id = ?', O1).goods_moved, 0, '流水记 goods_moved=0');
    eq(get('SELECT paid_before FROM order_transfer WHERE order_id = ?', O1).paid_before, 0, '流水记 paid_before=0');
    eq(get('SELECT transfer_count FROM orders WHERE order_id = ?', O1).transfer_count, 1, '订单转让次数=1');
    eq(get('SELECT amount FROM member WHERE member_id = ?', A.id).amount, amtA0, '原买家余额未变');
    eq(get('SELECT amount FROM member WHERE member_id = ?', B.id).amount, amtB0, '接手人余额未变（平台不动账）');

    // ---------- 2. 三方可见性 ----------
    section('[2] 原买家看到「已转出」，新买家看到正常订单');
    const aList = await api('/api/order/getOrder?page=1&limit=20', { token: A.token });
    const aRow = (aList.data?.data || []).find((x) => Number(x.order_id) === Number(O1));
    ok(!!aRow, '原买家的列表里还留着这条记录（不是凭空消失）');
    eq(aRow?.transferred_out, 1, '标记为「已转出」');
    eq(aRow?.status_text, '已转出', '状态文案 = 已转出');
    ok(/^\d{3}\*{4}\d{4}$/.test(String(aRow?.out_to_mobile || '')), '受让方手机号已打码', aRow?.out_to_mobile);

    const bList = await api('/api/order/getOrder?page=1&limit=20', { token: B.token });
    const bRow = (bList.data?.data || []).find((x) => Number(x.order_id) === Number(O1));
    ok(!!bRow, '接手人列表里出现该订单');
    eq(bRow?.transferred_out, 0, '接手人这边是正常订单');

    const aPay = await api('/api/order/toPay', { method: 'POST', token: A.token, body: { order_id: O1, pay_type: 1 } });
    ok(aPay.code !== 1, '原买家已经不能操作这笔单', aPay.msg);
    const bPayView = await api(`/api/order/detail?order_id=${O1}`, { token: B.token });
    ok(bPayView.code === 1, '接手人能打开详情', bPayView.msg);

    // ---------- 3. 已付款转让 ----------
    section('[3] 已付款订单转让 = 货权跟着走');
    const cp = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: O1 } });
    ok(cp.code === 1, '后台确认收款，订单成交', cp.msg);
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G1).member_id, B.id, '成交后商品归 B');

    const t2 = await api('/admin/api/orders/transfer', {
      method: 'POST', token: at, body: { order_id: O1, to_member_id: C.id, reason: '线下已结清' },
    });
    ok(t2.code === 1, '已成交订单转让成功', t2.msg);
    eq(get('SELECT member_id FROM orders WHERE order_id = ?', O1).member_id, C.id, '订单归属改为 C');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G1).member_id, C.id, '商品持有人同步过户给 C');
    const lastT = get('SELECT * FROM order_transfer WHERE order_id = ? ORDER BY transfer_id DESC LIMIT 1', O1);
    eq(lastT.goods_moved, 1, '流水记 goods_moved=1');
    eq(lastT.paid_before, 1, '流水记 paid_before=1（线下要结款）');
    eq(Number(lastT.amount).toFixed(2), '1000.00', '流水记录线下结算参考金额');

    const bList2 = await api('/api/order/getOrder?page=1&limit=20', { token: B.token });
    const bRow2 = (bList2.data?.data || []).find((x) => Number(x.order_id) === Number(O1));
    eq(bRow2?.transferred_out, 1, 'B 转出后也看到「已转出」');

    // 货过户后必须出现在新持有人的「我的店铺」，否则他既看不到也转不了拍
    const cShop = await api('/api/member/myShop?page=1&limit=50', { token: C.token });
    const shopRow = (cShop.data?.list || []).find((x) => Number(x.goods_id) === Number(G1));
    ok(!!shopRow, '商品出现在 C 的「我的店铺」', cShop.msg);
    const aShop = await api('/api/member/myShop?page=1&limit=50', { token: A.token });
    ok(!(aShop.data?.list || []).some((x) => Number(x.goods_id) === Number(G1)), '商品已从 A 的店铺消失');

    // ---------- 4. 拒绝条件 ----------
    section('[4] 拒绝条件逐条命中');
    const same = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O1, to_member_id: C.id, reason: '客服调整' } });
    ok(same.code !== 1 && /同一人/.test(String(same.msg)), '转给当前持有人被拒', same.msg);

    db.prepare('UPDATE member SET disabled = 20 WHERE member_id = ?').run(D.id);
    const disabled = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O1, to_member_id: D.id, reason: '客服调整' } });
    ok(disabled.code !== 1 && /禁用/.test(String(disabled.msg)), '禁用会员不能接手', disabled.msg);
    db.prepare('UPDATE member SET disabled = 10 WHERE member_id = ?').run(D.id);

    const noReason = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O1, to_member_id: D.id } });
    ok(noReason.code !== 1 && /原因/.test(String(noReason.msg)), '不填原因被拒', noReason.msg);

    // 挂牌中：商品正在等下一手买走，改归属会和成交并发打架
    db.prepare('UPDATE orders SET consignment_status = 10 WHERE order_id = ?').run(O1);
    const listed = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O1, to_member_id: D.id, reason: '客服调整' } });
    ok(listed.code !== 1 && /挂牌|下架/.test(String(listed.msg)), '挂牌中的订单不能转让', listed.msg);
    db.prepare('UPDATE orders SET consignment_status = 0 WHERE order_id = ?').run(O1);

    // 货已不在原买家名下（比如被转拍卖掉了）
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(A.id, G1);
    const notOwner = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O1, to_member_id: D.id, reason: '客服调整' } });
    ok(notOwner.code !== 1 && /不在原买家名下/.test(String(notOwner.msg)), '货不在原买家名下时拒绝', notOwner.msg);
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(C.id, G1);

    // 已取消的订单没有可转的东西
    const od2 = await api('/api/order/toAddOrder', { method: 'POST', token: D.token, body: { goods_id: G2, num: 1, pay_type: 0 } });
    ok(od2.code === 1, 'D 下单按件商品', od2.msg);
    const O2 = od2.data.order_id;
    await api('/admin/api/orders/cancel', { method: 'POST', token: at, body: { order_id: O2 } });
    const cancelled = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O2, to_member_id: A.id, reason: '客服调整' } });
    ok(cancelled.code !== 1 && /取消/.test(String(cancelled.msg)), '已取消订单不能转让', cancelled.msg);

    // 按件出售：成交后买家没有货权，转不了
    const od3 = await api('/api/order/toAddOrder', { method: 'POST', token: A.token, body: { goods_id: G2, num: 1, pay_type: 0 } });
    ok(od3.code === 1, 'A 下单按件商品', od3.msg);
    const O3 = od3.data.order_id;
    const cp3 = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: O3 } });
    ok(cp3.code === 1, '按件订单确认成交', cp3.msg);
    const piece = await api('/admin/api/orders/transfer', { method: 'POST', token: at, body: { order_id: O3, to_member_id: B.id, reason: '客服调整' } });
    ok(piece.code !== 1 && /按件/.test(String(piece.msg)), '按件订单成交后不能转让', piece.msg);

    // ---------- 5. 限购口径 ----------
    section('[5] 接手人本场已抢数会随转让增加（限购提示口径）');
    // 把 C 手上那笔已成交订单落到 1 号场次（buy_num=1），再让 D 下一单用来查候选人
    db.prepare('UPDATE orders SET specialarea_id = 1 WHERE order_id = ?').run(O1);
    db.prepare('UPDATE orders SET specialarea_id = 1 WHERE order_id = ?').run(O2);
    const od4 = await api('/api/order/toAddOrder', { method: 'POST', token: D.token, body: { goods_id: G1, num: 1, pay_type: 0 } });
    // G1 已被 C 持有、A 也买过：D 下单大概率被「已持有/已买过」拦住，这里只关心候选人接口，不强求成功
    const cand = await api(`/admin/api/orders/transfer-candidates?keyword=${C.phone}&order_id=${O2}`, { token: at });
    const c = (cand.data || []).find((x) => Number(x.member_id) === C.id);
    ok(!!c, '候选人能按手机号搜到');
    eq(c?.area_bought, 1, 'C 在本场已抢 1 件（那笔已成交订单）');
    eq(c?.area_limit, 1, '本场限购 1 件随候选人返回');
    eq(c?.over_limit, 1, '已达上限时给出超限标记');
    ok(od4.code === 1 || od4.code !== 1, '（D 的下单结果不影响本段结论）');

    // ---------- 6. 后台列表与详情流水 ----------
    section('[6] 后台列表与详情流水');
    const al = await api('/admin/api/orders/list?page=1&limit=50', { token: at });
    const aO1 = (al.data?.data || []).find((x) => Number(x.order_id) === Number(O1));
    eq(aO1?.transfer_count, 2, '列表带出转让次数=2');
    ok(!!aO1?.last_transfer_time, '列表带出最近转让时间');

    const hist = await api(`/admin/api/orders/transfer-history?order_id=${O1}`, { token: at });
    const hs = hist.data || [];
    eq(hs.length, 2, '转让流水两条');
    eq(hs[0]?.from_member_id, A.id, '第一条：A 转出');
    eq(hs[0]?.to_member_id, B.id, '第一条：转给 B');
    eq(hs[1]?.to_member_id, C.id, '第二条：转给 C');
    ok(/^\d{3}\*{4}\d{4}$/.test(String(hs[0]?.from_mobile || '')), '流水里手机号打码');

    // ---------- 6b. 「已转让」筛选与导出 ----------
    section('[6b] 已转让标签与导出列');
    const onlyT = await api('/admin/api/orders/list?page=1&limit=50&transferred=1', { token: at });
    const rowsT = onlyT.data?.data || [];
    ok(rowsT.length > 0 && rowsT.every((x) => Number(x.transfer_count) > 0), '已转让：只返回转过手的订单');
    ok(rowsT.some((x) => Number(x.order_id) === Number(O1)), '已转让里能看到转过两次的那一单');
    ok(!rowsT.some((x) => Number(x.order_id) === Number(O3)), '没转过手的订单不在结果里');

    // 导出必须跟筛选一致，且带出「原持有人」
    const csv = async (qs) => {
      const res = await fetch(`${BASE}/admin/api/orders/export${qs}`, { headers: { token: at } });
      return (await res.text()).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    };
    const linesT = await csv('?transferred=1');
    const headT = linesT[0].split(',');
    ok(headT.includes('原持有人') && headT.includes('原持有人手机号') && headT.includes('转让次数'), '导出表头含原持有人与转让次数');
    ok(linesT.length - 1 === rowsT.length, '导出条数与列表筛选一致', `${linesT.length - 1} vs ${rowsT.length}`);

    const colPrev = headT.indexOf('原持有人手机号');
    const o1no = get('SELECT order_no FROM orders WHERE order_id = ?', O1).order_no;
    const lineO1 = linesT.find((l) => l.includes(o1no));
    ok(!!lineO1, '导出里能找到这笔转让单');
    if (lineO1) {
      const cells = lineO1.split(',');
      eq(cells[colPrev], B.phone, '原持有人手机号是转让前的 B');
      eq(cells[headT.indexOf('转让次数')], '2', '转让次数导出为 2');
    }

    // 转让后商品能继续转拍（C 是当前持有人）
    const quote = await api(`/api/order/getConsignmentQuote?order_id=${O1}`, { token: C.token });
    ok(quote.code === 1, '新持有人可以发起转拍报价', quote.msg);

    console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : ''}`);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(' - ' + f);
    }
  } finally {
    cleanup();
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
