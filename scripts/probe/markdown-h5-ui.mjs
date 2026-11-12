/**
 * Markdown 协议 · H5 排版验收（真实浏览器 DOM + 样式断言 + 截图）
 *
 * 覆盖：
 *   1. 后台保存一份 Markdown 合同（标题/列表/表格/引用/分隔线）
 *   2. H5 注册页点提交后，合同弹窗里渲染出对应 HTML 结构
 *   3. .rich-content 样式确实生效（标题字号、表格边框、引用左边框）
 *   4. 无横向溢出、无控制台错误
 *   5. 输出两张截图：弹窗顶部、滚动到底部
 *
 * 前置：public/ 已构建（npm run build），Chrome 以 --remote-debugging-port=9333 启动。
 * 独立库（probe-markdown-ui.db / 3489），跑完销毁。
 * 用法: node scripts/probe/markdown-h5-ui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const SHOT_DIR = join(ROOT, '.workbuddy', 'shots');
const PORT = 3489;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-markdown-ui.db';
const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`];
const removeDb = () => {
  for (const f of dbFiles) {
    const p = join(SERVER, 'data', f);
    if (!existsSync(p)) continue;
    try { unlinkSync(p); } catch {}
  }
};
removeDb();
process.env.MALL_DB = DB;
const env = {
  ...process.env, MALL_DB: DB, PORT: String(PORT),
  RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0', ORDER_EXPIRE_SCAN_MS: '0',
};
let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}

const seed = () => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
});
const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

const MD = [
  '# 会员服务电子合同',
  '',
  '甲方：**平台运营方**　乙方：注册会员（以下称「您」）',
  '',
  '## 第一条 合同的成立',
  '',
  '您点击「确认注册」并完成注册，即视为已完整阅读、理解并同意本合同全部条款。',
  '',
  '## 第二条 账号与信息',
  '',
  '- 您应保证注册信息真实、准确',
  '- 账号仅限本人使用，不得出租、出借或转让',
  '- 请妥善保管登录密码，因保管不当造成的损失由您自行承担',
  '',
  '> 请完整阅读以上条款后再确认注册，阅读过程中可随时返回上一步。',
  '',
  '| 项目 | 说明 |',
  '| --- | --- |',
  '| 服务范围 | 商品展示、交易撮合、结算与售后 |',
  '| 费率口径 | 以页面实时公示为准 |',
  '| 结算周期 | T+1 |',
  '',
  '---',
  '',
  '## 第三条 权利义务',
  '',
  '1. 平台按公示规则提供服务，并保障交易数据安全',
  '2. 您承诺不进行虚假交易、恶意刷单、套取佣金等违规行为',
  '3. 违规时平台有权限制账号功能并追究相应责任',
  '',
  '## 第四条 争议解决',
  '',
  '因本合同产生的争议，双方应友好协商解决；协商不成的，提交平台所在地有管辖权的人民法院处理。',
  '',
  '[查看平台规则](https://example.com/rule)',
].join('\n');

async function main() {
  if (!existsSync(join(ROOT, 'public', 'h5', 'index.html'))) throw new Error('public/h5 未构建');
  mkdirSync(SHOT_DIR, { recursive: true });
  await seed();

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += String(d)));
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) { try { srv.kill(); } catch {} throw new Error('服务启动超时：\n' + log.slice(-600)); }

  try {
    section('[1] 后台保存 Markdown 合同');
    const at = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } });
    const token = at.data.token;
    const saved = await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { prompt_register: MD, contract_read_seconds: '0' } },
    });
    ok(saved.code === 1, '后台保存成功', saved.msg);
    const agreement = await api('/api/index/getRegisterAgreements');
    ok(String(agreement.data.user).includes('<h1>会员服务电子合同</h1>'), '接口返回排版后的 h1');
    ok(String(agreement.data.user).includes('<table>'), '接口返回表格');

    const wsUrl = await (async () => {
      for (let i = 0; i < 40; i++) {
        try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
        catch { await sleep(300); }
      }
      throw new Error(`Chrome 调试端口 ${CDP_PORT} 未就绪`);
    })();
    const ws = new WebSocket(wsUrl);
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
        consoleErrors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
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
    const ev = async (expression) => {
      const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      return result.value;
    };
    const waitFor = async (expression, timeout = 10000, step = 200) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await ev(expression)) return true; await sleep(step); }
      return false;
    };
    const shot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const { writeFileSync } = await import('node:fs');
      const p = join(SHOT_DIR, name);
      writeFileSync(p, Buffer.from(data, 'base64'));
      console.log('  截图:', p);
    };

    section('[2] H5 合同弹窗的 DOM 结构');
    await send('Page.navigate', { url: `${BASE}/register` }, sessionId);
    await sleep(2800);
    ok(await waitFor("!!document.querySelector('.reg__submit')", 8000), '注册页已渲染');
    await ev(`(() => {
      const ins = document.querySelectorAll('.reg__field input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(ins[0], '13971000011'); set(ins[1], '排版验收'); set(ins[2], 'probe123456'); set(ins[3], 'boss01');
      document.querySelector('.reg__submit').click();
    })()`);
    ok(await waitFor("(() => { const e = document.querySelector('.reg__doc'); return !!e && e.getBoundingClientRect().height > 100; })()", 6000), '合同弹窗出现');
    const dom = await ev(`(() => {
      const c = document.querySelector('.reg__doc-content');
      const q = (s) => c.querySelectorAll(s).length;
      return {
        rich: c.classList.contains('rich-content'),
        h1: c.querySelector('h1')?.textContent.trim() || '',
        h2: q('h2'), ul: q('ul'), ol: q('ol'), li: q('li'),
        table: q('table'), th: q('th'), td: q('td'),
        quote: q('blockquote'), hr: q('hr'), strong: q('strong'), link: q('a'),
        rawMd: (c.textContent || '').includes('## 第一条'),
      };
    })()`);
    ok(dom.rich === true, '容器带 rich-content 排版类');
    ok(dom.h1 === '会员服务电子合同', 'h1 标题正确', dom.h1);
    ok(dom.h2 >= 4, '多级标题渲染', String(dom.h2));
    ok(dom.ul >= 1 && dom.ol >= 1 && dom.li >= 6, '有序/无序列表渲染', JSON.stringify(dom));
    ok(dom.table === 1 && dom.th === 2 && dom.td === 6, '表格渲染', JSON.stringify(dom));
    ok(dom.quote === 1 && dom.hr === 1, '引用与分隔线渲染', JSON.stringify(dom));
    ok(dom.strong >= 1 && dom.link === 1, '粗体与链接渲染', JSON.stringify(dom));
    ok(dom.rawMd === false, '页面上不再出现原始 ## 标记');

    section('[3] 排版样式生效');
    const styles = await ev(`(() => {
      const c = document.querySelector('.reg__doc-content');
      const base = parseFloat(getComputedStyle(c).fontSize);
      const h1 = c.querySelector('h1');
      const h2 = c.querySelector('h2');
      const th = c.querySelector('th');
      const bq = c.querySelector('blockquote');
      const img = c.querySelector('img');
      const cs = getComputedStyle(h1);
      return {
        base,
        h1Size: parseFloat(cs.fontSize),
        h1Weight: parseInt(cs.fontWeight, 10),
        h1Margin: parseFloat(getComputedStyle(h2).marginTop),
        thBorder: getComputedStyle(th).borderTopWidth,
        thBg: getComputedStyle(th).backgroundColor,
        quoteBorder: getComputedStyle(bq).borderLeftWidth,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        hasImg: !!img,
      };
    })()`);
    ok(styles.h1Size > styles.base + 4, '一级标题字号明显大于正文', JSON.stringify(styles));
    ok(styles.h1Weight >= 700, '标题字重加粗', String(styles.h1Weight));
    ok(styles.h1Margin > 0, '标题有段间距', String(styles.h1Margin));
    ok(parseFloat(styles.thBorder) > 0, '表格有边框', styles.thBorder);
    ok(styles.quoteBorder !== '0px', '引用有左侧色条', styles.quoteBorder);
    ok(styles.overflowX <= 1, '无横向溢出', String(styles.overflowX));
    await sleep(450); // 等弹窗进场动画结束再截图
    await shot('md-contract-top.png');

    section('[4] 滚动到底部');
    await ev(`(() => { const b = document.querySelector('.reg__doc-body'); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); })()`);
    await sleep(400);
    ok(await ev("document.querySelector('.reg__doc-tip')?.textContent.includes('已阅读至底部')"), '长合同可滚动到底并解锁提示');
    await shot('md-contract-bottom.png');

    section('[5] 控制台');
    ok(consoleErrors.length === 0, '无控制台错误', consoleErrors.slice(0, 2).join(' | '));
    try { ws.close(); } catch {}
  } finally {
    try { srv.kill(); } catch {}
  }
}

main()
  .then(() => {
    console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
      for (const f of fails) console.log('  ✗ ' + f);
      process.exitCode = 1;
    }
    removeDb();
  })
  .catch((e) => {
    console.error('\n探针异常：', e?.message || e);
    removeDb();
    process.exitCode = 1;
  });
