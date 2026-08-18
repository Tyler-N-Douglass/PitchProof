/**
 * Nested jump and return, as explicit cases (§11, §22.4).
 *
 * The property test proves the return stack over 200,000 random transitions.
 * These are the specific sequences a presenter actually performs, written out
 * so a regression names the behaviour it broke rather than a seed:
 *
 *   - jump, jump, return, return unwinds one level at a time;
 *   - `r` unwinds the whole detour in one keystroke, from any depth;
 *   - a mistaken jump is undone exactly by stepping back;
 *   - `nextSpineScene` from inside a nested branch moves the *pitch* on, not
 *     the detour;
 *   - jumping to the branch you are already in does not deepen the stack;
 *   - the jump index reaches a branch from anywhere, and the return still lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck, SPINE, branchesFrom } from '../../src/runtime/deck.js';
import { initialState, navigate, offSpine, currentScene } from '../../src/runtime/nav.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { registerBranchOverlays } from '../../src/branch/overlays.js';
import { branch, scene, brand } from '../fixtures/make-proof.mjs';
import { defaultEmitOptions } from '../../src/core/contracts.js';
import { contentId } from '../../src/core/ids.js';
import { objectionProof } from '../fixtures/branch/objections.mjs';

/**
 * A three-level deck: spine → outer → middle → inner, with a `nextSpineScene`
 * branch hanging off the spine as well.
 */
function nestedProof() {
  const spine = [scene('sc_n0', 2), scene('sc_n1', 2), scene('sc_n2', 2), scene('sc_n3', 2)];
  const inner = branch('bn_inner', 'The third objection', [scene('sc_i0', 2)], 'anchor', ['third']);
  const middle = branch('bn_middle', 'The second objection',
    [scene('sc_m0', 2, { branchAnchors: ['bn_inner'] })], 'anchor', ['second']);
  const outer = branch('bn_outer', 'The first objection',
    [scene('sc_o0', 2), scene('sc_o1', 2, { branchAnchors: ['bn_middle'] })], 'anchor', ['first']);
  const onward = branch('bn_onward', 'Move the pitch on', [scene('sc_w0', 2)], 'nextSpineScene', ['onward']);
  spine[1].branchAnchors = ['bn_outer'];
  spine[2].branchAnchors = ['bn_onward'];

  return {
    schemaVersion: 1,
    id: contentId('proof', 'nested'),
    prospectName: 'Nested',
    createdAt: '2026-02-01T09:00:00.000Z',
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches: [outer, middle, inner, onward],
    emitOptions: defaultEmitOptions(),
  };
}

const deck = buildDeck(nestedProof());

/** @param {...import('../../src/runtime/nav.js').NavAction} actions */
function walk(...actions) {
  let state = initialState(deck);
  for (const action of actions) state = navigate(deck, state, action);
  return state;
}

const at = (id, beat = 0) => ({ type: 'goToBeat', sceneId: id, beatIndex: beat });
const jump = (branchId) => ({ type: 'jump', branchId });

test('three nested jumps stack three frames, and each return pops exactly one', () => {
  let state = walk(at('sc_n1'), jump('bn_outer'), at('sc_o1', 1), jump('bn_middle'), jump('bn_inner'));
  assert.equal(state.sequenceId, 'bn_inner');
  assert.deepEqual(state.stack.map((f) => f.sequenceId), [SPINE, 'bn_outer', 'bn_middle']);
  assert.equal(offSpine(state), true);

  state = navigate(deck, state, { type: 'return' });
  assert.equal(state.sequenceId, 'bn_middle');
  assert.equal(state.stack.length, 2);

  state = navigate(deck, state, { type: 'return' });
  assert.equal(state.sequenceId, 'bn_outer');
  assert.equal(state.sceneIndex, 1);
  assert.equal(state.beatIndex, 1, 'the return restores the exact beat the jump left');
  assert.equal(state.stack.length, 1);

  state = navigate(deck, state, { type: 'return' });
  assert.equal(state.sequenceId, SPINE);
  assert.equal(state.sceneIndex, 1);
  assert.deepEqual(state.stack, []);
  assert.equal(offSpine(state), false);
});

test('`r` unwinds the whole detour in one keystroke, from any depth', () => {
  const deep = walk(at('sc_n1', 1), jump('bn_outer'), at('sc_o1'), jump('bn_middle'), jump('bn_inner'));
  assert.equal(deep.stack.length, 3);

  const home = navigate(deck, deep, { type: 'returnToSpine' });
  assert.equal(home.sequenceId, SPINE);
  assert.equal(home.sceneIndex, 1);
  assert.equal(home.beatIndex, 1, 'it lands on the beat the first jump left, not the top of the scene');
  assert.deepEqual(home.stack, []);

  assert.equal(navigate(deck, home, { type: 'returnToSpine' }), home, 'on the spine, `r` is a no-op');
});

test('a mistaken jump costs nothing: stepping back off the front of a branch undoes it', () => {
  const before = walk(at('sc_n1', 1));
  const jumped = navigate(deck, before, jump('bn_outer'));
  assert.equal(jumped.sequenceId, 'bn_outer');

  const back = navigate(deck, jumped, { type: 'prevScene' });
  assert.equal(back.sequenceId, SPINE);
  assert.equal(back.sceneIndex, before.sceneIndex);
  assert.equal(back.beatIndex, before.beatIndex);
  assert.deepEqual(back.stack, []);
});

test('nextSpineScene moves the pitch on rather than back to the anchor', () => {
  const inBranch = walk(at('sc_n2', 1), jump('bn_onward'));
  assert.equal(inBranch.sequenceId, 'bn_onward');
  const out = navigate(deck, inBranch, { type: 'return' });
  assert.equal(out.sequenceId, SPINE);
  assert.equal(out.sceneIndex, 3, 'the scene after the anchor, not the anchor itself');
  assert.deepEqual(out.stack, []);
});

test('jumping into the branch you are already in does not deepen the stack', () => {
  const inBranch = walk(at('sc_n1'), jump('bn_outer'));
  const again = navigate(deck, inBranch, jump('bn_outer'));
  assert.equal(again.stack.length, 1, 'a double keypress must not stack a second frame');
  assert.equal(again.sequenceId, 'bn_outer');
});

test('the jump index reaches a branch from anywhere, and the return still lands', () => {
  // No anchor for bn_inner exists on the spine; the presenter finds it with `/`.
  const fromSpine = walk(at('sc_n3', 1), jump('bn_inner'));
  assert.equal(fromSpine.sequenceId, 'bn_inner');
  assert.deepEqual(fromSpine.stack.map((f) => f.sequenceId), [SPINE]);

  const back = navigate(deck, fromSpine, { type: 'return' });
  assert.equal(back.sequenceId, SPINE);
  assert.equal(back.sceneIndex, 3);
  assert.equal(back.beatIndex, 1, 'it returns to where the jump was made from, not to a declared anchor');
});

test('advancing off the end of a branch returns, and stepping back re-enters it (D15)', () => {
  const seq = deck.sequences.get('bn_outer');
  const last = seq.scenes[seq.scenes.length - 1];
  const atEnd = walk(at('sc_n1', 1), jump('bn_outer'), at(last.id, 1));
  const exited = navigate(deck, atEnd, { type: 'nextBeat' });
  assert.equal(exited.sequenceId, SPINE);
  assert.equal(exited.sceneIndex, 1, 'the anchor policy returns to the anchor');
  assert.ok(exited.exitedFrom, 'the automatic exit is marked reversible');

  const reentered = navigate(deck, exited, { type: 'prevBeat' });
  assert.equal(reentered.sequenceId, 'bn_outer');
  assert.equal(reentered.sceneIndex, atEnd.sceneIndex);
  assert.equal(reentered.beatIndex, atEnd.beatIndex);
  assert.deepEqual(reentered.stack.map((f) => f.sequenceId), [SPINE]);
});

test('goToScene into a different branch is a jump, and into the spine is an exit', () => {
  const inMiddle = walk(at('sc_n1'), jump('bn_outer'), at('sc_o1'), jump('bn_middle'));
  const sideways = navigate(deck, inMiddle, { type: 'goToScene', sceneId: 'sc_i0' });
  assert.equal(sideways.sequenceId, 'bn_inner');
  assert.equal(sideways.stack.length, 3, 'landing in another branch stays returnable');

  const home = navigate(deck, sideways, { type: 'goToScene', sceneId: 'sc_n3' });
  assert.equal(home.sequenceId, SPINE);
  assert.deepEqual(home.stack, [], 'going to a spine scene unwinds the detour');
});

test('visited accumulates across a nested detour, in the order the room saw it', () => {
  const state = walk(at('sc_n1'), jump('bn_outer'), at('sc_o1'), jump('bn_middle'), jump('bn_inner'),
    { type: 'returnToSpine' });
  assert.deepEqual(state.visited, ['sc_n0', 'sc_n1', 'sc_o0', 'sc_o1', 'sc_m0', 'sc_i0']);
});

test('the runtime drives the same nesting through commands, with the overlays registered', () => {
  const runtime = new Runtime(objectionProof(), { mode: 'presenter' });
  const unregister = registerBranchOverlays(runtime);

  runtime.run('goToScene', 'sc_spine_1');
  assert.deepEqual(branchesFrom(runtime.deck, 'sc_spine_1').map((s) => s.id), ['bn_approvals']);

  runtime.run('jump', 'bn_approvals');
  assert.equal(runtime.nav.sequenceId, 'bn_approvals');
  assert.equal(runtime.offSpine, true);

  runtime.run('jump', 'bn_legal');
  assert.deepEqual(runtime.nav.stack.map((f) => f.sequenceId), [SPINE, 'bn_approvals']);
  assert.equal(currentScene(runtime.deck, runtime.nav).id, 'bn_legal_s0');

  runtime.run('returnToSpine');
  assert.equal(runtime.nav.sequenceId, SPINE);
  assert.equal(runtime.nav.sceneIndex, 1);
  assert.deepEqual(runtime.nav.stack, []);
  assert.equal(runtime.offSpine, false);

  unregister();
});
