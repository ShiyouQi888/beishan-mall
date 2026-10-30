import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, run, now } from './db.js';
import { ensureNodes } from './lib/nodes.js';
import { ensureBuiltinAdmin } from './lib/builtinAdmin.js';
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
// 与「拆分」是两件事：拆分是一货多份的定价方式，名额是一批货能卖几次。
if (!db.prepare('PRAGMA table_info(goods)').all().some((c) => c.name === 'stock_total')) {
  db.exec('ALTER TABLE goods ADD COLUMN stock_total INTEGER DEFAULT 0');
  console.log('[migrate] goods.stock_total 已添加');
}

// 上一版曾把「库存 >1 的整件商品」硬标成拆分商品（is_split=1、split_total=库存份数），
// 用来记账名额。概念不对（拆分是定价玩法，名额是能卖几次），现在名额有独立字段了，把标记还回去。
// 只跑一次：真拆分商品的份数里必然已经有卖出的，或者历史销量不可能是这次拆分产生的，
// 用「一份没卖 + 销量远大于份数」识别被误标的那些。
if (!get("SELECT `value` FROM setting_config WHERE `key` = 'migrate_unmark_fake_split'")) {
  const unmarked = run(
    `UPDATE goods SET is_split = 0, split_total = 0
     WHERE IFNULL(is_split, 0) = 1 AND IFNULL(split_total, 0) > 1
       AND IFNULL(stock_num, 0) = split_total
       AND IFNULL(sales_actual, 0) > split_total`,
  );
  run("INSERT INTO setting_config (`key`, `value`) VALUES ('migrate_unmark_fake_split', '1')");
  if (Number(unmarked.changes) > 0) {
    console.log(`[migrate] ${Number(unmarked.changes)} 件商品撤销了误标的「拆分」状态`);
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
  `UPDATE goods SET stock_total = CASE
     WHEN IFNULL(is_split, 0) = 1 AND IFNULL(split_total, 0) > 1 THEN split_total
     ELSE MAX(IFNULL(stock_num, 1), 1) END
   WHERE IFNULL(stock_total, 0) = 0`,
);
if (Number(initStockTotal.changes) > 0) {
  console.log(`[migrate] ${Number(initStockTotal.changes)} 件商品补齐名额`);
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
