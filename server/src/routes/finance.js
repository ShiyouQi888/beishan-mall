import { Router } from 'express';
import { all, get, run, tx, now, today } from '../db.js';
import { ok, fail, authMember, money } from '../lib/helper.js';
import { todayStr } from '../lib/sessionWindow.js';

const r = Router();
const cfg = (k, d = '') => get('SELECT `value` FROM setting_config WHERE `key` = ?', k)?.value ?? d;

// 资产总览
r.get('/getAmountInfo', authMember, (req, res) => {
  const m = req.member;
  const monthStart = today().slice(0, 7) + '-01';
  const lastMonth = new Date();
  lastMonth.setDate(1);
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthStart = todayStr(lastMonth);
  const sum = (from, to) =>
    get(
      'SELECT IFNULL(SUM(face_value),0) v FROM finance_energy WHERE member_id = ? AND type = 1 AND create_time >= ? AND create_time < ?',
      m.member_id, from, to,
    )?.v || 0;

  res.json(
    ok({
      amount: {
        distribution_amount: Number(m.distribution_amount).toFixed(2),
        today_money: money(sum(today(), now().slice(0, 10) + ' 23:59:59')).toFixed(2),
        month_money: money(sum(monthStart, '9999-12-31')).toFixed(2),
        last_month_money: money(sum(lastMonthStart, monthStart)).toFixed(2),
        member_amount: Number(m.amount).toFixed(2),
        e_card_number: Number(m.e_card_number).toFixed(2),
        fy_price: Number(m.fy_price).toFixed(2),
      },
      balance_list: all(
        'SELECT energy_id, face_value, type, type_name, remarks, create_time FROM finance_energy WHERE member_id = ? ORDER BY energy_id DESC LIMIT 30',
        m.member_id,
      ),
      apply_list: all(
        'SELECT withdraw_id, amount, status, create_time FROM finance_withdraw WHERE member_id = ? ORDER BY withdraw_id DESC LIMIT 10',
        m.member_id,
      ),
    }),
  );
});

r.get('/getSystemInfo', authMember, (req, res) => {
  res.json(
    ok({
      service_charge: cfg('service_charge', '0'),
      consignment_rule: cfg('consignment_rule', ''),
      prompt_withdraw: cfg('prompt_withdraw', '提现申请提交后由平台审核，审核通过后 T+1 个工作日到账。'),
      amount: Number(req.member.amount).toFixed(2),
      withdraw_min: cfg('withdraw_min', '10'),
      withdraw_fee: cfg('withdraw_fee', '0'),
      withdraw_methods: {
        // 通道默认关闭：提现模块已整体下线，缺配置时按「未开放」处理
        wx: Number(cfg('withdraw_wx_open', '20')) === 10,
        zfb: Number(cfg('withdraw_zfb_open', '20')) === 10,
        bank: Number(cfg('withdraw_bank_open', '20')) === 10,
        offline: Number(cfg('withdraw_offline_open', '20')) === 10,
      },
      zfb_image: get("SELECT `value` FROM setting_config WHERE `key`='zfb_qr'")?.value || null,
      wx_image: get("SELECT `value` FROM setting_config WHERE `key`='wx_qr'")?.value || null,
    }),
  );
});

// 提现申请
r.post('/withdraw/apply', authMember, (req, res) => {
  const { amount } = req.body;
  const accountType = Number(req.body.account_type);
  const accountInfo = accountType === 4 ? '线下打款' : String(req.body.account_info || '').trim();
  const m = req.member;
  const amt = Number(amount);
  const min = Number(cfg('withdraw_min', '10'));
  if (!amt || amt <= 0) return res.json(fail('请输入提现金额'));
  if (amt < min) return res.json(fail(`最低提现金额为 ${min} 元`));
  if (amt > m.amount) return res.json(fail('可提现余额不足'));
  if (![1, 2, 3, 4].includes(accountType)) return res.json(fail('请选择有效的收款方式'));
  const withdrawSwitch = {
    1: 'withdraw_wx_open',
    2: 'withdraw_zfb_open',
    3: 'withdraw_bank_open',
    4: 'withdraw_offline_open',
  }[accountType];
  // 兜底按「关闭」：提现模块下线后新库不会自动建这些 key，不能默认当成开放
  if (Number(cfg(withdrawSwitch, '20')) !== 10) return res.json(fail('提现功能暂未开放'));
  if (!accountInfo) return res.json(fail('请选择收款账户'));
  const fee = money((amt * Number(cfg('withdraw_fee', '0'))) / 100);

  try {
    tx(() => {
      // 条件扣款：上面的 `amt > m.amount` 是请求进来时读的，并发下两个请求会同时通过，
      // 各自执行无条件减去 amt 就会把余额扣成负数。这里用 WHERE amount >= ? 兜住
      const r1 = run('UPDATE member SET amount = amount - ? WHERE member_id = ? AND amount >= ?', amt, m.member_id, amt);
      if (Number(r1.changes) !== 1) {
        const e = new Error('可提现余额不足');
        e.biz = true;
        throw e;
      }
      run(
        `INSERT INTO finance_withdraw (member_id, amount, fee, actual_amount, account_type, account_info, status, create_time)
         VALUES (?,?,?,?,?,?,0,?)`,
        m.member_id, amt, fee, money(amt - fee), accountType, accountInfo, now(),
      );
      run('INSERT INTO finance_energy (member_id, face_value, type, type_name, remarks, create_time) VALUES (?,?,?,?,?,?)',
        m.member_id, -amt, 2, '提现申请', `手续费 ${fee.toFixed(2)}`, now());
    });
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    throw e;
  }
  res.json(ok([], '提现申请已提交，等待审核'));
});

r.get('/withdraw/list', authMember, (req, res) => {
  res.json(ok(all('SELECT * FROM finance_withdraw WHERE member_id = ? ORDER BY withdraw_id DESC', req.member.member_id)));
});

export default r;
