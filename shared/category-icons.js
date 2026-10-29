export const CATEGORY_ICON_PREFIX = 'icon:';

export const CATEGORY_ICONS = [
  { key: 'jewelry', label: '珠宝首饰', markup: '<circle cx="12" cy="8.5" r="5.5"/><path d="m8.8 13.2 3.2 7.3 3.2-7.3M9.2 5.1l2.8 3.4 2.8-3.4"/>' },
  { key: 'gem', label: '翡翠玉器', markup: '<path d="m12 3 7.5 5-2 9L12 21l-7.5-4.5-2-9L12 3Z"/><path d="m4.5 8 7.5 5 7.5-5M12 13v8"/>' },
  { key: 'watch', label: '名表腕表', markup: '<circle cx="12" cy="12" r="7.2"/><path d="M9 2.5h6M9 21.5h6M12 8v4l2.7 1.7"/>' },
  { key: 'bag', label: '箱包皮具', markup: '<path d="M5 9h14l1 11H4L5 9Z"/><path d="M8.5 9V6.5a3.5 3.5 0 0 1 7 0V9M9 13h.01M15 13h.01"/>' },
  { key: 'fashion', label: '服饰鞋履', markup: '<path d="m8 4 4 2 4-2 4 3-2 4-2-1v10H8V10l-2 1-2-4 4-3Z"/><path d="M9 8h6"/>' },
  { key: 'craft', label: '文玩工艺', markup: '<path d="M8 3h8l-1 4 3 3v8l-6 3-6-3v-8l3-3-1-4Z"/><path d="M8 7h8M7 11h10M9 15h6"/>' },
  { key: 'beauty', label: '美妆护肤', markup: '<path d="M9 3h6v4H9zM8 7h8l1 13H7L8 7Z"/><path d="M10 11h4M10 15h4"/>' },
  { key: 'home', label: '家居生活', markup: '<path d="m3 11 9-7 9 7v9h-6v-6H9v6H3v-9Z"/><path d="M8 10h.01M16 10h.01"/>' },
  { key: 'collectible', label: '收藏臻品', markup: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/><path d="m9.5 13 1.7 1.7 3.5-3.6"/>' },
  { key: 'gift', label: '礼品礼盒', markup: '<path d="M4 10h16v11H4zM3 7h18v4H3zM12 7v14"/><path d="M12 7H8.5a2.5 2.5 0 1 1 2.5-2.5V7ZM12 7h3.5A2.5 2.5 0 1 0 13 4.5V7Z"/>' },
  { key: 'all', label: '精选好物', markup: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>' },
];

export function categoryIconKey(value) {
  if (typeof value !== 'string') return '';
  let normalized = value;
  try { normalized = decodeURIComponent(value); } catch {}
  const marker = normalized.lastIndexOf(CATEGORY_ICON_PREFIX);
  if (marker < 0 || (marker > 0 && normalized[marker - 1] !== '/')) return '';
  const key = normalized.slice(marker + CATEGORY_ICON_PREFIX.length).split(/[/?#]/, 1)[0];
  return CATEGORY_ICONS.some((icon) => icon.key === key) ? key : '';
}

export function categoryIconValue(key) {
  return CATEGORY_ICONS.some((icon) => icon.key === key) ? `${CATEGORY_ICON_PREFIX}${key}` : '';
}

export function categoryIconDefinition(key) {
  return CATEGORY_ICONS.find((icon) => icon.key === key) || null;
}

export function defaultCategoryIconKey(name = '') {
  const value = String(name);
  if (/翡|玉|宝石/.test(value)) return 'gem';
  if (/首饰|珠宝|珍珠|饰品/.test(value)) return 'jewelry';
  if (/表|钟|数码|电器/.test(value)) return 'watch';
  if (/箱包|皮具/.test(value)) return 'bag';
  if (/服|鞋/.test(value)) return 'fashion';
  if (/文玩|工艺/.test(value)) return 'craft';
  if (/美妆|护肤/.test(value)) return 'beauty';
  if (/家居|生活/.test(value)) return 'home';
  if (/收藏|臻品/.test(value)) return 'collectible';
  if (/礼品|礼盒/.test(value)) return 'gift';
  return 'all';
}
