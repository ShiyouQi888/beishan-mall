// 场次时间窗口：每个场次各有一套「周几 + 每日时段」
//
// 一次判定同时被三处使用（场次列表的 can-buy 标记、商品详情、下单校验），
// 所以必须只有一份实现——之前这套逻辑散在两处各写一遍，改一处就会走偏。
//
// 时区：业务时间一律按东八区（UTC+8）算，**不看服务器本地时区**。
// 因为 start_time 存的是「北京时间 08:00 = 28800 秒」这种**当地墙上时间**，
// 一旦服务器跑在 UTC（Docker 容器默认就是 UTC），用 setHours(0,0,0,0) 取到的
// 是 UTC 零点，08:00 就被解释成北京 16:00 —— 上午场明明在开放，前台却显示
// 「未开始 · 距开始 5 小时」，倒计时指向 16:00。所有「今天 / 现在」的判断
// 都必须走这里，不要在别处再写一套本地时间。
const BIZ_OFFSET_MIN = 480; // 东八区
const BIZ_OFFSET_SEC = BIZ_OFFSET_MIN * 60;

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const pad2 = (n) => String(n).padStart(2, '0');

/** 把真实时刻平移成「业务时区」的日历值：之后一律用 getUTC* 读，跟服务器时区彻底无关 */
function bizDate(d = new Date()) {
  return new Date(d.getTime() + BIZ_OFFSET_MIN * 60000);
}

/** 本地日期 YYYY-MM-DD，按东八区算（不能用 toISOString，那是 UTC，早八点前会差一天） */
export function todayStr(d = new Date()) {
  const b = bizDate(d);
  return `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}`;
}

/** 日期字符串 + n 天（纯日历算术，不碰任何时区） */
export function addDays(dateStr, n = 1) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1) + n * 86400000;
  const b = new Date(t);
  return `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}`;
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

  const b = bizDate(now);
  const jsDay = b.getUTCDay();
  const today = jsDay === 0 ? 7 : jsDay;
  // 业务时区当天 00:00 对应的真实 epoch（北京零点 = UTC 前一天 16:00）
  const dayStart = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) / 1000 - BIZ_OFFSET_SEC;
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

