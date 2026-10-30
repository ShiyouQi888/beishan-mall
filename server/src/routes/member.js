import { Router } from 'express';
import { all, get, run, tx, now, today } from '../db.js';
import { ok, fail, authMember, page, money, cfg, calcNextPrice, priceIncreaseRate, assetUrl } from '../lib/helper.js';
import { calcListingFee } from '../lib/settle.js';
import { hashPwd, verifyPwd, signMember, randomCode } from '../lib/auth.js';

const r = Router();

/** 生成唯一邀请码 */
function uniqueCode() {
  let c = randomCode(6);
  while (get('SELECT 1 FROM member WHERE invitation_code = ?', c)) c = randomCode(6);
  return c;
}

// ---------------- 登录 / 注册 ----------------
r.post('/accountLogin', (req, res) => {
  const { phone, password } = req.body;
  if (!phone) return res.json(fail('请先输入登录的手机号'));
  if (!password) return res.json(fail('请先输入登录密码'));
  const m = get('SELECT * FROM member WHERE mobile = ?', String(phone).trim());
  if (!m) return res.json(fail('该账号不存在，请先注册'));
  if (m.disabled !== 10) return res.json(fail('账号已被禁用，请联系客服'));
  if (!verifyPwd(password, m.password)) return res.json(fail('密码错误,请修改后重新登录'));
  run('UPDATE member SET update_time = ? WHERE member_id = ?', now(), m.member_id);
  res.json(ok({ token: signMember(m.member_id), member_id: m.member_id }, '登录成功'));
});

r.post('/registerAnAccount', (req, res) => {
  const { phone, password, code, nickName, pwd } = req.body;
  const pwdv = password || pwd;
  if (!phone) return res.json(fail('请先输入手机号'));
  if (!/^1\d{10}$/.test(String(phone))) return res.json(fail('手机号格式不正确'));
  if (!pwdv) return res.json(fail('请先输入密码'));
  if (get('SELECT 1 FROM member WHERE mobile = ?', String(phone))) return res.json(fail('该手机号已注册'));

  // 邀请码是否必填由后台「交易设置 → 注册必须填邀请码」控制，默认必须
  const requireCode = Number(cfg('require_invite_code', '10')) === 10;
  const codeStr = String(code || '').trim();
  if (requireCode && !codeStr) return res.json(fail('请先输入邀请码'));
  // 关闭时留空可注册（无上级）；但只要填了就必须有效，避免用户以为绑上了其实没有
  const parent = codeStr ? get('SELECT * FROM member WHERE invitation_code = ?', codeStr) : null;
  if (codeStr && !parent) return res.json(fail('邀请码不存在'));

  const id = tx(() => {
    const myCode = uniqueCode();
    const info = run(
      `INSERT INTO member (nick_name, mobile, password, p_id, path, level, invitation_code,
        identity_vip, is_valid, disabled, client_type, create_time, update_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      nickName || `用户${String(phone).slice(-4)}`,
      String(phone).trim(),
      hashPwd(pwdv),
      parent ? parent.member_id : 0,
      parent ? `${parent.path || '/'}${parent.member_id}/` : '/',
      parent ? Number(parent.level || 1) + 1 : 1,
      myCode,
      0, 10, 10, 3, now(), now(),
    );
    const newId = Number(info.lastInsertRowid);
    // 维护上级 child_id（无上级时跳过）
    if (parent) {
      const childs = parent.child_id ? parent.child_id.split(',').filter(Boolean) : [];
      childs.push(String(newId));
      run('UPDATE member SET child_id = ? WHERE member_id = ?', childs.join(','), parent.member_id);
    }
    return newId;
  });

  const m = get('SELECT * FROM member WHERE member_id = ?', id);
  res.json(ok({ token: signMember(id), member_id: id }, '注册成功'));
});

// ---------------- 资料 ----------------
r.get('/getMemberDetails', authMember, (req, res) => {
  const m = req.member;
  const parent = m.p_id ? get('SELECT nick_name FROM member WHERE member_id = ?', m.p_id) : null;
  const teamCount = get('SELECT COUNT(*) c FROM member WHERE path LIKE ?', `%/${m.member_id}/%`)?.c || 0;
  const childCount = m.child_id ? m.child_id.split(',').filter(Boolean).length : 0;
  const avatar = assetUrl(m.avatar_url);

  const todayProfit = get(
    'SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1 AND create_time >= ?',
    m.member_id,
    today(),
  )?.v;

  res.json(
    ok({
      member_id: m.member_id,
      nickName: m.nick_name,
      mobile: m.mobile.slice(0, 3) + '****' + m.mobile.slice(-4),
      z_phone: m.mobile,
      headimg: avatar,
      referrer_name: parent?.nick_name || '',
      score: m.score,
      team_count: teamCount,
      child_count: childCount,
      distribution_amount: m.distribution_amount.toFixed(2),
      is_certification: m.is_certification,
      is_certification_name: m.is_certification_name || '',
      certification_name: m.certification_name || '',
      invitation_code: m.invitation_code,
      todayAchievement: '0.00',
      todayProfit: money(todayProfit),
      todayCommission: money(todayProfit),
      teamAchievements: '0.00',
      amount: m.amount.toFixed(2),
      e_card_number: m.e_card_number.toFixed(2),
      rush_amount: m.rush_amount.toFixed(2),
      fy_price: m.fy_price.toFixed(2),
      identity_vip: m.identity_vip,
      identity_vip_value: get('SELECT name FROM member_grade WHERE grade_id = ?', (m.grade_id || 1))?.name || '普通会员',
      is_advance: m.is_advance,
      pay_info: m.pay_setting ? JSON.parse(m.pay_setting) : {},
    }),
  );
});

r.post('/editMember', authMember, (req, res) => {
  const { nickName, avatarUrl } = req.body;
  const m = req.member;
  if (nickName) run('UPDATE member SET nick_name = ? WHERE member_id = ?', nickName, m.member_id);
  if (avatarUrl) run('UPDATE member SET avatar_url = ? WHERE member_id = ?', avatarUrl, m.member_id);
  run('UPDATE member SET update_time = ? WHERE member_id = ?', now(), m.member_id);
  res.json(ok([], '修改成功'));
});

r.post('/editPwd', authMember, (req, res) => {
  const { oldPwd, newPwd, pwd } = req.body;
  const m = req.member;
  if (oldPwd && !verifyPwd(oldPwd, m.password)) return res.json(fail('原密码不正确'));
  const np = newPwd || pwd;
  if (!np || String(np).length < 6) return res.json(fail('新密码不能少于6位'));
  run('UPDATE member SET password = ? WHERE member_id = ?', hashPwd(np), m.member_id);
  res.json(ok({ phone: m.mobile, z_phone: m.mobile }, '修改成功'));
});

// 支付密码
r.get('/getIsPayPassword', authMember, (req, res) => {
  res.json(ok(req.member.pay_password ? '1' : '0'));
});

r.post('/verificationPayPassword', authMember, (req, res) => {
  const { pwd } = req.body;
  if (!pwd) return res.json(fail('请先输入支付密码'));
  const m = req.member;
  if (!m.pay_password) {
    run('UPDATE member SET pay_password = ? WHERE member_id = ?', hashPwd(pwd), m.member_id);
    return res.json(ok([], '支付密码设置成功'));
  }
  if (!verifyPwd(pwd, m.pay_password)) return res.json(fail('支付密码错误'));
  res.json(ok([], '验证成功'));
});

r.post('/setPay', authMember, (req, res) => {
  const { type, account, name, bank, image } = req.body;
  if (!type || !account) return res.json(fail('请填写完整的收款信息'));
  const m = req.member;
  const info = m.pay_setting ? JSON.parse(m.pay_setting) : {};
  const map = { 1: 'wx', 2: 'zfb', 3: 'bank' };
  const k = map[type];
  if (k) {
    info[`${k}_account`] = account;
    info[`${k}_name`] = name || '';
    if (k === 'bank') info.bank = bank || '';
    if (image) info[`${k}_image`] = image;
    info.mobile = m.mobile;
  }
  run('UPDATE member SET pay_setting = ? WHERE member_id = ?', JSON.stringify(info), m.member_id);
  if (type === 3 && account) {
    run(
      'INSERT INTO member_card (member_id, type, account, name, bank, image, create_time) VALUES (?,3,?,?,?,?,?)',
      m.member_id, account, name || '', bank || '', image || '', now(),
    );
  }
  res.json(ok('', '设置完成'));
});

r.post('/setSignImage', authMember, (req, res) => {
  const { image } = req.body;
  if (!image) return res.json(fail('签名不能为空'));
  run('UPDATE member SET sign_image = ? WHERE member_id = ?', image, req.member.member_id);
  res.json(ok([], '设置成功'));
});

r.get('/getLevelList', (req, res) => {
  const rows = all('SELECT grade_id, name, team_award FROM member_grade ORDER BY grade_id');
  res.json(ok(rows.map((x) => ({ id: x.grade_id, name: x.name, desc: `团队奖 ${x.team_award}%` }))));
});

// 直推列表
r.get('/getMyIndirection', authMember, (req, res) => {
  const m = req.member;
  const ids = m.child_id ? m.child_id.split(',').filter(Boolean).map(Number) : [];
  const list = ids.length
    ? all(
        `SELECT member_id, nick_name, mobile, avatar_url, create_time, identity_vip, is_valid
         FROM member WHERE member_id IN (${ids.map(() => '?').join(',')}) ORDER BY member_id DESC`,
        ...ids,
      )
    : [];
  res.json(ok(list.map(fmtMember)));
});

// 统计直推与全部层级团队人数
r.get('/getMyTeamStats', authMember, (req, res) => {
  const direct = Number(get('SELECT COUNT(*) n FROM member WHERE p_id = ?', req.member.member_id)?.n || 0);
  const total = Number(get(
    `WITH RECURSIVE descendants(member_id) AS (
       SELECT member_id FROM member WHERE p_id = ?
       UNION ALL
       SELECT m.member_id FROM member m JOIN descendants d ON m.p_id = d.member_id
     ) SELECT COUNT(*) n FROM descendants`,
    req.member.member_id,
  )?.n || 0);
  res.json(ok({ direct_count: direct, team_count: total }));
});

const fmtMember = (x) => ({
  member_id: x.member_id,
  nickName: x.nick_name,
  mobile: x.mobile,
  avatarUrl: x.avatar_url,
  identity_vip: x.identity_vip,
  create_time: x.create_time,
});

r.get('/getECardList', authMember, (req, res) => {
  const list = all(
    `SELECT energy_id, face_value, type, type_name, remarks, create_time
     FROM finance_energy WHERE member_id = ? AND type = 1 ORDER BY energy_id DESC LIMIT 100`,
    req.member.member_id,
  );
  res.json(ok(list));
});

r.get('/financialData', authMember, (req, res) => {
  const m = req.member;
  const t = get(
    'SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1 AND create_time >= ?',
    m.member_id, today(),
  )?.v;
  const total = get('SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1', m.member_id)?.v;
  res.json(
    ok({
      member_id: m.member_id,
      amount: m.amount.toFixed(2),
      score: m.score,
      e_card_number: m.e_card_number.toFixed(2),
      today_num: money(t).toFixed(2),
      total_num: money(total).toFixed(2),
    }),
  );
});

r.get('/personProfit', authMember, (req, res) => {
  const m = req.member;
  const sum = (from) =>
    get(
      'SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1 AND create_time >= ?',
      m.member_id, from,
    )?.v;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const monthStart = today().slice(0, 7) + '-01';
  res.json(
    ok({
      total: money(get('SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1', m.member_id)?.v),
      today: money(sum(today())),
      week: money(sum(weekAgo)),
      month: money(sum(monthStart)),
      all: money(get('SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1', m.member_id)?.v),
      rows: all(
        'SELECT energy_id, face_value, type_name, remarks, create_time FROM finance_energy WHERE member_id = ? AND type = 1 ORDER BY energy_id DESC LIMIT 50',
        m.member_id,
      ),
    }),
  );
});

r.get('/getApplyList', authMember, (req, res) => {
  res.json(ok(all('SELECT * FROM finance_withdraw WHERE member_id = ? ORDER BY withdraw_id DESC', req.member.member_id)));
});

r.get('/getTransfer', authMember, (req, res) => {
  res.json(
    ok({
      member_id: req.member.member_id,
      transfer_accounts: '温馨提示：线下付款时请核实对方身份，保留转账凭证，避免使用信用卡或花呗付款。',
      amount: req.member.amount.toFixed(2),
      e_card_number: req.member.e_card_number.toFixed(2),
    }),
  );
});

// 余额 / 能量券 转赠给下级
r.post('/toTransfer', authMember, (req, res) => {
  const { member_id, num, type } = req.body;
  const amount = Number(num);
  if (!member_id || !amount || amount <= 0) return res.json(fail('参数错误'));
  const target = get('SELECT * FROM member WHERE member_id = ?', Number(member_id));
  if (!target) return res.json(fail('接收会员不存在'));
  // 只能转给伞下会员
  if (!String(target.path || '').includes(`/${req.member.member_id}/`)) {
    return res.json(fail('只能转赠给伞下会员'));
  }
  const me = req.member;
  const isEnergy = Number(type) === 4;
  if (isEnergy ? me.fy_price < amount : me.amount < amount) return res.json(fail('可用额度不足'));

  try {
    tx(() => {
      if (isEnergy) {
        // 条件扣减：并发下两个请求会同时通过上面的余额判断，无条件减会扣成负数（凭空造钱）
        const r1 = run('UPDATE member SET fy_price = fy_price - ? WHERE member_id = ? AND fy_price >= ?', amount, me.member_id, amount);
        if (Number(r1.changes) !== 1) { const e = new Error('可用礼券不足'); e.biz = true; throw e; }
        run('UPDATE member SET fy_price = fy_price + ? WHERE member_id = ?', amount, target.member_id);
        run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
          me.member_id, -amount, 4, '礼券转出', `转给 ${target.nick_name}`, now());
        run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
          target.member_id, amount, 4, '礼券转入', `来自 ${me.nick_name}`, now());
      } else {
        const r1 = run('UPDATE member SET amount = amount - ? WHERE member_id = ? AND amount >= ?', amount, me.member_id, amount);
        if (Number(r1.changes) !== 1) { const e = new Error('可用余额不足'); e.biz = true; throw e; }
        run('UPDATE member SET amount = amount + ? WHERE member_id = ?', amount, target.member_id);
        run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
          me.member_id, -amount, 2, '余额转出', `转给 ${target.nick_name}`, now());
        run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
          target.member_id, amount, 2, '余额转入', `来自 ${me.nick_name}`, now());
      }
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok([], '转赠成功'));
});

// ---------------- 收货地址 ----------------
r.get('/address/list', authMember, (req, res) => {
  res.json(ok(all('SELECT * FROM member_address WHERE member_id = ? ORDER BY is_default DESC, address_id DESC', req.member.member_id)));
});

r.get('/address/detail', authMember, (req, res) => {
  const a = get('SELECT * FROM member_address WHERE address_id = ? AND member_id = ?', Number(req.query.address_id), req.member.member_id);
  if (!a) return res.json(fail('地址不存在'));
  res.json(ok(a));
});

r.post('/address/add', authMember, (req, res) => {
  const { name, mobile, province, city, district, detail, is_default } = req.body;
  if (!name) return res.json(fail('请先填写收货人姓名'));
  if (!mobile) return res.json(fail('请填写手机号'));
  if (!detail) return res.json(fail('请填写详细地址'));
  if (is_default) run('UPDATE member_address SET is_default = 0 WHERE member_id = ?', req.member.member_id);
  run(
    `INSERT INTO member_address (member_id, name, mobile, province, city, district, detail, is_default, create_time)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    req.member.member_id, name, mobile, province || '', city || '', district || '', detail, is_default ? 1 : 0, now(),
  );
  res.json(ok([], '添加成功'));
});

r.post('/address/edit', authMember, (req, res) => {
  const { address_id, name, mobile, province, city, district, detail, is_default } = req.body;
  const a = get('SELECT * FROM member_address WHERE address_id = ? AND member_id = ?', Number(address_id), req.member.member_id);
  if (!a) return res.json(fail('地址不存在'));
  if (is_default) run('UPDATE member_address SET is_default = 0 WHERE member_id = ?', req.member.member_id);
  run(
    'UPDATE member_address SET name=?, mobile=?, province=?, city=?, district=?, detail=?, is_default=? WHERE address_id=?',
    name ?? a.name, mobile ?? a.mobile, province ?? a.province, city ?? a.city, district ?? a.district,
    detail ?? a.detail, is_default ? 1 : a.is_default, address_id,
  );
  res.json(ok([], '修改成功'));
});

r.post('/address/remove', authMember, (req, res) => {
  run('DELETE FROM member_address WHERE address_id = ? AND member_id = ?', Number(req.body.address_id), req.member.member_id);
  res.json(ok([], '删除成功'));
});

// ---------------- 收款卡 ----------------
r.get('/card/cardList', authMember, (req, res) => {
  res.json(ok(all('SELECT * FROM member_card WHERE member_id = ? ORDER BY card_id DESC', req.member.member_id)));
});

r.post('/card/add', authMember, (req, res) => {
  const { type, account, name, bank, image } = req.body;
  if (!account || !name) return res.json(fail('请填写完整的账户信息'));
  if (type === 3 && !bank) return res.json(fail('请填写开户银行'));
  run(
    'INSERT INTO member_card (member_id, type, account, name, bank, image, create_time) VALUES (?,?,?,?,?,?,?)',
    req.member.member_id, Number(type) || 1, account, name, bank || '', image || '', now(),
  );
  res.json(ok([], '添加成功'));
});

r.post('/card/remove', authMember, (req, res) => {
  run('DELETE FROM member_card WHERE card_id = ? AND member_id = ?', Number(req.body.card_id), req.member.member_id);
  res.json(ok([], '删除成功'));
});

// ---------------- 实名认证 ----------------
r.post('/certification/addRealName', authMember, (req, res) => {
  const { real_name, idcard, front_image, back_image, hand_image } = req.body;
  if (!real_name) return res.json(fail('请先填写姓名'));
  if (!idcard) return res.json(fail('请填写身份证号'));
  if (!/^\d{17}[\dXx]$/.test(idcard)) return res.json(fail('身份证号格式不正确'));
  if (req.member.is_certification === 1) return res.json(fail('已经认证过了'));
  // 2 = 资料已提交待审核：此时再提交会产生多条待审记录，后台审核时会重复处理
  if (req.member.is_certification === 2) return res.json(fail('实名资料审核中，请耐心等待'));
  run(
    `INSERT INTO member_certification (member_id, real_name, idcard, front_image, back_image, hand_image, status, create_time)
     VALUES (?,?,?,?,?,?,0,?)`,
    req.member.member_id, real_name, idcard, front_image || '', back_image || '', hand_image || '', now(),
  );
  run('UPDATE member SET is_certification = 2, certification_name = ?, idcard = ? WHERE member_id = ?',
    real_name, idcard, req.member.member_id);
  res.json(ok([], '提交成功，等待审核'));
});

r.get('/certification/getIsRealName', authMember, (req, res) => {
  const m = req.member;
  if (m.is_certification === 1) return res.json(ok([], '已经认证过了'));
  res.json(ok({ status: m.is_certification, name: m.certification_name || '' }, '未认证'));
});

// ---------------- 我的店铺 ----------------
/**
 * 当前持有的在售商品 + 预计收益
 * 预计净收益 = 下一轮标价 − 我的买入价 − 上架费
 *   已挂牌：下一轮标价取商品现标价（已涨过），上架费已实际扣除
 *   未挂牌：下一轮标价按涨价率预估，上架费按预估
 * 商品被下一轮买走后 goods.member_id 变更，自然从列表消失，无需额外处理
 */
r.get('/myShop', authMember, (req, res) => {
  const me = req.member.member_id;
  // 含 20（已下架待转拍）：成交后商品会立刻下架，但持有人仍要能在「我的店铺」里看到它去转拍
  const goodsList = all(
    `SELECT goods_id, goods_name, good_thumb, goods_min_price, goods_status, turn_beat_num, update_time
     FROM goods WHERE member_id = ? AND goods_status IN (10, 20)
     ORDER BY update_time DESC, goods_id DESC`,
    me,
  );

  const list = goodsList.map((g) => {
    const o = get(
      `SELECT order_id, order_no, total_price, consignment_status, listing_fee FROM orders
       WHERE goods_id = ? AND member_id = ? AND type = 1 AND pay_status = 10 AND status <> 40
       ORDER BY order_id DESC LIMIT 1`,
      g.goods_id, me,
    );
    const myPrice = Number(o?.total_price || 0);
    const listed = Number(o?.consignment_status) === 10;
    // 已挂牌：商品标价就是下一轮成交价；未挂牌：按涨价率预估
    const nextPrice = listed ? Number(g.goods_min_price) : calcNextPrice(g.goods_min_price);
    const listingFee = listed ? Number(o?.listing_fee || 0) : calcListingFee(myPrice || g.goods_min_price);
    // 没有买入订单（平台指派/赠送）时无法算收益，返回 null 让前端显示「—」
    const estNet = myPrice > 0 ? money(nextPrice - myPrice - listingFee) : null;
    return {
      goods_id: g.goods_id,
      goods_name: g.goods_name,
      good_thumb: g.good_thumb,
      my_price: money(myPrice),
      current_price: money(g.goods_min_price),
      next_price: money(nextPrice),
      listing_fee: money(listingFee),
      est_net: estNet,
      listed,
      turn_beat_num: Number(g.turn_beat_num || 0),
      order_no: o?.order_no || '',
      update_time: g.update_time,
    };
  });

  const listedCount = list.filter((x) => x.listed).length;
  const totalNet = money(list.reduce((s, x) => s + (x.est_net || 0), 0));
  res.json(ok({
    list,
    summary: {
      count: list.length,
      listed_count: listedCount,
      unlisted_count: list.length - listedCount,
      total_net: totalNet,
      increase_rate: priceIncreaseRate(),
    },
  }));
});

export default r;
