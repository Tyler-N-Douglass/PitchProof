/**
 * STAND-IN for L9's `branchCoverage(deck)` (`API.md` Part 3 → L9).
 *
 * §11's coverage rule, implemented against the L2 `Deck`:
 *
 *  - **unreachable** — a branch with no anchor *and* no jump-index entry. A
 *    branch earns a jump-index entry from its objection text or its aliases, so
 *    a branch with neither and no anchoring scene cannot be reached by any key
 *    the presenter can press.
 *  - **noReturn** — a branch whose last scene has no resolved return target:
 *    `returnPolicy: 'anchor'` with no scene anchoring it, or
 *    `'nextSpineScene'` with no spine to return to, or no scenes at all.
 *
 * @module validate/standin/branch-coverage
 */

/**
 * @param {any} deck  a runtime/deck.js Deck
 * @returns {{unreachable: string[], noReturn: string[]}}
 */
export function branchCoverage(deck) {
  /** @type {string[]} */
  const unreachable = [];
  /** @type {string[]} */
  const noReturn = [];

  /** @type {Set<string>} */
  const anchored = new Set();
  for (const ids of deck.anchorsByScene.values()) for (const id of ids) anchored.add(id);

  const spineLength = deck.spine.scenes.length;

  const branches = [...deck.sequences.values()].filter((s) => s.kind === 'branch');
  for (const branch of branches.sort((a, b) => a.id.localeCompare(b.id))) {
    const searchable = Boolean(
      (branch.objection && branch.objection.trim())
      || (branch.aliases || []).some((a) => a && a.trim()),
    );
    if (!anchored.has(branch.id) && !searchable) unreachable.push(branch.id);

    const hasScenes = branch.scenes.length > 0;
    const resolvable = branch.returnPolicy === 'anchor'
      ? anchored.has(branch.id)
      : spineLength > 0;
    if (!hasScenes || !resolvable) noReturn.push(branch.id);
  }

  return { unreachable, noReturn };
}

/**
 * The position a branch returns to, or null when it has none.
 * @param {any} deck
 * @param {string} branchId
 * @returns {{sequenceId: string, sceneIndex: number}|null}
 */
export function returnTargetFor(deck, branchId) {
  const branch = deck.sequences.get(branchId);
  if (!branch || branch.kind !== 'branch') return null;
  if (branch.returnPolicy === 'anchor') {
    for (const [sceneId, ids] of deck.anchorsByScene) {
      if (ids.includes(branchId)) {
        const at = deck.sceneLocator.get(sceneId);
        if (at) return at;
      }
    }
    return null;
  }
  return deck.spine.scenes.length > 0 ? { sequenceId: deck.spine.id, sceneIndex: 0 } : null;
}
