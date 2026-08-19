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
  layoutText, metricDelta, normalizeFamily,
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
 * **What decides whether truncation blocks an emit is whether the viewer can
 * see that it happened.**
 *
 * A box that clips loses text silently: the sentence simply stops, and nobody in
 * the room knows there was more. That is the §22.2 defect — invisible until it
 * isn't — and it blocks. A box that ellipsises loses the same text but says so:
 * the trailing `…` is a signal the viewer reads, and a designed truncation of a
 * long URL into a one-line meta row is a layout decision rather than a defect.
 * It warns.
 *
 * This replaced an earlier rule that graded the clamp axis by *how many lines*
 * were lost, which produced an inconsistency the §20 critic caught (F6): losing
 * two lines of the client's own copy to a multi-line clamp graded 2, while
 * losing the tail of a URL to a one-line clamp graded 1. Grading on the signal
 * rather than the quantity removes the inconsistency and puts the line where the
 * product actually needs it.
 *
 * The field comes from L8 (`SceneMeasurement.boxes[].textOverflow`), derived
 * from the same design tokens that produce the artifact's CSS.
 */
export const TEXT_OVERFLOW_MODES = ['clip', 'ellipsis'];

/**
 * CSS's initial value for `text-overflow`, and therefore what a box that does
 * not declare one does. Defaulting the other way would silently downgrade real
 * data loss to a warning on every box whose measurement predates the field,
 * which is the one direction §14 does not allow.
 */
export const DEFAULT_TEXT_OVERFLOW = 'clip';

/**
 * Whether a box's truncation is visible to the viewer.
 *
 * `known` is false when the measurement carries no `textOverflow` at all; the
 * box is then graded as clipping (CSS's initial value), and the finding says the
 * mode was not declared so the gap is legible rather than silent.
 *
 * @param {{textOverflow?: string}} box
 * @returns {{mode: string, signalled: boolean, known: boolean}}
 */
export function truncationMode(box) {
  const declared = box && typeof box.textOverflow === 'string' ? box.textOverflow : null;
  const known = declared !== null && TEXT_OVERFLOW_MODES.includes(declared);
  const mode = known ? declared : DEFAULT_TEXT_OVERFLOW;
  return { mode, signalled: mode === 'ellipsis', known };
}

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
  let chosenIsGeneric = false;
  for (const name of stack) {
    const key = normalizeFamily(name);
    if (GENERIC_FAMILIES.has(key) || availKeys.has(key)) {
      chosen = name;
      chosenIsGeneric = GENERIC_FAMILIES.has(key) && !availKeys.has(key);
      break;
    }
  }

  const base = resolveFace(requested, { available, weight });
  // A stack that names no concrete available family before its generic — or
  // names none at all — leaves the artifact rendering in whatever the platform
  // happens to default to. That is the case worth offering to fix; a stack that
  // already lands on a real family is doing its job.
  const landsOnDefault = chosen === null || chosenIsGeneric;
  /** Merge the declared stack with the recommended one, keeping declaration order. */
  const merged = () => {
    const out = stack.slice();
    for (const name of base.stack) {
      if (!out.some((s) => normalizeFamily(s) === normalizeFamily(name))) out.push(name);
    }
    return out;
  };
  if (chosen === null) return { ...base, stack: stack.length ? merged() : base.stack, landsOnDefault };
  if (normalizeFamily(chosen) === normalizeFamily(base.resolved)) {
    return { ...base, stack: merged(), landsOnDefault };
  }
  return {
    ...base,
    resolved: chosen,
    stack,
    // §4 permits `metricDelta: null`, and `core/text-metrics.js` returns it for
    // a family this build has no published metrics for. Comparing an unknown
    // family to the model it already fell back to would report the substitution
    // as metrically perfect, which is exactly backwards for §22.2 — the
    // prospect's custom webfont is precisely the family we do not know.
    metricDelta: base.known ? metricDelta(requested, chosen, weight) : null,
    available: normalizeFamily(chosen) === normalizeFamily(requested),
    landsOnDefault,
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
 * @property {'clip'|'ellipsis'} [textOverflow]  L8's declared truncation mode
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
 * Apply the truncation policy to a magnitude verdict: a box that ellipsises
 * never blocks, because the viewer can see the cut; a box that clips is graded
 * on magnitude alone.
 * @param {0|1|2} severity
 * @param {{signalled: boolean}} truncation
 * @returns {0|1|2}
 */
function narrowIfSignalled(severity, truncation) {
  if (severity === 0) return 0;
  return truncation.signalled ? 2 : severity;
}

/**
 * What the box does with text it cannot fit, as a sentence.
 * @param {{mode: string, signalled: boolean, known: boolean}} truncation
 * @returns {string}
 */
function truncationClause(truncation) {
  if (!truncation.known) {
    return 'The measurement declares no text-overflow mode, so the box is graded as clipping — CSS\'s own default — and the text is assumed to be cut with no signal to the viewer.';
  }
  return truncation.signalled
    ? 'The box truncates with a visible ellipsis, so the viewer can see that something was cut; the tail is still gone.'
    : 'The box clips, so the text is cut with nothing to tell the viewer that anything is missing.';
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
  const delta = advanceDeltaOf(face);
  const drift = delta === null
    ? 'how much that moves the advance is unknown — this build holds no published metrics for the requested face, so the measurement above is the fallback\'s own'
    : delta === 1
      ? 'identical advance widths'
      : `${delta > 1 ? '+' : ''}${((delta - 1) * 100).toFixed(1)}% average advance`;
  return `"${face.requested}" is not available to the artifact and substitutes to ${face.resolved} (${drift}), which is what this was measured against.`;
}

/**
 * The advance-width ratio of a substitution, or null when this build has no
 * published metrics for the requested face. `null` is a real answer, not a
 * missing one, and §4 permits it.
 * @param {{metricDelta: {avgAdvance: number}|null}} face
 * @returns {number|null}
 */
export function advanceDeltaOf(face) {
  const delta = face && face.metricDelta;
  return delta && typeof delta.avgAdvance === 'number' ? delta.avgAdvance : null;
}

/**
 * The identity of one overflowing box, as a string.
 *
 * **This is the answer to CRITIQUE-2 C1's second half (L8-D10).** The key used
 * to be `box.elementId` alone, and `elementId` is the nearest *revealable
 * ancestor* — the thing a beat reveals — so every text run inside one panel
 * shares it. A headline and a body paragraph that both overflow in the same
 * cell minted the same finding id, `sortFindings` dropped one as a duplicate,
 * and the seller was shown one defect where there were two. Twenty findings
 * vanished that way on the corpus proof, and per-finding recall sat at 0.7721
 * where per-box recall was 0.9921.
 *
 * Argued in full in `docs/decisions/L11-validate.md` L11-D27; the contract gap
 * it works around — §4's locus cannot name a text run — is dispute 8.
 *
 * Four things identify the box, and each is a function of the *layout and the
 * scene model* rather than of the measurement:
 *
 *  - **`elementId`** — which revealable element it lives under. This is what a
 *    consumer needs to jump to it, and it is minted by `elementId(sceneId,
 *    path)` from the scene's id and the box's structural path, so it is the
 *    same string on every render of the same scene.
 *  - **`role`** — the `data-pp-tx` role the layout stamped. A headline and a
 *    subhead under one element differ here, which is the collapse this fixes.
 *  - **`ordinal`** — the box's position among the boxes sharing that
 *    `(elementId, role)` pair, in document order. Two bullets in one list, or
 *    two cells with the same role in one panel, differ here. `(elementId, role,
 *    ordinal)` is unique within a measurement by construction.
 *  - **the breakpoint**, added by the caller, because §4's `locus` cannot carry
 *    one and the same box at `sm` and at `lg` is two defects with two fixes
 *    (docs/disputes/L11-validate.md #1, #8).
 *
 * **Why this is stable across a re-render.** Nothing in it is measured. Not the
 * excess, not the line count, not the resolved face, and — deliberately — not
 * the text. A proof re-swept after a font substitution, a breakpoint change or
 * a threshold change produces the same ids for the same defects, which is what
 * L11-D13 requires of every finding and what lets the studio's dismissals and
 * blocking list survive a sweep. Text is excluded for a sharper reason than
 * consistency: the way a seller *fixes* an overflow is by editing the copy, so
 * a text-derived id would churn hardest in exactly the workflow the id exists
 * to support — every keystroke would mint a new finding, and a dismissal would
 * never outlive the edit that provoked it.
 *
 * `containerId` and `slot` are deliberately **not** in the key, though both are
 * reported in `detail`. `containerId` is `slot#n` with `n` counted over the
 * whole scene, so inserting an unrelated panel earlier in the layout renumbers
 * every later box of that slot — churn with no gain, since `(elementId, role,
 * ordinal)` is already unique.
 *
 * @param {BoxMeasurement} box
 * @param {number} ordinal  position among boxes sharing this `(elementId, role)`
 * @returns {string}
 */
export function boxKey(box, ordinal) {
  const el = box && typeof box.elementId === 'string' && box.elementId ? box.elementId : '-';
  const role = String((box && box.role) || 'text');
  const n = Number.isFinite(ordinal) && ordinal >= 0 ? Math.floor(ordinal) : 0;
  return `${el}|${role}|${n}`;
}

/**
 * The `(elementId, role)` ordinal of every box in a measurement, in document
 * order — `SceneMeasurement.boxes` is the order `collectTextBoxes` walked the
 * rendered tree, which is the order the browser lays them out.
 *
 * Scoping the counter to the pair rather than to the whole box list is what
 * keeps an id local: adding a paragraph to one panel renumbers that panel's
 * paragraphs and nothing else, where a flat index would renumber every box
 * after it in the scene.
 *
 * @param {BoxMeasurement[]} boxes
 * @returns {number[]} parallel to `boxes`
 */
export function boxOrdinals(boxes) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return (boxes || []).map((box) => {
    const el = box && typeof box.elementId === 'string' && box.elementId ? box.elementId : '-';
    const pair = `${el}|${String((box && box.role) || 'text')}`;
    const n = seen.get(pair) || 0;
    seen.set(pair, n + 1);
    return n;
  });
}

/**
 * Findings for one text box at one breakpoint.
 *
 * @param {BoxMeasurement} box
 * @param {object} where
 * @param {string} where.sceneId
 * @param {string} where.breakpoint
 * @param {number} [where.index]        the box's position in the measurement. Reported by
 *                                      `detectOverflow` for a caller that wants it; **not** part
 *                                      of the finding's identity — a flat index renumbers every
 *                                      box after an insertion, which is churn (L11-D27).
 * @param {number} [where.ordinal]      its position among boxes sharing its `(elementId, role)`,
 *                                      from `boxOrdinals()`. Defaults to 0, which is right for a
 *                                      box measured on its own.
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
  const ordinal = Number.isFinite(where.ordinal) ? Number(where.ordinal) : 0;
  const key = boxKey(box, ordinal);
  const nowrap = box.whiteSpace === 'nowrap' || box.whiteSpace === 'pre';
  const truncation = truncationMode(box);

  /** @type {any[]} */
  const findings = [];

  /** Shared machine-readable context for every axis. */
  const common = {
    breakpoint: where.breakpoint,
    elementId: box.elementId || null,
    role: box.role || null,
    // The three fields that, with `elementId` and `role`, name *which* box this
    // is. `orderInElement` is the disambiguator the key turns on; `containerId`
    // and `slot` are L8's declared extensions (API.md Part 3 → L8) and are
    // reported so a consumer can group siblings without re-measuring.
    orderInElement: ordinal,
    containerId: typeof box.containerId === 'string' ? box.containerId : null,
    slot: typeof box.slot === 'string' ? box.slot : null,
    requestedFamily: face.requested,
    resolvedFamily: face.resolved,
    textOverflow: truncation.mode,
    textOverflowDeclared: truncation.known,
    faceAvailable: face.available,
    advanceDelta: advanceDeltaOf(face),
    fontSizePx: style.fontSizePx,
    lineCount: full.lineCount,
  };

  // --- width axis --------------------------------------------------------
  const widthExcess = full.maxLineWidthPx - containerW;
  // The magnitude decides whether there is anything to say; the truncation mode
  // decides whether it blocks. Text cut with a visible ellipsis is a designed
  // truncation the viewer can see; text cut with nothing is data lost silently.
  const widthSeverity = narrowIfSignalled(classifyExcess(widthExcess, containerW), truncation);
  if (widthSeverity) {
    const ratio = widthExcess / containerW;
    const smaller = fittingFontSizePx(box, style);
    const chars = fittingCharCount(box, style);
    // A no-wrap box is *always* "unbreakable" by construction, so the wrap
    // remedy would be wrong advice there; the two causes are checked in the
    // order that makes the suggestion true.
    const cause = nowrap
      ? ' The box does not wrap, so the excess is clipped rather than pushed to a second line.'
      : full.unbreakable.length > 0
        ? ` The run "${sample(full.unbreakable[0], 32)}" is wider than the container on its own and has no break opportunity inside it — allow \`overflow-wrap: break-word\` or hyphenate it.`
        : '';
    findings.push(makeFinding({
      code: 'TEXT_OVERFLOW',
      severity: widthSeverity,
      locus: { sceneId: where.sceneId },
      key: `${where.breakpoint}|${key}|width`,
      autoFixAvailable: false,
      message: `${boxLabel(box)} is ${px(widthExcess)}px wider than its ${px(containerW)}px container at ${where.breakpoint} (${pct(ratio)} over): "${sample(text)}". ${truncationClause(truncation)} ${substitutionClause(face)}${cause} It fits at ${smaller === null ? 'no size above 4px' : `${smaller}px`}, or at about ${chars} of its ${[...text].length} characters.`,
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
    // Clamped text *fits* by construction, so a height check reports a pass. The
    // defect is the copy that silently vanished — and, exactly as on the width
    // axis, whether that blocks depends on whether the viewer is told.
    const severity = narrowIfSignalled(1, truncation);
    const droppedText = full.lines.slice(maxLines).map((l) => l.text).join(' ').trim();
    const chars = fittingCharCount(box, style);
    findings.push(makeFinding({
      code: 'TEXT_OVERFLOW',
      severity,
      locus: { sceneId: where.sceneId },
      key: `${where.breakpoint}|${key}|clamp`,
      autoFixAvailable: false,
      message: `${boxLabel(box)} is clamped to ${maxLines} line${maxLines === 1 ? '' : 's'} at ${where.breakpoint} but needs ${full.lineCount}, so ${lostLines} line${lostLines === 1 ? '' : 's'} of copy is truncated and never reaches the viewer: "${sample(droppedText)}". ${truncationClause(truncation)} ${substitutionClause(face)} Rewrite to about ${chars} characters, raise the clamp, or reduce the size.`,
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
  const ordinals = boxOrdinals(measurement.boxes);
  measurement.boxes.forEach((box, index) => {
    if (!box) return;
    out.push(...detectBoxOverflow(box, { sceneId, breakpoint, index, ordinal: ordinals[index] }, brand));
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
