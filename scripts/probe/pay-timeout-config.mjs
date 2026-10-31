/**
 * 「确认时限」能否在后台改：页面可见 → 改值 → 保存 → 生效 → 改回。
 *
 * 跑完把值还原成原来的，不留痕迹。
 *
 * 用法: node scripts/probe/pay-timeout-config.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9501;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db } = await import('../../server/src/db.js');
const original = Number(db.prepare("SELECT `value` v FROM setting_config WHERE `key` = 'order_pay_timeout'").get()?.v ?? 30);

async function main() {
  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const token = login.data.token;

  const profile = mkdtempSync(join(tmpdir(), 'paytimeout-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1500,1100', 'about:blank',
  ]);
  await sleep(2200);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errs = [];
  const send = (m, p = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method: m, params: p }));
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
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: `${WEB}/setting/trade` });
    await sleep(4500);

    const label = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.el-form-item')];
      const el = items.find((i) => (i.querySelector('.el-form-item__label')?.textContent || '').includes('确认时限'));
      if (!el) return null;
      const input = el.querySelector('input');
      return {
        title: el.querySelector('.el-form-item__label').textContent.trim(),
        value: input ? Number(input.value) : null,
        tip: el.querySelector('.el-form-item__tip, .tip, .hint')?.textContent?.trim() || '',
      };
    })()`);
    check('后台交易设置里有「确认时限(分钟)」', !!label, JSON.stringify(label?.title));
    check('当前值读到了', label?.value === original, `${label?.value} vs 库里 ${original}`);

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'pay-timeout-config.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/pay-timeout-config.png');
    } catch {}

    // 在页面上改成 5 分钟再保存
    const changed = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.el-form-item')];
      const el = items.find((i) => (i.querySelector('.el-form-item__label')?.textContent || '').includes('确认时限'));
      const input = el?.querySelector('input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
      setter.call(input, '5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);
    check('能在页面上改数字', changed === true);
    await sleep(400);

    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存设置'));
      if (btn) btn.click();
    })()`);
    await sleep(1800);

    const saved = Number(db.prepare("SELECT `value` v FROM setting_config WHERE `key` = 'order_pay_timeout'").get()?.v);
    check('保存后库里变成 5', saved === 5, String(saved));

    const tc = await fetch(`${API}/api/index/getTradeConfig`).then((r) => r.json());
    check('前台接口同步返回 5', Number(tc.data?.pay_timeout) === 5, String(tc.data?.pay_timeout));

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    // 还原
    db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'order_pay_timeout'").run(String(original));
    console.log(`\n已还原确认时限为 ${original} 分钟`);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  try { db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'order_pay_timeout'").run(String(original)); } catch {}
  process.exit(1);
});
