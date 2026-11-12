/**
 * 会员服务电子合同签署存证验收
 *
 * 覆盖：
 *   1. 后台有「合同签名」开关，注册协议接口返回 sign_required 与合同版本指纹
 *   2. 老客户端不带任何签署字段仍可注册（30+ 探针/API 不受影响）
 *   3. 带姓名 + 手写 PNG + 版本注册成功，事务内落库，签名图真实落盘
 *   4. 拒绝：缺姓名、缺签名图、非法 base64、非 PNG、超大图、合同版本不一致
 *   5. 后台列表 / 详情 / 导出接口能查到签名图、快照与证据字段
 *   6. 合同正文改动后版本指纹变化，历史签署记录仍保留当时版本与正文
 *
 * 独立库（probe-contract-sign.db / 3493），跑完销毁。
 * 用法: node scripts/probe/contract-sign.mjs
 */
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { existsSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const SIGN_DIR = join(SERVER, 'data', 'uploads', 'sign');
const PORT = 3493;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'probe-contract-sign.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const removeDb = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    const p = join(SERVER, 'data', f);
    if (existsSync(p)) { try { unlinkSync(p); } catch {} }
  }
};
if (existsSync(SIGN_DIR)) { try { rmSync(SIGN_DIR, { recursive: true, force: true }); } catch {} }
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
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);

/** 生成一张真实合法的 16x16 PNG，用于模拟手写签名图 */
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng() {
  const w = 16, h = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      raw[row + 1 + x * 3] = x === y ? 30 : 255;
      raw[row + 2 + x * 3] = x === y ? 30 : 255;
      raw[row + 3 + x * 3] = x === y ? 30 : 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG_DATA_URL = `data:image/png;base64,${makePng().toString('base64')}`;

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
const reg = (body) => api('/api/member/registerAnAccount', { method: 'POST', body });

async function main() {
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

  const { get } = await import('../../server/src/db.js');
  try {
    section('[1] 配置与注册协议接口');
    const at = await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } });
    const token = at.data.token;
    ok(!!token, '后台登录');
    const setting = await api('/admin/api/setting/prompt', { token });
    const sw = (setting.data?.items || []).find((x) => x.k === 'contract_sign_required');
    ok(sw?.type === 'switch', '后台有「合同签名」开关');
    eq(get("SELECT `value` v FROM setting_config WHERE `key` = 'contract_sign_required'")?.v, '10', '默认开启');
    const agree = await api('/api/index/getRegisterAgreements');
    ok(agree.data.sign_required === true, '接口返回 sign_required=true');
    const v1 = agree.data.contract_version;
    ok(/^[0-9a-f]{16}$/.test(String(v1)), '返回 16 位合同版本指纹', String(v1));

    section('[2] 兼容：老客户端不带签署字段仍可注册');
    const legacy = await reg({ phone: '13972000001', password: 'probe123456', code: 'boss01' });
    eq(legacy.code, 1, '老注册路径成功');
    eq(get('SELECT COUNT(*) c FROM contract_signature')?.c, 0, '不产生签署记录');

    section('[3] 带签名注册：事务内落库 + 图片落盘');
    const signed = await reg({
      phone: '13972000002', password: 'probe123456', code: 'boss01', nickName: '签署会员',
      sign_real_name: '张三', sign_image: PNG_DATA_URL,
      sign_read_seconds: 18, contract_version: v1,
    });
    eq(signed.code, 1, '签署注册成功', signed.msg);
    const memberId = Number(signed.data?.member_id);
    const row = get('SELECT * FROM contract_signature WHERE member_id = ?', memberId);
    ok(!!row, 'contract_signature 有记录');
    eq(row?.real_name, '张三', '姓名已存');
    eq(row?.phone, '13972000002', '手机号已存');
    eq(row?.contract_version, v1, '合同版本已存');
    eq(row?.read_seconds, 18, '阅读秒数已存');
    ok(String(row?.contract_snapshot || '').includes('会员服务电子合同'), '保存了当时合同正文快照');
    ok(String(row?.contract_title || '').length > 0, '保存了合同名称');
    ok(String(row?.create_time || '').length > 0, '保存了签署时间');
    eq(get('SELECT COUNT(*) c FROM member WHERE mobile = ?', '13972000002')?.c, 1, '账号与签名同批写入');
    const disk = join(SERVER, 'data', (row?.sign_image || '').replace(/^\/uploads\//, 'uploads/').replace(/^uploads\//, 'uploads/'));
    ok(existsSync(disk), '签名 PNG 已落盘', disk);
    ok((await fetch(BASE + row.sign_image)).ok, '签名图可通过 /uploads 访问');

    section('[4] 拒绝非法签署数据');
    const base = { phone: '13972000003', password: 'probe123456', code: 'boss01', sign_image: PNG_DATA_URL, sign_real_name: '李四', contract_version: v1 };
    const noName = await reg({ ...base, sign_real_name: '' });
    ok(noName.code !== 1 && /姓名/.test(noName.msg || ''), '缺姓名被拒', noName.msg);
    const noImg = await reg({ ...base, sign_image: '' });
    ok(noImg.code !== 1 && /签名/.test(noImg.msg || ''), '缺签名图被拒', noImg.msg);
    const badB64 = await reg({ ...base, sign_image: 'data:image/png;base64,@@@@' });
    ok(badB64.code !== 1, '非法 base64 被拒', badB64.msg);
    const notPng = await reg({ ...base, sign_image: `data:image/png;base64,${Buffer.from('this is not a png file at all, just some text to pass length check').toString('base64')}` });
    ok(notPng.code !== 1 && /PNG/.test(notPng.msg || ''), '非 PNG 内容被拒', notPng.msg);
    const huge = await reg({ ...base, sign_image: `data:image/png;base64,${Buffer.alloc(160 * 1024, 7).toString('base64')}` });
    ok(huge.code !== 1, '超大签名图被拒', huge.msg);
    const stale = await reg({ ...base, contract_version: 'deadbeefdeadbeef' });
    ok(stale.code !== 1 && /合同内容已更新/.test(stale.msg || ''), '合同版本不一致被拒', stale.msg);
    eq(get('SELECT COUNT(*) c FROM member WHERE mobile = ?', '13972000003')?.c, 0, '被拒请求没有建账号');
    eq(get('SELECT COUNT(*) c FROM contract_signature')?.c, 1, '被拒请求没有写签名记录');

    section('[5] 后台查询、详情与导出');
    const list = await api('/admin/api/contract-sign/list?phone=13972000002', { token });
    eq(list.code, 1, '列表接口可读');
    eq(list.data?.total, 1, '按手机号查到 1 条');
    ok(!!list.data?.list?.[0]?.sign_image_url, '列表返回签名图 URL');
    const detail = await api(`/admin/api/contract-sign/detail?id=${row.sign_id}`, { token });
    eq(detail.code, 1, '详情接口可读');
    ok(String(detail.data?.contract_html || '').includes('会员服务电子合同'), '详情返回合同快照（已渲染）');
    ok(!!detail.data?.user_agent, '详情返回设备信息字段');
    const exp = await api('/admin/api/contract-sign/export?real_name=张三', { token });
    eq(exp.code, 1, '导出接口可读');
    eq(exp.data?.list?.length, 1, '导出按姓名过滤生效');
    const badDetail = await api('/admin/api/contract-sign/detail?id=99999', { token });
    ok(badDetail.code !== 1, '不存在的记录被拒');

    section('[6] 合同改版后版本指纹变化，历史快照不动');
    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { prompt_register: '# 会员服务电子合同 V2\n\n全新条款内容。' } },
    });
    const v2 = (await api('/api/index/getRegisterAgreements')).data.contract_version;
    ok(v2 !== v1, '合同改动后版本指纹变化', `${v1} -> ${v2}`);
    const old = get('SELECT * FROM contract_signature WHERE sign_id = ?', row.sign_id);
    eq(old.contract_version, v1, '历史记录仍指向旧版本');
    ok(String(old.contract_snapshot).includes('会员服务电子合同') && !old.contract_snapshot.includes('全新条款'), '历史快照不被改版覆盖');
    const signed2 = await reg({
      phone: '13972000004', password: 'probe123456', code: 'boss01',
      sign_real_name: '王五', sign_image: PNG_DATA_URL,
      sign_read_seconds: 20, contract_version: v2,
    });
    eq(signed2.code, 1, '新版本可正常签署');
    const row2 = get('SELECT * FROM contract_signature WHERE member_id = ?', signed2.data.member_id);
    eq(row2?.contract_version, v2, '新记录指向新版本');
    ok(String(row2?.contract_snapshot).includes('全新条款'), '新记录保存新正文');

    section('[7] 关闭签名开关');
    await api('/admin/api/setting/save', {
      method: 'POST', token,
      body: { group: 'prompt', values: { contract_sign_required: '20' } },
    });
    ok((await api('/api/index/getRegisterAgreements')).data.sign_required === false, '接口返回 sign_required=false');
    const stillWorks = await reg({ phone: '13972000005', password: 'probe123456', code: 'boss01' });
    eq(stillWorks.code, 1, '关闭后无签名注册成功');
    eq(get('SELECT COUNT(*) c FROM contract_signature')?.c, 2, '关闭后不新增签署记录（共 2 条有效签署）');
  } finally {
    try { srv.kill(); } catch {}
    if (existsSync(SIGN_DIR)) { try { rmSync(SIGN_DIR, { recursive: true, force: true }); } catch {} }
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
