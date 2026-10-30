import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, run } from './db.js';
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
// 初始化权限节点（幂等）
const addedNodes = ensureNodes();
if (addedNodes) console.log(`[nodes] 初始化 ${addedNodes} 个权限节点`);

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
app.use('/uploads', express.static(UPLOAD_DIR));

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
