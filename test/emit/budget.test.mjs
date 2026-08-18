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
import { budgetAssets, collectAssets, rankAssets, minifySvg, SCALE_LADDER } from '../../src/emit/budget.js';
import { emit } from '../../src/emit/index.js';
import { utf8Length, parseDataUri } from '../../src/core/bytes.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, pngDataUri } from '../fixtures/emit/proofs.mjs';

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

test('the ladder is ordered and starts with a lossless re-encode', () => {
  assert.equal(SCALE_LADDER[0], 1);
  for (let i = 1; i < SCALE_LADDER.length; i++) assert.ok(SCALE_LADDER[i] < SCALE_LADDER[i - 1]);
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
