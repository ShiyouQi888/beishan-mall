import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, fail } from '../lib/helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '..', '..', 'data', 'uploads');
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

const publicUrl = (f) => `http://127.0.0.1:3300/uploads/${f.filename}`;

r.post('/image', upload.single('file'), (req, res) => {
  if (!req.file) return res.json(fail('请选择要上传的图片'));
  res.json(ok({ url: publicUrl(req.file), path: `/uploads/${req.file.filename}` }, '上传成功'));
});

r.post('/images', upload.array('files', 9), (req, res) => {
  if (!req.files?.length) return res.json(fail('请选择要上传的图片'));
  res.json(ok(req.files.map((f) => ({ url: publicUrl(f), path: `/uploads/${f.filename}` })), '上传成功'));
});

export default r;
