/**
 * Regressions from CRITIQUE-1, axis 10 (studio usability under pressure).
 *
 * Each of these is a defect the critic drove the studio into by hand. They are
 * kept together, named after the finding, so the next critic can see at a
 * glance which of its predecessors' findings are still nailed down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { PANELS } from '../../src/ui/panels/index.js';
import { emitBlockers } from '../../src/ui/gate.js';
import { brandGroupEvidence, emptyBrandGroups, reviewableBrandGroups, reviewedGroups } from '../../src/ui/model.js';
import { brandYield, makeServices } from '../../src/ui/services.js';
import { ProjectStore } from '../../src/core/storage.js';
import { fixtureDoc, fakeServices, makeClock, fixtureSpecimen } from '../fixtures/ui/studio-fixture.mjs';

/**
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function makeApp(options = {}) {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: options.services || fakeServices({ clock }), doc: options.doc || fixtureDoc(),
  });
  app.ui.settings.operator = 'Alex Mercer';
  return app;
}

/** A brand with nothing in it: what a failed extraction actually produces. */
function emptyBrandSystem() {
  return {
    id: 'br_empty',
    sourceUrl: 'https://www.northwind.example',
    capturedAt: '2026-02-01T09:00:00.000Z',
    colors: [],
    faces: [],
    logos: [],
    shape: { radiusPx: 0, borderWidthPx: 0, shadowLevel: 0 },
    imagery: { treatment: 'unknown', saturationBias: 0 },
    confidence: { colors: 0, faces: 0, logos: 0, shape: 0, imagery: 0 },
    manualOverrides: [],
  };
}

// ---------------------------------------------------------------- F14 ------

test('F14: the studio can run a seed recipe, not only paste against one', async () => {
  const app = await makeApp();
  app.dispatch('recipe.loadSeed');
  app.select({ specimenId: app.proof.specimens[0].id, recipeId: app.proof.recipes[0].id });

  const before = app.proof.renditions.length;
  app.dispatch('recipe.run', app.proof.recipes[0].id);
  assert.ok(app.proof.renditions.length > before, 'running a recipe produces renditions');
  assert.ok(
    app.proof.renditions.some((r) => r.producedBy === 'template'),
    '§9: the seed library is the reframe payload, and a template is how it pays',
  );
});

test('F14: the whole library runs against a specimen in one act', async () => {
  const app = await makeApp();
  app.dispatch('recipe.loadSeed');
  app.select({ specimenId: app.proof.specimens[0].id });
  const before = app.proof.renditions.length;
  const depth = app.stack.history().length;

  app.dispatch('recipe.runAll');
  assert.ok(app.proof.renditions.length > before);
  assert.equal(app.stack.history().length, depth + 1, 'and it is one undo step, not one per rendition');

  app.stack.undo();
  assert.equal(app.proof.renditions.length, before);
});

test('F14: running the library reaches L7’s real templates', async () => {
  // Against the real lane, not the fake: this is the wiring the critic found
  // missing, so the test that guards it must not be able to pass on a stub.
  const app = await makeApp({ services: makeServices({ clock: makeClock(), http: null }) });
  app.dispatch('recipe.loadSeed');
  assert.equal(app.services.seedRecipes().length, 8, '§9: all eight seed recipes');
  assert.ok(app.proof.recipes.length >= 8, 'and the project holds them');

  const specimen = fixtureSpecimen();
  const applicable = app.services.recipesFor(specimen);
  assert.ok(applicable.length >= 4, `expected several recipes to accept a page, got ${applicable.length}`);

  const rendered = app.services.renderAllRecipes(specimen, { seed: app.doc.seed });
  assert.ok(rendered.ok, rendered.ok ? '' : rendered.error);
  assert.ok(
    rendered.value.renditions.length >= 20,
    `§9 calls the library "the reframe payload"; it produced ${rendered.value.renditions.length} renditions`,
  );
  for (const rendition of rendered.value.renditions) {
    assert.equal(rendition.provenance, 'illustrative', 'every one is illustrative until a human promotes it');
  }
});

test('F14: the Recipes panel offers a route to run each recipe and all of them', async () => {
  const app = await makeApp();
  app.dispatch('recipe.loadSeed');
  app.select({ specimenId: app.proof.specimens[0].id });
  app.ui.section = 'recipes';
  const html = toHtml(PANELS.recipes(app));
  assert.match(html, /data-st-act="recipe\.run" data-st-arg="[^"]+"/, 'a Run control per recipe');
  assert.match(html, /data-st-act="recipe\.runAll"/, 'and one for the whole library');
  assert.match(html, /Run every recipe that fits/);
});

test('F14: a recipe that does not accept the specimen says so instead of failing', async () => {
  const app = await makeApp();
  app.dispatch('recipe.loadSeed');
  app.dispatch('specimen.setKind', app.proof.specimens[0].id, { value: 'image' });
  app.select({ specimenId: app.proof.specimens[0].id });
  const recipe = app.proof.recipes[0];
  const before = app.proof.renditions.length;
  app.dispatch('recipe.run', recipe.id);
  assert.equal(app.proof.renditions.length, before);
  assert.ok(app.ui.notices.some((n) => /takes .*and .* is a image/.test(n.text) || /takes/.test(n.text)));
});

// ---------------------------------------------------------------- F15 ------

test('F15: an empty brand group cannot be reviewed', async () => {
  const doc = fixtureDoc();
  doc.proof.brand = emptyBrandSystem();
  const app = await makeApp({ doc });

  for (const group of ['colors', 'faces', 'logos', 'shape', 'imagery']) {
    assert.equal(brandGroupEvidence(app.proof.brand, group).hasContent, false, `${group} holds nothing`);
  }
  assert.equal(reviewableBrandGroups(app.proof.brand).length, 0);
  assert.equal(emptyBrandGroups(app.proof.brand).length, 5);

  const before = emitBlockers(app).blockers.length;
  app.dispatch('brand.reviewAll');
  assert.deepEqual(reviewedGroups(app.proof.brand), [], 'nothing was signed off');
  assert.equal(
    emitBlockers(app).blockers.length,
    before,
    '§7: reviewing an empty field set is not a review, and must clear no blocker',
  );
});

test('F15: the single-group control refuses an empty group and says why', async () => {
  const doc = fixtureDoc();
  doc.proof.brand = emptyBrandSystem();
  const app = await makeApp({ doc });
  const depth = app.stack.history().length;

  app.dispatch('brand.review', 'colors', { value: true });
  assert.equal(app.stack.history().length, depth, 'no mutation at all');
  assert.deepEqual(reviewedGroups(app.proof.brand), []);
  assert.ok(app.ui.notices.some((n) => /nothing to review/i.test(n.text)));
});

test('F15: an empty group is reported as empty, not merely as unreviewed', async () => {
  const doc = fixtureDoc();
  doc.proof.brand = emptyBrandSystem();
  const app = await makeApp({ doc });
  const kinds = emitBlockers(app).blockers.map((b) => b.kind);
  assert.ok(kinds.includes('BRAND_EMPTY'), 'the blocker names the real problem');
  assert.ok(!kinds.includes('BRAND_UNREVIEWED'), 'and does not pretend a review would fix it');

  app.ui.section = 'brand';
  const html = toHtml(PANELS.brand(app));
  assert.match(html, /cannot be reviewed/i);
  assert.match(html, /no colour roles/i);
  assert.ok(!/I have checked all/.test(html), 'and there is no bulk control that could clear them');
});

test('F15: a group with content is still reviewable, and reviewing it clears its blocker', async () => {
  const app = await makeApp();   // the fixture brand has logos at 41%, with one logo
  const before = emitBlockers(app).blockers.filter((b) => b.kind === 'BRAND_UNREVIEWED').length;
  assert.ok(before > 0, 'the fixture has something below the floor');
  app.dispatch('brand.reviewAll');
  assert.equal(
    emitBlockers(app).blockers.filter((b) => b.kind === 'BRAND_UNREVIEWED').length,
    0,
    'a real review still releases the hold',
  );
});

test('F15: entering a field by hand makes it reviewable', async () => {
  const doc = fixtureDoc();
  doc.proof.brand = emptyBrandSystem();
  const app = await makeApp({ doc });
  assert.equal(brandGroupEvidence(app.proof.brand, 'shape').hasContent, false);

  app.dispatch('brand.setRadius', null, { value: '12' });
  assert.equal(
    brandGroupEvidence(app.proof.brand, 'shape').hasContent,
    true,
    'a hand-entered field is a claim, and a claim can be reviewed',
  );
  app.dispatch('brand.review', 'shape', { value: true });
  assert.ok(reviewedGroups(app.proof.brand).includes('shape'));
});

test('F15: a re-extraction that found less does not inherit the last sign-off', async () => {
  const app = await makeApp();
  app.dispatch('brand.reviewAll');
  assert.ok(reviewedGroups(app.proof.brand).length > 0);

  app.mutate('Re-extract', (doc) => ({ ...doc, proof: { ...doc.proof, brand: emptyBrandSystem() } }));
  // replaceBrand is the route the extract actions take; go through it.
  const { replaceBrand } = await import('../../src/ui/model.js');
  app.mutate('Replace brand', (doc) => replaceBrand(doc, { ...emptyBrandSystem(), reviewedGroups: ['colors', 'faces'] }));
  assert.deepEqual(reviewedGroups(app.proof.brand), [], 'a stale sign-off cannot survive the thing it signed off');
});

// ------------------------------------------------------- F1/F3 honesty -----

test('F1/F3: an extraction that yields nothing is reported as nothing', async () => {
  assert.deepEqual(brandYield(emptyBrandSystem()), {
    empty: true,
    found: [],
    missing: ['colour roles', 'type faces', 'logos', 'shape', 'imagery'],
  });

  const app = await makeApp();
  app.services.buildBrand = () => ({ ok: true, value: emptyBrandSystem() });
  app.setDraft('brand.url', 'https://www.northwind.example');
  await app.dispatch('brand.extract');

  const notice = app.ui.notices.find((n) => n.tone === 'bad');
  assert.ok(notice, '"Brand extracted." over an empty panel is the §18 failure in miniature');
  assert.match(notice.text, /nothing to extract|Nothing could be extracted/i);
  assert.match(notice.text, /proxy|save the page|by hand/i, 'and it names the way forward');
  assert.ok(!app.ui.notices.some((n) => n.tone === 'ok' && /Brand extracted/.test(n.text)));
});

test('F1/F3: a partial extraction says what it found and what it did not', async () => {
  const app = await makeApp();
  app.services.buildBrand = () => ({
    ok: true,
    value: { ...emptyBrandSystem(), colors: [{ role: 'primary', hex: '#123A8C', oklch: [0.36, 0.14, 264], source: 'extracted', contrastWithPair: null }], confidence: { colors: 0.5, faces: 0, logos: 0, shape: 0, imagery: 0 } },
  });
  app.setDraft('brand.url', 'https://www.northwind.example');
  await app.dispatch('brand.extract');
  const notice = app.ui.notices.find((n) => n.tone === 'warn');
  assert.ok(notice);
  assert.match(notice.text, /Extracted colour roles/);
  assert.match(notice.text, /Nothing was found for type faces, logos/);
});

test('F1/F3: the colour solve is fed stylesheet text, not the page source', async () => {
  const { stylesheetSources, logoColorSources } = await import('../../src/ui/services.js');
  const css = 'body{color:#16181D;background:#FFFFFF}h1{color:#123A8C}';
  const capture = {
    html: '<html><head><link rel="stylesheet" href="/a.css"></head><body style="color:#E2574C"><svg><rect fill="#123A8C"/></svg></body></html>',
    doc: null,
  };
  const assets = [{ name: '/a.css', mime: 'text/css', bytes: new TextEncoder().encode(css) }];

  const sheets = stylesheetSources([capture], assets);
  assert.ok(sheets.some((sheet) => sheet.includes('#123A8C')), 'a linked stylesheet is read, which is where a real brand keeps its colour');
  assert.ok(!sheets.some((sheet) => sheet.includes('<html>')), 'and the page source is not passed off as CSS');

  const logos = logoColorSources([capture], []);
  assert.deepEqual(logos, [['#123A8C']], '§7: the logo is a colour source in its own right');
});

test('F14: a new project already carries the §9 library, so nobody has to know to load it', async () => {
  const { mountStudio } = await import('../../src/ui/index.js');
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const services = makeServices({ clock, http: null });
  const app = new StudioApp({ document: null, window: null, store, clock, services });
  assert.equal(app.proof.recipes.length, 8, 'the reframe payload is there on the first screen');
  assert.equal(typeof mountStudio, 'function');

  app.dispatch('project.new');
  assert.equal(app.proof.recipes.length, 8, 'and on every project after it');
});
