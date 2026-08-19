/**
 * CSS colour syntax, for the collection half of §7.
 *
 * Two jobs. First, turn any CSS colour token a real site might carry into an
 * sRGB triple plus an alpha: hex in all four lengths, `rgb()`/`rgba()` in both
 * the legacy comma syntax and the modern space syntax, `hsl()`/`hsla()`,
 * `hwb()`, `oklab()`/`oklch()`, and the CSS Color Module Level 4 named colours.
 * Second, walk a raw stylesheet and pull out every declaration that carries a
 * colour, keeping the selector and the property name — because the property is
 * what tells the area model whether a colour paints a whole box, a text run, or
 * a hairline (see `cluster.js`).
 *
 * Anything that cannot be resolved without a live document — `currentColor`,
 * `var(...)`, `inherit`, `color-mix()` — returns `null` rather than a guess. A
 * guessed colour would enter the palette with the same weight as a measured one
 * and there is no way to tell them apart afterwards.
 *
 * @module brand/color-css
 */

import { hexToRgb, hexAlpha, oklchToOklab, oklabToRgb, clampChromaToGamut } from './oklab.js';

/**
 * The CSS Color Module Level 4 named colours (§6.1), verbatim. Stored as one
 * string and split at load so the source stays readable and the table stays
 * exactly the published one.
 */
const NAMED_COLOR_SOURCE = [
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff',
  'beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff',
  'blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00',
  'chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c',
  'cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9',
  'darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b',
  'darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000',
  'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f',
  'darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493',
  'deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222',
  'floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc',
  'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000',
  'greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c',
  'indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5',
  'lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080',
  'lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90',
  'lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa',
  'lightskyblue 87cefa lightslategray 778899 lightslategrey 778899',
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6',
  'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd',
  'mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee',
  'mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585',
  'midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5',
  'navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23',
  'orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98',
  'paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9',
  'peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080',
  'rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1',
  'saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee',
  'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090',
  'slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c',
  'teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee',
  'wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32',
].join(' ').split(/\s+/);

/** @type {Map<string, string>} name → `#rrggbb` */
export const NAMED_COLORS = new Map();
for (let i = 0; i < NAMED_COLOR_SOURCE.length; i += 2) {
  NAMED_COLORS.set(NAMED_COLOR_SOURCE[i], `#${NAMED_COLOR_SOURCE[i + 1]}`);
}

/** Keywords that resolve only against a live document, and so resolve to nothing here. */
export const UNRESOLVABLE_KEYWORDS = new Set([
  'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto',
]);

/**
 * @typedef {object} ParsedColor
 * @property {[number, number, number]} rgb 0..255
 * @property {number} alpha 0..1
 * @property {string} hex opaque `#rrggbb`
 */

/**
 * Parse one number, percentage, or `none` token against a reference scale.
 * @param {string} tok
 * @param {number} scale value that 100% maps to
 * @returns {number}
 */
function num(tok, scale) {
  const t = tok.trim();
  if (t === 'none') return 0;
  if (t.endsWith('%')) return parseFloat(t) / 100 * scale;
  return parseFloat(t);
}

/**
 * Split the argument list of a functional colour, tolerating both the legacy
 * comma form and the modern space form with a `/ alpha`.
 * @param {string} body
 * @returns {{args: string[], alpha: string|null}}
 */
function splitArgs(body) {
  const [main, alphaPart] = body.split('/');
  const args = main.trim().split(/[\s,]+/).filter(Boolean);
  let alpha = alphaPart === undefined ? null : alphaPart.trim();
  if (alpha === null && args.length === 4) alpha = args.pop();
  return { args, alpha };
}

/**
 * @param {string|null} tok
 * @returns {number} 0..1
 */
function parseAlpha(tok) {
  if (tok === null || tok === undefined || tok === '') return 1;
  const v = num(tok, 1);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/**
 * CSS Color 4 HSL → sRGB, stated as the specification states it.
 * @param {number} h degrees
 * @param {number} s 0..1
 * @param {number} l 0..1
 * @returns {[number, number, number]} 0..255
 */
export function hslToRgb(h, s, l) {
  const hp = ((h % 360) + 360) % 360 / 30;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hp) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * CSS Color 4 HWB → sRGB.
 * @param {number} h degrees
 * @param {number} w 0..1 whiteness
 * @param {number} b 0..1 blackness
 * @returns {[number, number, number]}
 */
export function hwbToRgb(h, w, b) {
  if (w + b >= 1) {
    const g = w / (w + b) * 255;
    return [g, g, g];
  }
  const base = hslToRgb(h, 1, 0.5);
  return /** @type {[number, number, number]} */ (base.map((c) => (c / 255 * (1 - w - b) + w) * 255));
}

/**
 * Parse any CSS colour value. Returns `null` when the token is not a colour or
 * cannot be resolved without a live document.
 * @param {string} value
 * @returns {ParsedColor|null}
 */
export function parseCssColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const lower = raw.toLowerCase();

  if (lower === 'transparent') return { rgb: [0, 0, 0], alpha: 0, hex: '#000000' };
  if (UNRESOLVABLE_KEYWORDS.has(lower)) return null;
  if (lower.startsWith('var(') || lower.startsWith('color-mix(')) return null;

  if (raw[0] === '#') {
    if (!/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) return null;
    const rgb = hexToRgb(raw);
    return finish(rgb, hexAlpha(raw));
  }

  const named = NAMED_COLORS.get(lower);
  if (named) return finish(hexToRgb(named), 1);

  const fn = /^([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/.exec(lower);
  if (!fn) return null;
  const name = fn[1];
  const { args, alpha } = splitArgs(fn[2]);
  const a = parseAlpha(alpha);

  if (name === 'rgb' || name === 'rgba') {
    if (args.length < 3) return null;
    const rgb = /** @type {[number, number, number]} */ ([
      num(args[0], 255), num(args[1], 255), num(args[2], 255),
    ]);
    if (rgb.some((v) => !Number.isFinite(v))) return null;
    return finish(rgb, a);
  }
  if (name === 'hsl' || name === 'hsla') {
    if (args.length < 3) return null;
    const h = parseFloat(args[0]);
    const s = num(args[1], 1);
    const l = num(args[2], 1);
    if (![h, s, l].every(Number.isFinite)) return null;
    return finish(hslToRgb(h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l))), a);
  }
  if (name === 'hwb') {
    if (args.length < 3) return null;
    const h = parseFloat(args[0]);
    const w = num(args[1], 1);
    const b = num(args[2], 1);
    if (![h, w, b].every(Number.isFinite)) return null;
    return finish(hwbToRgb(h, Math.min(1, Math.max(0, w)), Math.min(1, Math.max(0, b))), a);
  }
  if (name === 'oklch') {
    if (args.length < 3) return null;
    const l = num(args[0], 1);
    const c = num(args[1], 0.4);
    const h = parseFloat(args[2]);
    if (![l, c, h].every(Number.isFinite)) return null;
    return finish(oklabToRgb(oklchToOklab(clampChromaToGamut([l, c, h]))), a);
  }
  if (name === 'oklab') {
    if (args.length < 3) return null;
    const l = num(args[0], 1);
    const av = num(args[1], 0.4);
    const bv = num(args[2], 0.4);
    if (![l, av, bv].every(Number.isFinite)) return null;
    return finish(oklabToRgb([l, av, bv]), a);
  }
  return null;
}

/**
 * @param {readonly number[]} rgb
 * @param {number} alpha
 * @returns {ParsedColor}
 */
function finish(rgb, alpha) {
  const clamped = /** @type {[number, number, number]} */ ([
    Math.min(255, Math.max(0, rgb[0])),
    Math.min(255, Math.max(0, rgb[1])),
    Math.min(255, Math.max(0, rgb[2])),
  ]);
  let hex = '#';
  for (const c of clamped) hex += Math.round(c).toString(16).padStart(2, '0');
  return { rgb: clamped, alpha, hex };
}

/**
 * Composite a colour with alpha over an assumed backdrop. A translucent brand
 * colour paints what the eye sees, not what the author declared, and the eye
 * sees the composite.
 * @param {ParsedColor} c
 * @param {readonly number[]} backdrop 0..255
 * @returns {[number, number, number]}
 */
export function compositeOver(c, backdrop) {
  const a = c.alpha;
  return [
    c.rgb[0] * a + backdrop[0] * (1 - a),
    c.rgb[1] * a + backdrop[1] * (1 - a),
    c.rgb[2] * a + backdrop[2] * (1 - a),
  ];
}

/** Remove `/* … *\/` comments without disturbing byte offsets that matter. */
export function stripCssComments(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Blank out the parts of a declaration value that are text rather than colour:
 * quoted strings and the payload of `url(...)`. Replaced with spaces so offsets
 * and token boundaries are preserved.
 *
 * Without this, `background: url("gold-bar.png")` contributes CSS `gold` and
 * `fill: url(#navy-gradient)` contributes CSS `navy` — colours the page never
 * paints.
 * @param {string} value
 * @returns {string}
 */
export function maskCssLiterals(value) {
  return String(value)
    .replace(/"[^"]*"|'[^']*'/g, (m) => ' '.repeat(m.length))
    .replace(/\burl\(([^)]*)\)/gi, (m) => ' '.repeat(m.length));
}

/**
 * Every colour token inside a property value, including each stop of a
 * gradient and each entry of a comma-separated shorthand.
 *
 * The bare-keyword alternative is bounded on both sides so it can only match a
 * whole CSS identifier. That boundary is load-bearing rather than cosmetic:
 * without it `var(--nw-navy)` yielded the token `navy`, `parseCssColor` turned
 * it into HTML navy `#000080`, and the extracted palette was a colour the site
 * never renders. `navy` in `color: navy` is a colour; `navy` inside
 * `--nw-navy` is part of a name. `-` is excluded on both sides for exactly
 * that reason, since it is a legal CSS identifier character.
 *
 * @param {string} value
 * @returns {ParsedColor[]}
 */
export function colorTokensIn(value) {
  /** @type {ParsedColor[]} */
  const out = [];
  const raw = String(value);
  const direct = parseCssColor(raw);
  if (direct) return [direct];
  const text = maskCssLiterals(raw);
  // Functional and hex forms first; they cannot be confused with identifiers.
  const fnRe = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])|(?:rgba?|hsla?|hwb|oklch|oklab)\([^()]*(?:\([^()]*\)[^()]*)*\)/g;
  let m;
  /** @type {[number, number][]} */
  const consumed = [];
  while ((m = fnRe.exec(text)) !== null) {
    consumed.push([m.index, m.index + m[0].length]);
    const parsed = parseCssColor(m[0]);
    if (parsed) out.push(parsed);
  }
  // Then whole-identifier keywords, skipping anything already consumed.
  // `(^|[^\w-])` rather than a lookbehind: lookbehind is ES2018 and the studio
  // has to run in whatever browser the seller has open.
  const wordRe = /(^|[^\w-])([a-zA-Z]{3,20})(?![\w-])/g;
  while ((m = wordRe.exec(text)) !== null) {
    const start = m.index + m[1].length;
    if (consumed.some(([a, b]) => start >= a && start < b)) continue;
    const parsed = parseCssColor(m[2]);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** True for a CSS custom property name. */
export function isCustomProperty(prop) {
  return typeof prop === 'string' && prop.startsWith('--');
}

/**
 * Build the custom-property environment from a declaration list.
 *
 * A modern site keeps its palette in `:root { --brand-navy: #0F2A47 }` and
 * paints with `var(--brand-navy)`. Ignoring those declarations throws away the
 * only place the real colours appear.
 *
 * Precedence, in the order CSS itself would resolve it as far as a static
 * scanner can tell: an unconditional declaration beats one inside an at-rule
 * (a `prefers-color-scheme: dark` override must not become the default
 * palette), and within a tier the last declaration in source order wins, which
 * is CSS's own rule at equal specificity.
 *
 * @param {readonly CssDeclaration[]} declarations
 * @returns {Map<string, {value: string, conditional: boolean, selector: string}>}
 */
export function buildCustomPropertyEnv(declarations) {
  /** @type {Map<string, {value: string, conditional: boolean, selector: string}>} */
  const env = new Map();
  for (const d of declarations || []) {
    if (!isCustomProperty(d.prop)) continue;
    const conditional = d.atRules.length > 0;
    const prev = env.get(d.prop);
    if (prev && prev.conditional === false && conditional === true) continue;
    env.set(d.prop, { value: d.value, conditional, selector: d.selector });
  }
  return env;
}

/** Index of the parenthesis matching the one at `open`, or −1. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split `--name, fallback` at its first top-level comma. */
function splitVarArgs(body) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      return { name: body.slice(0, i).trim(), fallback: body.slice(i + 1).trim() };
    }
  }
  return { name: body.trim(), fallback: null };
}

/** Nesting depth of `var()` substitution before a value is declared unresolvable. */
export const MAX_VAR_DEPTH = 16;

/**
 * Index of the next `var(` that begins a whole identifier, at or after `from`.
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function indexOfVar(text, from) {
  const lower = text.toLowerCase();
  for (let i = lower.indexOf('var(', from); i >= 0; i = lower.indexOf('var(', i + 1)) {
    const before = i === 0 ? '' : text[i - 1];
    if (before === '' || !/[\w-]/.test(before)) return i;
  }
  return -1;
}

/**
 * @param {string} text
 * @param {Map<string, {value: string}>} env
 * @param {Set<string>} visited names currently being expanded on this branch
 * @param {((name: string) => void)|undefined} onReference
 * @param {number} depth
 * @returns {string|null}
 */
function expandVars(text, env, visited, onReference, depth) {
  if (depth > MAX_VAR_DEPTH) return null;
  let out = '';
  let i = 0;
  for (;;) {
    const at = indexOfVar(text, i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at);
    const close = matchParen(text, at + 3);
    if (close < 0) return null;
    const { name, fallback } = splitVarArgs(text.slice(at + 4, close));
    if (!name.startsWith('--')) return null;
    if (onReference) onReference(name);
    const entry = env && typeof env.get === 'function' ? env.get(name) : undefined;
    /** @type {string|null} */
    let replacement = null;
    // `visited` is per branch, not global: a value may legitimately use the
    // same token twice (`linear-gradient(var(--a), var(--a))`), and only a
    // token that expands into itself is a cycle.
    if (entry && !visited.has(name)) {
      const branch = new Set(visited);
      branch.add(name);
      replacement = expandVars(entry.value, env, branch, onReference, depth + 1);
    }
    if (replacement === null && fallback !== null) {
      replacement = expandVars(fallback, env, visited, onReference, depth + 1);
    }
    if (replacement === null) return null;
    out += replacement;
    i = close + 1;
  }
}

/**
 * Substitute `var()` references against a custom-property environment.
 *
 * Returns `null` when a reference cannot be resolved and carries no fallback —
 * which is what CSS does with it (the declaration becomes invalid at
 * computed-value time), and the only honest answer here: an unresolved
 * variable is a colour we cannot see, not a colour we may invent.
 *
 * @param {string} value
 * @param {Map<string, {value: string}>} env
 * @param {{onReference?: (name: string) => void, maxDepth?: number}} [options]
 * @returns {string|null}
 */
export function resolveCssVars(value, env, options = {}) {
  return expandVars(String(value), env, new Set(), options.onReference, 0);
}


/**
 * @typedef {object} CssDeclaration
 * @property {string} selector the selector list the declaration sits under (`''` at top level)
 * @property {string} prop lower-case property name
 * @property {string} value raw value text
 * @property {string[]} atRules enclosing at-rule preludes, outermost first
 */

/**
 * Walk a stylesheet and yield every declaration with its selector context.
 *
 * This is a scanner, not a parser: it tracks brace depth and the prelude that
 * opened each block, which is all the area model needs and is robust against
 * the malformed CSS real sites ship. Declarations inside `@media`,
 * `@supports` and `@layer` are kept (they paint); declarations inside
 * `@keyframes` and `@font-face` are kept but tagged by their at-rule so the
 * collector can drop them.
 *
 * @param {string} cssText
 * @returns {CssDeclaration[]}
 */
export function scanCssDeclarations(cssText) {
  const css = stripCssComments(cssText);
  /** @type {CssDeclaration[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [];
  let buf = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      flush(buf, stack, out);
      buf = '';
      stack.pop();
    } else if (ch === ';') {
      flush(buf, stack, out);
      buf = '';
    } else {
      buf += ch;
    }
  }
  flush(buf, stack, out);
  return out;
}

/**
 * @param {string} text
 * @param {string[]} stack
 * @param {CssDeclaration[]} out
 */
function flush(text, stack, out) {
  const decl = text.trim();
  if (decl === '' || stack.length === 0) return;
  const idx = decl.indexOf(':');
  if (idx <= 0) return;
  const prop = decl.slice(0, idx).trim().toLowerCase();
  const value = decl.slice(idx + 1).trim();
  if (prop === '' || value === '') return;
  if (!/^[-a-z0-9]+$/.test(prop)) return;
  const atRules = stack.filter((s) => s.startsWith('@'));
  const selector = stack.filter((s) => !s.startsWith('@')).join(' ');
  out.push({ selector, prop, value, atRules });
}
