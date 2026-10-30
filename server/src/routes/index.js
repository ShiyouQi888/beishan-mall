import { Router } from 'express';
import { useCascaderAreaData } from '@vant/area-data';
import { themeOf, DEFAULT_THEME } from '../lib/themes.js';
import { all, get } from '../db.js';
import { ok, fail, authMember } from '../lib/helper.js';

const r = Router();

/** 读取一项系统设置 */
export function cfg(key, def = '') {
  const row = get('SELECT `value` FROM setting_config WHERE `key` = ?', key);
  return row ? row.value : def;
}

const cfgNumber = (key, fallback) => {
  const raw = cfg(key, '');
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

// 轮播图
r.get('/index/getBannerList', (req, res) => {
  const typeId = Number(req.query.type_id) || 1;
  const list = all(
    'SELECT banner_id, file_path, link_url, sort FROM shop_banner WHERE type_id = ? ORDER BY sort ASC, banner_id DESC',
    typeId,
  );
  res.json(ok(list));
});

// 首页宫格导航
r.get('/index/getNavLists', (req, res) => {
  const list = all(
    'SELECT id, title, icon_name, file_path, link_url FROM shop_navigation WHERE disabled = 10 ORDER BY sort ASC, id ASC',
  );
  res.json(ok(list));
});

// 店铺信息 / 客服
r.get('/index/getStoreInfo', (req, res) => {
  res.json(
    ok({
      name: cfg('store_name', '示范商城'),
      logo: cfg('store_logo', ''),
      copyright: cfg('copyright', ''),
      icp_number: cfg('icp_number', ''),
      mobile: cfg('store_mobile', ''),
      customer_type: cfg('customer_type', '1'),
      customer_service: cfg('customer_service', ''),
      customer_link: cfg('customer_link', '#'),
      toExamine: cfg('to_examine', '10'),
      score_open: cfg('score_open', '10'),
      // 外观主题：key + 该主题的全部 CSS 变量，H5 启动时写到 :root
      theme: (() => { const t = themeOf(cfg('theme_key', DEFAULT_THEME)); return { key: t.key, name: t.name, vars: t.vars }; })(),
    }),
  );
});

// 底部导航开放配置
r.get('/index/getOpenNavigation', (req, res) => {
  res.json(
    ok({
      index_open: cfg('nav_index', '10'),
      category_open: cfg('nav_category', '10'),
      cart_open: cfg('nav_cart', '20'),
      invite_open: cfg('nav_invite', '10'),
      loot_open: cfg('nav_loot', '10'),
      member_open: cfg('nav_member', '10'),
      // 首页整条商品分类栏的开关（单个分类的显隐另由 goods_category.home_show 控制）
      home_category_open: cfg('home_category_show', '10'),
    }),
  );
});

// 分享 / 版权信息
r.get('/index/getShareInfo', (req, res) => {
  res.json(
    ok({
      name: cfg('store_name', '示范商城'),
      mobile: cfg('store_mobile', ''),
      copyright: cfg('copyright', ''),
      icp_number: cfg('icp_number', ''),
      toExamine: cfg('to_examine', '10'),
      logo: cfg('store_logo', ''),
      region_bg_img: cfg('region_bg_img', ''),
    }),
  );
});

// 邀请海报配置（后台所配内容供 H5 预览和生成个人邀请海报）
r.get('/index/getInvitePoster', (req, res) => {
  res.json(ok({
    background: cfg('poster_bg', ''),
    logo: cfg('poster_logo', cfg('store_logo', '')),
    qr_x: cfgNumber('poster_qr_x', 265),
    qr_y: cfgNumber('poster_qr_y', 850),
    qr_size: cfgNumber('poster_qr_size', 220),
    logo_x: cfgNumber('poster_logo_x', 54),
    logo_y: cfgNumber('poster_logo_y', 60),
    logo_size: cfgNumber('poster_logo_size', 116),
    title: cfg('poster_title', '邀请好友加入'),
    title_show: cfg('poster_title_show', '10'),
    title_x: cfgNumber('poster_title_x', 60),
    title_y: cfgNumber('poster_title_y', 240),
    title_size: cfgNumber('poster_title_size', 54),
    title_color: cfg('poster_title_color', '#ffffff'),
    title_align: cfg('poster_title_align', 'left'),
    subtitle: cfg('poster_subtitle', '一起分享好物与收益'),
    subtitle_show: cfg('poster_subtitle_show', '10'),
    subtitle_x: cfgNumber('poster_subtitle_x', 60),
    subtitle_y: cfgNumber('poster_subtitle_y', 315),
    subtitle_size: cfgNumber('poster_subtitle_size', 30),
    subtitle_color: cfg('poster_subtitle_color', '#ffffff'),
    subtitle_align: cfg('poster_subtitle_align', 'left'),
    content: cfg('poster_content', '长按识别二维码，立即加入'),
    content_show: cfg('poster_content_show', '10'),
    content_x: cfgNumber('poster_content_x', 60),
    content_y: cfgNumber('poster_content_y', 1190),
    content_size: cfgNumber('poster_content_size', 25),
    content_color: cfg('poster_content_color', '#ffffff'),
    content_align: cfg('poster_content_align', 'center'),
    code_label: cfg('poster_code_label', '邀请码：'),
    code_show: cfg('poster_code_show', '10'),
    code_x: cfgNumber('poster_code_x', 60),
    code_y: cfgNumber('poster_code_y', 1280),
    code_size: cfgNumber('poster_code_size', 22),
    code_color: cfg('poster_code_color', '#ffffff'),
    code_align: cfg('poster_code_align', 'center'),
  }));
});

// 版本信息
r.get('/index/getVision', (req, res) => {
  res.json(
    ok({
      android_down_link: cfg('android_down_link', '#'),
      android_vision: cfg('android_vision', '1.0.0'),
      android_content: cfg('android_content', '1.首个版本发布'),
      ios_down_link: cfg('ios_down_link', '#'),
      ios_vision: cfg('ios_vision', '1.0.0'),
      ios_content: cfg('ios_content', '1.首个版本发布'),
    }),
  );
});

// 预约设置
r.get('/index/getSubscribeSetting', (req, res) => {
  res.json(
    ok({
      subscribe_open: cfg('subscribe_open', '0'),
      subscribe_e_card: cfg('subscribe_e_card', '0'),
      e_card_number: '0.00',
    }),
  );
});

// 邀请须知
r.get('/index/getInvitationNotice', (req, res) => {
  res.json(ok({ prompt_values: cfg('prompt_invite', cfg('invitation_notice', '')) }));
});

// 注册协议由后台「须知配置」维护，前台注册页提供独立查看入口。
r.get('/index/getRegisterAgreements', (req, res) => {
  res.json(ok({
    user: cfg('prompt_register', cfg('register_agreement', '')),
    privacy: cfg('prompt_privacy', ''),
    // 注册页要据此决定邀请码是否必填
    require_invite_code: Number(cfg('require_invite_code', '10')) === 10 ? '1' : '0',
  }));
});

// 售后 / 交易协议
r.get('/index/getGroupAfterSalesAgreement', (req, res) => {
  res.json(
    ok({
      shop_agreement: cfg('prompt_shop', cfg('shop_agreement', '')),
      transaction_agreement: cfg('prompt_trade', cfg('transaction_agreement', '')),
    }),
  );
});

// 支付开关：库里统一用 10 开 / 20 关（与后台开关组件一致），对外仍返回 '1'/'0'
const switchOn = (key, def = '20') => (Number(cfg(key, def)) === 10 ? '1' : '0');
r.get('/index/getPaySeeting', (req, res) => {
  res.json(
    ok({
      balance_open: switchOn('pay_balance_open', '10'),
      wx_open: switchOn('pay_wx', '10'),
      zfb_open: switchOn('pay_zfb', '10'),
      bank_open: switchOn('pay_bank', '20'),
      wx_qr_ready: cfg('wx_qr', '') ? '1' : '0',
      zfb_qr_ready: cfg('zfb_qr', '') ? '1' : '0',
    }),
  );
});

r.get('/getPayGatWay', (req, res) => {
  res.json(ok({ is_open: Number(cfg('pay_gateway_open', '10')) }));
});

// 寄卖开关
r.get('/index/close_consignment', (req, res) => {
  const v = cfg('consignment_open', '10');
  res.json(ok({ text: v === '10' ? '已开启' : '已关闭', value: Number(v) }));
});

// 交易费率（转拍上架费 / 直推奖）
r.get('/index/getTradeConfig', (req, res) => {
  res.json(
    ok({
      listing_fee_rate: cfg('listing_fee_rate', '2.8'),
      service_charge: cfg('service_charge', '0'),
      price_increase_rate: cfg('price_increase_rate', '3'),
      drive_award_rate: cfg('drive_award_rate', '0.5'),
      consignment_open: cfg('consignment_open', '10'),
      withdraw_min: cfg('withdraw_min', '10'),
      withdraw_fee: cfg('withdraw_fee', '1'),
    }),
  );
});

// 当前登录会员ID
r.get('/index/getMemberId', authMember, (req, res) => res.json(ok(req.member.member_id)));

// 公告
r.get('/notice/getNotice', (req, res) => {
  res.json(ok(all('SELECT id, title, content, create_time FROM notice ORDER BY sort ASC, id DESC')));
});

r.get('/member/getNotice', (req, res) => {
  res.json(ok({ content: cfg('prompt_register', cfg('register_agreement', '')) }));
});

// 地区树：服务启动时加载完整省市区数据，避免依赖数据库里的演示地区。
const regionList = useCascaderAreaData().map((province) => ({
  id: Number(province.value),
  pid: 0,
  name: province.text,
  level: 1,
  city: (province.children || []).map((city) => ({
    id: Number(city.value),
    pid: Number(province.value),
    name: city.text,
    level: 2,
    region: (city.children || []).map((district) => ({
      id: Number(district.value),
      pid: Number(city.value),
      name: district.text,
      level: 3,
    })),
  })),
}));

r.get('/region/getAllList', (req, res) => {
  res.json(ok(regionList));
});

export default r;
