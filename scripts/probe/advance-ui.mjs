/**
 * 后台「开通提前抢购」弹窗：UI 与接口的联动验证。
 *
 * 流程：会员列表 → 开通提前抢购 → 弹窗填 3 分钟 → 确认 → 列表显示「已开通 · 提前 3 分钟」
 *      → 再关闭 → 列表回到「未开通」。跑完一定把资格关掉，不留状态。
 *
 * 用法: node scripts/probe/advance-ui.mjs [会员昵称=云中客]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9421;
const NICK = process.argv[2] || '云中客';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  if (login.code !== 1) throw new Error('后台登录失败：' + login.msg);
  const token = login.data.token;

  const profile = mkdtempSync(join(tmpdir(), 'advui-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1600,1100', 'about:blank',
  ]);
  await sleep(2200);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.type === 'page');
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
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };

  const rowState = () => evaluate(`(() => {
    const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
    const row = rows.find((r) => r.innerText.includes(${JSON.stringify(NICK)}));
    if (!row) return null;
    const cells = [...row.querySelectorAll('td')].map((c) => c.innerText.trim());
    const btn = [...row.querySelectorAll('button')].map((b) => b.textContent.trim());
    return { cells, btn };
  })()`);

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: `${WEB}/#/member` });
    await sleep(4500);

    // 搜索定位到目标会员，避免翻页
    await evaluate(`(() => {
      const input = document.querySelector('.page-head input, .toolbar input, input[placeholder*="搜索"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(NICK)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      }
    })()`);
    await sleep(1500);

    const before = await rowState();
    check('会员列表找到目标会员', !!before, NICK);
    check('初始状态显示「未开通」', !!before && before.cells.some((c) => c.includes('未开通')), JSON.stringify(before?.cells));

    // 点「开通提前抢购」
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const row = rows.find((r) => r.innerText.includes(${JSON.stringify(NICK)}));
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('开通提前抢购'));
      if (btn) btn.click();
    })()`);
    await sleep(1200);

    const dlg = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      if (!d) return null;
      return {
        title: d.querySelector('.el-dialog__title')?.textContent?.trim() || '',
        hasMinutes: !!d.querySelector('.el-input-number'),
        quick: [...d.querySelectorAll('.advance-quick button')].map((b) => b.textContent.trim()),
        tip: d.querySelector('.advance-tip')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
      };
    })()`);
    check('弹出「开通提前抢购」弹窗', !!dlg && dlg.title.includes('提前抢购'), JSON.stringify(dlg?.title));
    check('弹窗里有提前分钟数输入', dlg?.hasMinutes === true);
    check('提供 1/3/5/10 分钟快捷按钮', JSON.stringify(dlg?.quick) === JSON.stringify(['提前 1 分钟', '提前 3 分钟', '提前 5 分钟', '提前 10 分钟']), JSON.stringify(dlg?.quick));

    // 点「提前 3 分钟」再提交
    await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      const b = [...d.querySelectorAll('.advance-quick button')].find((x) => x.textContent.includes('3 分钟'));
      if (b) b.click();
    })()`);
    await sleep(400);
    const tipAfter = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      return d?.querySelector('.advance-tip')?.textContent?.replace(/\\s+/g, ' ').trim() || '';
    })()`);
    check('说明文字随选择实时更新', tipAfter.includes('3 分钟'), tipAfter.slice(0, 40));

    await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      const b = [...d.querySelectorAll('.el-dialog__footer button')].find((x) => x.textContent.trim() === '开通');
      if (b) b.click();
    })()`);
    await sleep(2000);

    const after = await rowState();
    const stateCell = after?.cells.find((c) => c.includes('已开通') || c.includes('未开通')) || '';
    check('列表显示「已开通 · 提前 3 分钟」', stateCell.includes('已开通') && stateCell.includes('3 分钟'), stateCell);

    // 落库校验
    const member = await fetch(`${API}/admin/api/member/list?page=1&limit=50&keyword=${encodeURIComponent(NICK)}`, {
      headers: { token },
    }).then((r) => r.json());
    const row = (member.data?.data || []).find((m) => m.nick_name === NICK);
    check('数据库 advance_seconds = 180', Number(row?.advance_seconds) === 180, String(row?.advance_seconds));
    check('列表接口回显 advance_minutes = 3', Number(row?.advance_minutes) === 3, String(row?.advance_minutes));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'advance-open.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/advance-open.png');
    } catch {}

    // 关闭，恢复原状
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const r = rows.find((x) => x.innerText.includes(${JSON.stringify(NICK)}));
      const btn = [...r.querySelectorAll('button')].find((b) => b.textContent.includes('关闭提前抢购'));
      if (btn) btn.click();
    })()`);
    await sleep(900);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.el-message-box__btns button')].find((x) => x.textContent.trim() === '确定');
      if (b) b.click();
    })()`);
    await sleep(1800);

    const closed = await rowState();
    const closedCell = closed?.cells.find((c) => c.includes('已开通') || c.includes('未开通')) || '';
    check('关闭后回到「未开通」', closedCell.includes('未开通'), closedCell);

    const member2 = await fetch(`${API}/admin/api/member/list?page=1&limit=50&keyword=${encodeURIComponent(NICK)}`, {
      headers: { token },
    }).then((r) => r.json());
    const row2 = (member2.data?.data || []).find((m) => m.nick_name === NICK);
    check('关闭后提前量清零', Number(row2?.advance_seconds) === 0 && Number(row2?.is_advance) !== 10, `${row2?.is_advance}/${row2?.advance_seconds}`);

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  process.exit(1);
});
