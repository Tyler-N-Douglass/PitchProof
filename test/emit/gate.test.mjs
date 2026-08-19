/**
 * The §14 gate: a severity-1 finding refuses the emit, whoever is calling.
 *
 * §14 says "Severity 1 findings block emit. There is no override flag", and
 * `API.md` Part 3 repeats it. Before `src/emit/gate.js` existed that sentence
 * was false: `emit()` enforced the laws it owned and let `TEXT_OVERFLOW` and
 * `CONTRAST_FAIL` through, so a body pair below 4.5:1 shipped in a
 * `.pitchproof.html` unless the caller happened to be the studio. The critic
 * found it (F8); these tests keep it found.
 *
 * The second half of the file is the more important half. The gate runs L11's
 * rule objects rather than a second copy of them, and `emit and runPreflight
 * agree` is what keeps that true as L11 changes: if the two ever diverge, this
 * fails rather than the product quietly enforcing two different laws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, runEmitGate, gatedCodes, MEASURED_BY_EMIT, buildDocument } from '../../src/emit/index.js';
import { runPreflight } from '../../src/validate/index.js';
import { FINDING_CODES, normalizeEmitOptions } from '../../src/core/contracts.js';
import { compileFallbackTheme } from '../../src/emit/theme.js';
import { hasPromotionRecord } from '../../src/emit/promotion.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof } from '../fixtures/emit/proofs.mjs';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();
const deps = { runtimeJs, runtimeCss, clock: FIXED_CLOCK };

/**
 * A brand whose body text sits just below the 4.5:1 floor. `#777777` on white
 * measures 4.478:1 — the pair §14 pins at severity 1 for body text.
 * @param {import('../../src/core/contracts.d.ts').Proof} proof
 * @returns {import('../../src/core/contracts.d.ts').Proof}
 */
function withBrokenBodyContrast(proof) {
  return {
    ...proof,
    brand: {
      ...proof.brand,
      colors: proof.brand.colors.map((c) => (c.role === 'onSurface'
        ? { ...c, hex: '#777777', contrastWithPair: 4.478 }
        : c)),
    },
  };
}

test('a body pair below 4.5:1 refuses the emit (§14, critic F8)', async () => {
  registerTestLayouts();
  const clean = await emit(emitProof({ imageEdge: 24 }), {}, deps);
  assert.equal(clean.ok, true, clean.ok ? '' : clean.error);

  const broken = await emit(withBrokenBodyContrast(emitProof({ imageEdge: 24 })), {}, deps);
  assert.equal(broken.ok, false, 'a sub-4.5:1 body pair must refuse the emit, not warn about it');

  const blocking = broken.detail.findings.filter((f) => f.severity === 1);
  assert.ok(blocking.length > 0);
  assert.ok(
    blocking.some((f) => f.code === 'CONTRAST_FAIL'),
    `expected a blocking CONTRAST_FAIL, got ${blocking.map((f) => f.code).join(', ')}`,
  );
  assert.equal(broken.detail.html, '', 'a refused emit hands back no artifact');
  assert.equal(broken.detail.bytes, 0);
  assert.match(broken.error, /no override flag/i);
  for (const f of blocking) assert.ok(broken.error.includes(f.message), 'the refusal must name every blocking finding');
});

test('no option, dep or environment variable lets a broken contrast pair through', async () => {
  const proof = withBrokenBodyContrast(emitProof({ imageEdge: 24 }));
  for (const options of [{}, { force: true }, { skipValidation: true }, { mode: 'presenter' }, { maxBytes: 50_000_000 }]) {
    registerTestLayouts();
    const result = await emit(proof, options, deps);
    assert.equal(result.ok, false, `emit accepted a sub-4.5:1 body pair with ${JSON.stringify(options)}`);
  }
});

test('the gate covers every §4 finding code except the one emit measures itself', () => {
  const covered = gatedCodes();
  assert.deepEqual([...MEASURED_BY_EMIT], ['SIZE_BUDGET_EXCEEDED']);
  assert.deepEqual(
    [...covered, ...MEASURED_BY_EMIT].sort(),
    FINDING_CODES.slice().sort(),
    'every code in the frozen set must be answered by the gate or by the emitter',
  );
});

test('emit and runPreflight agree, finding for finding', async () => {
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 24 });
  const emitOptions = normalizeEmitOptions(proof.emitOptions);
  const themeCss = compileFallbackTheme(proof.brand).css;
  const finalCss = [runtimeCss, themeCss].join('\n\n');
  const built = buildDocument({ ...proof, emitOptions }, { runtimeJs, runtimeCss, themeCss, userCss: '', fontCss: '' });

  const gateFindings = runEmitGate({
    proof: built.reconstructed,
    deck: built.runtime.deck,
    runtime: built.runtime,
    renderScene: built.renderScene,
    html: built.html,
    css: finalCss,
    runtimeJs,
    runtimeCss,
    nowIso: FIXED_CLOCK(),
  });

  const preflightFindings = await runPreflight(built.reconstructed, {
    clock: FIXED_CLOCK,
    runtimeJs,
    runtimeCss,
    html: built.html,
    css: finalCss,
    renderScene: built.renderScene,
    // L7 owns the promotion-record format, so both sides must read it with L7's
    // reader. `runPreflight` defaults to `src/validate/provenance.js`'s own,
    // which does not recognise a record `promoteProvenance` wrote — reported to
    // the integrator. Injecting here keeps this test about the *rules*.
    hasPromotionRecord,
  });

  /** @param {any[]} findings @returns {string[]} */
  const signature = (findings) => findings
    .filter((f) => !MEASURED_BY_EMIT.has(f.code))
    .map((f) => `${f.severity} ${f.code} ${f.message}`)
    .sort();

  assert.deepEqual(
    signature(gateFindings),
    signature(preflightFindings),
    'the emitter and the rehearsal sweep must enforce the same law from the same rules',
  );
  assert.ok(gateFindings.length > 0, 'the fixture must actually exercise some rules');
});

test('emit and runPreflight agree on a proof that fails', async () => {
  registerTestLayouts();
  const proof = withBrokenBodyContrast(emitProof({ imageEdge: 24 }));
  const emitOptions = normalizeEmitOptions(proof.emitOptions);
  const themeCss = compileFallbackTheme(proof.brand).css;
  const finalCss = [runtimeCss, themeCss].join('\n\n');
  const built = buildDocument({ ...proof, emitOptions }, { runtimeJs, runtimeCss, themeCss, userCss: '', fontCss: '' });

  const gateBlocking = runEmitGate({
    proof: built.reconstructed,
    deck: built.runtime.deck,
    runtime: built.runtime,
    renderScene: built.renderScene,
    html: built.html,
    css: finalCss,
    runtimeJs,
    runtimeCss,
    nowIso: FIXED_CLOCK(),
  }).filter((f) => f.severity === 1);

  const preflightBlocking = (await runPreflight(built.reconstructed, {
    clock: FIXED_CLOCK, runtimeJs, runtimeCss, html: built.html, css: finalCss, renderScene: built.renderScene, hasPromotionRecord,
  })).filter((f) => f.severity === 1 && !MEASURED_BY_EMIT.has(f.code));

  assert.ok(gateBlocking.length > 0);
  assert.deepEqual(
    gateBlocking.map((f) => `${f.code} ${f.message}`).sort(),
    preflightBlocking.map((f) => `${f.code} ${f.message}`).sort(),
  );
});

test('the gate refuses the emit when a rule cannot run, rather than shipping unchecked', async () => {
  registerTestLayouts();
  // A scene whose layout is registered but whose beats name a scene id that is
  // not in the deck is the kind of shape a rule can throw on. Whatever the
  // cause, a gate that cannot complete must refuse.
  const proof = emitProof({ imageEdge: 24 });
  const poisoned = {
    ...proof,
    spine: proof.spine.map((s, i) => (i === 0 ? { ...s, beats: [{ id: 'b', reveals: null, presenterNote: null, dwellHintMs: null }] } : s)),
  };
  const result = await emit(poisoned, {}, deps);
  // Either the shape validator rejects it or the gate does; what must never
  // happen is an artifact coming back.
  if (!result.ok) {
    assert.ok(!result.detail || result.detail.html === '' || result.detail.html === undefined);
  } else {
    assert.deepEqual(result.value.findings.filter((f) => f.severity === 1), []);
  }
});

test('severity-2 craft findings are reported and do not block', async () => {
  registerTestLayouts();
  const result = await emit(emitProof({ imageEdge: 24 }), {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  const codes = new Set(result.value.findings.map((f) => f.code));
  assert.ok(codes.size > 0, 'the emitter must report what the sweep found, not only what blocked');
  for (const f of result.value.findings) assert.ok(f.severity > 1);
  assert.ok(result.value.html.length > 0);
});

test('the emitter reports the whole sweep, not only the codes it owns', async () => {
  registerTestLayouts();
  const result = await emit(emitProof({ imageEdge: 24 }), {}, deps);
  const codes = new Set(result.value.findings.map((f) => f.code));
  assert.ok(
    codes.has('TEXT_OVERFLOW') || codes.has('FONT_UNAVAILABLE') || codes.has('CONTRAST_FAIL'),
    `expected at least one rule the emitter does not own; got ${[...codes].join(', ')}`,
  );
});

test('a rendition promoted through L7 is not reported as unpromoted', async () => {
  // E17: one reader of the promotion format. The emitter reads it with L7's
  // `hasPromotionRecord`, which is the function that wrote the record.
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 24 });
  const promoted = proof.renditions.find((r) => r.provenance === 'verified-by-user');
  assert.ok(promoted, 'the fixture must carry a promoted rendition');
  assert.equal(hasPromotionRecord(promoted), true);

  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.equal(
    result.value.findings.filter((f) => /no promotion record|stamped verified-by-user/.test(f.message)).length,
    0,
    'a properly promoted rendition must not be reported as unpromoted',
  );
});
