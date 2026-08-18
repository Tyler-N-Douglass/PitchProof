/**
 * Shape language extraction (§7) — modal border-radius, modal border width and a
 * shadow presence tier — plus the CSS parser the rest of L5 reads.
 *
 * §7 asks for "modal border-radius, modal border width, shadow presence tier".
 * "Modal" is used in its statistical sense: the value a design actually repeats,
 * not the first one found and not an average. An average is the wrong statistic
 * here — a design with a hundred 8px cards and one 40px pill averages to
 * something that appears nowhere in the design.
 *
 * Every value is parsed rather than pattern-matched: `px`, `rem`, `em`, `%`,
 * `pt`/`pc`/`in`/`cm`/`mm`/`Q`, `ex`/`ch`, viewport units, the four-value
 * `border-radius` shorthand with its `/` elliptical form, the `border`
 * shorthand, and comma-separated `box-shadow` lists with `inset` and `rgba()`
 * colours. A regex over the raw stylesheet would mis-read every one of those.
 *
 * This module also owns the CSS rule parser (`parseCssRules`) because two L5
 * modules need one and the lane may not add a sixth file; `type.js` imports it
 * from here.
 *
 * @module brand/shape
 */

// ---------------------------------------------------------------- constants

/**
 * CSS's own initial value for `font-size` on the root element, which is what
 * `rem` resolves against when a stylesheet does not set one.
 */
export const DEFAULT_ROOT_FONT_SIZE_PX = 16;

/**
 * The viewport a stylesheet's viewport units are resolved against when no
 * viewport is supplied. 1024×768 is the `md` breakpoint in
 * `core/contracts.js` `BREAKPOINTS`, so shape extraction and the overflow
 * detector are talking about the same middle case.
 */
export const DEFAULT_VIEWPORT_PX = { width: 1024, height: 768 };

/**
 * Absolute-length conversions, exactly as defined by CSS Values 4 §5.2:
 * 1in = 96px, 1pt = 1/72in, 1pc = 12pt, 1cm = 96/2.54px, 1mm = 1/10cm,
 * 1Q = 1/40cm.
 */
const ABSOLUTE_UNITS = {
  px: 1,
  in: 96,
  pt: 96 / 72,
  pc: 96 / 6,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

/**
 * `ex` and `ch` depend on the rendered font. CSS Values 4 §5.1.1 gives the
 * fallbacks a UA must use when the font metrics are unavailable: 0.5em for `ex`
 * and 0.5em for `ch` (the advance of "0" in a font whose metrics are unknown).
 * Shape extraction never has the rendered font in hand, so it uses those
 * defined fallbacks rather than guessing.
 */
const RELATIVE_TO_FONT = { em: 1, rem: 1, ex: 0.5, ch: 0.5 };

/**
 * Radii at or above this fraction of the reference box read as a pill or a
 * circle — an avatar, a chip, a toggle — and are not the design's corner
 * language. Half the box is the exact point at which a rectangle's corners meet
 * and the shape stops being "a rectangle with rounded corners".
 */
export const PILL_PERCENT = 50;

/**
 * A percentage radius is resolved against this box width. 320px is a single
 * column at the `sm` breakpoint (390px minus typical gutters) and is only used
 * to rank percentage radii below `PILL_PERCENT` against absolute ones; radii at
 * or above `PILL_PERCENT` are dropped before this is consulted.
 */
export const PERCENT_BASIS_PX = 320;

/**
 * Absolute radii above this are pills by intent (`border-radius: 9999px` is the
 * idiom) and are excluded from the modal radius for the same reason as
 * `PILL_PERCENT`. 64px is four times the largest radius in any mainstream design
 * system's card scale (Material's largest shape corner is 28px; Carbon's is
 * 16px), so nothing a design means as a corner is caught by it.
 */
export const PILL_RADIUS_PX = 64;

/** Border widths above this are dividers and rules, not component borders. */
export const MAX_BORDER_WIDTH_PX = 24;

/**
 * Selector weights. A design's shape language lives on its components, so a
 * radius declared on `.card` counts for more than one declared on `blockquote`,
 * and far more than one declared on `*`.
 *
 * The weights are ordinal, not measured: the only claim they make is
 * "container components define the shape language, controls define it almost as
 * much, page-level rules barely define it at all".
 */
export const SELECTOR_WEIGHTS = [
  { re: /\b(modal|dialog|card|panel|popover|sheet|drawer|tooltip|tile|well|surface)\b/i, weight: 3 },
  { re: /\b(btn|button|input|select|textarea|field|form-control|control|chip|badge|pill|tag|avatar|thumb)\b/i, weight: 2 },
  { re: /^\s*[*]\s*$|^\s*(html|body|:root)\b/i, weight: 0.25 },
];

/** Weight for a selector matching none of the above. */
export const DEFAULT_SELECTOR_WEIGHT = 1;

/**
 * Shadow strength tier boundaries, anchored to Material Design's published
 * elevation shadows so the tiers mean something outside this repository:
 *
 *   elevation  published umbra layer                 strength (see shadowStrength)
 *   dp1        0 1px 3px rgba(0,0,0,.12)             2.5
 *   dp2        0 3px 6px rgba(0,0,0,.16)             8.0
 *   dp8        0 8px 17px rgba(0,0,0,.20)           27.5  -> capped factor 2 -> 33.0
 *   dp16       0 16px 24px rgba(0,0,0,.14)          32.7
 *
 * Tier 1 is "a hairline lift" (dp1), tier 2 is "a card floats" (dp2–dp6), tier 3
 * is "a modal sits above the page" (dp8+).
 */
export const SHADOW_TIER_BOUNDS = { t1: 4, t2: 16 };

/**
 * The opacity a shadow is measured against. 0.12 is the umbra alpha in
 * Material's dp1 shadow and the most common shadow alpha in the wild; a shadow
 * at that alpha contributes its geometry unmodified.
 */
export const SHADOW_REFERENCE_ALPHA = 0.12;

// ------------------------------------------------------------ CSS tokenizing

/**
 * Remove CSS comments without disturbing anything inside a string.
 * @param {string} css
 * @returns {string}
 */
export function stripCssComments(css) {
  const src = String(css || '');
  let out = '';
  let i = 0;
  let quote = '';
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      // A comment is whitespace in CSS, not nothing.
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Split a CSS value on a separator, ignoring separators inside parentheses,
 * brackets or strings. `rgba(0, 0, 0, .2), 0 1px 2px` is two shadows, not five.
 * @param {string} value
 * @param {string} [sep]
 * @returns {string[]}
 */
export function splitTopLevel(value, sep = ',') {
  const src = String(value || '');
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < src.length) { cur += src[i + 1]; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') { depth += 1; cur += ch; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth === 0 && ch === sep) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Split a CSS value into whitespace-separated components, keeping functional
 * notation intact.
 * @param {string} value
 * @returns {string[]}
 */
export function splitComponents(value) {
  const src = String(value || '').trim();
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < src.length) { cur += src[i + 1]; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth += 1; cur += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth === 0 && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * @typedef {object} CssRule
 * @property {string[]} selectors     empty for at-rules that carry declarations
 * @property {Record<string, string>} declarations   last declaration wins, as in CSS
 * @property {string|null} at         at-rule name without the `@`, e.g. `font-face`
 * @property {string} prelude         the at-rule's prelude, e.g. `(min-width: 60rem)`
 * @property {string[]} conditions    enclosing at-rule preludes, outermost first
 * @property {number} order           source order, so extraction is stable
 */

/**
 * Parse a stylesheet into flat rules. Nested conditional groups (`@media`,
 * `@supports`, `@layer`, `@container`) are flattened and each rule records the
 * conditions it sat under; `@keyframes` bodies are skipped, because a keyframe's
 * declarations describe motion, never the shape language; statement at-rules
 * (`@import`, `@charset`, `@namespace`) are recorded with no declarations so a
 * caller can see them without following them.
 *
 * The parser is deliberately forgiving in the way browsers are: an unterminated
 * block ends at end of input, and a declaration without a colon is dropped.
 *
 * @param {string} css
 * @returns {CssRule[]}
 */
export function parseCssRules(css) {
  const src = stripCssComments(css);
  /** @type {CssRule[]} */
  const rules = [];
  let order = 0;

  /**
   * @param {number} start
   * @param {number} end
   * @param {string[]} conditions
   */
  const parseBlockList = (start, end, conditions) => {
    let i = start;
    while (i < end) {
      // Skip whitespace and stray semicolons.
      while (i < end && /[\s;]/.test(src[i])) i += 1;
      if (i >= end) break;

      const braceAt = findTopLevel(src, i, end, '{');
      const semiAt = findTopLevel(src, i, end, ';');
      const isStatement = semiAt >= 0 && (braceAt < 0 || semiAt < braceAt);

      if (isStatement) {
        const text = src.slice(i, semiAt).trim();
        if (text.startsWith('@')) {
          const m = /^@([-\w]+)\s*([\s\S]*)$/.exec(text);
          rules.push({
            selectors: [], declarations: {}, at: m ? m[1].toLowerCase() : '',
            prelude: m ? m[2].trim() : '', conditions: conditions.slice(), order: order++,
          });
        }
        i = semiAt + 1;
        continue;
      }
      if (braceAt < 0) break;

      const prelude = src.slice(i, braceAt).trim();
      const close = matchBrace(src, braceAt, end);
      const bodyStart = braceAt + 1;
      const bodyEnd = close;

      if (prelude.startsWith('@')) {
        const m = /^@([-\w]+)\s*([\s\S]*)$/.exec(prelude);
        const name = m ? m[1].toLowerCase() : '';
        const params = m ? m[2].trim() : '';
        if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container' || name === 'scope') {
          parseBlockList(bodyStart, bodyEnd, conditions.concat(params ? [`@${name} ${params}`] : [`@${name}`]));
        } else if (name === 'keyframes' || name === '-webkit-keyframes' || name === '-moz-keyframes') {
          // Motion, not shape. Recorded as an at-rule with no declarations.
          rules.push({ selectors: [], declarations: {}, at: name, prelude: params, conditions: conditions.slice(), order: order++ });
        } else {
          rules.push({
            selectors: [], declarations: parseDeclarations(src.slice(bodyStart, bodyEnd)),
            at: name, prelude: params, conditions: conditions.slice(), order: order++,
          });
        }
      } else {
        rules.push({
          selectors: splitTopLevel(prelude, ',').filter(Boolean),
          declarations: parseDeclarations(src.slice(bodyStart, bodyEnd)),
          at: null, prelude: '', conditions: conditions.slice(), order: order++,
        });
      }
      i = close + 1;
    }
  };

  parseBlockList(0, src.length, []);
  return rules;
}

/**
 * Index of the next occurrence of `ch` at paren/bracket depth zero and outside
 * a string, or -1.
 * @param {string} src @param {number} from @param {number} end @param {string} ch
 * @returns {number}
 */
function findTopLevel(src, from, end, ch) {
  let depth = 0;
  let quote = '';
  for (let i = from; i < end; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') { depth += 1; continue; }
    if (c === ')' || c === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && c === ch) return i;
    if (depth === 0 && ch === ';' && c === '{') return -1;
  }
  return -1;
}

/**
 * Index of the `}` matching the `{` at `open`, or `end`.
 * @param {string} src @param {number} open @param {number} end
 * @returns {number}
 */
function matchBrace(src, open, end) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return end;
}

/**
 * Parse a declaration block body into a property map. Later declarations of the
 * same property win, which is what the cascade does within one block.
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseDeclarations(body) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const decl of splitTopLevel(body, ';')) {
    const idx = decl.indexOf(':');
    if (idx <= 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    let value = decl.slice(idx + 1).trim();
    if (!prop || !value) continue;
    value = value.replace(/\s*!\s*important\s*$/i, '');
    out[prop] = value.trim();
  }
  return out;
}

// --------------------------------------------------------------- CSS lengths

/**
 * @typedef {object} LengthContext
 * @property {number} [rootFontSizePx]
 * @property {number} [fontSizePx]
 * @property {number} [basisPx]           what `%` resolves against
 * @property {number} [viewportWidthPx]
 * @property {number} [viewportHeightPx]
 */

/**
 * Resolve a CSS length to pixels, or null when the value is not a length this
 * build can resolve (`auto`, `inherit`, `calc()`, a custom property reference).
 * Returning null rather than a guess is deliberate: a guessed radius becomes a
 * brand fact the studio would then show a user as extracted.
 *
 * @param {string|number} value
 * @param {LengthContext} [ctx]
 * @returns {number|null}
 */
export function parseLength(value, ctx = {}) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '') return n === 0 ? 0 : null;      // only zero is unitless in CSS
  if (unit in ABSOLUTE_UNITS) return n * ABSOLUTE_UNITS[unit];
  const rootFont = ctx.rootFontSizePx ?? DEFAULT_ROOT_FONT_SIZE_PX;
  const font = ctx.fontSizePx ?? rootFont;
  if (unit === 'rem') return n * rootFont;
  if (unit in RELATIVE_TO_FONT) return n * RELATIVE_TO_FONT[unit] * font;
  if (unit === '%') return ctx.basisPx === undefined ? null : (n / 100) * ctx.basisPx;
  const vw = ctx.viewportWidthPx ?? DEFAULT_VIEWPORT_PX.width;
  const vh = ctx.viewportHeightPx ?? DEFAULT_VIEWPORT_PX.height;
  if (unit === 'vw') return (n / 100) * vw;
  if (unit === 'vh') return (n / 100) * vh;
  if (unit === 'vmin') return (n / 100) * Math.min(vw, vh);
  if (unit === 'vmax') return (n / 100) * Math.max(vw, vh);
  return null;
}

/**
 * True when the value is a percentage, with its numeric part. Radii need to know
 * because a percentage radius is a different kind of statement.
 * @param {string} value
 * @returns {number|null}
 */
export function percentageOf(value) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(String(value || '').trim());
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------------- colours

/** Named CSS colours that carry an implicit alpha of 0. */
const ZERO_ALPHA_KEYWORDS = new Set(['transparent']);

/**
 * The alpha channel of a CSS colour, 0..1, or 1 when the colour is opaque or
 * unparseable. Only alpha is needed here — shadow strength depends on how dark
 * the shadow reads, and a shadow's hue is almost always black.
 * @param {string} value
 * @returns {number}
 */
export function colorAlpha(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 1;
  if (ZERO_ALPHA_KEYWORDS.has(v)) return 0;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 4) return parseInt(h[3] + h[3], 16) / 255;
    if (h.length === 8) return parseInt(h.slice(6, 8), 16) / 255;
    return 1;
  }
  const fn = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(([\s\S]*)\)$/.exec(v);
  if (fn) {
    const body = fn[2];
    // Both legacy `rgba(r, g, b, a)` and modern `rgb(r g b / a)` syntaxes.
    const slash = splitTopLevel(body, '/');
    if (slash.length > 1) return alphaNumber(slash[slash.length - 1]);
    const parts = splitTopLevel(body, ',');
    if (parts.length === 4) return alphaNumber(parts[3]);
    return 1;
  }
  return 1;
}

/**
 * @param {string} token
 * @returns {number}
 */
function alphaNumber(token) {
  const t = String(token || '').trim();
  const pct = percentageOf(t);
  if (pct !== null) return Math.max(0, Math.min(1, pct / 100));
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

/**
 * True when a component of a shorthand looks like a colour rather than a length
 * or a keyword.
 * @param {string} token
 * @returns {boolean}
 */
export function looksLikeColor(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return false;
  if (/^#[0-9a-f]{3,8}$/.test(t)) return true;
  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var)\s*\(/.test(t)) return true;
  return NAMED_COLORS.has(t);
}

/**
 * The CSS named colours. The full list matters: a `border: thin dashed
 * rebeccapurple` must not be read as a length.
 */
export const NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue',
  'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
  'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite',
  'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink',
  'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen',
  'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow',
  'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
  'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow',
  'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive',
  'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen',
  'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum',
  'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
  'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver',
  'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue',
  'tan', 'teal', 'thistle', 'tomato', 'transparent', 'turquoise', 'violet', 'wheat',
  'white', 'whitesmoke', 'yellow', 'yellowgreen', 'currentcolor',
]);

// -------------------------------------------------------------------- border

/** Keyword border widths, from CSS Backgrounds 3 §4.1 (UA-defined; these are the
 * values every major engine ships). */
const BORDER_KEYWORD_PX = { thin: 1, medium: 3, thick: 5 };

/** Border styles that paint nothing regardless of width. */
const INVISIBLE_BORDER_STYLES = new Set(['none', 'hidden']);

/**
 * @typedef {object} BorderShorthand
 * @property {number|null} widthPx   null when the shorthand did not set a width
 * @property {string|null} style
 * @property {string|null} color
 * @property {boolean} paints        false for `none`/`hidden` or a zero width
 */

/**
 * Parse a `border`/`border-top`/… shorthand. The three components may appear in
 * any order, and any of them may be omitted.
 * @param {string} value
 * @param {LengthContext} [ctx]
 * @returns {BorderShorthand}
 */
export function parseBorderShorthand(value, ctx = {}) {
  /** @type {BorderShorthand} */
  const out = { widthPx: null, style: null, color: null, paints: true };
  const v = String(value || '').trim().toLowerCase();
  if (!v) return { ...out, paints: false };
  if (v === 'none' || v === 'hidden') return { widthPx: 0, style: v, color: null, paints: false };
  for (const token of splitComponents(v)) {
    if (token in BORDER_KEYWORD_PX) { out.widthPx = BORDER_KEYWORD_PX[token]; continue; }
    if (/^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/.test(token)) { out.style = token; continue; }
    const len = parseLength(token, ctx);
    if (len !== null) { out.widthPx = len; continue; }
    if (looksLikeColor(token)) { out.color = token; continue; }
  }
  if (out.style && INVISIBLE_BORDER_STYLES.has(out.style)) { out.paints = false; out.widthPx = 0; }
  if (out.widthPx === 0) out.paints = false;
  return out;
}

/**
 * Parse a `border-width` value, which may carry one to four sides.
 * @param {string} value
 * @param {LengthContext} [ctx]
 * @returns {number[]}
 */
export function parseBorderWidths(value, ctx = {}) {
  /** @type {number[]} */
  const out = [];
  for (const token of splitComponents(String(value || '').toLowerCase())) {
    if (token in BORDER_KEYWORD_PX) { out.push(BORDER_KEYWORD_PX[token]); continue; }
    const len = parseLength(token, ctx);
    if (len !== null) out.push(len);
  }
  return out;
}

// --------------------------------------------------------------------- radius

/**
 * Parse a `border-radius` value into its corner radii in source order.
 * Handles the one-to-four value form and the elliptical `h / v` form, of which
 * only the horizontal radii are returned — a corner's shape language is read
 * from its horizontal radius, and an elliptical corner is rare enough that
 * averaging the two axes would only blur the common case.
 *
 * Percentages are returned as `{percent}` entries so the caller can apply the
 * pill rule before resolving them.
 *
 * @param {string} value
 * @param {LengthContext} [ctx]
 * @returns {{px: number|null, percent: number|null, raw: string}[]}
 */
export function parseRadiusValue(value, ctx = {}) {
  const [horizontal] = splitTopLevel(String(value || ''), '/');
  /** @type {{px: number|null, percent: number|null, raw: string}[]} */
  const out = [];
  for (const token of splitComponents(horizontal || '')) {
    const pct = percentageOf(token);
    out.push({ px: pct === null ? parseLength(token, ctx) : null, percent: pct, raw: token });
  }
  return out;
}

/**
 * Reduce a parsed radius shorthand to the single number that stands for the
 * declaration, or null when it contributes nothing.
 *
 * The representative is the largest resolvable corner: `border-radius: 8px 8px 0
 * 0` is an 8px corner language applied to a component whose bottom sits against
 * something else, and reading it as 4 (the mean) or 0 (the minimum) would report
 * a radius the design never draws.
 *
 * @param {{px: number|null, percent: number|null}[]} corners
 * @returns {number|null}
 */
export function representativeRadius(corners) {
  let best = null;
  for (const c of corners) {
    if (c.percent !== null) {
      if (c.percent >= PILL_PERCENT) return null;              // pill or circle
      const px = (c.percent / 100) * PERCENT_BASIS_PX;
      best = best === null ? px : Math.max(best, px);
      continue;
    }
    if (c.px === null) continue;
    if (c.px < 0) continue;
    if (c.px > PILL_RADIUS_PX) return null;                    // `9999px` pill
    best = best === null ? c.px : Math.max(best, c.px);
  }
  return best;
}

// -------------------------------------------------------------------- shadows

/**
 * @typedef {object} ParsedShadow
 * @property {boolean} inset
 * @property {number} offsetXPx
 * @property {number} offsetYPx
 * @property {number} blurPx
 * @property {number} spreadPx
 * @property {string|null} color
 * @property {number} alpha
 */

/**
 * Parse a `box-shadow` value into its comma-separated layers. `none` yields an
 * empty list, which is how a design says "no shadow" and must be counted as
 * evidence rather than as silence.
 * @param {string} value
 * @param {LengthContext} [ctx]
 * @returns {ParsedShadow[]}
 */
export function parseBoxShadow(value, ctx = {}) {
  const v = String(value || '').trim();
  if (!v || /^(none|initial|unset|revert)$/i.test(v)) return [];
  /** @type {ParsedShadow[]} */
  const layers = [];
  for (const layer of splitTopLevel(v, ',')) {
    /** @type {number[]} */
    const lengths = [];
    let inset = false;
    /** @type {string|null} */
    let color = null;
    for (const token of splitComponents(layer)) {
      if (/^inset$/i.test(token)) { inset = true; continue; }
      const len = parseLength(token, ctx);
      if (len !== null) { lengths.push(len); continue; }
      if (looksLikeColor(token)) { color = token; continue; }
    }
    if (lengths.length < 2) continue;
    layers.push({
      inset,
      offsetXPx: lengths[0],
      offsetYPx: lengths[1],
      blurPx: lengths[2] ?? 0,
      spreadPx: lengths[3] ?? 0,
      color,
      alpha: color === null ? 1 : colorAlpha(color),
    });
  }
  return layers;
}

/**
 * How strongly a shadow reads, in pixels of apparent lift.
 *
 *   geometry = blur/2 + spread + max(|dx|, |dy|)
 *   strength = geometry × min(2, alpha / 0.12)
 *
 * Blur is halved because only half a Gaussian's radius reads as shadow; spread
 * and offset count fully because both move the shadow's edge. The alpha factor
 * is capped at 2 so a single opaque hairline (`0 1px 0 #000`) cannot outrank a
 * genuine elevation. Inset shadows describe an inner well rather than elevation
 * and score zero. The tier bounds in `SHADOW_TIER_BOUNDS` are anchored to
 * Material's published elevations under this same formula.
 *
 * @param {ParsedShadow} shadow
 * @returns {number}
 */
export function shadowStrength(shadow) {
  if (!shadow || shadow.inset) return 0;
  const geometry = shadow.blurPx / 2 + shadow.spreadPx + Math.max(Math.abs(shadow.offsetXPx), Math.abs(shadow.offsetYPx));
  if (geometry <= 0) return 0;
  const alpha = Math.max(0, Math.min(1, shadow.alpha));
  if (alpha === 0) return 0;
  return geometry * Math.min(2, alpha / SHADOW_REFERENCE_ALPHA);
}

/**
 * The strength of a whole `box-shadow` declaration: the strongest of its layers,
 * because a stacked shadow reads as one effect and its heaviest layer is what
 * the eye measures.
 * @param {ParsedShadow[]} layers
 * @returns {number}
 */
export function declarationStrength(layers) {
  let best = 0;
  for (const l of layers) best = Math.max(best, shadowStrength(l));
  return best;
}

/**
 * Map a strength to the §4 `shadowLevel` tier.
 * @param {number} strength
 * @returns {0|1|2|3}
 */
export function shadowTier(strength) {
  if (!(strength > 0)) return 0;
  if (strength <= SHADOW_TIER_BOUNDS.t1) return 1;
  if (strength <= SHADOW_TIER_BOUNDS.t2) return 2;
  return 3;
}

// ------------------------------------------------------------------ evidence

/**
 * The weight a selector list carries as evidence of the shape language.
 * @param {string[]} selectors
 * @returns {number}
 */
export function selectorWeight(selectors) {
  if (!selectors || selectors.length === 0) return DEFAULT_SELECTOR_WEIGHT;
  let best = 0;
  for (const sel of selectors) {
    let w = DEFAULT_SELECTOR_WEIGHT;
    for (const rule of SELECTOR_WEIGHTS) {
      if (rule.re.test(sel)) { w = rule.weight; break; }
    }
    best = Math.max(best, w);
  }
  return best;
}

/**
 * @typedef {object} ShapeEvidence
 * @property {{value: number, weight: number, selector: string, property: string}[]} radius
 * @property {{value: number, weight: number, selector: string, property: string}[]} border
 * @property {{tier: 0|1|2|3, strength: number, weight: number, selector: string}[]} shadow
 * @property {number} rulesSeen
 */

/** Properties that carry a corner radius. */
const RADIUS_PROPERTIES = [
  'border-radius', '-webkit-border-radius', '-moz-border-radius',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  'border-start-start-radius', 'border-start-end-radius',
  'border-end-start-radius', 'border-end-end-radius',
];

/** Properties that carry a border width. */
const BORDER_SHORTHANDS = ['border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-block', 'border-inline'];
const BORDER_WIDTH_PROPS = ['border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'];

/**
 * Walk a stylesheet and collect every shape declaration with the weight of the
 * selector that carried it.
 * @param {string} css
 * @param {LengthContext} [ctx]
 * @returns {ShapeEvidence}
 */
export function collectShapeEvidence(css, ctx = {}) {
  /** @type {ShapeEvidence} */
  const ev = { radius: [], border: [], shadow: [], rulesSeen: 0 };
  const rules = parseCssRules(css);
  const rootFontSizePx = rootFontSize(rules, ctx);
  const lengthCtx = { ...ctx, rootFontSizePx };

  for (const rule of rules) {
    if (rule.at) continue;                       // at-rule bodies are not components
    if (rule.selectors.length === 0) continue;
    ev.rulesSeen += 1;
    const weight = selectorWeight(rule.selectors);
    const selector = rule.selectors.join(', ');

    for (const prop of RADIUS_PROPERTIES) {
      const raw = rule.declarations[prop];
      if (raw === undefined) continue;
      const value = representativeRadius(parseRadiusValue(raw, lengthCtx));
      if (value === null) continue;
      ev.radius.push({ value, weight, selector, property: prop });
    }

    for (const prop of BORDER_SHORTHANDS) {
      const raw = rule.declarations[prop];
      if (raw === undefined) continue;
      const parsed = parseBorderShorthand(raw, lengthCtx);
      const px = parsed.paints ? parsed.widthPx : 0;
      if (px === null) continue;
      if (px > MAX_BORDER_WIDTH_PX) continue;
      ev.border.push({ value: px, weight, selector, property: prop });
    }
    for (const prop of BORDER_WIDTH_PROPS) {
      const raw = rule.declarations[prop];
      if (raw === undefined) continue;
      const widths = parseBorderWidths(raw, lengthCtx).filter((w) => w <= MAX_BORDER_WIDTH_PX);
      if (widths.length === 0) continue;
      const style = rule.declarations['border-style'];
      const invisible = style !== undefined && splitComponents(style).every((s) => INVISIBLE_BORDER_STYLES.has(s));
      ev.border.push({ value: invisible ? 0 : Math.max(...widths), weight, selector, property: prop });
    }
    if (rule.declarations['border-style'] !== undefined && rule.declarations['border'] === undefined) {
      const style = rule.declarations['border-style'];
      if (splitComponents(style).every((s) => INVISIBLE_BORDER_STYLES.has(s))) {
        ev.border.push({ value: 0, weight, selector, property: 'border-style' });
      }
    }

    const shadowRaw = rule.declarations['box-shadow'] ?? rule.declarations['-webkit-box-shadow'];
    if (shadowRaw !== undefined) {
      const layers = parseBoxShadow(shadowRaw, lengthCtx);
      const strength = declarationStrength(layers);
      ev.shadow.push({ tier: shadowTier(strength), strength, weight, selector });
    }
  }
  return ev;
}

/**
 * The root font size a stylesheet declares, so `rem` resolves the way the page
 * resolves it. A stylesheet that sets `html { font-size: 62.5% }` — the old
 * "10px rem" idiom — means every `rem` in it is worth 10px, and reading those as
 * 16px would report radii 60% too large.
 * @param {CssRule[]} rules
 * @param {LengthContext} ctx
 * @returns {number}
 */
export function rootFontSize(rules, ctx = {}) {
  let size = ctx.rootFontSizePx ?? DEFAULT_ROOT_FONT_SIZE_PX;
  for (const rule of rules) {
    if (rule.at) continue;
    if (!rule.selectors.some((s) => /^\s*(html|:root)\s*$/i.test(s))) continue;
    const raw = rule.declarations['font-size'];
    if (raw === undefined) continue;
    const pct = percentageOf(raw);
    if (pct !== null) { size = (pct / 100) * DEFAULT_ROOT_FONT_SIZE_PX; continue; }
    const px = parseLength(raw, { rootFontSizePx: DEFAULT_ROOT_FONT_SIZE_PX, fontSizePx: DEFAULT_ROOT_FONT_SIZE_PX });
    if (px !== null && px > 0) size = px;
  }
  return size;
}

/**
 * The weighted mode of a set of numeric observations, quantized to `step`.
 * Ties break toward the larger value, then toward the value with more distinct
 * selectors behind it, so the result never depends on iteration order.
 *
 * @param {{value: number, weight: number, selector: string}[]} rows
 * @param {number} step
 * @returns {{value: number, weight: number, share: number, distinct: number}|null}
 */
export function weightedMode(rows, step) {
  if (!rows || rows.length === 0) return null;
  /** @type {Map<number, {weight: number, selectors: Set<string>}>} */
  const bins = new Map();
  let total = 0;
  for (const row of rows) {
    const key = Math.round(row.value / step) * step;
    let bin = bins.get(key);
    if (!bin) { bin = { weight: 0, selectors: new Set() }; bins.set(key, bin); }
    bin.weight += row.weight;
    bin.selectors.add(row.selector);
    total += row.weight;
  }
  /** @type {{value: number, weight: number, distinct: number}[]} */
  const sorted = [...bins.entries()]
    .map(([value, bin]) => ({ value, weight: bin.weight, distinct: bin.selectors.size }))
    .sort((a, b) => (b.weight - a.weight) || (b.distinct - a.distinct) || (b.value - a.value));
  const best = sorted[0];
  return { value: best.value, weight: best.weight, share: total > 0 ? best.weight / total : 0, distinct: best.distinct };
}

/**
 * The weighted modal shadow tier. Ties break toward the higher tier: a design
 * that is evenly split between "flat" and "elevated" is an elevated design with
 * flat exceptions, not the reverse.
 * @param {{tier: 0|1|2|3, weight: number, selector: string}[]} rows
 * @returns {{tier: 0|1|2|3, share: number}|null}
 */
export function modalShadowTier(rows) {
  if (!rows || rows.length === 0) return null;
  const weights = [0, 0, 0, 0];
  let total = 0;
  for (const row of rows) { weights[row.tier] += row.weight; total += row.weight; }
  let best = 0;
  for (let t = 1; t <= 3; t++) if (weights[t] >= weights[best]) best = t;
  return { tier: /** @type {0|1|2|3} */ (best), share: total > 0 ? weights[best] / total : 0 };
}

// ------------------------------------------------------------------- surface

/**
 * Extract the shape language from a stylesheet (§7).
 *
 * @param {string} css
 * @param {LengthContext} [ctx]
 * @returns {{radiusPx: number, borderWidthPx: number, shadowLevel: 0|1|2|3}}
 */
export function detectShape(css, ctx = {}) {
  const ev = collectShapeEvidence(css, ctx);
  return shapeFromEvidence(ev);
}

/**
 * The same extraction, from already-collected evidence, so a caller that has
 * several stylesheets can merge their evidence before deciding.
 * @param {ShapeEvidence} ev
 * @returns {{radiusPx: number, borderWidthPx: number, shadowLevel: 0|1|2|3}}
 */
export function shapeFromEvidence(ev) {
  // Radius is quantized to 1px and border to 0.5px: sub-pixel radii are a
  // rounding artefact of rem arithmetic, but half-pixel borders are a real
  // hairline idiom on 2× displays.
  const radius = weightedMode(ev.radius, 1);
  const border = weightedMode(ev.border, 0.5);
  const shadow = modalShadowTier(ev.shadow);
  return {
    radiusPx: radius ? round3(radius.value) : 0,
    borderWidthPx: border ? round3(border.value) : 0,
    shadowLevel: shadow ? shadow.tier : 0,
  };
}

/**
 * Confidence in an extracted shape language (§7: computed from sample size and
 * agreement across sources, never hardcoded).
 *
 * Three factors, multiplied, because they are independent failure modes:
 *
 *   sample   — how many weighted observations there were, saturating at
 *              `SAMPLE_SATURATION` weighted units. One `.card { border-radius }`
 *              in a stylesheet is a guess; twenty is a language.
 *   agreement— the share of weight sitting on the chosen value. A stylesheet
 *              split evenly between 2px and 16px radii has no modal radius, and
 *              says so.
 *   coverage — how many of the three groups produced any evidence at all.
 *
 * @param {ShapeEvidence} ev
 * @returns {number}
 */
export function shapeConfidence(ev) {
  const radius = weightedMode(ev.radius, 1);
  const border = weightedMode(ev.border, 0.5);
  const shadow = modalShadowTier(ev.shadow);

  const groups = [
    { rows: ev.radius, chosen: radius ? radius.share : 0 },
    { rows: ev.border, chosen: border ? border.share : 0 },
    { rows: ev.shadow, chosen: shadow ? shadow.share : 0 },
  ];

  let sum = 0;
  let present = 0;
  for (const g of groups) {
    const weight = g.rows.reduce((a, r) => a + r.weight, 0);
    if (weight <= 0) continue;
    present += 1;
    const sample = Math.min(1, weight / SAMPLE_SATURATION);
    sum += sample * g.chosen;
  }
  if (present === 0) return 0;
  const coverage = present / groups.length;
  return clamp01(round6((sum / present) * (0.55 + 0.45 * coverage)));
}

/**
 * Weighted observations beyond which more evidence does not make the answer more
 * certain. Twelve weighted units is roughly four component rules at container
 * weight — the point at which a repeated value is a decision rather than a
 * coincidence.
 */
export const SAMPLE_SATURATION = 12;

/** @param {number} n @returns {number} */
function round3(n) { return Math.round(n * 1000) / 1000; }
/** @param {number} n @returns {number} */
function round6(n) { return Math.round(n * 1e6) / 1e6; }
/** @param {number} n @returns {number} */
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
