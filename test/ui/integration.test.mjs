/**
 * The studio driving the real lanes, end to end.
 *
 * Everything else under `test/ui/` injects a fake adapter, which is right: a
 * panel test should fail for a panel reason. This file does the opposite and
 * runs `makeServices` against L3–L11 as they actually landed, because §1.2's
 * definition of done is a sequence — capture, extract, stage, branch, rehearse,
 * emit — and a sequence is exactly what unit tests do not check.
 *
 * It deliberately asserts studio-level properties rather than lane-level ones.
 * Whether a particular fixture raises `CONTRAST_FAIL` is L11's business and
 * will change; that a blocking finding closes the emit, that a clean sweep
 * opens it, and that the emitted artifact never contains a studio variable are
 * this lane's business and must not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { makeServices } from '../../src/ui/services.js';
import { emitBlockers } from '../../src/ui/gate.js';
import { renderStudio } from '../../src/ui/layout.js';
import { ProjectStore } from '../../src/core/storage.js';
import { makeClock } from '../fixtures/ui/studio-fixture.mjs';
import { fakeServices } from '../fixtures/ui/studio-fixture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A small, self-contained page with chrome, content and a real palette. */
const PAGE = [
  '<!doctype html><html lang="en"><head><title>Industrial coatings that hold</title>',
  '<style>body{color:#16181D;background:#FFFFFF;font-family:Inter,Arial,sans-serif}',
  'h1{color:#123A8C}a{color:#E2574C}.btn{background:#123A8C;color:#FFFFFF;border-radius:6px;border:1px solid #123A8C}</style>',
  '</head><body>',
  '<header><nav><a href="/products">Products</a><a href="/services">Services</a><a href="/about">About</a></nav></header>',
  '<main><h1>Industrial coatings that hold</h1>',
  '<p>Forty years of protecting steel in places nobody wants to go twice.</p>',
  '<ul><li>Offshore platforms</li><li>Rail infrastructure</li><li>Bridge spans</li></ul>',
  '</main>',
  '<footer><p>Northwind Industrial. All rights reserved.</p></footer>',
  '</body></html>',
].join('');

/**
 * A studio wired to the real lanes, with no network available — which is the
 * §6 degraded path every enterprise prospect actually puts you on.
 * @returns {Promise<any>}
 */
async function realApp() {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const runtimeJs = existsSync(join(ROOT, 'dist', 'pitchproof-runtime.js'))
    ? readFileSync(join(ROOT, 'dist', 'pitchproof-runtime.js'), 'utf8') : '';
  const runtimeCss = existsSync(join(ROOT, 'dist', 'pitchproof-runtime.css'))
    ? readFileSync(join(ROOT, 'dist', 'pitchproof-runtime.css'), 'utf8') : '';
  const services = makeServices({ clock, http: null, runtimeJs, runtimeCss });
  const app = new StudioApp({ document: null, window: null, store, clock, services, runtimeJs, runtimeCss });
  app.ui.settings.operator = 'Alex Mercer';
  return app;
}

/**
 * Walk §1.2's flow: paste a page, extract the brand from it, load the recipe
 * library, paste a rendition, stage three scenes, wire a branch.
 * @param {any} app
 */
function assemble(app) {
  app.dispatch('project.setProspect', null, { value: 'Northwind Industrial' });

  app.setDraft('specimen.html', PAGE);
  app.setDraft('specimen.url', 'https://www.northwind.example/coatings');
  app.dispatch('specimen.importPaste');

  const capture = app.services.importHtmlText(PAGE, 'https://www.northwind.example/coatings');
  const brand = app.services.buildBrand([capture.value], { seed: app.doc.seed });
  if (brand.ok) app.mutate('Extract brand', (doc) => ({ ...doc, proof: { ...doc.proof, brand: brand.value } }));

  app.dispatch('recipe.loadSeed');
  app.select({ recipeId: app.proof.recipes[0].id, specimenId: app.proof.specimens[0].id });
  app.setDraft('rendition.paste', '# Industrielle Beschichtungen\n\nVierzig Jahre Stahlschutz.');
  app.setDraft('rendition.label', 'de-DE');
  app.dispatch('rendition.create');

  app.dispatch('scene.add', 'splitBeforeAfter');
  const first = app.proof.spine[0];
  app.dispatch('scene.setHeadline', first.id, { value: 'Your own page, in nine markets' });
  app.dispatch('scene.toggleRendition', `${first.id}|${app.proof.renditions[0].id}`);
  app.dispatch('scene.add', 'quoteCard');
  app.dispatch('scene.add', 'contentsIndex');

  for (const objection of [
    'Our approvals process would never allow this',
    'That works for one page, not four hundred',
    'Legal has to see every claim',
  ]) {
    app.setDraft('branch.objection', objection);
    app.dispatch('branch.create');
  }
  for (const branch of app.proof.branches) {
    app.dispatch('branch.anchorTo', `${branch.id}|${first.id}`);
  }
  return app;
}

test('a page pasted into the studio becomes a specimen with its chrome stripped and restorable', async () => {
  const app = await realApp();
  app.setDraft('specimen.html', PAGE);
  app.dispatch('specimen.importPaste');

  assert.equal(app.ui.notices.filter((n) => n.tone === 'bad').length, 0, app.ui.notices.map((n) => n.text).join(' | '));
  assert.equal(app.proof.specimens.length, 1);
  const specimen = app.proof.specimens[0];
  assert.ok(specimen.blocks.length >= 3, 'the content came through');
  assert.ok(specimen.blocks.some((b) => b.type === 'heading' && /Industrial coatings/.test(b.text)));
  assert.ok(!specimen.blocks.some((b) => /All rights reserved/.test(JSON.stringify(b))), 'the footer was stripped');
  assert.ok((specimen.stripped || []).length >= 1, 'and what was stripped is on the record');

  const before = specimen.blocks.length;
  app.dispatch('specimen.restoreAll');
  assert.ok(app.proof.specimens[0].blocks.length > before, '§8: every stripped block is restorable');
  app.stack.undo();
  assert.equal(app.proof.specimens[0].blocks.length, before, 'and the restore is undoable like anything else');
});

test('the brand extracted from that page carries a solved palette and computed confidence', async () => {
  const app = await realApp();
  const capture = app.services.importHtmlText(PAGE, 'https://www.northwind.example');
  const brand = app.services.buildBrand([capture.value], { seed: app.doc.seed });
  assert.ok(brand.ok, brand.ok ? '' : brand.error);

  const roles = new Set(brand.value.colors.map((c) => c.role));
  for (const role of ['primary', 'onPrimary', 'surface', 'onSurface']) {
    assert.ok(roles.has(role), `${role} must be solved`);
  }
  for (const key of ['colors', 'faces', 'logos', 'shape', 'imagery']) {
    const value = brand.value.confidence[key];
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${key} confidence must be a computed 0..1`);
  }
  assert.ok(brand.value.confidence.colors > 0, 'a page with colours in it produces a non-zero colour confidence');
});

test('the seed library is the eight recipes §9 names', async () => {
  const app = await realApp();
  app.dispatch('recipe.loadSeed');
  assert.equal(app.proof.recipes.length, 8);
  const ids = app.proof.recipes.map((r) => r.id);
  for (const expected of [
    'locale-fanout', 'channel-variants', 'system-assembly', 'brief-to-asset',
    'governed-iteration', 'approval-chain', 'dam-round-trip', 'volume-view',
  ]) {
    assert.ok(ids.some((id) => id.includes(expected)), `${expected} must be in the seed library`);
  }
  app.dispatch('recipe.loadSeed');
  assert.equal(app.proof.recipes.length, 8, 'loading twice does not duplicate');
});

test('a pasted rendition is stamped illustrative and can only be promoted deliberately', async () => {
  const app = await realApp();
  assemble(app);
  const rendition = app.proof.renditions[0];
  assert.ok(rendition, 'a rendition was created from the paste');
  assert.equal(rendition.provenance, 'illustrative', '§9: never default to verified');
  assert.equal(rendition.producedBy, 'manual-paste');

  app.select({ renditionId: rendition.id });
  app.dispatch('rendition.promote', rendition.id);
  const promoted = app.proof.renditions[0];
  assert.equal(promoted.provenance, 'verified-by-user');
  assert.match(String(promoted.notes), /Alex Mercer/, 'the promotion records who');
});

test('the assembled proof is contract-valid', async () => {
  const app = await realApp();
  assemble(app);
  const { validateProofShape } = await import('../../src/core/contracts.js');
  assert.deepEqual(validateProofShape(app.proof), [], 'a studio-built proof must satisfy §4');
});

test('the real preflight runs over the assembled proof and produces §4 findings', async () => {
  const app = await realApp();
  assemble(app);
  await app.dispatch('rehearse.sweep');

  assert.equal(app.ui.sweep.error, null, String(app.ui.sweep.error));
  assert.ok(app.ui.sweep.at, 'the sweep recorded when it ran');
  for (const f of app.ui.sweep.findings) {
    assert.ok([1, 2, 3].includes(f.severity), `${f.code} has an illegal severity`);
    assert.equal(typeof f.code, 'string');
    assert.equal(typeof f.message, 'string');
    assert.ok(f.message.length > 10, 'a finding says something a person can act on');
  }
});

test('the gate follows the real sweep: blocking closes it, clean opens it', async () => {
  const app = await realApp();
  assemble(app);
  await app.dispatch('rehearse.sweep');
  app.dispatch('brand.reviewAll');
  await app.dispatch('rehearse.sweep');

  const blocking = app.ui.sweep.findings.filter((f) => f.severity === 1);
  const gate = emitBlockers(app);
  if (blocking.length) {
    assert.equal(gate.canEmit, false, 'a blocking finding closes the emit');
    for (const f of blocking) {
      assert.ok(gate.blockers.some((b) => b.kind === f.code), `${f.code} must appear as a blocker`);
    }
    await app.dispatch('emit.run');
    assert.equal(app.ui.emit.result, null, 'and nothing is emitted');
    assert.ok(app.ui.notices.some((n) => /Emit refused/.test(n.text)));
  } else {
    assert.equal(gate.canEmit, true, gate.blockers.map((b) => b.message).join(' | '));
    await app.dispatch('emit.run');
    assert.ok(app.ui.emit.result, String(app.ui.emit.error));
  }
});

test('anything the studio does emit wears the prospect’s palette and never the studio’s', async () => {
  const app = await realApp();
  assemble(app);
  app.dispatch('brand.reviewAll');
  await app.dispatch('rehearse.sweep');
  if (!emitBlockers(app).canEmit) {
    // The fixture raised a real finding. That is the §14 behaviour under test
    // elsewhere; here there is simply no artifact to inspect.
    assert.equal(app.ui.emit.result, null);
    return;
  }
  await app.dispatch('emit.run');
  const html = app.ui.emit.result ? app.ui.emit.result.html : '';
  assert.ok(html, String(app.ui.emit.error));
  assert.ok(!/--st-/.test(html), 'D11: no studio variable may reach an artifact');
  assert.ok(!/\bst-app\b|\bst-rail\b|\bst-panel\b/.test(html), 'nor a studio class');
  assert.match(html, /--pp-/, 'the artifact wears its own namespace');
});

test('the preview mounts the real runtime and offers the layouts as revealable elements', async () => {
  const app = await realApp();
  assemble(app);
  app.services.ensureLayouts();
  const { registeredLayouts, missingLayouts } = await import('../../src/runtime/layouts.js');
  assert.equal(missingLayouts().length, 0, `unregistered layouts: ${missingLayouts().join(', ')}`);
  assert.equal(registeredLayouts().length, 8);

  app.preview.rebuild(app.proof, 'presenter');
  assert.ok(app.preview.runtime, 'the runtime booted without a document');
  const { revealableElements } = await import('../../src/ui/panels/scenes.js');
  const elements = revealableElements(app, app.proof.spine[0]);
  assert.ok(elements.length > 0, 'the beat editor offers the elements the layout actually renders');
  for (const el of elements) assert.match(el.id, /^el_[0-9a-f]+$/, 'and they are the ids the artifact will carry');
});

test('the whole studio renders against the real lanes without throwing', async () => {
  const app = await realApp();
  assemble(app);
  await app.dispatch('rehearse.sweep');
  for (const section of ['project', 'brand', 'specimens', 'recipes', 'scenes', 'branches', 'rehearse', 'emit', 'settings']) {
    app.ui.section = section;
    const html = toHtml(renderStudio(app));
    assert.ok(html.length > 1000, `${section} rendered nothing substantial`);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html), `${section} leaked a placeholder value into the interface`);
  }
});

test('the fake adapter used by the other tests exposes the real adapter’s surface', async () => {
  const clock = makeClock();
  const real = makeServices({ clock, http: null });
  const fake = fakeServices({ clock });
  const missing = Object.keys(real)
    .filter((key) => typeof real[key] === 'function')
    .filter((key) => typeof fake[key] !== 'function');
  assert.deepEqual(missing, [], 'a fake that has drifted from the real adapter tests nothing');
});

test('every lane declared in API.md Part 3 is wired', async () => {
  const app = await realApp();
  assert.deepEqual(app.services.missing(), [], 'the studio reports honestly which lanes it is missing');
});
