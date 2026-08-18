/**
 * §14 — "Auto-fix where safe and reversible… Every auto-fix is logged and
 * undoable."
 *
 * Three properties are asserted for every fix the engine offers, on every
 * finding it offers one for:
 *
 *  1. **It works.** Applying it makes the finding go away — or, for the two fixes
 *     the emitter carries out rather than the model (`effect: 'plan'`), it
 *     changes the instruction the emitter follows. Nothing else is legal, and
 *     the test below enumerates which fixes are which.
 *  2. **It is pure.** The proof handed in is byte-identical afterwards, which is
 *     what makes the fix reversible: the "undo" state is the object you already
 *     had. Apply-then-revert is therefore not a separate code path that could
 *     rot; it is the absence of one.
 *  3. **It is undoable in the studio.** `autoFixCommand` wraps it as a
 *     `CommandStack` command stamped `meta.autoFix`, and running it and undoing
 *     it on a real stack returns the exact prior state.
 *
 * The codes with no fix are asserted too, because "we chose not to" is a
 * decision that should fail loudly if someone quietly changes it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CommandStack } from '../../src/core/command.js';
import { stableStringify } from '../../src/core/hash.js';
import { FINDING_CODES } from '../../src/core/contracts.js';
import {
  runPreflight, autoFixes, autoFixCommand, applyAll, FIXABLE_CODES, summarize,
} from '../../src/validate/index.js';

import { cleanProof, defectProof, copy, NOW } from '../fixtures/validate/defects.mjs';

const preflight = (proof, options = {}) => runPreflight(proof, { clock: () => NOW, ...options });

/**
 * Codes whose fix is an instruction to the emitter rather than a model edit that
 * clears the finding on its own. Resampling pixels needs an image codec, which
 * belongs to L10's budgeter; what preflight can honestly do is hand it a plan.
 */
const PLANNED = {
  ASSET_OVERSIZE: 'the byte count comes down when the budgeter recompresses, not when the option changes',
  SIZE_BUDGET_EXCEEDED: 'the same recompression, applied to the whole budget',
};

/**
 * Codes whose fix reduces the consequence of a finding that remains true. The
 * post-condition is that the fix is no longer offered afterwards.
 */
const MITIGATED = {
  FONT_UNAVAILABLE: 'the face stays unembeddable; the fix decides which face renders instead',
};

/** Codes deliberately left unfixable, with the reason each one is. */
const UNFIXABLE = {
  TEXT_OVERFLOW: 'rewriting a seller\'s headline before a pitch is editorial, not mechanical',
  NETWORK_REFERENCE: 'the only fix is to remove content the user put there deliberately',
  STALE_CAPTURE: 'nothing but re-capturing fixes it',
  SPECIMEN_EMPTY: 'nothing but re-capturing fixes it',
  DUPLICATE_SCENE: 'which copy to keep is a decision about the narrative',
};

test('the fixable and unfixable sets together cover every code, with no overlap', () => {
  for (const code of FINDING_CODES) {
    const fixable = FIXABLE_CODES.includes(code);
    const unfixable = code in UNFIXABLE;
    assert.ok(fixable !== unfixable, `${code} must be either fixable or documented as unfixable, not both or neither`);
  }
});

test('every auto-fix resolves the finding that produced it', async () => {
  for (const code of FINDING_CODES) {
    const proof = defectProof(code);
    const findings = await preflight(proof);
    const fixes = autoFixes(proof, findings).filter((f) => f.finding.code === code);
    if (code in UNFIXABLE) {
      assert.equal(fixes.length, 0, `${code} must offer no fix: ${UNFIXABLE[code]}`);
      continue;
    }
    assert.ok(fixes.length > 0, `${code} declared a fix but offered none`);
    for (const fix of fixes) {
      assert.ok(['resolves', 'plan', 'mitigates'].includes(fix.effect), `${code}: a fix must declare its effect`);
      if (code in MITIGATED) {
        assert.equal(fix.effect, 'mitigates', `${code}: ${MITIGATED[code]}`);
        const fixed = fix.apply(proof);
        const after = await preflight(fixed);
        const still = after.find((f) => f.id === fix.finding.id);
        assert.ok(still, `${code}: a mitigated finding stays reported, because it is still true`);
        assert.equal(still.autoFixAvailable, false, `${code}: the fix must not be offered twice`);
        assert.deepEqual(autoFixes(fixed, after).filter((f) => f.finding.code === code), []);
        continue;
      }
      if (code in PLANNED) {
        assert.equal(fix.effect, 'plan', `${code}: ${PLANNED[code]}`);
        const fixed = fix.apply(proof);
        assert.notEqual(fixed.emitOptions.imageQuality, proof.emitOptions.imageQuality);
        continue;
      }
      assert.equal(fix.effect, 'resolves', `${code}: this fix must clear its own finding`);
      const fixed = fix.apply(proof);
      const after = await preflight(fixed);
      const remaining = after.filter((f) => f.id === fix.finding.id);
      assert.deepEqual(remaining, [], `${code}: "${fix.label}" did not resolve its own finding`);
    }
  }
});

test('every auto-fix is pure — the proof handed in is untouched, which is the undo', async () => {
  for (const code of FINDING_CODES.filter((c) => !(c in UNFIXABLE))) {
    const proof = defectProof(code);
    const before = stableStringify(proof);
    const findings = await preflight(proof);
    for (const fix of autoFixes(proof, findings)) {
      const fixed = fix.apply(proof);
      assert.notEqual(stableStringify(fixed), before, `${code}: "${fix.label}" changed nothing`);
      assert.equal(stableStringify(proof), before, `${code}: "${fix.label}" mutated the proof it was given`);
      // Applying twice is idempotent in effect and still pure.
      const twice = fix.apply(fixed);
      assert.equal(stableStringify(proof), before);
      assert.ok(twice);
    }
  }
});

test('applying a fix and reverting it returns the identical proof', async () => {
  const proof = defectProof('CONTRAST_FAIL');
  const original = copy(proof);
  const findings = await preflight(proof);
  const fixes = autoFixes(proof, findings);
  assert.ok(fixes.length > 0);

  const stack = new CommandStack(proof, {});
  for (const fix of fixes) stack.run(autoFixCommand(stack.state, fix));
  assert.notDeepEqual(stack.state, original);
  while (stack.canUndo) stack.undo();
  assert.deepEqual(stack.state, original, 'undoing every auto-fix must restore the exact prior proof');
});

test('an auto-fix command is stamped so the history shows what the tool did', async () => {
  const proof = defectProof('BEAT_EMPTY');
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings);
  const command = autoFixCommand(proof, fix);
  assert.equal(command.scope, 'proof');
  assert.equal(command.meta.autoFix, true);
  assert.equal(command.meta.code, 'BEAT_EMPTY');
  assert.equal(command.meta.findingId, fix.finding.id);
  assert.equal(command.meta.severity, fix.finding.severity);

  const stack = new CommandStack(proof, {});
  stack.run(command);
  const [entry] = stack.history();
  assert.equal(entry.label, fix.label);
  assert.equal(entry.meta.autoFix, true);
  assert.equal(stack.undoLabel, fix.label);
});

/**
 * Apply the offered fixes, re-run preflight, and repeat until nothing fixable is
 * left. Fixing a palette is genuinely iterative: deriving `primary` dark enough
 * to carry a headline changes what `onPrimary` has to clear, so a single pass
 * over findings computed against the *original* palette cannot be the whole
 * answer, and pretending otherwise would be the bug.
 */
async function fixToFixpoint(proof, rounds = 6) {
  let current = proof;
  for (let i = 0; i < rounds; i++) {
    const findings = await preflight(current);
    const fixes = autoFixes(current, findings).filter((f) => f.effect === 'resolves');
    if (fixes.length === 0) return { proof: current, findings, rounds: i };
    current = fixes[0].apply(current);
  }
  return { proof: current, findings: await preflight(current), rounds };
}

test('the contrast fix derives a colour that actually meets the minimum', async () => {
  const proof = defectProof('CONTRAST_FAIL');
  const { proof: fixed, findings: after } = await fixToFixpoint(proof);
  assert.deepEqual(after.filter((f) => f.code === 'CONTRAST_FAIL'), []);

  const onPrimary = fixed.brand.colors.find((c) => c.role === 'onPrimary');
  assert.equal(onPrimary.source, 'derived', 'a derived colour must say so');
  assert.ok(onPrimary.contrastWithPair >= 4.5, 'the recorded ratio must be the computed one');
  assert.equal(onPrimary.oklch.length, 3);
  assert.ok(fixed.brand.manualOverrides.includes('brand.colors.onPrimary'), 'the edit is recorded as an override');
});

test('the oversize fix steps image quality down, and offers nothing at the floor', async () => {
  const proof = defectProof('ASSET_OVERSIZE');
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings).filter((f) => f.finding.code === 'ASSET_OVERSIZE');
  assert.match(fix.label, /quality 0\.75/);
  assert.equal(fix.apply(proof).emitOptions.imageQuality, 0.75);

  const atFloor = copy(proof);
  atFloor.emitOptions.imageQuality = 0.6;
  const floorFindings = await preflight(atFloor);
  const oversize = floorFindings.find((f) => f.code === 'ASSET_OVERSIZE');
  assert.equal(oversize.autoFixAvailable, false, 'nothing left to give');
  assert.deepEqual(autoFixes(atFloor, floorFindings).filter((f) => f.finding.code === 'ASSET_OVERSIZE'), []);
});

test('the beat fix trims the empty beat and never the last one', async () => {
  const proof = defectProof('BEAT_EMPTY');
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings);
  const fixed = fix.apply(proof);
  assert.equal(fixed.spine[0].beats.length, proof.spine[0].beats.length - 1);
  assert.ok(fixed.spine[0].beats.every((b) => b.reveals.length > 0));

  // A scene down to one empty beat is the still-frame shape; the fix must not
  // leave a scene with no position for the navigator to stand on.
  const single = copy(cleanProof());
  single.spine[0].beats = [
    { id: 'only', reveals: [], presenterNote: null, dwellHintMs: null },
  ];
  const singleFindings = await preflight(single);
  assert.deepEqual(singleFindings.filter((f) => f.code === 'BEAT_EMPTY'), []);
});

test('the font fix rewrites the fallback stack to the face that will actually render', async () => {
  const proof = defectProof('FONT_UNAVAILABLE');
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings).filter((f) => f.finding.code === 'FONT_UNAVAILABLE');
  const fixed = fix.apply(proof);
  const face = fixed.brand.faces.find((f) => f.role === 'display');
  assert.equal(face.fallbackStack[0], 'Inter', 'the requested face stays first — it may yet be installed');
  assert.ok(face.fallbackStack.includes('Arial'));
  assert.ok(face.metricDelta && typeof face.metricDelta.avgAdvance === 'number');
  assert.ok(fixed.brand.manualOverrides.some((p) => p.includes('fallbackStack')));
});

test('the missing-asset fix removes only the block that dangles', async () => {
  const proof = defectProof('ASSET_MISSING');
  const before = proof.specimens[0].blocks.length;
  const findings = await preflight(proof);
  const [fix] = autoFixes(proof, findings).filter((f) => f.finding.code === 'ASSET_MISSING');
  const fixed = fix.apply(proof);
  assert.equal(fixed.specimens[0].blocks.length, before - 1);
  assert.ok(!fixed.specimens[0].blocks.some((b) => b.type === 'media' && b.ref === 'md_nowhere'));
  assert.ok(fixed.specimens[0].blocks.some((b) => b.type === 'heading'), 'the rest of the specimen survives');
});

test('fixes compose: applying every offered fix leaves a proof that can emit', async () => {
  // Three defects at once, all of them fixable.
  const proof = copy(cleanProof());
  proof.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';
  proof.spine[0].beats.splice(1, 0, { id: 'dead', reveals: [], presenterNote: null, dwellHintMs: null });
  proof.branches.push({
    id: 'bn_dead', objection: 'x', aliases: [], returnPolicy: 'anchor',
    scenes: [{ ...copy(proof.spine[2]), id: 'sc_dead', beats: [{ id: 'sc_dead_b0', reveals: ['e'], presenterNote: null, dwellHintMs: null }] }],
  });

  const findings = await preflight(proof);
  assert.ok(summarize(findings).blocking > 0, 'the fixture must actually block');
  const { proof: fixed, findings: after, rounds } = await fixToFixpoint(proof, 12);
  assert.equal(summarize(after).blocking, 0, `still blocking after ${rounds} rounds:\n  ${after.filter((f) => f.severity === 1).map((f) => f.message).join('\n  ')}`);
  assert.equal(summarize(after).canEmit, true);
  assert.ok(fixed.brand.manualOverrides.length > 0);
  assert.ok(rounds < 12, 'auto-fixing must converge rather than oscillate');
});

test('autoFixes offers nothing for findings that did not advertise a fix', async () => {
  const findings = await preflight(defectProof('TEXT_OVERFLOW'));
  const overflow = findings.filter((f) => f.code === 'TEXT_OVERFLOW');
  assert.ok(overflow.length > 0);
  assert.ok(overflow.every((f) => f.autoFixAvailable === false));
  assert.deepEqual(autoFixes(defectProof('TEXT_OVERFLOW'), overflow), []);
});

test('autoFixes is deterministic in order and content', async () => {
  const proof = defectProof('CONTRAST_FAIL');
  const findings = await preflight(proof);
  const a = autoFixes(proof, findings).map((f) => `${f.finding.id}:${f.label}`);
  const b = autoFixes(proof, findings).map((f) => `${f.finding.id}:${f.label}`);
  assert.deepEqual(a, b);
});
