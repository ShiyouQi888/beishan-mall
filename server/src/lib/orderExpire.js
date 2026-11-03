// 未确认订单超时关闭
//
// 抢购现在改成「提交订单即锁单」：唯一一件货被人下单后，别人就抢不了了。
// 所以必须有个兜底 —— 否则有人下一单不付款，这件货就被永久占着。
// 这个任务定期把「超过约定时间仍没付款」的订单关掉，商品名额同时释放。
//
// 只处理还没付款（status=0 且 pay_status=0）的抢购单与商城单：
// 寄买/寄卖单由运营手工处理，不在这里动。
import { all, get, run, now } from '../db.js';
import { cfg } from './helper.js';
import { restoreStock } from './stock.js';
import { sessionWindow } from './sessionWindow.js';

/** 支付时限（分钟），后台「交易设置」可改；默认 30，夹在 1 分钟到 24 小时之间 */
const payTimeoutMinutes = () =>
  Math.max(1, Math.min(1440, Number(cfg('order_pay_timeout', '30')) || 30));

/**
 * 把「当前时刻 − 时限」换算成和 create_time 同格式的字符串（东八区墙上时间）。
 * 不能直接把时间戳塞进 SQL 比较 —— create_time 存的是本地时间文本。
 */
function deadlineText(minutes) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - minutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * 扫描并关闭超时未支付订单
 * @param {number} [minutes] 覆盖配置的时限（测试用）
 */
export function expireUnpaidOrders(minutes = payTimeoutMinutes()) {
  const minutesNum = Math.max(1, Number(minutes) || 30);
  const line = deadlineText(minutesNum);

  const rows = all(
    `SELECT order_id, order_no, goods_id, member_id, num, specialarea_id
     FROM orders
     WHERE type IN (1, 3)
       AND IFNULL(status, 0) = 0
       AND IFNULL(pay_status, 0) = 0
       AND IFNULL(create_time, '') <> ''
       AND create_time < ?`,
    line,
  );

  const t = now();
  const closed = [];

  const nowEpoch = Math.floor(Date.now() / 1000);
  /** 这一单所在场次是否还没开场（提前抢购下的单属于这种） */
  const beforeAreaStart = (areaId) => {
    if (!areaId) return false;
    const area = get('SELECT * FROM specialarea WHERE specialarea_id = ?', Number(areaId));
    if (!area) return false;
    return sessionWindow(area, new Date()).startsAt > nowEpoch;
  };

  for (const o of rows) {
    // 提前抢购：会员在开抢前 N 分钟下的单，本来就是「先占住等开场」。
    // 按 create_time 算超时会在开场前就把它关掉、货重新放出 —— 提前抢等于白抢。
    // 这类单等场次真正开始后再按同样规则计时。
    if (beforeAreaStart(o.specialarea_id)) continue;
    // 原子关闭：期间用户刚好付了款就跳过，别把已支付的单关掉
    const r = run(
      'UPDATE orders SET status = 40 WHERE order_id = ? AND IFNULL(status, 0) = 0 AND IFNULL(pay_status, 0) = 0',
      o.order_id,
    );
    if (Number(r.changes) !== 1) continue;

    // 按件出售的商品下单时扣了名额，这里要还回去，否则名额会有去无回
    restoreStock(o.goods_id, o.num);

    run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
      o.order_id, '超时关闭', 'system', `超过 ${minutesNum} 分钟未确认，订单自动关闭，商品已释放`, t);

    const g = get('SELECT goods_name FROM goods WHERE goods_id = ?', o.goods_id);
    run('INSERT INTO member_msg (member_id, title, content, create_time) VALUES (?,?,?,?)',
      o.member_id, '订单已自动关闭',
      `「${g?.goods_name || '商品'}」的订单 ${o.order_no} 超过 ${minutesNum} 分钟未确认，已自动关闭，商品已重新放出。`, t);

    closed.push({ order_id: o.order_id, order_no: o.order_no, goods_id: o.goods_id });
  }

  return { scanned: rows.length, closed: closed.length, items: closed };
}
