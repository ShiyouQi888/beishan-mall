// 后台补充接口：统计、会员操作、直推奖补发、指派订单、举报审核、缓存清理
import { Router } from 'express';
import { all, get, run, tx, now, today, db } from '../../db.js';
import { ok, fail, authAdmin, money, ORDER_STATUS } from '../../lib/helper.js';
import { distributeAward, driveAwardRate } from '../../lib/settle.js';
import { orderNo } from '../../lib/auth.js';
import { nodeTree, roleNodeIds, saveRoleNodes, rolePaths, SUPER_ROLE_ID } from '../../lib/nodes.js';
import { MENU } from '../../lib/menu.config.js';

const r = Router();

// ---------------- 统计 ----------------
/** 商品金额统计（对齐原站 getstatistics 的四个卡片） */
r.get('/stats/goods', authAdmin, (req, res) => {
  const type = Number(req.query.type) || 1; // 1抢购 2商城
  const amt = (extra) =>
    get(
      `SELECT IFNULL(SUM(goods_min_price * CASE WHEN is_split = 1 THEN stock_num ELSE 1 END), 0) v
       FROM goods WHERE type = ? AND ${extra}`,
      type,
    )?.v || 0;

  res.json(
    ok({
      total_amount: money(amt('1=1')),
      online_amount: money(amt('goods_status = 10')),
      offline_amount: money(amt('goods_status = 20')),
      pending_amount: money(amt('goods_status = 30')),
      total_count: get('SELECT COUNT(*) c FROM goods WHERE type = ?', type).c,
      online_count: get('SELECT COUNT(*) c FROM goods WHERE type = ? AND goods_status = 10', type).c,
      offline_count: get('SELECT COUNT(*) c FROM goods WHERE type = ? AND goods_status = 20', type).c,
      pending_count: get('SELECT COUNT(*) c FROM goods WHERE type = ? AND goods_status = 30', type).c,
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
  const { member_id, enable, count = 0 } = req.body || {};
  const m = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!m) return res.json(fail('会员不存在'));
  const on = enable ? 10 : 0;
  run(
    'UPDATE member SET is_advance = ?, advance_count = ?, advance_time = ? WHERE member_id = ?',
    on, Number(count) || 0, on ? Math.floor(Date.now() / 1000) : 0, m.member_id,
  );
  res.json(ok([], on ? '已开通提前抢购' : '已关闭提前抢购'));
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
 * 支持的删除前提：无订单、无资金流水、无提现、无下级、无地址/收款卡/实名/举报。
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
    const wd = cnt('SELECT COUNT(*) c FROM finance_withdraw WHERE member_id = ?', id);
    if (wd) reasons.push(`${wd} 笔提现`);
    const childs = cnt('SELECT COUNT(*) c FROM member WHERE p_id = ?', id);
    if (childs) reasons.push(`${childs} 个下级会员`);
    const addr = cnt('SELECT COUNT(*) c FROM member_address WHERE member_id = ?', id);
    if (addr) reasons.push(`${addr} 条收货地址`);
    const card = cnt('SELECT COUNT(*) c FROM member_card WHERE member_id = ?', id);
    if (card) reasons.push(`${card} 张收款卡`);
    const cert = cnt('SELECT COUNT(*) c FROM member_certification WHERE member_id = ?', id);
    if (cert) reasons.push('实名认证记录');
    const rep = cnt('SELECT COUNT(*) c FROM order_report WHERE member_id = ?', id);
    if (rep) reasons.push(`${rep} 条举报`);
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

r.get('/streambeat/members', authAdmin, (req, res) => {
  const kw = String(req.query.keyword || '').trim();
  const rows = kw
    ? all('SELECT member_id, nick_name, mobile, amount FROM member WHERE nick_name LIKE ? OR mobile LIKE ? LIMIT 50', `%${kw}%`, `%${kw}%`)
    : all('SELECT member_id, nick_name, mobile, amount FROM member ORDER BY member_id DESC LIMIT 50');
  res.json(ok(rows));
});

/** 把流拍/挂单商品指派给指定会员 */
r.post('/streambeat/assign', authAdmin, (req, res) => {
  const { order_id, member_id } = req.body || {};
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  const m = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!m) return res.json(fail('目标会员不存在'));
  if (!o.goods_id) return res.json(fail('该订单没有关联商品'));

  tx(() => {
    run('UPDATE goods SET member_id = ?, goods_status = 10, update_time = ? WHERE goods_id = ?',
      m.member_id, now(), o.goods_id);
    run('UPDATE orders SET member_id = ?, status = 30, finish_time = ?, remark = ? WHERE order_id = ?',
      m.member_id, now(), `后台指派给 ${m.nick_name}`, o.order_id);
    run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
      o.order_id, '指派订单', 'admin', `指派给 ${m.nick_name}（${m.mobile}）`, now());
  });
  res.json(ok([], `已指派给 ${m.nick_name}`));
});

// ---------------- 举报审核 ----------------
r.post('/report/audit', authAdmin, (req, res) => {
  const { report_id, pass, result } = req.body || {};
  const rp = get('SELECT * FROM order_report WHERE report_id = ?', Number(report_id));
  if (!rp) return res.json(fail('举报记录不存在'));
  run('UPDATE order_report SET status = ?, result = ? WHERE report_id = ?',
    pass ? 10 : 20, result || '', rp.report_id);
  res.json(ok([], pass ? '已处理' : '已驳回'));
});


// ---------------- 订单管理增强 ----------------
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

/** 后台拆分订单：把一笔订单按数量拆成多笔 */
r.post('/orders/split', authAdmin, (req, res) => {
  const { order_id, split_num } = req.body || {};
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  const n = Number(split_num) || 2;
  if (!Number.isInteger(n) || n < 2) return res.json(fail('拆分份数必须是不小于 2 的整数'));
  if (n > 100) return res.json(fail('单次最多拆 100 份'));
  if (Number(o.num) < n) return res.json(fail(`订单数量为 ${o.num}，无法拆成 ${n} 份`));
  if (o.pay_status === 10 && o.consignment_status === 10) {
    return res.json(fail('已转拍上架的订单不可拆分'));
  }

  const per = Math.floor(Number(o.num) / n);
  const remain = Number(o.num) - per * (n - 1);
  const price = Number(o.price);

  tx(() => {
    for (let i = 0; i < n - 1; i++) {
      run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
          type, price, num, total_price, status, pay_status, pay_type, remark, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        orderNo('S'), o.member_id, o.seller_id, o.goods_id, o.goods_name, o.goods_thumb, o.specialarea_id,
        o.type, price, per, money(price * per), o.status, o.pay_status, o.pay_type,
        `由订单 ${o.order_no} 拆分`, now(),
      );
    }
    run('UPDATE orders SET num = ?, total_price = ?, remark = ? WHERE order_id = ?',
      remain, money(price * remain), `原订单拆分为 ${n} 份（本单 ${remain} 件）`, o.order_id);
    run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
      o.order_id, '后台拆分', 'admin', `拆成 ${n} 份，每份 ${per} 件`, now());
  });

  res.json(ok({ parts: n, per }, `已拆分为 ${n} 笔订单（每份 ${per} 件）`));
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
  res.json(ok({ tree: nodeTree(), super_role_id: SUPER_ROLE_ID }));
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
  if (Number(role_id) === SUPER_ROLE_ID) return res.json(fail('超级管理员默认拥有全部权限，无需配置'));
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
        settle_batch: size('settle_batch'),
        report: size('order_report'),
      },
    }),
  );
});

export default r;
