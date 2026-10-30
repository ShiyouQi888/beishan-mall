// 场次时间窗口：每个场次各有一套「周几 + 每日时段」
//
// 一次判定同时被三处使用（场次列表的 can-buy 标记、商品详情、下单校验），
// 所以必须只有一份实现——之前这套逻辑散在两处各写一遍，改一处就会走偏。
const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，早八点前会差一天） */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期字符串 + n 天 */
export function addDays(dateStr, n = 1) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}

/** 秒 → HH:MM */
function hhmm(sec) {
  const n = Math.max(0, Number(sec) || 0);
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * 某个场次此刻是否开放
 * 规则：今天在 open_days 里，且当前时刻落在 [start_time, end_time] 内。
 * end_time = 0 视为「不限结束」，当天剩下的时间都能抢（沿用老语义）。
 * @param {object} area specialarea 行
 * @param {Date} [now]
 */
export function sessionWindow(area, now = new Date()) {
  const days = String(area?.open_days || '1,2,3,4,5,6,7')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => n >= 1 && n <= 7);
  const start = Number(area?.start_time) || 0;
  const end = Number(area?.end_time) || 0;

  const jsDay = now.getDay();
  const today = jsDay === 0 ? 7 : jsDay;
  const dayStart = new Date(now).setHours(0, 0, 0, 0) / 1000;
  const nowSec = Math.floor(now.getTime() / 1000);

  const dayOk = !days.length || days.includes(today);
  const startsAt = dayStart + start;
  const endsAt = end ? dayStart + end : dayStart + 86399;
  const timeOk = !end || (nowSec >= startsAt && nowSec <= endsAt);
  // 三态：进行中 / 未开始 / 已结束（今天不开放时按「未开始」处理，一起沉到后面）
  let state = 'open';
  if (!dayOk) state = 'closed';
  else if (!timeOk) state = nowSec < startsAt ? 'upcoming' : 'ended';
  const daysText = !days.length || days.length === 7
    ? '每天'
    : days.slice().sort((a, b) => a - b).map((d) => `周${DAY_NAMES[d - 1]}`).join(' ');

  return {
    days,
    start,
    end,
    today,
    dayStart,
    nowSec,
    dayOk,
    timeOk,
    state,
    open: state === 'open',
    startsAt,
    endsAt,
    startText: hhmm(start),
    endText: end ? hhmm(end) : '',
    text: end ? `${hhmm(start)}-${hhmm(end)}` : `${hhmm(start)} 起`,
    daysText,
  };
}

