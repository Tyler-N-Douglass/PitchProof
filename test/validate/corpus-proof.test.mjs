/**
 * Preflight, graded against a proof built out of the corpus.
 *
 * The §20 critic's leverage sentence: *"Every severity-1 finding in this report
 * was reachable from a proof built out of the corpus, and none was reachable
 * from `makeProof()`."* A hand-written fixture agrees with whatever the lane
 * that wrote it believed; it cannot disagree, so it cannot find anything.
 *
 * `test/fixtures/corpus/proof.mjs` builds a §4 `Proof` from four hostile pages
 * and two binary documents, through the published surfaces of L3–L9 and nothing
 * else. What preflight says about *that* is a measurement of the sweep against
 * real client copy in real layouts, and it is the half §17.4's planted corpus
 * cannot supply: the planted corpus proves the detector finds what was put
 * there, and this proves it does not invent things that were not.
 *
 * The assertions here are **properties, not counts**. The corpus fixture is
 * still being tuned (scene chunking, in particular), and a test that pinned the
 * number of findings would break on every improvement to it while telling
 * nobody anything. What must hold regardless is that a proof assembled entirely
 * through the declared surfaces can be presented and emitted.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllLayouts } from '../../src/scene/index.js';
import { stableStringify } from '../../src/core/hash.js';
import { buildCorpusProof } from '../fixtures/corpus/proof.mjs';
import {
  runPreflight, summarize, autoFixes, dryRun, blockingFindings,
} from '../../src/validate/index.js';

/** Built once: the pipeline behind it runs six captures through six lanes. */
let proof = null;
/** @type {any[]} */
let findings = [];

before(async () => {
  registerAllLayouts();
  proof = await buildCorpusProof();
  findings = await runPreflight(proof, { clock: () => proof.createdAt });
});

test('a proof built entirely through the published lane surfaces can be emitted', () => {
  const summary = summarize(findings);
  const blocking = blockingFindings(findings);

  // Printed rather than asserted: the shape of what real content produces is
  // the thing a regression shows up in, and it should be legible in the log.
  /** @type {Record<string, number>} */
  const byCode = {};
  /** @type {Record<string, number>} */
  const shape = {};
  for (const f of findings) {
    byCode[`${f.code}/sev${f.severity}`] = (byCode[`${f.code}/sev${f.severity}`] || 0) + 1;
    if (f.code !== 'TEXT_OVERFLOW') continue;
    const k = `${f.detail.breakpoint} ${f.detail.axis} ${f.detail.role} ${f.detail.textOverflow}`;
    shape[k] = (shape[k] || 0) + 1;
  }
  console.log([
    '',
    `corpus proof — ${proof.spine.length} spine scenes, ${proof.branches.length} branches, `
      + `${proof.specimens.length} specimens, ${proof.renditions.length} renditions`,
    `  ${summary.total} findings: ${summary.blocking} blocking, ${summary.warnings} warnings, ${summary.notes} notes`,
    ...Object.entries(byCode).sort().map(([k, n]) => `    ${String(n).padStart(3)}x ${k}`),
    '  text overflow, by breakpoint / axis / role / truncation:',
    ...Object.entries(shape).sort().map(([k, n]) => `    ${String(n).padStart(3)}x ${k}`),
    '',
  ].join('\n'));

  assert.deepEqual(
    blocking.map((f) => `${f.code} @ ${JSON.stringify(f.locus)}: ${f.message}`),
    [],
    'real client content assembled by the real layouts must not refuse its own emit',
  );
  assert.equal(summary.canEmit, true);
});

test('every text box the layouts measure declares how it truncates', () => {
  // The §22.2 grading turns on this field. A box that does not declare it is
  // graded as clipping, which is right but conservative — and on production
  // layouts it should never happen.
  const undeclared = findings.filter(
    (f) => f.code === 'TEXT_OVERFLOW' && f.detail.textOverflowDeclared !== true,
  );
  assert.deepEqual(
    undeclared.map((f) => `${f.detail.role} @ ${f.detail.breakpoint}`),
    [],
    'a production layout must say whether it clips or ellipsises',
  );
});

test('every overflow finding on real content says something a seller can act on', () => {
  const overflow = findings.filter((f) => f.code === 'TEXT_OVERFLOW');
  assert.ok(overflow.length > 0, 'real copy in real layouts must exercise the detector at all');
  const sceneIds = new Set();
  for (const scene of proof.spine) sceneIds.add(scene.id);
  for (const branch of proof.branches) for (const scene of branch.scenes) sceneIds.add(scene.id);

  for (const f of overflow) {
    assert.ok(sceneIds.has(f.locus.sceneId), `${f.id} names a scene the proof does not contain`);
    assert.ok(['sm', 'md', 'lg'].includes(f.detail.breakpoint));
    assert.ok(['width', 'height', 'clamp'].includes(f.detail.axis));
    assert.ok(f.message.length > 80);
    assert.match(f.message, /\d/);
    if (f.detail.axis === 'clamp') {
      assert.ok(f.detail.lostLines > 0, 'a clamp finding must say how much was lost');
      assert.ok(String(f.detail.truncated).trim().length > 0, 'and must quote what was lost');
      assert.ok(f.detail.suggestedMaxChars >= 0);
    } else {
      assert.ok(f.detail.excessPx > 0);
      assert.ok(f.detail.extentPx > 0);
    }
  }
});

test('the sweep over the corpus proof is deterministic', async () => {
  const again = await runPreflight(proof, { clock: () => proof.createdAt });
  assert.equal(stableStringify(again), stableStringify(findings));

  // And from a second, independently built proof — so the determinism is the
  // pipeline's and the sweep's together, not a memoised object's.
  const rebuilt = await buildCorpusProof();
  const rebuiltFindings = await runPreflight(rebuilt, { clock: () => rebuilt.createdAt });
  assert.deepEqual(rebuiltFindings.map((f) => f.id), findings.map((f) => f.id));
});

test('every auto-fix offered on real content is pure and lands', async () => {
  const before = stableStringify(proof);
  const fixes = autoFixes(proof, findings);
  for (const fix of fixes) {
    const fixed = fix.apply(proof);
    assert.equal(stableStringify(proof), before, `"${fix.label}" mutated the proof it was given`);
    if (fix.effect !== 'resolves') continue;
    const after = await runPreflight(fixed, { clock: () => proof.createdAt });
    assert.deepEqual(
      after.filter((f) => f.id === fix.finding.id),
      [],
      `"${fix.label}" did not resolve its own finding on real content`,
    );
  }
});

test('a dry run walks the whole corpus deck with a live counter', async () => {
  /** @type {number[]} */
  const counts = [];
  const result = await dryRun(proof, {
    clock: () => proof.createdAt,
    findings,
    onPosition: (step) => { counts.push(step.issuesSeen); },
  });
  assert.equal(counts.length, result.positions);
  assert.ok(result.positions > proof.spine.length, 'the walk covers beats, not just scenes');
  assert.equal(result.scenesWalked, new Set([
    ...proof.spine.map((s) => s.id),
    ...proof.branches.flatMap((b) => b.scenes.map((s) => s.id)),
  ]).size);
  assert.equal(result.branchesWalked, proof.branches.length, 'every branch is rehearsed, opened on the day or not');
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1]);
  assert.equal(result.summary.canEmit, true);
});
