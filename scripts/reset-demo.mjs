// 重置演示数据：备份现有库 → 重建基线 → 清空 C 端数据（会员/订单/资金/结算等）
// 保留：后台账号、权限、全部配置、分类、场次、商品、广告、公告
// 只保留 1 个「官方」会员作为邀请码来源 + 商品初始持有人
//
// 用法：先停掉后端进程，然后 node scripts/reset-demo.mjs [--yes]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

// 与 server/src/lib/auth.js 的 hashPwd 保持一致
const hashPwd = (plain) => crypto.createHash('sha256').update(String(plain) + '::mall').digest('hex');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'server', 'data');
const DB_NAME = process.env.MALL_DB || 'mall.db';
const DB_FILE = DB_NAME.includes('/') || DB_NAME.includes('\\') ? DB_NAME : join(DATA, DB_NAME);

const OFFICIAL = {
  mobile: '13800000001',
  nick: '北山商城官方',
  code: 'boss01',
  password: '123456',
};

if (!process.argv.includes('--yes')) {
  console.log(`即将重置：${DB_FILE}`);
  console.log('会清空：会员、订单、订单日志、资金流水、提现、地址、收款卡、实名、举报、结算批次/账目/匹配、站内消息');
  console.log(`会保留：后台账号、权限节点、全部配置、分类、场次、商品、广告、公告、充值套餐、运费模板、会员等级`);
  console.log('并只保留 1 个官方会员（邀请码来源 + 商品初始持有人）');
  console.log('\n确认执行请加 --yes：node scripts/reset-demo.mjs --yes');
  process.exit(0);
}

if (!existsSync(DB_FILE)) {
  console.log(`数据库不存在：${DB_FILE}，直接初始化`);
}

// ---------- 1. 备份 ----------
if (existsSync(DB_FILE)) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = join(DATA, 'backup');
  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `mall-${stamp}.db`);
  // 连同 WAL/SHM 一起复制，保证快照一致
  copyFileSync(DB_FILE, dest);
  for (const ext of ['-wal', '-shm']) if (existsSync(DB_FILE + ext)) copyFileSync(DB_FILE + ext, dest + ext);
  console.log(`✓ 已备份到 ${dest}`);
}

// ---------- 2. 删除旧库并重建 ----------
for (const ext of ['', '-wal', '-shm']) if (existsSync(DB_FILE + ext)) rmSync(DB_FILE + ext);
const env = { ...process.env, MALL_DB: DB_FILE };
const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: join(ROOT, 'server'), env, stdio: 'inherit' });
if (seed.status !== 0) {
  console.error('✗ seed 失败');
  process.exit(seed.status || 1);
}

// ---------- 3. 清空 C 端数据 ----------
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA busy_timeout = 5000');

const wipe = [
  'order_log', 'order_report', 'orders',
  'finance_energy', 'finance_withdraw',
  'member_address', 'member_card', 'member_certification', 'member_msg',
  'settle_match', 'settle_account', 'settle_batch', 'settle_pay',
];

let removed = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const t of wipe) {
    const before = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    db.exec(`DELETE FROM ${t}`);
    if (before) console.log(`  清空 ${t}：${before} 行`);
    removed += before;
  }

  // 只保留一个官方会员：优先沿用已有 member_id 最小的那个
  const keep = db.prepare('SELECT member_id FROM member ORDER BY member_id LIMIT 1').get();
  if (!keep) throw new Error('会员表为空，无法保留官方账号');
  const keepId = keep.member_id;

  // 其余会员全部删除
  const delMembers = db.prepare('DELETE FROM member WHERE member_id <> ?').run(keepId).changes;
  if (delMembers) console.log(`  删除其它会员：${delMembers} 个`);

  db.prepare(
    `UPDATE member SET nick_name = ?, mobile = ?, password = ?, invitation_code = ?,
       p_id = 0, path = '/', level = 1, child_id = '', amount = 0, e_card_number = 0,
       score = 0, is_certification = 0, is_advance = 0, advance_count = 0,
       identity_vip = 0, is_valid = 10, disabled = 10, pay_password = '', pay_setting = ''
     WHERE member_id = ?`,
  ).run(OFFICIAL.nick, OFFICIAL.mobile, hashPwd(OFFICIAL.password), OFFICIAL.code, keepId);

  // 商品复位：全部归官方持有、上架、未拆分、流转归零
  const goodsReset = db.prepare(
    `UPDATE goods SET member_id = ?, goods_status = 10, stock_num = 1,
       is_split = 0, split_total = 0, turn_beat_num = 0, sales_actual = 0, is_sell = 10
     WHERE 1 = 1`,
  ).run(keepId).changes;

  // 自增序列归零，避免新用户 id 从旧序列继续（如 5、6…）
  for (const t of wipe) db.prepare('UPDATE sqlite_sequence SET seq = 0 WHERE name = ?').run(t);
  db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(keepId, 'member');

  db.exec('COMMIT');
  console.log(`✓ 已保留官方会员 #${keepId}（${OFFICIAL.nick} / ${OFFICIAL.mobile} / 邀请码 ${OFFICIAL.code}）`);
  console.log(`✓ 商品已复位：${goodsReset} 件全部上架，持有人=官方`);
  console.log(`共清除 C 端数据 ${removed} 行`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('✗ 清理失败，已回滚：', e.message);
  process.exit(1);
} finally {
  db.close();
}

// ---------- 4. 摘要 ----------
const chk = new DatabaseSync(DB_FILE);
const count = (t) => chk.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
console.log('\n重置后：');
for (const t of ['member', 'orders', 'finance_energy', 'finance_withdraw', 'goods', 'goods_category', 'specialarea', 'setting_config', 'store_user', 'member_grade']) {
  console.log(`  ${t.padEnd(18)} ${count(t)}`);
}
const g = chk.prepare('SELECT goods_status, COUNT(*) c FROM goods GROUP BY goods_status').all();
console.log('  商品状态分布：', g.map((x) => `${x.goods_status}:${x.c}`).join(' '));
chk.close();

console.log('\n下一步：npm start，然后');
console.log(`  H5 注册邀请码：${OFFICIAL.code}`);
console.log(`  官方账号：${OFFICIAL.mobile} / ${OFFICIAL.password}`);
console.log(`  后台：admin1 / 123456`);
