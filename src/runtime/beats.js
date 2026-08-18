/**
 * The beat engine (§10).
 *
 * Beats are additive reveals: beat *n* shows everything from beats 0..*n*. That
 * one rule is what makes backward navigation exact — the visible set at a beat
 * is a pure function of the beat index, so going back one beat cannot depend on
 * how the presenter got there.
 *
 * Scroll follows the same discipline (DECISIONS D12): the scroll position for a
 * beat is derived from the first element that beat newly reveals, not
 * remembered from the last time the beat was on screen. A remembered scroll
 * would make the §17.9 state-hash assertion depend on whether anyone touched
 * the wheel.
 *
 * @module runtime/beats
 */

import { MAX_TRANSITION_MS } from '../core/contracts.js';
import { beatsOf } from './nav.js';

/** Attribute the host uses to find revealable elements in a rendered scene. */
export const REVEAL_ATTR = 'data-pp-el';
/** Class applied to an element that this beat has revealed. */
export const REVEALED_CLASS = 'pp-revealed';
/** Class applied to an element this beat reveals for the first time. */
export const ENTERING_CLASS = 'pp-entering';

/**
 * The element ids visible at a beat: the union of `reveals` over beats 0..n.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} beatIndex
 * @returns {Set<string>}
 */
export function revealedAt(scene, beatIndex) {
  /** @type {Set<string>} */
  const out = new Set();
  const beats = scene.beats || [];
  for (let i = 0; i <= beatIndex && i < beats.length; i++) {
    for (const id of beats[i].reveals || []) out.add(id);
  }
  return out;
}

/**
 * The element ids this beat adds that the previous beat did not have. Drives
 * the entrance transition and the canonical scroll target.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} beatIndex
 * @returns {string[]}
 */
export function newlyRevealedAt(scene, beatIndex) {
  const beats = scene.beats || [];
  if (beatIndex < 0 || beatIndex >= beats.length) return [];
  const before = revealedAt(scene, beatIndex - 1);
  return (beats[beatIndex].reveals || []).filter((id) => !before.has(id));
}

/**
 * A scene whose beats declare no reveals at all shows everything from beat 0.
 * Without this a `contentsIndex` or `quoteCard` scene — which has nothing to
 * stage — would render blank, and the presenter would be looking at an empty
 * screen with no way to know why.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @returns {boolean}
 */
export function sceneRevealsNothing(scene) {
  return (scene.beats || []).every((b) => !b.reveals || b.reveals.length === 0);
}

/**
 * The visibility decision for one element at one beat.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} beatIndex
 * @param {string} elementId
 * @returns {{visible: boolean, entering: boolean}}
 */
export function visibilityOf(scene, beatIndex, elementId) {
  if (sceneRevealsNothing(scene)) return { visible: true, entering: beatIndex === 0 };
  const shown = revealedAt(scene, beatIndex);
  return {
    visible: shown.has(elementId),
    entering: newlyRevealedAt(scene, beatIndex).includes(elementId),
  };
}

/**
 * The canonical scroll target for a beat: the element it newly reveals, or the
 * scene root at beat 0. Derived, never remembered (D12).
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} beatIndex
 * @returns {string|null}
 */
export function scrollTargetFor(scene, beatIndex) {
  const fresh = newlyRevealedAt(scene, beatIndex);
  if (fresh.length > 0) return fresh[0];
  if (beatIndex === 0) return null;
  // A beat that reveals nothing new (a pause beat, or a beat that only carries
  // a presenter note) leaves the frame where the last revealing beat put it.
  for (let i = beatIndex - 1; i >= 0; i--) {
    const prior = newlyRevealedAt(scene, i);
    if (prior.length > 0) return prior[0];
  }
  return null;
}

/**
 * The complete render decision for a beat. The host applies it; the rehearsal
 * sweep and the emitter's static first paint read it without a browser.
 * @typedef {object} BeatFrame
 * @property {string} sceneId
 * @property {number} beatIndex
 * @property {number} beatCount
 * @property {Set<string>|null} revealed   null when the scene reveals everything
 * @property {string[]} entering
 * @property {string|null} scrollTarget
 * @property {string|null} presenterNote
 * @property {number|null} dwellHintMs
 * @property {boolean} revealsEverything
 */

/**
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} beatIndex
 * @returns {BeatFrame}
 */
export function beatFrame(scene, beatIndex) {
  const beats = scene.beats || [];
  const beat = beats[beatIndex] || null;
  const revealsEverything = sceneRevealsNothing(scene);
  return {
    sceneId: scene.id,
    beatIndex,
    beatCount: beatsOf(scene),
    revealed: revealsEverything ? null : revealedAt(scene, beatIndex),
    entering: revealsEverything ? [] : newlyRevealedAt(scene, beatIndex),
    scrollTarget: revealsEverything ? null : scrollTargetFor(scene, beatIndex),
    presenterNote: beat ? beat.presenterNote : null,
    dwellHintMs: beat ? beat.dwellHintMs : null,
    revealsEverything,
  };
}

/**
 * The §10 motion budget: transitions are capped at 240ms, and
 * `prefers-reduced-motion` takes them to zero. Every animation the runtime
 * plays goes through this, so there is one place to check rather than eight.
 * @param {number} requestedMs
 * @param {boolean} reducedMotion
 * @returns {number}
 */
export function transitionMs(requestedMs, reducedMotion) {
  if (reducedMotion) return 0;
  if (!Number.isFinite(requestedMs) || requestedMs < 0) return 0;
  return Math.min(MAX_TRANSITION_MS, requestedMs);
}

/**
 * Reveal elements never animate on the way out. Hiding an element that a
 * backward step un-reveals has to be instantaneous, or stepping back twice
 * quickly leaves a half-faded ghost on the client's screen.
 */
export const EXIT_TRANSITION_MS = 0;

/**
 * A stable digest of what is on screen for one beat, independent of the DOM.
 * §17.9 uses it to assert that forward-then-back restores the exact prior state.
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {number} beatIndex
 * @returns {string}
 */
export function beatSignature(scene, beatIndex) {
  const f = beatFrame(scene, beatIndex);
  const revealed = f.revealed ? [...f.revealed].sort().join(',') : '*';
  return `${f.sceneId}|${f.beatIndex}|${revealed}|${f.scrollTarget || ''}`;
}

/**
 * `dwellHintMs` is a pacing hint for the presenter view and nothing else. §10:
 * "No auto-advance ever. A proof that moves on its own in front of a client is
 * a defect." This function is the only reader of the field in the runtime, and
 * it returns a number to display — never a timer to start.
 * @param {import('../core/contracts.d.ts').Beat|null} beat
 * @returns {string|null}
 */
export function dwellHintLabel(beat) {
  if (!beat || beat.dwellHintMs === null || beat.dwellHintMs === undefined) return null;
  const s = Math.round(beat.dwellHintMs / 100) / 10;
  return `${s}s`;
}
