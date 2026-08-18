/**
 * The eight layouts, in one table.
 *
 * `registerAllLayouts()` puts them in L2's registry; `LAYOUT_FUNCTIONS` is the
 * same set as a plain map, which is what `measureScene` and `buildScene` render
 * through. They deliberately do *not* go via the registry: measuring and
 * planning must work whether or not somebody remembered to call
 * `registerAllLayouts()` first, and a lane that quietly depended on global
 * registration order would be a lane whose tests pass alone and fail in the
 * suite.
 *
 * @module scene/layouts/all
 */

import { registerLayout } from '../../runtime/layouts.js';
import { splitBeforeAfter } from './split-before-after.js';
import { fanOut } from './fan-out.js';
import { stack } from './stack.js';
import { fullBleed } from './full-bleed.js';
import { sideNote } from './side-note.js';
import { systemMap } from './system-map.js';
import { quoteCard } from './quote-card.js';
import { contentsIndex } from './contents-index.js';

/** @type {Record<string, (ctx: any) => any>} */
export const LAYOUT_FUNCTIONS = {
  splitBeforeAfter,
  fanOut,
  stack,
  fullBleed,
  sideNote,
  systemMap,
  quoteCard,
  contentsIndex,
};

/**
 * Register all eight with the runtime registry (§4's closed set).
 * @returns {() => void} unregister every one of them
 */
export function registerAllLayouts() {
  const offs = Object.keys(LAYOUT_FUNCTIONS).map((name) =>
    registerLayout(/** @type {any} */ (name), LAYOUT_FUNCTIONS[name]));
  return () => offs.forEach((off) => off());
}

/**
 * The layout function for a scene layout name.
 * @param {string} name
 * @returns {(ctx: any) => any}
 */
export function layoutFunction(name) {
  const fn = LAYOUT_FUNCTIONS[name];
  if (!fn) throw new Error(`scene/layouts: "${String(name)}" is not one of the eight §4 layouts`);
  return fn;
}
