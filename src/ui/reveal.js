/**
 * What a scene can reveal.
 *
 * The beat editor and the "plan the beats" action both need the same answer to
 * the same question: which elements does this scene's layout actually render?
 * Guessing it from the model would be a second, weaker copy of the layout, so
 * the answer comes from the real rendered tree — `Runtime.renderScene`, the
 * same call the artifact makes — and the ids are the ones the emitted file will
 * carry (`elementId`, via L8's `el()`).
 *
 * @module ui/reveal
 */

import { collectByAttr, textOf } from '../core/vdom.js';
import { REVEAL_ATTR } from '../runtime/beats.js';

/**
 * Every revealable element of a scene, in document order.
 * @param {any} app
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @returns {{id: string, label: string}[]}
 */
export function revealableElements(app, scene) {
  const runtime = app.preview.model(app.proof);
  if (!runtime || !scene) return [];
  let tree;
  try { tree = runtime.renderScene(scene); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const el of collectByAttr(tree, REVEAL_ATTR)) {
    const id = String(el.a[REVEAL_ATTR]);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: labelFor(el) });
  }
  return out;
}

/**
 * A human label for an element: its text if it has any, otherwise the layout
 * class that names its role.
 * @param {any} el
 * @returns {string}
 */
export function labelFor(el) {
  const text = textOf(el).replace(/\s+/g, ' ').trim();
  if (text) return text;
  const cls = String(el.a.class || '').split(/\s+/).find((c) => c.startsWith('pp-'));
  return cls || el.t;
}

/** The most beats a plan will produce. Beyond this a scene is a deck, not a beat. */
export const MAX_PLANNED_BEATS = 8;

/**
 * A beat plan over a scene's revealable elements: one beat per element until the
 * cap, then everything left folded into the last beat.
 *
 * The first beat deliberately reveals the first element rather than nothing —
 * a scene that opens blank is a scene the presenter has to press a key to
 * start, and §14 raises `BEAT_EMPTY` for the beat that reveals nothing.
 *
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {{id: string}[]} elements
 * @returns {import('../core/contracts.d.ts').Beat[]}
 */
export function planBeats(scene, elements) {
  const ids = elements.map((e) => e.id);
  if (!ids.length) return scene.beats || [];
  const count = Math.min(ids.length, MAX_PLANNED_BEATS);
  const existing = scene.beats || [];
  /** @type {import('../core/contracts.d.ts').Beat[]} */
  const beats = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const reveals = last ? ids.slice(i) : [ids[i]];
    const previous = existing[i];
    beats.push({
      id: previous ? previous.id : `${scene.id}_b${i}`,
      reveals,
      // A plan changes what a beat *shows*, never what the presenter wrote
      // against it. Losing a presenter note to a layout change would be exactly
      // the §20.10 "loses work" failure.
      presenterNote: previous ? previous.presenterNote : null,
      dwellHintMs: previous ? previous.dwellHintMs : null,
    });
  }
  return beats;
}
