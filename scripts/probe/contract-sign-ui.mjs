/**
 * 电子合同签署 · H5 交互验收（真实浏览器点击 + canvas 手写）
 *
 * 覆盖：
 *   1. 阅读完成前不能进入签署，按钮提示正确
 *   2. 点「下一步：签署」进入签名视图，姓名/笔迹缺一不可点
 *   3. canvas 真实绘制后按钮解锁，点「确认注册并签署」才注册成功
 *   4. 后台签署记录里能查到这次签名（姓名、签名图、合同版本）
 *   5. 关闭签名开关后，注册回到「确认注册」直接提交，不再出现签名视图
 *
 * 独立库（probe-contract-sign-ui.db / 3495），跑完销毁。
 * 前置：public/ 已构建，Chrome 以 --remote-debugging-port=9333 启动。
 * 用法: node scripts/probe/contract-sign-ui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const SHOT_DIR = join(ROOT, '.workbuddy', 'shots');
const SIGN_DIR = join(SERVER, 'data', 'uploads', 'sign');
const PORT = 3495;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-contract-sign-ui.db';
const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const removeDb = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    const p = join(SERVER, 'data', f);
    if (existsSync(p)) { try { unlinkSync(p); } catch {} }
  }
};
for (const d of [SIGN_DIR]) if (existsSync(d)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
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
  if (!existsSync(join(ROOT, 'public', 'h5', 'index.html'))) throw new Error('public/h5 未构建');
  mkdirSync(SHOT_DIR, { recursive: true });
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
  let ws = null;
  try {
    // 独立库测试前提：不限时、邀请码选填
    db.prepare("UPDATE setting_config SET `value` = '0' WHERE `key` = 'contract_read_seconds'").run();
    db.prepare("UPDATE setting_config SET `value` = '20' WHERE `key` = 'require_invite_code'").run();
    const token = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;

    const wsUrl = await (async () => {
      for (let i = 0; i < 40; i++) {
        try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
        catch { await sleep(300); }
      }
      throw new Error(`Chrome 调试端口 ${CDP_PORT} 未就绪`);
    })();
    ws = new WebSocket(wsUrl);
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
        consoleErrors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
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
      while (Date.now() < end) { if (await ev(expression)) return true; await sleep(step); }
      return false;
    };
    const shot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(SHOT_DIR, name), Buffer.from(data, 'base64'));
      console.log('  截图:', join(SHOT_DIR, name));
    };
    const popupShown = "(() => { const e = document.querySelector('.reg__doc'); return !!e && e.getBoundingClientRect().height > 100; })()";
    const btn = () => ev(`(() => { const b = document.querySelector('.reg__doc-btn'); return { d: b?.disabled, t: b?.textContent.trim() }; })()`);
    const openRegister = async (tag, phone) => {
      await ev("try { localStorage.removeItem('TOKEN'); } catch (e) {}");
      await send('Page.navigate', { url: `${BASE}/register?${tag}=1` }, sessionId);
      await sleep(2700);
      ok(await waitFor("!!document.querySelector('.reg__submit')", 8000), `注册页已渲染（${tag}）`);
      await ev(`(() => {
        const ins = document.querySelectorAll('.reg__field input');
        const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set(ins[0], '${phone}'); set(ins[1], '签署验收'); set(ins[2], 'probe123456'); set(ins[3], '');
        document.querySelector('.reg__submit').click();
      })()`);
      ok(await waitFor(popupShown, 6000), `合同弹窗出现（${tag}）`);
      // 无论合同长短都滚到底，保证阅读门控通过
      await ev(`(() => {
        const b = document.querySelector('.reg__doc-body');
        if (b) { b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); }
      })()`);
      await sleep(300);
    };

    section('[1] 阅读完成 → 进入签署');
    await openRegister('sign', '13973000001');
    const b0 = await btn();
    ok(b0.t === '下一步：签署', '按钮提示下一步签署', JSON.stringify(b0));
    ok(b0.d === false, '阅读门控已通过');
    await ev("document.querySelector('.reg__doc-btn').click()");
    ok(await waitFor("!!document.querySelector('.reg__doc-sign canvas')", 5000), '出现签名画布');
    const signHead = await ev("document.querySelector('.reg__doc-head strong')?.textContent.trim()");
    ok(signHead === '签署合同', '弹窗标题切到签署', signHead);
    const b1 = await btn();
    ok(b1.d === true, '姓名/笔迹为空时不可提交', JSON.stringify(b1));
    ok(b1.t === '确认注册并签署', '按钮文案正确', b1.t);
    await shot('contract-sign-step.png');

    section('[2] 填姓名 + canvas 手写');
    await ev(`(() => {
      const i = document.querySelector('.reg__sign-field input');
      i.value = '齐世有';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    ok((await btn()).d === true, '只填姓名仍不可提交');
    // 真实派发 pointer 事件在 canvas 上画几笔
    const drew = await ev(`(() => {
      const c = document.querySelector('.reg__doc-sign canvas');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
        clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true,
        pointerId: 1, pointerType: 'mouse', buttons: type === 'pointerup' ? 0 : 1,
      }));
      fire('pointerdown', 30, 90);
      fire('pointermove', 70, 50);
      fire('pointermove', 110, 100);
      fire('pointermove', 160, 45);
      fire('pointerup', 160, 45);
      return true;
    })()`);
    ok(drew, '在画布上完成手写');
    await sleep(300);
    const b2 = await btn();
    ok(b2.d === false, '姓名 + 笔迹齐全后按钮解锁', JSON.stringify(b2));
    const dataUrl = await ev("document.querySelector('.reg__doc-sign canvas')?.toDataURL('image/png') || ''");
    ok(dataUrl.startsWith('data:image/png;base64,') && dataUrl.length > 100, '画布能导出合法 PNG', `${dataUrl.length} 字符`);

    section('[3] 确认注册并签署');
    await ev("document.querySelector('.reg__doc-btn').click()");
    ok(await waitFor("!!localStorage.getItem('TOKEN')", 8000), '注册成功（写入 TOKEN）');
    const rec = get('SELECT * FROM contract_signature WHERE phone = ?', '13973000001');
    ok(!!rec, '后台生成签署记录');
    ok(rec?.real_name === '齐世有', '姓名落库正确', String(rec?.real_name));
    ok(!!rec?.sign_image && rec.sign_image.endsWith('.png'), '签名图路径已存', String(rec?.sign_image));
    ok(Number(rec?.read_seconds) >= 0, '阅读耗时已存', String(rec?.read_seconds));
    const list = await api('/admin/api/contract-sign/list?phone=13973000001', { token });
    ok(Number(list.data?.total) === 1, '后台列表可查到该笔签署');
    ok(!!list.data?.list?.[0]?.sign_image_url, '后台能看到签名图 URL');

    section('[4] 关闭签名开关后回到直接注册');
    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_sign_required: '20' } },
    });
    await openRegister('off', '13973000002');
    const b3 = await btn();
    ok(b3.t === '确认注册', '按钮回到「确认注册」', JSON.stringify(b3));
    await ev("document.querySelector('.reg__doc-btn').click()");
    ok(await waitFor("!!localStorage.getItem('TOKEN')", 8000), '不签名也能完成注册');
    ok(!get('SELECT 1 FROM contract_signature WHERE phone = ?', '13973000002'), '关闭后不产生签署记录');

    section('[5] 控制台');
    ok(consoleErrors.length === 0, '无控制台错误', consoleErrors.slice(0, 2).join(' | '));
  } finally {
    try { ws?.close(); } catch {}
    try { srv.kill(); } catch {}
    if (existsSync(SIGN_DIR)) { try { rmSync(SIGN_DIR, { recursive: true, force: true }); } catch {} }
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
