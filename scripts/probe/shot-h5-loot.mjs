/**
 * H5 抢购页截图 + 状态断言：确认「场次已开放」时商品不再是「未开始」。
 *
 * 用法: node scripts/probe/shot-h5-loot.mjs [输出文件]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || '_probe/h5-loot.png';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9391;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'h5loot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=420,900', 'about:blank',
]);

await sleep(2200);
const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
if (!target) throw new Error('没有可用 page target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
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
  }
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `${H5}/loot` });
await sleep(5200);

const info = await send('Runtime.evaluate', {
  expression: `(() => {
    const root = document.querySelector('.loot') || document.body;
    const text = root.innerText;
    return {
      hasUpcoming: text.includes('未开始'),
      hasToStart: text.includes('距开始'),
      snippet: text.slice(0, 200).replace(/\\n+/g, ' | '),
    };
  })()`,
  returnByValue: true,
});
const v = info.result.value;
console.log('页面文案：', v.snippet);
console.log(v.hasUpcoming ? '✗ 仍出现「未开始」' : '✓ 没有「未开始」');
console.log(v.hasToStart ? '✗ 仍出现「距开始」' : '✓ 没有「距开始」');

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('截图:', OUT);

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
