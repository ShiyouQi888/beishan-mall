/**
 * 「全部订单」时间筛选 + 导出表格验收。
 *
 * 覆盖：
 *   1. 接口：all / today / yesterday / week / month / custom 各自的口径与计数
 *   2. 接口：custom 日期非法会被拒（不能静默当成不限）
 *   3. 接口：导出返回 text/csv + BOM + 正确表头，且受同一套筛选条件影响
 *   4. 页面：范围按钮组与「导出表格」按钮存在
 *   5. 页面：点「今日」后列表按今日口径刷新，请求带 range=today
 *   6. 页面：点「自定义」后出现日期区间选择器
 *   7. 页面：点「导出表格」真的下到一个 CSV 文件
 *
 * 只读：不造任何数据，也不改任何配置。
 *
 * 用法: node scripts/probe/order-range-export.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const ADMIN = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9523;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { get, all } = await import('../../server/src/db.js');
const { todayStr, addDays } = await import('../../server/src/lib/sessionWindow.js');

async function main() {
  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const token = admin.data?.token;
  if (!token) throw new Error('管理员登录失败');

  const q = async (path) => fetch(`${API}/admin/api${path}`, { headers: { token } }).then((r) => r.json());
  const today = todayStr();

  // ---------- 1. 接口：范围口径 ----------
  console.log('[1] 接口：时间范围口径');
  const dbAll = Number(get('SELECT COUNT(*) c FROM orders').c);
  const dbToday = Number(get('SELECT COUNT(*) c FROM orders WHERE create_time >= ? AND create_time <= ?', `${today} 00:00:00`, `${today} 23:59:59`).c);
  const dbYesterday = Number(get('SELECT COUNT(*) c FROM orders WHERE create_time >= ? AND create_time <= ?', `${addDays(today, -1)} 00:00:00`, `${addDays(today, -1)} 23:59:59`).c);

  const rAll = await q('/orders/list?page=1&limit=200');
  check('不传 range = 全部', Number(rAll.data.total) === dbAll, `接口 ${rAll.data.total} / 库 ${dbAll}`);
  const rToday = await q('/orders/list?page=1&limit=200&range=today');
  check('今日', Number(rToday.data.total) === dbToday, `接口 ${rToday.data.total} / 库 ${dbToday}`);
  const rYest = await q('/orders/list?page=1&limit=200&range=yesterday');
  check('昨日', Number(rYest.data.total) === dbYesterday, `接口 ${rYest.data.total} / 库 ${dbYesterday}`);
  const rWeek = await q('/orders/list?page=1&limit=200&range=week');
  check('本周 >= 今日', Number(rWeek.data.total) >= dbToday, `本周 ${rWeek.data.total} / 今日 ${dbToday}`);
  const rMonth = await q('/orders/list?page=1&limit=200&range=month');
  // 不能拿「本月 >= 本周」来断言：月初那一周会跨上个月（11-01 是周日，本周从 10-26 起算），
  // 本月反而比本周小。改成与「今日」比 —— 今天永远属于本月。
  check('本月 >= 今日', Number(rMonth.data.total) >= dbToday, `本月 ${rMonth.data.total} / 今日 ${dbToday}`);

  const rCustom = await q(`/orders/list?page=1&limit=200&range=custom&date_start=${today}&date_end=${today}`);
  check('自定义（今天~今天）= 今日', Number(rCustom.data.total) === dbToday, `接口 ${rCustom.data.total} / 今日 ${dbToday}`);
  // 起止反着传也要能兜住
  // 起止反着传：交换后应等于「今天−3 ~ 今天」这个区间，而不是等于「今天」那一天
  const rSwap = await q(`/orders/list?page=1&limit=200&range=custom&date_start=${today}&date_end=${addDays(today, -3)}`);
  const dbSwap = Number(get('SELECT COUNT(*) c FROM orders WHERE create_time >= ? AND create_time <= ?',
    `${addDays(today, -3)} 00:00:00`, `${today} 23:59:59`).c);
  check('自定义起止反了会自动交换', Number(rSwap.data.total) === dbSwap, `接口 ${rSwap.data.total} / 库 ${dbSwap}`);
  const rBad = await q('/orders/list?range=custom&date_start=abc&date_end=def');
  check('自定义日期非法被拒', rBad.code === 0 && /YYYY-MM-DD/.test(rBad.msg || ''), rBad.msg);
  const rOld = await q('/orders/list?page=1&limit=200&range=custom&date_start=2020-01-01&date_end=2020-01-31');
  check('历史空区间返回 0 条', Number(rOld.data.total) === 0, String(rOld.data.total));

  // 与状态筛选叠加
  const rTodayConfirmed = await q('/orders/list?page=1&limit=200&range=today&pay_status=10');
  check('时间范围与「已确认」叠加生效',
    Number(rTodayConfirmed.data.total) <= dbToday, `叠加后 ${rTodayConfirmed.data.total}`);

  // ---------- 2. 接口：导出 ----------
  console.log('\n[2] 接口：导出 CSV');
  const res = await fetch(`${API}/admin/api/orders/export?range=today`, { headers: { token } });
  const ctype = res.headers.get('content-type') || '';
  const disp = res.headers.get('content-disposition') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  check('返回 text/csv', ctype.includes('text/csv'), ctype);
  check('带下载文件名', /attachment; filename="orders-\d{8}\.csv"/.test(disp), disp);
  check('有 UTF-8 BOM（Excel 不乱码）', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, buf.slice(0, 3).toString('hex'));
  const lines = text.replace(/^\ufeff/, '').split('\r\n');
  // 导出列已扩到「商品金额 / 抢单服务费 / 转拍上架费 / 实付金额」，运营按实付对账
  check('表头正确', lines[0] === '订单号,商品,类型,单价,数量,商品金额,抢单服务费,转拍上架费,实付金额,状态,买家,买家手机号,卖家,下单时间,确认时间,备注', lines[0]);
  check('行数 = 今日订单数 + 表头', lines.filter(Boolean).length === dbToday + 1, `${lines.filter(Boolean).length} vs ${dbToday + 1}`);
  check('金额保留两位小数', lines.length < 2 || /,\d+\.\d{2},\d+,/.test(lines[1] || ''), lines[1] || '(今日无单)');
  // 时间列包成 ="..."，Excel 才不会把它当日期压成 ####
  check('下单时间是文本格式', lines.length < 2 || /="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/.test(lines[1] || ''),
    (lines[1] || '').slice(0, 80));

  const emptyRes = await fetch(`${API}/admin/api/orders/export?range=custom&date_start=2020-01-01&date_end=2020-01-31`, { headers: { token } });
  const emptyText = (await emptyRes.text()).replace(/^\ufeff/, '');
  check('空区间导出只有表头', emptyText.trim().split('\r\n').length === 1, emptyText.slice(0, 60));

  // ---------- 3. 页面 ----------
  console.log('\n[3] 页面');
  const profile = mkdtempSync(join(tmpdir(), 'ordrange-'));
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
  const reqUrls = [];
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
    if (m.method === 'Network.requestWillBeSent') reqUrls.push(m.params.request.url);
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
    await send('Page.navigate', { url: `${ADMIN}/orders` });
    await sleep(4600);

    const ui = await evaluate(`(() => {
      const radios = [...document.querySelectorAll('.toolbar .el-radio-button')].map((x) => x.textContent.trim());
      const btns = [...document.querySelectorAll('.page-actions button')].map((x) => x.textContent.trim());
      const totalTxt = document.querySelector('.total-hint')?.textContent?.trim() || '';
      return { radios, btns, totalTxt };
    })()`);
    check('范围按钮齐全（全部/今日/昨日/本周/本月/自定义）',
      ['全部', '今日', '昨日', '本周', '本月', '自定义'].every((t) => ui.radios.includes(t)), JSON.stringify(ui.radios));
    check('有「导出表格」按钮', ui.btns.some((t) => t.includes('导出表格')), JSON.stringify(ui.btns));
    check('初始显示全部条数', ui.totalTxt.includes(String(dbAll)), ui.totalTxt);

    // 点「今日」
    reqUrls.length = 0;
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.toolbar .el-radio-button')].find((x) => x.textContent.trim() === '今日');
      if (b) b.querySelector('input')?.click() || b.click();
    })()`);
    await sleep(2200);
    const afterToday = await evaluate(`document.querySelector('.total-hint')?.textContent?.trim() || ''`);
    check('点「今日」后条数按今日口径', afterToday.includes(String(dbToday)), afterToday);
    check('请求带上 range=today', reqUrls.some((u) => u.includes('/orders/list') && u.includes('range=today')),
      reqUrls.filter((u) => u.includes('/orders/list')).slice(-1).join(','));

    // 点「自定义」→ 出现日期区间选择器
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.toolbar .el-radio-button')].find((x) => x.textContent.trim() === '自定义');
      if (b) b.querySelector('input')?.click() || b.click();
    })()`);
    await sleep(900);
    const hasPicker = await evaluate(`!!document.querySelector('.toolbar .el-date-editor--daterange')`);
    check('点「自定义」后出现日期区间选择器', hasPicker === true);

    // 切回「今日」再导出：选着「自定义」但没选日期时，导出会被拦住并提示先选日期
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.toolbar .el-radio-button')].find((x) => x.textContent.trim() === '今日');
      if (b) b.querySelector('input')?.click() || b.click();
    })()`);
    await sleep(1800);

    reqUrls.length = 0;
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.page-actions button')].find((x) => x.textContent.includes('导出表格'));
      if (b) b.click();
    })()`);
    await sleep(2600);
    const files = readdirSync(dlDir).filter((f) => f.endsWith('.csv'));
    check('下载到一个 CSV 文件', files.length === 1, files.join(','));
    if (files.length) {
      const content = readFileSync(join(dlDir, files[0]), 'utf8').replace(/^\ufeff/, '');
      check('下载内容首行是表头', content.split(/\r?\n/)[0].startsWith('订单号,商品,类型'), content.slice(0, 40));
    }
    check('导出请求带了当前筛选（range=today）', reqUrls.some((u) => u.includes('/orders/export') && u.includes('range=today')),
      reqUrls.filter((u) => u.includes('/orders/export')).join(','));

    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'order-range-export.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/order-range-export.png');
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
