/**
 * 商品编辑表单瘦身验证：编码 / 现持有人 / 基准价 / 划线价 不再出现在编辑弹窗，
 * 但底层数据照样正确（新建时自动生成编码、基准价取售价、持有人归平台 0）。
 *
 * 跑完把新建的测试商品删掉，不留数据。
 *
 * 用法: node scripts/probe/goods-form.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9401;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REMOVED = ['商品编码', '现持有人', '基准价', '划线价'];
const KEPT = ['商品名称', '分类', '售卖价', '价格上限(元)', '库存', '状态'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  if (login.code !== 1) throw new Error('后台登录失败：' + login.msg);
  const token = login.data.token;

  const profile = mkdtempSync(join(tmpdir(), 'goodsform-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1200', 'about:blank',
  ]);

  await sleep(2200);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('没有可用 page target');

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

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };

  let createdId = 0;
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: `${WEB}/#/goods` });
    await sleep(4500);

    // 打开「新增商品」弹窗
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新增商品'));
      if (b) b.click();
    })()`);
    await sleep(1500);

    const labels = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      if (!d) return null;
      return {
        title: d.querySelector('.el-dialog__title')?.textContent?.trim() || '',
        labels: [...d.querySelectorAll('.el-form-item__label')].map((l) => l.textContent.trim()),
      };
    })()`);
    check('打开新增商品弹窗', !!labels && labels.title.includes('商品'), JSON.stringify(labels?.title));

    const missing = REMOVED.filter((t) => labels.labels.includes(t));
    check('四项已从表单移除', missing.length === 0, missing.length ? `仍在：${missing.join('、')}` : `现有 ${labels.labels.length} 项`);
    const keptMissing = KEPT.filter((t) => !labels.labels.includes(t));
    check('其余字段仍在（没有误删）', keptMissing.length === 0, keptMissing.length ? `缺少：${keptMissing.join('、')}` : JSON.stringify(labels.labels));

    // 填一个最小商品并保存：只填名称 + 售价
    const filled = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      const item = (t) => [...d.querySelectorAll('.el-form-item')].find((i) => i.querySelector('.el-form-item__label')?.textContent.trim() === t);
      const setInput = (el, val) => {
        if (!el) return false;
        const input = el.querySelector('input, textarea');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      };
      const okName = setInput(item('商品名称'), '探针测试商品');
      const okPrice = setInput(item('售卖价')?.querySelector('.el-input-number') || item('售卖价'), '123.45');
      return { okName, okPrice };
    })()`);
    check('能填写商品名称与售卖价', filled.okName && filled.okPrice, JSON.stringify(filled));

    await sleep(400);
    await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      const b = [...d.querySelectorAll('.el-dialog__footer button')].find((x) => x.textContent.trim() === '保存');
      if (b) b.click();
    })()`);
    await sleep(2200);

    const savedOk = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      return !d;   // 保存成功会关弹窗
    })()`);
    check('保存后弹窗关闭', savedOk === true);

    // 直接查库确认落库结果
    const list = await fetch(`${API}/admin/api/goods/list?page=1&limit=200&keyword=${encodeURIComponent('探针测试商品')}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const row = (list.data?.data || []).find((g) => g.goods_name === '探针测试商品');
    check('新商品已创建', !!row, row ? `goods_id=${row.goods_id}` : '未找到');
    if (row) {
      createdId = row.goods_id;
      check('商品编码自动生成', /^GP\d+$/.test(String(row.goods_no || '')), String(row.goods_no));
      check('基准价自动取售卖价', Math.abs(Number(row.base_price) - 123.45) < 0.01, `${row.base_price} vs 123.45`);
      check('持有人归平台（0）', Number(row.member_id) === 0, String(row.member_id));
      check('划线价默认 0', Number(row.line_price) === 0, String(row.line_price));
    }

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'goods-form.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/goods-form.png');
    } catch {}

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    if (createdId) {
      const del = await fetch(`${API}/admin/api/goods/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: [createdId] }),
      }).then((r) => r.json());
      console.log(del.code === 1 ? '已删除测试商品' : `测试商品清理失败：${del.msg}`);
    }
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
