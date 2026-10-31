/**
 * 「交易设置里的提现通道全部隐藏」验收。
 *
 * 覆盖：
 *   1. 接口：trade 组的 items 里没有 6 个 withdraw_* 键，也没有任何文案带「提现」的项
 *   2. 接口：结算/回收/转拍等交易配置项一个都没少
 *   3. 页面：交易设置页整页不再出现「提现」二字，表单项数量与接口一致
 *   4. 兼容：老前端/脚本继续提交隐藏键不会报错，且库里的值不会被改掉
 *
 * 只读 + 一次「用原值回写」的保存，不造任何数据。
 *
 * 用法: node scripts/probe/setting-hide-withdraw.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const ADMIN = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9515;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db } = await import('../../server/src/db.js');
const HIDDEN = ['withdraw_wx_open', 'withdraw_zfb_open', 'withdraw_bank_open', 'withdraw_offline_open', 'withdraw_min', 'withdraw_fee'];
// 交易设置里必须还在的项（挑各段各一个，防止过滤写宽了把正经配置一起藏掉）
const KEEP = ['service_charge', 'require_invite_code', 'order_pay_timeout', 'price_increase_rate', 'listing_fee_rate', 'drive_award_rate', 'consignment_open', 'consignment_rule', 'recycle_open', 'recycle_daily_cap'];

const snapshot = () => Object.fromEntries(HIDDEN.map((k) => [k, db.prepare('SELECT `value` v FROM setting_config WHERE `key` = ?').get(k)?.v ?? null]));
const before = snapshot();

async function main() {
  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const token = admin.data?.token;
  if (!token) throw new Error('管理员登录失败');

  // ---------- 1. 接口 ----------
  console.log('[1] 接口：trade 组')
  const r = await fetch(`${API}/admin/api/setting/trade`, { headers: { token } }).then((x) => x.json());
  const items = r.data?.items || [];
  const keys = items.map((i) => i.k);
  check('接口正常返回', r.code === 1 && items.length > 0, `${items.length} 项`);
  for (const k of HIDDEN) check(`items 里没有 ${k}`, !keys.includes(k));
  check('没有任何带「提现」的项', !items.some((i) => String(i.t || '').includes('提现')),
    items.filter((i) => String(i.t || '').includes('提现')).map((i) => i.t).join('/'));
  // values 仍按全量返回：老探针（e2e-chain 等）会回读 withdraw_fee，不能突然变 undefined
  check('values 仍保留隐藏键（老脚本兼容）', HIDDEN.every((k) => Object.prototype.hasOwnProperty.call(r.data?.values || {}, k)),
    Object.keys(r.data?.values || {}).filter((k) => k.startsWith('withdraw_')).join(','));
  for (const k of KEEP) check(`交易配置 ${k} 还在`, keys.includes(k));

  // ---------- 2. 兼容：提交隐藏键不报错、不改值 ----------
  console.log('\n[2] 兼容：老前端继续提交隐藏键')
  const legacy = {};
  for (const [k, v] of Object.entries(before)) legacy[k] = v;
  const saveR = await fetch(`${API}/admin/api/setting/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ group: 'trade', values: legacy }),
  }).then((x) => x.json());
  check('提交隐藏键仍返回成功', saveR.code === 1, saveR.msg);
  const after = snapshot();
  check('隐藏项的值一个都没被改掉', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));

  // ---------- 3. 页面 ----------
  console.log('\n[3] 页面：/setting/trade')
  const profile = mkdtempSync(join(tmpdir(), 'hidewithdraw-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1100', 'about:blank',
  ]);
  await sleep(2200);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((x) => x.json());
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
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result?.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url: `${ADMIN}/setting/trade` });
    await sleep(4600);

    const ui = await evaluate(`(() => {
      const labels = [...document.querySelectorAll('.setting-form .el-form-item__label')].map((x) => x.textContent.trim());
      return {
        labels,
        body: document.body.innerText.replace(/\\s+/g, ' '),
        desc: document.querySelector('.page-head .desc')?.textContent?.trim() || '',
      };
    })()`);
    check('页面表单项数量与接口一致', ui.labels.length === items.length, `页面 ${ui.labels.length} / 接口 ${items.length}`);
    check('页面没有「提现」字样', !ui.body.includes('提现'),
      ui.labels.filter((l) => l.includes('提现')).join('/') || '正文也不含');
    check('页面没有「最低提现金额」', !ui.labels.includes('最低提现金额'));
    check('页面没有「提现手续费(%)」', !ui.labels.includes('提现手续费(%)'));
    check('副标题不再提提现', !ui.desc.includes('提现'), ui.desc);
    check('交易项仍在页面上', ui.labels.includes('抢单服务费(%)') && ui.labels.includes('到顶自动回收'), ui.labels.slice(0, 4).join(' / '));

    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'setting-hide-withdraw.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/setting-hide-withdraw.png');
    } catch {}

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
