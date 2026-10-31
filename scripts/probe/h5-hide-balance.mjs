/**
 * 会员端余额隐藏验收：个人中心 / 钱包 / 提现三处都不能再出现余额数字。
 *
 * 给临时会员充 5000，然后逐页检查——如果哪页还漏出余额，用「页面出现 5000」就能抓到。
 * 跑完删掉临时会员。
 *
 * 用法: node scripts/probe/h5-hide-balance.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9451;
const PHONE = '13970000001';
const PWD = 'hb123456';
const BALANCE = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run, get } = await import('../../server/src/db.js');
let memberId = 0;

function cleanup() {
  if (!memberId) return;
  for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
    run(`DELETE FROM ${t} WHERE member_id = ?`, memberId);
  }
  run('DELETE FROM member WHERE member_id = ?', memberId);
}

async function main() {
  cleanup();

  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const at = admin.data.token;

  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '余额隐藏验收' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  if (!memberId) throw new Error('临时会员创建失败：' + reg.msg);

  await fetch(`${API}/admin/api/member/adjust`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token: at },
    body: JSON.stringify({ member_id: memberId, field: 'amount', value: BALANCE, remark: '余额隐藏验收充值' }),
  });
  const bal = Number(get('SELECT amount FROM member WHERE member_id = ?', memberId).amount);
  check(`临时会员余额已充到 ${BALANCE}`, bal === BALANCE, String(bal));

  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!token) throw new Error('临时会员登录失败：' + lg.msg);

  const profile = mkdtempSync(join(tmpdir(), 'hidebal-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=420,900', 'about:blank',
  ]);
  await sleep(2200);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = targets.find((x) => x.type === 'page');
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

  const open = async (hash, sel = '') => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url: `${H5}/#${hash}` });
    await sleep(4200);
    // 只取指定区域：资金流水里出现「+5000.00」是记录本身，不是余额展示，不能算漏。
    // sel 为空时不能直接 querySelector('')，那是无效选择器会抛错。
    return evaluate(`(() => {
      const sel = ${JSON.stringify(sel)};
      const root = sel ? document.querySelector(sel) : null;
      return ((root || document.body).innerText || '').replace(/\\s+/g, ' ');
    })()`);
  };
  const shoot = async (name) => {
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', `${name}.png`), Buffer.from(shot.data, 'base64'));
    } catch {}
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    // ---- 个人中心 ----
    console.log('\n[1] 个人中心');
    const mine = await open('/mine');
    check('不再出现「账户余额」字样', !mine.includes('账户余额'), mine.slice(0, 120));
    check('不出现余额数字 5000', !mine.includes('5000'), mine.slice(0, 120));
    check('「我的佣金」仍在', mine.includes('我的佣金'));
    await shoot('hide-balance-mine');

    // ---- 钱包 ----
    console.log('\n[2] 我的钱包');
    const walletCard = await open('/wallet', '.wall__card');
    check('钱包卡片不再出现「账户余额」', !walletCard.includes('账户余额'), walletCard.slice(0, 160));
    check('钱包卡片不出现余额数字', !walletCard.includes('5000'), walletCard.slice(0, 160));
    check('收益/佣金统计仍在', walletCard.includes('今日收益') && walletCard.includes('佣金'));
    const walletAll = await evaluate(`document.body.innerText`);
    check('资金流水仍在（记录里出现金额属正常）', walletAll.includes('资金流水') && walletAll.includes('+5000.00'));
    await shoot('hide-balance-wallet');

    // ---- 提现（模块已下线，入口与路由都封了）----
    console.log('\n[3] 申请提现（已下线）');
    const wd = await open('/withdraw');
    // 路由已改 history 模式，用 pathname 判断有没有被兜回首页
    const wdPath = await evaluate('location.pathname');
    check('提现页已下线，路由被兜回首页', wdPath !== '/withdraw', `path=${wdPath}`);
    check('兜回后不再出现「可提现余额」', !wd.includes('可提现余额'), wd.slice(0, 120));
    check('不出现余额数字 5000.00', !wd.includes('5000.00'), wd.slice(0, 120));
    check('没有提现输入框与「全部提现」', !wd.includes('全部提现'));
    await shoot('hide-balance-withdraw');

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已删除临时会员');
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  try { cleanup(); } catch {}
  process.exit(1);
});
