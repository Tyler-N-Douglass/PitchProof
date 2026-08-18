/**
 * §22.2 — text overflow after font substitution.
 *
 * §14 calls this "the highest-value check in the entire tool", and §22.2 says
 * why: font swap is what breaks reskinned layouts, and it breaks silently. The
 * detector therefore has three properties, and each one is load-bearing.
 *
 * **1. It measures the face that will actually render, never the one that was
 * asked for.** A `TypeFace` in a `BrandSystem` names the prospect's typeface.
 * That file is almost never embeddable (§7: `embeddable` is false unless the
 * user supplied a licensed font), so what renders on the client's laptop is a
 * fallback. `resolveBoxFace()` walks the CSS font stack exactly as a browser
 * does — first available family wins — and every measurement below uses the
 * *resolved* family. A detector that measured the requested family would pass
 * every proof and catch nothing, which is the failure §22.2 is about.
 *
 * **2. It covers both axes and the clamp.** Width overflow for no-wrap contexts
 * and for segments no line break can rescue (German compounds, long tokens,
 * unspaced CJK runs); height overflow from wrapped line-count × line-height
 * against the container; and `-webkit-line-clamp`, where the text *fits* by
 * construction and the defect is the sentence that silently vanished.
 *
 * **3. Its severity threshold is a stated number with a reason.** See
 * `OVERFLOW_CLIP_RATIO` below and `docs/decisions/L11-validate.md`.
 *
 * @module validate/overflow
 */

import {
  layoutText, measureText, metricsFor, metricDelta, normalizeFamily,
  parseFamilyList, resolveFace, FALLBACK_CANDIDATES,
} from '../core/text-metrics.js';
import { makeFinding, sortFindings, px, pct } from './finding.js';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Below this the engine says nothing at all.
 *
 * Any deterministic model of text has a floor of disagreement with a real
 * rasteriser: subpixel advance rounding, kerning pairs the AFM table does not
 * carry, hinting at small sizes. Firing inside that floor would produce findings
 * that no browser can reproduce, and a check that cries wolf gets switched off —
 * which, for the check §14 calls the most valuable in the tool, is the worst
 * available outcome. Half a percent of the container, or half a pixel,
 * whichever is larger.
 */
export const OVERFLOW_NOISE_RATIO = 0.005;
/** @see OVERFLOW_NOISE_RATIO */
export const OVERFLOW_NOISE_PX = 0.5;

/**
 * The severity-1 line: excess beyond **2% of the container extent** is visibly
 * clipped text and blocks emit.
 *
 * The number is chosen against a measured quantity rather than taste. The
 * browser cross-check (`test/validate/overflow-browser.test.mjs`) lays a sample
 * of the corpus out in real Chromium and reports the residual between this
 * engine and the rasteriser; the tolerance is set above that residual, so a
 * severity-1 finding can never be an artifact of the model — if the engine says
 * the text is more than 2% over, no amount of measurement disagreement explains
 * it, and the text really is clipped. Inside the band the two can legitimately
 * disagree, so the finding narrows to severity 2 and warns instead of blocking.
 *
 * The absolute floor stops a tiny container from blocking on a two-pixel excess
 * that no eye resolves.
 */
export const OVERFLOW_CLIP_RATIO = 0.02;
/** @see OVERFLOW_CLIP_RATIO */
export const OVERFLOW_CLIP_MIN_PX = 2;

/**
 * Lines lost to `-webkit-line-clamp` before truncation blocks emit. One lost
 * line is the ordinary, deliberate teaser clamp — worth a warning, because the
 * seller should know the last line is gone. Two or more lost lines is a
 * paragraph the client will never see, presented as if it were complete.
 */
export const CLAMP_BLOCKING_LOST_LINES = 2;

/** CSS generic families: always available, and they resolve to a platform face. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
]);

// ---------------------------------------------------------------------------
// Face resolution — the "post-substitution" half of §22.2
// ---------------------------------------------------------------------------

/**
 * Families an emitted artifact can count on rendering: the system families in
 * `FALLBACK_CANDIDATES`, plus any brand face the user supplied a licensed font
 * file for (§7 — `embeddable` is the only thing that makes a brand face a
 * guarantee rather than a hope).
 *
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @returns {string[]}
 */
export function availableFamilies(brand) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const key = normalizeFamily(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const face of (brand && brand.faces) || []) if (face && face.embeddable) add(face.family);
  for (const name of FALLBACK_CANDIDATES) add(name);
  return out;
}

/**
 * Resolve a text box's `font-family` the way a browser does: take the declared
 * stack, and render in the first family that is actually present. The brand's
 * own `fallbackStack` is part of that stack, so a brand that declared a
 * metric-compatible fallback gets credit for it.
 *
 * @param {string} family          the box's `font-family`, one name or a CSS list
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @param {number} [weight]
 * @returns {import('../core/text-metrics.js').FaceResolution}
 */
export function resolveBoxFace(family, brand, weight = 400) {
  const declared = parseFamilyList(String(family || ''));
  const requested = declared[0] || 'sans-serif';
  const available = availableFamilies(brand);
  const availKeys = new Set(available.map(normalizeFamily));

  // The declared stack, extended with the brand's own fallback stack for the
  // requested family when the brand has an opinion about it.
  const face = ((brand && brand.faces) || []).find((f) => f && normalizeFamily(f.family) === normalizeFamily(requested));
  /** @type {string[]} */
  const stack = [];
  const push = (name) => {
    if (!name) return;
    const key = normalizeFamily(name);
    if (!key || stack.some((s) => normalizeFamily(s) === key)) return;
    stack.push(name);
  };
  for (const name of declared) push(name);
  if (face) for (const name of face.fallbackStack || []) push(name);

  let chosen = null;
  for (const name of stack) {
    const key = normalizeFamily(name);
    if (GENERIC_FAMILIES.has(key) || availKeys.has(key)) { chosen = name; break; }
  }

  const base = resolveFace(requested, { available, weight });
  /** Merge the declared stack with the recommended one, keeping declaration order. */
  const merged = () => {
    const out = stack.slice();
    for (const name of base.stack) {
      if (!out.some((s) => normalizeFamily(s) === normalizeFamily(name))) out.push(name);
    }
    return out;
  };
  if (chosen === null) return { ...base, stack: stack.length ? merged() : base.stack };
  if (normalizeFamily(chosen) === normalizeFamily(base.resolved)) {
    return { ...base, stack: merged() };
  }
  return {
    ...base,
    resolved: chosen,
    stack,
    metricDelta: metricDelta(requested, chosen, weight),
    available: normalizeFamily(chosen) === normalizeFamily(requested),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BoxMeasurement
 * @property {string|null} elementId
 * @property {string} role
 * @property {string} text
 * @property {import('../core/text-metrics.js').TextStyle} style
 * @property {number} containerWidthPx
 * @property {number} containerHeightPx
 * @property {string} [whiteSpace]
 * @property {string} [overflowWrap]
 * @property {number} [maxLines]
 */

/**
 * Lay a box out in the face that will actually render it.
 *
 * The returned `full` layout ignores `maxLines`, because the clamp is a
 * *consequence* to be reported, not a fact to be measured around: the honest
 * height of the content is the height it would take unclamped.
 *
 * @param {BoxMeasurement} box
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @returns {{face: import('../core/text-metrics.js').FaceResolution,
 *            style: import('../core/text-metrics.js').TextStyle,
 *            full: import('../core/text-metrics.js').TextLayout,
 *            lineHeightPx: number, renderedLines: number, renderedHeightPx: number,
 *            lostLines: number}}
 */
export function layOutBox(box, brand) {
  const requestedStyle = box.style || {};
  const weight = requestedStyle.weight ?? 400;
  const face = resolveBoxFace(requestedStyle.family, brand, weight);
  const style = { ...requestedStyle, family: face.resolved };
  const full = layoutText(String(box.text ?? ''), style, {
    maxWidthPx: box.containerWidthPx,
    whiteSpace: /** @type {any} */ (box.whiteSpace || 'normal'),
    overflowWrap: /** @type {any} */ (box.overflowWrap || 'normal'),
  });
  const lineHeightPx = full.lineHeightPx;
  const maxLines = Number.isFinite(box.maxLines) && box.maxLines > 0 ? Math.floor(box.maxLines) : 0;
  const renderedLines = maxLines ? Math.min(full.lineCount, maxLines) : full.lineCount;
  return {
    face,
    style,
    full,
    lineHeightPx,
    renderedLines,
    renderedHeightPx: renderedLines * lineHeightPx,
    lostLines: maxLines ? Math.max(0, full.lineCount - maxLines) : 0,
  };
}

/**
 * Classify an excess against a container extent.
 * @param {number} excessPx
 * @param {number} extentPx
 * @returns {0|1|2} 0 = nothing to report, otherwise the severity
 */
export function classifyExcess(excessPx, extentPx) {
  if (!(excessPx > 0) || !(extentPx > 0)) return 0;
  const noise = Math.max(OVERFLOW_NOISE_PX, OVERFLOW_NOISE_RATIO * extentPx);
  if (excessPx <= noise) return 0;
  const clip = Math.max(OVERFLOW_CLIP_MIN_PX, OVERFLOW_CLIP_RATIO * extentPx);
  return excessPx > clip ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Remedies — the part that makes a finding actionable
// ---------------------------------------------------------------------------

/**
 * The largest font size, in half-pixel steps, at which this box fits on both
 * axes. Returned so the message can say "39px fits" rather than "make it
 * smaller".
 * @param {BoxMeasurement} box
 * @param {import('../core/text-metrics.js').TextStyle} style
 * @returns {number|null}
 */
export function fittingFontSizePx(box, style) {
  const start = style.fontSizePx;
  if (!(start > 0)) return null;
  const fits = (size) => {
    const s = { ...style, fontSizePx: size };
    const l = layoutText(String(box.text ?? ''), s, {
      maxWidthPx: box.containerWidthPx,
      whiteSpace: /** @type {any} */ (box.whiteSpace || 'normal'),
      overflowWrap: /** @type {any} */ (box.overflowWrap || 'normal'),
    });
    if (l.maxLineWidthPx > box.containerWidthPx) return false;
    if (box.containerHeightPx > 0) {
      const lines = box.maxLines > 0 ? Math.min(l.lineCount, Math.floor(box.maxLines)) : l.lineCount;
      if (lines * l.lineHeightPx > box.containerHeightPx) return false;
      if (box.maxLines > 0 && l.lineCount > Math.floor(box.maxLines)) return false;
    } else if (box.maxLines > 0 && l.lineCount > Math.floor(box.maxLines)) return false;
    return true;
  };
  let lo = 4;
  let hi = start;
  if (fits(hi)) return hi;
  if (!fits(lo)) return null;
  for (let i = 0; i < 32 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return Math.floor(lo * 2) / 2;
}

/**
 * The longest prefix of the text, in characters, that fits at the declared size.
 * @param {BoxMeasurement} box
 * @param {import('../core/text-metrics.js').TextStyle} style
 * @returns {number}
 */
export function fittingCharCount(box, style) {
  const chars = [...String(box.text ?? '')];
  const fits = (n) => {
    const l = layoutText(chars.slice(0, n).join(''), style, {
      maxWidthPx: box.containerWidthPx,
      whiteSpace: /** @type {any} */ (box.whiteSpace || 'normal'),
      overflowWrap: /** @type {any} */ (box.overflowWrap || 'normal'),
    });
    if (l.maxLineWidthPx > box.containerWidthPx) return false;
    const cap = box.maxLines > 0 ? Math.floor(box.maxLines) : Infinity;
    if (l.lineCount > cap) return false;
    if (box.containerHeightPx > 0 && Math.min(l.lineCount, cap) * l.lineHeightPx > box.containerHeightPx) return false;
    return true;
  };
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/** Truncate a text sample for a message without splitting a surrogate pair. */
function sample(text, max = 48) {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

/** A short human name for a box, for the message. */
function boxLabel(box) {
  const role = String(box.role || 'text');
  return role.replace(/[._]/g, ' ');
}

/**
 * How the substitution contributed, as a sentence — or the empty string when the
 * requested face is the one that renders.
 * @param {import('../core/text-metrics.js').FaceResolution} face
 * @returns {string}
 */
function substitutionClause(face) {
  if (face.available && normalizeFamily(face.requested) === normalizeFamily(face.resolved)) {
    return `Set in ${face.requested}, which is the face that renders.`;
  }
  const delta = face.metricDelta.avgAdvance;
  const drift = delta === 1
    ? 'identical advance widths'
    : `${delta > 1 ? '+' : ''}${((delta - 1) * 100).toFixed(1)}% average advance`;
  return `"${face.requested}" is not available to the artifact and substitutes to ${face.resolved} (${drift}), which is what this was measured against.`;
}

/**
 * Findings for one text box at one breakpoint.
 *
 * @param {BoxMeasurement} box
 * @param {object} where
 * @param {string} where.sceneId
 * @param {string} where.breakpoint
 * @param {number} where.index
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @returns {any[]}
 */
export function detectBoxOverflow(box, where, brand) {
  const text = String(box.text ?? '');
  if (!text.trim()) return [];
  const containerW = Number(box.containerWidthPx);
  if (!(containerW > 0)) return [];

  const laid = layOutBox(box, brand);
  const { face, style, full, lineHeightPx, renderedLines, renderedHeightPx, lostLines } = laid;
  const containerH = Number(box.containerHeightPx) > 0 ? Number(box.containerHeightPx) : 0;
  const key = box.elementId || `${box.role || 'text'}#${where.index}`;
  const nowrap = box.whiteSpace === 'nowrap' || box.whiteSpace === 'pre';

  /** @type {any[]} */
  const findings = [];

  /** Shared machine-readable context for every axis. */
  const common = {
    breakpoint: where.breakpoint,
    elementId: box.elementId || null,
    role: box.role || null,
    requestedFamily: face.requested,
    resolvedFamily: face.resolved,
    faceAvailable: face.available,
    advanceDelta: face.metricDelta.avgAdvance,
    fontSizePx: style.fontSizePx,
    lineCount: full.lineCount,
  };

  // --- width axis --------------------------------------------------------
  const widthExcess = full.maxLineWidthPx - containerW;
  const widthSeverity = classifyExcess(widthExcess, containerW);
  if (widthSeverity) {
    const ratio = widthExcess / containerW;
    const smaller = fittingFontSizePx(box, style);
    const chars = fittingCharCount(box, style);
    const cause = full.unbreakable.length > 0
      ? ` The run "${sample(full.unbreakable[0], 32)}" is wider than the container on its own and has no break opportunity inside it — allow \`overflow-wrap: break-word\` or hyphenate it.`
      : nowrap
        ? ' The box does not wrap, so the excess is clipped rather than pushed to a second line.'
        : '';
    findings.push(makeFinding({
      code: 'TEXT_OVERFLOW',
      severity: widthSeverity,
      locus: { sceneId: where.sceneId },
      key: `${where.breakpoint}|${key}|width`,
      autoFixAvailable: false,
      message: `${boxLabel(box)} is ${px(widthExcess)}px wider than its ${px(containerW)}px container at ${where.breakpoint} (${pct(ratio)} over): "${sample(text)}". ${substitutionClause(face)}${cause} It fits at ${smaller === null ? 'no size above 4px' : `${smaller}px`}, or at about ${chars} of its ${[...text].length} characters.`,
      detail: {
        ...common,
        axis: 'width',
        excessPx: px(widthExcess),
        extentPx: px(containerW),
        ratio: Math.round(ratio * 10000) / 10000,
        measuredPx: px(full.maxLineWidthPx),
        unbreakable: full.unbreakable.slice(0, 3),
        suggestedFontSizePx: smaller,
        suggestedMaxChars: chars,
      },
    }));
  }

  // --- height axis -------------------------------------------------------
  if (containerH > 0) {
    const heightExcess = renderedHeightPx - containerH;
    const heightSeverity = classifyExcess(heightExcess, containerH);
    if (heightSeverity) {
      const ratio = heightExcess / containerH;
      const linesThatFit = Math.max(0, Math.floor(containerH / lineHeightPx));
      const smaller = fittingFontSizePx(box, style);
      const chars = fittingCharCount(box, style);
      findings.push(makeFinding({
        code: 'TEXT_OVERFLOW',
        severity: heightSeverity,
        locus: { sceneId: where.sceneId },
        key: `${where.breakpoint}|${key}|height`,
        autoFixAvailable: false,
        message: `${boxLabel(box)} wraps to ${renderedLines} lines at ${where.breakpoint} and needs ${px(renderedHeightPx)}px, which is ${px(heightExcess)}px more than its ${px(containerH)}px container (${pct(ratio)} over); only ${linesThatFit} line${linesThatFit === 1 ? '' : 's'} fit. Text: "${sample(text)}". ${substitutionClause(face)} It fits at ${smaller === null ? 'no size above 4px' : `${smaller}px`}, or at about ${chars} of its ${[...text].length} characters.`,
        detail: {
          ...common,
          axis: 'height',
          excessPx: px(heightExcess),
          extentPx: px(containerH),
          ratio: Math.round(ratio * 10000) / 10000,
          measuredPx: px(renderedHeightPx),
          lineHeightPx: px(lineHeightPx),
          linesThatFit,
          suggestedFontSizePx: smaller,
          suggestedMaxChars: chars,
        },
      }));
    }
  }

  // --- clamp axis --------------------------------------------------------
  if (lostLines > 0) {
    const maxLines = Math.floor(box.maxLines);
    const severity = lostLines >= CLAMP_BLOCKING_LOST_LINES ? 1 : 2;
    const droppedText = full.lines.slice(maxLines).map((l) => l.text).join(' ').trim();
    const chars = fittingCharCount(box, style);
    findings.push(makeFinding({
      code: 'TEXT_OVERFLOW',
      severity,
      locus: { sceneId: where.sceneId },
      key: `${where.breakpoint}|${key}|clamp`,
      autoFixAvailable: false,
      message: `${boxLabel(box)} is clamped to ${maxLines} line${maxLines === 1 ? '' : 's'} at ${where.breakpoint} but needs ${full.lineCount}, so ${lostLines} line${lostLines === 1 ? '' : 's'} of copy is truncated and never reaches the viewer: "${sample(droppedText)}". ${substitutionClause(face)} Rewrite to about ${chars} characters, raise the clamp, or reduce the size.`,
      detail: {
        ...common,
        axis: 'clamp',
        maxLines,
        lostLines,
        truncated: sample(droppedText, 120),
        suggestedMaxChars: chars,
      },
    }));
  }

  return findings;
}

/**
 * §22.2's detector. Runs over one scene's measurement at one breakpoint and
 * returns every overflow it can see, in canonical order.
 *
 * @param {{sceneId: string, breakpoint: string, boxes: BoxMeasurement[]}} measurement
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function detectOverflow(measurement, brand) {
  if (!measurement || !Array.isArray(measurement.boxes)) return [];
  const sceneId = String(measurement.sceneId || '');
  const breakpoint = String(measurement.breakpoint || '');
  /** @type {any[]} */
  const out = [];
  measurement.boxes.forEach((box, index) => {
    if (!box) return;
    out.push(...detectBoxOverflow(box, { sceneId, breakpoint, index }, brand));
  });
  return sortFindings(out);
}

/**
 * The advance-width penalty a brand's type substitution imposes, per face. Used
 * by the FONT_UNAVAILABLE rule to say how much the substitution moved, and by
 * the studio to show it before anything overflows.
 *
 * @param {import('../core/contracts.d.ts').BrandSystem} brand
 * @returns {{face: import('../core/contracts.d.ts').TypeFace, resolution: import('../core/text-metrics.js').FaceResolution}[]}
 */
export function faceResolutions(brand) {
  const available = availableFamilies(brand);
  return ((brand && brand.faces) || []).map((face) => {
    const weights = (face.weightsSeen || []).slice().sort((a, b) => a - b);
    const weight = face.role === 'display' ? (weights[weights.length - 1] || 700) : (weights[0] || 400);
    const base = resolveFace(face.family, { available, weight });
    // Honour the brand's own declared fallback stack, exactly as a browser would.
    const resolution = resolveBoxFace(face.family, brand, weight);
    return { face, resolution: { ...base, ...resolution } };
  });
}

/**
 * Metrics for a family, re-exported so the studio's inspector and the tests can
 * report what the engine believes without reaching into core.
 * @param {string} family
 * @param {number} [weight]
 */
export function metricsForFamily(family, weight = 400) {
  return metricsFor(family, weight);
}

export { measureText };
