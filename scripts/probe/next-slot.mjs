/**
 * 「转拍落下一场」的时间感知验收。
 *
 * 背景：下一次场次原来只按「场次顺序取下一项」，不看此刻几点。
 * 下午 5 点从上午场转拍，顺序上的下一项是下午场（13-17 已经结束），
 * 货就落进一个今天再也开不了的场次 —— 而 area_date 记的是今天，明天也不会自动跳出来。
 *
 * 这个用例把「跳到第一个还没结束的场次」钉死。独立库（next-slot.db），跑完销毁。
 * 用法: node scripts/probe/next-slot.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const DB = 'next-slot.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB };

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

function runSeed() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

/** 构造某个北京时间点的 Date */
const bj = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00+08:00`);

async function main() {
  await runSeed();
  const { db, get, all } = await import('../../server/src/db.js');

  const dbFile = String(db.prepare('PRAGMA database_list').get()?.file || '');
  if (!dbFile.includes(DB)) throw new Error(`安全阀拦住：实际连的是 ${dbFile}，不是 ${DB}`);

  const { nextSlot } = await import('../../server/src/lib/sessions.js');
  const { todayStr } = await import('../../server/src/lib/sessionWindow.js');
  const today = todayStr();

  const areas = all('SELECT specialarea_id, title_main, start_time, end_time FROM specialarea ORDER BY start_time');
  ok(areas.length === 3, '种子数据三个场次', `${areas.length}`);
  const [morning, afternoon, evening] = areas;
  eq(morning.start_time / 3600, 8, '上午场 08:00 开始');
  eq(afternoon.start_time / 3600, 13, '下午场 13:00 开始');
  eq(evening.start_time / 3600, 18, '晚间场 18:00 开始');
  eq(evening.end_time / 3600, 22, '晚间场 22:00 结束');

  section('[1] 白天各时刻：取第一个还没结束的场次');
  // 12:30 从上午场转拍 → 下午场（13:00 才会开，此刻是 upcoming，可以排进去）
  eq(nextSlot(morning.specialarea_id, today, bj(today, '12:30'))?.area_id, afternoon.specialarea_id,
    '12:30 从上午场 → 下午场（今天）');
  eq(nextSlot(morning.specialarea_id, today, bj(today, '12:30'))?.date, today, '日期是今天');

  // 13:30 从上午场转拍 → 下午场（正在开）
  eq(nextSlot(morning.specialarea_id, today, bj(today, '13:30'))?.area_id, afternoon.specialarea_id,
    '13:30 从上午场 → 下午场（今天）');

  // ★ 核心：17:30 下午场已结束，从上午场转拍应该跳到晚间场，而不是落进已结束的下午场
  eq(nextSlot(morning.specialarea_id, today, bj(today, '17:30'))?.area_id, evening.specialarea_id,
    '17:30 从上午场 → 晚间场（跳过已结束的下午场）');
  eq(nextSlot(morning.specialarea_id, today, bj(today, '17:30'))?.date, today, '仍然是今天的晚间场');

  // 19:00 从下午场转拍 → 晚间场（正在开）
  eq(nextSlot(afternoon.specialarea_id, today, bj(today, '19:00'))?.area_id, evening.specialarea_id,
    '19:00 从下午场 → 晚间场（今天）');

  section('[2] 当天全部结束：顺延到次日第一场');
  eq(nextSlot(evening.specialarea_id, today, bj(today, '22:30'))?.area_id, morning.specialarea_id,
    '22:30 从晚间场 → 次日第一场');
  const tom = nextSlot(evening.specialarea_id, today, bj(today, '22:30'))?.date;
  ok(tom > today, `日期顺延到 ${tom}`);

  eq(nextSlot(morning.specialarea_id, today, bj(today, '22:30'))?.area_id, morning.specialarea_id,
    '22:30 从上午场 → 次日第一场（今天已无场次可排）');
  ok(nextSlot(morning.specialarea_id, today, bj(today, '22:30'))?.date > today, '日期是明天');

  section('[3] 商品已经排到未来某天：按顺序即可，不受当前时间影响');
  // area_date 是明天 → 从上午场转拍，下一项就是明天下午场
  const tomorrow = nextSlot(morning.specialarea_id, tom, bj(today, '22:30'));
  eq(tomorrow?.area_id, afternoon.specialarea_id, '明天上午场之后 → 明天下午场');
  eq(tomorrow?.date, tom, '日期保持明天，不会因为现在已过 22 点又往后跳');

  section('[4] 场次时间被拉长到整天时，按实际时段判断');
  db.prepare('UPDATE specialarea SET end_time = 86399 WHERE specialarea_id = ?').run(afternoon.specialarea_id);
  eq(nextSlot(morning.specialarea_id, today, bj(today, '17:30'))?.area_id, afternoon.specialarea_id,
    '下午场改成 23:59 结束后，17:30 转拍仍落下午场（它确实还开着）');
  db.prepare('UPDATE specialarea SET end_time = ? WHERE specialarea_id = ?').run(afternoon.end_time, afternoon.specialarea_id);

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
