// 后台补充接口：统计、会员操作、直推奖补发、指派订单、缓存清理
import { Router } from 'express';
import { all, get, run, tx, now, today, db } from '../../db.js';
import { ok, fail, authAdmin, money, ORDER_STATUS, calcServiceCharge, serviceChargeRate } from '../../lib/helper.js';
import { distributeAward, driveAwardRate, calcListingFee, listingFeeRate, biz } from '../../lib/settle.js';
import { orderNo } from '../../lib/auth.js';
import { nodeTree, roleNodeIds, saveRoleNodes, rolePaths, isSuperRole, superRoleIds } from '../../lib/nodes.js';
import { MENU } from '../../lib/menu.config.js';
import { isPieceSale, deductStock } from '../../lib/stock.js';
import { areasOfGoods } from '../../lib/areaGoods.js';

const r = Router();

// ---------------- 管理员操作审计 ----------------
r.get('/audit/list', authAdmin, (req, res) => {
  const canViewAll = isSuperRole(req.admin.role_id);
  const currentPage = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(100, Math.max(10, Math.floor(Number(req.query.limit) || 20)));
  const where = [];
  const args = [];

  // 服务端强制数据范围：非超管无论提交什么 admin_id，都只能查本人。
  if (canViewAll) {
    const adminId = Number(req.query.admin_id) || 0;
    if (adminId > 0) { where.push('admin_id = ?'); args.push(adminId); }
  } else {
    where.push('admin_id = ?');
    args.push(Number(req.admin.store_user_id));
  }

  const keyword = String(req.query.keyword || '').trim().slice(0, 100);
  if (keyword) {
    const like = `%${keyword}%`;
    where.push('(admin_name LIKE ? OR admin_nick LIKE ? OR action LIKE ? OR path LIKE ? OR target_id LIKE ? OR result_message LIKE ? OR details LIKE ?)');
    args.push(like, like, like, like, like, like, like);
  }
  const result = String(req.query.result ?? '');
  if (result === '0' || result === '1') { where.push('result = ?'); args.push(Number(result)); }
  const startDate = String(req.query.start_date || '').slice(0, 10);
  const endDate = String(req.query.end_date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { where.push('create_time >= ?'); args.push(`${startDate} 00:00:00`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) { where.push('create_time <= ?'); args.push(`${endDate} 23:59:59`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get(`SELECT COUNT(*) c FROM admin_operation_log ${whereSql}`, ...args)?.c || 0);
  const list = all(
    `SELECT log_id, admin_id, admin_name, admin_nick, role_id, action, method, path,
            target_type, target_id, details, result, result_message, http_status, ip, user_agent, create_time
       FROM admin_operation_log ${whereSql}
       ORDER BY log_id DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, (currentPage - 1) * pageSize,
  );
  const operators = canViewAll
    ? all('SELECT store_user_id id, user_name name FROM store_user ORDER BY user_name ASC')
    : [];

  res.json(ok({ list, total, page: currentPage, page_size: pageSize, can_view_all: canViewAll, operators }));
});

// ---------------- 统计 ----------------
/** 商品金额统计（对齐原站 getstatistics 的四个卡片）——商品已统一，按「单价 × 库存」计货值 */
r.get('/stats/goods', authAdmin, (req, res) => {
  const amt = (extra) =>
    get(
      `SELECT IFNULL(SUM(goods_min_price * MAX(IFNULL(stock_num, 1), 1)), 0) v
       FROM goods WHERE ${extra}`,
    )?.v || 0;

  res.json(
    ok({
      total_amount: money(amt('1=1')),
      online_amount: money(amt('goods_status = 10')),
      offline_amount: money(amt('goods_status = 20')),
      pending_amount: money(amt('goods_status = 30')),
      // 已回收封顶的商品：前台不再展示，单独统计便于核对平台持仓
      recycled_amount: money(amt('IFNULL(recycled, 0) = 1')),
      total_count: get('SELECT COUNT(*) c FROM goods').c,
      online_count: get('SELECT COUNT(*) c FROM goods WHERE goods_status = 10').c,
      offline_count: get('SELECT COUNT(*) c FROM goods WHERE goods_status = 20').c,
      pending_count: get('SELECT COUNT(*) c FROM goods WHERE goods_status = 30').c,
      recycled_count: get('SELECT COUNT(*) c FROM goods WHERE IFNULL(recycled, 0) = 1').c,
    }),
  );
});

/** 今日订单明细（对齐原站 todayorderdetail） */
r.get('/stats/today-orders', authAdmin, (req, res) => {
  const d = today();
  const rows = all(
    `SELECT o.*, m.nick_name buyer_name, m.mobile buyer_mobile
     FROM orders o LEFT JOIN member m ON m.member_id = o.member_id
     WHERE o.create_time >= ? ORDER BY o.order_id DESC LIMIT 200`,
    d,
  );
  const sum = (f) => money(rows.reduce((s, x) => s + Number(x[f] || 0), 0));
  res.json(
    ok({
      date: d,
      count: rows.length,
      total_price: sum('total_price'),
      listing_fee: sum('listing_fee'),
      paid_count: rows.filter((x) => x.pay_status === 10).length,
      list: rows.map((x) => ({
        order_id: x.order_id,
        order_no: x.order_no,
        goods_name: x.goods_name,
        buyer_name: x.buyer_name || '—',
        buyer_mobile: x.buyer_mobile || '',
        total_price: Number(x.total_price).toFixed(2),
        status: x.status,
        create_time: x.create_time,
      })),
    }),
  );
});

// ---------------- 会员操作 ----------------
/** 提前抢购授权 */
r.post('/member/advance', authAdmin, (req, res) => {
  const { member_id, enable, count = 0, minutes = 0 } = req.body || {};
  const m = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!m) return res.json(fail('会员不存在'));
  const on = enable ? 10 : 0;
  // 提前量：分钟 → 秒，最多 60 分钟。关闭时一并清零，避免下次开通带着旧值
  const minutesNum = Math.max(0, Math.min(60, Math.round(Number(minutes) || 0)));
  const seconds = on ? minutesNum * 60 : 0;
  run(
    'UPDATE member SET is_advance = ?, advance_count = ?, advance_seconds = ?, advance_time = ? WHERE member_id = ?',
    on, Number(count) || 0, seconds, on ? Math.floor(Date.now() / 1000) : 0, m.member_id,
  );
  res.json(ok([], on
    ? `已开通提前抢购${minutesNum > 0 ? `（每场提前 ${minutesNum} 分钟）` : '（未设置提前量，按场次原时间）'}`
    : '已关闭提前抢购'));
});

/** 清除佣金（记一条负数流水，保留审计痕迹） */
r.post('/member/clear-commission', authAdmin, (req, res) => {
  const { member_id } = req.body || {};
  const m = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!m) return res.json(fail('会员不存在'));
  const v = money(Number(m.e_card_number || 0));
  if (v <= 0) return res.json(fail('该会员没有可清除的佣金'));
  tx(() => {
    run('UPDATE member SET e_card_number = 0 WHERE member_id = ?', m.member_id);
    run(
      'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      m.member_id, -v, 3, '后台清除佣金', '管理员清零操作', now(),
    );
  });
  res.json(ok({ amount: v }, `已清除佣金 ¥${v.toFixed(2)}`));
});

/** 佣金发放记录（按会员聚合 + 明细） */
r.get('/member/energy-record', authAdmin, (req, res) => {
  const memberId = Number(req.query.member_id) || 0;
  if (!memberId) {
    const list = all(
      `SELECT f.member_id, m.nick_name, m.mobile,
              IFNULL(SUM(f.face_value),0) total, COUNT(*) cnt, MAX(f.create_time) last_time
       FROM finance_energy f LEFT JOIN member m ON m.member_id = f.member_id
       WHERE f.type = 1 GROUP BY f.member_id ORDER BY total DESC LIMIT 100`,
    );
    return res.json(ok({ summary: true, list }));
  }
  // scope=all 返回全部资金流水（余额变动 + 返佣），默认只看返佣
  const allTypes = String(req.query.scope || '') === 'all';
  const rows = allTypes
    ? all('SELECT * FROM finance_energy WHERE member_id = ? ORDER BY energy_id DESC LIMIT 200', memberId)
    : all('SELECT * FROM finance_energy WHERE member_id = ? AND type = 1 ORDER BY energy_id DESC LIMIT 200', memberId);
  res.json(
    ok({
      member_id: memberId,
      scope: allTypes ? 'all' : 'award',
      total: money(rows.reduce((s, x) => s + Number(x.face_value || 0), 0)),
      list: rows,
    }),
  );
});

// ---------------- 直推奖补发 ----------------
r.post('/award/grant', authAdmin, (req, res) => {
  const { order_id } = req.body || {};
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  if (o.pay_status !== 10) return res.json(fail('订单未支付，无法发放直推奖'));

  const tag = `订单 ${o.order_no} 大账买单直推奖`;
  if (get('SELECT 1 FROM finance_energy WHERE type = 1 AND remarks = ?', tag)) {
    return res.json(fail('该订单已发放过直推奖'));
  }
  if (driveAwardRate() <= 0) return res.json(fail('直推奖比例为 0，请先在交易设置中配置'));

  let amount = 0;
  tx(() => {
    amount = distributeAward(o);
  });
  if (amount <= 0) return res.json(fail('该订单没有可发放的对象（下单人无上级）'));
  res.json(ok({ amount }, `已发放直推奖 ¥${amount.toFixed(2)}`));
});

// ---------------- 指派订单 ----------------
/** 可指派会员列表 */
// ---------------- 会员：启停用 / 删除 ----------------
/** 批量启用 / 禁用会员 */
r.post('/member/status', authAdmin, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id]).map(Number).filter(Boolean);
  const disabled = Number(req.body?.disabled) === 20 ? 20 : 10;
  if (!ids.length) return res.json(fail('请选择要操作的会员'));
  let n = 0;
  tx(() => {
    for (const id of ids) {
      if (!get('SELECT 1 FROM member WHERE member_id = ?', id)) continue;
      run('UPDATE member SET disabled = ?, update_time = ? WHERE member_id = ?', disabled, now(), id);
      run('INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
        id, disabled === 20 ? '账号已禁用' : '账号已启用',
        disabled === 20 ? '你的账号已被平台禁用，如有疑问请联系客服。' : '你的账号已恢复正常使用。', now());
      n += 1;
    }
  });
  res.json(ok({ count: n }, disabled === 20 ? `已禁用 ${n} 个账号` : `已启用 ${n} 个账号`));
});

/**
 * 批量删除会员。
 * 有业务记录的账号不能删——订单/流水/提现都引用会员，删了会变成孤儿数据，这种情况会提示改用禁用。
 * 支持的删除前提：无订单、无资金流水、无提现、无下级、无地址/收款卡/实名。
 */
r.post('/member/remove', authAdmin, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id]).map(Number).filter(Boolean);
  if (!ids.length) return res.json(fail('请选择要删除的会员'));

  const reasonsOf = (id) => {
    const m = get('SELECT member_id, nick_name, p_id, child_id FROM member WHERE member_id = ?', id);
    if (!m) return ['会员不存在'];
    const reasons = [];
    const cnt = (sql, ...args) => get(sql, ...args).c;
    const orders = cnt('SELECT COUNT(*) c FROM orders WHERE member_id = ? OR seller_id = ?', id, id);
    if (orders) reasons.push(`${orders} 笔订单`);
    const flows = cnt('SELECT COUNT(*) c FROM finance_energy WHERE member_id = ?', id);
    if (flows) reasons.push(`${flows} 条资金流水`);
    const childs = cnt('SELECT COUNT(*) c FROM member WHERE p_id = ?', id);
    if (childs) reasons.push(`${childs} 个下级会员`);
    const addr = cnt('SELECT COUNT(*) c FROM member_address WHERE member_id = ?', id);
    if (addr) reasons.push(`${addr} 条收货地址`);
    const card = cnt('SELECT COUNT(*) c FROM member_card WHERE member_id = ?', id);
    if (card) reasons.push(`${card} 张收款卡`);
    const cert = cnt('SELECT COUNT(*) c FROM member_certification WHERE member_id = ?', id);
    if (cert) reasons.push('实名认证记录');
    return reasons;
  };

  const removed = [];
  const skipped = [];
  tx(() => {
    for (const id of ids) {
      const reasons = reasonsOf(id);
      if (reasons.length) { skipped.push({ member_id: id, reasons }); continue; }
      const m = get('SELECT p_id FROM member WHERE member_id = ?', id);
      if (m?.p_id) {
        const p = get('SELECT child_id FROM member WHERE member_id = ?', m.p_id);
        const kept = String(p?.child_id || '').split(',').filter((x) => x && Number(x) !== id);
        run('UPDATE member SET child_id = ? WHERE member_id = ?', kept.join(','), m.p_id);
      }
      run('DELETE FROM member WHERE member_id = ?', id);
      removed.push(id);
    }
  });

  if (!removed.length) {
    const first = skipped[0];
    const detail = first ? `：该会员存在 ${first.reasons.join('、')}，请改用「禁用」` : '';
    return res.json(fail(`没有可删除的会员${detail}`));
  }
  const skipMsg = skipped.length ? `，${skipped.length} 个跳过（有业务记录，请用禁用）` : '';
  res.json(ok({ removed, skipped }, `已删除 ${removed.length} 个会员${skipMsg}`));
});

// 会员下拉（编辑会员时选上级用）
r.get('/member/options', authAdmin, (req, res) => {
  const kw = String(req.query.keyword || '').trim();
  const rows = kw
    ? all(
      'SELECT member_id, nick_name, mobile FROM member WHERE nick_name LIKE ? OR mobile LIKE ? ORDER BY member_id DESC LIMIT 50',
      `%${kw}%`, `%${kw}%`,
    )
    : all('SELECT member_id, nick_name, mobile FROM member ORDER BY member_id DESC LIMIT 50');
  res.json(ok(rows));
});

// ---------------- 订单管理增强 ----------------
/** 新增订单的会员、商品远程搜索。只提供正常会员和当前可售商品。 */
r.get('/orders/create-options', authAdmin, (req, res) => {
  const kind = String(req.query.kind || '');
  const keyword = String(req.query.keyword || '').trim().slice(0, 80);
  const like = `%${keyword}%`;

  if (kind === 'member') {
    const rows = keyword
      ? all(
        `SELECT member_id, nick_name, mobile FROM member
          WHERE IFNULL(disabled, 10) <> 20
            AND (nick_name LIKE ? OR mobile LIKE ? OR CAST(member_id AS TEXT) = ?)
          ORDER BY member_id DESC LIMIT 50`,
        like, like, keyword,
      )
      : all(
        `SELECT member_id, nick_name, mobile FROM member
          WHERE IFNULL(disabled, 10) <> 20 ORDER BY member_id DESC LIMIT 50`,
      );
    return res.json(ok({ rows, service_charge_rate: serviceChargeRate(), listing_fee_rate: listingFeeRate() }));
  }

  if (kind === 'goods') {
    const buyerId = Number(req.query.member_id) || 0;
    const conditions = [
      'goods_status = 10',
      'IFNULL(recycled, 0) = 0',
      '(MAX(IFNULL(stock_total, 0), IFNULL(stock_num, 0), 1) <= 1 OR IFNULL(stock_num, 0) > 0)',
    ];
    const args = [];
    if (buyerId > 0) {
      conditions.push('IFNULL(member_id, 0) <> ?'); args.push(buyerId);
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM orders prior WHERE prior.member_id = ?
          AND (prior.goods_id = goods.goods_id OR prior.asset_goods_id = goods.goods_id)
          AND prior.type = 1 AND IFNULL(prior.status, 0) <> 40
      )`);
      args.push(buyerId);
    }
    if (keyword) {
      conditions.push('(goods_name LIKE ? OR goods_no LIKE ? OR CAST(goods_id AS TEXT) = ?)');
      args.push(like, like, keyword);
    }
    // 唯一件商品有待确认订单时已被锁定；按件库存池仍可继续创建订单，按名额扣减。
    conditions.push(`(
      MAX(IFNULL(stock_total, 0), IFNULL(stock_num, 0), 1) > 1
      OR NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.goods_id = goods.goods_id AND o.type = 1
          AND IFNULL(o.status, 0) = 0 AND IFNULL(o.pay_status, 0) = 0
      )
    )`);
    const rows = all(
      `SELECT goods.*,
         MAX(IFNULL(goods.stock_total, 0), IFNULL(goods.stock_num, 0), 1) AS order_stock_total,
         m.nick_name AS holder_name, m.mobile AS holder_mobile
       FROM goods LEFT JOIN member m ON m.member_id = goods.member_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY (goods.goods_status = 10) DESC, goods.goods_sort ASC, goods.goods_id DESC LIMIT 100`,
      ...args,
    ).map((g) => ({
      goods_id: Number(g.goods_id),
      goods_name: g.goods_name || '',
      goods_no: g.goods_no || '',
      good_thumb: g.good_thumb || '',
      goods_min_price: Number(g.goods_min_price) || 0,
      stock_num: Number(g.stock_num) || 0,
      stock_total: Number(g.order_stock_total) || 1,
      member_id: Number(g.member_id) || 0,
      holder_name: g.holder_name || '',
      holder_mobile: g.holder_mobile || '',
      piece_sale: Number(g.order_stock_total) > 1 ? 1 : 0,
    }));
    return res.json(ok({ rows, service_charge_rate: serviceChargeRate(), listing_fee_rate: listingFeeRate() }));
  }

  return res.json(fail('请选择要搜索的选项类型'));
});

/** 后台手动新增一笔抢购单。每单一件，成交时复用现有确认收款结算流程。 */
r.post('/orders/create', authAdmin, (req, res) => {
  const memberId = Number(req.body?.member_id) || 0;
  const goodsId = Number(req.body?.goods_id) || 0;
  const priceInput = Number(req.body?.price);
  const remark = String(req.body?.remark || '').trim().slice(0, 500);
  if (!memberId) return res.json(fail('请选择会员'));
  if (!goodsId) return res.json(fail('请选择商品'));
  if (!Number.isFinite(priceInput) || priceInput <= 0) return res.json(fail('单价必须大于 0'));
  if (req.body?.num !== undefined && Number(req.body.num) !== 1) {
    return res.json(fail('每笔订单对应一件独立货权，请按件分别新增'));
  }

  let created;
  try {
    tx(() => {
      const member = get('SELECT member_id, nick_name, disabled FROM member WHERE member_id = ?', memberId);
      if (!member) throw biz('会员不存在');
      if (Number(member.disabled) === 20) throw biz('该会员已被禁用，不能新增订单');

      let goods = get('SELECT * FROM goods WHERE goods_id = ?', goodsId);
      if (!goods) throw biz('商品不存在');
      if (Number(goods.goods_status) !== 10 || Number(goods.recycled) === 1) throw biz('商品已下架，不能新增订单');
      if (Number(goods.member_id) === memberId) throw biz('不能为商品当前持有人新增购买订单');

      // 旧数据可能没有 stock_total；按现有库存补齐后再判断它是否属于库存池。
      const stockTotal = Math.max(Number(goods.stock_total) || 0, Number(goods.stock_num) || 0, 1);
      if (stockTotal !== Number(goods.stock_total || 0)) {
        run('UPDATE goods SET stock_total = ?, update_time = ? WHERE goods_id = ?', stockTotal, now(), goodsId);
        goods = get('SELECT * FROM goods WHERE goods_id = ?', goodsId);
      }

      const pieceSale = isPieceSale(goods);
      if (pieceSale) {
        if (Number(goods.stock_num) < 1) throw biz('商品库存不足');
      } else {
        const locked = get(
          `SELECT order_id FROM orders WHERE goods_id = ? AND type = 1
            AND IFNULL(status, 0) = 0 AND IFNULL(pay_status, 0) = 0 LIMIT 1`,
          goodsId,
        );
        if (locked) throw biz('该商品已有待确认订单，暂不能重复锁单');
      }

      const everBought = get(
        `SELECT 1 AS found FROM orders
          WHERE member_id = ? AND (goods_id = ? OR asset_goods_id = ?)
            AND type = 1 AND IFNULL(status, 0) <> 40 LIMIT 1`,
        memberId, goodsId, goodsId,
      );
      if (everBought) throw biz('该会员已有这件商品的有效订单，不能重复购买');

      const price = money(priceInput);
      if (price <= 0) throw biz('单价不能低于 0.01 元');
      const totalPrice = price;
      const serviceCharge = calcServiceCharge(totalPrice);
      const listingFee = calcListingFee(totalPrice);
      const no = orderNo('M');
      const area = areasOfGoods(goodsId)[0];

      if (pieceSale && !deductStock(goodsId, 1)) throw biz('商品库存不足，请刷新后重试');

      const info = run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
          type, price, num, total_price, service_charge, listing_fee, status, pay_status, pay_type, address_id, remark, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,?,?)`,
        no, memberId, Number(goods.member_id) || 0, goodsId, goods.goods_name || '', goods.good_thumb || '',
        Number(area?.specialarea_id || goods.specialarea_id) || 0,
        1, price, 1, totalPrice, serviceCharge, listingFee,
        remark || '后台手动新增', now(),
      );
      const orderId = Number(info.lastInsertRowid);
      const operator = req.admin.user_name || req.admin.nick_name || 'admin';
      run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        orderId, '后台新增订单', operator, `${member.nick_name || `会员#${memberId}`} · ${goods.goods_name} · ¥${price.toFixed(2)}`, now());
      created = { order_id: orderId, order_no: no, total_price: totalPrice, service_charge: serviceCharge, listing_fee: listingFee };
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }

  res.json(ok(created, '订单已新增，当前待确认'));
});

/** 批量导入订单（后台录入，跳过前台风控） */
r.post('/orders/import', authAdmin, (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.json(fail('请提供要导入的订单数据'));
  if (rows.length > 200) return res.json(fail('单次最多导入 200 条'));

  let okCount = 0;
  const errors = [];
  const created = [];

  tx(() => {
    rows.forEach((row, i) => {
      try {
        const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(row.goods_id));
        if (!g) throw new Error('商品不存在');
        const m = get('SELECT * FROM member WHERE member_id = ?', Number(row.member_id));
        if (!m) throw new Error('会员不存在');
        const price = Number(row.price) || Number(g.goods_min_price);
        const num = Number(row.num) || 1;
        if (price <= 0) throw new Error('价格必须大于 0');
        if (num <= 0) throw new Error('数量必须大于 0');
        if (!Number.isInteger(num) || num > 999) throw new Error('数量必须是 1~999 的整数');
        // 状态只接受已知值，避免导入出 999 这种没人认识的订单
        const status = row.status === undefined || row.status === '' ? 0 : Number(row.status);
        const payStatus = row.pay_status === undefined || row.pay_status === '' ? 0 : Number(row.pay_status);
        if (![0, 10, 20, 30, 40].includes(status)) throw new Error('订单状态无效（只能 0/10/20/30/40）');
        if (![0, 10].includes(payStatus)) throw new Error('支付状态无效（只能 0 或 10）');

        const type = Number(row.type) || 1;
        if (![1, 2, 3, 4, 5].includes(type)) throw new Error('订单类型无效');
        const no = orderNo('I');
        const info = run(
          `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
            type, price, num, total_price, status, pay_status, remark, create_time)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          no, m.member_id, g.member_id, g.goods_id, g.goods_name, g.good_thumb, g.specialarea_id,
          type, price, num, money(price * num), status, payStatus,
          row.remark || '后台导入', now(),
        );
        okCount++;
        created.push({ order_no: no, order_id: Number(info.lastInsertRowid) });
      } catch (e) {
        errors.push({ row: i + 1, msg: e.message });
      }
    });
  });

  res.json(
    ok({ okCount, failCount: errors.length, errors, created },
      `导入完成：成功 ${okCount} 条，失败 ${errors.length} 条`),
  );
});

/** 会员团队订单视图 */
r.get('/member/team-orders', authAdmin, (req, res) => {
  const mid = Number(req.query.member_id);
  const m = get('SELECT * FROM member WHERE member_id = ?', mid);
  if (!m) return res.json(fail('会员不存在'));

  const teamIds = all('SELECT member_id FROM member WHERE path LIKE ?', `%/${mid}/%`).map((x) => x.member_id);
  if (!teamIds.length) {
    return res.json(ok({ member: m.nick_name, team_count: 0, order_count: 0, stats: {}, list: [] }));
  }

  const ph = teamIds.map(() => '?').join(',');
  const rows = all(
    `SELECT o.*, m.nick_name, m.mobile
     FROM orders o LEFT JOIN member m ON m.member_id = o.member_id
     WHERE o.member_id IN (${ph}) ORDER BY o.order_id DESC LIMIT 300`,
    ...teamIds,
  );
  const paid = rows.filter((x) => x.pay_status === 10);
  const sum = (arr, f) => money(arr.reduce((s, x) => s + Number(x[f] || 0), 0));

  res.json(
    ok({
      member: m.nick_name,
      team_count: teamIds.length,
      order_count: rows.length,
      stats: {
        total_amount: sum(rows, 'total_price'),
        paid_amount: sum(paid, 'total_price'),
        listing_fee: sum(rows, 'listing_fee'),
        unpaid_count: rows.filter((x) => x.pay_status === 0).length,
      },
      list: rows.map((x) => ({
        order_id: x.order_id,
        order_no: x.order_no,
        goods_name: x.goods_name,
        member_id: x.member_id,
        nick_name: x.nick_name || '—',
        mobile: x.mobile || '',
        total_price: Number(x.total_price).toFixed(2),
        type: x.type,
        status_text: ORDER_STATUS[x.status] || '',
        pay_status: x.pay_status,
        create_time: x.create_time,
      })),
    }),
  );
});

/** 后台创建寄买订单 */
r.post('/orders/set-goods-order', authAdmin, (req, res) => {
  const { goods_id, member_id, price, remark } = req.body || {};
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goods_id));
  if (!g) return res.json(fail('商品不存在'));
  const m = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!m) return res.json(fail('会员不存在'));
  const p = Number(price) || Number(g.goods_min_price);
  if (p <= 0) return res.json(fail('价格必须大于 0'));

  const no = orderNo('J');
  const info = run(
    `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
      type, price, num, total_price, status, pay_status, remark, create_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    no, m.member_id, g.member_id, g.goods_id, g.goods_name, g.good_thumb, g.specialarea_id,
    4, p, 1, p, 0, 0, remark || `后台创建寄买单（${m.nick_name}）`, now(),
  );
  res.json(ok({ order_id: Number(info.lastInsertRowid), order_no: no }, '寄买订单已创建'));
});

// ---------------- 后台补充接口结束 ----------------

// ---------------- 权限节点 ----------------
r.get('/node/tree', authAdmin, (req, res) => {
  // 兼容旧字段名，值取第一个超管角色；实际判定一律走 is_super 标记
  res.json(ok({ tree: nodeTree(), super_role_id: superRoleIds()[0] || 0 }));
});

r.get('/role/nodes', authAdmin, (req, res) => {
  const roleId = Number(req.query.role_id);
  if (!roleId) return res.json(fail('请指定角色'));
  res.json(ok({ role_id: roleId, node_ids: roleNodeIds(roleId) }));
});

r.post('/role/nodes', authAdmin, (req, res) => {
  const { role_id, node_ids } = req.body || {};
  const role = get('SELECT * FROM store_role WHERE role_id = ?', Number(role_id));
  if (!role) return res.json(fail('角色不存在'));
  if (isSuperRole(role_id)) return res.json(fail('超级管理员默认拥有全部权限，无需配置'));
  saveRoleNodes(Number(role_id), node_ids || []);
  res.json(ok([], '权限已保存'));
});

/** 当前登录管理员可访问的路由（前端菜单过滤用） */
r.get('/my-paths', authAdmin, (req, res) => {
  const paths = rolePaths(req.admin.role_id);
  res.json(ok({ role_id: req.admin.role_id, unrestricted: paths === null, paths: paths || [] }));
});



/** 当前登录管理员可见的菜单树（含图标，权限已在服务端过滤） */
r.get('/menu', authAdmin, (req, res) => {
  const paths = rolePaths(req.admin.role_id);
  const menus = MENU.map((g) => ({
    label: g.label,
    items: g.items
      .filter((i) => paths === null || paths.includes(i.path))
      .map((i) => ({ path: i.path, title: i.title, icon: i.icon })),
  })).filter((g) => g.items.length > 0);
  res.json(ok({ menus }));
});

// ---------------- 运维 ----------------
r.post('/cache/clear', authAdmin, (req, res) => {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA optimize');
  } catch (e) {
    return res.json(fail(e.message));
  }
  res.json(ok([], '缓存已清理'));
});

/** 系统信息 */
r.get('/sysinfo', authAdmin, (req, res) => {
  const size = (t) => get(`SELECT COUNT(*) c FROM ${t}`)?.c || 0;
  res.json(
    ok({
      node: process.version,
      uptime_hours: Math.round(process.uptime() / 3600 * 10) / 10,
      db_size_kb: Math.round(
        (get("SELECT page_count * page_size v FROM pragma_page_count(), pragma_page_size()")?.v || 0) / 1024,
      ),
      counts: {
        member: size('member'),
        goods: size('goods'),
        orders: size('orders'),
      },
    }),
  );
});

export default r;
