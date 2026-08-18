/**
 * §17.1 colour science: sRGB ↔ OKLab ↔ OKLCH against published reference
 * values, and WCAG 2.1 contrast against published worked examples.
 *
 * **Every expected number in this file comes from a published source or is an
 * exact algebraic consequence of one.** Nothing asserts against a value this
 * implementation produced. §17.1 calls this non-negotiable and HANDOFF §4 lists
 * it among the tests that may not be weakened to make a build pass: if an
 * assertion here fails, the implementation is wrong.
 *
 * Sources, cited at each block:
 *
 *  [O]  Björn Ottosson, "A perceptual color space for image processing" (2020) —
 *       the OKLab definition, its matrices, and the XYZ→OKLab test table.
 *  [C4] CSS Color Module Level 4 — the sRGB transfer function, the `oklch()`
 *       values of the sRGB primaries and secondaries, `hsl()`, and the named
 *       colour table.
 *  [W]  WCAG 2.1 — the definitions of "relative luminance" and "contrast
 *       ratio", and the AA/AAA thresholds.
 *  [WA] The published grey/white contrast boundary pairs: `#767676` is the
 *       darkest grey reaching 4.5:1 on white and `#595959` the darkest reaching
 *       7:1, values quoted identically by WebAIM's contrast checker and the
 *       W3C's own contrast guidance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Pcg32, fnv1a64 } from '../../src/core/prng.js';
import {
  srgbToLinear, linearToSrgb, hexToRgb, rgbToHex, hexAlpha,
  rgbToOklab, oklabToRgb, linearRgbToOklab, oklabToLinearRgb,
  xyzToOklab, oklabToXyz, oklabToOklch, oklchToOklab, hexToOklch, oklchToHex,
  relativeLuminance, luminanceOfHex, contrastRatio, contrastRatioRgb, contrastFromLuminance,
  inGamut, clampChromaToGamut, maxChromaAt, deltaEok, hueDistance, meanHue,
  MAX_CONTRAST, GUARANTEED_CONTRAST, MAX_SRGB_CHROMA_BOUND,
  LUMA_R, LUMA_G, LUMA_B, WCAG_CONTRAST_OFFSET, SRGB_GAMMA, SRGB_OFFSET, SRGB_SLOPE,
  parseCssColor, hslToRgb, NAMED_COLORS,
} from '../../src/brand/color.js';
import {
  invert3, LMS_TO_OKLAB, LSRGB_TO_LMS, XYZ_TO_LMS, SRGB_WHITE_L, SRGB_BLACK_L,
  PUBLISHED_OKLAB_TO_LMS, PUBLISHED_LMS_TO_LSRGB, PUBLISHED_LMS_TO_XYZ,
} from '../../src/brand/oklab.js';

/** §17.1's stated tolerance. */
const TOL = 1e-6;

/**
 * An oracle for WCAG 2.1 relative luminance, written from the specification
 * text and deliberately independent of the implementation, so that the two can
 * disagree. The spec states the cutoff as 0.03928.
 * @param {readonly number[]} rgb 0..255
 */
function wcagLuminanceOracle(rgb) {
  const chan = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
}

/**
 * A seeded sweep of the sRGB cube — the same points on every machine, per §5.
 * The substream name is folded into the seed so two sweeps in this file cover
 * different points rather than repeating one another.
 * @param {number} count
 * @param {string} substream
 * @returns {number[][]}
 */
function cubeSweep(count, substream) {
  const rng = new Pcg32('pitchproof-v1', fnv1a64(`pitchproof/substream/${substream}`));
  /** @type {number[][]} */
  const out = [];
  for (let i = 0; i < count; i++) out.push([rng.nextInt(256), rng.nextInt(256), rng.nextInt(256)]);
  return out;
}

/* ------------------------------------------------------------------ [C4] */

test('the sRGB transfer function matches its published definition', () => {
  assert.equal(SRGB_SLOPE, 12.92);
  assert.equal(SRGB_OFFSET, 0.055);
  assert.equal(SRGB_GAMMA, 2.4);
  // Endpoints are exact.
  assert.equal(srgbToLinear(0), 0);
  assert.equal(srgbToLinear(1), 1);
  assert.equal(linearToSrgb(0), 0);
  // `1.055 · 1^(1/2.4) − 0.055` is 1 in exact arithmetic and one ulp below it
  // in IEEE-754 doubles; the identity is asserted at machine precision.
  assert.ok(Math.abs(linearToSrgb(1) - 1) <= Number.EPSILON);
  // The two branches meet at the published breakpoint.
  assert.ok(Math.abs(srgbToLinear(0.04045) - 0.04045 / 12.92) < 1e-12);
  assert.ok(Math.abs(srgbToLinear(0.04045) - 0.0031308) < 1e-7);
  // Published spot value: 50% grey encodes to ≈0.21404 linear.
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.21404114048223255) < 1e-12,
    `srgbToLinear(0.5) = ${srgbToLinear(0.5)}`);
  assert.ok(Math.abs(srgbToLinear(0.5) - ((0.5 + 0.055) / 1.055) ** 2.4) < 1e-15);
});

test('sRGB transfer round-trips to 1e-6 across the encoded range', () => {
  for (let i = 0; i <= 2000; i++) {
    const c = i / 2000;
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(c)) - c) < TOL, `round trip at ${c}`);
  }
  // And is extended as an odd function so out-of-gamut work never sees NaN.
  assert.ok(Math.abs(linearToSrgb(srgbToLinear(-0.3)) + 0.3) < TOL);
  assert.ok(Number.isFinite(linearToSrgb(-0.2)));
  assert.ok(Number.isFinite(srgbToLinear(-0.2)));
});

/* ------------------------------------------------------------------- [O] */

test('XYZ → OKLab matches Ottosson\'s published test table', () => {
  // The table from "A perceptual color space for image processing", quoted to
  // the three decimals it is published at.
  const TABLE = [
    { xyz: [0.950, 1.000, 1.089], lab: [1.000, 0.000, 0.000] },
    { xyz: [1.000, 0.000, 0.000], lab: [0.450, 1.236, -0.019] },
    { xyz: [0.000, 1.000, 0.000], lab: [0.922, -0.671, 0.263] },
    { xyz: [0.000, 0.000, 1.000], lab: [0.153, -1.415, -0.449] },
  ];
  for (const row of TABLE) {
    const got = xyzToOklab(row.xyz);
    for (let i = 0; i < 3; i++) {
      // 5e-4 is half of the last published digit: the strongest claim the
      // published precision supports.
      assert.ok(Math.abs(got[i] - row.lab[i]) < 5e-4,
        `xyzToOklab(${row.xyz}) component ${i}: got ${got[i]}, published ${row.lab[i]}`);
    }
  }
});

test('the computed matrix inverses agree with Ottosson\'s published inverses', () => {
  // The forward matrices are used verbatim; the inverses are computed from them
  // exactly (a rounded inverse costs three orders of magnitude of round-trip
  // accuracy). This asserts the computation lands on the published numbers, so
  // both sets of published values constrain the implementation.
  const pairs = [
    [invert3(LMS_TO_OKLAB), PUBLISHED_OKLAB_TO_LMS, 'OKLab → LMS'],
    [invert3(LSRGB_TO_LMS), PUBLISHED_LMS_TO_LSRGB, 'LMS → linear sRGB'],
    [invert3(XYZ_TO_LMS), PUBLISHED_LMS_TO_XYZ, 'LMS → XYZ'],
  ];
  for (const [computed, published, what] of pairs) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(computed[r][c] - published[r][c]) < 1e-7,
          `${what} [${r}][${c}]: computed ${computed[r][c]}, published ${published[r][c]}`);
      }
    }
  }
  // And the inverse really inverts, which the published rounding does not.
  const round = invert3(invert3(LMS_TO_OKLAB));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(round[r][c] - LMS_TO_OKLAB[r][c]) < 1e-12);
  }
  assert.throws(() => invert3([[1, 2, 3], [2, 4, 6], [1, 1, 1]]), /singular/);
});

test('OKLab → XYZ inverts the published forward transform to 1e-6', () => {
  for (const xyz of [[0.950, 1.000, 1.089], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, 0.4, 0.5]]) {
    const back = oklabToXyz(xyzToOklab(xyz));
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - xyz[i]) < TOL, `xyz round trip component ${i}`);
    }
  }
});

test('sRGB → OKLCH matches the published values for the primaries and secondaries', () => {
  // [C4] / [O]: the OKLCH coordinates of the sRGB corners, as published to five
  // decimal places by the CSS Color 4 conversion sample code and Ottosson's own
  // converter.
  const PUBLISHED = [
    { hex: '#ff0000', lch: [0.62796, 0.25768, 29.23388] },
    { hex: '#ffff00', lch: [0.96798, 0.21101, 109.76923] },
    { hex: '#00ff00', lch: [0.86644, 0.29483, 142.49534] },
    { hex: '#00ffff', lch: [0.90540, 0.15455, 194.76895] },
    { hex: '#0000ff', lch: [0.45201, 0.31321, 264.05202] },
    { hex: '#ff00ff', lch: [0.70167, 0.32249, 328.36342] },
  ];
  for (const row of PUBLISHED) {
    const got = hexToOklch(row.hex);
    // Published to five decimals for L and C; half of the last digit is 5e-6.
    assert.ok(Math.abs(got[0] - row.lch[0]) < 5e-6, `${row.hex} L: ${got[0]} vs ${row.lch[0]}`);
    assert.ok(Math.abs(got[1] - row.lch[1]) < 5e-6, `${row.hex} C: ${got[1]} vs ${row.lch[1]}`);
    assert.ok(Math.abs(got[2] - row.lch[2]) < 5e-5, `${row.hex} H: ${got[2]} vs ${row.lch[2]}`);
  }
});

test('white and black land on the published ends of the OKLab lightness axis', () => {
  const white = rgbToOklab([255, 255, 255]);
  assert.ok(Math.abs(white[0] - 1) < TOL, `white L = ${white[0]}`);
  assert.ok(Math.hypot(white[1], white[2]) < TOL, 'white must be achromatic');
  const black = rgbToOklab([0, 0, 0]);
  assert.ok(Math.abs(black[0]) < TOL, `black L = ${black[0]}`);
  assert.ok(Math.hypot(black[1], black[2]) < TOL, 'black must be achromatic');
  // Every neutral is achromatic, at every code.
  for (let v = 0; v < 256; v++) {
    const lab = rgbToOklab([v, v, v]);
    assert.ok(Math.hypot(lab[1], lab[2]) < 1e-6, `grey ${v} must be achromatic`);
  }
});

test('sRGB ↔ OKLab round-trips to 1e-6 over a seeded sweep of the cube', () => {
  let worst = 0;
  for (const rgb of cubeSweep(4096, 'test/oklab-sweep')) {
    const back = oklabToRgb(rgbToOklab(rgb));
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(back[i] - rgb[i]));
  }
  assert.ok(worst < TOL, `worst sRGB↔OKLab round-trip error was ${worst} 8-bit units`);
});

test('OKLab ↔ OKLCH round-trips to 1e-6 over a seeded sweep of the cube', () => {
  let worst = 0;
  for (const rgb of cubeSweep(4096, 'test/oklch-sweep')) {
    const lab = rgbToOklab(rgb);
    const back = oklchToOklab(oklabToOklch(lab));
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(back[i] - lab[i]));
  }
  assert.ok(worst < TOL, `worst OKLab↔OKLCH round-trip error was ${worst}`);
});

test('hex ↔ OKLCH round-trips exactly for every colour it is given', () => {
  for (const rgb of cubeSweep(2048, 'test/hex-sweep')) {
    const hex = rgbToHex(rgb);
    assert.equal(oklchToHex(hexToOklch(hex)), hex, `hex round trip for ${hex}`);
  }
  for (let v = 0; v < 256; v++) {
    const hex = rgbToHex([v, v, v]);
    assert.equal(oklchToHex(hexToOklch(hex)), hex, `grey round trip for ${hex}`);
  }
});

test('linear-light OKLab conversions agree with the 8-bit-domain ones', () => {
  for (const rgb of cubeSweep(512, 'test/linear-agreement')) {
    const viaLinear = linearRgbToOklab(rgb.map((c) => srgbToLinear(c / 255)));
    const direct = rgbToOklab(rgb);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(viaLinear[i] - direct[i]) < 1e-12);
    const back = oklabToLinearRgb(direct).map((c) => linearToSrgb(c) * 255);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rgb[i]) < TOL);
  }
});

/* ------------------------------------------------------------------- [W] */

test('relative luminance matches the WCAG 2.1 definition exactly', () => {
  assert.equal(LUMA_R, 0.2126);
  assert.equal(LUMA_G, 0.7152);
  assert.equal(LUMA_B, 0.0722);
  assert.equal(WCAG_CONTRAST_OFFSET, 0.05);
  // The coefficients sum to 1, so white is exactly 1 and black exactly 0.
  assert.ok(Math.abs(LUMA_R + LUMA_G + LUMA_B - 1) < 1e-15);
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-15);
  // The primaries are the coefficients themselves.
  assert.ok(Math.abs(relativeLuminance([255, 0, 0]) - LUMA_R) < 1e-15);
  assert.ok(Math.abs(relativeLuminance([0, 255, 0]) - LUMA_G) < 1e-15);
  assert.ok(Math.abs(relativeLuminance([0, 0, 255]) - LUMA_B) < 1e-15);
});

test('relative luminance agrees with an independent oracle over the whole 8-bit space', () => {
  let worst = 0;
  for (let v = 0; v < 256; v++) worst = Math.max(worst, Math.abs(relativeLuminance([v, v, v]) - wcagLuminanceOracle([v, v, v])));
  for (const rgb of cubeSweep(8192, 'test/luminance-oracle')) {
    worst = Math.max(worst, Math.abs(relativeLuminance(rgb) - wcagLuminanceOracle(rgb)));
  }
  assert.equal(worst, 0, `oracle disagreement of ${worst}`);
});

test('the WCAG 0.03928 cutoff and the IEC 0.04045 cutoff agree on every 8-bit code', () => {
  // The two published cutoffs bracket no representable 8-bit value: 10/255 is
  // below both and 11/255 above both. This is why the module can state the
  // WCAG form literally without diverging from the sRGB standard.
  for (let v = 0; v < 256; v++) {
    const iec = LUMA_R * srgbToLinear(v / 255) + LUMA_G * srgbToLinear(v / 255) + LUMA_B * srgbToLinear(v / 255);
    assert.equal(relativeLuminance([v, v, v]), iec, `code ${v}`);
  }
  assert.ok(10 / 255 <= 0.03928 && 10 / 255 <= 0.04045);
  assert.ok(11 / 255 > 0.03928 && 11 / 255 > 0.04045);
});

test('contrast ratio matches the W3C worked examples', () => {
  // Exact algebra from the published formula: (1.05)/(0.05) = 21.
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(MAX_CONTRAST, 21);
  // A colour against itself is exactly 1:1, for every colour.
  for (const rgb of cubeSweep(256, 'test/self-contrast')) {
    assert.equal(contrastRatio(rgbToHex(rgb), rgbToHex(rgb)), 1);
  }
  // The primaries against black, exact consequences of the published
  // coefficients: (coefficient + 0.05) / 0.05.
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) < tol, `${what}: ${a} vs ${b}`);
  near(contrastRatio('#ff0000', '#000000'), (LUMA_R + 0.05) / 0.05, 1e-12, 'red on black');
  near(contrastRatio('#00ff00', '#000000'), (LUMA_G + 0.05) / 0.05, 1e-12, 'green on black');
  near(contrastRatio('#0000ff', '#000000'), (LUMA_B + 0.05) / 0.05, 1e-12, 'blue on black');
  near(contrastRatio('#0000ff', '#ffffff'), 1.05 / (LUMA_B + 0.05), 1e-12, 'blue on white');
  // [WA] Published boundary greys on white, quoted to two decimals.
  near(contrastRatio('#767676', '#ffffff'), 4.54, 5e-3, '#767676 on white');
  near(contrastRatio('#777777', '#ffffff'), 4.48, 5e-3, '#777777 on white');
  near(contrastRatio('#595959', '#ffffff'), 7.00, 5e-3, '#595959 on white');
  // And the property those two published greys exist to express.
  assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5, '#767676 must pass AA on white');
  assert.ok(contrastRatio('#777777', '#ffffff') < 4.5, '#777777 must fail AA on white');
  assert.ok(contrastRatio('#595959', '#ffffff') >= 7, '#595959 must pass AAA on white');
});

test('contrast ratio is symmetric, bounded, and monotone in luminance', () => {
  const sweep = cubeSweep(400, 'test/contrast-properties');
  for (const a of sweep.slice(0, 60)) {
    for (const b of sweep.slice(60, 120)) {
      const ha = rgbToHex(a);
      const hb = rgbToHex(b);
      const r = contrastRatio(ha, hb);
      assert.equal(r, contrastRatio(hb, ha), 'symmetry');
      assert.ok(r >= 1 - 1e-12 && r <= 21 + 1e-12, `bounds: ${r}`);
      assert.ok(Math.abs(r - contrastRatioRgb(a, b)) < 1e-12, 'rgb and hex forms agree');
    }
  }
  // Monotone: as a grey darkens, its contrast against white rises without exception.
  let prev = 0;
  for (let v = 255; v >= 0; v--) {
    const r = contrastRatio(rgbToHex([v, v, v]), '#ffffff');
    assert.ok(r >= prev, `contrast must be monotone in lightness at code ${v}`);
    prev = r;
  }
});

test('every colour reaches at least sqrt(21):1 against black or white', () => {
  // The identity behind the derivation guarantee:
  //   contrast(c, white) · contrast(c, black) = (1.05/(Y+0.05)) · ((Y+0.05)/0.05) = 21
  // so the larger of the two is never below sqrt(21) = 4.5826…, which is above
  // the 4.5:1 body-text floor.
  assert.ok(Math.abs(GUARANTEED_CONTRAST - Math.sqrt(21)) < 1e-12);
  assert.ok(GUARANTEED_CONTRAST > 4.5);
  let worstBest = Infinity;
  for (const rgb of cubeSweep(4096, 'test/guarantee')) {
    const hex = rgbToHex(rgb);
    const w = contrastRatio(hex, '#ffffff');
    const b = contrastRatio(hex, '#000000');
    assert.ok(Math.abs(w * b - 21) < 1e-9, `product identity for ${hex}: ${w * b}`);
    worstBest = Math.min(worstBest, Math.max(w, b));
  }
  assert.ok(worstBest >= Math.sqrt(21) - 1e-9, `worst best-extreme contrast was ${worstBest}`);
});

test('contrastFromLuminance is the published formula', () => {
  assert.equal(contrastFromLuminance(1, 0), 21);
  assert.equal(contrastFromLuminance(0, 1), 21);
  assert.equal(contrastFromLuminance(0.5, 0.5), 1);
  assert.ok(Math.abs(contrastFromLuminance(0.3, 0.1) - (0.35 / 0.15)) < 1e-15);
  assert.ok(Math.abs(luminanceOfHex('#808080') - relativeLuminance([128, 128, 128])) < 1e-15);
});

/* ---------------------------------------------------------------- gamut */

test('the chroma search bound really bounds the sRGB gamut', () => {
  // The most chromatic colour sRGB can express is magenta, at C ≈ 0.32249.
  let worst = 0;
  let arg = null;
  for (const rgb of cubeSweep(20000, 'test/gamut-bound')) {
    const c = hexToOklch(rgbToHex(rgb))[1];
    if (c > worst) { worst = c; arg = rgbToHex(rgb); }
  }
  for (const hex of ['#ff00ff', '#0000ff', '#ff0000', '#00ff00', '#ffff00', '#00ffff']) {
    worst = Math.max(worst, hexToOklch(hex)[1]);
  }
  assert.ok(worst < MAX_SRGB_CHROMA_BOUND, `found chroma ${worst} at ${arg}, bound is ${MAX_SRGB_CHROMA_BOUND}`);
  assert.ok(Math.abs(hexToOklch('#ff00ff')[1] - 0.32249) < 5e-6, 'magenta is the gamut chroma maximum');
});

test('inGamut agrees with a direct channel test', () => {
  for (const rgb of cubeSweep(2048, 'test/in-gamut')) {
    assert.equal(inGamut(hexToOklch(rgbToHex(rgb))), true, `${rgbToHex(rgb)} must be in gamut`);
  }
  // Push chroma well past the boundary and it must fail.
  for (const hue of [0, 45, 90, 135, 180, 225, 270, 315]) {
    assert.equal(inGamut([0.5, 0.6, hue]), false, `hue ${hue} at C=0.6 must be out of gamut`);
    assert.equal(inGamut([0.5, 0, hue]), true, `hue ${hue} at C=0 must be in gamut`);
  }
  assert.equal(inGamut([1.5, 0, 0]), false, 'lightness above 1 is not representable');
  assert.equal(inGamut([-0.2, 0, 0]), false, 'negative lightness is not representable');
  assert.equal(inGamut([NaN, 0, 0]), false);
});

test('clampChromaToGamut lands inside the gamut, is idempotent, and holds hue', () => {
  for (let L = 0.05; L < 1; L += 0.05) {
    for (let H = 0; H < 360; H += 15) {
      const clamped = clampChromaToGamut([L, 0.6, H]);
      assert.ok(inGamut(clamped), `clamped colour at L=${L} H=${H} must be in gamut`);
      assert.ok(Math.abs(clamped[0] - L) < 1e-12, 'lightness held');
      assert.ok(Math.abs(clamped[2] - H) < 1e-12, 'hue held');
      const again = clampChromaToGamut(clamped);
      assert.ok(Math.abs(again[1] - clamped[1]) < 1e-12, 'idempotent');
      // The clamp is tight: a little more chroma leaves the gamut.
      assert.equal(inGamut([L, clamped[1] + 1e-4, H]), false, `clamp must be tight at L=${L} H=${H}`);
    }
  }
  // An already-in-gamut colour is returned unchanged.
  for (const hex of ['#3b2eea', '#f0728c', '#0b1220', '#8b93f4']) {
    const lch = hexToOklch(hex);
    const clamped = clampChromaToGamut(lch);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(clamped[i] - lch[i]) < 1e-12, `${hex} unchanged`);
  }
  // Out-of-range lightness is clamped rather than returned as a NaN colour.
  // Lightness above white's own OKLab lightness is above the sRGB solid; the
  // clamp maps it onto white rather than off the end of the gamut.
  assert.equal(clampChromaToGamut([1.4, 0.2, 30])[0], SRGB_WHITE_L);
  assert.equal(clampChromaToGamut([-0.4, 0.2, 30])[0], SRGB_BLACK_L);
  assert.equal(SRGB_BLACK_L, 0);
  assert.ok(Math.abs(SRGB_WHITE_L - 1) < 1e-8, `white's OKLab lightness is ${SRGB_WHITE_L}`);
  assert.equal(oklchToHex([1, 0, 0]), '#ffffff');
  assert.equal(oklchToHex([0, 0, 0]), '#000000');
  assert.ok(inGamut(clampChromaToGamut([1.4, 0.2, 30])));
  assert.ok(inGamut(clampChromaToGamut([-0.4, 0.2, 30])));
});

test('maxChromaAt is the boundary of the in-gamut predicate', () => {
  for (const H of [29.23, 109.77, 142.5, 194.77, 264.05, 328.36]) {
    for (const L of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const c = maxChromaAt(L, H);
      assert.ok(inGamut([L, c, H]), `L=${L} H=${H} C=${c} must be in gamut`);
      assert.equal(inGamut([L, c + 1e-5, H]), false, `L=${L} H=${H} must be out just past C=${c}`);
    }
  }
  // At the very ends of the lightness axis every channel collapses toward zero
  // (or toward one), so the gamut tolerance — an absolute 1e-6 in 8-bit units —
  // corresponds to a tiny but non-zero chroma. Assert it is negligible rather
  // than exactly zero, which is the honest claim.
  for (let H = 0; H < 360; H += 30) {
    assert.ok(maxChromaAt(0, H) < 0.01, `black must have negligible chroma at hue ${H}`);
    assert.ok(maxChromaAt(1, H) < 0.01, `white must have negligible chroma at hue ${H}`);
  }
});

/* ------------------------------------------------------- other distances */

test('hueDistance is the shortest arc on the hue circle', () => {
  assert.equal(hueDistance(0, 0), 0);
  assert.equal(hueDistance(0, 180), 180);
  assert.equal(hueDistance(10, 350), 20);
  assert.equal(hueDistance(350, 10), 20);
  assert.equal(hueDistance(90, 120), 30);
  assert.equal(hueDistance(275, 110), 165);
  assert.equal(hueDistance(0, 360), 0);
  for (let a = 0; a < 360; a += 7) {
    for (let b = 0; b < 360; b += 11) {
      const d = hueDistance(a, b);
      assert.ok(d >= 0 && d <= 180, `range at ${a},${b}`);
      assert.equal(d, hueDistance(b, a), 'symmetry');
      assert.ok(Math.abs(d - hueDistance(a + 360, b - 720)) < 1e-9, 'wrap invariance');
    }
  }
});

test('meanHue averages on the circle rather than on the number line', () => {
  // The arithmetic mean of 350 and 10 is 180, which is the opposite hue.
  const m = meanHue([{ h: 350, w: 1 }, { h: 10, w: 1 }]);
  assert.ok(Math.abs(((m + 180) % 360) - 180) < 1e-9, `expected ~0/360, got ${m}`);
  assert.ok(Math.abs(meanHue([{ h: 90, w: 1 }, { h: 110, w: 1 }]) - 100) < 1e-9);
  assert.equal(meanHue([]), 0);
  assert.equal(meanHue([{ h: 0, w: 0 }]), 0);
});

test('deltaEok is a metric on OKLab', () => {
  const pts = cubeSweep(60, 'test/delta-e').map((rgb) => rgbToOklab(rgb));
  for (const a of pts) {
    assert.equal(deltaEok(a, a), 0);
    for (const b of pts) {
      assert.ok(Math.abs(deltaEok(a, b) - deltaEok(b, a)) < 1e-15, 'symmetry');
      for (const c of pts.slice(0, 8)) {
        assert.ok(deltaEok(a, c) <= deltaEok(a, b) + deltaEok(b, c) + 1e-12, 'triangle inequality');
      }
    }
  }
});

/* --------------------------------------------------------- hex and CSS */

test('hex parsing accepts every published form', () => {
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
  assert.deepEqual(hexToRgb('#abc'), [170, 187, 204]);
  assert.deepEqual(hexToRgb('#aabbcc'), [170, 187, 204]);
  assert.deepEqual(hexToRgb('#aabbccdd'), [170, 187, 204]);
  assert.deepEqual(hexToRgb('aabbcc'), [170, 187, 204]);
  assert.deepEqual(hexToRgb('#ABCDEF'), [171, 205, 239]);
  assert.equal(hexAlpha('#aabbcc80'), 128 / 255);
  assert.equal(hexAlpha('#abcf'), 1);
  assert.equal(hexAlpha('#aabbcc'), 1);
  assert.throws(() => hexToRgb('#gg0000'));
  assert.throws(() => hexToRgb('rebeccapurple'));
  assert.throws(() => hexToRgb(null));
  assert.equal(rgbToHex([255.6, -3, 128.4]), '#ff0080');
  assert.throws(() => rgbToHex([NaN, 0, 0]));
});

test('CSS colour parsing matches the published equivalences', () => {
  // [C4] the named colour table.
  assert.equal(NAMED_COLORS.get('rebeccapurple'), '#663399');
  assert.equal(NAMED_COLORS.get('white'), '#ffffff');
  assert.equal(NAMED_COLORS.get('lime'), '#00ff00');
  assert.equal(NAMED_COLORS.size, 148, 'the CSS Color 4 named colour table has 148 entries');
  // [C4] hsl() worked equivalences.
  assert.deepEqual(hslToRgb(0, 1, 0.5).map(Math.round), [255, 0, 0]);
  assert.deepEqual(hslToRgb(120, 1, 0.5).map(Math.round), [0, 255, 0]);
  assert.deepEqual(hslToRgb(240, 1, 0.5).map(Math.round), [0, 0, 255]);
  assert.deepEqual(hslToRgb(0, 0, 0.5).map(Math.round), [128, 128, 128]);
  assert.equal(parseCssColor('hsl(240, 100%, 50%)').hex, '#0000ff');
  assert.equal(parseCssColor('hsl(240 100% 50% / 0.5)').alpha, 0.5);
  // rgb(), both syntaxes.
  assert.equal(parseCssColor('rgb(59, 46, 234)').hex, '#3b2eea');
  assert.equal(parseCssColor('rgb(59 46 234)').hex, '#3b2eea');
  assert.equal(parseCssColor('rgba(59, 46, 234, 0.25)').alpha, 0.25);
  assert.equal(parseCssColor('rgb(100% 0% 0%)').hex, '#ff0000');
  // Unresolvable tokens are refused rather than guessed.
  for (const bad of ['currentColor', 'inherit', 'var(--x)', 'color-mix(in oklab, red, blue)', 'notacolour', '']) {
    assert.equal(parseCssColor(bad), null, `${bad} must not resolve`);
  }
  assert.equal(parseCssColor('transparent').alpha, 0);
  // oklch() round-trips through the same maths the rest of the module uses.
  assert.equal(parseCssColor('oklch(0.62796 0.25768 29.23388)').hex, '#ff0000');
});
