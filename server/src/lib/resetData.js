// 数据清除：给「真人全量测试」用的在线清库（后台 → 系统设置 → 数据清除）
//
// 三条硬约束：
// 1. 动手前先备份（VACUUM INTO 出一份一致的快照，运行中也安全）
// 2. 全程一个事务，任何一步失败整体回滚
// 3. 永远不碰：后台账号 / 权限 / 系统配置 / 分类 / 场次 / 商品 / 广告 / 公告 / 运费模板 / 会员等级
//    这些是「跑起来的地基」，清掉之后页面会直接打不开
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, all, get, run } from '../db.js';
import { hashPwd } from './auth.js';
import { usagesOf } from './mediaRefs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MALL_DB && (process.env.MALL_DB.includes('/') || process.env.MALL_DB.includes('\\'))
  ? dirname(process.env.MALL_DB)
  : join(__dirname, '..', '..', 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', '..', 'data', 'uploads');

/** 必须由调用方原样回传的确认语，防止误点 */
export const CONFIRM_TEXT = '我已知晓风险并确认清除';

const OFFICIAL = {
  nick: '北山商城官方',
  mobile: '13800000001',
  code: 'boss01',
  password: '123456',
};

/** 交易与资金：连带结算三类账目 */
const TRADE_TABLES = [
  'order_log', 'order_report', 'orders',
  'finance_energy', 'finance_withdraw',
  'settle_pay', 'settle_match', 'settle_account', 'settle_batch',
];
/** 会员侧的附属数据 */
const MEMBER_TABLES = ['member_address', 'member_card', 'member_certification', 'member_msg'];

export const SCOPES = {
  trade: { label: '订单与资金', desc: '订单、订单日志、举报、资金流水、提现、结算批次/账目/匹配' },
  member: { label: '会员与团队', desc: '除官方账号外全部会员，及其地址、收款卡、实名、站内消息' },
  goods: { label: '商品复位', desc: '商品不删除，只把持有人改回官方、流转次数与销量归零、全部重新上架' },
  media: { label: '未引用的素材', desc: '只删没人用的图片，商品/广告/配置正在用的会保留' },
};

const countOf = (t) => Number(get(`SELECT COUNT(*) c FROM ${t}`)?.c || 0);
const officialOf = () =>
  get("SELECT * FROM member WHERE invitation_code = ? OR mobile = ? ORDER BY member_id LIMIT 1", OFFICIAL.code, OFFICIAL.mobile);

/** 预览：每个范围会影响多少行 */
export function planReset(scopes) {
  const pick = new Set(scopes?.length ? scopes : Object.keys(SCOPES));
  const detail = {};
  let total = 0;

  if (pick.has('trade')) {
    detail.trade = TRADE_TABLES.map((t) => ({ table: t, rows: countOf(t) }));
    total += detail.trade.reduce((s, x) => s + x.rows, 0);
  }
  if (pick.has('member')) {
    const members = countOf('member');
    const keep = officialOf() ? 1 : 0;
    const rows = Math.max(0, members - keep);
    detail.member = [
      { table: 'member（除官方）', rows },
      ...MEMBER_TABLES.map((t) => ({ table: t, rows: countOf(t) })),
    ];
    total += detail.member.reduce((s, x) => s + x.rows, 0);
  }
  if (pick.has('goods')) {
    detail.goods = [{ table: 'goods（复位，不删除）', rows: countOf('goods') }];
    total += detail.goods[0].rows;
  }
  if (pick.has('media')) {
    const rows = all('SELECT file_id, path FROM media_file').filter((f) => usagesOf(f.path).length === 0);
    detail.media = [{ table: '未引用素材', rows: rows.length }];
    total += rows.length;
  }
  return { total, detail };
}

/** 备份数据库到 data/backup/，返回文件名 */
function backupDb() {
  const dir = join(DATA_DIR, 'backup');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // 同一秒内连续点两次会撞名，VACUUM INTO 遇到已存在的文件会直接报错
  let dest = join(dir, `before-reset-${stamp}.db`);
  for (let i = 1; existsSync(dest); i += 1) {
    dest = join(dir, `before-reset-${stamp}-${i}.db`);
  }
  // VACUUM INTO 出来的是一致的快照，比直接复制 db 文件安全（有 WAL 时尤其明显）
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  return { file: basename(dest), dir };
}

/**
 * 执行清除
 * @param {string[]} scopes trade / member / goods / media
 * @returns {{ removed: Record<string, number>, total: number, backup: string, keptMemberId: number }}
 */
export function resetData(scopes) {
  const list = (scopes || []).filter((s) => SCOPES[s]);
  if (!list.length) throw Object.assign(new Error('请至少选择一个清除范围'), { biz: true });
  // 会员必须跟订单一起清，否则订单会变成指向不存在会员的孤儿
  if (list.includes('member') && !list.includes('trade')) {
    throw Object.assign(new Error('清除会员必须同时清除订单与资金流水，否则订单会变成孤儿数据'), { biz: true });
  }

  const backup = backupDb();

  // 执行顺序固定：先订单资金 → 再会员 → 商品复位 → 最后素材（此时引用关系已经刷新）
  const order = ['trade', 'member', 'goods', 'media'].filter((s) => list.includes(s));
  const removed = {};
  let keptMemberId = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const scope of order) {
      let n = 0;
      if (scope === 'trade') {
        for (const t of TRADE_TABLES) n += Number(run(`DELETE FROM ${t}`).changes || 0);
      } else if (scope === 'member') {
        let official = officialOf();
        if (!official) {
          const info = run(
            `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
               identity_vip, is_valid, amount, score, e_card_number, is_certification, disabled,
               client_type, create_time, update_time)
             VALUES (?,?,?,0,'/',1,?,0,10,0,0,0,0,10,3,datetime('now','localtime'),datetime('now','localtime'))`,
            OFFICIAL.nick, OFFICIAL.mobile, hashPwd(OFFICIAL.password), OFFICIAL.code,
          );
          official = get('SELECT * FROM member WHERE member_id = ?', Number(info.lastInsertRowid));
          n += 1;
        }
        keptMemberId = official.member_id;
        for (const t of MEMBER_TABLES) n += Number(run(`DELETE FROM ${t}`).changes || 0);
        n += Number(run('DELETE FROM member WHERE member_id <> ?', keptMemberId).changes || 0);
        run(
          `UPDATE member SET nick_name = ?, mobile = ?, invitation_code = ?,
             p_id = 0, path = '/', level = 1, child_id = '', amount = 0, e_card_number = 0,
             score = 0, is_certification = 0, is_advance = 0, advance_count = 0,
             identity_vip = 0, is_valid = 10, disabled = 10, pay_password = '', pay_setting = ''
           WHERE member_id = ?`,
          OFFICIAL.nick, OFFICIAL.mobile, OFFICIAL.code, keptMemberId,
        );
      } else if (scope === 'goods') {
        let holder = keptMemberId || officialOf()?.member_id || 0;
        if (!holder) {
          const first = get('SELECT member_id FROM member ORDER BY member_id LIMIT 1');
          holder = first?.member_id || 0;
        }
        n = Number(run(
          `UPDATE goods SET member_id = ?, goods_status = 10, stock_num = 1,
             is_split = 0, split_total = 0, turn_beat_num = 0, sales_actual = 0, is_sell = 10
           WHERE 1 = 1`,
          holder,
        ).changes || 0);
      } else if (scope === 'media') {
        const rows = all('SELECT * FROM media_file');
        for (const f of rows) {
          if (usagesOf(f.path).length) continue; // 还在用的留着
          if (f.private) continue;               // 会员私有文件不在这里删
          const abs = join(UPLOAD_DIR, basename(f.path));
          if (existsSync(abs)) {
            try { unlinkSync(abs); } catch { continue; }
          }
          run('DELETE FROM media_file WHERE file_id = ?', f.file_id);
          n += 1;
        }
      }
      removed[scope] = n;
    }

    // 自增序列归零，让测试从 member_id=2 / order_id=1 重新开始
    for (const t of [...TRADE_TABLES, ...MEMBER_TABLES]) {
      run('UPDATE sqlite_sequence SET seq = 0 WHERE name = ?', t);
    }
    if (keptMemberId) run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', keptMemberId, 'member');

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  return {
    removed,
    total: Object.values(removed).reduce((s, x) => s + x, 0),
    backup: backup.file,
    keptMemberId,
    official: { mobile: OFFICIAL.mobile, code: OFFICIAL.code },
  };
}

/** 当前数据概况（页面顶部展示） */
export function summary() {
  return {
    member: countOf('member'),
    orders: countOf('orders'),
    energy: countOf('finance_energy'),
    withdraw: countOf('finance_withdraw'),
    goods: countOf('goods'),
    media: countOf('media_file'),
  };
}
