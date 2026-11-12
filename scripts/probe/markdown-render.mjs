/**
 * Markdown 协议渲染验收
 *
 * 覆盖：
 *   1. renderRich 语法：标题/段落/列表(含嵌套)/表格/引用/代码块/链接/图片/分隔线/粗斜体
 *   2. 安全：原文 HTML、javascript: 链接、data: 图片都被转义或降级，输出无可执行标签
 *   3. 幂等、空值、CRLF、已有 HTML 直通
 *   4. 后台把协议改成 Markdown 后，5 个前台接口都返回排版好的 HTML
 *   5. 后台设置项类型是 markdown（编辑器才会给粘贴 + 预览）
 *   6. 老数据仍是 HTML 时原样返回，不被二次转换
 *   7. 公告表里的 Markdown 正文同样被渲染
 *
 * 独立库（probe-markdown.db / 3487），跑完销毁。
 * 用法: node scripts/probe/markdown-render.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3487;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-markdown.db';
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
  '甲方：**平台运营方**　乙方：注册会员（*以下简称您*）',
  '',
  '## 第一条 账号',
  '',
  '- 账号仅限本人使用',
  '- 不得出租、出借或转让',
  '  1. 子项一',
  '  2. 子项二',
  '',
  '> 请完整阅读后再确认注册。',
  '',
  '| 项目 | 说明 |',
  '| --- | --- |',
  '| 服务费 | 按页面公示 |',
  '| 结算 | T+1 |',
  '',
  '---',
  '',
  '[查看规则](https://example.com/rule) ![示意图](https://example.com/a.png)',
  '',
  '```',
  'const amount = 100;',
  '```',
].join('\n');

async function main() {
  const { renderRich } = await import('../../shared/markdown.js');

  section('[1] Markdown 语法渲染');
  const html = renderRich(MD);
  ok(html.includes('<h1>会员服务电子合同</h1>'), '一级标题');
  ok(html.includes('<h2>第一条 账号</h2>'), '二级标题');
  ok(html.includes('<strong>平台运营方</strong>'), '粗体');
  ok(html.includes('<em>以下简称您</em>'), '斜体');
  ok(html.includes('<ul><li>账号仅限本人使用</li>'), '无序列表同级不误嵌套');
  ok(/<li>不得出租[^<]*<ol><li>子项一<\/li><li>子项二<\/li><\/ol><\/li>/.test(html), '有序子列表嵌在 li 内');
  ok(html.includes('<blockquote><p>请完整阅读后再确认注册。</p></blockquote>'), '引用');
  ok(html.includes('<table><thead><tr><th>项目</th><th>说明</th>'), '表格表头');
  ok(html.includes('<td>结算</td>'), '表格数据行');
  ok(html.includes('<hr />'), '分隔线');
  ok(html.includes('href="https://example.com/rule"'), '链接');
  ok(html.includes('<img src="https://example.com/a.png"'), '图片');
  ok(html.includes('<pre><code>const amount = 100;</code></pre>'), '代码块');
  ok(renderRich('第一行\n第二行').includes('<br />'), '段落内软换行');

  section('[2] 安全');
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '[点我](javascript:alert(1))',
    '![图](data:text/html;base64,PHNjcmlwdD4=)',
    '[外链](https://a.com "onmouseover=alert(1)")',
  ].join('\n\n');
  const evilHtml = renderRich(evil);
  ok(!evilHtml.includes('<script>'), '原文 script 被转义');
  ok(!/<img\s+src=x\s+onerror/i.test(evilHtml), '原文 onerror 属性不保留');
  ok(!evilHtml.includes('href="javascript'), 'javascript: 链接降级为文本');
  ok(!evilHtml.includes('src="data:text/html'), 'data:text/html 图片被拒绝');
  ok(!evilHtml.includes('危险)'), '危险链接不留残括号');
  ok((evilHtml.match(/<(?!\/?(?:p|br|strong|em|s|code|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|pre|hr|a|img|div|span|b|i|u)\b)[a-z]/g) || []).length === 0,
    '输出只含白名单标签');

  section('[3] 兼容与幂等');
  const legacy = '<p>已有 <b>HTML</b> 内容</p>';
  ok(renderRich(legacy) === legacy, '已有 HTML 原样返回');
  ok(renderRich(html) === html, 'renderRich 幂等');
  ok(renderRich('') === '' && renderRich(null) === '' && renderRich(undefined) === '', '空值');
  ok(renderRich('第一行\r\n第二行').includes('<br />'), 'CRLF 换行');

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

  const { db, run } = await import('../../server/src/db.js');
  try {
    section('[4] 后台配置与前台接口');
    const at = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } });
    const token = at.data.token;
    ok(!!token, '后台登录');
    const items = (await api('/admin/api/setting/prompt', { token })).data.items || [];
    const byKey = Object.fromEntries(items.map((i) => [i.k, i]));
    for (const k of ['prompt_register', 'prompt_privacy', 'prompt_invite', 'prompt_shop', 'prompt_trade', 'prompt_loot', 'prompt_consign']) {
      ok(byKey[k]?.type === 'markdown', `${k} 是 markdown 编辑控件`);
    }

    const saved = await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: {
        group: 'prompt',
        values: {
          prompt_register: MD,
          prompt_privacy: '## 隐私政策\n\n- 仅收集必要信息\n- 不向第三方出售',
          prompt_invite: '# 邀请须知\n\n**好友**完成交易后可获得佣金',
          prompt_shop: '| 项目 | 说明 |\n| --- | --- |\n| 售后 | 7 天 |',
          prompt_trade: '> 交易规则\n\n一经售出，非质量问题不予退换',
        },
      },
    });
    ok(saved.code === 1, '后台保存 Markdown 成功', saved.msg);

    const reg = await api('/api/index/getRegisterAgreements');
    ok(String(reg.data.user).includes('<h1>会员服务电子合同</h1>'), '注册合同接口返回 h1');
    ok(String(reg.data.user).includes('<table>'), '注册合同接口返回表格');
    ok(String(reg.data.privacy).includes('<h2>隐私政策</h2>'), '隐私政策接口返回 h2');
    ok(String(reg.data.privacy).includes('<ul>'), '隐私政策接口返回列表');
    const invite = await api('/api/index/getInvitationNotice');
    ok(String(invite.data.prompt_values).includes('<strong>好友</strong>'), '邀请须知接口返回粗体');
    const after = await api('/api/index/getGroupAfterSalesAgreement');
    ok(String(after.data.shop_agreement).includes('<table>'), '商城协议接口返回表格');
    ok(String(after.data.transaction_agreement).includes('<blockquote>'), '交易协议接口返回引用');
    const memberNotice = await api('/api/member/getNotice');
    ok(String(memberNotice.data.content).includes('<h1>'), '会员须知接口返回 h1');

    section('[5] 老 HTML 数据直通');
    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { prompt_register: legacy } },
    });
    ok((await api('/api/index/getRegisterAgreements')).data.user === legacy, 'HTML 老内容原样返回');

    section('[6] 公告正文');
    run("INSERT INTO notice (title, content, sort, create_time) VALUES (?, ?, ?, ?)", 'Markdown 公告', '# 公告标题\n\n- 第一条\n- 第二条', 1, '2026-11-12 10:00:00');
    const notices = await api('/api/notice/getNotice');
    const n = (notices.data || []).find((x) => x.title === 'Markdown 公告');
    ok(!!n, '公告可读');
    ok(String(n?.content || '').includes('<h1>公告标题</h1>'), '公告正文 Markdown 已渲染');
    ok(String(n?.content || '').includes('<ul>'), '公告正文列表已渲染');

    section('[7] 接口层 XSS');
    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { prompt_register: '正常条款\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(1))' } },
    });
    const xss = (await api('/api/index/getRegisterAgreements')).data.user;
    ok(!String(xss).includes('<script>'), '接口输出无 script 标签');
    ok(String(xss).includes('&lt;script&gt;'), '原文脚本被转义成文本');
    ok(!String(xss).includes('href="javascript'), '接口输出无 javascript: 链接');
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
