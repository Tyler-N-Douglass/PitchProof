/**
 * The declared lane surface, and the §11 acceptance path end to end.
 *
 * `API.md` Part 3 binds `src/branch/index.js` to six exports. A lane may add to
 * that list but may not change or omit an entry, so the list is asserted rather
 * than trusted — integration breaks silently otherwise.
 *
 * The second half walks the §11 sentence with real keystrokes through the
 * runtime, the keymap, the overlay stack and the input bridge: `/`, three
 * characters, Enter, `r`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as branchLane from '../../src/branch/index.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { SPINE } from '../../src/runtime/deck.js';
import { isTextEntry } from '../../src/runtime/host.js';
import { OVERLAY } from '../../src/runtime/overlays.js';
import { objectionProof } from '../fixtures/branch/objections.mjs';

/** name → required arity (`Function.length` stops at the first optional parameter). */
const DECLARED = {
  buildJumpIndex: 1,      // (deck)
  searchJump: 2,          // (index, query, {limit?})
  registerBranchOverlays: 1, // (runtime)
  returnTargetFor: 2,     // (deck, branchId)
  branchCoverage: 1,      // (deck)
  randomWalk: 1,          // (deck, {seed, steps})
};

test('src/branch/index.js exports exactly what API.md declares', () => {
  for (const [name, arity] of Object.entries(DECLARED)) {
    assert.equal(typeof branchLane[name], 'function', `${name} is missing from the lane surface`);
    assert.equal(branchLane[name].length, arity, `${name} takes a different number of arguments than declared`);
  }
});

test('the declared surface behaves as declared, on a real proof', () => {
  const runtime = new Runtime(objectionProof(), { mode: 'presenter' });
  const deck = runtime.deck;

  const index = branchLane.buildJumpIndex(deck);
  assert.equal(index.entries.length, 6);

  const [top] = branchLane.searchJump(index, 'app', { limit: 3 });
  assert.deepEqual(Object.keys(top).sort().includes('branchId'), true);
  for (const key of ['branchId', 'objection', 'score', 'matched']) {
    assert.ok(key in top, `searchJump result is missing the declared key ${key}`);
  }

  assert.deepEqual(branchLane.returnTargetFor(deck, 'bn_approvals'), { sequenceId: SPINE, sceneIndex: 1 });

  const coverage = branchLane.branchCoverage(deck);
  assert.ok(Array.isArray(coverage.unreachable) && Array.isArray(coverage.noReturn));

  const states = branchLane.randomWalk(deck, { seed: 'surface', steps: 25 });
  assert.equal(states.length, 26, 'the opening state plus one per step');
  assert.equal(states[0].sequenceId, SPINE);

  const unregister = branchLane.registerBranchOverlays(runtime);
  assert.equal(typeof unregister, 'function');
  unregister();
});

test('§11 end to end: slash, three characters, Enter, then `r`', () => {
  const runtime = new Runtime(objectionProof(), { mode: 'presenter' });
  const unregister = branchLane.registerBranchOverlays(runtime);

  /** A document stub with the capture/bubble ordering the real one has. */
  const listeners = [];
  const doc = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: !!capture }),
    removeEventListener: (type, fn, capture) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatch(event) {
      let stopped = false;
      const e = { ...event, preventDefault() {}, stopPropagation() { stopped = true; } };
      for (const phase of [true, false]) {
        for (const l of listeners.slice()) {
          if (l.type !== e.type || l.capture !== phase || (stopped && !phase)) continue;
          l.fn(e);
        }
      }
    },
  };
  const detach = branchLane.installBranchInputBridge(runtime, { document: doc });
  // The host's keydown handler, bound the way `host.js` binds it.
  doc.addEventListener('keydown', (event) => {
    runtime.handleKey(event, { typing: isTextEntry(event.target), activeElement: event.target });
  }, false);

  // The room raises the objection three scenes in.
  runtime.run('goToScene', 'sc_spine_2');
  assert.equal(runtime.nav.sceneIndex, 2);

  // `/` — the presenter does not look down.
  doc.dispatch({ type: 'keydown', key: '/', target: { tagName: 'BODY', hasAttribute: () => false, closest: () => null } });
  assert.equal(runtime.overlays.top, OVERLAY.jump);

  // Three characters, typed into the field the overlay rendered.
  const field = (value) => ({
    tagName: 'INPUT', value,
    hasAttribute: (n) => n === branchLane.JUMP_INPUT_ATTR,
    getAttribute: () => 'text',
    closest: () => null,
  });
  for (const value of ['a', 'ap', 'app']) doc.dispatch({ type: 'input', target: field(value) });
  assert.equal(runtime.branchJump.active.branchId, 'bn_approvals', 'three characters must select the approvals branch');
  assert.equal(runtime.nav.sceneIndex, 2, 'and the deck must not have moved while typing');

  // Enter.
  doc.dispatch({ type: 'keydown', key: 'Enter', target: field('app') });
  assert.equal(runtime.nav.sequenceId, 'bn_approvals');
  assert.equal(runtime.nav.sceneIndex, 0);
  assert.equal(runtime.nav.beatIndex, 0);
  assert.equal(runtime.overlays.isOpen, false, 'the overlay is gone before the room looks up');
  assert.equal(runtime.offSpine, true);

  // Work through the branch, then `r`.
  runtime.run('nextBeat');
  runtime.run('nextBeat');
  doc.dispatch({ type: 'keydown', key: 'r', target: { tagName: 'BODY', hasAttribute: () => false, closest: () => null } });
  assert.equal(runtime.nav.sequenceId, SPINE);
  assert.equal(runtime.nav.sceneIndex, 2, 'back exactly where the objection was raised');
  assert.deepEqual(runtime.nav.stack, []);

  detach();
  unregister();
});
