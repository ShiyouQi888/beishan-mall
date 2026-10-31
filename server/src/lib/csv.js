// CSV 导出的小工具：订单、转拍订单等导出共用
//
// 两个坑都在这儿挡住了：
//   1. 不加 UTF-8 BOM，Excel 打开中文就是乱码
//   2. 商品名/备注里可能有逗号、引号、换行，不转义会把后面的列全部挤错位
export const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 时间/日期列专用。
 *
 * Excel 打开 CSV 时会把「2026-10-31 16:40:13」认成日期，列宽一旦不够就整列显示成 ####，
 * 用户看到的就是「导出没有时间」。包成 ="..." 之后 Excel 按公式取文本、整列变成文本格式，
 * 不会再被当日期压缩（WPS / Google 表格同样识别）。
 *
 * 不能用 csvCell 再包一层引号，否则 Excel 会原样显示 ="..." 这段字符。
 */
export const csvTime = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s) return '';
  return `="${s.replace(/"/g, '""')}"`;
};

/** 单格输出：csvTime 的 ="..." 要原样落盘，再包一层引号 Excel 就显示成字面量了 */
const cellOut = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  if (/^="[^"]*"$/.test(s)) return s;
  return csvCell(s);
};

/** @param {string[]} header @param {Array<Array<any>>} rows */
export function toCsv(header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(cellOut).join(','));
  return '\ufeff' + lines.join('\r\n');
}

/** 直接写回响应：附件下载 + 已有 BOM 的文本 */
export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
