import { Router } from 'express';
import { themeOptions } from '../../lib/themes.js';
import { isSuperRole } from '../../lib/nodes.js';
import { all, get, run, tx, now, today } from '../../db.js';
import { ok, fail, page, money, authAdmin, GOODS_STATUS, ORDER_STATUS, ORDER_TYPE } from '../../lib/helper.js';
import { hashPwd, verifyPwd, needsRehash, signAdmin, randomCode } from '../../lib/auth.js';
import { settleOrder, goodsStillOwnedBySeller } from '../../lib/settle.js';
import { restoreStock } from '../../lib/stock.js';
import { areasOfGoods, areaMapOfGoods, setGoodsAreas, addGoodsToArea, removeGoodsFromArea, clearAreaLinks } from '../../lib/areaGoods.js';
import { priceCapOf } from '../../lib/priceCap.js';
import { todayStr, addDays } from '../../lib/sessionWindow.js';
import { scanCappedGoods, settlePending, recycleSummary } from '../../lib/recycle.js';
import extraRouter from './extra.js';
import mediaRouter from './media.js';
import systemRouter from './system.js';
import financeBoardRouter from './finance.js';
import transposeRouter from './transpose.js';

const r = Router();
// 补充业务接口优先匹配，避免被通用 /:module/* 路由拦截
r.use(extraRouter);
// 文件管理：/media/* 不能被通用 /:module/* 吞掉
r.use(mediaRouter);
// 数据清除：/system/* 同理
r.use(systemRouter);
// 转拍订单：/transpose/* 也要排在通用路由前面（否则会被当成 module=transpose 的列表）
r.use(transposeRouter);
// 财务大盘要在通用 /:module/* 之前挂载
r.use(financeBoardRouter);
const cfg = (k, d = '') => get('SELECT `value` FROM setting_config WHERE `key` = ?', k)?.value ?? d;

// ============================================================
// 模块注册表：驱动后台全部列表 / 表单
// ============================================================
const M = {
  goods: {
    table: 'goods', pk: 'goods_id', label: '商品',
    search: ['goods_name', 'goods_no'],
    orderBy: 'goods_id DESC',
    fields: [
      { k: 'goods_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'good_thumb', t: '商品图片', type: 'image', w: 84 },
      { k: 'images', t: '图集', type: 'images', hide: true },
      { k: 'goods_name', t: '商品名称', type: 'text', w: 140 },
      // 编码不再手填：新建/复制时按序列自动生成，仍做唯一标识与搜索用
      { k: 'goods_no', t: '商品编码', type: 'text', w: 116, hide: true, readonly: true, tip: '新建时自动生成，不用手填' },
      // 场次由「抢购场次 → 关联商品」决定，商品这边只读展示，不再提供选择框
      { k: 'areas', t: '关联场次', type: 'areas', readonly: true, w: 150, tip: '在场次页「关联商品」里维护。一件商品可以同时关联多个场次；没有关联任何场次时，它只在首页/分类/搜索里正常售卖，不受场次时间限制。' },
      { k: 'area_date', t: '场次日期', type: 'text', readonly: true, w: 100, hide: true, tip: '轮转上架时自动写入。空白表示不限日期（未进入场次的商品）' },
      { k: 'category_id', t: '分类', type: 'select', opts: 'category', w: 96 },
      // 持有人由「抢购成交 / 转拍 / 系统回收」自动流转，编辑页不再提供手填入口
      { k: 'member_id', t: '现持有人', type: 'holder', w: 104, readonly: true, tip: '由成交、转拍、系统回收自动维护，不在编辑页手改。' },
      { k: 'goods_min_price', t: '售卖价', type: 'money', w: 100 },
      // 基准价不再手填：新建时自动取售卖价，之后转拍不会改它，涨幅水位就从这里起算
      { k: 'base_price', t: '基准价', type: 'money', w: 100, hide: true, readonly: true, tip: '自动取首次上架价，转拍涨价不会改它。这是涨幅水位的起点，不需要手工维护。' },
      { k: 'price_cap', t: '价格上限(元)', type: 'money', w: 108, hide: true, tip: '填金额，不是百分比：这是一道围栏，任何一轮标价都不能越过它。判定不是「等到等于上限」，而是「下一轮涨价会越界时」就停止转拍（如上限 1200、当前 1180、涨 3% 会到 1215 → 到顶）。0 = 不限。' },
      { k: 'price_warning', t: '价格水位', type: 'capbar', readonly: true, w: 168, tip: '绿 → 黄 → 红表示当前价在「基准价 → 价格上限」这段区间里的位置；红色表示已达上限、不能再转拍。' },
      // 划线价（前台「市场价」）随转拍自动上调，不再手填
      { k: 'line_price', t: '划线价', type: 'money', w: 100, hide: true, readonly: true, tip: '前台展示的「市场价」，转拍时会自动跟涨；不用手填。' },
      { k: 'stock_num', t: '库存', type: 'number', w: 72, tip: '还能被抢几个名额。填 1 = 唯一的一件货，成交后整件归买家并下架，等买家转拍；填 >1 = 一批货，抢一个减一个名额，抢光才下架，整件始终归原持有人。' },
      { k: 'session_quota', t: '每场放量', type: 'number', w: 92, hide: true, tip: '这一场只拿出多少件来卖。0 = 不限，整批库存都能卖。例如库存 100 件、这里填 10：本场最多卖 10 件，卖满立刻结束变灰，剩下 90 件留到下一场。注意是「名额数」不是「人数」—— 10 个名额 + 每人限购 2 件 = 5 个人就抢完了。' },
      { k: 'turn_beat_num', t: '转拍次数', type: 'number', w: 88, hide: true },
      { k: 'sales_actual', t: '销量', type: 'number', w: 72, hide: true },
      { k: 'goods_sort', t: '排序', type: 'number', w: 72, hide: true },
      { k: 'goods_status', t: '状态', type: 'select', opts: GOODS_STATUS, w: 84 },
      { k: 'detail', t: '商品详情', type: 'rich', hide: true },
      { k: 'detail_images', t: '详情图片', type: 'images', hide: true, tip: '前台商品详情页会把这里的图按上传顺序，接在「商品详情」文字下方满宽铺开。一张图讲一段内容，建议 750px 宽的长图；只写文字不配图就留空。' },
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
      { k: 'home_show', t: '首页显示', type: 'switch', opts: { 10: '显示', 20: '隐藏' }, w: 100 },
      { k: 'sort', t: '排序', type: 'number', w: 90 },
      { k: 'create_time', t: '创建时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  specialarea: {
    table: 'specialarea', pk: 'specialarea_id', label: '抢购场次',
    search: ['title_main'],
    // 与 H5 抢购页同一套顺序：开始时间 → 上午/下午/晚上 → 排序值
    orderBy: "start_time ASC, CASE name WHEN 'forenoon' THEN 1 WHEN 'afternoon' THEN 2 WHEN 'evening' THEN 3 ELSE 9 END ASC, sort ASC, specialarea_id ASC",
    fields: [
      { k: 'specialarea_id', t: 'ID', type: 'text', readonly: true, w: 60 },
      { k: 'name', t: '场次标识', type: 'text', w: 100, hide: true },
      { k: 'title_main', t: '主标题', type: 'text', required: true, w: 132 },
      { k: 'title_ordinary', t: '副标题', type: 'text', hide: true },
      { k: 'image_ordinary', t: '场次图', type: 'image', w: 80 },
      { k: 'open_days', t: '开放日期', type: 'days', w: 96 },
      { k: 'start_time', t: '开始时间', type: 'timesec', w: 88 },
      { k: 'end_time', t: '结束时间', type: 'timesec', w: 88 },
      { k: 'buy_num', t: '限购次数', type: 'number', w: 84 },
      { k: 'area_goods_count', t: '商品数', type: 'count', readonly: true, w: 80, tip: '本场次已关联多少件商品。点「配置」进去可以增减。' },
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
      { k: 'invitation_code', t: '邀请码', type: 'text', w: 112, readonly: true },
      { k: 'is_valid', t: '会员身份', type: 'select', opts: { 10: '有效会员', 20: '无效会员' }, w: 110, hide: true },
      { k: 'is_certification', t: '实名', type: 'cert', w: 90, readonly: true },
      { k: 'amount', t: '账户余额', type: 'money', w: 110, readonly: true },
      { k: 'e_card_number', t: '佣金', type: 'money', w: 100, readonly: true },
      { k: 'rush_amount', t: '抢购金额', type: 'money', w: 110, hide: true, readonly: true },
      { k: 'fy_price', t: '礼券', type: 'money', w: 90, hide: true, readonly: true },
      { k: 'score', t: '积分', type: 'number', w: 80, readonly: true },
      { k: 'p_id', t: '上级', type: 'parent', w: 130 },
      { k: 'is_advance', t: '提前抢购', type: 'advance', w: 132, readonly: true, tip: '开通后该会员可以比场次开始时间提前若干分钟下单（只提前开始，不延长结束）。' },
      { k: 'disabled', t: '状态', type: 'switch', opts: { 10: '正常', 20: '禁用' }, w: 90 },
      { k: 'create_time', t: '注册时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  // 系统回收台账：商品涨到价格上限后被平台接盘结算的记录（只读，结算走专用接口）
  recycle: {
    table: 'goods_recycle', pk: 'recycle_id', label: '系统回收',
    search: ['goods_name'], orderBy: 'recycle_id DESC',
    fields: [
      { k: 'recycle_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'good_thumb', t: '图片', type: 'image', w: 76 },
      { k: 'goods_name', t: '商品', type: 'text', readonly: true, w: 160 },
      { k: 'member_id', t: '原持有人', type: 'member', readonly: true, w: 132 },
      { k: 'buy_price', t: '买入价', type: 'money', readonly: true, w: 96 },
      { k: 'increase_rate', t: '结算涨幅(%)', type: 'number', readonly: true, w: 96, hide: true },
      { k: 'recycle_price', t: '回收价', type: 'money', readonly: true, w: 100 },
      { k: 'profit', t: '持有人收益', type: 'money', readonly: true, w: 100 },
      { k: 'cap_price', t: '当时上限价', type: 'money', readonly: true, w: 108, hide: true },
      { k: 'status', t: '状态', type: 'select', opts: { 10: '已结算', 20: '待处理' }, readonly: true, w: 88 },
      { k: 'create_time', t: '产生时间', type: 'text', readonly: true, w: 140 },
      { k: 'settle_time', t: '结算时间', type: 'text', readonly: true, w: 156, hide: true },
      { k: 'remark', t: '备注', type: 'text', readonly: true, w: 180, hide: true },
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
      { k: 'pay_voucher', t: '支付凭证', type: 'image', w: 80, hide: true, readonly: true },
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
    table: 'finance_energy', pk: 'energy_id', label: '资金流水',
    search: ['remarks'], orderBy: 'energy_id DESC',
    fields: [
      { k: 'energy_id', t: 'ID', type: 'text', readonly: true, w: 80 },
      { k: 'member_id', t: '会员', type: 'member', w: 120 },
      { k: 'face_value', t: '变更数量', type: 'money', w: 110 },
      { k: 'type', t: '变更类型', type: 'select', opts: { 1: '佣金', 2: '余额', 3: '积分', 4: '礼券' }, w: 100 },
      { k: 'type_name', t: '类型说明', type: 'text', w: 120 },
      { k: 'remarks', t: '备注', type: 'text' },
      { k: 'create_time', t: '时间', type: 'text', readonly: true, w: 160 },
    ],
  },
  scoreItem: {
    table: 'score_item', pk: 'item_id', label: '积分商品',
    search: ['name'], orderBy: 'sort ASC, item_id DESC',
    fields: [
      { k: 'item_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'thumb', t: '商品图片', type: 'image', w: 84 },
      { k: 'name', t: '商品名称', type: 'text', w: 180 },
      { k: 'score_price', t: '所需积分', type: 'number', w: 100 },
      { k: 'stock', t: '可兑数量', type: 'number', w: 96 },
      { k: 'sold', t: '已兑', type: 'number', readonly: true, w: 76 },
      { k: 'limit_per', t: '每人限兑', type: 'number', w: 100, tip: '同一会员最多兑换几件，填 0 表示不限' },
      { k: 'sort', t: '排序', type: 'number', w: 76, tip: '数字越小越靠前' },
      { k: 'status', t: '状态', type: 'select', opts: { 10: '在售', 20: '已下架' }, w: 90 },
      { k: 'intro', t: '卖点', type: 'text', w: 160, hide: true },
      { k: 'detail', t: '商品详情', type: 'rich', hide: true },
      { k: 'images', t: '图集', type: 'images', hide: true },
      { k: 'create_time', t: '添加时间', type: 'text', readonly: true, w: 150, hide: true },
    ],
  },
  scoreExchange: {
    table: 'score_exchange', pk: 'exchange_id', label: '积分兑换',
    search: ['exchange_no', 'item_name', 'receiver', 'mobile'],
    orderBy: 'exchange_id DESC',
    fields: [
      { k: 'exchange_id', t: 'ID', type: 'text', readonly: true, w: 64 },
      { k: 'exchange_no', t: '兑换单号', type: 'text', readonly: true, w: 170 },
      { k: 'member_id', t: '会员', type: 'member', w: 110 },
      { k: 'item_thumb', t: '图片', type: 'image', w: 76 },
      { k: 'item_name', t: '兑换商品', type: 'text', w: 160 },
      { k: 'total_score', t: '消耗积分', type: 'number', w: 100 },
      { k: 'num', t: '数量', type: 'number', w: 70 },
      { k: 'status', t: '状态', type: 'select', opts: { 10: '待发货', 20: '待收货', 30: '已完成', 40: '已取消' }, w: 90 },
      { k: 'receiver', t: '收货人', type: 'text', w: 100 },
      { k: 'mobile', t: '手机号', type: 'text', w: 120 },
      { k: 'region', t: '地区', type: 'text', w: 150, hide: true },
      { k: 'address', t: '详细地址', type: 'text', w: 200, hide: true },
      { k: 'express_company', t: '快递公司', type: 'text', w: 110, hide: true },
      { k: 'express_no', t: '快递单号', type: 'text', w: 140, hide: true },
      { k: 'create_time', t: '兑换时间', type: 'text', readonly: true, w: 150 },
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
      { k: 'account_type', t: '打款方式', type: 'select', opts: { 1: '微信', 2: '支付宝', 3: '银行卡', 4: '线下打款' }, w: 104, readonly: true },
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
  // 旧哈希（sha256 + 固定盐）在登录成功这一刻顺手升级成 scrypt，用户无感
  if (needsRehash(u.password)) {
    run('UPDATE store_user SET password = ? WHERE store_user_id = ?', hashPwd(password), u.store_user_id);
  }
  run('UPDATE store_user SET last_login_time = ? WHERE store_user_id = ?', now(), u.store_user_id);
  res.json(ok({ token: signAdmin(u.store_user_id), user: { id: u.store_user_id, name: u.user_name, nick: u.nick_name, role_id: u.role_id } }, '登录成功'));
});

r.get('/me', authAdmin, (req, res) => {
  const u = req.admin;
  res.json(ok({ id: u.store_user_id, name: u.user_name, nick: u.nick_name, role_id: u.role_id, avatar: u.avatar }));
});

// 修改自己的登录密码（任何管理员都能改自己的，不需要权限节点）
r.post('/me/password', authAdmin, (req, res) => {
  const u = req.admin;
  const oldPwd = String(req.body?.old_password || '');
  const newPwd = String(req.body?.new_password || '');
  if (!oldPwd || !newPwd) return res.json(fail('请填写原密码和新密码'));
  if (!verifyPwd(oldPwd, u.password)) return res.json(fail('原密码不正确'));
  if (newPwd.length < 6) return res.json(fail('新密码至少 6 位'));
  if (newPwd.length > 32) return res.json(fail('新密码最多 32 位'));
  if (newPwd === oldPwd) return res.json(fail('新密码不能与原密码相同'));
  run('UPDATE store_user SET password = ? WHERE store_user_id = ?', hashPwd(newPwd), u.store_user_id);
  res.json(ok([], '密码已修改，下次登录请使用新密码'));
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
        goods_total: num('SELECT COUNT(*) c FROM goods'),
        goods_online: num('SELECT COUNT(*) c FROM goods WHERE goods_status = 10'),
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

// 外观主题候选列表（后台设置页用）
r.get('/themes', authAdmin, (req, res) => {
  res.json(ok({ themes: themeOptions() }));
});

// 分类：一键设置「首页显示」（10 显示 / 20 隐藏）
r.post('/category/home-show-all', authAdmin, (req, res) => {
  const value = Number(req.body?.value);
  if (![10, 20].includes(value)) return res.json(fail('参数错误'));
  const n = Number(run('UPDATE goods_category SET home_show = ? WHERE type = 2', value).changes || 0);
  res.json(ok({ count: n }, value === 10 ? `已显示 ${n} 个分类` : `已隐藏 ${n} 个分类`));
});

// 后台订单通知：首次只建立游标，之后按订单 ID 增量读取，避免重复拉取订单列表。
r.get('/notifications/orders', authAdmin, (req, res) => {
  const rawType = req.query.type;
  const requestedType = rawType === undefined || rawType === '' ? 0 : Number(rawType);
  if (!Number.isSafeInteger(requestedType) || ![0, 3].includes(requestedType)) {
    return res.json(fail('订单通知类型无效'));
  }
  const typeFilter = requestedType === 3 ? 'type IN (3,4)' : 'type IN (1,3,4)';
  const hasCursor = req.query.after_id !== undefined && req.query.after_id !== '';
  const afterId = hasCursor ? Number(req.query.after_id) : 0;
  if (!Number.isSafeInteger(afterId) || afterId < 0) return res.json(fail('订单通知游标无效'));

  if (!hasCursor) {
    const latestId = Number(get(`SELECT IFNULL(MAX(order_id),0) id FROM orders WHERE ${typeFilter}`)?.id || 0);
    return res.json(ok({ latest_id: latestId, items: [] }));
  }

  const items = all(
    `SELECT order_id, order_no, goods_name, total_price, create_time, type
     FROM orders WHERE ${typeFilter} AND order_id > ? ORDER BY order_id ASC LIMIT 50`,
    afterId,
  );
  const latestId = items.length ? Number(items[items.length - 1].order_id) : afterId;
  res.json(ok({ latest_id: latestId, items }));
});

// 提现申请通知：按提现记录 ID 增量读取，仅供有提现审核权限的管理员使用。
r.get('/notifications/withdrawals', authAdmin, (req, res) => {
  const hasCursor = req.query.after_id !== undefined && req.query.after_id !== '';
  const afterId = hasCursor ? Number(req.query.after_id) : 0;
  if (!Number.isSafeInteger(afterId) || afterId < 0) return res.json(fail('提现通知游标无效'));

  if (!hasCursor) {
    const latestId = Number(get('SELECT IFNULL(MAX(withdraw_id),0) id FROM finance_withdraw')?.id || 0);
    return res.json(ok({ latest_id: latestId, items: [] }));
  }

  const items = all(
    `SELECT w.withdraw_id, w.member_id, m.nick_name, w.amount, w.create_time
     FROM finance_withdraw w LEFT JOIN member m ON m.member_id = w.member_id
     WHERE w.withdraw_id > ? ORDER BY w.withdraw_id ASC LIMIT 50`,
    afterId,
  );
  const latestId = items.length ? Number(items[items.length - 1].withdraw_id) : afterId;
  res.json(ok({ latest_id: latestId, items }));
});

// 系统回收通知：按回收单 ID 增量读取。到顶回收是系统自动发生的，
// 运营不在回收页时也要能第一时间收到提醒（后台全局轮询 + 语音播报）。
r.get('/notifications/recycles', authAdmin, (req, res) => {
  const hasCursor = req.query.after_id !== undefined && req.query.after_id !== '';
  const afterId = hasCursor ? Number(req.query.after_id) : 0;
  if (!Number.isSafeInteger(afterId) || afterId < 0) return res.json(fail('回收通知游标无效'));

  if (!hasCursor) {
    const latestId = Number(get('SELECT IFNULL(MAX(recycle_id),0) id FROM goods_recycle')?.id || 0);
    return res.json(ok({ latest_id: latestId, items: [] }));
  }

  const items = all(
    `SELECT r.recycle_id, r.goods_id, r.goods_name, r.member_id, r.buy_price, r.recycle_price,
            r.status, r.create_time, m.nick_name
     FROM goods_recycle r LEFT JOIN member m ON m.member_id = r.member_id
     WHERE r.recycle_id > ? ORDER BY r.recycle_id ASC LIMIT 50`,
    afterId,
  );
  const latestId = items.length ? Number(items[items.length - 1].recycle_id) : afterId;
  res.json(ok({ latest_id: latestId, items }));
});

function buildTrend() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(todayStr(), -i);
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
    { k: 'theme_key', t: '外观主题', type: 'theme', tip: '选一套配色，前台刷新页面即生效。只影响 H5 商城，后台界面不变。' },
    { k: 'score_open', t: '积分商城', type: 'switch', tip: '开启：我的页面显示积分余额与「积分商城」入口，会员可用积分兑换商品；关闭：前台隐藏全部积分入口，兑换接口一并关闭。已有的积分余额与兑换记录都会保留，后台仍可在会员列表里调账。' },
    { k: 'score_award_open', t: '成交送积分', type: 'switch', tip: '开启：每笔抢购/寄卖成交后，按下两项规则给买家和上级发积分。关闭：成交不产生任何积分。默认关闭，避免升级后凭空多出积分。' },
    { k: 'score_award_buyer', t: '买家积分返利(%)', type: 'number', tip: '按成交金额的百分比给买家送积分，向下取整。填 1 表示消费 100 元得 1 积分；填 0.5 表示 100 元得 0.5 分（不足 1 分不发放）。填 0 表示买家不送积分。' },
    { k: 'score_award_parent', t: '上级积分返利(%)', type: 'number', tip: '按成交金额的百分比给直接上级送积分，向下取整。填 0.5 表示下级消费 100 元，上级得 0.5 分。填 0 表示上级不送积分。与买家返利各自独立，可只开一边。' },
    { k: 'region_bg_img', t: '首页背景图', type: 'image' },
  ],
  trade: [
    { k: 'service_charge', t: '抢单服务费(%)', type: 'number', tip: '买家在商品金额之外额外支付；填 0 则不收（平台收入来自转拍上架费）' },
    { k: 'require_receiving_account', t: '抢购前必须绑定收款账户', type: 'switch', tip: '关闭时允许未绑定收款账户的会员直接下单；开启后，会员需先设置收款方式。默认关闭。' },
    { k: 'require_invite_code', t: '注册必须填邀请码', type: 'switch', tip: '开启：必须有有效邀请码才能入驻，注册后自动绑定上级。关闭：邀请码可留空直接注册（无上级、不产生直推奖），填了仍会校验有效性。默认开启。' },
    { k: 'withdraw_wx_open', t: '提现到微信', type: 'switch' },
    { k: 'withdraw_zfb_open', t: '提现到支付宝', type: 'switch' },
    { k: 'withdraw_bank_open', t: '提现到银行卡', type: 'switch' },
    { k: 'withdraw_offline_open', t: '提现线下打款', type: 'switch' },
    { k: 'price_increase_rate', t: '转拍涨价率(%)', type: 'number', tip: '每转拍一次，在上一手成交价基础上自动加价该比例，逐轮复利：10000 → 10300 → 10609。下一轮买家付 10300 时，上一手持有人收回 10300 全额（原价 + 涨价），此后与该持有人无关。注意：涨价率需高于上架费率才有净收益。' },
    { k: 'listing_fee_rate', t: '转拍上架费(%)', type: 'number' },
    { k: 'drive_award_rate', t: '直推奖(%)', type: 'number' },
    { k: 'consignment_open', t: '转拍开关', type: 'switch' },
    { k: 'consignment_rule', t: '转拍规则说明', type: 'textarea' },
    { k: 'withdraw_min', t: '最低提现金额', type: 'number' },
    { k: 'withdraw_fee', t: '提现手续费(%)', type: 'number' },
    { k: 'recycle_open', t: '到顶自动回收', type: 'switch', tip: '开启：商品的下一轮涨价会越过「价格上限」时即判定到顶，持有人无法再转拍，系统按商品「当前实际价格」接盘结算（刚买下的按买入价原价退回），商品转平台持仓。关闭：只记一笔「待处理」，不自动打款。' },
    { k: 'recycle_daily_cap', t: '每日回收上限(元)', type: 'number', tip: '平台每天最多垫付多少回收款；0 = 不限。超出后当天的到顶商品只记「待处理」，可在「订单管理 → 系统回收」里手动结算。' },
  ],
  pay: [
    { k: 'pay_balance_open', t: '余额支付', type: 'switch' },
    { k: 'pay_wx', t: '微信收款码转账', type: 'switch' },
    { k: 'pay_zfb', t: '支付宝收款码转账', type: 'switch' },
    { k: 'pay_bank', t: '线下转账凭证', type: 'switch', tip: '开启后前台可选择线下转账并上传凭证；微信、支付宝扫码方式需先配置对应收款码。' },
    { k: 'pay_voucher_required', t: '支付凭证必传', type: 'switch', tip: '开启（默认）：线下扫码/转账支付必须上传付款凭证，后台「确认收款」也会校验凭证是否已提交。关闭：会员选线下支付时无需上传凭证，点一下即标记为「已提交」；后台确认收款不再校验凭证，可直接确认。⚠️ 关闭后会员未实际付款也能自行标记已付款，请确保另有核实手段（如收款账户流水）。' },
    { k: 'pay_gateway_open', t: '在线支付通道', type: 'switch' },
    { k: 'zfb_qr', t: '支付宝收款码', type: 'image' },
    { k: 'wx_qr', t: '微信收款码', type: 'image' },
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
    { k: 'poster_title_show', t: '显示主标题', type: 'switch' },
    { k: 'poster_title_x', t: '主标题 X 坐标', type: 'number' },
    { k: 'poster_title_y', t: '主标题 Y 坐标', type: 'number' },
    { k: 'poster_title_size', t: '主标题字号', type: 'number' },
    { k: 'poster_title_color', t: '主标题颜色', type: 'text' },
    { k: 'poster_title_align', t: '主标题对齐', type: 'text' },
    { k: 'poster_subtitle', t: '海报副标题', type: 'text' },
    { k: 'poster_subtitle_show', t: '显示副标题', type: 'switch' },
    { k: 'poster_subtitle_x', t: '副标题 X 坐标', type: 'number' },
    { k: 'poster_subtitle_y', t: '副标题 Y 坐标', type: 'number' },
    { k: 'poster_subtitle_size', t: '副标题字号', type: 'number' },
    { k: 'poster_subtitle_color', t: '副标题颜色', type: 'text' },
    { k: 'poster_subtitle_align', t: '副标题对齐', type: 'text' },
    { k: 'poster_content', t: '海报说明文字', type: 'textarea' },
    { k: 'poster_content_show', t: '显示说明文字', type: 'switch' },
    { k: 'poster_content_x', t: '说明文字 X 坐标', type: 'number' },
    { k: 'poster_content_y', t: '说明文字 Y 坐标', type: 'number' },
    { k: 'poster_content_size', t: '说明文字字号', type: 'number' },
    { k: 'poster_content_color', t: '说明文字颜色', type: 'text' },
    { k: 'poster_content_align', t: '说明文字对齐', type: 'text' },
    { k: 'poster_code_label', t: '邀请码前缀', type: 'text' },
    { k: 'poster_code_show', t: '显示邀请码', type: 'switch' },
    { k: 'poster_code_x', t: '邀请码 X 坐标', type: 'number' },
    { k: 'poster_code_y', t: '邀请码 Y 坐标', type: 'number' },
    { k: 'poster_code_size', t: '邀请码字号', type: 'number' },
    { k: 'poster_code_color', t: '邀请码颜色', type: 'text' },
    { k: 'poster_code_align', t: '邀请码对齐', type: 'text' },
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
    { k: 'home_category_show', t: '首页商品分类', type: 'switch', tip: '关闭后 H5 首页整条分类栏都不显示（商品照常展示）。单个分类还能在「商品分类」里各自设首页显示。' },
    { k: 'subscribe_open', t: '预约功能', type: 'switch' },
    { k: 'subscribe_e_card', t: '预约奖励佣金', type: 'number' },
  ],
};

r.get('/setting/:group', authAdmin, (req, res) => {
  const g = Object.prototype.hasOwnProperty.call(SETTING_GROUPS, req.params.group) ? SETTING_GROUPS[req.params.group] : null;
  if (!g) return res.json(fail('设置组不存在'));
  const values = Object.fromEntries(g.map((x) => [x.k, get('SELECT `value` FROM setting_config WHERE `key` = ?', x.k)?.value ?? null]));
  res.json(ok({ group: req.params.group, items: g, values }));
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


/** 生成下一个商品编码：统一 GP20260001（不再区分抢购/商城） */
function nextGoodsNo() {
  const prefix = 'GP';
  const year = String(new Date().getFullYear());
  const head = `${prefix}${year}`;
  const rows = all('SELECT goods_no FROM goods WHERE goods_no LIKE ?', `${head}%`);
  let max = 0;
  for (const r of rows) {
    const tail = String(r.goods_no || '').slice(head.length);
    const n = Number(tail);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${head}${String(max + 1).padStart(4, '0')}`;
}

/**
 * 复制商品：以现有商品为模板快速建一条新的。
 *
 * 刻意不复制的东西：
 * - 持有人：新商品归平台，不会凭空空投给某个会员。
 *   只有原商品本来就归平台时，才跟随原状态直接可售；否则一律先下架，
 *   等运营确认价格/场次后再手动上架 —— 避免一件没确认的货直接出现在抢购列表里。
 * - 转拍次数、销量、场次日期：这些都是"这件货的历史"，新商品不该继承。
 * - 编码：重新按序列生成，goods_no 是唯一标识。
 */
r.post('/goods/duplicate', authAdmin, (req, res) => {
  const g = get('SELECT * FROM goods WHERE goods_id = ?', Number(req.body?.goods_id));
  if (!g) return res.json(fail('商品不存在'));

  const goodsNo = nextGoodsNo();
  const platformOwned = Number(g.member_id) === 0;
  const status = platformOwned ? Number(g.goods_status) || 20 : 20;
  const isSell = platformOwned ? Number(g.is_sell) || 0 : 0;
  const t = now();

  const info = run(
    `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id, area_date,
       member_id, goods_min_price, base_price, price_cap, line_price, stock_num, stock_total, sales_actual,
       goods_status, is_sell, session_quota, turn_beat_num, goods_sort, type, score_price, create_time, update_time)
     VALUES (?,?,?,?,?,?,?,'',0,?,?,?,?,?,?,0,?,?,?,0,?,?,?,?,?)`,
    `${g.goods_name}（副本）`, goodsNo, g.good_thumb || '', g.images || '', g.detail || '',
    Number(g.category_id) || 0, Number(g.specialarea_id) || 0,
    // 副本是全新的挂牌：基准价取它自己的售价（涨幅从 0 起算），上限沿用源商品
    Number(g.goods_min_price) || 0, Number(g.goods_min_price) || 0, Number(g.price_cap) || 0,
    Number(g.line_price) || 0,
    Number(g.stock_num) || 0, Math.max(1, Number(g.stock_num) || 0), status, isSell,
    Number(g.session_quota) || 0,
    Number(g.goods_sort) || 100, Number(g.type) || 1, Number(g.score_price) || 0,
    t, t,
  );

  const newId = Number(info.lastInsertRowid);
  // 场次关联跟着一起复制（旧版复制的是 goods.specialarea_id，行为保持一致）。
  // 新商品默认是下架态，落在同一场次也不会立刻出现在抢购列表里。
  setGoodsAreas(newId, areasOfGoods(g.goods_id).map((a) => Number(a.specialarea_id)));
  const tip = platformOwned && status === 10
    ? '已复制，可直接编辑或下架'
    : '已复制并设为下架，确认价格与场次后再上架';
  res.json(ok({ goods_id: newId, goods_no: goodsNo }, tip));
});

// ---------------- 系统回收（到顶） ----------------
// 商品涨到价格上限后无法再转拍，平台按「买入价 + 一轮涨幅」接盘；这里是台账与手动入口。

r.get('/recycle/summary', authAdmin, (req, res) => res.json(ok(recycleSummary())));

r.post('/recycle/scan', authAdmin, (req, res) => {
  // 强制结算（忽略开关与日限额）只给超管，避免普通运营绕过成本闸门
  const force = !!req.body?.force && isSuperRole(req.admin.role_id);
  const out = scanCappedGoods({ force });
  const parts = [];
  if (out.settled) parts.push(`已结算 ${out.settled} 件，垫付 ¥${out.paid.toFixed(2)}`);
  if (out.pending) {
    const why = out.no_order ? `（含 ${out.no_order} 件缺少买入订单，需人工核对）` : '';
    parts.push(`${out.pending} 件记为「待处理」${why}，可在列表中手动结算`);
  }
  if (out.skipped) parts.push(`${out.skipped} 件跳过`);
  res.json(ok(out, parts.length ? parts.join('；') : '没有需要回收的到顶商品'));
});

r.post('/recycle/settle', authAdmin, (req, res) => {
  const out = settlePending(req.body?.recycle_id, req.admin.user_name || 'admin');
  if (!out.ok) return res.json(fail(out.reason));
  res.json(ok(out, `已结算 ¥${out.recycle_price.toFixed(2)}（持有人收益 ¥${out.profit.toFixed(2)}）`));
});

// ---------------- 场次 ↔ 商品 关联 ----------------
// 商品表不再维护场次字段：哪个场次卖哪些货，全部由这组接口维护（多对多，可重复挂多场）。

/** 某场次已关联的商品列表 */
r.get('/specialarea/:id/goods', authAdmin, (req, res) => {
  const areaId = Number(req.params.id);
  const area = get('SELECT * FROM specialarea WHERE specialarea_id = ?', areaId);
  if (!area) return res.json(fail('场次不存在'));
  const rows = all(
    `SELECT g.*, sg.sort AS link_sort FROM specialarea_goods sg
     JOIN goods g ON g.goods_id = sg.goods_id
     WHERE sg.specialarea_id = ?
     ORDER BY sg.sort ASC, sg.area_goods_id ASC`,
    areaId,
  );
  const list = rows.map((row) => {
    const out = enrich('goods', row);
    out.link_sort = row.link_sort;
    // 除了本场之外还挂在哪些场次（多场关联时给运营一个提示）
    out.other_areas = (out._area_ids || [])
      .filter((id) => Number(id) !== areaId)
      .map((id) => get('SELECT title_main FROM specialarea WHERE specialarea_id = ?', id)?.title_main || '')
      .filter(Boolean)
      .join('、');
    return out;
  });
  res.json(ok({ specialarea: { specialarea_id: area.specialarea_id, title_main: area.title_main }, total: list.length, list }));
});

/** 可添加的商品（带「已在本场 / 已在其它场」标记） */
r.get('/specialarea/:id/pick-goods', authAdmin, (req, res) => {
  const areaId = Number(req.params.id);
  if (!get('SELECT 1 FROM specialarea WHERE specialarea_id = ?', areaId)) return res.json(fail('场次不存在'));
  const kw = String(req.query.keyword || '').trim();
  const rows = kw
    ? all('SELECT * FROM goods WHERE goods_name LIKE ? OR goods_no LIKE ? ORDER BY goods_id DESC LIMIT 60', `%${kw}%`, `%${kw}%`)
    : all('SELECT * FROM goods ORDER BY goods_id DESC LIMIT 60');
  const map = areaMapOfGoods(rows.map((g) => g.goods_id));
  const list = rows.map((g) => {
    const areas = map.get(Number(g.goods_id)) || [];
    return {
      goods_id: g.goods_id,
      goods_name: g.goods_name,
      goods_no: g.goods_no,
      good_thumb: g.good_thumb,
      goods_min_price: Number(g.goods_min_price || 0),
      stock_num: Number(g.stock_num || 0),
      goods_status: g.goods_status,
      in_area: areas.some((a) => Number(a.specialarea_id) === areaId),
      other_areas: areas
        .filter((a) => Number(a.specialarea_id) !== areaId)
        .map((a) => a.title_main || a.name || `#${a.specialarea_id}`)
        .join('、'),
    };
  });
  res.json(ok(list));
});

/** 场次批量关联商品 */
r.post('/specialarea/goods/add', authAdmin, (req, res) => {
  const areaId = Number(req.body?.specialarea_id);
  if (!areaId) return res.json(fail('请选择场次'));
  if (!get('SELECT 1 FROM specialarea WHERE specialarea_id = ?', areaId)) return res.json(fail('场次不存在'));
  const ids = (Array.isArray(req.body?.goods_ids) ? req.body.goods_ids : [req.body?.goods_id]).map(Number).filter(Boolean);
  if (!ids.length) return res.json(fail('请选择要关联的商品'));
  const out = addGoodsToArea(areaId, ids);
  if (!out.added) return res.json(fail('所选的商品都已经在本场了'));
  res.json(ok(out, out.skipped ? `已关联 ${out.added} 件，${out.skipped} 件已存在或无效` : `已关联 ${out.added} 件商品`));
});

/** 场次取消关联商品（只解除关联，不删商品） */
r.post('/specialarea/goods/remove', authAdmin, (req, res) => {
  const areaId = Number(req.body?.specialarea_id);
  if (!areaId) return res.json(fail('请选择场次'));
  const ids = (Array.isArray(req.body?.goods_ids) ? req.body.goods_ids : [req.body?.goods_id]).map(Number).filter(Boolean);
  if (!ids.length) return res.json(fail('请选择要移除的商品'));
  const removed = removeGoodsFromArea(areaId, ids);
  if (!removed) return res.json(fail('这些商品本来就不在本场次'));
  res.json(ok({ removed }, `已移除 ${removed} 件商品`));
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
  if (req.params.module === 'settle' && req.query.kind) {
    where.push('kind = ?');
    args.push(req.query.kind);
  }
  // 商品按「关联场次」筛选：件品与场次是多对多，走关联表判断
  if (req.params.module === 'goods' && req.query.area_id) {
    where.push('goods_id IN (SELECT goods_id FROM specialarea_goods WHERE specialarea_id = ?)');
    args.push(Number(req.query.area_id));
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
/**
 * 该订单的商品是否已经被买家转拍出去（不需要发货）。
 *
 * 判据：商品的「现持有人」已经不是这笔订单的买家。
 * 抢购商品成交后 goods.member_id 会写成买家；买家转拍给别人、被下一个人买走后，
 * member_id 就变成下一个人；被平台回收则归 0。两种情况买家都不再持有实物。
 *
 * 只对抢购类（type=1）判定 —— 这件货会被同一个人反复转手，是「一件货多笔订单」的根源。
 * 未支付时不判（还没真正成交，商品本来就还在卖家手里）。
 */
function isTransferredOut(o) {
  if (!o || Number(o.type) !== 1 || !o.goods_id) return false;
  if (Number(o.pay_status) !== 10) return false;
  const g = get('SELECT member_id FROM goods WHERE goods_id = ?', o.goods_id);
  if (!g) return false;
  return Number(g.member_id) !== Number(o.member_id);
}

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
    // 关联场次由关联表决定（可能多个），不再读 goods.specialarea_id 镜像列
    const areas = areasOfGoods(row.goods_id);
    out._areas = areas.map((a) => a.title_main || a.name || `#${a.specialarea_id}`).join('、');
    out._area_ids = areas.map((a) => Number(a.specialarea_id));
    // 价格水位：列表里的「绿→黄→红」色块按它渲染
    out._cap = priceCapOf(row);
  }
  if (mod === 'recycle') {
    const mm = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', row.member_id);
    out._member = mm ? `${mm.nick_name || '会员'} · ${mm.mobile}` : '—';
  }
  if (mod === 'orders') {
    const b = get('SELECT nick_name, mobile FROM member WHERE member_id = ?', row.member_id);
    out._buyer = b?.nick_name || '';
    out._buyer_mobile = b?.mobile || '';
    if (row.seller_id) out._seller = get('SELECT nick_name FROM member WHERE member_id = ?', row.seller_id)?.nick_name || '';
    // 已转拍出去的单不需要发货，前端据此隐藏发货按钮、状态显示为「已转拍」
    out.transferred = isTransferredOut(row) ? 1 : 0;
  }
  if (mod === 'member') {
    out._parent = row.p_id ? get('SELECT nick_name FROM member WHERE member_id = ?', row.p_id)?.nick_name || '' : '';
    // 提前抢购的提前量：库里存秒，列表上按分钟展示
    out.advance_minutes = Math.round((Number(row.advance_seconds) || 0) / 60);
  }
  if (mod === 'specialarea') {
    // 场次列表展示「已关联商品数」，商品归属完全由关联表决定
    out.area_goods_count = Number(get('SELECT COUNT(*) c FROM specialarea_goods WHERE specialarea_id = ?', row.specialarea_id)?.c || 0);
  }
  if (mod === 'energy' || mod === 'withdraw' || mod === 'settle' || mod === 'scoreExchange') {
    out._member = get('SELECT nick_name FROM member WHERE member_id = ?', row.member_id)?.nick_name || '';
    if (row.b_member_id) out._bmember = get('SELECT nick_name FROM member WHERE member_id = ?', row.b_member_id)?.nick_name || '';
  }
  if (mod === 'certification') {
    out._member = get('SELECT nick_name FROM member WHERE member_id = ?', row.member_id)?.nick_name || '';
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

  // 防提权（新建与编辑都要拦）：有「管理员」菜单权限的人，原本可以把自己的角色改成超管，
  // 或者新建一个超管账号。非超管一律不允许把 role_id 指向超管角色。
  if (mod.table === 'store_user' && body.role_id && !isSuperRole(req.admin.role_id) && isSuperRole(body.role_id)) {
    return res.json(fail('只有超级管理员才能分配超管角色'));
  }

  const id = body[mod.pk];
  let relisted = false;   // 本次保存是否把「已回收封顶」的商品重新上架
  // 商品：「库存」是还能抢几个，「名额」是一共几个，两个字段各管各的。
  // 运营把库存调大时名额跟着涨；调小时名额不动 —— 已经卖出去的名额不能凭空消失，
  // 否则剩余名额会被算错，取消订单归还时还会被错误地截断。
  if (mod.table === 'goods') {
    const cur = id ? get('SELECT stock_total, stock_num FROM goods WHERE goods_id = ?', Number(id)) : null;
    const nextStock = 'stock_num' in body ? Number(body.stock_num) || 0 : Number(cur?.stock_num) || 0;
    body.stock_total = Math.max(Number(cur?.stock_total) || 0, nextStock, 1);
    keys.push('stock_total');

    // 价格上限：金额（元），0 = 不限；负数/非法一律归 0
    if ('price_cap' in body) {
      const v = Number(body.price_cap);
      body.price_cap = Number.isFinite(v) && v > 0 ? Math.min(1e9, Number(v.toFixed(2))) : 0;
    }
    // 二次上架：回收封顶的商品只有后台改回「上架」才重新流通。
    // 清掉封顶标记，并把基准价重置为当前售价（水位从 0 重算），否则一上架就是满格红。
    if (id) {
      const rc = get('SELECT recycled, goods_min_price FROM goods WHERE goods_id = ?', Number(id));
      if (Number(rc?.recycled) === 1 && Number(body.goods_status) === 10) {
        relisted = true;
        body.recycled = 0;
        if (!keys.includes('recycled')) keys.push('recycled');
        if (!('base_price' in body) || !(Number(body.base_price) > 0)) {
          body.base_price = Number(body.goods_min_price) > 0 ? Number(body.goods_min_price) : Number(rc.goods_min_price);
          if (!keys.includes('base_price')) keys.push('base_price');
        }
      }
    }
    // 基准价：新建时默认取售卖价（水位从这里起算）；编辑时留空表示保持原值
    if (!id) {
      body.base_price = Number(body.base_price) > 0 ? Number(body.base_price) : (Number(body.goods_min_price) || 0);
      if (!keys.includes('base_price')) keys.push('base_price');
    }
  }
  if (id) {
    const updateKeys = keys.filter((k) => k !== mod.pk && !(k === 'password' && !body[k])
      && !(mod.table === 'member' && k === 'p_id')
      // 基准价留空（0）表示不修改，避免一次误清空就把涨幅起点重置成 0
      && !(mod.table === 'goods' && k === 'base_price' && !(Number(body[k]) > 0)));
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

      // 防提权：有「管理员」菜单权限的人，原本可以把自己的角色改成超管。
      // 规则：非超管既不能分配超管角色，也不能改动超管账号（降级 / 停用 / 改密）。
      const actorIsSuper = isSuperRole(req.admin.role_id);
      if (!actorIsSuper) {
        const targetUser = id ? get('SELECT * FROM store_user WHERE store_user_id = ?', Number(id)) : null;
        if (targetUser && isSuperRole(targetUser.role_id)) {
          return res.json(fail('只有超级管理员才能修改超级管理员账号'));
        }
        if (body.role_id && isSuperRole(body.role_id)) {
          return res.json(fail('只有超级管理员才能分配超管角色'));
        }
      }
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
    if (relisted) {
      const row2 = get('SELECT goods_min_price, price_cap FROM goods WHERE goods_id = ?', Number(id));
      const capWarn = Number(row2?.price_cap) > 0 && Number(row2.price_cap) <= Number(row2.goods_min_price) + 0.004
        ? '；注意价格上限不高于现价，买家买入后会立刻到顶，建议调高上限或清零'
        : '';
      return res.json(ok({ id, relisted: true }, `已解除封顶并重新上架（基准价重置为 ¥${Number(row2?.goods_min_price || 0).toFixed(2)}）${capWarn}`));
    }
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
      is_valid: Number(body.is_valid) || 10, is_certification: Number(body.is_certification) || 0,
      disabled: Number(body.disabled) || 10,
      amount: Number(body.amount) || 0, score: Number(body.score) || 0,
      e_card_number: Number(body.e_card_number) || 0, rush_amount: Number(body.rush_amount) || 0,
      fy_price: Number(body.fy_price) || 0, create_time: now(), update_time: now() };
    ins = [...permittedMemberKeys, 'invitation_code', 'path', 'level', 'password', 'create_time', 'update_time'];
    vals = [...permittedMemberKeys.map((k) => memberValues[k]), code, memberValues.path, memberValues.level,
      hashPwd(body.password), memberValues.create_time, memberValues.update_time];
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
  } else if (mod.table === 'goods') {
    // 商品编码不再让运营手填：新建时按序列自动生成，搜索、复制仍靠它做唯一标识。
    // base_price 已在上面按「取售卖价」补过，这里只补编码与时间戳。
    ins = [...keys, 'goods_no'];
    vals = [...vals, nextGoodsNo()];
    if (mod.fields.some((f) => f.k === 'create_time')) {
      ins = [...ins, 'create_time'];
      vals = [...vals, now()];
    }
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
  if (['orders', 'member', 'energy', 'withdraw', 'settle', 'certification'].includes(moduleName)) {
    return res.json(fail('业务记录需保留审计，不能通过通用接口删除'));
  }
  for (const id of ids) {
    if (moduleName === 'storeuser') {
      const user = get('SELECT store_user_id, role_id FROM store_user WHERE store_user_id = ?', Number(id));
      if (user && (Number(user.store_user_id) === Number(req.admin.store_user_id) || isSuperRole(user.role_id))) {
        return res.json(fail('不能删除当前管理员或超级管理员'));
      }
    }
    if (moduleName === 'role') {
      if (isSuperRole(id)) return res.json(fail('不能删除超级管理员角色'));
      if (get('SELECT 1 FROM store_user WHERE role_id = ?', Number(id))) return res.json(fail('该角色仍被管理员使用，不能删除'));
    }
    if (moduleName === 'goods' && get('SELECT 1 FROM orders WHERE goods_id = ?', Number(id))) {
      return res.json(fail('商品已有关联订单，不能删除'));
    }
    if (moduleName === 'category' && get('SELECT 1 FROM goods WHERE category_id = ?', Number(id))) {
      return res.json(fail('分类下仍有商品，不能删除'));
    }
    // 场次下的商品只存在于关联表里：删场次先把关联清掉，商品本身保留（不连带删货）
    if (moduleName === 'specialarea') clearAreaLinks(id);
  }
  tx(() => ids.forEach((id) => {
    // 商品删掉时把它的场次关联一并清掉，否则关联表会留下指向不存在商品的孤儿行
    if (moduleName === 'goods') run('DELETE FROM specialarea_goods WHERE goods_id = ?', Number(id));
    run(`DELETE FROM ${mod.table} WHERE ${mod.pk} = ?`, id);
  }));
  res.json(ok([], '删除成功'));
});

// ---------------- 订单操作 ----------------
r.post('/orders/deliver', authAdmin, (req, res) => {
  const { order_id, express_no, express_company } = req.body;
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(order_id));
  if (!o) return res.json(fail('订单不存在'));
  if (o.status !== 10) return res.json(fail('当前状态不可发货'));
  // 买家已经把货转拍给别人了，实物不在他手上，发不了也不该发
  if (isTransferredOut(o)) return res.json(fail('该商品已被买家转拍给他人，无需发货'));
  run('UPDATE orders SET status = 20, express_no = ?, express_company = ?, send_time = ? WHERE order_id = ?',
    express_no || '', express_company || '顺丰速运', now(), o.order_id);
  run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    o.order_id, '发货', 'admin', `${express_company || ''} ${express_no || ''}`, now());
  res.json(ok([], '发货成功'));
});

// ---------------- 积分兑换：发货 / 取消退分 ----------------
r.post('/score-exchange/deliver', authAdmin, (req, res) => {
  const { exchange_id, express_no, express_company } = req.body;
  const e = get('SELECT * FROM score_exchange WHERE exchange_id = ?', Number(exchange_id));
  if (!e) return res.json(fail('兑换记录不存在'));
  if (Number(e.status) !== 10) return res.json(fail('当前状态不可发货'));
  if (!express_no) return res.json(fail('请填写快递单号'));
  run(
    'UPDATE score_exchange SET status = 20, express_no = ?, express_company = ?, send_time = ? WHERE exchange_id = ?',
    String(express_no), express_company || '顺丰速运', now(), e.exchange_id,
  );
  res.json(ok([], '发货成功'));
});

/**
 * 取消兑换：退回积分、回滚库存与已兑数。
 * 只在「待发货」可取消 —— 已经发出去的货再退积分就是白送了。
 */
r.post('/score-exchange/cancel', authAdmin, (req, res) => {
  const e = get('SELECT * FROM score_exchange WHERE exchange_id = ?', Number(req.body?.exchange_id));
  if (!e) return res.json(fail('兑换记录不存在'));
  if (Number(e.status) !== 10) return res.json(fail('只有待发货的兑换可以取消'));
  tx(() => {
    run('UPDATE score_exchange SET status = 40, finish_time = ?, remark = ? WHERE exchange_id = ?',
      now(), req.body?.remark || '后台取消', e.exchange_id);
    run('UPDATE member SET score = score + ? WHERE member_id = ?', Number(e.total_score), e.member_id);
    run('UPDATE score_item SET stock = stock + ?, sold = MAX(0, sold - ?) WHERE item_id = ?',
      Number(e.num), Number(e.num), e.item_id);
    run(
      'INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
      e.member_id, Number(e.total_score), 3, '兑换取消退还', `兑换单 ${e.exchange_no}`, now(),
    );
  });
  res.json(ok([], '已取消并退还积分'));
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
  // 只有「待付款」的拆分订单才归还库存：已成交的份额是真卖掉了，再还回去等于凭空多一份
  const unpaid = Number(o.status) === 0;
  run('UPDATE orders SET status = 40 WHERE order_id = ?', o.order_id);
  if (unpaid) restoreStock(o.goods_id, o.num);
  run('INSERT INTO order_log (order_id, action, operator, remark, create_time) VALUES (?,?,?,?,?)',
    o.order_id, '后台取消', 'admin', '', now());
  res.json(ok([], '已取消'));
});

// 确认线下凭证收款（与 H5 余额支付共用同一套结算算法）
// 抽成函数，单笔与批量走同一段逻辑，避免两份实现走偏
function confirmPayOne(orderId) {
  const o = get('SELECT * FROM orders WHERE order_id = ?', Number(orderId));
  if (!o) { const e = new Error('订单不存在'); e.biz = true; throw e; }
  if (o.pay_status === 10) { const e = new Error('订单已确认'); e.biz = true; throw e; }
  // 后台开了「支付凭证必传」才拦；关了就是运营自己承担无凭证确认的风险
  if (Number(cfg('pay_voucher_required', '10')) === 10
    && Number(o.pay_type) !== 1 && !o.pay_voucher) {
    const e = new Error('会员尚未提交支付凭证');
    e.biz = true;
    throw e;
  }
  tx(() => {
    // 确认收款即成交，先核对这件货是否还在订单上的卖家手里。
    // 线下支付的凭证提交在前、这里确认在后，中间商品可能已经被别人买走了
    const own = goodsStillOwnedBySeller(o);
    if (!own.ok) {
      const e = new Error(own.reason);
      e.biz = true;
      throw e;
    }
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
  return o;
}

r.post('/orders/confirm-pay', authAdmin, (req, res) => {
  const { order_id } = req.body;
  try {
    confirmPayOne(order_id);
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok([], '已确认收款'));
});

// 批量确认收款：逐单处理，失败的单如实回报，不做「全成功或全失败」的假象
r.post('/orders/confirm-pay-batch', authAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.order_ids) ? req.body.order_ids.map(Number).filter(Boolean).slice(0, 200) : [];
  if (!ids.length) return res.json(fail('请先勾选订单'));
  const done = [];
  const failed = [];
  for (const id of ids) {
    try {
      confirmPayOne(id);
      done.push(id);
    } catch (e) {
      if (!e.biz) throw e;
      failed.push({ order_id: id, msg: e.message });
    }
  }
  if (!done.length) {
    const first = failed[0]?.msg || '没有可确认的订单';
    return res.json(fail(failed.length > 1 ? `${failed.length} 笔都没能确认：${first}` : first));
  }
  const msg = failed.length ? `已确认 ${done.length} 笔，${failed.length} 笔跳过` : `已确认 ${done.length} 笔收款`;
  res.json(ok({ done: done.length, failed }, msg));
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

// 提现审核（单笔与批量共用）
function auditWithdrawOne(withdrawId, pass, remark) {
  const w = get('SELECT * FROM finance_withdraw WHERE withdraw_id = ?', Number(withdrawId));
  if (!w) { const e = new Error('记录不存在'); e.biz = true; throw e; }
  if (w.status !== 0) { const e = new Error('该申请已处理'); e.biz = true; throw e; }
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
  return w;
}

r.post('/withdraw/audit', authAdmin, (req, res) => {
  const { withdraw_id, pass, remark } = req.body;
  try {
    auditWithdrawOne(withdraw_id, pass, remark);
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok([], pass ? '已通过' : '已驳回'));
});

// 批量审核提现：逐笔处理，失败如实回报
r.post('/withdraw/audit-batch', authAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.withdraw_ids) ? req.body.withdraw_ids.map(Number).filter(Boolean).slice(0, 200) : [];
  const pass = Boolean(req.body?.pass);
  const remark = req.body?.remark || '';
  if (!ids.length) return res.json(fail('请先勾选提现申请'));
  const done = [];
  const failed = [];
  for (const id of ids) {
    try {
      auditWithdrawOne(id, pass, remark);
      done.push(id);
    } catch (e) {
      if (!e.biz) throw e;
      failed.push({ withdraw_id: id, msg: e.message });
    }
  }
  if (!done.length) {
    const first = failed[0]?.msg || '没有可处理的申请';
    return res.json(fail(failed.length > 1 ? `${failed.length} 笔都没能处理：${first}` : first));
  }
  const verb = pass ? '通过' : '驳回';
  const msg = failed.length ? `已${verb} ${done.length} 笔，${failed.length} 笔跳过` : `已${verb} ${done.length} 笔`;
  res.json(ok({ done: done.length, failed }, msg));
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
