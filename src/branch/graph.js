/**
 * The branch graph: anchors, resolved return targets, and coverage (§11, §14).
 *
 * The runtime's return stack is dynamic — it remembers where a jump came from.
 * This file is the *static* view of the same thing: what the authored proof
 * declares about where each branch goes when it ends. Rehearsal needs the
 * static view, because a presenter finds out about an unreachable branch or a
 * branch with nowhere to return the moment they need it, and by then it is a
 * room full of people watching them press keys.
 *
 * The two findings §11 names come straight out of here:
 *   - `BRANCH_UNREACHABLE` — no anchor and no jump-index entry: nothing in the
 *     artifact can reach it, so it is dead weight in the file;
 *   - `BRANCH_NO_RETURN` — the last scene has no resolved return target.
 *
 * @module branch/graph
 */

import { SPINE, allBranches } from '../runtime/deck.js';
import { buildJumpIndex } from './jump-index.js';

/**
 * @typedef {object} AnchorSite
 * @property {string} sceneId
 * @property {string} sequenceId   the sequence the anchoring scene lives in
 * @property {number} sceneIndex
 * @property {boolean} onSpine
 */

/**
 * Every scene that offers a branch, in the order a pitch would meet them:
 * spine anchors first by spine position, then branch anchors in deck order.
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {string} branchId
 * @returns {AnchorSite[]}
 */
export function anchorsOf(deck, branchId) {
  const order = new Map();
  [deck.spine, ...allBranches(deck)].forEach((seq, i) => order.set(seq.id, i));
  /** @type {AnchorSite[]} */
  const sites = [];
  for (const seq of deck.sequences.values()) {
    seq.scenes.forEach((scene, sceneIndex) => {
      const anchors = deck.anchorsByScene.get(scene.id) || [];
      if (!anchors.includes(branchId)) return;
      // A scene id can appear in more than one sequence in a defective proof
      // (DUPLICATE_SCENE); the locator decides which occurrence is navigable,
      // so the anchor site follows the locator rather than the raw scan.
      const loc = deck.sceneLocator.get(scene.id);
      if (!loc || loc.sequenceId !== seq.id || loc.sceneIndex !== sceneIndex) return;
      sites.push({ sceneId: scene.id, sequenceId: seq.id, sceneIndex, onSpine: seq.id === SPINE });
    });
  }
  return sites.sort((a, b) => {
    if (a.onSpine !== b.onSpine) return a.onSpine ? -1 : 1;
    const ao = order.has(a.sequenceId) ? order.get(a.sequenceId) : Number.MAX_SAFE_INTEGER;
    const bo = order.has(b.sequenceId) ? order.get(b.sequenceId) : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    if (a.sceneIndex !== b.sceneIndex) return a.sceneIndex - b.sceneIndex;
    return a.sceneId < b.sceneId ? -1 : a.sceneId > b.sceneId ? 1 : 0;
  });
}

/**
 * The anchor a branch returns to when its policy is `anchor`: the first one.
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {string} branchId
 * @returns {AnchorSite|null}
 */
export function primaryAnchor(deck, branchId) {
  const sites = anchorsOf(deck, branchId);
  return sites.length ? sites[0] : null;
}

/**
 * The resolved return target for a branch, or null when the proof declares
 * none.
 *
 * `anchor` resolves to the scene that offers the branch — which may itself be
 * a branch scene, and that is exactly the nesting §22.4 warns about.
 * `nextSpineScene` walks the anchor chain up to the spine and takes the scene
 * after it, mirroring what the reducer does when it unwinds
 * (`unwindToNextSpineScene`), including the clamp at the end of the spine: a
 * proof that runs off its own end in front of a client is worse than one that
 * holds on its last scene.
 *
 * A branch with no anchor at all resolves to null. Its return works at runtime
 * — the stack remembers the jump — but the *proof* declares no exit, and that
 * is what `BRANCH_NO_RETURN` is for.
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {string} branchId
 * @returns {{sequenceId: string, sceneIndex: number}|null}
 */
export function returnTargetFor(deck, branchId) {
  const seq = deck.sequences.get(branchId);
  if (!seq || seq.kind !== 'branch') return null;
  if (seq.scenes.length === 0) return null;

  const anchor = primaryAnchor(deck, branchId);
  if (!anchor) return null;

  const policy = seq.returnPolicy === 'nextSpineScene' ? 'nextSpineScene' : 'anchor';
  if (policy === 'anchor') {
    return { sequenceId: anchor.sequenceId, sceneIndex: anchor.sceneIndex };
  }

  const spineLength = deck.spine.scenes.length;
  if (spineLength === 0) return null;

  // Walk up the anchor chain to the spine: a branch nested two deep still
  // means "move the pitch on" relative to the spine scene the detour left.
  let site = anchor;
  const seen = new Set([branchId]);
  while (!site.onSpine) {
    if (seen.has(site.sequenceId)) return null;   // an anchor cycle resolves to nothing
    seen.add(site.sequenceId);
    const up = primaryAnchor(deck, site.sequenceId);
    if (!up) return null;
    site = up;
  }
  return { sequenceId: SPINE, sceneIndex: Math.min(spineLength - 1, site.sceneIndex + 1) };
}

/**
 * @typedef {object} BranchCoverageDetail
 * @property {string} branchId
 * @property {string} objection
 * @property {boolean} anchored
 * @property {string[]} anchorScenes
 * @property {boolean} searchable        has an objection or alias to find it by
 * @property {'anchor'|'nextSpineScene'} returnPolicy
 * @property {{sequenceId: string, sceneIndex: number}|null} returnTarget
 * @property {number} sceneCount
 * @property {number} depth              anchor nesting depth, 1 = hangs off the spine
 * @property {string[]} reasons          machine-readable causes, for L11's messages
 */

/**
 * The §11 coverage rule, as data.
 *
 * `unreachable` and `noReturn` are the two id lists L11 turns into
 * `BRANCH_UNREACHABLE` and `BRANCH_NO_RETURN`. `details` carries the reason for
 * each, so a finding can say *why* rather than just naming a branch — a branch
 * with no anchor and no objection text is a different problem from one whose
 * anchor chain never reaches the spine, and the fix is different too.
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @returns {{unreachable: string[], noReturn: string[], details: BranchCoverageDetail[], depthByBranch: Map<string, number>, maxNestingDepth: number}}
 */
export function branchCoverage(deck) {
  const index = buildJumpIndex(deck);
  const depths = nestingDepths(deck);
  /** @type {string[]} */
  const unreachable = [];
  /** @type {string[]} */
  const noReturn = [];
  /** @type {BranchCoverageDetail[]} */
  const details = [];

  for (const seq of allBranches(deck)) {
    const entry = index.byBranchId.get(seq.id);
    const sites = anchorsOf(deck, seq.id);
    const searchable = !!(entry && entry.searchable);
    const returnPolicy = seq.returnPolicy === 'nextSpineScene' ? 'nextSpineScene' : 'anchor';
    const returnTarget = returnTargetFor(deck, seq.id);
    /** @type {string[]} */
    const reasons = [];

    if (sites.length === 0 && !searchable) reasons.push('no-anchor-and-no-jump-entry');
    if (seq.scenes.length === 0) reasons.push('no-scenes');
    if (!returnTarget) {
      if (seq.scenes.length === 0) reasons.push('nothing-to-return-from');
      else if (sites.length === 0) reasons.push('unanchored');
      else if (returnPolicy === 'nextSpineScene' && deck.spine.scenes.length === 0) reasons.push('empty-spine');
      else if (returnPolicy === 'nextSpineScene') reasons.push('anchor-chain-never-reaches-spine');
    }

    if (sites.length === 0 && !searchable) unreachable.push(seq.id);
    if (!returnTarget) noReturn.push(seq.id);

    details.push({
      branchId: seq.id,
      objection: seq.objection || '',
      anchored: sites.length > 0,
      anchorScenes: sites.map((s) => s.sceneId),
      searchable,
      returnPolicy,
      returnTarget,
      sceneCount: seq.scenes.length,
      depth: depths.get(seq.id) || 1,
      reasons,
    });
  }

  let maxNestingDepth = 0;
  for (const d of depths.values()) if (d > maxNestingDepth) maxNestingDepth = d;

  return { unreachable, noReturn, details, depthByBranch: depths, maxNestingDepth };
}

/**
 * How deep each branch hangs: 1 when it is offered from a spine scene or from
 * nowhere at all, n+1 when it is offered from inside a branch of depth n.
 *
 * This is the bound the §17.8 property test checks the return stack against
 * when the walk only takes anchored jumps: a presenter who only ever jumps to
 * what the scene in front of them offers can never nest deeper than the deck
 * was authored to nest.
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @returns {Map<string, number>}
 */
export function nestingDepths(deck) {
  /** @type {Map<string, number>} */
  const memo = new Map();
  const resolve = (branchId, trail) => {
    if (memo.has(branchId)) return memo.get(branchId);
    if (trail.has(branchId)) return 1;               // a cycle contributes no depth
    trail.add(branchId);
    const sites = anchorsOf(deck, branchId);
    let depth = 1;
    for (const site of sites) {
      if (site.onSpine) { depth = Math.max(depth, 1); continue; }
      depth = Math.max(depth, resolve(site.sequenceId, trail) + 1);
    }
    trail.delete(branchId);
    memo.set(branchId, depth);
    return depth;
  };
  for (const seq of allBranches(deck)) resolve(seq.id, new Set());
  return memo;
}

/**
 * The branch graph as nodes and edges, for the branch map overlay and for any
 * lane that wants to draw or reason about the structure.
 * @param {import('../runtime/deck.js').Deck} deck
 * @returns {{nodes: {id: string, kind: 'spine'|'branch', objection: string|null, sceneCount: number, depth: number}[],
 *            edges: {from: string, to: string, sceneId: string, onSpine: boolean}[],
 *            maxNestingDepth: number}}
 */
export function branchGraph(deck) {
  const depths = nestingDepths(deck);
  const nodes = [
    { id: SPINE, kind: /** @type {'spine'} */ ('spine'), objection: null, sceneCount: deck.spine.scenes.length, depth: 0 },
    ...allBranches(deck).map((seq) => ({
      id: seq.id,
      kind: /** @type {'branch'} */ ('branch'),
      objection: seq.objection,
      sceneCount: seq.scenes.length,
      depth: depths.get(seq.id) || 1,
    })),
  ];
  /** @type {{from: string, to: string, sceneId: string, onSpine: boolean}[]} */
  const edges = [];
  for (const seq of allBranches(deck)) {
    for (const site of anchorsOf(deck, seq.id)) {
      edges.push({ from: site.sequenceId, to: seq.id, sceneId: site.sceneId, onSpine: site.onSpine });
    }
  }
  let maxNestingDepth = 0;
  for (const d of depths.values()) if (d > maxNestingDepth) maxNestingDepth = d;
  return { nodes, edges, maxNestingDepth };
}

/**
 * Where `return` would actually land from the live state — the dynamic twin of
 * `returnTargetFor`. The branch map shows this rather than the declared target,
 * because a presenter three levels deep needs to know where the next Escape
 * from the detour puts them, not what the author intended in the abstract.
 *
 * It mirrors the reducer exactly, including the `nextSpineScene` unwind of the
 * whole stack and the clamp at the end of the spine.
 *
 * @param {import('../runtime/deck.js').Deck} deck
 * @param {import('../runtime/nav.js').NavState} nav
 * @returns {{sequenceId: string, sceneIndex: number, policy: 'anchor'|'nextSpineScene', unwindsAll: boolean}|null}
 */
export function liveReturnTarget(deck, nav) {
  if (!nav || !nav.stack || nav.stack.length === 0) return null;
  const frame = nav.stack[nav.stack.length - 1];
  if (frame.returnPolicy === 'nextSpineScene') {
    const bottom = nav.stack[0];
    const spineLength = deck.spine.scenes.length;
    if (spineLength === 0) return { sequenceId: SPINE, sceneIndex: 0, policy: 'nextSpineScene', unwindsAll: true };
    const sceneIndex = bottom.sequenceId === SPINE
      ? Math.min(spineLength - 1, bottom.sceneIndex + 1)
      : Math.min(spineLength - 1, bottom.sceneIndex);
    return { sequenceId: SPINE, sceneIndex, policy: 'nextSpineScene', unwindsAll: true };
  }
  return {
    sequenceId: frame.sequenceId,
    sceneIndex: frame.sceneIndex,
    policy: 'anchor',
    unwindsAll: false,
  };
}
