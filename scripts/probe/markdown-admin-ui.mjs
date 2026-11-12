/**
 * 后台 Markdown 编辑器验收（真实点击，确保不是「假按钮」）
 *
 * 覆盖：
 *   1. 须知配置页 7 个协议项都渲染成 Markdown 编辑器（编辑/预览/导入 .md）
 *   2. 在文本框里粘贴一段 Markdown，点「预览」即时渲染出标题/表格/列表
 *   3. 切回「编辑」原文不丢失
 *   4. 点「保存设置」后内容确实落库，且 H5 接口返回排版好的 HTML
 *   5. 无控制台错误
 *
 * 用 admin 的 vite dev（base=/）指向独立后端，避免生产 /admin/ base 的路由干扰。
 * 独立库（probe-markdown-admin.db / 3491），跑完销毁。
 * 前置：Chrome 以 --remote-debugging-port=9333 启动。
 * 用法: node scripts/probe/markdown-admin-ui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const ADMIN = join(ROOT, 'admin');
const SHOT_DIR = join(ROOT, '.workbuddy', 'shots');
const SERVER_PORT = 3491;
const VITE_PORT = 5299;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const DEV = `http://127.0.0.1:${VITE_PORT}`;
const DB = 'probe-markdown-admin.db';
const CDP_PORT = 9333;
const CONFIG = join(ADMIN, '.probe-vite.config.mjs');
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
  ...process.env, MALL_DB: DB, PORT: String(SERVER_PORT),
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
const api = async (path) => (await fetch(BASE + path)).json();

const MD = [
  '# 会员服务电子合同',
  '',
  '## 第一条 合同的成立',
  '',
  '- 点击确认注册即视为同意本合同',
  '- 账号仅限本人使用',
  '',
  '| 项目 | 说明 |',
  '| --- | --- |',
  '| 结算 | T+1 |',
].join('\n');

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
  if (!backendReady) { try { backend.kill(); } catch {} throw new Error('后端启动超时：\n' + blog.slice(-600)); }

  // 临时 vite 配置：base=/ 的 dev server，代理指向本次独立后端
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
  let viteReady = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(DEV + '/')).ok) { viteReady = true; break; } } catch {}
    await sleep(300);
  }
  if (!viteReady) {
    try { vite.kill(); } catch {}
    try { backend.kill(); } catch {}
    if (existsSync(CONFIG)) { try { unlinkSync(CONFIG); } catch {} }
    throw new Error('admin dev server 启动超时：\n' + vlog.slice(-800));
  }

  let ws = null;
  try {
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const ev = async (expression) => {
      const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return result.value;
    };
    const waitFor = async (expression, timeout = 15000, step = 250) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await ev(expression)) return true; await sleep(step); }
      return false;
    };

    section('[1] 后台登录并打开须知配置');
    await send('Page.navigate', { url: DEV + '/login' }, sessionId);
    await sleep(2600);
    ok(await waitFor("document.querySelectorAll('.formside input').length >= 2", 12000), '登录页已渲染');
    await ev(`(() => {
      const ins = document.querySelectorAll('.formside input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(ins[0], 'admin1'); set(ins[1], '123456');
      document.querySelector('button.submit')?.click();
    })()`);
    ok(await waitFor("!!localStorage.getItem('ADMIN_TOKEN')", 10000), '后台登录成功');
    await send('Page.navigate', { url: DEV + '/setting/prompt' }, sessionId);
    await sleep(3000);
    ok(await waitFor("!!document.querySelector('.setting-form .el-form-item')", 12000), '须知配置页已渲染');

    section('[2] Markdown 编辑器控件');
    const editors = await ev(`(() => {
      const list = [...document.querySelectorAll('.md-editor')];
      return {
        count: list.length,
        tabs: list[0] ? [...list[0].querySelectorAll('.md-editor__tab')].map((b) => b.textContent.trim()) : [],
        hasTextarea: !!list[0]?.querySelector('textarea'),
        hasFile: !!list[0]?.querySelector('input[type=file]'),
        hint: list[0]?.querySelector('.md-editor__hint')?.textContent.trim() || '',
      };
    })()`);
    ok(editors.count === 7, '7 个协议项都用了 Markdown 编辑器', JSON.stringify(editors));
    ok(editors.tabs.join(',') === '编辑,预览,导入 .md', '编辑/预览/导入三个按钮都在', JSON.stringify(editors.tabs));
    ok(editors.hasTextarea && editors.hasFile, '文本框与文件选择器真实存在');
    ok(/Markdown/.test(editors.hint), '有粘贴 Markdown 的提示', editors.hint);

    section('[3] 粘贴 Markdown → 预览 → 切回编辑');
    // 定位「会员服务电子合同（正文）」那一项的编辑器，按索引操作，避免其它项干扰
    const editorIndex = await ev(`(() => {
      const items = [...document.querySelectorAll('.el-form-item')];
      return items.findIndex((x) => (x.querySelector('.el-form-item__label')?.textContent || '').includes('会员服务电子合同'));
    })()`);
    ok(editorIndex >= 0, '找到合同正文配置项', String(editorIndex));
    const pasted = await ev(`(() => {
      const ed = document.querySelectorAll('.md-editor')[${editorIndex}];
      const ta = ed?.querySelector('textarea');
      if (!ta) return false;
      ta.value = ${JSON.stringify(MD)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    ok(pasted, '已把 Markdown 粘进文本框');
    await sleep(300);
    await ev(`document.querySelectorAll('.md-editor')[${editorIndex}].querySelectorAll('.md-editor__tab')[1].click()`);
    ok(await waitFor(`!!document.querySelectorAll('.md-editor')[${editorIndex}].querySelector('.md-editor__preview h1')`, 6000), '点预览后出现 h1 标题');
    const preview = await ev(`(() => {
      const p = document.querySelectorAll('.md-editor')[${editorIndex}].querySelector('.md-editor__preview');
      return {
        h1: p.querySelector('h1')?.textContent.trim(),
        h2: p.querySelectorAll('h2').length,
        li: p.querySelectorAll('li').length,
        table: p.querySelectorAll('table').length,
        raw: p.textContent.includes('## 第一条'),
      };
    })()`);
    ok(preview.h1 === '会员服务电子合同', '预览标题正确', JSON.stringify(preview));
    ok(preview.h2 === 1 && preview.li === 2 && preview.table === 1, '预览里标题/列表/表格都排版好', JSON.stringify(preview));
    ok(preview.raw === false, '预览不显示原始 ## 标记');
    const { data: shotData } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const shotPath = join(SHOT_DIR, 'md-admin-preview.png');
    writeFileSync(shotPath, Buffer.from(shotData, 'base64'));
    console.log('  截图:', shotPath);

    await ev(`document.querySelectorAll('.md-editor')[${editorIndex}].querySelectorAll('.md-editor__tab')[0].click()`);
    await sleep(300);
    const back = await ev(`document.querySelectorAll('.md-editor')[${editorIndex}].querySelector('textarea')?.value || ''`);
    ok(back.includes('# 会员服务电子合同'), '切回编辑后原文还在');

    section('[4] 保存设置 → 落库与 H5 接口');
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /保存设置/.test(x.innerText));
      if (b) b.click();
      return !!b;
    })()`);
    let savedOk = false;
    for (let i = 0; i < 40; i++) {
      const r = await api('/api/index/getRegisterAgreements');
      if (String(r.data?.user || '').includes('<h1>会员服务电子合同</h1>')) { savedOk = true; break; }
      await sleep(300);
    }
    ok(savedOk, '保存后 H5 接口返回排版好的合同 HTML');
    const { get } = await import('../../server/src/db.js');
    ok(String(get("SELECT `value` v FROM setting_config WHERE `key` = 'prompt_register'")?.v || '').includes('# 会员服务电子合同'),
      '数据库存的是 Markdown 原文（不是转换后的 HTML）');

    section('[5] 控制台');
    ok(consoleErrors.length === 0, '无控制台错误', consoleErrors.slice(0, 2).join(' | '));
  } finally {
    try { ws?.close(); } catch {}
    try { vite.kill(); } catch {}
    try { backend.kill(); } catch {}
    if (existsSync(CONFIG)) { try { unlinkSync(CONFIG); } catch {} }
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
    try { if (existsSync(CONFIG)) unlinkSync(CONFIG); } catch {}
    removeDb();
    process.exitCode = 1;
  });
