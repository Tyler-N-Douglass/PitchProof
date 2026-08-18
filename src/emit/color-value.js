/**
 * CSS colour values, resolved to sRGB, and WCAG 2.1 contrast.
 *
 * §18.1 makes the provenance label's legibility an enforced code path: the
 * label "cannot be styled to invisibility", which means the emitter has to
 * compute the label's actual foreground and background from the final
 * stylesheet and check the ratio. That needs a colour parser that understands
 * what a real stylesheet can say, including the forms an attacker would reach
 * for — `#fff` over `#ffffff`, `rgba(0,0,0,0)`, `oklch(1 0 0)`,
 * `color-mix(in srgb, …)` and the named colours.
 *
 * This is deliberately independent of `src/brand/color.js` (L4). The provenance
 * law is severity 1 with no override, and a law is stronger when its arithmetic
 * is not shared with the subsystem whose output it is judging: if the brand
 * pipeline ever produced a wrong contrast number, an emitter that reused the
 * same function would agree with it. The WCAG formulas are pinned to the W3C
 * worked examples in `test/emit/color-value.test.mjs`.
 *
 * @module emit/color-value
 */

/** @typedef {{r: number, g: number, b: number, a: number}} Rgba  r,g,b 0..255; a 0..1 */

/** The CSS named colours (CSS Color Level 4), as packed 24-bit hex. */
export const NAMED_COLORS = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
  deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
  dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
  fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f,
  grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
  lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32,
  linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
  midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
  navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000,
  olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093,
  papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb,
  plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399,
  red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513,
  salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee,
  sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
  slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f,
  steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8,
  tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3,
  white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32,
  // System-ish keywords a stylesheet may still use. Values are the common
  // rendering; they are only used to decide whether text is legible.
  canvas: 0xffffff, canvastext: 0x000000, buttonface: 0xefefef, buttontext: 0x000000,
  field: 0xffffff, fieldtext: 0x000000, linktext: 0x0000ee, visitedtext: 0x551a8b,
  highlight: 0x0078d7, highlighttext: 0xffffff, graytext: 0x6d6d6d, mark: 0xffff00,
  marktext: 0x000000, accentcolor: 0x0078d7, accentcolortext: 0xffffff,
};

/** Fully transparent, the value `transparent` and an unparseable colour share. */
export const TRANSPARENT = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

/**
 * Split a comma/space separated function argument list, respecting nesting.
 * @param {string} s
 * @returns {string[]}
 */
export function splitArgs(s) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if ((ch === ',' || ch === '/') && depth === 0) { out.push(cur.trim()); out.push(ch); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((x) => x !== '');
}

/**
 * Like `splitArgs`, but whitespace also separates — the modern colour syntax
 * (`rgb(1 2 3 / 50%)`) has no commas between components.
 * @param {string} s
 * @returns {string[]}
 */
export function splitComponents(s) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const ch of s) {
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (depth === 0 && (ch === ',' || ch === '/')) { flush(); out.push(ch); continue; }
    if (depth === 0 && /\s/.test(ch)) { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}

/**
 * Numbers in a colour function, with `%` and `none` handled.
 * @param {string} token
 * @param {number} scale  what 100% means
 * @returns {number}
 */
function numberOf(token, scale) {
  if (token === undefined || token === null) return 0;
  const t = String(token).trim().toLowerCase();
  if (t === 'none') return 0;
  if (t.endsWith('%')) return (parseFloat(t) / 100) * scale;
  if (t.endsWith('deg')) return parseFloat(t);
  if (t.endsWith('turn')) return parseFloat(t) * 360;
  if (t.endsWith('rad')) return (parseFloat(t) * 180) / Math.PI;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : 0;
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Parse a CSS colour value. Returns null when the value is not a colour at all
 * (which the caller treats as "not specified"), and `TRANSPARENT` for values
 * that are colours but paint nothing.
 *
 * @param {string} input
 * @returns {Rgba|null}
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim().replace(/\s*!important\s*$/i, '').trim();
  if (!v) return null;
  const lower = v.toLowerCase();

  if (lower === 'transparent') return { ...TRANSPARENT };
  if (lower === 'currentcolor' || lower === 'inherit' || lower === 'initial' || lower === 'unset' || lower === 'revert') return null;

  if (v[0] === '#') {
    const hex = v.slice(1);
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 };
    }
    if (/^[0-9a-f]{4}$/i.test(hex)) {
      return {
        r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16),
        a: parseInt(hex[3] + hex[3], 16) / 255,
      };
    }
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
    }
    if (/^[0-9a-f]{8}$/i.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }

  const fn = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(v);
  if (fn) {
    const name = fn[1].toLowerCase();
    const args = splitComponents(fn[2]).filter((t) => t !== ',');
    const slash = args.indexOf('/');
    const alphaToken = slash >= 0 ? args[slash + 1] : (args.length > 3 ? args[3] : null);
    const parts = (slash >= 0 ? args.slice(0, slash) : args.slice(0, 3));
    const alpha = alphaToken === null || alphaToken === undefined ? 1 : clamp01(numberOf(alphaToken, 1));

    if (name === 'rgb' || name === 'rgba') {
      return { r: clamp255(numberOf(parts[0], 255)), g: clamp255(numberOf(parts[1], 255)), b: clamp255(numberOf(parts[2], 255)), a: alpha };
    }
    if (name === 'hsl' || name === 'hsla') {
      return { ...hslToRgb(numberOf(parts[0], 360), clamp01(numberOf(parts[1], 1)), clamp01(numberOf(parts[2], 1))), a: alpha };
    }
    if (name === 'hwb') {
      const [r, g, b] = hwbToRgb(numberOf(parts[0], 360), clamp01(numberOf(parts[1], 1)), clamp01(numberOf(parts[2], 1)));
      return { r, g, b, a: alpha };
    }
    if (name === 'oklch') {
      const [r, g, b] = oklchToSrgb(clamp01(numberOf(parts[0], 1)), Math.max(0, numberOf(parts[1], 0.4)), numberOf(parts[2], 360));
      return { r, g, b, a: alpha };
    }
    if (name === 'oklab') {
      const [r, g, b] = oklabToSrgb(clamp01(numberOf(parts[0], 1)), numberOf(parts[1], 0.4), numberOf(parts[2], 0.4));
      return { r, g, b, a: alpha };
    }
    if (name === 'color-mix') return parseColorMix(fn[2]);
    if (name === 'color') {
      // color(srgb r g b) — the only space whose numbers need no conversion.
      const space = (args[0] || '').toLowerCase();
      if (space === 'srgb') {
        return { r: clamp255(numberOf(args[1], 1) * 255), g: clamp255(numberOf(args[2], 1) * 255), b: clamp255(numberOf(args[3], 1) * 255), a: alpha };
      }
      return null;
    }
    return null;
  }

  const named = NAMED_COLORS[lower];
  if (named !== undefined) return { r: (named >> 16) & 255, g: (named >> 8) & 255, b: named & 255, a: 1 };
  return null;
}

/**
 * `color-mix(in <space>, A p%, B q%)`. Mixing happens in the named space where
 * we support it and in sRGB otherwise; the residual error is far below what a
 * 4.5:1 threshold can notice, and the runtime stylesheet's only use of it is
 * the overlay scrim.
 * @param {string} inner
 * @returns {Rgba|null}
 */
export function parseColorMix(inner) {
  const parts = splitArgs(inner).filter((t) => t !== ',' && t !== '/');
  if (parts.length < 3) return null;
  const [spaceToken, aToken, bToken] = [parts[0], parts[1], parts[2]];
  if (!/^in\s+/i.test(spaceToken)) return null;
  const readOne = (token) => {
    const m = /^([\s\S]*?)\s+(-?[\d.]+)%$/.exec(token.trim());
    if (m) return { color: parseColor(m[1]), pct: parseFloat(m[2]) / 100 };
    return { color: parseColor(token), pct: null };
  };
  const A = readOne(aToken);
  const B = readOne(bToken);
  if (!A.color || !B.color) return null;
  let pa = A.pct;
  let pb = B.pct;
  if (pa === null && pb === null) { pa = 0.5; pb = 0.5; }
  else if (pa === null) pa = 1 - (pb ?? 0);
  else if (pb === null) pb = 1 - pa;
  const total = (pa ?? 0) + (pb ?? 0);
  if (total <= 0) return null;
  const wa = (pa ?? 0) / total;
  const wb = (pb ?? 0) / total;
  return {
    r: clamp255(A.color.r * wa + B.color.r * wb),
    g: clamp255(A.color.g * wa + B.color.g * wb),
    b: clamp255(A.color.b * wa + B.color.b * wb),
    a: clamp01(A.color.a * wa + B.color.a * wb),
  };
}

/**
 * @param {number} h degrees @param {number} s 0..1 @param {number} l 0..1
 * @returns {{r: number, g: number, b: number}}
 */
export function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) };
}

/**
 * @param {number} h @param {number} w @param {number} b
 * @returns {[number, number, number]}
 */
export function hwbToRgb(h, w, b) {
  if (w + b >= 1) { const g = clamp255((w / (w + b)) * 255); return [g, g, g]; }
  const base = hslToRgb(h, 1, 0.5);
  const mix = (c) => clamp255((c / 255) * (1 - w - b) * 255 + w * 255);
  return [mix(base.r), mix(base.g), mix(base.b)];
}

const srgbFromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * OKLab → sRGB (Björn Ottosson's matrices).
 * @param {number} L @param {number} a @param {number} b
 * @returns {[number, number, number]} 0..255
 */
export function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [clamp255(srgbFromLinear(lr) * 255), clamp255(srgbFromLinear(lg) * 255), clamp255(srgbFromLinear(lb) * 255)];
}

/**
 * @param {number} L @param {number} C @param {number} hDeg
 * @returns {[number, number, number]}
 */
export function oklchToSrgb(L, C, hDeg) {
  const rad = (hDeg * Math.PI) / 180;
  return oklabToSrgb(L, C * Math.cos(rad), C * Math.sin(rad));
}

/**
 * WCAG 2.1 relative luminance, computed exactly as the specification states it.
 * @param {Rgba|{r: number, g: number, b: number}} rgb
 * @returns {number}
 */
export function relativeLuminance(rgb) {
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
}

/**
 * WCAG 2.1 contrast ratio between two opaque colours.
 * @param {Rgba|{r: number, g: number, b: number}} a
 * @param {Rgba|{r: number, g: number, b: number}} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite a possibly-translucent colour over an opaque backdrop.
 * @param {Rgba} src
 * @param {Rgba} backdrop  assumed opaque
 * @returns {Rgba}
 */
export function compositeOver(src, backdrop) {
  const a = clamp01(src.a);
  return {
    r: clamp255(src.r * a + backdrop.r * (1 - a)),
    g: clamp255(src.g * a + backdrop.g * (1 - a)),
    b: clamp255(src.b * a + backdrop.b * (1 - a)),
    a: 1,
  };
}

/**
 * `#rrggbb` for a resolved colour, for legible finding messages.
 * @param {Rgba} c
 * @returns {string}
 */
export function toHex(c) {
  const p = (v) => clamp255(v).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}
