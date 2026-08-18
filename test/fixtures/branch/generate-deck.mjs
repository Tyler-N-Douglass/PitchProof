/**
 * A seeded generator for branchy decks, for the §17.8 property test.
 *
 * The corpus has to be varied or the property test only proves the reducer
 * works on the one shape someone happened to write down: so spine length, beat
 * counts, branch count, branch depth, return policies and anchoring are all
 * drawn from the seed, and every deck deliberately contains the three shapes
 * §22.4 is about — a branch anchored off the spine, a branch anchored from
 * inside another branch, and a branch anchored nowhere that only the jump index
 * can reach.
 *
 * Anchors only ever point *backwards* (branch n may be anchored from a scene in
 * branch m < n), which keeps the anchor graph acyclic and makes the available
 * nesting depth a computable number the test can assert the stack against.
 */

import { SeedBook } from '../../../src/core/prng.js';
import { contentId } from '../../../src/core/ids.js';
import { defaultEmitOptions } from '../../../src/core/contracts.js';
import { scene, branch, brand } from '../make-proof.mjs';
import { OBJECTION_POOL } from './objections.mjs';

/**
 * @param {string|number|bigint} seed
 * @param {{spineRange?: [number, number], branchRange?: [number, number]}} [options]
 * @returns {{proof: import('../../../src/core/contracts.d.ts').Proof, shape: object}}
 */
export function generateBranchyProof(seed, options = {}) {
  const rng = new SeedBook(seed).stream('test/branch/corpus');
  const [spineLo, spineHi] = options.spineRange || [3, 9];
  const [branchLo, branchHi] = options.branchRange || [3, 10];

  const spineCount = spineLo + rng.nextInt(spineHi - spineLo + 1);
  const spine = Array.from({ length: spineCount }, (_, i) => scene(`sc_sp${i}`, 1 + rng.nextInt(4)));

  const branchCount = branchLo + rng.nextInt(branchHi - branchLo + 1);
  /** @type {import('../../../src/core/contracts.d.ts').Branch[]} */
  const branches = [];
  const shape = { spineCount, branchCount, spineAnchored: 0, nested: 0, unanchored: 0, emptyText: 0 };

  for (let i = 0; i < branchCount; i++) {
    const sceneCount = 1 + rng.nextInt(3);
    const scenes = Array.from({ length: sceneCount }, (_, k) => scene(`sc_b${i}_${k}`, 1 + rng.nextInt(3)));
    const source = OBJECTION_POOL[rng.nextInt(OBJECTION_POOL.length)];
    const policy = rng.nextInt(2) === 0 ? 'anchor' : 'nextSpineScene';

    // One branch in eight carries no objection text at all: unreachable when it
    // is also unanchored, which is exactly the orphan §11 wants raised.
    const silent = rng.nextInt(8) === 0;
    if (silent) shape.emptyText++;
    const aliasCount = rng.nextInt(source.aliases.length + 1);

    branches.push(branch(
      `bn_g${i}`,
      silent ? '' : `${source.objection} [${i}]`,
      scenes,
      policy,
      silent ? [] : source.aliases.slice(0, aliasCount),
    ));
  }

  // Anchoring pass. Earlier branches are eligible parents, so the graph is a
  // DAG and `nestingDepths` has an exact answer.
  branches.forEach((b, i) => {
    const roll = rng.nextInt(100);
    if (roll < 55 || i === 0) {
      spine[rng.nextInt(spineCount)].branchAnchors.push(b.id);
      shape.spineAnchored++;
      return;
    }
    if (roll < 85) {
      const parent = branches[rng.nextInt(i)];
      parent.scenes[rng.nextInt(parent.scenes.length)].branchAnchors.push(b.id);
      shape.nested++;
      return;
    }
    shape.unanchored++;
  });

  const proof = {
    schemaVersion: 1,
    id: contentId('proof', `generated-${seed}`),
    prospectName: 'Generated Corp',
    createdAt: '2026-02-01T09:00:00.000Z',
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches,
    emitOptions: defaultEmitOptions(),
  };

  return { proof, shape };
}
