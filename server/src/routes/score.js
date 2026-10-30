// 积分商城（对齐原站 score 控制器：/api/score/xxx）
import { Router } from 'express';
import { all, get, run, tx, now } from '../db.js';
import { ok, fail, authMember, page } from '../lib/helper.js';
import { fmtGoods } from './goods.js';

const r = Router();

/** 积分商城总开关（后台「商城设置 → 积分商城」）：关闭后前台入口隐藏，接口也一并拒绝 */
const scoreOpen = () => String(get("SELECT `value` FROM setting_config WHERE `key` = 'score_open'")?.value ?? '10') === '10';
const closed = (res) => res.json(fail('积分商城暂未开放'));

/** 积分商品列表 */
r.get('/getScoreShopList', (req, res) => {
  if (!scoreOpen()) return closed(res);
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
  if (!scoreOpen()) return closed(res);
  const { goods_id } = req.query;
  if (!goods_id) return res.json(fail('method param miss:goods_id'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  const sg = get('SELECT * FROM score_goods WHERE goods_id = ?', Number(goods_id));
  if (!sg) return res.json(fail('该商品不支持积分兑换'));
  res.json(ok({ ...fmtGoods(g), score_price: sg.score, score_stock: sg.stock }));
});

/** 积分兑换商品：扣积分、减库存、生成一笔 0 元兑换单 */
r.post('/exchange', authMember, (req, res) => {
  if (!scoreOpen()) return closed(res);
  const { goods_id } = req.body;
  const sg = get('SELECT * FROM score_goods WHERE goods_id = ?', Number(goods_id));
  if (!sg) return res.json(fail('该商品不支持积分兑换'));
  const m = req.member;
  if (m.score < sg.score) return res.json(fail('积分不足'));
  if (sg.stock <= 0) return res.json(fail('库存不足'));
  const g = get('SELECT * FROM goods WHERE goods_id = ?', sg.goods_id);
  tx(() => {
    run('UPDATE member SET score = score - ? WHERE member_id = ?', sg.score, m.member_id);
    run('UPDATE score_goods SET stock = stock - 1 WHERE id = ?', sg.id);
    run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      m.member_id, -sg.score, 3, '积分兑换', g?.goods_name || '', now());
    run(
      `INSERT INTO orders (order_no, member_id, goods_id, goods_name, goods_thumb, type, price, num, total_price, status, pay_status, pay_type, create_time)
       VALUES (?,?,?,?,?,3,0,1,0,10,10,1,?)`,
      `J${Date.now()}`, m.member_id, sg.goods_id, g?.goods_name || '', g?.good_thumb || '', now(),
    );
  });
  res.json(ok([], '兑换成功'));
});

export default r;
