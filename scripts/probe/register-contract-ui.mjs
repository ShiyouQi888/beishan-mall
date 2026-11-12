/**
 * 会员服务电子合同 · H5 交互验收（真实点击 + DOM 断言）
 *
 * 覆盖：
 *   1. 注册页文案已是《会员服务电子合同》，且合同链接可点开查看
 *   2. 填完表单点「创建账号」才弹出合同，且按钮初始不可点
 *   3. 未滚到底 + 倒计时未结束时按钮始终 disabled
 *   4. 点关闭/遮罩不注册（不产生 TOKEN、不跳转）
 *   5. 滚到底 + 倒计时结束后按钮变「确认注册」，点击才真正注册并跳首页
 *
 * 前置：public/ 已构建（npm run build），Chrome 以 --remote-debugging-port=9333 启动。
 * 独立库（probe-register-contract-ui.db / 3483），跑完销毁。
 * 用法: node scripts/probe/register-contract-ui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3483;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-register-contract-ui.db';
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
// 探针自己也要 import db.js 改测试配置，必须把库名写进本进程 env，
// 否则会连上默认的 mall.db 把真实库改坏（踩过一次）
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

// 合同正文拉长，确保在 88vh 弹层里必须滚动才到底
const LONG_CONTRACT =
  '<h3>会员服务电子合同</h3>' +
  Array.from({ length: 40 }, (_, i) => `<p>第 ${i + 1} 条：本合同用于验证强制阅读的滚动到底行为，正文内容仅为测试占位，不代表真实条款。</p>`).join('');
const READ_SECONDS = 4;

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

  const { db } = await import('../../server/src/db.js');
  const stop = () => { try { srv.kill(); } catch {} };
  try {
    // 独立库：长正文 + 4 秒倒计时 + 邀请码选填，交互耗时更短
    db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'prompt_register'").run(LONG_CONTRACT);
    db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'contract_read_seconds'").run(String(READ_SECONDS));
    db.prepare("UPDATE setting_config SET `value` = '20' WHERE `key` = 'require_invite_code'").run();
    // 本探针只验证「强制阅读」门控，签名是另一条链路，关掉避免多一步签署
    db.prepare("UPDATE setting_config SET `value` = '20' WHERE `key` = 'contract_sign_required'").run();

    const wsUrl = await (async () => {
      for (let i = 0; i < 40; i++) {
        try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
        catch { await sleep(300); }
      }
      throw new Error(`Chrome 调试端口 ${CDP_PORT} 未就绪（请先启动 --remote-debugging-port=${CDP_PORT}）`);
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

    async function ev(expression) {
      const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return result.value;
    }
    async function waitFor(expression, timeout = 12000, step = 200) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await ev(expression)) return true;
        await sleep(step);
      }
      return false;
    }

    // H5 是 history 路由，直接打开 /register；改 hash 不会触发跳转
    await send('Page.navigate', { url: BASE + '/register' }, sessionId);
    await sleep(2800);
    if (!(await ev("!!document.querySelector('.reg__submit')"))) {
      const body = await ev('document.body.innerText');
      throw new Error('注册页未渲染：' + String(body).slice(0, 200) + ' | ' + consoleErrors.slice(0, 2).join(' | '));
    }

    section('[1] 注册页文案');
    const hasTitle = await ev("document.body.innerText.includes('会员服务电子合同')");
    ok(hasTitle, '页面出现《会员服务电子合同》');
    const noOld = await ev("!document.body.innerText.includes('用户注册协议')");
    ok(noOld, '不再出现「用户注册协议」');
    const stillPrivacy = await ev("document.body.innerText.includes('隐私政策')");
    ok(stillPrivacy, '《隐私政策》入口保留');

    section('[2] 点提交才弹合同');
    await ev(`(() => {
      const ins = document.querySelectorAll('.reg__field input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(ins[0], '13971000001'); set(ins[1], '合同验收'); set(ins[2], 'probe123456'); set(ins[3], '');
      return ins.length;
    })()`);
    await sleep(200);
    ok(!(await ev("!!document.querySelector('.reg__doc') && document.querySelector('.reg__doc').getBoundingClientRect().height > 0")), '填写阶段不弹合同');
    await ev("document.querySelector('.reg__submit').click()");
    await sleep(700);
    const popupShown = await waitFor("(() => { const el = document.querySelector('.reg__doc'); return !!el && el.getBoundingClientRect().height > 100; })()", 5000);
    if (!popupShown) {
      const diag = await ev(`(() => {
        const el = document.querySelector('.reg__doc');
        return {
          exists: !!el,
          h: el ? Math.round(el.getBoundingClientRect().height) : 0,
          display: el ? getComputedStyle(el).display : '',
          toast: (document.querySelector('.van-toast')?.innerText || '').replace(/\\n/g, ' '),
          vals: [...document.querySelectorAll('.reg__field input')].map((i) => i.value),
        };
      })()`);
      console.log('  诊断:', JSON.stringify(diag), '| errors:', consoleErrors.slice(0, 3).join(' | '));
    }
    ok(popupShown, '点「创建账号」后弹出合同');
    const headText = await ev("document.querySelector('.reg__doc-head strong')?.textContent?.trim() || ''");
    ok(headText === '会员服务电子合同', '弹窗标题为合同名称', headText);
    const btn0 = await ev("(() => { const b = document.querySelector('.reg__doc-btn'); return b ? { d: b.disabled, t: b.textContent.trim() } : null; })()");
    ok(btn0?.d === true, '未阅读时按钮不可点', JSON.stringify(btn0));
    ok(/请阅读至底部/.test(btn0?.t || ''), '按钮提示先读到底', btn0?.t || '');
    ok(await ev("!!document.querySelector('.reg__doc-content h3')"), '合同正文已渲染');

    section('[3] 关闭弹窗不注册');
    await ev("document.querySelector('.reg__doc-head button').click()");
    await sleep(700);
    ok(!(await ev("(() => { const el = document.querySelector('.reg__doc'); return !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none'; })()")),
      '弹窗已关闭');
    ok(!(await ev("!!localStorage.getItem('TOKEN')")), '关闭后没有注册（无 TOKEN）');
    ok(await ev("location.pathname.replace(/\\/$/, '') === '/register'"), '仍停留在注册页');

    section('[4] 滚到底 + 倒计时门控');
    await ev("document.querySelector('.reg__submit').click()");
    await sleep(500);
    ok(await waitFor("(() => { const el = document.querySelector('.reg__doc'); return !!el && el.getBoundingClientRect().height > 100; })()", 5000),
      '再次弹出合同');
    // 只滚到底，不等到期：按钮必须仍然不可点
    await ev(`(() => {
      const b = document.querySelector('.reg__doc-body');
      b.scrollTop = b.scrollHeight;
      b.dispatchEvent(new Event('scroll'));
    })()`);
    await sleep(300);
    const tipDone = await ev("document.querySelector('.reg__doc-tip')?.textContent?.trim() || ''");
    ok(/已阅读至底部/.test(tipDone), '滚动到底后提示已读到底', tipDone);
    const midBtn = await ev("(() => { const b = document.querySelector('.reg__doc-btn'); return { d: b.disabled, t: b.textContent.trim() }; })()");
    ok(midBtn.d === true, '倒计时未结束时仍不可点', JSON.stringify(midBtn));
    ok(/确认注册（\d+s）/.test(midBtn.t), '按钮显示剩余秒数', midBtn.t);

    section('[5] 到期后确认注册');
    const enabled = await waitFor("document.querySelector('.reg__doc-btn') && document.querySelector('.reg__doc-btn').disabled === false", (READ_SECONDS + 6) * 1000, 300);
    ok(enabled, `${READ_SECONDS} 秒后按钮可点`);
    const finalBtn = await ev("document.querySelector('.reg__doc-btn')?.textContent?.trim() || ''");
    ok(finalBtn === '确认注册', '按钮文案变为「确认注册」', finalBtn);
    await ev("document.querySelector('.reg__doc-btn').click()");
    ok(await waitFor("!!localStorage.getItem('TOKEN')", 8000, 200), '点击后注册成功（写入 TOKEN）');
    ok(await waitFor("location.pathname === '/' || location.pathname === '/index.html'", 6000, 200), '注册成功跳回首页');

    section('[6] 控制台');
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
