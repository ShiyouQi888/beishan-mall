/**
 * 控制面板（仪表盘）指标验收。
 *
 * 背景：发货、收货、提现审核三个模块早就下线了，卡片还挂着「待发货/待收货/待提现审核」，
 * 值永远是 0，运营看着以为有活没干。这次按现行业务（抢单 → 确认 → 转拍 → 回收 + 积分兑换）重排。
 *
 * 覆盖：
 *   1. 接口：5 张待办卡是现行指标，旧的三个字段彻底不在
 *   2. 接口：每张卡的数值与库里 COUNT 对得上
 *   3. 接口：经营概览字段齐全且金额口径正确（只算已确认订单）
 *   4. 接口：最近订单状态只说「待确认/已确认」，不再出现发货字眼
 *   5. 页面：五张卡渲染、点「在挂转拍」跳转正确、概览六项在、整页没有下线模块的字样
 *
 * 只读，不造数据。
 *
 * 用法: node scripts/probe/dashboard-metrics.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const ADMIN = 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9529;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const { get } = await import('../../server/src/db.js');
const { todayStr } = await import('../../server/src/lib/sessionWindow.js');

async function main() {
  const admin = await fetch(`${API}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  const token = admin.data?.token;
  if (!token) throw new Error('管理员登录失败');

  const today = todayStr();
  const api = await fetch(`${API}/admin/api/dashboard`, { headers: { token } }).then((r) => r.json());
  const d = api.data || {};

  // ---------- 1. 卡片 ----------
  console.log('[1] 待办卡');
  const keys = (d.cards || []).map((c) => c.key);
  const labels = (d.cards || []).map((c) => c.label);
  check('五张待办卡', d.cards?.length === 5, `${d.cards?.length}`);
  check('卡片刻意不含已下线指标',
    !keys.some((k) => ['wait_send', 'wait_receive', 'wait_withdraw'].includes(k)), keys.join(','));
  check('五张卡是现行业务',
    ['wait_confirm', 'transposing', 'wait_recycle', 'wait_score', 'wait_cert'].every((k) => keys.includes(k)), keys.join(','));
  check('卡片没有发货/提现字眼',
    !labels.some((t) => /发货订单|收货|提现/.test(t)), labels.join('/'));

  const num = (sql, ...p) => Number(get(sql, ...p)?.c || 0);
  const expect = {
    wait_confirm: num("SELECT COUNT(*) c FROM orders WHERE IFNULL(pay_status,0)=0 AND IFNULL(status,0)<>40"),
    transposing: num(`SELECT COUNT(*) c FROM orders o JOIN goods g ON g.goods_id=o.goods_id
      WHERE o.type=1 AND IFNULL(o.consignment_status,0)=10 AND g.member_id=o.member_id
        AND g.goods_status=10 AND IFNULL(g.recycled,0)=0`),
    wait_recycle: num('SELECT COUNT(*) c FROM goods_recycle WHERE IFNULL(status,0)=0'),
    wait_score: num('SELECT COUNT(*) c FROM score_exchange WHERE status=10'),
    wait_cert: num('SELECT COUNT(*) c FROM member_certification WHERE status=0'),
  };
  for (const [k, v] of Object.entries(expect)) {
    const card = (d.cards || []).find((c) => c.key === k);
    check(`${card?.label || k} 与库里一致`, Number(card?.value) === v, `接口 ${card?.value} / 库 ${v}`);
  }
  check('每张卡都有跳转路由', (d.cards || []).every((c) => String(c.route || '').startsWith('/')), (d.cards || []).map((c) => c.route).join(','));
  check('每张卡都有说明文案', (d.cards || []).every((c) => !!c.tip), '');

  // ---------- 2. 概览 ----------
  console.log('\n[2] 经营概览');
  const o = d.overview || {};
  const required = ['member_total', 'member_today', 'goods_total', 'goods_online', 'goods_capped',
    'order_total', 'order_today', 'turnover_total', 'turnover_today',
    'fee_total', 'fee_today', 'listing_fee_total', 'listing_fee_today', 'amount_total', 'commission_total'];
  check('字段齐全', required.every((k) => o[k] !== undefined), required.filter((k) => o[k] === undefined).join(','));

  check('会员总数', o.member_total === num('SELECT COUNT(*) c FROM member'), `${o.member_total}`);
  check('会员今日新增', o.member_today === num('SELECT COUNT(*) c FROM member WHERE create_time >= ?', today), `${o.member_today}`);
  check('在售商品只算在架且未封顶',
    o.goods_online === num('SELECT COUNT(*) c FROM goods WHERE goods_status=10 AND IFNULL(recycled,0)=0'), `${o.goods_online}`);
  check('封顶商品数', o.goods_capped === num('SELECT COUNT(*) c FROM goods WHERE IFNULL(recycled,0)<>0'), `${o.goods_capped}`);
  check('订单总数', o.order_total === num('SELECT COUNT(*) c FROM orders'), `${o.order_total}`);

  const sum = (sql, ...p) => Number(Number(get(sql, ...p)?.v || 0).toFixed(2));
  check('成交额只算已确认',
    Math.abs(Number(o.turnover_total) - sum('SELECT IFNULL(SUM(total_price),0) v FROM orders WHERE pay_status=10')) < 0.01,
    `${o.turnover_total}`);
  check('今日成交额',
    Math.abs(Number(o.turnover_today) - sum('SELECT IFNULL(SUM(total_price),0) v FROM orders WHERE pay_status=10 AND create_time>=?', today)) < 0.01,
    `${o.turnover_today}`);
  check('服务费累计/今日都对得上',
    Math.abs(Number(o.fee_total) - sum('SELECT IFNULL(SUM(service_charge),0) v FROM orders WHERE pay_status=10')) < 0.01
    && Math.abs(Number(o.fee_today) - sum('SELECT IFNULL(SUM(service_charge),0) v FROM orders WHERE pay_status=10 AND create_time>=?', today)) < 0.01,
    `${o.fee_today} / ${o.fee_total}`);
  check('上架费字段存在且非负', Number(o.listing_fee_today) >= 0 && Number(o.listing_fee_total) >= 0,
    `${o.listing_fee_today} / ${o.listing_fee_total}`);
  check('会员余额与佣金', Number(o.amount_total) >= 0 && Number(o.commission_total) >= 0,
    `${o.amount_total} / ${o.commission_total}`);

  // ---------- 3. 趋势与最近订单 ----------
  console.log('\n[3] 趋势与最近订单');
  check('趋势 7 天', (d.trend || []).length === 7, String((d.trend || []).length));
  check('趋势末日是今天', d.trend?.[6]?.date === today.slice(5), `${d.trend?.[6]?.date} vs ${today.slice(5)}`);
  const rec = d.recent_orders || [];
  check('最近订单状态只说确认', rec.every((x) => ['待确认', '已确认'].includes(x.status_text)),
    rec.map((x) => x.status_text).join(','));
  check('最近订单没有发货字眼', !rec.some((x) => /发货|收货|待付款/.test(x.status_text)), '');

  // ---------- 4. 页面 ----------
  console.log('\n[4] 页面');
  const profile = mkdtempSync(join(tmpdir(), 'dash-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1600,1200', 'about:blank',
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

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
    });
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url: `${ADMIN}/` });
    await sleep(4600);

    const ui = await evaluate(`(() => ({
      cards: [...document.querySelectorAll('.dash-cards .stat-card')].map((c) => ({
        label: c.querySelector('.label')?.textContent?.trim() || '',
        value: c.querySelector('.value')?.textContent?.trim() || '',
        hint: c.querySelector('.hint')?.textContent?.trim() || '',
      })),
      overview: [...document.querySelectorAll('.ov')].map((x) => ({
        k: x.querySelector('.ov-k')?.textContent?.trim() || '',
        v: x.querySelector('.ov-v')?.textContent?.trim() || '',
      })),
      body: document.body.innerText.replace(/\\s+/g, ' '),
      bars: document.querySelectorAll('.bar-wrap').length,
    }))()`);

    check('页面渲染出 5 张卡', ui.cards.length === 5, JSON.stringify(ui.cards.map((c) => c.label)));
    check('卡片标题与接口一致', ui.cards.map((c) => c.label).join('/') === labels.join('/'),
      `${ui.cards.map((c) => c.label).join('/')} vs ${labels.join('/')}`);
    check('卡片带说明文案', ui.cards.every((c) => c.hint && c.hint !== '点击查看明细 ›'), JSON.stringify(ui.cards.map((c) => c.hint)));
    check('概览六项', ui.overview.length === 6, JSON.stringify(ui.overview.map((x) => x.k)));
    check('趋势图 7 根柱', ui.bars === 7, String(ui.bars));
    check('页面没有「待发货订单/待收货订单/待提现审核」',
      !/待发货订单|待收货订单|待提现审核/.test(ui.body),
      (ui.body.match(/待发货订单|待收货订单|待提现审核/g) || []).join(','));

    try {
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'dashboard-metrics.png'), Buffer.from(s.data, 'base64'));
      console.log('截图: _probe/dashboard-metrics.png');
    } catch {}

    // 点「在挂转拍」能跳到转拍订单页
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.dash-cards .stat-card')]
        .find((c) => (c.querySelector('.label')?.textContent || '').includes('在挂转拍'));
      if (card) card.click();
    })()`);
    await sleep(1800);
    const path = await evaluate('location.pathname');
    check('点「在挂转拍」跳到转拍订单页', path === '/transpose', path);

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
