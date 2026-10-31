// 管理员账号与密码：环境变量预置 / 强制重置 / 自助改密
// 独立库（admin-account.db / 3405），不碰演示库
// 用法: node scripts/probe/admin-account.mjs
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3405;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'admin-account.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV_USER = 'ops_admin';
const ENV_PWD = 'InitPass_2026';

function runEnv(extraEnv) {
  return { ...process.env, MALL_DB: DB, PORT: String(PORT), ...extraEnv };
}

function runSeed(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

/** 起服务并等健康检查，返回 { stop } */
async function startServer(env) {
  // 系统默认只开线下转账；本用例要走余额支付，测试库显式把余额支付打开
  {
    try {
      const { db: __payDb } = await import('../../server/src/db.js');
      __payDb.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();
    } catch {}
  }
  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => {
    log += String(d);
    if (!String(d).includes('ExperimentalWarning') && !String(d).includes('trace-warnings')) process.stderr.write(d);
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));
  return {
    log: () => log,
    stop: () => new Promise((res) => { srv.once('exit', res); srv.kill('SIGTERM'); setTimeout(res, 800); }),
  };
}

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};
const login = (user, pwd) => api('/admin/api/login', { method: 'POST', body: { user_name: user, password: pwd } });
const tokenOf = async (user, pwd) => (await login(user, pwd)).data?.token || '';

async function main() {
  section('[1] 环境变量预置管理员（全新库）');
  // 显式不带 ADMIN_* 变量跑会污染结果，这里统一带上
  const env1 = runEnv({ ADMIN_USER: ENV_USER, ADMIN_PASSWORD: ENV_PWD });
  await runSeed(env1);
  let srv = await startServer(env1);

  const l1 = await login(ENV_USER, ENV_PWD);
  ok(l1.code === 1 && !!l1.data?.token, `环境变量账号可登录（${ENV_USER}）`, l1.msg);
  const l2 = await login('admin1', '123456');
  ok(l2.code !== 1, '默认账号 admin1 不再被创建');

  const at = l1.data.token;
  const me = await api('/admin/api/me', { token: at });
  ok(me.code === 1 && me.data?.name === ENV_USER, '当前登录身份正确', me.data?.name);
  ok(Number(me.data?.role_id) === 6, '内置管理员是超级管理员', String(me.data?.role_id));

  section('[2] 自助改密');
  const badOld = await api('/admin/api/me/password', { method: 'POST', token: at, body: { old_password: 'wrong', new_password: 'NewPass_2026' } });
  ok(badOld.code === 0 && /原密码/.test(badOld.msg), '原密码错误被拒', badOld.msg);
  const shortNew = await api('/admin/api/me/password', { method: 'POST', token: at, body: { old_password: ENV_PWD, new_password: '123' } });
  ok(shortNew.code === 0 && /6/.test(shortNew.msg), '新密码太短被拒', shortNew.msg);
  const samePwd = await api('/admin/api/me/password', { method: 'POST', token: at, body: { old_password: ENV_PWD, new_password: ENV_PWD } });
  ok(samePwd.code === 0 && /相同/.test(samePwd.msg), '新旧密码相同被拒', samePwd.msg);
  const emptyPwd = await api('/admin/api/me/password', { method: 'POST', token: at, body: {} });
  ok(emptyPwd.code === 0, '缺参数被拒', emptyPwd.msg);

  const NEW_PWD = 'Changed_2026';
  const changed = await api('/admin/api/me/password', { method: 'POST', token: at, body: { old_password: ENV_PWD, new_password: NEW_PWD } });
  ok(changed.code === 1, '改密成功', changed.msg);
  ok((await login(ENV_USER, ENV_PWD)).code !== 1, '旧密码已失效');
  ok((await login(ENV_USER, NEW_PWD)).code === 1, '新密码可登录');
  ok((await api('/admin/api/me', { token: at })).code === 1, '改密后当前会话仍然有效');

  section('[3] 重启不覆盖已改密码');
  await srv.stop();
  srv = await startServer(env1);
  ok((await login(ENV_USER, NEW_PWD)).code === 1, '重启后新密码仍有效（环境变量不覆盖）');
  ok((await login(ENV_USER, ENV_PWD)).code !== 1, '重启后旧密码仍失效');

  section('[4] ADMIN_PASSWORD_RESET 强制重置');
  await srv.stop();
  const env2 = runEnv({ ADMIN_USER: ENV_USER, ADMIN_PASSWORD: 'ResetPwd_2026', ADMIN_PASSWORD_RESET: '1' });
  srv = await startServer(env2);
  ok((await login(ENV_USER, 'ResetPwd_2026')).code === 1, '重置为环境变量里的新密码');
  ok((await login(ENV_USER, NEW_PWD)).code !== 1, '上次改的密码已失效');
  ok(/已按 ADMIN_PASSWORD_RESET 重置/.test(srv.log()), '启动日志记录重置动作');

  section('[5] 前端产物里不再含测试账号/一键填入');
  const readDist = (dir) => {
    const d = join(ROOT, 'public', dir, 'assets');
    if (!existsSync(d)) return '';
    return readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(d, f), 'utf8')).join('\n');
  };
  const adminJs = readDist('admin');
  const h5Js = readDist('h5');
  ok(!!adminJs && !/一键填入|演示账号/.test(adminJs), '后台产物无「一键填入 / 演示账号」', adminJs ? '' : '未找到构建产物，先 npm run build');
  ok(!!h5Js && !/测试账号/.test(h5Js), 'H5 产物无「测试账号」', h5Js ? '' : '未找到构建产物，先 npm run build');

  await srv.stop();

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main()
  .catch((e) => { console.error('\n[错误]', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
