/**
 * The §18.3 edit marker — the artifact's half of the edit record.
 *
 * §18.3: *"The prospect's own content is presented unmodified on the 'before'
 * side. If a specimen was edited, the artifact says so."*
 *
 * The model has said so since L6's dispute #4 (`Specimen.edited`, `editNotes`,
 * written only by `markEdited`), and the studio has shown it since L12 put it in
 * the specimens panel. CRITIQUE-3 P6 is that the **artifact** did not: the deck
 * the client is actually shown — the one thing §18.3 is written about — printed
 * the specimen's URL, locale and kind under every "before" panel and nothing
 * about the edit.
 *
 * What is asserted here:
 *   - a specimen marked edited carries the marker in **every one of the eight
 *     layouts**, on the ordinary branch and on the empty-state branch;
 *   - the marker sits inside the subtree of the specimen it is about;
 *   - it is not suppressible: no `data-pp-el`, never `pp-unrevealed` at any
 *     beat, and no flag — including `labelIllustrative: false`, which §9 does
 *     give the build over the *provenance* label — turns it off;
 *   - an unedited specimen gets no marker anywhere, so the marker means
 *     something;
 *   - it is measured, so the emitter can check its size against real numbers;
 *   - it says the fact and does not print the log.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toHtml } from '../../src/core/vdom.js';
import { applyBeat } from '../../src/runtime/runtime.js';
import { beatFrame, REVEAL_ATTR } from '../../src/runtime/beats.js';
import { SCENE_LAYOUTS } from '../../src/core/contracts.js';
import { markEdited } from '../../src/specimen/specimen.js';
import {
  buildScene, renderSceneTree, measureScene, boxGeometry, editedNoticeAllowance,
  EDITED_MARK_CLASS, EDITED_MARK_TEXT, EDITED_NOTICE_CLASS,
  specimenEdited, editRecordCount, editedMark, markedSpecimenIds,
} from '../../src/scene/index.js';
import { specimen, rendition, contextFor, localeFanout } from '../fixtures/scene/content.mjs';

/**
 * One note in the shape L11's `ASSET_MISSING` auto-fix actually writes: a full
 * sentence naming the file, its caption, the heading it sat under and why it
 * went. It is here at full length on purpose — it is the reason the marker
 * carries the fact and not the log.
 */
const REAL_NOTE = 'Removed an image — "/assets/product-hx400.png" (captioned "HX-400 shell-and-tube heat exchanger") '
  + ', under the heading "Specification" — during rehearsal: no media in this project carries that reference, so it '
  + 'would have shown to the room as a broken image. Everything else on the page is as it was captured.';

/** The specimen as the seller's click left it: through L6's only writer. */
function editedSpecimen(overrides = {}) {
  return markEdited(specimen(overrides), { note: REAL_NOTE, at: '2026-02-08T09:00:00.000Z' });
}

/** Every node matching a predicate, with its ancestry. */
function findAll(tree, predicate) {
  /** @type {{node: any, ancestors: any[]}[]} */
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

const isMark = (node) => String(node.a.class || '').split(/\s+/).includes(EDITED_MARK_CLASS);

/** The scene cases every layout is exercised with, per branch. */
function branches(spec) {
  return [
    { name: 'with renditions', renditions: localeFanout(3) },
    // The branch every layout has and nobody remembers: no renditions at all,
    // which is the empty state on five of the eight.
    { name: 'no renditions', renditions: [] },
    // …and a specimen with no blocks, which empties the other three.
    { name: 'no blocks', renditions: [], specimen: { ...spec, blocks: [] } },
  ];
}

test('§18.3: an edited specimen is marked in every layout, on every branch', () => {
  const spec = editedSpecimen();
  for (const layout of SCENE_LAYOUTS) {
    for (const branch of branches(spec)) {
      const subject = branch.specimen || spec;
      const scene = buildScene({
        layout, specimen: subject, renditions: branch.renditions, headline: 'Their page', subhead: 'As we changed it',
      });
      const ctx = contextFor(scene, { specimen: subject, renditions: branch.renditions });
      const tree = renderSceneTree(scene, ctx);
      const marks = findAll(tree, isMark);
      assert.ok(marks.length > 0, `${layout} (${branch.name}): the artifact does not say the specimen was edited`);

      // Each marker names the specimen and sits inside that specimen's subtree,
      // so it is a statement about the client's content and not about whatever
      // else the layout drew beside it.
      for (const { node, ancestors } of marks) {
        assert.equal(node.a['data-pp-edited-for'], subject.id, `${layout} (${branch.name}): a marker names no specimen`);
        assert.ok(ancestors.some((a) => a.a['data-pp-specimen'] === subject.id),
          `${layout} (${branch.name}): the marker is outside the specimen's subtree`);
      }
      assert.ok(markedSpecimenIds(tree).has(subject.id), `${layout} (${branch.name}): the sweep disagrees with the render`);
    }
  }
});

test('§18.3: an unedited specimen is not marked, in any layout', () => {
  const spec = specimen();
  assert.equal(specimenEdited(spec), false, 'the fixture starts unedited');
  for (const layout of SCENE_LAYOUTS) {
    const rends = localeFanout(3);
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Their page' });
    const tree = renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends }));
    assert.equal(findAll(tree, isMark).length, 0, `${layout}: an unedited specimen was marked as edited`);
    assert.ok(!toHtml(tree).includes(EDITED_NOTICE_CLASS), `${layout}: a notice strip with nothing to notice`);
  }
});

test('§18.3: the marker is not suppressible — no data-pp-el, and no beat hides it', () => {
  const spec = editedSpecimen();
  for (const layout of SCENE_LAYOUTS) {
    const rends = localeFanout(2);
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'Their page' });
    const tree = renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends }));
    for (const { node } of findAll(tree, isMark)) {
      assert.equal(node.a[REVEAL_ATTR], undefined, `${layout}: the marker is revealable, so a beat could hide it`);
    }
    for (let n = 0; n < scene.beats.length; n++) {
      const applied = applyBeat(tree, beatFrame(scene, n));
      const marks = findAll(applied, isMark);
      assert.ok(marks.length > 0, `${layout}: the marker vanished at beat ${n}`);
      for (const { node } of marks) {
        assert.ok(!String(node.a.class || '').split(/\s+/).includes('pp-unrevealed'),
          `${layout}: the marker was hidden at beat ${n}`);
        assert.notEqual(node.a['aria-hidden'], 'true', `${layout}: the marker was hidden from assistive tech at beat ${n}`);
      }
    }
  }
});

test('§18.3: no build flag turns the marker off — the function has no switch to flip', () => {
  const spec = editedSpecimen();
  // §9 gives a presenter-only build one legitimate way to drop the *provenance*
  // label. §18.3 gives nothing that power, and the enforcement is structural:
  // `editedMark` takes a specimen and nothing else.
  assert.equal(editedMark.length, 1, 'editedMark grew a second argument; a second argument is a switch');
  for (const layout of SCENE_LAYOUTS) {
    const rends = [rendition({ id: 'rd_x', label: 'Variant', provenance: 'illustrative', blocks: [] })];
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'H' });
    for (const flag of [true, false]) {
      const ctx = contextFor(scene, { specimen: spec, renditions: rends, labelIllustrative: flag });
      const html = toHtml(renderSceneTree(scene, ctx));
      assert.ok(html.includes(`class="${EDITED_MARK_CLASS}"`),
        `${layout}: labelIllustrative:${flag} dropped the §18.3 marker, which is not its to drop`);
    }
    // …and it is mode-invariant, like everything else a layout draws (L8-14).
    for (const mode of ['presenter', 'review']) {
      const ctx = contextFor(scene, { specimen: spec, renditions: rends, mode });
      assert.ok(toHtml(renderSceneTree(scene, ctx)).includes(EDITED_MARK_CLASS), `${layout}: no marker in ${mode} mode`);
    }
  }
});

test('the marker says the fact, and does not read the log out to the room', () => {
  const spec = editedSpecimen();
  const scene = buildScene({ layout: 'splitBeforeAfter', specimen: spec, renditions: [], headline: 'H' });
  const html = toHtml(renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: [] })));
  assert.match(html, /class="pp-edited"/);
  assert.match(html, /Edited/);
  assert.ok(html.includes(EDITED_MARK_TEXT), 'the marker does not say what it is for');
  // The note is a full sentence naming a file, a caption and a heading. It is
  // the studio's to show and a review surface's to carry; a meta line under a
  // panel cannot hold it, and half of it would be worse than none.
  assert.ok(!html.includes('/assets/product-hx400.png'), 'the log was printed on the stage');
  assert.ok(!html.includes('during rehearsal'), 'the log was printed on the stage');
  // The thread back to it is the count, so nothing downstream has to guess.
  assert.match(html, /data-pp-edit-notes="1"/);
});

test('the record count is a count of records, and says so about the model it was given', () => {
  assert.equal(editRecordCount(null), 0);
  assert.equal(editRecordCount(specimen()), 0);
  assert.equal(editRecordCount(editedSpecimen()), 1);
  const twice = markEdited(editedSpecimen(), { note: 'The seller cut two paragraphs for length.' });
  assert.equal(editRecordCount(twice), 2);
  // Blank strings are not records.
  assert.equal(editRecordCount({ editNotes: ['', '   ', 'a real note'] }), 1);
});

test('specimenEdited trusts neither half of the pair alone', () => {
  assert.equal(specimenEdited(null), false);
  assert.equal(specimenEdited(specimen()), false);
  assert.equal(specimenEdited({ edited: true }), true);
  // A record with the flag unset is still a record: something edited this
  // specimen and half-remembered to say so, and the marker is the wrong place
  // to be extending trust.
  assert.equal(specimenEdited({ edited: false, editNotes: ['Removed a block.'] }), true);
  assert.equal(specimenEdited({ edited: false, editNotes: [] }), false);
});

test('the marker is measured, so the emitter can check its size against real numbers', () => {
  const spec = editedSpecimen();
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: spec, renditions: localeFanout(2), headline: 'H' });
    const ctx = contextFor(scene, { specimen: spec, renditions: localeFanout(2) });
    for (const bp of ['sm', 'md', 'lg']) {
      const boxes = measureScene(scene, ctx, bp).boxes.filter((b) => b.role === 'editedMark');
      assert.ok(boxes.length > 0, `${layout}: no editedMark box at ${bp}`);
      for (const box of boxes) {
        // §18.1's size floor is 11px and this marker is the same 12px pill.
        assert.ok(box.style.fontSizePx >= 11, `${layout} ${bp}: marker measured at ${box.style.fontSizePx}px`);
        assert.ok(box.containerWidthPx > 0, `${layout} ${bp}: marker measured in a zero-width box`);
        assert.equal(box.fitsContent, true, `${layout} ${bp}: the pill is content-sized and must be reported as a bound`);
      }
    }
  }
});

test('the notice strip is the marker\'s home only where no panel carried it', () => {
  const spec = editedSpecimen();
  const rends = localeFanout(2);
  /** @type {Record<string, boolean>} */
  const strip = {};
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: spec, renditions: rends, headline: 'H' });
    const tree = renderSceneTree(scene, contextFor(scene, { specimen: spec, renditions: rends }));
    strip[layout] = toHtml(tree).includes(EDITED_NOTICE_CLASS);
  }
  // The four layouts that give the client's content a panel mark it there; the
  // four that do not get the strip. A layout moving between these two lists is a
  // decision, not an accident.
  assert.deepEqual(Object.keys(strip).filter((k) => !strip[k]).sort(),
    ['fanOut', 'sideNote', 'splitBeforeAfter', 'stack'],
    'a layout stopped marking the specimen in its own panel');
  assert.deepEqual(Object.keys(strip).filter((k) => strip[k]).sort(),
    ['contentsIndex', 'fullBleed', 'quoteCard', 'systemMap'],
    'a layout stopped falling back to the notice strip');
});

test('the notice strip costs room, and every box above it is measured against the stage it leaves', () => {
  const bp = 'md';
  const plain = boxGeometry('body', bp);
  const withNotice = boxGeometry('body', bp, { edited: true });
  assert.equal(plain.heightPx - withNotice.heightPx, editedNoticeAllowance(bp),
    'the strip is in flow and the measurement does not know it');

  // Both strips can be present at once, and they cost their own room each.
  const withBoth = boxGeometry('body', bp, { edited: true, ledger: true });
  assert.ok(withBoth.heightPx < withNotice.heightPx, 'a ledger and a notice cost one strip between them');

  // And the measurement of a real scene follows the render rather than a flag
  // passed beside it: `contentsIndex` renders the strip, so its boxes are short.
  const spec = editedSpecimen();
  const scene = buildScene({ layout: 'contentsIndex', specimen: spec, renditions: [], headline: 'H' });
  const edited = measureScene(scene, contextFor(scene, { specimen: spec, renditions: [] }), bp);
  const clean = specimen();
  const cleanScene = buildScene({ layout: 'contentsIndex', specimen: clean, renditions: [], headline: 'H' });
  const unedited = measureScene(cleanScene, contextFor(cleanScene, { specimen: clean, renditions: [] }), bp);
  const rowOf = (m) => m.boxes.find((b) => b.slot === 'indexRow');
  assert.ok(rowOf(edited) && rowOf(unedited), 'both scenes render index rows');
  assert.ok(rowOf(edited).containerHeightPx < rowOf(unedited).containerHeightPx,
    'the strip took no room out of the boxes above it');
});

test('the render is deterministic and the sweep does not double-mark', () => {
  const spec = editedSpecimen();
  for (const layout of SCENE_LAYOUTS) {
    const scene = buildScene({ layout, specimen: spec, renditions: localeFanout(2), headline: 'H' });
    const ctx = () => contextFor(scene, { specimen: spec, renditions: localeFanout(2) });
    const once = toHtml(renderSceneTree(scene, ctx()));
    assert.equal(once, toHtml(renderSceneTree(scene, ctx())), `${layout}: the render is not deterministic`);
    // One specimen, one marker: the sweep asks the tree what it already did.
    assert.equal(once.split(`class="${EDITED_MARK_CLASS}"`).length - 1, 1,
      `${layout}: the specimen is marked more than once`);
  }
});

test('a scene with no specimen at all says nothing about edits', () => {
  for (const layout of SCENE_LAYOUTS) {
    const rends = localeFanout(2);
    const scene = buildScene({ layout, specimen: null, renditions: rends, headline: 'H' });
    const tree = renderSceneTree(scene, contextFor(scene, { specimen: null, renditions: rends }));
    assert.equal(findAll(tree, isMark).length, 0, `${layout}: marked an edit to a specimen that is not there`);
  }
});
