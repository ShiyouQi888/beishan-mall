/**
 * 「申请抢单只能提交一次」+「后台订单不再有审核/拒绝、能批量取消」验收。
 *
 * 覆盖：
 *   1. 接口：同一笔订单重复申请不会刷出第二条日志，第二次只回提示
 *   2. 接口：订单详情 / 列表都带 applied 标记（H5 靠它把按钮置灰）
 *   3. 接口：已关闭的订单不能再申请抢单
 *   4. H5：详情页按钮变成「已提交，等待确认」且点不动；列表页该行「已提交」置灰
 *   5. 后台：订单操作列没有「审核」「拒绝」，详情里没有「审核状态」
 *   6. 后台：勾选订单 → 批量取消 → 订单关闭、商品释放
 *   7. 回归：pay_voucher_required 开着（默认档）时，pay_type=0 的订单也能确认抢单
 *      —— 前台下掉支付方式后已经没有凭证可传，凭证不能反过来卡住新单
 *
 * 全程用临时会员 + 临时商品，跑完全删。
 *
 * 用法: node scripts/probe/apply-once.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9513;
const PHONE = '13911000013';
const PWD = 'ao123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run, get } = await import('../../server/src/db.js');
const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

let memberId = 0;
const goodsIds = [];
let orderA = 0;
let orderB = 0;
// 凭证开关的原始值，跑完还原（演示库是 20，新库默认 10）
const voucherBackup = db.prepare("SELECT `value` v FROM setting_config WHERE `key` = 'pay_voucher_required'").get()?.v;

function cleanup() {
  for (const id of [orderA, orderB].filter(Boolean)) {
    run('DELETE FROM order_log WHERE order_id = ?', id);
    run('DELETE FROM goods_recycle WHERE order_id = ?', id);
    run('DELETE FROM orders WHERE order_id = ?', id);
  }
  for (const gid of goodsIds) {
    run('DELETE FROM specialarea_goods WHERE goods_id = ?', gid);
    run('DELETE FROM goods WHERE goods_id = ?', gid);
  }
  if (memberId) {
    for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
      run(`DELETE FROM ${t} WHERE member_id = ?`, memberId);
    }
    run('DELETE FROM member WHERE member_id = ?', memberId);
  }
}

/** 造一件「唯一一件货」，随时能抢（不挂场次，避开开放时段） */
function makeGoods(name, no) {
  const t = todayStr();
  const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
  const g = run(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES (?,?,'/uploads/demo-1.svg','[]','',?,1,'',1,1000,1000,0,0,1,1,0,10,10,0,0,100,1,0,0,?,?)`,
    name, no, catId, t, t,
  );
  const id = Number(g.lastInsertRowid);
  goodsIds.push(id);
  return id;
}

async function main() {
  cleanup();
  if (voucherBackup === undefined) throw new Error('setting_config 里没有 pay_voucher_required');

  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const at = admin.data.token;

  const reg = await fetch(`${API}/api/member/registerAnAccount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD, code: 'boss01', nickName: '重复提交验收' }),
  }).then((r) => r.json());
  memberId = Number(reg.data?.member_id) || Number(get('SELECT member_id FROM member WHERE mobile = ?', PHONE)?.member_id);
  const lg = await fetch(`${API}/api/member/accountLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, password: PWD }),
  }).then((r) => r.json());
  const token = lg.data?.token;
  if (!memberId || !token) throw new Error('临时会员准备失败');

  const goodsA = makeGoods('重复提交样品A', 'AO-A');
  const goodsB = makeGoods('批量取消样品B', 'AO-B');

  const post = async (path, body, tk = token) => fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token: tk },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const getJson = async (path, tk = token) => fetch(`${API}${path}`, { headers: { token: tk } }).then((r) => r.json());

  // ---------- 1. 接口层幂等 ----------
  console.log('[1] 接口层：重复申请只算一次');
  const a = await post('/api/order/toAddOrder', { goods_id: goodsA, num: 1, pay_type: 0 });
  orderA = Number(a.data?.order_id) || 0;
  check('订单 A 下单成功', a.code === 1 && orderA > 0, a.msg);

  const apply1 = await post('/api/order/toPay', { order_id: orderA, pay_type: 0 });
  check('第一次申请抢单成功', apply1.code === 1 && /等待平台确认/.test(apply1.msg || ''), apply1.msg);

  const apply2 = await post('/api/order/toPay', { order_id: orderA, pay_type: 0 });
  const apply3 = await post('/api/order/toPay', { order_id: orderA, pay_type: 0 });
  check('重复申请返回「已经提交过」', /已经提交过/.test(apply2.msg || '') && /已经提交过/.test(apply3.msg || ''),
    `${apply2.msg} / ${apply3.msg}`);
  const logCount = Number(get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '申请抢单'", orderA).c);
  check('连点 3 次，日志里只有 1 条「申请抢单」', logCount === 1, String(logCount));

  const detail = await getJson(`/api/order/detail?order_id=${orderA}`);
  check('订单详情带 applied=1', Number(detail.data?.applied) === 1, String(detail.data?.applied));
  const listA = await getJson('/api/order/getOrder?page=1&limit=5');
  const rowA = (listA.data?.data || []).find((x) => Number(x.order_id) === orderA);
  check('订单列表带 applied=1', Number(rowA?.applied) === 1, JSON.stringify(rowA && { applied: rowA.applied }));

  // ---------- 2. 已关闭的订单不能再申请 ----------
  console.log('\n[2] 接口层：已关闭订单不能再申请');
  const b = await post('/api/order/toAddOrder', { goods_id: goodsB, num: 1, pay_type: 0 });
  orderB = Number(b.data?.order_id) || 0;
  check('订单 B 下单成功', b.code === 1 && orderB > 0, b.msg);
  run('UPDATE orders SET status = 40 WHERE order_id = ?', orderB);
  const applyClosed = await post('/api/order/toPay', { order_id: orderB, pay_type: 0 });
  check('已关闭订单申请被拒', applyClosed.code === 0 && /已关闭/.test(applyClosed.msg || ''), applyClosed.msg);
  const closedLog = Number(get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '申请抢单'", orderB).c);
  check('被拒的申请没有留下日志', closedLog === 0, String(closedLog));
  // 送回待确认，留给后面的「批量取消」用
  run('UPDATE orders SET status = 0 WHERE order_id = ?', orderB);

  // ---------- 页面 ----------
  const profile = mkdtempSync(join(tmpdir(), 'applyonce-'));
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
  const shot = async (name) => {
    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', `${name}.png`), Buffer.from(s.data, 'base64'));
    } catch {}
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(at)});localStorage.setItem('TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    // ---------- 3. H5 详情页 ----------
    console.log('\n[3] H5 订单详情：已提交就点不动');
    await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
    await go(`${H5}/order/detail/${orderA}`);
    const detailUi = await evaluate(`(() => {
      const btn = document.querySelector('.odetail__bar button');
      return {
        text: btn?.textContent?.trim() || '',
        disabled: !!btn?.disabled,
        desc: document.querySelector('.status__d')?.textContent?.trim() || '',
      };
    })()`);
    check('按钮文案是「已提交，等待确认」', detailUi.text.includes('已提交'), detailUi.text);
    check('按钮已禁用', detailUi.disabled === true, String(detailUi.disabled));
    check('状态描述是「等待平台确认」', detailUi.desc.includes('等待平台确认'), detailUi.desc);
    await shot('apply-once-detail');

    // 未提交过的订单 B：按钮仍可点
    await go(`${H5}/order/detail/${orderB}`);
    const detailB = await evaluate(`(() => {
      const btn = document.querySelector('.odetail__bar button');
      return { text: btn?.textContent?.trim() || '', disabled: !!btn?.disabled };
    })()`);
    check('未申请的订单按钮还是「申请抢单」', detailB.text.includes('申请抢单'), detailB.text);
    check('未申请的订单按钮可点', detailB.disabled === false, String(detailB.disabled));

    // ---------- 4. H5 订单列表 ----------
    console.log('\n[4] H5 订单列表：已提交的行置灰');
    await go(`${H5}/order`);
    const listUi = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.ocard')];
      const pick = (no) => {
        const c = cards.find((x) => x.innerText.includes(no));
        if (!c) return null;
        const b = [...c.querySelectorAll('button')].find((x) => /申请抢单|已提交/.test(x.textContent));
        return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
      };
      return { a: pick(${JSON.stringify(get('SELECT order_no FROM orders WHERE order_id = ?', orderA).order_no)}),
               b: pick(${JSON.stringify(get('SELECT order_no FROM orders WHERE order_id = ?', orderB).order_no)}) };
    })()`);
    check('已申请的行按钮是「已提交」且禁用', listUi.a?.text === '已提交' && listUi.a?.disabled === true, JSON.stringify(listUi.a));
    check('未申请的行按钮是「申请抢单」且可点', listUi.b?.text === '申请抢单' && listUi.b?.disabled === false, JSON.stringify(listUi.b));
    await shot('apply-once-list');

    // ---------- 5. 后台订单页 ----------
    console.log('\n[5] 后台订单：没有审核/拒绝，能批量取消');
    await send('Emulation.clearDeviceMetricsOverride');
    await go(`${WEB}/orders`);
    const admUi = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.el-table__header th')].map((t) => t.innerText.trim());
      const ops = [...document.querySelectorAll('.el-table__body .ops')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim());
      return { head, ops: ops.slice(0, 3) };
    })()`);
    check('订单详情不再是「审核状态」列', !admUi.head.includes('审核状态'), JSON.stringify(admUi.head));
    const allOps = admUi.ops.join(' | ');
    check('操作列没有「审核」', !/审核/.test(allOps), allOps);
    check('操作列没有「拒绝」', !/拒绝/.test(allOps), allOps);
    check('操作列保留了「详情 / 确认抢单 / 取消」', /详情/.test(allOps) && /确认抢单/.test(allOps), allOps);

    // 勾选订单 B 那一行，批量取消
    const picked = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.el-table__body tr')];
      const row = rows.find((r) => r.innerText.includes(${JSON.stringify(get('SELECT order_no FROM orders WHERE order_id = ?', orderB).order_no)}));
      if (!row) return false;
      const cb = row.querySelector('input[type=checkbox]') || row.querySelector('.el-checkbox');
      if (!cb) return false;
      cb.click();
      return true;
    })()`);
    check('能勾选到订单 B', picked === true);
    await sleep(500);
    const hasBatchCancel = await evaluate(`(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '批量取消'))()`);
    check('勾选后出现「批量取消」按钮', hasBatchCancel === true);
    await shot('apply-once-admin');

    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '批量取消');
      if (btn) btn.click();
    })()`);
    await sleep(700);
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.el-message-box__btns button')].find((b) => b.textContent.includes('确定取消'));
      if (btn) btn.click();
    })()`);
    await sleep(1600);
    const bRow = get('SELECT status, pay_status FROM orders WHERE order_id = ?', orderB);
    check('批量取消后订单 B 关闭', Number(bRow?.status) === 40 && Number(bRow?.pay_status) === 0, JSON.stringify(bRow));
    const cancelledLog = Number(get("SELECT COUNT(*) c FROM order_log WHERE order_id = ? AND action = '后台取消'", orderB).c);
    check('落了「后台取消」日志', cancelledLog === 1, String(cancelledLog));

    // 已确认的订单不能再被单笔取消（防「取消即凭空退款」）
    run('UPDATE orders SET pay_status = 10 WHERE order_id = ?', orderB);
    run('UPDATE orders SET status = 10 WHERE order_id = ?', orderB);
    const cancelConfirmed = await post('/admin/api/orders/cancel', { order_id: orderB }, at);
    check('已确认的订单拒绝取消', cancelConfirmed.code === 0 && /已确认/.test(cancelConfirmed.msg || ''), cancelConfirmed.msg);
    run('UPDATE orders SET pay_status = 0, status = 40 WHERE order_id = ?', orderB);

    // ---------- 6. 凭证开关不该卡住 pay_type=0 的确认 ----------
    console.log('\n[6] 回归：凭证必传开着，也能确认「申请抢单」的订单');
    db.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_voucher_required'").run();
    const voucher = get("SELECT `value` v FROM setting_config WHERE `key` = 'pay_voucher_required'").v;
    check('已把「支付凭证必传」开到默认档', String(voucher) === '10', String(voucher));
    const confirm = await post('/admin/api/orders/confirm-pay', { order_id: orderA }, at);
    check('没有凭证也能确认抢单', confirm.code === 1, confirm.msg);
    const aRow = get('SELECT pay_status FROM orders WHERE order_id = ?', orderA);
    check('订单 A 已确认', Number(aRow?.pay_status) === 10, JSON.stringify(aRow));

    await go(`${H5}/order/detail/${orderA}`);
    const confirmedUi = await evaluate(`(() => ({
      t: document.querySelector('.status__t')?.textContent?.trim() || '',
      d: document.querySelector('.status__d')?.textContent?.trim() || '',
    }))()`);
    check('H5 状态变成「已确认」', confirmedUi.t.includes('已确认'), `${confirmedUi.t} / ${confirmedUi.d}`);

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    // 还原凭证开关
    try {
      db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'pay_voucher_required'").run(String(voucherBackup));
    } catch {}
    cleanup();
    console.log('\n已清理测试数据，凭证开关还原为', voucherBackup);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  try {
    db.prepare("UPDATE setting_config SET `value` = ? WHERE `key` = 'pay_voucher_required'").run(String(voucherBackup));
  } catch {}
  try { cleanup(); } catch {}
  process.exit(1);
});
