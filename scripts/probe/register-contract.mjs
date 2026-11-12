/**
 * 会员服务电子合同验收
 *
 * 覆盖：
 *   1. 种子库默认值：正文、名称、强制阅读开关与 15 秒倒计时
 *   2. /index/getRegisterAgreements 返回 title / force_read / read_seconds，且不影响邀请码必填口径
 *   3. 后台「须知配置」能改合同正文、名称、开关与秒数，H5 接口立刻生效
 *   4. 边界：秒数 0 = 不限时；超大值封顶 600；非法值回退 15；名称留空回退默认
 *   5. 老库迁移：旧提示语会被替换成合同正文，运营自己改过的正文不会被覆盖
 *
 * 独立库（probe-register-contract.db / 3481），跑完销毁。
 * 用法: node scripts/probe/register-contract.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3481;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-register-contract.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`];
const removeDb = () => {
  for (const f of dbFiles) {
    const p = join(SERVER, 'data', f);
    if (!existsSync(p)) continue;
    try { unlinkSync(p); } catch {}
  }
};
removeDb();
process.env.MALL_DB = DB;
const env = {
  ...process.env, MALL_DB: DB, PORT: String(PORT),
  RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0', ORDER_EXPIRE_SCAN_MS: '0',
};
let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

const seed = () => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
});
const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

let srv = null;
let serverLog = '';
async function startServer() {
  srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  srv.stdout.on('data', (d) => (serverLog += d));
  srv.stderr.on('data', (d) => (serverLog += String(d)));
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('服务启动超时：\n' + serverLog.slice(-800));
}
async function stopServer() {
  if (!srv) return;
  const p = srv;
  srv = null;
  await new Promise((resolve) => {
    p.once('close', resolve);
    try { p.kill(); } catch { resolve(); }
    setTimeout(resolve, 3000);
  });
}

async function main() {
  await seed();
  await startServer();
  const { db, get } = await import('../../server/src/db.js');
  const { DEFAULT_CONTRACT_HTML, LEGACY_CONTRACT_HINT } = await import('../../server/src/lib/defaultContract.js');

  try {
    section('[1] 种子库默认值');
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'contract_title'")?.v, '会员服务电子合同', '默认合同名称');
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'contract_force_read'")?.v, '10', '默认强制阅读开启（10）');
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'contract_read_seconds'")?.v, '15', '默认倒计时 15 秒');
    const seededBody = get("SELECT `value` v FROM setting_config WHERE `key` = 'prompt_register'")?.v || '';
    ok(seededBody.includes('会员服务电子合同'), '正文标题已是电子合同', seededBody.slice(0, 40));
    ok(!seededBody.includes('用户注册协议'), '正文不再出现「用户注册协议」');

    section('[2] H5 注册协议接口');
    const r0 = await api('/api/index/getRegisterAgreements');
    eq(r0.code, 1, '接口可读');
    eq(r0.data.title, '会员服务电子合同', '返回合同名称');
    eq(r0.data.force_read, true, '返回 force_read=true');
    eq(r0.data.read_seconds, 15, '返回 read_seconds=15');
    ok(String(r0.data.user || '').includes('会员服务电子合同'), '返回合同正文');
    ok(r0.data.privacy !== undefined, '隐私政策字段仍在');
    ok(r0.data.require_invite_code === '1' || r0.data.require_invite_code === '0', '邀请码口径仍返回');

    section('[3] 后台可配置并即时生效');
    const at = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } });
    const token = at.data.token;
    ok(!!token, '后台登录');
    const items = (await api('/admin/api/setting/prompt', { token })).data.items || [];
    const byKey = Object.fromEntries(items.map((i) => [i.k, i]));
    eq(byKey.prompt_register?.t, '会员服务电子合同（正文）', '后台该项已改名');
    eq(byKey.contract_title?.type, 'text', '合同名称是可编辑文本');
    eq(byKey.contract_force_read?.type, 'switch', '强制阅读是开关');
    eq(byKey.contract_read_seconds?.type, 'number', '倒计时是数字项');

    const custom = '<h3>门店专用合同</h3><p>本店会员须遵守门店规则。</p>';
    const save1 = await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: {
        group: 'prompt',
        values: {
          prompt_register: custom,
          contract_title: '门店会员合同',
          contract_force_read: '20',
          contract_read_seconds: '30',
        },
      },
    });
    eq(save1.code, 1, '保存成功', save1.msg);
    const r1 = await api('/api/index/getRegisterAgreements');
    eq(r1.data.title, '门店会员合同', 'H5 立刻拿到新名称');
    eq(r1.data.user, custom, 'H5 立刻拿到新正文');
    eq(r1.data.force_read, false, '关闭后 force_read=false');
    eq(r1.data.read_seconds, 30, '倒计时随配置变化');

    section('[4] 边界值');
    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_force_read: '10', contract_read_seconds: '0' } },
    });
    const r2 = await api('/api/index/getRegisterAgreements');
    eq(r2.data.force_read, true, '重新开启强制阅读');
    eq(r2.data.read_seconds, 0, '秒数 0 = 不限时（不再倒计时）');

    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_read_seconds: '999' } },
    });
    eq((await api('/api/index/getRegisterAgreements')).data.read_seconds, 600, '超大秒数封顶 600');

    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_read_seconds: 'abc' } },
    });
    eq((await api('/api/index/getRegisterAgreements')).data.read_seconds, 15, '非法秒数回退 15');

    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_title: '   ' } },
    });
    eq((await api('/api/index/getRegisterAgreements')).data.title, '会员服务电子合同', '名称留空回退默认');

    section('[5] 老库迁移');
    // 模拟历史库：正文是旧提示语，且三个新配置项都不存在
    db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'prompt_register'").run(LEGACY_CONTRACT_HINT);
    db.prepare("DELETE FROM setting_config WHERE `key` IN ('contract_title', 'contract_force_read', 'contract_read_seconds')").run();
    await stopServer();
    serverLog = '';
    await startServer();
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'prompt_register'")?.v, DEFAULT_CONTRACT_HTML, '旧提示语被替换为合同正文');
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'contract_read_seconds'")?.v, '15', '迁移补齐倒计时默认值');
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'contract_force_read'")?.v, '10', '迁移补齐强制阅读默认值');
    const r3 = await api('/api/index/getRegisterAgreements');
    ok(String(r3.data.user || '').includes('会员服务电子合同'), '迁移后接口返回合同正文');

    // 运营改过的正文在重启后必须原样保留
    const mine = '<h3>运营自定义合同</h3><p>请不要覆盖我。</p>';
    db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'prompt_register'").run(mine);
    await stopServer();
    serverLog = '';
    await startServer();
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'prompt_register'")?.v, mine, '运营自定义正文不被迁移覆盖');
  } finally {
    await stopServer();
  }
}

main()
  .then(() => {
    console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
      for (const f of fails) console.log('  ✗ ' + f);
      process.exitCode = 1;
    }
    removeDb();
  })
  .catch((e) => {
    console.error('\n探针异常：', e?.message || e);
    removeDb();
    process.exitCode = 1;
  });
