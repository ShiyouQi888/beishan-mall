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
 * 下一场：按规范顺序往后挪一格，到末尾回到第一场
 * 商品被抢走后转拍上架，就用它决定落到哪个场次
 */
export function nextSessionId(currentId) {
  const list = activeSessions();
  if (!list.length) return 0;
  const idx = list.findIndex((s) => Number(s.specialarea_id) === Number(currentId));
  if (idx < 0) return Number(list[0].specialarea_id);
  return Number(list[(idx + 1) % list.length].specialarea_id);
}
