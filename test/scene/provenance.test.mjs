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
  ledgerAllowance,
} from '../../src/scene/index.js';
import { layoutCases, contextFor, specimen, rendition, localeFanout, channelVariants, heroMedia, PIXEL } from '../fixtures/scene/content.mjs';
import { buildCorpusProof } from '../fixtures/corpus/proof.mjs';

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

/**
 * The ids of the renditions a rendered tree labels, unioned across every
 * `data-pp-rendition` subtree the label sits in. This is the emitter's own
 * reading of the markup (`src/emit/provenance.js`), rewritten here so the
 * assertion is independent of the implementation it is checking.
 * @param {any} tree
 * @returns {Set<string>}
 */
function labelledIn(tree) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const { node, ancestors } of findAll(tree, isLabel)) {
    for (const a of ancestors.concat([node])) {
      const owner = a.a && a.a['data-pp-rendition'];
      if (typeof owner === 'string' && owner) out.add(owner);
    }
  }
  return out;
}

/**
 * Every rendition a scene declares, needs a label for, and did not get one for.
 * @param {any} tree
 * @param {any[]} renditions   the scene's resolved `renditionIds`
 * @returns {any[]}
 */
function unlabelled(tree, renditions) {
  const labelled = labelledIn(tree);
  return renditions.filter((r) => needsProvenanceLabel(r) && !labelled.has(r.id));
}

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

test('a promotion record never reaches the screen', () => {
  // §4 gives `Rendition` one notes field and L7 writes its promotion record
  // into it. That record is the seller's bookkeeping, not the client's content.
  const rends = channelVariants();
  const promoted = rends.find((r) => r.provenance === 'verified-by-user');
  assert.match(promoted.notes, /^promoted:/, 'the fixture carries a promotion record');
  const spec = specimen();
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Notes' });
    const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends })));
    assert.ok(!html.includes('promoted:'), `${layout} rendered a promotion record`);
    assert.ok(!html.includes('t.douglass'), `${layout} rendered who promoted it`);
  }
  // …while a note the user actually wrote is rendered verbatim.
  const scene = buildScene({ layout: 'sideNote', specimen: spec, renditions: rends, headline: 'Notes' });
  const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends })));
  assert.ok(html.includes('Subject line held to 48 characters'), 'a real note is shown');
});

// ---------------------------------------------------------------------------
// The defect: a layout that selects, on a branch that selected nothing
// ---------------------------------------------------------------------------

/**
 * The shapes a real corpus produces that the eight layouts' fallback and
 * empty-state branches were written for. Each one is a scene that declares an
 * illustrative rendition and gives the layout a reason to render something
 * other than that rendition.
 * @returns {{name: string, specimen: any, renditions: any[]}[]}
 */
function fallbackShapes() {
  const withQuote = specimen();
  const noQuote = specimen({ blocks: specimen().blocks.filter((b) => b.type !== 'quote') });
  const ill = (spec) => rendition({ provenance: 'illustrative', ...spec });

  return [
    {
      // The corpus case. Sectioning a page at heading boundaries hands a
      // quoteCard scene a rendition with no `quote` block in it, and the
      // layout falls through to the specimen's quote.
      name: 'rendition carries no quote block, specimen does',
      specimen: withQuote,
      renditions: [ill({
        id: 'rd_noquote',
        label: 'Channel variants 4/6',
        blocks: [
          { type: 'heading', level: 2, text: 'Ordering and lead time' },
          { type: 'list', ordered: false, items: ['Standard build ships in six weeks'] },
        ],
      })],
    },
    {
      // Neither side has a quote: quoteCard falls all the way through to the
      // scene's own headline, which in a real proof is the rendition's leading
      // heading — rendition-derived text, on screen, with nothing to label it.
      name: 'no quote anywhere in the model',
      specimen: noQuote,
      renditions: [ill({
        id: 'rd_noquote_either',
        label: 'Brief to asset 4/6',
        blocks: [{ type: 'paragraph', text: 'Start from the cleaning interval, not the resistance.' }],
      })],
    },
    {
      // sideNote keeps a note only for a rendition block that carries text. A
      // rendition of nothing but media contributes no note at all.
      name: 'rendition of media blocks only',
      specimen: withQuote,
      renditions: [ill({
        id: 'rd_mediaonly',
        label: 'Assembled at three breakpoints',
        blocks: [{ type: 'media', ref: 'md_hero', caption: 'The same page at 390px' }],
        media: [heroMedia()],
      })],
    },
    {
      // fullBleed picks one carrier. With the specimen holding the only usable
      // image, the renditions are declared and none is the picked one.
      name: 'specimen holds the image, renditions do not',
      specimen: withQuote,
      renditions: [
        ill({ id: 'rd_nomedia_a', label: 'Locale fanout 1/9', blocks: [{ type: 'paragraph', text: 'Förderband-Antriebseinheiten für den Dauerbetrieb.' }] }),
        ill({ id: 'rd_nomedia_b', label: 'Locale fanout 2/9', blocks: [{ type: 'paragraph', text: 'Unités motrices de convoyeur pour service continu.' }] }),
      ],
    },
    {
      // fullBleed again, from the other side: one rendition carries the image
      // and is scoped in the overlay; the others are declared and dropped.
      name: 'one rendition carries the image, the rest do not',
      specimen: specimen({ media: [], blocks: specimen().blocks.filter((b) => b.type !== 'media') }),
      renditions: [
        ill({
          id: 'rd_withmedia',
          label: 'Hero, assembled',
          blocks: [{ type: 'media', ref: 'md_hero' }],
          media: [{ id: 'md_hero', dataUri: PIXEL, alt: 'The assembled hero', intrinsic: { w: 1200, h: 675 }, bytes: 68 }],
        }),
        ill({ id: 'rd_nomedia_c', label: 'Hero, second cut', blocks: [{ type: 'paragraph', text: 'The same hero at a second crop.' }] }),
      ],
    },
    {
      // systemMap draws five output nodes and collapses the rest into one "N
      // more renditions" node, which names no rendition and can scope none.
      name: 'more renditions than the map can draw',
      specimen: withQuote,
      renditions: localeFanout(9),
    },
    {
      // A rendition with nothing in it at all — the studio's state between
      // attaching a rendition and pasting into it.
      name: 'rendition with no blocks',
      specimen: withQuote,
      renditions: [ill({ id: 'rd_empty', label: 'Pasted variant', blocks: [] })],
    },
    {
      // No specimen: several layouts take their empty-state branch here.
      name: 'no specimen at all',
      specimen: null,
      renditions: [ill({ id: 'rd_orphan', label: 'Variant with no source', blocks: [] })],
    },
  ];
}

test('§18.1: every branch of every layout labels every illustrative rendition the scene declares', () => {
  for (const shape of fallbackShapes()) {
    for (const layout of SCENE_LAYOUTS) {
      const scene = buildScene({
        layout,
        specimen: shape.specimen,
        renditions: shape.renditions,
        headline: 'Ordering and lead time',
        subhead: 'northwind-industrial.example/equipment/heat-exchangers/hx-400',
      });
      const ctx = contextFor(scene, { specimen: shape.specimen, renditions: shape.renditions });
      const tree = renderSceneTree(scene, ctx);
      const missing = unlabelled(tree, shape.renditions).map((r) => r.label);
      assert.deepEqual(missing, [],
        `${layout} / ${shape.name}: ${missing.length} declared illustrative rendition(s) rendered with no provenance label`);
    }
  }
});

test('the defect: a quoteCard whose rendition holds no quote still labels that rendition', () => {
  // The exact shape the corpus produced. Before the fix this scene rendered the
  // specimen's quote, declared an illustrative rendition in `renditionIds`, and
  // carried no `pp-provenance` element anywhere — which the emitter refused at
  // severity 1 (`PROVENANCE_UNLABELED`, check `label-count`).
  const spec = specimen();
  assert.ok(spec.blocks.some((b) => b.type === 'quote'), 'the specimen has a quote to fall back to');
  const rends = [rendition({
    id: 'rd_b43b2462f6be',
    label: 'Channel variants 4/6',
    provenance: 'illustrative',
    blocks: [
      { type: 'heading', level: 2, text: 'Ordering and lead time' },
      { type: 'list', ordered: false, items: ['Standard build ships in six weeks from order.'] },
    ],
  })];
  assert.ok(!rends[0].blocks.some((b) => b.type === 'quote'), 'the rendition has no quote of its own');

  const scene = buildScene({ layout: 'quoteCard', specimen: spec, renditions: rends, headline: 'Ordering and lead time' });
  const tree = renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends }));

  const labels = findAll(tree, isLabel);
  assert.equal(labels.length, 1, 'exactly one label, for the one rendition that needs one');
  assert.equal(labels[0].node.a['data-pp-provenance-for'], 'rd_b43b2462f6be');
  assert.ok(labels[0].ancestors.some((a) => a.a['data-pp-rendition'] === 'rd_b43b2462f6be'),
    'the label sits inside a subtree scoped to the rendition it names');

  // …and the label names which rendition it is about, so it does not read as
  // marking the client's own quote — which is on the same screen — illustrative.
  const html = toHtml(tree);
  assert.match(html, /pp-provenance-ledger/);
  assert.ok(html.includes('Channel variants 4/6'), 'the ledger row names the rendition');
});

test('the ledger appears only where the layout did not label the rendition in place', () => {
  // A fan card, a split column and a legend chip each carry their own label, so
  // the ledger is not free noise on the layouts that were already correct.
  const rends = localeFanout(3);
  const spec = specimen();
  for (const layout of ['fanOut', 'splitBeforeAfter', 'stack', 'contentsIndex']) {
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Three markets' });
    const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends })));
    assert.ok(!html.includes('pp-provenance-ledger'), `${layout} rendered a ledger it does not need`);
    assert.equal((html.match(/class="pp-provenance"/g) || []).length, rends.length,
      `${layout}: one label per rendition, and no more`);
  }
});

test('the ledger never labels content the client supplied or verified', () => {
  const rends = [
    rendition({ id: 'rd_client2', label: 'Their own subject line', provenance: 'client-supplied', blocks: [{ type: 'paragraph', text: 'Copy the client pasted in themselves.' }] }),
    rendition({ id: 'rd_verified2', label: 'Signed off', provenance: 'verified-by-user', blocks: [{ type: 'paragraph', text: 'Copy somebody promoted.' }] }),
  ];
  const spec = specimen();
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Nothing to label' });
    const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends })));
    assert.ok(!html.includes('pp-provenance'), `${layout} labelled content that needs no label`);
  }
});

test('a ledger row is not revealable, and survives every beat', () => {
  const spec = specimen();
  const rends = [rendition({ id: 'rd_ledger', label: 'Unshown variant', provenance: 'illustrative', blocks: [] })];
  const scene = buildScene({ layout: 'quoteCard', specimen: spec, renditions: rends, headline: 'A headline' });
  const tree = renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends }));
  const rows = findAll(tree, (n) => String(n.a.class || '').includes('pp-provenance-ledger-row'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].node.a[REVEAL_ATTR], undefined, 'a ledger row is revealable, so a beat could hide it');
  for (let n = 0; n < scene.beats.length; n++) {
    const applied = applyBeat(tree, beatFrame(scene, n));
    assert.equal(findAll(applied, isLabel).length, 1, `the ledger label went missing at beat ${n}`);
  }
});

test('the ledger is measured, so its type and the room it takes are both real numbers', () => {
  const spec = specimen();
  const rends = [rendition({ id: 'rd_ledger2', label: 'Unshown variant', provenance: 'illustrative', blocks: [] })];
  const scene = buildScene({ layout: 'quoteCard', specimen: spec, renditions: rends, headline: 'A headline' });
  const ctx = contextFor(scene, { specimen: spec, renditions: rends });

  for (const bp of ['sm', 'md', 'lg']) {
    const boxes = measureScene(scene, ctx, bp).boxes;
    const label = boxes.filter((b) => b.role === 'provenance' && b.slot === 'provenanceLedger');
    assert.equal(label.length, 1, `${bp}: the ledger label is not measured`);
    assert.ok(label[0].style.fontSizePx >= 11, `${bp}: §18.1 size floor`);
    assert.ok(label[0].containerWidthPx > 0 && label[0].containerHeightPx > 0, `${bp}: the ledger row has no box`);

    // The strip is in flow at the foot of the stage, so everything above it has
    // that much less room. A measurement that ignored it would report the quote
    // fitting a box the ledger already took part of (§22.2).
    const bare = buildScene({ layout: 'quoteCard', specimen: spec, renditions: [], headline: 'A headline' });
    const bareBoxes = measureScene(bare, contextFor(bare, { specimen: spec, renditions: [] }), bp).boxes;
    const quoted = boxes.find((b) => b.role === 'quote');
    const bareQuote = bareBoxes.find((b) => b.role === 'quote');
    assert.ok(quoted && bareQuote, `${bp}: no quote box to compare`);
    assert.ok(quoted.containerHeightPx < bareQuote.containerHeightPx,
      `${bp}: the quote box is measured as if the ledger below it took no room`);
    assert.equal(
      Math.round(bareQuote.containerHeightPx - quoted.containerHeightPx),
      Math.round(ledgerAllowance(bp)),
      `${bp}: the room deducted is not the room the strip takes`,
    );
  }
});

// ---------------------------------------------------------------------------
// The same law, over the corpus rather than over a fixture that dodges
// ---------------------------------------------------------------------------

test('§18.1 holds over every scene of a proof built from the Northwind corpus', async () => {
  const proof = await buildCorpusProof();
  const renditionById = new Map(proof.renditions.map((r) => [r.id, r]));
  const media = new Map((proof.media || []).map((m) => [m.id, m]));
  const scenes = [...proof.spine, ...proof.branches.flatMap((b) => b.scenes)];
  assert.ok(scenes.length > 0, 'the corpus proof has scenes');

  /** @type {string[]} */
  const failures = [];
  let quoteCardsWithAnUnquotedRendition = 0;

  for (const scene of scenes) {
    const declared = (scene.renditionIds || []).map((id) => renditionById.get(id)).filter(Boolean);
    const spec = proof.specimens.find((s) => s.id === scene.specimenId) || null;
    const tree = renderSceneTree(scene, {
      brand: proof.brand,
      specimen: spec,
      renditions: declared,
      media,
      labelIllustrative: true,
    });

    if (scene.layout === 'quoteCard'
      && declared.some((r) => needsProvenanceLabel(r) && !(r.blocks || []).some((b) => b.type === 'quote'))) {
      quoteCardsWithAnUnquotedRendition += 1;
    }

    for (const r of unlabelled(tree, declared)) {
      failures.push(`${scene.id} (${scene.layout}): "${r.label}" (${r.id}, ${r.provenance})`);
    }
  }

  assert.deepEqual(failures, [],
    `${failures.length} rendition(s) declared by a corpus scene render with no provenance label`);

  // The corpus is only a regression test for this defect while it still
  // contains the shape that produced it: a quoteCard scene whose declared
  // illustrative rendition holds no quote block of its own.
  assert.ok(quoteCardsWithAnUnquotedRendition > 0,
    'the corpus no longer produces the scene shape this test exists for — re-derive it before deleting the test');
});
