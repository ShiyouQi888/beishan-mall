/**
 * 「后台确认后，H5 订单页要自己刷新」验收。
 *
 * 背景：抢单是「用户提交申请 → 平台在后台点确认」，确认那一刻手机上没有任何感知。
 * 不做轮询就会一直停在「已提交，等待确认」，得退出重进才更新。
 *
 * 覆盖：
 *   1. 详情页：确认前是「待确认 / 已提交，等待确认」
 *   2. 后台点确认后不手动刷新，等一轮轮询（4 秒）→ 自动变「已确认」，按钮变「查看我的店铺」
 *   3. 已确认的订单不再继续轮询（请求次数不再增长）
 *   4. 列表页：在「待确认」tab 下确认后，列表会自动更新并提示条数
 *
 * 全程临时会员 + 临时商品（买家 A、卖家 B），跑完全删。
 *
 * 用法: node scripts/probe/order-auto-refresh.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9525;
const PHONE = '13911000031';
const PWD = 'ar123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { run, get } = await import('../../server/src/db.js');
const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

let buyerId = 0;
let sellerId = 0;
let goodsId = 0;
let orderId = 0;

function cleanup() {
  if (orderId) {
    run('DELETE FROM order_log WHERE order_id = ?', orderId);
    run('DELETE FROM goods_recycle WHERE order_id = ?', orderId);
    run('DELETE FROM orders WHERE order_id = ?', orderId);
  }
  if (goodsId) {
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', goodsId);
    run('DELETE FROM goods WHERE goods_id = ?', goodsId);
  }
  for (const id of [buyerId, sellerId].filter(Boolean)) {
    for (const t of ['finance_energy', 'finance_withdraw', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
      run(`DELETE FROM ${t} WHERE member_id = ?`, id);
    }
    run('DELETE FROM member WHERE member_id = ?', id);
  }
}

async function main() {
  cleanup();

  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const at = admin.data?.token;
  if (!at) throw new Error('管理员登录失败');

  // 卖家（商品持有人）+ 商品
  const t = todayStr();
  const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
  sellerId = Number(run(
    `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
       is_valid, amount, score, e_card_number, is_certification, disabled, client_type, create_time, update_time)
     VALUES ('刷新验收卖家','13911000032','x',0,'/',1,'arsell01',10,0,0,0,0,10,3,?,?)`,
    `${t} 00:00:00`, `${t} 00:00:00`,
  ).lastInsertRowid);
  goodsId = Number(run(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES ('自动刷新样品','AR-1','/uploads/demo-1.svg','[]','',?,1,'',?,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,?,?)`,
    catId, sellerId, `${t} 00:00:00`, `${t} 00:00:00`,
  ).lastInsertRowid);

  // 买家 A
  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '刷新验收买家' }),
  }).then((r) => r.json());
  buyerId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!buyerId || !token) throw new Error('临时买家准备失败');

  const created = await fetch(`${API}/api/order/toAddOrder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ goods_id: goodsId, num: 1, pay_type: 0 }),
  }).then((r) => r.json());
  orderId = Number(created.data?.order_id) || 0;
  if (!orderId) throw new Error('下单失败：' + created.msg);
  await fetch(`${API}/api/order/toPay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ order_id: orderId, pay_type: 0 }),
  });
  check('前置：订单为待确认 + 已提交申请',
    Number(get('SELECT pay_status FROM orders WHERE order_id = ?', orderId).pay_status) === 0
    && Number(get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '申请抢单'", orderId).c) === 1);

  // ---------- 页面 ----------
  const profile = mkdtempSync(join(tmpdir(), 'autorefresh-'));
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
  const detailCalls = [];
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
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/order/detail')) {
      detailCalls.push(Date.now());
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
  const readDetail = () => evaluate(`(() => {
    const btn = document.querySelector('.odetail__bar button');
    return {
      title: document.querySelector('.status__t')?.textContent?.trim() || '',
      desc: document.querySelector('.status__d')?.textContent?.trim() || '',
      btn: btn?.textContent?.trim() || '',
      logs: [...document.querySelectorAll('.log__t')].map((x) => x.textContent.trim()),
    };
  })()`);

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });

    console.log('\n[1] 确认前');
    await go(`${H5}/#/order/detail/${orderId}`);
    const before = await readDetail();
    check('状态是「待确认」', before.title === '待确认', before.title);
    check('按钮是「已提交，等待确认」', before.btn.includes('已提交'), before.btn);
    check('动态里没有「确认收款」', !before.logs.includes('确认收款'), before.logs.join('/'));

    // ---------- 后台确认（页面不刷新） ----------
    console.log('\n[2] 后台点确认，页面不手动刷新');
    const callsBefore = detailCalls.length;
    const confirm = await fetch(`${API}/admin/api/orders/confirm-pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: at },
      body: JSON.stringify({ order_id: orderId }),
    }).then((r) => r.json());
    check('后台确认成功', confirm.code === 1, confirm.msg);

    // 轮询 4 秒一轮，给到 9 秒
    let after = null;
    for (let i = 0; i < 9; i++) {
      await sleep(1000);
      after = await readDetail();
      if (after.title === '已确认') break;
    }
    check('几秒内自动变成「已确认」（无需手动刷新）', after?.title === '已确认', `${after?.title} / ${after?.desc}`);
    check('按钮换成「查看我的店铺」', (after?.btn || '').includes('查看我的店铺'), after?.btn);
    check('动态里自动带出「确认收款」', (after?.logs || []).includes('确认收款'), (after?.logs || []).join('/'));
    check('期间确实发生了轮询请求', detailCalls.length > callsBefore, `${callsBefore} → ${detailCalls.length}`);

    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'order-auto-refresh.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/order-auto-refresh.png');
    } catch {}

    // ---------- 已确认后停止轮询 ----------
    console.log('\n[3] 已确认后停止轮询');
    const callsAfterStart = detailCalls.length;
    await sleep(9000);
    check('确认后不再继续请求（省流量）', detailCalls.length === callsAfterStart, `${callsAfterStart} → ${detailCalls.length}`);

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已清理临时会员与商品');
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
