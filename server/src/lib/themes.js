// 外观主题：预设几套配色，后台选一套，H5 刷新即生效
//
// 主题本质就是一组 CSS 变量。H5 的样式已经基本走 var(--brand) 这一套令牌，
// 所以换主题不需要改组件，只要把这些变量写到 :root 上即可。
// 新增主题 = 在这里加一项，后台与前台自动出现，不用动其它地方。
const THEMES = [
  {
    key: 'coral',
    name: '珊瑚红',
    desc: '默认配色，综合类商城',
    vars: {
      '--brand': '#ff513a',
      '--brand-dark': '#e63c26',
      '--brand-light': '#ff6a4d',
      '--brand-soft': '#fff1ee',
      '--brand-rgb': '255, 81, 58',
      '--brand-hero-1': '#ff795d',
      '--brand-hero-2': '#f04c36',
      '--brand-hero-3': '#d83727',
      '--bg': '#f5f6f8',
      '--page-bg': '#e9edf2',
    },
  },
  {
    key: 'green',
    name: '绿色健康',
    desc: '农业 · 生鲜 · 健康食品方向',
    vars: {
      '--brand': '#2f9d5b',
      '--brand-dark': '#237a45',
      '--brand-light': '#4bb873',
      '--brand-soft': '#edf8f1',
      '--brand-rgb': '47, 157, 91',
      '--brand-hero-1': '#5cc98a',
      '--brand-hero-2': '#2f9d5b',
      '--brand-hero-3': '#1d6f41',
      '--bg': '#f4f8f5',
      '--page-bg': '#e6eee8',
    },
  },
  {
    key: 'ocean',
    name: '深海蓝',
    desc: '数码 · 商务方向',
    vars: {
      '--brand': '#2f6fed',
      '--brand-dark': '#1f52bd',
      '--brand-light': '#5a90f5',
      '--brand-soft': '#eef3ff',
      '--brand-rgb': '47, 111, 237',
      '--brand-hero-1': '#5a90f5',
      '--brand-hero-2': '#2f6fed',
      '--brand-hero-3': '#1c47a8',
      '--bg': '#f4f6fb',
      '--page-bg': '#e7ecf5',
    },
  },
];

export const DEFAULT_THEME = 'coral';

/** 按 key 取主题，不存在时回落到默认主题 */
export function themeOf(key) {
  return THEMES.find((t) => t.key === key) || THEMES.find((t) => t.key === DEFAULT_THEME) || THEMES[0];
}

/** 给后台选择器用的精简列表 */
export function themeOptions() {
  return THEMES.map((t) => ({
    key: t.key,
    name: t.name,
    desc: t.desc,
    preview: [t.vars['--brand'], t.vars['--brand-light'], t.vars['--brand-soft']],
  }));
}
