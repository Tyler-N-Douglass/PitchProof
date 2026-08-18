/**
 * Exact colour science for the brand pipeline (§7, §17.1, §22.1).
 *
 * Everything downstream of this file — clustering, role solving, derivation,
 * the `CONTRAST_FAIL` rule, the emitted theme — is only as correct as these
 * functions. §17.1 calls the maths "non-negotiable exactness; this math
 * silently poisons everything downstream if it's off", so every constant here
 * is traceable to a published source and named in a comment:
 *
 *   - sRGB transfer and primaries: IEC 61966-2-1 / CSS Color Module Level 4 §10.
 *   - WCAG relative luminance and contrast: WCAG 2.1 definitions of
 *     "relative luminance" and "contrast ratio".
 *   - OKLab matrices and the XYZ reference table: Björn Ottosson,
 *     "A perceptual color space for image processing" (2020).
 *
 * Two domain conventions hold throughout and are never mixed silently:
 *
 *   - `srgbToLinear` / `linearToSrgb` operate on **0..1** channel values, the
 *     domain the sRGB standard states them in.
 *   - `rgb` triples in every other signature are **0..255** and may be
 *     fractional or out of range; only `rgbToHex` rounds and clamps. Keeping
 *     `oklabToRgb` unrounded is what makes the §17.1 round-trip hold to 1e-6
 *     and what makes `inGamut` able to see an out-of-gamut colour at all.
 *
 * @module brand/oklab
 */

/* ---------------------------------------------------------------------------
 * sRGB transfer function — IEC 61966-2-1
 * ------------------------------------------------------------------------ */

/** Linear-segment cutoff of the sRGB transfer, encoded side. IEC 61966-2-1. */
export const SRGB_LINEAR_BREAK = 0.04045;
/** Linear-segment cutoff, linear side: SRGB_LINEAR_BREAK / SRGB_SLOPE. */
export const SRGB_LINEAR_BREAK_LINEAR = 0.0031308;
/** Slope of the linear segment. IEC 61966-2-1. */
export const SRGB_SLOPE = 12.92;
/** Offset of the power segment. IEC 61966-2-1. */
export const SRGB_OFFSET = 0.055;
/** Exponent of the power segment. IEC 61966-2-1. */
export const SRGB_GAMMA = 2.4;

/**
 * WCAG 2.1 states the relative-luminance cutoff as 0.03928 rather than the
 * 0.04045 of IEC 61966-2-1 (an erratum in the original WCAG text that was never
 * normatively corrected). The two disagree only for encoded values strictly
 * between them, i.e. 8-bit codes in (10.0164, 10.3148) — an empty set, since
 * code 10 is below both cutoffs and code 11 is above both. `relativeLuminance`
 * therefore follows the WCAG text literally and
 * `test/brand/color-reference.test.mjs` asserts the two agree on all 256 codes.
 */
export const WCAG_LINEAR_BREAK = 0.03928;

/** WCAG 2.1 contrast-ratio offset: (L1 + 0.05) / (L2 + 0.05). */
export const WCAG_CONTRAST_OFFSET = 0.05;

/** WCAG 2.1 luminance coefficients for linear sRGB. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/**
 * Sign-preserving power. The sRGB transfer is defined on [0,1], but gamut
 * testing needs to evaluate it on out-of-range values without producing NaN,
 * so both directions are extended as odd functions — the standard convention in
 * CSS Color 4's sample code.
 * @param {number} x
 * @param {number} p
 * @returns {number}
 */
function signedPow(x, p) {
  return x < 0 ? -Math.pow(-x, p) : Math.pow(x, p);
}

/**
 * sRGB encoded value (0..1) to linear-light value.
 * @param {number} c encoded channel, 0..1 (extended outside for gamut work)
 * @returns {number} linear-light channel
 */
export function srgbToLinear(c) {
  const a = Math.abs(c);
  const v = a <= SRGB_LINEAR_BREAK
    ? a / SRGB_SLOPE
    : Math.pow((a + SRGB_OFFSET) / (1 + SRGB_OFFSET), SRGB_GAMMA);
  return c < 0 ? -v : v;
}

/**
 * Linear-light value to sRGB encoded value (0..1).
 * @param {number} c linear-light channel
 * @returns {number} encoded channel, 0..1 (extended outside for gamut work)
 */
export function linearToSrgb(c) {
  const a = Math.abs(c);
  const v = a <= SRGB_LINEAR_BREAK_LINEAR
    ? a * SRGB_SLOPE
    : (1 + SRGB_OFFSET) * Math.pow(a, 1 / SRGB_GAMMA) - SRGB_OFFSET;
  return c < 0 ? -v : v;
}

/* ---------------------------------------------------------------------------
 * Hex and 8-bit RGB
 * ------------------------------------------------------------------------ */

const HEX_RE = /^#?([0-9a-fA-F]{3,8})$/;

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` into 0..255 channels. Alpha
 * is parsed but not returned — compositing happens in the collector, which is
 * the only place that knows what a colour is being composited over.
 * @param {string} hex
 * @returns {[number, number, number]} 0..255
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') throw new TypeError(`hexToRgb: not a string: ${String(hex)}`);
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`hexToRgb: not a hex colour: ${hex}`);
  const body = m[1];
  if (body.length === 3 || body.length === 4) {
    return [
      parseInt(body[0] + body[0], 16),
      parseInt(body[1] + body[1], 16),
      parseInt(body[2] + body[2], 16),
    ];
  }
  if (body.length === 6 || body.length === 8) {
    return [
      parseInt(body.slice(0, 2), 16),
      parseInt(body.slice(2, 4), 16),
      parseInt(body.slice(4, 6), 16),
    ];
  }
  throw new Error(`hexToRgb: not a hex colour: ${hex}`);
}

/**
 * Alpha of a 4- or 8-digit hex colour, 0..1. Returns 1 for the opaque forms.
 * @param {string} hex
 * @returns {number}
 */
export function hexAlpha(hex) {
  const m = HEX_RE.exec(String(hex).trim());
  if (!m) return 1;
  const body = m[1];
  if (body.length === 4) return parseInt(body[3] + body[3], 16) / 255;
  if (body.length === 8) return parseInt(body.slice(6, 8), 16) / 255;
  return 1;
}

/**
 * Round and clamp 0..255 channels to a lower-case `#rrggbb`. This is the only
 * quantisation point in the module; every guarantee the solver makes is checked
 * on the quantised value, so an 8-bit rounding step can never drop a palette
 * below a contrast floor after the fact.
 * @param {readonly number[]} rgb 0..255, fractional and out-of-range allowed
 * @returns {string} `#rrggbb`
 */
export function rgbToHex(rgb) {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = rgb[i];
    if (!Number.isFinite(v)) throw new Error(`rgbToHex: non-finite channel ${i}`);
    const n = Math.min(255, Math.max(0, Math.round(v)));
    out += n.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * True when every channel lies inside 0..255 to within `eps` 8-bit units.
 * @param {readonly number[]} rgb
 * @param {number} [eps]
 * @returns {boolean}
 */
export function rgbInRange(rgb, eps = GAMUT_EPS_8BIT) {
  for (let i = 0; i < 3; i++) {
    const v = rgb[i];
    if (!Number.isFinite(v) || v < -eps || v > 255 + eps) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * OKLab — Björn Ottosson, "A perceptual color space for image processing"
 * ------------------------------------------------------------------------ */

/** Linear sRGB → LMS cone response. Published matrix M1. */
export const LSRGB_TO_LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];

/** LMS (cube-rooted) → OKLab. Published matrix M2. */
export const LMS_TO_OKLAB = [
  [0.2104542553, 0.7936177850, -0.0040720468],
  [1.9779984951, -2.4285922050, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.8086757660],
];

/**
 * Ottosson also publishes rounded inverse matrices. They are convenient but
 * they are *rounded*, and a rounded inverse is not the inverse: composing the
 * published forward and published inverse matrices leaves a residual of about
 * 1e-6, which shows up directly as a 4e-4 error in an 8-bit round trip — an
 * order of magnitude past the 1e-6 §17.1 demands.
 *
 * So the forward matrices above are the normative definition and every inverse
 * is computed from them exactly, by Gauss–Jordan elimination at load. The
 * published inverses are kept below purely so the reference test can assert
 * that the computed inverse agrees with them to their published precision —
 * which makes both sets of published numbers load-bearing instead of one.
 */
export const PUBLISHED_OKLAB_TO_LMS = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.2914855480],
];

export const PUBLISHED_LMS_TO_LSRGB = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.7076147010],
];

export const PUBLISHED_LMS_TO_XYZ = [
  [1.2270138511, -0.5577999807, 0.2812561490],
  [-0.0405801784, 1.1122568696, -0.0716766787],
  [-0.0763812845, -0.4214819784, 1.5861632204],
];

/**
 * Exact 3×3 inverse by Gauss–Jordan elimination with partial pivoting.
 * Deterministic: IEEE-754 double arithmetic in a fixed order.
 * @param {readonly number[][]} m
 * @returns {number[][]}
 */
export function invert3(m) {
  const a = m.map((row, i) => [...row, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-15) throw new Error('invert3: singular matrix');
    if (pivot !== col) { const t = a[pivot]; a[pivot] = a[col]; a[col] = t; }
    const d = a[col][col];
    for (let c = 0; c < 6; c++) a[col][c] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 6; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row) => row.slice(3));
}

/** OKLab → LMS (cube-rooted): the exact inverse of the published M2. */
const OKLAB_TO_LMS = invert3(LMS_TO_OKLAB);

/** LMS → linear sRGB: the exact inverse of the published M1. */
const LMS_TO_LSRGB = invert3(LSRGB_TO_LMS);

/** CIE XYZ (D65) → LMS. Published matrix. */
export const XYZ_TO_LMS = [
  [0.8189330101, 0.3618667424, -0.1288597137],
  [0.0329845436, 0.9293118715, 0.0361456387],
  [0.0482003018, 0.2643662691, 0.6338517070],
];

/** LMS → CIE XYZ (D65): the exact inverse of the published forward matrix. */
const LMS_TO_XYZ = invert3(XYZ_TO_LMS);

/**
 * @param {readonly number[][]} m
 * @param {readonly number[]} v
 * @returns {[number, number, number]}
 */
function apply3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Sign-preserving cube root, so out-of-gamut LMS stays real. */
function cbrtSigned(x) {
  return Math.cbrt(x);
}

/**
 * Linear-light sRGB (0..1) → OKLab.
 * @param {readonly number[]} lrgb
 * @returns {[number, number, number]} [L, a, b]
 */
export function linearRgbToOklab(lrgb) {
  const lms = apply3(LSRGB_TO_LMS, lrgb);
  return apply3(LMS_TO_OKLAB, [cbrtSigned(lms[0]), cbrtSigned(lms[1]), cbrtSigned(lms[2])]);
}

/**
 * OKLab → linear-light sRGB (0..1, may fall outside for out-of-gamut input).
 * @param {readonly number[]} lab
 * @returns {[number, number, number]}
 */
export function oklabToLinearRgb(lab) {
  const p = apply3(OKLAB_TO_LMS, lab);
  return apply3(LMS_TO_LSRGB, [p[0] * p[0] * p[0], p[1] * p[1] * p[1], p[2] * p[2] * p[2]]);
}

/**
 * 8-bit-domain sRGB (0..255) → OKLab.
 * @param {readonly number[]} rgb 0..255
 * @returns {[number, number, number]}
 */
export function rgbToOklab(rgb) {
  return linearRgbToOklab([
    srgbToLinear(rgb[0] / 255),
    srgbToLinear(rgb[1] / 255),
    srgbToLinear(rgb[2] / 255),
  ]);
}

/**
 * OKLab → sRGB in the 0..255 domain, **unrounded and unclamped** so that
 * round-trips are exact and gamut tests are meaningful.
 * @param {readonly number[]} lab
 * @returns {[number, number, number]}
 */
export function oklabToRgb(lab) {
  const l = oklabToLinearRgb(lab);
  return [linearToSrgb(l[0]) * 255, linearToSrgb(l[1]) * 255, linearToSrgb(l[2]) * 255];
}

/**
 * CIE XYZ (D65, Y = 1 for the reference white) → OKLab. Present so §17.1 can
 * assert against Ottosson's published XYZ test table directly rather than
 * through an sRGB conversion that would fold in a second set of constants.
 * @param {readonly number[]} xyz
 * @returns {[number, number, number]}
 */
export function xyzToOklab(xyz) {
  const lms = apply3(XYZ_TO_LMS, xyz);
  return apply3(LMS_TO_OKLAB, [cbrtSigned(lms[0]), cbrtSigned(lms[1]), cbrtSigned(lms[2])]);
}

/**
 * OKLab → CIE XYZ (D65).
 * @param {readonly number[]} lab
 * @returns {[number, number, number]}
 */
export function oklabToXyz(lab) {
  const p = apply3(OKLAB_TO_LMS, lab);
  return apply3(LMS_TO_XYZ, [p[0] * p[0] * p[0], p[1] * p[1] * p[1], p[2] * p[2] * p[2]]);
}

/* ---------------------------------------------------------------------------
 * OKLCH
 * ------------------------------------------------------------------------ */

/**
 * Chroma below which a colour is treated as achromatic and its hue is reported
 * as 0 rather than as the arctangent of two quantisation errors. 1e-9 is far
 * below the 8-bit representable step (the smallest non-zero chroma reachable
 * from an `#rrggbb` value is on the order of 1e-4), so this only ever fires on
 * an exactly neutral colour.
 */
export const ACHROMATIC_EPS = 1e-9;

/**
 * OKLab → OKLCH. Hue is in degrees, 0..360, measured from +a toward +b.
 * @param {readonly number[]} lab
 * @returns {[number, number, number]} [L, C, H]
 */
export function oklabToOklch(lab) {
  const c = Math.hypot(lab[1], lab[2]);
  if (c < ACHROMATIC_EPS) return [lab[0], 0, 0];
  let h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
  if (h < 0) h += 360;
  return [lab[0], c, h];
}

/**
 * OKLCH → OKLab.
 * @param {readonly number[]} lch
 * @returns {[number, number, number]}
 */
export function oklchToOklab(lch) {
  const rad = lch[2] * Math.PI / 180;
  return [lch[0], lch[1] * Math.cos(rad), lch[1] * Math.sin(rad)];
}

/**
 * `#rrggbb` → OKLCH.
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToOklch(hex) {
  return oklabToOklch(rgbToOklab(hexToRgb(hex)));
}

/**
 * OKLCH → `#rrggbb`. Chroma is clamped into the sRGB gamut first, so the
 * returned colour keeps the requested hue instead of being hue-shifted by a
 * per-channel clip. An in-gamut input round-trips unchanged.
 * @param {readonly number[]} lch
 * @returns {string}
 */
export function oklchToHex(lch) {
  return rgbToHex(oklabToRgb(oklchToOklab(clampChromaToGamut(lch))));
}

/**
 * `#rrggbb` → OKLab.
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToOklab(hex) {
  return rgbToOklab(hexToRgb(hex));
}

/**
 * OKLab → `#rrggbb`, chroma-clamped like `oklchToHex`.
 * @param {readonly number[]} lab
 * @returns {string}
 */
export function oklabToHex(lab) {
  return oklchToHex(oklabToOklch(lab));
}

/* ---------------------------------------------------------------------------
 * WCAG 2.1 relative luminance and contrast
 * ------------------------------------------------------------------------ */

/**
 * WCAG 2.1 relative luminance of an 0..255 sRGB triple, stated exactly as the
 * specification states it: linearise each channel with the
 * `((c + 0.055) / 1.055) ^ 2.4` transfer, then take
 * `0.2126 R + 0.7152 G + 0.0722 B`.
 * @param {readonly number[]} rgb 0..255
 * @returns {number} 0..1
 */
export function relativeLuminance(rgb) {
  const f = (v) => {
    const c = v / 255;
    return c <= WCAG_LINEAR_BREAK ? c / SRGB_SLOPE : Math.pow((c + SRGB_OFFSET) / (1 + SRGB_OFFSET), SRGB_GAMMA);
  };
  return LUMA_R * f(rgb[0]) + LUMA_G * f(rgb[1]) + LUMA_B * f(rgb[2]);
}

/**
 * WCAG 2.1 relative luminance of a hex colour.
 * @param {string} hex
 * @returns {number}
 */
export function luminanceOfHex(hex) {
  return relativeLuminance(hexToRgb(hex));
}

/**
 * WCAG 2.1 contrast ratio from two relative luminances.
 * @param {number} y1
 * @param {number} y2
 * @returns {number} 1..21
 */
export function contrastFromLuminance(y1, y2) {
  const hi = Math.max(y1, y2);
  const lo = Math.min(y1, y2);
  return (hi + WCAG_CONTRAST_OFFSET) / (lo + WCAG_CONTRAST_OFFSET);
}

/**
 * WCAG 2.1 contrast ratio between two hex colours. Symmetric by construction.
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
export function contrastRatio(hexA, hexB) {
  return contrastFromLuminance(luminanceOfHex(hexA), luminanceOfHex(hexB));
}

/**
 * WCAG 2.1 contrast ratio between two 0..255 triples.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 * @returns {number}
 */
export function contrastRatioRgb(a, b) {
  return contrastFromLuminance(relativeLuminance(a), relativeLuminance(b));
}

/**
 * The maximum contrast ratio, 21:1, reached only by pure black against pure
 * white: (1 + 0.05) / (0 + 0.05).
 */
export const MAX_CONTRAST = (1 + WCAG_CONTRAST_OFFSET) / WCAG_CONTRAST_OFFSET;

/**
 * The contrast ratio every colour is guaranteed to reach against *either* black
 * or white. Because `contrast(c, white) * contrast(c, black) = 21` for every
 * colour, the larger of the two is at least `sqrt(21) = 4.5826…`, which is
 * strictly above the 4.5:1 body-text floor. This is why derivation can always
 * satisfy the §7 constraint and why `solveRoles` throwing means the *input*
 * was impossible, never the palette.
 */
export const GUARANTEED_CONTRAST = Math.sqrt(MAX_CONTRAST);

/* ---------------------------------------------------------------------------
 * Gamut
 * ------------------------------------------------------------------------ */

/**
 * Gamut tolerance in 8-bit units, chosen to sit between two measured
 * quantities and to be justified by both:
 *
 *  - **Above** ≈3e-5, the intrinsic mismatch between the OKLab neutral axis
 *    and the sRGB grey axis. The published matrices do not put `#ffffff`
 *    exactly on `a = b = 0` (it lands at b ≈ 3.7e-8), so a pure neutral at
 *    white's own lightness overshoots the blue channel by about 2.7e-5 8-bit
 *    units. A tighter tolerance would report white itself as out of gamut.
 *  - **Far below** 0.5, the tolerance at which a colour would round to a
 *    different 8-bit code. A looser tolerance is a real defect: at 1/512 the
 *    predicate calls a visibly chromatic colour "in gamut at L = 0" purely
 *    because every channel still rounds to zero.
 *
 * The OKLab ↔ sRGB round trip itself is accurate to ≈3e-12 8-bit units, so
 * conversion noise is nowhere near either bound.
 */
export const GAMUT_EPS_8BIT = 1e-4;

/**
 * The largest OKLCH chroma any sRGB colour reaches is that of pure blue
 * (`#0000FF`), ≈0.3225. 0.4 is a strict upper bound for the binary search and
 * is asserted to be one in `test/brand/color-reference.test.mjs`.
 */
export const MAX_SRGB_CHROMA_BOUND = 0.4;

/** Binary-search iterations for chroma clamping: 0.4 / 2^40 ≈ 4e-13. */
const GAMUT_SEARCH_ITERS = 40;

/**
 * True when an OKLCH triple is representable in sRGB.
 * @param {readonly number[]} lch
 * @returns {boolean}
 */
export function inGamut(lch) {
  if (!Number.isFinite(lch[0]) || !Number.isFinite(lch[1]) || !Number.isFinite(lch[2])) return false;
  return rgbInRange(oklabToRgb(oklchToOklab(lch)));
}

/**
 * The largest chroma representable in sRGB at a given lightness and hue, by
 * binary search. The sRGB solid is star-shaped about the neutral axis in
 * OKLCH — every ray from the axis crosses the boundary exactly once — so the
 * in-gamut predicate is monotone in chroma and bisection is exact.
 * @param {number} L 0..1
 * @param {number} H degrees
 * @returns {number}
 */
export function maxChromaAt(L, H) {
  if (!inGamut([L, 0, H])) return 0;
  if (inGamut([L, MAX_SRGB_CHROMA_BOUND, H])) return MAX_SRGB_CHROMA_BOUND;
  let lo = 0;
  let hi = MAX_SRGB_CHROMA_BOUND;
  for (let i = 0; i < GAMUT_SEARCH_ITERS; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut([L, mid, H])) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * The OKLab lightness of pure sRGB white. It is *not* exactly 1: the published
 * matrices put `#ffffff` at L = 0.99999999347…, so an OKLCH colour at L = 1 is
 * a hair above the top of the sRGB solid and is correctly reported out of
 * gamut. Callers legitimately walk lightness up to 1, so the clamp maps that
 * end of the range onto white rather than off the end of the gamut.
 */
export const SRGB_WHITE_L = linearRgbToOklab([1, 1, 1])[0];
/** The OKLab lightness of pure sRGB black, exactly 0. */
export const SRGB_BLACK_L = linearRgbToOklab([0, 0, 0])[0];

/**
 * Clamp chroma into the sRGB gamut, holding lightness and hue. Lightness
 * outside the achievable neutral range is clamped first: no chroma can rescue
 * it, and returning a silently NaN colour would be worse than returning the
 * nearest neutral.
 * @param {readonly number[]} lch
 * @returns {[number, number, number]}
 */
export function clampChromaToGamut(lch) {
  const L = Math.min(SRGB_WHITE_L, Math.max(SRGB_BLACK_L, lch[0]));
  const H = ((lch[2] % 360) + 360) % 360;
  const C = Math.max(0, lch[1]);
  if (C === 0) return [L, 0, H];
  if (inGamut([L, C, H])) return [L, C, H];
  return [L, Math.min(C, maxChromaAt(L, H)), H];
}

/* ---------------------------------------------------------------------------
 * Perceptual distances
 * ------------------------------------------------------------------------ */

/**
 * Euclidean distance in OKLab — the metric OKLab was fitted to make meaningful,
 * and therefore the metric the k-means in `cluster.js` uses.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 * @returns {number}
 */
export function deltaEok(a, b) {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Shortest angular distance between two hues, 0..180 degrees.
 * @param {number} h1
 * @param {number} h2
 * @returns {number}
 */
export function hueDistance(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Circular mean of hues weighted by chroma and sample weight. Averaging hue
 * arithmetically wraps wrongly at 0/360; this does not.
 * @param {readonly {h: number, w: number}[]} entries
 * @returns {number} degrees, 0..360
 */
export function meanHue(entries) {
  let x = 0;
  let y = 0;
  for (const e of entries) {
    const r = e.h * Math.PI / 180;
    x += Math.cos(r) * e.w;
    y += Math.sin(r) * e.w;
  }
  if (Math.abs(x) < ACHROMATIC_EPS && Math.abs(y) < ACHROMATIC_EPS) return 0;
  let h = Math.atan2(y, x) * 180 / Math.PI;
  if (h < 0) h += 360;
  return h;
}

/* ---------------------------------------------------------------------------
 * Hue anchors, computed rather than chosen
 * ------------------------------------------------------------------------ */

/**
 * The OKLCH hues of the sRGB primaries and secondaries. The semantic roles
 * (`success`, `warning`, `danger`) need canonical hues; taking them from the
 * sRGB primaries themselves means no number here was picked by eye.
 */
export const SRGB_HUES = {
  red: hexToOklch('#ff0000')[2],
  yellow: hexToOklch('#ffff00')[2],
  green: hexToOklch('#00ff00')[2],
  cyan: hexToOklch('#00ffff')[2],
  blue: hexToOklch('#0000ff')[2],
  magenta: hexToOklch('#ff00ff')[2],
};
