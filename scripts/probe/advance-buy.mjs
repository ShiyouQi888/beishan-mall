/**
 * 提前抢购 + 提前时间：前后端关联验收。
 *
 * 场景构造：把场次改成「2 分钟后开抢、15 分钟后结束」，于是
 *   · 普通会员现在下单 → 应该被拒（还没到开抢时间）
 *   · 开通「提前 3 分钟」的会员现在下单 → 应该成功
 *   · 后台把提前量关掉 → 立刻又买不了
 *
 * 覆盖面：
 *   1. 后台开通接口写入 advance_seconds（分钟 → 秒）
 *   2. 提前量上限（> 60 分钟被夹到 60）
 *   3. 下单校验真的按提前量放行（这是「前后端关联」的核心）
 *   4. 详情接口按当前会员返回 advance_open / advance_seconds
 *   5. 关闭后立即失效
 *
 * 独立库（advance.db / 3413），跑完删库，不碰演示数据。
 *
 * 用法: node scripts/probe/advance-buy.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3413;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'advance.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };
// 关键：探针自己也要连测试库。忘了这行的话，db 会落到默认的 mall.db ——
// 商品插进演示库、服务却读测试库，两边对不上，而且会把演示数据改掉。
process.env.MALL_DB = DB;

let pass = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

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
  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

  // 必须先起服务：stock_total / base_price / advance_seconds 这些列是 app.js 启动时
  // 用 ALTER 补上的，seed 只按 schema.sql 建表，等它跑完再插测试数据才不会缺列。
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

  const { db } = await import('../../server/src/db.js');

  // 场次改成「2 分钟后开抢」，这样现在一定处于「未开始」状态
  const today = todayStr();
  const b = new Date(Date.now() + 8 * 3600 * 1000); // 北京日历
  const secOfDay = b.getUTCHours() * 3600 + b.getUTCMinutes() * 60 + b.getUTCSeconds();
  if (secOfDay > 82000) {
    throw new Error('当前北京时间已过 22:46，无法构造「2 分钟后开抢」场景，请换个时间再跑');
  }
  const start = secOfDay + 120;
  const end = start + 900;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const weekday = dow === 0 ? 7 : dow;
  db.prepare('UPDATE specialarea SET start_time = ?, end_time = ?, open_days = ?, is_open = 10, transposition_hours = 0 WHERE specialarea_id = 1')
    .run(start, end, `${weekday}`);
  console.log(`场次改为 ${Math.floor(start / 3600)}:${String(Math.floor((start % 3600) / 60)).padStart(2, '0')} 开抢（2 分钟后），开放日=周${weekday}\n`);

  // 造两件商品挂在这场
  const goodsIds = [];
  for (let i = 1; i <= 2; i += 1) {
    const r = db.prepare(
      `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
         member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
         goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
       VALUES (?,?,?,?,'',1,1,'',1,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,?,?)`,
    ).run(`提前抢购样品${i}`, `ADV-${i}`, '/uploads/demo-1.svg', '[]', today, today);
    const gid = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, ?)').run(gid, i);
    goodsIds.push(gid);
  }

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;

    // 两个会员：A 普通、B 待开通提前抢购
    const members = [];
    for (const [i, phone] of [[1, '13920000001'], [2, '13920000002']]) {
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'adv123456', code: 'boss01', nickName: `提前会员${i}` },
      });
      const mid = Number(reg.data?.member_id) || db.prepare('SELECT member_id FROM member WHERE mobile = ?').get(phone)?.member_id;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '验收充值' },
      });
      const login = await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'adv123456' } });
      members.push({ mid: Number(mid), token: login.data?.token, phone });
    }
    ok(members.every((m) => m.token), '两个测试会员可登录');

    // ---------- 1. 没到点，普通会员买不了 ----------
    console.log('[1] 场次还没开始');
    const noAdv = await api('/api/order/toAddOrder', {
      method: 'POST', token: members[0].token, body: { goods_id: goodsIds[0], num: 1, pay_type: 1 },
    });
    eq(noAdv.code, 0, '普通会员下单被拒');
    ok(/不在抢购时间|未到|开抢/.test(noAdv.msg), '提示说明了「还没到开抢时间」', noAdv.msg);

    // ---------- 2. 开通提前 3 分钟 ----------
    console.log('\n[2] 后台开通「提前 3 分钟」');
    const on = await api('/admin/api/member/advance', {
      method: 'POST', token: at, body: { member_id: members[1].mid, enable: true, count: 0, minutes: 3 },
    });
    eq(on.code, 1, '开通接口成功');
    ok(/提前 3 分钟/.test(on.msg), '返回文案带上提前量', on.msg);
    const row = db.prepare('SELECT is_advance, advance_seconds FROM member WHERE member_id = ?').get(members[1].mid);
    eq(row.is_advance, 10, 'is_advance 已置为 10');
    eq(row.advance_seconds, 180, 'advance_seconds = 3 × 60 = 180');

    // 列表接口要能带出分钟数给后台展示
    const list = await api('/admin/api/member/list?page=1&limit=100&keyword=13920000002', { token: at });
    const listed = (list.data?.data || []).find((m) => Number(m.member_id) === members[1].mid);
    eq(listed?.advance_minutes, 3, '会员列表回显提前 3 分钟');

    // ---------- 3. 提前会员现在能买 ----------
    console.log('\n[3] 提前会员此刻下单');
    const advOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: members[1].token, body: { goods_id: goodsIds[0], num: 1, pay_type: 1 },
    });
    eq(advOrder.code, 1, '开通后同一时刻下单成功');
    ok(Number(advOrder.data?.order_id) > 0, '拿到订单号', JSON.stringify(advOrder.data?.order_id));

    // ---------- 4. 详情接口按会员返回提前状态 ----------
    console.log('\n[4] 商品详情按会员区分');
    const dAdv = await api(`/api/goods/shopgoods/getDetails?goods_id=${goodsIds[1]}`, { token: members[1].token });
    eq(dAdv.data?.advance_open, 1, '提前会员看到 advance_open = 1');
    eq(dAdv.data?.advance_seconds, 180, '详情带出提前 180 秒');
    eq(dAdv.data?.is_ordinary_order, 0, '场次本身仍是「未开放」');
    eq(dAdv.data?.specialarea?.state, 'upcoming', '代表场次状态 = upcoming');

    const dNo = await api(`/api/goods/shopgoods/getDetails?goods_id=${goodsIds[1]}`, { token: members[0].token });
    eq(dNo.data?.advance_open, 0, '普通会员 advance_open = 0');
    eq(dNo.data?.advance_seconds, 0, '普通会员没有提前量');

    const dGuest = await api(`/api/goods/shopgoods/getDetails?goods_id=${goodsIds[1]}`);
    eq(dGuest.code, 1, '未登录也能看详情（可选鉴权不挡游客）');
    eq(dGuest.data?.advance_open, 0, '游客 advance_open = 0');

    // ---------- 5. 关掉资格，立刻失效 ----------
    console.log('\n[5] 关闭提前抢购');
    const off = await api('/admin/api/member/advance', {
      method: 'POST', token: at, body: { member_id: members[1].mid, enable: false },
    });
    eq(off.code, 1, '关闭接口成功');
    const row2 = db.prepare('SELECT is_advance, advance_seconds FROM member WHERE member_id = ?').get(members[1].mid);
    eq(row2.is_advance, 0, 'is_advance 归 0');
    eq(row2.advance_seconds, 0, '提前量一并清零（避免下次开通带旧值）');

    const afterOff = await api('/api/order/toAddOrder', {
      method: 'POST', token: members[1].token, body: { goods_id: goodsIds[1], num: 1, pay_type: 1 },
    });
    eq(afterOff.code, 0, '关闭后同一时刻又买不了');

    // ---------- 6. 提前量上限 ----------
    console.log('\n[6] 提前量边界');
    await api('/admin/api/member/advance', {
      method: 'POST', token: at, body: { member_id: members[0].mid, enable: true, count: 0, minutes: 90 },
    });
    const capped = db.prepare('SELECT advance_seconds FROM member WHERE member_id = ?').get(members[0].mid);
    eq(capped.advance_seconds, 3600, '90 分钟被夹到上限 60 分钟（3600 秒）');

    await api('/admin/api/member/advance', {
      method: 'POST', token: at, body: { member_id: members[0].mid, enable: true, count: 0, minutes: 0 },
    });
    const zero = db.prepare('SELECT is_advance, advance_seconds FROM member WHERE member_id = ?').get(members[0].mid);
    eq(zero.is_advance, 10, '填 0 分钟仍然算开通');
    eq(zero.advance_seconds, 0, '但没有提前量，行为等同普通会员');

    const zeroOrder = await api('/api/order/toAddOrder', {
      method: 'POST', token: members[0].token, body: { goods_id: goodsIds[1], num: 1, pay_type: 1 },
    });
    eq(zeroOrder.code, 0, '开通但提前量为 0 时，照样买不了');
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
