// H5 UI 交互冒烟：真实点击 + DOM 断言 + 控制台错误收集
// 注意：为避免污染演示库，本脚本只做「导航 / 切页 / 打开弹窗 / 断言渲染」，
//       不提交下单、提现、转拍等写操作（这些由 h5-e2e-api.mjs 覆盖业务逻辑）。
// 用法: node scripts/probe/h5-e2e-ui.mjs [baseUrl] [token]
const [, , BASE_ARG, TOKEN_ARG] = process.argv;
const BASE = BASE_ARG || 'http://127.0.0.1:5273';
const TOKEN = TOKEN_ARG || '';
const PORT = 9333;
const CDP = `http://127.0.0.1:${PORT}`;

const { writeFileSync } = await import('node:fs');

async function wsUrl() {
  for (let i = 0; i < 30; i++) {
    try { return (await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('Chrome 调试端口未就绪（请先启动 --remote-debugging-port=9333）');
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
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0]);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push('[error] ' + m.params.entry.text);
  }
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
if (TOKEN) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('TOKEN',${JSON.stringify(TOKEN)})}catch(e){}`,
  }, sessionId);
}

let pass = 0;
const fails = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(expression) {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return result.value;
}

// 必须先真正打开页面，否则后续只改 hash 不会加载应用
await send('Page.navigate', { url: BASE + '/#/' }, sessionId);
await sleep(3000);
const onApp = (await ev('location.origin')) !== 'null';
if (!onApp) throw new Error('页面未加载：' + BASE);

async function go(hash, wait = 1600) {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(wait);
}

function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const has = async (txt) => (await ev(`document.body.innerText.includes(${JSON.stringify(txt)})`)) === true;
const count = async (sel) => (await ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`)) || 0;

async function clickText(txt, sel = 'button, .btn-main, .mini, .func, .q, .nav, .more, .item__actions button, .tab') {
  return ev(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els.find((e) => (e.innerText || '').trim() === ${JSON.stringify(txt)});
    if (!el) return 'notfound';
    el.click();
    return 'ok';
  })()`);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(`_probe/ui-${name}.png`, Buffer.from(data, 'base64'));
}

async function section(title, fn) {
  console.log(`\n${title}`);
  const before = consoleErrors.length;
  try { await fn(); } catch (e) { ok(false, `${title} 执行异常`, e.message); }
  const errs = consoleErrors.slice(before);
  if (errs.length) ok(false, `${title} 无控制台错误`, errs.slice(0, 3).join(' | '));
  else ok(true, `${title} 无控制台错误`);
}

try {
  // ---------- 登录 ----------
  await section('[1] 登录页与登录流程', async () => {
    await go('#/login', 2000);
    ok(await has('欢迎回来'), '登录页渲染');
    ok((await count('input')) >= 2, '登录页有手机号与密码输入框', `${await count('input')} 个`);
    ok(await has('注册新账号'), '登录页有注册入口');
    // 未填直接提交
    await clickText('登 录') === 'ok' ? null : await clickText('登录');
    await sleep(600);
    ok(await has('手机号'), '空提交时仍停留在登录页');
  });

  if (!TOKEN) {
    console.log('\n未提供 token，后续需登录的步骤跳过。用法: node scripts/probe/h5-e2e-ui.mjs <base> <token>');
  } else {
    // ---------- 首页 ----------
    await section('[2] 首页渲染与底部导航', async () => {
      await go('#/', 2600);
      ok(await has('限量发售') || await has('抢购'), '首页渲染促销/抢购区');
      const cards = await count('.goods-card');
      ok(cards > 0, '首页渲染商品卡', `${cards} 张`);
      const imgs = await count('img');
      ok(imgs >= Math.min(cards, 1), '首页商品图正常渲染', `${imgs} 张图 / ${cards} 张卡`);
      // 「全部」分类标签已按需求下线（再点一次已选分类即取消筛选），这里反向断言
      ok(!(await has('全部')), '首页不再出现「全部」分类标签');
      ok(await has('首页'), '底部导航存在');
      await go('#/loot', 1800);
      ok(await has('场') || await has('抢购'), '抢购页可切换');
      await go('#/invite', 1800);
      ok(await has('邀请'), '邀请页可切换');
    });

    // ---------- 商品详情 ----------
    await section('[3] 商品详情与抢购入口', async () => {
      await go('#/', 2200);
      const clicked = await ev(`(() => {
        const card = document.querySelector('.goods-card, .g-card, .product, .card');
        const el = [...document.querySelectorAll('div, a')].find((e) => e.className && /goods|product/.test(e.className) && e.onclick !== null);
        const target = el || card;
        if (!target) return 'notfound';
        target.click();
        return 'ok';
      })()`);
      await sleep(1800);
      const onDetail = (await ev('location.hash')).includes('/goods/');
      ok(clicked === 'ok' && onDetail, '点击商品进入详情页', await ev('location.hash'));
      if (onDetail) {
        ok(await has('¥'), '详情页显示价格');
        ok((await count('.btn-main, button')) >= 1, '详情页有操作按钮');
      }
    });

    // ---------- 确认订单 ----------
    await section('[4] 确认订单页', async () => {
      const gid = await ev(`(async () => {
        const r = await fetch('/api/goods/getLootGoodsList?page=1&limit=1').then(x=>x.json());
        return (r.data?.data||[])[0]?.goods_id || 0;
      })()`);
      await go(`#/submit/${gid}`, 2200);
      ok(await has('确认订单'), '确认订单页渲染');
      ok(await has('商品金额'), '显示商品金额');
      ok(await has('服务费'), '显示服务费行');
      ok(await has('合计'), '显示应付合计');
      await shot('submit');
    });

    // ---------- 订单列表与转拍弹窗 ----------
    await section('[5] 订单列表与转拍弹窗', async () => {
      await go('#/order', 2200);
      ok(await has('我的订单'), '订单列表渲染');
      ok(await has('全部'), '订单状态筛选存在');
      const t = await clickText('转拍');
      if (t === 'ok') {
        await sleep(1600);
        ok(await has('转拍上架'), '转拍弹窗打开');
        ok(await has('下一轮自动标价'), '弹窗显示自动标价');
        ok(await has('上架费'), '弹窗显示上架费');
        ok(await has('净收益'), '弹窗显示净收益');
        await shot('transfer');
        // 关闭弹窗，不提交
        await ev(`document.querySelector('.van-popup .van-icon-cross, .van-overlay')?.click()`);
        await sleep(800);
      } else {
        ok(true, '当前账号无可转拍订单（跳过弹窗）', t);
      }
    });

    // ---------- 我的 ----------
    await section('[6] 我的页面与功能入口', async () => {
      await go('#/mine', 2200);
      ok(await has('我的订单'), '我的页渲染');
      ok(await has('我的店铺'), '我的店铺入口存在');
      ok(await has('账户余额') || await has('钱包'), '资产区块存在');
      for (const entry of ['我的团队', '我的佣金', '收货地址', '实名认证']) {
        ok(await has(entry), `功能入口存在：${entry}`);
      }
    });

    // ---------- 我的店铺 ----------
    await section('[7] 我的店铺页', async () => {
      await go('#/my-shop', 2200);
      ok(await has('我的店铺'), '店铺页渲染');
      ok(await has('在售商品'), '展示在售件数');
      ok(await has('预计收益'), '展示预计收益');
      ok(await has('下一轮标价'), '商品卡显示下一轮标价', '');
      await shot('shop');
    });

    // ---------- 钱包 / 提现 ----------
    await section('[8] 钱包与提现页', async () => {
      await go('#/wallet', 2000);
      ok(await has('我的钱包'), '钱包页渲染');
      ok(await has('余额'), '显示余额');
      await go('#/withdraw', 2000);
      ok(await has('申请提现'), '提现页渲染');
      ok(await has('可提现余额'), '显示可提现余额');
      ok(await has('最低提现'), '显示最低提现门槛');
    });

    // ---------- 地址 ----------
    await section('[9] 收货地址', async () => {
      await go('#/address', 2000);
      ok(await has('收货地址'), '地址页渲染');
      ok(await has('新增收货地址') || await has('新增'), '有新增地址入口');
      await go('#/address/edit', 1800);
      ok(await has('收货人'), '地址编辑页渲染');
      ok(await has('所在地区'), '地区选择存在');
    });

    // ---------- 实名 ----------
    await section('[10] 实名认证页', async () => {
      await go('#/identify', 2000);
      ok(await has('实名认证'), '实名页渲染');
      const txt = await ev('document.body.innerText.slice(0, 200)');
      ok(/已完成实名认证|审核中|未完成实名认证/.test(txt), '展示实名状态', txt.split('\n')[1] || '');
    });

    // ---------- 积分商城 ----------
    await section('[11] 积分商城', async () => {
      await go('#/score', 2000);
      ok(await has('积分商城'), '积分页渲染');
      ok(await has('我的积分'), '显示我的积分');
    });

    // ---------- 团队 / 佣金 ----------
    await section('[12] 团队与佣金', async () => {
      await go('#/team', 2000);
      ok(await has('我的团队'), '团队页渲染');
      await go('#/commission', 2000);
      ok(await has('我的佣金'), '佣金页渲染');
    });

    // ---------- 设置 / 公告 ----------
    await section('[13] 设置与公告', async () => {
      await go('#/setting', 2000);
      ok(await has('设置'), '设置页渲染');
      ok(await has('登录密码'), '有修改登录密码入口');
      ok(await has('支付密码'), '有支付密码入口');
      await go('#/notice', 1800);
      ok(await has('公告'), '公告页渲染');
    });

    // ---------- 分类与搜索 ----------
    await section('[14] 分类与搜索', async () => {
      await go('#/category', 2000);
      ok(await has('商品分类'), '分类页渲染');
      ok((await count('img, svg')) > 0, '分类图标渲染');
      await go('#/search', 1800);
      ok(await has('搜索'), '搜索页渲染');
    });
  }
} finally {
  console.log('\n' + '='.repeat(52));
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  if (consoleErrors.length) {
    console.log(`\n控制台错误 ${consoleErrors.length} 条：`);
    [...new Set(consoleErrors)].slice(0, 10).forEach((e) => console.log('  ' + e.slice(0, 140)));
  }
  if (fails.length) {
    console.log('\n失败项：');
    fails.forEach((f) => console.log('  · ' + f));
  }
  await send('Target.closeTarget', { targetId });
  ws.close();
  process.exit(fails.length ? 1 : 0);
}
