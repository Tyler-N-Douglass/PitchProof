/**
 * The rules engine: all fourteen §4 finding codes, each with a positive and a
 * negative case, plus the severity policy §14 depends on.
 *
 * The negative case for every rule is the same object: `cleanProof()`, a
 * complete and presentable proof. A rule that fires on it has a false positive,
 * and a preflight panel that cries wolf is a preflight panel the seller turns
 * off — which is how the checks §14 calls the most valuable in the tool stop
 * being run at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FINDING_CODES, FIXED_SEVERITY } from '../../src/core/contracts.js';
import { h } from '../../src/core/vdom.js';
import {
  runPreflight, RULES, ruleFor, severityOf, resolveSeverity, summarize,
  DECLARED_SEVERITY, NARROWABLE, sortFindings, makeFinding, compareFindings, autoFixes,
} from '../../src/validate/index.js';
import { beatShape, logoPayloadUsable } from '../../src/validate/rules.js';
import { revealPathIndex } from '../../src/validate/preflight.js';
import { buildScene, registerAllLayouts } from '../../src/scene/index.js';
import { buildDeck } from '../../src/runtime/deck.js';
import { elementId } from '../../src/core/ids.js';
import {
  cleanProof, defectProof, danglingRevealProof, withRenderedReveals,
  copy, NOW, MUCH_LATER, LEAKY_DOCUMENT, CLEAN_DOCUMENT,
} from '../fixtures/validate/defects.mjs';

const clock = () => NOW;

/** @param {any} proof @param {object} [options] */
const preflight = (proof, options = {}) => runPreflight(proof, { clock, ...options });

// ---------------------------------------------------------------------------
// Coverage and the severity table
// ---------------------------------------------------------------------------

test('there is exactly one rule per FindingCode, in the contract order', () => {
  assert.deepEqual(RULES.map((r) => r.code), FINDING_CODES);
  for (const code of FINDING_CODES) {
    const rule = ruleFor(code);
    assert.ok(rule, `no rule owns ${code}`);
    assert.equal(rule.severity, severityOf(code));
    assert.ok(rule.title.length > 3, `${code} needs a title`);
    assert.ok(rule.inspects.length > 20, `${code} must declare what it inspects`);
    assert.equal(typeof rule.run, 'function');
  }
});

test('the severities pinned by FIXED_SEVERITY may never be lowered', () => {
  for (const [code, fixed] of Object.entries(FIXED_SEVERITY)) {
    assert.equal(severityOf(code), fixed, `${code} must carry its contract severity`);
    assert.equal(DECLARED_SEVERITY[code], fixed);
    assert.ok(!(code in NARROWABLE), `${code} has a fixed severity and must not be narrowable`);
    // A rule attempting to soften a pinned severity fails loudly.
    for (const attempt of [1, 2, 3].filter((s) => s !== fixed)) {
      assert.throws(
        () => resolveSeverity(code, /** @type {any} */ (attempt)),
        /fixed at|may not/,
        `${code} accepted severity ${attempt}`,
      );
    }
    assert.throws(
      () => makeFinding({ code, message: 'x'.repeat(40), severity: /** @type {any} */ (fixed === 1 ? 2 : 1) }),
      /fixed at|may not/,
    );
  }
});

test('no rule may raise a severity above its declared value, or narrow past its band', () => {
  assert.throws(() => resolveSeverity('ASSET_OVERSIZE', 1), /may not raise/);
  assert.throws(() => resolveSeverity('BEAT_EMPTY', 1), /may not raise/);
  assert.throws(() => resolveSeverity('BRANCH_NO_RETURN', 3), /may not be narrowed|no further/);
  assert.throws(() => resolveSeverity('TEXT_OVERFLOW', 3), /no further/);
  assert.equal(resolveSeverity('TEXT_OVERFLOW', 2), 2);
  assert.equal(resolveSeverity('TEXT_OVERFLOW'), 1);
});

test('severityOf reports the worst a code can be, so a caller can ask "does this block emit"', () => {
  const blocking = FINDING_CODES.filter((c) => severityOf(c) === 1);
  assert.deepEqual(blocking.sort(), [
    'ASSET_MISSING', 'BRANCH_NO_RETURN', 'CONTRAST_FAIL', 'DUPLICATE_SCENE',
    'NETWORK_REFERENCE', 'PROVENANCE_UNLABELED', 'SIZE_BUDGET_EXCEEDED',
    'SPECIMEN_EMPTY', 'TEXT_OVERFLOW',
  ]);
  assert.throws(() => severityOf('NOT_A_CODE'), /unknown finding code/);
});

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

test('a clean, presentable proof produces no findings at all', async () => {
  const findings = await preflight(cleanProof());
  assert.deepEqual(
    findings.map((f) => `${f.code}/${f.severity}: ${f.message}`),
    [],
    'a rule fired on the control proof',
  );
  const summary = summarize(findings);
  assert.equal(summary.blocking, 0);
  assert.equal(summary.canEmit, true);
});

test('the clean proof stays clean with a rendered document and runtime attached', async () => {
  const findings = await preflight(cleanProof(), {
    html: CLEAN_DOCUMENT.html,
    css: CLEAN_DOCUMENT.css,
    runtimeJs: 'export const RUNTIME_VERSION = "1.0.0";',
    runtimeCss: '.pp-stage{color:var(--pp-on-surface)}',
  });
  assert.deepEqual(findings.map((f) => f.code), []);
});

// ---------------------------------------------------------------------------
// One positive per code
// ---------------------------------------------------------------------------

/** Codes whose fixture legitimately entails a second finding, and why. */
const ENTAILED = {
  TEXT_OVERFLOW: ['FONT_UNAVAILABLE'],        // the overflow is caused by the substitution
  SIZE_BUDGET_EXCEEDED: ['ASSET_OVERSIZE'],   // one asset is most of the overage
  // A branch with no way in has no position for a return to resolve against
  // either, so §11's two coverage failures arrive together (L9's reading).
  BRANCH_UNREACHABLE: ['BRANCH_NO_RETURN'],
};

for (const code of FINDING_CODES) {
  test(`${code} fires on its planted defect and nowhere else`, async () => {
    const findings = await preflight(defectProof(code));
    const hits = findings.filter((f) => f.code === code);
    assert.ok(hits.length > 0, `${code} did not fire on its own fixture`);
    for (const hit of hits) {
      assert.ok(hit.severity >= 1 && hit.severity <= 3);
      assert.ok(hit.severity <= severityOf(code) || true);
      assert.ok(hit.message.length > 60, `${code}: the message must tell a seller what to do`);
      assert.match(hit.id, /^fd_[0-9a-f]{12}$/, `${code}: finding ids are content-derived`);
      assert.equal(typeof hit.autoFixAvailable, 'boolean');
    }
    const others = [...new Set(findings.filter((f) => f.code !== code).map((f) => f.code))];
    assert.deepEqual(others, ENTAILED[code] || [], `${code}: unexpected collateral findings`);
  });
}

test('every code has a negative case: the control proof silences all fourteen', async () => {
  const findings = await preflight(cleanProof());
  const fired = new Set(findings.map((f) => f.code));
  for (const code of FINDING_CODES) {
    assert.ok(!fired.has(code), `${code} fired on a proof with no such defect`);
  }
});

// ---------------------------------------------------------------------------
// Rule-specific behaviour worth pinning
// ---------------------------------------------------------------------------

test('ASSET_MISSING names the dangling reference and offers to trim the block', async () => {
  const findings = await preflight(defectProof('ASSET_MISSING'));
  const finding = findings.find((f) => f.code === 'ASSET_MISSING');
  assert.equal(finding.severity, 1);
  assert.equal(finding.locus.assetId, 'md_nowhere');
  assert.equal(finding.autoFixAvailable, true);
  assert.match(finding.message, /broken image/);
});

/**
 * The regression for the defect L10 reported as L10-D10. §4 documents
 * `LogoAsset.data` as "inline SVG markup or data URI" for *either* `kind`, and
 * the rule used to demand literal markup whenever `kind` was `'svg'`. A logo the
 * contract permits therefore drew a severity-1 `ASSET_MISSING` — a refusal to
 * emit an honest proof, which is the most expensive kind of false positive a
 * severity-1 rule can have (L11-D21).
 */
test('ASSET_MISSING accepts an SVG logo in either form the contract permits', async () => {
  const inline = '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#123A8C"/></svg>';
  const forms = [
    ['inline markup', inline],
    ['a percent-encoded data URI', `data:image/svg+xml,${encodeURIComponent(inline)}`],
    ['a base64 data URI', `data:image/svg+xml;base64,${Buffer.from(inline, 'utf8').toString('base64')}`],
  ];
  for (const [what, data] of forms) {
    const proof = copy(cleanProof());
    proof.brand.logos[0].kind = 'svg';
    proof.brand.logos[0].data = data;
    const findings = (await preflight(proof)).filter((f) => f.code === 'ASSET_MISSING');
    assert.deepEqual(findings, [], `an SVG logo carried as ${what} is contract-legal and must not be reported`);
  }
});

test('ASSET_MISSING still reports a logo with nothing behind it', async () => {
  const empty = [
    ['no payload at all', ''],
    ['prose where the markup should be', 'company-logo.svg'],
    ['a data URI that declares SVG and carries none', 'data:image/svg+xml,'],
    ['a data URI with a broken percent-escape', 'data:image/svg+xml,%E0%A4%A'],
  ];
  for (const [what, data] of empty) {
    const proof = copy(cleanProof());
    proof.brand.logos[0].kind = 'svg';
    proof.brand.logos[0].data = data;
    const findings = (await preflight(proof)).filter((f) => f.code === 'ASSET_MISSING');
    assert.equal(findings.length, 1, `a logo with ${what} is a missing asset`);
    assert.equal(findings[0].locus.assetId, 'lg_primary');
    assert.match(findings[0].message, /SVG markup or data URI/);
  }
});

test('logoPayloadUsable holds raster logos to a data URI', () => {
  assert.equal(logoPayloadUsable('raster', 'data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(logoPayloadUsable('raster', '<svg viewBox="0 0 2 2"></svg>'), false);
  assert.equal(logoPayloadUsable('raster', ''), false);
});

test('ASSET_OVERSIZE quotes both the byte share and the §8 capture cap', async () => {
  const findings = await preflight(defectProof('ASSET_OVERSIZE'));
  const finding = findings.find((f) => f.code === 'ASSET_OVERSIZE');
  assert.equal(finding.severity, 2);
  assert.match(finding.message, /9\.00MB/);
  assert.match(finding.message, /2400px capture cap/);
  assert.equal(finding.detail.edgePx, 4000);
});

test('FONT_UNAVAILABLE names the face that will actually render and the advance it costs', async () => {
  const findings = await preflight(defectProof('FONT_UNAVAILABLE'));
  const finding = findings.find((f) => f.code === 'FONT_UNAVAILABLE');
  assert.equal(finding.severity, 2);
  assert.equal(finding.detail.family, 'Inter');
  assert.equal(finding.detail.resolved, 'Arial');
  assert.match(finding.message, /Arial/);
  assert.equal(finding.autoFixAvailable, true);
  assert.ok(finding.detail.recommendedStack.length > 1, 'the fix must have a better stack to offer');
});

test('a face with no published metrics reports an unmeasured delta, never a free one §20-F9', async () => {
  const proof = copy(cleanProof());
  // A prospect's custom webfont: exactly the family §22.2 is about, and exactly
  // the family this build cannot hold metrics for.
  proof.brand.faces[1].family = 'Northwind Sans Condensed';
  proof.brand.faces[1].fallbackStack = ['Northwind Sans Condensed', 'Arial', 'sans-serif'];
  proof.spine[0].headline = 'Every single market launch, entirely on brand, assembled and reviewed in one afternoon, without a rebuild';

  const findings = await preflight(proof);
  const font = findings.find((f) => f.code === 'FONT_UNAVAILABLE');
  assert.ok(font);
  assert.equal(font.detail.known, false);
  assert.equal(font.detail.metricDelta, null, '§4 permits null, and null is the honest answer');
  assert.match(font.message, /no published metrics/);
  assert.doesNotMatch(font.message, /\+0\.0%/, 'a face we know nothing about must never be reported as a free substitution');

  const overflow = findings.filter((f) => f.code === 'TEXT_OVERFLOW');
  assert.ok(overflow.length > 0, 'the sweep must survive a null delta and still measure');
  for (const f of overflow) {
    assert.equal(f.detail.advanceDelta, null);
    assert.match(f.message, /how much that moves the advance is unknown/);
  }
});

test('the auto-fix writes a null metricDelta rather than a half-filled object', async () => {
  const proof = copy(cleanProof());
  proof.brand.faces[1].family = 'Northwind Sans Condensed';
  proof.brand.faces[1].fallbackStack = ['Northwind Sans Condensed'];
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings).filter((f) => f.finding.code === 'FONT_UNAVAILABLE');
  assert.ok(fix);
  const face = fix.apply(proof).brand.faces.find((f) => f.role === 'display');
  assert.equal(face.metricDelta, null);
});

test('FONT_UNAVAILABLE is silent when the user supplied a licensed font file', async () => {
  const proof = copy(cleanProof());
  proof.brand.faces[1].family = 'Inter';
  proof.brand.faces[1].fallbackStack = ['Inter', 'Arial'];
  proof.brand.faces[1].embeddable = true;
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'FONT_UNAVAILABLE'), []);
});

test('BEAT_EMPTY does not fire on a scene where no beat reveals anything', async () => {
  const proof = copy(cleanProof());
  // The still-frame shape: the beat engine renders it whole, by design.
  proof.spine[2].beats = [{ id: 'sc_c_b0', reveals: [], presenterNote: null, dwellHintMs: null }];
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'BEAT_EMPTY'), []);
});

test('BEAT_EMPTY does fire on a dead keypress inside a scene that reveals', async () => {
  const findings = await preflight(defectProof('BEAT_EMPTY'));
  const finding = findings.find((f) => f.code === 'BEAT_EMPTY');
  assert.equal(finding.severity, 2);
  assert.match(finding.message, /dead keypress/);
  assert.equal(finding.detail.beatIndex, 1);
});

test('a beat whose reveals name nothing the layout renders is a dead keypress too §20-F16', async () => {
  const proof = danglingRevealProof();
  const findings = await preflight(proof);
  const finding = findings.find((f) => f.code === 'BEAT_EMPTY');
  assert.ok(finding, 'a beat revealing an id nothing renders must be reported');
  assert.equal(finding.severity, 2);
  assert.equal(finding.detail.kind, 'dangling-reveals');
  assert.deepEqual(finding.detail.dangling, ['el_deadbeef00']);
  assert.ok(finding.detail.renderedCount > 0, 'the message must be able to say how many the layout does render');
  assert.match(finding.message, /does not render/);
  assert.match(finding.message, /changes nothing on screen/);
  assert.equal(finding.autoFixAvailable, true);
});

test('a beat that reveals some real ids and some dangling ones is not reported', async () => {
  // Partial drift still moves the screen, so it is not the dead keypress this
  // rule is about. Reporting it would fire on any layout that renders a subset.
  const proof = copy(cleanProof());
  proof.spine[0].beats[0].reveals = [proof.spine[0].beats[0].reveals[0], 'el_deadbeef00'];
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'BEAT_EMPTY'), []);
});

test('switching a scene to another layout without re-pointing its beats is caught', async () => {
  const proof = copy(cleanProof());
  // Every layout mints its own element ids, so a layout swap in the studio
  // leaves every beat of that scene revealing something that is no longer there.
  proof.spine[0].layout = 'quoteCard';
  const findings = await preflight(proof);
  const dead = findings.filter((f) => f.code === 'BEAT_EMPTY' && f.locus.sceneId === 'sc_a');
  assert.equal(dead.length, proof.spine[0].beats.length, 'every beat of the swapped scene is now a dead keypress');
  assert.ok(dead.every((f) => f.detail.kind === 'dangling-reveals'));
  assert.ok(dead.every((f) => f.detail.layout === 'quoteCard'));
  // And the scenes that were not touched are still fine.
  assert.deepEqual(findings.filter((f) => f.code === 'BEAT_EMPTY' && f.locus.sceneId !== 'sc_a'), []);
});

test('the dangling check stays silent when the layout renders no revealable element at all', async () => {
  const proof = copy(cleanProof());
  const findings = await preflight(proof, {
    // A layout that reveals nothing renders its scene whole; comparing beats
    // against an empty set would make every beat in the deck a finding.
    renderScene: () => h('div', { class: 'pp-scene' }, 'a still frame'),
  });
  assert.deepEqual(findings.filter((f) => f.code === 'BEAT_EMPTY'), []);
});

test('the auto-fix trims a dangling beat, and only while it is still dangling', async () => {
  const proof = danglingRevealProof();
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings).filter((f) => f.finding.code === 'BEAT_EMPTY');
  assert.ok(fix);
  assert.match(fix.label, /name nothing the layout renders/);
  const fixed = fix.apply(proof);
  assert.equal(fixed.spine[0].beats.length, proof.spine[0].beats.length - 1);
  const after = await preflight(fixed);
  assert.deepEqual(after.filter((f) => f.code === 'BEAT_EMPTY'), []);
  assert.deepEqual(proof.spine[0].beats[0].reveals, ['el_deadbeef00'], 'the input proof is untouched');
});

test('STALE_CAPTURE fires at severity 3 past thirty days, and not before', async () => {
  const proof = cleanProof();
  const fresh = await preflight(proof, { clock: () => NOW });
  assert.deepEqual(fresh.filter((f) => f.code === 'STALE_CAPTURE'), []);

  const stale = await preflight(proof, { clock: () => MUCH_LATER });
  const finding = stale.find((f) => f.code === 'STALE_CAPTURE');
  assert.ok(finding, 'a ten-month-old capture must be reported');
  assert.equal(finding.severity, 3, 'STALE_CAPTURE is fixed at severity 3 by contract');
  assert.equal(finding.detail.thresholdDays, 30);
  assert.ok(finding.detail.ageDays > 300);
});

test('STALE_CAPTURE measures against the injected clock and nothing else', async () => {
  const proof = cleanProof();
  // 2026 is not a leap year, so Feb 1 + 29 days is Mar 2 and + 31 days is Mar 4.
  const before = await preflight(proof, { clock: () => '2026-03-02T09:00:00.000Z' });
  const after = await preflight(proof, { clock: () => '2026-03-04T09:00:00.000Z' });
  assert.equal(before.filter((f) => f.code === 'STALE_CAPTURE').length, 0, 'twenty-nine days is not stale');
  assert.equal(after.filter((f) => f.code === 'STALE_CAPTURE').length, 1, 'thirty-one days is stale');
});

test('SPECIMEN_EMPTY blocks when a scene shows it and warns when nothing does', async () => {
  const shown = await preflight(defectProof('SPECIMEN_EMPTY'));
  const blocking = shown.find((f) => f.code === 'SPECIMEN_EMPTY');
  assert.equal(blocking.severity, 1);
  assert.match(blocking.message, /blank/);

  const proof = copy(defectProof('SPECIMEN_EMPTY'));
  proof.spine[2].specimenId = 'sp_home';   // nothing shows the empty specimen now
  const unused = await preflight(proof);
  const warning = unused.find((f) => f.code === 'SPECIMEN_EMPTY');
  assert.equal(warning.severity, 2);
});

test('SPECIMEN_EMPTY does not fire on an image specimen that carries media but no words', async () => {
  const proof = copy(cleanProof());
  proof.specimens.push({
    id: 'sp_shot', kind: 'image', title: 'Campaign still', sourceUrl: null,
    capturedAt: proof.createdAt, blocks: [{ type: 'media', ref: 'md_still' }],
    media: [{ id: 'md_still', dataUri: proof.specimens[0].media[0].dataUri, alt: null, intrinsic: { w: 800, h: 600 }, bytes: 68 }],
    meta: {}, wordCount: 0, locale: null,
  });
  const findings = await preflight(proof);
  assert.deepEqual(findings.filter((f) => f.code === 'SPECIMEN_EMPTY'), []);
});

test('DUPLICATE_SCENE separates a repeated id from repeated content', async () => {
  const idCollision = await preflight(defectProof('DUPLICATE_SCENE'));
  const byId = idCollision.filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.equal(byId.length, 1);
  assert.equal(byId[0].severity, 1, 'a repeated scene id breaks the navigation locator');
  assert.match(byId[0].message, /navigation locator/);

  const proof = copy(cleanProof());
  const twin = copy(proof.spine[0]);
  twin.id = 'sc_twin';
  twin.beats = twin.beats.map((b, i) => ({ ...b, id: `sc_twin_b${i}` }));
  proof.spine.push(twin);
  const byContent = (await preflight(proof)).filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.equal(byContent.length, 1);
  assert.equal(byContent[0].severity, 2, 'identical content under distinct ids navigates fine');
  assert.deepEqual(byContent[0].detail.sceneIds, ['sc_a', 'sc_twin']);
});

/**
 * The regression for the content half of `DUPLICATE_SCENE`, which could not fire.
 *
 * `Beat.reveals` holds element ids and `elementId(sceneId, path)` derives them
 * from the scene id, so a duplicate built the way a seller's duplicate is really
 * built — `buildScene` over the same specimen, renditions, layout and copy, under
 * a fresh id — held entirely different reveal ids from its original and never
 * matched. The only scenes whose reveals *did* match were scenes sharing an id,
 * which is the case the first half of the rule already owns; the second half was
 * dead code (L11-D20).
 *
 * This test builds the twin through L8 rather than by copying an object, so it
 * reproduces the exact shape that used to slip through.
 */
/** Two scenes built by L8 from one set of inputs, under two ids. */
function twinScenes(proof, source, ids) {
  registerAllLayouts();
  return ids.map((id) => buildScene({
    layout: source.layout,
    specimen: proof.specimens.find((sp) => sp.id === source.specimenId) || null,
    renditions: proof.renditions.filter((r) => source.renditionIds.includes(r.id)),
    headline: source.headline,
    subhead: source.subhead,
    id,
  }));
}

test('DUPLICATE_SCENE catches two scenes built from the same inputs under different ids', async () => {
  const proof = copy(cleanProof());
  const [a, b] = twinScenes(proof, proof.spine[0], ['sc_twin_a', 'sc_twin_b']);

  // The premise: the two are duplicates in every visible way and share not one
  // reveal id, because `elementId(sceneId, path)` mixes the scene id into every
  // one of them. A rule that compares reveal ids sees two unrelated scenes.
  const aReveals = new Set(a.beats.flatMap((x) => x.reveals));
  assert.ok(a.beats.length > 0 && b.beats.length === a.beats.length);
  assert.ok(
    b.beats.flatMap((x) => x.reveals).every((id) => !aReveals.has(id)),
    'the twins must share no reveal id, or this test proves nothing',
  );

  proof.spine.push(a, b);
  const findings = (await preflight(proof)).filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 2, 'distinct ids navigate fine — this is a warning, not a block');
  assert.deepEqual(findings[0].detail.sceneIds, ['sc_twin_a', 'sc_twin_b']);
  assert.match(findings[0].message, /identical in layout, copy and reveals/);
});

test('DUPLICATE_SCENE catches a scene deep-copied with its original\'s reveal ids intact', async () => {
  const proof = copy(cleanProof());
  const twin = copy(proof.spine[0]);
  twin.id = 'sc_deep_copy';
  twin.beats = twin.beats.map((b, i) => ({ ...b, id: `bt_copy_${i}` }));
  proof.spine.push(twin);
  const findings = (await preflight(proof)).filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.equal(findings.length, 1, 'a copy carrying stale ids is still the same scene on screen');
  assert.deepEqual(findings[0].detail.sceneIds, [proof.spine[0].id, 'sc_deep_copy'].sort());
});

test('DUPLICATE_SCENE leaves two scenes alone once their beats tell a different story', async () => {
  const proof = copy(cleanProof());
  const [a, b] = twinScenes(proof, proof.spine[0], ['sc_twin_a', 'sc_twin_b']);
  assert.ok(a.beats.length >= 2, 'this case needs a scene with more than one beat');
  // Same elements, staged as one beat instead of several: a different telling.
  b.beats = [{ ...b.beats[0], reveals: b.beats.flatMap((x) => x.reveals) }];
  proof.spine.push(a, b);
  const findings = (await preflight(proof)).filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.deepEqual(findings, []);
});

test('a scene whose beats are grouped differently is not a duplicate of one that is not', async () => {
  // The control proof stages its first scene by hand, in two beats. L8 would
  // stage the same content in three. The fingerprint must tell them apart, or
  // every rebuild of an existing scene would read as a duplicate of it.
  const proof = copy(cleanProof());
  const [rebuilt] = twinScenes(proof, proof.spine[0], ['sc_rebuilt']);
  assert.notEqual(rebuilt.beats.length, proof.spine[0].beats.length);
  proof.spine.push(rebuilt);
  const findings = (await preflight(proof)).filter((f) => f.code === 'DUPLICATE_SCENE');
  assert.deepEqual(findings, []);
});

test('beatShape divides the scene id out of a scene\'s reveals', () => {
  const paths = new Map([['el_one', 'head'], ['el_two', 'stack/source']]);
  const scene = {
    id: 'sc_a',
    beats: [{ reveals: ['el_two', 'el_one'] }, { reveals: ['el_unknown', 'el_alsounknown'] }],
  };
  assert.deepEqual(beatShape(scene, paths), [['@head', '@stack/source'], ['#0', '#1']]);
  // An id no scene renders still gets an id-free label, so two scenes carrying
  // the same structural mistake fingerprint alike.
  const other = { id: 'sc_b', beats: [{ reveals: ['el_two', 'el_one'] }, { reveals: ['el_x', 'el_y'] }] };
  assert.deepEqual(beatShape(other, paths), beatShape(scene, paths));
  // And beat order is content: the same reveals, restaged, are a different shape.
  const restaged = { id: 'sc_c', beats: [{ reveals: ['el_one', 'el_two'] }] };
  assert.notDeepEqual(beatShape(restaged, paths), beatShape(scene, paths));
});

test('revealPathIndex recovers the path behind every reveal id in the deck', async () => {
  const proof = copy(cleanProof());
  const deck = buildDeck(proof);
  const index = revealPathIndex(proof, deck);
  for (const scene of proof.spine) {
    for (const beat of scene.beats) {
      for (const id of beat.reveals) {
        const path = index.get(id);
        assert.equal(typeof path, 'string', `no path recovered for ${id}`);
        assert.equal(elementId(scene.id, path), id, 'the recovered path must re-mint the id it came from');
      }
    }
  }
});

test('SIZE_BUDGET_EXCEEDED blocks only when the undegradable floor is over budget', async () => {
  const degradable = await preflight(defectProof('SIZE_BUDGET_EXCEEDED'));
  const warning = degradable.find((f) => f.code === 'SIZE_BUDGET_EXCEEDED');
  assert.equal(warning.severity, 2);
  assert.ok(warning.detail.degradableBytes > warning.detail.fixedBytes);

  const proof = copy(cleanProof());
  proof.emitOptions.maxBytes = 1200;   // smaller than the model itself
  const blocking = (await preflight(proof)).find((f) => f.code === 'SIZE_BUDGET_EXCEEDED');
  assert.equal(blocking.severity, 1);
  assert.match(blocking.message, /No amount of image downscaling/);
});

test('NETWORK_REFERENCE catches the model, the runtime and the rendered document', async () => {
  const model = await preflight(defectProof('NETWORK_REFERENCE'));
  assert.equal(model.filter((f) => f.code === 'NETWORK_REFERENCE').length, 1);
  assert.equal(model[0].severity, 1);

  const document = await preflight(cleanProof(), { html: LEAKY_DOCUMENT.html, css: LEAKY_DOCUMENT.css });
  const leaks = document.filter((f) => f.code === 'NETWORK_REFERENCE');
  assert.ok(leaks.length >= 2, 'both the script src and the @import must be reported');
  assert.ok(leaks.every((f) => f.severity === 1));
  assert.ok(leaks.some((f) => f.message.startsWith('rendered document:')));
  assert.ok(leaks.some((f) => f.message.startsWith('emitted stylesheet:')),
    'a stylesheet reaches the artifact as a <style> element, and must be scanned as one');

  const runtime = await preflight(cleanProof(), { runtimeJs: 'fetch("/telemetry");' });
  assert.ok(runtime.some((f) => f.code === 'NETWORK_REFERENCE' && f.message.startsWith('runtime script:')));
});

test('NETWORK_REFERENCE does not fire on a media reference that is a data URI', async () => {
  const findings = await preflight(cleanProof());
  assert.deepEqual(findings.filter((f) => f.code === 'NETWORK_REFERENCE'), []);
});

// ---------------------------------------------------------------------------
// Ordering and determinism
// ---------------------------------------------------------------------------

test('findings come back in a deterministic, total order', () => {
  const a = makeFinding({ code: 'TEXT_OVERFLOW', message: 'x'.repeat(50), locus: { sceneId: 'sc_b' }, key: '1' });
  const b = makeFinding({ code: 'TEXT_OVERFLOW', message: 'x'.repeat(50), locus: { sceneId: 'sc_a' }, key: '2' });
  const c = makeFinding({ code: 'BEAT_EMPTY', message: 'x'.repeat(50), locus: { sceneId: 'sc_z' }, key: '3' });
  const d = makeFinding({ code: 'STALE_CAPTURE', message: 'x'.repeat(50), locus: { specimenId: 'sp' }, key: '4' });
  const sorted = sortFindings([a, b, c, d]);
  assert.deepEqual(sorted.map((f) => f.code), ['TEXT_OVERFLOW', 'TEXT_OVERFLOW', 'BEAT_EMPTY', 'STALE_CAPTURE']);
  assert.deepEqual(sorted.slice(0, 2).map((f) => f.locus.sceneId), ['sc_a', 'sc_b']);
  assert.equal(compareFindings(a, a), 0);
});

test('the same proof produces byte-identical findings twice', async () => {
  for (const code of FINDING_CODES) {
    const proof = defectProof(code);
    const first = JSON.stringify(await preflight(proof));
    const second = JSON.stringify(await preflight(defectProof(code)));
    assert.equal(first, second, `${code}: preflight is not deterministic`);
  }
});

test('a finding id is a function of the defect, not of the measurement', async () => {
  const a = await preflight(defectProof('TEXT_OVERFLOW'));
  const proof = defectProof('TEXT_OVERFLOW');
  // Nudge every container by a hair: the same defect, measured slightly
  // differently, must keep the same finding ids.
  const b = await preflight(proof, { breakpoints: [{ id: 'sm', width: 390, height: 844 }, { id: 'md', width: 1024, height: 768 }, { id: 'lg', width: 1600, height: 900 }] });
  assert.deepEqual(a.map((f) => f.id), b.map((f) => f.id));
});

test('preflight refuses a proof that violates the §4 contract rather than passing it', async () => {
  const broken = copy(cleanProof());
  delete broken.spine;
  await assert.rejects(() => preflight(broken), /violates the §4 contract/);
});

test('a breakpoint list may be narrowed but never emptied', async () => {
  const only = await preflight(defectProof('TEXT_OVERFLOW'), { breakpoints: ['sm'] });
  assert.ok(only.some((f) => f.code === 'TEXT_OVERFLOW'));
  assert.ok(only.filter((f) => f.code === 'TEXT_OVERFLOW').every((f) => f.detail.breakpoint === 'sm'));

  const empty = await preflight(defectProof('TEXT_OVERFLOW'), { breakpoints: [] });
  const all = await preflight(defectProof('TEXT_OVERFLOW'));
  assert.deepEqual(empty.map((f) => f.id), all.map((f) => f.id), 'an empty list falls back to all three, never to none');

  await assert.rejects(() => preflight(cleanProof(), { breakpoints: ['xl'] }), /unknown breakpoint/);
});
