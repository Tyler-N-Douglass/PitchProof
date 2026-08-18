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

test('a verified-by-user rendition with a promotion record is accepted', async () => {
  const proof = copy(defectProof('PROVENANCE_UNLABELED'));
  proof.renditions[0].notes = 'Promoted to verified-by-user by j.okafor@northwind.example at 2026-02-05T14:12:00Z after side-by-side review.';
  assert.equal(hasPromotionRecord(proof.renditions[0]), true);
  assert.deepEqual(promotionRecord(proof.renditions[0]), {
    by: 'j.okafor@northwind.example',
    at: '2026-02-05T14:12:00Z',
  });
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
});

test('a structured promotion record is accepted too, so L7 may carry it as a field', () => {
  assert.equal(hasPromotionRecord({ provenance: 'verified-by-user', notes: null, promotion: { by: 'a@b.example', at: '2026-02-05T00:00:00Z' } }), true);
  assert.equal(hasPromotionRecord({ notes: null, promotion: { by: '', at: '2026-02-05T00:00:00Z' } }), false);
  assert.equal(hasPromotionRecord({ notes: 'Looks good to me.' }), false);
  assert.equal(hasPromotionRecord(null), false);
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

test('an unlabelled illustrative rendition in the rendered document is caught', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  const html = '<div class="pp-scene" data-pp-scene="sc_a"><article data-rd="rd_de">Markteinführung</article></div>';
  const findings = await preflight(proof, { html, css: '' });
  const finding = findings.find((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.ok(finding, 'the label is missing from the rendered subtree');
  assert.equal(finding.severity, 1);
  assert.equal(finding.detail.source, 'rendered-document');
});

test('a label styled to invisibility is caught, not merely its absence', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  const html = '<div class="pp-scene" data-pp-scene="sc_a"><article data-rd="rd_de">x<span class="pp-provenance">Illustrative</span></article></div>';
  for (const css of ['.pp-provenance{display:none}', '.pp-provenance{opacity:0}', '.pp-provenance{font-size:1px}', '.pp-provenance{visibility:hidden}']) {
    const findings = await preflight(proof, { html, css });
    const finding = findings.find((f) => f.code === 'PROVENANCE_UNLABELED');
    assert.ok(finding, `a label hidden with "${css}" must still be caught`);
    assert.equal(finding.severity, 1);
  }
});

test('a properly labelled illustrative rendition passes', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  const html = `<div class="pp-scene" data-pp-scene="sc_a"><article data-rd="rd_de">x<span class="pp-provenance">Illustrative</span></article></div>`;
  const findings = await preflight(proof, { html, css: CLEAN_DOCUMENT.css });
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
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

test('a client-supplied rendition needs neither a label nor a promotion record', async () => {
  const findings = await preflight(cleanProof(), { html: CLEAN_DOCUMENT.html, css: CLEAN_DOCUMENT.css });
  assert.deepEqual(findings.filter((f) => f.code === 'PROVENANCE_UNLABELED'), []);
});
