/**
 * Colour collection, the area model, and clustering in OKLab (§7).
 *
 * §7 is explicit that clusters are weighted **by rendered area, not by
 * occurrence count** — "a color used once across a full-bleed hero matters more
 * than a border used two hundred times". That sentence is the whole design of
 * this file, so the area model is written down rather than implied:
 *
 * ## The area model
 *
 * Every sample carries a weight in **square CSS pixels of painted area**, which
 * is a quantity that can be compared across properties and across elements.
 *
 *   | Source                | Painted area of one sample                        |
 *   |-----------------------|---------------------------------------------------|
 *   | fill (`background`)   | `w · h · alpha` — a box paints its whole border box |
 *   | line (`border-color`) | `2(w + h) · borderWidth · alpha` — the ring only    |
 *   | text (`color`)        | `advance · xHeight · INK_DUTY_CYCLE · alpha`        |
 *   | image / logo pixel    | one pixel of the rendered image, times its alpha    |
 *
 * Text is the one that has to be modelled rather than measured. A text run does
 * not paint its line box; it paints glyph strokes inside the x-height band. The
 * band is `advanceWidth · xHeight`, and the fraction of that band that is
 * actually inked is `INK_DUTY_CYCLE`, derived below from published Helvetica
 * metrics rather than chosen.
 *
 * ## Sources that have no geometry
 *
 * Raw CSS gives declarations with no layout. Rather than pretend, the collector
 * substitutes an explicitly *assumed* footprint per property class (a page
 * ground gets the reference viewport, an ordinary block gets one card of an
 * assumed 3×4 card grid, a text run gets a 60-character measure over three
 * lines) and marks the sample `estimated`. Estimated samples are still ordered
 * correctly relative to one another, which is all a source-normalised weight
 * needs, and `confidence.js` prices the estimation.
 *
 * ## Combining sources
 *
 * Areas are commensurable *within* a source and not across them: a hero
 * screenshot's pixel count and a stylesheet's assumed footprints are different
 * units. So each source is normalised to sum to one, then combined by an
 * evidential weight (`SOURCE_WEIGHTS`) that ranks how directly the source
 * reports what the browser actually painted. Area ordering therefore holds
 * exactly where it is meaningful, and never pretends to hold where it is not.
 *
 * @module brand/cluster
 */

import { BREAKPOINTS } from '../core/contracts.js';
import { Pcg32, DEFAULT_SEED, SeedBook } from '../core/prng.js';
import { AFM_TABLES, metricsFor, measureText, UNITS_PER_EM } from '../core/text-metrics.js';
import { rgbToOklab, oklabToOklch, rgbToHex, deltaEok, clampChromaToGamut, oklchToOklab, oklabToRgb } from './oklab.js';
import { parseCssColor, colorTokensIn, scanCssDeclarations, compositeOver } from './color-css.js';

/* ---------------------------------------------------------------------------
 * Area-model constants — every one traceable
 * ------------------------------------------------------------------------ */

/** The largest breakpoint (`lg`, 1600×900) is the reference viewport for assumed footprints. */
const LG = BREAKPOINTS[BREAKPOINTS.length - 1];
/** Reference viewport area in CSS px², from `core/contracts.js` BREAKPOINTS. */
export const REFERENCE_VIEWPORT_AREA = LG.width * LG.height;

/**
 * Adobe's Core-14 Helvetica AFM header declares `StdVW 88` — the standard
 * vertical stem width, in units of 1/1000 em. A lower-case `n` is two such
 * stems inside an advance of 556 (the AFM advance width for `n`, which
 * `core/text-metrics` carries), so the inked fraction of the x-height band is
 * `2 · 88 / 556 ≈ 0.3165`. That is the duty cycle used to convert a text run's
 * band area into painted area.
 */
export const HELVETICA_STD_VW = 88;
const HELVETICA_N_ADVANCE = AFM_TABLES.Helvetica.widths['n'.charCodeAt(0) - 32];
export const INK_DUTY_CYCLE = (2 * HELVETICA_STD_VW) / HELVETICA_N_ADVANCE;

/** CSS initial `font-size: medium` computes to 16px in every major engine. */
export const ASSUMED_FONT_SIZE_PX = 16;
/**
 * `line-height: normal` is font-dependent; `core/text-metrics` uses 1.2 as its
 * default unitless line height, and this module follows it so that a line count
 * derived here matches one derived there.
 */
export const ASSUMED_LINE_HEIGHT = 1.2;
/**
 * A declared border colour with no measured width is assumed to be a `thin`
 * border, which computes to 1px. `thin` rather than the CSS initial `medium`
 * (3px) because it is the least generous assumption available: it cannot
 * inflate a border's share of the palette.
 */
export const ASSUMED_BORDER_PX = 1;
/**
 * The classic measure for continuous text is 45–75 characters per line; 60 is
 * its midpoint. Three lines is the shortest run that still reads as a
 * paragraph rather than a label.
 */
export const ASSUMED_TEXT_CHARS = 60;
export const ASSUMED_TEXT_LINES = 3;
/**
 * A block-level fill with no geometry is assumed to occupy one cell of a 3×4
 * card grid over the reference viewport — the layout an enterprise marketing
 * page uses for its card decks, and the smallest common full-width block.
 */
export const ASSUMED_CARD_FRACTION = 1 / 12;

/**
 * Evidential weight per source, applied after each source's own areas have been
 * normalised. The ordering is the justification: computed styles are what the
 * browser actually painted; hero imagery is real painted pixels but carries
 * photographic content that is not brand palette; a logo is the brand's own
 * declaration of its colours but occupies almost no area; raw CSS is declared
 * intent with an assumed geometry. Ratio 4.5 : 2.5 : 2 : 1.
 */
export const SOURCE_WEIGHTS = { computed: 0.45, image: 0.25, logo: 0.20, css: 0.10 };

/** Property classes. A property not listed here contributes no sample. */
const FILL_PROPS = new Set([
  'background', 'background-color', 'background-image', 'fill',
]);
const TEXT_PROPS = new Set([
  'color', '-webkit-text-fill-color',
]);
const LINE_PROPS = new Set([
  'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
  'border-left-color', 'border-block-color', 'border-inline-color', 'outline-color',
  'stroke', 'text-decoration-color', 'column-rule-color', 'caret-color', 'accent-color',
]);

/**
 * At-rules whose declarations never paint a surface the reader sees as brand
 * colour: keyframes are transient, font-face carries no colour, page is print.
 */
const NON_PAINTING_AT_RULES = /^@(keyframes|-webkit-keyframes|font-face|page|counter-style|property)\b/;

/** Selectors that address the page ground rather than a block inside it. */
const PAGE_GROUND_RE = /(^|[\s,>+~])(html|body|:root)\b/;

/**
 * @typedef {object} ColorSample
 * @property {[number, number, number]} rgb 0..255, already composited
 * @property {string} hex
 * @property {[number, number, number]} lab OKLab
 * @property {number} area painted area in CSS px² (or pixels, for image sources)
 * @property {number} weight normalised weight; set by `normalizeSampleWeights`
 * @property {number} observations how many raw observations this sample stands
 *   for — one per declaration for style sources, the pixel count of the bin for
 *   image sources. Area drives ranking; this drives the sample-size half of
 *   confidence, and after histogram binning the two are no longer the same
 *   number.
 * @property {'computed'|'css'|'image'|'logo'} origin
 * @property {string} prop the property or pseudo-property the colour came from
 * @property {boolean} estimated true when the footprint was assumed, not measured
 */

/**
 * @param {readonly number[]} rgb
 * @param {number} area
 * @param {ColorSample['origin']} origin
 * @param {string} prop
 * @param {boolean} estimated
 * @returns {ColorSample}
 */
function makeSample(rgb, area, origin, prop, estimated, observations = 1) {
  const lab = rgbToOklab(rgb);
  return {
    rgb: /** @type {[number, number, number]} */ ([rgb[0], rgb[1], rgb[2]]),
    hex: rgbToHex(rgb),
    lab,
    area,
    weight: 0,
    observations,
    origin,
    prop,
    estimated,
  };
}

/* ---------------------------------------------------------------------------
 * Collection — computed styles
 * ------------------------------------------------------------------------ */

/**
 * Normalise a style key to its kebab-case CSS name, so a collector can be fed
 * either a `CSSStyleDeclaration`-shaped object or a camelCase plain object.
 * @param {string} key
 * @returns {string}
 */
function kebab(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/^-(webkit|moz|ms)-/i, (s) => s.toLowerCase()).toLowerCase();
}

/**
 * Painted area of a text run inside a box of the given size.
 * @param {number} w
 * @param {number} h
 * @param {{text?: string, fontSizePx?: number, fontFamily?: string, lineHeight?: number}} info
 * @returns {number} px²
 */
export function textInkArea(w, h, info) {
  const fontSizePx = Number.isFinite(info.fontSizePx) && info.fontSizePx > 0 ? info.fontSizePx : ASSUMED_FONT_SIZE_PX;
  const family = info.fontFamily || 'Helvetica';
  const metrics = metricsFor(family);
  const xHeightPx = metrics.xHeight / UNITS_PER_EM * fontSizePx;
  const lineHeightPx = fontSizePx * (Number.isFinite(info.lineHeight) && info.lineHeight > 0 ? info.lineHeight : ASSUMED_LINE_HEIGHT);
  if (typeof info.text === 'string' && info.text.trim() !== '') {
    // Real text: the total advance is measured through the shared service, so
    // this agrees with every other measurement in the product (§5, API Part 1).
    const advance = measureText(info.text, { family, fontSizePx });
    return advance * xHeightPx * INK_DUTY_CYCLE;
  }
  // No text given: assume the box is full of lines of text.
  const lines = Math.max(1, Math.round((h || lineHeightPx) / lineHeightPx));
  return Math.max(0, w) * lines * xHeightPx * INK_DUTY_CYCLE;
}

/**
 * Collect samples from rendered elements. Each entry is one element with the
 * styles the browser computed for it and the size the browser gave it.
 *
 * @param {readonly {
 *   styles?: Record<string, string>, style?: Record<string, string>,
 *   rect?: {w?: number, h?: number, width?: number, height?: number},
 *   text?: string, fontSizePx?: number, fontFamily?: string, lineHeight?: number,
 *   borderWidthPx?: number
 * }[]} entries
 * @param {{backdrop?: readonly number[]}} [options]
 * @returns {ColorSample[]}
 */
export function collectFromComputedStyles(entries, options = {}) {
  const backdrop = options.backdrop || [255, 255, 255];
  /** @type {ColorSample[]} */
  const out = [];
  for (const entry of entries || []) {
    const styles = entry.styles || entry.style || {};
    const rect = entry.rect || {};
    const w = Number(rect.w ?? rect.width ?? 0);
    const h = Number(rect.h ?? rect.height ?? 0);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const borderWidthPx = Number.isFinite(entry.borderWidthPx) && entry.borderWidthPx > 0
      ? entry.borderWidthPx : ASSUMED_BORDER_PX;
    for (const [rawKey, rawValue] of Object.entries(styles)) {
      const prop = kebab(rawKey);
      const tokens = colorTokensIn(String(rawValue));
      if (tokens.length === 0) continue;
      /** @type {number} */
      let base;
      if (FILL_PROPS.has(prop)) base = w * h;
      else if (LINE_PROPS.has(prop)) base = 2 * (w + h) * borderWidthPx;
      else if (TEXT_PROPS.has(prop)) {
        base = textInkArea(w, h, entry);
      } else continue;
      // A gradient's stops share the fill.
      const share = base / tokens.length;
      for (const token of tokens) {
        if (token.alpha <= 0) continue;
        const rgb = compositeOver(token, backdrop);
        const area = share * token.alpha;
        if (area <= 0) continue;
        out.push(makeSample(rgb, area, 'computed', prop, false));
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Collection — raw CSS
 * ------------------------------------------------------------------------ */

/**
 * Collect samples from raw stylesheet text, using the assumed-footprint model.
 * @param {string|readonly string[]} cssText one stylesheet or several
 * @param {{backdrop?: readonly number[]}} [options]
 * @returns {ColorSample[]}
 */
export function collectFromCss(cssText, options = {}) {
  const backdrop = options.backdrop || [255, 255, 255];
  const sheets = Array.isArray(cssText) ? cssText : [cssText];
  /** @type {ColorSample[]} */
  const out = [];
  for (const sheet of sheets) {
    if (typeof sheet !== 'string' || sheet === '') continue;
    for (const decl of scanCssDeclarations(sheet)) {
      if (decl.atRules.some((a) => NON_PAINTING_AT_RULES.test(a))) continue;
      const prop = decl.prop;
      const tokens = colorTokensIn(decl.value);
      if (tokens.length === 0) continue;
      const isGround = PAGE_GROUND_RE.test(` ${decl.selector}`);
      /** @type {number} */
      let base;
      if (FILL_PROPS.has(prop)) {
        base = isGround ? REFERENCE_VIEWPORT_AREA : REFERENCE_VIEWPORT_AREA * ASSUMED_CARD_FRACTION;
      } else if (LINE_PROPS.has(prop)) {
        const side = Math.sqrt(REFERENCE_VIEWPORT_AREA * ASSUMED_CARD_FRACTION);
        base = 4 * side * ASSUMED_BORDER_PX;
      } else if (TEXT_PROPS.has(prop)) {
        const advance = measureText('n'.repeat(ASSUMED_TEXT_CHARS), { family: 'Helvetica', fontSizePx: ASSUMED_FONT_SIZE_PX });
        const xHeightPx = AFM_TABLES.Helvetica.xHeight / UNITS_PER_EM * ASSUMED_FONT_SIZE_PX;
        base = advance * xHeightPx * INK_DUTY_CYCLE * ASSUMED_TEXT_LINES;
      } else continue;
      const share = base / tokens.length;
      for (const token of tokens) {
        if (token.alpha <= 0) continue;
        const rgb = compositeOver(token, backdrop);
        const area = share * token.alpha;
        if (area <= 0) continue;
        out.push(makeSample(rgb, area, 'css', prop, true));
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Collection — pixels
 * ------------------------------------------------------------------------ */

/**
 * Most bins kept from an image's colour histogram. When an image has more
 * distinct binned colours than this, the lightest bins are dropped — which
 * discards the least painted area, the exact quantity the area model ranks by.
 */
export const MAX_PIXEL_SAMPLES = 4096;

/**
 * Bits per channel used to bin pixels before histogramming: 5 bits gives
 * 32³ = 32,768 bins, the classic uniform pre-quantisation step of a colour
 * quantiser. It costs nothing in accuracy here because each bin reports the
 * **weighted mean of the pixels that fell into it**, not the bin centre, and
 * k-means then refines centroids from those means.
 *
 * Binning replaced an earlier stride-based subsample, which was a real defect:
 * a fixed stride aliases against periodic pixel patterns, and images are full
 * of them. A one-in-four red pattern sampled every fortieth pixel came back
 * 100% red.
 */
export const PIXEL_BIN_BITS = 5;

/**
 * Decode any reasonable pixel container into `{rgb, alpha}` records.
 *
 * Accepts a packed `Uint8Array`/`Uint8ClampedArray` (RGBA when the length is a
 * multiple of four, otherwise RGB), an array of `[r,g,b]` or `[r,g,b,a]`, an
 * array of `#rrggbb` strings, or an array of `{rgb|hex, alpha?, weight?}`.
 *
 * @param {any} pixels
 * @returns {{rgb: number[], alpha: number, weight: number}[]}
 */
export function decodePixels(pixels) {
  /** @type {{rgb: number[], alpha: number, weight: number}[]} */
  const out = [];
  if (!pixels) return out;
  if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray
      || (ArrayBuffer.isView(pixels) && typeof pixels.length === 'number' && !Array.isArray(pixels))) {
    const arr = /** @type {Uint8Array} */ (pixels);
    const stride = arr.length % 4 === 0 ? 4 : 3;
    for (let i = 0; i + stride <= arr.length; i += stride) {
      const alpha = stride === 4 ? arr[i + 3] / 255 : 1;
      out.push({ rgb: [arr[i], arr[i + 1], arr[i + 2]], alpha, weight: 1 });
    }
    return out;
  }
  if (!Array.isArray(pixels)) return out;
  for (const p of pixels) {
    if (p == null) continue;
    if (typeof p === 'string') {
      const parsed = parseCssColor(p);
      if (parsed) out.push({ rgb: parsed.rgb.slice(), alpha: parsed.alpha, weight: 1 });
      continue;
    }
    if (Array.isArray(p)) {
      if (p.length < 3) continue;
      out.push({ rgb: [p[0], p[1], p[2]], alpha: p.length > 3 ? p[3] / (p[3] > 1 ? 255 : 1) : 1, weight: 1 });
      continue;
    }
    if (typeof p === 'object') {
      const weight = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1;
      if (Array.isArray(p.rgb) && p.rgb.length >= 3) {
        out.push({ rgb: [p.rgb[0], p.rgb[1], p.rgb[2]], alpha: Number.isFinite(p.alpha) ? p.alpha : 1, weight });
        continue;
      }
      if (typeof p.hex === 'string') {
        const parsed = parseCssColor(p.hex);
        if (parsed) out.push({ rgb: parsed.rgb.slice(), alpha: Number.isFinite(p.alpha) ? p.alpha : parsed.alpha, weight });
      }
    }
  }
  return out;
}

/**
 * Collect samples from image pixels. One pixel is one unit of painted area —
 * which is the area model applied literally, with no assumption to make.
 *
 * @param {any} pixels
 * @param {{origin?: 'image'|'logo', backdrop?: readonly number[], maxSamples?: number, area?: number}} [options]
 * @returns {ColorSample[]}
 */
export function collectFromPixels(pixels, options = {}) {
  const origin = options.origin === 'logo' ? 'logo' : 'image';
  const backdrop = options.backdrop || [255, 255, 255];
  const maxSamples = Number.isFinite(options.maxSamples) && options.maxSamples > 0
    ? Math.floor(options.maxSamples) : MAX_PIXEL_SAMPLES;
  const decoded = decodePixels(pixels);
  if (decoded.length === 0) return [];
  // Rendered area, when known, rescales pixel counts into CSS px². It cancels
  // out under source normalisation but keeps the units honest.
  const scale = Number.isFinite(options.area) && options.area > 0
    ? options.area / decoded.length : 1;
  const shift = 8 - PIXEL_BIN_BITS;
  /** @type {Map<number, {r: number, g: number, b: number, w: number, n: number}>} */
  const bins = new Map();
  for (const p of decoded) {
    if (!Number.isFinite(p.rgb[0]) || !Number.isFinite(p.rgb[1]) || !Number.isFinite(p.rgb[2])) continue;
    const alpha = Math.min(1, Math.max(0, Number.isFinite(p.alpha) ? p.alpha : 1));
    if (alpha <= 0) continue;
    const rgb = compositeOver({ rgb: /** @type {[number,number,number]} */ (p.rgb), alpha, hex: '' }, backdrop);
    const w = p.weight * alpha;
    if (!(w > 0)) continue;
    const key = ((Math.min(255, Math.max(0, Math.round(rgb[0]))) >> shift) << (2 * PIXEL_BIN_BITS))
      | ((Math.min(255, Math.max(0, Math.round(rgb[1]))) >> shift) << PIXEL_BIN_BITS)
      | (Math.min(255, Math.max(0, Math.round(rgb[2]))) >> shift);
    let bin = bins.get(key);
    if (!bin) { bin = { r: 0, g: 0, b: 0, w: 0, n: 0 }; bins.set(key, bin); }
    bin.n += 1;
    bin.r += rgb[0] * w;
    bin.g += rgb[1] * w;
    bin.b += rgb[2] * w;
    bin.w += w;
  }
  // Sorted by weight, then by bin key: a total order independent of insertion.
  let entries = [...bins.entries()].sort((a, b) => (b[1].w - a[1].w) || (a[0] - b[0]));
  if (entries.length > maxSamples) entries = entries.slice(0, maxSamples);
  /** @type {ColorSample[]} */
  const out = [];
  for (const [, bin] of entries) {
    out.push(makeSample(
      [bin.r / bin.w, bin.g / bin.w, bin.b / bin.w],
      bin.w * scale,
      origin, 'pixel', false, bin.n,
    ));
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Source normalisation
 * ------------------------------------------------------------------------ */

/**
 * Normalise areas within each source, then combine sources by evidential
 * weight. Mutates nothing; returns new sample objects with `weight` set.
 * @param {readonly ColorSample[]} samples
 * @returns {ColorSample[]}
 */
export function normalizeSampleWeights(samples) {
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const s of samples) {
    if (!(s.area > 0)) continue;
    totals.set(s.origin, (totals.get(s.origin) || 0) + s.area);
  }
  let presentWeight = 0;
  for (const origin of totals.keys()) presentWeight += SOURCE_WEIGHTS[origin] ?? 0;
  if (presentWeight <= 0) return [];
  /** @type {ColorSample[]} */
  const out = [];
  for (const s of samples) {
    if (!(s.area > 0)) continue;
    const total = totals.get(s.origin) || 0;
    if (total <= 0) continue;
    const w = (s.area / total) * ((SOURCE_WEIGHTS[s.origin] ?? 0) / presentWeight);
    if (!(w > 0)) continue;
    out.push({ ...s, weight: w });
  }
  return out;
}

/**
 * Collect from every available source at once.
 * @param {{
 *   computed?: any[], css?: string|string[],
 *   images?: any[], logos?: any[], backdrop?: readonly number[]
 * }} sources
 * @returns {{samples: ColorSample[], origins: string[]}}
 */
export function collectColors(sources = {}) {
  const backdrop = sources.backdrop || [255, 255, 255];
  /** @type {ColorSample[]} */
  let all = [];
  if (sources.computed && sources.computed.length) {
    all = all.concat(collectFromComputedStyles(sources.computed, { backdrop }));
  }
  if (sources.css) all = all.concat(collectFromCss(sources.css, { backdrop }));
  for (const img of sources.images || []) {
    all = all.concat(collectFromPixels(img && img.pixels ? img.pixels : img, {
      origin: 'image', backdrop, area: img && img.area,
    }));
  }
  for (const logo of sources.logos || []) {
    all = all.concat(collectFromPixels(logo && logo.pixels ? logo.pixels : logo, {
      origin: 'logo', backdrop, area: logo && logo.area,
    }));
  }
  const samples = normalizeSampleWeights(all);
  const origins = [...new Set(samples.map((s) => s.origin))].sort();
  return { samples, origins };
}

/* ---------------------------------------------------------------------------
 * k-means in OKLab
 * ------------------------------------------------------------------------ */

/** Substream names, namespaced per API.md Part 1. */
export const KMEANS_STREAM = 'brand/kmeans';

/** Lloyd iterations before declaring convergence by exhaustion. */
export const MAX_KMEANS_ITERS = 64;
/** Independent k-means++ restarts; the lowest-inertia run wins, ties to the first. */
export const KMEANS_RESTARTS = 4;
/** Silhouette is O(n²); above this many points it runs on a seeded subsample. */
export const SILHOUETTE_MAX_POINTS = 700;

/**
 * @typedef {object} Cluster
 * @property {number} index
 * @property {[number, number, number]} center OKLab centroid
 * @property {[number, number, number]} oklch centroid in OKLCH, gamut-clamped
 * @property {string} hex centroid as `#rrggbb`
 * @property {number} weight share of total sample weight, 0..1
 * @property {number} count raw observations behind this cluster (pixels for
 *   image sources, declarations for style sources) — the sample size confidence
 *   is computed from
 * @property {number} members how many collected samples fell into it
 * @property {number} spread weighted RMS OKLab distance from the centroid
 * @property {Record<string, number>} sourceWeights weight contributed per origin
 */

/**
 * Turn arbitrary input into weighted OKLab points. Accepts already-collected
 * `ColorSample`s (weights preserved) or any pixel container (`decodePixels`).
 * @param {any} input
 * @returns {ColorSample[]}
 */
export function toSamples(input) {
  if (Array.isArray(input) && input.length > 0 && input[0] && typeof input[0] === 'object'
      && Array.isArray(input[0].lab) && Number.isFinite(input[0].weight)) {
    return /** @type {ColorSample[]} */ (input.filter((s) => s.weight > 0));
  }
  const collected = collectFromPixels(input, { origin: 'image' });
  return normalizeSampleWeights(collected);
}

/**
 * k-means++ seeding, weighted. The first centre is drawn with probability
 * proportional to sample weight; each later centre with probability
 * proportional to `weight · D²`, D being the distance to the nearest chosen
 * centre. Draws come from the `brand/kmeans` substream, so the same pixels and
 * the same seed always produce the same initialisation.
 *
 * @param {readonly ColorSample[]} samples
 * @param {number} k
 * @param {Pcg32} rng
 * @returns {number[]} indices of the seeded centres
 */
export function kmeansPlusPlusSeeds(samples, k, rng) {
  const n = samples.length;
  /** @type {number[]} */
  const chosen = [];
  const totalWeight = samples.reduce((a, s) => a + s.weight, 0);
  let target = rng.nextFloat() * totalWeight;
  let first = 0;
  for (let i = 0; i < n; i++) {
    target -= samples[i].weight;
    if (target <= 0) { first = i; break; }
    first = i;
  }
  chosen.push(first);
  const d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) d2[i] = deltaEok(samples[i].lab, samples[first].lab) ** 2;
  while (chosen.length < k) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[i].weight * d2[i];
    let pick;
    if (!(sum > 0)) {
      // Every remaining point coincides with a chosen centre. Take the first
      // index not already chosen so the result stays deterministic.
      pick = 0;
      while (pick < n && chosen.includes(pick)) pick++;
      if (pick >= n) break;
    } else {
      let t = rng.nextFloat() * sum;
      pick = n - 1;
      for (let i = 0; i < n; i++) {
        t -= samples[i].weight * d2[i];
        if (t <= 0) { pick = i; break; }
      }
    }
    chosen.push(pick);
    for (let i = 0; i < n; i++) {
      const d = deltaEok(samples[i].lab, samples[pick].lab) ** 2;
      if (d < d2[i]) d2[i] = d;
    }
  }
  return chosen;
}

/**
 * One weighted Lloyd run from a given seeding.
 * @param {readonly ColorSample[]} samples
 * @param {readonly number[]} seedIdx
 * @returns {{assignment: Int32Array, centers: number[][], inertia: number}}
 */
function lloyd(samples, seedIdx) {
  const n = samples.length;
  const k = seedIdx.length;
  let centers = seedIdx.map((i) => samples[i].lab.slice());
  const assignment = new Int32Array(n).fill(-1);
  for (let iter = 0; iter < MAX_KMEANS_ITERS; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = deltaEok(samples[i].lab, centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignment[i] !== best) { assignment[i] = best; moved = true; }
    }
    // Recompute centroids.
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    const wts = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const c = assignment[i];
      const w = samples[i].weight;
      sums[c][0] += samples[i].lab[0] * w;
      sums[c][1] += samples[i].lab[1] * w;
      sums[c][2] += samples[i].lab[2] * w;
      wts[c] += w;
    }
    for (let c = 0; c < k; c++) {
      if (wts[c] > 0) {
        centers[c] = [sums[c][0] / wts[c], sums[c][1] / wts[c], sums[c][2] / wts[c]];
      } else {
        // Empty cluster: reseed it on the point furthest from its own centre.
        // Deterministic, and it keeps k honest rather than silently collapsing.
        let worst = -1;
        let worstD = -1;
        for (let i = 0; i < n; i++) {
          const d = deltaEok(samples[i].lab, centers[assignment[i]]) * samples[i].weight;
          if (d > worstD) { worstD = d; worst = i; }
        }
        if (worst >= 0) { centers[c] = samples[worst].lab.slice(); moved = true; }
      }
    }
    if (!moved && iter > 0) break;
  }
  let inertia = 0;
  for (let i = 0; i < n; i++) {
    inertia += samples[i].weight * deltaEok(samples[i].lab, centers[assignment[i]]) ** 2;
  }
  return { assignment, centers, inertia };
}

/**
 * Weighted k-means in OKLab with seeded k-means++ initialisation and restarts.
 * @param {readonly ColorSample[]} samples
 * @param {{k: number, seed?: any, restarts?: number}} options
 * @returns {{clusters: Cluster[], assignment: Int32Array, inertia: number}}
 */
export function kmeansOklab(samples, options) {
  const pts = samples.filter((s) => s.weight > 0);
  if (pts.length === 0) throw new Error('kmeansOklab: no weighted samples');
  const distinct = new Set(pts.map((s) => s.hex)).size;
  const k = Math.max(1, Math.min(Math.floor(options.k), distinct, pts.length));
  const restarts = Number.isFinite(options.restarts) && options.restarts > 0
    ? Math.floor(options.restarts) : KMEANS_RESTARTS;
  const book = new SeedBook(options.seed ?? DEFAULT_SEED);
  const rng = book.fresh(KMEANS_STREAM);

  /** @type {{assignment: Int32Array, centers: number[][], inertia: number}|null} */
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const seeds = kmeansPlusPlusSeeds(pts, k, rng);
    if (seeds.length === 0) continue;
    const run = lloyd(pts, seeds);
    // Strict `<` keeps the earliest of equal-inertia runs, so the result does
    // not depend on iteration order beyond what the seed already fixes.
    if (best === null || run.inertia < best.inertia) best = run;
  }
  if (best === null) throw new Error('kmeansOklab: initialisation failed');

  const clusters = summarise(pts, best.assignment, best.centers);
  // Sort by weight descending, hex ascending on ties: a total order that does
  // not depend on which restart won.
  const order = clusters
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.weight - a.c.weight) || (a.c.hex < b.c.hex ? -1 : a.c.hex > b.c.hex ? 1 : 0));
  const remap = new Int32Array(clusters.length);
  order.forEach((o, newIndex) => { remap[o.i] = newIndex; });
  const sorted = order.map((o, newIndex) => ({ ...o.c, index: newIndex }));
  const assignment = new Int32Array(best.assignment.length);
  for (let i = 0; i < best.assignment.length; i++) assignment[i] = remap[best.assignment[i]];
  return { clusters: sorted, assignment, inertia: best.inertia };
}

/**
 * @param {readonly ColorSample[]} pts
 * @param {Int32Array} assignment
 * @param {readonly number[][]} centers
 * @returns {Cluster[]}
 */
function summarise(pts, assignment, centers) {
  const k = centers.length;
  const weight = new Float64Array(k);
  const count = new Float64Array(k);
  const members = new Int32Array(k);
  const sq = new Float64Array(k);
  /** @type {Record<string, number>[]} */
  const bySource = Array.from({ length: k }, () => ({}));
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const c = assignment[i];
    const w = pts[i].weight;
    weight[c] += w;
    count[c] += Number.isFinite(pts[i].observations) && pts[i].observations > 0 ? pts[i].observations : 1;
    members[c] += 1;
    sq[c] += w * deltaEok(pts[i].lab, centers[c]) ** 2;
    bySource[c][pts[i].origin] = (bySource[c][pts[i].origin] || 0) + w;
    total += w;
  }
  /** @type {Cluster[]} */
  const out = [];
  for (let c = 0; c < k; c++) {
    const center = /** @type {[number, number, number]} */ ([centers[c][0], centers[c][1], centers[c][2]]);
    const lch = clampChromaToGamut(oklabToOklch(center));
    out.push({
      index: c,
      center,
      oklch: lch,
      hex: rgbToHex(oklabToRgb(oklchToOklab(lch))),
      weight: total > 0 ? weight[c] / total : 0,
      count: count[c],
      members: members[c],
      spread: weight[c] > 0 ? Math.sqrt(sq[c] / weight[c]) : 0,
      sourceWeights: bySource[c],
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Silhouette and k selection
 * ------------------------------------------------------------------------ */

/**
 * Weighted mean silhouette coefficient. For each point, `a` is the weighted
 * mean distance to the other members of its own cluster and `b` the smallest
 * weighted mean distance to any other cluster; `s = (b − a) / max(a, b)`.
 *
 * @param {readonly ColorSample[]} samples
 * @param {Int32Array|readonly number[]} assignment
 * @param {number} k
 * @param {{seed?: any, maxPoints?: number}} [options]
 * @returns {number} −1..1; 0 when k is 1 or every point is in one cluster
 */
export function silhouetteScore(samples, assignment, k, options = {}) {
  if (k < 2) return 0;
  const maxPoints = Number.isFinite(options.maxPoints) && options.maxPoints > 0
    ? Math.floor(options.maxPoints) : SILHOUETTE_MAX_POINTS;
  /** @type {number[]} */
  let idx = samples.map((_, i) => i);
  if (idx.length > maxPoints) {
    const rng = new SeedBook(options.seed ?? DEFAULT_SEED).fresh(KMEANS_STREAM);
    idx = rng.shuffled(idx).slice(0, maxPoints).sort((a, b) => a - b);
  }
  const occupied = new Set(idx.map((i) => assignment[i]));
  if (occupied.size < 2) return 0;
  let num = 0;
  let den = 0;
  for (const i of idx) {
    const ci = assignment[i];
    const sums = new Float64Array(k);
    const wts = new Float64Array(k);
    for (const j of idx) {
      if (i === j) continue;
      const cj = assignment[j];
      const w = samples[j].weight;
      sums[cj] += w * deltaEok(samples[i].lab, samples[j].lab);
      wts[cj] += w;
    }
    const a = wts[ci] > 0 ? sums[ci] / wts[ci] : 0;
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci || wts[c] <= 0) continue;
      const m = sums[c] / wts[c];
      if (m < b) b = m;
    }
    if (!Number.isFinite(b)) continue;
    const denom = Math.max(a, b);
    const s = denom > 0 ? (b - a) / denom : 0;
    num += samples[i].weight * s;
    den += samples[i].weight;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Choose k over `range` by silhouette (§7). Ties go to the smaller k: with two
 * partitions of equal quality the more parsimonious one is the one that has
 * actually found structure.
 *
 * @param {any} pixels samples or any pixel container
 * @param {{seed?: any, range?: [number, number], restarts?: number}} [options]
 * @returns {number}
 */
export function chooseK(pixels, options = {}) {
  const samples = toSamples(pixels);
  if (samples.length === 0) throw new Error('chooseK: no samples');
  const [lo, hi] = options.range && options.range.length === 2 ? options.range : [3, 8];
  const distinct = new Set(samples.map((s) => s.hex)).size;
  const low = Math.max(1, Math.floor(lo));
  const high = Math.max(low, Math.min(Math.floor(hi), distinct, samples.length));
  if (high <= low) return Math.min(low, distinct);
  let bestK = low;
  let bestScore = -Infinity;
  for (let k = low; k <= high; k++) {
    const { assignment } = kmeansOklab(samples, { k, seed: options.seed, restarts: options.restarts });
    const score = silhouetteScore(samples, assignment, k, { seed: options.seed });
    if (score > bestScore + SILHOUETTE_TIE_EPS) { bestScore = score; bestK = k; }
  }
  return bestK;
}

/**
 * Two silhouette scores within this of each other are treated as equal, and the
 * smaller k wins. 1e-9 is far below any difference that reflects structure and
 * far above double-precision accumulation noise over a few hundred points.
 */
export const SILHOUETTE_TIE_EPS = 1e-9;

/**
 * The §7 quantisation pass: cluster colours in OKLab with seeded k-means,
 * choosing k by silhouette over [3,8] when k is not given.
 *
 * @param {any} pixels samples or any pixel container
 * @param {{k?: number, seed?: any, range?: [number, number], restarts?: number}} [options]
 * @returns {Cluster[]} sorted by weight, descending
 */
export function quantize(pixels, options = {}) {
  const samples = toSamples(pixels);
  if (samples.length === 0) throw new Error('quantize: no samples');
  const k = Number.isFinite(options.k) && options.k > 0
    ? Math.floor(options.k)
    : chooseK(samples, { seed: options.seed, range: options.range, restarts: options.restarts });
  return kmeansOklab(samples, { k, seed: options.seed, restarts: options.restarts }).clusters;
}
