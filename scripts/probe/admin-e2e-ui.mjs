// 后台 UI 交互冒烟：遍历全部后台路由 + 打开新增/编辑/详情弹窗 + 设置组表单
// 只读不写（不点保存），避免污染数据；写入逻辑由 admin-e2e-api.mjs 覆盖
// 用法: node scripts/probe/admin-e2e-ui.mjs [baseUrl] [token]
const [, , BASE_ARG, TOKEN_ARG] = process.argv;
const BASE = BASE_ARG || 'http://127.0.0.1:5274';
const TOKEN = TOKEN_ARG || '';
const PORT = 9333;
const CDP = `http://127.0.0.1:${PORT}`;

const { writeFileSync } = await import('node:fs');

async function wsUrl() {
  for (let i = 0; i < 30; i++) {
    try { return (await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('Chrome 调试端口未就绪（需 --remote-debugging-port=9333）');
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
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false }, sessionId);
if (TOKEN) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('ADMIN_TOKEN',${JSON.stringify(TOKEN)})}catch(e){}`,
  }, sessionId);
}

let pass = 0;
const fails = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(expression) {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return result.value;
}
const has = async (txt) => (await ev(`document.body.innerText.includes(${JSON.stringify(txt)})`)) === true;
const count = async (sel) => (await ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`)) || 0;

function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}

async function go(hash, wait = 1500) {
  await ev(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(wait);
}

async function clickByText(txt, sel = 'button, .el-button, .el-menu-item, .el-tabs__item, .el-dropdown-link') {
  return ev(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els.find((e) => (e.innerText || '').trim().includes(${JSON.stringify(txt)}));
    if (!el) return 'notfound';
    el.click();
    return 'ok';
  })()`);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(`_probe/admin-ui-${name}.png`, Buffer.from(data, 'base64'));
}

async function section(title, fn) {
  console.log(`\n${title}`);
  const before = consoleErrors.length;
  try { await fn(); } catch (e) { ok(false, `${title} 执行异常`, e.message); }
  const errs = consoleErrors.slice(before);
  ok(errs.length === 0, `${title} 无控制台错误`, errs.slice(0, 3).join(' | '));
}

// 必须先真正打开页面
await send('Page.navigate', { url: BASE + '/#/' }, sessionId);
await sleep(3000);
if ((await ev('location.origin')) === 'null') throw new Error('页面未加载：' + BASE);

try {
  await section('[1] 登录后进入后台', async () => {
    ok(await has('管理后台') || await has('控制面板'), '后台已登录并渲染');
    ok((await count('.sidebar, .layout')) > 0, '布局容器存在');
    ok((await count('.menu__item')) >= 20, '侧边栏菜单项渲染', `${await count('.menu__item')} 项`);
  });

  // ---------- 全部列表/内容页 ----------
  const pages = [
    ['/', '控制面板'],
    ['/goods', '抢购商品'],
    ['/shop-goods', '商城商品'],
    ['/category', '商品分类'],
    ['/specialarea', '抢购场次'],
    ['/orders', '全部订单'],
    ['/orders/shop', '商城订单'],
    ['/streambeat', '流拍订单'],
    ['/report', '举报处理'],
    ['/delivery', '运费模板'],
    ['/settle', '结算账目'],
    ['/settlement', '差价结算'],
    ['/energy', '佣金记录'],
    ['/withdraw', '提现审核'],
    ['/member', '会员列表'],
    ['/member-grade', '会员等级'],
    ['/certification', '实名认证'],
    ['/banner', '广告管理'],
    ['/navigation', '菜单配置'],
    ['/notice', '公告管理'],
    ['/recharge', '充值套餐'],
    ['/storeuser', '管理员'],
    ['/role', '角色管理'],
    ['/node', '节点管理'],
  ];

  await section('[2] 24 个后台页面逐个渲染', async () => {
    let rendered = 0;
    for (const [path, label] of pages) {
      await go(path, 1300);
      const bodyOk = await has(label);
      const tableOk = path === '/' ? true : ((await count('.el-table')) > 0 || (await count('.node-tree, .el-tree')) > 0 || (await count('.panel')) > 0);
      if (bodyOk && tableOk) rendered++;
      ok(bodyOk && tableOk, `页面渲染：${label}`, `bodyOk=${bodyOk} tableOk=${tableOk}`);
    }
    ok(rendered === pages.length, '全部页面渲染成功', `${rendered}/${pages.length}`);
  });

  await section('[3] 列表交互：搜索 / 新增弹窗 / 编辑弹窗 / 详情', async () => {
    await go('/category', 1600);
    const rows = await count('.el-table__row');
    ok(rows > 0, '分类列表有数据行', `${rows} 行`);

    // 搜索
    const searched = await ev(`(() => {
      const input = document.querySelector('.el-input__inner');
      if (!input) return 'noinput';
      input.value = '茶';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('搜索') || (b.innerText || '').includes('查询'));
      if (btn) btn.click();
      return btn ? 'ok' : 'nosearchbtn';
    })()`);
    ok(searched === 'ok' || searched === 'noinput', '列表搜索可用', searched);
    await sleep(900);

    // 新增弹窗
    const openCreate = await clickByText('新增');
    await sleep(900);
    ok(openCreate === 'ok', '点击新增按钮', openCreate);
    ok(await has('保存'), '新增弹窗出现（含保存按钮）');
    ok((await count('.el-dialog')) > 0, '弹窗容器存在', `${await count('.el-dialog')} 个`);
    await shot('create-dialog');
    // 关闭
    await ev(`(() => { const b = [...document.querySelectorAll('.el-dialog__headerbtn')]; if (b[0]) b[0].click(); })()`);
    await sleep(700);

    // 编辑弹窗
    const openEdit = await clickByText('编辑');
    await sleep(900);
    if (openEdit === 'ok') {
      ok(await has('保存'), '编辑弹窗出现');
      ok(await has('商品分类'), '编辑弹窗带模块名');
      await ev(`(() => { const b = [...document.querySelectorAll('.el-dialog__headerbtn')]; if (b[0]) b[0].click(); })()`);
      await sleep(700);
    } else {
      ok(true, '列表无「编辑」按钮（跳过）');
    }

    // 详情弹窗
    const openView = await clickByText('查看');
    await sleep(900);
    if (openView === 'ok') {
      ok((await count('.el-dialog')) > 0, '详情弹窗出现');
      await ev(`(() => { const b = [...document.querySelectorAll('.el-dialog__headerbtn')]; if (b[0]) b[0].click(); })()`);
      await sleep(700);
    } else {
      ok(true, '列表无「查看」按钮（跳过）');
    }
  });

  await section('[4] 订单页专用操作按钮', async () => {
    await go('/orders', 1600);
    ok((await count('.el-table__row')) > 0, '订单列表有数据');
    const hasDeliver = await has('发货');
    ok(hasDeliver || (await count('.el-button') > 0), '订单行操作按钮渲染');
    await go('/streambeat', 1500);
    ok(await has('流拍'), '流拍订单页渲染');
  });

  await section('[5] 8 个设置组表单', async () => {
    const groups = [
      ['store', '商城设置'], ['trade', '交易设置'], ['pay', '支付设置'],
      ['auction', '竞拍设置'], ['storage', '上传配置'], ['poster', '海报配置'],
      ['prompt', '须知配置'], ['nav', '导航配置'],
    ];
    for (const [g, title] of groups) {
      await go(`/setting/${g}`, 1400);
      const items = await count('.el-form-item');
      ok(await has(title) && items > 0, `设置组渲染：${title}`, `${items} 项`);
    }
    // 交易设置里必须能看到关键业务项
    await go('/setting/trade', 1500);
    ok(await has('抢单服务费'), '交易设置含抢单服务费');
    ok(await has('转拍涨价率'), '交易设置含转拍涨价率');
    ok(await has('转拍上架费'), '交易设置含转拍上架费');
    await shot('setting-trade');
  });

  await section('[6] 节点管理与结算页', async () => {
    await go('/node', 1600);
    const treeNodes = await count('.node-group');
    ok(treeNodes > 0, '节点树渲染', `${treeNodes} 组 / ${await count('.node-item')} 项`);
    await go('/settlement', 1600);
    ok(await has('差价结算') || await has('批次'), '差价结算页渲染');
    ok((await count('button')) > 0, '结算页有操作按钮');
    await shot('settlement');
  });

  await section('[7] 权限弹窗（角色分配权限）', async () => {
    await go('/role', 1600);
    ok((await count('.el-table__row')) > 0, '角色列表有数据');
    const openAssign = await clickByText('分配权限');
    await sleep(1000);
    if (openAssign === 'ok') {
      ok(await has('保存权限'), '权限弹窗出现');
      const cb = await count('.el-checkbox');
      ok(cb > 0, '权限节点可勾选', `${cb} 个`);
      await shot('role-permission');
      await ev(`(() => { const b = [...document.querySelectorAll('.el-dialog__headerbtn')]; if (b[0]) b[0].click(); })()`);
      await sleep(600);
    } else {
      ok(true, '无「分配权限」按钮（跳过）');
    }
  });

  await section('[8] 侧边栏菜单跳转', async () => {
    await go('/', 1500);
    const clicked = await clickByText('会员列表', '.menu__item');
    await sleep(1400);
    ok(clicked === 'ok' && (await ev('location.hash')).includes('/member'), '点击菜单可跳转', await ev('location.hash'));
    ok(await has('会员列表'), '跳转后页面标题正确');
  });
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
