/**
 * §17.8 — return-stack correctness, as a property.
 *
 * "Random walks of jumps and returns always terminate on the spine, never on an
 * orphan." §22.4 names this as one of the six things most likely to be wrong,
 * because a nested jump that does not unwind strands the presenter mid-pitch in
 * front of a client.
 *
 * So this is not three hand-written jump sequences. It is 1000 seeded walks of
 * 200 steps each over 1000 *generated* decks — varying spine length, beat
 * counts, branch count, nesting depth, return policies, branches anchored from
 * branch scenes, and branches anchored nowhere at all — plus 200 further walks
 * restricted to anchored jumps, where the stack depth has an exact upper bound
 * the deck's own structure supplies.
 *
 * Every step is checked. Every walk is then driven to completion the way a
 * presenter ends a meeting: `r` back to the spine, then forward to the end.
 *
 * A failure prints the seed and the step index; `generateBranchyProof(seed)`
 * plus `randomWalkTrace(deck, {seed, steps})` reproduces it exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck, SPINE } from '../../src/runtime/deck.js';
import { checkInvariants, beatsOf, initialState, navigate, NavInvariantError } from '../../src/runtime/nav.js';
import { randomWalkTrace, driveToSpineEnd, orphanReasons } from '../../src/branch/walk.js';
import { nestingDepths, branchCoverage } from '../../src/branch/graph.js';
import { generateBranchyProof } from '../fixtures/branch/generate-deck.mjs';

const WALKS = 1000;
const STEPS = 200;
const ANCHORED_WALKS = 200;

/**
 * Check one produced state against every invariant the machine promises.
 * @param {import('../../src/runtime/deck.js').Deck} deck
 * @param {import('../../src/runtime/nav.js').NavState} state
 * @param {string} where
 */
function assertSound(deck, state, where) {
  const reasons = orphanReasons(deck, state);
  assert.deepEqual(reasons, [], `${where}: orphan state — ${reasons.join('; ')}`);

  // Stated separately from `orphanReasons` so a regression names the law it
  // broke rather than a generic "orphan".
  assert.ok(state.stack.length >= 0, `${where}: negative stack depth`);
  assert.equal(
    state.stack.length === 0,
    state.sequenceId === SPINE,
    `${where}: the stack is empty iff the spine is active (depth ${state.stack.length}, sequence ${state.sequenceId})`,
  );

  const scene = deck.sequences.get(state.sequenceId).scenes[state.sceneIndex];
  assert.ok(scene, `${where}: position names no scene`);
  assert.ok(state.beatIndex >= 0 && state.beatIndex < beatsOf(scene), `${where}: position names no beat`);

  // The reducer's own invariant check must also pass on every produced state.
  checkInvariants(deck, state, where);
}

test('1000 seeded walks × 200 steps never strand the presenter', () => {
  let maxDepth = 0;
  let deepestSeed = null;
  let totalSteps = 0;
  const branchesVisited = new Set();
  const decksWithNesting = new Set();
  let jumpActions = 0;
  let returnActions = 0;
  let terminalChecked = 0;

  for (let w = 0; w < WALKS; w++) {
    const seed = `property/walk/${w}`;
    const { proof, shape } = generateBranchyProof(seed);
    const deck = buildDeck(proof);
    const depths = nestingDepths(deck);
    if (shape.nested > 0) decksWithNesting.add(seed);

    let trace;
    try {
      trace = randomWalkTrace(deck, { seed, steps: STEPS });
    } catch (error) {
      if (error instanceof NavInvariantError) {
        assert.fail(`seed ${seed}: the reducer threw during a legal walk — ${error.message}`);
      }
      throw error;
    }

    let jumpsSoFar = 0;
    for (let i = 0; i < trace.states.length; i++) {
      const state = trace.states[i];
      assertSound(deck, state, `seed ${seed} step ${i}`);
      if (i > 0) {
        const action = trace.actions[i - 1];
        if (action.type === 'jump' || action.type === 'goToScene') jumpsSoFar++;
        if (action.type === 'jump') jumpActions++;
        if (action.type === 'return' || action.type === 'returnToSpine') returnActions++;
        // A frame is only ever pushed by a jump, so the depth can never exceed
        // the number of jumps the walk has actually issued.
        assert.ok(
          state.stack.length <= jumpsSoFar,
          `seed ${seed} step ${i}: stack depth ${state.stack.length} exceeds ${jumpsSoFar} jumps issued`,
        );
        // Every frame names a sequence that exists, and the bottom frame is
        // always on the spine — that is what makes `r` a guaranteed exit.
        for (const frame of state.stack) {
          assert.ok(deck.sequences.has(frame.sequenceId), `seed ${seed} step ${i}: frame names a missing sequence`);
          assert.ok(depths.has(frame.branchId) || frame.branchId === SPINE,
            `seed ${seed} step ${i}: frame names a missing branch`);
        }
      }
      if (state.sequenceId !== SPINE) branchesVisited.add(`${seed}:${state.sequenceId}`);
      if (state.stack.length > maxDepth) { maxDepth = state.stack.length; deepestSeed = seed; }
    }
    totalSteps += STEPS;

    // Driven to completion, every walk ends on the spine, at the end of it,
    // with nothing left on the stack.
    const end = driveToSpineEnd(deck, trace.states[trace.states.length - 1]);
    assertSound(deck, end.state, `seed ${seed} terminal`);
    assert.equal(end.state.sequenceId, SPINE, `seed ${seed}: walk did not terminate on the spine`);
    assert.deepEqual(end.state.stack, [], `seed ${seed}: terminal state still carries a return stack`);
    assert.equal(end.state.sceneIndex, deck.spine.scenes.length - 1, `seed ${seed}: terminal scene is not the last spine scene`);
    assert.equal(
      end.state.beatIndex,
      beatsOf(deck.spine.scenes[deck.spine.scenes.length - 1]) - 1,
      `seed ${seed}: terminal beat is not the last beat`,
    );
    terminalChecked++;
  }

  assert.ok(maxDepth >= 3, `the corpus never nested deeply enough to be a test (max depth ${maxDepth})`);
  assert.ok(decksWithNesting.size > WALKS / 4, 'too few generated decks contained a branch anchored inside a branch');
  assert.ok(jumpActions > 1000, 'the walks barely jumped');
  assert.ok(returnActions > 1000, 'the walks barely returned');
  assert.equal(terminalChecked, WALKS);

  console.log([
    '',
    '  return-stack property test',
    `    walks:                 ${WALKS}`,
    `    steps per walk:        ${STEPS}`,
    `    reducer transitions:   ${totalSteps.toLocaleString('en-US')}`,
    `    decks generated:       ${WALKS} (${decksWithNesting.size} with a branch anchored inside a branch)`,
    `    jump actions:          ${jumpActions.toLocaleString('en-US')}`,
    `    return actions:        ${returnActions.toLocaleString('en-US')}`,
    `    max stack depth:       ${maxDepth} (seed ${deepestSeed})`,
    `    branch visits:         ${branchesVisited.size.toLocaleString('en-US')} distinct deck/branch pairs`,
    `    terminal states:       ${terminalChecked} — all on the last beat of the spine, stack empty`,
    '',
  ].join('\n'));
});

test('an anchored-only walk never nests deeper than the deck was authored to nest', () => {
  let checked = 0;
  let maxObserved = 0;
  let maxAvailable = 0;

  for (let w = 0; w < ANCHORED_WALKS; w++) {
    const seed = `property/anchored/${w}`;
    const { proof } = generateBranchyProof(seed);
    const deck = buildDeck(proof);
    const depths = nestingDepths(deck);
    const available = Math.max(0, ...depths.values());

    const trace = randomWalkTrace(deck, { seed, steps: STEPS, anchoredOnly: true });
    for (let i = 0; i < trace.states.length; i++) {
      const state = trace.states[i];
      assertSound(deck, state, `seed ${seed} step ${i}`);
      assert.ok(
        state.stack.length <= available,
        `seed ${seed} step ${i}: stack depth ${state.stack.length} exceeds the ${available} levels the deck offers`,
      );
      if (state.stack.length > maxObserved) maxObserved = state.stack.length;
    }
    maxAvailable = Math.max(maxAvailable, available);

    const end = driveToSpineEnd(deck, trace.states[trace.states.length - 1]);
    assert.equal(end.state.sequenceId, SPINE);
    assert.deepEqual(end.state.stack, []);
    checked++;
  }

  assert.equal(checked, ANCHORED_WALKS);
  assert.ok(maxObserved >= 2, `anchored walks never nested (max depth ${maxObserved})`);
  console.log(`  anchored-only walks: ${ANCHORED_WALKS} × ${STEPS} steps · deepest stack ${maxObserved} of ${maxAvailable} available\n`);
});

test('a walk is reproducible from its seed alone', () => {
  const { proof } = generateBranchyProof('property/repeat');
  const deck = buildDeck(proof);
  const a = randomWalkTrace(deck, { seed: 'property/repeat', steps: 120 });
  const b = randomWalkTrace(deck, { seed: 'property/repeat', steps: 120 });
  assert.deepEqual(b.actions, a.actions, 'the same seed must draw the same actions');
  assert.deepEqual(b.states, a.states, 'the same seed must produce the same states');

  const c = randomWalkTrace(deck, { seed: 'property/repeat/other', steps: 120 });
  assert.notDeepEqual(c.actions, a.actions, 'a different seed must draw a different walk');
});

test('every generated deck agrees with its own coverage report', () => {
  for (let w = 0; w < 60; w++) {
    const seed = `property/coverage/${w}`;
    const { proof } = generateBranchyProof(seed);
    const deck = buildDeck(proof);
    const coverage = branchCoverage(deck);

    for (const detail of coverage.details) {
      // Unreachable means exactly what §11 says: no anchor and no jump entry.
      assert.equal(
        coverage.unreachable.includes(detail.branchId),
        !detail.anchored && !detail.searchable,
        `${seed}/${detail.branchId}: unreachable disagrees with anchors and jump entry`,
      );
      assert.equal(
        coverage.noReturn.includes(detail.branchId),
        detail.returnTarget === null,
        `${seed}/${detail.branchId}: noReturn disagrees with the resolved return target`,
      );
      if (detail.returnTarget) {
        const seq = deck.sequences.get(detail.returnTarget.sequenceId);
        assert.ok(seq, `${seed}/${detail.branchId}: return target names a missing sequence`);
        assert.ok(seq.scenes[detail.returnTarget.sceneIndex], `${seed}/${detail.branchId}: return target names a missing scene`);
      }
    }
  }
});

test('a jump followed by a return restores the exact prior state, at every depth', () => {
  for (let w = 0; w < 40; w++) {
    const seed = `property/roundtrip/${w}`;
    const { proof } = generateBranchyProof(seed);
    const deck = buildDeck(proof);
    const anchorPolicy = new Map(proof.branches.map((b) => [b.id, b.returnPolicy]));

    let state = initialState(deck);
    for (let step = 0; step < 60; step++) {
      state = navigate(deck, state, { type: 'nextBeat' });
      const scene = deck.sequences.get(state.sequenceId).scenes[state.sceneIndex];
      const offered = (deck.anchorsByScene.get(scene.id) || [])
        .filter((id) => anchorPolicy.get(id) === 'anchor' && deck.sequences.get(id).scenes.length > 0);
      for (const branchId of offered) {
        const jumped = navigate(deck, state, { type: 'jump', branchId });
        assert.equal(jumped.sequenceId, branchId);
        assert.equal(jumped.stack.length, state.stack.length + 1);
        const back = navigate(deck, jumped, { type: 'return' });
        assert.equal(back.sequenceId, state.sequenceId, `${seed}: return landed in the wrong sequence`);
        assert.equal(back.sceneIndex, state.sceneIndex, `${seed}: return landed on the wrong scene`);
        assert.equal(back.beatIndex, state.beatIndex, `${seed}: return landed on the wrong beat`);
        assert.deepEqual(back.stack, state.stack, `${seed}: return left the stack changed`);
      }
    }
  }
});
