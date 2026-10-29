import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export const SECRET = process.env.JWT_SECRET || 'mall-replica-secret-2026';

export function hashPwd(plain) {
  return crypto.createHash('sha256').update(String(plain) + '::mall').digest('hex');
}

export function verifyPwd(plain, hashed) {
  return hashPwd(plain) === hashed;
}

/** 会员 token（H5） */
export function signMember(memberId) {
  return jwt.sign({ member_info: memberId, scope: 'member' }, SECRET, { expiresIn: '7d' });
}

/** 后台 token */
export function signAdmin(userId) {
  return jwt.sign({ store_user_id: userId, scope: 'admin' }, SECRET, { expiresIn: '12h' });
}

export function decode(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

export function randomCode(len = 6) {
  const chars = 'abcdef0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function orderNo(prefix = 'D') {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${prefix}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(Math.floor(Math.random() * 10000), 4)}`;
}
