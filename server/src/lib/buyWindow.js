// 抢购总时间：全站统一的一段开放时间，所有场次共用
//
// 为什么单独抽出来：判断「现在能不能抢」原来散落在两处
// （goods.js 算场次卡片状态、order.js 下单时再校验一遍），
// 两边各写一份时间逻辑，早晚会走偏。现在统一从这里取。
//
// 配置项（后台「交易设置」）：
//   buy_open_days   周一~周日，逗号分隔（1=周一 … 7=周日），空 = 每天
//   buy_start_time  每日开始（秒），0 = 00:00
//   buy_end_time    每日结束（秒），0 = 不限时（当天剩下的时间都能抢）
import { get } from '../db.js';

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

const cfg = (key, fallback) => {
  const row = get('SELECT `value` FROM setting_config WHERE `key` = ?', key);
  return row ? String(row.value) : fallback;
};

/** 秒 → HH:MM */
export function hhmm(sec) {
  const n = Math.max(0, Number(sec) || 0);
  return `${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}`;
}

/** HH:MM → 秒（非法输入返回 0） */
export function toSec(text) {
  const m = String(text || '').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return 0;
  return Math.min(86399, Number(m[1]) * 3600 + Number(m[2]) * 60);
}

/**
 * 取当前生效的抢购时间窗口
 * @param {Date} [now]
 * @returns {{days:number[],start:number,end:number,dayOk:boolean,timeOk:boolean,open:boolean,
 *            dayStart:number,nowSec:number,startText:string,endText:string,text:string,daysText:string}}
 */
export function buyWindow(now = new Date()) {
  const days = String(cfg('buy_open_days', '1,2,3,4,5,6,7'))
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => n >= 1 && n <= 7);
  const start = Number(cfg('buy_start_time', '0')) || 0;
  const end = Number(cfg('buy_end_time', '0')) || 0;

  const jsDay = now.getDay();
  const today = jsDay === 0 ? 7 : jsDay;
  const dayStart = new Date(now).setHours(0, 0, 0, 0) / 1000;
  const nowSec = Math.floor(now.getTime() / 1000);

  const dayOk = days.length === 0 || days.includes(today);
  const timeOk = !end || (nowSec >= dayStart + start && nowSec <= dayStart + end);
  const daysText = days.length === 0 || days.length === 7
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
    open: dayOk && timeOk,
    startText: hhmm(start),
    endText: end ? hhmm(end) : '',
    text: end ? `${hhmm(start)}-${hhmm(end)}` : `${hhmm(start)} 起（不限结束）`,
    daysText,
  };
}
