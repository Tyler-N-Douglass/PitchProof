/**
 * Bridge to L10 — `src/emit/index.js` (`API.md` Part 3 → L10).
 *
 * L10 enforces both of these inside `emit()`, which is where §22.6 requires the
 * enforcement to live. L11 calls them earlier, in the preflight sweep, so the
 * seller sees the same findings before they reach the emit button rather than
 * only when the button refuses.
 *
 * **Imported from the modules that define them, not from the lane's index.**
 * `emit/index.js` re-exports the whole lane, so importing the two functions
 * through it pulled `emit/emit.js` into the graph and closed a cycle —
 * `emit/emit.js → validate/index.js → validate/preflight.js → lane-emit.js →
 * emit/index.js` — which the bundler refuses outright (D3: it refuses what it
 * will not silently mis-compile). That cycle is why L10's §14 gate had to
 * assemble `validate/rules.js` itself rather than calling `runPreflight`, and
 * why the two came within one un-run test of drifting apart. Naming the defining
 * modules costs nothing and removes the edge; L10-D8 asked for it.
 *
 * @module validate/lane-emit
 */

export { scanForNetworkReferences } from '../emit/scan.js';
export { assertProvenance } from '../emit/provenance.js';
