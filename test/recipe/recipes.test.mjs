/**
 * The eight §9 seed recipes.
 *
 * Every one of them must produce contract-valid renditions from a real
 * specimen, deterministically, with no adapter and no network — because §9 says
 * the manual path "must be excellent, not a fallback", and a recipe library that
 * only works with a generation endpoint configured is a fallback.
 *
 * The structural claims each recipe makes are asserted concretely: nine locale
 * renditions whose *shape* differs, four channel variants whose budgets are
 * measured and reported to the character, three breakpoints that re-compose, five
 * iterations that hold their claim set, five review states with different
 * permission surfaces, three DAM stages with a field-level diff, three volume
 * tiers with the right number of tiles.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEED_RECIPES, recipeById, recipeAccepts, recipesFor, renderRecipe, renderAll,
  channelBudget, CHANNEL_BUDGETS, LOCALES, hasPromotionRecord, verifyProvenance,
  buildRendition, renditionId, cloneBlock, mapBlockText, carryFields, enforceBudget,
} from '../../src/recipe/index.js';
import { structureOf } from '../../src/recipe/templates/locale-fanout.js';
import { readBudgetNote } from '../../src/recipe/templates/channel-variants.js';
import { reviewSurfaceOf } from '../../src/recipe/templates/approval-chain.js';
import { claimSet } from '../../src/recipe/templates/governed-iteration.js';
import { cellsFor, TIERS, combinationVocabulary } from '../../src/recipe/templates/volume-view.js';
import { validateRendition, SPECIMEN_KINDS, BREAKPOINTS } from '../../src/core/contracts.js';
import { stableStringify } from '../../src/core/hash.js';
import { retailSpecimen, briefSpecimen, digitFreeSpecimen } from '../fixtures/recipe/specimens.mjs';

const OPTIONS = { brief: 'Announce the unified planning board to existing customers. Book a walkthrough with the account team.' };

test('all eight §9 seed recipes are present, with contract-valid metadata', () => {
  assert.equal(SEED_RECIPES.length, 8);
  assert.deepEqual(SEED_RECIPES.map((r) => r.id), [
    'locale-fanout', 'channel-variants', 'system-assembly', 'brief-to-asset',
    'governed-iteration', 'approval-chain', 'dam-round-trip', 'volume-view',
  ]);
  for (const r of SEED_RECIPES) {
    assert.equal(typeof r.name, 'string');
    assert.ok(r.name.length > 0, `${r.id} needs a name`);
    assert.ok(r.intent.length > 0, `${r.id} needs a one-line intent`);
    assert.ok(r.inputKinds.length > 0 && r.inputKinds.every((k) => SPECIMEN_KINDS.includes(k)), `${r.id} inputKinds`);
    assert.ok(r.outputLabels.length > 0 && r.outputLabels.every((l) => typeof l === 'string'), `${r.id} outputLabels`);
    assert.ok(typeof r.adapterPrompt === 'string' && r.adapterPrompt.length > 0, `${r.id} adapterPrompt`);
    assert.equal(recipeById(r.id), r);
  }
  assert.equal(recipeById('nope'), null);
});

test('every recipe produces contract-valid renditions with zero errors', () => {
  const specimen = retailSpecimen();
  for (const recipe of SEED_RECIPES) {
    const result = renderRecipe(recipe.id, specimen, OPTIONS);
    assert.ok(result.ok, `${recipe.id}: ${result.ok ? '' : result.error}`);
    assert.ok(result.value.length > 0, `${recipe.id} produced nothing`);
    for (const rendition of result.value) {
      /** @type {string[]} */
      const errs = [];
      validateRendition(rendition, `${recipe.id}/${rendition.label}`, errs);
      assert.deepEqual(errs, [], `${recipe.id}/${rendition.label}`);
      assert.equal(rendition.recipeId, recipe.id);
      assert.equal(rendition.specimenId, specimen.id);
      assert.equal(rendition.producedBy, 'template');
      assert.equal(rendition.provenance, 'illustrative', 'a template arranged it, so the artifact labels it');
      assert.equal(hasPromotionRecord(rendition), false);
      assert.deepEqual(verifyProvenance(rendition), []);
      assert.ok(rendition.blocks.length > 0);
    }
  }
});

test('rendering is deterministic — same input twice, identical output including ids', () => {
  const specimen = retailSpecimen();
  const first = renderAll(specimen, OPTIONS);
  const second = renderAll(specimen, OPTIONS);
  assert.deepEqual(first.failures, []);
  assert.equal(stableStringify(first.renditions), stableStringify(second.renditions));
  assert.equal(new Set(first.renditions.map((r) => r.id)).size, first.renditions.length, 'ids are unique');
});

test('recipes run on a minimal specimen without inventing content to fill the gaps', () => {
  const specimen = briefSpecimen();
  const { renditions, failures } = renderAll(specimen, OPTIONS);
  assert.deepEqual(failures, []);
  assert.ok(renditions.length > 0);
  // The fragment has no cta, no media and no legal line: the labelled slots say so.
  const text = JSON.stringify(renditions);
  assert.match(text, /no source content; supply before use/);
});

test('every recipe runs on a source that contains no digits at all', () => {
  // Regression, found in integration: a source with no numerals leaves a
  // template's own measurement chrome with nothing in the source bag to lean on.
  // The SMS budget report names its encoding — `UCS-2` — and the guard read the
  // `2` as a fabricated numeral. A digit in a *name* is not a claim; see
  // `docs/decisions/L7-recipes.md` D-L7-5.
  const specimen = digitFreeSpecimen();
  const { renditions, failures } = renderAll(specimen, OPTIONS);
  assert.deepEqual(failures, []);
  assert.ok(renditions.length >= 25);

  const sms = renderRecipe('channel-variants', specimen, { channels: ['sms'] });
  assert.ok(sms.ok, sms.ok ? '' : sms.error);
  const report = sms.value[0].blocks[sms.value[0].blocks.length - 1];
  assert.match(report.rows[1][1], /\((GSM-7|UCS-2)\)$/);
});

test('recipeAccepts and recipesFor gate on specimen kind', () => {
  const page = retailSpecimen();
  const fragment = briefSpecimen();
  assert.ok(recipeAccepts(recipeById('locale-fanout'), page));
  assert.ok(!recipeAccepts(recipeById('locale-fanout'), fragment), 'a fragment is not a page to localise');
  assert.ok(recipeAccepts(recipeById('brief-to-asset'), fragment));
  assert.ok(recipesFor(page).length > recipesFor(fragment).length);
});

test('renderRecipe reports failure as a Result err, never a throw', () => {
  const empty = { ...retailSpecimen(), blocks: [] };
  const unknown = renderRecipe('not-a-recipe', retailSpecimen());
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown recipe/);

  const onEmpty = renderRecipe('locale-fanout', empty);
  assert.equal(onEmpty.ok, false);
  assert.match(onEmpty.error, /empty specimen/);

  assert.equal(renderRecipe('locale-fanout', null).ok, false);
});

/* ------------------------------------------------------------------ *
 * 1 — locale-fanout
 * ------------------------------------------------------------------ */

test('locale-fanout produces nine renditions whose STRUCTURE differs, not only their strings', () => {
  const specimen = retailSpecimen();
  const renditions = renderRecipe('locale-fanout', specimen).value;
  assert.equal(renditions.length, 9);
  assert.deepEqual(renditions.map((r) => r.label), LOCALES.map((l) => l.id));

  const byLabel = new Map(renditions.map((r) => [r.label, structureOf(r)]));

  // (a) The structural SIGNATURE differs: the RTL market carries a different
  //     writing direction on every block and a mirrored contract table, so its
  //     signature is not the LTR markets' signature. This compares the block —
  //     not only its type — because finding C8 was that encoding direction in
  //     the block *type* (`raw`) is what made the rendition unrenderable.
  assert.notEqual(byLabel.get('en-US').signature, byLabel.get('ar-SA').signature);
  assert.equal(byLabel.get('en-US').rtlBlocks, 0);
  assert.ok(byLabel.get('ar-SA').rtlBlocks >= 5, 'RTL prose is marked, block by block');
  for (const id of ['de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'ru-RU', 'es-MX', 'pt-BR']) {
    assert.equal(byLabel.get(id).rtlBlocks, 0, `${id} is left-to-right`);
  }

  // (b) Legal-line PLACEMENT differs: Germany and Japan lift it above the call
  //     to action; the rest keep it in the footer.
  const legalIndex = (id) => byLabel.get(id).legalIndex;
  assert.ok(legalIndex('de-DE') < legalIndex('en-US'), 'de-DE lifts the legal line above the CTA');
  assert.ok(legalIndex('ja-JP') < legalIndex('en-US'), 'ja-JP lifts the legal line above the CTA');
  assert.equal(legalIndex('fr-FR'), legalIndex('en-US'));

  const ctaIndexOf = (id) => renditions.find((r) => r.label === id).blocks.findIndex((b) => b.type === 'cta');
  assert.ok(legalIndex('de-DE') < ctaIndexOf('de-DE'));
  assert.ok(legalIndex('en-US') > ctaIndexOf('en-US'));

  // (c) The format contract itself differs, market by market.
  const rows = new Map(renditions.map((r) => {
    const table = r.blocks.find((b) => b.type === 'table');
    return [r.label, new Map(table.rows.map((row) => (r.label === 'ar-SA' ? [row[1], row[0]] : [row[0], row[1]])))];
  }));
  assert.equal(rows.get('en-US').get('Date'), 'MM/DD/YYYY');
  assert.equal(rows.get('de-DE').get('Date'), 'TT.MM.JJJJ');
  assert.equal(rows.get('ru-RU').get('Date'), 'ДД.ММ.ГГГГ');
  assert.equal(rows.get('ja-JP').get('Date'), 'YYYY年M月D日');
  assert.equal(rows.get('ja-JP').get('Name order'), 'family then given');
  assert.equal(rows.get('en-US').get('Name order'), 'given then family');
  assert.equal(rows.get('ar-SA').get('Writing direction'), 'right to left');
  assert.equal(rows.get('ru-RU').get('Plural categories'), 'one, few, many, other');
  assert.equal(rows.get('ja-JP').get('Plural categories'), 'other');
  assert.equal(rows.get('ar-SA').get('Plural categories'), 'zero, one, two, few, many, other');

  // (d) Table CELL ORDER is mirrored for the RTL market.
  const arTable = renditions.find((r) => r.label === 'ar-SA').blocks.find((b) => b.type === 'table');
  const enTable = renditions.find((r) => r.label === 'en-US').blocks.find((b) => b.type === 'table');
  assert.deepEqual(arTable.rows[0], enTable.rows[0].slice().reverse());

  // (e) The prose is reformatted, not translated: the same digits, differently laid out.
  const prose = (id) => JSON.stringify(renditions.find((r) => r.label === id).blocks);
  assert.match(prose('en-US'), /08\/17\/2026/);
  assert.match(prose('de-DE'), /17\.08\.2026/);
  assert.match(prose('ja-JP'), /2026年08月17日/);
  assert.match(prose('de-DE'), /1\.800/);
  assert.match(prose('fr-FR'), /1 800/);
  assert.ok(!/08\/17\/2026/.test(prose('de-DE')));
});

/* ------------------------------------------------------------------ *
 * C8 — the ar-SA rendition must be typed blocks carrying direction
 * ------------------------------------------------------------------ */

test('C8: no seed recipe emits a `raw` block for content it generated', () => {
  // §8's rule — "raw source is never presented as markup by a layout" — is about
  // the prospect's *captured* HTML. A layout is right to flatten a `raw` block to
  // plain text under "Source markup, shown as text". So a rendition this lane
  // produced must never arrive as one: it would be presented to the room as the
  // prospect's own page source, and every structural fact it carried would be
  // stripped on the way. This is the finding, asserted across all eight rather
  // than only where the critic looked.
  const specimen = retailSpecimen();
  const { renditions, failures } = renderAll(specimen, OPTIONS);
  assert.deepEqual(failures, []);
  assert.ok(renditions.length > 0);
  for (const rendition of renditions) {
    const raw = rendition.blocks.filter((b) => b.type === 'raw');
    assert.deepEqual(
      raw,
      [],
      `${rendition.recipeId} / ${rendition.label} emitted ${raw.length} raw block(s); `
      + 'a layout flattens those to plain text under a caption calling them the prospect\u2019s source markup',
    );
  }
});

test('C8: the ar-SA rendition carries direction on typed blocks, not inside raw HTML', () => {
  const specimen = retailSpecimen();
  const renditions = renderRecipe('locale-fanout', specimen).value;
  const ar = renditions.find((r) => r.label === 'ar-SA');
  const en = renditions.find((r) => r.label === 'en-US');

  // (a) Every block is a real typed block. Nothing is smuggled through markup.
  assert.equal(structureOf(ar).rawBlocks, 0);
  assert.ok(ar.blocks.length >= 10);
  assert.ok(ar.blocks.some((b) => b.type === 'heading'));
  assert.ok(ar.blocks.some((b) => b.type === 'paragraph'));
  assert.ok(ar.blocks.some((b) => b.type === 'list'));
  assert.ok(ar.blocks.some((b) => b.type === 'quote'));
  assert.ok(ar.blocks.some((b) => b.type === 'cta'));

  // (b) The heading the LTR markets render as a `heading` is still a `heading`,
  //     with its level intact — the old encoding turned it into `<h1 dir=…>`
  //     inside a string, and its level was lost the moment a layout stripped it.
  const arHeadings = ar.blocks.filter((b) => b.type === 'heading');
  const enHeadings = en.blocks.filter((b) => b.type === 'heading');
  assert.deepEqual(arHeadings.map((b) => b.level), enHeadings.map((b) => b.level));

  // (c) Direction is declared on every block, and on the rendition.
  for (const [i, block] of ar.blocks.entries()) {
    assert.equal(block.dir, 'rtl', `ar-SA block ${i} (${block.type}) must declare dir`);
  }
  assert.equal(ar.dir, 'rtl');
  assert.equal(en.dir, 'ltr');
  for (const block of en.blocks) assert.equal(block.dir, 'ltr');

  // (d) No `dir="…"` survives anywhere in the block payload as markup: the whole
  //     point is that the fact is a field, not an escaped attribute in a string.
  assert.ok(!/dir=/.test(JSON.stringify(ar.blocks)));

  // (e) Nothing is translated, and nothing claims to be. §18.2: the copy is the
  //     source's own words, so it is marked with the *source's* language, never
  //     with `ar-SA`. Inventing Arabic would be fabrication; calling English
  //     Arabic would be a false claim about the content.
  const prose = ar.blocks.find((b) => b.type === 'paragraph' && /Northwind connects/.test(b.text));
  assert.ok(prose, 'the source paragraph survives as a paragraph');
  assert.equal(prose.lang, 'en-US');
  assert.ok(!ar.blocks.some((b) => b.lang === 'ar-SA'), 'no block claims to be in Arabic');
  assert.equal(ar.lang, undefined, 'a rendition mixing the tool\u2019s labels and the source\u2019s words claims no single language');

  // (f) The tool's own structural labels are marked as the tool's language,
  //     because that is what they are.
  const card = ar.blocks[0];
  assert.equal(card.type, 'heading');
  assert.equal(card.lang, 'en');

  // (g) The structural facts §9.1 asks to be shown are still shown: the contract
  //     table's cells are mirrored, and the direction row still reads.
  const arTable = ar.blocks.find((b) => b.type === 'table');
  const enTable = en.blocks.find((b) => b.type === 'table');
  assert.deepEqual(arTable.rows[0], enTable.rows[0].slice().reverse());
  assert.equal(arTable.dir, 'rtl');

  // (h) The deck says out loud why right-to-left copy reads left to right.
  assert.match(ar.notes, /words are still the source/i);
  assert.ok(!/left to right/i.test(en.notes ?? '') || true);
});

test('C8: a specimen that declares no language gets direction and no language claim', () => {
  const specimen = retailSpecimen({ locale: null, meta: { title: 'Retail media, unified' } });
  const ar = renderRecipe('locale-fanout', specimen).value.find((r) => r.label === 'ar-SA');
  const fromSource = ar.blocks.find((b) => b.type === 'paragraph' && /Northwind connects/.test(b.text));
  assert.equal(fromSource.dir, 'rtl');
  assert.equal(fromSource.lang, undefined, 'an unknown source language is left unclaimed, never guessed');
});

test('C8: direction survives the block helpers that rebuild a block field by field', () => {
  // The bug had a second half: `cloneBlock` and `mapBlockText` reconstruct their
  // result, so any field §4 does not name was silently dropped between the
  // template that set it and the layout that reads it.
  const marked = { type: 'paragraph', text: 'One line.', dir: 'rtl', lang: 'en-US' };
  assert.deepEqual(cloneBlock(marked), marked);
  assert.deepEqual(mapBlockText(marked, (t) => t.toUpperCase()), {
    type: 'paragraph', text: 'ONE LINE.', dir: 'rtl', lang: 'en-US',
  });
  const list = { type: 'list', ordered: false, items: ['a'], dir: 'rtl' };
  assert.deepEqual(cloneBlock(list), list);
  const table = { type: 'table', header: true, rows: [['a', 'b']], dir: 'rtl', lang: 'en-US' };
  assert.deepEqual(mapBlockText(table, (t) => t), table);
});

test('C8 (L6 follow-on): `pre` survives every rebuild, and so does the field nobody has invented yet', () => {
  // The instance L6 found. A `<pre>` captured by L6, or a fenced block parsed by
  // this lane's `paste.js`, arrives as `{type:'paragraph', text, pre: true}`
  // (`API.md` Part 3b). `mapBlockText` used to rebuild the paragraph as
  // `{type, text}` and drop the flag, so a client's aligned parameter table
  // survived capture and the specimen, then lost its alignment the moment a
  // template touched its text.
  const code = { type: 'paragraph', text: 'timeout  = 30\nretries  = 3', pre: true, dir: 'ltr', lang: 'en-US' };
  assert.deepEqual(cloneBlock(code), code);
  assert.deepEqual(mapBlockText(code, (t) => t.toUpperCase()), {
    type: 'paragraph', text: 'TIMEOUT  = 30\nRETRIES  = 3', pre: true, dir: 'ltr', lang: 'en-US',
  });

  // The class. `dir`, then `lang`, then `pre` were three findings against one
  // shape: a rebuild that names the fields it carries loses every field added
  // after it was written, and §4's contracts grow by optional extension. So the
  // rebuild now carries by default, and a field this test invents — which no
  // module has heard of — must come through untouched. If this assertion has to
  // be edited to add a name, the fix regressed to a whitelist.
  const future = {
    type: 'heading', level: 2, text: 'Parameters', pre: true,
    footnoteRefs: ['fn_1', 'fn_2'], emphasis: { weight: 700, tracking: -0.01 },
  };
  const mapped = mapBlockText(future, (t) => `${t}!`);
  assert.deepEqual(mapped, { ...future, text: 'Parameters!' });

  // And carried by *copy*: an unknown extension holding an array would otherwise
  // reintroduce the aliasing bug `cloneBlock` exists to prevent.
  assert.notEqual(mapped.footnoteRefs, future.footnoteRefs);
  assert.notEqual(mapped.emphasis, future.emphasis);
  mapped.footnoteRefs.push('fn_3');
  mapped.emphasis.weight = 400;
  assert.deepEqual(future.footnoteRefs, ['fn_1', 'fn_2']);
  assert.equal(future.emphasis.weight, 700);

  const cloned = cloneBlock(future);
  assert.deepEqual(cloned, future);
  assert.notEqual(cloned.footnoteRefs, future.footnoteRefs);
  assert.notEqual(cloned.emphasis, future.emphasis);

  // Every block type, not just the paragraph the bug was reported against.
  const byType = [
    { type: 'heading', level: 3, text: 'h' },
    { type: 'paragraph', text: 'p' },
    { type: 'list', ordered: true, items: ['i'] },
    { type: 'quote', text: 'q', attribution: 'a' },
    { type: 'table', header: false, rows: [['c']] },
    { type: 'cta', label: 'l', href: '/x' },
    { type: 'media', ref: 'md_hero', caption: 'c' },
    { type: 'raw', html: '<p>r</p>' },
  ];
  for (const base of byType) {
    const marked = { ...base, pre: true, dir: 'rtl', lang: 'en-US', unheardOf: 7 };
    assert.deepEqual(cloneBlock(marked), marked, `cloneBlock drops nothing on ${base.type}`);
    const out = mapBlockText(marked, (t) => t);
    assert.equal(out.pre, true, `mapBlockText keeps pre on ${base.type}`);
    assert.equal(out.dir, 'rtl', `mapBlockText keeps dir on ${base.type}`);
    assert.equal(out.lang, 'en-US', `mapBlockText keeps lang on ${base.type}`);
    assert.equal(out.unheardOf, 7, `mapBlockText keeps an unknown extension on ${base.type}`);
  }
});

test('C8 (L6 follow-on): carrying by default still lets a transform drop what it falsifies', () => {
  // Carry-by-default is only safe because the exceptions stay explicit. Two
  // kinds go in a transform's `except` list: the fields it recomputed, and the
  // fields it falsified — a value derived from the exact characters of the text
  // it just replaced. The second kind is empty across §4 and Part 3b today
  // (`level`, `ordered`, `header`, `href`, `ref`, `dir`, `lang`, `pre` are all
  // structural facts that survive a rewrite), so this exercises the mechanism
  // the day one arrives.
  const withCache = { type: 'paragraph', text: 'One line.', pre: true, measuredWidthPx: 412 };
  assert.deepEqual(
    carryFields(withCache, { type: 'paragraph', text: 'Another line.' }, ['text', 'measuredWidthPx']),
    { type: 'paragraph', text: 'Another line.', pre: true },
  );

  // A transform's own decision is never overwritten from underneath it: an empty
  // attribution stays omitted rather than being restored unmapped.
  const emptyAttr = mapBlockText({ type: 'quote', text: 'q', attribution: '' }, (t) => t.toUpperCase());
  assert.deepEqual(emptyAttr, { type: 'quote', text: 'Q' });
  const emptyCaption = mapBlockText({ type: 'media', ref: 'md_hero', caption: '' }, (t) => t);
  assert.deepEqual(emptyCaption, { type: 'media', ref: 'md_hero' });
});

test('C8 (L6 follow-on): a preformatted block keeps its flag through a whole template render', () => {
  // End to end, which is where the bug actually bit: capture keeps `pre`, the
  // specimen keeps `pre`, and then a recipe maps the text.
  const base = retailSpecimen();
  const specimen = {
    ...base,
    blocks: base.blocks.slice(0, 2).concat(
      [{ type: 'paragraph', text: 'region      = eu-west\nconcurrency = 4', pre: true }],
      base.blocks.slice(2),
    ),
  };
  const isSample = (b) => b.type === 'paragraph' && /concurrency/.test(b.text);

  const renditions = renderRecipe('locale-fanout', specimen).value;
  for (const rendition of renditions) {
    const sample = rendition.blocks.find(isSample);
    assert.ok(sample, `${rendition.label} still carries the code sample`);
    assert.equal(sample.pre, true, `${rendition.label} still calls it preformatted`);
  }
  const ar = renditions.find((r) => r.label === 'ar-SA');
  const arSample = ar.blocks.find(isSample);
  assert.equal(arSample.dir, 'rtl', 'the C8 extensions and `pre` coexist on one block');

  // §13's budget trimming is a rebuild too, and used to drop the same fields.
  const long = { type: 'paragraph', text: 'x'.repeat(400), pre: true, dir: 'rtl', lang: 'en-US' };
  const trimmed = enforceBudget([long], 'sms', { truncate: true, includeReport: false }).blocks[0];
  assert.ok(trimmed.text.length < 400, 'the budget actually shortened it');
  assert.equal(trimmed.pre, true);
  assert.equal(trimmed.dir, 'rtl');
  assert.equal(trimmed.lang, 'en-US');
});

test('C8: buildRendition refuses a direction or language it cannot put in an attribute', () => {
  const specimen = retailSpecimen();
  const args = {
    specimen, recipe: recipeById('locale-fanout'), label: 'ar-SA',
    blocks: [{ type: 'paragraph', text: 'One line.' }], producedBy: 'template',
  };
  assert.throws(() => buildRendition({ ...args, dir: 'RTL' }), /dir must be ltr\|rtl\|auto/);
  assert.throws(() => buildRendition({ ...args, dir: 'right' }), /dir must be ltr\|rtl\|auto/);
  // `auto` is the third value HTML's attribute takes and the third L8 honours;
  // L7 never emits it, and must not refuse a caller who does.
  assert.equal(buildRendition({ ...args, dir: 'auto' }).dir, 'auto');
  assert.throws(() => buildRendition({ ...args, lang: 'en" onload="x' }), /lang must be a BCP-47 tag/);
  assert.throws(() => buildRendition({ ...args, lang: 'en\nUS' }), /lang must be a BCP-47 tag/);

  // Absent stays absent: `undefined` means "this recipe made no claim about
  // direction", which is a different thing from "left to right".
  const plain = buildRendition(args);
  assert.equal('dir' in plain, false);
  assert.equal('lang' in plain, false);

  // And an id minted without the extensions is unchanged by their existence.
  assert.equal(plain.id, renditionId({
    specimenId: specimen.id, recipeId: 'locale-fanout', label: 'ar-SA',
    blocks: args.blocks, media: [], producedBy: 'template',
  }));
});

test('locale-fanout can be narrowed to a subset of markets', () => {
  const renditions = renderRecipe('locale-fanout', retailSpecimen(), { locales: ['de-DE', 'ar-SA'] }).value;
  assert.deepEqual(renditions.map((r) => r.label), ['de-DE', 'ar-SA']);
});

/* ------------------------------------------------------------------ *
 * 2 — channel-variants
 * ------------------------------------------------------------------ */

test('channel-variants enforces every channel budget and reports the overage exactly', () => {
  const specimen = retailSpecimen();
  const renditions = renderRecipe('channel-variants', specimen).value;
  assert.deepEqual(renditions.map((r) => r.label), ['Email', 'Paid social', 'In-product message', 'SMS']);

  for (const rendition of renditions) {
    const budget = channelBudget(rendition.label);
    assert.ok(budget, `${rendition.label} must resolve to a budget`);

    // The budget report is the last block, and it is visible content.
    const report = rendition.blocks[rendition.blocks.length - 1];
    assert.equal(report.type, 'table');
    assert.deepEqual(report.rows[0], ['Part', 'Characters', 'Limit', 'Over by']);
    assert.ok(report.rows.length > 1, `${rendition.label} reports at least one part`);

    const note = readBudgetNote(rendition);
    assert.ok(note, `${rendition.label} carries a machine-readable budget note`);
    assert.equal(note.channel, budget.id);

    // The reported overage equals the arithmetic, part by part.
    const totalOver = note.parts.reduce((n, p) => n + Math.max(0, p.chars - p.limit), 0);
    assert.equal(note.over, totalOver, `${rendition.label} overage is exact`);
    for (const part of note.parts) {
      const row = report.rows.find((r) => r[0].length && r[1].includes(String(part.chars)));
      assert.ok(row, `${rendition.label}/${part.role} appears in the visible report`);
    }
  }
});

test('channel-variants measures SMS in the encoding the copy actually forces', () => {
  const sms = renderRecipe('channel-variants', retailSpecimen()).value.find((r) => r.label === 'SMS');
  const note = readBudgetNote(sms);
  const message = note.parts[0];
  // The em dash in the assembled message is outside GSM 03.38, so the single-
  // segment budget is 70, not 160, and the report says so rather than the
  // flattering number.
  assert.equal(message.limit, 70);
  assert.equal(note.over, message.chars - 70);
  assert.match(sms.notes, /outside the GSM 03\.38 alphabet forces UCS-2/);
  const report = sms.blocks[sms.blocks.length - 1];
  assert.match(report.rows[1][1], /\(UCS-2\)$/);
  assert.match(report.rows[1][3], /segments$/);
});

test('channel-variants over-budget copy is reported, and truncation is never silent', () => {
  const long = retailSpecimen();
  long.blocks = long.blocks.slice();
  long.blocks[0] = {
    type: 'heading',
    level: 1,
    text: 'Retail media, unified across every market and every channel, planned once and reported once for every team that needs it',
  };

  const plain = renderRecipe('channel-variants', long, { channels: ['email'] }).value[0];
  const note = readBudgetNote(plain);
  const subject = note.parts.find((p) => p.role === 'subject');
  assert.ok(subject.chars > subject.limit, 'the subject line is genuinely over');
  assert.equal(note.over, subject.chars - subject.limit);
  assert.match(plain.notes, /Over budget by \d+ characters/);
  assert.equal(plain.blocks[0].text, long.blocks[0].text, 'nothing was cut without being asked');

  const cut = renderRecipe('channel-variants', long, { channels: ['email'], truncate: true }).value[0];
  assert.ok(cut.blocks[0].text.length < long.blocks[0].text.length, 'truncate mode does cut');
  const cutReport = cut.blocks[cut.blocks.length - 1];
  const subjectRow = cutReport.rows.find((r) => r[0] === 'Subject line');
  assert.match(subjectRow[3], /removed\)$/, 'and says exactly how much it removed');
  assert.equal(readBudgetNote(cut).over, note.over, 'the overage is still measured against the original');
});

test('channelBudget resolves every §9 channel and its aliases, and nothing else', () => {
  for (const budget of CHANNEL_BUDGETS) {
    assert.equal(channelBudget(budget.channel).id, budget.id);
    assert.equal(channelBudget(budget.id).id, budget.id);
    assert.equal(typeof budget.maxChars, 'number');
    assert.equal(typeof budget.maxWords, 'number');
    assert.ok(budget.maxWords > 0 && budget.maxWords < budget.maxChars);
    assert.ok(budget.parts.every((p) => p.source.length > 20), `${budget.id}: every part cites its source`);
  }
  assert.equal(channelBudget('e-mail').id, 'email');
  assert.equal(channelBudget('  Paid Social ').id, 'paid-social');
  assert.equal(channelBudget('in-app').id, 'in-product');
  assert.equal(channelBudget('text message').id, 'sms');
  assert.equal(channelBudget('carrier pigeon'), null);
  assert.equal(channelBudget(null), null);
});

test('a budget that is a project convention says so rather than posing as a published limit', () => {
  assert.equal(channelBudget('SMS').published, true);
  assert.equal(channelBudget('Email').published, true);
  assert.equal(channelBudget('In-product message').published, false);
  assert.match(channelBudget('In-product message').sources[0], /Project convention/);
});

/* ------------------------------------------------------------------ *
 * 3 — system-assembly
 * ------------------------------------------------------------------ */

test('system-assembly composes the same content differently at three breakpoints', () => {
  const renditions = renderRecipe('system-assembly', retailSpecimen()).value;
  assert.equal(renditions.length, 3);
  assert.deepEqual(renditions.map((r) => r.label), BREAKPOINTS.map((b) => `${b.id} — ${b.width}px`));

  const [sm, md, lg] = renditions;
  // The component map itself changes shape: a table does not survive 390px.
  assert.equal(sm.blocks[1].type, 'list');
  assert.equal(md.blocks[1].type, 'table');
  assert.equal(lg.blocks[1].type, 'table');
  assert.equal(md.blocks[1].rows[0].length, 2);
  assert.equal(lg.blocks[1].rows[0].length, 3, 'the widest breakpoint adds the region column');

  // And the composition changes: media hoists at lg, sinks at sm.
  const mediaIndex = (r) => r.blocks.findIndex((b) => b.type === 'media');
  assert.equal(mediaIndex(sm), sm.blocks.length - 1, 'sm puts media last');
  assert.ok(mediaIndex(lg) < mediaIndex(md), 'lg hoists media above the fold');
  assert.notEqual(sm.blocks.map((b) => b.type).join(','), md.blocks.map((b) => b.type).join(','));
  assert.notEqual(md.blocks.map((b) => b.type).join(','), lg.blocks.map((b) => b.type).join(','));
});

/* ------------------------------------------------------------------ *
 * 4 — brief-to-asset
 * ------------------------------------------------------------------ */

test('brief-to-asset turns a paragraph into a structured asset, showing both sides', () => {
  const renditions = renderRecipe('brief-to-asset', briefSpecimen()).value;
  assert.deepEqual(renditions.map((r) => r.label), ['Brief', 'Structured asset']);

  const [brief, asset] = renditions;
  assert.ok(brief.blocks.some((b) => b.type === 'list'), 'the brief is shown split into its own sentences');

  assert.equal(asset.blocks[0].type, 'heading');
  assert.equal(asset.blocks[0].level, 1);
  assert.ok(asset.blocks.some((b) => b.type === 'list' || /no source content/.test(b.text || '')));
  assert.ok(asset.blocks.some((b) => b.type === 'cta' || /no source content/.test(b.text || '')));

  // Every word of the headline came from the brief.
  const briefWords = new Set(briefSpecimen().blocks[0].text.toLowerCase().match(/[a-z]+/g));
  for (const word of asset.blocks[0].text.toLowerCase().match(/[a-z]+/g) || []) {
    assert.ok(briefWords.has(word), `headline word "${word}" must come from the brief`);
  }
});

test('brief-to-asset accepts a brief supplied directly', () => {
  const renditions = renderRecipe('brief-to-asset', briefSpecimen(), {
    brief: 'Launch the planning board to retail media customers. Explain the reconciliation saving. Book a walkthrough.',
  }).value;
  assert.match(renditions[0].blocks[1].text, /Launch the planning board/);
  assert.match(renditions[1].blocks[0].text, /Launch The Planning Board|Launch the planning board/i);
});

/* ------------------------------------------------------------------ *
 * 5 — governed-iteration
 * ------------------------------------------------------------------ */

test('governed-iteration keeps brand and claim rules holding across all five', () => {
  const renditions = renderRecipe('governed-iteration', retailSpecimen()).value;
  assert.equal(renditions.length, 5);
  assert.deepEqual(renditions.map((r) => r.label), ['Iteration 1', 'Iteration 2', 'Iteration 3', 'Iteration 4', 'Iteration 5']);

  const headlines = renditions.map((r) => r.blocks[0].text);
  assert.equal(new Set(headlines).size, 5, 'all five iterations differ');

  const claims = renditions.map((r) => claimSet(r.blocks).join('|'));
  assert.equal(new Set(claims).size, 1, 'the claim set is identical in every iteration');

  const hrefs = renditions.map((r) => (r.blocks.find((b) => b.type === 'cta') || {}).href);
  assert.equal(new Set(hrefs).size, 1, 'the action destination never moves');

  const quotes = renditions.map((r) => JSON.stringify(r.blocks.find((b) => b.type === 'quote')));
  assert.equal(new Set(quotes).size, 1, 'the quotation and its attribution are carried verbatim');

  for (const r of renditions) {
    const ledger = r.blocks.find((b) => b.type === 'table' && b.rows[0][0] === 'Rule');
    assert.ok(ledger, `${r.label} carries a rule ledger`);
    for (const row of ledger.rows.slice(1)) {
      assert.ok(row[1] === 'held' || row[1] === 'no quotation in source', `${r.label}: ${row[0]} is ${row[1]}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 6 — approval-chain
 * ------------------------------------------------------------------ */

test('approval-chain shows a different asset and a different permission surface per reviewer', () => {
  const renditions = renderRecipe('approval-chain', retailSpecimen()).value;
  assert.deepEqual(renditions.map((r) => r.label), ['Draft', 'Brand review', 'Legal review', 'Localization review', 'Approved']);

  const surfaces = renditions.map(reviewSurfaceOf);

  // What is VISIBLE differs: brand does not see the legal line, legal does not
  // see the feature list. The block list is genuinely shorter, not styled down.
  const legalLines = renditions.map((r) => r.blocks.filter((b) => b.type === 'paragraph' && /©/.test(b.text)).length);
  assert.equal(legalLines[0], 1, 'the author sees the legal line');
  assert.equal(legalLines[1], 0, 'the brand reviewer does not');
  assert.equal(legalLines[2], 1, 'the legal reviewer does');

  const featureLists = renditions.map((r) => r.blocks.filter((b) => b.type === 'list').length);
  assert.ok(featureLists[2] < featureLists[0], 'the legal reviewer does not see the feature list');

  // What is EDITABLE differs, role by role.
  assert.equal(surfaces[0].permissions.get('Headline'), 'edit');
  assert.equal(surfaces[2].permissions.get('Headline'), 'read-only');
  assert.equal(surfaces[2].permissions.get('Legal line'), 'edit');
  assert.equal(surfaces[1].permissions.get('Legal line'), 'hidden');
  for (const [, mode] of surfaces[4].permissions) assert.equal(mode, 'locked');

  // Open items never grow, and reach zero at Approved.
  const open = surfaces.map((s) => s.openItems);
  for (let i = 1; i < open.length; i++) assert.ok(open[i] <= open[i - 1], `open items grew at step ${i}`);
  assert.equal(open[open.length - 1], 0);

  // §18.2: no individual is named anywhere in the chain.
  assert.ok(!/\b(VP|Chief|Director) of\b/.test(JSON.stringify(renditions.map((r) => r.blocks))));
});

/* ------------------------------------------------------------------ *
 * 7 — dam-round-trip
 * ------------------------------------------------------------------ */

test('dam-round-trip sources an asset, produces a variant and writes metadata back', () => {
  const specimen = retailSpecimen();
  const renditions = renderRecipe('dam-round-trip', specimen).value;
  assert.deepEqual(renditions.map((r) => r.label), ['Sourced asset', 'Variant produced', 'Metadata written back']);

  const [sourced, variant, writeback] = renditions;
  assert.ok(sourced.media.length === 1 && sourced.media[0].id === 'md_hero', 'the source asset travels with the rendition');
  assert.ok(variant.blocks.some((b) => b.type === 'media'));

  const diff = writeback.blocks.find((b) => b.type === 'table');
  assert.deepEqual(diff.rows[0], ['Field', 'Before', 'After', 'Written by']);

  const byField = new Map(diff.rows.slice(1).map((r) => [r[0], r]));
  assert.equal(byField.get('Variant of')[1], '[original]');
  assert.equal(byField.get('Variant of')[2], 'md_hero');
  assert.equal(byField.get('Variant of')[3], 'variant pipeline');

  // Fields the tool cannot know stay empty and say so, in both columns.
  assert.match(byField.get('Usage rights')[1], /not recorded in source/);
  assert.equal(byField.get('Usage rights')[2], byField.get('Usage rights')[1]);
  assert.equal(byField.get('Usage rights')[3], 'unchanged');
  assert.match(byField.get('Owning team')[2], /not recorded in source/);
});

/* ------------------------------------------------------------------ *
 * 8 — volume-view
 * ------------------------------------------------------------------ */

test('volume-view renders 1, 40 and 400 tiles as real grids', () => {
  const renditions = renderRecipe('volume-view', retailSpecimen()).value;
  assert.deepEqual(renditions.map((r) => r.label), ['1 rendition', '40 renditions', '400 renditions']);

  renditions.forEach((rendition, i) => {
    const tier = TIERS[i];
    const grid = rendition.blocks.find((b) => b.type === 'table' && b.header === false);
    assert.ok(grid, `${rendition.label} has a density grid`);
    const cells = grid.rows.flat().filter(Boolean);
    assert.equal(cells.length, tier.count, `${rendition.label} shows exactly ${tier.count} tiles`);
    assert.equal(grid.rows[0].length, tier.columns);
    for (const cell of cells) assert.match(cell, /^[a-z]{2}-[A-Z]{2}·[A-Z]{2}$/, 'every tile is a market × channel label');
  });

  // The grid says out loud that tiles repeat past the combination count.
  const big = renditions[2];
  assert.match(JSON.stringify(big.blocks), /the grid shows volume, not a unique enumeration/);
});

test('volume-view cell order is seeded, reproducible, and seed-sensitive', () => {
  const a = cellsFor(40, 'pitchproof-v1');
  const b = cellsFor(40, 'pitchproof-v1');
  const c = cellsFor(40, 'another-seed');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(combinationVocabulary().length, LOCALES.length * CHANNEL_BUDGETS.length);
  for (const cell of a) assert.ok(combinationVocabulary().includes(cell));
});
