/**
 * The §14 automated sweep and dry-run mode.
 *
 * The sweep has to walk *everything* — "every scene, every beat, and every
 * branch" — and it has to walk it the same way twice. Both are asserted here
 * against the deck the runtime itself builds, rather than against a count this
 * file keeps, so a scene the sweep forgets is a failure rather than a smaller
 * number nobody notices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeck } from '../../src/runtime/deck.js';
import { allPositions } from '../../src/runtime/nav.js';
import { BREAKPOINTS } from '../../src/core/contracts.js';
import {
  runPreflight, dryRun, summarize, measureDeck, resolveDeps, resolveBreakpoints, readClock,
} from '../../src/validate/index.js';
import { cleanProof, defectProof, copy, NOW } from '../fixtures/validate/defects.mjs';

const clock = () => NOW;
const preflight = (proof, options = {}) => runPreflight(proof, { clock, ...options });

// ---------------------------------------------------------------------------
// Coverage of the sweep
// ---------------------------------------------------------------------------

test('the sweep measures every scene in the deck at all three breakpoints', () => {
  const proof = cleanProof();
  const deck = buildDeck(proof);
  const measurements = measureDeck(proof, deck, BREAKPOINTS, resolveDeps({}));
  const sceneIds = [...new Set(measurements.map((m) => m.sceneId))];
  const deckScenes = [...deck.sceneById.keys()];
  assert.deepEqual(sceneIds.slice().sort(), deckScenes.slice().sort(), 'a scene the sweep never measured cannot be checked');
  assert.equal(measurements.length, deckScenes.length * BREAKPOINTS.length);
  for (const bp of BREAKPOINTS) {
    assert.equal(measurements.filter((m) => m.breakpoint === bp.id).length, deckScenes.length);
  }
});

test('every measured scene produces at least one text box to check', () => {
  const proof = cleanProof();
  const measurements = measureDeck(proof, buildDeck(proof), BREAKPOINTS, resolveDeps({}));
  for (const m of measurements) {
    assert.ok(m.boxes.length > 0, `${m.sceneId} at ${m.breakpoint} produced no measurable text`);
    for (const box of m.boxes) {
      assert.ok(box.containerWidthPx > 0, 'a text box needs a container to overflow');
      assert.ok(typeof box.style.fontSizePx === 'number');
    }
  }
});

test('branch scenes are swept, not just the spine', () => {
  const proof = cleanProof();
  const measurements = measureDeck(proof, buildDeck(proof), BREAKPOINTS, resolveDeps({}));
  assert.ok(measurements.some((m) => m.sceneId === 'sc_ap0'), 'the branch scene was never measured');
});

test('a defect inside a branch is found by the sweep', async () => {
  const proof = copy(cleanProof());
  proof.branches[0].scenes[0].headline =
    'An objection answer so long that no container at any breakpoint could hold it on a single line without clipping the last several words entirely';
  proof.brand.faces[1].family = 'Montserrat';
  proof.brand.faces[1].fallbackStack = ['Montserrat', 'Verdana', 'sans-serif'];
  const findings = await preflight(proof);
  const inBranch = findings.filter((f) => f.code === 'TEXT_OVERFLOW' && f.locus.sceneId === 'sc_ap0');
  assert.ok(inBranch.length > 0, 'an overflow inside a branch is still an overflow in front of the client');
});

test("L8's measurement declares a truncation mode, which the grading turns on", () => {
  const proof = cleanProof();
  const measurements = measureDeck(proof, buildDeck(proof), BREAKPOINTS, resolveDeps({}));
  const boxes = measurements.flatMap((m) => m.boxes);
  assert.ok(boxes.length > 0);
  for (const box of boxes) {
    assert.ok(
      box.textOverflow === 'clip' || box.textOverflow === 'ellipsis',
      `every measured box must declare how it truncates; ${box.role} declares ${JSON.stringify(box.textOverflow)}`,
    );
  }
  // The one-line clamp the layouts put under every panel title ellipsises, which
  // is what makes a long URL a warning rather than a blocked emit.
  const clamped = boxes.filter((b) => b.maxLines === 1);
  assert.ok(clamped.length > 0, 'the layouts must still be emitting one-line clamps');
  assert.ok(clamped.every((b) => b.textOverflow === 'ellipsis'));
});

test("the prospect's own URL and title do not block the emit §20-F6", async () => {
  // The critic's reproduction: a real source URL and a real page title, both
  // rendered by `splitBeforeAfter` into one-line clamped rows, both far past
  // their containers at sm. §18.3 presents the prospect's content unmodified, so
  // there is nothing the seller can shorten — and the rows ellipsise by design.
  const proof = copy(cleanProof());
  proof.specimens[0].sourceUrl = 'https://www.northwind-industrial.example/insights/fouling-resistant-heat-exchangers';
  proof.specimens[0].title = 'Fouling-resistant heat exchangers for continuous process lines | Northwind Industrial';

  const findings = await preflight(proof);
  const overflow = findings.filter((f) => f.code === 'TEXT_OVERFLOW');
  assert.ok(overflow.length > 0, 'the overflow is real and must still be reported');
  assert.deepEqual(
    overflow.filter((f) => f.severity === 1).map((f) => f.message),
    [],
    'but nothing about it may refuse the emit',
  );
  assert.ok(overflow.every((f) => f.detail.textOverflow === 'ellipsis'));
  assert.equal(summarize(findings).canEmit, true, 'the layout the before/after thesis rests on must stay emittable');
});

test('a clipping box carrying the same overflow does block', async () => {
  const proof = copy(cleanProof());
  proof.specimens[0].sourceUrl = 'https://www.northwind-industrial.example/insights/fouling-resistant-heat-exchangers';
  const findings = await preflight(proof, {
    // The same measurement with the truncation mode taken away: identical text,
    // identical geometry, and the text now disappears with no signal.
    measureScene: (scene, ctx, bp) => {
      const m = resolveDeps({}).measureScene(scene, ctx, bp);
      return { ...m, boxes: m.boxes.map((b) => ({ ...b, textOverflow: 'clip' })) };
    },
  });
  const blocking = findings.filter((f) => f.code === 'TEXT_OVERFLOW' && f.severity === 1);
  assert.ok(blocking.length > 0, 'text cut with no signal is the §22.2 defect and must block');
  assert.ok(blocking.every((f) => f.detail.textOverflow === 'clip'));
});

// ---------------------------------------------------------------------------
// Injected time and injected dependencies
// ---------------------------------------------------------------------------

test('the clock is injected, never read from the machine', () => {
  assert.equal(readClock(() => '2026-05-05T00:00:00.000Z'), '2026-05-05T00:00:00.000Z');
  assert.equal(readClock('2026-05-05T00:00:00.000Z'), '2026-05-05T00:00:00.000Z');
  assert.equal(readClock(undefined), null);
  assert.equal(readClock(() => 42), null);
});

test('with no clock, the time-dependent rule simply does not run — it does not guess', async () => {
  const proof = defectProof('STALE_CAPTURE');
  const withClock = await runPreflight(proof, { clock: () => '2026-12-01T00:00:00.000Z' });
  const without = await runPreflight(proof, {});
  assert.ok(withClock.some((f) => f.code === 'STALE_CAPTURE'));
  assert.ok(!without.some((f) => f.code === 'STALE_CAPTURE'));
  // Every other rule still runs: no clock is not a way to silence the sweep.
  assert.deepEqual(withClock.filter((f) => f.code !== 'STALE_CAPTURE').map((f) => f.id),
    without.map((f) => f.id));
});

test('cross-lane dependencies are injectable, and the defaults are the declared modules', async () => {
  const deps = resolveDeps({});
  for (const name of ['contrastRatio', 'measureScene', 'branchCoverage', 'scanForNetworkReferences', 'assertProvenance', 'hasPromotionRecord']) {
    assert.equal(typeof deps[name], 'function', `${name} must be resolvable`);
  }
  let called = 0;
  const findings = await preflight(cleanProof(), {
    measureScene: (scene, ctx, bp) => { called++; return { sceneId: scene.id, breakpoint: bp, boxes: [] }; },
  });
  assert.equal(called, 4 * BREAKPOINTS.length, 'the injected measurer must be used for every scene at every breakpoint');
  assert.deepEqual(findings.filter((f) => f.code === 'TEXT_OVERFLOW'), []);
});

test('resolveBreakpoints accepts ids or geometry and refuses nonsense', () => {
  assert.deepEqual(resolveBreakpoints(undefined), BREAKPOINTS);
  assert.deepEqual(resolveBreakpoints([]), BREAKPOINTS);
  assert.deepEqual(resolveBreakpoints(['lg']), [BREAKPOINTS[2]]);
  assert.deepEqual(resolveBreakpoints([{ id: 'xs', width: 320, height: 568 }]), [{ id: 'xs', width: 320, height: 568 }]);
  assert.throws(() => resolveBreakpoints([{ id: 'bad' }]), /needs \{id, width, height\}/);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same proof produces byte-identical findings, twice, from separate builds', async () => {
  const first = await preflight(cleanProof({ spine: defectProof('TEXT_OVERFLOW').spine }));
  const second = await preflight(cleanProof({ spine: defectProof('TEXT_OVERFLOW').spine }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('the finding order is severity first, then the contract code order, then locus', async () => {
  const proof = copy(defectProof('TEXT_OVERFLOW'));
  proof.specimens[0].capturedAt = '2025-01-01T00:00:00.000Z';       // STALE_CAPTURE, severity 3
  proof.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';  // CONTRAST_FAIL, severity 1
  const findings = await preflight(proof);
  const severities = findings.map((f) => f.severity);
  assert.deepEqual(severities.slice().sort(), severities, 'blocking findings come first');
  const firstOfEach = [];
  for (const f of findings) if (!firstOfEach.includes(f.code)) firstOfEach.push(f.code);
  assert.ok(firstOfEach.includes('TEXT_OVERFLOW') && firstOfEach.includes('CONTRAST_FAIL') && firstOfEach.includes('STALE_CAPTURE'));
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

test('dryRun walks every position in the deck, in presentation order', async () => {
  const proof = cleanProof();
  const expected = allPositions(buildDeck(proof));
  /** @type {any[]} */
  const seen = [];
  const result = await dryRun(proof, { clock, onPosition: (step) => { seen.push(step); } });

  assert.equal(result.positions, expected.length);
  assert.equal(seen.length, expected.length);
  assert.deepEqual(seen.map((s) => `${s.position.sequenceId}:${s.position.sceneIndex}:${s.position.beatIndex}`),
    expected.map((p) => `${p.sequenceId}:${p.sceneIndex}:${p.beatIndex}`));
  assert.equal(result.scenesWalked, 4);
  assert.equal(result.branchesWalked, 1, 'a branch the presenter may never open is still rehearsed');
});

test('dryRun hands the presenter the beat frame and the note, as a rehearsal would', async () => {
  /** @type {any[]} */
  const notes = [];
  await dryRun(cleanProof(), {
    clock,
    onPosition: (step) => {
      assert.equal(step.frame.sceneId, step.scene.id);
      assert.equal(step.frame.beatIndex, step.position.beatIndex);
      assert.equal(step.total, 7);
      if (step.presenterNote) notes.push(step.presenterNote);
    },
  });
  assert.ok(notes.length >= 4, 'every scene opens with a presenter note in this fixture');
});

test('the issue counter is live: it reports what has been walked past, not the total', async () => {
  const proof = copy(defectProof('TEXT_OVERFLOW'));
  // A second defect, deeper in the deck, so the counter has somewhere to climb.
  proof.spine[2].headline = proof.spine[0].headline;
  /** @type {number[]} */
  const counts = [];
  const result = await dryRun(proof, { clock, onPosition: (step) => { counts.push(step.issuesSeen); } });

  assert.ok(counts.length > 0);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] >= counts[i - 1], 'the counter never goes down mid-walk');
  }
  assert.equal(counts[0] > 0, true, 'the first scene already carries a finding in this fixture');
  assert.ok(counts[counts.length - 1] > counts[0], 'later scenes add to it');
  const placed = result.findings.filter((f) => f.locus.sceneId).length;
  assert.equal(counts[counts.length - 1], placed, 'by the end, every placed finding has been walked past');
});

test('dryRun reports the summary and the deck-wide findings it has no position for', async () => {
  const proof = copy(cleanProof());
  proof.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';   // a palette failure belongs to the deck
  const result = await dryRun(proof, { clock });
  assert.ok(result.summary.blocking > 0);
  assert.equal(result.summary.canEmit, false);
  assert.ok(result.deckWideFindings > 0, 'a contrast failure has no scene to show it at, and must still be reported');
  assert.equal(result.findings.length, result.summary.total);
});

test('dryRun reuses a preflight result rather than running the sweep twice', async () => {
  const proof = cleanProof();
  const findings = await preflight(proof);
  let measured = 0;
  const result = await dryRun(proof, {
    clock,
    findings,
    measureScene: () => { measured++; return null; },
  });
  assert.equal(measured, 0, 'a supplied finding list means no second sweep');
  assert.deepEqual(result.findings, findings);
});

test('dryRun defaults its clock to the proof itself, so a rehearsal stays deterministic', async () => {
  const a = await dryRun(cleanProof(), {});
  const b = await dryRun(cleanProof(), {});
  assert.equal(JSON.stringify(a.findings), JSON.stringify(b.findings));
  assert.equal(a.positions, b.positions);
});

test('dryRun awaits an async onPosition, so a real rehearsal can pace itself', async () => {
  let ticks = 0;
  const result = await dryRun(cleanProof(), {
    clock,
    onPosition: async () => { await Promise.resolve(); ticks++; },
  });
  assert.equal(ticks, result.positions);
});

// ---------------------------------------------------------------------------
// The summary the emitter reads
// ---------------------------------------------------------------------------

test('summarize counts by severity and code, and canEmit follows severity 1 alone', async () => {
  const clean = summarize(await preflight(cleanProof()));
  assert.deepEqual(clean, { total: 0, blocking: 0, warnings: 0, notes: 0, byCode: {}, canEmit: true });

  const warned = summarize(await preflight(defectProof('BEAT_EMPTY')));
  assert.equal(warned.warnings, 1);
  assert.equal(warned.blocking, 0);
  assert.equal(warned.canEmit, true, 'a warning does not block emit');

  const noted = summarize(await runPreflight(defectProof('STALE_CAPTURE'), { clock: () => '2026-12-01T00:00:00.000Z' }));
  assert.equal(noted.notes, 1);
  assert.equal(noted.canEmit, true, 'an informational finding does not block emit');

  const blocked = summarize(await preflight(defectProof('PROVENANCE_UNLABELED')));
  assert.equal(blocked.blocking, 1);
  assert.equal(blocked.canEmit, false);
  assert.equal(blocked.byCode.PROVENANCE_UNLABELED, 1);
});
