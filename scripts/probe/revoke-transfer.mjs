/**
 * 撤销订单转让验收：后台 /admin/api/orders/transfer-revoke
 *
 * 覆盖：
 *   1. 已成交转让后：订单归属、货权、转让次数、流水都正确落库，会员端可见
 *   2. 拒绝条件：无 confirm、错误的 transfer_id、未登录、正在挂牌、货已被下一手买走、无转让流水
 *   3. 撤销成功：归属/货权/次数/最近转让时间回滚，流水删除，订单动态与审计留痕
 *   4. 会员端同步：原买家的订单、已转出记录、我的店铺；接手人侧全部消失
 *   5. 多次转让：只撤最后一次，逐次退回最初持有人
 *
 * 独立库（probe-revoke-transfer.db / 3477），跑完销毁。
 * 用法: node scripts/probe/revoke-transfer.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3477;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-revoke-transfer.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`];
const removeDb = () => {
  for (const f of dbFiles) {
    const p = join(SERVER, 'data', f);
    if (!existsSync(p)) continue;
    try { unlinkSync(p); } catch { /* Windows 句柄未释放，留到下次 */ }
  }
};

removeDb();
process.env.MALL_DB = DB;
const env = {
  ...process.env, MALL_DB: DB, PORT: String(PORT),
  RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0', ORDER_EXPIRE_SCAN_MS: '0',
};
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

  const { db, get, all } = await import('../../server/src/db.js');
  const cleanup = () => { try { srv.kill(); } catch {} };

  try {
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, is_open = 10, buy_num = 99').run();
    const at = (await api('/admin/api/login', {
      method: 'POST', body: { user_name: 'admin1', password: '123456' },
    })).data.token;
    ok(!!at, '后台登录');

    const mkMember = async (phone, nick) => {
      const r = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'probe123456', code: 'boss01', nickName: nick },
      });
      const tk = (await api('/api/member/accountLogin', {
        method: 'POST', body: { phone, password: 'probe123456' },
      })).data.token;
      return { id: Number(r.data?.member_id), token: tk };
    };
    const A = await mkMember('13973000001', '撤销原买家');
    const B = await mkMember('13973000002', '撤销接手人');
    const C = await mkMember('13973000003', '撤销第三手');
    ok(A.id && B.id && C.id, '三个会员注册完成');

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = async (name, price) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: price, stock_num: 1, goods_status: 10, goods_sort: 1 },
      });
      const id = Number(r.data?.id);
      // 唯一件平台货：成交后 goods.member_id 会变成买家，转让时货权同步过户
      db.prepare("UPDATE goods SET area_date = '', stock_total = 1, stock_num = 1, member_id = 0 WHERE goods_id = ?").run(id);
      return id;
    };
    const G1 = await mkGoods('撤销验证·整件一', 1000);
    const G2 = await mkGoods('撤销验证·整件二', 1200);
    const G3 = await mkGoods('撤销验证·无流水', 900);
    const G4 = await mkGoods('撤销验证·挂牌强制回撤', 1100);
    const G5 = await mkGoods('撤销验证·已卖出', 1300);
    ok(G1 && G2 && G3 && G4 && G5, '五件整件样品商品创建完成');

    const makePaidOrder = async (goodsId, buyer) => {
      const r = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer.token, body: { goods_id: goodsId, num: 1, pay_type: 0 },
      });
      if (r.code !== 1) throw new Error('下单失败：' + r.msg);
      const oid = Number(r.data.order_id);
      const cp = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: oid } });
      if (cp.code !== 1) throw new Error('确认成交失败：' + cp.msg);
      return oid;
    };
    const transferTo = async (oid, toId, reason) => api('/admin/api/orders/transfer', {
      method: 'POST', token: at, body: { order_id: oid, to_member_id: toId, reason },
    });
    const revoke = (body, token = at) => api('/admin/api/orders/transfer-revoke', { method: 'POST', token, body });
    const orderOf = (oid) => get('SELECT * FROM orders WHERE order_id = ?', oid);
    const transfersOf = (oid) => all('SELECT * FROM order_transfer WHERE order_id = ? ORDER BY transfer_id', oid);
    const hasOrder = async (who, oid) => {
      const r = await api('/api/order/getOrder?page=1&limit=30', { token: who.token });
      return (r.data?.data || []).some((x) => Number(x.order_id) === Number(oid));
    };
    const shopHas = async (who, goodsId) => {
      const r = await api('/api/member/myShop?page=1&limit=50', { token: who.token });
      const list = r.data?.data || r.data?.list || [];
      return list.some((g) => Number(g.goods_id) === Number(goodsId));
    };

    // ---------- 1. 成交 + 转让 ----------
    section('[1] 已成交订单转让给 B');
    const O1 = await makePaidOrder(G1, A);
    const t1 = await transferTo(O1, B.id, '帮人代拍');
    ok(t1.code === 1, 'A → B 转让成功', t1.msg);
    eq(orderOf(O1).member_id, B.id, '订单归属改为 B');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G1).member_id, B.id, '货权同步过户给 B');
    eq(Number(orderOf(O1).transfer_count), 1, '转让次数 +1');
    const flow1 = transfersOf(O1);
    eq(flow1.length, 1, '写入 1 条转让流水');
    eq(flow1[0].goods_moved, 1, '流水标记货权已过户');
    ok(await hasOrder(B, O1), 'B 的订单列表出现该单');
    ok(await hasOrder(A, O1), 'A 的列表仍有「已转出」只读记录');
    ok(await shopHas(B, G1), 'B 的我的店铺出现该货');

    // ---------- 2. 拒绝条件 ----------
    section('[2] 拒绝条件');
    const lastId = flow1[0].transfer_id;
    ok((await revoke({ order_id: O1, transfer_id: lastId }, '')).code !== 1, '未登录管理员不能撤销');
    ok((await revoke({ order_id: O1, transfer_id: lastId })).code !== 1, '缺少 confirm 被拒绝');
    ok((await revoke({ order_id: O1, transfer_id: lastId + 999, confirm: 'REVOKE_TRANSFER' })).code !== 1,
      '不是最后一次转让被拒绝');
    ok((await revoke({ order_id: 999999, transfer_id: lastId, confirm: 'REVOKE_TRANSFER' })).code !== 1,
      '订单不存在被拒绝');
    const noFlowOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: G3, num: 1, pay_type: 0 },
    });
    const noFlowId = Number(noFlowOrder.data?.order_id);
    ok((await revoke({ order_id: noFlowId, confirm: 'REVOKE_TRANSFER' })).code !== 1, '无转让流水的订单被拒绝');

    db.prepare('UPDATE orders SET consignment_status = 10 WHERE order_id = ?').run(O1);
    const listed = await revoke({ order_id: O1, transfer_id: lastId, confirm: 'REVOKE_TRANSFER' });
    ok(listed.code !== 1, '正在挂牌转拍时拒绝撤销', listed.msg);
    db.prepare('UPDATE orders SET consignment_status = 0 WHERE order_id = ?').run(O1);

    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(C.id, G1);
    const movedAway = await revoke({ order_id: O1, transfer_id: lastId, confirm: 'REVOKE_TRANSFER' });
    ok(movedAway.code !== 1, '货已被下一手买走时拒绝撤销', movedAway.msg);
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(B.id, G1);
    eq(orderOf(O1).member_id, B.id, '被拒绝的调用没有改动归属');

    // ---------- 3. 撤销成功 ----------
    section('[3] 撤销最近一次转让');
    const no1 = String(orderOf(O1).order_no);
    const rv = await revoke({ order_id: O1, transfer_id: lastId, confirm: 'REVOKE_TRANSFER' });
    ok(rv.code === 1, '撤销成功', rv.msg);
    eq(orderOf(O1).member_id, A.id, '订单归属退回 A');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G1).member_id, A.id, '货权退回 A');
    eq(Number(orderOf(O1).transfer_count), 0, '转让次数回到 0');
    eq(orderOf(O1).last_transfer_time, '', '最近转让时间清空');
    eq(transfersOf(O1).length, 0, '该次转让流水已删除');
    eq(rv.data?.goods_reverted, 1, '返回摘要标出货权已退回');
    const logs1 = all('SELECT action FROM order_log WHERE order_id = ?', O1).map((x) => x.action);
    ok(logs1.includes('订单转让') && logs1.includes('撤销转让'), '保留转让日志并新增撤销日志');
    const audit1 = get(
      "SELECT COUNT(*) c FROM admin_operation_log WHERE action = '撤销订单转让' AND details LIKE ?", `%${no1}%`,
    );
    ok(Number(audit1?.c || 0) > 0, '撤销明细写进操作审计');

    // ---------- 4. 会员端同步 ----------
    section('[4] 会员端同步');
    ok(await hasOrder(A, O1), 'A 的订单列表恢复该单');
    const aList = await api('/api/order/getOrder?page=1&limit=30', { token: A.token });
    const aRow = (aList.data?.data || []).find((x) => Number(x.order_id) === Number(O1));
    eq(aRow?.transferred_out, 0, 'A 侧不再是「已转出」');
    ok(!(await hasOrder(B, O1)), 'B 的订单列表不再出现该单');
    ok(await shopHas(A, G1), 'A 的我的店铺恢复该货');
    ok(!(await shopHas(B, G1)), 'B 的我的店铺不再显示该货');

    // ---------- 5. 多次转让逐次退 ----------
    section('[5] 多次转让：只撤最后一次，逐次退回');
    const O2 = await makePaidOrder(G2, A);
    ok((await transferTo(O2, B.id, '第一手')).code === 1, 'A → B');
    ok((await transferTo(O2, C.id, '第二手')).code === 1, 'B → C');
    eq(orderOf(O2).member_id, C.id, '当前归属 C');
    eq(Number(orderOf(O2).transfer_count), 2, '转让次数 2');
    const rv2 = await revoke({ order_id: O2, confirm: 'REVOKE_TRANSFER' });
    ok(rv2.code === 1, '撤销最后一次成功', rv2.msg);
    eq(orderOf(O2).member_id, B.id, '退回 B（不是直接回 A）');
    eq(Number(orderOf(O2).transfer_count), 1, '转让次数减到 1');
    ok(String(orderOf(O2).last_transfer_time).length > 0, '最近转让时间回退到上一笔');
    const rv3 = await revoke({ order_id: O2, confirm: 'REVOKE_TRANSFER' });
    ok(rv3.code === 1, '再撤一次成功', rv3.msg);
    eq(orderOf(O2).member_id, A.id, '退回最初持有人 A');
    eq(Number(orderOf(O2).transfer_count), 0, '转让次数归零');
    eq(transfersOf(O2).length, 0, '转让流水全部清空');

    // ---------- 6. 转卖（挂牌转拍）中强制回撤 ----------
    section('[6] 挂牌转拍中：普通撤销被拒，强制回撤成功');
    const areaId = Number(get('SELECT specialarea_id FROM specialarea LIMIT 1')?.specialarea_id || 0);
    const O3 = await makePaidOrder(G4, A);
    ok((await transferTo(O3, B.id, '帮人代拍后挂牌')).code === 1, 'A → B 转让成功');
    // 模拟会员端「转拍上架」写入的四处状态：在挂标记、商品在售、场次归属、场次关联
    db.prepare("UPDATE orders SET consignment_status = 10, transposition_time = ? WHERE order_id = ?")
      .run('2026-11-08 00:00:00', O3);
    db.prepare("UPDATE goods SET goods_status = 10, is_sell = 10, area_date = '2026-11-08' WHERE goods_id = ?").run(G4);
    db.prepare('INSERT OR IGNORE INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)')
      .run(areaId, G4, 1, '2026-11-08 00:00:00');
    ok(Number(orderOf(O3).consignment_status) === 10, '订单已处于挂牌转拍状态');
    ok(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G4).c) > 0, '商品已挂到下一场');

    const normalOnListed = await revoke({ order_id: O3, confirm: 'REVOKE_TRANSFER' });
    ok(normalOnListed.code !== 1, '普通撤销仍拒绝挂牌中的订单', normalOnListed.msg);
    ok(String(normalOnListed.msg).includes('强制回撤'), '拒绝文案指路到强制回撤');

    const forced = await revoke({ order_id: O3, confirm: 'FORCE_REVOKE_TRANSFER' });
    ok(forced.code === 1, '强制回撤成功', forced.msg);
    eq(forced.data?.force, 1, '返回摘要标出强制模式');
    eq(forced.data?.delisted, 1, '返回摘要标出已自动下架');
    eq(orderOf(O3).member_id, A.id, '订单归属退回上一手 A');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G4).member_id, A.id, '货权退回上一手 A');
    eq(Number(orderOf(O3).consignment_status), 0, '在挂标记已清除');
    eq(Number(get('SELECT goods_status FROM goods WHERE goods_id = ?', G4).goods_status), 20, '商品已下架');
    eq(Number(get('SELECT is_sell FROM goods WHERE goods_id = ?', G4).is_sell), 0, '商品已停止出售');
    eq(get("SELECT area_date FROM goods WHERE goods_id = ?", G4).area_date, '', '场次日期已清空');
    eq(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', G4).c), 0, '已退出场次关联');
    eq(transfersOf(O3).length, 0, '该次转让流水已删除');
    const forceLogs = all('SELECT action FROM order_log WHERE order_id = ?', O3).map((x) => x.action);
    ok(forceLogs.includes('强制回撤转让'), '订单动态记录「强制回撤转让」');
    const forceAudit = get(
      "SELECT COUNT(*) c FROM admin_operation_log WHERE action = '强制回撤订单转让' AND details LIKE '%\"force\":1%'",
    );
    ok(Number(forceAudit?.c || 0) > 0, '强制回撤明细写进操作审计');
    ok(await hasOrder(A, O3), '会员端 A 的订单列表恢复该单');
    ok(!(await hasOrder(B, O3)), '会员端 B 的订单列表不再出现该单');
    ok(await shopHas(A, G4), '会员端 A 的我的店铺恢复该货');
    ok(!(await shopHas(B, G4)), '会员端 B 的我的店铺不再显示该货');

    // 货已被下一手买走：这是数据完整性底线，强制也不放行
    section('[7] 货已卖出：强制回撤仍被拒绝');
    const O4 = await makePaidOrder(G5, A);
    ok((await transferTo(O4, B.id, '挂牌后已卖出')).code === 1, 'A → B 转让成功');
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(C.id, G5);
    const forceSold = await revoke({ order_id: O4, confirm: 'FORCE_REVOKE_TRANSFER' });
    ok(forceSold.code !== 1, '货已属第三方时强制回撤被拒绝', forceSold.msg);
    eq(orderOf(O4).member_id, B.id, '被拒后订单归属未变');
    eq(get('SELECT member_id FROM goods WHERE goods_id = ?', G5).member_id, C.id, '被拒后第三方货权未被抢回');

    console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : ''}`);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(' - ' + f);
    }
  } finally {
    cleanup();
  }
  await sleep(500);
  removeDb();
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
