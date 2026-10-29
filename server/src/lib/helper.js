import { decode } from './auth.js';
import { get } from '../db.js';

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
  req.admin = u;
  next();
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
