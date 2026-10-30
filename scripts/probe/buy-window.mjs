// 抢购总时间：全站统一时间窗口对「场次可抢状态」与「下单校验」的影响
// 独立库（buy-window.db / 3411），不碰演示库
// 用法: node scripts/probe/buy-window.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3411;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'buy-window.db';

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
    const buyer = db.prepare("SELECT * FROM member WHERE mobile = '13822367845'").get();
    const mToken = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: buyer.mobile, password: buyer.mobile } })).data?.token;
    ok(!!mToken, '测试会员登录');
    // 给买家充够余额，避免下单时被余额挡住
    await api('/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: buyer.member_id, field: 'amount', value: 500000, remark: '冒烟充值' } });

    const setWindow = (v) => api('/admin/api/setting/save', { method: 'POST', token: at, body: { group: 'trade', values: v } });
    const target = db.prepare("SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND member_id <> ? LIMIT 1").get(buyer.member_id);
    ok(!!target, '存在可抢购的他人商品');

    const orderOnce = () =>
      api('/api/order/toAddOrder', { method: 'POST', token: mToken, body: { goods_id: target.goods_id, num: 1, pay_type: 1 } });

    // ---------- 默认：不限时、每天开放 ----------
    section('[1] 默认总时间（0/0 = 全天、每天）');
    await setWindow({ buy_open_days: '1,2,3,4,5,6,7', buy_start_time: '0', buy_end_time: '0' });
    const listOpen = await api('/api/goods/getLootList');
    const areasOpen = listOpen.data?.list || [];
    ok(areasOpen.length > 0 && areasOpen.every((a) => a.is_ordinary_order === 1), '场次全部标记可抢', `${areasOpen.length} 场`);
    ok(areasOpen[0]?.time?.start_end_time === '00:00', '开始时间显示 00:00（0 秒不当成空）', areasOpen[0]?.time?.start_end_time);
    const detailOpen = await api(`/api/goods/getLootDetails?goods_id=${target.goods_id}`);
    ok(detailOpen.data?.is_ordinary_order === 1, '商品详情标记可抢');
    const orderOpen = await orderOnce();
    ok(orderOpen.code === 1, '开放时间内可以下单', orderOpen.msg);

    // ---------- 关闭：一天只开 00:00-00:00 ----------
    section('[2] 窗口外：场次不可抢、下单被拒');
    await setWindow({ buy_open_days: '1,2,3,4,5,6,7', buy_start_time: '0', buy_end_time: '1' });
    const listClosed = await api('/api/goods/getLootList');
    ok((listClosed.data?.list || []).every((a) => a.is_ordinary_order === 0), '场次全部标记不可抢');
    const detailClosed = await api(`/api/goods/getLootDetails?goods_id=${target.goods_id}`);
    ok(detailClosed.data?.is_ordinary_order === 0, '商品详情标记不可抢');
    const listed = db.prepare("SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND member_id <> ? LIMIT 1").get(buyer.member_id);
    const orderClosed = await api('/api/order/toAddOrder', { method: 'POST', token: mToken, body: { goods_id: listed.goods_id, num: 1, pay_type: 1 } });
    ok(orderClosed.code === 0 && /不在抢购时间/.test(orderClosed.msg), '下单被时间校验拦住', orderClosed.msg);

    // ---------- 非开放日 ----------
    section('[3] 非开放日：下单被拒');
    const jsDay = new Date().getDay();
    const today = jsDay === 0 ? 7 : jsDay;
    const otherDay = today === 1 ? 2 : 1;
    await setWindow({ buy_open_days: String(otherDay), buy_start_time: '0', buy_end_time: '0' });
    const orderDay = await api('/api/order/toAddOrder', { method: 'POST', token: mToken, body: { goods_id: listed.goods_id, num: 1, pay_type: 1 } });
    ok(orderDay.code === 0 && /不是抢购日/.test(orderDay.msg), `今日(周${today})不在开放日被拒`, orderDay.msg);
    const listDay = await api('/api/goods/getLootList');
    ok((listDay.data?.list || []).every((a) => a.is_ordinary_order === 0), '非开放日场次也不可抢');

    // ---------- 恢复 ----------
    section('[4] 改回全天后恢复');
    await setWindow({ buy_open_days: '1,2,3,4,5,6,7', buy_start_time: '0', buy_end_time: '0' });
    const listBack = await api('/api/goods/getLootList');
    ok((listBack.data?.list || []).every((a) => a.is_ordinary_order === 1), '场次恢复可抢');
    const again = api('/api/order/toAddOrder', {
      method: 'POST', token: mToken,
      body: { goods_id: db.prepare("SELECT goods_id FROM goods WHERE type = 1 AND goods_status = 10 AND member_id <> ? LIMIT 1").get(buyer.member_id)?.goods_id, num: 1, pay_type: 1 },
    });
    const againRes = await again;
    ok(againRes.code === 1, '恢复后又能下单', againRes.msg);
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
