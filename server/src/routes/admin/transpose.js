// 转拍订单：正在挂牌等下一手买走的单子（后台 → 订单管理 → 转拍订单）
//
// 「正在转拍」的判定（四个条件缺一不可）：
//   1. orders.consignment_status = 10 —— 这单已经点了转拍、成功挂出
//   2. orders.type = 1               —— 只有抢购单能转拍，商城单不参与
//   3. goods.member_id = orders.member_id —— 货还在他手上。
//      被别人买走后 goods.member_id 会变成下一个人，这单就自动退出「正在转拍」；
//      被系统回收则归 0，同样退出。
//   4. goods.goods_status = 10       —— 还挂在架上。场次到期没人买会被 expire 自动下架，
//      同时把 consignment_status 归零，两个条件互为兜底。
//
// 为什么不改写历史单的 consignment_status：那份记录是「这一手曾经挂牌过」的事实，
// 用 goods.member_id 判断「此刻还在不在售」更准确，也不会动到既有数据。
import { Router } from 'express';
import { all, get, run, tx, now } from '../../db.js';
import { ok, fail, authAdmin, money } from '../../lib/helper.js';
import { reverseOrderEnergy, negativeMembersOf } from '../../lib/energyReversal.js';
import { resolveRange } from '../../lib/dateRange.js';
import { priceCapOf } from '../../lib/priceCap.js';
import { nextSlot, todaySlot, activeSessions } from '../../lib/sessions.js';
import { toCsv, sendCsv, csvTime } from '../../lib/csv.js';
import { todayStr } from '../../lib/sessionWindow.js';
import { orderGoods, orderGoodsId } from '../../lib/orderAssets.js';
import { setGoodsAreas } from '../../lib/areaGoods.js';

const r = Router();

function buildWhere(range, start, end, keyword) {
  const where = [
    'o.type = 1',
    'IFNULL(o.consignment_status, 0) = 10',
    'g.member_id = o.member_id',
    'g.goods_status = 10',
    'IFNULL(g.recycled, 0) = 0',
  ];
  const args = [];
  if (range) {
    where.push('o.transposition_time >= ?', 'o.transposition_time <= ?');
    args.push(`${range.start} 00:00:00`, `${range.end} 23:59:59`);
  }
  const kw = String(keyword || '').trim();
  if (kw) {
    where.push('(o.order_no LIKE ? OR g.goods_name LIKE ? OR IFNULL(m.nick_name, \'\') LIKE ? OR IFNULL(m.mobile, \'\') LIKE ?)');
    for (let i = 0; i < 4; i += 1) args.push(`%${kw}%`);
  }
  return { sql: `WHERE ${where.join(' AND ')}`, args };
}

const FROM = `FROM orders o
  JOIN goods g ON g.goods_id = COALESCE(NULLIF(o.asset_goods_id, 0), o.goods_id)
  LEFT JOIN member m ON m.member_id = o.member_id
  LEFT JOIN member s ON s.member_id = o.seller_id`;

/** 列表与导出共用同一段查询，避免两处字段走偏 */
const ROW_SELECT = `SELECT o.order_id, o.order_no,
            COALESCE(NULLIF(o.asset_goods_id, 0), o.goods_id) AS goods_id, o.goods_id AS source_goods_id,
            o.member_id, o.total_price, o.listing_fee,
            o.transposition_time, o.specialarea_id, o.pay_time, o.create_time, o.remark,
            o.service_charge, o.pay_status,
            g.goods_name, g.goods_no, g.good_thumb, g.goods_min_price, g.base_price, g.price_cap,
            g.turn_beat_num, g.area_date, g.stock_total, g.stock_num,
            g.specialarea_id AS goods_area_id, g.member_id AS holder_id,
            o.seller_id, s.nick_name AS seller_name, s.mobile AS seller_mobile,
            m.nick_name, m.mobile
     ${FROM}`;
const ORDER_BY = 'ORDER BY o.transposition_time DESC, o.order_id DESC';

/** 秒 → HH:mm（场次起止时间存的都是秒） */
const hhmm = (sec) => {
  const n = Number(sec) || 0;
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
};

/**
 * 下一场（场次 + 日期 + 时段）：
 * 这件货当前挂在哪个场次之后就该轮到哪一场，走到当天最后一场则顺延到次日第一场。
 * 运营盯盘时最关心的就是「今晚没卖掉，下一次什么时候有机会」。
 */
function nextSlotOf(areaId, areaDate) {
  const next = nextSlot(areaId, areaDate || '');
  if (!next) return null;
  const a = get('SELECT title_main, name, start_time, end_time FROM specialarea WHERE specialarea_id = ?', next.area_id);
  if (!a) return null;
  const name = a.title_main || a.name || '';
  const start = hhmm(a.start_time);
  const end = hhmm(a.end_time);
  return {
    area_id: next.area_id,
    area_name: name,
    date: next.date,
    start,
    end,
    text: `${name} ${next.date} ${start}-${end}`,
    short: `${next.date.slice(5)} ${start}`,
  };
}

/** 一行转拍订单 → 接口/导出共用的结构 */
function fmtRow(row) {
  // 场次以「商品此刻挂在哪个场次」为准：转拍上架时会把它挪到下一场，
  // 订单上的 specialarea_id 记的是买家当初在哪一场买到的，拿它显示会误导运营。
  const areaId = Number(row.goods_area_id) || Number(row.specialarea_id) || 0;
  const area = areaId
    ? get('SELECT title_main, name, start_time, end_time FROM specialarea WHERE specialarea_id = ?', areaId)
    : null;
  // 水位按「基准价 → 上限」算，和商品页同源，避免两处口径不一致
  const cap = priceCapOf({
    goods_min_price: row.goods_min_price,
    base_price: row.base_price,
    price_cap: row.price_cap,
  });
  const next = nextSlotOf(areaId, row.area_date);
  return {
    order_id: row.order_id,
    order_no: row.order_no,
    goods_id: row.goods_id,
    goods_no: row.goods_no || '',
    goods_name: row.goods_name,
    good_thumb: row.good_thumb || '',
    // 买卖链路：这一手是从谁手里买来的（卖家）→ 现在归谁（买家，也就是挂牌转拍的人）
    seller_id: Number(row.seller_id) || 0,
    // 卖家账号可能已被删除（会员列表里删号），别显示成空白，标出原始 id 更好查
    seller_name: row.seller_name || (Number(row.seller_id) ? `会员#${row.seller_id}` : '平台'),
    seller_mobile: row.seller_mobile || '',
    buyer_id: row.member_id,
    buyer_name: row.nick_name || '',
    buyer_mobile: row.mobile || '',
    // 兼容旧字段
    member_id: row.member_id,
    nick_name: row.nick_name || '',
    mobile: row.mobile || '',
    holder_id: Number(row.holder_id) || 0,
    buy_price: Number(row.total_price || 0),
    service_charge: Number(row.service_charge || 0),
    pay_status: Number(row.pay_status) === 10 ? '已确认' : '待确认',
    sell_price: Number(row.goods_min_price || 0),
    gain: Number((Number(row.goods_min_price || 0) - Number(row.total_price || 0)).toFixed(2)),
    listing_fee: Number(row.listing_fee || 0),
    transposition_time: row.transposition_time || '',
    pay_time: row.pay_time || '',
    create_time: row.create_time || '',
    remark: row.remark || '',
    online_minutes: minutesSince(row.transposition_time),
    turn_beat_num: Number(row.turn_beat_num || 0),
    area_id: areaId,
    area_name: area?.title_main || area?.name || '',
    area_start: area ? hhmm(area.start_time) : '',
    area_end: area ? hhmm(area.end_time) : '',
    area_date: row.area_date || '',
    next_slot: next,
    stock_total: Number(row.stock_total || 1),
    stock_num: Number(row.stock_num || 0),
    cap_price: cap.cap_price,
    cap_reached: cap.reached ? 1 : 0,
    cap_ratio: Math.round(Number(cap.ratio || 0) * 100),
  };
}

/** 已经挂牌多久（分钟） */
function minutesSince(text) {
  if (!text) return null;
  const t = new Date(String(text).replace(/-/g, '/')).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

r.get('/transpose/list', authAdmin, (req, res) => {
  const range = resolveRange(req.query.range, req.query.start, req.query.end);
  if (!range) return res.json(fail('自定义日期格式不正确，应为 YYYY-MM-DD'));

  const p = Math.max(1, Number(req.query.page) || 1);
  const pp = Math.min(100, Number(req.query.limit) || 15);
  const { sql, args } = buildWhere(range.start ? range : null, range.start, range.end, req.query.keyword);

  const total = Number(get(`SELECT COUNT(*) c ${FROM} ${sql}`, ...args)?.c || 0);

  // 汇总跟筛选走，但不受分页影响
  const sum = get(
    `SELECT COUNT(*) c,
            COUNT(DISTINCT COALESCE(NULLIF(o.asset_goods_id, 0), o.goods_id)) goods_count,
            IFNULL(SUM(o.listing_fee), 0) fee,
            IFNULL(SUM(g.goods_min_price), 0) price,
            IFNULL(SUM(g.goods_min_price - o.total_price), 0) gain
     ${FROM} ${sql}`,
    ...args,
  ) || {};

  const rows = all(`${ROW_SELECT} ${sql} ${ORDER_BY} LIMIT ? OFFSET ?`, ...args, pp, (p - 1) * pp);

  const list = rows.map(fmtRow);

  res.json(ok({
    list,
    total,
    page: p,
    per_page: pp,
    range: { kind: req.query.range || 'today', start: range.start, end: range.end },
    summary: {
      count: Number(sum.c || 0),
      goods_count: Number(sum.goods_count || 0),
      fee: Number(Number(sum.fee || 0).toFixed(2)),
      price: Number(Number(sum.price || 0).toFixed(2)),
      gain: Number(Number(sum.gain || 0).toFixed(2)),
    },
  }));
});

/**
 * 导出转拍订单：跟列表同一套筛选条件，但字段给全
 * （页面只看关键的十列，导出要能直接拿去对账，所以把买卖双方手机号、成本、封顶、下一场都带上）
 */
r.get('/transpose/export', authAdmin, (req, res) => {
  const range = resolveRange(req.query.range, req.query.start, req.query.end);
  if (!range) return res.json(fail('自定义日期格式不正确，应为 YYYY-MM-DD'));
  const { sql, args } = buildWhere(range.start ? range : null, range.start, range.end, req.query.keyword);
  const rows = all(`${ROW_SELECT} ${sql} ${ORDER_BY} LIMIT 50000`, ...args);
  const list = rows.map(fmtRow);

  const header = [
    '订单ID', '订单号', '订单状态', '商品ID', '商品编码', '商品名称',
    '卖家', '卖家手机号', '买家（当前持有人）', '买家手机号', '持有人ID',
    '买入价', '服务费', '上架费', '当前标价', '涨价',
    '挂牌时间', '已挂(分钟)', '转拍次数', '下单时间', '确认时间',
    '所在场次', '场次日期', '场次时段',
    '下一场次', '下一场日期', '下一场时段',
    '价格上限', '价格水位(%)', '是否封顶', '备注',
  ];
  const body = list.map((x) => [
    x.order_id,
    x.order_no,
    x.pay_status,
    x.goods_id,
    x.goods_no,
    x.goods_name,
    x.seller_name,
    x.seller_mobile,
    x.buyer_name,
    x.buyer_mobile,
    x.holder_id,
    x.buy_price.toFixed(2),
    x.service_charge.toFixed(2),
    x.listing_fee.toFixed(2),
    x.sell_price.toFixed(2),
    x.gain.toFixed(2),
    // 时间/日期列都走 csvTime，Excel 里才不会被压成 ####
    csvTime(x.transposition_time),
    x.online_minutes === null ? '' : x.online_minutes,
    x.turn_beat_num,
    csvTime(x.create_time),
    csvTime(x.pay_time),
    x.area_name || '未关联场次',
    csvTime(x.area_date),
    x.area_start ? `${x.area_start}-${x.area_end}` : '',
    x.next_slot?.area_name || '',
    csvTime(x.next_slot?.date || ''),
    x.next_slot ? `${x.next_slot.start}-${x.next_slot.end}` : '',
    x.cap_price > 0 ? x.cap_price.toFixed(2) : '不限',
    x.cap_price > 0 ? x.cap_ratio : '',
    x.cap_reached ? '是' : '否',
    x.remark,
  ]);
  sendCsv(res, `transpose-orders-${todayStr().replace(/-/g, '')}.csv`, toCsv(header, body));
});

/** 订单详情（点「查看」用，只读） */
r.get('/transpose/detail', authAdmin, (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.json(fail('缺少订单号'));
  const o = get('SELECT * FROM orders WHERE order_id = ?', id);
  if (!o) return res.json(fail('订单不存在'));
  const g = orderGoods(o);
  const m = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', o.member_id);
  const logs = all('SELECT action, operator, remark, create_time FROM order_log WHERE order_id = ? ORDER BY log_id DESC LIMIT 20', id);

  // 商品流转链路：这件货被经手的每一手（卖家 → 买家 → 下一手…），按成交先后排
  const chainRows = all(
    `SELECT order_id, order_no, seller_id, member_id, total_price, pay_time, create_time
     FROM orders WHERE COALESCE(NULLIF(asset_goods_id, 0), goods_id) = ?
       AND type = 1 AND pay_status = 10 ORDER BY order_id ASC`,
    orderGoodsId(o),
  );
  const nameOf = (mid) => (Number(mid) ? get('SELECT nick_name FROM member WHERE member_id = ?', Number(mid))?.nick_name || `会员#${mid}` : '平台');
  const chain = chainRows.map((x, i) => ({
    step: i + 1,
    order_id: x.order_id,
    order_no: x.order_no,
    seller_id: Number(x.seller_id) || 0,
    seller_name: nameOf(x.seller_id),
    buyer_id: Number(x.member_id) || 0,
    buyer_name: nameOf(x.member_id),
    price: Number(x.total_price || 0),
    pay_time: x.pay_time || x.create_time || '',
    current: Number(x.order_id) === Number(id),
  }));

  const holder = o.seller_id ? get('SELECT nick_name, mobile FROM member WHERE member_id = ?', o.seller_id) : null;
  const areaRow = g?.specialarea_id
    ? get('SELECT title_main, name FROM specialarea WHERE specialarea_id = ?', g.specialarea_id)
    : null;
  res.json(ok({
    order: { ...o, owned_goods_id: orderGoodsId(o), _nick: m?.nick_name || '', _mobile: m?.mobile || '', _seller: holder?.nick_name || '', _seller_mobile: holder?.mobile || '' },
    chain,
    goods: g ? {
      goods_id: g.goods_id, goods_name: g.goods_name, good_thumb: g.good_thumb,
      goods_min_price: g.goods_min_price, base_price: g.base_price, price_cap: g.price_cap,
      goods_status: g.goods_status, turn_beat_num: g.turn_beat_num, area_date: g.area_date,
      // 场次口径与列表保持一致：取商品此刻挂的场次，不是订单当初成交的场次
      area_name: areaRow ? (areaRow.title_main || areaRow.name || '') : '',
      next_slot: nextSlotOf(g.specialarea_id, g.area_date),
    } : null,
    logs,
  }));
});

/**
 * 回撤转拍成交到指定手（仅管理员）。
 *
 * 流转链路的每一手是「同一件货的一笔独立成交订单」，不是 order_transfer 流水，
 * 所以撤销转让那套在这里用不上。回撤到第 N 手 = 撤销第 N+1 手及之后的全部成交单，
 * 把状态恢复到第 N 手刚成交完：
 *   - 逐单冲正积分/佣金/货款（与强制删除共用 lib/energyReversal.js），删对应流水
 *   - 删这些订单的 order_log / order_transfer / orders 行
 *   - 货权归第 N 手买家；turn_beat_num / sales_actual 按撤销手数回退
 *   - 标价回到第 N 手成交价，商品下架、退出场次关联
 *   - 第 N 手订单清挂牌标记，持有人可重新点「转拍上架」
 * 目标手及之前的成交不动；结算/回收台账按审计要求保留。
 */
r.post('/transpose/rollback', authAdmin, (req, res) => {
  const orderId = Number(req.body?.order_id);
  const targetStep = Number(req.body?.target_step);
  const reason = String(req.body?.reason || '').trim().slice(0, 100);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.json(fail('订单编号无效'));
  if (!Number.isInteger(targetStep) || targetStep < 1) return res.json(fail('请选择要回撤到的手数'));
  if (String(req.body?.confirm || '') !== 'ROLLBACK_CHAIN') return res.json(fail('缺少回撤确认'));

  const cur = get('SELECT * FROM orders WHERE order_id = ?', orderId);
  if (!cur) return res.json(fail('订单不存在'));
  const goodsId = orderGoodsId(cur);
  const g = get('SELECT * FROM goods WHERE goods_id = ?', goodsId);
  if (!g) return res.json(fail('商品不存在'));

  // 与 /transpose/detail 完全同一套链路口径：同一件货的已成交抢购单，按成交先后排
  const rows = all(
    `SELECT * FROM orders
      WHERE COALESCE(NULLIF(asset_goods_id, 0), goods_id) = ?
        AND type = 1 AND pay_status = 10
      ORDER BY order_id ASC`,
    goodsId,
  );
  if (rows.length < 2) return res.json(fail('该货只有一手成交，没有可回撤的后续交易'));
  if (targetStep >= rows.length) return res.json(fail('只能回撤到更早的一手'));
  const target = rows[targetStep - 1];
  const removing = rows.slice(targetStep);
  const last = rows[rows.length - 1];

  // 链路外还有变更就不动：否则会把别人已经拿走的货硬改回去
  if (Number(g.member_id) !== Number(last.member_id)) {
    return res.json(fail('商品当前持有人已不是最后一手买家，不能回撤'));
  }
  const ph = rows.map(() => '?').join(',');
  const pending = get(
    `SELECT COUNT(*) c FROM orders
      WHERE COALESCE(NULLIF(asset_goods_id, 0), goods_id) = ?
        AND order_id NOT IN (${ph}) AND IFNULL(status, 0) = 0`,
    goodsId, ...rows.map((x) => x.order_id),
  ).c;
  if (Number(pending) > 0) return res.json(fail('该货还有未确认的待处理订单，请先取消或确认后再回撤'));

  const targetBuyer = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', target.member_id);
  const reversal = [];
  let negativeMembers = [];
  tx(() => {
    // 倒序撤：先撤最后一手，避免中间状态被误判
    for (const o of [...removing].reverse()) {
      const rev = reverseOrderEnergy(o.order_no);
      reversal.push({ order_id: o.order_id, order_no: o.order_no, ...rev });
      run('DELETE FROM order_log WHERE order_id = ?', o.order_id);
      run('DELETE FROM order_transfer WHERE order_id = ?', o.order_id);
      run('DELETE FROM orders WHERE order_id = ?', o.order_id);
    }
    const n = removing.length;
    const targetPrice = Number(target.total_price || 0);
    run(
      `UPDATE goods SET member_id = ?, goods_status = 20, is_sell = 0, area_date = '',
         goods_min_price = ?, line_price = ?,
         turn_beat_num = MAX(0, IFNULL(turn_beat_num, 0) - ?),
         sales_actual = MAX(0, IFNULL(sales_actual, 0) - ?),
         update_time = ?
       WHERE goods_id = ?`,
      target.member_id, targetPrice, money(targetPrice * 1.1), n, n, now(), goodsId,
    );
    // 转拍上架时把场次关联覆盖成「下一场」，回撤后必须清掉
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', goodsId);
    // 目标手回到「未挂牌」，持有人可以重新点转拍上架
    run("UPDATE orders SET consignment_status = 0, transposition_time = '' WHERE order_id = ?", target.order_id);
    run(
      'INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
      target.order_id, '回撤流转', 'admin',
      `回撤到第 ${targetStep} 手，撤销 ${removing.map((x) => x.order_no).join('、')}${reason ? `；原因：${reason}` : ''}`,
      now(),
    );
    negativeMembers = [...new Set(reversal.flatMap((r) => negativeMembersOf(r)))];
    run(
      `INSERT INTO admin_operation_log
        (admin_id, admin_name, admin_nick, role_id, action, method, path, target_type, target_id,
         details, result, http_status, create_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      Number(req.admin?.store_user_id) || 0,
      String(req.admin?.user_name || ''), String(req.admin?.nick_name || ''), Number(req.admin?.role_id) || 0,
      '回撤转拍流转', 'POST', '/transpose/rollback', '商品', String(goodsId),
      JSON.stringify({
        goods_id: goodsId,
        target_step: targetStep,
        target_order_no: target.order_no,
        holder_id: target.member_id,
        removed_orders: removing.map((x) => ({ order_id: x.order_id, order_no: x.order_no, total_price: Number(x.total_price) })),
        reversal: reversal.map((r) => ({ order_no: r.order_no, rows: r.rows, commission: r.commission, balance: r.balance, score: r.score })),
        negative_members: negativeMembers,
        reason,
      }),
      1, 200, now(),
    );
  });

  res.json(ok({
    goods_id: goodsId,
    target_step: targetStep,
    target_order_no: target.order_no,
    holder_id: target.member_id,
    holder_name: targetBuyer?.nick_name || '',
    removed_count: removing.length,
    removed_orders: removing.map((x) => x.order_no),
    reversal: reversal.map((r) => ({ order_no: r.order_no, rows: r.rows, commission: r.commission, balance: r.balance, score: r.score })),
    negative_members: negativeMembers,
  }, `已回撤到第 ${targetStep} 手，撤销 ${removing.length} 笔成交；商品已下架并退回 ${targetBuyer?.nick_name || `会员#${target.member_id}`}`));
});

/**
 * 把正在转拍的商品改排到今天的场次（仅管理员）。
 *
 * goods.area_date 决定商品在哪天露出（列表只放行空值或等于今天），
 * 之前转拍以「上一手挂的日期」为基准往后推，会出现凌晨挂牌却排到大后天。
 * 这里给运营一个救急入口：直接把 area_date 改成今天、商品上架、只关联今天选定的场次。
 * 不动价格、不动货权、不动订单，也不改资金流水。
 */
r.post('/transpose/set-slot', authAdmin, (req, res) => {
  const orderId = Number(req.body?.order_id);
  const areaInput = Number(req.body?.area_id) || 0;
  if (!Number.isInteger(orderId) || orderId <= 0) return res.json(fail('订单编号无效'));
  if (String(req.body?.confirm || '') !== 'SET_SLOT') return res.json(fail('缺少改排确认'));
  const o = get('SELECT * FROM orders WHERE order_id = ?', orderId);
  if (!o) return res.json(fail('订单不存在'));
  const goodsId = orderGoodsId(o);
  const g = get('SELECT * FROM goods WHERE goods_id = ?', goodsId);
  if (!g) return res.json(fail('商品不存在'));
  if (Number(g.recycled) === 1) return res.json(fail('商品已被回收，不能改排场次'));
  if (Number(g.member_id) <= 0) return res.json(fail('该商品没有持有人，不能改排场次'));

  const today = todayStr();
  const list = activeSessions();
  if (!list.length) return res.json(fail('当前没有启用的场次'));
  const areaId = Number(areaInput || todaySlot(g.specialarea_id)?.area_id || list[0].specialarea_id);
  const area = list.find((s) => Number(s.specialarea_id) === areaId);
  if (!area) return res.json(fail('场次不存在或已停用'));
  const areaName = area.title_main || area.name || `场次#${areaId}`;
  const oldDate = g.area_date || '';

  tx(() => {
    run(
      "UPDATE goods SET area_date = ?, goods_status = 10, is_sell = 10, update_time = ? WHERE goods_id = ?",
      today, now(), goodsId,
    );
    // 覆盖式关联：只挂今天这一场，旧的场次关联会清掉，避免同一件货在多个场次重复露出
    setGoodsAreas(goodsId, [areaId]);
    const listed = get(
      `SELECT order_id FROM orders
        WHERE COALESCE(NULLIF(asset_goods_id, 0), goods_id) = ?
          AND member_id = ? AND type = 1 AND IFNULL(consignment_status, 0) = 10
        ORDER BY order_id DESC LIMIT 1`,
      goodsId, Number(g.member_id),
    );
    if (listed) {
      run(
        'INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        listed.order_id, '调整场次', 'admin',
        `由 ${oldDate || '不限日期'} 改排到 ${today} 的「${areaName}」，商品已上架`, now(),
      );
    }
    run(
      `INSERT INTO admin_operation_log
        (admin_id, admin_name, admin_nick, role_id, action, method, path, target_type, target_id,
         details, result, http_status, create_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      Number(req.admin?.store_user_id) || 0,
      String(req.admin?.user_name || ''), String(req.admin?.nick_name || ''), Number(req.admin?.role_id) || 0,
      '调整转拍场次', 'POST', '/transpose/set-slot', '商品', String(goodsId),
      JSON.stringify({ order_id: orderId, goods_id: goodsId, previous_date: oldDate, date: today, area_id: areaId, area_name: areaName }),
      1, 200, now(),
    );
  });

  res.json(ok({
    goods_id: goodsId,
    date: today,
    area_id: areaId,
    area_name: areaName,
    previous_date: oldDate,
    goods_status: 10,
  }, `已改排到今天（${today}）的「${areaName}」，商品已上架`));
});

export default r;
