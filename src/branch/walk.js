/**
 * Seeded random walks over the navigation reducer (§17.8, §22.4).
 *
 * §22.4 says the return stack is one of the six things most likely to be wrong,
 * and §17.8 says the answer is a property test: "random walks of jumps and
 * returns always terminate on the spine, never on an orphan". This file is the
 * engine of that test — and it is in `src/`, not in the test tree, because the
 * studio's rehearsal mode drives the same walks to shake a deck out before
 * anybody stands in front of a room with it.
 *
 * Every draw comes from a named PCG32 substream (`branch/walk/*`), so a failing
 * walk is reproducible from its seed alone: the seed is the bug report.
 *
 * @module branch/walk
 */

import { SeedBook } from '../core/prng.js';
import { SPINE, allBranches, branchesFrom, sceneAt } from '../runtime/deck.js';
import { initialState, navigate, currentScene, beatsOf } from '../runtime/nav.js';

/**
 * The action mix. Weighted towards forward motion because that is what a
 * presentation is: mostly `space`, with detours. A uniform mix would spend the
 * walk thrashing the stack and would never test a long forward run through a
 * branch, which is where the automatic exit (D15) lives.
 */
export const WALK_WEIGHTS = [
  { kind: 'nextBeat', weight: 38 },
  { kind: 'prevBeat', weight: 12 },
  { kind: 'nextScene', weight: 8 },
  { kind: 'prevScene', weight: 5 },
  { kind: 'jumpAnchored', weight: 15 },
  { kind: 'jumpAny', weight: 6 },
  { kind: 'return', weight: 8 },
  { kind: 'returnToSpine', weight: 3 },
  { kind: 'goToScene', weight: 3 },
  { kind: 'firstScene', weight: 1 },
  { kind: 'lastScene', weight: 1 },
];

const TOTAL_WEIGHT = WALK_WEIGHTS.reduce((n, w) => n + w.weight, 0);

/**
 * @typedef {object} WalkOptions
 * @property {string|number|bigint} [seed]
 * @property {number} [steps]
 * @property {boolean} [anchoredOnly]  only jump to branches the current scene offers
 * @property {string} [stream]         substream name suffix, for independent walks off one seed
 * @property {(state: import('../runtime/nav.js').NavState, action: object, previous: import('../runtime/nav.js').NavState) => boolean} [haltOn]
 *   Stop the walk the moment a produced state satisfies this predicate. The
 *   offending state is reported in `halted` rather than appended, so everything
 *   in `states` is a state the caller has already accepted. Rehearsal uses it to
 *   stop at the first anomaly instead of walking on through the wreckage; the
 *   §17.8 property test uses it to fence a known reducer defect without
 *   loosening a single assertion about everything else.
 */

/**
 * A seeded walk, with the action taken at every step.
 *
 * `states[0]` is the opening state and `states[i]` is the state after
 * `actions[i - 1]`, so a failure can be replayed exactly.
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {WalkOptions} [options]
 * @returns {{states: import('../runtime/nav.js').NavState[], actions: object[], maxDepth: number, sequencesVisited: Set<string>, scenesVisited: Set<string>, halted: {step: number, state: import('../runtime/nav.js').NavState, action: object, previous: import('../runtime/nav.js').NavState}|null}}
 */
export function randomWalkTrace(deck, options = {}) {
  const steps = Math.max(0, options.steps === undefined ? 200 : options.steps | 0);
  const seed = options.seed === undefined ? 'branch/walk' : options.seed;
  const rng = new SeedBook(seed).stream(`branch/walk/${options.stream || 'default'}`);
  const branches = allBranches(deck).filter((b) => b.scenes.length > 0);
  const sceneIds = [...deck.sceneLocator.keys()];

  let state = initialState(deck);
  /** @type {import('../runtime/nav.js').NavState[]} */
  const states = [state];
  /** @type {object[]} */
  const actions = [];
  let maxDepth = 0;
  const sequencesVisited = new Set([state.sequenceId]);
  const scenesVisited = new Set();
  const first = currentScene(deck, state);
  if (first) scenesVisited.add(first.id);

  /** @type {{step: number, state: import('../runtime/nav.js').NavState, action: object, previous: import('../runtime/nav.js').NavState}|null} */
  let halted = null;

  for (let i = 0; i < steps; i++) {
    const action = pickAction(deck, state, rng, branches, sceneIds, !!options.anchoredOnly);
    const previous = state;
    state = navigate(deck, state, action);
    if (options.haltOn && options.haltOn(state, action, previous)) {
      halted = { step: i + 1, state, action, previous };
      break;
    }
    actions.push(action);
    states.push(state);
    if (state.stack.length > maxDepth) maxDepth = state.stack.length;
    sequencesVisited.add(state.sequenceId);
    const scene = currentScene(deck, state);
    if (scene) scenesVisited.add(scene.id);
  }

  return { states, actions, maxDepth, sequencesVisited, scenesVisited, halted };
}

/**
 * The §17.8 walk: the state after every step, opening state first.
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {WalkOptions} [options]
 * @returns {import('../runtime/nav.js').NavState[]}
 */
export function randomWalk(deck, options = {}) {
  return randomWalkTrace(deck, options).states;
}

/**
 * Choose one action for the current state.
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {import('../runtime/nav.js').NavState} state
 * @param {import('../core/prng.js').Pcg32} rng
 * @param {import('../runtime/deck.js').Sequence[]} branches
 * @param {string[]} sceneIds
 * @param {boolean} anchoredOnly
 * @returns {import('../runtime/nav.js').NavAction}
 */
function pickAction(deck, state, rng, branches, sceneIds, anchoredOnly) {
  let roll = rng.nextInt(TOTAL_WEIGHT);
  let kind = WALK_WEIGHTS[WALK_WEIGHTS.length - 1].kind;
  for (const w of WALK_WEIGHTS) {
    if (roll < w.weight) { kind = w.kind; break; }
    roll -= w.weight;
  }

  switch (kind) {
    case 'jumpAnchored': {
      const scene = currentScene(deck, state);
      const here = scene ? branchesFrom(deck, scene.id).filter((b) => b.scenes.length > 0) : [];
      if (here.length === 0) return anchoredOnly ? { type: 'nextBeat' } : anyJump(rng, branches, state);
      return { type: 'jump', branchId: rng.pick(here).id };
    }
    case 'jumpAny': {
      // The jump index reaches any branch from any scene (§11), which is
      // precisely how a stack gets deep in a real room.
      if (anchoredOnly) return { type: 'nextBeat' };
      return anyJump(rng, branches, state);
    }
    case 'goToScene': {
      // `goToScene` into another branch is a jump in disguise (the reducer
      // pushes a frame for it), so an anchored-only walk may only address the
      // spine — otherwise the walk could nest deeper than the deck was
      // authored to nest, and the depth bound it exists to check would be
      // measuring the walk rather than the reducer.
      const pool = anchoredOnly ? deck.spine.scenes.map((s) => s.id) : sceneIds;
      if (pool.length === 0) return { type: 'nextBeat' };
      return { type: 'goToScene', sceneId: rng.pick(pool) };
    }
    default:
      return /** @type {import('../runtime/nav.js').NavAction} */ ({ type: kind });
  }
}

/**
 * @param {import('../core/prng.js').Pcg32} rng
 * @param {import('../runtime/deck.js').Sequence[]} branches
 * @param {import('../runtime/nav.js').NavState} state
 * @returns {import('../runtime/nav.js').NavAction}
 */
function anyJump(rng, branches, state) {
  if (branches.length === 0) return { type: 'nextBeat' };
  const target = rng.pick(branches);
  if (target.id === state.sequenceId) return { type: 'nextBeat' };
  return { type: 'jump', branchId: target.id };
}

/**
 * Drive a state to the end of the pitch the way a presenter would when the
 * detour is over: back to the spine, then forward until the deck holds.
 *
 * Returns the terminal state and the path taken. §17.8 asserts the terminal
 * state is always the last beat of the last spine scene with an empty stack —
 * which is the formal statement of "the presenter is never stranded".
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {import('../runtime/nav.js').NavState} start
 * @param {{maxSteps?: number}} [options]
 * @returns {{state: import('../runtime/nav.js').NavState, steps: number, states: import('../runtime/nav.js').NavState[]}}
 */
export function driveToSpineEnd(deck, start, options = {}) {
  const positions = [...deck.sequences.values()]
    .reduce((n, seq) => n + seq.scenes.reduce((m, sc) => m + beatsOf(sc), 0), 0);
  const cap = options.maxSteps === undefined ? Math.max(16, positions * 4 + 16) : options.maxSteps;

  let state = start;
  /** @type {import('../runtime/nav.js').NavState[]} */
  const states = [];
  let steps = 0;

  // `r` unwinds the whole stack in one step, however deep the nesting went.
  while (state.stack.length > 0 && steps < cap) {
    state = navigate(deck, state, { type: 'returnToSpine' });
    states.push(state);
    steps++;
  }

  for (; steps < cap; steps++) {
    const next = navigate(deck, state, { type: 'nextBeat' });
    if (samePosition(next, state)) break;
    state = next;
    states.push(state);
  }

  return { state, steps, states };
}

/**
 * @param {import('../runtime/nav.js').NavState} a
 * @param {import('../runtime/nav.js').NavState} b
 * @returns {boolean}
 */
export function samePosition(a, b) {
  return a.sequenceId === b.sequenceId && a.sceneIndex === b.sceneIndex && a.beatIndex === b.beatIndex
    && a.stack.length === b.stack.length;
}

/**
 * Is this state a legal, non-orphan position in the deck? The property test
 * calls it on every step: the position must name a real scene and a real beat,
 * the stack must be empty exactly when the spine is active, and every frame
 * must name a real position too.
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {import('../runtime/nav.js').NavState} state
 * @returns {string[]}  empty when the state is sound
 */
export function orphanReasons(deck, state) {
  /** @type {string[]} */
  const bad = [];
  const seq = deck.sequences.get(state.sequenceId);
  if (!seq) { bad.push(`unknown sequence ${state.sequenceId}`); return bad; }
  const scene = sceneAt(deck, state.sequenceId, state.sceneIndex);
  if (!scene) bad.push(`no scene at ${state.sequenceId}[${state.sceneIndex}]`);
  else if (state.beatIndex < 0 || state.beatIndex >= beatsOf(scene)) {
    bad.push(`beat ${state.beatIndex} outside scene ${scene.id}`);
  }
  if (state.stack.length < 0) bad.push('negative stack depth');
  if ((state.stack.length === 0) !== (state.sequenceId === SPINE)) {
    bad.push(`stack depth ${state.stack.length} with sequence ${state.sequenceId}`);
  }
  state.stack.forEach((frame, i) => {
    const frameScene = sceneAt(deck, frame.sequenceId, frame.sceneIndex);
    if (!frameScene) bad.push(`frame ${i} points at ${frame.sequenceId}[${frame.sceneIndex}] which is not a scene`);
    else if (frame.beatIndex < 0 || frame.beatIndex >= beatsOf(frameScene)) {
      bad.push(`frame ${i} beat ${frame.beatIndex} outside ${frameScene.id}`);
    }
    if (frame.returnPolicy !== 'anchor' && frame.returnPolicy !== 'nextSpineScene') {
      bad.push(`frame ${i} carries return policy ${frame.returnPolicy}`);
    }
  });
  if (state.stack.length > 0 && state.stack[0].sequenceId !== SPINE) {
    bad.push('the bottom frame is not on the spine');
  }
  return bad;
}
