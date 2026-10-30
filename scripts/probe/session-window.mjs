// 场次独立时段：每个场次按自己的「周几 + 时段」开放，已结束的排到后面
// 独立库（session-window.db / 3417）
// 用法: node scripts/probe/session-window.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3417;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'session-window.db';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await runSeed();
  const { db } = await import('../../server/src/db.js');

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
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
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const fore = db.prepare("SELECT * FROM specialarea WHERE name = 'forenoon'").get();
    const after = db.prepare("SELECT * FROM specialarea WHERE name = 'afternoon'").get();
    const even = db.prepare("SELECT * FROM specialarea WHERE name = 'evening'").get();

    section('[1] 种子里的三个场次各有时段');
    eq(fore.start_time, 8 * 3600, '上午场 08:00 开始');
    eq(fore.end_time, 12 * 3600, '上午场 12:00 结束');
    eq(after.start_time, 13 * 3600, '下午场 13:00 开始');
    eq(after.end_time, 17 * 3600, '下午场 17:00 结束');

    section('[2] 后台保存场次时间（前端选择器提交的是秒）');
    const save = await api('/admin/api/specialarea/save', {
      method: 'POST', token: at,
      body: { specialarea_id: fore.specialarea_id, start_time: 8 * 3600, end_time: 12 * 3600, open_days: '1,2,3,4,5,6,7', title_main: fore.title_main },
    });
    ok(save.code === 1, '保存成功', save.msg);
    const foreBack = db.prepare('SELECT * FROM specialarea WHERE specialarea_id = ?').get(fore.specialarea_id);
    eq(foreBack.start_time, 8 * 3600, '开始时间回读正确');
    eq(foreBack.end_time, 12 * 3600, '结束时间回读正确');

    // 找一个上午场的商品 + 买家
    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const mToken = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: buyer.mobile, password: buyer.mobile } })).data?.token;
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer.member_id, field: 'amount', value: 900000, remark: '冒烟充值' } });
    await api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: { service_charge: '0', listing_fee_rate: '0' } } });
    const target = db.prepare(
      "SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND specialarea_id = ? AND member_id <> ? LIMIT 1",
    ).get(fore.specialarea_id, buyer.member_id);
    ok(!!target, '上午场有可买商品');

    // 把「上午场」的窗口设成不覆盖现在：已结束
    const nowSec = Math.floor(Date.now() / 1000);
    const nowOfDay = nowSec - new Date().setHours(0, 0, 0, 0) / 1000;
    const closedStart = Math.max(0, Math.floor(nowOfDay) - 7200);
    const closedEnd = Math.max(1, Math.floor(nowOfDay) - 3600);
    db.prepare('UPDATE specialarea SET start_time = ?, end_time = ? WHERE specialarea_id = ?')
      .run(closedStart, closedEnd, fore.specialarea_id);
    // 下午场窗口覆盖现在
    db.prepare('UPDATE specialarea SET start_time = ?, end_time = ? WHERE specialarea_id = ?')
      .run(Math.max(0, Math.floor(nowOfDay) - 600), Math.min(86399, Math.floor(nowOfDay) + 3600), after.specialarea_id);

    section('[3] 已结束的场次排到最后');
    const loot1 = await api('/api/goods/getLootList');
    const order1 = (loot1.data?.list || []).map((a) => a.name);
    ok(order1.length >= 2, '场次列表可读', order1.join(','));
    ok(order1[0] !== 'forenoon', '已结束的上午场不再排第一', order1.join(','));

    const foreNow = (loot1.data?.list || []).find((a) => a.name === 'forenoon');
    ok(foreNow && foreNow.is_ordinary_order === 0, '上午场标记为不可抢');
    const afterNow = (loot1.data?.list || []).find((a) => a.name === 'afternoon');
    ok(afterNow && afterNow.is_ordinary_order === 1, '下午场标记为可抢');

    section('[4] 已结束的场次不能下单');
    const closedOrder = await api('/api/order/toAddOrder', { method: 'POST', token: mToken, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(closedOrder.code === 0 && /不在该场次抢购时间内|已结束|开抢/.test(closedOrder.msg), '窗口外下单被拒', closedOrder.msg);

    section('[5] 非开放日不能下单');
    const jsDay = new Date().getDay();
    const today = jsDay === 0 ? 7 : jsDay;
    const otherDay = today === 1 ? 2 : 1;
    db.prepare('UPDATE specialarea SET open_days = ?, start_time = 0, end_time = 86399 WHERE specialarea_id = ?')
      .run(String(otherDay), fore.specialarea_id);
    const dayOrder = await api('/api/order/toAddOrder', { method: 'POST', token: mToken, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(dayOrder.code === 0 && /今日未开放该场次/.test(dayOrder.msg), `今日(周${today})不在开放日被拒`, dayOrder.msg);

    section('[6] 恢复开放后可以下单');
    db.prepare('UPDATE specialarea SET open_days = ?, start_time = 0, end_time = 86399 WHERE specialarea_id = ?')
      .run('1,2,3,4,5,6,7', fore.specialarea_id);
    const okOrder = await api('/api/order/toAddOrder', { method: 'POST', token: mToken, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });
    ok(okOrder.code === 1, '窗口内下单成功', okOrder.msg);
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
