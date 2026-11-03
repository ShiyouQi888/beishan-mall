/** 提前抢购：确认订单页（/submit/:id）必须放行，不能把有资格的人弹回抢购页。 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', '..', 'server');
const PORT = 3481;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'advance-ui.db';
const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9385;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  const p = join(SERVER, 'data', f); if (existsSync(p)) unlinkSync(p);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };
await new Promise((res, rej) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
  p.on('close', c => (c === 0 ? res(o) : rej(new Error(o))));
});
const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }
const { db, get } = await import('../../server/src/db.js');

const nowSec = Math.floor((Math.floor(Date.now() / 1000) + 8 * 3600) % 86400);
const start = nowSec + 180, end = start + 3600;
db.prepare("UPDATE specialarea SET start_time=?, end_time=?, is_open=10, open_days=?, buy_num=0 WHERE specialarea_id=1").run(start, end, '1,2,3,4,5,6,7');

const api = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
};
const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
const reg = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: '13991000001', password: 'advance123', code: 'boss01', nickName: '提前抢' } });
const mid = Number(reg.data?.member_id);
const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13991000001', password: 'advance123' } })).data.token;
await api('/admin/api/member/advance', { method: 'POST', token: at, body: { member_id: mid, enable: true, minutes: 5, count: 0 } });
const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
const cg = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_name: '提前抢UI样品', category_id: catId, goods_min_price: 500, stock_num: 1, goods_status: 10, goods_sort: 1 } });
const gid = Number(cg.data?.id);
db.prepare("UPDATE goods SET area_date='' WHERE goods_id=?").run(gid);
await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid] } });

const profile = mkdtempSync(join(tmpdir(), 'adv-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`, '--window-size=390,844', 'about:blank']);
let ok = false;
try {
  await sleep(2200);
  const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then(r => r.json());
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(tk)})}catch(e){}` });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, null).catch(() => {});
  const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  await send('Page.navigate', { url: `${BASE}/#/submit/${gid}` });
  await sleep(4500);
  const text = await evalJs('document.body.innerText.replace(/\\s+/g," ")');
  const blocked = text.includes('不在该场次抢购时间') || text.includes('商品不存在或已下架');
  const hasBtn = await evalJs(`!!document.querySelector('.submit__bar-btn')`);
  console.log('页面片段:', text.slice(0, 120));
  console.log('被拦截:', blocked, ' 有提交按钮:', hasBtn);
  ok = !blocked && hasBtn;
  await send('Browser.close').catch(() => {});
} finally {
  chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
  srv.kill();
  // 测试库留给下次运行自己清理（这里的批量删除会触发安全删除保护）
}
console.log(ok ? '✓ 提前抢购在确认订单页放行' : '✗ 确认订单页仍然拦截');
process.exit(ok ? 0 : 1);
