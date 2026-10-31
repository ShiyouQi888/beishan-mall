import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import { ok, fail, authMember, maybeMember, page, money, serviceChargeRate, assetUrl } from '../lib/helper.js';
import { sessionWindow, todayStr } from '../lib/sessionWindow.js';
import { soldTodayByGoods, soldTodayOf, quotaFull, quotaLeft } from '../lib/quota.js';
import { areasOfGoods, areaMapOfGoods, displayAreaOf, openAreaOf, advanceLeadOf } from '../lib/areaGoods.js';

// 商品与场次的关系自本版起只由关联表 specialarea_goods 决定（一件商品可挂多场）。
// goods.specialarea_id 仅作为「首个关联场次」的镜像，这里一律不再读它。
const AREA_DATE_OK = "(area_date IS NULL OR area_date = '' OR area_date = ?)";

// 列表里该露出哪些商品（抢购列表 / 分类列表 / 首页共用同一口径）
//   在售的 —— 照常露出
//   已抢完的（下架态）—— 继续露出，只是变灰。**不能因为卖完就让卡片凭空消失**：
//                        用户刚看见它、回头想再看一眼却找不到，比灰着更难受。
//      · 属于某个场次的，留到它那场结束（area_date 不等于今天了才退出）
//      · 不属于任何日期的（平台持仓/不限日期），留到当天，第二天自然退场，不会越积越多
// 注意第二个条件必须限定「area_date 为空」：否则昨天那场卖剩的货今天被改一下状态，
// 就会被当成本场商品重新捞出来。
const LIST_VISIBLE = `(IFNULL(recycled, 0) = 0 AND ((goods_status = 10 AND ${AREA_DATE_OK})
  OR (goods_status = 20 AND (area_date = ? OR (IFNULL(area_date, '') = '' AND date(update_time) = ?)))))`;
// 在售的排在前面，已抢完的沉到后面，不影响「先看到能买的」
const ON_SALE_FIRST = 'ORDER BY (goods_status = 10) DESC, goods_sort ASC, goods_id DESC';
import { activeSessions } from '../lib/sessions.js';

const r = Router();

// 资源地址统一走 helper.assetUrl：默认相对路径，PUBLIC_BASE_URL 可切绝对地址
const img = (u) => assetUrl(u);

/**
 * 这件货此刻是否被「待付款订单」锁着。
 * 抢购是提交即锁单：别人下了单还没付款，这件货就不该再让人下单。
 * 按件出售的一批货不锁（那是抢一个减一个），所以这里只看唯一一件货。
 */
function isLockedByOrder(goodsId, stockTotal) {
  if (Number(stockTotal) > 1) return 0;
  const row = get(
    `SELECT 1 AS x FROM orders
     WHERE goods_id = ? AND type = 1 AND IFNULL(status, 0) = 0 AND IFNULL(pay_status, 0) = 0
     LIMIT 1`,
    Number(goodsId),
  );
  return row ? 1 : 0;
}

/**
 * 商品统一出参格式
 * @param {object} g goods 行
 * @param {number} soldToday 本场已卖出件数
 * @param {Array} areas 该商品关联的场次（由调用方批量查好后传入，避免 N+1）
 */
export const fmtGoods = (g, soldToday = 0, areas = []) => {
  const list = areas || [];
  return {
    goods_id: g.goods_id,
    goods_name: g.goods_name,
    goods_no: g.goods_no,
    good_thumb: img(g.good_thumb),
    images: g.images ? JSON.parse(g.images).map(img) : [],
    detail: g.detail || '',
    // 详情长图：接在富文本下方满宽铺开，顺序 = 后台的上传顺序
    detail_images: g.detail_images ? JSON.parse(g.detail_images).map(img) : [],
    goods_min_price: Number(g.goods_min_price).toFixed(2),
    line_price: Number(g.line_price || 0).toFixed(2),
    sales_actual: g.sales_actual,
    stock_num: g.stock_num,
    // 名额：这件商品一共几个。>1 表示「一批货，抢一个减一个」，=1 表示「唯一一件货，成交即归买家」
    stock_total: Number(g.stock_total) || Number(g.stock_num) || 1,
    // 每场放量：这一场只拿出多少件来卖（0 = 不限，整批库存都能卖）
    session_quota: Number(g.session_quota) || 0,
    session_sold: Number(soldToday) || 0,
    // 本场放量已经卖满 —— 注意这和「库存卖光」是两回事：库存可能还有 90 件，只是这场不放了
    session_full: quotaFull(g, soldToday) ? 1 : 0,
    session_left: quotaLeft(g, soldToday) === null ? null : quotaLeft(g, soldToday),
    goods_status: g.goods_status,
    // 1 抢购语义（关联了场次）/ 2 商城语义（没关联场次）。**必须返回**：H5 详情页靠它区分
    // 「要不要等抢购场次」，漏返会让抢购商品在非抢购时段也显示「立即抢购」
    type: list.length ? 1 : 2,
    // 已抢完：下架态（成交/售罄都会落到 20），或「本场放量已经卖满」。
    // 不看 stock_num —— 未关联场次的商品常常不维护库存，用它判断会全标成售罄
    sold_out: Number(g.goods_status) === 10 && !quotaFull(g, soldToday) ? 0 : 1,
    turn_beat_num: g.turn_beat_num,
    // 1 = 已经有别人下单锁着（还没付款），前台要显示「抢购中」并禁用按钮
    locked: isLockedByOrder(g.goods_id, Number(g.stock_total) || Number(g.stock_num) || 1),
    // 兼容字段：第一个关联场次。真实归属以 specialarea_ids 为准（可多场）
    specialarea_id: list.length ? Number(list[0].specialarea_id) : 0,
    specialarea_ids: list.map((a) => Number(a.specialarea_id)),
    specialarea_names: list.map((a) => a.title_main || a.name || ''),
    category_id: g.category_id,
    create_time: g.create_time,
    holder: g.member_id
      ? get('SELECT nick_name FROM member WHERE member_id = ?', g.member_id)?.nick_name || ''
      : '',
  };
};

// ---------------- 分类 ----------------
const CATEGORY_SQL = (homeOnly) =>
  `SELECT * FROM goods_category WHERE type = 2 ${homeOnly ? 'AND home_show = 10' : ''} ORDER BY sort ASC, category_id ASC`;

/** 各场次此刻的状态（open / upcoming / ended / closed），一次查询给整页商品共用 */
export function areaStates() {
  const m = new Map();
  for (const a of all('SELECT * FROM specialarea')) m.set(Number(a.specialarea_id), sessionWindow(a).state);
  return m;
}

/**
 * 列表专用格式化：在 fmtGoods 之上补一个 session_state。
 * 首页 / 分类 / 搜索的商品卡片都要靠它判断「这场是不是已经结束了」——
 * 只给抢购页加灰卡、别的入口还是彩色卡片，用户点进去才发现买不了，等于没做。
 * 没关联任何场次的商品拿不到场次，状态是 none，前端不会置灰。
 */
export const fmtList = (rows, states = null, soldMap = null) => {
  const stateMap = states || areaStates();
  const sold = soldMap || soldTodayByGoods();
  const areaMap = areaMapOfGoods(rows.map((g) => g.goods_id));
  return rows.map((g) => {
    const areas = areaMap.get(Number(g.goods_id)) || [];
    const shown = displayAreaOf(areas);
    return {
      ...fmtGoods(g, sold.get(Number(g.goods_id)) || 0, areas),
      // 代表场次的状态（开放中优先，其次未开始、已结束）
      session_state: shown ? shown.w.state : 'none',
      session_state_area: shown ? Number(shown.a.specialarea_id) : 0,
    };
  });
};

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
    `SELECT COUNT(*) c FROM goods WHERE category_id = ? AND ${LIST_VISIBLE}`,
    Number(category_id), todayStr(), todayStr(), todayStr(),
  ).c;
  const list = all(
    `SELECT * FROM goods WHERE category_id = ? AND ${LIST_VISIBLE}
     ${ON_SALE_FIRST} LIMIT ? OFFSET ?`,
    Number(category_id), todayStr(), todayStr(), todayStr(), pp, (cur - 1) * pp,
  );
  res.json(ok(page(fmtList(list), total, cur, pp)));
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
  const states = areaStates();
  const list = areas.map((a) => {
    // 场次与商品多对多：一件商品可以同时出现在多个场次里
    const goods = fmtList(all(
      `SELECT * FROM goods
       WHERE goods_id IN (SELECT goods_id FROM specialarea_goods WHERE specialarea_id = ?)
         AND ${LIST_VISIBLE}
       ${ON_SALE_FIRST} LIMIT 20`,
      a.specialarea_id, todayStr(), todayStr(), todayStr(),
    ), states);
    return { ...a, goods_list: goods };
  });
  res.json(ok({ list }));
});

// 抢购商品列表（分页，带场次筛选）
r.get('/getLootGoodsList', (req, res) => {
  const { specialarea_id, page: p = 1, limit = 10 } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  // 不传场次时列出「所有已关联场次」的商品；传了则只看该场
  const where = [
    specialarea_id
      ? 'goods_id IN (SELECT goods_id FROM specialarea_goods WHERE specialarea_id = ?)'
      : 'goods_id IN (SELECT goods_id FROM specialarea_goods)',
    LIST_VISIBLE,
  ];
  const args = specialarea_id
    ? [Number(specialarea_id), todayStr(), todayStr(), todayStr()]
    : [todayStr(), todayStr(), todayStr()];
  const w = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM goods WHERE ${w}`, ...args).c;
  const list = all(
    `SELECT * FROM goods WHERE ${w} ${ON_SALE_FIRST} LIMIT ? OFFSET ?`,
    ...args, pp, (cur - 1) * pp,
  );
  res.json(ok(page(fmtList(list), total, cur, pp)));
});

r.get('/getLootDetails', maybeMember, (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g || Number(g.recycled) === 1) return res.json(fail('商品不存在或已下架'));
  const areas = areasOfGoods(g.goods_id);
  const shown = displayAreaOf(areas);
  const area = shown?.a || null;
  const w = shown?.w || null;
  const now = new Date();
  const open = openAreaOf(areas, now);
  // 提前抢购：场次还没开，但这个会员有资格提前进来
  const lead = advanceLeadOf(req.member);
  const adv = !open && lead > 0 ? openAreaOf(areas, now, lead) : null;
  res.json(
    ok({
      ...fmtGoods(g, soldTodayOf(g.goods_id), areas),
      // 只要这件商品关联的场次里有一个正在开放，此刻就能抢
      is_ordinary_order: open ? 1 : 0,
      // 已开通提前抢购、且此刻正处在提前窗口里
      advance_open: adv && adv.advanced ? 1 : 0,
      advance_lead_left: adv && adv.advanced ? adv.lead_left : 0,
      advance_seconds: lead,
      // 与列表同一口径：open / upcoming / ended / closed / none
      session_state: w ? w.state : 'none',
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
      transposition_hours: Number(open?.area?.transposition_hours ?? area?.transposition_hours ?? 0),
    }),
  );
});

// ---------------- 商城商品（未关联场次的商品、以及首页/分类/搜索的通用列表） ----------------
r.get('/searchShop', (req, res) => {
  const { keywords = '', page: p = 1, limit = 10, category_id } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  const where = ['goods_status = 10', 'IFNULL(recycled, 0) = 0'];
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
  res.json(ok(page(fmtList(list), total, cur, pp)));
});

r.get('/shopgoods/getDetails', maybeMember, (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g || Number(g.recycled) === 1) return res.json(fail('商品不存在'));

  const areas = areasOfGoods(g.goods_id);
  const shown = displayAreaOf(areas);
  // 场次对象要把开始/结束时间格式化成 HH:MM 再给出去 —— 前端模板直接用这两个字段
  const area = shown ? {
    specialarea_id: shown.a.specialarea_id,
    name: shown.a.name,
    title_main: shown.a.title_main,
    title_ordinary: shown.a.title_ordinary,
    start_end_time: shown.w.startText,
    start_end_time1: shown.w.endText,
    state: shown.w.state,
    days_text: shown.w.daysText,
  } : null;

  // 提前抢购：当前会员（没登录则没有）能把场次往前放多少秒
  const lead = advanceLeadOf(req.member);
  const now = new Date();
  const opened = openAreaOf(areas, now);
  const adv = !opened && lead > 0 ? openAreaOf(areas, now, lead) : null;

  res.json(ok({
    ...fmtGoods(g, soldTodayOf(g.goods_id), areas),
    specialarea: area,
    // 本场此刻是否真的开放（前端靠它决定按钮能不能点）
    is_ordinary_order: opened ? 1 : 0,
    // 已开通提前抢购、且此刻正处在「提前窗口」里
    advance_open: adv && adv.advanced ? 1 : 0,
    advance_lead_left: adv && adv.advanced ? adv.lead_left : 0,
    advance_seconds: lead,
    comments: [],
  }));
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
  const areas = areasOfGoods(g.goods_id);
  // 限购次数取「此刻正在开放」的那场；都不开放时取代表场次（与下单提示保持一致）
  const area = openAreaOf(areas)?.area || displayAreaOf(areas)?.a || null;
  // 与下单校验同一口径：只算「这个会员买过这个商品多少件」，不牵扯同场其它商品
  const bought = Number(get(
    'SELECT IFNULL(SUM(num),0) n FROM orders WHERE member_id = ? AND goods_id = ? AND type = 1 AND status <> 40',
    req.member.member_id, g.goods_id,
  ).n);
  const limit = area?.buy_num || 1;
  const left = Math.max(0, limit - bought);
  if (left <= 0) return res.json(fail(`每人限抢 ${limit} 件，你已经抢过了`));
  res.json(ok({ buy_num: bought, limit, left, can_buy: 1 }));
});

r.get('/getShopPosterDetails', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  res.json(ok({ ...fmtGoods(g, soldTodayOf(g.goods_id), areasOfGoods(g.goods_id)), poster_bg: get("SELECT `value` FROM setting_config WHERE `key`='poster_bg'")?.value || '' }));
});

// 积分商城已拆到独立控制器 score.js（对齐原站 /api/score/ 路径）


export default r;
