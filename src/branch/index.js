/**
 * L9 Branches — the branch graph, the jump index, the return stack and the
 * three overlays that make a branchable pitch navigable in a live room
 * (§2, §11, §12, §17.8, §22.4).
 *
 * The surface below is the one `API.md` declares. Everything else in this
 * directory is an implementation detail no other lane may reach into.
 *
 * @module branch
 */

export { buildJumpIndex, searchJump, highlightRuns, FIELD_WEIGHT, STRATEGY_SCORE, DEFAULT_LIMIT } from './jump-index.js';
export { registerBranchOverlays, JumpController, renderJumpOverlay, renderMapOverlay, renderContentsOverlay, sceneTitle, JUMP_INPUT_ATTR, COMMAND_ATTR, PAYLOAD_ATTR } from './overlays.js';
export { installBranchInputBridge } from './bridge.js';
export { returnTargetFor, branchCoverage, anchorsOf, primaryAnchor, nestingDepths, branchGraph, liveReturnTarget } from './graph.js';
export { randomWalk, randomWalkTrace, driveToSpineEnd, orphanReasons, samePosition, WALK_WEIGHTS } from './walk.js';
export { fold, tokenize, charGrams, acronyms, boundedEditDistance, boundedPrefixDistance, typoBudget } from './text.js';
