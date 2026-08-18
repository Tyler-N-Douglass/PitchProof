/**
 * Deterministic text measurement (DECISIONS D7).
 *
 * §22.2 names post-substitution text overflow as the defect most likely to make
 * a proof look amateur in front of a client, and §14 calls overflow detection
 * "the highest-value check in the entire tool". A detector is only worth having
 * if it measures the same way everywhere, so measurement here is a table lookup,
 * not a canvas call:
 *
 *   - `AFM_TABLES` carries the published Adobe Core-14 advance-width tables
 *     (Helvetica, Helvetica-Bold, Times-Roman, Times-Bold, Courier) at 1000
 *     units per em, together with their published cap-height and x-height.
 *   - `FAMILY_MODELS` maps every family the studio is likely to meet onto one of
 *     those tables plus a documented width scale and its own published vertical
 *     metrics. Families backed by an AFM table are `exact`; the rest are
 *     `approximate` and say so, and their confidence is lowered accordingly.
 *   - Line breaking is greedy over the same widths, so a wrapped paragraph
 *     measures identically in Node, in the studio and in CI.
 *
 * A browser cross-check (`test/core/text-metrics.browser.test.mjs`) compares
 * these numbers against real Chromium measurement and reports the residual
 * rather than hiding it. Canvas is a calibration instrument here, never the
 * source of truth.
 *
 * @module core/text-metrics
 */

/** Every AFM table is expressed in this many units per em. */
export const UNITS_PER_EM = 1000;

/**
 * Advance widths for codepoints 32..126, in 1000ths of an em, straight from the
 * Adobe Font Metrics files distributed with the Core-14 PostScript fonts.
 */
const W_HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const W_HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const W_TIMES_ROMAN = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

const W_TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
];

const W_COURIER = new Array(95).fill(600);

/**
 * Latin-1 and General-Punctuation characters that appear constantly in real
 * captured copy. Accented Latin letters take the advance of their base letter,
 * which is exact in every Latin design that composes them from a base glyph and
 * a mark; the rest are the published AFM widths for those codepoints.
 * @type {Record<number, string|number>}
 */
const EXTENDED = {
  0x00a0: ' ', 0x00a1: '!', 0x00a2: '$', 0x00a3: '$', 0x00a5: '$', 0x00a9: '@',
  0x00ab: '"', 0x00ad: '-', 0x00ae: '@', 0x00b0: '*', 0x00b7: '.', 0x00bb: '"',
  0x00bf: '?', 0x00d7: '+', 0x00f7: '+',
  0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2013: '-', 0x2014: 'm', 0x2015: 'm',
  0x2018: "'", 0x2019: "'", 0x201a: ',', 0x201c: '"', 0x201d: '"', 0x201e: '"',
  0x2020: '+', 0x2021: '+', 0x2022: '.', 0x2026: 'W', 0x2030: '%',
  0x2039: '<', 0x203a: '>', 0x2044: '/', 0x20ac: '$', 0x2122: 'W',
  0x2192: '+', 0x2260: '=', 0x2264: '=', 0x2265: '=',
};

/** Base letters for the Latin-1 accented range, so `é` measures as `e`. */
const DEACCENT = (() => {
  /** @type {Record<number, string>} */
  const m = {};
  const put = (from, to, base) => { for (let c = from; c <= to; c++) m[c] = base[c - from]; };
  put(0x00c0, 0x00c5, 'AAAAAA'); m[0x00c6] = 'A'; m[0x00c7] = 'C';
  put(0x00c8, 0x00cb, 'EEEE'); put(0x00cc, 0x00cf, 'IIII');
  m[0x00d0] = 'D'; m[0x00d1] = 'N'; put(0x00d2, 0x00d6, 'OOOOO'); m[0x00d8] = 'O';
  put(0x00d9, 0x00dc, 'UUUU'); m[0x00dd] = 'Y'; m[0x00de] = 'P'; m[0x00df] = 'B';
  put(0x00e0, 0x00e5, 'aaaaaa'); m[0x00e6] = 'a'; m[0x00e7] = 'c';
  put(0x00e8, 0x00eb, 'eeee'); put(0x00ec, 0x00ef, 'iiii');
  m[0x00f0] = 'o'; m[0x00f1] = 'n'; put(0x00f2, 0x00f6, 'ooooo'); m[0x00f8] = 'o';
  put(0x00f9, 0x00fc, 'uuuu'); m[0x00fd] = 'y'; m[0x00fe] = 'p'; m[0x00ff] = 'y';
  put(0x0100, 0x0105, 'AaAaAa'); put(0x0106, 0x010d, 'CcCcCcCc');
  put(0x010e, 0x0111, 'DdDd'); put(0x0112, 0x011b, 'EeEeEeEeEe');
  put(0x011c, 0x0123, 'GgGgGgGg'); put(0x0124, 0x0127, 'HhHh');
  put(0x0128, 0x0131, 'IiIiIiIiIi'); put(0x0139, 0x0142, 'LlLlLlLlLl');
  put(0x0143, 0x014b, 'NnNnNnnNn'); put(0x014c, 0x0151, 'OoOoOo');
  put(0x0154, 0x0159, 'RrRrRr'); put(0x015a, 0x0161, 'SsSsSsSs');
  put(0x0162, 0x0167, 'TtTtTt'); put(0x0168, 0x0173, 'UuUuUuUuUuUu');
  m[0x0174] = 'W'; m[0x0175] = 'w'; put(0x0176, 0x0178, 'YyY');
  put(0x0179, 0x017e, 'ZzZzZz');
  return m;
})();

/**
 * @typedef {object} AfmTable
 * @property {string} name
 * @property {number[]} widths   codepoints 32..126
 * @property {number} capHeight
 * @property {number} xHeight
 * @property {number} ascender
 * @property {number} descender  negative
 * @property {number} defaultWidth
 */

/** The published Core-14 tables. @type {Record<string, AfmTable>} */
export const AFM_TABLES = {
  'Helvetica': { name: 'Helvetica', widths: W_HELVETICA, capHeight: 718, xHeight: 523, ascender: 718, descender: -207, defaultWidth: 556 },
  'Helvetica-Bold': { name: 'Helvetica-Bold', widths: W_HELVETICA_BOLD, capHeight: 718, xHeight: 532, ascender: 718, descender: -207, defaultWidth: 611 },
  'Times-Roman': { name: 'Times-Roman', widths: W_TIMES_ROMAN, capHeight: 662, xHeight: 450, ascender: 683, descender: -217, defaultWidth: 500 },
  'Times-Bold': { name: 'Times-Bold', widths: W_TIMES_BOLD, capHeight: 676, xHeight: 461, ascender: 683, descender: -217, defaultWidth: 500 },
  'Courier': { name: 'Courier', widths: W_COURIER, capHeight: 562, xHeight: 426, ascender: 629, descender: -157, defaultWidth: 600 },
};

/**
 * The corpus the average advance is taken over: the Latin alphabet in both
 * cases, the digits, and a space, each counted once. Documented rather than
 * tuned, so `metricDelta.avgAdvance` means the same thing for every family.
 */
export const AVG_ADVANCE_CORPUS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';

/**
 * @typedef {object} FamilyModel
 * @property {string} key            normalized family name
 * @property {string} label          canonical display name
 * @property {string} base           AFM table for regular weights
 * @property {string|null} boldBase  AFM table for weight >= 600, when one exists
 * @property {number} widthScale     multiplier on the base table's advances
 * @property {number} capHeight      per mille of em, published
 * @property {number} xHeight        per mille of em, published
 * @property {number} ascender
 * @property {number} descender
 * @property {'sans'|'serif'|'mono'|'display'} category
 * @property {boolean} exact         true when the widths come from this family's own AFM
 * @property {string[]} aliases      other names that resolve to this model
 */

/**
 * @param {string} label
 * @param {Partial<FamilyModel> & {base: string, capHeight: number, xHeight: number, category: FamilyModel['category']}} spec
 * @returns {FamilyModel}
 */
function model(label, spec) {
  return {
    key: normalizeFamily(label),
    label,
    base: spec.base,
    boldBase: spec.boldBase ?? null,
    widthScale: spec.widthScale ?? 1,
    capHeight: spec.capHeight,
    xHeight: spec.xHeight,
    ascender: spec.ascender ?? Math.round(spec.capHeight * 1.02),
    descender: spec.descender ?? -Math.round(spec.capHeight * 0.29),
    category: spec.category,
    exact: spec.exact ?? false,
    aliases: spec.aliases ?? [],
  };
}

/**
 * Every family model. Vertical metrics are the families' own published values
 * (OS/2 sCapHeight and sxHeight, normalized to a 1000-unit em); `widthScale` is
 * the ratio of the family's average advance over `AVG_ADVANCE_CORPUS` to the
 * base table's, taken from the same source. Families marked `exact` are the
 * ones whose advance table *is* the base table.
 * @type {FamilyModel[]}
 */
const MODELS = [
  // --- metric-compatible with Helvetica -----------------------------------
  model('Helvetica', { base: 'Helvetica', boldBase: 'Helvetica-Bold', capHeight: 718, xHeight: 523, ascender: 718, descender: -207, category: 'sans', exact: true, aliases: ['nimbus sans', 'helvetica lt', 'helvetica now'] }),
  model('Arial', { base: 'Helvetica', boldBase: 'Helvetica-Bold', capHeight: 716, xHeight: 519, ascender: 728, descender: -210, category: 'sans', exact: true, aliases: ['arialmt', 'arial mt'] }),
  model('Liberation Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', capHeight: 688, xHeight: 528, category: 'sans', exact: true }),
  model('Arimo', { base: 'Helvetica', boldBase: 'Helvetica-Bold', capHeight: 716, xHeight: 519, category: 'sans', exact: true }),
  model('Helvetica Neue', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.985, capHeight: 714, xHeight: 517, category: 'sans', aliases: ['helveticaneue', 'tex gyre heros'] }),
  // --- metric-compatible with Times ---------------------------------------
  model('Times New Roman', { base: 'Times-Roman', boldBase: 'Times-Bold', capHeight: 662, xHeight: 447, ascender: 693, descender: -216, category: 'serif', exact: true, aliases: ['times', 'timesnewromanpsmt'] }),
  model('Liberation Serif', { base: 'Times-Roman', boldBase: 'Times-Bold', capHeight: 654, xHeight: 450, category: 'serif', exact: true }),
  model('Tinos', { base: 'Times-Roman', boldBase: 'Times-Bold', capHeight: 662, xHeight: 447, category: 'serif', exact: true }),
  // --- metric-compatible with Courier -------------------------------------
  model('Courier New', { base: 'Courier', capHeight: 571, xHeight: 423, category: 'mono', exact: true, aliases: ['courier'] }),
  model('Liberation Mono', { base: 'Courier', capHeight: 571, xHeight: 423, category: 'mono', exact: true }),
  model('Cousine', { base: 'Courier', capHeight: 571, xHeight: 423, category: 'mono', exact: true }),
  // --- system sans ---------------------------------------------------------
  model('Verdana', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.105, capHeight: 727, xHeight: 545, category: 'sans' }),
  model('Tahoma', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.015, capHeight: 727, xHeight: 546, category: 'sans' }),
  model('Trebuchet MS', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.995, capHeight: 715, xHeight: 522, category: 'sans' }),
  model('Segoe UI', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.955, capHeight: 700, xHeight: 500, category: 'sans' }),
  model('Calibri', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.915, capHeight: 644, xHeight: 466, category: 'sans' }),
  model('San Francisco', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.965, capHeight: 700, xHeight: 517, category: 'sans', aliases: ['sf pro', 'sf pro text', 'sf pro display', '-apple-system', 'blinkmacsystemfont', 'system-ui'] }),
  // --- ubiquitous webfonts -------------------------------------------------
  model('Roboto', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.962, capHeight: 711, xHeight: 528, category: 'sans' }),
  model('Open Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.992, capHeight: 714, xHeight: 535, category: 'sans' }),
  model('Lato', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.948, capHeight: 720, xHeight: 506, category: 'sans' }),
  model('Montserrat', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.088, capHeight: 700, xHeight: 517, category: 'sans' }),
  model('Inter', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.002, capHeight: 727, xHeight: 517, category: 'sans' }),
  model('Poppins', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.078, capHeight: 700, xHeight: 548, category: 'sans' }),
  model('Source Sans Pro', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.928, capHeight: 660, xHeight: 486, category: 'sans', aliases: ['source sans 3'] }),
  model('Nunito Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.975, capHeight: 705, xHeight: 490, category: 'sans', aliases: ['nunito'] }),
  model('Raleway', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.968, capHeight: 720, xHeight: 520, category: 'sans' }),
  model('Work Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.985, capHeight: 720, xHeight: 500, category: 'sans' }),
  model('Rubik', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.995, capHeight: 700, xHeight: 519, category: 'sans' }),
  model('DM Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.972, capHeight: 700, xHeight: 517, category: 'sans' }),
  model('Manrope', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.978, capHeight: 715, xHeight: 520, category: 'sans' }),
  model('Plus Jakarta Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.985, capHeight: 730, xHeight: 525, category: 'sans' }),
  model('Figtree', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.968, capHeight: 720, xHeight: 520, category: 'sans' }),
  model('Outfit', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.015, capHeight: 700, xHeight: 500, category: 'sans' }),
  model('Space Grotesk', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 1.005, capHeight: 700, xHeight: 505, category: 'sans' }),
  model('Karla', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.945, capHeight: 715, xHeight: 510, category: 'sans' }),
  model('Barlow', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.925, capHeight: 720, xHeight: 520, category: 'sans' }),
  model('Mulish', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.965, capHeight: 700, xHeight: 500, category: 'sans' }),
  model('Geist', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.972, capHeight: 730, xHeight: 520, category: 'sans' }),
  model('Noto Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.995, capHeight: 714, xHeight: 536, category: 'sans' }),
  model('PT Sans', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.955, capHeight: 700, xHeight: 500, category: 'sans' }),
  model('Ubuntu', { base: 'Helvetica', boldBase: 'Helvetica-Bold', widthScale: 0.972, capHeight: 693, xHeight: 520, category: 'sans' }),
  // --- serif ---------------------------------------------------------------
  model('Georgia', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.075, capHeight: 692, xHeight: 484, category: 'serif' }),
  model('Merriweather', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.125, capHeight: 740, xHeight: 554, category: 'serif' }),
  model('Playfair Display', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.022, capHeight: 700, xHeight: 517, category: 'serif' }),
  model('Lora', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.048, capHeight: 700, xHeight: 510, category: 'serif' }),
  model('PT Serif', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.035, capHeight: 700, xHeight: 500, category: 'serif' }),
  model('Noto Serif', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.075, capHeight: 714, xHeight: 536, category: 'serif' }),
  model('Libre Baskerville', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.115, capHeight: 700, xHeight: 530, category: 'serif' }),
  model('Source Serif Pro', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.005, capHeight: 660, xHeight: 475, category: 'serif', aliases: ['source serif 4'] }),
  model('Crimson Text', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 0.965, capHeight: 660, xHeight: 430, category: 'serif', aliases: ['crimson pro'] }),
  model('EB Garamond', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 0.955, capHeight: 660, xHeight: 440, category: 'serif', aliases: ['garamond'] }),
  model('Palatino', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.045, capHeight: 692, xHeight: 469, category: 'serif', aliases: ['palatino linotype', 'book antiqua'] }),
  model('Cambria', { base: 'Times-Roman', boldBase: 'Times-Bold', widthScale: 1.035, capHeight: 667, xHeight: 467, category: 'serif' }),
  // --- mono ----------------------------------------------------------------
  model('Menlo', { base: 'Courier', widthScale: 1.005, capHeight: 720, xHeight: 545, category: 'mono' }),
  model('Monaco', { base: 'Courier', widthScale: 1.028, capHeight: 700, xHeight: 545, category: 'mono' }),
  model('Consolas', { base: 'Courier', widthScale: 0.916, capHeight: 644, xHeight: 466, category: 'mono' }),
  model('SF Mono', { base: 'Courier', widthScale: 1.0, capHeight: 700, xHeight: 517, category: 'mono', aliases: ['ui-monospace'] }),
  model('JetBrains Mono', { base: 'Courier', widthScale: 1.0, capHeight: 730, xHeight: 550, category: 'mono' }),
  model('Fira Code', { base: 'Courier', widthScale: 1.0, capHeight: 700, xHeight: 527, category: 'mono', aliases: ['fira mono'] }),
  model('IBM Plex Mono', { base: 'Courier', widthScale: 1.0, capHeight: 698, xHeight: 516, category: 'mono' }),
  model('Roboto Mono', { base: 'Courier', widthScale: 1.002, capHeight: 711, xHeight: 528, category: 'mono' }),
  model('Source Code Pro', { base: 'Courier', widthScale: 1.0, capHeight: 660, xHeight: 486, category: 'mono' }),
  model('Geist Mono', { base: 'Courier', widthScale: 1.0, capHeight: 730, xHeight: 520, category: 'mono' }),
  model('Space Mono', { base: 'Courier', widthScale: 1.0, capHeight: 700, xHeight: 496, category: 'mono' }),
];

/** @type {Map<string, FamilyModel>} */
const MODEL_INDEX = (() => {
  const m = new Map();
  for (const mod of MODELS) {
    m.set(mod.key, mod);
    for (const a of mod.aliases) m.set(normalizeFamily(a), mod);
  }
  // Generic CSS families resolve to a representative concrete model.
  m.set('sans-serif', m.get('arial'));
  m.set('serif', m.get('times new roman'));
  m.set('monospace', m.get('courier new'));
  m.set('cursive', m.get('georgia'));
  m.set('fantasy', m.get('arial'));
  m.set('ui-sans-serif', m.get('arial'));
  m.set('ui-serif', m.get('times new roman'));
  m.set('ui-rounded', m.get('arial'));
  return m;
})();

/** Every model, for lanes that need to enumerate what the studio knows. */
export const FAMILY_MODELS = MODELS.slice();

/**
 * Normalize a CSS family name to a lookup key: unquoted, collapsed whitespace,
 * lowercase, with weight/style suffixes that CSS carries in the family string
 * ("Inter Tight SemiBold") left intact, because those are genuinely different
 * families and guessing otherwise would silently mis-measure.
 * @param {string} family
 * @returns {string}
 */
export function normalizeFamily(family) {
  return String(family || '')
    .replace(/^\s*["']|["']\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Split a CSS `font-family` list into its entries.
 * @param {string} list
 * @returns {string[]}
 */
export function parseFamilyList(list) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let quote = '';
  for (const ch of String(list || '')) {
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The model for a family, or null when this build has no published metrics for
 * it. Callers that need a guaranteed answer use `metricsFor`, which falls back
 * to a category-matched model and says so.
 * @param {string} family
 * @returns {FamilyModel|null}
 */
export function lookupFamily(family) {
  return MODEL_INDEX.get(normalizeFamily(family)) || null;
}

/**
 * Guess a category from a family name when the family is unknown. Documented,
 * not clever: the name is the only signal available, and the answer is reported
 * as approximate.
 * @param {string} family
 * @returns {'sans'|'serif'|'mono'|'display'}
 */
export function guessCategory(family) {
  const n = normalizeFamily(family);
  if (/\b(mono|code|console|courier|typewriter|terminal)\b/.test(n)) return 'mono';
  if (/\b(serif|times|georgia|garamond|baskerville|caslon|didot|bodoni|playfair|roman|book|slab)\b/.test(n)
      && !/sans[- ]?serif/.test(n)) return 'serif';
  if (/\b(display|headline|poster|condensed|expanded|black)\b/.test(n)) return 'display';
  return 'sans';
}

/**
 * @typedef {object} ResolvedMetrics
 * @property {string} family        the family asked for
 * @property {string} resolved      the family whose metrics were used
 * @property {AfmTable} table
 * @property {number} widthScale
 * @property {number} capHeight     per mille
 * @property {number} xHeight       per mille
 * @property {number} ascender
 * @property {number} descender
 * @property {'sans'|'serif'|'mono'|'display'} category
 * @property {boolean} exact        widths come from this family's own AFM
 * @property {boolean} known        this build has published metrics for the family
 * @property {number} avgAdvance    per mille, over AVG_ADVANCE_CORPUS
 */

/** @type {Map<string, ResolvedMetrics>} */
const METRIC_CACHE = new Map();

/**
 * Metrics for a family at a weight. Unknown families fall back to the closest
 * model in their guessed category and come back with `known: false`, which is
 * what lowers `TypeFace` confidence and what makes the studio ask the user.
 * @param {string} family
 * @param {number} [weight]
 * @returns {ResolvedMetrics}
 */
export function metricsFor(family, weight = 400) {
  const key = `${normalizeFamily(family)}|${weight}`;
  const hit = METRIC_CACHE.get(key);
  if (hit) return hit;

  const found = lookupFamily(family);
  const known = !!found;
  const category = found ? found.category : guessCategory(family);
  const mod = found || MODEL_INDEX.get(
    category === 'serif' ? 'times new roman' : category === 'mono' ? 'courier new' : 'arial',
  );

  const bold = weight >= 600;
  const table = AFM_TABLES[bold && mod.boldBase ? mod.boldBase : mod.base];
  // A family with no bold table of its own still gets wider: the ratio of
  // Helvetica-Bold to Helvetica over AVG_ADVANCE_CORPUS is 1.0429, and the same
  // ratio is used for every synthesized bold. Weights between 400 and 600
  // interpolate; above 700 the growth flattens, as it does in real families.
  let widthScale = mod.widthScale;
  if (!mod.boldBase) {
    const t = weight <= 400 ? 0 : Math.min(1, (weight - 400) / 300);
    widthScale *= 1 + t * 0.0429;
  } else if (weight > 700) {
    widthScale *= 1 + Math.min(1, (weight - 700) / 200) * 0.03;
  } else if (weight > 400 && weight < 600) {
    // 500 sits between the regular and bold tables; the regular table with a
    // partial scale is closer than snapping to either.
    widthScale *= 1 + ((weight - 400) / 200) * 0.028;
  } else if (weight < 400) {
    widthScale *= 1 - Math.min(1, (400 - weight) / 300) * 0.035;
  }

  const out = {
    family,
    resolved: mod.label,
    table,
    widthScale,
    capHeight: mod.capHeight,
    xHeight: mod.xHeight,
    ascender: mod.ascender,
    descender: mod.descender,
    category,
    exact: !!(found && found.exact && (!bold || !!mod.boldBase)),
    known,
    avgAdvance: 0,
  };
  out.avgAdvance = advanceOfString(AVG_ADVANCE_CORPUS, out) / AVG_ADVANCE_CORPUS.length;
  METRIC_CACHE.set(key, out);
  return out;
}

/**
 * Advance of one codepoint in per-mille units.
 * @param {number} cp
 * @param {ResolvedMetrics} m
 * @returns {number}
 */
export function advanceOfCodepoint(cp, m) {
  if (cp >= 32 && cp <= 126) return m.table.widths[cp - 32] * m.widthScale;
  if (cp === 9) return m.table.widths[0] * 8 * m.widthScale;     // tab: eight spaces
  if (cp === 10 || cp === 13) return 0;
  const ext = EXTENDED[cp];
  if (typeof ext === 'string') return m.table.widths[ext.charCodeAt(0) - 32] * m.widthScale;
  if (typeof ext === 'number') return ext * m.widthScale;
  const de = DEACCENT[cp];
  if (de) return m.table.widths[de.charCodeAt(0) - 32] * m.widthScale;
  if (cp >= 0x0370 && cp <= 0x04ff) return m.table.defaultWidth * m.widthScale;          // Greek/Cyrillic
  if (cp >= 0x0590 && cp <= 0x08ff) return m.table.defaultWidth * 0.9 * m.widthScale;    // Hebrew/Arabic
  if (isWideCodepoint(cp)) return UNITS_PER_EM * (m.category === 'mono' ? 1 : 1);        // CJK: one em
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;                                            // variation selectors
  if (cp >= 0x200b && cp <= 0x200f) return 0;                                            // zero-width
  return m.table.defaultWidth * m.widthScale;
}

/**
 * CJK, Hangul, Kana and full-width forms advance a full em in every Latin
 * fallback that has them at all.
 * @param {number} cp
 * @returns {boolean}
 */
export function isWideCodepoint(cp) {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff);
}

/**
 * Total advance of a string in per-mille units.
 * @param {string} text
 * @param {ResolvedMetrics} m
 * @returns {number}
 */
export function advanceOfString(text, m) {
  let total = 0;
  for (const ch of String(text)) total += advanceOfCodepoint(ch.codePointAt(0), m);
  return total;
}

/**
 * @typedef {object} TextStyle
 * @property {string} family
 * @property {number} [weight]        default 400
 * @property {number} fontSizePx
 * @property {number} [letterSpacingPx] default 0
 * @property {number} [wordSpacingPx]   default 0
 * @property {number} [lineHeight]      unitless multiplier, default 1.2
 * @property {'none'|'uppercase'|'lowercase'|'capitalize'} [textTransform]
 */

/**
 * Apply `text-transform` before measurement, because a headline set in
 * uppercase measures nothing like the string in the model.
 * @param {string} text
 * @param {TextStyle['textTransform']} [transform]
 * @returns {string}
 */
export function applyTransform(text, transform) {
  switch (transform) {
    case 'uppercase': return String(text).toUpperCase();
    case 'lowercase': return String(text).toLowerCase();
    case 'capitalize': return String(text).replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
    default: return String(text);
  }
}

/**
 * Width of a single run of text in CSS pixels.
 * @param {string} text
 * @param {TextStyle} style
 * @returns {number}
 */
export function measureText(text, style) {
  const m = metricsFor(style.family, style.weight ?? 400);
  const s = applyTransform(text, style.textTransform);
  const em = style.fontSizePx / UNITS_PER_EM;
  let w = advanceOfString(s, m) * em;
  const chars = [...s].length;
  if (chars > 0 && style.letterSpacingPx) w += style.letterSpacingPx * chars;
  if (style.wordSpacingPx) {
    let spaces = 0;
    for (const ch of s) if (ch === ' ') spaces++;
    w += style.wordSpacingPx * spaces;
  }
  return w;
}

/** Characters after which a line may break even without a space. */
const BREAK_AFTER = new Set(['-', '‐', '‒', '–', '—', '/', '​', '­']);

/**
 * Split text into break-opportunity segments. Each segment carries the text
 * that would stay on the line and whether the break after it is collapsible
 * whitespace (which disappears at end of line) or a hard character.
 * @param {string} text
 * @returns {{text: string, trailingSpace: string}[]}
 */
export function segments(text) {
  /** @type {{text: string, trailingSpace: string}[]} */
  const out = [];
  const chars = [...String(text)];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t' || ch === ' ') {
      if (ch === ' ') { cur += ch; continue; }   // nbsp never breaks
      let ws = '';
      while (i < chars.length && (chars[i] === ' ' || chars[i] === '\t')) { ws += chars[i]; i++; }
      i--;
      out.push({ text: cur, trailingSpace: ws });
      cur = '';
      continue;
    }
    cur += ch;
    if (BREAK_AFTER.has(ch) && i + 1 < chars.length) {
      out.push({ text: cur, trailingSpace: '' });
      cur = '';
    }
    if (isWideCodepoint(ch.codePointAt(0)) && i + 1 < chars.length) {
      out.push({ text: cur, trailingSpace: '' });
      cur = '';
    }
  }
  if (cur) out.push({ text: cur, trailingSpace: '' });
  return out;
}

/**
 * @typedef {object} LayoutOptions
 * @property {number} maxWidthPx
 * @property {'normal'|'nowrap'|'pre'|'pre-wrap'} [whiteSpace]
 * @property {'normal'|'break-word'|'anywhere'} [overflowWrap]
 * @property {number} [maxLines]        `-webkit-line-clamp`
 */

/**
 * @typedef {object} TextLayout
 * @property {{text: string, widthPx: number}[]} lines
 * @property {number} lineCount
 * @property {number} maxLineWidthPx
 * @property {number} heightPx
 * @property {number} lineHeightPx
 * @property {string[]} unbreakable    segments wider than the container on their own
 * @property {boolean} clamped         maxLines truncated the result
 */

/**
 * Greedy line breaking. The same algorithm every browser uses for
 * `white-space: normal` with no justification: fill a line until the next
 * segment would exceed the container, then break.
 * @param {string} text
 * @param {TextStyle} style
 * @param {LayoutOptions} options
 * @returns {TextLayout}
 */
export function layoutText(text, style, options) {
  const ws = options.whiteSpace || 'normal';
  const lineHeightPx = (style.lineHeight ?? 1.2) * style.fontSizePx;
  const transformed = applyTransform(text, style.textTransform);
  const maxWidthPx = Math.max(0, options.maxWidthPx);

  /** @param {string} s @returns {number} */
  const w = (s) => measureText(s, { ...style, textTransform: 'none' });

  /** @type {{text: string, widthPx: number}[]} */
  const lines = [];
  /** @type {string[]} */
  const unbreakable = [];

  const hardLines = ws === 'pre' || ws === 'pre-wrap'
    ? transformed.split('\n')
    : [transformed.replace(/\s*\n\s*/g, ' ')];

  for (const hard of hardLines) {
    if (ws === 'nowrap' || ws === 'pre') {
      const width = w(hard);
      if (width > maxWidthPx && maxWidthPx > 0) unbreakable.push(hard);
      lines.push({ text: hard, widthPx: width });
      continue;
    }
    const segs = segments(hard);
    if (segs.length === 0) { lines.push({ text: '', widthPx: 0 }); continue; }
    let cur = '';
    let curW = 0;
    // A break collapses trailing whitespace, so a line's recorded width is the
    // width of its content without the space that ended it.
    const pushLine = (text) => lines.push({ text, widthPx: w(text.replace(/[ \t]+$/, '')) });
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const piece = cur === '' ? seg.text : cur + seg.text;
      const pieceW = w(piece);
      if (cur !== '' && pieceW > maxWidthPx) {
        pushLine(cur);
        cur = seg.text;
        curW = w(cur);
      } else {
        cur = piece;
        curW = pieceW;
      }
      // A single segment that does not fit on an empty line.
      if (cur === seg.text && curW > maxWidthPx && maxWidthPx > 0) {
        if (options.overflowWrap === 'break-word' || options.overflowWrap === 'anywhere') {
          const broken = breakLongSegment(cur, style, maxWidthPx, w);
          for (let k = 0; k < broken.length - 1; k++) pushLine(broken[k].text);
          cur = broken[broken.length - 1].text;
          curW = broken[broken.length - 1].widthPx;
        } else {
          unbreakable.push(seg.text);
        }
      }
      if (seg.trailingSpace && i < segs.length - 1) {
        const withSpace = cur + seg.trailingSpace;
        const wsWidth = w(withSpace);
        // Trailing whitespace at a break point is collapsed, so it only counts
        // while more text follows on the same line.
        cur = withSpace;
        curW = wsWidth;
      }
    }
    pushLine(cur);
  }

  let clamped = false;
  let final = lines;
  if (options.maxLines && lines.length > options.maxLines) {
    final = lines.slice(0, options.maxLines);
    clamped = true;
  }

  const maxLineWidthPx = final.reduce((a, l) => Math.max(a, l.widthPx), 0);
  return {
    lines: final,
    lineCount: final.length,
    maxLineWidthPx,
    lineHeightPx,
    heightPx: final.length * lineHeightPx,
    unbreakable,
    clamped,
  };
}

/**
 * Break a segment that cannot fit on a line, character by character.
 * @param {string} seg
 * @param {TextStyle} style
 * @param {number} maxWidthPx
 * @param {(s: string) => number} w
 * @returns {{text: string, widthPx: number}[]}
 */
function breakLongSegment(seg, style, maxWidthPx, w) {
  /** @type {{text: string, widthPx: number}[]} */
  const out = [];
  let cur = '';
  for (const ch of seg) {
    const next = cur + ch;
    if (cur !== '' && w(next) > maxWidthPx) { out.push({ text: cur, widthPx: w(cur) }); cur = ch; }
    else cur = next;
  }
  out.push({ text: cur, widthPx: w(cur) });
  return out;
}

/**
 * Cap height in CSS pixels at a given font size.
 * @param {string} family @param {number} fontSizePx @param {number} [weight]
 */
export function capHeightPx(family, fontSizePx, weight = 400) {
  return metricsFor(family, weight).capHeight * fontSizePx / UNITS_PER_EM;
}

/**
 * x-height in CSS pixels at a given font size.
 * @param {string} family @param {number} fontSizePx @param {number} [weight]
 */
export function xHeightPx(family, fontSizePx, weight = 400) {
  return metricsFor(family, weight).xHeight * fontSizePx / UNITS_PER_EM;
}

/**
 * The §4 `TypeFace.metricDelta`: the ratio of the requested face's metrics to
 * the fallback that will actually render. 1.0 means the substitution is
 * metrically invisible; 1.1 means every headline is ten percent wider than the
 * design assumed, which is exactly the §22.2 failure.
 * @param {string} requested
 * @param {string} fallback
 * @param {number} [weight]
 * @returns {{capHeight: number, xHeight: number, avgAdvance: number}}
 */
export function metricDelta(requested, fallback, weight = 400) {
  const a = metricsFor(requested, weight);
  const b = metricsFor(fallback, weight);
  return {
    capHeight: round6(a.capHeight / b.capHeight),
    xHeight: round6(a.xHeight / b.xHeight),
    avgAdvance: round6(a.avgAdvance / b.avgAdvance),
  };
}

/** @param {number} n @returns {number} */
function round6(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * Candidates a fallback stack may be built from: families present on
 * essentially every machine a proof will be opened on, plus the CSS generics.
 */
export const FALLBACK_CANDIDATES = [
  'Arial', 'Helvetica', 'Helvetica Neue', 'Liberation Sans', 'Segoe UI', 'Roboto',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri',
  'Times New Roman', 'Georgia', 'Liberation Serif', 'Palatino', 'Cambria',
  'Courier New', 'Consolas', 'Menlo', 'Monaco', 'Liberation Mono',
];

/** Families that are metrically identical, in preference order. */
const METRIC_GROUPS = [
  ['Arial', 'Helvetica', 'Liberation Sans', 'Arimo', 'Helvetica Neue'],
  ['Times New Roman', 'Times', 'Liberation Serif', 'Tinos'],
  ['Courier New', 'Courier', 'Liberation Mono', 'Cousine'],
];

/**
 * Distance between two families' metrics. Advance width dominates, because that
 * is what overflows a container; cap-height and x-height follow, because they
 * are what makes a substitution look wrong even when it fits.
 * @param {ResolvedMetrics} a
 * @param {ResolvedMetrics} b
 * @returns {number}
 */
export function metricDistance(a, b) {
  return 3 * Math.abs(a.avgAdvance / b.avgAdvance - 1)
    + Math.abs(a.capHeight / b.capHeight - 1)
    + Math.abs(a.xHeight / b.xHeight - 1);
}

/**
 * @typedef {object} FaceResolution
 * @property {string} requested
 * @property {string} resolved            the family that will actually render
 * @property {string[]} stack             the CSS fallback stack, metric-compatible first
 * @property {{capHeight: number, xHeight: number, avgAdvance: number}} metricDelta
 * @property {boolean} available          the requested family is guaranteed present
 * @property {boolean} known              this build has published metrics for it
 * @property {number} confidence          0..1
 */

/**
 * Build a metric-compatible fallback stack for a requested family (§7).
 *
 * `available` lists families the artifact can count on: families the user
 * supplied a licensed font file for, plus the system families in
 * `FALLBACK_CANDIDATES`. A requested family that is not available is *resolved*
 * to the closest available one, and that resolution — not the request — is what
 * every downstream measurement uses. That is what "post-substitution" means in
 * §14, and it is why overflow detection here cannot be fooled by a font the
 * client's laptop does not have.
 *
 * @param {string} family
 * @param {object} [options]
 * @param {string[]} [options.available]  families guaranteed to render
 * @param {number} [options.weight]
 * @returns {FaceResolution}
 */
export function resolveFace(family, options = {}) {
  const weight = options.weight ?? 400;
  const available = options.available || FALLBACK_CANDIDATES;
  const availKeys = new Set(available.map(normalizeFamily));
  const reqKey = normalizeFamily(family);
  const reqMetrics = metricsFor(family, weight);
  const known = reqMetrics.known;

  /** @type {string[]} */
  const stack = [];
  const push = (name) => { if (name && !stack.some((s) => normalizeFamily(s) === normalizeFamily(name))) stack.push(name); };

  push(family);

  // 1. Anything in the same metric group is a free, exact substitution.
  for (const group of METRIC_GROUPS) {
    if (group.some((g) => normalizeFamily(g) === reqKey)) for (const g of group) if (availKeys.has(normalizeFamily(g))) push(g);
  }

  // 2. Otherwise rank available families of the same category by metric distance.
  const ranked = available
    .filter((c) => normalizeFamily(c) !== reqKey)
    .map((c) => ({ name: c, m: metricsFor(c, weight) }))
    .filter((c) => c.m.category === reqMetrics.category)
    .map((c) => ({ ...c, d: metricDistance(reqMetrics, c.m) }))
    .sort((a, b) => (a.d === b.d ? a.name.localeCompare(b.name) : a.d - b.d));

  for (const c of ranked.slice(0, 3)) push(c.name);

  const generic = reqMetrics.category === 'serif' ? 'serif'
    : reqMetrics.category === 'mono' ? 'monospace' : 'sans-serif';
  push(generic);

  const isAvailable = availKeys.has(reqKey);
  const resolved = isAvailable ? family : (ranked[0]?.name || generic);
  const delta = metricDelta(family, resolved, weight);

  // Confidence: a family we have exact tables for, that is itself available, is
  // certain. Anything else loses confidence in proportion to how far the
  // substitution moves the advance width, because that is the quantity that
  // decides whether a layout survives.
  let confidence = 1;
  if (!known) confidence -= 0.35;
  else if (!reqMetrics.exact) confidence -= 0.12;
  if (!isAvailable) confidence -= Math.min(0.4, Math.abs(delta.avgAdvance - 1) * 2 + 0.05);
  confidence = Math.max(0, Math.min(1, round6(confidence)));

  return { requested: family, resolved, stack, metricDelta: delta, available: isAvailable, known, confidence };
}

/**
 * Serialize a fallback stack into a CSS `font-family` value, quoting families
 * whose names need it.
 * @param {string[]} stack
 * @returns {string}
 */
export function cssFontFamily(stack) {
  return stack.map((f) => (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(f) ? f : `"${f.replace(/"/g, '')}"`)).join(', ');
}
