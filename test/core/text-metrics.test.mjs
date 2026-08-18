/**
 * §17.3 type metrics, and the measurement service §22.2 depends on.
 *
 * Every expected value here comes from a published source — the Adobe Core-14
 * AFM files for advance widths and vertical metrics — or is derived from them
 * arithmetically inside the test. Nothing asserts against a number the
 * implementation produced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AFM_TABLES, UNITS_PER_EM, metricsFor, measureText, layoutText, metricDelta,
  resolveFace, normalizeFamily, parseFamilyList, lookupFamily, guessCategory,
  capHeightPx, xHeightPx, cssFontFamily, advanceOfString, segments, isWideCodepoint,
  FALLBACK_CANDIDATES, metricDistance,
} from '../../src/core/text-metrics.js';

/** Published AFM advance widths, spot-checked across the table. */
const AFM_SPOT = {
  Helvetica: { ' ': 278, A: 667, M: 833, W: 944, a: 556, i: 222, m: 833, '0': 556, '@': 1015 },
  'Helvetica-Bold': { ' ': 278, A: 722, M: 833, W: 944, a: 556, i: 278, m: 889, '0': 556, '@': 975 },
  'Times-Roman': { ' ': 250, A: 722, M: 889, W: 944, a: 444, i: 278, m: 778, '0': 500, '@': 921 },
  'Times-Bold': { ' ': 250, A: 722, M: 944, W: 1000, a: 500, i: 278, m: 833, '0': 500, '@': 930 },
  Courier: { ' ': 600, A: 600, M: 600, W: 600, a: 600, i: 600, m: 600, '0': 600, '@': 600 },
};

/** Published AFM vertical metrics. */
const AFM_VERTICAL = {
  Helvetica: { capHeight: 718, xHeight: 523 },
  'Helvetica-Bold': { capHeight: 718, xHeight: 532 },
  'Times-Roman': { capHeight: 662, xHeight: 450 },
  'Times-Bold': { capHeight: 676, xHeight: 461 },
  Courier: { capHeight: 562, xHeight: 426 },
};

test('the AFM tables carry the published advance widths', () => {
  for (const [name, spot] of Object.entries(AFM_SPOT)) {
    const t = AFM_TABLES[name];
    assert.ok(t, `missing table ${name}`);
    assert.equal(t.widths.length, 95, `${name}: table must cover codepoints 32..126`);
    for (const [ch, w] of Object.entries(spot)) {
      assert.equal(t.widths[ch.charCodeAt(0) - 32], w, `${name} "${ch}"`);
    }
  }
});

test('the AFM tables carry the published cap-height and x-height', () => {
  for (const [name, v] of Object.entries(AFM_VERTICAL)) {
    assert.equal(AFM_TABLES[name].capHeight, v.capHeight, `${name} capHeight`);
    assert.equal(AFM_TABLES[name].xHeight, v.xHeight, `${name} xHeight`);
  }
});

test('measured width equals the sum of published advances', () => {
  // "Hello" in Helvetica: H 722 + e 556 + l 222 + l 222 + o 556 = 2278/1000 em.
  assert.equal(measureText('Hello', { family: 'Helvetica', fontSizePx: 1000 }), 2278);
  assert.ok(Math.abs(measureText('Hello', { family: 'Helvetica', fontSizePx: 12 }) - 2278 * 12 / 1000) < 1e-9);
  // Times: H 722 + e 444 + l 278 + l 278 + o 500 = 2222.
  assert.equal(measureText('Hello', { family: 'Times New Roman', fontSizePx: 1000 }), 2222);
  // Courier is monospaced: five glyphs at 600.
  assert.equal(measureText('Hello', { family: 'Courier New', fontSizePx: 1000 }), 3000);
});

test('bold uses the bold table, not a fudge factor, where one is published', () => {
  // "Hello" in Helvetica-Bold: 722 + 556 + 278 + 278 + 611 = 2445.
  assert.equal(measureText('Hello', { family: 'Helvetica', weight: 700, fontSizePx: 1000 }), 2445);
  assert.equal(measureText('Hello', { family: 'Arial', weight: 700, fontSizePx: 1000 }), 2445);
});

test('letter-spacing and text-transform change the measurement, as they do on screen', () => {
  const base = measureText('Hello', { family: 'Arial', fontSizePx: 16 });
  assert.equal(measureText('Hello', { family: 'Arial', fontSizePx: 16, letterSpacingPx: 2 }), base + 10);
  const upper = measureText('Hello', { family: 'Helvetica', fontSizePx: 1000, textTransform: 'uppercase' });
  // HELLO: 722 + 667 + 556 + 556 + 778 = 3279.
  assert.equal(upper, 3279);
});

test('metric-compatible families measure identically', () => {
  const s = 'The quick brown fox jumps over the lazy dog';
  const groups = [['Arial', 'Helvetica', 'Liberation Sans', 'Arimo'], ['Times New Roman', 'Liberation Serif', 'Tinos'], ['Courier New', 'Liberation Mono', 'Cousine']];
  for (const group of groups) {
    const widths = group.map((f) => measureText(s, { family: f, fontSizePx: 16 }));
    for (const w of widths) assert.equal(w, widths[0], group.join('/'));
  }
});

test('cap-height and x-height in pixels follow the published ratios', () => {
  assert.equal(capHeightPx('Helvetica', 100), 71.8);
  assert.equal(xHeightPx('Helvetica', 100), 52.3);
  assert.equal(capHeightPx('Times New Roman', 1000), 662);
  assert.equal(capHeightPx('Courier New', 1000), 571);
});

test('metricDelta is the ratio of requested to fallback, as §4 defines it', () => {
  const same = metricDelta('Arial', 'Helvetica');
  assert.ok(Math.abs(same.avgAdvance - 1) < 1e-9);
  // Arial capHeight 716 vs Helvetica 718.
  assert.ok(Math.abs(same.capHeight - 716 / 718) < 1e-6);

  const wide = metricDelta('Verdana', 'Arial');
  assert.ok(wide.avgAdvance > 1.05, `Verdana is materially wider than Arial: ${wide.avgAdvance}`);
  const inverse = metricDelta('Arial', 'Verdana');
  assert.ok(Math.abs(wide.avgAdvance * inverse.avgAdvance - 1) < 1e-5, 'the delta must be reciprocal');
});

test('greedy line breaking matches a hand-computed break', () => {
  // At 1000px em, "The quick" = T611+h556+e556+space278+q556+u556+i222+c500+k500 = 4335.
  const style = { family: 'Helvetica', fontSizePx: 1000 };
  const l = layoutText('The quick brown', style, { maxWidthPx: 4600 });
  assert.equal(l.lines.length, 2);
  assert.equal(l.lines[0].text.trim(), 'The quick');
  assert.equal(l.lines[1].text, 'brown');
  // A recorded line width excludes the whitespace the break collapsed.
  assert.equal(l.lines[0].widthPx, 611 + 556 + 556 + 278 + 556 + 556 + 222 + 500 + 500);
});

test('layout height is line count times line height', () => {
  const l = layoutText('one two three four five six seven eight nine ten', { family: 'Arial', fontSizePx: 16, lineHeight: 1.5 }, { maxWidthPx: 120 });
  assert.equal(l.lineHeightPx, 24);
  assert.equal(l.heightPx, l.lineCount * 24);
  assert.ok(l.lineCount >= 3);
  for (const line of l.lines) assert.ok(line.widthPx <= 120 + 1e-9, `"${line.text}" is ${line.widthPx}px`);
});

test('a word wider than its container is reported, not silently wrapped', () => {
  const opts = { maxWidthPx: 60 };
  const style = { family: 'Arial', fontSizePx: 16 };
  const strict = layoutText('Unternehmensberatungsgesellschaft', style, opts);
  assert.equal(strict.lineCount, 1);
  assert.deepEqual(strict.unbreakable, ['Unternehmensberatungsgesellschaft']);
  assert.ok(strict.maxLineWidthPx > 60, 'the overflow must be visible in the measurement');

  const broken = layoutText('Unternehmensberatungsgesellschaft', style, { ...opts, overflowWrap: 'break-word' });
  assert.ok(broken.lineCount > 1);
  assert.deepEqual(broken.unbreakable, []);
  assert.equal(broken.lines.map((l) => l.text).join(''), 'Unternehmensberatungsgesellschaft');
});

test('nowrap measures one line however long it gets', () => {
  const l = layoutText('a b c d e f g h i j k l m n o p', { family: 'Arial', fontSizePx: 16 }, { maxWidthPx: 40, whiteSpace: 'nowrap' });
  assert.equal(l.lineCount, 1);
  assert.ok(l.maxLineWidthPx > 40);
  assert.equal(l.unbreakable.length, 1);
});

test('line clamping reports that it truncated', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve';
  const l = layoutText(text, { family: 'Arial', fontSizePx: 16 }, { maxWidthPx: 100, maxLines: 2 });
  assert.equal(l.lineCount, 2);
  assert.equal(l.clamped, true);
  const unclamped = layoutText(text, { family: 'Arial', fontSizePx: 16 }, { maxWidthPx: 100 });
  assert.equal(unclamped.clamped, false);
  assert.ok(unclamped.lineCount > 2);
});

test('hard newlines only break under pre white-space', () => {
  const style = { family: 'Arial', fontSizePx: 16 };
  assert.equal(layoutText('a\nb', style, { maxWidthPx: 500 }).lineCount, 1);
  assert.equal(layoutText('a\nb', style, { maxWidthPx: 500, whiteSpace: 'pre-wrap' }).lineCount, 2);
});

test('breaks happen after hyphens and around CJK, and never inside a non-breaking space', () => {
  assert.deepEqual(segments('state-of-the-art').map((s) => s.text), ['state-', 'of-', 'the-', 'art']);
  assert.deepEqual(segments('a b').map((s) => s.text), ['a b']);
  assert.equal(segments('日本語').length, 3);
  assert.ok(isWideCodepoint('日'.codePointAt(0)));
  assert.ok(!isWideCodepoint('a'.codePointAt(0)));
});

test('accented Latin measures as its base letter, and unknown codepoints get a documented default', () => {
  const style = { family: 'Helvetica', fontSizePx: 1000 };
  assert.equal(measureText('é', style), measureText('e', style));
  assert.equal(measureText('Ü', style), measureText('U', style));
  assert.equal(measureText('—', style), measureText('m', style), 'em dash takes the width of an em-ish glyph');
  assert.equal(measureText('​', style), 0, 'zero-width space costs nothing');
  assert.equal(advanceOfString('日', metricsFor('Helvetica')), UNITS_PER_EM);
});

test('family lookup normalizes quotes, case and whitespace, and parses CSS lists', () => {
  assert.equal(normalizeFamily('  "Helvetica  Neue" '), 'helvetica neue');
  assert.equal(lookupFamily("'Arial'").label, 'Arial');
  assert.equal(lookupFamily('ARIALMT').label, 'Arial');
  assert.deepEqual(parseFamilyList('"Inter Var", -apple-system, "Segoe UI", sans-serif'),
    ['Inter Var', '-apple-system', 'Segoe UI', 'sans-serif']);
  assert.equal(lookupFamily('Definitely Not A Real Face'), null);
});

test('category guessing is conservative and documented', () => {
  assert.equal(guessCategory('Acme Mono'), 'mono');
  assert.equal(guessCategory('Acme Serif'), 'serif');
  assert.equal(guessCategory('Acme Sans-Serif'), 'sans');
  assert.equal(guessCategory('Acme Display'), 'display');
  assert.equal(guessCategory('Acme'), 'sans');
});

test('an unknown family resolves to the closest available family in its category', () => {
  const r = resolveFace('Northwind Grotesk', { available: ['Arial', 'Georgia', 'Courier New'] });
  assert.equal(r.resolved, 'Arial');
  assert.equal(r.available, false);
  assert.equal(r.known, false);
  assert.ok(r.confidence < 0.7, 'an unknown, unavailable family cannot be measured with confidence');
  assert.equal(r.stack[0], 'Northwind Grotesk');
  assert.equal(r.stack[r.stack.length - 1], 'sans-serif');

  const serif = resolveFace('Northwind Text Serif', { available: ['Arial', 'Georgia', 'Courier New'] });
  assert.equal(serif.resolved, 'Georgia');
  assert.equal(serif.stack[serif.stack.length - 1], 'serif');
});

test('a metric-compatible substitute is preferred and costs no confidence', () => {
  const r = resolveFace('Helvetica', { available: FALLBACK_CANDIDATES });
  assert.equal(r.available, true);
  assert.equal(r.resolved, 'Helvetica');
  assert.equal(r.confidence, 1);
  assert.ok(r.stack.includes('Arial'), r.stack.join(','));
  assert.ok(r.stack.indexOf('Arial') < r.stack.indexOf('sans-serif'));
});

test('the fallback ranking prefers the metrically closest candidate', () => {
  const verdanaish = metricsFor('Verdana');
  const arial = metricsFor('Arial');
  const tahoma = metricsFor('Tahoma');
  assert.ok(metricDistance(verdanaish, tahoma) < metricDistance(verdanaish, metricsFor('Courier New')));
  // Arial and Helvetica share an advance table but not their vertical metrics
  // (716/519 against 718/523), so the distance is small but not zero — and it
  // is far smaller than the distance to any family with different advances.
  assert.ok(metricDistance(arial, metricsFor('Helvetica')) < 0.02);
  assert.ok(metricDistance(arial, metricsFor('Helvetica')) < metricDistance(arial, metricsFor('Verdana')) / 10);
  assert.equal(metricDistance(arial, metricsFor('Liberation Sans')) >= 0, true);
  assert.equal(metricDistance(arial, arial), 0, 'a family is distance zero from itself');
});

test('cssFontFamily quotes only the families that need it', () => {
  assert.equal(cssFontFamily(['Arial', 'Helvetica Neue', 'sans-serif']), 'Arial, "Helvetica Neue", sans-serif');
});

test('measurement is deterministic across calls and instances', () => {
  const s = 'Determinism is the whole point of measuring this way.';
  const a = layoutText(s, { family: 'Inter', fontSizePx: 18 }, { maxWidthPx: 200 });
  const b = layoutText(s, { family: 'Inter', fontSizePx: 18 }, { maxWidthPx: 200 });
  assert.deepEqual(a, b);
});
