/**
 * 「转拍货失去场次时自动退货」验收。
 *
 * 背景：转拍的货被绑定到某一手场次。如果运营把商品从场次里移除、或者把整个场次删掉，
 * 关联没了但 goods.area_date 和订单的 consignment_status=10 还在，货就进入死锁：
 * H5 看不到、到期扫描跳过、持有人点转拍被「已挂牌」拦住 —— 货凭空消失。
 *
 * 覆盖：
 *   1. 在挂牌的转拍货：不能直接从场次移除，也不能连带删除场次（先让运营处理持有人那一手）
 *   2. 先下架 → 在挂标记自动归零 → 再移除/删场次就放行
 *   3. 双挂场次只移除一个 → 不受影响
 *   4. 历史悬空货（无场次 + 在挂 + 已过期）→ 定时扫描自愈
 *   5. 平台自营商品（member_id=0）不受影响
 *
 * 独立库（listing-release.db / 3459），跑完销毁。
 * 用法: node scripts/probe/listing-release.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3459;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'listing-release.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '1500' };

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
  const { db, run, get, all } = await import('../../server/src/db.js');
  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  // 场次全天开放、转拍时限不限、上架费率 0（只验退货，不掺财务）
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, transposition_hours = 0, buy_num = 999, is_open = 10');
  run("UPDATE setting_config SET `value` = '0' WHERE `key` = 'listing_fee_rate'");

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
  const today = String(get("SELECT date('now','+8 hours') d")?.d || '');
  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const mkUser = async (phone) => {
      await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: `退货${phone.slice(-4)}` },
      });
      const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
      const mid = Number(get('SELECT member_id id FROM member WHERE mobile = ?', phone)?.id);
      memberIds.push(mid);
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 1000000, remark: '退货验收' },
      });
      return { tk, mid };
    };

    const M = await mkUser('13911000101');
    ok(!!M.tk && !!M.mid, '持有人就绪');

    /** 造一件「会员持有 + 在挂 + 已支付订单」的货，并挂到指定场次 */
    const mkListed = (name, no, areaIds, areaDate = today, holder = M.mid) => {
      const gid = Number(run(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',1,0,?,?,1000,1000,0,0,1,1,1,10,10,0,1,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
        name, no, areaDate, holder,
      ).lastInsertRowid);
      goodsIds.push(gid);
      for (const a of areaIds) {
        run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (?, ?, 100)', a, gid);
      }
      const oid = Number(run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
           type, price, num, total_price, service_charge, status, pay_status, pay_type,
           consignment_status, listing_fee, transposition_time, pay_time, create_time)
         VALUES (?,?,1,?,?,'',?,1,1000,1,1000,0,10,10,1,10,0,?,?,datetime('now','+8 hours'))`,
        `LR-${no}`, holder, gid, name, areaIds[0] || 0,
        `${today} 10:00:00`, `${today} 09:00:00`,
      ).lastInsertRowid);
      return { gid, oid };
    };

    section('[1] 在挂牌的转拍货：移除被拦、删场次被拦');
    const a = mkListed('退货验收A', 'LR-A', [1]);
    const rm = await api('/admin/api/specialarea/goods/remove', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [a.gid] },
    });
    ok(rm.code === 0, '在挂牌的转拍货不能直接从场次移除', rm.msg);
    ok(/正在本场挂牌/.test(rm.msg || ''), '提示说明它正在挂牌', rm.msg);
    ok(/商品管理/.test(rm.msg || ''), '提示给出处理路径（先去商品管理下架）', rm.msg);
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', a.oid).consignment_status, 10, '被拦后商品仍在挂（没被静默处理）');
    eq(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', a.gid).c, 1, '关联也还在');

    const del1 = await api('/admin/api/specialarea/remove', { method: 'POST', token: at, body: { id: 1 } });
    ok(del1.code === 0, '场内还有在挂牌的货时，删场次也被拦', del1.msg);
    ok(/不能删除/.test(del1.msg || ''), '提示说明不能删除', del1.msg);
    ok(!!get('SELECT 1 FROM specialarea WHERE specialarea_id = 1'), '场次没被删掉');

    section('[1b] 先下架 → 挂牌解除 → 移除/删场次放行');
    const offA = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: a.gid, goods_status: 20 } });
    ok(offA.code === 1, '商品下架成功', offA.msg);
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', a.oid).consignment_status, 0,
      '下架同时解除挂牌（不用等场次结束）');
    const rmOk = await api('/admin/api/specialarea/goods/remove', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [a.gid] },
    });
    ok(rmOk.code === 1, '下架后可以正常移除', rmOk.msg);
    eq(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', a.gid).c, 0, '关联已删除');

    // 重新申请转拍，验证退牌之后能重新挂牌
    run('UPDATE goods SET goods_status = 10 WHERE goods_id = ?', a.gid);
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', a.gid);
    const consign = await api('/api/order/consignment', { method: 'POST', token: M.tk, body: { order_id: a.oid } });
    ok(consign.code === 1, '持有人可以重新转拍', consign.msg);
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', a.oid).consignment_status, 10, '重新挂牌后标记回到 10');

    section('[2] 双挂场次只移除一个 → 不退货');
    const b = mkListed('退货验收B', 'LR-B', [1, 2]);
    const rm2 = await api('/admin/api/specialarea/goods/remove', {
      method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [b.gid] },
    });
    ok(rm2.code === 1, '移除成功', rm2.msg);
    const gB = get('SELECT goods_status FROM goods WHERE goods_id = ?', b.gid);
    eq(gB.goods_status, 10, '商品仍在架（还有场次 2 可卖）');
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', b.oid).consignment_status, 10, '在挂标记保持 10');

    section('[3] 删除临时场次：有人在挂就拦，下架后放行');
    const tmpArea = Number(run(
      "INSERT INTO specialarea (name, title_main, start_time, end_time, open_days, buy_num, transposition_hours, is_subscribe, is_open, sort, create_time) VALUES ('', '临时待删场次', 0, 86399, '1,2,3,4,5,6,7', 10, 0, 0, 10, 200, datetime('now','+8 hours'))",
    ).lastInsertRowid);
    const c = mkListed('退货验收C', 'LR-C', [tmpArea]);
    const delBlocked = await api('/admin/api/specialarea/remove', { method: 'POST', token: at, body: { id: tmpArea } });
    ok(delBlocked.code === 0, '场内转拍货在挂时删除被拦', delBlocked.msg);
    ok(/退货验收C/.test(delBlocked.msg || ''), '提示里点名是哪件货', delBlocked.msg);
    ok(!!get('SELECT 1 FROM specialarea WHERE specialarea_id = ?', tmpArea), '场次还在');

    await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: c.gid, goods_status: 20 } });
    const delOk = await api('/admin/api/specialarea/remove', { method: 'POST', token: at, body: { id: tmpArea } });
    ok(delOk.code === 1, '把货下架后可以删除场次', delOk.msg);
    ok(!get('SELECT 1 FROM specialarea WHERE specialarea_id = ?', tmpArea), '场次已删除');
    eq(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', c.gid).c, 0, '场次关联随之清空');

    section('[4] 历史悬空货 → 定时扫描自愈');
    // 造一件「无场次 + 在挂 + 日期已过」的货，模拟本次修复前留下的死锁数据
    const d = mkListed('退货验收D', 'LR-D', []);
    run("UPDATE goods SET area_date = date('now','+8 hours','-1 day') WHERE goods_id = ?", d.gid);
    ok(Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE goods_id = ?', d.gid).c) === 0, '前置：这件货没有任何场次');
    // 等扫描（间隔 1.5 秒）
    let healed = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      if (Number(get('SELECT goods_status FROM goods WHERE goods_id = ?', d.gid).goods_status) === 20) { healed = true; break; }
    }
    ok(healed, '扫描把悬空货自动下架');
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', d.oid).consignment_status, 0, '在挂标记已归零');
    eq(get('SELECT area_date FROM goods WHERE goods_id = ?', d.gid).area_date, '', '开抢日期已清空');

    section('[5] 平台自营商品不受影响');
    const e = mkListed('退货验收E', 'LR-E', [], today, 0); // member_id = 0
    run('UPDATE orders SET consignment_status = 10 WHERE order_id = ?', e.oid);
    const rm3 = await api('/admin/api/specialarea/goods/remove', {
      method: 'POST', token: at, body: { specialarea_id: 2, goods_ids: [e.gid] },
    });
    ok(rm3.code !== 1 ? /不在本场次|正在本场挂牌/.test(rm3.msg || '') : true, '接口对平台货不会触发退货', rm3.msg);
    eq(get('SELECT goods_status FROM goods WHERE goods_id = ?', e.gid).goods_status, 10, '平台货没被下架');

    section('[6] 后台下架转拍货 → 在挂标记归零');
    const f = mkListed('退货验收F', 'LR-F', [1]);
    const off = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_id: f.gid, goods_status: 20 } });
    ok(off.code === 1, '下架成功', off.msg);
    eq(get('SELECT consignment_status FROM orders WHERE order_id = ?', f.oid).consignment_status, 0,
      '下架同时把在挂标记归零（重新上架后可以直接转拍）');
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
    for (const mid of memberIds) {
      if (!mid) continue;
      for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
        run(`DELETE FROM ${t} WHERE member_id = ?`, mid);
      }
      run('DELETE FROM member WHERE member_id = ?', mid);
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
