/**
 * Was a rendition's `verified-by-user` claim actually earned?
 *
 * §4 says `provenance` must "NEVER default to 'verified-by-user'". §9 says the
 * only route to it is an explicit user promotion, and API.md gives L7 the
 * function that performs one: `promoteProvenance(rendition, {by, at})`, which
 * "records who and when" in `rendition.notes`.
 *
 * The emitter cannot take the claim on trust. A rendition that says
 * `verified-by-user` with nothing behind it is the §22.6 failure exactly — a
 * proof implying that generated sample content is the client's approved copy —
 * and §9 puts the enforcement here rather than in the UI. So the emitter reads
 * the record itself.
 *
 * The reader is deliberately tolerant about *form* and strict about *content*:
 * it accepts a structured `promotion` field or a note, and in either case it
 * requires both a person and a timestamp. A note that says "promoted" and
 * nothing else is not a record of anything.
 *
 * @module emit/promotion
 */

/**
 * @typedef {object} PromotionRecord
 * @property {string} by
 * @property {string} at
 * @property {'field'|'note'} source
 */

const NOTE_PATTERNS = [
  /promoted\s+by\s*[:=]?\s*([^\n;|]+?)\s+(?:on|at)\s*[:=]?\s*([0-9][^\s\n;|]*)/i,
  /promoted\s*[:=]\s*([^\n;|]+?)\s+(?:on|at)\s*[:=]?\s*([0-9][^\s\n;|]*)/i,
  /verified\s+by\s*[:=]?\s*([^\n;|]+?)\s+(?:on|at)\s*[:=]?\s*([0-9][^\s\n;|]*)/i,
];

/**
 * Read a promotion record off a rendition, or return null.
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {PromotionRecord|null}
 */
export function promotionRecord(rendition) {
  if (!rendition || typeof rendition !== 'object') return null;

  const structured = /** @type {any} */ (rendition).promotion;
  if (structured && typeof structured === 'object') {
    const by = typeof structured.by === 'string' ? structured.by.trim() : '';
    const at = typeof structured.at === 'string' ? structured.at.trim() : '';
    if (by && at) return { by, at, source: 'field' };
  }

  const notes = typeof rendition.notes === 'string' ? rendition.notes : '';
  if (!notes) return null;

  const asJson = /"promotedBy"\s*:\s*"([^"]+)"[\s\S]*?"promotedAt"\s*:\s*"([^"]+)"/.exec(notes);
  if (asJson) return { by: asJson[1].trim(), at: asJson[2].trim(), source: 'note' };

  for (const re of NOTE_PATTERNS) {
    const m = re.exec(notes);
    if (m && m[1].trim() && m[2].trim()) return { by: m[1].trim(), at: m[2].trim(), source: 'note' };
  }
  return null;
}

/**
 * @param {import('../core/contracts.d.ts').Rendition} rendition
 * @returns {boolean}
 */
export function hasPromotionRecord(rendition) {
  return promotionRecord(rendition) !== null;
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
