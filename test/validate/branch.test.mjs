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
import { runPreflight, autoFixes } from '../../src/validate/index.js';
import { branchCoverage } from '../../src/validate/lane-branch.js';
import { cleanProof, defectProof, scene, copy, NOW } from '../fixtures/validate/defects.mjs';

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
