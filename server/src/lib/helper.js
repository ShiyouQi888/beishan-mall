import { decode } from './auth.js';
import { get } from '../db.js';
import { rolePaths } from './nodes.js';

/** 统一响应：对齐原系统 { code, msg, data } */
export const ok = (data = [], msg = 'OK') => ({ code: 1, msg, data });
export const fail = (msg = '操作失败', code = 0, data = []) => ({ code, msg, data });

export function page(list, total, currentPage = 1, perPage = 15) {
  return {
    total,
    per_page: Number(perPage),
    current_page: Number(currentPage),
    last_page: Math.ceil(total / perPage) || 0,
    data: list,
  };
}

/** 从 header.token 或 Authorization 取会员身份 */
export function authMember(req, res, next) {
  const raw = req.headers.token || req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
  const payload = raw ? decode(raw) : null;
  if (!payload || payload.scope !== 'member') {
    return res.json(fail('请先登录', -1));
  }
  const m = get('SELECT * FROM member WHERE member_id = ?', payload.member_info);
  if (!m) return res.json(fail('账号不存在', -1));
  if (m.disabled !== 10) return res.json(fail('账号已被禁用', -1));
  req.member = m;
  next();
}

/** 后台身份 */
export function authAdmin(req, res, next) {
  const raw = req.headers.token || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = raw ? decode(raw) : null;
  if (!payload || payload.scope !== 'admin') {
    return res.status(401).json(fail('登录已失效，请重新登录', -1));
  }
  const u = get('SELECT * FROM store_user WHERE store_user_id = ?', payload.store_user_id);
  if (!u) return res.status(401).json(fail('账号不存在', -1));
  if (Number(u.status) !== 10) return res.status(401).json(fail('管理员账号已停用', -1));
  req.admin = u;
  const allowedPaths = rolePaths(u.role_id);
  if (allowedPaths !== null && !adminRequestAllowed(req, allowedPaths)) {
    return res.status(403).json(fail('当前角色无权执行此操作', 403));
  }
  next();
}

function adminRequestAllowed(req, allowedPaths) {
  const path = String(req.path || '').replace(/\/$/, '') || '/';
  const has = (...paths) => paths.some((p) => allowedPaths.includes(p));
  const orderTypeForId = (id) => Number(get('SELECT type FROM orders WHERE order_id = ?', Number(id))?.type || 0);
  const orderPath = (type) => ({
    1: '/orders', 2: '/orders/consign', 3: '/orders/shop', 4: '/orders/shop', 5: '/streambeat',
  }[Number(type)] || null);

  // 身份信息与当前权限菜单可读，但不会授予任何业务操作权限。
  if (['/me', '/menu', '/my-paths', '/modules'].includes(path)) return true;
  if (path === '/dashboard') return has('/');
  if (path === '/settlement') return has('/settlement');

  if (path === '/node/tree') return has('/node', '/role');
  if (path.startsWith('/role/')) return has('/role');
  if (path.startsWith('/storeuser/')) return has('/storeuser');
  if (path.startsWith('/setting/')) {
    const group = path === '/setting/save' ? req.body?.group : path.split('/')[2];
    return has(`/setting/${group}`);
  }
  if (path === '/options/role') return has('/role', '/storeuser');
  if (path === '/options/category') return has('/category', '/goods', '/shop-goods');
  if (path === '/options/specialarea') return has('/specialarea', '/goods', '/shop-goods', '/settlement');

  if (path.startsWith('/goods/')) {
    let type = Number(req.query.type || req.body?.type || 0);
    if (path === '/goods/split') {
      type = Number(get('SELECT type FROM goods WHERE goods_id = ?', Number(req.body?.goods_id))?.type || 0);
      return has(type === 2 ? '/shop-goods' : '/goods');
    }
    if (!type && (path.endsWith('/detail') || path.endsWith('/save'))) {
      const id = req.query.id || req.body?.goods_id || req.body?.goodsId;
      if (id) type = Number(get('SELECT type FROM goods WHERE goods_id = ?', Number(id))?.type || 0);
    }
    if (!type && path.endsWith('/remove')) {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id];
      const types = ids.filter(Boolean).map((id) => Number(get('SELECT type FROM goods WHERE goods_id = ?', Number(id))?.type || 0));
      if (types.includes(2) && !has('/shop-goods')) return false;
      if (types.includes(1) && !has('/goods')) return false;
      return types.length > 0;
    }
    if (type && type !== 1 && type !== 2) return false;
    return has(type === 2 ? '/shop-goods' : '/goods');
  }

  if (path.startsWith('/orders/')) {
    if (path === '/orders/list') {
      if (req.query.type) {
        const pagePath = orderPath(req.query.type);
        return Boolean(pagePath && has('/orders', pagePath));
      }
      return has('/orders');
    }
    if (path === '/orders/import') {
      const types = (req.body?.rows || []).map((row) => Number(row.type) || 1);
      return types.length > 0 && types.every((type) => {
        const pagePath = orderPath(type);
        return Boolean(pagePath && has('/orders', pagePath));
      });
    }
    if (path === '/orders/set-goods-order') return has('/orders', '/orders/shop');
    const id = req.query.id || req.body?.order_id;
    if (id) {
      const pagePath = orderPath(orderTypeForId(id));
      if (!pagePath || !has('/orders', pagePath)) return false;
    }
    return has('/orders', '/orders/consign', '/orders/shop', '/streambeat');
  }
  if (path.startsWith('/streambeat/')) return has('/streambeat');
  if (path.startsWith('/member/')) return has('/member');
  if (path === '/stats/goods') {
    const type = Number(req.query.type) || 1;
    if (type !== 1 && type !== 2) return false;
    return has(type === 2 ? '/shop-goods' : '/goods');
  }
  if (path === '/stats/today-orders') return has('/orders');
  if (path === '/report/audit') return has('/report');
  if (path === '/award/grant') {
    const type = orderTypeForId(req.body?.order_id);
    const pagePath = orderPath(type);
    return Boolean(pagePath && has('/orders', pagePath));
  }
  if (path.startsWith('/settle/')) {
    return has(path === '/settle/confirm' ? '/settle' : '/settlement');
  }
  if (path === '/cache/clear' || path === '/sysinfo') return has('/setting/store');

  const moduleMatch = path.match(/^\/([^/]+)\/(?:list|detail|save|remove)$/);
  if (moduleMatch) {
    const pagePath = {
      category: '/category', specialarea: '/specialarea', member: '/member',
      certification: '/certification', grade: '/member-grade', report: '/report',
      delivery: '/delivery', energy: '/energy', withdraw: '/withdraw', settle: '/settle',
      banner: '/banner', navigation: '/navigation', notice: '/notice', recharge: '/recharge',
      storeuser: '/storeuser', role: '/role',
    }[moduleMatch[1]];
    return Boolean(pagePath && has(pagePath));
  }
  return false;
}

/** 状态文本映射 */
export const GOODS_STATUS = { 10: '上架', 20: '下架', 30: '流拍' };
export const ORDER_STATUS = { 0: '待付款', 10: '待发货', 20: '待收货', 30: '已完成', 40: '已取消', 50: '已流拍', 60: '已释放' };
export const ORDER_TYPE = { 1: '抢购订单', 2: '寄卖订单', 3: '商城订单', 4: '寄买订单', 5: '流拍订单' };
export const PAY_TYPE = { 1: '余额支付', 2: '微信支付', 3: '支付宝', 4: '线下凭证' };

/** 金额两位小数 */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 读取配置（setting_config） */
export const cfg = (k, d = '') => get('SELECT `value` FROM setting_config WHERE `key` = ?', k)?.value ?? d;

/**
 * 抢单服务费费率（%）。
 * 单一口径：后台「交易设置 → 抢单服务费」、下单写入、H5 确认订单页展示
 * 全部走这里，避免各算各的相互打脸。
 * 默认 0 —— 与原站实证一致：抢购环节平台不收费，平台收入来自转拍上架费。
 */
export function serviceChargeRate() {
  const v = Number(cfg('service_charge', '0'));
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/** 按金额算服务费（买家额外承担，卖家仍收全额货款） */
export function calcServiceCharge(amount) {
  const rate = serviceChargeRate();
  if (rate <= 0) return 0;
  return money((Number(amount) * rate) / 100);
}
