/** Card text (Quizlet terms, Anki fields shown outside Anki's sandboxed card frame) may be
 *  HTML from anywhere: keep formatting, drop everything that could run code. */

const ALLOWED_TAGS = new Set([
  'B', 'I', 'U', 'S', 'EM', 'STRONG', 'SMALL', 'MARK', 'SUB', 'SUP', 'BR', 'HR', 'P', 'DIV', 'SPAN',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'RUBY', 'RT', 'RP', 'IMG', 'FONT', 'TABLE', 'THEAD',
  'TBODY', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'A',
]);
const ALLOWED_ATTRS = new Set(['class', 'style', 'src', 'alt', 'title', 'color', 'href', 'colspan', 'rowspan']);
/** Elements removed together with their content. */
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'FORM', 'LINK', 'META', 'BASE']);

function safeUrl(value: string, image: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (image && v.startsWith('data:image/') && !v.startsWith('data:image/svg')) return true;
  return v.startsWith('https://') || v.startsWith('http://') || (!v.includes(':') && !v.startsWith('//'));
}

function clean(node: Node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (DROP.has(el.tagName)) { el.remove(); continue; }
    if (!ALLOWED_TAGS.has(el.tagName)) {
      clean(el);
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const keep = ALLOWED_ATTRS.has(name)
        && !((name === 'src' || name === 'href') && !safeUrl(attr.value, name === 'src'))
        && !(name === 'style' && /url\(|expression|javascript:/i.test(attr.value));
      if (!keep) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    clean(el);
  }
}

const cache = new Map<string, string>();

export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return '';
  const hit = cache.get(html);
  if (hit !== undefined) return hit;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(doc.body);
  const out = doc.body.innerHTML;
  if (cache.size > 2000) cache.clear();
  cache.set(html, out);
  return out;
}
