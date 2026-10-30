// 商品价格上限（金额围栏）
//
// 口径：
//   · 价格上限 price_cap 是一道「围栏」，任何一轮标价都不允许越过它（0 = 不限）
//   · 判定「到顶」不是等价格等于封顶价，而是看**下一轮涨幅会不会越界**：
//       当前价 1980、涨幅 3% → 下一轮 2039 > 封顶 2000 → 判定到顶，停止转拍
//     （如果非要等 2000 才停，最后一轮就已经 2039 越界了）
//   · 到顶后由平台按「持有人实际成交价」原价接盘结算（不额外加价，围栏内实际价为准）
//
// 涨价率为 0 时没有「下一轮」，退化为「当前价 ≥ 封顶价」即到顶。
import { money, priceIncreaseRate } from './helper.js';

const pct2 = (n) => Number(Number(n).toFixed(2));

/**
 * 计算一个商品的价格水位
 * @param {object} g goods 行（需要 goods_min_price / base_price / price_cap）
 * @param {number} [rate] 转拍涨价率（%），不传则读后台配置
 * @returns {{
 *   base_price:number, cap_price:number, current:number, headroom:number, next_price:number,
 *   pct:number, ratio:number, reached:boolean, level:'none'|'green'|'yellow'|'orange'|'red'
 * }}
 */
export function priceCapOf(g, rate = priceIncreaseRate()) {
  const base = Number(g?.base_price) > 0
    ? Number(g.base_price)
    : Number(g?.goods_min_price) || 0;   // 老数据没基准价时退化为当前价
  const cap = Math.max(0, Number(g?.price_cap) || 0);
  const current = Number(g?.goods_min_price) || 0;
  const rateNum = Math.max(0, Number(rate) || 0);

  // 累计涨幅（相对基准价），只用于展示「已经涨了多少」
  const pct = base > 0 ? ((current - base) / base) * 100 : 0;
  // 下一轮按配置涨幅算出来的价（不削顶），用于判断围栏
  const nextRaw = money(current * (1 + rateNum / 100));

  // 到顶判定：
  //   涨价率 > 0 → 下一轮会越过围栏（或已经越过）就到顶；
  //   涨价率 = 0 → 没有下一轮，只能按「当前价 ≥ 封顶价」判断。
  const reached = cap > 0 && (rateNum > 0
    ? nextRaw > cap + 0.004
    : current + 0.004 >= cap);

  // 水位 = 当前价在 [基准价, 封顶价] 区间里的位置
  // 已达上限时直接拉满：封顶价可能只比基准价高一点点（比如 3600 / 3700），
  // 按区间算会得到 0%，白点停在最左边，和「已达上限」的红字自相矛盾。
  const span = cap > 0 ? cap - base : 0;
  let ratio = 0;
  if (cap > 0) {
    if (reached) ratio = 1;
    else ratio = span > 0 ? Math.min(1, Math.max(0, (current - base) / span)) : 0;
  }

  let level = 'none';
  if (cap > 0) {
    if (reached) level = 'red';
    else if (ratio >= 0.7) level = 'orange';
    else if (ratio >= 0.35) level = 'yellow';
    else level = 'green';
  }

  return {
    base_price: money(base),
    cap_price: money(cap),
    current: money(current),
    next_price: nextRaw,
    // 当前价距离围栏还有多少（到顶后为 0）
    headroom: cap > 0 ? money(Math.max(0, cap - current)) : 0,
    pct: pct2(pct),
    ratio: Number(ratio.toFixed(4)),
    reached,
    level,
  };
}

/**
 * 下一轮标价：按涨幅算出后仍要保证不越过围栏（正常情况下 reached 已先拦下，
 * 这里只是兜底，避免手工改价/改配置留下越界的口子）。
 */
export function clampToCap(price, cap) {
  const p = money(price);
  if (!cap || !(cap.cap_price > 0)) return p;
  return money(Math.min(p, cap.cap_price));
}
