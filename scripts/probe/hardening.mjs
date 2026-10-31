// 安全加固回归：密码哈希升级、角色提权封锁、超管标记、素材死链清理
// 独立库（hardening.db / 3432）
// 用法: node scripts/probe/hardening.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3432;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'hardening.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runSeed() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

const legacyHash = (plain) => createHash('sha256').update(String(plain) + '::mall').digest('hex');

async function main() {
  await runSeed();
  const { db } = await import('../../server/src/db.js');

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
  srv.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  try {
    // ---------------- 1. 密码哈希 ----------------
    section('[1] 密码哈希：scrypt + 随机盐，旧哈希登录后自动升级');
    const adminRow = db.prepare("SELECT * FROM store_user WHERE user_name = 'admin1'").get();
    ok(String(adminRow.password).startsWith('scrypt$'), '新库里的密码用 scrypt 存储', String(adminRow.password).slice(0, 12));
    const p1 = String(adminRow.password).split('$');
    ok(p1.length === 3 && p1[1].length >= 32, '格式为 scrypt$盐$哈希，盐长度足够');

    // 同一个密码两次哈希应不同（随机盐）
    const { hashPwd, verifyPwd, needsRehash } = await import('../../server/src/lib/auth.js');
    const h1 = hashPwd('abc12345');
    const h2 = hashPwd('abc12345');
    ok(h1 !== h2, '同一密码两次哈希结果不同（盐是随机的）');
    ok(verifyPwd('abc12345', h1) && verifyPwd('abc12345', h2), '两个哈希都能校验通过');
    ok(!verifyPwd('abc12346', h1), '错误密码校验失败');
    ok(verifyPwd('oldpwd888', legacyHash('oldpwd888')), '旧的 sha256 哈希仍能校验');
    ok(needsRehash(legacyHash('x')) && !needsRehash(h1), '能识别旧格式需要升级');

    // 造一个"旧格式密码"的会员，登录后应被自动升级
    const mid = db.prepare("SELECT member_id id FROM member WHERE mobile='13822367845'").get().id;
    db.prepare('UPDATE member SET password = ? WHERE member_id = ?').run(legacyHash('legacy123'), mid);
    const legacyLogin = await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13822367845', password: 'legacy123' } });
    ok(legacyLogin.code === 1, '旧哈希账号仍能登录', legacyLogin.msg);
    const afterLogin = db.prepare('SELECT password FROM member WHERE member_id = ?').get(mid).password;
    ok(String(afterLogin).startsWith('scrypt$'), '登录成功后密码自动升级为 scrypt', String(afterLogin).slice(0, 12));
    const relogin = await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13822367845', password: 'legacy123' } });
    ok(relogin.code === 1, '升级后同一密码还能登录', relogin.msg);

    // ---------------- 2. 超管标记 ----------------
    section('[2] 超管判定改为表字段（不再硬编码 role_id=6）');
    const roles = db.prepare('SELECT role_id, role_name, is_super FROM store_role ORDER BY role_id').all();
    ok(roles.some((r) => Number(r.is_super) === 1), '存在 is_super=1 的角色', JSON.stringify(roles));
    const superRole = roles.find((r) => Number(r.is_super) === 1);
    ok(superRole.role_name === '超级管理员', '标记落在超级管理员角色上', superRole.role_name);

    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data?.token;
    ok(!!at, '超管登录成功');
    const tree = await api('/admin/api/node/tree', { token: at });
    ok(tree.code === 1 && Number(tree.data.super_role_id) === Number(superRole.role_id), '角色树接口返回的超管 ID 与标记一致');

    // ---------------- 3. 提权封锁 ----------------
    section('[3] 非超管不能给自己或别人分配超管角色');
    // 造一个「有管理员菜单权限、但不是超管」的角色
    const opRole = roles.find((r) => Number(r.is_super) !== 1);
    ok(!!opRole, '存在普通角色', opRole?.role_name);
    // 给该角色分配 storeuser 菜单节点
    const node = db.prepare("SELECT id FROM store_node WHERE action_name = '/storeuser'").get();
    ok(!!node, '找到「管理员」菜单节点');
    db.prepare('INSERT OR IGNORE INTO store_role_node (role_id, node_id) VALUES (?,?)').run(opRole.role_id, node.id);

    const { hashPwd: hp } = await import('../../server/src/lib/auth.js');
    db.prepare("INSERT INTO store_user (user_name, password, nick_name, role_id, status, create_time) VALUES (?,?,?,?,10,datetime('now','localtime'))")
      .run('op_user', hp('op123456'), '运营小李', opRole.role_id);
    const opLogin = await api('/admin/api/login', { method: 'POST', body: { user_name: 'op_user', password: 'op123456' } });
    ok(opLogin.code === 1, '普通管理员登录成功', opLogin.msg);
    const opToken = opLogin.data.token;
    const opId = db.prepare("SELECT store_user_id id FROM store_user WHERE user_name='op_user'").get().id;

    // 能进「管理员」模块（验证权限确实给了）
    const canList = await api('/admin/api/storeuser/list?page=1&limit=5', { token: opToken });
    ok(canList.code === 1, '该角色确实有「管理员」菜单权限', canList.msg);

    // 尝试把自己提成超管
    const selfPromote = await api('/admin/api/storeuser/save', {
      method: 'POST', token: opToken, body: { store_user_id: opId, role_id: superRole.role_id },
    });
    ok(selfPromote.code !== 1, '不能把自己改成超管角色', selfPromote.msg);
    ok(Number(db.prepare('SELECT role_id FROM store_user WHERE store_user_id = ?').get(opId).role_id) === Number(opRole.role_id), '角色实际未被改动');

    // 尝试新建一个超管账号
    const createSuper = await api('/admin/api/storeuser/save', {
      method: 'POST', token: opToken,
      body: { user_name: 'evil_super', password: '123456', nick_name: '影子超管', role_id: superRole.role_id },
    });
    ok(createSuper.code !== 1, '不能新建超管账号', createSuper.msg);
    ok(!db.prepare("SELECT 1 FROM store_user WHERE user_name='evil_super'").get(), '超管账号没有被创建出来');

    // 尝试改动超管账号（降级 / 停用）
    const superUserId = db.prepare('SELECT store_user_id id FROM store_user WHERE user_name = ?').get('admin1').id;
    const demote = await api('/admin/api/storeuser/save', {
      method: 'POST', token: opToken, body: { store_user_id: superUserId, role_id: opRole.role_id },
    });
    ok(demote.code !== 1, '不能把超管降级成普通角色', demote.msg);
    ok(Number(db.prepare('SELECT role_id FROM store_user WHERE store_user_id = ?').get(superUserId).role_id) === Number(superRole.role_id), '超管角色保持不变');

    // 普通角色之间互相调整是允许的（说明没拦过头）
    const normal = await api('/admin/api/storeuser/save', {
      method: 'POST', token: opToken, body: { store_user_id: opId, nick_name: '运营小李（改名）' },
    });
    ok(normal.code === 1, '普通角色仍可正常编辑非超管账号', normal.msg);

    // 超管自己可以自由分配
    const superAssign = await api('/admin/api/storeuser/save', {
      method: 'POST', token: at, body: { store_user_id: opId, role_id: superRole.role_id },
    });
    ok(superAssign.code === 1, '超管本人可以分配超管角色', superAssign.msg);
    await api('/admin/api/storeuser/save', { method: 'POST', token: at, body: { store_user_id: opId, role_id: opRole.role_id } });

    section('[4] 超管角色与超管账号不能被删除');
    const delRole = await api('/admin/api/role/remove', { method: 'POST', token: at, body: { ids: [superRole.role_id] } });
    ok(delRole.code !== 1, '不能删除超管角色', delRole.msg);
    const delSuper = await api('/admin/api/storeuser/remove', { method: 'POST', token: at, body: { ids: [superUserId] } });
    ok(delSuper.code !== 1, '不能删除超管账号', delSuper.msg);

    // ---------------- 5. 素材死链清理 ----------------
    section('[6] 素材库清掉「文件已不存在」的死链');
    const { UPLOAD_DIR } = await import('../../server/src/lib/uploadStorage.js');
    // 造两条记录：一条磁盘上有文件，一条只有记录
    const aliveName = `probe-alive-${Date.now()}.png`;
    writeFileSync(join(UPLOAD_DIR, aliveName), Buffer.from('x'));
    const deadName = `probe-dead-${Date.now()}.png`;
    db.prepare("INSERT INTO media_file (name, path, group_id, size, mime, width, height, private, create_time) VALUES (?,?,0,1,'image/png',1,1,0,datetime('now','localtime'))")
      .run('alive-probe', `/uploads/${aliveName}`);
    db.prepare("INSERT INTO media_file (name, path, group_id, size, mime, width, height, private, create_time) VALUES (?,?,0,1,'image/png',1,1,0,datetime('now','localtime'))")
      .run('dead-probe', `/uploads/${deadName}`);

    const list = await api('/admin/api/media/list?page=1&limit=200', { token: at });
    const paths = (list.data?.list || []).map((x) => x.path);
    ok(paths.some((p) => p.includes(aliveName)), '磁盘上存在的文件仍在列表里');
    ok(!paths.some((p) => p.includes(deadName)), '磁盘上已不存在的记录已被清掉');
    ok(!db.prepare('SELECT 1 FROM media_file WHERE path = ?').get(`/uploads/${deadName}`), '失效记录已从索引删除');
    rmSync(join(UPLOAD_DIR, aliveName), { force: true });

    // ---------------- 7. 富文本净化 ----------------
    section('[7] 富文本净化：脚本与危险协议必须被剥掉');
    const { sanitizeHtml } = await import('../../shared/sanitize.js');
    // Node 环境没有 DOMParser，走纯文本降级分支
    const dirty = '<p>正常内容</p><script>alert(1)</script><img src=x onerror=alert(2)>';
    const cleaned = sanitizeHtml(dirty);
    ok(!/<script/i.test(cleaned), '脚本标签被移除', cleaned);
    ok(cleaned.includes('正常内容'), '正常文字保留', cleaned);
  } catch (e) {
    fails.push('异常：' + e.message);
    console.error('\n异常：', e.message);
  } finally {
    srv.kill();
    await sleep(300);
  }

  console.log('\n' + '─'.repeat(52));
  if (fails.length) {
    console.log(`✗ ${fails.length} 项失败（通过 ${pass} 项）`);
    for (const f of fails) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
