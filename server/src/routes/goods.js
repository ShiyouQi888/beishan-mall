import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import { ok, fail, authMember, page, money, serviceChargeRate, assetUrl } from '../lib/helper.js';
import { splitGoods } from '../lib/split.js';
import { sessionWindow, todayStr } from '../lib/sessionWindow.js';

// 只露出「今天该出现」的商品：轮转到明天的商品今天不该被看到/被抢
const AREA_DATE_OK = "(area_date IS NULL OR area_date = '' OR area_date = ?)";

// 列表里该露出哪些商品（抢购列表 / 分类列表 / 首页共用同一口径）
//   在售的 —— 照常露出
//   已抢完的（下架态）—— 只在「它自己那场的日期 = 今天」时继续露一次，让用户看到「已抢完」
//                        的灰卡片，而不是卡片凭空消失。轮到下一场 / 到了明天，area_date 不再等于
//                        今天，这些卡片自然被替换掉，不需要额外的定时清理。
// 注意这里比 AREA_DATE_OK 更严：不限日期（area_date 为空）的商品一旦售罄就直接消失 ——
// 否则平台持仓的老货会永远挂成一张灰卡片，越积越多。
// 占位顺序：第一个 ? = AREA_DATE_OK 的今天，第二个 ? = 已抢完判定用的今天
const LIST_VISIBLE = `((goods_status = 10 AND ${AREA_DATE_OK}) OR (goods_status = 20 AND area_date = ?))`;
// 在售的排在前面，已抢完的沉到后面，不影响「先看到能买的」
const ON_SALE_FIRST = 'ORDER BY (goods_status = 10) DESC, goods_sort ASC, goods_id DESC';
import { activeSessions } from '../lib/sessions.js';

const r = Router();

// 资源地址统一走 helper.assetUrl：默认相对路径，PUBLIC_BASE_URL 可切绝对地址
const img = (u) => assetUrl(u);

// 商品统一出参格式（积分商城路由 score.js 也复用）
export const fmtGoods = (g) => ({
  goods_id: g.goods_id,
  goods_name: g.goods_name,
  goods_no: g.goods_no,
  good_thumb: img(g.good_thumb),
  images: g.images ? JSON.parse(g.images).map(img) : [],
  detail: g.detail || '',
  goods_min_price: Number(g.goods_min_price).toFixed(2),
  line_price: Number(g.line_price || 0).toFixed(2),
  sales_actual: g.sales_actual,
  stock_num: g.stock_num,
  goods_status: g.goods_status,
  // 1 抢购 / 2 商城。**必须返回**：H5 详情页靠它区分「要不要等抢购场次」，
  // 之前漏了这个字段，前端 Number(undefined) === 1 恒为 false，
  // 结果抢购商品在非抢购时段也显示「立即抢购」、按钮能点 —— 外面显示已结束/已抢完，
  // 点进去却像还能买。这种「字段没返回 → 前端静默放行」的坑只能靠接口契约兜住
  type: Number(g.type) || 1,
  // 已抢完：下架态（成交/售罄都会落到 20）。前端据此置灰卡片、把按钮改成「已抢完」。
  // 不看 stock_num —— 商城商品(type=2)根本不维护库存，用它判断会把商城货全标成售罄
  sold_out: Number(g.goods_status) === 10 ? 0 : 1,
  is_split: g.is_split,
  split_total: g.split_total,
  turn_beat_num: g.turn_beat_num,
  specialarea_id: g.specialarea_id,
  category_id: g.category_id,
  create_time: g.create_time,
  holder: g.member_id
    ? get('SELECT nick_name FROM member WHERE member_id = ?', g.member_id)?.nick_name || ''
    : '',
});

// ---------------- 分类 ----------------
const CATEGORY_SQL = (homeOnly) =>
  `SELECT * FROM goods_category WHERE type = 2 ${homeOnly ? 'AND home_show = 10' : ''} ORDER BY sort ASC, category_id ASC`;

r.get('/getCategory', (req, res) => {
  const homeOnly = String(req.query.home || '') === '1';
  let rows;
  try {
    rows = all(CATEGORY_SQL(homeOnly));
  } catch (e) {
    // 老库可能还没补上 home_show 列（启动迁移失败 / 手工导过库）。
    // 这种情况退化成「不过滤」，绝不能让首页整块分类直接 500。
    if (!/home_show/.test(String(e.message))) throw e;
    rows = all(CATEGORY_SQL(false));
  }
  res.json(
    ok({
      categoryList: rows.map((c) => ({
        category_id: c.category_id,
        name: c.name,
        image: String(c.image || '').startsWith('icon:') ? c.image : img(c.image),
        sort: c.sort,
      })),
    }),
  );
});

r.get('/category/getCategoryGoodsList', (req, res) => {
  const { category_id, page: p = 1, limit = 10 } = req.query;
  if (!category_id) return res.json(fail('method param miss:category_id'));
  const pp = Number(limit);
  const cur = Number(p);
  const total = get(
    `SELECT COUNT(*) c FROM goods WHERE category_id = ? AND type = 1 AND ${LIST_VISIBLE}`,
    Number(category_id), todayStr(), todayStr(),
  ).c;
  const list = all(
    `SELECT * FROM goods WHERE category_id = ? AND type = 1 AND ${LIST_VISIBLE}
     ${ON_SALE_FIRST} LIMIT ? OFFSET ?`,
    Number(category_id), todayStr(), todayStr(), pp, (cur - 1) * pp,
  );
  res.json(ok(page(list.map(fmtGoods), total, cur, pp)));
});

// ---------------- 抢购场次 ---------------- 
function areaPayload() {
  const now = new Date();
  // 场次顺序统一走 lib/sessions.js：开放中的在前，再按各自开始时间 / 上午-下午-晚上语义排
  const list = activeSessions((a) => sessionWindow(a, now));
  return list.map((a) => {
    const w = sessionWindow(a, now);
    const start = w.dayStart + w.start;
    const end = w.end ? w.dayStart + w.end : w.dayStart + 86399;
    return {
      specialarea_id: a.specialarea_id,
      name: a.name,
      srot: a.sort,
      title: {
        ordinary_title_main: a.title_main,
        ordinary_title: a.title_ordinary,
        introduction_title: a.title_intro,
      },
      images: {
        ordinary_images: img(a.image_ordinary),
        introduction_images: img(a.image_intro),
      },
      time: {
        start_time: start,
        end_time: end,
        new_time: w.nowSec,
        start_end_time: w.startText,
        start_end_time1: w.endText || '23:59',
      },
      is_ordinary_order: w.open ? 1 : 0,
      is_introduction_order: 0,
      is_subscribe: a.is_subscribe,
      buy_num: a.buy_num,
      open_days: a.open_days || '1,2,3,4,5,6,7',
      transposition_hours: a.transposition_hours,
    };
  });
}

r.get('/getLootList', (req, res) => {
  const areas = areaPayload();
  const list = areas.map((a) => {
    const goods = all(
      `SELECT * FROM goods WHERE specialarea_id = ? AND type = 1 AND ${LIST_VISIBLE}
       ${ON_SALE_FIRST} LIMIT 20`,
      a.specialarea_id, todayStr(), todayStr(),
    ).map(fmtGoods);
    return { ...a, goods_list: goods };
  });
  res.json(ok({ list }));
});

// 抢购商品列表（分页，带场次筛选）
r.get('/getLootGoodsList', (req, res) => {
  const { specialarea_id, page: p = 1, limit = 10 } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  const where = ['type = 1', LIST_VISIBLE];
  const args = [todayStr(), todayStr()];
  if (specialarea_id) {
    where.push('specialarea_id = ?');
    args.push(Number(specialarea_id));
  }
  const w = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM goods WHERE ${w}`, ...args).c;
  const list = all(
    `SELECT * FROM goods WHERE ${w} ${ON_SALE_FIRST} LIMIT ? OFFSET ?`,
    ...args, pp, (cur - 1) * pp,
  );
  res.json(ok(page(list.map(fmtGoods), total, cur, pp)));
});

r.get('/getLootDetails', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在或已下架'));
  const area = get('SELECT * FROM specialarea WHERE specialarea_id = ?', g.specialarea_id);
  const w = area ? sessionWindow(area) : { open: false, startText: '', endText: '' };
  res.json(
    ok({
      ...fmtGoods(g),
      // 抢购商品是否处于开放时间（统一按后台的抢购总时间）
      is_ordinary_order: g.type === 1 && area && w.open ? 1 : 0,
      specialarea: area
        ? {
            specialarea_id: area.specialarea_id,
            title_main: area.title_main,
            title_ordinary: area.title_ordinary,
            start_end_time: w.startText,
            start_end_time1: w.endText || '23:59',
          }
        : null,
      // 与下单、后台配置同一口径（lib/helper.js serviceChargeRate）
      service_charge_rate: serviceChargeRate(),
      transposition_hours: Number(
        get('SELECT transposition_hours h FROM specialarea WHERE specialarea_id = ?', g.specialarea_id)?.h || 0,
      ),
    }),
  );
});

// ---------------- 商城商品 ----------------
r.get('/searchShop', (req, res) => {
  const { keywords = '', page: p = 1, limit = 10, category_id } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  const where = ['goods_status = 10'];
  const args = [];
  if (keywords) {
    where.push('goods_name LIKE ?');
    args.push(`%${keywords}%`);
  }
  if (category_id) {
    where.push('category_id = ?');
    args.push(Number(category_id));
  }
  const w = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM goods WHERE ${w}`, ...args).c;
  const list = all(
    `SELECT * FROM goods WHERE ${w} ORDER BY goods_sort ASC, goods_id DESC LIMIT ? OFFSET ?`,
    ...args, pp, (cur - 1) * pp,
  );
  res.json(ok(page(list.map(fmtGoods), total, cur, pp)));
});

r.get('/shopgoods/getDetails', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  res.json(ok({ ...fmtGoods(g), comments: [] }));
});

r.get('/getGoodsEvaluation', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  res.json(ok({ list: [], total: 0, rate: '100%' }));
});

r.get('/getPurchaseNum', authMember, (req, res) => {
  const { goods_id } = req.query;
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  const area = get('SELECT * FROM specialarea WHERE specialarea_id = ?', g.specialarea_id);
  const bought = get(
    `SELECT COUNT(*) c FROM orders WHERE member_id = ? AND goods_id = ? AND type = 1 AND status NOT IN (40)`,
    req.member.member_id, g.goods_id,
  ).c;
  const limit = area?.buy_num || 1;
  if (bought >= limit) return res.json(fail('该场次购买数量已达上限'));
  res.json(ok({ buy_num: bought, limit, can_buy: 1 }));
});

r.get('/getShopPosterDetails', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  res.json(ok({ ...fmtGoods(g), poster_bg: get("SELECT `value` FROM setting_config WHERE `key`='poster_bg'")?.value || '' }));
});

// 积分商城已拆到独立控制器 score.js（对齐原站 /api/score/ 路径）


// 商品拆分（持有人把自己的商品按份挂牌）
r.post('/split', authMember, (req, res) => {
  const { goods_id, parts } = req.body;
  const out = splitGoods(goods_id, parts, req.member.member_id);
  if (!out.ok) return res.json(fail(out.reason));
  res.json(ok(out, `已拆分为 ${out.parts} 份，每份 ¥${out.per_part.toFixed(2)}`));
});

export default r;
