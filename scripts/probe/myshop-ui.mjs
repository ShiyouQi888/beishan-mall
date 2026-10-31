/**
 * 「我的店铺」收益展示：用用户截图里的那组数字复验。
 *
 * 买入价 9800 + 抢单服务费 196 = 实际成本 9996，下一轮标价 10094。
 *   旧算法：10094 − 9800 − 0 = +294   ← 服务费没算进去
 *   正确值：10094 − 9996 − 0 = +98
 *
 * 用临时会员 + 临时商品/订单复现，跑完全删，不动演示数据。
 * 用法: node scripts/probe/myshop-ui.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9441;
const PHONE = '13960000001';
const PWD = 'ms123456';
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

function cleanup() {
  if (goodsId) {
    const o = db.prepare('SELECT order_id FROM orders WHERE goods_id = ?').all(goodsId).map((x) => x.order_id);
    for (const id of o) {
      run('DELETE FROM order_log WHERE order_id = ?', id);
      run('DELETE FROM orders WHERE order_id = ?', id);
    }
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

  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '收益展示验收' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  if (!memberId) throw new Error('临时会员创建失败：' + reg.msg);

  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!token) throw new Error('临时会员登录失败：' + lg.msg);

  // 复现用户截图的那组数字：买 9800、服务费 196、已挂牌标价 10094、上架费 0
  const t = todayStr();
  const g = db.prepare(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES ('收益展示样品','MS-1','/uploads/demo-1.svg','[]','',1,1,'',?,10094,9800,0,0,1,1,1,10,10,0,3,100,1,0,0,?,?)`,
  ).run(memberId, t, t);
  goodsId = Number(g.lastInsertRowid);
  run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', goodsId);
  run(
    `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
       num, total_price, service_charge, pay_type, pay_voucher, status, pay_status, type, is_examine,
       consignment_status, listing_fee, transposition_time, pay_time, create_time)
     VALUES ('MS-ORDER-1', ?, 1, ?, '收益展示样品', '/uploads/demo-1.svg', 1, 1, 9800, 196, 1, '', 10, 10, 1, 10, 10, 0, ?, ?, ?)`,
    memberId, goodsId, `${t} 10:00:00`, `${t} 09:30:00`, t,
  );

  // 接口口径先对一遍
  const shop = await fetch(`${API}/api/member/myShop`, { headers: { token } }).then((r) => r.json());
  const item = (shop.data?.list || [])[0];
  check('接口：实际成本 = 买入价 + 服务费', Number(item?.my_cost) === 9996, String(item?.my_cost));
  check('接口：预计净收益 = 98（不是 294）', Number(item?.est_net) === 98, String(item?.est_net));
  check('接口：汇总也同步为 98', Number(shop.data?.summary?.total_net) === 98, String(shop.data?.summary?.total_net));

  const profile = mkdtempSync(join(tmpdir(), 'myshop-'));
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

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: `${H5}/my-shop` });
    await sleep(4500);

    const dom = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.kv')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
      const sum = document.querySelector('.sum__v.brand')?.textContent?.trim() || '';
      const tip = document.querySelector('.sum__tip');
      return { rows, sum, hasTip: !!tip, text: (document.querySelector('.item')?.innerText || '').replace(/\\s+/g, ' ') };
    })()`);

    // 只留「上架费」和「预计成交净赚」，中间过程全部不展示
    check('只保留「上架费」一行费用', dom.rows.some((r) => r.includes('上架费')), JSON.stringify(dom.rows));
    check('不再显示「我的买入价」', !dom.text.includes('我的买入价'), dom.text);
    check('不再显示「抢单服务费」', !dom.text.includes('抢单服务费'), dom.text);
    check('不再显示「下一轮标价」', !dom.text.includes('下一轮标价'), dom.text);
    check('不再显示「成交后可收回」', !dom.text.includes('成交后可收回'), dom.text);
    check('页面显示「预计成交净赚 +98.00」', dom.rows.some((r) => r.includes('预计成交净赚') && r.includes('98.00')), JSON.stringify(dom.rows));
    check('顶部预计收益为 98.00', dom.sum.includes('98.00'), dom.sum);
    check('顶部收益说明整块已去掉', dom.hasTip === false, String(dom.hasTip));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'myshop-profit.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/myshop-profit.png');
    } catch {}

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
