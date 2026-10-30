// 上传存储的统一配置（会员端上传与后台素材库共用）
//
// 为什么不能直接用客户端的 originalname 扩展名：
// multer 的 fileFilter 只能读到客户端自己声明的 mimetype，这个值随便改。
// 攻击者把 .html 内容标成 image/png 传上来，文件名保留 .html，
// 之后访问 /uploads/xxx.html 浏览器会按页面执行 —— 就是存储型 XSS，
// 能直接读走 localStorage 里的登录 token。所以扩展名必须由服务端定。
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const UPLOAD_DIR = process.env.UPLOAD_DIR || join(__dirname, '..', '..', 'data', 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

/** 只接受这几种图片扩展名；其余一律按 .png 存，杜绝可执行扩展名落盘 */
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function safeImageExt(originalName) {
  const e = extname(String(originalName || '')).toLowerCase();
  return ALLOWED_EXT.has(e) ? e : '.png';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}${Math.random().toString(16).slice(2, 8)}${safeImageExt(file.originalname)}`);
  },
});

export const imageUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(String(file.mimetype || ''))) cb(null, true);
    else cb(new Error('仅支持上传图片'));
  },
});
