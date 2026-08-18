/**
 * Navigation: a pure reducer with an explicit return stack (§11, §22.4).
 *
 * §22.4 names the return stack as one of the six things most likely to be
 * wrong: "nested branch jumps that don't unwind correctly strand the presenter
 * mid-pitch". So navigation is not a set of methods that mutate a cursor. It is
 * a reducer from `(deck, state, action) → state` with a hard invariant checked
 * on every transition:
 *
 *   1. stack depth is never negative;
 *   2. a frame is only ever popped by a return;
 *   3. when the stack is empty, the active sequence IS the spine;
 *   4. the position always names a real scene and a real beat.
 *
 * A violated invariant throws rather than degrading, because a runtime that
 * quietly recovers from an impossible state is a runtime that strands a
 * presenter in front of a client without telling anyone why.
 *
 * @module runtime/nav
 */

import { SPINE, sceneAt, sequenceOf } from './deck.js';
import { contentHash } from '../core/hash.js';

/**
 * @typedef {object} ReturnFrame
 * @property {string} sequenceId
 * @property {number} sceneIndex
 * @property {number} beatIndex
 * @property {'anchor'|'nextSpineScene'} returnPolicy
 * @property {string} branchId   the branch this frame was pushed to enter
 */

/**
 * @typedef {object} NavState
 * @property {string} sequenceId
 * @property {number} sceneIndex
 * @property {number} beatIndex
 * @property {ReturnFrame[]} stack
 * @property {string[]} visited     scene ids shown so far, in order, deduplicated
 * @property {{from: {sequenceId: string, sceneIndex: number, beatIndex: number}, stack: ReturnFrame[]}|null} [exitedFrom]
 *   Set only by the automatic exit that fires when the presenter advances past
 *   the last beat of a branch. It makes that one transition reversible: pressing
 *   back immediately afterwards re-enters the branch where it was left, instead
 *   of walking into the previous spine scene. It is cleared by every other
 *   transition, and it is deliberately absent from `stateHash` — it changes what
 *   the back key does, not what is on screen.
 *
 *   It records the **whole** stack the exit unwound, not the top frame. A
 *   `returnPolicy: 'anchor'` exit pops one frame, but `'nextSpineScene'` unwinds
 *   all of them; restoring only the top frame would leave the stack floored on a
 *   branch instead of the spine, and the next return would throw one action
 *   later — the presenter presses back, then `r`, and the deck stops responding.
 */

/**
 * The state a deck opens in.
 * @param {import('./deck.js').Deck} deck
 * @returns {NavState}
 */
export function initialState(deck) {
  const first = deck.spine.scenes[0];
  return {
    sequenceId: SPINE,
    sceneIndex: 0,
    beatIndex: 0,
    stack: [],
    visited: first ? [first.id] : [],
    exitedFrom: null,
  };
}

/** Thrown when a transition would produce a state the machine forbids. */
export class NavInvariantError extends Error {}

/**
 * Assert the machine's invariants. Called on every produced state.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {string} action
 * @returns {NavState}
 */
export function checkInvariants(deck, state, action) {
  const fail = (msg) => { throw new NavInvariantError(`${action}: ${msg}`); };
  if (!Array.isArray(state.stack)) fail('stack is not an array');
  if (state.stack.length < 0) fail('stack depth is negative');
  if (state.stack.length === 0 && state.sequenceId !== SPINE) {
    fail(`stack is empty but the active sequence is ${state.sequenceId}, not the spine`);
  }
  if (state.stack.length > 0 && state.sequenceId === SPINE) {
    fail('the spine is active with a non-empty return stack');
  }
  const seq = deck.sequences.get(state.sequenceId);
  if (!seq) fail(`unknown sequence ${state.sequenceId}`);
  if (seq.scenes.length === 0) {
    if (state.sceneIndex !== 0 || state.beatIndex !== 0) fail('position set inside an empty sequence');
    return state;
  }
  if (state.sceneIndex < 0 || state.sceneIndex >= seq.scenes.length) {
    fail(`scene index ${state.sceneIndex} is outside ${state.sequenceId} (${seq.scenes.length} scenes)`);
  }
  const beats = beatsOf(seq.scenes[state.sceneIndex]);
  if (state.beatIndex < 0 || state.beatIndex >= beats) {
    fail(`beat index ${state.beatIndex} is outside scene ${seq.scenes[state.sceneIndex].id} (${beats} beats)`);
  }
  for (const frame of state.stack) {
    if (!deck.sequences.has(frame.sequenceId)) fail(`stack frame names unknown sequence ${frame.sequenceId}`);
  }
  // The floor is always the spine: a frame is pushed only by a jump, recording
  // where the jump came from, and the first jump can only be made from the
  // spine. `unwindToNextSpineScene` computes from `stack[0]` on exactly this
  // basis, so it is checked here rather than assumed — a state whose floor is a
  // branch passes every other check and throws one action later.
  if (state.stack.length > 0 && state.stack[0].sequenceId !== SPINE) {
    fail(`the return stack is floored on ${state.stack[0].sequenceId}, not the spine`);
  }
  return state;
}

/**
 * A scene always has at least one beat as far as navigation is concerned: a
 * scene with no beats is one still visual state. Validation raises `BEAT_EMPTY`
 * for it; navigation must not divide by zero in the meantime.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @returns {number}
 */
export function beatsOf(scene) {
  return Math.max(1, (scene.beats || []).length);
}

/**
 * @param {NavState} state
 * @param {string} sceneId
 * @returns {string[]}
 */
function withVisited(state, sceneId) {
  if (!sceneId || state.visited[state.visited.length - 1] === sceneId) return state.visited;
  if (state.visited.includes(sceneId)) return state.visited;
  return state.visited.concat(sceneId);
}

/**
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {Partial<NavState>} patch
 * @returns {NavState}
 */
function at(deck, state, patch) {
  const next = { exitedFrom: null, ...state, ...patch };
  if (!Object.prototype.hasOwnProperty.call(patch, 'exitedFrom')) next.exitedFrom = null;
  const scene = sceneAt(deck, next.sequenceId, next.sceneIndex);
  next.visited = scene ? withVisited(state, scene.id) : state.visited;
  return next;
}

/**
 * @typedef {(
 *   | {type: 'nextBeat'}
 *   | {type: 'prevBeat'}
 *   | {type: 'nextScene'}
 *   | {type: 'prevScene'}
 *   | {type: 'firstScene'}
 *   | {type: 'lastScene'}
 *   | {type: 'jump', branchId: string}
 *   | {type: 'goToScene', sceneId: string}
 *   | {type: 'goToBeat', sceneId: string, beatIndex: number}
 *   | {type: 'return'}
 *   | {type: 'returnToSpine'}
 * )} NavAction
 */

/**
 * The reducer. Pure: same deck, same state, same action, same result.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {NavAction} action
 * @returns {NavState}
 */
export function navigate(deck, state, action) {
  const seq = sequenceOf(deck, state.sequenceId);
  const scene = seq.scenes[state.sceneIndex];
  const lastBeat = scene ? beatsOf(scene) - 1 : 0;
  const lastScene = seq.scenes.length - 1;

  switch (action.type) {
    case 'nextBeat': {
      if (scene && state.beatIndex < lastBeat) {
        return checkInvariants(deck, at(deck, state, { beatIndex: state.beatIndex + 1 }), 'nextBeat');
      }
      return navigate(deck, state, { type: 'nextScene' });
    }

    case 'prevBeat': {
      if (state.exitedFrom) return reenterExited(deck, state, 'prevBeat');
      if (state.beatIndex > 0) {
        return checkInvariants(deck, at(deck, state, { beatIndex: state.beatIndex - 1 }), 'prevBeat');
      }
      return navigate(deck, state, { type: 'prevScene' });
    }

    case 'nextScene': {
      if (state.sceneIndex < lastScene) {
        return checkInvariants(deck, at(deck, state, { sceneIndex: state.sceneIndex + 1, beatIndex: 0 }), 'nextScene');
      }
      // Past the end of a branch, the branch returns. Past the end of the
      // spine, the deck holds — a proof that wraps around to its own first
      // scene in front of a client reads as a bug, not as a feature.
      if (state.stack.length > 0) {
        const exitedFrom = {
          from: { sequenceId: state.sequenceId, sceneIndex: state.sceneIndex, beatIndex: state.beatIndex },
          stack: state.stack,
        };
        const returned = navigate(deck, state, { type: 'return' });
        return { ...returned, exitedFrom };
      }
      return checkInvariants(deck, state, 'nextScene');
    }

    case 'prevScene': {
      if (state.exitedFrom) return reenterExited(deck, state, 'prevScene');
      if (state.sceneIndex > 0) {
        const target = seq.scenes[state.sceneIndex - 1];
        return checkInvariants(deck, at(deck, state, {
          sceneIndex: state.sceneIndex - 1,
          beatIndex: beatsOf(target) - 1,
        }), 'prevScene');
      }
      // Stepping back off the front of a branch returns to where the jump came
      // from, exactly. That is what makes a mistaken jump costless.
      if (state.stack.length > 0) return popExactly(deck, state, 'prevScene');
      return checkInvariants(deck, state, 'prevScene');
    }

    case 'firstScene':
      return checkInvariants(deck, at(deck, { ...state, stack: [] }, {
        sequenceId: SPINE,
        sceneIndex: 0,
        beatIndex: 0,
      }), 'firstScene');

    case 'lastScene': {
      const idx = Math.max(0, deck.spine.scenes.length - 1);
      const target = deck.spine.scenes[idx];
      return checkInvariants(deck, at(deck, { ...state, stack: [] }, {
        sequenceId: SPINE,
        sceneIndex: idx,
        beatIndex: target ? beatsOf(target) - 1 : 0,
      }), 'lastScene');
    }

    case 'jump': {
      const target = deck.sequences.get(action.branchId);
      if (!target || target.kind !== 'branch') return checkInvariants(deck, state, 'jump');
      if (target.scenes.length === 0) return checkInvariants(deck, state, 'jump');
      // Jumping to the branch you are already inside is a no-op, not a second
      // frame — otherwise a double keypress deepens the stack forever.
      if (state.sequenceId === target.id) return checkInvariants(deck, state, 'jump');
      /** @type {ReturnFrame} */
      const frame = {
        sequenceId: state.sequenceId,
        sceneIndex: state.sceneIndex,
        beatIndex: state.beatIndex,
        returnPolicy: target.returnPolicy || 'anchor',
        branchId: target.id,
      };
      return checkInvariants(deck, at(deck, { ...state, stack: state.stack.concat(frame) }, {
        sequenceId: target.id,
        sceneIndex: 0,
        beatIndex: 0,
      }), 'jump');
    }

    case 'goToScene':
    case 'goToBeat': {
      const loc = deck.sceneLocator.get(action.sceneId);
      if (!loc) return checkInvariants(deck, state, action.type);
      const targetScene = sceneAt(deck, loc.sequenceId, loc.sceneIndex);
      const beatIndex = action.type === 'goToBeat'
        ? Math.max(0, Math.min(beatsOf(targetScene) - 1, action.beatIndex))
        : 0;
      if (loc.sequenceId === state.sequenceId) {
        return checkInvariants(deck, at(deck, state, { sceneIndex: loc.sceneIndex, beatIndex }), action.type);
      }
      if (loc.sequenceId === SPINE) {
        // Going to a spine scene is leaving the branch, so the stack unwinds.
        return checkInvariants(deck, at(deck, { ...state, stack: [] }, {
          sequenceId: SPINE, sceneIndex: loc.sceneIndex, beatIndex,
        }), action.type);
      }
      // Landing inside a different branch is a jump, so it pushes a frame and
      // stays returnable.
      const jumped = navigate(deck, state, { type: 'jump', branchId: loc.sequenceId });
      if (jumped.sequenceId !== loc.sequenceId) return jumped;
      return checkInvariants(deck, at(deck, jumped, { sceneIndex: loc.sceneIndex, beatIndex }), action.type);
    }

    case 'return': {
      if (state.stack.length === 0) return checkInvariants(deck, state, 'return');
      const frame = state.stack[state.stack.length - 1];
      if (frame.returnPolicy === 'anchor') return popExactly(deck, state, 'return');
      return unwindToNextSpineScene(deck, state, 'return');
    }

    case 'returnToSpine': {
      if (state.stack.length === 0) return checkInvariants(deck, state, 'returnToSpine');
      // `r` unwinds the whole stack in one step rather than popping once: a
      // presenter reaching for "get me back to the pitch" means all the way
      // back, not one level up.
      const bottom = state.stack[0];
      return checkInvariants(deck, at(deck, { ...state, stack: [] }, {
        sequenceId: bottom.sequenceId,
        sceneIndex: bottom.sceneIndex,
        beatIndex: bottom.beatIndex,
      }), 'returnToSpine');
    }

    default:
      return checkInvariants(deck, state, 'unknown');
  }
}

/**
 * Undo the automatic exit that fired when the presenter advanced past the last
 * beat of a branch: step back into the branch where it was left, with the frame
 * that was popped restored. Without this, one forward keypress at the end of a
 * branch would put the branch permanently behind the presenter — and §17.9
 * requires forward-then-back to restore the exact prior state from every beat
 * of every scene, branches included.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {string} action
 * @returns {NavState}
 */
function reenterExited(deck, state, action) {
  const { from, stack } = state.exitedFrom;
  return checkInvariants(deck, at(deck, { ...state, stack }, {
    sequenceId: from.sequenceId,
    sceneIndex: from.sceneIndex,
    beatIndex: from.beatIndex,
  }), action);
}

/**
 * Pop one frame and restore its position exactly.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {string} action
 * @returns {NavState}
 */
function popExactly(deck, state, action) {
  const stack = state.stack.slice();
  const frame = stack.pop();
  return checkInvariants(deck, at(deck, { ...state, stack }, {
    sequenceId: frame.sequenceId,
    sceneIndex: frame.sceneIndex,
    beatIndex: frame.beatIndex,
  }), action);
}

/**
 * `returnPolicy: 'nextSpineScene'` means "we are done with this detour, move
 * the pitch on". From a branch nested inside another branch that still means
 * the spine, so the whole stack unwinds and the position advances past the
 * outermost anchor.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {string} action
 * @returns {NavState}
 */
function unwindToNextSpineScene(deck, state, action) {
  const bottom = state.stack[0];
  const spineLen = deck.spine.scenes.length;
  const nextIndex = Math.min(spineLen - 1, bottom.sceneIndex + 1);
  if (spineLen === 0) {
    return checkInvariants(deck, at(deck, { ...state, stack: [] }, {
      sequenceId: SPINE, sceneIndex: 0, beatIndex: 0,
    }), action);
  }
  // The bottom frame is always on the spine, because a frame is only pushed by
  // a jump and the first jump can only be made from the spine.
  return checkInvariants(deck, at(deck, { ...state, stack: [] }, {
    sequenceId: SPINE,
    sceneIndex: bottom.sequenceId === SPINE ? nextIndex : Math.min(spineLen - 1, bottom.sceneIndex),
    beatIndex: 0,
  }), action);
}

/**
 * Is the presenter currently off the spine?
 * @param {NavState} state
 * @returns {boolean}
 */
export function offSpine(state) {
  return state.sequenceId !== SPINE || state.stack.length > 0;
}

/**
 * The scene the state names.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @returns {import('../core/contracts.d.ts').Scene|null}
 */
export function currentScene(deck, state) {
  return sceneAt(deck, state.sequenceId, state.sceneIndex);
}

/**
 * The position one `nextBeat` ahead, without moving. The presenter view shows
 * this so the presenter knows what the room is about to see.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @returns {NavState}
 */
export function peekNext(deck, state) {
  return navigate(deck, state, { type: 'nextBeat' });
}

/**
 * A hash of everything that decides what is on screen. §17.9 asserts that
 * forward-then-back returns the original hash for every beat of every scene.
 * Scroll is not in the hash because it is derived from the beat (D12) — if it
 * were remembered, reversibility would depend on presentation history.
 * @param {import('./deck.js').Deck} deck
 * @param {NavState} state
 * @param {{blanked?: boolean, overlay?: string|null}} [chrome]
 * @returns {string}
 */
export function stateHash(deck, state, chrome = {}) {
  const scene = currentScene(deck, state);
  return contentHash({
    deck: deck.fingerprint,
    sequenceId: state.sequenceId,
    sceneId: scene ? scene.id : null,
    sceneIndex: state.sceneIndex,
    beatIndex: state.beatIndex,
    stack: state.stack.map((f) => `${f.sequenceId}:${f.sceneIndex}:${f.beatIndex}:${f.returnPolicy}`),
    blanked: !!chrome.blanked,
    overlay: chrome.overlay || null,
  });
}

/**
 * Every reachable position in the deck, spine first then each branch, in the
 * order a full walk would meet them. The rehearsal sweep (§14) and the
 * §17.9 reversibility test both walk this.
 * @param {import('./deck.js').Deck} deck
 * @returns {{sequenceId: string, sceneIndex: number, beatIndex: number, sceneId: string}[]}
 */
export function allPositions(deck) {
  /** @type {{sequenceId: string, sceneIndex: number, beatIndex: number, sceneId: string}[]} */
  const out = [];
  const order = [deck.spine, ...[...deck.sequences.values()].filter((s) => s.kind === 'branch')];
  for (const seq of order) {
    seq.scenes.forEach((scene, sceneIndex) => {
      for (let beatIndex = 0; beatIndex < beatsOf(scene); beatIndex++) {
        out.push({ sequenceId: seq.id, sceneIndex, beatIndex, sceneId: scene.id });
      }
    });
  }
  return out;
}
