/**
 * A CSS selector engine over `DocNode` trees (D8).
 *
 * L6 strips chrome by structural signal — landmark roles, link density, classes
 * that name a region. Every one of those signals is a selector query, so the
 * parser ships with just enough of a selector language to express them without
 * anybody writing a bespoke tree walk per rule.
 *
 * Supported: `tag`, `.class`, `#id`, `*`, `[attr]`, `[attr=v]`, `[attr*=v]`,
 * `[attr^=v]`, `[attr$=v]`, `[attr~=v]`, `[attr|=v]`, `[attr=v i]`, `:not(...)`,
 * `:first-child`, `:last-child`, `:only-child`, `:empty`, `:root`, descendant,
 * `>`, `+`, `~`, and comma groups.
 *
 * Deliberately not supported, because nothing in this product needs them and a
 * half-working implementation is worse than an honest refusal: `:nth-child()`
 * expressions with `an+b`, pseudo-elements, namespaces, `:has()`.
 *
 * @module ingest/select
 */

import { walk, attr, classList } from './html-parse.js';

/**
 * @typedef {import('./html-parse.js').DocNode} DocNode
 */

/**
 * @typedef {object} SimpleSelector
 * @property {string|null} tag
 * @property {string|null} id
 * @property {string[]} classes
 * @property {{name: string, op: string|null, value: string|null, insensitive: boolean}[]} attrs
 * @property {{name: string, argument: Compound[]|null}[]} pseudos
 */

/**
 * @typedef {{combinator: ' '|'>'|'+'|'~'|null, simple: SimpleSelector}} Compound
 */

/** Thrown for selector syntax this engine will not guess at. */
export class SelectorError extends Error {}

const IDENT = /[-\w\u00a0-\uffff\\]/;

/**
 * Parse a selector list into complex selectors.
 * @param {string} selector
 * @returns {Compound[][]}
 */
export function parseSelector(selector) {
  const src = String(selector == null ? '' : selector);
  /** @type {Compound[][]} */
  const groups = [];
  /** @type {Compound[]} */
  let current = [];
  /** @type {' '|'>'|'+'|'~'|null} */
  let pendingCombinator = null;
  let i = 0;

  const pushSimple = (simple) => {
    current.push({ combinator: current.length === 0 ? null : (pendingCombinator || ' '), simple });
    pendingCombinator = null;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      if (current.length) pendingCombinator = pendingCombinator || ' ';
      i += 1;
      continue;
    }
    if (c === '>' || c === '+' || c === '~') {
      if (!current.length) throw new SelectorError(`selector "${src}": combinator "${c}" with nothing before it`);
      pendingCombinator = /** @type {'>'|'+'|'~'} */ (c);
      i += 1;
      continue;
    }
    if (c === ',') {
      if (current.length) groups.push(current);
      current = [];
      pendingCombinator = null;
      i += 1;
      continue;
    }
    const parsed = parseSimple(src, i);
    pushSimple(parsed.simple);
    i = parsed.next;
  }
  if (current.length) groups.push(current);
  if (!groups.length) throw new SelectorError(`selector "${src}": empty`);
  return groups;
}

/**
 * Parse one compound selector (`div.a#b[c=d]:not(.e)`).
 * @param {string} src
 * @param {number} from
 * @returns {{simple: SimpleSelector, next: number}}
 */
function parseSimple(src, from) {
  /** @type {SimpleSelector} */
  const simple = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = from;
  let consumed = false;

  const readIdent = () => {
    const start = i;
    while (i < src.length && IDENT.test(src[i])) i += 1;
    return src.slice(start, i);
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '*') { simple.tag = null; i += 1; consumed = true; continue; }
    if (c === '.') {
      i += 1;
      const name = readIdent();
      if (!name) throw new SelectorError(`selector "${src}": empty class name at ${i}`);
      simple.classes.push(name);
      consumed = true;
      continue;
    }
    if (c === '#') {
      i += 1;
      const name = readIdent();
      if (!name) throw new SelectorError(`selector "${src}": empty id at ${i}`);
      simple.id = name;
      consumed = true;
      continue;
    }
    if (c === '[') {
      const close = findAttributeEnd(src, i);
      if (close < 0) throw new SelectorError(`selector "${src}": unterminated attribute selector`);
      simple.attrs.push(parseAttributeSelector(src.slice(i + 1, close), src));
      i = close + 1;
      consumed = true;
      continue;
    }
    if (c === ':') {
      i += 1;
      if (src[i] === ':') throw new SelectorError(`selector "${src}": pseudo-elements are not supported`);
      const name = readIdent().toLowerCase();
      /** @type {Compound[][]|null} */
      let argument = null;
      if (src[i] === '(') {
        const close = matchParen(src, i);
        if (close < 0) throw new SelectorError(`selector "${src}": unterminated "(" after :${name}`);
        argument = parseSelector(src.slice(i + 1, close));
        i = close + 1;
      }
      if (!SUPPORTED_PSEUDOS.has(name)) {
        throw new SelectorError(`selector "${src}": ":${name}" is not supported by this engine`);
      }
      simple.pseudos.push({ name, argument: argument ? argument.map((g) => g) : null });
      consumed = true;
      continue;
    }
    if (IDENT.test(c)) {
      if (consumed && (simple.tag || simple.classes.length || simple.id || simple.attrs.length || simple.pseudos.length)) break;
      simple.tag = readIdent().toLowerCase();
      consumed = true;
      continue;
    }
    break;
  }
  if (!consumed) throw new SelectorError(`selector "${src}": unexpected "${src[i]}" at ${i}`);
  return { simple, next: i };
}

const SUPPORTED_PSEUDOS = new Set(['not', 'first-child', 'last-child', 'only-child', 'empty', 'root', 'is', 'where']);

/**
 * @param {string} src @param {number} from @returns {number}
 */
function findAttributeEnd(src, from) {
  let i = from + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === ']') return i;
    i += 1;
  }
  return -1;
}

/**
 * @param {string} src @param {number} from @returns {number}
 */
function matchParen(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * @param {string} body  the text between `[` and `]`
 * @param {string} src   the whole selector, for error messages
 * @returns {{name: string, op: string|null, value: string|null, insensitive: boolean}}
 */
function parseAttributeSelector(body, src) {
  const m = body.match(/^\s*([-\w:.]+)\s*(?:([~^$*|]?=)\s*(.*?)\s*)?$/);
  if (!m) throw new SelectorError(`selector "${src}": cannot parse attribute selector "[${body}]"`);
  const name = m[1].toLowerCase();
  const op = m[2] || null;
  let rest = m[3];
  let insensitive = false;
  if (rest !== undefined && rest !== null) {
    const flag = rest.match(/\s+([iIsS])$/);
    if (flag) { insensitive = flag[1].toLowerCase() === 'i'; rest = rest.slice(0, flag.index); }
    rest = rest.trim();
    if ((rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2)
      || (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2)) {
      rest = rest.slice(1, -1);
    }
  }
  return { name, op, value: op ? (rest === undefined ? '' : rest) : null, insensitive };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * @param {DocNode} node
 * @param {SimpleSelector} simple
 * @returns {boolean}
 */
function matchesSimple(node, simple) {
  if (node.type !== 'element') return false;
  const tag = String(node.tag || '');
  if (tag.startsWith('#')) return false;   // #document / #fragment are not elements a selector can name
  if (simple.tag !== null && tag.toLowerCase() !== simple.tag) return false;
  if (simple.id !== null && attr(node, 'id') !== simple.id) return false;
  if (simple.classes.length) {
    const classes = classList(node);
    for (const want of simple.classes) if (!classes.includes(want)) return false;
  }
  for (const a of simple.attrs) {
    const value = attr(node, a.name);
    if (value === null) return false;
    if (a.op === null) continue;
    const have = a.insensitive ? value.toLowerCase() : value;
    const want = a.insensitive ? String(a.value).toLowerCase() : String(a.value);
    switch (a.op) {
      case '=': if (have !== want) return false; break;
      case '*=': if (want === '' || !have.includes(want)) return false; break;
      case '^=': if (want === '' || !have.startsWith(want)) return false; break;
      case '$=': if (want === '' || !have.endsWith(want)) return false; break;
      case '~=': if (want === '' || /\s/.test(want) || !have.split(/\s+/).includes(want)) return false; break;
      case '|=': if (have !== want && !have.startsWith(`${want}-`)) return false; break;
      default: return false;
    }
  }
  for (const pseudo of simple.pseudos) {
    if (!matchesPseudo(node, pseudo)) return false;
  }
  return true;
}

/**
 * @param {DocNode} node
 * @param {{name: string, argument: any}} pseudo
 * @returns {boolean}
 */
function matchesPseudo(node, pseudo) {
  switch (pseudo.name) {
    case 'not':
      if (!pseudo.argument) return true;
      return !pseudo.argument.some((group) => matchesComplex(node, group));
    case 'is':
    case 'where':
      if (!pseudo.argument) return false;
      return pseudo.argument.some((group) => matchesComplex(node, group));
    case 'first-child': return siblingElements(node).indexOf(node) === 0;
    case 'last-child': {
      const sibs = siblingElements(node);
      return sibs.length > 0 && sibs[sibs.length - 1] === node;
    }
    case 'only-child': return siblingElements(node).length === 1;
    case 'empty': return !(node.children || []).some((c) => c.type === 'element' || (c.type === 'text' && /\S/.test(c.text || '')));
    case 'root': return !node.parent || String(node.parent.tag || '').startsWith('#');
    default: return false;
  }
}

/**
 * @param {DocNode} node
 * @returns {DocNode[]}
 */
function siblingElements(node) {
  const parent = node.parent;
  if (!parent || !parent.children) return [node];
  return parent.children.filter((c) => c.type === 'element');
}

/**
 * Right-to-left evaluation of a complex selector against one node.
 * @param {DocNode} node
 * @param {Compound[]} parts
 * @returns {boolean}
 */
export function matchesComplex(node, parts) {
  if (!parts.length) return false;
  const last = parts[parts.length - 1];
  if (!matchesSimple(node, last.simple)) return false;
  return matchesFrom(node, parts, parts.length - 1);
}

/**
 * @param {DocNode} node
 * @param {Compound[]} parts
 * @param {number} index  the part `node` already satisfies
 * @returns {boolean}
 */
function matchesFrom(node, parts, index) {
  if (index === 0) return true;
  const combinator = parts[index].combinator;
  const next = parts[index - 1];
  if (combinator === '>') {
    const parent = node.parent;
    if (!parent || parent.type !== 'element') return false;
    return matchesSimple(parent, next.simple) && matchesFrom(parent, parts, index - 1);
  }
  if (combinator === '+') {
    const prev = previousElementSibling(node);
    if (!prev) return false;
    return matchesSimple(prev, next.simple) && matchesFrom(prev, parts, index - 1);
  }
  if (combinator === '~') {
    let prev = previousElementSibling(node);
    while (prev) {
      if (matchesSimple(prev, next.simple) && matchesFrom(prev, parts, index - 1)) return true;
      prev = previousElementSibling(prev);
    }
    return false;
  }
  // Descendant.
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.type === 'element' && matchesSimple(ancestor, next.simple) && matchesFrom(ancestor, parts, index - 1)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

/**
 * @param {DocNode} node
 * @returns {DocNode|null}
 */
function previousElementSibling(node) {
  const parent = node.parent;
  if (!parent || !parent.children) return null;
  const sibs = parent.children;
  const at = sibs.indexOf(node);
  for (let i = at - 1; i >= 0; i--) if (sibs[i].type === 'element') return sibs[i];
  return null;
}

/**
 * True when `node` matches the selector.
 * @param {DocNode} node
 * @param {string|Compound[][]} selector
 * @returns {boolean}
 */
export function matches(node, selector) {
  const groups = typeof selector === 'string' ? parseSelector(selector) : selector;
  return groups.some((group) => matchesComplex(node, group));
}

/**
 * Every descendant element of `root` matching the selector, in document order,
 * de-duplicated across comma groups.
 * @param {DocNode} root
 * @param {string} selector
 * @returns {DocNode[]}
 */
export function querySelectorAll(root, selector) {
  const groups = parseSelector(selector);
  /** @type {DocNode[]} */
  const out = [];
  if (!root) return out;
  walk(root, (node) => {
    if (node === root || node.type !== 'element') return undefined;
    if (groups.some((group) => matchesComplex(node, group))) out.push(node);
    return undefined;
  });
  return out;
}

/**
 * The first match, or null.
 * @param {DocNode} root
 * @param {string} selector
 * @returns {DocNode|null}
 */
export function querySelector(root, selector) {
  const groups = parseSelector(selector);
  /** @type {DocNode|null} */
  let found = null;
  if (!root) return null;
  walk(root, (node) => {
    if (node === root || node.type !== 'element') return undefined;
    if (groups.some((group) => matchesComplex(node, group))) { found = node; return 'stop'; }
    return undefined;
  });
  return found;
}

/**
 * The nearest ancestor-or-self matching the selector.
 * @param {DocNode} node
 * @param {string} selector
 * @returns {DocNode|null}
 */
export function closest(node, selector) {
  const groups = parseSelector(selector);
  /** @type {DocNode|null|undefined} */
  let cur = node;
  while (cur) {
    if (cur.type === 'element' && groups.some((group) => matchesComplex(cur, group))) return cur;
    cur = cur.parent;
  }
  return null;
}
