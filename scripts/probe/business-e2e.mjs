// 业务全链路验收：邀请注册 → 充值 → 抢单 → 余额支付 → 分账结算 → 转拍涨价 → 再成交
//                  → 到顶拦截 → 自动回收 → 提现申请/驳回 → 财务大盘对账
// 独立库（business-e2e.db / 3480），跑完自动销毁，不碰演示库
// 用法: node scripts/probe/business-e2e.mjs
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SERVER = join(ROOT, 'server');
const PORT = 3480;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'business-e2e.db';

for (const f of [join(SERVER, 'data', DB), join(SERVER, 'data', `${DB}-wal`), join(SERVER, 'data', `${DB}-shm`)]) {
  if (existsSync(f)) unlinkSync(f);
}
process.env.MALL_DB = DB;
const env = { ...process.env, MALL_DB: DB, PORT: String(PORT), RECYCLE_SCAN_MS: '0', EXPIRE_SCAN_MS: '0' };

let pass = 0;
const fails = [];
const section = (t) => console.log(`\n${t}`);
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}
const money = (n) => Number(Number(n || 0).toFixed(2));
const eq = (a, b, name) => ok(money(a) === money(b), name, `期望 ${b}，实际 ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

async function main() {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/seed.js'], { cwd: SERVER, env, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(out))));
  });
  const { db } = await import('../../server/src/db.js');
  // 系统默认只开线下转账；本用例验证的是余额扣款与分账，测试库显式把余额支付打开
  db.prepare("UPDATE setting_config SET `value` = '10' WHERE `key` = 'pay_balance_open'").run();

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
  if (!ready) throw new Error(`服务启动超时：\n${log.slice(-600)}`);

  const balanceOf = (mid) => money(db.prepare('SELECT amount FROM member WHERE member_id = ?').get(mid).amount);
  const commissionOf = (mid) => money(db.prepare('SELECT e_card_number FROM member WHERE member_id = ?').get(mid).e_card_number);
  const flowSum = (mid, typeName) => money(
    db.prepare('SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type_name = ?').get(mid, typeName)?.v,
  );

  try {
    const at = (await api('/admin/api/login', { method: 'POST', body: { user_name: 'admin1', password: '123456' } })).data.token;
    ok(!!at, '后台登录');

    // 口径：服务费 2%、上架费 0、涨价 3%、回收开启且不限日额
    db.prepare("UPDATE specialarea SET start_time = 0, end_time = 86399, buy_num = 99, open_days = '1,2,3,4,5,6,7'").run();
    const areaId = Number(db.prepare('SELECT specialarea_id FROM specialarea ORDER BY specialarea_id LIMIT 1').get().specialarea_id);
    await api('/admin/api/setting/save', {
      method: 'POST', token: at,
      body: {
        group: 'trade',
        values: {
          service_charge: '2', listing_fee_rate: '0', price_increase_rate: '3',
          drive_award_rate: '0.5', withdraw_min: '10', withdraw_fee: '0',
          recycle_open: '10', recycle_daily_cap: '0',
        },
      },
    });

    // ================= 1. 邀请注册 + 充值 =================
    section('[1] 邀请注册（4 个买家都挂在官方名下）');
    const official = db.prepare("SELECT member_id FROM member WHERE mobile = '13800000001'").get();
    const buyers = [];
    for (let i = 1; i <= 4; i += 1) {
      const phone = `1391000000${i}`;
      const reg = await api('/api/member/registerAnAccount', {
        method: 'POST', body: { phone, password: 'buy123456', code: 'boss01', nickName: `买家${i}` },
      });
      ok(reg.code === 1, `注册买家${i}`, reg.msg);
      const mid = Number(reg.data?.member_id) || db.prepare('SELECT member_id FROM member WHERE mobile = ?').get(phone)?.member_id;
      await api('/admin/api/member/adjust', {
        method: 'POST', token: at,
        body: { member_id: mid, field: 'amount', value: 5000, remark: '验收充值' },
      });
      const login = await api('/api/member/accountLogin', { method: 'POST', body: { phone, password: 'buy123456' } });
      ok(login.code === 1, `买家${i} 可登录`);
      buyers.push({ mid: Number(mid), token: login.data.token, phone });
    }
    eq(buyers.length, 4, '四个买家就绪');
    const parentIds = buyers.map((b) => Number(db.prepare('SELECT p_id FROM member WHERE member_id = ?').get(b.mid).p_id));
    ok(parentIds.every((p) => p === Number(official.member_id)), '四人都绑定到官方（上级=官方）');
    buyers.forEach((b) => eq(balanceOf(b.mid), 5000, `买家${b.phone.slice(-1)} 充值到账 5000`));

    // ================= 2. 建商品（基准 1000 / 围栏 1100） =================
    section('[2] 建商品：售价 1000、基准价 1000、价格上限 1100');
    const catId = db.prepare('SELECT category_id FROM goods_category LIMIT 1').get().category_id;
    // 说明：后台编辑表单已不再提供「商品编码 / 现持有人 / 基准价 / 划线价」入口，
    // 这四项由系统维护 —— 编码自动生成、基准价自动取售价、持有人归平台、划线价随转拍跟涨。
    // 这里仍按老参数传一遍，是为了确认它们被安全忽略（不会写坏数据）。
    const created = await api('/admin/api/goods/save', {
      method: 'POST', token: at,
      body: {
        goods_name: '验收·流转样品', goods_no: `E2E-${Date.now()}`, category_id: catId,
        member_id: official.member_id, goods_min_price: 1000, base_price: 1000, price_cap: 1100,
        line_price: 1500, stock_num: 1, sales_actual: 0, goods_status: 10, goods_sort: 1,
      },
    });
    const gid = Number(created.data?.id);
    ok(created.code === 1 && gid > 0, '商品创建成功', created.msg);
    const goods = () => db.prepare('SELECT * FROM goods WHERE goods_id = ?').get(gid);
    eq(goods().price_cap, 1100, '价格上限落库');
    eq(goods().base_price, 1000, '基准价自动取售价（表单传参被忽略）');
    ok(/^GP\d+$/.test(String(goods().goods_no || '')), '编码自动生成（表单传参被忽略）', goods().goods_no);
    // 新建商品默认归平台（member_id = 0），平台卖出不向会员打款。
    // 这个用例要验证的是「卖家收款分账」，所以把它置为官方持有 —— 等价于商品被官方抢走后的状态。
    db.prepare('UPDATE goods SET member_id = ? WHERE goods_id = ?').run(official.member_id, gid);
    eq(goods().member_id, official.member_id, '已把样品置为官方持有');
    // 挂进第一场：这样抢单走的是真正的场次校验，不是「没场次的随时可买」
    const link = await api('/admin/api/specialarea/goods/add', {
      method: 'POST', token: at, body: { specialarea_id: areaId, goods_ids: [gid] },
    });
    ok(link.code === 1, '商品已关联到场次', link.msg);

    // 财务与余额基线（库里还有 seed 的演示订单，所以后面一律用增量对账）
    const ovBefore = (await api('/admin/api/finance/overview', { token: at })).data;
    const balSumBefore = money(db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v);
    const flowsBefore = money(db.prepare('SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2').get().v);
    const officialBefore = balanceOf(official.member_id);
    const officialCommissionBefore = commissionOf(official.member_id);

    // ================= 3. 抢单 → 支付 → 分账（4 轮） =================
    section('[3] 抢单 / 余额支付 / 分账结算（4 轮，金额逐轮到分核对）');
    // 服务费 2%、涨价 3%、直推奖 0.5%
    const rounds = [
      { price: 1000, fee: 20, pay: 1020, award: 5 },
      { price: 1030, fee: 20.6, pay: 1050.6, award: 5.15 },
      { price: 1060.9, fee: 21.22, pay: 1082.12, award: 5.3 },
      { price: 1092.73, fee: 21.85, pay: 1114.58, award: 5.46 },
    ];

    for (let i = 0; i < rounds.length; i += 1) {
      const r = rounds[i];
      const buyer = buyers[i];
      const sellerMid = Number(goods().member_id);
      const sellerBefore = balanceOf(sellerMid);
      const awardBefore = flowSum(official.member_id, '直推奖');
      const buyerBefore = balanceOf(buyer.mid);

      // 转拍会把商品排到「下一场」，一天三场走完就顺延到次日；验收要连着买 4 手，
      // 这里代替「等到了那一天」把场次日期放开，买卖与分账口径一概不动。
      db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);
      const order = await api('/api/order/toAddOrder', {
        method: 'POST', token: buyer.token, body: { goods_id: gid, num: 1, pay_type: 1 },
      });
      ok(order.code === 1, `第${i + 1}轮 下单`, order.msg);
      eq(order.data?.total_price, r.price, `第${i + 1}轮 标价 ${r.price}`);
      eq(order.data?.service_charge, r.fee, `第${i + 1}轮 服务费 = ${r.price} × 2%`);

      const pay = await api('/api/order/toPay', { method: 'POST', token: buyer.token, body: { order_id: order.data.order_id, pay_type: 1 } });
      ok(pay.code === 1, `第${i + 1}轮 余额支付`, pay.msg);

      eq(buyerBefore - balanceOf(buyer.mid), r.pay, `第${i + 1}轮 买家实付 = 标价 + 服务费`);
      eq(balanceOf(sellerMid) - sellerBefore, r.price, `第${i + 1}轮 卖家到账全额（平台不抽货款）`);
      eq(flowSum(official.member_id, '直推奖') - awardBefore, r.award, `第${i + 1}轮 上级直推奖 = ${r.price} × 0.5%`);

      const g = goods();
      eq(g.member_id, buyer.mid, `第${i + 1}轮 商品归属转移给买家`);
      eq(g.goods_status, 20, `第${i + 1}轮 成交即下架`);
      eq(g.turn_beat_num, i + 1, `第${i + 1}轮 流转次数 +1`);

      // 下一手转拍（最后一轮不转，留给围栏拦截）
      if (i < rounds.length - 1) {
        db.prepare("UPDATE goods SET area_date = '' WHERE goods_id = ?").run(gid);
        const cons = await api('/api/order/consignment', {
          method: 'POST', token: buyer.token, body: { order_id: order.data.order_id },
        });
        ok(cons.code === 1, `第${i + 1}轮 转拍上架`, cons.msg);
        eq(goods().goods_min_price, rounds[i + 1].price, `第${i + 1}轮 转拍后标价 = ${rounds[i].price} × 1.03`);
        eq(goods().goods_status, 10, `第${i + 1}轮 转拍后重新上架`);
      }
    }

    // ================= 4. 到顶：下一轮越界 → 禁止转拍 → 自动回收 =================
    section('[4] 到顶判定：1092.73 × 1.03 = 1125.51 > 1100 → 停止转拍 + 自动回收');
    const lastOrder = db.prepare(
      'SELECT * FROM orders WHERE goods_id = ? AND member_id = ? ORDER BY order_id DESC LIMIT 1',
    ).get(gid, buyers[3].mid);
    const lastBuyerBefore = balanceOf(buyers[3].mid);

    const quote = await api(`/api/order/getConsignmentQuote?order_id=${lastOrder.order_id}`, { token: buyers[3].token });
    ok(quote.code === 0 && /价格上限/.test(quote.msg), '报价接口拒绝', quote.msg);
    const cons = await api('/api/order/consignment', {
      method: 'POST', token: buyers[3].token, body: { order_id: lastOrder.order_id },
    });
    ok(cons.code === 0 && /价格上限/.test(cons.msg), '转拍接口拒绝', cons.msg);
    eq(goods().goods_min_price, 1092.73, '被拒后标价没有变化');

    const scan = await api('/admin/api/recycle/scan', { method: 'POST', token: at, body: {} });
    ok(scan.code === 1 && scan.data.settled >= 1, '自动回收扫描命中', scan.msg);
    const rec = db.prepare('SELECT * FROM goods_recycle WHERE goods_id = ? ORDER BY recycle_id DESC LIMIT 1').get(gid);
    eq(rec?.buy_price, 1092.73, '回收单记录买入价 1092.73');
    eq(rec?.recycle_price, 1092.73, '回收价 = 当前实际价格（原价接盘）');
    // 收益按实际成本算：买入 1092.73 + 抢单服务费 21.85（2%）= 1114.58
    eq(rec?.buy_cost, 1114.58, '回收单记录实际成本 1114.58（含服务费）');
    eq(rec?.profit, -21.85, '这一手没有涨幅，扣掉服务费后净亏 21.85');
    eq(balanceOf(buyers[3].mid) - lastBuyerBefore, 1092.73, '回收款到账 1092.73');
    eq(goods().recycled, 1, '商品打上「封顶」标记');
    eq(goods().member_id, 0, '商品转平台持仓');

    // 前台全面消失
    const loot = await api('/api/goods/getLootGoodsList?page=1&limit=100');
    ok(!(loot.data?.data || []).some((x) => Number(x.goods_id) === gid), '抢购列表不再出现');
    const shop = await api('/api/goods/searchShop?page=1&limit=100');
    ok(!(shop.data?.data || []).some((x) => Number(x.goods_id) === gid), '商城/搜索结果不再出现');
    const detail = await api(`/api/goods/getLootDetails?goods_id=${gid}`);
    ok(detail.code === 0, '详情接口按不存在处理', detail.msg);

    // ================= 5. 资金净额核对 =================
    section('[5] 资金净额：买家、卖家、上级、平台逐项对平');
    // 买家1：-1020（买）+1030（卖出）= +10；买家2：-1050.6+1060.9=+10.3；买家3：-1082.12+1092.73=+10.61
    eq(balanceOf(buyers[0].mid) - 5000, 10, '买家1 净 +10（赚 1030−1020）');
    eq(balanceOf(buyers[1].mid) - 5000, 10.3, '买家2 净 +10.3（赚 1060.9−1050.6）');
    eq(balanceOf(buyers[2].mid) - 5000, 10.61, '买家3 净 +10.61（赚 1092.73−1082.12）');
    eq(balanceOf(buyers[3].mid) - 5000, -21.85, '买家4 净 −21.85（到顶原价接盘，自担 2% 服务费）');
    eq(balanceOf(official.member_id) - officialBefore, 1000, '官方：卖出到账 1000（货款进余额）');
    eq(commissionOf(official.member_id) - officialCommissionBefore, 20.91, '官方：直推奖 20.91 进佣金账户');

    const totalFees = money(rounds.reduce((s, r) => s + r.fee, 0));
    const totalAwards = money(rounds.reduce((s, r) => s + r.award, 0));
    eq(totalFees, 83.67, '四轮服务费合计 83.67');
    eq(totalAwards, 20.91, '四轮直推奖合计 20.91');
    eq(money(totalFees - totalAwards), 62.76, '平台净收 62.76（1.5%/轮）');

    // ================= 6. 提现：申请 → 驳回退回 =================
    section('[6] 提现申请 → 审核驳回 → 余额退回');
    const wBuyer = buyers[0];
    const wBefore = balanceOf(wBuyer.mid);
    const apply = await api('/api/finance/withdraw/apply', {
      method: 'POST', token: wBuyer.token,
      body: { amount: 500, account_type: 3, account_info: '6222020000000001 工商银行 买家1' },
    });
    ok(apply.code === 1, '提现申请提交', apply.msg);
    eq(balanceOf(wBuyer.mid), money(wBefore - 500), '申请即冻结扣减 500');
    const wRow = db.prepare('SELECT * FROM finance_withdraw WHERE member_id = ? ORDER BY withdraw_id DESC LIMIT 1').get(wBuyer.mid);
    eq(wRow?.status, 0, '提现单待审核');
    eq(flowSum(wBuyer.mid, '提现申请'), -500, '资金流水记录 −500');

    const reject = await api('/admin/api/withdraw/audit', {
      method: 'POST', token: at, body: { withdraw_id: wRow.withdraw_id, pass: false, remark: '验收：驳回' },
    });
    ok(reject.code === 1, '后台驳回提现', reject.msg);
    eq(balanceOf(wBuyer.mid), wBefore, '驳回后余额自动退回');

    // ================= 7. 财务大盘对账 =================
    section('[7] 财务大盘：收入 / 支出 / 净利与库内数据一致');
    const ov = (await api('/admin/api/finance/overview', { token: at })).data;
    eq(ov?.today?.orders - ovBefore.today.orders, 4, '今日成交 +4 笔');
    eq(money(ov?.today?.gmv - ovBefore.today.gmv), 4183.63, '今日成交额 +4183.63');
    eq(money(ov?.today?.service_fee - ovBefore.today.service_fee), totalFees, '今日服务费 +83.67');
    eq(money(ov?.today?.income - ovBefore.today.income), totalFees, '今日经营收入 = 服务费');
    eq(money(ov?.today?.drive_award - ovBefore.today.drive_award), totalAwards, '今日直推奖 +20.91');
    eq(money(ov?.today?.net - ovBefore.today.net), money(totalFees - totalAwards), '今日经营净利 +62.76');
    ok(Array.isArray(ov?.risks), '风险自检可用');
    ok((ov?.liability?.total || 0) > 0, '会员负债已统计', `¥${ov?.liability?.total}`);

    // ================= 8. 数据一致性 =================
    section('[8] 数据一致性');
    eq(db.prepare('SELECT COUNT(*) c FROM member WHERE amount < 0').get().c, 0, '没有会员负余额');
    const flowsAfter = money(db.prepare("SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE type = 2").get().v);
    const balSumAfter = money(db.prepare('SELECT IFNULL(SUM(amount),0) v FROM member').get().v);
    // 增量对账：这期间余额类流水的净额必须等于会员余额的净变化
    eq(money(flowsAfter - flowsBefore), money(balSumAfter - balSumBefore), '余额流水增量 = 会员余额增量');
    eq(db.prepare('SELECT COUNT(*) c FROM orders o LEFT JOIN goods g ON g.goods_id = o.goods_id WHERE g.goods_id IS NULL').get().c, 0, '没有孤儿订单');
    eq(db.prepare("SELECT COUNT(*) c FROM orders WHERE goods_id = ? AND type = 1 AND pay_status = 10").get(gid).c, 4, '该商品 4 笔抢购订单全部已支付');
  } finally {
    srv.kill();
  }

  console.log('\n' + '─'.repeat(52));
  if (fails.length) {
    console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
    fails.forEach((f) => console.log(`   · ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`✓ 全部通过：${pass} 项断言`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
