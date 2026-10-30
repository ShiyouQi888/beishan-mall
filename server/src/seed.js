import { db, all, get, run, now, tx } from './db.js';
import { hashPwd, randomCode } from './lib/auth.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 先建表
db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8'));

const __dirname = dirname(fileURLToPath(import.meta.url));
// 与运行时一致：可用 UPLOAD_DIR 覆盖（Docker 数据卷）
const UP = process.env.UPLOAD_DIR || join(__dirname, '..', 'data', 'uploads');
mkdirSync(UP, { recursive: true });

/** 生成一张带文字的商品占位图（SVG，离线可用） */
function makeImg(name, c1, c2, file) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/>
<circle cx="300" cy="262" r="126" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1.4"/>
<circle cx="300" cy="262" r="96" fill="rgba(255,255,255,.10)"/>
<circle cx="300" cy="262" r="62" fill="rgba(255,255,255,.14)"/>
<text x="300" y="470" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif" font-size="40" fill="rgba(255,255,255,.92)"
 text-anchor="middle" font-weight="600" letter-spacing="4">${name}</text>
</svg>`;
  writeFileSync(join(UP, file), svg);
  return `/uploads/${file}`;
}

function makeBanner(file) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#9c2530"/><stop offset="55%" stop-color="#6b1420"/><stop offset="100%" stop-color="#320a10"/></linearGradient></defs>
<rect width="800" height="450" fill="url(#g)"/>
<circle cx="650" cy="100" r="155" fill="rgba(255,255,255,.045)"/>
<circle cx="110" cy="370" r="115" fill="rgba(255,255,255,.035)"/>
<rect x="200" y="92" width="400" height="266" rx="4" fill="none" stroke="#c9a55f" stroke-width="1.2" opacity=".45"/>
<text x="400" y="212" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif" font-size="58" fill="#f5e6c8"
 text-anchor="middle" font-weight="700" letter-spacing="12">北山商城</text>
<line x1="310" y1="244" x2="490" y2="244" stroke="#c9a55f" stroke-width="1.4" opacity=".6"/>
<text x="400" y="292" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif" font-size="22" fill="rgba(245,230,200,.82)"
 text-anchor="middle" letter-spacing="9">精品臻选 · 正品保障</text>
</svg>`;
  writeFileSync(join(UP, file), svg);
  return `/uploads/${file}`;
}

const already = get('SELECT COUNT(*) c FROM store_user').c > 0;

if (already) {
  console.log('数据已存在，跳过初始化。如需重建请删除 server/data/mall.db');
  process.exit(0);
}

tx(() => {
  // ---------- 后台角色（会员等级见 member_grade，两者不再混用一张表） ----------
  run('INSERT INTO store_role (role_id, role_name, description, create_time) VALUES (?,?,?,?)',
    6, '超级管理员', '拥有全部权限，不受节点限制', now());
  run('INSERT INTO store_role (role_id, role_name, description, create_time) VALUES (?,?,?,?)',
    7, '运营', '日常运营，按节点授权', now());

  run('INSERT INTO store_user (user_name, password, nick_name, role_id, status, create_time) VALUES (?,?,?,?,?,?)',
    'admin1', hashPwd('123456'), '超级管理员', 6, 10, now());

  // ---------- 会员等级（对齐原站等级体系） ----------
  const grades = [
    [1, '普通会员', 1, 0, 0, 0],
    [2, '白银级', 1, 1, 5, 0],
    [3, '黄金级', 1, 1, 10, 0],
    [4, '砖石级', 1, 1, 20, 0],
    [5, '王者级', 1, 1, 30, 0],
  ];
  for (const [id, name, drive, valid, water, award] of grades) {
    run('INSERT INTO member_grade (grade_id, name, drive_num, team_valid, team_water, team_award, create_time) VALUES (?,?,?,?,?,?,?)',
      id, name, drive, valid, water, award, now());
  }

  // ---------- 系统设置 ----------
  const settings = [
    ['store_name', '北山商城', 'store'],
    ['store_mobile', '400-888-8888', 'store'],
    ['copyright', '版权所有 © 北山商城 2026', 'store'],
    ['icp_number', 'ICP备00000000号', 'store'],
    ['customer_link', '#', 'store'],
    // 演示默认口径：抢单服务费 2%、上架费 0、提现手续费 0、转拍涨价 3%
    // （原站实证为 上架费 2.8% / 服务费 0，此处按业务决策改为以服务费为主要收入）
    ['listing_fee_rate', '0', 'trade'],
    ['drive_award_rate', '0.5', 'trade'],
    ['same_level_award_rate', '0', 'trade'],
    ['service_charge', '2', 'trade'],
    ['consignment_open', '10', 'trade'],
    ['require_receiving_account', '20', 'trade'],
    ['require_invite_code', '10', 'trade'],  // 注册是否强制邀请码：10 必须 / 20 可选
    ['price_increase_rate', '3', 'trade'],
    ['consignment_rule', '转拍免上架费；商品按后台涨价率自动加价进入下一轮，成交后货款全额结算给上一手持有人。', 'trade'],
    ['withdraw_min', '10', 'trade'],
    ['withdraw_fee', '0', 'trade'],
    ['pay_wx', '10', 'pay'],
    ['pay_zfb', '10', 'pay'],
    ['pay_bank', '20', 'pay'],
    ['pay_gateway_open', '10', 'pay'],
    ['auction_open', '0', 'auction'],
    ['auction_start_price', '80', 'auction'],
    ['auction_step', '100', 'auction'],
    ['nav_index', '10', 'nav'],
    ['nav_category', '10', 'nav'],
    ['nav_cart', '20', 'nav'],
    ['nav_loot', '10', 'nav'],
    ['nav_member', '10', 'nav'],
    ['subscribe_open', '0', 'nav'],
    ['subscribe_e_card', '50', 'nav'],
    ['prompt_register', '<p>请认真阅读并同意本商城的《用户注册协议》后再进行注册。</p>', 'prompt'],
    ['prompt_invite', '<p>邀请好友注册，好友完成交易后可获得佣金奖励。</p>', 'prompt'],
    ['prompt_shop', '<p>商城服务协议内容。</p>', 'prompt'],
    ['prompt_trade', '<p>交易规则：商品一经售出，非质量问题不予退换。</p>', 'prompt'],
    ['prompt_loot', '<p>抢购成功后请在 30 分钟内完成支付，超时订单自动关闭。</p>', 'prompt'],
    ['prompt_consign', '<p>转拍免上架费；商品按平台设定的涨价率自动加价后进入下一轮，成交后货款全额结算给上一手持有人。</p>', 'prompt'],
    ['prompt_withdraw', '<p>提现申请审核通过后 T+1 个工作日到账。</p>', 'prompt'],
    ['customer_type', '1', 'store'],
    ['to_examine', '10', 'store'],
    ['recharge_status', '10', 'store'],
    ['region_bg_img', '', 'store'],
    ['android_vision', '1.0.0', 'store'],
  ];
  for (const [k, v, g] of settings) {
    run('INSERT INTO setting_config (`key`, `value`, `group`) VALUES (?,?,?)', k, v, g);
  }

  // ---------- 图片资源 ----------
  const imgGold = makeImg('金镶玉', '#c99a4b', '#8a5f22', 'demo-1.svg');
  const imgPearl = makeImg('珍珠项链', '#d9d2c5', '#9c8f78', 'demo-2.svg');
  const imgJade = makeImg('翡翠吊坠', '#4f8a6b', '#1f4536', 'demo-3.svg');
  const imgWatch = makeImg('腕表', '#6b7b8c', '#2f3a45', 'demo-4.svg');
  const imgRing = makeImg('钻戒', '#c8ccd4', '#7b8494', 'demo-5.svg');
  const imgBanner = makeBanner('banner-1.svg');

  // ---------- 分类 ----------
  const cats = [
    ['珠宝首饰', 101, 2],
    ['翡翠玉器', 102, 2],
    ['名表腕表', 103, 2],
    ['文玩工艺', 104, 2],
  ];
  cats.forEach(([n, s, t]) =>
    run('INSERT INTO goods_category (name, type, sort, create_time) VALUES (?,?,?,?)', n, t, s, now()),
  );

  // ---------- 场次 ----------
  const areas = [
    ['forenoon', '上午场 · 精选专场', '✔️顶级精品，✔️优质服务，✔️实名认证', 8 * 3600, 13 * 3600, 10, 100],
    ['afternoon', '下午场 · 臻品专场', '✔️正品保障，✔️极速发货，✔️售后无忧', 13 * 3600, 18 * 3600, 10, 90],
    ['evening', '晚间场 · 珍藏专场', '✔️限量发售，✔️顺丰包邮，✔️假一赔十', 18 * 3600, 23 * 3600 + 59 * 60, 10, 80],
  ];
  areas.forEach(([n, t, sub, st, et, buy, srt]) =>
    run(
      `INSERT INTO specialarea (name, title_main, title_ordinary, image_ordinary, start_time, end_time,
        open_days, buy_num, transposition_hours, is_subscribe, is_open, sort, create_time)
       VALUES (?,?,?,?,?,?,?,?,?,0,10,?,?)`,
      n, t, sub, imgBanner, st, et, '1,2,3,4,5,6,7', buy, 10, srt, now(),
    ),
  );

  // ---------- 演示会员（三级分销链） ----------
  const mkMember = (nick, mobile, pId, code) => {
    const parent = pId ? get('SELECT * FROM member WHERE member_id = ?', pId) : null;
    const info = run(
      `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code, identity_vip,
        is_valid, amount, score, e_card_number, is_certification, disabled, client_type, create_time, update_time)
       VALUES (?,?,?,?,?,?,?,?,10,?,0,0,1,10,3,?,?)`,
      nick, mobile, hashPwd(mobile), pId, parent ? `${parent.path}${parent.member_id}/` : '/',
      parent ? (parent.level || 1) + 1 : 1, code, pId ? 1 : 0, pId ? 5000 : 0, now(), now(),
    );
    const id = Number(info.lastInsertRowid);
    if (pId) {
      const p = get('SELECT child_id FROM member WHERE member_id = ?', pId);
      const arr = p.child_id ? p.child_id.split(',') : [];
      arr.push(String(id));
      run('UPDATE member SET child_id = ? WHERE member_id = ?', arr.join(','), pId);
    }
    return id;
  };

  const boss = mkMember('总部运营', '13800000001', 0, 'boss01');
  const a1 = mkMember('玄德世家', '13800000002', boss, 'a1a1a1');
  const a2 = mkMember('北山', '13822367845', a1, 'b2b2b2');
  const a3 = mkMember('云中客', '13800000004', a2, 'c3c3c3');
  run('UPDATE member SET amount = 20000, e_card_number = 1200, score = 500 WHERE member_id = ?', a2);
  run('UPDATE member SET amount = 8000 WHERE member_id = ?', a1);
  run('UPDATE member SET amount = 3000 WHERE member_id = ?', boss);

  // ---------- 商品 ----------
  const goodsData = [
    ['星落仓池', 'GP20260001', imgJade, 16800, 22800, 1, 1, a1],
    ['蓝沁云露', 'GP20260002', imgPearl, 16800, 21800, 1, 1, boss],
    ['金镶玉如意', 'GP20260003', imgGold, 9800, 12800, 1, 2, a1],
    ['冰种翡翠戒', 'GP20260004', imgRing, 12800, 16800, 2, 2, a2],
    ['瑞士机械腕表', 'GP20260005', imgWatch, 5800, 8800, 2, 3, boss],
    ['和田玉手串', 'GP20260006', imgJade, 3600, 5200, 3, 3, a1],
    ['天然珍珠耳饰', 'GP20260007', imgPearl, 2600, 3800, 3, 1, a2],
    ['足金转运珠', 'GP20260008', imgGold, 1800, 2600, 1, 2, boss],
  ];
  goodsData.forEach(([n, no, thumb, price, line, area, cat, holder], i) => {
    run(
      `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id,
        member_id, goods_min_price, line_price, stock_num, sales_actual, goods_status, is_sell, is_split,
        turn_beat_num, goods_sort, type, create_time, update_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,10,10,0,?,?,1,?,?)`,
      n, no, thumb, JSON.stringify([thumb]), `<p>${n} · 精选正品，支持复检，顺丰包邮。</p>`,
      cat, area, holder, price, line, 1, Math.floor(Math.random() * 8), Math.floor(Math.random() * 5),
      100 - i, now(), now(),
    );
  });

  // 商城商品（普通购物）
  const shopGoods = [
    ['茶具礼盒', imgGold, 399, 599, 1],
    ['丝巾', imgPearl, 259, 399, 1],
  ];
  shopGoods.forEach(([n, thumb, price, line, cat], i) => {
    run(
      `INSERT INTO goods (goods_name, goods_no, good_thumb, images, detail, category_id, specialarea_id,
        member_id, goods_min_price, line_price, stock_num, goods_status, goods_sort, type, create_time, update_time)
       VALUES (?,?,?,?,?,0,0,0,?,?,?,10,?,2,?,?)`,
      n, `SP2026${String(i + 1).padStart(4, '0')}`, thumb, JSON.stringify([thumb]),
      `<p>${n} · 商城自营商品</p>`, price, line, 100, 100 - i, now(), now(),
    );
  });

  // ---------- 轮播 / 导航 ----------
  run('INSERT INTO shop_banner (type_id, file_path, link_url, sort, create_time) VALUES (1,?,?,100,?)', imgBanner, '', now());
  const navs = [
    ['限时抢购', 'loot', 1, 1],
    ['积分商城', 'score', 2, 2],
    ['我的订单', 'order', 3, 3],
    ['邀请好友', 'invite', 4, 4],
    ['实名认证', 'certify', 5, 5],
  ];
  navs.forEach(([t, link, sort, type]) =>
    run('INSERT INTO shop_navigation (title, icon_name, link_url, type, sort, disabled, create_time) VALUES (?,?,?,?,?,10,?)',
      t, t.slice(0, 1), link, type, sort, now()),
  );

  // ---------- 公告 ----------
  run('INSERT INTO notice (title, content, sort, create_time) VALUES (?,?,?,?)',
    '平台交易规则说明', '<p>1. 所有商品均支持复检；<br/>2. 抢购成功后请在 30 分钟内完成支付；<br/>3. 寄卖商品由平台统一撮合。</p>', 100, now());
  run('INSERT INTO notice (title, content, sort, create_time) VALUES (?,?,?,?)',
    '关于提现到账时间', '<p>提现申请审核通过后 T+1 个工作日到账。</p>', 99, now());

  // ---------- 充值套餐 ----------
  [[100, 105, 5], [500, 520, 30], [1000, 1060, 80]].forEach(([f, p, i], idx) =>
    run('INSERT INTO recharge_package (face_value, price, integral, is_open, sort) VALUES (?,?,?,10,?)',
      f, p, i, 100 - idx),
  );

  // ---------- 地区（演示数据） ----------
  const regions = {
    北京市: [['北京市', ['东城区', '西城区', '朝阳区', '海淀区', '丰台区']]],
    上海市: [['上海市', ['黄浦区', '徐汇区', '长宁区', '静安区', '浦东新区']]],
    广东省: [['广州市', ['天河区', '越秀区', '海珠区', '番禺区']], ['深圳市', ['福田区', '南山区', '罗湖区', '宝安区']], ['东莞市', ['莞城街道', '南城街道', '东城街道']]],
    浙江省: [['杭州市', ['西湖区', '上城区', '拱墅区', '余杭区']], ['宁波市', ['海曙区', '江北区', '鄞州区']]],
    江苏省: [['南京市', ['玄武区', '鼓楼区', '建邺区', '江宁区']], ['苏州市', ['姑苏区', '吴中区', '工业园区']]],
    四川省: [['成都市', ['锦江区', '青羊区', '武侯区', '高新区']]],
    湖北省: [['武汉市', ['江岸区', '武昌区', '洪山区', '江汉区']]],
    河南省: [['郑州市', ['金水区', '二七区', '中原区', '郑东新区']]],
  };
  let rid = 1;
  for (const [prov, cities] of Object.entries(regions)) {
    const pid = rid;
    run('INSERT INTO region (id, pid, name, level) VALUES (?,0,?,1)', rid++, prov);
    for (const [city, districts] of cities) {
      const cid = rid;
      run('INSERT INTO region (id, pid, name, level) VALUES (?,?,?,2)', rid++, pid, city);
      for (const d of districts) {
        run('INSERT INTO region (id, pid, name, level) VALUES (?,?,?,3)', rid++, cid, d);
      }
    }
  }

  // ---------- 积分商品 ----------
  const sg = get("SELECT goods_id FROM goods WHERE type = 2 LIMIT 1");
  if (sg) run('INSERT INTO score_goods (goods_id, score, stock, sort) VALUES (?,?,?,100)', sg.goods_id, 500, 20);

  // ---------- 示例订单 ----------
  const g1 = get("SELECT * FROM goods WHERE goods_name = '星落仓池'");
  if (g1) {
    run(
      `INSERT INTO orders (order_no, member_id, seller_id, goods_id, goods_name, goods_thumb, specialarea_id,
        type, price, num, total_price, service_charge, status, pay_status, pay_type, create_time, pay_time)
       VALUES (?,?,?,?,?,?,?,1,?,1,?,?,10,10,1,?,?)`,
      'Q20261029000001', a3, g1.member_id, g1.goods_id, g1.goods_name, g1.good_thumb, g1.specialarea_id,
      g1.goods_min_price, g1.goods_min_price, g1.goods_min_price * 0.05, now(), now(),
    );
  }
});

console.log('初始化完成');
console.log('后台账号: admin1 / 123456');
console.log('H5 账号: 13822367845 / 13822367845');
