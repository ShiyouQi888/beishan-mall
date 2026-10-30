// 内置管理员账号：账号密码从环境变量读，不再写死在代码里
//
//   ADMIN_USER            登录账号，默认 admin1
//   ADMIN_PASSWORD        登录密码，默认 123456
//   ADMIN_PASSWORD_RESET  设为 1 时，启动把该账号密码强制改回环境变量里的值（忘记密码时的后门）
//
// 设计取舍：默认只在「账号不存在」时创建，不会每次启动都覆盖密码——
// 否则后台改完密码，下次重启又被环境变量刷回去，等于改密功能失效。
// 真需要重置时显式加 ADMIN_PASSWORD_RESET=1。
import { get, run, now } from '../db.js';
import { hashPwd } from './auth.js';

export const ADMIN_USER = String(process.env.ADMIN_USER || 'admin1').trim() || 'admin1';
export const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '123456');
const ADMIN_RESET = String(process.env.ADMIN_PASSWORD_RESET || '') === '1';

/** 是否显式配置了环境变量（用于区分「部署方指定」和「用默认值兜底」） */
const fromEnv = Boolean(process.env.ADMIN_USER || process.env.ADMIN_PASSWORD);

export function ensureBuiltinAdmin() {
  const user = ADMIN_USER;
  const plain = ADMIN_PASSWORD;
  if (!user || !plain) return { action: 'skip' };

  const exists = get('SELECT * FROM store_user WHERE user_name = ?', user);

  if (!exists) {
    // 没配环境变量、库里又已经有管理员时不动手，避免凭空多出一个超管
    if (!fromEnv && Number(get('SELECT COUNT(*) c FROM store_user').c) > 0) return { action: 'skip' };
    run(
      'INSERT INTO store_user (user_name, password, nick_name, role_id, status, create_time) VALUES (?,?,?,?,?,?)',
      user, hashPwd(plain), '超级管理员', 6, 10, now(),
    );
    console.log(`[admin] 已创建内置管理员 ${user}（密码取自环境变量 ADMIN_PASSWORD）`);
    return { action: 'created', user };
  }

  if (ADMIN_RESET) {
    run('UPDATE store_user SET password = ?, status = 10 WHERE store_user_id = ?', hashPwd(plain), exists.store_user_id);
    console.log(`[admin] 已按 ADMIN_PASSWORD_RESET 重置 ${user} 的密码`);
    return { action: 'reset', user };
  }

  return { action: 'keep', user };
}
