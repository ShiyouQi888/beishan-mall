// 数据清除：只有拿到「数据清除」权限节点的角色能用（默认仅超级管理员）
// 预览 + 执行分开，执行必须原样回传确认语
import { Router } from 'express';
import { ok, fail, authAdmin } from '../../lib/helper.js';
import { SCOPES, CONFIRM_TEXT, planReset, resetData, summary } from '../../lib/resetData.js';

const r = Router();

r.get('/system/reset/plan', authAdmin, (req, res) => {
  const scopes = String(req.query.scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { total, totals, detail } = planReset(scopes.length ? scopes : null);
  res.json(ok({
    scopes: SCOPES,
    confirm_text: CONFIRM_TEXT,
    summary: summary(),
    total,
    totals,
    detail,
  }));
});

r.post('/system/reset', authAdmin, (req, res) => {
  const { scopes, confirm } = req.body || {};
  if (String(confirm || '').trim() !== CONFIRM_TEXT) {
    return res.json(fail(`确认文字不正确，请原样输入「${CONFIRM_TEXT}」`));
  }
  if (!Array.isArray(scopes) || !scopes.length) return res.json(fail('请至少选择一个清除范围'));
  try {
    const result = resetData(scopes);
    res.json(ok(result, `已清除 ${result.total} 行数据，备份文件 ${result.backup}`));
  } catch (e) {
    if (e.biz) return res.json(fail(e.message));
    console.error('[reset] 清除失败：', e);
    res.json(fail('清除失败：' + e.message));
  }
});

export default r;
