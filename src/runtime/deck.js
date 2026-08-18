/**
 * The deck: a Proof flattened into the sequences the runtime navigates (§11).
 *
 * The spine is one sequence. Every branch is another. Everything the navigation
 * reducer needs is precomputed here — scene lookup, anchor lists, the jump-index
 * corpus — so navigation is a pure function over an already-built index rather
 * than a search through the model on every keystroke.
 *
 * @module runtime/deck
 */

import { contentHash } from '../core/hash.js';

/** The id of the spine sequence. Branch sequences use their Branch id. */
export const SPINE = 'spine';

/**
 * @typedef {object} Sequence
 * @property {string} id
 * @property {'spine'|'branch'} kind
 * @property {import('../core/contracts.d.ts').Scene[]} scenes
 * @property {'anchor'|'nextSpineScene'|null} returnPolicy
 * @property {string|null} objection      branch sequences only
 * @property {string[]} aliases
 */

/**
 * @typedef {object} Deck
 * @property {Map<string, Sequence>} sequences
 * @property {Sequence} spine
 * @property {Map<string, {sequenceId: string, sceneIndex: number}>} sceneLocator
 * @property {Map<string, string[]>} anchorsByScene   sceneId → branch ids offered there
 * @property {Map<string, import('../core/contracts.d.ts').Scene>} sceneById
 * @property {import('../core/contracts.d.ts').Proof} proof
 * @property {string} fingerprint   content hash of the navigable structure
 */

/**
 * Build a deck from a proof.
 * @param {import('../core/contracts.d.ts').Proof} proof
 * @returns {Deck}
 */
export function buildDeck(proof) {
  /** @type {Map<string, Sequence>} */
  const sequences = new Map();
  const spine = {
    id: SPINE,
    kind: /** @type {'spine'} */ ('spine'),
    scenes: proof.spine || [],
    returnPolicy: null,
    objection: null,
    aliases: [],
  };
  sequences.set(SPINE, spine);

  for (const branch of proof.branches || []) {
    sequences.set(branch.id, {
      id: branch.id,
      kind: 'branch',
      scenes: branch.scenes || [],
      returnPolicy: branch.returnPolicy,
      objection: branch.objection,
      aliases: branch.aliases || [],
    });
  }

  /** @type {Map<string, {sequenceId: string, sceneIndex: number}>} */
  const sceneLocator = new Map();
  /** @type {Map<string, import('../core/contracts.d.ts').Scene>} */
  const sceneById = new Map();
  /** @type {Map<string, string[]>} */
  const anchorsByScene = new Map();

  for (const seq of sequences.values()) {
    seq.scenes.forEach((scene, sceneIndex) => {
      // A scene id repeated across sequences is a modelling error the validator
      // reports as DUPLICATE_SCENE; the locator keeps the first occurrence so
      // navigation stays deterministic while that finding is outstanding.
      if (!sceneLocator.has(scene.id)) sceneLocator.set(scene.id, { sequenceId: seq.id, sceneIndex });
      if (!sceneById.has(scene.id)) sceneById.set(scene.id, scene);
      anchorsByScene.set(scene.id, (scene.branchAnchors || []).filter((b) => sequences.has(b)));
    });
  }

  const fingerprint = contentHash({
    sequences: [...sequences.values()].map((s) => ({
      id: s.id,
      kind: s.kind,
      returnPolicy: s.returnPolicy,
      scenes: s.scenes.map((sc) => ({ id: sc.id, beats: sc.beats.map((b) => b.id), anchors: sc.branchAnchors })),
    })),
  });

  return { sequences, spine, sceneLocator, anchorsByScene, sceneById, proof, fingerprint };
}

/**
 * @param {Deck} deck
 * @param {string} sequenceId
 * @returns {Sequence}
 */
export function sequenceOf(deck, sequenceId) {
  const seq = deck.sequences.get(sequenceId);
  if (!seq) throw new Error(`deck: unknown sequence ${sequenceId}`);
  return seq;
}

/**
 * The scene at a position, or null when the position is out of range.
 * @param {Deck} deck
 * @param {string} sequenceId
 * @param {number} sceneIndex
 * @returns {import('../core/contracts.d.ts').Scene|null}
 */
export function sceneAt(deck, sequenceId, sceneIndex) {
  const seq = deck.sequences.get(sequenceId);
  if (!seq) return null;
  return seq.scenes[sceneIndex] || null;
}

/**
 * Branches reachable from a scene, in declaration order.
 * @param {Deck} deck
 * @param {string} sceneId
 * @returns {Sequence[]}
 */
export function branchesFrom(deck, sceneId) {
  return (deck.anchorsByScene.get(sceneId) || []).map((id) => deck.sequences.get(id)).filter(Boolean);
}

/**
 * Every branch in the deck, spine order of first anchor first and unanchored
 * branches last, so the branch map reads in the order the pitch would meet them.
 * @param {Deck} deck
 * @returns {Sequence[]}
 */
export function allBranches(deck) {
  /** @type {Map<string, number>} */
  const firstAnchor = new Map();
  deck.spine.scenes.forEach((scene, i) => {
    for (const id of deck.anchorsByScene.get(scene.id) || []) {
      if (!firstAnchor.has(id)) firstAnchor.set(id, i);
    }
  });
  return [...deck.sequences.values()]
    .filter((s) => s.kind === 'branch')
    .sort((a, b) => {
      const ai = firstAnchor.has(a.id) ? firstAnchor.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = firstAnchor.has(b.id) ? firstAnchor.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.id.localeCompare(b.id) : ai - bi;
    });
}

/**
 * Total beat count, used by the presenter view's progress readout.
 * @param {Sequence} seq
 * @returns {number}
 */
export function beatCount(seq) {
  return seq.scenes.reduce((n, s) => n + Math.max(1, s.beats.length), 0);
}
