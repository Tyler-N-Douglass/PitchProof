/**
 * The navigation reducer and the return stack (§11, §22.4).
 *
 * §22.4: "nested branch jumps that don't unwind correctly strand the presenter
 * mid-pitch." These are the unit cases; L9 lands the seeded-random-walk property
 * test on top of the same reducer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck, SPINE, allBranches, branchesFrom, beatCount } from '../../src/runtime/deck.js';
import {
  initialState, navigate, currentScene, stateHash, offSpine, allPositions,
  NavInvariantError, checkInvariants, beatsOf,
} from '../../src/runtime/nav.js';
import { makeProof, minimalProof, scene, branch } from '../fixtures/make-proof.mjs';

const proof = makeProof();
const deck = buildDeck(proof);

/** @param {...import('../../src/runtime/nav.js').NavAction} actions */
function walk(...actions) {
  let s = initialState(deck);
  for (const a of actions) s = navigate(deck, s, a);
  return s;
}

const next = { type: 'nextBeat' };
const prev = { type: 'prevBeat' };

test('a deck opens on the first beat of the first spine scene', () => {
  const s = initialState(deck);
  assert.equal(s.sequenceId, SPINE);
  assert.equal(s.sceneIndex, 0);
  assert.equal(s.beatIndex, 0);
  assert.deepEqual(s.stack, []);
  assert.deepEqual(s.visited, ['sc_spine_0']);
});

test('beats advance within a scene, then roll into the next scene', () => {
  let s = initialState(deck);
  assert.equal(beatsOf(deck.spine.scenes[0]), 3);
  s = navigate(deck, s, next); assert.equal(s.beatIndex, 1);
  s = navigate(deck, s, next); assert.equal(s.beatIndex, 2);
  s = navigate(deck, s, next);
  assert.equal(s.sceneIndex, 1);
  assert.equal(s.beatIndex, 0);
});

test('stepping back off the front of a scene lands on the previous scene last beat', () => {
  let s = walk(next, next, next);
  assert.equal(s.sceneIndex, 1);
  s = navigate(deck, s, prev);
  assert.equal(s.sceneIndex, 0);
  assert.equal(s.beatIndex, 2, 'back must land on the last beat of the previous scene');
});

test('the deck holds at both ends rather than wrapping', () => {
  const start = initialState(deck);
  assert.equal(navigate(deck, start, prev).sceneIndex, 0);
  assert.equal(navigate(deck, start, prev).beatIndex, 0);

  let s = navigate(deck, start, { type: 'lastScene' });
  const atEnd = { ...s };
  s = navigate(deck, s, next);
  assert.equal(s.sceneIndex, atEnd.sceneIndex);
  assert.equal(s.beatIndex, atEnd.beatIndex, 'a proof that wraps in front of a client reads as a bug');
});

test('a jump pushes exactly one frame and lands on the branch first beat', () => {
  const s = walk(next, next, next, { type: 'jump', branchId: 'bn_approvals' });
  assert.equal(s.sequenceId, 'bn_approvals');
  assert.equal(s.sceneIndex, 0);
  assert.equal(s.beatIndex, 0);
  assert.equal(s.stack.length, 1);
  assert.deepEqual(s.stack[0], {
    sequenceId: SPINE, sceneIndex: 1, beatIndex: 0, returnPolicy: 'anchor', branchId: 'bn_approvals',
  });
  assert.equal(offSpine(s), true);
});

test('jumping into the branch you are already in is a no-op, not a second frame', () => {
  const s = walk({ type: 'jump', branchId: 'bn_approvals' });
  const again = navigate(deck, s, { type: 'jump', branchId: 'bn_approvals' });
  assert.equal(again.stack.length, 1);
  assert.equal(again.sceneIndex, s.sceneIndex);
});

test("returnPolicy 'anchor' restores the exact position the jump left", () => {
  const before = walk(next, next, next, next);      // spine scene 1, beat 1
  assert.deepEqual([before.sequenceId, before.sceneIndex, before.beatIndex], [SPINE, 1, 1]);
  const jumped = navigate(deck, before, { type: 'jump', branchId: 'bn_approvals' });
  const back = navigate(deck, jumped, { type: 'return' });
  assert.equal(back.sequenceId, SPINE);
  assert.equal(back.sceneIndex, 1);
  assert.equal(back.beatIndex, 1);
  assert.deepEqual(back.stack, []);
});

test("returnPolicy 'nextSpineScene' advances past the anchor", () => {
  const before = walk(next, next, next, next, next, next, next, next, next);
  assert.equal(before.sequenceId, SPINE);
  const anchorIndex = before.sceneIndex;
  const jumped = navigate(deck, before, { type: 'jump', branchId: 'bn_scale' });
  const back = navigate(deck, jumped, { type: 'return' });
  assert.equal(back.sequenceId, SPINE);
  assert.equal(back.sceneIndex, Math.min(deck.spine.scenes.length - 1, anchorIndex + 1));
  assert.equal(back.beatIndex, 0);
  assert.deepEqual(back.stack, []);
});

test('running off the end of a branch returns automatically', () => {
  let s = walk({ type: 'jump', branchId: 'bn_approvals' });
  const branchSeq = deck.sequences.get('bn_approvals');
  const total = branchSeq.scenes.reduce((n, sc) => n + beatsOf(sc), 0);
  for (let i = 0; i < total; i++) s = navigate(deck, s, next);
  assert.equal(s.sequenceId, SPINE, 'a branch always exits — it never dead-ends');
  assert.deepEqual(s.stack, []);
});

test('stepping back off the front of a branch returns to the jump point exactly', () => {
  const before = walk(next, next, next);
  const jumped = navigate(deck, before, { type: 'jump', branchId: 'bn_approvals' });
  const back = navigate(deck, jumped, prev);
  assert.equal(back.sequenceId, before.sequenceId);
  assert.equal(back.sceneIndex, before.sceneIndex);
  assert.equal(back.beatIndex, before.beatIndex);
  assert.deepEqual(back.stack, []);
});

test('nested jumps unwind one frame at a time', () => {
  let s = walk(next, next, next, { type: 'jump', branchId: 'bn_approvals' });
  s = navigate(deck, s, { type: 'nextScene' });                    // approvals scene 1
  s = navigate(deck, s, { type: 'jump', branchId: 'bn_legal' });
  assert.equal(s.stack.length, 2);
  assert.equal(s.sequenceId, 'bn_legal');

  s = navigate(deck, s, { type: 'return' });
  assert.equal(s.sequenceId, 'bn_approvals');
  assert.equal(s.sceneIndex, 1);
  assert.equal(s.stack.length, 1);

  s = navigate(deck, s, { type: 'return' });
  assert.equal(s.sequenceId, SPINE);
  assert.deepEqual(s.stack, []);
});

test('returnToSpine unwinds the whole stack in one step', () => {
  let s = walk(next, next, next, { type: 'jump', branchId: 'bn_approvals' });
  s = navigate(deck, s, { type: 'nextScene' });
  s = navigate(deck, s, { type: 'jump', branchId: 'bn_legal' });
  assert.equal(s.stack.length, 2);

  const home = navigate(deck, s, { type: 'returnToSpine' });
  assert.equal(home.sequenceId, SPINE);
  assert.deepEqual(home.stack, []);
  assert.equal(home.sceneIndex, 1, 'it lands where the first jump left the spine');
  assert.equal(home.beatIndex, 0);
});

test('return and returnToSpine on the spine are no-ops', () => {
  const s = initialState(deck);
  assert.deepEqual(navigate(deck, s, { type: 'return' }), s);
  assert.deepEqual(navigate(deck, s, { type: 'returnToSpine' }), s);
});

test('goToScene inside the spine clears the stack; into a branch it pushes a frame', () => {
  let s = walk(next, next, next, { type: 'jump', branchId: 'bn_approvals' });
  const toSpine = navigate(deck, s, { type: 'goToScene', sceneId: 'sc_spine_4' });
  assert.equal(toSpine.sequenceId, SPINE);
  assert.equal(toSpine.sceneIndex, 4);
  assert.deepEqual(toSpine.stack, []);

  const toBranch = navigate(deck, initialState(deck), { type: 'goToScene', sceneId: 'sc_scale_1' });
  assert.equal(toBranch.sequenceId, 'bn_scale');
  assert.equal(toBranch.sceneIndex, 1);
  assert.equal(toBranch.stack.length, 1, 'landing in a branch must stay returnable');
});

test('goToBeat clamps to the scene it lands in', () => {
  const s = navigate(deck, initialState(deck), { type: 'goToBeat', sceneId: 'sc_spine_2', beatIndex: 99 });
  assert.equal(s.sceneIndex, 2);
  assert.equal(s.beatIndex, 0, 'sc_spine_2 has one beat');
});

test('Home and End reset to the spine from anywhere', () => {
  let s = walk(next, next, next, { type: 'jump', branchId: 'bn_approvals' });
  const home = navigate(deck, s, { type: 'firstScene' });
  assert.deepEqual([home.sequenceId, home.sceneIndex, home.beatIndex, home.stack.length], [SPINE, 0, 0, 0]);

  const end = navigate(deck, s, { type: 'lastScene' });
  assert.equal(end.sequenceId, SPINE);
  assert.equal(end.sceneIndex, deck.spine.scenes.length - 1);
  assert.equal(end.beatIndex, beatsOf(deck.spine.scenes[deck.spine.scenes.length - 1]) - 1);
  assert.deepEqual(end.stack, []);
});

test('jumping to an unknown or empty branch changes nothing', () => {
  const s = initialState(deck);
  assert.deepEqual(navigate(deck, s, { type: 'jump', branchId: 'bn_nope' }), s);

  const empty = {
    ...proof,
    branches: [...proof.branches, branch('bn_empty', 'Nothing here', [])],
  };
  const emptyDeck = buildDeck(empty);
  const e0 = initialState(emptyDeck);
  assert.deepEqual(navigate(emptyDeck, e0, { type: 'jump', branchId: 'bn_empty' }), e0);
});

test('the invariants reject every impossible state', () => {
  const bad = [
    { ...initialState(deck), sequenceId: 'bn_approvals', stack: [] },
    { ...initialState(deck), sceneIndex: 99 },
    { ...initialState(deck), beatIndex: 99 },
    { ...initialState(deck), sequenceId: 'nope' },
    { ...initialState(deck), stack: [{ sequenceId: 'ghost', sceneIndex: 0, beatIndex: 0, returnPolicy: 'anchor', branchId: 'ghost' }], sequenceId: 'bn_approvals' },
  ];
  for (const s of bad) {
    assert.throws(() => checkInvariants(deck, s, 'test'), NavInvariantError, JSON.stringify(s.sequenceId));
  }
});

test('visited accumulates in first-seen order and never repeats', () => {
  let s = walk(next, next, next, next, next, next);
  s = navigate(deck, s, { type: 'firstScene' });
  s = navigate(deck, s, next);
  assert.deepEqual(s.visited, [...new Set(s.visited)]);
  assert.equal(s.visited[0], 'sc_spine_0');
});

test('the state hash changes with position and is stable for the same position', () => {
  const a = initialState(deck);
  const b = navigate(deck, a, next);
  assert.notEqual(stateHash(deck, a), stateHash(deck, b));
  assert.equal(stateHash(deck, a), stateHash(deck, initialState(deck)));
  assert.notEqual(stateHash(deck, a), stateHash(deck, a, { blanked: true }));
  assert.notEqual(stateHash(deck, a), stateHash(deck, a, { overlay: 'map' }));
});

test('forward-then-back restores the exact hash from every position (§17.9)', () => {
  for (const pos of allPositions(deck)) {
    let s = navigate(deck, initialState(deck), { type: 'goToBeat', sceneId: pos.sceneId, beatIndex: pos.beatIndex });
    if (s.sceneId === null) continue;
    const before = stateHash(deck, s);
    const forward = navigate(deck, s, next);
    if (stateHash(deck, forward) === before) continue;   // already at the end
    const back = navigate(deck, forward, prev);
    assert.equal(stateHash(deck, back), before,
      `forward-then-back diverged at ${pos.sceneId} beat ${pos.beatIndex}`);
  }
});

test('a one-scene proof navigates without incident', () => {
  const solo = buildDeck(minimalProof());
  let s = initialState(solo);
  for (const action of [next, next, prev, prev, { type: 'return' }, { type: 'returnToSpine' }, { type: 'lastScene' }, { type: 'firstScene' }]) {
    s = navigate(solo, s, action);
  }
  assert.equal(s.sequenceId, SPINE);
  assert.equal(s.sceneIndex, 0);
  assert.equal(s.beatIndex, 0);
});

test('an empty spine does not throw', () => {
  const emptyDeck = buildDeck({ ...proof, spine: [], branches: [] });
  let s = initialState(emptyDeck);
  for (const action of [next, prev, { type: 'nextScene' }, { type: 'lastScene' }, { type: 'firstScene' }]) {
    s = navigate(emptyDeck, s, action);
  }
  assert.equal(s.sceneIndex, 0);
  assert.equal(currentScene(emptyDeck, s), null);
});

test('the deck indexes scenes, anchors and branch order', () => {
  assert.equal(deck.sceneLocator.get('sc_legal_0').sequenceId, 'bn_legal');
  assert.deepEqual(branchesFrom(deck, 'sc_spine_1').map((b) => b.id), ['bn_approvals']);
  assert.deepEqual(allBranches(deck).map((b) => b.id), ['bn_approvals', 'bn_scale', 'bn_legal']);
  assert.equal(beatCount(deck.spine), 3 + 3 + 1 + 3 + 3);
});

test('the deck fingerprint tracks structure, not content', () => {
  const same = buildDeck(makeProof());
  assert.equal(deck.fingerprint, same.fingerprint);
  const retitled = makeProof();
  retitled.spine[0].headline = 'A different headline entirely';
  assert.equal(buildDeck(retitled).fingerprint, deck.fingerprint, 'copy edits must not invalidate navigation state');
  const restructured = makeProof();
  restructured.spine.push(scene('sc_extra', 2));
  assert.notEqual(buildDeck(restructured).fingerprint, deck.fingerprint);
});

test('the automatic exit at the end of a branch is reversible; an explicit return is not', () => {
  const seq = deck.sequences.get('bn_approvals');
  const lastScene = seq.scenes[seq.scenes.length - 1];
  let s = navigate(deck, initialState(deck), { type: 'goToBeat', sceneId: lastScene.id, beatIndex: beatsOf(lastScene) - 1 });
  assert.equal(s.sequenceId, 'bn_approvals');
  const inBranch = stateHash(deck, s);

  const exited = navigate(deck, s, next);
  assert.equal(exited.sequenceId, SPINE);
  assert.ok(exited.exitedFrom, 'the automatic exit records how to step back into the branch');

  const backIn = navigate(deck, exited, prev);
  assert.equal(stateHash(deck, backIn), inBranch, 'one forward keypress must not strand the branch behind the presenter');
  assert.equal(backIn.stack.length, 1);
  assert.equal(backIn.exitedFrom, null);

  // An explicit return is a decision, not an accident, so back walks the spine.
  const deliberate = navigate(deck, s, { type: 'returnToSpine' });
  assert.equal(deliberate.exitedFrom, null);
  assert.equal(navigate(deck, deliberate, prev).sequenceId, SPINE);
});

test('the exit marker is cleared by any other transition', () => {
  const seq = deck.sequences.get('bn_approvals');
  const lastScene = seq.scenes[seq.scenes.length - 1];
  let s = navigate(deck, initialState(deck), { type: 'goToBeat', sceneId: lastScene.id, beatIndex: beatsOf(lastScene) - 1 });
  const exited = navigate(deck, s, next);
  assert.ok(exited.exitedFrom);
  for (const action of [next, { type: 'nextScene' }, { type: 'firstScene' }, { type: 'goToScene', sceneId: 'sc_spine_0' }]) {
    assert.equal(navigate(deck, exited, action).exitedFrom, null, action.type);
  }
});

test('a nextSpineScene exit from a nested branch is reversible, and the stack floor stays the spine', () => {
  // Found by L9's return-stack property test: `exitedFrom` used to record only
  // the top frame, which is right for `anchor` (one pop) and wrong for
  // `nextSpineScene` (which unwinds everything). Stepping back then restored a
  // stack floored on a branch, and the next return threw — the presenter
  // presses back, then `r`, and the deck stops responding. §22.4 exactly.
  const nested = makeProof();
  nested.branches = [
    branch('bn_outer', 'Outer objection', [scene('sc_o0', 1, { branchAnchors: ['bn_inner'] })], 'anchor'),
    branch('bn_inner', 'Inner objection', [scene('sc_i0', 1)], 'nextSpineScene'),
  ];
  nested.spine[1].branchAnchors = ['bn_outer'];
  const d = buildDeck(nested);

  let s = navigate(d, initialState(d), { type: 'goToScene', sceneId: 'sc_spine_1' });
  s = navigate(d, s, { type: 'jump', branchId: 'bn_outer' });
  s = navigate(d, s, { type: 'jump', branchId: 'bn_inner' });
  assert.equal(s.stack.length, 2);
  const insideInner = stateHash(d, s);

  s = navigate(d, s, next);                       // off the end of the inner branch
  assert.equal(s.sequenceId, SPINE);
  assert.deepEqual(s.stack, []);
  assert.ok(s.exitedFrom, 'the automatic exit is recorded');

  s = navigate(d, s, prev);                       // and is reversible
  assert.equal(stateHash(d, s), insideInner, 'back must restore the exact prior state');
  assert.equal(s.stack.length, 2, 'the whole unwound stack comes back, not just the top frame');
  assert.equal(s.stack[0].sequenceId, SPINE, 'the floor is the spine');

  s = navigate(d, s, { type: 'returnToSpine' });   // and does not throw afterwards
  assert.equal(s.sequenceId, SPINE);
  assert.deepEqual(s.stack, []);
});

test('a stack floored on a branch is rejected as the impossible state it is', () => {
  const bad = {
    ...initialState(deck),
    sequenceId: 'bn_legal',
    stack: [
      { sequenceId: 'bn_approvals', sceneIndex: 0, beatIndex: 0, returnPolicy: 'anchor', branchId: 'bn_legal' },
    ],
  };
  assert.throws(() => checkInvariants(deck, bad, 'test'), /floored on bn_approvals, not the spine/);
});
