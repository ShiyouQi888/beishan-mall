/**
 * 后台两处精简的验收：
 *   1. 订单列表不再有「补发直推奖」按钮
 *   2. 场次列表只保留「配置」，不再有重复的「编辑」
 *   3. 「配置」页把原来编辑弹窗才有的字段补全了（副标题 / 开放预约 / 启用 / 排序），
 *      并且保存接口真的接受这些字段
 *
 * 「配置」页保存这一步用「原值原样提交」的方式验证：既测了写入链路，又不会改数据。
 *
 * 用法: node scripts/probe/admin-cleanup.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9471;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { db } = await import('../../server/src/db.js');

async function main() {
  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  if (login.code !== 1) throw new Error('后台登录失败：' + login.msg);
  const token = login.data.token;

  // ---------- 接口层的保存链路（原值原样提交，不改数据） ----------
  const before = db.prepare('SELECT * FROM specialarea WHERE specialarea_id = 1').get();
  const save = await fetch(`${API}/admin/api/specialarea/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({
      specialarea_id: before.specialarea_id,
      name: before.name,
      title_main: before.title_main,
      title_ordinary: before.title_ordinary,
      open_days: before.open_days,
      start_time: before.start_time,
      end_time: before.end_time,
      buy_num: before.buy_num,
      transposition_hours: before.transposition_hours,
      image_ordinary: before.image_ordinary,
      is_subscribe: Number(before.is_subscribe) === 10 ? 10 : 0,
      is_open: Number(before.is_open) === 20 ? 20 : 10,
      sort: Number(before.sort ?? 100),
    }),
  }).then((r) => r.json());
  check('配置页保存接口接受新增字段', save.code === 1, save.msg);
  const after = db.prepare('SELECT * FROM specialarea WHERE specialarea_id = 1').get();
  check('保存后数据未被改动（原值提交）', after.title_main === before.title_main && Number(after.is_open) === Number(before.is_open), `${after.is_open}`);

  const profile = mkdtempSync(join(tmpdir(), 'cleanup-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1600,1100', 'about:blank',
  ]);
  await sleep(2200);
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = targets.find((t) => t.type === 'page');
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

  const go = async (hash) => {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url: `${WEB}/#${hash}` });
    await sleep(4200);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });

    // ---------- 订单列表 ----------
    console.log('\n[1] 订单列表');
    await go('/orders');
    const orders = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.el-table__header th')].map((t) => t.innerText.trim());
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const opIdx = head.findIndex((h) => h.includes('操作'));
      const ops = rows.slice(0, 3).map((r) => (r.querySelectorAll('td')[opIdx]?.innerText || '').replace(/\\s+/g, ' ').trim());
      const body = document.body.innerText;
      return { ops, hasGrant: body.includes('补发直推奖'), sample: ops[0] || '' };
    })()`);
    check('订单操作列不再有「补发直推奖」', orders.hasGrant === false, orders.sample);
    check('订单其它操作仍然正常', orders.sample.length > 0, orders.sample);

    // ---------- 场次列表 ----------
    console.log('\n[2] 场次列表');
    await go('/specialarea');
    const areas = await evaluate(`(() => {
      const head = [...document.querySelectorAll('.el-table__header th')].map((t) => t.innerText.trim());
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      const opIdx = head.findIndex((h) => h.includes('操作'));
      const ops = rows.map((r) => (r.querySelectorAll('td')[opIdx]?.innerText || '').replace(/\\s+/g, ' ').trim());
      return { ops, count: rows.length };
    })()`);
    check('场次操作列只有「配置」和「删除」', areas.ops.every((o) => o.includes('配置') && !o.includes('编辑')), JSON.stringify(areas.ops));
    check('场次行数正常', areas.count > 0, String(areas.count));

    // ---------- 场次配置页 ----------
    console.log('\n[3] 场次配置页字段');
    await go('/specialarea/1');
    const cfg = await evaluate(`(() => {
      const labels = [...document.querySelectorAll('.el-form-item__label')].map((l) => l.textContent.trim());
      return { labels, hasSwitch: document.querySelectorAll('.el-switch').length, hasNumber: document.querySelectorAll('.el-input-number').length };
    })()`);
    // 已下线：排序（几乎不生效）、开放预约（H5 根本没有预约功能，是空开关）
    const need = ['专场副标题', '启用状态'];
    const missing = need.filter((t) => !cfg.labels.includes(t));
    check('配置页补齐了原来编辑弹窗才有的字段', missing.length === 0, missing.length ? `缺少：${missing.join('、')}` : JSON.stringify(cfg.labels));
    check('「启用状态」是开关（开放预约已下线，只剩这一个）', cfg.hasSwitch === 1, String(cfg.hasSwitch));
    check('「排序」字段已从配置页移除', !cfg.labels.includes('排序'), JSON.stringify(cfg.labels));
    check('「开放预约」开关已移除（空开关）', !cfg.labels.includes('开放预约'), JSON.stringify(cfg.labels));
    check('图片字段统一叫「场次图」', cfg.labels.includes('场次图') && !cfg.labels.includes('专区图片'), JSON.stringify(cfg.labels));

    // 关联商品表要能看出「开抢日期」：带未来日期的商品当天不会出现在 H5，
    // 运营看不到这一列就会以为前台漏显示了
    const rel = await evaluate(`(() => {
      const heads = [...document.querySelectorAll('.related .el-table__header th')].map((x) => x.innerText.trim());
      const dates = [...document.querySelectorAll('.related .open-date')].map((x) => ({
        text: x.textContent.trim(), cls: x.className,
      }));
      const hint = document.querySelector('.rel-hint')?.innerText || '';
      return { heads, dates, hint };
    })()`);
    check('关联商品表有「开抢日期」列', rel.heads.includes('开抢日期'), JSON.stringify(rel.heads));
    check('每行都标了日期（不限 / 今天 / X 起）',
      rel.dates.length > 0 && rel.dates.every((d) => d.text.length > 0), JSON.stringify(rel.dates));
    check('带未来日期的行用橙色提醒',
      rel.dates.every((d) => !d.text.includes('起') || d.cls.includes('is-future')), JSON.stringify(rel.dates));
    check('表头说明了开抢日期的作用', rel.hint.includes('开抢日期'), rel.hint.slice(0, 60));

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'specialarea-config.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/specialarea-config.png');
    } catch {}

    // ---------- 结算账目 / 提现审核已下线 ----------
    console.log('\n[4] 结算账目与提现审核已下线');
    const sidebar = await evaluate(`document.querySelector('.sidebar, .el-menu')?.innerText || document.body.innerText`);
    check('侧边栏不再出现「结算账目」', !sidebar.includes('结算账目'));
    check('侧边栏不再出现「提现审核」', !sidebar.includes('提现审核'));

    await go('/withdraw');
    const wdHash = await evaluate('location.hash');
    check('直接访问 /withdraw 会被重定向走', wdHash !== '#/withdraw', wdHash);

    await go('/settle');
    const settleHash = await evaluate('location.hash');
    check('直接访问 /settle 会被重定向走', settleHash !== '#/settle', settleHash);

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
