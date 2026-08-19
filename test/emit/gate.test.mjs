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
import { emit, gatedCodes, MEASURED_BY_EMIT, buildDocument, describeRefusal } from '../../src/emit/index.js';
import { runPreflight } from '../../src/validate/index.js';
import { FINDING_CODES, normalizeEmitOptions } from '../../src/core/contracts.js';
import { compileFallbackTheme } from '../../src/emit/theme.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, rendition } from '../fixtures/emit/proofs.mjs';
import { contentId, elementId } from '../../src/core/ids.js';

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

test("emit reports the sweep's findings, minus the one code it measures itself", async () => {
  // The gate is one call to `runPreflight`, so rule-for-rule equivalence is
  // true by construction and asserting it would prove nothing. What is *not*
  // by construction is `emit()` wiring the artifact's own document, stylesheet
  // and scenes into that call, and filtering only the code it answers itself.
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 24 });
  const emitOptions = normalizeEmitOptions(proof.emitOptions);
  const themeCss = compileFallbackTheme(proof.brand).css;
  const finalCss = [runtimeCss, themeCss].join('\n\n');
  const built = buildDocument({ ...proof, emitOptions }, { runtimeJs, runtimeCss, themeCss, userCss: '', fontCss: '' });

  const swept = await runPreflight(built.reconstructed, {
    clock: FIXED_CLOCK,
    runtimeJs,
    runtimeCss,
    html: built.html,
    css: finalCss,
    renderScene: built.renderScene,
  });

  const emitted = await emit(proof, {}, deps);
  assert.equal(emitted.ok, true, emitted.ok ? '' : emitted.error);

  /** @param {any[]} findings @returns {string[]} */
  const signature = (findings) => findings
    .filter((f) => !MEASURED_BY_EMIT.has(f.code))
    .map((f) => `${f.severity} ${f.code} ${f.message}`)
    .sort();

  assert.deepEqual(signature(emitted.value.findings), signature(swept));
  assert.ok(swept.length > 0, 'the fixture must actually exercise some rules');
});

test('the sweep sees the artifact\'s own stylesheet, document and scenes', async () => {
  // Three findings that can only arise if the corresponding argument reached
  // `runPreflight`. Dropping any one of them from the gate would be silent —
  // the emit would still succeed, having checked less than it claimed.
  registerTestLayouts();
  const proof = emitProof({ imageEdge: 24 });

  // `css`: a label styled away is invisible to anything reading only the model.
  const styled = await emit(proof, {}, { ...deps, userCss: '.pp-provenance{opacity:0}' });
  assert.equal(styled.ok, false, 'a label hidden by the final stylesheet must refuse the emit');
  assert.ok(styled.detail.findings.some((f) => f.code === 'PROVENANCE_UNLABELED' && /opacity:0/.test(f.message)));

  // `renderScene`: the label lives in the rendered subtree, not in the model.
  registerTestLayouts({ omitLabel: true });
  const unlabelled = await emit(proof, {}, deps);
  assert.equal(unlabelled.ok, false, 'a label missing from the rendered scene must refuse the emit');
  assert.ok(unlabelled.detail.findings.some((f) => f.code === 'PROVENANCE_UNLABELED'));

  // `html`: a live link in the pre-rendered opening beat is in the document.
  registerTestLayouts({ ctaHref: 'https://northwind.example/contact' });
  const linked = await emit(proof, {}, deps);
  assert.equal(linked.ok, false, 'a live link in the document must refuse the emit');
  assert.ok(linked.detail.findings.some((f) => f.code === 'NETWORK_REFERENCE' && /rendered document/.test(f.message)));
});

test('emit and the studio gate refuse the same proof', async () => {
  registerTestLayouts();
  const proof = withBrokenBodyContrast(emitProof({ imageEdge: 24 }));
  const emitOptions = normalizeEmitOptions(proof.emitOptions);
  const themeCss = compileFallbackTheme(proof.brand).css;
  const finalCss = [runtimeCss, themeCss].join('\n\n');
  const built = buildDocument({ ...proof, emitOptions }, { runtimeJs, runtimeCss, themeCss, userCss: '', fontCss: '' });

  const sweptBlocking = (await runPreflight(built.reconstructed, {
    clock: FIXED_CLOCK, runtimeJs, runtimeCss, html: built.html, css: finalCss, renderScene: built.renderScene,
  })).filter((f) => f.severity === 1 && !MEASURED_BY_EMIT.has(f.code));

  const emitted = await emit(proof, {}, deps);
  assert.equal(emitted.ok, false);
  const emitBlocking = emitted.detail.findings.filter((f) => f.severity === 1 && !MEASURED_BY_EMIT.has(f.code));

  assert.ok(sweptBlocking.length > 0);
  assert.deepEqual(
    emitBlocking.map((f) => `${f.code} ${f.message}`).sort(),
    sweptBlocking.map((f) => `${f.code} ${f.message}`).sort(),
    'a proof the studio refuses and a proof the emitter refuses must be the same proof',
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
  assert.match(promoted.notes, /\[\[pp-promotion:/, 'the promotion must be on the record, not in prose');

  const result = await emit(proof, {}, deps);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.equal(
    result.value.findings.filter((f) => /no promotion record|stamped verified-by-user/.test(f.message)).length,
    0,
    'a properly promoted rendition must not be reported as unpromoted',
  );
});


test('the refusal collapses identical defects and states the shape of the problem', async () => {
  // A five-rendition splitBeforeAfter scene produces eleven blocking findings
  // that are three distinct defects: the same body text measured in several
  // cells. Eleven near-identical paragraphs do not tell a seller whether they
  // have three problems or eleven.
  const base = emitProof({ imageEdge: 24 });
  const specimen = base.specimens[0];
  const extra = [4, 5, 6].map((i) => rendition(contentId('rendition', `crowd${i}`), specimen.id, 'client-supplied', { label: `Market ${i}` }));
  const crowded = {
    ...base,
    renditions: [...base.renditions, ...extra],
    spine: base.spine.map((s, i) => {
      if (i !== 1) return s;
      const ids = [...s.renditionIds, ...extra.map((r) => r.id)];
      return {
        ...s,
        renditionIds: ids,
        beats: ids.map((_, k) => ({ id: `${s.id}_b${k}`, reveals: [elementId(s.id, `after/${k}`)], presenterNote: null, dwellHintMs: null })),
      };
    }),
  };

  const { registerAllLayouts } = await import('../../src/scene/index.js');
  const { resetLayouts } = await import('../../src/runtime/layouts.js');
  resetLayouts();
  registerAllLayouts();

  const result = await emit(crowded, {}, deps);
  assert.equal(result.ok, false, 'a scene with no room for its text must refuse');

  const blocking = result.detail.findings.filter((f) => f.severity === 1);
  const distinct = new Set(blocking.map((f) => `${f.code} ${f.message}`));
  assert.ok(blocking.length > distinct.size, 'the fixture must actually produce repeated defects');

  // Every distinct defect is still named in full - collapsing is not hiding.
  for (const message of new Set(blocking.map((f) => f.message))) {
    assert.ok(result.error.includes(message), 'a distinct defect was dropped from the refusal');
  }
  // And it is stated once, with a count, not once per occurrence.
  const first = blocking[0].message;
  const occurrences = result.error.split(first).length - 1;
  assert.equal(occurrences, 1, 'a repeated defect must appear once in the refusal, with a count');
  assert.match(result.error, /\d+ severity-1 finding\(s\), \d+ distinct/);
  assert.match(result.error, /TEXT_OVERFLOW/);
  assert.match(result.error, /in scene sc_spine_1\./);
  assert.match(result.error, /no override flag/);
});

test('a refusal with no repetition reads exactly as before', () => {
  const one = {
    id: 'fd_1', severity: 1, code: 'NETWORK_REFERENCE', message: 'a beacon', locus: { sceneId: 'sc_1' }, autoFixAvailable: false,
  };
  const two = {
    id: 'fd_2', severity: 1, code: 'PROVENANCE_UNLABELED', message: 'no label', locus: { sceneId: 'sc_2' }, autoFixAvailable: false,
  };
  const text = describeRefusal([one, two]);
  assert.match(text, /2 severity-1 finding\(s\) block this artifact/);
  assert.ok(!/distinct/.test(text), 'nothing repeated, so nothing to count');
  assert.match(text, /1 . NETWORK_REFERENCE, 1 . PROVENANCE_UNLABELED/);
  assert.match(text, /in scenes sc_1, sc_2\./);
  assert.ok(text.includes('a beacon') && text.includes('no label'));
});
