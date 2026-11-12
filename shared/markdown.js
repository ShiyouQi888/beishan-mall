/**
 * 轻量 Markdown → 安全 HTML 渲染器（前后端共用，零依赖）
 *
 * 用在后台可编辑的「协议 / 须知 / 公告」内容上：
 *   - 后台可以直接粘贴 Markdown 文档，前台拿到的是排版好的 HTML
 *   - 老数据里已经是 HTML 的，原样返回（由前台 sanitizeHtml 再净化一次）
 *   - 输出只含白名单标签，原文一律先转义，天然免疫 <script> / javascript: 等注入
 *   - 不依赖 DOM，Node 服务端、admin 预览、H5 兜底都能用
 *
 * 支持的语法：# 标题、段落与软换行、**粗体**、*斜体*、~~删除线~~、`行内代码`、
 *   代码块 ```、无序/有序列表（含一层缩进嵌套）、> 引用、--- 分隔线、
 *   表格、[链接](url)、![图片](url)。
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);

/** 已经像是 HTML 的内容不再转换，避免把老数据里的标签当 Markdown 转义掉。
 *  只认块级标签：Markdown 文档里偶尔夹一行 <img> / <a> 不应把整篇误判成 HTML，
 *  否则原文会被直通、失去转义保护。行内标签本来就由 Markdown 语法生成。 */
const HTML_TAG = /<(?:p|div|h[1-6]|ul|ol|li|dl|table|thead|tbody|tfoot|tr|th|td|blockquote|pre|section|article|figure|figcaption)\b[^>]*>/i;

/** 只允许常规链接；javascript: / data: 一律降级成纯文本 */
function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^(https?:\/\/|mailto:|\/|#)/i.test(u)) return u;
  return '';
}

/** 行内语法：输入是未经转义的原文，输出是安全 HTML 片段 */
function inline(raw) {
  let s = escapeText(raw);

  // 行内代码先占位，避免里面的 * _ [ ] 被后续规则吃掉
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 允许 URL 里出现成对的括号（如 javascript:alert(1)），否则会留下一个残括号
  const IN_PARENS = '\\(([^)]*(?:\\([^)]*\\)[^)]*)*)\\)';
  const imgRe = new RegExp(`!\\[([^\\]]*)\\]${IN_PARENS}`, 'g');
  const linkRe = new RegExp(`\\[([^\\]]+)\\]${IN_PARENS}`, 'g');
  s = s.replace(imgRe, (_, alt, url) => {
    const u = safeUrl(url);
    return u ? `<img src="${u}" alt="${alt}" />` : alt;
  });
  s = s.replace(linkRe, (_, text, url) => {
    const u = safeUrl(url);
    return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  // 行尾两个空格表示硬换行
  s = s.replace(/ {2,}$/g, '<br />');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] || '');
}

const HEADING = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*```/;

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 表格：表头 + |---|---| 分隔行 + 若干数据行 */
function parseTable(lines, start) {
  if (start + 1 >= lines.length || !/^\s*\|/.test(lines[start])) return null;
  const head = splitTableRow(lines[start]);
  const align = splitTableRow(lines[start + 1]);
  if (!head.length || !align.length || !align.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  const rows = [];
  let i = start + 2;
  while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].trim()) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  const cells = (row, tag) => row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('');
  const html =
    `<table><thead><tr>${cells(head, 'th')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`;
  return { html, next: i };
}

/** 列表：按缩进构造一层嵌套树，输出合法的 <ul>/<ol> 结构 */
function parseList(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m) break;
    items.push({
      indent: m[1].replace(/\t/g, '  ').length,
      ordered: /^\d/.test(m[2]),
      text: m[3],
    });
    i += 1;
  }
  if (!items.length) return null;

  const root = { ordered: items[0].ordered, children: [] };
  const stack = [{ indent: items[0].indent, node: root }];
  for (const item of items) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
    let parent = stack[stack.length - 1].node;
    if (item.indent > stack[stack.length - 1].indent && parent.children.length) {
      // 更深一层：挂在上一项 <li> 里，同级连续子项复用同一个子列表
      const last = parent.children[parent.children.length - 1];
      if (!last.sub || last.sub.ordered !== item.ordered) {
        last.sub = { ordered: item.ordered, children: [] };
      }
      stack.push({ indent: item.indent, node: last.sub });
      parent = last.sub;
    }
    parent.children.push({ text: item.text });
  }

  const render = (node) => {
    const tag = node.ordered ? 'ol' : 'ul';
    return `<${tag}>${node.children
      .map((li) => `<li>${inline(li.text)}${li.sub ? render(li.sub) : ''}</li>`)
      .join('')}</${tag}>`;
  };
  return { html: render(root), next: i };
}

function markdownToHtml(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    // 代码块
    if (FENCE.test(line)) {
      const buf = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) { buf.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      out.push(`<pre><code>${escapeText(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 表格
    const table = parseTable(lines, i);
    if (table) { out.push(table.html); i = table.next; continue; }

    // 标题
    const h = line.match(HEADING);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i += 1; continue; }

    // 分隔线
    if (HR.test(line)) { out.push('<hr />'); i += 1; continue; }

    // 引用（连续 > 行递归渲染内部块）
    if (QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表
    const list = parseList(lines, i);
    if (list) { out.push(list.html); i = list.next; continue; }

    // 普通段落：连续非空行合并，单个换行渲染成 <br />
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    if (buf.length) out.push(`<p>${buf.map(inline).join('<br />')}</p>`);
    else i += 1; // 兜底，防止异常输入死循环
  }
  return out.join('\n');
}

/**
 * 统一入口：HTML 原样返回，其他内容按 Markdown 渲染成安全 HTML。
 * 幂等 —— renderRich(renderRich(x)) === renderRich(x)。
 */
export function renderRich(raw) {
  const src = String(raw ?? '');
  if (!src.trim()) return '';
  if (HTML_TAG.test(src)) return src;
  return markdownToHtml(src.trim());
}

export default renderRich;
