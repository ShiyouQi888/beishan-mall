import { Router } from 'express';
import { all, get, run, tx, now, today } from '../../db.js';
import { ok, fail, page, money, authAdmin, GOODS_STATUS, ORDER_STATUS, ORDER_TYPE } from '../../lib/helper.js';
import { hashPwd, verifyPwd, signAdmin, randomCode } from '../../lib/auth.js';
import { settleOrder } from '../../lib/settle.js';
import { runSettlement } from '../../lib/settlement.js';
import { splitGoods, scanStreambeat, releaseStreambeat, recycleStreambeat } from '../../lib/split.js';
import extraRouter from './extra.js';

const r = Router();
// 补充业务接口优先匹配，避免被通用 /:module/* 路由拦截
r.use(extraRouter);
const cfg = (k, d = '') => get('SELECT `value` FROM setting_config WHERE `key` = ?', k)?.value ?? d;

// ============================================================
// 模块注册表：驱动后台全部列表 / 表单
// ============================================================
const M = {
  goods: {
    table: 'goods', pk: 'goods_id', label: '抢购商品',
    search: ['goods_name', 'goods_no'],
    orderBy: 'goods_id DESC',
    fields: [
      { k: 'goods_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'good_thumb', t: '商品图片', type: 'image', w: 84 },
      { k: 'goods_name', t: '商品名称', type: 'text', w: 140 },
      { k: 'goods_no', t: '商品编码', type: 'text', w: 116, hide: true },
      { k: 'specialarea_id', t: '场次', type: 'select', opts: 'specialarea', w: 104 },
      { k: 'category_id', t: '分类', type: 'select', opts: 'category', w: 96 },
      { k: 'member_id', t: '现持有人', type: 'holder', w: 104 },
      { k: 'goods_min_price', t: '售卖价', type: 'money', w: 100 },
      { k: 'line_price', t: '划线价', type: 'money', w: 100, hide: true },
      { k: 'stock_num', t: '库存', type: 'number', w: 72 },
      { k: 'turn_beat_num', t: '转拍次数', type: 'number', w: 88, hide: true },
      { k: 'sales_actual', t: '销量', type: 'number', w: 72, hide: true },
      { k: 'goods_sort', t: '排序', type: 'number', w: 72, hide: true },
      { k: 'goods_status', t: '状态', type: 'select', opts: GOODS_STATUS, w: 84 },
      { k: 'detail', t: '商品详情', type: 'rich', hide: true },
      { k: 'images', t: '图集', type: 'images', hide: true },
      { k: 'create_time', t: '添加时间', type: 'text', readonly: true, w: 150, hide: true },
    ],
  },
  category: {
    table: 'goods_category', pk: 'category_id', label: '商品分类',
    search: ['name'], orderBy: 'sort ASC, category_id ASC',
    fields: [
      { k: 'category_id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'name', t: '分类名称', type: 'text', required: true },
      { k: 'image', t: '分类图', type: 'image', w: 90 },
      { k: 'type', t: '分类位置', type: 'select', opts: { 1: '商城', 2: '首页抢购' }, w: 110 },
      { k: 'sort', t: '排序', type: 'number', w: 90 },
      { k: 'create_time', t: '创建时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  specialarea: {
    table: 'specialarea', pk: 'specialarea_id', label: '抢购场次',
    search: ['title_main'], orderBy: 'sort ASC',
    fields: [
      { k: 'specialarea_id', t: 'ID', type: 'text', readonly: true, w: 60 },
      { k: 'name', t: '场次标识', type: 'text', w: 100, hide: true },
      { k: 'title_main', t: '主标题', type: 'text', required: true, w: 132 },
      { k: 'title_ordinary', t: '副标题', type: 'text', hide: true },
      { k: 'image_ordinary', t: '场次图', type: 'image', w: 80 },
      { k: 'start_time', t: '开始时间', type: 'timesec', w: 84 },
      { k: 'end_time', t: '结束时间', type: 'timesec', w: 84 },
      { k: 'open_days', t: '开启日期', type: 'days', w: 82 },
      { k: 'buy_num', t: '限购次数', type: 'number', w: 84 },
      { k: 'transposition_hours', t: '转拍时限(小时)', type: 'number', w: 96 },
      { k: 'is_subscribe', t: '开放预约', type: 'switch', opts: { 10: '是', 0: '否' }, w: 100 },
      { k: 'is_open', t: '启用', type: 'switch', opts: { 10: '启用', 20: '停用' }, w: 90 },
      { k: 'sort', t: '排序', type: 'number', w: 80 },
    ],
  },
  member: {
    table: 'member', pk: 'member_id', label: '会员',
    search: ['nick_name', 'mobile', 'invitation_code'], orderBy: 'member_id DESC',
    fields: [
      { k: 'member_id', t: '会员ID', type: 'text', readonly: true, w: 90 },
      { k: 'avatar_url', t: '头像', type: 'avatar', w: 70 },
      { k: 'nick_name', t: '昵称', type: 'text', w: 120 },
      { k: 'mobile', t: '手机号', type: 'text', w: 130 },
      { k: 'password', t: '登录密码', type: 'password', hide: true },
      { k: 'invitation_code', t: '邀请码', type: 'text', w: 100, hide: true, readonly: true },
      { k: 'identity_vip', t: '会员等级', type: 'vip', w: 100 },
      { k: 'is_valid', t: '会员身份', type: 'select', opts: { 10: '有效会员', 20: '无效会员' }, w: 110, hide: true },
      { k: 'is_certification', t: '实名', type: 'cert', w: 90, readonly: true },
      { k: 'amount', t: '账户余额', type: 'money', w: 110, readonly: true },
      { k: 'e_card_number', t: '佣金', type: 'money', w: 100, readonly: true },
      { k: 'rush_amount', t: '抢购金额', type: 'money', w: 110, hide: true, readonly: true },
      { k: 'fy_price', t: '礼券', type: 'money', w: 90, hide: true, readonly: true },
      { k: 'score', t: '积分', type: 'number', w: 80, readonly: true },
      { k: 'p_id', t: '上级', type: 'parent', w: 130 },
      { k: 'is_advance', t: '提前抢购', type: 'switch', opts: { 10: '已开通', 0: '未开通' }, w: 100, readonly: true },
      { k: 'disabled', t: '状态', type: 'switch', opts: { 10: '正常', 20: '禁用' }, w: 90 },
      { k: 'create_time', t: '注册时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  orders: {
    table: 'orders', pk: 'order_id', label: '订单',
    search: ['order_no', 'goods_name'], orderBy: 'order_id DESC',
    fields: [
      { k: 'order_id', t: '订单ID', type: 'text', readonly: true, w: 80 },
      { k: 'order_no', t: '订单号', type: 'text', readonly: true, w: 180 },
      { k: 'goods_thumb', t: '图片', type: 'image', w: 70 },
      { k: 'goods_name', t: '商品', type: 'text' },
      { k: 'type', t: '类型', type: 'select', opts: ORDER_TYPE, w: 110 },
      { k: 'price', t: '单价', type: 'money', w: 100, hide: true },
      { k: 'num', t: '数量', type: 'number', w: 70, hide: true },
      { k: 'total_price', t: '总额', type: 'money', w: 110 },
      { k: 'service_charge', t: '服务费', type: 'money', w: 90, hide: true },
      { k: 'status', t: '状态', type: 'select', opts: ORDER_STATUS, w: 100 },
      { k: 'pay_type', t: '支付方式', type: 'select', opts: { 0: '未支付', 1: '余额', 2: '微信', 3: '支付宝', 4: '线下凭证' }, w: 110 },
      { k: 'buyer', t: '买家', type: 'member', w: 110 },
      { k: 'seller_id', t: '卖家ID', type: 'text', w: 90, hide: true },
      { k: 'express_no', t: '快递单号', type: 'text', w: 140, hide: true },
      { k: 'create_time', t: '下单时间', type: 'text', readonly: true, w: 160 },
    ],
    actions: ['detail', 'deliver', 'audit', 'cancel'],
  },
  certification: {
    table: 'member_certification', pk: 'certification_id', label: '实名认证',
    search: ['real_name', 'idcard'], orderBy: 'certification_id DESC',
    fields: [
      { k: 'certification_id', t: 'ID', type: 'text', readonly: true, w: 80 },
      { k: 'member_id', t: '会员ID', type: 'member', w: 110 },
      { k: 'real_name', t: '姓名', type: 'text', w: 110 },
      { k: 'idcard', t: '身份证号', type: 'text', w: 180 },
      { k: 'front_image', t: '正面', type: 'image', w: 80 },
      { k: 'back_image', t: '反面', type: 'image', w: 80 },
      { k: 'status', t: '审核状态', type: 'select', opts: { 0: '待审核', 10: '已通过', 20: '已拒绝' }, w: 110 },
      { k: 'create_time', t: '提交时间', type: 'text', readonly: true, w: 160 },
    ],
    actions: ['audit'],
  },
  grade: {
    table: 'member_grade', pk: 'grade_id', label: '会员等级',
    search: ['name'], orderBy: 'grade_id ASC',
    fields: [
      { k: 'grade_id', t: '等级', type: 'text', readonly: true, w: 70 },
      { k: 'name', t: '等级名称', type: 'text', required: true },
      { k: 'drive_num', t: '直推人数', type: 'number', w: 100 },
      { k: 'team_valid', t: '团队有效人数', type: 'number', w: 120 },
      { k: 'team_water', t: '团队流水(万)', type: 'number', w: 120 },
      { k: 'team_award', t: '团队奖(%)', type: 'number', w: 110 },
    ],
  },
  report: {
    table: 'order_report', pk: 'report_id', label: '举报',
    search: ['reason', 'content'], orderBy: 'report_id DESC',
    fields: [
      { k: 'report_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'member_id', t: '举报人', type: 'member', w: 110 },
      { k: 'order_id', t: '订单ID', type: 'text', w: 84 },
      { k: 'goods_id', t: '商品ID', type: 'text', w: 84 },
      { k: 'reason', t: '举报原因', type: 'text', w: 140 },
      { k: 'content', t: '补充说明', type: 'text' },
      { k: 'images', t: '凭证', type: 'image', w: 80 },
      { k: 'status', t: '状态', type: 'select', opts: { 0: '待处理', 10: '已处理', 20: '已驳回' }, w: 96 },
      { k: 'result', t: '处理结果', type: 'text', w: 140, hide: true },
      { k: 'create_time', t: '提交时间', type: 'text', readonly: true, w: 150 },
    ],
    actions: ['audit'],
  },
  delivery: {
    table: 'delivery_template', pk: 'template_id', label: '运费模板',
    search: ['name'], orderBy: 'sort ASC, template_id ASC',
    fields: [
      { k: 'template_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'name', t: '模板名称', type: 'text', required: true, w: 150 },
      { k: 'type', t: '计费方式', type: 'select', opts: { 1: '按件', 2: '按重量' }, w: 100 },
      { k: 'first_num', t: '首件/首重', type: 'number', w: 110 },
      { k: 'first_price', t: '首费', type: 'money', w: 90 },
      { k: 'add_num', t: '续件/续重', type: 'number', w: 110 },
      { k: 'add_price', t: '续费', type: 'money', w: 90 },
      { k: 'free_area', t: '包邮地区', type: 'text', hide: true },
      { k: 'is_open', t: '启用', type: 'switch', opts: { 10: '启用', 20: '停用' }, w: 86 },
      { k: 'sort', t: '排序', type: 'number', w: 76 },
      { k: 'create_time', t: '创建时间', type: 'text', readonly: true, w: 150, hide: true },
    ],
  },
  energy: {
    table: 'finance_energy', pk: 'energy_id', label: '佣金记录',
    search: ['remarks'], orderBy: 'energy_id DESC',
    fields: [
      { k: 'energy_id', t: 'ID', type: 'text', readonly: true, w: 80 },
      { k: 'member_id', t: '会员', type: 'member', w: 120 },
      { k: 'face_value', t: '变更数量', type: 'money', w: 110 },
      { k: 'type', t: '变更类型', type: 'select', opts: { 1: '系统充值', 2: '余额', 3: '返佣', 4: '礼券' }, w: 100 },
      { k: 'type_name', t: '类型说明', type: 'text', w: 120 },
      { k: 'remarks', t: '备注', type: 'text' },
      { k: 'create_time', t: '时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  withdraw: {
    table: 'finance_withdraw', pk: 'withdraw_id', label: '提现审核',
    search: [], orderBy: 'withdraw_id DESC',
    fields: [
      { k: 'withdraw_id', t: 'ID', type: 'text', readonly: true, w: 80 },
      { k: 'member_id', t: '会员', type: 'member', w: 120 },
      { k: 'amount', t: '申请金额', type: 'money', w: 110 },
      { k: 'fee', t: '手续费', type: 'money', w: 90 },
      { k: 'actual_amount', t: '实际到账', type: 'money', w: 110 },
      { k: 'account_info', t: '收款账户', type: 'text' },
      { k: 'status', t: '状态', type: 'select', opts: { 0: '待审核', 10: '已通过', 20: '已拒绝' }, w: 100 },
      { k: 'create_time', t: '申请时间', type: 'text', readonly: true, w: 160 },
    ],
    actions: ['audit'],
  },
  settle: {
    table: 'settle_pay', pk: 'id', label: '结算账目',
    search: ['order_no'], orderBy: 'id DESC',
    fields: [
      { k: 'id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'kind', t: '账目', type: 'select', opts: { large: '大帐-结算', medium: '中账-差额', small: '小账-凭证' }, w: 120 },
      { k: 'order_no', t: '订单号', type: 'text', w: 170 },
      { k: 'member_id', t: '付款方', type: 'member', w: 110 },
      { k: 'b_member_id', t: '收款方', type: 'member', w: 110 },
      { k: 'buy_amount', t: '抢购金额', type: 'money', w: 100 },
      { k: 'consignment_amount', t: '寄卖金额', type: 'money', w: 100, hide: true },
      { k: 'listing_fee_amount', t: '上架费', type: 'money', w: 90, hide: true },
      { k: 'balance', t: '收支金额', type: 'money', w: 110 },
      { k: 'pay_status', t: '状态', type: 'select', opts: { 0: '待确认', 10: '已确认' }, w: 90 },
      { k: 'create_time', t: '时间', type: 'text', readonly: true, w: 160 },
    ],
    actions: ['confirm'],
  },
  banner: {
    table: 'shop_banner', pk: 'banner_id', label: '广告管理',
    search: [], orderBy: 'sort ASC, banner_id DESC',
    fields: [
      { k: 'banner_id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'type_id', t: '展示位置', type: 'select', opts: { 1: '首页顶部', 2: '抢购页', 3: '个人中心' }, w: 120 },
      { k: 'file_path', t: '轮播图', type: 'image', w: 200 },
      { k: 'link_url', t: '跳转链接', type: 'text' },
      { k: 'sort', t: '排序', type: 'number', w: 80 },
      { k: 'create_time', t: '添加时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  navigation: {
    table: 'shop_navigation', pk: 'id', label: '菜单配置',
    search: ['title'], orderBy: 'sort ASC, id ASC',
    fields: [
      { k: 'id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'title', t: '导航标题', type: 'text', required: true, w: 120 },
      { k: 'icon_name', t: '图标名', type: 'text', w: 100 },
      { k: 'file_path', t: '缩略图', type: 'image', w: 90 },
      { k: 'link_url', t: '跳转链接', type: 'text' },
      { k: 'type', t: '位置', type: 'select', opts: { 1: '首页宫格', 2: '抢购页' }, w: 110 },
      { k: 'sort', t: '排序', type: 'number', w: 80 },
      { k: 'disabled', t: '显示', type: 'switch', opts: { 10: '显示', 20: '隐藏' }, w: 90 },
    ],
  },
  notice: {
    table: 'notice', pk: 'id', label: '公告管理',
    search: ['title'], orderBy: 'sort ASC, id DESC',
    fields: [
      { k: 'id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'title', t: '标题', type: 'text', required: true },
      { k: 'content', t: '内容', type: 'rich', hide: true },
      { k: 'sort', t: '排序', type: 'number', w: 80 },
      { k: 'create_time', t: '添加时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  recharge: {
    table: 'recharge_package', pk: 'recharge_id', label: '充值套餐',
    search: [], orderBy: 'sort ASC',
    fields: [
      { k: 'recharge_id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'face_value', t: '面值', type: 'money', required: true, w: 100 },
      { k: 'price', t: '售价', type: 'money', required: true, w: 100 },
      { k: 'integral', t: '赠送积分', type: 'number', w: 100 },
      { k: 'is_open', t: '启用', type: 'switch', opts: { 10: '启用', 20: '停用' }, w: 90 },
      { k: 'sort', t: '排序', type: 'number', w: 80 },
    ],
  },
  storeuser: {
    table: 'store_user', pk: 'store_user_id', label: '管理员',
    search: ['user_name', 'nick_name'], orderBy: 'store_user_id DESC',
    fields: [
      { k: 'store_user_id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'user_name', t: '登录账号', type: 'text', required: true, w: 130 },
      { k: 'password', t: '登录密码', type: 'password', hide: true },
      { k: 'nick_name', t: '昵称', type: 'text', w: 120 },
      { k: 'role_id', t: '角色', type: 'select', opts: 'role', w: 110 },
      { k: 'status', t: '状态', type: 'switch', opts: { 10: '正常', 20: '停用' }, w: 90 },
      { k: 'last_login_time', t: '最后登录', type: 'text', readonly: true, w: 160 },
      { k: 'create_time', t: '创建时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  role: {
    table: 'store_role', pk: 'role_id', label: '角色',
    search: ['role_name'], orderBy: 'role_id ASC',
    fields: [
      { k: 'role_id', t: 'ID', type: 'text', readonly: true, w: 70 },
      { k: 'role_name', t: '角色名称', type: 'text', required: true },
      { k: 'description', t: '说明', type: 'text' },
      { k: 'create_time', t: '创建时间', type: 'text', readonly: true, w: 160 },
    ],
  },
};

// ---------------- 登录 ----------------
r.post('/login', (req, res) => {
  const { user_name, password } = req.body;
  if (!user_name || !password) return res.json(fail('请输入账号和密码'));
  const u = get('SELECT * FROM store_user WHERE user_name = ?', user_name);
  if (!u) return res.json(fail('账号不存在'));
  if (u.status !== 10) return res.json(fail('账号已停用'));
  if (!verifyPwd(password, u.password)) return res.json(fail('密码错误'));
  run('UPDATE store_user SET last_login_time = ? WHERE store_user_id = ?', now(), u.store_user_id);
  res.json(ok({ token: signAdmin(u.store_user_id), user: { id: u.store_user_id, name: u.user_name, nick: u.nick_name, role_id: u.role_id } }, '登录成功'));
});

r.get('/me', authAdmin, (req, res) => {
  const u = req.admin;
  res.json(ok({ id: u.store_user_id, name: u.user_name, nick: u.nick_name, role_id: u.role_id, avatar: u.avatar }));
});

// ---------------- 控制面板 ----------------
r.get('/dashboard', authAdmin, (req, res) => {
  const d = today();
  const num = (sql, ...p) => get(sql, ...p)?.c || 0;
  const sum = (sql, ...p) => get(sql, ...p)?.v || 0;

  res.json(
    ok({
      cards: [
        { key: 'wait_send', label: '待发货订单', value: num("SELECT COUNT(*) c FROM orders WHERE status = 10"), route: 'orders' },
        { key: 'wait_receive', label: '待收货订单', value: num("SELECT COUNT(*) c FROM orders WHERE status = 20"), route: 'orders' },
        { key: 'wait_withdraw', label: '待提现审核', value: num("SELECT COUNT(*) c FROM finance_withdraw WHERE status = 0"), route: 'withdraw' },
        { key: 'wait_cert', label: '待实名审核', value: num("SELECT COUNT(*) c FROM member_certification WHERE status = 0"), route: 'certification' },
      ],
      overview: {
        member_total: num('SELECT COUNT(*) c FROM member'),
        member_today: num('SELECT COUNT(*) c FROM member WHERE create_time >= ?', d),
        goods_total: num('SELECT COUNT(*) c FROM goods WHERE type = 1'),
        goods_online: num("SELECT COUNT(*) c FROM goods WHERE type = 1 AND goods_status = 10"),
        order_total: num('SELECT COUNT(*) c FROM orders'),
        order_today: num('SELECT COUNT(*) c FROM orders WHERE create_time >= ?', d),
        turnover_total: money(sum("SELECT IFNULL(SUM(total_price),0) v FROM orders WHERE pay_status = 10")),
        turnover_today: money(sum('SELECT IFNULL(SUM(total_price),0) v FROM orders WHERE pay_status = 10 AND create_time >= ?', d)),
        amount_total: money(sum("SELECT IFNULL(SUM(amount),0) v FROM member")),
        commission_total: money(sum("SELECT IFNULL(SUM(e_card_number),0) v FROM member")),
      },
      trend: buildTrend(),
      recent_orders: all('SELECT * FROM orders ORDER BY order_id DESC LIMIT 6').map((o) => ({
        order_id: o.order_id,
        order_no: o.order_no,
        goods_name: o.goods_name,
        total_price: Number(o.total_price).toFixed(2),
        status_text: ORDER_STATUS[o.status] || '',
        create_time: o.create_time,
      })),
      recent_members: all('SELECT member_id, nick_name, mobile, create_time FROM member ORDER BY member_id DESC LIMIT 6'),
    }),
  );
});

function buildTrend() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const orders = get('SELECT COUNT(*) c, IFNULL(SUM(total_price),0) v FROM orders WHERE create_time >= ? AND create_time < ?', d, d + ' 23:59:59');
    const members = get('SELECT COUNT(*) c FROM member WHERE create_time >= ? AND create_time < ?', d, d + ' 23:59:59');
    days.push({ date: d.slice(5), orders: orders.c, amount: money(orders.v), members: members.c });
  }
  return days;
}

// ---------------- 模块元信息 ----------------
r.get('/modules', authAdmin, (req, res) => {
  res.json(
    ok(
      Object.entries(M).map(([k, v]) => ({
        key: k,
        label: v.label,
        pk: v.pk,
        fields: v.fields,
        actions: v.actions || [],
      })),
    ),
  );
});

/** 下拉选项数据 */
function options(name) {
  if (name === 'specialarea') return all('SELECT specialarea_id id, title_main name FROM specialarea ORDER BY sort');
  if (name === 'category') return all('SELECT category_id id, name FROM goods_category ORDER BY sort');
  if (name === 'role') return all('SELECT role_id id, role_name name FROM store_role ORDER BY role_id');
  return [];
}

r.get('/options/:name', authAdmin, (req, res) => res.json(ok(options(req.params.name))));

// ---------------- 系统设置 ----------------
const SETTING_GROUPS = {
  store: [
    { k: 'store_name', t: '商城名称', type: 'text' },
    { k: 'store_logo', t: '商城Logo', type: 'image' },
    { k: 'store_mobile', t: '联系电话', type: 'text' },
    { k: 'copyright', t: '版权信息', type: 'text' },
    { k: 'icp_number', t: 'ICP备案号', type: 'text' },
    { k: 'customer_service', t: '客服二维码', type: 'image' },
    { k: 'customer_link', t: '客服链接', type: 'text' },
    { k: 'region_bg_img', t: '首页背景图', type: 'image' },
  ],
  trade: [
    { k: 'service_charge', t: '抢单服务费(%)', type: 'number', tip: '买家在商品金额之外额外支付；填 0 则不收（平台收入来自转拍上架费）' },
    { k: 'require_receiving_account', t: '抢购前必须绑定收款账户', type: 'switch', tip: '关闭时允许未绑定收款账户的会员直接下单；开启后，会员需先设置收款方式。默认关闭。' },
    { k: 'require_invite_code', t: '注册必须填邀请码', type: 'switch', tip: '开启：必须有有效邀请码才能入驻，注册后自动绑定上级。关闭：邀请码可留空直接注册（无上级、不产生直推奖），填了仍会校验有效性。默认开启。' },
    { k: 'price_increase_rate', t: '转拍涨价率(%)', type: 'number', tip: '每转拍一次，在上一手成交价基础上自动加价该比例，逐轮复利：10000 → 10300 → 10609。下一轮买家付 10300 时，上一手持有人收回 10300 全额（原价 + 涨价），此后与该持有人无关。注意：涨价率需高于上架费率才有净收益。' },
    { k: 'listing_fee_rate', t: '转拍上架费(%)', type: 'number' },
    { k: 'drive_award_rate', t: '直推奖(%)', type: 'number' },
    { k: 'consignment_open', t: '转拍开关', type: 'switch' },
    { k: 'consignment_rule', t: '转拍规则说明', type: 'textarea' },
    { k: 'withdraw_min', t: '最低提现金额', type: 'number' },
    { k: 'withdraw_fee', t: '提现手续费(%)', type: 'number' },
  ],
  pay: [
    { k: 'pay_wx', t: '微信支付', type: 'switch' },
    { k: 'pay_zfb', t: '支付宝', type: 'switch' },
    { k: 'pay_bank', t: '银行卡转账', type: 'switch' },
    { k: 'pay_gateway_open', t: '在线支付通道', type: 'switch' },
    { k: 'zfb_qr', t: '支付宝收款码', type: 'image' },
    { k: 'wx_qr', t: '微信收款码', type: 'image' },
  ],
  auction: [
    { k: 'auction_open', t: '竞拍开关', type: 'switch' },
    { k: 'auction_start_price', t: '起拍价比例(%)', type: 'number' },
    { k: 'auction_step', t: '加价幅度', type: 'number' },
  ],
  storage: [
    { k: 'storage_type', t: '存储方式', type: 'text' },
    { k: 'storage_domain', t: '访问域名', type: 'text' },
    { k: 'storage_access_key', t: 'AccessKey', type: 'text' },
    { k: 'storage_secret_key', t: 'SecretKey', type: 'text' },
    { k: 'storage_bucket', t: 'Bucket', type: 'text' },
    { k: 'storage_max_size', t: '单文件上限(MB)', type: 'number' },
    { k: 'storage_ext', t: '允许的扩展名', type: 'text' },
  ],
  poster: [
    { k: 'poster_bg', t: '海报底图', type: 'image' },
    { k: 'poster_logo', t: '海报 Logo', type: 'image' },
    { k: 'poster_qr_x', t: '二维码 X 坐标', type: 'number' },
    { k: 'poster_qr_y', t: '二维码 Y 坐标', type: 'number' },
    { k: 'poster_qr_size', t: '二维码尺寸', type: 'number' },
    { k: 'poster_logo_x', t: 'Logo X 坐标', type: 'number' },
    { k: 'poster_logo_y', t: 'Logo Y 坐标', type: 'number' },
    { k: 'poster_logo_size', t: 'Logo 尺寸', type: 'number' },
    { k: 'poster_title', t: '海报主标题', type: 'text' },
    { k: 'poster_title_x', t: '主标题 X 坐标', type: 'number' },
    { k: 'poster_title_y', t: '主标题 Y 坐标', type: 'number' },
    { k: 'poster_title_size', t: '主标题字号', type: 'number' },
    { k: 'poster_subtitle', t: '海报副标题', type: 'text' },
    { k: 'poster_subtitle_x', t: '副标题 X 坐标', type: 'number' },
    { k: 'poster_subtitle_y', t: '副标题 Y 坐标', type: 'number' },
    { k: 'poster_subtitle_size', t: '副标题字号', type: 'number' },
    { k: 'poster_content', t: '海报说明文字', type: 'textarea' },
    { k: 'poster_content_x', t: '说明文字 X 坐标', type: 'number' },
    { k: 'poster_content_y', t: '说明文字 Y 坐标', type: 'number' },
    { k: 'poster_content_size', t: '说明文字字号', type: 'number' },
    { k: 'poster_code_x', t: '邀请码 X 坐标', type: 'number' },
    { k: 'poster_code_y', t: '邀请码 Y 坐标', type: 'number' },
    { k: 'poster_code_size', t: '邀请码字号', type: 'number' },
  ],
  prompt: [
    { k: 'prompt_register', t: '注册协议', type: 'richtext' },
    { k: 'prompt_privacy', t: '隐私政策', type: 'richtext' },
    { k: 'prompt_invite', t: '邀请须知', type: 'richtext' },
    { k: 'prompt_shop', t: '商城协议', type: 'richtext' },
    { k: 'prompt_trade', t: '交易协议', type: 'richtext' },
    { k: 'prompt_loot', t: '抢购须知', type: 'richtext' },
    { k: 'prompt_consign', t: '转拍须知', type: 'richtext' },
    { k: 'prompt_withdraw', t: '提现须知', type: 'richtext' },
  ],
  nav: [
    { k: 'nav_index', t: '首页显示', type: 'switch' },
    { k: 'nav_category', t: '分类显示', type: 'switch' },
    { k: 'nav_invite', t: '邀请好友显示', type: 'switch' },
    { k: 'nav_loot', t: '抢购显示', type: 'switch' },
    { k: 'nav_member', t: '我的显示', type: 'switch' },
    { k: 'subscribe_open', t: '预约功能', type: 'switch' },
    { k: 'subscribe_e_card', t: '预约奖励佣金', type: 'number' },
  ],
};

r.get('/setting/:group', authAdmin, (req, res) => {
  const g = Object.prototype.hasOwnProperty.call(SETTING_GROUPS, req.params.group) ? SETTING_GROUPS[req.params.group] : null;
  if (!g) return res.json(fail('设置组不存在'));
  res.json(ok({ group: req.params.group, items: g, values: Object.fromEntries(g.map((x) => [x.k, cfg(x.k, '')])) }));
});

r.post('/setting/save', authAdmin, (req, res) => {
  const { group, values } = req.body || {};
  const fields = Object.prototype.hasOwnProperty.call(SETTING_GROUPS, group) ? SETTING_GROUPS[group] : null;
  if (!fields || !values || typeof values !== 'object' || Array.isArray(values)) return res.json(fail('参数错误'));
  const allowed = new Set(fields.map((x) => x.k));
  const keys = Object.keys(values);
  if (!keys.length || keys.some((k) => !allowed.has(k))) return res.json(fail('设置项不属于当前设置分组'));
  tx(() => {
  for (const [k, v] of Object.entries(values)) {
    const exist = get('SELECT 1 FROM setting_config WHERE `key` = ?', k);
    if (exist) run('UPDATE setting_config SET `value` = ? WHERE `key` = ?', String(v ?? ''), k);
    else run('INSERT INTO setting_config (`key`, `value`, `group`) VALUES (?,?,?)', k, String(v ?? ''), group);
  }
  });
  res.json(ok([], '保存成功'));
});


// ---------------- 场次结算（差价匹配） ----------------
r.post('/settle/run', authAdmin, (req, res) => {
  const { specialarea_id = 0, date = '' } = req.body || {};
  const out = runSettlement(Number(specialarea_id), date);
  if (!out.ok) return res.json(fail(out.reason));
  res.json(ok(out, '结算完成'));
});

r.get('/settle/batches', authAdmin, (req, res) => {
  const list = all('SELECT * FROM settle_batch ORDER BY batch_id DESC LIMIT 50');
  res.json(ok(list.map((b) => ({
    ...b,
    area_name: b.specialarea_id
      ? get('SELECT title_main n FROM specialarea WHERE specialarea_id = ?', b.specialarea_id)?.n || ''
      : '全部场次',
  }))));
});

r.get('/settle/accounts', authAdmin, (req, res) => {
  const bid = Number(req.query.batch_id);
  const rows = all(
    `SELECT sa.*, m.nick_name, m.mobile FROM settle_account sa
     LEFT JOIN member m ON m.member_id = sa.member_id
     WHERE sa.batch_id = ? ORDER BY ABS(sa.balance) DESC`,
    bid,
  );
  res.json(ok(rows));
});

r.get('/settle/matches', authAdmin, (req, res) => {
  const bid = Number(req.query.batch_id);
  const rows = all(
    `SELECT sm.*,
       pm.nick_name payer_name, pm.mobile payer_mobile,
       qm.nick_name payee_name, qm.mobile payee_mobile
     FROM settle_match sm
     LEFT JOIN member pm ON pm.member_id = sm.payer_id
     LEFT JOIN member qm ON qm.member_id = sm.payee_id
     WHERE sm.batch_id = ? ORDER BY sm.match_id`,
    bid,
  );
  res.json(ok(rows));
});

r.post('/settle/confirm-match', authAdmin, (req, res) => {
  const { match_id, pass } = req.body || {};
  const m = get('SELECT * FROM settle_match WHERE match_id = ?', Number(match_id));
  if (!m) return res.json(fail('记录不存在'));
  if (m.pay_status === 20) return res.json(fail('该笔已完成'));
  run('UPDATE settle_match SET pay_status = ?, confirm_time = ? WHERE match_id = ?',
    pass ? 20 : 10, now(), m.match_id);
  res.json(ok([], pass ? '已确认收款' : '已标记待确认'));
});


// ---------------- 拆分 & 流拍 ----------------
r.post('/goods/split', authAdmin, (req, res) => {
  const { goods_id, parts } = req.body || {};
  const out = splitGoods(goods_id, parts, 0);
  if (!out.ok) return res.json(fail(out.reason));
  res.json(ok(out, `已拆分为 ${out.parts} 份，每份 ¥${out.per_part.toFixed(2)}`));
});

r.post('/streambeat/scan', authAdmin, (req, res) => {
  const { specialarea_id = 0, date = '' } = req.body || {};
  const out = scanStreambeat(Number(specialarea_id), date);
  res.json(ok(out, out.count ? `扫描完成，${out.count} 件商品流拍` : '没有需要标记流拍的商品'));
});

r.post('/streambeat/release', authAdmin, (req, res) => {
  const out = releaseStreambeat(req.body?.order_id);
  if (!out.ok) return res.json(fail(out.reason));
  res.json(ok(out, '已释放，商品恢复可售'));
});

// 平台回收：按当前挂牌价把流拍商品收归平台，给持有人打款
r.post('/streambeat/recycle', authAdmin, (req, res) => {
  const out = recycleStreambeat(req.body?.order_id);
  if (!out.ok) return res.json(fail(out.reason));
  res.json(ok(out, `已按挂牌价 ¥${Number(out.price).toFixed(2)} 回收，商品转平台持仓`));
});

// ---------------- 通用列表 ----------------
r.get('/:module/list', authAdmin, (req, res) => {
  const mod = M[req.params.module];
  if (!mod) return res.json(fail('模块不存在'));
  const p = Math.max(1, Number(req.query.page) || 1);
  const pp = Math.min(100, Number(req.query.limit) || 15);
  const where = [];
  const args = [];

  if (req.query.keyword && mod.search.length) {
    where.push('(' + mod.search.map((f) => `${f} LIKE ?`).join(' OR ') + ')');
    mod.search.forEach(() => args.push(`%${req.query.keyword}%`));
  }
  // 通用筛选：字段名直接作为 query key
  for (const f of mod.fields) {
    const v = req.query[f.k];
    if (v !== undefined && v !== '' && ['text', 'select', 'switch', 'money', 'number'].includes(f.type)) {
      where.push(`${f.k} = ?`);
      args.push(v);
    }
  }
  // 订单额外筛选
  if (req.params.module === 'orders') {
    if (req.query.type) {
      where.push('type = ?');
      args.push(Number(req.query.type));
    }
    if (req.query.status !== undefined && req.query.status !== '') {
      where.push('status = ?');
      args.push(Number(req.query.status));
    }
  }
  if (req.params.module === 'goods' && req.query.type) {
    where.push('type = ?');
    args.push(Number(req.query.type));
  }
  if (req.params.module === 'settle' && req.query.kind) {
    where.push('kind = ?');
    args.push(req.query.kind);
  }

  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = get(`SELECT COUNT(*) c FROM ${mod.table} ${w}`, ...args)?.c || 0;
  const rows = all(`SELECT * FROM ${mod.table} ${w} ORDER BY ${mod.orderBy} LIMIT ? OFFSET ?`, ...args, pp, (p - 1) * pp);

  res.json(ok({ ...page(rows.map((x) => safeAdminRow(req.params.module, enrich(req.params.module, x))), total, p, pp), module: mod }));
});

/** 后台列表/详情不返回认证凭证、支付口令或会员收款配置。 */
function safeAdminRow(module, row) {
  const out = { ...row };
  for (const key of ['password', 'pay_password', 'pay_setting', 'open_id']) delete out[key];
  if (module === 'member') {
    for (const key of ['idcard', 'sign_image', 'child_id', 'path', 'client_type',
      'personal_income', 'total_amount', 'distribution_amount', 'team_water', 'advance_time']) delete out[key];
  }
  return out;
}

/** 列表数据补充（关联展示字段） */
function enrich(mod, row) {
  const out = { ...row };
  if (mod === 'goods' || mod === 'orders') {
    const holder = row.member_id
      ? get('SELECT nick_name, mobile FROM member WHERE member_id = ?', row.member_id)
      : null;
    out._holder = holder?.nick_name || '';
    out._holder_mobile = holder?.mobile || '';
  }
  if (mod === 'goods') {
    out._category = row.category_id
      ? get('SELECT name FROM goods_category WHERE category_id = ?', row.category_id)?.name || ''
      : '';
    out._area = row.specialarea_id
      ? get('SELECT title_main FROM specialarea WHERE specialarea_id = ?', row.specialarea_id)?.title_main || ''
      : '';
  }
  if (mod === 'orders') {
    const b = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', row.member_id);
    out._buyer = b?.nick_name || '';
    out._buyer_mobile = b?.mobile || '';
    if (row.seller_id) out._seller = get('SELECT nick_name FROM member WHERE member_id = ?', row.seller_id)?.nick_name || '';
  }
  if (mod === 'member') {
    out._parent = row.p_id ? get('SELECT nick_name FROM member WHERE member_id = ?', row.p_id)?.nick_name || '' : '';
  }
  if (mod === 'energy' || mod === 'withdraw' || mod === 'settle') {
    out._member = get('SELECT nick_name FROM member WHERE member_id = ?', row.member_id)?.nick_name || '';
    if (row.b_member_id) out._bmember = get('SELECT nick_name FROM member WHERE member_id = ?', row.b_member_id)?.nick_name || '';
  }
  if (mod === 'certification') {
    out._member = get('SELECT nick_name FROM member WHERE member_id = ?', row.member_id)?.nick_name || '';
  }
  if (mod === 'report') {
    out._member = get('SELECT nick_name FROM member WHERE member_id = ?', row.member_id)?.nick_name || '';
    if (row.target_id) {
      out._target = get('SELECT nick_name FROM member WHERE member_id = ?', row.target_id)?.nick_name || '';
    }
  }
  return out;
}

r.get('/:module/detail', authAdmin, (req, res) => {
  const mod = M[req.params.module];
  if (!mod) return res.json(fail('模块不存在'));
  const row = get(`SELECT * FROM ${mod.table} WHERE ${mod.pk} = ?`, req.query.id);
  if (!row) return res.json(fail('记录不存在'));
  res.json(ok(safeAdminRow(req.params.module, enrich(req.params.module, row))));
});

// ---------------- 通用保存 ----------------
r.post('/:module/save', authAdmin, (req, res) => {
  const mod = M[req.params.module];
  if (!mod) return res.json(fail('模块不存在'));
  if (req.params.module === 'orders') return res.json(fail('订单请通过审核、发货等专用操作修改'));
  const body = req.body || {};
  const keys = mod.fields
    .filter((f) => !f.readonly)
    .map((f) => f.k)
    .filter((k) => k in body && !['create_time'].includes(k));
  if (!keys.length) return res.json(fail('没有可保存的字段'));

  const id = body[mod.pk];
  if (id) {
    const updateKeys = keys.filter((k) => k !== mod.pk && !(k === 'password' && !body[k])
      && !(mod.table === 'member' && k === 'p_id'));
    const currentMember = mod.table === 'member' ? get('SELECT * FROM member WHERE member_id = ?', Number(id)) : null;
    let nextMemberParent = null;
    if (mod.table === 'member') {
      if (!currentMember) return res.json(fail('会员不存在'));
      if (body.mobile && !/^1\d{10}$/.test(String(body.mobile))) return res.json(fail('手机号格式不正确'));
      if (body.mobile && get('SELECT 1 FROM member WHERE mobile = ? AND member_id <> ?', String(body.mobile), Number(id))) {
        return res.json(fail('手机号已存在'));
      }
      if (body.password && String(body.password).length < 6) return res.json(fail('密码至少 6 位'));
      if ('p_id' in body) {
        const parentId = Number(body.p_id) || 0;
        nextMemberParent = parentId ? get('SELECT * FROM member WHERE member_id = ?', parentId) : null;
        if (parentId && !nextMemberParent) return res.json(fail('上级会员不存在'));
        const oldRoot = `${currentMember.path || '/'}${currentMember.member_id}/`;
        if (parentId === Number(id) || (nextMemberParent && String(nextMemberParent.path || '').startsWith(oldRoot))) {
          return res.json(fail('不能将会员调整到自己的团队下'));
        }
      }
    }
    if (mod.table === 'store_user') {
      if (body.user_name && get('SELECT 1 FROM store_user WHERE user_name = ? AND store_user_id <> ?', body.user_name, Number(id))) {
        return res.json(fail('登录账号已存在'));
      }
      if (body.role_id && !get('SELECT 1 FROM store_role WHERE role_id = ?', Number(body.role_id))) return res.json(fail('所选角色不存在'));
      if (body.password && String(body.password).length < 6) return res.json(fail('密码至少 6 位'));
    }
    const sets = updateKeys.map((k) => `${k} = ?`);
    const vals = updateKeys.map((k) => k === 'password' ? hashPwd(body[k]) : body[k]);
    const parentChange = mod.table === 'member' && 'p_id' in body
      && Number(body.p_id || 0) !== Number(currentMember.p_id || 0);
    if (!sets.length && !parentChange) return res.json(fail('没有可更新的字段'));
    tx(() => {
      if (sets.length) run(`UPDATE ${mod.table} SET ${sets.join(', ')} WHERE ${mod.pk} = ?`, ...vals, id);
      if (mod.table === 'member' && nextMemberParent && Number(nextMemberParent.member_id) !== Number(currentMember.p_id || 0)) {
        const oldRoot = `${currentMember.path || '/'}${currentMember.member_id}/`;
        const nextPath = `${nextMemberParent.path || '/'}${nextMemberParent.member_id}/`;
        const nextRoot = `${nextPath}${currentMember.member_id}/`;
        const nextLevel = Number(nextMemberParent.level || 1) + 1;
        const descendants = all('SELECT member_id, path, level FROM member WHERE path LIKE ?', `${oldRoot}%`);
        run('UPDATE member SET p_id = ?, path = ?, level = ? WHERE member_id = ?', nextMemberParent.member_id, nextPath, nextLevel, Number(id));
        const delta = nextLevel - Number(currentMember.level || 1);
        for (const child of descendants) {
          run('UPDATE member SET path = ?, level = ? WHERE member_id = ?',
            `${nextRoot}${child.path.slice(oldRoot.length)}`, Number(child.level || 1) + delta, child.member_id);
        }
        if (currentMember.p_id) {
          const oldParent = get('SELECT child_id FROM member WHERE member_id = ?', Number(currentMember.p_id));
          const remaining = (oldParent?.child_id || '').split(',').filter((x) => x && Number(x) !== Number(id));
          run('UPDATE member SET child_id = ? WHERE member_id = ?', remaining.join(','), Number(currentMember.p_id));
        }
        const childIds = (nextMemberParent.child_id || '').split(',').filter(Boolean);
        if (!childIds.includes(String(id))) childIds.push(String(id));
        run('UPDATE member SET child_id = ? WHERE member_id = ?', childIds.join(','), nextMemberParent.member_id);
      } else if (mod.table === 'member' && 'p_id' in body && Number(body.p_id || 0) === 0 && Number(currentMember.p_id || 0) !== 0) {
        const oldRoot = `${currentMember.path || '/'}${currentMember.member_id}/`;
        const descendants = all('SELECT member_id, path, level FROM member WHERE path LIKE ?', `${oldRoot}%`);
        run("UPDATE member SET p_id = 0, path = '/', level = 1 WHERE member_id = ?", Number(id));
        const delta = 1 - Number(currentMember.level || 1);
        for (const child of descendants) {
          run('UPDATE member SET path = ?, level = ? WHERE member_id = ?',
            `/${currentMember.member_id}/${child.path.slice(oldRoot.length)}`, Number(child.level || 1) + delta, child.member_id);
        }
        const oldParent = get('SELECT child_id FROM member WHERE member_id = ?', Number(currentMember.p_id));
        const remaining = (oldParent?.child_id || '').split(',').filter((x) => x && Number(x) !== Number(id));
        run('UPDATE member SET child_id = ? WHERE member_id = ?', remaining.join(','), Number(currentMember.p_id));
      }
    });
    return res.json(ok({ id }, '修改成功'));
  }
  // 新增
  let ins = keys;
  let vals = keys.map((k) => body[k]);
  if (mod.table === 'store_user') {
    if (!body.password || String(body.password).length < 6) return res.json(fail('请设置至少 6 位登录密码'));
    if (!body.user_name || !body.role_id) return res.json(fail('请填写登录账号并选择角色'));
    if (get('SELECT 1 FROM store_user WHERE user_name = ?', body.user_name)) return res.json(fail('登录账号已存在'));
    if (!get('SELECT 1 FROM store_role WHERE role_id = ?', Number(body.role_id))) return res.json(fail('所选角色不存在'));
    ins = [...keys.filter((k) => k !== 'password'), 'password', 'create_time'];
    vals = [...keys.filter((k) => k !== 'password').map((k) => body[k]), hashPwd(body.password), now()];
  } else if (mod.table === 'member') {
    if (!body.mobile) return res.json(fail('请填写手机号'));
    if (get('SELECT 1 FROM member WHERE mobile = ?', body.mobile)) return res.json(fail('手机号已存在'));
    if (!/^1\d{10}$/.test(String(body.mobile))) return res.json(fail('手机号格式不正确'));
    if (!body.password || String(body.password).length < 6) return res.json(fail('请设置至少 6 位登录密码'));
    const parent = Number(body.p_id) ? get('SELECT * FROM member WHERE member_id = ?', Number(body.p_id)) : null;
    if (Number(body.p_id) && !parent) return res.json(fail('上级会员不存在'));
    const makeCode = () => {
      let code = randomCode(6);
      while (get('SELECT 1 FROM member WHERE invitation_code = ?', code)) code = randomCode(6);
      return code;
    };
    const code = body.invitation_code || makeCode();
    if (get('SELECT 1 FROM member WHERE invitation_code = ?', code)) return res.json(fail('邀请码已存在'));
    const permittedMemberKeys = keys.filter((k) => !['password', 'is_advance', 'invitation_code'].includes(k));
    const memberValues = { ...body, invitation_code: code, p_id: parent?.member_id || 0,
      path: parent ? `${parent.path || '/'}${parent.member_id}/` : '/',
      level: parent ? Number(parent.level || 1) + 1 : 1,
      grade_id: Number(body.grade_id) || 1, identity_vip: Number(body.identity_vip) || 0,
      is_valid: Number(body.is_valid) || 10, is_certification: Number(body.is_certification) || 0,
      disabled: Number(body.disabled) || 10,
      amount: Number(body.amount) || 0, score: Number(body.score) || 0,
      e_card_number: Number(body.e_card_number) || 0, rush_amount: Number(body.rush_amount) || 0,
      fy_price: Number(body.fy_price) || 0, create_time: now(), update_time: now() };
    ins = [...permittedMemberKeys, 'invitation_code', 'path', 'level', 'grade_id', 'password', 'create_time', 'update_time'];
    vals = [...permittedMemberKeys.map((k) => memberValues[k]), code, memberValues.path, memberValues.level,
      memberValues.grade_id, hashPwd(body.password), memberValues.create_time, memberValues.update_time];
    const create = () => {
      const info = run(`INSERT INTO member (${ins.join(',')}) VALUES (${ins.map(() => '?').join(',')})`, ...vals);
      const memberId = Number(info.lastInsertRowid);
      if (parent) {
        const childIds = (parent.child_id || '').split(',').filter(Boolean);
        childIds.push(String(memberId));
        run('UPDATE member SET child_id = ? WHERE member_id = ?', childIds.join(','), parent.member_id);
      }
      return memberId;
    };
    const memberId = tx(create);
    return res.json(ok({ id: memberId }, '添加成功'));
  } else {
    if (mod.fields.some((f) => f.k === 'create_time')) {
      ins = [...keys, 'create_time'];
      vals = [...vals, now()];
    }
  }
  const info = run(
    `INSERT INTO ${mod.table} (${ins.join(',')}) VALUES (${ins.map(() => '?').join(',')})`,
    ...vals,
  );
  res.json(ok({ id: Number(info.lastInsertRowid) }, '添加成功'));
});

r.post('/:module/remove', authAdmin, (req, res) => {
  const mod = M[req.params.module];
  if (!mod) return res.json(fail('模块不存在'));
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id]).filter(Boolean);
  if (!ids.length) return res.json(fail('请选择要删除的记录'));
  const moduleName = req.params.module;
  if (['orders', 'member', 'energy', 'withdraw', 'settle', 'certification', 'report'].includes(moduleName)) {
    return res.json(fail('业务记录需保留审计，不能通过通用接口删除'));
  }
  for (const id of ids) {
    if (moduleName === 'storeuser') {
      const user = get('SELECT store_user_id, role_id FROM store_user WHERE store_user_id = ?', Number(id));
      if (user && (Number(user.store_user_id) === Number(req.admin.store_user_id) || Number(user.role_id) === 6)) {
        return res.json(fail('不能删除当前管理员或超级管理员'));
      }
    }
    if (moduleName === 'role') {
      if (Number(id) === 6) return res.json(fail('不能删除超级管理员角色'));
      if (get('SELECT 1 FROM store_user WHERE role_id = ?', Number(id))) return res.json(fail('该角色仍被管理员使用，不能删除'));
    }
    if (moduleName === 'goods' && get('SELECT 1 FROM orders WHERE goods_id = ?', Number(id))) {
      return res.json(fail('商品已有关联订单，不能删除'));
    }
    if (moduleName === 'category' && get('SELECT 1 FROM goods WHERE category_id = ?', Number(id))) {
      return res.json(fail('分类下仍有商品，不能删除'));
    }
    if (moduleName === 'specialarea' && get('SELECT 1 FROM goods WHERE specialarea_id = ?', Number(id))) {
      return res.json(fail('场次下仍有商品，不能删除'));
    }
  }
  tx(() => ids.forEach((id) => run(`DELETE FROM ${mod.table} WHERE ${mod.pk} = ?`, id)));
  res.json(ok([], '删除成功'));
});

// ---------------- 订单操作 ----------------
r.post('/orders/deliver', authAdmin, (req, res) => {
  const { order_id, express_no, express_company } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  if (o.status !== 10) return res.json(fail('当前状态不可发货'));
  run('UPDATE orders SET status = 20, express_no = ?, express_company = ?, send_time = ? WHERE order_id = ?',
    express_no || '', express_company || '顺丰速运', now(), o.order_id);
  run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    o.order_id, '发货', 'admin', `${express_company || ''} ${express_no || ''}`, now());
  res.json(ok([], '发货成功'));
});

r.post('/orders/audit', authAdmin, (req, res) => {
  const { order_id, pass } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  run('UPDATE orders SET is_examine = ? WHERE order_id = ?', pass ? 10 : 20, o.order_id);
  run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    o.order_id, pass ? '审核通过' : '审核拒绝', 'admin', '', now());
  res.json(ok([], '操作成功'));
});

r.post('/orders/cancel', authAdmin, (req, res) => {
  const { order_id } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  run('UPDATE orders SET status = 40 WHERE order_id = ?', o.order_id);
  run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    o.order_id, '后台取消', 'admin', '', now());
  res.json(ok([], '已取消'));
});

// 确认线下凭证收款（与 H5 余额支付共用同一套结算算法）
r.post('/orders/confirm-pay', authAdmin, (req, res) => {
  const { order_id } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  if (o.pay_status === 10) return res.json(fail('订单已确认'));
  try {
    tx(() => {
      // 原子更新，避免与用户端并发支付冲突
      const r = run(
        'UPDATE orders SET status = 10, pay_status = 10, pay_time = ? WHERE order_id = ? AND pay_status = 0',
        now(), o.order_id,
      );
      if (Number(r.changes) !== 1) {
        const e = new Error('订单已支付，请勿重复确认');
        e.biz = true;
        throw e;
      }
      settleOrder(o);
      run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
        o.order_id, '确认收款', 'admin', '', now());
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok([], '已确认收款'));
});

// 给会员加减余额 / 佣金
r.post('/member/adjust', authAdmin, (req, res) => {
  const { member_id, field, value, remark } = req.body;
  const m = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!m) return res.json(fail('会员不存在'));
  const allow = { amount: '账户余额', e_card_number: '佣金', score: '积分', fy_price: '礼券', rush_amount: '抢购金额' };
  if (!allow[field]) return res.json(fail('不支持的字段'));
  const v = Number(value);
  if (!v) return res.json(fail('请输入变更数量'));
  tx(() => {
    run(`UPDATE member SET ${field} = ${field} + ? WHERE member_id = ?`, v, m.member_id);
    const typeMap = { amount: 2, e_card_number: 1, score: 3, fy_price: 4, rush_amount: 2 };
    run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      m.member_id, v, typeMap[field], `后台调整${allow[field]}`, remark || '管理员操作', now());
  });
  res.json(ok([], '调整成功'));
});

// 提现审核
r.post('/withdraw/audit', authAdmin, (req, res) => {
  const { withdraw_id, pass, remark } = req.body;
  const w = get('SELECT * FROM finance_withdraw WHERE withdraw_id = ?', Number(withdraw_id));
  if (!w) return res.json(fail('记录不存在'));
  if (w.status !== 0) return res.json(fail('该申请已处理'));
  tx(() => {
    run('UPDATE finance_withdraw SET status = ?, audit_time = ?, remark = ? WHERE withdraw_id = ?',
      pass ? 10 : 20, now(), remark || '', w.withdraw_id);
    if (!pass) {
      // 驳回退还
      run('UPDATE member SET amount = amount + ? WHERE member_id = ?', w.amount, w.member_id);
      run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
        w.member_id, w.amount, 2, '提现驳回退回', remark || '', now());
    }
  });
  res.json(ok([], pass ? '已通过' : '已驳回'));
});

// 实名审核
r.post('/certification/audit', authAdmin, (req, res) => {
  const { certification_id, pass } = req.body;
  const c = get('SELECT * FROM member_certification WHERE certification_id = ?', Number(certification_id));
  if (!c) return res.json(fail('记录不存在'));
  run('UPDATE member_certification SET status = ?, audit_time = ? WHERE certification_id = ?',
    pass ? 10 : 20, now(), c.certification_id);
  run('UPDATE member SET is_certification = ?, certification_name = ? WHERE member_id = ?',
    pass ? 1 : 0, pass ? c.real_name : '', c.member_id);
  res.json(ok([], '审核完成'));
});

// 结算确认
r.post('/settle/confirm', authAdmin, (req, res) => {
  const { id } = req.body;
  const s = get('SELECT * FROM settle_pay WHERE id = ?', Number(id));
  if (!s) return res.json(fail('记录不存在'));
  run('UPDATE settle_pay SET pay_status = 10, pay_time = ? WHERE id = ?', now(), s.id);
  res.json(ok([], '已确认'));
});

export default r;
