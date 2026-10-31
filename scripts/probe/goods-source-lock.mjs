/**
 * 「转拍货 / 平台货」区分 + 转拍货锁价 + 场次关联限制 验收。
 *
 * 三条规则：
 *   1. 商品管理要分得清来源：会员持有的 = 转拍货，平台自持 = 平台货（列表筛选 + 只读列）
 *   2. 转拍货的价格由系统按涨幅算，后台改价无效（标题/图片/上下架仍可改）
 *   3. 转拍货的场次由系统按轮转自动维护，后台不能手动挂到别的场次
 *
 * 独立库（goods-source.db / 3453），跑完销毁。
 * 用法: node scripts/probe/goods-source-lock.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3453;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'goods-source.db';

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

  const created = [];
  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const mkGoods = (name, no, holder, areaDate = '', areaId = 0) => {
      const gid = Number(run(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',1,0,?,?,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
        name, no, areaDate, holder,
      ).lastInsertRowid);
      created.push(gid);
      if (areaId) run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (?, ?, 100)', areaId, gid);
      return gid;
    };
    // 「转拍货」的判定依据是「被买过」：补一条已支付的抢购单，货才真正算在会员之间流转过
    const mkSoldOrder = (gid) => run(
      `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
         type, price, num, total_price, service_charge, status, pay_status, pay_type, consignment_status, create_time)
       VALUES (?,2,1,?,'锁价验收','',0,1,1000,1,1000,20,10,10,1,0,datetime('now','+8 hours'))`,
      `GSL-${gid}`, gid,
    );

    // 会员持有的转拍货：已排到场次 2
    const transGoods = mkGoods('锁价验收-转拍货', 'GS-T1', 3, '', 2);
    mkSoldOrder(transGoods);
    // 平台自持：没挂场次、也从来没卖过
    const ownGoods = mkGoods('锁价验收-平台货', 'GS-O1', 0);
    // 卖过一次但还没关联场次（测「没挂场次时允许补关联一次」）
    const freeTrans = mkGoods('锁价验收-未挂场转拍货', 'GS-T2', 3);
    mkSoldOrder(freeTrans);
    // 卖过 + 排在明天
    const futureTrans = mkGoods('锁价验收-明日转拍货', 'GS-T3', 3, '2099-01-01');
    mkSoldOrder(futureTrans);

    section('[1] 商品列表分得清来源');
    const all1 = await api('/admin/api/goods/list?page=1&limit=100', { token: at });
    const rowT = (all1.data.data || []).find((x) => x.goods_id === transGoods);
    const rowO = (all1.data.data || []).find((x) => x.goods_id === ownGoods);
    eq(rowT?._kind, '转拍货', '会员持有的标记为「转拍货」');
    eq(rowO?._kind, '平台货', '平台持有的标记为「平台货」');
    ok((all1.data.module.fields || []).some((f) => f.k === '_kind' && f.t === '来源'), '字段里带「来源」列');

    const onlyTrans = await api('/admin/api/goods/list?page=1&limit=100&kind=transpose', { token: at });
    ok((onlyTrans.data.data || []).length > 0 && (onlyTrans.data.data || []).every((x) => x._kind === '转拍货'),
      '筛「转拍货」只返回被买过的货', `${(onlyTrans.data.data || []).length} 条`);
    const onlyOwn = await api('/admin/api/goods/list?page=1&limit=100&kind=own', { token: at });
    ok((onlyOwn.data.data || []).length > 0 && (onlyOwn.data.data || []).every((x) => x._kind === '平台货'),
      '筛「平台货」只返回没成交过的货', `${(onlyOwn.data.data || []).length} 条`);
    ok(!(onlyOwn.data.data || []).some((x) => x.goods_id === transGoods), '造出来的转拍货没混进平台货列表');

    section('[2] 转拍货锁价');
    const beforeT = get('SELECT goods_min_price, base_price, price_cap, line_price, goods_name FROM goods WHERE goods_id = ?', transGoods);
    const saveT = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: {
        goods_id: transGoods, goods_name: '锁价验收-改名成功', goods_min_price: 99999, price_cap: 88888, line_price: 77777, base_price: 6666,
      },
    });
    ok(saveT.code === 1, '转拍货保存成功（改标题是允许的）', saveT.msg);
    const afterT = get('SELECT goods_min_price, base_price, price_cap, line_price, goods_name FROM goods WHERE goods_id = ?', transGoods);
    eq(afterT.goods_name, '锁价验收-改名成功', '标题改动生效');
    eq(afterT.goods_min_price, beforeT.goods_min_price, '售卖价没被改');
    eq(afterT.base_price, beforeT.base_price, '基准价没被改');
    eq(afterT.price_cap, beforeT.price_cap, '价格上限没被改');
    eq(afterT.line_price, beforeT.line_price, '划线价没被改');

    section('[3] 转拍货仍可下架');
    const offT = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: transGoods, goods_status: 20 } });
    ok(offT.code === 1, '下架成功', offT.msg);
    eq(get('SELECT goods_status FROM goods WHERE goods_id = ?', transGoods).goods_status, 20, '状态变成下架');
    await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: transGoods, goods_status: 10 } });

    section('[4] 平台货可以改价');
    const saveO = await api('/admin/api/goods/save', {
      method: 'POST', token: at, body: { goods_id: ownGoods, goods_min_price: 2345 },
    });
    ok(saveO.code === 1, '平台货保存成功', saveO.msg);
    eq(get('SELECT goods_min_price FROM goods WHERE goods_id = ?', ownGoods).goods_min_price, 2345, '平台货价格改动生效');

    section('[5] 场次关联限制');
    const pick = await api('/admin/api/specialarea/1/pick-goods', { token: at });
    const pT = (pick.data || []).find((x) => x.goods_id === transGoods);
    const pO = (pick.data || []).find((x) => x.goods_id === ownGoods);
    const pF = (pick.data || []).find((x) => x.goods_id === futureTrans);
    ok(pT?.blocked === true, '已挂其它场次的转拍货 → 禁选', pT?.blocked_reason);
    ok(/已属/.test(pT?.blocked_reason || ''), '原因写明已属哪个场次', pT?.blocked_reason);
    ok(pF?.blocked === true && /2099-01-01/.test(pF?.blocked_reason || ''), '未来日期的转拍货 → 禁选并说明日期', pF?.blocked_reason);
    ok(pO?.blocked === false, '平台货可以关联');

    const add1 = await api('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [transGoods] },
    });
    ok(add1.code === 0, '强行关联转拍货被拒', add1.msg);
    ok(/转拍商品/.test(add1.msg || ''), '拒绝理由说明是转拍商品', add1.msg);

    const add2 = await api('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [transGoods, ownGoods] },
    });
    ok(add2.code === 1, '混选时平台货照常关联、转拍货被跳过', add2.msg);
    eq(add2.data?.added, 1, '实际只加进 1 件');
    ok(Array.isArray(add2.data?.rejected) && add2.data.rejected.length === 1, '带回了被拒明细', JSON.stringify(add2.data?.rejected));

    const add3 = await api('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [freeTrans] },
    });
    ok(add3.code === 1, '没挂过场次的转拍货（今天可开抢）允许关联一次', add3.msg);
  } finally {
    try { srv.kill(); } catch {}
    for (const gid of created) {
      run('DELETE FROM specialarea_goods WHERE goods_id = ?', gid);
      run('DELETE FROM order_log WHERE order_id IN (SELECT order_id FROM orders WHERE goods_id = ?)', gid);
      run('DELETE FROM orders WHERE goods_id = ?', gid);
      run('DELETE FROM goods WHERE goods_id = ?', gid);
    }
    console.log('\n已清理测试商品');
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
