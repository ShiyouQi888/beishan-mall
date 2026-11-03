/**
 * 提前抢购：会员资格 + 提前量，必须在「场次开始前 N 分钟」真的能下单。
 * 独立库（advance.db / 3480），跑完销毁。
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', '..', 'server');
const PORT = 3480;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'advance.db';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  const p = join(SERVER, 'data', f); if (existsSync(p)) unlinkSync(p);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };
const seed = () => new Promise((res, rej) => {
  const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d));
  p.on('close', (c) => (c === 0 ? res(o) : rej(new Error(o))));
});
const api = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
};

await seed();
const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }

const { db, get } = await import('../../server/src/db.js');


// 场次：从现在起 3 分钟后开始（提前量 5 分钟 → 现在就该能下单）
const now = new Date();
// 业务时区（北京）当天的秒数
const nowSec = Math.floor(((Math.floor(now.getTime() / 1000) + 8 * 3600) % 86400));
const start = nowSec + 180;
const end = start + 3600;
db.prepare('UPDATE specialarea SET start_time=?, end_time=?, is_open=10, open_days=?, buy_num=0 WHERE specialarea_id=1').run(start, end, '1,2,3,4,5,6,7');
console.log(`现在距场次开始 ${start - nowSec} 秒，场次 ${start}-${end}`);

const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
const reg = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: '13990000001', password: 'advance123', code: 'boss01', nickName: '提前抢' } });
const mid = Number(reg.data?.member_id);
const tk = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13990000001', password: 'advance123' } })).data.token;

// 开通 5 分钟提前量
const adv = await api('/admin/api/member/advance', { method: 'POST', token: at, body: { member_id: mid, enable: true, minutes: 5, count: 1 } });
console.log('开通提前抢购:', adv.code === 1 ? adv.msg : adv.msg);
console.log('库里:', JSON.stringify(get('SELECT is_advance, advance_seconds, advance_count FROM member WHERE member_id = ?', mid)));

const catId = get('SELECT category_id FROM goods_category LIMIT 1').category_id;
const cg = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_name: '提前抢样品', category_id: catId, goods_min_price: 500, stock_num: 1, goods_status: 10, goods_sort: 1 } });
const gid = Number(cg.data?.id);
db.prepare("UPDATE goods SET area_date='' WHERE goods_id=?").run(gid);
const link = await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid] } });
console.log('关联场次:', link.code === 1 ? 'ok' : link.msg);

// 列表层：有资格的人必须看到「可抢」，否则卡片是灰的，用户根本不会点进来
const loot = await api('/api/goods/getLootList', { token: tk });
const card = (loot.data?.list || []).flatMap((a) => a.goods_list || []).find((x) => Number(x.goods_id) === gid);
console.log('列表卡片 advance_open =', card?.advance_open, ' session_state =', card?.session_state);
const lootNo = await api('/api/goods/getLootList');
const cardNo = (lootNo.data?.list || []).flatMap((a) => a.goods_list || []).find((x) => Number(x.goods_id) === gid);
console.log('未登录同卡片 advance_open =', cardNo?.advance_open);

const detail = await api(`/api/goods/getLootDetails?goods_id=${gid}`, { token: tk });
console.log('详情 advance_open =', detail.data?.advance_open, ' advance_seconds =', detail.data?.advance_seconds,
  ' is_ordinary_order =', detail.data?.is_ordinary_order, ' session_state =', detail.data?.session_state);

const order = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: gid, num: 1 } });
console.log('下单结果:', order.code === 1 ? '成功' : '失败', order.msg);

// 对照：没资格的会员应该下不了
const reg2 = await api('/api/member/registerAnAccount', { method: 'POST', body: { phone: '13990000002', password: 'advance123', code: 'boss01', nickName: '没资格' } });
const tk2 = (await api('/api/member/accountLogin', { method: 'POST', body: { phone: '13990000002', password: 'advance123' } })).data.token;
const order2 = await api('/api/order/toAddOrder', { method: 'POST', token: tk2, body: { goods_id: gid, num: 1 } });
console.log('无资格会员下单:', order2.code === 1 ? '成功（不该成功！）' : '被拒', order2.msg);

// 次数：设了 1 次，用掉一次后就不该再提前
console.log('用完后 advance_count =', get('SELECT advance_count FROM member WHERE member_id = ?', mid).advance_count);
const cg2 = await api('/admin/api/goods/save', { method: 'POST', token: at, body: { goods_name: '提前抢样品2', category_id: catId, goods_min_price: 600, stock_num: 1, goods_status: 10, goods_sort: 2 } });
const gid2 = Number(cg2.data?.id);
db.prepare("UPDATE goods SET area_date='' WHERE goods_id=?").run(gid2);
await api('/admin/api/specialarea/goods/add', { method: 'POST', token: at, body: { specialarea_id: 1, goods_ids: [gid2] } });
const order3 = await api('/api/order/toAddOrder', { method: 'POST', token: tk, body: { goods_id: gid2, num: 1 } });
console.log('额度用完后同场再抢:', order3.code === 1 ? '成功（额度没生效！）' : '被拒', order3.msg);

srv.kill();
process.exit(0);
