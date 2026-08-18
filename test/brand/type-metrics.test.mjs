/**
 * §17.3 — type metrics against a fixture set of known font pairs.
 *
 * Every expected number in this file comes from a published source, named
 * inline, and every assertion compares the product's output to a ratio computed
 * from those published numbers *inside this test*. Nothing here asserts against
 * a value the implementation produced, which is the whole point of a golden
 * test: if `text-metrics.js` and this file both drifted, the drift would have to
 * be identical in two places written from different inputs.
 *
 * Sources:
 *   - AFM: the Adobe Font Metrics files distributed with the Core-14 PostScript
 *     fonts. `CapHeight` and `XHeight` are stated in the file header at 1000
 *     units per em.
 *   - OS/2: the `sCapHeight` and `sxHeight` fields of the font's OS/2 table,
 *     divided by the font's `unitsPerEm` and expressed per mille.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { metricsFor, metricDelta, resolveFace } from '../../src/core/text-metrics.js';
import { detectFaces } from '../../src/brand/type.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/brand/faces/${name}`, import.meta.url)), 'utf8');

/**
 * Published vertical metrics, per mille of the em.
 *
 * `tol` is the relative tolerance the assertion allows, and it is a statement
 * about the *source*, not about the implementation: families whose advance and
 * vertical metrics come straight from an AFM file are exact; families read out
 * of an OS/2 table carry the rounding of `round(1000 * value / unitsPerEm)`;
 * Georgia is the one family below whose shipped `sxHeight` has been revised
 * between releases, so it gets a wider band and a separate design-fact check.
 */
const PUBLISHED = {
  Helvetica: {
    capHeight: 718, xHeight: 523, tol: 0,
    source: 'Adobe Helvetica.afm (Core-14): CapHeight 718, XHeight 523, 1000 upm',
  },
  Arial: {
    capHeight: 716, xHeight: 519, tol: 0.002,
    source: 'Monotype Arial OS/2: sCapHeight 1467, sxHeight 1062, unitsPerEm 2048',
  },
  'Liberation Sans': {
    capHeight: 688, xHeight: 528, tol: 0.002,
    source: 'Liberation Sans OS/2: sCapHeight 1409, sxHeight 1082, unitsPerEm 2048',
  },
  Verdana: {
    capHeight: 727, xHeight: 545, tol: 0.002,
    source: 'Verdana OS/2: sCapHeight 1489, sxHeight 1117, unitsPerEm 2048',
  },
  'Times New Roman': {
    capHeight: 662, xHeight: 447, tol: 0.002,
    source: 'Times New Roman OS/2: sCapHeight 1356, sxHeight 916, unitsPerEm 2048',
  },
  Georgia: {
    capHeight: 693, xHeight: 481, tol: 0.01,
    source: 'Georgia OS/2: sCapHeight 1419, sxHeight 986, unitsPerEm 2048 (sxHeight revised between releases)',
  },
  'Courier New': {
    capHeight: 571, xHeight: 423, tol: 0.002,
    source: 'Courier New OS/2: sCapHeight 1170, sxHeight 866, unitsPerEm 2048',
  },
};

/** The per-mille values recomputed from the raw published integers, as a check
 *  that the table above transcribes them correctly. */
const RAW_OS2 = {
  Arial: { cap: 1467, x: 1062, upm: 2048 },
  'Liberation Sans': { cap: 1409, x: 1082, upm: 2048 },
  Verdana: { cap: 1489, x: 1117, upm: 2048 },
  'Times New Roman': { cap: 1356, x: 916, upm: 2048 },
  Georgia: { cap: 1419, x: 986, upm: 2048 },
  'Courier New': { cap: 1170, x: 866, upm: 2048 },
};

test('the published table transcribes its OS/2 sources correctly', () => {
  for (const [family, raw] of Object.entries(RAW_OS2)) {
    const pub = PUBLISHED[family];
    assert.equal(Math.round((1000 * raw.cap) / raw.upm), pub.capHeight, `${family} cap-height`);
    assert.equal(Math.round((1000 * raw.x) / raw.upm), pub.xHeight, `${family} x-height`);
  }
});

test('§17.3 metricDelta cap-height and x-height match the published pairs', () => {
  /** Pairs a substitution actually happens between, in the direction the
   *  product computes them: requested face over the fallback that renders. */
  const PAIRS = [
    ['Arial', 'Helvetica'],
    ['Arial', 'Liberation Sans'],
    ['Liberation Sans', 'Arial'],
    ['Verdana', 'Arial'],
    ['Verdana', 'Helvetica'],
    ['Georgia', 'Times New Roman'],
    ['Times New Roman', 'Georgia'],
    ['Courier New', 'Arial'],
  ];

  for (const [requested, fallback] of PAIRS) {
    const a = PUBLISHED[requested];
    const b = PUBLISHED[fallback];
    const delta = metricDelta(requested, fallback, 400);
    const tol = a.tol + b.tol + 1e-9;

    const expectedCap = a.capHeight / b.capHeight;
    const expectedX = a.xHeight / b.xHeight;

    assert.ok(
      Math.abs(delta.capHeight - expectedCap) <= Math.max(tol * expectedCap, 1e-9),
      `${requested}/${fallback} cap-height: got ${delta.capHeight}, published ${expectedCap} `
      + `(${a.source} over ${b.source})`,
    );
    assert.ok(
      Math.abs(delta.xHeight - expectedX) <= Math.max(tol * expectedX, 1e-9),
      `${requested}/${fallback} x-height: got ${delta.xHeight}, published ${expectedX}`,
    );
  }
});

test('§17.3 metric-compatible families substitute with an advance delta of exactly 1', () => {
  // Arial is metric-compatible with Helvetica by design (Monotype supplied it as
  // a drop-in), and Liberation Sans and Arimo are metric-compatible substitutes
  // for Arial (Red Hat/Google shipped them for exactly that). "Metric-compatible"
  // is a claim about advance widths, so the advance delta is exactly 1.
  for (const pair of [['Arial', 'Helvetica'], ['Liberation Sans', 'Arial'], ['Arimo', 'Arial'], ['Liberation Serif', 'Times New Roman'], ['Liberation Mono', 'Courier New']]) {
    const delta = metricDelta(pair[0], pair[1], 400);
    assert.equal(delta.avgAdvance, 1, `${pair[0]} is metric-compatible with ${pair[1]}`);
  }
});

test('§17.3 Verdana is materially wider than Arial, as published', () => {
  // Verdana was drawn by Matthew Carter for screen legibility with wide
  // letterforms and a large x-height; it is the standard example of a
  // substitution that overflows a layout designed for Arial.
  const delta = metricDelta('Verdana', 'Arial', 400);
  assert.ok(delta.avgAdvance > 1.08, `Verdana/Arial advance ratio ${delta.avgAdvance} should exceed 1.08`);
  assert.ok(delta.avgAdvance < 1.2, `Verdana/Arial advance ratio ${delta.avgAdvance} should stay under 1.2`);
  // And its x-height is published as 545/1000 against Arial's 519/1000.
  assert.ok(Math.abs(delta.xHeight - 545 / 519) <= 0.005, `Verdana/Arial x-height ratio ${delta.xHeight}`);
});

test("§17.3 Georgia's x-height against Times is the published ratio", () => {
  // Georgia was designed with a notably larger x-height than Times New Roman;
  // the published OS/2 values put the ratio between 1.07 and 1.09.
  const delta = metricDelta('Georgia', 'Times New Roman', 400);
  const published = PUBLISHED.Georgia.xHeight / PUBLISHED['Times New Roman'].xHeight;
  assert.ok(Math.abs(delta.xHeight - published) <= 0.012, `Georgia/Times x-height ratio ${delta.xHeight} vs published ${published}`);
  assert.ok(delta.xHeight > 1.05 && delta.xHeight < 1.12, `Georgia/Times x-height ratio ${delta.xHeight} outside the published band`);
  // Its cap-height is the larger of the two too, but by much less.
  assert.ok(delta.capHeight > 1.02 && delta.capHeight < 1.08, `Georgia/Times cap-height ratio ${delta.capHeight}`);
});

test('metricsFor reports the published per-mille metrics for every fixture family', () => {
  for (const [family, pub] of Object.entries(PUBLISHED)) {
    const m = metricsFor(family, 400);
    const capErr = Math.abs(m.capHeight - pub.capHeight) / pub.capHeight;
    const xErr = Math.abs(m.xHeight - pub.xHeight) / pub.xHeight;
    assert.ok(capErr <= pub.tol + 1e-9, `${family} cap-height ${m.capHeight} vs published ${pub.capHeight} (${pub.source})`);
    assert.ok(xErr <= pub.tol + 1e-9, `${family} x-height ${m.xHeight} vs published ${pub.xHeight} (${pub.source})`);
  }
});

test('a detected face carries the published metricDelta against the face that will render', () => {
  // The face the artifact will actually paint is the resolved fallback, not the
  // requested family (§14, §22.2). A page that asks for Verdana on a machine
  // that only has Arial renders Arial, and the face must say so.
  const css = 'body, p { font-family: Verdana, sans-serif; font-size: 16px; }';
  const [face] = detectFaces(null, css, { available: ['Arial', 'Times New Roman', 'Courier New'] });

  assert.equal(face.family, 'Verdana');
  assert.equal(face.resolved, 'Arial');
  assert.equal(face.available, false);

  const expectedCap = PUBLISHED.Verdana.capHeight / PUBLISHED.Arial.capHeight;
  const expectedX = PUBLISHED.Verdana.xHeight / PUBLISHED.Arial.xHeight;
  assert.ok(Math.abs(face.metricDelta.capHeight - expectedCap) <= 0.005, `cap ${face.metricDelta.capHeight} vs ${expectedCap}`);
  assert.ok(Math.abs(face.metricDelta.xHeight - expectedX) <= 0.005, `x ${face.metricDelta.xHeight} vs ${expectedX}`);
  assert.ok(face.metricDelta.avgAdvance > 1.08, 'a Verdana layout rendered in Arial is materially narrower');
});

test('a face that is available substitutes with an identity delta', () => {
  const css = 'body { font-family: Arial, sans-serif; font-size: 16px; }';
  const [face] = detectFaces(null, css, { available: ['Arial', 'Helvetica'] });
  assert.equal(face.resolved, 'Arial');
  assert.equal(face.available, true);
  assert.deepEqual(face.metricDelta, { capHeight: 1, xHeight: 1, avgAdvance: 1 });
});

test('the metric-compatible ordering puts an exact substitute first in the stack', () => {
  // §4 requires `fallbackStack` in "metric-compatible ordering". Arial's stack
  // must reach Helvetica and Liberation Sans before it reaches anything whose
  // advances differ.
  const resolution = resolveFace('Arial', { available: ['Verdana', 'Liberation Sans', 'Helvetica', 'Georgia'] });
  const withoutSelf = resolution.stack.filter((f) => f !== 'Arial');
  assert.ok(withoutSelf.length >= 2, 'the stack must offer more than the requested family');
  for (const family of withoutSelf.slice(0, 2)) {
    if (family === 'sans-serif') continue;
    assert.equal(metricDelta('Arial', family, 400).avgAdvance, 1, `${family} sits ahead of a wider family in the stack`);
  }
  assert.ok(resolution.stack.indexOf('Verdana') === -1 || resolution.stack.indexOf('Verdana') > resolution.stack.indexOf('Helvetica'));
});

test('the fixture stylesheets resolve to faces whose deltas come from published metrics', () => {
  const faces = detectFaces(null, fixture('heading-heavy.css'), { available: ['Arial', 'Georgia', 'Times New Roman', 'Courier New'] });
  const display = faces.find((f) => f.role === 'display');
  assert.ok(display, 'a display face is detected');
  // "Canela Deck" is unknown to this build: it falls back inside its guessed
  // category and the face says the metrics are approximate.
  assert.equal(display.known, false);
  assert.ok(display.metricDelta !== null, 'an unknown face still reports a delta against what will render');
  assert.ok(display.confidence < 1, 'an unknown family cannot be fully confident');
});
