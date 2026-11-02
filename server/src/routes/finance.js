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
    }),
  );
});

// 交易参数：支付与提现都已下线，这里只留转拍/服务费这类还在用的配置
r.get('/getSystemInfo', authMember, (req, res) => {
  res.json(
    ok({
      service_charge: cfg('service_charge', '0'),
      consignment_rule: cfg('consignment_rule', ''),
      amount: Number(req.member.amount).toFixed(2),
    }),
  );
});

export default r;
