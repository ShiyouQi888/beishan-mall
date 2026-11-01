import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import { ok, fail, authMember, maybeMember, page, money, serviceChargeRate, assetUrl } from '../lib/helper.js';
import { sessionLimitLeft } from '../lib/purchaseLimit.js';
import { sessionWindow, todayStr } from '../lib/sessionWindow.js';
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
// 场次被停用后，只挂在这一场里的商品不该继续出现在前台。
// 注意要放行「一个场次都没关联」的自由商品 —— 它们本来就不受场次约束。
const AREA_ENABLED = `(
  NOT EXISTS (SELECT 1 FROM specialarea_goods sg0 WHERE sg0.goods_id = goods.goods_id)
  OR EXISTS (
    SELECT 1 FROM specialarea_goods sg1
    JOIN specialarea s1 ON s1.specialarea_id = sg1.specialarea_id
    WHERE sg1.goods_id = goods.goods_id AND IFNULL(s1.is_open, 10) = 10
  )
)`;
const LIST_VISIBLE = `(IFNULL(recycled, 0) = 0 AND ${AREA_ENABLED} AND ((goods_status = 10 AND ${AREA_DATE_OK})
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
 * @param {Array} areas 该商品关联的场次（由调用方批量查好后传入，避免 N+1）
 */
export const fmtGoods = (g, areas = []) => {
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
    goods_status: g.goods_status,
    // 1 抢购语义（关联了场次）/ 2 商城语义（没关联场次）。**必须返回**：H5 详情页靠它区分
    // 「要不要等抢购场次」，漏返会让抢购商品在非抢购时段也显示「立即抢购」
    type: list.length ? 1 : 2,
    // 已抢完就看下架态（成交 / 售罄都会落到 20）。
    // 不看 stock_num —— 未关联场次的商品常常不维护库存，用它判断会全标成售罄
    sold_out: Number(g.goods_status) === 10 ? 0 : 1,
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
export const fmtList = (rows, states = null, member = null) => {
  const stateMap = states || areaStates();
  const areaMap = areaMapOfGoods(rows.map((g) => g.goods_id));
  const picked = rows.map((g) => ({ g, shown: displayAreaOf(areaMap.get(Number(g.goods_id)) || []) }));

  // 本场每人限购：一次查出这批货涉及的所有场次、今天这个会员已买了几件（跨商品合计）。
  // 之前列表完全不返回限购状态，会员抢满额度后列表还是一片「去抢购」，
  // 点进去才被详情页拦住 —— 看起来就像「明明抢过了还能抢」。
  const boughtByArea = (() => {
    if (!member?.member_id) return null;
    const ids = [...new Set(picked.map((x) => Number(x.shown?.a?.specialarea_id) || 0).filter(Boolean))];
    if (!ids.length) return new Map();
    const list = all(
      `SELECT specialarea_id, IFNULL(SUM(num),0) n FROM orders
        WHERE member_id = ? AND type = 1 AND status <> 40 AND date(create_time) = ?
          AND specialarea_id IN (${ids.map(() => '?').join(',')})
        GROUP BY specialarea_id`,
      member.member_id, todayStr(), ...ids,
    );
    return new Map(list.map((r) => [Number(r.specialarea_id), Number(r.n)]));
  })();

  return picked.map(({ g, shown }) => {
    const areaId = shown ? Number(shown.a.specialarea_id) : 0;
    const out = {
      ...fmtGoods(g, areaMap.get(Number(g.goods_id)) || []),
      // 代表场次的状态（开放中优先，其次未开始、已结束）
      session_state: shown ? shown.w.state : 'none',
      session_state_area: areaId,
    };
    if (boughtByArea) {
      out.purchase_limit = Number(shown?.a?.buy_num) || 0;
      out.purchase_bought = boughtByArea.get(areaId) || 0;
    }
    return out;
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
  res.json(ok(page(fmtList(list, null, req.member), total, cur, pp)));
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
      // 只剩「主标题 + 副标题 + 一张场次图」：introduction_* 那套是早期商城语义的遗留，
      // 前台从来不渲染，出参里也一并去掉（列还在表里，只是不再读）
      title: {
        ordinary_title_main: a.title_main,
        ordinary_title: a.title_ordinary,
      },
      images: {
        ordinary_images: img(a.image_ordinary),
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
      buy_num: a.buy_num,
      open_days: a.open_days || '1,2,3,4,5,6,7',
      transposition_hours: a.transposition_hours,
    };
  });
}

r.get('/getLootList', maybeMember, (req, res) => {
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
    ), states, req.member);
    return { ...a, goods_list: goods };
  });

  // 本场成交后又被转拍的货：它的开抢日期已经排到未来，按规则就不该出现在今天的列表里，
  // 但直接消失会让用户以为「刚看到的货没了」。单独给一块「下一场开抢」的预告，
  // 只做展示、不可购买（点进去是详情页的「xx 开抢」提示）。
  const hhmm = (sec) => {
    const n = Number(sec) || 0;
    return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
  };
  const preview = all(
    `SELECT o.goods_id, o.goods_name, g.good_thumb, g.goods_min_price, g.area_date, g.specialarea_id
     FROM orders o JOIN goods g ON g.goods_id = o.goods_id
     WHERE o.type = 1 AND o.pay_status = 10 AND IFNULL(o.consignment_status, 0) = 10
       AND g.member_id = o.member_id AND g.goods_status = 10 AND IFNULL(g.recycled, 0) = 0
       AND IFNULL(g.area_date, '') > ?
     ORDER BY g.area_date ASC, o.order_id DESC LIMIT 12`,
    todayStr(),
  ).map((x) => {
    const a = x.specialarea_id
      ? get('SELECT title_main, name, start_time FROM specialarea WHERE specialarea_id = ?', x.specialarea_id)
      : null;
    const areaName = a ? (a.title_main || a.name || '') : '';
    return {
      goods_id: x.goods_id,
      goods_name: x.goods_name,
      good_thumb: img(x.good_thumb),
      // 显示的是「下一场」的标价，不是当前场的价格，前端会标明
      price: Number(x.goods_min_price || 0).toFixed(2),
      next_date: x.area_date,
      next_area: areaName,
      next_text: `${x.area_date.slice(5)}${a ? ` ${hhmm(a.start_time)}` : ''} 开抢`,
    };
  });

  res.json(ok({ list, preview }));
});

// 抢购商品列表（分页，带场次筛选）
r.get('/getLootGoodsList', maybeMember, (req, res) => {
  const { specialarea_id, page: p = 1, limit = 10 } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  // 不传场次时列出「所有已关联场次」的商品；传了则只看该场
  // 停用的场次不列商品：子查询里直接带上 is_open 过滤
  const enabledLink = `SELECT sg.goods_id FROM specialarea_goods sg
      JOIN specialarea s ON s.specialarea_id = sg.specialarea_id
      WHERE IFNULL(s.is_open, 10) = 10`;
  const where = [
    specialarea_id
      ? `goods_id IN (${enabledLink} AND sg.specialarea_id = ?)`
      : `goods_id IN (${enabledLink})`,
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
  res.json(ok(page(fmtList(list, null, req.member), total, cur, pp)));
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
  // 轮转到明天的商品，今天任何场次开放都不代表能买
  const notYetOpen = !!g.area_date && g.area_date > todayStr();
  // 提前抢购：场次还没开，但这个会员有资格提前进来
  const lead = advanceLeadOf(req.member);
  const adv = !open && lead > 0 ? openAreaOf(areas, now, lead) : null;
  res.json(
    ok({
      ...fmtGoods(g, areas),
      // 只要这件商品关联的场次里有一个正在开放、且开抢日期已到，此刻才能抢
      is_ordinary_order: open && !notYetOpen ? 1 : 0,
      // 开抢日期还没到（转拍落到明天那种）：场次时间窗可能显示「开放中」，
      // 但下单会被拒，所以这里单独标出来，让前端直接禁按钮并说明哪天开抢
      not_yet_open: notYetOpen ? 1 : 0,
      area_date: g.area_date || '',
      // 已开通提前抢购、且此刻正处在提前窗口里
      advance_open: adv && adv.advanced ? 1 : 0,
      advance_lead_left: adv && adv.advanced ? adv.lead_left : 0,
      advance_seconds: lead,
      // 与列表同一口径：open / upcoming / ended / closed / none
      session_state: w ? w.state : 'none',
      // 本场每人限购：limit>0 才有效，bought 是这个会员本场今天已买的件数（跨商品合计）
      ...(() => {
        const target = open?.area || area;
        const { limit, bought } = sessionLimitLeft(req.member?.member_id, target);
        return { purchase_limit: limit, purchase_bought: bought };
      })(),
      // 这件货本人是否已经买过（同一件货每人只能买一次），前端据此直接禁用按钮
      purchased: req.member
        ? (Number(get(
          'SELECT COUNT(*) c FROM orders WHERE member_id = ? AND goods_id = ? AND type = 1 AND status <> 40',
          req.member.member_id, g.goods_id,
        )?.c || 0) > 0 ? 1 : 0)
        : 0,
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
  res.json(ok(page(fmtList(list, null, req.member), total, cur, pp)));
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
    ...fmtGoods(g, areas),
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
  // 限购取「此刻正在开放」的那场；都不开放时取代表场次（与下单提示保持一致）
  const area = openAreaOf(areas)?.area || displayAreaOf(areas)?.a || null;
  // 与下单校验同一口径：本场次今天这个会员合计买了多少件（跨商品），见 lib/purchaseLimit.js
  const { limit, bought, left } = sessionLimitLeft(req.member.member_id, area);
  if (limit > 0 && left <= 0) return res.json(fail(`本场每人限购 ${limit} 件，你已经抢满了`));
  res.json(ok({ buy_num: bought, limit, left, can_buy: 1 }));
});

r.get('/getShopPosterDetails', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  res.json(ok({ ...fmtGoods(g, areasOfGoods(g.goods_id)), poster_bg: get("SELECT `value` FROM setting_config WHERE `key`='poster_bg'")?.value || '' }));
});

// 积分商城已拆到独立控制器 score.js（对齐原站 /api/score/ 路径）


export default r;
