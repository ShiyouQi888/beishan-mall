/**
 * 「每场每人限购」口径验收：必须是**本场次当天跨商品合计**。
 *
 * 背景：字段叫「每场每人限购」，但旧实现按 goods_id 统计，实际是「每个商品各自限购」——
 * 同一场里买 10 件不同的货完全不受拦。这个用例把新口径钉死：
 *   1. 同场次不同商品共用一份额度
 *   2. 刚好卡满能过，超一件就拒
 *   3. 昨天的订单不占今天的额度
 *   4. 别的场次不占本场额度
 *   5. 详情接口返回 purchase_limit / purchase_bought
 *
 * 独立库（session-limit.db / 3451），跑完销毁，不碰演示库。
 * 用法: node scripts/probe/session-limit.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3451;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'session-limit.db';

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

const LIMIT = 3;

async function main() {
  await runSeed();
  const { db, run, get, all } = await import('../../server/src/db.js');

  // 安全阀：会写库，连错就中止
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  // 场次 1 改成全天开放（否则现在这个时间点可能没场次在开），限购设 3
  const area = get('SELECT * FROM specialarea WHERE specialarea_id = 1');
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, open_days = ?, buy_num = ? WHERE specialarea_id = 1',
    '1,2,3,4,5,6,7', LIMIT);
  const area2 = get('SELECT * FROM specialarea WHERE specialarea_id = 2');
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, open_days = ?, buy_num = ? WHERE specialarea_id = 2',
    '1,2,3,4,5,6,7', LIMIT);

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

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    // 临时会员
    const phone = '13911000071';
    const pwd = 'sl123456';
    const reg = await api('/api/member/registerAnAccount', {
      method: 'POST', body: { phone, password: pwd, code: 'boss01', nickName: '限购验收' },
    });
    ok(reg.code === 1, '注册临时会员', reg.msg);
    const token = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: pwd } })).data?.token;
    const mid = Number(get('SELECT member_id FROM member WHERE mobile = ?', phone)?.member_id);
    ok(!!token && !!mid, '临时会员登录');

    // 两个「一批货」商品，都挂场次 1，库存 10
    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const mkGoods = (name, no, areaId) => Number(run(
      `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
         member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
         goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
       VALUES (?,?,'/uploads/demo-1.svg','[]','',?,1,'',0,1000,1000,0,0,10,10,0,10,10,0,0,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
      name, no, catId,
    ).lastInsertRowid);

    const gA = mkGoods('限购样品A', 'SL-A');
    const gB = mkGoods('限购样品B', 'SL-B');
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', gA);
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 101)', gB);

    // 场次 2 的商品：用于验证「别的场次不占本场额度」
    const gC = mkGoods('限购样品C', 'SL-C');
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (2, ?, 100)', gC);

    section('[1] 同场次不同商品共用额度');
    const buy = async (goodsId, num) => api('/api/order/toAddOrder', {
      method: 'POST', token, body: { goods_id: goodsId, num, pay_type: 0 },
    });

    const a2 = await buy(gA, 2);
    ok(a2.code === 1, `A 买 2 件成功（额度 ${LIMIT}）`, a2.msg);
    const b2 = await buy(gB, 2);
    ok(b2.code === 0, 'B 再买 2 件被拒（2+2 > 3）', b2.msg);
    ok(/本场每人限购 3 件/.test(b2.msg || ''), '提示里写明「本场每人限购 3 件」', b2.msg);
    ok(/已抢 2 件/.test(b2.msg || ''), '提示里带出已抢件数', b2.msg);

    const b1 = await buy(gB, 1);
    ok(b1.code === 1, 'B 改买 1 件刚好卡满（2+1=3）', b1.msg);
    const a1 = await buy(gA, 1);
    ok(a1.code === 0, '额度用尽后再买 A 也被拒', a1.msg);
    ok(/还能再抢 0 件/.test(a1.msg || ''), '提示剩余 0 件', a1.msg);

    section('[2] 别的场次不占本场额度');
    const c2 = await buy(gC, 2);
    ok(c2.code === 1, '场次 2 的商品可以另买 2 件', c2.msg);
    const c2b = await buy(gC, 2);
    ok(c2b.code === 0, '场次 2 自己的额度也会卡（2+2 > 3）', c2b.msg);

    section('[3] 昨天的订单不占今天额度');
    // 把场次 1 的那两笔挪到昨天，今天的额度应恢复
    run("UPDATE orders SET create_time = date('now', '+8 hours', '-1 day') || ' 10:00:00' WHERE specialarea_id = 1");
    // seed 自带一条演示订单也挂在场次 1，所以只断言「至少这两笔都在昨天」，不写死总数
    const movedTo = Number(get(
      "SELECT COUNT(*) c FROM orders WHERE specialarea_id = 1 AND date(create_time) = date('now','+8 hours','-1 day')",
    ).c);
    ok(movedTo >= 2, `本场订单已挪到昨天（${movedTo} 笔）`);
    const again = await buy(gA, 2);
    ok(again.code === 1, '挪走昨天的订单后，今天又能买 2 件', again.msg);

    section('[4] 详情接口透出额度');
    const d = await api(`/api/goods/getLootDetails?goods_id=${gA}`, { token });
    eq(d.data?.purchase_limit, LIMIT, '详情返回 purchase_limit = 3');
    eq(d.data?.purchase_bought, 2, '详情返回 purchase_bought = 2（刚买的这两件）');
    const pn = await api(`/api/goods/getPurchaseNum?goods_id=${gA}`, { token });
    eq(pn.data?.limit, LIMIT, 'getPurchaseNum 的 limit = 3');
    eq(pn.data?.left, 1, 'getPurchaseNum 的 left = 1');
    const pnFull = await api(`/api/goods/getPurchaseNum?goods_id=${gB}`, { token });
    eq(pnFull.data?.left, 1, 'B 也共用同一份额度（left = 1）');

    section('[5] 未关联场次的商品不受限');
    const gD = mkGoods('限购样品D', 'SL-D');
    const d1 = await buy(gD, 5);
    ok(d1.code === 1, '未关联场次的商品可以一次买 5 件', d1.msg);

    // 清理造的数据
    for (const gid of [gA, gB, gC, gD]) {
      const oids = all('SELECT order_id FROM orders WHERE goods_id = ?', gid).map((x) => x.order_id);
      for (const oid of oids) {
        run('DELETE FROM order_log WHERE order_id = ?', oid);
        run('DELETE FROM orders WHERE order_id = ?', oid);
      }
      run('DELETE FROM specialarea_goods WHERE goods_id = ?', gid);
      run('DELETE FROM goods WHERE goods_id = ?', gid);
    }
    for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
      run(`DELETE FROM ${t} WHERE member_id = ?`, mid);
    }
    run('DELETE FROM member WHERE member_id = ?', mid);
    run('UPDATE specialarea SET start_time = ?, end_time = ?, buy_num = ? WHERE specialarea_id = 1',
      area.start_time, area.end_time, area.buy_num);
    run('UPDATE specialarea SET start_time = ?, end_time = ?, buy_num = ? WHERE specialarea_id = 2',
      area2.start_time, area2.end_time, area2.buy_num);
    console.log('\n已清理测试数据并还原场次配置');
  } finally {
    try { srv.kill(); } catch {}
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
