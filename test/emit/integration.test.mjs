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
import { assertProvenance, walkWithChain, RENDITION_ATTR } from '../../src/emit/provenance.js';
import { requiresProvenanceLabel } from '../../src/emit/promotion.js';
import { Runtime } from '../../src/runtime/runtime.js';
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
  // `splitBeforeAfter` puts `data-pp-rendition` on the panel head *and* on each
  // body cell; the label lives only in the head. Letting the last subtree seen
  // decide reported a correctly labelled proof as bare, which is how this was
  // found. The union is asserted against the real layout, and the fixture is
  // asserted to still exercise the case — otherwise the test could pass by
  // no longer testing anything.
  resetLayouts();
  registerAllLayouts();
  const proof = emitProof({ imageEdge: 24 });
  const scene = proof.spine.find((s) => s.layout === 'splitBeforeAfter' && s.renditionIds.length > 1);
  assert.ok(scene, 'the fixture must contain a split scene with more than one rendition');

  const illustrative = proof.renditions.find((r) => scene.renditionIds.includes(r.id) && requiresProvenanceLabel(r));
  assert.ok(illustrative, 'the split scene must carry a rendition that needs a label');

  const runtime = new Runtime(proof, {});
  const tree = runtime.renderScene(scene);

  /** @type {{chain: any[], hasLabel: boolean}[]} */
  const scopes = [];
  walkWithChain(tree, (node, chain) => {
    const desc = chain[chain.length - 1];
    if (desc.attrs[RENDITION_ATTR] !== illustrative.id) return;
    let hasLabel = false;
    walkWithChain(node, (_inner, innerChain) => {
      if (innerChain[innerChain.length - 1].classes.includes(PROVENANCE_LABEL_CLASS)) hasLabel = true;
    });
    scopes.push({ chain, hasLabel });
  });

  assert.ok(scopes.length >= 2, `the real layout must render ${illustrative.id} in more than one subtree; got ${scopes.length}`);
  assert.equal(scopes.filter((s) => s.hasLabel).length, 1, 'exactly one of those subtrees carries the label');
  assert.ok(scopes.some((s) => !s.hasLabel), 'and at least one does not — which is the case that broke');

  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('the union does not make the subtree check vacuous', async () => {
  // If the label really is missing from every subtree, the emitter must still
  // refuse. Rendering through the real layouts and stripping the label proves
  // the union widened the search rather than switching the check off.
  resetLayouts();
  registerAllLayouts();
  const proof = emitProof({ imageEdge: 24 });
  const runtime = new Runtime(proof, {});

  /** @param {any} node @returns {any} */
  const stripLabels = (node) => {
    if (node === null || node === undefined || node === false) return node;
    if (Array.isArray(node)) return node.map(stripLabels);
    if (typeof node !== 'object' || 'raw' in node || !node.t) return node;
    if (String(node.a.class || '').split(/\s+/).includes(PROVENANCE_LABEL_CLASS)) return null;
    return { t: node.t, a: node.a, c: (node.c || []).map(stripLabels) };
  };

  const findings = assertProvenance(proof, '', runtimeCss, {
    renderScene: (scene) => stripLabels(runtime.renderScene(scene)),
  });
  assert.ok(findings.length > 0, 'stripping every label must be caught');
  for (const f of findings) {
    assert.equal(f.severity, 1);
    assert.equal(f.code, 'PROVENANCE_UNLABELED');
  }
  assert.ok(findings.some((f) => /carries no \.pp-provenance element/.test(f.message)), 'the subtree check must be the thing that fired');
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
