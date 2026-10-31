/**
 * 转拍订单：新增「下一场」与「导出完整订单」验收。
 *
 * 覆盖：
 *   1. 列表每行带 next_slot，且「所在场次」取的是商品当前场次（不是买家当初买入的场次）
 *   2. 非最后一场 → 下一场是同日的下一档；当天最后一场 → 下一场顺延到次日第一档
 *   3. 导出 CSV：28 列完整字段、带 BOM、行数与列表一致、含下一场数据
 *   4. 页面：所在场次列里出现「下一场」，页头有「导出表格」，点了能真下到文件
 *
 * 用临时会员 + 两件临时商品（挂「第一场」和「最后一场」），跑完全删。
 *
 * 用法: node scripts/probe/transpose-next-export.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9527;
const TAG = 'TNX';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { all, get, run } = await import('../../server/src/db.js');
const { todayStr, addDays } = await import('../../server/src/lib/sessionWindow.js');

let memberId = 0;
const goodsIds = [];
const orderIds = [];

function cleanup() {
  for (const id of orderIds) {
    run('DELETE FROM order_log WHERE order_id = ?', id);
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

/** 造一条在挂转拍：商品挂在指定场次，订单 consignment_status=10 */
function seed(areaId, dateStr, name, idx) {
  const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
  const gid = Number(run(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, recycled, create_time, update_time)
     VALUES (?,?,'/uploads/demo-1.svg','[]','',?,?,?,?,1000,1000,0,0,1,1,1,10,10,0,1,100,1,0,0,?,?)`,
    `${TAG} ${name}`, `${TAG}-${idx}`, catId, areaId, dateStr, memberId, `${dateStr} 00:00:00`, `${dateStr} 00:00:00`,
  ).lastInsertRowid);
  goodsIds.push(gid);
  const oid = Number(run(
    `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
       type, price, num, total_price, service_charge, status, pay_status, pay_type, consignment_status,
       listing_fee, transposition_time, pay_time, create_time)
     VALUES (?,?,1,?,?,'/uploads/demo-1.svg',?,1,1000,1,1000,20,10,10,0,10,0,?,?,?)`,
    `${TAG}-${idx}`, memberId, gid, `${TAG} ${name}`, areaId,
    `${dateStr} 09:00:00`, `${dateStr} 08:30:00`, `${dateStr} 00:00:00`,
  ).lastInsertRowid);
  orderIds.push(oid);
  return { gid, oid, no: `${TAG}-${idx}` };
}

async function main() {
  cleanup();
  const today = todayStr();

  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const token = admin.data?.token;
  if (!token) throw new Error('管理员登录失败');

  const areas = all('SELECT specialarea_id, title_main, start_time FROM specialarea WHERE is_open = 10 ORDER BY start_time');
  if (areas.length < 2) throw new Error('启用中的场次不足 2 个，无法验证「下一场」');
  const first = areas[0];
  const second = areas[1];
  const last = areas[areas.length - 1];

  memberId = Number(run(
    `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
       is_valid, amount, score, e_card_number, is_certification, disabled, client_type, create_time, update_time)
     VALUES ('下一场验收','13911000051','x',0,'/',1,'tnx01',10,0,0,0,0,10,3,?,?)`,
    `${today} 00:00:00`, `${today} 00:00:00`,
  ).lastInsertRowid);

  const a = seed(first.specialarea_id, today, '首场货', 1);
  const b = seed(last.specialarea_id, today, '末场货', 2);
  check('前置：造出 2 条在挂转拍', orderIds.length === 2);

  // ---------- 1. 列表：场次与下一场 ----------
  console.log('\n[1] 列表：所在场次 + 下一场');
  const listRes = await fetch(`${API}/admin/api/transpose/list?range=all&keyword=${TAG}`, { headers: { token } }).then((r) => r.json());
  const list = listRes.data?.list || [];
  const rowA = list.find((x) => x.order_no === a.no);
  const rowB = list.find((x) => x.order_no === b.no);
  check('两条都能查到', !!rowA && !!rowB, `${list.length}`);

  check('A 的所在场次 = 商品实际场次（首场）', rowA?.area_name === first.title_main, `${rowA?.area_name} vs ${first.title_main}`);
  check('A 的下一场 = 第二场（同日）',
    rowA?.next_slot?.area_id === second.specialarea_id && rowA?.next_slot?.date === today,
    JSON.stringify(rowA?.next_slot));
  check('A 的下一场文案含日期与时段',
    !!rowA?.next_slot && rowA.next_slot.text.includes(today) && /\d{2}:\d{2}-\d{2}:\d{2}/.test(rowA.next_slot.text),
    rowA?.next_slot?.text);

  check('B 的所在场次 = 最后一场', rowB?.area_name === last.title_main, `${rowB?.area_name} vs ${last.title_main}`);
  check('B 的下一场顺延到次日第一场',
    rowB?.next_slot?.area_id === first.specialarea_id && rowB?.next_slot?.date === addDays(today, 1),
    JSON.stringify(rowB?.next_slot));

  // ---------- 2. 导出 ----------
  console.log('\n[2] 导出完整订单');
  const res = await fetch(`${API}/admin/api/transpose/export?range=all&keyword=${TAG}`, { headers: { token } });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  const lines = text.replace(/^\ufeff/, '').split('\r\n').filter(Boolean);
  check('返回 text/csv', (res.headers.get('content-type') || '').includes('text/csv'), res.headers.get('content-type'));
  check('带 UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, buf.slice(0, 3).toString('hex'));
  check('表头 31 列', lines[0].split(',').length === 31, String(lines[0].split(',').length));
  check('表头含关键字段',
    ['订单ID', '订单号', '商品编码', '卖家手机号', '买家（当前持有人）', '买入价', '服务费', '上架费',
      '所在场次', '场次时段', '下一场次', '下一场日期', '下一场时段', '价格水位(%)', '是否封顶',
      '下单时间', '确认时间', '备注']
      .every((h) => lines[0].includes(h)),
    lines[0].slice(0, 80));
  check('导出行数 = 造的 2 条 + 表头', lines.length === 3, String(lines.length));

  const csvA = lines.find((l) => l.includes(a.no)) || '';
  const csvB = lines.find((l) => l.includes(b.no)) || '';
  check('A 行带上「下一场次」', csvA.includes(second.title_main), csvA.slice(0, 90));
  check('B 行下一场日期是明天', csvB.includes(addDays(today, 1)), csvB.slice(0, 90));
  check('金额两位小数', /,\d+\.\d{2},/.test(csvA), csvA.slice(0, 60));
  check('买家手机号带出来了', csvA.includes('13911000051'), csvA.slice(0, 90));

  // ---------- 3. 页面 ----------
  console.log('\n[3] 页面');
  const profile = mkdtempSync(join(tmpdir(), 'tnx-'));
  const dlDir = join(profile, 'dl');
  mkdirSync(dlDir, { recursive: true });
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
  await new Promise((res2) => ws.addEventListener('open', res2));
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
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url: `${WEB}/#/transpose` });
    await sleep(4600);

    // 切到「全部」并搜 TAG，只留造出来的两条
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.range-tabs .rt')].find((x) => x.textContent.trim() === '全部');
      if (b) b.click();
    })()`);
    await sleep(1500);
    await evaluate(`(() => {
      const input = document.querySelector('.filters input');
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
      setter.call(input, '${TAG}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.filters button')].find((x) => x.textContent.trim() === '查询');
      if (b) b.click();
    })()`);
    await sleep(2000);

    const ui = await evaluate(`(() => {
      const heads = [...document.querySelectorAll('.el-table__header th')].map((x) => x.innerText.trim());
      const rows = [...document.querySelectorAll('.el-table__body tr')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
      const nextTexts = [...document.querySelectorAll('.el-table__body .next-slot')].map((x) => x.textContent.trim());
      const btns = [...document.querySelectorAll('.page-head button')].map((x) => x.textContent.trim());
      return { heads, rows, nextTexts, btns };
    })()`);
    check('表头有「所在场次」列', ui.heads.includes('所在场次'), JSON.stringify(ui.heads));
    check('行里渲染出「下一场」', ui.nextTexts.length >= 2 && ui.nextTexts.every((t) => t.includes('下一场')),
      JSON.stringify(ui.nextTexts));
    check('页头有「导出表格」按钮', ui.btns.some((t) => t.includes('导出表格')), JSON.stringify(ui.btns));

    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'transpose-next-export.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/transpose-next-export.png');
    } catch {}

    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.page-head button')].find((x) => x.textContent.includes('导出表格'));
      if (b) b.click();
    })()`);
    await sleep(2800);
    const files = readdirSync(dlDir).filter((f) => f.endsWith('.csv'));
    check('点导出真下到 CSV', files.length === 1, files.join(','));
    if (files.length) {
      const content = readFileSync(join(dlDir, files[0]), 'utf8').replace(/^\ufeff/, '');
      const first = content.split(/\r?\n/)[0];
      check('下载文件表头正确', first.includes('订单号') && first.includes('下一场次'), first.slice(0, 60));
      check('下载内容只含当前筛选的 2 条', content.split(/\r?\n/).filter(Boolean).length === 3,
        String(content.split(/\r?\n/).filter(Boolean).length));
    }

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    cleanup();
    console.log('\n已清理造的数据');
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
