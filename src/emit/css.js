/**
 * A CSS parser and a small cascade evaluator.
 *
 * §18.1 and §22.6 require the provenance label to survive the **final**
 * stylesheet — the runtime sheet, the compiled brand theme, and any CSS the
 * user added — with a computed contrast of at least 4.5:1 and a computed font
 * size of at least 11px, and with no rule anywhere that renders it invisible.
 * "Computed" is the load-bearing word: checking the markup is not enough,
 * because every interesting attack on the label is a stylesheet, not a missing
 * element.
 *
 * The evaluator is honest about its scope. It resolves the cascade for a known
 * element path — selectors, specificity, `!important`, inline `style`, custom
 * properties and `var()`, inheritance of the properties that matter — and it
 * does not lay anything out. Its limits are enumerated in
 * `docs/decisions/L10-emit.md` and each one is stated in the direction that
 * fails safe: where it cannot decide, it treats the rule as applying.
 *
 * @module emit/css
 */

import { maskCss } from './scan-parse.js';

/**
 * @typedef {object} Declaration
 * @property {string} prop
 * @property {string} value
 * @property {boolean} important
 */

/**
 * @typedef {object} StyleRule
 * @property {string} selectorText
 * @property {SelectorPart[]} selector    right-to-left compounds with combinators
 * @property {[number, number, number]} specificity
 * @property {Declaration[]} declarations
 * @property {number} order               source order, later wins ties
 * @property {string[]} conditions        enclosing at-rule preludes, outermost first
 * @property {number} index               source offset of the selector
 */

/**
 * @typedef {object} SelectorPart
 * @property {string} combinator   ' ' | '>' | '+' | '~' | '' for the first compound
 * @property {string|null} tag
 * @property {string|null} id
 * @property {string[]} classes
 * @property {{name: string, op: string|null, value: string|null}[]} attrs
 * @property {string[]} pseudos
 * @property {SelectorPart[][]} nots
 * @property {boolean} universal
 * @property {boolean} pseudoElement
 * @property {boolean} dynamic     carries a state pseudo-class (:hover, :focus…)
 */

/** At-rule preludes whose contents never apply to a screen presentation. */
const NON_SCREEN_MEDIA = /^\s*(print|speech|aural|braille|embossed|tty|tv|projection|handheld)\s*$/i;

/** Pseudo-classes that depend on user interaction rather than the document. */
const DYNAMIC_PSEUDOS = new Set([
  'hover', 'active', 'focus', 'focus-within', 'focus-visible', 'visited', 'target',
  'checked', 'indeterminate', 'placeholder-shown', 'autofill', 'default', 'user-invalid', 'user-valid',
]);

/**
 * Parse a stylesheet into flat style rules, carrying their at-rule context.
 *
 * Nested at-rules (`@media`, `@supports`, `@layer`, `@container`) are flattened
 * and their preludes recorded, so a rule that hides the label inside a media
 * query is still visible to the checker and its locus still names the query.
 *
 * @param {string} css
 * @returns {{rules: StyleRule[], atRules: {name: string, prelude: string, index: number}[]}}
 */
export function parseStylesheet(css) {
  const src = String(css);
  const masked = maskCss(src).code;
  /** @type {StyleRule[]} */
  const rules = [];
  /** @type {{name: string, prelude: string, index: number}[]} */
  const atRules = [];
  let order = 0;

  /**
   * @param {number} from
   * @param {number} to
   * @param {string[]} conditions
   */
  const parseBlock = (from, to, conditions) => {
    let i = from;
    while (i < to) {
      // Skip whitespace and stray semicolons.
      while (i < to && /[\s;]/.test(masked[i])) i++;
      if (i >= to) break;

      if (masked[i] === '@') {
        const preludeEnd = findAny(masked, i, to, '{;');
        const name = /^@([\w-]+)/.exec(masked.slice(i, preludeEnd))?.[1] || '';
        const prelude = src.slice(i + 1 + name.length, preludeEnd).trim();
        atRules.push({ name: name.toLowerCase(), prelude, index: i });
        if (preludeEnd >= to || masked[preludeEnd] === ';') { i = preludeEnd + 1; continue; }
        const close = matchBrace(masked, preludeEnd, to);
        const lower = name.toLowerCase();
        if (lower === 'media' || lower === 'supports' || lower === 'layer' || lower === 'container' || lower === 'scope') {
          parseBlock(preludeEnd + 1, close, conditions.concat(`@${lower} ${prelude}`.trim()));
        } else if (lower === 'font-face' || lower === 'keyframes' || lower === 'page' || lower === 'property' || lower === 'counter-style') {
          // Declaration-only at-rules: the scanner reads them, the cascade does not.
        }
        i = close + 1;
        continue;
      }

      const braceAt = masked.indexOf('{', i);
      if (braceAt < 0 || braceAt >= to) break;
      const close = matchBrace(masked, braceAt, to);
      const selectorText = src.slice(i, braceAt).trim();
      const body = src.slice(braceAt + 1, close);
      const declarations = parseDeclarations(body);
      for (const sel of splitSelectorList(selectorText)) {
        if (!sel.trim()) continue;
        const selector = parseSelector(sel);
        rules.push({
          selectorText: sel.trim(),
          selector,
          specificity: specificityOf(selector),
          declarations,
          order: order++,
          conditions,
          index: i,
        });
      }
      i = close + 1;
    }
  };

  parseBlock(0, masked.length, []);
  return { rules, atRules };
}

/** @param {string} s @param {number} from @param {number} to @param {string} chars @returns {number} */
function findAny(s, from, to, chars) {
  for (let i = from; i < to; i++) if (chars.includes(s[i])) return i;
  return to;
}

/** @param {string} s @param {number} openAt @param {number} to @returns {number} index of the matching `}` */
function matchBrace(s, openAt, to) {
  let depth = 0;
  for (let i = openAt; i < to; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return to;
}

/**
 * Split a selector list on top-level commas.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSelectorList(text) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (const ch of String(text)) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a declaration block.
 * @param {string} body
 * @returns {Declaration[]}
 */
export function parseDeclarations(body) {
  const src = String(body);
  const masked = maskCss(src).code;
  /** @type {Declaration[]} */
  const out = [];
  let i = 0;
  while (i < masked.length) {
    // Skip nested blocks (a nested rule inside a declaration block).
    const semi = masked.indexOf(';', i);
    const brace = masked.indexOf('{', i);
    if (brace >= 0 && (semi < 0 || brace < semi)) {
      const close = matchBrace(masked, brace, masked.length);
      i = close + 1;
      continue;
    }
    const end = semi < 0 ? masked.length : semi;
    const chunk = src.slice(i, end);
    const colon = masked.slice(i, end).indexOf(':');
    if (colon > 0) {
      const prop = chunk.slice(0, colon).trim();
      let value = chunk.slice(colon + 1).trim();
      let important = false;
      const bang = /\s*!\s*important\s*$/i.exec(value);
      if (bang) { important = true; value = value.slice(0, bang.index).trim(); }
      if (prop) out.push({ prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value, important });
    }
    i = end + 1;
  }
  return out;
}

/**
 * Parse one complex selector into its compounds, in source order.
 * @param {string} text
 * @returns {SelectorPart[]}
 */
export function parseSelector(text) {
  const s = String(text).trim();
  /** @type {SelectorPart[]} */
  const parts = [];
  let combinator = '';
  let i = 0;

  const blank = () => ({
    combinator, tag: null, id: null, classes: [], attrs: [], pseudos: [],
    nots: [], universal: false, pseudoElement: false, dynamic: false,
  });
  /** @type {SelectorPart|null} */
  let cur = null;

  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = s[j];
      if (next === '>' || next === '+' || next === '~') { i = j; continue; }
      if (j >= s.length) break;
      if (cur) { parts.push(cur); cur = null; combinator = ' '; }
      i = j;
      continue;
    }
    if (ch === '>' || ch === '+' || ch === '~') {
      if (cur) { parts.push(cur); cur = null; }
      combinator = ch;
      i++;
      continue;
    }
    if (!cur) cur = blank();
    if (ch === '*') { cur.universal = true; i++; continue; }
    if (ch === '#') {
      const m = /^#([\w-]+)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      cur.id = m[1]; i += m[0].length; continue;
    }
    if (ch === '.') {
      const m = /^\.([\w-]+)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      cur.classes.push(m[1]); i += m[0].length; continue;
    }
    if (ch === '[') {
      const close = s.indexOf(']', i);
      const inner = s.slice(i + 1, close < 0 ? s.length : close);
      const m = /^\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(.+?)\s*)?$/.exec(inner);
      if (m) {
        let value = m[3] ?? null;
        if (value && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
        if (value) value = value.replace(/\s+[iIsS]$/, '');
        cur.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value });
      }
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (ch === ':') {
      const isElement = s[i + 1] === ':';
      const m = /^::?([\w-]+)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      const name = m[1].toLowerCase();
      let advance = m[0].length;
      if (s[i + advance] === '(') {
        let depth = 0;
        let j = i + advance;
        for (; j < s.length; j++) {
          if (s[j] === '(') depth++;
          else if (s[j] === ')') { depth--; if (depth === 0) { j++; break; } }
        }
        const inner = s.slice(i + advance + 1, j - 1);
        if (name === 'not' || name === 'is' || name === 'where' || name === 'matches') {
          const branches = splitSelectorList(inner).map((b) => parseSelector(b));
          if (name === 'not') cur.nots.push(...branches);
          // :is()/:where() are treated as matching, which is the fail-safe
          // direction for a checker looking for rules that hide the label.
        }
        advance = j - i;
      }
      if (isElement || name === 'before' || name === 'after' || name === 'marker' || name === 'placeholder' || name === 'selection' || name === 'backdrop' || name === 'first-line' || name === 'first-letter') {
        cur.pseudoElement = true;
      }
      if (DYNAMIC_PSEUDOS.has(name)) cur.dynamic = true;
      cur.pseudos.push(name);
      i += advance;
      continue;
    }
    const m = /^[\w-]+/.exec(s.slice(i));
    if (m) { cur.tag = m[0].toLowerCase(); i += m[0].length; continue; }
    i++;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * CSS specificity, (ids, classes/attributes/pseudo-classes, types/pseudo-elements).
 * @param {SelectorPart[]} selector
 * @returns {[number, number, number]}
 */
export function specificityOf(selector) {
  let a = 0, b = 0, c = 0;
  for (const part of selector) {
    if (part.id) a++;
    b += part.classes.length + part.attrs.length;
    for (const p of part.pseudos) {
      if (p === 'before' || p === 'after' || p === 'first-line' || p === 'first-letter' || p === 'marker' || p === 'selection' || p === 'backdrop' || p === 'placeholder') c++;
      else if (p !== 'not' && p !== 'is' && p !== 'where') b++;
    }
    for (const notBranch of part.nots) {
      const [na, nb, nc] = specificityOf(notBranch);
      a += na; b += nb; c += nc;
    }
    if (part.tag) c++;
  }
  return [a, b, c];
}

/**
 * @typedef {object} ElementDesc
 * @property {string} tag
 * @property {string|null} id
 * @property {string[]} classes
 * @property {Record<string, string>} attrs
 * @property {string} inlineStyle
 * @property {number} childIndex   position among siblings, for `+` and `~`
 * @property {ElementDesc[]} siblingsBefore
 */

/**
 * Does a compound selector match one element?
 * @param {SelectorPart} part
 * @param {ElementDesc} el
 * @returns {boolean}
 */
export function matchesCompound(part, el) {
  if (part.pseudoElement) return false;
  if (part.tag && part.tag !== el.tag) return false;
  if (part.id && part.id !== el.id) return false;
  for (const cls of part.classes) if (!el.classes.includes(cls)) return false;
  for (const att of part.attrs) {
    const have = el.attrs[att.name];
    if (have === undefined) return false;
    if (att.op === null) continue;
    const want = att.value ?? '';
    if (att.op === '=' && have !== want) return false;
    if (att.op === '~=' && !have.split(/\s+/).includes(want)) return false;
    if (att.op === '^=' && !have.startsWith(want)) return false;
    if (att.op === '$=' && !have.endsWith(want)) return false;
    if (att.op === '*=' && !have.includes(want)) return false;
    if (att.op === '|=' && !(have === want || have.startsWith(`${want}-`))) return false;
  }
  for (const p of part.pseudos) {
    if (p === 'root' && !(el.tag === 'html' || el.attrs['data-pp-root'] === 'true')) return false;
    if (p === 'first-child' && el.childIndex !== 0) return false;
    if (p === 'empty' && el.attrs['data-pp-empty'] !== 'true') return false;
  }
  for (const notBranch of part.nots) {
    if (matchesSelector(notBranch, [el], 0)) return false;
  }
  return true;
}

/**
 * Does a complex selector match `chain[index]`, where `chain` runs root → element?
 * @param {SelectorPart[]} selector
 * @param {ElementDesc[]} chain
 * @param {number} index
 * @returns {boolean}
 */
export function matchesSelector(selector, chain, index) {
  if (selector.length === 0) return false;
  const last = selector[selector.length - 1];
  if (!matchesCompound(last, chain[index])) return false;

  /**
   * @param {number} si  index into the selector, walking leftwards
   * @param {number} ei  index into the chain
   * @returns {boolean}
   */
  const walk = (si, ei) => {
    if (si < 0) return true;
    const part = selector[si];
    const combinator = selector[si + 1].combinator;
    if (combinator === '>') {
      if (ei - 1 < 0) return false;
      return matchesCompound(part, chain[ei - 1]) && walk(si - 1, ei - 1);
    }
    if (combinator === '+' || combinator === '~') {
      const siblings = chain[ei].siblingsBefore || [];
      const candidates = combinator === '+' ? siblings.slice(-1) : siblings;
      for (const sib of candidates) {
        if (matchesCompound(part, sib)) return si - 1 < 0 ? true : walk(si - 1, ei);
      }
      return false;
    }
    for (let k = ei - 1; k >= 0; k--) {
      if (matchesCompound(part, chain[k]) && walk(si - 1, k)) return true;
    }
    return false;
  };

  return walk(selector.length - 2, index);
}

/** Properties the cascade evaluator inherits. */
export const INHERITED_PROPS = new Set([
  'color', 'font-size', 'font-family', 'font-weight', 'font', 'visibility',
  'text-indent', 'line-height', 'letter-spacing', 'text-transform', 'white-space',
]);

/** Everything the provenance checker reads. Anything else is ignored on purpose. */
export const TRACKED_PROPS = [
  'display', 'visibility', 'opacity', 'color', 'background-color', 'background',
  'font-size', 'font', 'font-family', 'position', 'left', 'top', 'right', 'bottom',
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'transform', 'scale', 'clip', 'clip-path', 'overflow', 'text-indent',
  'filter', 'content-visibility', 'z-index', 'line-height', 'inset',
];

/**
 * Should a rule inside these at-rule conditions be considered?
 *
 * A rule inside `@media print` cannot affect what a client sees on a screen, so
 * it is skipped. Every other condition is treated as applying. That is
 * deliberately paranoid: a label hidden only above 600px is still a label
 * hidden in the room, and the cost of the false positive is one stylesheet
 * edit, while the cost of the false negative is the reputational failure §22.6
 * exists to prevent.
 *
 * @param {string[]} conditions
 * @returns {boolean}
 */
export function conditionsApply(conditions) {
  for (const cond of conditions) {
    const m = /^@media\s+([\s\S]*)$/.exec(cond);
    if (!m) continue;
    const query = m[1].trim();
    if (!query) continue;
    const branches = query.split(',').map((q) => q.trim());
    // Applies when at least one branch could match a screen.
    const anyScreen = branches.some((b) => {
      const head = b.split(/\s+and\s+/i)[0].trim();
      if (NON_SCREEN_MEDIA.test(head)) return false;
      if (/^not\s+screen\b/i.test(b)) return false;
      return true;
    });
    if (!anyScreen) return false;
  }
  return true;
}

/**
 * @typedef {object} ComputedStyle
 * @property {Record<string, string>} props     resolved declared values
 * @property {Record<string, string>} vars      custom properties in scope
 * @property {Record<string, {rule: StyleRule|null, important: boolean}>} sources
 * @property {number} fontSizePx
 * @property {number} effectiveOpacity          product of this element and its ancestors
 */

/**
 * Compute styles down an ancestor chain.
 *
 * @param {ElementDesc[]} chain  root → target
 * @param {StyleRule[]} rules
 * @param {object} [options]
 * @param {number} [options.rootFontSizePx]
 * @returns {ComputedStyle[]}  one entry per chain element
 */
export function computeCascade(chain, rules, options = {}) {
  const rootFontSizePx = options.rootFontSizePx ?? 16;
  /** @type {ComputedStyle[]} */
  const out = [];

  for (let i = 0; i < chain.length; i++) {
    const el = chain[i];
    const parent = i > 0 ? out[i - 1] : null;

    /** @type {{decl: Declaration, spec: [number, number, number], order: number, rule: StyleRule|null}[]} */
    const candidates = [];
    for (const rule of rules) {
      if (!conditionsApply(rule.conditions)) continue;
      if (rule.selector.some((p) => p.dynamic)) continue;   // interaction states are transient
      if (!matchesSelector(rule.selector, chain, i)) continue;
      for (const decl of rule.declarations) {
        candidates.push({ decl, spec: rule.specificity, order: rule.order, rule });
      }
    }
    for (const decl of parseDeclarations(el.inlineStyle || '')) {
      candidates.push({ decl, spec: [1000, 0, 0], order: Number.MAX_SAFE_INTEGER, rule: null });
    }

    /** @type {Record<string, {value: string, important: boolean, spec: [number, number, number], order: number, rule: StyleRule|null}>} */
    const winners = {};
    for (const c of candidates) {
      const key = c.decl.prop;
      const prev = winners[key];
      if (!prev || beats(c, prev)) {
        winners[key] = { value: c.decl.value, important: c.decl.important, spec: c.spec, order: c.order, rule: c.rule };
      }
    }

    /** @type {Record<string, string>} */
    const vars = { ...(parent ? parent.vars : {}) };
    for (const [k, v] of Object.entries(winners)) if (k.startsWith('--')) vars[k] = v.value;

    /** @type {Record<string, string>} */
    const props = {};
    /** @type {Record<string, {rule: StyleRule|null, important: boolean}>} */
    const sources = {};
    for (const prop of TRACKED_PROPS) {
      const w = winners[prop];
      if (w) {
        props[prop] = resolveVars(w.value, vars);
        sources[prop] = { rule: w.rule, important: w.important };
      } else if (parent && INHERITED_PROPS.has(prop) && parent.props[prop] !== undefined) {
        props[prop] = parent.props[prop];
        sources[prop] = parent.sources[prop] || { rule: null, important: false };
      }
    }

    const parentFontSize = parent ? parent.fontSizePx : rootFontSizePx;
    const fontSizePx = resolveFontSize(props['font-size'] ?? shorthandFontSize(props.font), parentFontSize, rootFontSizePx);
    const ownOpacity = parseOpacity(props.opacity);
    const effectiveOpacity = (parent ? parent.effectiveOpacity : 1) * ownOpacity;

    out.push({ props, vars, sources, fontSizePx, effectiveOpacity });
  }
  return out;
}

/**
 * @param {{decl: Declaration, spec: [number, number, number], order: number}} a
 * @param {{important: boolean, spec: [number, number, number], order: number}} b
 * @returns {boolean}
 */
function beats(a, b) {
  if (a.decl.important !== b.important) return a.decl.important;
  for (let i = 0; i < 3; i++) {
    if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
  }
  return a.order >= b.order;
}

/**
 * Substitute `var(--name, fallback)` recursively.
 * @param {string} value
 * @param {Record<string, string>} vars
 * @param {number} [depth]
 * @returns {string}
 */
export function resolveVars(value, vars, depth = 0) {
  if (depth > 12 || typeof value !== 'string' || !value.includes('var(')) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let depthCount = 0;
    let j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === '(') depthCount++;
      else if (value[j] === ')') { depthCount--; if (depthCount === 0) { j++; break; } }
    }
    const inner = value.slice(at + 4, j - 1);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const hit = vars[name];
    out += resolveVars(hit !== undefined ? hit : fallback, vars, depth + 1);
    i = j;
  }
  return out;
}

/** @param {string} s @returns {number} */
function topLevelComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) return i;
  }
  return -1;
}

/** @param {string|undefined} fontShorthand @returns {string|undefined} */
function shorthandFontSize(fontShorthand) {
  if (!fontShorthand) return undefined;
  const m = /(^|\s)(-?[\d.]+(?:px|pt|em|rem|%|ex|ch|vh|vw)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(\s*\/|\s|$)/i.exec(fontShorthand);
  return m ? m[2] : undefined;
}

const ABSOLUTE_SIZES = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32,
};

/**
 * Resolve a font-size declaration to px.
 * @param {string|undefined} value
 * @param {number} parentPx
 * @param {number} rootPx
 * @returns {number}
 */
export function resolveFontSize(value, parentPx, rootPx) {
  if (!value) return parentPx;
  const v = String(value).trim().toLowerCase();
  if (v === 'inherit' || v === 'unset' || v === 'revert') return parentPx;
  if (v === 'initial') return 16;
  if (v === 'smaller') return parentPx / 1.2;
  if (v === 'larger') return parentPx * 1.2;
  if (ABSOLUTE_SIZES[v] !== undefined) return ABSOLUTE_SIZES[v];
  const clampMatch = /^clamp\(([\s\S]+)\)$/.exec(v);
  if (clampMatch) {
    // The floor of a clamp() is the smallest size it can ever render at, and the
    // floor is what a size law has to be judged on.
    const args = clampMatch[1].split(',');
    return resolveFontSize(args[0], parentPx, rootPx);
  }
  const minMatch = /^min\(([\s\S]+)\)$/.exec(v);
  if (minMatch) {
    return Math.min(...minMatch[1].split(',').map((a) => resolveFontSize(a, parentPx, rootPx)));
  }
  const maxMatch = /^max\(([\s\S]+)\)$/.exec(v);
  if (maxMatch) {
    return Math.max(...maxMatch[1].split(',').map((a) => resolveFontSize(a, parentPx, rootPx)));
  }
  const num = parseFloat(v);
  if (!Number.isFinite(num)) return parentPx;
  if (v.endsWith('rem')) return num * rootPx;
  if (v.endsWith('em')) return num * parentPx;
  if (v.endsWith('%')) return (num / 100) * parentPx;
  if (v.endsWith('pt')) return (num * 96) / 72;
  if (v.endsWith('pc')) return (num * 96) / 6;
  if (v.endsWith('in')) return num * 96;
  if (v.endsWith('cm')) return (num * 96) / 2.54;
  if (v.endsWith('mm')) return (num * 96) / 25.4;
  if (v.endsWith('ex')) return num * parentPx * 0.5;
  if (v.endsWith('ch')) return num * parentPx * 0.5;
  if (v.endsWith('vh') || v.endsWith('vw') || v.endsWith('vmin') || v.endsWith('vmax')) {
    // Viewport units cannot be resolved without a viewport. 1vh of the smallest
    // breakpoint (390×844) is the fail-safe reading for a *minimum* size check.
    return num * 3.9;
  }
  if (v.endsWith('px')) return num;
  return num;
}

/**
 * @param {string|undefined} value
 * @returns {number} 0..1
 */
export function parseOpacity(value) {
  if (value === undefined || value === null || value === '') return 1;
  const v = String(value).trim();
  if (v.endsWith('%')) {
    const p = parseFloat(v) / 100;
    return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 1;
  }
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

/**
 * The background colour a `background` shorthand or `background-color` sets.
 * @param {ComputedStyle} style
 * @returns {string|null}
 */
export function backgroundColorOf(style) {
  const direct = style.props['background-color'];
  if (direct) return direct;
  const shorthand = style.props.background;
  if (!shorthand) return null;
  // Take the last colour-looking token; `background: url(...) #fff no-repeat`.
  const tokens = shorthand.match(/#[0-9a-fA-F]{3,8}\b|[a-z-]+\([^)]*\)|\b[a-zA-Z]+\b/g) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^(url|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|image-set)\(/i.test(t)) continue;
    if (/^(no-repeat|repeat|repeat-x|repeat-y|center|top|bottom|left|right|cover|contain|fixed|scroll|local|border-box|padding-box|content-box|space|round|none)$/i.test(t)) continue;
    return t;
  }
  return null;
}
