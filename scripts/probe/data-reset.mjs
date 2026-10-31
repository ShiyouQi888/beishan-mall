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

  // 系统默认只开线下转账；本用例要走余额支付，测试库显式把余额支付打开
  {
    try {
      const { db: __payDb } = await import('../../server/src/db.js');
      __payDb.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();
    } catch {}
  }
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

    // 卡片上的行数必须一直看得到：只勾一项时，其余三项不能变成 0
    const planTradeOnly = await api('/admin/api/system/reset/plan?scopes=trade', { token: at });
    ok(
      (planTradeOnly.data.detail.member || []).length > 0
      && (planTradeOnly.data.detail.goods || []).length > 0
      && (planTradeOnly.data.detail.media || []).length > 0,
      '只勾一项时，其余范围仍返回真实行数',
      JSON.stringify(Object.keys(planTradeOnly.data.detail || {})),
    );
    eq(planTradeOnly.data.total, planTradeOnly.data.totals.trade, '合计只算勾选的范围');

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

    // 复位只动流转字段：名额复原、封顶标记清掉、回到不限日期、价格回到基准价
    const restock = db.prepare('SELECT COUNT(*) c FROM goods WHERE stock_num <> MAX(IFNULL(stock_total, 1), 1)').get().c;
    eq(restock, 0, '名额复原（stock_num = stock_total）');
    eq(db.prepare('SELECT COUNT(*) c FROM goods WHERE IFNULL(recycled,0) <> 0').get().c, 0, '封顶标记已清');
    eq(db.prepare("SELECT COUNT(*) c FROM goods WHERE IFNULL(area_date,'') <> ''").get().c, 0, '场次日期已清空');
    const priceBack = db.prepare('SELECT COUNT(*) c FROM goods WHERE base_price > 0 AND ABS(goods_min_price - base_price) > 0.004').get().c;
    eq(priceBack, 0, '价格回到基准价');

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

    // 详情里引用的图不能被当成「没人用」删掉（以前只查 good_thumb/images，详情是漏洞）
    const upFd2 = new FormData();
    upFd2.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), '详情专用.png');
    const up2 = await fetch(`${BASE}/admin/api/media/upload`, { method: 'POST', headers: { token: at }, body: upFd2 }).then((r) => r.json());
    ok(up2.code === 1, '上传一张「只在详情里用」的图', up2.msg);
    const detailPath = up2.data.path;
    db.prepare('UPDATE goods SET detail = ? WHERE goods_id = (SELECT goods_id FROM goods ORDER BY goods_id LIMIT 1)')
      .run(`<p>图文详情</p><img src="${detailPath}" alt="" />`);
    const cleanAgain = await api('/admin/api/system/reset', {
      method: 'POST', token: at, body: { scopes: ['media'], confirm: '我已知晓风险并确认清除' },
    });
    ok(cleanAgain.code === 1, '再清一次未引用素材', cleanAgain.msg);
    eq(db.prepare('SELECT COUNT(*) c FROM media_file WHERE path = ?').get(detailPath).c, 1, '商品详情里引用的图没被误删');

    // ---------- 恢复出厂口径 ----------
    // 用户要的是「只清用户 / 订单 / 财务资金」，商品连详情都不许动。
    section('[7] 恢复出厂：只清会员+订单+资金，商品与详情原样保留');
    const testMember = db.prepare('SELECT * FROM member WHERE mobile = ?').get('13900001111');
    ok(!!testMember, '前置：库里有一个非官方会员');

    const gid = db.prepare('SELECT goods_id FROM goods ORDER BY goods_id LIMIT 1').get().goods_id;
    const DETAIL = '<p>详情占位</p><img src="/uploads/demo-1.svg" alt="" />';
    const DIMGS = '["/uploads/demo-2.svg"]';
    db.prepare(
      `UPDATE goods SET member_id = ?, detail = ?, detail_images = ?, good_thumb = ?, images = ?,
         goods_min_price = 888, base_price = 100, stock_total = 5, stock_num = 2,
         turn_beat_num = 4, goods_status = 20, recycled = 1
       WHERE goods_id = ?`,
    ).run(testMember.member_id, DETAIL, DIMGS, '/uploads/demo-3.svg', '["/uploads/demo-4.svg"]', gid);
    const snap = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(gid);

    const factory = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['trade', 'member'], confirm: '我已知晓风险并确认清除' },
    });
    ok(factory.code === 1, '恢复出厂（会员 + 订单资金）执行成功', factory.msg);

    eq(db.prepare('SELECT COUNT(*) c FROM member').get().c, 1, '会员只剩官方账号');
    eq(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0, '订单清空');
    eq(db.prepare('SELECT COUNT(*) c FROM finance_energy').get().c, 0, '资金流水清空');
    eq(db.prepare('SELECT COUNT(*) c FROM finance_withdraw').get().c, 0, '提现申请清空');
    eq(db.prepare('SELECT COUNT(*) c FROM settle_pay').get().c, 0, '结算账目清空');
    eq(db.prepare('SELECT COUNT(*) c FROM member_address').get().c, 0, '会员地址清空');

    const a = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(gid);
    eq(db.prepare('SELECT COUNT(*) c FROM goods').get().c, before.goods, '商品一个都没少');
    eq(a.detail, DETAIL, '商品详情原样保留');
    eq(a.detail_images, DIMGS, '详情长图原样保留');
    eq(a.good_thumb, snap.good_thumb, '主图原样保留');
    eq(a.images, snap.images, '图集原样保留');
    eq(Number(a.goods_min_price), 888, '售卖价没被改');
    eq(Number(a.base_price), 100, '基准价没被改');
    eq(Number(a.goods_status), 20, '上下架状态没被改');
    eq(Number(a.stock_num), 2, '库存没被改');
    eq(Number(a.turn_beat_num), 4, '转拍次数没被改');
    eq(Number(a.recycled), 1, '封顶标记没被改');

    const off2 = db.prepare('SELECT * FROM member LIMIT 1').get();
    eq(Number(a.member_id), Number(off2.member_id), '持有人悬空的商品自动回到官方（只改这一个字段）');

    eq(db.prepare('SELECT COUNT(*) c FROM goods_category').get().c, before.cat, '分类没动');
    eq(db.prepare('SELECT COUNT(*) c FROM specialarea').get().c, before.area, '场次没动');
    eq(db.prepare('SELECT COUNT(*) c FROM setting_config').get().c, before.cfg, '系统设置没动');
    eq(db.prepare('SELECT COUNT(*) c FROM store_user').get().c, userBeforeReset, '后台账号没动');

    // ---------- 恢复出厂：四项全带 ----------
    section('[8] 恢复出厂四项全带：商品复位，但详情/图片/素材引用都不受损');
    const upFd3 = new FormData();
    upFd3.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), '详情长图.png');
    const up3 = await fetch(`${BASE}/admin/api/media/upload`, { method: 'POST', headers: { token: at }, body: upFd3 }).then((r) => r.json());
    ok(up3.code === 1, '上传一张只被详情引用的图', up3.msg);
    const keepPath = up3.data.path;
    const DETAIL2 = `<p>恢复出厂前的详情</p><img src="${keepPath}" alt="" />`;
    db.prepare('UPDATE goods SET detail = ?, detail_images = ?, area_date = ?, sales_actual = 3 WHERE goods_id = ?')
      .run(DETAIL2, '["/uploads/demo-2.svg"]', '2026-11-01', gid);
    const snap2 = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(gid);

    const allIn = await api('/admin/api/system/reset', {
      method: 'POST', token: at,
      body: { scopes: ['trade', 'member', 'goods', 'media'], confirm: '我已知晓风险并确认清除' },
    });
    ok(allIn.code === 1, '四项全带的恢复出厂执行成功', allIn.msg);
    eq(Object.keys(allIn.data?.removed || {}).length, 4, '四个范围都执行了');

    const b = db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(gid);
    eq(b.detail, snap2.detail, '商品详情原样保留');
    eq(b.detail_images, snap2.detail_images, '详情长图原样保留');
    eq(b.good_thumb, snap2.good_thumb, '主图原样保留');
    eq(b.images, snap2.images, '图集原样保留');
    eq(Number(b.goods_status), 10, '商品重新上架');
    eq(Number(b.is_sell), 10, '在售标记已恢复');
    eq(Number(b.stock_num), Number(b.stock_total), '名额复原（stock_num = stock_total）');
    eq(Number(b.turn_beat_num), 0, '转拍次数归零');
    eq(Number(b.sales_actual), 0, '销量归零');
    eq(Number(b.recycled), 0, '封顶标记已清');
    eq(String(b.area_date || ''), '', '场次日期已清空');
    eq(Number(b.goods_min_price), Number(b.base_price), '价格回到基准价');
    eq(
      db.prepare('SELECT COUNT(*) c FROM media_file WHERE path = ?').get(keepPath).c,
      1,
      '详情里引用的素材没被当成垃圾删掉',
    );
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
