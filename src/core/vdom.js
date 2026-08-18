/**
 * The rendering substrate.
 *
 * Every layout in PitchProof is a pure function to a VNode tree rather than to
 * DOM. That single decision buys four things the spec needs:
 *   - layouts are testable under `node --test` with no browser;
 *   - the emitter can serialize a scene to static HTML for first paint, so the
 *     artifact paints before any JavaScript runs (§12 cold-boot budget);
 *   - the automated rehearsal sweep (§14) can walk every beat of every scene
 *     headlessly and measure it;
 *   - the same tree renders identically in the studio preview and the artifact,
 *     so a rehearsal pass means something.
 *
 * @module core/vdom
 */

/**
 * @typedef {string | number | null | false | undefined | VElement | VRaw | VNode[]} VNode
 * @typedef {{ t: string, a: Record<string, unknown>, c: VNode[] }} VElement
 * @typedef {{ raw: string }} VRaw
 */

/** HTML void elements — serialized without a closing tag. */
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose children are serialized without entity escaping. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/** SVG elements needing the SVG namespace when created in a real document. */
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'text', 'tspan', 'defs', 'use', 'symbol', 'linearGradient', 'radialGradient',
  'stop', 'clipPath', 'mask', 'pattern', 'filter', 'foreignObject', 'title', 'desc',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element node.
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...VNode} children
 * @returns {VElement}
 */
export function h(tag, attrs, ...children) {
  return { t: tag, a: attrs || {}, c: children };
}

/**
 * Wrap pre-serialized markup. Used only for inline SVG logo assets and for
 * `raw` content blocks a user explicitly opted in to (§8). The emitter's
 * network scanner inspects the final document, so raw markup cannot smuggle a
 * network reference past it.
 * @param {string} html
 * @returns {VRaw}
 */
export function raw(html) {
  return { raw: String(html) };
}

/**
 * Build a class attribute from strings, arrays and conditional maps.
 * @param {...unknown} parts
 * @returns {string}
 */
export function cx(...parts) {
  /** @type {string[]} */
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (typeof p === 'string') { if (p.trim()) out.push(p.trim()); return; }
    if (Array.isArray(p)) { p.forEach(walk); return; }
    if (typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) if (v) out.push(k);
    }
  };
  parts.forEach(walk);
  return out.join(' ');
}

/**
 * Serialize a style object to a CSS declaration string with deterministic
 * ordering (insertion order of the object).
 * @param {Record<string, string|number|null|undefined|false>} style
 * @returns {string}
 */
export function styleString(style) {
  const out = [];
  for (const [k, v] of Object.entries(style)) {
    if (v === null || v === undefined || v === false || v === '') continue;
    const prop = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out.push(`${prop}:${typeof v === 'number' && !UNITLESS.has(prop) ? `${v}px` : v}`);
  }
  return out.join(';');
}

const UNITLESS = new Set([
  'opacity', 'z-index', 'flex', 'flex-grow', 'flex-shrink', 'order', 'line-height',
  'font-weight', 'zoom', 'column-count', 'grid-row', 'grid-column', 'aspect-ratio',
]);

const ESCAPE_TEXT = /[&<>]/g;
const ESCAPE_ATTR = /[&<>"]/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text content.
 * @param {string} s
 * @returns {string}
 */
export function escapeText(s) {
  return String(s).replace(ESCAPE_TEXT, (c) => ESC_MAP[c]);
}

/**
 * Escape an attribute value.
 * @param {string} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return String(s).replace(ESCAPE_ATTR, (c) => ESC_MAP[c]);
}

/**
 * Serialize a VNode tree to HTML. Deterministic: attribute order follows object
 * key order, and no whitespace is introduced that was not in the tree.
 * @param {VNode} node
 * @returns {string}
 */
export function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node === 'string' || typeof node === 'number') return escapeText(String(node));
  if ('raw' in node) return node.raw;

  const { t, a, c } = node;
  let out = `<${t}`;
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' && v && typeof v === 'object') {
      const s = styleString(/** @type {Record<string,string>} */ (v));
      if (s) out += ` style="${escapeAttr(s)}"`;
      continue;
    }
    if (v === true) { out += ` ${k}`; continue; }
    out += ` ${k}="${escapeAttr(String(v))}"`;
  }
  out += '>';
  if (VOID_ELEMENTS.has(t)) return out;
  out += RAW_TEXT_ELEMENTS.has(t) ? flattenRawText(c) : toHtml(c);
  return `${out}</${t}>`;
}

/** @param {VNode[]} children @returns {string} */
function flattenRawText(children) {
  const parts = [];
  const walk = (n) => {
    if (n === null || n === undefined || n === false) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'object' && 'raw' in n) { parts.push(n.raw); return; }
    if (typeof n === 'object') { parts.push(toHtml(n)); return; }
    parts.push(String(n));
  };
  children.forEach(walk);
  return parts.join('');
}

/**
 * Materialize a VNode tree as DOM.
 * @param {VNode} node
 * @param {Document} doc
 * @param {boolean} [svg] whether the parent context is SVG
 * @returns {Node}
 */
export function toDom(node, doc, svg = false) {
  if (node === null || node === undefined || node === false) return doc.createTextNode('');
  if (Array.isArray(node)) {
    const frag = doc.createDocumentFragment();
    for (const child of node) frag.appendChild(toDom(child, doc, svg));
    return frag;
  }
  if (typeof node === 'string' || typeof node === 'number') return doc.createTextNode(String(node));
  if ('raw' in node) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = node.raw;
    return tpl.content.cloneNode(true);
  }
  const isSvg = svg || SVG_TAGS.has(node.t);
  const el = isSvg ? doc.createElementNS(SVG_NS, node.t) : doc.createElement(node.t);
  for (const [k, v] of Object.entries(node.a)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' && v && typeof v === 'object') {
      el.setAttribute('style', styleString(/** @type {Record<string,string>} */ (v)));
      continue;
    }
    if (v === true) { el.setAttribute(k, ''); continue; }
    el.setAttribute(k, String(v));
  }
  if (!VOID_ELEMENTS.has(node.t)) {
    for (const child of node.c) el.appendChild(toDom(child, doc, isSvg));
  }
  return el;
}

/**
 * Replace the contents of a DOM element with a rendered tree.
 * @param {Element} root
 * @param {VNode} node
 */
export function mount(root, node) {
  const doc = root.ownerDocument;
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(toDom(node, doc));
}

/**
 * Depth-first walk over element nodes.
 * @param {VNode} node
 * @param {(el: VElement, path: number[]) => void|false} visit  return false to skip children
 * @param {number[]} [path]
 */
export function walk(node, visit, path = []) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) { node.forEach((c, i) => walk(c, visit, path.concat(i))); return; }
  if (typeof node !== 'object' || 'raw' in node) return;
  if (visit(node, path) === false) return;
  node.c.forEach((c, i) => walk(c, visit, path.concat(i)));
}

/**
 * Collect the concatenated visible text of a tree.
 * @param {VNode} node
 * @returns {string}
 */
export function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if ('raw' in node) return node.raw.replace(/<[^>]*>/g, '');
  return textOf(node.c);
}

/**
 * Find the first element carrying an attribute value.
 * @param {VNode} node
 * @param {string} attr
 * @param {string} value
 * @returns {VElement|null}
 */
export function findByAttr(node, attr, value) {
  /** @type {VElement|null} */
  let found = null;
  walk(node, (el) => {
    if (found) return false;
    if (el.a[attr] === value) { found = el; return false; }
    return undefined;
  });
  return found;
}

/**
 * Every element carrying an attribute, in document order.
 * @param {VNode} node
 * @param {string} attr
 * @returns {VElement[]}
 */
export function collectByAttr(node, attr) {
  /** @type {VElement[]} */
  const out = [];
  walk(node, (el) => { if (el.a[attr] !== undefined) out.push(el); return undefined; });
  return out;
}
