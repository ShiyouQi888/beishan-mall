// 抢购场次的「规范顺序」
//
// 之前场次列表直接 ORDER BY sort ASC，而 sort 值是运营手填的：
// 演示数据里 晚间=80、下午=90、上午=100，于是抢购页排成了「晚上、下午、上午」。
// 这里统一成一条规则，列表页、H5 抢购页、转拍进下一场都用它，避免各处各排一套。
//
// 排序键（依次比较）：
//   1. 还在开放中的排前面，已结束的沉到后面
//   2. 各场次自己的开始时间（秒）
//   3. id（创建先后）
//
// 原来还比过两项：运营手填的 sort、以及场次标识 name（forenoon/afternoon/evening）。
// 两者都排在第 3、4 位，只有「开始时间完全相同」才轮得到，实际几乎永远不生效；
// 而 name 在后台根本不暴露（新建场次就是空串），等于用了一个运营改不了的字段决定顺序。
// 都已下线：场次先后只看开始时间，同一时间的按创建顺序。
import { all } from '../db.js';
import { todayStr, addDays, sessionWindow } from './sessionWindow.js';

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

    // 开始时间相同的场次按创建先后排（原来这里还比过 name 和手填 sort，两者都已下线）
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
 * 只按顺序取下一项还不够：下午 5 点从上午场转拍，顺序上的下一项是「下午场」，
 * 而下午场 13-17 点已经结束了 —— 货会落进一个今天再也开不了的场次，明天也不会自动跳出来。
 * 所以排在「今天」时还要看每个候选场次今天是否已经结束，跳过结束的、取第一个还能开的。
 *
 * @param {number} currentId 当前所在场次
 * @param {string} baseDate  基准日期（商品原 area_date，空=今天）；不允许落在过去
 * @param {Date}   at        以什么时刻来算「今天还剩哪些场」（默认现在）
 * @returns {{area_id:number, date:string}|null}
 */
export function nextSlot(currentId, baseDate = '', at = new Date()) {
  const list = activeSessions();
  if (!list.length) return null;
  const today = todayStr();
  // 基准日不能早于今天：昨天被抢的商品今天才转拍，要从今天开始排
  const base = baseDate && baseDate >= today ? baseDate : today;
  const idx = list.findIndex((s) => Number(s.specialarea_id) === Number(currentId));
  const after = idx >= 0 ? list.slice(idx + 1) : [...list];

  if (base === today) {
    // 今天：跳过已经结束（或今天不开放）的场次，落在第一个还能开的
    for (const s of after) {
      const w = sessionWindow(s, at);
      if (w.state === 'open' || w.state === 'upcoming') {
        return { area_id: Number(s.specialarea_id), date: base };
      }
    }
    return { area_id: Number(list[0].specialarea_id), date: addDays(base, 1) };
  }
  // 已经排到未来某天：按顺序取下一项即可，那天的时段还没到
  if (idx >= 0 && idx < list.length - 1) {
    return { area_id: Number(list[idx + 1].specialarea_id), date: base };
  }
  return { area_id: Number(list[0].specialarea_id), date: addDays(base, 1) };
}
