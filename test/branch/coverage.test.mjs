/**
 * Branch coverage and resolved return targets (§11, §14, §20.6).
 *
 * §11's coverage rule is two sentences: `BRANCH_UNREACHABLE` for a branch with
 * no anchor and no jump-index entry, `BRANCH_NO_RETURN` for a branch whose last
 * scene lacks a resolved return target. §20.6 says the critic will *try to
 * build an orphan* and check that validation catches it, so both orphans are
 * constructed here deliberately rather than hoped for.
 *
 * The strongest test in this file is the last one: the statically resolved
 * return target must equal where the reducer actually lands when a presenter
 * jumps in and comes back out. A static answer that disagrees with the runtime
 * is worse than no answer, because rehearsal would pass and the room would not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck, SPINE } from '../../src/runtime/deck.js';
import { initialState, navigate, beatsOf } from '../../src/runtime/nav.js';
import {
  returnTargetFor, branchCoverage, anchorsOf, primaryAnchor, nestingDepths, branchGraph,
} from '../../src/branch/graph.js';
import { branch, scene, brand } from '../fixtures/make-proof.mjs';
import { defaultEmitOptions } from '../../src/core/contracts.js';
import { contentId } from '../../src/core/ids.js';
import { objectionProof } from '../fixtures/branch/objections.mjs';

/**
 * @param {import('../../src/core/contracts.d.ts').Scene[]} spine
 * @param {import('../../src/core/contracts.d.ts').Branch[]} branches
 * @param {string} label
 */
function deckOf(spine, branches, label) {
  return buildDeck({
    schemaVersion: 1,
    id: contentId('proof', label),
    prospectName: 'Coverage',
    createdAt: '2026-02-01T09:00:00.000Z',
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches,
    emitOptions: defaultEmitOptions(),
  });
}

const deck = buildDeck(objectionProof());

test('a well-formed proof reports no unreachable branches', () => {
  const coverage = branchCoverage(deck);
  assert.deepEqual(coverage.unreachable, []);
  assert.equal(coverage.details.length, 6);
  // bn_replatform is anchored nowhere; the jump index is the only way in, and
  // that is enough for reachability but not for a declared return.
  const replatform = coverage.details.find((d) => d.branchId === 'bn_replatform');
  assert.equal(replatform.anchored, false);
  assert.ok(replatform.searchable);
  assert.deepEqual(coverage.noReturn, ['bn_replatform']);
  assert.deepEqual(replatform.reasons, ['unanchored']);
});

test('BRANCH_UNREACHABLE: a branch with no anchor and no jump entry is reported', () => {
  // The §20.6 orphan, built on purpose: no anchor anywhere, no objection text,
  // no aliases. Nothing in the artifact can reach it.
  const orphan = branch('bn_orphan', '', [scene('sc_orphan_0', 2)], 'anchor', []);
  const reachable = branch('bn_ok', 'A real objection', [scene('sc_ok_0', 2)], 'anchor', []);
  const spine = [scene('sc_c_0', 2), scene('sc_c_1', 2, { branchAnchors: ['bn_ok'] })];
  const coverage = branchCoverage(deckOf(spine, [orphan, reachable], 'orphan-unreachable'));

  assert.deepEqual(coverage.unreachable, ['bn_orphan']);
  const detail = coverage.details.find((d) => d.branchId === 'bn_orphan');
  assert.equal(detail.anchored, false);
  assert.equal(detail.searchable, false);
  assert.ok(detail.reasons.includes('no-anchor-and-no-jump-entry'));
  assert.ok(!coverage.unreachable.includes('bn_ok'));
});

test('whitespace-only objection text does not count as a jump entry', () => {
  const orphan = branch('bn_blank', '   ', [scene('sc_blank_0', 1)], 'anchor', ['  ', '']);
  const coverage = branchCoverage(deckOf([scene('sc_b_0', 1)], [orphan], 'orphan-blank'));
  assert.deepEqual(coverage.unreachable, ['bn_blank']);
});

test('BRANCH_NO_RETURN: a branch whose last scene has no resolved return is reported', () => {
  // Reachable — it has an objection, so the jump index finds it — but it hangs
  // off nothing, so `returnPolicy: 'anchor'` names a scene that does not exist.
  const loose = branch('bn_loose', 'They will ask about procurement', [scene('sc_loose_0', 2)], 'anchor', ['purchasing']);
  const looseDeck = deckOf([scene('sc_n_0', 2)], [loose], 'orphan-no-return');
  const coverage = branchCoverage(looseDeck);

  assert.deepEqual(coverage.noReturn, ['bn_loose']);
  assert.deepEqual(coverage.unreachable, [], 'it is reachable — that is a different finding');
  assert.equal(returnTargetFor(looseDeck, 'bn_loose'), null);
});

test('both orphans are reported at once, and told apart', () => {
  const unreachable = branch('bn_dead', '', [scene('sc_dead_0', 1)], 'anchor', []);
  const noReturn = branch('bn_floating', 'Security will never approve a new vendor', [scene('sc_float_0', 1)], 'anchor', ['infosec']);
  const fine = branch('bn_fine', 'Our approvals process would never allow this', [scene('sc_fine_0', 1)], 'anchor', []);
  const spine = [scene('sc_x_0', 1), scene('sc_x_1', 1, { branchAnchors: ['bn_fine'] })];
  const coverage = branchCoverage(deckOf(spine, [unreachable, noReturn, fine], 'orphan-both'));

  assert.deepEqual(coverage.unreachable, ['bn_dead']);
  assert.deepEqual(coverage.noReturn.slice().sort(), ['bn_dead', 'bn_floating']);
  assert.deepEqual(coverage.details.find((d) => d.branchId === 'bn_fine').reasons, []);
});

test('a branch with no scenes has nothing to return from', () => {
  const empty = branch('bn_empty', 'An objection with no scenes behind it', [], 'anchor', []);
  const spine = [scene('sc_e_0', 1, { branchAnchors: ['bn_empty'] })];
  const coverage = branchCoverage(deckOf(spine, [empty], 'empty-branch'));
  assert.deepEqual(coverage.noReturn, ['bn_empty']);
  assert.ok(coverage.details[0].reasons.includes('no-scenes'));
  assert.deepEqual(coverage.unreachable, [], 'it is anchored, so it is reachable — just empty');
});

test("returnPolicy 'anchor' resolves to the scene that offers the branch", () => {
  assert.deepEqual(returnTargetFor(deck, 'bn_approvals'), { sequenceId: SPINE, sceneIndex: 1 });
  assert.deepEqual(returnTargetFor(deck, 'bn_dam'), { sequenceId: SPINE, sceneIndex: 3 });
});

test("returnPolicy 'anchor' on a nested branch resolves into the parent branch", () => {
  // bn_legal is offered from a scene inside bn_approvals — the §22.4 shape.
  assert.deepEqual(returnTargetFor(deck, 'bn_legal'), { sequenceId: 'bn_approvals', sceneIndex: 0 });
  assert.equal(nestingDepths(deck).get('bn_legal'), 2);
});

test("returnPolicy 'nextSpineScene' resolves to the spine scene after the anchor", () => {
  assert.deepEqual(returnTargetFor(deck, 'bn_scale'), { sequenceId: SPINE, sceneIndex: 3 });
  assert.deepEqual(returnTargetFor(deck, 'bn_brand'), { sequenceId: SPINE, sceneIndex: 5 });
});

test("'nextSpineScene' anchored on the last spine scene holds rather than running off the end", () => {
  const spine = [scene('sc_l_0', 1), scene('sc_l_1', 1)];
  spine[1].branchAnchors = ['bn_tail'];
  const tail = branch('bn_tail', 'One last objection', [scene('sc_tail_0', 1)], 'nextSpineScene', []);
  const tailDeck = deckOf(spine, [tail], 'tail');
  assert.deepEqual(returnTargetFor(tailDeck, 'bn_tail'), { sequenceId: SPINE, sceneIndex: 1 });
});

test("'nextSpineScene' on a nested branch walks the anchor chain up to the spine", () => {
  const inner = scene('sc_p_a0', 1, { branchAnchors: ['bn_child'] });
  const parent = branch('bn_parent', 'The parent objection', [inner], 'anchor', []);
  const child = branch('bn_child', 'The child objection', [scene('sc_p_b0', 1)], 'nextSpineScene', []);
  const spine = [scene('sc_p_0', 1), scene('sc_p_1', 1), scene('sc_p_2', 1)];
  spine[1].branchAnchors = ['bn_parent'];
  const nested = deckOf(spine, [parent, child], 'nested-next');
  assert.deepEqual(returnTargetFor(nested, 'bn_child'), { sequenceId: SPINE, sceneIndex: 2 });
});

test('an anchor cycle resolves to nothing rather than looping', () => {
  const a = branch('bn_cy_a', 'A', [scene('sc_cy_a0', 1, { branchAnchors: ['bn_cy_b'] })], 'nextSpineScene', []);
  const b = branch('bn_cy_b', 'B', [scene('sc_cy_b0', 1, { branchAnchors: ['bn_cy_a'] })], 'nextSpineScene', []);
  const cyclic = deckOf([scene('sc_cy_0', 1)], [a, b], 'cycle');
  assert.equal(returnTargetFor(cyclic, 'bn_cy_a'), null);
  assert.equal(returnTargetFor(cyclic, 'bn_cy_b'), null);
  const coverage = branchCoverage(cyclic);
  assert.deepEqual(coverage.noReturn.slice().sort(), ['bn_cy_a', 'bn_cy_b']);
  assert.ok(coverage.details[0].reasons.includes('anchor-chain-never-reaches-spine'));
  assert.ok(Number.isFinite(nestingDepths(cyclic).get('bn_cy_a')), 'a cycle must not hang the depth walk');
});

test('an empty spine leaves nextSpineScene with nowhere to go', () => {
  const only = branch('bn_only', 'Objection', [scene('sc_only_0', 1)], 'nextSpineScene', []);
  const spineless = deckOf([], [only], 'spineless');
  assert.equal(returnTargetFor(spineless, 'bn_only'), null);
  assert.ok(branchCoverage(spineless).details[0].reasons.includes('unanchored'));
});

test('unknown ids and the spine itself resolve to nothing', () => {
  assert.equal(returnTargetFor(deck, 'bn_nope'), null);
  assert.equal(returnTargetFor(deck, SPINE), null);
});

test('multiple anchors resolve to the first spine anchor, deterministically', () => {
  const spine = [scene('sc_m_0', 1), scene('sc_m_1', 1), scene('sc_m_2', 1)];
  spine[2].branchAnchors = ['bn_multi'];
  spine[1].branchAnchors = ['bn_multi'];
  const host = scene('sc_m_h0', 1, { branchAnchors: ['bn_multi'] });
  const holder = branch('bn_holder', 'Holder', [host], 'anchor', []);
  spine[0].branchAnchors = ['bn_holder'];
  const multi = branch('bn_multi', 'Offered in three places', [scene('sc_multi_0', 1)], 'anchor', []);
  const multiDeck = deckOf(spine, [holder, multi], 'multi-anchor');

  const sites = anchorsOf(multiDeck, 'bn_multi');
  assert.equal(sites.length, 3);
  assert.deepEqual(sites.map((s) => s.onSpine), [true, true, false], 'spine anchors sort ahead of branch anchors');
  assert.equal(primaryAnchor(multiDeck, 'bn_multi').sceneIndex, 1, 'the earliest spine anchor wins');
  assert.deepEqual(returnTargetFor(multiDeck, 'bn_multi'), { sequenceId: SPINE, sceneIndex: 1 });
});

test('the branch graph names every anchor edge and the deepest nesting', () => {
  const graph = branchGraph(deck);
  assert.equal(graph.nodes[0].id, SPINE);
  assert.equal(graph.nodes.length, 7);
  assert.equal(graph.maxNestingDepth, 2);
  const nested = graph.edges.find((e) => e.to === 'bn_legal');
  assert.deepEqual(nested, { from: 'bn_approvals', to: 'bn_legal', sceneId: 'bn_approvals_s0', onSpine: false });
  assert.equal(graph.edges.filter((e) => e.onSpine).length, 4);
});

test('the resolved return target is where the reducer actually lands', () => {
  // Walk the anchor chain down to each branch the way a presenter would, run to
  // its last beat, and press return. Static and dynamic must agree.
  for (const detail of branchCoverage(deck).details) {
    if (!detail.returnTarget) continue;

    /** @type {string[]} */
    const chain = [];
    for (let id = detail.branchId; id;) {
      chain.unshift(id);
      const site = primaryAnchor(deck, id);
      id = site && !site.onSpine ? site.sequenceId : null;
    }
    const entry = primaryAnchor(deck, chain[0]);

    let state = initialState(deck);
    state = navigate(deck, state, { type: 'goToScene', sceneId: entry.sceneId });
    for (const id of chain) {
      const site = primaryAnchor(deck, id);
      state = navigate(deck, state, { type: 'goToScene', sceneId: site.sceneId });
      state = navigate(deck, state, { type: 'jump', branchId: id });
    }
    assert.equal(state.sequenceId, detail.branchId);

    // To the last beat of the last scene of the branch, then out.
    const seq = deck.sequences.get(detail.branchId);
    state = navigate(deck, state, {
      type: 'goToBeat',
      sceneId: seq.scenes[seq.scenes.length - 1].id,
      beatIndex: beatsOf(seq.scenes[seq.scenes.length - 1]) - 1,
    });
    const returned = navigate(deck, state, { type: 'return' });

    assert.equal(returned.sequenceId, detail.returnTarget.sequenceId,
      `${detail.branchId}: the reducer returned to a different sequence than returnTargetFor promised`);
    assert.equal(returned.sceneIndex, detail.returnTarget.sceneIndex,
      `${detail.branchId}: the reducer returned to a different scene than returnTargetFor promised`);
  }
});
