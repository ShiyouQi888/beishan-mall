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
  // type=2（历史寄卖挂单）已不再产生，统一按「全部订单」校验权限
  const orderPath = (type) => ({
    1: '/orders', 2: '/orders', 3: '/orders/shop', 4: '/orders/shop', 5: '/streambeat',
  }[Number(type)] || null);

  // 身份信息与当前权限菜单可读，但不会授予任何业务操作权限。
  if (['/me', '/me/password', '/menu', '/my-paths', '/modules'].includes(path)) return true;
  if (path === '/dashboard') return has('/');
  if (path === '/settlement') return has('/settlement');

  if (path === '/node/tree') return has('/node', '/role');
  if (path.startsWith('/role/')) return has('/role');
  if (path.startsWith('/storeuser/')) return has('/storeuser');
  if (path.startsWith('/setting/')) {
    const group = path === '/setting/save' ? req.body?.group : path.split('/')[2];
    return has(`/setting/${group}`);
  }
  // 文件管理：挑素材（列表/分组/上传）任何后台角色都能用，动素材（改名/移动/删除/分组维护）要 /media 权限
  if (path === '/media/list' || path === '/media/groups' || path === '/media/refs' || path === '/media/upload') {
    return true;
  }
  if (path.startsWith('/media')) return has('/media');
  // 分类：一键切换首页显示（批量操作）
  if (path === '/category/home-show-all') return has('/category');
  // 数据清除：跟菜单节点走，默认只有超级管理员有（超管不受限），可下放给指定角色
  if (path === '/system/reset' || path === '/system/reset/plan') return has('/setting/danger');
  if (path === '/options/role') return has('/role', '/storeuser');
  if (path === '/options/category') return has('/category', '/goods', '/shop-goods');
  if (path === '/options/specialarea') return has('/specialarea', '/goods', '/shop-goods', '/settlement');

  if (path === '/notifications/orders') {
    const type = Number(req.query.type) || 0;
    if (!type) return has('/orders');
    if (type === 3) return has('/orders/shop');
    return false;
  }
  if (path === '/notifications/withdrawals') return has('/withdraw');
  // 提现审核（含批量）：原来没显式映射，导致只有超管能用，普通角色拿到菜单也审不了
  if (path === '/withdraw/audit' || path === '/withdraw/audit-batch') return has('/withdraw');
  // 订单批量确认收款：逐单按类型校验，商城单与抢购单权限分开
  if (path === '/orders/confirm-pay-batch') {
    const ids = Array.isArray(req.body?.order_ids) ? req.body.order_ids : [];
    if (!ids.length) return false;
    return ids.every((id) => {
      const pagePath = orderPath(orderTypeForId(id));
      return Boolean(pagePath && has('/orders', pagePath));
    });
  }

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
    return has('/orders', '/orders/shop', '/streambeat');
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
      banner: '/banner', navigation: '/navigation', notice: '/notice',
      storeuser: '/storeuser', role: '/role',
    }[moduleMatch[1]];
    return Boolean(pagePath && has(pagePath));
  }
  return false;
}

/** 状态文本映射 */
export const GOODS_STATUS = { 10: '上架', 20: '下架', 30: '流拍' };
export const ORDER_STATUS = { 0: '待付款', 10: '待发货', 20: '待收货', 30: '已完成', 40: '已取消', 50: '已流拍', 60: '已释放', 70: '平台已回收' };
export const ORDER_TYPE = { 1: '抢购订单', 2: '寄卖订单', 3: '商城订单', 4: '寄买订单', 5: '流拍订单' };
export const PAY_TYPE = { 1: '余额支付', 2: '微信支付', 3: '支付宝', 4: '线下凭证' };

/** 金额两位小数 */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 静态资源地址（上传图片等）
 * - 默认返回相对路径（同源部署最稳，开发代理与 Docker 都适用）
 * - PUBLIC_BASE_URL 非空时拼成绝对地址（分离部署 / CDN 场景）
 * - 历史数据里可能存了 http://127.0.0.1:3300/... 的绝对地址，这里统一剥成相对路径再处理，
 *   避免换域名或上 Docker 后图片全部裂开
 */
const PUBLIC_BASE = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

export function assetUrl(p) {
  if (!p) return '';
  let path = String(p);
  const localAbs = path.match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(\/.*)$/i);
  if (localAbs) path = localAbs[1];
  else if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith('/')) path = `/${path}`;
  return PUBLIC_BASE ? `${PUBLIC_BASE}${path}` : path;
}

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

/**
 * 转拍涨价率（%）。
 * 每转拍一次，在「上一手成交价」基础上自动加价该比例，逐轮复利：
 *   10000 → 10300 → 10609 → …
 * 下一轮买家付 10300，上一手持有人收回 10300 全额（原价 + 涨价），之后与原持有人再无关系。
 * 设为 0 时退化为按原价挂牌（允许前端指定价格）。
 */
export function priceIncreaseRate() {
  const v = Number(cfg('price_increase_rate', '0'));
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/** 按上一手成交价算下一轮标价 */
export function calcNextPrice(prevPrice) {
  const base = Number(prevPrice) || 0;
  const rate = priceIncreaseRate();
  if (rate <= 0) return money(base);
  return money(base * (1 + rate / 100));
}
