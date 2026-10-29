// 后台/H5 全路由控制台错误扫描：逐个访问路由，收集 JS 异常、console.error、失败请求
// 用法: node _probe/console-sweep.mjs <baseUrl> <tokenKey> <token> [路由文件] [--hash]
// --hash：H5 用 createWebHashHistory，必须走 /#/path
const argv = process.argv.slice(2);
const HASH = argv.includes('--hash');
const idArg = argv.find((a) => a.startsWith('--id='));
const SUBST = idArg ? idArg.slice(5) : '1';
const [base, tokenKey, token, routeFile] = argv.filter((a) => !a.startsWith('--'));
if (!base || !tokenKey || !token) {
  console.error('usage: node console-sweep.mjs <baseUrl> <tokenKey> <token> [路由文件] [--hash]');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const src = readFileSync(routeFile || new URL('../../admin/src/router.js', import.meta.url), 'utf8');
const raw = [
  ...[...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...src.matchAll(/\blist\(\s*'([^']+)'/g)].map((m) => m[1]),
  // H5 路由写法：数组里直接写 '/path'
  ...[...src.matchAll(/^\s*'(\/[^']*)'/gm)].map((m) => m[1]),
];
// 动态段用 1 代入，便于真实访问详情页
// :id 用 --id 代入（默认 1）；:group 固定用 trade，否则扫的是不存在的设置组
const paths = [...new Set(raw)]
  .map((p) => p.replace(/:id\b/g, SUBST).replace(/:group\b/g, 'trade'))
  .filter((p) => p.startsWith('/') && !p.includes(':'));

// H5 用 createWebHashHistory，必须走 /#/path（由 --hash 控制）


const PORT = 9333;
const CDP = `http://127.0.0.1:${PORT}`;
async function wsUrl() {
  for (let i = 0; i < 30; i++) {
    try { return (await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('Chrome 调试端口未就绪');
}

const ws = new WebSocket(await wsUrl());
let id = 0;
const pending = new Map();
const events = new Map();
const send = (method, params = {}, sessionId) => {
  const m = ++id;
  ws.send(JSON.stringify({ id: m, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(m, { res, rej }));
};
const once = (name, sid) => new Promise((r) => events.set(name + (sid || ''), r));
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method && events.has(m.method + (m.sessionId || ''))) {
    events.get(m.method + (m.sessionId || ''))(m.params);
    events.delete(m.method + (m.sessionId || ''));
  }
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);

const errors = [];
// requestId → URL，用于把 loadingFailed 对应回具体请求
const reqUrl = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent') reqUrl.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Runtime.exceptionThrown') errors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) errors.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
  if (m.method === 'Network.loadingFailed') errors.push(`[net] ${m.params.errorText} ${reqUrl.get(m.params.requestId) || ''}`);
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    errors.push(`[http ${m.params.response.status}] ${m.params.response.url}`);
  }
  if (m.method === 'Network.loadingFailed') reqUrl.delete(m.params.requestId);
});

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.setItem(${JSON.stringify(tokenKey)},${JSON.stringify(token)})}catch(e){}`,
}, sessionId);

const results = [];
for (const p of paths) {
  // 等上一页残留请求落地，再清空基线，避免把上一页的失败算到当前页头上
  await new Promise((r) => setTimeout(r, 900));
  errors.length = 0;
  const before = errors.length;
  const loaded = once('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url: base.replace(/\/$/, '') + (HASH ? '/#' : '') + p }, sessionId);
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 8000))]);
  await new Promise((r) => setTimeout(r, 1800));
  const { result } = await send('Runtime.evaluate', {
    expression: `document.querySelector('.layout') ? 'ok' : (document.body.innerText.slice(0,120) || '(empty)')`,
    returnByValue: true,
  }, sessionId);
  const newErrs = errors.slice(before);
  results.push({ path: p, text: String(result.value).replace(/\s+/g, ' ').slice(0, 90), errs: newErrs });
}

console.log(`\n扫描 ${results.length} 个路由 @ ${base}\n`);
for (const r of results) {
  const flag = r.errs.length ? '✗' : '✓';
  console.log(`${flag} ${r.path}  → ${r.text}`);
  r.errs.slice(0, 6).forEach((e) => console.log('     ' + e.split('\n')[0].slice(0, 160)));
}
const bad = results.filter((r) => r.errs.length);
console.log(`\n有问题的路由: ${bad.length}/${results.length}`);

await send('Target.closeTarget', { targetId });
ws.close();
process.exit(0);
