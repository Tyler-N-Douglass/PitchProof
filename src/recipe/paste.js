/**
 * The manual paste surface (§9).
 *
 * "The studio's assumption is that the user brings real outputs — produced in
 * Gradial, produced by their own agent, or written by hand — and pastes or
 * imports them as renditions. **This path must be excellent, not a fallback.**"
 *
 * `parsePasted` is that path's front door. It takes whatever actually lands on a
 * clipboard — plain text, Markdown-ish text, or the HTML a browser copies out of
 * a rendered page — and returns faithful `ContentBlock[]`. Faithful means: no
 * block invented, no block silently dropped, heading levels preserved, list
 * nesting preserved as indentation, table headers detected rather than assumed,
 * and links promoted to `cta` only when they read as calls to action.
 *
 * It is deliberately self-contained rather than built on L3's `parseHtml`
 * (D-L7-6): clipboard HTML is a *fragment*, frequently unbalanced, and this
 * module has to work with no ingest pipeline present at all.
 *
 * @module recipe/paste
 */

import { normalizeWhitespace, flatten } from './text.js';

/** Elements that never have children. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Elements whose text content is never content. */
const DROPPED = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'svg', 'iframe', 'object', 'canvas']);

/** Elements that close an open `p`. */
const BLOCKISH = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dt', 'dd',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Tags whose close is implied by the open of certain siblings. */
const IMPLIED_CLOSE = {
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  p: BLOCKISH,
  tr: new Set(['tr']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option']),
};

/** Named character references worth decoding without a 2,000-entry table. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '', zwnj: '', zwj: '', minus: '−', prime: '′', Prime: '″', permil: '‰',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', ntilde: 'ñ', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú',
};

/**
 * Decode numeric and the common named character references.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

/**
 * @typedef {object} PasteNode
 * @property {'element'|'text'} type
 * @property {string} [tag]
 * @property {Record<string,string>} [attrs]
 * @property {PasteNode[]} [children]
 * @property {string} [text]
 */

/**
 * Parse an attribute list. Tolerates unquoted values and bare attributes.
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseAttrs(body) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    if (!name || name === '/') continue;
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    out[name] = decodeEntities(value);
  }
  return out;
}

/**
 * A tolerant HTML fragment parser. Never throws on malformed input — clipboard
 * HTML is malformed as a matter of course.
 * @param {string} html
 * @returns {PasteNode}
 */
export function parseFragment(html) {
  /** @type {PasteNode} */
  const root = { type: 'element', tag: '#root', attrs: {}, children: [] };
  /** @type {PasteNode[]} */
  const stack = [root];
  const src = String(html == null ? '' : html);
  let i = 0;

  const top = () => stack[stack.length - 1];
  /** @param {string} text */
  const pushText = (text) => {
    if (!text) return;
    const decoded = decodeEntities(text);
    if (!decoded) return;
    top().children.push({ type: 'text', text: decoded });
  };
  /** @param {string} tag */
  const closeTo = (tag) => {
    for (let d = stack.length - 1; d > 0; d--) {
      if (stack[d].tag === tag) { stack.length = d; return true; }
    }
    return false;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt < 0) { pushText(src.slice(lt)); break; }
    const inner = src.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      const tag = inner.slice(1).trim().toLowerCase();
      if (tag) closeTo(tag);
      i = gt + 1;
      continue;
    }

    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
    if (!nameMatch) { pushText(src.slice(lt, gt + 1)); i = gt + 1; continue; }
    const tag = nameMatch[1].toLowerCase();
    const attrs = parseAttrs(inner.slice(nameMatch[1].length));
    const selfClosing = inner.trimEnd().endsWith('/');

    if (DROPPED.has(tag)) {
      const closeTag = `</${tag}`;
      const end = src.toLowerCase().indexOf(closeTag, gt);
      if (VOID.has(tag) || selfClosing || end < 0) { i = gt + 1; continue; }
      const endGt = src.indexOf('>', end);
      i = endGt < 0 ? src.length : endGt + 1;
      continue;
    }

    // Implied close: `<li>` closes an open `<li>`, `<p>` closes an open `<p>`, …
    for (let d = stack.length - 1; d > 0; d--) {
      const openTag = stack[d].tag;
      const closes = IMPLIED_CLOSE[openTag];
      if (closes && closes.has(tag)) { stack.length = d; } else break;
    }

    /** @type {PasteNode} */
    const node = { type: 'element', tag, attrs, children: [] };
    top().children.push(node);
    if (!VOID.has(tag) && !selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

/** Inline elements whose text folds into the surrounding run. */
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'font']);

/**
 * The visible text of a node, with `<br>` becoming a newline.
 * @param {PasteNode} node
 * @returns {string}
 */
export function nodeText(node) {
  if (node.type === 'text') return node.text || '';
  if (node.tag === 'br') return '\n';
  if (DROPPED.has(node.tag || '')) return '';
  let out = '';
  for (const c of node.children || []) out += nodeText(c);
  return out;
}

/** Verbs that make a link read as a call to action. */
const ACTION_VERBS = /^(get|start|try|book|request|learn|see|shop|buy|download|sign|contact|explore|discover|read|watch|join|subscribe|schedule|talk|find|view|browse|order|apply|register|create|build|compare|calculate|demo|call|chat|open|continue|next|go)\b/i;

/**
 * Does this link text read as a call to action rather than prose?
 * @param {string} label
 * @param {Record<string,string>} [attrs]
 * @returns {boolean}
 */
export function looksLikeCta(label, attrs = {}) {
  const text = flatten(label);
  if (!text) return false;
  const words = text.split(/\s+/).length;
  if (words > 8) return false;
  const cls = `${attrs.class || ''} ${attrs.role || ''} ${attrs['data-testid'] || ''}`.toLowerCase();
  if (/\b(btn|button|cta|call-to-action)\b/.test(cls)) return true;
  if (/[→›»➔▸]\s*$/.test(text)) return true;
  if (ACTION_VERBS.test(text) && words <= 6) return true;
  return false;
}

/**
 * @param {PasteNode} node
 * @returns {boolean} true when the element contains no block-level descendant
 */
function inlineOnly(node) {
  for (const c of node.children || []) {
    if (c.type !== 'element') continue;
    if (!INLINE.has(c.tag || '') && c.tag !== 'br' && c.tag !== 'img') return false;
    if (!inlineOnly(c)) return false;
  }
  return true;
}

/**
 * The single `<a>` an element consists of, if it consists of one.
 * @param {PasteNode} node
 * @returns {PasteNode|null}
 */
function soleLink(node) {
  /** @type {PasteNode[]} */
  const links = [];
  let otherText = '';
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.type === 'text') { otherText += c.text || ''; continue; }
      if (c.tag === 'a') { links.push(c); continue; }
      walk(c);
    }
  };
  walk(node);
  if (links.length !== 1) return null;
  return otherText.trim() === '' ? links[0] : null;
}

/**
 * Turn a parsed HTML fragment into blocks.
 * @param {PasteNode} root
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function blocksFromFragment(root) {
  /** @type {import('../core/contracts.d.ts').ContentBlock[]} */
  const out = [];

  /** @param {string} text @param {number} level */
  const pushHeading = (text, level) => {
    const t = flatten(text);
    if (t) out.push({ type: 'heading', level: /** @type {any} */(Math.min(6, Math.max(1, level))), text: t });
  };
  /** @param {string} text */
  const pushParagraph = (text) => {
    const t = normalizeWhitespace(text);
    if (t) out.push({ type: 'paragraph', text: t.replace(/\n+/g, ' ') });
  };

  /**
   * @param {PasteNode} node
   * @param {number} depth
   */
  const visit = (node, depth) => {
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const t = flatten(child.text || '');
        if (t) pushParagraph(t);
        continue;
      }
      const tag = child.tag || '';
      if (DROPPED.has(tag)) continue;

      if (/^h[1-6]$/.test(tag)) { pushHeading(nodeText(child), Number(tag[1])); continue; }

      if (tag === 'p' || tag === 'figcaption' || tag === 'dd' || tag === 'dt') {
        const link = soleLink(child);
        if (link && looksLikeCta(nodeText(link), link.attrs)) {
          out.push({ type: 'cta', label: flatten(nodeText(link)), href: link.attrs.href || null });
          continue;
        }
        const inner = nodeText(child);
        const imgs = collectTag(child, 'img');
        if (flatten(inner) === '' && imgs.length) { imgs.forEach((im) => pushImage(out, im)); continue; }
        pushParagraph(inner);
        imgs.forEach((im) => pushImage(out, im));
        continue;
      }

      if (tag === 'figure') {
        const imgs = collectTag(child, 'img');
        const caps = collectTag(child, 'figcaption');
        const caption = caps.length ? flatten(nodeText(caps[0])) : '';
        if (imgs.length) {
          imgs.forEach((im, idx) => {
            const src = (im.attrs && (im.attrs.src || im.attrs['data-src'])) || '';
            if (!src) return;
            const text = idx === 0 && caption ? caption : flatten((im.attrs && im.attrs.alt) || '');
            out.push(text ? { type: 'media', ref: src, caption: text } : { type: 'media', ref: src });
          });
          continue;
        }
        if (caption) pushParagraph(caption);
        continue;
      }

      if (tag === 'ul' || tag === 'ol') { out.push(listBlock(child, tag === 'ol')); continue; }

      if (tag === 'blockquote') { out.push(quoteBlock(child)); continue; }

      if (tag === 'table') { const t = tableBlock(child); if (t) out.push(t); continue; }

      if (tag === 'pre') {
        const text = nodeText(child).replace(/\n+$/, '');
        if (text.trim()) out.push({ type: 'raw', html: `<pre><code>${escapeHtml(text)}</code></pre>` });
        continue;
      }

      if (tag === 'img') { pushImage(out, child); continue; }

      if (tag === 'hr' || tag === 'br') continue;

      if (tag === 'a') {
        const label = flatten(nodeText(child));
        if (!label) continue;
        if (looksLikeCta(label, child.attrs)) out.push({ type: 'cta', label, href: child.attrs.href || null });
        else pushParagraph(label);
        continue;
      }

      if (tag === 'button') {
        const label = flatten(nodeText(child));
        if (label) out.push({ type: 'cta', label, href: null });
        continue;
      }

      if (INLINE.has(tag)) { pushParagraph(nodeText(child)); continue; }

      // A container. If it holds only inline content it is a paragraph; if it
      // holds blocks, recurse so nothing is flattened away.
      if (inlineOnly(child)) {
        const link = soleLink(child);
        if (link && looksLikeCta(nodeText(link), link.attrs)) {
          out.push({ type: 'cta', label: flatten(nodeText(link)), href: link.attrs.href || null });
          continue;
        }
        const imgs = collectTag(child, 'img');
        const text = nodeText(child);
        if (flatten(text)) pushParagraph(text);
        imgs.forEach((im) => pushImage(out, im));
        continue;
      }
      if (depth < 64) visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return out;
}

/**
 * @param {import('../core/contracts.d.ts').ContentBlock[]} out
 * @param {PasteNode} img
 */
function pushImage(out, img) {
  const src = (img.attrs && (img.attrs.src || img.attrs['data-src'])) || '';
  if (!src) return;
  const alt = (img.attrs && img.attrs.alt) || '';
  /** @type {import('../core/contracts.d.ts').ContentBlock} */
  const block = alt ? { type: 'media', ref: src, caption: flatten(alt) } : { type: 'media', ref: src };
  out.push(block);
}

/**
 * @param {PasteNode} node
 * @param {string} tag
 * @returns {PasteNode[]}
 */
function collectTag(node, tag) {
  /** @type {PasteNode[]} */
  const out = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.type !== 'element') continue;
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/**
 * A list, with nesting preserved as two spaces of indentation per level so no
 * item is lost and no character is invented.
 * @param {PasteNode} node
 * @param {boolean} ordered
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
function listBlock(node, ordered) {
  /** @type {string[]} */
  const items = [];
  /** @param {PasteNode} list @param {number} level */
  const walk = (list, level) => {
    for (const li of list.children || []) {
      if (li.type !== 'element' || li.tag !== 'li') continue;
      let own = '';
      /** @type {PasteNode[]} */
      const sublists = [];
      for (const c of li.children || []) {
        if (c.type === 'element' && (c.tag === 'ul' || c.tag === 'ol')) { sublists.push(c); continue; }
        own += nodeText(c);
      }
      const text = flatten(own);
      if (text) items.push(`${'  '.repeat(level)}${text}`);
      for (const sub of sublists) walk(sub, level + 1);
    }
  };
  walk(node, 0);
  return { type: 'list', ordered, items };
}

/**
 * A blockquote. A trailing `cite`, `footer` or em-dash line becomes the
 * attribution — the shape a real testimonial arrives in.
 * @param {PasteNode} node
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
function quoteBlock(node) {
  /** @type {string|undefined} */
  let attribution;
  let body = '';
  for (const c of node.children || []) {
    if (c.type === 'element' && (c.tag === 'cite' || c.tag === 'footer')) {
      const t = flatten(nodeText(c));
      if (t) attribution = t.replace(/^[—–-]\s*/, '');
      continue;
    }
    body += nodeText(c);
  }
  let text = normalizeWhitespace(body).replace(/\n+/g, ' ');
  if (!attribution) {
    const m = /\s[—–]\s*([^—–]{2,80})$/.exec(text);
    if (m) { attribution = m[1].trim(); text = text.slice(0, m.index).trim(); }
  }
  return attribution ? { type: 'quote', text, attribution } : { type: 'quote', text };
}

/**
 * A table. The header row is *detected* — a `thead`, or a first row made
 * entirely of `th` — never assumed.
 * @param {PasteNode} node
 * @returns {import('../core/contracts.d.ts').ContentBlock|null}
 */
function tableBlock(node) {
  /** @type {{cells: string[], allTh: boolean, inHead: boolean}[]} */
  const rows = [];
  /** @param {PasteNode} n @param {boolean} inHead */
  const walk = (n, inHead) => {
    for (const c of n.children || []) {
      if (c.type !== 'element') continue;
      if (c.tag === 'thead') { walk(c, true); continue; }
      if (c.tag === 'tbody' || c.tag === 'tfoot') { walk(c, false); continue; }
      if (c.tag === 'tr') {
        /** @type {string[]} */
        const cells = [];
        let allTh = true;
        let any = false;
        for (const cell of c.children || []) {
          if (cell.type !== 'element' || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
          any = true;
          if (cell.tag !== 'th') allTh = false;
          cells.push(flatten(nodeText(cell)));
        }
        if (any) rows.push({ cells, allTh, inHead });
        continue;
      }
      walk(c, inHead);
    }
  };
  walk(node, false);
  if (rows.length === 0) return null;
  const header = rows[0].inHead || rows[0].allTh;
  const width = rows.reduce((n, r) => Math.max(n, r.cells.length), 0);
  return { type: 'table', header, rows: rows.map((r) => padRow(r.cells, width)) };
}

/**
 * @param {string[]} cells
 * @param {number} width
 * @returns {string[]}
 */
function padRow(cells, width) {
  const out = cells.slice();
  while (out.length < width) out.push('');
  return out;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Does this text look like HTML rather than prose that merely contains a `<`?
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeHtml(text) {
  const s = String(text == null ? '' : text);
  if (/^\s*<(!doctype|html|body|div|table|section|article|ul|ol|p|h[1-6])\b/i.test(s)) return true;
  const tags = s.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g) || [];
  if (tags.length < 2) return false;
  const known = tags.filter((t) => {
    const name = (/<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(t) || [])[1];
    return name && (VOID.has(name.toLowerCase()) || BLOCKISH.has(name.toLowerCase()) || INLINE.has(name.toLowerCase()) || DROPPED.has(name.toLowerCase()));
  });
  return known.length >= 2;
}

/* ------------------------------------------------------------------ *
 * Markdown-ish and plain text
 * ------------------------------------------------------------------ */

/**
 * Strip inline Markdown emphasis and code markers, keeping the text.
 * @param {string} s
 * @returns {string}
 */
export function stripInlineMarkdown(s) {
  return String(s == null ? '' : s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}])([*_])(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}])/gu, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '');
}

const MD_LINK_ONLY = /^\s*\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const MD_IMAGE_ONLY = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const MD_BULLET = /^(\s*)([-*+•])\s+(.*)$/;
const MD_ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const MD_TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const MD_TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Parse Markdown-ish or plain text.
 * @param {string} text
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function blocksFromText(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  /** @type {import('../core/contracts.d.ts').ContentBlock[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];

  /**
   * A paragraph run ends here. One line of short, unpunctuated text standing
   * alone between blank lines is how a copied page title arrives in plain text,
   * so it becomes a heading: level 1 when it opens the paste, level 2 after.
   * Anything longer, punctuated, or multi-line stays a paragraph.
   */
  const flushParagraph = () => {
    if (para.length === 0) return;
    const lineCount = para.length;
    const joined = para.join(' ').replace(/\s+/g, ' ').trim();
    para = [];
    if (!joined) return;
    const words = joined.split(' ').length;
    const isCaps = joined === joined.toUpperCase() && /\p{L}/u.test(joined);
    const headingShaped = lineCount === 1 && words <= 10 && joined.length <= 60 && !/[.,;:!?]$/.test(joined);
    if (lineCount === 1 && (headingShaped || (isCaps && words <= 10 && joined.length <= 60))) {
      out.push({ type: 'heading', level: /** @type {any} */(out.length === 0 ? 1 : 2), text: joined });
      return;
    }
    out.push({ type: 'paragraph', text: joined });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { flushParagraph(); continue; }

    // Fenced code.
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0].repeat(3);
      /** @type {string[]} */
      const body = [];
      i += 1;
      for (; i < lines.length; i++) {
        if (new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i])) break;
        body.push(lines[i]);
      }
      if (body.length) out.push({ type: 'raw', html: `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>` });
      continue;
    }

    // ATX heading.
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      flushParagraph();
      const t = stripInlineMarkdown(atx[2]).trim();
      if (t) out.push({ type: 'heading', level: /** @type {any} */(atx[1].length), text: t });
      continue;
    }

    // Setext heading: the underline belongs to the paragraph just accumulated.
    const setext = /^\s{0,3}(=+|-{2,})\s*$/.exec(line);
    if (setext && para.length === 1) {
      const t = stripInlineMarkdown(para[0]).trim();
      para = [];
      if (t) out.push({ type: 'heading', level: setext[1][0] === '=' ? 1 : 2, text: t });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && para.length === 0) continue;

    // Tables.
    if (MD_TABLE_ROW.test(line)) {
      flushParagraph();
      /** @type {string[][]} */
      const rows = [];
      let header = false;
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!MD_TABLE_ROW.test(l)) break;
        if (MD_TABLE_RULE.test(l)) { if (rows.length === 1) header = true; continue; }
        const cells = (MD_TABLE_ROW.exec(l) || [])[1].split('|').map((c) => stripInlineMarkdown(c).trim());
        rows.push(cells);
      }
      i -= 1;
      if (rows.length) {
        const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
        out.push({ type: 'table', header, rows: rows.map((r) => padRow(r, width)) });
      }
      continue;
    }

    // Blockquote.
    if (/^\s{0,3}>/.test(line)) {
      flushParagraph();
      /** @type {string[]} */
      const body = [];
      for (; i < lines.length; i++) {
        if (!/^\s{0,3}>/.test(lines[i])) break;
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      }
      i -= 1;
      let text = stripInlineMarkdown(body.join(' ')).replace(/\s+/g, ' ').trim();
      /** @type {string|undefined} */
      let attribution;
      const m = /\s[—–]\s*([^—–]{2,80})$/.exec(text);
      if (m) { attribution = m[1].trim(); text = text.slice(0, m.index).trim(); }
      if (text) out.push(attribution ? { type: 'quote', text, attribution } : { type: 'quote', text });
      continue;
    }

    // Lists.
    if (MD_BULLET.test(line) || MD_ORDERED.test(line)) {
      flushParagraph();
      const ordered = !MD_BULLET.test(line);
      /** @type {string[]} */
      const items = [];
      let baseIndent = -1;
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '') {
          const next = lines[i + 1] || '';
          if (MD_BULLET.test(next) || MD_ORDERED.test(next)) continue;
          break;
        }
        const bm = MD_BULLET.exec(l);
        const om = MD_ORDERED.exec(l);
        const m = ordered ? (om || bm) : (bm || om);
        if (!m) {
          if (items.length && /^\s+\S/.test(l)) { items[items.length - 1] += ` ${stripInlineMarkdown(l.trim())}`; continue; }
          break;
        }
        const indent = m[1].replace(/\t/g, '  ').length;
        if (baseIndent < 0) baseIndent = indent;
        const level = Math.max(0, Math.floor((indent - baseIndent) / 2));
        items.push(`${'  '.repeat(level)}${stripInlineMarkdown(m[3]).trim()}`);
      }
      i -= 1;
      if (items.length) out.push({ type: 'list', ordered, items });
      continue;
    }

    // A standalone image or link line.
    const img = MD_IMAGE_ONLY.exec(line);
    if (img) {
      flushParagraph();
      const alt = img[1].trim();
      out.push(alt ? { type: 'media', ref: img[2], caption: alt } : { type: 'media', ref: img[2] });
      continue;
    }
    const link = MD_LINK_ONLY.exec(line);
    if (link && looksLikeCta(link[1])) {
      flushParagraph();
      out.push({ type: 'cta', label: flatten(link[1]), href: link[2] });
      continue;
    }

    para.push(stripInlineMarkdown(line).trim());
  }
  flushParagraph();
  return out;
}

/**
 * Turn pasted plain text, Markdown-ish text or pasted HTML into blocks.
 *
 * Detection is by content, not by a flag: HTML is recognised structurally, and
 * anything else goes through the Markdown-ish reader, which degrades to plain
 * paragraphs when no markers are present.
 *
 * @param {string} text
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function parsePasted(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return [];
  if (looksLikeHtml(src)) {
    const blocks = blocksFromFragment(parseFragment(src));
    if (blocks.length) return blocks;
  }
  return blocksFromText(src);
}
