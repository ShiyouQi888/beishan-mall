// 一体化部署自检：同一进程下 H5(/) 与后台(/admin/) 是否都能正常加载
// 用法: node scripts/probe/integrated-check.mjs [baseUrl] [adminToken]
const [, , BASE_ARG, TOKEN_ARG] = process.argv;
const BASE = (BASE_ARG || 'http://127.0.0.1:3300').replace(/\/$/, '');
const TOKEN = TOKEN_ARG || '';
const CDP = 'http://127.0.0.1:9333';

const { writeFileSync } = await import('node:fs');

async function wsUrl() {
  for (let i = 0; i < 30; i++) {
    try { return (await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('Chrome 调试端口未就绪（需 --remote-debugging-port=9333）');
}

const ws = new WebSocket(await wsUrl());
let id = 0;
const pending = new Map();
const send = (m, p = {}, s) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); return new Promise((r, j) => pending.set(i, { r, j })); };
await new Promise((r) => (ws.onopen = r));
const errs = [];
const bad = [];
const reqs = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { r, j } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0]);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errs.push('[error] ' + m.params.entry.text);
  } else if (m.method === 'Network.requestWillBeSent') {
    reqs.set(m.params.requestId, m.params.request.url);
  } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    bad.push(`${m.params.response.status} ${m.params.response.url}`);
  }
};

let pass = 0;
const fails = [];
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fails.push(n + (d ? ' → ' + d : '')); console.log(`  ✗ ${n}${d ? ' → ' + d : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
if (TOKEN) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('ADMIN_TOKEN',${JSON.stringify(TOKEN)})}catch(e){}`,
  }, sessionId);
}

async function ev(expr) {
  const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  return result.value;
}
async function visit(url, wait = 3500) {
  errs.length = 0; bad.length = 0;
  await send('Page.navigate', { url }, sessionId);
  await sleep(wait);
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(`_probe/integrated-${name}.png`, Buffer.from(data, 'base64'));
}

try {
  console.log(`\n[1] H5 首页 ${BASE}/`);
  await visit(`${BASE}/`);
  const h5Title = await ev('document.title');
  const h5Cards = await ev("document.querySelectorAll('.goods-card').length");
  ok(typeof h5Title === 'string' && h5Title.trim().length >= 2, 'H5 标题已渲染（取店铺名）', h5Title);
  ok(h5Cards > 0, 'H5 商品卡渲染', `${h5Cards} 张`);
  ok((await ev("!!document.querySelector('.tabbar, .van-tabbar, .tab-bar')")), 'H5 底部导航存在');
  ok(!bad.length, 'H5 无 4xx/5xx 资源请求', bad.slice(0, 3).join(' | '));
  ok(!errs.length, 'H5 无控制台错误', errs.slice(0, 3).join(' | '));
  await shot('h5');

  console.log(`\n[2] 后台 ${BASE}/admin/`);
  await visit(`${BASE}/admin/`, 4000);
  const aTitle = await ev('document.title');
  const menuItems = await ev("document.querySelectorAll('.menu__item').length");
  ok(String(aTitle).includes('管理后台'), '后台标题正确', aTitle);
  ok(menuItems >= 20, '后台菜单渲染', `${menuItems} 项`);
  ok(await ev("!!document.querySelector('.sidebar, .layout')"), '后台布局挂载');
  ok(!bad.length, '后台无 4xx/5xx 资源请求', bad.slice(0, 3).join(' | '));
  ok(!errs.length, '后台无控制台错误', errs.slice(0, 3).join(' | '));
  await shot('admin');

  console.log(`\n[3] 后台深链接 ${BASE}/admin/#/member`);
  await visit(`${BASE}/admin/#/member`, 2500);
  ok(await ev("location.hash.includes('/member')"), '后台 hash 路由可用', await ev('location.hash'));
  ok(await ev("document.body.innerText.includes('会员列表')"), '后台页面切换正常');
  await shot('admin-member');

  console.log(`\n[4] 接口与静态资源同源`);
  const health = await ev(`fetch('/api/health').then(r=>r.json()).then(d=>d.code)`);
  ok(health === 1, '同源 /api 可用', String(health));
  const up = await ev(`fetch('/uploads/demo-1.svg').then(r=>r.status)`);
  ok(up === 200, '同源 /uploads 可用', String(up));
  const adminApi = await ev(`fetch('/admin/api/me',{headers:{Authorization:'Bearer ${TOKEN}'}}).then(r=>r.json()).then(d=>d.code)`);
  ok(adminApi === 1, '同源 /admin/api 可用', String(adminApi));

  console.log(`\n[5] 未知路径回落`);
  await visit(`${BASE}/whatever/deep`, 2000);
  ok(await ev("!!document.querySelector('#app')"), '未知路径回落到 H5', await ev('document.title'));
} finally {
  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (fails.length) { console.log('\n失败项：'); fails.forEach((f) => console.log('  · ' + f)); }
  await send('Target.closeTarget', { targetId });
  ws.close();
  process.exit(fails.length ? 1 : 0);
}
