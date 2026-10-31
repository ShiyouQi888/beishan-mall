/**
 * 转拍订单页：接口筛选口径 + 页面交互验证。
 *
 * 造几条不同日期的「正在转拍」记录（订单 consignment_status=10、商品还在他名下），
 * 然后逐个验证 今日 / 昨日 / 本周 / 本月 / 自定义 / 全部 的命中集合，
 * 再打开后台页面截图并断言表格行数与筛选按钮生效。
 *
 * 所有测试数据带 TPTEST- 前缀，跑完（含异常）一律清理，不污染演示库。
 *
 * 用法: node scripts/probe/transpose-orders.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db, run, all } = await import('../../server/src/db.js');
const { todayStr, addDays } = await import('../../server/src/lib/sessionWindow.js');

const TAG = 'TPTEST';
const dates = (() => {
  const today = todayStr();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const weekStart = addDays(today, -(dow === 0 ? 6 : dow - 1));
  const monthStart = `${today.slice(0, 7)}-01`;
  // 上月 15 号，保证既不落在本周也不落在本月
  const [y, m] = today.split('-').map(Number);
  const prevMonth = m === 1 ? `${y - 1}-12-15` : `${y}-${String(m - 1).padStart(2, '0')}-15`;
  return { today, weekStart, monthStart, prevMonth, yesterday: addDays(today, -1) };
})();

function cleanup() {
  const orders = all(`SELECT order_id FROM orders WHERE order_no LIKE '${TAG}-%'`).map((o) => o.order_id);
  for (const id of orders) {
    run('DELETE FROM order_log WHERE order_id = ?', id);
    run('DELETE FROM orders WHERE order_id = ?', id);
  }
  run(`DELETE FROM goods WHERE goods_no LIKE '${TAG}-%'`);
  return orders.length;
}

/** 造一条「正在转拍」：商品挂在会员名下、上架中，订单已挂牌 */
function seedOne(idx, dateStr, { memberId = 2, price = 1000, sell = 1030 } = {}) {
  const g = run(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES (?,?,?,?,'',1,0,'',?,?,?,0,0,1,1,0,10,10,0,2,100,1,0,0,?,?)`,
    `${TAG} 转拍样品 ${idx}`, `${TAG}-${idx}`, '/uploads/demo-1.svg', '[]',
    memberId, sell, price, dateStr, dateStr,
  );
  const goodsId = Number(g.lastInsertRowid);
  const o = run(
    `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
       num, total_price, service_charge, pay_type, pay_voucher, status, pay_status, type, is_examine,
       consignment_status, listing_fee, transposition_time, pay_time, create_time)
     VALUES (?,?,?,?,?,?,0,1,?,20,1,'',10,10,1,10,10,?,?,?,?)`,
    `${TAG}-${idx}`, memberId, 1, goodsId, `${TAG} 转拍样品 ${idx}`, '/uploads/demo-1.svg',
    price, sell - price, `${dateStr} 09:00:00`, `${dateStr} 08:30:00`, dateStr,
  );
  return { goodsId, orderId: Number(o.lastInsertRowid), no: `${TAG}-${idx}`, date: dateStr, listingFee: sell - price };
}

async function main() {
  cleanup();

  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  if (login.code !== 1) throw new Error('后台登录失败：' + login.msg);
  const token = login.data.token;

  // 今日 / 昨日 / 本周内（非今日昨日）/ 上月
  const weekInner = dates.weekStart > addDays(dates.today, -2) ? dates.today : addDays(dates.today, -2);
  const rows = {
    today: seedOne(1, dates.today, { price: 1000, sell: 1030 }),
    yesterday: seedOne(2, dates.yesterday, { price: 2000, sell: 2060 }),
    week: weekInner === dates.today ? null : seedOne(3, weekInner, { price: 3000, sell: 3090 }),
    prev: seedOne(4, dates.prevMonth, { price: 4000, sell: 4120 }),
  };
  // 一条「已经被买走」的干扰数据：商品持有人变了，不该出现在列表里
  const ghost = seedOne(5, dates.today, { price: 5000, sell: 5150 });
  run('UPDATE goods SET member_id = 3 WHERE goods_id = ?', ghost.goodsId);

  const seeded = Object.values(rows).filter(Boolean);
  console.log(`已造 ${seeded.length} 条在挂单 + 1 条干扰单（已卖出的）\n`);

  const call = async (qs) => {
    const r = await fetch(`${API}/admin/api/transpose/list?${qs}`, { headers: { token } }).then((x) => x.json());
    if (r.code !== 1) throw new Error(r.msg);
    return r.data;
  };

  try {
    // ---------------- 接口筛选 ----------------
    console.log('[1] 时间筛选口径');
    const todayRes = await call('range=today');
    const todayNos = todayRes.list.map((x) => x.order_no);
    check('今日只命中今天的单', todayNos.length === 1 && todayNos[0] === rows.today.no, JSON.stringify(todayNos));
    check('今日的统计卡数字跟着筛选走', todayRes.summary.count === 1, String(todayRes.summary.count));

    const yRes = await call('range=yesterday');
    const yNos = yRes.list.map((x) => x.order_no);
    check('昨日只命中昨天的单', yNos.length === 1 && yNos[0] === rows.yesterday.no, JSON.stringify(yNos));

    const weekRes = await call('range=week');
    const weekNos = weekRes.list.map((x) => x.order_no);
    check('本周包含今天与昨天的单', weekNos.includes(rows.today.no) && weekNos.includes(rows.yesterday.no), JSON.stringify(weekNos));
    check('本周不包含上月的单', !weekNos.includes(rows.prev.no), JSON.stringify(weekNos));

    const monthRes = await call('range=month');
    const monthNos = monthRes.list.map((x) => x.order_no);
    check('本月不包含上月的单', !monthNos.includes(rows.prev.no), JSON.stringify(monthNos));
    check('本月包含今天的单', monthNos.includes(rows.today.no), JSON.stringify(monthNos));

    const allRes = await call('range=all');
    const allNos = allRes.list.map((x) => x.order_no);
    check('全部命中所有在挂单', seeded.every((x) => allNos.includes(x.no)), JSON.stringify(allNos));
    check('「已被买走」的单不出现在列表里', !allNos.includes(ghost.no), JSON.stringify(allNos));

    const cusRes = await call(`range=custom&start=${dates.prevMonth}&end=${dates.prevMonth}`);
    check('自定义日期精确命中', cusRes.list.length === 1 && cusRes.list[0].order_no === rows.prev.no, JSON.stringify(cusRes.list.map((x) => x.order_no)));

    const badRes = await fetch(`${API}/admin/api/transpose/list?range=custom&start=abc&end=def`, { headers: { token } }).then((x) => x.json());
    check('自定义日期格式错误会报错', badRes.code === 0, badRes.msg);

    // ---------------- 字段口径 ----------------
    console.log('\n[2] 字段口径');
    const one = todayRes.list[0];
    check('买入价取订单金额', Math.abs(one.buy_price - 1000) < 0.01, String(one.buy_price));
    check('当前标价取商品售价', Math.abs(one.sell_price - 1030) < 0.01, String(one.sell_price));
    check('涨价 = 标价 - 买入价', Math.abs(one.gain - 30) < 0.01, String(one.gain));
    check('带出转拍人昵称', !!one.nick_name, one.nick_name);
    check('带出挂牌时长（分钟）', Number.isFinite(one.online_minutes) && one.online_minutes >= 0, String(one.online_minutes));

    const allSummary = allRes.summary;
    check('汇总：上架费合计', Math.abs(allSummary.fee - seeded.reduce((s, x) => s + x.listingFee, 0)) < 0.01, String(allSummary.fee));
    check('汇总：涉及商品数', allSummary.goods_count === seeded.length, String(allSummary.goods_count));

    // ---------------- 页面 ----------------
    console.log('\n[3] 后台页面');
    const profile = mkdtempSync(join(tmpdir(), 'transpose-'));
    const chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
      '--window-size=1600,1100', 'about:blank',
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

    try {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
      });
      await send('Page.navigate', { url: `${WEB}/#/transpose` });
      await sleep(4500);

      const head = await evaluate(`(document.querySelector('.page-head h2') || {}).textContent || ''`);
      check('页面能打开', String(head).includes('转拍订单'), String(head));

      const state = () => evaluate(`(() => {
        const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
        const tabs = [...document.querySelectorAll('.rt')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on') }));
        const stat = document.querySelector('.stat .v')?.textContent?.trim() || '';
        return { rows: rows.length, names: rows.map((r) => r.innerText.split('\\n')[1] || ''), tabs, stat };
      })()`);

      const s1 = await state();
      check('默认选中「今日」', s1.tabs.find((x) => x.on)?.t === '今日', JSON.stringify(s1.tabs.map((x) => x.t)));
      check('今日 1 行', s1.rows === 1, String(s1.rows));
      check('统计卡显示 1', s1.stat === '1', s1.stat);

      await evaluate(`(() => { const b=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='全部'); if(b) b.click(); })()`);
      await sleep(1200);
      const s2 = await state();
      check('切到「全部」显示 4 行', s2.rows === 4, String(s2.rows));

      await evaluate(`(() => { const b=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='昨日'); if(b) b.click(); })()`);
      await sleep(1200);
      const s3 = await state();
      check('切到「昨日」显示 1 行', s3.rows === 1, String(s3.rows));

      await evaluate(`(() => { const b=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='自定义'); if(b) b.click(); })()`);
      await sleep(800);
      const hasPicker = await evaluate(`!!document.querySelector('.el-date-editor')`);
      check('切到「自定义」出现日期选择器', hasPicker === true);

      // 回到「全部」再截图，内容更完整
      await evaluate(`(() => { const b=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='全部'); if(b) b.click(); })()`);
      await sleep(1400);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'transpose-orders.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/transpose-orders.png');

      check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    } finally {
      ws.close();
      chrome.kill();
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  } finally {
    const removed = cleanup();
    console.log(`\n已清理测试数据：${removed} 条订单及相关商品`);
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
