/**
 * The IndexedDB backend, against a real IndexedDB.
 *
 * `storage.test.mjs` exercises `ProjectStore` through the memory backend, which
 * proves the store's logic and leaves the half that actually persists a user's
 * work completely untested. §16 says a save must never fail silently; that is a
 * claim about `IndexedDbBackend`, and it can only be checked where an
 * `IDBFactory` exists.
 *
 * The page is served from a routed origin rather than `file://`, because a
 * `file://` document has an opaque origin and Chromium refuses IndexedDB there.
 * No server and no network: Playwright fulfils the navigation itself. That
 * opaque-origin refusal is itself a case worth covering, and the last test does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from '../../scripts/lib/bundler.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'https://pitchproof.test';

async function loadChromium() {
  try {
    const pw = await import('playwright');
    return pw.chromium;
  } catch {
    return null;
  }
}

/** The storage module, bundled and exposed as a global in the page. */
function storageBundle() {
  return bundle({
    entry: join(ROOT, 'src/core/storage.js'),
    root: join(ROOT, 'src'),
    global: 'PPStorage',
  }).code;
}

/**
 * Open a page with the storage bundle loaded, on a real origin, with every
 * outbound request refused.
 * @param {import('playwright').Browser} browser
 */
async function openPage(browser, { origin = ORIGIN } = {}) {
  const context = await browser.newContext();
  /** @type {string[]} */
  const attempted = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === `${origin}/` || url === origin) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><title>storage</title><script>${storageBundle()}</script>`,
      });
      return;
    }
    attempted.push(url);
    await route.abort();
  });
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  return { page, context, attempted, errors };
}

/** A proof small enough to move through the page boundary quickly. */
const PROOF = {
  schemaVersion: 1,
  id: 'pf_000000000001',
  prospectName: 'Northwind Industrial',
  createdAt: '2026-02-01T09:00:00.000Z',
  brand: {
    id: 'br_1', sourceUrl: null, capturedAt: '2026-02-01T09:00:00.000Z',
    colors: [], faces: [], logos: [],
    shape: { radiusPx: 4, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'photographic', saturationBias: 0.1 },
    confidence: { colors: 0.8, faces: 0.7, logos: 0.5, shape: 0.8, imagery: 0.6 },
    manualOverrides: [],
  },
  specimens: [], renditions: [], recipes: [], spine: [], branches: [],
  emitOptions: { mode: 'both', includePresenterNotes: true, maxBytes: 25000000, imageQuality: 0.85, labelIllustrativeContent: true },
};

test('the IndexedDB backend persists, reads back and deletes a project', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const browser = await chromium.launch();
  try {
    const { page, attempted, errors } = await openPage(browser);

    const result = await page.evaluate(async (proof) => {
      const { ProjectStore } = window.PPStorage;
      let tick = 0;
      const clock = () => new Date(Date.UTC(2026, 1, 10, 10, 0, tick++)).toISOString();
      const store = await ProjectStore.open({ clock });

      const backendKind = store.backend.kind;
      const degraded = store.degraded;

      const saved = await store.save({ id: 'pj_browser', name: 'Northwind pitch', proof, seed: 'seed-1' });
      const loaded = await store.load('pj_browser');
      const listed = await store.list();
      const skipped = await store.save({ id: 'pj_browser', name: 'Northwind pitch', proof, seed: 'seed-1' });

      const edited = { ...proof, prospectName: 'Contoso' };
      const second = await store.save({ id: 'pj_browser', name: 'Northwind pitch', proof: edited, seed: 'seed-1' });

      await store.setSetting('adapterKey', 'sk-local-only');
      const setting = await store.getSetting('adapterKey');

      const pressure = await store.pressure();
      const removed = await store.remove('pj_browser');
      const afterRemove = await store.load('pj_browser');
      store.close();

      return {
        backendKind,
        degraded,
        savedOk: saved.ok,
        savedSkipped: saved.ok && saved.value.skipped,
        loadedOk: loaded.ok,
        loadedName: loaded.ok ? loaded.value.prospectName : null,
        loadedRevision: loaded.ok ? loaded.value.revision : null,
        listedCount: listed.length,
        listedId: listed[0] ? listed[0].id : null,
        skippedSecondSave: skipped.ok && skipped.value.skipped,
        secondRevision: second.ok ? second.value.record.revision : null,
        setting,
        pressureLevel: pressure.level,
        pressureHasQuota: pressure.quota > 0,
        removedOk: removed.ok,
        gone: !afterRemove.ok,
      };
    }, PROOF);

    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(attempted, [], `storage attempted network: ${attempted.join(', ')}`);

    assert.equal(result.backendKind, 'indexeddb', 'a real browser must get the real backend');
    assert.equal(result.degraded, null);
    assert.equal(result.savedOk, true);
    assert.equal(result.savedSkipped, false);
    assert.equal(result.loadedOk, true);
    assert.equal(result.loadedName, 'Northwind Industrial');
    assert.equal(result.loadedRevision, 1);
    assert.equal(result.listedCount, 1);
    assert.equal(result.listedId, 'pj_browser');
    assert.equal(result.skippedSecondSave, true, 'an unchanged save must not rewrite');
    assert.equal(result.secondRevision, 2, 'a changed save bumps the revision');
    assert.equal(result.setting, 'sk-local-only');
    assert.equal(result.pressureLevel, 'ok');
    assert.equal(result.pressureHasQuota, true, 'navigator.storage.estimate should report a quota');
    assert.equal(result.removedOk, true);
    assert.equal(result.gone, true);
  } finally {
    await browser.close();
  }
});

test('data survives a page reload, which is the whole point of the backend', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const browser = await chromium.launch();
  try {
    const { page } = await openPage(browser);

    await page.evaluate(async (proof) => {
      const { ProjectStore } = window.PPStorage;
      const store = await ProjectStore.open({ clock: () => '2026-02-10T10:00:00.000Z' });
      await store.save({ id: 'pj_persist', name: 'Persisted', proof, seed: 'seed-x' });
      store.close();
    }, PROOF);

    await page.reload({ waitUntil: 'load' });

    const after = await page.evaluate(async () => {
      const { ProjectStore } = window.PPStorage;
      const store = await ProjectStore.open({ clock: () => '2026-02-10T10:00:01.000Z' });
      const loaded = await store.load('pj_persist');
      const rows = await store.list();
      store.close();
      return { ok: loaded.ok, name: loaded.ok ? loaded.value.name : null, seed: loaded.ok ? loaded.value.seed : null, rows: rows.length };
    });

    assert.equal(after.ok, true, 'the project must still be there after a reload');
    assert.equal(after.name, 'Persisted');
    assert.equal(after.seed, 'seed-x');
    assert.equal(after.rows, 1);
  } finally {
    await browser.close();
  }
});

test('a refused IndexedDB degrades to memory and says so, rather than losing the save', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const browser = await chromium.launch();
  try {
    const { page } = await openPage(browser);

    const result = await page.evaluate(async (proof) => {
      const { ProjectStore } = window.PPStorage;
      // Exactly what a browser in private mode, or a `file://` document with an
      // opaque origin, does: the factory exists and refuses to open.
      const refusing = {
        open() {
          const req = { onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null, error: new Error('SecurityError: access denied') };
          setTimeout(() => req.onerror && req.onerror(), 0);
          return req;
        },
      };
      const store = await ProjectStore.open({ clock: () => '2026-02-10T10:00:00.000Z', indexedDB: refusing });
      const saved = await store.save({ id: 'pj_degraded', name: 'Degraded', proof, seed: 's' });
      const loaded = await store.load('pj_degraded');
      return {
        kind: store.backend.kind,
        degraded: store.degraded,
        savedOk: saved.ok,
        loadedOk: loaded.ok,
      };
    }, PROOF);

    assert.equal(result.kind, 'memory');
    assert.match(result.degraded, /IndexedDB unavailable/);
    assert.match(result.degraded, /Export your project/, 'the user must be told what they are risking');
    assert.equal(result.savedOk, true, 'the work must still be held, not dropped on the floor');
    assert.equal(result.loadedOk, true);
  } finally {
    await browser.close();
  }
});

test('a quota failure is reported with what to do about it', async (t) => {
  const chromium = await loadChromium();
  if (!chromium) return t.skip('playwright is not linked in node_modules');

  const browser = await chromium.launch();
  try {
    const { page } = await openPage(browser);

    const result = await page.evaluate(async (proof) => {
      const { ProjectStore, IndexedDbBackend } = window.PPStorage;
      const backend = new IndexedDbBackend(indexedDB, 'pitchproof-quota-test');
      await backend.open();
      backend.put = () => Promise.reject(new Error('QuotaExceededError: The quota has been exceeded.'));
      const store = new ProjectStore({ backend, clock: () => '2026-02-10T10:00:00.000Z' });
      const saved = await store.save({ id: 'pj_quota', name: 'Too big', proof, seed: 's' });
      store.close();
      return { ok: saved.ok, error: saved.ok ? null : saved.error };
    }, PROOF);

    assert.equal(result.ok, false, 'a failed write must not report success');
    assert.match(result.error, /quota/i);
    assert.match(result.error, /Re-compress assets or export the project/);
  } finally {
    await browser.close();
  }
});
