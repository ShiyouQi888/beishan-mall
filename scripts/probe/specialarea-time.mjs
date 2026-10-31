/**
 * 场次时段校验：结束时间必须晚于开始时间。
 *
 * 背景：配置页有前端校验，但「商品/场次管理」列表页的编辑弹窗（timesec 只是把 HH:mm 转秒赋值）
 * 和直接调接口都能存出 end < start。这种场次 sessionWindow 的 timeOk 恒为 false，
 * 整场静默失效 —— 运营只会觉得「这场怎么点不进去」。
 *
 * 覆盖：
 *   1. 新建：end < start / end = start 被拒
 *   2. 新建：end = 0（不限）合法
 *   3. 编辑：只传 end_time 造成非法 → 被拒（用库里值合并判断）
 *   4. 编辑：只传 start_time 造成非法 → 被拒
 *   5. 编辑：合法修改放行
 *   6. 超出 00:00-23:59 范围被拒
 *   7. 场次列表的「商品数」与配置页明细同口径（孤儿关联不算数，且启动时会被清掉）
 *
 * 独立库（specialarea-time.db / 3461），跑完销毁。
 * 用法: node scripts/probe/specialarea-time.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3461;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'specialarea-time.db';

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

const H = (h) => h * 3600;

async function main() {
  await runSeed();
  const { db, get } = await import('../../server/src/db.js');
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

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');
    const save = (body) => api('/admin/api/specialarea/save', { method: 'POST', token: at, body });

    section('[1] 新建时的非法时段');
    const bad1 = await save({ title_main: '坏时段', start_time: H(20), end_time: H(8) });
    ok(bad1.code === 0, 'end < start 被拒', bad1.msg);
    ok(/结束时间必须晚于开始时间/.test(bad1.msg || ''), '提示写明原因', bad1.msg);

    const bad2 = await save({ title_main: '相等时段', start_time: H(10), end_time: H(10) });
    ok(bad2.code === 0, 'end = start 被拒', bad2.msg);

    const bad3 = await save({ title_main: '超范围', start_time: 90000, end_time: 0 });
    ok(bad3.code === 0 && /超出范围/.test(bad3.msg || ''), '超过 23:59 被拒', bad3.msg);

    const noEnd = await save({ title_main: '不限结束', start_time: H(8), end_time: 0 });
    ok(noEnd.code === 1, 'end = 0（不限）允许', noEnd.msg);
    const freeId = Number(get("SELECT specialarea_id FROM specialarea WHERE title_main = '不限结束' LIMIT 1")?.specialarea_id);
    ok(!!freeId, '不限结束的场次已创建');

    section('[2] 编辑时只传一个字段也要校验（合并库里的值）');
    const good = await save({ title_main: '正常场次', start_time: H(8), end_time: H(12) });
    ok(good.code === 1, '先建一个 08:00-12:00 的正常场次', good.msg);
    const id = Number(get("SELECT specialarea_id FROM specialarea WHERE title_main = '正常场次' LIMIT 1")?.specialarea_id);
    ok(!!id, '拿到场次 ID');

    const editEnd = await save({ specialarea_id: id, end_time: H(7) });
    ok(editEnd.code === 0, '只把结束改成 07:00（早于开始）被拒', editEnd.msg);
    const afterEditEnd = get('SELECT start_time, end_time FROM specialarea WHERE specialarea_id = ?', id);
    ok(Number(afterEditEnd.end_time) === H(12), '被拒后库里仍是 12:00', String(afterEditEnd.end_time));

    const editStart = await save({ specialarea_id: id, start_time: H(13) });
    ok(editStart.code === 0, '只把开始改成 13:00（晚于结束）被拒', editStart.msg);

    const okEdit = await save({ specialarea_id: id, end_time: H(20) });
    ok(okEdit.code === 1, '把结束改成 20:00（合法）放行', okEdit.msg);
    const after = get('SELECT start_time, end_time FROM specialarea WHERE specialarea_id = ?', id);
    ok(Number(after.start_time) === H(8) && Number(after.end_time) === H(20), '库里已是 08:00-20:00',
      `${after.start_time}-${after.end_time}`);

    section('[3] 商品数：列表统计与配置页明细同口径');
    const run = (sql, ...p) => db.prepare(sql).run(...p);
    const gid = Number(run(
      `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
         member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
         goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
       VALUES ('商品数验收','SC-1','/uploads/demo-1.svg','[]','',1,1,'',0,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
    ).lastInsertRowid);
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', gid);
    // 造一条孤儿关联（指向不存在的商品），模拟「商品被删但关联没清」
    run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, 999999, 100)');

    const listApi = await api('/admin/api/specialarea/list?page=1&limit=100', { token: at });
    const rowArea = (listApi.data?.data || []).find((x) => Number(x.specialarea_id) === 1);
    const detailApi = await api('/admin/api/specialarea/1/goods', { token: at });
    eq(rowArea?.area_goods_count, detailApi.data?.total, '列表的「商品数」= 配置页明细条数（孤儿不算）');
    ok(!(detailApi.data?.list || []).some((x) => Number(x.goods_id) === 999999), '明细里不出现孤儿商品');

    const { cleanOrphanLinks } = await import('../../server/src/lib/areaGoods.js');
    ok(cleanOrphanLinks() >= 1, '清理函数能删掉孤儿关联');
    eq(cleanOrphanLinks(), 0, '再跑一次是幂等的');
    const afterClean = await api('/admin/api/specialarea/1/goods', { token: at });
    ok(!(afterClean.data?.list || []).some((x) => Number(x.goods_id) === 999999), '清理后明细里没有孤儿');

    // 收尾：删掉验收商品
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', gid);
    run('DELETE FROM goods WHERE goods_id = ?', gid);

    section('[4] 现有场次仍然合法（没被误伤）');
    const areas = db.prepare('SELECT specialarea_id, start_time, end_time FROM specialarea').all();
    ok(areas.every((a) => Number(a.end_time) === 0 || Number(a.end_time) > Number(a.start_time)),
      '库里所有场次都满足 end = 0 或 end > start',
      JSON.stringify(areas.map((a) => `${a.specialarea_id}:${a.start_time}-${a.end_time}`)));
  } finally {
    try { srv.kill(); } catch {}
    console.log('\n（独立库，已随进程销毁）');
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
