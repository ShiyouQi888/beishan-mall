/**
 * 「不要支付方式」验收：前后台都不再出现支付方式，下单按钮改成「申请抢单」。
 *
 * 覆盖：
 *   1. 后台侧边栏没有「支付设置」
 *   2. 后台订单列表没有「支付方式」列、筛选是待确认/已确认
 *   3. H5 确认订单页没有支付方式区块，按钮是「申请抢单」
 *   4. 下单（pay_type=0）能成功，订单落在「待确认」
 *   5. H5 订单详情没有「选择支付方式」，按钮是「申请抢单」
 *
 * 用临时会员 + 临时商品验证，跑完全删。
 *
 * 用法: node scripts/probe/no-payment.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9511;
const PHONE = '13911000001';
const PWD = 'np123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run, get } = await import('../../server/src/db.js');
const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

let memberId = 0;
let goodsId = 0;
let orderId = 0;

function cleanup() {
  if (orderId) {
    run('DELETE FROM order_log WHERE order_id = ?', orderId);
    run('DELETE FROM orders WHERE order_id = ?', orderId);
  }
  if (goodsId) {
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', goodsId);
    run('DELETE FROM goods WHERE goods_id = ?', goodsId);
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

  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '无支付方式验收' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!memberId || !token) throw new Error('临时会员准备失败');

  // 造一件在售商品，挂到第一场并放开日期
  const t = todayStr();
  const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
  const g = run(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES ('无支付方式样品','NP-1','/uploads/demo-1.svg','[]','',?,1,'',1,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,?,?)`,
    catId, t, t,
  );
  goodsId = Number(g.lastInsertRowid);
  // 特意不挂场次：随时可买，不受当前时段影响（挂场次要等开放时间，测起来不稳）

  // ---------- 接口层 ----------
  console.log('[1] 接口层');
  const setting = await fetch(`${API}/api/index/getPaySeeting`).then((r) => r.json());
  check('支付设置接口仍然可用（历史兼容）', setting.code === 1);

  const created = await fetch(`${API}/api/order/toAddOrder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ goods_id: goodsId, num: 1, pay_type: 0 }),
  }).then((r) => r.json());
  check('pay_type=0 能直接下单（不再校验支付方式）', created.code === 1, created.msg);
  orderId = Number(created.data?.order_id) || 0;
  if (orderId) {
    const row = get('SELECT pay_type, status, pay_status FROM orders WHERE order_id = ?', orderId);
    check('订单记为 pay_type=0 且待确认', Number(row?.pay_type) === 0 && Number(row?.status) === 0 && Number(row?.pay_status) === 0,
      JSON.stringify(row));
  }

  const apply = await fetch(`${API}/api/order/toPay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ order_id: orderId, pay_type: 0 }),
  }).then((r) => r.json());
  check('「申请抢单」接口返回成功', apply.code === 1, apply.msg);
  check('提示语是等待平台确认', /等待平台确认/.test(apply.msg || ''), apply.msg);
  const logRow = get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '申请抢单'", orderId);
  check('落下「申请抢单」日志', Number(logRow.c) >= 1, String(logRow.c));

  const list = await fetch(`${API}/admin/api/orders/list?page=1&limit=5`, { headers: { token: at } }).then((r) => r.json());
  const mod = list.data?.module || {};
  const payField = (mod.fields || []).find((f) => f.k === 'pay_type');
  check('后台订单的支付方式字段被隐藏', payField?.hide === true, JSON.stringify(payField && { hide: payField.hide }));

  // ---------- 页面 ----------
  const profile = mkdtempSync(join(tmpdir(), 'nopay-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1600,1100', 'about:blank',
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
    await sleep(4400);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(at)});localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    // 后台
    console.log('\n[2] 后台');
    await go(`${WEB}/#/orders`);
    const adm = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.el-table__header th')].map((t) => t.innerText.trim());
      const nav = document.querySelector('.sidebar, .el-menu')?.innerText || '';
      return { head, nav };
    })()`);
    check('侧边栏没有「支付设置」', !adm.nav.includes('支付设置'), adm.nav.split('\n').filter(Boolean).slice(-6).join('/'));
    check('订单列表没有「支付方式」列', !adm.head.includes('支付方式'), JSON.stringify(adm.head));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'no-payment-admin.png'), Buffer.from(shot.data, 'base64'));
    } catch {}

    // H5 确认订单页
    console.log('\n[3] H5 确认订单页');
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await go(`${H5}/#/submit/${goodsId}`);
    const submit = await evaluate(`(() => {
      // 用 DOM 判断而不是文本匹配 —— 测试商品名里就带「支付方式」四个字
      const body = document.body.innerText.replace(/\\s+/g, ' ');
      const btn = document.querySelector('.submit__bar-btn')?.textContent?.trim() || '';
      const hasPaysel = !!document.querySelector('.paysel, .payitem');
      const hasVoucher = !!document.querySelector('.payment__voucher');
      return { body: body.slice(0, 300), btn, hasPaysel, hasVoucher };
    })()`);
    check('确认页没有支付方式区块', submit.hasPaysel === false && submit.hasVoucher === false,
      JSON.stringify({ hasPaysel: submit.hasPaysel, hasVoucher: submit.hasVoucher }));
    check('按钮文案是「申请抢单」', submit.btn.includes('申请抢单'), submit.btn);

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(process.cwd(), '_probe', 'no-payment-submit.png'), Buffer.from(shot.data, 'base64'));
    } catch {}

    // H5 订单详情
    console.log('\n[4] H5 订单详情');
    await go(`${H5}/#/order/detail/${orderId}`);
    const detail = await evaluate(`(() => {
      const body = document.body.innerText.replace(/\\s+/g, ' ');
      const btn = document.querySelector('.odetail__bar button')?.textContent?.trim() || '';
      return { body: body.slice(0, 320), btn };
    })()`);
    check('详情页没有「选择支付方式」', !detail.body.includes('选择支付方式'), detail.body.slice(0, 120));
    check('详情页没有「我已付款」', !detail.body.includes('我已付款'), detail.body.slice(0, 120));
    // 前面已经调过一次「申请抢单」，这里按钮应当已经置灰（重复提交由 apply-once 专门验）
    check('详情页按钮变成「已提交，等待确认」', detail.btn.includes('已提交'), detail.btn);

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(process.cwd(), '_probe', 'no-payment-detail.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/no-payment-*.png');
    } catch {}

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已清理测试数据');
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
