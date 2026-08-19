/**
 * Bridge to L7 — `src/recipe/index.js` (`API.md` Part 5 → L7).
 *
 * The promotion record is L7's format: `promoteProvenance` is the only thing
 * that writes one (§9), and `docs/decisions/L7-recipes.md` D-L7-2 fixes its
 * grammar. L11 reads it with L7's reader rather than a second parser of its own
 * — see L11-D19, which supersedes L11-D7.
 *
 * `hasPromotionRecord` is declared on L7's surface in `API.md` Part 5 for
 * exactly this reason ("L10 and L11 must detect a `verified-by-user` claim
 * carrying no promotion record"), so importing it breaks no rule of §4.
 *
 * @module validate/lane-recipe
 */

export {
  hasPromotionRecord, readPromotionRecord, readPromotionRecords,
  PROMOTION_RECORD_RE, PROMOTION_RECORD_VERSION,
} from '../recipe/index.js';
