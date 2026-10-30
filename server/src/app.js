import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, run, now } from './db.js';
import { ensureNodes } from './lib/nodes.js';
import { ensureBuiltinAdmin } from './lib/builtinAdmin.js';
import { scanCappedGoods } from './lib/recycle.js';
import { expireUnsold } from './lib/expire.js';
import { fail, cfg } from './lib/helper.js';
import { themeOf, DEFAULT_THEME } from './lib/themes.js';

import indexRouter from './routes/index.js';
import memberRouter from './routes/member.js';
import goodsRouter from './routes/goods.js';
import orderRouter from './routes/order.js';
import financeRouter from './routes/finance.js';
import uploadRouter from './routes/upload.js';
import scoreRouter from './routes/score.js';
import adminRouter from './routes/admin/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 初始化表结构
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
// 老库增加首页分类显示状态；默认显示，确保升级后现有首页不变。
if (!db.prepare('PRAGMA table_info(goods_category)').all().some((column) => column.name === 'home_show')) {
  db.exec('ALTER TABLE goods_category ADD COLUMN home_show INTEGER NOT NULL DEFAULT 10');
  console.log('[migrate] goods_category.home_show 已添加，现有分类默认显示');
}
// 商品增加「场次日期」：轮转上架要能落到明天，光有 specialarea_id 表达不了跨天
if (!db.prepare('PRAGMA table_info(goods)').all().some((c) => c.name === 'area_date')) {
  db.exec("ALTER TABLE goods ADD COLUMN area_date TEXT DEFAULT ''");
  console.log('[migrate] goods.area_date 已添加，老商品视为不限日期');
}
// 角色增加「是否超管」标记：原来靠 role_id === 6 硬编码判断，换个库或改 seed 就失效
if (!db.prepare('PRAGMA table_info(store_role)').all().some((c) => c.name === 'is_super')) {
  db.exec('ALTER TABLE store_role ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0');
  const marked = run("UPDATE store_role SET is_super = 1 WHERE role_id = 6 OR role_name = '超级管理员'");
  console.log(`[migrate] store_role.is_super 已添加，标记 ${Number(marked.changes) || 0} 个超管角色`);
}

// 商品增加「初始名额」：库存是「还能被抢几个」，名额是「一共几个」。
// 光看 stock_num 判断不出一件货是「唯一一件」还是「一批货」，因为卖着卖着它也变成 1。
// 这个字段一旦定下就不再随成交变化，用来区分两种完全不同的商品：
//   名额 = 1          → 唯一的一件货，成交即整件归买家 + 下架，买家可转拍
//   名额 > 1          → 一批货，抢一个减一个名额，抢光才下架，整件始终归原持有人
if (!db.prepare('PRAGMA table_info(goods)').all().some((c) => c.name === 'stock_total')) {
  db.exec('ALTER TABLE goods ADD COLUMN stock_total INTEGER DEFAULT 0');
  console.log('[migrate] goods.stock_total 已添加');
}

// 「按份拆分」功能已整体下线：旧库里的 is_split / split_total 一律清掉并删列。
// 已拆分的商品保留现有份数与每份价格，当作普通多库存商品继续卖（不再有按份的专属逻辑）。
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_drop_split'")) {
  const cols = db.prepare('PRAGMA table_info(goods)').all().map((c) => c.name);
  if (cols.includes('is_split')) db.exec('ALTER TABLE goods DROP COLUMN is_split');
  if (cols.includes('split_total')) db.exec('ALTER TABLE goods DROP COLUMN split_total');
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_drop_split', '1')");
  if (cols.includes('is_split') || cols.includes('split_total')) {
    console.log('[migrate] 已下线「按份拆分」：goods.is_split / split_total 列已删除，原拆分商品按普通商品保留');
  }
}

// 商品增加「每场放量」：库存是仓库里一共有多少，放量是这一场只拿出多少来卖。
// 例如库存 100 件、每场只放 10 件 —— 抢满 10 件这一场就结束变灰，剩下的留在下次。
// 0（默认）= 不限，整批库存都能卖，现有商品行为不变。
// 注意这是「名额数」不是「人数」：放 10 个名额 + 每人限购 2 件 = 5 个人就能抢完。
if (!db.prepare('PRAGMA table_info(goods)').all().some((c) => c.name === 'session_quota')) {
  db.exec('ALTER TABLE goods ADD COLUMN session_quota INTEGER DEFAULT 0');
  console.log('[migrate] goods.session_quota 已添加，老商品默认不限量');
}
// 「名额」一旦定下就不随成交变化，用来区分「唯一一件货」（成交即归买家）和「一批货」（抢一个减一个）。
const initStockTotal = run(
  `UPDATE goods SET stock_total = MAX(IFNULL(stock_num, 1), 1) WHERE IFNULL(stock_total, 0) = 0`,
);
if (Number(initStockTotal.changes) > 0) {
  console.log(`[migrate] ${Number(initStockTotal.changes)} 件商品补齐名额`);
}

// 商品价格上限：base_price 是「首次上架价」，色块水位从它起算；price_cap 是「最高能卖多少钱」（元，0=不限）。
// 老库补列后，基准价用「当前售价」回填（历史成交价拿不到，从当前价开始算涨幅最稳），
// 上限一律 0 = 不限，现有商品行为不变，运营按需去后台逐个设置。
{
  const cols = db.prepare('PRAGMA table_info(goods)').all().map((c) => c.name);
  if (!cols.includes('base_price')) {
    db.exec('ALTER TABLE goods ADD COLUMN base_price REAL DEFAULT 0');
    console.log('[migrate] goods.base_price 已添加');
  }
  if (!cols.includes('price_cap')) {
    db.exec('ALTER TABLE goods ADD COLUMN price_cap REAL DEFAULT 0');
    console.log('[migrate] goods.price_cap 已添加（价格上限，元；0 = 不限）');
  }
  const filled = run(
    'UPDATE goods SET base_price = goods_min_price WHERE IFNULL(base_price, 0) <= 0 AND goods_min_price > 0',
  );
  if (Number(filled.changes) > 0) {
    console.log(`[migrate] ${Number(filled.changes)} 件商品补齐基准价（取当前售价）`);
  }
  // 上一版上限是「百分比」，现在改成「金额封顶」：把百分比折算成上限价，再删列。
  // 折算 = 基准价 × (1 + 上限%/100)，这样已设过上限的商品行为保持不变。
  if (cols.includes('price_cap_rate')) {
    const converted = run(
      `UPDATE goods SET price_cap = ROUND(base_price * (1 + price_cap_rate / 100), 2)
       WHERE IFNULL(price_cap, 0) <= 0 AND IFNULL(price_cap_rate, 0) > 0 AND IFNULL(base_price, 0) > 0`,
    );
    db.exec('ALTER TABLE goods DROP COLUMN price_cap_rate');
    console.log(`[migrate] 价格上限改为金额口径：${Number(converted.changes) || 0} 件商品已折算成上限价，price_cap_rate 列已删除`);
  }
  // 已回收封顶标记：前台不再展示，后台打「封顶」标签；改回上架才重新流通
  if (!cols.includes('recycled')) {
    db.exec('ALTER TABLE goods ADD COLUMN recycled INTEGER DEFAULT 0');
    console.log('[migrate] goods.recycled 已添加（1 = 已被系统回收封顶）');
  }
  // 只回填一次：之后「二次上架」会把标记清掉，不能被启动迁移again 打回去
  if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_recycled_flag'")) {
    const marked = run(
      `UPDATE goods SET recycled = 1
       WHERE EXISTS (SELECT 1 FROM goods_recycle r WHERE r.goods_id = goods.goods_id AND r.status = 10)`,
    );
    run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_recycled_flag', '1')");
    if (Number(marked.changes) > 0) {
      console.log(`[migrate] ${Number(marked.changes)} 件已回收商品补打「封顶」标记`);
    }
  }
}

// 「流拍」下线：删掉历史流拍台账（orders.type = 5），流拍态商品（goods_status = 30）改回下架。
// 替代方案是「到期自动下架」：场次结束仍没人买 → 下架退回持有人，不生成任何台账。
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_drop_streambeat'")) {
  const del = run('DELETE FROM orders WHERE type = 5');
  const back = run('UPDATE goods SET goods_status = 20 WHERE goods_status = 30');
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_drop_streambeat', '1')");
  console.log(`[migrate] 流拍已下线：删除 ${Number(del.changes) || 0} 条流拍台账，${Number(back.changes) || 0} 件流拍商品改回下架`);
}

// 「差价对账」下线：批次 / 中账 / 匹配三张表一并删除（成交流程早已即时入账）
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_drop_settlement'")) {
  for (const t of ['settle_match', 'settle_account', 'settle_batch']) db.exec(`DROP TABLE IF EXISTS ${t}`);
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_drop_settlement', '1')");
  console.log('[migrate] 差价对账已下线：settle_batch / settle_account / settle_match 已删除');
}

// 「举报处理」下线：举报表一并删除（历史数据不留）
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_drop_report'")) {
  db.exec('DROP TABLE IF EXISTS order_report');
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_drop_report', '1')");
  console.log('[migrate] 举报处理已下线：order_report 表已删除');
}

// 「会员等级」体系整体下线：会员表上的等级/战绩字段与 member_grade 表一起删
// （等级不再影响任何资金口径：团队奖、升级判定都已移除）
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_drop_member_grade'")) {
  const mcols = db.prepare('PRAGMA table_info(member)').all().map((c) => c.name);
  for (const col of ['grade_id', 'identity_vip', 'team_water']) {
    if (mcols.includes(col)) db.exec(`ALTER TABLE member DROP COLUMN ${col}`);
  }
  db.exec('DROP TABLE IF EXISTS member_grade');
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_drop_member_grade', '1')");
  console.log('[migrate] 会员等级体系已下线：member_grade 表与 grade_id/identity_vip/team_water 字段已删除');
}

// 商品与场次改为「关联表」决定，goods.specialarea_id 只作为首个关联场次的镜像。
// 老库里每件商品的场次存在 goods.specialarea_id 上，这里一次性搬进关联表；
// 搬完之后商品表上的场次字段不再参与任何业务判断。
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_area_goods_rel'")) {
  const moved = run(
    `INSERT OR IGNORE INTO specialarea_goods (specialarea_id, goods_id, sort, create_time)
     SELECT specialarea_id, goods_id, IFNULL(goods_sort, 100), ? FROM goods
     WHERE IFNULL(specialarea_id, 0) > 0
       AND specialarea_id IN (SELECT specialarea_id FROM specialarea)`,
    now(),
  );
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_area_goods_rel', '1')");
  if (Number(moved.changes) > 0) {
    console.log(`[migrate] ${Number(moved.changes)} 件商品的场次已迁入关联表 specialarea_goods`);
  }
}

// 清理早期 seed 预置的默认轮播图。
// 它和运营自己上传的图一起轮播，看起来像「换了轮播图但默认图还在」。
// 只删 file_path 仍然指向那张预制 SVG 的记录：运营一旦换成自己的图，路径就变了，不会被误删。
{
  const removed = run("DELETE FROM shop_banner WHERE file_path = '/uploads/banner-1.svg'");
  if (Number(removed.changes) > 0) {
    console.log(`[migrate] 移除 ${removed.changes} 条预置默认轮播图（banner-1.svg）`);
  }
}

// 初始化权限节点（幂等）
const addedNodes = ensureNodes();
if (addedNodes) console.log(`[nodes] 初始化 ${addedNodes} 个权限节点`);

// 积分商品从「关联商城商品」改为独立表：把老 score_goods 的数据搬过去，只在首次迁移时执行
{
  const old = db.prepare('SELECT sg.*, g.goods_name, g.good_thumb, g.images, g.detail FROM score_goods sg LEFT JOIN goods g ON g.goods_id = sg.goods_id').all();
  const has = db.prepare('SELECT COUNT(*) c FROM score_item').get().c;
  if (old.length && Number(has) === 0) {
    for (const o of old) {
      db.prepare(
        `INSERT INTO score_item (name, thumb, images, intro, detail, score_price, stock, sold, limit_per, sort, status, create_time, update_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        o.goods_name || `积分商品 ${o.goods_id}`, o.good_thumb || '', o.images || '[]',
        '', o.detail || '', Number(o.score || 0), Number(o.stock || 0), 0, 0,
        Number(o.sort || 100), 10, now(), now(),
      );
    }
    console.log(`[migrate] score_goods → score_item，迁移 ${old.length} 件积分商品`);
  }
}

// 修正历史流水：早期 payCommission 把佣金写成了 type=3（积分），与积分兑换混在一起。
// 佣金按定义应为 type=1；这里只改「类型说明」明确是佣金的那批，不误伤真实积分记录。
{
  const fixed = run(
    "UPDATE finance_energy SET type = 1 WHERE type = 3 AND type_name IN ('直推奖', '团队奖')",
  );
  if (Number(fixed.changes) > 0) {
    console.log(`[migrate] 修正 ${fixed.changes} 条佣金流水类型：3(积分) → 1(佣金)`);
  }
}

// 协议类配置从旧键迁移到 prompt_ 前缀（幂等；旧键保留兼容）
for (const [to, from] of [
  ['prompt_register', 'register_agreement'],
  ['prompt_invite', 'invitation_notice'],
  ['prompt_shop', 'shop_agreement'],
  ['prompt_trade', 'transaction_agreement'],
]) {
  if (!get('SELECT 1 FROM setting_config WHERE `key` = ?', to)) {
    const old = get('SELECT `value` v FROM setting_config WHERE `key` = ?', from);
    if (old?.v) {
      run('INSERT INTO setting_config (`key`, `value`, `group`) VALUES (?,?,?)', to, old.v, 'prompt');
      console.log(`[migrate] ${from} → ${to}`);
    }
  }
}

// 修正早期 seed 写错的默认文案：转拍规则说明里误用了「提现规则」的文字
// 只在值仍是那条错误默认值时才覆盖，避免冲掉运营自己改过的内容
{
  const WRONG_RULE = '提现规则：可提现至已绑定的收款账户，T+1 到账；寄卖商品由平台统一撮合。';
  const cur = get("SELECT `value` v FROM setting_config WHERE `key` = 'consignment_rule'");
  if (cur?.v === WRONG_RULE) {
    run(
      "UPDATE setting_config SET `value` = ? WHERE `key` = 'consignment_rule'",
      '转拍需支付上架费，上架费按本轮竞得金额计算；转拍后商品自动按后台涨价率加价，进入下一轮场次。',
    );
    console.log('[migrate] 修正 consignment_rule 的错误默认文案');
  }
}

// 新增配置项：老库没有这些键时补默认值（否则后台开关会按「关闭」显示）
for (const [key, val, group] of [
  ['require_invite_code', '10', 'trade'],   // 注册必须填邀请码
  ['score_open', '10', 'store'],            // 积分商城开关
  ['score_award_open', '20', 'store'],      // 成交送积分开关（默认关，避免升级后凭空产生积分）
  ['score_award_buyer', '0', 'store'],      // 买家积分返利百分比（成交金额 × 百分比）
  ['score_award_parent', '0', 'store'],     // 上级积分返利百分比（成交金额 × 百分比）
  ['theme_key', 'coral', 'store'],          // 外观主题
  ['home_category_show', '10', 'nav'],      // 首页商品分类栏开关
  ['pay_balance_open', '10', 'pay'],        // 余额支付开关
  ['pay_voucher_required', '10', 'pay'],    // 线下支付是否必须上传凭证
  ['withdraw_wx_open', '10', 'trade'],      // 提现到微信
  ['withdraw_zfb_open', '10', 'trade'],     // 提现到支付宝
  ['withdraw_bank_open', '10', 'trade'],    // 提现到银行卡
  ['withdraw_offline_open', '10', 'trade'], // 提现线下打款
  ['recycle_open', '10', 'trade'],          // 到顶自动回收开关
  ['recycle_daily_cap', '0', 'trade'],      // 每日回收总额上限（0 = 不限）
]) {
  if (!get('SELECT 1 FROM setting_config WHERE `key` = ?', key)) {
    run('INSERT INTO setting_config (`key`, `value`, `group`) VALUES (?,?,?)', key, val, group);
    console.log(`[migrate] 补充默认配置 ${key}=${val}`);
  }
}

// 已废弃配置：分销只做一级，平级奖没有对应逻辑，清掉避免误解
if (get("SELECT 1 FROM setting_config WHERE `key` = 'same_level_award_rate'")) {
  run("DELETE FROM setting_config WHERE `key` = 'same_level_award_rate'");
  console.log('[migrate] 删除废弃配置 same_level_award_rate（分销仅一级，无平级奖）');
}

// 支付开关统一为 10 开 / 20 关（旧数据是 1 / 0，后台开关组件认不出）
for (const [key, on] of [['pay_wx', true], ['pay_zfb', true], ['pay_bank', false]]) {
  const cur = get('SELECT `value` v FROM setting_config WHERE `key` = ?', key);
  if (cur && ['0', '1'].includes(String(cur.v))) {
    run('UPDATE setting_config SET `value` = ? WHERE `key` = ?', on ? '10' : '20', key);
    console.log(`[migrate] 支付开关 ${key} 归一化为 ${on ? '10' : '20'}`);
  }
}

// 清掉早期「三级佣金」错误模型遗留的配置键（幂等；现在是单级直推奖 0.5%，这几个键无人读取）
for (const deadKey of ['commission_l1', 'commission_l2', 'commission_l3', 'commission_base']) {
  if (get('SELECT 1 FROM setting_config WHERE `key` = ?', deadKey)) {
    run('DELETE FROM setting_config WHERE `key` = ?', deadKey);
    console.log(`[migrate] 删除废弃配置 ${deadKey}`);
  }
}

// 「按份拆分」下线后，这条一次性迁移标记已无意义（is_split 列也已删除）
if (get("SELECT 1 FROM setting_config WHERE `key` = 'migrate_unmark_fake_split'")) {
  run("DELETE FROM setting_config WHERE `key` = 'migrate_unmark_fake_split'");
}

// 竞拍与充值套餐已整体下线（只有配置项/空表，没有对应业务逻辑与页面）
for (const deadKey of [
  'auction_open', 'auction_start_price', 'auction_step',
  'recharge_status', 'recharge_set',
]) {
  if (get('SELECT 1 FROM setting_config WHERE `key` = ?', deadKey)) {
    run('DELETE FROM setting_config WHERE `key` = ?', deadKey);
    console.log(`[migrate] 删除废弃配置 ${deadKey}`);
  }
}
if (get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recharge_package'")) {
  run('DROP TABLE recharge_package');
  console.log('[migrate] 删除废弃表 recharge_package（充值套餐已下线）');
}

// 内置管理员：账号密码来自 ADMIN_USER / ADMIN_PASSWORD，不再写死在代码里
ensureBuiltinAdmin();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
// 上传目录与 upload.js 保持一致，可用 UPLOAD_DIR 覆盖
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', 'data', 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    // 上传目录里一律不让浏览器猜类型：即使混进一段可执行内容，
    // nosniff 也会让它按声明的 Content-Type（图片）处理，而不是当页面跑起来
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ---- H5 / 小程序接口 ----
app.use('/api', indexRouter);
app.use('/api/member', memberRouter);
app.use('/api/goods', goodsRouter);
app.use('/api/order', orderRouter);
app.use('/api/finance', financeRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/score', scoreRouter);

// ---- 后台接口 ----
app.use('/admin/api', adminRouter);

app.get('/api/health', (req, res) => res.json({ code: 1, msg: 'ok', data: { time: Date.now() } }));

// ---- 一体化静态站点（前后端同一进程）----
// 构建产物目录：默认 <repo>/public，可用 PUBLIC_DIR 覆盖（Docker 里指向 /app/public）
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(__dirname, '..', '..', 'public');
const ADMIN_DIR = join(PUBLIC_DIR, 'admin');
const H5_DIR = join(PUBLIC_DIR, 'h5');
const hasAdmin = existsSync(join(ADMIN_DIR, 'index.html'));
const hasH5 = existsSync(join(H5_DIR, 'index.html'));

// ---- PWA：清单与 iOS 主屏图标（跟随店铺名与当前主题）----
app.get('/manifest.webmanifest', (req, res) => {
  const theme = themeOf(cfg('theme_key', DEFAULT_THEME));
  const name = cfg('store_name', '北山商城') || '北山商城';
  const icons = [
    { src: '/pwa/' + theme.key + '-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/pwa/' + theme.key + '-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/pwa/' + theme.key + '-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  const logo = cfg('store_logo', '');
  if (logo) icons.push({ src: logo, sizes: 'any', purpose: 'any' });
  // 名称/主题随时可能被后台改，别让浏览器把清单缓存住
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/manifest+json').send(JSON.stringify({
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: name + ' · 手机端商城',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'zh-CN',
    theme_color: theme.vars['--brand'],
    background_color: theme.vars['--bg'],
    icons,
  }));
});

// iOS 添加到主屏时用的图标（同样跟随主题）
app.get('/apple-touch-icon.png', (req, res) => {
  const theme = themeOf(cfg('theme_key', DEFAULT_THEME));
  const file = join(H5_DIR, 'pwa', theme.key + '-apple-180.png');
  if (existsSync(file)) return res.sendFile(file);
  res.status(404).end();
});


if (hasAdmin) {
  // 后台构建时 base=/admin/，资源在 /admin/assets/*
  // 精确匹配 /admin 才补斜杠，避免非严格路由把 /admin/ 也重定向到自己
  app.get(/^\/admin$/, (req, res) => res.redirect(301, '/admin/'));
  app.use('/admin', express.static(ADMIN_DIR, { index: false, maxAge: '7d' }));
  // 注意排除 /admin/api：接口走 JSON，不能被 SPA 回落吞掉
  app.get(/^\/admin(?!\/api(?:\/|$))(\/.*)?$/, (req, res) => res.sendFile(join(ADMIN_DIR, 'index.html')));
}

if (hasH5) {
  app.use(express.static(H5_DIR, { index: false, maxAge: '7d' }));
  // 前端用 hash 路由，深链接不经过服务端；其余路径回落到首页
  app.get(/^(?!\/(api|admin|uploads))(\/.*)?$/, (req, res) => res.sendFile(join(H5_DIR, 'index.html')));
}

if (hasAdmin || hasH5) {
  console.log(`[static] 后台 ${hasAdmin ? '已挂载 /admin' : '未构建'} ｜ H5 ${hasH5 ? '已挂载 /' : '未构建'}（目录 ${PUBLIC_DIR}）`);
}

// 统一 404 / 错误
app.use((req, res) => res.status(404).json(fail(`接口不存在: ${req.path}`, 404)));
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json(fail(err.message || '服务器内部错误'));
});

const PORT = Number(process.env.PORT) || 3300;
// 默认只监听本机；Docker / 反代场景用 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`mall-server running at http://${HOST}:${PORT}`);
  if (hasAdmin) console.log(`  后台管理：http://${HOST}:${PORT}/admin/`);
  if (hasH5) console.log(`  H5 商城：http://${HOST}:${PORT}/`);
});

// 到顶商品自动回收：默认 60 秒扫一次（只查「到顶 + 下架 + 仍在会员手里」的货，开销极小）。
// 后台「订单管理 → 系统回收」也有手动扫描按钮，两者走同一段逻辑，幂等。
// RECYCLE_SCAN_MS=0 可关掉定时任务（联调脚本用，避免定时器抢在断言前结算）。
const RECYCLE_SCAN_MS = Number(process.env.RECYCLE_SCAN_MS ?? 60000);
if (RECYCLE_SCAN_MS > 0) {
  setInterval(() => {
    try {
      const r = scanCappedGoods();
      if (r.settled || r.pending) {
        console.log(`[recycle] 到顶回收：结算 ${r.settled} 件（¥${r.paid.toFixed(2)}）｜待处理 ${r.pending} 件`);
      }
    } catch (e) {
      console.error('[recycle] 扫描失败：', e.message);
    }
  }, RECYCLE_SCAN_MS).unref?.();
}

// 到期自动下架：转拍挂出后场次结束仍没人买 → 下架退回持有人（替代原「流拍」）
// EXPIRE_SCAN_MS=0 可关掉（联调脚本用）
const EXPIRE_SCAN_MS = Number(process.env.EXPIRE_SCAN_MS ?? 300000);
if (EXPIRE_SCAN_MS > 0) {
  setInterval(() => {
    try {
      const r = expireUnsold();
      if (r.expired) console.log(`[expire] 到期下架：${r.expired} 件挂单已退回持有人`);
    } catch (e) {
      console.error('[expire] 扫描失败：', e.message);
    }
  }, EXPIRE_SCAN_MS).unref?.();
}
