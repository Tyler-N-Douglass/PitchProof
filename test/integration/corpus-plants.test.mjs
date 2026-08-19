/**
 * §17.4 precision and recall, measured over the prospect's own copy.
 *
 * Each lane built a planted-defect corpus of its own, and each measures over
 * synthetic text — because synthetic text is the only place ground truth is
 * knowable by construction. The §20 critic named the cost of that: a detector
 * can score 1.0 on planted paragraphs and be blind on a real page, and every
 * severity-1 finding in the critique was reachable from a corpus proof and none
 * from `makeProof()`.
 *
 * `PLANTS` closes that gap. Each one injects a single named defect into the
 * corpus proof through the same published surfaces the rest of the pipeline
 * uses — nothing reaches into a lane's internals, nothing hand-writes a §4
 * record no surface would produce — and hands back what it injected. So ground
 * truth stays knowable while the text, the layouts, the palette and the
 * geometry are the real ones.
 *
 * Recall is: does the planted defect appear? Precision is the assertion nobody
 * usually writes: does planting one defect leave every *other* detector's count
 * exactly where it was? A detector that fires on a neighbouring change is a
 * detector a seller learns to ignore.
 *
 * One plant expects nothing at all. `CTA_LIVE_LINK_NEUTRALISED` puts a live
 * outbound link in a rendition, and the pipeline is supposed to swallow it
 * before the scanner ever sees it — `scene/blocks.js` renders a `cta` block's
 * label and drops its `href`. That is the outer of two defences, and it is
 * asserted here so it cannot quietly stop holding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCorpusProof, buildPlantedProof, PLANTS, plantByName } from '../fixtures/corpus/proof.mjs';
import { corpusClock } from '../fixtures/corpus/index.mjs';
import { emit } from '../../src/emit/index.js';
import { registerAllLayouts } from '../../src/scene/index.js';
import { buildRuntime } from '../../scripts/build.mjs';

registerAllLayouts();

let cachedRuntime = null;
function runtime() {
  if (!cachedRuntime) cachedRuntime = buildRuntime();
  return cachedRuntime;
}

/** Findings live in different places depending on whether the emit was refused. */
function findingsOf(result) {
  if (result.ok) return result.value.findings || [];
  if (Array.isArray(result.detail)) return result.detail;
  return (result.detail && result.detail.findings) || [];
}

/** @param {any} proof @returns {Promise<Record<string, number>>} */
async function countsFor(proof) {
  const rt = runtime();
  const result = await emit(proof, proof.emitOptions, {
    runtimeJs: rt.js, runtimeCss: rt.css, clock: corpusClock(),
  });
  /** @type {Record<string, number>} */
  const counts = {};
  for (const finding of findingsOf(result)) {
    counts[finding.code] = (counts[finding.code] || 0) + 1;
  }
  return counts;
}

/** The clean run, built once. Every plant is measured as a delta against it. */
let cachedBaseline = null;
async function baseline() {
  if (!cachedBaseline) cachedBaseline = await countsFor(await buildCorpusProof());
  return cachedBaseline;
}

test('the plants are well formed and distinctly named', () => {
  assert.ok(PLANTS.length >= 8, 'too few plants to measure anything');
  const names = PLANTS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'two plants share a name');
  for (const plant of PLANTS) {
    assert.equal(typeof plant.describe, 'string');
    assert.ok(plant.describe.length > 20, `${plant.name} does not say what a seller did to cause it`);
    assert.equal(typeof plant.apply, 'function');
    assert.equal(plantByName(plant.name), plant);
  }
  assert.throws(() => plantByName('NOT_A_PLANT'), /no plant named/);
});

for (const plant of PLANTS) {
  test(`plant ${plant.name}: ${plant.describe}`, async () => {
    const base = await baseline();
    const { proof, expected } = await buildPlantedProof(plant.name);
    const after = await countsFor(proof);

    const delta = (after[plant.code] || 0) - (base[plant.code] || 0);

    if (plant.expectsNothing) {
      assert.equal(delta, 0,
        `${plant.name} is a negative control: the pipeline is meant to neutralise it before the detector sees it, `
        + `but ${plant.code} moved by ${delta}`);
    } else {
      // Recall.
      assert.ok(delta > 0,
        `${plant.name} was planted and no ${plant.code} finding appeared. `
        + `Ground truth: ${JSON.stringify(expected)}`);
    }

    // Precision. Planting one defect must not move a detector the plant does not
    // declare. `alsoMoves` is for defects that genuinely imply another — an
    // unanchored branch really does have no return target — and every entry
    // carries the reason, so the escape hatch cannot be used to wave away a
    // false positive.
    const declared = plant.alsoMoves || {};
    const moved = [...new Set([...Object.keys(base), ...Object.keys(after)])]
      .filter((code) => code !== plant.code && !(code in declared))
      .filter((code) => (after[code] || 0) !== (base[code] || 0))
      .map((code) => `${code} ${base[code] || 0} -> ${after[code] || 0}`);
    assert.deepEqual(moved, [],
      `planting ${plant.name} moved detectors it does not declare: ${moved.join(', ')}`);

    // And a declared implication that did not happen is a stale declaration.
    for (const [code, reason] of Object.entries(declared)) {
      assert.ok(reason.length > 20, `${plant.name} declares ${code} with no reason worth the name`);
      assert.notEqual((after[code] || 0), (base[code] || 0),
        `${plant.name} declares it also moves ${code} ("${reason}") and it did not`);
    }
  });
}

test('planting is deterministic — the same plant twice gives the same findings', async () => {
  const a = await buildPlantedProof('TEXT_OVERFLOW_CLIP');
  const b = await buildPlantedProof('TEXT_OVERFLOW_CLIP');
  assert.deepEqual(await countsFor(a.proof), await countsFor(b.proof));
});

test('every plant declares ground truth naming its own code', async () => {
  for (const plant of PLANTS) {
    const { expected } = await buildPlantedProof(plant.name);
    assert.ok(expected.length > 0, `${plant.name} declared no ground truth`);
    for (const entry of expected) {
      assert.equal(entry.code, plant.code,
        `${plant.name} declares ground truth for ${entry.code} but is registered under ${plant.code}`);
    }
  }
});

test('recall across every plant that expects a finding', async () => {
  const base = await baseline();
  /** @type {string[]} */
  const missed = [];
  let planted = 0;
  for (const plant of PLANTS) {
    if (plant.expectsNothing) continue;
    planted += 1;
    const { proof } = await buildPlantedProof(plant.name);
    const after = await countsFor(proof);
    if ((after[plant.code] || 0) <= (base[plant.code] || 0)) missed.push(plant.name);
  }
  assert.deepEqual(missed, [],
    `recall ${planted - missed.length}/${planted} — undetected: ${missed.join(', ')}`);
});
