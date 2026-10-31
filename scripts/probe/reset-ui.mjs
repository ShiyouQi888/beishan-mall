/**
 * 数据清除页（后台 → 系统设置 → 数据清除）交互回归。
 *
 * 修的问题是「选不动」，所以要验的正是点击本身：
 *   1) 直接点勾选框的方框，必须能选中（以前这里挂了 @click.stop 却没处理函数，点了没反应）
 *   2) 点卡片空白处也能选中
 *   3) 勾「会员」自动带上「订单与资金」，避免点了之后被后端拦下
 *   4) 没选中任何范围时，其余卡片的行数依然显示真实值（不能因为没勾就变 0）
 *   5) 「恢复出厂」只勾会员 + 订单资金，商品/分类/系统设置不在里面
 *
 * 全程只读：点开确认弹窗后取消，不真的清库。
 *
 * 用法: node scripts/probe/reset-ui.mjs [服务地址=5274]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = process.argv[2] || 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9381;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const profile = mkdtempSync(join(tmpdir(), 'reset-ui-'));
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

  /** 用真实鼠标事件点某个元素（element.click() 测不出「点方框没反应」这种问题） */
  async function realClick(selector) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box || !box.w) return null;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return box;
  }

  const snapshot = () => evaluate(`(() => {
    const cards = [...document.querySelectorAll('.scope')];
    return {
      selected: cards.map((c) => c.classList.contains('on')),
      labels: cards.map((c) => c.querySelector('.scope-t')?.textContent?.trim() || ''),
      counts: cards.map((c) => Number(c.querySelector('.scope-n b')?.textContent || 0)),
      total: Number((document.querySelector('.foot-tip b')?.textContent || '0').replace(/[^0-9]/g, '')),
    };
  })()`);

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: `${WEB}/setting/danger` });
    await sleep(4500);

    const title = await evaluate(`(document.querySelector('.page-head h2') || {}).textContent || ''`);
    check('打开数据清除页', String(title).includes('数据清除'), String(title));

    const s0 = await snapshot();
    check(
      '七个范围卡片都渲染了',
      s0.labels.length === 7
        && ['订单与资金', '转拍订单', '系统回收', '积分兑换', '会员与团队', '商品复位', '未引用的素材']
          .every((t) => s0.labels.includes(t)),
      JSON.stringify(s0.labels),
    );
    check('没勾选时行数也是真实值（不是全 0）', s0.counts.some((n) => n > 0), JSON.stringify(s0.counts));
    check('商品范围默认不勾选', s0.selected[s0.labels.indexOf('商品复位')] === false, JSON.stringify(s0.selected));

    // ---- 关键回归：点勾选框方框本身 ----
    const box = await realClick('.scope .el-checkbox');
    check('点到勾选框方框', !!box, box ? `${Math.round(box.x)},${Math.round(box.y)}` : 'no-box');
    await sleep(900);
    const s1 = await snapshot();
    check('点方框就能勾上（以前点了没反应）', s1.selected[0] === true, JSON.stringify(s1.selected));
    check('勾上后合计行数 > 0', s1.total > 0, String(s1.total));

    // ---- 点卡片空白处 ----
    await realClick('.scope:nth-child(2) .scope-d');
    await sleep(900);
    const s2 = await snapshot();
    check('点卡片空白处也能勾上', s2.selected[1] === true, JSON.stringify(s2.selected));

    // ---- 再点一次取消 ----
    await realClick('.scope .el-checkbox');
    await sleep(900);
    const s3 = await snapshot();
    check('再点一次能取消勾选（不会点一下变两下）', s3.selected[0] === false, JSON.stringify(s3.selected));

    // ---- 清空后行数依旧 ----
    await evaluate(`(() => { const a=[...document.querySelectorAll('.panel-head .link')].find(x=>x.textContent.includes('全不选')); if(a) a.click(); })()`);
    await sleep(800);
    const s4 = await snapshot();
    check('全不选后所有卡片行数依然是真实值', s4.selected.every((v) => v === false) && s4.counts.some((n) => n > 0), JSON.stringify(s4.counts));

    // ---- 勾会员自动带上订单 ----
    const memberIdx = s4.labels.indexOf('会员与团队');
    await realClick(`.scope:nth-child(${memberIdx + 1}) .el-checkbox`);
    await sleep(1000);
    const s5 = await snapshot();
    const tradeIdx = s5.labels.indexOf('订单与资金');
    check('勾「会员」自动带上「订单与资金」', s5.selected[memberIdx] === true && s5.selected[tradeIdx] === true, JSON.stringify(s5.selected));

    // ---- 恢复出厂 ----
    await evaluate(`(() => { const a=[...document.querySelectorAll('.panel-head .link')].find(x=>x.textContent.includes('全不选')); if(a) a.click(); })()`);
    await sleep(700);
    const factoryBox = await realClick('.factory button');
    check('「恢复出厂设置」按钮可点', !!factoryBox);
    await sleep(1200);
    const dlg = await evaluate(`(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
      if (!d) return null;
      return {
        title: d.querySelector('.el-dialog__title')?.textContent?.trim() || '',
        items: [...d.querySelectorAll('.risk ul li b')].map((b) => b.textContent.trim()),
        confirmBtn: [...d.querySelectorAll('.el-dialog__footer button')].map((b) => b.textContent.trim()),
        confirmDisabled: [...d.querySelectorAll('.el-dialog__footer button')].some(
          (b) => b.textContent.includes('确认清除') && (b.disabled || b.classList.contains('is-disabled')),
        ),
        hint: d.querySelector('.cb-hint')?.textContent?.trim() || '',
      };
    })()`);
    check('弹出确认框', !!dlg && dlg.title.includes('确认清除'), JSON.stringify(dlg?.title));
    check(
      '恢复出厂包含七个范围（订单/转拍/回收/兑换/会员/商品/素材）',
      !!dlg
        && dlg.items.length === 7
        && ['订单', '转拍', '回收', '兑换', '会员', '商品', '素材'].every((kw) => dlg.items.some((t) => t.includes(kw))),
      JSON.stringify(dlg?.items),
    );
    check('没输确认语时「确认清除」是禁用的', dlg?.confirmDisabled === true, String(dlg?.confirmDisabled));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'reset-confirm.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/reset-confirm.png');
    } catch {}

    // 取消，绝不真的执行
    await evaluate(`(() => { const d=[...document.querySelectorAll('.el-dialog')].find(x=>x.offsetParent!==null); const b=d && [...d.querySelectorAll('.el-dialog__footer button')][0]; if(b) b.click(); })()`);
    await sleep(800);

    // 关掉弹窗后照一张整页，方便看布局
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(process.cwd(), '_probe', 'reset-page.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/reset-page.png');
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
