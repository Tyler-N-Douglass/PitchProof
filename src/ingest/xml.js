/**
 * A small, strict-enough XML reader for OOXML parts.
 *
 * `src/core/zip.js` gives the container and a regex-level attribute reader;
 * `.docx` and `.pptx` need a real tree, because paragraph structure lives in
 * nesting (`w:p > w:r > w:t`, `p:sp > p:txBody > a:p > a:r > a:t`) and a regex
 * over that produces plausible-looking wrong answers.
 *
 * Namespace prefixes are kept verbatim rather than resolved: OOXML always
 * writes the same prefixes, every consumer here matches on them, and resolving
 * would cost a namespace stack for no gain.
 *
 * @module ingest/xml
 */

import { decodeXmlEntities } from '../core/zip.js';

/**
 * @typedef {object} XmlNode
 * @property {'element'|'text'} type
 * @property {string} [name]
 * @property {Record<string,string>} [attrs]
 * @property {XmlNode[]} [children]
 * @property {string} [text]
 * @property {XmlNode|null} [parent]
 */

/**
 * Parse an XML document into a tree. Never throws: malformed markup degrades to
 * whatever structure could be recovered, because a corrupt part in a 300-slide
 * deck should cost that part, not the import.
 *
 * @param {string} xml
 * @returns {XmlNode}
 */
export function parseXml(xml) {
  const src = String(xml == null ? '' : xml);
  /** @type {XmlNode} */
  const root = { type: 'element', name: '#document', attrs: {}, children: [], parent: null };
  /** @type {XmlNode[]} */
  const stack = [root];
  let i = 0;

  const push = (node) => {
    const parent = stack[stack.length - 1];
    node.parent = parent;
    (parent.children || (parent.children = [])).push(node);
    return node;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      const tail = src.slice(i);
      if (/\S/.test(tail)) push({ type: 'text', text: decodeXmlEntities(tail) });
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.length) push({ type: 'text', text: decodeXmlEntities(text) });
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end < 0 ? src.length : end;
      push({ type: 'text', text: src.slice(lt + 9, stop) });
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? src.length : end).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // Start tag. Attribute values may contain `>`, so scan with quote awareness.
    let j = lt + 1;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j += 1;
    }
    const body = src.slice(lt + 1, j);
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = inner.match(/^([^\s/>]+)/);
    const name = nameMatch ? nameMatch[1] : '';
    const node = push({ type: 'element', name, attrs: parseAttrs(inner.slice(name.length)), children: [] });
    if (!selfClosing) stack.push(node);
    i = j < src.length ? j + 1 : src.length;
  }
  return root;
}

/**
 * @param {string} body
 * @returns {Record<string,string>}
 */
function parseAttrs(body) {
  /** @type {Record<string,string>} */
  const out = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body))) {
    const value = m[3] !== undefined ? m[3] : m[4];
    if (!(m[1] in out)) out[m[1]] = decodeXmlEntities(value);
  }
  return out;
}

/**
 * Depth-first walk in document order.
 * @param {XmlNode} node
 * @param {(node: XmlNode) => (boolean|void)} visit  return false to prune
 */
export function walkXml(node, visit) {
  if (!node) return;
  if (visit(node) === false) return;
  for (const child of node.children || []) walkXml(child, visit);
}

/**
 * Direct element children with a tag name.
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {XmlNode[]}
 */
export function childrenNamed(node, name) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.type === 'element' && c.name === name);
}

/**
 * The first direct child with a tag name, or null.
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {XmlNode|null}
 */
export function childNamed(node, name) {
  if (!node || !node.children) return null;
  for (const c of node.children) if (c.type === 'element' && c.name === name) return c;
  return null;
}

/**
 * Every descendant with a tag name, in document order.
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {XmlNode[]}
 */
export function findAll(node, name) {
  /** @type {XmlNode[]} */
  const out = [];
  if (!node) return out;
  walkXml(node, (n) => { if (n.type === 'element' && n.name === name) out.push(n); });
  return out;
}

/**
 * The first descendant with a tag name, or null.
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {XmlNode|null}
 */
export function findFirst(node, name) {
  /** @type {XmlNode|null} */
  let found = null;
  if (!node) return null;
  walkXml(node, (n) => {
    if (found) return false;
    if (n.type === 'element' && n.name === name) { found = n; return false; }
    return undefined;
  });
  return found;
}

/**
 * An attribute value, or null.
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {string|null}
 */
export function xmlAttr(node, name) {
  if (!node || !node.attrs) return null;
  return name in node.attrs ? node.attrs[name] : null;
}

/**
 * The concatenated text of a subtree.
 * @param {XmlNode|null|undefined} node
 * @returns {string}
 */
export function xmlTextOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  let out = '';
  walkXml(node, (n) => { if (n.type === 'text') out += n.text || ''; });
  return out;
}

/**
 * True when a descendant with this name exists.
 * @param {XmlNode|null|undefined} node
 * @param {string} name
 * @returns {boolean}
 */
export function hasDescendant(node, name) { return findFirst(node, name) !== null; }
