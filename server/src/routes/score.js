// 积分商城（对齐原站 score 控制器：/api/score/xxx）
import { Router } from 'express';
import { all, get } from '../db.js';
import { ok, fail, page } from '../lib/helper.js';
import { fmtGoods } from './goods.js';

const r = Router();

/** 积分商品列表 */
r.get('/getScoreShopList', (req, res) => {
  const { page: p = 1, limit = 10 } = req.query;
  const pp = Number(limit);
  const cur = Number(p);
  const total = get(
    'SELECT COUNT(*) c FROM score_goods sg JOIN goods g ON g.goods_id = sg.goods_id WHERE g.goods_status = 10',
  ).c;
  const list = all(
    `SELECT g.*, sg.score AS score_price, sg.stock AS score_stock FROM score_goods sg JOIN goods g ON g.goods_id = sg.goods_id
     WHERE g.goods_status = 10 ORDER BY sg.sort ASC LIMIT ? OFFSET ?`,
    pp, (cur - 1) * pp,
  );
  // fmtGoods 只输出固定字段，积分价需显式带上
  res.json(ok({
    list: page(
      list.map((g) => ({ ...fmtGoods(g), score_price: Number(g.score_price), score_stock: Number(g.score_stock) })),
      total, cur, pp,
    ),
  }));
});

/** 积分商品详情（带兑换所需积分） */
r.get('/getDetails', (req, res) => {
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  const sg = get('SELECT * FROM score_goods WHERE goods_id = ?', Number(goods_id));
  if (!sg) return res.json(fail('该商品不支持积分兑换'));
  res.json(ok({ ...fmtGoods(g), score_price: sg.score, score_stock: sg.stock }));
});

export default r;
