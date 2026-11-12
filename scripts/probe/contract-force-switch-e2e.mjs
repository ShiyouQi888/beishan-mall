/**
 * 「强制阅读合同」开关 · 端到端验收
 *
 * 链路：后台登录 → 读取「须知配置」里的开关 → 通过后台保存接口切换开关
 *       → 配置落库 → H5 注册协议接口 → 真实浏览器点击注册 → member 表落库
 *
 * 覆盖：
 *   1. 后台设置项里确实存在「强制阅读合同」开关（switch），默认开启
 *   2. 开启时：点提交弹合同，按钮 disabled、有倒计时
 *   3. 后台把开关关掉（并把秒数调到 30 以证明倒计时被整体跳过）并保存 → 落库 20、接口 false
 *   4. 关闭后 H5 重新加载：合同仍弹，但按钮立即可点、无倒计时；不滚动直接确认 → 注册成功
 *   5. 后台重新开启并保存 → 落库 10、接口 true
 *   6. 重新开启后 H5：门控恢复；关闭弹窗不注册
 *
 * 说明：后台「保存设置」按钮调用的就是 /admin/api/setting/save，这里用同一接口，
 *       避免手写后台 SPA 深链接受构建 base 影响。H5 侧为真实浏览器点击。
 * 前置：public/ 已构建（npm run build），Chrome 以 --remote-debugging-port=9333 启动。
 * 独立库（probe-force-switch.db / 3485），跑完销毁。
 * 用法: node scripts/probe/contract-force-switch-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3485;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-force-switch.db';
const CDP_PORT = 9333;
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
// 探针自己也会 import db.js 读落库结果，必须把库名写进本进程 env，
// 否则会连上默认 mall.db（真实库）
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

async function main() {
  if (!existsSync(join(ROOT, 'public', 'h5', 'index.html'))) {
    throw new Error('public/h5 未构建，先执行 npm run build');
  }
  await seed();

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += String(d)));
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) { try { srv.kill(); } catch {} throw new Error('服务启动超时：\n' + log.slice(-600)); }

  const { db, get } = await import('../../server/src/db.js');
  const stop = () => { try { srv.kill(); } catch {} };
  try {
    // 测试前提：邀请码选填，注册表单里就不用猜 seed 的邀请码
    db.prepare("UPDATE setting_config SET `value` = '20' WHERE `key` = 'require_invite_code'").run();
    // 本探针只验证强制阅读开关，关闭签名开关以隔离新签署步骤
    db.prepare("UPDATE setting_config SET `value` = '20' WHERE `key` = 'contract_sign_required'").run();
    const cfgVal = (k) => get('SELECT `value` v FROM setting_config WHERE `key` = ?', k)?.v;
    const memberCount = (phone) => get('SELECT COUNT(*) c FROM member WHERE mobile = ?', phone)?.c || 0;

    section('[1] 后台配置项里存在强制阅读开关');
    const login = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } });
    const token = login.data?.token;
    ok(!!token, '后台登录成功');
    const setting = await api('/admin/api/setting/prompt', { token });
    const items = setting.data?.items || [];
    const sw = items.find((x) => x.k === 'contract_force_read');
    ok(!!sw, '设置项含 contract_force_read');
    eq(sw?.type, 'switch', '该项是开关类型');
    eq(sw?.t, '强制阅读合同', '后台显示名正确');
    eq(cfgVal('contract_force_read'), '10', '默认开启（10）');
    ok((await api('/api/index/getRegisterAgreements')).data.force_read === true, 'H5 接口 force_read=true');

    // ---- Chrome：H5 真实点击 ----
    const wsUrl = await (async () => {
      for (let i = 0; i < 40; i++) {
        try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
        catch { await sleep(300); }
      }
      throw new Error(`Chrome 调试端口 ${CDP_PORT} 未就绪`);
    })();
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}, sessionId) => {
      const m = ++id;
      ws.send(JSON.stringify({ id: m, method, params, sessionId }));
      return new Promise((res, rej) => pending.set(m, { res, rej }));
    };
    await new Promise((r) => (ws.onopen = r));
    const consoleErrors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0]);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        consoleErrors.push('[error] ' + m.params.entry.text);
      }
    };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
    const ev = async (expression) => {
      const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return result.value;
    };
    const waitFor = async (expression, timeout = 10000, step = 200) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await ev(expression)) return true;
        await sleep(step);
      }
      return false;
    };
    const popupShown = "(() => { const e = document.querySelector('.reg__doc'); return !!e && e.getBoundingClientRect().height > 100; })()";
    const openRegister = async (tag, phone) => {
      await send('Page.navigate', { url: `${BASE}/register?${tag}=1` }, sessionId);
      await sleep(2700);
      ok(await waitFor("!!document.querySelector('.reg__submit')", 8000), `注册页已渲染（${tag}）`);
      await ev(`(() => {
        const ins = document.querySelectorAll('.reg__field input');
        const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set(ins[0], '${phone}'); set(ins[1], '开关验收'); set(ins[2], 'probe123456'); set(ins[3], '');
        document.querySelector('.reg__submit').click();
      })()`);
      ok(await waitFor(popupShown, 6000), `点提交后弹出合同（${tag}）`);
    };
    const docState = () => ev(`(() => {
      const b = document.querySelector('.reg__doc-btn');
      return {
        disabled: b?.disabled,
        text: b?.textContent.trim(),
        countdown: !!document.querySelector('.reg__doc-count'),
        tip: !!document.querySelector('.reg__doc-tip'),
      };
    })()`);

    section('[2] 开关开启：门控生效');
    await openRegister('default', '13971000001');
    const sOn0 = await docState();
    ok(sOn0.disabled === true, '按钮不可点', JSON.stringify(sOn0));
    ok(sOn0.countdown === true && sOn0.tip === true, '倒计时与滚到底提示都在', JSON.stringify(sOn0));
    await ev("document.querySelector('.reg__doc-head button').click()");
    await sleep(600);
    ok(memberCount('13971000001') === 0, '关闭弹窗不注册');

    section('[3] 后台关闭开关并保存');
    const savedOff = await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_force_read: '20', contract_read_seconds: '30' } },
    });
    eq(savedOff.code, 1, '后台保存成功');
    eq(cfgVal('contract_force_read'), '20', '关闭状态已落库');
    eq(cfgVal('contract_read_seconds'), '30', '倒计时被调到 30 秒（用于验证开关优先级）');
    const offApi = await api('/api/index/getRegisterAgreements');
    ok(offApi.data.force_read === false, 'H5 接口 force_read=false');
    eq(offApi.data.read_seconds, 30, 'H5 接口仍返回 30 秒配置（但开关关闭应整体跳过）');

    section('[4] 关闭后 H5 端到端：不滚动、不等待即可注册');
    await openRegister('off', '13971000002');
    const sOff = await docState();
    ok(sOff.disabled === false, '按钮立即可点', JSON.stringify(sOff));
    eq(sOff.text, '确认注册', '按钮文案为「确认注册」');
    ok(sOff.countdown === false && sOff.tip === false, '无倒计时、无滚到底提示', JSON.stringify(sOff));
    // 关键：完全不滚动、不等待 30 秒，直接确认
    await ev("document.querySelector('.reg__doc-btn').click()");
    let registered = false;
    for (let i = 0; i < 40; i++) { if (memberCount('13971000002') === 1) { registered = true; break; } await sleep(250); }
    ok(registered, '不滚动不等待，直接注册成功（member 表落库）');

    section('[5] 后台重新打开开关');
    const savedOn = await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_force_read: '10', contract_read_seconds: '15' } },
    });
    eq(savedOn.code, 1, '后台保存成功');
    eq(cfgVal('contract_force_read'), '10', '重新开启已落库');
    ok((await api('/api/index/getRegisterAgreements')).data.force_read === true, 'H5 接口 force_read=true');

    section('[6] 重新开启后 H5：门控恢复');
    await openRegister('on', '13971000003');
    const sOn = await docState();
    ok(sOn.disabled === true, '按钮又不可点', JSON.stringify(sOn));
    ok(sOn.countdown === true && sOn.tip === true, '倒计时与滚到底提示回来', JSON.stringify(sOn));
    await ev("document.querySelector('.reg__doc-head button').click()");
    await sleep(600);
    ok(memberCount('13971000003') === 0, '关闭弹窗不注册');

    section('[7] 控制台');
    ok(consoleErrors.length === 0, '无控制台错误', consoleErrors.slice(0, 2).join(' | '));
    try { ws.close(); } catch {}
  } finally {
    stop();
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
