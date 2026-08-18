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
} from '../../src/recipe/index.js';
import { structureOf } from '../../src/recipe/templates/locale-fanout.js';
import { readBudgetNote } from '../../src/recipe/templates/channel-variants.js';
import { reviewSurfaceOf } from '../../src/recipe/templates/approval-chain.js';
import { claimSet } from '../../src/recipe/templates/governed-iteration.js';
import { cellsFor, TIERS, combinationVocabulary } from '../../src/recipe/templates/volume-view.js';
import { validateRendition, SPECIMEN_KINDS, BREAKPOINTS } from '../../src/core/contracts.js';
import { stableStringify } from '../../src/core/hash.js';
import { retailSpecimen, briefSpecimen } from '../fixtures/recipe/specimens.mjs';

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

  // (a) Block TYPE sequence differs: the RTL market renders prose as direction-
  //     carrying raw blocks, so its type list is not the LTR markets' type list.
  const ltr = byLabel.get('en-US').types.join(',');
  const rtl = byLabel.get('ar-SA').types.join(',');
  assert.notEqual(ltr, rtl);
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
