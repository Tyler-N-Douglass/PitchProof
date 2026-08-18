/**
 * §18.2 — "No fabricated metrics, logos of third parties, testimonials, or named
 * customers may be inserted by the tool. There is no 'sample stat' generator.
 * Ever."
 *
 * The guard is tested the only way a detector can honestly be tested: by
 * planting the defect and confirming it is caught, and by confirming it stays
 * quiet on content that legitimately came from the source. A guard that fires on
 * a faithfully reformatted number is as broken as one that misses a fabricated
 * statistic — the first trains people to ignore it, and then the second happens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoFabricatedFacts, enforceNoFabricatedFacts, buildSourceBag, sourceStrings,
  unsourcedNote, numericTokens, WATCHED_BRANDS,
} from '../../src/recipe/index.js';
import { retailSpecimen } from '../fixtures/recipe/specimens.mjs';

const specimen = retailSpecimen();

/** @param {import('../../src/core/contracts.d.ts').ContentBlock[]} blocks */
const check = (blocks, options) => assertNoFabricatedFacts(blocks, specimen, options);

test('a rendition made only of source text is clean', () => {
  assert.deepEqual(check(specimen.blocks), []);
});

test('CAUGHT: a planted fabricated statistic', () => {
  const v = check([{ type: 'paragraph', text: 'Teams see a 42% lift in campaign throughput.' }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'numeral', 'neither the digits nor the percent are in the source');
  assert.equal(v[0].value, '42%');
  assert.match(v[0].message, /does not appear in the source specimen/);
});

test('CAUGHT: a plain numeral the source never stated', () => {
  const v = check([{ type: 'paragraph', text: 'Rolled out across 63 markets.' }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'numeral');
  assert.equal(v[0].value, '63');
});

test('CAUGHT: a real source number given a unit it never had', () => {
  // The source says `1,800 campaigns` and `$400`. It never says `1,800%`.
  const v = check([{ type: 'paragraph', text: 'Throughput rose 1,800% after launch.' }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'unit');
});

test('CAUGHT: a currency amount the source never quoted', () => {
  const v = check([{ type: 'paragraph', text: 'Plans from $12,500 a year.' }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'numeral');
  assert.equal(v[0].value, '$12,500');
});

test('CAUGHT: a multiplier', () => {
  const v = check([{ type: 'paragraph', text: 'Ten campaigns became 10x the output.' }]);
  assert.ok(v.some((x) => x.kind === 'unit' && x.value === '10x'));
});

test('CAUGHT: a spelled-out statistic', () => {
  const v = check([{ type: 'paragraph', text: 'Teams report forty percent less rework.' }]);
  assert.ok(v.some((x) => x.kind === 'spelled-number' && /forty percent/.test(x.value)));
});

test('CAUGHT: a planted testimonial', () => {
  const v = check([{
    type: 'quote',
    text: 'PitchProof cut our production time in half and the team has never looked back.',
    attribution: 'VP of Marketing, Contoso',
  }]);
  assert.ok(v.some((x) => x.kind === 'testimonial'));
  assert.ok(v.some((x) => x.kind === 'attribution'));
  assert.match(v.find((x) => x.kind === 'testimonial').message, /may not author a testimonial/);
});

test('CAUGHT: a testimonial-shaped quotation hidden inside a paragraph', () => {
  const v = check([{ type: 'paragraph', text: 'One customer told us “this changed how our whole team plans”.' }]);
  assert.ok(v.some((x) => x.kind === 'testimonial'));
});

test('CAUGHT: a third-party brand the source never mentions', () => {
  const v = check([{ type: 'paragraph', text: 'Trusted by Nike, Adobe and Salesforce.' }]);
  const names = v.filter((x) => x.kind === 'named-entity').map((x) => x.value).sort();
  assert.deepEqual(names, ['Adobe', 'Nike', 'Salesforce']);
});

test('QUIET: numbers that came from the source', () => {
  assert.deepEqual(check([
    { type: 'paragraph', text: 'Launched 08/17/2026 with 1,800 campaigns live and seats from $400.' },
    { type: 'table', header: true, rows: [['Plan', 'Seats'], ['Business', '50']] },
  ]), []);
});

test('QUIET: a source number reformatted for another market', () => {
  // These are exactly the transformations `locale-fanout` performs.
  assert.deepEqual(check([{ type: 'paragraph', text: 'Gestartet am 17.08.2026 mit 1.800 Kampagnen und Plätzen ab 400 $.' }]), []);
  assert.deepEqual(check([{ type: 'paragraph', text: '2026年08月17日' }]), []);
  assert.deepEqual(check([{ type: 'paragraph', text: 'Lancé le 17/08/2026 avec 1 800 campagnes.' }]), []);
});

test('QUIET: a quotation the prospect published themselves, carried verbatim', () => {
  assert.deepEqual(check([{
    type: 'quote',
    text: 'We moved a full quarter of planning into one workspace in a fortnight.',
    attribution: 'Head of Digital, Northwind',
  }]), []);
});

test('QUIET: a brand the prospect already names is not a finding', () => {
  const withBrand = retailSpecimen();
  withBrand.blocks = withBrand.blocks.concat([{ type: 'paragraph', text: 'Integrations include Salesforce and SAP.' }]);
  assert.deepEqual(
    assertNoFabricatedFacts([{ type: 'paragraph', text: 'Connects to Salesforce.' }], withBrand),
    [],
  );
  assert.ok(WATCHED_BRANDS.includes('Salesforce'));
});

test('QUIET: a digit that belongs to a name, not a quantity', () => {
  // Regression: an SMS budget report naming its own encoding fired the guard.
  assert.deepEqual(check([{ type: 'table', header: true, rows: [['Part', 'Characters'], ['Message', '163 (UCS-2)']] }], { structural: ['163'] }), []);
  assert.deepEqual(check([{ type: 'paragraph', text: 'Encoded GSM-7 per 3GPP TS 23.038.' }], { structural: [] }).filter((v) => v.value === '7'), []);
  assert.equal(numericTokens('UCS-2')[0].kind, 'identifier');
  assert.equal(numericTokens('UTF-8')[0].kind, 'identifier');
  // …but a unit is never a name.
  assert.equal(numericTokens('LIFT 40%')[0].kind, 'percent');
  assert.equal(numericTokens('SAVE 20')[0].kind, 'plain');
});

test('the structural allowance permits a dimensionless integer and nothing more', () => {
  assert.deepEqual(check([{ type: 'paragraph', text: 'Assembled at 1600px.' }], { structural: ['1600px'] }), []);
  assert.deepEqual(check([{ type: 'paragraph', text: 'Tiles shown: 400' }], { structural: ['400'] }), []);

  // A percentage, a currency amount or a rate can never be declared structural.
  assert.throws(() => enforceNoFabricatedFacts([], specimen, { structural: ['42%'] }), /never be declared structural/);
  assert.throws(() => enforceNoFabricatedFacts([], specimen, { structural: ['$1,200'] }), /never be declared structural/);
  assert.throws(() => enforceNoFabricatedFacts([], specimen, { structural: ['3.4x'] }), /never be declared structural/);
  assert.throws(() => enforceNoFabricatedFacts([], specimen, { structural: ['1,800'] }), /never be declared structural/);

  // And declaring `400` does not launder `400%`.
  const v = check([{ type: 'paragraph', text: 'Up 400% year on year.' }], { structural: ['400'] });
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'unit');
});

test('enforceNoFabricatedFacts throws with every violation named', () => {
  assert.throws(
    () => enforceNoFabricatedFacts([{ type: 'paragraph', text: 'A 42% lift, said Nike.' }], specimen, { label: 'planted' }),
    (e) => /§18\.2 violation in "planted"/.test(e.message) && /42%/.test(e.message) && /Nike/.test(e.message),
  );
  assert.doesNotThrow(() => enforceNoFabricatedFacts(specimen.blocks, specimen));
});

test('extraSource widens the permitted source without widening it silently', () => {
  const brief = 'Announce the board to 12 pilot accounts.';
  assert.equal(check([{ type: 'paragraph', text: 'Announced to 12 pilot accounts.' }]).length, 1);
  assert.deepEqual(check([{ type: 'paragraph', text: 'Announced to 12 pilot accounts.' }], { extraSource: [brief] }), []);
});

test('sourceStrings covers everything the specimen legitimately holds', () => {
  const strings = sourceStrings(specimen);
  assert.ok(strings.includes(specimen.title));
  assert.ok(strings.includes('md_hero'), 'media ids are source, not fabrication');
  assert.ok(strings.includes('1600') && strings.includes('900'), 'intrinsic dimensions are source');
  assert.ok(strings.includes('/book-a-demo'), 'a cta href is source');
  assert.ok(strings.some((s) => /Northwind Retail Group/.test(s)));

  const bag = buildSourceBag(specimen);
  assert.ok(bag.digits.has('08172026'));
  assert.ok(bag.classed.has('currency:400'));
  assert.ok(!bag.classed.has('percent:400'));
});

test('unsourcedNote is a one-line machine record, or null when clean', () => {
  assert.equal(unsourcedNote([]), null);
  assert.equal(unsourcedNote(null), null);
  const note = unsourcedNote(check([{ type: 'paragraph', text: 'A 42% lift, said Nike.' }]));
  assert.match(note, /^\[\[pp-unsourced:1;n=2;kinds=named-entity,numeral\]\]$/);
});

test('the guard reports where a violation is, not just that there is one', () => {
  const v = check([
    { type: 'heading', level: 2, text: 'Results' },
    { type: 'list', ordered: false, items: ['Steady', 'Up 42%'] },
    { type: 'table', header: false, rows: [['a', 'b'], ['c', '$99']] },
  ]);
  assert.equal(v.length, 2);
  assert.equal(v[0].blockIndex, 1);
  assert.equal(v[0].where, 'list item 1');
  assert.equal(v[1].blockIndex, 2);
  assert.equal(v[1].where, 'table r1c1');
});
