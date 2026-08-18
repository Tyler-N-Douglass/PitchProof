/**
 * §14 — dry-run mode.
 *
 * "Dry-run mode puts the presenter through the full deck with a heads-up issue
 * counter, so the last pass before walking in is a real rehearsal that also
 * validates."
 *
 * Two words in that sentence do the work. **Full** — the walk covers every
 * position in `allPositions(deck)`: every beat, of every scene, of the spine and
 * of every branch, including branches the presenter may never open on the day.
 * And **rehearsal** — the walk is driven for the presenter, in presentation
 * order, handing each position to `onPosition` with the issues that land there
 * and a running count, so the seller reads their own deck and the validator
 * reads it with them.
 *
 * The counter is live in the strict sense: at position *n* it reports what has
 * been *seen* by position *n*, not the final total. A presenter who stops
 * halfway knows exactly what they walked past.
 *
 * @module validate/dryrun
 */

import { buildDeck } from '../runtime/deck.js';
import { allPositions } from '../runtime/nav.js';
import { beatFrame } from '../runtime/beats.js';
import { runPreflight, summarize } from './preflight.js';

/**
 * Walk the deck, reporting issues as they come up.
 *
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @param {object} [options]
 * @param {(step: DryRunStep) => void|Promise<void>} [options.onPosition]
 * @param {(() => string)|string} [options.clock]  defaults to the proof's own createdAt,
 *   which keeps a rehearsal deterministic when the caller has no clock to give
 * @param {import('../core/contracts.d.ts').Finding[]} [options.findings]  a preflight
 *   result to reuse, so a studio that has just run the sweep does not run it twice
 * @returns {Promise<{positions: number, findings: import('../core/contracts.d.ts').Finding[],
 *                    summary: ReturnType<typeof summarize>, scenesWalked: number, branchesWalked: number}>}
 */
export async function dryRun(proof, options = {}) {
  const deck = buildDeck(proof);
  const positions = allPositions(deck);
  const findings = options.findings
    ? options.findings.slice()
    : await runPreflight(proof, { ...options, clock: options.clock || proof.createdAt });

  /** @type {Map<string, any[]>} */
  const bySceneId = new Map();
  /** @type {any[]} */
  const unplaced = [];
  for (const finding of findings) {
    const sceneId = finding.locus && finding.locus.sceneId;
    if (!sceneId) { unplaced.push(finding); continue; }
    if (!bySceneId.has(sceneId)) bySceneId.set(sceneId, []);
    bySceneId.get(sceneId).push(finding);
  }

  /** @type {Set<string>} */
  const seenIds = new Set();
  /** @type {Set<string>} */
  const scenesWalked = new Set();
  /** @type {Set<string>} */
  const branchesWalked = new Set();
  let blockingSeen = 0;

  const onPosition = typeof options.onPosition === 'function' ? options.onPosition : null;

  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    const sequence = deck.sequences.get(position.sequenceId);
    const scene = sequence ? sequence.scenes[position.sceneIndex] : null;
    if (!scene) continue;
    scenesWalked.add(scene.id);
    if (sequence.kind === 'branch') branchesWalked.add(sequence.id);

    const here = bySceneId.get(scene.id) || [];
    // A scene's findings surface at its first beat: that is the moment the
    // presenter is looking at the thing the finding is about.
    const arriving = position.beatIndex === 0 ? here : [];
    const fresh = arriving.filter((f) => !seenIds.has(f.id));
    for (const f of fresh) {
      seenIds.add(f.id);
      if (f.severity === 1) blockingSeen++;
    }

    if (onPosition) {
      /**
       * @typedef {object} DryRunStep
       * @property {number} index                 0-based position in the walk
       * @property {number} total                 positions in the whole deck
       * @property {{sequenceId: string, sceneIndex: number, beatIndex: number, sceneId: string}} position
       * @property {'spine'|'branch'} sequenceKind
       * @property {import('../core/contracts.d.ts').Scene} scene
       * @property {any} frame                    the beat frame the runtime would render
       * @property {string|null} presenterNote
       * @property {any[]} findings               every finding at this scene
       * @property {any[]} newFindings            the ones this step is the first to reach
       * @property {number} issuesSeen            live counter: findings met so far
       * @property {number} blockingSeen          live counter: severity-1 findings met so far
       */
      const frame = beatFrame(scene, position.beatIndex);
      await onPosition({
        index,
        total: positions.length,
        position,
        sequenceKind: sequence.kind,
        scene,
        frame,
        presenterNote: frame.presenterNote,
        findings: here,
        newFindings: fresh,
        issuesSeen: seenIds.size,
        blockingSeen,
      });
    }
  }

  // Findings with no scene — a palette failure, a branch with no way back, the
  // byte budget — belong to the deck as a whole. They are in the returned list
  // and in the summary; the walk simply has no position to show them at.
  return {
    positions: positions.length,
    findings,
    summary: summarize(findings),
    scenesWalked: scenesWalked.size,
    branchesWalked: branchesWalked.size,
    deckWideFindings: unplaced.length,
  };
}
