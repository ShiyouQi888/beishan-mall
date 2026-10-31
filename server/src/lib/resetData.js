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
import { normPath, referencedPathSet } from './mediaRefs.js';

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
  'order_log', 'orders', 'goods_recycle',
  'finance_energy', 'finance_withdraw',
  'settle_pay',
];
/** 会员侧的附属数据 */
const MEMBER_TABLES = ['member_address', 'member_card', 'member_certification', 'member_msg'];

export const SCOPES = {
  trade: { label: '订单与资金', desc: '订单、订单日志、资金流水、提现、结算账目、系统回收台账' },
  member: { label: '会员与团队', desc: '除官方账号外全部会员，及其地址、收款卡、实名、站内消息' },
  goods: {
    label: '商品复位',
    desc: '商品不删除：持有人改回官方、价格回到基准价、名额复原、转拍与销量归零、清掉封顶标记并全部上架。商品详情、图片、分类、场次关联一律不动',
  },
  media: { label: '未引用的素材', desc: '只删没人用的图片，商品主图/图集/详情图、广告、配置正在用的都会保留' },
};

const countOf = (t) => Number(get(`SELECT COUNT(*) c FROM ${t}`)?.c || 0);
const officialOf = () =>
  get("SELECT * FROM member WHERE invitation_code = ? OR mobile = ? ORDER BY member_id LIMIT 1", OFFICIAL.code, OFFICIAL.mobile);

/**
 * 预览：每个范围会影响多少行
 *
 * 注意：detail / totals 永远按「全部范围」统计，只有 total 跟随选中项。
 * 原来按选中项过滤，结果勾一个、其余三个数字变 0，看着像数据没了或者点不动。
 */
export function planReset(scopes) {
  const detail = {};

  detail.trade = TRADE_TABLES.map((t) => ({ table: t, rows: countOf(t) }));

  const members = countOf('member');
  const keep = officialOf() ? 1 : 0;
  detail.member = [
    { table: 'member（除官方）', rows: Math.max(0, members - keep) },
    ...MEMBER_TABLES.map((t) => ({ table: t, rows: countOf(t) })),
  ];

  detail.goods = [{ table: 'goods（复位，不删除）', rows: countOf('goods') }];

  // 一次扫全库引用，别再逐文件查十张表 —— 素材一多这里会把页面拖住
  const refs = referencedPathSet();
  detail.media = [
    {
      table: '未引用素材',
      rows: all('SELECT file_id, path, private FROM media_file').filter(
        (f) => !Number(f.private) && !refs.has(normPath(f.path)),
      ).length,
    },
  ];

  const sumOf = (k) => (detail[k] || []).reduce((s, x) => s + Number(x.rows || 0), 0);
  const totals = Object.fromEntries(Object.keys(SCOPES).map((k) => [k, sumOf(k)]));
  const picked = scopes?.length ? scopes.filter((s) => SCOPES[s]) : Object.keys(SCOPES);
  const total = picked.reduce((s, k) => s + (totals[k] || 0), 0);
  return { total, totals, detail };
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
               is_valid, amount, score, e_card_number, is_certification, disabled,
               client_type, create_time, update_time)
             VALUES (?,?,?,0,'/',1,?,10,0,0,0,0,10,3,datetime('now','localtime'),datetime('now','localtime'))`,
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
             is_valid = 10, disabled = 10, pay_password = '', pay_setting = ''
           WHERE member_id = ?`,
          OFFICIAL.nick, OFFICIAL.mobile, OFFICIAL.code, keptMemberId,
        );
        // 会员被删了，商品上的「现持有人」就成了悬空 id：前台会显示空持有人、转拍也会出错。
        // 这里只把悬空的改回官方，正常的商品数据一行都不动（不改价格、不改状态、不动详情）。
        // 不计入 n：这不是删除，是引用清理。
        run(
          `UPDATE goods SET member_id = ?
           WHERE IFNULL(member_id, 0) > 0 AND member_id NOT IN (SELECT member_id FROM member)`,
          keptMemberId,
        );
      } else if (scope === 'goods') {
        let holder = keptMemberId || officialOf()?.member_id || 0;
        if (!holder) {
          const first = get('SELECT member_id FROM member ORDER BY member_id LIMIT 1');
          holder = first?.member_id || 0;
        }
        // 复位 = 回到刚建好的状态，但**只动流转相关的列**。
        // 明确不碰：detail / detail_images / images / good_thumb / line_price / price_cap /
        //           category_id / specialarea_goods 关联 —— 运营辛苦填的详情和图片不能被清库带走。
        // 价格回到基准价（首次上架价），否则转拍涨上去的价会留在原位，水位一上来就是红的。
        n = Number(run(
          `UPDATE goods SET
             member_id = ?,
             goods_status = 10,
             is_sell = 10,
             stock_num = MAX(IFNULL(stock_total, 1), 1),
             turn_beat_num = 0,
             sales_actual = 0,
             recycled = 0,
             area_date = '',
             goods_min_price = CASE WHEN IFNULL(base_price, 0) > 0 THEN base_price ELSE goods_min_price END
           WHERE 1 = 1`,
          holder,
        ).changes || 0);
      } else if (scope === 'media') {
        // 引用关系要重新算：前面 trade 已把订单删了，之前「被订单引用」的素材现在确实没人用了
        const refs = referencedPathSet();
        for (const f of all('SELECT * FROM media_file')) {
          if (refs.has(normPath(f.path))) continue; // 还在用的留着
          if (f.private) continue;                  // 会员私有文件不在这里删
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
