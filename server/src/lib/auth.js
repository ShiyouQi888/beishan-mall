import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 签名密钥**不能写死在代码里**：本仓库是公开的，写死等于把后台钥匙挂在门上 ——
 * 任何人都能拿这个默认值伪造 scope=admin 的 token，直接接管后台。
 *
 * 取值顺序：
 *   1. 环境变量 JWT_SECRET（推荐，部署方自己定）
 *   2. data/.jwt-secret（首次启动自动生成 32 字节随机串并落盘，之后复用，
 *      重启不会把所有人踢下线；该文件已在 .gitignore 中，不会入库）
 *   3. 落盘失败时退化成本次进程的临时密钥（能跑，但重启后所有登录失效）
 */
let cachedSecret = null;
function resolveSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = String(process.env.JWT_SECRET || '').trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  const file = join(__dirname, '..', '..', 'data', '.jwt-secret');
  try {
    if (existsSync(file)) {
      const s = readFileSync(file, 'utf8').trim();
      if (s.length >= 32) {
        cachedSecret = s;
        return cachedSecret;
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    writeFileSync(file, s, { mode: 0o600 });
    console.log('[auth] 未配置 JWT_SECRET，已生成随机密钥并保存到 server/data/.jwt-secret');
    cachedSecret = s;
    return cachedSecret;
  } catch (e) {
    console.warn('[auth] 警告：无法持久化 JWT 密钥，本次使用临时密钥，重启后所有登录都会失效：', e.message);
    cachedSecret = crypto.randomBytes(32).toString('hex');
    return cachedSecret;
  }
}

const secret = () => resolveSecret();

export function hashPwd(plain) {
  return crypto.createHash('sha256').update(String(plain) + '::mall').digest('hex');
}

export function verifyPwd(plain, hashed) {
  return hashPwd(plain) === hashed;
}

/** 会员 token（H5） */
export function signMember(memberId) {
  return jwt.sign({ member_info: memberId, scope: 'member' }, secret(), { expiresIn: '7d' });
}

/** 后台 token */
export function signAdmin(userId) {
  return jwt.sign({ store_user_id: userId, scope: 'admin' }, secret(), { expiresIn: '12h' });
}

export function decode(token) {
  try {
    return jwt.verify(token, secret());
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
