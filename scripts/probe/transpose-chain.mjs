/**
 * 转拍订单「买卖链路」验收。
 *
 * 造一件被倒过三手的货：m1 → m2 → m3 → m4（最后一手正在挂牌）。
 * 会员从库里取，不够 4 个就临时造（跑完删），不依赖演示库恰好有谁。
 * 验证：
 *   列表的「买卖链路」列显示「卖家 → 买家」
 *   详情弹窗的流转链路有三手，且当前这一手高亮
 *
 * 数据用完即删，不动演示库里的真实订单。
 *
 * 用法: node scripts/probe/transpose-chain.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9491;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run, get } = await import('../../server/src/db.js');
const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

let goodsId = 0;
// 演示库可能被清过，会员不够 4 个；缺的自己临时补，别依赖库里恰好有人
const tempMemberIds = [];
function cleanup() {
  if (goodsId) {
    const ids = db.prepare('SELECT order_id FROM orders WHERE goods_id = ?').all(goodsId).map((x) => x.order_id);
    for (const id of ids) {
      run('DELETE FROM order_log WHERE order_id = ?', id);
      run('DELETE FROM orders WHERE order_id = ?', id);
    }
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', goodsId);
    run('DELETE FROM goods WHERE goods_id = ?', goodsId);
    goodsId = 0;
  }
  for (const mid of tempMemberIds.splice(0)) {
    for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
      run(`DELETE FROM ${t} WHERE member_id = ?`, mid);
    }
    run('DELETE FROM member WHERE member_id = ?', mid);
  }
}

/** 取够 n 个会员，不足的临时造（跑完删） */
function ensureMembers(n, t) {
  const out = db.prepare('SELECT member_id, nick_name FROM member ORDER BY member_id LIMIT ?').all(n);
  let i = 0;
  while (out.length < n) {
    i += 1;
    const mid = Number(run(
      `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
         is_valid, amount, score, e_card_number, is_certification, disabled, client_type, create_time, update_time)
       VALUES (?,?,'x',0,'/',1,?,10,0,0,0,0,10,3,?,?)`,
      `链路验收${i}`, `1391100006${i}`, `chain0${i}`, `${t} 00:00:00`, `${t} 00:00:00`,
    ).lastInsertRowid);
    tempMemberIds.push(mid);
    out.push({ member_id: mid, nick_name: `链路验收${i}` });
  }
  return out;
}

async function main() {
  cleanup();

  const t = todayStr();
  const [m1, m2, m3, m4] = ensureMembers(4, t);
  // 后端对空昵称会兜底成「会员#id」，断言这边用同一套口径，否则库里有个没填昵称的账号就会假失败
  const dn = (m) => m.nick_name || `会员#${m.member_id}`;

  // 三手：m1 → m2 → m3 → m4，最后一手挂着等下一轮
  const g = db.prepare(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES ('链路验收样品','CHAIN-T-1','/uploads/demo-1.svg','[]','',1,1,'',?,3000,1000,0,0,1,1,3,10,10,0,3,100,1,0,0,?,?)`,
  ).run(m4.member_id, t, t);
  goodsId = Number(g.lastInsertRowid);
  run('INSERT INTO specialarea_goods (specialarea_id, goods_id, sort) VALUES (1, ?, 100)', goodsId);

  const chainSeed = [
    { seller: m1.member_id, buyer: m2.member_id, price: 2000 },
    { seller: m2.member_id, buyer: m3.member_id, price: 2500 },
    { seller: m3.member_id, buyer: m4.member_id, price: 3000 },
  ];
  let lastOrderId = 0;
  chainSeed.forEach((c, i) => {
    const info = run(
      `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
         num, total_price, service_charge, pay_type, pay_voucher, status, pay_status, type, is_examine,
         consignment_status, listing_fee, transposition_time, pay_time, create_time)
       VALUES (?,?,?,?,?,?,1,1,?,0,1,'',10,10,1,10,?,0,?,?,?)`,
      `CHAIN-T-${i + 1}`, c.buyer, c.seller, goodsId, '链路验收样品', '/uploads/demo-1.svg',
      c.price, i === chainSeed.length - 1 ? 10 : 0, `${t} 1${i}:00:00`, `${t} 1${i}:00:00`, `${t} 1${i}:00:00`,
    );
    if (i === chainSeed.length - 1) lastOrderId = Number(info.lastInsertRowid);
  });

  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const at = login.data.token;

  // ---------- 接口层 ----------
  const listRes = await fetch(`${API}/admin/api/transpose/list?range=all&limit=50`, { headers: { token: at } }).then((r) => r.json());
  const row = (listRes.data?.list || []).find((x) => Number(x.goods_id) === goodsId);
  check('列表能查到这条在挂单', !!row, JSON.stringify(listRes.data?.list?.length));
  if (row) {
    check('带出卖家', row.seller_name === m3.nick_name, `${row.seller_name} vs ${m3.nick_name}`);
    check('带出买家（转拍人）', row.buyer_name === m4.nick_name, `${row.buyer_name} vs ${m4.nick_name}`);
    check('带出买家手机号', !!row.buyer_mobile, row.buyer_mobile);
  }

  const detailRes = await fetch(`${API}/admin/api/transpose/detail?id=${lastOrderId}`, { headers: { token: at } }).then((r) => r.json());
  const chain = detailRes.data?.chain || [];
  check('详情返回三手链路', chain.length === 3, `${chain.length} 手`);
  if (chain.length === 3) {
    check(`第 1 手 ${dn(m1)} → ${dn(m2)}`, chain[0].seller_name === dn(m1) && chain[0].buyer_name === dn(m2),
      `${chain[0].seller_name}→${chain[0].buyer_name}`);
    check(`第 3 手 ${dn(m3)} → ${dn(m4)}`, chain[2].seller_name === dn(m3) && chain[2].buyer_name === dn(m4),
      `${chain[2].seller_name}→${chain[2].buyer_name}`);
    check('只有最后一手标记为当前', chain.filter((c) => c.current).length === 1 && chain[2].current === true,
      JSON.stringify(chain.map((c) => c.current)));
    check('链路带成交价', chain[2].price === 3000, String(chain[2].price));
  }
  check('详情带出卖家昵称', detailRes.data?.order?._seller === m3.nick_name, detailRes.data?.order?._seller);

  // ---------- 页面 ----------
  const profile = mkdtempSync(join(tmpdir(), 'chain-'));
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

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(at)})}catch(e){}`,
    });
    await send('Page.navigate', { url: `${WEB}/transpose` });
    await sleep(4300);

    const dom = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.el-table__header th')].map((t) => t.innerText.trim());
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const row = rows.find((r) => r.innerText.includes('链路验收样品'));
      return { head, text: row ? row.innerText.replace(/\\s+/g, ' ').trim() : '' };
    })()`);
    check('表头有「买卖链路」列', dom.head.includes('买卖链路'), JSON.stringify(dom.head));
    check('行里显示「卖家 → 买家」',
      dom.text.includes(dn(m3).slice(0, 2)) && dom.text.includes(dn(m4)) && dom.text.includes('→'), dom.text);

    // 列表截图（详情弹窗之前拍，能看到「买卖链路」列）
    try {
      const shot0 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'transpose-chain-list.png'), Buffer.from(shot0.data, 'base64'));
      console.log('截图: _probe/transpose-chain-list.png');
    } catch {}

    // 打开详情看链路
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const row = rows.find((r) => r.innerText.includes('链路验收样品'));
      const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '详情');
      if (btn) btn.click();
    })()`);
    await sleep(1500);
    const dlg = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      if (!d) return null;
      const lines = [...d.querySelectorAll('.chainline')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim());
      const cur = [...d.querySelectorAll('.chainline.is-current')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim());
      return { lines, cur, title: d.innerText.includes('流转链路') };
    })()`);
    check('详情有「流转链路」区', dlg?.title === true, JSON.stringify(dlg?.lines));
    check('链路显示三手', dlg?.lines.length === 3, JSON.stringify(dlg?.lines));
    check('当前这一手被高亮', dlg?.cur.length === 1, JSON.stringify(dlg?.cur));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'transpose-chain.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/transpose-chain.png');
    } catch {}

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已清理链路测试数据');
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
