/**
 * H5 商品详情：提前抢购的展示联调。
 *
 * 构造：场次改成「2 分钟后开抢」→ 普通会员看详情应显示「当前不在抢购时间」；
 * 同一个会员开通「提前 3 分钟」后再看，应出现「提前抢购中」提示条且按钮可点。
 * 跑完把场次和资格全部还原，并删掉临时会员。
 *
 * 用法: node scripts/probe/advance-h5.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9431;
const PHONE = '13930000001';
const PWD = 'adv123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run } = await import('../../server/src/db.js');
const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

const origin = db.prepare('SELECT start_time, end_time, open_days, transposition_hours FROM specialarea WHERE specialarea_id = 1').get();
let memberId = 0;
let goodsId = 0;

function cleanup() {
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
  run('UPDATE specialarea SET start_time = ?, end_time = ?, open_days = ?, transposition_hours = ? WHERE specialarea_id = 1',
    origin.start_time, origin.end_time, origin.open_days, origin.transposition_hours);
}

async function main() {
  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const at = admin.data.token;

  // 场次：2 分钟后开抢
  const today = todayStr();
  const b = new Date(Date.now() + 8 * 3600 * 1000);
  const secOfDay = b.getUTCHours() * 3600 + b.getUTCMinutes() * 60 + b.getUTCSeconds();
  if (secOfDay > 82000) throw new Error('当前北京时间太晚，无法构造「2 分钟后开抢」场景');
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  run('UPDATE specialarea SET start_time = ?, end_time = ?, open_days = ?, transposition_hours = 0 WHERE specialarea_id = 1',
    secOfDay + 120, secOfDay + 1020, `${dow === 0 ? 7 : dow}`);
  console.log('场次已改为 2 分钟后开抢\n');

  // 用一条「只挂这一场」的临时商品：演示库里的商品可能同时挂着下午场，
  // 而下午场此刻是开放的，那样提前抢购根本无从体现。
  const t = todayStr();
  const g = db.prepare(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES ('提前验收样品','ADVH5-1','/uploads/demo-1.svg','[]','',1,1,'',1,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,?,?)`,
  ).run(t, t);
  goodsId = Number(g.lastInsertRowid);
  run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', goodsId);
  const GOODS_ID = goodsId;

  // 临时会员
  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '提前验收临时' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(db.prepare('SELECT member_id FROM member WHERE mobile = ?').get(PHONE)?.member_id);
  if (!memberId) throw new Error('临时会员创建失败：' + reg.msg);

  const login = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = login.data?.token;
  if (!token) throw new Error('临时会员登录失败：' + login.msg);

  const profile = mkdtempSync(join(tmpdir(), 'advh5-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=420,900', 'about:blank',
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
  const pageState = () => evaluate(`(() => {
    const banner = document.querySelector('.detail__advance');
    const btn = document.querySelector('.bar-btn');
    const tip = document.querySelector('.detail__state');
    return {
      banner: banner ? banner.textContent.replace(/\\s+/g, ' ').trim() : '',
      btnText: btn ? btn.textContent.replace(/\\s+/g, ' ').trim() : '',
      btnDisabled: btn ? !!btn.disabled : null,
      tip: tip ? tip.textContent.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);
  const openPage = async () => {
    // 直接 navigate 到同一个 hash 地址，SPA 不会重新挂载，详情还是上一轮的。
    // 先跳 about:blank 再回来，保证是全新文档 + 重新发一次详情请求。
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(400);
    await send('Page.navigate', { url: `${H5}/#/goods/${GOODS_ID}` });
    await sleep(4500);
    return pageState();
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    // 详情是 GET，浏览器会对没有 Cache-Control 的响应做启发式缓存，
    // 刷新后仍拿到「未开通」那份旧数据 —— 必须先关掉缓存才能验证真实链路。
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    // ---- 未开通：应显示不可购买 ----
    console.log('[1] 未开通提前抢购');
    const s1 = await openPage();
    check('不显示「提前抢购中」提示条', s1.banner === '', JSON.stringify(s1.banner));
    check('按钮是禁用的', s1.btnDisabled === true, String(s1.btnDisabled));
    check('按钮文案是「当前不在抢购时间」', s1.btnText.includes('不在抢购时间'), s1.btnText);
    check('给出了不可购买的原因', s1.tip.length > 0, s1.tip);

    // ---- 开通 3 分钟 ----
    console.log('\n[2] 开通「提前 3 分钟」后');
    const on = await fetch(`${API}/admin/api/member/advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: at },
      body: JSON.stringify({ member_id: memberId, enable: true, count: 0, minutes: 3 }),
    }).then((r) => r.json());
    check('后台开通成功', on.code === 1, on.msg);

    // 先用 Node 直连接口确认后端口径，再看页面 —— 出问题能立刻分清是哪一端
    const direct = await fetch(`${API}/api/goods/shopgoods/getDetails?goods_id=${GOODS_ID}`, {
      headers: { token },
    }).then((r) => r.json());
    check('接口层：会员看到 advance_open = 1', direct.data?.advance_open === 1,
      JSON.stringify({ advance_open: direct.data?.advance_open, advance_seconds: direct.data?.advance_seconds, is_ordinary_order: direct.data?.is_ordinary_order }));

    const s2 = await openPage();
    const pageToken = await evaluate(`(() => {
      const t = localStorage.getItem('TOKEN') || '';
      return { has: t.length > 0 };
    })()`);
    check('页面里有登录态', pageToken.has === true, JSON.stringify(pageToken));
    check('出现「提前抢购中」提示条', s2.banner.includes('提前抢购中'), s2.banner);
    check('提示条写明提前 3 分钟', s2.banner.includes('3 分钟'), s2.banner);
    check('按钮变为可点', s2.btnDisabled === false, String(s2.btnDisabled));
    check('按钮文案变为「提前抢购」', s2.btnText.includes('提前抢购'), s2.btnText);

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'advance-h5.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/advance-h5.png');
    } catch {}

    // ---- 关掉资格，应立刻回到不可购买 ----
    console.log('\n[3] 关闭后立刻失效');
    await fetch(`${API}/admin/api/member/advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: at },
      body: JSON.stringify({ member_id: memberId, enable: false }),
    });
    const s3 = await openPage();
    check('提示条消失', s3.banner === '', JSON.stringify(s3.banner));
    check('按钮重新变灰', s3.btnDisabled === true, String(s3.btnDisabled));

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已还原场次设置并删除临时会员');
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
