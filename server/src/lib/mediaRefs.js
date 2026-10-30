// 素材引用检查：文件管理（删除保护）与数据清除（只删没人用的图）共用一套判断
import { all } from '../db.js';

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

/** 这个文件正被谁用着（返回人类可读的用途列表，空数组表示没人用） */
export function usagesOf(path) {
  const out = [];
  const push = (list, fmt) => list.slice(0, 2).forEach((x) => out.push(fmt(x)));
  push(all('SELECT goods_name FROM goods WHERE good_thumb = ? OR images LIKE ? LIMIT 2', path, `%${path}%`), (x) => `商品「${x.goods_name}」`);
  push(all('SELECT name FROM goods_category WHERE image = ? LIMIT 2', path), (x) => `分类「${x.name}」`);
  push(all('SELECT title_main FROM specialarea WHERE image_ordinary = ? OR image_intro = ? LIMIT 2', path, path), (x) => `场次「${x.title_main}」`);
  push(all('SELECT banner_id FROM shop_banner WHERE file_path = ? LIMIT 2', path), (x) => `广告 #${x.banner_id}`);
  push(all('SELECT title FROM shop_navigation WHERE file_path = ? LIMIT 2', path), (x) => `导航「${x.title}」`);
  push(all('SELECT `key` FROM setting_config WHERE `value` = ? LIMIT 2', path), (x) => `系统设置「${x.key}」`);
  push(all('SELECT order_no FROM orders WHERE goods_thumb = ? OR pay_voucher = ? LIMIT 2', path, path), (x) => `订单 ${x.order_no}`);
  push(all('SELECT nick_name FROM member WHERE avatar_url = ? LIMIT 2', path), (x) => `会员「${x.nick_name}」`);
  push(all('SELECT nick_name FROM store_user WHERE avatar = ? LIMIT 2', path), (x) => `管理员「${x.nick_name}」`);
  push(all('SELECT real_name FROM member_certification WHERE front_image = ? OR back_image = ? OR hand_image = ? LIMIT 2', path, path, path), (x) => `实名认证「${x.real_name}」`);
  push(all('SELECT match_id FROM settle_match WHERE voucher = ? LIMIT 2', path), (x) => `结算凭证 #${x.match_id}`);
  return out;
}
