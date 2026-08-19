/**
 * L7 — recipes, adapters and provenance. The lane surface declared in
 * `API.md` Part 3, plus the extensions the other lanes need.
 *
 * ## The API.md surface
 *
 * ```js
 * SEED_RECIPES: Recipe[]
 * recipeById(id): Recipe|null
 * alignBlocks(sourceBlocks, pastedBlocks): {pairs, score}
 * parsePasted(text): ContentBlock[]
 * buildRendition({specimen, recipe, label, blocks, media, producedBy, provenance?, notes?}): Rendition
 * promoteProvenance(rendition, {by, at}): Rendition
 * channelBudget(label): {maxChars, maxWords}|null
 * enforceBudget(blocks, budget): {blocks, overBy}
 * runAdapter(recipe, specimen, {endpoint, key, http}): Promise<Result<Rendition>>
 * ```
 *
 * ## What L10 and L11 must know
 *
 * - **`hasPromotionRecord(rendition)`** — a rendition claiming
 *   `'verified-by-user'` without one is a forgery (§22.6). `verifyProvenance`
 *   returns every problem as a string; empty means clean.
 * - **The promotion record format** is documented in `recipe/provenance.js` and
 *   in `docs/decisions/L7-recipes.md` D-L7-2. It is one line in `notes`:
 *   `[[pp-promotion:1;by=<base64url>;at=<iso>;of=<renditionId>;from=<provenance>;sig=<16 hex>]]`.
 * - **`sig` is tamper-evidence, not authentication** (finding F23). It is an
 *   unkeyed digest, and `promotionSignature`/`formatPromotionRecord` are on
 *   this surface, so anyone with the repository can mint a record that passes.
 *   `PromotionRecord.recordIntact` is the accurate name for the outcome;
 *   `signatureValid` survives as an identical alias for L12 and L11, and
 *   overstates what it knows. `PROMOTION_RECORD_LIMIT` is the sentence to show
 *   a person next to either one. There is no backend and no account system to
 *   key a real signature against (§1.1.5) — the module header in
 *   `recipe/provenance.js` sets out why, and what defends §22.6 instead.
 * - **`assertNoAdapterSecrets(value)`** — proves an adapter key is absent from
 *   anything about to be serialised. Empty means clean.
 * - **`renditionsRequiringLabel(renditions)`** — the exact set the artifact must
 *   carry a visible provenance label for.
 *
 * @module recipe
 */

export { SEED_RECIPES, RECIPE_TEMPLATES, recipeById, recipeAccepts, recipesFor, renderRecipe, renderAll } from './library.js';

export {
  buildRendition, promoteProvenance, demoteProvenance,
  hasPromotionRecord, readPromotionRecord, readPromotionRecords, parsePromotionRecords,
  formatPromotionRecord, promotionSignature, stripPromotionRecords, isIsoInstant,
  verifyProvenance, renditionsRequiringLabel, resolveProvenance, renditionId,
  PROMOTION_RECORD_VERSION, PROMOTION_RECORD_RE, PROMOTION_RECORD_LIMIT,
} from './provenance.js';

export {
  parsePasted, blocksFromText, blocksFromFragment, parseFragment,
  looksLikeHtml, looksLikeCta, decodeEntities, stripInlineMarkdown, nodeText, parseAttrs,
} from './paste.js';

export {
  alignBlocks, alignBlocksDetailed, blockSimilarity, typeSimilarity, lengthSimilarity,
  tokenSimilarity, substitutionScore, alignText,
  GAP_PENALTY, MOVE_THRESHOLD, MATCH_THRESHOLD, SIMILARITY_WEIGHTS,
} from './align.js';

export {
  channelBudget, enforceBudget, assignParts, smsSegments, smsUnits, isGsm7,
  CHANNEL_BUDGETS, SMS_SEGMENTS, GSM7_BASIC, GSM7_EXTENDED, CHARS_PER_WORD,
} from './budget.js';

export {
  assertNoFabricatedFacts, enforceNoFabricatedFacts, buildSourceBag, sourceStrings,
  unsourcedNote, WATCHED_BRANDS, TESTIMONIAL_MIN_WORDS,
} from './facts.js';

export {
  runAdapter, assertNoAdapterSecrets, noteAdapterSecret, forgetAdapterSecrets,
  adapterSecretCount, blocksFromAdapterPayload,
} from './adapter.js';

export { LOCALES, localeById, localizeText, formatContractRows, legalPlacementLabel } from './locales.js';

export { slot, mediaFor, cloneBlock, mapBlockText, legalLine, bodyBlocks, leadHeadline, leadParagraph, leadCta, finish } from './blocks.js';

export {
  normalizeWhitespace, flatten, tokenize, numericTokens, groupKey, sentences,
  firstClause, splitAtChars, titleCase, sentenceCase, quotedSpans, foldForCompare,
} from './text.js';
