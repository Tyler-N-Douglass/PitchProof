/**
 * §18.3 — "The prospect's own content is presented unmodified on the 'before'
 * side. If a specimen was edited, the artifact says so."
 *
 * CRITIQUE-3 **P6**, second half, reported by L6 after it fixed its own: the
 * `ASSET_MISSING` auto-fix spliced a block out of `specimen.blocks` and set
 * neither `edited` nor `editNotes`. A seller clicked "Remove the block
 * referencing missing media", the prospect's own content left the deck, and the
 * artifact — whose whole premise is that it is built on the prospect's
 * material — said nothing about it.
 *
 * This file is the regression, and it is two tests rather than one, because the
 * defect was never really about that single fix:
 *
 *  1. **The named case.** That fix, on that finding, records what it removed.
 *  2. **The general case.** Every fix the engine offers is applied, and the
 *     record is checked against what actually changed: a fix that removes a
 *     block from a specimen must record exactly one edit, and a fix that does
 *     not must record none. The second half matters as much as the first — a
 *     colour fix that claimed the prospect's page had been edited would be the
 *     same law broken from the other side.
 *
 * The audit that decided which fixes fall on which side is L11-D30.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stableStringify } from '../../src/core/hash.js';
import { FINDING_CODES } from '../../src/core/contracts.js';
import { runPreflight, autoFixes, applyAll } from '../../src/validate/index.js';

import { cleanProof, defectProof, copy, withRenderedReveals, NOW } from '../fixtures/validate/defects.mjs';

const preflight = (proof, options = {}) => runPreflight(proof, { clock: () => NOW, ...options });

/** The §18.3 record on one specimen, as a comparable value. */
const record = (specimen) => ({
  edited: Boolean(specimen.edited),
  notes: [...(specimen.editNotes || [])],
});

/** The content a viewer would see from one owner, as a comparable value. */
const content = (owner) => stableStringify(owner.blocks || []);

/** A proof with `count` media blocks in one specimen that no media backs. */
function danglingProof(count, refs = []) {
  const p = copy(cleanProof());
  for (let i = 0; i < count; i++) {
    p.specimens[0].blocks.push({
      type: 'media',
      ref: refs[i] || `/assets/missing-${i}.png`,
      caption: i === 0 ? 'The hero shot' : '',
    });
  }
  return withRenderedReveals(p);
}

const missingFixes = (proof, findings, options) =>
  autoFixes(proof, findings, options).filter((f) => f.finding.code === 'ASSET_MISSING');

// ---------------------------------------------------------------------------
// 1. The named case
// ---------------------------------------------------------------------------

test('P6: the missing-asset fix records the edit it made to the prospect\'s content', async () => {
  const proof = defectProof('ASSET_MISSING');
  const findings = await preflight(proof);
  const [fix] = missingFixes(proof, findings);
  assert.ok(fix, 'the fixture must offer the fix this test is about');

  const fixed = fix.apply(proof);
  const specimen = fixed.specimens[0];

  assert.equal(specimen.edited, true, '§18.3: the specimen must say it was edited');
  assert.equal(specimen.editNotes.length, 1, 'one removal, one note');
  assert.ok(!proof.specimens[0].edited, 'and the proof handed in is untouched — that is the undo');
  assert.deepEqual(proof.specimens[0].editNotes || [], []);
});

test('P6: the note says what was removed and why, not "block removed"', async () => {
  const proof = defectProof('ASSET_MISSING');
  const findings = await preflight(proof);
  const [fix] = missingFixes(proof, findings);
  const [note] = fix.apply(proof).specimens[0].editNotes;

  assert.match(note, /md_nowhere/, 'the note names the image that left');
  assert.match(note, /The hero shot/, 'and what the page called it');
  assert.match(note, /Market launch/, 'and where it stood, the way a reader would look for it');
  assert.match(note, /broken image/, 'and why it could not stay');
  assert.ok(note.length > 40, `a note a client can act on, not a label: ${note}`);
});

test('P6: an injected clock dates the note; without one the note still says what changed', async () => {
  const proof = defectProof('ASSET_MISSING');
  const findings = await preflight(proof);

  const [dated] = missingFixes(proof, findings, { clock: () => NOW });
  assert.match(dated.apply(proof).specimens[0].editNotes[0], new RegExp(`^${NOW}: `));

  const [undated] = missingFixes(proof, findings);
  const note = undated.apply(proof).specimens[0].editNotes[0];
  assert.doesNotMatch(note, /^\d{4}-\d\d-\d\dT/);
  assert.match(note, /md_nowhere/);
});

test('P6: the removal keeps the specimen\'s own numbers honest', async () => {
  const proof = danglingProof(1, ['/assets/hero.png']);
  proof.specimens[0].blocks.push({ type: 'paragraph', text: 'One more sentence, four words.' });
  proof.specimens[0].wordCount = 999;

  const findings = await preflight(proof);
  const [fix] = missingFixes(proof, findings);
  const fixed = fix.apply(proof);

  assert.notEqual(fixed.specimens[0].wordCount, 999, 'markEdited recomputes what the splice used to leave stale');
  assert.ok(fixed.specimens[0].blocks.some((b) => b.type === 'paragraph'), 'and removes only the media block');
});

// ---------------------------------------------------------------------------
// 2. The general case — every fix, against what it actually changed
// ---------------------------------------------------------------------------

test('every auto-fix that changes what the room sees records it, and every other one does not', async () => {
  let contentChanging = 0;
  for (const code of FINDING_CODES) {
    const proof = defectProof(code);
    const findings = await preflight(proof);
    for (const fix of autoFixes(proof, findings)) {
      const fixed = fix.apply(proof);

      for (const before of proof.specimens || []) {
        const after = (fixed.specimens || []).find((s) => s.id === before.id);
        assert.ok(after, `${code}: "${fix.label}" removed a whole specimen, which no fix may do`);
        const changed = content(after) !== content(before);
        if (!changed) {
          assert.deepEqual(record(after), record(before),
            `${code}: "${fix.label}" claimed an edit to specimen ${before.id} it did not make`);
          continue;
        }
        contentChanging++;
        assert.equal(after.edited, true,
          `§18.3: "${fix.label}" changed the content of specimen ${before.id} and did not say so`);
        assert.equal(after.editNotes.length, (before.editNotes || []).length + 1,
          `${code}: one edit, one note`);
        assert.ok(after.editNotes[after.editNotes.length - 1].length >= 40,
          `${code}: the note must say something a client can act on`);
      }

      // The other half of §18.3's protection: no fix may edit a rendition the
      // prospect declared as their own material, or that a person signed off
      // on, because §4 gives a rendition nowhere to record that it happened.
      for (const before of proof.renditions || []) {
        if (before.provenance !== 'client-supplied' && before.provenance !== 'verified-by-user') continue;
        const after = (fixed.renditions || []).find((r) => r.id === before.id);
        assert.ok(after, `${code}: "${fix.label}" removed rendition ${before.id}`);
        assert.equal(content(after), content(before),
          `${code}: "${fix.label}" edited ${before.provenance} rendition ${before.id} with nowhere to say so`);
      }
    }
  }
  assert.ok(contentChanging > 0, 'the sweep must actually exercise a content-changing fix');
});

// ---------------------------------------------------------------------------
// 3. Renditions — which ones the tool may edit on its own initiative
// ---------------------------------------------------------------------------

test('a dangling block in a client-supplied rendition is reported and not auto-fixed', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].blocks.push({ type: 'media', ref: '/assets/gone.png' });
  const findings = await preflight(withRenderedReveals(proof));

  const finding = findings.find((f) => f.code === 'ASSET_MISSING' && f.detail && f.detail.ownerKind === 'rendition');
  assert.ok(finding, 'the finding still fires — the broken image is real');
  assert.equal(finding.severity, 1, 'and still blocks: this is not a weakening of the rule');
  assert.equal(finding.autoFixAvailable, false);
  assert.match(finding.message, /client-supplied/);
  assert.match(finding.message, /remove the block yourself/i);
  assert.deepEqual(missingFixes(proof, findings), [], 'and no fixer offers one behind the rule\'s back');
});

test('a dangling block in the tool\'s own draft rendition is fixed, and marks no specimen edited', async () => {
  const proof = copy(cleanProof());
  proof.renditions[0].provenance = 'illustrative';
  proof.renditions[0].blocks.push({ type: 'media', ref: '/assets/gone.png' });
  const findings = await preflight(withRenderedReveals(proof));

  const [fix] = missingFixes(proof, findings);
  assert.ok(fix, 'the tool may edit its own draft');
  const fixed = fix.apply(proof);
  assert.ok(!fixed.renditions[0].blocks.some((b) => b.type === 'media' && b.ref === '/assets/gone.png'));
  assert.deepEqual(record(fixed.specimens[0]), record(proof.specimens[0]),
    'editing a rendition is not an edit to the prospect\'s page, and must not claim to be');
});

// ---------------------------------------------------------------------------
// 4. applyAll — ten fixes are one action, and read like one
// ---------------------------------------------------------------------------

test('applyAll removes every dangling block, not just the first', async () => {
  const proof = danglingProof(3, ['/a.png', '/b.png', '/c.png']);
  const findings = await preflight(proof);
  const fixes = missingFixes(proof, findings);
  assert.equal(fixes.length, 3, 'three dangling refs, three fixes');

  const fixed = applyAll(proof, fixes);
  const left = fixed.specimens[0].blocks.filter((b) => b.type === 'media');
  assert.deepEqual(left, [], 'an earlier removal shifts the later indices; every fix must still find its block');
  assert.deepEqual(await preflight(fixed).then((f) => f.filter((x) => x.code === 'ASSET_MISSING')), []);
});

test('applyAll folds a batch into one note that names every image, not three that each name one', async () => {
  const proof = danglingProof(3, ['/a.png', '/b.png', '/c.png']);
  const findings = await preflight(proof);
  const fixed = applyAll(proof, missingFixes(proof, findings), { clock: () => NOW });

  const notes = fixed.specimens[0].editNotes;
  assert.equal(fixed.specimens[0].edited, true);
  assert.equal(notes.length, 1, `one action, one note — got ${notes.length}:\n  ${notes.join('\n  ')}`);
  for (const ref of ['/a.png', '/b.png', '/c.png']) {
    assert.ok(notes[0].includes(ref), `the fold may summarise, never drop: ${ref} is missing from the note`);
  }
  assert.match(notes[0], /^2026-02-09T09:00:00\.000Z: Removed 3 images/);
  assert.match(notes[0], /The hero shot/, 'and it keeps what the page called them');
});

test('applyAll on a single fix writes the singular note, and appends to notes already there', async () => {
  const proof = danglingProof(1, ['/only.png']);
  proof.specimens[0].edited = true;
  proof.specimens[0].editNotes = ['2026-02-08T09:00:00.000Z: The seller cut two paragraphs for length.'];

  const findings = await preflight(proof);
  const fixed = applyAll(proof, missingFixes(proof, findings));
  const notes = fixed.specimens[0].editNotes;

  assert.equal(notes.length, 2, 'an earlier edit is history, not something a batch may rewrite');
  assert.match(notes[0], /cut two paragraphs/);
  assert.match(notes[1], /^Removed an image/);
});

test('applyAll is still pure, and still applies fixes that record nothing', async () => {
  const proof = danglingProof(2, ['/a.png', '/b.png']);
  proof.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';
  const before = stableStringify(proof);

  const findings = await preflight(proof);
  const fixes = autoFixes(proof, findings).filter((f) => f.effect === 'resolves');
  assert.ok(fixes.length > 2, 'the batch must mix a content edit with fixes that are not one');

  const fixed = applyAll(proof, fixes);
  assert.equal(stableStringify(proof), before, 'applyAll must not touch the proof it was handed');
  assert.equal(fixed.specimens[0].editNotes.length, 1);
  assert.ok(fixed.brand.manualOverrides.length > 0, 'and the fixes that record nothing still ran');
});
