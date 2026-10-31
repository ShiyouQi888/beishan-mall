/**
 * 后台图片上传：验证「选完文件不再强制裁剪」。
 *
 * 断言链（对应需求：从文件选择不要强制裁剪）：
 *   1) 只把文件塞进 file input，不点任何按钮 —— 裁剪器不应弹出来
 *   2) 缩略图直接 +1，说明原图已经上传成功
 *   3) 缩略图上出现「裁剪」按钮，点它才进裁剪器（裁剪变成可选）
 *   4) 关掉裁剪器后缩略图数量不变（取消不会误删）
 *
 * 用 CDP 的 DOM.setFileInputFiles 直接给隐藏 input 赋值，它会像用户选择一样
 * 触发 input/change 事件，这样才是在验证真实链路，而不是绕过组件。
 *
 * 上传会往素材库落一条记录，跑完按 file_id 差集删掉，避免污染数据。
 *
 * 用法: node scripts/probe/img-nocrop.mjs [服务地址=5274]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = process.argv[2] || 'http://127.0.0.1:5274';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function pickSourceImage() {
  const dir = join(process.cwd(), 'server', 'data', 'uploads');
  if (!existsSync(dir)) throw new Error('找不到 server/data/uploads，先跑一次种子数据');
  const png = readdirSync(dir).find((f) => /\.(png|jpg|jpeg)$/i.test(f));
  if (!png) throw new Error('uploads 目录里没有可用图片');
  return join(dir, png);
}

async function mediaIds(token) {
  const r = await fetch(`${API}/admin/api/media/list?page=1&limit=200`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((x) => x.json());
  return new Set((r.data?.list || []).map((f) => Number(f.file_id)));
}

async function main() {
  const login = await fetch(`${API}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: 'admin1', password: '123456' }),
  }).then((r) => r.json());
  if (login.code !== 1) throw new Error('后台登录失败：' + login.msg);
  const token = login.data.token;

  const before = await mediaIds(token);
  const FILE = pickSourceImage();

  const profile = mkdtempSync(join(tmpdir(), 'nocrop-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1100',
    'about:blank',
  ]);

  await sleep(2200);
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('没有可用的 page target');

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
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
  });

  await send('Page.navigate', { url: `${WEB}/goods` });
  await sleep(4500);

  // 超大图必须走「等比缩小」分支：尺寸变小、比例不变、内容不被切掉
  const sharedPath = join(process.cwd(), 'shared', 'imagePrepare.js').replace(/\\/g, '/');
  const shrink = await evaluate(`(async () => {
    const mod = await import('/@fs/${sharedPath}');
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 2000;
    const x = c.getContext('2d');
    x.fillStyle = '#cc3322'; x.fillRect(0, 0, 3000, 2000);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'big.png', { type: 'image/png' });
    const out = await mod.prepareImage(file);
    const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = URL.createObjectURL(out); });
    return { inSize: file.size, outSize: out.size, w: img.naturalWidth, h: img.naturalHeight, type: out.type, name: out.name };
  })()`);
  check(
    '超大图只等比压缩、不改比例',
    !!shrink && Math.max(shrink.w, shrink.h) === 2560 && Math.abs(shrink.w / shrink.h - 1.5) < 0.01,
    JSON.stringify(shrink),
  );
  check('压缩后体积变小', !!shrink && shrink.outSize < shrink.inSize, shrink ? `${shrink.inSize} → ${shrink.outSize}` : '');

  // 小图应原样直传，不做无谓重编码
  const passthrough = await evaluate(`(async () => {
    const mod = await import('/@fs/${sharedPath}');
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    c.getContext('2d').fillRect(0, 0, 320, 240);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'small.png', { type: 'image/png' });
    const out = await mod.prepareImage(file);
    return { same: out === file, type: out.type, name: out.name };
  })()`);
  check('小图原样直传（不重编码）', !!passthrough && passthrough.same === true, JSON.stringify(passthrough));

  // 打开第一行商品的编辑弹窗
  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.el-table__row button')].find((b) => b.textContent.trim() === '编辑');
    if (!btn) return 'no-row';
    btn.click();
    return 'ok';
  })()`);
  check('商品列表页打开编辑弹窗', opened === 'ok', String(opened));
  if (opened !== 'ok') throw new Error('没有可编辑的商品，无法继续');
  await sleep(1500);

  const hasUploader = await evaluate(`!!document.querySelector('.image-uploader__input')`);
  check('弹窗内存在图片上传组件', hasUploader === true);

  // 来源面板文案：应明确告知「不强制裁剪」
  const addClicked = await evaluate(`(() => {
    const b = document.querySelector('.image-uploader__add');
    if (!b) return 'no-add';
    b.click();
    return 'ok';
  })()`);
  await sleep(600);
  const panelText = await evaluate(`(() => {
    const p = document.querySelector('.image-uploader__source-panel');
    return p ? p.innerText.replace(/\\s+/g, ' ') : '';
  })()`);
  check('来源面板可正常打开', addClicked === 'ok' && !!panelText, String(addClicked));
  check('来源面板文案已去掉「先裁剪」的说法', !panelText.includes('先裁剪') && panelText.includes('不强制裁剪'), panelText.slice(0, 80));
  await evaluate(`(() => { const b = document.querySelector('.image-uploader__source-close'); if (b) b.click(); })()`);
  await sleep(400);

  // 找出弹窗里所有上传组件的形态：单图字段是替换、多图字段是追加，断言要分开
  const fields = await evaluate(`(() => {
    return [...document.querySelectorAll('.image-uploader')].map((el, i) => ({
      i,
      multiple: !!el.querySelector('input[type=file]')?.multiple,
      tiles: el.querySelectorAll('.image-uploader__tile').length,
      srcs: [...el.querySelectorAll('.image-uploader__tile img')].map((t) => t.getAttribute('src')),
    }));
  })()`);
  const multiIdx = fields.findIndex((f) => f.multiple);
  const singleIdx = fields.findIndex((f) => !f.multiple);
  check('弹窗内同时存在单图与多图字段', multiIdx >= 0 && singleIdx >= 0, JSON.stringify(fields.map((f) => ({ i: f.i, m: f.multiple, t: f.tiles }))));

  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.image-uploader__input' });
  if (!nodeIds?.length) throw new Error('找不到 file input 节点');

  const fieldState = (i) => evaluate(`(() => {
    const el = document.querySelectorAll('.image-uploader')[${i}];
    if (!el) return null;
    return {
      tiles: el.querySelectorAll('.image-uploader__tile').length,
      last: el.querySelector('.image-uploader__tile:last-of-type img')?.getAttribute('src') || '',
      srcs: [...el.querySelectorAll('.image-uploader__tile img')].map((t) => t.getAttribute('src')),
    };
  })()`);

  // 关键动作：只塞文件，不做任何确认 —— 多图字段应直接追加一张
  const multiBefore = await fieldState(multiIdx);
  await send('DOM.setFileInputFiles', { files: [FILE], nodeId: nodeIds[multiIdx] });
  let multiAfter = multiBefore;
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    multiAfter = await fieldState(multiIdx);
    if (multiAfter && multiAfter.tiles > multiBefore.tiles) break;
  }
  check('选完文件没有强制弹出裁剪器', (await evaluate(`!!document.querySelector('.image-editor')`)) === false);
  check('多图字段缩略图直接 +1（原图已上传）', multiAfter.tiles === multiBefore.tiles + 1, `${multiBefore.tiles} → ${multiAfter.tiles}`);
  check('新缩略图指向刚上传的图片', String(multiAfter.last).includes('/uploads/') && !multiBefore.srcs.includes(multiAfter.last), String(multiAfter.last).slice(-42));

  // 单图字段（商品缩略图）走的是替换，数量不变但地址要变
  const singleBefore = await fieldState(singleIdx);
  await send('DOM.setFileInputFiles', { files: [FILE], nodeId: nodeIds[singleIdx] });
  let singleAfter = singleBefore;
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    singleAfter = await fieldState(singleIdx);
    if (singleAfter && singleAfter.srcs[0] !== singleBefore.srcs[0]) break;
  }
  check('单图字段上传后原地替换（数量不变）', singleAfter.tiles === singleBefore.tiles && singleAfter.srcs[0] !== singleBefore.srcs[0], `${singleBefore.srcs[0]} → ${singleAfter.srcs[0]}`);

  // 裁剪变成可选入口
  const cropBtns = await evaluate(`document.querySelectorAll('.image-uploader__crop').length`);
  const allTiles = await evaluate(`document.querySelectorAll('.image-uploader__tile').length`);
  check('缩略图上出现「裁剪」按钮', cropBtns === allTiles, `${cropBtns} 个 / ${allTiles} 张`);
  await evaluate(`(() => { const b = document.querySelector('.image-uploader__crop'); if (b) b.click(); })()`);
  await sleep(1200);
  const editorByChoice = await evaluate(`(() => {
    const el = document.querySelector('.image-editor');
    if (!el) return null;
    const preset = el.querySelector('.image-editor__preset-row');
    return { title: el.querySelector('h2')?.textContent?.trim() || '', hasPreset: !!preset };
  })()`);
  check('点「裁剪」才进裁剪器（可选）', !!editorByChoice, JSON.stringify(editorByChoice));
  await evaluate(`(() => { const b = document.querySelector('.image-editor__cancel'); if (b) b.click(); })()`);
  await sleep(700);
  const tilesAfterCancel = await evaluate(`document.querySelectorAll('.image-uploader__tile').length`);
  check('取消裁剪后缩略图数量不变', tilesAfterCancel === allTiles, `${allTiles} → ${tilesAfterCancel}`);

  check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  // 留一张可回看的截图（放 _probe/，已被 .gitignore 忽略）
  try {
    const box = await evaluate(`(() => {
      const el = document.querySelector('.el-dialog');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()`);
    if (box) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, scale: 1 } });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'img-nocrop.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/img-nocrop.png');
    }
  } catch {}

  // 清理：删掉本次新增的素材记录
  const after = await mediaIds(token);
  const created = [...after].filter((x) => !before.has(x));
  if (created.length) {
    await fetch(`${API}/admin/api/media/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: created }),
    });
    console.log(`已清理测试素材 ${created.length} 条`);
  }

  ws.close();
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('探针失败：', e.message);
  process.exit(1);
});
