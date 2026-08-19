/**
 * §11's coverage rule and §20 axis 6 — "critic attempts to construct an orphan
 * and confirms validation catches it".
 *
 * This file is that attempt, written in advance and from several directions:
 * a branch with no anchor and no objection, a branch with an anchor but an
 * unresolvable return, a branch nested inside another, a branch with no scenes
 * at all, and a proof with no spine to return to. Each one is a way a presenter
 * gets stranded off-spine mid-pitch, which §22.4 names as one of the six things
 * most likely to go wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck } from '../../src/runtime/deck.js';
import { runPreflight, autoFixes, ruleFor } from '../../src/validate/index.js';
import { branchCoverage } from '../../src/validate/lane-branch.js';
import { branchShipCost } from '../../src/validate/rules.js';
import { sweepScenes } from '../../src/validate/preflight.js';
import { summarize } from '../../src/validate/index.js';
import {
  cleanProof, defectProof, scene, copy, withRenderedReveals, NOW,
} from '../fixtures/validate/defects.mjs';

const preflight = (proof, options = {}) => runPreflight(proof, { clock: () => NOW, ...options });

/** @param {any} proof @param {string} id @param {object} spec */
function addBranch(proof, id, spec) {
  proof.branches.push({
    id,
    objection: spec.objection ?? `Objection ${id}`,
    aliases: spec.aliases ?? [],
    scenes: spec.scenes ?? [scene(`${id}_s0`, 1, { headline: `Answer ${id}` })],
    returnPolicy: spec.returnPolicy ?? 'anchor',
  });
  if (spec.anchorAt !== undefined) proof.spine[spec.anchorAt].branchAnchors.push(id);
  return proof;
}

/** The two fields `API.md` declares. L9 carries extra diagnostics beyond them. */
const declaredCoverage = (deck) => {
  const c = branchCoverage(deck);
  return { unreachable: c.unreachable, noReturn: c.noReturn };
};

test('a well-formed deck has no coverage findings', async () => {
  assert.deepEqual(declaredCoverage(buildDeck(cleanProof())), { unreachable: [], noReturn: [] });
  const findings = await preflight(cleanProof());
  assert.deepEqual(findings.filter((f) => f.code.startsWith('BRANCH_')), []);
});

test('an orphan branch — no anchor, no jump-index entry — is caught', async () => {
  // L9 reports an orphan as both unreachable and unreturnable: with no anchor
  // and no way in, there is no position for a return to resolve against either.
  const findings = await preflight(defectProof('BRANCH_UNREACHABLE'));
  const finding = findings.find((f) => f.code === 'BRANCH_UNREACHABLE');
  assert.ok(finding, 'the orphan was not caught');
  assert.equal(finding.locus.branchId, 'bn_orphan');
  assert.equal(finding.severity, 2);
  assert.match(finding.message, /no anchoring scene and no jump-index entry/);
  assert.equal(finding.autoFixAvailable, true);
});

test('a branch reachable only through the jump index is not an orphan', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_searchonly', { objection: 'What about our review chain?', aliases: ['review'] });
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'BRANCH_UNREACHABLE'), []);
});

test('a branch reachable only through an anchor is not an orphan either', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_anchoronly', { objection: '', aliases: [], anchorAt: 0 });
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'BRANCH_UNREACHABLE'), []);
});

test('an unanchored branch warns rather than blocks — nobody is stranded', async () => {
  const findings = await preflight(defectProof('BRANCH_NO_RETURN'));
  const finding = findings.find((f) => f.code === 'BRANCH_NO_RETURN');
  assert.ok(finding);
  assert.equal(finding.locus.branchId, 'bn_deadend');
  assert.deepEqual(finding.detail.reasons, ['unanchored']);
  assert.equal(finding.severity, 2, 'a jump still reaches it and still returns; the declaration is what is missing');
  assert.match(finding.message, /never says where it belongs/);
  assert.equal(finding.autoFixAvailable, true);
});

test('an anchor chain that never reaches the spine strands the presenter, and blocks', async () => {
  const proof = copy(cleanProof());
  // bn_inner is offered only from a scene inside bn_outer, and bn_outer itself
  // is anchored nowhere. Following "next spine scene" out of bn_inner therefore
  // walks a chain that never arrives at the spine.
  addBranch(proof, 'bn_outer', { objection: 'The outer objection', scenes: [scene('sc_outer0', 1)] });
  proof.branches.find((b) => b.id === 'bn_outer').scenes[0].branchAnchors = ['bn_inner'];
  addBranch(proof, 'bn_inner', { objection: 'The inner objection', returnPolicy: 'nextSpineScene' });

  const findings = await preflight(proof);
  const inner = findings.find((f) => f.code === 'BRANCH_NO_RETURN' && f.locus.branchId === 'bn_inner');
  assert.ok(inner, 'the unreachable chain must be caught');
  assert.equal(inner.severity, 1, 'stranding the presenter mid-pitch blocks emit');
  assert.match(inner.message, /stranded/);
  assert.deepEqual(inner.detail.reasons, ['anchor-chain-never-reaches-spine']);

  const fixes = autoFixes(proof, findings).filter((f) => f.finding.id === inner.id);
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].label, /to its anchor/);
  const fixed = fixes[0].apply(proof);
  const after = await preflight(fixed);
  assert.deepEqual(after.filter((f) => f.code === 'BRANCH_NO_RETURN' && f.locus.branchId === 'bn_inner'), []);
});

test('a branch with no scenes at all has nowhere to return from', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_hollow', { scenes: [], returnPolicy: 'nextSpineScene', anchorAt: 0 });
  const findings = await preflight(proof);
  const finding = findings.find((f) => f.code === 'BRANCH_NO_RETURN' && f.locus.branchId === 'bn_hollow');
  assert.ok(finding);
  assert.match(finding.message, /no scenes at all/);
  assert.equal(finding.autoFixAvailable, false, 'no fix invents scenes');
});

test('a proof with no spine leaves every branch with nothing to return to', async () => {
  const proof = copy(cleanProof());
  proof.spine = [];
  proof.branches[0].returnPolicy = 'nextSpineScene';
  const findings = await preflight(proof);
  const finding = findings.find((f) => f.code === 'BRANCH_NO_RETURN');
  assert.ok(finding, 'a branch hanging off an empty spine must be reported');
  assert.equal(finding.detail.spineLength, 0);
  assert.equal(finding.autoFixAvailable, false, 'no fix invents a spine');
});

test('a branch nested inside another branch resolves its return through its anchor', async () => {
  const proof = copy(cleanProof());
  // bn_legal is offered from a scene that lives inside bn_approvals.
  proof.branches[0].scenes[0].branchAnchors = ['bn_legal'];
  proof.branches.push({
    id: 'bn_legal',
    objection: 'Legal has to see every claim',
    aliases: ['claims'],
    scenes: [scene('sc_legal0', 1, { headline: 'Claim rules' })],
    returnPolicy: 'anchor',
  });
  assert.deepEqual(declaredCoverage(buildDeck(proof)), { unreachable: [], noReturn: [] }, 'a nested branch anchored off-spine still resolves');
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code.startsWith('BRANCH_')), []);
});

test('the auto-fix for an unanchored branch anchors it, and the finding clears', async () => {
  const proof = defectProof('BRANCH_NO_RETURN');
  const findings = await preflight(proof);
  const fixes = autoFixes(proof, findings).filter((f) => f.finding.code === 'BRANCH_NO_RETURN');
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].label, /Anchor branch/);
  const fixed = fixes[0].apply(proof);
  assert.deepEqual(declaredCoverage(buildDeck(fixed)).noReturn, []);
  const after = await preflight(fixed);
  assert.deepEqual(after.filter((f) => f.code === 'BRANCH_NO_RETURN'), []);
  // Purity: the proof handed in is untouched.
  assert.deepEqual(proof.spine[0].branchAnchors, []);
});

test('the auto-fix for an orphan branch makes it reachable', async () => {
  const proof = defectProof('BRANCH_UNREACHABLE');
  const findings = await preflight(proof);
  const fixes = autoFixes(proof, findings).filter((f) => f.finding.code === 'BRANCH_UNREACHABLE');
  assert.equal(fixes.length, 1);
  const fixed = fixes[0].apply(proof);
  assert.deepEqual(declaredCoverage(buildDeck(fixed)).unreachable, []);
  assert.deepEqual(proof.spine[0].branchAnchors, [], 'the original proof is untouched');
});

test('coverage is computed over the deck, so a branch id that is not in the deck is not invented', () => {
  const proof = copy(cleanProof());
  proof.spine[0].branchAnchors.push('bn_does_not_exist');
  assert.deepEqual(declaredCoverage(buildDeck(proof)), { unreachable: [], noReturn: [] });
});

test('branch coverage findings are ordered and deterministic', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_z_orphan', { objection: '', aliases: [] });
  addBranch(proof, 'bn_a_orphan', { objection: '', aliases: [] });
  addBranch(proof, 'bn_m_dead', { objection: 'Middle', returnPolicy: 'anchor' });
  const first = await preflight(proof);
  const second = await preflight(copy(proof));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const orphans = first.filter((f) => f.code === 'BRANCH_UNREACHABLE').map((f) => f.locus.branchId);
  assert.deepEqual(orphans, ['bn_a_orphan', 'bn_z_orphan'], 'ordering is by locus, not by declaration');
});

// ---------------------------------------------------------------------------
// The other end of the orphan edge, and what an orphan costs
// ---------------------------------------------------------------------------

/**
 * The regression for F20. `branchCoverage` reports branches no scene anchors;
 * nothing reported the mirror image — a scene anchoring a branch that is not in
 * the proof — and the critic drove it through and got silence at every severity.
 *
 * The deck filters an anchor that names nothing, so the artifact offers no key
 * for it and nobody is stranded; what is wrong is that the model says this scene
 * offers a branch and the studio counts it. Severity 2, and reported (L11-D22).
 *
 * **The code is `BRANCH_UNREACHABLE`, and that is CRITIQUE-2's C10** (L11-D25).
 * It was `ASSET_MISSING`, on the reading that this is a scene reference with
 * nothing behind it — true, but it puts a branch-graph failure in the bucket a
 * caller filters to find missing media. A code is the question a consumer asks;
 * the question this answers is "what is wrong with my branch graph?".
 */
test('a scene anchoring a branch that does not exist is reported as a branch failure', async () => {
  const proof = copy(cleanProof());
  proof.spine[0].branchAnchors = ['bn_ghost'];

  // The premise: the deck drops it, so no other rule has anything to say.
  const deck = buildDeck(proof);
  assert.deepEqual(deck.anchorsByScene.get(proof.spine[0].id), [], 'the deck filters an anchor that names nothing');
  assert.deepEqual(declaredCoverage(deck), { unreachable: [], noReturn: [] });

  const findings = await preflight(proof);
  assert.equal(findings.length, 1, 'exactly one rule should have something to say about a ghost anchor');
  const finding = findings[0];
  assert.equal(finding.code, 'BRANCH_UNREACHABLE', 'branch topology belongs in the branch bucket (C10)');
  assert.deepEqual(
    findings.filter((f) => f.code === 'ASSET_MISSING'), [],
    'a caller filtering ASSET_MISSING for missing media must not be handed the branch graph',
  );
  assert.equal(finding.severity, 2, 'the deck drops it, so nothing breaks in front of the room');
  assert.equal(finding.locus.sceneId, proof.spine[0].id);
  assert.equal(finding.locus.branchId, 'bn_ghost', 'the locus names the branch that is not there');
  assert.equal(finding.detail.kind, 'branch-anchor');
  assert.equal(finding.detail.inBranchId, null, 'the anchor is on a spine scene');
  assert.match(finding.message, /bn_ghost/);
  assert.match(finding.message, /not in the proof/);
  assert.equal(finding.autoFixAvailable, false, 'a fix may not choose between deleting the anchor and restoring the branch');
  assert.deepEqual(autoFixes(proof, findings), [], 'and nothing offers one anyway');
});

test('the unreachable-branch auto-fix refuses to anchor an id no branch carries', async () => {
  const proof = copy(cleanProof());
  proof.spine[0].branchAnchors = ['bn_ghost'];
  const findings = await preflight(proof);
  // Force the flag on: the fixer itself must hold the invariant, not just the
  // rule that declines to advertise a fix. Anchoring a ghost would add a second
  // dangling anchor and leave the finding standing.
  const forced = findings.map((f) => ({ ...f, autoFixAvailable: true }));
  assert.deepEqual(autoFixes(proof, forced), []);
});

test('a ghost anchor is reported once per scene that names it, and never for a real branch', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_real', { anchorAt: 0 });
  proof.spine[0].branchAnchors.push('bn_ghost');
  proof.spine[1].branchAnchors = ['bn_ghost', 'bn_real'];
  const ghosts = (await preflight(proof))
    .filter((f) => f.code === 'BRANCH_UNREACHABLE' && f.detail.kind === 'branch-anchor');
  assert.deepEqual(
    ghosts.map((f) => f.locus.sceneId).sort(),
    [proof.spine[0].id, proof.spine[1].id].sort(),
  );
  assert.ok(ghosts.every((f) => f.locus.branchId === 'bn_ghost'));
});

test('a ghost anchor inside a branch names the branch it sits in', async () => {
  const proof = copy(cleanProof());
  proof.branches[0].scenes[0].branchAnchors = ['bn_ghost'];
  const ghost = (await preflight(proof)).find((f) => f.detail && f.detail.kind === 'branch-anchor');
  assert.ok(ghost);
  assert.equal(ghost.locus.sceneId, proof.branches[0].scenes[0].id);
  assert.equal(ghost.locus.branchId, 'bn_ghost');
  assert.equal(ghost.detail.inBranchId, 'bn_approvals');
});

/**
 * The regression for F21. `BRANCH_UNREACHABLE` stays severity 2 — a branch with
 * no way in is a tidiness problem, not a deck that strands anyone, and §14
 * reserves the unoverridable refusal for real harms. What was missing is that
 * its scenes ship regardless, at a cost the seller was never shown (L11-D23).
 */
test('BRANCH_UNREACHABLE says the branch ships anyway and what it costs', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_orphan', {
    objection: '',
    scenes: [
      scene('bn_orphan_s0', 1, { headline: 'Answer one' }),
      scene('bn_orphan_s1', 1, { headline: 'Answer two' }),
    ],
  });
  const finding = (await preflight(proof)).find((f) => f.code === 'BRANCH_UNREACHABLE');
  assert.ok(finding);
  assert.equal(finding.severity, 2, 'non-blocking is the call; silence about the cost was not');
  assert.equal(finding.detail.sceneCount, 2);
  assert.ok(finding.detail.shippedBytes > 0, 'the finding must quote a cost, not just a scene count');
  assert.match(finding.message, /2 scenes ship in the artifact anyway/);
  assert.match(finding.message, /against the byte budget/);
  assert.match(finding.message, /delete it/, 'the seller needs the option that actually removes the weight');
  assert.equal(finding.autoFixAvailable, true, 'and the option that keeps it, applied for them');
});

test('an unreachable branch with no scenes is not billed for weight it does not carry', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_hollow', { objection: '', scenes: [] });
  const finding = (await preflight(proof)).find((f) => f.code === 'BRANCH_UNREACHABLE');
  assert.ok(finding);
  assert.equal(finding.detail.shippedBytes, 0);
  assert.match(finding.message, /costs the artifact nothing/);
});

test('branchShipCost counts media only the unreachable branch shows', async () => {
  const proof = copy(cleanProof());
  const shared = proof.spine[0];
  addBranch(proof, 'bn_orphan', {
    objection: '',
    scenes: [{ ...copy(shared), id: 'bn_orphan_s0', branchAnchors: [] }],
  });
  const cost = branchShipCost(proof, proof.branches.find((b) => b.id === 'bn_orphan'));
  assert.equal(cost.sceneCount, 1);
  assert.deepEqual(cost.exclusiveSources, [], 'the branch shows the spine\'s own specimen — removing it recovers no media');
  assert.equal(cost.mediaBytes, 0);
  assert.ok(cost.modelBytes > 0);
});

// ---------------------------------------------------------------------------
// Two branches, one id — CRITIQUE-2's C5
// ---------------------------------------------------------------------------

/**
 * `buildDeck` keys its sequences by `Branch.id`, and a `Map` keeps one value per
 * key. Two branches sharing an id therefore lose one of them silently: it is in
 * the file, it is in the studio's branch list, and it is in no deck. Nothing
 * reported it — the seller was told instead that a scene anchored a branch "not
 * in the proof", naming an id they could see in front of them.
 *
 * Reported as `DUPLICATE_SCENE` at severity 1 (L11-D26): §4's only
 * duplicate-identity code, the same defect one namespace up, and the same
 * consequence the scene case blocks for — a key that opens the wrong thing.
 */

/** Add a second branch under an existing branch's id, with scenes of its own. */
function duplicateBranchProof() {
  const proof = copy(cleanProof());
  proof.branches.push({
    id: 'bn_approvals',
    objection: 'Procurement will want three quotes',
    aliases: ['quotes'],
    scenes: [scene('sc_quotes0', 2, { headline: 'Three quotes' })],
    returnPolicy: 'anchor',
  });
  return withRenderedReveals(proof);
}

test('two branches claiming one id is a blocking finding, not a silent overwrite', async () => {
  const proof = duplicateBranchProof();

  // The defect itself, asserted against the deck so this test fails loudly if
  // L2 ever changes what it does with the collision — which is what it did:
  // `buildDeck` now keeps the **first** occurrence, the policy it already
  // applied to scene ids, and records the casualty on `Deck.duplicateBranchIds`
  // (API.md Part 3b). Which branch is lost changed; that one is lost did not.
  const deck = buildDeck(proof);
  assert.equal(deck.sequences.get('bn_approvals').scenes[0].id, 'sc_ap0',
    'the first declaration keeps the id');
  assert.equal(deck.sceneById.has('sc_quotes0'), false,
    'and the later branch is in the proof but in no deck — one authored branch, gone');
  assert.deepEqual(deck.duplicateBranchIds, ['bn_approvals'],
    'and the deck says so, rather than dropping a sequence in silence');
  assert.deepEqual(declaredCoverage(deck), { unreachable: [], noReturn: [] },
    'coverage walks the deck, so it cannot see the branch that is missing from it');

  const findings = await preflight(proof);
  const dup = findings.find((f) => f.code === 'DUPLICATE_SCENE');
  assert.ok(dup, 'a branch that disappears from the deck must not be silent');
  assert.equal(dup.severity, 1, 'a key that opens the wrong branch in front of a client blocks the emit');
  assert.equal(summarize(findings).canEmit, false);
  assert.equal(dup.locus.branchId, 'bn_approvals');
  assert.equal(dup.detail.kind, 'branch-id');
  assert.equal(dup.detail.occurrences, 2);
  assert.deepEqual(dup.detail.objections, [
    'Our approvals process would never allow this',
    'Procurement will want three quotes',
  ]);
  assert.deepEqual(dup.detail.sceneIds, [['sc_ap0'], ['sc_quotes0']]);
  assert.match(dup.message, /claimed by 2 branches/);
  assert.match(dup.message, /Our approvals process would never allow this/);
  assert.match(dup.message, /the client sees the other answer/);
  assert.equal(dup.detail.droppedByDeck, true);
  assert.match(dup.message, /already dropped|dropped a sequence for this id/,
    'with a deck in hand the finding reports the loss as observed, not predicted');
  assert.equal(dup.autoFixAvailable, false, 'which branch to rename is the seller\'s call');

  // The old symptom is gone: the anchor names an id that is in the proof, so
  // nothing tells the seller to go looking for a branch sitting in front of them.
  assert.deepEqual(findings.filter((f) => f.detail && f.detail.kind === 'branch-anchor'), []);
});

test('the id collision is found in the model, not in the deck that already lost it', async () => {
  // Both orders, because a Map keeps the last write: whichever branch survives,
  // the finding is the same one and names the same id.
  const first = await preflight(duplicateBranchProof());
  const swapped = duplicateBranchProof();
  swapped.branches.reverse();
  const second = await preflight(swapped);
  const ids = (fs) => fs.filter((f) => f.code === 'DUPLICATE_SCENE').map((f) => f.locus.branchId);
  assert.deepEqual(ids(first), ['bn_approvals']);
  assert.deepEqual(ids(second), ['bn_approvals']);
  // Determinism: the same proof twice is the same finding list, byte for byte.
  assert.equal(JSON.stringify(first), JSON.stringify(await preflight(duplicateBranchProof())));
});

test('the collision is a fact about the proof, so the rule finds it with no deck at all', () => {
  // `Deck.duplicateBranchIds` is read when it is there and depended on never:
  // the rule derives the collision from `proof.branches`, so it cannot be
  // silenced by a deck that fails to report one, and it still fires for a caller
  // that runs the rule without building a deck.
  const proof = duplicateBranchProof();
  const findings = ruleFor('DUPLICATE_SCENE').run({ proof });
  const dup = findings.find((f) => f.detail.kind === 'branch-id');
  assert.ok(dup, 'no deck, and the duplicate is still found');
  assert.equal(dup.severity, 1);
  assert.equal(dup.detail.droppedByDeck, false);
  assert.doesNotMatch(dup.message, /dropped a sequence/,
    'and nothing is claimed about a deck that was never built');

  // A deck that reported nothing does not soften it either.
  const silent = { ...buildDeck(proof), duplicateBranchIds: [] };
  const again = ruleFor('DUPLICATE_SCENE').run({ proof, deck: silent });
  assert.ok(again.some((f) => f.detail.kind === 'branch-id' && f.severity === 1));
});

test('three branches under one id are reported once, and counted', async () => {
  const proof = duplicateBranchProof();
  proof.branches.push({
    id: 'bn_approvals',
    objection: 'Legal has to see every claim',
    aliases: [],
    scenes: [scene('sc_legal0', 1, { headline: 'Claim rules' })],
    returnPolicy: 'anchor',
  });
  withRenderedReveals(proof);
  const dups = (await preflight(proof)).filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.equal(dups.length, 1, 'one id, one finding');
  assert.equal(dups[0].detail.occurrences, 3);
  assert.match(dups[0].message, /claimed by 3 branches/);
});

test('the sweep still measures the scenes of the branch the deck dropped', async () => {
  const proof = duplicateBranchProof();
  const deck = buildDeck(proof);
  // Whichever branch the deck's collision policy drops is the one this has to
  // hold for, so the casualty is read off the deck rather than assumed.
  const lost = proof.branches.find((b) => !(b.scenes || []).every((sc) => deck.sceneById.has(sc.id)));
  assert.ok(lost, 'the premise of this test is that a branch left the deck');
  const lostSceneId = lost.scenes[0].id;
  assert.equal(lostSceneId, 'sc_quotes0');

  // Every scene the model declares is walked, deck or no deck. Otherwise the
  // sweep reports "nothing else is wrong" about scenes it never looked at.
  assert.ok(sweepScenes(proof, deck).some((s) => s.id === lostSceneId),
    'the shadowed branch\'s scene must still be walked');

  // Drive it end to end: a defect planted in the shadowed scene must still be
  // reported. Before C5 was fixed this scene was invisible to every rule that
  // reads the deck, so preflight was silent about all of it.
  lost.scenes[0].beats[lost.scenes[0].beats.length - 1].reveals = ['el_planted_nothing_reveals_this'];
  const findings = await preflight(proof);
  const beat = findings.find((f) => f.code === 'BEAT_EMPTY' && f.locus.sceneId === lostSceneId);
  assert.ok(beat, 'a defect inside the shadowed branch must still be found');
  assert.ok(findings.some((f) => f.code === 'DUPLICATE_SCENE'), 'and the collision is still reported');
});

test('a branch that claims the deck\'s own spine id cannot be a sequence, and is refused', async () => {
  const proof = copy(cleanProof());
  proof.branches.push({
    id: 'spine',
    objection: 'Can we see this on a pilot first?',
    aliases: ['pilot'],
    scenes: [scene('sc_pilot0', 1, { headline: 'Pilot scope' })],
    returnPolicy: 'anchor',
  });
  withRenderedReveals(proof);

  // The spine now survives the collision — `buildDeck` keeps the first
  // occupant of an id and the spine is set before any branch — and the impostor
  // is dropped and recorded. Either way one authored sequence is missing from
  // the artifact, which is what the finding is about.
  const deck = buildDeck(proof);
  assert.deepEqual(deck.sequences.get('spine').scenes.map((s) => s.id), proof.spine.map((s) => s.id),
    'the spine keeps the id the deck reserves for it');
  assert.equal(deck.sceneById.has('sc_pilot0'), false, 'and the branch that claimed it is in no deck');
  assert.deepEqual(deck.duplicateBranchIds, ['spine']);

  const findings = await preflight(proof);
  const dup = findings.find((f) => f.code === 'DUPLICATE_SCENE');
  assert.ok(dup, 'a branch that collides with the spine must not be silent');
  assert.equal(dup.severity, 1);
  assert.equal(dup.detail.kind, 'spine-collision');
  assert.equal(dup.detail.droppedByDeck, true);
  assert.equal(dup.locus.branchId, 'spine');
  assert.match(dup.message, /reserves for the spine itself/);
  assert.match(dup.message, /missing from the artifact/);
  assert.equal(summarize(findings).canEmit, false);
});

test('distinct branch ids raise nothing, and the control proof stays clean', async () => {
  const proof = copy(cleanProof());
  addBranch(proof, 'bn_second', { objection: 'What does this cost to run?', anchorAt: 2 });
  withRenderedReveals(proof);
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'DUPLICATE_SCENE'), []);
  assert.deepEqual((await preflight(cleanProof())).filter((f) => f.code === 'DUPLICATE_SCENE'), []);
});
