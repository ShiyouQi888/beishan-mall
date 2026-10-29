// 商品拆分 & 流拍（推断实现，依据见 docs/streambeat-split-inference.md）
import { all, get, run, tx, now } from '../db.js';

const money2 = (n) => Number(Number(n).toFixed(2));

/**
 * 商品按份拆分
 * - 把一件商品拆成 N 份挂牌，每份独立成交
 * - 每份价格 = 商品价 / N（向下取整到分，差额留在平台侧不计息）
 * - 划线价（市场价）同步按份折算，保持「市场价 : 现价」的比例
 */
export function splitGoods(goodsId, parts, operatorId = 0) {
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(goodsId));
  if (!g) return { ok: false, reason: '商品不存在' };
  if (g.type !== 1) return { ok: false, reason: '仅抢购商品支持拆分' };
  if (g.is_split === 1) return { ok: false, reason: '该商品已拆分，不可重复拆分' };
  if (operatorId && g.member_id !== operatorId) return { ok: false, reason: '您不是该商品持有人' };
  if (g.goods_status !== 10) return { ok: false, reason: '商品未在售，无法拆分' };

  const n = Number(parts);
  if (!n || n < 2) return { ok: false, reason: '拆分份数至少为 2 份' };
  if (n > 1000) return { ok: false, reason: '单件商品最多拆分为 1000 份' };

  const total = Number(g.goods_min_price);
  if (total <= 0) return { ok: false, reason: '商品价格异常' };

  const perPart = Math.floor((total * 100) / n) / 100;
  if (perPart <= 0) return { ok: false, reason: '拆分份数过多，每份价格不足 0.01 元' };

  // 划线价按同比例折算；未设置划线价则保持 0
  const oldLine = Number(g.line_price || 0);
  const perLine = oldLine > 0 ? Math.floor((oldLine * 100) / n) / 100 : 0;

  run(
    `UPDATE goods SET is_split = 1, split_total = ?, stock_num = ?, goods_min_price = ?, line_price = ?, update_time = ?
     WHERE goods_id = ?`,
    n, n, perPart, perLine, now(), g.goods_id,
  );

  return {
    ok: true,
    goods_id: g.goods_id,
    parts: n,
    per_part: perPart,
    per_line_price: perLine,
    original_price: total,
    original_line_price: oldLine,
    split_total_price: money2(perPart * n),
    diff: money2(total - perPart * n),
  };
}

/** 下单时扣减拆分库存（事务内调用，原子操作） */
export function deductStock(goodsId, num) {
  const r = run(
    'UPDATE goods SET stock_num = stock_num - ? WHERE goods_id = ? AND stock_num >= ?',
    Number(num), Number(goodsId), Number(num),
  );
  if (Number(r.changes) !== 1) return false;
  // 售罄自动下架
  const g = get('SELECT stock_num FROM goods WHERE goods_id = ?', Number(goodsId));
  if (g && Number(g.stock_num) <= 0) {
    run("UPDATE goods SET goods_status = 20 WHERE goods_id = ? AND is_split = 1", Number(goodsId));
  }
  return true;
}

/**
 * 扫描流拍：场次结束后仍未被购买的寄售挂单
 * @param {number} specialareaId 场次（0=全部）
 * @param {string} date 日期 YYYY-MM-DD
 */
export function scanStreambeat(specialareaId = 0, date = '') {
  const day = date || now().slice(0, 10);
  // 挂单台账不再单独成单，改为从「原抢购订单 + 商品」推导：
  //   consignment_status = 10  该订单已转拍挂出
  //   g.member_id = o.member_id 商品仍归转拍人（没被下一位买走）
  //   g.goods_status = 10       商品仍在架（没被标记过流拍/下架）
  const where = [
    'o.consignment_status = 10',
    'o.type = 1',
    'o.status IN (10, 30)',
    'g.member_id = o.member_id',
    'g.goods_status = 10',
  ];
  const args = [];
  if (specialareaId) {
    where.push('o.specialarea_id = ?');
    args.push(Number(specialareaId));
  }
  const pending = all(
    `SELECT o.*, g.goods_min_price AS list_price FROM orders o JOIN goods g ON g.goods_id = o.goods_id
     WHERE ${where.join(' AND ')} AND IFNULL(o.transposition_time, o.create_time) <= ?`,
    ...args, `${day} 23:59:59`,
  );

  let count = 0;
  const details = [];
  tx(() => {
    for (const o of pending) {
      // 流拍记录里的金额记「流拍时的挂牌价」——平台回收就按这个价收回
      const listPrice = money2(Number(o.list_price) || Number(o.total_price) || 0);
      // 生成流拍记录（type=5 是流拍台账，不动原订单的履约状态）
      run(
        `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
          type, price, num, total_price, status, pay_status, remark, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `L${o.order_no}`, o.member_id, o.member_id, o.goods_id, o.goods_name, o.goods_thumb,
        o.specialarea_id, 5, listPrice, 1, listPrice, 50, 0,
        `流拍：${day} 场次结束未成交（原订单 ${o.order_no}，挂牌价 ${listPrice}）`, now(),
      );
      // 关闭该次挂单，避免重复扫描；同时商品下架为流拍态
      run('UPDATE orders SET consignment_status = 0 WHERE order_id = ?', o.order_id);
      run('UPDATE goods SET goods_status = 30, update_time = ? WHERE goods_id = ?', now(), o.goods_id);
      count++;
      details.push({ goods_id: o.goods_id, goods_name: o.goods_name, owner: o.member_id });
    }
  });

  return { ok: true, count, details, date: day };
}

/** 释放流拍：商品恢复可售，供持有人重新上架 */
export function releaseStreambeat(orderId) {
  const o = get('SELECT * FROM orders WHERE order_id = ? AND type = 5', Number(orderId));
  if (!o) return { ok: false, reason: '流拍记录不存在' };
  if (o.status === 60) return { ok: false, reason: '该流拍记录已释放' };

  tx(() => {
    run('UPDATE orders SET status = 60 WHERE order_id = ?', o.order_id);
    // 商品恢复可售即可；挂单状态在流拍时已归零，持有人可重新转拍
    run('UPDATE goods SET goods_status = 10, update_time = ? WHERE goods_id = ?', now(), o.goods_id);
  });

  return { ok: true, goods_id: o.goods_id };
}

/**
 * 平台回收：流拍商品由平台按「当前挂牌价」收回
 * - 按挂牌价给持有人打款，记一条资金流水
 * - 商品转为平台持仓（member_id = 0），下架；后台可再改回上架进入下一轮
 * - 流拍单置 70（已回收），防止重复回收
 * @returns {{ok:boolean, reason?:string, price?:number, goods_id?:number}}
 */
export function recycleStreambeat(orderId) {
  const o = get('SELECT * FROM orders WHERE order_id = ? AND type = 5', Number(orderId));
  if (!o) return { ok: false, reason: '流拍记录不存在' };
  if (o.status === 60) return { ok: false, reason: '该流拍记录已释放，无需回收' };
  if (o.status === 70) return { ok: false, reason: '该流拍商品已被平台回收' };

  const g = get('SELECT * FROM goods WHERE goods_id = ?', o.goods_id);
  if (!g) return { ok: false, reason: '商品不存在' };
  if (g.member_id !== o.member_id) return { ok: false, reason: '商品已不在原持有人名下，无法回收' };

  // 按当前挂牌价回收（含历次涨价）
  const price = money2(Number(g.goods_min_price) || 0);
  if (price <= 0) return { ok: false, reason: '商品挂牌价无效，无法回收' };

  tx(() => {
    run('UPDATE member SET amount = amount + ? WHERE member_id = ?', price, o.member_id);
    run(
      'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      o.member_id, price, 2, '平台回收', `流拍商品 ${g.goods_name} 由平台按挂牌价回收`, now(),
    );
    // 商品转平台持仓：持有人置 0、下架。后台把状态改回上架即可重新进入场次
    run(
      'UPDATE goods SET member_id = 0, goods_status = 20, is_sell = 0, update_time = ? WHERE goods_id = ?',
      now(), g.goods_id,
    );
    run('UPDATE orders SET status = 70 WHERE order_id = ?', o.order_id);
  });

  return { ok: true, goods_id: g.goods_id, price, owner: o.member_id };
}
