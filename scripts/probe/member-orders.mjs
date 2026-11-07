/**
 * 会员订单档案验收：后台 /admin/api/member/orders
 *
 * 覆盖：
 *   1. 三类关联订单都能查到：当前归属（买家）、作为卖家、已被后台转出
 *   2. 每笔订单的详细字段齐全，实付口径 = 货款 + 服务费 + 上架费
 *   3. 订单来源四项口径：下单渠道（Q 自助 / M 后台录入）、订单类型、关联场次、卖家与转让方
 *   4. 转让受让方能拿到 acquired_from 与转让流水
 *   5. role 筛选、订单号搜索、分页
 *   6. 未登录管理员不能访问；不存在的会员返回业务失败；调用被操作审计记录
 *
 * 独立库（probe-member-orders.db / 3475），跑完销毁。
 * 用法: node scripts/probe/member-orders.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3475;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-member-orders.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`];
const removeDb = () => {
  for (const f of dbFiles) {
    const p = join(SERVER, 'data', f);
    if (!existsSync(p)) continue;
    // 服务进程刚被 kill，Windows 上文件句柄可能还没释放干净。
    // 删不掉不影响验收结果：这些库在 .gitignore 里，下次运行开头还会再清一次。
    try { unlinkSync(p); } catch { /* 留到下次清 */ }
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
    // 场次全开，避免下单被时间窗挡住；限购放宽，一个会员要下两笔单
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
      return { id: Number(r.data?.member_id), token: tk, phone };
    };
    const A = await mkMember('13971000001', '档案会员A');
    const B = await mkMember('13971000002', '档案会员B');
    const S = await mkMember('13971000003', '档案卖家S');
    ok(A.id && B.id && S.id, '三个会员注册完成');

    const area = get('SELECT specialarea_id FROM specialarea LIMIT 1');
    ok(!!area, '存在场次基础数据');
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = async (name, price) => {
      const r = await api('/admin/api/goods/save', {
        method: 'POST', token: at,
        body: { goods_name: name, category_id: catId, goods_min_price: price, stock_num: 1, goods_status: 10, goods_sort: 1 },
      });
      const id = Number(r.data?.id);
      // 让这笔单有真实卖家，并挂到场次上，才能验证「卖家」和「关联场次」两项来源
      db.prepare("UPDATE goods SET area_date = '', member_id = ? WHERE goods_id = ?").run(S.id, id);
      if (area) {
        db.prepare('INSERT OR IGNORE INTO specialarea_goods (specialarea_id, goods_id, sort, create_time) VALUES (?,?,?,?)')
          .run(area.specialarea_id, id, 1, new Date().toISOString());
      }
      return id;
    };
    const G1 = await mkGoods('档案验证·自助单', 1000);
    const G2 = await mkGoods('档案验证·后台单', 1200);
    const G3 = await mkGoods('档案验证·转让单', 1400);
    ok(G1 && G2 && G3, '三件样品商品创建完成');

    // Q 前缀：会员前台自助下单
    const oQ = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: G1, num: 1, pay_type: 0 },
    });
    ok(oQ.code === 1, 'A 前台自助下单', oQ.msg);
    // M 前缀：后台手工录入，带场次
    const oM = await api('/admin/api/orders/create', {
      method: 'POST', token: at,
      body: { member_id: A.id, goods_id: G2, price: 1200, specialarea_id: area.specialarea_id, remark: '验收手工单' },
    });
    ok(oM.code === 1, '后台手工录入订单', oM.msg);
    // 第三笔先由 A 买，再转给 B：A 视角「已转出」，B 视角「转让受让」
    const oT = await api('/api/order/toAddOrder', {
      method: 'POST', token: A.token, body: { goods_id: G3, num: 1, pay_type: 0 },
    });
    ok(oT.code === 1, 'A 下第三笔单', oT.msg);
    const tr = await api('/admin/api/orders/transfer', {
      method: 'POST', token: at,
      body: { order_id: oT.data?.order_id, to_member_id: B.id, reason: '验收转让' },
    });
    ok(tr.code === 1, '后台把第三笔单转给 B', tr.msg);

    // ---------- 1. A 的全部关联订单 ----------
    section('[1] 会员 A：全部关联订单与字段');
    const aRes = await api(`/admin/api/member/orders?member_id=${A.id}&limit=50`, { token: at });
    ok(aRes.code === 1, '订单档案接口返回成功', aRes.msg);
    const aRows = aRes.data?.data || [];
    eq(aRows.length, 3, 'A 关联 3 笔（自助 / 后台录入 / 已转出）');
    const need = ['order_no', 'goods_name', 'create_time', 'pay_total', 'total_price',
      'service_charge', 'listing_fee', 'order_type_text', 'status_text', 'source_code',
      'source_text', 'area_name', 'seller_name', 'role', 'role_text', 'logs'];
    ok(aRows.every((r) => need.every((k) => r[k] !== undefined)), '每笔订单的商品名/下单时间/金额/来源等字段齐全');
    ok(aRows.every((r) => Math.abs(
      Number(r.pay_total) - (Number(r.total_price) + Number(r.service_charge) + Number(r.listing_fee)),
    ) < 0.005), '实付 = 货款 + 抢单服务费 + 上架费');
    ok(Number(aRes.data?.stats?.orders) === 3, '汇总笔数与列表一致');

    // ---------- 2. 订单来源四项口径 ----------
    section('[2] 订单来源：渠道 / 类型 / 场次 / 卖家');
    const q = aRows.find((r) => String(r.order_no).startsWith('Q'));
    const m = aRows.find((r) => String(r.order_no).startsWith('M'));
    eq(q?.source_code, 'member_self', '会员自助下单渠道判定');
    eq(m?.source_code, 'admin_manual', '后台手工录入渠道判定');
    ok(m?.logs?.some((l) => l.action === '后台新增订单'), '后台单带「后台新增订单」动态');
    ok(aRows.every((r) => !!r.order_type_text), '订单类型文案齐全');
    ok(Number(m?.area_id) > 0 && m?.area_name !== '未关联场次', '关联场次读到真实场次名', m?.area_name);
    eq(m?.seller_name, '档案卖家S', '卖家名来自 member 表');
    ok(!!m?.seller_mobile, '卖家手机号透出');

    // ---------- 3. 角色与转让 ----------
    section('[3] 角色分类与转让受让');
    const out = aRows.find((r) => r.role === 'transferred');
    ok(!!out, '已转出的订单仍能被该会员查到');
    ok(String(out?.role_text).includes('已转出'), '已转出角色文案');
    const bRes = await api(`/admin/api/member/orders?member_id=${B.id}`, { token: at });
    const bRow = (bRes.data?.data || [])[0];
    ok(bRes.code === 1 && !!bRow, '受让方 B 能查到订单');
    eq(bRow?.role, 'buyer', 'B 是当前买家');
    eq(bRow?.acquired_from?.from_name, '档案会员A', '取得方式显示转让方');
    eq(bRow?.acquired_from?.reason, '验收转让', '转让原因透出');
    eq(bRow?.transfers?.length, 1, '转让流水透出');
    const sRes = await api(`/admin/api/member/orders?member_id=${S.id}&role=seller`, { token: at });
    ok(sRes.code === 1 && (sRes.data?.data || []).length >= 1, '卖家视角能查到关联订单');
    ok((sRes.data?.data || []).every((r) => r.role === 'seller'), '卖家筛选结果只含卖家角色');

    // ---------- 4. 筛选 / 搜索 / 分页 ----------
    section('[4] 筛选、搜索与分页');
    const buyerOnly = await api(`/admin/api/member/orders?member_id=${A.id}&role=buyer`, { token: at });
    ok((buyerOnly.data?.data || []).length === 2 && (buyerOnly.data?.data || []).every((r) => r.role === 'buyer'), '买家筛选生效');
    const outOnly = await api(`/admin/api/member/orders?member_id=${A.id}&role=transferred`, { token: at });
    ok((outOnly.data?.data || []).length === 1 && (outOnly.data?.data || []).every((r) => r.role === 'transferred'), '已转出筛选生效');
    const kw = await api(`/admin/api/member/orders?member_id=${A.id}&keyword=${m.order_no}`, { token: at });
    eq(kw.data?.total, 1, '订单号搜索生效');
    const paged = await api(`/admin/api/member/orders?member_id=${A.id}&page=1&limit=2`, { token: at });
    ok(paged.data?.data?.length === 2 && paged.data?.last_page >= 2, '分页生效');

    // ---------- 5. 权限与审计 ----------
    section('[5] 仅管理员可见');
    const noAuth = await api(`/admin/api/member/orders?member_id=${A.id}`);
    ok(noAuth.code !== 1, '未登录管理员不能查看');
    const badId = await api('/admin/api/member/orders?member_id=999999', { token: at });
    ok(badId.code !== 1, '不存在的会员返回业务失败');
    const audited = get("SELECT COUNT(*) c FROM admin_operation_log WHERE path LIKE '%member/orders%'");
    ok(Number(audited?.c || 0) > 0, '调用被管理员操作审计记录');

    console.log(`\n通过 ${pass} 项${fails.length ? `，失败 ${fails.length} 项` : ''}`);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(' - ' + f);
    }
  } finally {
    cleanup();
  }
  // 等服务进程释放 SQLite 文件句柄（Windows 上 kill 不是立刻生效），再删独立库
  await sleep(500);
  removeDb();
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
