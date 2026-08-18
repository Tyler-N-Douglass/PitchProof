/**
 * §9: the runtime adapter's key "lives in memory and IndexedDB on their machine
 * only; it is **never** written into an emitted artifact; the emitter must
 * assert its absence".
 *
 * The studio's half of that is narrower and easier to get wrong than it looks:
 * the key must not reach the *model*. Once it is in the proof it is in the
 * export, in the autosave, and in whatever the emitter serialises — and no
 * amount of asserting at the far end helps. So this file checks the model, the
 * `.pitchproof.json` export, and — when `src/emit/` has landed — the emitted
 * artifact itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { SETTING_KEYS } from '../../src/ui/constants.js';
import { ProjectStore, exportProjectJson, makeRecord, importProjectJson } from '../../src/core/storage.js';
import { renderAllPanels } from '../../src/ui/panels/index.js';
import { fixtureDoc, fakeServices, makeClock } from '../fixtures/ui/studio-fixture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'sk-pitchproof-test-4f2b9c1a-DO-NOT-SHIP';
const ENDPOINT = 'https://adapter.example/generate';

/** @returns {Promise<any>} */
async function makeApp() {
  const clock = makeClock();
  const store = await ProjectStore.open({ clock, indexedDB: null });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock }), doc: fixtureDoc(),
  });
  await app.setSetting(SETTING_KEYS.adapterEndpoint, ENDPOINT);
  await app.setSetting(SETTING_KEYS.adapterKey, SECRET);
  return app;
}

test('the key is stored on this machine and nowhere near the model', async () => {
  const app = await makeApp();
  assert.equal(app.ui.settings.adapterKey, SECRET, 'it is held in memory for the session');
  assert.equal(await app.store.getSetting(SETTING_KEYS.adapterKey), SECRET, 'and in the local meta store');
  assert.ok(!JSON.stringify(app.doc).includes(SECRET), 'the document must not contain the key');
});

test('the key survives no path into a .pitchproof.json export', async () => {
  const app = await makeApp();
  // Do everything that could plausibly drag a setting into the model first.
  app.dispatch('project.setProspect', null, { value: 'Northwind' });
  await app.saveNow();
  const record = makeRecord({
    id: app.doc.id, name: app.doc.name, proof: app.doc.proof, seed: app.doc.seed, clock: app.clock,
  });
  const json = exportProjectJson(record);

  assert.ok(!json.includes(SECRET), '§9: the key is never written into a project export');
  assert.ok(!json.includes(ENDPOINT), 'nor is the endpoint — settings are per-machine');
  assert.ok(!json.includes('adapter.endpoint'), 'nor the setting keys themselves');

  const back = importProjectJson(json);
  assert.ok(back.ok, 'and the export still round-trips');
  assert.ok(!JSON.stringify(back.value).includes(SECRET));
});

test('the autosaved record carries no key', async () => {
  const app = await makeApp();
  await app.saveNow();
  const loaded = await app.store.load(app.doc.id);
  assert.ok(loaded.ok);
  assert.ok(!JSON.stringify(loaded.value).includes(SECRET), 'the saved project record is clean');
});

test('an adapter-produced rendition carries no key and is stamped illustrative', async () => {
  const app = await makeApp();
  app.select({ specimenId: app.proof.specimens[0].id, recipeId: app.proof.recipes[0].id });
  await app.dispatch('rendition.runAdapter');
  const added = app.proof.renditions.find((r) => r.producedBy === 'adapter');
  assert.ok(added, 'the adapter produced a rendition');
  assert.equal(added.provenance, 'illustrative', '§9: adapter output is illustrative until a human promotes it');
  assert.ok(!JSON.stringify(added).includes(SECRET));
  assert.ok(!JSON.stringify(app.doc).includes(SECRET));
});

test('what reaches the emitter is the proof and the options, and neither carries a key', async () => {
  const app = await makeApp();
  const seen = [];
  app.services.emit = async (proof, options) => {
    seen.push({ proof, options });
    return { ok: true, value: { html: '<html></html>', bytes: 10, findings: [], degradations: [], compression: { mode: 'raw', modelBytes: 5, mediaBytes: 0 } } };
  };
  app.ui.sweep = { findings: [], at: app.clock(), running: false, error: null, proofHash: null };
  app.dispatch('brand.reviewAll');
  app.ui.sweep.proofHash = null;
  await app.dispatch('emit.run');

  assert.equal(seen.length, 1, 'the emitter was called exactly once');
  const payload = JSON.stringify(seen[0]);
  assert.ok(!payload.includes(SECRET), 'the emitter is never handed the key');
  assert.ok(!payload.includes(ENDPOINT), 'nor the endpoint');
});

test('the emitted artifact contains no key', async () => {
  const app = await makeApp();
  app.ui.sweep = { findings: [], at: app.clock(), running: false, error: null, proofHash: null };
  app.dispatch('brand.reviewAll');
  app.ui.sweep.proofHash = null;
  await app.dispatch('emit.run');
  const emitted = app.ui.emit.result;
  assert.ok(emitted, 'something was emitted');
  assert.ok(!emitted.html.includes(SECRET));
});

test('the real emitter, once it has landed, produces an artifact with no key', async (t) => {
  const emitEntry = join(ROOT, 'src', 'emit', 'index.js');
  if (!existsSync(emitEntry)) {
    t.skip('src/emit/index.js has not landed yet; the model-side assertions above still hold');
    return;
  }
  const lane = await import('../../src/emit/index.js');
  const app = await makeApp();
  const result = await lane.emit(app.proof, app.proof.emitOptions, {
    runtimeJs: '', runtimeCss: '', clock: app.clock,
  });
  if (!result.ok) {
    // A refusal is a legitimate outcome for a fixture proof; what matters is
    // that nothing on the way there carried the key.
    assert.ok(!JSON.stringify(result).includes(SECRET));
    return;
  }
  assert.ok(!result.value.html.includes(SECRET), '§9: the emitter asserts the key is absent');
  assert.ok(!result.value.html.includes(ENDPOINT));
});

test('the settings panel says plainly where the key lives and where it does not', async () => {
  const app = await makeApp();
  const html = toHtml(renderAllPanels(app));
  assert.match(html, /never leaves this machine/i);
  assert.match(html, /not written into an emitted artifact/i);
  assert.match(html, /asserts its absence/i);
  assert.match(html, /type="password"/, 'the key field is not shown in clear text by default');
});

test('forgetting the key clears it from memory and from storage', async () => {
  const app = await makeApp();
  await app.dispatch('settings.clearAdapterKey');
  assert.equal(app.ui.settings.adapterKey, '');
  assert.equal(await app.store.getSetting(SETTING_KEYS.adapterKey), '');
});

test('no source file under src/ui/** writes a setting into the proof', () => {
  // The mechanical half of the law: `SETTING_KEYS` is read in exactly two
  // places — the app's settings loader and the actions that write them — and
  // never inside a `mutate` updater.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  };
  walk(join(ROOT, 'src', 'ui'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!/adapterKey|SETTING_KEYS\.adapterKey/.test(line)) continue;
      assert.ok(
        !/app\.mutate|withProof|M\.set(?!ting)/.test(line),
        `${file}: the adapter key must never appear inside a model mutation — ${line.trim()}`,
      );
    }
  }
});
