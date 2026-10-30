import { Router } from 'express';
import { all, get } from '../db.js';
import { ok, fail, authMember } from '../lib/helper.js';

const r = Router();

/** 读取一项系统设置 */
export function cfg(key, def = '') {
  const row = get('SELECT `value` FROM setting_config WHERE `key` = ?', key);
  return row ? row.value : def;
}

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
      recharge_status: cfg('recharge_status', '10'),
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
      recharge_status: cfg('recharge_status', '10'),
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
    qr_x: Number(cfg('poster_qr_x', '265')) || 0,
    qr_y: Number(cfg('poster_qr_y', '850')) || 0,
    qr_size: Number(cfg('poster_qr_size', '220')) || 220,
    logo_x: Number(cfg('poster_logo_x', '54')) || 0,
    logo_y: Number(cfg('poster_logo_y', '60')) || 0,
    logo_size: Number(cfg('poster_logo_size', '116')) || 116,
    title: cfg('poster_title', '邀请好友加入'),
    title_x: Number(cfg('poster_title_x', '60')) || 0,
    title_y: Number(cfg('poster_title_y', '240')) || 0,
    title_size: Number(cfg('poster_title_size', '54')) || 54,
    subtitle: cfg('poster_subtitle', '一起分享好物与收益'),
    subtitle_x: Number(cfg('poster_subtitle_x', '60')) || 0,
    subtitle_y: Number(cfg('poster_subtitle_y', '315')) || 0,
    subtitle_size: Number(cfg('poster_subtitle_size', '30')) || 30,
    content: cfg('poster_content', '长按识别二维码，立即加入'),
    content_x: Number(cfg('poster_content_x', '60')) || 0,
    content_y: Number(cfg('poster_content_y', '1190')) || 0,
    content_size: Number(cfg('poster_content_size', '25')) || 25,
    code_x: Number(cfg('poster_code_x', '60')) || 0,
    code_y: Number(cfg('poster_code_y', '1280')) || 0,
    code_size: Number(cfg('poster_code_size', '22')) || 22,
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
      wx_open: switchOn('pay_wx', '10'),
      zfb_open: switchOn('pay_zfb', '10'),
      bank_open: switchOn('pay_bank', '20'),
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
      same_level_award_rate: cfg('same_level_award_rate', '0'),
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

// 地区树
r.get('/region/getAllList', (req, res) => {
  const provinces = all('SELECT * FROM region WHERE pid = 0 ORDER BY id');
  const out = provinces.map((p) => {
    const cities = all('SELECT * FROM region WHERE pid = ? ORDER BY id', p.id);
    return {
      id: p.id,
      pid: 0,
      name: p.name,
      level: 1,
      city: cities.map((c) => ({
        id: c.id,
        pid: p.id,
        name: c.name,
        level: 2,
        region: all('SELECT id, pid, name, level FROM region WHERE pid = ? ORDER BY id', c.id),
      })),
    };
  });
  res.json(ok(out));
});

export default r;
