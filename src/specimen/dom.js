/**
 * Tree helpers over the `DocNode` shape produced by L3's parser (API.md Part 3,
 * D8). This module contains **no HTML parsing** — it only walks, measures and
 * clones a tree that was already parsed. Parsing belongs to `src/ingest`.
 *
 * `DocNode` = { type: 'element'|'text'|'comment', tag?, attrs?, children?, text?, parent? }
 *
 * Everything here is pure apart from `detach`/`reattach`, which are the two
 * mutating operations chrome stripping needs and which are exact inverses of
 * each other — that is what makes §8's "stripping is reversible" true at the
 * tree level as well as at the block level.
 */

/** Elements that never contribute rendered text. */
export const NON_RENDERED = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
  'base', 'param', 'source', 'track', 'object', 'embed', 'canvas',
]);

/** Elements that force a text break when flattening a subtree to a string. */
export const BLOCK_LEVEL = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Inline elements that are pure presentation and get unwrapped by `toBlocks`. */
export const PRESENTATIONAL = new Set([
  'span', 'font', 'b', 'i', 'u', 's', 'strike', 'em', 'strong', 'small',
  'mark', 'abbr', 'acronym', 'cite', 'dfn', 'kbd', 'samp', 'var', 'sub',
  'sup', 'time', 'data', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'wbr', 'ins', 'del',
  'label', 'output', 'nobr', 'big', 'tt',
]);

/** @param {any} n @returns {boolean} */
export function isElement(n) { return Boolean(n) && n.type === 'element'; }

/** @param {any} n @returns {boolean} */
export function isText(n) { return Boolean(n) && n.type === 'text'; }

/** @param {any} n @returns {string} lowercased tag name, '' for non-elements */
export function tagOf(n) { return isElement(n) && typeof n.tag === 'string' ? n.tag.toLowerCase() : ''; }

/** @param {any} n @returns {import('../core/contracts.d.ts')['ContentBlock'] extends never ? never : any[]} */
export function childrenOf(n) { return (n && Array.isArray(n.children)) ? n.children : []; }

/**
 * Attribute lookup that does not care about attribute-name casing, because
 * saved pages, HAR bodies and hand-written markup disagree about it.
 * @param {any} n
 * @param {string} name
 * @returns {string|null}
 */
export function attrOf(n, name) {
  if (!isElement(n) || !n.attrs) return null;
  const want = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(n.attrs, want)) {
    const v = n.attrs[want];
    return v === undefined || v === null ? '' : String(v);
  }
  for (const k of Object.keys(n.attrs)) {
    if (k.toLowerCase() === want) {
      const v = n.attrs[k];
      return v === undefined || v === null ? '' : String(v);
    }
  }
  return null;
}

/**
 * Pre-order walk. `visit` returning `false` prunes the subtree.
 * @param {any} node
 * @param {(n: any, depth: number) => boolean|void} visit
 * @param {number} [depth]
 */
export function walk(node, visit, depth = 0) {
  if (!node) return;
  if (visit(node, depth) === false) return;
  for (const child of childrenOf(node).slice()) walk(child, visit, depth + 1);
}

/**
 * Every element in the subtree, document order, root included when it is one.
 * @param {any} node
 * @returns {any[]}
 */
export function elements(node) {
  /** @type {any[]} */
  const out = [];
  walk(node, (n) => { if (isElement(n)) out.push(n); });
  return out;
}

/**
 * First element in document order matching `pred`.
 * @param {any} node
 * @param {(n: any) => boolean} pred
 * @returns {any|null}
 */
export function firstElement(node, pred) {
  /** @type {any|null} */
  let found = null;
  walk(node, (n) => {
    if (found) return false;
    if (isElement(n) && pred(n)) { found = n; return false; }
    return true;
  });
  return found;
}

/**
 * All elements matching a tag name (or a set of tag names).
 * @param {any} node
 * @param {string|string[]|Set<string>} tags
 * @returns {any[]}
 */
export function byTag(node, tags) {
  const want = tags instanceof Set ? tags : new Set(Array.isArray(tags) ? tags : [tags]);
  return elements(node).filter((n) => want.has(tagOf(n)));
}

/**
 * Ancestor chain, nearest first. Requires `parent` links; a tree produced by
 * `cloneTree` always has them.
 * @param {any} node
 * @returns {any[]}
 */
export function ancestors(node) {
  /** @type {any[]} */
  const out = [];
  let cur = node && node.parent;
  while (cur) { out.push(cur); cur = cur.parent; }
  return out;
}

/**
 * Nearest ancestor (or self) satisfying `pred`.
 * @param {any} node
 * @param {(n: any) => boolean} pred
 * @returns {any|null}
 */
export function closest(node, pred) {
  let cur = node;
  while (cur) { if (isElement(cur) && pred(cur)) return cur; cur = cur.parent; }
  return null;
}

/**
 * @param {any} node
 * @param {any} maybeAncestor
 * @returns {boolean}
 */
export function contains(maybeAncestor, node) {
  let cur = node;
  while (cur) { if (cur === maybeAncestor) return true; cur = cur.parent; }
  return false;
}

/**
 * Collapse runs of whitespace, normalise non-breaking and zero-width spaces,
 * and trim. Every text comparison in this lane goes through it so that two
 * captures of the same words compare equal.
 * @param {string} s
 * @returns {string}
 */
export function normalizeSpace(s) {
  return String(s == null ? '' : s)
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rendered text of a subtree. Block-level elements insert a break so that
 * `<div>a</div><div>b</div>` reads "a b" rather than "ab", and non-rendered
 * elements contribute nothing.
 * @param {any} node
 * @returns {string}
 */
export function rawText(node) {
  /** @type {string[]} */
  const parts = [];
  const rec = (n) => {
    if (!n) return;
    if (n.type === 'comment') return;
    if (isText(n)) { parts.push(String(n.text ?? '')); return; }
    if (!isElement(n)) return;
    const tag = tagOf(n);
    if (NON_RENDERED.has(tag)) return;
    const block = BLOCK_LEVEL.has(tag);
    if (block) parts.push('\n');
    for (const c of childrenOf(n)) rec(c);
    if (block) parts.push('\n');
  };
  rec(node);
  return parts.join('');
}

/**
 * Normalised rendered text of a subtree.
 * @param {any} node
 * @returns {string}
 */
export function textOf(node) { return normalizeSpace(rawText(node)); }

/**
 * Character counts used by the link-density signal (§8, PLAN §4.3b).
 * `linkChars` counts text inside `<a href>`; `interactiveChars` also counts
 * button and menuitem labels, which is what a mega-nav is actually made of.
 * @param {any} node
 * @returns {{textChars: number, linkChars: number, interactiveChars: number, linkCount: number, itemCount: number}}
 */
export function textStats(node) {
  const textChars = textOf(node).length;
  let linkChars = 0;
  let interactiveChars = 0;
  let linkCount = 0;
  let itemCount = 0;
  const seen = new Set();
  walk(node, (n) => {
    if (!isElement(n)) return true;
    const tag = tagOf(n);
    if (tag === 'li') itemCount += 1;
    const role = (attrOf(n, 'role') || '').toLowerCase();
    const isLink = tag === 'a' && attrOf(n, 'href') !== null;
    const isInteractive = isLink || tag === 'button' || role === 'button' || role === 'link' || role === 'menuitem';
    if (!isInteractive) return true;
    // Only count the outermost interactive element so nested markup is not
    // double counted.
    for (const a of ancestors(n)) if (seen.has(a)) return true;
    seen.add(n);
    const chars = textOf(n).length;
    interactiveChars += chars;
    if (isLink) { linkChars += chars; linkCount += 1; }
    return true;
  });
  return { textChars, linkChars, interactiveChars, linkCount, itemCount };
}

/**
 * Lowercased identity tokens of an element: tag, id, classes, role, aria-label,
 * data-testid, data-component. This is the string the boilerplate lexicon runs
 * against. Ground-truth labels used by the test corpus live on `data-pp-truth`
 * and are deliberately **not** included — the classifier must never see them.
 * @param {any} n
 * @returns {string[]}
 */
export function identityTokens(n) {
  if (!isElement(n)) return [];
  /** @type {string[]} */
  const out = [tagOf(n)];
  const push = (v) => { if (v) for (const t of String(v).toLowerCase().split(/[^a-z0-9]+/)) if (t) out.push(t); };
  push(attrOf(n, 'id'));
  push(attrOf(n, 'class'));
  push(attrOf(n, 'role'));
  push(attrOf(n, 'aria-label'));
  push(attrOf(n, 'data-testid'));
  push(attrOf(n, 'data-component'));
  push(attrOf(n, 'data-module'));
  return out;
}

/**
 * The identity string used for whole-word lexicon matching, e.g.
 * "div site-header utility-nav". Pass `{includeTag: false}` to leave the tag
 * name out — the boilerplate lexicon does, because element names are the
 * landmark signal's business and counting them twice would charge an article's
 * own `<header>` for being called header.
 * @param {any} n
 * @param {{includeTag?: boolean}} [options]
 * @returns {string}
 */
export function identityString(n, options = {}) {
  if (!isElement(n)) return '';
  const parts = options.includeTag === false ? [] : [tagOf(n)];
  for (const name of ['id', 'class', 'role', 'aria-label', 'data-testid', 'data-component', 'data-module']) {
    const v = attrOf(n, name);
    if (v) parts.push(v.toLowerCase());
  }
  return parts.join(' ');
}

/**
 * Index path from `root` to `node`, e.g. `[1, 0, 4]`. Used to re-insert a
 * stripped subtree at exactly the position it came from.
 * @param {any} root
 * @param {any} node
 * @returns {number[]|null}
 */
export function indexPath(root, node) {
  /** @type {number[]} */
  const path = [];
  let cur = node;
  while (cur && cur !== root) {
    const parent = cur.parent;
    if (!parent) return null;
    const i = childrenOf(parent).indexOf(cur);
    if (i < 0) return null;
    path.unshift(i);
    cur = parent;
  }
  return cur === root ? path : null;
}

/**
 * Human-legible structural path: `body > div.site-header > nav.primary`.
 * Recorded on every removed entry so a reviewer in the studio can see *where*
 * something was taken from, not only that it was.
 * @param {any} node
 * @param {any} [stopAt]
 * @returns {string}
 */
export function selectorPath(node, stopAt = null) {
  /** @type {string[]} */
  const parts = [];
  let cur = node;
  while (isElement(cur)) {
    let part = tagOf(cur);
    const id = attrOf(cur, 'id');
    if (id) part += `#${id.trim().split(/\s+/)[0]}`;
    else {
      const cls = (attrOf(cur, 'class') || '').trim().split(/\s+/).filter(Boolean)[0];
      if (cls) part += `.${cls}`;
    }
    parts.unshift(part);
    if (cur === stopAt) break;
    cur = cur.parent;
  }
  return parts.join(' > ');
}

/**
 * Deep clone with fresh `parent` links. Chrome stripping always works on a
 * clone so the caller's document is never mutated — that is what lets a test
 * assert a restored specimen equals the never-stripped one.
 * @param {any} node
 * @param {any} [parent]
 * @returns {any}
 */
export function cloneTree(node, parent = null) {
  /** @type {any} */
  const copy = { type: node.type };
  if (node.tag !== undefined) copy.tag = node.tag;
  if (node.attrs) copy.attrs = { ...node.attrs };
  if (node.text !== undefined) copy.text = node.text;
  if (parent) copy.parent = parent;
  if (Array.isArray(node.children)) copy.children = node.children.map((c) => cloneTree(c, copy));
  return copy;
}

/**
 * Remove a node from its parent, remembering where it was.
 * @param {any} node
 * @returns {{parent: any, index: number}|null}
 */
export function detach(node) {
  const parent = node && node.parent;
  if (!parent || !Array.isArray(parent.children)) return null;
  const index = parent.children.indexOf(node);
  if (index < 0) return null;
  parent.children.splice(index, 1);
  return { parent, index };
}

/**
 * Exact inverse of `detach`.
 * @param {any} node
 * @param {{parent: any, index: number}} where
 */
export function reattach(node, where) {
  if (!where || !where.parent) return;
  const kids = Array.isArray(where.parent.children) ? where.parent.children : (where.parent.children = []);
  kids.splice(Math.min(where.index, kids.length), 0, node);
  node.parent = where.parent;
}

/**
 * The `<body>` of a parsed document, or the node itself when the capture is a
 * fragment (pasted HTML frequently is).
 * @param {any} doc
 * @returns {any}
 */
export function bodyOf(doc) {
  if (!doc) return doc;
  if (tagOf(doc) === 'body') return doc;
  const body = firstElement(doc, (n) => tagOf(n) === 'body');
  return body || doc;
}

/**
 * The `<head>` of a parsed document, or null.
 * @param {any} doc
 * @returns {any|null}
 */
export function headOf(doc) {
  if (!doc) return null;
  if (tagOf(doc) === 'head') return doc;
  return firstElement(doc, (n) => tagOf(n) === 'head');
}

/**
 * Ensure every node in a tree has a correct `parent` link. Parsers are allowed
 * by the `DocNode` shape to omit them (`parent?`), and every traversal in this
 * lane needs them.
 * @param {any} node
 * @param {any} [parent]
 * @returns {any} the same node
 */
export function linkParents(node, parent = null) {
  if (!node) return node;
  if (parent) node.parent = parent;
  for (const c of childrenOf(node)) linkParents(c, node);
  return node;
}
