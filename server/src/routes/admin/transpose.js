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
import { all, get } from '../../db.js';
import { ok, fail, authAdmin } from '../../lib/helper.js';
import { resolveRange } from '../../lib/dateRange.js';
import { priceCapOf } from '../../lib/priceCap.js';
import { nextSlot } from '../../lib/sessions.js';
import { toCsv, sendCsv, csvTime } from '../../lib/csv.js';
import { todayStr } from '../../lib/sessionWindow.js';

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
  JOIN goods g ON g.goods_id = o.goods_id
  LEFT JOIN member m ON m.member_id = o.member_id
  LEFT JOIN member s ON s.member_id = o.seller_id`;

/** 列表与导出共用同一段查询，避免两处字段走偏 */
const ROW_SELECT = `SELECT o.order_id, o.order_no, o.goods_id, o.member_id, o.total_price, o.listing_fee,
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
            COUNT(DISTINCT o.goods_id) goods_count,
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
  const g = get('SELECT * FROM goods WHERE goods_id = ?', o.goods_id);
  const m = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', o.member_id);
  const logs = all('SELECT action, operator, remark, create_time FROM order_log WHERE order_id = ? ORDER BY log_id DESC LIMIT 20', id);

  // 商品流转链路：这件货被经手的每一手（卖家 → 买家 → 下一手…），按成交先后排
  const chainRows = all(
    `SELECT order_id, order_no, seller_id, member_id, total_price, pay_time, create_time
     FROM orders WHERE goods_id = ? AND type = 1 AND pay_status = 10 ORDER BY order_id ASC`,
    o.goods_id,
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
    order: { ...o, _nick: m?.nick_name || '', _mobile: m?.mobile || '', _seller: holder?.nick_name || '', _seller_mobile: holder?.mobile || '' },
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

export default r;
