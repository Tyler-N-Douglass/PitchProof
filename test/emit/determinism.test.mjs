/**
 * §17.6 — "same project emits byte-identical output twice; different seeds
 * produce different ids but identical rendering".
 *
 * The emitter goes further than the letter of the law: no wall-clock value
 * reaches the artifact at all, so the two emits are byte-identical even when
 * the injected clock moves between them. `deps.clock` is read for the §6
 * staleness check and for nothing else.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../../src/emit/index.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, scene, specimen, rendition, brand } from '../fixtures/emit/proofs.mjs';
import { contentId, elementId } from '../../src/core/ids.js';
import { IdMinter } from '../../src/core/ids.js';
import { defaultEmitOptions } from '../../src/core/contracts.js';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();
const deps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

test('two emits of the same proof are byte-identical (§17.6)', async () => {
  registerTestLayouts();
  const proof = emitProof();
  const a = await emit(proof, {}, deps);
  const b = await emit(proof, {}, deps);
  assert.equal(a.ok, true, a.ok ? '' : a.error);
  assert.equal(b.ok, true);
  assert.equal(a.value.bytes, b.value.bytes);
  assert.equal(a.value.html, b.value.html, 'the same project must emit the same bytes');
  assert.deepEqual(a.value.compression, b.value.compression);
});

test('a fresh proof object with the same content emits the same bytes', async () => {
  registerTestLayouts();
  const a = await emit(emitProof(), {}, deps);
  const b = await emit(emitProof(), {}, deps);
  assert.equal(a.value.html, b.value.html);
});

test('key order in the model cannot change the bytes', async () => {
  registerTestLayouts();
  const proof = emitProof();
  const shuffled = {
    emitOptions: proof.emitOptions,
    branches: proof.branches,
    spine: proof.spine,
    recipes: proof.recipes,
    renditions: proof.renditions,
    specimens: proof.specimens,
    brand: proof.brand,
    createdAt: proof.createdAt,
    prospectName: proof.prospectName,
    id: proof.id,
    schemaVersion: proof.schemaVersion,
  };
  const a = await emit(proof, {}, deps);
  const b = await emit(shuffled, {}, deps);
  assert.equal(a.value.html, b.value.html, 'stableStringify must make object key order irrelevant');
});

test('the clock cannot change a single byte of the artifact', async () => {
  registerTestLayouts();
  const proof = emitProof();
  const early = await emit(proof, {}, { runtimeJs, runtimeCss, clock: () => '2026-02-02T00:00:00.000Z' });
  const late = await emit(proof, {}, { runtimeJs, runtimeCss, clock: () => '2031-11-30T23:59:59.000Z' });
  assert.equal(early.ok, true);
  assert.equal(late.ok, true);
  assert.equal(early.value.html, late.value.html, 'no wall-clock value may reach the artifact (§5, §17.6)');
});

test('a later clock changes only the findings, and only STALE_CAPTURE (§6)', async () => {
  registerTestLayouts();
  const proof = emitProof();
  const fresh = await emit(proof, {}, { runtimeJs, runtimeCss, clock: () => '2026-02-10T00:00:00.000Z' });
  const stale = await emit(proof, {}, { runtimeJs, runtimeCss, clock: () => '2026-06-10T00:00:00.000Z' });
  assert.deepEqual(fresh.value.findings, []);
  assert.ok(stale.value.findings.length > 0);
  for (const f of stale.value.findings) {
    assert.equal(f.code, 'STALE_CAPTURE');
    assert.equal(f.severity, 3, 'a stale capture warns; it does not block');
  }
});

test('a different project seed changes ids without changing what renders (§17.6)', async () => {
  registerTestLayouts();

  /** @param {string} seed @returns {import('../../src/core/contracts.d.ts').Proof} */
  const build = (seed) => {
    const minter = new IdMinter(seed, 'test/determinism');
    const specimenId = minter.next('specimen');
    const renditionId = minter.next('rendition');
    const sceneId = minter.next('scene');
    const sp = { ...specimen(specimenId, []), id: specimenId };
    const rd = { ...rendition(renditionId, specimenId, 'client-supplied'), id: renditionId };
    const sc = {
      ...scene(sceneId, { specimenId, blockCount: 3, renditionIds: [renditionId] }),
      beats: [
        { id: `${sceneId}_b0`, reveals: [elementId(sceneId, 'before/block/0')], presenterNote: null, dwellHintMs: null },
        { id: `${sceneId}_b1`, reveals: [elementId(sceneId, 'after/0')], presenterNote: null, dwellHintMs: null },
      ],
    };
    return {
      schemaVersion: 1,
      id: contentId('proof', seed),
      prospectName: 'Northwind Industrial',
      createdAt: '2026-02-01T09:00:00.000Z',
      brand: brand(),
      specimens: [sp],
      renditions: [rd],
      recipes: [],
      spine: [sc],
      branches: [],
      emitOptions: defaultEmitOptions(),
    };
  };

  const one = build('seed-one');
  const two = build('seed-two');
  assert.notEqual(one.spine[0].id, two.spine[0].id, 'a different seed must mint different ids');

  const a = await emit(one, {}, deps);
  const b = await emit(two, {}, deps);
  assert.equal(a.ok, true, a.ok ? '' : a.error);
  assert.equal(b.ok, true, b.ok ? '' : b.error);
  assert.notEqual(a.value.html, b.value.html, 'different ids must be visible in the file');

  /** Strip every minted id, leaving only what a viewer would see. */
  const rendered = (html) => html
    .replace(/(sp|rd|sc|pf|br|lg|md|el|bt|bn|fd|rc)_[0-9a-f]{10,12}/g, 'ID')
    .replace(/data-pp-hash="[^"]*"/g, 'data-pp-hash="H"');

  const stageOf = (html) => rendered(html).slice(html.indexOf('<div id="pp-stage-root"'), html.indexOf('<noscript>'));
  assert.equal(stageOf(a.value.html), stageOf(b.value.html), 'the rendered output must be identical once ids are normalised');
});

test('findings are deterministic in id and order', async () => {
  registerTestLayouts({ omitLabel: true });
  const proof = emitProof();
  const a = await emit(proof, {}, deps);
  const b = await emit(proof, {}, deps);
  assert.equal(a.ok, false);
  assert.deepEqual(a.detail.findings.map((f) => f.id), b.detail.findings.map((f) => f.id));
  assert.deepEqual(a.detail.findings.map((f) => f.message), b.detail.findings.map((f) => f.message));
});

test('degradation plans are deterministic', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 200 });
  // Measure the artifact at full fidelity, then ask for a fraction of it. A
  // hardcoded budget would silently become unreachable the moment the runtime
  // bundle grows, and the test would then be asserting the wrong thing.
  const full = await emit(proof, { maxBytes: 50_000_000 }, deps);
  const budget = Math.round(full.value.bytes * 0.85);
  const a = await emit(proof, { maxBytes: budget }, deps);
  const b = await emit(proof, { maxBytes: budget }, deps);
  assert.equal(a.ok, true, a.ok ? '' : a.error);
  assert.deepEqual(a.value.degradations, b.value.degradations);
  assert.equal(a.value.html, b.value.html);
});
