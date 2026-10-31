// 上传前的「不裁剪」预处理
//
// 背景：原来的上传组件选完文件必须进裁剪器确认一次才能上传，
// 但绝大多数场景（商品图、轮播图、素材库）只是想把原图传上去，
// 被迫裁剪不仅多一步，还容易把边缘内容裁掉。
//
// 这里只做两件事：超尺寸等比缩小、超大体积压缩。
// 永远不改变画面比例和内容 —— 想裁剪请走 ImageEditor 的显式入口。

/** 最大边长，超过就等比缩小（不改比例） */
const MAX_EDGE = 2560;
/** 体积超过这个值就重编码压缩，否则原文件直传，避免无谓的画质损失 */
const MAX_BYTES = 4 * 1024 * 1024;
/** 压缩质量 */
const QUALITY = 0.86;

let webpSupported;

function supportsWebp() {
  if (webpSupported !== undefined) return webpSupported;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpSupported = false;
  }
  return webpSupported;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这张图片无法读取，请换一张（不支持 HEIC 等格式）'));
    };
    img.src = url;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片处理失败，请换一种格式重试'))), type, quality);
  });
}

function safeName(name, ext) {
  const base = String(name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fff-]+/g, '_') || 'image';
  return `${base}.${ext}`;
}

/**
 * 把文件处理成可直接上传的成品：只等比缩放 / 压缩，绝不裁剪。
 * 本来就够小的图片会原样返回（返回同一个 File 引用），零画质损失。
 *
 * @param {File} file
 * @param {{ maxEdge?: number, maxBytes?: number, quality?: number }} [options]
 * @returns {Promise<File>}
 */
export async function prepareImage(file, options = {}) {
  if (!file) throw new Error('没有读到要上传的图片');
  const maxEdge = options.maxEdge || MAX_EDGE;
  const maxBytes = options.maxBytes || MAX_BYTES;
  const quality = options.quality || QUALITY;

  // GIF 走 canvas 会丢动画帧，原样上传；超过服务端限制时给出明确提示
  if (file.type === 'image/gif') {
    if (file.size > 10 * 1024 * 1024) throw new Error('GIF 超过 10MB，请压缩后再上传');
    return file;
  }

  const img = await loadImageElement(file);
  const naturalWidth = img.naturalWidth || 0;
  const naturalHeight = img.naturalHeight || 0;
  if (!naturalWidth || !naturalHeight) throw new Error('无法获取图片尺寸，请换一张重试');

  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  if (scale >= 1 && file.size <= maxBytes) return file;

  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法处理图片，请换一个浏览器重试');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const useWebp = supportsWebp();
  // 回退到 JPEG 时先铺白底，避免透明 PNG 变黑
  if (!useWebp) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await toBlob(canvas, useWebp ? 'image/webp' : 'image/jpeg', quality);
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], safeName(file.name, ext), { type: blob.type, lastModified: Date.now() });
}
