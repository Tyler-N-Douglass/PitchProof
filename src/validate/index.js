/**
 * L11 Validate — the preflight rules engine (§14, §17.4, §22.2).
 *
 * This module exports exactly the surface `API.md` Part 3 declares for L11,
 * plus the pieces the studio's rehearse panel needs to render what the engine
 * found. Nothing here accepts a flag that lets a severity-1 finding through, and
 * §14 is explicit that none may ever be added:
 *
 *   > Severity 1 findings block emit. There is no override flag. If a lane
 *   > proposes one, the critic rejects it.
 *
 * @module validate
 */

export { runPreflight, summarize, resolveBreakpoints, resolveDeps, measureDeck, readClock } from './preflight.js';
export { RULES, ruleFor, STALE_CAPTURE_DAYS, MAX_MEDIA_EDGE_PX } from './rules.js';
export {
  detectOverflow, detectBoxOverflow, layOutBox, resolveBoxFace, availableFamilies,
  classifyExcess, faceResolutions, fittingFontSizePx, fittingCharCount, truncationMode, advanceDeltaOf,
  OVERFLOW_CLIP_RATIO, OVERFLOW_CLIP_MIN_PX, OVERFLOW_NOISE_RATIO, OVERFLOW_NOISE_PX,
  TEXT_OVERFLOW_MODES, DEFAULT_TEXT_OVERFLOW,
} from './overflow.js';
export { checkContrast, contrastReport, displayTextIsLarge, PROVENANCE_PAIR, DISPLAY_SIZE_PX } from './contrast.js';
export { autoFixes, autoFixCommand, applyAll, FIXABLE_CODES, clone } from './autofix.js';
export { dryRun } from './dryrun.js';
export {
  severityOf, resolveSeverity, blocksEmit, blockingFindings, DECLARED_SEVERITY, NARROWABLE,
} from './severity.js';
export { makeFinding, sortFindings, compareFindings, compactLocus } from './finding.js';
export { hasPromotionRecord, promotionRecord, reviewReachable } from './provenance.js';
