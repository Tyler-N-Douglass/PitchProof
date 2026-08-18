/**
 * Was a rendition's `verified-by-user` claim actually earned?
 *
 * §4 says `provenance` must "NEVER default to 'verified-by-user'". §9 says the
 * only route to it is an explicit user promotion, and API.md gives L7 the
 * function that performs one: `promoteProvenance(rendition, {by, at})`, which
 * records who and when.
 *
 * The emitter cannot take the claim on trust. A rendition that says
 * `verified-by-user` with nothing behind it is the §22.6 failure exactly — a
 * proof implying that generated sample content is the client's approved copy —
 * and §9 puts the enforcement here rather than in the UI.
 *
 * **The reader is L7's, not the emitter's.** `hasPromotionRecord` comes from
 * `src/recipe/index.js`, which owns the record format. Two readers of one
 * format is one reader too many: the moment they disagree, the artifact ships
 * either an unlabelled lie or a false refusal, and neither lane would know
 * which of them was wrong. L7's reader is also stricter than a note-scraper can
 * be — a record is bound to the id of the rendition it was written for, so a
 * record copied from one rendition onto another does not verify.
 *
 * What this module adds is the emitter's *judgement* on top of that reading:
 * which renditions must carry a label, and which claims were never earned.
 *
 * @module emit/promotion
 */

import { hasPromotionRecord as recipeHasPromotionRecord, readPromotionRecord } from '../recipe/index.js';

/**
 * The promotion record that currently stands for a rendition, or null.
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {{by: string, at: string, of: string, from: string}|null}
 */
export function promotionRecord(rendition) {
  if (!rendition || typeof rendition !== 'object') return null;
  return readPromotionRecord(rendition);
}

/**
 * Does this rendition carry a promotion record that verifies against itself?
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {boolean}
 */
export function hasPromotionRecord(rendition) {
  if (!rendition || typeof rendition !== 'object') return false;
  return recipeHasPromotionRecord(rendition);
}

/**
 * Does this rendition have to carry a visible label in the artifact?
 *
 * §9: anything that is not `client-supplied`, and not a `verified-by-user`
 * whose promotion is on the record, is illustrative as far as the artifact is
 * concerned — including a `verified-by-user` claim with nothing behind it,
 * which is the case this function exists for.
 *
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {boolean}
 */
export function requiresProvenanceLabel(rendition) {
  if (!rendition) return false;
  if (rendition.provenance === 'client-supplied') return false;
  if (rendition.provenance === 'verified-by-user') return !hasPromotionRecord(rendition);
  return true;
}

/**
 * A `verified-by-user` claim with no promotion behind it — reported separately
 * from a missing label, because the lie is the claim, not the styling.
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {boolean}
 */
export function isUnearnedVerification(rendition) {
  return !!rendition && rendition.provenance === 'verified-by-user' && !hasPromotionRecord(rendition);
}
