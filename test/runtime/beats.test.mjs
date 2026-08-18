/**
 * §10 beats and §17.9 beat reversibility.
 *
 * Beats are additive reveals, backward navigation is exact, and nothing
 * auto-advances. All three are asserted here rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  revealedAt, newlyRevealedAt, sceneRevealsNothing, visibilityOf, scrollTargetFor,
  beatFrame, beatSignature, transitionMs, dwellHintLabel, EXIT_TRANSITION_MS, REVEAL_ATTR,
} from '../../src/runtime/beats.js';
import { applyBeat, Runtime } from '../../src/runtime/runtime.js';
import { h, toHtml, collectByAttr } from '../../src/core/vdom.js';
import { MAX_TRANSITION_MS } from '../../src/core/contracts.js';
import { makeProof, stillScene } from '../fixtures/make-proof.mjs';
import { buildDeck } from '../../src/runtime/deck.js';
import { allPositions, navigate, initialState } from '../../src/runtime/nav.js';

/** @returns {import('../../src/core/contracts.d.ts').Scene} */
function staged() {
  return {
    id: 'sc_x',
    layout: 'stack',
    headline: 'Staged',
    subhead: null,
    specimenId: null,
    renditionIds: [],
    branchAnchors: [],
    beats: [
      { id: 'b0', reveals: ['a', 'b'], presenterNote: 'Open here.', dwellHintMs: 15000 },
      { id: 'b1', reveals: ['c'], presenterNote: null, dwellHintMs: null },
      { id: 'b2', reveals: [], presenterNote: 'Pause and let it land.', dwellHintMs: null },
      { id: 'b3', reveals: ['d', 'a'], presenterNote: null, dwellHintMs: null },
    ],
  };
}

test('reveals are additive: beat n shows everything from beats 0..n', () => {
  const s = staged();
  assert.deepEqual([...revealedAt(s, 0)].sort(), ['a', 'b']);
  assert.deepEqual([...revealedAt(s, 1)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...revealedAt(s, 2)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...revealedAt(s, 3)].sort(), ['a', 'b', 'c', 'd']);
});

test('a re-declared reveal is not counted as new', () => {
  const s = staged();
  assert.deepEqual(newlyRevealedAt(s, 0), ['a', 'b']);
  assert.deepEqual(newlyRevealedAt(s, 1), ['c']);
  assert.deepEqual(newlyRevealedAt(s, 2), []);
  assert.deepEqual(newlyRevealedAt(s, 3), ['d'], "'a' was already showing");
});

test('a scene that declares no reveals shows everything from beat 0', () => {
  const still = stillScene('sc_still');
  assert.equal(sceneRevealsNothing(still), true);
  assert.deepEqual(visibilityOf(still, 0, 'anything'), { visible: true, entering: true });
  assert.equal(beatFrame(still, 0).revealsEverything, true);
  assert.equal(beatFrame(still, 0).revealed, null);
});

test('the scroll target is derived from the beat, never remembered (D12)', () => {
  const s = staged();
  assert.equal(scrollTargetFor(s, 0), 'a');
  assert.equal(scrollTargetFor(s, 1), 'c');
  assert.equal(scrollTargetFor(s, 2), 'c', 'a pause beat leaves the frame where it was');
  assert.equal(scrollTargetFor(s, 3), 'd');
  // Same beat, same answer, whatever route got there.
  assert.equal(scrollTargetFor(s, 1), scrollTargetFor(staged(), 1));
});

test('the beat frame carries exactly what the host and the sweep need', () => {
  const f = beatFrame(staged(), 1);
  assert.equal(f.sceneId, 'sc_x');
  assert.equal(f.beatIndex, 1);
  assert.equal(f.beatCount, 4);
  assert.deepEqual([...f.revealed].sort(), ['a', 'b', 'c']);
  assert.deepEqual(f.entering, ['c']);
  assert.equal(f.scrollTarget, 'c');
  assert.equal(f.presenterNote, null);
  assert.equal(beatFrame(staged(), 0).presenterNote, 'Open here.');
});

test('the beat signature is stable and distinguishes every beat', () => {
  const s = staged();
  const sigs = [0, 1, 2, 3].map((i) => beatSignature(s, i));
  assert.equal(new Set(sigs).size, 4);
  assert.deepEqual(sigs, [0, 1, 2, 3].map((i) => beatSignature(staged(), i)));
});

test('applyBeat marks the tree without changing its shape', () => {
  const tree = h('div', null,
    h('p', { [REVEAL_ATTR]: 'a', class: 'x' }, 'A'),
    h('p', { [REVEAL_ATTR]: 'c' }, 'C'),
    h('p', null, 'always'));
  const marked = applyBeat(tree, beatFrame(staged(), 0));
  const els = collectByAttr(marked, REVEAL_ATTR);
  assert.equal(els.length, 2);
  assert.match(els[0].a.class, /\bx\b/);
  assert.match(els[0].a.class, /pp-revealed/);
  assert.match(els[0].a.class, /pp-entering/);
  assert.match(els[1].a.class, /pp-unrevealed/);
  assert.equal(els[1].a['aria-hidden'], 'true');
  assert.equal(els[0].a['aria-hidden'], null);
  assert.ok(toHtml(marked).includes('always'), 'elements without a reveal id are untouched');
});

test('applyBeat leaves a reveal-free scene entirely visible', () => {
  const tree = h('div', null, h('p', { [REVEAL_ATTR]: 'a' }, 'A'));
  const marked = applyBeat(tree, beatFrame(stillScene('sc_s'), 0));
  assert.equal(toHtml(marked), toHtml(tree));
});

test('the motion budget caps every transition at 240ms and reduced motion zeroes it', () => {
  assert.equal(MAX_TRANSITION_MS, 240);
  assert.equal(transitionMs(1000, false), 240);
  assert.equal(transitionMs(120, false), 120);
  assert.equal(transitionMs(120, true), 0);
  assert.equal(transitionMs(-5, false), 0);
  assert.equal(transitionMs(Number.NaN, false), 0);
  assert.equal(EXIT_TRANSITION_MS, 0, 'un-revealing must be instant, or a fast back leaves a ghost');
});

test('dwellHintMs is a label, never a timer (§10)', () => {
  assert.equal(dwellHintLabel({ dwellHintMs: 15000 }), '15s');
  assert.equal(dwellHintLabel({ dwellHintMs: 1450 }), '1.5s');
  assert.equal(dwellHintLabel({ dwellHintMs: null }), null);
  assert.equal(dwellHintLabel(null), null);

  // Nothing in the runtime may schedule a deck advance.
  const src = ['beats.js', 'nav.js', 'runtime.js', 'host.js', 'deck.js', 'keymap.js', 'overlays.js', 'layouts.js'];
  return Promise.all(src.map(async (name) => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(new URL(`../../src/runtime/${name}`, import.meta.url), 'utf8');
    assert.ok(!/setTimeout\s*\([^)]*nextBeat/.test(text), `${name} schedules an advance`);
    assert.ok(!/setInterval/.test(text), `${name} runs a timer`);
  }));
});

test('every beat of every scene is reversible through the runtime (§17.9)', () => {
  const proof = makeProof();
  const deck = buildDeck(proof);
  for (const pos of allPositions(deck)) {
    const runtime = new Runtime(proof);
    runtime.nav = navigate(deck, initialState(deck), { type: 'goToBeat', sceneId: pos.sceneId, beatIndex: pos.beatIndex });
    const before = runtime.hash();
    const beforeHtml = toHtml(runtime.render());
    if (!runtime.run('nextBeat')) continue;
    runtime.run('prevBeat');
    assert.equal(runtime.hash(), before, `hash diverged at ${pos.sceneId}:${pos.beatIndex}`);
    assert.equal(toHtml(runtime.render()), beforeHtml, `rendered output diverged at ${pos.sceneId}:${pos.beatIndex}`);
  }
});
