import { get, run, now } from '../db.js';
import { decode } from './auth.js';

const SKIP_READ_PATHS = new Set(['/me', '/menu', '/my-paths', '/modules']);
const MODULE_LABELS = {
  goods: '商品', category: '商品分类', specialarea: '抢购场次', orders: '订单',
  transpose: '转拍订单', recycle: '系统回收', member: '会员', withdraw: '提现',
  certification: '实名认证', banner: '广告', navigation: '菜单配置', notice: '公告',
  storeuser: '管理员', role: '角色', energy: '资金流水', scoreItem: '积分商品',
  scoreExchange: '积分兑换', delivery: '运费模板', setting: '系统设置', media: '素材',
};
const TARGET_LABELS = {
  goods: '商品', category: '分类', specialarea: '场次', orders: '订单',
  member: '会员', storeuser: '管理员', role: '角色', banner: '广告',
  notice: '公告', navigation: '导航', scoreItem: '积分商品', scoreExchange: '积分兑换',
  certification: '实名记录', withdraw: '提现记录', media: '素材', setting: '设置',
};
const EXPLICIT_ACTIONS = new Map([
  ['POST /me/password', '修改登录密码'],
  ['POST /orders/confirm-pay', '确认订单收款'],
  ['POST /orders/confirm-pay-batch', '批量确认收款'],
  ['POST /orders/cancel', '取消订单'],
  ['POST /orders/cancel-batch', '批量取消订单'],
  ['POST /orders/audit', '审核订单'],
  ['POST /orders/transfer', '转让订单'],
  ['POST /member/adjust', '调整会员账户'],
  ['POST /member/advance', '设置会员提前抢购权限'],
  ['POST /certification/audit', '审核实名认证'],
  ['POST /role/nodes', '分配角色权限'],
  ['POST /setting/save', '修改系统设置'],
  ['POST /system/reset', '清除业务数据'],
  ['POST /cache/clear', '清理缓存'],
  ['POST /withdraw/audit', '审核提现'],
  ['POST /withdraw/audit-batch', '批量审核提现'],
  ['POST /score-exchange/deliver', '处理积分兑换发货'],
  ['POST /score-exchange/cancel', '取消积分兑换'],
  ['POST /settle/confirm', '确认结算'],
  ['POST /media/upload', '上传素材'],
  ['POST /media/remove', '删除素材'],
  ['POST /media/rename', '重命名素材'],
  ['POST /media/move', '移动素材'],
  ['POST /media/group/save', '保存素材分组'],
  ['POST /media/group/remove', '删除素材分组'],
]);

const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|authorization|mobile|phone|id_?card|voucher|base64|file|image|content|detail|html)/i;

function cleanPath(path) {
  const value = String(path || '/').split('?')[0].replace(/\/$/, '');
  return value || '/';
}

function scrub(value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (depth > 4) return '[层级过深]';
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => scrub(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[已隐藏]' : scrub(item, depth + 1),
    ]));
  }
  return String(value);
}

function safeDetails(req) {
  const value = JSON.stringify({ body: scrub(req.body || {}), query: scrub(req.query || {}) });
  if (value.length <= 4000) return value;
  return JSON.stringify({ truncated: true, preview: value.slice(0, 3900) });
}

function subject(req, path) {
  const body = req.body || {};
  const query = req.query || {};
  const targetKeys = ['order_id', 'goods_id', 'member_id', 'store_user_id', 'role_id', 'item_id', 'exchange_id', 'id'];
  let id = '';
  for (const key of targetKeys) {
    const value = body[key] ?? query[key];
    if (value != null && value !== '') { id = Array.isArray(value) ? value.slice(0, 40).join(',') : String(value); break; }
  }
  if (!id) {
    const value = body.ids ?? body.order_ids ?? query.ids;
    if (Array.isArray(value)) id = value.slice(0, 40).join(',');
    else if (value != null && value !== '') id = String(value);
  }
  const segment = path.split('/').filter(Boolean)[0] || '';
  return { type: TARGET_LABELS[segment] || segment, id: id.slice(0, 300) };
}

function actionName(method, path, req) {
  if (path === '/login') return '管理员登录';
  const explicit = EXPLICIT_ACTIONS.get(`${method} ${path}`);
  if (explicit) return explicit;

  const [moduleName = '', operation = ''] = path.split('/').filter(Boolean);
  const label = MODULE_LABELS[moduleName] || moduleName || '后台';
  if (operation === 'list') return `查看${label}列表`;
  if (operation === 'detail') return `查看${label}详情`;
  if (operation === 'save') return `${req.body?.id ? '编辑' : '新增'}${label}`;
  if (operation === 'remove') return `删除${label}`;
  if (operation === 'export') return `导出${label}`;
  if (method === 'GET' && path === '/dashboard') return '查看控制面板';
  if (method === 'GET') return `查看${label}`;
  return `操作${label}`;
}

function shouldSkip(method, path) {
  if (method === 'OPTIONS') return true;
  if (path === '/audit/list') return true;
  if (method === 'GET' && (SKIP_READ_PATHS.has(path) || path.startsWith('/options/') || path.startsWith('/notifications/'))) return true;
  return false;
}

/**
 * Records authenticated admin API activity after the route has produced its response.
 * Login attempts are associated with the submitted account; passwords and credentials
 * are scrubbed from the details snapshot before persistence.
 */
export function auditAdminRequest(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = cleanPath(req.path || req.originalUrl);
  if (shouldSkip(method, path)) return next();

  const isLogin = method === 'POST' && path === '/login';
  const raw = req.headers.token || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = raw ? decode(raw) : null;
  let admin = payload?.scope === 'admin'
    ? get('SELECT store_user_id, user_name, nick_name, role_id FROM store_user WHERE store_user_id = ?', Number(payload.store_user_id))
    : null;
  if (!admin && isLogin) {
    admin = get('SELECT store_user_id, user_name, nick_name, role_id FROM store_user WHERE user_name = ?', String(req.body?.user_name || '').trim());
  }
  if (!admin && !isLogin) return next();

  const fallbackName = String(req.body?.user_name || '').trim().slice(0, 100);
  const operator = admin || { store_user_id: 0, user_name: fallbackName, nick_name: '', role_id: 0 };
  let responseCode;
  let responseMessage = '';
  const originalJson = res.json;
  res.json = function captureAdminResponse(body) {
    if (body && typeof body === 'object') {
      if (body.code !== undefined) responseCode = Number(body.code);
      if (body.msg !== undefined) responseMessage = String(body.msg).slice(0, 300);
    }
    return originalJson.call(this, body);
  };

  res.once('finish', () => {
    const target = subject(req, path);
    const success = responseCode === undefined ? res.statusCode < 400 : responseCode === 1;
    try {
      run(
        `INSERT INTO admin_operation_log
          (admin_id, admin_name, admin_nick, role_id, action, method, path, target_type, target_id,
           details, result, result_message, http_status, ip, user_agent, create_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        Number(operator.store_user_id) || 0,
        String(operator.user_name || '').slice(0, 100),
        String(operator.nick_name || '').slice(0, 100),
        Number(operator.role_id) || 0,
        actionName(method, path, req),
        method,
        String(req.originalUrl || path).split('?')[0].slice(0, 500),
        target.type.slice(0, 80),
        target.id,
        safeDetails(req),
        success ? 1 : 0,
        responseMessage,
        Number(res.statusCode) || 200,
        String(req.ip || req.socket?.remoteAddress || '').slice(0, 100),
        String(req.headers['user-agent'] || '').slice(0, 500),
        now(),
      );
    } catch (error) {
      console.error('[admin-audit] 写入操作审计失败：', error.message);
    }
  });
  next();
}
