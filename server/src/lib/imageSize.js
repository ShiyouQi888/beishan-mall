// 读取图片宽高：只解析文件头，不解码整张图，几百 KB 的图也就读几十字节
// 支持 PNG / JPEG / GIF / WebP，其它格式返回 0（前端显示「—」即可）
import { openSync, readSync, closeSync } from 'node:fs';

const HEAD = 96 * 1024; // JPEG 的 SOF 段可能靠后一点，读前 96KB 足够

function readHead(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEAD);
    const n = readSync(fd, buf, 0, HEAD, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function png(b) {
  if (b.length < 24) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b) {
  if (b.length < 10) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpeg(b) {
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    // SOF0-3 / SOF5-7 / SOF9-11 / SOF13-15 都带尺寸
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    // 其它段：跳过「长度」字节
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webp(b) {
  if (b.length < 30) return null;
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fmt === 'VP8L') {
    const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (fmt === 'VP8X') {
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/** @returns {{width:number,height:number}} 读不出来时返回 0×0 */
export function imageSize(filePath) {
  try {
    const b = readHead(filePath);
    let r = null;
    if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') r = png(b);
    else if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') r = gif(b);
    else if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) r = jpeg(b);
    else if (b.length > 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') r = webp(b);
    if (!r || !r.width || !r.height) return { width: 0, height: 0 };
    return { width: Number(r.width) || 0, height: Number(r.height) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 文件后缀 → mime（素材库只收图片，够用） */
export const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
