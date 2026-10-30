// 文件管理（素材库）：列表 / 分组 / 上传 / 重命名 / 移动 / 删除
//
// 设计要点：
// 1. 事实来源是磁盘。列表时会把 uploads 目录里「还没有记录」的文件自动入库，
//    这样历史图片（演示数据、H5 上传的图）不用迁移脚本也能出现在素材库里。
// 2. 会员私有文件（实名证件、结算凭证）标记 private=1，不进素材库，
//    避免给轮播图选图时翻出一堆身份证照片。
// 3. 删除前查引用：商品主图、广告、分类图、场次图、配置项、订单快照……
//    只要还在被用就拒绝，并说明被谁用着。
import { Router } from 'express';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { all, get, run, now } from '../../db.js';
import { ok, fail, authAdmin, assetUrl } from '../../lib/helper.js';
import { imageSize, MIME_BY_EXT } from '../../lib/imageSize.js';
import { normPath, usagesOf } from '../../lib/mediaRefs.js';
// 上传目录与存储策略统一走 lib/uploadStorage.js（扩展名白名单在那里）
import { UPLOAD_DIR, imageUpload } from '../../lib/uploadStorage.js';

const r = Router();
const IMAGE_EXT = Object.keys(MIME_BY_EXT);

const absOf = (p) => join(UPLOAD_DIR, basename(normPath(p)));

/**
 * 会员私有文件集合：实名证件 + 结算凭证。
 * 每次同步都重算（而不是只在入库时判一次），否则某张图后来被用作凭证，
 * 它还会一直躺在素材库里。
 */
function privatePaths() {
  const rows = all(
    `SELECT front_image v FROM member_certification WHERE front_image <> ''
     UNION SELECT back_image FROM member_certification WHERE back_image <> ''
     UNION SELECT hand_image FROM member_certification WHERE hand_image <> ''
     UNION SELECT voucher FROM settle_match WHERE voucher <> ''`,
  );
  return new Set(rows.map((x) => normPath(x.v)).filter(Boolean));
}

/** 磁盘扫描入库：新文件入库，老文件的 private 标记按当前引用关系刷新 */
function syncDisk() {
  const priv = privatePaths();
  const known = new Map(all('SELECT file_id, path, private FROM media_file').map((x) => [x.path, x]));
  let added = 0;
  let flagged = 0;
  for (const f of readdirSync(UPLOAD_DIR)) {
    const ext = extname(f).toLowerCase();
    if (!IMAGE_EXT.includes(ext)) continue;
    const p = `/uploads/${f}`;
    const want = priv.has(p) ? 1 : 0;
    const row = known.get(p);
    if (row) {
      if (Number(row.private) !== want) {
        run('UPDATE media_file SET private = ? WHERE file_id = ?', want, row.file_id);
        flagged += 1;
      }
      continue;
    }
    const abs = join(UPLOAD_DIR, f);
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    const { width, height } = imageSize(abs);
    run(
      `INSERT INTO media_file (name, path, group_id, size, mime, width, height, private, create_time)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      basename(f, ext), p, 0, size, MIME_BY_EXT[ext] || '', width, height, want, now(),
    );
    added += 1;
  }
  return { added, flagged };
}

const toApi = (x) => ({
  file_id: x.file_id,
  name: x.name || '',
  path: x.path,
  url: assetUrl(x.path),
  group_id: Number(x.group_id || 0),
  size: Number(x.size || 0),
  mime: x.mime || '',
  width: Number(x.width || 0),
  height: Number(x.height || 0),
  ext: extname(x.path || '').replace('.', '').toLowerCase(),
  create_time: x.create_time || '',
});


// ---------------- 分组 ----------------
r.get('/media/groups', authAdmin, (req, res) => {
  syncDisk();
  const used = all('SELECT group_id, COUNT(*) c FROM media_file WHERE private = 0 GROUP BY group_id');
  const map = new Map(used.map((x) => [Number(x.group_id || 0), Number(x.c)]));
  const groups = all('SELECT * FROM media_group ORDER BY sort ASC, group_id ASC').map((g) => ({
    group_id: g.group_id,
    name: g.name,
    count: map.get(Number(g.group_id)) || 0,
  }));
  res.json(ok({
    groups,
    ungrouped: map.get(0) || 0,
    total: groups.reduce((s, g) => s + g.count, 0) + (map.get(0) || 0),
  }));
});

r.post('/media/group/save', authAdmin, (req, res) => {
  const id = Number(req.body?.group_id || 0);
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.json(fail('请填写分组名称'));
  const dup = get('SELECT group_id FROM media_group WHERE name = ? AND group_id <> ?', name, id);
  if (dup) return res.json(fail('分组名称已存在'));
  if (id) {
    if (!get('SELECT 1 FROM media_group WHERE group_id = ?', id)) return res.json(fail('分组不存在'));
    run('UPDATE media_group SET name = ? WHERE group_id = ?', name, id);
    return res.json(ok([], '已重命名'));
  }
  const info = run('INSERT INTO media_group (name, sort, create_time) VALUES (?,?,?)', name, 100, now());
  res.json(ok({ group_id: Number(info.lastInsertRowid) }, '已创建'));
});

r.post('/media/group/remove', authAdmin, (req, res) => {
  const id = Number(req.body?.group_id || 0);
  if (!id) return res.json(fail('请选择分组'));
  if (!get('SELECT 1 FROM media_group WHERE group_id = ?', id)) return res.json(fail('分组不存在'));
  // 分组里的文件退回「未分组」，不删文件
  const moved = Number(run('UPDATE media_file SET group_id = 0 WHERE group_id = ?', id).changes || 0);
  run('DELETE FROM media_group WHERE group_id = ?', id);
  res.json(ok({ moved }, moved ? `已删除分组，${moved} 个文件移回未分组` : '已删除分组'));
});

// ---------------- 文件 ----------------
r.get('/media/list', authAdmin, (req, res) => {
  syncDisk();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const keyword = String(req.query.keyword || '').trim();
  const groupRaw = req.query.group_id;

  const where = ['private = 0'];
  const args = [];
  if (groupRaw !== undefined && groupRaw !== '' && groupRaw !== null) {
    where.push('group_id = ?');
    args.push(Number(groupRaw) || 0);
  }
  if (keyword) {
    where.push('(name LIKE ? OR path LIKE ?)');
    args.push(`%${keyword}%`, `%${keyword}%`);
  }
  const w = where.join(' AND ');
  const total = Number(get(`SELECT COUNT(*) c FROM media_file WHERE ${w}`, ...args).c || 0);
  const rows = all(
    `SELECT * FROM media_file WHERE ${w} ORDER BY file_id DESC LIMIT ? OFFSET ?`,
    ...args, size, (page - 1) * size,
  );
  res.json(ok({ list: rows.map(toApi), total, page, limit: size }));
});

r.get('/media/refs', authAdmin, (req, res) => {
  const id = Number(req.query.file_id || 0);
  const f = get('SELECT * FROM media_file WHERE file_id = ?', id);
  if (!f) return res.json(fail('文件不存在'));
  res.json(ok({ usages: usagesOf(f.path) }));
});

const upload = imageUpload;

r.post('/media/upload', authAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.json(fail('请选择要上传的图片'));
  const p = `/uploads/${req.file.filename}`;
  const abs = join(UPLOAD_DIR, req.file.filename);
  const { width, height } = imageSize(abs);
  const ext = extname(req.file.filename).toLowerCase();
  // multer/busboy 按 latin1 解析文件名，中文名会变成乱码，这里转回 utf8
  const decodeName = (s) => {
    const t = Buffer.from(String(s || ''), 'latin1').toString('utf8');
    return t.includes('\uFFFD') ? String(s || '') : t;
  };
  const original = decodeName(req.file.originalname);
  const rawName = String(req.body?.name || '').trim();
  const name = (rawName || basename(original || req.file.filename, extname(original || ''))).slice(0, 60);
  const groupId = Number(req.body?.group_id || 0);
  const info = run(
    `INSERT INTO media_file (name, path, group_id, size, mime, width, height, private, create_time)
     VALUES (?,?,?,?,?,?,?,0,?)`,
    name, p, groupId, req.file.size || 0, req.file.mimetype || MIME_BY_EXT[ext] || '', width, height, now(),
  );
  res.json(ok(toApi(get('SELECT * FROM media_file WHERE file_id = ?', Number(info.lastInsertRowid))), '上传成功'));
});

r.post('/media/rename', authAdmin, (req, res) => {
  const id = Number(req.body?.file_id || 0);
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const f = get('SELECT * FROM media_file WHERE file_id = ?', id);
  if (!f) return res.json(fail('文件不存在'));
  if (!name) return res.json(fail('请填写名称'));
  run('UPDATE media_file SET name = ? WHERE file_id = ?', name, id);
  res.json(ok([], '已重命名'));
});

r.post('/media/move', authAdmin, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id]).map(Number).filter(Boolean);
  const groupId = Number(req.body?.group_id || 0);
  if (!ids.length) return res.json(fail('请选择文件'));
  if (groupId && !get('SELECT 1 FROM media_group WHERE group_id = ?', groupId)) return res.json(fail('分组不存在'));
  for (const id of ids) run('UPDATE media_file SET group_id = ? WHERE file_id = ?', groupId, id);
  res.json(ok({ count: ids.length }, `已移动 ${ids.length} 个文件`));
});

r.post('/media/remove', authAdmin, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [req.body?.id]).map(Number).filter(Boolean);
  if (!ids.length) return res.json(fail('请选择文件'));
  let deleted = 0;
  const skipped = [];
  for (const id of ids) {
    const f = get('SELECT * FROM media_file WHERE file_id = ?', id);
    if (!f) continue;
    const usages = usagesOf(f.path);
    if (usages.length) {
      skipped.push({ file_id: id, name: f.name, usages });
      continue;
    }
    const abs = absOf(f.path);
    if (existsSync(abs)) {
      try { unlinkSync(abs); } catch {
        skipped.push({ file_id: id, name: f.name, usages: ['磁盘文件被占用，删除失败'] });
        continue;
      }
    }
    run('DELETE FROM media_file WHERE file_id = ?', id);
    deleted += 1;
  }
  const msg = skipped.length
    ? `已删除 ${deleted} 个，${skipped.length} 个仍在使用未删除`
    : `已删除 ${deleted} 个文件`;
  res.json(ok({ deleted, skipped }, msg));
});

export default r;
