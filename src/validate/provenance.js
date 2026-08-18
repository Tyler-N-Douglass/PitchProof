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
 * `hasPromotionRecord` is implemented here rather than imported from L7 because
 * `API.md` does not declare it on L7's surface, and a lane imports only declared
 * surfaces. It is injectable, so the integrator can hand L7's version in without
 * touching this module.
 *
 * @module validate/provenance
 */

/**
 * The promotion record `promoteProvenance` writes into `Rendition.notes`. Read
 * liberally: who and when, in that order, however the sentence is phrased.
 */
export const PROMOTION_PATTERN =
  /promot(?:ed|ion)\b[^.\n]*?\bby\s+(.+?)\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+Z?)?)/i;

/**
 * Does this rendition carry evidence that a person promoted it?
 *
 * Accepts either the note L7 writes, or a structured `promotion: {by, at}`
 * field if a lane adds one (§4 permits optional extensions).
 *
 * @param {import('../core/contracts.d.ts').Rendition & {promotion?: {by?: string, at?: string}}} rendition
 * @returns {boolean}
 */
export function hasPromotionRecord(rendition) {
  if (!rendition) return false;
  const structured = /** @type {any} */ (rendition).promotion;
  if (structured && typeof structured.by === 'string' && structured.by.trim()
      && typeof structured.at === 'string' && structured.at.trim()) {
    return true;
  }
  const notes = typeof rendition.notes === 'string' ? rendition.notes : '';
  return PROMOTION_PATTERN.test(notes);
}

/**
 * The promotion record, parsed, or null.
 * @param {any} rendition
 * @returns {{by: string, at: string}|null}
 */
export function promotionRecord(rendition) {
  if (!rendition) return null;
  const structured = rendition.promotion;
  if (structured && structured.by && structured.at) return { by: String(structured.by), at: String(structured.at) };
  const m = PROMOTION_PATTERN.exec(typeof rendition.notes === 'string' ? rendition.notes : '');
  return m ? { by: m[1].trim(), at: m[2].trim() } : null;
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
