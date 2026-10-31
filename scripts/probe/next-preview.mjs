/**
 * 「已转拍 · 下一场开抢」预告卡验收。
 *
 * 背景：一件货被买走后又被转拍，会排到下一场（可能是明天）。按规则它今天不该出现在场次列表里，
 * 于是用户看到的就是「刚看到的货凭空消失了」。抢购页现在额外返回一块 preview，
 * 用预告卡说明它还在、哪天开抢、下一场标价多少；详情页也要明确禁用按钮并写出开抢时间。
 *
 * 覆盖：
 *   1. 排到明天的货 → preview 里有它，带下一场时间与标价
 *   2. 详情接口 not_yet_open = 1、is_ordinary_order = 0
 *   3. 此时下单被拒，提示里带开抢日期
 *   4. 把开抢日期改回今天 → preview 不再包含它（它回到正常场次列表）
 *   5. 没有转拍（consignment_status=0）的货不会进预告
 *
 * 独立库（next-preview.db / 3467），跑完销毁。
 * 用法: node scripts/probe/next-preview.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3467;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'next-preview.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
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

async function main() {
  await runSeed();
  const { db, run, get } = await import('../../server/src/db.js');
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  const today = String(get("SELECT date('now','+8 hours') d")?.d || '');
  const tomorrow = String(get("SELECT date('now','+8 hours','+1 day') d")?.d || '');
  // 场次 1 全天开放、限购放开，方便测「场次开着但日期没到」
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, is_open = 10 WHERE specialarea_id = 1');
  run("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'");

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
  try {
    const phone = '13911000171';
    await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: '预告验收' },
    });
    const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
    const mid = Number(get('SELECT member_id FROM member WHERE mobile = ?', phone)?.member_id);
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000000, remark: '预告验收' },
    });
    ok(!!tk && !!mid, '会员就绪');
    // 下单要用另一个会员：自己不能买自己持有的货，否则先被「不能购买自己持有的商品」拦住
    const bPhone = '13911000172';
    await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone: bPhone, password: bPhone, code: 'boss01', nickName: '预告买家' },
    });
    const btk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: bPhone, password: bPhone } })).data?.token;
    const bmid = Number(get('SELECT member_id FROM member WHERE mobile = ?', bPhone)?.member_id);
    await api('/admin/api/member/adjust', {
      method: 'POST', token: at, body: { member_id: bmid, field: 'amount', value: 5000000, remark: '预告验收' },
    });
    ok(!!btk, '另一个买家就绪');

    /** 造一件「会员持有 + 已成交 + 已转拍 + 排到指定日期」的货 */
    const mk = (name, no, areaDate, listed = 10) => {
      const gid = Number(run(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',1,1,?,?,2000,1000,0,0,1,1,1,10,10,0,1,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
        name, no, areaDate, mid,
      ).lastInsertRowid);
      goodsIds.push(gid);
      run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', gid);
      run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
           type, price, num, total_price, service_charge, status, pay_status, pay_type,
           consignment_status, listing_fee, transposition_time, pay_time, create_time)
         VALUES (?,?,1,?,?,'',1,1,2000,1,2000,40,10,10,1,?,0,?,?,datetime('now','+8 hours'))`,
        `NP-${no}`, mid, gid, name, listed,
        `${today} 10:00:00`, `${today} 09:00:00`,
      );
      return gid;
    };

    const futureGoods = mk('预告-明天开抢', 'NP-A', tomorrow);
    const normalGoods = mk('预告-今天正常', 'NP-B', today);
    const notListed = mk('预告-没挂牌', 'NP-C', tomorrow, 0);

    section('[1] 抢购页返回的预告');
    const loot = await api('/api/goods/getLootList');
    const preview = loot.data?.preview || [];
    const hit = preview.find((x) => Number(x.goods_id) === futureGoods);
    ok(!!hit, '排到明天的货出现在预告里', JSON.stringify(preview.map((x) => x.goods_name)));
    eq(hit?.price, '2000.00', '预告显示下一场标价');
    ok(/开抢$/.test(hit?.next_text || ''), '带开抢时间文案', hit?.next_text);
    ok((hit?.next_text || '').includes(tomorrow.slice(5)), '文案里有明天的日期', hit?.next_text);
    ok(!preview.some((x) => Number(x.goods_id) === normalGoods), '今天开抢的货不进预告（正常列表里有它）');
    ok(!preview.some((x) => Number(x.goods_id) === notListed), '没挂牌（consignment_status=0）的不进预告');

    section('[2] 详情接口标记「还没到开抢日」');
    const det = await api(`/api/goods/getLootDetails?goods_id=${futureGoods}`, { token: tk });
    eq(det.data?.not_yet_open, 1, 'not_yet_open = 1');
    eq(det.data?.is_ordinary_order, 0, 'is_ordinary_order = 0（按钮不可点）');
    eq(det.data?.area_date, tomorrow, '带出开抢日期');

    section('[3] 此时下单被拒');
    const buy = await api('/api/order/toAddOrder', { method: 'POST', token: btk, body: { goods_id: futureGoods, num: 1, pay_type: 1 } });
    ok(buy.code === 0, '下单被拒', buy.msg);
    ok(/开抢/.test(buy.msg || ''), '提示里说明开抢日期', buy.msg);

    section('[4] 日期改回今天 → 回到正常列表、退出预告');
    run('UPDATE goods SET area_date = ? WHERE goods_id = ?', today, futureGoods);
    const loot2 = await api('/api/goods/getLootList');
    ok(!(loot2.data?.preview || []).some((x) => Number(x.goods_id) === futureGoods), '预告里不再有它');
    const inList = (loot2.data?.list || [])
      .flatMap((a) => a.goods_list || [])
      .some((x) => Number(x.goods_id) === futureGoods);
    ok(inList, '它回到了本场正常商品列表');
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
    for (const phone of ['13911000171', '13911000172']) {
      const m = get('SELECT member_id FROM member WHERE mobile = ?', phone);
      if (!m) continue;
      for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
        run(`DELETE FROM ${t} WHERE member_id = ?`, m.member_id);
      }
      run('DELETE FROM member WHERE member_id = ?', m.member_id);
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
