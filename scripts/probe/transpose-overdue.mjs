/**
 * 转拍时限是「软约束」：超时仍可转拍，只在订单动态里记一笔。
 *
 * 背景：原来是硬拦 —— 支付后超过 N 小时就拒绝转拍。但货已经在会员手上，
 * 一旦超时他既不能挂牌、也卖不掉、下架后再点转拍还是被拦，这件货就永久死在他手里。
 * 现在改成：照常允许挂牌，日志标「超时挂牌」，运营看日志去催。
 *
 * 覆盖：
 *   1. 时限内转拍 → 成功，日志没有「超时挂牌」
 *   2. 超时后转拍 → 仍然成功，日志带「超时挂牌」
 *   3. 时限配 0（不限）→ 多久都能转，日志不标超时
 *
 * 独立库（transpose-overdue.db / 3465），跑完销毁。
 * 用法: node scripts/probe/transpose-overdue.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3465;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'transpose-overdue.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };

const LIMIT_HOURS = 2;
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
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

/** 北京时间的「n 小时前」，格式同 create_time */
function hoursAgo(n) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - n * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function main() {
  await runSeed();
  const { db, run, get } = await import('../../server/src/db.js');
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  // 场次 1：全天开放、上架费与涨价率 0、转拍时限 2 小时
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, transposition_hours = ?, is_open = 10', LIMIT_HOURS);
  run("UPDATE setting_config SET `value` = '0' WHERE `key` IN ('listing_fee_rate', 'price_increase_rate')");

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  const goodsIds = [];
  const memberIds = [];
  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const phone = '13911000121';
    await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: '超时挂牌' },
    });
    const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
    const mid = Number(get('SELECT member_id FROM member WHERE mobile = ?', phone)?.member_id);
    memberIds.push(mid);
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000000, remark: '超时挂牌验收' },
    });
    ok(!!tk && !!mid, '持有人就绪');

    /** 造一件在持有人手上、已支付、未挂牌的货，pay_time 由调用方决定 */
    const mk = (name, no, payTime) => {
      const gid = Number(run(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',1,0,'',?,1000,1000,0,0,1,1,1,20,10,0,1,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
        name, no, mid,
      ).lastInsertRowid);
      goodsIds.push(gid);
      run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', gid);
      const oid = Number(run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
           type, price, num, total_price, service_charge, status, pay_status, pay_type,
           consignment_status, listing_fee, pay_time, create_time)
         VALUES (?,?,1,?,?,'',1,1,1000,1,1000,0,10,10,1,0,0,?,?)`,
        `TO-${no}`, mid, gid, name, payTime, payTime,
      ).lastInsertRowid);
      return { gid, oid };
    };
    const logOf = (oid) => String(get(
      "SELECT remark FROM order_log WHERE order_id = ? AND action = '转拍上架' ORDER BY log_id DESC LIMIT 1", oid,
    )?.remark || '');

    section('[1] 时限内转拍：不标超时');
    const a = mk('时限内样品', 'TO-A', hoursAgo(0.2));
    const ca = await api('/api/order/consignment', { method: 'POST', token: tk, body: { order_id: a.oid } });
    ok(ca.code === 1, '转拍成功', ca.msg);
    ok(!logOf(a.oid).includes('超时'), '日志里没有「超时挂牌」', logOf(a.oid));

    section(`[2] 超过 ${LIMIT_HOURS} 小时后再转拍：仍然允许`);
    const b = mk('超时样品', 'TO-B', hoursAgo(LIMIT_HOURS + 3));
    const cb = await api('/api/order/consignment', { method: 'POST', token: tk, body: { order_id: b.oid } });
    ok(cb.code === 1, '★ 超时也允许转拍（不再拒绝）', cb.msg);
    ok(logOf(b.oid).includes('超时挂牌'), '★ 日志里标注了「超时挂牌」', logOf(b.oid));
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', b.oid).consignment_status, 10, '挂牌标记已置 10');
    eq(get('SELECT goods_status FROM goods WHERE goods_id = ?', b.gid).goods_status, 10, '商品已重新上架');

    section('[3] 时限配 0：多久都不算超时');
    run('UPDATE specialarea SET transposition_hours = 0 WHERE specialarea_id = 1');
    const c = mk('不限时样品', 'TO-C', hoursAgo(72));
    const cc = await api('/api/order/consignment', { method: 'POST', token: tk, body: { order_id: c.oid } });
    ok(cc.code === 1, '三天前买的也能转拍', cc.msg);
    ok(!logOf(c.oid).includes('超时'), '不限时就不标超时', logOf(c.oid));
  } finally {
    try { srv.kill(); } catch {}
    for (const gid of goodsIds) {
      const oids = db.prepare('SELECT order_id FROM orders WHERE goods_id = ?').all(gid).map((x) => x.order_id);
      for (const oid of oids) {
        run('DELETE FROM order_log WHERE order_id = ?', oid);
        run('DELETE FROM orders WHERE order_id = ?', oid);
      }
      run('DELETE FROM specialarea_goods WHERE goods_id = ?', gid);
      run('DELETE FROM goods WHERE goods_id = ?', gid);
    }
    for (const m of memberIds) {
      if (!m) continue;
      for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
        run(`DELETE FROM ${t} WHERE member_id = ?`, m);
      }
      run('DELETE FROM member WHERE member_id = ?', m);
    }
    console.log('\n已清理测试数据');
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项，通过 ${pass} 项`);
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass} 项断言`);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  process.exit(1);
});
