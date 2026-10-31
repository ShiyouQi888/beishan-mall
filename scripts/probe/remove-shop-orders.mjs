/**
 * 「运费模板隐藏 + 商城订单删除清理」验收。
 *
 * 覆盖：
 *   1. 菜单接口里没有 /delivery 与 /orders/shop
 *   2. 权限节点树里也没有这两个节点（启动时的 ensureNodes 会自动清掉）
 *   3. 侧边栏不再渲染这两项
 *   4. 直接敲地址访问 #/delivery、#/orders/shop 会被路由兜回控制面板
 *   5. 「全部订单」页完好：有数据、批量导入在、挂在商城订单页下的「新建寄买单」已移除
 *
 * 用法: node scripts/probe/remove-shop-orders.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const ADMIN = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9517;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const token = admin.data?.token;
  if (!token) throw new Error('管理员登录失败');

  // ---------- 1. 菜单与权限节点 ----------
  console.log('[1] 菜单与权限节点')
  const menu = await fetch(`${API}/admin/api/menu`, { headers: { token } }).then((r) => r.json());
  const flat = (menu.data?.menus || []).flatMap((g) => (g.items || []).map((i) => ({ group: g.label, ...i })));
  const paths = flat.map((i) => i.path);
  check('菜单里没有 /delivery', !paths.includes('/delivery'), paths.join(','));
  check('菜单里没有 /orders/shop', !paths.includes('/orders/shop'));
  check('菜单里没有「运费模板」字样', !flat.some((i) => String(i.title || '').includes('运费')));
  check('菜单里没有「商城订单」字样', !flat.some((i) => String(i.title || '').includes('商城订单')));
  check('「全部订单」「转拍订单」「系统回收」都还在',
    ['/orders', '/transpose', '/recycle'].every((p) => paths.includes(p)));

  const tree = await fetch(`${API}/admin/api/node/tree`, { headers: { token } }).then((r) => r.json());
  const nodes = JSON.stringify(tree.data || []);
  check('权限节点树里没有商城订单节点', !nodes.includes('商城订单'));
  check('权限节点树里没有运费模板节点', !nodes.includes('运费模板'));

  // ---------- 2. 页面 ----------
  const profile = mkdtempSync(join(tmpdir(), 'rmshop-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1100', 'about:blank',
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
  const go = async (url, wait = 4200) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url });
    await sleep(wait);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    console.log('\n[2] 侧边栏')
    await go(`${ADMIN}/orders`);
    const side = await evaluate(`(() => ({
      nav: document.querySelector('.sidebar, .el-menu, aside')?.innerText || '',
      title: document.querySelector('.page-head h2')?.textContent?.trim() || '',
      actions: [...document.querySelectorAll('.page-actions button')].map((b) => b.textContent.trim()),
      rows: document.querySelectorAll('.el-table__body tr').length,
    }))()`);
    check('侧边栏没有「运费模板」', !side.nav.includes('运费模板'), side.nav.replace(/\s+/g, '/').slice(0, 120));
    check('侧边栏没有「商城订单」', !side.nav.includes('商城订单'));
    check('侧边栏仍有「全部订单」', side.nav.includes('全部订单'));
    check('全部订单页标题正确', side.title === '全部订单', side.title);
    check('全部订单有数据', side.rows > 0, `${side.rows} 行`);
    check('「批量导入」还在', side.actions.some((t) => t.includes('批量导入')), JSON.stringify(side.actions));
    check('「新建寄买单」已移除', !side.actions.some((t) => t.includes('寄买')), JSON.stringify(side.actions));

    console.log('\n[3] 直接敲地址')
    await go(`${ADMIN}/delivery`, 3200);
    const del = await evaluate(`(() => ({ path: location.pathname, title: document.querySelector('.page-head h2')?.textContent?.trim() || '' }))()`);
    check('/delivery 被兜回控制面板', del.path !== '/delivery', `path=${del.path} 标题=${del.title}`);

    await go(`${ADMIN}/orders/shop`, 3200);
    const shop = await evaluate(`(() => ({ path: location.pathname, title: document.querySelector('.page-head h2')?.textContent?.trim() || '' }))()`);
    check('/orders/shop 被兜回控制面板', shop.path !== '/orders/shop', `path=${shop.path} 标题=${shop.title}`);

    try {
      await go(`${ADMIN}/orders`, 3600);
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'remove-shop-orders.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/remove-shop-orders.png');
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
