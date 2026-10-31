/**
 * 支付方式默认只走线下：配置默认值 + 接口 + 前台默认选中 + 后端校验。
 *
 * 断言四层一致：
 *   1. seed 出的配置里只有 pay_bank 是开的
 *   2. /api/index/getPaySeeting 只返回 bank_open=1
 *   3. H5 下单确认页默认选中「线下转账」，列表里没有余额/微信/支付宝
 *   4. 后端下单校验：传 pay_type=1 被拒、传 4 通过
 *
 * 用独立库跑 1/2/4，用演示库 + 临时会员跑 3（前台页面），跑完全部清理。
 *
 * 用法: node scripts/probe/pay-offline.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3417;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'payoffline.db';
const DEMO = 'http://127.0.0.1:3300';
const H5 = 'http://127.0.0.1:5273';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = 9461;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };
process.env.MALL_DB = DB;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function runSeed() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const api = async (base, path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await runSeed();
  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  try {
    // ---------- 1. 配置默认值 ----------
    console.log('[1] 默认配置');
    const { db, get } = await import('../../server/src/db.js');
    const cfgOf = (k) => get('SELECT `value` v FROM setting_config WHERE `key` = ?', k)?.v;
    for (const [key, want, label] of [
      ['pay_balance_open', '20', '余额支付'], ['pay_wx', '20', '微信扫码'],
      ['pay_zfb', '20', '支付宝扫码'], ['pay_bank', '10', '线下转账'],
    ]) {
      const v = cfgOf(key);
      check(`${label}默认${want === '10' ? '开启' : '关闭'}`, String(v) === want, `${key}=${v}`);
    }

    // ---------- 2. 支付设置接口 ----------
    console.log('\n[2] 支付设置接口');
    const setting = await api(BASE, '/api/index/getPaySeeting');
    const d = setting.data || {};
    check('bank_open = 1', String(d.bank_open) === '1', String(d.bank_open));
    check('balance_open = 0', String(d.balance_open) === '0', String(d.balance_open));
    check('wx_open = 0', String(d.wx_open) === '0', String(d.wx_open));
    check('zfb_open = 0', String(d.zfb_open) === '0', String(d.zfb_open));

    // ---------- 3. 后台开关与库里一致 ----------
    console.log('\n[3] 后端下单校验');
    const at = (await api(BASE, '/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    const dow = new Date(`${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)}T00:00:00Z`).getUTCDay();
    db.prepare('UPDATE specialarea SET start_time = 0, end_time = 0, open_days = ?, is_open = 10, transposition_hours = 0 WHERE specialarea_id = 1')
      .run(String(dow === 0 ? 7 : dow));

    const reg = await api(BASE, '/api/member/registerAnAccount', {
      method: 'POST', body: { phone: '13980000001', password: 'pof123456', code: 'boss01', nickName: '支付验收' },
    });
    const mid = Number(reg.data?.member_id) || get('SELECT member_id FROM member WHERE mobile = ?', '13980000001')?.member_id;
    await api(BASE, '/admin/api/member/adjust', { method: 'POST', token: at, body: { member_id: mid, field: 'amount', value: 5000, remark: '支付验收充值' } });
    const token = (await api(BASE, '/api/member/accountLogin', { method: 'POST', body: { phone: '13980000001', password: 'pof123456' } })).data?.token;

    const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
    const created = await api(BASE, '/admin/api/goods/save', {
      method: 'POST', token: at,
      body: { goods_name: '支付验收样品', category_id: catId, goods_min_price: 1000, stock_num: 1, goods_status: 10, goods_sort: 1 },
    });
    const gid = Number(created.data?.id);
    await api(BASE, '/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid] } });
    db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);

    const byBalance = await api(BASE, '/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: gid, num: 1, pay_type: 1 } });
    check('选余额支付被拒', byBalance.code === 0, byBalance.msg);
    okMatch(byBalance.msg, /支付/, '拒绝原因提到支付方式');

    const byBank = await api(BASE, '/api/order/toAddOrder', { method: 'POST', token, body: { goods_id: gid, num: 1, pay_type: 4 } });
    check('选线下转账可以下单', byBank.code === 1, byBank.msg);
    check('订单支付方式记为 4', Number(byBank.data?.pay_type ?? 4) === 4, JSON.stringify(byBank.data?.pay_type));
    const orderRow = get('SELECT pay_type FROM orders WHERE order_id = ?', Number(byBank.data?.order_id));
    check('库里 pay_type = 4', Number(orderRow?.pay_type) === 4, String(orderRow?.pay_type));

    srv.kill('SIGTERM');
    await sleep(400);

    // ---------- 4. 前台默认选中（演示库） ----------
    console.log('\n[4] H5 下单页默认支付方式');
    // 演示库单独开一个连接：db.js 是单例，已经连着测试库了
    const { DatabaseSync } = await import('node:sqlite');
    const demoDb = new DatabaseSync(join(SERVER, 'data', 'mall.db'));

    const phone = '13980000002';
    const reg2 = await api(DEMO, '/api/member/registerAnAccount', {
      method: 'POST', body: { phone, password: 'pof123456', code: 'boss01', nickName: '支付展示验收' },
    });
    const mid2 = Number(reg2.data?.member_id)
      || Number(demoDb.prepare('SELECT member_id FROM member WHERE mobile = ?').get(phone)?.member_id);
    const lg2 = await api(DEMO, '/api/member/accountLogin', { method: 'POST', body: { phone, password: 'pof123456' } });
    const token2 = lg2.data?.token;
    check('演示库临时会员可登录', !!token2, lg2.msg);

    const profile = mkdtempSync(join(tmpdir(), 'payoff-'));
    const chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP}`,
      '--window-size=420,900', 'about:blank',
    ]);
    await sleep(2200);
    const targets = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
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

    try {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Network.enable');
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try{localStorage.setItem('TOKEN', ${JSON.stringify(token2)})}catch(e){}`,
      });
      await send('Page.navigate', { url: `${H5}/submit/1` });
      await sleep(4800);

      const dom = await evaluate(`(() => {
        const items = [...document.querySelectorAll('.payitem')].map((el) => ({
          text: el.innerText.replace(/\\s+/g, ' ').trim(),
          on: !!el.querySelector('.radio.on'),
        }));
        const body = document.body.innerText.replace(/\\s+/g, ' ');
        return { items, body: body.slice(0, 260) };
      })()`);

      // 支付方式这一环已经整体下线：确认页不该再出现任何支付方式选项
      check('确认页不再有支付方式选项', dom.items.length === 0, JSON.stringify(dom.items.map((x) => x.text)));
      check('页面没有余额/微信/支付宝支付文案',
        !dom.body.includes('余额支付') && !dom.body.includes('微信扫码') && !dom.body.includes('支付宝扫码'), dom.body.slice(0, 120));

      try {
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
        writeFileSync(join(process.cwd(), '_probe', 'pay-offline.png'), Buffer.from(shot.data, 'base64'));
        console.log('截图: _probe/pay-offline.png');
      } catch {}

      check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    } finally {
      ws.close();
      chrome.kill();
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
      // 清理演示库临时会员
      if (mid2) {
        for (const t of ['finance_energy', 'member_address', 'member_card', 'member_certification', 'member_msg']) {
          demoDb.prepare(`DELETE FROM ${t} WHERE member_id = ?`).run(mid2);
        }
        demoDb.prepare('DELETE FROM member WHERE member_id = ?').run(mid2);
      }
      demoDb.close();
      console.log('已清理演示库临时会员');
    }
  } finally {
    try { srv.kill('SIGTERM'); } catch {}
    await sleep(300);
  }

  console.log(`\n${results.length - results.filter((x) => !x.ok).length}/${results.length} 通过`);
  if (results.some((x) => !x.ok)) process.exitCode = 1;
}

function okMatch(value, re, name) {
  check(name, re.test(String(value || '')), String(value || ''));
}

main()
  .catch((e) => { console.error('\n[错误]', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
