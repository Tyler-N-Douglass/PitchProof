/**
 * Bridge to L8 — `src/scene/index.js` (`API.md` Part 3 → L8).
 *
 * `measureScene` is the input §22.2 depends on: if a layout renders text it does
 * not measure, the overflow detector cannot see it.
 *
 * @module validate/lane-scene
 */

export { measureScene } from '../scene/index.js';
