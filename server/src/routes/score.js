// 积分商城（会员端）
// 积分商品是独立表 score_item，不再关联商城商品 goods；
// 兑换生成独立的 score_exchange 记录，不进 orders，也就不参与货款、分账与佣金。
import { Router } from 'express';
import { all, get, run, tx, now } from '../db.js';
import { ok, fail, authMember, page, assetUrl } from '../lib/helper.js';

const r = Router();

/** 积分商城总开关（后台「商城设置 → 积分商城」）：关闭后前台入口隐藏，接口也一并拒绝 */
const scoreOpen = () => String(get("SELECT `value` FROM setting_config WHERE `key` = 'score_open'")?.value ?? '10') === '10';
const closed = (res) => res.json(fail('积分商城暂未开放'));

/** 积分商品的对外结构：只暴露前台需要的字段，避免把内部排序权重等漏出去 */
function fmtItem(x) {
  return {
    item_id: x.item_id,
    name: x.name || '',
    thumb: assetUrl(x.thumb),
    images: (() => {
      try { return JSON.parse(x.images || '[]').map((p) => assetUrl(p)); } catch { return []; }
    })(),
    intro: x.intro || '',
    detail: x.detail || '',
    score_price: Number(x.score_price || 0),
    stock: Number(x.stock || 0),
    sold: Number(x.sold || 0),
    limit_per: Number(x.limit_per || 0),
  };
}

/** 积分商品列表 */
r.get('/getScoreShopList', (req, res) => {
  if (!scoreOpen()) return closed(res);
  const cur = Math.max(1, Number(req.query.page) || 1);
  const pp = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const total = get('SELECT COUNT(*) c FROM score_item WHERE status = 10')?.c || 0;
  const list = all(
    'SELECT * FROM score_item WHERE status = 10 ORDER BY sort ASC, item_id DESC LIMIT ? OFFSET ?',
    pp, (cur - 1) * pp,
  );
  res.json(ok({ list: page(list.map(fmtItem), total, cur, pp) }));
});

/** 积分商品详情 */
r.get('/getDetails', (req, res) => {
  if (!scoreOpen()) return closed(res);
  const id = Number(req.query.item_id || req.query.goods_id || 0);
  if (!id) return res.json(fail('method param miss:item_id'));
  const it = get('SELECT * FROM score_item WHERE item_id = ?', id);
  if (!it) return res.json(fail('积分商品不存在'));
  if (Number(it.status) !== 10) return res.json(fail('该商品已下架'));
  res.json(ok(fmtItem(it)));
});

/** 我的兑换记录 */
r.get('/myExchanges', authMember, (req, res) => {
  if (!scoreOpen()) return closed(res);
  const cur = Math.max(1, Number(req.query.page) || 1);
  const pp = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const mid = req.member.member_id;
  const total = get('SELECT COUNT(*) c FROM score_exchange WHERE member_id = ?', mid)?.c || 0;
  const list = all(
    'SELECT * FROM score_exchange WHERE member_id = ? ORDER BY exchange_id DESC LIMIT ? OFFSET ?',
    mid, pp, (cur - 1) * pp,
  );
  res.json(ok({
    list: page(list.map((x) => ({
      exchange_id: x.exchange_id,
      exchange_no: x.exchange_no,
      item_id: x.item_id,
      item_name: x.item_name,
      item_thumb: assetUrl(x.item_thumb),
      num: Number(x.num || 0),
      total_score: Number(x.total_score || 0),
      status: Number(x.status),
      status_text: { 10: '待发货', 20: '待收货', 30: '已完成', 40: '已取消' }[Number(x.status)] || '',
      express_no: x.express_no || '',
      express_company: x.express_company || '',
      create_time: x.create_time,
    })), total, cur, pp),
  }));
});

/**
 * 兑换商品：扣积分、减库存、写兑换单。
 * 兑换走发货流程，所以收货地址是必填的 —— 没有地址的兑换单在后台根本发不出去。
 */
r.post('/exchange', authMember, (req, res) => {
  if (!scoreOpen()) return closed(res);
  const m = req.member;
  const itemId = Number(req.body?.item_id || req.body?.goods_id || 0);
  const num = Number(req.body?.num ?? 1);
  const addressId = Number(req.body?.address_id || 0);

  if (!itemId) return res.json(fail('请选择积分商品'));
  if (!Number.isInteger(num) || num < 1) return res.json(fail('兑换数量必须是不小于 1 的整数'));
  if (num > 99) return res.json(fail('单次最多兑换 99 件'));
  if (!addressId) return res.json(fail('请选择收货地址'));

  const it = get('SELECT * FROM score_item WHERE item_id = ?', itemId);
  if (!it) return res.json(fail('积分商品不存在'));
  if (Number(it.status) !== 10) return res.json(fail('该商品已下架'));

  const addr = get('SELECT * FROM member_address WHERE address_id = ? AND member_id = ?', addressId, m.member_id);
  if (!addr) return res.json(fail('收货地址不存在'));

  const scorePrice = Number(it.score_price || 0);
  if (!(scorePrice > 0)) return res.json(fail('该商品积分配置异常，请联系客服'));
  const need = scorePrice * num;

  if (Number(it.stock || 0) < num) return res.json(fail(`库存不足，仅剩 ${Number(it.stock) || 0} 件`));
  if (Number(m.score || 0) < need) return res.json(fail(`积分不足，还差 ${need - Number(m.score || 0)} 积分`));

  // 每人限兑：按已兑换（不含已取消）的总件数算
  const limitPer = Number(it.limit_per || 0);
  if (limitPer > 0) {
    const got = get(
      'SELECT IFNULL(SUM(num),0) s FROM score_exchange WHERE member_id = ? AND item_id = ? AND status <> 40',
      m.member_id, itemId,
    )?.s || 0;
    if (Number(got) + num > limitPer) {
      return res.json(fail(`每人限兑 ${limitPer} 件，你已兑换 ${Number(got)} 件`));
    }
  }

  const exchangeNo = `E${Date.now()}${String(Math.floor(Math.random() * 900 + 100))}`;
  try {
    tx(() => {
      // 原子扣积分：余额不足时 changes=0，避免并发超兑
      const r1 = run('UPDATE member SET score = score - ? WHERE member_id = ? AND score >= ?', need, m.member_id, need);
      if (Number(r1.changes) !== 1) throw Object.assign(new Error('积分不足'), { biz: true });
      // 原子扣库存：库存不足时 changes=0
      const r2 = run('UPDATE score_item SET stock = stock - ?, sold = sold + ? WHERE item_id = ? AND stock >= ?', num, num, itemId, num);
      if (Number(r2.changes) !== 1) throw Object.assign(new Error('库存不足'), { biz: true });

      run(
        `INSERT INTO score_exchange (exchange_no, member_id, item_id, item_name, item_thumb, score_cost, num, total_score,
           receiver, mobile, region, address, status, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,10,?)`,
        exchangeNo, m.member_id, itemId, it.name || '', it.thumb || '', scorePrice, num, need,
        addr.name || '', addr.mobile || '', `${addr.province || ''}${addr.city || ''}${addr.district || ''}`, addr.detail || '', now(),
      );
      run(
        'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
        m.member_id, -need, 3, '积分兑换', `兑换 ${it.name || ''} ×${num}`, now(),
      );
    });
  } catch (e) {
    return res.json(fail(e.biz ? e.message : '兑换失败，请稍后重试'));
  }
  res.json(ok({ exchange_no: exchangeNo }, '兑换成功'));
});

export default r;
