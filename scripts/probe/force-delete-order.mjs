/**
 * 强制删除订单验收：后台 /admin/api/orders/force-delete
 *
 * 覆盖：
 *   1. 服务端确认校验：缺 confirm、单号不匹配、未登录、通用删除接口仍拒绝 orders
 *   2. 物理删除并级联清理 order_log / order_transfer / 独立货权商品
 *   3. 会员端同步：H5 订单列表（含「已转出」只读记录）、订单详情、我的店铺都不再出现
 *   4. 未确认的按件订单删除后归还库存名额；整件商品不会被误删
 *   5. 财务/结算台账保留并在返回里如实列出；操作审计留痕
 *   6. 积分 / 佣金 / 卖家货款：成交确实入账，强制删除后账户冲正、对应资金流水删除、
 *      冲正明细进审计；积分已被消费时冲成负数会如实点名
 *
 * 独立库（probe-force-delete.db / 3476），跑完销毁。
 * 用法: node scripts/probe/force-delete-order.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3476;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-force-delete.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`];
const removeDb = () => {
  for (const f of dbFiles) {
    const p = join(SERVER, 'data', f);
    if (!existsSync(p)) continue;
    // Windows 上服务刚被 kill 时句柄可能还没释放，删不掉留到下次开头再清
    try { unlinkSync(p); } catch {}
  }
};

removeDb();
process.env.MALL_DB = DB;
const env = {
  ...process.env,
  MALL_DB: DB, PORT: String(PORT),
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
const near = (a, b, name) => ok(Math.abs(Number(a) - Number(b)) < 0.005, name, `期望 ${b}，实际 ${a}`);

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
    const A = await mkMember('13972000001', '删单原买家');
    const B = await mkMember('13972000002', '删单接手人');
    const P = await mkMember('13972000003', '删单上级');
    const S = await mkMember('13972000004', '删单卖家');
    ok(A.id && B.id && P.id && S.id, '四个会员注册完成');
    // 给 A 挂上级：直推奖和推广奖励积分才发得出来
    db.prepare('UPDATE member SET p_id = ?, path = ? WHERE member_id = ?').run(P.id, `/${P.id}/`, A.id);
    // 默认积分奖励是关闭的；打开并给买家/上级各配比例，直推奖率确保 > 0
    const setCfg = (k, v) => {
      const r = db.prepare('UPDATE setting_config SET value = ? WHERE `key` = ?').run(v, k);
      if (!r.changes) db.prepare('INSERT INTO setting_config (`key`, `value`) VALUES (?, ?)').run(k, v);
    };
    setCfg('score_award_open', '10');
    setCfg('score_award_buyer', '1');
    setCfg('score_award_parent', '0.5');
    setCfg('drive_award_rate', '0.5');
    ok(true, '开启积分奖励与直推奖配置');

    const energyFor = (orderNo) => db.prepare(
      "SELECT * FROM finance_energy WHERE type IN (1,2,3) AND (remarks = ? OR substr(IFNULL(remarks,''),1,?) = ?) ORDER BY energy_id",
    ).all(`订单 ${orderNo}`, `订单 ${orderNo} `.length, `订单 ${orderNo} `);
    const account = (mid) => db.prepare(
      'SELECT score, e_card_number, distribution_amount, amount FROM member WHERE member_id = ?',
    ).get(mid);

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = async (name, price, stock) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: price, stock_num: stock, goods_status: 10, goods_sort: 1 },
      });
      const id = Number(r.data?.id);
      // 商品挂在卖家 S 名下，成交时才会产生「商品售出」货款流水
      db.prepare("UPDATE goods SET area_date = '', stock_total = ?, stock_num = ?, member_id = ? WHERE goods_id = ?")
        .run(stock, stock, S.id, id);
      return id;
    };
    const pieceGoods = await mkGoods('删单验证·按件', 1000, 5);
    const pieceGoods2 = await mkGoods('删单验证·未确认', 900, 5);
    const singleGoods = await mkGoods('删单验证·整件', 800, 1);
    ok(pieceGoods && pieceGoods2 && singleGoods, '三件样品商品创建完成');

    // O1：成交 → 生成独立货权 → 已付款转让给 B（A 侧会留下「已转出」只读记录）
    const o1 = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: pieceGoods, num: 1, pay_type: 0 },
    });
    ok(o1.code === 1, 'A 下按件单 O1', o1.msg);
    const O1 = Number(o1.data?.order_id);
    const cp = await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: O1 } });
    ok(cp.code === 1, '后台确认成交 O1', cp.msg);
    const assetId = Number(get('SELECT asset_goods_id FROM orders WHERE order_id = ?', O1).asset_goods_id || 0);
    ok(assetId > 0, '按件成交生成独立货权商品');

    // ---------- 成交入账：积分 / 佣金 / 货款 ----------
    const o1No = String(get('SELECT order_no FROM orders WHERE order_id = ?', O1).order_no);
    const e1 = energyFor(o1No);
    ok(e1.length >= 4, '成交产生货款/直推奖/买家积分/上级积分四类流水', `实际 ${e1.length} 条`);
    ok(e1.some((x) => Number(x.type) === 1 && Number(x.face_value) > 0), '直推奖流水入账');
    ok(e1.some((x) => Number(x.type) === 2 && Number(x.face_value) > 0), '卖家货款流水入账');
    ok(e1.filter((x) => Number(x.type) === 3).length >= 2, '买家与上级积分流水入账');
    ok(Number(account(S.id).amount) > 0, '卖家余额已增加');
    ok(Number(account(P.id).e_card_number) > 0, '上级佣金已增加');
    ok(Number(account(A.id).score) > 0 && Number(account(P.id).score) > 0, '买家与上级积分已增加');
    const tr = await api('/admin/api/orders/transfer', {
      method: 'POST', token: at, body: { order_id: O1, to_member_id: B.id, reason: '删单验收' },
    });
    ok(tr.code === 1, '把 O1 转让给 B', tr.msg);
    const aBefore = await api('/api/order/getOrder?page=1&limit=30', { token: A.token });
    ok((aBefore.data?.data || []).some((x) => Number(x.order_id) === O1 && Number(x.transferred_out) === 1),
      '删除前 A 的列表里有「已转出」记录');

    // O2：未确认的按件单，占着库存名额
    const stockBefore = Number(get('SELECT stock_num FROM goods WHERE goods_id = ?', pieceGoods2).stock_num);
    const o2 = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: pieceGoods2, num: 1, pay_type: 0 },
    });
    ok(o2.code === 1, 'A 下未确认按件单 O2', o2.msg);
    const O2 = Number(o2.data?.order_id);
    const stockAfterOrder = Number(get('SELECT stock_num FROM goods WHERE goods_id = ?', pieceGoods2).stock_num);
    eq(stockAfterOrder, stockBefore - 1, '下单扣掉 1 个名额');

    // O3：整件商品成交单，用来验证商品本体不会被误删
    const o3 = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: singleGoods, num: 1, pay_type: 0 },
    });
    ok(o3.code === 1, 'A 下整件单 O3', o3.msg);
    const O3 = Number(o3.data?.order_id);
    await api('/admin/api/orders/confirm-pay', { method: 'POST', token: at, body: { order_id: O3 } });

    // ---------- 1. 服务端确认校验 ----------
    section('[1] 二次确认与权限');
    const o1Row = get('SELECT * FROM orders WHERE order_id = ?', O1);
    const noToken = await api('/admin/api/orders/force-delete', {
      method: 'POST', body: { order_id: O1, order_no: o1Row.order_no, confirm: 'FORCE_DELETE' },
    });
    ok(noToken.code !== 1, '未登录管理员不能强制删除');
    const noConfirm = await api('/admin/api/orders/force-delete', {
      method: 'POST', token: at, body: { order_id: O1, order_no: o1Row.order_no },
    });
    ok(noConfirm.code !== 1, '缺少 confirm 标记被拒绝');
    const wrongNo = await api('/admin/api/orders/force-delete', {
      method: 'POST', token: at, body: { order_id: O1, order_no: 'WRONG-NO', confirm: 'FORCE_DELETE' },
    });
    ok(wrongNo.code !== 1, '确认订单号不匹配被拒绝');
    const generic = await api('/admin/api/orders/remove', { method: 'POST', token: at, body: { ids: [O1] } });
    ok(generic.code !== 1, '通用删除接口仍拒绝订单（审计拦截保留）');
    ok(!!get('SELECT 1 FROM orders WHERE order_id = ?', O1), '被拒绝的调用没有删掉任何数据');

    // 模拟买家已把积分花掉：冲正后应为负数，接口要点名让运营核账
    db.prepare('UPDATE member SET score = 0 WHERE member_id = ?').run(A.id);
    const before = {};
    for (const mid of [A.id, B.id, P.id, S.id]) before[mid] = account(mid);

    // ---------- 2. 强制删除 O1 ----------
    section('[2] 强制删除 O1 与级联清理');
    const del = await api('/admin/api/orders/force-delete', {
      method: 'POST', token: at,
      body: { order_id: O1, order_no: o1Row.order_no, confirm: 'FORCE_DELETE' },
    });
    ok(del.code === 1, '强制删除成功', del.msg);
    ok(!get('SELECT 1 FROM orders WHERE order_id = ?', O1), 'orders 行已删除');
    eq(get('SELECT COUNT(*) c FROM order_log WHERE order_id = ?', O1).c, 0, '订单动态清空');
    eq(get('SELECT COUNT(*) c FROM order_transfer WHERE order_id = ?', O1).c, 0, '转让流水清空');
    ok(!get('SELECT 1 FROM goods WHERE goods_id = ?', assetId), '独立货权商品同步删除');
    ok(!get('SELECT 1 FROM specialarea_goods WHERE goods_id = ?', assetId), '货权的场次关联同步清理');
    eq(del.data?.removed?.asset_goods, 1, '返回摘要列出已删货权');
    ok(del.data?.kept && typeof del.data.kept.settle_pay === 'number', '返回摘要如实列出保留的结算台账');

    section('[2b] 积分 / 佣金 / 货款冲正');
    eq(energyFor(o1No).length, 0, '本单产生的资金流水已全部删除');
    eq(del.data?.reversed?.rows, e1.length, '返回摘要列出被冲正的流水条数');
    ok(Number(del.data?.reversed?.commission) > 0, '返回摘要含佣金冲正');
    ok(Number(del.data?.reversed?.score) > 0, '返回摘要含积分冲正');
    ok(Number(del.data?.reversed?.balance) > 0, '返回摘要含货款冲正');
    for (const acc of del.data?.reversed?.by_member || []) {
      const after = account(acc.member_id);
      const prev = before[acc.member_id];
      near(Number(after.score), Number(prev.score) - Math.round(acc.score), `会员${acc.member_id} 积分已冲正`);
      near(Number(after.e_card_number), Number(prev.e_card_number) - Number(acc.commission), `会员${acc.member_id} 佣金已冲正`);
      near(Number(after.distribution_amount), Number(prev.distribution_amount) - Number(acc.commission), `会员${acc.member_id} 分销收益已冲正`);
      near(Number(after.amount), Number(prev.amount) - Number(acc.balance), `会员${acc.member_id} 货款已冲正`);
    }
    ok((del.data?.negative_members || []).includes(A.id), '积分已消费的账户被点名为负数');
    const auditDetail = get(
      "SELECT COUNT(*) c FROM admin_operation_log WHERE action = '强制删除订单·积分佣金冲正' AND details LIKE ?",
      `%${o1No}%`,
    );
    ok(Number(auditDetail?.c || 0) > 0, '冲正明细写进操作审计');

    // ---------- 3. 会员端同步 ----------
    section('[3] 会员端订单同步');
    const aAfter = await api('/api/order/getOrder?page=1&limit=30', { token: A.token });
    ok(!(aAfter.data?.data || []).some((x) => Number(x.order_id) === O1), 'A 的列表不再出现 O1（含「已转出」幽灵记录）');
    const bAfter = await api('/api/order/getOrder?page=1&limit=30', { token: B.token });
    ok(!(bAfter.data?.data || []).some((x) => Number(x.order_id) === O1), 'B 的列表不再出现 O1');
    const detail = await api(`/api/order/detail?order_id=${O1}`, { token: B.token });
    ok(detail.code !== 1, '订单详情返回「订单不存在」');
    const shop = await api('/api/member/myShop?page=1&limit=50', { token: B.token });
    const shopList = shop.data?.data || shop.data?.list || [];
    ok(!shopList.some((g) => Number(g.goods_id) === assetId), '我的店铺不再显示已删的独立货权商品');

    // ---------- 4. 库存回滚 / 整件商品保留 ----------
    section('[4] 库存与商品本体');
    const o2Row = get('SELECT * FROM orders WHERE order_id = ?', O2);
    const del2 = await api('/admin/api/orders/force-delete', {
      method: 'POST', token: at,
      body: { order_id: O2, order_no: o2Row.order_no, confirm: 'FORCE_DELETE' },
    });
    ok(del2.code === 1, '未确认单 O2 强制删除成功', del2.msg);
    eq(Number(get('SELECT stock_num FROM goods WHERE goods_id = ?', pieceGoods2).stock_num), stockBefore, '未确认单删除后归还名额');
    eq(del2.data?.restored_stock, 1, '返回摘要标出库存已归还');
    const o3Row = get('SELECT * FROM orders WHERE order_id = ?', O3);
    await api('/admin/api/orders/force-delete', {
      method: 'POST', token: at,
      body: { order_id: O3, order_no: o3Row.order_no, confirm: 'FORCE_DELETE' },
    });
    ok(!!get('SELECT 1 FROM goods WHERE goods_id = ?', singleGoods), '整件商品本体不会被误删');

    // ---------- 5. 审计 ----------
    section('[5] 审计留痕');
    const audited = get("SELECT COUNT(*) c FROM admin_operation_log WHERE path LIKE '%force-delete%' AND action NOT LIKE '%查看%'");
    ok(Number(audited?.c || 0) > 0, '强制删除请求被操作审计记录');

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
