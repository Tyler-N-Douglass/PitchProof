/**
 * Provenance attacks (§9, §18.1, §22.6, §20 axis 7).
 *
 * §22.6 calls provenance leakage "the single reputational risk in this
 * product", and §9 says the enforcement lives in the emitter, not the UI. So
 * every attack below is run through `emit()` itself and asserted to come back
 * as a refusal — not as a warning, not as a finding a caller could ignore.
 *
 * The list is the one the lane brief names, plus the variants an attacker
 * reaches for next: a clip, a zero-size box, an empty label, and a rule hidden
 * inside a media query.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../../src/emit/index.js';
import { assertProvenance } from '../../src/emit/provenance.js';
import { parseStylesheet } from '../../src/emit/css.js';
import { registerTestLayouts } from '../fixtures/emit/layouts.mjs';
import { runtimeBundle, FIXED_CLOCK } from '../fixtures/emit/runtime-bundle.mjs';
import { emitProof } from '../fixtures/emit/proofs.mjs';

const { js: runtimeJs, css: runtimeCss } = runtimeBundle();

/**
 * @param {object} [options]
 * @param {Parameters<typeof registerTestLayouts>[0]} [options.layout]
 * @param {string} [options.userCss]
 * @param {Partial<import('../../src/core/contracts.d.ts').EmitOptions>} [options.emitOptions]
 * @param {Parameters<typeof emitProof>[0]} [options.proof]
 */
async function attempt(options = {}) {
  registerTestLayouts(options.layout || {});
  const proof = emitProof(options.proof || {});
  return emit(proof, options.emitOptions || {}, {
    runtimeJs,
    runtimeCss,
    clock: FIXED_CLOCK,
    userCss: options.userCss || '',
  });
}

/**
 * The custom properties the `.pp-provenance` rule reads for its foreground and
 * background, read out of the emitted stylesheet.
 *
 * Discovered rather than hardcoded, so that moving the label onto a different
 * colour pair cannot leave this file attacking variables nothing uses.
 * @returns {{color: string|null, background: string|null}}
 */
function labelColourVars() {
  const { rules } = parseStylesheet(runtimeCss);
  /** @type {{color: string|null, background: string|null}} */
  const out = { color: null, background: null };
  for (const rule of rules) {
    if (!rule.selector.some((part) => part.classes.includes('pp-provenance'))) continue;
    for (const decl of rule.declarations) {
      const m = /var\(\s*(--[\w-]+)/.exec(decl.value);
      if (!m) continue;
      if (decl.prop === 'color') out.color = m[1];
      if (decl.prop === 'background' || decl.prop === 'background-color') out.background = m[1];
    }
  }
  return out;
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
  for (const f of findings) assert.equal(f.severity, 1, `${what} produced severity ${f.severity}, and §14 fixes it at 1`);
  assert.ok(
    findings.some((f) => messageMatch.test(f.message)),
    `${what}: no finding matched ${messageMatch}. Got: ${findings.map((f) => f.message).join(' | ')}`,
  );
  assert.equal(result.detail.html, '', `${what}: a refused emit must not hand back an artifact`);
  assert.match(result.error, /no override flag/i);
}

test('the control case emits cleanly — the attacks below are the only difference', async () => {
  const result = await attempt();
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.equal(result.value.findings.filter((f) => f.severity === 1).length, 0);
});

test('attack 1: omit the provenance label entirely', async () => {
  const result = await attempt({ layout: { omitLabel: true } });
  assertBlocked(result, /carries no \.pp-provenance element|is unlabelled/, 'omitting the label');
});

test('attack 2: labelIllustrativeContent:false on a review-reachable build', async () => {
  const review = await attempt({ emitOptions: { mode: 'review', labelIllustrativeContent: false } });
  assertBlocked(review, /cannot be disabled/, 'disabling labels on a Review build');

  const both = await attempt({ emitOptions: { mode: 'both', labelIllustrativeContent: false } });
  assertBlocked(both, /cannot be disabled/, 'disabling labels on a mode:both build');
});

test('attack 3: style the label to opacity:0', async () => {
  const viaCss = await attempt({ userCss: '.pp-provenance{opacity:0}' });
  assertBlocked(viaCss, /opacity:0/, 'opacity:0 via user CSS');

  const viaInline = await attempt({ layout: { labelStyle: 'opacity:0' } });
  assertBlocked(viaInline, /opacity:0/, 'opacity:0 via an inline style');
});

test('attack 4: style the label to display:none', async () => {
  const own = await attempt({ userCss: '.pp-provenance{display:none}' });
  assertBlocked(own, /display:none on the label/, 'display:none on the label');

  const ancestor = await attempt({ userCss: '.pp-rendition{display:none}' });
  assertBlocked(ancestor, /display:none on an ancestor/, 'display:none on an ancestor');
});

test('attack 5: style the label to visibility:hidden', async () => {
  const result = await attempt({ userCss: '.pp-provenance{visibility:hidden}' });
  assertBlocked(result, /visibility:hidden/, 'visibility:hidden');
});

test('attack 6: shrink the label to 1px', async () => {
  const px = await attempt({ userCss: '.pp-provenance{font-size:1px}' });
  assertBlocked(px, /font-size computes to 1px/, 'a 1px label');

  const em = await attempt({ userCss: '.pp-provenance{font-size:0.05em}' });
  assertBlocked(em, /below the 11px floor/, 'a label sized in ems below the floor');

  const clamped = await attempt({ userCss: '.pp-provenance{font-size:clamp(2px, 1vw, 14px)}' });
  assertBlocked(clamped, /below the 11px floor/, 'a clamp() whose floor is below 11px');
});

test('attack 7: zero-contrast colours', async () => {
  const same = await attempt({ userCss: '.pp-provenance{color:#ffffff;background:#ffffff}' });
  assertBlocked(same, /computed contrast is 1\.00:1/, 'white on white');

  const named = await attempt({ userCss: '.pp-provenance{color:white;background-color:white}' });
  assertBlocked(named, /computed contrast/, 'white on white by name');

  const marginal = await attempt({ userCss: '.pp-provenance{color:#777777;background:#ffffff}' });
  assertBlocked(marginal, /below the 4.5:1 floor/, 'a 4.48:1 pair, just under the floor');

  const justOver = await attempt({ userCss: '.pp-provenance{color:#767676;background:#ffffff}' });
  assert.equal(justOver.ok, true, 'a 4.54:1 pair clears the floor and must not be refused');

  // Attack the variables the label *actually* reads, discovered from the
  // stylesheet rather than hardcoded. The first version of this test named
  // `--pp-warning`/`--pp-on-primary`; the runtime later moved the label onto
  // the `surfaceAlt` pair, and a hardcoded attack would have gone on passing
  // while testing nothing.
  const vars = labelColourVars();
  assert.ok(vars.color && vars.background, `could not find the label's colour variables in the stylesheet: ${JSON.stringify(vars)}`);
  const viaVars = await attempt({ userCss: `:root{${vars.background}:#fefefe;${vars.color}:#ffffff}` });
  assertBlocked(viaVars, /computed contrast/, `an attack through ${vars.background}/${vars.color}, the theme variables the label reads`);
});

test('attack 8: position the label off screen', async () => {
  const absolute = await attempt({ userCss: '.pp-provenance{position:absolute;left:-9999px}' });
  assertBlocked(absolute, /off screen/, 'position:absolute;left:-9999px');

  const indent = await attempt({ userCss: '.pp-provenance{text-indent:-9999px}' });
  assertBlocked(indent, /off screen/, 'text-indent:-9999px');

  const transform = await attempt({ userCss: '.pp-provenance{transform:translateX(-9999px)}' });
  assertBlocked(transform, /off screen/, 'transform:translateX(-9999px)');
});

test('attack 9: verified-by-user with no promotion record', async () => {
  const result = await attempt({ proof: { promotionNote: null } });
  assertBlocked(result, /no promotion record/, 'an unearned verified-by-user claim');

  const vague = await attempt({ proof: { promotionNote: 'promoted' } });
  assertBlocked(vague, /no promotion record/, 'a note that says "promoted" and nothing else');

  const noWho = await attempt({ proof: { promotionNote: 'promoted at 2026-02-14T10:12:00.000Z' } });
  assertBlocked(noWho, /no promotion record/, 'a promotion with a time and no person');
});

test('attack 10: clip the label away', async () => {
  const clip = await attempt({ userCss: '.pp-provenance{clip:rect(0,0,0,0)}' });
  assertBlocked(clip, /clip:rect\(0,0,0,0\)/, 'clip:rect(0,0,0,0)');

  const clipPath = await attempt({ userCss: '.pp-provenance{clip-path:inset(100%)}' });
  assertBlocked(clipPath, /clip-path/, 'clip-path:inset(100%)');
});

test('attack 11: collapse the label to zero size', async () => {
  const zeroHeight = await attempt({ userCss: '.pp-provenance{height:0;overflow:hidden}' });
  assertBlocked(zeroHeight, /height:0/, 'height:0');

  const zeroScale = await attempt({ userCss: '.pp-provenance{transform:scale(0)}' });
  assertBlocked(zeroScale, /collapses it/, 'transform:scale(0)');
});

test('attack 12: an empty label', async () => {
  const result = await attempt({ layout: { labelEmptyText: true } });
  assertBlocked(result, /renders no text/, 'a label with no text');
});

test('attack 13: hide the label inside a media query', async () => {
  const result = await attempt({ userCss: '@media (min-width: 600px){.pp-provenance{display:none}}' });
  assertBlocked(result, /display:none/, 'display:none inside a screen media query');
});

test('attack 14: !important cannot beat the law either', async () => {
  const result = await attempt({ userCss: '.pp-provenance{opacity:0 !important;font-size:12px}' });
  assertBlocked(result, /opacity:0/, 'an !important opacity:0');
});

test('attack 15: drop the rendition scoping attribute and under-label the scene', async () => {
  const result = await attempt({ layout: { omitRenditionAttr: true, omitLabel: true } });
  assertBlocked(result, /has 0 spare \.pp-provenance element/, 'an unscoped scene with no labels');
});

test('attack 16: render illustrative content without declaring it', async () => {
  // Dropping `data-pp-rendition` is the obvious way to escape a subtree check.
  // The rendition's own label text is still on screen, so the content-based
  // fallback catches it.
  const result = await attempt({ layout: { omitRenditionAttr: true, omitLabel: true } });
  assertBlocked(result, /unscoped rendition/, 'undeclared illustrative content');
});

test('a rendition a layout does not render needs no label', async () => {
  // `quoteCard` pulls one quotation out of a scene's renditions. What is not on
  // screen has nothing to label, and demanding one would refuse an honest proof.
  const { registerAllLayouts } = await import('../../src/scene/index.js');
  const { resetLayouts } = await import('../../src/runtime/layouts.js');
  resetLayouts();
  registerAllLayouts();
  const proof = emitProof();
  const quoted = { ...proof, spine: proof.spine.map((s, i) => (i === 1 ? { ...s, layout: 'quoteCard' } : s)) };
  const result = await emit(quoted, {}, { runtimeJs, runtimeCss, clock: FIXED_CLOCK });
  assert.equal(result.ok, true, result.ok ? '' : result.error);
});

test('a @media print rule that hides the label is not an attack', async () => {
  const result = await attempt({ userCss: '@media print{.pp-provenance{display:none}}' });
  assert.equal(result.ok, true, 'a print-only rule cannot hide anything in the room');
});

test('a :hover rule that hides the label is transient, not an attack', async () => {
  const result = await attempt({ userCss: '.pp-provenance:hover{opacity:0}' });
  assert.equal(result.ok, true);
});

test('client-supplied renditions need no label and none is demanded', () => {
  const proof = emitProof();
  const clientOnly = {
    ...proof,
    renditions: proof.renditions.filter((r) => r.provenance === 'client-supplied'),
    spine: proof.spine.map((s) => ({ ...s, renditionIds: s.renditionIds.filter((id) => id.includes('client')) })),
    branches: proof.branches.map((b) => ({ ...b, scenes: b.scenes.map((s) => ({ ...s, renditionIds: [] })) })),
  };
  assert.deepEqual(assertProvenance(clientOnly, '', runtimeCss, { renderScene: () => null }), []);
});

test('a properly promoted rendition needs no label', () => {
  // The fixture's verified rendition is promoted through L7's
  // `promoteProvenance`, which is the only route to `verified-by-user` (§9).
  const proof = emitProof();
  const verified = proof.renditions.find((r) => r.provenance === 'verified-by-user');
  assert.ok(verified, 'the fixture must carry a promoted rendition');
  assert.match(verified.notes, /\[\[pp-promotion:/, 'the promotion must be on the record, not in prose');
  const findings = assertProvenance(proof, '', runtimeCss, { renderScene: () => null });
  assert.equal(findings.filter((f) => /promotion record/.test(f.message)).length, 0);
});

test('a promotion record copied from another rendition does not verify', () => {
  const proof = emitProof();
  const verified = proof.renditions.find((r) => r.provenance === 'verified-by-user');
  const stolen = {
    ...proof,
    renditions: proof.renditions.map((r) => (r.provenance === 'illustrative' && r.label === 'SMS'
      ? { ...r, provenance: 'verified-by-user', notes: verified.notes }
      : r)),
  };
  const findings = assertProvenance(stolen, '', runtimeCss, { renderScene: () => null });
  const unearned = findings.filter((f) => /no promotion record/.test(f.message));
  assert.equal(unearned.length, 1, 'a record written for another rendition must not verify this one');
  assert.equal(unearned[0].severity, 1);
});

test('assertProvenance refuses rather than assumes when it cannot render a scene', () => {
  const proof = emitProof();
  const findings = assertProvenance(proof, '', runtimeCss, {});
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.severity === 1));
  assert.ok(findings.some((f) => /could not be verified/.test(f.message)));
});
