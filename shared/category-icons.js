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
  { key: 'produce', label: '农副产品', markup: '<path d="M4 20h16M7 20v-4.5l5-2.5 5 2.5V20M12 13V5"/><path d="M12 8C8.8 8 6.5 6.3 6.5 3.8 10 3.8 12 5.2 12 8ZM12 7.5c0-2.8 1.9-4.8 5.5-4.8 0 3-2.1 4.8-5.5 4.8Z"/>' },
  { key: 'fruit', label: '水果鲜品', markup: '<path d="M12 8c-1.6-1.7-4.5-1.9-6.2-.2-2.7 2.7-.7 9.7 2.2 11.6 1.5 1 2.5-.4 4-.4s2.5 1.4 4 .4c2.9-1.9 4.9-8.9 2.2-11.6C16.5 6.1 13.6 6.3 12 8Z"/><path d="M12 7.8c-.1-2 1-3.8 3.7-4.8M12.2 6.5c1.2-1.4 2.6-1.9 4.1-1.8"/>' },
  { key: 'vegetable', label: '蔬菜菌菇', markup: '<path d="M12 20 7.2 11.5 12 9l4.8 2.5L12 20Z"/><path d="M12 9c-3.8 0-6.4-2.2-6.4-5.4C9.5 3.6 12 5.6 12 9ZM12 8.4c0-3 2.1-5.3 6.2-5.3 0 3.4-2.4 5.3-6.2 5.3ZM9.8 16h4.4"/>' },
  { key: 'grain', label: '粮油米面', markup: '<path d="M7 21c5-4.5 8-10 9-18M9 17l-3-2M11 13l-3-2M13 9l-3-2M15 6l-2.5-2"/><path d="M14 16l3-2M15.5 12.5l3-2M16.5 9l3-2"/>' },
  { key: 'meat', label: '肉禽蛋品', markup: '<path d="M12 21c-4.3 0-7-3-7-7.2 0-4.6 3-8.8 7-8.8s7 4.2 7 8.8c0 4.2-2.7 7.2-7 7.2Z"/><path d="M9 12.5c.7-1.4 1.7-2.1 3-2.1s2.3.7 3 2.1M10 16h4"/>' },
  { key: 'seafood', label: '水产海鲜', markup: '<path d="M3 12s3.2-5.5 9-5.5 9 5.5 9 5.5-3.2 5.5-9 5.5S3 12 3 12Z"/><path d="m3.5 12-2-3v6l2-3ZM13.5 10h.01M16.5 10h.01M12 14c1.4 1.2 2.8 1.2 4.2 0"/>' },
  { key: 'tea', label: '茶叶饮品', markup: '<path d="M4 10h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-5ZM17 12h1.5a2.5 2.5 0 0 1 0 5H17M3 21h16"/><path d="M9 8c-1.8-1.7-.6-3.2.2-4M13 8c-1.8-1.7-.6-3.2.2-4"/>' },
  { key: 'honey', label: '蜂蜜滋补', markup: '<path d="M9 3.5h6M10 3.5v3l-4.5 5v7A2.5 2.5 0 0 0 8 21h8a2.5 2.5 0 0 0 2.5-2.5v-7L14 6.5v-3"/><path d="M6.5 12h11M9 15.5c1.8-1.5 4.2-1.5 6 0M12 14v4"/>' },
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
  if (/水果|鲜果|果品/.test(value)) return 'fruit';
  if (/蔬菜|菌菇|食用菌/.test(value)) return 'vegetable';
  if (/粮油|米面|杂粮|谷物|粮食/.test(value)) return 'grain';
  if (/肉禽|肉类|禽蛋|畜禽|蛋品|鸡蛋|鸭蛋/.test(value)) return 'meat';
  if (/水产|海产|海鲜|鱼虾|虾蟹|海味/.test(value)) return 'seafood';
  if (/茶叶|名茶|茶品|茶饮|饮品/.test(value)) return 'tea';
  if (/蜂蜜|蜂产品|滋补/.test(value)) return 'honey';
  if (/农产品|农副|生鲜|果蔬|特产|山货/.test(value)) return 'produce';
  return 'all';
}
