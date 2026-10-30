// 富文本净化：用于 v-html 渲染后台可编辑的内容（商品详情、公告、协议等）
//
// 为什么不直接 v-html：这些内容虽然来自后台，但后台账号一旦被攻破（弱口令、社工、
// token 泄露），攻击者就能往商品详情里塞 <script>，所有打开该商品的会员都会中招，
// 直接读走 localStorage 里的登录 token。净化是最后一道闸。
//
// 策略是白名单：只保留排版相关的标签和属性，其余一律剥掉。
const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'img', 'a', 'figure', 'figcaption', 'section', 'article',
]);

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'width', 'height', 'colspan', 'rowspan',
]);

/** 危险协议与表达式：href/src 里出现就整个属性删掉 */
const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html)/i;
/** style 里允许出现，但不允许 expression / javascript: / behavior */
const DANGEROUS_STYLE = /(expression|javascript:|vbscript:|behavior\s*:|-moz-binding)/i;

export function sanitizeHtml(html) {
  const src = String(html ?? '');
  if (!src) return '';
  // 没有 DOM 环境（SSR/测试）时退化成纯文本，宁可丢排版也不放脚本
  if (typeof window === 'undefined' || typeof window.DOMParser !== 'function') {
    return src.replace(/<[^>]*>/g, '');
  }

  const doc = new window.DOMParser().parseFromString(src, 'text/html');

  const clean = (node) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // script / style / iframe / object / form 等直接连内容一起丢掉
        el.remove();
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '');
        if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((name === 'href' || name === 'src') && DANGEROUS_URL.test(value)) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === 'style' && DANGEROUS_STYLE.test(value)) {
          el.removeAttribute(attr.name);
        }
      }
      // 外链统一加 rel，防止 window.opener 被反向控制
      if (tag === 'a' && el.getAttribute('target') === '_blank') {
        el.setAttribute('rel', 'noopener noreferrer');
      }
      clean(el);
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

/** 只取纯文本（列表摘要等场景） */
export function stripHtml(html) {
  const src = String(html ?? '');
  if (!src) return '';
  if (typeof window === 'undefined' || typeof window.DOMParser !== 'function') {
    return src.replace(/<[^>]*>/g, '');
  }
  const doc = new window.DOMParser().parseFromString(src, 'text/html');
  return doc.body.textContent || '';
}
