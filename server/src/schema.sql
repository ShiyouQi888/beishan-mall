-- ============================================================
-- 抢购寄售商城 · 数据库结构
-- 状态约定：10 = 开启/上架/正常，20 = 关闭/下架/禁用
-- ============================================================

-- ---------- 后台账号与权限 ----------
CREATE TABLE IF NOT EXISTS store_role (
  role_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  role_name   TEXT NOT NULL,
  description TEXT DEFAULT '',
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS store_user (
  store_user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name     TEXT NOT NULL UNIQUE,
  password      TEXT NOT NULL,
  nick_name     TEXT DEFAULT '',
  avatar        TEXT DEFAULT '',
  role_id       INTEGER DEFAULT 1,
  status        INTEGER DEFAULT 10,
  last_login_time TEXT DEFAULT '',
  create_time   TEXT
);

CREATE TABLE IF NOT EXISTS store_node (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  node_name       TEXT NOT NULL,
  controller_name TEXT DEFAULT '',
  action_name     TEXT DEFAULT '',
  menu_icon       TEXT DEFAULT '',
  parent_id       INTEGER DEFAULT 0,
  type            INTEGER DEFAULT 1,      -- 1菜单 2按钮
  sort            INTEGER DEFAULT 100
);

CREATE TABLE IF NOT EXISTS store_role_node (
  role_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  PRIMARY KEY (role_id, node_id)
);

-- ---------- 会员等级配置（对齐原站 setting/grade） ----------
CREATE TABLE IF NOT EXISTS member_grade (
  grade_id    INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  drive_num   INTEGER DEFAULT 0,      -- 升级所需直推人数
  team_valid  INTEGER DEFAULT 0,      -- 升级所需团队有效人数
  team_water  REAL DEFAULT 0,         -- 升级所需团队流水（万元）
  team_award  REAL DEFAULT 0,         -- 团队奖励比例（%）
  create_time TEXT
);

-- ---------- 会员 ----------
CREATE TABLE IF NOT EXISTS member (
  member_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nick_name      TEXT DEFAULT '',
  mobile         TEXT NOT NULL UNIQUE,
  password       TEXT NOT NULL,
  pay_password   TEXT DEFAULT '',
  avatar_url     TEXT DEFAULT '',
  p_id           INTEGER DEFAULT 0,       -- 上级（邀请人）
  child_id       TEXT DEFAULT '',         -- 直属下级ID，逗号分隔
  path           TEXT DEFAULT '',         -- 层级路径 /1/4/411/
  level          INTEGER DEFAULT 1,       -- 团队深度
  grade_id       INTEGER DEFAULT 1,       -- 会员等级（对应 member_grade）
  team_water     REAL DEFAULT 0,          -- 累计团队流水
  invitation_code TEXT DEFAULT '',
  identity_vip   INTEGER DEFAULT 0,       -- 会员等级（兼容旧字段）
  is_valid       INTEGER DEFAULT 10,      -- 10有效 20无效
  amount         REAL DEFAULT 0,          -- 账户余额
  score          INTEGER DEFAULT 0,       -- 积分
  e_card_number  REAL DEFAULT 0,          -- 佣金（电子卡）
  rush_amount    REAL DEFAULT 0,          -- 抢购金额
  fy_price       REAL DEFAULT 0,          -- 礼券 / 能量券
  distribution_amount REAL DEFAULT 0,     -- 分销收益累计
  personal_income REAL DEFAULT 0,         -- 个人收益
  total_amount   REAL DEFAULT 0,          -- 累计消费
  is_advance     INTEGER DEFAULT 0,       -- 提前抢购资格 10有 0无
  advance_time   INTEGER DEFAULT 0,
  advance_count  INTEGER DEFAULT 0,
  morning_limit  INTEGER DEFAULT 0,       -- 早场限购数
  disabled       INTEGER DEFAULT 10,      -- 10正常 20禁用
  certification_name TEXT DEFAULT '',
  idcard         TEXT DEFAULT '',
  is_certification INTEGER DEFAULT 0,     -- 实名 1已认证
  sign_image     TEXT DEFAULT '',         -- 手写签名
  pay_setting    TEXT DEFAULT '',         -- JSON 收款方式
  open_id        TEXT DEFAULT '',
  client_type    INTEGER DEFAULT 1,       -- 1公众号 2小程序 3H5 4APP
  create_time    TEXT,
  update_time    TEXT
);
CREATE INDEX IF NOT EXISTS idx_member_pid ON member(p_id);
CREATE INDEX IF NOT EXISTS idx_member_path ON member(path);

CREATE TABLE IF NOT EXISTS member_certification (
  certification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id        INTEGER NOT NULL,
  real_name        TEXT DEFAULT '',
  idcard           TEXT DEFAULT '',
  front_image      TEXT DEFAULT '',
  back_image       TEXT DEFAULT '',
  hand_image       TEXT DEFAULT '',
  status           INTEGER DEFAULT 0,     -- 0待审 10通过 20拒绝
  remark           TEXT DEFAULT '',
  create_time      TEXT,
  audit_time       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS member_address (
  address_id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  name       TEXT DEFAULT '',
  mobile     TEXT DEFAULT '',
  province   TEXT DEFAULT '',
  city       TEXT DEFAULT '',
  district   TEXT DEFAULT '',
  detail     TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS member_card (
  card_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  type       INTEGER DEFAULT 1,           -- 1微信 2支付宝 3银行卡
  account    TEXT DEFAULT '',
  name       TEXT DEFAULT '',
  bank       TEXT DEFAULT '',
  image      TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  create_time TEXT
);

-- ---------- 商品 ----------
CREATE TABLE IF NOT EXISTS goods_category (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  parent_id   INTEGER DEFAULT 0,
  type        INTEGER DEFAULT 2,          -- 1商城分类 2首页抢购分类
  image       TEXT DEFAULT '',
  sort        INTEGER DEFAULT 100,
  create_time TEXT
);

-- 场次 / 专区
CREATE TABLE IF NOT EXISTS specialarea (
  specialarea_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT DEFAULT '',        -- forenoon / afternoon / evening
  title_main      TEXT DEFAULT '',        -- 主标题（抢购专场）
  title_ordinary  TEXT DEFAULT '',        -- 副标题（服务承诺）
  title_intro     TEXT DEFAULT '',
  image_ordinary  TEXT DEFAULT '',
  image_intro     TEXT DEFAULT '',
  start_time      INTEGER DEFAULT 0,      -- 每日开始（秒）
  end_time        INTEGER DEFAULT 0,      -- 每日结束（秒）
  open_days       TEXT DEFAULT '1,2,3,4,5,6,7',  -- 开启日期（1=周一 … 7=周日）
  buy_num         INTEGER DEFAULT 1,      -- 每场每人限购次数
  transposition_hours INTEGER DEFAULT 0,  -- 转拍延长时间（小时）
  is_subscribe    INTEGER DEFAULT 0,      -- 是否开放预约
  is_open         INTEGER DEFAULT 10,
  sort            INTEGER DEFAULT 100,
  create_time     TEXT
);

CREATE TABLE IF NOT EXISTS goods (
  goods_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  goods_name     TEXT NOT NULL,
  goods_no       TEXT DEFAULT '',
  good_thumb     TEXT DEFAULT '',
  images         TEXT DEFAULT '',         -- JSON 数组
  detail         TEXT DEFAULT '',         -- 富文本详情
  category_id    INTEGER DEFAULT 0,
  specialarea_id INTEGER DEFAULT 0,
  member_id      INTEGER DEFAULT 0,       -- 现持有人
  goods_min_price REAL DEFAULT 0,         -- 售卖价
  line_price     REAL DEFAULT 0,          -- 市场价/划线价
  stock_num      INTEGER DEFAULT 0,
  sales_actual   INTEGER DEFAULT 0,
  goods_status   INTEGER DEFAULT 10,      -- 10上架 20下架 30流拍
  is_sell        INTEGER DEFAULT 10,      -- 是否在售
  is_split       INTEGER DEFAULT 0,       -- 是否拆分商品（按份出售）
  split_total    INTEGER DEFAULT 0,       -- 拆分总份数
  turn_beat_num  INTEGER DEFAULT 0,       -- 转拍次数
  goods_sort     INTEGER DEFAULT 100,
  type           INTEGER DEFAULT 1,       -- 1抢购商品 2商城商品
  score_price    INTEGER DEFAULT 0,       -- 积分商品所需积分
  create_time    TEXT,
  update_time    TEXT
);
CREATE INDEX IF NOT EXISTS idx_goods_area ON goods(specialarea_id);
CREATE INDEX IF NOT EXISTS idx_goods_member ON goods(member_id);

-- ---------- 订单 ----------
CREATE TABLE IF NOT EXISTS orders (
  order_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT NOT NULL UNIQUE,
  member_id     INTEGER NOT NULL,         -- 买家
  seller_id     INTEGER DEFAULT 0,        -- 卖家（寄卖订单）
  goods_id      INTEGER DEFAULT 0,
  goods_name    TEXT DEFAULT '',
  goods_thumb   TEXT DEFAULT '',
  specialarea_id INTEGER DEFAULT 0,
  type          INTEGER DEFAULT 1,        -- 1抢购 2寄卖 3商城 4寄买 5流拍
  price         REAL DEFAULT 0,
  num           INTEGER DEFAULT 1,
  total_price   REAL DEFAULT 0,
  service_charge REAL DEFAULT 0,          -- 服务费（历史字段）
  listing_fee   REAL DEFAULT 0,           -- 上架费（转拍时收取，对齐原站 listing_fee_amount）
  selling_price REAL DEFAULT 0,           -- 寄卖标价（转拍时设定）
  transposition_time TEXT DEFAULT '',     -- 转拍时间
  status        INTEGER DEFAULT 0,        -- 0待付款 10待发货 20待收货 30已完成 40已取消
  pay_status    INTEGER DEFAULT 0,        -- 0未付 10已付
  pay_type      INTEGER DEFAULT 0,        -- 1余额 2微信 3支付宝 4线下凭证
  pay_voucher   TEXT DEFAULT '',
  pay_time      TEXT DEFAULT '',
  consignment_status INTEGER DEFAULT 0,   -- 寄卖：0未寄卖 10已寄卖
  is_examine    INTEGER DEFAULT 0,        -- 审核：0待审 10通过 20拒绝
  address_id    INTEGER DEFAULT 0,
  express_no    TEXT DEFAULT '',
  express_company TEXT DEFAULT '',
  send_time     TEXT DEFAULT '',
  finish_time   TEXT DEFAULT '',
  remark        TEXT DEFAULT '',
  create_time   TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_member ON orders(member_id);
CREATE INDEX IF NOT EXISTS idx_order_type ON orders(type, status);

CREATE TABLE IF NOT EXISTS order_log (
  log_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL,
  action     TEXT DEFAULT '',
  operator   TEXT DEFAULT '',
  remark     TEXT DEFAULT '',
  create_time TEXT
);

-- ---------- 财务 ----------
-- 佣金 / 能量值 / 积分 变更流水
CREATE TABLE IF NOT EXISTS finance_energy (
  energy_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  face_value REAL DEFAULT 0,              -- 变更数量（负数为支出）
  type       INTEGER DEFAULT 1,           -- 1佣金 2余额 3积分 4礼券
  type_name  TEXT DEFAULT '',
  remarks    TEXT DEFAULT '',
  create_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_energy_member ON finance_energy(member_id, type);

CREATE TABLE IF NOT EXISTS finance_withdraw (
  withdraw_id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL,
  amount      REAL DEFAULT 0,
  fee         REAL DEFAULT 0,
  actual_amount REAL DEFAULT 0,
  account_type INTEGER DEFAULT 1,         -- 1微信 2支付宝 3银行卡
  account_info TEXT DEFAULT '',
  status      INTEGER DEFAULT 0,          -- 0待审 10通过 20拒绝
  remark      TEXT DEFAULT '',
  create_time TEXT,
  audit_time  TEXT DEFAULT ''
);

-- 大/中/小账结算
CREATE TABLE IF NOT EXISTS settle_pay (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,             -- large / medium / small
  order_id     INTEGER DEFAULT 0,
  order_no     TEXT DEFAULT '',
  member_id    INTEGER DEFAULT 0,         -- 付款方
  b_member_id  INTEGER DEFAULT 0,         -- 收款方
  buy_amount   REAL DEFAULT 0,            -- 抢购金额
  consignment_amount REAL DEFAULT 0,      -- 寄卖金额
  listing_fee_amount REAL DEFAULT 0,      -- 上架费
  coupon_reward REAL DEFAULT 0,           -- 优惠券奖励
  balance      REAL DEFAULT 0,            -- 收支金额
  pay_type     INTEGER DEFAULT 1,
  payment_voucher TEXT DEFAULT '',
  pay_time     TEXT DEFAULT '',
  pay_status   INTEGER DEFAULT 0,         -- 0待确认 10已确认
  remark       TEXT DEFAULT '',
  create_time  TEXT
);
CREATE INDEX IF NOT EXISTS idx_settle_kind ON settle_pay(kind, pay_status);

-- ---------- 运营 ----------
CREATE TABLE IF NOT EXISTS shop_banner (
  banner_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id    INTEGER DEFAULT 1,           -- 1首页 2抢购页 ...
  file_path  TEXT DEFAULT '',
  link_url   TEXT DEFAULT '',
  sort       INTEGER DEFAULT 100,
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS shop_navigation (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       INTEGER DEFAULT 1,           -- 位置
  title      TEXT DEFAULT '',
  icon_name  TEXT DEFAULT '',
  file_path  TEXT DEFAULT '',
  link_url   TEXT DEFAULT '',
  sort       INTEGER DEFAULT 100,
  disabled   INTEGER DEFAULT 10,
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS notice (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT DEFAULT '',
  sort        INTEGER DEFAULT 100,
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS member_msg (
  msg_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER DEFAULT 0,           -- 0 为全体
  title      TEXT DEFAULT '',
  content    TEXT DEFAULT '',
  is_read    INTEGER DEFAULT 0,
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS circle (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL,
  content     TEXT DEFAULT '',
  images      TEXT DEFAULT '',
  create_time TEXT
);

CREATE TABLE IF NOT EXISTS score_goods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goods_id   INTEGER NOT NULL,
  score      INTEGER DEFAULT 0,
  stock      INTEGER DEFAULT 0,
  sort       INTEGER DEFAULT 100
);

-- ---------- 系统配置 ----------
CREATE TABLE IF NOT EXISTS setting_config (
  `key`      TEXT PRIMARY KEY,
  `value`    TEXT DEFAULT '',
  `group`    TEXT DEFAULT 'base',
  remark     TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS region (
  id    INTEGER PRIMARY KEY,
  pid   INTEGER DEFAULT 0,
  name  TEXT NOT NULL,
  level INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_region_pid ON region(pid);

-- ---------- 场次结算（差价匹配） ----------
-- 原站机制：场次结束后统计每人买入/卖出金额，做差价匹配，生成付款单线下转账
CREATE TABLE IF NOT EXISTS settle_batch (
  batch_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  specialarea_id INTEGER DEFAULT 0,
  batch_date     TEXT DEFAULT '',        -- 结算归属日期
  total_buy      REAL DEFAULT 0,         -- 全场买入合计
  total_sell     REAL DEFAULT 0,         -- 全场卖出合计
  total_fee      REAL DEFAULT 0,         -- 全场上架费合计
  member_count   INTEGER DEFAULT 0,
  status         INTEGER DEFAULT 0,      -- 0待结算 10已结算
  create_time    TEXT
);

-- 中账：每个会员一条结算账目
CREATE TABLE IF NOT EXISTS settle_account (
  account_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL,
  member_id      INTEGER NOT NULL,
  buy_amount     REAL DEFAULT 0,         -- 抢购金额（买入）
  consignment_amount REAL DEFAULT 0,     -- 寄卖金额（卖出）
  listing_fee_amount REAL DEFAULT 0,     -- 上架费
  listing_fee_percentage REAL DEFAULT 0, -- 上架费率
  coupon_reward  REAL DEFAULT 0,         -- 优惠券奖励
  balance        REAL DEFAULT 0,         -- 收支差额（正=应收，负=应付）
  buy_order_ids  TEXT DEFAULT '',        -- 买单ID列表
  sell_order_ids TEXT DEFAULT '',        -- 卖单ID列表
  create_time    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sa_batch ON settle_account(batch_id);

-- 小账：差价匹配后的付款单（线下转账 + 凭证确认）
CREATE TABLE IF NOT EXISTS settle_match (
  match_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL,
  payer_id       INTEGER NOT NULL,       -- 付款方
  payee_id       INTEGER NOT NULL,       -- 收款方
  amount         REAL DEFAULT 0,
  pay_status     INTEGER DEFAULT 0,      -- 0待付款 10待确认 20已完成
  voucher        TEXT DEFAULT '',        -- 付款凭证
  pay_time       TEXT DEFAULT '',
  confirm_time   TEXT DEFAULT '',
  remark         TEXT DEFAULT '',
  create_time    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sm_batch ON settle_match(batch_id);
CREATE INDEX IF NOT EXISTS idx_sm_payer ON settle_match(payer_id, pay_status);

-- ---------- 举报 ----------
CREATE TABLE IF NOT EXISTS order_report (
  report_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER DEFAULT 0,
  member_id   INTEGER NOT NULL,        -- 举报人
  target_id   INTEGER DEFAULT 0,       -- 被举报会员
  goods_id    INTEGER DEFAULT 0,
  reason      TEXT DEFAULT '',
  content     TEXT DEFAULT '',
  images      TEXT DEFAULT '',
  status      INTEGER DEFAULT 0,       -- 0待处理 10已处理 20已驳回
  result      TEXT DEFAULT '',
  create_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_status ON order_report(status);

-- ---------- 运费模板 ----------
CREATE TABLE IF NOT EXISTS delivery_template (
  template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT DEFAULT '',
  type        INTEGER DEFAULT 1,       -- 1按件 2按重量
  first_num   REAL DEFAULT 1,          -- 首件/首重
  first_price REAL DEFAULT 0,          -- 首费
  add_num     REAL DEFAULT 1,          -- 续件/续重
  add_price   REAL DEFAULT 0,          -- 续费
  free_area   TEXT DEFAULT '',         -- 包邮地区（逗号分隔）
  is_default  INTEGER DEFAULT 0,
  is_open     INTEGER DEFAULT 10,
  sort        INTEGER DEFAULT 100,
  create_time TEXT
);
