/**
 * Bridge to L10 — `src/emit/index.js` (`API.md` Part 3 → L10).
 *
 * L10 enforces both of these inside `emit()`, which is where §22.6 requires the
 * enforcement to live. L11 calls them earlier, in the preflight sweep, so the
 * seller sees the same findings before they reach the emit button rather than
 * only when the button refuses.
 *
 * @module validate/lane-emit
 */

export { scanForNetworkReferences, assertProvenance } from '../emit/index.js';
