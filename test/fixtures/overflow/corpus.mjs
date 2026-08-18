/**
 * The planted-defect corpus for §17.4.
 *
 *   > Overflow detection — a synthetic corpus with planted overflow at known
 *   > locations; measure precision and recall; assert recall ≥ 0.98 for
 *   > severity-1 overflow. Planted-defect corpora are the only honest way to
 *   > know a detector works.
 *
 * **How a case is planted.** Every case fixes the text, the style and the face
 * substitution, then *derives* the container from them so the excess is a stated
 * fraction of the container: `overBy: 0.12` means the text is exactly 12% wider
 * (or taller) than the box it has to live in, and `overBy: -0.25` means it fits
 * with a quarter of the container to spare. The defect is therefore planted at a
 * known magnitude, not eyeballed, and the margins on both sides are comfortable
 * except where a group deliberately probes the threshold.
 *
 * **What the corpus does not do.** It does not decide whether a case is a
 * severity-1 overflow. That is the oracle's job, and the oracle lives in
 * `test/validate/overflow-corpus.test.mjs`, is written independently of
 * `src/validate/`, and never imports the detector. `planted` below is the
 * *design intent* of the case; the test asserts the oracle agrees with the
 * intent (which is what proves the corpus is well formed) and then measures the
 * detector against the oracle.
 *
 * Construction uses `src/core/text-metrics.js` — the shared measurement service,
 * which is not the thing under test — to size containers. A construction error
 * there would show up immediately as the oracle disagreeing with the planted
 * intent, because the oracle sums advances itself.
 */

import { SeedBook } from '../../../src/core/prng.js';
import {
  layoutText, measureText, normalizeFamily, FALLBACK_CANDIDATES,
} from '../../../src/core/text-metrics.js';
import {
  HEADLINES, SUBHEADS, PARAGRAPHS, GERMAN_COMPOUNDS, GERMAN_SENTENCES,
  CJK, LABELS, LONG_TOKENS,
} from './copy.mjs';

/** The three breakpoints §4 pins, by id. */
export const BREAKPOINT_WIDTH = { sm: 390, md: 1024, lg: 1600 };

const GENERICS = new Set(['sans-serif', 'serif', 'monospace', 'system-ui']);
const AVAILABLE = new Set(FALLBACK_CANDIDATES.map(normalizeFamily));

/**
 * The face a browser would land on for a declared stack: the first entry that is
 * actually present. Written here so a case can state its own expected
 * substitution without asking the detector.
 * @param {string[]} stack
 * @returns {string}
 */
export function firstAvailable(stack) {
  for (const name of stack) {
    const key = normalizeFamily(name);
    if (GENERICS.has(key) || AVAILABLE.has(key)) return name;
  }
  return 'sans-serif';
}

/**
 * A minimal BrandSystem carrying one face. `embeddable: false` is the normal
 * case (§7 — a brand face is only embeddable when the user supplied a licensed
 * file), and it is what makes the substitution happen.
 * @param {object} spec
 * @returns {any}
 */
export function brandWith(spec) {
  const { family, stack, role = 'body', weights = [400], embeddable = false } = spec;
  return {
    id: 'br_corpus',
    sourceUrl: null,
    capturedAt: '2026-02-01T09:00:00.000Z',
    colors: [],
    faces: [{
      family,
      fallbackStack: [family, ...stack],
      weightsSeen: weights,
      role,
      metricDelta: null,
      embeddable,
    }],
    logos: [],
    shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'photographic', saturationBias: 0 },
    confidence: { colors: 1, faces: 1, logos: 1, shape: 1, imagery: 1 },
    manualOverrides: [],
  };
}

/** Round a derived container dimension to a hundredth of a pixel. */
const q = (n) => Math.round(n * 100) / 100;

/** @type {any[]} */
const CASES = [];

/**
 * Plant one case.
 *
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.group
 * @param {string} spec.note
 * @param {'sev1'|'sev2'|'fit'} spec.planted     the design intent, not the ground truth
 * @param {'width'|'height'|'clamp'} spec.axis
 * @param {string} spec.text
 * @param {string} spec.family                    the requested family
 * @param {string[]} spec.stack                   the declared fallback stack after it
 * @param {'sm'|'md'|'lg'} spec.breakpoint
 * @param {number} spec.fontSizePx
 * @param {number} [spec.weight]
 * @param {number} [spec.lineHeight]
 * @param {number} [spec.letterSpacingPx]
 * @param {'none'|'uppercase'|'lowercase'|'capitalize'} [spec.textTransform]
 * @param {'normal'|'nowrap'} [spec.whiteSpace]
 * @param {'normal'|'break-word'|'anywhere'} [spec.overflowWrap]
 * @param {number} [spec.overBy]                  excess as a fraction of the container
 * @param {number} [spec.containerWidthPx]        for wrapped cases, the wrap width
 * @param {number} [spec.maxLines]
 * @param {number} [spec.lostLines]               for clamp cases
 * @param {string} [spec.role]
 * @param {boolean} [spec.embeddable]
 */
function plant(spec) {
  const {
    id, group, note, planted, axis, text, family, stack, breakpoint,
    fontSizePx, weight = 400, lineHeight = axis === 'width' ? 1.2 : 1.45,
    letterSpacingPx = 0, textTransform = 'none',
    whiteSpace = axis === 'width' ? 'nowrap' : 'normal',
    overflowWrap = 'normal', overBy = 0,
    containerWidthPx, maxLines, lostLines, role = 'body', embeddable = false,
  } = spec;

  const declared = [family, ...stack];
  const resolved = embeddable ? family : firstAvailable(declared);
  const style = { family, weight, fontSizePx, lineHeight, letterSpacingPx, textTransform };
  const measuredStyle = { ...style, family: resolved };

  /** @type {any} */
  const box = {
    elementId: `el_${id.replace(/[^a-z0-9]/gi, '').slice(0, 10)}`,
    role,
    text,
    style,
    whiteSpace,
    overflowWrap,
  };

  if (axis === 'width') {
    const width = whiteSpace === 'nowrap'
      ? measureText(text, measuredStyle)
      : layoutText(text, measuredStyle, { maxWidthPx: containerWidthPx, whiteSpace, overflowWrap }).maxLineWidthPx;
    const target = whiteSpace === 'nowrap' ? q(width / (1 + overBy)) : containerWidthPx;
    box.containerWidthPx = target;
    // Generous on the other axis, so exactly one axis is under test.
    box.containerHeightPx = q(fontSizePx * lineHeight * 6);
  } else if (axis === 'height') {
    box.containerWidthPx = containerWidthPx;
    const laid = layoutText(text, measuredStyle, { maxWidthPx: containerWidthPx, whiteSpace, overflowWrap });
    box.containerHeightPx = q((laid.lineCount * laid.lineHeightPx) / (1 + overBy));
  } else {
    box.containerWidthPx = containerWidthPx;
    const laid = layoutText(text, measuredStyle, { maxWidthPx: containerWidthPx, whiteSpace, overflowWrap });
    const lines = Math.max(1, laid.lineCount - lostLines);
    box.maxLines = lines;
    // Tall enough for the clamped text, so the clamp is the only finding.
    box.containerHeightPx = q(lines * laid.lineHeightPx * 1.05);
  }

  CASES.push({
    id,
    group,
    note,
    planted,
    axis,
    overBy,
    requestedFamily: family,
    resolvedFamily: resolved,
    breakpoint,
    brand: brandWith({ family, stack, role: role === 'headline' ? 'display' : 'body', weights: [weight], embeddable }),
    measurement: {
      sceneId: `sc_${group}`,
      breakpoint,
      boxes: [box],
    },
  });
}

// ---------------------------------------------------------------------------
// A. Headlines that overflow at `sm` only
//    The single most common shape of the defect: the deck is built on a laptop,
//    reviewed on a laptop, and the one breakpoint nobody looked at is the one
//    the client opens on a phone in Review mode.
// ---------------------------------------------------------------------------

const HEADLINE_SIZES = { sm: 28, md: 40, lg: 52 };
HEADLINES.slice(0, 5).forEach((text, i) => {
  const family = ['Inter', 'Montserrat', 'Poppins', 'Work Sans', 'Lato'][i];
  for (const bp of ['sm', 'md', 'lg']) {
    plant({
      id: `A${i}-${bp}`,
      group: 'headline-sm-only',
      note: `Headline set in ${family}, which substitutes; it clears the container at md and lg and clips at sm.`,
      planted: bp === 'sm' ? 'sev1' : 'fit',
      axis: 'width',
      text,
      family,
      stack: ['Arial', 'sans-serif'],
      breakpoint: /** @type {any} */ (bp),
      fontSizePx: HEADLINE_SIZES[bp],
      weight: 700,
      role: 'headline',
      overBy: bp === 'sm' ? 0.16 : -0.22,
    });
  }
});

// ---------------------------------------------------------------------------
// B. Body copy that overflows at every breakpoint, on the height axis
// ---------------------------------------------------------------------------

PARAGRAPHS.forEach((text, i) => {
  const family = ['Source Sans Pro', 'Open Sans', 'Noto Sans', 'Merriweather'][i];
  const stack = i === 3 ? ['Georgia', 'serif'] : ['Arial', 'sans-serif'];
  for (const bp of ['sm', 'md', 'lg']) {
    plant({
      id: `B${i}-${bp}`,
      group: 'body-every-breakpoint',
      note: `Body copy in a column sized for ${family}; the substitution to ${firstAvailable([family, ...stack])} adds a line at every breakpoint.`,
      planted: 'sev1',
      axis: 'height',
      text,
      family,
      stack,
      breakpoint: /** @type {any} */ (bp),
      fontSizePx: bp === 'sm' ? 15 : bp === 'md' ? 16 : 18,
      containerWidthPx: bp === 'sm' ? 350 : bp === 'md' ? 460 : 700,
      overBy: 0.22,
    });
  }
});

// ---------------------------------------------------------------------------
// C. A face substitution that pushes text over by about 3%
//    The container fits the requested face exactly. The *only* thing that
//    overflows it is the substitution, and it lands just past the 2% line — the
//    hardest true positive in the corpus, and the one §22.2 is really about.
// ---------------------------------------------------------------------------

[
  { family: 'Source Sans Pro', stack: ['Segoe UI', 'Arial'], text: HEADLINES[5], size: 34 },
  { family: 'Barlow', stack: ['Segoe UI', 'Arial'], text: HEADLINES[6], size: 30 },
  { family: 'Source Sans Pro', stack: ['Segoe UI', 'Arial'], text: SUBHEADS[2].slice(0, 74), size: 20 },
].forEach((spec, i) => {
  const resolved = firstAvailable([spec.family, ...spec.stack]);
  const requestedWidth = measureText(spec.text, { family: spec.family, fontSizePx: spec.size, weight: 600 });
  const resolvedWidth = measureText(spec.text, { family: resolved, fontSizePx: spec.size, weight: 600 });
  const over = resolvedWidth / requestedWidth - 1;
  plant({
    id: `C${i}`,
    group: 'substitution-3pct',
    note: `Container sized to fit ${spec.family} exactly; substituting ${resolved} widens the line by ${(over * 100).toFixed(2)}%.`,
    planted: 'sev1',
    axis: 'width',
    text: spec.text,
    family: spec.family,
    stack: spec.stack,
    breakpoint: 'md',
    fontSizePx: spec.size,
    weight: 600,
    role: 'headline',
    overBy: over,
  });
});

// ---------------------------------------------------------------------------
// D. The widest pure substitution this fallback set can produce, and gross
//    overflow at 40% of the container.
// ---------------------------------------------------------------------------

[
  { family: 'Calibri', stack: ['Verdana'], text: HEADLINES[0], size: 32, embeddable: false },
  { family: 'EB Garamond', stack: ['Verdana', 'Georgia'], text: HEADLINES[1], size: 30 },
].forEach((spec, i) => {
  const resolved = firstAvailable([spec.family, ...spec.stack]);
  const over = measureText(spec.text, { family: resolved, fontSizePx: spec.size })
    / measureText(spec.text, { family: spec.family, fontSizePx: spec.size }) - 1;
  plant({
    id: `D${i}`,
    group: 'substitution-widest',
    note: `${spec.family} → ${resolved} is the widest substitution in this fallback set: ${(over * 100).toFixed(1)}%.`,
    planted: 'sev1',
    axis: 'width',
    text: spec.text,
    family: spec.family,
    stack: spec.stack,
    breakpoint: 'md',
    fontSizePx: spec.size,
    role: 'headline',
    overBy: over,
  });
});

[
  { text: HEADLINES[2], family: 'Playfair Display', stack: ['Georgia', 'serif'], size: 44, bp: 'md' },
  { text: HEADLINES[3], family: 'Montserrat', stack: ['Arial'], size: 30, bp: 'sm' },
  { text: SUBHEADS[0].slice(0, 96), family: 'Lato', stack: ['Arial'], size: 22, bp: 'lg' },
].forEach((spec, i) => {
  plant({
    id: `D4${i}`,
    group: 'gross-40pct',
    note: 'A headline written for a wider container, dropped into a narrow one, with the substitution on top: 40% over.',
    planted: 'sev1',
    axis: 'width',
    text: spec.text,
    family: spec.family,
    stack: spec.stack,
    breakpoint: /** @type {any} */ (spec.bp),
    fontSizePx: spec.size,
    weight: 700,
    role: 'headline',
    overBy: 0.40,
  });
});

// ---------------------------------------------------------------------------
// E. text-transform: uppercase
//    An eyebrow or a button label set in caps measures nothing like the string
//    in the model, and the model is what a naive check would measure.
// ---------------------------------------------------------------------------

[
  { text: LABELS[2], planted: 'sev1', overBy: 0.19 },
  { text: HEADLINES[7], planted: 'sev1', overBy: 0.11 },
  { text: LABELS[7], planted: 'fit', overBy: -0.28 },
  { text: LABELS[5], planted: 'fit', overBy: -0.35 },
].forEach((spec, i) => {
  plant({
    id: `E${i}`,
    group: 'uppercase',
    note: 'Uppercase transform applied before measurement; the untransformed string would fit.',
    planted: /** @type {any} */ (spec.planted),
    axis: 'width',
    text: spec.text,
    family: 'Inter',
    stack: ['Arial', 'sans-serif'],
    breakpoint: 'md',
    fontSizePx: 18,
    weight: 600,
    textTransform: 'uppercase',
    role: 'eyebrow',
    overBy: spec.overBy,
  });
});

// ---------------------------------------------------------------------------
// F. letter-spacing
// ---------------------------------------------------------------------------

[
  { spacing: 1.8, planted: 'sev1', overBy: 0.13, text: LABELS[0] },
  { spacing: 2.4, planted: 'sev1', overBy: 0.24, text: LABELS[3] },
  { spacing: 0.4, planted: 'fit', overBy: -0.2, text: LABELS[1] },
  { spacing: 1.2, planted: 'fit', overBy: -0.3, text: LABELS[4] },
].forEach((spec, i) => {
  plant({
    id: `F${i}`,
    group: 'letter-spacing',
    note: `letter-spacing: ${spec.spacing}px, which adds one advance per character on top of the substitution.`,
    planted: /** @type {any} */ (spec.planted),
    axis: 'width',
    text: spec.text,
    family: 'Work Sans',
    stack: ['Segoe UI', 'Arial'],
    breakpoint: 'md',
    fontSizePx: 13,
    weight: 600,
    letterSpacingPx: spec.spacing,
    role: 'provenance',
    overBy: spec.overBy,
  });
});

// ---------------------------------------------------------------------------
// G. Unbreakable runs: German compounds and long tokens
//    These wrap normally and still overflow, because no break opportunity
//    exists inside the token. `overflow-wrap: break-word` rescues one of them,
//    and that one must not fire.
// ---------------------------------------------------------------------------

GERMAN_COMPOUNDS.slice(0, 3).forEach((word, i) => {
  const width = measureText(word, { family: 'Arial', fontSizePx: 20, weight: 400 });
  plant({
    id: `G${i}`,
    group: 'german-compound',
    note: 'A single German compound wider than its column, with no break opportunity inside it.',
    planted: 'sev1',
    axis: 'width',
    text: `Die ${word} ist entscheidend.`,
    family: 'Open Sans',
    stack: ['Arial', 'sans-serif'],
    breakpoint: 'sm',
    fontSizePx: 20,
    whiteSpace: 'normal',
    overflowWrap: 'normal',
    containerWidthPx: q(width * 0.7),
    role: 'paragraph',
    overBy: 0,
  });
});

plant({
  id: 'G3',
  group: 'german-compound',
  note: 'The same compound with `overflow-wrap: break-word`, which breaks it and must not fire.',
  planted: 'fit',
  axis: 'width',
  text: `Die ${GERMAN_COMPOUNDS[0]} ist entscheidend.`,
  family: 'Open Sans',
  stack: ['Arial', 'sans-serif'],
  breakpoint: 'sm',
  fontSizePx: 20,
  whiteSpace: 'normal',
  overflowWrap: 'break-word',
  containerWidthPx: q(measureText(GERMAN_COMPOUNDS[0], { family: 'Arial', fontSizePx: 20 }) * 0.7),
  role: 'paragraph',
  overBy: 0,
});

LONG_TOKENS.forEach((token, i) => {
  plant({
    id: `G4${i}`,
    group: 'long-token',
    note: 'A file path or identifier pasted into body copy: one token, no spaces, wider than the column.',
    planted: 'sev1',
    axis: 'width',
    text: `Asset reference: ${token}`,
    family: 'Inter',
    stack: ['Arial'],
    breakpoint: 'md',
    fontSizePx: 16,
    whiteSpace: 'normal',
    overflowWrap: 'normal',
    containerWidthPx: q(measureText(token, { family: 'Arial', fontSizePx: 16 }) * 0.6),
    role: 'paragraph',
    overBy: 0,
  });
});

GERMAN_SENTENCES.forEach((text, i) => {
  plant({
    id: `G5${i}`,
    group: 'german-sentence',
    note: 'German body copy: longer words, fewer break opportunities, more lines than the English it was translated from.',
    planted: 'sev1',
    axis: 'height',
    text,
    family: 'Source Sans Pro',
    stack: ['Arial'],
    breakpoint: 'md',
    fontSizePx: 16,
    containerWidthPx: 420,
    overBy: 0.30,
  });
});

// ---------------------------------------------------------------------------
// H. CJK
//    Every codepoint advances a full em in a Latin fallback, and the run breaks
//    between characters rather than at spaces.
// ---------------------------------------------------------------------------

CJK.forEach((text, i) => {
  const overflows = i < 2;
  plant({
    id: `H${i}`,
    group: 'cjk-height',
    note: overflows
      ? 'Japanese/Chinese copy in a box sized from the English source: every character is a full em wide.'
      : 'The same shape, in a box sized for the translated length.',
    planted: overflows ? 'sev1' : 'fit',
    axis: 'height',
    text,
    family: 'Noto Sans',
    stack: ['Arial', 'sans-serif'],
    breakpoint: 'md',
    fontSizePx: 16,
    containerWidthPx: 380,
    overBy: overflows ? 0.35 : -0.30,
  });
});

plant({
  id: 'H4',
  group: 'cjk-nowrap',
  note: 'A CJK headline in a no-wrap container.',
  planted: 'sev1',
  axis: 'width',
  text: CJK[1],
  family: 'Noto Sans',
  stack: ['Arial', 'sans-serif'],
  breakpoint: 'sm',
  fontSizePx: 22,
  role: 'headline',
  overBy: 0.28,
});

plant({
  id: 'H5',
  group: 'cjk-nowrap',
  note: 'A short CJK label that fits its chip comfortably.',
  planted: 'fit',
  axis: 'width',
  text: '出所あり',
  family: 'Noto Sans',
  stack: ['Arial', 'sans-serif'],
  breakpoint: 'md',
  fontSizePx: 12,
  role: 'provenance',
  overBy: -0.32,
});

// ---------------------------------------------------------------------------
// I. -webkit-line-clamp
//    Clamped text *fits* by construction. The defect is the sentence that
//    silently disappeared, which a height check alone reports as a pass.
// ---------------------------------------------------------------------------

[
  { text: PARAGRAPHS[0], lost: 1, planted: 'sev2' },
  { text: PARAGRAPHS[1], lost: 1, planted: 'sev2' },
  { text: PARAGRAPHS[2], lost: 3, planted: 'sev1' },
  { text: SUBHEADS[0], lost: 2, planted: 'sev1' },
].forEach((spec, i) => {
  plant({
    id: `I${i}`,
    group: 'line-clamp',
    note: `Clamped ${spec.lost} line${spec.lost === 1 ? '' : 's'} short of the copy it was given.`,
    planted: /** @type {any} */ (spec.planted),
    axis: 'clamp',
    text: spec.text,
    family: 'Lato',
    stack: ['Arial'],
    breakpoint: 'md',
    fontSizePx: 16,
    containerWidthPx: 440,
    lostLines: spec.lost,
  });
});

plant({
  id: 'I4',
  group: 'line-clamp',
  note: 'A clamp with more lines than the copy needs: nothing is truncated, nothing must fire.',
  planted: 'fit',
  axis: 'clamp',
  text: LABELS[2],
  family: 'Lato',
  stack: ['Arial'],
  breakpoint: 'md',
  fontSizePx: 16,
  containerWidthPx: 440,
  lostLines: -2,
});

// ---------------------------------------------------------------------------
// J. Negative cases: copy that fits comfortably and must stay silent.
//    A detector that fires here is worse than none, because it teaches the
//    seller to ignore the panel.
// ---------------------------------------------------------------------------

const book = new SeedBook('pitchproof-overflow-corpus');
const rng = book.stream('validate/corpus');

const NEGATIVE_FAMILIES = [
  { family: 'Inter', stack: ['Arial', 'sans-serif'] },
  { family: 'Lato', stack: ['Segoe UI', 'Arial'] },
  { family: 'Merriweather', stack: ['Georgia', 'serif'] },
  { family: 'Source Serif Pro', stack: ['Times New Roman', 'serif'] },
  { family: 'Arial', stack: ['sans-serif'] },
  { family: 'Georgia', stack: ['serif'] },
];

NEGATIVE_FAMILIES.forEach((face, i) => {
  const headline = HEADLINES[rng.nextInt(HEADLINES.length)];
  plant({
    id: `J${i}w`,
    group: 'negative-width',
    note: `${face.family} headline with ample room on the width axis.`,
    planted: 'fit',
    axis: 'width',
    text: headline,
    family: face.family,
    stack: face.stack,
    breakpoint: /** @type {any} */ (['sm', 'md', 'lg'][i % 3]),
    fontSizePx: [24, 32, 44][i % 3],
    weight: 700,
    role: 'headline',
    overBy: -(0.18 + rng.nextFloat() * 0.25),
  });
  const paragraph = PARAGRAPHS[rng.nextInt(PARAGRAPHS.length)];
  plant({
    id: `J${i}h`,
    group: 'negative-height',
    note: `${face.family} body copy in a column with room for another two lines.`,
    planted: 'fit',
    axis: 'height',
    text: paragraph,
    family: face.family,
    stack: face.stack,
    breakpoint: /** @type {any} */ (['sm', 'md', 'lg'][i % 3]),
    fontSizePx: 16,
    containerWidthPx: [340, 480, 720][i % 3],
    overBy: -(0.20 + rng.nextFloat() * 0.2),
  });
});

LABELS.slice(0, 4).forEach((text, i) => {
  plant({
    id: `J9${i}`,
    group: 'negative-label',
    note: 'A short label with room to spare — including the illustrative-content label, which must never be reported as overflowing.',
    planted: 'fit',
    axis: 'width',
    text,
    family: 'Inter',
    stack: ['Arial'],
    breakpoint: 'md',
    fontSizePx: 12,
    weight: 600,
    role: 'provenance',
    overBy: -0.24,
  });
});

// ---------------------------------------------------------------------------
// K. The tolerance band, probed from both sides.
//    Below the noise floor: silence. Inside the band: severity 2, never 1.
// ---------------------------------------------------------------------------

[
  { over: 0.002, planted: 'fit', note: 'Two tenths of a percent over — inside the measurement noise floor, so silence.' },
  { over: 0.004, planted: 'fit', note: 'Four tenths of a percent over — still inside the noise floor.' },
  { over: 0.010, planted: 'sev2', note: 'One percent over — inside the tolerance band, so a warning, never a block.' },
  { over: 0.016, planted: 'sev2', note: 'Just inside the tolerance band.' },
  { over: 0.030, planted: 'sev1', note: 'Just outside the tolerance band: clipped.' },
  { over: 0.055, planted: 'sev1', note: 'Comfortably outside the band.' },
].forEach((spec, i) => {
  plant({
    id: `K${i}`,
    group: 'tolerance-band',
    note: spec.note,
    planted: /** @type {any} */ (spec.planted),
    axis: 'width',
    text: HEADLINES[i % HEADLINES.length],
    family: 'Inter',
    stack: ['Arial'],
    breakpoint: 'md',
    fontSizePx: 30,
    weight: 700,
    role: 'headline',
    overBy: spec.over,
  });
});

[
  { over: 0.003, planted: 'fit' },
  { over: 0.013, planted: 'sev2' },
  { over: 0.045, planted: 'sev1' },
].forEach((spec, i) => {
  plant({
    id: `K9${i}`,
    group: 'tolerance-band-height',
    note: 'The same band, on the height axis.',
    planted: /** @type {any} */ (spec.planted),
    axis: 'height',
    text: PARAGRAPHS[i % PARAGRAPHS.length],
    family: 'Open Sans',
    stack: ['Arial'],
    breakpoint: 'lg',
    fontSizePx: 18,
    containerWidthPx: 640,
    overBy: spec.over,
  });
});

// ---------------------------------------------------------------------------
// L. No-wrap contexts at every breakpoint, including a face that is embeddable
//    and therefore does not substitute at all.
// ---------------------------------------------------------------------------

['sm', 'md', 'lg'].forEach((bp, i) => {
  plant({
    id: `L${i}`,
    group: 'nowrap-breakpoints',
    note: 'A no-wrap metadata row: the excess is clipped, not wrapped.',
    planted: 'sev1',
    axis: 'width',
    text: `${LABELS[2]} · ${LABELS[4]} · ${LABELS[6]}`,
    family: 'Poppins',
    stack: ['Arial'],
    breakpoint: /** @type {any} */ (bp),
    fontSizePx: 14,
    role: 'meta',
    overBy: 0.18,
  });
});

plant({
  id: 'L3',
  group: 'embeddable-face',
  note: 'A licensed font file was supplied, so no substitution happens and the container that fits the requested face is the container that fits.',
  planted: 'fit',
  axis: 'width',
  text: HEADLINES[4],
  family: 'Poppins',
  stack: ['Arial'],
  breakpoint: 'md',
  fontSizePx: 36,
  weight: 700,
  role: 'headline',
  embeddable: true,
  overBy: -0.06,
});

plant({
  id: 'L4',
  group: 'embeddable-face',
  note: 'The same headline, same container, without the licensed file: the substitution alone takes it over.',
  planted: 'sev1',
  axis: 'width',
  text: HEADLINES[4],
  family: 'Poppins',
  stack: ['Arial'],
  breakpoint: 'md',
  fontSizePx: 36,
  weight: 700,
  role: 'headline',
  embeddable: false,
  overBy: 0.09,
});

// ---------------------------------------------------------------------------

/** Every planted case, frozen so a test cannot edit the corpus into passing. */
export const CORPUS = Object.freeze(CASES.map((c) => Object.freeze(c)));

/** Counts by planted intent, for the test's report header. */
export const CORPUS_STATS = CORPUS.reduce((acc, c) => {
  acc.total++;
  acc[c.planted] = (acc[c.planted] || 0) + 1;
  acc.groups.add(c.group);
  acc.breakpoints.add(c.breakpoint);
  return acc;
}, { total: 0, groups: new Set(), breakpoints: new Set() });
