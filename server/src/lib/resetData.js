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
import { db, all, get, run, now } from '../db.js';
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
  transpose: {
    label: '转拍订单',
    desc: '撤销所有在挂的转拍挂单：转拍订单列表清空，商品收回持有人手中并下架。订单与资金记录保留（要连订单一起清，请再勾「订单与资金」）',
  },
  recycle: {
    label: '系统回收',
    desc: '删除回收台账，并解除商品的「封顶」标记、重新上架。商品本身不删除，价格与详情不动',
  },
  score: {
    label: '积分兑换',
    desc: '删除兑换单，把积分退回会员、恢复积分商品库存与已兑数。积分流水里对应的兑换记录一并清掉',
  },
  member: { label: '会员与团队', desc: '除官方账号外全部会员，及其地址、收款卡、实名、站内消息' },
  goods: {
    label: '商品复位',
    desc: '商品不删除：持有人改回官方、价格回到基准价、名额复原、转拍与销量归零、清掉封顶标记并全部上架。商品详情、图片、分类、场次关联一律不动',
  },
  media: { label: '未引用的素材', desc: '只删没人用的图片，商品主图/图集/详情图、广告、配置正在用的都会保留' },
};

const countOf = (t) => Number(get(`SELECT COUNT(*) c FROM ${t}`)?.c || 0);
const countWhere = (t, w = '1 = 1') => Number(get(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`)?.c || 0);
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

  // 转拍订单页的口径：在挂（consignment_status=10）且货还在他手上。
  // 这里按订单侧统计，和页面「转拍订单」的条数保持同一量级
  detail.transpose = [
    { table: '在挂转拍订单', rows: countWhere('orders', 'IFNULL(consignment_status, 0) = 10') },
  ];
  detail.recycle = [
    { table: 'goods_recycle（台账）', rows: countOf('goods_recycle') },
    { table: 'goods（解除封顶）', rows: countWhere('goods', 'IFNULL(recycled, 0) <> 0') },
  ];
  detail.score = [
    { table: 'score_exchange（兑换单）', rows: countOf('score_exchange') },
  ];

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

  // 执行顺序固定：先订单资金 → 撤挂单 → 回收 → 积分兑换 → 再会员 → 商品复位 → 最后素材
  const order = ['trade', 'transpose', 'recycle', 'score', 'member', 'goods', 'media'].filter((s) => list.includes(s));
  const removed = {};
  let keptMemberId = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const scope of order) {
      let n = 0;
      if (scope === 'trade') {
        for (const t of TRADE_TABLES) n += Number(run(`DELETE FROM ${t}`).changes || 0);
      } else if (scope === 'transpose') {
        // 只撤挂单、不删订单：订单是持仓与收益的凭证（我的店铺靠它算买入价与服务费），
        // 删掉会让商品「凭空持有」且算不出收益。商品一并下架，回到持有人手里。
        const pending = all('SELECT order_id, goods_id FROM orders WHERE IFNULL(consignment_status, 0) = 10');
        for (const o of pending) {
          run('UPDATE orders SET consignment_status = 0 WHERE order_id = ?', o.order_id);
          run('UPDATE goods SET goods_status = 20, is_sell = 0, update_time = ? WHERE goods_id = ?', now(), o.goods_id);
          n += 1;
        }
      } else if (scope === 'recycle') {
        // 台账删掉，商品解除封顶并重新上架；持有人保持现状（回收时已转平台）
        const unCapped = Number(run(
          `UPDATE goods SET recycled = 0, goods_status = 10, is_sell = 10, update_time = ?
           WHERE IFNULL(recycled, 0) <> 0`,
          now(),
        ).changes || 0);
        n += Number(run('DELETE FROM goods_recycle').changes || 0) + unCapped;
      } else if (scope === 'score') {
        // 逐单回滚：退积分 + 还原库存与已兑数；已取消（status=40）的当时就退过，跳过
        const rows = all('SELECT exchange_id, member_id, item_id, num, total_score, status FROM score_exchange');
        for (const e of rows) {
          if (Number(e.status) === 40) continue;
          run('UPDATE member SET score = score + ? WHERE member_id = ?', Number(e.total_score) || 0, e.member_id);
          run('UPDATE score_item SET stock = stock + ?, sold = MAX(0, sold - ?) WHERE item_id = ?',
            Number(e.num) || 0, Number(e.num) || 0, e.item_id);
        }
        // 兑换流水属于这次兑换的镜像记录，兑换单清了就该一起清，否则积分余额与流水对不上
        n += Number(run("DELETE FROM finance_energy WHERE type = 3 AND type_name = '积分兑换'").changes || 0);
        // 兑换取消退还的流水也一并清（它对应的兑换单同样不在了）
        n += Number(run("DELETE FROM finance_energy WHERE type = 3 AND type_name = '兑换取消退还'").changes || 0);
        n += Number(run('DELETE FROM score_exchange').changes || 0);
      } else if (scope === 'member') {
        let official = officialOf();
        if (!official) {
          const info = run(
            `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
               is_valid, amount, score, e_card_number, is_certification, disabled,
               client_type, create_time, update_time)
             VALUES (?,?,?,0,'/',1,?,10,0,0,0,0,10,3,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
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
    for (const t of [...TRADE_TABLES, ...MEMBER_TABLES, 'score_exchange']) {
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
    transpose: countWhere('orders', 'IFNULL(consignment_status, 0) = 10'),
    recycle: countOf('goods_recycle'),
    score: countOf('score_exchange'),
  };
}
