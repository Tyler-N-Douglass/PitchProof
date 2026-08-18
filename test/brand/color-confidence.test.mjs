/**
 * §7 confidence: "computed from cluster separation, sample size, and agreement
 * across sources — never hardcoded."
 *
 * The tests are behavioural rather than numeric, because the value has no
 * published ground truth: what can be pinned is that it responds to each of the
 * three named factors in the right direction, that it never leaves [0,1], and
 * that no path returns a constant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  colorConfidence, colorConfidenceDetail, clusterSeparation, sampleSizeFactor,
  sourceAgreement, totalSamples, normalizeSources,
  CONFIDENCE_WEIGHTS, UNKNOWN_FACTOR, HALF_CONFIDENCE_SAMPLES,
  quantize, collectFromComputedStyles, collectFromCss, collectFromPixels,
  normalizeSampleWeights, extractPalette,
} from '../../src/brand/color.js';
import { syntheticPixels, KNOWN_K_CENTERS } from '../fixtures/brand/palettes.mjs';

/**
 * Clusters with a chosen separation: centroids `gap` apart in OKLab lightness,
 * each with the given spread.
 */
function madeClusters({ gap, spread, count, k = 3, sourceWeights }) {
  return Array.from({ length: k }, (_, i) => ({
    index: i,
    center: [0.2 + i * gap, 0, 0],
    spread,
    weight: 1 / k,
    count,
    sourceWeights: sourceWeights ? sourceWeights(i) : { computed: 1 / k },
  }));
}

test('the weights are declared, sum to one, and none is zero', () => {
  const total = Object.values(CONFIDENCE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-12, `weights sum to ${total}`);
  for (const [k, v] of Object.entries(CONFIDENCE_WEIGHTS)) {
    assert.ok(v > 0, `${k} must actually count`);
  }
  assert.ok(CONFIDENCE_WEIGHTS.separation > CONFIDENCE_WEIGHTS.size);
  assert.ok(CONFIDENCE_WEIGHTS.size > CONFIDENCE_WEIGHTS.agreement);
  assert.equal(UNKNOWN_FACTOR, 0.5, 'an unmeasurable factor neither rewards nor punishes');
});

test('confidence rises with cluster separation', () => {
  const overlapping = madeClusters({ gap: 0.02, spread: 0.10, count: 200 });
  const middling = madeClusters({ gap: 0.15, spread: 0.05, count: 200 });
  const separated = madeClusters({ gap: 0.30, spread: 0.01, count: 200 });
  const a = colorConfidence(overlapping, ['computed']);
  const b = colorConfidence(middling, ['computed']);
  const c = colorConfidence(separated, ['computed']);
  assert.ok(a < b, `${a} < ${b}`);
  assert.ok(b < c, `${b} < ${c}`);
  assert.ok(clusterSeparation(overlapping) < clusterSeparation(separated));
  assert.ok(clusterSeparation(separated) > 0.9, 'tight, distant clusters score near 1');
  assert.ok(clusterSeparation(overlapping) < 0.5, 'overlapping clusters score below the midpoint');
});

test('confidence rises with sample size and saturates', () => {
  const at = (count) => colorConfidence(madeClusters({ gap: 0.2, spread: 0.03, count }), ['computed']);
  const tiny = at(4);
  const some = at(64);
  const many = at(4000);
  assert.ok(tiny < some, `${tiny} < ${some}`);
  assert.ok(some < many, `${some} < ${many}`);
  assert.equal(sampleSizeFactor(HALF_CONFIDENCE_SAMPLES), 0.5, 'the half-confidence point is where it says it is');
  assert.equal(sampleSizeFactor(0), 0);
  assert.equal(sampleSizeFactor(-5), 0);
  assert.equal(sampleSizeFactor(NaN), 0);
  assert.ok(sampleSizeFactor(1e9) > 0.999 && sampleSizeFactor(1e9) < 1, 'saturates without reaching 1');
  // Saturating means diminishing returns, not a cliff.
  assert.ok(at(4000) - at(2000) < at(200) - at(100));
});

test('confidence rises with agreement across sources', () => {
  // Two sources that put their weight on the same clusters agree; two that put
  // it on different clusters do not.
  const agreeing = madeClusters({
    gap: 0.2, spread: 0.03, count: 300,
    sourceWeights: () => ({ computed: 1, css: 1 }),
  });
  const disagreeing = madeClusters({
    gap: 0.2, spread: 0.03, count: 300,
    sourceWeights: (i) => (i === 0 ? { computed: 1 } : { css: 1 }),
  });
  const high = sourceAgreement(agreeing, ['computed', 'css']);
  const low = sourceAgreement(disagreeing, ['computed', 'css']);
  assert.ok(high > low, `${high} > ${low}`);
  assert.ok(high > 0.9, 'identical distributions agree almost perfectly');
  assert.ok(low < 0.4, 'disjoint distributions barely agree');
  assert.ok(colorConfidence(agreeing, ['computed', 'css']) > colorConfidence(disagreeing, ['computed', 'css']));
});

test('an unmeasurable factor takes the midpoint rather than a guess', () => {
  const single = madeClusters({ gap: 0.2, spread: 0.03, count: 200, sourceWeights: () => ({ computed: 1 }) });
  assert.equal(sourceAgreement(single, ['computed']), UNKNOWN_FACTOR, 'one source cannot corroborate itself');
  assert.equal(clusterSeparation([{ center: [0.5, 0, 0], spread: 0, weight: 1 }]), UNKNOWN_FACTOR,
    'one cluster has no separation to measure');
  assert.equal(clusterSeparation([]), UNKNOWN_FACTOR);
  assert.equal(totalSamples([{ hex: '#fff' }]), null, 'no counts recorded means unknown, not zero');
  const detail = colorConfidenceDetail([{ hex: '#fff' }, { hex: '#000' }], []);
  assert.equal(detail.size, UNKNOWN_FACTOR);
  assert.equal(detail.samples, null);
});

test('confidence is always in [0,1], on every input including hostile ones', () => {
  const inputs = [
    [], [null], [undefined],
    madeClusters({ gap: 0, spread: 0, count: 0, k: 1 }),
    madeClusters({ gap: 0, spread: 10, count: 1 }),
    madeClusters({ gap: 100, spread: 0, count: 1e9 }),
    [{ center: [0, 0, 0], spread: NaN, weight: NaN, count: NaN, sourceWeights: {} }],
    [{ center: [0, 0, 0] }, { center: [1, 0, 0] }],
  ];
  for (const clusters of inputs) {
    for (const sources of [undefined, [], ['a'], ['a', 'b'], 3, { a: 1, b: 2 }]) {
      const v = colorConfidence(/** @type {any} */ (clusters), sources);
      assert.ok(Number.isFinite(v), `non-finite confidence for ${JSON.stringify(clusters)}`);
      assert.ok(v >= 0 && v <= 1, `confidence ${v} out of range`);
    }
  }
});

test('nothing about the value is hardcoded', () => {
  // The same clusters with different evidence must not produce the same number.
  const seen = new Set();
  for (const count of [4, 16, 64, 256, 1024]) {
    for (const gap of [0.03, 0.1, 0.25]) {
      seen.add(colorConfidence(madeClusters({ gap, spread: 0.02, count }), ['computed', 'css']).toFixed(6));
    }
  }
  assert.equal(seen.size, 15, 'every distinct evidence state must give a distinct confidence');
});

test('the detail breakdown reports the parts the studio surfaces for review', () => {
  const clusters = madeClusters({ gap: 0.2, spread: 0.02, count: 500, sourceWeights: () => ({ computed: 2, css: 1 }) });
  const d = colorConfidenceDetail(clusters, ['computed', 'css']);
  assert.equal(d.confidence, colorConfidence(clusters, ['computed', 'css']));
  assert.equal(d.separation, clusterSeparation(clusters));
  assert.equal(d.agreement, sourceAgreement(clusters, ['computed', 'css']));
  assert.equal(d.samples, 1500);
  for (const key of ['confidence', 'separation', 'size', 'agreement']) {
    assert.ok(d[key] >= 0 && d[key] <= 1, `${key} out of range`);
  }
  // A weighted geometric mean sits between its smallest and largest factor.
  const factors = [d.separation, d.size, d.agreement];
  assert.ok(d.confidence >= Math.min(...factors) - 1e-9);
  assert.ok(d.confidence <= Math.max(...factors) + 1e-9);
});

test('a collapsed factor collapses the result, which an arithmetic mean would not', () => {
  const clusters = madeClusters({ gap: 0.2, spread: 0.02, count: 0, k: 3 });
  const withNoSamples = colorConfidence(clusters, ['computed', 'css']);
  const arithmetic = CONFIDENCE_WEIGHTS.separation * clusterSeparation(clusters)
    + CONFIDENCE_WEIGHTS.size * 0
    + CONFIDENCE_WEIGHTS.agreement * UNKNOWN_FACTOR;
  assert.ok(withNoSamples < arithmetic,
    `geometric ${withNoSamples} must punish a zero factor harder than arithmetic ${arithmetic}`);
  assert.ok(withNoSamples < 0.05, 'no samples at all is near-zero confidence');
});

test('normalizeSources accepts every shape a caller might have', () => {
  assert.deepEqual(normalizeSources(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(normalizeSources([{ origin: 'computed' }, { origin: 'css' }]), ['computed', 'css']);
  assert.deepEqual(normalizeSources({ computed: 1, css: 2 }), ['computed', 'css']);
  assert.equal(normalizeSources(2).length, 2);
  assert.deepEqual(normalizeSources(null), []);
  assert.deepEqual(normalizeSources(undefined), []);
});

test('confidence responds to real extractions, not just synthetic clusters', () => {
  const strong = extractPalette({
    computed: [
      { styles: { backgroundColor: '#ffffff' }, rect: { w: 1600, h: 900 } },
      { styles: { backgroundColor: '#3b2eea' }, rect: { w: 400, h: 200 } },
      { styles: { color: '#0b1220' }, rect: { w: 900, h: 300 }, text: 'copy '.repeat(40) },
    ],
    css: 'body{background:#ffffff;color:#0b1220}.cta{background:#3b2eea}',
    images: [{ pixels: syntheticPixels(['#ffffff', '#3b2eea', '#0b1220'], { perCluster: 400, jitter: 2, seed: 'strong' }) }],
  }, { seed: 'conf', k: 3 });
  const weak = extractPalette({
    css: '.a{color:#7a7a78}.b{color:#7b7b79}.c{color:#7c7c7a}',
  }, { seed: 'conf', k: 3 });
  assert.ok(strong.confidence > weak.confidence,
    `corroborated and separated (${strong.confidence}) must beat a single blurry source (${weak.confidence})`);
  assert.ok(strong.confidence > 0 && strong.confidence <= 1);
  assert.ok(weak.confidence >= 0 && weak.confidence <= 1);
});

test('confidence tracks the separation of real clustered pixels', () => {
  const tight = quantize(syntheticPixels(KNOWN_K_CENTERS[4], { perCluster: 150, jitter: 2, seed: 'tight' }), { k: 4, seed: 'q' });
  const smeared = quantize(syntheticPixels(KNOWN_K_CENTERS[4], { perCluster: 150, jitter: 60, seed: 'smear' }), { k: 4, seed: 'q' });
  assert.ok(colorConfidence(tight, ['image']) > colorConfidence(smeared, ['image']),
    'well-separated pixels give higher confidence than smeared ones');
});
