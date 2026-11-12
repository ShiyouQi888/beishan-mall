/**
 * 会员服务电子合同：版本指纹、签名图校验与落盘、签署记录写入。
 *
 * 设计取舍：
 *   - 签名发生在注册之前，此时还没有 member_id，所以签名数据随 registerAnAccount
 *     一起提交，由注册事务原子写入，不开放匿名上传接口，也不产生孤儿文件。
 *   - 后台随时可改合同正文，签署记录必须带上"当时那一版"的版本指纹和正文快照，
 *     否则事后无法举证用户签的是什么。
 *   - 后端只校验"提交上来的签名数据"是否合法；不强制所有注册都必须带签名，
 *     以兼容既有 API 客户端 / 探针（30+ 处直接调注册接口）。H5 侧的强制由
 *     contract_sign_required 开关控制，见 /index/getRegisterAgreements。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, run, now } from '../db.js';
import { cfg } from './helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = process.env.UPLOAD_DIR || join(__dirname, '..', '..', 'data', 'uploads');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIGN_BYTES = 150 * 1024;

/** 与 schema.sql 保持一致的幂等建表（老库启动时补上） */
export function ensureContractSignTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_signature (
      sign_id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL DEFAULT 0,
      phone TEXT NOT NULL DEFAULT '',
      real_name TEXT NOT NULL DEFAULT '',
      sign_image TEXT NOT NULL DEFAULT '',
      contract_title TEXT NOT NULL DEFAULT '',
      contract_version TEXT NOT NULL DEFAULT '',
      contract_snapshot TEXT NOT NULL DEFAULT '',
      read_seconds INTEGER NOT NULL DEFAULT 0,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      create_time TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contract_sign_member ON contract_signature(member_id);
    CREATE INDEX IF NOT EXISTS idx_contract_sign_phone ON contract_signature(phone);
  `);
}

/** 当前生效的合同：标题、正文、版本指纹 */
export function contractMeta() {
  const content = String(cfg('prompt_register', cfg('register_agreement', '')) ?? '');
  const title = String(cfg('contract_title', '') || '').trim() || '会员服务电子合同';
  const version = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { content, title, version };
}

/** H5 是否要求阅读完必须签署（10 开启 / 20 关闭） */
export function signRequired() {
  return String(cfg('contract_sign_required', '10')) === '10';
}

/** 校验前端提交的 data URL，返回 PNG Buffer；非法直接抛业务错误 */
export function decodeSignImage(raw) {
  const s = String(raw || '');
  const m = s.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/) || s.match(/^([A-Za-z0-9+/=]{32,})$/);
  if (!m) throw new Error('签名图片格式不正确');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 32 || buf.length > MAX_SIGN_BYTES) throw new Error('签名图片大小不正确');
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('签名图片必须为 PNG 格式');
  return buf;
}

/** 把签名 PNG 写到 uploads/sign/年月/ 下，返回可直接访问的 URL */
export function saveSignImage(buf) {
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dir = join(UPLOAD_ROOT, 'sign', ym);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomBytes(6).toString('hex')}.png`;
  writeFileSync(join(dir, name), buf);
  return `/uploads/sign/${ym}/${name}`;
}

/**
 * 在注册事务内写入签署记录。调用方负责先 decodeSignImage 得到 buf。
 * 返回 sign_id；没有签名数据时返回 0（不写记录）。
 */
export function insertSignature({ memberId, phone, realName, signBuf, meta, readSeconds, ip, userAgent }) {
  if (!signBuf) return 0;
  const url = saveSignImage(signBuf);
  const info = run(
    `INSERT INTO contract_signature
      (member_id, phone, real_name, sign_image, contract_title, contract_version,
       contract_snapshot, read_seconds, ip, user_agent, create_time)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    memberId,
    String(phone || '').trim(),
    String(realName || '').trim().slice(0, 40),
    url,
    meta.title,
    meta.version,
    meta.content,
    Math.max(0, Math.min(3600, Math.round(Number(readSeconds) || 0))),
    String(ip || '').slice(0, 60),
    String(userAgent || '').slice(0, 300),
    now(),
  );
  return Number(info.lastInsertRowid);
}

/** 取某个会员最近一次签署（会员详情里展示"已签署"用） */
export function latestSignatureOf(memberId) {
  return get('SELECT * FROM contract_signature WHERE member_id = ? ORDER BY sign_id DESC LIMIT 1', memberId);
}
