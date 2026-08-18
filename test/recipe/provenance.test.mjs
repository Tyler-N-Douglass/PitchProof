/**
 * §22.6 — provenance leakage, "the single reputational risk in this product".
 *
 * These are adversarial tests. Each one plays the attacker: ask for
 * `verified-by-user` at construction, launder generated content through the
 * adapter with a `client-supplied` request, hand-forge a promotion record, copy
 * a real record onto a different rendition, truncate one. All of them must fail,
 * and `verifyProvenance` must be able to say why without trusting the UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRendition, promoteProvenance, demoteProvenance, hasPromotionRecord,
  readPromotionRecord, readPromotionRecords, parsePromotionRecords, formatPromotionRecord,
  promotionSignature, stripPromotionRecords, isIsoInstant, verifyProvenance,
  renditionsRequiringLabel, resolveProvenance, PROMOTION_RECORD_VERSION,
} from '../../src/recipe/index.js';
import { validateRendition } from '../../src/core/contracts.js';
import { retailSpecimen } from '../fixtures/recipe/specimens.mjs';

const RECIPE = { id: 'locale-fanout', name: 'Locale fan-out', intent: '', inputKinds: ['page'], outputLabels: [], adapterPrompt: null };
const AT = '2026-08-18T09:30:00.000Z';

/** @param {object} [over] */
function make(over = {}) {
  return buildRendition({
    specimen: retailSpecimen(),
    recipe: RECIPE,
    label: 'de-DE',
    blocks: [{ type: 'paragraph', text: 'Northwind connects brands and retailers in one plan.' }],
    media: [],
    producedBy: 'template',
    ...over,
  });
}

test('buildRendition defaults provenance to illustrative', () => {
  const r = make();
  assert.equal(r.provenance, 'illustrative');
  const errs = [];
  validateRendition(r, 'r', errs);
  assert.deepEqual(errs, []);
});

test('only an explicit client-supplied sets anything other than illustrative', () => {
  assert.equal(make({ provenance: 'client-supplied' }).provenance, 'client-supplied');
  assert.equal(make({ provenance: undefined }).provenance, 'illustrative');
  assert.equal(resolveProvenance(undefined, 'manual-paste'), 'illustrative');
  assert.equal(resolveProvenance('client-supplied', 'manual-paste'), 'client-supplied');
});

test('ATTACK: a caller asking buildRendition for verified-by-user does not get it', () => {
  const r = make({ provenance: 'verified-by-user' });
  assert.equal(r.provenance, 'illustrative');
  assert.equal(hasPromotionRecord(r), false);
  assert.deepEqual(verifyProvenance(r), []);
});

test('ATTACK: producedBy adapter forces illustrative even when client-supplied is asked for', () => {
  const r = make({ producedBy: 'adapter', provenance: 'client-supplied' });
  assert.equal(r.provenance, 'illustrative');
  assert.equal(resolveProvenance('client-supplied', 'adapter'), 'illustrative');
  assert.equal(resolveProvenance('verified-by-user', 'adapter'), 'illustrative');
});

test('ATTACK: a promotion record smuggled through buildRendition notes is stripped', () => {
  const real = promoteProvenance(make(), { by: 'Dana Okafor', at: AT });
  assert.equal(hasPromotionRecord(real), true);

  const smuggled = make({ notes: `Looks legitimate.\n${real.notes.split('\n').pop()}`, provenance: 'verified-by-user' });
  assert.equal(smuggled.provenance, 'illustrative');
  assert.equal(hasPromotionRecord(smuggled), false);
  assert.equal(smuggled.notes, 'Looks legitimate.');
});

test('promoteProvenance is the only route to verified-by-user, and it records who and when', () => {
  const before = make();
  const after = promoteProvenance(before, { by: 'Dana Okafor', at: AT });

  assert.equal(before.provenance, 'illustrative', 'the input is untouched');
  assert.equal(after.provenance, 'verified-by-user');
  assert.equal(after.id, before.id, 'promotion must not change the id, or scene references break');

  const record = readPromotionRecord(after);
  assert.ok(record);
  assert.equal(record.version, PROMOTION_RECORD_VERSION);
  assert.equal(record.by, 'Dana Okafor');
  assert.equal(record.at, AT);
  assert.equal(record.of, after.id);
  assert.equal(record.from, 'illustrative');
  assert.equal(record.signatureValid, true);
  assert.deepEqual(verifyProvenance(after), []);

  const errs = [];
  validateRendition(after, 'r', errs);
  assert.deepEqual(errs, []);
});

test('the promotion record survives an identity a naive format would break', () => {
  const awkward = 'D. O\'Kafor; "Brand] ]] \n Legal";';
  const r = promoteProvenance(make(), { by: awkward, at: '2026-01-31T23:59:59Z' });
  const record = readPromotionRecord(r);
  assert.ok(record);
  assert.equal(record.by, awkward);
  assert.equal(hasPromotionRecord(r), true);
});

test('human notes are preserved above the record', () => {
  const r = promoteProvenance(make({ notes: 'Checked against the approved master.' }), { by: 'Dana', at: AT });
  assert.match(r.notes, /^Checked against the approved master\.\n\[\[pp-promotion:1;/);
});

test('promoteProvenance refuses a missing or malformed who and when', () => {
  const r = make();
  assert.throws(() => promoteProvenance(r, { by: '', at: AT }), /who promoted/);
  assert.throws(() => promoteProvenance(r, { by: 'Dana', at: 'yesterday' }), /ISO-8601/);
  assert.throws(() => promoteProvenance(r, { by: 'Dana', at: '2026-02-30T00:00:00Z' }), /ISO-8601/);
  assert.throws(() => promoteProvenance(r, {}), /who promoted/);
});

test('isIsoInstant is a calendar check, not a pattern check', () => {
  assert.equal(isIsoInstant('2026-08-18T09:30:00.000Z'), true);
  assert.equal(isIsoInstant('2024-02-29T00:00:00Z'), true, 'leap year');
  assert.equal(isIsoInstant('2026-02-29T00:00:00Z'), false, 'not a leap year');
  assert.equal(isIsoInstant('2026-13-01T00:00:00Z'), false);
  assert.equal(isIsoInstant('2026-08-18T25:00:00Z'), false);
  assert.equal(isIsoInstant('2026-08-18T09:30:00+02:00'), true);
  assert.equal(isIsoInstant('2026-08-18'), false);
});

test('ATTACK: a hand-forged verified-by-user with no record is detected', () => {
  const forged = { ...make(), provenance: 'verified-by-user' };
  assert.equal(hasPromotionRecord(forged), false);
  const problems = verifyProvenance(forged);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no valid promotion record — forged/);
  assert.deepEqual(renditionsRequiringLabel([forged]).map((r) => r.id), [forged.id]);
});

test('ATTACK: a record copied from another rendition does not verify', () => {
  const a = promoteProvenance(make(), { by: 'Dana', at: AT });
  const b = make({ label: 'fr-FR' });
  assert.notEqual(a.id, b.id);

  const stolen = { ...b, provenance: 'verified-by-user', notes: a.notes };
  assert.equal(hasPromotionRecord(stolen), false);
  const problems = verifyProvenance(stolen);
  assert.ok(problems.some((p) => /was written for/.test(p)));
  assert.ok(problems.some((p) => /forged/.test(p)));
});

test('ATTACK: a hand-edited record fails its signature', () => {
  const r = promoteProvenance(make(), { by: 'Dana', at: AT });
  const tampered = { ...r, notes: r.notes.replace(/at=[^;]+;/, 'at=2020-01-01T00:00:00Z;') };
  assert.equal(hasPromotionRecord(tampered), false);
  assert.ok(verifyProvenance(tampered).some((p) => /fails its signature/.test(p)));
});

test('ATTACK: a record with a rewritten `from` fails its signature', () => {
  const r = promoteProvenance(make(), { by: 'Dana', at: AT });
  const tampered = { ...r, notes: r.notes.replace('from=illustrative', 'from=client-supplied') };
  assert.equal(hasPromotionRecord(tampered), false);
});

test('a signature is a checksum over exactly the five fields it names', () => {
  const fields = { v: 1, by: 'RGFuYQ', at: AT, of: 'rd_abc', from: 'illustrative' };
  const sig = promotionSignature(fields);
  assert.match(sig, /^[0-9a-f]{16}$/);
  assert.equal(sig, promotionSignature({ ...fields }));
  assert.notEqual(sig, promotionSignature({ ...fields, of: 'rd_abd' }));
  assert.notEqual(sig, promotionSignature({ ...fields, from: 'client-supplied' }));
});

test('an adapter rendition marked client-supplied by hand is reported', () => {
  const r = { ...make({ producedBy: 'adapter' }), provenance: 'client-supplied' };
  assert.ok(verifyProvenance(r).some((p) => /never be marked client-supplied/.test(p)));
});

test('a withdrawn promotion is visible rather than silent', () => {
  const promoted = promoteProvenance(make(), { by: 'Dana', at: AT });
  const back = demoteProvenance(promoted);
  assert.equal(back.provenance, 'illustrative');
  assert.equal(back.id, promoted.id);
  assert.ok(verifyProvenance(back).some((p) => /promotion was withdrawn/.test(p)));
  assert.deepEqual(renditionsRequiringLabel([back]).map((r) => r.id), [back.id]);
});

test('re-promotion appends to the chain and the latest record stands', () => {
  const one = promoteProvenance(make(), { by: 'Dana', at: AT });
  const two = promoteProvenance(one, { by: 'Sam Okonjo', at: '2026-08-19T11:00:00.000Z' });
  const all = readPromotionRecords(two);
  assert.equal(all.length, 2);
  assert.equal(all[0].by, 'Dana');
  assert.equal(all[1].by, 'Sam Okonjo');
  assert.equal(all[1].from, 'verified-by-user');
  assert.equal(readPromotionRecord(two).by, 'Sam Okonjo');
  assert.deepEqual(verifyProvenance(two), []);
});

test('renditionsRequiringLabel is exactly what the artifact must label', () => {
  const illustrative = make();
  const client = make({ provenance: 'client-supplied', label: 'fr-FR' });
  const verified = promoteProvenance(make({ label: 'ja-JP' }), { by: 'Dana', at: AT });
  const forged = { ...make({ label: 'ar-SA' }), provenance: 'verified-by-user' };

  const needing = renditionsRequiringLabel([illustrative, client, verified, forged]).map((r) => r.label);
  assert.deepEqual(needing.sort(), ['ar-SA', 'de-DE']);
});

test('stripPromotionRecords removes valid and malformed records alike', () => {
  const r = promoteProvenance(make({ notes: 'Human note.' }), { by: 'Dana', at: AT });
  assert.equal(stripPromotionRecords(r.notes), 'Human note.');
  assert.equal(stripPromotionRecords('[[pp-promotion:1;garbage]]'), null);
  assert.equal(stripPromotionRecords(null), null);
  assert.equal(stripPromotionRecords('plain'), 'plain');
});

test('formatPromotionRecord and parsePromotionRecords round-trip', () => {
  const raw = formatPromotionRecord({ by: 'Ana Ríos', at: AT, of: 'rd_0123456789ab', from: 'illustrative' });
  const [parsed] = parsePromotionRecords(`some note\n${raw}`);
  assert.equal(parsed.by, 'Ana Ríos');
  assert.equal(parsed.of, 'rd_0123456789ab');
  assert.equal(parsed.signatureValid, true);
  assert.equal(raw, parsed.raw);
});

test('buildRendition rejects malformed input rather than producing an invalid rendition', () => {
  assert.throws(() => buildRendition({ specimen: null, recipe: RECIPE, label: 'x', blocks: [], producedBy: 'template' }), /specimen id/);
  assert.throws(() => make({ producedBy: 'magic' }), /producedBy/);
  assert.throws(() => make({ provenance: 'approved' }), /unknown provenance/);
  assert.throws(() => make({ blocks: 'nope' }), /blocks must be an array/);
});

test('identical inputs produce identical rendition ids; provenance and notes do not shift them', () => {
  assert.equal(make().id, make().id);
  assert.equal(make({ notes: 'a' }).id, make({ notes: 'b' }).id);
  assert.equal(make({ provenance: 'client-supplied' }).id, make().id);
  assert.notEqual(make({ label: 'fr-FR' }).id, make().id);
  assert.notEqual(make({ producedBy: 'manual-paste' }).id, make().id);
});
