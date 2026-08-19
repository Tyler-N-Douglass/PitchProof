/**
 * §9, §18.1, §22.6 — provenance, which the spec calls "the single reputational
 * risk in this product".
 *
 * §20 axis 7 has the critic attempt to emit unlabelled illustrative content and
 * confirm it is blocked. Enforcement against the rendered document lives in
 * L10's `emit()`, where §22.6 requires it. What preflight adds is the model-level
 * half, which is visible long before emit and is the half a hand-edited project
 * can smuggle past a UI: a rendition wearing `verified-by-user` that nobody ever
 * promoted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runPreflight, autoFixes, hasPromotionRecord, promotionRecord, reviewReachable,
} from '../../src/validate/index.js';
import { promoteProvenance, hasPromotionRecord as recipeHasPromotionRecord } from '../../src/recipe/index.js';
import { hasPromotionRecord as emitHasPromotionRecord } from '../../src/emit/promotion.js';
import { cleanProof, defectProof, copy, NOW, CLEAN_DOCUMENT } from '../fixtures/validate/defects.mjs';

const preflight = (proof, options = {}) => runPreflight(proof, { clock: () => NOW, ...options });

test('a verified-by-user rendition with no promotion record blocks emit', async () => {
  const findings = await preflight(defectProof('PROVENANCE_UNLABELED'));
  const finding = findings.find((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.ok(finding, 'an unpromoted verified-by-user rendition must be caught');
  assert.equal(finding.severity, 1);
  assert.match(finding.message, /no promotion record/);
  assert.match(finding.message, /client-approved fact/);
  assert.equal(finding.detail.renditionId, 'rd_de');
  assert.equal(finding.autoFixAvailable, true);
});

/**
 * The regression for the defect L10 reported as L10-D9. L11 used to carry its own
 * reader for the promotion record — a regex looking for an English sentence — and
 * it did not recognise the delimited record `promoteProvenance` actually writes.
 * A correctly promoted rendition therefore drew a severity-1 `PROVENANCE_UNLABELED`
 * from preflight, so the studio greyed out the emit button on an honest proof
 * while `emit()` accepted the same proof without complaint. There is now one
 * reader, L7's (L11-D19).
 *
 * This test builds the record the only supported way — by calling L7's
 * `promoteProvenance` — so it cannot pass against a reader that agrees with a
 * hand-written imitation of the format instead of the format itself.
 */
test('a rendition promoted by L7 is accepted, and preflight agrees with the emitter', async () => {
  const proof = copy(defectProof('PROVENANCE_UNLABELED'));
  const promoted = promoteProvenance(
    { ...proof.renditions[0], provenance: 'illustrative' },
    { by: 'j.okafor@northwind.example', at: '2026-02-05T14:12:00.000Z' },
  );
  proof.renditions[0] = promoted;

  assert.equal(hasPromotionRecord(promoted), true, 'L11 must read the record L7 wrote');
  assert.equal(emitHasPromotionRecord(promoted), true, 'and so must L10');
  const record = promotionRecord(promoted);
  assert.equal(record.by, 'j.okafor@northwind.example');
  assert.equal(record.at, '2026-02-05T14:12:00.000Z');
  assert.equal(record.of, promoted.id);

  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
});

test('preflight and the emitter read the promotion record with the same function', () => {
  assert.equal(hasPromotionRecord, recipeHasPromotionRecord,
    'L11 re-exports L7\'s reader rather than implementing a second one');
  assert.equal(emitHasPromotionRecord({ provenance: 'verified-by-user', notes: 'Promoted by Dana at 2026-02-05T00:00:00Z.' }), false);
  assert.equal(hasPromotionRecord({ provenance: 'verified-by-user', notes: 'Promoted by Dana at 2026-02-05T00:00:00Z.' }), false,
    'an English sentence is not a promotion record, and forging one must stay hard');
  assert.equal(hasPromotionRecord({ notes: 'Looks good to me.' }), false);
  assert.equal(hasPromotionRecord(null), false);
  assert.equal(promotionRecord(null), null);
});

test('a record copied onto another rendition does not verify', () => {
  const donor = promoteProvenance(
    { ...cleanProof().renditions[0], id: 'rd_donor', provenance: 'illustrative' },
    { by: 'Dana Okafor', at: '2026-02-05T14:12:00.000Z' },
  );
  const thief = { ...donor, id: 'rd_thief' };
  assert.equal(hasPromotionRecord(donor), true);
  assert.equal(hasPromotionRecord(thief), false, 'the record names the rendition it was written for');
});

test('the reader preflight defaults to needs no injection to agree with L10', async () => {
  const proof = copy(defectProof('PROVENANCE_UNLABELED'));
  proof.renditions[0] = promoteProvenance(
    { ...proof.renditions[0], provenance: 'illustrative' },
    { by: 'Dana Okafor', at: '2026-02-05T14:12:00.000Z' },
  );
  const byDefault = (await preflight(proof)).filter((f) => f.code === 'PROVENANCE_UNLABELED');
  const injected = (await preflight(proof, { hasPromotionRecord: emitHasPromotionRecord }))
    .filter((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.deepEqual(byDefault, []);
  assert.deepEqual(injected, byDefault, 'injecting L10\'s reader changes nothing — L10 may drop the injection');
});

test('an illustrative rendition is not a finding on its own — it is labelled, not forbidden', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  proof.renditions[0].producedBy = 'adapter';
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
});

test('disabling the label on a Review-reachable build blocks emit', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  proof.emitOptions.mode = 'both';
  proof.emitOptions.labelIllustrativeContent = false;
  assert.equal(reviewReachable(proof.emitOptions), true);

  const findings = await preflight(proof);
  const finding = findings.find((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.ok(finding, '§9 forbids disabling the label for a build a recipient can open');
  assert.equal(finding.severity, 1);
  assert.match(finding.message, /Review mode/);
  assert.equal(finding.detail.illustrativeShown, 1);
});

test('a presenter-only build may disable the label, because no recipient opens it', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  proof.emitOptions.mode = 'presenter';
  proof.emitOptions.labelIllustrativeContent = false;
  assert.equal(reviewReachable(proof.emitOptions), false);
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
});

/**
 * The document-level half of the law belongs to L10: `assertProvenance` runs
 * inside `emit()`, renders each scene, and checks that the label is inside the
 * rendition's own subtree and legible in the final stylesheet. What preflight
 * owns is the *wiring* — that it hands L10 a renderer and the stylesheet, and
 * surfaces what comes back without reporting the model-level defects twice.
 * These tests assert the wiring; L10's own suite asserts its verdict.
 */
test('preflight hands L10 a scene renderer and the final stylesheet', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  /** @type {any[]} */
  const calls = [];
  await preflight(proof, {
    html: '<html></html>',
    css: '.pp-provenance{font-size:12px}',
    assertProvenance: (p, html, css, options) => { calls.push({ p, html, css, options }); return []; },
  });
  assert.equal(calls.length, 1, 'the document-level check runs exactly once');
  assert.equal(calls[0].html, '<html></html>');
  assert.equal(calls[0].css, '.pp-provenance{font-size:12px}');
  assert.equal(typeof calls[0].options.renderScene, 'function');
  assert.equal(calls[0].options.mode, proof.emitOptions.mode);
  // The renderer must produce the tree the artifact will paint, label and all.
  const tree = calls[0].options.renderScene(proof.spine[0]);
  assert.ok(tree, 'the renderer must return a VNode tree');
});

test('the document-level check is not run when there is no document to check', async () => {
  let called = false;
  await preflight(cleanProof(), { assertProvenance: () => { called = true; return []; } });
  assert.equal(called, false, 'a model-only sweep has no rendered document to assert against');
});

test("L10's document findings are surfaced, and its copy of the model checks is not", async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'verified-by-user';   // preflight reports this from the model
  const findings = await preflight(proof, {
    html: '<html></html>',
    css: '',
    assertProvenance: () => ([
      // L10's copy of the model check: preflight already made it, with a fix.
      { id: 'x1', severity: 1, code: 'PROVENANCE_UNLABELED', message: 'promotion record missing', locus: { check: 'promotion-record', renditionId: 'rd_de' }, autoFixAvailable: false },
      // A finding only the rendered document can produce.
      { id: 'x2', severity: 1, code: 'PROVENANCE_UNLABELED', message: 'the label is not in the subtree', locus: { sceneId: 'sc_a', check: 'label-present' }, autoFixAvailable: false },
    ]),
  });
  const provenance = findings.filter((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.equal(provenance.length, 2, 'one model finding and one document finding, not three');
  assert.equal(provenance.filter((f) => f.detail && f.detail.source === 'rendered-document').length, 1);
  assert.equal(provenance.filter((f) => f.autoFixAvailable).length, 1, 'the model finding keeps its auto-fix');
  assert.ok(provenance.some((f) => f.message.includes('the label is not in the subtree')));
});

test('a document-level finding blocks emit like any other severity-1', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  const findings = await preflight(proof, {
    html: '<html></html>',
    css: '.pp-provenance{display:none}',
    assertProvenance: () => ([
      { id: 'y1', severity: 1, code: 'PROVENANCE_UNLABELED', message: 'the label is styled to invisibility', locus: { sceneId: 'sc_a', check: 'label-style' }, autoFixAvailable: false },
    ]),
  });
  const finding = findings.find((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.ok(finding);
  assert.equal(finding.severity, 1);
  assert.equal(finding.detail.source, 'rendered-document');
});

test('the auto-fix demotes an unpromoted rendition rather than inventing a promotion', async () => {
  const proof = defectProof('PROVENANCE_UNLABELED');
  const findings = await preflight(proof);
  const fixes = autoFixes(proof, findings).filter((f) => f.finding.code === 'PROVENANCE_UNLABELED');
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].label, /Demote/);
  assert.match(fixes[0].label, /illustrative/);

  const fixed = fixes[0].apply(proof);
  assert.equal(fixed.renditions[0].provenance, 'illustrative');
  assert.equal(proof.renditions[0].provenance, 'verified-by-user', 'the input proof is untouched');
  // The fix must never fabricate the record §9 requires a person to create.
  assert.equal(hasPromotionRecord(fixed.renditions[0]), false);
  const after = await preflight(fixed);
  assert.deepEqual(after.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
});

test('the auto-fix for a disabled label turns it back on', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  proof.emitOptions.labelIllustrativeContent = false;
  const findings = await preflight(proof);
  const fixes = autoFixes(proof, findings).filter((f) => f.finding.code === 'PROVENANCE_UNLABELED');
  assert.equal(fixes.length, 1);
  const fixed = fixes[0].apply(proof);
  assert.equal(fixed.emitOptions.labelIllustrativeContent, true);
  assert.equal(proof.emitOptions.labelIllustrativeContent, false);
});

// ---------------------------------------------------------------------------
// The same law, end to end against the real L10 and the real L8 layouts.
// ---------------------------------------------------------------------------

/** A document that carries the label the layouts render, as the emitter would write it. */
const LABELLED_DOCUMENT = {
  html: '<div id="pp-stage-root"><div class="pp-scene"><p class="pp-provenance">Illustrative example — not client-approved content</p></div></div>',
  css: '.pp-provenance{font-size:12px;color:#24272E;background:#F2F4F8}',
};

test('a labelled illustrative rendition passes the real emit-side check', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  const findings = await preflight(proof, LABELLED_DOCUMENT);
  assert.deepEqual(
    findings.filter((f) => f.code === 'PROVENANCE_UNLABELED').map((f) => f.message),
    [],
    'the layouts do render the label, and the emitter finds it where it is',
  );
});

test('the real emit-side check catches a label styled to invisibility', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  for (const css of [
    '.pp-provenance{display:none}',
    '.pp-provenance{visibility:hidden}',
    '.pp-provenance{opacity:0}',
    '.pp-provenance{font-size:8px;color:#24272E;background:#F2F4F8}',
    '.pp-provenance{color:#F0F2F6;background:#F2F4F8}',
  ]) {
    const findings = await preflight(proof, { html: LABELLED_DOCUMENT.html, css });
    const finding = findings.find((f) => f.code === 'PROVENANCE_UNLABELED');
    assert.ok(finding, `a label hidden with "${css}" must be caught at emit`);
    assert.equal(finding.severity, 1);
    assert.equal(finding.detail.source, 'rendered-document');
  }
});

test('the unearned verification is reported once, and its auto-fix clears the whole cascade', async () => {
  const proof = copy(defectProof('PROVENANCE_UNLABELED'));
  const findings = await preflight(proof, LABELLED_DOCUMENT);
  const provenance = findings.filter((f) => f.code === 'PROVENANCE_UNLABELED');

  // Exactly one finding about the missing promotion record — preflight's, with
  // the fix attached. L10's copy of that check is dropped.
  const claim = provenance.filter((f) => f.detail && f.detail.renditionId === 'rd_de' && !f.detail.source);
  assert.equal(claim.length, 1, 'preflight and the emitter must not both report the model-level defect');
  assert.equal(claim[0].autoFixAvailable, true, 'the surviving copy is the one that carries the fix');

  // L10 additionally holds an unearned verification to the labelling rule, which
  // is the safe reading: a claim nobody made must not render unlabelled either.
  // Those are a different check and are surfaced, not folded away.
  const labelling = provenance.filter((f) => f.detail && f.detail.source === 'rendered-document');
  assert.ok(labelling.length > 0, 'the emitter also requires an unearned claim to be labelled');
  assert.ok(labelling.every((f) => f.severity === 1));

  // Demoting the rendition — the one honest fix — clears every one of them.
  const fix = autoFixes(proof, findings).find((f) => f.finding.id === claim[0].id);
  assert.ok(fix);
  const fixed = fix.apply(proof);
  const after = await preflight(fixed, LABELLED_DOCUMENT);
  assert.deepEqual(after.filter((f) => f.code === 'PROVENANCE_UNLABELED').map((f) => f.message), []);
});

test('a client-supplied rendition needs neither a label nor a promotion record', async () => {
  const findings = await preflight(cleanProof(), { html: CLEAN_DOCUMENT.html, css: CLEAN_DOCUMENT.css });
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), [],
    'nothing about client-supplied content needs a label, so no check may fire on it');
});
