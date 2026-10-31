/**
 * 「提现彻底封死」验收：H5 路由 + 后备接口 + 配置三处都要通不过。
 *
 * 覆盖：
 *   1. 库里四个提现通道都是关闭（20）
 *   2. 接口 getSystemInfo 的 withdraw_methods 全是 false
 *   3. 接口 /finance/withdraw/apply 直接打也报「提现功能暂未开放」（通道关 = 后端兜住）
 *   4. H5：直连 #/withdraw 会被兜回首页，不再白屏
 *   5. H5：钱包页只剩「佣金明细」，没有「申请提现」
 *   6. H5：我的页面没有任何提现入口
 *
 * 用临时会员（临时给余额）+ 演示库，跑完全删。
 *
 * 用法: node scripts/probe/withdraw-closed.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9519;
const PHONE = '13911000019';
const PWD = 'wc123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { run, get } = await import('../../server/src/db.js');
const CHANNELS = ['withdraw_wx_open', 'withdraw_zfb_open', 'withdraw_bank_open', 'withdraw_offline_open'];

let memberId = 0;
function cleanup() {
  if (!memberId) return;
  for (const t of ['finance_energy', 'finance_withdraw', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
    run(`DELETE FROM ${t} WHERE member_id = ?`, memberId);
  }
  run('DELETE FROM member WHERE member_id = ?', memberId);
}

async function main() {
  cleanup();

  // ---------- 1. 配置 ----------
  console.log('[1] 通道配置')
  for (const k of CHANNELS) {
    const v = get('SELECT `value` v FROM setting_config WHERE `key` = ?', k)?.v;
    check(`${k} = 20（关闭）`, String(v) === '20', String(v));
  }

  // ---------- 2. 临时会员 ----------
  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '通道封禁验收' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!memberId || !token) throw new Error('临时会员准备失败');
  // 给余额，才能越过「余额不足」走到通道校验
  run('UPDATE member SET amount = 1000 WHERE member_id = ?', memberId);

  // ---------- 3. 接口 ----------
  console.log('\n[2] 接口')
  const sys = await fetch(`${API}/api/finance/getSystemInfo`, { headers: { token } }).then((r) => r.json());
  const methods = sys.data?.withdraw_methods || {};
  check('getSystemInfo 四个通道全 false',
    !methods.wx && !methods.zfb && !methods.bank && !methods.offline, JSON.stringify(methods));

  const apply = await fetch(`${API}/api/finance/withdraw/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ amount: 100, account_type: 4, account_info: '线下打款' }),
  }).then((r) => r.json());
  check('直接打提现申请接口被拒', apply.code === 0, apply.msg);
  check('提示是「提现功能暂未开放」', /暂未开放/.test(apply.msg || ''), apply.msg);
  const wdCount = Number(get('SELECT COUNT(*) c FROM finance_withdraw WHERE member_id = ?', memberId).c);
  check('没有产生提现单', wdCount === 0, String(wdCount));
  check('余额没被冻结', Number(get('SELECT amount a FROM member WHERE member_id = ?', memberId)?.a) === 1000);

  // 另外三种方式也逐一试，确认不是只挡住了线下
  for (const [type, label] of [[1, '微信'], [2, '支付宝'], [3, '银行卡']]) {
    const r = await fetch(`${API}/api/finance/withdraw/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token },
      body: JSON.stringify({ amount: 100, account_type: type, account_info: 'x' }),
    }).then((x) => x.json());
    check(`${label}通道同样被拒`, r.code === 0, r.msg);
  }

  // ---------- 4. 页面 ----------
  const profile = mkdtempSync(join(tmpdir(), 'wdclosed-'));
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
  const go = async (url) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url });
    await sleep(4200);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });

    console.log('\n[3] 页面')
    await go(`${H5}/#/withdraw`);
    const wd = await evaluate(`(() => ({
      hash: location.hash,
      text: document.body.innerText.replace(/\\s+/g,' ').slice(0, 120),
      hasWithdrawPage: !!document.querySelector('.wpage, .withdraw, .wall__card'),
    }))()`);
    check('#/withdraw 被兜回首页', wd.hash === '#/' || wd.hash === '', `hash=${wd.hash}`);
    check('没有渲染出提现页', wd.hasWithdrawPage === false, wd.text);
    await mkdirSafe();
    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(process.cwd(), '_probe', 'withdraw-closed-redirect.png'), Buffer.from(s.data, 'base64'));
    } catch {}

    await go(`${H5}/#/wallet`);
    const wallet = await evaluate(`(() => ({
      btns: [...document.querySelectorAll('.wall__btns button')].map((b) => b.textContent.trim()),
      body: document.body.innerText.replace(/\\s+/g,' '),
    }))()`);
    check('钱包页没有「申请提现」', !wallet.body.includes('申请提现'), wallet.btns.join('/'));
    check('钱包页保留「佣金明细」', wallet.btns.some((t) => t.includes('佣金明细')), wallet.btns.join('/'));
    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(process.cwd(), '_probe', 'withdraw-closed-wallet.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/withdraw-closed-*.png');
    } catch {}

    await go(`${H5}/#/mine`);
    const mine = await evaluate(`(() => document.body.innerText.replace(/\\s+/g,' '))()`);
    check('我的页面没有「提现」字样', !mine.includes('提现'), mine.slice(0, 100));

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已清理临时会员');
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

async function mkdirSafe() {
  mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  try { cleanup(); } catch {}
  process.exit(1);
});
