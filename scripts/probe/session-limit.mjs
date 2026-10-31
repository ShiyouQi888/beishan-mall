/**
 * 「每场每人限购」+「每件商品每人只能买一次」口径验收。
 *
 * 两条规则配合起来才是完整语义：
 *   1. 同一件货（一个 goods_id），一个人终身只能买一次（取消的不算）
 *   2. 本场次当天，同一个人合计最多买 N 件（不同商品合并计算），换场次/换天重新计
 *
 * 覆盖：
 *   - 同场次买到上限后，再买别的商品被拒
 *   - 同一件商品重复买被拒（即使额度还没用完）
 *   - 不同会员各自独立计数
 *   - 换场次不占本场额度
 *   - 昨天的订单不占今天额度
 *   - 未关联场次的商品不受场次限购
 *   - 详情 / getPurchaseNum 返回的额度与下单口径一致
 *   - 一次买多件直接拒
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
  const { db, run, get } = await import('../../server/src/db.js');

  // 安全阀：会写库，连错就中止
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  // 场次 1、2 改成全天开放，限购 3（否则这个时间点可能没场次在开）
  const a1 = get('SELECT * FROM specialarea WHERE specialarea_id = 1');
  const a2 = get('SELECT * FROM specialarea WHERE specialarea_id = 2');
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, open_days = ?, buy_num = ?', '1,2,3,4,5,6,7', LIMIT);
  // 系统默认只开线下转账；本用例走余额支付，测试库显式打开
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
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const mkUser = async (phone) => {
      await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: `限购${phone.slice(-4)}` },
      });
      const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
      const mid = Number(get('SELECT member_id id FROM member WHERE mobile = ?', phone)?.id);
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000000, remark: '限购验收' },
      });
      return { tk, mid, phone };
    };
    const M = await mkUser('13911000071');
    const N = await mkUser('13911000072');
    ok(!!M.tk && !!N.tk, '两个测试会员就绪');

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    // 一批货：库存 10，同一会员只能买 1 件，多人各抢 1 件
    const mkGoods = (name, no, areaId) => {
      const gid = Number(run(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',?,1,'',0,1000,1000,0,0,10,10,0,10,10,0,0,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
        name, no, catId,
      ).lastInsertRowid);
      goodsIds.push(gid);
      if (areaId) {
        run('DELETE FROM specialarea_goods WHERE goods_id = ?', gid);
        run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (?, ?, 100)', areaId, gid);
      }
      return gid;
    };

    const A = mkGoods('限购A', 'SL-A', 1);
    const B = mkGoods('限购B', 'SL-B', 1);
    const C = mkGoods('限购C', 'SL-C', 1);
    const D = mkGoods('限购D', 'SL-D', 1);
    const E = mkGoods('限购E', 'SL-E', 1);
    const F = mkGoods('限购F', 'SL-F', 2); // 另一个场次
    const G1 = mkGoods('无场次1', 'SL-G1', 0);
    const G2 = mkGoods('无场次2', 'SL-G2', 0);
    const G3 = mkGoods('无场次3', 'SL-G3', 0);

    const buy = async (user, gid, num = 1) => api('/api/order/toAddOrder', {
      method: 'POST', token: user.tk, body: { goods_id: gid, num, pay_type: 1 },
    });

    section(`[1] 本场次额度 ${LIMIT} 件，跨商品合并`);
    ok((await buy(M, A)).code === 1, 'M 买 A（第 1 件）');
    ok((await buy(M, B)).code === 1, 'M 买 B（第 2 件，额度共用）');
    ok((await buy(M, C)).code === 1, 'M 买 C（第 3 件，刚好卡满）');
    const over = await buy(M, D);
    ok(over.code === 0, 'M 再买 D 被拒（超本场额度）', over.msg);
    ok(/本场每人限购 3 件/.test(over.msg || ''), '提示写明本场限购 3 件', over.msg);
    ok(/已抢 3 件/.test(over.msg || ''), '提示带出已抢件数', over.msg);

    section('[2] 同一件商品每人只能买一次');
    const dup = await buy(M, A);
    ok(dup.code === 0 && /已经买过/.test(dup.msg || ''), 'M 再买 A 被拒（已买过）', dup.msg);
    const dupN = await buy(N, D);
    ok(dupN.code === 1, '换会员 N 买 D 成功（各自计数）', dupN.msg);
    const dupN2 = await buy(N, D);
    ok(dupN2.code === 0 && /已经买过/.test(dupN2.msg || ''), 'N 再买 D 也被拒', dupN2.msg);

    section('[3] 换场次不占本场额度');
    const other = await buy(M, F);
    ok(other.code === 1, 'M 去场次 2 买 F 成功（额度独立）', other.msg);

    section('[4] 一次买多件直接拒');
    const multi = await buy(N, B, 2);
    ok(multi.code === 0 && /不能一次购买多件/.test(multi.msg || ''), '一次买 2 件被拒', multi.msg);

    section('[5] 详情与 getPurchaseNum 口径一致');
    const det = await api(`/api/goods/getLootDetails?goods_id=${A}`, { token: M.tk });
    eq(det.data?.purchase_limit, LIMIT, '详情返回 purchase_limit = 3');
    eq(det.data?.purchase_bought, LIMIT, '详情返回 purchase_bought = 3（A/B/C 合计）');
    eq(det.data?.purchased, 1, '详情标记「本人已买过这件货」');
    // 满额时接口直接返回失败并说明原因（不再吐出额度）
    const pnFull = await api(`/api/goods/getPurchaseNum?goods_id=${D}`, { token: M.tk });
    ok(pnFull.code !== 1 && /本场每人限购 3 件/.test(pnFull.msg || ''), 'getPurchaseNum 满额时给出限购提示', pnFull.msg);
    // 没买过的会员查到完整额度
    const pn = await api(`/api/goods/getPurchaseNum?goods_id=${E}`, { token: N.tk });
    eq(pn.data?.limit, LIMIT, 'getPurchaseNum 的 limit = 3');
    eq(pn.data?.left, LIMIT - 1, 'getPurchaseNum 的 left = 2（N 本场已买过 D 一件）');

    section('[6] 昨天的订单不占今天额度');
    const moved = Number(run(
      "UPDATE orders SET create_time = date('now','+8 hours','-1 day') || ' 10:00:00' WHERE member_id = ? AND specialarea_id = 1",
      M.mid,
    ).changes || 0);
    ok(moved === 3, `把 M 在场次 1 的 ${moved} 笔订单挪到昨天`);
    const again = await buy(M, D);
    ok(again.code === 1, '挪走昨天的订单后，今天又能买 D', again.msg);
    const afterAgain = await buy(M, E);
    ok(afterAgain.code === 1, '还能继续买 E（今天额度重新从 0 开始）', afterAgain.msg);

    section('[7] 未关联场次的商品不受场次限购');
    const g1 = await buy(M, G1);
    ok(g1.code === 1, '买无场次商品 1', g1.msg);
    const g2 = await buy(M, G2);
    ok(g2.code === 1, '买无场次商品 2（说明不占场次额度）', g2.msg);
    const g3 = await buy(M, G3);
    ok(g3.code === 1, '买无场次商品 3（此时场次额度早已超 3 件）', g3.msg);
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
    for (const mobile of ['13911000071', '13911000072']) {
      const m = get('SELECT member_id FROM member WHERE mobile = ?', mobile);
      if (!m) continue;
      for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
        run(`DELETE FROM ${t} WHERE member_id = ?`, m.member_id);
      }
      run('DELETE FROM member WHERE member_id = ?', m.member_id);
    }
    run('UPDATE specialarea SET start_time = ?, end_time = ?, buy_num = ? WHERE specialarea_id = 1',
      a1.start_time, a1.end_time, a1.buy_num);
    run('UPDATE specialarea SET start_time = ?, end_time = ?, buy_num = ? WHERE specialarea_id = 2',
      a2.start_time, a2.end_time, a2.buy_num);
    console.log('\n已清理测试数据并还原场次配置');
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
