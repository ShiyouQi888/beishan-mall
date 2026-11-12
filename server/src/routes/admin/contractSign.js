// 会员服务电子合同签署记录：后台查询与举证
import { Router } from 'express';
import { all, get } from '../../db.js';
import { ok, fail, authAdmin, assetUrl } from '../../lib/helper.js';
import { renderRich } from '../../../../shared/markdown.js';

const r = Router();
const LIST_FIELDS = `sign_id, member_id, phone, real_name, sign_image,
  contract_title, contract_version, read_seconds, ip, create_time`;

function whereOf(q) {
  const parts = [];
  const args = [];
  if (q.phone) { parts.push('phone LIKE ?'); args.push(`%${String(q.phone).trim()}%`); }
  if (q.real_name) { parts.push('real_name LIKE ?'); args.push(`%${String(q.real_name).trim()}%`); }
  if (q.start) { parts.push('create_time >= ?'); args.push(`${String(q.start).trim()} 00:00:00`); }
  if (q.end) { parts.push('create_time <= ?'); args.push(`${String(q.end).trim()} 23:59:59`); }
  if (q.version) { parts.push('contract_version = ?'); args.push(String(q.version).trim()); }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

const fmt = (row) => ({
  ...row,
  sign_image_url: assetUrl(row.sign_image),
  create_time: row.create_time || '',
});

r.get('/contract-sign/list', authAdmin, (req, res) => {
  const q = req.query || {};
  const { sql, args } = whereOf(q);
  const limit = Math.max(1, Math.min(100, Number(q.limit) || 15));
  const pageNo = Math.max(1, Number(q.page) || 1);
  const total = Number(get(`SELECT COUNT(*) c FROM contract_signature ${sql}`, ...args)?.c || 0);
  const rows = all(
    `SELECT ${LIST_FIELDS} FROM contract_signature ${sql} ORDER BY sign_id DESC LIMIT ? OFFSET ?`,
    ...args, limit, (pageNo - 1) * limit,
  );
  res.json(ok({ list: rows.map(fmt), total, page: pageNo, limit }));
});

r.get('/contract-sign/detail', authAdmin, (req, res) => {
  const id = Number(req.query.id || 0);
  if (!id) return res.json(fail('参数错误'));
  const row = get('SELECT * FROM contract_signature WHERE sign_id = ?', id);
  if (!row) return res.json(fail('签署记录不存在'));
  res.json(ok({
    ...fmt(row),
    user_agent: row.user_agent || '',
    contract_html: renderRich(row.contract_snapshot || ''),
  }));
});

/** 导出：与列表同口径，一次最多 5000 条，避免一次拉爆内存 */
r.get('/contract-sign/export', authAdmin, (req, res) => {
  const { sql, args } = whereOf(req.query || {});
  const rows = all(
    `SELECT ${LIST_FIELDS} FROM contract_signature ${sql} ORDER BY sign_id DESC LIMIT 5000`,
    ...args,
  );
  res.json(ok({
    list: rows.map((x) => ({
      签署时间: x.create_time,
      会员ID: x.member_id,
      手机号: x.phone,
      姓名: x.real_name,
      合同名称: x.contract_title,
      合同版本: x.contract_version,
      阅读秒数: x.read_seconds,
      IP: x.ip,
      签名图: assetUrl(x.sign_image),
    })),
  }));
});

export default r;
