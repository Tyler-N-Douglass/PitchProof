/**
 * §17.4 — overflow detection measured against a planted-defect corpus.
 *
 *   > a synthetic corpus with planted overflow at known locations; measure
 *   > precision and recall; assert recall ≥ 0.98 for severity-1 overflow.
 *   > Planted-defect corpora are the only honest way to know a detector works.
 *
 * ## The oracle
 *
 * Ground truth is computed **in this file**, by the code below, and
 * `src/validate/` is never consulted to produce it. The oracle re-implements,
 * independently:
 *
 *   - family lookup and the weight→table decision,
 *   - glyph advance summation, including the accented-Latin and CJK rules,
 *   - `text-transform` and `letter-spacing`,
 *   - break-opportunity segmentation and greedy line breaking,
 *   - the width, height and clamp verdicts, and the severity classification.
 *
 * Two things it deliberately shares with the engine, and the reason for each:
 *
 *   1. **The published metric data** — the Adobe Core-14 AFM advance tables and
 *      the per-family width scales, imported from `core/text-metrics.js`. These
 *      are published constants, not algorithm: re-typing the same numbers into
 *      this file would produce an identical answer while merely looking more
 *      independent. The question "are these numbers right?" is a different
 *      question, and it is answered by a different test —
 *      `overflow-browser.test.mjs` lays the same cases out in real Chromium and
 *      reports the residual.
 *   2. **The threshold constants and the grading policy** — 2% of the container
 *      for severity 1, 0.5% for the noise floor, and "text cut with an ellipsis
 *      warns, text cut with nothing blocks". The oracle states them itself and a
 *      test asserts they equal the detector's exported values, so a change that
 *      would skew this measurement fails loudly instead of silently.
 *
 * **What that means, stated plainly.** The oracle proves the *arithmetic*, not
 * the *policy*. It computes independently that a box is 27.7% past its
 * container; it does not independently decide that 27.7% past an ellipsised
 * container should warn rather than block. Agreement between the two therefore
 * says the detector measures what it claims to measure — it does not say the
 * severity policy is the right one. The policy is argued in
 * `docs/decisions/L11-validate.md` (L11-D1, L11-D15), pinned by a separate
 * table-driven test below that does not go through the oracle at all, and was
 * set centrally after the §20 critic found the previous one wrong (F6).
 *
 * ## What is asserted
 *
 *   - Every case's planted intent matches the oracle's verdict. That proves the
 *     corpus is well formed: the defects really are where the corpus says they
 *     are, at the magnitude it says.
 *   - Recall ≥ 0.98 on severity-1 overflow, against the oracle.
 *   - Precision ≥ the stated floor.
 *   - The full 3×3 confusion matrix is printed, so a regression is legible
 *     rather than a single number moving.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AFM_TABLES, FAMILY_MODELS } from '../../src/core/text-metrics.js';
import { FALLBACK_CANDIDATES } from '../../src/core/text-metrics.js';
import { CORPUS, CORPUS_STATS } from '../fixtures/overflow/corpus.mjs';
import {
  detectOverflow, detectBoxOverflow, truncationMode,
  OVERFLOW_CLIP_RATIO, OVERFLOW_CLIP_MIN_PX, OVERFLOW_NOISE_RATIO, OVERFLOW_NOISE_PX,
  DEFAULT_TEXT_OVERFLOW, TEXT_OVERFLOW_MODES,
} from '../../src/validate/index.js';

// ===========================================================================
// The oracle. Nothing below this line reads `src/validate/`.
// ===========================================================================

/** The severity-1 line, restated independently. Asserted equal to the engine's. */
const ORACLE_CLIP_RATIO = 0.02;
const ORACLE_CLIP_MIN_PX = 2;
const ORACLE_NOISE_RATIO = 0.005;
const ORACLE_NOISE_PX = 0.5;
/** CSS's initial value: a box that declares no mode cuts text with no signal. */
const ORACLE_DEFAULT_TEXT_OVERFLOW = 'clip';
const UNITS = 1000;

const ORACLE_GENERICS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
]);

/** Fold a family name to a comparison key. */
function key(name) {
  return String(name || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

/** The width model for a family, chosen the way the documented model chooses it. */
function oracleModel(family) {
  const k = key(family);
  const direct = FAMILY_MODELS.find((m) => m.key === k || (m.aliases || []).includes(k));
  if (direct) return direct;
  const category = /\b(mono|code|console|courier|typewriter|terminal)\b/.test(k) ? 'mono'
    : (/\b(serif|times|georgia|garamond|baskerville|caslon|didot|bodoni|playfair|roman|book|slab)\b/.test(k) && !/sans[- ]?serif/.test(k)) ? 'serif'
      : 'sans';
  const stand = category === 'serif' ? 'times new roman' : category === 'mono' ? 'courier new' : 'arial';
  return FAMILY_MODELS.find((m) => m.key === stand);
}

/**
 * Table and scale for a family at a weight. The weight model is the one
 * documented in `core/text-metrics.js`: a family with its own bold table uses
 * it at 600 and above, and a family without one is synthesised wider by the
 * published Helvetica-Bold/Helvetica ratio.
 */
function oracleMetrics(family, weight) {
  const model = oracleModel(family);
  const bold = weight >= 600;
  const table = AFM_TABLES[bold && model.boldBase ? model.boldBase : model.base];
  let scale = model.widthScale;
  if (!model.boldBase) {
    const t = weight <= 400 ? 0 : Math.min(1, (weight - 400) / 300);
    scale *= 1 + t * 0.0429;
  } else if (weight > 700) {
    scale *= 1 + Math.min(1, (weight - 700) / 200) * 0.03;
  } else if (weight > 400 && weight < 600) {
    scale *= 1 + ((weight - 400) / 200) * 0.028;
  } else if (weight < 400) {
    scale *= 1 - Math.min(1, (400 - weight) / 300) * 0.035;
  }
  return { table, scale };
}

/** Codepoints that take a full em in a Latin fallback. */
function oracleIsWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xff60);
}

/** Punctuation outside ASCII that the corpus uses, mapped to its published width twin. */
const ORACLE_PUNCTUATION = {
  0x00a0: ' ', 0x00b7: '.', 0x2010: '-', 0x2013: '-', 0x2014: 'm',
  0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"', 0x2026: 'W',
};

/** Advance of one codepoint, in units of 1/1000 em. */
function oracleAdvance(cp, met) {
  if (cp >= 32 && cp <= 126) return met.table.widths[cp - 32] * met.scale;
  if (cp === 9) return met.table.widths[0] * 8 * met.scale;
  if (cp === 10 || cp === 13) return 0;
  const twin = ORACLE_PUNCTUATION[cp];
  if (twin) return met.table.widths[twin.charCodeAt(0) - 32] * met.scale;
  // Accented Latin composes from a base glyph and a mark, so it takes the base
  // glyph's advance. Unicode canonical decomposition finds that base for us.
  const stripped = String.fromCodePoint(cp).normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (stripped.length === 1) {
    const base = stripped.codePointAt(0);
    if (base !== cp && base >= 32 && base <= 126) return met.table.widths[base - 32] * met.scale;
  }
  if (oracleIsWide(cp)) return UNITS;
  return met.table.defaultWidth * met.scale;
}

/** `text-transform`, applied before anything is measured. */
function oracleTransform(text, transform) {
  if (transform === 'uppercase') return String(text).toUpperCase();
  if (transform === 'lowercase') return String(text).toLowerCase();
  if (transform === 'capitalize') return String(text).replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
  return String(text);
}

/** Width of a run, in CSS px, with letter-spacing counted once per character. */
function oracleWidth(run, style, met) {
  let units = 0;
  let count = 0;
  for (const ch of run) { units += oracleAdvance(ch.codePointAt(0), met); count++; }
  let width = (units * style.fontSizePx) / UNITS;
  if (style.letterSpacingPx) width += style.letterSpacingPx * count;
  return width;
}

/** Characters a line may break after even with no space present. */
const ORACLE_BREAK_AFTER = new Set(['-', '‐', '‒', '–', '—', '/', '​', '­']);

/**
 * Split into break-opportunity pieces. A piece carries the text that stays on
 * the line and the collapsible whitespace that followed it.
 */
function oraclePieces(text) {
  const out = [];
  const chars = [...text];
  let current = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      let ws = '';
      while (i < chars.length && (chars[i] === ' ' || chars[i] === '\t')) { ws += chars[i]; i++; }
      i--;
      out.push({ text: current, space: ws });
      current = '';
      continue;
    }
    if (ch === ' ') { current += ch; continue; }   // no-break space never breaks
    current += ch;
    const last = i === chars.length - 1;
    if (!last && (ORACLE_BREAK_AFTER.has(ch) || oracleIsWide(ch.codePointAt(0)))) {
      out.push({ text: current, space: '' });
      current = '';
    }
  }
  if (current) out.push({ text: current, space: '' });
  return out;
}

/** Greedy line breaking. Returns line widths and the count, unclamped. */
function oracleLayout(text, style, options) {
  const met = oracleMetrics(style.family, style.weight ?? 400);
  const transformed = oracleTransform(text, style.textTransform);
  const wrap = options.whiteSpace === 'nowrap' || options.whiteSpace === 'pre' ? 'none' : 'wrap';
  const maxWidth = options.maxWidthPx;
  const w = (s) => oracleWidth(s, style, met);

  if (wrap === 'none') {
    const width = w(transformed);
    return { widths: [width], lineCount: 1, maxWidth: width, unbreakable: width > maxWidth ? [transformed] : [] };
  }

  const pieces = oraclePieces(transformed.replace(/\s*\n\s*/g, ' '));
  /** @type {number[]} */
  const widths = [];
  const unbreakable = [];
  let line = '';
  const flush = () => { widths.push(w(line.replace(/[ \t]+$/, ''))); };

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const joined = line === '' ? piece.text : line + piece.text;
    if (line !== '' && w(joined) > maxWidth) {
      flush();
      line = piece.text;
    } else {
      line = joined;
    }
    if (line === piece.text && w(line) > maxWidth && maxWidth > 0) {
      if (options.overflowWrap === 'break-word' || options.overflowWrap === 'anywhere') {
        // Break the run character by character, keeping the tail on the line.
        let acc = '';
        for (const ch of piece.text) {
          if (acc !== '' && w(acc + ch) > maxWidth) { widths.push(w(acc)); acc = ch; } else acc += ch;
        }
        line = acc;
      } else {
        unbreakable.push(piece.text);
      }
    }
    if (piece.space && i < pieces.length - 1) line += piece.space;
  }
  flush();
  return { widths, lineCount: widths.length, maxWidth: Math.max(...widths), unbreakable };
}

/** The severity an excess earns from its magnitude alone, restated independently. */
function oracleClassify(excessPx, extentPx) {
  if (!(excessPx > 0) || !(extentPx > 0)) return 0;
  if (excessPx <= Math.max(ORACLE_NOISE_PX, ORACLE_NOISE_RATIO * extentPx)) return 0;
  return excessPx > Math.max(ORACLE_CLIP_MIN_PX, ORACLE_CLIP_RATIO * extentPx) ? 1 : 2;
}

/** Does the box tell the viewer that text was cut? */
function oracleSignalled(box) {
  const mode = box.textOverflow === 'clip' || box.textOverflow === 'ellipsis'
    ? box.textOverflow
    : ORACLE_DEFAULT_TEXT_OVERFLOW;
  return mode === 'ellipsis';
}

/** Truncation the viewer can see warns; truncation the viewer cannot see blocks. */
function oracleNarrow(severity, signalled) {
  if (severity === 0) return 0;
  return signalled ? 2 : severity;
}

/** The face that will actually render, walked through the declared stack. */
function oracleResolveFamily(box, brand) {
  const face = (brand.faces || []).find((f) => key(f.family) === key(box.style.family));
  const stack = face ? face.fallbackStack : [box.style.family];
  const available = new Set(FALLBACK_CANDIDATES.map(key));
  for (const f of brand.faces || []) if (f.embeddable) available.add(key(f.family));
  for (const name of stack) {
    const k = key(name);
    if (ORACLE_GENERICS.has(k) || available.has(k)) return name;
  }
  return 'sans-serif';
}

/**
 * The oracle's verdict for one corpus case: the severity of each axis.
 * @returns {{width: 0|1|2, height: 0|1|2, clamp: 0|1|2, lines: number, maxWidth: number}}
 */
function oracleVerdict(kase) {
  const box = kase.measurement.boxes[0];
  const resolved = oracleResolveFamily(box, kase.brand);
  const style = { ...box.style, family: resolved };
  const laid = oracleLayout(box.text, style, {
    maxWidthPx: box.containerWidthPx,
    whiteSpace: box.whiteSpace,
    overflowWrap: box.overflowWrap,
  });
  const lineHeightPx = (style.lineHeight ?? 1.2) * style.fontSizePx;
  const signalled = oracleSignalled(box);

  const width = oracleNarrow(oracleClassify(laid.maxWidth - box.containerWidthPx, box.containerWidthPx), signalled);

  const cap = Number.isFinite(box.maxLines) && box.maxLines > 0 ? Math.floor(box.maxLines) : 0;
  const renderedLines = cap ? Math.min(laid.lineCount, cap) : laid.lineCount;
  // The height axis is not narrowed: `text-overflow` is a horizontal property,
  // and text that runs past the bottom of its box does so with no ellipsis
  // anywhere.
  const height = box.containerHeightPx > 0
    ? oracleClassify(renderedLines * lineHeightPx - box.containerHeightPx, box.containerHeightPx)
    : 0;

  const lost = cap ? Math.max(0, laid.lineCount - cap) : 0;
  const clamp = lost === 0 ? 0 : oracleNarrow(1, signalled);

  return { width, height, clamp, lines: laid.lineCount, maxWidth: laid.maxWidth, resolved, lost, signalled };
}

// ===========================================================================
// Tests
// ===========================================================================

const AXES = ['width', 'height', 'clamp'];

/** The detector's severity per axis for a case. */
function detectorVerdict(kase) {
  const findings = detectOverflow(kase.measurement, kase.brand);
  /** @type {{width: 0|1|2, height: 0|1|2, clamp: 0|1|2}} */
  const out = { width: 0, height: 0, clamp: 0 };
  for (const f of findings) {
    assert.equal(f.code, 'TEXT_OVERFLOW', `${kase.id}: detectOverflow must only produce TEXT_OVERFLOW`);
    const axis = f.detail.axis;
    assert.ok(AXES.includes(axis), `${kase.id}: unknown axis ${axis}`);
    // Two findings on one axis of one box would be a bug in the detector.
    assert.equal(out[axis], 0, `${kase.id}: two findings on the ${axis} axis`);
    out[axis] = f.severity;
  }
  return out;
}

test('the corpus is large enough and covers every planted shape §17.4', () => {
  assert.ok(CORPUS.length >= 60, `the corpus must carry at least 60 cases, has ${CORPUS.length}`);
  assert.ok(CORPUS_STATS.sev1 >= 20, 'the corpus must plant a substantial number of blocking defects');
  assert.ok(CORPUS_STATS.fit >= 20, 'the corpus must carry a matching set of negative cases');
  assert.equal(CORPUS_STATS.breakpoints.size, 3, 'every breakpoint must be represented');
  const groups = [...CORPUS_STATS.groups];
  for (const required of [
    'headline-sm-only', 'body-every-breakpoint', 'substitution-3pct', 'gross-40pct',
    'uppercase', 'letter-spacing', 'german-compound', 'cjk-height', 'line-clamp',
    'negative-width', 'negative-height', 'tolerance-band',
  ]) {
    assert.ok(groups.includes(required), `the corpus is missing the "${required}" group`);
  }
  const ids = CORPUS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'every case needs a unique id');
});

/**
 * The distribution check the §20 critic ran by hand (F7) and this suite did not.
 *
 * The corpus reported recall 1.0000 over 93 cases that contained **zero**
 * `maxLines: 1` boxes, while every severity-1 overflow the product produced on
 * its own corpus was a one-line clamp. A figure measured over a distribution
 * that excludes the failure mode is not a measurement of the detector, and the
 * only way that stays fixed is if the distribution itself is asserted.
 */
test('the corpus covers the shapes the layouts actually emit §17.4', () => {
  const boxes = CORPUS.map((c) => c.measurement.boxes[0]);
  const count = (pred) => boxes.filter(pred).length;

  // The class F7 found missing: a one-line clamp, which is what
  // `data-pp-clamp="1"` becomes in `scenes.css` and what every panel title and
  // panel meta row in four of the eight layouts carries.
  assert.ok(count((b) => b.maxLines === 1) >= 10,
    `the corpus must exercise the one-line clamp; it has ${count((b) => b.maxLines === 1)}`);

  // Both truncation modes, in quantity, because the grading turns on them.
  assert.ok(count((b) => b.textOverflow === 'ellipsis') >= 8, 'ellipsised boxes must be represented');
  assert.ok(count((b) => b.textOverflow === 'clip') >= 5, 'clipping boxes must be represented');
  assert.ok(count((b) => b.textOverflow === undefined) >= 5,
    'and boxes that declare no mode at all, which must grade as CSS default');

  // Both modes at a one-line clamp specifically — the F6 pair.
  assert.ok(count((b) => b.maxLines === 1 && b.textOverflow === 'ellipsis') >= 6);
  assert.ok(count((b) => b.maxLines === 1 && b.textOverflow === 'clip') >= 3);

  // The roles the layouts give those boxes, by name.
  for (const role of ['panelMeta', 'panelTitle']) {
    assert.ok(count((b) => b.role === role) >= 3, `the corpus must carry the ${role} role`);
  }

  // At all three breakpoints, which is where a one-line clamp changes verdict.
  for (const bp of ['sm', 'md', 'lg']) {
    assert.ok(
      CORPUS.some((c) => c.breakpoint === bp && c.measurement.boxes[0].maxLines === 1),
      `no one-line clamp case at ${bp}`,
    );
  }

  // Positive and negative on both sides of the discriminator.
  const plantedFor = (pred, planted) => CORPUS.filter((c) => pred(c.measurement.boxes[0]) && c.planted === planted).length;
  assert.ok(plantedFor((b) => b.maxLines === 1 && b.textOverflow === 'ellipsis', 'sev2') >= 4, 'ellipsised overflow must be planted as a warning');
  assert.ok(plantedFor((b) => b.maxLines === 1 && b.textOverflow === 'ellipsis', 'fit') >= 3, 'and the same row fitting must be planted as silence');
  assert.ok(plantedFor((b) => b.maxLines === 1 && b.textOverflow === 'clip', 'sev1') >= 3, 'clipped overflow must be planted as blocking');
  assert.ok(plantedFor((b) => b.maxLines === 1 && b.textOverflow === 'clip', 'fit') >= 1);

  // And the multi-line clamp the critic paired it against, on both settings.
  assert.ok(count((b) => b.maxLines > 1 && b.textOverflow === 'ellipsis') >= 2);
  assert.ok(count((b) => b.maxLines > 1 && b.textOverflow === 'clip') >= 1);
});

/**
 * The policy, pinned without the oracle.
 *
 * The critic's second point about §17.4 is that an independently written oracle
 * proves the *arithmetic* and not the *policy*: it recomputes that a box is 27.7%
 * past its container, but it encodes the same decision about what that should
 * mean. So the decision is stated once more here, as a table, checked straight
 * against `detectBoxOverflow` with no oracle in the path. If the policy changes,
 * this fails whether or not the oracle was changed to match.
 */
test('the grading policy is what it says it is, checked without the oracle', () => {
  const brand = CORPUS[0].brand;
  /** One box, one knob: only `textOverflow` differs between the rows. */
  const box = (textOverflow, extra = {}) => ({
    elementId: 'el_policy',
    role: 'panelMeta',
    text: 'www.northwind-industrial.example/insights/fouling-resistant-heat-exchangers',
    style: { family: 'Arial', weight: 400, fontSizePx: 12, lineHeight: 1.3 },
    containerWidthPx: 200,
    containerHeightPx: 400,
    whiteSpace: 'nowrap',
    overflowWrap: 'normal',
    ...(textOverflow === undefined ? {} : { textOverflow }),
    ...extra,
  });
  const severityOfAxis = (b, axis) => {
    const found = detectBoxOverflow(b, { sceneId: 'sc_p', breakpoint: 'md', index: 0 }, brand)
      .filter((f) => f.detail.axis === axis);
    return found.length ? found[0].severity : 0;
  };

  // Width axis: the same overflow, three declarations, three verdicts.
  assert.equal(severityOfAxis(box('clip'), 'width'), 1, 'text cut with no signal blocks');
  assert.equal(severityOfAxis(box('ellipsis'), 'width'), 2, 'text cut with an ellipsis warns');
  assert.equal(severityOfAxis(box(undefined), 'width'), 1, "an undeclared mode grades as CSS's own default, which is clip");

  // Clamp axis: the same discriminator, and no line-count rule anywhere in it.
  const clamped = (to, maxLines) => box(to, {
    text: PARAGRAPH_FOR_CLAMP, whiteSpace: 'normal', maxLines, containerWidthPx: 300, containerHeightPx: 400,
  });
  assert.equal(severityOfAxis(clamped('clip', 1), 'clamp'), 1);
  assert.equal(severityOfAxis(clamped('ellipsis', 1), 'clamp'), 2);
  assert.equal(severityOfAxis(clamped('clip', 2), 'clamp'), 1);
  assert.equal(severityOfAxis(clamped('ellipsis', 2), 'clamp'), 2,
    'losing several lines behind an ellipsis grades the same as losing one — the signal decides, not the quantity');
  assert.equal(severityOfAxis(clamped('ellipsis', 3), 'clamp'), 2);

  // Height axis is untouched by the mode: `text-overflow` is horizontal, and
  // text running past the bottom of a box carries no ellipsis anywhere.
  const tall = (to) => box(to, {
    text: PARAGRAPH_FOR_CLAMP, whiteSpace: 'normal', containerWidthPx: 300, containerHeightPx: 40,
  });
  assert.equal(severityOfAxis(tall('clip'), 'height'), 1);
  assert.equal(severityOfAxis(tall('ellipsis'), 'height'), 1);

  // And `truncationMode` reports the default honestly rather than silently.
  assert.deepEqual(truncationMode({}), { mode: 'clip', signalled: false, known: false });
  assert.deepEqual(truncationMode({ textOverflow: 'ellipsis' }), { mode: 'ellipsis', signalled: true, known: true });
  assert.deepEqual(truncationMode({ textOverflow: 'nonsense' }), { mode: 'clip', signalled: false, known: false });
});

/** A paragraph long enough to overflow every clamp the policy test applies. */
const PARAGRAPH_FOR_CLAMP =
  'A campaign that ships in nine markets today needs nine briefs, nine rounds of layout, nine review '
  + 'threads and nine sets of corrections. The work is not the writing; the work is the retyping.';

test('the oracle states the same thresholds the detector uses', () => {
  assert.equal(ORACLE_CLIP_RATIO, OVERFLOW_CLIP_RATIO);
  assert.equal(ORACLE_CLIP_MIN_PX, OVERFLOW_CLIP_MIN_PX);
  assert.equal(ORACLE_NOISE_RATIO, OVERFLOW_NOISE_RATIO);
  assert.equal(ORACLE_NOISE_PX, OVERFLOW_NOISE_PX);
  assert.equal(ORACLE_DEFAULT_TEXT_OVERFLOW, DEFAULT_TEXT_OVERFLOW);
  assert.deepEqual(TEXT_OVERFLOW_MODES, ['clip', 'ellipsis']);
});

test('every planted defect is where the corpus says it is (oracle vs. intent)', () => {
  /** @type {string[]} */
  const mismatches = [];
  for (const kase of CORPUS) {
    const verdict = oracleVerdict(kase);
    const worst = Math.min(
      ...[verdict.width, verdict.height, verdict.clamp].map((s) => (s === 0 ? 9 : s)),
    );
    const observed = worst === 9 ? 'fit' : worst === 1 ? 'sev1' : 'sev2';
    if (observed !== kase.planted) {
      mismatches.push(`${kase.id} (${kase.group}, ${kase.axis}, overBy=${kase.overBy.toFixed?.(4) ?? kase.overBy}): planted ${kase.planted}, oracle says ${observed} — w:${verdict.width} h:${verdict.height} c:${verdict.clamp}`);
    }
  }
  assert.deepEqual(mismatches, [], `the corpus is not well formed:\n  ${mismatches.join('\n  ')}`);
});

test('§17.4 — recall ≥ 0.98 for severity-1 overflow, precision above the stated floor', () => {
  /** The floor this suite holds precision to. */
  const PRECISION_FLOOR = 0.98;
  const RECALL_FLOOR = 0.98;

  /** @type {Record<string, Record<string, number>>} 3×3 confusion matrix */
  const matrix = { none: { none: 0, sev2: 0, sev1: 0 }, sev2: { none: 0, sev2: 0, sev1: 0 }, sev1: { none: 0, sev2: 0, sev1: 0 } };
  const label = (s) => (s === 0 ? 'none' : s === 1 ? 'sev1' : 'sev2');

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  /** @type {string[]} */
  const misses = [];
  /** @type {string[]} */
  const spurious = [];

  for (const kase of CORPUS) {
    const truth = oracleVerdict(kase);
    const found = detectorVerdict(kase);
    for (const axis of AXES) {
      matrix[label(truth[axis])][label(found[axis])]++;
      const truthBlocks = truth[axis] === 1;
      const foundBlocks = found[axis] === 1;
      if (truthBlocks && foundBlocks) truePositive++;
      else if (truthBlocks && !foundBlocks) { falseNegative++; misses.push(`${kase.id}/${axis} (${kase.group}): oracle sev1, detector ${label(found[axis])}`); }
      else if (!truthBlocks && foundBlocks) { falsePositive++; spurious.push(`${kase.id}/${axis} (${kase.group}): oracle ${label(truth[axis])}, detector sev1`); }
      else trueNegative++;
    }
  }

  const recall = truePositive / (truePositive + falseNegative);
  const precision = truePositive / (truePositive + falsePositive);
  const exact = AXES.length * CORPUS.length
    - Object.entries(matrix).reduce((n, [t, row]) => n + Object.entries(row).reduce((m, [f, c]) => m + (t === f ? 0 : c), 0), 0);

  const rows = ['none', 'sev2', 'sev1'];
  const lines = [
    '',
    `overflow corpus — ${CORPUS.length} cases × ${AXES.length} axes = ${CORPUS.length * AXES.length} judgements`,
    `  planted: ${CORPUS_STATS.sev1} severity-1, ${CORPUS_STATS.sev2} severity-2, ${CORPUS_STATS.fit} negative`,
    '',
    '  confusion matrix (rows: oracle, columns: detector)',
    `           ${rows.map((r) => r.padStart(7)).join('')}`,
    ...rows.map((r) => `    ${r.padEnd(7)}${rows.map((c) => String(matrix[r][c]).padStart(7)).join('')}`),
    '',
    `  severity-1 recall    ${recall.toFixed(4)}   (${truePositive} found of ${truePositive + falseNegative})`,
    `  severity-1 precision ${precision.toFixed(4)}   (${truePositive} of ${truePositive + falsePositive} calls)`,
    `  exact severity agreement ${exact}/${CORPUS.length * AXES.length}`,
    '',
  ];
  if (misses.length) lines.push('  missed:', ...misses.map((m) => `    ${m}`), '');
  if (spurious.length) lines.push('  spurious:', ...spurious.map((m) => `    ${m}`), '');
  console.log(lines.join('\n'));

  assert.ok(truePositive + falseNegative >= 25, 'the corpus must carry enough severity-1 truth to measure recall meaningfully');
  assert.ok(
    recall >= RECALL_FLOOR,
    `§17.4 requires recall ≥ ${RECALL_FLOOR} for severity-1 overflow; measured ${recall.toFixed(4)}\n  ${misses.join('\n  ')}`,
  );
  assert.ok(
    precision >= PRECISION_FLOOR,
    `precision floor is ${PRECISION_FLOOR}; measured ${precision.toFixed(4)}\n  ${spurious.join('\n  ')}`,
  );
});

test('the detector agrees with the oracle on severity-2 as well, not only on blocking', () => {
  /** @type {string[]} */
  const disagreements = [];
  for (const kase of CORPUS) {
    const truth = oracleVerdict(kase);
    const found = detectorVerdict(kase);
    for (const axis of AXES) {
      if (truth[axis] !== found[axis]) {
        disagreements.push(`${kase.id}/${axis}: oracle ${truth[axis]}, detector ${found[axis]}`);
      }
    }
  }
  // Total agreement is the target; the assertion allows none, because every
  // disagreement here is either a detector bug or a corpus case sitting on the
  // threshold, and both deserve to be looked at rather than tolerated.
  assert.deepEqual(disagreements, [], `severity disagreements:\n  ${disagreements.join('\n  ')}`);
});

test('every group in the corpus is actually exercised, positives and negatives alike', () => {
  /** @type {Map<string, {sev1: number, fit: number}>} */
  const byGroup = new Map();
  for (const kase of CORPUS) {
    if (!byGroup.has(kase.group)) byGroup.set(kase.group, { sev1: 0, fit: 0 });
    const bucket = byGroup.get(kase.group);
    if (kase.planted === 'fit') bucket.fit++;
    else bucket.sev1++;
  }
  // Groups that exist to plant a defect must plant one; groups that exist as
  // controls must contain a control.
  assert.ok(byGroup.get('headline-sm-only').sev1 >= 5);
  assert.ok(byGroup.get('headline-sm-only').fit >= 10);
  assert.ok(byGroup.get('negative-width').fit >= 5);
  assert.ok(byGroup.get('negative-height').fit >= 5);
  assert.ok(byGroup.get('substitution-3pct').sev1 >= 3);
  assert.ok(byGroup.get('line-clamp').sev1 >= 2);
});

test('detection is deterministic — the same case twice, byte for byte', () => {
  for (const kase of CORPUS.slice(0, 30)) {
    const a = JSON.stringify(detectOverflow(kase.measurement, kase.brand));
    const b = JSON.stringify(detectOverflow(kase.measurement, kase.brand));
    assert.equal(a, b, `${kase.id} is not deterministic`);
  }
});

test('every severity-1 overflow finding tells the seller what to do about it', () => {
  for (const kase of CORPUS) {
    for (const finding of detectOverflow(kase.measurement, kase.brand)) {
      if (finding.severity !== 1) continue;
      assert.ok(finding.message.length > 80, `${kase.id}: message is too thin to act on`);
      assert.match(finding.message, /\d/, `${kase.id}: a message with no number is not actionable`);
      assert.ok(finding.locus.sceneId, `${kase.id}: a finding needs a locus`);
      assert.equal(finding.detail.breakpoint, kase.breakpoint);
      // The message names the face that actually renders — the whole point of
      // §22.2 is that it is not the face that was asked for.
      assert.ok(
        finding.message.includes(kase.resolvedFamily),
        `${kase.id}: the message must name the resolved face ${kase.resolvedFamily}`,
      );
    }
  }
});
