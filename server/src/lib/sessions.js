// 抢购场次的「规范顺序」
//
// 之前场次列表直接 ORDER BY sort ASC，而 sort 值是运营手填的：
// 演示数据里 晚间=80、下午=90、上午=100，于是抢购页排成了「晚上、下午、上午」。
// 这里统一成一条规则，列表页、H5 抢购页、转拍进下一场都用它，避免各处各排一套。
//
// 排序键（依次比较）：
//   1. 还在开放中的排前面，已结束的沉到后面
//   2. 各场次自己的开始时间（秒）
//   3. 场次标识的语义顺序：forenoon(上午) → afternoon(下午) → evening(晚上)
//   4. 后台手填的 sort 值
//   5. id
import { all } from '../db.js';
import { todayStr, addDays } from './sessionWindow.js';

const NAME_RANK = { forenoon: 1, afternoon: 2, evening: 3 };

// 三态权重：进行中 → 未开始 → 已结束 → 今天不开放
const STATE_RANK = { open: 0, upcoming: 1, ended: 2, closed: 3 };

/**
 * 场次排序
 * @param {Array} list 场次行
 * @param {(s) => {state: string}} stateOf 取每个场次此刻的状态（来自 lib/sessionWindow）
 */
function orderSessions(list, stateOf = () => ({ state: 'open' })) {
  return [...list].sort((a, b) => {
    const ra0 = STATE_RANK[stateOf(a).state] ?? 0;
    const rb0 = STATE_RANK[stateOf(b).state] ?? 0;
    if (ra0 !== rb0) return ra0 - rb0;

    const sa = Number(a.start_time) || 0;
    const sb = Number(b.start_time) || 0;
    if (sa !== sb) return sa - sb;

    const ra = NAME_RANK[a.name] ?? 99;
    const rb = NAME_RANK[b.name] ?? 99;
    if (ra !== rb) return ra - rb;

    const ta = Number(a.sort) || 0;
    const tb = Number(b.sort) || 0;
    if (ta !== tb) return ta - tb;

    return (Number(a.specialarea_id) || 0) - (Number(b.specialarea_id) || 0);
  });
}

/** 启用中的场次，已按规范顺序排好 */
export function activeSessions(stateOf) {
  return orderSessions(all('SELECT * FROM specialarea WHERE is_open = 10'), stateOf);
}

/**
 * 下一场（含日期）：一天内的场次按顺序往后走，走到当天最后一场就顺延到第二天第一场。
 *
 * 之前只按 (idx+1) % length 环形轮转，不带日期，于是「晚上场转拍 → 落到今天上午场」
 * 当天就能再被抢一次，商品总在同一天里打转。
 *
 * @param {number} currentId 当前所在场次
 * @param {string} baseDate  基准日期（商品原 area_date，空=今天）；不允许落在过去
 * @returns {{area_id:number, date:string}|null}
 */
export function nextSlot(currentId, baseDate = '') {
  const list = activeSessions();
  if (!list.length) return null;
  const today = todayStr();
  // 基准日不能早于今天：昨天被抢的商品今天才转拍，要从今天开始排
  const base = baseDate && baseDate >= today ? baseDate : today;
  const idx = list.findIndex((s) => Number(s.specialarea_id) === Number(currentId));
  if (idx >= 0 && idx < list.length - 1) {
    return { area_id: Number(list[idx + 1].specialarea_id), date: base };
  }
  // 当前已经是当天最后一场（或找不到当前场次）→ 明天第一场
  return { area_id: Number(list[0].specialarea_id), date: addDays(base, 1) };
}
