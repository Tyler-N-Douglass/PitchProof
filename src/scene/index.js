/**
 * L8 Scenes — the public surface (API.md Part 3).
 *
 * Eight layouts, the reveal plan that drives them, and the measurement surface
 * §22.2's overflow detector runs on. Everything else in this directory is an
 * implementation detail of these five exports; the extras below them are
 * additions, not replacements, and exist because L11 and L12 need to reach the
 * same geometry the layouts were drawn with rather than re-derive it.
 *
 * @module scene/index
 */

export { registerAllLayouts, LAYOUT_FUNCTIONS, layoutFunction } from './layouts/all.js';
export { sceneTemplates, buildScene, collectGroups, presenterNote, mediaMap } from './plan.js';
export { measureScene, collectTextBoxes, renderSceneTree, normalizeContext, plainText, textOverflowOf, fitReason, insetLength, trackWidth as declaredTrackWidth, BRAND_BORDER_INSET } from './measure.js';
export {
  PROVENANCE_LABEL_CLASS, PROVENANCE_LABEL_TEXT, needsProvenanceLabel, provenanceLabel,
  PROVENANCE_LEDGER_CLASS, labelledRenditionIds, unlabelledRenditions, withProvenanceLedger,
  presentableNotes, displayUrl, URL_LABEL_BUDGET, PROVENANCE_LABEL_INSET_PX,
} from './parts.js';

// -- extensions ------------------------------------------------------------
// Geometry, tokens and the type scale, so L11 can reason about a box it was
// handed and L12 can lay the studio's preview out at true aspect without
// guessing at the artifact's numbers.
export { stageBox, boxGeometry, breakpointId, mapScale, mapLegendHeight, fanColumns, stagePadPx, trackWidth, ledgerAllowance, MAP_DESIGN, PANEL_BORDER_PX, NOTE_RULE_PX, SLOTS } from './geometry.js';
export { sceneVars, GEOM, TYPE_ROLES, BP_IDS, BP_QUERY, geom, cssRoleName, scenesCssRoles } from './tokens.js';
export { styleForRole, textRoles } from './type-scale.js';
export { alignColumns, alignPair, signatureOf } from './align.js';
export { renderBlock, renderBlocks, blockBody, summarize, firstOfType, headingRole } from './blocks.js';
export { faceFor, colorFor, logoFor, neutralBrand, availableFamilies, renderedFamily, borderWidthFor, DEFAULT_STACKS } from './brand-access.js';
// Writing direction, read from the optional `dir`/`lang` extensions L7 writes
// (CRITIQUE-2 C8, dispute L8-D11). Exported so L12's preview and L11's checks
// can ask the same question the layouts ask rather than re-deriving the rule.
export { flowOf, flowAttrs, resolveFlow, firstFlow, isRtl, DIRECTIONS } from './direction.js';
export { splitBeforeAfter } from './layouts/split-before-after.js';
export { fanOut } from './layouts/fan-out.js';
export { stack } from './layouts/stack.js';
export { fullBleed } from './layouts/full-bleed.js';
export { sideNote } from './layouts/side-note.js';
export { systemMap } from './layouts/system-map.js';
export { quoteCard } from './layouts/quote-card.js';
export { contentsIndex } from './layouts/contents-index.js';
