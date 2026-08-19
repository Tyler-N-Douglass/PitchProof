/**
 * Bridge to L6 — `src/specimen/index.js` (`API.md` Part 3 → L6).
 *
 * One export, and it is the one §18.3 turns on: `markEdited` is the only way a
 * specimen records that its content was changed, and L6 refuses an edit that
 * does not say what changed. L11's `ASSET_MISSING` auto-fix removes a block from
 * a specimen, so it goes through here rather than writing `edited` / `editNotes`
 * itself — the honesty law has one implementation, in the lane that owns the
 * model (L11-D30).
 *
 * **Imported from the lane's published index**, unlike `lane-emit.js`: that
 * bridge names two modules deep inside L10 because importing L10's index closes
 * a cycle the bundler refuses, and §19's "cross-lane needs go through the frozen
 * contracts" is otherwise the rule. There is no cycle here — nothing under
 * `src/specimen/` imports L11 — so the published surface is the one to use, and
 * `test/integration/api-conformance.test.mjs` holds this file to it.
 *
 * @module validate/lane-specimen
 */

export { markEdited } from '../specimen/index.js';
