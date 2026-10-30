/**
 * 后台页面截图：注入登录态后用 CDP 截整页。
 *
 * 为什么不用 chrome --screenshot：
 *   1) 那个模式没法在导航前写 localStorage，会先被打到登录页；
 *   2) 只能截视口，长页面会被截断。
 * 为什么必须给独立 --user-data-dir：
 *   如果本机还开着别的 Chrome，新进程会把地址转交给已有实例然后自己退出，
 *   这时 CDP 连到的是别人的标签页，截出来的是上一个状态。
 *
 * 用法: node scripts/probe/shot-admin.mjs <路由> <输出文件> [服务地址]
 *   路由不要带前导斜杠——Git Bash(MSYS) 会把 “/xxx” 当路径，擅自转换成
 *   “C:/.../PortableGit/xxx”，脚本里做了兜底还原，但少一层麻烦更好。
 *   例: node scripts/probe/shot-admin.mjs finance-board shot.png http://127.0.0.1:3300
 *       node scripts/probe/shot-admin.mjs setting/trade trade.png
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 还原被 Git Bash 路径转换弄坏的路由参数 */
function normalizeRoute(arg) {
  let r = String(arg || '').trim();
  if (!r) return '/';
  const mangled = r.match(/^[A-Za-z]:[\\/]/);
  if (mangled) {
    const afterGit = r.match(/(?:PortableGit|Git)[\\/](.+)$/i);
    r = afterGit ? afterGit[1] : r.split(/[\\/]/).filter(Boolean).pop();
  }
  r = r.replace(/\\/g, '/');
  if (!r.startsWith('/')) r = `/${r}`;
  return r;
}

const ROUTE = normalizeRoute(process.argv[2]);
const OUT = process.argv[3] || 'shot.png';
const BASE = process.argv[4] || 'http://127.0.0.1:3300';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const login = await fetch(`${BASE}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  if (login.code !== 1) throw new Error('后台登录失败：' + login.msg);
  const token = login.data.token;

  const profile = mkdtempSync(join(tmpdir(), 'shot-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1100',
    'about:blank',
  ]);

  await sleep(2200);
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('没有可用的 page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errs = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  // 登录态要在 app 启动前就写进 localStorage，否则带 hash 的路由会先被打到登录页
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
  });
  await send('Page.navigate', { url: `${BASE}/admin/#${ROUTE}` });
  await sleep(5000);

  // 后台是「侧边栏 + 内部滚动容器」布局，documentElement 不会随内容变高，
  // 直接用 scrollHeight 会把下半页截掉。这里把视口临时拉高，让内容整体撑开。
  const H = Number(process.env.SHOT_H || 2600);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(700);

  // 可选：截图前先点一下某个元素（例如展开弹窗、切到某个 tab）
  if (process.env.SHOT_CLICK) {
    await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(process.env.SHOT_CLICK)});
        if (el) el.click();
        return !!el;
      })()`,
      returnByValue: true,
    });
    await sleep(900);
  }

  const info = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      href: location.href,
      hash: location.hash,
      hasToken: !!localStorage.getItem('ADMIN_TOKEN'),
      h: document.documentElement.scrollHeight,
      w: document.documentElement.scrollWidth,
      // 视口拉高后按最后一个面板的底边裁剪，避免截图底部留一大片空白
      contentH: (() => {
        let max = 0;
        document.querySelectorAll('.page-head, .stat-grid, .panel').forEach((e) => {
          max = Math.max(max, e.getBoundingClientRect().bottom);
        });
        return Math.ceil(max + 26);
      })(),
      title: (document.querySelector('.page-head h2') || {}).textContent || '',
    })`,
    returnByValue: true,
  });
  const meta = JSON.parse(info.result.value);
  console.log('页面状态：', JSON.stringify(meta));
  if (!meta.href.includes(`#${ROUTE}`)) throw new Error(`路由未命中，实际停在 ${meta.href}`);

  const shotH = Math.min(Math.max(meta.contentH || 0, 600), H);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: meta.w, height: shotH, scale: 1 },
  });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`已保存 ${OUT}  ${meta.w}x${shotH}`);
  if (errs.length) console.log('页面报错：\n  ' + errs.slice(0, 6).join('\n  '));

  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

main().catch((e) => {
  console.error('截图失败：', e.message);
  process.exit(1);
});
