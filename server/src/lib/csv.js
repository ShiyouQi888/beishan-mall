// CSV 导出的小工具：订单、转拍订单等导出共用
//
// 两个坑都在这儿挡住了：
//   1. 不加 UTF-8 BOM，Excel 打开中文就是乱码
//   2. 商品名/备注里可能有逗号、引号、换行，不转义会把后面的列全部挤错位
export const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @param {string[]} header @param {Array<Array<any>>} rows */
export function toCsv(header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '\ufeff' + lines.join('\r\n');
}

/** 直接写回响应：附件下载 + 已有 BOM 的文本 */
export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
