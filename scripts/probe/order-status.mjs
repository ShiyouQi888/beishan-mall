/**
 * 发货环节下线验收：订单只看「已支付 / 未支付」。
 *
 * 覆盖：
 *   后台「全部订单」——状态列是已支付/未支付、筛选只有这两项、操作列没有发货
 *   会员端订单列表——tab 只有 全部/未支付/已支付，没有待发货/待收货
 *   会员端订单详情——没有快递行、状态显示已支付、没有确认收货按钮
 *
 * 用临时会员 + 一条临时订单（已支付）验证会员端，跑完全删。
 *
 * 用法: node scripts/probe/order-status.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9481;
const PHONE = '13981000001';
const PWD = 'os123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run, get } = await import('../../server/src/db.js');
let memberId = 0;
let orderId = 0;

function cleanup() {
  if (orderId) {
    run('DELETE FROM order_log WHERE order_id = ?', orderId);
    run('DELETE FROM orders WHERE order_id = ?', orderId);
  }
  if (memberId) {
    for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
      run(`DELETE FROM ${t} WHERE member_id = ?`, memberId);
    }
    run('DELETE FROM member WHERE member_id = ?', memberId);
  }
}

async function main() {
  cleanup();

  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const at = admin.data.token;

  // 临时会员 + 一条已支付订单
  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '订单状态验收' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  if (!memberId) throw new Error('临时会员创建失败：' + reg.msg);

  const g = get('SELECT goods_id, goods_name, good_thumb FROM goods ORDER BY goods_id LIMIT 1');
  const ins = run(
    `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
       num, total_price, service_charge, pay_type, pay_voucher, status, pay_status, type, is_examine, create_time, pay_time)
     VALUES (?,?,0,?,?,?,0,1,1000,20,4,'',10,10,1,10,?,?)`,
    `OS-${Date.now()}`, memberId, g.goods_id, g.goods_name, g.good_thumb || '', '2026-10-31 10:00:00', '2026-10-31 10:05:00',
  );
  orderId = Number(ins.lastInsertRowid);

  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!token) throw new Error('临时会员登录失败：' + lg.msg);

  const profile = mkdtempSync(join(tmpdir(), 'ordstat-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1600,1000', 'about:blank',
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
  const go = async (url) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url });
    await sleep(4300);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(at)});localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    // ---------- 后台订单列表 ----------
    console.log('[1] 后台全部订单');
    await go(`${WEB}/#/orders`);
    const adm = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.el-table__header th')].map((t) => t.innerText.trim());
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const opIdx = head.findIndex((h) => h.includes('操作'));
      const statusIdx = head.findIndex((h) => h.trim() === '状态');
      const ops = rows.map((r) => (r.querySelectorAll('td')[opIdx]?.innerText || '').replace(/\\s+/g, ' ').trim());
      const st = rows.map((r) => (r.querySelectorAll('td')[statusIdx]?.innerText || '').trim());
      return { head, ops, st, body: document.body.innerText };
    })()`);
    check('状态列存在', adm.head.includes('状态'), JSON.stringify(adm.head.slice(0, 10)));
    check('状态只显示待确认/已确认', adm.st.every((x) => x === '已确认' || x === '待确认'), JSON.stringify(adm.st));
    check('操作列没有「发货」', adm.ops.every((o) => !o.includes('发货')), JSON.stringify(adm.ops.slice(0, 3)));
    check('页面没有「待发货/待收货」字样', !adm.body.includes('待发货') && !adm.body.includes('待收货'));

    // 筛选下拉
    await evaluate(`(() => { const el=[...document.querySelectorAll('.el-select')].find(e=>e.innerText.includes('支付状态')||e.querySelector('.el-select__placeholder')); if(el) el.querySelector('.el-select__wrapper')?.click(); })()`);
    await sleep(600);
    const opts = await evaluate(`[...document.querySelectorAll('.el-select-dropdown__item')].map((x) => x.innerText.trim()).filter(Boolean)`);
    // 下拉里还混着分页的「10条/页」，只校验支付状态这一组
    const payOpts = opts.filter((o) => ['已确认', '待确认', '已支付', '未支付', '待付款', '待发货', '待收货', '已完成', '已取消'].includes(o));
    check('筛选下拉只有待确认/已确认', payOpts.length === 2 && payOpts.includes('已确认') && payOpts.includes('待确认'), JSON.stringify(payOpts));
    await evaluate(`document.body.click()`);
    await sleep(300);

    // ---------- 会员端订单列表 ----------
    console.log('\n[2] 会员端订单列表');
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await go(`${H5}/#/order`);
    const h5list = await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.otab, .tabs__item, [class*="tab"]')].map((x) => x.innerText.trim()).filter(Boolean);
      const body = document.body.innerText;
      return { tabs: [...new Set(tabs)], body: body.slice(0, 300) };
    })()`);
    check('会员端 tab 没有待发货/待收货', !h5list.body.includes('待发货') && !h5list.body.includes('待收货'), JSON.stringify(h5list.tabs));
    check('会员端出现「待确认」', h5list.body.includes('待确认'), JSON.stringify(h5list.tabs));
    check('会员端出现「已确认」', h5list.body.includes('已确认'), JSON.stringify(h5list.tabs));

    // ---------- 会员端订单详情 ----------
    console.log('\n[3] 会员端订单详情');
    await go(`${H5}/#/order/detail/${orderId}`);
    const h5detail = await evaluate(`(() => document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400))()`);
    check('详情没有「快递」行', !h5detail.includes('快递'), h5detail.slice(0, 120));
    check('详情没有「确认收货」', !h5detail.includes('确认收货'), h5detail.slice(0, 120));
    check('详情没有「备货/待发货」', !h5detail.includes('备货') && !h5detail.includes('待发货'), h5detail.slice(0, 120));
    check('详情状态为已确认', h5detail.includes('已确认'), h5detail.slice(0, 120));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'order-status-h5.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/order-status-h5.png');
    } catch {}

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已清理临时会员与订单');
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
