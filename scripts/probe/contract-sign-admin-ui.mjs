/**
 * 电子合同签署 · 全链路端到端（H5 真实签名 → 后台真实页面查看）
 *
 * 覆盖：
 *   1. H5：填表 → 阅读 → 签署 → 注册成功
 *   2. 后台：登录 → 左侧菜单「合同签署记录」→ 列表出现该会员 → 点「查看」
 *   3. 详情弹窗：签名图真实加载（naturalWidth > 0）、合同快照、版本/IP/设备字段
 *   4. 导出按钮可用、无控制台错误
 *
 * 用 admin vite dev（base=/）指向独立后端，避免生产 /admin/ base 的路由干扰。
 * 独立库（probe-contract-sign-admin.db / 3497），跑完销毁。
 * 前置：public/ 已构建，Chrome 以 --remote-debugging-port=9333 启动。
 * 用法: node scripts/probe/contract-sign-admin-ui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const ADMIN = join(ROOT, 'admin');
const SHOT_DIR = join(ROOT, '.workbuddy', 'shots');
const SIGN_DIR = join(SERVER, 'data', 'uploads', 'sign');
// 动态端口：避免上一次探针残留的服务串数据（固定端口曾导致假阳性）
const PORT = 3600 + (Date.now() % 300);
const VITE_PORT = 5400 + (Date.now() % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DEV = `http://127.0.0.1:${VITE_PORT}`;
const DB = 'probe-contract-sign-admin.db';
const CONFIG = join(ADMIN, '.probe-vite.config.mjs');
const CDP_PORT = 9333;
const PHONE = '13974000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanupFiles = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    const p = join(SERVER, 'data', f);
    if (existsSync(p)) { try { unlinkSync(p); } catch {} }
  }
  if (existsSync(SIGN_DIR)) { try { rmSync(SIGN_DIR, { recursive: true, force: true }); } catch {} }
  if (existsSync(CONFIG)) { try { unlinkSync(CONFIG); } catch {} }
};
cleanupFiles();
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

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  await seed();
  const backend = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let blog = '';
  backend.stdout.on('data', (d) => (blog += d));
  backend.stderr.on('data', (d) => (blog += String(d)));
  let backendReady = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { backendReady = true; break; } } catch {}
    await sleep(250);
  }
  if (!backendReady) throw new Error('后端启动超时：\n' + blog.slice(-600));

  const { db, get } = await import('../../server/src/db.js');
  db.prepare("UPDATE setting_config SET `value` = '0' WHERE `key` = 'contract_read_seconds'").run();
  db.prepare("UPDATE setting_config SET `value` = '20' WHERE `key` = 'require_invite_code'").run();

  writeFileSync(CONFIG, `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import ElementPlus from 'unplugin-element-plus/vite';
export default defineConfig({
  base: '/',
  plugins: [vue(), Components({ resolvers: [ElementPlusResolver()], dts: false }), ElementPlus({ useSource: false })],
  server: {
    host: '127.0.0.1', port: ${VITE_PORT}, strictPort: true, fs: { allow: ['..'] },
    proxy: {
      '/admin/api': { target: '${BASE}', changeOrigin: true },
      '/api': { target: '${BASE}', changeOrigin: true },
      '/uploads': { target: '${BASE}', changeOrigin: true },
    },
  },
});
`, 'utf8');
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', '.probe-vite.config.mjs'], {
    cwd: ADMIN, env: { ...process.env }, stdio: 'pipe',
  });
  let vlog = '';
  vite.stdout.on('data', (d) => (vlog += d));
  vite.stderr.on('data', (d) => (vlog += String(d)));

  let ws = null;
  try {
    let viteReady = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(DEV + '/')).ok) { viteReady = true; break; } } catch {}
      await sleep(300);
    }
    if (!viteReady) throw new Error('admin dev server 启动超时：\n' + vlog.slice(-800));

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
    async function makeSession(width, height, mobile) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Page.enable', {}, sessionId);
      await send('Runtime.enable', {}, sessionId);
      await send('Log.enable', {}, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }, sessionId);
      const ev = async (expression) => {
        const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        return result.value;
      };
      const waitFor = async (expression, timeout = 12000, step = 200) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) { if (await ev(expression)) return true; await sleep(step); }
        return false;
      };
      return { sessionId, ev, waitFor };
    }

    const h5 = await makeSession(390, 844, true);
    const admin = await makeSession(1360, 900, false);

    section('[1] H5：填表 → 阅读 → 签署 → 注册');
    // Chrome profile 会被复用，先清掉同 origin 的 localStorage，避免 TOKEN 残留造成假阳性
    await send('Page.navigate', { url: `${BASE}/` }, h5.sessionId);
    await sleep(1200);
    await h5.ev("try { localStorage.clear(); } catch (e) {}");
    await send('Page.navigate', { url: `${BASE}/register` }, h5.sessionId);
    await sleep(2700);
    ok(await h5.waitFor("!!document.querySelector('.reg__submit')"), '注册页已渲染');
    await h5.ev(`(() => {
      const ins = document.querySelectorAll('.reg__field input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(ins[0], '${PHONE}'); set(ins[1], '链路验收'); set(ins[2], 'probe123456'); set(ins[3], '');
      document.querySelector('.reg__submit').click();
    })()`);
    ok(await h5.waitFor("(() => { const e = document.querySelector('.reg__doc'); return !!e && e.getBoundingClientRect().height > 100; })()"), '合同弹窗出现');
    await h5.ev(`(() => { const b = document.querySelector('.reg__doc-body'); if (b) { b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); } })()`);
    await sleep(250);
    await h5.ev("document.querySelector('.reg__doc-btn').click()");
    ok(await h5.waitFor("!!document.querySelector('.reg__doc-sign canvas')"), '进入签署步骤');
    await h5.ev(`(() => {
      const i = document.querySelector('.reg__sign-field input');
      i.value = '齐世有'; i.dispatchEvent(new Event('input', { bubbles: true }));
      const c = document.querySelector('.reg__doc-sign canvas');
      const r = c.getBoundingClientRect();
      const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', buttons: t === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', 30, 90); fire('pointermove', 80, 45); fire('pointermove', 140, 95); fire('pointerup', 140, 95);
    })()`);
    await sleep(250);
    ok((await h5.ev("document.querySelector('.reg__doc-btn')?.disabled")) === false, '签名齐全后按钮解锁');
    await h5.ev("document.querySelector('.reg__doc-btn').click()");
    // 用数据库记录做硬断言，而不是 localStorage 里的 TOKEN（后者可能被上次运行残留）
    let rec = null;
    for (let i = 0; i < 40; i += 1) {
      rec = get('SELECT * FROM contract_signature WHERE phone = ?', PHONE);
      if (rec) break;
      await sleep(250);
    }
    ok(await h5.waitFor("!!localStorage.getItem('TOKEN')", 8000), '注册成功（写入 TOKEN）');
    ok(!!rec, '签署记录已落库（本次注册产生）', rec ? '' : '库里查不到该手机号');
    const version = rec?.contract_version || '';

    section('[2] 后台：登录并打开「合同签署记录」');
    await send('Page.navigate', { url: DEV + '/' }, admin.sessionId);
    await sleep(1200);
    await admin.ev("try { localStorage.clear(); } catch (e) {}");
    await send('Page.navigate', { url: DEV + '/login' }, admin.sessionId);
    await sleep(2600);
    ok(await admin.waitFor("document.querySelectorAll('.formside input').length >= 2", 12000), '后台登录页已渲染');
    await admin.ev(`(() => {
      const ins = document.querySelectorAll('.formside input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(ins[0], 'admin1'); set(ins[1], '123456');
      document.querySelector('button.submit')?.click();
    })()`);
    ok(await admin.waitFor("!!localStorage.getItem('ADMIN_TOKEN')", 10000), '后台登录成功');
    await send('Page.navigate', { url: DEV + '/contract-sign' }, admin.sessionId);
    await sleep(3000);
    ok(await admin.waitFor("!!document.querySelector('.el-table')", 12000), '签署记录页已渲染');
    const pageInfo = await admin.ev(`(() => ({
      title: document.querySelector('.page-head h2')?.textContent.trim() || '',
      text: document.querySelector('.el-table')?.innerText || '',
      rows: document.querySelectorAll('.el-table__body tr').length,
    }))()`);
    ok(pageInfo.title === '合同签署记录', '页面标题正确', pageInfo.title);
    ok(pageInfo.rows >= 1, '列表有数据', String(pageInfo.rows));
    ok(pageInfo.text.includes(PHONE), '列表显示刚签署的手机号');
    ok(pageInfo.text.includes('齐世有'), '列表显示签署姓名');
    ok(version.length > 0 && pageInfo.text.includes(version), '列表显示合同版本');

    section('[3] 后台详情：签名图与合同快照');
    await admin.ev(`(() => {
      const b = [...document.querySelectorAll('.el-table button')].find((x) => /查看/.test(x.innerText));
      if (b) b.click();
      return !!b;
    })()`);
    ok(await admin.waitFor("!!document.querySelector('.sign-box img')", 8000), '详情弹窗出现且含签名图');
    // 图片经 vite proxy 转发，加载是异步的：轮询到真正解码完成再断言
    ok(await admin.waitFor("(() => { const i = document.querySelector('.sign-box img'); return !!i && i.complete && i.naturalWidth > 0; })()", 10000),
      '签名图片真实加载成功（非裂图）');
    const detail = await admin.ev(`(() => {
      const img = document.querySelector('.sign-box img');
      const d = document.querySelector('.el-dialog')?.innerText || '';
      return {
        loaded: !!img && img.complete && img.naturalWidth > 0,
        w: img?.naturalWidth || 0,
        src: img?.getAttribute('src') || '',
        hasName: d.includes('齐世有'),
        hasVersion: d.includes('${version}'),
        hasContract: d.includes('会员服务电子合同'),
        hasSnapshot: (document.querySelector('.contract-snapshot')?.innerText || '').includes('甲方'),
      };
    })()`);
    ok(detail.src.startsWith('/uploads/sign/'), '签名图指向 /uploads/sign/', detail.src);
    ok(detail.hasName && detail.hasVersion, '详情显示姓名与合同版本', JSON.stringify(detail));
    ok(detail.hasSnapshot, '详情渲染了当时的合同正文快照');
    const { data: shotData } = await send('Page.captureScreenshot', { format: 'png' }, admin.sessionId);
    writeFileSync(join(SHOT_DIR, 'contract-sign-admin-detail.png'), Buffer.from(shotData, 'base64'));
    console.log('  截图:', join(SHOT_DIR, 'contract-sign-admin-detail.png'));

    section('[4] 导出按钮与控制台');
    ok(await admin.ev("[...document.querySelectorAll('button')].some((b) => /导出 CSV/.test(b.innerText))"), '导出按钮存在');
    ok(consoleErrors.length === 0, '无控制台错误', consoleErrors.slice(0, 2).join(' | '));
  } finally {
    try { ws?.close(); } catch {}
    try { vite.kill(); } catch {}
    try { backend.kill(); } catch {}
    cleanupFiles();
  }
}

main()
  .then(() => {
    console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
      for (const f of fails) console.log('  ✗ ' + f);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error('\n探针异常：', e?.message || e);
    cleanupFiles();
    process.exitCode = 1;
  });
