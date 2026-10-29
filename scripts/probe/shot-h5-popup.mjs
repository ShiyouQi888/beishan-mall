// 打开 H5 订单页的「转拍」弹窗并截图
const [, , url, out, tokenKey, token] = process.argv;
const PORT = 9333;
const CDP = `http://127.0.0.1:${PORT}`;
const { writeFileSync } = await import('node:fs');

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
const send = (method, params = {}, sessionId) => {
  const m = ++id;
  ws.send(JSON.stringify({ id: m, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(m, { res, rej }));
};
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.setItem(${JSON.stringify(tokenKey)},${JSON.stringify(token)})}catch(e){}`,
}, sessionId);
await send('Page.navigate', { url }, sessionId);
await new Promise((r) => setTimeout(r, 3500));

const click = await send('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.innerText.trim() === '转拍');
    if (!b) return 'not-found:' + btns.map(x=>x.innerText.trim()).join('|');
    b.click();
    return 'clicked';
  })()`,
  returnByValue: true,
}, sessionId);
console.log('点击结果:', click.result.value);

await new Promise((r) => setTimeout(r, 2000));
const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved:', out);

await send('Target.closeTarget', { targetId });
ws.close();
process.exit(0);
