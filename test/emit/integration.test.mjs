/**
 * The emitter against the real layouts and overlays, not the stand-ins.
 *
 * Every other file in `test/emit/**` uses `test/fixtures/emit/layouts.mjs`, so
 * that the emitter's laws are tested against markup the emitter does not
 * control. That is the right default and it misses exactly one class of defect:
 * the emitter agreeing with itself. This file emits through `src/artifact.js`
 * — the composition root the build bundles, with L8's eight layouts and L9's
 * overlays — and asserts the artifact comes out clean.
 *
 * It caught one real defect on first run: a rendition rendered by two elements
 * in one scene (a panel head and a body cell) had its label counted against the
 * wrong subtree, and a correctly labelled proof was refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, scanForNetworkReferences } from '../../src/emit/index.js';
import { registerAllLayouts, PROVENANCE_LABEL_CLASS } from '../../src/scene/index.js';
import { resetLayouts, registeredLayouts, missingLayouts } from '../../src/runtime/layouts.js';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof } from '../fixtures/emit/proofs.mjs';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();
const deps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

test('all eight §4 layouts are registered by L8', () => {
  resetLayouts();
  registerAllLayouts();
  assert.deepEqual(missingLayouts(), []);
  assert.equal(registeredLayouts().length, 8);
});

test('a proof emits cleanly through the real layouts', async () => {
  resetLayouts();
  registerAllLayouts();
  const result = await emit(emitProof({ imageEdge: 64 }), {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.deepEqual(result.value.findings, []);
  assert.deepEqual(scanForNetworkReferences(result.value.html), []);
  assert.ok(result.value.bytes > 100_000, 'the artifact carries the whole runtime');
});

test('the real layouts label every illustrative rendition where the emitter looks for it', async () => {
  resetLayouts();
  registerAllLayouts();
  const proof = emitProof({ imageEdge: 32 });
  const illustrative = proof.renditions.filter((r) => r.provenance === 'illustrative');
  assert.ok(illustrative.length >= 2, 'the fixture must carry illustrative renditions');
  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.ok(result.value.html.includes(PROVENANCE_LABEL_CLASS), 'the opening scenes must carry the label in the file');
});

test('the artifact carries no placeholder layouts', async () => {
  resetLayouts();
  registerAllLayouts();
  const result = await emit(emitProof({ imageEdge: 32 }), {}, deps);
  // Scoped to the pre-rendered stage: the runtime bundle carries the
  // placeholder *renderer* as source, which is not the same as rendering one.
  const html = result.value.html;
  const stage = html.slice(html.indexOf('<div id="pp-stage-root"'), html.indexOf('<noscript>'));
  assert.ok(!stage.includes('pp-layout--placeholder'), 'a placeholder in the artifact is a missing layout');
  assert.ok(!stage.includes('Layout not registered'));
});

test('the real artifact bundle survives the scanner', () => {
  assert.deepEqual(scanForNetworkReferences(`<script>${runtimeJs}</script><style>${runtimeCss}</style>`), []);
});

test('the emitter is byte-identical through the real layouts too', async () => {
  resetLayouts();
  registerAllLayouts();
  const proof = emitProof({ imageEdge: 32 });
  const a = await emit(proof, {}, deps);
  const b = await emit(proof, {}, deps);
  assert.equal(a.value.html, b.value.html);
});

test('a rendition rendered by more than one element in a scene is still counted as labelled', async () => {
  // `splitBeforeAfter` puts `data-pp-rendition` on both the panel head and each
  // body cell; the label lives only in the head. The emitter must union the
  // subtrees rather than let the last one decide.
  resetLayouts();
  registerAllLayouts();
  const proof = emitProof({ imageEdge: 24 });
  const split = proof.spine.find((s) => s.layout === 'splitBeforeAfter' && s.renditionIds.length > 1);
  assert.ok(split, 'the fixture must contain a split scene with more than one rendition');
  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('every layout in the closed set emits without a finding', async () => {
  resetLayouts();
  registerAllLayouts();
  const base = emitProof({ imageEdge: 24 });
  const layouts = ['splitBeforeAfter', 'fanOut', 'stack', 'fullBleed', 'sideNote', 'systemMap', 'quoteCard', 'contentsIndex'];
  for (const layout of layouts) {
    const proof = { ...base, spine: base.spine.map((s, i) => (i === 1 ? { ...s, layout } : s)) };
    const result = await emit(proof, {}, deps);
    assert.equal(result.ok, true, `layout ${layout}: ${result.ok ? '' : result.error}`);
    assert.deepEqual(result.value.findings, [], `layout ${layout} produced findings`);
  }
});
