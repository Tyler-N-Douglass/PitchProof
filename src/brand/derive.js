/**
 * Derivation: producing a colour that meets a contrast constraint when no
 * extracted colour can (§7, PLAN §4.1).
 *
 * §7 states the method exactly — "derive one by walking lightness in OKLCH
 * while holding hue and clamping chroma" — and this file implements it
 * literally, with three properties the solver depends on:
 *
 *  1. **It always succeeds for any ratio up to 4.5826:1.** For any colour,
 *     `contrast(c, white) · contrast(c, black) = 21`, so the larger of the two
 *     is at least `sqrt(21) = 4.5826…`. The walk reaches white at L = 1 and
 *     black at L = 0, so a 4.5:1 target is always reachable. `solveRoles` can
 *     therefore only fail on an input that was impossible to begin with.
 *  2. **The guarantee is checked on the quantised colour.** Every candidate is
 *     rounded to `#rrggbb` before its contrast is measured, so 8-bit rounding
 *     cannot drop a derived colour below the floor after the fact.
 *  3. **It moves as little as possible.** Both directions in lightness are
 *     searched and the one closer to the base lightness wins, so a derived
 *     colour stays as close to the brand's own colour as the constraint allows.
 *
 * @module brand/derive
 */

import {
  hexToOklch, oklchToHex, contrastRatio, luminanceOfHex, contrastFromLuminance,
  MAX_CONTRAST, GUARANTEED_CONTRAST, maxChromaAt, rgbToHex, hexToRgb,
} from './oklab.js';

/** Thrown when a contrast constraint cannot be met by any colour. */
export class DeriveError extends Error {}

/** Substream name reserved for the derivation stage, per API.md Part 1. */
export const DERIVE_STREAM = 'brand/derive';

/**
 * Lightness grid resolution for the outward scan. 1/512 ≈ 0.00195 in OKLab L,
 * which is finer than the smallest lightness step an 8-bit sRGB colour can
 * express near mid-grey, so the scan cannot step over a satisfying band.
 */
export const DERIVE_L_STEPS = 512;
/** Bisection refinements after the scan brackets the boundary: 1/512/2^24 ≈ 1e-10. */
export const DERIVE_BISECT_ITERS = 24;
/** Outward nudges allowed after bisection if 8-bit rounding lands just short. */
const DERIVE_NUDGES = 8;

/**
 * The highest contrast ratio any colour can reach against `hex` — attained by
 * pure white or pure black, whichever is further away.
 * @param {string} hex
 * @returns {number}
 */
export function contrastCeiling(hex) {
  const y = luminanceOfHex(hex);
  return Math.max(contrastFromLuminance(y, 1), contrastFromLuminance(y, 0));
}

/**
 * Pure black or pure white, whichever contrasts more with `hex`. Always at
 * least `GUARANTEED_CONTRAST` (4.5826:1).
 * @param {string} hex
 * @returns {string}
 */
export function bestExtremeFor(hex) {
  const y = luminanceOfHex(hex);
  return contrastFromLuminance(y, 1) >= contrastFromLuminance(y, 0) ? '#ffffff' : '#000000';
}

/**
 * Normalise any accepted hex form to lower-case `#rrggbb`.
 * @param {string} hex
 * @returns {string}
 */
export function normalizeHex(hex) {
  return rgbToHex(hexToRgb(hex));
}

/**
 * Walk lightness in OKLCH, holding hue and clamping chroma into the sRGB gamut,
 * until `baseHex` reaches `minRatio` against `targetHex`.
 *
 * Returns `baseHex` unchanged (normalised) when it already satisfies the
 * constraint — derivation is a repair, not a rewrite.
 *
 * @param {string} baseHex the colour to move; its hue is preserved
 * @param {string} targetHex the fixed colour it must contrast against
 * @param {number} minRatio required WCAG 2.1 contrast ratio
 * @param {{keepChroma?: boolean}} [options] `keepChroma` false lets chroma fall
 *   to zero as lightness approaches an extreme; true (the default) keeps the
 *   requested chroma wherever the gamut allows it
 * @returns {string} `#rrggbb`
 */
export function deriveForContrast(baseHex, targetHex, minRatio, options = {}) {
  const base = normalizeHex(baseHex);
  const target = normalizeHex(targetHex);
  const ratio = Number(minRatio);
  if (!Number.isFinite(ratio) || ratio <= 1) return base;
  if (ratio > MAX_CONTRAST) {
    throw new DeriveError(
      `deriveForContrast: ${ratio} exceeds the maximum possible WCAG contrast ratio of ${MAX_CONTRAST}`,
    );
  }
  if (contrastRatio(base, target) >= ratio) return base;

  const [baseL, baseC, baseH] = hexToOklch(base);
  const keepChroma = options.keepChroma !== false;
  const targetY = luminanceOfHex(target);

  /**
   * The quantised colour at a given lightness, holding hue and clamping chroma.
   * @param {number} L
   * @returns {string}
   */
  const at = (L) => {
    const c = keepChroma ? baseC : Math.min(baseC, maxChromaAt(L, baseH));
    return oklchToHex([L, c, baseH]);
  };
  /** @param {number} L */
  const ratioAt = (L) => contrastFromLuminance(luminanceOfHex(at(L)), targetY);

  const step = 1 / DERIVE_L_STEPS;

  /**
   * Scan outward from the base lightness in one direction and return the
   * closest lightness that satisfies the constraint, or null.
   * @param {number} dir −1 darker, +1 lighter
   * @returns {{L: number, hex: string, ratio: number}|null}
   */
  const search = (dir) => {
    const limit = dir < 0 ? 0 : 1;
    let prev = baseL;
    let found = null;
    for (let i = 1; ; i++) {
      const L = dir < 0 ? Math.max(limit, baseL - i * step) : Math.min(limit, baseL + i * step);
      if (ratioAt(L) >= ratio) { found = L; break; }
      prev = L;
      if (L === limit) break;
    }
    if (found === null) return null;
    // Bisect between the last failing lightness and the first passing one to
    // land as close to the base lightness as the constraint permits.
    let fail = prev;
    let pass = found;
    for (let i = 0; i < DERIVE_BISECT_ITERS; i++) {
      const mid = (fail + pass) / 2;
      if (ratioAt(mid) >= ratio) pass = mid; else fail = mid;
    }
    // Quantisation guard: nudge outward until the rounded colour really passes.
    for (let i = 0; i <= DERIVE_NUDGES; i++) {
      const hex = at(pass);
      const r = contrastFromLuminance(luminanceOfHex(hex), targetY);
      if (r >= ratio) return { L: pass, hex, ratio: r };
      pass = dir < 0 ? Math.max(limit, pass - step) : Math.min(limit, pass + step);
    }
    return null;
  };

  const down = search(-1);
  const up = search(1);
  /** @type {{L: number, hex: string, ratio: number}|null} */
  let best = null;
  for (const cand of [down, up]) {
    if (!cand) continue;
    if (best === null) { best = cand; continue; }
    const dc = Math.abs(cand.L - baseL);
    const db = Math.abs(best.L - baseL);
    // Closest in lightness wins; on a tie the higher contrast wins; on a second
    // tie the darker colour wins, which keeps the choice deterministic.
    if (dc < db - 1e-12) best = cand;
    else if (Math.abs(dc - db) <= 1e-12) {
      if (cand.ratio > best.ratio + 1e-12) best = cand;
      else if (Math.abs(cand.ratio - best.ratio) <= 1e-12 && cand.L < best.L) best = cand;
    }
  }
  if (best) return best.hex;

  // The hue walk failed — only possible when chroma was held so high that no
  // lightness on the hue line reaches the ratio. Fall back to the extreme,
  // which is guaranteed to reach 4.5826:1.
  const extreme = bestExtremeFor(target);
  if (contrastRatio(extreme, target) >= ratio) return extreme;
  if (options.keepChroma !== false) {
    return deriveForContrast(base, target, ratio, { keepChroma: false });
  }
  throw new DeriveError(
    `deriveForContrast: cannot reach ${ratio}:1 against ${target}; the ceiling for that colour is ${contrastCeiling(target).toFixed(4)}:1`,
  );
}

/**
 * True when `minRatio` is reachable against `targetHex` by some sRGB colour.
 * @param {string} targetHex
 * @param {number} minRatio
 * @returns {boolean}
 */
export function contrastReachable(targetHex, minRatio) {
  return minRatio <= contrastCeiling(targetHex) + 1e-12;
}

/**
 * A near-white and a near-black surface anchor carrying the brand hue, for
 * palettes that extracted no usable ground (a two-colour logo, a neon-only
 * brand). Both are found by search rather than chosen:
 *
 *  - the light anchor is the **darkest** colour on the hue line that still
 *    reads as white, defined as contrast ≤ `LIGHT_ANCHOR_MAX_CONTRAST` against
 *    pure white;
 *  - the dark anchor is the **lightest** colour that still reads as black,
 *    defined as contrast ≤ `DARK_ANCHOR_MAX_CONTRAST` against pure black.
 *
 * The two thresholds differ because the WCAG ratio is compressed near white
 * (the +0.05 offset) and expanded near black: 1.1:1 and 1.5:1 are the same
 * perceptual distance from their respective extremes measured in luminance.
 *
 * @param {number} hue degrees
 * @param {number} tintFraction chroma as a fraction of the maximum at that lightness
 * @returns {{light: string, dark: string}}
 */
export function neutralAnchors(hue, tintFraction) {
  const t = Math.min(1, Math.max(0, Number.isFinite(tintFraction) ? tintFraction : 0));
  /** @param {number} L */
  const at = (L) => oklchToHex([L, t * maxChromaAt(L, hue), hue]);
  // Light: bisect for the lowest L with contrast(L, white) <= threshold.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), '#ffffff') <= LIGHT_ANCHOR_MAX_CONTRAST) hi = mid; else lo = mid;
  }
  const light = at(hi);
  // Dark: bisect for the highest L with contrast(L, black) <= threshold.
  lo = 0;
  hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), '#000000') <= DARK_ANCHOR_MAX_CONTRAST) lo = mid; else hi = mid;
  }
  const dark = at(lo);
  return { light, dark };
}

/** A colour within this contrast of pure white still reads as a white surface. */
export const LIGHT_ANCHOR_MAX_CONTRAST = 1.1;
/** A colour within this contrast of pure black still reads as a black surface. */
export const DARK_ANCHOR_MAX_CONTRAST = 1.5;

/**
 * Re-exported for callers that want the reachability bound without importing
 * `oklab.js` directly.
 */
export { GUARANTEED_CONTRAST, MAX_CONTRAST };
