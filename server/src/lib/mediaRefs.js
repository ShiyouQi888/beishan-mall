// 素材引用检查：文件管理（删除保护）与数据清除（只删没人用的图）共用一套判断
import { db, all } from '../db.js';

/** 把各种形态的地址统一成 /uploads/xxx.png */
export function normPath(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  const abs = s.match(/^https?:\/\/[^/]+(\/.*)$/i);
  if (abs) s = abs[1];
  if (s.includes('?') || s.includes('#')) s = s.split(/[?#]/)[0];
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

// 从任意文本里抠出图片地址：富文本 <img src>、JSON 数组、纯路径都能认。
// 不能只按 JSON 解析 —— 商品详情是一段 HTML，按 JSON 解会漏。
const PATH_RE = /\/uploads\/[^\s"'<>()\\?#]+/g;

/** 哪些表/列可能存图片地址（detail 与 detail_images 也要算，否则详情里正在用的图会被当成垃圾） */
const IMAGE_COLUMNS = {
  goods: ['good_thumb', 'images', 'detail', 'detail_images'],
  goods_category: ['image'],
  specialarea: ['image_ordinary', 'image_intro'],
  shop_banner: ['file_path'],
  shop_navigation: ['file_path'],
  setting_config: ['value'],
  orders: ['goods_thumb', 'pay_voucher'],
  member: ['avatar_url'],
  store_user: ['avatar'],
  member_certification: ['front_image', 'back_image', 'hand_image'],
  goods_recycle: ['good_thumb'],
};

/**
 * 一次性收集全库被引用的图片地址。
 * 为什么不复用 usagesOf：那个是「一个文件查 10 次表」，几百个素材就是几千次查询，
 * 数据一多页面就卡。这里按表扫一遍，十几条 SQL 搞定。
 */
export function referencedPathSet() {
  const set = new Set();
  const scan = (value) => {
    const s = String(value || '');
    if (!s.includes('/uploads/')) return;
    for (const m of s.match(PATH_RE) || []) set.add(normPath(m));
  };
  for (const [table, cols] of Object.entries(IMAGE_COLUMNS)) {
    let exists;
    try {
      exists = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    } catch {
      continue; // 老库里没有这张表就跳过
    }
    const use = cols.filter((c) => exists.has(c));
    if (!use.length) continue;
    for (const row of all(`SELECT ${use.join(', ')} FROM ${table}`)) {
      for (const c of use) scan(row[c]);
    }
  }
  return set;
}

/** 这个文件正被谁用着（返回人类可读的用途列表，空数组表示没人用） */
export function usagesOf(path) {
  const out = [];
  const push = (list, fmt) => list.slice(0, 2).forEach((x) => out.push(fmt(x)));
  push(all('SELECT goods_name FROM goods WHERE good_thumb = ? OR images LIKE ? LIMIT 2', path, `%${path}%`), (x) => `商品「${x.goods_name}」`);
  // 商品详情正文与详情长图里也可能引用着这张图
  push(
    all('SELECT goods_name FROM goods WHERE detail LIKE ? OR IFNULL(detail_images, \'\') LIKE ? LIMIT 2', `%${path}%`, `%${path}%`),
    (x) => `商品详情「${x.goods_name}」`,
  );
  push(all('SELECT name FROM goods_category WHERE image = ? LIMIT 2', path), (x) => `分类「${x.name}」`);
  push(all('SELECT title_main FROM specialarea WHERE image_ordinary = ? OR image_intro = ? LIMIT 2', path, path), (x) => `场次「${x.title_main}」`);
  push(all('SELECT banner_id FROM shop_banner WHERE file_path = ? LIMIT 2', path), (x) => `广告 #${x.banner_id}`);
  push(all('SELECT title FROM shop_navigation WHERE file_path = ? LIMIT 2', path), (x) => `导航「${x.title}」`);
  push(all('SELECT `key` FROM setting_config WHERE `value` = ? LIMIT 2', path), (x) => `系统设置「${x.key}」`);
  push(all('SELECT order_no FROM orders WHERE goods_thumb = ? OR pay_voucher = ? LIMIT 2', path, path), (x) => `订单 ${x.order_no}`);
  push(all('SELECT nick_name FROM member WHERE avatar_url = ? LIMIT 2', path), (x) => `会员「${x.nick_name}」`);
  push(all('SELECT nick_name FROM store_user WHERE avatar = ? LIMIT 2', path), (x) => `管理员「${x.nick_name}」`);
  push(all('SELECT real_name FROM member_certification WHERE front_image = ? OR back_image = ? OR hand_image = ? LIMIT 2', path, path, path), (x) => `实名认证「${x.real_name}」`);
  return out;
}
