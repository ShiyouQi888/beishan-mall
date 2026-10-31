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
import { todayStr, addDays } from '../../lib/sessionWindow.js';
import { priceCapOf } from '../../lib/priceCap.js';

const r = Router();

/** 快捷时间范围 → [起, 止] 的 YYYY-MM-DD（按北京日期，不用服务器时区） */
function resolveRange(range, start, end) {
  const today = todayStr();
  if (range === 'yesterday') {
    const d = addDays(today, -1);
    return { start: d, end: d };
  }
  if (range === 'week') {
    // 本周一 → 今天。getUTCDay 读的是纯日历值，不受服务器时区影响
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = 周日
    return { start: addDays(today, -(dow === 0 ? 6 : dow - 1)), end: today };
  }
  if (range === 'month') return { start: `${today.slice(0, 7)}-01`, end: today };
  if (range === 'custom') {
    const s = String(start || '').trim();
    const e = String(end || '').trim();
    // 只认 YYYY-MM-DD，别把任意字符串拼进 SQL
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return null;
    return s <= e ? { start: s, end: e } : { start: e, end: s };
  }
  if (range === 'all') return { start: '', end: '' };
  return { start: today, end: today }; // 默认今日
}

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
  LEFT JOIN member m ON m.member_id = o.member_id`;

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

  const rows = all(
    `SELECT o.order_id, o.order_no, o.goods_id, o.member_id, o.total_price, o.listing_fee,
            o.transposition_time, o.specialarea_id, o.pay_time,
            g.goods_name, g.good_thumb, g.goods_min_price, g.base_price, g.price_cap,
            g.turn_beat_num, g.area_date, g.stock_total, g.stock_num,
            m.nick_name, m.mobile
     ${FROM} ${sql}
     ORDER BY o.transposition_time DESC, o.order_id DESC
     LIMIT ? OFFSET ?`,
    ...args, pp, (p - 1) * pp,
  );

  const list = rows.map((row) => {
    const area = row.specialarea_id
      ? get('SELECT title_main, name FROM specialarea WHERE specialarea_id = ?', row.specialarea_id)
      : null;
    // 水位按「基准价 → 上限」算，和商品页同源，避免两处口径不一致
    const cap = priceCapOf({
      goods_min_price: row.goods_min_price,
      base_price: row.base_price,
      price_cap: row.price_cap,
    });
    return {
      order_id: row.order_id,
      order_no: row.order_no,
      goods_id: row.goods_id,
      goods_name: row.goods_name,
      good_thumb: row.good_thumb || '',
      member_id: row.member_id,
      nick_name: row.nick_name || '',
      mobile: row.mobile || '',
      buy_price: Number(row.total_price || 0),
      sell_price: Number(row.goods_min_price || 0),
      gain: Number((Number(row.goods_min_price || 0) - Number(row.total_price || 0)).toFixed(2)),
      listing_fee: Number(row.listing_fee || 0),
      transposition_time: row.transposition_time || '',
      online_minutes: minutesSince(row.transposition_time),
      turn_beat_num: Number(row.turn_beat_num || 0),
      area_name: area?.title_main || area?.name || '',
      area_date: row.area_date || '',
      stock_total: Number(row.stock_total || 1),
      stock_num: Number(row.stock_num || 0),
      cap_price: cap.cap_price,
      cap_reached: cap.reached ? 1 : 0,
      cap_ratio: Math.round(Number(cap.ratio || 0) * 100),
    };
  });

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

/** 订单详情（点「查看」用，只读） */
r.get('/transpose/detail', authAdmin, (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.json(fail('缺少订单号'));
  const o = get('SELECT * FROM orders WHERE order_id = ?', id);
  if (!o) return res.json(fail('订单不存在'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', o.goods_id);
  const m = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', o.member_id);
  const logs = all('SELECT action, operator, remark, create_time FROM order_log WHERE order_id = ? ORDER BY log_id DESC LIMIT 20', id);
  res.json(ok({
    order: { ...o, _nick: m?.nick_name || '', _mobile: m?.mobile || '' },
    goods: g ? {
      goods_id: g.goods_id, goods_name: g.goods_name, good_thumb: g.good_thumb,
      goods_min_price: g.goods_min_price, base_price: g.base_price, price_cap: g.price_cap,
      goods_status: g.goods_status, turn_beat_num: g.turn_beat_num, area_date: g.area_date,
    } : null,
    logs,
  }));
});

export default r;
