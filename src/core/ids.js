/**
 * Id minting under the determinism law (§5).
 *
 * Two mints, and only two:
 *   - `contentId(kind, payload)` — the id IS a function of the content, so
 *     rebuilding the same object anywhere produces the same id.
 *   - `IdMinter` — a counter over a named PRNG substream, for objects whose
 *     identity is positional rather than content-derived (a beat, a scene slot)
 *     and which must keep their id when their content is edited.
 *
 * `Math.random()` and `Date.now()` appear nowhere in this module and nowhere in
 * any model construction path. `scripts/lint-determinism.mjs` enforces that.
 *
 * @module core/ids
 */

import { Pcg32, SeedBook, DEFAULT_SEED } from './prng.js';
import { shortHash } from './hash.js';

/** Prefixes, one per model kind, so an id is self-describing in a log. */
export const ID_PREFIX = {
  proof: 'pf', brand: 'br', color: 'co', face: 'fa', logo: 'lg',
  specimen: 'sp', block: 'bl', media: 'md', recipe: 'rc', rendition: 'rd',
  scene: 'sc', beat: 'bt', branch: 'bn', finding: 'fd', element: 'el',
  asset: 'as', project: 'pj', command: 'cm',
};

/**
 * Content-derived id. Stable across machines, runs and rebuilds.
 * @param {keyof typeof ID_PREFIX} kind
 * @param {unknown} payload
 * @returns {string}
 */
export function contentId(kind, payload) {
  const prefix = ID_PREFIX[kind];
  if (!prefix) throw new Error(`contentId: unknown kind ${String(kind)}`);
  return `${prefix}_${shortHash({ k: kind, p: payload }, 12)}`;
}

/**
 * Sequential ids over a named PRNG substream. Construct one per subsystem; the
 * sequence it produces depends only on the project seed and the substream name,
 * never on how many ids some other subsystem drew.
 */
export class IdMinter {
  /**
   * @param {bigint|number|string} seed
   * @param {string} [substream]
   */
  constructor(seed = DEFAULT_SEED, substream = 'ids') {
    this.book = seed instanceof SeedBook ? seed : new SeedBook(seed);
    this.substream = substream;
    /** @type {Map<string, Pcg32>} */
    this.gens = new Map();
    /** @type {Map<string, number>} */
    this.counts = new Map();
  }

  /**
   * Mint the next id for a kind.
   * @param {keyof typeof ID_PREFIX} kind
   * @returns {string}
   */
  next(kind) {
    const prefix = ID_PREFIX[kind];
    if (!prefix) throw new Error(`IdMinter.next: unknown kind ${String(kind)}`);
    let g = this.gens.get(kind);
    if (!g) { g = this.book.fresh(`${this.substream}/${kind}`); this.gens.set(kind, g); }
    this.counts.set(kind, (this.counts.get(kind) || 0) + 1);
    const a = g.nextU32().toString(16).padStart(8, '0');
    const b = (g.nextU32() >>> 16).toString(16).padStart(4, '0');
    return `${prefix}_${a}${b}`;
  }

  /** Reset every kind's sequence. Used by tests and by project reload. */
  reset() {
    this.gens.clear();
    this.counts.clear();
  }
}

/**
 * A deterministic element id for a node inside a rendered scene. Beats reveal
 * element ids (§4 `Beat.reveals`), so those ids must be stable between the
 * studio preview, the automated sweep and the emitted artifact.
 * @param {string} sceneId
 * @param {string} path  a stable structural path, e.g. "before/block/3"
 * @returns {string}
 */
export function elementId(sceneId, path) {
  return `el_${shortHash({ s: sceneId, p: path }, 10)}`;
}

/**
 * True when a string looks like an id this module could have minted. Used by
 * validation to catch hand-written ids that would break determinism.
 * @param {string} id
 * @returns {boolean}
 */
export function isMintedId(id) {
  return typeof id === 'string' && /^(pf|br|co|fa|lg|sp|bl|md|rc|rd|sc|bt|bn|fd|el|as|pj|cm)_[0-9a-f]{10,12}$/.test(id);
}
