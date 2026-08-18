/**
 * Project persistence (§16).
 *
 * Two backends behind one async interface: IndexedDB when a document is
 * present, an in-memory map otherwise (Node tests, and the fallback when a
 * browser refuses IndexedDB in a `file://` context or in private mode — §16
 * says a save must never fail silently, so a refusal degrades to memory and
 * reports itself rather than throwing at the caller).
 *
 * The store is versioned. `SCHEMA_VERSION` is the version this build writes;
 * `MIGRATIONS` carries one function per step from an older version forward, and
 * `migrateRecord` walks them in order. `Proof.schemaVersion` is frozen at 1 by
 * §4, so the *record envelope* carries its own version — that is what migrates,
 * and a proof upgraded past 1 will be rewritten by the migration that raises it.
 *
 * Nothing in this module invents a timestamp. `clock` is injected so a test can
 * pin `savedAt` and so `scripts/lint-determinism.mjs` can prove there is no
 * hidden `Date.now()` in a model path.
 *
 * @module core/storage
 */

import { contentHash } from './hash.js';
import { ok, err } from './result.js';

/** The record-envelope schema version this build writes. */
export const SCHEMA_VERSION = 1;

/** IndexedDB database name and object store names. */
export const DB_NAME = 'pitchproof';
export const STORE_PROJECTS = 'projects';
export const STORE_META = 'meta';

/** Fraction of estimated quota at which §16 requires a warning. */
export const PRESSURE_WARN_RATIO = 0.8;

/**
 * @typedef {object} ProjectRecord
 * @property {string} id                     project id (pj_*)
 * @property {number} schemaVersion          envelope version
 * @property {string} name                   display name
 * @property {string} prospectName
 * @property {string} createdAt              ISO
 * @property {string} savedAt                ISO, from the injected clock
 * @property {number} revision               monotonically increasing per save
 * @property {string} seed                   project PRNG seed
 * @property {import('./contracts.d.ts').Proof} proof
 * @property {string} contentHash            hash of `proof`, used to skip no-op saves
 * @property {number} bytes                  serialized size of this record
 */

/**
 * Migrations from envelope version N to N+1, keyed by N. Each receives and
 * returns a plain record. Adding a version means adding a function here and
 * bumping `SCHEMA_VERSION`; the test suite asserts the chain is complete.
 * @type {Record<number, (rec: any) => any>}
 */
export const MIGRATIONS = {
  // No migrations yet: version 1 is the first shipped envelope. The chain is
  // exercised by `test/core/storage.test.mjs`, which registers a synthetic
  // version-0 record and asserts `migrateRecord` refuses to load it without a
  // registered step rather than silently mangling it.
};

/**
 * Bring a record forward to `SCHEMA_VERSION`.
 * @param {any} rec
 * @returns {{ok: true, value: ProjectRecord} | {ok: false, error: string}}
 */
export function migrateRecord(rec) {
  if (!rec || typeof rec !== 'object') return err('storage: record is not an object');
  let v = typeof rec.schemaVersion === 'number' ? rec.schemaVersion : 0;
  if (v > SCHEMA_VERSION) {
    return err(`storage: record schemaVersion ${v} is newer than this build (${SCHEMA_VERSION})`);
  }
  let cur = rec;
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return err(`storage: no migration registered from schemaVersion ${v} to ${v + 1}`);
    cur = step(cur);
    v += 1;
    cur.schemaVersion = v;
  }
  return ok(/** @type {ProjectRecord} */ (cur));
}

/**
 * Build a fresh record envelope around a proof.
 * @param {object} args
 * @param {string} args.id
 * @param {string} args.name
 * @param {import('./contracts.d.ts').Proof} args.proof
 * @param {string} args.seed
 * @param {number} [args.revision]
 * @param {() => string} args.clock  returns an ISO string
 * @returns {ProjectRecord}
 */
export function makeRecord({ id, name, proof, seed, revision = 1, clock }) {
  const rec = {
    id,
    schemaVersion: SCHEMA_VERSION,
    name,
    prospectName: proof.prospectName,
    createdAt: proof.createdAt,
    savedAt: clock(),
    revision,
    seed,
    proof,
    contentHash: contentHash(proof),
    bytes: 0,
  };
  rec.bytes = utf8Bytes(JSON.stringify(rec));
  return rec;
}

/** @param {string} s @returns {number} */
function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * The backend interface every store speaks.
 * @typedef {object} StorageBackend
 * @property {string} kind
 * @property {() => Promise<void>} open
 * @property {(store: string, key: string) => Promise<any>} get
 * @property {(store: string, value: any) => Promise<void>} put
 * @property {(store: string, key: string) => Promise<void>} del
 * @property {(store: string) => Promise<any[]>} all
 * @property {() => Promise<{usage: number, quota: number}>} estimate
 * @property {() => void} close
 */

/** In-memory backend. Deterministic, synchronous under the hood, always available. */
export class MemoryBackend {
  /** @param {number} [quota] bytes reported by `estimate` */
  constructor(quota = 50 * 1024 * 1024) {
    this.kind = 'memory';
    /** @type {Map<string, Map<string, any>>} */
    this.stores = new Map([[STORE_PROJECTS, new Map()], [STORE_META, new Map()]]);
    this.quota = quota;
  }

  async open() { /* nothing to do */ }

  /** @param {string} store @returns {Map<string, any>} */
  bucket(store) {
    let m = this.stores.get(store);
    if (!m) { m = new Map(); this.stores.set(store, m); }
    return m;
  }

  /** @param {string} store @param {string} key */
  async get(store, key) {
    const v = this.bucket(store).get(key);
    return v === undefined ? undefined : structuredCloneish(v);
  }

  /** @param {string} store @param {any} value */
  async put(store, value) {
    this.bucket(store).set(value.id, structuredCloneish(value));
  }

  /** @param {string} store @param {string} key */
  async del(store, key) { this.bucket(store).delete(key); }

  /** @param {string} store */
  async all(store) {
    return [...this.bucket(store).values()].map(structuredCloneish)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  async estimate() {
    let usage = 0;
    for (const m of this.stores.values()) for (const v of m.values()) usage += utf8Bytes(JSON.stringify(v));
    return { usage, quota: this.quota };
  }

  close() { /* nothing to release */ }
}

/** @template T @param {T} v @returns {T} */
function structuredCloneish(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch { /* fall through for non-cloneable */ }
  }
  return JSON.parse(JSON.stringify(v));
}

/** IndexedDB backend. Used whenever `indexedDB` is reachable. */
export class IndexedDbBackend {
  /**
   * @param {IDBFactory} factory
   * @param {string} [name]
   */
  constructor(factory, name = DB_NAME) {
    this.kind = 'indexeddb';
    this.factory = factory;
    this.name = name;
    /** @type {IDBDatabase|null} */
    this.db = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = this.factory.open(this.name, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      req.onblocked = () => reject(new Error('indexedDB open blocked by another tab'));
    });
  }

  /**
   * @param {string} store
   * @param {IDBTransactionMode} mode
   * @param {(s: IDBObjectStore) => IDBRequest} fn
   */
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('indexedDB not open')); return; }
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
      t.onabort = () => reject(t.error || new Error('indexedDB transaction aborted'));
    });
  }

  /** @param {string} store @param {string} key */
  get(store, key) { return this.tx(store, 'readonly', (s) => s.get(key)); }
  /** @param {string} store @param {any} value */
  async put(store, value) { await this.tx(store, 'readwrite', (s) => s.put(value)); }
  /** @param {string} store @param {string} key */
  async del(store, key) { await this.tx(store, 'readwrite', (s) => s.delete(key)); }
  /** @param {string} store */
  async all(store) {
    const rows = await this.tx(store, 'readonly', (s) => s.getAll());
    return (rows || []).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  async estimate() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && nav.storage && typeof nav.storage.estimate === 'function') {
      const e = await nav.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
    const rows = await this.all(STORE_PROJECTS);
    let usage = 0;
    for (const r of rows) usage += r.bytes || utf8Bytes(JSON.stringify(r));
    return { usage, quota: 0 };
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}

/**
 * Choose a backend. Never throws: an IndexedDB refusal degrades to memory and
 * the caller learns about it from `store.degraded`.
 * @param {object} [env]
 * @param {IDBFactory|null} [env.indexedDB]
 * @param {number} [env.memoryQuota]
 * @returns {Promise<{backend: StorageBackend, degraded: string|null}>}
 */
export async function selectBackend(env = {}) {
  const factory = env.indexedDB !== undefined
    ? env.indexedDB
    : (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (factory) {
    const be = new IndexedDbBackend(factory);
    try {
      await be.open();
      return { backend: be, degraded: null };
    } catch (e) {
      return {
        backend: new MemoryBackend(env.memoryQuota),
        degraded: `IndexedDB unavailable (${e instanceof Error ? e.message : String(e)}); using in-memory storage. Export your project before closing this tab.`,
      };
    }
  }
  return { backend: new MemoryBackend(env.memoryQuota), degraded: null };
}

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

/**
 * The store the studio talks to. Autosaves on every committed mutation, skips
 * a save whose content hash is unchanged, and reports storage pressure rather
 * than discovering it during a failed write.
 */
export class ProjectStore {
  /**
   * @param {object} args
   * @param {StorageBackend} args.backend
   * @param {() => string} args.clock  ISO-string clock, injected (§5 determinism law)
   * @param {string|null} [args.degraded]
   */
  constructor({ backend, clock, degraded = null }) {
    this.backend = backend;
    this.clock = clock;
    this.degraded = degraded;
    /** @type {Map<string, string>} last-written content hash per project id */
    this.lastHash = new Map();
    /** @type {((n: {level: 'warn'|'critical'|'ok', usage: number, quota: number, ratio: number}) => void)[]} */
    this.pressureListeners = [];
  }

  /**
   * Convenience constructor that picks a backend.
   * @param {object} args
   * @param {() => string} args.clock
   * @param {IDBFactory|null} [args.indexedDB]
   * @param {number} [args.memoryQuota]
   */
  static async open({ clock, indexedDB: idb, memoryQuota }) {
    const { backend, degraded } = await selectBackend({ indexedDB: idb, memoryQuota });
    return new ProjectStore({ backend, clock, degraded });
  }

  /** @param {(n: {level: 'warn'|'critical'|'ok', usage: number, quota: number, ratio: number}) => void} fn */
  onPressure(fn) {
    this.pressureListeners.push(fn);
    return () => { const i = this.pressureListeners.indexOf(fn); if (i >= 0) this.pressureListeners.splice(i, 1); };
  }

  /**
   * Current storage pressure. `quota: 0` means the platform would not say, in
   * which case the ratio is reported as 0 and no warning fires — an unknown
   * quota must not manufacture a false alarm.
   * @returns {Promise<{level: 'ok'|'warn'|'critical', usage: number, quota: number, ratio: number}>}
   */
  async pressure() {
    const { usage, quota } = await this.backend.estimate();
    const ratio = quota > 0 ? usage / quota : 0;
    const level = ratio >= 0.95 ? 'critical' : ratio >= PRESSURE_WARN_RATIO ? 'warn' : 'ok';
    return { level, usage, quota, ratio };
  }

  /**
   * Persist a project. Returns the written record, or the previous one when the
   * content hash is unchanged (`skipped: true`). Never throws on a storage
   * failure — the failure is returned so the UI can surface it (§16).
   * @param {object} args
   * @param {string} args.id
   * @param {string} args.name
   * @param {import('./contracts.d.ts').Proof} args.proof
   * @param {string} args.seed
   * @param {boolean} [args.force]
   * @returns {Promise<{ok: true, value: {record: ProjectRecord, skipped: boolean, pressure: any}} | {ok: false, error: string, detail?: unknown}>}
   */
  async save({ id, name, proof, seed, force = false }) {
    const hash = contentHash(proof);
    if (!force && this.lastHash.get(id) === hash) {
      const prev = await this.load(id);
      if (prev.ok) return ok({ record: prev.value, skipped: true, pressure: await this.pressure() });
    }
    let revision = 1;
    try {
      const existing = await this.backend.get(STORE_PROJECTS, id);
      if (existing && typeof existing.revision === 'number') revision = existing.revision + 1;
    } catch { /* a read failure is not a reason to refuse a write */ }

    const record = makeRecord({ id, name, proof, seed, revision, clock: this.clock });
    const pressure = await this.pressure();
    if (pressure.level !== 'ok') for (const fn of this.pressureListeners) fn(pressure);

    try {
      await this.backend.put(STORE_PROJECTS, record);
      this.lastHash.set(id, hash);
      return ok({ record, skipped: false, pressure });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const quotaish = /quota|storage|full/i.test(msg);
      return err(
        quotaish
          ? `Save failed: storage quota exceeded. Re-compress assets or export the project. (${msg})`
          : `Save failed: ${msg}`,
        e,
      );
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<{ok: true, value: ProjectRecord} | {ok: false, error: string}>}
   */
  async load(id) {
    let raw;
    try { raw = await this.backend.get(STORE_PROJECTS, id); }
    catch (e) { return err(`Load failed: ${e instanceof Error ? e.message : String(e)}`); }
    if (!raw) return err(`No project with id ${id}`);
    const migrated = migrateRecord(raw);
    if (!migrated.ok) return migrated;
    this.lastHash.set(id, migrated.value.contentHash);
    return migrated;
  }

  /**
   * Project summaries, newest save first, without deserializing every proof
   * body twice.
   * @returns {Promise<{id: string, name: string, prospectName: string, savedAt: string, revision: number, bytes: number, schemaVersion: number}[]>}
   */
  async list() {
    let rows = [];
    try { rows = await this.backend.all(STORE_PROJECTS); } catch { rows = []; }
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        prospectName: r.prospectName,
        savedAt: r.savedAt,
        revision: r.revision || 1,
        bytes: r.bytes || 0,
        schemaVersion: r.schemaVersion || 0,
      }))
      .sort((a, b) => (a.savedAt === b.savedAt ? a.id.localeCompare(b.id) : (a.savedAt < b.savedAt ? 1 : -1)));
  }

  /** @param {string} id */
  async remove(id) {
    try { await this.backend.del(STORE_PROJECTS, id); this.lastHash.delete(id); return ok(true); }
    catch (e) { return err(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /**
   * Read a settings value from the meta store. Settings are per-machine and
   * never travel inside a project export — the runtime adapter key in §9 lives
   * here and must never reach an emitted artifact.
   * @param {string} key
   * @param {any} [fallback]
   */
  async getSetting(key, fallback = null) {
    try {
      const row = await this.backend.get(STORE_META, `setting:${key}`);
      return row ? row.value : fallback;
    } catch { return fallback; }
  }

  /** @param {string} key @param {any} value */
  async setSetting(key, value) {
    try { await this.backend.put(STORE_META, { id: `setting:${key}`, value }); return ok(true); }
    catch (e) { return err(`Setting write failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  close() { this.backend.close(); }
}

/**
 * Serialize a project record to the `.pitchproof.json` interchange format
 * (§16). Assets are already inline data URIs inside the proof, so the export is
 * the record itself with a format banner — no side files, no fetches on import.
 * @param {ProjectRecord} record
 * @returns {string}
 */
export function exportProjectJson(record) {
  return JSON.stringify({
    format: 'pitchproof-project',
    formatVersion: SCHEMA_VERSION,
    record,
  }, null, 2);
}

/**
 * Parse a `.pitchproof.json` file back into a record, migrating it forward.
 * @param {string} text
 * @returns {{ok: true, value: ProjectRecord} | {ok: false, error: string}}
 */
export function importProjectJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return err(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!parsed || parsed.format !== 'pitchproof-project') return err('Not a PitchProof project export');
  return migrateRecord(parsed.record);
}
