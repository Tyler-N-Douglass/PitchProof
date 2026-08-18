/**
 * The provenance label (§9, §18.1, §22.6) — the render-side half of the law the
 * emitter enforces.
 *
 * What is asserted here:
 *   - every layout that renders an illustrative rendition renders a
 *     `pp-provenance` element inside that rendition's own subtree;
 *   - a `client-supplied` or `verified-by-user` rendition does not get one;
 *   - the label never carries `data-pp-el`, so no beat can hide it;
 *   - the label survives every beat of every scene;
 *   - `labelIllustrative: false` is honoured exactly as given — and the
 *     boundary that makes that safe is asserted too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toHtml, walk } from '../../src/core/vdom.js';
import { applyBeat } from '../../src/runtime/runtime.js';
import { beatFrame, REVEAL_ATTR } from '../../src/runtime/beats.js';
import { normalizeEmitOptions, SCENE_LAYOUTS } from '../../src/core/contracts.js';
import {
  buildScene, renderSceneTree, measureScene, PROVENANCE_LABEL_CLASS, needsProvenanceLabel,
} from '../../src/scene/index.js';
import { layoutCases, contextFor, specimen, rendition, localeFanout } from '../fixtures/scene/content.mjs';

/** Every element carrying a class, as a flat list with its ancestry. */
function findAll(tree, predicate) {
  /** @type {any[]} */
  const out = [];
  const visit = (node, ancestors) => {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) { node.forEach((child) => visit(child, ancestors)); return; }
    if (typeof node !== 'object' || 'raw' in node) return;
    if (predicate(node)) out.push({ node, ancestors });
    (node.c || []).forEach((child) => visit(child, ancestors.concat([node])));
  };
  visit(tree, []);
  return out;
}

const isLabel = (node) => String(node.a.class || '').split(/\s+/).includes(PROVENANCE_LABEL_CLASS);

/** Renditions in one shape per provenance value, for the same layout. */
function trio() {
  return [
    rendition({ id: 'rd_ill', label: 'Illustrative variant', provenance: 'illustrative', blocks: sample('Illustrative') }),
    rendition({ id: 'rd_client', label: 'Client supplied', provenance: 'client-supplied', blocks: sample('Client') }),
    rendition({ id: 'rd_verified', label: 'Verified', provenance: 'verified-by-user', blocks: sample('Verified') }),
  ];
}

function sample(word) {
  return [
    { type: 'heading', level: 2, text: `${word} heading for the drive unit page` },
    { type: 'paragraph', text: `${word} body copy carried through from the source specimen.` },
    { type: 'quote', text: `${word} pull quote taken from the page.`, attribution: 'Product page' },
    { type: 'media', ref: 'md_hero', caption: `${word} hero` },
  ];
}

test('§9: an illustrative rendition is labelled, in every layout, inside its own subtree', () => {
  for (const layout of SCENE_LAYOUTS) {
    const rends = trio();
    const spec = specimen();
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Provenance', subhead: 'All three states' });
    const ctx = contextFor(scene, { specimen: spec, renditions: rends });
    const tree = renderSceneTree(scene, ctx);

    const labels = findAll(tree, isLabel);
    assert.ok(labels.length > 0, `${layout}: no provenance label at all`);

    // Each label sits inside the subtree of the rendition it describes.
    for (const { node, ancestors } of labels) {
      const owner = node.a['data-pp-provenance-for'];
      assert.ok(owner, `${layout}: a label names no rendition`);
      const inSubtree = ancestors.some((a) => a.a['data-pp-rendition'] === owner);
      assert.ok(inSubtree, `${layout}: the label for ${owner} is outside its subtree`);
    }

    // And the illustrative rendition is among the ones labelled.
    const labelled = new Set(labels.map(({ node }) => node.a['data-pp-provenance-for']));
    assert.ok(labelled.has('rd_ill'), `${layout}: the illustrative rendition is unlabelled`);
  }
});

test('§9: client-supplied and verified-by-user renditions are not labelled', () => {
  for (const layout of SCENE_LAYOUTS) {
    const rends = trio();
    const spec = specimen();
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Provenance' });
    const ctx = contextFor(scene, { specimen: spec, renditions: rends });
    const labelled = new Set(findAll(renderSceneTree(scene, ctx), isLabel)
      .map(({ node }) => node.a['data-pp-provenance-for']));
    assert.ok(!labelled.has('rd_client'), `${layout}: laballed client-supplied content`);
    assert.ok(!labelled.has('rd_verified'), `${layout}: labelled verified content`);
  }
});

test('needsProvenanceLabel labels anything that is not one of the two safe values', () => {
  assert.equal(needsProvenanceLabel({ provenance: 'illustrative' }), true);
  assert.equal(needsProvenanceLabel({ provenance: 'client-supplied' }), false);
  assert.equal(needsProvenanceLabel({ provenance: 'verified-by-user' }), false);
  // A value this lane has never heard of is labelled, not trusted.
  assert.equal(needsProvenanceLabel({ provenance: 'probably-fine' }), true);
  assert.equal(needsProvenanceLabel({}), true);
  assert.equal(needsProvenanceLabel(null), false);
});

test('§18.1: the label carries no data-pp-el, so no beat can hide it', () => {
  for (const layout of SCENE_LAYOUTS) {
    const rends = trio();
    const spec = specimen();
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Provenance' });
    const ctx = contextFor(scene, { specimen: spec, renditions: rends });
    const tree = renderSceneTree(scene, ctx);
    for (const { node } of findAll(tree, isLabel)) {
      assert.equal(node.a[REVEAL_ATTR], undefined, `${layout}: the label is revealable, so a beat could hide it`);
    }
    // …and it is never marked unrevealed at any beat.
    for (let n = 0; n < scene.beats.length; n++) {
      const applied = applyBeat(tree, beatFrame(scene, n));
      for (const { node } of findAll(applied, isLabel)) {
        const cls = String(node.a.class || '').split(/\s+/);
        assert.ok(!cls.includes('pp-unrevealed'), `${layout}: the label was hidden at beat ${n}`);
        assert.notEqual(node.a['aria-hidden'], 'true', `${layout}: the label was hidden from assistive tech at beat ${n}`);
      }
    }
  }
});

test('the label says plainly that the content is illustrative', () => {
  const rends = [rendition({ id: 'rd_x', label: 'Variant', provenance: 'illustrative', blocks: sample('X') })];
  const spec = specimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: rends, headline: 'H' });
  const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends })));
  assert.match(html, /class="pp-provenance"/);
  assert.match(html, /Illustrative/);
  assert.match(html, /not client-approved/);
});

test('the label is measured, so the emitter can check its size and contrast against real numbers', () => {
  const rends = [rendition({ id: 'rd_x', label: 'Variant', provenance: 'illustrative', blocks: sample('X') })];
  const spec = specimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: rends, headline: 'H' });
  const ctx = contextFor(scene, { specimen: spec, renditions: rends });
  for (const bp of ['sm', 'md', 'lg']) {
    const boxes = measureScene(scene, ctx, bp).boxes.filter((b) => b.role === 'provenance');
    assert.ok(boxes.length > 0, `no provenance box at ${bp}`);
    for (const box of boxes) {
      // §18.1's size floor is 11px; runtime.css sets 12 and this reports it.
      assert.ok(box.style.fontSizePx >= 11, `${bp}: label measured at ${box.style.fontSizePx}px`);
      assert.ok(box.containerWidthPx > 0);
    }
  }
});

test('labelIllustrative:false is honoured exactly as given — the flag is a build property, not a layout choice', () => {
  const rends = [rendition({ id: 'rd_x', label: 'Variant', provenance: 'illustrative', blocks: sample('X') })];
  const spec = specimen();
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'H' });
    const off = contextFor(scene, { specimen: spec, renditions: rends, labelIllustrative: false });
    assert.ok(!toHtml(renderSceneTree(scene, off)).includes('pp-provenance'), `${layout}: label rendered with the flag off`);
    const on = contextFor(scene, { specimen: spec, renditions: rends, labelIllustrative: true });
    assert.ok(toHtml(renderSceneTree(scene, on)).includes('pp-provenance'), `${layout}: label missing with the flag on`);
  }
});

test('the boundary: a review-reachable build cannot turn labelling off upstream', () => {
  // The layout honours the flag it is handed; forcing the flag for a build a
  // recipient can open is `normalizeEmitOptions`' job, and the runtime reads it
  // from there into `LayoutContext.labelIllustrative`. Asserted here so the
  // division of responsibility is a test rather than a comment.
  for (const mode of ['review', 'both']) {
    const options = normalizeEmitOptions({ mode, labelIllustrativeContent: false });
    assert.equal(options.labelIllustrativeContent, true, `${mode} build had labelling disabled`);
  }
  const presenterOnly = normalizeEmitOptions({ mode: 'presenter', labelIllustrativeContent: false });
  assert.equal(presenterOnly.labelIllustrativeContent, false,
    'a presenter-only build may disable labelling; that is the only case, and it is upstream of L8');
});

test('every illustrative rendition in a nine-market fan is labelled', () => {
  const rends = localeFanout(9);
  const spec = specimen();
  const scene = buildScene({ layout: 'fanOut', specimen: spec, renditions: rends, headline: 'Nine markets' });
  const ctx = contextFor(scene, { specimen: spec, renditions: rends });
  const labelled = new Set(findAll(renderSceneTree(scene, ctx), isLabel)
    .map(({ node }) => node.a['data-pp-provenance-for']));
  for (const r of rends) assert.ok(labelled.has(r.id), `${r.label} is unlabelled`);
});

test('a rendition rendered in two places in one layout is labelled in both', () => {
  // systemMap draws a node and a legend chip per rendition; the chip is the
  // labelled subtree, and the node is deliberately not a rendition subtree.
  const rends = localeFanout(3);
  const spec = specimen();
  const scene = buildScene({ layout: 'systemMap', specimen: spec, renditions: rends, headline: 'Flow' });
  const tree = renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends }));
  const owners = findAll(tree, (n) => typeof n.a['data-pp-rendition'] === 'string');
  for (const { node } of owners) {
    const labels = findAll(node, isLabel);
    assert.ok(labels.length > 0, `a rendition subtree for ${node.a['data-pp-rendition']} carries no label`);
  }
});
