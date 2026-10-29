// CDP 截图：精确控制移动端视口，可选裁剪区域
// 用法: node scripts/shot.mjs <url> <out.png> [width] [height] [fullPage]
//       node scripts/shot.mjs <url> <out.png> 390 844 --full

const [, , url, out, w = '390', h = '844', ...rest] = process.argv;
if (!url || !out) {
  console.error('usage: node shot.mjs <url> <out.png> [w] [h] [--full] [--pre "js"]');
  process.exit(1);
}
const mode = rest.includes('--full') ? '--full' : '';
const preIdx = rest.indexOf('--pre');
const PRE_JS = preIdx >= 0 ? rest[preIdx + 1] : '';

const PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;

async function getWsUrl() {
  // 等 Chrome 调试端口就绪
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/json/version`);
      const j = await r.json();
      return j.webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('Chrome 调试端口未就绪');
}

const wsUrl = await getWsUrl();
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const events = new Map();

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
}

function once(name, sessionId) {
  return new Promise((resolve) => events.set(name, resolve));
}

await new Promise((r) => (ws.onopen = r));

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method && events.has(msg.method)) {
    events.get(msg.method)(msg.params);
    events.delete(msg.method);
  }
};

// 新建 target
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
if (PRE_JS) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PRE_JS }, sessionId);
}
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(w),
  height: Number(h),
  deviceScaleFactor: 2,
  mobile: true,
}, sessionId);

const loaded = once('Page.loadEventFired', sessionId);
await send('Page.navigate', { url }, sessionId);
await loaded;

// 等 SPA 渲染 + 接口返回
await new Promise((r) => setTimeout(r, 2600));

const { result } = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight})',
  returnByValue: true,
}, sessionId);
const info = JSON.parse(result.value);
console.log(`viewport=${w}x${h} scrollWidth=${info.sw} clientWidth=${info.cw} scrollHeight=${info.sh}`);
if (info.sw > info.cw + 1) console.log(`⚠ 横向溢出 ${info.sw - info.cw}px`);

const shotParams = { format: 'png' };
if (mode === '--full') {
  shotParams.captureBeyondViewport = true;
  shotParams.clip = { x: 0, y: 0, width: Number(w), height: info.sh, scale: 1 };
}

const { data } = await send('Page.captureScreenshot', shotParams, sessionId);
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved:', out);

await send('Target.closeTarget', { targetId });
ws.close();
process.exit(0);
