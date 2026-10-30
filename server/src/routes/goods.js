import { Router } from 'express';
import { all, get, run, now } from '../db.js';
import { ok, fail, authMember, page, money, serviceChargeRate, assetUrl } from '../lib/helper.js';
import { splitGoods } from '../lib/split.js';

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
r.get('/getCategory', (req, res) => {
  const rows = all('SELECT * FROM goods_category WHERE type = 2 ORDER BY sort ASC, category_id ASC');
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
    'SELECT COUNT(*) c FROM goods WHERE category_id = ? AND goods_status = 10 AND type = 1',
    Number(category_id),
  ).c;
  const list = all(
    `SELECT * FROM goods WHERE category_id = ? AND goods_status = 10 AND type = 1
     ORDER BY goods_sort ASC, goods_id DESC LIMIT ? OFFSET ?`,
    Number(category_id), pp, (cur - 1) * pp,
  );
  res.json(ok(page(list.map(fmtGoods), total, cur, pp)));
});

// ---------------- 抢购场次 ---------------- 
function areaPayload() {
  const nowSec = Math.floor(Date.now() / 1000);
  const dayStart = new Date().setHours(0, 0, 0, 0) / 1000;
  const list = all('SELECT * FROM specialarea WHERE is_open = 10 ORDER BY sort ASC, specialarea_id ASC');
  return list.map((a) => {
    const start = dayStart + a.start_time;
    const end = dayStart + a.end_time;
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
        new_time: nowSec,
        start_end_time: hhmm(a.start_time),
        start_end_time1: hhmm(a.end_time),
      },
      is_ordinary_order: nowSec >= start && nowSec <= end ? 1 : 0,
      is_introduction_order: 0,
      is_subscribe: a.is_subscribe,
      buy_num: a.buy_num,
      open_days: a.open_days,
      transposition_hours: a.transposition_hours,
    };
  });
}

const hhmm = (sec) =>
  `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

r.get('/getLootList', (req, res) => {
  const areas = areaPayload();
  const list = areas.map((a) => {
    const goods = all(
      `SELECT * FROM goods WHERE specialarea_id = ? AND goods_status = 10 AND type = 1
       ORDER BY goods_sort ASC, goods_id DESC LIMIT 20`,
      a.specialarea_id,
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
  const where = ['goods_status = 10', 'type = 1'];
  const args = [];
  if (specialarea_id) {
    where.push('specialarea_id = ?');
    args.push(Number(specialarea_id));
  }
  const w = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM goods WHERE ${w}`, ...args).c;
  const list = all(
    `SELECT * FROM goods WHERE ${w} ORDER BY goods_sort ASC, goods_id DESC LIMIT ? OFFSET ?`,
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
  res.json(
    ok({
      ...fmtGoods(g),
      specialarea: area
        ? {
            specialarea_id: area.specialarea_id,
            title_main: area.title_main,
            title_ordinary: area.title_ordinary,
            start_end_time: hhmm(area.start_time),
            start_end_time1: hhmm(area.end_time),
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
