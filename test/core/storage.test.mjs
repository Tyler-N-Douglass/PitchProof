/**
 * §16 persistence: versioned schema with a migration path, autosave that skips
 * no-ops, storage-pressure warning at 80%, and a save that never fails silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectStore, MemoryBackend, SCHEMA_VERSION, MIGRATIONS, migrateRecord,
  makeRecord, exportProjectJson, importProjectJson, PRESSURE_WARN_RATIO, selectBackend,
  recordProblems, QuotaError,
} from '../../src/core/storage.js';
import { defaultEmitOptions } from '../../src/core/contracts.js';

/** A pinned clock: §5 forbids a wall-clock read inside model construction. */
function fixedClock(iso = '2026-01-02T03:04:05.000Z') {
  let n = 0;
  return () => new Date(Date.parse(iso) + (n++) * 1000).toISOString();
}

/** @returns {import('../../src/core/contracts.d.ts').Proof} */
function makeProof(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'pf_000000000001',
    prospectName: 'Northwind',
    createdAt: '2026-01-01T00:00:00.000Z',
    brand: {
      id: 'br_1', sourceUrl: null, capturedAt: '2026-01-01T00:00:00.000Z',
      colors: [], faces: [], logos: [],
      shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 1 },
      imagery: { treatment: 'unknown', saturationBias: 0 },
      confidence: { colors: 0, faces: 0, logos: 0, shape: 0, imagery: 0 },
      manualOverrides: [],
    },
    specimens: [], renditions: [], recipes: [], spine: [], branches: [],
    emitOptions: defaultEmitOptions(),
    ...overrides,
  };
}

async function newStore(quota = 1_000_000) {
  return new ProjectStore({ backend: new MemoryBackend(quota), clock: fixedClock() });
}

test('a saved project loads back identically', async () => {
  const store = await newStore();
  const proof = makeProof();
  const saved = await store.save({ id: 'pj_1', name: 'Northwind pitch', proof, seed: 'seed-1' });
  assert.ok(saved.ok);
  assert.equal(saved.value.skipped, false);

  const loaded = await store.load('pj_1');
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.value.proof, proof);
  assert.equal(loaded.value.schemaVersion, SCHEMA_VERSION);
  assert.equal(loaded.value.seed, 'seed-1');
  assert.equal(loaded.value.revision, 1);
});

test('an unchanged save is skipped, and a changed one bumps the revision', async () => {
  const store = await newStore();
  const proof = makeProof();
  await store.save({ id: 'pj_1', name: 'p', proof, seed: 's' });
  const again = await store.save({ id: 'pj_1', name: 'p', proof, seed: 's' });
  assert.ok(again.ok && again.value.skipped, 'identical content must not rewrite');

  const edited = makeProof({ prospectName: 'Contoso' });
  const third = await store.save({ id: 'pj_1', name: 'p', proof: edited, seed: 's' });
  assert.ok(third.ok && !third.value.skipped);
  assert.equal(third.value.record.revision, 2);
});

test('a forced save rewrites even when the content hash is unchanged', async () => {
  const store = await newStore();
  const proof = makeProof();
  await store.save({ id: 'pj_1', name: 'p', proof, seed: 's' });
  const forced = await store.save({ id: 'pj_1', name: 'p', proof, seed: 's', force: true });
  assert.ok(forced.ok && !forced.value.skipped);
  assert.equal(forced.value.record.revision, 2);
});

test('list is newest-first and reports what the rail needs', async () => {
  const store = await newStore();
  await store.save({ id: 'pj_a', name: 'A', proof: makeProof(), seed: 's' });
  await store.save({ id: 'pj_b', name: 'B', proof: makeProof({ prospectName: 'B Corp' }), seed: 's' });
  const rows = await store.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'pj_b', 'most recently saved first');
  assert.ok(rows[0].bytes > 0);
  assert.equal(rows[0].schemaVersion, SCHEMA_VERSION);
});

test('deleting a project removes it and clears the skip cache', async () => {
  const store = await newStore();
  await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's' });
  assert.ok((await store.remove('pj_1')).ok);
  const gone = await store.load('pj_1');
  assert.ok(!gone.ok);
  const resaved = await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's' });
  assert.ok(resaved.ok && !resaved.value.skipped, 'a delete must invalidate the no-op cache');
});

test('storage pressure warns at 80% of quota and never invents an alarm', async () => {
  // A quota this record fits inside, but only just: the warn band is between
  // 80% and 100%, and a record that does not fit at all exercises the refusal
  // below rather than the warning. The record is ~891 bytes.
  const store = new ProjectStore({ backend: new MemoryBackend(1050), clock: fixedClock() });
  const seen = [];
  store.onPressure((p) => seen.push(p.level));

  const small = await store.pressure();
  assert.equal(small.level, 'ok');

  const saved = await store.save({ id: 'pj_big', name: 'big', proof: makeProof(), seed: 's' });
  assert.ok(saved.ok, `the record must fit for this to test the warning: ${saved.ok ? '' : saved.error}`);
  const after = await store.pressure();
  assert.ok(after.ratio >= PRESSURE_WARN_RATIO, `ratio ${after.ratio}`);
  assert.ok(after.level === 'warn' || after.level === 'critical');
  assert.ok(seen.length > 0, 'the pressure listener heard nothing');

  const unknownQuota = new ProjectStore({ backend: new MemoryBackend(0), clock: fixedClock() });
  const u = await unknownQuota.pressure();
  assert.equal(u.level, 'ok', 'an unknown quota must not manufacture a warning');
  assert.equal(u.ratio, 0);
});

test('MemoryBackend refuses a save past the quota it reports', async () => {
  // CRITIQUE-2 C15: it reported a quota and never enforced one. With a 400kB
  // quota, eight saves of the corpus project ran usage to 3.6x it, every one
  // returning success — while §16's pressure warning correctly said the store
  // was over. The seller was told they were full and then told each save had
  // worked. This is the fallback backend, the one a locked-down browser gets.
  const store = new ProjectStore({ backend: new MemoryBackend(400), clock: fixedClock() });
  const res = await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's' });
  assert.ok(!res.ok, 'a record larger than the whole quota was accepted');
  assert.match(res.error, /full|quota/i);
  assert.match(res.error, /export|delete/i, 'the message must say what to do about it');
});

test('usage never exceeds the quota, however many saves are attempted', async () => {
  const backend = new MemoryBackend(3000);
  const store = new ProjectStore({ backend, clock: fixedClock() });
  let accepted = 0;
  for (let i = 0; i < 8; i += 1) {
    const res = await store.save({ id: `pj_${i}`, name: `p${i}`, proof: makeProof(), seed: 's' });
    if (res.ok) accepted += 1;
  }
  const { usage, quota } = await backend.estimate();
  assert.ok(usage <= quota, `usage ${usage} ran past quota ${quota} after ${accepted} accepted saves`);
  assert.ok(accepted > 0, 'nothing was accepted at all, so this proves nothing about the ceiling');
  assert.ok(accepted < 8, 'every save fit, so the ceiling was never tested');
});

test('overwriting a project with a smaller one always fits', async () => {
  // Otherwise a full store cannot be emptied one project at a time, and the
  // remedy the refusal names is unreachable.
  const backend = new MemoryBackend(1200);
  const store = new ProjectStore({ backend, clock: fixedClock() });
  const first = await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's' });
  assert.ok(first.ok, first.ok ? '' : first.error);
  const again = await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's', revision: 2 });
  assert.ok(again.ok, `re-saving the same project was refused: ${again.ok ? '' : again.error}`);
});

test('a project file with no proof in it is refused, per field', async () => {
  // CRITIQUE-2 C4. `migrateRecord` answers "is this envelope a version I can
  // move forward" and answers it correctly; it says nothing about whether the
  // envelope contains a proof, and every panel downstream reads record.proof.*.
  const empty = JSON.stringify({ format: 'pitchproof-project', formatVersion: 1, record: { schemaVersion: 1 } });
  const res = importProjectJson(empty);
  assert.ok(!res.ok, 'a record with no proof imported cleanly');
  assert.match(res.error, /there is no proof in this file/);

  // Per field, because "invalid project file" tells a seller who has just lost
  // a file nothing they can act on.
  const partial = JSON.stringify({
    format: 'pitchproof-project',
    formatVersion: 1,
    record: {
      schemaVersion: 1, id: 'pj_1', name: 'p', seed: 's', savedAt: 'now', revision: 1,
      proof: { id: 'pf_1', prospectName: 'X', createdAt: 'now', brand: {}, emitOptions: {}, specimens: [], renditions: [], recipes: [], spine: 'nope', branches: [] },
    },
  });
  const partialRes = importProjectJson(partial);
  assert.ok(!partialRes.ok);
  assert.match(partialRes.error, /proof\.spine is a string, expected an array/);
});

test('a well-formed export round-trips through import', () => {
  const rec = makeRecord({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's', clock: fixedClock() });
  const back = importProjectJson(exportProjectJson(rec));
  assert.ok(back.ok, back.ok ? '' : back.error);
  assert.deepEqual(recordProblems(back.value), []);
  assert.equal(back.value.id, rec.id);
  assert.equal(back.value.proof.prospectName, rec.proof.prospectName);
});

test('a backend write failure is reported, never swallowed', async () => {
  const backend = new MemoryBackend();
  backend.put = async () => { throw new Error('QuotaExceededError: storage full'); };
  const store = new ProjectStore({ backend, clock: fixedClock() });
  const res = await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's' });
  assert.ok(!res.ok);
  assert.match(res.error, /quota/i);
  assert.match(res.error, /re-compress|export/i, 'the message must say what to do about it');
});

test('an IndexedDB refusal degrades to memory and says so', async () => {
  const refusing = {
    open() {
      const req = { onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null, error: new Error('blocked in private mode') };
      queueMicrotask(() => req.onerror && req.onerror());
      return req;
    },
  };
  const { backend, degraded } = await selectBackend({ indexedDB: /** @type {any} */ (refusing) });
  assert.equal(backend.kind, 'memory');
  assert.match(degraded, /IndexedDB unavailable/);
  assert.match(degraded, /Export your project/);
});

test('migrateRecord refuses a version it has no step for, and one from the future', () => {
  assert.deepEqual(Object.keys(MIGRATIONS), [], 'version 1 is the first shipped envelope');
  const v0 = migrateRecord({ schemaVersion: 0, id: 'pj_x' });
  assert.ok(!v0.ok);
  assert.match(v0.error, /no migration registered from schemaVersion 0/);

  const future = migrateRecord({ schemaVersion: SCHEMA_VERSION + 1, id: 'pj_x' });
  assert.ok(!future.ok);
  assert.match(future.error, /newer than this build/);
});

test('a registered migration chain runs in order', () => {
  // Register a synthetic step, prove the walker uses it, then remove it. This
  // is how the next schema bump will be tested; the chain must be exercised
  // before it is needed, not after it breaks a user's project.
  MIGRATIONS[0] = (rec) => ({ ...rec, migrated: true, prospectName: rec.prospect });
  try {
    const out = migrateRecord({ schemaVersion: 0, id: 'pj_x', prospect: 'Old Field' });
    assert.ok(out.ok);
    assert.equal(out.value.schemaVersion, SCHEMA_VERSION);
    assert.equal(out.value.prospectName, 'Old Field');
    assert.equal(out.value.migrated, true);
  } finally {
    delete MIGRATIONS[0];
  }
});

test('export/import round-trips a project through a single JSON file', async () => {
  const clock = fixedClock();
  const record = makeRecord({ id: 'pj_1', name: 'Northwind', proof: makeProof(), seed: 's', clock });
  const json = exportProjectJson(record);
  assert.ok(json.includes('"format": "pitchproof-project"'));
  const back = importProjectJson(json);
  assert.ok(back.ok);
  assert.deepEqual(back.value.proof, record.proof);
  assert.equal(back.value.savedAt, record.savedAt);

  assert.ok(!importProjectJson('{').ok);
  assert.ok(!importProjectJson('{"format":"something-else"}').ok);
});

test('settings live in the meta store and never travel with a project', async () => {
  const store = await newStore();
  await store.setSetting('adapterKey', 'sk-not-a-real-key');
  assert.equal(await store.getSetting('adapterKey'), 'sk-not-a-real-key');
  assert.equal(await store.getSetting('missing', 'fallback'), 'fallback');

  await store.save({ id: 'pj_1', name: 'p', proof: makeProof(), seed: 's' });
  const exported = exportProjectJson((await store.load('pj_1')).value);
  assert.ok(!exported.includes('sk-not-a-real-key'), 'a runtime adapter key must never reach an export (§9)');
});

test('the record envelope is content-addressed, so a rebuild is not a new save', () => {
  const a = makeRecord({ id: 'pj_1', name: 'n', proof: makeProof(), seed: 's', clock: fixedClock() });
  const b = makeRecord({ id: 'pj_1', name: 'n', proof: makeProof(), seed: 's', clock: fixedClock() });
  assert.equal(a.contentHash, b.contentHash);
});
