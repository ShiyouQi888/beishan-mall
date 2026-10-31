/**
 * 商品详情页图片上传：后台「详情图片」+ 正文插图 + 前台渲染，整条链路验证。
 *
 * 断言链：
 *   1) 后台商品编辑弹窗里有「详情图片」表单项，且是满宽的多图上传位
 *   2) 选完文件直接上传（不强制裁剪，沿用上一版改法）
 *   3) 正文富文本的「插入图片」能把 <img> 插到光标位置
 *   4) 保存后 /admin/api/goods/detail 落库正确
 *   5) H5 接口 /api/goods/shopgoods/getDetails 返回 detail_images 数组
 *   6) 前台详情页真的把这些图渲染出来了
 *
 * 跑完把商品恢复原样（detail / detail_images 写回原值），不留测试数据。
 *
 * 用法: node scripts/probe/detail-images.mjs [goodsId=1]
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3300';
const WEB = 'http://127.0.0.1:5274';
const H5 = 'http://127.0.0.1:5273';
const GOODS_ID = Number(process.argv[2] || 1);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function pickSourceImage() {
  const dir = join(process.cwd(), 'server', 'data', 'uploads');
  if (!existsSync(dir)) throw new Error('找不到 server/data/uploads');
  const f = readdirSync(dir).find((x) => /\.(png|jpg|jpeg)$/i.test(x));
  if (!f) throw new Error('uploads 里没有可用图片');
  return join(dir, f);
}

async function call(path, { token, method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((x) => x.json());
  return r;
}

/** 素材库现有 file_id 集合，用于跑完清理本次新传的图 */
async function mediaIds(token) {
  const r = await call('/admin/api/media/list?page=1&limit=300', { token });
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

  // 先留个底，跑完原样写回
  const origin = await call(`/admin/api/goods/detail?id=${GOODS_ID}`, { token });
  if (origin.code !== 1) throw new Error('读取商品失败');
  console.log('目标商品：', origin.data.goods_name);

  const FILE = pickSourceImage();
  const mediaBefore = await mediaIds(token);
  const profile = mkdtempSync(join(tmpdir(), 'detail-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,1100', 'about:blank',
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description || ''));
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('ADMIN_TOKEN', ${JSON.stringify(token)})}catch(e){}`,
  });

  let targetId = GOODS_ID;
  let backup = { goods_id: GOODS_ID, detail: origin.data.detail || '', detail_images: origin.data.detail_images || '' };

  try {
    // ---------------- 后台 ----------------
    await send('Page.navigate', { url: `${WEB}/#/goods` });
    await sleep(4500);

    // 必须点中目标那一行：列表按 goods_id DESC 排，第一行是 id 最大的，不一定是目标。
    // 表格里的 ID 列可能被折叠，直接用商品名匹配最稳。
    const targetName = origin.data.goods_name;
    const opened = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.el-table__body-wrapper .el-table__row')];
      if (!rows.length) return { ok: false, why: 'no-rows' };
      const row = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(targetName)}));
      if (!row) return { ok: false, why: 'row-not-found', sample: rows.slice(0, 3).map((r) => r.innerText.slice(0, 24)) };
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '编辑');
      if (!btn) return { ok: false, why: 'no-edit-btn' };
      btn.click();
      return { ok: true };
    })()`);
    check('打开商品编辑弹窗', !!opened?.ok, JSON.stringify(opened));
    if (!opened?.ok) throw new Error('打不开编辑弹窗');
    await sleep(1500);

    // 「详情图片」表单项：应该有独立的多图上传位，且占满整行
    const detailField = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.el-form-item')];
      const el = items.find((i) => (i.querySelector('.el-form-item__label')?.textContent || '').includes('详情图片'));
      if (!el) return null;
      const up = el.querySelector('.image-uploader');
      return {
        hasUploader: !!up,
        wide: el.classList.contains('is-wide'),
        multi: !!el.querySelector('input[type=file]')?.multiple,
        tiles: el.querySelectorAll('.image-uploader__tile').length,
      };
    })()`);
    check('存在「详情图片」上传位', !!detailField?.hasUploader, JSON.stringify(detailField));
    check('详情图片占满整行且支持多图', !!detailField?.wide && !!detailField?.multi, JSON.stringify(detailField));

    // ---------------- 详情图片：选完直接上传 ----------------
    const { root } = await send('DOM.getDocument', { depth: -1 });
    const nodeIdsOfDetail = (await send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '.el-form-item.is-wide .image-uploader__input',
    })).nodeIds;
    // 详情图那行的 input（is-wide 只有 rich 与 detail_images 两处，取最后一个 = detail_images）
    const detailInput = nodeIdsOfDetail[nodeIdsOfDetail.length - 1];
    if (!detailInput) throw new Error('找不到详情图片的 file input');
    await send('DOM.setFileInputFiles', { files: [FILE], nodeId: detailInput });

    let tiles = detailField.tiles;
    for (let i = 0; i < 20; i += 1) {
      await sleep(400);
      const t = await evaluate(`(() => {
        const el = [...document.querySelectorAll('.el-form-item')].find((i) => (i.querySelector('.el-form-item__label')?.textContent || '').includes('详情图片'));
        return el ? el.querySelectorAll('.image-uploader__tile').length : 0;
      })()`);
      if (t > tiles) { tiles = t; break; }
    }
    check('详情图片选完即上传（不弹裁剪器）', tiles === detailField.tiles + 1 && !(await evaluate(`!!document.querySelector('.image-editor')`)), `缩略图 ${detailField.tiles} → ${tiles}`);

    // ---------------- 正文插图：插到光标位置 ----------------
    // 必须先点按钮（它才记住要往哪个字段插），点击会拉起系统文件框 —— headless 里要拦下来
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    const clicked = await evaluate(`(() => {
      const rich = [...document.querySelectorAll('.el-form-item')].find((i) => (i.querySelector('.el-form-item__label')?.textContent || '').includes('商品详情'));
      const ta = rich?.querySelector('textarea');
      const btn = rich?.querySelector('.rich-tools button');
      if (!ta || !btn) return { ok: false, why: 'no-textarea-or-button' };
      ta.focus();
      ta.setSelectionRange(0, 0);
      btn.click();
      return { ok: true, hasBtn: btn.textContent.includes('插入图片') };
    })()`);
    check('详情文本框旁有「插入图片」按钮', !!clicked?.ok && clicked.hasBtn === true, JSON.stringify(clicked));
    await sleep(500);

    const { nodeIds: richInputs } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.rich-file' });
    if (!richInputs?.length) throw new Error('找不到插图用的隐藏 input');
    await send('DOM.setFileInputFiles', { files: [FILE], nodeId: richInputs[0] });
    await sleep(2800);

    const afterInsert = await evaluate(`(() => {
      const rich = [...document.querySelectorAll('.el-form-item')].find((i) => (i.querySelector('.el-form-item__label')?.textContent || '').includes('商品详情'));
      const ta = rich?.querySelector('textarea');
      return { value: ta?.value || '', caret: ta?.selectionStart };
    })()`);
    check('插入的 <img> 落在光标处（开头）', /^<img src="\/uploads\/[^"]+"/.test(String(afterInsert.value)), String(afterInsert.value).slice(0, 60));
    check('插入后光标停在图片之后', Number(afterInsert.caret) > 0 && Number(afterInsert.caret) === String(afterInsert.value).indexOf('/>') + 2, `caret=${afterInsert.caret}`);

    // 留一张后台弹窗的截图，方便回看布局
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
        writeFileSync(join(process.cwd(), '_probe', 'detail-admin.png'), Buffer.from(shot.data, 'base64'));
        console.log('截图: _probe/detail-admin.png');
      }
    } catch {}

    // ---------------- 保存并核对落库 ----------------
    await evaluate(`(() => {
      const foot = document.querySelector('.el-dialog__footer');
      const btn = [...(foot ? foot.querySelectorAll('button') : [])].find((b) => /保存|确定/.test(b.textContent));
      if (btn) btn.click();
    })()`);
    await sleep(2500);

    const saved = await call(`/admin/api/goods/detail?id=${targetId}`, { token });
    const savedImages = (() => { try { return JSON.parse(saved.data.detail_images || '[]'); } catch { return []; } })();
    check('详情图片已落库', Array.isArray(savedImages) && savedImages.length >= 1, JSON.stringify(savedImages));
    check('正文里已写入 <img>', String(saved.data.detail || '').includes('<img src="/uploads/'), String(saved.data.detail).slice(0, 50));

    // ---------------- 前台接口与页面 ----------------
    const h5api = await call(`/api/goods/shopgoods/getDetails?goods_id=${targetId}`);
    check('H5 详情接口返回 detail_images', Array.isArray(h5api.data?.detail_images) && h5api.data.detail_images.length >= 1, JSON.stringify(h5api.data?.detail_images));

    await send('Page.navigate', { url: `${H5}/#/goods/${targetId}` });
    await sleep(4000);
    const h5dom = await evaluate(`(() => {
      const imgs = [...document.querySelectorAll('.detail__long img')];
      const rich = document.querySelector('.detail__rich');
      return {
        longCount: imgs.length,
        widths: imgs.map((i) => Math.round(i.getBoundingClientRect().width)),
        richHasImg: !!rich?.querySelector('img'),
        empty: !!document.querySelector('.detail__empty'),
      };
    })()`);
    check('前台详情页渲染详情长图', h5dom.longCount >= 1, `渲染 ${h5dom.longCount} 张，宽 ${JSON.stringify(h5dom.widths)}`);
    check('前台正文里的插图也渲染了', h5dom.richHasImg === true);
    check('有图时不再显示「暂无详情」', h5dom.empty === false);

    try {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(join(process.cwd(), '_probe'), { recursive: true });
      writeFileSync(join(process.cwd(), '_probe', 'detail-images.png'), Buffer.from(shot.data, 'base64'));
      console.log('截图: _probe/detail-images.png');
    } catch {}

    check('页面无 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    // 无论断言成败都把商品恢复原样
    const restored = await call('/admin/api/goods/save', { token, method: 'POST', body: backup });
    console.log(restored.code === 1 ? '已还原商品原详情' : `还原失败：${restored.msg}`);

    // 再清掉本次上传的素材，避免反复跑把文件堆起来
    try {
      const after = await mediaIds(token);
      const created = [...after].filter((x) => !mediaBefore.has(x));
      if (created.length) {
        await call('/admin/api/media/remove', { token, method: 'POST', body: { ids: created } });
        console.log(`已清理测试素材 ${created.length} 条`);
      }
    } catch {}

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
