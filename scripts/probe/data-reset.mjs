// 数据清除：预览 / 确认语 / 权限 / 事务性 / 序列归零
// 独立库（data-reset.db / 3407），不碰演示库
// 用法: node scripts/probe/data-reset.mjs
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const BACKUP_DIR = join(SERVER, 'data', 'backup');
const PORT = 3407;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'data-reset.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const eq = (a, b, name) => ok(String(a) === String(b), name, `期望 ${b}，实际 ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT) };

function runSeed() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
}

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await runSeed();
  const { db } = await import('../../server/src/db.js');

  const srv = spawn(process.execPath, ['src/app.js'], { cwd: SERVER, env, stdio: 'pipe' });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => {
    log += String(d);
    if (!String(d).includes('ExperimentalWarning') && !String(d).includes('trace-warnings')) process.stderr.write(d);
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('服务启动超时：\n' + log.slice(-600));

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '超管登录');

    const before = {
      member: db.prepare('SELECT COUNT(*) c FROM member').get().c,
      orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
      energy: db.prepare('SELECT COUNT(*) c FROM finance_energy').get().c,
      goods: db.prepare('SELECT COUNT(*) c FROM goods').get().c,
      cat: db.prepare('SELECT COUNT(*) c FROM goods_category').get().c,
      area: db.prepare('SELECT COUNT(*) c FROM specialarea').get().c,
      user: db.prepare('SELECT COUNT(*) c FROM store_user').get().c,
      cfg: db.prepare('SELECT COUNT(*) c FROM setting_config').get().c,
    };
    console.log(`  初始：会员 ${before.member} / 订单 ${before.orders} / 流水 ${before.energy} / 商品 ${before.goods}`);

    // ---------- 权限 ----------
    section('[1] 权限：默认只有超管能用，可下放');
    const opCreate = await api('/admin/api/storeuser/save', {
      method: 'POST', token: at,
      body: { user_name: 'reset_op', password: '123456', nick_name: '运营小张', role_id: 7, status: 10 },
    });
    ok(opCreate.code === 1 && !!opCreate.data?.id, '新建一个「运营」角色账号', opCreate.msg);
    const opToken = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'reset_op', password: '123456' } })).data?.token;
    ok(!!opToken, '运营账号可登录');

    const opPlan = await api('/admin/api/system/reset/plan', { token: opToken });
    ok(opPlan.code !== 1, '运营角色读不到清除预览', `code=${opPlan.code}`);
    const opReset = await api('/admin/api/system/reset', {
      method: 'POST', token: opToken, body: { scopes: ['trade'], confirm: '我已知晓风险并确认清除' },
    });
    ok(opReset.code !== 1, '运营角色不能执行清除', `code=${opReset.code}`);

    // 下放权限：把「数据清除」节点授给运营角色
    const tree = await api('/admin/api/node/tree', { token: at });
    const settingGroup = (tree.data?.tree || []).find((g) => g.name === '系统设置');
    const dangerNode = (settingGroup?.children || []).find((c) => c.path === '/setting/danger');
    ok(!!dangerNode, '权限树里有「数据清除」节点', JSON.stringify(settingGroup?.children?.map((c) => c.path) || []).slice(0, 80));
    const grant = await api('/admin/api/role/nodes', {
      method: 'POST', token: at, body: { role_id: 7, node_ids: [dangerNode.id] },
    });
    ok(grant.code === 1, '把节点授权给运营角色', grant.msg);
    const opPlan2 = await api('/admin/api/system/reset/plan', { token: opToken });
    ok(opPlan2.code === 1, '授权后运营可读预览', opPlan2.msg);
    // 收回，后续都用超管
    await api('/admin/api/role/nodes', { method: 'POST', token: at, body: { role_id: 7, node_ids: [] } });

    // ---------- 预览 ----------
    section('[2] 预览：行数要与库里一致');
    const plan = await api('/admin/api/system/reset/plan?scopes=trade,member,goods,media', { token: at });
    ok(plan.code === 1, '预览可读', plan.msg);
    eq(plan.data.summary.orders, before.orders, '预览里的订单数 = 实际');
    eq(plan.data.summary.member, before.member, '预览里的会员数 = 实际');
    const tradeRows = (plan.data.detail.trade || []).reduce((s, x) => s + x.rows, 0);
    eq(tradeRows, db.prepare("SELECT COUNT(*) c FROM orders").get().c + db.prepare('SELECT COUNT(*) c FROM finance_energy').get().c,
      '交易范围行数含订单与流水');
    ok(plan.data.total > 0, '合计行数 > 0', String(plan.data.total));
    ok(plan.data.confirm_text === '我已知晓风险并确认清除', '下发了确认文字', plan.data.confirm_text);

    // ---------- 校验 ----------
    section('[3] 执行前校验');
    const badConfirm = await api('/admin/api/system/reset', { method: 'POST', token: at, body: { scopes: ['trade'], confirm: '随便写' } });
    ok(badConfirm.code === 0 && /确认文字/.test(badConfirm.msg), '确认文字不对被拒', badConfirm.msg);
    const emptyScope = await api('/admin/api/system/reset', { method: 'POST', token: at, body: { scopes: [], confirm: '我已知晓风险并确认清除' } });
    ok(emptyScope.code === 0, '没选范围被拒', emptyScope.msg);
    const memberOnly = await api('/admin/api/system/reset', { method: 'POST', token: at, body: { scopes: ['member'], confirm: '我已知晓风险并确认清除' } });
    ok(memberOnly.code === 0 && /孤儿/.test(memberOnly.msg), '只清会员被拒（会留孤儿订单）', memberOnly.msg);
    eq(db.prepare('SELECT COUNT(*) c FROM orders').get().c, before.orders, '被拒后订单数没变（无副作用）');

    const userBeforeReset = db.prepare('SELECT COUNT(*) c FROM store_user').get().c;
    const backupsBefore = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((f) => f.startsWith('before-reset-')).length : 0;

    // ---------- 执行 ----------
    section('[4] 执行清除（交易 + 会员 + 商品复位）');
    const done = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['trade', 'member', 'goods'], confirm: '我已知晓风险并确认清除' },
    });
    ok(done.code === 1, '清除成功', done.msg);
    ok(!!done.data?.backup, '返回了备份文件名', done.data?.backup);
    ok(done.data.total > 0, '清除了若干行', String(done.data?.total));

    eq(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0, '订单已清空');
    eq(db.prepare('SELECT COUNT(*) c FROM finance_energy').get().c, 0, '资金流水已清空');
    eq(db.prepare('SELECT COUNT(*) c FROM settle_pay').get().c, 0, '结算账目已清空');
    eq(db.prepare('SELECT COUNT(*) c FROM member').get().c, 1, '只保留 1 个官方账号');
    const off = db.prepare('SELECT * FROM member LIMIT 1').get();
    eq(off.mobile, '13800000001', '官方手机号');
    eq(off.invitation_code, 'boss01', '官方邀请码');
    eq(Number(off.p_id), 0, '官方是根节点');
    eq(Number(off.amount), 0, '官方余额归零');
    eq(Number(off.e_card_number), 0, '官方佣金归零');
    eq(off.child_id || '', '', '官方下级清空');

    const g = db.prepare('SELECT COUNT(*) c, SUM(goods_status = 10) on_sale, SUM(turn_beat_num) turns, SUM(sales_actual) sales FROM goods').get();
    eq(g.c, before.goods, '商品一个都没删');
    eq(g.on_sale, before.goods, '商品全部重新上架');
    eq(Number(g.turns), 0, '流转次数归零');
    eq(Number(g.sales), 0, '销量归零');
    eq(db.prepare('SELECT COUNT(*) c FROM goods WHERE member_id <> ?', off.member_id).get().c, 0, '商品持有人都是官方');

    const after = {
      cat: db.prepare('SELECT COUNT(*) c FROM goods_category').get().c,
      area: db.prepare('SELECT COUNT(*) c FROM specialarea').get().c,
      user: db.prepare('SELECT COUNT(*) c FROM store_user').get().c,
      cfg: db.prepare('SELECT COUNT(*) c FROM setting_config').get().c,
    };
    eq(after.cat, before.cat, '分类没被删');
    eq(after.area, before.area, '场次没被删');
    eq(after.user, userBeforeReset, '后台账号没被删');
    eq(after.cfg, before.cfg, '系统配置没被删');

    const backupsAfter = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((f) => f.startsWith('before-reset-')).length : 0;
    ok(backupsAfter > backupsBefore, '备份文件已生成', `${backupsBefore} → ${backupsAfter}`);
    ok(existsSync(join(BACKUP_DIR, done.data.backup)), '备份文件确实落盘');

    // ---------- 序列归零 ----------
    section('[5] 自增序列归零');
    const reg = await api('/api/member/registerAnAccount', {
      method: 'POST',
      body: { phone: '13900001111', password: '123456', code: 'boss01', nickName: '第一个测试用户' },
    });
    ok(reg.code === 1, '官方邀请码仍可注册', reg.msg);
    eq(reg.data.member_id, 2, '新用户从 member_id=2 开始');
    const order = await api('/api/order/toAddOrder', {
      method: 'POST', token: reg.data.token, body: { goods_id: db.prepare('SELECT goods_id FROM goods ORDER BY goods_id LIMIT 1').get().goods_id, num: 1, pay_type: 1 },
    });
    ok(order.code === 1 || order.code === 0, '新用户能下单（余额不足属正常）', order.msg);

    // ---------- 素材范围 ----------
    section('[6] 素材范围只删没人用的图');
    const upFd = new FormData();
    upFd.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), '待清理.png');
    const up = await fetch(`${BASE}/admin/api/media/upload`, { method: 'POST', headers: { token: at }, body: upFd }).then((r) => r.json());
    ok(up.code === 1, '上传一张测试图', up.msg);
    await api('/admin/api/media/groups', { token: at }); // 触发磁盘同步，把历史图登记进来
    const mediaTotal = db.prepare('SELECT COUNT(*) c FROM media_file').get().c;
    const mediaDone = await api('/admin/api/system/reset', {
      method: 'POST', token: at, body: { scopes: ['trade', 'media'], confirm: '我已知晓风险并确认清除' },
    });
    ok(mediaDone.code === 1, '带素材范围清除成功', mediaDone.msg);
    const mediaAfter = db.prepare('SELECT COUNT(*) c FROM media_file').get().c;
    ok(mediaAfter < mediaTotal, '未引用素材被删掉', `${mediaTotal} → ${mediaAfter}`);
    const stillUsed = db.prepare("SELECT COUNT(*) c FROM media_file WHERE path LIKE '%demo-1%'").get().c;
    eq(stillUsed, 1, '被商品引用的 demo-1 仍保留');
    const uploadedGone = db.prepare("SELECT COUNT(*) c FROM media_file WHERE name = '待清理'").get().c;
    eq(uploadedGone, 0, '没人用的测试图已被删');
  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.log(`   · ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main()
  .catch((e) => { console.error('\n[错误]', e.message); process.exitCode = 1; })
  .finally(() => {
    for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
