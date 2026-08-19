/**
 * §18.3 at the emitter: *if a specimen was edited, the artifact says so.*
 *
 * §18.1 is a law because `assertProvenance` refuses when the label is missing
 * or unreadable. §18.3 had the same three lanes behind it — L6 records the
 * edit, L11's `ASSET_MISSING` fix calls `markEdited` when it takes the
 * prospect's own content out, L8 renders `.pp-edited` in all eight layouts —
 * and nothing that checked the marker arrived. A layout that stopped rendering
 * it, or a brand stylesheet that faded it, would have shipped in silence, and
 * what ships in that case is a client being shown material the presenting team
 * changed as if it were their own page as captured. That is §22.6's sentence
 * with one noun replaced, so it is refused where §22.6 says to refuse it.
 *
 * The file is in two halves, and the second half is the one that matters most:
 *
 *   - **the attacks** — the marker removed, and every route P8 and C9 closed
 *     against `.pp-provenance` re-run against `.pp-edited`;
 *   - **the false positives** — a marker styled hard but still readable, which
 *     must emit. A rule that refuses a hidden marker and also refuses a
 *     legitimately styled one is worse than no rule (P8's precedent: `invert(1)`
 *     on a marker with its own background still reads, and still emits).
 *
 * Every attack is run through `emit()` itself, so what is asserted is a
 * refusal of the artifact rather than a finding a caller could ignore.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../../src/emit/index.js';
import {
  assertProvenance, editedScenesOf, htmlHasClass, markerFor, judgeLabelStyle,
  documentChainPrefix, describeElement,
  PROTECTED_MARKERS, LABEL_MARKER, EDITED_MARKER,
  EDITED_MARK_CLASS, PROVENANCE_LABEL_CLASS, SPECIMEN_ATTR, EDITED_FOR_ATTR,
} from '../../src/emit/provenance.js';
import { parseStylesheet } from '../../src/emit/css.js';
import { h } from '../../src/core/vdom.js';
import { registerLayout, resetLayouts } from '../../src/runtime/layouts.js';
import { SCENE_LAYOUTS } from '../../src/core/contracts.js';
import { registerAllLayouts } from '../../src/scene/index.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof, scene as sceneFixture } from '../fixtures/emit/proofs.mjs';
import { Runtime } from '../../src/runtime/runtime.js';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();

const NOTES = [
  'Removed an image whose file was missing from the capture. It would have shown to the room as a broken image. Everything else on the page is as it was captured.',
  'Shortened the page heading so it fits the panel.',
];

/**
 * The fixture proof with its first specimen marked edited. That specimen is on
 * three scenes across two sequences and three layouts — `splitBeforeAfter`
 * twice (which hangs the pill on its own panel head) and `fullBleed` (which has
 * no panel and gets the notice strip), so both of L8's routes are covered.
 * @param {object} [options]
 * @param {boolean} [options.flagOnly]   set `edited` and no notes
 * @param {boolean} [options.notesOnly]  set notes and no `edited` flag
 * @param {number} [options.imageEdge]
 */
function editedProof(options = {}) {
  const proof = emitProof({ imageEdge: options.imageEdge ?? 32 });
  const specimens = proof.specimens.map((sp, i) => {
    if (i !== 0) return sp;
    if (options.flagOnly) return { ...sp, edited: true };
    if (options.notesOnly) return { ...sp, editNotes: NOTES };
    return { ...sp, edited: true, editNotes: NOTES };
  });
  return { ...proof, specimens };
}

/** The specimen every helper above marks. */
const subjectOf = (proof) => proof.specimens[0];

/**
 * @param {object} [options]
 * @param {string} [options.userCss]
 * @param {'real'|'bare'} [options.layouts]
 * @param {import('../../src/core/contracts.d.ts').Proof} [options.proof]
 * @param {Partial<import('../../src/core/contracts.d.ts').EmitOptions>} [options.emitOptions]
 */
async function attempt(options = {}) {
  if (options.layouts === 'bare') registerTestLayouts({});
  else { resetLayouts(); registerAllLayouts(); }
  return emit(options.proof || editedProof(), options.emitOptions || {}, {
    runtimeJs,
    runtimeCss,
    clock: FIXED_CLOCK,
    userCss: options.userCss || '',
  });
}

/**
 * @param {any} result
 * @param {RegExp} messageMatch
 * @param {string} what
 */
function assertBlocked(result, messageMatch, what) {
  assert.equal(result.ok, false, `${what} was NOT blocked — the emit succeeded`);
  const findings = result.detail.findings.filter((f) => f.code === 'PROVENANCE_UNLABELED');
  assert.ok(findings.length > 0, `${what} produced no PROVENANCE_UNLABELED finding`);
  for (const f of findings) {
    assert.equal(f.severity, 1, `${what} produced severity ${f.severity}; §14 fixes PROVENANCE_UNLABELED at 1`);
  }
  assert.ok(
    findings.some((f) => messageMatch.test(f.message)),
    `${what}: no finding matched ${messageMatch}. Got: ${findings.map((f) => f.message).join(' | ')}`,
  );
  assert.equal(result.detail.html, '', `${what}: a refused emit must not hand back an artifact`);
  assert.match(result.error, /no override flag/i);
}

/**
 * @param {any} result
 * @param {string} what
 */
function assertClean(result, what) {
  assert.equal(result.ok, true, `${what} was refused: ${result.ok ? '' : result.error}`);
  assert.deepEqual(
    result.value.findings.filter((f) => f.severity === 1),
    [],
    `${what} produced blocking findings`,
  );
}

// ---------------------------------------------------------------------------
// The control: the real deck, with an edited specimen on it.
// ---------------------------------------------------------------------------

test('the control case — an edited specimen through the real layouts emits, and the marker is in the file', async () => {
  const result = await attempt();
  assertClean(result, 'an edited specimen through L8\'s eight layouts');
  assert.ok(
    htmlHasClass(result.value.html, EDITED_MARK_CLASS),
    'the opening scene renders the edited specimen, so the marker must be in the emitted bytes',
  );
});

test('all eight §4 layouts satisfy the check — the emitter agrees with L8 on every one', () => {
  resetLayouts();
  registerAllLayouts();
  const base = editedProof();
  const subject = subjectOf(base);
  // One scene per layout, every one of them showing the edited specimen. Four
  // of L8's layouts hang the pill on a panel of their own and four have nowhere
  // to hang it and get `withEditedNotice`'s strip; a check that only ever saw
  // the first four would pass while half the deck shipped silent.
  const proof = {
    ...base,
    spine: SCENE_LAYOUTS.map((layout, i) => sceneFixture(`sc_${layout}`, {
      layout, specimenId: subject.id, blockCount: i === 0 ? 2 : 1,
    })),
    branches: [],
  };
  assert.equal(editedScenesOf(proof).size, SCENE_LAYOUTS.length);

  const runtime = new Runtime(proof, { mode: 'both' });
  const findings = assertProvenance(proof, '', runtimeCss, {
    renderScene: (scene) => runtime.renderScene(scene),
  }).filter((f) => String(f.locus.check || '').startsWith('edited'));
  assert.deepEqual(
    findings.map((f) => `${f.locus.sceneId}: ${f.message}`),
    [],
    'a layout L8 covers that the emitter refuses is a false positive, and a false positive is how a law gets switched off',
  );
});

test('an unedited proof renders no marker and is not asked for one', async () => {
  const proof = emitProof({ imageEdge: 32 });
  assert.equal(editedScenesOf(proof).size, 0, 'the baseline fixture must start unedited');
  const result = await attempt({ proof });
  assertClean(result, 'the unedited baseline');
  assert.ok(
    !htmlHasClass(result.value.html, EDITED_MARK_CLASS),
    'a marker on content nobody edited says nothing — that is how an honesty marker dies',
  );
});

// ---------------------------------------------------------------------------
// The expectation, derived from the model.
// ---------------------------------------------------------------------------

test('the expectation is derived the way the runtime derives ctx.specimen', () => {
  const proof = editedProof();
  const subject = subjectOf(proof);
  const scenes = editedScenesOf(proof);
  assert.ok(scenes.size >= 3, `the fixture must put the edited specimen on several scenes, got ${scenes.size}`);
  for (const [sceneId, specimen] of scenes) {
    assert.equal(specimen.id, subject.id, `scene ${sceneId} resolved the wrong specimen`);
  }
  // Every scene naming that specimen, and no other scene.
  const named = [...proof.spine, ...proof.branches.flatMap((b) => b.scenes)]
    .filter((sc) => sc.specimenId === subject.id).map((sc) => sc.id).sort();
  assert.deepEqual([...scenes.keys()].sort(), named);
});

test('edit notes with no `edited` flag still require the marker (L8\'s reader, not a second one)', async () => {
  const proof = editedProof({ notesOnly: true });
  assert.ok(editedScenesOf(proof).size > 0, 'notes alone must count as edited');
  const bare = await attempt({ proof, layouts: 'bare' });
  assertBlocked(bare, /which the presenting team edited after capture/, 'a specimen carrying notes and no flag');
});

test('the `edited` flag with no notes requires the marker, and the refusal does not claim records it has not got', async () => {
  const proof = editedProof({ flagOnly: true });
  const bare = await attempt({ proof, layouts: 'bare' });
  assertBlocked(bare, /which the presenting team edited after capture, but the scene rendered no/, 'a specimen flagged with no notes');
  const finding = bare.detail.findings.find((f) => /edited after capture/.test(f.message));
  assert.ok(!/edit record\(s\)/.test(finding.message), 'a specimen with no notes must not be described as carrying records');
});

// ---------------------------------------------------------------------------
// Attack 1: do not render it.
// ---------------------------------------------------------------------------

test('attack 1: a layout that renders no edit marker at all is refused', async () => {
  const proof = editedProof();
  const subject = subjectOf(proof);
  const result = await attempt({ proof, layouts: 'bare' });
  assertBlocked(result, /the scene rendered no \.pp-edited element for it/, 'a layout that drops the marker');

  const finding = result.detail.findings.find((f) => /the scene rendered no \.pp-edited element for it/.test(f.message));
  assert.match(finding.message, new RegExp(subject.id), 'the refusal must name the specimen');
  assert.match(finding.message, /2 edit record\(s\)/, 'the refusal must name how many records the seller can go and read');
  assert.match(finding.message, /as if it were their own page as captured/, 'the refusal must say what the client would see');
  assert.equal(finding.locus.specimenId, subject.id);
});

test('attack 1 is refused in a presenter-only build as well — §18.3 has no off switch', async () => {
  for (const mode of ['presenter', 'review', 'both']) {
    const result = await attempt({ proof: editedProof(), layouts: 'bare', emitOptions: { mode } });
    assertBlocked(result, /the scene rendered no \.pp-edited element for it/, `a dropped marker in mode "${mode}"`);
  }
});

test('attack 1b: the marker in the tree but not in the emitted document', () => {
  const proof = editedProof();
  const findings = assertProvenance(proof, '<html><body><div id="pp-stage-root"></div></body></html>', runtimeCss, {
    renderScene: (scene) => h('div', { class: 'pp-scene' },
      h('div', { [SPECIMEN_ATTR]: scene.specimenId },
        h('p', { class: EDITED_MARK_CLASS }, 'Edited by the presenting team — not as captured'))),
  });
  const serialized = findings.filter((f) => f.locus.check === 'edited-serialized');
  assert.equal(serialized.length, 1, `expected one serialization finding, got ${findings.map((f) => f.locus.check).join(', ')}`);
  assert.match(serialized[0].message, /no \.pp-edited element reached the emitted document/);
  assert.equal(serialized[0].severity, 1);
});

test('the document check reads class tokens, so `pp-edited-notice` is not `pp-edited`', () => {
  assert.equal(htmlHasClass('<ul class="pp-edited-notice"><li></li></ul>', EDITED_MARK_CLASS), false);
  assert.equal(htmlHasClass('<p class="pp-edited-notice-name">x</p>', EDITED_MARK_CLASS), false);
  assert.equal(htmlHasClass('<p class="pp-stack-meta pp-edited">x</p>', EDITED_MARK_CLASS), true);
  assert.equal(htmlHasClass("<p class='pp-edited'>x</p>", EDITED_MARK_CLASS), true);
  assert.equal(htmlHasClass('<p class=pp-edited>x</p>', EDITED_MARK_CLASS), true);
  // The same hazard on the other marker: the ledger is not the label.
  assert.equal(htmlHasClass('<ul class="pp-provenance-ledger"></ul>', PROVENANCE_LABEL_CLASS), false);
});

test('assertProvenance refuses rather than assumes when it cannot render an edited scene', () => {
  const findings = assertProvenance(editedProof(), '', runtimeCss, {});
  const unrendered = findings.filter((f) => f.locus.check === 'edited-render');
  assert.ok(unrendered.length > 0, 'no renderer and an edited specimen must refuse, not pass');
  for (const f of unrendered) {
    assert.equal(f.severity, 1);
    assert.match(f.message, /refused rather than assumed correct/);
  }
});

test('a marker that renders no text says nothing', () => {
  const proof = editedProof();
  const findings = assertProvenance(proof, '', runtimeCss, {
    renderScene: (scene) => h('div', { class: 'pp-scene' },
      h('div', { [SPECIMEN_ATTR]: scene.specimenId }, h('p', { class: EDITED_MARK_CLASS }, ''))),
  });
  const empty = findings.filter((f) => f.locus.check === 'edited-text');
  assert.ok(empty.length > 0, 'an empty marker must be refused');
  assert.match(empty[0].message, /does not say the specimen was edited \(§18\.3\)/);
});

test('a marker that names its specimen but sits in no scope is accepted — the client can still read it', () => {
  const proof = editedProof();
  const subject = subjectOf(proof);
  const findings = assertProvenance(proof, `<p class="${EDITED_MARK_CLASS}">Edited</p>`, runtimeCss, {
    renderScene: () => h('div', { class: 'pp-scene' },
      h('p', { class: EDITED_MARK_CLASS, [EDITED_FOR_ATTR]: subject.id },
        'Edited by the presenting team — not as captured')),
  });
  assert.deepEqual(
    findings.filter((f) => String(f.locus.check || '').startsWith('edited')),
    [],
    'a visible, correctly attributed marker must not be refused for a missing ancestor attribute',
  );
});

test('a marker naming a different specimen does not satisfy the law for this one', () => {
  const proof = editedProof();
  const findings = assertProvenance(proof, '', runtimeCss, {
    renderScene: () => h('div', { class: 'pp-scene' },
      h('p', { class: EDITED_MARK_CLASS, [EDITED_FOR_ATTR]: 'sp_somebody_else' }, 'Edited')),
  });
  assert.ok(
    findings.some((f) => f.locus.check === 'edited-present'),
    'a marker about another specimen is not a marker about this one',
  );
});

// ---------------------------------------------------------------------------
// Attacks 2-9: every route closed against `.pp-provenance`, re-run on the pill.
//
// The selector is `.pp-scene .pp-edited` rather than `.pp-edited` because that
// is what it takes to reach it: L8 declares the marker's box, colour pair,
// `opacity` and `visibility` under a descendant selector, so a bare class rule
// in `deps.userCss` loses on specificity and the marker is genuinely unharmed.
// Attacking through the weaker selector would have produced eight green tests
// about nothing.
// ---------------------------------------------------------------------------

const ATTACKS = [
  ['display:none', '.pp-scene .pp-edited{display:none}', /display:none on the edit marker/],
  ['visibility:hidden', '.pp-scene .pp-edited{visibility:hidden}', /visibility:hidden on the edit marker/],
  ['opacity:0', '.pp-scene .pp-edited{opacity:0}', /opacity:0 — the edit marker is styled to invisibility/],
  ['a one-pixel clipping box', '.pp-scene .pp-edited{height:1px;overflow:hidden}', /a box too short to hold one line of the edit marker/],
  ['negative tracking', '.pp-scene .pp-edited{letter-spacing:-1em}', /the characters collapse onto one another/],
  ['a sub-floor font size', '.pp-scene .pp-edited{font-size:6px}', /below the 11px floor §18\.3 enforces/],
  ['scaling it to a fifth', '.pp-scene .pp-edited{transform:scale(0.2)}', /renders at 2\.4px — below the 11px floor §18\.3 enforces/],
  ['blur', '.pp-scene .pp-edited{filter:blur(20px)}', /past the 0\.04em ceiling/],
  ['-webkit-text-fill-color', '.pp-scene .pp-edited{-webkit-text-fill-color:transparent}', /the glyph paint comes from -webkit-text-fill-color/],
  ['a contrast pair below 4.5:1', '.pp-scene .pp-edited{color:#f2f2f2;background:#ffffff}', /below the 4\.5:1 floor §18\.3 enforces/],
  ['pushing it off screen', '.pp-scene .pp-edited{position:absolute;left:-9999px}', /puts it off screen/],
  ['clip-path', '.pp-scene .pp-edited{clip-path:inset(100%)}', /clip-path:inset\(100%\) on the edit marker/],
  ['an ancestor at zero alpha', '.pp-scene{filter:opacity(0)}', /paints it at zero alpha/],
  ['hiding it inside a media query', '@media (min-width:100px){.pp-scene .pp-edited{display:none}}', /display:none on the edit marker/],
];

for (const [name, userCss, match] of ATTACKS) {
  test(`attack: ${name} on the edit marker is refused (§18.3)`, async () => {
    const result = await attempt({ userCss });
    assertBlocked(result, match, `${name} on .pp-edited`);
    // An attack aimed at an ancestor reaches both markers, and both refusals
    // are correct; these assertions are about the edit marker's own sentence.
    const refusals = result.detail.findings.filter((f) => match.test(f.message) && /edit marker/.test(f.message));
    assert.ok(refusals.length > 0, `${name} produced no refusal naming the edit marker`);
    for (const f of refusals) {
      assert.match(f.message, /§18\.3 makes the marker non-removable/, 'the refusal must cite the law it is refusing under');
      assert.ok(!/§18\.1/.test(f.message), 'the edit marker is not refused under the provenance label\'s section');
    }
  });
}

test('the theme\'s own custom properties are an attack route, and they are covered', async () => {
  // The pair the marker reads, discovered from the stylesheet rather than
  // hardcoded, so moving the marker onto a different pair cannot leave this
  // attacking variables nothing uses.
  const { rules } = parseStylesheet(runtimeCss);
  /** @type {{color: string|null, background: string|null}} */
  const vars = { color: null, background: null };
  for (const rule of rules) {
    if (!rule.selector.some((part) => part.classes.includes(EDITED_MARK_CLASS))) continue;
    for (const decl of rule.declarations) {
      const m = /var\(\s*(--[\w-]+)/.exec(decl.value);
      if (!m) continue;
      if (decl.prop === 'color') vars.color = m[1];
      if (decl.prop === 'background' || decl.prop === 'background-color') vars.background = m[1];
    }
  }
  assert.ok(vars.color && vars.background, `could not find the marker's colour variables: ${JSON.stringify(vars)}`);
  const result = await attempt({ userCss: `:root{${vars.background}:#fdfdfd;${vars.color}:#fbfbfb}` });
  assertBlocked(result, /computed contrast/, `an attack through ${vars.background}/${vars.color}`);
});

// ---------------------------------------------------------------------------
// The other half: styling the marker hard, and still being allowed to ship.
//
// P8's precedent. `invert(1)` on a marker with its own background inverts both
// and leaves the contrast where it was: it looks different and it reads, so it
// emits. A law that refuses this is a law a designer cannot ship under, and
// nobody enforces a law they cannot ship under.
// ---------------------------------------------------------------------------

const LEGITIMATE = [
  ['inverted with its own background', '.pp-scene .pp-edited{filter:invert(1)}'],
  ['a dark brand recolour', '.pp-scene .pp-edited{background:#101418;color:#ffffff;border-left-color:#ffb020}'],
  ['12px type, the smallest a designer reaches for', '.pp-scene .pp-edited{font-size:12px}'],
  ['a genuinely narrow column', '.pp-scene .pp-edited{max-width:50%}'],
  ['a short box that lets its text spill', '.pp-scene .pp-edited{height:4px;overflow:visible}'],
  ['a scrolling ancestor', '.pp-scene{max-height:120px;overflow:auto}'],
  ['tight but real tracking', '.pp-scene .pp-edited{letter-spacing:-0.02em}'],
  ['a softness a reader would not notice', '.pp-scene .pp-edited{filter:blur(0.3px)}'],
  ['92% opacity', '.pp-scene .pp-edited{opacity:0.92}'],
  ['hidden only when printed', '@media print{.pp-scene .pp-edited{display:none}}'],
  ['hidden only on hover', '.pp-scene .pp-edited:hover{display:none}'],
  ['a rounded, bordered, uppercase treatment', '.pp-scene .pp-edited{border-radius:999px;text-transform:uppercase;font-weight:700;padding:6px 14px}'],
];

for (const [name, userCss] of LEGITIMATE) {
  test(`a marker that is ${name} still emits`, async () => {
    const result = await attempt({ userCss });
    assertClean(result, `.pp-edited ${name}`);
    assert.ok(htmlHasClass(result.value.html, EDITED_MARK_CLASS), 'and the marker is still in the file');
  });
}

// ---------------------------------------------------------------------------
// The generalisation itself: one detector, a set of subjects.
// ---------------------------------------------------------------------------

test('the protected set covers both §18 markers, and each carries its own noun and law', () => {
  assert.deepEqual(PROTECTED_MARKERS.map((m) => m.className), [PROVENANCE_LABEL_CLASS, EDITED_MARK_CLASS]);
  for (const marker of PROTECTED_MARKERS) {
    for (const field of ['className', 'noun', 'title', 'law', 'what', 'emptyText', 'nonRemovable']) {
      assert.equal(typeof marker[field], 'string', `${marker.className} has no ${field}`);
      assert.ok(marker[field].length > 0, `${marker.className}'s ${field} is empty`);
    }
    assert.match(marker.law, /^§18\./);
  }
  const laws = new Set(PROTECTED_MARKERS.map((m) => m.law));
  assert.equal(laws.size, PROTECTED_MARKERS.length, 'two markers refused under one section would misattribute one of them');
});

test('markerFor identifies each protected class and nothing else', () => {
  const desc = (cls) => describeElement({ t: 'p', a: { class: cls } });
  assert.equal(markerFor(desc(PROVENANCE_LABEL_CLASS)), LABEL_MARKER);
  assert.equal(markerFor(desc(EDITED_MARK_CLASS)), EDITED_MARKER);
  assert.equal(markerFor(desc(`pp-stack-meta ${EDITED_MARK_CLASS}`)), EDITED_MARKER);
  assert.equal(markerFor(desc('pp-edited-notice')), null);
  assert.equal(markerFor(desc('pp-provenance-ledger')), null);
  assert.equal(markerFor(desc('')), null);
});

test('the detector reads a cascade, not a class — the same chain judged as either marker differs only in wording', () => {
  const chain = documentChainPrefix().concat([
    describeElement({ t: 'div', a: { class: 'pp-scene' } }),
    describeElement({ t: 'p', a: { class: 'pp-marker', style: 'font-size:6px' } }),
  ]);
  const { rules } = parseStylesheet('');
  const asLabel = judgeLabelStyle(chain, rules, LABEL_MARKER);
  const asMark = judgeLabelStyle(chain, rules, EDITED_MARKER);
  assert.equal(asLabel.ok, false);
  assert.equal(asMark.ok, false);
  assert.deepEqual(asLabel.detail, asMark.detail, 'the measurements must be identical; only the sentence changes');
  assert.match(asLabel.reasons.join(' '), /§18\.1/);
  assert.match(asMark.reasons.join(' '), /§18\.3/);
});

test('judgeLabelStyle still speaks about "the label" when nobody names a subject', () => {
  const chain = documentChainPrefix().concat([
    describeElement({ t: 'span', a: { class: PROVENANCE_LABEL_CLASS, style: 'display:none' } }),
  ]);
  const verdict = judgeLabelStyle(chain, parseStylesheet('').rules);
  assert.match(verdict.reasons.join('; '), /display:none on the label/);
});

test('a third marker needs no third implementation — a made-up one is judged by the same code', () => {
  const invented = { className: 'pp-invented', noun: 'the invented marker', law: '§18.9' };
  const chain = documentChainPrefix().concat([
    describeElement({ t: 'p', a: { class: 'pp-invented', style: 'opacity:0' } }),
  ]);
  const verdict = judgeLabelStyle(chain, parseStylesheet('').rules, invented);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join('; '), /opacity:0 — the invented marker is styled to invisibility/);
});

// ---------------------------------------------------------------------------
// The emitter's own honesty: the check runs on the artifact, not on a promise.
// ---------------------------------------------------------------------------

test('the refusal comes from emit(), not from a caller who remembered to ask', async () => {
  // A layout registered under all eight names that renders the specimen's own
  // text and no marker: the shape of a layout that regressed.
  resetLayouts();
  const bare = (ctx) => h('div', { class: 'pp-layout' },
    h('h1', null, ctx.scene.headline || ''),
    h('div', { [SPECIMEN_ATTR]: ctx.specimen ? ctx.specimen.id : null },
      ((ctx.specimen && ctx.specimen.blocks) || []).map((b) => h('p', null, b.text || ''))));
  for (const name of SCENE_LAYOUTS) registerLayout(name, bare);

  const proof = editedProof();
  const result = await emit(proof, {}, { runtimeJs, runtimeCss, clock: FIXED_CLOCK });
  assert.equal(result.ok, false, 'a layout that renders the edited page without the marker must not emit');
  assert.match(result.error, /no override flag/i);
  assert.ok(
    result.detail.findings.some((f) => f.severity === 1 && /edited after capture/.test(f.message)),
    'and the refusal has to be about the edit, not about something else',
  );
});
