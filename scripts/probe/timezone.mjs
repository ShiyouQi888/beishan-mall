/**
 * 时区回归：场次时间判断不能依赖服务器本地时区。
 *
 * 背景：start_time 存的是「北京时间 08:00 = 28800 秒」这类当地墙上时间，
 * 之前用 new Date().setHours(0,0,0,0) 取「今天零点」——服务器一旦跑在 UTC
 * （Docker 容器默认就是），拿到的是 UTC 零点，08:00 被解释成北京 16:00，
 * 于是上午场在开放中却显示「未开始 · 距开始 5 小时」。
 *
 * 这个探针用固定的时间点、在多个 TZ 下各跑一遍子进程，结果必须完全一致。
 *
 * 用法: node scripts/probe/timezone.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// 子进程模式：在指定 TZ 下跑断言并输出 JSON
if (process.env.TZ_CHILD === '1') {
  const { sessionWindow, todayStr, addDays } = await import(
    `file://${join(ROOT, 'server', 'src', 'lib', 'sessionWindow.js').replace(/\\/g, '/')}`
  );
  const DAY = { open_days: '1,2,3,4,5,6,7', start_time: 28800, end_time: 43200 }; // 08:00-12:00
  const at = (iso) => sessionWindow(DAY, new Date(iso));

  const out = {
    tz: process.env.TZ || '(local)',
    // 北京时间 10:23，上午场应开放
    morning: at('2026-10-31T02:23:00Z').state,
    // 北京时间 08:30
    justAfterStart: at('2026-10-31T00:30:00Z').state,
    // 北京时间 07:30，还没开始
    beforeStart: at('2026-10-30T23:30:00Z').state,
    // 北京时间 12:30，已结束
    afterEnd: at('2026-10-31T04:30:00Z').state,
    // 北京时间 11-01 00:30 == UTC 10-31 16:30（UTC 那边还在 10-31）
    crossDay: { today: todayStr(new Date('2026-10-31T16:30:00Z')), state: at('2026-10-31T16:30:00Z').state },
    // 北京时间 10-31 07:00（UTC 还是 10-30 23:00）
    crossDay2: todayStr(new Date('2026-10-30T23:00:00Z')),
    addDay: addDays('2026-10-31', 1),
    addMonthEnd: addDays('2026-10-31', 1),
    startText: at('2026-10-31T02:23:00Z').startText,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const ZONES = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Kiritimati', 'Europe/London'];

function runIn(tz) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: tz, TZ_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${tz} 子进程失败: ${err.slice(-300)}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`${tz} 输出无法解析: ${out.slice(0, 200)}`));
      }
    });
  });
}

let pass = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ' → ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`);
  }
}

const EXPECT = {
  morning: 'open',
  justAfterStart: 'open',
  beforeStart: 'upcoming',
  afterEnd: 'ended',
  addDay: '2026-11-01',
  startText: '08:00',
};

async function main() {
  console.log('各时区下的场次判定：');
  for (const tz of ZONES) {
    const r = await runIn(tz);
    console.log(`\n[${r.tz}]`);
    ok(r.morning === EXPECT.morning, '北京 10:23 上午场应开放', r.morning);
    ok(r.justAfterStart === EXPECT.justAfterStart, '北京 08:30 应开放', r.justAfterStart);
    ok(r.beforeStart === EXPECT.beforeStart, '北京 07:30 应未开始', r.beforeStart);
    ok(r.afterEnd === EXPECT.afterEnd, '北京 12:30 应已结束', r.afterEnd);
    ok(r.crossDay.today === '2026-11-01', '北京时间 11-01 00:30 的今天应是 11-01', r.crossDay.today);
    ok(r.crossDay.state === 'upcoming', '北京 11-01 00:30 上午场应未开始', r.crossDay.state);
    ok(r.crossDay2 === '2026-10-31', '北京时间 10-31 07:00 的今天应是 10-31', r.crossDay2);
    ok(r.addDay === EXPECT.addDay, '加一天跨月正确', r.addDay);
    ok(r.startText === EXPECT.startText, '开始时间文案不受时区影响', r.startText);
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass} 项断言（${ZONES.length} 个时区）`);
}

main().catch((e) => {
  console.error('[错误]', e.message);
  process.exit(1);
});
