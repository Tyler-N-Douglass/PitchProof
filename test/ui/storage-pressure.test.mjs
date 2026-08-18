/**
 * §16: "Storage-pressure handling: warn at 80% of estimated quota, offer asset
 * re-compression, never fail a save silently."
 *
 * Three separate obligations, tested separately, because the third is the one
 * that actually bites: a studio that quietly stops saving on the afternoon
 * before a pitch is worse than one that never saved at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../../src/core/vdom.js';
import { StudioApp } from '../../src/ui/app.js';
import { ProjectStore, MemoryBackend, PRESSURE_WARN_RATIO } from '../../src/core/storage.js';
import { renderStudio } from '../../src/ui/layout.js';
import { fixtureDoc, fakeServices, makeClock } from '../fixtures/ui/studio-fixture.mjs';

/**
 * A backend that reports whatever pressure a test wants and can be made to fail
 * on write.
 */
class RiggedBackend extends MemoryBackend {
  /** @param {{usage: number, quota: number}} estimate */
  constructor(estimate) {
    super(estimate.quota);
    this.rigged = estimate;
    /** @type {string|null} */
    this.failWith = null;
  }

  async estimate() { return this.rigged; }

  /** @param {string} store @param {any} value */
  async put(store, value) {
    if (this.failWith) throw new Error(this.failWith);
    return super.put(store, value);
  }
}

/**
 * @param {{usage: number, quota: number}} estimate
 * @returns {Promise<{app: any, backend: RiggedBackend}>}
 */
async function makeApp(estimate) {
  const clock = makeClock();
  const backend = new RiggedBackend(estimate);
  const store = new ProjectStore({ backend, clock });
  const app = new StudioApp({
    document: null, window: null, store, clock,
    services: fakeServices({ clock }), doc: fixtureDoc(),
  });
  return { app, backend };
}

test('an estimate at 80% of quota produces a warning that offers re-compression', async () => {
  const { app } = await makeApp({ usage: 80, quota: 100 });
  const result = await app.saveNow();
  assert.ok(result.ok, 'the save itself still succeeds');
  assert.equal(app.ui.pressure.level, 'warn', `${PRESSURE_WARN_RATIO} is the §16 floor`);

  const warning = app.ui.notices.find((n) => n.tone === 'warn');
  assert.ok(warning, 'a warning must be raised at the floor');
  assert.match(warning.text, /80% full/, 'the warning states the number');
  assert.match(warning.text, /Re-compress/i, '§16 requires the re-compression offer to be attached to the warning');
  assert.equal(warning.sticky, true, 'a storage warning does not fade away on its own');
});

test('below the floor nothing is raised', async () => {
  const { app } = await makeApp({ usage: 10, quota: 100 });
  await app.saveNow();
  assert.equal(app.ui.pressure.level, 'ok');
  assert.equal(app.ui.notices.filter((n) => n.tone === 'warn' || n.tone === 'bad').length, 0);
});

test('an unknown quota does not manufacture a false alarm', async () => {
  const { app } = await makeApp({ usage: 900000, quota: 0 });
  await app.saveNow();
  assert.equal(app.ui.pressure.level, 'ok', 'a platform that will not report a quota is not a full disk');
  assert.equal(app.ui.notices.filter((n) => n.tone === 'warn').length, 0);
});

test('a critical estimate escalates', async () => {
  const { app } = await makeApp({ usage: 98, quota: 100 });
  await app.saveNow();
  assert.equal(app.ui.pressure.level, 'critical');
  assert.ok(app.ui.notices.some((n) => n.tone === 'bad'));
});

test('a failing save surfaces an error and never reports success', async () => {
  const { app, backend } = await makeApp({ usage: 10, quota: 100 });
  backend.failWith = 'QuotaExceededError: the quota has been exceeded';
  const result = await app.saveNow();

  assert.equal(result.ok, false, 'the store reports the failure rather than swallowing it');
  assert.equal(app.ui.save.status, 'error');
  assert.match(app.ui.save.error, /quota/i);

  const error = app.ui.notices.find((n) => n.tone === 'bad');
  assert.ok(error, '§16: never fail a save silently');
  assert.equal(error.sticky, true, 'a failed save stays on screen until it is dealt with');
  assert.match(error.text, /Re-compress assets or export the project/i, 'the message says what to do about it');
});

test('a non-quota storage failure is reported just as loudly', async () => {
  const { app, backend } = await makeApp({ usage: 10, quota: 100 });
  backend.failWith = 'the object store was removed';
  const result = await app.saveNow();
  assert.equal(result.ok, false);
  assert.equal(app.ui.save.status, 'error');
  assert.ok(app.ui.notices.some((n) => n.tone === 'bad' && /object store/.test(n.text)));
});

test('the failure is visible in the rendered studio, not only in state', async () => {
  const { app, backend } = await makeApp({ usage: 10, quota: 100 });
  backend.failWith = 'QuotaExceededError';
  await app.saveNow();
  app.ui.section = 'project';
  const html = toHtml(renderStudio(app));
  assert.match(html, /Save failed/, 'the top bar says so');
  assert.match(html, /QuotaExceededError/, 'and the panel repeats the exact message the store produced');
});

test('re-compression is a real, undoable mutation of the image quality step', async () => {
  const { app } = await makeApp({ usage: 90, quota: 100 });
  assert.equal(app.proof.emitOptions.imageQuality, 0.85);
  app.dispatch('project.recompress');
  assert.equal(app.proof.emitOptions.imageQuality, 0.75, 'one step down the §4 quality ladder');
  app.stack.undo();
  assert.equal(app.proof.emitOptions.imageQuality, 0.85);
});

test('re-compression at the bottom of the ladder says so rather than pretending', async () => {
  const { app } = await makeApp({ usage: 90, quota: 100 });
  app.dispatch('project.recompress');
  app.dispatch('project.recompress');
  assert.equal(app.proof.emitOptions.imageQuality, 0.6);
  const depth = app.stack.history().length;
  app.dispatch('project.recompress');
  assert.equal(app.stack.history().length, depth, 'no phantom mutation at the floor');
  assert.ok(app.ui.notices.some((n) => /already at its lowest/.test(n.text)));
});

test('a degraded backend is announced on start', async () => {
  const clock = makeClock();
  const backend = new MemoryBackend(1000);
  const store = new ProjectStore({ backend, clock, degraded: 'IndexedDB unavailable; using in-memory storage.' });
  const app = new StudioApp({
    document: null, window: null, store, clock, services: fakeServices({ clock }), doc: fixtureDoc(),
  });
  await app.start();
  assert.ok(
    app.ui.notices.some((n) => n.sticky && /in-memory/.test(n.text)),
    'a studio that is only holding your work in memory has to say so',
  );
});

test('every committed mutation schedules a save', async () => {
  const { app } = await makeApp({ usage: 10, quota: 100 });
  await app.saveNow();
  assert.equal(app.ui.save.status, 'saved');
  app.dispatch('project.setProspect', null, { value: 'Changed' });
  // With no window there is no timer, so the save runs inline and completes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.ui.save.status, 'saved');
  const loaded = await app.store.load(app.doc.id);
  assert.ok(loaded.ok);
  assert.equal(loaded.value.proof.prospectName, 'Changed', '§16: autosave on every committed mutation');
});
