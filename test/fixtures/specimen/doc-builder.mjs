/**
 * A minimal `DocNode` builder for the specimen fixtures.
 *
 * L3 owns the real parser (`src/ingest/html-parse.js`, D8) and the shipped
 * `src/specimen/**` never contains one. This exists only so the §17.5 corpus
 * can be scored while L3 is still landing, and `corpus.mjs` prefers the real
 * parser whenever it is importable — see `PARSER_SOURCE`.
 *
 * It produces exactly the shape the contract declares:
 *   { type: 'element'|'text'|'comment', tag?, attrs?, children?, text?, parent? }
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', middot: '·', pound: '£', euro: '€', deg: '°',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”',
};

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

/** @param {string} source @returns {any} */
export function buildDoc(source) {
  const src = String(source ?? '');
  const document = { type: 'element', tag: '#document', attrs: {}, children: [] };
  const html = append(document, { type: 'element', tag: 'html', attrs: {}, children: [] });
  const head = append(html, { type: 'element', tag: 'head', attrs: {}, children: [] });
  let body = null;
  let stack = [html, head];
  let inBody = false;

  const openBody = () => {
    if (inBody) return;
    stack = [html];
    body = append(html, { type: 'element', tag: 'body', attrs: {}, children: [] });
    stack.push(body);
    inBody = true;
  };
  const top = () => stack[stack.length - 1];

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(top(), src.slice(i), openBody); break; }
    if (lt > i) addText(top(), src.slice(i, lt), openBody);

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end < 0 ? src.length : end + 3;
      append(top(), { type: 'comment', text: src.slice(lt + 4, end < 0 ? src.length : end), children: [] });
      i = stop;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const end = src.indexOf('>', lt);
    if (end < 0) { addText(top(), src.slice(lt), openBody); break; }
    const inner = src.slice(lt + 1, end);
    i = end + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      continue;
    }

    const m = /^([a-zA-Z][^\s/>]*)([\s\S]*)$/.exec(inner);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const selfClosing = /\/\s*$/.test(m[2]);

    if (tag === 'html') { Object.assign(html.attrs, attrs); continue; }
    if (tag === 'head') { stack = [html, head]; continue; }
    if (tag === 'body') {
      openBody();
      Object.assign(body.attrs, attrs);
      continue;
    }
    if (!inBody && !HEAD_TAGS.has(tag)) openBody();

    const node = append(top(), { type: 'element', tag, attrs, children: [] });
    if (VOID.has(tag) || selfClosing) continue;
    if (RAW_TEXT.has(tag)) {
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      const stop = close < 0 ? src.length : close;
      const text = src.slice(i, stop);
      if (text) append(node, { type: 'text', text, children: [] });
      const gt = close < 0 ? src.length : src.indexOf('>', close);
      i = gt < 0 ? src.length : gt + 1;
      continue;
    }
    if (IMPLICIT_CLOSE[tag]) {
      // `<li>` inside `<li>`, `<td>` inside `<td>`, and friends.
      for (let k = stack.length - 1; k >= 1; k--) {
        if (IMPLICIT_CLOSE[tag].has(stack[k].tag)) { stack.length = k; break; }
      }
    }
    stack.push(node);
  }
  return document;
}

const HEAD_TAGS = new Set(['meta', 'link', 'title', 'style', 'base', 'script']);
const IMPLICIT_CLOSE = {
  li: new Set(['li']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
  tr: new Set(['tr']),
  p: new Set(['p']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
};

function append(parent, node) {
  node.parent = parent;
  parent.children.push(node);
  return node;
}

function addText(parent, text, openBody) {
  if (!text) return;
  if (parent.tag === 'head' || parent.tag === 'html' || parent.tag === '#document') {
    if (!text.trim()) return;
    openBody();
    return;
  }
  append(parent, { type: 'text', text: decodeEntities(text), children: [] });
}

function parseAttrs(rest) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const re = /([^\s=/>]+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m = re.exec(rest);
  while (m) {
    const name = m[1].toLowerCase();
    if (name !== '/') {
      const value = m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : (m[6] !== undefined ? m[6] : ''));
      attrs[name] = decodeEntities(value);
    }
    m = re.exec(rest);
  }
  return attrs;
}
