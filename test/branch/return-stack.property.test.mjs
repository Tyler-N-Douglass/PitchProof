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
 *
 * ---------------------------------------------------------------------------
 * This test found a defect in the frozen reducer, and it is fixed.
 *
 * `src/runtime/nav.js` recorded `exitedFrom.frame` — a single frame — when the
 * presenter advanced off the end of a branch, and pushed that one frame back on
 * the way in. Under `returnPolicy: 'nextSpineScene'` the exit unwinds the
 * *whole* stack, so stepping back restored a stack missing every frame below
 * the top one, floored on a branch instead of the spine; the next `return`,
 * `prevScene` or `r` then threw `NavInvariantError` and stranded the presenter.
 * 342 of these 1000 walks reached it.
 *
 * Fixed in `ec1dd38`: `exitedFrom.stack` carries the whole stack and
 * `reenterExited` restores it wholesale, and `checkInvariants` now tests the
 * floor rather than assuming it. The walks below run unfenced, and the five
 * keystrokes that produced the defect are kept as a regression case at the foot
 * of this file. See `docs/disputes/L9-branches.md` §1.
 * ---------------------------------------------------------------------------
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck, SPINE } from '../../src/runtime/deck.js';
import { checkInvariants, beatsOf, initialState, navigate } from '../../src/runtime/nav.js';
import { randomWalkTrace, driveToSpineEnd, orphanReasons } from '../../src/branch/walk.js';
import { nestingDepths, branchCoverage } from '../../src/branch/graph.js';
import { generateBranchyProof } from '../fixtures/branch/generate-deck.mjs';
import { scene, branch, brand } from '../fixtures/make-proof.mjs';
import { defaultEmitOptions } from '../../src/core/contracts.js';
import { contentId } from '../../src/core/ids.js';

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

    // No try/catch: a `NavInvariantError` escaping here fails the test, which
    // is the §17.8 assertion that the reducer never throws during a legal walk.
    const trace = randomWalkTrace(deck, { seed, steps: STEPS });

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

/**
 * The five keystrokes that used to strand the presenter, kept as a regression.
 *
 * Three spine scenes; `bnA` (policy `anchor`) hangs off spine scene 1 and offers
 * `bnB` (policy `nextSpineScene`). Jump, jump, one press of space, one press of
 * back — five keystrokes a presenter makes without thinking — and until
 * `ec1dd38` the return stack's floor was a branch, from which `r` threw.
 *
 * The nesting and the two different return policies are the whole point: the
 * automatic exit has to put back exactly what it took, whether the policy popped
 * one frame or unwound all of them.
 */
test('the nextSpineScene auto-exit restores the whole return stack (regression, ec1dd38)', () => {
  const spine = [scene('sc_pin_0', 1), scene('sc_pin_1', 1), scene('sc_pin_2', 1)];
  const inner = scene('sc_pin_a0', 1, { branchAnchors: ['bn_pin_b'] });
  const outer = branch('bn_pin_a', 'The outer objection', [inner], 'anchor', []);
  const nested = branch('bn_pin_b', 'The nested objection', [scene('sc_pin_b0', 1)], 'nextSpineScene', []);
  spine[1].branchAnchors = ['bn_pin_a'];

  const deck = buildDeck({
    schemaVersion: 1,
    id: contentId('proof', 'nested-exit-regression'),
    prospectName: 'Regression',
    createdAt: '2026-02-01T09:00:00.000Z',
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches: [outer, nested],
    emitOptions: defaultEmitOptions(),
  });

  let state = initialState(deck);
  state = navigate(deck, state, { type: 'goToScene', sceneId: 'sc_pin_1' });
  state = navigate(deck, state, { type: 'jump', branchId: 'bn_pin_a' });
  state = navigate(deck, state, { type: 'jump', branchId: 'bn_pin_b' });
  assert.deepEqual(state.stack.map((f) => f.sequenceId), [SPINE, 'bn_pin_a'], 'the nested jump stacks two frames');

  // Space past the last beat of the nested branch: `nextSpineScene` unwinds the
  // whole stack and moves the pitch on.
  state = navigate(deck, state, { type: 'nextBeat' });
  assert.equal(state.sequenceId, SPINE);
  assert.equal(state.sceneIndex, 2, 'the scene after the spine anchor the detour started from');
  assert.deepEqual(state.stack, []);
  assert.ok(state.exitedFrom, 'the exit is marked reversible (D15)');

  // Back: D15 re-enters the branch where it was left, with everything that was
  // popped put back.
  state = navigate(deck, state, { type: 'prevBeat' });
  assert.equal(state.sequenceId, 'bn_pin_b');
  assert.deepEqual(state.stack.map((f) => f.sequenceId), [SPINE, 'bn_pin_a'],
    'the whole stack comes back, not just its top frame');
  assert.deepEqual(orphanReasons(deck, state), [], 'and the state is sound, floor included');

  // And the key a presenter reaches for when the detour is over works.
  const home = navigate(deck, state, { type: 'returnToSpine' });
  assert.equal(home.sequenceId, SPINE);
  assert.equal(home.sceneIndex, 1, 'back where the first jump was made');
  assert.deepEqual(home.stack, []);

  // One level up rather than all the way: `return` pops exactly one frame.
  const oneUp = navigate(deck, state, { type: 'return' });
  assert.equal(oneUp.sequenceId, SPINE, 'nextSpineScene unwinds the detour rather than popping one level');
  assert.equal(oneUp.sceneIndex, 2);
  assert.deepEqual(oneUp.stack, []);
});

/**
 * `haltOn` is what let the property test fence the defect above while it was
 * outstanding, and it is what rehearsal uses to stop at the first anomaly
 * instead of walking on through the wreckage. It stays tested so it stays
 * working the next time something needs fencing.
 */
test('a walk can be stopped at the first state a caller rejects', () => {
  const { proof } = generateBranchyProof('property/halt');
  const deck = buildDeck(proof);
  const full = randomWalkTrace(deck, { seed: 'property/halt', steps: 200 });
  const offSpineAt = full.states.findIndex((s) => s.sequenceId !== SPINE);
  assert.ok(offSpineAt > 0, 'the corpus walk never left the spine');

  const halted = randomWalkTrace(deck, { seed: 'property/halt', steps: 200, haltOn: (s) => s.sequenceId !== SPINE });
  assert.ok(halted.halted, 'the walk did not stop');
  assert.equal(halted.halted.step, offSpineAt, 'it stopped at exactly the transition the predicate names');
  assert.equal(halted.states.length, offSpineAt, 'the rejected state is reported, not appended');
  for (const state of halted.states) assert.equal(state.sequenceId, SPINE);
  assert.deepEqual(halted.states, full.states.slice(0, offSpineAt), 'halting changes nothing about the walk itself');
});
