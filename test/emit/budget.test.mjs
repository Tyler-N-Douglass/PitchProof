/**
 * Size budgeting (§13, §17.10, §22.5, §20 axis 9 "degradation honesty").
 *
 * §17.10 asks for two assertions and this file makes both of them literal:
 * "assert degradation is monotonic in importance rank and that the reported
 * degradation matches actual bytes saved". Nothing here is estimated — the
 * images really are decoded, resampled and re-encoded, and the numbers in the
 * plan are the numbers on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetAssets, collectAssets, dedupeAssets, countAssetCopies, assetFootprint, rankAssets, minifySvg,
  scaleForQuality, quantizeScale, scaleSteps, describeFixedCost, SCALE_FLOOR, SCALE_QUANTUM,
} from '../../src/emit/budget.js';
import { emit } from '../../src/emit/index.js';
import { utf8Length, parseDataUri } from '../../src/core/bytes.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, pngDataUri } from '../fixtures/emit/proofs.mjs';
import { artifactModel } from '../fixtures/emit/artifact-dom.mjs';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();

/** @param {import('../../src/core/contracts.d.ts').Proof} proof */
function sceneRenderer(proof) {
  const runtime = new Runtime(proof, {});
  return (scene) => runtime.renderScene(scene);
}

/** Total emitted cost of every asset in a proof. */
function assetTotal(proof) {
  return collectAssets(proof).reduce((sum, a) => sum + a.bytes, 0);
}

test('a proof already under budget is left completely alone', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 32 });
  const result = budgetAssets(proof, 50_000_000, { renderScene: sceneRenderer(proof) });
  assert.deepEqual(result.plan, []);
  assert.equal(result.proof, proof, 'an untouched proof must be the same object, not a copy');
  assert.equal(result.fits, true);
});

test('degradation is monotonic in importance rank (§17.10)', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 220 });
  const total = assetTotal(proof);
  const result = budgetAssets(proof, Math.round(total * 0.45), { renderScene: sceneRenderer(proof) });

  assert.ok(result.plan.length >= 2, `expected several degradations, got ${result.plan.length}`);
  const byRank = result.plan.slice().sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    assert.ok(
      byRank[i].steps >= byRank[i - 1].steps,
      `rank ${byRank[i].rank} took ${byRank[i].steps} step(s) but the more important rank ${byRank[i - 1].rank} took ${byRank[i - 1].steps}; '
      + 'importance rank must degrade monotonically`,
    );
  }
});

test('the reported saving equals the actual byte delta, exactly (§17.10)', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 200 });
  const total = assetTotal(proof);
  const result = budgetAssets(proof, Math.round(total * 0.4), { renderScene: sceneRenderer(proof) });
  assert.ok(result.plan.length > 0);

  const after = new Map(collectAssets(result.proof).map((a) => [a.assetId, a.bytes]));
  const before = new Map(collectAssets(proof).map((a) => [a.assetId, a.bytes]));

  let reportedSaving = 0;
  for (const line of result.plan) {
    assert.equal(line.beforeBytes, before.get(line.assetId), `${line.assetId}: beforeBytes does not match the original asset`);
    assert.equal(line.afterBytes, after.get(line.assetId), `${line.assetId}: afterBytes does not match the emitted asset`);
    assert.equal(line.actualBytes, line.afterBytes, `${line.assetId}: actualBytes must be the measured result`);
    assert.equal(line.savedBytes, line.beforeBytes - line.afterBytes, `${line.assetId}: the reported saving is not the byte delta`);
    assert.ok(line.savedBytes > 0, `${line.assetId}: a degradation that saves nothing is not a degradation`);
    assert.equal(typeof line.predictedBytes, 'number');
    assert.ok(line.predictedBytes > 0);
    assert.ok(line.to.w <= line.from.w && line.to.h <= line.from.h, `${line.assetId}: an asset must not grow`);
    assert.equal(typeof line.reason, 'string');
    assert.ok(line.reason.length > 0);
    reportedSaving += line.savedBytes;
  }

  const actualSaving = assetTotal(proof) - assetTotal(result.proof);
  assert.equal(reportedSaving, actualSaving, 'the sum of reported savings must equal the real total delta');
});

test('the prediction is in the right neighbourhood of the measurement', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 200 });
  const total = assetTotal(proof);
  const result = budgetAssets(proof, Math.round(total * 0.3), { renderScene: sceneRenderer(proof) });
  for (const line of result.plan) {
    if (line.steps === 0) continue;                        // a lossless re-encode is not predictable
    const ratio = line.actualBytes / line.predictedBytes;
    assert.ok(ratio > 0.2 && ratio < 5, `${line.assetId}: predicted ${line.predictedBytes}, actual ${line.actualBytes}`);
  }
});

test('the degraded proof really carries the smaller images', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 180 });
  const result = budgetAssets(proof, Math.round(assetTotal(proof) * 0.35), { renderScene: sceneRenderer(proof) });
  assert.ok(result.plan.length > 0);
  for (const line of result.plan) {
    if (line.to.w === line.from.w) continue;
    const asset = collectAssets(result.proof).find((a) => a.assetId === line.assetId);
    assert.ok(asset, `${line.assetId} vanished from the proof`);
    const parsed = parseDataUri(asset.dataUri);
    assert.ok(parsed, `${line.assetId} is no longer a data URI`);
    assert.equal(asset.intrinsic.w, line.to.w, `${line.assetId}: the model's intrinsic width was not updated`);
    assert.equal(asset.intrinsic.h, line.to.h);
  }
  assert.notEqual(result.proof, proof, 'budgeting must not mutate the proof it was given');
  assert.equal(assetTotal(proof), assetTotal(emitProof({ imageEdge: 180 })), 'the original proof was mutated');
});

test('the spine outranks the branches and early beats outrank late ones', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 40 });
  const assets = rankAssets(collectAssets(proof));
  const placements = assets.map((a) => a.placement);
  for (let i = 1; i < placements.length; i++) {
    const prev = placements[i - 1];
    const cur = placements[i];
    const prevKey = [prev.sequence, prev.sceneIndex, prev.beatIndex];
    const curKey = [cur.sequence, cur.sceneIndex, cur.beatIndex];
    assert.ok(
      prevKey[0] < curKey[0] || (prevKey[0] === curKey[0] && (prevKey[1] < curKey[1] || (prevKey[1] === curKey[1] && prevKey[2] <= curKey[2]))),
      `rank ${i - 1} at ${prevKey} outranks rank ${i} at ${curKey}`,
    );
  }
});

test('an asset the codec cannot re-encode is reported, never silently kept', () => {
  registerTestLayouts();
  const base = emitProof({ imageEdge: 24 });
  const jpeg = `data:image/jpeg;base64,${'A'.repeat(400_000)}`;
  const proof = {
    ...base,
    specimens: base.specimens.map((s, i) => (i === 0
      ? { ...s, media: s.media.map((m, j) => (j === 0 ? { ...m, dataUri: jpeg, bytes: 300_000 } : m)) }
      : s)),
  };
  const result = budgetAssets(proof, 1000, { renderScene: sceneRenderer(proof) });
  assert.equal(result.fits, false);
  assert.ok(result.undegradable.length > 0, 'an undegradable asset must be named');
  assert.ok(result.undegradable.some((u) => /image\/jpeg/.test(u.reason)));
});

test('a host resampler is used for formats the in-repo codec cannot handle', () => {
  registerTestLayouts();
  const base = emitProof({ imageEdge: 24 });
  const jpeg = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
  const proof = {
    ...base,
    specimens: base.specimens.map((s, i) => (i === 0
      ? { ...s, media: s.media.map((m, j) => (j === 0 ? { ...m, dataUri: jpeg, bytes: 150_000 } : m)) }
      : s)),
  };
  const resample = ({ bytes, scale }) => ({
    bytes: bytes.subarray(0, Math.max(1, Math.round(bytes.length * scale * scale))),
    width: Math.round(24 * scale),
    height: Math.round(24 * scale),
  });
  const result = budgetAssets(proof, 40_000, { renderScene: sceneRenderer(proof), resample });
  const line = result.plan.find((l) => l.reason.includes('host resampler'));
  assert.ok(line, 'the host resampler was never called');
  assert.equal(line.savedBytes, line.beforeBytes - line.afterBytes);
});

test('SVG minification saves real bytes and keeps text whitespace', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">\n  <!-- a comment -->\n  <rect   width="4"  height="4"/>\n  <text>keep  this  spacing</text>\n</svg>';
  const min = minifySvg(svg);
  assert.ok(min.length < svg.length);
  assert.ok(!min.includes('<!--'));
  assert.match(min, /keep {2}this {2}spacing/);
});

test('emit raises SIZE_BUDGET_EXCEEDED at severity 1 rather than shipping over budget', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 96, emitOptions: { maxBytes: 60_000 } });
  const result = await emit(proof, {}, { runtimeJs, runtimeCss, clock: FIXED_CLOCK });
  assert.equal(result.ok, false, 'an artifact over budget must be refused');
  const finding = result.detail.findings.find((f) => f.code === 'SIZE_BUDGET_EXCEEDED');
  assert.ok(finding, 'no SIZE_BUDGET_EXCEEDED finding was raised');
  assert.equal(finding.severity, 1, '§22.5 calls an over-budget artifact a failed artifact');
  assert.match(finding.message, /over the 60000-byte budget/);
  assert.equal(result.detail.html, '', 'a refused emit must not hand back a partial artifact');
});

test('emit degrades and fits when it can, and reports every line', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 220 });
  const generous = await emit(proof, { maxBytes: 50_000_000 }, { runtimeJs, runtimeCss, clock: FIXED_CLOCK });
  assert.equal(generous.ok, true, generous.ok ? '' : generous.error);
  const fullBytes = generous.value.bytes;
  assert.deepEqual(generous.value.degradations, [], 'nothing should be degraded when the budget is generous');

  const target = Math.round(fullBytes * 0.75);
  const tight = await emit(proof, { maxBytes: target }, { runtimeJs, runtimeCss, clock: FIXED_CLOCK });
  assert.equal(tight.ok, true, tight.ok ? '' : tight.error);
  assert.ok(tight.value.bytes <= target, `emitted ${tight.value.bytes} against a ${target} budget`);
  assert.ok(tight.value.degradations.length > 0, 'degradation happened but was not reported');
  for (const line of tight.value.degradations) {
    assert.equal(line.savedBytes, line.beforeBytes - line.afterBytes);
  }
});

test('the quality dial is ordered, bounded, and starts with a lossless re-encode (P7)', () => {
  // q = 1 is the lossless pass: every asset keeps every pixel.
  for (const rank of [0, 3, 7]) assert.equal(scaleForQuality(1, rank, 8), 1);
  // q = 0 is the floor, and nothing ever goes below it.
  for (const rank of [0, 3, 7]) assert.equal(scaleForQuality(0, rank, 8), SCALE_FLOOR);
  for (const q of [0.001, 0.05, 0.2]) assert.ok(scaleForQuality(q, 7, 8) >= SCALE_FLOOR);

  // Monotone in the dial: turning it up never shrinks an asset further.
  for (const rank of [0, 4, 7]) {
    let previous = 0;
    for (const q of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
      const scale = scaleForQuality(q, rank, 8);
      assert.ok(scale >= previous, `rank ${rank}: q ${q} gave ${scale} after ${previous}`);
      previous = scale;
    }
  }

  // Monotone in importance: a less important asset never keeps more pixels.
  for (const q of [0.2, 0.5, 0.8, 0.97]) {
    let previous = 1;
    for (let rank = 0; rank < 8; rank++) {
      const scale = scaleForQuality(q, rank, 8);
      assert.ok(scale <= previous, `q ${q}: rank ${rank} kept ${scale} against ${previous} for the rank above it`);
      previous = scale;
    }
  }

  // Every scale the encoder sees is on the quantum grid, so §5's byte-identical
  // re-emit survives a search that is otherwise continuous.
  for (const q of [0.137, 0.4991, 0.8888]) {
    const scale = scaleForQuality(q, 2, 8);
    assert.equal(scale, quantizeScale(scale), `${scale} is not on the ${SCALE_QUANTUM} grid`);
  }
});

test('steps is a monotone reading of the scale, and 0 means no pixel was given up (P7)', () => {
  assert.equal(scaleSteps(1), 0);
  assert.ok(scaleSteps(0.9999) >= 1, 'any resampling at all must read as at least one step');
  let previous = -1;
  for (const scale of [1, 0.99, 0.9, 0.75, 0.5, 0.25, SCALE_FLOOR]) {
    const steps = scaleSteps(scale);
    assert.ok(steps >= previous, `scale ${scale} read ${steps} after ${previous}`);
    previous = steps;
  }
});

test('an identical asset used twice is carried once and degraded once', () => {
  registerTestLayouts();
  const shared = pngDataUri(64, 64, 5);
  const base = emitProof({ imageEdge: 24 });
  const proof = {
    ...base,
    specimens: base.specimens.map((s) => ({ ...s, media: s.media.map((m) => ({ ...m, dataUri: shared })) })),
  };
  const assets = collectAssets(proof).filter((a) => a.dataUri === shared);
  assert.ok(assets.length >= 2, 'the fixture must actually share an asset');
  const result = budgetAssets(proof, 1_000, { renderScene: sceneRenderer(proof) });
  const uris = new Set(collectAssets(result.proof).map((a) => a.dataUri));
  assert.ok(uris.size <= collectAssets(result.proof).length);
});

// ---------------------------------------------------------------------------
// Critic F13 — one line per asset, and a prediction worth reading
// ---------------------------------------------------------------------------

import { predictEmittedBytes, dataUriPrefixBytes, PNG_CONTAINER_BYTES } from '../../src/emit/budget.js';

/**
 * A proof whose media is inlined more than once — the shape the critic hit,
 * where one image is referenced by several `MediaRef`s.
 * @param {number} edge
 */
function proofWithSharedMedia(edge = 160) {
  const base = emitProof({ imageEdge: edge });
  const shared = base.specimens[0].media[0].dataUri;
  return {
    ...base,
    specimens: base.specimens.map((s) => ({
      ...s,
      media: (s.media || []).map((m) => ({ ...m, dataUri: shared, intrinsic: { w: edge, h: edge } })),
    })),
    renditions: base.renditions.map((r) => ({
      ...r,
      media: (r.media || []).map((m) => ({ ...m, dataUri: shared, intrinsic: { w: edge, h: edge } })),
    })),
  };
}

test('one payload is one budgeting unit, however many references point at it', () => {
  registerTestLayouts();
  const proof = proofWithSharedMedia();
  const raw = collectAssets(proof);
  const deduped = dedupeAssets(raw);
  assert.ok(raw.length > deduped.length, 'the fixture must actually share a payload');
  const shared = deduped.find((a) => a.assetIds.length > 1);
  assert.ok(shared, 'the shared payload must collapse to one entry');
  assert.equal(new Set(deduped.map((a) => a.dataUri)).size, deduped.length, 'one entry per distinct payload');
});

test('the report carries one line per asset, never one per reference (F13)', () => {
  registerTestLayouts();
  const proof = proofWithSharedMedia();
  const total = dedupeAssets(collectAssets(proof)).reduce((n, a) => n + a.bytes, 0);
  const result = budgetAssets(proof, Math.round(total * 0.4), { renderScene: sceneRenderer(proof) });
  assert.ok(result.plan.length > 0);
  const ids = result.plan.map((l) => l.assetId);
  assert.equal(new Set(ids).size, ids.length, `the report repeats an asset: ${ids.join(', ')}`);
  const payloads = result.plan.map((l) => l.beforeBytes + ':' + l.from.w + 'x' + l.from.h);
  assert.equal(new Set(payloads).size, payloads.length, 'two lines describe the same degradation');
  for (const line of result.plan) {
    assert.ok(Array.isArray(line.assetIds) && line.assetIds.length >= 1);
    assert.ok(line.assetIds.includes(line.assetId));
  }
});

test('degrading a shared payload updates every reference to it', () => {
  registerTestLayouts();
  const proof = proofWithSharedMedia();
  const total = dedupeAssets(collectAssets(proof)).reduce((n, a) => n + a.bytes, 0);
  const result = budgetAssets(proof, Math.round(total * 0.4), { renderScene: sceneRenderer(proof) });
  const line = result.plan.find((l) => l.assetIds.length > 1);
  assert.ok(line, 'the shared payload must be among the degraded');
  const after = collectAssets(result.proof).filter((a) => line.assetIds.includes(a.assetId));
  assert.ok(after.length > 1);
  assert.equal(new Set(after.map((a) => a.dataUri)).size, 1, 'every reference must carry the same degraded payload');
  for (const a of after) {
    assert.equal(a.bytes, line.afterBytes);
    assert.equal(a.intrinsic.w, line.to.w);
  }
});

test('the reported saving is still exactly the byte delta when payloads are shared', () => {
  registerTestLayouts();
  const proof = proofWithSharedMedia();
  const before = dedupeAssets(collectAssets(proof)).reduce((n, a) => n + a.bytes, 0);
  const result = budgetAssets(proof, Math.round(before * 0.4), { renderScene: sceneRenderer(proof) });
  const after = dedupeAssets(collectAssets(result.proof)).reduce((n, a) => n + a.bytes, 0);
  const reported = result.plan.reduce((n, l) => n + l.savedBytes, 0);
  assert.equal(reported, before - after, 'double counting a shared payload would break this');
});

test('the prediction accounts for the container floor and for base64 (F13)', () => {
  const prefix = dataUriPrefixBytes('data:image/png;base64,AAAA');
  assert.equal(prefix, 22);

  // Halving the linear size quarters the pixel payload, not the whole file.
  const big = predictEmittedBytes(960_690, 1, 0.5, prefix);
  assert.ok(big > 240_000 && big < 242_000, `expected about a quarter of the payload, got ${big}`);

  // At the bottom of the ladder the container dominates, and the prediction
  // must never fall below what an empty PNG costs.
  const tiny = predictEmittedBytes(300, 0.25, 0.15, prefix);
  assert.ok(tiny >= prefix + 4 * Math.ceil(PNG_CONTAINER_BYTES / 3), `a prediction below the container floor: ${tiny}`);
  assert.ok(tiny < 300);

  // The naive model this replaced predicted `bytes × scale²`, which for the
  // same input says 108 — under the container floor, and out by an order of
  // magnitude against a real 30×18 PNG.
  assert.ok(tiny > 300 * (0.15 / 0.25) ** 2, 'the corrected model must exceed the naive one at small sizes');
});

test('predictions land within a quarter of the measurement on real images', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 240 });
  const total = collectAssets(proof).reduce((n, a) => n + a.bytes, 0);
  for (const fraction of [0.5, 0.3, 0.15]) {
    const result = budgetAssets(proof, Math.round(total * fraction), { renderScene: sceneRenderer(proof) });
    const errors = result.plan
      .filter((l) => l.steps > 0)
      .map((l) => Math.abs(l.actualBytes - l.predictedBytes) / l.predictedBytes);
    assert.ok(errors.length > 0, `no degradation at ${fraction}`);
    const sorted = errors.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(median <= 0.25, `median prediction error ${(median * 100).toFixed(1)}% at budget fraction ${fraction}`);
    assert.ok(Math.max(...errors) <= 1.0, `worst prediction error ${(Math.max(...errors) * 100).toFixed(1)}% at ${fraction}`);
  }
});

test('a degraded MediaRef reports its inlined cost, not its decoded payload', () => {
  // L6's F19 fix: `MediaRef.bytes` means `utf8Length(dataUri)`. Writing the
  // decoded size back after degrading would leave the one asset the product
  // just told the seller it shrank showing a number a third too small.
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 180 });
  const result = budgetAssets(proof, Math.round(assetTotal(proof) * 0.35), { renderScene: sceneRenderer(proof) });
  assert.ok(result.plan.length > 0);

  const degraded = new Set(result.plan.flatMap((l) => l.assetIds));
  const refs = [
    ...result.proof.specimens.flatMap((s) => s.media || []),
    ...result.proof.renditions.flatMap((r) => r.media || []),
  ].filter((m) => degraded.has(m.id));
  assert.ok(refs.length > 0, 'the fixture must degrade at least one MediaRef');

  for (const ref of refs) {
    assert.equal(ref.bytes, utf8Length(ref.dataUri), `${ref.id}: bytes must be the inlined cost`);
    const line = result.plan.find((l) => l.assetIds.includes(ref.id));
    assert.equal(ref.bytes, line.afterBytes, `${ref.id}: the model and the report must agree`);
  }
});

test('an untouched MediaRef keeps the meaning it arrived with', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 32 });
  const result = budgetAssets(proof, 50_000_000, { renderScene: sceneRenderer(proof) });
  assert.equal(result.proof, proof, 'nothing was degraded, so nothing was rewritten');
});


// --------------------------------------------------------------------- C2
//
// The budgeter used to reason about a number that was not in the file. It
// summed `collectAssets` — one entry per `MediaRef`, so a picture two
// references shared was counted twice — and subtracted that from the built size
// to get the reserve, while the document was carrying every payload the opening
// beat paints a second time in the pre-rendered markup. The reserve came out
// megabytes wrong in both directions at once, and the three things that ride on
// it rode on the error: the refusal, the stopping point, and the report a
// seller reads.
//
// Everything below is measured against an emitted string. Not "the estimate is
// close": equal.

const budgetDeps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

/** Emit with a budget nothing can hit, to learn the artifact's natural size. */
async function emitNaturally(proof) {
  const result = await emit(proof, { maxBytes: 1_000_000_000 }, budgetDeps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result.value;
}

/**
 * Count a payload in a document the way a reader would: every occurrence,
 * non-overlapping. Written out longhand rather than called out of `budget.js`,
 * because this is the ground truth the module is being checked against.
 */
function occurrencesOf(html, needle) {
  let count = 0;
  let at = 0;
  for (;;) {
    const i = html.indexOf(needle, at);
    if (i < 0) return count;
    count += 1;
    at = i + needle.length;
  }
}

/** Every distinct payload the emitted model carries, and what the file spends on it. */
function measuredFromFile(html) {
  const model = artifactModel(html);
  const assets = dedupeAssets(collectAssets(model));
  let bytes = 0;
  /** @type {Map<string, number>} */
  const copies = new Map();
  for (const asset of assets) {
    const n = occurrencesOf(html, asset.dataUri);
    copies.set(asset.assetId, n);
    bytes += n * asset.bytes;
  }
  return { assets, copies, bytes };
}

test('the bytes the budgeter reasons about are the bytes in the file (C2)', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 200 });
  const natural = await emitNaturally(proof);

  // Budgets expressed against the *asset* half of the file, because the other
  // half is the runtime bundle and no allocator can spend that. `reserveBytes`
  // is the emitter's own measurement of it, which is the number under test.
  for (const fraction of [1, 0.8, 0.6, 0.4, 0.2]) {
    const maxBytes = natural.budget.reserveBytes + Math.floor(natural.budget.assetBytes * fraction);
    const result = await emit(proof, { maxBytes }, budgetDeps);
    assert.equal(result.ok, true, `budget ${fraction}: ${result.ok ? '' : result.error}`);
    const { bytes, html, budget } = result.value;

    assert.equal(bytes, utf8Length(html), `budget ${fraction}: EmitResult.bytes is not the length of the document`);
    assert.equal(
      budget.reserveBytes + budget.assetBytes, bytes,
      `budget ${fraction}: reserve ${budget.reserveBytes} + assets ${budget.assetBytes} is not the ${bytes}-byte file`,
    );
    assert.equal(budget.bytes, bytes);
    assert.equal(budget.maxBytes, maxBytes);

    const measured = measuredFromFile(html);
    assert.equal(
      budget.assetBytes, measured.bytes,
      `budget ${fraction}: the budgeter counted ${budget.assetBytes} asset bytes and the file carries ${measured.bytes}`,
    );
    const reported = new Map(budget.copies.map((c) => [c.assetId, c.copies]));
    for (const [assetId, expected] of measured.copies) {
      assert.equal(
        reported.get(assetId), expected,
        `budget ${fraction}: ${assetId} is written ${expected} time(s) into the file and the budgeter believes ${reported.get(assetId)}`,
      );
    }
  }
});

test('a budget the artifact already meets is not refused (C2)', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 220 });
  const natural = await emitNaturally(proof);

  // The exact natural size, and one byte under it. Both were refused with a
  // severity-1 SIZE_BUDGET_EXCEEDED while the reserve was inflated by every
  // asset the opening beat paints.
  for (const maxBytes of [natural.bytes, natural.bytes - 1]) {
    const result = await emit(proof, { maxBytes }, budgetDeps);
    assert.equal(result.ok, true, `maxBytes ${maxBytes} was refused: ${result.ok ? '' : result.error}`);
    assert.ok(result.value.bytes <= maxBytes, `maxBytes ${maxBytes} produced ${result.value.bytes} bytes`);
  }
});

test('the artifact does not throw away quality it did not need to (C2)', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 220 });
  const natural = await emitNaturally(proof);

  // A budget 5% under the natural size must not cost the pictures three
  // quarters of their pixels. The allocator spends one ladder step at a time
  // and stops the moment the file fits, so the overshoot is bounded by the last
  // step it took — not by a reserve that was wrong by the size of the assets.
  const maxBytes = natural.budget.reserveBytes + Math.floor(natural.budget.assetBytes * 0.95);
  const result = await emit(proof, { maxBytes }, budgetDeps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.ok(result.value.bytes <= maxBytes);

  const biggestStep = Math.max(...result.value.degradations.map((d) => d.savedBytes), 0);
  const unused = maxBytes - result.value.bytes;
  assert.ok(
    unused <= biggestStep,
    `left ${unused} bytes of a ${maxBytes}-byte budget unused, more than the ${biggestStep}-byte step that overshot it`,
  );
});

test('the reported saving is the saving the file made (C2, §17.10)', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 220 });
  const natural = await emitNaturally(proof);
  const before = measuredFromFile(natural.html);

  let sawADegradation = false;
  for (const fraction of [0.9, 0.75, 0.6, 0.45, 0.3]) {
    const maxBytes = natural.budget.reserveBytes + Math.floor(natural.budget.assetBytes * fraction);
    const result = await emit(proof, { maxBytes }, budgetDeps);
    assert.equal(result.ok, true, `budget ${fraction} (maxBytes ${maxBytes}): ${result.ok ? '' : result.error}`);
    if (result.value.degradations.length === 0) continue;
    sawADegradation = true;

    const after = measuredFromFile(result.value.html);
    const reported = result.value.degradations.reduce((sum, d) => sum + d.savedBytes, 0);
    assert.equal(
      reported, before.bytes - after.bytes,
      `budget ${fraction}: the report claims ${reported} bytes saved and the file gave back ${before.bytes - after.bytes}`,
    );
    for (const line of result.value.degradations) {
      assert.equal(line.savedBytes, line.beforeBytes - line.afterBytes, `${line.assetId}: savedBytes is not the delta`);
      assert.ok(line.copies >= 1, `${line.assetId}: a line must say how many copies of the payload it is about`);
      assert.equal(line.afterBytes, line.copies * (line.afterBytes / line.copies), `${line.assetId}: afterBytes must be the document cost`);
    }
  }
  assert.equal(sawADegradation, true, 'the fixture must degrade at some budget, or this test asserts nothing');
});

test('an asset written twice is charged twice (C2)', () => {
  // The accounting has to survive a document that genuinely carries a payload
  // more than once — two <img> tags on the opening beat showing the same
  // picture both need a real src, and only one of them can lend it to the media
  // table. `countAssetCopies` is what says so.
  const uri = pngDataUri(16, 16, 7);
  const other = pngDataUri(24, 24, 9);
  const assets = [
    { assetId: 'a', assetIds: ['a'], dataUri: uri, bytes: utf8Length(uri) },
    { assetId: 'b', assetIds: ['b'], dataUri: other, bytes: utf8Length(other) },
  ];
  const html = `<img src="${uri}"><img src="${uri}"><i>${other}</i>`;
  const copies = countAssetCopies(html, assets);
  assert.equal(copies.get(uri), 2);
  assert.equal(copies.get(other), 1);

  const footprint = assetFootprint(html, assets);
  assert.equal(footprint.assetBytes, 2 * utf8Length(uri) + utf8Length(other));
  assert.equal(footprint.reserveBytes + footprint.assetBytes, utf8Length(html));
  assert.equal(footprint.byAssetId.get('a'), 2);
  assert.equal(footprint.inPayload.length, 0);
});

test('a payload the document never writes out is reserve, not a line item (C2)', () => {
  // Anything `splitMedia` leaves in the model travels inside the deflated,
  // base64 payload. Its bytes are real and they are counted — in the reserve,
  // where they are — but no per-asset saving can be measured for it, so the
  // budgeter neither promises one nor pretends the asset is absent.
  const uri = pngDataUri(16, 16, 3);
  const assets = [{ assetId: 'hidden', assetIds: ['hidden'], dataUri: uri, bytes: utf8Length(uri) }];
  const html = '<p>nothing here carries it</p>';
  const footprint = assetFootprint(html, assets);
  assert.equal(footprint.assetBytes, 0);
  assert.equal(footprint.reserveBytes, utf8Length(html));
  assert.equal(footprint.inPayload.length, 1);
  assert.equal(footprint.byAssetId.get('hidden'), 0);
});

test('an asset the budgeter cannot measure is named rather than passed over (C2)', () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 64 });
  const assets = dedupeAssets(collectAssets(proof));
  const copies = new Map(assets.flatMap((a) => a.assetIds.map((id) => [id, 0])));
  const result = budgetAssets(proof, 60_000, { copies, reserveBytes: 500_000, renderScene: sceneRenderer(proof) });
  assert.deepEqual(result.plan, [], 'nothing the file does not write out can be degraded on a promise');
  assert.ok(result.undegradable.length > 0, 'and nothing may be silently passed over either');
  for (const entry of result.undegradable) {
    assert.match(entry.reason, /compressed model payload/);
  }
});
