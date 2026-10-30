import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, fail, assetUrl, authMember } from '../lib/helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 上传目录可用 UPLOAD_DIR 覆盖（Docker 里指向数据卷 /app/data/uploads）
const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', '..', 'data', 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname || '.png') || '.png';
    cb(null, `${Date.now()}${Math.random().toString(16).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持上传图片'));
  },
});

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
