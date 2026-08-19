/**
 * Model-level provenance checks (§9, §18.1, §22.6).
 *
 * L10 enforces provenance against the *rendered document* inside `emit()`, which
 * is where §22.6 requires the enforcement to live and where a label styled to
 * invisibility is caught. That check needs HTML and CSS, so it can only run at
 * emit. Two provenance defects are visible in the model alone, long before then,
 * and preflight raises them so the seller is not surprised at the last step:
 *
 *  - a rendition stamped `verified-by-user` with **no promotion record**. §9 says
 *    `promoteProvenance` is the only route to that value and that it records who
 *    promoted it and when. A rendition wearing the label without the record is
 *    either a hand-edited model or a lane that stamped it directly, and either
 *    way the artifact would tell a client that generated copy is approved fact.
 *    That is the single reputational risk in the product (§22.6).
 *  - `labelIllustrativeContent: false` on a build a recipient can open in Review
 *    mode. `normalizeEmitOptions` forces the flag true for those builds; a proof
 *    that still carries false has bypassed normalisation.
 *
 * **The reader is L7's.** `hasPromotionRecord` is not implemented here. It is
 * re-exported from `validate/lane-recipe.js`, which bridges to the module that
 * writes the record in the first place, exactly as `lane-brand.js` and
 * `lane-scene.js` bridge to L4 and L8. L11 carried its own reader for one round
 * (L11-D7) and the two disagreed: L7 writes a delimited `[[pp-promotion:1;…]]`
 * record, L11's regex was looking for an English sentence, and preflight raised
 * a severity-1 `PROVENANCE_UNLABELED` against honestly promoted renditions that
 * `emit()` was happy to accept. L11-D19 records the correction. `deps
 * .hasPromotionRecord` still exists as an injection seam, but the default is now
 * the same function L10 calls, so nothing has to be injected for the two to
 * agree.
 *
 * @module validate/provenance
 */

import { hasPromotionRecord, readPromotionRecord } from './lane-recipe.js';

export { hasPromotionRecord, readPromotionRecord };
export { PROMOTION_RECORD_RE, PROMOTION_RECORD_VERSION } from './lane-recipe.js';

/**
 * The promotion record that currently stands for a rendition, or `null`.
 *
 * The same shape L10's `promotionRecord` returns, because it is the same
 * function underneath: `{version, by, at, of, from, raw, signatureValid}`.
 * `by` and `at` — who promoted it and when, the two things §9 names — are
 * always present on a record that verifies.
 *
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {{version: number, by: string, at: string, of: string, from: string, raw: string, signatureValid: boolean}|null}
 */
export function promotionRecord(rendition) {
  if (!rendition || typeof rendition !== 'object') return null;
  return readPromotionRecord(rendition);
}

/**
 * True when a build's emit options make it reachable in Review mode, which is
 * where §9 says the illustrative label may never be disabled.
 * @param {import('../core/contracts.d.ts').EmitOptions} emitOptions
 * @returns {boolean}
 */
export function reviewReachable(emitOptions) {
  const mode = emitOptions && emitOptions.mode;
  return mode === 'review' || mode === 'both' || mode === undefined;
}

/**
 * Renditions a scene in the deck actually puts on screen. A rendition sitting
 * unused in the model cannot mislead anyone.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {Set<string>}
 */
export function renderedRenditionIds(proof) {
  /** @type {Set<string>} */
  const out = new Set();
  const scenes = [...(proof.spine || [])];
  for (const branch of proof.branches || []) scenes.push(...(branch.scenes || []));
  for (const scene of scenes) for (const id of scene.renditionIds || []) out.add(id);
  return out;
}

/**
 * The scene ids a rendition appears in, for a finding's locus.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {string} renditionId
 * @returns {string[]}
 */
export function scenesShowing(proof, renditionId) {
  /** @type {string[]} */
  const out = [];
  for (const scene of proof.spine || []) {
    if ((scene.renditionIds || []).includes(renditionId)) out.push(scene.id);
  }
  for (const branch of proof.branches || []) {
    for (const scene of branch.scenes || []) {
      if ((scene.renditionIds || []).includes(renditionId)) out.push(scene.id);
    }
  }
  return out;
}
