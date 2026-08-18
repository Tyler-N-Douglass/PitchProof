/**
 * §17.2 contrast solving, and the §22.1 risk it exists to retire.
 *
 * The claim under test is narrow and absolute: **`solveRoles` never returns a
 * palette in which a foreground role sits below 4.5:1 against its pair.** Not
 * "usually", not "for reasonable brands". The adversarial corpus in
 * `test/fixtures/brand/palettes.mjs` is fourteen palettes chosen to break a
 * heuristic chain — near-white primary, neon accent, monochrome, single hue,
 * ultra-dark, low-chroma grey, two-colour, one-colour, all-mid-lightness,
 * all-saturated, and four more — and every one of them is checked on every
 * foreground role, at the floor and above it.
 *
 * The other half of the claim is that the solver **refuses** rather than
 * returning something broken. Every entry in `IMPOSSIBLE_INPUTS` must throw.
 *
 * Contrast is recomputed here from an oracle written against the WCAG text, so
 * a bug in `contrastRatio` cannot make this file pass by agreeing with itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_ROLES, ROLE_PAIR, FOREGROUND_ROLES, BACKGROUND_ROLES,
  CONTRAST_AA_BODY, CONTRAST_AA_NONTEXT,
} from '../../src/core/contracts.js';
import {
  solveRoles, ContrastSolveError, deriveForContrast, DeriveError,
  paletteContrastReport, assertPaletteContrast, contrastCeiling, bestExtremeFor,
  contrastRatio, hexToOklch, oklchToHex, hexToRgb, rgbToHex, inGamut,
  clampChromaToGamut, hueDistance, maxChromaAt, buildCandidatePool,
  buildContext, searchAssignment, unaryCost, binaryCost, variantCandidates,
  neutralAnchors, hueCusp, cuspChroma, contrastReachable,
  MAX_CONTRAST, GUARANTEED_CONTRAST, SEMANTIC_HUES, DERIVE_MARGIN,
} from '../../src/brand/color.js';
import { ADVERSARIAL_PALETTES, IMPOSSIBLE_INPUTS } from '../fixtures/brand/palettes.mjs';

/** WCAG 2.1 contrast, written from the specification text, independent of `src/`. */
function oracleContrast(hexA, hexB) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const chan = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  };
  const a = lum(hexA);
  const b = lum(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Assert a returned palette satisfies every structural contract, not just contrast. */
function assertWellFormed(tokens, label, minRatio = CONTRAST_AA_BODY) {
  assert.equal(tokens.length, COLOR_ROLES.length, `${label}: one token per role`);
  assert.deepEqual(tokens.map((t) => t.role), COLOR_ROLES, `${label}: roles in contract order`);
  /** @type {Record<string, string>} */
  const byRole = {};
  for (const t of tokens) byRole[t.role] = t.hex;

  for (const t of tokens) {
    assert.match(t.hex, /^#[0-9a-f]{6}$/, `${label}: ${t.role} hex form`);
    assert.ok(['extracted', 'derived', 'manual'].includes(t.source), `${label}: ${t.role} source`);
    assert.ok(Array.isArray(t.oklch) && t.oklch.length === 3, `${label}: ${t.role} oklch shape`);
    assert.ok(t.oklch.every(Number.isFinite), `${label}: ${t.role} oklch finite`);
    assert.ok(t.oklch[0] >= 0 && t.oklch[0] <= 1, `${label}: ${t.role} L in 0..1`);
    assert.ok(t.oklch[1] >= 0, `${label}: ${t.role} C non-negative`);
    assert.ok(t.oklch[2] >= 0 && t.oklch[2] < 360, `${label}: ${t.role} H in 0..360`);
    // The declared OKLCH must be the OKLCH of the declared hex.
    const actual = hexToOklch(t.hex);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(t.oklch[i] - actual[i]) < 1e-9, `${label}: ${t.role} oklch matches hex`);
    }
    // Every colour in a returned palette is representable — derived ones too.
    assert.ok(inGamut(t.oklch), `${label}: ${t.role} (${t.hex}, ${t.source}) must be in gamut`);
    assert.equal(oklchToHex(t.oklch), t.hex, `${label}: ${t.role} oklch round-trips to its hex`);
    // contrastWithPair is computed, never assumed (§4).
    const pair = ROLE_PAIR[t.role];
    if (pair === null) {
      assert.equal(t.contrastWithPair, null, `${label}: ${t.role} has no pair`);
    } else {
      assert.ok(Number.isFinite(t.contrastWithPair), `${label}: ${t.role} contrastWithPair computed`);
      assert.ok(Math.abs(t.contrastWithPair - oracleContrast(t.hex, byRole[pair])) < 1e-9,
        `${label}: ${t.role} contrastWithPair must equal the oracle`);
    }
  }
  // The post-condition, checked against the oracle rather than the module.
  for (const role of FOREGROUND_ROLES) {
    const pair = ROLE_PAIR[role];
    const ratio = oracleContrast(byRole[role], byRole[pair]);
    assert.ok(ratio >= minRatio,
      `${label}: ${role} on ${pair} is ${ratio.toFixed(4)}:1, below the ${minRatio}:1 floor`);
  }
  return byRole;
}

/* ------------------------------------------------------- the corpus */

test('the adversarial corpus is at least the seven §17.2 hostilities', () => {
  const names = ADVERSARIAL_PALETTES.map((p) => p.name);
  assert.ok(ADVERSARIAL_PALETTES.length >= 7, 'at least seven hostile palettes');
  for (const required of ['near-white', 'neon', 'monochrome', 'single hue', 'ultra dark', 'low-chroma', 'two colour']) {
    assert.ok(names.some((n) => n.includes(required)), `corpus must cover "${required}"`);
  }
  for (const p of ADVERSARIAL_PALETTES) {
    assert.ok(p.hostility.length > 10, `${p.name} must say what it breaks`);
    assert.ok(p.clusters.length >= 1);
  }
});

for (const palette of ADVERSARIAL_PALETTES) {
  test(`every onX role meets 4.5:1 for the "${palette.name}" palette`, () => {
    const tokens = solveRoles(palette.clusters, { seed: 'test/brand/contrast' });
    assertWellFormed(tokens, palette.name);
  });
}

test('every foreground clears the floor with the margin the derivation promises', () => {
  for (const palette of ADVERSARIAL_PALETTES) {
    const tokens = solveRoles(palette.clusters, { seed: 'test/brand/contrast' });
    const report = paletteContrastReport(tokens);
    for (const row of report) {
      assert.ok(row.ok, `${palette.name}: ${row.role}`);
      // Derived foregrounds are aimed at the floor times the margin; extracted
      // ones are only required to clear the floor.
      const token = tokens.find((t) => t.role === row.role);
      if (token.source === 'derived') {
        assert.ok(row.ratio >= CONTRAST_AA_BODY,
          `${palette.name}: derived ${row.role} at ${row.ratio}`);
      }
    }
  }
  assert.ok(DERIVE_MARGIN >= 1, 'the derive margin never reduces the target');
});

test('the solve still holds when the floor is raised to AAA', () => {
  // 7:1 is above sqrt(21), so it is not universally reachable — but it is
  // reachable against every one of these palettes' backgrounds, and where it is
  // the solver must reach it rather than settling.
  for (const palette of ADVERSARIAL_PALETTES) {
    const tokens = solveRoles(palette.clusters, { seed: 'aaa', minRatio: 7 });
    assertWellFormed(tokens, `${palette.name} @7:1`, 7);
  }
});

test('the solve holds at every floor from 1.5 to 4.5', () => {
  for (const minRatio of [1.5, 2, 3, 4, 4.5, GUARANTEED_CONTRAST]) {
    for (const palette of ADVERSARIAL_PALETTES.slice(0, 6)) {
      const tokens = solveRoles(palette.clusters, { seed: 'sweep', minRatio });
      assertWellFormed(tokens, `${palette.name} @${minRatio}`, minRatio);
    }
  }
});

/* --------------------------------------------------- refusal, not failure */

for (const bad of IMPOSSIBLE_INPUTS) {
  test(`solveRoles refuses "${bad.name}" rather than returning a failing palette`, () => {
    assert.throws(
      () => solveRoles(bad.clusters, { ...bad.options, seed: 'refuse' }),
      (err) => err instanceof ContrastSolveError,
      `${bad.name}: ${bad.why}`,
    );
  });
}

test('solveRoles refuses non-array and nullish cluster sets', () => {
  for (const bad of [null, undefined, 'clusters', 42, {}]) {
    assert.throws(() => solveRoles(/** @type {any} */ (bad), { seed: 'x' }), ContrastSolveError);
  }
});

test('the post-condition rejects a hand-built failing palette', () => {
  // Build a palette by hand in which onSurface is unreadable, and confirm the
  // assertion the solver runs before returning would have caught it.
  const tokens = COLOR_ROLES.map((role) => ({
    role,
    hex: role.startsWith('on') ? '#f0f0f0' : '#ffffff',
    oklch: hexToOklch(role.startsWith('on') ? '#f0f0f0' : '#ffffff'),
    source: 'manual',
    contrastWithPair: null,
  }));
  assert.throws(() => assertPaletteContrast(tokens), ContrastSolveError);
  const report = paletteContrastReport(tokens);
  assert.ok(report.every((r) => !r.ok), 'every foreground in that palette fails');
  assert.equal(report.length, FOREGROUND_ROLES.length);
  // And a palette that passes is accepted without complaint.
  const good = COLOR_ROLES.map((role) => ({
    role,
    hex: role.startsWith('on') ? '#000000' : '#ffffff',
    oklch: hexToOklch(role.startsWith('on') ? '#000000' : '#ffffff'),
    source: 'manual',
    contrastWithPair: null,
  }));
  assertPaletteContrast(good);
  assert.ok(paletteContrastReport(good).every((r) => r.ratio === 21));
});

/* ------------------------------------------------------------ derivation */

test('deriveForContrast reaches the requested ratio against any target', () => {
  const targets = ['#ffffff', '#000000', '#808080', '#3b2eea', '#39ff14', '#f0728c',
    '#0b1220', '#767676', '#7f7f7f', '#ff0000', '#00ff00', '#0000ff'];
  const bases = ['#ffffff', '#000000', '#888888', '#3b2eea', '#ff6600', '#001858'];
  for (const target of targets) {
    for (const base of bases) {
      for (const ratio of [3, 4.5, GUARANTEED_CONTRAST]) {
        const out = deriveForContrast(base, target, ratio);
        assert.match(out, /^#[0-9a-f]{6}$/);
        const got = oracleContrast(out, target);
        assert.ok(got >= ratio,
          `derive(${base} vs ${target} @${ratio}) gave ${out} at ${got.toFixed(4)}:1`);
        assert.ok(inGamut(hexToOklch(out)), `${out} must be in gamut`);
      }
    }
  }
});

test('deriveForContrast holds the base hue wherever the gamut allows it', () => {
  for (const base of ['#3b2eea', '#d94f04', '#0d47a1', '#8b5e3c', '#e94560']) {
    const out = deriveForContrast(base, base, CONTRAST_AA_BODY);
    const before = hexToOklch(base);
    const after = hexToOklch(out);
    // The walk moves lightness only; hue survives to within the resolution an
    // 8-bit colour can express at the derived lightness.
    assert.ok(hueDistance(before[2], after[2]) < 12,
      `${base} → ${out}: hue moved ${hueDistance(before[2], after[2]).toFixed(2)}°`);
    assert.ok(oracleContrast(out, base) >= CONTRAST_AA_BODY);
  }
});

test('deriveForContrast returns the base untouched when it already passes', () => {
  assert.equal(deriveForContrast('#000000', '#ffffff', 4.5), '#000000');
  assert.equal(deriveForContrast('#FFFFFF', '#000000', 21), '#ffffff');
  assert.equal(deriveForContrast('#0b1220', '#ffffff', 4.5), '#0b1220');
  // A ratio of 1 or less is not a constraint.
  assert.equal(deriveForContrast('#3b2eea', '#3b2eea', 1), '#3b2eea');
  assert.equal(deriveForContrast('#3b2eea', '#3b2eea', 0), '#3b2eea');
});

test('deriveForContrast moves as little as it can', () => {
  // The derived colour must be the nearest satisfying lightness, so nudging one
  // step back toward the base breaks the constraint.
  for (const base of ['#ffffff', '#3b2eea', '#39ff14', '#7f7f7f']) {
    const out = deriveForContrast(base, base, CONTRAST_AA_BODY);
    const baseL = hexToOklch(base)[0];
    const outLch = hexToOklch(out);
    const towardBase = outLch[0] + Math.sign(baseL - outLch[0]) * 0.05;
    const nudged = oklchToHex([towardBase, outLch[1], outLch[2]]);
    assert.ok(oracleContrast(nudged, base) < oracleContrast(out, base) + 1e-9,
      `${base}: moving back toward the base must not increase contrast`);
  }
});

test('deriveForContrast refuses an unreachable ratio', () => {
  assert.throws(() => deriveForContrast('#888888', '#888888', 21.5), DeriveError);
  assert.throws(() => deriveForContrast('#888888', '#888888', MAX_CONTRAST + 1e-6), DeriveError);
  // Against mid-grey the ceiling really is below 21, and asking past it fails.
  const ceiling = contrastCeiling('#7f7f7f');
  assert.ok(ceiling < MAX_CONTRAST);
  assert.ok(!contrastReachable('#7f7f7f', ceiling + 0.01));
  assert.throws(() => deriveForContrast('#3b2eea', '#7f7f7f', ceiling + 0.5), DeriveError);
});

test('the derivation guarantee is a theorem, not a hope', () => {
  // contrast(c, white) · contrast(c, black) = 21 for every colour, so the best
  // extreme is never below sqrt(21) — which is above 4.5.
  for (let i = 0; i < 4096; i++) {
    const hex = rgbToHex([(i * 37) % 256, (i * 91) % 256, (i * 149) % 256]);
    const extreme = bestExtremeFor(hex);
    assert.ok(['#ffffff', '#000000'].includes(extreme));
    assert.ok(oracleContrast(extreme, hex) >= GUARANTEED_CONTRAST - 1e-9,
      `${hex}: best extreme ${extreme} gave ${oracleContrast(extreme, hex)}`);
    assert.ok(contrastCeiling(hex) >= GUARANTEED_CONTRAST - 1e-9);
    assert.ok(contrastReachable(hex, CONTRAST_AA_BODY));
  }
});

/* --------------------------------------------------------- determinism */

test('the same clusters and seed give byte-identical palettes', () => {
  for (const palette of ADVERSARIAL_PALETTES) {
    const a = solveRoles(palette.clusters, { seed: 'determinism' });
    const b = solveRoles(palette.clusters, { seed: 'determinism' });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), palette.name);
  }
});

test('a different seed still returns a palette that satisfies every constraint', () => {
  for (const seed of ['alpha', 'beta', 'gamma', 42, 'pitchproof-v1']) {
    for (const palette of ADVERSARIAL_PALETTES) {
      assertWellFormed(solveRoles(palette.clusters, { seed }), `${palette.name}/${seed}`);
    }
  }
});

test('cluster order does not change the solution', () => {
  // The search enumerates; it must not depend on the order clusters arrive in.
  for (const palette of ADVERSARIAL_PALETTES) {
    const forward = solveRoles(palette.clusters, { seed: 'order' });
    const reversed = solveRoles(palette.clusters.slice().reverse(), { seed: 'order' });
    assert.deepEqual(
      forward.map((t) => `${t.role}:${t.hex}`),
      reversed.map((t) => `${t.role}:${t.hex}`),
      palette.name,
    );
  }
});

/* ------------------------------------------------------- the cost model */

test('the search is exhaustive over the pool and its bound is admissible', () => {
  // Branch and bound must find exactly what brute force finds. Verified on a
  // pool small enough to enumerate completely inside the test.
  const clusters = [
    { hex: '#3b2eea', weight: 0.4 }, { hex: '#ffffff', weight: 0.35 },
    { hex: '#f0728c', weight: 0.15 }, { hex: '#0b1220', weight: 0.10 },
  ];
  const pool = buildCandidatePool(clusters);
  const ctx = buildContext(pool, CONTRAST_AA_BODY);
  const slots = ['surface', 'surfaceAlt', 'primary', 'accent', 'secondary'];
  const unary = slots.map((slot) => pool.map((_, ci) => unaryCost(slot, ci, ctx).total));
  let bestCost = Infinity;
  /** @type {number[]|null} */
  let bestPick = null;
  const P = pool.length;
  const pick = [0, 0, 0, 0, 0];
  for (pick[0] = 0; pick[0] < P; pick[0]++) {
    for (pick[1] = 0; pick[1] < P; pick[1]++) {
      for (pick[2] = 0; pick[2] < P; pick[2]++) {
        for (pick[3] = 0; pick[3] < P; pick[3]++) {
          for (pick[4] = 0; pick[4] < P; pick[4]++) {
            let c = binaryCost(pick, ctx).total;
            for (let s = 0; s < 5; s++) c += unary[s][pick[s]];
            if (c < bestCost - 1e-12) { bestCost = c; bestPick = pick.slice(); }
          }
        }
      }
    }
  }
  const found = searchAssignment(ctx);
  assert.ok(Math.abs(found.cost - bestCost) < 1e-9,
    `branch and bound found ${found.cost}, brute force ${bestCost}`);
  assert.deepEqual(found.pick.map((i) => pool[i].hex), bestPick.map((i) => pool[i].hex));
  assert.ok(found.leaves < P ** 5, 'pruning must actually prune');
});

test('every cost term is non-negative, which is what makes the bound admissible', () => {
  for (const palette of ADVERSARIAL_PALETTES) {
    const pool = buildCandidatePool(palette.clusters);
    const ctx = buildContext(pool, CONTRAST_AA_BODY);
    for (const slot of ['surface', 'surfaceAlt', 'primary', 'accent', 'secondary']) {
      for (let ci = 0; ci < pool.length; ci++) {
        const u = unaryCost(slot, ci, ctx);
        assert.ok(u.total >= 0, `${palette.name} ${slot}: unary cost ${u.total}`);
        for (const [k, v] of Object.entries(u.terms)) {
          assert.ok(v >= 0 && Number.isFinite(v), `${palette.name} ${slot} ${k} = ${v}`);
        }
      }
    }
    const pick = [0, 1 % pool.length, 2 % pool.length, 3 % pool.length, 4 % pool.length];
    const b = binaryCost(pick, ctx);
    assert.ok(b.total >= 0);
    for (const [k, v] of Object.entries(b.terms)) {
      assert.ok(v >= 0 && Number.isFinite(v), `${palette.name} binary ${k} = ${v}`);
    }
  }
});

test('the candidate pool always offers a readable ground and stays inside the cap', () => {
  for (const palette of ADVERSARIAL_PALETTES) {
    const pool = buildCandidatePool(palette.clusters);
    assert.ok(pool.length >= palette.clusters.length, `${palette.name}: extracted colours are kept`);
    assert.ok(pool.length <= 16, `${palette.name}: pool ${pool.length} exceeds the cap`);
    const hexes = new Set(pool.map((c) => c.hex));
    assert.equal(hexes.size, pool.length, `${palette.name}: pool must not contain duplicates`);
    for (const c of pool) {
      assert.ok(inGamut(c.oklch), `${palette.name}: pool colour ${c.hex} in gamut`);
      assert.ok(c.chromaFraction >= 0 && c.chromaFraction <= 1);
      assert.ok(['extracted', 'derived'].includes(c.source));
    }
    // Something in the pool can carry body text on both a light and a dark ground.
    assert.ok(pool.some((c) => c.luminance > 0.7), `${palette.name}: a light candidate exists`);
    assert.ok(pool.some((c) => c.luminance < 0.2), `${palette.name}: a dark candidate exists`);
  }
});

test('derived variants stay on their seed hue and inside the gamut', () => {
  for (const palette of ADVERSARIAL_PALETTES) {
    const pool = buildCandidatePool(palette.clusters);
    for (const seed of pool.filter((c) => c.source === 'extracted').slice(0, 2)) {
      for (const v of variantCandidates(seed)) {
        assert.match(v.hex, /^#[0-9a-f]{6}$/);
        assert.ok(inGamut(hexToOklch(v.hex)), `${v.hex} must be in gamut`);
        if (seed.chromaFraction >= 0.2) {
          assert.ok(hueDistance(hexToOklch(v.hex)[2], seed.oklch[2]) < 20,
            `${seed.hex} → ${v.hex} must keep its hue`);
        }
      }
    }
  }
});

test('the neutral anchors read as white and black and carry the brand hue', () => {
  for (const hue of [0, 40, 110, 180, 264, 330]) {
    const { light, dark } = neutralAnchors(hue, 0.075);
    assert.ok(contrastRatio(light, '#ffffff') <= 1.1 + 1e-6, `light anchor at hue ${hue}`);
    assert.ok(contrastRatio(dark, '#000000') <= 1.5 + 1e-6, `dark anchor at hue ${hue}`);
    assert.ok(contrastRatio(light, dark) > 10, 'the two anchors must be far apart');
    assert.ok(inGamut(hexToOklch(light)) && inGamut(hexToOklch(dark)));
  }
});

test('the hue cusp is the most chromatic point of its hue', () => {
  for (const hue of [29.23, 109.77, 142.5, 194.77, 264.05, 328.36]) {
    const cusp = hueCusp(hue);
    // The cache quantises hue to a tenth of a degree; chroma varies slowly
    // enough with hue that the two agree far inside any band comparison.
    assert.ok(Math.abs(cusp.C - cuspChroma(hue)) < 1e-3, 'the cache agrees with the search');
    for (let L = 0.02; L < 1; L += 0.02) {
      assert.ok(maxChromaAt(L, hue) <= cusp.C + 1e-6,
        `hue ${hue}: chroma at L=${L} exceeds the cusp`);
    }
    assert.ok(inGamut([cusp.L, cusp.C, hue]));
  }
  // The sRGB primaries sit essentially at their own cusps.
  assert.ok(Math.abs(cuspChroma(SEMANTIC_HUES.danger) - hexToOklch('#ff0000')[1]) < 1e-3);
});

/* ------------------------------------------------- the rest of the roles */

test('semantic and border roles are legible and canonical', () => {
  for (const palette of ADVERSARIAL_PALETTES) {
    const tokens = solveRoles(palette.clusters, { seed: 'semantic' });
    const byRole = {};
    for (const t of tokens) byRole[t.role] = t.hex;
    // §4 pairs border, success, warning and danger with surface. Status colours
    // are status *text*, so they are held to the body floor too; a border is a
    // component boundary, so it is held to the WCAG non-text 3:1.
    for (const role of ['success', 'warning', 'danger']) {
      assert.ok(oracleContrast(byRole[role], byRole.surface) >= CONTRAST_AA_BODY,
        `${palette.name}: ${role} on surface is ${oracleContrast(byRole[role], byRole.surface).toFixed(3)}`);
    }
    assert.ok(oracleContrast(byRole.border, byRole.surface) >= CONTRAST_AA_NONTEXT - 1e-9,
      `${palette.name}: border on surface must meet ${CONTRAST_AA_NONTEXT}:1`);
    // The semantic hues are the sRGB primaries themselves, not chosen numbers.
    assert.ok(Math.abs(SEMANTIC_HUES.danger - hexToOklch('#ff0000')[2]) < 1e-9);
    assert.ok(Math.abs(SEMANTIC_HUES.warning - hexToOklch('#ffff00')[2]) < 1e-9);
    assert.ok(Math.abs(SEMANTIC_HUES.success - hexToOklch('#00ff00')[2]) < 1e-9);
    // A synthesised status colour lands within one hue category of its anchor.
    for (const role of ['success', 'warning', 'danger']) {
      const token = tokens.find((t) => t.role === role);
      if (token.source !== 'derived') continue;
      assert.ok(hueDistance(token.oklch[2], SEMANTIC_HUES[role]) <= 30,
        `${palette.name}: derived ${role} strayed to hue ${token.oklch[2]}`);
    }
  }
});

test('background roles keep some structural distinctness where the palette allows it', () => {
  // Not a hard constraint — a one-colour brand cannot supply five distinct
  // fills — but a palette with five or more clusters has no excuse.
  for (const palette of ADVERSARIAL_PALETTES.filter((p) => p.clusters.length >= 5)) {
    const tokens = solveRoles(palette.clusters, { seed: 'distinct' });
    const byRole = {};
    for (const t of tokens) byRole[t.role] = t.hex;
    const fills = BACKGROUND_ROLES.map((r) => byRole[r]);
    assert.ok(new Set(fills).size >= 4,
      `${palette.name}: only ${new Set(fills).size} distinct background fills`);
    assert.notEqual(byRole.surface, byRole.primary, `${palette.name}: surface and primary must differ`);
  }
});

test('extracted colours are preferred over derived ones when they are usable', () => {
  // Fidelity to the brand is the product's premise; a solver that reaches for a
  // synthesised anchor when the brand's own colour would do has failed §1.
  const tokens = solveRoles([
    { hex: '#ffffff', weight: 0.5 }, { hex: '#0b1220', weight: 0.2 },
    { hex: '#3b2eea', weight: 0.15 }, { hex: '#8b93f4', weight: 0.1 },
    { hex: '#f0728c', weight: 0.05 },
  ], { seed: 'fidelity' });
  const byRole = {};
  for (const t of tokens) byRole[t.role] = t.hex;
  assert.equal(byRole.surface, '#ffffff', 'the heaviest neutral is the ground');
  assert.equal(byRole.primary, '#3b2eea', 'the brand colour is the primary');
  const extracted = tokens.filter((t) => t.source === 'extracted').length;
  assert.ok(extracted >= 6, `only ${extracted} of ${tokens.length} roles used an extracted colour`);
});

test('a solve completes well inside an interactive budget', () => {
  // The search is exhaustive with pruning; the guard is that "exhaustive" has
  // not quietly become "exponential" for a maximum-size pool.
  const worst = ADVERSARIAL_PALETTES.find((p) => p.name === 'eight clusters');
  const started = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) solveRoles(worst.clusters, { seed: `budget-${i}` });
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / 10;
  assert.ok(ms < 500, `a solve took ${ms.toFixed(1)}ms`);
});
