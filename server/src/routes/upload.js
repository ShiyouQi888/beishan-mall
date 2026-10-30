import { Router } from 'express';
import { ok, fail, assetUrl, authMember } from '../lib/helper.js';
import { imageUpload as upload } from '../lib/uploadStorage.js';

const r = Router();

const publicUrl = (f) => assetUrl(`/uploads/${f.filename}`);

// 上传必须登录：原来完全开放，任何人都能往服务器磁盘塞图（免费图床 + 塞满磁盘）
r.post('/image', authMember, upload.single('file'), (req, res) => {
  if (!req.file) return res.json(fail('请选择要上传的图片'));
  res.json(ok({ url: publicUrl(req.file), path: `/uploads/${req.file.filename}` }, '上传成功'));
});

r.post('/images', authMember, upload.array('files', 9), (req, res) => {
  if (!req.files?.length) return res.json(fail('请选择要上传的图片'));
  res.json(ok(req.files.map((f) => ({ url: publicUrl(f), path: `/uploads/${f.filename}` })), '上传成功'));
});

export default r;
