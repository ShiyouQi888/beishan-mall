/**
 * 场次「启用状态」是否真的生效。
 *
 * 背景：配置页写着「停用后本场不出现在前台抢购页，也不参与下单校验」，
 * 但原来 is_open 只在场次列表接口里过滤，商品列表与下单校验都不看它 —— 停用等于没停。
 *
 * 覆盖：
 *   1. 启用时可买、列表可见
 *   2. 停用后：H5 列表看不到、下单被拒且提示「场次已停用」
 *   3. 重新启用后恢复
 *   4. 同时挂「停用场 + 启用场」的商品不受影响（还有能卖的那一场）
 *   5. 没关联任何场次的自由商品不受影响
 *
 * 独立库（area-disabled.db / 3457），跑完销毁。
 * 用法: node scripts/probe/area-disabled.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'area-disabled.db';

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

  // 场次 1 全天开放（方便测量），同时打开余额支付
  run('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, is_open = 10 WHERE specialarea_id = 1');
  run("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_pending'");
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
  const memberIds = [];
  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    const mkUser = async (phone) => {
      await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: phone, code: 'boss01', nickName: `停用场${phone.slice(-4)}` },
      });
      const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: phone } })).data?.token;
      const mid = Number(get('SELECT member_id id FROM member WHERE mobile = ?', phone)?.id);
      memberIds.push(mid);
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 1000000, remark: '停用场次验收' },
      });
      return tk;
    };

    const mkGoods = (name, no, areaIds) => {
      const gid = Number(run(
        `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
           member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
           goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
         VALUES (?,?,'/uploads/demo-1.svg','[]','',1,0,'',0,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
        name, no,
      ).lastInsertRowid);
      goodsIds.push(gid);
      for (const a of areaIds) {
        run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (?, ?, 100)', a, gid);
      }
      return gid;
    };

    const inList = async (gid) => {
      const r = await api('/api/goods/getLootGoodsList?page=1&limit=100');
      return (r.data?.data || []).some((x) => Number(x.goods_id) === gid);
    };
    // 分类页走的是 LIST_VISIBLE，用来验证「没有关联场次的自由商品」是否被误伤
    const inCategory = async (gid) => {
      const cat = Number(get('SELECT category_id FROM goods WHERE goods_id = ?', gid)?.category_id) || 0;
      const r = await api(`/api/goods/category/getCategoryGoodsList?category_id=${cat}&page=1&limit=100`);
      return (r.data?.data || []).some((x) => Number(x.goods_id) === gid);
    };
    const buy = async (token, gid) => api('/api/order/toAddOrder', {
      method: 'POST', token, body: { goods_id: gid, num: 1, pay_type: 1 },
    });

    const gOnlyArea1 = mkGoods('停用场次-只挂场次1', 'AD-1', [1]);
    const gFree = mkGoods('停用场次-无场次', 'AD-2', []);
    const U1 = await mkUser('13911000091');
    const U2 = await mkUser('13911000092');
    const U3 = await mkUser('13911000093');
    const U4 = await mkUser('13911000094');

    section('[1] 场次启用时：正常可买');
    ok(await inList(gOnlyArea1), '商品出现在 H5 抢购列表');
    ok(await inCategory(gOnlyArea1), '商品出现在分类列表');
    const b1 = await buy(U1, gOnlyArea1);
    ok(b1.code === 1, '下单成功', b1.msg);

    section('[2] 停用场次后：不可见、不可买');
    run('UPDATE specialarea SET is_open = 20 WHERE specialarea_id = 1');
    ok(!(await inList(gOnlyArea1)), '商品已从 H5 抢购列表消失');
    ok(!(await inCategory(gOnlyArea1)), '商品也已从分类列表消失');
    const b2 = await buy(U2, gOnlyArea1);
    ok(b2.code === 0, '下单被拒', b2.msg);
    ok(/场次已停用/.test(b2.msg || ''), '提示写明「场次已停用」', b2.msg);

    const detail = await api(`/api/goods/getLootDetails?goods_id=${gOnlyArea1}`, { token: U2 });
    ok(Number(detail.data?.is_ordinary_order) === 0, '详情接口也标记为「当前不可下单」', String(detail.data?.is_ordinary_order));

    section('[3] 自由商品（没关联任何场次）不受影响');
    ok(await inCategory(gFree), '自由商品仍在分类列表里（没被场次过滤误伤）');
    const b3 = await buy(U3, gFree);
    ok(b3.code === 1, '自由商品照常可买', b3.msg);

    section('[4] 重新启用后恢复');
    run('UPDATE specialarea SET is_open = 10 WHERE specialarea_id = 1');
    ok(await inList(gOnlyArea1), '商品重新出现在列表');
    // 换个人买（同一件货每人只能买一次）
    const gOnlyArea1b = mkGoods('停用场次-只挂场次1-二号', 'AD-3', [1]);
    const b4 = await buy(U4, gOnlyArea1b);
    ok(b4.code === 1, '恢复启用后可正常下单', b4.msg);

    section('[5] 同时挂「停用场 + 启用场」：不受影响');
    // 场次 2 设为全天启用
    run('UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 999, is_open = 10 WHERE specialarea_id = 2');
    const gMulti = mkGoods('停用场次-双挂', 'AD-4', [1, 2]);
    run('UPDATE specialarea SET is_open = 20 WHERE specialarea_id = 1');
    ok(await inList(gMulti), '还有启用场次，商品仍在列表');
    const U5 = await mkUser('13911000095');
    const b5 = await buy(U5, gMulti);
    ok(b5.code === 1, '从启用那一场照常可买', b5.msg);
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
