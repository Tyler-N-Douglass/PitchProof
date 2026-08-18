/**
 * §14 — "`CONTRAST_FAIL` — every text/background pair, computed, at severity 1
 * for body text below 4.5:1", against the adversarial palettes §17.2 names:
 * near-white primaries, neon accents, monochrome.
 *
 * The point of running hostile palettes here rather than only in L4's solver
 * tests is that a palette does not have to come from the solver. It can be
 * hand-edited in the studio, imported from an older project, or hand-typed by a
 * seller working from a brand PDF at eleven at night. Whatever its provenance,
 * the client sees the result, so preflight recomputes rather than trusts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTRAST_AA_BODY, CONTRAST_AA_LARGE, FOREGROUND_ROLES, ROLE_PAIR } from '../../src/core/contracts.js';
import { checkContrast, contrastReport, displayTextIsLarge, PROVENANCE_PAIR } from '../../src/validate/index.js';
import { contrastRatio } from '../../src/validate/lane-brand.js';
import { COMPLIANT_COLORS, brand, copy } from '../fixtures/validate/defects.mjs';

/** Build a brand from a role→hex map, filling the rest from the compliant palette. */
function palette(overrides, faceOverrides) {
  const b = copy(brand());
  for (const [role, hex] of Object.entries(overrides)) {
    const token = b.colors.find((c) => c.role === role);
    if (token) token.hex = hex;
    else b.colors.push({ role, hex, oklch: [0.5, 0, 0], source: 'manual', contrastWithPair: null });
  }
  // The stored `contrastWithPair` is deliberately left stale: the rule must
  // recompute from the hex, never read the number the model claims.
  if (faceOverrides) b.faces = faceOverrides;
  return b;
}

test('a compliant palette produces no contrast findings', () => {
  assert.deepEqual(checkContrast(brand()), []);
});

test('every pair the sweep inspects is actually measured, not skipped', () => {
  const report = contrastReport(brand());
  assert.ok(report.length >= FOREGROUND_ROLES.length + 4);
  for (const row of report) {
    assert.ok(row.ratio !== null, `${row.fg}/${row.bg} was not measured`);
    assert.ok(row.passes, `${row.fg}/${row.bg} measured ${row.ratio} against ${row.minimum}`);
  }
  for (const role of FOREGROUND_ROLES) {
    assert.ok(report.some((r) => r.fg === role && r.bg === ROLE_PAIR[role] && r.minimum === CONTRAST_AA_BODY));
  }
});

test('a near-white primary with white text on it blocks emit', () => {
  const findings = checkContrast(palette({ primary: '#EDEFF5' }));
  const pair = findings.find((f) => f.detail.foregroundRole === 'onPrimary');
  assert.ok(pair, 'onPrimary on a near-white primary must be reported');
  assert.equal(pair.severity, 1);
  assert.equal(pair.code, 'CONTRAST_FAIL');
  assert.ok(pair.detail.ratio < CONTRAST_AA_BODY);
  assert.equal(pair.detail.minimum, CONTRAST_AA_BODY);
  assert.equal(pair.autoFixAvailable, true);
  assert.match(pair.message, /below the 4\.5:1 body-text minimum/);
});

test('a neon accent fails as display text at 3:1 and as a body pair at 4.5:1', () => {
  const findings = checkContrast(palette({ accent: '#4BFF00', onAccent: '#FFFFFF' }));
  const codes = findings.map((f) => `${f.detail.foregroundRole}/${f.detail.backgroundRole}:${f.detail.kind}`);
  assert.ok(codes.includes('onAccent/accent:body'), 'white on neon green is unreadable body text');
  assert.ok(codes.includes('accent/surface:large'), 'neon green as a headline colour on white fails 3:1');
  for (const f of findings) assert.equal(f.severity, 1);
});

test('a monochrome palette fails on every foreground pair at once', () => {
  const mono = palette({
    primary: '#767676', onPrimary: '#8A8A8A',
    secondary: '#7A7A7A', onSecondary: '#909090',
    surface: '#FFFFFF', onSurface: '#A8A8A8',
    surfaceAlt: '#EFEFEF', onSurfaceAlt: '#ADADAD',
    accent: '#6E6E6E', onAccent: '#828282',
  });
  const findings = checkContrast(mono);
  const failed = new Set(findings.map((f) => f.detail.foregroundRole));
  for (const role of FOREGROUND_ROLES) assert.ok(failed.has(role), `${role} was not reported`);
  assert.ok(findings.filter((f) => f.severity === 1).length >= FOREGROUND_ROLES.length);
});

test('an ultra-dark palette with dark text on it blocks', () => {
  const findings = checkContrast(palette({ surface: '#0B0D12', onSurface: '#20242D' }));
  const pair = findings.find((f) => f.detail.foregroundRole === 'onSurface');
  assert.equal(pair.severity, 1);
  assert.ok(pair.detail.ratio < 1.6);
});

test('the illustrative-content label is checked against its own background', () => {
  const findings = checkContrast(palette({ surfaceAlt: '#F2F4F8', onSurfaceAlt: '#C9CDD6' }));
  const pair = findings.find(
    (f) => f.detail.foregroundRole === PROVENANCE_PAIR.fg && f.detail.backgroundRole === PROVENANCE_PAIR.bg,
  );
  assert.ok(pair, 'the provenance pair must be measured');
  assert.equal(pair.severity, 1);
  assert.match(pair.message, /illustrative-content label/, '§18.1 must be named in the message');
});

test('large text is held to 3:1 only when the type scale actually makes it large', () => {
  const largeScale = brand();
  assert.equal(displayTextIsLarge(largeScale).large, true);

  // A brand whose display face is light-weight and whose scale starts small has
  // no large text, so the same pair is held to the body minimum instead.
  const small = copy(brand());
  small.faces = small.faces.map((f) => ({ ...f, weightsSeen: [300, 400] }));
  const scale = displayTextIsLarge(small);
  assert.equal(scale.bold, false);
  assert.equal(scale.large, true, 'a 28px headline is large text even unbolded');

  // A borderline brand colour: passes 3:1, fails 4.5:1.
  const borderline = palette({ accent: '#C07800' });
  const ratio = contrastRatio('#C07800', '#FFFFFF');
  assert.ok(ratio >= CONTRAST_AA_LARGE && ratio < CONTRAST_AA_BODY, `expected a borderline colour, got ${ratio}`);
  const findings = checkContrast(borderline);
  assert.ok(
    !findings.some((f) => f.detail.foregroundRole === 'accent' && f.detail.backgroundRole === 'surface'),
    'a colour that clears 3:1 must not be reported while the scale keeps it large',
  );
});

test('non-text pairs warn rather than block', () => {
  const findings = checkContrast(palette({ border: '#E4E7EC' }));
  const pair = findings.find((f) => f.detail.foregroundRole === 'border');
  assert.ok(pair);
  assert.equal(pair.severity, 2, 'nothing is read off a divider');
  assert.equal(pair.detail.kind, 'nontext');
  assert.equal(pair.autoFixAvailable, false);
});

test('the sweep recomputes and never believes the stored contrastWithPair', () => {
  const lying = copy(brand());
  const onPrimary = lying.colors.find((c) => c.role === 'onPrimary');
  lying.colors.find((c) => c.role === 'primary').hex = '#F4F6FB';
  onPrimary.contrastWithPair = 21;          // the model claims it is fine
  const findings = checkContrast(lying);
  assert.ok(findings.some((f) => f.detail.foregroundRole === 'onPrimary' && f.severity === 1));
});

test('an unparseable colour does not crash the sweep', () => {
  const broken = copy(brand());
  broken.colors.find((c) => c.role === 'accent').hex = 'not-a-colour';
  assert.doesNotThrow(() => checkContrast(broken));
});

test('a missing role is skipped rather than guessed at', () => {
  const partial = copy(brand());
  partial.colors = partial.colors.filter((c) => c.role !== 'accent' && c.role !== 'onAccent');
  const findings = checkContrast(partial);
  assert.ok(!findings.some((f) => f.detail.foregroundRole === 'onAccent'));
});

test('contrast findings are deterministic and content-addressed', () => {
  const hostile = palette({ primary: '#EDEFF5', accent: '#4BFF00' });
  const a = JSON.stringify(checkContrast(hostile));
  const b = JSON.stringify(checkContrast(hostile));
  assert.equal(a, b);
  const ids = checkContrast(hostile).map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'two findings must never share an id');
});

test('WCAG ratios are exact — the W3C worked values, not an approximation', () => {
  // Black on white is exactly 21:1, and mid grey on white is a published value.
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF') * 100) / 100, 21);
  assert.equal(Math.round(contrastRatio('#FFFFFF', '#FFFFFF') * 100) / 100, 1);
  const grey = contrastRatio('#767676', '#FFFFFF');
  assert.ok(grey >= 4.5 && grey < 4.6, `#767676 on white is the canonical 4.54:1 boundary, got ${grey}`);
  assert.ok(COMPLIANT_COLORS.every((c) => /^#[0-9A-F]{6}$/.test(c.hex)));
});
